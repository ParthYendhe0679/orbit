package proxy

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/mochatrade/backend/middleware"
)

func TestUserHubPublishesOnlyToThatUser(t *testing.T) {
	h := NewUserHub()
	a1 := &clientSink{send: make(chan frame, 4), done: make(chan struct{})}
	a2 := &clientSink{send: make(chan frame, 4), done: make(chan struct{})}
	b := &clientSink{send: make(chan frame, 4), done: make(chan struct{})}
	h.add("1", a1)
	h.add("1", a2)
	h.add("2", b)

	if n := h.Publish("1", []byte(`{"type":"bot_event"}`)); n != 2 {
		t.Fatalf("delivered to %d sockets; want 2", n)
	}
	if len(b.send) != 0 {
		t.Fatal("another user's socket received the event")
	}
	h.remove("1", a2)
	if n := h.Publish("1", []byte(`{}`)); n != 1 {
		t.Fatalf("after removal delivered to %d; want 1", n)
	}
	close(a1.done)
	if n := h.Publish("1", []byte(`{}`)); n != 0 {
		t.Fatalf("closed socket accepted a frame")
	}
	if h.Publish("nobody", []byte(`{}`)) != 0 {
		t.Fatal("unknown user must reach nobody")
	}
}

func TestUserHubDropsInsteadOfBlockingOnSlowSockets(t *testing.T) {
	h := NewUserHub()
	slow := &clientSink{send: make(chan frame, 1), done: make(chan struct{})}
	h.add("1", slow)
	h.Publish("1", []byte(`{}`))
	done := make(chan int)
	go func() { done <- h.Publish("1", []byte(`{}`)) }()
	select {
	case n := <-done:
		if n != 0 {
			t.Fatalf("full buffer reported delivery %d", n)
		}
	case <-time.After(time.Second):
		t.Fatal("Publish blocked on a slow socket")
	}
}

// asUser stands in for Authenticator.RequireUser in these tests: the verified
// account comes from the X-Test-User header (absent -> no identity).
func asUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if v := r.Header.Get("X-Test-User"); v != "" {
			uid, _ := strconv.ParseInt(v, 10, 64)
			r = r.WithContext(middleware.WithIdentity(r.Context(), &middleware.Identity{UserID: uid, Method: "session"}))
		}
		next.ServeHTTP(w, r)
	})
}

func userHeader(uid string) http.Header {
	h := http.Header{}
	h.Set("X-Test-User", uid)
	return h
}

// End to end: backend frames and hub events both reach the browser through the
// proxy's single writer, only the verified account receives hub events, and
// the ai-service sees the verified account (not the client's claim).
func TestWebSocketProxyInterleavesBackendFramesAndUserEvents(t *testing.T) {
	up := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	var mu sync.Mutex
	seenUsers := map[string]bool{}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seenUsers[r.Header.Get(middleware.HeaderUserID)+"|"+r.Header.Get(middleware.HeaderInternalToken)] = true
		mu.Unlock()
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		for i := 0; i < 50; i++ {
			if err := c.WriteMessage(websocket.TextMessage, []byte(`{"type":"tick"}`)); err != nil {
				return
			}
		}
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer backend.Close()

	hub := NewUserHub()
	gw := httptest.NewServer(asUser(NewWebSocketProxy(backend.URL, hub, "tok", SameOriginOrAllowed(nil))))
	defer gw.Close()
	wsURL := "ws" + strings.TrimPrefix(gw.URL, "http")

	alice, _, err := websocket.DefaultDialer.Dial(wsURL+"/ws", userHeader("42"))
	if err != nil {
		t.Fatal(err)
	}
	defer alice.Close()
	bob, _, err := websocket.DefaultDialer.Dial(wsURL+"/ws", userHeader("43"))
	if err != nil {
		t.Fatal(err)
	}
	defer bob.Close()

	waitFor := func(cond func() bool) {
		deadline := time.Now().Add(2 * time.Second)
		for !cond() && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
	}
	waitFor(func() bool { return hub.Connections() == 2 })

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); hub.Publish("42", []byte(`{"type":"bot_event"}`)) }()
	}
	wg.Wait()

	count := func(c *websocket.Conn, want string, limit int) int {
		n := 0
		_ = c.SetReadDeadline(time.Now().Add(700 * time.Millisecond))
		for i := 0; i < limit; i++ {
			_, msg, err := c.ReadMessage()
			if err != nil {
				break
			}
			if strings.Contains(string(msg), want) {
				n++
			}
		}
		return n
	}
	if got := count(alice, "bot_event", 200); got != 20 {
		t.Fatalf("alice received %d bot events; want 20", got)
	}
	if got := count(bob, "bot_event", 200); got != 0 {
		t.Fatalf("bob received %d of alice's bot events", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if !seenUsers["42|tok"] || !seenUsers["43|tok"] {
		t.Fatalf("ai-service did not receive the verified accounts and gateway token: %v", seenUsers)
	}
}

func TestWebSocketProxyRefusesBeforeDialing(t *testing.T) {
	var dials int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&dials, 1)
	}))
	defer backend.Close()
	gw := httptest.NewServer(asUser(NewWebSocketProxy(backend.URL, NewUserHub(), "", SameOriginOrAllowed(nil))))
	defer gw.Close()
	wsURL := "ws" + strings.TrimPrefix(gw.URL, "http") + "/ws"

	cases := []struct {
		name   string
		url    string
		header http.Header
		want   int
	}{
		{"unauthenticated", wsURL, nil, http.StatusUnauthorized},
		{"unauthenticated asserting a user", wsURL + "?user_id=7", nil, http.StatusUnauthorized},
		{"user A asking for user B", wsURL + "?user_id=8", userHeader("7"), http.StatusForbidden},
		{"cross-site origin", wsURL, func() http.Header {
			h := userHeader("7")
			h.Set("Origin", "http://evil.example")
			return h
		}(), http.StatusForbidden},
	}
	for _, c := range cases {
		_, resp, err := websocket.DefaultDialer.Dial(c.url, c.header)
		if err == nil {
			t.Fatalf("%s: connection was accepted", c.name)
		}
		if resp == nil || resp.StatusCode != c.want {
			got := 0
			if resp != nil {
				got = resp.StatusCode
			}
			t.Fatalf("%s: status %d, want %d", c.name, got, c.want)
		}
	}
	if n := atomic.LoadInt32(&dials); n != 0 {
		t.Fatalf("refused handshakes still dialed the ai-service %d times", n)
	}
}

