package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
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

// End to end: backend frames and hub events both reach the browser through the
// proxy's single writer, and only the matching user_id receives hub events.
func TestWebSocketProxyInterleavesBackendFramesAndUserEvents(t *testing.T) {
	up := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	gw := httptest.NewServer(NewWebSocketProxy(backend.URL, hub))
	defer gw.Close()
	wsURL := "ws" + strings.TrimPrefix(gw.URL, "http")

	alice, _, err := websocket.DefaultDialer.Dial(wsURL+"/ws?user_id=42", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer alice.Close()
	bob, _, err := websocket.DefaultDialer.Dial(wsURL+"/ws?user_id=43", nil)
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
}
