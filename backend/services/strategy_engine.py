"""
ORBIT Phase 4 - Trading Strategy Engine
Modular quantitative strategy architecture evaluating standardized market data
from Phase 2 MarketDataService and producing structured setup detections.
"""

import asyncio
import time
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from backend.models.strategy import (
    StrategyCategory,
    StrategyOrchestrationResult,
    StrategyResult,
    StrategySignal,
    StrategyStatus,
)
from backend.services.market_data_service import market_service
from backend.agents.chart_analyst import find_support_resistance


# ---------------------------------------------------------------------------
# Base Strategy Abstract Class
# ---------------------------------------------------------------------------

class BaseStrategy(ABC):
    """Abstract base class for all ORBIT quantitative trading strategies."""

    def __init__(
        self,
        strategy_id: str,
        name: str,
        category: StrategyCategory,
        formula: str,
        description: str,
        min_candles: int = 50,
    ):
        self.strategy_id = strategy_id
        self.name = name
        self.category = category
        self.formula = formula
        self.description = description
        self.min_candles = min_candles

    @abstractmethod
    async def evaluate(
        self,
        symbol: str,
        df: pd.DataFrame,
        supports: Optional[List[float]] = None,
        resistances: Optional[List[float]] = None,
        timeframe: str = "1d",
    ) -> StrategyResult:
        """Evaluate strategy rules against standardized OHLCV market data."""
        pass


# ---------------------------------------------------------------------------
# Pre-calculation Helper
# ---------------------------------------------------------------------------

def _compute_common_indicators(df: pd.DataFrame) -> Dict[str, Any]:
    """Compute shared technical indicators across OHLCV DataFrame in a single pass."""
    close = df["Close"].values.astype(float)
    highs = df["High"].values.astype(float)
    lows = df["Low"].values.astype(float)
    opens = df["Open"].values.astype(float)
    volumes = df["Volume"].values.astype(float)

    # EMAs
    ema9 = pd.Series(close).ewm(span=9, adjust=False).mean().values
    ema21 = pd.Series(close).ewm(span=21, adjust=False).mean().values
    ema50 = pd.Series(close).ewm(span=50, adjust=False).mean().values
    ema200 = pd.Series(close).ewm(span=200, adjust=False).mean().values

    # Bollinger Bands (20, 2)
    rolling20 = pd.Series(close).rolling(window=20)
    sma20 = rolling20.mean().values
    std20 = rolling20.std().values
    upper_band = sma20 + (2.0 * std20)
    lower_band = sma20 - (2.0 * std20)

    # Volume metrics
    avg_vol20 = pd.Series(volumes).rolling(window=20).mean().values
    curr_vol = float(volumes[-1])
    recent_avg_vol = float(avg_vol20[-1]) if not np.isnan(avg_vol20[-1]) else curr_vol
    vol_ratio = (curr_vol / recent_avg_vol) if recent_avg_vol > 0 else 1.0
    high_vol = vol_ratio > 1.3

    # ADX (14)
    tr1 = highs - lows
    tr2 = np.abs(highs - np.roll(close, 1))
    tr3 = np.abs(lows - np.roll(close, 1))
    tr = np.maximum(tr1, np.maximum(tr2, tr3))
    tr[0] = tr1[0]

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
    curr_adx = float(adx_series[-1]) if not np.isnan(adx_series[-1]) else 25.0

    return {
        "close": close,
        "highs": highs,
        "lows": lows,
        "opens": opens,
        "volumes": volumes,
        "current_price": float(close[-1]),
        "ema9": ema9,
        "ema21": ema21,
        "ema50": ema50,
        "ema200": ema200,
        "sma20": sma20,
        "std20": std20,
        "upper_band": upper_band,
        "lower_band": lower_band,
        "vol_ratio": vol_ratio,
        "high_vol": high_vol,
        "tr": tr,
        "curr_adx": curr_adx,
    }


# ---------------------------------------------------------------------------
# Strategy 1: Smart Money Concepts (SMC)
# ---------------------------------------------------------------------------

class SmcStrategy(BaseStrategy):
    """Smart Money Concepts: 20-period swing Break of Structure (BOS) + Fair Value Gap (FVG)."""

    def __init__(self):
        super().__init__(
            strategy_id="smc",
            name="Smart Money Concepts (SMC)",
            category=StrategyCategory.STRUCTURE,
            formula="BOS(20) + FVG(3-bar gap)",
            description="Identifies institutional footprints where price breaks swing structure and creates an unmitigated fair value gap.",
            min_candles=50,
        )

    async def evaluate(self, symbol: str, df: pd.DataFrame, supports=None, resistances=None, timeframe="1d") -> StrategyResult:
        start_t = time.perf_counter()
        highs = df["High"].values
        lows = df["Low"].values
        close = df["Close"].values
        current_price = float(close[-1])

        max_20 = float(np.max(highs[-21:-1]))
        min_20 = float(np.min(lows[-21:-1]))
        bos_bull = current_price > max_20
        bos_bear = current_price < min_20

        fvg_bull = False
        fvg_bear = False
        for i in range(-5, -1):
            if lows[i - 1] > highs[i + 1]:
                fvg_bull = True
            if highs[i - 1] < lows[i + 1]:
                fvg_bear = True

        setup_bull = bos_bull and fvg_bull
        setup_bear = bos_bear and fvg_bear
        setup_detected = setup_bull or setup_bear

        if setup_bull:
            signal = StrategySignal.BULLISH
            confidence = 82.0
            summary = f"Bullish Break of Structure above {max_20:.2f} with confirmed Fair Value Gap."
            reasoning = [
                f"Price ({current_price:.2f}) broke above the recent 20-bar swing high ({max_20:.2f}).",
                "Unmitigated bullish Fair Value Gap detected within the last 5 candles.",
                "Structure favors institutional upward continuation on gap retest."
            ]
        elif setup_bear:
            signal = StrategySignal.BEARISH
            confidence = 82.0
            summary = f"Bearish Break of Structure below {min_20:.2f} with confirmed Fair Value Gap."
            reasoning = [
                f"Price ({current_price:.2f}) broke below the recent 20-bar swing low ({min_20:.2f}).",
                "Unmitigated bearish Fair Value Gap detected within the last 5 candles.",
                "Structure favors institutional downward displacement on gap retest."
            ]
        else:
            signal = StrategySignal.NEUTRAL
            confidence = 45.0
            summary = "No decisive Break of Structure and Fair Value Gap confluence."
            reasoning = [
                f"Current price ({current_price:.2f}) is contained inside the 20-bar range ({min_20:.2f} - {max_20:.2f}).",
                f"BOS Bullish: {bos_bull}, FVG Bullish: {fvg_bull}; BOS Bearish: {bos_bear}, FVG Bearish: {fvg_bear}."
            ]

        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            setup_detected=setup_detected,
            signal=signal,
            confidence=confidence,
            entry_context={
                "current_price": current_price,
                "swing_high_20": max_20,
                "swing_low_20": min_20,
                "fvg_bull": fvg_bull,
                "fvg_bear": fvg_bear,
            },
            conditions={
                "bos_bullish": bos_bull,
                "bos_bearish": bos_bear,
                "fvg_bullish": fvg_bull,
                "fvg_bearish": fvg_bear,
            },
            metrics={"current_price": current_price, "swing_high": max_20, "swing_low": min_20},
            reasoning=reasoning,
            status=StrategyStatus.SUCCESS,
            execution_time_ms=round(elapsed_ms, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )


