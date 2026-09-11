package botsched

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeEngine records how the supervisor drives the engine.
type fakeEngine struct {
	mu sync.Mutex

	leader      bool
	sessions    []SessionRef
	assets      map[int64][]string
	scanBudget  map[int64]int // remaining scans per session; -1 = unlimited
	stopFlag    map[int64]bool
	monitorErr  map[int64]int // remaining monitor calls that fail
	monitorDown map[int64]int // remaining monitor calls that fail as transport errors
	concurrency int
	tickSeconds float64

	analyzeDelay time.Duration
	stepDelay    time.Duration

	inflight        map[int64]int
	maxPerSession   map[int64]int
	global          int
	maxGlobal       int
	analyzeCalls    int
	evaluateCalls   int
	monitorCalls    int
	finalized       map[int64]int
	failed          map[int64]string
	attachRecovered map[int64]bool
	scansAfterStop  int
}

func newFake() *fakeEngine {
	return &fakeEngine{
		leader:          true,
		assets:          map[int64][]string{},
		scanBudget:      map[int64]int{},
		stopFlag:        map[int64]bool{},
		monitorErr:      map[int64]int{},
		monitorDown:     map[int64]int{},
		concurrency:     8,
		tickSeconds:     0.002,
		inflight:        map[int64]int{},
		maxPerSession:   map[int64]int{},
		finalized:       map[int64]int{},
		failed:          map[int64]string{},
		attachRecovered: map[int64]bool{},
	}
}

func (f *fakeEngine) enter(id int64) {
	f.mu.Lock()
	f.inflight[id]++
	if f.inflight[id] > f.maxPerSession[id] {
		f.maxPerSession[id] = f.inflight[id]
	}
	f.global++
	if f.global > f.maxGlobal {
		f.maxGlobal = f.global
	}
	f.mu.Unlock()
}

func (f *fakeEngine) exit(id int64) {
	f.mu.Lock()
	f.inflight[id]--
	f.global--
	f.mu.Unlock()
}

func (f *fakeEngine) Heartbeat(ctx context.Context, owner string, ttl time.Duration) (HeartbeatResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var hb HeartbeatResult
	hb.Leader = f.leader
	hb.Config.TickSeconds = f.tickSeconds
	hb.Config.AnalysisTTLSeconds = 60
	hb.Config.MaxConcurrency = f.concurrency
	return hb, nil
}

func (f *fakeEngine) Sessions(ctx context.Context) ([]SessionRef, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]SessionRef(nil), f.sessions...), nil
}

func (f *fakeEngine) Attach(ctx context.Context, id int64, recovered bool) error {
	f.mu.Lock()
	f.attachRecovered[id] = recovered
	f.mu.Unlock()
	return nil
}

func (f *fakeEngine) Monitor(ctx context.Context, id int64) (MonitorResult, error) {
	f.enter(id)
	defer f.exit(id)
	time.Sleep(f.stepDelay)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.monitorCalls++
	if f.monitorDown[id] > 0 {
		f.monitorDown[id]--
		return MonitorResult{}, fmt.Errorf("%w: connection refused", ErrEngineUnavailable)
	}
	if f.monitorErr[id] > 0 {
		f.monitorErr[id]--
		return MonitorResult{}, errors.New("engine unavailable")
	}
	if f.finalized[id] > 0 {
		// Like the ai-service: a STOPPED session without open positions is done.
		return MonitorResult{Status: "STOPPED", Done: true}, nil
	}
	if f.stopFlag[id] {
		return MonitorResult{Status: "STOPPING", StopRequested: true}, nil
	}
	due := f.scanBudget[id] != 0
	return MonitorResult{Status: "WAITING", EntriesAllowed: true, ScanDue: due}, nil
}

func (f *fakeEngine) BeginScan(ctx context.Context, id int64) (BeginScanResult, error) {
	f.enter(id)
	defer f.exit(id)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stopFlag[id] {
		f.scansAfterStop++
		return BeginScanResult{Proceed: false}, nil
	}
	if f.scanBudget[id] > 0 {
		f.scanBudget[id]--
	}
	return BeginScanResult{Proceed: true, Assets: f.assets[id]}, nil
}

func (f *fakeEngine) Analyze(ctx context.Context, symbol string) (AnalysisResult, error) {
	f.mu.Lock()
	f.analyzeCalls++
	n := f.analyzeCalls
	f.mu.Unlock()
	time.Sleep(f.analyzeDelay)
	return AnalysisResult{AnalysisID: symbol + "-" + string(rune('a'+n)), OK: true}, nil
}

func (f *fakeEngine) Evaluate(ctx context.Context, id int64, symbol, analysisID string) (EvaluateResult, error) {
	f.enter(id)
	defer f.exit(id)
	time.Sleep(f.stepDelay)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.evaluateCalls++
	return EvaluateResult{Continue: !f.stopFlag[id], Outcome: "no_opportunity"}, nil
}

