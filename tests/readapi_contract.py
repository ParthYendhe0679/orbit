"""
Shared fixture for the read-endpoint contract between the Python ai-service
and the Go gateway (backend/readapi).

seed() writes one deterministic portfolio through the ai-service's own
database layer (SQLite or PostgreSQL), capture() records the ai-service's
responses for it, and normalize() drops the fields that depend on the clock.
The captured responses become backend/readapi/testdata/python_golden.json,
which the Go tests compare against.
"""

import json
from pathlib import Path

GOLDEN_PATH = Path(__file__).resolve().parents[1] / "backend" / "readapi" / "testdata" / "python_golden.json"

PRICES = {"BTC-USD": 61234.5, "ETH-USD": 2950.25}
VOLATILE_KEYS = {"timestamp", "updated_at", "duration"}

HISTORY_QUERIES = [
    "", "limit=2&offset=1", "symbol=btc-usd", "market=stock", "side=SELL", "outcome=profit",
    "outcome=loss", "outcome=breakeven", "source=bot", "source=manual", "bot_session_id={session}",
    "limit=0", "symbol=%20",
]

_TRADE_COLUMNS = (
    "user_id", "asset", "type", "quantity", "original_quantity", "remaining_quantity", "leverage", "margin_used",
    "market", "entry_price", "current_price", "exit_price", "sl", "target", "pnl", "realized_pnl", "status",
    "outcome", "timestamp", "closed_at", "source", "bot_session_id",
)


def _insert(db, table, row):
    conn = db.get_connection()
    cur = db.get_cursor(conn)
    p = db.get_placeholder()
    cols = list(row)
    sql = f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join([p] * len(cols))})"
    if db.IS_POSTGRES:
        cur.execute(sql + " RETURNING id", tuple(row[c] for c in cols))
        new_id = cur.fetchone()["id"]
    else:
        cur.execute(sql, tuple(row[c] for c in cols))
        new_id = cur.lastrowid
    conn.commit()
    conn.close()
    return new_id


def _trade(db, **fields):
    row = {c: None for c in _TRADE_COLUMNS}
    row.update(fields)
    return _insert(db, "trades", row)


