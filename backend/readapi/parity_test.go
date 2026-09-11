package readapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/mochatrade/backend/database"
	"github.com/mochatrade/backend/middleware"
)

// golden is testdata/python_golden.json, captured from the Python ai-service
// on PostgreSQL by tests/generate_readapi_golden.py.
type golden struct {
	IDs struct {
		Alice, Bob, Carol, Session int64
	} `json:"ids"`
	Prices          map[string]float64 `json:"prices"`
	BotLiveStatuses []string           `json:"bot_live_statuses"`
	Rows            struct {
		AliceBalance       float64 `json:"alice_balance"`
		AliceOpenPositions []Row   `json:"alice_open_positions"`
		AliceClosedStats   struct {
			RealizedPnL float64 `json:"realized_pnl"`
			ClosedCount int64   `json:"closed_count"`
			Winning     int64   `json:"winning"`
		} `json:"alice_closed_stats"`
		AliceBotConfig Row `json:"alice_bot_config"`
	} `json:"rows"`
	Responses struct {
		DashboardSummary      map[string]any            `json:"dashboard_summary"`
		TradesOpen            map[string]any            `json:"trades_open"`
		TradesHistory         map[string]map[string]any `json:"trades_history"`
		BotConfigAlice        map[string]any            `json:"bot_config_alice"`
		BotConfigCarolDefault map[string]any            `json:"bot_config_carol_default"`
		DashboardSummaryBob   map[string]any            `json:"dashboard_summary_bob"`
	} `json:"responses"`
}

func loadGolden(t *testing.T) *golden {
	t.Helper()
	raw, err := os.ReadFile("testdata/python_golden.json")
	if err != nil {
		t.Fatalf("golden missing (run tests/generate_readapi_golden.py): %v", err)
	}
	var g golden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return &g
}

var volatile = map[string]bool{"timestamp": true, "updated_at": true, "duration": true}

func normalize(v any, drop map[string]bool) any {
	switch t := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, val := range t {
			if !drop[k] {
				out[k] = normalize(val, drop)
			}
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i := range t {
			out[i] = normalize(t[i], drop)
		}
		return out
	}
	return v
}

// jsonOf round-trips through JSON so both sides compare as plain JSON values.
func jsonOf(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func diff(path string, got, want any) []string {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return []string{fmt.Sprintf("%s: got %T, want object", path, got)}
		}
		var out []string
		keys := map[string]bool{}
		for k := range w {
			keys[k] = true
		}
		for k := range g {
			keys[k] = true
		}
		sorted := make([]string, 0, len(keys))
		for k := range keys {
			sorted = append(sorted, k)
		}
		sort.Strings(sorted)
		for _, k := range sorted {
			gv, gok := g[k]
			wv, wok := w[k]
			switch {
			case !gok:
				out = append(out, fmt.Sprintf("%s.%s: missing (python has %v)", path, k, wv))
			case !wok:
				out = append(out, fmt.Sprintf("%s.%s: extra key (go has %v)", path, k, gv))
			default:
				out = append(out, diff(path+"."+k, gv, wv)...)
			}
		}
		return out
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return []string{fmt.Sprintf("%s: got %v, want %v", path, got, want)}
		}
		var out []string
		for i := range w {
			out = append(out, diff(fmt.Sprintf("%s[%d]", path, i), g[i], w[i])...)
		}
		return out
	case float64:
		g, ok := got.(float64)
		if !ok || math.Abs(g-w) > 1e-9*math.Max(1, math.Abs(w)) {
			return []string{fmt.Sprintf("%s: got %v (%T), want %v", path, got, got, w)}
		}
		return nil
	default:
		if !reflect.DeepEqual(got, want) {
			return []string{fmt.Sprintf("%s: got %v (%T), want %v (%T)", path, got, got, want, want)}
		}
		return nil
	}
}

