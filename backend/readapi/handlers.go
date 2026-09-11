package readapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/mochatrade/backend/middleware"
)

// PriceSource supplies live prices keyed by symbol (the Valkey market cache).
type PriceSource interface {
	MarketPrices(ctx context.Context, symbols []string) (map[string]float64, error)
}

// Handlers serves the Go-native read endpoints. Store nil means no PostgreSQL
// (local SQLite mode) and Prices nil means no Valkey: the affected endpoints
// then always use Fallback (the ai-service proxy).
type Handlers struct {
	Store    Store
	Prices   PriceSource
	Fallback http.Handler
	Now      func() time.Time
	Timeout  time.Duration
}

// SourceHeader tells which layer produced a response (for ops and tests).
const SourceHeader = "X-Orbit-Source"

var errIncompleteLive = errors.New("no fresh price for a held symbol")

func (h *Handlers) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}

func (h *Handlers) ctx(r *http.Request) (context.Context, context.CancelFunc) {
	t := h.Timeout
	if t <= 0 {
		t = 8 * time.Second
	}
	return context.WithTimeout(r.Context(), t)
}

func (h *Handlers) fallback(w http.ResponseWriter, r *http.Request, why error) {
	if why != nil && !errors.Is(why, errIncompleteLive) {
		log.Printf("[readapi] %s served by ai-service: %v", r.URL.Path, why)
	}
	w.Header().Set(SourceHeader, "ai-service")
	h.Fallback.ServeHTTP(w, r)
}

func writeJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set(SourceHeader, "gateway")
	_ = json.NewEncoder(w).Encode(body)
}

func userID(r *http.Request) (int64, bool) {
	id, ok := middleware.IdentityFrom(r.Context())
	if !ok || id.UserID <= 0 {
		return 0, false
	}
	return id.UserID, true
}

// livePositions loads open positions priced from the live cache. It refuses
// (errIncompleteLive) when any held symbol has no fresh price, because the
// ai-service can fetch a quote the gateway cannot.
func (h *Handlers) livePositions(ctx context.Context, uid int64, now time.Time) ([]map[string]any, error) {
	rows, err := h.Store.OpenPositions(ctx, uid)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var symbols []string
	for _, p := range rows {
		k := SymbolKey(getOr(p, "asset", "BTC-USD"))
		if !seen[k] {
			seen[k] = true
			symbols = append(symbols, k)
		}
	}
	prices, err := h.Prices.MarketPrices(ctx, symbols)
	if err != nil {
		return nil, err
	}
	for _, s := range symbols {
		if prices[s] <= 0 {
			return nil, errIncompleteLive
		}
	}
	return BuildOpenPositions(uid, rows, prices, now), nil
}

// DashboardSummary serves GET /api/dashboard/summary (and its aliases).
func (h *Handlers) DashboardSummary(w http.ResponseWriter, r *http.Request) {
	uid, ok := userID(r)
	if !ok || h.Store == nil || h.Prices == nil {
		h.fallback(w, r, nil)
		return
	}
	ctx, cancel := h.ctx(r)
	defer cancel()
	now := h.now()
	cash, found, err := h.Store.UserBalance(ctx, uid)
	if err != nil || !found {
		h.fallback(w, r, err)
		return
	}
	positions, err := h.livePositions(ctx, uid, now)
	if err != nil {
		h.fallback(w, r, err)
		return
	}
	stats, err := h.Store.ClosedStats(ctx, uid)
	if err != nil {
		h.fallback(w, r, err)
		return
	}
	writeJSON(w, DashboardResponse(BuildDashboardSummary(cash, stats, positions, now), now))
}

// OpenTrades serves GET /api/trades/open and /api/positions.
func (h *Handlers) OpenTrades(w http.ResponseWriter, r *http.Request) {
	uid, ok := userID(r)
	if !ok || h.Store == nil || h.Prices == nil {
		h.fallback(w, r, nil)
		return
	}
	ctx, cancel := h.ctx(r)
	defer cancel()
	now := h.now()
	positions, err := h.livePositions(ctx, uid, now)
	if err != nil {
		h.fallback(w, r, err)
		return
	}
	writeJSON(w, OpenTradesResponse(positions, now))
}

// TradesHistory serves GET /api/trades/history.
func (h *Handlers) TradesHistory(w http.ResponseWriter, r *http.Request) {
	uid, ok := userID(r)
	if !ok || h.Store == nil {
		h.fallback(w, r, nil)
		return
	}
	q := r.URL.Query()
	f := HistoryFilter{
		Symbol: q.Get("symbol"), Market: q.Get("market"), Side: q.Get("side"),
		Outcome: q.Get("outcome"), Source: q.Get("source"),
	}
	var invalid []map[string]any
	f.Limit = queryInt(q.Get("limit"), q.Has("limit"), 20, "limit", &invalid)
	f.Offset = queryInt(q.Get("offset"), q.Has("offset"), 0, "offset", &invalid)
	if q.Has("bot_session_id") {
		v := queryInt(q.Get("bot_session_id"), true, 0, "bot_session_id", &invalid)
		b := int64(v)
		f.BotSessionID = &b
	}
	if len(invalid) > 0 {
		writeValidationError(w, invalid)
		return
	}
	// Postgres rejects negative LIMIT/OFFSET; keep pages bounded.
	if f.Limit < 0 {
		f.Limit = 0
	}
	if f.Limit > 500 {
		f.Limit = 500
	}
	if f.Offset < 0 {
		f.Offset = 0
	}
	ctx, cancel := h.ctx(r)
	defer cancel()
	rows, total, err := h.Store.ClosedHistory(ctx, uid, f)
	if err != nil {
		h.fallback(w, r, err)
		return
	}
	writeJSON(w, HistoryResponse(rows, total, f.Limit, f.Offset))
}

// BotConfig serves GET /api/bot-config.
func (h *Handlers) BotConfig(w http.ResponseWriter, r *http.Request) {
	uid, ok := userID(r)
	if !ok || h.Store == nil {
		h.fallback(w, r, nil)
		return
	}
	ctx, cancel := h.ctx(r)
	defer cancel()
	if _, found, err := h.Store.UserBalance(ctx, uid); err != nil || !found {
		h.fallback(w, r, err)
		return
	}
	cfg, err := h.Store.BotConfig(ctx, uid)
	if err != nil || cfg == nil {
		h.fallback(w, r, err)
		return
	}
	live, err := h.Store.HasLiveBotSession(ctx, uid)
	if err != nil {
		h.fallback(w, r, err)
		return
	}
	writeJSON(w, BotConfigResponse(cfg, live))
}

// queryInt parses an optional integer query parameter the way FastAPI does,
// collecting a 422 detail entry when it is not an integer.
func queryInt(raw string, present bool, def int, name string, invalid *[]map[string]any) int {
	if !present {
		return def
	}
	v, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		*invalid = append(*invalid, map[string]any{
			"type":  "int_parsing",
			"loc":   []string{"query", name},
			"msg":   "Input should be a valid integer, unable to parse string as an integer",
			"input": raw,
		})
		return def
	}
	return v
}

func writeValidationError(w http.ResponseWriter, detail []map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set(SourceHeader, "gateway")
	w.WriteHeader(http.StatusUnprocessableEntity)
	_ = json.NewEncoder(w).Encode(map[string]any{"detail": detail})
}
