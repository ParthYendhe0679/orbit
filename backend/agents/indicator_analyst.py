import pandas as pd
import numpy as np

def analyze_indicators(df: pd.DataFrame, log_func=None):
    close = df['Close']
    
    # 1. Calculate EMAs
    ema50 = close.ewm(span=50, adjust=False).mean()
    ema200 = close.ewm(span=200, adjust=False).mean()
    current_price = close.iloc[-1]
    curr_ema50 = ema50.iloc[-1]
    curr_ema200 = ema200.iloc[-1]
    
    # EMA Trend Assessment
    if current_price > curr_ema50 and curr_ema50 > curr_ema200:
        ma_alignment = "above 50/200 EMA"
        trend = "uptrend"
    elif current_price < curr_ema50 and curr_ema50 < curr_ema200:
        ma_alignment = "below 50/200 EMA"
        trend = "downtrend"
    else:
        ma_alignment = "mixed EMA alignment"
        trend = "neutral"
        
    # 2. Calculate RSI (Relative Strength Index)
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -1 * delta.clip(upper=0)
    
    # Wilder's smoothing (alpha = 1/period), which is what charting platforms
    # such as TradingView use — a plain rolling mean gives a different RSI.
    period = 14
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()

    # Avoid division by zero
    rs = avg_gain / avg_loss.replace(0, 0.00001)
    rsi_series = 100 - (100 / (1 + rs))
    current_rsi = float(rsi_series.iloc[-1])
    
    if np.isnan(current_rsi):
        current_rsi = 50.0  # Fallback
        
    # 3. Calculate MACD
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    signal_line = macd_line.ewm(span=9, adjust=False).mean()
    
    curr_macd = macd_line.iloc[-1]
    curr_signal = signal_line.iloc[-1]
    macd_state = "bullish" if curr_macd > curr_signal else "bearish"
    
    # 4. Synthesise Trend Strength
    strength = "neutral"
    if trend == "uptrend" and macd_state == "bullish":
        strength = "strong uptrend" if current_rsi > 50 else "uptrend"
    elif trend == "downtrend" and macd_state == "bearish":
        strength = "strong downtrend" if current_rsi < 50 else "downtrend"
        
    if log_func:
        log_func("Indicator Analyst", f"RSI: {current_rsi:.2f} ({'Oversold' if current_rsi < 30 else 'Overbought' if current_rsi > 70 else 'Neutral'})")
        log_func("Indicator Analyst", f"MACD: {macd_state.upper()} (Line: {curr_macd:.4f}, Signal: {curr_signal:.4f})")
        log_func("Indicator Analyst", f"EMAs: Price is {ma_alignment} (EMA50: {curr_ema50:.2f}, EMA200: {curr_ema200:.2f})")
        log_func("Indicator Analyst", f"Conclusion: Trend strength is {strength.upper()}")
        
    return {
        "strength": strength,
        "rsi": float(current_rsi),
        "macd": macd_state,
        "ma_alignment": ma_alignment
    }
