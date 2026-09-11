package middleware

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// ClerkSessionCookie is the cookie clerk-js keeps refreshed with the current
// session token on the application's own domain.
const ClerkSessionCookie = "__session"

// maxScopedBody bounds how much of a JSON request body the gateway buffers to
// check its user_id field.
const maxScopedBody = 1 << 20

// ErrIdentityUnavailable means credentials were valid but the account lookup
// failed (database / ai-service down) — a 503, not a 401.
var ErrIdentityUnavailable = errors.New("identity lookup unavailable")

// Authenticator turns request credentials into a verified Identity.
//
// Accepted credentials, in order:
//  1. Authorization: Bearer <token> — a gateway session (HS256) or a Clerk
//     session token (RS256, verified against the Clerk JWKS). When present it
//     is authoritative: an invalid header is rejected, never skipped.
//  2. The orbit_session cookie (gateway session).
//  3. The __session cookie (Clerk session token).
type Authenticator struct {
	Sessions *SessionManager
	Clerk    *ClerkVerifier // nil when Clerk is not configured
	Resolver UserResolver   // maps Clerk users to ORBIT accounts
}

// Identify verifies the request's credentials.
func (a *Authenticator) Identify(r *http.Request) (*Identity, error) {
	if h := r.Header.Get("Authorization"); h != "" {
		tok, ok := bearer(h)
		if !ok {
			return nil, ErrInvalidToken
		}
		return a.verifyToken(r.Context(), tok)
	}
	sawCredential := false
	if c, err := r.Cookie(SessionCookie); err == nil && c.Value != "" {
		sawCredential = true
		if id, err := a.Sessions.Verify(c.Value); err == nil {
			return id, nil
		}
	}
	if c, err := r.Cookie(ClerkSessionCookie); err == nil && c.Value != "" && a.Clerk != nil {
		sawCredential = true
		id, err := a.verifyClerk(r.Context(), c.Value)
		if err == nil || errors.Is(err, ErrIdentityUnavailable) {
			return id, err
		}
	}
	if sawCredential {
		return nil, ErrInvalidToken
	}
	return nil, ErrNoCredentials
}

// IdentifyClerk accepts only Clerk credentials (header or __session cookie).
// /api/auth/sync uses it: provisioning an account needs a verified Clerk user.
func (a *Authenticator) IdentifyClerk(r *http.Request) (*Identity, error) {
	if a.Clerk == nil {
		return nil, ErrNoCredentials
	}
	if h := r.Header.Get("Authorization"); h != "" {
		tok, ok := bearer(h)
		if !ok || tokenAlg(tok) != jwt.SigningMethodRS256.Alg() {
			return nil, ErrInvalidToken
		}
		return a.verifyClerk(r.Context(), tok)
	}
	if c, err := r.Cookie(ClerkSessionCookie); err == nil && c.Value != "" {
		return a.verifyClerk(r.Context(), c.Value)
	}
	return nil, ErrNoCredentials
}

func (a *Authenticator) verifyToken(ctx context.Context, tok string) (*Identity, error) {
	switch tokenAlg(tok) {
	case jwt.SigningMethodHS256.Alg():
		return a.Sessions.Verify(tok)
	case jwt.SigningMethodRS256.Alg():
		if a.Clerk == nil {
			return nil, ErrInvalidToken
		}
		return a.verifyClerk(ctx, tok)
	default:
		return nil, ErrInvalidToken
	}
}

func (a *Authenticator) verifyClerk(ctx context.Context, tok string) (*Identity, error) {
	claims, err := a.Clerk.Verify(ctx, tok)
	if err != nil {
		return nil, ErrInvalidToken
	}
	id := &Identity{ClerkID: claims.Subject, Method: "clerk"}
	if a.Resolver == nil {
		return id, nil
	}
	uid, name, err := a.Resolver.ResolveClerkUser(ctx, claims.Subject)
	switch {
	case err == nil:
		id.UserID, id.Username = uid, name
	case errors.Is(err, ErrUserNotFound):
		// Verified Clerk user without an ORBIT account yet (first sign-in).
	default:
		log.Printf("[auth] account lookup for a verified Clerk user failed: %v", err)
		return nil, ErrIdentityUnavailable
	}
	return id, nil
}

func bearer(h string) (string, bool) {
	scheme, tok, ok := strings.Cut(strings.TrimSpace(h), " ")
	tok = strings.TrimSpace(tok)
	return tok, ok && strings.EqualFold(scheme, "Bearer") && tok != ""
}

// tokenAlg reads the (unverified) header alg only to pick the verifier; the
// chosen verifier then enforces that exact algorithm on the signature.
func tokenAlg(tok string) string {
	t, _, err := jwt.NewParser().ParseUnverified(tok, jwt.MapClaims{})
	if err != nil {
		return ""
	}
	alg, _ := t.Header["alg"].(string)
	return alg
}

