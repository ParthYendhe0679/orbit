package readapi

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// The functions in this file are line-by-line ports of the ai-service's
// response builders (services/position_service.py, main.py). Field names,
// defaults, Python truthiness ("x or default") and rounding are kept exactly,
// and parity is checked against responses captured from the Python service
// (testdata/python_golden.json).

// PyISO formats like Python's datetime.now().isoformat().
func PyISO(t time.Time) string {
	return t.Format("2006-01-02T15:04:05.000000")
}

// round is Python's round(x, n): the correctly rounded decimal of the exact
// binary value (strconv rounds the same way), not math.Round(x*10^n)/10^n.
func round(x float64, n int) float64 {
	f, err := strconv.ParseFloat(strconv.FormatFloat(x, 'f', n, 64), 64)
	if err != nil {
		return x
	}
	return f
}

func toFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case int64:
		return float64(t), true
	case int32:
		return float64(t), true
	case int:
		return float64(t), true
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		return f, err == nil
	}
	return 0, false
}

// floatOf is float(v) with a default for None/absent.
func floatOf(v any, def float64) float64 {
	if f, ok := toFloat(v); ok {
		return f
	}
	return def
}

// orFloat is Python's `float(v or def)`: None, 0 and "" fall back to def.
func orFloat(v any, def float64) float64 {
	if f, ok := toFloat(v); ok && f != 0 {
		return f
	}
	return def
}

// orValue is Python's `v or def` for a generic value.
func orValue(v any, def any) any {
	switch t := v.(type) {
	case nil:
		return def
	case string:
		if t == "" {
			return def
		}
	case bool:
		if !t {
			return def
		}
	default:
		if f, ok := toFloat(v); ok && f == 0 {
			return def
		}
	}
	return v
}

// getOr is dict.get(key, def): the stored value (even None) when the key exists.
func getOr(r Row, key string, def any) any {
	if v, ok := r[key]; ok {
		return v
	}
	return def
}

func pyStr(v any) string {
	switch t := v.(type) {
	case nil:
		return "None"
	case string:
		return t
	default:
		return fmt.Sprint(t)
	}
}

// durationSince mirrors the duration string in get_live_open_positions.
func durationSince(opened any, now time.Time) string {
	s, ok := opened.(string)
	if !ok || s == "" {
		return ""
	}
	var t time.Time
	var err error
	for _, layout := range []string{"2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02"} {
		if t, err = time.ParseInLocation(layout, s, time.Local); err == nil {
			break
		}
	}
	if err != nil {
		// Python: an unparsable or timezone-aware stamp leaves "".
		return ""
	}
	secs := int64(now.Sub(t).Seconds())
	switch {
	case secs < 60:
		return fmt.Sprintf("%ds", secs)
	case secs < 3600:
		return fmt.Sprintf("%dm", secs/60)
	case secs < 86400:
		return fmt.Sprintf("%dh %dm", secs/3600, (secs%3600)/60)
	default:
		return fmt.Sprintf("%dd %dh", secs/86400, (secs%86400)/3600)
	}
}

// SymbolKey is how a position's asset is looked up in the live price cache.
func SymbolKey(asset any) string {
	s, _ := asset.(string)
	if s == "" {
		s = "BTC-USD"
	}
	return strings.ToUpper(strings.TrimSpace(s))
}

// BuildOpenPositions ports PositionService.get_live_open_positions.
// prices holds the live price per SymbolKey; a symbol missing from it keeps
// the stored current_price and is_live=false, as in Python.
func BuildOpenPositions(userID int64, rows []Row, prices map[string]float64, now time.Time) []map[string]any {
	out := make([]map[string]any, 0, len(rows))
	nowISO := PyISO(now)
	for _, p := range rows {
		sym := getOr(p, "asset", "BTC-USD")
		currentPrice := floatOf(getOr(p, "current_price", 0.0), 0)
		isLive := false
		if live, ok := prices[SymbolKey(sym)]; ok && live > 0 {
			currentPrice = live
			isLive = true
		}
		entryPrice := floatOf(getOr(p, "entry_price", 0.0), 0)
		remQty := floatOf(p["quantity"], 0)
		if v, ok := p["remaining_quantity"]; ok && v != nil {
			remQty = floatOf(v, 0)
		}
		origQty := floatOf(p["quantity"], 0)
		if v, ok := p["original_quantity"]; ok && v != nil {
			origQty = floatOf(v, 0)
		}
		leverage := orFloat(p["leverage"], 1.0)
		tradeType := strings.ToLower(pyStr(getOr(p, "type", "buy")))

		var unrealized float64
		if tradeType == "buy" {
			unrealized = (currentPrice - entryPrice) * remQty * leverage
		} else {
			unrealized = (entryPrice - currentPrice) * remQty * leverage
		}
		marginUsed := orFloat(p["margin_used"], (remQty*entryPrice)/leverage)
		positionSize := remQty * currentPrice * leverage
		pct := 0.0
		if marginUsed > 0 {
			pct = unrealized / marginUsed * 100.0
		}
		openedAt := getOr(p, "timestamp", "")
		typ := getOr(p, "type", "BUY")

		out = append(out, map[string]any{
			"id":                     p["id"],
			"trade_id":               p["id"],
			"user_id":                userID,
			"symbol":                 sym,
			"asset":                  sym,
			"market":                 getOr(p, "market", marketDefault(sym)),
			"type":                   typ,
			"side":                   typ,
			"status":                 getOr(p, "status", "active"),
			"entry_price":            round(entryPrice, 4),
			"current_price":          round(currentPrice, 4),
			"quantity":               remQty,
			"original_quantity":      origQty,
			"remaining_quantity":     remQty,
			"leverage":               leverage,
			"position_size":          round(positionSize, 2),
			"margin_used":            round(marginUsed, 2),
			"unrealized_pnl":         round(unrealized, 2),
			"unrealized_pnl_pct":     round(pct, 2),
			"unrealized_pnl_percent": round(pct, 2),
			"realized_pnl":           round(orFloat(p["realized_pnl"], 0.0), 2),
			"sl":                     orFloat(p["sl"], 0.0),
			"target":                 orFloat(p["target"], 0.0),
			"opened_at":              openedAt,
			"updated_at":             nowISO,
			"duration":               durationSince(openedAt, now),
			"is_live":                isLive,
			"source":                 orValue(p["source"], "manual"),
			"bot_session_id":         p["bot_session_id"],
		})
	}
	return out
}

