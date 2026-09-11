"""
backend/services/copilot_service.py — ORBIT AI Market Intelligence Copilot Service.

Orchestrates:
1. Context Resolution: retrieves existing ORBIT analysis (Phases 2-10) with zero duplicate execution.
2. Intent Classification: classifies questions into 9 targeted categories with depth detection.
3. Context Selection: filters relevant intelligence dimensions based on intent.
4. Conversation Memory: maintains sliding-window multi-turn continuity per session.
5. LLM Orchestration & Prompt Guardrails: enforces anti-hallucination and financial boundaries.
6. Deterministic Fallback: guarantees high-quality answers even if external LLM APIs are offline.
"""

import asyncio
import logging
import re
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import backend.database as db
from backend.llm import generate_text
from backend.models.copilot import (
    CopilotChatMessage,
    CopilotChatRequest,
    CopilotChatResponse,
    CopilotContextSummary,
    CopilotDepth,
    CopilotIntent,
    CopilotMessageRole,
    ResponseMode,
)
from backend.models.decision import MarketStance
from backend.models.explainability import ExplainabilityEvaluationResult, ExplainabilityStatus
from backend.services.decision_engine import DecisionEngine, decision_engine
from backend.services.explainability_engine import ExplainabilityEngine, explainability_engine
from backend.services.market_data_service import MarketDataService, market_service
from backend.services.opportunity_engine import OpportunityEngine, opportunity_engine
from backend.services.orbit_brain import OrbitBrain, orbit_brain
from backend.services.risk_guard import RiskGuard, risk_guard

logger = logging.getLogger("orbit.copilot")


