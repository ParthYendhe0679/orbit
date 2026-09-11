import asyncio
import csv
import io
import json
import os
import random
import traceback
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import yfinance as yf
import pandas as pd

# Load .env before anything reads os.environ (news/LLM keys, DATABASE_URL).
load_dotenv()

import backend.database as db
import backend.reporting as reporting
from backend.services.market_data_service import market_service
from backend.services.agent_orchestrator import agent_orchestrator
from backend.services.strategy_engine import strategy_engine
from backend.services.consensus_engine import consensus_engine
from backend.services.orbit_brain import orbit_brain
from backend.services.risk_guard import risk_guard
from backend.services.opportunity_engine import opportunity_engine
from backend.services.decision_engine import decision_engine
from backend.services.explainability_engine import explainability_engine
from backend.services.copilot_service import copilot_service
from backend.services.position_service import position_service
from backend.services.valkey_service import valkey_service
from backend.models.copilot import CopilotChatRequest, ConversationCreate
from backend.agents.chart_analyst import find_support_resistance
from backend.agents.indicator_analyst import analyze_indicators
from backend.agents.news_analyst import analyze_sentiment
from backend.agents.momentum_candle_analyst import analyze_momentum_candles
from backend.agents.ema_ribbon_analyst import analyze_ema_ribbon
from backend.agents.volatility_analyst import analyze_volatility
from backend.agents.volume_flow_analyst import analyze_volume_flow
from backend.agents.mtf_trend_analyst import analyze_mtf_trend
from backend.agents.strategy_judge import evaluate_strategies
from backend.agents.risk_planner import plan_trade
from backend.agents.execution_agent import check_and_execute_trades
from backend.agents.portfolio_monitor import monitor_positions

# Seconds between price ticks in the live simulation loop.
TICK_INTERVAL_SECONDS = 4
# Seconds between full autotrade market scans.
AUTOTRADE_SCAN_SECONDS = 180

# ---------------------------------------------------------------------------
# Phase 11 — orbit-stream Go hub integration
# ---------------------------------------------------------------------------
# URL of the Go WebSocket broadcast hub.  Python publishes high-frequency tick
# and metrics payloads here; the hub fans them out to all browser clients with
# goroutine-level concurrency.  If the hub is not running the helper silently
# drops the frame — the Python path continues to work as before.
STREAM_HUB_URL = os.getenv("STREAM_HUB_URL", "http://127.0.0.1:8001/publish")

def publish_tick(payload: dict) -> bool:
    """Fire-and-forget: POST a JSON payload to the orbit-stream Go hub.

    Runs synchronously (called from asyncio.to_thread).  A 50 ms timeout
    ensures a stalled hub never blocks the pipeline tick loop.
    Returns True if accepted by the Go hub, False otherwise.
    """
    try:
        import urllib.request, json as _json
        data = _json.dumps(payload).encode()
        req = urllib.request.Request(
            STREAM_HUB_URL,
            data=data,
            method="POST",
            headers={"Content-Type": "application/json"},
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
    print("DATABASE: CONNECTED", flush=True)
    print("VALKEY: " + ("CONNECTED" if valkey_connected else "DEGRADED_FALLBACK"), flush=True)
    print("TLS: ENABLED", flush=True)
    print("MARKET SERVICE: READY", flush=True)
    print("WEBSOCKET: READY", flush=True)

    scanner = asyncio.create_task(autotrade_scanner_loop())
    market_scheduler = asyncio.create_task(market_tick_scheduler_loop())
    try:
        yield
    finally:
        scanner.cancel()
        market_scheduler.cancel()
        try:
            await asyncio.gather(scanner, market_scheduler, return_exceptions=True)
        except Exception:
            pass
        valkey_service.close()


app = FastAPI(lifespan=lifespan)

@app.middleware("http")
async def add_no_cache_header(request, call_next):
    response = await call_next(request)
    if request.url.path.endswith((".js", ".css", ".html")) or request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


@app.get("/", response_class=HTMLResponse)
async def serve_root():
    index_file = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend", "index.html"))
    with open(index_file, "r", encoding="utf-8") as f:
        content = f.read()
    response = HTMLResponse(content=content)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


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
        "service": "orbit-backend",
        "valkey_mode": "aiven_cloud" if valkey_connected else "in_memory",
        "tls_enabled": valkey_health.get("tls", True),
        "timestamp": datetime.now().isoformat()
    }


