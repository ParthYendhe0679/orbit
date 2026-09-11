import json as _json
import os
import sqlite3
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

DB_PATH = os.path.join(os.path.dirname(__file__), "trading_sim.db")
DATABASE_URL = os.getenv("DATABASE_URL")
IS_POSTGRES = False

if DATABASE_URL and (DATABASE_URL.startswith("postgres://") or DATABASE_URL.startswith("postgresql://")):
    IS_POSTGRES = True

def get_connection():
    if IS_POSTGRES:
        import psycopg2
        last_err = None
        for attempt in range(3):
            try:
                conn = psycopg2.connect(DATABASE_URL, connect_timeout=4)
                return conn
            except Exception as e:
                last_err = e
                if attempt < 2:
                    time.sleep(0.3 * (attempt + 1))
        if last_err is not None:
            raise last_err
        raise ConnectionError("Failed to connect to PostgreSQL database after 3 attempts.")
    else:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        return conn

def get_cursor(conn):
    if IS_POSTGRES:
        import psycopg2.extras
        return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    else:
        return conn.cursor()

def get_placeholder():
    return "%s" if IS_POSTGRES else "?"

def get_user_table():
    return '"user"' if IS_POSTGRES else 'user'


def _for_update():
    """Row-lock suffix for SELECTs inside a read-check-write transaction (Postgres only)."""
    return " FOR UPDATE" if IS_POSTGRES else ""


def _begin_write(cursor):
    """
    Serialize a read-check-write sequence.

    SQLite has no row locks, so take the database write lock before the first
    read; Postgres relies on the FOR UPDATE row locks taken by the SELECTs.
    """
    if not IS_POSTGRES:
        cursor.execute("BEGIN IMMEDIATE")


# ---------------------------------------------------------------------------
# Auto-Trade Bot session states (mirrors backend.models.bot.BotSessionStatus)
# ---------------------------------------------------------------------------
# States in which a session scans and may open new trades.
BOT_ENTRY_STATUSES = ("STARTING", "SCANNING", "ANALYZING", "OPPORTUNITY_FOUND", "TRADE_ACTIVE", "WAITING")
# Every non-terminal state. At most one session per user may be in one of these.
BOT_LIVE_STATUSES = BOT_ENTRY_STATUSES + ("STOPPING",)
BOT_TERMINAL_STATUSES = ("STOPPED", "TARGET_REACHED", "MAX_LOSS_REACHED", "ERROR")


class BotSessionConflictError(Exception):
    """The user already has a live bot session."""


def _is_unique_violation(err: Exception) -> bool:
    if isinstance(err, sqlite3.IntegrityError):
        return "UNIQUE" in str(err).upper()
    return getattr(err, "pgcode", None) == "23505"