func writeAuthError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrIdentityUnavailable):
		WriteError(w, http.StatusServiceUnavailable, "Account service temporarily unavailable. Please retry.")
	case errors.Is(err, ErrNoCredentials):
		WriteError(w, http.StatusUnauthorized, "Authentication required.")
	default:
		WriteError(w, http.StatusUnauthorized, "Invalid or expired session. Please sign in again.")
	}
}

// RequireUser admits only callers with a verified identity bound to an ORBIT
// account: 401 without valid credentials, 403 for a verified Clerk user who
// has no account yet.
func (a *Authenticator) RequireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := a.Identify(r)
		if err != nil {
			writeAuthError(w, err)
			return
		}
		if id.UserID <= 0 {
			WriteError(w, http.StatusForbidden, "Account not provisioned. Complete sign-in to create your trading account.")
			return
		}
		next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), id)))
	})
}

// RequireClerk admits only callers presenting a verified Clerk session.
func (a *Authenticator) RequireClerk(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := a.IdentifyClerk(r)
		if err != nil {
			writeAuthError(w, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), id)))
	})
}

// EnforceUserScope binds a request to the verified account: a user_id in the
// query string or JSON body that names anyone else is refused with 403, and
// the query's user_id is set to the verified account for the handler/proxy.
// Must run after RequireUser.
func EnforceUserScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, ok := IdentityFrom(r.Context())
		if !ok || id.UserID <= 0 {
			WriteError(w, http.StatusUnauthorized, "Authentication required.")
			return
		}
		want := id.UserIDString()
		q := r.URL.Query()
		for _, v := range q["user_id"] {
			if strings.TrimSpace(v) != want {
				WriteError(w, http.StatusForbidden, "user_id does not match the signed-in account.")
				return
			}
		}
		if isJSONBody(r) {
			body, err := io.ReadAll(io.LimitReader(r.Body, maxScopedBody+1))
			_ = r.Body.Close()
			if err != nil {
				WriteError(w, http.StatusBadRequest, "Could not read request body.")
				return
			}
			if len(body) > maxScopedBody {
				WriteError(w, http.StatusRequestEntityTooLarge, "Request body too large.")
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			r.ContentLength = int64(len(body))
			if got, present, valid := jsonUserID(body); present && (!valid || got != want) {
				WriteError(w, http.StatusForbidden, "user_id does not match the signed-in account.")
				return
			}
		}
		q.Set("user_id", want)
		r.URL.RawQuery = q.Encode()
		next.ServeHTTP(w, r)
	})
}

func isJSONBody(r *http.Request) bool {
	if r.Body == nil || r.Body == http.NoBody {
		return false
	}
	return strings.Contains(strings.ToLower(r.Header.Get("Content-Type")), "json")
}

// jsonUserID extracts a top-level "user_id" from a JSON object body.
// present=false when absent or null; valid=false when it is not an integer.
func jsonUserID(body []byte) (value string, present bool, valid bool) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(body, &obj); err != nil {
		return "", false, true // not an object: nothing to check
	}
	raw, ok := obj["user_id"]
	if !ok || string(bytes.TrimSpace(raw)) == "null" {
		return "", false, true
	}
	var num json.Number
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return "", true, false
	}
	switch t := v.(type) {
	case json.Number:
		num = t
	case string:
		num = json.Number(strings.TrimSpace(t))
	default:
		return "", true, false
	}
	if i, err := num.Int64(); err == nil {
		return strconv.FormatInt(i, 10), true, true
	}
	if f, err := num.Float64(); err == nil && f == float64(int64(f)) {
		return strconv.FormatInt(int64(f), 10), true, true
	}
	return "", true, false
}

// Access is the authentication an /api route requires at the gateway.
type Access int

const (
	// AccessPublic needs no credentials (health, market data, news, login).
	AccessPublic Access = iota
	// AccessClerk needs a verified Clerk session (account provisioning).
	AccessClerk
	// AccessUser needs a verified identity bound to an ORBIT account; the
	// request is scoped to that account.
	AccessUser
)

var publicAPIRoutes = map[string]bool{
	"/api/health":      true,
	"/api/auth/config": true,
	"/api/login":       true,
	"/api/register":    true,
	"/api/auth/logout": true,
	"/api/news":        true,
	"/api/news/global": true,
}

// APIAccess classifies an /api path. Anything not explicitly public is
// user-scoped: new endpoints are private by default.
func APIAccess(path string) Access {
	if publicAPIRoutes[path] || path == "/api/market" || strings.HasPrefix(path, "/api/market/") {
		return AccessPublic
	}
	if path == "/api/auth/sync" {
		return AccessClerk
	}
	return AccessUser
}
