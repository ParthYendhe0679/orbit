#!/usr/bin/env python3
"""
scripts/seed_demo_trades.py — One-time idempotent seed script for ORBIT demo data.

Seeds exactly 6 realistic closed historical trades for demo user 'test123'.
Adheres strictly to existing database schema, models, calculations, and authentication mappings.
Does NOT hardcode passwords or bypass authentication.
"""

import json
import os
import sys
from datetime import datetime, timedelta

# Ensure ai-service root is in sys.path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
AI_SERVICE_DIR = os.path.join(PROJECT_ROOT, "ai-service")
if AI_SERVICE_DIR not in sys.path:
    sys.path.insert(0, AI_SERVICE_DIR)

from dotenv import load_dotenv

load_dotenv(os.path.join(PROJECT_ROOT, ".env"))
load_dotenv(os.path.join(AI_SERVICE_DIR, ".env"))
load_dotenv()

import database as db

DEMO_USERNAME = "test123"

# 6 Realistic Sample Closed Trades Specification
# P&L Formula:
# Long (buy):  (exit_price - entry_price) * quantity * leverage
# Short (sell): (entry_price - exit_price) * quantity * leverage
DEMO_TRADES_SPEC = [
    {
        "asset": "BTC-USD",
        "market": "Crypto",
        "type": "buy",  # LONG
        "quantity": 0.02,
        "entry_price": 71450.00,
        "exit_price": 72250.00,
        "current_price": 72250.00,
        "sl": 70800.00,
        "target": 72500.00,
        "leverage": 2.0,
        "realized_pnl": 32.00,  # (72250 - 71450) * 0.02 * 2 = +32.00 (WIN 1)
        "outcome": "manual_close",
        "days_ago_open": 10,
        "hours_open_duration": 4.5,
    },
    {
        "asset": "XAU-USD",
        "market": "Commodities",
        "type": "buy",  # LONG
        "quantity": 0.50,
        "entry_price": 2680.50,
        "exit_price": 2705.50,
        "current_price": 2705.50,
        "sl": 2660.00,
        "target": 2710.00,
        "leverage": 2.0,
        "realized_pnl": 25.00,  # (2705.50 - 2680.50) * 0.50 * 2 = +25.00 (WIN 2)
        "outcome": "manual_close",
        "days_ago_open": 8,
        "hours_open_duration": 6.2,
    },
    {
        "asset": "XAG-USD",
        "market": "Commodities",
        "type": "sell",  # SHORT
        "quantity": 10.0,
        "entry_price": 31.80,
        "exit_price": 32.65,
        "current_price": 32.65,
        "sl": 32.65,
        "target": 30.50,
        "leverage": 2.0,
        "realized_pnl": -17.00,  # (31.80 - 32.65) * 10.0 * 2 = -17.00 (LOSS 1)
        "outcome": "sl",
        "days_ago_open": 6,
        "hours_open_duration": 5.1,
    },
    {
        "asset": "BTC-USD",
        "market": "Crypto",
        "type": "sell",  # SHORT
        "quantity": 0.025,
        "entry_price": 73800.00,
        "exit_price": 73150.00,
        "current_price": 73150.00,
        "sl": 74400.00,
        "target": 73000.00,
        "leverage": 2.0,
        "realized_pnl": 32.50,  # (73800 - 73150) * 0.025 * 2 = +32.50 (WIN 3)
        "outcome": "manual_close",
        "days_ago_open": 4,
        "hours_open_duration": 5.0,
    },
    {
        "asset": "XAU-USD",
        "market": "Commodities",
        "type": "sell",  # SHORT
        "quantity": 0.50,
        "entry_price": 2715.00,
        "exit_price": 2736.00,
        "current_price": 2736.00,
        "sl": 2736.00,
        "target": 2690.00,
        "leverage": 2.0,
        "realized_pnl": -21.00,  # (2715 - 2736) * 0.50 * 2 = -21.00 (LOSS 2)
        "outcome": "sl",
        "days_ago_open": 2,
        "hours_open_duration": 6.7,
    },
    {
        "asset": "XAG-USD",
        "market": "Commodities",
        "type": "buy",  # LONG
        "quantity": 10.0,
        "entry_price": 32.10,
        "exit_price": 33.50,
        "current_price": 33.50,
        "sl": 31.20,
        "target": 33.60,
        "leverage": 2.0,
        "realized_pnl": 28.00,  # (33.50 - 32.10) * 10.0 * 2 = +28.00 (WIN 4)
        "outcome": "target",
        "days_ago_open": 1,
        "hours_open_duration": 5.3,
    },
]


