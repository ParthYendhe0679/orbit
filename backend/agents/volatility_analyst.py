"""
volatility_analyst.py — the ATR / Bollinger squeeze regime agent.

Direction is only half of a trade; the other half is whether the market is
even moving enough to pay for the spread and the stop. This agent classifies
the current regime so the rest of the pipeline knows what kind of trade is
appropriate:

  * squeeze    — volatility compressed into the bottom of its recent range.
                 Breakout setups belong here; mean-reversion does not.
  * expansion  — volatility in the top of its range. Trends run, but stops
                 must be wider and size must come down.
  * normal     — everything in between.

It deliberately returns a *neutral* directional bias most of the time. Its job
is to size and gate the other agents, not to pick a side.
"""

import numpy as np
import pandas as pd

ATR_PERIOD = 14
BB_PERIOD = 20
LOOKBACK = 100          # window the percentiles are measured against
SQUEEZE_PCTILE = 25.0   # bandwidth below this percentile = squeeze
EXPANSION_PCTILE = 75.0 # bandwidth above this percentile = expansion


def analyze_volatility(df: pd.DataFrame, log_func=None):
    """Classify the volatility regime and hand back a risk multiplier."""
    if len(df) < BB_PERIOD + 5:
        if log_func:
            log_func("Volatility Analyst", "⚠️ Not enough candles to classify the volatility regime.")
        return {
            "bias": "neutral", "regime": "unknown", "atr": 0.0, "atr_pct": 0.0,
            "bandwidth_pct": 0.0, "percentile": 50.0, "risk_multiplier": 1.0,
            "summary": "Insufficient candle history for volatility regime analysis.",
        }

    high, low, close = df["High"], df["Low"], df["Close"]
    price = float(close.iloc[-1])

    # ---- ATR ---------------------------------------------------------------
    prev_close = close.shift(1)
    true_range = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    atr_series = true_range.ewm(alpha=1 / ATR_PERIOD, adjust=False, min_periods=1).mean()
    atr = float(atr_series.iloc[-1])
    atr_pct = (atr / price * 100) if price else 0.0

    # ---- Bollinger bandwidth ----------------------------------------------
    mid = close.rolling(BB_PERIOD).mean()
    std = close.rolling(BB_PERIOD).std()
    bandwidth = ((mid + 2 * std) - (mid - 2 * std)) / mid.replace(0, np.nan) * 100
    bandwidth = bandwidth.dropna()

    if bandwidth.empty:
        bandwidth_pct, percentile = 0.0, 50.0
    else:
        bandwidth_pct = float(bandwidth.iloc[-1])
        window = bandwidth.tail(LOOKBACK)
        # Share of the recent window this reading sits above.
        percentile = float((window < bandwidth_pct).sum() / len(window) * 100)

    # ---- regime ------------------------------------------------------------
    if percentile <= SQUEEZE_PCTILE:
        regime = "squeeze"
        # Tight stops are affordable, and a breakout is more likely than not.
        risk_multiplier = 0.8
        note = "Volatility is coiled — favour breakout setups, expect expansion."
    elif percentile >= EXPANSION_PCTILE:
        regime = "expansion"
        # Wide stops needed, so cut position size to keep rupee risk constant.
        risk_multiplier = 1.6
        note = "Volatility is elevated — widen stops and reduce position size."
    else:
        regime = "normal"
        risk_multiplier = 1.0
        note = "Volatility is average — standard stop distance applies."

    # Is volatility rising or falling into this reading?
    prior = float(atr_series.iloc[-6]) if len(atr_series) > 6 else atr
    direction = "rising" if atr > prior * 1.05 else "falling" if atr < prior * 0.95 else "steady"

    summary = (
        f"{regime.upper()} regime — ATR {atr:.2f} ({atr_pct:.2f}% of price), "
        f"bandwidth {bandwidth_pct:.2f}% at the {percentile:.0f}th percentile, {direction}."
    )

    if log_func:
        log_func("Volatility Analyst", f"ATR({ATR_PERIOD}): {atr:.2f} = {atr_pct:.2f}% of price, {direction}.")
        log_func("Volatility Analyst", f"Bollinger bandwidth {bandwidth_pct:.2f}% sits at the {percentile:.0f}th percentile of the last {LOOKBACK} bars.")
        log_func("Volatility Analyst", f"Regime: {regime.upper()} — {note}")
        log_func("Volatility Analyst", f"Suggested stop-distance multiplier: {risk_multiplier}x ATR baseline.")

    return {
        "bias": "neutral",              # this agent gates risk, it does not pick a side
        "regime": regime,
        "atr": round(atr, 2),
        "atr_pct": round(atr_pct, 2),
        "bandwidth_pct": round(bandwidth_pct, 2),
        "percentile": round(percentile, 1),
        "direction": direction,
        "risk_multiplier": risk_multiplier,
        "summary": summary,
    }
