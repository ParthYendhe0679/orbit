"""
strategy_lab/service.py - orchestration between the API layer and the engine.

Ties interpretation, data loading, simulation and persistence together, and
keeps every blocking call (LLM, pandas, database) off the event loop with
asyncio.to_thread so the ai-service stays responsive while a backtest runs.

A short-lived Valkey entry de-duplicates identical backtests (same user, same
strategy, same window): re-opening a result or double-clicking Run does not
re-fetch candles or re-run the simulation. It is a cache, never storage - the
authoritative record is in PostgreSQL.
"""

import asyncio
import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from services.valkey_service import valkey_service

from . import store
from .data import (
    HistoricalDataUnavailable,
    TIMEFRAME_SPECS,
    historical_data_provider,
    resolve_window,
)
from .engine import run_backtest
from .interpreter import interpret_strategy
from .schema import (
    MARKETS,
    StrategyDefinition,
    StrategyValidationError,
    validate_strategy_payload,
)

logger = logging.getLogger("orbit.strategy_lab.service")

MIN_CAPITAL = 100.0
MAX_CAPITAL = 100_000_000.0
# One backtest at a time per process would be too strict; this bounds how many
# simultaneous simulations can compete for CPU with the live trading loops.
_BACKTEST_SLOTS = asyncio.Semaphore(3)
_RESULT_CACHE_TTL = 600


