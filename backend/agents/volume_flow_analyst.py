"""
volume_flow_analyst.py — the order-flow / participation agent.

Price tells you where the market went; volume tells you whether anyone came
along. This agent separates moves that are backed by real participation from
drifting moves that tend to retrace, using three independent reads:

  * OBV slope   — is volume accumulating on up days or down days?
  * VWAP        — is price trading above or below the rolling volume-weighted
                  average, i.e. are buyers or sellers in control of the session?
  * divergence  — price making a new high/low that OBV refuses to confirm is a
                  classic exhaustion warning.
"""

import numpy as np
import pandas as pd

VWAP_PERIOD = 20
OBV_SLOPE_LOOKBACK = 10
DIVERGENCE_LOOKBACK = 20
SPIKE_MULT = 1.5


def analyze_volume_flow(df: pd.DataFrame, log_func=None):
    """Grade participation behind the current move."""
    if len(df) < VWAP_PERIOD + 5 or "Volume" not in df.columns:
        if log_func:
            log_func("Volume Flow Analyst", "⚠️ Not enough candles or no volume data for flow analysis.")
        return {
            "bias": "neutral", "confidence": 0, "obv_trend": "flat",
            "vwap": 0.0, "vwap_position": "unknown", "divergence": "none",
            "volume_spike": False,
            "summary": "Insufficient volume history for order-flow analysis.",
        }

    close = df["Close"]
    volume = df["Volume"].fillna(0)
    price = float(close.iloc[-1])

    # ---- OBV ---------------------------------------------------------------
    direction = np.sign(close.diff().fillna(0))
    obv = (direction * volume).cumsum()

    obv_now = float(obv.iloc[-1])
    obv_then = float(obv.iloc[-1 - OBV_SLOPE_LOOKBACK])
    obv_range = float(obv.tail(DIVERGENCE_LOOKBACK).max() - obv.tail(DIVERGENCE_LOOKBACK).min()) or 1.0
    obv_change = (obv_now - obv_then) / obv_range

    if obv_change > 0.15:
        obv_trend = "accumulation"
    elif obv_change < -0.15:
        obv_trend = "distribution"
    else:
        obv_trend = "flat"

    # ---- rolling VWAP ------------------------------------------------------
    typical = (df["High"] + df["Low"] + df["Close"]) / 3
    pv = (typical * volume).rolling(VWAP_PERIOD).sum()
    vol_sum = volume.rolling(VWAP_PERIOD).sum().replace(0, np.nan)
    vwap_series = pv / vol_sum
    vwap = float(vwap_series.iloc[-1]) if not np.isnan(vwap_series.iloc[-1]) else price
    vwap_position = "above" if price > vwap else "below"

    # ---- volume spike ------------------------------------------------------
    avg_vol = float(volume.rolling(20).mean().iloc[-1] or 0)
    curr_vol = float(volume.iloc[-1] or 0)
    vol_mult = (curr_vol / avg_vol) if avg_vol else 0.0
    volume_spike = vol_mult >= SPIKE_MULT

    # ---- price / OBV divergence -------------------------------------------
    recent_close = close.tail(DIVERGENCE_LOOKBACK)
    recent_obv = obv.tail(DIVERGENCE_LOOKBACK)
    divergence = "none"
    if price >= float(recent_close.max()) and obv_now < float(recent_obv.max()):
        divergence = "bearish"      # new price high, OBV does not confirm
    elif price <= float(recent_close.min()) and obv_now > float(recent_obv.min()):
        divergence = "bullish"      # new price low, OBV holding up

    # ---- combine -----------------------------------------------------------
    bias, confidence = "neutral", 20

    if obv_trend == "accumulation" and vwap_position == "above":
        bias, confidence = "buy", 70
    elif obv_trend == "distribution" and vwap_position == "below":
        bias, confidence = "sell", 70
    elif obv_trend == "accumulation":
        bias, confidence = "buy", 45
    elif obv_trend == "distribution":
        bias, confidence = "sell", 45

    # Divergence is a warning that overrides a weak agreeing read.
    if divergence == "bearish" and bias == "buy" and confidence < 70:
        bias, confidence = "neutral", 25
    elif divergence == "bullish" and bias == "sell" and confidence < 70:
        bias, confidence = "neutral", 25

    if volume_spike and bias != "neutral":
        confidence = min(95, confidence + 10)

    summary = (
        f"OBV shows {obv_trend}, price {vwap_position} VWAP ({vwap:.2f}), "
        f"volume {vol_mult:.2f}x average, divergence: {divergence}."
    )

    if log_func:
        log_func("Volume Flow Analyst", f"OBV trend over last {OBV_SLOPE_LOOKBACK} bars: {obv_trend.upper()} ({obv_change:+.2f} normalised).")
        log_func("Volume Flow Analyst", f"Rolling VWAP({VWAP_PERIOD}): {vwap:.2f} — price is {vwap_position.upper()} it.")
        log_func("Volume Flow Analyst", f"Current volume {vol_mult:.2f}x the 20-bar average{' ⚡ SPIKE' if volume_spike else ''}.")
        if divergence != "none":
            log_func("Volume Flow Analyst", f"⚠️ {divergence.upper()} price/OBV divergence detected — move lacks participation.")
        log_func("Volume Flow Analyst", f"Conclusion: order-flow bias {bias.upper()} ({confidence}% confidence)")

    return {
        "bias": bias,
        "confidence": int(confidence),
        "obv_trend": obv_trend,
        "vwap": round(vwap, 2),
        "vwap_position": vwap_position,
        "volume_multiple": round(vol_mult, 2),
        "volume_spike": bool(volume_spike),
        "divergence": divergence,
        "summary": summary,
    }