def init_db():
    conn = get_connection()
    # Use standard connection cursor for table creation (non-dict)
    cursor = conn.cursor()
    
    if IS_POSTGRES:
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS "user" (
            id SERIAL PRIMARY KEY,
            username VARCHAR(255) NOT NULL UNIQUE,
            email VARCHAR(255) UNIQUE,
            password_hash VARCHAR(255),
            is_verified BOOLEAN NOT NULL DEFAULT FALSE,
            balance DOUBLE PRECISION NOT NULL DEFAULT 1000000.0
        )
        """)
        # Migrate existing Postgres user table if columns are missing
        for col_name, col_type in [("email", "VARCHAR(255) UNIQUE"), ("password_hash", "VARCHAR(255)"), ("is_verified", "BOOLEAN NOT NULL DEFAULT FALSE"), ("clerk_id", "VARCHAR(255) UNIQUE")]:
            try:
                cursor.execute(f'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS {col_name} {col_type}')
            except Exception as e:
                print(f"Postgres column migration error for {col_name}: {e}")

        # One row per Auto-Trade Bot run. The session snapshots its own
        # configuration; P&L and trade counts are derived from the trades it
        # opened (trades.bot_session_id), never stored twice.
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS bot_sessions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
            status VARCHAR(30) NOT NULL DEFAULT 'STARTING',
            market_category VARCHAR(50) NOT NULL,
            selected_assets TEXT NOT NULL,
            allocated_capital DOUBLE PRECISION NOT NULL,
            target_profit DOUBLE PRECISION NOT NULL,
            max_loss DOUBLE PRECISION NOT NULL,
            leverage DOUBLE PRECISION NOT NULL DEFAULT 1.0,
            stop_reason VARCHAR(255),
            last_error TEXT,
            scan_count INTEGER NOT NULL DEFAULT 0,
            last_scan_at VARCHAR(50),
            started_at VARCHAR(50),
            stopped_at VARCHAR(50),
            created_at VARCHAR(50) NOT NULL,
            updated_at VARCHAR(50) NOT NULL
        )
        """)

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS trades (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES "user"(id) ON DELETE CASCADE,
            asset VARCHAR(50) NOT NULL,
            type VARCHAR(10) NOT NULL, -- buy / sell
            quantity DOUBLE PRECISION NOT NULL,
            entry_price DOUBLE PRECISION NOT NULL,
            current_price DOUBLE PRECISION NOT NULL,
            exit_price DOUBLE PRECISION,
            sl DOUBLE PRECISION NOT NULL,
            target DOUBLE PRECISION NOT NULL,
            pnl DOUBLE PRECISION DEFAULT 0.0,
            status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending / active / closed
            outcome VARCHAR(20), -- target / sl / stopped / cancelled / manual_close
            timestamp VARCHAR(50) NOT NULL
        )
        """)
        # Postgres migration for trade lifecycle columns
        for col_name, col_type in [
            ("leverage", "DOUBLE PRECISION DEFAULT 1.0"),
            ("margin_used", "DOUBLE PRECISION DEFAULT 0.0"),
            ("original_quantity", "DOUBLE PRECISION"),
            ("remaining_quantity", "DOUBLE PRECISION"),
            ("market", "VARCHAR(50) DEFAULT 'Crypto'"),
            ("realized_pnl", "DOUBLE PRECISION DEFAULT 0.0"),
            ("closed_at", "VARCHAR(50)"),
            ("source", "VARCHAR(20) DEFAULT 'manual'"),
            ("bot_session_id", "INTEGER REFERENCES bot_sessions(id) ON DELETE SET NULL")
        ]:
            try:
                cursor.execute(f'ALTER TABLE trades ADD COLUMN IF NOT EXISTS {col_name} {col_type}')
            except Exception as e:
                print(f"Postgres trade migration error for {col_name}: {e}")

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS trade_executions (
            id SERIAL PRIMARY KEY,
            position_id INTEGER REFERENCES trades(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES "user"(id) ON DELETE CASCADE,
            action VARCHAR(20) NOT NULL, -- OPEN, PARTIAL_CLOSE, FULL_CLOSE
            quantity DOUBLE PRECISION NOT NULL,
            price DOUBLE PRECISION NOT NULL,
            realized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0.0,
            timestamp VARCHAR(50) NOT NULL,
            metadata TEXT DEFAULT '{}'
        )
        """)
        
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS bot_config (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES "user"(id) ON DELETE CASCADE UNIQUE,
            assets TEXT NOT NULL DEFAULT 'BTC-USD,ETH-USD',
            total_capital DOUBLE PRECISION NOT NULL DEFAULT 10000.0,
            max_risk_per_trade DOUBLE PRECISION NOT NULL DEFAULT 100.0,
            min_profit_target DOUBLE PRECISION NOT NULL DEFAULT 200.0,
            max_profit_target DOUBLE PRECISION NOT NULL DEFAULT 1000.0,
            is_active BOOLEAN NOT NULL DEFAULT FALSE
        )
        """)
        for col_name, col_type in [("market_category", "VARCHAR(50) DEFAULT 'Crypto'"), ("leverage", "DOUBLE PRECISION DEFAULT 1.0")]:
            try:
                cursor.execute(f'ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS {col_name} {col_type}')
            except Exception as e:
                print(f"Postgres bot_config migration error for {col_name}: {e}")

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS conversations (
            id VARCHAR(100) PRIMARY KEY,
            user_id INTEGER REFERENCES "user"(id) ON DELETE CASCADE,
            title VARCHAR(255) NOT NULL,
            selected_asset VARCHAR(50) NOT NULL DEFAULT 'BTC-USD',
            selected_market VARCHAR(50) NOT NULL DEFAULT 'Crypto',
            created_at VARCHAR(50) NOT NULL,
            updated_at VARCHAR(50) NOT NULL
        )
        """)

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS chat_messages (
            id VARCHAR(100) PRIMARY KEY,
            conversation_id VARCHAR(100) REFERENCES conversations(id) ON DELETE CASCADE,
            role VARCHAR(20) NOT NULL,
            content TEXT NOT NULL,
            timestamp VARCHAR(50) NOT NULL,
            metadata TEXT DEFAULT '{}'
        )
        """)
    else:
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS user (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            email TEXT UNIQUE,
            password_hash TEXT,
            is_verified INTEGER NOT NULL DEFAULT 0,
            balance REAL NOT NULL DEFAULT 1000000.0
        )
        """)
        # Migrate existing SQLite user table if columns are missing
        cursor.execute("PRAGMA table_info(user)")
        user_cols = [col[1] for col in cursor.fetchall()]
        for col_def in [("email", "TEXT UNIQUE"), ("password_hash", "TEXT"), ("is_verified", "INTEGER NOT NULL DEFAULT 0"), ("clerk_id", "TEXT UNIQUE")]:
            if col_def[0] not in user_cols:
                try:
                    cursor.execute(f"ALTER TABLE user ADD COLUMN {col_def[0]} {col_def[1]}")
                except Exception:
                    pass
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS bot_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'STARTING',
            market_category TEXT NOT NULL,
            selected_assets TEXT NOT NULL,
            allocated_capital REAL NOT NULL,
            target_profit REAL NOT NULL,
            max_loss REAL NOT NULL,
            leverage REAL NOT NULL DEFAULT 1.0,
            stop_reason TEXT,
            last_error TEXT,
            scan_count INTEGER NOT NULL DEFAULT 0,
            last_scan_at TEXT,
            started_at TEXT,
            stopped_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        )
        """)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            asset TEXT NOT NULL,
            type TEXT NOT NULL, -- buy / sell
            quantity REAL NOT NULL,
            entry_price REAL NOT NULL,
            current_price REAL NOT NULL,
            exit_price REAL,
            sl REAL NOT NULL,
            target REAL NOT NULL,
            pnl REAL DEFAULT 0.0,
            status TEXT NOT NULL DEFAULT 'pending', -- pending / active / closed
            outcome TEXT, -- target / sl / stopped / cancelled / manual_close
            timestamp TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES user(id)
        )
        """)
        
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS bot_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER UNIQUE,
            assets TEXT NOT NULL DEFAULT 'BTC-USD,ETH-USD',
            total_capital REAL NOT NULL DEFAULT 10000.0,
            max_risk_per_trade REAL NOT NULL DEFAULT 100.0,
            min_profit_target REAL NOT NULL DEFAULT 200.0,
            max_profit_target REAL NOT NULL DEFAULT 1000.0,
            is_active INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(user_id) REFERENCES user(id)
        )
        """)

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            user_id INTEGER,
            title TEXT NOT NULL,
            selected_asset TEXT NOT NULL DEFAULT 'BTC-USD',
            selected_market TEXT NOT NULL DEFAULT 'Crypto',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES user(id)
        )
        """)

        cursor.execute("""
        CREATE TABLE IF NOT EXISTS chat_messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            metadata TEXT DEFAULT '{}',
            FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        )
        """)
        
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS trade_executions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            position_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            action TEXT NOT NULL, -- OPEN, PARTIAL_CLOSE, FULL_CLOSE
            quantity REAL NOT NULL,
            price REAL NOT NULL,
            realized_pnl REAL NOT NULL DEFAULT 0.0,
            timestamp TEXT NOT NULL,
            metadata TEXT DEFAULT '{}',
            FOREIGN KEY(position_id) REFERENCES trades(id) ON DELETE CASCADE,
            FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE
        )
        """)
        
        # SQLite schema migration to add missing columns to trades
        cursor.execute("PRAGMA table_info(trades)")
        columns = [col[1] for col in cursor.fetchall()]
        sqlite_trade_migrations = [
            ("user_id", "INTEGER"),
            ("leverage", "REAL DEFAULT 1.0"),
            ("margin_used", "REAL DEFAULT 0.0"),
            ("original_quantity", "REAL"),
            ("remaining_quantity", "REAL"),
            ("market", "TEXT DEFAULT 'Crypto'"),
            ("realized_pnl", "REAL DEFAULT 0.0"),
            ("closed_at", "TEXT"),
            ("source", "TEXT DEFAULT 'manual'"),
            ("bot_session_id", "INTEGER REFERENCES bot_sessions(id) ON DELETE SET NULL")
        ]
        for col_name, col_type in sqlite_trade_migrations:
            if col_name not in columns:
                try:
                    cursor.execute(f"ALTER TABLE trades ADD COLUMN {col_name} {col_type}")
                except Exception as e:
                    print(f"SQLite migration error for {col_name}: {e}")

        cursor.execute("PRAGMA table_info(bot_config)")
        bot_config_cols = [col[1] for col in cursor.fetchall()]
        for col_name, col_type in [("market_category", "TEXT DEFAULT 'Crypto'"), ("leverage", "REAL DEFAULT 1.0")]:
            if col_name not in bot_config_cols:
                try:
                    cursor.execute(f"ALTER TABLE bot_config ADD COLUMN {col_name} {col_type}")
                except Exception as e:
                    print(f"SQLite bot_config migration error for {col_name}: {e}")

    # Backfill legacy trades with default quantities and leverage if missing
    try:
        cursor.execute("UPDATE trades SET original_quantity = quantity WHERE original_quantity IS NULL")
        cursor.execute("UPDATE trades SET remaining_quantity = quantity WHERE remaining_quantity IS NULL AND status IN ('pending', 'active')")
        cursor.execute("UPDATE trades SET remaining_quantity = 0.0 WHERE remaining_quantity IS NULL AND status = 'closed'")
        cursor.execute("UPDATE trades SET leverage = 1.0 WHERE leverage IS NULL OR leverage <= 0")
        cursor.execute("UPDATE trades SET margin_used = (quantity * entry_price) WHERE margin_used IS NULL OR margin_used = 0.0")
        cursor.execute("UPDATE trades SET market = 'Crypto' WHERE market IS NULL")
        cursor.execute("UPDATE trades SET realized_pnl = pnl WHERE realized_pnl IS NULL AND status = 'closed'")
        cursor.execute("UPDATE trades SET source = 'manual' WHERE source IS NULL")
    except Exception as e:
        print(f"Backfill legacy trades error: {e}")

    # Auto-Trade Bot indexes. The partial unique index is what makes "one live
    # session per user" hold under concurrent start requests.
    live_list = ", ".join(f"'{s}'" for s in BOT_LIVE_STATUSES)
    for ddl in (
        "CREATE INDEX IF NOT EXISTS ix_trades_bot_session ON trades(bot_session_id)",
        "CREATE INDEX IF NOT EXISTS ix_bot_sessions_user ON bot_sessions(user_id)",
        f"CREATE UNIQUE INDEX IF NOT EXISTS ux_bot_sessions_one_live_per_user ON bot_sessions(user_id) WHERE status IN ({live_list})",
    ):
        try:
            cursor.execute(ddl)
        except Exception as e:
            print(f"Bot index migration error: {e}")
                
    # Initialize default user if not exists
    u = get_user_table()
    p = get_placeholder()
    
    cursor.execute(f"SELECT COUNT(*) FROM {u}")
    count = cursor.fetchone()[0]
    
    if count == 0:
        cursor.execute(f"INSERT INTO {u} (username, balance) VALUES ({p}, {p})", ("Trader Account", 1000000.0))
        
    conn.commit()
    conn.close()

def get_or_create_user(username):
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()
    
    cursor.execute(f"SELECT id, balance FROM {u} WHERE username = {p}", (username,))
    row = cursor.fetchone()
    if not row:
        cursor.execute(f"INSERT INTO {u} (username, balance) VALUES ({p}, {p})", (username, 1000000.0))
        conn.commit()
        if IS_POSTGRES:
            cursor.execute(f"SELECT id FROM {u} WHERE username = {p}", (username,))
            user_id = cursor.fetchone()["id"]
        else:
            user_id = cursor.lastrowid
        balance = 1000000.0
    else:
        user_id = row["id"]
        balance = row["balance"]
        
    conn.close()
    return user_id, balance

# ---------------------------------------------------------------------------
# Auth-specific DB functions
# ---------------------------------------------------------------------------

def register_user(username, email, password_hash, is_verified=True):
    """Create a new user. Returns user_id or None if duplicate."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()
    try:
        verified_val = ('TRUE' if IS_POSTGRES else 1) if is_verified else ('FALSE' if IS_POSTGRES else 0)
        cursor.execute(
            f"INSERT INTO {u} (username, email, password_hash, is_verified, balance) VALUES ({p}, {p}, {p}, {verified_val}, 1000000.0)",
            (username, email, password_hash)
        )
        conn.commit()
        if IS_POSTGRES:
            cursor.execute(f"SELECT id FROM {u} WHERE username = {p}", (username,))
            user_id = cursor.fetchone()["id"]
        else:
            user_id = cursor.lastrowid
        return user_id
    except Exception as e:
        print(f"register_user error: {e}")
        return None
    finally:
        conn.close()