func (f *fakeEngine) CompleteScan(ctx context.Context, id int64) error {
	f.enter(id)
	defer f.exit(id)
	return nil
}

func (f *fakeEngine) FinalizeStop(ctx context.Context, id int64) error {
	f.enter(id)
	defer f.exit(id)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.finalized[id]++
	// Once STOPPED the engine no longer lists the session.
	kept := f.sessions[:0]
	for _, s := range f.sessions {
		if s.ID != id {
			kept = append(kept, s)
		}
	}
	f.sessions = kept
	return nil
}

func (f *fakeEngine) Fail(ctx context.Context, id int64, reason string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failed[id] = reason
	return nil
}

func (f *fakeEngine) get(fn func() int) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return fn()
}

func runFor(t *testing.T, s *Supervisor, d time.Duration) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	time.Sleep(d)
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("supervisor did not shut down")
	}
}

func waitUntil(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("condition not reached in time")
}

func testConfig() Config {
	return Config{Owner: "test", PollInterval: 5 * time.Millisecond, StepTimeout: 2 * time.Second}
}

func TestStepsOfOneSessionNeverOverlap(t *testing.T) {
	f := newFake()
	f.stepDelay = 2 * time.Millisecond
	for id := int64(1); id <= 4; id++ {
		f.sessions = append(f.sessions, SessionRef{ID: id, Status: "WAITING", Live: true})
		f.assets[id] = []string{"BTC-USD", "ETH-USD"}
		f.scanBudget[id] = -1
	}
	runFor(t, New(testConfig(), f), 300*time.Millisecond)

	f.mu.Lock()
	defer f.mu.Unlock()
	for id := int64(1); id <= 4; id++ {
		if f.maxPerSession[id] != 1 {
			t.Fatalf("session %d had %d concurrent steps; want exactly 1", id, f.maxPerSession[id])
		}
	}
	if f.maxGlobal < 2 {
		t.Fatalf("sessions never ran in parallel (max global in-flight %d)", f.maxGlobal)
	}
	if f.evaluateCalls == 0 {
		t.Fatal("no evaluations happened")
	}
}

