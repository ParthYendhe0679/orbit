"""
ai-service/services/risk_guard.py — ORBIT Risk Guard (Phase 7).

Centralized, deterministic, explainable, and modular risk evaluation system.
Evaluates the quality, reliability, and risk characteristics of the CURRENT MARKET ANALYSIS
by synthesizing intelligence from Phase 2 Market Data, Phase 3 AI Agents, Phase 4 Strategies,
Phase 5 Consensus, and Phase 6 ORBIT Brain.

Key Architectural Principles:
  - Consumes existing BrainAnalysisContext directly (zero duplicate network calls or indicator calculations).
  - Multi-dimensional deterministic scoring across 5 distinct risk pillars.
  - Transparent attribution: Every risk and safety factor is backed by concrete data.
  - Anti-False-Safety Guarantee: Incomplete or missing data NEVER returns LOW RISK.
  - Zero execution authority: Produces analytical safety evaluation, not trade executions.
"""

import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from models.brain import (
    BrainAnalysisContext,
    BrainStatus,
    CompletenessTier,
)
from models.consensus import ConsensusSignal, AgreementLevel, ConsensusStatus
from models.decision import DecisionEvaluationResult
from models.opportunity import OpportunityEvaluationResult
from models.risk import (
    BotGateCheck,
    BotTradeGateResult,
    DimensionAssessment,
    FactorSeverity,
    RiskDiagnostics,
    RiskDimensions,
    RiskEvaluationResult,
    RiskFactor,
    RiskLevel,
    RiskStatus,
    SafetyFactor,
)
from services.orbit_brain import OrbitBrain, orbit_brain

logger = logging.getLogger("orbit.risk_guard")