def get_user_by_username(username):
    """Fetch full user record by username."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()
    cursor.execute(f"SELECT * FROM {u} WHERE username = {p}", (username,))
    row = cursor.fetchone()
    conn.close()
    if row:
        return dict(row)
    return None

def get_user_by_id(user_id):
    """Fetch full user record by primary key. Used to authenticate the WebSocket."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()
    try:
        cursor.execute(f"SELECT * FROM {u} WHERE id = {p}", (int(user_id),))
    except (TypeError, ValueError):
        conn.close()
        return None
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def get_user_by_email(email):
    """Fetch full user record by email."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()
    cursor.execute(f"SELECT * FROM {u} WHERE email = {p}", (email,))
    row = cursor.fetchone()
    conn.close()
    if row:
        return dict(row)
    return None

def verify_user(email):
    """Mark a user verified by email. Kept for callers that only have the email."""
    user = get_user_by_email(email)
    if not user:
        return False
    mark_user_verified(user["id"])
    return True

def get_user_by_clerk_id(clerk_id):
    """Fetch full user record by Clerk user ID."""
    if not clerk_id:
        return None
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()
    try:
        cursor.execute(f"SELECT * FROM {u} WHERE clerk_id = {p}", (str(clerk_id).strip(),))
        row = cursor.fetchone()
        return dict(row) if row else None
    except Exception as e:
        print(f"get_user_by_clerk_id error: {e}")
        return None
    finally:
        conn.close()

def sync_login_user(email=None, username=None, clerk_id=None):
    """
    Finds or creates a user based on login parameters (clerk_id, email, username).
    Ensures seamless database connection for OAuth & direct logins.
    Returns full user dict.
    """
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()
    
    clean_clerk_id = str(clerk_id).strip() if clerk_id else None
    clean_email = email.lower().strip() if email else None
    clean_username = username.strip() if username else None
    
    user = None
    try:
        # 1. Lookup by clerk_id
        if clean_clerk_id:
            cursor.execute(f"SELECT * FROM {u} WHERE clerk_id = {p}", (clean_clerk_id,))
            row = cursor.fetchone()
            if row:
                user = dict(row)
                needs_update = False
                update_cols = []
                update_vals = []
                if clean_email and not user.get("email"):
                    update_cols.append(f"email = {p}")
                    update_vals.append(clean_email)
                    user["email"] = clean_email
                    needs_update = True
                if not user.get("is_verified"):
                    verified_val = True if IS_POSTGRES else 1
                    update_cols.append(f"is_verified = {p}")
                    update_vals.append(verified_val)
                    user["is_verified"] = verified_val
                    needs_update = True
                if needs_update and update_cols:
                    update_vals.append(user["id"])
                    cursor.execute(f"UPDATE {u} SET {', '.join(update_cols)} WHERE id = {p}", tuple(update_vals))
                    conn.commit()

        # 2. Lookup by email
        if not user and clean_email:
            cursor.execute(f"SELECT * FROM {u} WHERE email = {p}", (clean_email,))
            row = cursor.fetchone()
            if row:
                user = dict(row)
                verified_val = True if IS_POSTGRES else 1
                if clean_clerk_id and user.get("clerk_id") != clean_clerk_id:
                    cursor.execute(f"UPDATE {u} SET clerk_id = {p}, is_verified = {p} WHERE id = {p}", (clean_clerk_id, verified_val, user["id"]))
                    conn.commit()
                    user["clerk_id"] = clean_clerk_id
                    user["is_verified"] = verified_val

        # 3. Lookup by username
        if not user and clean_username:
            cursor.execute(f"SELECT * FROM {u} WHERE username = {p}", (clean_username,))
            row = cursor.fetchone()
            if row:
                user = dict(row)
                verified_val = True if IS_POSTGRES else 1
                if clean_clerk_id and user.get("clerk_id") != clean_clerk_id:
                    cursor.execute(f"UPDATE {u} SET clerk_id = {p}, is_verified = {p} WHERE id = {p}", (clean_clerk_id, verified_val, user["id"]))
                    conn.commit()
                    user["clerk_id"] = clean_clerk_id
                    user["is_verified"] = verified_val

        # 4. User does not exist in DB — auto create verified trading account
        if not user:
            import re
            raw_base = clean_username or (clean_email.split("@")[0] if clean_email else f"trader_{int(datetime.utcnow().timestamp())}")
            base_name = re.sub(r'[^a-zA-Z0-9_-]', '_', raw_base).strip('_') or f"trader_{int(datetime.utcnow().timestamp())}"
            final_username = base_name
            cursor.execute(f"SELECT id FROM {u} WHERE username = {p}", (final_username,))
            if cursor.fetchone():
                import random
                final_username = f"{base_name}_{random.randint(100, 999)}"

            verified_val = True if IS_POSTGRES else 1
            cursor.execute(
                f"INSERT INTO {u} (username, email, clerk_id, is_verified, balance) VALUES ({p}, {p}, {p}, {p}, 1000000.0)",
                (final_username, clean_email, clean_clerk_id, verified_val)
            )
            conn.commit()
            if IS_POSTGRES:
                cursor.execute(f"SELECT * FROM {u} WHERE username = {p}", (final_username,))
                user = dict(cursor.fetchone())
            else:
                user_id = cursor.lastrowid
                cursor.execute(f"SELECT * FROM {u} WHERE id = {p}", (user_id,))
                user = dict(cursor.fetchone())

        return user
    except Exception as e:
        print(f"sync_login_user error: {e}")
        return None
    finally:
        conn.close()

# --- Autotrade Bot Configuration Methods ---

def get_bot_config(user_id):
    conn = get_connection()
    cursor = get_cursor(conn)
    placeholder = get_placeholder()
    try:
        cursor.execute(f"SELECT * FROM bot_config WHERE user_id = {placeholder}", (user_id,))
        row = cursor.fetchone()
        if not row:
            # Create default if not exists
            cursor.execute(f"""
                INSERT INTO bot_config (user_id, assets, total_capital, max_risk_per_trade, min_profit_target, max_profit_target, is_active)
                VALUES ({placeholder}, 'BTC-USD,ETH-USD', 10000.0, 100.0, 200.0, 1000.0, {'FALSE' if IS_POSTGRES else 0})
            """, (user_id,))
            conn.commit()
            cursor.execute(f"SELECT * FROM bot_config WHERE user_id = {placeholder}", (user_id,))
            row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        cursor.close()
        conn.close()

def get_all_active_bot_configs():
    conn = get_connection()
    cursor = get_cursor(conn)
    val = "TRUE" if IS_POSTGRES else 1
    cursor.execute(f"SELECT * FROM bot_config WHERE is_active = {val}")
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def update_bot_config(user_id, config):
    conn = get_connection()
    cursor = conn.cursor()
    placeholder = get_placeholder()
    
    is_active_val = config.get('is_active', False)
    if not IS_POSTGRES:
        is_active_val = 1 if is_active_val else 0

    try:
        cursor.execute(f"""
            UPDATE bot_config 
            SET assets = {placeholder},
                total_capital = {placeholder},
                max_risk_per_trade = {placeholder},
                min_profit_target = {placeholder},
                max_profit_target = {placeholder},
                is_active = {placeholder},
                market_category = {placeholder},
                leverage = {placeholder}
            WHERE user_id = {placeholder}
        """, (
            config.get('assets', 'BTC-USD'),
            float(config.get('total_capital', 10000.0)),
            float(config.get('max_risk_per_trade', 100.0)),
            float(config.get('min_profit_target', 200.0)),
            float(config.get('max_profit_target', 1000.0)),
            is_active_val,
            config.get('market_category') or 'Crypto',
            float(config.get('leverage') or 1.0),
            user_id
        ))
        conn.commit()
    except Exception as e:
        print(f"Error updating bot config: {e}")
        conn.rollback()
    finally:
        cursor.close()
        conn.close()


# --- Auto-Trade Bot Session Methods ---

# Session metrics are aggregated from the trades a session opened, so partial
# and full closes (whichever code path performs them) are reflected without
# any extra bookkeeping.
_BOT_AGGREGATE_COLUMNS = """
    COALESCE(SUM(realized_pnl), 0.0) AS realized_pnl,
    COALESCE(SUM(CASE WHEN outcome IS NULL OR outcome <> 'cancelled' THEN 1 ELSE 0 END), 0) AS total_trades,
    COALESCE(SUM(CASE WHEN status = 'closed' AND realized_pnl > 0 THEN 1 ELSE 0 END), 0) AS winning_trades,
    COALESCE(SUM(CASE WHEN status = 'closed' AND realized_pnl < 0 THEN 1 ELSE 0 END), 0) AS losing_trades,
    COALESCE(SUM(CASE WHEN status = 'active' AND (remaining_quantity IS NULL OR remaining_quantity > 0) THEN 1 ELSE 0 END), 0) AS open_trades,
    COALESCE(SUM(CASE WHEN status = 'active' AND (remaining_quantity IS NULL OR remaining_quantity > 0) THEN margin_used ELSE 0 END), 0.0) AS used_capital
