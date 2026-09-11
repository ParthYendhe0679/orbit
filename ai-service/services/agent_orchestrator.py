"""
backend/services/agent_orchestrator.py — ORBIT AI Agent Intelligence System (Phase 3).

Central orchestrator coordinating specialized quantitative and intelligence agents.
Consumes normalized, validated data exclusively from Phase 2's MarketDataService.
All agent outputs follow the standardized AgentResult schema with deterministic
signals (BULLISH, BEARISH, NEUTRAL), calculated metrics, and explainability points.
"""

import asyncio
import logging
import time
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from backend.models.agent import (
    AgentCategory,
    AgentOrchestrationResult,
    AgentResult,
    AgentSignal,
    AgentStatus,
)
from backend.services.market_data_service import MarketDataService, market_service

# Reusing existing quantitative implementations directly
import backend.agents.chart_analyst as chart_analyst
import backend.agents.indicator_analyst as indicator_analyst
import backend.agents.momentum_candle_analyst as momentum_candle_analyst
import backend.agents.ema_ribbon_analyst as ema_ribbon_analyst
import backend.agents.volatility_analyst as volatility_analyst
import backend.agents.volume_flow_analyst as volume_flow_analyst
import backend.agents.mtf_trend_analyst as mtf_trend_analyst
import backend.agents.news_analyst as news_analyst

logger = logging.getLogger("orbit.agent_system")


# ===========================================================================
# BASE AGENT INTERFACE
# ===========================================================================

class BaseAgent(ABC):
    """Abstract base class for all specialized ORBIT intelligence agents."""

    def __init__(self, agent_id: str, agent_name: str, category: AgentCategory):
        self.agent_id = agent_id
        self.agent_name = agent_name
        self.category = category

    @abstractmethod
    async def evaluate(self, symbol: str, df: pd.DataFrame, timeframe: str = "1d") -> AgentResult:
        """Analyze market data and return standardized AgentResult."""
        pass


# ===========================================================================
# 1. TREND AGENT
# ===========================================================================