func marketDefault(sym any) string {
	if s, _ := sym.(string); strings.Contains(s, "-") {
		return "Crypto"
	}
	return "Stock"
}

// BuildDashboardSummary ports PositionService.get_account_and_dashboard_summary.
func BuildDashboardSummary(cash float64, stats ClosedStats, positions []map[string]any, now time.Time) map[string]any {
	var margin, unrealized float64
	for _, p := range positions {
		margin += floatOf(p["margin_used"], 0)
		unrealized += floatOf(p["unrealized_pnl"], 0)
	}
	equity := cash + margin + unrealized

	var winRate any
	winRateStr := "—"
	winning, losing := int64(0), int64(0)
	if stats.ClosedCount > 0 {
		winning = stats.Winning
		losing = stats.ClosedCount - winning
		wr := float64(winning) / float64(stats.ClosedCount) * 100.0
		winRate = round(wr, 2)
		winRateStr = fmt.Sprintf("%.1f%%", wr)
	}
	active := len(positions)
	ts := PyISO(now)
	return map[string]any{
		"account": map[string]any{
			"total_capital":     round(equity, 2),
			"available_balance": round(cash, 2),
			"used_margin":       round(margin, 2),
			"equity":            round(equity, 2),
		},
		"trading": map[string]any{
			"active_trades":        active,
			"unrealized_pnl":       round(unrealized, 2),
			"realized_pnl":         round(stats.RealizedPnL, 2),
			"win_rate":             winRate,
			"win_rate_str":         winRateStr,
			"closed_trades_count":  stats.ClosedCount,
			"total_closed_trades":  stats.ClosedCount,
			"winning_trades_count": winning,
			"winning_trades":       winning,
			"losing_trades_count":  losing,
		},
		"open_positions":    positions,
		"timestamp":         ts,
		"total_capital":     round(equity, 2),
		"available_balance": round(cash, 2),
		"used_margin":       round(margin, 2),
		"equity":            round(equity, 2),
		"active_trades":     active,
		"unrealized_pnl":    round(unrealized, 2),
		"realized_pnl":      round(stats.RealizedPnL, 2),
		"win_rate":          winRate,
		"win_rate_str":      winRateStr,
	}
}

// DashboardResponse is main.api_dashboard_summary's envelope:
// {"ok", "data", **summary, "timestamp", "source"}.
func DashboardResponse(summary map[string]any, now time.Time) map[string]any {
	out := map[string]any{"ok": true, "data": summary}
	for k, v := range summary {
		out[k] = v
	}
	out["timestamp"] = PyISO(now)
	out["source"] = "database"
	return out
}

// OpenTradesResponse is main.api_get_open_trades's envelope.
func OpenTradesResponse(positions []map[string]any, now time.Time) map[string]any {
	return map[string]any{
		"ok":        true,
		"trades":    positions,
		"positions": positions,
		"count":     len(positions),
		"timestamp": PyISO(now),
		"source":    "database",
	}
}

// HistoryResponse ports get_closed_trade_history_paginated plus the
// api_get_trades_history envelope.
func HistoryResponse(rows []Row, total int64, limit, offset int) map[string]any {
	trades := make([]Row, 0, len(rows))
	for _, r := range rows {
		d := make(Row, len(r)+1)
		for k, v := range r {
			d[k] = v
		}
		d["symbol"] = orValue(d["asset"], getOr(d, "symbol", ""))
		trades = append(trades, d)
	}
	data := map[string]any{
		"trades":      trades,
		"total":       total,
		"total_count": total,
		"limit":       limit,
		"offset":      offset,
	}
	return map[string]any{
		"ok":          true,
		"data":        data,
		"trades":      trades,
		"total":       total,
		"total_count": total,
		"limit":       limit,
		"offset":      offset,
	}
}

// BotConfigResponse ports main._format_bot_config and api_get_bot_config.
func BotConfigResponse(cfg Row, live bool) map[string]any {
	c := make(Row, len(cfg)+4)
	for k, v := range cfg {
		c[k] = v
	}
	c["is_active"] = live
	assets := []string{}
	raw := ""
	if v := orValue(c["assets"], ""); v != nil {
		raw = pyStr(v)
	}
	for _, a := range strings.Split(raw, ",") {
		if t := strings.TrimSpace(a); t != "" {
			assets = append(assets, strings.ToUpper(t))
		}
	}
	c["assets_list"] = assets
	c["allocated_capital"] = c["total_capital"]
	c["target_profit"] = c["min_profit_target"]
	c["max_loss"] = c["max_profit_target"]
	return map[string]any{"ok": true, "config": c}
}
