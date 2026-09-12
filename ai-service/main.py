import asyncio
import csv
import hmac
import io
import json
import logging
import os
import time
import traceback
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import RedirectResponse
import yfinance as yf
import pandas as pd

import sys
# ai-service/ is the package root: database, models.*, services.*, agents.*.
_current_dir = os.path.dirname(os.path.abspath(__file__))
_parent_dir = os.path.abspath(os.path.join(_current_dir, ".."))
if _current_dir not in sys.path:
    sys.path.insert(0, _current_dir)

# Load .env before anything reads os.environ (news/LLM keys, DATABASE_URL).
load_dotenv(os.path.join(_parent_dir, ".env"))
load_dotenv(os.path.join(_current_dir, ".env"))
load_dotenv()

import database as db
import reporting as reporting
from services.market_data_service import market_service
from services.agent_orchestrator import agent_orchestrator
from services.strategy_engine import strategy_engine
from services.consensus_engine import consensus_engine
from services.orbit_brain import orbit_brain
from services.risk_guard import risk_guard
from services.opportunity_engine import opportunity_engine
from services.decision_engine import decision_engine
from services.explainability_engine import explainability_engine
from services.copilot_service import copilot_service
from services.position_service import position_service
from services.valkey_service import valkey_service
from services.bot_service import BotEngine, BotConfigError, market_universe, validate_bot_config
from models.bot import BotStartRequest, BotStopRequest
from models.copilot import CopilotChatRequest, ConversationCreate
from agents.chart_analyst import find_support_resistance
from agents.indicator_analyst import analyze_indicators
from agents.news_analyst import analyze_sentiment
from agents.momentum_candle_analyst import analyze_momentum_candles
from agents.ema_ribbon_analyst import analyze_ema_ribbon
from agents.volatility_analyst import analyze_volatility
from agents.volume_flow_analyst import analyze_volume_flow
from agents.mtf_trend_analyst import analyze_mtf_trend
from agents.strategy_judge import evaluate_strategies
from agents.risk_planner import plan_trade
from agents.execution_agent import check_and_execute_trades
from agents.portfolio_monitor import monitor_positions
from gateway_auth import GatewayIdentityMiddleware, gateway_user_id, gateway_clerk_id
# ORBIT AI Strategy Lab (additive): natural-language strategy interpretation and
# backtesting. Self-contained under strategy_lab/ and mounted below; it shares
# the market data, Valkey and database layers but no live trading code path.
from strategy_lab.routes import router as strategy_lab_router

logger = logging.getLogger("orbit.main")

# Seconds between ticks of the terminal's live analysis loop.
TICK_INTERVAL_SECONDS = 4

# Go gateway (backend/) — Auto-Trade Bot scheduling and user-scoped event
# fan-out. The shared token authenticates /internal/* calls in both
# directions; without it only loopback callers are accepted.
GATEWAY_INTERNAL_URL = os.getenv("GATEWAY_INTERNAL_URL", "http://127.0.0.1:8000").rstrip("/")
INTERNAL_TOKEN = os.getenv("ORBIT_INTERNAL_TOKEN", "").strip()

# ---------------------------------------------------------------------------
# Phase 11 — orbit-stream Go hub integration
# ---------------------------------------------------------------------------
# URL of the orbit-stream Go hub. The market tick scheduler publishes real
# quotes here; the hub fans them out to every browser through the gateway's
# /ws/stream. If the hub is down the frame is dropped; per-user sockets still
# receive their own updates from this service.
STREAM_HUB_URL = os.getenv("STREAM_HUB_URL", "http://127.0.0.1:8002/publish")

def publish_tick(payload: dict) -> bool:
    """Fire-and-forget: POST a JSON payload to the orbit-stream Go hub.

    Runs synchronously (called from asyncio.to_thread). A 50 ms timeout
    ensures a stalled hub never blocks the tick loop. The shared internal
    token authenticates the publisher. Returns True if the hub accepted it.
    """
    try:
        import urllib.request, json as _json
        data = _json.dumps(payload).encode()
        headers = {"Content-Type": "application/json"}
        if INTERNAL_TOKEN:
            headers["X-Orbit-Internal-Token"] = INTERNAL_TOKEN
        req = urllib.request.Request(
            STREAM_HUB_URL,
            data=data,
            method="POST",
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=0.05) as resp:
            return resp.status in (200, 204)
    except Exception:
        return False  # hub not running or slow — tick drop is acceptable


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: prepare the schema, initialize Valkey, log validation
    db.init_db()
    valkey_connected = valkey_service.connect()
    print("DATABASE: " + ("POSTGRESQL" if db.IS_POSTGRES else "SQLITE (local fallback)"), flush=True)
    print("VALKEY: " + ("CONNECTED" if valkey_connected else "DEGRADED_FALLBACK (in-memory)"), flush=True)
    if not INTERNAL_TOKEN:
        print("GATEWAY TRUST: ORBIT_INTERNAL_TOKEN not set; only loopback callers are trusted", flush=True)

    # The Auto-Trade Bot has no loop here: the Go gateway's scheduler
    # (backend/botsched) drives it through the /internal/bot/* step endpoints.
    market_scheduler = asyncio.create_task(market_tick_scheduler_loop())
    try:
        yield
    finally:
        market_scheduler.cancel()
        try:
            await asyncio.gather(market_scheduler, return_exceptions=True)
        except Exception:
            pass
        valkey_service.close()


app = FastAPI(lifespan=lifespan)
# Private routes and /ws only accept identities forwarded by the Go gateway
# (see gateway_auth.py).
app.add_middleware(GatewayIdentityMiddleware)
# /api/strategy-lab/* — private by default at both the gateway (AccessUser) and
# here (gateway_auth.classify -> "user"), like every other /api route.
app.include_router(strategy_lab_router)

@app.middleware("http")
async def add_no_cache_header(request, call_next):
    response = await call_next(request)
    if request.url.path.endswith((".js", ".css", ".html")) or request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


@app.get("/")
@app.get("/index.html")
async def serve_root():
    # The app must be opened through the Go gateway: only the gateway issues the
    # session cookie and forwards the verified identity. Served from here, a
    # sign-in succeeds but every private call is refused with 401 and the user
    # is signed straight back out.
    gateway_url = os.getenv("ORBIT_GATEWAY_URL", "http://127.0.0.1:8000").rstrip("/")
    return RedirectResponse(url=gateway_url + "/", status_code=307)


@app.get("/health")
@app.get("/api/health")
async def health_check():
    valkey_health = await asyncio.to_thread(valkey_service.health_check)
    valkey_connected = valkey_health.get("valkey") == "connected"
    db_connected = False
    try:
        def _check_db():
            c = db.get_connection()
            c.close()
            return True
        db_connected = await asyncio.to_thread(_check_db)
    except Exception:
        db_connected = False

    is_healthy = db_connected and valkey_connected
    return {
        "status": "healthy" if is_healthy else "degraded",
        "backend": "connected",
        "database": "connected" if db_connected else "disconnected",
        "valkey": "connected" if valkey_connected else "disconnected",
        "cache_mode": "aiven_valkey" if valkey_connected else "memory_fallback",
        "tls": valkey_health.get("tls", True),
        # Diagnostic metadata
        "service": "ai-service",
        "version": "1.0.0",
        "valkey_mode": "aiven_cloud" if valkey_connected else "in_memory",
        "tls_enabled": valkey_health.get("tls", True),
        "timestamp": datetime.now().isoformat()
    }


@app.get("/api/news")
def get_market_news(symbol: str = "BTC-USD"):
    from agents.news_analyst import get_headlines, BULLISH_WORDS, BEARISH_WORDS
    import re
    
    headlines = get_headlines(symbol)
    
    # Per-headline lexicon-based sentiment (fast, no API call needed here)
    for h in headlines:
        text = h["title"].lower()
        words = re.findall(r'\w+', text)
        pos = sum(1 for w in words if w in BULLISH_WORDS)
        neg = sum(1 for w in words if w in BEARISH_WORDS)
        score = 0.0
        if pos + neg > 0:
            score = (pos - neg) / (pos + neg)
        h["sentiment"] = "bullish" if score > 0.1 else "bearish" if score < -0.1 else "neutral"
        
    return {
        "headlines": headlines,
        "count": len(headlines),
        "symbol": symbol,
    }


# ---------------------------------------------------------------------------
# Centralized Market Data REST Endpoints (Phase 2)
# ---------------------------------------------------------------------------

@app.get("/api/market/quote")
async def api_get_market_quote(symbol: str = "BTC-USD", refresh: bool = False):
    """Retrieve real-time quote for a symbol via the centralized MarketDataService."""
    clean_symbol = symbol.strip() if symbol else ""
    if not clean_symbol:
        raise HTTPException(status_code=400, detail="Asset symbol parameter cannot be empty.")
    try:
        quote = await market_service.get_quote(clean_symbol, force_refresh=refresh)
        dumped = quote.model_dump()
        return {"ok": True, "data": dumped, **dumped}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/market/history")
async def api_get_market_history(
    symbol: str = "BTC-USD",
    period: str = "60d",
    interval: str = "1d",
    refresh: bool = False
):
    """Retrieve standardized historical OHLCV snapshot with validation."""
    clean_symbol = symbol.strip() if symbol else ""
    if not clean_symbol:
        raise HTTPException(status_code=400, detail="Asset symbol parameter cannot be empty.")
    try:
        snapshot = await market_service.get_historical_snapshot(
            clean_symbol, period=period, interval=interval, force_refresh=refresh
        )
        return {"ok": True, "data": snapshot.model_dump()}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/market/search")
async def api_search_market_symbols(q: str = "", market: Optional[str] = None):
    """Search and autocomplete financial symbols across Crypto, Equities, Forex, Indices."""
    results = await market_service.search_symbols(q, market=market)
    dumped = [r.model_dump() for r in results]
    return {"ok": True, "results": dumped, "data": {"results": dumped}}


@app.get("/api/market/stats")
def api_get_market_stats():
    """Retrieve cache telemetry and health stats from the MarketDataService."""
    return {"ok": True, "stats": market_service.get_cache_stats()}


@app.get("/api/market/{symbol}")
async def api_get_market_symbol(symbol: str, refresh: bool = False):
    """Path-based market quote alias conforming to GET /api/market/:symbol."""
    return await api_get_market_quote(symbol=symbol, refresh=refresh)


# ---------------------------------------------------------------------------
# ORBIT AI Agent Intelligence REST Endpoints (Phase 3)
# ---------------------------------------------------------------------------

@app.get("/api/agents/list")
def api_list_agents():
    """List all registered ORBIT specialized intelligence agents and metadata."""
    agents = agent_orchestrator.list_agents()
    return {"ok": True, "count": len(agents), "agents": agents}


