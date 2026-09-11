package middleware

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ClerkClaims are the Clerk session-token claims the gateway relies on.
// Clerk session tokens carry no email by default, so identity is `sub`.
type ClerkClaims struct {
	AuthorizedParty string `json:"azp,omitempty"`
	SessionID       string `json:"sid,omitempty"`
	jwt.RegisteredClaims
}

// ClerkVerifier verifies Clerk session JWTs against the instance's JWKS:
// RS256 signature, expiry, not-before, issued-at, issuer, subject, and — when
// configured — authorized party (azp) and audience.
type ClerkVerifier struct {
	issuer   string
	jwksURL  string
	parties  map[string]struct{}
	audience string
	client   *http.Client

	mu          sync.RWMutex
	keys        map[string]*rsa.PublicKey
	fetchedAt   time.Time
	lastAttempt time.Time
	refreshMu   sync.Mutex
}

const (
	jwksMaxAge          = time.Hour
	jwksMinRefreshDelay = 30 * time.Second
	clerkLeeway         = 5 * time.Second
)

// IssuerFromPublishableKey derives the Clerk Frontend API origin, which is the
// token issuer: pk_test_<base64("<host>$")> -> https://<host>.
func IssuerFromPublishableKey(pk string) (string, error) {
	pk = strings.TrimSpace(pk)
	var encoded string
	switch {
	case strings.HasPrefix(pk, "pk_test_"):
		encoded = strings.TrimPrefix(pk, "pk_test_")
	case strings.HasPrefix(pk, "pk_live_"):
		encoded = strings.TrimPrefix(pk, "pk_live_")
	default:
		return "", errors.New("not a Clerk publishable key")
	}
	raw, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(encoded, "="))
	if err != nil {
		return "", fmt.Errorf("decode publishable key: %w", err)
	}
	host := strings.TrimSuffix(string(raw), "$")
	if host == "" || strings.ContainsAny(host, "/ ") {
		return "", errors.New("publishable key has no valid Frontend API host")
	}
	return "https://" + host, nil
}

// NewClerkVerifier builds a verifier. jwksURL defaults to
// <issuer>/.well-known/jwks.json; parties restricts azp when non-empty.
func NewClerkVerifier(issuer, jwksURL string, parties []string, audience string) (*ClerkVerifier, error) {
	issuer = strings.TrimRight(strings.TrimSpace(issuer), "/")
	if !strings.HasPrefix(issuer, "https://") && !strings.HasPrefix(issuer, "http://") {
		return nil, errors.New("clerk issuer must be an absolute URL")
	}
	if jwksURL == "" {
		jwksURL = issuer + "/.well-known/jwks.json"
	}
	v := &ClerkVerifier{
		issuer:   issuer,
		jwksURL:  jwksURL,
		parties:  map[string]struct{}{},
		audience: audience,
		client:   &http.Client{Timeout: 5 * time.Second},
		keys:     map[string]*rsa.PublicKey{},
	}
	for _, p := range parties {
		v.parties[strings.TrimRight(p, "/")] = struct{}{}
	}
	return v, nil
}

// Issuer is the expected `iss` claim.
func (v *ClerkVerifier) Issuer() string { return v.issuer }

// Verify returns the claims of a valid Clerk session token.
func (v *ClerkVerifier) Verify(ctx context.Context, token string) (*ClerkClaims, error) {
	opts := []jwt.ParserOption{
		jwt.WithValidMethods([]string{jwt.SigningMethodRS256.Alg()}),
		jwt.WithIssuer(v.issuer),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(clerkLeeway),
	}
	if v.audience != "" {
		opts = append(opts, jwt.WithAudience(v.audience))
	}
	claims := &ClerkClaims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		if kid == "" {
			return nil, errors.New("token has no kid")
		}
		return v.key(ctx, kid)
	}, opts...)
	if err != nil || !parsed.Valid {
		return nil, ErrInvalidToken
	}
	if strings.TrimSpace(claims.Subject) == "" {
		return nil, ErrInvalidToken
	}
	if len(v.parties) > 0 && claims.AuthorizedParty != "" {
		if _, ok := v.parties[strings.TrimRight(claims.AuthorizedParty, "/")]; !ok {
			return nil, ErrInvalidToken
		}
	}
	return claims, nil
}

func (v *ClerkVerifier) key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	v.mu.RLock()
	k, ok := v.keys[kid]
	stale := time.Since(v.fetchedAt) > jwksMaxAge
	v.mu.RUnlock()
	if ok && !stale {
		return k, nil
	}
	// Unknown kid (key rotation) or a cache older than an hour: refetch, but
	// never more than once per jwksMinRefreshDelay so bogus kids cannot turn
	// the gateway into a JWKS request amplifier.
	if err := v.refresh(ctx); err != nil && !ok {
		return nil, err
	}
	v.mu.RLock()
	defer v.mu.RUnlock()
	if k, ok := v.keys[kid]; ok {
		return k, nil
	}
	return nil, fmt.Errorf("unknown signing key %q", kid)
}

func (v *ClerkVerifier) refresh(ctx context.Context) error {
	v.refreshMu.Lock()
	defer v.refreshMu.Unlock()
	v.mu.RLock()
	recent := time.Since(v.lastAttempt) < jwksMinRefreshDelay
	v.mu.RUnlock()
	if recent {
		return nil
	}
	v.mu.Lock()
	v.lastAttempt = time.Now()
	v.mu.Unlock()

	keys, err := fetchJWKS(ctx, v.client, v.jwksURL)
	if err != nil {
		return err
	}
	v.mu.Lock()
	v.keys = keys
	v.fetchedAt = time.Now()
	v.mu.Unlock()
	return nil
}

type jwksDoc struct {
	Keys []struct {
		Kty string `json:"kty"`
		Kid string `json:"kid"`
		Use string `json:"use"`
		Alg string `json:"alg"`
		N   string `json:"n"`
		E   string `json:"e"`
	} `json:"keys"`
}

func fetchJWKS(ctx context.Context, client *http.Client, url string) (map[string]*rsa.PublicKey, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch JWKS: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch JWKS: status %d", resp.StatusCode)
	}
	var doc jwksDoc
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&doc); err != nil {
		return nil, fmt.Errorf("decode JWKS: %w", err)
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range doc.Keys {
		if k.Kty != "RSA" || k.Kid == "" || (k.Use != "" && k.Use != "sig") {
			continue
		}
		n, errN := base64.RawURLEncoding.DecodeString(k.N)
		e, errE := base64.RawURLEncoding.DecodeString(k.E)
		if errN != nil || errE != nil || len(e) == 0 || len(e) > 4 {
			continue
		}
		exp := 0
		for _, b := range e {
			exp = exp<<8 | int(b)
		}
		pub := &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: exp}
		if pub.N.BitLen() < 2048 {
			continue
		}
		keys[k.Kid] = pub
	}
	if len(keys) == 0 {
		return nil, errors.New("JWKS contains no usable RSA signing keys")
	}
	return keys, nil
}
