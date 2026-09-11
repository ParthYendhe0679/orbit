package middleware

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ---------------------------------------------------------------------------
// Fake Clerk instance: an RSA key and a JWKS endpoint
// ---------------------------------------------------------------------------

type fakeClerk struct {
	key    *rsa.PrivateKey
	kid    string
	server *httptest.Server
	hits   int
}

func newFakeClerk(t *testing.T) *fakeClerk {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	fc := &fakeClerk{key: key, kid: "ins_test_key"}
	fc.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fc.hits++
		e := big.NewInt(int64(key.PublicKey.E)).Bytes()
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "kid": fc.kid, "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(e),
		}}})
	}))
	t.Cleanup(fc.server.Close)
	return fc
}

func (fc *fakeClerk) issuer() string { return fc.server.URL }

func (fc *fakeClerk) token(t *testing.T, mutate func(jwt.MapClaims, map[string]any)) string {
	t.Helper()
	now := time.Now()
	claims := jwt.MapClaims{
		"iss": fc.issuer(), "sub": "user_2abc", "sid": "sess_1", "azp": "http://localhost:8000",
		"iat": now.Unix(), "nbf": now.Unix() - 5, "exp": now.Add(time.Minute).Unix(),
	}
	header := map[string]any{"kid": fc.kid}
	if mutate != nil {
		mutate(claims, header)
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	for k, v := range header {
		tok.Header[k] = v
	}
	s, err := tok.SignedString(fc.key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func (fc *fakeClerk) verifier(t *testing.T, parties ...string) *ClerkVerifier {
	v, err := NewClerkVerifier(fc.issuer(), "", parties, "")
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestClerkVerifierAcceptsOnlyValidTokens(t *testing.T) {
	fc := newFakeClerk(t)
	v := fc.verifier(t, "http://localhost:8000")
	ctx := context.Background()

	claims, err := v.Verify(ctx, fc.token(t, nil))
	if err != nil || claims.Subject != "user_2abc" {
		t.Fatalf("valid token rejected: %v", err)
	}

	otherKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	forged := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iss": fc.issuer(), "sub": "user_2abc", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(),
	})
	forged.Header["kid"] = fc.kid
	forgedStr, _ := forged.SignedString(otherKey)

	// Algorithm confusion: an HS256 token "signed" with the public modulus.
	confused := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"iss": fc.issuer(), "sub": "user_2abc", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(),
	})
	confused.Header["kid"] = fc.kid
	confusedStr, _ := confused.SignedString(fc.key.PublicKey.N.Bytes())

	unsigned := strings.Join(strings.Split(fc.token(t, nil), ".")[:2], ".") + "."

	bad := map[string]string{
		"expired":          fc.token(t, func(c jwt.MapClaims, _ map[string]any) { c["exp"] = time.Now().Add(-time.Minute).Unix() }),
		"no expiry":        fc.token(t, func(c jwt.MapClaims, _ map[string]any) { delete(c, "exp") }),
		"not yet valid":    fc.token(t, func(c jwt.MapClaims, _ map[string]any) { c["nbf"] = time.Now().Add(time.Hour).Unix() }),
		"issued in future": fc.token(t, func(c jwt.MapClaims, _ map[string]any) { c["iat"] = time.Now().Add(time.Hour).Unix() }),
		"wrong issuer":     fc.token(t, func(c jwt.MapClaims, _ map[string]any) { c["iss"] = "https://evil.clerk.accounts.dev" }),
		"no subject":       fc.token(t, func(c jwt.MapClaims, _ map[string]any) { delete(c, "sub") }),
		"foreign azp":      fc.token(t, func(c jwt.MapClaims, _ map[string]any) { c["azp"] = "http://evil.example" }),
		"unknown kid":      fc.token(t, func(_ jwt.MapClaims, h map[string]any) { h["kid"] = "rotated-away" }),
		"forged signature": forgedStr,
		"alg confusion":    confusedStr,
		"alg none":         unsigned,
		"garbage":          "not.a.jwt",
	}
	for name, tok := range bad {
		if _, err := v.Verify(ctx, tok); err == nil {
			t.Errorf("%s: token accepted", name)
		}
	}
}

func TestClerkVerifierRateLimitsJWKSRefetch(t *testing.T) {
	fc := newFakeClerk(t)
	v := fc.verifier(t)
	for i := 0; i < 5; i++ {
		_, _ = v.Verify(context.Background(), fc.token(t, func(_ jwt.MapClaims, h map[string]any) { h["kid"] = "bogus" }))
	}
	if fc.hits > 1 {
		t.Fatalf("unknown kids triggered %d JWKS fetches; want at most 1", fc.hits)
	}
}

