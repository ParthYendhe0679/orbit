"""
ema_ribbon_analyst.py — the fast EMA 5 / 9 / 15 ribbon agent.

The existing Indicator Analyst only looks at the slow 50/200 pair, which is
useful for the macro trend but turns far too late to time an entry. This agent
watches the fast ribbon instead:

  * stacking      — 5 > 9 > 15 (bull) or 5 < 9 < 15 (bear) is the trend filter
  * fresh cross   — the 5 crossing the 9 within the last few bars is the trigger
  * compression   — a tight ribbon means consolidation, and a squeeze usually
                    precedes an expansion, so it downgrades trend signals
  * slope         — a flat ribbon is a chop warning even when it is stacked
"""

import numpy as np
import pandas as pd

FAST, MID, SLOW = 5, 9, 15

# How many bars back a 5/9 cross still counts as "fresh".
CROSS_LOOKBACK = 3
# Ribbon width below this share of price is treated as compressed/coiled.
COMPRESSION_PCT = 0.004      # 0.4% of price
# Slope over this many bars, as a share of price, to call the ribbon "rising".
SLOPE_LOOKBACK = 5
SLOPE_FLAT_PCT = 0.001       # 0.1% of price


def analyze_ema_ribbon(df: pd.DataFrame, log_func=None):
    """
    Read the 5/9/15 EMA ribbon and return a directional bias with confidence.
    """
    if len(df) < SLOW + CROSS_LOOKBACK + 2:
        if log_func:
            log_func("EMA Ribbon Analyst", f"⚠️ Not enough candles for the {FAST}/{MID}/{SLOW} ribbon.")
        return {
            "bias": "neutral", "confidence": 0, "stacked": "none",
            "cross": "none", "compressed": False, "slope": "flat",
            "ema5": 0.0, "ema9": 0.0, "ema15": 0.0,
            "summary": "Insufficient candle history for fast EMA ribbon analysis.",
        }

    close = df["Close"]
    ema_f = close.ewm(span=FAST, adjust=False).mean()
    ema_m = close.ewm(span=MID, adjust=False).mean()
    ema_s = close.ewm(span=SLOW, adjust=False).mean()

    price = float(close.iloc[-1])
    f, m, s = float(ema_f.iloc[-1]), float(ema_m.iloc[-1]), float(ema_s.iloc[-1])

    # ---- 1. stacking -------------------------------------------------------
    if f > m > s:
        stacked = "bullish"
    elif f < m < s:
        stacked = "bearish"
    else:
        stacked = "tangled"

    # ---- 2. fresh 5/9 cross ------------------------------------------------
    cross = "none"
    cross_age = None
    for back in range(1, CROSS_LOOKBACK + 1):
        now_above = ema_f.iloc[-back] > ema_m.iloc[-back]
        was_above = ema_f.iloc[-back - 1] > ema_m.iloc[-back - 1]
        if now_above and not was_above:
            cross, cross_age = "golden", back
            break
        if not now_above and was_above:
            cross, cross_age = "death", back
            break

    # ---- 3. compression ----------------------------------------------------
    width = max(f, m, s) - min(f, m, s)
    width_pct = width / price if price else 0.0
    compressed = width_pct < COMPRESSION_PCT

    # ---- 4. slope ----------------------------------------------------------
    past_m = float(ema_m.iloc[-1 - SLOPE_LOOKBACK])
    slope_pct = (m - past_m) / price if price else 0.0
    if slope_pct > SLOPE_FLAT_PCT:
        slope = "rising"
    elif slope_pct < -SLOPE_FLAT_PCT:
        slope = "falling"
    else:
        slope = "flat"

    # ---- 5. combine into a bias -------------------------------------------
    bias, confidence = "neutral", 20

    if stacked == "bullish" and price > f:
        bias, confidence = "buy", 65
    elif stacked == "bearish" and price < f:
        bias, confidence = "sell", 65
    elif stacked == "bullish":
        bias, confidence = "buy", 45
    elif stacked == "bearish":
        bias, confidence = "sell", 45

    # A fresh cross is the actual trigger — it outranks mere stacking.
    if cross == "golden":
        bias = "buy"
        confidence = max(confidence, 75)
    elif cross == "death":
        bias = "sell"
        confidence = max(confidence, 75)

    # A flat or compressed ribbon means chop; do not trust the direction.
    if slope == "flat":
        confidence = max(10, confidence - 20)
    if compressed:
        confidence = max(10, confidence - 15)
        if cross == "none":
            bias = "neutral"

    confidence = int(min(95, confidence))

    cross_text = "none" if cross == "none" else f"{cross} cross {cross_age} bar(s) ago"
    summary = (
        f"EMA{FAST}/{MID}/{SLOW} {stacked}, {cross_text}, ribbon {'compressed' if compressed else 'expanded'} "
        f"({width_pct * 100:.2f}% of price), slope {slope}."
    )

    if log_func:
        log_func("EMA Ribbon Analyst", f"EMA{FAST}: {f:.2f} | EMA{MID}: {m:.2f} | EMA{SLOW}: {s:.2f} (price {price:.2f})")
        log_func("EMA Ribbon Analyst", f"Ribbon stacking is {stacked.upper()}; slope over last {SLOPE_LOOKBACK} bars is {slope.upper()}.")
        log_func("EMA Ribbon Analyst", f"Ribbon width {width_pct * 100:.2f}% of price → {'COMPRESSED (coiling)' if compressed else 'expanded (trending)'}.")
        if cross != "none":
            log_func("EMA Ribbon Analyst", f"⚡ Fresh {FAST}/{MID} {cross.upper()} CROSS detected {cross_age} bar(s) ago.")
        log_func("EMA Ribbon Analyst", f"Conclusion: fast-ribbon bias {bias.upper()} ({confidence}% confidence)")

    return {
        "bias": bias,
        "confidence": confidence,
        "stacked": stacked,
        "cross": cross,
        "cross_age": cross_age,
        "compressed": bool(compressed),
        "slope": slope,
        "width_pct": round(width_pct * 100, 3),
        "ema5": round(f, 2),
        "ema9": round(m, 2),
        "ema15": round(s, 2),
        "summary": summary,
    }
