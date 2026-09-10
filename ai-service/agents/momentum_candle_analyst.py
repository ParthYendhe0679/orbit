"""
momentum_candle_analyst.py — the "big bar" agent.

Reads the shape of the most recent candles rather than a smoothed indicator.
A single wide-range, high-volume bar that closes near its extreme is one of the
earliest signs that one side has taken control, and it shows up a long time
before a 50/200 EMA cross does. This agent grades the last bar against the
average true range so "big" means big *for this asset*, not big in rupees.
"""

import numpy as np
import pandas as pd

# A bar counts as "big" once its range is this multiple of the recent ATR.
BIG_BAR_ATR_MULT = 1.5
# Body must fill this share of the range before the bar is called decisive.
MARUBOZU_BODY_RATIO = 0.70
# A wick this large relative to the range is a rejection/pin bar.
PIN_WICK_RATIO = 0.60
# Volume multiple over the 20-bar average that confirms real participation.
VOLUME_CONFIRM_MULT = 1.3


def _atr(df: pd.DataFrame, period: int = 14) -> float:
    """Wilder-style ATR, with a sane fallback when history is short."""
    high, low, close = df["High"], df["Low"], df["Close"]
    prev_close = close.shift(1)
    true_range = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)

    atr = true_range.ewm(alpha=1 / period, adjust=False, min_periods=1).mean().iloc[-1]
    if not atr or np.isnan(atr):
        atr = float((high - low).mean()) or 1.0
    return float(atr)


def analyze_momentum_candles(df: pd.DataFrame, log_func=None):
    """
    Grade the latest candles for decisive momentum.

    Returns a dict with a directional bias, a 0-100 confidence, and the
    individual pattern flags so the Strategy Judge and the UI can both use it.
    """
    if len(df) < 20:
        if log_func:
            log_func("Momentum Candle Analyst", "⚠️ Not enough candles to grade bar momentum (needs 20).")
        return {
            "bias": "neutral", "confidence": 0, "big_bar": False,
            "pattern": "insufficient data", "body_pct": 0.0,
            "range_vs_atr": 0.0, "volume_confirmed": False,
            "summary": "Insufficient candle history for momentum bar analysis.",
        }

    o = float(df["Open"].iloc[-1])
    h = float(df["High"].iloc[-1])
    l = float(df["Low"].iloc[-1])
    c = float(df["Close"].iloc[-1])
    prev_o = float(df["Open"].iloc[-2])
    prev_c = float(df["Close"].iloc[-2])

    bar_range = max(h - l, 1e-9)
    body = abs(c - o)
    body_pct = body / bar_range
    bullish = c >= o

    atr = _atr(df)
    range_vs_atr = bar_range / atr if atr else 0.0
    big_bar = range_vs_atr >= BIG_BAR_ATR_MULT

    # Volume participation — the difference between a real drive and a drift.
    volume_confirmed = False
    vol_mult = 0.0
    if "Volume" in df.columns:
        avg_vol = float(df["Volume"].rolling(20).mean().iloc[-1] or 0)
        curr_vol = float(df["Volume"].iloc[-1] or 0)
        if avg_vol > 0:
            vol_mult = curr_vol / avg_vol
            volume_confirmed = vol_mult >= VOLUME_CONFIRM_MULT

    upper_wick = h - max(o, c)
    lower_wick = min(o, c) - l

    # ---- pattern classification, most decisive first ----------------------
    pattern = "indecisive bar"
    bias = "neutral"
    confidence = 20

    engulf_bull = c > prev_o and o < prev_c and prev_c < prev_o and body > abs(prev_c - prev_o)
    engulf_bear = c < prev_o and o > prev_c and prev_c > prev_o and body > abs(prev_c - prev_o)

    if big_bar and body_pct >= MARUBOZU_BODY_RATIO:
        pattern = "big bullish marubozu" if bullish else "big bearish marubozu"
        bias = "buy" if bullish else "sell"
        confidence = 80
    elif engulf_bull or engulf_bear:
        pattern = "bullish engulfing" if engulf_bull else "bearish engulfing"
        bias = "buy" if engulf_bull else "sell"
        confidence = 70
    elif big_bar and lower_wick / bar_range >= PIN_WICK_RATIO:
        pattern = "big rejection wick from lows"
        bias = "buy"
        confidence = 65
    elif big_bar and upper_wick / bar_range >= PIN_WICK_RATIO:
        pattern = "big rejection wick from highs"
        bias = "sell"
        confidence = 65
    elif big_bar:
        pattern = "wide-range bar" + (" (bullish close)" if bullish else " (bearish close)")
        bias = "buy" if bullish else "sell"
        confidence = 55
    elif body_pct >= MARUBOZU_BODY_RATIO:
        # Not wide enough to be a big bar, but the close is still decisive:
        # one side held control for the whole session.
        pattern = "solid bullish body" if bullish else "solid bearish body"
        bias = "buy" if bullish else "sell"
        confidence = 45
    elif body_pct < 0.15:
        pattern = "doji / indecision"
        bias = "neutral"
        confidence = 15

    # Volume either backs the read or undercuts it.
    if bias != "neutral":
        confidence = min(95, confidence + 10) if volume_confirmed else max(10, confidence - 20)

    summary = (
        f"{pattern} — range {range_vs_atr:.2f}x ATR, body {body_pct * 100:.0f}% of range, "
        f"volume {vol_mult:.2f}x average."
    )

    if log_func:
        log_func("Momentum Candle Analyst", f"Last bar range is {range_vs_atr:.2f}x ATR ({'BIG BAR' if big_bar else 'normal'}).")
        log_func("Momentum Candle Analyst", f"Body fills {body_pct * 100:.0f}% of range; upper wick {upper_wick / bar_range * 100:.0f}%, lower wick {lower_wick / bar_range * 100:.0f}%.")
        log_func("Momentum Candle Analyst", f"Volume {vol_mult:.2f}x 20-bar average ({'CONFIRMED' if volume_confirmed else 'unconfirmed'}).")
        log_func("Momentum Candle Analyst", f"Pattern: {pattern.upper()} → bias {bias.upper()} ({confidence}% confidence)")

    return {
        "bias": bias,
        "confidence": confidence,
        "big_bar": bool(big_bar),
        "pattern": pattern,
        "body_pct": round(body_pct * 100, 1),
        "range_vs_atr": round(range_vs_atr, 2),
        "volume_multiple": round(vol_mult, 2),
        "volume_confirmed": bool(volume_confirmed),
        "summary": summary,
    }