func TestIssuerFromPublishableKey(t *testing.T) {
	iss, err := IssuerFromPublishableKey("pk_test_aGlwLWNhbWVsLTk3ODQuY2xlcmsuYWNjb3VudHMuZGV2JA")
	if err != nil || iss != "https://hip-camel-9784.clerk.accounts.dev" {
		t.Fatalf("got %q, %v", iss, err)
	}
	for _, bad := range []string{"", "sk_test_abc", "pk_test_!!!"} {
		if _, err := IssuerFromPublishableKey(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// ---------------------------------------------------------------------------
// Gateway sessions
// ---------------------------------------------------------------------------

func TestSessionsRoundTripAndRejectTampering(t *testing.T) {
	m, err := NewSessionManager(strings.Repeat("k", 32), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	tok, _, err := m.Mint(12, "trader12")
	if err != nil {
		t.Fatal(err)
	}
	id, err := m.Verify(tok)
	if err != nil || id.UserID != 12 || id.Username != "trader12" {
		t.Fatalf("round trip failed: %+v %v", id, err)
	}

	other, _ := NewSessionManager(strings.Repeat("x", 32), time.Hour)
	foreign, _, _ := other.Mint(12, "x")
	expired := jwt.NewWithClaims(jwt.SigningMethodHS256, sessionClaims{RegisteredClaims: jwt.RegisteredClaims{
		Issuer: sessionIssuer, Audience: jwt.ClaimStrings{sessionIssuer}, Subject: "12",
		IssuedAt: jwt.NewNumericDate(time.Now().Add(-2 * time.Hour)), ExpiresAt: jwt.NewNumericDate(time.Now().Add(-time.Hour)),
	}})
	expiredStr, _ := expired.SignedString([]byte(strings.Repeat("k", 32)))
	parts := strings.Split(tok, ".")
	payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
	swapped := strings.Replace(string(payload), `"sub":"12"`, `"sub":"13"`, 1)
	tampered := parts[0] + "." + base64.RawURLEncoding.EncodeToString([]byte(swapped)) + "." + parts[2]

	for name, bad := range map[string]string{"foreign key": foreign, "expired": expiredStr, "tampered subject": tampered, "empty": ""} {
		if _, err := m.Verify(bad); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := NewSessionManager("short", time.Hour); err == nil {
		t.Error("a short secret was accepted")
	}
}

// ---------------------------------------------------------------------------
// Authenticator
// ---------------------------------------------------------------------------

type mapResolver struct {
	users map[string]int64
	err   error
}

func (m mapResolver) ResolveClerkUser(_ context.Context, clerkID string) (int64, string, error) {
	if m.err != nil {
		return 0, "", m.err
	}
	if id, ok := m.users[clerkID]; ok {
		return id, "trader", nil
	}
	return 0, "", ErrUserNotFound
}

func newAuth(t *testing.T, fc *fakeClerk, r UserResolver) *Authenticator {
	m, _ := NewSessionManager(strings.Repeat("k", 32), time.Hour)
	return &Authenticator{Sessions: m, Clerk: fc.verifier(t), Resolver: r}
}

func TestRequireUser(t *testing.T) {
	fc := newFakeClerk(t)
	a := newAuth(t, fc, mapResolver{users: map[string]int64{"user_2abc": 31}})
	sessTok, _, _ := a.Sessions.Mint(5, "five")
	var seen int64
	h := a.RequireUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, _ := IdentityFrom(r.Context())
		seen = id.UserID
	}))
	do := func(mut func(*http.Request)) int {
		seen = 0
		r := httptest.NewRequest(http.MethodGet, "/api/trades/open", nil)
		mut(r)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}

	if c := do(func(r *http.Request) {}); c != http.StatusUnauthorized {
		t.Fatalf("no credentials: %d", c)
	}
	if c := do(func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+fc.token(t, nil)) }); c != 200 || seen != 31 {
		t.Fatalf("clerk bearer: %d user %d", c, seen)
	}
	if c := do(func(r *http.Request) { r.AddCookie(&http.Cookie{Name: SessionCookie, Value: sessTok}) }); c != 200 || seen != 5 {
		t.Fatalf("session cookie: %d user %d", c, seen)
	}
	if c := do(func(r *http.Request) { r.AddCookie(&http.Cookie{Name: ClerkSessionCookie, Value: fc.token(t, nil)}) }); c != 200 || seen != 31 {
		t.Fatalf("clerk cookie: %d user %d", c, seen)
	}
	// An explicit but invalid Authorization header is never bypassed by a cookie.
	if c := do(func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer forged")
		r.AddCookie(&http.Cookie{Name: SessionCookie, Value: sessTok})
	}); c != http.StatusUnauthorized {
		t.Fatalf("invalid header with valid cookie: %d", c)
	}
	if c := do(func(r *http.Request) { r.Header.Set("Authorization", "Basic dXNlcjpwYXNz") }); c != http.StatusUnauthorized {
		t.Fatalf("basic auth: %d", c)
	}
	expired := fc.token(t, func(c jwt.MapClaims, _ map[string]any) { c["exp"] = time.Now().Add(-time.Minute).Unix() })
	if c := do(func(r *http.Request) { r.AddCookie(&http.Cookie{Name: ClerkSessionCookie, Value: expired}) }); c != http.StatusUnauthorized {
		t.Fatalf("expired clerk cookie: %d", c)
	}
	newcomer := fc.token(t, func(c jwt.MapClaims, _ map[string]any) { c["sub"] = "user_new" })
	if c := do(func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+newcomer) }); c != http.StatusForbidden {
		t.Fatalf("verified but unprovisioned clerk user: %d, want 403", c)
	}

	down := newAuth(t, fc, mapResolver{err: ErrIdentityUnavailable})
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	r.Header.Set("Authorization", "Bearer "+fc.token(t, nil))
	down.RequireUser(http.NotFoundHandler()).ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("resolver outage: %d, want 503", w.Code)
	}
}

