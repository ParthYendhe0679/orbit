"""
strategy_lab/metrics.py - performance statistics for a finished backtest.

Rules followed throughout:
  * never divide by zero - a statistic that cannot be computed is returned as
    None, and the UI shows a dash rather than a fabricated number;
  * risk-adjusted ratios (Sharpe, Sortino, Calmar) are only produced when
    there is enough data for them to mean anything;
  * the equity curve is downsampled for the chart only. Every statistic is
    computed on the full-resolution curve.
"""

import math
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

# Below this many return observations an annualized ratio is noise.
MIN_OBSERVATIONS_FOR_RATIOS = 30
# Points sent to the browser for the equity chart.
MAX_CURVE_POINTS = 600


def _safe_div(numerator: float, denominator: float) -> Optional[float]:
    if denominator is None or denominator == 0 or not np.isfinite(denominator):
        return None
    value = numerator / denominator
    return float(value) if np.isfinite(value) else None


def _round(value: Optional[float], digits: int = 2) -> Optional[float]:
    if value is None or not np.isfinite(value):
        return None
    return round(float(value), digits)


def max_drawdown(equity: np.ndarray) -> Dict[str, Optional[float]]:
    """Largest peak-to-trough fall of the equity curve."""
    if equity.size == 0:
        return {"max_drawdown_percent": None, "max_drawdown_value": None}
    running_peak = np.maximum.accumulate(equity)
    drawdown_value = running_peak - equity
    with np.errstate(divide="ignore", invalid="ignore"):
        drawdown_pct = np.where(running_peak > 0, drawdown_value / running_peak * 100.0, 0.0)
    return {
        "max_drawdown_percent": _round(float(np.max(drawdown_pct)) if drawdown_pct.size else 0.0),
        "max_drawdown_value": _round(float(np.max(drawdown_value)) if drawdown_value.size else 0.0),
    }


def _periods_per_year(times: List[str]) -> Optional[float]:
    """Bars per year, inferred from the median gap between candles."""
    if len(times) < 3:
        return None
    try:
        index = pd.to_datetime(pd.Series(times))
    except Exception:
        return None
    deltas = index.diff().dropna()
    if deltas.empty:
        return None
    median_seconds = float(deltas.dt.total_seconds().median())
    if median_seconds <= 0:
        return None
    return (365.0 * 24.0 * 3600.0) / median_seconds


def compute_metrics(
    initial_capital: float,
    equity_values: List[float],
    equity_times: List[str],
    trades: List[Dict[str, Any]],
) -> Dict[str, Any]:
    equity = np.asarray(equity_values, dtype=float)
    final_equity = float(equity[-1]) if equity.size else float(initial_capital)
    net_profit = final_equity - float(initial_capital)

    pnls = np.asarray([float(t["pnl"]) for t in trades], dtype=float)
    wins = pnls[pnls > 0]
    losses = pnls[pnls < 0]
    gross_profit = float(wins.sum()) if wins.size else 0.0
    gross_loss = float(-losses.sum()) if losses.size else 0.0

    return_fraction = _safe_div(net_profit, float(initial_capital))
    return_percent = _round(return_fraction * 100.0) if return_fraction is not None else None

    metrics: Dict[str, Any] = {
        "initial_capital": _round(initial_capital),
        "final_equity": _round(final_equity),
        "net_profit": _round(net_profit),
        "net_profit_percent": return_percent,
        "total_return_percent": return_percent,
        "total_trades": int(pnls.size),
        "winning_trades": int(wins.size),
        "losing_trades": int(losses.size),
        "breakeven_trades": int(np.count_nonzero(pnls == 0)),
        "win_rate": _round(_safe_div(float(wins.size), float(pnls.size)) * 100.0
                           if pnls.size else None),
        "average_win": _round(float(wins.mean())) if wins.size else None,
        "average_loss": _round(float(losses.mean())) if losses.size else None,
        "largest_win": _round(float(wins.max())) if wins.size else None,
        "largest_loss": _round(float(losses.min())) if losses.size else None,
        "average_trade": _round(float(pnls.mean())) if pnls.size else None,
        "gross_profit": _round(gross_profit),
        "gross_loss": _round(gross_loss),
        "profit_factor": _round(_safe_div(gross_profit, gross_loss), 3),
    }
    metrics.update(max_drawdown(equity))

    # ---- Risk-adjusted ratios, only when statistically defensible ----------
    ratios: Dict[str, Optional[float]] = {"sharpe_ratio": None, "sortino_ratio": None, "calmar_ratio": None}
    notes: List[str] = []
    if equity.size >= MIN_OBSERVATIONS_FOR_RATIOS + 1:
        with np.errstate(divide="ignore", invalid="ignore"):
            returns = np.diff(equity) / np.where(equity[:-1] != 0, equity[:-1], np.nan)
        returns = returns[np.isfinite(returns)]
        periods = _periods_per_year(equity_times)
        if returns.size >= MIN_OBSERVATIONS_FOR_RATIOS and periods:
            annualization = math.sqrt(periods)
            std = float(returns.std(ddof=1))
            mean = float(returns.mean())
            if std > 0:
                ratios["sharpe_ratio"] = _round(mean / std * annualization, 3)
            downside = returns[returns < 0]
            downside_std = float(downside.std(ddof=1)) if downside.size > 1 else 0.0
            if downside_std > 0:
                ratios["sortino_ratio"] = _round(mean / downside_std * annualization, 3)
            elif downside.size <= 1:
                notes.append("Sortino ratio needs at least two losing periods.")
            years = returns.size / periods
            dd = metrics.get("max_drawdown_percent")
            if years > 0 and dd:
                total_growth = _safe_div(final_equity, float(initial_capital))
                if total_growth and total_growth > 0:
                    cagr = (total_growth ** (1.0 / years) - 1.0) * 100.0
                    ratios["calmar_ratio"] = _round(cagr / dd, 3)
                    metrics["cagr_percent"] = _round(cagr)
        else:
            notes.append("Not enough return observations for annualized risk ratios.")
    else:
        notes.append(
            "This backtest has fewer than " + str(MIN_OBSERVATIONS_FOR_RATIOS + 1)
            + " candles, so Sharpe, Sortino and Calmar are not reported."
        )
    metrics.update(ratios)
    metrics["notes"] = notes
    return metrics


def downsample_curve(times: List[Any], values: List[float]) -> List[Dict[str, Any]]:
    """Equity points for the chart: every point, or an even sample of them.

    Downsampling affects the picture only - every statistic above is computed
    on the full series. The first and last points are always kept so the chart
    starts and ends on the true values.
    """
    count = len(values)
    if count == 0:
        return []
    if count <= MAX_CURVE_POINTS:
        indices = range(count)
    else:
        step = count / float(MAX_CURVE_POINTS)
        indices = sorted({int(i * step) for i in range(MAX_CURVE_POINTS)} | {0, count - 1})
    out = []
    for i in indices:
        timestamp = times[i]
        out.append({
            "time": timestamp.isoformat() if hasattr(timestamp, "isoformat") else str(timestamp),
            "equity": round(float(values[i]), 4),
        })
    return out