"""


def _normalize_bot_aggregates(row) -> dict:
    d = dict(row) if row else {}
    return {
        "realized_pnl": float(d.get("realized_pnl") or 0.0),
        "total_trades": int(d.get("total_trades") or 0),
        "winning_trades": int(d.get("winning_trades") or 0),
        "losing_trades": int(d.get("losing_trades") or 0),
        "open_trades": int(d.get("open_trades") or 0),
        "used_capital": float(d.get("used_capital") or 0.0),
    }


def _session_from_row(row) -> dict:
    s = dict(row)
    try:
        s["assets"] = _json.loads(s.get("selected_assets") or "[]")
    except (TypeError, ValueError):
        s["assets"] = [a.strip() for a in str(s.get("selected_assets") or "").split(",") if a.strip()]
    return s


def create_bot_session(user_id, market_category, assets, allocated_capital, target_profit, max_loss, leverage) -> dict:
    """
    Insert a new session in STARTING state.

    The allocation is re-checked against the wallet balance inside the same
    transaction, and the partial unique index rejects a second live session for
    the user, so two concurrent start requests cannot both succeed. Nothing is
    deducted here: margin only moves when a trade is actually opened.
    Raises BotSessionConflictError or ValueError.
    """
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()
    now_iso = datetime.now().isoformat()
    try:
        _begin_write(cursor)
        cursor.execute(f"SELECT balance FROM {u} WHERE id = {p}{_for_update()}", (user_id,))
        row = cursor.fetchone()
        if not row:
            raise ValueError("User account not found.")
        balance = float(row["balance"])
        if float(allocated_capital) > balance:
            raise ValueError(f"Allocated capital {float(allocated_capital):.2f} exceeds available balance {balance:.2f}.")

        values = (user_id, market_category, _json.dumps(list(assets)), float(allocated_capital),
                  float(target_profit), float(max_loss), float(leverage), now_iso, now_iso, now_iso)
        insert_sql = f"""
        INSERT INTO bot_sessions (user_id, status, market_category, selected_assets, allocated_capital, target_profit, max_loss, leverage, started_at, created_at, updated_at)
        VALUES ({p}, 'STARTING', {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p})
        """
        if IS_POSTGRES:
            cursor.execute(insert_sql + " RETURNING id", values)
            session_id = cursor.fetchone()["id"]
        else:
            cursor.execute(insert_sql, values)
            session_id = cursor.lastrowid
        cursor.execute(f"SELECT * FROM bot_sessions WHERE id = {p}", (session_id,))
        session = _session_from_row(cursor.fetchone())
        conn.commit()
        return session
    except Exception as err:
        conn.rollback()
        if _is_unique_violation(err):
            raise BotSessionConflictError("A bot session is already running for this account.") from err
        raise
    finally:
        conn.close()


def get_bot_session(session_id, user_id=None):
    """Fetch one session; with user_id, only if it belongs to that user."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    try:
        if user_id is not None:
            cursor.execute(f"SELECT * FROM bot_sessions WHERE id = {p} AND user_id = {p}", (session_id, user_id))
        else:
            cursor.execute(f"SELECT * FROM bot_sessions WHERE id = {p}", (session_id,))
        row = cursor.fetchone()
        return _session_from_row(row) if row else None
    finally:
        conn.close()


def get_live_bot_session(user_id):
    """The user's non-terminal session (running or stopping), if any."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    placeholders = ", ".join([p] * len(BOT_LIVE_STATUSES))
    try:
        cursor.execute(
            f"SELECT * FROM bot_sessions WHERE user_id = {p} AND status IN ({placeholders}) ORDER BY id DESC LIMIT 1",
            (user_id, *BOT_LIVE_STATUSES),
        )
        row = cursor.fetchone()
        return _session_from_row(row) if row else None
    finally:
        conn.close()


def get_latest_bot_session(user_id):
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    try:
        cursor.execute(f"SELECT * FROM bot_sessions WHERE user_id = {p} ORDER BY id DESC LIMIT 1", (user_id,))
        row = cursor.fetchone()
        return _session_from_row(row) if row else None
    finally:
        conn.close()


def get_current_bot_session(user_id):
    """The user's live session if there is one, otherwise the most recent — in one round trip."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    placeholders = ", ".join([p] * len(BOT_LIVE_STATUSES))
    try:
        cursor.execute(
            f"SELECT * FROM bot_sessions WHERE user_id = {p} "
            f"ORDER BY CASE WHEN status IN ({placeholders}) THEN 0 ELSE 1 END, id DESC LIMIT 1",
            (user_id, *BOT_LIVE_STATUSES),
        )
        row = cursor.fetchone()
        return _session_from_row(row) if row else None
    finally:
        conn.close()


def list_bot_sessions_by_status(statuses) -> list:
    """Sessions (all users) currently in one of the given states — the runtime's work list."""
    statuses = tuple(statuses)
    if not statuses:
        return []
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    placeholders = ", ".join([p] * len(statuses))
    try:
        cursor.execute(f"SELECT * FROM bot_sessions WHERE status IN ({placeholders}) ORDER BY id ASC", statuses)
        return [_session_from_row(r) for r in cursor.fetchall()]
    finally:
        conn.close()


def transition_bot_session(session_id, new_status, from_statuses, user_id=None, stop_reason=None,
                           last_error=None, mark_stopped=False) -> bool:
    """
    Compare-and-set a session's status.

    The UPDATE only applies while the current status is one of from_statuses,
    so a worker that is still mid-scan cannot overwrite a STOPPING set by the
    user, and a stop cannot resurrect a session that already hit its target.
    Returns True when the transition was applied.
    """
    from_statuses = tuple(from_statuses)
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    now_iso = datetime.now().isoformat()
    sets = [f"status = {p}", f"updated_at = {p}"]
    params = [new_status, now_iso]
    if stop_reason is not None:
        sets.append(f"stop_reason = {p}")
        params.append(str(stop_reason)[:255])
    if last_error is not None:
        sets.append(f"last_error = {p}")
        params.append(str(last_error)[:2000])
    if mark_stopped:
        sets.append(f"stopped_at = {p}")
        params.append(now_iso)
    where = f"id = {p} AND status IN ({', '.join([p] * len(from_statuses))})"
    params.extend([session_id, *from_statuses])
    if user_id is not None:
        where += f" AND user_id = {p}"
        params.append(user_id)
    try:
        cursor.execute(f"UPDATE bot_sessions SET {', '.join(sets)} WHERE {where}", tuple(params))
        changed = cursor.rowcount == 1
        conn.commit()
        return changed
    finally:
        conn.close()


def mark_bot_session_scanned(session_id):
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    now_iso = datetime.now().isoformat()
    try:
        cursor.execute(
            f"UPDATE bot_sessions SET scan_count = scan_count + 1, last_scan_at = {p}, updated_at = {p} WHERE id = {p}",
            (now_iso, now_iso, session_id),
        )
        conn.commit()
    finally:
        conn.close()


def get_bot_session_aggregates(session_id) -> dict:
    """Realized P&L, trade counts and committed margin for one session."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    try:
        cursor.execute(f"SELECT {_BOT_AGGREGATE_COLUMNS} FROM trades WHERE bot_session_id = {p}", (session_id,))
        return _normalize_bot_aggregates(cursor.fetchone())
    finally:
        conn.close()


def list_bot_sessions_with_metrics(user_id, limit=20, offset=0) -> dict:
    """Session history for one user, newest first, with metrics derived from its trades."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    try:
        cursor.execute(f"SELECT COUNT(*) AS total FROM bot_sessions WHERE user_id = {p}", (user_id,))
        total = int(dict(cursor.fetchone())["total"])
        cursor.execute(f"""
        SELECT s.*, a.realized_pnl, a.total_trades, a.winning_trades, a.losing_trades, a.open_trades, a.used_capital
        FROM bot_sessions s
        LEFT JOIN (
            SELECT bot_session_id, {_BOT_AGGREGATE_COLUMNS}
            FROM trades WHERE bot_session_id IS NOT NULL GROUP BY bot_session_id
        ) a ON a.bot_session_id = s.id
        WHERE s.user_id = {p}
        ORDER BY s.id DESC
        LIMIT {int(limit)} OFFSET {int(offset)}
        """, (user_id,))
        sessions = []
        for r in cursor.fetchall():
            s = _session_from_row(r)
            s.update(_normalize_bot_aggregates(r))
            sessions.append(s)
        return {"sessions": sessions, "total": total, "limit": limit, "offset": offset}
    finally:
        conn.close()