func TestHTTPProxyReplacesClientIdentityHeaders(t *testing.T) {
	var got http.Header
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()
	p, err := NewHTTPProxy(backend.URL, "gateway-secret", nil)
	if err != nil {
		t.Fatal(err)
	}
	gw := httptest.NewServer(asUser(p))
	defer gw.Close()

	req, _ := http.NewRequest(http.MethodGet, gw.URL+"/api/trades/pending?user_id=7", nil)
	req.Header.Set("X-Test-User", "7")
	req.Header.Set(middleware.HeaderUserID, "999")
	req.Header.Set(middleware.HeaderUserClerkID, "user_attacker")
	req.Header.Set(middleware.HeaderInternalToken, "forged")
	req.Header.Set("Authorization", "Bearer secret-token")
	req.Header.Set("Cookie", "orbit_session=abc")
	req.Header.Set("Origin", "http://localhost:8000")
	if _, err := http.DefaultClient.Do(req); err != nil {
		t.Fatal(err)
	}
	if got.Get(middleware.HeaderUserID) != "7" {
		t.Fatalf("X-User-ID = %q, want the verified 7", got.Get(middleware.HeaderUserID))
	}
	if got.Get(middleware.HeaderUserClerkID) != "" || got.Get(middleware.HeaderInternalToken) != "gateway-secret" {
		t.Fatalf("spoofed headers leaked: clerk=%q token=%q", got.Get(middleware.HeaderUserClerkID), got.Get(middleware.HeaderInternalToken))
	}
	if got.Get("Authorization") != "" || got.Get("Cookie") != "" || got.Get("Origin") != "" {
		t.Fatal("browser credentials were forwarded to the ai-service")
	}

	// A public request carries no identity at all, whatever the client sends.
	req2, _ := http.NewRequest(http.MethodGet, gw.URL+"/api/market/quote", nil)
	req2.Header.Set(middleware.HeaderUserID, "1")
	if _, err := http.DefaultClient.Do(req2); err != nil {
		t.Fatal(err)
	}
	if got.Get(middleware.HeaderUserID) != "" {
		t.Fatal("anonymous request reached the ai-service with a user id")
	}
}

func TestSameOriginOrAllowed(t *testing.T) {
	check := SameOriginOrAllowed([]string{"https://app.example.com"})
	mk := func(host, origin string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "http://"+host+"/ws", nil)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		return r
	}
	if !check(mk("localhost:8000", "http://localhost:8000")) || !check(mk("localhost:8000", "")) ||
		!check(mk("localhost:8000", "https://app.example.com")) || check(mk("localhost:8000", "http://evil.example")) {
		t.Fatal("origin policy mismatch")
	}
}