func TestRequireClerkIgnoresGatewaySessions(t *testing.T) {
	fc := newFakeClerk(t)
	a := newAuth(t, fc, mapResolver{})
	sessTok, _, _ := a.Sessions.Mint(5, "five")
	var got *Identity
	h := a.RequireClerk(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got, _ = IdentityFrom(r.Context()) }))

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/api/auth/sync", nil)
	r.AddCookie(&http.Cookie{Name: SessionCookie, Value: sessTok})
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("gateway session provisioning: %d", w.Code)
	}
	w = httptest.NewRecorder()
	r = httptest.NewRequest(http.MethodPost, "/api/auth/sync", nil)
	r.Header.Set("Authorization", "Bearer "+fc.token(t, func(c jwt.MapClaims, _ map[string]any) { c["sub"] = "user_first" }))
	h.ServeHTTP(w, r)
	if w.Code != 200 || got == nil || got.ClerkID != "user_first" || got.UserID != 0 {
		t.Fatalf("first clerk sign-in: %d %+v", w.Code, got)
	}
}

// ---------------------------------------------------------------------------
// Account scoping
// ---------------------------------------------------------------------------

func TestEnforceUserScope(t *testing.T) {
	var gotQuery, gotBody string
	h := EnforceUserScope(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query().Get("user_id")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
	}))
	send := func(method, target, body string) int {
		r := httptest.NewRequest(method, target, strings.NewReader(body))
		if body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		r = r.WithContext(WithIdentity(r.Context(), &Identity{UserID: 7}))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	cases := []struct {
		name, method, target, body string
		want                       int
	}{
		{"query of another user", "GET", "/api/trades/open?user_id=8", "", 403},
		{"duplicated query smuggling", "GET", "/api/trades/open?user_id=7&user_id=8", "", 403},
		{"body of another user", "POST", "/api/trade/open", `{"user_id": 8, "symbol": "BTC-USD"}`, 403},
		{"body user as string", "POST", "/api/trade/open", `{"user_id": "8"}`, 403},
		{"body user not an integer", "POST", "/api/trade/open", `{"user_id": "7abc"}`, 403},
		{"body user as object", "POST", "/api/trade/open", `{"user_id": {"$ne": 1}}`, 403},
		{"own query", "GET", "/api/trades/open?user_id=7", "", 200},
		{"own body as float", "POST", "/api/trade/open", `{"user_id": 7.0}`, 200},
		{"absent -> injected", "GET", "/api/trades/pending", "", 200},
		{"body null user", "POST", "/api/bot/session/stop", `{"user_id": null}`, 200},
		{"non-object body", "POST", "/api/x", `[1,2]`, 200},
	}
	for _, c := range cases {
		if got := send(c.method, c.target, c.body); got != c.want {
			t.Errorf("%s: %d, want %d", c.name, got, c.want)
		}
	}
	if send("POST", "/api/trade/open", `{"user_id": 7, "quantity": 1}`) != 200 || gotQuery != "7" || !strings.Contains(gotBody, `"quantity": 1`) {
		t.Fatalf("handler saw query=%q body=%q", gotQuery, gotBody)
	}
	if send("POST", "/api/x", strings.Repeat(" ", maxScopedBody+10)+"{}") != http.StatusRequestEntityTooLarge {
		t.Fatal("oversized body was buffered")
	}
}

