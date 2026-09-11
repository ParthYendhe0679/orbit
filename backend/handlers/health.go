package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Pinger is anything with a context-aware liveness check (pgxpool.Pool, cache.Valkey).
type Pinger interface {
	Ping(ctx context.Context) error
}

// HealthDeps describes what the gateway health report probes.
type HealthDeps struct {
	AIServiceURL string
	StreamURL    string // orbit-stream base URL; empty to skip
	DB           Pinger // nil when the gateway has no PostgreSQL pool
	DBConfigured bool   // DATABASE_URL points at PostgreSQL
	Valkey       Pinger // nil when the gateway has no Valkey client
	ValkeyURLSet bool
	Clerk        bool // Clerk JWT verification configured
	Ephemeral    bool // session signing key is per-process
	// ProbeTimeout bounds every downstream probe. 5 s by default: Neon and
	// Aiven TLS cold starts and Python startup routinely exceed 2 s, which
	// used to report a false "degraded".
	ProbeTimeout time.Duration
}

// aiReportedFields are passed through from the ai-service's /health JSON when
// present; nothing is invented.
var aiReportedFields = []string{
	"status", "backend", "database", "valkey", "cache_mode", "tls", "valkey_mode", "tls_enabled", "service", "version", "timestamp",
}

type probe struct {
	status  string
	latency float64
	code    int
	body    map[string]any
}

// HealthHandler reports gateway, ai-service, database, Valkey and stream-hub
// health separately, plus an overall status. It always answers 200.
func HealthHandler(d HealthDeps) http.HandlerFunc {
	timeout := d.ProbeTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	client := &http.Client{Timeout: timeout}
	aiBase := strings.TrimRight(d.AIServiceURL, "/")
	streamBase := strings.TrimRight(d.StreamURL, "/")

	httpProbe := func(ctx context.Context, url string) probe {
		start := time.Now()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return probe{status: "unavailable"}
		}
		resp, err := client.Do(req)
		p := probe{latency: float64(time.Since(start).Microseconds()) / 1000.0}
		if err != nil {
			p.status = "unavailable"
			return p
		}
		defer resp.Body.Close()
		p.code = resp.StatusCode
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		_ = json.Unmarshal(raw, &p.body)
		if resp.StatusCode == http.StatusOK {
			p.status = "ok"
		} else {
			p.status = "unavailable"
		}
		return p
	}
	ping := func(ctx context.Context, p Pinger, configured bool) string {
		if !configured {
			return "not_configured"
		}
		if p == nil {
			return "disconnected"
		}
		if err := p.Ping(ctx); err != nil {
			return "disconnected"
		}
		return "connected"
	}

	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()

		var ai, stream probe
		var dbState, vkState string
		var wg sync.WaitGroup
		wg.Add(4)
		go func() { defer wg.Done(); ai = httpProbe(ctx, aiBase+"/health") }()
		go func() {
			defer wg.Done()
			if streamBase == "" {
				stream = probe{status: "not_configured"}
				return
			}
			stream = httpProbe(ctx, streamBase+"/health")
		}()
		go func() { defer wg.Done(); dbState = ping(ctx, d.DB, d.DBConfigured) }()
		go func() { defer wg.Done(); vkState = ping(ctx, d.Valkey, d.ValkeyURLSet) }()
		wg.Wait()

		// The ai-service answers 200 with status "healthy" or "degraded".
		aiStatus := ai.status
		reported := map[string]any{}
		for _, k := range aiReportedFields {
			if v, ok := ai.body[k]; ok {
				reported[k] = v
			}
		}
		if aiStatus == "ok" {
			if s, _ := ai.body["status"].(string); s != "" && s != "healthy" && s != "ok" {
				aiStatus = "degraded"
			}
		}
		aiSection := map[string]any{"status": aiStatus, "latency_ms": ai.latency}
		if ai.code != 0 {
			aiSection["http_status"] = ai.code
		}
		if len(reported) > 0 {
			aiSection["reported"] = reported
		}

		sessions := "persistent"
		if d.Ephemeral {
			sessions = "ephemeral"
		}
		clerk := "not_configured"
		if d.Clerk {
			clerk = "configured"
		}

		healthy := aiStatus == "ok" &&
			dbState != "disconnected" && vkState != "disconnected" &&
			(stream.status == "ok" || stream.status == "not_configured")
		overall := "ok"
		if !healthy {
			overall = "degraded"
		}

		body := map[string]any{
			"status":    overall,
			"service":   "go-backend",
			"timestamp": time.Now().UTC().Format(time.RFC3339),
			"gateway": map[string]any{
				"status": "ok",
				"auth":   map[string]any{"clerk": clerk, "sessions": sessions},
			},
			"ai_service": aiSection,
			"database": map[string]any{
				"gateway":    dbState,
				"ai_service": reported["database"],
			},
			"valkey": map[string]any{
				"gateway":    vkState,
				"ai_service": reported["valkey"],
				"cache_mode": reported["cache_mode"],
				"tls":        reported["tls"],
			},
			"stream_hub": map[string]any{"status": stream.status},
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(body)
	}
}