class TrendAgent(BaseAgent):
    """
    Evaluates market trend direction, structural moving averages (EMA 50/200),
    fast EMA ribbon alignment (5/9/15), and multi-timeframe weekly alignment.
    """

    def __init__(self):
        super().__init__("trend_agent", "Trend Analyst", AgentCategory.TREND)

    async def evaluate(self, symbol: str, df: pd.DataFrame, timeframe: str = "1d") -> AgentResult:
        t0 = time.time()
        close = float(df["Close"].iloc[-1])

        # 1. Classical Indicators (EMA 50 & 200)
        ind_data = indicator_analyst.analyze_indicators(df)
        ema50 = ind_data.get("ema50", close)
        ema200 = ind_data.get("ema200", close)
        above_50 = close > ema50
        above_200 = close > ema200

        # 2. Fast EMA Ribbon (5/9/15)
        ribbon_data = ema_ribbon_analyst.analyze_ema_ribbon(df)
        ribbon_bias = ribbon_data.get("bias", "neutral").upper()
        ribbon_conf = ribbon_data.get("confidence", 50)
        ribbon_stacked = ribbon_data.get("stacked", False)
        spread_pct = ribbon_data.get("spread_pct", 0.0)

        # 3. Higher Timeframe Weekly Alignment
        mtf_data = mtf_trend_analyst.analyze_mtf_trend(df)
        htf_trend = mtf_data.get("htf_trend", "neutral").upper()
        ltf_trend = mtf_data.get("ltf_trend", "neutral").upper()
        mtf_aligned = mtf_data.get("aligned", False)

        # Consensus score calculation
        score = 0
        reasons = []

        if above_50 and above_200:
            score += 2
            reasons.append(f"Price ({close:.2f}) is firmly above both the 50 EMA ({ema50:.2f}) and 200 EMA ({ema200:.2f}).")
        elif not above_50 and not above_200:
            score -= 2
            reasons.append(f"Price ({close:.2f}) is trading below both the 50 EMA ({ema50:.2f}) and 200 EMA ({ema200:.2f}).")
        else:
            reasons.append(f"Price ({close:.2f}) is mixed between 50 EMA ({ema50:.2f}) and 200 EMA ({ema200:.2f}).")

        if ribbon_bias == "BUY":
            score += 2
            reasons.append(f"Fast EMA ribbon (5/9/15) is stacked bullishly with a {spread_pct:.2f}% spread.")
        elif ribbon_bias == "SELL":
            score -= 2
            reasons.append(f"Fast EMA ribbon (5/9/15) is stacked bearishly with a {spread_pct:.2f}% spread.")

        if mtf_aligned and htf_trend == "UPTREND":
            score += 2
            reasons.append(f"Higher timeframe (Weekly) confirms strong macro uptrend alignment.")
        elif mtf_aligned and htf_trend == "DOWNTREND":
            score -= 2
            reasons.append(f"Higher timeframe (Weekly) confirms macro downtrend alignment.")

        # Determine signal & confidence
        if score >= 3:
            signal = AgentSignal.BULLISH
            confidence = min(95.0, max(65.0, 50.0 + (score * 8.0) + (ribbon_conf * 0.2)))
            summary = f"Strong structural uptrend confirmed by moving average alignment and higher-timeframe trend."
        elif score <= -3:
            signal = AgentSignal.BEARISH
            confidence = min(95.0, max(65.0, 50.0 + (abs(score) * 8.0) + (ribbon_conf * 0.2)))
            summary = f"Decisive downtrend confirmed by bearish EMA stacking and lower-timeframe breakdowns."
        else:
            signal = AgentSignal.NEUTRAL
            confidence = 50.0
            summary = f"Trend is neutral or transitioning; moving average signals are currently mixed."

        return AgentResult(
            agent_id=self.agent_id,
            agent_name=self.agent_name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            signal=signal,
            confidence=round(confidence, 1),
            summary=summary,
            reasoning=reasons,
            metrics={
                "price": close,
                "ema50": round(ema50, 2),
                "ema200": round(ema200, 2),
                "ribbon_stacked": ribbon_stacked,
                "ribbon_spread_pct": round(spread_pct, 3),
                "htf_weekly_trend": htf_trend,
                "ltf_daily_trend": ltf_trend,
                "mtf_aligned": mtf_aligned
            },
            status=AgentStatus.SUCCESS,
            execution_time_ms=round((time.time() - t0) * 1000, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        )


# ===========================================================================
# 2. MOMENTUM AGENT
# ===========================================================================

class MomentumAgent(BaseAgent):
    """
    Measures rate of price velocity, RSI momentum extremes, MACD histogram
    expansions, and decisive 'Big Bar' candle expansion.
    """

    def __init__(self):
        super().__init__("momentum_agent", "Momentum Analyst", AgentCategory.MOMENTUM)

    async def evaluate(self, symbol: str, df: pd.DataFrame, timeframe: str = "1d") -> AgentResult:
        t0 = time.time()

        # 1. Classical RSI & MACD
        ind_data = indicator_analyst.analyze_indicators(df)
        rsi = float(ind_data.get("rsi", 50.0))
        macd_state = str(ind_data.get("macd", "neutral")).upper()
        macd_line = float(ind_data.get("macd_line", 0.0))
        macd_signal = float(ind_data.get("macd_signal", 0.0))
        macd_hist = macd_line - macd_signal

        # 2. Momentum Candle (Big Bar) Read
        candle_data = momentum_candle_analyst.analyze_momentum_candles(df)
        candle_bias = candle_data.get("bias", "neutral").upper()
        is_big_bar = candle_data.get("is_momentum_bar", False)
        body_ratio = candle_data.get("body_to_atr", 1.0)
        close_pos = candle_data.get("close_location", 0.5)

        reasons = []
        score = 0

        # RSI Evaluation
        if rsi > 70:
            score += 1
            reasons.append(f"RSI is in strong overbought momentum territory ({rsi:.1f}).")
        elif rsi >= 55:
            score += 2
            reasons.append(f"RSI is expanding bullishly above centerline ({rsi:.1f}).")
        elif rsi < 30:
            score -= 1
            reasons.append(f"RSI is in oversold exhaustion territory ({rsi:.1f}).")
        elif rsi <= 45:
            score -= 2
            reasons.append(f"RSI is declining below centerline ({rsi:.1f}), signaling downward pressure.")
        else:
            reasons.append(f"RSI is balanced in the neutral zone ({rsi:.1f}).")

        # MACD Evaluation
        if macd_state == "BULLISH":
            score += 2
            reasons.append(f"MACD line ({macd_line:.2f}) is positioned above signal ({macd_signal:.2f}) with positive momentum.")
        elif macd_state == "BEARISH":
            score -= 2
            reasons.append(f"MACD line ({macd_line:.2f}) is positioned below signal ({macd_signal:.2f}) showing negative momentum.")

        # Candle Expansion Evaluation
        if is_big_bar:
            if candle_bias == "BUY":
                score += 2
                reasons.append(f"Bullish 'Big Bar' expansion detected (body is {body_ratio:.1f}x normal ATR, closed near highs).")
            elif candle_bias == "SELL":
                score -= 2
                reasons.append(f"Bearish 'Big Bar' sell-off detected (body is {body_ratio:.1f}x normal ATR, closed near lows).")

        # Signal & Confidence
        if score >= 3:
            signal = AgentSignal.BULLISH
            confidence = min(92.0, max(60.0, 52.0 + (score * 7.5)))
            summary = "Positive price momentum accelerating with bullish RSI and MACD support."
        elif score <= -3:
            signal = AgentSignal.BEARISH
            confidence = min(92.0, max(60.0, 52.0 + (abs(score) * 7.5)))
            summary = "Negative price momentum dominant with weakening technical velocity."
        else:
            signal = AgentSignal.NEUTRAL
            confidence = 50.0
            summary = "Momentum indicators are balanced; no decisive directional thrust present."

        return AgentResult(
            agent_id=self.agent_id,
            agent_name=self.agent_name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            signal=signal,
            confidence=round(confidence, 1),
            summary=summary,
            reasoning=reasons,
            metrics={
                "rsi": round(rsi, 2),
                "macd_line": round(macd_line, 4),
                "macd_signal": round(macd_signal, 4),
                "macd_hist": round(macd_hist, 4),
                "is_big_bar": is_big_bar,
                "body_to_atr_ratio": round(body_ratio, 2),
                "close_location_pct": round(close_pos * 100, 1)
            },
            status=AgentStatus.SUCCESS,
            execution_time_ms=round((time.time() - t0) * 1000, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        )


# ===========================================================================
# 3. VOLUME AGENT
# ===========================================================================

class VolumeAgent(BaseAgent):
    """
    Measures institutional participation: On-Balance Volume (OBV),
    VWAP distance, volume surges relative to 20-day SMA, and volume-price divergences.
    """

    def __init__(self):
        super().__init__("volume_agent", "Volume Flow Analyst", AgentCategory.VOLUME)

    async def evaluate(self, symbol: str, df: pd.DataFrame, timeframe: str = "1d") -> AgentResult:
        t0 = time.time()
        vol_data = volume_flow_analyst.analyze_volume_flow(df)

        bias = vol_data.get("bias", "neutral").upper()
        confidence = float(vol_data.get("confidence", 50.0))
        obv_slope = str(vol_data.get("obv_slope", "neutral")).upper()
        price_vs_vwap = str(vol_data.get("price_vs_vwap", "near")).upper()
        surge = bool(vol_data.get("vol_surge", False))
        divergence = bool(vol_data.get("divergence", False))

        reasons = []
        if obv_slope == "RISING":
            reasons.append("On-Balance Volume (OBV) trend is sloping upwards, signaling sustained accumulation.")
        elif obv_slope == "FALLING":
            reasons.append("On-Balance Volume (OBV) trend is sloping downwards, signaling persistent distribution.")
        else:
            reasons.append("On-Balance Volume is flat, indicating balanced institutional participation.")

        if price_vs_vwap == "ABOVE":
            reasons.append("Price is holding above the rolling institutional VWAP benchmark.")
        elif price_vs_vwap == "BELOW":
            reasons.append("Price is trading beneath the rolling institutional VWAP benchmark.")

        if surge:
            reasons.append("Significant volume surge detected relative to the 20-day average.")

        if divergence:
            reasons.append("Volume-price divergence detected: volume is not confirming current price trajectory.")

        if bias == "BUY":
            signal = AgentSignal.BULLISH
            summary = "Volume flow confirms strong accumulation with supportive OBV and price above VWAP."
        elif bias == "SELL":
            signal = AgentSignal.BEARISH
            summary = "Volume flow confirms aggressive distribution with declining OBV and price below VWAP."
        else:
            signal = AgentSignal.NEUTRAL
            summary = "Volume participation is neutral and within average statistical parameters."

        return AgentResult(
            agent_id=self.agent_id,
            agent_name=self.agent_name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            signal=signal,
            confidence=round(confidence, 1),
            summary=summary,
            reasoning=reasons,
            metrics={
                "obv_slope": obv_slope,
                "price_vs_vwap": price_vs_vwap,
                "volume_surge": surge,
                "has_divergence": divergence,
                "summary": vol_data.get("summary", "")
            },
            status=AgentStatus.SUCCESS,
            execution_time_ms=round((time.time() - t0) * 1000, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        )


# ===========================================================================
# 4. VOLATILITY AGENT
# ===========================================================================

class VolatilityAgent(BaseAgent):
    """
    Evaluates market expansion and contraction regimes using ATR (14)
    and Bollinger Bandwidth squeeze metrics.
    """

    def __init__(self):
        super().__init__("volatility_agent", "Volatility Analyst", AgentCategory.VOLATILITY)

    async def evaluate(self, symbol: str, df: pd.DataFrame, timeframe: str = "1d") -> AgentResult:
        t0 = time.time()
        vol_data = volatility_analyst.analyze_volatility(df)

        regime = str(vol_data.get("regime", "normal")).upper()
        atr_pct = float(vol_data.get("atr_pct", 2.0))
        bb_width = float(vol_data.get("bb_bandwidth", 0.05))
        is_squeeze = bool(vol_data.get("squeeze", False))
        risk_multiplier = float(vol_data.get("risk_multiplier", 1.0))

        reasons = []
        if is_squeeze:
            reasons.append(f"Bollinger Bandwidth is at multi-week lows ({bb_width*100:.1f}%), signaling an active volatility squeeze.")
            reasons.append("A major volatility breakout is imminent as bands compress.")
        elif regime == "EXPANSION":
            reasons.append(f"Volatility is expanding with wide daily ranges (ATR: {atr_pct:.2f}% of price).")
        else:
            reasons.append(f"Volatility is within standard historical bounds (ATR: {atr_pct:.2f}% of price).")

        # Volatility Agent signal:
        # High volatility / squeeze prepares the risk engine. Squeeze = NEUTRAL with high breakout probability.
        if is_squeeze:
            signal = AgentSignal.NEUTRAL
            confidence = 80.0
            summary = "Market is in an active volatility squeeze; prepare for explosive directional expansion."
        elif regime == "EXPANSION":
            signal = AgentSignal.NEUTRAL
            confidence = 70.0
            summary = "High volatility expansion regime; wider stops and smaller position sizes are required."
        else:
            signal = AgentSignal.NEUTRAL
            confidence = 60.0
            summary = "Normal volatility regime; optimal for standard technical strategy execution."

        return AgentResult(
            agent_id=self.agent_id,
            agent_name=self.agent_name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            signal=signal,
            confidence=round(confidence, 1),
            summary=summary,
            reasoning=reasons,
            metrics={
                "regime": regime,
                "atr_percent": round(atr_pct, 2),
                "bb_bandwidth_percent": round(bb_width * 100, 2),
                "is_squeeze": is_squeeze,
                "risk_multiplier": risk_multiplier
            },
            status=AgentStatus.SUCCESS,
            execution_time_ms=round((time.time() - t0) * 1000, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        )


# ===========================================================================
# 5. MARKET REGIME AGENT
# ===========================================================================

class MarketRegimeAgent(BaseAgent):
    """
    Synthesizes directional trend strength (ADX Wilder's 14) with volatility states
    to classify the broader environment (TRENDING_BULLISH, TRENDING_BEARISH, RANGING, COMPRESSION).
    """

    def __init__(self):
        super().__init__("regime_agent", "Market Regime Analyst", AgentCategory.REGIME)

    async def evaluate(self, symbol: str, df: pd.DataFrame, timeframe: str = "1d") -> AgentResult:
        t0 = time.time()
        close = df["Close"].values
        highs = df["High"].values
        lows = df["Low"].values

        # Calculate ADX (Wilder's method)
        tr1 = highs - lows
        tr2 = np.abs(highs - np.roll(close, 1))
        tr3 = np.abs(lows - np.roll(close, 1))
        tr = np.maximum(tr1, np.maximum(tr2, tr3))
        tr[0] = tr1[0]

        up_move = highs - np.roll(highs, 1)
        down_move = np.roll(lows, 1) - lows
        plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
        minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)

        tr_smooth = pd.Series(tr).rolling(window=14).sum().values
        plus_dm_smooth = pd.Series(plus_dm).rolling(window=14).sum().values
        minus_dm_smooth = pd.Series(minus_dm).rolling(window=14).sum().values

        plus_di = (plus_dm_smooth / (tr_smooth + 1e-9)) * 100.0
        minus_di = (minus_dm_smooth / (tr_smooth + 1e-9)) * 100.0
        dx = (np.abs(plus_di - minus_di) / (plus_di + minus_di + 1e-9)) * 100.0
        adx_series = pd.Series(dx).rolling(window=14).mean().values

        curr_adx = float(adx_series[-1]) if not np.isnan(adx_series[-1]) else 20.0
        curr_pdi = float(plus_di[-1]) if not np.isnan(plus_di[-1]) else 20.0
        curr_mdi = float(minus_di[-1]) if not np.isnan(minus_di[-1]) else 20.0

        # Check Volatility Squeeze
        vol_data = volatility_analyst.analyze_volatility(df)
        is_squeeze = bool(vol_data.get("squeeze", False))

        reasons = []
        if curr_adx >= 25.0:
            is_trending = True
            reasons.append(f"ADX is {curr_adx:.1f} (above 25.0), confirming an established strong market trend.")
            if curr_pdi > curr_mdi:
                regime = "TRENDING_BULLISH"
                signal = AgentSignal.BULLISH
                reasons.append(f"+DI ({curr_pdi:.1f}) leads -DI ({curr_mdi:.1f}), showing sustained buyer dominance.")
                summary = "Bullish Trending Regime — trend-following strategies have strong statistical edge."
            else:
                regime = "TRENDING_BEARISH"
                signal = AgentSignal.BEARISH
                reasons.append(f"-DI ({curr_mdi:.1f}) leads +DI ({curr_pdi:.1f}), showing sustained seller dominance.")
                summary = "Bearish Trending Regime — short-side continuation strategies favored."
            confidence = min(92.0, 60.0 + (curr_adx - 25.0) * 1.5)
        elif is_squeeze:
            is_trending = False
            regime = "COMPRESSION_SQUEEZE"
            signal = AgentSignal.NEUTRAL
            confidence = 75.0
            reasons.append(f"ADX is {curr_adx:.1f} (sub-25) and Bollinger Bands are compressed.")
            reasons.append("Market is coiling; avoid breakout entries until direction resolves.")
            summary = "Compression Squeeze Regime — volatility is low and range is tightening."
        else:
            is_trending = False
            regime = "RANGING_CHOPPY"
            signal = AgentSignal.NEUTRAL
            confidence = 65.0
            reasons.append(f"ADX is {curr_adx:.1f} (below 20.0 threshold), indicating lack of directional momentum.")
            reasons.append("Mean reversion and boundary trading favored over breakout strategies.")
            summary = "Ranging / Choppy Regime — sideways price action without institutional direction."

        return AgentResult(
            agent_id=self.agent_id,
            agent_name=self.agent_name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            signal=signal,
            confidence=round(confidence, 1),
            summary=summary,
            reasoning=reasons,
            metrics={
                "regime": regime,
                "adx": round(curr_adx, 2),
                "plus_di": round(curr_pdi, 2),
                "minus_di": round(curr_mdi, 2),
                "is_trending": is_trending,
                "in_squeeze": is_squeeze
            },
            status=AgentStatus.SUCCESS,
            execution_time_ms=round((time.time() - t0) * 1000, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        )


# ===========================================================================
# 6. LEVELS & LIQUIDITY AGENT
# ===========================================================================

class LevelsAgent(BaseAgent):
    """
    Identifies structural support and resistance levels, liquidity pools,
    and calculates distance to major market supply/demand boundaries.
    """

    def __init__(self):
        super().__init__("levels_agent", "Levels Analyst", AgentCategory.LEVELS)

    async def evaluate(self, symbol: str, df: pd.DataFrame, timeframe: str = "1d") -> AgentResult:
        t0 = time.time()
        close = float(df["Close"].iloc[-1])

        sr_data = chart_analyst.find_support_resistance(df, window=5)
        supports = sr_data.get("supports", [])
        resistances = sr_data.get("resistances", [])
        liquidity = sr_data.get("liquidity", [])

        nearest_supp = max([s for s in supports if s < close], default=close * 0.95)
        nearest_res = min([r for r in resistances if r > close], default=close * 1.05)

        supp_dist_pct = ((close - nearest_supp) / close) * 100.0 if close > 0 else 0.0
        res_dist_pct = ((nearest_res - close) / close) * 100.0 if close > 0 else 0.0

        reasons = [
            f"Nearest major support zone identified at {nearest_supp:.2f} ({supp_dist_pct:.2f}% below price).",
            f"Nearest major resistance barrier identified at {nearest_res:.2f} ({res_dist_pct:.2f}% above price)."
        ]

        if len(liquidity) > 0:
            reasons.append(f"Active liquidity pools mapped at {len(liquidity)} key swing inflection points.")

        # Proximity bias: if testing support -> potential bounce (bullish), if testing resistance -> potential rejection (bearish)
        if supp_dist_pct < 1.0:
            signal = AgentSignal.BULLISH
            confidence = 70.0
            summary = f"Price is actively testing key support ({nearest_supp:.2f}); high reward-to-risk zone."
        elif res_dist_pct < 1.0:
            signal = AgentSignal.BEARISH
            confidence = 70.0
            summary = f"Price is encountering overhead resistance ({nearest_res:.2f}); elevated rejection risk."
        else:
            signal = AgentSignal.NEUTRAL
            confidence = 55.0
            summary = f"Price is trading within the normal range between support ({nearest_supp:.2f}) and resistance ({nearest_res:.2f})."

        return AgentResult(
            agent_id=self.agent_id,
            agent_name=self.agent_name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            signal=signal,
            confidence=round(confidence, 1),
            summary=summary,
            reasoning=reasons,
            metrics={
                "supports": [round(s, 2) for s in supports],
                "resistances": [round(r, 2) for r in resistances],
                "liquidity_pools": [round(l, 2) for l in liquidity],
                "nearest_support": round(nearest_supp, 2),
                "nearest_resistance": round(nearest_res, 2),
                "distance_to_support_pct": round(supp_dist_pct, 2),
                "distance_to_resistance_pct": round(res_dist_pct, 2)
            },
            status=AgentStatus.SUCCESS,
            execution_time_ms=round((time.time() - t0) * 1000, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        )


# ===========================================================================
# 7. NEWS SENTIMENT AGENT
# ===========================================================================

class SentimentAgent(BaseAgent):
    """
    Evaluates real-time financial news headlines using NewsAPI, Yahoo Finance RSS,
    and contextual LLM scoring with deterministic lexicon fallback.
    """

    def __init__(self):
        super().__init__("sentiment_agent", "News Analyst", AgentCategory.SENTIMENT)

    async def evaluate(self, symbol: str, df: pd.DataFrame, timeframe: str = "1d") -> AgentResult:
        t0 = time.time()
        # news_analyst runs off event loop
        sent_data = await asyncio.to_thread(news_analyst.analyze_sentiment, symbol)

        score = float(sent_data.get("score", 0.0))
        headlines = sent_data.get("headlines", [])
        count = len(headlines)

        reasons = []
        if score > 0.15:
            signal = AgentSignal.BULLISH
            summary = f"News sentiment is net bullish (+{score:.2f}) across {count} recent financial articles."
            reasons.append(f"Aggregate financial headlines exhibit positive institutional tone.")
        elif score < -0.15:
            signal = AgentSignal.BEARISH
            summary = f"News sentiment is net bearish ({score:.2f}) across {count} recent financial articles."
            reasons.append(f"Macro headlines highlight risk factors, headwinds, or selling pressure.")
        else:
            signal = AgentSignal.NEUTRAL
            summary = f"News sentiment is neutral ({score:.2f}) across {count} recent headlines."
            reasons.append("Headlines are balanced without prevailing catalyst bias.")

        if count > 0:
            top_title = headlines[0].get("title", "")
            reasons.append(f"Top headline: '{top_title[:85]}...'")

        confidence = min(90.0, max(50.0, 50.0 + (abs(score) * 40.0)))

        return AgentResult(
            agent_id=self.agent_id,
            agent_name=self.agent_name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            signal=signal,
            confidence=round(confidence, 1),
            summary=summary,
            reasoning=reasons,
            metrics={
                "sentiment_score": round(score, 3),
                "article_count": count,
                "top_source": headlines[0].get("source", "NewsAPI") if count > 0 else "None"
            },
            status=AgentStatus.SUCCESS,
            execution_time_ms=round((time.time() - t0) * 1000, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        )


# ===========================================================================
# 8. CENTRAL AGENT ORCHESTRATOR
# ===========================================================================

class AgentOrchestrator:
    """
    Central Orchestration Gateway for ORBIT AI Agents (Phase 3).

    Responsibilities:
      - Obtains standardized, validated market data exclusively from MarketDataService.
      - Dispatches analysis tasks across all 7 specialized intelligence agents concurrently.
      - Implements strict failure isolation (one agent failing does not bring down the suite).
      - Collects and aggregates structured outputs into a standardized AgentOrchestrationResult.
    """

    def __init__(self, data_service: Optional[MarketDataService] = None):
        self.market_service = data_service or market_service
        self.agents: Dict[str, BaseAgent] = {
            "trend": TrendAgent(),
            "momentum": MomentumAgent(),
            "volume": VolumeAgent(),
            "volatility": VolatilityAgent(),
            "regime": MarketRegimeAgent(),
            "levels": LevelsAgent(),
            "sentiment": SentimentAgent(),
        }

    def list_agents(self) -> List[Dict[str, str]]:
        """Returns catalog of registered intelligence agents."""
        return [
            {
                "id": a.agent_id,
                "agent_id": a.agent_id,
                "name": a.agent_name,
                "category": a.category.value,
            }
            for a in self.agents.values()
        ]

    async def analyze_symbol(
        self,
        symbol: str,
        timeframe: str = "1d",
        selected_agents: Optional[List[str]] = None,
        df: Optional[pd.DataFrame] = None,
    ) -> AgentOrchestrationResult:
        """
        Executes full multi-agent intelligence analysis for a ticker symbol.
        """
        t0 = time.time()
        upper_sym = symbol.strip().upper()

        # 1. Obtain verified market data through Phase 2 MarketDataService if not provided
        if df is not None:
            norm_df = df
        else:
            norm_df = await self.market_service.get_normalized_dataframe(upper_sym, period="60d", interval=timeframe)

        # 2. Select agents to execute
        agents_to_run = [
            agent for key, agent in self.agents.items()
            if not selected_agents or key in selected_agents or agent.agent_id in selected_agents
        ]

        # 3. Concurrent Fault-Tolerant Execution
        async def _run_safe(agent: BaseAgent) -> AgentResult:
            sub_t0 = time.time()
            try:
                return await agent.evaluate(upper_sym, norm_df, timeframe=timeframe)
            except Exception as exc:
                logger.error(f"Agent '{agent.agent_name}' failed for {upper_sym}: {exc}", exc_info=True)
                return AgentResult(
                    agent_id=agent.agent_id,
                    agent_name=agent.agent_name,
                    category=agent.category,
                    symbol=upper_sym,
                    timeframe=timeframe,
                    signal=AgentSignal.NEUTRAL,
                    confidence=0.0,
                    summary=f"Analysis failed: {str(exc)[:100]}",
                    reasoning=[f"Agent execution encountered an unhandled exception: {str(exc)}"],
                    metrics={},
                    status=AgentStatus.ERROR,
                    error_message=str(exc),
                    execution_time_ms=round((time.time() - sub_t0) * 1000, 2),
                    timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                )

        results: List[AgentResult] = await asyncio.gather(*[_run_safe(a) for a in agents_to_run])

        # 4. Aggregation and Metrics
        succeeded = [r for r in results if r.status == AgentStatus.SUCCESS]
        failed_count = len(results) - len(succeeded)

        tally = {"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0}
        total_conf = 0.0

        for r in succeeded:
            tally[r.signal.value] = tally.get(r.signal.value, 0) + 1
            total_conf += r.confidence

        avg_confidence = round(total_conf / len(succeeded), 1) if succeeded else 0.0
        total_time_ms = round((time.time() - t0) * 1000, 2)

        return AgentOrchestrationResult(
            symbol=upper_sym,
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            data_source="MarketDataService",
            agents_total=len(results),
            agents_succeeded=len(succeeded),
            agents_failed=failed_count,
            consensus_tally=tally,
            average_confidence=avg_confidence,
            execution_time_ms=total_time_ms,
            results=results
        )


# Global singleton instance for the ORBIT backend
agent_orchestrator = AgentOrchestrator()