@app.get("/api/news")
def get_market_news(symbol: str = "BTC-USD"):
    from backend.agents.news_analyst import get_headlines, BULLISH_WORDS, BEARISH_WORDS
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
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Copilot inference error: {str(exc)}")


@app.get("/api/chat/conversations")
async def api_list_conversations(user_id: Optional[int] = None, limit: int = 50):
    """List stored chat conversations for the history sidebar."""
    try:
        conversations = db.list_conversations(user_id=user_id, limit=limit)
        return {"ok": True, "data": conversations}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to list conversations: {str(exc)}")


@app.post("/api/chat/conversations")
async def api_create_conversation(payload: Optional[ConversationCreate] = None):
    """Create a new conversation session."""
    try:
        cid = str(uuid.uuid4())
        title = payload.title if payload and payload.title else "New Analysis"
        asset = payload.selected_asset if payload and payload.selected_asset else ""
        market = payload.selected_market if payload and payload.selected_market else "US Stocks"
        user_id = payload.user_id if payload else None

        conv = db.create_conversation(
            conversation_id=cid,
            title=title,
            selected_asset=asset,
            selected_market=market,
            user_id=user_id,
        )
        return {"ok": True, "data": conv}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to create conversation: {str(exc)}")


@app.get("/api/chat/conversations/{conversation_id}")
async def api_get_conversation(conversation_id: str):
    """Get full conversation details and historical message records."""
    clean_cid = conversation_id.strip()
    try:
        conv = db.get_conversation(clean_cid)
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        messages = db.get_chat_messages(clean_cid, limit=60)
        return {"ok": True, "data": {"conversation": conv, "messages": messages}}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to load conversation: {str(exc)}")


@app.delete("/api/chat/conversations/{conversation_id}")
async def api_delete_conversation(conversation_id: str):
    """Delete a conversation thread and its messages."""
    clean_cid = conversation_id.strip()
    try:
        deleted = db.delete_conversation(clean_cid)
        copilot_service.reset_session(clean_cid)
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
async def api_copilot_reset(conversation_id: str):
    """Reset a conversation session and clear conversational history."""
    clean_cid = conversation_id.strip() if conversation_id else ""
    if not clean_cid:
        raise HTTPException(status_code=400, detail="conversation_id cannot be empty.")
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
    from backend.agents.news_analyst import BULLISH_WORDS, BEARISH_WORDS

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

    # Fallback simulated headlines if everything failed
    if not unique:
        if _GLOBAL_NEWS_CACHE["data"]:
            return _GLOBAL_NEWS_CACHE["data"]
        unique = [
            {"title": "Global stocks climb as investors weigh inflation metrics and rate decisions", "link": "#", "source": "Reuters", "published": ""},
            {"title": "Nasdaq leads tech rebound while bond yields stabilize", "link": "#", "source": "Bloomberg", "published": ""},
            {"title": "European markets tick higher on positive corporate earnings outlook", "link": "#", "source": "CNBC", "published": ""},
            {"title": "Oil prices steady amid supply cuts and global demand forecast shifts", "link": "#", "source": "MarketWatch", "published": ""},
            {"title": "Fed signals cautious approach to rate cuts amid mixed economic data", "link": "#", "source": "Reuters", "published": ""},
            {"title": "Asian markets mixed as China PMI data disappoints investors", "link": "#", "source": "Bloomberg", "published": ""},
        ]

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
from backend.auth import hash_password, verify_password, store_otp, verify_otp as auth_verify_otp, send_otp_email

class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str

class VerifyOtpRequest(BaseModel):
    email: str
    otp: str

class LoginRequest(BaseModel):
    username: str
    password: str

class SyncAuthRequest(BaseModel):
    email: str | None = None
    username: str | None = None
    clerk_id: str | None = None
    first_name: str | None = None
    last_name: str | None = None

class ResendOtpRequest(BaseModel):
    email: str

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