func TestAnalysisIsSharedAcrossSessions(t *testing.T) {
	f := newFake()
	f.analyzeDelay = 40 * time.Millisecond
	for id := int64(1); id <= 5; id++ {
		f.sessions = append(f.sessions, SessionRef{ID: id, Status: "WAITING", Live: true})
		f.assets[id] = []string{"BTC-USD"}
		f.scanBudget[id] = 1
	}
	s := New(testConfig(), f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	waitUntil(t, 3*time.Second, func() bool { return f.get(func() int { return f.evaluateCalls }) >= 5 })

	if got := f.get(func() int { return f.analyzeCalls }); got != 1 {
		t.Fatalf("analysis ran %d times for one symbol across 5 sessions; want 1", got)
	}
	stats := s.Stats()
	if stats["analyses_shared"].(int64) < 4 {
		t.Fatalf("expected at least 4 shared analyses, got %v", stats["analyses_shared"])
	}
}

func TestConcurrencyLimitIsRespected(t *testing.T) {
	f := newFake()
	f.concurrency = 2
	f.stepDelay = 10 * time.Millisecond
	for id := int64(1); id <= 10; id++ {
		f.sessions = append(f.sessions, SessionRef{ID: id, Status: "WAITING", Live: true})
	}
	runFor(t, New(testConfig(), f), 250*time.Millisecond)
	if got := f.get(func() int { return f.maxGlobal }); got > 2 {
		t.Fatalf("max concurrent engine steps %d exceeds limit 2", got)
	}
	if got := f.get(func() int { return f.monitorCalls }); got < 10 {
		t.Fatalf("expected every session to be supervised, got %d monitor calls", got)
	}
}

func TestStopRequestIsFinalizedOnceWithoutFurtherScans(t *testing.T) {
	f := newFake()
	f.sessions = []SessionRef{{ID: 7, Status: "WAITING", Live: true}}
	f.assets[7] = []string{"BTC-USD"}
	f.scanBudget[7] = -1
	s := New(testConfig(), f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	waitUntil(t, 2*time.Second, func() bool { return f.get(func() int { return f.evaluateCalls }) > 0 })

	f.mu.Lock()
	f.stopFlag[7] = true
	evalsAtStop := f.evaluateCalls
	f.mu.Unlock()
	s.Wake()

	waitUntil(t, 2*time.Second, func() bool { return f.get(func() int { return f.finalized[7] }) == 1 })
	time.Sleep(50 * time.Millisecond)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.finalized[7] != 1 {
		t.Fatalf("finalized %d times; want 1", f.finalized[7])
	}
	// At most the evaluation that was already in flight may complete.
	if f.evaluateCalls > evalsAtStop+1 {
		t.Fatalf("scanning continued after stop: %d -> %d evaluations", evalsAtStop, f.evaluateCalls)
	}
}

func TestSessionsLiveAtStartupAreAttachedAsRecovered(t *testing.T) {
	f := newFake()
	f.sessions = []SessionRef{
		{ID: 1, Status: "TRADE_ACTIVE", Live: true},
		{ID: 2, Status: "STARTING", Live: true},
	}
	s := New(testConfig(), f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	waitUntil(t, time.Second, func() bool {
		return f.get(func() int { return len(f.attachRecovered) }) == 2
	})
	f.mu.Lock()
	f.sessions = append(f.sessions, SessionRef{ID: 3, Status: "SCANNING", Live: true})
	f.mu.Unlock()
	waitUntil(t, time.Second, func() bool {
		return f.get(func() int { return len(f.attachRecovered) }) == 3
	})
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.attachRecovered[1] {
		t.Fatal("session live before the scheduler started must be attached as recovered")
	}
	if f.attachRecovered[2] {
		t.Fatal("a STARTING session is a fresh start, not a recovery")
	}
	if f.attachRecovered[3] {
		t.Fatal("a session that appears later is not a recovery")
	}
}

func TestLosingTheLeaseStopsWorkers(t *testing.T) {
	f := newFake()
	f.sessions = []SessionRef{{ID: 1, Status: "WAITING", Live: true}}
	s := New(testConfig(), f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	waitUntil(t, time.Second, func() bool { return f.get(func() int { return f.monitorCalls }) > 3 })

	f.mu.Lock()
	f.leader = false
	f.mu.Unlock()
	waitUntil(t, time.Second, func() bool { return s.Stats()["workers"].(int) == 0 })
	before := f.get(func() int { return f.monitorCalls })
	time.Sleep(60 * time.Millisecond)
	if after := f.get(func() int { return f.monitorCalls }); after != before {
		t.Fatalf("non-leader kept supervising: %d -> %d monitor calls", before, after)
	}
}

func TestRepeatedFailuresPutSessionInError(t *testing.T) {
	f := newFake()
	f.sessions = []SessionRef{{ID: 9, Status: "WAITING", Live: true}}
	f.monitorErr[9] = 3
	s := New(testConfig(), f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	waitUntil(t, 2*time.Second, func() bool { return f.get(func() int { return len(f.failed) }) == 1 })
}

func TestEngineRestartDoesNotPutSessionInError(t *testing.T) {
	f := newFake()
	f.sessions = []SessionRef{{ID: 4, Status: "TRADE_ACTIVE", Live: true}}
	f.monitorDown[4] = 10 // ai-service unreachable for 10 ticks
	s := New(testConfig(), f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	waitUntil(t, 2*time.Second, func() bool { return f.get(func() int { return f.monitorCalls }) > 12 })
	if got := f.get(func() int { return len(f.failed) }); got != 0 {
		t.Fatalf("an unreachable engine put %d session(s) in ERROR", got)
	}
}

func TestSessionLeavingTheListCancelsItsWorker(t *testing.T) {
	f := newFake()
	f.sessions = []SessionRef{{ID: 1, Status: "WAITING", Live: true}, {ID: 2, Status: "WAITING", Live: true}}
	s := New(testConfig(), f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	waitUntil(t, time.Second, func() bool { return s.Stats()["workers"].(int) == 2 })
	f.mu.Lock()
	f.sessions = f.sessions[:1]
	f.mu.Unlock()
	waitUntil(t, time.Second, func() bool { return s.Stats()["workers"].(int) == 1 })
}

func TestFlightCacheRunsOneFetchPerKey(t *testing.T) {
	c := newFlightCache()
	var fetches atomic.Int32
	var wg sync.WaitGroup
	ids := make([]string, 20)
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id, err := c.get("ETH-USD", time.Minute, func() (string, error) {
				fetches.Add(1)
				time.Sleep(20 * time.Millisecond)
				return "analysis-1", nil
			})
			if err != nil {
				t.Error(err)
			}
			ids[i] = id
		}(i)
	}
	wg.Wait()
	if fetches.Load() != 1 {
		t.Fatalf("fetch ran %d times; want 1", fetches.Load())
	}
	for _, id := range ids {
		if id != "analysis-1" {
			t.Fatalf("caller got %q", id)
		}
	}
	c.forget("ETH-USD", "analysis-1")
	_, _ = c.get("ETH-USD", time.Minute, func() (string, error) { fetches.Add(1); return "analysis-2", nil })
	if fetches.Load() != 2 {
		t.Fatal("forget did not invalidate the cached analysis")
	}
}