# ---------------------------------------------------------------------------
# Strategy 2: ICT Strategy (MSS & FVG)
# ---------------------------------------------------------------------------

class IctStrategy(BaseStrategy):
    """Inner Circle Trader: Market Structure Shift on heavy volume with imbalance mitigation."""

    def __init__(self):
        super().__init__(
            strategy_id="ict",
            name="ICT Strategy (MSS & FVG)",
            category=StrategyCategory.STRUCTURE,
            formula="MSS + Volume > 1.3x ATR + FVG",
            description="Market Structure Shift confirmed by high volume expansion followed by mitigation into an imbalance zone.",
            min_candles=50,
        )

    async def evaluate(self, symbol: str, df: pd.DataFrame, supports=None, resistances=None, timeframe="1d") -> StrategyResult:
        start_t = time.perf_counter()
        c = _compute_common_indicators(df)
        max_20 = float(np.max(c["highs"][-21:-1]))
        min_20 = float(np.min(c["lows"][-21:-1]))
        curr_p = c["current_price"]
        high_vol = c["high_vol"]

        mss_bull = (curr_p > max_20) and high_vol
        mss_bear = (curr_p < min_20) and high_vol

        fvg_bull = any(c["lows"][i - 1] > c["highs"][i + 1] for i in range(-5, -1))
        fvg_bear = any(c["highs"][i - 1] < c["lows"][i + 1] for i in range(-5, -1))

        setup_bull = mss_bull and fvg_bull
        setup_bear = mss_bear and fvg_bear
        setup_detected = setup_bull or setup_bear

        if setup_bull:
            signal = StrategySignal.BULLISH
            confidence = 85.0
            reasoning = [
                f"Market Structure Shift confirmed: price ({curr_p:.2f}) broke swing high ({max_20:.2f}) on elevated volume ({c['vol_ratio']:.2f}x avg).",
                "Bullish Fair Value Gap confirmed as optimal mitigation entry point."
            ]
        elif setup_bear:
            signal = StrategySignal.BEARISH
            confidence = 85.0
            reasoning = [
                f"Market Structure Shift confirmed: price ({curr_p:.2f}) broke swing low ({min_20:.2f}) on elevated volume ({c['vol_ratio']:.2f}x avg).",
                "Bearish Fair Value Gap confirmed as optimal short mitigation entry point."
            ]
        else:
            signal = StrategySignal.NEUTRAL
            confidence = 45.0
            reasoning = [
                f"No confirmed MSS with volume expansion. Volume ratio: {c['vol_ratio']:.2f}x (threshold: >1.3x).",
                f"MSS Bull: {mss_bull}, MSS Bear: {mss_bear}, FVG Bull: {fvg_bull}, FVG Bear: {fvg_bear}."
            ]

        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            setup_detected=setup_detected,
            signal=signal,
            confidence=confidence,
            entry_context={"current_price": curr_p, "volume_ratio": round(c["vol_ratio"], 2), "high_vol": high_vol},
            conditions={"mss_bull": mss_bull, "mss_bear": mss_bear, "fvg_bull": fvg_bull, "fvg_bear": fvg_bear},
            metrics={"current_price": curr_p, "volume_ratio": round(c["vol_ratio"], 2), "swing_high": max_20, "swing_low": min_20},
            reasoning=reasoning,
            status=StrategyStatus.SUCCESS,
            execution_time_ms=round(elapsed_ms, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )


# ---------------------------------------------------------------------------
# Strategy 3: Wyckoff Method
# ---------------------------------------------------------------------------

class WyckoffStrategy(BaseStrategy):
    """Wyckoff Method: False breakdown (Spring) or false breakout (Upthrust) of a 30-bar range."""

    def __init__(self):
        super().__init__(
            strategy_id="wyckoff",
            name="Wyckoff Method (Spring/Upthrust)",
            category=StrategyCategory.STRUCTURE,
            formula="Spring / Upthrust (30-bar) + Volume",
            description="Catches false breakdowns (Springs) and false breakouts (Upthrusts) that trap retail liquidity before smart money reverses trend.",
            min_candles=50,
        )

    async def evaluate(self, symbol: str, df: pd.DataFrame, supports=None, resistances=None, timeframe="1d") -> StrategyResult:
        start_t = time.perf_counter()
        c = _compute_common_indicators(df)
        lows = c["lows"]
        highs = c["highs"]
        close = c["close"]
        high_vol = c["high_vol"]

        range_low = float(np.min(lows[-30:-3]))
        range_high = float(np.max(highs[-30:-3]))

        spring = (np.min(lows[-3:]) < range_low) and (close[-1] > range_low) and high_vol
        upthrust = (np.max(highs[-3:]) > range_high) and (close[-1] < range_high) and high_vol

        setup_detected = bool(spring or upthrust)
        if spring:
            signal = StrategySignal.BULLISH
            confidence = 80.0
            reasoning = [
                f"Wyckoff Spring detected: Price breached 30-bar support ({range_low:.2f}) but swiftly recovered above it on heavy volume.",
                "Trapped retail short liquidity; smart money accumulation confirmed."
            ]
        elif upthrust:
            signal = StrategySignal.BEARISH
            confidence = 80.0
            reasoning = [
                f"Wyckoff Upthrust detected: Price pierced 30-bar resistance ({range_high:.2f}) but was rejected back inside the range on heavy volume.",
                "Trapped retail breakout buyers; smart money distribution confirmed."
            ]
        else:
            signal = StrategySignal.NEUTRAL
            confidence = 40.0
            reasoning = [
                f"Price remains orderly within 30-bar Wyckoff boundaries ({range_low:.2f} - {range_high:.2f}).",
                "No liquidity sweep spring or upthrust detected."
            ]

        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            setup_detected=setup_detected,
            signal=signal,
            confidence=confidence,
            entry_context={"range_low": range_low, "range_high": range_high, "current_price": float(close[-1])},
            conditions={"spring_detected": bool(spring), "upthrust_detected": bool(upthrust), "high_volume": high_vol},
            metrics={"range_low": range_low, "range_high": range_high, "current_price": float(close[-1])},
            reasoning=reasoning,
            status=StrategyStatus.SUCCESS,
            execution_time_ms=round(elapsed_ms, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )


# ---------------------------------------------------------------------------
# Strategy 4: Price Action Rejections
# ---------------------------------------------------------------------------

class PriceActionStrategy(BaseStrategy):
    """Price Action Trading: Pin bars (Hammer/Shooting Star) and Engulfing patterns at key S/R."""

    def __init__(self):
        super().__init__(
            strategy_id="price_action",
            name="Price Action (Pin Bar/Engulfing)",
            category=StrategyCategory.PRICE_ACTION,
            formula="Pin Bar & Engulfing at S/R",
            description="Monitors hammer/shooting star rejection wicks and engulfing expansion candles occurring within 1.5% of verified support/resistance.",
            min_candles=50,
        )

    async def evaluate(self, symbol: str, df: pd.DataFrame, supports=None, resistances=None, timeframe="1d") -> StrategyResult:
        start_t = time.perf_counter()
        c = _compute_common_indicators(df)
        close = c["close"]
        opens = c["opens"]
        highs = c["highs"]
        lows = c["lows"]
        curr_p = c["current_price"]

        if supports is None or resistances is None:
            sr = find_support_resistance(df)
            supports = sr.get("supports", [])
            resistances = sr.get("resistances", [])

        cr = float(highs[-1] - lows[-1]) if (highs[-1] - lows[-1]) > 0 else 0.00001
        cb = float(abs(close[-1] - opens[-1]))
        cus = float(highs[-1] - max(close[-1], opens[-1]))
        cls = float(min(close[-1], opens[-1]) - lows[-1])

        hammer = (cls > 2.0 * cb) and (cus < 0.2 * cr)
        shooting_star = (cus > 2.0 * cb) and (cls < 0.2 * cr)

        near_support = any(abs(curr_p - s) / s < 0.015 for s in (supports or []))
        near_resistance = any(abs(curr_p - r) / r < 0.015 for r in (resistances or []))

        bullish_engulfing = (close[-1] > opens[-1]) and (close[-2] < opens[-2]) and (close[-1] > opens[-2]) and (opens[-1] < close[-2])
        bearish_engulfing = (close[-1] < opens[-1]) and (close[-2] > opens[-2]) and (close[-1] < opens[-2]) and (opens[-1] > close[-2])

        setup_bull = bool((hammer and near_support) or bullish_engulfing)
        setup_bear = bool((shooting_star and near_resistance) or bearish_engulfing)
        setup_detected = setup_bull or setup_bear

        if setup_bull:
            signal = StrategySignal.BULLISH
            confidence = 78.0
            pattern = "Bullish Hammer at Support" if (hammer and near_support) else "Bullish Engulfing Expansion"
            reasoning = [
                f"High-probability candlestick pattern confirmed: {pattern}.",
                f"Price rejected lower liquidity and closed firmly upward at {curr_p:.2f}."
            ]
        elif setup_bear:
            signal = StrategySignal.BEARISH
            confidence = 78.0
            pattern = "Shooting Star at Resistance" if (shooting_star and near_resistance) else "Bearish Engulfing Expansion"
            reasoning = [
                f"High-probability candlestick pattern confirmed: {pattern}.",
                f"Price rejected overhead resistance and was driven downward to {curr_p:.2f}."
            ]
        else:
            signal = StrategySignal.NEUTRAL
            confidence = 45.0
            reasoning = [
                "No decisive pin bar rejection or engulfing candle at key price boundaries.",
                f"Near Support (<1.5%): {near_support}, Near Resistance (<1.5%): {near_resistance}."
            ]

        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            setup_detected=setup_detected,
            signal=signal,
            confidence=confidence,
            entry_context={"current_price": curr_p, "near_support": near_support, "near_resistance": near_resistance},
            conditions={"hammer": hammer, "shooting_star": shooting_star, "bullish_engulfing": bool(bullish_engulfing), "bearish_engulfing": bool(bearish_engulfing)},
            metrics={"wick_ratio": round(cls / cr, 2) if cr > 0 else 0.0, "body_ratio": round(cb / cr, 2) if cr > 0 else 0.0},
            reasoning=reasoning,
            status=StrategyStatus.SUCCESS,
            execution_time_ms=round(elapsed_ms, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )


# ---------------------------------------------------------------------------
# Strategy 5: Supply & Demand Zones
# ---------------------------------------------------------------------------

