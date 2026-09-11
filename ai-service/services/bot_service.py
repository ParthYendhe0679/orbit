"""
backend/services/bot_service.py — ORBIT Auto-Trade Bot engine.

Division of labour
  * Go (backend/botsched) owns concurrency and scheduling: one goroutine per
    session so a session's steps never overlap, a bounded worker pool,
    per-symbol single-flight analysis shared by every session, a leader lease
    across gateway replicas and graceful stop. It drives this engine through
    the /internal/bot/* endpoints, one step per call.
  * This module performs a single step when asked: session state transitions,
    the analysis stack (Brain -> Risk Guard -> Opportunity -> Decision), the
    Risk Guard entry gate, Risk Planner sizing, execution through
    PositionService and protective SL/target supervision through the P&L
    Manager. It runs no loops and keeps no in-process state between calls
    (analyses are handed between steps through Valkey).
  * PostgreSQL is the source of truth. Every entry is re-checked inside the
    trade-opening transaction (database._bot_entry_refusal), so correctness
    never depends on the scheduler's timing.
"""

import asyncio
import logging
import math
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Awaitable, Callable, Dict, List, Optional

import backend.database as db
from backend.models.bot import BotEventType, ENTRY_STATES, LIVE_STATES
from backend.models.brain import BrainAnalysisContext
from backend.models.decision import DecisionEvaluationResult
from backend.models.opportunity import OpportunityEvaluationResult
from backend.models.risk import RiskEvaluationResult
from backend.services.market_data_service import POPULAR_SYMBOLS, market_service
from backend.services.orbit_brain import orbit_brain
from backend.services.risk_guard import risk_guard
from backend.services.opportunity_engine import opportunity_engine
from backend.services.decision_engine import decision_engine
from backend.services.position_service import position_service
from backend.services.valkey_service import valkey_service
from backend.agents.chart_analyst import find_support_resistance
from backend.agents.news_analyst import analyze_sentiment
from backend.agents.risk_planner import plan_trade
from backend.agents.portfolio_monitor import monitor_positions

logger = logging.getLogger("orbit.bot")

ENTRY = frozenset(s.value for s in ENTRY_STATES)
LIVE = frozenset(s.value for s in LIVE_STATES)

LEADER_LEASE_KEY = "bot:scheduler:leader"
HEARTBEAT_KEY = "bot:scheduler:heartbeat"
ACTIVITY_MAX_EVENTS = 300
ACTIVITY_TTL_SECONDS = 7 * 24 * 3600

# Categories the product has referenced but the market-data universe does not
# cover yet. Shown as unavailable instead of pretending to support them.
UNSUPPORTED_CATEGORIES = [
    {"id": "Commodities", "reason": "No commodity symbols in the market-data universe yet."},
]


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


def _env_tuple(name: str, default: tuple, cast=str) -> tuple:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return tuple(cast(x.strip()) for x in raw.split(",") if x.strip())
    except ValueError:
        return default


def _r(value: Any, digits: int = 2) -> float:
    try:
        return round(float(value), digits)
    except (TypeError, ValueError):
        return 0.0


@dataclass(frozen=True)
class BotPolicy:
    """
    Bot tunables. Entries marked TBD reuse the existing engines' categorical
    outputs as placeholders; their final values are a product decision and can
    be overridden through the environment.
    """
    scan_interval_seconds: float = 180.0     # Previous AUTOTRADE_SCAN_SECONDS; keeps news/LLM/market-data quotas.
    tick_seconds: float = 10.0               # Supervision cadence: SL/target exits, limit checks, live metrics.
    analysis_ttl_seconds: float = 170.0      # Window in which sessions share one analysis of a symbol.
    max_concurrency: int = 8                 # Parallel engine steps the Go scheduler may run.
    blocked_risk_levels: tuple = ("CRITICAL",)          # TBD
    min_decision_clarity: str = "MODERATE"              # TBD
    min_opportunity_level: str = "MODERATE"             # TBD
    max_loss_basis: str = "realized_plus_unrealized"    # TBD — alternative: "realized"
    supported_leverage: tuple = (1.0, 2.0, 3.0, 5.0)    # TBD — the engine itself accepts any value >= 1
    protect_positions_after_stop: bool = True           # TBD — keep enforcing SL/target after the bot stops

    @classmethod
    def from_env(cls) -> "BotPolicy":
        d = cls()
        scan = max(30.0, _env_float("BOT_SCAN_INTERVAL_SECONDS", d.scan_interval_seconds))
        basis = os.getenv("BOT_MAX_LOSS_BASIS", d.max_loss_basis).strip().lower()
        if basis not in ("realized", "realized_plus_unrealized"):
            basis = d.max_loss_basis
        return cls(
            scan_interval_seconds=scan,
            tick_seconds=max(2.0, _env_float("BOT_TICK_SECONDS", d.tick_seconds)),
            analysis_ttl_seconds=max(10.0, _env_float("BOT_ANALYSIS_TTL_SECONDS", scan - 10.0)),
            max_concurrency=max(1, int(_env_float("BOT_MAX_CONCURRENCY", d.max_concurrency))),
            blocked_risk_levels=_env_tuple("BOT_BLOCKED_RISK_LEVELS", d.blocked_risk_levels, str.upper),
            min_decision_clarity=os.getenv("BOT_MIN_DECISION_CLARITY", d.min_decision_clarity).strip().upper(),
            min_opportunity_level=os.getenv("BOT_MIN_OPPORTUNITY_LEVEL", d.min_opportunity_level).strip().upper(),
            max_loss_basis=basis,
            supported_leverage=_env_tuple("BOT_SUPPORTED_LEVERAGE", d.supported_leverage, float),
            protect_positions_after_stop=os.getenv("BOT_PROTECT_POSITIONS_AFTER_STOP", "true").strip().lower() in ("1", "true", "yes"),
        )

    def public(self) -> Dict[str, Any]:
        return {
            "scan_interval_seconds": self.scan_interval_seconds,
            "tick_seconds": self.tick_seconds,
            "supported_leverage": list(self.supported_leverage),
            "max_loss_basis": self.max_loss_basis,
            "protect_positions_after_stop": self.protect_positions_after_stop,
            "blocked_risk_levels": list(self.blocked_risk_levels),
            "min_decision_clarity": self.min_decision_clarity,
            "min_opportunity_level": self.min_opportunity_level,
        }


