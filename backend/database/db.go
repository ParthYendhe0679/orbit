// Package database owns the gateway's PostgreSQL connection pool (pgx).
package database

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotConfigured is returned when DATABASE_URL is not a PostgreSQL URL (the
// ai-service then runs on its local SQLite file and owns every read).
var ErrNotConfigured = errors.New("DATABASE_URL is not a PostgreSQL URL")

// IsPostgresURL mirrors the ai-service's check in database.py.
func IsPostgresURL(raw string) bool {
	raw = strings.TrimSpace(raw)
	return strings.HasPrefix(raw, "postgres://") || strings.HasPrefix(raw, "postgresql://")
}

// Connect opens a pool and verifies it with a ping. The caller keeps running
// without a pool when this fails: the gateway then proxies reads to Python.
func Connect(ctx context.Context, rawURL string) (*pgxpool.Pool, error) {
	if !IsPostgresURL(rawURL) {
		return nil, ErrNotConfigured
	}
	normalized, note := normalizeURL(rawURL)
	if note != "" {
		log.Printf("[database] %s", note)
	}
	cfg, err := pgxpool.ParseConfig(normalized)
	if err != nil {
		// Never echo the URL: it carries the password.
		return nil, errors.New("invalid DATABASE_URL")
	}
	cfg.MaxConns = int32(envInt("DB_MAX_CONNS", 10))
	cfg.MinConns = 0
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnLifetimeJitter = 2 * time.Minute
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second
	// Neon cold starts can take several seconds.
	cfg.ConnConfig.ConnectTimeout = 10 * time.Second
	// Neon's "-pooler" endpoint is PgBouncer in transaction mode, where named
	// prepared statements break; Exec mode prepares nothing server-side.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

// normalizeURL removes libpq options pgx does not implement. pgx would send
// an unknown option to the server as a runtime parameter and the connection
// would fail. Neon URLs carry channel_binding=require; its protection against
// a man-in-the-middle is kept by upgrading sslmode=require (encrypt only) to
// verify-full (encrypt and verify the server certificate and host name).
func normalizeURL(raw string) (string, string) {
	u, err := url.Parse(raw)
	if err != nil {
		return raw, ""
	}
	q := u.Query()
	if q.Get("channel_binding") == "" {
		return raw, ""
	}
	note := "channel_binding is not supported by pgx; removed from the connection options"
	if strings.EqualFold(q.Get("channel_binding"), "require") && strings.EqualFold(q.Get("sslmode"), "require") {
		q.Set("sslmode", "verify-full")
		note += " and sslmode upgraded to verify-full"
	}
	q.Del("channel_binding")
	u.RawQuery = q.Encode()
	return u.String(), note
}

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name))); err == nil && v > 0 {
		return v
	}
	return def
}
