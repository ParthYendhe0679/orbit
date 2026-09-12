"""
strategy_lab/store.py - persistence for saved strategies and backtest runs.

Uses the project's existing database layer (database.get_connection and its
PostgreSQL pool / SQLite fallback). It adds three tables of its own and
touches no existing table, so the live trading schema is unchanged.

Ownership is not optional: every table carries user_id, every read filters on
it, and the id comes from the Go gateway's verified identity - never from the
request body. There is no code path here that can return row belonging to
another account.

The schema is created lazily on first use rather than inside database.init_db(),
so a problem in the Strategy Lab can never stop the rest of ORBIT from booting.
"""

import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import database as db

logger = logging.getLogger("orbit.strategy_lab.store")

_schema_lock = threading.Lock()
_schema_ready = False

# A stored equity curve is already downsampled; this is a backstop against a
# pathological payload filling a row.
MAX_STORED_TRADES = 2000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ph() -> str:
    return db.get_placeholder()


def ensure_schema() -> None:
    """Create the Strategy Lab tables once per process."""
    global _schema_ready
    if _schema_ready:
        return
    with _schema_lock:
        if _schema_ready:
            return
        conn = db.get_connection()
        try:
            cursor = conn.cursor()
            if db.IS_POSTGRES:
                cursor.execute("""
                CREATE TABLE IF NOT EXISTS strategy_lab_strategies (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
                    name VARCHAR(160) NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    definition TEXT NOT NULL,
                    market VARCHAR(40),
                    symbol VARCHAR(60),
                    timeframe VARCHAR(10),
                    created_at VARCHAR(50) NOT NULL,
                    updated_at VARCHAR(50) NOT NULL
                )
                """)
                cursor.execute("""
                CREATE TABLE IF NOT EXISTS strategy_lab_backtests (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
                    strategy_id INTEGER REFERENCES strategy_lab_strategies(id) ON DELETE SET NULL,
                    strategy_name VARCHAR(160) NOT NULL DEFAULT '',
                    definition TEXT NOT NULL,
                    market VARCHAR(40),
                    symbol VARCHAR(60) NOT NULL,
                    timeframe VARCHAR(10) NOT NULL,
                    start_date VARCHAR(50),
                    end_date VARCHAR(50),
                    initial_capital DOUBLE PRECISION NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'completed',
                    error TEXT,
                    metrics TEXT NOT NULL DEFAULT '{}',
                    equity_curve TEXT NOT NULL DEFAULT '[]',
                    data_meta TEXT NOT NULL DEFAULT '{}',
                    execution_model TEXT NOT NULL DEFAULT '{}',
                    created_at VARCHAR(50) NOT NULL,
                    completed_at VARCHAR(50)
                )
                """)
                cursor.execute("""
                CREATE TABLE IF NOT EXISTS strategy_lab_backtest_trades (
                    id SERIAL PRIMARY KEY,
                    backtest_id INTEGER NOT NULL REFERENCES strategy_lab_backtests(id) ON DELETE CASCADE,
                    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
                    trade_seq INTEGER NOT NULL,
                    symbol VARCHAR(60) NOT NULL,
                    side VARCHAR(10) NOT NULL,
                    entry_time VARCHAR(50),
                    exit_time VARCHAR(50),
                    entry_price DOUBLE PRECISION,
                    exit_price DOUBLE PRECISION,
                    quantity DOUBLE PRECISION,
                    pnl DOUBLE PRECISION,
                    pnl_percent DOUBLE PRECISION,
                    exit_reason VARCHAR(30)
                )
                """)
                cursor.execute(
                    "CREATE INDEX IF NOT EXISTS idx_sl_backtests_user "
                    "ON strategy_lab_backtests (user_id, id DESC)"
                )
                cursor.execute(
                    "CREATE INDEX IF NOT EXISTS idx_sl_trades_backtest "
                    "ON strategy_lab_backtest_trades (backtest_id)"
                )
            else:
                cursor.execute("""
                CREATE TABLE IF NOT EXISTS strategy_lab_strategies (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    definition TEXT NOT NULL,
                    market TEXT,
                    symbol TEXT,
                    timeframe TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """)
                cursor.execute("""
                CREATE TABLE IF NOT EXISTS strategy_lab_backtests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    strategy_id INTEGER,
                    strategy_name TEXT NOT NULL DEFAULT '',
                    definition TEXT NOT NULL,
                    market TEXT,
                    symbol TEXT NOT NULL,
                    timeframe TEXT NOT NULL,
                    start_date TEXT,
                    end_date TEXT,
                    initial_capital REAL NOT NULL,
                    status TEXT NOT NULL DEFAULT 'completed',
                    error TEXT,
                    metrics TEXT NOT NULL DEFAULT '{}',
                    equity_curve TEXT NOT NULL DEFAULT '[]',
                    data_meta TEXT NOT NULL DEFAULT '{}',
                    execution_model TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    completed_at TEXT
                )
                """)
                cursor.execute("""
                CREATE TABLE IF NOT EXISTS strategy_lab_backtest_trades (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    backtest_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    trade_seq INTEGER NOT NULL,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    entry_time TEXT,
                    exit_time TEXT,
                    entry_price REAL,
                    exit_price REAL,
                    quantity REAL,
                    pnl REAL,
                    pnl_percent REAL,
                    exit_reason TEXT
                )
                """)
                cursor.execute(
                    "CREATE INDEX IF NOT EXISTS idx_sl_backtests_user "
                    "ON strategy_lab_backtests (user_id, id DESC)"
                )
                cursor.execute(
                    "CREATE INDEX IF NOT EXISTS idx_sl_trades_backtest "
                    "ON strategy_lab_backtest_trades (backtest_id)"
                )
            conn.commit()
            _schema_ready = True
            logger.info("Strategy Lab schema ready (%s).", "postgres" if db.IS_POSTGRES else "sqlite")
        finally:
            conn.close()