func assertParity(t *testing.T, name string, got, want any, extraDrop ...string) {
	t.Helper()
	drop := map[string]bool{}
	for k := range volatile {
		drop[k] = true
	}
	for _, k := range extraDrop {
		drop[k] = true
	}
	d := diff(name, normalize(jsonOf(t, got), drop), normalize(jsonOf(t, want), drop))
	if len(d) > 0 {
		t.Errorf("%s differs from the Python contract:\n  %s", name, strings.Join(d, "\n  "))
	}
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type fakeStore struct {
	balance    float64
	found      bool
	open       []Row
	stats      ClosedStats
	history    []Row
	total      int64
	cfg        Row
	live       bool
	err        error
	lastFilter HistoryFilter
}

func (f *fakeStore) UserBalance(context.Context, int64) (float64, bool, error) {
	return f.balance, f.found, f.err
}
func (f *fakeStore) OpenPositions(context.Context, int64) ([]Row, error) { return f.open, f.err }
func (f *fakeStore) ClosedStats(context.Context, int64) (ClosedStats, error) {
	return f.stats, f.err
}
func (f *fakeStore) ClosedHistory(_ context.Context, _ int64, hf HistoryFilter) ([]Row, int64, error) {
	f.lastFilter = hf
	return f.history, f.total, f.err
}
func (f *fakeStore) BotConfig(context.Context, int64) (Row, error)        { return f.cfg, f.err }
func (f *fakeStore) HasLiveBotSession(context.Context, int64) (bool, error) { return f.live, f.err }

type fixedPrices map[string]float64

func (p fixedPrices) MarketPrices(_ context.Context, symbols []string) (map[string]float64, error) {
	out := map[string]float64{}
	for _, s := range symbols {
		if v, ok := p[s]; ok {
			out[s] = v
		}
	}
	return out, nil
}

var fallbackHit = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Test-Fallback", "1")
	w.WriteHeader(http.StatusTeapot)
})

func call(t *testing.T, h http.HandlerFunc, uid int64, target string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, target, nil)
	if uid > 0 {
		r = r.WithContext(middleware.WithIdentity(r.Context(), &middleware.Identity{UserID: uid}))
	}
	w := httptest.NewRecorder()
	h(w, r)
	var body map[string]any
	if w.Header().Get("X-Test-Fallback") == "" {
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: invalid JSON %q", target, w.Body.String())
		}
	}
	return w, body
}

func historyTarget(q string) string {
	if q == "" {
		return "/api/trades/history"
	}
	return "/api/trades/history?" + strings.ReplaceAll(q, " ", "%20")
}

// ---------------------------------------------------------------------------
// Unit parity: Go assembly of the same rows == Python responses
// ---------------------------------------------------------------------------

func TestBotLiveStatusesMatchPython(t *testing.T) {
	g := loadGolden(t)
	if !reflect.DeepEqual(g.BotLiveStatuses, BotLiveStatuses) {
		t.Fatalf("BotLiveStatuses = %v, python = %v", BotLiveStatuses, g.BotLiveStatuses)
	}
}

func TestDashboardAndOpenTradesMatchPython(t *testing.T) {
	g := loadGolden(t)
	st := &fakeStore{
		balance: g.Rows.AliceBalance, found: true, open: g.Rows.AliceOpenPositions,
		stats: ClosedStats{g.Rows.AliceClosedStats.RealizedPnL, g.Rows.AliceClosedStats.ClosedCount, g.Rows.AliceClosedStats.Winning},
	}
	h := &Handlers{Store: st, Prices: fixedPrices(g.Prices), Fallback: fallbackHit}

	w, body := call(t, h.DashboardSummary, g.IDs.Alice, "/api/dashboard/summary")
	if w.Header().Get(SourceHeader) != "gateway" {
		t.Fatalf("dashboard was not served by the gateway: %d", w.Code)
	}
	assertParity(t, "dashboard_summary", body, g.Responses.DashboardSummary)

	_, body = call(t, h.OpenTrades, g.IDs.Alice, "/api/trades/open")
	assertParity(t, "trades_open", body, g.Responses.TradesOpen)
}

func TestHistoryEnvelopeMatchesPython(t *testing.T) {
	g := loadGolden(t)
	for q, want := range g.Responses.TradesHistory {
		var rows []Row
		for _, tr := range want["trades"].([]any) {
			r := Row{}
			for k, v := range tr.(map[string]any) {
				if k != "symbol" {
					r[k] = v
				}
			}
			rows = append(rows, r)
		}
		st := &fakeStore{history: rows, total: int64(want["total"].(float64))}
		h := &Handlers{Store: st, Fallback: fallbackHit}
		_, body := call(t, h.TradesHistory, g.IDs.Alice, historyTarget(q))
		assertParity(t, "trades_history["+q+"]", body, want)
	}
}

func TestBotConfigMatchesPython(t *testing.T) {
	g := loadGolden(t)
	st := &fakeStore{found: true, cfg: g.Rows.AliceBotConfig, live: true}
	h := &Handlers{Store: st, Fallback: fallbackHit}
	_, body := call(t, h.BotConfig, g.IDs.Alice, "/api/bot-config")
	assertParity(t, "bot_config_alice", body, g.Responses.BotConfigAlice)
}

