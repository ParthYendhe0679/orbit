import database as db

# Break-even rule: once a position is this far in profit, the stop is pulled up
# to the entry price so the trade can no longer lose money.
BREAK_EVEN_TRIGGER_PCT = 0.015

# Human-readable names for the outcome codes stored on the trade row.
OUTCOME_LABELS = {"sl": "stop loss", "target": "target", "cancelled": "cancelled"}


def monitor_positions(current_price, log_func=None, user_id=None):
    active_positions = db.get_active_positions(user_id)
    closed_any = False
    
    for trade in active_positions:
        if trade["status"] != "active":
            continue
            
        trade_id = trade["id"]
        asset = trade["asset"]
        trade_type = trade["type"]
        entry = trade["entry_price"]
        sl = trade["sl"]
        target = trade["target"]
        qty = trade["quantity"]
        
        # 1. Update current price and calculate unrealized P&L
        db.update_active_position_price(trade_id, current_price)
        
        # Fetch updated trade from DB to get the latest P&L
        updated_trade = db.get_trade(trade_id)
        
        if not updated_trade:
            continue
            
        unrealized_pnl = updated_trade["pnl"]
        
        # 2. Check Break-Even Rule (Lock in profit)
        # If trade is up more than 1.5% and SL is not already at entry
        percent_profit = (current_price - entry) / entry if trade_type == "buy" else (entry - current_price) / entry
        
        if percent_profit >= BREAK_EVEN_TRIGGER_PCT:
            is_sl_at_entry = (sl == entry)
            if not is_sl_at_entry:
                # Update SL to Entry in database
                db.update_trade_sl(trade_id, entry)
                if log_func:
                    log_func("P&L Manager", f"Position up {percent_profit*100:.1f}%! Moved Stop Loss to break-even ({entry:.2f} INR) to lock in a risk-free state.")
                sl = entry # Update local variable for checking exit
                
        # 3. Check for SL / Take Profit triggers
        should_close = False
        exit_price = current_price
        outcome = "target"

        if trade_type == "buy":
            if current_price <= sl:
                should_close = True
                exit_price = sl  # Assume execution at SL (no slippage)
                outcome = "sl"
            elif current_price >= target:
                should_close = True
                exit_price = target  # Assume execution at Target
                outcome = "target"
        else: # sell
            if current_price >= sl:
                should_close = True
                exit_price = sl
                outcome = "sl"
            elif current_price <= target:
                should_close = True
                exit_price = target
                outcome = "target"
                
        if should_close:
            if log_func:
                log_func("P&L Manager", f"Price hit {OUTCOME_LABELS.get(outcome, outcome).upper()} level ({exit_price:.2f} INR). Closing position...")
                
            db.close_trade(trade_id, exit_price, outcome)
            closed_any = True
            
            # Calculate final realized P&L
            if trade_type == "buy":
                final_pnl = (exit_price - entry) * qty
            else:
                final_pnl = (entry - exit_price) * qty
                
            if log_func:
                pnl_sign = "+" if final_pnl >= 0 else ""
                log_func("P&L Manager", f"[POSITION CLOSED] Trade on {asset} closed. Exit price: {exit_price:.2f} INR. Realized P&L: {pnl_sign}{final_pnl:.2f} INR ({OUTCOME_LABELS.get(outcome, outcome).upper()}).")
                
    return closed_any
