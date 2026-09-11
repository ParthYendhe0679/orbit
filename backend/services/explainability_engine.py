"""
backend/services/explainability_engine.py — ORBIT Explainability & Insight Engine (Phase 10).

Centralized, deterministic, explainable, and traceable insight synthesis system.
Answers the foundational user questions:
  - WHAT is the current market stance?
  - WHY did ORBIT reach this conclusion?
  - WHAT EVIDENCE supports the thesis?
  - WHAT CONFLICTS exist across models?
  - WHAT RISKS and CONSTRAINTS limit conviction?
  - WHAT IS UNCERTAIN or MISSING?

Strict Operational Boundary: Pure explanation layer. Does NOT execute trades, place orders,
manage broker connections, or allocate capital. Does NOT recalculate technical indicators,
rerun agents, or recompute upstream risk/opportunity/decision models.
"""

import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

import pandas as pd

from backend.models.brain import BrainAnalysisContext, BrainStatus
from backend.models.decision import DecisionEvaluationResult, MarketStance, DecisionClarity, DecisionStatus
from backend.models.explainability import (
    ConflictExplanation,
    ExplainabilityDiagnostics,
    ExplainabilityEvaluationResult,
    ExplainabilityInputSummary,
    ExplainabilityStatus,
    InsightCategory,
    SourceSubsystem,
    TraceableEvidenceItem,
    UncertaintyReason,
)
from backend.models.opportunity import OpportunityEvaluationResult, OpportunityStatus
from backend.models.risk import RiskEvaluationResult, RiskStatus
from backend.services.decision_engine import DecisionEngine, decision_engine
from backend.services.opportunity_engine import OpportunityEngine, opportunity_engine
from backend.services.orbit_brain import OrbitBrain, orbit_brain
from backend.services.risk_guard import RiskGuard, risk_guard

logger = logging.getLogger("orbit.explainability_engine")


