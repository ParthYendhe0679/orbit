// Package readapi serves the read-heavy portfolio endpoints natively from
// PostgreSQL (and live prices from Valkey), with the same JSON contract as the
// Python ai-service. Whenever the gateway cannot produce an authoritative
// answer (no database, no fresh price for a held symbol, a query error) it
// hands the request to the ai-service instead.
package readapi

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Row is one database row keyed by column name, like the ai-service's
// dict(row) — `SELECT *` rows keep every column, including future ones.
type Row = map[string]any

// ClosedStats aggregates a user's closed trades exactly as
// PositionService.get_account_and_dashboard_summary does.
type ClosedStats struct {
	RealizedPnL float64 // SUM(realized_pnl) over every closed trade
	ClosedCount int64   // closed trades whose outcome is not "cancelled"
	Winning     int64   // of those, realized_pnl (or pnl) > 0
}

// HistoryFilter mirrors the /api/trades/history query parameters.
type HistoryFilter struct {
	Symbol, Market, Side, Outcome, Source string
	BotSessionID                          *int64
	Limit, Offset                         int
}

// Store is the data the read endpoints need.
type Store interface {
	UserBalance(ctx context.Context, userID int64) (balance float64, found bool, err error)
	OpenPositions(ctx context.Context, userID int64) ([]Row, error)
	ClosedStats(ctx context.Context, userID int64) (ClosedStats, error)
	ClosedHistory(ctx context.Context, userID int64, f HistoryFilter) ([]Row, int64, error)
	BotConfig(ctx context.Context, userID int64) (Row, error)
	HasLiveBotSession(ctx context.Context, userID int64) (bool, error)
}

// BotLiveStatuses must equal ai-service database.BOT_LIVE_STATUSES (checked
// by the contract fixture tests on both sides).
var BotLiveStatuses = []string{
	"STARTING", "SCANNING", "ANALYZING", "OPPORTUNITY_FOUND", "TRADE_ACTIVE", "WAITING", "STOPPING",
}

// PGStore implements Store on the ai-service's PostgreSQL schema.
type PGStore struct{ Pool *pgxpool.Pool }

