import database as db

# How far price may drift away from the planned entry before an unconfirmed
# order is considered stale and withdrawn.
MAX_ENTRY_DRIFT_PCT = 0.02


def check_and_execute_trades(current_price, log_func=None, user_id=None):
    """
    Order-desk agent: manages PENDING orders that are waiting for the trader
    to confirm them.

    It does NOT close active positions — that belongs to the P&L Manager
    (portfolio_monitor). Both agents used to close on SL/target with different
    fill prices and different outcome labels, so whichever ran first won and the
    P&L Manager's break-even logic never got a chance to run.

    An order is withdrawn when the setup is no longer valid:
      * price has already traded through the planned stop loss, or
      * price has drifted more than MAX_ENTRY_DRIFT_PCT away from the entry.

    Returns True if any order was withdrawn (so the caller can resync the UI).
    """
    if current_price is None or current_price <= 0:
        return False

    changed = False

    for trade in db.get_active_positions(user_id):
        if trade["status"] != "pending":
            continue

        trade_id = trade["id"]
        asset = trade["asset"]
        trade_type = trade["type"]
        entry = trade["entry_price"]
        sl = trade["sl"]

        invalidated = (
            (trade_type == "buy" and current_price <= sl)
            or (trade_type == "sell" and current_price >= sl)
        )
        drift = abs(current_price - entry) / entry if entry else 0.0

        if invalidated:
            if log_func:
                log_func(
                    "Execution Agent",
                    f"[ORDER WITHDRAWN] {asset} traded through the planned stop "
                    f"({current_price:.2f} vs SL {sl:.2f}) before confirmation. Setup invalidated.",
                )
            db.close_trade(trade_id, current_price, "cancelled")
            changed = True
        elif drift > MAX_ENTRY_DRIFT_PCT:
            if log_func:
                log_func(
                    "Execution Agent",
                    f"[ORDER WITHDRAWN] {asset} moved {drift * 100:.2f}% away from the planned "
                    f"entry of {entry:.2f}. Order is stale.",
                )
            db.close_trade(trade_id, current_price, "cancelled")
            changed = True

    return changed
