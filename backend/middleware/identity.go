// Package middleware authenticates browser requests at the Go gateway and
// carries the verified identity to the handlers and to the Python ai-service.
package middleware

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
)

// Identity is a caller whose credentials the gateway verified. UserID is the
// ORBIT account (PostgreSQL "user".id); it is 0 for a Clerk user who has not
// been provisioned yet (first sign-in, before /api/auth/sync).
type Identity struct {
	UserID   int64
	Username string
	ClerkID  string
	Method   string // "clerk" or "session"
}

// UserIDString is the account id as the decimal string used in headers.
func (id *Identity) UserIDString() string {
	return strconv.FormatInt(id.UserID, 10)
}

var (
	ErrNoCredentials  = errors.New("no credentials")
	ErrInvalidToken   = errors.New("invalid or expired token")
	ErrUserNotFound   = errors.New("user not found")
	ErrNotProvisioned = errors.New("account not provisioned")
)

// Trusted headers the gateway sets on requests it forwards to the ai-service.
// Any client-supplied copy is stripped first, so they cannot be spoofed
// through the gateway.
const (
	HeaderUserID        = "X-User-ID"
	HeaderUserClerkID   = "X-User-Clerk-ID"
	HeaderUserName      = "X-User-Name"
	HeaderInternalToken = "X-Orbit-Internal-Token"
)

var spoofableHeaders = []string{
	HeaderUserID, HeaderUserClerkID, HeaderUserName, "X-User-Email", HeaderInternalToken,
}

type ctxKey struct{}

// WithIdentity returns a context carrying id.
func WithIdentity(ctx context.Context, id *Identity) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// IdentityFrom returns the verified identity stored in ctx, if any.
func IdentityFrom(ctx context.Context) (*Identity, bool) {
	id, ok := ctx.Value(ctxKey{}).(*Identity)
	return id, ok && id != nil
}

// StripTrustedHeaders removes every identity/credential header a client could
// use to impersonate the gateway, plus the browser credentials the ai-service
// never needs (tokens and cookies stay at the gateway).
func StripTrustedHeaders(h http.Header) {
	for _, name := range spoofableHeaders {
		h.Del(name)
	}
	h.Del("Authorization")
	h.Del("Cookie")
	// The ai-service refuses browser-originated calls on its trusted paths;
	// requests relayed by the gateway are not browser requests to it.
	h.Del("Origin")
}

// SetTrustedHeaders stamps the verified identity and the gateway's shared
// secret on an outbound request to the ai-service.
func SetTrustedHeaders(h http.Header, id *Identity, internalToken string) {
	if internalToken != "" {
		h.Set(HeaderInternalToken, internalToken)
	}
	if id == nil {
		return
	}
	if id.UserID > 0 {
		h.Set(HeaderUserID, id.UserIDString())
	}
	if id.ClerkID != "" {
		h.Set(HeaderUserClerkID, id.ClerkID)
	}
}

// WriteError writes a FastAPI-shaped error ({"detail": ...}) so the frontend's
// existing error handling reads gateway and ai-service errors the same way.
func WriteError(w http.ResponseWriter, status int, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"detail": detail})
}