@app.get("/api/agents/analyze")
async def api_analyze_symbol(
    symbol: str = "BTC-USD",
    timeframe: str = "1d",
    agents: Optional[str] = None
):
    """
    Execute specialized intelligence agents against standardized market data.
    Query param 'agents' can be a comma-separated list of agent IDs (e.g. 'trend_agent,momentum_agent').
    """
    clean_symbol = symbol.strip() if symbol else ""
    if not clean_symbol:
        raise HTTPException(status_code=400, detail="Asset symbol parameter cannot be empty.")
    try:
        agent_id_list = [a.strip() for a in agents.split(",") if a.strip()] if agents else None
        result = await agent_orchestrator.analyze_symbol(
            symbol=clean_symbol,
            timeframe=timeframe,
            selected_agents=agent_id_list
        )
        return {"ok": True, "data": result.model_dump()}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# ORBIT Trading Strategy Engine REST Endpoints (Phase 4)
# ---------------------------------------------------------------------------

@app.get("/api/strategies/list")
def api_list_strategies():
    """List all registered ORBIT quantitative trading strategies, formulas, and metadata."""
    strategies = strategy_engine.list_strategies()
    return {"ok": True, "count": len(strategies), "strategies": strategies}


@app.get("/api/strategies/evaluate")
async def api_evaluate_strategies(
    symbol: str = "BTC-USD",
    timeframe: str = "1d",
    strategies: Optional[str] = None
):
    """
    Evaluate quantitative trading strategies against standardized market data.
    Query param 'strategies' can be a comma-separated list of strategy IDs (e.g. 'smc,trend_following,supertrend').
    """
    clean_symbol = symbol.strip() if symbol else ""
    if not clean_symbol:
        raise HTTPException(status_code=400, detail="Asset symbol parameter cannot be empty.")
    try:
        strat_id_list = [s.strip() for s in strategies.split(",") if s.strip()] if strategies else None
        result = await strategy_engine.evaluate_symbol(
            symbol=clean_symbol,
            timeframe=timeframe,
            selected_strategies=strat_id_list
        )
        return {"ok": True, "data": result.model_dump()}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# ORBIT Consensus Engine REST Endpoints (Phase 5)
# ---------------------------------------------------------------------------

@app.get("/api/consensus/evaluate")
async def api_evaluate_consensus(
    symbol: str = "BTC-USD",
    timeframe: str = "1d"
):
    """
    Evaluate unified ORBIT market consensus blending Phase 3 AI Agent Intelligence
    and Phase 4 Trading Strategy setup evidence into a normalized market view.
    """
    clean_symbol = symbol.strip() if symbol else ""
    if not clean_symbol:
        raise HTTPException(status_code=400, detail="Asset symbol parameter cannot be empty.")
    try:
        result = await consensus_engine.evaluate_consensus(
            symbol=clean_symbol,
            timeframe=timeframe
        )
        return {"ok": True, "data": result.model_dump()}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# ORBIT Brain Central Intelligence Orchestrator REST Endpoints (Phase 6)
# ---------------------------------------------------------------------------

@app.get("/api/brain/analyze")
async def api_brain_analyze(
    symbol: str = "BTC-USD",
    timeframe: str = "1d"
):
    """
    Synthesize complete ORBIT market intelligence context across Phase 2 Market Data,
    Phase 3 AI Agents, Phase 4 Trading Strategies, and Phase 5 Consensus Engine.
    """
    clean_symbol = symbol.strip() if symbol else ""
    if not clean_symbol:
        raise HTTPException(status_code=400, detail="Asset symbol parameter cannot be empty.")
    try:
        result = await orbit_brain.synthesize_analysis(
            symbol=clean_symbol,
            timeframe=timeframe
        )
        return {"ok": True, "data": result.model_dump()}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# ORBIT Risk Guard REST Endpoints (Phase 7)
# ---------------------------------------------------------------------------

@app.get("/api/risk/evaluate")
async def api_risk_evaluate(
    symbol: str = "BTC-USD",
    timeframe: str = "1d"
):
    """
    Evaluate analysis risk and safety profile using Phase 7 ORBIT Risk Guard.
    Synthesizes volatility, signal conflict, consensus uncertainty, analysis
    completeness, and data sufficiency without trade execution.
    """
    clean_symbol = symbol.strip() if symbol else ""
    if not clean_symbol:
        raise HTTPException(status_code=400, detail="Asset symbol parameter cannot be empty.")
    try:
        result = await risk_guard.evaluate_risk(
            symbol=clean_symbol,
            timeframe=timeframe
        )
        return {"ok": True, "data": result.model_dump()}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# ORBIT Opportunity Evaluation Engine REST Endpoints (Phase 8)
# ---------------------------------------------------------------------------

@app.get("/api/opportunity/evaluate")
async def api_opportunity_evaluate(
    symbol: str = "BTC-USD",
    timeframe: str = "1d"
):
    """
    Evaluate market opportunity quality using Phase 8 ORBIT Opportunity Evaluation Engine.
    Synthesizes consensus conviction, active strategy setups, multi-agent harmony,
    Risk Guard safety headroom, and pipeline completeness without trade execution.
    """
    clean_symbol = symbol.strip() if symbol else ""
    if not clean_symbol:
        raise HTTPException(status_code=400, detail="Asset symbol parameter cannot be empty.")
    try:
        result = await opportunity_engine.evaluate_opportunity(
            symbol=clean_symbol,
            timeframe=timeframe
        )
        return {"ok": True, "data": result.model_dump()}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# ORBIT Decision Engine REST Endpoints (Phase 9)
# ---------------------------------------------------------------------------

@app.get("/api/decision/evaluate")
async def api_decision_evaluate(
    symbol: str = "BTC-USD",
    timeframe: str = "1d"
):
    """
    Evaluate deterministic, risk-aware market stance using Phase 9 ORBIT Decision Engine.
    Synthesizes ORBIT Brain context, Risk Guard evaluation, and Opportunity Engine confluence
    into an authoritative market stance (BULLISH, BEARISH, NEUTRAL, MIXED, NO_CLEAR_DECISION).
    Strict Operational Boundary: Market stance only; does NOT execute trades or place orders.
    """
    clean_symbol = symbol.strip() if symbol else ""
    if not clean_symbol:
        raise HTTPException(status_code=400, detail="Asset symbol parameter cannot be empty.")
    try:
        result = await decision_engine.evaluate_decision(
            symbol=clean_symbol,
            timeframe=timeframe
        )
        return {"ok": True, "data": result.model_dump()}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# ORBIT Explainability & Insight Engine REST Endpoints (Phase 10)
# ---------------------------------------------------------------------------

@app.get("/api/explain/evaluate")
@app.get("/api/insights/evaluate")
async def api_explain_evaluate(
    symbol: str = "BTC-USD",
    timeframe: str = "1d"
):
    """
    Synthesize structured, traceable, human-understandable market insights using Phase 10 Explainability Engine.
    Explains the WHAT, WHY, SUPPORT, CONFLICTS, RISKS, and UNCERTAINTIES across the entire ORBIT stack.
    Strict Operational Boundary: Pure explanation layer; does NOT execute trades or recompute technicals.
    """
    clean_symbol = symbol.strip() if symbol else ""
    if not clean_symbol:
        raise HTTPException(status_code=400, detail="Asset symbol parameter cannot be empty.")
    try:
        result = await explainability_engine.evaluate_explanation(
            symbol=clean_symbol,
            timeframe=timeframe
        )
        return {"ok": True, "data": result.model_dump()}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# ORBIT AI Market Intelligence Copilot REST Endpoints (Phase 12)
# ---------------------------------------------------------------------------

@app.post("/api/copilot/chat")
@app.post("/api/chat/message")
async def api_copilot_chat(req: CopilotChatRequest):
    """
    Interactive question-answering and contextual reasoning over active ORBIT analysis.
    Grounds answers strictly in Phase 2-10 intelligence context with zero hallucination.
    """
    clean_msg = req.message.strip() if req.message else ""
    if not clean_msg:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")
    try:
        response = await copilot_service.chat(req)
        return {"ok": True, "data": response.model_dump()}
    except PermissionError:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Copilot inference error: {str(exc)}")


@app.get("/api/chat/conversations")
async def api_list_conversations(request: Request, limit: int = 50):
    """List the signed-in user's chat conversations for the history sidebar."""
    try:
        conversations = await asyncio.to_thread(db.list_conversations, gateway_user_id(request), max(1, min(200, limit)))
        return {"ok": True, "data": conversations}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to list conversations: {str(exc)}")


def _owned_conversation(conversation_id: str, uid: Optional[int]) -> Optional[dict]:
    """The conversation when it belongs to uid; None when missing or someone else's."""
    conv = db.get_conversation((conversation_id or "").strip())
    if not conv or uid is None or conv.get("user_id") != uid:
        return None
    return conv


@app.post("/api/chat/conversations")
async def api_create_conversation(request: Request, payload: Optional[ConversationCreate] = None):
    """Create a new conversation owned by the signed-in user."""
    try:
        cid = str(uuid.uuid4())
        title = payload.title if payload and payload.title else "New Analysis"
        asset = payload.selected_asset if payload and payload.selected_asset else ""
        market = payload.selected_market if payload and payload.selected_market else "US Stocks"
        conv = await asyncio.to_thread(
            db.create_conversation,
            conversation_id=cid,
            title=title,
            selected_asset=asset,
            selected_market=market,
            user_id=gateway_user_id(request),
        )
        return {"ok": True, "data": conv}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to create conversation: {str(exc)}")


@app.get("/api/chat/conversations/{conversation_id}")
async def api_get_conversation(conversation_id: str, request: Request):
    """A conversation owned by the signed-in user, with its message history."""
    conv = await asyncio.to_thread(_owned_conversation, conversation_id, gateway_user_id(request))
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    try:
        messages = await asyncio.to_thread(db.get_chat_messages, conv["id"], None, 60)
        return {"ok": True, "data": {"conversation": conv, "messages": messages}}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to load conversation: {str(exc)}")


@app.delete("/api/chat/conversations/{conversation_id}")
async def api_delete_conversation(conversation_id: str, request: Request):
    """Delete a conversation owned by the signed-in user."""
    conv = await asyncio.to_thread(_owned_conversation, conversation_id, gateway_user_id(request))
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    try:
        deleted = await asyncio.to_thread(db.delete_conversation, conv["id"])
        copilot_service.reset_session(conv["id"])
        return {"ok": True, "deleted": deleted}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to delete conversation: {str(exc)}")