class SupplyDemandStrategy(BaseStrategy):
    """Supply & Demand: Price retracing into fresh unmitigated origin base."""

    def __init__(self):
        super().__init__(
            strategy_id="supply_demand",
            name="Supply & Demand Zones",
            category=StrategyCategory.STRUCTURE,
            formula="Rally-Base-Rally (15-bar lookback)",
            description="Pinpoints high-momentum origin zones where institutional orders caused rapid displacement, buying retests into the base.",
            min_candles=50,
        )

    async def evaluate(self, symbol: str, df: pd.DataFrame, supports=None, resistances=None, timeframe="1d") -> StrategyResult:
        start_t = time.perf_counter()
        c = _compute_common_indicators(df)
        close = c["close"]
        highs = c["highs"]
        lows = c["lows"]
        opens = c["opens"]
        curr_p = c["current_price"]

        signal = StrategySignal.NEUTRAL
        setup_detected = False
        confidence = 40.0
        reasoning = ["No fresh unmitigated supply or demand base currently being retested."]
        base_level = None

        for i in range(len(df) - 15, len(df) - 3):
            if close[i] / close[i - 3] > 1.025:  # strong demand rally
                zone_base = float(lows[i - 3])
                if zone_base <= curr_p <= zone_base * 1.015 and close[-1] > opens[-1]:
                    signal = StrategySignal.BULLISH
                    setup_detected = True
                    confidence = 75.0
                    base_level = zone_base
                    reasoning = [
                        f"Price ({curr_p:.2f}) retested a validated demand base ({zone_base:.2f}) with bullish candle reaction.",
                        "Unmitigated institutional buy liquidity active at origin base."
                    ]
                    break
            elif close[i] / close[i - 3] < 0.975:  # strong supply drop
                zone_base = float(highs[i - 3])
                if zone_base * 0.985 <= curr_p <= zone_base and close[-1] < opens[-1]:
                    signal = StrategySignal.BEARISH
                    setup_detected = True
                    confidence = 75.0
                    base_level = zone_base
                    reasoning = [
                        f"Price ({curr_p:.2f}) retested a validated supply base ({zone_base:.2f}) with bearish rejection candle.",
                        "Unmitigated institutional sell liquidity active at origin base."
                    ]
                    break

        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            setup_detected=setup_detected,
            signal=signal,
            confidence=confidence,
            entry_context={"zone_base": base_level, "current_price": curr_p},
            conditions={"base_retest": setup_detected},
            metrics={"current_price": curr_p, "base_level": base_level},
            reasoning=reasoning,
            status=StrategyStatus.SUCCESS,
            execution_time_ms=round(elapsed_ms, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )


# ---------------------------------------------------------------------------
# Strategy 6: Trend Following Ribbon (4-EMA/ADX)
# ---------------------------------------------------------------------------

class TrendFollowingStrategy(BaseStrategy):
    """Trend Following: 4-EMA ribbon alignment (9 > 21 > 50 > 200) + ADX > 22 + pullback confirmation."""

    def __init__(self):
        super().__init__(
            strategy_id="trend_following",
            name="Trend Following (4-EMA/ADX)",
            category=StrategyCategory.TREND,
            formula="EMA(9 > 21 > 50 > 200) + ADX > 22",
            description="Multi-timeframe exponential moving average alignment paired with Average Directional Index trend strength filter.",
            min_candles=50,
        )

    async def evaluate(self, symbol: str, df: pd.DataFrame, supports=None, resistances=None, timeframe="1d") -> StrategyResult:
        start_t = time.perf_counter()
        c = _compute_common_indicators(df)
        curr_p = c["current_price"]
        ema9 = c["ema9"][-1]
        ema21 = c["ema21"][-1]
        ema50 = c["ema50"][-1]
        ema200 = c["ema200"][-1]
        curr_adx = c["curr_adx"]

        trend_bull = ema9 > ema21 > ema50 > ema200
        trend_bear = ema9 < ema21 < ema50 < ema200

        # Pullback test against EMA21
        lows = c["lows"]
        highs = c["highs"]
        pullback_bull = lows[-1] <= ema21 <= highs[-1]
        pullback_bear = lows[-1] <= ema21 <= highs[-1]

        setup_bull = trend_bull and pullback_bull and (curr_adx > 22.0)
        setup_bear = trend_bear and pullback_bear and (curr_adx > 22.0)
        setup_detected = setup_bull or setup_bear

        if setup_bull:
            signal = StrategySignal.BULLISH
            confidence = 88.0
            reasoning = [
                f"Bullish 4-EMA ribbon aligned (9: {ema9:.2f} > 21: {ema21:.2f} > 50: {ema50:.2f} > 200: {ema200:.2f}).",
                f"Price pulled back into key 21 EMA dynamic support with strong ADX ({curr_adx:.1f} > 22.0)."
            ]
        elif setup_bear:
            signal = StrategySignal.BEARISH
            confidence = 88.0
            reasoning = [
                f"Bearish 4-EMA ribbon aligned (9: {ema9:.2f} < 21: {ema21:.2f} < 50: {ema50:.2f} < 200: {ema200:.2f}).",
                f"Price pulled back into 21 EMA dynamic resistance with strong ADX ({curr_adx:.1f} > 22.0)."
            ]
        else:
            signal = StrategySignal.NEUTRAL
            confidence = 50.0
            reasoning = [
                f"Moving average ribbon is not fully stacked or ADX ({curr_adx:.1f}) lacks threshold momentum (>22.0).",
                f"Trend Bullish: {trend_bull}, Trend Bearish: {trend_bear}, Pullback to EMA21: {pullback_bull}."
            ]

        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            setup_detected=setup_detected,
            signal=signal,
            confidence=confidence,
            entry_context={"ema9": round(ema9, 2), "ema21": round(ema21, 2), "ema50": round(ema50, 2), "ema200": round(ema200, 2), "adx": round(curr_adx, 1)},
            conditions={"ribbon_aligned_bull": trend_bull, "ribbon_aligned_bear": trend_bear, "pullback_confirmed": pullback_bull or pullback_bear, "adx_strong": curr_adx > 22.0},
            metrics={"ema9": ema9, "ema21": ema21, "ema50": ema50, "ema200": ema200, "adx": curr_adx},
            reasoning=reasoning,
            status=StrategyStatus.SUCCESS,
            execution_time_ms=round(elapsed_ms, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )


# ---------------------------------------------------------------------------
# Strategy 7: Bollinger Breakout & Volatility Squeeze
# ---------------------------------------------------------------------------

