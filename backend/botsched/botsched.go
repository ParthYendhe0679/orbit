// Package botsched is the Auto-Trade Bot's concurrency layer.
//
// The Python ai-service owns the trading and AI logic but exposes it only as
// single-step internal endpoints (/internal/bot/*). This package decides when
// those steps run and how many run at once:
//
//   - one goroutine per bot session, so a session's steps never overlap;
//   - a bounded semaphore across all sessions (engine-provided max_concurrency);
//   - per-symbol single-flight analysis, shared by every session and user that
//     scans the symbol inside the analysis TTL;
//   - an expiring leader lease, so only one gateway replica schedules;
//   - graceful stop: a stopping session finishes its in-flight step and is then
//     finalized; cancellation only ever happens between steps;
//   - recovery: sessions that are live when the scheduler starts are resumed.
//
// The ai-service's database guards stay the source of truth, so a scheduling
// fault can delay a step but can never over-allocate capital.
package botsched

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ---------------------------------------------------------------------------
// Engine contract (ai-service step API)
// ---------------------------------------------------------------------------

// SessionRef is one session the engine wants scheduled.
type SessionRef struct {
	ID     int64  `json:"id"`
	UserID int64  `json:"user_id"`
	Status string `json:"status"`
	Live   bool   `json:"live"`
}

// HeartbeatResult carries the lease verdict and the engine's pacing policy.
type HeartbeatResult struct {
	Leader bool `json:"leader"`
	Config struct {
		TickSeconds        float64 `json:"tick_seconds"`
		AnalysisTTLSeconds float64 `json:"analysis_ttl_seconds"`
		MaxConcurrency     int     `json:"max_concurrency"`
	} `json:"config"`
}

// MonitorResult is the outcome of one supervision tick.
type MonitorResult struct {
	Status         string `json:"status"`
	Done           bool   `json:"done"`
	StopRequested  bool   `json:"stop_requested"`
	EntriesAllowed bool   `json:"entries_allowed"`
	ScanDue        bool   `json:"scan_due"`
}

// BeginScanResult lists the symbols to evaluate in this scan.
type BeginScanResult struct {
	Proceed bool     `json:"proceed"`
	Assets  []string `json:"assets"`
}

// AnalysisResult identifies a stored analysis the engine can evaluate against.
type AnalysisResult struct {
	AnalysisID string `json:"analysis_id"`
	OK         bool   `json:"ok"`
}

// EvaluateResult says whether the scan should go on to the next symbol.
type EvaluateResult struct {
	Continue bool   `json:"continue"`
	Outcome  string `json:"outcome"`
}

// Engine is the ai-service step API. HTTPEngine implements it; tests fake it.
type Engine interface {
	Heartbeat(ctx context.Context, owner string, ttl time.Duration) (HeartbeatResult, error)
	Sessions(ctx context.Context) ([]SessionRef, error)
	Attach(ctx context.Context, id int64, recovered bool) error
	Monitor(ctx context.Context, id int64) (MonitorResult, error)
	BeginScan(ctx context.Context, id int64) (BeginScanResult, error)
	Analyze(ctx context.Context, symbol string) (AnalysisResult, error)
	Evaluate(ctx context.Context, id int64, symbol, analysisID string) (EvaluateResult, error)
	CompleteScan(ctx context.Context, id int64) error
	FinalizeStop(ctx context.Context, id int64) error
	Fail(ctx context.Context, id int64, reason string) error
}

// HTTPEngine calls the ai-service's /internal/bot/* endpoints.
type HTTPEngine struct {
	base   string
	token  string
	client *http.Client
}

// NewHTTPEngine targets the ai-service base URL; token is ORBIT_INTERNAL_TOKEN.
func NewHTTPEngine(baseURL, token string) *HTTPEngine {
	return &HTTPEngine{base: strings.TrimRight(baseURL, "/"), token: token, client: &http.Client{}}
}

