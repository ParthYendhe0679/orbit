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
	"github.com/mochatrade/backend/middleware"
)

// OriginChecker decides whether a browser Origin may open a WebSocket.
type OriginChecker func(r *http.Request) bool

// SameOriginOrAllowed accepts non-browser clients (no Origin header; they still
// have to authenticate), same-origin pages, and the explicitly allowed origins.
// Everything else is refused, which blocks cross-site WebSocket hijacking.
func SameOriginOrAllowed(allowed []string) OriginChecker {
	set := map[string]bool{}
	for _, o := range allowed {
		set[strings.TrimRight(strings.ToLower(o), "/")] = true
	}
	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		if strings.EqualFold(u.Host, r.Host) {
			return true
		}
		return set[strings.TrimRight(strings.ToLower(origin), "/")]
	}
}

// NewHTTPProxy forwards REST requests to the ai-service. Client-supplied
// identity headers, tokens and cookies are always stripped; a verified
// identity from the request context and the gateway's shared secret are
// stamped on instead. modify, when set, becomes ModifyResponse.
func NewHTTPProxy(targetURL, internalToken string, modify func(*http.Response) error) (http.Handler, error) {
	target, err := url.Parse(targetURL)
	if err != nil {
		return nil, err
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director

	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Host = target.Host

		if clientIP := req.RemoteAddr; clientIP != "" {
			if prior := req.Header.Get("X-Forwarded-For"); prior != "" {
				req.Header.Set("X-Forwarded-For", prior+", "+clientIP)
			} else {
				req.Header.Set("X-Forwarded-For", clientIP)
			}
		}
		if req.TLS != nil {
			req.Header.Set("X-Forwarded-Proto", "https")
		} else if req.Header.Get("X-Forwarded-Proto") == "" {
			req.Header.Set("X-Forwarded-Proto", "http")
		}

		middleware.StripTrustedHeaders(req.Header)
		id, _ := middleware.IdentityFrom(req.Context())
		middleware.SetTrustedHeaders(req.Header, id, internalToken)
	}
	proxy.ModifyResponse = modify

	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("[proxy-error] %s %s -> ai-service failed: %v", r.Method, r.URL.Path, err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   "AI service unavailable",
			"detail":  "AI service unavailable",
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

// UserHub indexes proxied /ws connections by the verified account they
// authenticated as, so the gateway can push user-scoped events (Auto-Trade
// Bot activity) to exactly that user's sockets.
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

func wsBase(targetURL string) string {
	base := targetURL
	if strings.HasPrefix(base, "http://") {
		base = "ws://" + strings.TrimPrefix(base, "http://")
	} else if strings.HasPrefix(base, "https://") {
		base = "wss://" + strings.TrimPrefix(base, "https://")
	}
	return strings.TrimRight(base, "/")
}

// NewWebSocketProxy bridges an authenticated browser socket to the
// ai-service's /ws. It must be wrapped in Authenticator.RequireUser: the
// account comes from the verified identity, never from the query string
// (a user_id that names another account is refused with 403). The backend
// dial carries the verified account in X-User-ID plus the shared secret, and
// the socket is registered in hub under that account.
func NewWebSocketProxy(targetURL string, hub *UserHub, internalToken string, checkOrigin OriginChecker) http.HandlerFunc {
	base := wsBase(targetURL)
	upgrader := websocket.Upgrader{CheckOrigin: checkOrigin}

	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := middleware.IdentityFrom(r.Context())
		if !ok || id.UserID <= 0 {
			middleware.WriteError(w, http.StatusUnauthorized, "Authentication required.")
			return
		}
		account := id.UserIDString()
		if claimed := strings.TrimSpace(r.URL.Query().Get("user_id")); claimed != "" && claimed != account {
			middleware.WriteError(w, http.StatusForbidden, "user_id does not match the signed-in account.")
			return
		}
		if checkOrigin != nil && !checkOrigin(r) {
			middleware.WriteError(w, http.StatusForbidden, "Origin not allowed.")
			return
		}

		reqHeader := http.Header{}
		middleware.SetTrustedHeaders(reqHeader, id, internalToken)
		if ua := r.Header.Get("User-Agent"); ua != "" {
			reqHeader.Set("User-Agent", ua)
		}
		backendConn, resp, err := websocket.DefaultDialer.Dial(base+"/ws", reqHeader)
		if err != nil {
			log.Printf("[ws-proxy] dial ai-service /ws failed: %v", err)
			if resp != nil && resp.Body != nil {
				_ = resp.Body.Close()
			}
			middleware.WriteError(w, http.StatusBadGateway, "AI service unavailable")
			return
		}

		clientConn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("[ws-proxy] upgrade error: %v", err)
			_ = backendConn.Close()
			return
		}

		sink := &clientSink{send: make(chan frame, 256), done: make(chan struct{})}
		if hub != nil {
			hub.add(account, sink)
			defer hub.remove(account, sink)
		}
		bridge(clientConn, backendConn, sink, true)
	}
}

// NewStreamProxy bridges a browser socket to the orbit-stream hub's /ws —
// public market ticks, broadcast to everyone, so no identity is needed. The
// browser only receives; anything it sends is discarded.
func NewStreamProxy(streamURL string, checkOrigin OriginChecker) http.HandlerFunc {
	base := wsBase(streamURL)
	upgrader := websocket.Upgrader{CheckOrigin: checkOrigin}

	return func(w http.ResponseWriter, r *http.Request) {
		if checkOrigin != nil && !checkOrigin(r) {
			middleware.WriteError(w, http.StatusForbidden, "Origin not allowed.")
			return
		}
		backendConn, resp, err := websocket.DefaultDialer.Dial(base+"/ws", nil)
		if err != nil {
			if resp != nil && resp.Body != nil {
				_ = resp.Body.Close()
			}
			middleware.WriteError(w, http.StatusBadGateway, "Stream hub unavailable")
			return
		}
		clientConn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			_ = backendConn.Close()
			return
		}
		sink := &clientSink{send: make(chan frame, 256), done: make(chan struct{})}
		bridge(clientConn, backendConn, sink, false)
	}
}

// bridge pumps frames both ways until either side closes. All writes to the
// browser go through sink (gorilla/websocket allows one concurrent writer and
// both the backend stream and hub events write). With forwardClient=false the
// browser's frames are read (to notice close) but not relayed.
func bridge(clientConn, backendConn *websocket.Conn, sink *clientSink, forwardClient bool) {
	var once sync.Once
	closeBoth := func() {
		once.Do(func() {
			close(sink.done)
			_ = clientConn.Close()
			_ = backendConn.Close()
		})
	}
	defer closeBoth()

	errChan := make(chan error, 3)

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

	go func() {
		defer closeBoth()
		for {
			msgType, msg, err := clientConn.ReadMessage()
			if err != nil {
				errChan <- err
				return
			}
			if !forwardClient {
				continue
			}
			if err := backendConn.WriteMessage(msgType, msg); err != nil {
				errChan <- err
				return
			}
		}
	}()

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

	<-errChan
}