# ===========================================================================
# Market universe & configuration validation
# ===========================================================================

def market_universe() -> List[Dict[str, Any]]:
    """
    Categories and symbols the bot may trade: exactly the curated universe the
    MarketDataService already serves (POPULAR_SYMBOLS), plus categories that
    are known but not supported yet.
    """
    categories: Dict[str, List[Dict[str, str]]] = {}
    for item in POPULAR_SYMBOLS:
        categories.setdefault(item["category"], []).append({
            "symbol": item["symbol"], "name": item["name"], "exchange": item.get("exchange", ""),
        })
    out = [{"id": cat, "label": cat, "supported": True, "reason": None, "assets": assets}
           for cat, assets in categories.items()]
    out += [{"id": u["id"], "label": u["id"], "supported": False, "reason": u["reason"], "assets": []}
            for u in UNSUPPORTED_CATEGORIES]
    return out


class BotConfigError(ValueError):
    def __init__(self, message: str, field: Optional[str] = None):
        super().__init__(message)
        self.field = field


def validate_bot_config(market_category, assets, allocated_capital, target_profit, max_loss, leverage,
                        available_balance: float, policy: BotPolicy) -> Dict[str, Any]:
    """Authoritative server-side validation of a bot configuration."""
    categories = {c["id"].lower(): c for c in market_universe()}
    cat = categories.get(str(market_category or "").strip().lower())
    if not cat:
        raise BotConfigError(f"Unsupported market category '{market_category}'.", "market_category")
    if not cat["supported"]:
        raise BotConfigError(f"{cat['label']} is not supported by the market-data system yet.", "market_category")

    if isinstance(assets, str):
        assets = assets.split(",")
    clean: List[str] = []
    for a in assets or []:
        sym = str(a).strip().upper()
        if sym and sym not in clean:
            clean.append(sym)
    if not clean:
        raise BotConfigError("Select at least one asset.", "assets")
    allowed = {x["symbol"].upper() for x in cat["assets"]}
    outside = [s for s in clean if s not in allowed]
    if outside:
        raise BotConfigError(f"Not in the supported {cat['label']} universe: {', '.join(outside)}.", "assets")

    def positive(name: str, value: Any) -> float:
        try:
            f = float(value)
        except (TypeError, ValueError):
            raise BotConfigError(f"{name.replace('_', ' ').capitalize()} must be a number.", name)
        if not math.isfinite(f) or f <= 0:
            raise BotConfigError(f"{name.replace('_', ' ').capitalize()} must be greater than zero.", name)
        return f

    capital = positive("allocated_capital", allocated_capital)
    if capital > float(available_balance) + 1e-9:
        raise BotConfigError(
            f"Allocated capital {capital:,.2f} exceeds available balance {float(available_balance):,.2f}.",
            "allocated_capital",
        )
    target = positive("target_profit", target_profit)
    loss = positive("max_loss", max_loss)
    lev = positive("leverage", leverage)
    if not any(abs(lev - s) < 1e-9 for s in policy.supported_leverage):
        allowed_lev = ", ".join(f"{s:g}x" for s in policy.supported_leverage)
        raise BotConfigError(f"Leverage {lev:g}x is not supported. Allowed: {allowed_lev}.", "leverage")

    return {"market_category": cat["id"], "assets": clean, "allocated_capital": capital,
            "target_profit": target, "max_loss": loss, "leverage": lev}


# ===========================================================================
# Analysis (one run of the existing ORBIT stack for a symbol)
# ===========================================================================

async def run_asset_analysis(symbol: str) -> Dict[str, Any]:
    """
    Run the existing stack once and return a JSON-serializable record:
    MarketDataService -> ORBIT Brain (agents + strategies + consensus) ->
    Risk Guard -> Opportunity Engine -> Decision Engine, plus the Levels and
    News analysts the Risk Planner needs. Nothing is recomputed downstream.
    """
    t0 = time.perf_counter()
    rec: Dict[str, Any] = {"symbol": symbol, "ok": False, "error": None, "created_at": time.time()}
    try:
        snapshot = await market_service.get_historical_snapshot(symbol, period="60d", interval="1d")
        df = await market_service.get_normalized_dataframe(symbol, period="60d", interval="1d")
    except Exception as exc:
        rec["error"] = f"Market data unavailable: {exc}"
        return rec
    rec.update(price=float(snapshot.quote.price), candles=int(snapshot.count),
               data_source=snapshot.source, data_age_seconds=float(snapshot.data_age_seconds or 0.0))
    try:
        brain = await orbit_brain.synthesize_analysis(symbol, timeframe="1d", df=df)
        risk = await risk_guard.evaluate_risk(symbol, "1d", brain_context=brain, df=df)
        opp = await opportunity_engine.evaluate_opportunity(symbol, "1d", brain_context=brain, risk_result=risk, df=df)
        decision = await decision_engine.evaluate_decision(
            symbol, "1d", brain_context=brain, risk_result=risk, opp_result=opp, df=df)
        # Inputs of the existing Risk Planner. analyze_sentiment is served from
        # the cache the Brain's SentimentAgent has just filled.
        sr = await asyncio.to_thread(find_support_resistance, df)
        sentiment = await asyncio.to_thread(analyze_sentiment, symbol)
    except Exception as exc:
        logger.exception(f"[Bot] Analysis failed for {symbol}")
        rec["error"] = f"Analysis failed: {exc}"
        return rec
    rec.update(
        ok=True,
        brain=brain.model_dump(mode="json"),
        risk=risk.model_dump(mode="json"),
        opportunity=opp.model_dump(mode="json"),
        decision=decision.model_dump(mode="json"),
        supports=[float(x) for x in sr.get("supports", [])],
        resistances=[float(x) for x in sr.get("resistances", [])],
        sentiment_score=float(sentiment.get("score", 0.0) or 0.0),
        latency_ms=round((time.perf_counter() - t0) * 1000.0, 1),
    )
    return rec


