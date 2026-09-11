"""
ai-service/services/opportunity_engine.py — ORBIT Trade Opportunity Evaluation Engine (Phase 8).

Centralized, deterministic, explainable, and modular trade opportunity evaluation system.
Synthesizes intelligence from:
  - Phase 2: Market Data System (MarketDataService)
  - Phase 3: AI Agent Intelligence (AgentOrchestrator — 7 agents)
  - Phase 4: Trading Strategy Engine (StrategyEngine — 12 quantitative strategies)
  - Phase 5: Consensus Engine (ConsensusEngine — synthesis layer)
  - Phase 6: ORBIT Brain (OrbitBrain — master analysis context)
  - Phase 7: ORBIT Risk Guard (RiskGuard — safety analysis)

Answers: "Based on all available analysis, how strong or weak is the current market opportunity?"
Strict Operational Boundary: Evaluates analytical opportunity quality; does NOT execute trades,
generate orders, connect to brokers, or allocate portfolio capital.
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
from models.risk import RiskEvaluationResult, RiskLevel, RiskStatus
from models.opportunity import (
    FactorImpact,
    OpportunityDiagnostics,
    OpportunityDimension,
    OpportunityDimensions,
    OpportunityEvaluationResult,
    OpportunityFactor,
    OpportunityLevel,
    OpportunityStatus,
)
from services.orbit_brain import OrbitBrain, orbit_brain
from services.risk_guard import RiskGuard, risk_guard

logger = logging.getLogger("orbit.opportunity_engine")


class OpportunityEngine:
    """
    Central Trade Opportunity Evaluation Engine for ORBIT (Phase 8).

    Synthesizes multi-system intelligence to evaluate current market opportunity quality.
    Evaluates:
      1. Consensus Quality (Strength, agreement, and directional thrust)
      2. Strategy Confluence (Active setup triggers and directional alignment)
      3. Agent Harmony (Multi-agent agreement and perspective confluence)
      4. Risk Headroom (Inverse of Risk Guard score: 100 - risk_score)
      5. Analysis Completeness (Pipeline verification and data integrity)
    """

    def __init__(
        self,
        brain: Optional[OrbitBrain] = None,
        guard: Optional[RiskGuard] = None,
    ):
        self.brain = brain or orbit_brain
        self.risk_guard = guard or risk_guard

    async def evaluate_opportunity(
        self,
        symbol: str,
        timeframe: str = "1d",
        brain_context: Optional[BrainAnalysisContext] = None,
        risk_result: Optional[RiskEvaluationResult] = None,
        df: Optional[pd.DataFrame] = None,
    ) -> OpportunityEvaluationResult:
        """
        Evaluates analytical market opportunity quality for a given symbol and timeframe.
        Guarantees zero duplicate computations by reusing Brain and Risk Guard contexts.
        """
        t0 = time.perf_counter()
        upper_sym = symbol.strip().upper()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        contexts_reused = (brain_context is not None) and (risk_result is not None)
        brain_ms = 0.0
        risk_ms = 0.0

        # -------------------------------------------------------------------
        # 1. Acquire Structured Master Context (Phase 6 Brain)
        # -------------------------------------------------------------------
        if brain_context is None:
            t_b = time.perf_counter()
            try:
                brain_context = await self.brain.synthesize_analysis(upper_sym, timeframe=timeframe, df=df)
            except Exception as exc:
                logger.error(f"OpportunityEngine: Failed to synthesize Brain context for {upper_sym}: {exc}", exc_info=True)
                return self._create_fatal_result(upper_sym, timeframe, now_str, f"Brain synthesis error: {str(exc)}", t0)
            brain_ms = round((time.perf_counter() - t_b) * 1000.0, 2)

        # -------------------------------------------------------------------
        # 2. Acquire Structured Risk Context (Phase 7 Risk Guard)
        # -------------------------------------------------------------------
        if risk_result is None:
            t_r = time.perf_counter()
            try:
                risk_result = await self.risk_guard.evaluate_risk(
                    upper_sym, timeframe=timeframe, brain_context=brain_context, df=df
                )
            except Exception as exc:
                logger.error(f"OpportunityEngine: Failed to evaluate Risk Guard for {upper_sym}: {exc}", exc_info=True)
                return self._create_fatal_result(upper_sym, timeframe, now_str, f"Risk Guard error: {str(exc)}", t0)
            risk_ms = round((time.perf_counter() - t_r) * 1000.0, 2)

        # -------------------------------------------------------------------
        # 3. Check for Critical Upstream Failures (Anti-False-Opportunity)
        # -------------------------------------------------------------------
        if brain_context.analysis_status == BrainStatus.FAILED or risk_result.status == RiskStatus.FAILED:
            return self._create_fatal_result(
                upper_sym, timeframe, now_str,
                f"Upstream pipeline failure: {brain_context.executive_summary}",
                t0, brain_ms=brain_ms, risk_ms=risk_ms, contexts_reused=contexts_reused
            )

        if brain_context.analysis_status == BrainStatus.INSUFFICIENT_DATA or risk_result.status == RiskStatus.INSUFFICIENT_DATA:
            return self._create_insufficient_data_result(
                upper_sym, timeframe, now_str,
                f"Insufficient historical data ({brain_context.market_summary.data_points} candles available)",
                t0, brain_ms=brain_ms, risk_ms=risk_ms, contexts_reused=contexts_reused
            )

        # -------------------------------------------------------------------
        # 4. Evaluate 5 Core Opportunity Dimensions Deterministically
        # -------------------------------------------------------------------
        t_eval = time.perf_counter()

        dim_consensus = self._eval_consensus_quality(brain_context)
        dim_strategy = self._eval_strategy_confluence(brain_context)
        dim_agent = self._eval_agent_harmony(brain_context)
        dim_risk = self._eval_risk_headroom(risk_result)
        dim_quality = self._eval_analysis_completeness(brain_context)

        dimensions = OpportunityDimensions(
            consensus_quality=dim_consensus,
            strategy_confluence=dim_strategy,
            agent_harmony=dim_agent,
            risk_headroom=dim_risk,
            analysis_completeness=dim_quality,
        )

        # -------------------------------------------------------------------
        # 5. Composite Opportunity Score & Weight Attribution
        # -------------------------------------------------------------------
        # Standard weights: Consensus (25%), Strategy (25%), Agent (20%), Risk (20%), Quality (10%)
        composite_score = (
            (dim_consensus.score * dim_consensus.weight) +
            (dim_strategy.score * dim_strategy.weight) +
            (dim_agent.score * dim_agent.weight) +
            (dim_risk.score * dim_risk.weight) +
            (dim_quality.score * dim_quality.weight)
        )
        composite_score = round(min(100.0, max(0.0, composite_score)), 1)

        opportunity_level = self._score_to_opportunity_level(composite_score)

        # Determine operational status
        if brain_context.analysis_status == BrainStatus.READY and risk_result.status == RiskStatus.READY:
            status = OpportunityStatus.READY
        elif brain_context.analysis_status == BrainStatus.PARTIAL or risk_result.status == RiskStatus.PARTIAL:
            status = OpportunityStatus.PARTIAL
        else:
            status = OpportunityStatus.LIMITED

        # -------------------------------------------------------------------
        # 6. Extract Concrete Strength Factors (Boosters)
        # -------------------------------------------------------------------
        strength_factors: List[OpportunityFactor] = []

        # Consensus boosters
        if brain_context.consensus_summary.agreement_level == AgreementLevel.HIGH:
            strength_factors.append(OpportunityFactor(
                factor_id="CONSENSUS_HIGH_AGREEMENT",
                category="CONSENSUS",
                impact=FactorImpact.POSITIVE,
                title="High Cross-System Agreement",
                detail=f"{brain_context.consensus_summary.agreement_score:.0f}% of evaluated agents and strategies align in unified directional consensus."
            ))

        if brain_context.consensus_summary.strength >= 70.0 and brain_context.overall_bias != ConsensusSignal.NEUTRAL:
            strength_factors.append(OpportunityFactor(
                factor_id="CONSENSUS_STRONG_THRUST",
                category="CONSENSUS",
                impact=FactorImpact.POSITIVE,
                title="Decisive Directional Thrust",
                detail=f"Consensus conviction is robust at {brain_context.consensus_summary.strength:.1f}/100 toward {brain_context.overall_bias.value}."
            ))

        # Strategy boosters
        if brain_context.strategy_summary.setups_found >= 2:
            names = ", ".join(brain_context.strategy_summary.active_strategies[:3])
            strength_factors.append(OpportunityFactor(
                factor_id="STRATEGY_MULTI_SETUP_CONFLUENCE",
                category="STRATEGY",
                impact=FactorImpact.POSITIVE,
                title="Multiple Aligned Strategy Setups",
                detail=f"{brain_context.strategy_summary.setups_found} quantitative strategies triggered simultaneous setups: {names}."
            ))
        elif brain_context.strategy_summary.setups_found == 1:
            name = brain_context.strategy_summary.active_strategies[0] if brain_context.strategy_summary.active_strategies else "Quantitative Model"
            strength_factors.append(OpportunityFactor(
                factor_id="STRATEGY_ACTIVE_SETUP",
                category="STRATEGY",
                impact=FactorImpact.POSITIVE,
                title="Active Strategy Setup Triggered",
                detail=f"Verified technical setup active: {name} ({brain_context.strategy_summary.average_confidence:.0f}% confidence)."
            ))

        # Agent boosters
        if dim_agent.score >= 70.0:
            strength_factors.append(OpportunityFactor(
                factor_id="AGENT_STRONG_ALIGNMENT",
                category="AGENTS",
                impact=FactorImpact.POSITIVE,
                title="Multi-Agent Perspective Alignment",
                detail=f"Strong agent confluence with majority of specialist models confirming {brain_context.overall_bias.value} bias."
            ))

        # Risk headroom boosters
        if risk_result.risk_level == RiskLevel.LOW:
            strength_factors.append(OpportunityFactor(
                factor_id="RISK_FAVORABLE_HEADROOM",
                category="RISK",
                impact=FactorImpact.POSITIVE,
                title="Low Analytical Risk Environment",
                detail=f"Risk Guard reports low composite risk ({risk_result.risk_score:.1f}/100); generous safety headroom."
            ))

        # Quality booster
        if brain_context.completeness_tier == CompletenessTier.COMPLETE:
            strength_factors.append(OpportunityFactor(
                factor_id="QUALITY_FULL_VERIFICATION",
                category="QUALITY",
                impact=FactorImpact.POSITIVE,
                title="100% Pipeline Verification",
                detail="All 7 AI agents, 12 strategies, consensus, and risk dimensions verified without faults."
            ))

        # -------------------------------------------------------------------
        # 7. Extract Concrete Weakness Factors (Headwinds)
        # -------------------------------------------------------------------
        weakness_factors: List[OpportunityFactor] = []

        # Consensus headwinds
        if brain_context.consensus_summary.signal == ConsensusSignal.MIXED:
            weakness_factors.append(OpportunityFactor(
                factor_id="CONSENSUS_POLAR_DEADLOCK",
                category="CONSENSUS",
                impact=FactorImpact.NEGATIVE,
                title="Consensus Deadlock (MIXED)",
                detail="Consensus engine detected an unresolved standoff between bullish and bearish models; directional opportunity is neutralized."
            ))
        elif brain_context.consensus_summary.signal == ConsensusSignal.NEUTRAL:
            weakness_factors.append(OpportunityFactor(
                factor_id="CONSENSUS_NEUTRAL_EQUILIBRIUM",
                category="CONSENSUS",
                impact=FactorImpact.NEGATIVE,
                title="Neutral Market Equilibrium",
                detail="Market is consolidating without decisive directional momentum or clear imbalance."
            ))

        # Strategy headwinds
        if brain_context.strategy_summary.setups_found == 0:
            weakness_factors.append(OpportunityFactor(
                factor_id="STRATEGY_NO_ACTIVE_SETUPS",
                category="STRATEGY",
                impact=FactorImpact.NEGATIVE,
                title="No Active Strategy Setups",
                detail="Zero quantitative strategies detected entry trigger criteria; market is in transition or consolidation."
            ))
        elif brain_context.strategy_summary.bullish_setups > 0 and brain_context.strategy_summary.bearish_setups > 0:
            weakness_factors.append(OpportunityFactor(
                factor_id="STRATEGY_CONTRADICTORY_SETUPS",
                category="STRATEGY",
                impact=FactorImpact.NEGATIVE,
                title="Contradictory Strategy Triggers",
                detail=f"Both bullish ({brain_context.strategy_summary.bullish_setups}) and bearish ({brain_context.strategy_summary.bearish_setups}) setups are active simultaneously."
            ))

        # Agent headwinds
        if len(brain_context.key_conflicting_evidence) >= 3:
            weakness_factors.append(OpportunityFactor(
                factor_id="AGENT_CROSS_CONFLICT",
                category="AGENTS",
                impact=FactorImpact.NEGATIVE,
                title="Noticeable Model Disagreement",
                detail=f"{len(brain_context.key_conflicting_evidence)} specialist agents/indicators actively oppose the leading market view."
            ))

        # Risk headwinds
        if risk_result.risk_level in (RiskLevel.HIGH, RiskLevel.CRITICAL):
            weakness_factors.append(OpportunityFactor(
                factor_id="RISK_ELEVATED_HEADWIND",
                category="RISK",
                impact=FactorImpact.NEGATIVE,
                title=f"Elevated Market Risk ({risk_result.risk_level.value})",
                detail=f"Risk Guard flagged elevated risk ({risk_result.risk_score:.1f}/100) due to volatility expansion or model divergence."
            ))

        # Quality headwinds
        if brain_context.completeness_tier in (CompletenessTier.PARTIAL, CompletenessTier.LIMITED):
            weakness_factors.append(OpportunityFactor(
                factor_id="QUALITY_PARTIAL_DATA",
                category="QUALITY",
                impact=FactorImpact.NEGATIVE,
                title="Partial Analysis Completeness",
                detail=f"Analysis pipeline is {brain_context.completeness_score:.0f}% complete; uncalculated components diminish conviction."
            ))

        # -------------------------------------------------------------------
        # 8. Synthesize Executive Narrative Summary
        # -------------------------------------------------------------------
        leading_bias = brain_context.overall_bias.value
        summary = self._generate_executive_summary(
            upper_sym, opportunity_level, composite_score, leading_bias,
            brain_context.strategy_summary.setups_found, risk_result.risk_level
        )

        eval_ms = round((time.perf_counter() - t_eval) * 1000.0, 2)
        total_ms = round(eval_ms + brain_ms + risk_ms, 2)

        return OpportunityEvaluationResult(
            symbol=upper_sym,
            timeframe=timeframe,
            timestamp=now_str,
            opportunity_level=opportunity_level,
            opportunity_score=composite_score,
            status=status,
            leading_bias=leading_bias,
            summary=summary,
            dimensions=dimensions,
            strength_factors=strength_factors,
            weakness_factors=weakness_factors,
            unavailable_dimensions=[],
            diagnostics=OpportunityDiagnostics(
                opportunity_latency_ms=eval_ms,
                brain_latency_ms=brain_ms,
                risk_latency_ms=risk_ms,
                total_latency_ms=total_ms,
                contexts_reused=contexts_reused,
                dimensions_evaluated=5,
            ),
        )

    # =======================================================================
    # DIMENSION EVALUATION METHODS
    # =======================================================================

    def _eval_consensus_quality(self, ctx: BrainAnalysisContext) -> OpportunityDimension:
        """
        Evaluates consensus conviction and directional clarity.
        Weight: 25% (0.25)
        """
        sig = ctx.consensus_summary.signal
        strength = ctx.consensus_summary.strength
        agreement = ctx.consensus_summary.agreement_score

        if sig in (ConsensusSignal.BULLISH, ConsensusSignal.BEARISH):
            score = (strength * 0.5) + (agreement * 0.5)
            summary = f"Decisive {sig.value} consensus with {strength:.1f}/100 conviction and {agreement:.0f}% agreement."
        elif sig == ConsensusSignal.NEUTRAL:
            score = min(35.0, strength * 0.4)
            summary = "Neutral market equilibrium; lack of directional force suppresses opportunity."
        else:  # MIXED
            score = min(20.0, strength * 0.25)
            summary = "Consensus polar deadlock (MIXED); acute cross-model conflict."

        score = round(min(100.0, max(0.0, score)), 1)
        return OpportunityDimension(
            dimension_id="consensus_quality",
            name="Consensus Quality",
            score=score,
            weight=0.25,
            summary=summary,
            metrics={
                "signal": sig.value,
                "strength": strength,
                "agreement_score": agreement,
                "agreement_level": ctx.consensus_summary.agreement_level.value,
            },
            status="EVALUATED",
        )

    def _eval_strategy_confluence(self, ctx: BrainAnalysisContext) -> OpportunityDimension:
        """
        Evaluates presence and alignment of active quantitative strategy setups.
        Weight: 25% (0.25)
        """
        st = ctx.strategy_summary
        n_setups = st.setups_found
        bull = st.bullish_setups
        bear = st.bearish_setups
        conf = st.average_confidence

        if n_setups == 0:
            score = 15.0
            summary = "No active quantitative setups triggered; technical entry conditions unfulfilled."
        elif bull > 0 and bear > 0:
            score = 30.0
            summary = f"Conflicting setups active ({bull} Bull vs {bear} Bear); opposing trigger signals."
        elif n_setups == 1:
            score = 55.0 + (conf * 0.3)
            name = st.active_strategies[0] if st.active_strategies else "Setup"
            summary = f"1 active setup verified ({name}) with {conf:.0f}% model confidence."
        elif n_setups == 2:
            score = 75.0 + (conf * 0.15)
            summary = f"2 aligned setups triggered simultaneously ({', '.join(st.active_strategies[:2])})."
        else:
            score = min(98.0, 85.0 + (conf * 0.12))
            summary = f"Robust confluence: {n_setups} aligned setups active ({', '.join(st.active_strategies[:3])})."

        score = round(min(100.0, max(5.0, score)), 1)
        return OpportunityDimension(
            dimension_id="strategy_confluence",
            name="Strategy Confluence",
            score=score,
            weight=0.25,
            summary=summary,
            metrics={
                "setups_found": n_setups,
                "bullish_setups": bull,
                "bearish_setups": bear,
                "active_strategies": st.active_strategies,
                "average_confidence": conf,
            },
            status="EVALUATED",
        )

    def _eval_agent_harmony(self, ctx: BrainAnalysisContext) -> OpportunityDimension:
        """
        Evaluates the proportion of AI agents aligned with the dominant bias.
        Weight: 20% (0.20)
        """
        ag = ctx.agent_summary
        tally = ag.tally
        bias = ctx.overall_bias.value
        n_succ = max(1, ag.successful_agents)

        if bias == "BULLISH":
            aligned = tally.get("BULLISH", 0)
        elif bias == "BEARISH":
            aligned = tally.get("BEARISH", 0)
        else:
            aligned = tally.get("NEUTRAL", 0)

        ratio = aligned / n_succ
        score = min(100.0, max(10.0, ratio * 100.0))
        score = round(score, 1)

        summary = f"{aligned} of {n_succ} successful AI agents align directly with {bias} market view ({ratio*100:.0f}%)."

        return OpportunityDimension(
            dimension_id="agent_harmony",
            name="Agent Harmony",
            score=score,
            weight=0.20,
            summary=summary,
            metrics={
                "aligned_agents": aligned,
                "successful_agents": n_succ,
                "total_agents": ag.total_agents,
                "alignment_ratio": round(ratio, 2),
                "leading_signal": ag.leading_signal,
            },
            status="EVALUATED",
        )

    def _eval_risk_headroom(self, risk: RiskEvaluationResult) -> OpportunityDimension:
        """
        Translates Risk Guard findings into opportunity headroom (100 - risk_score).
        Weight: 20% (0.20)
        """
        r_score = risk.risk_score
        headroom = max(0.0, 100.0 - r_score)

        if risk.risk_level == RiskLevel.CRITICAL:
            headroom = min(20.0, headroom)
        elif risk.risk_level == RiskLevel.HIGH:
            headroom = min(40.0, headroom)

        headroom = round(headroom, 1)
        summary = f"Risk Guard reports {risk.risk_score:.1f}/100 risk ({risk.risk_level.value}). Headroom: {headroom:.1f}/100."

        return OpportunityDimension(
            dimension_id="risk_headroom",
            name="Risk Headroom",
            score=headroom,
            weight=0.20,
            summary=summary,
            metrics={
                "risk_score": r_score,
                "risk_level": risk.risk_level.value,
                "risk_status": risk.status.value,
            },
            status="EVALUATED",
        )

    def _eval_analysis_completeness(self, ctx: BrainAnalysisContext) -> OpportunityDimension:
        """
        Evaluates pipeline completeness and reliability.
        Weight: 10% (0.10)
        """
        comp = ctx.completeness_score
        tier = ctx.completeness_tier

        if tier == CompletenessTier.FAILED:
            score = 0.0
        else:
            score = comp

        score = round(min(100.0, max(0.0, score)), 1)
        summary = f"Analysis completeness is {comp:.0f}% ({tier.value})."

        return OpportunityDimension(
            dimension_id="analysis_completeness",
            name="Analysis Completeness",
            score=score,
            weight=0.10,
            summary=summary,
            metrics={"completeness_score": comp, "completeness_tier": tier.value},
            status="EVALUATED",
        )

    # =======================================================================
    # HELPER METHODS
    # =======================================================================

    @staticmethod
    def _score_to_opportunity_level(score: float) -> OpportunityLevel:
        """Deterministic mapping from 0-100 score to OpportunityLevel."""
        if score >= 80.0:
            return OpportunityLevel.VERY_HIGH
        elif score >= 65.0:
            return OpportunityLevel.HIGH
        elif score >= 45.0:
            return OpportunityLevel.MODERATE
        elif score >= 25.0:
            return OpportunityLevel.LOW
        else:
            return OpportunityLevel.VERY_LOW

    def _generate_executive_summary(
        self,
        symbol: str,
        level: OpportunityLevel,
        score: float,
        bias: str,
        n_setups: int,
        risk_lvl: RiskLevel,
    ) -> str:
        """Generates a professional, factual narrative explaining opportunity posture."""
        if level in (OpportunityLevel.VERY_HIGH, OpportunityLevel.HIGH):
            return (
                f"{symbol} demonstrates {level.value} analytical opportunity ({score}/100) favoring {bias}. "
                f"Multi-system confluence is pronounced with {n_setups} active setup(s) supported by a {risk_lvl.value} risk profile."
            )
        elif level == OpportunityLevel.MODERATE:
            return (
                f"{symbol} presents MODERATE opportunity ({score}/100) with {bias} tendency. "
                f"Technical conditions show developing momentum ({n_setups} active setups), though risk headwinds require disciplined entry criteria."
            )
        else:
            return (
                f"{symbol} reflects {level.value} opportunity quality ({score}/100). "
                f"Absence of confluent setups or elevated risk posture warrants patience until decisive market imbalance forms."
            )

    def _create_fatal_result(
        self,
        symbol: str,
        timeframe: str,
        timestamp: str,
        reason: str,
        t0: float,
        brain_ms: float = 0.0,
        risk_ms: float = 0.0,
        contexts_reused: bool = False,
    ) -> OpportunityEvaluationResult:
        """Generates structured VERY_LOW opportunity result when fatal upstream errors occur."""
        eval_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        total_ms = round(eval_ms + brain_ms + risk_ms, 2)

        fatal_dim = OpportunityDimension(
            dimension_id="system_fault",
            name="System Integrity",
            score=0.0,
            weight=0.20,
            summary=reason,
            metrics={"error": reason},
            status="FAILED",
        )

        return OpportunityEvaluationResult(
            symbol=symbol,
            timeframe=timeframe,
            timestamp=timestamp,
            opportunity_level=OpportunityLevel.VERY_LOW,
            opportunity_score=0.0,
            status=OpportunityStatus.FAILED,
            leading_bias="NONE",
            summary=f"Opportunity evaluation failed for {symbol}: {reason}. Opportunity quality cannot be determined.",
            dimensions=OpportunityDimensions(
                consensus_quality=fatal_dim,
                strategy_confluence=fatal_dim,
                agent_harmony=fatal_dim,
                risk_headroom=fatal_dim,
                analysis_completeness=fatal_dim,
            ),
            strength_factors=[],
            weakness_factors=[
                OpportunityFactor(
                    factor_id="FATAL_PIPELINE_ERROR",
                    category="SYSTEM",
                    impact=FactorImpact.NEGATIVE,
                    title="Fatal Upstream Analysis Failure",
                    detail=reason,
                )
            ],
            unavailable_dimensions=["ALL"],
            diagnostics=OpportunityDiagnostics(
                opportunity_latency_ms=eval_ms,
                brain_latency_ms=brain_ms,
                risk_latency_ms=risk_ms,
                total_latency_ms=total_ms,
                contexts_reused=contexts_reused,
                dimensions_evaluated=0,
            ),
        )

    def _create_insufficient_data_result(
        self,
        symbol: str,
        timeframe: str,
        timestamp: str,
        reason: str,
        t0: float,
        brain_ms: float = 0.0,
        risk_ms: float = 0.0,
        contexts_reused: bool = False,
    ) -> OpportunityEvaluationResult:
        """Generates structured INSUFFICIENT_DATA result (anti-false-opportunity guarantee)."""
        eval_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        total_ms = round(eval_ms + brain_ms + risk_ms, 2)

        insuf_dim = OpportunityDimension(
            dimension_id="data_scarcity",
            name="Data Scarcity",
            score=10.0,
            weight=0.20,
            summary=reason,
            metrics={"reason": reason},
            status="INSUFFICIENT_DATA",
        )

        return OpportunityEvaluationResult(
            symbol=symbol,
            timeframe=timeframe,
            timestamp=timestamp,
            opportunity_level=OpportunityLevel.VERY_LOW,
            opportunity_score=10.0,
            status=OpportunityStatus.INSUFFICIENT_DATA,
            leading_bias="UNKNOWN",
            summary=f"Insufficient data to evaluate trade opportunity on {symbol}. Opportunity defaults to VERY_LOW.",
            dimensions=OpportunityDimensions(
                consensus_quality=insuf_dim,
                strategy_confluence=insuf_dim,
                agent_harmony=insuf_dim,
                risk_headroom=insuf_dim,
                analysis_completeness=insuf_dim,
            ),
            strength_factors=[],
            weakness_factors=[
                OpportunityFactor(
                    factor_id="DATA_INSUFFICIENT",
                    category="DATA_QUALITY",
                    impact=FactorImpact.NEGATIVE,
                    title="Insufficient Market Data",
                    detail=reason,
                )
            ],
            unavailable_dimensions=["CONSENSUS", "STRATEGY", "AGENTS"],
            diagnostics=OpportunityDiagnostics(
                opportunity_latency_ms=eval_ms,
                brain_latency_ms=brain_ms,
                risk_latency_ms=risk_ms,
                total_latency_ms=total_ms,
                contexts_reused=contexts_reused,
                dimensions_evaluated=0,
            ),
        )


# Global singleton instance
opportunity_engine = OpportunityEngine()
