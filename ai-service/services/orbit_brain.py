"""
backend/services/orbit_brain.py — ORBIT Brain Central Intelligence Orchestrator (Phase 6).

Coordinates the multi-system intelligence pipeline across:
  - Phase 2: Market Data System (MarketDataService)
  - Phase 3: AI Agent Intelligence (AgentOrchestrator - 7 specialized agents)
  - Phase 4: Trading Strategy Engine (StrategyEngine - 12 quantitative strategies)
  - Phase 5: Consensus Engine (ConsensusEngine - deterministic evidence synthesis)

Key Guarantees:
  - Zero duplicate data fetching: Market DataFrame is acquired once and shared in-memory.
  - Zero execution/order generation: Produces purely structured analytical context.
  - Deterministic completeness scoring & explainable institutional market views.
"""

import asyncio
import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from backend.models.brain import (
    AgentIntelligenceSummary,
    BrainAnalysisContext,
    BrainDiagnostics,
    BrainStatus,
    CompletenessTier,
    ConsensusSummary,
    KeyEvidence,
    MarketSummary,
    StrategySummary,
)
from backend.models.agent import AgentOrchestrationResult, AgentStatus
from backend.models.strategy import StrategyOrchestrationResult, StrategyStatus
from backend.models.consensus import (
    AgreementLevel,
    ConsensusResult,
    ConsensusSignal,
    ConsensusStatus,
)
from backend.services.agent_orchestrator import AgentOrchestrator, agent_orchestrator
from backend.services.consensus_engine import ConsensusEngine, consensus_engine
from backend.services.market_data_service import MarketDataService, market_service
from backend.services.strategy_engine import StrategyEngine, strategy_engine

logger = logging.getLogger("orbit.brain")


