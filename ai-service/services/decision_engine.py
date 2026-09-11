"""
ai-service/services/decision_engine.py — ORBIT Decision Engine (Phase 9).

Centralized, deterministic, explainable, and evidence-based market stance synthesis system.
Synthesizes intelligence across the full ORBIT stack:
  - Phase 6: ORBIT Brain (BrainAnalysisContext)
  - Phase 7: ORBIT Risk Guard (RiskEvaluationResult)
  - Phase 8: Trade Opportunity Engine (OpportunityEvaluationResult)
  - (And through Brain context: Phase 3 AI Agents, Phase 4 Strategies, Phase 5 Consensus)

Answers: "Given all currently available ORBIT analysis, what is the strongest supported MARKET STANCE?"
Strict Operational Boundary: Evaluates analytical market stances (BULLISH, BEARISH, NEUTRAL, MIXED,
NO_CLEAR_DECISION, INSUFFICIENT_DATA). Does NOT execute trades, generate orders, connect to brokers,
or allocate portfolio capital.
"""

import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

import pandas as pd

from models.brain import (
    BrainAnalysisContext,
    BrainStatus,
    CompletenessTier,
)
from models.consensus import ConsensusSignal, AgreementLevel, ConsensusStatus
from models.decision import (
    DecisionClarity,
    DecisionDiagnostics,
    DecisionEvaluationResult,
    DecisionInputSummary,
    DecisionStatus,
    MarketStance,
)
from models.opportunity import (
    OpportunityEvaluationResult,
    OpportunityLevel,
    OpportunityStatus,
)
from models.risk import RiskEvaluationResult, RiskLevel, RiskStatus
from services.opportunity_engine import OpportunityEngine, opportunity_engine
from services.orbit_brain import OrbitBrain, orbit_brain
from services.risk_guard import RiskGuard, risk_guard

logger = logging.getLogger("orbit.decision_engine")


