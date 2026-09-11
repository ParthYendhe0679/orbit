// Package cache reads the live market state the ai-service keeps in Valkey.
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Valkey is a read client for the Aiven Valkey (Redis-compatible) cache.
type Valkey struct {
	rdb *redis.Client
}

// URLFromEnv resolves the connection URL the same way the ai-service's
// valkey_service does: VALKEY_URL, then REDIS_URL, then host/port parts.
func URLFromEnv() string {
	for _, k := range []string{"VALKEY_URL", "REDIS_URL"} {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	host := strings.TrimSpace(os.Getenv("VALKEY_HOST"))
	if host == "" {
		return ""
	}
	port := strings.TrimSpace(os.Getenv("VALKEY_PORT"))
	if port == "" {
		port = "6379"
	}
	scheme := "rediss"
	if s := strings.ToLower(strings.TrimSpace(os.Getenv("VALKEY_SSL"))); s == "false" || s == "0" || s == "no" {
		scheme = "redis"
	}
	u := &url.URL{Scheme: scheme, Host: host + ":" + port}
	user := strings.TrimSpace(os.Getenv("VALKEY_USERNAME"))
	if user == "" {
		user = "default"
	}
	if pass := os.Getenv("VALKEY_PASSWORD"); pass != "" {
		u.User = url.UserPassword(user, pass)
	}
	return u.String()
}

// Connect dials Valkey (TLS for rediss://) and verifies it with PING.
func Connect(ctx context.Context, rawURL string) (*Valkey, error) {
	if rawURL == "" {
		return nil, errors.New("no Valkey URL configured")
	}
	opts, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, errors.New("invalid Valkey URL")
	}
	opts.DialTimeout = 5 * time.Second
	opts.ReadTimeout = 2 * time.Second
	opts.WriteTimeout = 2 * time.Second
	opts.PoolSize = 10
	// Managed Valkey may reject CLIENT SETINFO; identity is cosmetic.
	opts.DisableIdentity = true
	c := &Valkey{rdb: redis.NewClient(opts)}
	pingCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if err := c.Ping(pingCtx); err != nil {
		_ = c.rdb.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return c, nil
}

// Ping checks the connection.
func (c *Valkey) Ping(ctx context.Context) error {
	return c.rdb.Ping(ctx).Err()
}

// Close releases the connection pool.
func (c *Valkey) Close() error { return c.rdb.Close() }

// PriceKey is the key the ai-service's market tick scheduler refreshes every
// few seconds (15 s TTL) for every symbol with an open position.
func PriceKey(symbol string) string {
	return "market:price:" + strings.ToUpper(strings.TrimSpace(symbol))
}

// MarketPrices returns the live price of each symbol that has a fresh cache
// entry; symbols without one are absent from the map.
func (c *Valkey) MarketPrices(ctx context.Context, symbols []string) (map[string]float64, error) {
	out := make(map[string]float64, len(symbols))
	if len(symbols) == 0 {
		return out, nil
	}
	keys := make([]string, len(symbols))
	for i, s := range symbols {
		keys[i] = PriceKey(s)
	}
	vals, err := c.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	for i, v := range vals {
		s, ok := v.(string)
		if !ok {
			continue
		}
		var entry struct {
			Price float64 `json:"price"`
		}
		if json.Unmarshal([]byte(s), &entry) == nil && entry.Price > 0 {
			out[symbols[i]] = entry.Price
		}
	}
	return out, nil
}