func (e *HTTPEngine) do(ctx context.Context, method, path string, body, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, e.base+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if e.token != "" {
		req.Header.Set("X-Orbit-Internal-Token", e.token)
	}
	resp, err := e.client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrEngineUnavailable, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		msg := string(data)
		if len(msg) > 200 {
			msg = msg[:200]
		}
		return fmt.Errorf("%s %s: HTTP %d %s", method, path, resp.StatusCode, msg)
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

func sessionPath(id int64, step string) string {
	return fmt.Sprintf("/internal/bot/sessions/%d/%s", id, step)
}

func (e *HTTPEngine) Heartbeat(ctx context.Context, owner string, ttl time.Duration) (HeartbeatResult, error) {
	var out HeartbeatResult
	err := e.do(ctx, http.MethodPost, "/internal/bot/scheduler/heartbeat",
		map[string]any{"owner": owner, "ttl_seconds": int(ttl.Seconds())}, &out)
	return out, err
}

func (e *HTTPEngine) Sessions(ctx context.Context) ([]SessionRef, error) {
	var out struct {
		Sessions []SessionRef `json:"sessions"`
	}
	err := e.do(ctx, http.MethodGet, "/internal/bot/scheduler/sessions", nil, &out)
	return out.Sessions, err
}

func (e *HTTPEngine) Attach(ctx context.Context, id int64, recovered bool) error {
	return e.do(ctx, http.MethodPost, sessionPath(id, "attach"), map[string]any{"recovered": recovered}, nil)
}

func (e *HTTPEngine) Monitor(ctx context.Context, id int64) (MonitorResult, error) {
	var out MonitorResult
	err := e.do(ctx, http.MethodPost, sessionPath(id, "monitor"), nil, &out)
	return out, err
}

func (e *HTTPEngine) BeginScan(ctx context.Context, id int64) (BeginScanResult, error) {
	var out BeginScanResult
	err := e.do(ctx, http.MethodPost, sessionPath(id, "scan/begin"), nil, &out)
	return out, err
}

func (e *HTTPEngine) Analyze(ctx context.Context, symbol string) (AnalysisResult, error) {
	var out AnalysisResult
	err := e.do(ctx, http.MethodPost, "/internal/bot/analysis", map[string]any{"symbol": symbol}, &out)
	return out, err
}

func (e *HTTPEngine) Evaluate(ctx context.Context, id int64, symbol, analysisID string) (EvaluateResult, error) {
	var out EvaluateResult
	err := e.do(ctx, http.MethodPost, sessionPath(id, "evaluate"),
		map[string]any{"symbol": symbol, "analysis_id": analysisID}, &out)
	return out, err
}

func (e *HTTPEngine) CompleteScan(ctx context.Context, id int64) error {
	return e.do(ctx, http.MethodPost, sessionPath(id, "scan/complete"), nil, nil)
}

func (e *HTTPEngine) FinalizeStop(ctx context.Context, id int64) error {
	return e.do(ctx, http.MethodPost, sessionPath(id, "finalize-stop"), nil, nil)
}

func (e *HTTPEngine) Fail(ctx context.Context, id int64, reason string) error {
	return e.do(ctx, http.MethodPost, sessionPath(id, "fail"), map[string]any{"error": reason}, nil)
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

// Config tunes the supervisor. Zero values take the defaults below; pacing
// (tick, analysis TTL, concurrency) comes from the engine's heartbeat.
type Config struct {
	Owner        string        // lease identity; defaults to host-pid-random
	PollInterval time.Duration // session-list reconciliation; default 3s
	LeaseTTL     time.Duration // leader lease; default 15s
	StepTimeout  time.Duration // one engine step (analysis can include LLM calls); default 120s
	MaxFailures  int           // consecutive failed ticks before the session is put in ERROR; default 3
}

func (c *Config) withDefaults() {
	if c.Owner == "" {
		host, _ := os.Hostname()
		b := make([]byte, 4)
		_, _ = rand.Read(b)
		c.Owner = fmt.Sprintf("%s-%d-%s", host, os.Getpid(), hex.EncodeToString(b))
	}
	if c.PollInterval <= 0 {
		c.PollInterval = 3 * time.Second
	}
	if c.LeaseTTL <= 0 {
		c.LeaseTTL = 15 * time.Second
	}
	if c.StepTimeout <= 0 {
		c.StepTimeout = 120 * time.Second
	}
	if c.MaxFailures <= 0 {
		c.MaxFailures = 3
	}
}

const (
	defaultTick        = 10 * time.Second
	defaultAnalysisTTL = 170 * time.Second
	defaultConcurrency = 8
)

var errWorkerDone = errors.New("session no longer needs scheduling")

// ErrEngineUnavailable wraps transport failures (the ai-service is down or
// restarting). They are retried on the next tick and never count towards
// putting a session in ERROR — the session itself is not at fault.
var ErrEngineUnavailable = errors.New("bot engine unavailable")

// Supervisor runs every scheduled bot session.
type Supervisor struct {
	cfg    Config
	engine Engine

	mu         sync.Mutex
	workers    map[int64]*worker
	leader     bool
	reconciled bool
	sem        chan struct{}

	tickNanos atomic.Int64
	ttlNanos  atomic.Int64

	analyses *flightCache
	wake     chan struct{}

	steps        atomic.Int64
	stepFailures atomic.Int64
}

type worker struct {
	id     int64
	cancel context.CancelFunc
	kick   chan struct{}
	done   chan struct{}
}

// New builds a supervisor; call Run to start it.
func New(cfg Config, engine Engine) *Supervisor {
	cfg.withDefaults()
	s := &Supervisor{
		cfg:      cfg,
		engine:   engine,
		workers:  make(map[int64]*worker),
		analyses: newFlightCache(),
		wake:     make(chan struct{}, 1),
	}
	s.tickNanos.Store(int64(defaultTick))
	s.ttlNanos.Store(int64(defaultAnalysisTTL))
	return s
}

// Owner is this supervisor's lease identity.
func (s *Supervisor) Owner() string { return s.cfg.Owner }

// Wake triggers an immediate reconciliation (e.g. right after a start/stop request).
func (s *Supervisor) Wake() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Run reconciles until ctx is cancelled, then waits for in-flight steps.
func (s *Supervisor) Run(ctx context.Context) {
	ticker := time.NewTicker(s.cfg.PollInterval)
	defer ticker.Stop()
	for {
		s.reconcile(ctx)
		select {
		case <-ctx.Done():
			s.stopAll(true)
			return
		case <-ticker.C:
		case <-s.wake:
		}
	}
}

func (s *Supervisor) applyConfig(hb HeartbeatResult) {
	if hb.Config.TickSeconds > 0 {
		s.tickNanos.Store(int64(hb.Config.TickSeconds * float64(time.Second)))
	}
	if hb.Config.AnalysisTTLSeconds > 0 {
		s.ttlNanos.Store(int64(hb.Config.AnalysisTTLSeconds * float64(time.Second)))
	}
	s.mu.Lock()
	if s.sem == nil {
		n := hb.Config.MaxConcurrency
		if n <= 0 {
			n = defaultConcurrency
		}
		s.sem = make(chan struct{}, n)
	}
	s.mu.Unlock()
}

func (s *Supervisor) reconcile(ctx context.Context) {
	hbCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	hb, err := s.engine.Heartbeat(hbCtx, s.cfg.Owner, s.cfg.LeaseTTL)
	cancel()
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("[botsched] heartbeat failed: %v", err)
		}
		return
	}
	s.applyConfig(hb)

	if !hb.Leader {
		s.mu.Lock()
		wasLeader := s.leader
		s.leader = false
		s.mu.Unlock()
		if wasLeader {
			log.Printf("[botsched] lost the scheduler lease; stopping local workers")
			s.stopAll(false)
		}
		return
	}

	listCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	refs, err := s.engine.Sessions(listCtx)
	cancel()
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("[botsched] session list failed: %v", err)
		}
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.leader {
		log.Printf("[botsched] holding the scheduler lease as %s", s.cfg.Owner)
	}
	s.leader = true
	// Sessions already live on the first successful pass were running before
	// this process started: they are recoveries, not fresh starts.
	firstPass := !s.reconciled
	s.reconciled = true

	wanted := make(map[int64]bool, len(refs))
	for _, ref := range refs {
		wanted[ref.ID] = true
		if w, ok := s.workers[ref.ID]; ok {
			select {
			case w.kick <- struct{}{}:
			default:
			}
			continue
		}
		wctx, wcancel := context.WithCancel(ctx)
		w := &worker{id: ref.ID, cancel: wcancel, kick: make(chan struct{}, 1), done: make(chan struct{})}
		s.workers[ref.ID] = w
		go s.runWorker(wctx, w, firstPass && ref.Status != "STARTING")
	}
	for id, w := range s.workers {
		if !wanted[id] {
			w.cancel()
		}
	}
}