class StrategyLabError(Exception):
    """A user-facing failure with an HTTP status."""

    def __init__(self, message: str, status_code: int = 400, issues: Optional[List[str]] = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.issues = issues or []


def normalize_market(market: Optional[str]) -> str:
    key = (market or "crypto").strip().lower().replace(" ", "_").replace("-", "_")
    aliases = {
        "us_equities": "us_stocks", "stocks": "us_stocks", "equities": "us_stocks",
        "us": "us_stocks", "usstocks": "us_stocks", "indian_equities": "nse",
        "india": "nse", "commodity": "commodities", "index": "indices",
    }
    key = aliases.get(key, key)
    return key if key in MARKETS else "crypto"


def validate_capital(value: Any) -> float:
    try:
        capital = float(value)
    except (TypeError, ValueError):
        raise StrategyLabError("Initial capital must be a number.")
    if not (MIN_CAPITAL <= capital <= MAX_CAPITAL):
        raise StrategyLabError(
            "Initial capital must be between %g and %g." % (MIN_CAPITAL, MAX_CAPITAL)
        )
    return capital


def validate_timeframe(timeframe: Optional[str]) -> str:
    key = (timeframe or "1d").strip().lower()
    if key not in TIMEFRAME_SPECS:
        raise StrategyLabError(
            "Timeframe '" + str(timeframe) + "' is not supported. Supported: "
            + ", ".join(TIMEFRAME_SPECS) + "."
        )
    return key


async def interpret(description: str, context: Dict[str, Any]) -> Dict[str, Any]:
    """Natural language -> validated strategy (or questions). Never raises."""
    result = await asyncio.to_thread(interpret_strategy, description, context)
    return result.to_dict()


def _bucket(moment: datetime, minutes: int) -> str:
    """`moment` floored to a whole number of `minutes` since the epoch."""
    step = max(1, int(minutes)) * 60
    return str(int(moment.replace(tzinfo=timezone.utc).timestamp()) // step * step)


def _cache_key(user_id: int, payload: Dict[str, Any]) -> str:
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:32]
    # User-scoped by construction: one user's cached run can never be served
    # to another account.
    return "strategy_lab:run:" + str(user_id) + ":" + digest


async def run_backtest_request(
    user_id: int,
    strategy_payload: Dict[str, Any],
    symbol: str,
    market: Optional[str],
    timeframe: str,
    period: str,
    start: Optional[str],
    end: Optional[str],
    initial_capital: float,
    description: str = "",
    strategy_id: Optional[int] = None,
    save: bool = True,
    commission_percent: float = 0.0,
) -> Dict[str, Any]:
    """Validate, load real candles, simulate, persist, and return the result.

    Simulation only: nothing in this path opens a trade, moves a balance or
    touches a live position.
    """
    try:
        strategy: StrategyDefinition = validate_strategy_payload(strategy_payload)
    except StrategyValidationError as exc:
        raise StrategyLabError(exc.message, 400, exc.issues)

    clean_symbol = (symbol or "").strip().upper()
    if not clean_symbol:
        raise StrategyLabError("Select an asset before running the backtest.")
    market_key = normalize_market(market)
    timeframe_key = validate_timeframe(timeframe)
    capital = validate_capital(initial_capital)
    if not (0.0 <= float(commission_percent) <= 5.0):
        raise StrategyLabError("Commission must be between 0% and 5%.")

    try:
        start_dt, end_dt = resolve_window(period, start, end)
    except ValueError as exc:
        raise StrategyLabError(str(exc))

    definition = strategy.model_dump(mode="json")
    # A relative period ("last 6 months") resolves against the current clock,
    # so the raw timestamps differ on every request and would make the cache
    # key unique every time. Bucketing to the timeframe means two runs inside
    # the same candle share a key - which is exactly when the result is
    # identical anyway.
    bucket_minutes = TIMEFRAME_SPECS[timeframe_key]["minutes"]
    cache_payload = {
        "definition": definition, "symbol": clean_symbol, "market": market_key,
        "timeframe": timeframe_key,
        "start": _bucket(start_dt, bucket_minutes), "end": _bucket(end_dt, bucket_minutes),
        "capital": capital, "commission": float(commission_percent),
    }
    cache_key = _cache_key(user_id, cache_payload)
    cached = valkey_service.get(cache_key)
    if isinstance(cached, dict) and cached.get("metrics"):
        cached["cached"] = True
        return cached

    warmup = strategy.warmup_bars()
    try:
        df, data_meta = await historical_data_provider.get_historical_data(
            clean_symbol, market_key, timeframe_key, start_dt, end_dt, warmup_bars=warmup
        )
    except HistoricalDataUnavailable as exc:
        raise StrategyLabError(str(exc), 424)
    except Exception as exc:
        logger.exception("Strategy Lab data load failed for %s", clean_symbol)
        raise StrategyLabError("Could not load historical data: " + str(exc), 424)

    async with _BACKTEST_SLOTS:
        try:
            result = await asyncio.to_thread(
                run_backtest,
                df,
                strategy,
                capital,
                clean_symbol,
                data_meta["warmup_candles"],
                float(commission_percent),
            )
        except ValueError as exc:
            raise StrategyLabError(str(exc), 422)
        except Exception as exc:
            logger.exception("Strategy Lab backtest failed for %s", clean_symbol)
            raise StrategyLabError("The backtest could not be completed: " + str(exc), 500)

    response: Dict[str, Any] = {
        "strategy": definition,
        "understanding": strategy.summary(),
        "symbol": clean_symbol,
        "market": market_key,
        "timeframe": timeframe_key,
        "start_date": data_meta["data_start"],
        "end_date": data_meta["data_end"],
        "initial_capital": capital,
        "metrics": result.metrics,
        "trades": result.trades,
        "equity_curve": result.equity_curve,
        "execution_model": result.execution_model,
        "data": data_meta,
        "cached": False,
    }

    if save:
        try:
            backtest_id = await asyncio.to_thread(
                store.save_backtest,
                user_id, strategy_id, strategy.strategy_name, definition, market_key,
                clean_symbol, timeframe_key, data_meta["data_start"], data_meta["data_end"],
                capital, result.metrics, result.equity_curve, result.trades,
                data_meta, result.execution_model,
            )
            response["backtest_id"] = backtest_id
        except Exception as exc:
            # A storage failure must not throw away a completed backtest.
            logger.exception("Strategy Lab could not persist a backtest")
            response["backtest_id"] = None
            response["persistence_error"] = "The result could not be saved to your history."

    try:
        valkey_service.set(cache_key, response, ttl_seconds=_RESULT_CACHE_TTL)
    except Exception as exc:
        logger.debug("Strategy Lab result cache skipped: %s", exc)

    if description:
        response["description"] = description[:2000]
    return response