func (s PGStore) UserBalance(ctx context.Context, userID int64) (float64, bool, error) {
	var bal float64
	err := s.Pool.QueryRow(ctx, `SELECT balance FROM "user" WHERE id = $1`, userID).Scan(&bal)
	if err == pgx.ErrNoRows {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return bal, true, nil
}

func (s PGStore) OpenPositions(ctx context.Context, userID int64) ([]Row, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT * FROM trades
		WHERE user_id = $1 AND status = 'active' AND (remaining_quantity IS NULL OR remaining_quantity > 0)
		ORDER BY timestamp DESC`, userID)
	if err != nil {
		return nil, err
	}
	return collectRows(rows)
}

func (s PGStore) ClosedStats(ctx context.Context, userID int64) (ClosedStats, error) {
	var st ClosedStats
	err := s.Pool.QueryRow(ctx, `
		SELECT
			COALESCE(SUM(realized_pnl), 0.0),
			COUNT(*) FILTER (WHERE outcome IS DISTINCT FROM 'cancelled'),
			COUNT(*) FILTER (WHERE outcome IS DISTINCT FROM 'cancelled'
			                   AND COALESCE(NULLIF(realized_pnl, 0), NULLIF(pnl, 0), 0) > 0)
		FROM trades
		WHERE user_id = $1 AND status = 'closed'`, userID).Scan(&st.RealizedPnL, &st.ClosedCount, &st.Winning)
	return st, err
}

func (s PGStore) ClosedHistory(ctx context.Context, userID int64, f HistoryFilter) ([]Row, int64, error) {
	where := []string{"status = 'closed'", "user_id = $1"}
	args := []any{userID}
	add := func(clause string, v any) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(clause, len(args)))
	}
	switch strings.ToLower(strings.TrimSpace(f.Source)) {
	case "bot":
		where = append(where, "source = 'bot'")
	case "manual":
		where = append(where, "(source IS NULL OR source = 'manual')")
	}
	if f.BotSessionID != nil {
		add("bot_session_id = $%d", *f.BotSessionID)
	}
	if f.Symbol != "" {
		add("UPPER(asset) = $%d", strings.ToUpper(strings.TrimSpace(f.Symbol)))
	}
	if f.Market != "" {
		add("UPPER(market) = $%d", strings.ToUpper(strings.TrimSpace(f.Market)))
	}
	if f.Side != "" {
		add("LOWER(type) = $%d", strings.ToLower(strings.TrimSpace(f.Side)))
	}
	switch strings.ToLower(strings.TrimSpace(f.Outcome)) {
	case "profit":
		where = append(where, "realized_pnl > 0")
	case "loss":
		where = append(where, "realized_pnl < 0")
	case "breakeven":
		where = append(where, "realized_pnl = 0")
	}
	whereSQL := " WHERE " + strings.Join(where, " AND ")

	var total int64
	if err := s.Pool.QueryRow(ctx, "SELECT COUNT(*) FROM trades"+whereSQL, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	pageArgs := append(append([]any{}, args...), f.Limit, f.Offset)
	rows, err := s.Pool.Query(ctx, fmt.Sprintf(
		"SELECT * FROM trades%s ORDER BY COALESCE(closed_at, timestamp) DESC, id DESC LIMIT $%d OFFSET $%d",
		whereSQL, len(args)+1, len(args)+2), pageArgs...)
	if err != nil {
		return nil, 0, err
	}
	out, err := collectRows(rows)
	return out, total, err
}

// BotConfig returns the user's row, creating the default one first when it is
// missing — the same upsert the ai-service's get_bot_config performs.
func (s PGStore) BotConfig(ctx context.Context, userID int64) (Row, error) {
	for attempt := 0; attempt < 2; attempt++ {
		rows, err := s.Pool.Query(ctx, `SELECT * FROM bot_config WHERE user_id = $1`, userID)
		if err != nil {
			return nil, err
		}
		found, err := collectRows(rows)
		if err != nil {
			return nil, err
		}
		if len(found) > 0 {
			return found[0], nil
		}
		if attempt == 0 {
			if _, err := s.Pool.Exec(ctx, `
				INSERT INTO bot_config (user_id, assets, total_capital, max_risk_per_trade, min_profit_target, max_profit_target, is_active)
				VALUES ($1, 'BTC-USD,ETH-USD', 10000.0, 100.0, 200.0, 1000.0, FALSE)
				ON CONFLICT (user_id) DO NOTHING`, userID); err != nil {
				return nil, err
			}
		}
	}
	return nil, nil
}

func (s PGStore) HasLiveBotSession(ctx context.Context, userID int64) (bool, error) {
	args := []any{userID}
	marks := make([]string, len(BotLiveStatuses))
	for i, st := range BotLiveStatuses {
		args = append(args, st)
		marks[i] = fmt.Sprintf("$%d", i+2)
	}
	var live bool
	err := s.Pool.QueryRow(ctx,
		"SELECT EXISTS (SELECT 1 FROM bot_sessions WHERE user_id = $1 AND status IN ("+strings.Join(marks, ", ")+"))",
		args...).Scan(&live)
	return live, err
}

func collectRows(rows pgx.Rows) ([]Row, error) {
	defer rows.Close()
	fields := rows.FieldDescriptions()
	var out []Row
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, err
		}
		r := make(Row, len(fields))
		for i, fd := range fields {
			r[fd.Name] = normalizeValue(vals[i])
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func normalizeValue(v any) any {
	switch t := v.(type) {
	case int16:
		return int64(t)
	case int32:
		return int64(t)
	case int:
		return int64(t)
	case float32:
		return float64(t)
	case []byte:
		return string(t)
	default:
		return v
	}
}