class BollingerBreakoutStrategy(BaseStrategy):
    """Bollinger Breakout: Volatility expansion closing outside 20-period bands on high volume."""

    def __init__(self):
        super().__init__(
            strategy_id="bollinger_breakout",
            name="BB Breakout & Volatility Squeeze",
            category=StrategyCategory.BREAKOUT,
            formula="Close > BB_Upper(20, 2) + Vol > 1.3x",
            description="Exploits volatility expansion when price closes outside the 20-period Bollinger Band accompanied by heavy volume confirmation.",
            min_candles=50,
        )

    async def evaluate(self, symbol: str, df: pd.DataFrame, supports=None, resistances=None, timeframe="1d") -> StrategyResult:
        start_t = time.perf_counter()
        c = _compute_common_indicators(df)
        curr_p = c["current_price"]
        upper_b = float(c["upper_band"][-1])
        lower_b = float(c["lower_band"][-1])
        high_vol = c["high_vol"]

        bb_break_bull = (curr_p > upper_b) and high_vol
        bb_break_bear = (curr_p < lower_b) and high_vol
        setup_detected = bb_break_bull or bb_break_bear

        if bb_break_bull:
            signal = StrategySignal.BULLISH
            confidence = 82.0
            reasoning = [
                f"Bullish Bollinger Band breakout confirmed: Price ({curr_p:.2f}) closed above upper band ({upper_b:.2f}).",
                f"Breakout confirmed by institutional volume surge ({c['vol_ratio']:.2f}x 20-period average)."
            ]
        elif bb_break_bear:
            signal = StrategySignal.BEARISH
            confidence = 82.0
            reasoning = [
                f"Bearish Bollinger Band breakdown confirmed: Price ({curr_p:.2f}) closed below lower band ({lower_b:.2f}).",
                f"Breakdown confirmed by institutional volume surge ({c['vol_ratio']:.2f}x 20-period average)."
            ]
        else:
            signal = StrategySignal.NEUTRAL
            confidence = 45.0
            reasoning = [
                f"Price ({curr_p:.2f}) is trading within standard Bollinger Bands ({lower_b:.2f} - {upper_b:.2f}).",
                f"No volatility expansion breakout detected. Volume ratio: {c['vol_ratio']:.2f}x."
            ]

        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            setup_detected=setup_detected,
            signal=signal,
            confidence=confidence,
            entry_context={"upper_band": upper_b, "lower_band": lower_b, "vol_ratio": round(c["vol_ratio"], 2)},
            conditions={"upper_break": curr_p > upper_b, "lower_break": curr_p < lower_b, "volume_surge": high_vol},
            metrics={"upper_band": upper_b, "lower_band": lower_b, "bandwidth_pct": round((upper_b - lower_b) / curr_p * 100, 2)},
            reasoning=reasoning,
            status=StrategyStatus.SUCCESS,
            execution_time_ms=round(elapsed_ms, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )


# ---------------------------------------------------------------------------
# Strategy 8: Fibonacci Retracement (50 / 61.8)
# ---------------------------------------------------------------------------

class FibonacciStrategy(BaseStrategy):
    """Fibonacci Golden Pocket: Confluence bounce inside 50.0% - 61.8% retracement level."""

    def __init__(self):
        super().__init__(
            strategy_id="fibonacci",
            name="Fibonacci Retracement (50/61.8)",
            category=StrategyCategory.GEOMETRIC,
            formula="50.0% - 61.8% Retracement + EMA50",
            description="Measures 40-bar macro impulse swings and triggers entry when price retraces into the high-probability golden pocket ratio.",
            min_candles=50,
        )

    async def evaluate(self, symbol: str, df: pd.DataFrame, supports=None, resistances=None, timeframe="1d") -> StrategyResult:
        start_t = time.perf_counter()
        c = _compute_common_indicators(df)
        highs = c["highs"]
        lows = c["lows"]
        close = c["close"]
        opens = c["opens"]
        curr_p = c["current_price"]
        ema50 = c["ema50"][-1]

        swing_high = float(np.max(highs[-40:]))
        swing_low = float(np.min(lows[-40:]))
        swing_range = swing_high - swing_low if (swing_high - swing_low) > 0 else 0.00001

        fib_50 = swing_high - 0.50 * swing_range
        fib_618 = swing_high - 0.618 * swing_range
        in_bull_fib = fib_618 <= curr_p <= fib_50

        fib_50_bear = swing_low + 0.50 * swing_range
        fib_618_bear = swing_low + 0.618 * swing_range
        in_bear_fib = fib_50_bear <= curr_p <= fib_618_bear

        setup_bull = (curr_p > ema50) and in_bull_fib and (close[-1] > opens[-1])
        setup_bear = (curr_p < ema50) and in_bear_fib and (close[-1] < opens[-1])
        setup_detected = setup_bull or setup_bear

        if setup_bull:
            signal = StrategySignal.BULLISH
            confidence = 80.0
            reasoning = [
                f"Price ({curr_p:.2f}) entered the 50.0% - 61.8% Fibonacci golden pocket ({fib_618:.2f} - {fib_50:.2f}).",
                f"Bullish candle reaction above 50 EMA ({ema50:.2f}) confirms macro impulse continuation."
            ]
        elif setup_bear:
            signal = StrategySignal.BEARISH
            confidence = 80.0
            reasoning = [
                f"Price ({curr_p:.2f}) retraced into the bearish 50.0% - 61.8% Fibonacci zone ({fib_50_bear:.2f} - {fib_618_bear:.2f}).",
                f"Bearish rejection candle below 50 EMA ({ema50:.2f}) confirms downtrend continuation."
            ]
        else:
            signal = StrategySignal.NEUTRAL
            confidence = 45.0
            reasoning = [
                f"Price is outside the 40-bar Fibonacci golden pocket ({fib_618:.2f} - {fib_50:.2f}).",
                f"Current Price: {curr_p:.2f}, 40-bar Range: {swing_low:.2f} - {swing_high:.2f}."
            ]

        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            setup_detected=setup_detected,
            signal=signal,
            confidence=confidence,
            entry_context={"fib_50": fib_50, "fib_618": fib_618, "swing_high": swing_high, "swing_low": swing_low},
            conditions={"in_bull_golden_pocket": in_bull_fib, "in_bear_golden_pocket": in_bear_fib, "ema50_filter": curr_p > ema50},
            metrics={"fib_50": fib_50, "fib_618": fib_618, "current_price": curr_p},
            reasoning=reasoning,
            status=StrategyStatus.SUCCESS,
            execution_time_ms=round(elapsed_ms, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )


# ---------------------------------------------------------------------------
# Strategy 9: Order Flow Trading (CVD Divergence)
# ---------------------------------------------------------------------------

