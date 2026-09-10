"""
reporting.py — turns the raw trades table into a performance report.

Everything here is pure computation over a list of trade dicts, with no
database or FastAPI imports, so the numbers can be unit-tested directly and
reused by any caller (the API, a CSV export, or a future scheduled digest).

The statistics are the standard trading-journal set. Two of them are worth
spelling out because they are the ones people usually get wrong:

  * profit factor — gross profit / gross loss. Above 1.0 the system makes
    money; it is a far better health check than win rate, because a 30% win
    rate with 4:1 winners beats a 70% win rate with 1:4 winners.
  * max drawdown — the deepest peak-to-trough fall of the cumulative P&L
    curve, which is what actually determines whether an account survives.
"""

from datetime import datetime


def _num(value, default=0.0) -> float:
    """Coerce a database value to a float without exploding on None/''/text."""
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _is_win(trade) -> bool:
    return _num(trade.get("pnl")) > 0


def _month_of(timestamp: str) -> str:
    """'YYYY-MM' bucket from whatever timestamp format the row carries."""
    if not timestamp:
        return "unknown"
    text = str(timestamp)
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text[:19], fmt).strftime("%Y-%m")
        except ValueError:
            continue
    # Fall back to a plain prefix slice rather than dropping the trade.
    return text[:7] if len(text) >= 7 else "unknown"


def build_equity_curve(closed_trades, starting_balance=0.0):
    """
    Cumulative realised P&L after each closed trade, oldest first.

    Returned as a list of points the frontend can plot directly. `balance` is
    included so the curve can be shown in rupees rather than as a delta.
    """
    curve = []
    cumulative = 0.0
    for index, trade in enumerate(closed_trades, start=1):
        cumulative += _num(trade.get("pnl"))
        curve.append({
            "n": index,
            "trade_id": trade.get("id"),
            "timestamp": trade.get("timestamp"),
            "asset": trade.get("asset"),
            "pnl": round(_num(trade.get("pnl")), 2),
            "cumulative": round(cumulative, 2),
            "balance": round(starting_balance + cumulative, 2),
        })
    return curve


def max_drawdown(curve):
    """
    Deepest peak-to-trough decline of the cumulative curve.

    Returns the absolute rupee drop and the percentage of the running peak it
    represented. A curve that only ever rises has zero drawdown.
    """
    peak = 0.0
    worst_abs = 0.0
    worst_pct = 0.0
    for point in curve:
        value = point["cumulative"]
        peak = max(peak, value)
        drop = peak - value
        if drop > worst_abs:
            worst_abs = drop
            # Percentage is only meaningful once the curve has been positive.
            worst_pct = (drop / peak * 100) if peak > 0 else 0.0
    return round(worst_abs, 2), round(worst_pct, 2)


def streaks(closed_trades):
    """Longest consecutive winning and losing runs."""
    best_win = best_loss = run_win = run_loss = 0
    for trade in closed_trades:
        if _is_win(trade):
            run_win += 1
            run_loss = 0
        else:
            run_loss += 1
            run_win = 0
        best_win = max(best_win, run_win)
        best_loss = max(best_loss, run_loss)
    return best_win, best_loss


def _group_stats(trades, key):
    """Aggregate P&L per distinct value of `key` (asset, month, direction…)."""
    buckets = {}
    for trade in trades:
        name = trade.get(key) or "unknown"
        bucket = buckets.setdefault(name, {"name": name, "trades": 0, "wins": 0, "pnl": 0.0})
        bucket["trades"] += 1
        bucket["wins"] += 1 if _is_win(trade) else 0
        bucket["pnl"] += _num(trade.get("pnl"))

    for bucket in buckets.values():
        bucket["pnl"] = round(bucket["pnl"], 2)
        bucket["losses"] = bucket["trades"] - bucket["wins"]
        bucket["win_rate"] = round(bucket["wins"] / bucket["trades"] * 100, 1) if bucket["trades"] else 0.0

    return sorted(buckets.values(), key=lambda b: b["pnl"], reverse=True)


def build_report(all_trades, starting_balance=0.0):
    """
    Full performance report over every trade belonging to one user.

    `all_trades` is the raw rows from the trades table, chronological. Open and
    pending trades are reported separately from the closed ones, because
    unrealised P&L must never contaminate realised performance statistics.
    """
    closed = [t for t in all_trades if t.get("status") == "closed"]
    open_trades = [t for t in all_trades if t.get("status") == "active"]
    pending = [t for t in all_trades if t.get("status") == "pending"]

    wins = [t for t in closed if _is_win(t)]
    losses = [t for t in closed if not _is_win(t)]

    gross_profit = sum(_num(t.get("pnl")) for t in wins)
    gross_loss = abs(sum(_num(t.get("pnl")) for t in losses))
    net_pnl = gross_profit - gross_loss

    total_closed = len(closed)
    win_rate = (len(wins) / total_closed * 100) if total_closed else 0.0
    avg_win = (gross_profit / len(wins)) if wins else 0.0
    avg_loss = (gross_loss / len(losses)) if losses else 0.0

    # Profit factor is undefined with no losses; report it as None rather than
    # inventing an infinity the frontend would have to special-case anyway.
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else None

    # Expectancy: average rupees won or lost per trade taken.
    expectancy = (net_pnl / total_closed) if total_closed else 0.0

    curve = build_equity_curve(closed, starting_balance)
    dd_abs, dd_pct = max_drawdown(curve)
    win_streak, loss_streak = streaks(closed)

    best = max(closed, key=lambda t: _num(t.get("pnl")), default=None)
    worst = min(closed, key=lambda t: _num(t.get("pnl")), default=None)

    unrealized = sum(
        (_num(t.get("current_price")) - _num(t.get("entry_price")))
        * _num(t.get("quantity"))
        * (1 if t.get("type") == "buy" else -1)
        for t in open_trades
    )

    # Month buckets are derived, so they need a synthetic column to group on.
    for trade in closed:
        trade["_month"] = _month_of(trade.get("timestamp"))

    return {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "summary": {
            "total_trades": len(all_trades),
            "closed_trades": total_closed,
            "open_trades": len(open_trades),
            "pending_trades": len(pending),
            "wins": len(wins),
            "losses": len(losses),
            "win_rate": round(win_rate, 1),
            "net_pnl": round(net_pnl, 2),
            "gross_profit": round(gross_profit, 2),
            "gross_loss": round(gross_loss, 2),
            "profit_factor": round(profit_factor, 2) if profit_factor is not None else None,
            "expectancy": round(expectancy, 2),
            "avg_win": round(avg_win, 2),
            "avg_loss": round(avg_loss, 2),
            "best_trade": round(_num(best.get("pnl")), 2) if best else 0.0,
            "worst_trade": round(_num(worst.get("pnl")), 2) if worst else 0.0,
            "max_drawdown": dd_abs,
            "max_drawdown_pct": dd_pct,
            "longest_win_streak": win_streak,
            "longest_loss_streak": loss_streak,
            "unrealized_pnl": round(unrealized, 2),
            "starting_balance": round(starting_balance, 2),
        },
        "equity_curve": curve,
        "by_asset": _group_stats(closed, "asset"),
        "by_direction": _group_stats(closed, "type"),
        "by_outcome": _group_stats(closed, "outcome"),
        "by_month": sorted(_group_stats(closed, "_month"), key=lambda b: b["name"]),
        "trades": all_trades,
    }
