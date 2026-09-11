package middleware

import (
	"crypto/rand"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// SessionCookie holds the gateway-issued session token. It is HttpOnly (page
// scripts cannot read it) and SameSite=Strict (other sites cannot send it),
// and it is what the browser presents on the /ws handshake.
const SessionCookie = "orbit_session"

const sessionIssuer = "orbit-gateway"

// SessionManager mints and verifies HS256 session tokens. Sessions are issued
// only after the ai-service verified a password (/api/login, /api/register)
// or the gateway verified a Clerk token (/api/auth/sync).
type SessionManager struct {
	secret    []byte
	ttl       time.Duration
	ephemeral bool
}

type sessionClaims struct {
	Name string `json:"name,omitempty"`
	jwt.RegisteredClaims
}

// NewSessionManager uses secret when given; otherwise a random per-process key
// (every session then ends when the gateway restarts).
func NewSessionManager(secret string, ttl time.Duration) (*SessionManager, error) {
	m := &SessionManager{ttl: ttl}
	if ttl <= 0 {
		m.ttl = 12 * time.Hour
	}
	if secret != "" {
		if len(secret) < 32 {
			return nil, errors.New("ORBIT_SESSION_SECRET must be at least 32 characters")
		}
		m.secret = []byte(secret)
		return m, nil
	}
	m.secret = make([]byte, 32)
	if _, err := rand.Read(m.secret); err != nil {
		return nil, err
	}
	m.ephemeral = true
	return m, nil
}

// Ephemeral reports whether the signing key lives only in this process.
func (m *SessionManager) Ephemeral() bool { return m.ephemeral }

// Mint returns a signed session token for the account and its expiry.
func (m *SessionManager) Mint(userID int64, username string) (string, time.Time, error) {
	if userID <= 0 {
		return "", time.Time{}, errors.New("session requires a positive user id")
	}
	now := time.Now()
	exp := now.Add(m.ttl)
	claims := sessionClaims{
		Name: username,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    sessionIssuer,
			Audience:  jwt.ClaimStrings{sessionIssuer},
			Subject:   strconv.FormatInt(userID, 10),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	}
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(m.secret)
	return tok, exp, err
}

// Verify checks the signature (HS256 only), expiry, issuer and audience.
func (m *SessionManager) Verify(token string) (*Identity, error) {
	claims := &sessionClaims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(*jwt.Token) (any, error) {
		return m.secret, nil
	},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(sessionIssuer),
		jwt.WithAudience(sessionIssuer),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(5*time.Second),
	)
	if err != nil || !parsed.Valid {
		return nil, ErrInvalidToken
	}
	uid, err := strconv.ParseInt(claims.Subject, 10, 64)
	if err != nil || uid <= 0 {
		return nil, ErrInvalidToken
	}
	return &Identity{UserID: uid, Username: claims.Name, Method: "session"}, nil
}

// SetCookie attaches the session cookie to the response.
func (m *SessionManager) SetCookie(w http.ResponseWriter, r *http.Request, token string, exp time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		Expires:  exp,
		MaxAge:   int(time.Until(exp).Seconds()),
		HttpOnly: true,
		Secure:   isSecureRequest(r),
		SameSite: http.SameSiteStrictMode,
	})
}

// ClearCookie expires the session cookie.
func (m *SessionManager) ClearCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
		HttpOnly: true,
		Secure:   isSecureRequest(r),
		SameSite: http.SameSiteStrictMode,
	})
}

func isSecureRequest(r *http.Request) bool {
	if r == nil {
		return false
	}
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}
