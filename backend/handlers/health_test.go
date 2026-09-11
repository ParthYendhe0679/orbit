package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type pinger struct{ err error }

func (p pinger) Ping(context.Context) error { return p.err }

func health(t *testing.T, d HealthDeps) map[string]any {
	t.Helper()
	w := httptest.NewRecorder()
	HealthHandler(d)(w, httptest.NewRequest(http.MethodGet, "/health", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func section(m map[string]any, k string) map[string]any {
	v, _ := m[k].(map[string]any)
	return v
}

func TestHealthReportsEachLayerAndPassesPythonTelemetry(t *testing.T) {
	py := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"healthy","database":"connected","valkey":"connected","cache_mode":"aiven_valkey","tls":true,"version":"1.0.0"}`))
	}))
	defer py.Close()
	stream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer stream.Close()

	out := health(t, HealthDeps{AIServiceURL: py.URL, StreamURL: stream.URL, DB: pinger{}, DBConfigured: true,
		Valkey: pinger{}, ValkeyURLSet: true, Clerk: true})
	if out["status"] != "ok" || out["service"] != "go-backend" {
		t.Fatalf("overall: %v", out)
	}
	ai := section(out, "ai_service")
	rep := section(ai, "reported")
	if ai["status"] != "ok" || rep["database"] != "connected" || rep["cache_mode"] != "aiven_valkey" || rep["tls"] != true {
		t.Fatalf("ai_service section: %v", ai)
	}
	if _, invented := rep["uptime"]; invented {
		t.Fatal("a field the ai-service did not report was added")
	}
	if section(out, "database")["gateway"] != "connected" || section(out, "valkey")["gateway"] != "connected" ||
		section(out, "stream_hub")["status"] != "ok" || section(section(out, "gateway"), "auth")["clerk"] != "configured" {
		t.Fatalf("sections: %v", out)
	}
}

func TestHealthDistinguishesFailures(t *testing.T) {
	degraded := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"degraded","database":"disconnected","valkey":"connected"}`))
	}))
	defer degraded.Close()
	out := health(t, HealthDeps{AIServiceURL: degraded.URL, DB: pinger{errors.New("down")}, DBConfigured: true})
	if out["status"] != "degraded" || section(out, "ai_service")["status"] != "degraded" ||
		section(out, "database")["gateway"] != "disconnected" || section(out, "database")["ai_service"] != "disconnected" ||
		section(out, "valkey")["gateway"] != "not_configured" {
		t.Fatalf("degraded report: %v", out)
	}

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
	}))
	defer slow.Close()
	out = health(t, HealthDeps{AIServiceURL: slow.URL, ProbeTimeout: 50 * time.Millisecond})
	if section(out, "ai_service")["status"] != "unavailable" || out["status"] != "degraded" {
		t.Fatalf("timeout report: %v", out)
	}
}

func TestHealthDefaultProbeTimeoutIsFiveSeconds(t *testing.T) {
	// Neon / Aiven TLS cold starts exceed the old 2 s budget.
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2500 * time.Millisecond)
		_, _ = w.Write([]byte(`{"status":"healthy"}`))
	}))
	defer slow.Close()
	if s := section(health(t, HealthDeps{AIServiceURL: slow.URL}), "ai_service")["status"]; s != "ok" {
		t.Fatalf("a 2.5 s cold start was reported as %v", s)
	}
}
