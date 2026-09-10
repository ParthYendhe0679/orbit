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

// NewWebSocketProxy creates a transparent bi-directional WebSocket proxy to the AI service.
// Preserves route query parameters (/ws?user_id=...&username=...) and message frames exactly.
func NewWebSocketProxy(targetURL string) http.HandlerFunc {
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

		var once sync.Once
		closeBoth := func() {
			once.Do(func() {
				_ = clientConn.Close()
				_ = backendConn.Close()
			})
		}

		errChan := make(chan error, 2)

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

		// Forward from backend to client
		go func() {
			for {
				msgType, msg, err := backendConn.ReadMessage()
				if err != nil {
					errChan <- err
					break
				}
				if err := clientConn.WriteMessage(msgType, msg); err != nil {
					errChan <- err
					break
				}
			}
			closeBoth()
		}()

		// Wait until either stream terminates
		<-errChan
	}
}
