import sqlite3
import os
from datetime import datetime
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
        # Neon DB connection
        conn = psycopg2.connect(DATABASE_URL)
        return conn
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
        for col_name, col_type in [("email", "VARCHAR(255) UNIQUE"), ("password_hash", "VARCHAR(255)"), ("is_verified", "BOOLEAN NOT NULL DEFAULT FALSE")]:
            try:
                cursor.execute(f'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS {col_name} {col_type}')
            except Exception as e:
                print(f"Postgres column migration error for {col_name}: {e}")

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
            outcome VARCHAR(20), -- target / sl / stopped / cancelled
            timestamp VARCHAR(50) NOT NULL
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
        for col_def in [("email", "TEXT UNIQUE"), ("password_hash", "TEXT"), ("is_verified", "INTEGER NOT NULL DEFAULT 0")]:
            if col_def[0] not in user_cols:
                try:
                    cursor.execute(f"ALTER TABLE user ADD COLUMN {col_def[0]} {col_def[1]}")
                except Exception:
                    pass
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
            outcome TEXT, -- target / sl / stopped / cancelled
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
        
        # SQLite schema migration to add user_id column if it doesn't exist
        cursor.execute("PRAGMA table_info(trades)")
        columns = [col[1] for col in cursor.fetchall()]
        if "user_id" not in columns:
            try:
                cursor.execute("ALTER TABLE trades ADD COLUMN user_id INTEGER")
            except Exception as e:
                print(f"Migration error: {e}")
                
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

def register_user(username, email, password_hash):
    """Create a new unverified user. Returns user_id or None if duplicate."""
    conn = get_connection()
    cursor = get_cursor(conn)
    p = get_placeholder()
    u = get_user_table()
    try:
        cursor.execute(
            f"INSERT INTO {u} (username, email, password_hash, is_verified, balance) VALUES ({p}, {p}, {p}, {'FALSE' if IS_POSTGRES else 0}, 1000000.0)",
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
                is_active = {placeholder}
            WHERE user_id = {placeholder}
        """, (
            config.get('assets', 'BTC-USD'),
            float(config.get('total_capital', 10000.0)),
            float(config.get('max_risk_per_trade', 100.0)),
            float(config.get('min_profit_target', 200.0)),
            float(config.get('max_profit_target', 1000.0)),
            is_active_val,
            user_id
        ))
        conn.commit()
    except Exception as e:
        print(f"Error updating bot config: {e}")
        conn.rollback()
    finally:
        cursor.close()
        conn.close()

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

def create_pending_trade(user_id, asset, trade_type, quantity, entry_price, sl, target):
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
    SET status = 'closed', exit_price = {p}, current_price = {p}, outcome = 'cancelled', pnl = 0.0
    WHERE user_id = {p} AND asset = {p} AND status = 'pending'
    """, (entry_price, entry_price, user_id, asset))

    timestamp = datetime.now().isoformat()
    if IS_POSTGRES:
        cursor.execute(f"""
        INSERT INTO trades (user_id, asset, type, quantity, entry_price, current_price, sl, target, status, timestamp)
        VALUES ({p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, 'pending', {p})
        RETURNING id
        """, (user_id, asset, trade_type, quantity, entry_price, entry_price, sl, target, timestamp))
        trade_id = cursor.fetchone()["id"]
    else:
        cursor.execute(f"""
        INSERT INTO trades (user_id, asset, type, quantity, entry_price, current_price, sl, target, status, timestamp)
        VALUES ({p}, {p}, {p}, {p}, {p}, {p}, {p}, {p}, 'pending', {p})
        """, (user_id, asset, trade_type, quantity, entry_price, entry_price, sl, target, timestamp))
        trade_id = cursor.lastrowid
    
    conn.commit()
    conn.close()
    return trade_id

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
        
    cost = trade["quantity"] * execution_price
    user_id = trade["user_id"] if trade["user_id"] is not None else 1

    # Never let a fill push the wallet negative — reject it and cancel the order
    # instead, otherwise the simulation happily trades money it does not have.
    cursor.execute(f"SELECT balance FROM {u} WHERE id = {p}", (user_id,))
    row = cursor.fetchone()
    balance = row["balance"] if row else 0.0
    if cost > balance:
        cursor.execute(f"""
        UPDATE trades
        SET status = 'closed', exit_price = {p}, current_price = {p}, pnl = 0.0, outcome = 'cancelled'
        WHERE id = {p}
        """, (execution_price, execution_price, trade_id))
        conn.commit()
        conn.close()
        return False

    # Deduct cost from balance
    cursor.execute(f"UPDATE {u} SET balance = balance - {p} WHERE id = {p}", (cost, user_id))

    # Update trade status
    cursor.execute(f"""
    UPDATE trades
    SET status = 'active', entry_price = {p}, current_price = {p}
    WHERE id = {p}
    """, (execution_price, execution_price, trade_id))

    conn.commit()
    conn.close()
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
    entry = trade["entry_price"]
    qty = trade["quantity"]
    if trade["type"] == "buy":
        pnl = (current_price - entry) * qty
    else: # sell
        pnl = (entry - current_price) * qty
        
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
    
    cursor.execute(f"SELECT * FROM trades WHERE id = {p}", (trade_id,))
    trade = cursor.fetchone()
    if not trade or trade["status"] not in ("active", "pending"):
        conn.close()
        return
        
    qty = trade["quantity"]
    entry = trade["entry_price"]
    user_id = trade["user_id"] if trade["user_id"] is not None else 1
    
    if trade["status"] == "pending":
        # Pending trade was never funded — just mark it closed/cancelled, no refund
        cursor.execute(f"""
        UPDATE trades 
        SET status = 'closed', exit_price = {p}, current_price = {p}, pnl = 0.0, outcome = {p}
        WHERE id = {p}
        """, (exit_price, exit_price, outcome, trade_id))
        conn.commit()
        conn.close()
        return
        
    # Calculate final P&L for active trade
    if trade["type"] == "buy":
        pnl = (exit_price - entry) * qty
    else: # sell
        pnl = (entry - exit_price) * qty
        
    # Refund position value + P&L back to balance
    if trade["type"] == "buy":
        refund = qty * exit_price
    else:
        refund = qty * (2 * entry - exit_price)
        
    cursor.execute(f"UPDATE {u} SET balance = balance + {p} WHERE id = {p}", (refund, user_id))
    
    # Update trade status
    cursor.execute(f"""
    UPDATE trades 
    SET status = 'closed', exit_price = {p}, current_price = {p}, pnl = {p}, outcome = {p}
    WHERE id = {p}
    """, (exit_price, exit_price, pnl, outcome, trade_id))
    
    conn.commit()
    conn.close()

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
