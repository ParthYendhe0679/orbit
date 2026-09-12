"""
strategy_lab/data.py - historical OHLCV for the backtester.

The engine never talks to a market API. It asks this module for a normalized
DataFrame and gets real candles or a clear error - there is no synthetic or
randomly generated price data anywhere in the Strategy Lab.

Reuse, not duplication:
  * candles come from the existing MarketDataService provider objects
    (services.market_data_service). No new API client and no new API key.
  * normalization and validation reuse normalize_market_dataframe() and
    validate_market_data() from the same module, so a Strategy Lab candle is
    shaped exactly like a candle anywhere else in ORBIT.
  * caching reuses the existing valkey_service singleton (one connection for
    the whole process). Candles are market data, identical for every user, so
    the cache key contains no user id - and no user-scoped data is ever
    written under these keys.

Why the Yahoo provider specifically: MarketDataService's primary provider is
Alpha Vantage, whose fetch_historical_raw() ignores the interval argument and
returns ~100 daily bars (TIME_SERIES_DAILY, outputsize=compact). That is
correct for the dashboards that use it and useless for a multi-year intraday
backtest, so the Lab asks the service's Yahoo provider for bars and keeps
Alpha Vantage as the daily-timeframe fallback through the shared service.
"""

import asyncio
import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Protocol, Tuple

import pandas as pd

from services.market_data_service import (
    market_service,
    normalize_market_dataframe,
    validate_market_data,
)
from services.valkey_service import valkey_service

logger = logging.getLogger("orbit.strategy_lab.data")


class HistoricalDataUnavailable(RuntimeError):
    """Real candles could not be obtained for this symbol/timeframe/range."""


# ---------------------------------------------------------------------------
# Timeframes
# ---------------------------------------------------------------------------
# max_lookback_days is how far back the provider will serve an interval, less
# the couple of days _fetch_period_string() pads the request with. Yahoo caps a
# 1m request at 8 days, other intraday intervals at 60, and 1h at 730, and
# rejects - not truncates - anything longer, so these stay under the cap. A
# request beyond the limit is clamped and the clamp is REPORTED to the user;
# it is never silently padded with invented candles.

TIMEFRAME_SPECS: Dict[str, Dict[str, Any]] = {
    "1m":  {"label": "1 minute",   "provider_interval": "1m",  "minutes": 1,    "max_lookback_days": 6},
    "5m":  {"label": "5 minutes",  "provider_interval": "5m",  "minutes": 5,    "max_lookback_days": 57},
    "15m": {"label": "15 minutes", "provider_interval": "15m", "minutes": 15,   "max_lookback_days": 57},
    "30m": {"label": "30 minutes", "provider_interval": "30m", "minutes": 30,   "max_lookback_days": 57},
    "1h":  {"label": "1 hour",     "provider_interval": "1h",  "minutes": 60,   "max_lookback_days": 727},
    # Yahoo has no native 4h bar: 1h candles are resampled, which is exact
    # (open of first, max high, min low, close of last, summed volume).
    "4h":  {"label": "4 hours",    "provider_interval": "1h",  "minutes": 240,  "max_lookback_days": 727,
            "resample": "4h"},
    "1d":  {"label": "1 day",      "provider_interval": "1d",  "minutes": 1440, "max_lookback_days": 3650},
    "1w":  {"label": "1 week",     "provider_interval": "1wk", "minutes": 10080, "max_lookback_days": 3650},
}

BACKTEST_PERIODS: Dict[str, Dict[str, Any]] = {
    "3m": {"label": "Last 3 Months", "days": 90},
    "6m": {"label": "Last 6 Months", "days": 182},
    "1y": {"label": "Last 1 Year", "days": 365},
    "2y": {"label": "Last 2 Years", "days": 730},
    "custom": {"label": "Custom Range", "days": None},
}

# Cache lifetimes: an intraday series gains a candle every few minutes, a
# daily series once a day. Both are short enough that a backtest re-run picks
# up new candles quickly, and long enough to keep one provider call serving
# many runs (rate-limit protection).
_CACHE_TTL_SECONDS = {"intraday": 900, "daily": 21600}
# Guard rail: never push a huge blob into the cache.
_MAX_CACHED_CANDLES = 40000