def check_demo_trades_exist(user_id: int) -> bool:
    """Check if the exact 6 demo trades are already seeded for this user."""
    conn = db.get_connection()
    cursor = db.get_cursor(conn)
    p = db.get_placeholder()

    cursor.execute(
        f"""
        SELECT id, asset, type, realized_pnl, status 
        FROM trades 
        WHERE user_id = {p} AND status = 'closed'
        ORDER BY id ASC
        """,
        (user_id,),
    )
    rows = cursor.fetchall()
    conn.close()

    if not rows or len(rows) < 6:
        return False

    # Check if the 6 specific demo trade realized_pnls match
    expected_pnls = sorted([round(t["realized_pnl"], 2) for t in DEMO_TRADES_SPEC])
    actual_pnls = sorted([round(float(r["realized_pnl"] or 0.0), 2) for r in rows])

    # If all 6 expected PnLs are present in actual_pnls and count is 6
    if len(rows) == 6 and expected_pnls == actual_pnls:
        return True

    return False


def clean_prior_user_trades(user_id: int):
    """Clean prior test trades for user 43 to guarantee exact count and win rate."""
    conn = db.get_connection()
    cursor = db.get_cursor(conn)
    p = db.get_placeholder()

    # Delete trade executions for this user's prior test trades
    cursor.execute(f"DELETE FROM trade_executions WHERE user_id = {p}", (user_id,))
    # Delete trades for this user
    cursor.execute(f"DELETE FROM trades WHERE user_id = {p}", (user_id,))
    conn.commit()
    conn.close()


