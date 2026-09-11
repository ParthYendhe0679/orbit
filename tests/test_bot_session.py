"""
Auto-Trade Bot lifecycle tests (Phase 21).

The ai-service engine is exercised exactly the way the Go scheduler drives it
(begin_scan -> analyze -> evaluate -> complete_scan, monitor, finalize_stop),
against the real database layer, execution engine, Risk Guard gate, Risk
Planner and P&L Manager. Only the market price and the analysis verdict are
supplied by the test, so every scenario is deterministic.
"""

import asyncio
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient  # noqa: F401

from conftest import GatewayClient

import main  # ai-service/main.py (see conftest.py for isolation)
from models.bot import LIVE_STATES, ENTRY_STATES, TERMINAL_STATES
from models.decision import DecisionClarity, DecisionStatus, MarketStance
from models.market import MarketQuote
from models.opportunity import OpportunityLevel, OpportunityStatus
from models.risk import RiskLevel, RiskStatus
from models.brain import BrainStatus
from services.bot_service import BotEngine, BotPolicy
from services.decision_engine import decision_engine
from services.opportunity_engine import opportunity_engine
from services.orbit_brain import orbit_brain
from services.risk_guard import risk_guard

db = main.db
ROOT = Path(__file__).resolve().parents[1]
TOKEN = {"X-Orbit-Internal-Token": "test-internal-token"}


# ---------------------------------------------------------------------------
# Fixtures & helpers
# ---------------------------------------------------------------------------

def make_analysis(symbol, stance="NEUTRAL", price=100.0, risk_level="MODERATE", clarity="CLEAR", opportunity="HIGH"):
    """A stored-analysis record shaped exactly like run_asset_analysis() output."""
    t0 = time.perf_counter()
    brain = orbit_brain._create_fatal_context(symbol, "1d", "now", "fixture", t0).model_copy(
        update={"analysis_status": BrainStatus.READY})
    risk = risk_guard._create_fatal_result(symbol, "1d", "now", "fixture", t0).model_copy(
        update={"risk_level": RiskLevel(risk_level), "risk_score": 40.0, "status": RiskStatus.READY})
    opp = opportunity_engine._create_fatal_result(symbol, "1d", "now", "fixture", t0).model_copy(
        update={"opportunity_level": OpportunityLevel(opportunity), "opportunity_score": 70.0,
                "status": OpportunityStatus.READY, "leading_bias": stance})
    decision = decision_engine._create_fatal_result(symbol, "1d", "now", "fixture", t0).model_copy(
        update={"decision": MarketStance(stance), "decision_clarity": DecisionClarity(clarity),
                "decision_confidence": 72.0, "status": DecisionStatus.READY})
    return {
        "symbol": symbol, "ok": True, "error": None, "created_at": time.time(),
        "price": price, "candles": 60, "data_source": "fixture", "data_age_seconds": 0.0,
        "brain": brain.model_dump(mode="json"), "risk": risk.model_dump(mode="json"),
        "opportunity": opp.model_dump(mode="json"), "decision": decision.model_dump(mode="json"),
        "supports": [round(price * 0.985, 4)], "resistances": [round(price * 1.03, 4)],
        "sentiment_score": 0.0,
    }


@pytest.fixture
def app_env(tmp_path, monkeypatch):
    dbfile = str(tmp_path / "orbit_test.db")
    for mod in (db, sys.modules["database"]):
        monkeypatch.setattr(mod, "DB_PATH", dbfile)
        monkeypatch.setattr(mod, "IS_POSTGRES", False)
    db.init_db()

    vs = main.valkey_service
    vs._memory_cache.clear()
    vs._memory_sets.clear()
    vs._memory_lists.clear()
    vs.is_connected = False
    vs._valkey_client = None

    prices = {"BTC-USD": 100.0, "ETH-USD": 50.0, "SOL-USD": 20.0}

    async def fake_quote(symbol, force_refresh=False):
        sym = symbol.strip().upper()
        p = prices[sym]
        return MarketQuote(symbol=sym, price=p, open=p, high=p, low=p, close=p, previous_close=p,
                           change=0.0, change_percent=0.0, timestamp="now", source="test")

    async def fake_price(symbol, force_refresh=False):
        return prices[symbol.strip().upper()]

    monkeypatch.setattr(main.market_service, "get_quote", fake_quote)
    monkeypatch.setattr(main.market_service, "get_price", fake_price)
    import llm
    monkeypatch.setattr(llm, "generate_text", lambda *a, **k: "")
    monkeypatch.setattr(main, "_gateway_publish_down_until", float("inf"))

    stances = {}
    published = []

    async def analyzer(symbol):
        return make_analysis(symbol, stances.get(symbol, "NEUTRAL"), price=prices[symbol])

    async def record(uid, msg):
        published.append((uid, msg))

    # The REST/internal endpoints use main.bot_engine; give it the same test inputs.
    monkeypatch.setattr(main.bot_engine, "analyzer", analyzer)
    monkeypatch.setattr(main.bot_engine, "price_fn", fake_price)
    monkeypatch.setattr(main.bot_engine, "publish", record)
    return SimpleNamespace(prices=prices, stances=stances, published=published, analyzer=analyzer, price=fake_price)