def timeframe_options() -> List[Dict[str, Any]]:
    return [
        {
            "value": key,
            "label": spec["label"],
            "max_lookback_days": spec["max_lookback_days"],
        }
        for key, spec in TIMEFRAME_SPECS.items()
    ]


def period_options() -> List[Dict[str, Any]]:
    return [{"value": k, "label": v["label"], "days": v["days"]} for k, v in BACKTEST_PERIODS.items()]


def resolve_window(
    period_key: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
) -> Tuple[datetime, datetime]:
    """The requested [start, end] window as naive UTC datetimes."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    key = (period_key or "1y").strip().lower()
    if key == "custom":
        if not start or not end:
            raise ValueError("A custom range needs both a start and an end date.")
        try:
            start_dt = pd.to_datetime(start).to_pydatetime().replace(tzinfo=None)
            end_dt = pd.to_datetime(end).to_pydatetime().replace(tzinfo=None)
        except Exception as exc:
            raise ValueError("Could not read the custom date range: " + str(exc))
        if end_dt <= start_dt:
            raise ValueError("The end date must be after the start date.")
        return start_dt, min(end_dt, now)
    spec = BACKTEST_PERIODS.get(key)
    if not spec or not spec["days"]:
        raise ValueError("Unknown backtest period '" + str(period_key) + "'.")
    return now - timedelta(days=int(spec["days"])), now


def _fetch_period_string(days: int) -> str:
    """Yahoo accepts an explicit day count; ask for a little more than needed."""
    return str(max(2, int(math.ceil(days)) + 2)) + "d"


def _cache_key(symbol: str, interval: str, fetch_days: int) -> str:
    # Bucketed by day count so two runs of the same shape share one entry.
    return "strategy_lab:ohlcv:" + symbol.upper() + ":" + interval + ":" + str(fetch_days) + "d"


def _df_to_records(df: pd.DataFrame) -> List[List[float]]:
    return [
        [int(ts.timestamp()), float(o), float(h), float(low), float(c), float(v)]
        for ts, o, h, low, c, v in zip(
            df.index, df["Open"], df["High"], df["Low"], df["Close"], df["Volume"]
        )
    ]


def _records_to_df(records: Any) -> pd.DataFrame:
    if not isinstance(records, list) or not records:
        return pd.DataFrame()
    try:
        frame = pd.DataFrame(records, columns=["ts", "Open", "High", "Low", "Close", "Volume"])
        frame.index = pd.to_datetime(frame["ts"], unit="s")
        return frame.drop(columns=["ts"]).astype(float)
    except Exception:
        return pd.DataFrame()


def _resample(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    agg = df.resample(rule, label="left", closed="left").agg(
        {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}
    )
    return agg.dropna(subset=["Open", "High", "Low", "Close"])


class MarketDataProvider(Protocol):
    """What the backtest engine needs from a data source. Nothing else."""

    async def get_historical_data(
        self, symbol: str, market: str, timeframe: str, start: datetime, end: datetime, warmup_bars: int
    ) -> Tuple[pd.DataFrame, Dict[str, Any]]:
        ...


class OrbitHistoricalDataProvider:
    """Historical candles from ORBIT's existing market data infrastructure."""

    def __init__(self) -> None:
        # The provider objects already built by the shared MarketDataService.
        self._bars_provider = market_service.fallback      # YahooFinanceProvider
        self._service = market_service                     # Alpha Vantage + cache + validation

    async def get_historical_data(
        self,
        symbol: str,
        market: str,
        timeframe: str,
        start: datetime,
        end: datetime,
        warmup_bars: int = 0,
    ) -> Tuple[pd.DataFrame, Dict[str, Any]]:
        """Normalized OHLCV covering [start, end] plus `warmup_bars` before it.

        Returns (df, meta). meta carries the notes the UI shows the user:
        the actual range served, the source, and any clamping that happened.
        """
        spec = TIMEFRAME_SPECS.get(timeframe)
        if spec is None:
            raise HistoricalDataUnavailable("Timeframe '" + str(timeframe) + "' is not supported.")

        clean_symbol = (symbol or "").strip().upper()
        if not clean_symbol:
            raise HistoricalDataUnavailable("A symbol is required.")

        notes: List[str] = []
        requested_days = max(1.0, (end - start).total_seconds() / 86400.0)
        warmup_days = (warmup_bars * spec["minutes"]) / 1440.0
        # Weekends and market holidays mean calendar days > trading days for
        # everything but crypto; ask for roughly 1.6x the warmup to be safe.
        need_days = requested_days + warmup_days * 1.6 + 1

        limit = float(spec["max_lookback_days"])
        if need_days > limit:
            if requested_days > limit:
                notes.append(
                    "The data provider serves at most " + str(int(limit)) + " days of "
                    + spec["label"] + " candles, so the backtest window was shortened to fit."
                )
            need_days = limit

        fetch_days = int(math.ceil(need_days))
        cache_key = _cache_key(clean_symbol, spec["provider_interval"], fetch_days)

        df = _records_to_df(valkey_service.get(cache_key))
        source = "cache"
        if df.empty:
            source = "YahooFinance"
            raw = await self._bars_provider.fetch_historical_raw(
                clean_symbol, period=_fetch_period_string(fetch_days), interval=spec["provider_interval"]
            )
            df = normalize_market_dataframe(raw)
            if df.empty and spec["provider_interval"] == "1d":
                # Daily only: fall through to the shared service, which can
                # still answer from Alpha Vantage or its own cache.
                try:
                    df = await self._service.get_normalized_dataframe(
                        clean_symbol, period=_fetch_period_string(fetch_days), interval="1d"
                    )
                    source = "MarketDataService"
                except Exception as exc:
                    logger.info("Strategy Lab daily fallback failed for %s: %s", clean_symbol, exc)
                    df = pd.DataFrame()
            if df is None or df.empty:
                raise HistoricalDataUnavailable(
                    "Historical data is unavailable for " + clean_symbol + " on the "
                    + spec["label"] + " timeframe. Check the symbol, or try a longer timeframe."
                )
            if len(df) <= _MAX_CACHED_CANDLES:
                ttl = _CACHE_TTL_SECONDS["daily"] if spec["minutes"] >= 1440 else _CACHE_TTL_SECONDS["intraday"]
                try:
                    valkey_service.set(cache_key, _df_to_records(df), ttl_seconds=ttl)
                except Exception as exc:  # cache problems must never fail a backtest
                    logger.debug("Strategy Lab cache write skipped: %s", exc)

        if spec.get("resample"):
            df = _resample(df, spec["resample"])

        # Trim to the requested window, keeping the warmup candles before it.
        window = df[(df.index >= pd.Timestamp(start)) & (df.index <= pd.Timestamp(end))]
        warmup_slice = df[df.index < pd.Timestamp(start)]
        if warmup_bars > 0 and not warmup_slice.empty:
            warmup_slice = warmup_slice.iloc[-warmup_bars:]
        trimmed = pd.concat([warmup_slice, window]) if not warmup_slice.empty else window
        trimmed = trimmed[~trimmed.index.duplicated(keep="last")].sort_index()

        validation = validate_market_data(trimmed, min_candles=max(10, warmup_bars // 4))
        if not validation.is_valid:
            raise HistoricalDataUnavailable(
                "Not enough valid historical data for " + clean_symbol + " ("
                + str(validation.error or "insufficient candles")
                + "). Try a longer backtest period or a larger timeframe."
            )

        warmup_count = int(len(warmup_slice))
        tradable = len(trimmed) - warmup_count
        if tradable < 5:
            raise HistoricalDataUnavailable(
                "The selected period contains only " + str(max(0, tradable)) + " "
                + spec["label"] + " candles for " + clean_symbol + ". Widen the backtest period."
            )
        if warmup_count < warmup_bars:
            notes.append(
                "Only " + str(warmup_count) + " of the " + str(warmup_bars)
                + " warm-up candles the indicators need were available before the start date; "
                "the first signals in the window are skipped until every indicator is ready."
            )

        meta = {
            "symbol": clean_symbol,
            "market": market,
            "timeframe": timeframe,
            "timeframe_label": spec["label"],
            "provider_interval": spec["provider_interval"],
            "source": source,
            "candles": int(len(trimmed)),
            "warmup_candles": warmup_count,
            "tradable_candles": int(tradable),
            "data_start": trimmed.index[0].isoformat(),
            "data_end": trimmed.index[-1].isoformat(),
            "requested_start": start.isoformat(),
            "requested_end": end.isoformat(),
            "notes": notes,
            "warnings": list(validation.warnings or []),
        }
        return trimmed, meta


historical_data_provider = OrbitHistoricalDataProvider()