@app.get("/api/copilot/context")
async def api_copilot_context(symbol: str = "BTC-USD", timeframe: str = "1d"):
    """
    Retrieve current ORBIT context snapshot and suggested follow-ups for the active symbol.
    """
    clean_symbol = symbol.strip() if symbol else ""
    if not clean_symbol:
        raise HTTPException(status_code=400, detail="Asset symbol parameter cannot be empty.")
    try:
        analysis = await copilot_service.get_or_resolve_analysis(clean_symbol, timeframe=timeframe)
        if not analysis:
            return {"ok": False, "detail": f"Could not acquire analysis for {clean_symbol}"}

        summary = {
            "symbol": analysis.symbol,
            "timeframe": analysis.timeframe,
            "market_stance": analysis.market_stance.value,
            "confidence": analysis.decision_confidence,
            "clarity": analysis.decision_clarity,
            "risk_level": analysis.input_summary.risk_level,
            "risk_score": analysis.input_summary.risk_score,
            "opportunity_score": analysis.input_summary.opportunity_score,
            "opportunity_level": analysis.input_summary.opportunity_level,
            "headline": analysis.headline,
            "why": analysis.why,
            "suggested_questions": copilot_service.generate_suggested_followups(analysis, None),
        }
        return {"ok": True, "data": summary}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/copilot/reset")
async def api_copilot_reset(request: Request, conversation_id: Optional[str] = None):
    """Reset one of the signed-in user's conversation sessions (id in query or JSON body)."""
    if not conversation_id:
        try:
            body = await request.json()
            conversation_id = body.get("conversation_id") if isinstance(body, dict) else None
        except Exception:
            conversation_id = None
    clean_cid = (conversation_id or "").strip()
    if not clean_cid:
        raise HTTPException(status_code=400, detail="conversation_id cannot be empty.")
    exists = await asyncio.to_thread(db.get_conversation, clean_cid)
    if exists and not await asyncio.to_thread(_owned_conversation, clean_cid, gateway_user_id(request)):
        raise HTTPException(status_code=404, detail="Conversation not found.")
    cleared = copilot_service.reset_session(clean_cid)
    return {"ok": True, "cleared": cleared}




# In-memory cache for /api/news/global to guarantee instantaneous (<1ms) dashboard loads
_GLOBAL_NEWS_CACHE = {
    "data": None,
    "timestamp": 0.0
}
GLOBAL_NEWS_CACHE_TTL = 180.0  # 3 minutes cache


@app.get("/api/news/global")
async def get_global_market_news():
    """Fetch broad world stock market and financial news for the dashboard with in-memory caching."""
    global _GLOBAL_NEWS_CACHE
    import asyncio, re, time, urllib.request, urllib.parse, json, xml.etree.ElementTree as ET
    from agents.news_analyst import BULLISH_WORDS, BEARISH_WORDS

    now = time.time()
    if _GLOBAL_NEWS_CACHE["data"] and (now - _GLOBAL_NEWS_CACHE["timestamp"] < GLOBAL_NEWS_CACHE_TTL):
        return _GLOBAL_NEWS_CACHE["data"]

    api_key = os.environ.get("NEWS_API_KEY", "").strip()

    def _fetch_newsapi_sync():
        results = []
        if not api_key:
            return results
        # Use top-headlines business category — pre-indexed and returns in <300ms
        url = (
            f"https://newsapi.org/v2/top-headlines"
            f"?category=business&language=en&pageSize=15&apiKey={api_key}"
        )
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "OrbitTradingTerminal/1.0"})
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            for a in data.get("articles", []):
                title = a.get("title", "") or ""
                if title and "[Removed]" not in title:
                    results.append({
                        "title":     title,
                        "link":      a.get("url", "#"),
                        "source":    (a.get("source") or {}).get("name", "NewsAPI"),
                        "published": (a.get("publishedAt") or "")[:10],
                    })
        except Exception:
            pass
        return results

    def _fetch_yahoo_sync():
        results = []
        url = "https://finance.yahoo.com/rss/topstories"
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
            )
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                root = ET.fromstring(resp.read())
            for item in root.findall(".//item"):
                title_el = item.find("title")
                link_el  = item.find("link")
                pub_el   = item.find("pubDate")
                if title_el is not None and title_el.text:
                    results.append({
                        "title":     title_el.text.strip(),
                        "link":      link_el.text if link_el is not None else "#",
                        "source":    "Yahoo Finance",
                        "published": (pub_el.text[:16] if pub_el is not None else ""),
                    })
        except Exception:
            pass
        return results

    # Run both fetches concurrently in threads
    try:
        newsapi_results, yahoo_results = await asyncio.gather(
            asyncio.to_thread(_fetch_newsapi_sync),
            asyncio.to_thread(_fetch_yahoo_sync),
        )
    except Exception:
        newsapi_results, yahoo_results = [], []

    # Merge and deduplicate
    seen = set()
    unique = []
    for h in newsapi_results + yahoo_results:
        if h["title"] not in seen:
            seen.add(h["title"])
            unique.append(h)

    # No live source answered: keep serving the last real response if there is
    # one, otherwise an honest empty list (never invented headlines).
    if not unique:
        if _GLOBAL_NEWS_CACHE["data"]:
            return _GLOBAL_NEWS_CACHE["data"]
        return {"headlines": [], "count": 0, "symbol": "GLOBAL"}

    # Sentiment-tag each headline
    for h in unique:
        text = h["title"].lower()
        words = re.findall(r'\w+', text)
        pos = sum(1 for w in words if w in BULLISH_WORDS)
        neg = sum(1 for w in words if w in BEARISH_WORDS)
        score = (pos - neg) / (pos + neg) if pos + neg > 0 else 0.0
        h["sentiment"] = "bullish" if score > 0.1 else "bearish" if score < -0.1 else "neutral"

    res = {"headlines": unique[:40], "count": len(unique), "symbol": "GLOBAL"}
    _GLOBAL_NEWS_CACHE["data"] = res
    _GLOBAL_NEWS_CACHE["timestamp"] = now
    return res



# ---------------------------------------------------------------------------
# Authentication Endpoints
# ---------------------------------------------------------------------------
from fastapi import HTTPException
from pydantic import BaseModel
from auth import hash_password, verify_password

class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str

class LoginRequest(BaseModel):
    username: str
    password: str

class SyncAuthRequest(BaseModel):
    email: str | None = None
    username: str | None = None
    clerk_id: str | None = None
    first_name: str | None = None
    last_name: str | None = None

@app.get("/api/auth/config")
def api_auth_config():
    pub_key = (
        os.getenv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "").strip()
        or os.getenv("CLERK_PUBLISHABLE_KEY", "").strip()
    )
    return {
        "clerk_publishable_key": pub_key,
        "is_clerk_configured": bool(pub_key and pub_key.startswith("pk_") and not pub_key.endswith("placeholder_key"))
    }

def _clerk_verified_email(clerk_id: str) -> Optional[str]:
    """
    The Clerk user's primary email from the Clerk Backend API, and only when
    Clerk has verified it. Emails sent by the browser are never trusted for
    linking an existing account.
    """
    secret = os.getenv("CLERK_SECRET_KEY", "").strip()
    if not secret.startswith("sk_") or secret.endswith("placeholder_key"):
        return None
    try:
        import urllib.parse
        import urllib.request
        req = urllib.request.Request(
            f"https://api.clerk.com/v1/users/{urllib.parse.quote(clerk_id, safe='')}",
            headers={"Authorization": f"Bearer {secret}", "User-Agent": "OrbitTradingTerminal/1.0"},
        )
        with urllib.request.urlopen(req, timeout=4) as resp:
            clerk_user = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        logger.warning(f"[auth] Clerk user lookup failed: {exc}")
        return None
    primary = clerk_user.get("primary_email_address_id")
    for entry in clerk_user.get("email_addresses") or []:
        if entry.get("id") == primary and (entry.get("verification") or {}).get("status") == "verified":
            return (entry.get("email_address") or "").strip().lower() or None
    return None


@app.post("/api/auth/sync")
async def api_auth_sync(req: SyncAuthRequest, request: Request):
    """
    Called after a Clerk / Google OAuth sign-in. The Clerk user id comes from
    the Go gateway, which verified the Clerk session token (X-User-Clerk-ID);
    the clerk_id and email in the body are ignored. An existing ORBIT account
    is linked only through the email Clerk reports as verified. Returns the
    database user_id, username and balance; the gateway then issues its session.
    """
    clerk_id = gateway_clerk_id(request)
    if not clerk_id:
        raise HTTPException(status_code=401, detail="A verified Clerk session is required.")
    verified_email = await asyncio.to_thread(_clerk_verified_email, clerk_id)
    user = await asyncio.to_thread(
        db.sync_login_user, email=verified_email, username=req.username, clerk_id=clerk_id
    )
    if not user:
        raise HTTPException(status_code=500, detail="Database sync failed.")
    return {
        "ok": True,
        "user_id": user["id"],
        "username": user["username"],
        "balance": user.get("balance"),
    }

@app.post("/api/register")
def api_register(req: RegisterRequest):
    import re
    # Validate email format
    if not re.match(r"[^@]+@[^@]+\.[^@]+", req.email):
        raise HTTPException(status_code=400, detail="Invalid email address.")
    if len(req.username.strip()) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters.")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")

    # Check duplicates in local DB
    if db.get_user_by_username(req.username.strip()):
        raise HTTPException(status_code=409, detail="Username already taken.")
    if db.get_user_by_email(req.email.lower().strip()):
        raise HTTPException(status_code=409, detail="Email already registered.")

    # Register user with immediate active/verified status (zero OTP)
    pw_hash = hash_password(req.password)
    user_id = db.register_user(req.username.strip(), req.email.lower().strip(), pw_hash, is_verified=True)
    if not user_id:
        raise HTTPException(status_code=500, detail="Registration failed. Please try again.")

    # Seamless Clerk Account Sync & Direct Sign-in Token (asynchronous background sync so DB registration returns instantaneously in <50ms)
    clerk_secret = os.getenv("CLERK_SECRET_KEY", "").strip()
    if clerk_secret and clerk_secret.startswith("sk_") and not clerk_secret.endswith("placeholder_key"):
        def _sync_clerk_background(uid: int, email_str: str, uname_str: str, pwd_str: str):
            try:
                import urllib.request, json
                clerk_payload = json.dumps({
                    "email_address": [email_str],
                    "username": uname_str,
                    "password": pwd_str,
                    "skip_password_checks": True
                }).encode()
                clerk_req = urllib.request.Request(
                    "https://api.clerk.com/v1/users",
                    data=clerk_payload,
                    headers={
                        "Authorization": f"Bearer {clerk_secret}",
                        "Content-Type": "application/json",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                    }
                )
                with urllib.request.urlopen(clerk_req, timeout=4) as c_res:
                    c_user = json.loads(c_res.read().decode())
                    c_uid = c_user.get("id")
                    if c_uid:
                        conn_bg = db.get_connection()
                        cur_bg = db.get_cursor(conn_bg)
                        p_bg = db.get_placeholder()
                        u_bg = db.get_user_table()
                        cur_bg.execute(f"UPDATE {u_bg} SET clerk_id = {p_bg} WHERE id = {p_bg}", (c_uid, uid))
                        conn_bg.commit()
                        conn_bg.close()
            except Exception as e:
                logger.debug(f"[Clerk Headless Sync Warning]: {e}")

        import threading
        threading.Thread(
            target=_sync_clerk_background,
            args=(user_id, req.email.lower().strip(), req.username.strip(), req.password),
            daemon=True
        ).start()

    return {
        "ok": True,
        "message": "Account created successfully.",
        "user_id": user_id,
        "username": req.username.strip(),
        "clerk_token": None
    }


