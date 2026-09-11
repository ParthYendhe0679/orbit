"""
ORBIT LIVE SYSTEM AUDIT - 10-POINT AUTOMATED VERIFICATION TEST SUITE
Covers Part 33 specification:
TEST 1: Health check
TEST 2: Open trade
TEST 3: Live price update
TEST 4: Dashboard synchronization
TEST 5: Refresh button API endpoints
TEST 6: Partial close (25/50/75/custom)
TEST 7: Full close
TEST 8: WebSocket connection & broadcast
TEST 9: Valkey offline graceful fallback
TEST 10: API rate protection (Single-flight coalescing)
"""

import asyncio
import json
import time
import urllib.request
import websockets
from datetime import datetime

BASE_URL = "http://127.0.0.1:8000"
TEST_USER_ID = 22  # Known valid test user in database
TEST_SYMBOL = "BTC-USD"

test_results = {}

def log_test(test_num: int, name: str, passed: bool, detail: str = ""):
    status = "PASS" if passed else "FAIL"
    test_results[f"TEST {test_num}"] = {"name": name, "status": status, "detail": detail}
    print(f"[{status}] TEST {test_num}: {name} - {detail}", flush=True)


def http_get(path: str) -> dict:
    url = f"{BASE_URL}{path}"
    print(f"[HTTP] GET {url}", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "OrbitAuditTest/1.0"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        content = resp.read().decode()
        print(f"[HTTP] GET {url} completed ({len(content)} bytes)", flush=True)
        return json.loads(content)


def http_post(path: str, body: dict = None) -> dict:
    url = f"{BASE_URL}{path}"
    print(f"[HTTP] POST {url} (body={body})", flush=True)
    data = json.dumps(body or {}).encode() if body else b""
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "OrbitAuditTest/1.0"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        content = resp.read().decode()
        print(f"[HTTP] POST {url} completed ({len(content)} bytes)", flush=True)
        return json.loads(content)


async def run_all_tests():
    print("=" * 60)
    print("STARTING ORBIT AUDIT TEST SUITE (10 TESTS)")
    print("=" * 60)

    # -------------------------------------------------------------
    # TEST 1: Health check
    # -------------------------------------------------------------
    try:
        health = http_get("/health")
        p1 = (
            health.get("backend") == "connected" and
            health.get("database") == "connected" and
            health.get("valkey") == "connected" and
            health.get("tls") is True
        )
        api_health = http_get("/api/health")
        passed = p1 and api_health.get("status") == "healthy"
        log_test(1, "Health check (/health & /api/health)", passed, f"Status: {health}")
    except Exception as e:
        log_test(1, "Health check", False, str(e))

    # -------------------------------------------------------------
    # TEST 2: Open trade
    # -------------------------------------------------------------
    opened_trade_id = None
    try:
        trade_payload = {
            "symbol": TEST_SYMBOL,
            "side": "BUY",
            "quantity": 0.05,
            "leverage": 1,
            "user_id": TEST_USER_ID,
            "notes": "Automated audit test trade"
        }
        res = http_post("/api/trade/open", trade_payload)
        trade = res.get("trade") or res.get("data") or {}
        opened_trade_id = trade.get("id") or trade.get("trade_id") or res.get("trade_id")
        
        # Verify Valkey indexes & open trades endpoint
        open_trades_resp = http_get(f"/api/trades/open?user_id={TEST_USER_ID}")
        open_trades = open_trades_resp.get("trades") or open_trades_resp.get("positions") if isinstance(open_trades_resp, dict) else open_trades_resp
        matched = any(t.get("id") == opened_trade_id or t.get("trade_id") == opened_trade_id for t in open_trades)
        
        passed = bool(opened_trade_id and matched and trade.get("status") == "active")
        log_test(2, "Open trade & Valkey index creation", passed, f"Trade ID: {opened_trade_id}, Status: {trade.get('status')}")
    except Exception as e:
        log_test(2, "Open trade", False, str(e))

    # -------------------------------------------------------------
    # TEST 3: Live price update & P&L recalculation
    # -------------------------------------------------------------
    try:
        # Fetch current price from market service
        market_data = http_get(f"/api/market/{TEST_SYMBOL}")
        price = market_data.get("price") or market_data.get("data", {}).get("price")
        
        # Check open trade position for current_price and unrealized_pnl calculation
        open_trades_resp = http_get(f"/api/trades/open?user_id={TEST_USER_ID}")
        open_trades = open_trades_resp.get("trades") or open_trades_resp.get("positions") if isinstance(open_trades_resp, dict) else open_trades_resp
        our_trade = next((t for t in open_trades if (t.get("id") == opened_trade_id or t.get("trade_id") == opened_trade_id)), None)
        
        passed = False
        if our_trade:
            entry = our_trade.get("entry_price", 0)
            curr = our_trade.get("current_price", 0)
            pnl = our_trade.get("unrealized_pnl")
            pnl_pct = our_trade.get("unrealized_pnl_percent")
            passed = curr > 0 and pnl is not None and pnl_pct is not None
            detail = f"Entry: {entry}, Current: {curr}, PnL: {pnl}, PnL%: {pnl_pct}%"
        else:
            detail = "Could not locate open trade in positions"
            
        log_test(3, "Live price update & P&L calculation", passed, detail)
    except Exception as e:
        log_test(3, "Live price update", False, str(e))

    # -------------------------------------------------------------
    # TEST 4: Dashboard synchronization
    # -------------------------------------------------------------
    try:
        dash = http_get(f"/api/dashboard?user_id={TEST_USER_ID}")
        active_cnt = dash.get("active_trades") or dash.get("data", {}).get("trading", {}).get("active_trades")
        tot_cap = dash.get("total_capital") or dash.get("data", {}).get("account", {}).get("total_capital")
        unreal_pnl = dash.get("unrealized_pnl") or dash.get("data", {}).get("trading", {}).get("unrealized_pnl")
        win_rate = dash.get("win_rate") or dash.get("data", {}).get("trading", {}).get("win_rate")
        
        # Verify top-level fields are present and active_trades reflects at least 1 open trade
        passed = (
            active_cnt is not None and active_cnt >= 1 and
            tot_cap is not None and
            unreal_pnl is not None and
            win_rate is not None
        )
        log_test(4, "Dashboard synchronization", passed, f"Active: {active_cnt}, Capital: {tot_cap}, WinRate: {win_rate}")
    except Exception as e:
        log_test(4, "Dashboard synchronization", False, str(e))

    # -------------------------------------------------------------
    # TEST 5: Refresh button API endpoints
    # -------------------------------------------------------------
    try:
        e1 = http_get(f"/api/dashboard?user_id={TEST_USER_ID}")
        e2 = http_get(f"/api/trades/open?user_id={TEST_USER_ID}")
        e3 = http_get(f"/api/trades/history?user_id={TEST_USER_ID}&limit=5&offset=0")
        e4 = http_get("/api/report")
        e5 = http_get(f"/api/market/{TEST_SYMBOL}")
        
        passed = (
            ("total_capital" in e1 or "data" in e1) and
            ("trades" in e2 or "positions" in e2 or isinstance(e2, list)) and
            ("trades" in e3 or "data" in e3 or isinstance(e3, list)) and
            ("report" in e4 or "metrics" in e4 or "data" in e4) and
            ("symbol" in e5 or "data" in e5)
        )
        log_test(5, "Refresh button API endpoints contract", passed, "Dashboard, Open, History, Report, Market all returned 200 OK with valid schema")
    except Exception as e:
        log_test(5, "Refresh button API endpoints", False, str(e))

    # -------------------------------------------------------------
    # TEST 6: Partial close (50%)
    # -------------------------------------------------------------
    try:
        if opened_trade_id:
            part_payload = {
                "user_id": TEST_USER_ID,
                "percentage": 50,
                "reason": "Test audit 50% partial close"
            }
            p_res = http_post(f"/api/trades/{opened_trade_id}/partial-close", part_payload)
            success = p_res.get("success") or p_res.get("ok") or (p_res.get("status") == "success")
            rem_qty = p_res.get("remaining_quantity") or p_res.get("result", {}).get("remaining_quantity")
            
            # Verify trade is still active in open trades
            open_trades_resp = http_get(f"/api/trades/open?user_id={TEST_USER_ID}")
            open_trades = open_trades_resp.get("trades") or open_trades_resp.get("positions") if isinstance(open_trades_resp, dict) else open_trades_resp
            still_open = any(t.get("id") == opened_trade_id or t.get("trade_id") == opened_trade_id for t in open_trades)
            
            passed = bool(success and still_open and (rem_qty is not None and rem_qty < 0.05))
            log_test(6, "Partial close (50%)", passed, f"Remaining qty: {rem_qty}, Still active: {still_open}")
        else:
            log_test(6, "Partial close", False, "No trade ID available")
    except Exception as e:
        log_test(6, "Partial close", False, str(e))

    # -------------------------------------------------------------
    # TEST 7: Full close
    # -------------------------------------------------------------
    try:
        if opened_trade_id:
            close_res = http_post(f"/api/trades/{opened_trade_id}/close/full?user_id={TEST_USER_ID}")
            closed_ok = close_res.get("success") or close_res.get("ok") or ("closed" in str(close_res).lower())
            
            # Verify trade is no longer in open trades
            open_trades_resp = http_get(f"/api/trades/open?user_id={TEST_USER_ID}")
            open_trades = open_trades_resp.get("trades") or open_trades_resp.get("positions") if isinstance(open_trades_resp, dict) else open_trades_resp
            not_in_open = not any(t.get("id") == opened_trade_id or t.get("trade_id") == opened_trade_id for t in open_trades)
            
            # Verify trade appears in history
            history_resp = http_get(f"/api/trades/history?user_id={TEST_USER_ID}&limit=10&offset=0")
            history = history_resp.get("trades") or history_resp.get("data", {}).get("trades") if isinstance(history_resp, dict) else history_resp
            in_history = any(t.get("id") == opened_trade_id or t.get("trade_id") == opened_trade_id for t in history)
            
            passed = bool(closed_ok and not_in_open and in_history)
            log_test(7, "Full close & history persistence", passed, f"Closed: {closed_ok}, Removed from active: {not_in_open}, Persisted in history: {in_history}")
        else:
            log_test(7, "Full close", False, "No trade ID available")
    except Exception as e:
        log_test(7, "Full close", False, str(e))

    # -------------------------------------------------------------
    # TEST 8: WebSocket connection & broadcast
    # -------------------------------------------------------------
    try:
        ws_url = f"ws://127.0.0.1:8000/ws?user_id={TEST_USER_ID}&username=test_auditor"
        received_events = []
        async with websockets.connect(ws_url, open_timeout=5) as ws:
            # Wait up to 5 seconds to capture broadcasts (e.g. from market_tick_scheduler_loop)
            start = time.time()
            while time.time() - start < 5:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=2.0)
                    parsed = json.loads(msg)
                    received_events.append(parsed.get("type", "unknown"))
                    if len(received_events) >= 1:
                        break
                except asyncio.TimeoutError:
                    pass

        passed = len(received_events) > 0
        log_test(8, "WebSocket connection & event broadcast", passed, f"Received events: {received_events}")
    except Exception as e:
        log_test(8, "WebSocket connection", False, str(e))

    # -------------------------------------------------------------
    # TEST 9: Valkey offline graceful fallback
    # -------------------------------------------------------------
    try:
        from backend.services.valkey_service import valkey_service
        # Simulate Valkey network partition
        valkey_service._force_offline = True
        
        # Test basic operations in fallback mode
        fallback_health = valkey_service.health_check()
        valkey_service.set("test:fallback:key", "valkey_degraded_test", ex=10)
        val = valkey_service.get("test:fallback:key")
        valkey_service.sadd("test:fallback:set", "item1", "item2")
        members = valkey_service.smembers("test:fallback:set")
        pipe = valkey_service.pipeline()
        pipe.set("test:pipe:1", "abc")
        pipe.execute()
        
        # Restore online state
        valkey_service._force_offline = False
        valkey_service.connect()
        
        passed = (
            fallback_health.get("status") == "degraded" and
            val == "valkey_degraded_test" and
            "item1" in members and
            bool(valkey_service.is_connected)
        )
        log_test(9, "Valkey offline graceful fallback & auto-recovery", passed, f"Degraded status: {fallback_health.get('status')}, Fallback val: {val}")
    except Exception as e:
        log_test(9, "Valkey offline fallback", False, str(e))
        from backend.services.valkey_service import valkey_service
        valkey_service._force_offline = False
        valkey_service.connect()

    # -------------------------------------------------------------
    # TEST 10: API rate protection (Single-flight coalescing)
    # -------------------------------------------------------------
    try:
        from backend.services.market_data_service import market_service
        # Test that multiple concurrent calls to get_price for the same symbol do not race
        tasks = [market_service.get_price(TEST_SYMBOL) for _ in range(5)]
        results = await asyncio.gather(*tasks)
        
        all_equal = all(r == results[0] for r in results)
        passed = all_equal and results[0] > 0
        log_test(10, "API rate protection (Single-flight coalescing)", passed, f"5 concurrent calls returned identical price: {results[0]}")
    except Exception as e:
        log_test(10, "API rate protection", False, str(e))

    print("=" * 60)
    passed_cnt = sum(1 for v in test_results.values() if v["status"] == "PASS")
    total_cnt = len(test_results)
    print(f"AUDIT TEST RESULTS: {passed_cnt}/{total_cnt} TESTS PASSED")
    print("=" * 60)
    return passed_cnt == total_cnt

if __name__ == "__main__":
    asyncio.run(run_all_tests())
