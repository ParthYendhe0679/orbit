package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthHandler(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rr := httptest.NewRecorder()

	healthHandler(rr, req)

	if status := rr.Code; status != http.StatusOK {
		t.Fatalf("healthHandler returned wrong status code: got %v want %v", status, http.StatusOK)
	}

	expected := `{"ok":true,"service":"orbit-stream"}`
	if strings.TrimSpace(rr.Body.String()) != expected {
		t.Errorf("healthHandler returned unexpected body: got %v want %v", rr.Body.String(), expected)
	}
}

func publish(h http.Handler, method string, body []byte, mutate func(*http.Request)) int {
	req := httptest.NewRequest(method, "/publish", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "127.0.0.1:5000"
	if mutate != nil {
		mutate(req)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr.Code
}

func TestPublishHandler_ValidJSON(t *testing.T) {
	hub := newHub()
	payload := []byte(`{"type":"tick","candle":{"close":65000.5,"time":1710000000}}`)

	if status := publish(publishHandler(hub, "tok"), http.MethodPost, payload, func(r *http.Request) {
		r.Header.Set("X-Orbit-Internal-Token", "tok")
	}); status != http.StatusNoContent {
		t.Fatalf("publishHandler with valid JSON returned wrong status code: got %v want %v", status, http.StatusNoContent)
	}

	select {
	case msg := <-hub.broadcast:
		if !bytes.Equal(msg, payload) {
			t.Errorf("broadcasted message mismatch: got %s want %s", string(msg), string(payload))
		}
	default:
		t.Errorf("expected message in hub broadcast channel, but channel was empty")
	}
}

func TestPublishHandler_RequiresTheSharedToken(t *testing.T) {
	hub := newHub()
	h := publishHandler(hub, "tok")
	payload := []byte(`{"type":"tick"}`)
	cases := map[string]func(*http.Request){
		"missing token": nil,
		"wrong token":   func(r *http.Request) { r.Header.Set("X-Orbit-Internal-Token", "nope") },
		"browser origin": func(r *http.Request) {
			r.Header.Set("X-Orbit-Internal-Token", "tok")
			r.Header.Set("Origin", "http://evil.example")
		},
	}
	for name, mut := range cases {
		if status := publish(h, http.MethodPost, payload, mut); status != http.StatusForbidden {
			t.Errorf("%s: status %d, want 403", name, status)
		}
	}
	if len(hub.broadcast) != 0 {
		t.Fatal("an unauthorized frame was broadcast")
	}

	noToken := publishHandler(hub, "")
	if status := publish(noToken, http.MethodPost, payload, nil); status != http.StatusNoContent {
		t.Fatalf("loopback without token configured: %d", status)
	}
	if status := publish(noToken, http.MethodPost, payload, func(r *http.Request) { r.RemoteAddr = "10.0.0.9:1" }); status != http.StatusForbidden {
		t.Fatalf("remote without token configured: %d", status)
	}
}

func TestPublishHandler_InvalidJSON(t *testing.T) {
	hub := newHub()
	status := publish(publishHandler(hub, ""), http.MethodPost, []byte(`{"type":"tick", invalid json`), nil)
	if status != http.StatusBadRequest {
		t.Fatalf("publishHandler with invalid JSON returned wrong status code: got %v want %v", status, http.StatusBadRequest)
	}
}

func TestPublishHandler_MethodNotAllowed(t *testing.T) {
	hub := newHub()
	if status := publish(publishHandler(hub, ""), http.MethodGet, nil, nil); status != http.StatusMethodNotAllowed {
		t.Fatalf("publishHandler with GET method returned wrong status code: got %v want %v", status, http.StatusMethodNotAllowed)
	}
}