@pytest.fixture
def engine(app_env):
    events = []

    async def publish(uid, msg):
        events.append((uid, msg))

    eng = BotEngine(publish=publish, analyzer=app_env.analyzer, price_fn=app_env.price,
                    policy=BotPolicy(scan_interval_seconds=60.0, tick_seconds=2.0, analysis_ttl_seconds=50.0))
    eng.events = events
    return eng


@pytest.fixture
def client(app_env):
    # Requests arrive as the Go gateway forwards them (token + verified account).
    return GatewayClient(main.app)


def run(coro):
    return asyncio.run(coro)


def new_user(name, balance=None):
    uid = db.register_user(name, f"{name}@example.com", "salt:hash")
    if balance is not None:
        db.update_user_balance(uid, balance - db.get_user_balance(uid))
    return uid


def bot_events(events):
    return [m for _, m in events if m.get("type") == "bot_event"]


def event_types(events):
    return [m["event"] for m in bot_events(events)]


def start(eng, uid, **overrides):
    cfg = dict(market_category="Crypto", assets=["BTC-USD"], allocated_capital=10000.0,
               target_profit=500.0, max_loss=300.0, leverage=1)
    cfg.update(overrides)
    return run(eng.start_session(uid, cfg))


def scan(eng, sid):
    """One scan exactly as backend/botsched drives it."""
    async def go():
        begin = await eng.begin_scan(sid)
        results = []
        for sym in begin["assets"]:
            a = await eng.analyze(sym)
            ev = await eng.evaluate(sid, sym, a["analysis_id"])
            results.append(ev)
            if not ev["continue"]:
                break
        await eng.complete_scan(sid)
        return begin, results
    return run(go())


def session_row(sid):
    return db.get_bot_session(sid)


def bot_trades(sid, status=None):
    return db.get_bot_session_trades(sid, status)


def start_payload(uid, **overrides):
    body = dict(user_id=uid, market_category="Crypto", assets=["BTC-USD", "ETH-USD"],
                allocated_capital=10000, target_profit=500, max_loss=300, leverage=2)
    body.update(overrides)
    return body


# ---------------------------------------------------------------------------
# 1-6: session creation and validation
# ---------------------------------------------------------------------------

def test_start_creates_session_without_reserving_capital(client):
    uid = new_user("alice")
    res = client.post("/api/bot/session/start", json=start_payload(uid))
    assert res.status_code == 200, res.text
    s = res.json()["session"]
    assert s["status"] == "STARTING" and s["is_live"] and s["entries_allowed"]
    assert s["allocated_capital"] == 10000 and s["used_capital"] == 0 and s["available_bot_capital"] == 10000
    assert s["assets"] == ["BTC-USD", "ETH-USD"] and s["leverage"] == 2
    assert db.get_user_balance(uid) == 1_000_000.0  # configuration never deducts capital
    cfg = client.get(f"/api/bot-config?user_id={uid}").json()["config"]
    assert cfg["market_category"] == "Crypto" and cfg["leverage"] == 2 and cfg["is_active"] is True


@pytest.mark.parametrize("assets", [["DOGE-XYZ"], ["AAPL"], []])
def test_invalid_asset_rejected(client, assets):
    uid = new_user("bob")
    res = client.post("/api/bot/session/start", json=start_payload(uid, assets=assets))
    assert res.status_code == 400
    assert db.get_live_bot_session(uid) is None


@pytest.mark.parametrize("market", ["Commodities", "Options", ""])
def test_unsupported_market_rejected(client, market):
    uid = new_user("carol")
    res = client.post("/api/bot/session/start", json=start_payload(uid, market_category=market))
    assert res.status_code == 400
    assert "support" in res.json()["detail"].lower()