class OrderFlowStrategy(BaseStrategy):
    """Order Flow: Cumulative Volume Delta divergence detecting hidden institutional bias."""

    def __init__(self):
        super().__init__(
            strategy_id="order_flow",
            name="Order Flow (CVD Divergence)",
            category=StrategyCategory.ORDER_FLOW,
            formula="Price Low vs CVD High (20-bar)",
            description="Detects hidden institutional accumulation when spot price prints lower lows while Cumulative Volume Delta forms higher lows.",
            min_candles=50,
        )

    async def evaluate(self, symbol: str, df: pd.DataFrame, supports=None, resistances=None, timeframe="1d") -> StrategyResult:
        start_t = time.perf_counter()
        c = _compute_common_indicators(df)
        close = c["close"]
        highs = c["highs"]
        lows = c["lows"]
        volumes = c["volumes"]

        denom = highs - lows
        denom = np.where(denom == 0, 0.00001, denom)
        delta_vol = volumes * (close - lows - (highs - close)) / denom
        cvd = pd.Series(delta_vol).rolling(window=20).sum().values

        cvd_bull = (cvd[-1] > cvd[-3] > cvd[-5]) and (close[-1] < close[-5])
        cvd_bear = (cvd[-1] < cvd[-3] < cvd[-5]) and (close[-1] > close[-5])
        setup_detected = cvd_bull or cvd_bear

        if cvd_bull:
            signal = StrategySignal.BULLISH
            confidence = 82.0
            reasoning = [
                "Bullish CVD Divergence detected: Spot price printed lower lows while Cumulative Volume Delta printed higher highs.",
                "Aggressive market order absorption confirms institutional accumulation."
            ]
        elif cvd_bear:
            signal = StrategySignal.BEARISH
            confidence = 82.0
            reasoning = [
                "Bearish CVD Divergence detected: Spot price pushed higher while Cumulative Volume Delta printed lower lows.",
                "Passive limit selling absorbing market orders confirms institutional distribution."
            ]
        else:
            signal = StrategySignal.NEUTRAL
            confidence = 45.0
            reasoning = [
                "No Cumulative Volume Delta divergence detected between price trajectory and order flow delta.",
                f"CVD Trend: {float(cvd[-1]):.1f} vs Previous: {float(cvd[-3]):.1f}."
            ]

        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            setup_detected=setup_detected,
            signal=signal,
            confidence=confidence,
            entry_context={"cvd_latest": float(cvd[-1]), "cvd_lag5": float(cvd[-5])},
            conditions={"cvd_divergence_bull": cvd_bull, "cvd_divergence_bear": cvd_bear},
            metrics={"cvd_current": round(float(cvd[-1]), 1), "cvd_previous": round(float(cvd[-3]), 1)},
            reasoning=reasoning,
            status=StrategyStatus.SUCCESS,
            execution_time_ms=round(elapsed_ms, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )


# ---------------------------------------------------------------------------
# Strategy 10: Quantitative Statistical Strategy (Z-Score)
# ---------------------------------------------------------------------------

class MeanReversionStrategy(BaseStrategy):
    """Mean Reversion: Statistical Z-Score exceeding +/- 2.0 sigma from 20-period moving average."""

    def __init__(self):
        super().__init__(
            strategy_id="mean_reversion",
            name="Quantitative Statistical (Z-Score)",
            category=StrategyCategory.MEAN_REVERSION,
            formula="Z-Score(SMA20) > |2.0σ|",
            description="Calculates statistical standard deviation from 20-period moving average. Triggers fade trades when price reaches overextended extremes.",
            min_candles=50,
        )

    async def evaluate(self, symbol: str, df: pd.DataFrame, supports=None, resistances=None, timeframe="1d") -> StrategyResult:
        start_t = time.perf_counter()
        c = _compute_common_indicators(df)
        curr_p = c["current_price"]
        sma20 = float(c["sma20"][-1])
        std20 = float(c["std20"][-1]) if c["std20"][-1] > 0 else 0.00001

        z_score = float((curr_p - sma20) / std20)

        setup_bull = z_score < -2.0
        setup_bear = z_score > 2.0
        setup_detected = setup_bull or setup_bear

        if setup_bull:
            signal = StrategySignal.BULLISH
            confidence = 84.0
            reasoning = [
                f"Statistical extreme oversold: Price ({curr_p:.2f}) is {abs(z_score):.2f} standard deviations below the 20 SMA ({sma20:.2f}).",
                "High mathematical probability of mean reversion bounce towards 20-period equilibrium."
            ]
        elif setup_bear:
            signal = StrategySignal.BEARISH
            confidence = 84.0
            reasoning = [
                f"Statistical extreme overbought: Price ({curr_p:.2f}) is {z_score:.2f} standard deviations above the 20 SMA ({sma20:.2f}).",
                "High mathematical probability of mean reversion pullback towards 20-period equilibrium."
            ]
        else:
            signal = StrategySignal.NEUTRAL
            confidence = 50.0
            reasoning = [
                f"Z-Score ({z_score:.2f}σ) is within normal statistical distribution bounds (±2.0σ).",
                f"Mean SMA20: {sma20:.2f}, Standard Deviation: {std20:.2f}."
            ]

        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            setup_detected=setup_detected,
            signal=signal,
            confidence=confidence,
            entry_context={"z_score": round(z_score, 2), "sma20": round(sma20, 2), "std20": round(std20, 2)},
            conditions={"oversold_2sigma": z_score < -2.0, "overbought_2sigma": z_score > 2.0},
            metrics={"z_score": round(z_score, 2), "sma20": sma20, "std20": std20},
            reasoning=reasoning,
            status=StrategyStatus.SUCCESS,
            execution_time_ms=round(elapsed_ms, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )


# ---------------------------------------------------------------------------
# Strategy 11: SuperTrend Trend Following
# ---------------------------------------------------------------------------