func TestHistoryQueryParsing(t *testing.T) {
	st := &fakeStore{}
	h := &Handlers{Store: st, Fallback: fallbackHit}
	w, _ := call(t, h.TradesHistory, 9, "/api/trades/history?limit=abc")
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("non-integer limit: %d", w.Code)
	}
	call(t, h.TradesHistory, 9, "/api/trades/history?limit=100000&offset=-4&source=Bot&bot_session_id=12")
	f := st.lastFilter
	if f.Limit != 500 || f.Offset != 0 || f.Source != "Bot" || f.BotSessionID == nil || *f.BotSessionID != 12 {
		t.Fatalf("filter = %+v", f)
	}
}

func TestLiveReadsDeferToPythonWhenNotAuthoritative(t *testing.T) {
	g := loadGolden(t)
	base := func() *fakeStore {
		return &fakeStore{balance: 1, found: true, open: g.Rows.AliceOpenPositions}
	}
	cases := map[string]*Handlers{
		"no database":               {Store: nil, Prices: fixedPrices(g.Prices), Fallback: fallbackHit},
		"no price cache":            {Store: base(), Prices: nil, Fallback: fallbackHit},
		"a held symbol has no tick": {Store: base(), Prices: fixedPrices{"BTC-USD": 1}, Fallback: fallbackHit},
		"database error":            {Store: &fakeStore{err: errors.New("boom"), found: true}, Prices: fixedPrices(g.Prices), Fallback: fallbackHit},
		"unknown account":           {Store: &fakeStore{found: false}, Prices: fixedPrices(g.Prices), Fallback: fallbackHit},
	}
	for name, h := range cases {
		for _, ep := range []http.HandlerFunc{h.DashboardSummary, h.OpenTrades} {
			w, _ := call(t, ep, g.IDs.Alice, "/api/trades/open")
			if name == "unknown account" && w.Header().Get("X-Test-Fallback") == "" {
				// OpenTrades does not look the balance up; only the dashboard defers here.
				continue
			}
			if w.Header().Get("X-Test-Fallback") != "1" || w.Header().Get(SourceHeader) != "ai-service" {
				t.Errorf("%s: served by the gateway instead of the ai-service", name)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Integration parity: Go SQL on PostgreSQL == Python on PostgreSQL
// ---------------------------------------------------------------------------

// TestIntegrationParityOnPostgres runs against the database seeded by
// tests/generate_readapi_golden.py (set ORBIT_TEST_DATABASE_URL to it).
func TestIntegrationParityOnPostgres(t *testing.T) {
	url := os.Getenv("ORBIT_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("ORBIT_TEST_DATABASE_URL not set")
	}
	g := loadGolden(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := database.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	h := &Handlers{Store: PGStore{Pool: pool}, Prices: fixedPrices(g.Prices), Fallback: fallbackHit}

	check := func(name string, ep http.HandlerFunc, uid int64, target string, want map[string]any, drop ...string) {
		w, body := call(t, ep, uid, target)
		if w.Header().Get(SourceHeader) != "gateway" {
			t.Fatalf("%s: not served by the gateway (%d)", name, w.Code)
		}
		assertParity(t, name, body, want, drop...)
	}
	check("dashboard_summary", h.DashboardSummary, g.IDs.Alice, "/api/dashboard/summary", g.Responses.DashboardSummary)
	check("dashboard_summary_bob", h.DashboardSummary, g.IDs.Bob, "/api/dashboard/summary", g.Responses.DashboardSummaryBob)
	check("trades_open", h.OpenTrades, g.IDs.Alice, "/api/trades/open", g.Responses.TradesOpen)
	for q, want := range g.Responses.TradesHistory {
		check("trades_history["+q+"]", h.TradesHistory, g.IDs.Alice, historyTarget(q), want)
	}
	check("bot_config_alice", h.BotConfig, g.IDs.Alice, "/api/bot-config", g.Responses.BotConfigAlice)

	// The default-config insert path: remove carol's row, let Go recreate it.
	if _, err := pool.Exec(ctx, `DELETE FROM bot_config WHERE user_id = $1`, g.IDs.Carol); err != nil {
		t.Fatal(err)
	}
	check("bot_config_carol_default", h.BotConfig, g.IDs.Carol, "/api/bot-config", g.Responses.BotConfigCarolDefault, "id")
}
