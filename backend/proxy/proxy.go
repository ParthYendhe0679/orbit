package proxy

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for local and cross-origin frontend support
	},
}

// NewHTTPProxy creates a reverse proxy for forwarding REST requests to the target service.
func NewHTTPProxy(targetURL string) (http.Handler, error) {
	target, err := url.Parse(targetURL)
	if err != nil {
		return nil, err
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director

	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Host = target.Host

		// Set forwarding headers
		if clientIP := req.RemoteAddr; clientIP != "" {
			if prior := req.Header.Get("X-Forwarded-For"); prior != "" {
				req.Header.Set("X-Forwarded-For", prior+", "+clientIP)
			} else {
				req.Header.Set("X-Forwarded-For", clientIP)
			}
		}
		if req.TLS != nil {
			req.Header.Set("X-Forwarded-Proto", "https")
		} else {
			req.Header.Set("X-Forwarded-Proto", "http")
		}
	}

	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("[proxy-error] HTTP proxy to %s failed: %v", targetURL, err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   "AI service unavailable",
			"detail":  err.Error(),
			"status":  http.StatusBadGateway,
			"service": "go-backend",
		})
	}

	return proxy, nil
}

// ---------------------------------------------------------------------------
// UserHub — user-scoped fan-out into proxied browser sockets
// ---------------------------------------------------------------------------

type frame struct {
	msgType int
	data    []byte
}

// clientSink is the single write path to one browser socket.
type clientSink struct {
	send chan frame
	done chan struct{}
}

// offer queues a frame without blocking; false if the socket is gone or backed up.
func (c *clientSink) offer(f frame) bool {
	select {
	case <-c.done:
		return false
	default:
	}
	select {
	case c.send <- f:
		return true
	case <-c.done:
		return false
	default:
		return false
	}
}

// UserHub indexes proxied /ws connections by the user_id they connected with,
// so the gateway can push user-scoped events (Auto-Trade Bot activity) to
// exactly that user's sockets, concurrently, without a Python-side fan-out.
// Identity is the same client-asserted user_id the ai-service socket uses.
type UserHub struct {
	mu    sync.RWMutex
	users map[string]map[*clientSink]struct{}
}

func NewUserHub() *UserHub {
	return &UserHub{users: make(map[string]map[*clientSink]struct{})}
}

func (h *UserHub) add(user string, c *clientSink) {
	h.mu.Lock()
	set, ok := h.users[user]
	if !ok {
		set = make(map[*clientSink]struct{})
		h.users[user] = set
	}
	set[c] = struct{}{}
	h.mu.Unlock()
}

func (h *UserHub) remove(user string, c *clientSink) {
	h.mu.Lock()
	if set, ok := h.users[user]; ok {
		delete(set, c)
		if len(set) == 0 {
			delete(h.users, user)
		}
	}
	h.mu.Unlock()
}

// Publish queues payload as a text frame on every socket of user and returns
// how many sockets accepted it.
func (h *UserHub) Publish(user string, payload []byte) int {
	h.mu.RLock()
	sinks := make([]*clientSink, 0, len(h.users[user]))
	for c := range h.users[user] {
		sinks = append(sinks, c)
	}
	h.mu.RUnlock()
	delivered := 0
	for _, c := range sinks {
		if c.offer(frame{msgType: websocket.TextMessage, data: payload}) {
			delivered++
		}
	}
	return delivered
}

// Connections is the number of registered sockets (all users).
func (h *UserHub) Connections() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	n := 0
	for _, set := range h.users {
		n += len(set)
	}
	return n
}

// NewWebSocketProxy creates a transparent bi-directional WebSocket proxy to the AI service.
// Preserves route query parameters (/ws?user_id=...&username=...) and message frames exactly.
// When hub is non-nil the browser socket is also registered under its user_id
// so user-scoped events can be injected into the same stream.
func NewWebSocketProxy(targetURL string, hub *UserHub) http.HandlerFunc {
	// Derive WebSocket target scheme and host
	wsBase := targetURL
	if strings.HasPrefix(wsBase, "http://") {
		wsBase = "ws://" + strings.TrimPrefix(wsBase, "http://")
	} else if strings.HasPrefix(wsBase, "https://") {
		wsBase = "wss://" + strings.TrimPrefix(wsBase, "https://")
	}
	wsBase = strings.TrimRight(wsBase, "/")

	return func(w http.ResponseWriter, r *http.Request) {
		// Construct backend WebSocket destination URL preserving raw query
		targetWS := wsBase + r.URL.Path
		if r.URL.RawQuery != "" {
			targetWS += "?" + r.URL.RawQuery
		}

		// Upgrade incoming client connection
		clientConn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("[ws-proxy] Upgrade error: %v", err)
			return
		}
		defer clientConn.Close()

		// Prepare dialer headers (preserving Authorization/Cookies if present)
		reqHeader := http.Header{}
		for _, h := range []string{"Authorization", "Cookie", "User-Agent"} {
			if val := r.Header.Get(h); val != "" {
				reqHeader.Set(h, val)
			}
		}

		// Dial backend AI service WebSocket
		backendConn, resp, err := websocket.DefaultDialer.Dial(targetWS, reqHeader)
		if err != nil {
			log.Printf("[ws-proxy] Dial backend %s error: %v", targetWS, err)
			if resp != nil && resp.Body != nil {
				defer resp.Body.Close()
				body, _ := io.ReadAll(resp.Body)
				log.Printf("[ws-proxy] Dial response body: %s", string(body))
			}
			_ = clientConn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseServiceRestart, "AI service unavailable"))
			return
		}
		defer backendConn.Close()

		sink := &clientSink{send: make(chan frame, 256), done: make(chan struct{})}

		var once sync.Once
		closeBoth := func() {
			once.Do(func() {
				close(sink.done)
				_ = clientConn.Close()
				_ = backendConn.Close()
			})
		}
		defer closeBoth()

		if user := strings.TrimSpace(r.URL.Query().Get("user_id")); hub != nil && user != "" {
			hub.add(user, sink)
			defer hub.remove(user, sink)
		}

		errChan := make(chan error, 3)

		// Single writer for the browser socket: gorilla/websocket allows one
		// concurrent writer, and both the backend stream and hub events write.
		go func() {
			for {
				select {
				case f := <-sink.send:
					if err := clientConn.WriteMessage(f.msgType, f.data); err != nil {
						errChan <- err
						closeBoth()
						return
					}
				case <-sink.done:
					return
				}
			}
		}()

		// Forward from client to backend
		go func() {
			for {
				msgType, msg, err := clientConn.ReadMessage()
				if err != nil {
					errChan <- err
					break
				}
				if err := backendConn.WriteMessage(msgType, msg); err != nil {
					errChan <- err
					break
				}
			}
			closeBoth()
		}()

		// Forward from backend to client (through the single writer, in order)
		go func() {
			defer closeBoth()
			for {
				msgType, msg, err := backendConn.ReadMessage()
				if err != nil {
					errChan <- err
					return
				}
				select {
				case sink.send <- frame{msgType: msgType, data: msg}:
				case <-sink.done:
					errChan <- io.EOF
					return
				}
			}
		}()

		// Wait until either stream terminates
		<-errChan
	}
}