def get_bot_session_trades(session_id, status=None, limit=200) -> list:
    """Trades opened by one session. status: 'open', 'closed' or None for all."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    query = f"SELECT * FROM trades WHERE bot_session_id = {p}"
    if status == "open":
        query += " AND status = 'active' AND (remaining_quantity IS NULL OR remaining_quantity > 0)"
    elif status == "closed":
        query += " AND status = 'closed'"
    query += f" ORDER BY id DESC LIMIT {int(limit)}"
    try:
        cursor.execute(query, (session_id,))
        return [dict(r) for r in cursor.fetchall()]
    finally:
        conn.close()


def get_open_bot_trades() -> list:
    """Every open trade opened by any bot session (all users) — for protective SL/target monitoring."""
    conn = get_connection()
    cursor = get_cursor(conn)
    try:
        cursor.execute("""
        SELECT * FROM trades
        WHERE bot_session_id IS NOT NULL AND status = 'active' AND (remaining_quantity IS NULL OR remaining_quantity > 0)
        ORDER BY id ASC
        """)
        return [dict(r) for r in cursor.fetchall()]
    finally:
        conn.close()


def _bot_entry_refusal(cursor, session_id, user_id, asset, margin):
    """
    Auto-Trade Bot guard, evaluated inside the trade-opening transaction.
    Locks the session row so concurrent entries for one session serialize.
    Returns a refusal reason, or None when the entry may proceed.
    """
    p = get_placeholder()
    cursor.execute(f"SELECT * FROM bot_sessions WHERE id = {p}{_for_update()}", (session_id,))
    row = cursor.fetchone()
    if not row:
        return "Bot session not found."
    session = dict(row)
    if int(session["user_id"]) != int(user_id):
        return "Bot session does not belong to this account."
    if session["status"] not in BOT_ENTRY_STATUSES:
        return f"Bot session is {session['status']}; it no longer opens new trades."

    cursor.execute(f"SELECT {_BOT_AGGREGATE_COLUMNS} FROM trades WHERE bot_session_id = {p}", (session_id,))
    agg = _normalize_bot_aggregates(cursor.fetchone())
    if agg["realized_pnl"] >= float(session["target_profit"]):
        return "Session target profit has already been reached."
    if agg["realized_pnl"] <= -float(session["max_loss"]):
        return "Session maximum loss has already been reached."

    cursor.execute(f"""
    SELECT COUNT(*) AS n FROM trades
    WHERE bot_session_id = {p} AND asset = {p} AND status = 'active' AND (remaining_quantity IS NULL OR remaining_quantity > 0)
    """, (session_id, asset))
    if int(dict(cursor.fetchone())["n"]) > 0:
        return f"Session already holds an open {asset} position."

    remaining = float(session["allocated_capital"]) - agg["used_capital"]
    if margin > remaining + 1e-9:
        return f"Margin {margin:.2f} exceeds remaining bot capital {max(0.0, remaining):.2f}."
    return None

def mark_user_verified(user_id):
    """Mark a user as email-verified."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()
    val = "TRUE" if IS_POSTGRES else 1
    cursor.execute(f"UPDATE {u} SET is_verified = {val} WHERE id = {p}", (user_id,))
    conn.commit()
    conn.close()


def get_user_balance(user_id=1):
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()
    cursor.execute(f"SELECT balance FROM {u} WHERE id = {p}", (user_id,))
    row = cursor.fetchone()
    balance = row["balance"] if row else 1000000.0
    conn.close()
    return balance

def update_user_balance(user_id, amount):
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()
    cursor.execute(f"UPDATE {u} SET balance = balance + {p} WHERE id = {p}", (amount, user_id))
    conn.commit()
    conn.close()

def create_pending_trade(user_id, asset, trade_type, quantity, entry_price, sl, target, leverage=1.0, market="Crypto"):
    # Supersede any *pending* order on the same asset — an unconfirmed order was
    # never funded, so cancelling it costs nothing.
    #
    # ACTIVE positions are deliberately left alone. The old code closed them with
    # the same blind UPDATE, which wiped the position without refunding the
    # capital that execute_trade() had already deducted, silently draining the
    # user's balance. Superseding a funded position has to go through
    # close_trade() so the refund happens.
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()

    cursor.execute(f"""
    UPDATE trades
    SET status = 'closed', exit_price = {p}, current_price = {p}, outcome = 'cancelled', pnl = 0.0, remaining_quantity = 0.0, closed_at = {p}
    WHERE user_id = {p} AND asset = {p} AND status = 'pending'
    """, (entry_price, entry_price, datetime.now().isoformat(), user_id, asset))

    timestamp = datetime.now().isoformat()
    lev = float(leverage) if leverage and float(leverage) > 0 else 1.0
    margin = (float(quantity) * float(entry_price)) / lev
    mkt = market or ("Crypto" if "-" in str(asset) else "Stock")

    if IS_POSTGRES:
        cursor.execute(f"""
        INSERT INTO trades (user_id, asset, type, quantity, original_quantity, remaining_quantity, leverage, margin_used, market, entry_price, current_price, sl, target, status, realized_pnl, timestamp)
        VALUES ({p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, 'pending', 0.0, {p})
        RETURNING id
        """, (user_id, asset, trade_type, quantity, quantity, quantity, lev, margin, mkt, entry_price, entry_price, sl, target, timestamp))
        trade_id = cursor.fetchone()["id"]
    else:
        cursor.execute(f"""
        INSERT INTO trades (user_id, asset, type, quantity, original_quantity, remaining_quantity, leverage, margin_used, market, entry_price, current_price, sl, target, status, realized_pnl, timestamp)
        VALUES ({p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, 'pending', 0.0, {p})
        """, (user_id, asset, trade_type, quantity, quantity, quantity, lev, margin, mkt, entry_price, entry_price, sl, target, timestamp))
        trade_id = cursor.lastrowid
    
    conn.commit()
    conn.close()
    return trade_id

def open_active_trade_atomic(user_id: int, asset: str, trade_type: str, quantity: float, price: float, leverage: float = 1.0, sl: float = 0.0, target: float = 0.0, market: Optional[str] = None, source: str = "manual", bot_session_id: Optional[int] = None):
    """
    Atomic single-transaction trade opener fulfilling Part 12 & Part 25.
    Executes balance validation, margin reservation, active trade insertion,
    and audit log creation in a single ACID transaction on the permanent database.

    With bot_session_id the Auto-Trade Bot guard (_bot_entry_refusal) runs in
    the same transaction, so a stop, a reached target/loss limit or an
    exhausted allocation that lands while the order is in flight still blocks it.
    """
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()

    lev = float(leverage) if leverage and float(leverage) > 0 else 1.0
    cost = (float(quantity) * float(price)) / lev
    mkt = market or ("Crypto" if "-" in str(asset) else "Stock")
    src = "bot" if bot_session_id is not None else (source or "manual")
    now_iso = datetime.now().isoformat()

    try:
        _begin_write(cursor)
        if bot_session_id is not None:
            refusal = _bot_entry_refusal(cursor, bot_session_id, user_id, asset, cost)
            if refusal:
                conn.rollback()
                return None, refusal

        # 1. Validate balance (row-locked so concurrent opens cannot both spend it)
        cursor.execute(f"SELECT balance FROM {u} WHERE id = {p}{_for_update()}", (user_id,))
        row = cursor.fetchone()
        balance = float(row["balance"]) if row else 0.0
        if cost > balance:
            conn.rollback()
            return None, f"Insufficient funds: margin {cost:.2f} exceeds balance {balance:.2f}"

        # 2. Deduct margin from user balance
        new_balance = balance - cost
        cursor.execute(f"UPDATE {u} SET balance = {p} WHERE id = {p}", (new_balance, user_id))

        # 3. Insert active trade
        insert_sql = f"""
            INSERT INTO trades (user_id, asset, type, quantity, original_quantity, remaining_quantity, leverage, margin_used, market, entry_price, current_price, sl, target, status, realized_pnl, timestamp, source, bot_session_id)
            VALUES ({p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, 'active', 0.0, {p}, {p}, {p})
            """
        values = (user_id, asset, trade_type, quantity, quantity, quantity, lev, cost, mkt, price, price, sl, target, now_iso, src, bot_session_id)
        if IS_POSTGRES:
            cursor.execute(insert_sql + " RETURNING id", values)
            trade_id = cursor.fetchone()["id"]
        else:
            cursor.execute(insert_sql, values)
            trade_id = cursor.lastrowid

        # 4. Insert audit log execution
        cursor.execute(f"""
        INSERT INTO trade_executions (position_id, user_id, action, quantity, price, realized_pnl, timestamp, metadata)
        VALUES ({p}, {p}, 'OPEN', {p}, {p}, 0.0, {p}, '{{}}')
        """, (trade_id, user_id, float(quantity), float(price), now_iso))

        conn.commit()
        return trade_id, new_balance
    except Exception as err:
        conn.rollback()
        raise err
    finally:
        conn.close()