class OrbitBrain:
    """
    Central Intelligence Orchestration Layer for ORBIT (Phase 6).

    Harmonizes standardized market context, multi-agent intelligence, quantitative setups,
    and consensus evaluation into a single structured master analysis context.
    """

    def __init__(
        self,
        market_data: Optional[MarketDataService] = None,
        orchestrator: Optional[AgentOrchestrator] = None,
        strategies: Optional[StrategyEngine] = None,
        consensus: Optional[ConsensusEngine] = None,
    ):
        self.market_service = market_data or market_service
        self.agent_orchestrator = orchestrator or agent_orchestrator
        self.strategy_engine = strategies or strategy_engine
        self.consensus_engine = consensus or consensus_engine

    async def synthesize_analysis(
        self,
        symbol: str,
        timeframe: str = "1d",
        df: Optional[pd.DataFrame] = None,
    ) -> BrainAnalysisContext:
        """
        Executes complete intelligence orchestration for a given symbol and timeframe.
        Guarantees zero-duplicate data fetching by sharing `df` across all subsystems.
        """
        t0 = time.perf_counter()
        upper_sym = symbol.strip().upper()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        failed_subsystems: List[str] = []

        # -------------------------------------------------------------------
        # 1. Standardized Market Data Retrieval (Single Context Acquisition)
        # -------------------------------------------------------------------
        t_md = time.perf_counter()
        if df is None:
            try:
                df = await self.market_service.get_normalized_dataframe(upper_sym, period="60d", interval=timeframe)
            except Exception as exc:
                logger.error(f"Brain failed to acquire market data for {upper_sym}: {exc}", exc_info=True)
                return self._create_fatal_context(
                    upper_sym, timeframe, now_str, f"Market data retrieval failed: {str(exc)}", t0
                )
        md_ms = round((time.perf_counter() - t_md) * 1000.0, 2)

        # Sanity check candle count
        if df is None or len(df) == 0:
            return self._create_fatal_context(
                upper_sym, timeframe, now_str, "No candlestick data available for symbol", t0
            )

        # -------------------------------------------------------------------
        # 2. Extract Standardized Market Summary
        # -------------------------------------------------------------------
        market_summary = self._compute_market_summary(upper_sym, timeframe, df, now_str)

        # -------------------------------------------------------------------
        # 3. Concurrent Multi-System Upstream Execution (Agents + Strategies)
        # -------------------------------------------------------------------
        t_up = time.perf_counter()
        agent_task = self.agent_orchestrator.analyze_symbol(upper_sym, timeframe=timeframe, df=df)
        strat_task = self.strategy_engine.evaluate_symbol(upper_sym, timeframe=timeframe, df=df)

        upstream_results = await asyncio.gather(agent_task, strat_task, return_exceptions=True)

        raw_agent_res = upstream_results[0]
        raw_strat_res = upstream_results[1]

        agents_ms = round((time.perf_counter() - t_up) * 1000.0, 2)
        strategies_ms = agents_ms  # Concurrent execution duration

        # Validate agent results
        if isinstance(raw_agent_res, Exception):
            logger.error(f"Agent orchestrator failed in Brain: {raw_agent_res}")
            agent_res: Optional[AgentOrchestrationResult] = None
            failed_subsystems.append("AI_AGENTS")
        else:
            agent_res = raw_agent_res

        # Validate strategy results
        if isinstance(raw_strat_res, Exception):
            logger.error(f"Strategy engine failed in Brain: {raw_strat_res}")
            strat_res: Optional[StrategyOrchestrationResult] = None
            failed_subsystems.append("STRATEGIES")
        else:
            strat_res = raw_strat_res

        # -------------------------------------------------------------------
        # 4. Consensus Engine Synthesis (Consuming Ingested Results)
        # -------------------------------------------------------------------
        t_cons = time.perf_counter()
        try:
            consensus_res = await self.consensus_engine.evaluate_consensus(
                symbol=upper_sym,
                timeframe=timeframe,
                agent_results=agent_res,
                strategy_results=strat_res,
                df=df,
            )
        except Exception as exc:
            logger.error(f"Consensus engine failed in Brain: {exc}", exc_info=True)
            failed_subsystems.append("CONSENSUS")
            consensus_res = self.consensus_engine._create_failed_consensus(
                upper_sym, timeframe, now_str, f"Consensus calculation error: {str(exc)}", t_cons
            )
        consensus_ms = round((time.perf_counter() - t_cons) * 1000.0, 2)

        # -------------------------------------------------------------------
        # 5. Extract Structured Subsystem Summaries
        # -------------------------------------------------------------------
        agent_summary = self._summarize_agents(agent_res)
        strategy_summary = self._summarize_strategies(strat_res)
        consensus_summary = ConsensusSummary(
            signal=consensus_res.consensus_signal,
            strength=consensus_res.consensus_strength,
            agreement_score=consensus_res.agreement_score,
            agreement_level=consensus_res.agreement_level,
            status=consensus_res.status,
            market_view=consensus_res.market_view,
        )

        # -------------------------------------------------------------------
        # 6. Extract Key Evidence (Supporting & Conflicting)
        # -------------------------------------------------------------------
        key_supporting, key_conflicting = self._extract_key_evidence(consensus_res)

        # -------------------------------------------------------------------
        # 7. Deterministic Analysis Completeness & Status Evaluation
        # -------------------------------------------------------------------
        completeness_score, completeness_tier = self._calculate_completeness(
            df=df,
            agent_res=agent_res,
            strat_res=strat_res,
            consensus_res=consensus_res,
            failed_subsystems=failed_subsystems,
        )

        # Determine authoritative analysis status
        if len(df) < 50:
            analysis_status = BrainStatus.INSUFFICIENT_DATA
        elif completeness_tier == CompletenessTier.FAILED:
            analysis_status = BrainStatus.FAILED
        elif completeness_tier == CompletenessTier.LIMITED:
            analysis_status = BrainStatus.LIMITED
        elif failed_subsystems or consensus_res.status == ConsensusStatus.PARTIAL:
            analysis_status = BrainStatus.PARTIAL
        else:
            analysis_status = BrainStatus.READY

        # -------------------------------------------------------------------
        # 8. Formulate Executive Summary
        # -------------------------------------------------------------------
        overall_bias = consensus_res.consensus_signal
        conviction_strength = consensus_res.consensus_strength

        executive_summary = self._formulate_executive_summary(
            symbol=upper_sym,
            market_summary=market_summary,
            agent_summary=agent_summary,
            strategy_summary=strategy_summary,
            consensus_summary=consensus_summary,
            analysis_status=analysis_status,
            completeness_score=completeness_score,
        )

        total_pipeline_ms = round((time.perf_counter() - t0) * 1000.0, 2)

        diagnostics = BrainDiagnostics(
            market_data_ms=md_ms,
            agents_ms=agents_ms,
            strategies_ms=strategies_ms,
            consensus_ms=consensus_ms,
            total_pipeline_ms=total_pipeline_ms,
            data_reused=True,
            failed_subsystems=failed_subsystems,
        )

        return BrainAnalysisContext(
            symbol=upper_sym,
            timeframe=timeframe,
            timestamp=now_str,
            analysis_status=analysis_status,
            completeness_score=completeness_score,
            completeness_tier=completeness_tier,
            overall_bias=overall_bias,
            conviction_strength=conviction_strength,
            executive_summary=executive_summary,
            market_summary=market_summary,
            agent_summary=agent_summary,
            strategy_summary=strategy_summary,
            consensus_summary=consensus_summary,
            key_supporting_evidence=key_supporting,
            key_conflicting_evidence=key_conflicting,
            diagnostics=diagnostics,
        )

    def _compute_market_summary(
        self, symbol: str, timeframe: str, df: pd.DataFrame, timestamp: str
    ) -> MarketSummary:
        """Derives normalized price action, volatility, and trend regime from DataFrame."""
        close = df["Close"].values
        high = df["High"].values
        low = df["Low"].values

        curr_p = round(float(close[-1]), 4)
        prev_p = round(float(close[-2]), 4) if len(close) > 1 else curr_p
        price_change = round(curr_p - prev_p, 4)
        price_change_pct = round((price_change / prev_p) * 100.0, 2) if prev_p != 0 else 0.0

        high_val = round(float(np.max(high)), 4)
        low_val = round(float(np.min(low)), 4)
        vol_val = round(float(df["Volume"].iloc[-1]), 2) if "Volume" in df.columns else 0.0

        # ATR(14) Volatility
        if len(df) >= 14:
            tr_elements = [
                high[1:] - low[1:],
                np.abs(high[1:] - close[:-1]),
                np.abs(low[1:] - close[:-1]),
            ]
            tr = np.maximum(tr_elements[0], np.maximum(tr_elements[1], tr_elements[2]))
            atr_val = round(float(np.mean(tr[-14:])), 4)
        else:
            atr_val = round(float(high[-1] - low[-1]), 4)

        vol_pct = round((atr_val / curr_p) * 100.0, 2) if curr_p > 0 else 0.0

        # Trend Regime via Moving Average Alignment
        ema20 = float(df["Close"].ewm(span=20).mean().iloc[-1])
        ema50 = float(df["Close"].ewm(span=50).mean().iloc[-1]) if len(df) >= 50 else ema20

        if curr_p > ema20 and ema20 > ema50:
            trend_regime = "STRONG UPTREND"
        elif curr_p < ema20 and ema20 < ema50:
            trend_regime = "STRONG DOWNTREND"
        elif curr_p > ema50:
            trend_regime = "MODERATE UPTREND / PULLBACK"
        elif curr_p < ema50:
            trend_regime = "MODERATE DOWNTREND / REBOUND"
        else:
            trend_regime = "CONSOLIDATION / EQUILIBRIUM"

        return MarketSummary(
            symbol=symbol,
            current_price=curr_p,
            price_change=price_change,
            price_change_pct=price_change_pct,
            high=high_val,
            low=low_val,
            volume=vol_val,
            volatility_atr=atr_val,
            volatility_pct=vol_pct,
            trend_regime=trend_regime,
            data_points=len(df),
            timestamp=timestamp,
        )

    def _summarize_agents(self, agent_res: Optional[AgentOrchestrationResult]) -> AgentIntelligenceSummary:
        """Aggregates Phase 3 agent findings into a structured summary."""
        if not agent_res or not hasattr(agent_res, "results"):
            return AgentIntelligenceSummary(
                total_agents=7,
                successful_agents=0,
                failed_agents=7,
                leading_signal="NEUTRAL",
                average_confidence=0.0,
                tally={"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0},
                key_findings=["AI Agent subsystem unavailable or execution failed."],
            )

        tally = agent_res.consensus_tally or {"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0}
        leading_sig = max(tally, key=tally.get) if any(tally.values()) else "NEUTRAL"

        # Collect top agent takeaways
        findings: List[str] = []
        for r in agent_res.results:
            if r.status == AgentStatus.SUCCESS:
                findings.append(f"{r.agent_name}: {r.summary}")
            if len(findings) >= 4:
                break

        return AgentIntelligenceSummary(
            total_agents=agent_res.agents_total,
            successful_agents=agent_res.agents_succeeded,
            failed_agents=agent_res.agents_failed,
            leading_signal=leading_sig,
            average_confidence=agent_res.average_confidence,
            tally=tally,
            key_findings=findings,
        )

    def _summarize_strategies(self, strat_res: Optional[StrategyOrchestrationResult]) -> StrategySummary:
        """Aggregates Phase 4 strategy setups into a structured summary."""
        if not strat_res or not hasattr(strat_res, "results"):
            return StrategySummary(
                strategies_evaluated=0,
                setups_found=0,
                bullish_setups=0,
                bearish_setups=0,
                average_confidence=0.0,
                tally={"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0},
                active_strategies=[],
            )

        active = [
            r.strategy_name for r in strat_res.results
            if getattr(r, "setup_detected", False) and r.status == StrategyStatus.SUCCESS
        ]
        bull_setups = sum(
            1 for r in strat_res.results
            if getattr(r, "setup_detected", False) and r.signal.value == "BULLISH" and r.status == StrategyStatus.SUCCESS
        )
        bear_setups = sum(
            1 for r in strat_res.results
            if getattr(r, "setup_detected", False) and r.signal.value == "BEARISH" and r.status == StrategyStatus.SUCCESS
        )

        return StrategySummary(
            strategies_evaluated=strat_res.strategies_evaluated,
            setups_found=strat_res.setups_found,
            bullish_setups=bull_setups,
            bearish_setups=bear_setups,
            average_confidence=strat_res.average_confidence,
            tally=strat_res.tally or {"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0},
            active_strategies=active,
        )

    def _extract_key_evidence(
        self, consensus_res: ConsensusResult
    ) -> tuple[List[KeyEvidence], List[KeyEvidence]]:
        """Extracts top supporting and conflicting evidence items from consensus payload."""
        supporting: List[KeyEvidence] = []
        conflicting: List[KeyEvidence] = []

        if hasattr(consensus_res, "supporting_evidence"):
            for item in consensus_res.supporting_evidence[:5]:
                supporting.append(
                    KeyEvidence(
                        source_id=item.source_id,
                        source_name=item.source_name,
                        source_type=item.evidence_type.value,
                        signal=item.signal,
                        confidence=item.confidence,
                        summary=item.summary,
                        is_conflicting=False,
                    )
                )

        if hasattr(consensus_res, "conflicting_evidence"):
            for item in consensus_res.conflicting_evidence[:5]:
                conflicting.append(
                    KeyEvidence(
                        source_id=item.source_id,
                        source_name=item.source_name,
                        source_type=item.evidence_type.value,
                        signal=item.signal,
                        confidence=item.confidence,
                        summary=item.summary,
                        is_conflicting=True,
                    )
                )

        return supporting, conflicting

    def _calculate_completeness(
        self,
        df: pd.DataFrame,
        agent_res: Optional[AgentOrchestrationResult],
        strat_res: Optional[StrategyOrchestrationResult],
        consensus_res: ConsensusResult,
        failed_subsystems: List[str],
    ) -> tuple[float, CompletenessTier]:
        """
        Calculates deterministic analysis completeness score (0-100%).
        Allocations:
          - Market Data Integrity: 20 pts
          - AI Agent Execution: 30 pts
          - Strategy Engine Execution: 30 pts
          - Consensus Engine Synthesis: 20 pts
        """
        score = 0.0

        # 1. Market Data (20 points)
        if len(df) >= 50:
            score += 20.0
        elif len(df) > 0:
            score += (len(df) / 50.0) * 20.0

        # 2. AI Agents (30 points)
        if agent_res and agent_res.agents_total > 0:
            ratio = agent_res.agents_succeeded / agent_res.agents_total
            score += ratio * 30.0

        # 3. Strategies (30 points)
        if strat_res and strat_res.strategies_total > 0:
            ratio = strat_res.strategies_evaluated / strat_res.strategies_total
            score += ratio * 30.0

        # 4. Consensus (20 points)
        if consensus_res.status == ConsensusStatus.READY:
            score += 20.0
        elif consensus_res.status == ConsensusStatus.PARTIAL:
            score += 15.0
        elif consensus_res.status == ConsensusStatus.INSUFFICIENT_EVIDENCE:
            score += 6.0

        final_score = round(min(100.0, max(0.0, score)), 1)

        if final_score >= 90.0:
            tier = CompletenessTier.COMPLETE
        elif final_score >= 60.0:
            tier = CompletenessTier.PARTIAL
        elif final_score >= 30.0:
            tier = CompletenessTier.LIMITED
        else:
            tier = CompletenessTier.FAILED

        return final_score, tier

    def _formulate_executive_summary(
        self,
        symbol: str,
        market_summary: MarketSummary,
        agent_summary: AgentIntelligenceSummary,
        strategy_summary: StrategySummary,
        consensus_summary: ConsensusSummary,
        analysis_status: BrainStatus,
        completeness_score: float,
    ) -> str:
        """Synthesizes structured narrative explaining current market posture."""
        p_str = f"{market_summary.current_price:,.2f}"
        chg_sign = "+" if market_summary.price_change >= 0 else ""
        chg_str = f"{chg_sign}{market_summary.price_change_pct:.2f}%"

        parts = [
            f"{symbol} is trading at {p_str} ({chg_str}) in a {market_summary.trend_regime} with ATR volatility of {market_summary.volatility_pct:.2f}%."
        ]

        if consensus_summary.signal == ConsensusSignal.MIXED:
            parts.append(
                f"Consensus Engine flags MIXED signals with low directional conviction ({consensus_summary.strength:.1f}%). Substantial opposing forces exist between trend indicators and momentum setups."
            )
        elif consensus_summary.signal == ConsensusSignal.BULLISH:
            parts.append(
                f"Consensus Engine indicates a BULLISH bias with {consensus_summary.strength:.1f}% conviction strength and {consensus_summary.agreement_score:.1f}% agreement ({consensus_summary.agreement_level.value} level). Leading view: '{consensus_summary.market_view}'."
            )
        elif consensus_summary.signal == ConsensusSignal.BEARISH:
            parts.append(
                f"Consensus Engine indicates a BEARISH bias with {consensus_summary.strength:.1f}% conviction strength and {consensus_summary.agreement_score:.1f}% agreement ({consensus_summary.agreement_level.value} level). Leading view: '{consensus_summary.market_view}'."
            )
        else:
            parts.append(
                f"Consensus Engine indicates NEUTRAL market equilibrium with {consensus_summary.strength:.1f}% strength ({consensus_summary.market_view}). Price is oscillating without sustained directional momentum."
            )

        parts.append(
            f"Phase 3 Agents reported {agent_summary.tally.get('BULLISH', 0)} Bullish, {agent_summary.tally.get('BEARISH', 0)} Bearish, and {agent_summary.tally.get('NEUTRAL', 0)} Neutral findings. Phase 4 Strategies identified {strategy_summary.setups_found} active setup(s) across 12 quantitative frameworks."
        )

        parts.append(
            f"Overall analysis completeness is {completeness_score:.1f}% with operational status {analysis_status.value}."
        )

        return " ".join(parts)

    def _create_fatal_context(
        self, symbol: str, timeframe: str, timestamp: str, reason: str, start_t: float
    ) -> BrainAnalysisContext:
        """Fallback factory emitting structured context when fatal data retrieval occurs."""
        elapsed_ms = round((time.perf_counter() - start_t) * 1000.0, 2)

        return BrainAnalysisContext(
            symbol=symbol,
            timeframe=timeframe,
            timestamp=timestamp,
            analysis_status=BrainStatus.FAILED,
            completeness_score=0.0,
            completeness_tier=CompletenessTier.FAILED,
            overall_bias=ConsensusSignal.NEUTRAL,
            conviction_strength=0.0,
            executive_summary=f"ORBIT Brain analysis could not be synthesized: {reason}.",
            market_summary=MarketSummary(
                symbol=symbol,
                current_price=0.0,
                price_change=0.0,
                price_change_pct=0.0,
                high=0.0,
                low=0.0,
                volume=0.0,
                volatility_atr=0.0,
                volatility_pct=0.0,
                trend_regime="UNKNOWN",
                data_points=0,
                timestamp=timestamp,
            ),
            agent_summary=AgentIntelligenceSummary(
                total_agents=7,
                successful_agents=0,
                failed_agents=7,
                leading_signal="NEUTRAL",
                average_confidence=0.0,
                tally={"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0},
                key_findings=[reason],
            ),
            strategy_summary=StrategySummary(
                strategies_evaluated=0,
                setups_found=0,
                bullish_setups=0,
                bearish_setups=0,
                average_confidence=0.0,
                tally={"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0},
                active_strategies=[],
            ),
            consensus_summary=ConsensusSummary(
                signal=ConsensusSignal.NEUTRAL,
                strength=0.0,
                agreement_score=0.0,
                agreement_level=AgreementLevel.LOW,
                status=ConsensusStatus.FAILED,
                market_view="Analysis Execution Failed",
            ),
            key_supporting_evidence=[],
            key_conflicting_evidence=[],
            diagnostics=BrainDiagnostics(
                market_data_ms=0.0,
                agents_ms=0.0,
                strategies_ms=0.0,
                consensus_ms=0.0,
                total_pipeline_ms=elapsed_ms,
                data_reused=False,
                failed_subsystems=["MARKET_DATA"],
            ),
        )


# Global singleton instance for ORBIT backend
orbit_brain = OrbitBrain()