func TestAPIAccessIsPrivateByDefault(t *testing.T) {
	public := []string{"/api/health", "/api/auth/config", "/api/login", "/api/register", "/api/news",
		"/api/news/global", "/api/market/quote", "/api/market/BTC-USD", "/api/auth/logout"}
	private := []string{"/api/trades/open", "/api/trade/open", "/api/bot/session/start", "/api/bot-config",
		"/api/dashboard/summary", "/api/report", "/api/chat/conversations", "/api/copilot/chat",
		"/api/brain/analyze", "/api/auth/me", "/api/newsletter", "/api/marketplace", "/api/verify-otp", "/api/unknown"}
	for _, p := range public {
		if APIAccess(p) != AccessPublic {
			t.Errorf("%s should be public", p)
		}
	}
	for _, p := range private {
		if APIAccess(p) != AccessUser {
			t.Errorf("%s should require a signed-in user", p)
		}
	}
	if APIAccess("/api/auth/sync") != AccessClerk {
		t.Error("/api/auth/sync should require a Clerk session")
	}
}

// ---------------------------------------------------------------------------
// Session issuance after a verified login
// ---------------------------------------------------------------------------

func TestIssueSessionOnSuccess(t *testing.T) {
	fc := newFakeClerk(t)
	a := newAuth(t, fc, mapResolver{})
	respond := func(method, path string, status int, body string) *http.Response {
		req := httptest.NewRequest(method, path, nil)
		resp := &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), Request: req}
		if err := a.IssueSessionOnSuccess(resp); err != nil {
			t.Fatal(err)
		}
		return resp
	}
	resp := respond("POST", "/api/login", 200, `{"ok": true, "user_id": 44, "username": "ana"}`)
	cookie := resp.Header.Get("Set-Cookie")
	if !strings.HasPrefix(cookie, SessionCookie+"=") || !strings.Contains(cookie, "HttpOnly") || !strings.Contains(cookie, "SameSite=Strict") {
		t.Fatalf("cookie = %q", cookie)
	}
	tok := strings.TrimPrefix(strings.Split(cookie, ";")[0], SessionCookie+"=")
	if id, err := a.Sessions.Verify(tok); err != nil || id.UserID != 44 || id.Username != "ana" {
		t.Fatalf("issued session invalid: %+v %v", id, err)
	}
	if b, _ := io.ReadAll(resp.Body); !strings.Contains(string(b), `"user_id": 44`) {
		t.Fatal("response body was not preserved")
	}
	for name, r := range map[string]*http.Response{
		"failed login":    respond("POST", "/api/login", 401, `{"detail": "Invalid"}`),
		"ok false":        respond("POST", "/api/login", 200, `{"ok": false, "user_id": 44}`),
		"not a login":     respond("POST", "/api/trade/open", 200, `{"ok": true, "user_id": 44}`),
		"GET login":       respond("GET", "/api/login", 200, `{"ok": true, "user_id": 44}`),
		"bogus user id":   respond("POST", "/api/register", 200, `{"ok": true, "user_id": "x"}`),
		"non-JSON answer": respond("POST", "/api/auth/sync", 200, `<html>`),
	} {
		if r.Header.Get("Set-Cookie") != "" {
			t.Errorf("%s: a session was issued", name)
		}
	}
}

func TestJSONUserID(t *testing.T) {
	cases := map[string]struct {
		v              string
		present, valid bool
	}{
		`{"user_id": 7}`:      {"7", true, true},
		`{"user_id": "7"}`:    {"7", true, true},
		`{"user_id": 7.5}`:    {"", true, false},
		`{"user_id": true}`:   {"", true, false},
		`{"other": 1}`:        {"", false, true},
		`nonsense`:            {"", false, true},
		`{"user_id": 1e1000}`: {"", true, false},
	}
	for in, want := range cases {
		v, present, valid := jsonUserID([]byte(in))
		if v != want.v || present != want.present || valid != want.valid {
			t.Errorf("%s -> %q %v %v", in, v, present, valid)
		}
	}
	if !errors.Is(ErrInvalidToken, ErrInvalidToken) {
		t.Fatal("sanity")
	}
}
