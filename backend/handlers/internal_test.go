package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mochatrade/backend/proxy"
)

func TestInternalAuthorized(t *testing.T) {
	cases := []struct {
		name   string
		token  string
		header string
		origin string
		remote string
		want   bool
	}{
		{"token matches", "s3cret", "s3cret", "", "10.0.0.5:4000", true},
		{"token mismatch", "s3cret", "wrong", "", "127.0.0.1:4000", false},
		{"token missing", "s3cret", "", "", "127.0.0.1:4000", false},
		{"no token, loopback", "", "", "", "127.0.0.1:4000", true},
		{"no token, remote", "", "", "", "172.17.0.1:4000", false},
		{"browser origin refused", "s3cret", "s3cret", "http://evil.example", "10.0.0.5:4000", false},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodPost, "/internal/events/publish", nil)
		r.RemoteAddr = c.remote
		if c.header != "" {
			r.Header.Set("X-Orbit-Internal-Token", c.header)
		}
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		if got := InternalAuthorized(r, c.token); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestPublishUserEventHandler(t *testing.T) {
	hub := proxy.NewUserHub()
	h := PublishUserEventHandler(hub, "tok")

	post := func(body, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/internal/events/publish", strings.NewReader(body))
		r.RemoteAddr = "10.1.1.1:1234"
		if token != "" {
			r.Header.Set("X-Orbit-Internal-Token", token)
		}
		w := httptest.NewRecorder()
		h(w, r)
		return w
	}

	if w := post(`{"user_id":"5","message":{"type":"bot_event"}}`, ""); w.Code != http.StatusForbidden {
		t.Fatalf("missing token: got %d", w.Code)
	}
	if w := post(`{"user_id":"","message":{}}`, "tok"); w.Code != http.StatusBadRequest {
		t.Fatalf("empty user: got %d", w.Code)
	}
	if w := post(`not json`, "tok"); w.Code != http.StatusBadRequest {
		t.Fatalf("bad json: got %d", w.Code)
	}
	w := post(`{"user_id":"5","message":{"type":"bot_event"}}`, "tok")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"delivered":0`) {
		t.Fatalf("valid publish: %d %s", w.Code, w.Body.String())
	}
}