def _returning_id(cursor, conn, table: str) -> int:
    if db.IS_POSTGRES:
        row = cursor.fetchone()
        if isinstance(row, dict):
            return int(row["id"])
        return int(row[0])
    return int(cursor.lastrowid)


def _loads(value: Any, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return default


def _row_to_dict(row: Any, columns: List[str]) -> Dict[str, Any]:
    """Normalize a row from either driver.

    psycopg2's RealDictCursor yields dicts and sqlite3.Row is mapping-like;
    a plain tuple cursor is matched against the SELECT's column order.
    """
    if isinstance(row, dict):
        return dict(row)
    if hasattr(row, "keys"):
        return {key: row[key] for key in row.keys()}
    return {columns[i]: row[i] for i in range(len(columns))}


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

_STRATEGY_COLUMNS = [
    "id", "user_id", "name", "description", "definition",
    "market", "symbol", "timeframe", "created_at", "updated_at",
]


def _strategy_out(raw: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": raw["id"],
        "name": raw["name"],
        "description": raw.get("description") or "",
        "definition": _loads(raw.get("definition"), {}),
        "market": raw.get("market"),
        "symbol": raw.get("symbol"),
        "timeframe": raw.get("timeframe"),
        "created_at": raw.get("created_at"),
        "updated_at": raw.get("updated_at"),
    }


def save_strategy(
    user_id: int,
    name: str,
    description: str,
    definition: Dict[str, Any],
    market: Optional[str],
    symbol: Optional[str],
    timeframe: Optional[str],
) -> Dict[str, Any]:
    ensure_schema()
    now = _now()
    ph = _ph()
    conn = db.get_connection()
    try:
        cursor = conn.cursor()
        sql = (
            "INSERT INTO strategy_lab_strategies "
            "(user_id, name, description, definition, market, symbol, timeframe, created_at, updated_at) "
            "VALUES (" + ", ".join([ph] * 9) + ")"
        )
        if db.IS_POSTGRES:
            sql += " RETURNING id"
        cursor.execute(sql, (
            int(user_id), name[:160], (description or "")[:4000], json.dumps(definition),
            market, symbol, timeframe, now, now,
        ))
        new_id = _returning_id(cursor, conn, "strategy_lab_strategies")
        conn.commit()
    finally:
        conn.close()
    return {
        "id": new_id, "name": name[:160], "description": description or "",
        "definition": definition, "market": market, "symbol": symbol,
        "timeframe": timeframe, "created_at": now, "updated_at": now,
    }


def list_strategies(user_id: int, limit: int = 50) -> List[Dict[str, Any]]:
    ensure_schema()
    ph = _ph()
    conn = db.get_connection()
    try:
        cursor = db.get_cursor(conn)
        cursor.execute(
            "SELECT " + ", ".join(_STRATEGY_COLUMNS) + " FROM strategy_lab_strategies "
            "WHERE user_id = " + ph + " ORDER BY id DESC LIMIT " + ph,
            (int(user_id), int(limit)),
        )
        rows = cursor.fetchall() or []
    finally:
        conn.close()
    return [_strategy_out(_row_to_dict(r, _STRATEGY_COLUMNS)) for r in rows]


def get_strategy(user_id: int, strategy_id: int) -> Optional[Dict[str, Any]]:
    """A strategy, only if this user owns it."""
    ensure_schema()
    ph = _ph()
    conn = db.get_connection()
    try:
        cursor = db.get_cursor(conn)
        cursor.execute(
            "SELECT " + ", ".join(_STRATEGY_COLUMNS) + " FROM strategy_lab_strategies "
            "WHERE id = " + ph + " AND user_id = " + ph,
            (int(strategy_id), int(user_id)),
        )
        row = cursor.fetchone()
    finally:
        conn.close()
    return _strategy_out(_row_to_dict(row, _STRATEGY_COLUMNS)) if row else None


def delete_strategy(user_id: int, strategy_id: int) -> bool:
    ensure_schema()
    ph = _ph()
    conn = db.get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM strategy_lab_strategies WHERE id = " + ph + " AND user_id = " + ph,
            (int(strategy_id), int(user_id)),
        )
        deleted = cursor.rowcount
        conn.commit()
    finally:
        conn.close()
    return bool(deleted)


