"""
strategy_lab/routes.py - the /api/strategy-lab REST surface.

These routes are mounted on the existing FastAPI app by main.py. They inherit
the project's security model unchanged:

    browser -> Clerk / gateway session
            -> Go gateway (verifies, strips spoofable headers, scopes user_id)
            -> ai-service GatewayIdentityMiddleware (trusted-gateway check)
            -> gateway_user_id(request)          <- the only source of identity
            -> strategy_lab.store (every query filtered by that id)

/api/strategy-lab/* is not in the gateway's public route table, so it is
private by default (middleware.APIAccess -> AccessUser) and no Go change is
needed. The user id in a request body is overwritten by the gateway before it
arrives here and is never read by these handlers.
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from gateway_auth import gateway_user_id

from . import service, store
from .data import BACKTEST_PERIODS, period_options, timeframe_options
from .schema import SUPPORTED_VOCABULARY, StrategyValidationError, validate_strategy_payload

logger = logging.getLogger("orbit.strategy_lab.routes")

router = APIRouter(prefix="/api/strategy-lab", tags=["strategy-lab"])

# Markets the Lab offers, each pointing at symbols the existing
# MarketDataService already serves. Nothing here is a new data source.
MARKET_OPTIONS: List[Dict[str, Any]] = [
    {"value": "crypto", "label": "Crypto", "search_market": "Crypto",
     "examples": ["BTC-USD", "ETH-USD", "SOL-USD"]},
    {"value": "us_stocks", "label": "US Stocks", "search_market": "US Stocks",
     "examples": ["AAPL", "TSLA", "NVDA"]},
    {"value": "nse", "label": "India NSE", "search_market": "Indian Equities",
     "examples": ["RELIANCE.NS", "TCS.NS", "INFY.NS"]},
    {"value": "bse", "label": "India BSE", "search_market": "Indian Equities",
     "examples": ["RELIANCE.BO", "TCS.BO"]},
    {"value": "forex", "label": "Forex", "search_market": "Forex",
     "examples": ["EURUSD=X", "GBPUSD=X", "USDINR=X"]},
    {"value": "commodities", "label": "Commodities", "search_market": "Commodities",
     "examples": ["GC=F", "SI=F", "CL=F"]},
    {"value": "indices", "label": "Indices", "search_market": "Indices",
     "examples": ["SPY", "QQQ", "^NSEI"]},
]


def _user(request: Request) -> int:
    uid = gateway_user_id(request)
    if not uid or int(uid) <= 0:
        # Should be unreachable: the middleware rejects unidentified callers.
        raise HTTPException(status_code=401, detail="Authentication required.")
    return int(uid)


def _fail(exc: service.StrategyLabError):
    detail: Any = exc.message
    if exc.issues:
        detail = exc.message + " (" + "; ".join(exc.issues[:4]) + ")"
    raise HTTPException(status_code=exc.status_code, detail=detail)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
# user_id is accepted only because the gateway stamps it into every JSON body
# it forwards; it is never read. Identity comes from gateway_user_id().

class InterpretRequest(BaseModel):
    description: str = ""
    symbol: Optional[str] = None
    market: Optional[str] = None
    timeframe: Optional[str] = None
    user_id: Optional[int] = None


class BacktestRequest(BaseModel):
    strategy: Dict[str, Any]
    symbol: str
    market: Optional[str] = "crypto"
    timeframe: str = "1d"
    period: str = "1y"
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    initial_capital: float = 10000.0
    commission_percent: float = 0.0
    description: str = ""
    strategy_id: Optional[int] = None
    save: bool = True
    user_id: Optional[int] = None


class SaveStrategyRequest(BaseModel):
    name: str = Field(default="Untitled Strategy", max_length=160)
    description: str = ""
    strategy: Dict[str, Any]
    market: Optional[str] = None
    symbol: Optional[str] = None
    timeframe: Optional[str] = None
    user_id: Optional[int] = None


class ValidateRequest(BaseModel):
    strategy: Dict[str, Any]
    user_id: Optional[int] = None


# ---------------------------------------------------------------------------
# Capability discovery
# ---------------------------------------------------------------------------

@router.get("/supported")
async def api_supported() -> Dict[str, Any]:
    """Everything the Strategy Lab can express, for the UI to render honestly."""
    return {
        "ok": True,
        "data": {
            "vocabulary": SUPPORTED_VOCABULARY,
            "markets": MARKET_OPTIONS,
            "timeframes": timeframe_options(),
            "periods": period_options(),
            "capital": {"min": service.MIN_CAPITAL, "max": service.MAX_CAPITAL, "default": 10000.0},
            "execution_model": {
                "signal": "evaluated on candle close",
                "fill": "next candle open",
                "protective_exits": "checked against each candle's high/low from the entry candle",
                "same_candle_conflict": "stop loss assumed to trigger first",
                "leverage": "none",
                "direction": "long only",
            },
            "examples": [
                "Buy when the 20 EMA crosses above the 50 EMA and RSI is below 70. "
                "Exit when the 20 EMA crosses below the 50 EMA. Use a 3% stop loss.",
                "Enter when RSI drops below 30 and price is above the 200 SMA. "
                "Take profit at 6%, stop loss at 3%.",
                "Buy when price closes below the lower Bollinger Band (20, 2). "
                "Exit when price crosses above the middle band.",
            ],
        },
    }


# ---------------------------------------------------------------------------
# Interpretation
# ---------------------------------------------------------------------------

@router.post("/interpret")
async def api_interpret(req: InterpretRequest, request: Request) -> Dict[str, Any]:
    """Natural language in, a validated strategy or clarifying questions out."""
    _user(request)
    try:
        result = await service.interpret(
            req.description,
            {"symbol": req.symbol, "market": req.market, "timeframe": req.timeframe},
        )
    except Exception as exc:
        logger.exception("Strategy Lab interpretation crashed")
        raise HTTPException(status_code=500, detail="The strategy interpreter failed: " + str(exc))
    return {"ok": True, "data": result}


@router.post("/validate")
async def api_validate(req: ValidateRequest, request: Request) -> Dict[str, Any]:
    """Re-check a strategy the user edited by hand before running it."""
    _user(request)
    try:
        strategy = validate_strategy_payload(req.strategy)
    except StrategyValidationError as exc:
        return {"ok": True, "data": {"valid": False, "message": exc.message, "issues": exc.issues}}
    return {
        "ok": True,
        "data": {
            "valid": True,
            "strategy": strategy.model_dump(mode="json"),
            "understanding": strategy.summary(),
            "warmup_candles": strategy.warmup_bars(),
        },
    }


# ---------------------------------------------------------------------------
# Backtesting
# ---------------------------------------------------------------------------

@router.post("/backtest")
async def api_backtest(req: BacktestRequest, request: Request) -> Dict[str, Any]:
    """Run a simulated backtest over real historical candles."""
    user_id = _user(request)
    if req.period == "custom" and not (req.start_date and req.end_date):
        raise HTTPException(status_code=400, detail="A custom range needs both a start and an end date.")
    if req.period not in BACKTEST_PERIODS:
        raise HTTPException(
            status_code=400,
            detail="Unknown backtest period. Supported: " + ", ".join(BACKTEST_PERIODS) + ".",
        )
    try:
        result = await service.run_backtest_request(
            user_id=user_id,
            strategy_payload=req.strategy,
            symbol=req.symbol,
            market=req.market,
            timeframe=req.timeframe,
            period=req.period,
            start=req.start_date,
            end=req.end_date,
            initial_capital=req.initial_capital,
            description=req.description,
            strategy_id=req.strategy_id,
            save=bool(req.save),
            commission_percent=req.commission_percent,
        )
    except service.StrategyLabError as exc:
        _fail(exc)
    except Exception as exc:
        logger.exception("Strategy Lab backtest endpoint failed")
        raise HTTPException(status_code=500, detail="The backtest could not be completed: " + str(exc))
    return {"ok": True, "data": result}


# ---------------------------------------------------------------------------
# Saved strategies
# ---------------------------------------------------------------------------

@router.post("/strategies")
async def api_save_strategy(req: SaveStrategyRequest, request: Request) -> Dict[str, Any]:
    user_id = _user(request)
    try:
        strategy = validate_strategy_payload(req.strategy)
    except StrategyValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail=exc.message + ((" (" + "; ".join(exc.issues[:4]) + ")") if exc.issues else ""),
        )
    try:
        saved = await asyncio.to_thread(
            store.save_strategy,
            user_id,
            (req.name or strategy.strategy_name),
            req.description,
            strategy.model_dump(mode="json"),
            service.normalize_market(req.market) if req.market else None,
            (req.symbol or "").strip().upper() or None,
            req.timeframe,
        )
    except Exception as exc:
        logger.exception("Strategy Lab could not save a strategy")
        raise HTTPException(status_code=500, detail="Could not save the strategy: " + str(exc))
    saved["understanding"] = strategy.summary()
    return {"ok": True, "data": saved}


@router.get("/strategies")
async def api_list_strategies(request: Request, limit: int = 50) -> Dict[str, Any]:
    user_id = _user(request)
    try:
        rows = await asyncio.to_thread(store.list_strategies, user_id, max(1, min(200, limit)))
    except Exception as exc:
        logger.exception("Strategy Lab could not list strategies")
        raise HTTPException(status_code=500, detail="Could not load your strategies: " + str(exc))
    return {"ok": True, "data": rows}


@router.get("/strategies/{strategy_id}")
async def api_get_strategy(strategy_id: int, request: Request) -> Dict[str, Any]:
    user_id = _user(request)
    row = await asyncio.to_thread(store.get_strategy, user_id, strategy_id)
    if not row:
        # Someone else's strategy is indistinguishable from a missing one.
        raise HTTPException(status_code=404, detail="Strategy not found.")
    return {"ok": True, "data": row}


@router.delete("/strategies/{strategy_id}")
async def api_delete_strategy(strategy_id: int, request: Request) -> Dict[str, Any]:
    user_id = _user(request)
    deleted = await asyncio.to_thread(store.delete_strategy, user_id, strategy_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Strategy not found.")
    return {"ok": True, "deleted": True}


# ---------------------------------------------------------------------------
# Backtest history
# ---------------------------------------------------------------------------

@router.get("/backtests")
async def api_list_backtests(request: Request, limit: int = 30, strategy_id: Optional[int] = None) -> Dict[str, Any]:
    user_id = _user(request)
    try:
        rows = await asyncio.to_thread(
            store.list_backtests, user_id, max(1, min(100, limit)), strategy_id
        )
    except Exception as exc:
        logger.exception("Strategy Lab could not list backtests")
        raise HTTPException(status_code=500, detail="Could not load your backtest history: " + str(exc))
    return {"ok": True, "data": rows}


@router.get("/backtests/{backtest_id}")
async def api_get_backtest(backtest_id: int, request: Request) -> Dict[str, Any]:
    user_id = _user(request)
    row = await asyncio.to_thread(store.get_backtest, user_id, backtest_id)
    if not row:
        raise HTTPException(status_code=404, detail="Backtest not found.")
    return {"ok": True, "data": row}


@router.delete("/backtests/{backtest_id}")
async def api_delete_backtest(backtest_id: int, request: Request) -> Dict[str, Any]:
    user_id = _user(request)
    deleted = await asyncio.to_thread(store.delete_backtest, user_id, backtest_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Backtest not found.")
    return {"ok": True, "deleted": True}