@app.post("/api/login")
def api_login(req: LoginRequest):
    ident = req.username.strip()
    user = db.get_user_by_username(ident)
    if not user and "@" in ident:
        user = db.get_user_by_email(ident.lower())
    if not user:
        user = db.get_user_by_email(ident.lower())
    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    if not verify_password(req.password, user.get("password_hash") or ""):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    
    # Ensure active status without OTP roadblocks
    if not user.get("is_verified"):
        db.mark_user_verified(user["id"])
        
    return {"ok": True, "user_id": user["id"], "username": user["username"]}


class BotConfigRequest(BaseModel):
    user_id: int
    assets: str | list[str]
    # Legacy field names (min_profit_target = session target profit,
    # max_profit_target = session max loss — as the original form used them).
    total_capital: Optional[float] = None
    max_risk_per_trade: Optional[float] = None
    min_profit_target: Optional[float] = None
    max_profit_target: Optional[float] = None
    is_active: Optional[bool] = None
    # Control-center field names
    market_category: Optional[str] = None
    allocated_capital: Optional[float] = None
    target_profit: Optional[float] = None
    max_loss: Optional[float] = None
    leverage: Optional[float] = None


def _infer_bot_category(assets) -> Optional[str]:
    wanted = {str(a).strip().upper() for a in assets if str(a).strip()}
    for cat in market_universe():
        if wanted and wanted <= {x["symbol"].upper() for x in cat["assets"]}:
            return cat["id"]
    return None


def _format_bot_config(config: dict, is_live: bool) -> dict:
    config = dict(config)
    # The legacy is_active flag is no longer authoritative; a live session is.
    config["is_active"] = is_live
    config["assets_list"] = [a.strip().upper() for a in str(config.get("assets") or "").split(",") if a.strip()]
    config["allocated_capital"] = config.get("total_capital")
    config["target_profit"] = config.get("min_profit_target")
    config["max_loss"] = config.get("max_profit_target")
    return config


@app.get("/api/bot-config")
async def api_get_bot_config(user_id: int):
    await _require_user(user_id)  # get_bot_config inserts a default row, so the account must exist first
    config, live = await asyncio.gather(
        asyncio.to_thread(db.get_bot_config, user_id),
        asyncio.to_thread(db.get_live_bot_session, user_id),
    )
    if not config:
        raise HTTPException(status_code=404, detail="Bot config not found")
    return {"ok": True, "config": _format_bot_config(config, bool(live))}

@app.get("/api/report")
def api_get_report(user_id: int = 1):
    """Full performance report for one user: summary stats, curve, breakdowns."""
    trades = db.get_all_trades(user_id)
    # The equity curve is plotted against the opening balance, which is the
    # current balance rewound by everything already realised.
    current_balance = db.get_user_balance(user_id)
    realised = sum(
        float(t.get("pnl") or 0) for t in trades if t.get("status") == "closed"
    )
    report = reporting.build_report(trades, starting_balance=current_balance - realised)
    return {"ok": True, "report": report, "data": report, **report}


@app.get("/api/report/export.csv")
def api_export_report_csv(user_id: int):
    """The same trade record as a CSV download, for Excel or a tax filing."""
    trades = db.get_all_trades(user_id)

    columns = [
        "id", "timestamp", "asset", "type", "status", "outcome", "quantity",
        "entry_price", "exit_price", "current_price", "sl", "target", "pnl",
    ]

    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for trade in trades:
        writer.writerow({c: trade.get(c, "") for c in columns})

    filename = f"aether-trade-report-{datetime.now().strftime('%Y%m%d-%H%M%S')}.csv"
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/bot-config")
async def api_update_bot_config(req: BotConfigRequest):
    """
    Save the bot configuration. Saving never reserves or deducts capital.
    Legacy clients that flip is_active start/stop a session through the same
    validated path as /api/bot/session/start|stop.
    """
    await _require_user(req.user_id)
    assets = req.assets if isinstance(req.assets, list) else str(req.assets).split(",")
    category = req.market_category or _infer_bot_category(assets)
    balance = await asyncio.to_thread(db.get_user_balance, req.user_id)
    try:
        clean = validate_bot_config(
            category,
            assets,
            req.allocated_capital if req.allocated_capital is not None else req.total_capital,
            req.target_profit if req.target_profit is not None else req.min_profit_target,
            req.max_loss if req.max_loss is not None else req.max_profit_target,
            req.leverage if req.leverage is not None else 1.0,
            balance,
            bot_engine.policy,
        )
    except BotConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    live = await asyncio.to_thread(db.get_live_bot_session, req.user_id)
    await asyncio.to_thread(BotEngine.save_config, req.user_id, clean, bool(live))
    session = None
    try:
        if req.is_active is True and not live:
            session = await bot_engine.start_session(req.user_id, clean)
        elif req.is_active is False and live:
            session = await bot_engine.stop_session(req.user_id, "Stopped from the configuration toggle")
    except db.BotSessionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except (ValueError, LookupError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "message": "Bot configuration updated", "config": clean, "session": session}


# ---------------------------------------------------------------------------
# Authoritative Dashboard & Trade Management REST Endpoints
# ---------------------------------------------------------------------------

class ClosePositionRequest(BaseModel):
    user_id: int = 1
    quantity: Optional[float] = None
    percentage: Optional[float] = None
    full_close: Optional[bool] = False
    reason: Optional[str] = None