# ---------------------------------------------------------------------------
# Backtests
# ---------------------------------------------------------------------------

_BACKTEST_COLUMNS = [
    "id", "user_id", "strategy_id", "strategy_name", "definition", "market", "symbol",
    "timeframe", "start_date", "end_date", "initial_capital", "status", "error",
    "metrics", "equity_curve", "data_meta", "execution_model", "created_at", "completed_at",
]

_TRADE_COLUMNS = [
    "id", "backtest_id", "user_id", "trade_seq", "symbol", "side", "entry_time", "exit_time",
    "entry_price", "exit_price", "quantity", "pnl", "pnl_percent", "exit_reason",
]


def _backtest_out(raw: Dict[str, Any], include_curve: bool = True) -> Dict[str, Any]:
    out = {
        "id": raw["id"],
        "strategy_id": raw.get("strategy_id"),
        "strategy_name": raw.get("strategy_name") or "",
        "definition": _loads(raw.get("definition"), {}),
        "market": raw.get("market"),
        "symbol": raw.get("symbol"),
        "timeframe": raw.get("timeframe"),
        "start_date": raw.get("start_date"),
        "end_date": raw.get("end_date"),
        "initial_capital": raw.get("initial_capital"),
        "status": raw.get("status"),
        "error": raw.get("error"),
        "metrics": _loads(raw.get("metrics"), {}),
        "data_meta": _loads(raw.get("data_meta"), {}),
        "execution_model": _loads(raw.get("execution_model"), {}),
        "created_at": raw.get("created_at"),
        "completed_at": raw.get("completed_at"),
    }
    if include_curve:
        out["equity_curve"] = _loads(raw.get("equity_curve"), [])
    return out


def save_backtest(
    user_id: int,
    strategy_id: Optional[int],
    strategy_name: str,
    definition: Dict[str, Any],
    market: Optional[str],
    symbol: str,
    timeframe: str,
    start_date: str,
    end_date: str,
    initial_capital: float,
    metrics: Dict[str, Any],
    equity_curve: List[Dict[str, Any]],
    trades: List[Dict[str, Any]],
    data_meta: Dict[str, Any],
    execution_model: Dict[str, Any],
) -> int:
    """Persist one completed backtest and its simulated trades."""
    ensure_schema()
    now = _now()
    ph = _ph()
    conn = db.get_connection()
    try:
        cursor = conn.cursor()
        sql = (
            "INSERT INTO strategy_lab_backtests (user_id, strategy_id, strategy_name, definition, "
            "market, symbol, timeframe, start_date, end_date, initial_capital, status, metrics, "
            "equity_curve, data_meta, execution_model, created_at, completed_at) "
            "VALUES (" + ", ".join([ph] * 17) + ")"
        )
        if db.IS_POSTGRES:
            sql += " RETURNING id"
        cursor.execute(sql, (
            int(user_id), strategy_id, (strategy_name or "")[:160], json.dumps(definition),
            market, symbol, timeframe, start_date, end_date, float(initial_capital),
            "completed", json.dumps(metrics), json.dumps(equity_curve),
            json.dumps(data_meta), json.dumps(execution_model), now, now,
        ))
        backtest_id = _returning_id(cursor, conn, "strategy_lab_backtests")

        rows = [
            (
                backtest_id, int(user_id), int(t.get("trade_id") or 0), t.get("symbol") or symbol,
                t.get("side") or "LONG", t.get("entry_time"), t.get("exit_time"),
                t.get("entry_price"), t.get("exit_price"), t.get("quantity"),
                t.get("pnl"), t.get("pnl_percent"), t.get("exit_reason"),
            )
            for t in trades[:MAX_STORED_TRADES]
        ]
        if rows:
            cursor.executemany(
                "INSERT INTO strategy_lab_backtest_trades (backtest_id, user_id, trade_seq, symbol, "
                "side, entry_time, exit_time, entry_price, exit_price, quantity, pnl, pnl_percent, "
                "exit_reason) VALUES (" + ", ".join([ph] * 13) + ")",
                rows,
            )
        conn.commit()
    finally:
        conn.close()
    return backtest_id