class CopilotService:
    """
    Centralized ORBIT AI Market Intelligence Copilot.
    Provides conversational reasoning grounded in actual ORBIT analytical output.
    """

    def __init__(
        self,
        explain_engine: Optional[ExplainabilityEngine] = None,
        dec_engine: Optional[DecisionEngine] = None,
        brain_svc: Optional[OrbitBrain] = None,
        guard_svc: Optional[RiskGuard] = None,
        opp_svc: Optional[OpportunityEngine] = None,
        mkt_svc: Optional[MarketDataService] = None,
    ):
        self.explainability_engine = explain_engine or explainability_engine
        self.decision_engine = dec_engine or decision_engine
        self.brain = brain_svc or orbit_brain
        self.risk_guard = guard_svc or risk_guard
        self.opp_engine = opp_svc or opportunity_engine
        self.market_service = mkt_svc or market_service

        # In-memory analysis cache: (symbol, timeframe) -> (timestamp, ExplainabilityEvaluationResult)
        self._analysis_cache: Dict[Tuple[str, str], Tuple[float, ExplainabilityEvaluationResult]] = {}
        # In-memory session store: conversation_id -> {"symbol": str, "messages": List[Dict]}
        self._sessions: Dict[str, Dict[str, Any]] = {}
        self._cache_ttl_seconds = 180.0  # 3 minutes

    # -----------------------------------------------------------------------
    # 1. Context Resolution & Caching
    # -----------------------------------------------------------------------

    async def get_or_resolve_analysis(
        self, symbol: str, timeframe: str = "1d", force_refresh: bool = False
    ) -> Optional[ExplainabilityEvaluationResult]:
        """
        Retrieves existing analysis from memory or runs a single unified pass.
        Guarantees zero duplicate processing.
        """
        upper_sym = symbol.strip().upper()
        cache_key = (upper_sym, timeframe)
        now = time.time()

        if not force_refresh and cache_key in self._analysis_cache:
            ts, cached_res = self._analysis_cache[cache_key]
            if (now - ts) < self._cache_ttl_seconds:
                return cached_res

        # Evaluate via Phase 10 Explainability Engine (unifies Phases 2-9 in a single pass)
        try:
            result = await self.explainability_engine.evaluate_explanation(upper_sym, timeframe=timeframe)
            self._analysis_cache[cache_key] = (now, result)
            return result
        except Exception as exc:
            logger.error(f"Copilot: Failed to resolve ORBIT analysis for {upper_sym}: {exc}", exc_info=True)
            return None

    # -----------------------------------------------------------------------
    # 2. Intent Classification & Depth Detection
    # -----------------------------------------------------------------------

    def classify_intent(self, query: str) -> Tuple[CopilotIntent, CopilotDepth]:
        """
        Classifies user query into structured intent and requested detail depth.
        """
        q = query.lower()

        # Depth detection
        depth = CopilotDepth.STANDARD
        if any(term in q for term in ["simply", "simple", "beginner", "in brief", "short", "plain english", "easy"]):
            depth = CopilotDepth.SIMPLE
        elif any(term in q for term in ["detailed", "deep dive", "in-depth", "comprehensive", "breakdown", "exhaustive"]):
            depth = CopilotDepth.DEEP

        # Intent detection
        if any(k in q for k in ["risk", "danger", "stop loss", "drawdown", "hazard", "threat", "volatility", "worst case"]):
            return CopilotIntent.RISK_CONSTRAINTS, depth

        if any(k in q for k in ["disagree", "diverge", "conflict", "oppose", "agents agree", "agent opinion"]):
            return CopilotIntent.AGENT_DISAGREEMENT, depth

        if any(k in q for k in ["opportunity", "reward", "headroom", "conviction", "potential", "setup score"]):
            return CopilotIntent.OPPORTUNITY_CONFLUENCE, depth

        if any(k in q for k in ["strategy", "strategies", "setup", "smc", "ict", "wyckoff", "supertrend", "trend following"]):
            return CopilotIntent.STRATEGY_SETUPS, depth

        if any(k in q for k in ["why", "stance", "bullish", "bearish", "neutral", "decision", "verdict", "call"]):
            return CopilotIntent.DECISION_STANCE, depth

        if any(k in q for k in ["evidence", "data", "support", "proof", "metric", "indicator", "candle", "oscillator", "quantum"]):
            return CopilotIntent.EVIDENCE_DATA, depth

        if any(k in q for k in ["invalidate", "watch next", "flip", "change mind", "fail", "levels"]):
            return CopilotIntent.INVALIDATION_NEXT_STEPS, depth

        if depth == CopilotDepth.SIMPLE:
            return CopilotIntent.SIMPLIFICATION, depth

        if depth == CopilotDepth.DEEP:
            return CopilotIntent.DEEP_DIVE, depth

        return CopilotIntent.GENERAL_QUERY, depth

    # -----------------------------------------------------------------------
    # 3. Context Selection (Token-Efficient Context Packaging)
    # -----------------------------------------------------------------------

    def select_context(
        self, analysis: ExplainabilityEvaluationResult, intent: CopilotIntent, depth: CopilotDepth
    ) -> Dict[str, Any]:
        """
        Filters and structures relevant ORBIT intelligence based on query intent.
        Prevents prompt bloating while ensuring complete factual grounding.
        """
        inp = analysis.input_summary
        ctx: Dict[str, Any] = {
            "symbol": analysis.symbol,
            "timeframe": analysis.timeframe,
            "status": analysis.status.value,
            "market_stance": analysis.market_stance.value,
            "confidence": analysis.decision_confidence,
            "clarity": analysis.decision_clarity,
            "headline": analysis.headline,
            "why_thesis": analysis.why,
            "consensus": {
                "signal": inp.consensus_signal,
                "strength": inp.consensus_strength,
                "agreement_pct": inp.agreement_score,
            },
            "risk": {
                "level": inp.risk_level,
                "score": inp.risk_score,
                "constraints": [
                    rc.detail or rc.message or rc.title if hasattr(rc, "detail") else str(rc)
                    for rc in analysis.risk_constraints
                ],
            },
            "opportunity": {
                "level": inp.opportunity_level,
                "score": inp.opportunity_score,
            },
            "pipeline_completeness": f"{inp.completeness_score:.1f}% ({inp.completeness_tier})",
        }

        # Targeted intelligence inclusion
        if intent in (CopilotIntent.RISK_CONSTRAINTS, CopilotIntent.DEEP_DIVE):
            ctx["risk_constraints"] = [
                rc.detail or rc.message or rc.title if hasattr(rc, "detail") else str(rc)
                for rc in analysis.risk_constraints
            ]
            ctx["uncertainties"] = [
                {"factor": u.factor, "explanation": u.explanation, "severity": u.severity}
                for u in analysis.uncertainties
            ]

        if intent in (CopilotIntent.AGENT_DISAGREEMENT, CopilotIntent.DEEP_DIVE):
            ctx["conflicts"] = [
                {"category": c.category.value, "severity": c.severity.value, "explanation": c.explanation}
                for c in analysis.conflicts
            ]

        if intent in (CopilotIntent.EVIDENCE_DATA, CopilotIntent.DECISION_STANCE, CopilotIntent.DEEP_DIVE):
            all_evidence = analysis.primary_evidence + analysis.supporting_evidence
            ctx["traceable_evidence"] = [
                {
                    "subsystem": e.source.value if hasattr(e.source, "value") else str(e.source),
                    "category": e.category.value if hasattr(e.category, "value") else str(e.category),
                    "detail": e.detail or e.message or e.title,
                }
                for e in all_evidence[:8]
            ]

        return ctx

    # -----------------------------------------------------------------------
    # 4. Session & Conversation Memory
    # -----------------------------------------------------------------------

    def get_or_create_session(
        self,
        conv_id: Optional[str],
        symbol: str,
        user_id: Optional[int] = None,
        market: str = "US Stocks",
    ) -> Tuple[str, List[Dict[str, str]]]:
        """Retrieves or creates a conversation session with sliding-window history and DB persistence."""
        cid = conv_id or str(uuid.uuid4())
        clean_sym = symbol.strip().upper() if symbol else ""
        
        if cid not in self._sessions:
            # Check if conversation exists in persistent database
            try:
                existing_conv = db.get_conversation(cid)
                if existing_conv:
                    msgs = db.get_chat_messages(cid, limit=16)
                    self._sessions[cid] = {
                        "symbol": existing_conv.get("selected_asset") or clean_sym,
                        "market": existing_conv.get("selected_market") or market,
                        "created_at": time.time(),
                        "messages": [
                            {"role": m.get("role", "user"), "content": m.get("content", ""), "time": m.get("timestamp", "")}
                            for m in msgs
                        ],
                    }
                else:
                    db.create_conversation(
                        conversation_id=cid,
                        title="New Analysis",
                        selected_asset=clean_sym,
                        selected_market=market,
                        user_id=user_id,
                    )
                    self._sessions[cid] = {
                        "symbol": clean_sym,
                        "market": market,
                        "created_at": time.time(),
                        "messages": [],
                    }
            except Exception as e:
                logger.warning(f"Could not load conversation {cid} from DB: {e}")
                self._sessions[cid] = {
                    "symbol": clean_sym,
                    "market": market,
                    "created_at": time.time(),
                    "messages": [],
                }
        
        session = self._sessions[cid]
        if clean_sym:
            session["symbol"] = clean_sym
        return cid, session["messages"]

    def append_message(
        self,
        cid: str,
        role: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Appends a message to conversation history, saves to database, and updates title if needed."""
        # 1. Update In-Memory Sliding Window
        if cid in self._sessions:
            msgs = self._sessions[cid]["messages"]
            msgs.append({"role": role, "content": content, "time": datetime.now().isoformat()})
            if len(msgs) > 12:
                self._sessions[cid]["messages"] = msgs[-12:]

        # 2. Persist to Database
        try:
            db.save_chat_message(cid, role, content, metadata=metadata)
            
            # Auto-generate title on first user question if title is default
            if role == "user":
                conv = db.get_conversation(cid)
                if conv and (not conv.get("title") or conv.get("title") in ("New Analysis", "Untitled Analysis")):
                    sym = (metadata or {}).get("symbol") or (self._sessions.get(cid, {}).get("symbol", ""))
                    q_lower = content.lower()
                    if "risk" in q_lower:
                        new_title = f"{sym} Risk Analysis" if sym else "Risk Analysis"
                    elif any(k in q_lower for k in ["outlook", "trend", "stance", "bullish", "bearish"]):
                        new_title = f"{sym} Market Outlook" if sym else "Market Outlook"
                    elif sym:
                        new_title = f"{sym} Analysis"
                    else:
                        new_title = content[:28] + ("..." if len(content) > 28 else "")
                    db.update_conversation(cid, title=new_title, selected_asset=sym)
        except Exception as e:
            logger.warning(f"Error persisting chat message for conversation {cid}: {e}")

    def reset_session(self, cid: str) -> bool:
        """Clears a conversation session."""
        if cid in self._sessions:
            del self._sessions[cid]
            return True
        return False

    # -----------------------------------------------------------------------
    # -----------------------------------------------------------------------
    # 5. Deterministic Fallback Synthesis (Section 13 & 14 Multi-Mode Engine)
    # -----------------------------------------------------------------------

    def synthesize_deterministic_fallback(
        self,
        query: str,
        analysis: ExplainabilityEvaluationResult,
        intent: CopilotIntent,
        depth: CopilotDepth,
        response_mode: str = "DETAILED",
    ) -> str:
        """
        Constructs an authoritative, factual, and articulate response directly
        from Phase 10 Explainability and upstream models when LLM providers are offline.
        Strictly follows Section 13 layout and Section 14 response modes.
        """
        sym = analysis.symbol
        stance = analysis.market_stance.value
        conf = analysis.decision_confidence
        clarity = analysis.decision_clarity
        risk_lvl = analysis.input_summary.risk_level
        risk_score = analysis.input_summary.risk_score
        opp_score = analysis.input_summary.opportunity_score
        opp_lvl = analysis.input_summary.opportunity_level
        headline = analysis.headline

        mode = (response_mode or "DETAILED").upper()

        # MODE 1: QUICK (Short, high-conviction analytical summary)
        if mode == "QUICK":
            first_why = analysis.why[0] if analysis.why else headline
            top_risk = "Volatility within normal boundaries"
            if analysis.risk_constraints:
                rc = analysis.risk_constraints[0]
                top_risk = rc.detail or rc.message or rc.title if hasattr(rc, "detail") else str(rc)

            return (
                f"### {sym} — {stance} ({conf:.1f}% Confidence)\n\n"
                f"• **Market Stance:** {stance} ({clarity} clarity). {first_why}\n"
                f"• **Risk Profile:** {risk_lvl} ({risk_score:.0f}/100) — {top_risk}.\n"
                f"• **Opportunity Score:** {opp_score:.0f}/100 ({opp_lvl}).\n"
                f"• **Key Invalidation:** Reversal in momentum or breach of support zones.\n\n"
                f"*This is analytical decision support and not an automatic trading action.*"
            )

        # MODE 2: EXPLAIN SIMPLY (Beginner-friendly language, plain English, zero jargon)
        if mode == "EXPLAIN_SIMPLY" or depth == CopilotDepth.SIMPLE or intent == CopilotIntent.SIMPLIFICATION:
            stance_desc = "favorable and leaning upward" if "bull" in stance.lower() else "cautious and leaning downward" if "bear" in stance.lower() else "neutral, waiting for a clearer trend"
            first_why = analysis.why[0] if analysis.why else "technical indicators and quantitative models are broadly aligned"
            return (
                f"### {sym} Analysis (Plain English)\n\n"
                f"In simple terms, ORBIT's quantitative models currently evaluate **{sym}** as **{stance}** with **{conf:.1f}% confidence**.\n\n"
                f"**What does this mean?**\n"
                f"The overall market environment looks {stance_desc}. Specifically, {first_why.lower()}.\n\n"
                f"**What are the main risks to keep in mind?**\n"
                f"Analytical risk is currently **{risk_lvl}** ({risk_score:.0f} out of 100). "
                f"Even when signals lean positive, sudden market volatility or shifts in volume can quickly alter the picture.\n\n"
                f"**What would change this view?**\n"
                f"If the price falls below critical support or market volume drops off significantly, ORBIT would revise this stance.\n\n"
                f"*Note: This explanation is for educational decision support and does not execute trades or promise profits.*"
            )

        # MODE 3: DETAILED (Full Section 13 Structured Layout)
        why_bullets = ""
        if analysis.why:
            for pt in analysis.why[:3]:
                why_bullets += f"• {pt}\n"
        else:
            why_bullets = f"• {headline}\n"

        risk_bullets = ""
        if analysis.risk_constraints:
            for rc in analysis.risk_constraints[:3]:
                text = rc.detail or rc.message or rc.title if hasattr(rc, "detail") else str(rc)
                risk_bullets += f"• {text}\n"
        else:
            risk_bullets = "• Volatility and data quality metrics within controlled operational boundaries\n"

        invalidation_bullets = ""
        if analysis.uncertainties:
            for u in analysis.uncertainties[:3]:
                invalidation_bullets += f"• Breakdown in {u.factor}: {u.explanation}\n"
        else:
            invalidation_bullets = "• Breakdown below important structural support\n• Weakening volume momentum\n• Significant adverse market catalyst\n"

        data_bullets = ""
        all_evidence = analysis.primary_evidence + analysis.supporting_evidence
        if all_evidence:
            for ev in all_evidence[:3]:
                data_bullets += f"• [{ev.category.value}] {ev.title}: {ev.detail or ev.message}\n"
        else:
            data_bullets = f"• Synthesized across 7 specialist agents and 12 quantitative strategies\n"

        ans = (
            f"### {sym} — ANALYSIS\n\n"
            f"**Market Stance:** {stance}\n"
            f"**Confidence:** {conf:.1f}% ({clarity} Clarity)\n"
            f"**Risk Profile:** {risk_lvl} ({risk_score:.1f}/100) | **Opportunity:** {opp_score:.1f}/100\n\n"
            f"### WHY\n"
            f"{why_bullets}\n"
            f"### RISKS\n"
            f"{risk_bullets}\n"
            f"### WHAT WOULD CHANGE THE VIEW\n"
            f"{invalidation_bullets}\n"
            f"### DATA & EVIDENCE\n"
            f"{data_bullets}\n"
            f"*This is analytical decision-support information and not an automatic trading action.*"
        )
        return ans

    # -----------------------------------------------------------------------
    # 6. Prompt Construction & Grounding
    # -----------------------------------------------------------------------

    def build_llm_prompt(
        self,
        query: str,
        context: Dict[str, Any],
        history: List[Dict[str, str]],
        intent: CopilotIntent,
        depth: CopilotDepth,
        response_mode: str = "DETAILED",
    ) -> str:
        """
        Builds a strictly grounded prompt instructing the LLM to reason ONLY over the ORBIT context.
        """
        history_snippet = ""
        if history:
            history_snippet = "\n".join(f"{h['role'].upper()}: {h['content']}" for h in history[-4:])

        prompt = f"""You are the ORBIT AI Market Intelligence Copilot, an elite quantitative decision-support assistant.
Your responsibility is to explain, clarify, and reason over ORBIT's actual intelligence output.

STRICT OPERATIONAL RULES:
1. GROUNDING ONLY: Answer ONLY using the factual ORBIT Analysis Context provided below.
2. ZERO HALLUCINATION: If a metric, indicator, price target, or detail is NOT in the context, explicitly state: "This information is not available in the current ORBIT analysis." NEVER invent numbers, dates, or prices.
3. FINANCIAL BOUNDARY: You are an analytical explainer. You do NOT execute trades, place orders, guarantee profits, or provide personal financial advice.
4. UNCERTAINTY HONESTY: If the market stance has low confidence or mixed signals, communicate that clearly. Never convert uncertainty into false certainty.
5. FORMATTING & READABILITY: Avoid large unstructured walls of text. Use clean markdown with clear headers (### WHY, ### RISKS, ### WHAT WOULD CHANGE THE VIEW).
6. RESPONSE MODE: User requested mode is '{response_mode}'.
   - If QUICK: Provide a short, punchy 3-bullet summary.
   - If EXPLAIN_SIMPLY: Explain everything in plain English for a beginner without financial jargon.
   - If DETAILED: Provide deep institutional reasoning with distinct sections.
7. Always conclude with: "*This is analytical decision-support information and not an automatic trading action.*"

ACTIVE ORBIT ANALYSIS CONTEXT (GROUND TRUTH):
{context}

RECENT CONVERSATION HISTORY:
{history_snippet or "No previous messages."}

USER QUESTION:
{query}

ANSWER (grounded strictly in ORBIT data, structured and readable):"""
        return prompt

    # -----------------------------------------------------------------------
    # 7. Follow-up Question Suggestion Generator
    # -----------------------------------------------------------------------

    def generate_suggested_followups(
        self, analysis: Optional[ExplainabilityEvaluationResult], intent: CopilotIntent
    ) -> List[str]:
        """Generates dynamic, context-aware suggested questions for the user."""
        if not analysis:
            return [
                "What stocks can ORBIT analyze?",
                "How does the consensus engine work?",
                "What data is required for a complete analysis?",
            ]

        stance = analysis.market_stance.value
        suggestions = []

        if intent == CopilotIntent.DECISION_STANCE:
            suggestions = [
                f"What are the biggest risks to this {stance.lower()} stance?",
                "What evidence supports this decision?",
                "What would invalidate this analysis?",
            ]
        elif intent == CopilotIntent.RISK_CONSTRAINTS:
            suggestions = [
                "What do the AI agents disagree on?",
                "What is the opportunity score for this asset?",
                f"Explain this {stance.lower()} setup simply.",
            ]
        elif intent == CopilotIntent.AGENT_DISAGREEMENT:
            suggestions = [
                "Which quantitative strategies triggered setups?",
                "How did Consensus resolve these conflicts?",
                "What are the primary risk constraints?",
            ]
        else:
            suggestions = [
                f"Why is the stance {stance.lower()}?",
                "What are the biggest risks?",
                "Explain this analysis simply.",
            ]

        return suggestions[:3]

    # -----------------------------------------------------------------------
    # 8. Main Chat Execution Pipeline
    # -----------------------------------------------------------------------

    async def chat(self, request: CopilotChatRequest) -> CopilotChatResponse:
        """
        Executes the complete Copilot pipeline:
        Validation -> Context Resolution -> Intent Classification ->
        Context Selection -> Reasoning (LLM or Deterministic Fallback) ->
        Structured Verification -> Response.
        """
        t0 = time.perf_counter()
        raw_msg = request.message.strip()
        timeframe = request.timeframe.strip() if request.timeframe else "1d"
        selected_market = request.selected_market or "US Stocks"
        response_mode = (request.response_mode or "DETAILED").upper()

        # 1. Active symbol resolution from query, selected_asset, or symbol
        provided_sym = (request.selected_asset or request.symbol or "").strip().upper()

        # Check if user query explicitly mentions a common ticker (e.g. "Analyze NVDA", "What about AAPL")
        ticker_match = re.search(r"\b([A-Z]{1,5}(?:-[A-Z]{2,4}|=[A-Z]{1,3})?)\b", raw_msg)
        if ticker_match and ticker_match.group(1) not in ("A", "I", "AN", "OR", "AT", "WHY", "WHAT", "HOW", "IS", "THE"):
            candidate = ticker_match.group(1)
            # If query is asking about a specific ticker, prioritize that
            if any(k in raw_msg.lower() for k in ["analyze", "about", "for", "check", "outlook", "risks for"]):
                provided_sym = candidate

        # 2. Manage Conversation Session with Persistence
        cid, history = self.get_or_create_session(
            request.conversation_id,
            provided_sym,
            user_id=request.user_id,
            market=selected_market,
        )

        # Fallback to session active symbol if query had no symbol
        active_sym = provided_sym or self._sessions.get(cid, {}).get("symbol", "")

        # 3. Classify Intent & Depth
        detected_intent, detected_depth = self.classify_intent(raw_msg)
        depth = request.depth or detected_depth

        if not active_sym:
            return CopilotChatResponse(
                ok=True,
                answer="Please specify an asset ticker symbol (e.g. BTC-USD, NVDA, AAPL) so ORBIT can retrieve the relevant market intelligence.",
                symbol="",
                timeframe=timeframe,
                conversation_id=cid,
                intent=detected_intent,
                depth=depth,
                context_available=False,
                suggested_followups=["Why is BTC-USD bullish?", "Analyze NVDA", "What stocks can ORBIT analyze?"],
                warnings=["No active asset symbol specified."],
                latency_ms=round((time.perf_counter() - t0) * 1000.0, 2),
            )

        # 4. Context Resolution (Phases 2-10 via Explainability Engine)
        analysis = await self.get_or_resolve_analysis(active_sym, timeframe=timeframe)

        # Handle Missing or Unresolvable Market Data
        if (
            not analysis
            or analysis.status in (ExplainabilityStatus.FAILED, ExplainabilityStatus.INSUFFICIENT_DATA)
            or analysis.market_stance == MarketStance.INSUFFICIENT_DATA
        ):
            answer = (
                f"### {active_sym} — ANALYSIS\n\n"
                f"**Market Stance:** INSUFFICIENT_DATA\n"
                f"**Confidence:** 0.0%\n\n"
                f"### LIMITATION\n"
                f"• Verified market data or active ORBIT analysis for **{active_sym}** ({timeframe}) is currently unavailable.\n"
                f"• Please verify the ticker symbol or wait for market data feed synchronization.\n\n"
                f"*This is analytical decision-support information and not an automatic trading action.*"
            )
            self.append_message(cid, "user", raw_msg, metadata={"symbol": active_sym, "market": selected_market})
            self.append_message(cid, "assistant", answer, metadata={"symbol": active_sym, "market": selected_market, "status": "INSUFFICIENT_DATA"})
            latency = round((time.perf_counter() - t0) * 1000.0, 2)
            return CopilotChatResponse(
                ok=True,
                answer=answer,
                symbol=active_sym,
                timeframe=timeframe,
                conversation_id=cid,
                intent=detected_intent,
                depth=depth,
                context_summary=None,
                context_available=False,
                suggested_followups=self.generate_suggested_followups(None, detected_intent),
                warnings=["Insufficient market data to conduct authoritative reasoning."],
                latency_ms=latency,
            )

        # 5. Context Selection & Alpha Vantage Quote Enrichment
        filtered_context = self.select_context(analysis, detected_intent, depth)
        
        # Enrich with live Alpha Vantage / provider quote if available
        try:
            live_quote = await self.market_service.get_quote(active_sym)
            if live_quote:
                filtered_context["live_market_data"] = {
                    "price": live_quote.price,
                    "change": live_quote.change,
                    "change_percent": live_quote.change_percent,
                    "open": live_quote.open,
                    "high": live_quote.high,
                    "low": live_quote.low,
                    "volume": live_quote.volume,
                    "source": live_quote.source,
                    "timestamp": live_quote.timestamp,
                }
        except Exception as e:
            logger.debug(f"Copilot: Live quote enrichment skipped for {active_sym}: {e}")

        summary = CopilotContextSummary(
            symbol=analysis.symbol,
            timeframe=analysis.timeframe,
            market_stance=analysis.market_stance.value,
            confidence=analysis.decision_confidence,
            clarity=analysis.decision_clarity,
            risk_level=analysis.input_summary.risk_level,
            risk_score=analysis.input_summary.risk_score,
            opportunity_score=analysis.input_summary.opportunity_score,
            opportunity_level=analysis.input_summary.opportunity_level,
            active_setups_count=len(analysis.why),
            conflicts_count=len(analysis.conflicts),
            analysis_status=analysis.status.value,
        )

        # 6. LLM Reasoning with Guardrails & Response Mode
        prompt = self.build_llm_prompt(raw_msg, filtered_context, history, detected_intent, depth, response_mode=response_mode)

        # Execute LLM in thread with 15-second timeout
        llm_answer = ""
        try:
            llm_answer = await asyncio.wait_for(
                asyncio.to_thread(generate_text, prompt, None, "Copilot"),
                timeout=15.0,
            )
            llm_answer = llm_answer.strip()
        except asyncio.TimeoutError:
            logger.warning(f"Copilot: LLM request timed out after 15s for {active_sym}. Triggering deterministic fallback.")
        except Exception as exc:
            logger.warning(f"Copilot: LLM invocation error: {exc}. Triggering deterministic fallback.")

        # 7. Response Synthesis & Deterministic Fallback Validation
        if not llm_answer:
            answer = self.synthesize_deterministic_fallback(raw_msg, analysis, detected_intent, depth, response_mode=response_mode)
        else:
            answer = llm_answer

        # 8. Update Session & Database History
        self.append_message(cid, "user", raw_msg, metadata={"symbol": active_sym, "market": selected_market})
        self.append_message(
            cid,
            "assistant",
            answer,
            metadata={
                "symbol": active_sym,
                "market": selected_market,
                "market_stance": analysis.market_stance.value,
                "confidence": analysis.decision_confidence,
                "response_mode": response_mode,
            },
        )

        latency = round((time.perf_counter() - t0) * 1000.0, 2)
        followups = self.generate_suggested_followups(analysis, detected_intent)

        return CopilotChatResponse(
            ok=True,
            answer=answer,
            symbol=active_sym,
            timeframe=timeframe,
            conversation_id=cid,
            intent=detected_intent,
            depth=depth,
            context_summary=summary,
            context_available=True,
            suggested_followups=followups,
            warnings=[],
            latency_ms=latency,
        )


# Global Singleton Instance
copilot_service = CopilotService()