def seed(db):
    """Create the parity portfolio. Returns the ids the captures refer to."""
    alice = db.register_user("parity_alice", "parity_alice@example.com", "salt:hash")
    bob = db.register_user("parity_bob", "parity_bob@example.com", "salt:hash")
    carol = db.register_user("parity_carol", "parity_carol@example.com", "salt:hash")
    db.update_user_balance(alice, 812345.67 - db.get_user_balance(alice))

    ts = "2026-09-11T08:00:00.000000"
    session = _insert(db, "bot_sessions", {
        "user_id": alice, "status": "TRADE_ACTIVE", "market_category": "Crypto",
        "selected_assets": json.dumps(["BTC-USD", "ETH-USD"]), "allocated_capital": 25000.0,
        "target_profit": 800.0, "max_loss": 400.0, "leverage": 2.0, "scan_count": 3,
        "started_at": ts, "created_at": ts, "updated_at": ts,
    })
    _insert(db, "bot_config", {
        "user_id": alice, "assets": "btc-usd, ETH-USD ,", "total_capital": 25000.0, "max_risk_per_trade": 250.0,
        "min_profit_target": 800.0, "max_profit_target": 400.0, "is_active": False if db.IS_POSTGRES else 0,
        "market_category": "Crypto", "leverage": 2.0,
    })

    common = dict(user_id=alice, pnl=0.0, realized_pnl=0.0, source="manual", market="Crypto")
    # Open positions
    _trade(db, **common, asset="BTC-USD", type="buy", quantity=0.5, original_quantity=0.5, remaining_quantity=0.5,
           leverage=2.0, margin_used=15000.0, entry_price=60000.0, current_price=60000.0, sl=58000.0,
           target=65000.0, status="active", timestamp="2026-09-10T10:00:00.000000")
    _trade(db, **{**common, "source": "bot", "realized_pnl": 50.25}, asset="ETH-USD", type="sell", quantity=3.0,
           original_quantity=3.0, remaining_quantity=2.0, leverage=1.0, margin_used=0.0, entry_price=3000.0,
           current_price=3000.0, sl=0.0, target=0.0, status="active", bot_session_id=session,
           timestamp="2026-09-11T09:30:00.000000")
    # Active but fully closed out, and a pending order: neither is an open position.
    _trade(db, **common, asset="BTC-USD", type="buy", quantity=1.0, original_quantity=1.0, remaining_quantity=0.0,
           leverage=1.0, margin_used=0.0, entry_price=59000.0, current_price=59000.0, sl=0.0, target=0.0,
           status="active", timestamp="2026-09-05T10:00:00.000000")
    _trade(db, **common, asset="SOL-USD", type="buy", quantity=4.0, original_quantity=4.0, remaining_quantity=4.0,
           leverage=1.0, margin_used=560.0, entry_price=140.0, current_price=140.0, sl=130.0, target=160.0,
           status="pending", timestamp="2026-09-11T10:00:00.000000")
    # Closed trades
    _trade(db, **{**common, "pnl": 120.5, "realized_pnl": 120.5}, asset="BTC-USD", type="buy", quantity=0.1,
           original_quantity=0.1, remaining_quantity=0.0, leverage=1.0, margin_used=5900.0, entry_price=59000.0,
           current_price=61000.0, exit_price=61000.0, sl=57000.0, target=61000.0, status="closed", outcome="target",
           timestamp="2026-09-09T10:00:00.000000", closed_at="2026-09-09T12:00:00.000000")
    _trade(db, **{**common, "pnl": -40.0, "realized_pnl": -40.0, "source": None, "market": "Stock"}, asset="AAPL",
           type="sell", quantity=2.0, original_quantity=2.0, remaining_quantity=0.0, leverage=1.0, margin_used=400.0,
           entry_price=200.0, current_price=220.0, exit_price=220.0, sl=220.0, target=180.0, status="closed",
           outcome="sl", timestamp="2026-09-08T14:00:00.000000", closed_at="2026-09-08T15:00:00.000000")
    _trade(db, **common, asset="ETH-USD", type="buy", quantity=1.0, original_quantity=1.0, remaining_quantity=0.0,
           leverage=1.0, margin_used=0.0, entry_price=3100.0, current_price=3100.0, exit_price=3100.0, sl=0.0,
           target=0.0, status="closed", outcome="cancelled", timestamp="2026-09-07T09:00:00.000000",
           closed_at="2026-09-07T09:05:00.000000")
    _trade(db, **{**common, "pnl": 10.0}, asset="BTC-USD", type="buy", quantity=0.01, original_quantity=0.01,
           remaining_quantity=0.0, leverage=1.0, margin_used=590.0, entry_price=59000.0, current_price=60000.0,
           exit_price=60000.0, sl=0.0, target=0.0, status="closed", outcome="manual_close",
           timestamp="2026-09-06T08:00:00.000000")
    _trade(db, **{**common, "pnl": 15.75, "realized_pnl": 15.75, "source": "bot"}, asset="ETH-USD", type="sell",
           quantity=1.0, original_quantity=1.0, remaining_quantity=0.0, leverage=1.0, margin_used=3000.0,
           entry_price=3000.0, current_price=2984.25, exit_price=2984.25, sl=0.0, target=0.0, status="closed",
           outcome="manual_close", bot_session_id=session, timestamp="2026-09-11T10:30:00.000000",
           closed_at="2026-09-11T11:00:00.000000")
    # Another account's history must never leak in.
    _trade(db, **{**common, "user_id": bob, "pnl": 999.0, "realized_pnl": 999.0}, asset="BTC-USD", type="buy",
           quantity=1.0, original_quantity=1.0, remaining_quantity=0.0, leverage=1.0, margin_used=59000.0,
           entry_price=59000.0, current_price=60000.0, exit_price=60000.0, sl=0.0, target=0.0, status="closed",
           outcome="target", timestamp="2026-09-10T10:00:00.000000", closed_at="2026-09-10T11:00:00.000000")
    return {"alice": alice, "bob": bob, "carol": carol, "session": session}


def closed_stats(db, uid):
    """What PositionService derives from the closed trades (for the Go unit tests)."""
    closed = [t for t in db.get_all_trades(uid, "closed") if t.get("outcome") != "cancelled"]
    winning = sum(1 for t in closed if float(t.get("realized_pnl") or t.get("pnl") or 0.0) > 0)
    return {"realized_pnl": db.get_total_realized_pnl(uid), "closed_count": len(closed), "winning": winning}


def capture(client, db, ids):
    alice, bob, carol = ids["alice"], ids["bob"], ids["carol"]
    h = lambda uid: {"X-User-ID": str(uid)}  # noqa: E731

    def get(path, uid):
        res = client.get(path, headers=h(uid))
        assert res.status_code == 200, (path, res.status_code, res.text)
        return res.json()

    history = {}
    for q in HISTORY_QUERIES:
        q = q.format(session=ids["session"])
        history[q] = get(f"/api/trades/history?{q}" if q else "/api/trades/history", alice)

    return {
        "ids": ids,
        "prices": PRICES,
        "bot_live_statuses": list(db.BOT_LIVE_STATUSES),
        "rows": {
            "alice_balance": db.get_user_balance(alice),
            "alice_open_positions": db.get_open_positions(alice),
            "alice_closed_stats": closed_stats(db, alice),
            "alice_bot_config": db.get_bot_config(alice),
        },
        "responses": {
            "dashboard_summary": get("/api/dashboard/summary", alice),
            "trades_open": get("/api/trades/open", alice),
            "trades_history": history,
            "bot_config_alice": get("/api/bot-config", alice),
            "bot_config_carol_default": get("/api/bot-config", carol),
            "dashboard_summary_bob": get("/api/dashboard/summary", bob),
        },
    }


def normalize(value, drop=VOLATILE_KEYS):
    if isinstance(value, dict):
        return {k: normalize(v, drop) for k, v in value.items() if k not in drop}
    if isinstance(value, list):
        return [normalize(v, drop) for v in value]
    if isinstance(value, float) and value.is_integer():
        return int(value)  # JSON has one number type; 1.0 and 1 are the same value
    return value
