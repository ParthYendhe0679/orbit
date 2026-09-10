import llm as llm

# Fraction of total equity put at risk on a single trade.
RISK_PER_TRADE_PCT = 0.01
# Take profit distance as a multiple of the stop distance (1:2 R:R).
REWARD_MULTIPLE = 2.0
# Sentiment strong enough to veto a technical signal pointing the other way.
SENTIMENT_VETO = 0.30


def _hold(reason, log_func=None):
    """
    A 'hold' decision. Every numeric field is present (as None) so that callers
    can read trade_setup["entry"] without a KeyError before checking the action.
    """
    if log_func:
        log_func("Risk Planner", reason)
    return {
        "action": "hold",
        "reason": reason,
        "entry": None,
        "sl": None,
        "target": None,
        "quantity": 0.0,
        "risk_reward_ratio": REWARD_MULTIPLE,
        "risk_brief": "",
    }


def plan_trade(consensus, sentiment_score, supports, resistances, current_price, wallet_balance, log_func=None, strategy_reasoning=None):
    if log_func:
        log_func("Risk Planner", "Checking risk parameters and alignment between strategy consensus and news sentiment...")

    signal = consensus["signal"]

    # 1. Align signal with sentiment
    if signal == "buy" and sentiment_score < -SENTIMENT_VETO:
        return _hold(
            f"BLOCKED: Buy consensus rejected because News Sentiment is highly negative ({sentiment_score:.2f}).",
            log_func,
        )

    if signal == "sell" and sentiment_score > SENTIMENT_VETO:
        return _hold(
            f"BLOCKED: Sell consensus rejected because News Sentiment is highly positive ({sentiment_score:.2f}).",
            log_func,
        )

    if signal not in ("buy", "sell"):
        return _hold("No trade planned. System is currently holding.", log_func)

    # A non-positive price means the feed gave us garbage — never size a trade off it.
    if not current_price or current_price <= 0:
        return _hold("No trade planned. Received an invalid market price.", log_func)

    if not wallet_balance or wallet_balance <= 0:
        return _hold("No trade planned. Wallet balance is exhausted.", log_func)


    # 2. Plan levels: Stop Loss (SL) & Take Profit (Target)
    entry = current_price
    
    if signal == "buy":
        # Stop loss below closest support, but at least 1% and at most 4% below entry
        sl = current_price * 0.98  # Default 2%
        if supports:
            closest_support = supports[0] # Sorted closest first
            if current_price * 0.96 <= closest_support <= current_price * 0.99:
                sl = closest_support * 0.995 # Slightly below support
                
        # Take profit enforcing the configured risk-to-reward ratio
        risk_per_unit = entry - sl
        target = entry + (risk_per_unit * REWARD_MULTIPLE)
        
    else: # sell
        # Stop loss above closest resistance, but at least 1% and at most 4% above entry
        sl = current_price * 1.02  # Default 2%
        if resistances:
            closest_res = resistances[0] # Sorted closest first
            if current_price * 1.01 <= closest_res <= current_price * 1.04:
                sl = closest_res * 1.005 # Slightly above resistance
                
        # Take profit enforcing the configured risk-to-reward ratio
        risk_per_unit = sl - entry
        target = entry - (risk_per_unit * REWARD_MULTIPLE)
        
    # Round levels
    entry = round(entry, 2)
    sl = round(sl, 2)
    target = round(target, 2)
    
    # 3. Position Sizing (risk a fixed fraction of total wallet capital)
    capital_at_risk = wallet_balance * RISK_PER_TRADE_PCT
    risk_per_share = abs(entry - sl)
    
    if risk_per_share <= 0:
        risk_per_share = entry * 0.01 # Fallback
        
    quantity = capital_at_risk / risk_per_share
    
    # Capital cap (Cannot buy more than our total wallet balance allows)
    max_qty = wallet_balance / entry
    if quantity > max_qty:
        quantity = max_qty
        
    # Round quantity to 4 decimal places (useful for crypto, round to 1/0 for stocks if needed, but 4 is safe)
    quantity = round(quantity, 4)
    total_cost = round(quantity * entry, 2)
    
    fallback_brief = (
        f"Capital at risk is capped at {RISK_PER_TRADE_PCT * 100:.2f}% of equity. "
        f"Stop loss placed at {sl:.2f} INR with a 1:{REWARD_MULTIPLE} risk-to-reward ratio."
    )

    prompt = (
        "You are an expert risk planner for a hedge fund. Review the following trade setup "
        "and write a concise 1-to-2 sentence risk briefing explaining the placement of the "
        f"Stop Loss, Take Profit, and why the capital allocation ({RISK_PER_TRADE_PCT * 100:.0f}% risk) "
        "is secure for this setup.\n"
        f"- Action: {'LONG' if signal == 'buy' else 'SHORT'}\n"
        f"- Entry Price: {entry:.2f} INR\n"
        f"- Stop Loss: {sl:.2f} INR\n"
        f"- Take Profit: {target:.2f} INR\n"
        f"- Position Size: {quantity} units (Cost: {total_cost:.2f} INR)\n"
        f"- Strategy Reasoning: {strategy_reasoning or 'None'}\n\n"
        "Output ONLY the risk brief sentences, nothing else."
    )
    risk_brief = llm.generate_text(prompt, log_func=log_func, agent_name="Risk Planner") or fallback_brief

    if log_func:
        direction = "LONG" if signal == "buy" else "SHORT"
        log_func("Risk Planner", f"PLANNING {direction} TRADE:")
        log_func("Risk Planner", f"  - Capital: {wallet_balance:.2f} INR | {RISK_PER_TRADE_PCT * 100:.0f}% Risk Allocation: {capital_at_risk:.2f} INR")
        log_func("Risk Planner", f"  - Entry Price: {entry:.2f} INR")
        log_func("Risk Planner", f"  - Stop Loss: {sl:.2f} INR (Risk: {risk_per_share:.2f} INR per unit)")
        log_func("Risk Planner", f"  - Take Profit: {target:.2f} INR (Reward: {(risk_per_share * REWARD_MULTIPLE):.2f} INR per unit)")
        log_func("Risk Planner", f"  - Risk-to-Reward Ratio: 1:{REWARD_MULTIPLE}")
        log_func("Risk Planner", f"  - Quantity to Trade: {quantity} units (Est. Cost: {total_cost:.2f} INR)")
        if risk_brief:
            log_func("Risk Planner", f"  - Risk Brief: {risk_brief}")
        
    return {
        "action": signal,
        "entry": entry,
        "sl": sl,
        "target": target,
        "quantity": quantity,
        "risk_reward_ratio": REWARD_MULTIPLE,
        "risk_brief": risk_brief
    }
