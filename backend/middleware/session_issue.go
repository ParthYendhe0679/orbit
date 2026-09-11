package middleware

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// sessionIssuingPaths are the ai-service endpoints whose success response
// proves who the caller is: a password the ai-service verified (login,
// register) or a Clerk token the gateway verified (auth/sync).
var sessionIssuingPaths = map[string]bool{
	"/api/login":     true,
	"/api/register":  true,
	"/api/auth/sync": true,
}

// IssueSessionOnSuccess is a ReverseProxy.ModifyResponse hook: when one of the
// sessionIssuingPaths returns {"ok": true, "user_id": N}, it adds the
// gateway's HttpOnly session cookie for account N to the response.
func (a *Authenticator) IssueSessionOnSuccess(resp *http.Response) error {
	req := resp.Request
	if req == nil || req.Method != http.MethodPost || !sessionIssuingPaths[req.URL.Path] || resp.StatusCode != http.StatusOK {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	_ = resp.Body.Close()
	if err != nil {
		return err
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.ContentLength = int64(len(body))
	resp.Header.Set("Content-Length", strconv.Itoa(len(body)))

	var payload struct {
		OK       bool        `json:"ok"`
		UserID   json.Number `json:"user_id"`
		Username string      `json:"username"`
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if dec.Decode(&payload) != nil || !payload.OK {
		return nil
	}
	uid, err := payload.UserID.Int64()
	if err != nil || uid <= 0 {
		return nil
	}
	tok, exp, err := a.Sessions.Mint(uid, payload.Username)
	if err != nil {
		return err
	}
	secure := strings.EqualFold(req.Header.Get("X-Forwarded-Proto"), "https")
	cookie := &http.Cookie{
		Name:     SessionCookie,
		Value:    tok,
		Path:     "/",
		Expires:  exp,
		MaxAge:   int(time.Until(exp).Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	}
	resp.Header.Add("Set-Cookie", cookie.String())
	return nil
}

// MeHandler returns the verified account: GET /api/auth/me. The frontend
// restores a session from this instead of trusting localStorage.
func MeHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, ok := IdentityFrom(r.Context())
		if !ok || id.UserID <= 0 {
			WriteError(w, http.StatusUnauthorized, "Authentication required.")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":       true,
			"user_id":  id.UserID,
			"username": id.Username,
			"method":   id.Method,
		})
	})
}

// LogoutHandler clears the gateway session cookie: POST /api/auth/logout.
func (a *Authenticator) LogoutHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.Sessions.ClearCookie(w, r)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})
}