@app.get("/api/dashboard")
@app.get("/api/dashboard/summary")
@app.get("/api/portfolio/summary")
async def api_dashboard_summary(user_id: int = 1):
    """Authoritative financial dashboard summary (Equity, Cash, Margin, P&L, Win Rate)."""
    try:
        data = await position_service.get_account_and_dashboard_summary(user_id)
        flat = dict(data) if isinstance(data, dict) else {}
        return {"ok": True, "data": data, **flat, "timestamp": datetime.now().isoformat(), "source": "database"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

@app.get("/api/trades/open")
@app.get("/api/positions")
async def api_get_open_trades(user_id: int = 1):
    """Retrieve all open positions with live market valuation and P&L."""
    try:
        trades = await position_service.get_live_open_positions(user_id)
        return {
            "ok": True,
            "trades": trades,
            "positions": trades,
            "count": len(trades),
            "timestamp": datetime.now().isoformat(),
            "source": "database"
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

@app.get("/api/trades/history")
async def api_get_trades_history(
    user_id: int = 1,
    symbol: Optional[str] = None,
    market: Optional[str] = None,
    side: Optional[str] = None,
    outcome: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
    source: Optional[str] = None,
    bot_session_id: Optional[int] = None
):
    """Paginated completed trade history with filters (source=bot|manual, bot_session_id)."""
    try:
        res = await position_service.get_trade_history_paginated(
            user_id=user_id,
            symbol=symbol,
            market=market,
            side=side,
            outcome=outcome,
            limit=limit,
            offset=offset,
            source=source,
            bot_session_id=bot_session_id
        )
        return {
            "ok": True,
            "data": res,
            "trades": res.get("trades", []),
            "total": res.get("total", 0),
            "total_count": res.get("total_count", 0),
            "limit": res.get("limit", limit),
            "offset": res.get("offset", offset)
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

@app.get("/api/trades/pending")
@app.get("/api/orders/pending")
async def api_get_pending_trades(user_id: int = 1):
    """Retrieve all pending unfilled orders."""
    try:
        orders = await position_service.get_pending_orders_list(user_id)
        return {"ok": True, "orders": orders, "count": len(orders)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

@app.get("/api/trades/{trade_id}")
async def api_get_trade_by_id(trade_id: int, user_id: int = 1):
    """Retrieve trade by id with ownership validation."""
    pos = db.get_position_by_id(trade_id, user_id)
    if not pos:
        raise HTTPException(status_code=404, detail="Trade not found or unauthorized.")
    return {"ok": True, "trade": pos}

class OpenTradeRequest(BaseModel):
    user_id: int = 1
    symbol: str
    side: str = "BUY"
    quantity: float
    leverage: Optional[float] = 1.0
    sl: Optional[float] = None
    target: Optional[float] = None
    market: Optional[str] = None
    notes: Optional[str] = None

@app.post("/api/trade/open")
@app.post("/api/trades/open")
async def api_open_trade(req: OpenTradeRequest):
    """Authoritative trade opening endpoint fulfilling Part 12 database & Valkey sync."""
    user_id = req.user_id
    symbol = req.symbol.strip().upper()
    side = req.side.strip().upper()
    if side not in ("BUY", "SELL", "LONG", "SHORT"):
        raise HTTPException(status_code=400, detail="Invalid trade side")
    side = "BUY" if side in ("BUY", "LONG") else "SELL"
    if req.quantity <= 0:
        raise HTTPException(status_code=400, detail="Trade quantity must be greater than zero")
    leverage = max(1.0, float(req.leverage or 1.0))

    # 1. Obtain the real-time market price. No price, no order: a trade is
    # never executed against an invented price.
    try:
        price = float(await market_service.get_price(symbol) or 0.0)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"No live market price available for {symbol}: {exc}")
    if price <= 0:
        raise HTTPException(status_code=503, detail=f"No live market price available for {symbol}.")

    # 2 & 3. Shared execution path (also used by the Auto-Trade Bot): atomic
    # balance validation, margin reservation, trade insert and audit record in
    # one transaction, then the Valkey live-state indices.
    try:
        opened = await position_service.open_market_position(
            user_id,
            symbol,
            side,
            req.quantity,
            leverage=leverage,
            sl=req.sl or 0.0,
            target=req.target or 0.0,
            market=req.market or ("Crypto" if "-" in symbol else "Stock"),
            price=price,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    trade_dict = opened["trade"]
    trade_id = trade_dict["id"]
    res_balance = opened["balance"]

    # 4. Broadcast real-time WebSocket events immediately
    await manager.send_to_user(user_id, {"type": "trade_opened", "data": trade_dict})
    await manager.send_to_user(user_id, {"type": "wallet", "balance": res_balance})

    async def _broadcast_open():
        try:
            live_open = await position_service.get_live_open_positions(user_id)
            await manager.send_to_user(user_id, {"type": "positions_updated", "data": {"trades": live_open}})
        except Exception as e:
            logger.error(f"Error in post-open broadcast: {e}")

    asyncio.create_task(_broadcast_open())

    return {
        "ok": True,
        "status": "success",
        "trade": trade_dict,
        "data": trade_dict,
        "trade_id": trade_id,
        "id": trade_id,
        "message": f"Successfully opened {side} position for {req.quantity} {symbol}"
    }

class PartialCloseRequest(BaseModel):
    user_id: int = 1
    quantity: Optional[float] = None
    percentage: Optional[float] = None
    reason: Optional[str] = None

@app.post("/api/trades/{trade_id}/partial-close")
async def api_partial_close_position(trade_id: int, req: PartialCloseRequest):
    """Dedicated endpoint for partial position close supporting quantity or percentage."""
    close_req = ClosePositionRequest(user_id=req.user_id, quantity=req.quantity, percentage=req.percentage, full_close=False)
    return await api_close_position(trade_id, close_req)

@app.post("/api/trades/{trade_id}/close")
async def api_close_position(trade_id: int, req: ClosePositionRequest):
    """
    Close an active position partially or fully.
    Emits real-time wallet and position updates across WebSocket to connected clients.
    """
    try:
        pos = await asyncio.to_thread(db.get_position_by_id, trade_id, req.user_id)
        if not pos:
            raise HTTPException(status_code=404, detail="Position not found or unauthorized.")
        if pos["status"] != "active" and pos["status"] != "pending":
            raise HTTPException(status_code=400, detail=f"Position is {pos['status']}, cannot close.")

        rem_qty = float(pos.get("remaining_quantity") if pos.get("remaining_quantity") is not None else pos.get("quantity", 0.0))

        close_qty = req.quantity
        if close_qty is None and req.percentage is not None:
            pct = max(1.0, min(100.0, float(req.percentage)))
            close_qty = round(rem_qty * (pct / 100.0), 6)

        if req.full_close or close_qty is None or float(close_qty) >= rem_qty:
            result = await position_service.close_position_fully(trade_id, req.user_id, pos=pos, skip_summary=True)
        else:
            if float(close_qty) <= 0:
                raise HTTPException(status_code=400, detail="Close quantity must be positive.")
            result = await position_service.close_position_partially(trade_id, req.user_id, float(close_qty), pos=pos, skip_summary=True)

        # Background task for broadcasting and full summary refresh so the client HTTP call returns in <300ms
        async def _broadcast_and_sync():
            try:
                if pos.get("bot_session_id"):
                    await bot_engine.on_trade_closed(pos, result)
                summary = await position_service.get_account_and_dashboard_summary(req.user_id)
                wallet_balance = summary.get("account", {}).get("available_balance", 0.0)
                await manager.send_to_user(req.user_id, {"type": "wallet", "balance": wallet_balance})
                live_open = summary.get("open_positions") if "open_positions" in summary else await position_service.get_live_open_positions(req.user_id)
                await manager.send_to_user(req.user_id, {"type": "positions_updated", "data": {"trades": live_open}})
                await manager.send_to_user(req.user_id, {"type": "dashboard_summary", "data": summary})
                if req.full_close or result.get("status") == "closed":
                    await manager.send_to_user(req.user_id, {"type": "trade_closed", "data": result})
                else:
                    await manager.send_to_user(req.user_id, {"type": "trade_updated", "data": result})
                    await manager.send_to_user(req.user_id, {"type": "position_updated", "data": result})
            except Exception as e:
                logger.error(f"Error in post-close sync: {e}")

        asyncio.create_task(_broadcast_and_sync())

        return {"ok": True, "success": True, "result": result, **result}
    except HTTPException:
        raise
    except ValueError as val_err:
        raise HTTPException(status_code=400, detail=str(val_err))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

@app.post("/api/trades/{trade_id}/close/full")
async def api_full_close_position(trade_id: int, user_id: int = 1):
    """Convenience endpoint for full close."""
    req = ClosePositionRequest(user_id=user_id, full_close=True)
    return await api_close_position(trade_id, req)


# WebSocket Manager to handle connected clients
class ConnectionManager:
    """
    Tracks live sockets and which user each one belongs to.

    Every outbound message goes through a per-socket FIFO queue drained by a
    single writer task. The agents are synchronous, so they emit their log lines
    through asyncio.create_task while the pipeline awaits its own sends; without
    one ordered queue the two streams interleaved and the terminal showed
    results before the log lines that produced them.
    """

    def __init__(self):
        self.active_connections: list[WebSocket] = []
        self.user_of: dict[WebSocket, int] = {}
        self._queues: dict[WebSocket, asyncio.Queue] = {}
        self._writers: dict[WebSocket, asyncio.Task] = {}

    async def connect(self, websocket: WebSocket, user_id: int):
        await websocket.accept()
        self.active_connections.append(websocket)
        self.user_of[websocket] = user_id
        self._queues[websocket] = asyncio.Queue()
        self._writers[websocket] = asyncio.create_task(self._writer(websocket))

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        self.user_of.pop(websocket, None)
        self._queues.pop(websocket, None)
        writer = self._writers.pop(websocket, None)
        if writer:
            writer.cancel()

    async def _writer(self, websocket: WebSocket):
        queue = self._queues.get(websocket)
        if queue is None:
            return
        try:
            while True:
                message = await queue.get()
                try:
                    await websocket.send_json(message)
                except Exception:
                    # Socket is gone — stop writing instead of spinning on a
                    # dead connection forever.
                    self.disconnect(websocket)
                    return
        except asyncio.CancelledError:
            pass

    def send_soon(self, message: dict, websocket: WebSocket):
        """Queue a message from synchronous code (the agents' log callback)."""
        queue = self._queues.get(websocket)
        if queue is not None:
            queue.put_nowait(message)

    async def send_json(self, message: dict, websocket: WebSocket):
        """Queue a message and yield, preserving order with send_soon()."""
        self.send_soon(message, websocket)
        await asyncio.sleep(0)

    async def broadcast(self, message: dict):
        for connection in list(self.active_connections):
            self.send_soon(message, connection)
        await asyncio.sleep(0)

    async def send_to_user(self, user_id: int, message: dict):
        """
        Deliver only to the sockets belonging to one user.

        The autotrade scanner used to broadcast() wallet and position payloads,
        which pushed one user's portfolio into every connected browser.
        """
        for connection in list(self.active_connections):
            if self.user_of.get(connection) == user_id:
                self.send_soon(message, connection)
        await asyncio.sleep(0)


manager = ConnectionManager()

# Dictionary to hold the running agent loops
# Key: websocket, Value: asyncio.Task
running_loops = {}
# Asset each terminal pipeline is analysing (priced by the tick scheduler).
pipeline_assets = {}
# Always priced, so the dashboard has live ticks before any position exists.
WATCHLIST_SYMBOLS = ("BTC-USD", "ETH-USD")


def build_confluence(momentum_res, ribbon_res, flow_res, mtf_res):
    """
    Package the specialist agents' reads for the Strategy Judge.

    Only the four *directional* agents are included. The Volatility Analyst is
    deliberately left out: it grades regime and position size, and giving it a
    directional vote it never forms would just dilute the tally.
    """
    return {
        "Momentum Candle (Big Bar)": momentum_res,
        "EMA Ribbon 5/9/15": ribbon_res,
        "Volume Flow (OBV/VWAP)": flow_res,
        "Multi-Timeframe Alignment": mtf_res,
    }


def stop_pipeline(websocket: WebSocket):
    """Cancel and forget any agent pipeline attached to this socket."""
    pipeline_assets.pop(websocket, None)
    task = running_loops.pop(websocket, None)
    if task:
        task.cancel()

async def run_agent_pipeline(websocket: WebSocket, asset: str, user_id: int):
    loop = asyncio.get_running_loop()

    def log_agent(agent_name, message):
        """
        Log callback handed to the (synchronous) agents.

        Agents run inside a worker thread, so this must be thread-safe: it hands
        the message to the socket's FIFO queue via call_soon_threadsafe rather
        than touching the event loop directly.
        """
        log_msg = {
            "type": "log",
            "agent": agent_name,
            "message": message,
            "time": datetime.now().strftime("%H:%M:%S"),
        }
        loop.call_soon_threadsafe(manager.send_soon, log_msg, websocket)

    try:
        log_agent("SYSTEM", f"Starting agent pipeline for {asset}...")

        # 1. Fetch historical data via centralized MarketDataService
        log_agent("SYSTEM", f"Retrieving validated market data for {asset} via MarketDataService...")
        try:
            snapshot = await market_service.get_historical_snapshot(asset, period="60d", interval="1d")
            df = await market_service.get_normalized_dataframe(asset, period="60d", interval="1d")
        except Exception as exc:
            log_agent("SYSTEM", f"ERROR: Could not load market data for '{asset}': {exc}")
            await manager.send_json({"type": "system_status", "status": "standby"}, websocket)
            return

        log_agent("SYSTEM", f"Successfully loaded {snapshot.count} days of verified historical data (Age: {snapshot.data_age_seconds:.1f}s).")
        
        # Convert snapshot candles to lightweight-charts format
        # [{time: 'YYYY-MM-DD', open: X, high: Y, low: Z, close: W, volume: V}]
        candles = [
            {
                "time": c.time,
                "open": c.open,
                "high": c.high,
                "low": c.low,
                "close": c.close,
                "volume": c.volume,
            }
            for c in snapshot.candles
        ]
            
        # Send historical data to client
        latest_close = snapshot.quote.price
        prev_close = snapshot.quote.previous_close
        change_pct = snapshot.quote.change_percent
        
        await manager.send_json({
            "type": "history",
            "candles": candles,
            "changePercent": change_pct
        }, websocket)
        
        # Initial database values sync
        balance = db.get_user_balance(user_id)
        await manager.send_json({"type": "wallet", "balance": balance}, websocket)
        await manager.send_json({"type": "positions", "positions": db.get_active_positions(user_id)}, websocket)
        await manager.send_json({"type": "history_trades", "trades": db.get_trade_history(user_id)}, websocket)
        
        # ── SEQUENTIAL INITIALIZATION OF THE 12 AGENTS ──
        # Each agent writes its own opening line through log_func, so the
        # pipeline no longer repeats it (every header used to appear twice).

        # Agent 1: Levels Analyst (Chart Analyst)
        log_agent("Levels Analyst", "Analyzing historical candles to identify key price zones...")
        await asyncio.sleep(0.8)
        sr_data = find_support_resistance(df, window=5, log_func=log_agent)
        # Liquidity zones = recent swing highs/lows beyond the normal S/R
        liquidity_zones = sr_data.get("liquidity", []) or (
            [s * 0.992 for s in sr_data["supports"][:2]] +
            [r * 1.008 for r in sr_data["resistances"][:2]]
        )
        await manager.send_json({
            "type": "levels",
            "supports": sr_data["supports"],
            "resistances": sr_data["resistances"],
            "liquidity": liquidity_zones
        }, websocket)
        await asyncio.sleep(0.8)

        # Agent 2: Indicator Analyst
        log_agent("Indicator Analyst", "Calculating technical indicators (RSI, MACD, Moving Averages)...")
        await asyncio.sleep(0.8)
        tech_res = await asyncio.to_thread(analyze_indicators, df, log_agent)
        await manager.send_json({
            "type": "metrics",
            "trend": tech_res
        }, websocket)
        await asyncio.sleep(0.8)
        
        # Agent 3: News Analyst
        log_agent("News Analyst", f"📡 Fetching live news headlines for '{asset}'...")
        await asyncio.sleep(0.8)
        sentiment_res = await asyncio.to_thread(analyze_sentiment, asset, log_agent)
        sentiment_score = sentiment_res["score"]
        await manager.send_json({
            "type": "metrics",
            "sentiment": sentiment_score
        }, websocket)
        await asyncio.sleep(0.8)

        # Agent 4: Momentum Candle Analyst — the "big bar" read
        log_agent("Momentum Candle Analyst", "Grading recent candles for decisive momentum bars...")
        await asyncio.sleep(0.8)
        momentum_res = await asyncio.to_thread(analyze_momentum_candles, df, log_agent)
        await manager.send_json({"type": "metrics", "momentum": momentum_res}, websocket)
        await asyncio.sleep(0.8)

        # Agent 5: EMA Ribbon Analyst — fast 5/9/15 stacking and crossovers
        log_agent("EMA Ribbon Analyst", "Mapping the fast EMA 5/9/15 ribbon for trend and triggers...")
        await asyncio.sleep(0.8)
        ribbon_res = await asyncio.to_thread(analyze_ema_ribbon, df, log_agent)
        await manager.send_json({"type": "metrics", "ribbon": ribbon_res}, websocket)
        await asyncio.sleep(0.8)

        # Agent 6: Volatility Analyst — ATR / squeeze regime, gates position size
        log_agent("Volatility Analyst", "Classifying the volatility regime (ATR + Bollinger bandwidth)...")
        await asyncio.sleep(0.8)
        volatility_res = await asyncio.to_thread(analyze_volatility, df, log_agent)
        await manager.send_json({"type": "metrics", "volatility": volatility_res}, websocket)
        await asyncio.sleep(0.8)

        # Agent 7: Volume Flow Analyst — OBV, VWAP and participation divergence
        log_agent("Volume Flow Analyst", "Measuring order flow behind the current move (OBV / VWAP)...")
        await asyncio.sleep(0.8)
        flow_res = await asyncio.to_thread(analyze_volume_flow, df, log_agent)
        await manager.send_json({"type": "metrics", "flow": flow_res}, websocket)
        await asyncio.sleep(0.8)

        # Agent 8: MTF Trend Analyst — does the weekly chart agree with the daily?
        log_agent("MTF Trend Analyst", "Resampling to the higher timeframe to check trend alignment...")
        await asyncio.sleep(0.8)
        mtf_res = await asyncio.to_thread(analyze_mtf_trend, df, log_agent)
        await manager.send_json({"type": "metrics", "mtf": mtf_res}, websocket)
        await asyncio.sleep(0.8)

        # Agent 9: Strategy Judge (Consensus Agent)
        # The four directional specialists above vote alongside the 12
        # quantitative strategies, so the consensus reflects the whole pipeline.
        await asyncio.sleep(0.8)
        confluence_signals = build_confluence(momentum_res, ribbon_res, flow_res, mtf_res)
        strategy_res = await asyncio.to_thread(
            evaluate_strategies, df, sr_data["supports"], sr_data["resistances"], log_agent,
            confluence_signals,
        )
        await manager.send_json({
            "type": "metrics",
            "consensus": strategy_res
        }, websocket)
        await asyncio.sleep(0.8)

        # Agent 10: Risk Planner
        await asyncio.sleep(0.8)
        wallet_balance = db.get_user_balance(user_id)
        active_positions = db.get_active_positions(user_id)
        has_active_or_pending = any(p["status"] in ("active", "pending") for p in active_positions)
        
        trade_setup = await asyncio.to_thread(
            plan_trade,
            strategy_res,
            sentiment_score,
            sr_data["supports"],
            sr_data["resistances"],
            latest_close,
            wallet_balance,
            log_agent,
            strategy_res.get("reasoning", ""),
        )
        if not has_active_or_pending and trade_setup["action"] in ("buy", "sell"):
            trade_id = db.create_pending_trade(
                user_id,
                asset, 
                trade_setup["action"], 
                trade_setup["quantity"], 
                trade_setup["entry"], 
                trade_setup["sl"], 
                trade_setup["target"]
            )
            capital_required = trade_setup["quantity"] * trade_setup["entry"]
            max_risk = abs(trade_setup["entry"] - trade_setup["sl"]) * trade_setup["quantity"]
            await manager.send_json({
                "type": "signal",
                "trade_id": trade_id,
                "direction": trade_setup["action"],
                "entry": trade_setup["entry"],
                "sl": trade_setup["sl"],
                "target": trade_setup["target"],
                "quantity": trade_setup["quantity"],
                "capital_required": capital_required,
                "max_risk": max_risk
            }, websocket)
            await manager.send_json({"type": "positions", "positions": db.get_active_positions(user_id)}, websocket)
        await asyncio.sleep(0.8)

        # Agent 11: Execution Agent (order desk — manages unconfirmed orders)
        log_agent("Execution Agent", "Scanning open orders for execution criteria...")
        await asyncio.sleep(0.8)
        active_positions = db.get_active_positions(user_id)
        pending_trades = [p for p in active_positions if p["status"] == "pending"]
        if pending_trades:
            withdrawn = await asyncio.to_thread(check_and_execute_trades, latest_close, log_agent, user_id)
            if withdrawn:
                await manager.send_json({"type": "positions", "positions": db.get_active_positions(user_id)}, websocket)
            else:
                log_agent("Execution Agent", f"{len(pending_trades)} order(s) still valid. Awaiting trader confirmation.")
        else:
            log_agent("Execution Agent", "No pending orders to manage. Waiting for entry conditions.")
        await asyncio.sleep(0.8)

        # Agent 12: Portfolio Monitor (P&L Manager)
        log_agent("P&L Manager", "Scanning open positions to monitor P&L and risk constraints...")
        await asyncio.sleep(0.8)
        open_positions = [p for p in active_positions if p["status"] == "active"]
        if open_positions:
            closed = await asyncio.to_thread(monitor_positions, latest_close, log_agent, user_id, asset)
            if closed:
                await manager.send_json({"type": "wallet", "balance": db.get_user_balance(user_id)}, websocket)
                await manager.send_json({"type": "positions", "positions": db.get_active_positions(user_id)}, websocket)
                await manager.send_json({"type": "history_trades", "trades": db.get_trade_history(user_id)}, websocket)
                summary = await position_service.get_account_and_dashboard_summary(user_id)
                await manager.send_json({"type": "dashboard_summary", "data": summary}, websocket)
            else:
                log_agent("P&L Manager", "Active positions monitoring completed. Risk thresholds are clear.")
        else:
            log_agent("P&L Manager", "No active positions to monitor. Monitoring completed.")
        await asyncio.sleep(0.8)

        # Live loop: every tick re-reads the real market quote (MarketDataService,
        # cached upstream) and re-runs the agents on the current candle. A tick
        # without a fresh quote is skipped entirely, so nothing is planned,
        # filled or closed against an invented price.
        live_price = latest_close
        tick_count = 0

        while True:
            tick_count += 1
            try:
                quote = await market_service.get_quote(asset)
            except Exception as exc:
                quote = None
                if tick_count % 5 == 1:
                    log_agent("SYSTEM", f"Live quote for {asset} unavailable ({exc}); waiting for market data.")
            if quote is None or not quote.price or quote.price <= 0:
                await asyncio.sleep(TICK_INTERVAL_SECONDS)
                continue
            live_price = float(quote.price)
            live_change_pct = float(quote.change_percent or 0.0)
            tick_payload = {
                "type": "tick",
                "symbol": asset,
                "candle": {
                    "time": int(datetime.now().timestamp()),
                    "open": live_price,
                    "high": live_price,
                    "low": live_price,
                    "close": live_price,
                },
                "changePercent": live_change_pct,
                "data": {"price": live_price, "change_percent": live_change_pct},
            }
            await manager.send_json(tick_payload, websocket)

            # 2. Run indicator analyst (Agent 2)
            # Fold the tick into the CURRENT candle rather than appending a new
            # one. Appending a synthetic row where open==high==low==close and
            # volume==0 made every candle-pattern and volume-based strategy
            # degenerate (zero range, zero body, zero volume).
            df_curr = df.copy()
            last = df_curr.index[-1]
            df_curr.loc[last, "Close"] = live_price
            df_curr.loc[last, "High"] = max(float(df_curr.loc[last, "High"]), live_price)
            df_curr.loc[last, "Low"] = min(float(df_curr.loc[last, "Low"]), live_price)

            tech_res = await asyncio.to_thread(
                analyze_indicators, df_curr, log_agent if tick_count % 3 == 1 else None
            )
            
            # Update metrics gauges
            await manager.send_json({
                "type": "metrics",
                "trend": tech_res
            }, websocket)
            
            # 3. News sentiment analyst (Agent 3) runs every 5 ticks (20s) to save rate limits
            if tick_count % 5 == 1:
                sentiment_res = await asyncio.to_thread(analyze_sentiment, asset, log_agent)
                sentiment_score = sentiment_res["score"]
                await manager.send_json({
                    "type": "metrics",
                    "sentiment": sentiment_score
                }, websocket)
                
            # 4. Specialist analysts (Agents 4-8) re-read the live candle.
            # They are cheap, pure-pandas passes, so they run every tick; only
            # every third tick is logged, matching the other live agents.
            verbose = log_agent if tick_count % 3 == 1 else None
            momentum_res = await asyncio.to_thread(analyze_momentum_candles, df_curr, verbose)
            ribbon_res = await asyncio.to_thread(analyze_ema_ribbon, df_curr, verbose)
            volatility_res = await asyncio.to_thread(analyze_volatility, df_curr, verbose)
            flow_res = await asyncio.to_thread(analyze_volume_flow, df_curr, verbose)
            mtf_res = await asyncio.to_thread(analyze_mtf_trend, df_curr, verbose)

            await manager.send_json({
                "type": "metrics",
                "momentum": momentum_res,
                "ribbon": ribbon_res,
                "volatility": volatility_res,
                "flow": flow_res,
                "mtf": mtf_res,
            }, websocket)

            # 5. Run Strategy Consensus Judge (Agent 9)
            strategy_res = await asyncio.to_thread(
                evaluate_strategies,
                df_curr,
                sr_data["supports"],
                sr_data["resistances"],
                verbose,
                build_confluence(momentum_res, ribbon_res, flow_res, mtf_res),
            )
            
            await manager.send_json({
                "type": "metrics",
                "consensus": strategy_res
            }, websocket)
            
            # Check active trades database
            wallet_balance = db.get_user_balance(user_id)
            active_positions = db.get_active_positions(user_id)
            
            has_active_or_pending = any(p["status"] in ("active", "pending") for p in active_positions)
            
            # 6. Run Risk Planner (Agent 10)
            # Only plan a new trade if we don't have an active or pending trade already
            if not has_active_or_pending and strategy_res["signal"] in ("buy", "sell"):
                trade_setup = await asyncio.to_thread(
                    plan_trade,
                    strategy_res,
                    sentiment_score,
                    sr_data["supports"],
                    sr_data["resistances"],
                    live_price,
                    wallet_balance,
                    log_agent,
                    strategy_res.get("reasoning", ""),
                )
                
                if trade_setup["action"] in ("buy", "sell"):
                    # Save pending trade to database (waits for user confirmation)
                    trade_id = db.create_pending_trade(
                        user_id,
                        asset, 
                        trade_setup["action"], 
                        trade_setup["quantity"], 
                        trade_setup["entry"], 
                        trade_setup["sl"], 
                        trade_setup["target"]
                    )
                    capital_required = trade_setup["quantity"] * trade_setup["entry"]
                    max_risk = abs(trade_setup["entry"] - trade_setup["sl"]) * trade_setup["quantity"]
                    # Send confirmation request to UI — trader must approve
                    await manager.send_json({
                        "type": "signal",
                        "trade_id": trade_id,
                        "direction": trade_setup["action"],
                        "entry": trade_setup["entry"],
                        "sl": trade_setup["sl"],
                        "target": trade_setup["target"],
                        "quantity": trade_setup["quantity"],
                        "capital_required": capital_required,
                        "max_risk": max_risk
                    }, websocket)
                    
                    # Sync database tables
                    await manager.send_json({"type": "positions", "positions": db.get_active_positions(user_id)}, websocket)
                    
            # 6. Run Execution Agent (Agent 6) — withdraws stale pending orders
            withdrawn = await asyncio.to_thread(check_and_execute_trades, live_price, log_agent, user_id)
            if withdrawn:
                await manager.send_json({"type": "positions", "positions": db.get_active_positions(user_id)}, websocket)

            # 7. Run Portfolio Monitor (Agent 7) — owns SL/target exits
            closed = await asyncio.to_thread(monitor_positions, live_price, log_agent, user_id, asset)
            if closed:
                await manager.send_json({"type": "wallet", "balance": db.get_user_balance(user_id)}, websocket)
                await manager.send_json({"type": "positions", "positions": db.get_active_positions(user_id)}, websocket)
                await manager.send_json({"type": "history_trades", "trades": db.get_trade_history(user_id)}, websocket)
                summary = await position_service.get_account_and_dashboard_summary(user_id)
                await manager.send_json({"type": "dashboard_summary", "data": summary}, websocket)
                
            # Pause before the next tick
            await asyncio.sleep(TICK_INTERVAL_SECONDS)
            
    except asyncio.CancelledError:
        log_agent("SYSTEM", f"Agent pipeline for {asset} stopped.")
    except Exception as e:
        log_agent("SYSTEM", f"ERROR in pipeline: {str(e)}")
        traceback.print_exc()

# WebSocket Endpoint
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    The socket is bound to the account the Go gateway verified (X-User-ID,
    enforced by GatewayIdentityMiddleware). Query parameters carry no identity.
    """
    user_id = gateway_user_id(websocket)
    user = await asyncio.to_thread(db.get_user_by_id, user_id) if user_id else None
    if user is None:
        # 1008 = policy violation. Accept first so the browser sees the reason.
        await websocket.accept()
        await websocket.send_json({
            "type": "auth_error",
            "message": "Session not recognised. Please log in again.",
        })
        await websocket.close(code=1008)
        return

    user_id = user["id"]
    balance = user["balance"]
    await manager.connect(websocket, user_id)

    # Send initial database sync immediately upon connection
    await manager.send_json({"type": "wallet", "balance": balance}, websocket)
    await manager.send_json({"type": "positions", "positions": db.get_active_positions(user_id)}, websocket)
    await manager.send_json({"type": "history_trades", "trades": db.get_trade_history(user_id)}, websocket)
    initial_summary = await position_service.get_account_and_dashboard_summary(user_id)
    await manager.send_json({"type": "dashboard_summary", "data": initial_summary}, websocket)
    
    try:
        while True:
            # Receive messages from frontend
            try:
                data = await websocket.receive_text()
            except (WebSocketDisconnect, RuntimeError):
                break
            message = json.loads(data)
            
            action = message.get("action")
            
            if action == "start":
                asset = (message.get("asset") or "BTC-USD").strip().upper()
                # Cancel existing loop if running
                stop_pipeline(websocket)

                # Start new loop task
                running_loops[websocket] = asyncio.create_task(
                    run_agent_pipeline(websocket, asset, user_id)
                )
                pipeline_assets[websocket] = asset
                await manager.send_json({"type": "system_status", "status": "running"}, websocket)

            elif action == "stop":
                stop_pipeline(websocket)
                await manager.send_json({"type": "system_status", "status": "standby"}, websocket)

            elif action == "confirm_trade":
                # Trader confirmed — execute the pending trade immediately
                trade_id = message.get("trade_id")
                pending = db.get_active_positions(user_id)
                for p in pending:
                    if p["status"] == "pending" and (trade_id is None or p["id"] == trade_id):
                        fill_price = p["entry_price"]
                        filled = db.execute_trade(p["id"], fill_price)
                        if filled:
                            text = f"[ORDER FILLED] Trade #{p['id']} on {p['asset']} executed at {fill_price:.2f}."
                        else:
                            # execute_trade refuses fills the wallet cannot fund.
                            text = (f"[ORDER REJECTED] Trade #{p['id']} on {p['asset']} needs "
                                    f"{p['quantity'] * fill_price:.2f} INR, which exceeds the available balance.")
                        await manager.send_json({
                            "type": "log",
                            "agent": "Execution Agent",
                            "message": text,
                            "time": datetime.now().strftime("%H:%M:%S"),
                        }, websocket)
                        break
                await manager.send_json({"type": "wallet", "balance": db.get_user_balance(user_id)}, websocket)
                await manager.send_json({"type": "positions", "positions": db.get_active_positions(user_id)}, websocket)
                updated_summary = await position_service.get_account_and_dashboard_summary(user_id)
                await manager.send_json({"type": "dashboard_summary", "data": updated_summary}, websocket)

            elif action in ("cancel_trade", "reject_trade"):
                # Trader rejected — cancel the named pending order, or every
                # pending order when no trade_id is given.
                raw_id = message.get("trade_id")
                try:
                    wanted = None if raw_id is None else int(raw_id)
                    valid_request = True
                except (TypeError, ValueError):
                    wanted, valid_request = None, False
                for p in (db.get_active_positions(user_id) if valid_request else []):
                    if p["status"] == "pending" and (wanted is None or p["id"] == wanted):
                        db.close_trade(p["id"], p["entry_price"], "cancelled")
                await manager.send_json({"type": "positions", "positions": db.get_active_positions(user_id)}, websocket)
                updated_summary = await position_service.get_account_and_dashboard_summary(user_id)
                await manager.send_json({"type": "dashboard_summary", "data": updated_summary}, websocket)
                log_msg = {"type": "log", "agent": "Risk Planner",
                           "message": "Trade cancelled by trader.",
                           "time": datetime.now().strftime("%H:%M:%S")}
                await manager.send_json(log_msg, websocket)
                
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"WebSocket error for user {user_id}: {e}")
        traceback.print_exc()
    finally:
        # Always tear down, whatever ended the session — a leaked pipeline task
        # kept trading against a browser that had already gone away.
        stop_pipeline(websocket)
        manager.disconnect(websocket)

# ---------------------------------------------------------------------------
# Auto-Trade Bot — event delivery, REST API and Go scheduler step endpoints
# ---------------------------------------------------------------------------
# The legacy autotrade_scanner_loop (a Python asyncio loop over bot_config
# rows) is gone. Scheduling and concurrency live in the Go gateway
# (backend/botsched); this process executes single steps when asked.

_gateway_publish_down_until = 0.0


def _publish_via_gateway(user_id: int, message: dict) -> int:
    """
    Hand a user-scoped event to the Go gateway, which fans it out to that
    user's proxied sockets. Returns the number of sockets reached, or -1 when
    the gateway is unreachable (then skipped for a short back-off).
    """
    global _gateway_publish_down_until
    if time.time() < _gateway_publish_down_until:
        return -1
    try:
        import urllib.request
        body = json.dumps({"user_id": str(user_id), "message": message}, default=str).encode()
        req = urllib.request.Request(
            f"{GATEWAY_INTERNAL_URL}/internal/events/publish",
            data=body,
            method="POST",
            headers={"Content-Type": "application/json", "X-Orbit-Internal-Token": INTERNAL_TOKEN},
        )
        with urllib.request.urlopen(req, timeout=0.5) as resp:
            return int(json.loads(resp.read() or b"{}").get("delivered", 0))
    except Exception:
        _gateway_publish_down_until = time.time() + 15.0
        return -1


async def publish_to_user(user_id: int, message: dict):
    """Go gateway fan-out first; the Python socket manager only when no gateway socket took the event."""
    delivered = await asyncio.to_thread(_publish_via_gateway, user_id, message)
    if delivered <= 0:
        await manager.send_to_user(user_id, message)


bot_engine = BotEngine(publish=publish_to_user)


async def _require_user(user_id: int) -> dict:
    """
    Resolve the acting account. user_id is the account the Go gateway verified
    (GatewayIdentityMiddleware rewrites it); every bot query is scoped to it,
    so one account can never read or control another account's sessions.
    """
    user = await asyncio.to_thread(db.get_user_by_id, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    return user


async def _require_owned_session(session_id: int, user_id: int) -> dict:
    session = await asyncio.to_thread(db.get_bot_session, session_id, user_id)
    if not session:
        raise HTTPException(status_code=404, detail="Bot session not found.")
    return session


@app.get("/api/bot/universe")
async def api_bot_universe(user_id: Optional[int] = None):
    """Market categories, their tradable symbols and the supported leverage values."""
    data = {"ok": True, "categories": market_universe(), "policy": bot_engine.policy.public()}
    if user_id is not None:
        _, data["available_balance"] = await asyncio.gather(
            _require_user(user_id), asyncio.to_thread(db.get_user_balance, user_id))
    return data


@app.get("/api/bot/session/current")
async def api_bot_current_session(user_id: int):
    """The live session (or the most recent one) with live metrics and its open auto-trades."""
    await _require_user(user_id)  # get_bot_config inserts a default row, so the account must exist first
    # Independent reads, each a database round trip: run them together.
    session, config, balance = await asyncio.gather(
        bot_engine.current_view(user_id),
        asyncio.to_thread(db.get_bot_config, user_id),
        asyncio.to_thread(db.get_user_balance, user_id),
    )
    return {
        "ok": True,
        "session": session,
        "config": _format_bot_config(config, bool(session and session["is_live"])) if config else None,
        "available_balance": balance,
        "scheduler_online": bot_engine.scheduler_online(),
        "policy": bot_engine.policy.public(),
    }


@app.get("/api/bot/session/history")
async def api_bot_session_history(user_id: int, limit: int = 20, offset: int = 0):
    _, res = await asyncio.gather(
        _require_user(user_id),
        asyncio.to_thread(db.list_bot_sessions_with_metrics, user_id, max(1, min(100, limit)), max(0, offset)),
    )
    return {"ok": True, **res}


@app.post("/api/bot/session/start")
async def api_bot_start_session(req: BotStartRequest):
    await _require_user(req.user_id)
    try:
        session = await bot_engine.start_session(req.user_id, req.model_dump())
    except db.BotSessionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except ValueError as exc:  # BotConfigError is a ValueError
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "session": session}


@app.post("/api/bot/session/stop")
async def api_bot_stop_session(req: BotStopRequest):
    """Graceful stop: no new scans or entries; open positions are kept."""
    await _require_user(req.user_id)
    try:
        session = await bot_engine.stop_session(req.user_id, req.reason)
    except LookupError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {"ok": True, "session": session}


@app.get("/api/bot/session/{session_id}")
async def api_bot_session_detail(session_id: int, user_id: int):
    session = await _require_owned_session(session_id, user_id)  # scoped to the account; 404 otherwise
    return {"ok": True, "session": await bot_engine.snapshot(session)}


@app.get("/api/bot/session/{session_id}/trades")
async def api_bot_session_trades(session_id: int, user_id: int, status: str = "all"):
    session = await _require_owned_session(session_id, user_id)  # scoped to the account; 404 otherwise
    open_trades, closed = [], []
    if status in ("all", "open"):
        positions = await position_service.get_live_open_positions(user_id)
        open_trades = [p for p in positions if p.get("bot_session_id") == session["id"]]
    if status in ("all", "closed"):
        closed = await asyncio.to_thread(db.get_bot_session_trades, session["id"], "closed")
    return {"ok": True, "session_id": session["id"], "open": open_trades, "closed": closed}


@app.get("/api/bot/session/{session_id}/activity")
async def api_bot_session_activity(session_id: int, user_id: int, limit: int = 100):
    session = await _require_owned_session(session_id, user_id)  # scoped to the account; 404 otherwise
    events = await asyncio.to_thread(bot_engine.activity, session["id"], max(1, min(300, limit)))
    return {"ok": True, "session_id": session["id"], "events": events}


def _require_internal(request: Request):
    """
    Guard for the Go scheduler's step endpoints. With ORBIT_INTERNAL_TOKEN set
    the shared header is required; without it only loopback callers pass.
    Browser requests (they carry an Origin header) are always refused.
    """
    if request.headers.get("origin"):
        raise HTTPException(status_code=403, detail="Forbidden")
    if INTERNAL_TOKEN:
        if not hmac.compare_digest(request.headers.get("x-orbit-internal-token", ""), INTERNAL_TOKEN):
            raise HTTPException(status_code=403, detail="Forbidden")
        return
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1"):
        raise HTTPException(status_code=403, detail="Forbidden: set ORBIT_INTERNAL_TOKEN for non-loopback schedulers.")


_internal = [Depends(_require_internal)]


class SchedulerHeartbeatRequest(BaseModel):
    owner: str
    ttl_seconds: int = 15


class BotAttachRequest(BaseModel):
    recovered: bool = False


class BotAnalyzeRequest(BaseModel):
    symbol: str


class BotEvaluateRequest(BaseModel):
    symbol: str
    analysis_id: str = ""


class BotFailRequest(BaseModel):
    error: str


@app.post("/internal/bot/scheduler/heartbeat", dependencies=_internal)
async def internal_bot_heartbeat(req: SchedulerHeartbeatRequest):
    return await asyncio.to_thread(bot_engine.heartbeat, req.owner, max(5, min(120, req.ttl_seconds)))


@app.get("/internal/bot/scheduler/sessions", dependencies=_internal)
async def internal_bot_sessions():
    return {"sessions": await bot_engine.scheduler_sessions()}


@app.post("/internal/bot/sessions/{session_id}/attach", dependencies=_internal)
async def internal_bot_attach(session_id: int, req: BotAttachRequest):
    return await bot_engine.attach(session_id, req.recovered)


@app.post("/internal/bot/sessions/{session_id}/monitor", dependencies=_internal)
async def internal_bot_monitor(session_id: int):
    return await bot_engine.monitor(session_id)


@app.post("/internal/bot/sessions/{session_id}/scan/begin", dependencies=_internal)
async def internal_bot_begin_scan(session_id: int):
    return await bot_engine.begin_scan(session_id)


@app.post("/internal/bot/analysis", dependencies=_internal)
async def internal_bot_analyze(req: BotAnalyzeRequest):
    return await bot_engine.analyze(req.symbol)


@app.post("/internal/bot/sessions/{session_id}/evaluate", dependencies=_internal)
async def internal_bot_evaluate(session_id: int, req: BotEvaluateRequest):
    return await bot_engine.evaluate(session_id, req.symbol, req.analysis_id)


@app.post("/internal/bot/sessions/{session_id}/scan/complete", dependencies=_internal)
async def internal_bot_complete_scan(session_id: int):
    return await bot_engine.complete_scan(session_id)


@app.post("/internal/bot/sessions/{session_id}/finalize-stop", dependencies=_internal)
async def internal_bot_finalize_stop(session_id: int):
    return await bot_engine.finalize_stop(session_id)


@app.post("/internal/bot/sessions/{session_id}/fail", dependencies=_internal)
async def internal_bot_fail(session_id: int, req: BotFailRequest):
    return await bot_engine.fail_session(session_id, req.error)


@app.get("/internal/auth/resolve", dependencies=_internal)
async def internal_auth_resolve(clerk_id: str):
    """Gateway lookup (when it has no database pool): Clerk user -> ORBIT account."""
    user = await asyncio.to_thread(db.get_user_by_clerk_id, clerk_id.strip())
    if not user:
        raise HTTPException(status_code=404, detail="No account is linked to this Clerk user.")
    return {"user_id": user["id"], "username": user["username"]}


async def market_tick_scheduler_loop():
    """
    Single market tick scheduler for the whole service (every 2.5 s):
      1. Price every symbol with an open position, plus the watchlist and the
         assets open in a terminal, from MarketDataService (real quotes).
      2. Refresh the Valkey live-price cache (market:price:<SYM>, 15 s TTL);
         the Go gateway prices its portfolio reads from it.
      3. Publish a typed tick frame to the orbit-stream hub (public prices).
      4. Push each open position's live P&L to its owner's sockets.
    Positions come straight from the database each round, so live P&L never
    depends on a cache that some read endpoint happened to warm.
    """
    while True:
        try:
            try:
                open_trades = await asyncio.to_thread(db.get_open_positions)
            except Exception as db_err:
                logger.debug(f"[MarketScheduler] open positions unavailable: {db_err}")
                open_trades = []

            by_symbol: dict = {}
            for tr in open_trades:
                sym = (tr.get("asset") or "").strip().upper()
                if sym:
                    by_symbol.setdefault(sym, []).append(tr)
            symbols = set(WATCHLIST_SYMBOLS) | set(by_symbol) | {a for a in pipeline_assets.values() if a}

            for sym in sorted(symbols):
                try:
                    quote = await market_service.get_quote(sym)
                    if not quote or not quote.price or quote.price <= 0:
                        continue
                    curr_price = float(quote.price)
                    change_pct = float(quote.change_percent or 0.0)
                    now_dt = datetime.now()

                    valkey_service.set(f"market:price:{sym}", {
                        "symbol": sym,
                        "price": curr_price,
                        "previous_close": float(quote.previous_close or curr_price),
                        "change": float(quote.change or 0.0),
                        "change_percent": change_pct,
                        "updated_at": now_dt.isoformat(),
                    }, ttl_seconds=15)

                    await asyncio.to_thread(publish_tick, {
                        "type": "tick",
                        "symbol": sym,
                        "candle": {
                            "time": int(now_dt.timestamp()),
                            "open": curr_price,
                            "high": curr_price,
                            "low": curr_price,
                            "close": curr_price,
                            "volume": float(quote.volume or 0.0),
                        },
                        "changePercent": change_pct,
                        "data": {"price": curr_price, "change_percent": change_pct},
                    })

                    for tr in by_symbol.get(sym, []):
                        uid = tr.get("user_id")
                        if not uid:
                            continue
                        entry = float(tr.get("entry_price") or curr_price)
                        rem = tr.get("remaining_quantity")
                        qty = float(rem if rem is not None else (tr.get("quantity") or 0.0))
                        lev = float(tr.get("leverage") or 1.0)
                        if str(tr.get("type") or "buy").lower() == "buy":
                            unrealized = (curr_price - entry) * qty * lev
                        else:
                            unrealized = (entry - curr_price) * qty * lev
                        margin = float(tr.get("margin_used") or ((qty * entry) / lev))
                        pct = (unrealized / margin * 100.0) if margin > 0 else 0.0
                        update = {
                            "id": tr["id"],
                            "trade_id": tr["id"],
                            "user_id": uid,
                            "symbol": sym,
                            "asset": sym,
                            "current_price": round(curr_price, 4),
                            "unrealized_pnl": round(unrealized, 2),
                            "unrealized_pnl_pct": round(pct, 2),
                            "unrealized_pnl_percent": round(pct, 2),
                            "is_live": True,
                            "updated_at": now_dt.isoformat(),
                        }
                        await manager.send_to_user(uid, {
                            "type": "trade_updated",
                            "data": update,
                            "trade_id": tr["id"],
                            "current_price": update["current_price"],
                            "unrealized_pnl": update["unrealized_pnl"],
                        })
                        await manager.send_to_user(uid, {"type": "position_updated", "position": update})
                except Exception as sym_err:
                    logger.debug(f"[MarketScheduler] Error ticking symbol {sym}: {sym_err}")

            await asyncio.sleep(2.5)
        except asyncio.CancelledError:
            break
        except Exception as loop_err:
            logger.warning(f"[MarketScheduler] Exception in tick loop: {loop_err}")
            await asyncio.sleep(5.0)


# The Go gateway on :8000 serves the frontend and static assets; the ai-service
# runs internal AI analytics and agent execution on :8001.

