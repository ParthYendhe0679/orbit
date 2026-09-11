package handlers

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"

	"github.com/mochatrade/backend/proxy"
)

// InternalAuthorized reports whether a request may use the gateway's
// /internal/* endpoints. With a token configured the X-Orbit-Internal-Token
// header must match; without one only loopback callers are accepted. Browser
// requests (they always carry Origin on cross-site POSTs) are refused either way.
func InternalAuthorized(r *http.Request, token string) bool {
	if r.Header.Get("Origin") != "" {
		return false
	}
	if token != "" {
		supplied := r.Header.Get("X-Orbit-Internal-Token")
		return subtle.ConstantTimeCompare([]byte(supplied), []byte(token)) == 1
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

type publishRequest struct {
	UserID  string          `json:"user_id"`
	Message json.RawMessage `json:"message"`
}

// PublishUserEventHandler lets the ai-service push a JSON message to every
// proxied socket of one user. Responds {"delivered": n}.
func PublishUserEventHandler(hub *proxy.UserHub, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !InternalAuthorized(r, token) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 256*1024))
		if err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		var req publishRequest
		if err := json.Unmarshal(body, &req); err != nil || strings.TrimSpace(req.UserID) == "" || !json.Valid(req.Message) {
			http.Error(w, "expected {\"user_id\": ..., \"message\": {...}}", http.StatusBadRequest)
			return
		}
		delivered := hub.Publish(strings.TrimSpace(req.UserID), req.Message)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int{"delivered": delivered})
	}
}

// BotSchedulerStatsHandler exposes the scheduler's read-only counters.
func BotSchedulerStatsHandler(stats func() map[string]any) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if stats == nil {
			_ = json.NewEncoder(w).Encode(map[string]any{"enabled": false})
			return
		}
		out := stats()
		out["enabled"] = true
		_ = json.NewEncoder(w).Encode(out)
	}
}