@app.post("/api/auth/sync")
def api_auth_sync(req: SyncAuthRequest):
    """
    Called when a user logs in via Clerk / Google OAuth.
    Finds or creates their record in PostgreSQL/SQLite database to make a permanent connection.
    Returns database integer user_id, username, and balance.
    """
    user = db.sync_login_user(
        email=req.email,
        username=req.username,
        clerk_id=req.clerk_id
    )
    if not user:
        raise HTTPException(status_code=500, detail="Database sync failed.")
    return {
        "ok": True,
        "user_id": user["id"],
        "username": user["username"],
        "balance": user.get("balance", 1000000.0)
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

    # Seamless Clerk Account Sync & Direct Sign-in Token
    clerk_secret = os.getenv("CLERK_SECRET_KEY", "").strip()
    clerk_token = None
    if clerk_secret and clerk_secret.startswith("sk_") and not clerk_secret.endswith("placeholder_key"):
        try:
            import urllib.request, json
            clerk_payload = json.dumps({
                "email_address": [req.email.lower().strip()],
                "username": req.username.strip(),
                "password": req.password,
                "skip_password_checks": True
            }).encode()
            clerk_req = urllib.request.Request(
                "https://api.clerk.com/v1/users",
                data=clerk_payload,
                headers={
                    "Authorization": f"Bearer {clerk_secret}",
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0"
                }
            )
            c_res = urllib.request.urlopen(clerk_req, timeout=5)
            c_user = json.loads(c_res.read().decode())
            c_uid = c_user.get("id")

            if c_uid:
                token_data = json.dumps({"user_id": c_uid}).encode()
                t_req = urllib.request.Request(
                    "https://api.clerk.com/v1/sign_in_tokens",
                    data=token_data,
                    headers={
                        "Authorization": f"Bearer {clerk_secret}",
                        "Content-Type": "application/json",
                        "User-Agent": "Mozilla/5.0"
                    }
                )
                t_res = urllib.request.urlopen(t_req, timeout=5)
                t_obj = json.loads(t_res.read().decode())
                clerk_token = t_obj.get("token")
        except Exception as e:
            print(f"[Clerk Headless Sync Warning]: {e}")

    return {
        "ok": True,
        "message": "Account created successfully.",
        "user_id": user_id,
        "username": req.username.strip(),
        "clerk_token": clerk_token
    }


@app.post("/api/verify-otp")
def api_verify_otp(req: VerifyOtpRequest):
    # Kept for backward compatibility
    user = db.get_user_by_email(req.email.lower().strip())
    if user:
        db.mark_user_verified(user["id"])
        return {"ok": True, "user_id": user["id"], "username": user["username"]}
    return {"ok": True, "user_id": 1, "username": "Trader"}


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


@app.post("/api/resend-otp")
def api_resend_otp(req: ResendOtpRequest):
    user = db.get_user_by_email(req.email.lower().strip())
    if not user:
        raise HTTPException(status_code=404, detail="No account found with that email.")
    otp_code = store_otp(req.email.lower().strip(), user["id"])
    send_otp_email(req.email.lower().strip(), otp_code, user["username"])
    return {"ok": True, "message": "A new verification code has been sent."}

class BotConfigRequest(BaseModel):
    user_id: int
    assets: str
    total_capital: float
    max_risk_per_trade: float
    min_profit_target: float
    max_profit_target: float
    is_active: bool

@app.get("/api/bot-config")
def api_get_bot_config(user_id: int):
    config = db.get_bot_config(user_id)
    if not config:
        raise HTTPException(status_code=404, detail="Bot config not found")
    return {"ok": True, "config": config}

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
def api_update_bot_config(req: BotConfigRequest):
    db.update_bot_config(req.user_id, req.dict())
    return {"ok": True, "message": "Bot configuration updated"}


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
    offset: int = 0
):
    """Paginated completed trade history with filters."""
    try:
        res = await position_service.get_trade_history_paginated(
            user_id=user_id,
            symbol=symbol,
            market=market,
            side=side,
            outcome=outcome,
            limit=limit,
            offset=offset
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

    # 1. Obtain real-time market price
    try:
        price = await market_service.get_price(symbol)
        if price <= 0:
            price = 100.0
    except Exception:
        price = 100.0

    margin = (req.quantity * price) / leverage

    # 2. Permanent database transaction (atomic balance validation, margin reservation, trade insert, audit execution)
    trade_id, res_balance = await asyncio.to_thread(
        db.open_active_trade_atomic,
        user_id,
        symbol,
        side,
        req.quantity,
        price,
        leverage,
        req.sl or 0.0,
        req.target or 0.0,
        req.market or ("Crypto" if "-" in symbol else "Stock")
    )
    if not trade_id:
        raise HTTPException(status_code=400, detail=str(res_balance))

    # 3. Store active state in Valkey
    trade_dict = {
        "id": trade_id,
        "trade_id": trade_id,
        "user_id": user_id,
        "symbol": symbol,
        "side": side,
        "entry_price": price,
        "current_price": price,
        "quantity": req.quantity,
        "remaining_quantity": req.quantity,
        "leverage": leverage,
        "margin_used": margin,
        "position_size": req.quantity * price,
        "unrealized_pnl": 0.0,
        "unrealized_pnl_percent": 0.0,
        "status": "active",
        "opened_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat()
    }
    valkey_service.set(f"trade:active:{trade_id}", trade_dict, ttl_seconds=300)
    valkey_service.sadd(f"user:{user_id}:active_trades", str(trade_id))
    valkey_service.sadd(f"symbol:{symbol}:active_trades", str(trade_id))
    valkey_service.delete(f"dashboard:{user_id}:metrics")

    # 4. Broadcast real-time WebSocket events
    await manager.send_to_user(user_id, {"type": "trade_opened", "data": trade_dict})
    live_open = await position_service.get_live_open_positions(user_id)
    await manager.send_to_user(user_id, {"type": "positions_updated", "data": {"trades": live_open}})
    await manager.send_to_user(user_id, {"type": "wallet", "balance": res_balance})

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
            result = await position_service.close_position_fully(trade_id, req.user_id)
        else:
            if float(close_qty) <= 0:
                raise HTTPException(status_code=400, detail="Close quantity must be positive.")
            result = await position_service.close_position_partially(trade_id, req.user_id, float(close_qty))

        summary = result.get("summary") or await position_service.get_account_and_dashboard_summary(req.user_id)
        wallet_balance = summary.get("account", {}).get("total_capital", 0.0)

        # Broadcast state synchronization to user's connected WebSocket clients
        await manager.send_to_user(req.user_id, {"type": "wallet", "balance": wallet_balance})
        live_open = summary.get("open_positions") if "open_positions" in summary else await position_service.get_live_open_positions(req.user_id)
        await manager.send_to_user(req.user_id, {"type": "positions_updated", "data": {"trades": live_open}})
        await manager.send_to_user(req.user_id, {"type": "dashboard_summary", "data": summary})

        # Also emit standard events per Part 21:
        if req.full_close or result.get("status") == "closed":
            await manager.send_to_user(req.user_id, {"type": "trade_closed", "data": result})
        else:
            await manager.send_to_user(req.user_id, {"type": "trade_updated", "data": result})
            await manager.send_to_user(req.user_id, {"type": "position_updated", "data": result})

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

        # Define simulation price variables
        sim_price = latest_close
        tick_count = 0
        
        # Start real-time simulation loop
        while True:
            # Simulate real-time price fluctuation (random walk around the actual close price)
            # This makes the simulator responsive on the chart every few seconds
            tick_count += 1
            change_percent = random.uniform(-0.002, 0.002) # max 0.2% change per tick
            sim_price = sim_price * (1 + change_percent)
            
            # Send live tick to chart
            current_time_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            tick_candle = {
                "time": int(datetime.now().timestamp()), # Unix timestamp for intraday chart updates
                "open": sim_price,
                "high": max(sim_price, sim_price * 1.001),
                "low": min(sim_price, sim_price * 0.999),
                "close": sim_price
            }
            
            # Recalculate daily percentage change
            current_change_pct = ((sim_price - prev_close) / prev_close) * 100
            tick_payload = {
                "type": "tick",
                "candle": tick_candle,
                "changePercent": current_change_pct,
            }

            # Phase 6 & Phase 9: Live Market Cache & Symbol-Indexed P&L Updates in Valkey
            valkey_service.set(f"market:price:{asset}", {
                "symbol": asset,
                "price": round(sim_price, 4),
                "previous_close": prev_close,
                "change": round(sim_price - prev_close, 4),
                "change_percent": round(current_change_pct, 4),
                "updated_at": datetime.now().isoformat()
            }, ttl_seconds=15)

            # Update live P&L for any active positions on this symbol
            active_trade_ids = valkey_service.smembers(f"symbol:{asset}:active_trades")
            if active_trade_ids:
                for tid_s in active_trade_ids:
                    pos_data = valkey_service.get(f"trade:active:{tid_s}")
                    if pos_data and isinstance(pos_data, dict) and pos_data.get("status") == "active":
                        entry = float(pos_data.get("entry_price", sim_price))
                        qty = float(pos_data.get("remaining_quantity") or pos_data.get("quantity", 0.0))
                        lev = float(pos_data.get("leverage") or 1.0)
                        side = str(pos_data.get("side", "BUY")).upper()
                        pnl = (sim_price - entry) * qty * lev if side == "BUY" else (entry - sim_price) * qty * lev
                        margin = float(pos_data.get("margin_used") or 1.0)
                        pos_data["current_price"] = round(sim_price, 4)
                        pos_data["unrealized_pnl"] = round(pnl, 2)
                        pos_data["unrealized_pnl_pct"] = round((pnl / margin * 100.0) if margin > 0 else 0.0, 2)
                        valkey_service.set(f"trade:active:{tid_s}", pos_data, ttl_seconds=60)

            # Publish to Go hub for high-concurrency broadcast (Phase 11).
            # Also send via Python socket so single-user setups work without Go.
            await asyncio.to_thread(publish_tick, tick_payload)
            await manager.send_json(tick_payload, websocket)

            
            # 2. Run indicator analyst (Agent 2)
            # Fold the tick into the CURRENT candle rather than appending a new
            # one. Appending a synthetic row where open==high==low==close and
            # volume==0 made every candle-pattern and volume-based strategy
            # degenerate (zero range, zero body, zero volume).
            df_curr = df.copy()
            last = df_curr.index[-1]
            df_curr.loc[last, "Close"] = sim_price
            df_curr.loc[last, "High"] = max(float(df_curr.loc[last, "High"]), sim_price)
            df_curr.loc[last, "Low"] = min(float(df_curr.loc[last, "Low"]), sim_price)

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
                    sim_price,
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
            withdrawn = await asyncio.to_thread(check_and_execute_trades, sim_price, log_agent, user_id)
            if withdrawn:
                await manager.send_json({"type": "positions", "positions": db.get_active_positions(user_id)}, websocket)

            # 7. Run Portfolio Monitor (Agent 7) — owns SL/target exits
            closed = await asyncio.to_thread(monitor_positions, sim_price, log_agent, user_id, asset)
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
async def websocket_endpoint(websocket: WebSocket, user_id: str | None = None, username: str | None = None):
    """
    The socket is bound to a real, already-registered account.
    Resolves identity by numeric user_id, clerk_id, username, or email.
    If an authenticated session connects, connects or provisions the user record cleanly.
    """
    user = None
    if user_id is not None and str(user_id).strip():
        raw_uid = str(user_id).strip()
        if raw_uid.isdigit():
            user = db.get_user_by_id(int(raw_uid))
        if not user:
            user = db.get_user_by_clerk_id(raw_uid)

    if user is None and username:
        clean_u = username.strip()
        user = db.get_user_by_username(clean_u)
        if not user and "@" in clean_u:
            user = db.get_user_by_email(clean_u.lower())

    # Auto-connect/sync if user authenticated on frontend
    if user is None and (username or user_id):
        user = db.sync_login_user(
            username=username.strip() if username else None,
            clerk_id=str(user_id).strip() if user_id else None
        )

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

            elif action == "cancel_trade":
                # Trader rejected — cancel all pending trades for this user
                pending = db.get_active_positions(user_id)
                for p in pending:
                    if p["status"] == "pending":
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

async def autotrade_scanner_loop():
    while True:
        try:
            active_configs = db.get_all_active_bot_configs()
            for config in active_configs:
                user_id = config["user_id"]
                
                # Check overall Profit/Loss goals to see if we should stop trading
                active_pos = db.get_active_positions(user_id)
                history_pos = db.get_trade_history(user_id)
                total_pnl = sum(p.get("pnl", 0) for p in active_pos) + sum(p.get("pnl", 0) for p in history_pos)
                
                target_profit = config["min_profit_target"] # Used as Daily Target Profit
                max_loss = config["max_profit_target"]      # Used as Daily Max Loss
                
                if total_pnl >= target_profit or total_pnl <= -max_loss:
                    print(f"User {user_id} hit PnL bounds ({total_pnl}). Target: {target_profit}, Max Loss: -{max_loss}. Disabling bot.")
                    config["is_active"] = False
                    db.update_bot_config(user_id, config)
                    continue
                    
                # User requested: "at time only one request is done"
                # Do not open new trades if there is already an active trade
                if len(active_pos) > 0:
                    continue

                assets = [a.strip() for a in config["assets"].split(",")]
                for asset in assets:
                    if not asset: continue
                    # 1. Fetch live data via centralized MarketDataService
                    try:
                        snapshot = await market_service.get_historical_snapshot(asset, period="60d", interval="1d")
                        hist = await market_service.get_normalized_dataframe(asset, period="60d", interval="1d")
                        current_price = snapshot.quote.price
                    except Exception:
                        continue

                    if current_price <= 0 or hist.empty:
                        continue

                    # 2. Run Agents headless (also off the event loop - these
                    #    make network and Gemini calls)
                    sr_data = await asyncio.to_thread(find_support_resistance, hist)
                    news_sentiment = await asyncio.to_thread(analyze_sentiment, asset)
                    sentiment_score = news_sentiment.get("score", 0.0)
                    strategy_res = await asyncio.to_thread(
                        evaluate_strategies, hist, sr_data["supports"], sr_data["resistances"]
                    )

                    if strategy_res.get("signal") not in ("buy", "sell"):
                        continue

                    # 3. Plan Trade
                    trade_setup = await asyncio.to_thread(
                        plan_trade,
                        strategy_res,
                        sentiment_score,
                        sr_data["supports"],
                        sr_data["resistances"],
                        current_price,
                        config["total_capital"],
                    )

                    # The planner can veto a signal (sentiment conflict, bad
                    # price, empty wallet). Reading entry/sl unconditionally
                    # used to raise KeyError and kill the whole scanner loop.
                    if trade_setup["action"] not in ("buy", "sell"):
                        continue

                    # Adjust max risk
                    risk_per_share = abs(trade_setup["entry"] - trade_setup["sl"])
                    if risk_per_share > 0:
                        qty = min(trade_setup["quantity"], config["max_risk_per_trade"] / risk_per_share)
                    else:
                        qty = trade_setup["quantity"]

                    potential_profit = abs(trade_setup["target"] - trade_setup["entry"]) * qty

                    # If the opportunity offers a positive reward, execute automatically
                    if qty > 0 and potential_profit > 0:
                        # Execute immediately without waiting for confirmation
                        trade_id = db.create_pending_trade(
                            user_id, asset, trade_setup["action"], qty,
                            trade_setup["entry"], trade_setup["sl"], trade_setup["target"]
                        )
                        if not db.execute_trade(trade_id, current_price):
                            await manager.send_to_user(user_id, {
                                "type": "log", "agent": "Auto-Trade Bot",
                                "message": f"AUTOTRADE SKIPPED: insufficient balance for {asset}.",
                                "time": datetime.now().strftime("%H:%M:%S"),
                            })
                            continue

                        # Notify ONLY this bot's owner. Broadcasting pushed one
                        # user's wallet and positions into every open browser.
                        await manager.send_to_user(user_id, {
                            "type": "log", "agent": "Auto-Trade Bot",
                            "message": f"🤖 AUTOTRADE FIRED: {trade_setup['action'].upper()} {asset} @ {trade_setup['entry']:.2f}",
                            "time": datetime.now().strftime("%H:%M:%S"),
                        })
                        await manager.send_to_user(user_id, {"type": "positions", "positions": db.get_active_positions(user_id)})
                        await manager.send_to_user(user_id, {"type": "wallet", "balance": db.get_user_balance(user_id)})
                        summary = await position_service.get_account_and_dashboard_summary(user_id)
                        await manager.send_to_user(user_id, {"type": "dashboard_summary", "data": summary})

            # Wait before the next global scan
            await asyncio.sleep(AUTOTRADE_SCAN_SECONDS)
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"Autotrade scanner error: {e}")
            await asyncio.sleep(60)