def test_capital_above_balance_rejected(client):
    uid = new_user("dave", balance=5000.0)
    res = client.post("/api/bot/session/start", json=start_payload(uid, allocated_capital=5000.01))
    assert res.status_code == 400 and "exceeds available balance" in res.json()["detail"]
    # The database layer enforces it too, inside the insert transaction.
    with pytest.raises(ValueError):
        db.create_bot_session(uid, "Crypto", ["BTC-USD"], 6000, 100, 100, 1)


@pytest.mark.parametrize("lev", [7, 2.5, 0, -1, 100])
def test_invalid_leverage_rejected(client, lev):
    uid = new_user("erin")
    res = client.post("/api/bot/session/start", json=start_payload(uid, leverage=lev))
    assert res.status_code == 400


@pytest.mark.parametrize("field,value", [("allocated_capital", 0), ("target_profit", -5), ("max_loss", 0)])
def test_non_positive_limits_rejected(client, field, value):
    uid = new_user("frank")
    assert client.post("/api/bot/session/start", json=start_payload(uid, **{field: value})).status_code == 400


def test_bot_cannot_start_twice(client):
    uid = new_user("gina")
    assert client.post("/api/bot/session/start", json=start_payload(uid)).status_code == 200
    second = client.post("/api/bot/session/start", json=start_payload(uid))
    assert second.status_code == 409