func (s *Supervisor) stopAll(wait bool) {
	s.mu.Lock()
	workers := make([]*worker, 0, len(s.workers))
	for _, w := range s.workers {
		w.cancel()
		workers = append(workers, w)
	}
	s.mu.Unlock()
	if !wait {
		return
	}
	deadline := time.After(s.cfg.StepTimeout)
	for _, w := range workers {
		select {
		case <-w.done:
		case <-deadline:
			return
		}
	}
}

func (s *Supervisor) retire(w *worker) {
	s.mu.Lock()
	if s.workers[w.id] == w {
		delete(s.workers, w.id)
	}
	s.mu.Unlock()
	close(w.done)
}

// step runs one engine call under the global concurrency limit. It uses its
// own timeout context rather than the worker's: once a step has started it is
// allowed to finish, so a stop never interrupts an order half-way.
func (s *Supervisor) step(fn func(ctx context.Context) error) error {
	s.sem <- struct{}{}
	defer func() { <-s.sem }()
	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.StepTimeout)
	defer cancel()
	s.steps.Add(1)
	err := fn(ctx)
	if err != nil {
		s.stepFailures.Add(1)
	}
	return err
}

func (s *Supervisor) tick() time.Duration { return time.Duration(s.tickNanos.Load()) }

func (s *Supervisor) runWorker(ctx context.Context, w *worker, recovered bool) {
	defer s.retire(w)
	if err := s.step(func(c context.Context) error { return s.engine.Attach(c, w.id, recovered) }); err != nil {
		log.Printf("[botsched] session %d attach failed: %v", w.id, err)
	}
	failures := 0
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-w.kick:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
		err := s.cycle(ctx, w.id)
		if errors.Is(err, errWorkerDone) {
			return
		}
		switch {
		case err == nil:
			failures = 0
		case errors.Is(err, ErrEngineUnavailable):
			log.Printf("[botsched] session %d: engine unavailable, retrying next tick: %v", w.id, err)
		default:
			failures++
			log.Printf("[botsched] session %d tick failed (%d/%d): %v", w.id, failures, s.cfg.MaxFailures, err)
			if failures >= s.cfg.MaxFailures {
				reason := err.Error()
				if ferr := s.step(func(c context.Context) error { return s.engine.Fail(c, w.id, reason) }); ferr != nil {
					log.Printf("[botsched] session %d could not be marked ERROR: %v", w.id, ferr)
				}
				failures = 0
			}
		}
		timer.Reset(s.tick())
	}
}