class RiskGuard:
    """
    Central Risk Intelligence and Safety Evaluation Engine for ORBIT (Phase 7).

    Answers: "How risky or unreliable is the current market analysis?"
    Evaluates:
      1. Volatility Risk (ATR % and historical price expansion)
      2. Signal Conflict Risk (Polar disagreement between agents and strategies)
      3. Consensus Risk (Conviction strength and directional alignment)
      4. Analysis Quality Risk (Completeness tier and component failure rates)
      5. Data Quality Risk (Candle sufficiency, gaps, and staleness)
    """

    def __init__(self, brain: Optional[OrbitBrain] = None):
        self.brain = brain or orbit_brain

    async def evaluate_risk(
        self,
        symbol: str,
        timeframe: str = "1d",
        brain_context: Optional[BrainAnalysisContext] = None,
        df: Optional[pd.DataFrame] = None,
    ) -> RiskEvaluationResult:
        """
        Evaluates analysis risk for a given symbol and timeframe.
        Reuses existing BrainAnalysisContext if provided; otherwise synthesizes via OrbitBrain.
        """
        t0 = time.perf_counter()
        upper_sym = symbol.strip().upper()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        brain_reused = brain_context is not None
        brain_ms = 0.0

        # -------------------------------------------------------------------
        # 1. Acquire Structured Master Analysis Context (Phase 6)
        # -------------------------------------------------------------------
        if brain_context is None:
            t_b = time.perf_counter()
            try:
                brain_context = await self.brain.synthesize_analysis(upper_sym, timeframe=timeframe, df=df)
            except Exception as exc:
                logger.error(f"RiskGuard: Failed to synthesize Brain context for {upper_sym}: {exc}", exc_info=True)
                return self._create_fatal_result(upper_sym, timeframe, now_str, f"Brain synthesis failed: {str(exc)}", t0)
            brain_ms = round((time.perf_counter() - t_b) * 1000.0, 2)

        # -------------------------------------------------------------------
        # 2. Check for Critical Upstream Failures (Anti-False-Safety Guard)
        # -------------------------------------------------------------------
        if brain_context.analysis_status == BrainStatus.FAILED:
            return self._create_fatal_result(
                upper_sym, timeframe, now_str,
                f"Market analysis failed upstream: {brain_context.executive_summary}",
                t0, brain_ms=brain_ms, brain_reused=brain_reused
            )

        if brain_context.analysis_status == BrainStatus.INSUFFICIENT_DATA:
            return self._create_insufficient_data_result(
                upper_sym, timeframe, now_str,
                f"Insufficient market data points ({brain_context.market_summary.data_points} candles available)",
                t0, brain_ms=brain_ms, brain_reused=brain_reused
            )

        # -------------------------------------------------------------------
        # 3. Evaluate the 5 Core Risk Dimensions Deterministically
        # -------------------------------------------------------------------
        t_eval = time.perf_counter()
        dim_vol = self._eval_volatility_risk(brain_context)
        dim_conflict = self._eval_signal_conflict_risk(brain_context)
        dim_consensus = self._eval_consensus_risk(brain_context)
        dim_quality = self._eval_analysis_quality_risk(brain_context)
        dim_data = self._eval_data_quality_risk(brain_context)

        dimensions = RiskDimensions(
            volatility=dim_vol,
            signal_conflict=dim_conflict,
            consensus=dim_consensus,
            analysis_quality=dim_quality,
            data_quality=dim_data,
        )

        all_dims = [dim_vol, dim_conflict, dim_consensus, dim_quality, dim_data]
        evaluated_dims = [d for d in all_dims if d.status == "EVALUATED"]
        unavailable_names = [d.name for d in all_dims if d.status != "EVALUATED"]

        # -------------------------------------------------------------------
        # 4. Composite Risk Score & Weighted Attribution
        # -------------------------------------------------------------------
        # Equal weighting across available dimensions (0.20 each nominally)
        n_eval = len(evaluated_dims)
        if n_eval == 0:
            return self._create_fatal_result(
                upper_sym, timeframe, now_str, "All risk dimensions unavailable", t0, brain_ms, brain_reused
            )

        equal_weight = round(1.0 / n_eval, 4)
        composite_score = 0.0
        for d in evaluated_dims:
            d.weight = equal_weight
            composite_score += d.score * equal_weight

        composite_score = round(min(100.0, max(0.0, composite_score)), 1)

        # Determine overall risk level from composite score
        overall_level = self._score_to_risk_level(composite_score)

        # Operational status
        if n_eval == 5:
            status = RiskStatus.READY
        elif n_eval >= 3:
            status = RiskStatus.PARTIAL
        else:
            status = RiskStatus.LIMITED

        # -------------------------------------------------------------------
        # 5. Extract Concrete Risk Warnings (Risk Factors)
        # -------------------------------------------------------------------
        risk_factors: List[RiskFactor] = []

        # Volatility warnings
        if dim_vol.score >= 70.0:
            risk_factors.append(RiskFactor(
                factor_id="VOL_EXPANSION_CRITICAL",
                category="VOLATILITY",
                severity=FactorSeverity.CRITICAL,
                title="Extreme Volatility Expansion",
                detail=f"ATR represents {brain_context.market_summary.volatility_pct:.2f}% of spot price; extreme price swings elevate whipsaw danger."
            ))
        elif dim_vol.score >= 50.0:
            risk_factors.append(RiskFactor(
                factor_id="VOL_ELEVATED",
                category="VOLATILITY",
                severity=FactorSeverity.WARNING,
                title="Elevated Volatility Regime",
                detail=f"ATR is {brain_context.market_summary.volatility_atr:.2f} ({brain_context.market_summary.volatility_pct:.2f}% of price); wider stop distances required."
            ))

        # Conflict warnings
        if dim_conflict.score >= 75.0:
            risk_factors.append(RiskFactor(
                factor_id="CONFLICT_POLAR_OPPOSITION",
                category="CONFLICT",
                severity=FactorSeverity.CRITICAL,
                title="Severe Cross-System Signal Polarisation",
                detail=f"Substantial opposing directional forces detected across AI agents and quantitative strategies ({len(brain_context.key_conflicting_evidence)} conflicting signals)."
            ))
        elif dim_conflict.score >= 40.0:
            risk_factors.append(RiskFactor(
                factor_id="CONFLICT_MODERATE_DIVERGENCE",
                category="CONFLICT",
                severity=FactorSeverity.CAUTION,
                title="Moderate Directional Disagreement",
                detail=f"{len(brain_context.key_conflicting_evidence)} indicators/setups contradict the majority market view."
            ))

        # Consensus warnings
        if brain_context.consensus_summary.signal == ConsensusSignal.MIXED:
            risk_factors.append(RiskFactor(
                factor_id="CONSENSUS_MIXED_DEADLOCK",
                category="CONSENSUS",
                severity=FactorSeverity.WARNING,
                title="Consensus Deadlock (MIXED)",
                detail="Consensus engine detected an unresolved standoff between bullish and bearish participants."
            ))
        elif dim_consensus.score >= 55.0:
            risk_factors.append(RiskFactor(
                factor_id="CONSENSUS_WEAK_CONVICTION",
                category="CONSENSUS",
                severity=FactorSeverity.WARNING,
                title="Weak Consensus Conviction",
                detail=f"Consensus conviction is low ({brain_context.consensus_summary.strength:.1f}/100) with agreement at {brain_context.consensus_summary.agreement_score:.1f}%."
            ))

        # Quality warnings
        if brain_context.completeness_tier in (CompletenessTier.PARTIAL, CompletenessTier.LIMITED):
            risk_factors.append(RiskFactor(
                factor_id="QUALITY_PARTIAL_SUBSYSTEMS",
                category="ANALYSIS_QUALITY",
                severity=FactorSeverity.CAUTION,
                title="Subsystem Evaluation Incomplete",
                detail=f"Completeness is at {brain_context.completeness_score:.1f}% ({brain_context.completeness_tier.value}); some agent or strategy checks failed to report."
            ))

        # Data warnings
        if dim_data.score >= 40.0:
            risk_factors.append(RiskFactor(
                factor_id="DATA_SPARSE_CANDLES",
                category="DATA_QUALITY",
                severity=FactorSeverity.CAUTION,
                title="Marginal Historical Data Window",
                detail=f"Only {brain_context.market_summary.data_points} candles available; statistical significance is reduced compared to ideal 100+ sample."
            ))

        # -------------------------------------------------------------------
        # 6. Extract Stabilizing Positive Conditions (Safety Factors)
        # -------------------------------------------------------------------
        safety_factors: List[SafetyFactor] = []

        if brain_context.consensus_summary.agreement_level == AgreementLevel.HIGH:
            safety_factors.append(SafetyFactor(
                factor_id="CONSENSUS_HIGH_ALIGNMENT",
                category="CONSENSUS",
                title="High Cross-System Agreement",
                detail=f"{brain_context.consensus_summary.agreement_score:.1f}% of evaluated agents and strategies align in unified directional consensus."
            ))

        if brain_context.consensus_summary.strength >= 75.0:
            safety_factors.append(SafetyFactor(
                factor_id="CONVICTION_STRONG",
                category="CONSENSUS",
                title="Robust Quantitative Conviction",
                detail=f"Consensus conviction score is strong at {brain_context.consensus_summary.strength:.1f}/100."
            ))

        if dim_vol.score <= 30.0:
            safety_factors.append(SafetyFactor(
                factor_id="VOLATILITY_STABLE",
                category="VOLATILITY",
                title="Controlled Volatility Environment",
                detail=f"Normalized ATR is calm at {brain_context.market_summary.volatility_pct:.2f}% of spot price; predictable boundary behavior."
            ))

        if brain_context.completeness_tier == CompletenessTier.COMPLETE:
            safety_factors.append(SafetyFactor(
                factor_id="QUALITY_COMPLETE_PIPELINE",
                category="ANALYSIS_QUALITY",
                title="100% Pipeline Verification",
                detail=f"All {brain_context.agent_summary.total_agents} AI agents and {brain_context.strategy_summary.strategies_evaluated} quantitative strategies executed without errors."
            ))

        if dim_conflict.score <= 20.0:
            safety_factors.append(SafetyFactor(
                factor_id="CONFLICT_MINIMAL",
                category="CONFLICT",
                title="Low Signal Contradiction",
                detail="Extremely low conflict; minimal contradictory signals across independent quantitative models."
            ))

        # -------------------------------------------------------------------
        # 7. Synthesize Executive Narrative Summary
        # -------------------------------------------------------------------
        summary = self._generate_executive_summary(
            upper_sym, overall_level, composite_score, status, dim_vol, dim_conflict, dim_consensus, brain_context
        )

        eval_ms = round((time.perf_counter() - t_eval) * 1000.0, 2)
        total_ms = round(eval_ms + brain_ms, 2)

        return RiskEvaluationResult(
            symbol=upper_sym,
            timeframe=timeframe,
            timestamp=now_str,
            risk_level=overall_level,
            risk_score=composite_score,
            status=status,
            summary=summary,
            dimensions=dimensions,
            risk_factors=risk_factors,
            safety_factors=safety_factors,
            unavailable_dimensions=unavailable_names,
            diagnostics=RiskDiagnostics(
                evaluation_latency_ms=eval_ms,
                brain_latency_ms=brain_ms,
                total_latency_ms=total_ms,
                brain_context_reused=brain_reused,
                dimensions_evaluated=n_eval,
            ),
        )

    # =======================================================================
    # DIMENSION EVALUATION METHODS
    # =======================================================================

    def _eval_volatility_risk(self, ctx: BrainAnalysisContext) -> DimensionAssessment:
        """
        Evaluates price volatility risk based on normalized ATR percentage.
        Formula: R_vol = min(100.0, max(10.0, (volatility_pct / 8.0) * 100.0))
        """
        atr_pct = ctx.market_summary.volatility_pct
        atr = ctx.market_summary.volatility_atr

        # Normalization scale: 8.0% ATR is considered 100% maximum volatility risk
        score = min(100.0, max(10.0, (atr_pct / 8.0) * 100.0))
        score = round(score, 1)

        level = self._score_to_risk_level(score)
        summary = (
            f"ATR is {atr:.2f} ({atr_pct:.2f}% of price). "
            f"{'Extreme expansion risk.' if score >= 75 else 'Elevated range fluctuations.' if score >= 55 else 'Controlled market volatility.'}"
        )

        return DimensionAssessment(
            dimension_id="volatility",
            name="Volatility Risk",
            score=score,
            level=level,
            weight=0.20,
            summary=summary,
            metrics={"atr": atr, "volatility_pct": atr_pct, "trend_regime": ctx.market_summary.trend_regime},
            status="EVALUATED",
        )

    def _eval_signal_conflict_risk(self, ctx: BrainAnalysisContext) -> DimensionAssessment:
        """
        Evaluates disagreement between AI agents and quantitative strategies.
        High conflict between long and short signals elevates whipsaw risk.
        """
        n_supp = len(ctx.key_supporting_evidence)
        n_conf = len(ctx.key_conflicting_evidence)
        total_evid = n_supp + n_conf

        if ctx.consensus_summary.signal == ConsensusSignal.MIXED:
            score = 88.0
            summary = "Consensus signal is MIXED with acute deadlock between long and short models."
        elif total_evid == 0:
            score = 65.0
            summary = "No evidence items available to evaluate directional harmony."
        else:
            conflict_ratio = n_conf / total_evid
            # Scale: 50% conflict ratio maps to 80 risk score
            score = min(100.0, max(10.0, conflict_ratio * 160.0))
            summary = f"{n_conf} conflicting evidence items vs {n_supp} supporting items ({conflict_ratio*100:.1f}% conflict ratio)."

        score = round(score, 1)
        level = self._score_to_risk_level(score)

        return DimensionAssessment(
            dimension_id="signal_conflict",
            name="Signal Conflict Risk",
            score=score,
            level=level,
            weight=0.20,
            summary=summary,
            metrics={
                "supporting_count": n_supp,
                "conflicting_count": n_conf,
                "total_evidence": total_evid,
                "is_mixed": ctx.consensus_summary.signal == ConsensusSignal.MIXED,
            },
            status="EVALUATED",
        )

    def _eval_consensus_risk(self, ctx: BrainAnalysisContext) -> DimensionAssessment:
        """
        Evaluates uncertainty in the Phase 5 consensus synthesis.
        Low strength or fragmented agreement implies higher analytical risk.
        """
        strength = ctx.consensus_summary.strength
        agreement = ctx.consensus_summary.agreement_score
        sig = ctx.consensus_summary.signal

        # Base consensus risk is inverse of quality: 100 - average(strength, agreement)
        quality = (strength * 0.5) + (agreement * 0.5)
        score = 100.0 - quality

        # Extra penalty if signal is neutral without conviction
        if sig == ConsensusSignal.NEUTRAL and strength < 50.0:
            score += 15.0

        score = round(min(95.0, max(5.0, score)), 1)
        level = self._score_to_risk_level(score)

        summary = (
            f"Consensus strength is {strength:.1f}/100 with {agreement:.1f}% agreement ({ctx.consensus_summary.agreement_level.value}). "
            f"Market view: '{ctx.consensus_summary.market_view}'."
        )

        return DimensionAssessment(
            dimension_id="consensus",
            name="Consensus Risk",
            score=score,
            level=level,
            weight=0.20,
            summary=summary,
            metrics={
                "strength": strength,
                "agreement_score": agreement,
                "agreement_level": ctx.consensus_summary.agreement_level.value,
                "consensus_signal": sig.value,
            },
            status="EVALUATED",
        )

    def _eval_analysis_quality_risk(self, ctx: BrainAnalysisContext) -> DimensionAssessment:
        """
        Evaluates pipeline completeness and failures across agents and strategies.
        Formula: R_quality = 100.0 - completeness_score
        """
        comp = ctx.completeness_score
        tier = ctx.completeness_tier

        if tier == CompletenessTier.FAILED:
            score = 100.0
        else:
            score = 100.0 - comp

        # Subsystem error penalties
        failed_agents = ctx.agent_summary.failed_agents
        if failed_agents > 0:
            score = min(100.0, score + (failed_agents * 5.0))

        score = round(min(100.0, max(0.0, score)), 1)
        level = self._score_to_risk_level(score)

        summary = (
            f"Analysis completeness is {comp:.1f}% ({tier.value}). "
            f"{ctx.agent_summary.successful_agents}/{ctx.agent_summary.total_agents} agents and "
            f"{ctx.strategy_summary.strategies_evaluated} strategies evaluated successfully."
        )

        return DimensionAssessment(
            dimension_id="analysis_quality",
            name="Analysis Quality Risk",
            score=score,
            level=level,
            weight=0.20,
            summary=summary,
            metrics={
                "completeness_score": comp,
                "completeness_tier": tier.value,
                "failed_agents": failed_agents,
                "successful_agents": ctx.agent_summary.successful_agents,
            },
            status="EVALUATED",
        )

    def _eval_data_quality_risk(self, ctx: BrainAnalysisContext) -> DimensionAssessment:
        """
        Evaluates candle sample sufficiency and data integrity.
        """
        n_bars = ctx.market_summary.data_points

        if n_bars >= 60:
            score = 10.0
            summary = f"Full historical dataset available ({n_bars} validated candles)."
        elif n_bars >= 50:
            score = 30.0
            summary = f"Adequate historical dataset ({n_bars} candles); meets minimum institutional requirements."
        elif n_bars >= 30:
            score = 60.0
            summary = f"Marginal historical dataset ({n_bars} candles); statistical indicators may carry wider confidence intervals."
        elif n_bars > 0:
            score = 85.0
            summary = f"Critically sparse candle history ({n_bars} candles); high probability of distorted indicators."
        else:
            score = 100.0
            summary = "Zero market candles available."

        score = round(score, 1)
        level = self._score_to_risk_level(score)

        return DimensionAssessment(
            dimension_id="data_quality",
            name="Data Quality Risk",
            score=score,
            level=level,
            weight=0.20,
            summary=summary,
            metrics={"data_points": n_bars, "timestamp": ctx.market_summary.timestamp},
            status="EVALUATED",
        )

    # =======================================================================
    # AUTO-TRADE BOT ENTRY GATE
    # =======================================================================

    # Ordinal ranks for the categorical outputs of the Decision and Opportunity
    # engines, so a configured minimum level can be compared.
    _CLARITY_RANK = {"INSUFFICIENT": 0, "UNCLEAR": 1, "MODERATE": 2, "CLEAR": 3}
    _OPPORTUNITY_RANK = {"VERY_LOW": 0, "LOW": 1, "MODERATE": 2, "HIGH": 3, "VERY_HIGH": 4}

    def evaluate_bot_trade_gate(
        self,
        *,
        symbol: str,
        session_status: str,
        entry_statuses,
        target_profit: float,
        max_loss: float,
        realized_pnl: float,
        loss_basis_pnl: float,
        allocated_capital: float,
        used_capital: float,
        has_open_position: bool,
        risk_result: Optional[RiskEvaluationResult],
        decision: Optional[DecisionEvaluationResult],
        opportunity: Optional[OpportunityEvaluationResult],
        blocked_risk_levels,
        min_decision_clarity: str,
        min_opportunity_level: str,
    ) -> BotTradeGateResult:
        """
        Decide whether a bot session may open a trade on `symbol`.

        Pure and deterministic: session limits come from the caller, market
        risk from evaluate_risk(). The thresholds (blocked risk levels, minimum
        clarity / opportunity level) are policy inputs, not constants here —
        their final values are still a product decision.
        """
        checks: List[BotGateCheck] = []
        rejections: List[RiskFactor] = []
        limit_breached: Optional[str] = None

        def check(check_id: str, passed: bool, detail: str, severity: FactorSeverity = FactorSeverity.WARNING, category: str = "BOT_SESSION"):
            checks.append(BotGateCheck(check_id=check_id, passed=passed, detail=detail))
            if not passed:
                rejections.append(RiskFactor(
                    factor_id=check_id, category=category, severity=severity,
                    title=check_id.replace("_", " ").title(), detail=detail,
                ))

        entry_statuses = {str(getattr(s, "value", s)) for s in entry_statuses}
        check("SESSION_ACCEPTS_ENTRIES", session_status in entry_statuses,
              f"Session status is {session_status}.", FactorSeverity.CRITICAL)

        target_ok = realized_pnl < target_profit
        check("TARGET_PROFIT_NOT_REACHED", target_ok,
              f"Realized session P&L {realized_pnl:.2f} vs target {target_profit:.2f}.", FactorSeverity.INFO)
        if not target_ok:
            limit_breached = "TARGET_REACHED"

        loss_ok = loss_basis_pnl > -max_loss
        check("MAX_LOSS_NOT_REACHED", loss_ok,
              f"Session P&L for the loss limit {loss_basis_pnl:.2f} vs limit -{max_loss:.2f}.", FactorSeverity.CRITICAL)
        if not loss_ok and limit_breached is None:
            limit_breached = "MAX_LOSS_REACHED"

        remaining = allocated_capital - used_capital
        check("BOT_CAPITAL_AVAILABLE", remaining > 0,
              f"Remaining bot capital {max(0.0, remaining):.2f} of {allocated_capital:.2f} allocated.")
        check("NO_OPEN_POSITION_ON_SYMBOL", not has_open_position,
              f"{'An' if has_open_position else 'No'} open bot position on {symbol}.", FactorSeverity.INFO)

        if risk_result is None:
            check("ANALYSIS_RISK_AVAILABLE", False, "Risk Guard evaluation unavailable.", FactorSeverity.CRITICAL, "ANALYSIS_RISK")
        else:
            usable = risk_result.status not in (RiskStatus.FAILED, RiskStatus.INSUFFICIENT_DATA)
            check("ANALYSIS_RISK_AVAILABLE", usable,
                  f"Risk Guard status {risk_result.status.value}.", FactorSeverity.CRITICAL, "ANALYSIS_RISK")
            blocked = {str(getattr(lvl, "value", lvl)) for lvl in blocked_risk_levels}
            check("ANALYSIS_RISK_LEVEL_ALLOWED", risk_result.risk_level.value not in blocked,
                  f"Market risk {risk_result.risk_level.value} ({risk_result.risk_score:.1f}/100); blocked levels: {sorted(blocked) or 'none'}.",
                  FactorSeverity.CRITICAL, "ANALYSIS_RISK")

        if decision is None:
            check("DECISION_DIRECTIONAL", False, "Decision Engine result unavailable.", FactorSeverity.WARNING, "DECISION")
        else:
            check("DECISION_DIRECTIONAL", decision.decision.value in ("BULLISH", "BEARISH"),
                  f"Market stance {decision.decision.value}.", FactorSeverity.WARNING, "DECISION")
            clarity = decision.decision_clarity.value
            check("DECISION_CLARITY_SUFFICIENT",
                  self._CLARITY_RANK.get(clarity, 0) >= self._CLARITY_RANK.get(min_decision_clarity, 99),
                  f"Decision clarity {clarity} (confidence {decision.decision_confidence:.1f}); minimum {min_decision_clarity}.",
                  FactorSeverity.WARNING, "DECISION")

        if opportunity is None:
            check("OPPORTUNITY_LEVEL_SUFFICIENT", False, "Opportunity Engine result unavailable.", FactorSeverity.WARNING, "OPPORTUNITY")
        else:
            level = opportunity.opportunity_level.value
            check("OPPORTUNITY_LEVEL_SUFFICIENT",
                  self._OPPORTUNITY_RANK.get(level, 0) >= self._OPPORTUNITY_RANK.get(min_opportunity_level, 99),
                  f"Opportunity {level} ({opportunity.opportunity_score:.1f}/100); minimum {min_opportunity_level}.",
                  FactorSeverity.WARNING, "OPPORTUNITY")

        return BotTradeGateResult(
            symbol=symbol,
            approved=all(c.passed for c in checks),
            checks=checks,
            rejections=rejections,
            limit_breached=limit_breached,
        )

    # =======================================================================
    # HELPER METHODS
    # =======================================================================

    @staticmethod
    def _score_to_risk_level(score: float) -> RiskLevel:
        """Deterministic mapping from 0-100 risk score to categorical RiskLevel."""
        if score < 30.0:
            return RiskLevel.LOW
        elif score < 55.0:
            return RiskLevel.MODERATE
        elif score < 75.0:
            return RiskLevel.HIGH
        else:
            return RiskLevel.CRITICAL

    def _generate_executive_summary(
        self,
        symbol: str,
        level: RiskLevel,
        score: float,
        status: RiskStatus,
        vol: DimensionAssessment,
        conflict: DimensionAssessment,
        cons: DimensionAssessment,
        ctx: BrainAnalysisContext,
    ) -> str:
        """Creates a professional, factual narrative explaining the risk posture."""
        if level == RiskLevel.LOW:
            posture = (
                f"{symbol} exhibits low analytical risk ({score}/100). Market conditions are stabilized with "
                f"high cross-model agreement ({ctx.consensus_summary.agreement_score:.0f}%) and controlled volatility."
            )
        elif level == RiskLevel.MODERATE:
            posture = (
                f"{symbol} reflects standard moderate market risk ({score}/100). Technical conditions are manageable, "
                f"though typical range fluctuations and isolated signal divergence should be factored into risk planning."
            )
        elif level == RiskLevel.HIGH:
            posture = (
                f"Elevated risk posture detected for {symbol} ({score}/100). "
                f"{'High volatility expansion' if vol.score >= 55 else 'Cross-system signal conflict'} "
                f"warrants cautious positioning and defensive trade parameters."
            )
        else:
            posture = (
                f"CRITICAL risk alert on {symbol} ({score}/100). Severe market volatility, acute model divergence, "
                f"or degraded analysis completeness undermines reliable directional execution."
            )
        return posture

    def _create_fatal_result(
        self,
        symbol: str,
        timeframe: str,
        timestamp: str,
        reason: str,
        t0: float,
        brain_ms: float = 0.0,
        brain_reused: bool = False,
    ) -> RiskEvaluationResult:
        """Generates a structured CRITICAL risk result when fatal errors occur."""
        eval_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        total_ms = round(eval_ms + brain_ms, 2)

        fatal_dim = DimensionAssessment(
            dimension_id="system_fault",
            name="System Integrity",
            score=100.0,
            level=RiskLevel.CRITICAL,
            weight=1.0,
            summary=reason,
            metrics={"error": reason},
            status="FAILED",
        )

        return RiskEvaluationResult(
            symbol=symbol,
            timeframe=timeframe,
            timestamp=timestamp,
            risk_level=RiskLevel.CRITICAL,
            risk_score=100.0,
            status=RiskStatus.FAILED,
            summary=f"Risk evaluation failed for {symbol}: {reason}. Safety cannot be confirmed.",
            dimensions=RiskDimensions(
                volatility=fatal_dim,
                signal_conflict=fatal_dim,
                consensus=fatal_dim,
                analysis_quality=fatal_dim,
                data_quality=fatal_dim,
            ),
            risk_factors=[
                RiskFactor(
                    factor_id="FATAL_UPSTREAM_ERROR",
                    category="SYSTEM",
                    severity=FactorSeverity.CRITICAL,
                    title="Fatal Upstream Analysis Failure",
                    detail=reason,
                )
            ],
            safety_factors=[],
            unavailable_dimensions=["ALL"],
            diagnostics=RiskDiagnostics(
                evaluation_latency_ms=eval_ms,
                brain_latency_ms=brain_ms,
                total_latency_ms=total_ms,
                brain_context_reused=brain_reused,
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
        brain_reused: bool = False,
    ) -> RiskEvaluationResult:
        """Generates a structured INSUFFICIENT_DATA result (anti-false-safety guarantee)."""
        eval_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        total_ms = round(eval_ms + brain_ms, 2)

        insuf_dim = DimensionAssessment(
            dimension_id="data_scarcity",
            name="Data Scarcity",
            score=85.0,
            level=RiskLevel.HIGH,
            weight=1.0,
            summary=reason,
            metrics={"reason": reason},
            status="INSUFFICIENT_DATA",
        )

        return RiskEvaluationResult(
            symbol=symbol,
            timeframe=timeframe,
            timestamp=timestamp,
            risk_level=RiskLevel.HIGH,
            risk_score=85.0,
            status=RiskStatus.INSUFFICIENT_DATA,
            summary=f"Risk evaluation incomplete for {symbol} due to insufficient market data. Defaulting to defensive posture.",
            dimensions=RiskDimensions(
                volatility=insuf_dim,
                signal_conflict=insuf_dim,
                consensus=insuf_dim,
                analysis_quality=insuf_dim,
                data_quality=insuf_dim,
            ),
            risk_factors=[
                RiskFactor(
                    factor_id="DATA_INSUFFICIENT",
                    category="DATA_QUALITY",
                    severity=FactorSeverity.WARNING,
                    title="Insufficient Candle History",
                    detail=reason,
                )
            ],
            safety_factors=[],
            unavailable_dimensions=["VOLATILITY", "SIGNAL_CONFLICT", "CONSENSUS"],
            diagnostics=RiskDiagnostics(
                evaluation_latency_ms=eval_ms,
                brain_latency_ms=brain_ms,
                total_latency_ms=total_ms,
                brain_context_reused=brain_reused,
                dimensions_evaluated=0,
            ),
        )


# Global singleton instance
risk_guard = RiskGuard()