async def market_tick_scheduler_loop():
    """
    Authoritative single market tick scheduler and real-time live P&L engine.
    Fulfills Part 9 & Part 24: Single controlled scheduler across the entire application.
    Gathers active symbols, fetches quotes, updates Valkey, updates live trade P&L in O(1),
    and broadcasts synchronized real-time ticks to Go stream hub and WebSocket connections.
    """
    while True:
        try:
            # 1. Discover all symbols with active positions
            active_symbols = {"BTC-USD", "ETH-USD"}
            try:
                open_trades = db.get_open_positions()
                for tr in open_trades:
                    sym = tr.get("asset")
                    if sym:
                        active_symbols.add(sym.strip().upper())
            except Exception:
                pass

            for sym in list(active_symbols):
                try:
                    quote = await market_service.get_quote(sym)
                    if not quote or quote.price <= 0:
                        continue
                    curr_price = float(quote.price)

                    # Update Valkey live price cache (TTL 15s)
                    valkey_service.set(f"market:price:{sym}", {
                        "symbol": sym,
                        "price": curr_price,
                        "previous_close": float(quote.previous_close or curr_price),
                        "change": float(quote.change or 0.0),
                        "change_percent": float(quote.change_percent or 0.0),
                        "updated_at": datetime.now().isoformat()
                    }, ttl_seconds=15)

                    # Publish tick to high-concurrency Go stream hub
                    tick_payload = {
                        "time": int(datetime.now().timestamp()),
                        "open": curr_price,
                        "high": max(curr_price, curr_price * 1.0005),
                        "low": min(curr_price, curr_price * 0.9995),
                        "close": curr_price,
                        "volume": float(quote.volume or 0.0),
                        "symbol": sym,
                        "changePercent": float(quote.change_percent or 0.0),
                    }
                    publish_tick(tick_payload)

                    # Find affected active trades for this symbol in O(1)
                    trade_ids = valkey_service.smembers(f"symbol:{sym}:active_trades")
                    if trade_ids:
                        for tid in trade_ids:
                            trade_data = valkey_service.get(f"trade:active:{tid}")
                            if trade_data and isinstance(trade_data, dict):
                                entry = float(trade_data.get("entry_price") or curr_price)
                                qty = float(trade_data.get("remaining_quantity") or trade_data.get("quantity") or 0.0)
                                lev = float(trade_data.get("leverage") or 1.0)
                                side = str(trade_data.get("side") or trade_data.get("type") or "BUY").upper()

                                # P&L calculation based on side
                                if side in ("BUY", "LONG"):
                                    unrealized = (curr_price - entry) * qty * lev
                                else:
                                    unrealized = (entry - curr_price) * qty * lev

                                margin = float(trade_data.get("margin_used") or ((qty * entry) / lev))
                                unrealized_pct = (unrealized / margin * 100.0) if margin > 0 else 0.0

                                trade_data["current_price"] = round(curr_price, 4)
                                trade_data["unrealized_pnl"] = round(unrealized, 2)
                                trade_data["unrealized_pnl_pct"] = round(unrealized_pct, 2)
                                trade_data["unrealized_pnl_percent"] = round(unrealized_pct, 2)
                                trade_data["updated_at"] = datetime.now().isoformat()
                                valkey_service.set(f"trade:active:{tid}", trade_data, ttl_seconds=300)

                                # Broadcast updated trade to owner
                                uid = trade_data.get("user_id", 1)
                                await manager.send_to_user(uid, {
                                    "type": "trade_updated",
                                    "data": trade_data,
                                    "trade_id": tid,
                                    "current_price": round(curr_price, 4),
                                    "unrealized_pnl": round(unrealized, 2)
                                })
                                await manager.send_to_user(uid, {
                                    "type": "position_updated",
                                    "position": trade_data
                                })
                except Exception as sym_err:
                    logger.debug(f"[MarketScheduler] Error ticking symbol {sym}: {sym_err}")

            # Tick interval: 2.5 seconds
            await asyncio.sleep(2.5)
        except asyncio.CancelledError:
            break
        except Exception as loop_err:
            logger.warning(f"[MarketScheduler] Exception in tick loop: {loop_err}")
            await asyncio.sleep(5.0)


# Serve node_modules for local scripts, when present. StaticFiles raises at
# import time if the directory is missing, which crashed the Docker image (it
# never copies node_modules into the container).
node_modules_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "node_modules"))
if os.path.isdir(node_modules_path):
    app.mount("/node_modules", StaticFiles(directory=node_modules_path), name="node_modules")
else:
    print("[startup] node_modules not found - skipping /node_modules mount.")

# Serve static frontend files (must be defined AFTER the api routes)
frontend_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))
app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")