// cycle is one supervision tick, followed by a scan when the engine says one is due.
func (s *Supervisor) cycle(ctx context.Context, id int64) error {
	var mon MonitorResult
	if err := s.step(func(c context.Context) error {
		var e error
		mon, e = s.engine.Monitor(c, id)
		return e
	}); err != nil {
		return err
	}
	switch {
	case mon.StopRequested:
		// Nothing else runs for this session inside this goroutine, so there
		// is no in-flight step left: the stop can be finalized now.
		return s.step(func(c context.Context) error { return s.engine.FinalizeStop(c, id) })
	case mon.Done:
		return errWorkerDone
	case mon.ScanDue && mon.EntriesAllowed:
		return s.scan(ctx, id)
	}
	return nil
}

func (s *Supervisor) scan(ctx context.Context, id int64) error {
	var begin BeginScanResult
	if err := s.step(func(c context.Context) error {
		var e error
		begin, e = s.engine.BeginScan(c, id)
		return e
	}); err != nil {
		return err
	}
	if !begin.Proceed {
		return nil
	}
	for _, sym := range begin.Assets {
		if ctx.Err() != nil {
			break // lease lost or shutdown: stop between symbols, never mid-step
		}
		ev, err := s.evaluateSymbol(id, sym)
		if err != nil {
			log.Printf("[botsched] session %d %s: %v", id, sym, err)
			continue
		}
		if !ev.Continue {
			break // stopped, limit reached, or session gone
		}
	}
	return s.step(func(c context.Context) error { return s.engine.CompleteScan(c, id) })
}