def get_active_positions(user_id=None):
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    if user_id is not None:
        cursor.execute(f"SELECT * FROM trades WHERE user_id = {p} AND status IN ('pending', 'active')", (user_id,))
    else:
        cursor.execute("SELECT * FROM trades WHERE status IN ('pending', 'active')")
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_open_positions(user_id=None):
    """Retrieve all open active positions with remaining quantity > 0."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    if user_id is not None:
        cursor.execute(f"""
        SELECT * FROM trades 
        WHERE user_id = {p} AND status = 'active' AND (remaining_quantity IS NULL OR remaining_quantity > 0)
        ORDER BY timestamp DESC
        """, (user_id,))
    else:
        cursor.execute("""
        SELECT * FROM trades 
        WHERE status = 'active' AND (remaining_quantity IS NULL OR remaining_quantity > 0)
        ORDER BY timestamp DESC
        """)
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_position_by_id(trade_id: int, user_id: Optional[int] = None) -> Optional[dict]:
    """Retrieve single position by id, ensuring optional user ownership validation."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    if user_id is not None:
        cursor.execute(f"SELECT * FROM trades WHERE id = {p} AND user_id = {p}", (trade_id, user_id))
    else:
        cursor.execute(f"SELECT * FROM trades WHERE id = {p}", (trade_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def get_pending_orders(user_id=None):
    """Retrieve all pending unfilled orders."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    if user_id is not None:
        cursor.execute(f"SELECT * FROM trades WHERE user_id = {p} AND status = 'pending' ORDER BY timestamp DESC", (user_id,))
    else:
        cursor.execute("SELECT * FROM trades WHERE status = 'pending' ORDER BY timestamp DESC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def record_trade_execution(position_id: int, user_id: int, action: str, quantity: float, price: float, realized_pnl: float = 0.0, metadata: Optional[dict] = None):
    """Append-only audit record of an execution event (OPEN, PARTIAL_CLOSE, FULL_CLOSE)."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    timestamp = datetime.now().isoformat()
    meta_json = _json.dumps(metadata or {})
    try:
        cursor.execute(f"""
        INSERT INTO trade_executions (position_id, user_id, action, quantity, price, realized_pnl, timestamp, metadata)
        VALUES ({p}, {p}, {p}, {p}, {p}, {p}, {p}, {p})
        """, (position_id, user_id, action, float(quantity), float(price), float(realized_pnl), timestamp, meta_json))
        conn.commit()
    except Exception as e:
        print(f"record_trade_execution error: {e}")
    finally:
        conn.close()

def get_trade_history(user_id=None):
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    if user_id is not None:
        cursor.execute(f"SELECT * FROM trades WHERE user_id = {p} AND status = 'closed' ORDER BY timestamp DESC LIMIT 50", (user_id,))
    else:
        cursor.execute("SELECT * FROM trades WHERE status = 'closed' ORDER BY timestamp DESC LIMIT 50")
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_closed_trade_history_paginated(
    user_id: Optional[int] = None,
    symbol: Optional[str] = None,
    market: Optional[str] = None,
    side: Optional[str] = None,
    outcome: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
    source: Optional[str] = None,
    bot_session_id: Optional[int] = None
) -> dict:
    """Retrieve paginated completed closed trades with filters."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()

    where_clauses = ["status = 'closed'"]
    params = []

    if user_id is not None:
        where_clauses.append(f"user_id = {p}")
        params.append(user_id)

    if source:
        if source.strip().lower() == "bot":
            where_clauses.append("source = 'bot'")
        elif source.strip().lower() == "manual":
            where_clauses.append("(source IS NULL OR source = 'manual')")

    if bot_session_id is not None:
        where_clauses.append(f"bot_session_id = {p}")
        params.append(bot_session_id)

    if symbol:
        where_clauses.append(f"UPPER(asset) = {p}")
        params.append(symbol.strip().upper())

    if market:
        where_clauses.append(f"UPPER(market) = {p}")
        params.append(market.strip().upper())

    if side:
        where_clauses.append(f"LOWER(type) = {p}")
        params.append(side.strip().lower())

    if outcome:
        out = outcome.strip().lower()
        if out == "profit":
            where_clauses.append("realized_pnl > 0")
        elif out == "loss":
            where_clauses.append("realized_pnl < 0")
        elif out == "breakeven":
            where_clauses.append("realized_pnl = 0")

    where_str = " WHERE " + " AND ".join(where_clauses)

    # Count query
    count_query = f"SELECT COUNT(*) as total FROM trades {where_str}"
    cursor.execute(count_query, tuple(params))
    count_row = cursor.fetchone()
    total_count = count_row["total"] if count_row else 0

    # Data query
    data_query = f"""
    SELECT * FROM trades 
    {where_str} 
    ORDER BY COALESCE(closed_at, timestamp) DESC, id DESC 
    LIMIT {int(limit)} OFFSET {int(offset)}
    """
    cursor.execute(data_query, tuple(params))
    rows = cursor.fetchall()
    conn.close()

    formatted_trades = []
    for r in rows:
        d = dict(r)
        d["symbol"] = d.get("asset") or d.get("symbol", "")
        formatted_trades.append(d)

    return {
        "trades": formatted_trades,
        "total": total_count,
        "total_count": total_count,
        "limit": limit,
        "offset": offset
    }

def get_total_realized_pnl(user_id: Optional[int] = None) -> float:
    """Sum total realized profit/loss across all closed trades for user."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    if user_id is not None:
        cursor.execute(f"SELECT COALESCE(SUM(realized_pnl), 0.0) as total FROM trades WHERE user_id = {p} AND status = 'closed'", (user_id,))
    else:
        cursor.execute("SELECT COALESCE(SUM(realized_pnl), 0.0) as total FROM trades WHERE status = 'closed'")
    row = cursor.fetchone()
    total = float(row["total"]) if row and row["total"] is not None else 0.0
    conn.close()
    return total

def get_all_trades(user_id=None, status=None):
    """
    Every trade for a user, oldest first — the reporting view.

    get_trade_history() caps at the 50 most recent closed trades because it
    feeds a live panel. A report has to run statistics over the whole record,
    so this one takes no limit and returns chronological order, which is what
    an equity curve and a drawdown calculation need.
    """
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()

    query = "SELECT * FROM trades"
    params = []
    clauses = []
    if user_id is not None:
        clauses.append(f"user_id = {p}")
        params.append(user_id)
    if status is not None:
        clauses.append(f"status = {p}")
        params.append(status)
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY timestamp ASC, id ASC"

    cursor.execute(query, tuple(params))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]


def execute_trade(trade_id, execution_price):
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()
    
    # Fetch trade details
    cursor.execute(f"SELECT * FROM trades WHERE id = {p}", (trade_id,))
    trade = cursor.fetchone()
    if not trade or trade["status"] != "pending":
        conn.close()
        return False
        
    lev = float(trade["leverage"]) if trade["leverage"] and float(trade["leverage"]) > 0 else 1.0
    cost = (trade["quantity"] * execution_price) / lev
    user_id = trade["user_id"] if trade["user_id"] is not None else 1

    # Never let a fill push the wallet negative — reject it and cancel the order
    # instead, otherwise the simulation happily trades money it does not have.
    cursor.execute(f"SELECT balance FROM {u} WHERE id = {p}", (user_id,))
    row = cursor.fetchone()
    balance = row["balance"] if row else 0.0
    if cost > balance:
        now_iso = datetime.now().isoformat()
        cursor.execute(f"""
        UPDATE trades
        SET status = 'closed', exit_price = {p}, current_price = {p}, pnl = 0.0, realized_pnl = 0.0, outcome = 'cancelled', remaining_quantity = 0.0, closed_at = {p}
        WHERE id = {p}
        """, (execution_price, execution_price, now_iso, trade_id))
        conn.commit()
        conn.close()
        return False

    # Deduct margin cost from balance
    cursor.execute(f"UPDATE {u} SET balance = balance - {p} WHERE id = {p}", (cost, user_id))

    # Update trade status
    cursor.execute(f"""
    UPDATE trades
    SET status = 'active', entry_price = {p}, current_price = {p}, margin_used = {p}, original_quantity = quantity, remaining_quantity = quantity
    WHERE id = {p}
    """, (execution_price, execution_price, cost, trade_id))

    conn.commit()
    conn.close()

    # Record open execution in audit log
    record_trade_execution(
        position_id=trade_id,
        user_id=user_id,
        action="OPEN",
        quantity=trade["quantity"],
        price=execution_price,
        realized_pnl=0.0
    )
    return True

def update_active_position_price(trade_id, current_price):
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    
    cursor.execute(f"SELECT * FROM trades WHERE id = {p}", (trade_id,))
    trade = cursor.fetchone()
    if not trade or trade["status"] != "active":
        conn.close()
        return
        
    # Calculate current unrealized P&L
    trade = dict(trade)
    entry = trade["entry_price"]
    qty = trade.get("remaining_quantity") if trade.get("remaining_quantity") is not None else trade["quantity"]
    lev = trade.get("leverage") or 1.0
    if trade["type"].lower() == "buy":
        pnl = (current_price - entry) * qty * lev
    else: # sell
        pnl = (entry - current_price) * qty * lev
        
    cursor.execute(f"""
    UPDATE trades 
    SET current_price = {p}, pnl = {p}
    WHERE id = {p}
    """, (current_price, pnl, trade_id))
    
    conn.commit()
    conn.close()

def close_trade(trade_id, exit_price, outcome):
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()
    
    # Lock the row: without it a manual close racing an SL/target exit could
    # both pass the status check and refund the margin twice.
    _begin_write(cursor)
    cursor.execute(f"SELECT * FROM trades WHERE id = {p}{_for_update()}", (trade_id,))
    trade = cursor.fetchone()
    if not trade or trade["status"] not in ("active", "pending"):
        conn.close()
        return
    trade = dict(trade)
        
    now_iso = datetime.now().isoformat()
    qty = trade.get("remaining_quantity") if trade.get("remaining_quantity") is not None else trade["quantity"]
    entry = trade["entry_price"]
    lev = trade.get("leverage") or 1.0
    user_id = trade["user_id"] if trade["user_id"] is not None else 1
    
    if trade["status"] == "pending":
        # Pending trade was never funded — just mark it closed/cancelled, no refund
        cursor.execute(f"""
        UPDATE trades 
        SET status = 'closed', exit_price = {p}, current_price = {p}, pnl = 0.0, realized_pnl = 0.0, remaining_quantity = 0.0, outcome = {p}, closed_at = {p}
        WHERE id = {p}
        """, (exit_price, exit_price, outcome, now_iso, trade_id))
        conn.commit()
        conn.close()
        return
        
    # Calculate final P&L for active trade on remaining quantity
    if trade["type"].lower() == "buy":
        portion_pnl = (exit_price - entry) * qty * lev
    else: # sell
        portion_pnl = (entry - exit_price) * qty * lev
        
    # Refund margin + portion PnL back to balance
    margin = trade.get("margin_used") if trade.get("margin_used") is not None and trade.get("margin_used") > 0 else ((qty * entry) / lev)
    refund = margin + portion_pnl
    total_realized_pnl = (trade.get("realized_pnl") or 0.0) + portion_pnl
        
    cursor.execute(f"UPDATE {u} SET balance = balance + {p} WHERE id = {p}", (refund, user_id))
    
    # Update trade status
    cursor.execute(f"""
    UPDATE trades 
    SET status = 'closed', exit_price = {p}, current_price = {p}, pnl = {p}, realized_pnl = {p}, remaining_quantity = 0.0, margin_used = 0.0, outcome = {p}, closed_at = {p}
    WHERE id = {p}
    """, (exit_price, exit_price, total_realized_pnl, total_realized_pnl, outcome, now_iso, trade_id))
    
    conn.commit()
    conn.close()

    # Record execution
    record_trade_execution(
        position_id=trade_id,
        user_id=user_id,
        action="FULL_CLOSE",
        quantity=qty,
        price=exit_price,
        realized_pnl=portion_pnl
    )

def partially_close_position(trade_id: int, user_id: int, close_qty: float, exit_price: float) -> dict:
    """
    Partially close an open active position.
    Credits margin refund + realized PnL on closed quantity to user balance.
    Decrements remaining_quantity, retains remaining margin & unrealized PnL.
    """
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()

    _begin_write(cursor)
    cursor.execute(f"SELECT * FROM trades WHERE id = {p} AND user_id = {p}{_for_update()}", (trade_id, user_id))
    trade = cursor.fetchone()
    if not trade:
        conn.close()
        raise ValueError("Position not found or unauthorized.")
    trade = dict(trade)

    if trade["status"] != "active":
        conn.close()
        raise ValueError(f"Position is {trade['status']}, cannot close.")

    rem_qty = float(trade.get("remaining_quantity") if trade.get("remaining_quantity") is not None else trade["quantity"])
    if close_qty <= 0:
        conn.close()
        raise ValueError("Close quantity must be strictly greater than 0.")

    if close_qty > rem_qty:
        conn.close()
        raise ValueError(f"Close quantity ({close_qty}) exceeds remaining position quantity ({rem_qty}).")

    if close_qty == rem_qty:
        conn.close()
        # Exact remaining quantity matches full close
        return fully_close_position(trade_id, user_id, exit_price, outcome="manual_close")

    entry = float(trade["entry_price"])
    lev = float(trade.get("leverage") or 1.0)

    # Realized PnL for the closed portion
    if trade["type"].lower() == "buy":
        portion_pnl = (exit_price - entry) * close_qty * lev
    else:
        portion_pnl = (entry - exit_price) * close_qty * lev

    # Proportional margin release
    current_margin = float(trade.get("margin_used") or ((rem_qty * entry) / lev))
    margin_portion = (close_qty / rem_qty) * current_margin
    refund_amount = margin_portion + portion_pnl

    new_remaining = rem_qty - close_qty
    new_margin = max(0.0, current_margin - margin_portion)
    acc_realized_pnl = float(trade.get("realized_pnl") or 0.0) + portion_pnl

    # Credit user wallet balance
    cursor.execute(f"UPDATE {u} SET balance = balance + {p} WHERE id = {p}", (refund_amount, user_id))

    # Update trade remaining state
    cursor.execute(f"""
    UPDATE trades
    SET remaining_quantity = {p}, margin_used = {p}, realized_pnl = {p}, current_price = {p}
    WHERE id = {p}
    """, (new_remaining, new_margin, acc_realized_pnl, exit_price, trade_id))

    # Append execution audit inside same atomic transaction
    now_ts = datetime.now().isoformat()
    cursor.execute(f"""
    INSERT INTO trade_executions (position_id, user_id, action, quantity, price, realized_pnl, timestamp, metadata)
    VALUES ({p}, {p}, 'PARTIAL_CLOSE', {p}, {p}, {p}, {p}, '{{}}')
    """, (trade_id, user_id, float(close_qty), float(exit_price), float(portion_pnl), now_ts))

    conn.commit()
    conn.close()

    return {
        "success": True,
        "trade_id": trade_id,
        "action": "PARTIAL_CLOSE",
        "closed_quantity": close_qty,
        "remaining_quantity": new_remaining,
        "exit_price": exit_price,
        "realized_pnl": portion_pnl,
        "total_realized_pnl": acc_realized_pnl,
        "refund_amount": refund_amount,
        "status": "active"
    }

def fully_close_position(trade_id: int, user_id: int, exit_price: float, outcome: str = "manual_close") -> dict:
    """
    Fully close an open position or cancel a pending order.
    Releases all remaining margin, calculates final realized PnL, marks status='closed'.
    """
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()

    _begin_write(cursor)
    cursor.execute(f"SELECT * FROM trades WHERE id = {p} AND user_id = {p}{_for_update()}", (trade_id, user_id))
    trade = cursor.fetchone()
    if not trade:
        conn.close()
        raise ValueError("Position not found or unauthorized.")
    trade = dict(trade)

    if trade["status"] == "closed":
        conn.close()
        raise ValueError("Position is already closed.")

    now_iso = datetime.now().isoformat()

    if trade["status"] == "pending":
        cursor.execute(f"""
        UPDATE trades
        SET status = 'closed', exit_price = {p}, current_price = {p}, pnl = 0.0, realized_pnl = 0.0, remaining_quantity = 0.0, margin_used = 0.0, outcome = 'cancelled', closed_at = {p}
        WHERE id = {p}
        """, (exit_price, exit_price, now_iso, trade_id))
        conn.commit()
        conn.close()
        return {
            "success": True,
            "trade_id": trade_id,
            "action": "CANCEL_PENDING",
            "closed_quantity": 0.0,
            "remaining_quantity": 0.0,
            "exit_price": exit_price,
            "realized_pnl": 0.0,
            "refund_amount": 0.0,
            "status": "closed"
        }

    rem_qty = float(trade.get("remaining_quantity") if trade.get("remaining_quantity") is not None else trade["quantity"])
    entry = float(trade["entry_price"])
    lev = float(trade.get("leverage") or 1.0)

    if trade["type"].lower() == "buy":
        portion_pnl = (exit_price - entry) * rem_qty * lev
    else:
        portion_pnl = (entry - exit_price) * rem_qty * lev

    current_margin = float(trade.get("margin_used") or ((rem_qty * entry) / lev))
    refund_amount = current_margin + portion_pnl
    total_realized = float(trade.get("realized_pnl") or 0.0) + portion_pnl

    # Credit user balance
    cursor.execute(f"UPDATE {u} SET balance = balance + {p} WHERE id = {p}", (refund_amount, user_id))

    # Mark closed
    cursor.execute(f"""
    UPDATE trades
    SET status = 'closed', remaining_quantity = 0.0, margin_used = 0.0, exit_price = {p}, current_price = {p}, pnl = {p}, realized_pnl = {p}, outcome = {p}, closed_at = {p}
    WHERE id = {p}
    """, (exit_price, exit_price, total_realized, total_realized, outcome, now_iso, trade_id))

    # Append execution audit inside same atomic transaction
    cursor.execute(f"""
    INSERT INTO trade_executions (position_id, user_id, action, quantity, price, realized_pnl, timestamp, metadata)
    VALUES ({p}, {p}, 'FULL_CLOSE', {p}, {p}, {p}, {p}, '{{}}')
    """, (trade_id, user_id, float(rem_qty), float(exit_price), float(portion_pnl), now_iso))

    conn.commit()
    conn.close()

    return {
        "success": True,
        "trade_id": trade_id,
        "action": "FULL_CLOSE",
        "closed_quantity": rem_qty,
        "remaining_quantity": 0.0,
        "exit_price": exit_price,
        "realized_pnl": portion_pnl,
        "total_realized_pnl": total_realized,
        "refund_amount": refund_amount,
        "status": "closed"
    }

def get_trade(trade_id):
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    cursor.execute(f"SELECT * FROM trades WHERE id = {p}", (trade_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def update_trade_sl(trade_id, new_sl):
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    cursor.execute(f"UPDATE trades SET sl = {p} WHERE id = {p}", (new_sl, trade_id))
    conn.commit()
    conn.close()


# ===========================================================================
# ORBIT AI Chatbot Conversation & Message Persistence Layer
# ===========================================================================

import json as _json

def create_conversation(
    conv_id: Optional[str] = None,
    title: str = "New Analysis",
    selected_asset: str = "BTC-USD",
    selected_market: str = "Crypto",
    user_id: Optional[int] = None,
    conversation_id: Optional[str] = None,
) -> dict:
    """Create a new chat conversation."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    now_iso = datetime.now().isoformat()
    cid = conv_id or conversation_id or str(uuid.uuid4())
    clean_title = (title or "New Analysis").strip()[:200]
    clean_asset = (selected_asset or "BTC-USD").strip().upper()[:50]
    clean_market = (selected_market or "Crypto").strip()[:50]

    cursor.execute(f"SELECT id, user_id, title, selected_asset, selected_market, created_at, updated_at FROM conversations WHERE id = {p}", (cid,))
    existing = cursor.fetchone()
    if existing:
        conn.close()
        return dict(existing)

    cursor.execute(f"""
    INSERT INTO conversations (id, user_id, title, selected_asset, selected_market, created_at, updated_at)
    VALUES ({p}, {p}, {p}, {p}, {p}, {p}, {p})
    """, (cid, user_id, clean_title, clean_asset, clean_market, now_iso, now_iso))
    conn.commit()
    conn.close()

    return {
        "id": cid,
        "user_id": user_id,
        "title": clean_title,
        "selected_asset": clean_asset,
        "selected_market": clean_market,
        "created_at": now_iso,
        "updated_at": now_iso,
    }


def list_conversations(user_id: Optional[int] = None, limit: int = 50) -> List[dict]:
    """Retrieve all conversations, ordered by most recently updated."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()

    if user_id is not None:
        cursor.execute(f"""
        SELECT id, user_id, title, selected_asset, selected_market, created_at, updated_at
        FROM conversations
        WHERE user_id = {p} OR user_id IS NULL
        ORDER BY updated_at DESC
        LIMIT {int(limit)}
        """, (user_id,))
    else:
        cursor.execute(f"""
        SELECT id, user_id, title, selected_asset, selected_market, created_at, updated_at
        FROM conversations
        ORDER BY updated_at DESC
        LIMIT {int(limit)}
        """)

    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows] if rows else []


def get_conversation(conv_id: Optional[str] = None, conversation_id: Optional[str] = None) -> Optional[dict]:
    """Retrieve single conversation record."""
    cid = conv_id or conversation_id
    if not cid:
        return None
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    cursor.execute(f"""
    SELECT id, user_id, title, selected_asset, selected_market, created_at, updated_at
    FROM conversations
    WHERE id = {p}
    """, (cid,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def update_conversation(
    conv_id: Optional[str] = None,
    title: Optional[str] = None,
    selected_asset: Optional[str] = None,
    selected_market: Optional[str] = None,
    conversation_id: Optional[str] = None,
) -> bool:
    """Update title, active asset, or market on conversation and touch updated_at."""
    cid = conv_id or conversation_id
    if not cid:
        return False
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    now_iso = datetime.now().isoformat()

    updates = ["updated_at = " + p]
    params = [now_iso]

    if title is not None:
        updates.append(f"title = {p}")
        params.append(title.strip()[:200])
    if selected_asset is not None:
        updates.append(f"selected_asset = {p}")
        params.append(selected_asset.strip().upper()[:50])
    if selected_market is not None:
        updates.append(f"selected_market = {p}")
        params.append(selected_market.strip()[:50])

    params.append(cid)
    query = f"UPDATE conversations SET {', '.join(updates)} WHERE id = {p}"
    cursor.execute(query, tuple(params))
    conn.commit()
    conn.close()
    return True


def delete_conversation(conv_id: Optional[str] = None, conversation_id: Optional[str] = None) -> bool:
    """Delete a conversation and its cascaded chat messages."""
    cid = conv_id or conversation_id
    if not cid:
        return False
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    cursor.execute(f"DELETE FROM chat_messages WHERE conversation_id = {p}", (cid,))
    cursor.execute(f"DELETE FROM conversations WHERE id = {p}", (cid,))
    conn.commit()
    conn.close()
    return True


def save_chat_message(
    conv_id: Optional[str] = None,
    role: str = "user",
    content: str = "",
    metadata: Optional[dict] = None,
    msg_id: Optional[str] = None,
    conversation_id: Optional[str] = None,
) -> dict:
    """Save an incoming or outgoing chat message in conversation thread."""
    cid = conv_id or conversation_id
    mid = msg_id or str(uuid.uuid4())
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    now_iso = datetime.now().isoformat()
    meta_json = _json.dumps(metadata or {})

    # Ensure conversation exists; auto-create if missing
    cursor.execute(f"SELECT id FROM conversations WHERE id = {p}", (cid,))
    existing = cursor.fetchone()
    if not existing:
        sym = (metadata or {}).get("asset") or (metadata or {}).get("symbol") or "BTC-USD"
        mkt = (metadata or {}).get("market") or "Crypto"
        auto_title = content.strip()[:40] if role == "user" else f"{sym} Analysis"
        cursor.execute(f"""
        INSERT INTO conversations (id, user_id, title, selected_asset, selected_market, created_at, updated_at)
        VALUES ({p}, NULL, {p}, {p}, {p}, {p}, {p})
        """, (cid, auto_title, sym, mkt, now_iso, now_iso))

    cursor.execute(f"""
    INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, metadata)
    VALUES ({p}, {p}, {p}, {p}, {p}, {p})
    """, (mid, cid, role, content, now_iso, meta_json))

    # Touch conversation updated_at
    cursor.execute(f"UPDATE conversations SET updated_at = {p} WHERE id = {p}", (now_iso, cid))
    conn.commit()
    conn.close()

    return {
        "id": mid,
        "conversation_id": cid,
        "role": role,
        "content": content,
        "timestamp": now_iso,
        "metadata": metadata or {},
    }


def get_chat_messages(
    conv_id: Optional[str] = None,
    conversation_id: Optional[str] = None,
    limit: int = 100,
) -> List[dict]:
    """Retrieve full message history for a conversation thread ordered chronologically."""
    cid = conv_id or conversation_id
    if not cid:
        return []
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    cursor.execute(f"""
    SELECT id, conversation_id, role, content, timestamp, metadata
    FROM chat_messages
    WHERE conversation_id = {p}
    ORDER BY timestamp ASC
    LIMIT {int(limit)}
    """, (cid,))
    rows = cursor.fetchall()
    conn.close()

    messages = []
    for r in rows:
        m = dict(r)
        if isinstance(m.get("metadata"), str):
            try:
                m["metadata"] = _json.loads(m["metadata"])
            except Exception:
                m["metadata"] = {}
        messages.append(m)
    return messages
