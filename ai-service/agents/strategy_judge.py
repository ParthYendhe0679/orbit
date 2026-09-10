import pandas as pd
import numpy as np

import llm as llm

# Number of quantitative strategies in the suite below. Kept in one place so
# the logs, the LLM prompt and the neutral-fallback vote count can never drift
# apart again. The upstream analyst agents (momentum bar, EMA ribbon, volume
# flow, multi-timeframe) add their own votes on top via `extra_signals`, so the
# effective total is len(votes), not this constant.
TOTAL_STRATEGIES = 12

# Minimum confirming votes needed before the judge commits to a direction.
MIN_CONSENSUS_VOTES = 2

# A specialist agent's read must be at least this confident to earn a vote.
CONFLUENCE_MIN_CONFIDENCE = 50


def evaluate_strategies(df: pd.DataFrame, supports, resistances, log_func=None,
                        extra_signals=None):
    """
    Run the quantitative strategy suite and fold in the upstream analyst votes.

    extra_signals: optional {display name: {"bias": ..., "confidence": ...}}
        from the specialist agents (momentum bar, EMA ribbon, volume flow,
        multi-timeframe). A signal only earns a vote once its own confidence
        clears CONFLUENCE_MIN_CONFIDENCE, so a hedged read cannot outvote a
        decisive one.
    """
    if len(df) < 50:
        if log_func:
            log_func("Strategy Judge", "⚠️ Insufficient candle data to run strategy suite (needs at least 50 periods).")
        return {
            "signal": "neutral",
            "votes_buy": 0,
            "votes_sell": 0,
            "votes_neutral": TOTAL_STRATEGIES,
            "total_signals": TOTAL_STRATEGIES,
            "details": [],
            "confluence": {},
            "reasoning": "Insufficient candle data to run quantitative strategy suite."
        }

    if log_func:
        log_func("Strategy Judge", f"Evaluating {TOTAL_STRATEGIES} world-class trading strategies on current asset candles...")

    close = df['Close'].values
    highs = df['High'].values
    lows = df['Low'].values
    opens = df['Open'].values
    volumes = df['Volume'].values
    current_price = close[-1]
    
    # -----------------------------------------------------------------------
    # 0. Pre-calculate technical indicators
    # -----------------------------------------------------------------------
    # EMAs
    df_ema9 = df['Close'].ewm(span=9, adjust=False).mean().values
    df_ema21 = df['Close'].ewm(span=21, adjust=False).mean().values
    df_ema50 = df['Close'].ewm(span=50, adjust=False).mean().values
    df_ema200 = df['Close'].ewm(span=200, adjust=False).mean().values
    
    # Bollinger Bands
    df_ema20 = df['Close'].rolling(window=20).mean().values
    df_std20 = df['Close'].rolling(window=20).std().values
    upper_band = df_ema20 + (2 * df_std20)
    lower_band = df_ema20 - (2 * df_std20)
    
    # RSI
    delta = df['Close'].diff()
    gain = delta.clip(lower=0)
    loss = -1 * delta.clip(upper=0)
    avg_gain = gain.rolling(window=14).mean()
    avg_loss = loss.rolling(window=14).mean()
    rs = avg_gain / avg_loss.replace(0, 0.00001)
    rsi = (100 - (100 / (1 + rs))).values
    
    # MACD
    ema12 = df['Close'].ewm(span=12, adjust=False).mean()
    ema26 = df['Close'].ewm(span=26, adjust=False).mean()
    macd_line = (ema12 - ema26).values
    signal_line = pd.Series(macd_line).ewm(span=9, adjust=False).mean().values
    
    # ADX (Standard Wilder's Method)
    tr1 = highs - lows
    tr2 = np.abs(highs - np.roll(close, 1))
    tr3 = np.abs(lows - np.roll(close, 1))
    tr = np.maximum(tr1, np.maximum(tr2, tr3))
    tr[0] = tr1[0]  # Fix first element
    
    up_move = highs - np.roll(highs, 1)
    down_move = np.roll(lows, 1) - lows
    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)
    
    tr_smooth = pd.Series(tr).rolling(window=14).sum()
    plus_dm_smooth = pd.Series(plus_dm).rolling(window=14).sum()
    minus_dm_smooth = pd.Series(minus_dm).rolling(window=14).sum()
    
    plus_di = 100 * (plus_dm_smooth / tr_smooth.replace(0, 0.00001))
    minus_di = 100 * (minus_dm_smooth / tr_smooth.replace(0, 0.00001))
    dx = 100 * np.abs(plus_di - minus_di) / (plus_di + minus_di).replace(0, 0.00001)
    adx_series = dx.rolling(window=14).mean().values
    curr_adx = adx_series[-1] if not np.isnan(adx_series[-1]) else 25.0
    
    avg_vol_20 = df['Volume'].rolling(window=20).mean().iloc[-1]
    curr_vol = volumes[-1]
    high_vol = curr_vol > 1.3 * avg_vol_20
    
    votes = {}

    # -----------------------------------------------------------------------
    # Strategy 1: Smart Money Concepts (SMC)
    # -----------------------------------------------------------------------
    # BOS (Break of Structure): Current price breaks recent 20-period swing high/low
    max_20 = np.max(highs[-21:-1])
    min_20 = np.min(lows[-21:-1])
    bos_bull = current_price > max_20
    bos_bear = current_price < min_20
    
    # FVG (Fair Value Gap): Detect if a gap exists in the last 6 candles
    fvg_bull = False
    fvg_bear = False
    for i in range(-5, -1):
        if lows[i-1] > highs[i+1]:
            fvg_bull = True
        if highs[i-1] < lows[i+1]:
            fvg_bear = True
            
    s1_vote = "buy" if bos_bull and fvg_bull else "sell" if bos_bear and fvg_bear else "neutral"
    votes["Smart Money Concepts (SMC)"] = s1_vote

    # -----------------------------------------------------------------------
    # Strategy 2: ICT Strategy
    # -----------------------------------------------------------------------
    # MSS (Market Structure Shift) on high volume + FVG retracement
    mss_bull = bos_bull and high_vol
    mss_bear = bos_bear and high_vol
    s2_vote = "buy" if mss_bull and fvg_bull else "sell" if mss_bear and fvg_bear else "neutral"
    votes["ICT Strategy (MSS & FVG)"] = s2_vote

    # -----------------------------------------------------------------------
    # Strategy 3: Wyckoff Method
    # -----------------------------------------------------------------------
    # Spring (false breakdown) / Upthrust (false breakout) of a 30-period range
    range_low = np.min(lows[-30:-3])
    range_high = np.max(highs[-30:-3])
    spring = np.min(lows[-3:]) < range_low and close[-1] > range_low and high_vol
    upthrust = np.max(highs[-3:]) > range_high and close[-1] < range_high and high_vol
    s3_vote = "buy" if spring else "sell" if upthrust else "neutral"
    votes["Wyckoff Method (Spring/Upthrust)"] = s3_vote

    # -----------------------------------------------------------------------
    # Strategy 4: Price Action Trading
    # -----------------------------------------------------------------------
    # Hammer/Shooting Star Pin Bars or Engulfing Candles
    cr = highs[-1] - lows[-1] if (highs[-1] - lows[-1]) > 0 else 0.00001
    cb = abs(close[-1] - opens[-1])
    cus = highs[-1] - max(close[-1], opens[-1])
    cls = min(close[-1], opens[-1]) - lows[-1]
    
    hammer = cls > 2.0 * cb and cus < 0.2 * cr
    shooting_star = cus > 2.0 * cb and cls < 0.2 * cr
    
    near_support = any(abs(current_price - s) / s < 0.015 for s in supports)
    near_resistance = any(abs(current_price - r) / r < 0.015 for r in resistances)
    
    bullish_engulfing = (close[-1] > opens[-1]) and (close[-2] < opens[-2]) and (close[-1] > opens[-2]) and (opens[-1] < close[-2])
    bearish_engulfing = (close[-1] < opens[-1]) and (close[-2] > opens[-2]) and (close[-1] < opens[-2]) and (opens[-1] > close[-2])
    
    s4_vote = "buy" if (hammer and near_support) or bullish_engulfing else "sell" if (shooting_star and near_resistance) or bearish_engulfing else "neutral"
    votes["Price Action (Pin Bar/Engulfing)"] = s4_vote

    # -----------------------------------------------------------------------
    # Strategy 5: Supply and Demand
    # -----------------------------------------------------------------------
    # Check if price has entered a fresh historical supply/demand zone base
    s5_vote = "neutral"
    for i in range(len(df) - 15, len(df) - 3):
        if close[i] / close[i-3] > 1.025:  # strong demand base
            zone_base = lows[i-3]
            if zone_base <= current_price <= zone_base * 1.015 and close[-1] > opens[-1]:
                s5_vote = "buy"
                break
        elif close[i] / close[i-3] < 0.975:  # strong supply base
            zone_base = highs[i-3]
            if zone_base * 0.985 <= current_price <= zone_base and close[-1] < opens[-1]:
                s5_vote = "sell"
                break
    votes["Supply & Demand Zones"] = s5_vote

    # -----------------------------------------------------------------------
    # Strategy 6: Trend Following
    # -----------------------------------------------------------------------
    # EMA alignment (9 > 21 > 50 > 200) + ADX trend strength confirmation
    trend_bull = df_ema9[-1] > df_ema21[-1] > df_ema50[-1] > df_ema200[-1]
    trend_bear = df_ema9[-1] < df_ema21[-1] < df_ema50[-1] < df_ema200[-1]
    pullback_bull = lows[-1] <= df_ema21[-1] <= highs[-1]
    pullback_bear = lows[-1] <= df_ema21[-1] <= highs[-1]
    
    s6_vote = "buy" if trend_bull and pullback_bull and curr_adx > 22 else "sell" if trend_bear and pullback_bear and curr_adx > 22 else "neutral"
    votes["Trend Following (4-EMA/ADX)"] = s6_vote

    # -----------------------------------------------------------------------
    # Strategy 7: Breakout Strategy
    # -----------------------------------------------------------------------
    # Bollinger Band breakout with volume expansion
    bb_break_bull = current_price > upper_band[-1] and high_vol
    bb_break_bear = current_price < lower_band[-1] and high_vol
    s7_vote = "buy" if bb_break_bull else "sell" if bb_break_bear else "neutral"
    votes["BB Breakout & Volatility Squeeze"] = s7_vote

    # -----------------------------------------------------------------------
    # Strategy 8: Fibonacci Strategy
    # -----------------------------------------------------------------------
    # Bounces inside the 50% - 61.8% retracement level of the 40-candle swing range
    swing_high = np.max(highs[-40:])
    swing_low = np.min(lows[-40:])
    swing_range = swing_high - swing_low if (swing_high - swing_low) > 0 else 0.00001
    
    fib_50 = swing_high - 0.50 * swing_range
    fib_618 = swing_high - 0.618 * swing_range
    in_bull_fib = fib_618 <= current_price <= fib_50
    
    fib_50_bear = swing_low + 0.50 * swing_range
    fib_618_bear = swing_low + 0.618 * swing_range
    in_bear_fib = fib_50_bear <= current_price <= fib_618_bear
    
    s8_vote = "buy" if (current_price > df_ema50[-1]) and in_bull_fib and (close[-1] > opens[-1]) else "sell" if (current_price < df_ema50[-1]) and in_bear_fib and (close[-1] < opens[-1]) else "neutral"
    votes["Fibonacci Retracement (50/61.8)"] = s8_vote

    # -----------------------------------------------------------------------
    # Strategy 9: Order Flow Trading
    # -----------------------------------------------------------------------
    # Cumulative Volume Delta (CVD) divergence proxy
    denom = highs - lows
    denom = np.where(denom == 0, 0.00001, denom)
    delta_vol = volumes * (close - lows - (highs - close)) / denom
    cvd = pd.Series(delta_vol).rolling(window=20).sum().values
    
    cvd_bull = cvd[-1] > cvd[-3] > cvd[-5] and close[-1] < close[-5]
    cvd_bear = cvd[-1] < cvd[-3] < cvd[-5] and close[-1] > close[-5]
    s9_vote = "buy" if cvd_bull else "sell" if cvd_bear else "neutral"
    votes["Order Flow (CVD Divergence)"] = s9_vote

    # -----------------------------------------------------------------------
    # Strategy 10: Quantitative Statistical Strategy
    # -----------------------------------------------------------------------
    # Reversion when Z-Score is outer-bound (>2 or <-2 std dev)
    std_val = df_std20[-1] if df_std20[-1] > 0 else 0.00001
    z_score = (current_price - df_ema20[-1]) / std_val
    s10_vote = "buy" if z_score < -2.0 else "sell" if z_score > 2.0 else "neutral"
    votes["Quantitative Statistical (Z-Score)"] = s10_vote

    # -----------------------------------------------------------------------
    # Strategy 11: SuperTrend Trend Following
    # -----------------------------------------------------------------------
    # ATR based SuperTrend: bands are built from the ATR and the trend only
    # flips when price actually closes through the opposite band.
    atr_series = pd.Series(tr).rolling(window=10).mean().values
    atr = atr_series[-1] if not np.isnan(atr_series[-1]) else float(np.mean(highs - lows))
    if not atr or np.isnan(atr):
        atr = 1.0

    st_multiplier = 2.0
    hl2 = (highs + lows) / 2.0
    st_upper = hl2 + st_multiplier * atr
    st_lower = hl2 - st_multiplier * atr

    # Walk the last 30 bars to establish which side of the SuperTrend we are on.
    st_direction = 1  # 1 = uptrend (price above lower band), -1 = downtrend
    for i in range(max(1, len(close) - 30), len(close)):
        if close[i] > st_upper[i - 1]:
            st_direction = 1
        elif close[i] < st_lower[i - 1]:
            st_direction = -1

    s11_vote = "buy" if st_direction == 1 else "sell"
    votes["SuperTrend Indicator"] = s11_vote

    # -----------------------------------------------------------------------
    # Strategy 12: Hull Moving Average (HMA) Momentum
    # -----------------------------------------------------------------------
    # Slow/Fast HMA crossovers proxy
    hma_fast = df['Close'].rolling(window=9).mean().values
    hma_slow = df['Close'].rolling(window=21).mean().values
    s12_vote = "buy" if hma_fast[-1] > hma_slow[-1] and hma_fast[-2] <= hma_slow[-2] else "sell" if hma_fast[-1] < hma_slow[-1] and hma_fast[-2] >= hma_slow[-2] else "neutral"
    votes["HMA Crossover Momentum"] = s12_vote

    # -----------------------------------------------------------------------
    # Confluence: votes contributed by the upstream specialist agents
    # -----------------------------------------------------------------------
    confluence = {}
    for name, signal in (extra_signals or {}).items():
        if not isinstance(signal, dict):
            continue
        bias = signal.get("bias", "neutral")
        confidence = signal.get("confidence", 0)
        # A low-confidence read is recorded for the log but does not get a vote.
        vote = bias if bias in ("buy", "sell") and confidence >= CONFLUENCE_MIN_CONFIDENCE else "neutral"
        votes[name] = vote
        confluence[name] = {"vote": vote, "confidence": confidence}

    total_signals = len(votes)

    # -----------------------------------------------------------------------
    # Consensus Tally & Logic
    # -----------------------------------------------------------------------
    buy_votes = sum(1 for v in votes.values() if v == "buy")
    sell_votes = sum(1 for v in votes.values() if v == "sell")
    neutral_votes = sum(1 for v in votes.values() if v == "neutral")
    
    # Requires at least MIN_CONSENSUS_VOTES confirming votes to form a consensus
    consensus = "neutral"
    if buy_votes > sell_votes and buy_votes >= MIN_CONSENSUS_VOTES:
        consensus = "buy"
    elif sell_votes > buy_votes and sell_votes >= MIN_CONSENSUS_VOTES:
        consensus = "sell"

        
    fallback_reasoning = (
        f"Deterministic vote tally confirmed {consensus.upper()} signal "
        f"based on {total_signals}-signal consensus "
        f"({TOTAL_STRATEGIES} strategies + {len(confluence)} specialist agents)."
    )

    indicator_summary = (
        f"- Current Price: {current_price:.2f} INR\n"
        f"- Strategy Votes:\n"
    )
    for name, vote in votes.items():
        indicator_summary += f"  * {name}: {vote.upper()}\n"
    indicator_summary += f"- Mathematical Consensus: {consensus.upper()}"

    prompt = (
        "You are an expert quantitative trading judge. Review these technical indicators and votes "
        f"from our {total_signals} advanced signals, then write a concise, professional "
        "1-to-2 sentence market reasoning explaining why the current market structure supports this "
        "consensus verdict. Output ONLY the reasoning sentences, nothing else.\n\n"
        f"Market Data:\n{indicator_summary}"
    )

    reasoning = llm.generate_text(prompt, log_func=log_func, agent_name="Strategy Judge") or fallback_reasoning

    if log_func:
        log_func("Strategy Judge", f"Collected votes from {total_signals} signals ({TOTAL_STRATEGIES} strategies + {len(confluence)} specialist agents):")
        for name, vote in votes.items():
            log_func("Strategy Judge", f"  - {name}: {vote.upper()}")
        log_func("Strategy Judge", f"Tally: {buy_votes} BUY, {sell_votes} SELL, {neutral_votes} NEUTRAL")
        log_func("Strategy Judge", f"Consensus Verdict: {consensus.upper()}")
        if reasoning:
            log_func("Strategy Judge", f"  - Reasoning: {reasoning}")
        
    return {
        "signal": consensus,
        "votes_buy": buy_votes,
        "votes_sell": sell_votes,
        "votes_neutral": neutral_votes,
        "total_signals": total_signals,
        "details": [{"name": k, "vote": v} for k, v in votes.items()],
        "confluence": confluence,
        "reasoning": reasoning
    }
