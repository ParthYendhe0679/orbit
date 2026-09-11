package middleware

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// UserResolver maps a verified Clerk user id to the ORBIT account linked to it
// by /api/auth/sync ("user".clerk_id). ErrUserNotFound when none is linked.
type UserResolver interface {
	ResolveClerkUser(ctx context.Context, clerkID string) (userID int64, username string, err error)
}

// DBResolver reads the link straight from PostgreSQL.
type DBResolver struct{ Pool *pgxpool.Pool }

func (d DBResolver) ResolveClerkUser(ctx context.Context, clerkID string) (int64, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var id int64
	var name string
	err := d.Pool.QueryRow(ctx, `SELECT id, username FROM "user" WHERE clerk_id = $1`, clerkID).Scan(&id, &name)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, "", ErrUserNotFound
	}
	if err != nil {
		return 0, "", fmt.Errorf("%w: %v", ErrIdentityUnavailable, err)
	}
	return id, name, nil
}

// HTTPResolver asks the ai-service (/internal/auth/resolve); used when the
// gateway has no DATABASE_URL (local SQLite mode).
type HTTPResolver struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

func (h HTTPResolver) ResolveClerkUser(ctx context.Context, clerkID string) (int64, string, error) {
	client := h.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	u := strings.TrimRight(h.BaseURL, "/") + "/internal/auth/resolve?clerk_id=" + url.QueryEscape(clerkID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, "", err
	}
	if h.Token != "" {
		req.Header.Set(HeaderInternalToken, h.Token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", fmt.Errorf("%w: %v", ErrIdentityUnavailable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return 0, "", ErrUserNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return 0, "", fmt.Errorf("%w: ai-service status %d", ErrIdentityUnavailable, resp.StatusCode)
	}
	var out struct {
		UserID   int64  `json:"user_id"`
		Username string `json:"username"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out); err != nil || out.UserID <= 0 {
		return 0, "", fmt.Errorf("%w: bad resolve response", ErrIdentityUnavailable)
	}
	return out.UserID, out.Username, nil
}

// CachingResolver memoizes successful lookups for TTL. Misses are not cached,
// so an account provisioned by /api/auth/sync is visible immediately.
type CachingResolver struct {
	Next UserResolver
	TTL  time.Duration

	mu      sync.Mutex
	entries map[string]cachedUser
}

type cachedUser struct {
	id      int64
	name    string
	expires time.Time
}

func (c *CachingResolver) ResolveClerkUser(ctx context.Context, clerkID string) (int64, string, error) {
	now := time.Now()
	c.mu.Lock()
	if e, ok := c.entries[clerkID]; ok && now.Before(e.expires) {
		c.mu.Unlock()
		return e.id, e.name, nil
	}
	c.mu.Unlock()

	id, name, err := c.Next.ResolveClerkUser(ctx, clerkID)
	if err != nil {
		return 0, "", err
	}
	ttl := c.TTL
	if ttl <= 0 {
		ttl = time.Minute
	}
	c.mu.Lock()
	if c.entries == nil {
		c.entries = map[string]cachedUser{}
	}
	if len(c.entries) > 10000 {
		c.entries = map[string]cachedUser{}
	}
	c.entries[clerkID] = cachedUser{id: id, name: name, expires: now.Add(ttl)}
	c.mu.Unlock()
	return id, name, nil
}