class DecisionEngine:
    """
    Central Decision Engine for ORBIT (Phase 9).

    Synthesizes multi-system intelligence into a definitive, explainable market stance:
      - BULLISH / BEARISH / NEUTRAL / MIXED / NO_CLEAR_DECISION / INSUFFICIENT_DATA
    Accompanied by:
      - Evidence Confidence (0-100)
      - Decision Clarity (CLEAR, MODERATE, UNCLEAR, INSUFFICIENT)
      - Factual Primary and Supporting Evidence
      - Analytical Constraints and Explicit Conflicts
    """

    def __init__(
        self,
        brain: Optional[OrbitBrain] = None,
        guard: Optional[RiskGuard] = None,
        opp_engine: Optional[OpportunityEngine] = None,
    ):
        self.brain = brain or orbit_brain
        self.risk_guard = guard or risk_guard
        self.opp_engine = opp_engine or opportunity_engine

    async def evaluate_decision(
        self,
        symbol: str,
        timeframe: str = "1d",
        brain_context: Optional[BrainAnalysisContext] = None,
        risk_result: Optional[RiskEvaluationResult] = None,
        opp_result: Optional[OpportunityEvaluationResult] = None,
        df: Optional[pd.DataFrame] = None,
    ) -> DecisionEvaluationResult:
        """
        Synthesizes the entire ORBIT intelligence stack into a deterministic market stance.
        Guarantees zero duplicate computations by reusing Brain, Risk Guard, and Opportunity contexts.
        """
        t0 = time.perf_counter()
        upper_sym = symbol.strip().upper()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        contexts_reused = (brain_context is not None) and (risk_result is not None) and (opp_result is not None)
        brain_ms = 0.0
        risk_ms = 0.0
        opp_ms = 0.0

        # -------------------------------------------------------------------
        # 1. Acquire Structured Upstream Contexts
        # -------------------------------------------------------------------
        if brain_context is None:
            t_b = time.perf_counter()
            try:
                brain_context = await self.brain.synthesize_analysis(upper_sym, timeframe=timeframe, df=df)
            except Exception as exc:
                logger.error(f"DecisionEngine: Failed to synthesize Brain context for {upper_sym}: {exc}", exc_info=True)
                return self._create_fatal_result(upper_sym, timeframe, now_str, f"Brain synthesis error: {str(exc)}", t0)
            brain_ms = round((time.perf_counter() - t_b) * 1000.0, 2)

        if risk_result is None:
            t_r = time.perf_counter()
            try:
                risk_result = await self.risk_guard.evaluate_risk(
                    symbol=upper_sym, timeframe=timeframe, brain_context=brain_context, df=df
                )
            except Exception as exc:
                logger.error(f"DecisionEngine: Failed to evaluate Risk Guard for {upper_sym}: {exc}", exc_info=True)
                return self._create_fatal_result(upper_sym, timeframe, now_str, f"Risk Guard error: {str(exc)}", t0, brain_ms)
            risk_ms = round((time.perf_counter() - t_r) * 1000.0, 2)

        if opp_result is None:
            t_o = time.perf_counter()
            try:
                opp_result = await self.opp_engine.evaluate_opportunity(
                    symbol=upper_sym, timeframe=timeframe, brain_context=brain_context, risk_result=risk_result, df=df
                )
            except Exception as exc:
                logger.error(f"DecisionEngine: Failed to evaluate Opportunity Engine for {upper_sym}: {exc}", exc_info=True)
                return self._create_fatal_result(upper_sym, timeframe, now_str, f"Opportunity error: {str(exc)}", t0, brain_ms, risk_ms)
            opp_ms = round((time.perf_counter() - t_o) * 1000.0, 2)

        # -------------------------------------------------------------------
        # 2. Safety Gate 1: Upstream Data & Pipeline Integrity Check
        # -------------------------------------------------------------------
        if (
            brain_context.analysis_status in [BrainStatus.FAILED, BrainStatus.INSUFFICIENT_DATA]
            or risk_result.status in [RiskStatus.FAILED, RiskStatus.INSUFFICIENT_DATA]
            or opp_result.status in [OpportunityStatus.FAILED, OpportunityStatus.INSUFFICIENT_DATA]
        ):
            reason = (
                f"Upstream pipeline failure for {upper_sym}: "
                f"Brain={brain_context.analysis_status.value}, Risk={risk_result.status.value}, Opp={opp_result.status.value}."
            )
            return self._create_insufficient_result(
                symbol=upper_sym,
                timeframe=timeframe,
                timestamp=now_str,
                summary=f"Cannot formulate market stance for {upper_sym}: {reason}",
                t0=t0,
                brain_ms=brain_ms,
                risk_ms=risk_ms,
                opp_ms=opp_ms,
                contexts_reused=contexts_reused,
                brain_ctx=brain_context,
                risk_res=risk_result,
                opp_res=opp_result,
            )

        # -------------------------------------------------------------------
        # 3. Extract Core Metrics from Upstream Stack
        # -------------------------------------------------------------------
        cs = brain_context.consensus_summary
        cs_signal = cs.signal.value  # "BULLISH", "BEARISH", "NEUTRAL", "MIXED"
        cs_strength = float(cs.strength)
        cs_agreement = float(cs.agreement_score)

        st = brain_context.strategy_summary
        st_bull = int(st.bullish_setups)
        st_bear = int(st.bearish_setups)
        st_active = list(st.active_strategies)

        ag = brain_context.agent_summary
        ag_tally = ag.tally
        ag_bull = int(ag_tally.get("BULLISH", 0))
        ag_bear = int(ag_tally.get("BEARISH", 0))
        ag_neutral = int(ag_tally.get("NEUTRAL", 0))
        ag_total = max(1, ag.successful_agents)

        r_score = float(risk_result.risk_score)
        r_level = risk_result.risk_level.value  # "LOW", "MODERATE", "HIGH", "CRITICAL"

        o_score = float(opp_result.opportunity_score)
        o_level = opp_result.opportunity_level.value  # "VERY_LOW", "LOW", "MODERATE", "HIGH", "VERY_HIGH"

        comp_score = float(brain_context.completeness_score)
        comp_tier = brain_context.completeness_tier.value

        # -------------------------------------------------------------------
        # 4. Explicit Cross-System Conflict Detection
        # -------------------------------------------------------------------
        conflicts: List[str] = []

        # Conflict A: Strategy triggers directly oppose each other
        if st_bull > 0 and st_bear > 0:
            conflicts.append(
                f"Contradictory quantitative strategy triggers: {st_bull} bullish setup(s) vs {st_bear} bearish setup(s) active simultaneously."
            )

        # Conflict B: AI Agents diverge from Strategy Setups
        if ag_bull > ag_bear and st_bear > st_bull and st_bear > 0:
            conflicts.append(
                f"Cross-system divergence: AI Agents lean Bullish ({ag_bull} agents) while Quantitative Strategies triggered Bearish setups ({st_bear} setups)."
            )
        elif ag_bear > ag_bull and st_bull > st_bear and st_bull > 0:
            conflicts.append(
                f"Cross-system divergence: AI Agents lean Bearish ({ag_bear} agents) while Quantitative Strategies triggered Bullish setups ({st_bull} setups)."
            )

        # Conflict C: Consensus deadlocked / Polar split
        if cs_signal == "MIXED":
            conflicts.append(
                f"Consensus engine reports polar deadlock (MIXED); opposing buying and selling forces are in equilibrium."
            )

        # Conflict D: High Directional Conviction vs Severe Risk
        if cs_strength >= 60.0 and r_score >= 65.0:
            conflicts.append(
                f"High directional conviction ({cs_strength:.1f}/100) contradicts elevated analytical risk ({r_score:.1f}/100, {r_level})."
            )

        # Conflict E: Strong Signal vs Very Low Opportunity
        if (cs_signal in ["BULLISH", "BEARISH"]) and o_level in ["VERY_LOW", "LOW"] and cs_strength >= 50.0:
            conflicts.append(
                f"Directional consensus is established ({cs_signal}) but overall opportunity confluence is suppressed ({o_score:.1f}/100, {o_level})."
            )

        # -------------------------------------------------------------------
        # 5. Deterministic Market Stance Formulation (Rules Engine)
        # -------------------------------------------------------------------
        decision: MarketStance
        primary_evidence: List[str] = []
        supporting_evidence: List[str] = []
        constraints: List[str] = []

        # Gate 2: Polar Deadlock / High Conflict with Poor Opportunity
        if cs_signal == "MIXED" or (st_bull > 0 and st_bear > 0 and st_bull == st_bear and cs_agreement < 45.0):
            if o_level in ["VERY_LOW", "LOW"]:
                decision = MarketStance.NO_CLEAR_DECISION
                primary_evidence.append("Severe multi-system conflict combined with weak setup opportunity prevents clear stance.")
            else:
                decision = MarketStance.MIXED
                primary_evidence.append(f"Strong bidirectional momentum forces active simultaneously ({st_bull} Bull vs {st_bear} Bear setups).")

        # Gate 3: Critical Analytical Risk (R >= 75) + Low Opportunity
        elif r_score >= 75.0 and o_level in ["VERY_LOW", "LOW"]:
            decision = MarketStance.NO_CLEAR_DECISION
            primary_evidence.append(f"Critical analytical risk ({r_score:.1f}/100) and low opportunity ({o_score:.1f}/100) negate directional stance.")
            constraints.append(f"Risk Guard reports {r_level} severity across volatility, conflict, and data dimensions.")

        # Gate 4: Cross-System Direct Deadlock (Strong opposite pull between Agents and Strategies)
        elif (ag_bull >= 4 and st_bear >= 2 and st_bull == 0) or (ag_bear >= 4 and st_bull >= 2 and st_bear == 0):
            decision = MarketStance.NO_CLEAR_DECISION
            primary_evidence.append("Severe divergence between AI agent sentiment and quantitative strategy triggers.")

        # Gate 5: Decisive Bullish Stance
        elif cs_signal == "BULLISH" and st_bull >= st_bear and ag_bull >= ag_bear:
            decision = MarketStance.BULLISH
            primary_evidence.append(f"Consensus verdict is BULLISH with {cs_strength:.1f}/100 strength and {cs_agreement:.1f}% model agreement.")
            if st_bull > 0:
                primary_evidence.append(f"{st_bull} quantitative strategy setup(s) triggered bullish entry ({', '.join(st_active) or 'Multiple'}).")
            if ag_bull > 0:
                supporting_evidence.append(f"{ag_bull} of {ag_total} AI specialist agents confirm bullish market regime.")

        # Gate 6: Decisive Bearish Stance
        elif cs_signal == "BEARISH" and st_bear >= st_bull and ag_bear >= ag_bull:
            decision = MarketStance.BEARISH
            primary_evidence.append(f"Consensus verdict is BEARISH with {cs_strength:.1f}/100 strength and {cs_agreement:.1f}% model agreement.")
            if st_bear > 0:
                primary_evidence.append(f"{st_bear} quantitative strategy setup(s) triggered bearish entry ({', '.join(st_active) or 'Multiple'}).")
            if ag_bear > 0:
                supporting_evidence.append(f"{ag_bear} of {ag_total} AI specialist agents confirm bearish market regime.")

        # Gate 7: Neutral / Consolidating Stance
        elif cs_signal == "NEUTRAL" and st_bull == 0 and st_bear == 0:
            decision = MarketStance.NEUTRAL
            primary_evidence.append(f"Market is in consolidation equilibrium; consensus reports NEUTRAL with {cs_agreement:.1f}% agreement.")
            supporting_evidence.append("Zero active directional strategy setups detected across all 12 quantitative models.")

        # Gate 8: Leaning Setup when Consensus is Neutral
        elif cs_signal == "NEUTRAL" and st_bull > st_bear and ag_bull >= ag_bear:
            decision = MarketStance.BULLISH
            primary_evidence.append(f"Emergent bullish momentum: {st_bull} active long setup(s) outnumbering neutral consensus bias.")
            if ag_bull > 0:
                supporting_evidence.append(f"{ag_bull} AI agents aligned with long-side setups.")

        elif cs_signal == "NEUTRAL" and st_bear > st_bull and ag_bear >= ag_bull:
            decision = MarketStance.BEARISH
            primary_evidence.append(f"Emergent bearish momentum: {st_bear} active short setup(s) outnumbering neutral consensus bias.")
            if ag_bear > 0:
                supporting_evidence.append(f"{ag_bear} AI agents aligned with short-side setups.")

        # Fallback: Ambiguous Evidence
        else:
            if len(conflicts) > 0:
                decision = MarketStance.NO_CLEAR_DECISION
                primary_evidence.append("Ambiguous evidence profile with unresolved cross-system conflicts.")
            elif cs_signal == "BULLISH":
                decision = MarketStance.BULLISH
                primary_evidence.append(f"Consensus leans BULLISH ({cs_strength:.1f}/100) despite isolated friction.")
            elif cs_signal == "BEARISH":
                decision = MarketStance.BEARISH
                primary_evidence.append(f"Consensus leans BEARISH ({cs_strength:.1f}/100) despite isolated friction.")
            else:
                decision = MarketStance.NEUTRAL
                primary_evidence.append("Neutral market regime with balanced analytical evidence.")

        # Add Supporting Evidence & Constraints from Upstream Stack
        if o_score >= 65.0:
            supporting_evidence.append(f"Opportunity Engine verifies {o_level} setup confluence ({o_score:.1f}/100).")
        elif o_score < 45.0:
            constraints.append(f"Opportunity quality is constrained ({o_score:.1f}/100, {o_level}).")

        if r_score < 35.0:
            supporting_evidence.append(f"Risk Guard confirms safe analytical environment ({r_score:.1f}/100, {r_level}).")
        elif r_score >= 55.0:
            constraints.append(f"Elevated analytical risk ({r_score:.1f}/100, {r_level}) imposes caution on directional conviction.")

        if comp_score >= 95.0:
            supporting_evidence.append(f"Complete pipeline verification: {comp_score:.1f}% verified execution across all subsystems.")
        elif comp_score < 80.0:
            constraints.append(f"Pipeline completeness is degraded ({comp_score:.1f}%, {comp_tier}).")

        # -------------------------------------------------------------------
        # 6. Deterministic Evidence Confidence Calculation (0 - 100)
        # -------------------------------------------------------------------
        # Base Evidence Score:
        #   35% Consensus Strength + 25% Agreement + 25% Opportunity Score + 15% Completeness
        base_confidence = (
            (cs_strength * 0.35)
            + (cs_agreement * 0.25)
            + (o_score * 0.25)
            + (comp_score * 0.15)
        )

        # Risk Drag: Elevated risk (>50) penalizes confidence
        if r_score > 50.0:
            risk_drag = (r_score - 50.0) * 0.40
            base_confidence -= risk_drag
        elif r_score < 30.0:
            base_confidence += 5.0  # Safe market stabilization bonus

        # Conflict Penalties
        if len(conflicts) > 0:
            conflict_penalty = min(25.0, len(conflicts) * 7.5)
            base_confidence -= conflict_penalty

        # Decision State Overrides
        if decision == MarketStance.NO_CLEAR_DECISION:
            base_confidence = min(base_confidence, 28.0)
        elif decision == MarketStance.MIXED:
            base_confidence = min(base_confidence, 38.0)
        elif decision == MarketStance.INSUFFICIENT_DATA:
            base_confidence = 0.0

        confidence = round(max(0.0, min(100.0, base_confidence)), 1)

        # -------------------------------------------------------------------
        # 7. Decision Clarity Tiering
        # -------------------------------------------------------------------
        clarity: DecisionClarity
        if decision == MarketStance.INSUFFICIENT_DATA:
            clarity = DecisionClarity.INSUFFICIENT
        elif decision in [MarketStance.NO_CLEAR_DECISION, MarketStance.MIXED]:
            clarity = DecisionClarity.UNCLEAR
        elif confidence >= 70.0 and r_score < 50.0 and len(conflicts) == 0:
            clarity = DecisionClarity.CLEAR
        elif confidence >= 48.0 and r_score < 65.0:
            clarity = DecisionClarity.MODERATE
        else:
            clarity = DecisionClarity.UNCLEAR

        # -------------------------------------------------------------------
        # 8. Executive Narrative Summary
        # -------------------------------------------------------------------
        summary = self._generate_executive_summary(
            symbol=upper_sym,
            decision=decision,
            confidence=confidence,
            clarity=clarity,
            cs_signal=cs_signal,
            r_level=r_level,
            o_level=o_level,
            conflicts_count=len(conflicts),
        )

        # -------------------------------------------------------------------
        # 9. Diagnostics and Status
        # -------------------------------------------------------------------
        decision_latency = round((time.perf_counter() - t0) * 1000.0, 2)
        total_latency = round(brain_ms + risk_ms + opp_ms + decision_latency, 2)

        status = DecisionStatus.READY
        if comp_tier in ["PARTIAL", "LIMITED"]:
            status = DecisionStatus.PARTIAL

        unavailable: List[str] = []
        if ag.failed_agents > 0:
            unavailable.append(f"{ag.failed_agents} AI agent(s) failed during evaluation")

        input_summary = DecisionInputSummary(
            consensus_signal=cs_signal,
            consensus_strength=round(cs_strength, 1),
            agreement_score=round(cs_agreement, 1),
            risk_score=round(r_score, 1),
            risk_level=r_level,
            opportunity_score=round(o_score, 1),
            opportunity_level=o_level,
            completeness_score=round(comp_score, 1),
            completeness_tier=comp_tier,
        )

        diagnostics = DecisionDiagnostics(
            decision_latency_ms=decision_latency,
            brain_latency_ms=brain_ms,
            risk_latency_ms=risk_ms,
            opportunity_latency_ms=opp_ms,
            total_latency_ms=total_latency,
            contexts_reused=contexts_reused,
        )

        return DecisionEvaluationResult(
            symbol=upper_sym,
            timeframe=timeframe,
            decision=decision,
            decision_confidence=confidence,
            decision_clarity=clarity,
            status=status,
            summary=summary,
            primary_evidence=primary_evidence,
            supporting_evidence=supporting_evidence,
            constraints=constraints,
            conflicts=conflicts,
            input_summary=input_summary,
            unavailable_inputs=unavailable,
            diagnostics=diagnostics,
            timestamp=now_str,
        )

    def _generate_executive_summary(
        self,
        symbol: str,
        decision: MarketStance,
        confidence: float,
        clarity: DecisionClarity,
        cs_signal: str,
        r_level: str,
        o_level: str,
        conflicts_count: int,
    ) -> str:
        """Constructs a deterministic, transparent explanation of the market stance."""
        if decision == MarketStance.BULLISH:
            return (
                f"{symbol} exhibits a {clarity.value} BULLISH market stance (Confidence: {confidence:.1f}/100). "
                f"Consensus conviction and active quantitative setups align favorably with {o_level} opportunity confluence "
                f"under a {r_level} risk profile."
            )
        elif decision == MarketStance.BEARISH:
            return (
                f"{symbol} exhibits a {clarity.value} BEARISH market stance (Confidence: {confidence:.1f}/100). "
                f"Consensus conviction and active quantitative setups indicate downward pressure with {o_level} opportunity confluence "
                f"under a {r_level} risk profile."
            )
        elif decision == MarketStance.NEUTRAL:
            return (
                f"{symbol} demonstrates a NEUTRAL market stance (Confidence: {confidence:.1f}/100, Clarity: {clarity.value}). "
                f"Consolidation conditions prevail with balanced buying/selling forces and zero active directional breakout setups."
            )
        elif decision == MarketStance.MIXED:
            return (
                f"{symbol} reflects a MIXED market stance (Confidence: {confidence:.1f}/100, Clarity: {clarity.value}). "
                f"Simultaneous conflicting bullish and bearish triggers create a volatile, polarized equilibrium."
            )
        elif decision == MarketStance.NO_CLEAR_DECISION:
            return (
                f"{symbol} yields NO_CLEAR_DECISION (Confidence: {confidence:.1f}/100, Clarity: {clarity.value}). "
                f"Elevated analytical friction ({conflicts_count} active conflict(s)), high risk ({r_level}), or weak opportunity ({o_level}) "
                f"preclude taking an authoritative market stance."
            )
        else:
            return f"{symbol} stance is INSUFFICIENT_DATA due to incomplete market history or upstream analysis failure."

    def _create_fatal_result(
        self,
        symbol: str,
        timeframe: str,
        timestamp: str,
        error_msg: str,
        t0: float,
        brain_ms: float = 0.0,
        risk_ms: float = 0.0,
        opp_ms: float = 0.0,
    ) -> DecisionEvaluationResult:
        """Generates a safe error result enforcing the anti-false-decision guarantee."""
        elapsed = round((time.perf_counter() - t0) * 1000.0, 2)
        return DecisionEvaluationResult(
            symbol=symbol,
            timeframe=timeframe,
            decision=MarketStance.INSUFFICIENT_DATA,
            decision_confidence=0.0,
            decision_clarity=DecisionClarity.INSUFFICIENT,
            status=DecisionStatus.FAILED,
            summary=f"Decision evaluation failed for {symbol}: {error_msg}. Market stance cannot be determined.",
            primary_evidence=[],
            supporting_evidence=[],
            constraints=["Fatal upstream error prevented market stance synthesis."],
            conflicts=[],
            input_summary=DecisionInputSummary(
                consensus_signal="UNKNOWN",
                consensus_strength=0.0,
                agreement_score=0.0,
                risk_score=100.0,
                risk_level="CRITICAL",
                opportunity_score=0.0,
                opportunity_level="VERY_LOW",
                completeness_score=0.0,
                completeness_tier="FAILED",
            ),
            unavailable_inputs=["Complete upstream pipeline unavailable"],
            diagnostics=DecisionDiagnostics(
                decision_latency_ms=elapsed,
                brain_latency_ms=brain_ms,
                risk_latency_ms=risk_ms,
                opportunity_latency_ms=opp_ms,
                total_latency_ms=round(brain_ms + risk_ms + opp_ms + elapsed, 2),
                contexts_reused=False,
            ),
            timestamp=timestamp,
        )

    def _create_insufficient_result(
        self,
        symbol: str,
        timeframe: str,
        timestamp: str,
        summary: str,
        t0: float,
        brain_ms: float,
        risk_ms: float,
        opp_ms: float,
        contexts_reused: bool,
        brain_ctx: Optional[BrainAnalysisContext] = None,
        risk_res: Optional[RiskEvaluationResult] = None,
        opp_res: Optional[OpportunityEvaluationResult] = None,
    ) -> DecisionEvaluationResult:
        """Safe handler for incomplete or missing historical market data."""
        elapsed = round((time.perf_counter() - t0) * 1000.0, 2)

        cs_sig = brain_ctx.consensus_summary.signal.value if brain_ctx else "UNKNOWN"
        cs_str = float(brain_ctx.consensus_summary.strength) if brain_ctx else 0.0
        cs_agr = float(brain_ctx.consensus_summary.agreement_score) if brain_ctx else 0.0
        r_sc = float(risk_res.risk_score) if risk_res else 100.0
        r_lv = risk_res.risk_level.value if risk_res else "CRITICAL"
        o_sc = float(opp_res.opportunity_score) if opp_res else 0.0
        o_lv = opp_res.opportunity_level.value if opp_res else "VERY_LOW"
        c_sc = float(brain_ctx.completeness_score) if brain_ctx else 0.0
        c_tr = brain_ctx.completeness_tier.value if brain_ctx else "FAILED"

        return DecisionEvaluationResult(
            symbol=symbol,
            timeframe=timeframe,
            decision=MarketStance.INSUFFICIENT_DATA,
            decision_confidence=0.0,
            decision_clarity=DecisionClarity.INSUFFICIENT,
            status=DecisionStatus.INSUFFICIENT_DATA,
            summary=summary,
            primary_evidence=[],
            supporting_evidence=[],
            constraints=["Insufficient historical market candles or pipeline execution."],
            conflicts=[],
            input_summary=DecisionInputSummary(
                consensus_signal=cs_sig,
                consensus_strength=cs_str,
                agreement_score=cs_agr,
                risk_score=r_sc,
                risk_level=r_lv,
                opportunity_score=o_sc,
                opportunity_level=o_lv,
                completeness_score=c_sc,
                completeness_tier=c_tr,
            ),
            unavailable_inputs=["Historical candle stream", "Validated pipeline context"],
            diagnostics=DecisionDiagnostics(
                decision_latency_ms=elapsed,
                brain_latency_ms=brain_ms,
                risk_latency_ms=risk_ms,
                opportunity_latency_ms=opp_ms,
                total_latency_ms=round(brain_ms + risk_ms + opp_ms + elapsed, 2),
                contexts_reused=contexts_reused,
            ),
            timestamp=timestamp,
        )


# Singleton instance for system-wide reuse
decision_engine = DecisionEngine()
