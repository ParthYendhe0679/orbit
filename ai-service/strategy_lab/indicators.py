"""
strategy_lab/indicators.py - deterministic indicator maths for the backtester.

Every series here is causal: the value at index i is computed only from
candles at or before i. pandas' rolling/ewm windows are backward-looking, and
nothing in this module shifts data backwards, so a strategy can never read a
future candle through an indicator.

The series are computed once per backtest over the whole (warmed-up) dataset
and then read bar by bar by the engine, which is both faster and identical in
result to recomputing on each bar of a causal indicator.
"""

from typing import Dict

import numpy as np
import pandas as pd

from .schema import IndicatorOperand, PriceOperand, StrategyDefinition, ValueOperand


def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(window=period, min_periods=period).mean()


def ema(series: pd.Series, period: int) -> pd.Series:
    # adjust=False gives the recursive form used by charting platforms.
    out = series.ewm(span=period, adjust=False, min_periods=period).mean()
    return out


def rsi(series: pd.Series, period: int) -> pd.Series:
    """Wilder's RSI."""
    delta = series.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = gain.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    out = 100.0 - (100.0 / (1.0 + rs))
    # A window with no losses is RSI 100; with no gains it is RSI 0.
    out = out.where(avg_loss != 0.0, 100.0)
    out = out.where(~((avg_gain == 0.0) & (avg_loss == 0.0)), 50.0)
    out[avg_gain.isna() | avg_loss.isna()] = np.nan
    return out


def macd(series: pd.Series, fast: int, slow: int, signal: int) -> Dict[str, pd.Series]:
    fast_ema = series.ewm(span=fast, adjust=False, min_periods=fast).mean()
    slow_ema = series.ewm(span=slow, adjust=False, min_periods=slow).mean()
    line = fast_ema - slow_ema
    signal_line = line.ewm(span=signal, adjust=False, min_periods=signal).mean()
    return {"line": line, "signal": signal_line, "histogram": line - signal_line}


def bollinger(series: pd.Series, period: int, std_dev: float) -> Dict[str, pd.Series]:
    middle = series.rolling(window=period, min_periods=period).mean()
    # ddof=0 (population sigma) matches the standard Bollinger definition.
    sigma = series.rolling(window=period, min_periods=period).std(ddof=0)
    return {
        "middle": middle,
        "upper": middle + std_dev * sigma,
        "lower": middle - std_dev * sigma,
    }


def atr(df: pd.DataFrame, period: int) -> pd.Series:
    """Wilder's Average True Range."""
    high, low, close = df["High"], df["Low"], df["Close"]
    prev_close = close.shift(1)
    true_range = pd.concat(
        [(high - low).abs(), (high - prev_close).abs(), (low - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    return true_range.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()


_SOURCE_COLUMNS = {"open": "Open", "high": "High", "low": "Low", "close": "Close", "volume": "Volume"}


def compute_operand_series(df: pd.DataFrame, operand: IndicatorOperand) -> pd.Series:
    """The single series an indicator operand refers to."""
    source = df[_SOURCE_COLUMNS[operand.source]]
    name = operand.indicator
    if name == "SMA":
        return sma(source, operand.period)
    if name == "EMA":
        return ema(source, operand.period)
    if name == "RSI":
        return rsi(source, operand.period)
    if name == "ATR":
        return atr(df, operand.period)
    if name == "MACD":
        return macd(source, operand.period, operand.slow_period, operand.signal_period)[operand.field]
    if name == "BBANDS":
        return bollinger(source, operand.period, float(operand.std_dev))[operand.field]
    # Unreachable: the schema validator rejects unknown indicators first.
    raise ValueError("Indicator " + str(name) + " has no implementation.")


def build_indicator_frame(df: pd.DataFrame, strategy: StrategyDefinition) -> pd.DataFrame:
    """A frame of every distinct series the strategy's conditions reference.

    Columns are keyed by operand.key(), so two conditions using EMA(20) share
    one computation.
    """
    columns: Dict[str, pd.Series] = {}
    for group in (strategy.entry, strategy.exit):
        for condition in group.conditions:
            for operand in (condition.left, condition.right):
                if isinstance(operand, ValueOperand):
                    continue
                key = operand.key()
                if key in columns:
                    continue
                if isinstance(operand, PriceOperand):
                    columns[key] = df[_SOURCE_COLUMNS[operand.field]].astype(float)
                else:
                    columns[key] = compute_operand_series(df, operand).astype(float)
    if not columns:
        return pd.DataFrame(index=df.index)
    return pd.DataFrame(columns, index=df.index)