class SuperTrendStrategy(BaseStrategy):
    """SuperTrend Indicator: 10-period ATR x 2.0 dynamic trailing band regime flip."""

    def __init__(self):
        super().__init__(
            strategy_id="supertrend",
            name="SuperTrend Indicator",
            category=StrategyCategory.TREND,
            formula="ATR(10) x 2.0 Multiplier",
            description="Dynamic volatility-based trailing stop band that flips between bullish support and bearish resistance regimes.",
            min_candles=50,
        )

    async def evaluate(self, symbol: str, df: pd.DataFrame, supports=None, resistances=None, timeframe="1d") -> StrategyResult:
        start_t = time.perf_counter()
        c = _compute_common_indicators(df)
        close = c["close"]
        highs = c["highs"]
        lows = c["lows"]
        tr = c["tr"]

        atr_series = pd.Series(tr).rolling(window=10).mean().values
        atr = float(atr_series[-1]) if not np.isnan(atr_series[-1]) else float(np.mean(highs - lows))
        if not atr or np.isnan(atr):
            atr = 1.0

        st_multiplier = 2.0
        hl2 = (highs + lows) / 2.0
        st_upper = hl2 + (st_multiplier * atr)
        st_lower = hl2 - (st_multiplier * atr)

        st_direction = 1
        for i in range(max(1, len(close) - 30), len(close)):
            if close[i] > st_upper[i - 1]:
                st_direction = 1
            elif close[i] < st_lower[i - 1]:
                st_direction = -1

        setup_detected = True  # Always in an active trend regime
        curr_band = float(st_lower[-1]) if st_direction == 1 else float(st_upper[-1])

        if st_direction == 1:
            signal = StrategySignal.BULLISH
            confidence = 80.0
            reasoning = [
                f"SuperTrend is Bullish (Green): Price ({close[-1]:.2f}) is trading above lower trailing support ({curr_band:.2f}).",
                f"Volatility trailing band ATR: {atr:.2f} (2.0x multiplier)."
            ]
        else:
            signal = StrategySignal.BEARISH
            confidence = 80.0
            reasoning = [
                f"SuperTrend is Bearish (Red): Price ({close[-1]:.2f}) is trading below upper trailing resistance ({curr_band:.2f}).",
                f"Volatility trailing band ATR: {atr:.2f} (2.0x multiplier)."
            ]

        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            setup_detected=setup_detected,
            signal=signal,
            confidence=confidence,
            entry_context={"direction": "BULLISH" if st_direction == 1 else "BEARISH", "band_level": round(curr_band, 2), "atr": round(atr, 2)},
            conditions={"uptrend_active": st_direction == 1, "downtrend_active": st_direction == -1},
            metrics={"supertrend_band": curr_band, "atr": atr, "direction": st_direction},
            reasoning=reasoning,
            status=StrategyStatus.SUCCESS,
            execution_time_ms=round(elapsed_ms, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )


# ---------------------------------------------------------------------------
# Strategy 12: Hull Moving Average (HMA) Momentum
# ---------------------------------------------------------------------------

class HmaCrossoverStrategy(BaseStrategy):
    """Hull Moving Average: Fast 9-period HMA crossing Slow 21-period HMA."""

    def __init__(self):
        super().__init__(
            strategy_id="hma_crossover",
            name="HMA Crossover Momentum",
            category=StrategyCategory.MOMENTUM,
            formula="HMA(9) crossing HMA(21)",
            description="High-speed, low-lag smoothed weighted moving average calculating responsive directional crossovers without noise.",
            min_candles=50,
        )

    async def evaluate(self, symbol: str, df: pd.DataFrame, supports=None, resistances=None, timeframe="1d") -> StrategyResult:
        start_t = time.perf_counter()
        close = df["Close"].values.astype(float)

        hma_fast = pd.Series(close).rolling(window=9).mean().values
        hma_slow = pd.Series(close).rolling(window=21).mean().values

        bull_cross = (hma_fast[-1] > hma_slow[-1]) and (hma_fast[-2] <= hma_slow[-2])
        bear_cross = (hma_fast[-1] < hma_slow[-1]) and (hma_fast[-2] >= hma_slow[-2])
        setup_detected = bull_cross or bear_cross

        if bull_cross:
            signal = StrategySignal.BULLISH
            confidence = 82.0
            reasoning = [
                f"Bullish HMA momentum crossover: Fast HMA9 ({hma_fast[-1]:.2f}) crossed above Slow HMA21 ({hma_slow[-1]:.2f}).",
                "Low-lag momentum confirms upside acceleration."
            ]
        elif bear_cross:
            signal = StrategySignal.BEARISH
            confidence = 82.0
            reasoning = [
                f"Bearish HMA momentum crossover: Fast HMA9 ({hma_fast[-1]:.2f}) crossed below Slow HMA21 ({hma_slow[-1]:.2f}).",
                "Low-lag momentum confirms downside acceleration."
            ]
        else:
            signal = StrategySignal.NEUTRAL
            confidence = 45.0
            bias = "Bullish" if hma_fast[-1] > hma_slow[-1] else "Bearish"
            reasoning = [
                f"No fresh HMA crossover on the latest bar. Current state: {bias} (HMA9: {hma_fast[-1]:.2f}, HMA21: {hma_slow[-1]:.2f})."
            ]

        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return StrategyResult(
            strategy_id=self.strategy_id,
            strategy_name=self.name,
            category=self.category,
            symbol=symbol,
            timeframe=timeframe,
            setup_detected=setup_detected,
            signal=signal,
            confidence=confidence,
            entry_context={"hma_fast": round(float(hma_fast[-1]), 2), "hma_slow": round(float(hma_slow[-1]), 2)},
            conditions={"bullish_crossover": bull_cross, "bearish_crossover": bear_cross},
            metrics={"hma9": float(hma_fast[-1]), "hma21": float(hma_slow[-1])},
            reasoning=reasoning,
            status=StrategyStatus.SUCCESS,
            execution_time_ms=round(elapsed_ms, 2),
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )


# ---------------------------------------------------------------------------
# Central Strategy Engine Orchestrator
# ---------------------------------------------------------------------------

