"""
mtf_trend_analyst.py — the multi-timeframe alignment agent.

Every other agent in the pipeline reads a single timeframe, which is how a
setup that looks clean on the daily chart turns out to be a counter-trend
short against a rising weekly. This agent resamples the same candles up to a
higher timeframe and asks one question: does the bigger picture agree?

Trading with higher-timeframe alignment is the single cheapest edge available,
so its verdict is used to *gate* the consensus rather than merely add a vote.
"""

import numpy as np
import pandas as pd

HTF_RULE = "W"          # resample daily candles to weekly
HTF_FAST, HTF_SLOW = 10, 30
LTF_FAST, LTF_SLOW = 20, 50


def _trend_of(close: pd.Series, fast: int, slow: int) -> tuple:
    """Direction and strength of one timeframe, from an EMA pair."""
    if len(close) < slow:
        return "neutral", 0.0
    ema_f = close.ewm(span=fast, adjust=False).mean()
    ema_s = close.ewm(span=slow, adjust=False).mean()
    f, s = float(ema_f.iloc[-1]), float(ema_s.iloc[-1])
    price = float(close.iloc[-1])

    # Separation between the EMAs, as a share of price, is the strength read.
    spread = (f - s) / price * 100 if price else 0.0

    if f > s and price > s:
        return "uptrend", abs(spread)
    if f < s and price < s:
        return "downtrend", abs(spread)
    return "neutral", abs(spread)


def analyze_mtf_trend(df: pd.DataFrame, log_func=None):
    """Compare the trading timeframe against the higher timeframe."""
    if len(df) < LTF_SLOW + 5:
        if log_func:
            log_func("MTF Trend Analyst", "⚠️ Not enough candles for multi-timeframe alignment.")
        return {
            "bias": "neutral", "confidence": 0, "aligned": False,
            "htf_trend": "unknown", "ltf_trend": "unknown",
            "htf_strength": 0.0, "ltf_strength": 0.0,
            "summary": "Insufficient history for multi-timeframe trend analysis.",
        }

    ltf_trend, ltf_strength = _trend_of(df["Close"], LTF_FAST, LTF_SLOW)

    # ---- resample to the higher timeframe ---------------------------------
    htf_trend, htf_strength = "neutral", 0.0
    try:
        htf = df.resample(HTF_RULE).agg({
            "Open": "first", "High": "max", "Low": "min", "Close": "last",
        }).dropna()
        if len(htf) >= HTF_SLOW:
            htf_trend, htf_strength = _trend_of(htf["Close"], HTF_FAST, HTF_SLOW)
        elif len(htf) >= 10:
            # Not enough weekly bars for the full pair — fall back to a
            # shorter one rather than reporting a bogus neutral.
            htf_trend, htf_strength = _trend_of(htf["Close"], 5, 10)
    except (TypeError, ValueError):
        # A non-datetime index cannot be resampled; degrade to LTF-only.
        if log_func:
            log_func("MTF Trend Analyst", "⚠️ Candle index is not time-based — higher timeframe skipped.")

    # ---- alignment ---------------------------------------------------------
    aligned = htf_trend == ltf_trend and htf_trend != "neutral"
    conflict = (
        (htf_trend == "uptrend" and ltf_trend == "downtrend") or
        (htf_trend == "downtrend" and ltf_trend == "uptrend")
    )

    if aligned:
        bias = "buy" if htf_trend == "uptrend" else "sell"
        confidence = 85
        note = "Both timeframes agree — highest-quality trend continuation context."
    elif conflict:
        bias = "neutral"
        confidence = 15
        note = "Timeframes conflict — the lower timeframe is counter-trend. Reduce size or stand aside."
    elif htf_trend != "neutral":
        bias = "buy" if htf_trend == "uptrend" else "sell"
        confidence = 50
        note = "Higher timeframe has direction while the lower timeframe consolidates — favour pullback entries."
    elif ltf_trend != "neutral":
        bias = "buy" if ltf_trend == "uptrend" else "sell"
        confidence = 35
        note = "Only the lower timeframe is trending — treat as a short-term move, not a position trade."
    else:
        bias = "neutral"
        confidence = 20
        note = "Neither timeframe is trending — range conditions."

    summary = (
        f"Weekly {htf_trend} ({htf_strength:.2f}%) vs daily {ltf_trend} ({ltf_strength:.2f}%) — "
        f"{'ALIGNED' if aligned else 'CONFLICT' if conflict else 'partial'}."
    )

    if log_func:
        log_func("MTF Trend Analyst", f"Higher timeframe (weekly): {htf_trend.upper()}, EMA spread {htf_strength:.2f}% of price.")
        log_func("MTF Trend Analyst", f"Trading timeframe (daily): {ltf_trend.upper()}, EMA spread {ltf_strength:.2f}% of price.")
        log_func("MTF Trend Analyst", f"Alignment: {'✅ ALIGNED' if aligned else '⚠️ CONFLICT' if conflict else 'PARTIAL'} — {note}")
        log_func("MTF Trend Analyst", f"Conclusion: multi-timeframe bias {bias.upper()} ({confidence}% confidence)")

    return {
        "bias": bias,
        "confidence": confidence,
        "aligned": bool(aligned),
        "conflict": bool(conflict),
        "htf_trend": htf_trend,
        "ltf_trend": ltf_trend,
        "htf_strength": round(htf_strength, 2),
        "ltf_strength": round(ltf_strength, 2),
        "note": note,
        "summary": summary,
    }