def list_backtests(user_id: int, limit: int = 30, strategy_id: Optional[int] = None) -> List[Dict[str, Any]]:
    """Backtest history for the signed-in user (without the equity curves)."""
    ensure_schema()
    ph = _ph()
    conn = db.get_connection()
    try:
        cursor = db.get_cursor(conn)
        sql = ("SELECT " + ", ".join(_BACKTEST_COLUMNS) + " FROM strategy_lab_backtests "
               "WHERE user_id = " + ph)
        params: List[Any] = [int(user_id)]
        if strategy_id is not None:
            sql += " AND strategy_id = " + ph
            params.append(int(strategy_id))
        sql += " ORDER BY id DESC LIMIT " + ph
        params.append(int(limit))
        cursor.execute(sql, tuple(params))
        rows = cursor.fetchall() or []
    finally:
        conn.close()
    return [_backtest_out(_row_to_dict(r, _BACKTEST_COLUMNS), include_curve=False) for r in rows]


def get_backtest(user_id: int, backtest_id: int) -> Optional[Dict[str, Any]]:
    """One backtest with its trades, only if this user owns it."""
    ensure_schema()
    ph = _ph()
    conn = db.get_connection()
    try:
        cursor = db.get_cursor(conn)
        cursor.execute(
            "SELECT " + ", ".join(_BACKTEST_COLUMNS) + " FROM strategy_lab_backtests "
            "WHERE id = " + ph + " AND user_id = " + ph,
            (int(backtest_id), int(user_id)),
        )
        row = cursor.fetchone()
        if not row:
            return None
        record = _backtest_out(_row_to_dict(row, _BACKTEST_COLUMNS))
        cursor.execute(
            "SELECT " + ", ".join(_TRADE_COLUMNS) + " FROM strategy_lab_backtest_trades "
            "WHERE backtest_id = " + ph + " AND user_id = " + ph + " ORDER BY trade_seq ASC",
            (int(backtest_id), int(user_id)),
        )
        trade_rows = cursor.fetchall() or []
    finally:
        conn.close()
    record["trades"] = [
        {
            "trade_id": t.get("trade_seq"),
            "symbol": t.get("symbol"),
            "side": t.get("side"),
            "entry_time": t.get("entry_time"),
            "exit_time": t.get("exit_time"),
            "entry_price": t.get("entry_price"),
            "exit_price": t.get("exit_price"),
            "quantity": t.get("quantity"),
            "pnl": t.get("pnl"),
            "pnl_percent": t.get("pnl_percent"),
            "exit_reason": t.get("exit_reason"),
        }
        for t in (_row_to_dict(r, _TRADE_COLUMNS) for r in trade_rows)
    ]
    return record


def delete_backtest(user_id: int, backtest_id: int) -> bool:
    ensure_schema()
    ph = _ph()
    conn = db.get_connection()
    try:
        cursor = conn.cursor()
        # Trades go first: SQLite does not enforce the cascade by default.
        cursor.execute(
            "DELETE FROM strategy_lab_backtest_trades WHERE backtest_id = " + ph + " AND user_id = " + ph,
            (int(backtest_id), int(user_id)),
        )
        cursor.execute(
            "DELETE FROM strategy_lab_backtests WHERE id = " + ph + " AND user_id = " + ph,
            (int(backtest_id), int(user_id)),
        )
        deleted = cursor.rowcount
        conn.commit()
    finally:
        conn.close()
    return bool(deleted)