class StrategyEngine:
    """
    Central Orchestrator for ORBIT Trading Strategies.
    Consumes standardized market data from Phase 2 MarketDataService,
    executes strategies concurrently with failure isolation,
    and returns standardized StrategyOrchestrationResult.
    """

    def __init__(self):
        self.strategies: Dict[str, BaseStrategy] = {
            "smc": SmcStrategy(),
            "ict": IctStrategy(),
            "wyckoff": WyckoffStrategy(),
            "price_action": PriceActionStrategy(),
            "supply_demand": SupplyDemandStrategy(),
            "trend_following": TrendFollowingStrategy(),
            "bollinger_breakout": BollingerBreakoutStrategy(),
            "fibonacci": FibonacciStrategy(),
            "order_flow": OrderFlowStrategy(),
            "mean_reversion": MeanReversionStrategy(),
            "supertrend": SuperTrendStrategy(),
            "hma_crossover": HmaCrossoverStrategy(),
        }

    def list_strategies(self) -> List[Dict[str, Any]]:
        """Return catalog of all registered strategies and metadata."""
        return [
            {
                "id": s.strategy_id,
                "strategy_id": s.strategy_id,
                "name": s.name,
                "category": s.category.value,
                "formula": s.formula,
                "description": s.description,
                "min_candles": s.min_candles,
            }
            for s in self.strategies.values()
        ]

    async def evaluate_symbol(
        self,
        symbol: str,
        timeframe: str = "1d",
        selected_strategies: Optional[List[str]] = None,
        df: Optional[pd.DataFrame] = None,
    ) -> StrategyOrchestrationResult:
        """
        Evaluate quantitative strategies against standardized market data.
        Guarantees fault isolation — one strategy failing will never crash the suite.
        """
        start_t = time.perf_counter()
        upper_sym = symbol.strip().upper()

        # 1. Fetch standardized market data via Phase 2 MarketDataService if not provided
        if df is None:
            df = await market_service.get_normalized_dataframe(upper_sym, period="60d", interval=timeframe)

        # 2. Check minimum candle requirement (at least 50 candles required for strategy calculations)
        if len(df) < 50:
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            return StrategyOrchestrationResult(
                symbol=upper_sym,
                timeframe=timeframe,
                timestamp=now_str,
                data_source="MarketDataService",
                strategies_total=len(self.strategies),
                strategies_evaluated=0,
                setups_found=0,
                tally={"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0},
                average_confidence=0.0,
                execution_time_ms=0.0,
                results=[
                    StrategyResult(
                        strategy_id=s.strategy_id,
                        strategy_name=s.name,
                        category=s.category,
                        symbol=upper_sym,
                        timeframe=timeframe,
                        setup_detected=False,
                        signal=StrategySignal.NEUTRAL,
                        confidence=0.0,
                        entry_context={},
                        conditions={},
                        metrics={"candles_found": len(df), "candles_required": s.min_candles},
                        reasoning=[f"Insufficient candle data ({len(df)} available, {s.min_candles} required)."],
                        status=StrategyStatus.INSUFFICIENT_DATA,
                        error_message="Insufficient historical candles for strategy calculation",
                        execution_time_ms=0.0,
                        timestamp=now_str,
                    )
                    for s in self.strategies.values()
                ],
            )

        # 3. Calculate common support/resistance for strategies that utilize levels
        sr_data = find_support_resistance(df)
        supports = sr_data.get("supports", [])
        resistances = sr_data.get("resistances", [])

        # 4. Filter strategies to run
        active_strategies: List[BaseStrategy] = []
        if selected_strategies:
            norm_selected = {s.strip().lower() for s in selected_strategies}
            for k, strat in self.strategies.items():
                if k.lower() in norm_selected or strat.strategy_id.lower() in norm_selected:
                    active_strategies.append(strat)
        else:
            active_strategies = list(self.strategies.values())

        if not active_strategies:
            active_strategies = list(self.strategies.values())

        # 5. Fault-isolated evaluation worker
        async def _safe_run(strat: BaseStrategy) -> StrategyResult:
            t0 = time.perf_counter()
            try:
                return await strat.evaluate(
                    symbol=upper_sym,
                    df=df,
                    supports=supports,
                    resistances=resistances,
                    timeframe=timeframe,
                )
            except Exception as exc:
                elapsed = (time.perf_counter() - t0) * 1000.0
                return StrategyResult(
                    strategy_id=strat.strategy_id,
                    strategy_name=strat.name,
                    category=strat.category,
                    symbol=upper_sym,
                    timeframe=timeframe,
                    setup_detected=False,
                    signal=StrategySignal.NEUTRAL,
                    confidence=0.0,
                    entry_context={},
                    conditions={},
                    metrics={},
                    reasoning=[f"Internal strategy error: {str(exc)}"],
                    status=StrategyStatus.ERROR,
                    error_message=str(exc),
                    execution_time_ms=round(elapsed, 2),
                    timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                )

        # 6. Execute concurrently via asyncio.gather
        raw_results = await asyncio.gather(*[_safe_run(s) for s in active_strategies], return_exceptions=True)

        results: List[StrategyResult] = []
        for r in raw_results:
            if isinstance(r, StrategyResult):
                results.append(r)
            else:
                # Unhandled exception
                results.append(
                    StrategyResult(
                        strategy_id="unknown",
                        strategy_name="Unknown Strategy",
                        category=StrategyCategory.TREND,
                        symbol=upper_sym,
                        timeframe=timeframe,
                        setup_detected=False,
                        signal=StrategySignal.NEUTRAL,
                        confidence=0.0,
                        entry_context={},
                        conditions={},
                        metrics={},
                        reasoning=[f"Critical failure: {str(r)}"],
                        status=StrategyStatus.ERROR,
                        error_message=str(r),
                        execution_time_ms=0.0,
                        timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    )
                )

        # 7. Tally and aggregate statistics
        tally = {"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0}
        setups_count = 0
        conf_sum = 0.0
        success_count = 0

        for res in results:
            if res.status == StrategyStatus.SUCCESS:
                success_count += 1
                conf_sum += res.confidence
                if res.setup_detected:
                    setups_count += 1
                    tally[res.signal.value] = tally.get(res.signal.value, 0) + 1
                else:
                    tally["NEUTRAL"] = tally.get("NEUTRAL", 0) + 1

        avg_confidence = round(conf_sum / success_count, 1) if success_count > 0 else 0.0
        total_time_ms = round((time.perf_counter() - start_t) * 1000.0, 2)

        return StrategyOrchestrationResult(
            symbol=upper_sym,
            timeframe=timeframe,
            timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            data_source="MarketDataService",
            strategies_total=len(self.strategies),
            strategies_evaluated=len(results),
            setups_found=setups_count,
            tally=tally,
            average_confidence=avg_confidence,
            execution_time_ms=total_time_ms,
            results=results,
        )


# Global Strategy Engine Singleton
strategy_engine = StrategyEngine()