def test_concurrent_starts_create_exactly_one_session(app_env):
    uid = new_user("hank")
    outcomes = []

    def attempt():
        try:
            db.create_bot_session(uid, "Crypto", ["BTC-USD"], 1000, 100, 100, 1)
            outcomes.append("ok")
        except db.BotSessionConflictError:
            outcomes.append("conflict")

    threads = [threading.Thread(target=attempt) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert outcomes.count("ok") == 1 and outcomes.count("conflict") == 7


# ---------------------------------------------------------------------------
# 11-12: attribution
# ---------------------------------------------------------------------------

def test_autonomous_trade_is_attributed_to_its_session(app_env, engine):
    uid = new_user("ivy")
    sid = start(engine, uid, leverage=2)["id"]
    app_env.stances["BTC-USD"] = "BULLISH"
    begin, results = scan(engine, sid)
    assert begin["proceed"] and results[0]["outcome"] == "opened"

    [trade] = bot_trades(sid)
    assert trade["source"] == "bot" and trade["bot_session_id"] == sid
    assert trade["type"] == "buy" and trade["leverage"] == 2 and trade["market"] == "Crypto"
    assert trade["sl"] > 0 and trade["target"] > trade["entry_price"]
    types = event_types(engine.events)
    for expected in ("SCAN_STARTED", "MARKET_DATA_UPDATED", "AGENTS_COMPLETED", "STRATEGIES_COMPLETED",
                     "RISK_EVALUATED", "OPPORTUNITY_EVALUATED", "DECISION_READY", "OPPORTUNITY_DETECTED",
                     "RISK_APPROVED", "TRADE_OPENED", "SCAN_COMPLETED"):
        assert expected in types, expected
    assert session_row(sid)["status"] == "TRADE_ACTIVE"
    # Existing portfolio events fire too, so the dashboard / Manage Trades refresh.
    assert {"trade_opened", "positions_updated", "wallet", "dashboard_summary"} <= {m["type"] for _, m in engine.events}


def test_no_opportunity_leaves_session_waiting(app_env, engine):
    uid = new_user("jack")
    sid = start(engine, uid)["id"]
    _, results = scan(engine, sid)  # NEUTRAL stance
    assert results[0]["outcome"] == "no_opportunity"
    assert bot_trades(sid) == [] and session_row(sid)["status"] == "WAITING"
    assert "NO_OPPORTUNITY" in event_types(engine.events)


def test_manual_trade_is_not_counted_as_bot_trade(app_env, engine, client):
    uid = new_user("kate")
    sid = start(engine, uid)["id"]
    res = client.post("/api/trade/open", json={"user_id": uid, "symbol": "BTC-USD", "side": "BUY", "quantity": 1})
    assert res.status_code == 200, res.text
    manual_id = res.json()["trade_id"]
    assert db.get_trade(manual_id)["source"] == "manual" and db.get_trade(manual_id)["bot_session_id"] is None

    agg = db.get_bot_session_aggregates(sid)
    assert agg["total_trades"] == 0 and agg["used_capital"] == 0
    snap = run(engine.snapshot(session_row(sid)))
    assert snap["active_trades"] == [] and snap["open_trades"] == 0

    client.post(f"/api/trades/{manual_id}/close/full?user_id={uid}")
    assert client.get(f"/api/trades/history?user_id={uid}&source=bot").json()["total"] == 0
    assert client.get(f"/api/trades/history?user_id={uid}&source=manual").json()["total"] == 1


# ---------------------------------------------------------------------------
# 7-10: stop, target, max loss, allocation
# ---------------------------------------------------------------------------

def test_stop_prevents_new_trades_and_keeps_positions(app_env, engine):
    uid = new_user("liam")
    sid = start(engine, uid, assets=["BTC-USD", "ETH-USD"])["id"]
    app_env.stances["BTC-USD"] = "BULLISH"
    scan(engine, sid)
    assert len(bot_trades(sid, "open")) == 1

    snap = run(engine.stop_session(uid))  # no scheduler heartbeat -> finalized immediately
    assert snap["status"] == "STOPPED" and snap["stopped_at"]
    assert len(bot_trades(sid, "open")) == 1  # stopping never closes positions

    app_env.stances["ETH-USD"] = "BULLISH"
    begin, _ = scan(engine, sid)
    assert begin["proceed"] is False and len(bot_trades(sid)) == 1
    trade_id, reason = db.open_active_trade_atomic(uid, "ETH-USD", "buy", 1, 50, 1, 0, 0, "Crypto", "bot", sid)
    assert trade_id is None and "no longer opens new trades" in reason
    with pytest.raises(LookupError):
        run(engine.stop_session(uid))  # stopping an already-stopped bot


def test_graceful_stop_with_scheduler_online(app_env, engine):
    uid = new_user("mia")
    sid = start(engine, uid)["id"]
    engine.heartbeat("go-scheduler-test", 30)  # the Go scheduler holds the lease
    assert run(engine.stop_session(uid))["status"] == "STOPPING"

    app_env.stances["BTC-USD"] = "BULLISH"
    a = run(engine.analyze("BTC-USD"))
    assert run(engine.evaluate(sid, "BTC-USD", a["analysis_id"]))["continue"] is False
    mon = run(engine.monitor(sid))
    assert mon["stop_requested"] is True and mon["entries_allowed"] is False
    assert run(engine.finalize_stop(sid))["status"] == "STOPPED"
    assert bot_trades(sid) == []


def test_target_reached_stops_new_entries(app_env, engine, client):
    uid = new_user("noah")
    sid = start(engine, uid, target_profit=100.0, max_loss=10_000.0, assets=["BTC-USD", "ETH-USD"])["id"]
    app_env.stances["BTC-USD"] = "BULLISH"
    scan(engine, sid)
    [trade] = bot_trades(sid, "open")

    app_env.prices["BTC-USD"] = 102.0  # +2 * ~50.25 units = ~100.5 realized
    res = client.post(f"/api/trades/{trade['id']}/close/full?user_id={uid}")
    assert res.status_code == 200, res.text

    s = session_row(sid)
    assert s["status"] == "TARGET_REACHED" and s["stopped_at"]
    assert db.get_bot_session_aggregates(sid)["realized_pnl"] >= 100.0
    assert "TARGET_REACHED" in event_types(app_env.published)

    app_env.stances["ETH-USD"] = "BULLISH"
    begin, _ = scan(engine, sid)
    assert begin["proceed"] is False and bot_trades(sid, "open") == []
    tid, reason = db.open_active_trade_atomic(uid, "ETH-USD", "buy", 1, 50, 1, 0, 0, "Crypto", "bot", sid)
    assert tid is None


def test_target_reached_while_trade_in_flight_is_refused_by_database(app_env):
    uid = new_user("olga")
    s = db.create_bot_session(uid, "Crypto", ["BTC-USD", "ETH-USD"], 10000, 50, 1000, 1)
    tid, _ = db.open_active_trade_atomic(uid, "BTC-USD", "buy", 10, 100, 1, 0, 0, "Crypto", "bot", s["id"])
    db.fully_close_position(tid, uid, 110.0)  # realized +100 >= target 50, before any worker noticed
    refused, reason = db.open_active_trade_atomic(uid, "ETH-USD", "buy", 1, 50, 1, 0, 0, "Crypto", "bot", s["id"])
    assert refused is None and "target profit" in reason


def test_max_loss_reached_stops_new_entries(app_env, engine):
    uid = new_user("paul")
    sid = start(engine, uid, target_profit=10_000.0, max_loss=50.0, assets=["BTC-USD", "ETH-USD"])["id"]
    app_env.stances["BTC-USD"] = "BULLISH"
    scan(engine, sid)
    assert len(bot_trades(sid, "open")) == 1

    app_env.prices["BTC-USD"] = 99.0  # unrealized ~ -50.25, above the stop at ~98.01
    main.valkey_service.invalidate_user_cache(uid)
    mon = run(engine.monitor(sid))
    assert mon["entries_allowed"] is False
    assert session_row(sid)["status"] == "MAX_LOSS_REACHED"
    assert "MAX_LOSS_REACHED" in event_types(engine.events)
    assert len(bot_trades(sid, "open")) == 1  # the position is not force-closed

    app_env.stances["ETH-USD"] = "BULLISH"
    begin, _ = scan(engine, sid)
    assert begin["proceed"] is False


def test_max_loss_realized_basis_ignores_open_drawdown(app_env):
    eng = BotEngine(publish=None, analyzer=app_env.analyzer, price_fn=app_env.price,
                    policy=BotPolicy(max_loss_basis="realized"))
    uid = new_user("quinn")
    sid = start(eng, uid, target_profit=10_000.0, max_loss=50.0)["id"]
    app_env.stances["BTC-USD"] = "BULLISH"
    scan(eng, sid)
    app_env.prices["BTC-USD"] = 99.0
    main.valkey_service.invalidate_user_cache(uid)
    run(eng.monitor(sid))
    assert session_row(sid)["status"] == "TRADE_ACTIVE"


def test_allocated_capital_is_never_exceeded(app_env, engine):
    uid = new_user("rosa")
    sid = start(engine, uid, allocated_capital=1000.0, assets=["BTC-USD", "ETH-USD", "SOL-USD"])["id"]
    for sym in ("BTC-USD", "ETH-USD", "SOL-USD"):
        app_env.stances[sym] = "BULLISH"
    scan(engine, sid)
    agg = db.get_bot_session_aggregates(sid)
    assert agg["open_trades"] >= 2
    assert agg["used_capital"] <= 1000.0 + 1e-6
    assert db.get_user_balance(uid) == pytest.approx(1_000_000.0 - agg["used_capital"])


def test_concurrent_entries_cannot_exceed_allocation(app_env):
    uid = new_user("sam")
    s = db.create_bot_session(uid, "Crypto", ["X"], 1000, 10_000, 10_000, 1)
    results = []

    def attempt(i):
        tid, _ = db.open_active_trade_atomic(uid, f"SYM{i}", "buy", 3, 100, 1, 0, 0, "Crypto", "bot", s["id"])
        results.append(tid)

    threads = [threading.Thread(target=attempt, args=(i,)) for i in range(10)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sum(1 for r in results if r) == 3  # 3 x 300 margin fits in 1000; a 4th would not
    assert db.get_bot_session_aggregates(s["id"])["used_capital"] == pytest.approx(900.0)


def test_one_open_position_per_asset_per_session(app_env):
    uid = new_user("tara")
    s = db.create_bot_session(uid, "Crypto", ["BTC-USD"], 10_000, 10_000, 10_000, 1)
    first, _ = db.open_active_trade_atomic(uid, "BTC-USD", "buy", 1, 100, 1, 0, 0, "Crypto", "bot", s["id"])
    dup, reason = db.open_active_trade_atomic(uid, "BTC-USD", "buy", 1, 100, 1, 0, 0, "Crypto", "bot", s["id"])
    assert first and dup is None and "already holds" in reason


def test_risk_guard_rejects_critical_market_risk(app_env, engine):
    uid = new_user("uma")
    sid = start(engine, uid)["id"]

    async def critical(symbol):
        return make_analysis(symbol, "BULLISH", price=100.0, risk_level="CRITICAL")
    engine.analyzer = critical
    _, results = scan(engine, sid)
    assert results[0]["outcome"] == "rejected" and bot_trades(sid) == []
    assert "RISK_REJECTED" in event_types(engine.events)


def test_gate_is_deterministic_and_reports_each_check():
    t0 = time.perf_counter()
    risk = risk_guard._create_fatal_result("BTC-USD", "1d", "now", "x", t0).model_copy(
        update={"risk_level": RiskLevel.LOW, "status": RiskStatus.READY, "risk_score": 10.0})
    decision = decision_engine._create_fatal_result("BTC-USD", "1d", "now", "x", t0).model_copy(
        update={"decision": MarketStance.BULLISH, "decision_clarity": DecisionClarity.CLEAR})
    opp = opportunity_engine._create_fatal_result("BTC-USD", "1d", "now", "x", t0).model_copy(
        update={"opportunity_level": OpportunityLevel.HIGH})
    args = dict(symbol="BTC-USD", session_status="SCANNING", entry_statuses=ENTRY_STATES, target_profit=100,
                max_loss=100, realized_pnl=0, loss_basis_pnl=0, allocated_capital=1000, used_capital=0,
                has_open_position=False, risk_result=risk, decision=decision, opportunity=opp,
                blocked_risk_levels=("CRITICAL",), min_decision_clarity="MODERATE", min_opportunity_level="MODERATE")
    assert risk_guard.evaluate_bot_trade_gate(**args).approved
    hit = risk_guard.evaluate_bot_trade_gate(**{**args, "realized_pnl": 100})
    assert not hit.approved and hit.limit_breached == "TARGET_REACHED"
    loss = risk_guard.evaluate_bot_trade_gate(**{**args, "loss_basis_pnl": -100})
    assert loss.limit_breached == "MAX_LOSS_REACHED"
    full = risk_guard.evaluate_bot_trade_gate(**{**args, "used_capital": 1000})
    assert not full.approved and full.limit_breached is None


# ---------------------------------------------------------------------------
# 13-14: manual closes of bot trades update session metrics
# ---------------------------------------------------------------------------

def test_partial_close_updates_session_metrics(app_env, engine, client):
    uid = new_user("vera")
    sid = start(engine, uid, target_profit=10_000.0)["id"]
    app_env.stances["BTC-USD"] = "BULLISH"
    scan(engine, sid)
    [trade] = bot_trades(sid, "open")
    before = db.get_bot_session_aggregates(sid)

    app_env.prices["BTC-USD"] = 102.0
    res = client.post(f"/api/trades/{trade['id']}/close", json={"user_id": uid, "percentage": 50})
    assert res.status_code == 200, res.text
    after = db.get_bot_session_aggregates(sid)
    assert after["open_trades"] == 1 and after["total_trades"] == 1
    assert after["used_capital"] == pytest.approx(before["used_capital"] / 2, rel=1e-3)
    assert after["realized_pnl"] == pytest.approx(2.0 * trade["quantity"] / 2, rel=1e-3)
    closed = [m for m in bot_events(app_env.published) if m["event"] == "TRADE_CLOSED"]
    assert closed and closed[-1]["data"]["action"] == "PARTIAL_CLOSE"


def test_full_close_updates_session_metrics(app_env, engine, client):
    uid = new_user("walt")
    sid = start(engine, uid, target_profit=10_000.0)["id"]
    app_env.stances["BTC-USD"] = "BULLISH"
    scan(engine, sid)
    [trade] = bot_trades(sid, "open")
    app_env.prices["BTC-USD"] = 101.0
    assert client.post(f"/api/trades/{trade['id']}/close/full?user_id={uid}").status_code == 200
    agg = db.get_bot_session_aggregates(sid)
    assert agg["open_trades"] == 0 and agg["used_capital"] == 0
    assert agg["winning_trades"] == 1 and agg["losing_trades"] == 0
    assert agg["realized_pnl"] == pytest.approx(trade["quantity"] * 1.0, rel=1e-6)
    history = client.get(f"/api/trades/history?user_id={uid}&source=bot").json()
    assert history["total"] == 1 and history["trades"][0]["bot_session_id"] == sid


def test_protective_exit_keeps_running_after_stop(app_env, engine):
    uid = new_user("xena")
    sid = start(engine, uid, target_profit=10_000.0)["id"]
    app_env.stances["BTC-USD"] = "BULLISH"
    scan(engine, sid)
    [trade] = bot_trades(sid, "open")
    run(engine.stop_session(uid))

    app_env.prices["BTC-USD"] = trade["target"] + 0.5  # the position's own take-profit
    mon = run(engine.monitor(sid))
    closed = db.get_trade(trade["id"])
    assert closed["status"] == "closed" and closed["outcome"] == "target"
    assert mon["done"] is True and session_row(sid)["status"] == "STOPPED"
    assert "TRADE_CLOSED" in event_types(engine.events)


def test_supervision_does_not_claim_a_concurrent_manual_close(app_env, engine, client):
    uid = new_user("ivan")
    sid = start(engine, uid, target_profit=10_000.0)["id"]
    app_env.stances["BTC-USD"] = "BULLISH"
    scan(engine, sid)
    rows = bot_trades(sid, "open")  # a monitor tick reads the open trades...
    assert client.post(f"/api/trades/{rows[0]['id']}/close/full?user_id={uid}").status_code == 200  # ...the user closes
    engine.events.clear()
    run(engine._supervise_positions(session_row(sid), rows))
    assert "TRADE_CLOSED" not in event_types(engine.events)


def test_other_users_cannot_see_or_control_a_session(app_env, engine, client):
    owner, intruder = new_user("yuri"), new_user("zoe")
    sid = start(engine, owner)["id"]
    app_env.stances["BTC-USD"] = "BULLISH"
    scan(engine, sid)
    [trade] = bot_trades(sid, "open")
    for path in (f"/api/bot/session/{sid}", f"/api/bot/session/{sid}/trades", f"/api/bot/session/{sid}/activity"):
        assert client.get(f"{path}?user_id={intruder}").status_code == 404
    assert client.post("/api/bot/session/stop", json={"user_id": intruder}).status_code == 409
    assert client.post(f"/api/trades/{trade['id']}/close", json={"user_id": intruder, "percentage": 100}).status_code == 404
    assert session_row(sid)["status"] == "TRADE_ACTIVE"
    tid, reason = db.open_active_trade_atomic(intruder, "ETH-USD", "buy", 1, 50, 1, 0, 0, "Crypto", "bot", sid)
    assert tid is None and "does not belong" in reason


# ---------------------------------------------------------------------------
# 15-17: WebSocket events, frontend independence, restart recovery
# ---------------------------------------------------------------------------

@asynccontextmanager
async def _no_lifespan(app):
    yield


def test_bot_events_stream_over_websocket(app_env, monkeypatch):
    monkeypatch.setattr(main.app.router, "lifespan_context", _no_lifespan)
    monkeypatch.setattr(main.bot_engine, "publish", main.publish_to_user)  # the real delivery path
    uid = new_user("abby")
    with GatewayClient(main.app) as c:
        with c.websocket_connect(f"/ws?user_id={uid}") as ws:
            initial = [ws.receive_json()["type"] for _ in range(4)]
            assert initial == ["wallet", "positions", "history_trades", "dashboard_summary"]
            assert c.post("/api/bot/session/start", json=start_payload(uid)).status_code == 200
            seen = {}
            for _ in range(12):
                msg = ws.receive_json()
                seen.setdefault(msg["type"], msg)
                if "bot_event" in seen and "bot_session_updated" in seen:
                    break
            assert seen["bot_event"]["event"] == "STATE_CHANGED"
            assert seen["bot_session_updated"]["data"]["status"] == "STARTING"


def test_bot_keeps_trading_after_the_browser_disconnects(app_env, client):
    uid = new_user("bert")
    with client.websocket_connect(f"/ws?user_id={uid}") as ws:
        ws.receive_json()
    sid = client.post("/api/bot/session/start", json=start_payload(uid, assets=["BTC-USD"])).json()["session"]["id"]
    app_env.stances["BTC-USD"] = "BULLISH"

    # Drive the engine through the same internal HTTP steps the Go scheduler uses.
    assert client.post("/internal/bot/scheduler/heartbeat", json={"owner": "go-1", "ttl_seconds": 15}, headers=TOKEN).json()["leader"]
    assert sid in [s["id"] for s in client.get("/internal/bot/scheduler/sessions", headers=TOKEN).json()["sessions"]]
    assert client.post(f"/internal/bot/sessions/{sid}/monitor", headers=TOKEN).json()["scan_due"] is True
    assert client.post(f"/internal/bot/sessions/{sid}/scan/begin", headers=TOKEN).json()["proceed"] is True
    aid = client.post("/internal/bot/analysis", json={"symbol": "BTC-USD"}, headers=TOKEN).json()["analysis_id"]
    ev = client.post(f"/internal/bot/sessions/{sid}/evaluate", json={"symbol": "BTC-USD", "analysis_id": aid}, headers=TOKEN).json()
    client.post(f"/internal/bot/sessions/{sid}/scan/complete", headers=TOKEN)
    assert ev["outcome"] == "opened"
    assert session_row(sid)["status"] == "TRADE_ACTIVE" and len(bot_trades(sid, "open")) == 1


def test_session_recovers_after_service_restart(app_env, engine):
    uid = new_user("cleo")
    sid = start(engine, uid)["id"]
    run(engine.begin_scan(sid))  # the old process died mid-scan
    assert session_row(sid)["status"] == "SCANNING"

    fresh = BotEngine(publish=engine.publish, analyzer=app_env.analyzer, price_fn=app_env.price,
                      policy=BotPolicy(scan_interval_seconds=60.0))
    fresh.events = engine.events
    assert sid in [s["id"] for s in run(fresh.scheduler_sessions())]
    run(fresh.attach(sid, recovered=True))
    assert "SESSION_RECOVERED" in event_types(engine.events)
    assert run(fresh.monitor(sid))["scan_due"] is True
    app_env.stances["BTC-USD"] = "BULLISH"
    _, results = scan(fresh, sid)
    assert results[0]["outcome"] == "opened"

    other = new_user("dora")
    sid2 = start(fresh, other)["id"]
    db.transition_bot_session(sid2, "STOPPING", db.BOT_ENTRY_STATUSES)  # stop requested before the crash
    assert run(fresh.monitor(sid2))["stop_requested"] is True
    assert run(fresh.finalize_stop(sid2))["status"] == "STOPPED"


def test_activity_is_persisted_for_the_session(app_env, engine, client):
    uid = new_user("eden")
    sid = start(engine, uid)["id"]
    scan(engine, sid)
    events = client.get(f"/api/bot/session/{sid}/activity?user_id={uid}").json()["events"]
    assert events and events[0]["session_id"] == sid
    assert {"SCAN_STARTED", "DECISION_READY", "NO_OPPORTUNITY"} <= {e["event"] for e in events}


def test_session_history_derives_metrics_from_trades(app_env, engine, client):
    uid = new_user("fern")
    sid = start(engine, uid, target_profit=10_000.0)["id"]
    app_env.stances["BTC-USD"] = "BULLISH"
    scan(engine, sid)
    [trade] = bot_trades(sid, "open")
    client.post(f"/api/trades/{trade['id']}/close/full?user_id={uid}")
    run(engine.stop_session(uid))
    hist = client.get(f"/api/bot/session/history?user_id={uid}").json()
    assert hist["total"] == 1
    row = hist["sessions"][0]
    assert row["status"] == "STOPPED" and row["total_trades"] == 1 and row["stopped_at"]
    assert row["allocated_capital"] == 10000 and row["assets"] == ["BTC-USD"]


# ---------------------------------------------------------------------------
# Compatibility, security, regressions, structure
# ---------------------------------------------------------------------------

def test_legacy_bot_config_toggle_uses_the_session_lifecycle(client):
    uid = new_user("gus")
    legacy = {"user_id": uid, "assets": "BTC-USD,ETH-USD", "total_capital": 10000, "max_risk_per_trade": 300,
              "min_profit_target": 500, "max_profit_target": 300, "is_active": True}
    res = client.post("/api/bot-config", json=legacy)
    assert res.status_code == 200 and res.json()["session"]["status"] == "STARTING"
    assert client.get(f"/api/bot-config?user_id={uid}").json()["config"]["is_active"] is True
    res = client.post("/api/bot-config", json={**legacy, "is_active": False})
    assert res.status_code == 200 and res.json()["session"]["status"] == "STOPPED"
    too_much = client.post("/api/bot-config", json={**legacy, "total_capital": 5_000_000, "is_active": None})
    assert too_much.status_code == 400


def test_internal_endpoints_require_the_shared_token(client):
    body = {"owner": "x", "ttl_seconds": 15}
    assert client.post("/internal/bot/scheduler/heartbeat", json=body).status_code == 403
    assert client.post("/internal/bot/scheduler/heartbeat", json=body,
                       headers={"X-Orbit-Internal-Token": "wrong"}).status_code == 403
    assert client.post("/internal/bot/scheduler/heartbeat", json=body,
                       headers={**TOKEN, "Origin": "http://evil.example"}).status_code == 403
    ok = client.post("/internal/bot/scheduler/heartbeat", json=body, headers=TOKEN)
    assert ok.status_code == 200 and ok.json()["leader"] is True and ok.json()["config"]["tick_seconds"] > 0
    # A second scheduler instance does not get the lease while the first holds it.
    assert client.post("/internal/bot/scheduler/heartbeat", json={"owner": "y", "ttl_seconds": 15},
                       headers=TOKEN).json()["leader"] is False


def test_pnl_manager_ignores_unset_stop_and_target(app_env, client):
    from agents.portfolio_monitor import monitor_positions
    uid = new_user("hugo")
    tid = client.post("/api/trade/open", json={"user_id": uid, "symbol": "BTC-USD", "side": "BUY", "quantity": 1}).json()["trade_id"]
    monitor_positions(101.0, None, uid, "BTC-USD")
    assert db.get_trade(tid)["status"] == "active"  # used to close at price 0


def test_state_constants_match_the_enum():
    assert set(db.BOT_ENTRY_STATUSES) == {s.value for s in ENTRY_STATES}
    assert set(db.BOT_LIVE_STATUSES) == {s.value for s in LIVE_STATES}
    assert set(db.BOT_TERMINAL_STATUSES) == {s.value for s in TERMINAL_STATES}

