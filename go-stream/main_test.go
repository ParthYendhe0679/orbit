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

func TestPublishHandler_ValidJSON(t *testing.T) {
	hub := newHub()
	handler := publishHandler(hub)

	payload := []byte(`{"type":"tick","candle":{"close":65000.5,"time":1710000000}}`)
	req := httptest.NewRequest(http.MethodPost, "/publish", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if status := rr.Code; status != http.StatusNoContent {
		t.Fatalf("publishHandler with valid JSON returned wrong status code: got %v want %v", status, http.StatusNoContent)
	}

	// Verify the hub received the message on its broadcast channel
	select {
	case msg := <-hub.broadcast:
		if !bytes.Equal(msg, payload) {
			t.Errorf("broadcasted message mismatch: got %s want %s", string(msg), string(payload))
		}
	default:
		t.Errorf("expected message in hub broadcast channel, but channel was empty")
	}
}

func TestPublishHandler_InvalidJSON(t *testing.T) {
	hub := newHub()
	handler := publishHandler(hub)

	invalidPayload := []byte(`{"type":"tick", invalid json`)
	req := httptest.NewRequest(http.MethodPost, "/publish", bytes.NewReader(invalidPayload))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if status := rr.Code; status != http.StatusBadRequest {
		t.Fatalf("publishHandler with invalid JSON returned wrong status code: got %v want %v", status, http.StatusBadRequest)
	}
}

func TestPublishHandler_MethodNotAllowed(t *testing.T) {
	hub := newHub()
	handler := publishHandler(hub)

	req := httptest.NewRequest(http.MethodGet, "/publish", nil)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if status := rr.Code; status != http.StatusMethodNotAllowed {
		t.Fatalf("publishHandler with GET method returned wrong status code: got %v want %v", status, http.StatusMethodNotAllowed)
	}
}