# ===========================================================================
# Engine
# ===========================================================================

Publisher = Callable[[int, Dict[str, Any]], Awaitable[None]]


class BotEngine:
    def __init__(
        self,
        publish: Optional[Publisher] = None,
        analyzer: Optional[Callable[[str], Awaitable[Dict[str, Any]]]] = None,
        price_fn: Optional[Callable[[str], Awaitable[float]]] = None,
        policy: Optional[BotPolicy] = None,
    ):
        self.publish = publish
        self.analyzer = analyzer or run_asset_analysis
        self.price_fn = price_fn or market_service.get_price
        self.policy = policy or BotPolicy.from_env()

    # ---------------------------------------------------------------- events

    async def _send(self, user_id: int, message: Dict[str, Any]) -> None:
        if self.publish is None:
            return
        try:
            await self.publish(int(user_id), message)
        except Exception as exc:
            logger.warning(f"[Bot] Could not publish to user {user_id}: {exc}")

    async def emit(self, session: Dict[str, Any], event: BotEventType, message: str, *,
                   symbol: Optional[str] = None, level: str = "info", data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Record an activity event for the session and stream it to its owner."""
        evt = {
            "event": event.value,
            "session_id": session["id"],
            "symbol": symbol,
            "level": level,
            "message": message,
            "data": data or {},
            "ts": datetime.now().isoformat(),
        }
        try:
            await asyncio.to_thread(valkey_service.lpush_capped, f"bot:activity:{session['id']}", evt,
                                    ACTIVITY_MAX_EVENTS, ACTIVITY_TTL_SECONDS)
        except Exception as exc:
            logger.warning(f"[Bot] Could not record activity: {exc}")
        await self._send(session["user_id"], {"type": "bot_event", **evt})
        return evt

    async def push_snapshot(self, session: Dict[str, Any]) -> Dict[str, Any]:
        snap = await self.snapshot(session)
        await self._send(session["user_id"], {"type": "bot_session_updated", "data": snap})
        return snap

    async def _terminal_log(self, user_id: int, message: str) -> None:
        # The terminal console has always shown bot activity as "Auto-Trade Bot" log lines.
        await self._send(user_id, {"type": "log", "agent": "Auto-Trade Bot", "message": message,
                                   "time": datetime.now().strftime("%H:%M:%S")})

    async def _publish_portfolio(self, user_id: int, opened: Optional[Dict[str, Any]] = None,
                                 closed: Optional[Dict[str, Any]] = None) -> None:
        """Existing portfolio events, so the dashboard and Manage Trades refresh too."""
        if opened:
            await self._send(user_id, {"type": "trade_opened", "data": opened})
        if closed:
            await self._send(user_id, {"type": "trade_closed", "data": closed})
        try:
            live_open = await position_service.get_live_open_positions(user_id)
            await self._send(user_id, {"type": "positions_updated", "data": {"trades": live_open}})
            balance = await asyncio.to_thread(db.get_user_balance, user_id)
            await self._send(user_id, {"type": "wallet", "balance": balance})
            summary = await position_service.get_account_and_dashboard_summary(user_id)
            await self._send(user_id, {"type": "dashboard_summary", "data": summary})
        except Exception as exc:
            logger.warning(f"[Bot] Portfolio refresh failed for user {user_id}: {exc}")

    # ------------------------------------------------------------ transitions

    async def _transition(self, session: Dict[str, Any], new_status: str, from_statuses, *,
                          reason: Optional[str] = None, error: Optional[str] = None,
                          stopped: bool = False) -> bool:
        """Compare-and-set the status in the database; emit STATE_CHANGED when it applied."""
        old = session["status"]
        if old == new_status and old in from_statuses:
            return True
        ok = await asyncio.to_thread(db.transition_bot_session, session["id"], new_status, tuple(from_statuses),
                                     stop_reason=reason, last_error=error, mark_stopped=stopped)
        if not ok:
            fresh = await asyncio.to_thread(db.get_bot_session, session["id"])
            if fresh:
                session.update(fresh)
            return False
        # Mirror what the UPDATE wrote so snapshots built from this dict are current.
        now_iso = datetime.now().isoformat()
        session.update(status=new_status, updated_at=now_iso)
        if reason is not None:
            session["stop_reason"] = reason
        if error is not None:
            session["last_error"] = error
        if stopped:
            session["stopped_at"] = now_iso
        await self.emit(session, BotEventType.STATE_CHANGED, f"Bot state {old} → {new_status}",
                        level="error" if new_status == "ERROR" else "info",
                        data={"from": old, "to": new_status, "reason": reason})
        return True

    def _limit_breach(self, snap: Dict[str, Any]) -> Optional[str]:
        if snap["realized_pnl"] >= snap["target_profit"]:
            return "TARGET_REACHED"
        if snap["loss_basis_pnl"] <= -snap["max_loss"]:
            return "MAX_LOSS_REACHED"
        return None

    async def _enter_limit_state(self, session: Dict[str, Any], breach: str, snap: Dict[str, Any]) -> None:
        if breach == "TARGET_REACHED":
            reason = f"Realized session P&L {snap['realized_pnl']:,.2f} reached the target {snap['target_profit']:,.2f}."
            event, level = BotEventType.TARGET_REACHED, "success"
        else:
            reason = (f"Session P&L {snap['loss_basis_pnl']:,.2f} ({self.policy.max_loss_basis.replace('_', ' ')}) "
                      f"reached the loss limit -{snap['max_loss']:,.2f}.")
            event, level = BotEventType.MAX_LOSS_REACHED, "error"
        if await self._transition(session, breach, ENTRY, reason=reason, stopped=True):
            await self.emit(session, event, reason + " New entries and scanning have stopped; open positions are kept.",
                            level=level, data={"realized_pnl": snap["realized_pnl"], "total_pnl": snap["total_pnl"],
                                               "open_trades": snap["open_trades"]})
            await self._terminal_log(session["user_id"], f"{breach.replace('_', ' ')}: {reason}")

    # --------------------------------------------------------------- metrics

    def _seconds_until_scan(self, session: Dict[str, Any]) -> float:
        if session["status"] == "STARTING" or not session.get("last_scan_at"):
            return 0.0
        try:
            last = datetime.fromisoformat(session["last_scan_at"])
        except ValueError:
            return 0.0
        return max(0.0, self.policy.scan_interval_seconds - (datetime.now() - last).total_seconds())

    def scheduler_online(self) -> bool:
        try:
            return bool(valkey_service.get(HEARTBEAT_KEY))
        except Exception:
            return False

    async def snapshot(self, session: Dict[str, Any]) -> Dict[str, Any]:
        """Live view of a session. Everything numeric is derived from its trades."""
        # Independent reads (each a database round trip): run them together.
        agg, positions = await asyncio.gather(
            asyncio.to_thread(db.get_bot_session_aggregates, session["id"]),
            position_service.get_live_open_positions(session["user_id"]),
        )
        active: List[Dict[str, Any]] = [p for p in positions if p.get("bot_session_id") == session["id"]]
        unrealized = sum(float(p.get("unrealized_pnl") or 0.0) for p in active)
        realized = agg["realized_pnl"]
        total = realized + unrealized
        loss_basis_pnl = total if self.policy.max_loss_basis == "realized_plus_unrealized" else realized
        allocated = float(session["allocated_capital"])
        target = float(session["target_profit"])
        max_loss = float(session["max_loss"])
        session_loss = max(0.0, -loss_basis_pnl)
        status = session["status"]
        return {
            "id": session["id"],
            "user_id": session["user_id"],
            "status": status,
            "is_live": status in LIVE,
            "entries_allowed": status in ENTRY,
            "market_category": session["market_category"],
            "assets": session["assets"],
            "leverage": float(session["leverage"]),
            "allocated_capital": _r(allocated),
            "used_capital": _r(agg["used_capital"]),
            "available_bot_capital": _r(max(0.0, allocated - agg["used_capital"])),
            "target_profit": _r(target),
            "max_loss": _r(max_loss),
            "realized_pnl": _r(realized),
            "unrealized_pnl": _r(unrealized),
            "total_pnl": _r(total),
            "loss_basis": self.policy.max_loss_basis,
            "loss_basis_pnl": _r(loss_basis_pnl),
            "session_loss": _r(session_loss),
            "target_progress_pct": _r(min(100.0, max(0.0, realized / target * 100.0)) if target > 0 else 0.0, 1),
            "loss_progress_pct": _r(min(100.0, session_loss / max_loss * 100.0) if max_loss > 0 else 0.0, 1),
            "total_trades": agg["total_trades"],
            "winning_trades": agg["winning_trades"],
            "losing_trades": agg["losing_trades"],
            "open_trades": agg["open_trades"],
            "scan_count": int(session.get("scan_count") or 0),
            "last_scan_at": session.get("last_scan_at"),
            "next_scan_in_seconds": _r(self._seconds_until_scan(session), 0) if status in ENTRY else None,
            "stop_reason": session.get("stop_reason"),
            "last_error": session.get("last_error"),
            "started_at": session.get("started_at"),
            "stopped_at": session.get("stopped_at"),
            "created_at": session.get("created_at"),
            "updated_at": session.get("updated_at"),
            "active_trades": active,
            "scheduler_online": self.scheduler_online(),
        }

    # ------------------------------------------------------- user lifecycle

    async def start_session(self, user_id: int, cfg: Dict[str, Any]) -> Dict[str, Any]:
        """Validate and create a session. Raises BotConfigError / db.BotSessionConflictError / ValueError."""
        balance = await asyncio.to_thread(db.get_user_balance, user_id)
        clean = validate_bot_config(cfg.get("market_category"), cfg.get("assets"), cfg.get("allocated_capital"),
                                    cfg.get("target_profit"), cfg.get("max_loss"), cfg.get("leverage", 1.0),
                                    balance, self.policy)
        session = await asyncio.to_thread(db.create_bot_session, user_id, clean["market_category"], clean["assets"],
                                          clean["allocated_capital"], clean["target_profit"], clean["max_loss"],
                                          clean["leverage"])
        await asyncio.to_thread(self.save_config, user_id, clean)
        await self.emit(session, BotEventType.STATE_CHANGED,
                        f"Bot session #{session['id']} created for {', '.join(clean['assets'])} "
                        f"with {clean['allocated_capital']:,.2f} allocated.",
                        data={"from": None, "to": "STARTING", "config": clean})
        if not self.scheduler_online():
            await self.emit(session, BotEventType.STATE_CHANGED,
                            "The Go bot scheduler is not reporting a heartbeat; the session will start scanning once it is online.",
                            level="warning", data={"from": "STARTING", "to": "STARTING"})
        await self._terminal_log(user_id, f"Session #{session['id']} started on {', '.join(clean['assets'])}.")
        return await self.push_snapshot(session)

    @staticmethod
    def save_config(user_id: int, clean: Dict[str, Any], is_active: bool = False) -> None:
        """Persist the form values as the user's saved configuration (legacy bot_config columns)."""
        db.get_bot_config(user_id)  # creates the row on first use
        db.update_bot_config(user_id, {
            "assets": ",".join(clean["assets"]),
            "total_capital": clean["allocated_capital"],
            "min_profit_target": clean["target_profit"],   # legacy name: session target profit
            "max_profit_target": clean["max_loss"],        # legacy name: session max loss
            "max_risk_per_trade": clean["max_loss"],
            "market_category": clean["market_category"],
            "leverage": clean["leverage"],
            "is_active": is_active,
        })

    async def stop_session(self, user_id: int, reason: Optional[str] = None) -> Dict[str, Any]:
        """
        Request a graceful stop. No positions are closed. The Go scheduler
        finishes the in-flight step and finalizes STOPPING -> STOPPED; with no
        scheduler online the stop is finalized here.
        Raises LookupError when there is nothing to stop.
        """
        session = await asyncio.to_thread(db.get_live_bot_session, user_id)
        if not session:
            raise LookupError("No running bot session to stop.")
        if session["status"] == "STOPPING":
            return await self.snapshot(session)
        ok = await self._transition(session, "STOPPING", ENTRY, reason=reason or "Stopped by user")
        if not ok and session["status"] not in LIVE:
            # A limit was reached (or the session failed) while the request was in flight.
            return await self.push_snapshot(session)
        if not self.scheduler_online():
            return await self.finalize_stop(session["id"])
        return await self.push_snapshot(session)

    async def current_view(self, user_id: int) -> Optional[Dict[str, Any]]:
        session = await asyncio.to_thread(db.get_current_bot_session, user_id)
        return await self.snapshot(session) if session else None

    def activity(self, session_id: int, limit: int = 100) -> List[Dict[str, Any]]:
        return valkey_service.lrange(f"bot:activity:{session_id}", 0, max(0, int(limit) - 1))

    async def on_trade_closed(self, trade_before: Dict[str, Any], result: Dict[str, Any]) -> None:
        """Hook for manual closes of bot trades through the existing close endpoint."""
        session_id = trade_before.get("bot_session_id")
        if not session_id:
            return
        session = await asyncio.to_thread(db.get_bot_session, session_id)
        if not session:
            return
        symbol = trade_before.get("asset")
        partial = result.get("action") == "PARTIAL_CLOSE"
        realized = float(result.get("realized_pnl") or 0.0)
        await self.emit(session, BotEventType.TRADE_CLOSED,
                        f"{symbol} #{trade_before.get('id')} {'partially' if partial else 'fully'} closed manually "
                        f"({float(result.get('closed_quantity') or 0):g} units), realized {realized:+,.2f}.",
                        symbol=symbol, level="success" if realized >= 0 else "warning",
                        data={"trade_id": trade_before.get("id"), "action": result.get("action"), "via": "manual",
                              "realized_pnl": _r(realized), "remaining_quantity": result.get("remaining_quantity")})
        snap = await self.snapshot(session)
        if session["status"] in ENTRY:
            breach = self._limit_breach(snap)
            if breach:
                await self._enter_limit_state(session, breach, snap)
        await self.push_snapshot(session)

    # ------------------------------------------------------ scheduler steps

    def heartbeat(self, owner: str, ttl_seconds: int) -> Dict[str, Any]:
        """Leader lease for the Go scheduler; the leader's heartbeat marks the scheduler online."""
        leader = valkey_service.acquire_lease(LEADER_LEASE_KEY, owner, ttl_seconds)
        if leader:
            valkey_service.set(HEARTBEAT_KEY, {"owner": owner, "ts": time.time()}, ttl_seconds=int(ttl_seconds))
        return {
            "leader": leader,
            "config": {
                "tick_seconds": self.policy.tick_seconds,
                "analysis_ttl_seconds": self.policy.analysis_ttl_seconds,
                "max_concurrency": self.policy.max_concurrency,
            },
        }

    async def scheduler_sessions(self) -> List[Dict[str, Any]]:
        """Work list: every live session, plus stopped sessions whose positions still need SL/target supervision."""
        live = await asyncio.to_thread(db.list_bot_sessions_by_status, db.BOT_LIVE_STATUSES)
        refs = {s["id"]: s for s in live}
        if self.policy.protect_positions_after_stop:
            open_trades = await asyncio.to_thread(db.get_open_bot_trades)
            for sid in {t["bot_session_id"] for t in open_trades} - set(refs):
                s = await asyncio.to_thread(db.get_bot_session, sid)
                if s:
                    refs[sid] = s
        return [{"id": s["id"], "user_id": s["user_id"], "status": s["status"], "assets": s["assets"],
                 "live": s["status"] in LIVE} for s in refs.values()]

    async def attach(self, session_id: int, recovered: bool) -> Dict[str, Any]:
        session = await asyncio.to_thread(db.get_bot_session, session_id)
        if not session:
            return {"status": None}
        if recovered and session["status"] in LIVE and session["status"] != "STARTING":
            await self.emit(session, BotEventType.SESSION_RECOVERED,
                            f"Session resumed by the scheduler after a restart (state {session['status']}).",
                            data={"status": session["status"]})
        return {"status": session["status"]}

    async def monitor(self, session_id: int) -> Dict[str, Any]:
        """
        One supervision tick: enforce SL/target on the session's open trades
        (existing P&L Manager), refresh metrics, apply target / max-loss limits
        and tell the scheduler whether a scan is due.
        """
        session, open_rows = await asyncio.gather(
            asyncio.to_thread(db.get_bot_session, session_id),
            asyncio.to_thread(db.get_bot_session_trades, session_id, "open"),
        )
        if not session:
            return {"status": None, "done": True, "stop_requested": False, "entries_allowed": False, "scan_due": False}
        if session["status"] == "STOPPING":
            return {"status": "STOPPING", "done": False, "stop_requested": True, "entries_allowed": False, "scan_due": False}

        if open_rows and (session["status"] in ENTRY or self.policy.protect_positions_after_stop):
            await self._supervise_positions(session, open_rows)

        snap = await self.snapshot(session)
        if session["status"] in ENTRY:
            breach = self._limit_breach(snap)
            if breach:
                await self._enter_limit_state(session, breach, snap)
                snap = await self.snapshot(session)
        if snap["is_live"] or snap["open_trades"] > 0:
            await self._send(session["user_id"], {"type": "bot_session_updated", "data": snap})

        entries_allowed = session["status"] in ENTRY
        done = not entries_allowed and (snap["open_trades"] == 0 or not self.policy.protect_positions_after_stop)
        return {
            "status": session["status"],
            "done": done,
            "stop_requested": False,
            "entries_allowed": entries_allowed,
            "scan_due": entries_allowed and (snap["next_scan_in_seconds"] or 0) <= 0,
            "open_trades": snap["open_trades"],
            "monitor_only": not entries_allowed and not done,
        }

    async def _supervise_positions(self, session: Dict[str, Any], open_rows: List[Dict[str, Any]]) -> None:
        by_symbol: Dict[str, List[Dict[str, Any]]] = {}
        for row in open_rows:
            by_symbol.setdefault(row["asset"], []).append(row)
        for symbol, rows in by_symbol.items():
            try:
                price = float(await self.price_fn(symbol))
            except Exception as exc:
                logger.warning(f"[Bot] No quote for {symbol} while supervising: {exc}")
                continue
            if price <= 0:
                continue
            logs: List[str] = []
            await asyncio.to_thread(monitor_positions, price, lambda _agent, msg: logs.append(msg),
                                    session["user_id"], symbol, session["id"])
            for msg in logs:
                await self.emit(session, BotEventType.POSITION_MANAGED, msg, symbol=symbol, data={"price": price})
            still_open = {r["id"] for r in await asyncio.to_thread(db.get_bot_session_trades, session["id"], "open")}
            for row in rows:
                if row["id"] in still_open:
                    continue
                final = await asyncio.to_thread(db.get_trade, row["id"]) or row
                # Report only exits the P&L Manager booked itself. A manual close
                # that lands between this tick's read and now is reported by the
                # close endpoint's hook instead.
                if final.get("outcome") not in ("sl", "target"):
                    continue
                self._clear_live_state(final)
                realized = float(final.get("realized_pnl") or 0.0)
                await self.emit(session, BotEventType.TRADE_CLOSED,
                                f"{symbol} #{row['id']} closed by the P&L Manager at {float(final.get('exit_price') or price):,.4f} "
                                f"({str(final.get('outcome') or '').upper()}), realized {realized:+,.2f}.",
                                symbol=symbol, level="success" if realized >= 0 else "warning",
                                data={"trade_id": row["id"], "outcome": final.get("outcome"), "via": "pnl_manager",
                                      "realized_pnl": _r(realized)})
                await self._terminal_log(session["user_id"], f"Auto-trade #{row['id']} on {symbol} closed "
                                                             f"({final.get('outcome')}), realized {realized:+,.2f}.")
                await self._publish_portfolio(session["user_id"], closed={"trade_id": row["id"], "status": "closed",
                                                                          "realized_pnl": realized})

    @staticmethod
    def _clear_live_state(trade: Dict[str, Any]) -> None:
        tid, uid, sym = str(trade["id"]), trade.get("user_id"), trade.get("asset")
        valkey_service.delete(f"trade:active:{tid}")
        valkey_service.srem(f"user:{uid}:active_trades", tid)
        valkey_service.srem(f"symbol:{sym}:active_trades", tid)
        if uid is not None:
            valkey_service.invalidate_user_cache(uid)

    async def begin_scan(self, session_id: int) -> Dict[str, Any]:
        session = await asyncio.to_thread(db.get_bot_session, session_id)
        if not session or session["status"] not in ENTRY:
            return {"proceed": False, "status": session["status"] if session else None, "assets": []}
        if not await self._transition(session, "SCANNING", ENTRY):
            return {"proceed": False, "status": session["status"], "assets": []}
        await self.emit(session, BotEventType.SCAN_STARTED,
                        f"Scan #{int(session.get('scan_count') or 0) + 1}: checking {', '.join(session['assets'])}.",
                        data={"assets": session["assets"]})
        return {"proceed": True, "status": session["status"], "assets": session["assets"]}

    async def analyze(self, symbol: str) -> Dict[str, Any]:
        """Run the analysis stack once; the Go scheduler shares the result across sessions."""
        symbol = symbol.strip().upper()
        try:
            rec = await self.analyzer(symbol)
        except Exception as exc:
            logger.exception(f"[Bot] Analyzer crashed for {symbol}")
            rec = {"symbol": symbol, "ok": False, "error": str(exc), "created_at": time.time()}
        analysis_id = uuid.uuid4().hex
        rec["analysis_id"] = analysis_id
        await asyncio.to_thread(valkey_service.set, f"bot:analysis:{analysis_id}", rec,
                                int(self.policy.analysis_ttl_seconds + 120))
        return {"analysis_id": analysis_id, "symbol": symbol, "ok": bool(rec.get("ok")), "error": rec.get("error"),
                "decision": (rec.get("decision") or {}).get("decision")}

    async def _emit_analysis(self, session, symbol, rec, brain, risk, opp, decision) -> None:
        await self.emit(session, BotEventType.MARKET_DATA_UPDATED,
                        f"{symbol}: {rec.get('candles', 0)} candles from {rec.get('data_source')} "
                        f"(age {float(rec.get('data_age_seconds') or 0):.0f}s), last {float(rec.get('price') or 0):,.4f}.",
                        symbol=symbol, data={"price": rec.get("price"), "candles": rec.get("candles"),
                                             "source": rec.get("data_source")})
        ag = brain.agent_summary
        await self.emit(session, BotEventType.AGENTS_COMPLETED,
                        f"{symbol}: {ag.successful_agents}/{ag.total_agents} agents — "
                        f"{ag.tally.get('BULLISH', 0)} bullish, {ag.tally.get('BEARISH', 0)} bearish, "
                        f"{ag.tally.get('NEUTRAL', 0)} neutral.",
                        symbol=symbol, data={"tally": ag.tally, "succeeded": ag.successful_agents, "total": ag.total_agents})
        st = brain.strategy_summary
        await self.emit(session, BotEventType.STRATEGIES_COMPLETED,
                        f"{symbol}: {st.strategies_evaluated} strategies evaluated, {st.setups_found} setup(s) "
                        f"({st.bullish_setups} bullish / {st.bearish_setups} bearish)"
                        + (f": {', '.join(st.active_strategies[:3])}." if st.active_strategies else "."),
                        symbol=symbol, data={"setups": st.setups_found, "bullish": st.bullish_setups,
                                             "bearish": st.bearish_setups, "active": st.active_strategies})
        await self.emit(session, BotEventType.RISK_EVALUATED,
                        f"{symbol}: Risk Guard {risk.risk_level.value} ({risk.risk_score:.1f}/100).",
                        symbol=symbol, level="warning" if risk.risk_level.value in ("HIGH", "CRITICAL") else "info",
                        data={"level": risk.risk_level.value, "score": risk.risk_score, "status": risk.status.value})
        await self.emit(session, BotEventType.OPPORTUNITY_EVALUATED,
                        f"{symbol}: opportunity {opp.opportunity_level.value} ({opp.opportunity_score:.1f}/100), "
                        f"bias {opp.leading_bias}.",
                        symbol=symbol, data={"level": opp.opportunity_level.value, "score": opp.opportunity_score})
        await self.emit(session, BotEventType.DECISION_READY,
                        f"{symbol}: stance {decision.decision.value} — confidence {decision.decision_confidence:.1f}, "
                        f"clarity {decision.decision_clarity.value}.",
                        symbol=symbol, data={"stance": decision.decision.value, "confidence": decision.decision_confidence,
                                             "clarity": decision.decision_clarity.value, "summary": decision.summary})

    async def evaluate(self, session_id: int, symbol: str, analysis_id: str) -> Dict[str, Any]:
        """
        Evaluate one symbol for one session against a shared analysis:
        candidate -> Risk Guard gate -> Risk Planner -> execution.
        """
        session = await asyncio.to_thread(db.get_bot_session, session_id)
        if not session:
            return {"continue": False, "outcome": "missing_session"}
        if session["status"] not in ENTRY:
            return {"continue": False, "outcome": "not_running", "status": session["status"]}
        symbol = symbol.strip().upper()
        if symbol not in [a.upper() for a in session["assets"]]:
            return {"continue": True, "outcome": "ignored"}
        rec = await asyncio.to_thread(valkey_service.get, f"bot:analysis:{analysis_id}") if analysis_id else None
        if not isinstance(rec, dict):
            return {"continue": True, "outcome": "analysis_missing"}

        if session["status"] not in ("ANALYZING", "OPPORTUNITY_FOUND"):
            if not await self._transition(session, "ANALYZING", ENTRY):
                return {"continue": False, "outcome": "not_running", "status": session["status"]}
        if not rec.get("ok"):
            await self.emit(session, BotEventType.MARKET_DATA_FAILED, f"{symbol}: {rec.get('error')}",
                            symbol=symbol, level="warning")
            return {"continue": True, "outcome": "analysis_failed"}

        brain = BrainAnalysisContext.model_validate(rec["brain"])
        risk = RiskEvaluationResult.model_validate(rec["risk"])
        opp = OpportunityEvaluationResult.model_validate(rec["opportunity"])
        decision = DecisionEvaluationResult.model_validate(rec["decision"])
        await self._emit_analysis(session, symbol, rec, brain, risk, opp, decision)

        stance = decision.decision.value
        if stance not in ("BULLISH", "BEARISH"):
            await self.emit(session, BotEventType.NO_OPPORTUNITY,
                            f"{symbol}: no directional opportunity ({stance}).", symbol=symbol,
                            data={"stance": stance})
            return {"continue": True, "outcome": "no_opportunity"}

        side = "buy" if stance == "BULLISH" else "sell"
        if session["status"] != "OPPORTUNITY_FOUND":
            if not await self._transition(session, "OPPORTUNITY_FOUND", ENTRY):
                return {"continue": False, "outcome": "not_running", "status": session["status"]}
        await self.emit(session, BotEventType.OPPORTUNITY_DETECTED,
                        f"{symbol}: {'LONG' if side == 'buy' else 'SHORT'} candidate ({stance}, "
                        f"opportunity {opp.opportunity_level.value}). Sending to Risk Guard.",
                        symbol=symbol, level="success", data={"side": side, "stance": stance})

        snap = await self.snapshot(session)
        has_open = any(str(t.get("symbol") or t.get("asset")).upper() == symbol for t in snap["active_trades"])
        gate = risk_guard.evaluate_bot_trade_gate(
            symbol=symbol,
            session_status=session["status"],
            entry_statuses=ENTRY,
            target_profit=snap["target_profit"],
            max_loss=snap["max_loss"],
            realized_pnl=snap["realized_pnl"],
            loss_basis_pnl=snap["loss_basis_pnl"],
            allocated_capital=snap["allocated_capital"],
            used_capital=snap["used_capital"],
            has_open_position=has_open,
            risk_result=risk,
            decision=decision,
            opportunity=opp,
            blocked_risk_levels=self.policy.blocked_risk_levels,
            min_decision_clarity=self.policy.min_decision_clarity,
            min_opportunity_level=self.policy.min_opportunity_level,
        )
        if not gate.approved:
            reasons = [r.detail for r in gate.rejections]
            await self.emit(session, BotEventType.RISK_REJECTED, f"{symbol}: Risk Guard rejected — {'; '.join(reasons)}",
                            symbol=symbol, level="warning",
                            data={"checks": [c.model_dump() for c in gate.checks], "limit": gate.limit_breached})
            if gate.limit_breached:
                await self._enter_limit_state(session, gate.limit_breached, snap)
                return {"continue": False, "outcome": "limit_reached"}
            return {"continue": True, "outcome": "rejected"}

        try:
            price = float(await self.price_fn(symbol))
        except Exception as exc:
            price = 0.0
            logger.warning(f"[Bot] Quote failed for {symbol}: {exc}")
        if price <= 0:
            await self.emit(session, BotEventType.EXECUTION_REJECTED, f"{symbol}: no live quote, entry skipped.",
                            symbol=symbol, level="warning")
            return {"continue": True, "outcome": "no_quote"}

        balance = await asyncio.to_thread(db.get_user_balance, session["user_id"])
        budget = min(snap["available_bot_capital"], float(balance))
        planner_log: List[str] = []
        plan = await asyncio.to_thread(plan_trade, {"signal": side}, rec.get("sentiment_score", 0.0),
                                       rec.get("supports", []), rec.get("resistances", []), price, budget,
                                       lambda _agent, msg: planner_log.append(msg), decision.summary)
        if plan.get("action") != side or float(plan.get("quantity") or 0) <= 0:
            await self.emit(session, BotEventType.RISK_REJECTED,
                            f"{symbol}: Risk Planner declined — {plan.get('reason') or 'no position size'}",
                            symbol=symbol, level="warning", data={"planner": planner_log[-6:]})
            return {"continue": True, "outcome": "planner_declined"}

        qty = float(plan["quantity"])
        leverage = float(session["leverage"])
        await self.emit(session, BotEventType.RISK_APPROVED,
                        f"{symbol}: approved {'LONG' if side == 'buy' else 'SHORT'} {qty:g} @ {price:,.4f}, "
                        f"SL {plan['sl']:,.2f}, target {plan['target']:,.2f}, margin ~{qty * price / leverage:,.2f}.",
                        symbol=symbol, level="success",
                        data={"quantity": qty, "price": price, "sl": plan["sl"], "target": plan["target"],
                              "leverage": leverage, "risk_brief": plan.get("risk_brief")})
        try:
            opened = await position_service.open_market_position(
                session["user_id"], symbol, side, qty, leverage=leverage, sl=plan["sl"], target=plan["target"],
                market=session["market_category"], price=price, source="bot", bot_session_id=session["id"],
            )
        except ValueError as exc:
            await self.emit(session, BotEventType.EXECUTION_REJECTED, f"{symbol}: execution refused — {exc}",
                            symbol=symbol, level="warning")
            fresh = await asyncio.to_thread(db.get_bot_session, session["id"])
            still_running = bool(fresh and fresh["status"] in ENTRY)
            return {"continue": still_running, "outcome": "execution_refused"}

        trade = opened["trade"]
        await self.emit(session, BotEventType.TRADE_OPENED,
                        f"Opened {'LONG' if side == 'buy' else 'SHORT'} {symbol} #{trade['id']}: {qty:g} @ {price:,.4f} "
                        f"({leverage:g}x), margin {trade['margin_used']:,.2f}.",
                        symbol=symbol, level="success", data={"trade": trade})
        await self._terminal_log(session["user_id"], f"AUTOTRADE FIRED: {side.upper()} {symbol} @ {price:,.2f} (#{trade['id']}).")
        await self._publish_portfolio(session["user_id"], opened=trade)
        return {"continue": True, "outcome": "opened", "trade_id": trade["id"]}

    async def complete_scan(self, session_id: int) -> Dict[str, Any]:
        session = await asyncio.to_thread(db.get_bot_session, session_id)
        if not session:
            return {"status": None}
        await asyncio.to_thread(db.mark_bot_session_scanned, session_id)
        if session["status"] in ENTRY:
            agg = await asyncio.to_thread(db.get_bot_session_aggregates, session_id)
            await self._transition(session, "TRADE_ACTIVE" if agg["open_trades"] > 0 else "WAITING", ENTRY)
            await self.emit(session, BotEventType.SCAN_COMPLETED,
                            f"Scan complete. Next scan in {self.policy.scan_interval_seconds:.0f}s.",
                            data={"next_scan_in_seconds": self.policy.scan_interval_seconds})
        session = await asyncio.to_thread(db.get_bot_session, session_id) or session
        await self.push_snapshot(session)
        return {"status": session["status"]}

    async def finalize_stop(self, session_id: int) -> Dict[str, Any]:
        session = await asyncio.to_thread(db.get_bot_session, session_id)
        if not session:
            return {"status": None}
        if session["status"] == "STOPPING":
            if await self._transition(session, "STOPPED", ("STOPPING",), stopped=True):
                agg = await asyncio.to_thread(db.get_bot_session_aggregates, session_id)
                await self.emit(session, BotEventType.STATE_CHANGED,
                                f"Bot stopped. {agg['open_trades']} open position(s) kept and remain manageable.",
                                data={"from": "STOPPING", "to": "STOPPED", "open_trades": agg["open_trades"]})
                await self._terminal_log(session["user_id"], f"Session #{session_id} stopped.")
        return await self.push_snapshot(session)

    async def fail_session(self, session_id: int, error: str) -> Dict[str, Any]:
        session = await asyncio.to_thread(db.get_bot_session, session_id)
        if not session:
            return {"status": None}
        if await self._transition(session, "ERROR", LIVE, error=error, reason="Scheduler reported repeated failures",
                                  stopped=True):
            await self.emit(session, BotEventType.ERROR, f"Bot cannot continue safely: {error}", level="error")
        return await self.push_snapshot(session)