class ExplainabilityEngine:
    """
    Central Explainability & Insight Engine for ORBIT (Phase 10).
    Transforms machine intelligence from Phases 2-9 into transparent, traceable,
    and human-understandable market insights.
    """

    def __init__(
        self,
        decision_svc: Optional[DecisionEngine] = None,
        brain_svc: Optional[OrbitBrain] = None,
        risk_svc: Optional[RiskGuard] = None,
        opp_svc: Optional[OpportunityEngine] = None,
    ):
        self.decision_engine = decision_svc or decision_engine
        self.brain = brain_svc or orbit_brain
        self.risk_guard = risk_svc or risk_guard
        self.opp_engine = opp_svc or opportunity_engine

    async def evaluate_explanation(
        self,
        symbol: str,
        timeframe: str = "1d",
        decision_result: Optional[DecisionEvaluationResult] = None,
        brain_context: Optional[BrainAnalysisContext] = None,
        risk_result: Optional[RiskEvaluationResult] = None,
        opp_result: Optional[OpportunityEvaluationResult] = None,
        df: Optional[pd.DataFrame] = None,
    ) -> ExplainabilityEvaluationResult:
        """
        Synthesizes structured, human-understandable market insights from existing upstream outputs.
        Guarantees zero duplicate calculations by reusing Decision, Brain, Risk, and Opportunity contexts.
        """
        t0 = time.perf_counter()
        upper_sym = symbol.strip().upper()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        contexts_reused = (decision_result is not None) and (brain_context is not None) and (risk_result is not None) and (opp_result is not None)
        decision_ms = 0.0

        # -------------------------------------------------------------------
        # 1. Acquire Structured Upstream Contexts
        # -------------------------------------------------------------------
        if brain_context is None:
            try:
                brain_context = await self.brain.synthesize_analysis(upper_sym, timeframe=timeframe, df=df)
            except Exception as exc:
                logger.error(f"ExplainabilityEngine: Brain synthesis error for {upper_sym}: {exc}", exc_info=True)
                return self._create_fatal_result(upper_sym, timeframe, now_str, f"Brain synthesis error: {str(exc)}", t0)

        if risk_result is None:
            try:
                risk_result = await self.risk_guard.evaluate_risk(symbol=upper_sym, timeframe=timeframe, brain_context=brain_context, df=df)
            except Exception as exc:
                logger.error(f"ExplainabilityEngine: Risk Guard error for {upper_sym}: {exc}", exc_info=True)
                return self._create_fatal_result(upper_sym, timeframe, now_str, f"Risk Guard error: {str(exc)}", t0)

        if opp_result is None:
            try:
                opp_result = await self.opp_engine.evaluate_opportunity(
                    symbol=upper_sym, timeframe=timeframe, brain_context=brain_context, risk_result=risk_result, df=df
                )
            except Exception as exc:
                logger.error(f"ExplainabilityEngine: Opportunity Engine error for {upper_sym}: {exc}", exc_info=True)
                return self._create_fatal_result(upper_sym, timeframe, now_str, f"Opportunity error: {str(exc)}", t0)

        if decision_result is None:
            t_d = time.perf_counter()
            try:
                decision_result = await self.decision_engine.evaluate_decision(
                    symbol=upper_sym,
                    timeframe=timeframe,
                    brain_context=brain_context,
                    risk_result=risk_result,
                    opp_result=opp_result,
                    df=df,
                )
            except Exception as exc:
                logger.error(f"ExplainabilityEngine: Decision Engine error for {upper_sym}: {exc}", exc_info=True)
                return self._create_fatal_result(upper_sym, timeframe, now_str, f"Decision Engine error: {str(exc)}", t0)
            decision_ms = round((time.perf_counter() - t_d) * 1000.0, 2)
        else:
            decision_ms = decision_result.diagnostics.decision_latency_ms

        # -------------------------------------------------------------------
        # 2. Safety Gate: Handle Failed or Insufficient Upstream Pipelines
        # -------------------------------------------------------------------
        if (
            decision_result.status in [DecisionStatus.FAILED, DecisionStatus.INSUFFICIENT_DATA]
            or brain_context.analysis_status in [BrainStatus.FAILED, BrainStatus.INSUFFICIENT_DATA]
            or risk_result.status in [RiskStatus.FAILED, RiskStatus.INSUFFICIENT_DATA]
            or opp_result.status in [OpportunityStatus.FAILED, OpportunityStatus.INSUFFICIENT_DATA]
        ):
            return self._create_insufficient_result(
                symbol=upper_sym,
                timeframe=timeframe,
                timestamp=now_str,
                t0=t0,
                decision_ms=decision_ms,
                contexts_reused=contexts_reused,
                dec_res=decision_result,
                brain_ctx=brain_context,
                risk_res=risk_result,
                opp_res=opp_result,
            )

        # -------------------------------------------------------------------
        # 3. Extract Upstream Metrics
        # -------------------------------------------------------------------
        stance = decision_result.decision.value  # "BULLISH", "BEARISH", "NEUTRAL", "MIXED", "NO_CLEAR_DECISION"
        conf = decision_result.decision_confidence
        clarity = decision_result.decision_clarity.value  # "CLEAR", "MODERATE", "UNCLEAR", "INSUFFICIENT"
        dec_status = decision_result.status.value

        cs = brain_context.consensus_summary
        cs_sig = cs.signal.value
        cs_str = float(cs.strength)
        cs_agr = float(cs.agreement_score)
        market_view = cs.market_view

        st = brain_context.strategy_summary
        bull_setups = st.bullish_setups
        bear_setups = st.bearish_setups
        active_strats = list(st.active_strategies)

        ag = brain_context.agent_summary
        ag_tally = ag.tally
        ag_bull = ag_tally.get("BULLISH", 0)
        ag_bear = ag_tally.get("BEARISH", 0)
        ag_total = max(1, ag.successful_agents)

        r_score = float(risk_result.risk_score)
        r_level = risk_result.risk_level.value

        o_score = float(opp_result.opportunity_score)
        o_level = opp_result.opportunity_level.value

        comp_score = float(brain_context.completeness_score)
        comp_tier = brain_context.completeness_tier.value

        # -------------------------------------------------------------------
        # 4. Formulate Headline and Core Thesis ("WHY?")
        # -------------------------------------------------------------------
        headline = self._build_headline(upper_sym, stance, conf, clarity, r_level, o_level)
        core_thesis = self._build_core_thesis(
            symbol=upper_sym,
            stance=stance,
            cs_sig=cs_sig,
            cs_str=cs_str,
            cs_agr=cs_agr,
            bull_setups=bull_setups,
            bear_setups=bear_setups,
            active_strats=active_strats,
            ag_bull=ag_bull,
            ag_bear=ag_bear,
            ag_total=ag_total,
            r_level=r_level,
            r_score=r_score,
            o_level=o_level,
            o_score=o_score,
            conflicts_count=len(decision_result.conflicts),
        )

        # -------------------------------------------------------------------
        # 5. Collect & Classify Traceable Evidence
        # -------------------------------------------------------------------
        primary_evidence: List[TraceableEvidenceItem] = []
        supporting_evidence: List[TraceableEvidenceItem] = []
        risk_constraints: List[TraceableEvidenceItem] = []
        conflicts: List[ConflictExplanation] = []
        uncertainties: List[UncertaintyReason] = []
        missing_info: List[str] = list(decision_result.unavailable_inputs)

        # Primary Evidence from Consensus Engine
        if cs_sig in ["BULLISH", "BEARISH"]:
            category = InsightCategory.POSITIVE_ALIGNMENT if cs_sig == "BULLISH" else InsightCategory.NEGATIVE_ALIGNMENT
            primary_evidence.append(
                TraceableEvidenceItem(
                    source=SourceSubsystem.CONSENSUS_ENGINE,
                    category=category,
                    title=f"Directional Consensus Alignment ({cs_sig})",
                    detail=f"Phase 5 Consensus synthesized an institutional {market_view} with {cs_str:.1f}/100 conviction and {cs_agr:.1f}% cross-model agreement.",
                    impact="HIGH",
                    metrics={"strength": cs_str, "agreement": cs_agr, "signal": cs_sig},
                )
            )
        elif cs_sig == "NEUTRAL":
            primary_evidence.append(
                TraceableEvidenceItem(
                    source=SourceSubsystem.CONSENSUS_ENGINE,
                    category=InsightCategory.NEUTRAL_EQUILIBRIUM,
                    title="Consolidation Equilibrium",
                    detail=f"Phase 5 Consensus detected balanced buying and selling pressures ({cs_agr:.1f}% model agreement on neutrality).",
                    impact="MEDIUM",
                    metrics={"strength": cs_str, "agreement": cs_agr},
                )
            )

        # Primary Evidence from Quantitative Strategy Setups
        if (stance == "BULLISH" and bull_setups > 0) or (stance == "BEARISH" and bear_setups > 0):
            strat_count = bull_setups if stance == "BULLISH" else bear_setups
            active_names = ", ".join(active_strats) if active_strats else "Multiple Quantitative Setups"
            primary_evidence.append(
                TraceableEvidenceItem(
                    source=SourceSubsystem.STRATEGY_ENGINE,
                    category=InsightCategory.POSITIVE_ALIGNMENT if stance == "BULLISH" else InsightCategory.NEGATIVE_ALIGNMENT,
                    title=f"Active Quantitative Strategy Setups ({strat_count} Triggered)",
                    detail=f"Empirical entry triggers verified across: {active_names}. Average strategy confidence: {st.average_confidence:.1f}%.",
                    impact="HIGH",
                    metrics={"setups_count": strat_count, "strategies": active_strats},
                )
            )
        elif bull_setups == 0 and bear_setups == 0:
            supporting_evidence.append(
                TraceableEvidenceItem(
                    source=SourceSubsystem.STRATEGY_ENGINE,
                    category=InsightCategory.NEUTRAL_EQUILIBRIUM,
                    title="Zero Directional Strategy Triggers",
                    detail="All 12 quantitative models evaluated market conditions as ranging without breakout triggers.",
                    impact="MEDIUM",
                    metrics={"strategies_evaluated": 12, "setups_found": 0},
                )
            )

        # Supporting Evidence from AI Specialist Agents
        aligning_agents = ag_bull if stance == "BULLISH" else (ag_bear if stance == "BEARISH" else ag.tally.get("NEUTRAL", 0))
        supporting_evidence.append(
            TraceableEvidenceItem(
                source=SourceSubsystem.AGENT_SYSTEM,
                category=InsightCategory.INFORMATIONAL,
                title=f"AI Specialist Agent Confirmation ({aligning_agents}/{ag_total} Aligned)",
                detail=f"{aligning_agents} of {ag_total} successful specialist agents confirm the {stance.lower()} perspective. Leading signal: {ag.leading_signal}.",
                impact="MEDIUM",
                metrics={"aligned_agents": aligning_agents, "total_agents": ag_total, "average_confidence": ag.average_confidence},
            )
        )

        # Supporting Evidence from Opportunity Engine
        if o_score >= 60.0:
            supporting_evidence.append(
                TraceableEvidenceItem(
                    source=SourceSubsystem.OPPORTUNITY_ENGINE,
                    category=InsightCategory.POSITIVE_ALIGNMENT,
                    title=f"Robust Opportunity Confluence ({o_score:.1f}/100)",
                    detail=f"Opportunity Engine evaluates setup confluence at {o_level} tier across consensus quality and strategy headroom.",
                    impact="MEDIUM",
                    metrics={"opportunity_score": o_score, "opportunity_level": o_level},
                )
            )
        else:
            risk_constraints.append(
                TraceableEvidenceItem(
                    source=SourceSubsystem.OPPORTUNITY_ENGINE,
                    category=InsightCategory.RISK_CONSTRAINT,
                    title=f"Constrained Opportunity Confluence ({o_score:.1f}/100)",
                    detail=f"Opportunity Engine notes {o_level} setup confluence, reducing conviction on aggressive positioning.",
                    impact="MEDIUM",
                    metrics={"opportunity_score": o_score, "opportunity_level": o_level},
                )
            )

        # Risk Constraints & Safety Headroom from Risk Guard
        if r_score < 35.0:
            supporting_evidence.append(
                TraceableEvidenceItem(
                    source=SourceSubsystem.RISK_GUARD,
                    category=InsightCategory.INFORMATIONAL,
                    title=f"Favorable Risk Environment ({r_score:.1f}/100, {r_level})",
                    detail=f"Phase 7 Risk Guard reports low analytical risk with generous safety headroom ({100.0 - r_score:.1f}/100).",
                    impact="MEDIUM",
                    metrics={"risk_score": r_score, "risk_level": r_level},
                )
            )
        else:
            risk_constraints.append(
                TraceableEvidenceItem(
                    source=SourceSubsystem.RISK_GUARD,
                    category=InsightCategory.RISK_CONSTRAINT,
                    title=f"Elevated Analytical Risk ({r_score:.1f}/100, {r_level})",
                    detail=f"Risk Guard flagged elevated friction across volatility and conflict dimensions, applying a drag on stance confidence.",
                    impact="HIGH" if r_score >= 65.0 else "MEDIUM",
                    metrics={"risk_score": r_score, "risk_level": r_level},
                )
            )

        # Ingest specific risk warnings from Risk Guard
        for rf in risk_result.risk_factors:
            sev_str = getattr(rf.severity, "value", str(rf.severity))
            risk_constraints.append(
                TraceableEvidenceItem(
                    source=SourceSubsystem.RISK_GUARD,
                    category=InsightCategory.RISK_CONSTRAINT,
                    title=f"Risk Warning: {rf.title}",
                    detail=rf.detail,
                    impact="HIGH" if sev_str in ["CRITICAL", "WARNING"] else "MEDIUM",
                    metrics={"factor_id": rf.factor_id, "category": rf.category, "severity": sev_str},
                )
            )

        # Completeness Evidence from ORBIT Brain
        if comp_score >= 95.0:
            supporting_evidence.append(
                TraceableEvidenceItem(
                    source=SourceSubsystem.ORBIT_BRAIN,
                    category=InsightCategory.INFORMATIONAL,
                    title=f"Complete Pipeline Verification ({comp_score:.1f}%)",
                    detail="100% verified execution across market data candles, 7 AI agents, 12 strategies, and consensus synthesis.",
                    impact="LOW",
                    metrics={"completeness_score": comp_score, "tier": comp_tier},
                )
            )
        else:
            risk_constraints.append(
                TraceableEvidenceItem(
                    source=SourceSubsystem.ORBIT_BRAIN,
                    category=InsightCategory.UNCERTAINTY_WARNING,
                    title=f"Degraded Pipeline Completeness ({comp_score:.1f}%, {comp_tier})",
                    detail="Incomplete analytical context limits total evidence fidelity.",
                    impact="MEDIUM",
                    metrics={"completeness_score": comp_score, "tier": comp_tier},
                )
            )

        # -------------------------------------------------------------------
        # 6. Parse & Structure Conflicts
        # -------------------------------------------------------------------
        for conf_str in decision_result.conflicts:
            if "quantitative strategy triggers" in conf_str.lower():
                conflicts.append(
                    ConflictExplanation(
                        conflict_type="STRATEGY_CONTRADICTION",
                        description=conf_str,
                        implication="Simultaneous active long and short setups neutralize directional momentum.",
                        conflicting_parties=["Bullish Strategies", "Bearish Strategies"],
                    )
                )
            elif "cross-system divergence" in conf_str.lower():
                conflicts.append(
                    ConflictExplanation(
                        conflict_type="AGENT_STRATEGY_DIVERGENCE",
                        description=conf_str,
                        implication="AI specialist agents and quantitative strategy triggers are pointing in opposite directions.",
                        conflicting_parties=["AI Specialist Agents", "Quantitative Strategy Engine"],
                    )
                )
            elif "polar deadlock" in conf_str.lower() or "mixed" in conf_str.lower():
                conflicts.append(
                    ConflictExplanation(
                        conflict_type="POLAR_CONSENSUS_DEADLOCK",
                        description=conf_str,
                        implication="Buying and selling forces are in perfect equilibrium; directional conviction is suppressed.",
                        conflicting_parties=["Buyer Force", "Seller Force"],
                    )
                )
            else:
                conflicts.append(
                    ConflictExplanation(
                        conflict_type="ANALYTICAL_FRICTION",
                        description=conf_str,
                        implication="Opposing analytical forces reduce decision clarity.",
                        conflicting_parties=["Consensus", "Risk Guard"],
                    )
                )

        # -------------------------------------------------------------------
        # 7. Formulate Uncertainty Reasons
        # -------------------------------------------------------------------
        if clarity in ["UNCLEAR", "MODERATE"]:
            if len(conflicts) > 0:
                uncertainties.append(
                    UncertaintyReason(
                        factor="Cross-System Disagreements",
                        explanation=f"{len(conflicts)} active conflict(s) detected between models, preventing clear consensus.",
                        severity="HIGH" if len(conflicts) >= 2 else "MODERATE",
                    )
                )
            if r_score >= 50.0:
                uncertainties.append(
                    UncertaintyReason(
                        factor="Elevated Market Risk",
                        explanation=f"Risk Guard composite score is {r_score:.1f}/100 ({r_level}), imposing caution.",
                        severity="HIGH" if r_score >= 70.0 else "MODERATE",
                    )
                )
            if o_score < 45.0:
                uncertainties.append(
                    UncertaintyReason(
                        factor="Low Setup Confluence",
                        explanation=f"Opportunity score is constrained at {o_score:.1f}/100, reflecting weak setup confluence.",
                        severity="MODERATE",
                    )
                )
            if cs_agr < 60.0:
                uncertainties.append(
                    UncertaintyReason(
                        factor="Low Model Agreement",
                        explanation=f"Only {cs_agr:.1f}% of analytical models agree on directional trajectory.",
                        severity="MODERATE",
                    )
                )
            if comp_score < 90.0:
                uncertainties.append(
                    UncertaintyReason(
                        factor="Incomplete Pipeline Execution",
                        explanation=f"Completeness is at {comp_score:.1f}% ({comp_tier}).",
                        severity="LOW",
                    )
                )

        # -------------------------------------------------------------------
        # 8. Assemble Diagnostics and Master Envelope
        # -------------------------------------------------------------------
        elapsed = round((time.perf_counter() - t0) * 1000.0, 2)
        total_lat = round(decision_ms + elapsed, 2)

        input_summary = ExplainabilityInputSummary(
            market_stance=stance,
            decision_confidence=round(conf, 1),
            decision_clarity=clarity,
            decision_status=dec_status,
            consensus_signal=cs_sig,
            consensus_strength=round(cs_str, 1),
            agreement_score=round(cs_agr, 1),
            risk_score=round(r_score, 1),
            risk_level=r_level,
            opportunity_score=round(o_score, 1),
            opportunity_level=o_level,
            completeness_score=round(comp_score, 1),
            completeness_tier=comp_tier,
        )

        diagnostics = ExplainabilityDiagnostics(
            explainability_latency_ms=elapsed,
            decision_latency_ms=decision_ms,
            total_latency_ms=total_lat,
            contexts_reused=contexts_reused,
        )

        exp_status = ExplainabilityStatus.READY
        if decision_result.status == DecisionStatus.PARTIAL:
            exp_status = ExplainabilityStatus.PARTIAL
        elif decision_result.status == DecisionStatus.LIMITED:
            exp_status = ExplainabilityStatus.LIMITED
        elif decision_result.status == DecisionStatus.INSUFFICIENT_DATA:
            exp_status = ExplainabilityStatus.INSUFFICIENT_DATA

        return ExplainabilityEvaluationResult(
            symbol=upper_sym,
            timeframe=timeframe,
            timestamp=now_str,
            status=exp_status,
            market_stance=stance,
            decision_confidence=round(conf, 1),
            decision_clarity=clarity,
            headline=headline,
            executive_summary=decision_result.summary,
            core_thesis=core_thesis,
            primary_evidence=primary_evidence,
            supporting_evidence=supporting_evidence,
            conflicts=conflicts,
            risk_constraints=risk_constraints,
            uncertainties=uncertainties,
            missing_information=missing_info,
            input_summary=input_summary,
            diagnostics=diagnostics,
        )

    def _build_headline(
        self,
        symbol: str,
        stance: str,
        conf: float,
        clarity: str,
        r_level: str,
        o_level: str,
    ) -> str:
        """Constructs a deterministic, concise headline."""
        if stance == "BULLISH":
            return f"{symbol} exhibits an authoritative BULLISH stance ({clarity} clarity, {conf:.1f}% confidence) under {r_level.lower()} risk."
        elif stance == "BEARISH":
            return f"{symbol} exhibits a decisive BEARISH stance ({clarity} clarity, {conf:.1f}% confidence) under {r_level.lower()} risk."
        elif stance == "NEUTRAL":
            return f"{symbol} is in consolidation equilibrium with balanced buying and selling pressures."
        elif stance == "MIXED":
            return f"{symbol} displays a polarized MIXED market stance with simultaneous conflicting momentum signals."
        elif stance == "NO_CLEAR_DECISION":
            return f"{symbol} yields NO_CLEAR_DECISION due to multi-system analytical conflicts and elevated uncertainty."
        else:
            return f"{symbol} market stance is INSUFFICIENT_DATA due to incomplete historical candles or pipeline errors."

    def _build_core_thesis(
        self,
        symbol: str,
        stance: str,
        cs_sig: str,
        cs_str: float,
        cs_agr: float,
        bull_setups: int,
        bear_setups: int,
        active_strats: List[str],
        ag_bull: int,
        ag_bear: int,
        ag_total: int,
        r_level: str,
        r_score: float,
        o_level: str,
        o_score: float,
        conflicts_count: int,
    ) -> List[str]:
        """Constructs 2-3 structured thesis bullet points answering 'WHY?'."""
        points: List[str] = []

        # Point 1: Consensus & Direction
        if cs_sig in ["BULLISH", "BEARISH"]:
            points.append(
                f"Consensus engine confirms {cs_sig} directional bias with {cs_str:.1f}/100 conviction strength and {cs_agr:.1f}% cross-model agreement."
            )
        elif cs_sig == "MIXED":
            points.append(
                "Consensus engine reports polar deadlock: buying and selling momentum forces are evenly matched."
            )
        else:
            points.append(
                f"Consensus engine indicates neutral consolidation equilibrium ({cs_agr:.1f}% agreement on lack of trend)."
            )

        # Point 2: Strategy Setups & Specialist Agents
        active_count = bull_setups if stance == "BULLISH" else (bear_setups if stance == "BEARISH" else (bull_setups + bear_setups))
        if active_count > 0:
            strat_text = f" ({', '.join(active_strats)})" if active_strats else ""
            align_agents = ag_bull if stance == "BULLISH" else ag_bear
            points.append(
                f"{active_count} quantitative strategy setup(s) triggered valid entry criteria{strat_text}, supported by {align_agents} of {ag_total} AI specialist agents."
            )
        else:
            points.append(
                "Zero active breakout strategy setups detected; market structure favors range-bound rotation over trending continuation."
            )

        # Point 3: Risk & Opportunity Environment
        if conflicts_count > 0:
            points.append(
                f"Conviction is constrained by {conflicts_count} active cross-system conflict(s) under a {r_level} risk profile ({r_score:.1f}/100)."
            )
        else:
            points.append(
                f"Market environment features {r_level} analytical risk ({r_score:.1f}/100) and {o_level} opportunity confluence ({o_score:.1f}/100)."
            )

        return points

    def _create_fatal_result(
        self,
        symbol: str,
        timeframe: str,
        timestamp: str,
        error_msg: str,
        t0: float,
    ) -> ExplainabilityEvaluationResult:
        """Safe fallback for unexpected fatal errors."""
        elapsed = round((time.perf_counter() - t0) * 1000.0, 2)
        return ExplainabilityEvaluationResult(
            symbol=symbol,
            timeframe=timeframe,
            timestamp=timestamp,
            status=ExplainabilityStatus.FAILED,
            market_stance="INSUFFICIENT_DATA",
            decision_confidence=0.0,
            decision_clarity="INSUFFICIENT",
            headline=f"Explainability synthesis failed for {symbol}: {error_msg}.",
            executive_summary=f"A fatal upstream error prevented insight generation for {symbol}.",
            core_thesis=["Upstream pipeline execution failed."],
            primary_evidence=[],
            supporting_evidence=[],
            conflicts=[],
            risk_constraints=[],
            uncertainties=[UncertaintyReason(factor="System Error", explanation=error_msg, severity="HIGH")],
            missing_information=["Full upstream analysis pipeline"],
            input_summary=ExplainabilityInputSummary(
                market_stance="INSUFFICIENT_DATA",
                decision_confidence=0.0,
                decision_clarity="INSUFFICIENT",
                decision_status="FAILED",
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
            diagnostics=ExplainabilityDiagnostics(
                explainability_latency_ms=elapsed,
                decision_latency_ms=0.0,
                total_latency_ms=elapsed,
                contexts_reused=False,
            ),
        )

    def _create_insufficient_result(
        self,
        symbol: str,
        timeframe: str,
        timestamp: str,
        t0: float,
        decision_ms: float,
        contexts_reused: bool,
        dec_res: Optional[DecisionEvaluationResult] = None,
        brain_ctx: Optional[BrainAnalysisContext] = None,
        risk_res: Optional[RiskEvaluationResult] = None,
        opp_res: Optional[OpportunityEvaluationResult] = None,
    ) -> ExplainabilityEvaluationResult:
        """Safe handler for missing data or delisted ticker scenarios."""
        elapsed = round((time.perf_counter() - t0) * 1000.0, 2)

        return ExplainabilityEvaluationResult(
            symbol=symbol,
            timeframe=timeframe,
            timestamp=timestamp,
            status=ExplainabilityStatus.INSUFFICIENT_DATA,
            market_stance="INSUFFICIENT_DATA",
            decision_confidence=0.0,
            decision_clarity="INSUFFICIENT",
            headline=f"Insufficient market data to produce an authoritative insight for {symbol}.",
            executive_summary=f"Historical candles could not be validated or the upstream pipeline reported insufficient data for {symbol}. ORBIT refuses to formulate an unjustified explanation.",
            core_thesis=["Market data stream is unavailable or delisted; no empirical setup confluence can be calculated."],
            primary_evidence=[],
            supporting_evidence=[],
            conflicts=[],
            risk_constraints=[
                TraceableEvidenceItem(
                    source=SourceSubsystem.DECISION_ENGINE,
                    category=InsightCategory.MISSING_DATA_NOTICE,
                    title="Missing Historical Market Data",
                    detail="Asset candles could not be retrieved from provider.",
                    impact="HIGH",
                    metrics={},
                )
            ],
            uncertainties=[
                UncertaintyReason(
                    factor="Missing Historical Market Data",
                    explanation="Asset candles could not be acquired or validated from provider.",
                    severity="HIGH",
                )
            ],
            missing_information=["Validated OHLCV candle dataset", "Upstream intelligence pipeline"],
            input_summary=ExplainabilityInputSummary(
                market_stance="INSUFFICIENT_DATA",
                decision_confidence=0.0,
                decision_clarity="INSUFFICIENT",
                decision_status="INSUFFICIENT_DATA",
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
            diagnostics=ExplainabilityDiagnostics(
                explainability_latency_ms=elapsed,
                decision_latency_ms=decision_ms,
                total_latency_ms=round(decision_ms + elapsed, 2),
                contexts_reused=contexts_reused,
            ),
        )


# Singleton instance for system-wide reuse
explainability_engine = ExplainabilityEngine()