def seed_demo_trades():
    # 1. Check user test123 existence
    user = db.get_user_by_username(DEMO_USERNAME)
    if not user:
        print(f"Demo user {DEMO_USERNAME} was not found.")
        sys.exit(1)

    user_id = user["id"]

    # 2. Check Idempotency
    if check_demo_trades_exist(user_id):
        print("================================")
        print("ORBIT DEMO DATA SEED")
        print("================================")
        print()
        print("Demo trades already exist.")
        print()
        print("No duplicate records inserted.")
        print()
        print("================================")
        return

    # 3. Clean up prior test trades for this demo account
    clean_prior_user_trades(user_id)

    # 4. Insert the 6 realistic closed historical trades
    conn = db.get_connection()
    cursor = db.get_cursor(conn)
    p = db.get_placeholder()
    u = db.get_user_table()

    base_time = datetime.now()
    inserted_ids = []
    total_realized_pnl = 0.0

    for spec in DEMO_TRADES_SPEC:
        open_time = base_time - timedelta(days=spec["days_ago_open"])
        close_time = open_time + timedelta(hours=spec["hours_open_duration"])

        open_ts = open_time.strftime("%Y-%m-%dT%H:%M:%S.000000")
        close_ts = close_time.strftime("%Y-%m-%dT%H:%M:%S.000000")

        pnl = float(spec["realized_pnl"])
        total_realized_pnl += pnl

        insert_trade_sql = f"""
        INSERT INTO trades (
            user_id, asset, type, quantity, entry_price, current_price, exit_price,
            sl, target, pnl, status, outcome, timestamp, leverage, margin_used,
            original_quantity, remaining_quantity, market, realized_pnl, closed_at,
            source, bot_session_id
        ) VALUES (
            {p}, {p}, {p}, {p}, {p}, {p}, {p},
            {p}, {p}, {p}, 'closed', {p}, {p}, {p}, 0.0,
            {p}, 0.0, {p}, {p}, {p},
            'manual', NULL
        )
        """
        trade_params = (
            user_id,
            spec["asset"],
            spec["type"],
            float(spec["quantity"]),
            float(spec["entry_price"]),
            float(spec["exit_price"]),
            float(spec["exit_price"]),
            float(spec["sl"]),
            float(spec["target"]),
            pnl,
            spec["outcome"],
            open_ts,
            float(spec["leverage"]),
            float(spec["quantity"]),
            spec["market"],
            pnl,
            close_ts,
        )

        if db.IS_POSTGRES:
            cursor.execute(insert_trade_sql + " RETURNING id", trade_params)
            trade_id = cursor.fetchone()["id"]
        else:
            cursor.execute(insert_trade_sql, trade_params)
            trade_id = cursor.lastrowid

        inserted_ids.append(trade_id)

        # Record OPEN execution event in audit log
        open_meta = json.dumps({"source": "manual", "demo": True, "action": "OPEN"})
        cursor.execute(
            f"""
            INSERT INTO trade_executions (position_id, user_id, action, quantity, price, realized_pnl, timestamp, metadata)
            VALUES ({p}, {p}, 'OPEN', {p}, {p}, 0.0, {p}, {p})
            """,
            (trade_id, user_id, float(spec["quantity"]), float(spec["entry_price"]), open_ts, open_meta),
        )

        # Record FULL_CLOSE execution event in audit log
        close_meta = json.dumps({"source": "manual", "demo": True, "outcome": spec["outcome"], "action": "FULL_CLOSE"})
        cursor.execute(
            f"""
            INSERT INTO trade_executions (position_id, user_id, action, quantity, price, realized_pnl, timestamp, metadata)
            VALUES ({p}, {p}, 'FULL_CLOSE', {p}, {p}, {p}, {p}, {p})
            """,
            (trade_id, user_id, float(spec["quantity"]), float(spec["exit_price"]), pnl, close_ts, close_meta),
        )

    # 5. Update user balance with settled net realized PnL from starting base
    new_balance = round(1000000.0 + total_realized_pnl, 2)
    cursor.execute(f"UPDATE {u} SET balance = {p} WHERE id = {p}", (new_balance, user_id))

    conn.commit()
    conn.close()

    # 6. Invalidate Valkey / memory cache for user 43
    try:
        from services.valkey_service import valkey_service, cache_service
        cache_service.delete(f"portfolio:{user_id}")
        cache_service.delete(f"positions:{user_id}")
        valkey_service.delete(f"dashboard:{user_id}:metrics")
        valkey_service.delete(f"trade:active:{user_id}")
    except Exception:
        pass

    # 7. Print summary exactly as requested
    print("================================")
    print("ORBIT DEMO DATA SEED")
    print("================================")
    print()
    print("Demo User:")
    print(DEMO_USERNAME)
    print()
    print("Database User:")
    print(user_id)
    print()
    print()
    print("Trades Inserted:")
    print(len(inserted_ids))
    print()
    print()
    print("Assets:")
    print()
    print("BTC:")
    print("2 Trades")
    print()
    print("Gold:")
    print("2 Trades")
    print()
    print("Silver:")
    print("2 Trades")
    print()
    print()
    print("Results:")
    print()
    print("Winning Trades:")
    print("4")
    print()
    print("Losing Trades:")
    print("2")
    print()
    print("Win Rate:")
    print("66.67%")
    print()
    print()
    print("Status:")
    print("SUCCESS")
    print()
    print("================================")


if __name__ == "__main__":
    seed_demo_trades()
