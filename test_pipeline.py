import asyncio
import sys
import traceback
sys.path.insert(0, "ai-service")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import pandas as pd
import database as db
from services.market_data_service import market_service

from agents.chart_analyst import find_support_resistance
from agents.indicator_analyst import analyze_indicators
from agents.news_analyst import analyze_sentiment
from agents.strategy_judge import evaluate_strategies
from agents.risk_planner import plan_trade
from agents.execution_agent import check_and_execute_trades
from agents.portfolio_monitor import monitor_positions

def log(agent, msg):
    safe_msg = str(msg)
    try:
        print(f"  [{agent}] {safe_msg}")
    except UnicodeEncodeError:
        print(f"  [{agent}] {safe_msg.encode('ascii', 'replace').decode('ascii')}")

try:
    print("Step 1: Init DB...")
    db.init_db()

    print("Step 2: Retrieving market data via MarketDataService...")
    df = asyncio.run(market_service.get_normalized_dataframe("BTC-USD", period="60d", interval="1d"))
    print(f"  Retrieved {len(df)} validated rows. Columns: {list(df.columns)}")

    latest_close = float(df["Close"].iloc[-1])
    print(f"  Latest close: {latest_close:.2f}")

    print("\nStep 3: Chart Analyst...")
    sr_data = find_support_resistance(df, window=5, log_func=log)
    print(f"  Supports: {sr_data['supports']}")
    print(f"  Resistances: {sr_data['resistances']}")

    print("\nStep 4: Indicator Analyst...")
    tech_res = analyze_indicators(df, log_func=log)
    print(f"  Result: {tech_res}")

    print("\nStep 5: News Analyst...")
    sentiment_res = analyze_sentiment("BTC-USD", log_func=log)
    sentiment_score = sentiment_res["score"]
    print(f"  Score: {sentiment_score}")

    print("\nStep 6: Strategy Judge...")
    strategy_res = evaluate_strategies(df, sr_data["supports"], sr_data["resistances"], log_func=log)
    print(f"  Signal: {strategy_res['signal']}, Buy: {strategy_res['votes_buy']}, Sell: {strategy_res['votes_sell']}")

    print("\nStep 7: Risk Planner...")
    user_id = 1
    wallet_balance = db.get_user_balance(user_id)
    print(f"  Wallet: {wallet_balance}")
    trade_setup = plan_trade(
        strategy_res,
        sentiment_score,
        sr_data["supports"],
        sr_data["resistances"],
        latest_close,
        wallet_balance,
        log_func=log,
        strategy_reasoning=strategy_res.get("reasoning", "")
    )
    print(f"  Trade setup: {trade_setup}")

    print("\nStep 8: Execution Agent...")
    result = check_and_execute_trades(latest_close, log_func=log, user_id=user_id)
    print(f"  Executed: {result}")

    print("\nStep 9: Portfolio Monitor...")
    result = monitor_positions(latest_close, log_func=log, user_id=user_id)
    print(f"  Closed: {result}")

    print("\n=== ALL STEPS PASSED ===")

except Exception as e:
    print(f"\n=== ERROR ===")
    print(f"Exception: {e}")
    traceback.print_exc()
