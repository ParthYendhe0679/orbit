package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mochatrade/backend/handlers"
	"github.com/mochatrade/backend/middleware"
	"github.com/mochatrade/backend/proxy"
	"github.com/mochatrade/backend/readapi"
)

// fakeAI records what the gateway forwards to the ai-service.
type fakeAI struct {
	mu   sync.Mutex
	hits []*http.Request
}

func (f *fakeAI) last() *http.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.hits) == 0 {
		return nil
	}
	return f.hits[len(f.hits)-1]
}

func (f *fakeAI) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.hits)
}

func (f *fakeAI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.hits = append(f.hits, r.Clone(r.Context()))
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/api/login":
		_, _ = io.WriteString(w, `{"ok": true, "user_id": 5, "username": "fiona"}`)
	case "/health":
		_, _ = io.WriteString(w, `{"status": "healthy"}`)
	default:
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "path": r.URL.Path})
	}
}

func newTestGateway(t *testing.T) (*httptest.Server, *fakeAI, *middleware.Authenticator) {
	t.Helper()
	ai := &fakeAI{}
	aiSrv := httptest.NewServer(ai)
	t.Cleanup(aiSrv.Close)
	sessions, _ := middleware.NewSessionManager(strings.Repeat("s", 32), time.Hour)
	authn := &middleware.Authenticator{Sessions: sessions}
	apiProxy, err := proxy.NewHTTPProxy(aiSrv.URL, "gw-token", authn.IssueSessionOnSuccess)
	if err != nil {
		t.Fatal(err)
	}
	g := &gateway{
		aiURL:         aiSrv.URL,
		streamURL:     aiSrv.URL,
		internalToken: "gw-token",
		authn:         authn,
		apiProxy:      apiProxy,
		read:          &readapi.Handlers{Fallback: apiProxy},
		hub:           proxy.NewUserHub(),
		health:        handlers.HealthHandler(handlers.HealthDeps{AIServiceURL: aiSrv.URL}),
	}
	srv := httptest.NewServer(g.routes())
	t.Cleanup(srv.Close)
	return srv, ai, authn
}

func newClient(t *testing.T) *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar}
}

func TestGatewayAuthenticatesBeforeForwarding(t *testing.T) {
	srv, ai, _ := newTestGateway(t)
	anon := newClient(t)

	for _, path := range []string{"/api/trades/open", "/api/trades/pending", "/api/bot/session/current",
		"/api/brain/analyze?symbol=BTC-USD", "/api/chat/conversations", "/api/report", "/api/auth/me"} {
		before := ai.count()
		resp, err := anon.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s anonymous: %d, want 401", path, resp.StatusCode)
		}
		if ai.count() != before {
			t.Errorf("%s: unauthenticated request reached the ai-service", path)
		}
	}

	// Public data needs no session, and client identity headers never pass.
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/market/quote?symbol=BTC-USD", nil)
	req.Header.Set("X-User-ID", "1")
	resp, err := anon.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || ai.last().Header.Get("X-User-ID") != "" {
		t.Fatalf("public market route: %d, forwarded X-User-ID=%q", resp.StatusCode, ai.last().Header.Get("X-User-ID"))
	}

	// Provisioning needs a Clerk session; none is configured here.
	resp, _ = anon.Post(srv.URL+"/api/auth/sync", "application/json", strings.NewReader(`{"clerk_id":"user_x"}`))
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("/api/auth/sync without Clerk: %d", resp.StatusCode)
	}
}

func TestGatewaySessionLifecycle(t *testing.T) {
	srv, ai, _ := newTestGateway(t)
	c := newClient(t)

	resp, err := c.Post(srv.URL+"/api/login", "application/json", strings.NewReader(`{"username":"fiona","password":"pw"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	var session *http.Cookie
	for _, ck := range resp.Cookies() {
		if ck.Name == middleware.SessionCookie {
			session = ck
		}
	}
	if session == nil || !session.HttpOnly || session.SameSite != http.SameSiteStrictMode {
		t.Fatalf("login did not issue an HttpOnly/Strict session cookie: %+v", resp.Cookies())
	}

	// The session scopes forwarded requests to account 5.
	resp, _ = c.Get(srv.URL + "/api/trades/pending")
	resp.Body.Close()
	fwd := ai.last()
	if resp.StatusCode != 200 || fwd.Header.Get("X-User-ID") != "5" || fwd.URL.Query().Get("user_id") != "5" ||
		fwd.Header.Get("X-Orbit-Internal-Token") != "gw-token" || fwd.Header.Get("Cookie") != "" {
		t.Fatalf("forwarded: status=%d X-User-ID=%q user_id=%q token=%q cookie=%q", resp.StatusCode,
			fwd.Header.Get("X-User-ID"), fwd.URL.Query().Get("user_id"), fwd.Header.Get("X-Orbit-Internal-Token"), fwd.Header.Get("Cookie"))
	}
	// Go-native read endpoints (no database here) hand over to the ai-service, scoped the same way.
	resp, _ = c.Get(srv.URL + "/api/dashboard/summary?user_id=5")
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get(readapi.SourceHeader) != "ai-service" || ai.last().Header.Get("X-User-ID") != "5" {
		t.Fatalf("dashboard fallback: %d %q", resp.StatusCode, resp.Header.Get(readapi.SourceHeader))
	}

	// Asking for someone else's data is forbidden, in the query or the body.
	before := ai.count()
	resp, _ = c.Get(srv.URL + "/api/trades/open?user_id=6")
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign user_id in query: %d", resp.StatusCode)
	}
	resp, _ = c.Post(srv.URL+"/api/trade/open", "application/json", strings.NewReader(`{"user_id": 6, "symbol": "BTC-USD", "quantity": 1}`))
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden || ai.count() != before {
		t.Fatalf("foreign user_id in body: %d (forwarded: %v)", resp.StatusCode, ai.count() != before)
	}

	resp, _ = c.Get(srv.URL + "/api/auth/me")
	var me map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&me)
	resp.Body.Close()
	if me["user_id"] != float64(5) || me["username"] != "fiona" {
		t.Fatalf("/api/auth/me = %v", me)
	}

	resp, _ = c.Post(srv.URL+"/api/auth/logout", "application/json", nil)
	resp.Body.Close()
	resp, _ = c.Get(srv.URL + "/api/trades/pending")
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("after logout: %d, want 401", resp.StatusCode)
	}
}

func TestGatewayRejectsPathTricksAndForeignOrigins(t *testing.T) {
	srv, ai, _ := newTestGateway(t)
	c := newClient(t)

	for _, raw := range []string{"/api/%2e%2e/internal/bot/analysis", "/api/..%2Finternal/bot/analysis"} {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+raw, nil)
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode == 200 {
			t.Errorf("%s reached a handler", raw)
		}
	}
	if last := ai.last(); last != nil && strings.HasPrefix(last.URL.Path, "/internal/") {
		t.Fatal("an /internal path was forwarded to the ai-service")
	}

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/market/quote", nil)
	req.Header.Set("Origin", "http://evil.example")
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.Header.Get("Access-Control-Allow-Origin") != "" || resp.Header.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatal("a foreign origin received CORS credentials")
	}
}