func (s *Supervisor) evaluateSymbol(id int64, sym string) (EvaluateResult, error) {
	for attempt := 0; attempt < 2; attempt++ {
		aid, err := s.analysis(sym)
		if err != nil {
			return EvaluateResult{Continue: true}, err
		}
		var ev EvaluateResult
		if err := s.step(func(c context.Context) error {
			var e error
			ev, e = s.engine.Evaluate(c, id, sym, aid)
			return e
		}); err != nil {
			return EvaluateResult{Continue: true}, err
		}
		if ev.Outcome != "analysis_missing" {
			return ev, nil
		}
		s.analyses.forget(strings.ToUpper(strings.TrimSpace(sym)), aid)
	}
	return EvaluateResult{Continue: true, Outcome: "analysis_missing"}, nil
}

// analysis returns an analysis id for sym, running the engine's analysis at
// most once at a time per symbol and reusing it for the analysis TTL.
func (s *Supervisor) analysis(sym string) (string, error) {
	key := strings.ToUpper(strings.TrimSpace(sym))
	ttl := time.Duration(s.ttlNanos.Load())
	return s.analyses.get(key, ttl, func() (string, error) {
		var res AnalysisResult
		err := s.step(func(c context.Context) error {
			var e error
			res, e = s.engine.Analyze(c, key)
			return e
		})
		if err == nil && res.AnalysisID == "" {
			err = errors.New("engine returned no analysis id")
		}
		return res.AnalysisID, err
	})
}

// Stats is a read-only snapshot for the health endpoint.
func (s *Supervisor) Stats() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return map[string]any{
		"owner":           s.cfg.Owner,
		"leader":          s.leader,
		"workers":         len(s.workers),
		"steps":           s.steps.Load(),
		"step_failures":   s.stepFailures.Load(),
		"analyses_run":    s.analyses.runs.Load(),
		"analyses_shared": s.analyses.shared.Load(),
		"tick_seconds":    s.tick().Seconds(),
	}
}

// ---------------------------------------------------------------------------
// Per-key single-flight with a short result cache
// ---------------------------------------------------------------------------

type cacheEntry struct {
	id      string
	expires time.Time
}

type flight struct {
	done chan struct{}
	id   string
	err  error
}

type flightCache struct {
	mu       sync.Mutex
	entries  map[string]cacheEntry
	inflight map[string]*flight
	runs     atomic.Int64 // fetches actually executed
	shared   atomic.Int64 // lookups served by the cache or by another caller's fetch
}

func newFlightCache() *flightCache {
	return &flightCache{entries: make(map[string]cacheEntry), inflight: make(map[string]*flight)}
}

func (f *flightCache) get(key string, ttl time.Duration, fetch func() (string, error)) (string, error) {
	f.mu.Lock()
	if e, ok := f.entries[key]; ok {
		if time.Now().Before(e.expires) {
			f.mu.Unlock()
			f.shared.Add(1)
			return e.id, nil
		}
		delete(f.entries, key)
	}
	if fl, ok := f.inflight[key]; ok {
		f.mu.Unlock()
		f.shared.Add(1)
		<-fl.done
		return fl.id, fl.err
	}
	fl := &flight{done: make(chan struct{})}
	f.inflight[key] = fl
	f.mu.Unlock()

	fl.id, fl.err = fetch()
	f.runs.Add(1)

	f.mu.Lock()
	delete(f.inflight, key)
	if fl.err == nil && ttl > 0 {
		f.entries[key] = cacheEntry{id: fl.id, expires: time.Now().Add(ttl)}
	}
	f.mu.Unlock()
	close(fl.done)
	return fl.id, fl.err
}

func (f *flightCache) forget(key, id string) {
	f.mu.Lock()
	if e, ok := f.entries[key]; ok && e.id == id {
		delete(f.entries, key)
	}
	f.mu.Unlock()
}
