"""
ORBIT Phase 5 - Consensus Engine
Centralized, deterministic, and explainable consensus layer synthesizing
Phase 3 AI Agent Intelligence and Phase 4 Trading Strategy Evidence into a unified market view.
"""

import asyncio
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from backend.models.agent import AgentOrchestrationResult, AgentResult, AgentStatus
from backend.models.consensus import (
    AgreementLevel,
    ConsensusResult,
    ConsensusSignal,
    ConsensusStatus,
    EvidenceItem,
    EvidenceType,
)
from backend.models.strategy import StrategyOrchestrationResult, StrategyResult, StrategyStatus
from backend.services.agent_orchestrator import agent_orchestrator
from backend.services.strategy_engine import strategy_engine
from backend.services.market_data_service import market_service


# ---------------------------------------------------------------------------
# Signal Normalization Layer
# ---------------------------------------------------------------------------

def normalize_signal(raw_signal: Any) -> ConsensusSignal:
    """
    Deterministic mapping converting disparate signal representations
    into standardized ConsensusSignal (BULLISH, BEARISH, NEUTRAL).
    """
    if raw_signal is None:
        return ConsensusSignal.NEUTRAL

    norm = str(getattr(raw_signal, "value", raw_signal)).strip().upper()

    if norm in ("BULLISH", "BUY", "LONG", "UPTREND", "POSITIVE"):
        return ConsensusSignal.BULLISH
    elif norm in ("BEARISH", "SELL", "SHORT", "DOWNTREND", "NEGATIVE"):
        return ConsensusSignal.BEARISH
    elif norm in ("NEUTRAL", "HOLD", "FLAT", "NO_SETUP", "SIDEWAYS"):
        return ConsensusSignal.NEUTRAL
    else:
        return ConsensusSignal.NEUTRAL


# ---------------------------------------------------------------------------
# Central Consensus Engine
# ---------------------------------------------------------------------------

class ConsensusEngine:
    """
    ORBIT Consensus Engine.
    Combines Phase 3 AI Agents (Market Intelligence) and Phase 4 Trading Strategies
    (Setup Detection) into a unified, explainable, and deterministic market consensus.
    """

    def __init__(self):
        self.min_evidence_threshold = 3  # Minimum valid inputs required to declare consensus
        self.agent_weight_share = 0.45   # 45% weight to broad market intelligence
        self.strategy_weight_share = 0.55 # 55% weight to concrete setup detections

    async def evaluate_consensus(
        self,
        symbol: str,
        timeframe: str = "1d",
        agent_results: Optional[AgentOrchestrationResult] = None,
        strategy_results: Optional[StrategyOrchestrationResult] = None,
        df: Optional[pd.DataFrame] = None,
    ) -> ConsensusResult:
        """
        Evaluate full multi-source market consensus for a given symbol and timeframe.
        Executes agents and strategies concurrently if pre-calculated payloads are not provided.
        """
        start_t = time.perf_counter()
        upper_sym = symbol.strip().upper()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # 1. Fetch market data and execute upstream engines concurrently if needed
        if agent_results is None or strategy_results is None:
            if df is None:
                try:
                    df = await market_service.get_normalized_dataframe(upper_sym, period="60d", interval=timeframe)
                except Exception as exc:
                    return self._create_failed_consensus(
                        upper_sym, timeframe, now_str, f"Market data retrieval failed: {str(exc)}", start_t
                    )

            tasks = []
            if agent_results is None:
                tasks.append(agent_orchestrator.analyze_symbol(upper_sym, timeframe=timeframe))
            else:
                tasks.append(asyncio.sleep(0, result=agent_results))

            if strategy_results is None:
                tasks.append(strategy_engine.evaluate_symbol(upper_sym, timeframe=timeframe, df=df))
            else:
                tasks.append(asyncio.sleep(0, result=strategy_results))

            completed = await asyncio.gather(*tasks, return_exceptions=True)
            ag_out = completed[0] if not isinstance(completed[0], Exception) else None
            st_out = completed[1] if not isinstance(completed[1], Exception) else None
        else:
            ag_out = agent_results
            st_out = strategy_results

        # 2. Ingest, validate, and normalize evidence
        valid_items: List[EvidenceItem] = []
        ignored_items: List[Dict[str, Any]] = []

        agent_tally = {"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0}
        strategy_tally = {"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0}

        # Process Agent Results (Phase 3)
        if ag_out and hasattr(ag_out, "results"):
            valid_agents = [a for a in ag_out.results if a.status == AgentStatus.SUCCESS]
            w_agent = (self.agent_weight_share / len(valid_agents)) if valid_agents else 0.0

            for ag in ag_out.results:
                if ag.status != AgentStatus.SUCCESS:
                    ignored_items.append({
                        "source_id": ag.agent_id,
                        "source_name": ag.agent_name,
                        "type": "AGENT",
                        "status": ag.status.value,
                        "reason": ag.error_message or "Execution failed or skipped"
                    })
                    continue

                sig = normalize_signal(ag.signal)
                agent_tally[sig.value] = agent_tally.get(sig.value, 0) + 1
                valid_items.append(EvidenceItem(
                    source_id=ag.agent_id,
                    source_name=ag.agent_name,
                    evidence_type=EvidenceType.AGENT,
                    category=ag.category.value,
                    signal=sig,
                    confidence=float(ag.confidence),
                    weight=w_agent,
                    summary=ag.summary or f"{ag.agent_name} indicates {sig.value}.",
                    is_conflicting=False,
                ))
        else:
            ignored_items.append({"source_id": "agents_suite", "type": "AGENT", "status": "FAILED", "reason": "Agent orchestrator threw exception"})

        # Process Strategy Results (Phase 4)
        if st_out and hasattr(st_out, "results"):
            valid_strats = [s for s in st_out.results if s.status == StrategyStatus.SUCCESS]
            # Active setups carry 1.4x higher conviction than inactive neutral holding
            raw_weights = [1.4 if s.setup_detected else 0.7 for s in valid_strats]
            weight_sum = sum(raw_weights) if raw_weights else 1.0

            for idx, st in enumerate(st_out.results):
                if st.status != StrategyStatus.SUCCESS:
                    ignored_items.append({
                        "source_id": st.strategy_id,
                        "source_name": st.strategy_name,
                        "type": "STRATEGY",
                        "status": st.status.value,
                        "reason": st.error_message or "Strategy evaluation returned insufficient data or error"
                    })
                    continue

                # An active setup projects its signal; a non-setup strategy represents neutral wait
                sig = normalize_signal(st.signal) if st.setup_detected else ConsensusSignal.NEUTRAL
                strategy_tally[sig.value] = strategy_tally.get(sig.value, 0) + 1
                w_strat = (raw_weights[idx] / weight_sum) * self.strategy_weight_share if valid_strats else 0.0

                summary_text = (st.reasoning[0] if st.reasoning else "") or f"{st.strategy_name}: {sig.value} setup."
                valid_items.append(EvidenceItem(
                    source_id=st.strategy_id,
                    source_name=st.strategy_name,
                    evidence_type=EvidenceType.STRATEGY,
                    category=st.category.value,
                    signal=sig,
                    confidence=float(st.confidence),
                    weight=w_strat,
                    summary=summary_text,
                    is_conflicting=False,
                ))
        else:
            ignored_items.append({"source_id": "strategies_suite", "type": "STRATEGY", "status": "FAILED", "reason": "Strategy engine threw exception"})

        # 3. Minimum Evidence Check
        if len(valid_items) < self.min_evidence_threshold:
            elapsed_ms = (time.perf_counter() - start_t) * 1000.0
            return ConsensusResult(
                symbol=upper_sym,
                timeframe=timeframe,
                timestamp=now_str,
                consensus_signal=ConsensusSignal.NEUTRAL,
                consensus_strength=0.0,
                agreement_level=AgreementLevel.LOW,
                agreement_score=0.0,
                status=ConsensusStatus.INSUFFICIENT_EVIDENCE,
                market_view="Insufficient Evidence to Form Consensus",
                summary_reasoning=f"Only {len(valid_items)} valid evidence items available; at least {self.min_evidence_threshold} are required.",
                supporting_evidence=[],
                conflicting_evidence=[],
                ignored_evidence=ignored_items,
                agent_tally=agent_tally,
                strategy_tally=strategy_tally,
                total_evidence_evaluated=len(valid_items),
                execution_time_ms=round(elapsed_ms, 2),
            )

        # 4. Deterministic Consensus Calculations
        f_bull = sum(it.weight * it.confidence for it in valid_items if it.signal == ConsensusSignal.BULLISH)
        f_bear = sum(it.weight * it.confidence for it in valid_items if it.signal == ConsensusSignal.BEARISH)
        f_neut = sum(it.weight * it.confidence for it in valid_items if it.signal == ConsensusSignal.NEUTRAL)
        f_total = f_bull + f_bear + f_neut + 1e-5

        # Vote counts
        v_bull = sum(1 for it in valid_items if it.signal == ConsensusSignal.BULLISH)
        v_bear = sum(1 for it in valid_items if it.signal == ConsensusSignal.BEARISH)
        v_neut = sum(1 for it in valid_items if it.signal == ConsensusSignal.NEUTRAL)
        v_total = len(valid_items)

        # Agreement Level & Score
        v_max = max(v_bull, v_bear, v_neut)
        agreement_score = round((v_max / v_total) * 100.0, 1)

        if agreement_score >= 70.0:
            agreement_level = AgreementLevel.HIGH
        elif agreement_score >= 50.0:
            agreement_level = AgreementLevel.MEDIUM
        else:
            agreement_level = AgreementLevel.LOW

        # Conflict Detection: Substantial forces on both sides with narrow margin
        is_conflicted = False
        if f_bull >= 15.0 and f_bear >= 15.0:
            diff_ratio = abs(f_bull - f_bear) / max(f_bull, f_bear)
            if diff_ratio < 0.35:
                is_conflicted = True

        # Signal Resolution
        if is_conflicted:
            consensus_signal = ConsensusSignal.MIXED
            conviction = max(f_bull, f_bear) - min(f_bull, f_bear)
            consensus_strength = min(45.0, round(conviction * 1.5, 1))
        elif f_bull > f_bear and f_bull >= f_neut:
            consensus_signal = ConsensusSignal.BULLISH
            directional_edge = (f_bull - f_bear) / f_total
            consensus_strength = round(min(100.0, (directional_edge * 70.0) + (agreement_score * 0.30)), 1)
        elif f_bear > f_bull and f_bear >= f_neut:
            consensus_signal = ConsensusSignal.BEARISH
            directional_edge = (f_bear - f_bull) / f_total
            consensus_strength = round(min(100.0, (directional_edge * 70.0) + (agreement_score * 0.30)), 1)
        else:
            consensus_signal = ConsensusSignal.NEUTRAL
            consensus_strength = round(min(60.0, 30.0 + (v_neut / v_total) * 30.0), 1)

        # 5. Segregate Supporting and Conflicting Evidence
        supporting: List[EvidenceItem] = []
        conflicting: List[EvidenceItem] = []

        for item in valid_items:
            if consensus_signal == ConsensusSignal.BULLISH:
                if item.signal == ConsensusSignal.BULLISH:
                    supporting.append(item)
                elif item.signal == ConsensusSignal.BEARISH:
                    item.is_conflicting = True
                    conflicting.append(item)
            elif consensus_signal == ConsensusSignal.BEARISH:
                if item.signal == ConsensusSignal.BEARISH:
                    supporting.append(item)
                elif item.signal == ConsensusSignal.BULLISH:
                    item.is_conflicting = True
                    conflicting.append(item)
            elif consensus_signal == ConsensusSignal.MIXED:
                if item.signal == ConsensusSignal.BULLISH:
                    supporting.append(item)
                elif item.signal == ConsensusSignal.BEARISH:
                    item.is_conflicting = True
                    conflicting.append(item)
            else:  # NEUTRAL
                if item.signal == ConsensusSignal.NEUTRAL:
                    supporting.append(item)
                else:
                    item.is_conflicting = True
                    conflicting.append(item)

        # Sort evidence by confidence descending
        supporting.sort(key=lambda x: x.confidence, reverse=True)
        conflicting.sort(key=lambda x: x.confidence, reverse=True)

        # 6. Institutional Market View Text & Summary Reasoning
        market_view, summary_reasoning = self._build_explainability_text(
            consensus_signal=consensus_signal,
            consensus_strength=consensus_strength,
            agreement_level=agreement_level,
            agreement_score=agreement_score,
            v_bull=v_bull,
            v_bear=v_bear,
            v_neut=v_neut,
            v_total=v_total,
            supporting=supporting,
            conflicting=conflicting,
            is_conflicted=is_conflicted,
        )

        status = ConsensusStatus.PARTIAL if ignored_items else ConsensusStatus.READY
        elapsed_ms = (time.perf_counter() - start_t) * 1000.0

        return ConsensusResult(
            symbol=upper_sym,
            timeframe=timeframe,
            timestamp=now_str,
            consensus_signal=consensus_signal,
            consensus_strength=consensus_strength,
            agreement_level=agreement_level,
            agreement_score=agreement_score,
            status=status,
            market_view=market_view,
            summary_reasoning=summary_reasoning,
            supporting_evidence=supporting,
            conflicting_evidence=conflicting,
            ignored_evidence=ignored_items,
            agent_tally=agent_tally,
            strategy_tally=strategy_tally,
            total_evidence_evaluated=len(valid_items),
            execution_time_ms=round(elapsed_ms, 2),
        )

    def _build_explainability_text(
        self,
        consensus_signal: ConsensusSignal,
        consensus_strength: float,
        agreement_level: AgreementLevel,
        agreement_score: float,
        v_bull: int,
        v_bear: int,
        v_neut: int,
        v_total: int,
        supporting: List[EvidenceItem],
        conflicting: List[EvidenceItem],
        is_conflicted: bool,
    ) -> Tuple[str, str]:
        """Construct deterministic market view title and explainability summary."""
        if consensus_signal == ConsensusSignal.BULLISH:
            if agreement_level == AgreementLevel.HIGH:
                market_view = "Strong Bullish Confluence — Unified Trend & Setup Alignment"
            elif agreement_level == AgreementLevel.MEDIUM:
                market_view = "Moderate Bullish Bias — Selective Upside Participation"
            else:
                market_view = "Guarded Bullish Tilt — Low Agreement Among Drivers"

            top_supp = [s.source_name for s in supporting[:3]]
            supp_str = ", ".join(top_supp) if top_supp else "multiple technical drivers"
            conflict_str = f" However, {len(conflicting)} opposing read(s) detected (e.g. {conflicting[0].source_name})." if conflicting else ""

            summary = (
                f"Bullish consensus affirmed with {consensus_strength:.1f}% strength and {agreement_score:.1f}% agreement "
                f"({v_bull} of {v_total} sources). Key support from {supp_str}.{conflict_str}"
            )

        elif consensus_signal == ConsensusSignal.BEARISH:
            if agreement_level == AgreementLevel.HIGH:
                market_view = "Strong Bearish Confluence — Distribution & Downward Thrust"
            elif agreement_level == AgreementLevel.MEDIUM:
                market_view = "Moderate Bearish Bias — Selective Downside Confirmation"
            else:
                market_view = "Guarded Bearish Tilt — Low Agreement Among Drivers"

            top_supp = [s.source_name for s in supporting[:3]]
            supp_str = ", ".join(top_supp) if top_supp else "multiple technical drivers"
            conflict_str = f" However, {len(conflicting)} opposing read(s) detected (e.g. {conflicting[0].source_name})." if conflicting else ""

            summary = (
                f"Bearish consensus affirmed with {consensus_strength:.1f}% strength and {agreement_score:.1f}% agreement "
                f"({v_bear} of {v_total} sources). Downside pressure driven by {supp_str}.{conflict_str}"
            )

        elif consensus_signal == ConsensusSignal.MIXED:
            market_view = "Conflicted Market State — Bullish & Bearish Forces Colliding"
            summary = (
                f"Consensus is divided: {v_bull} sources indicate Bullish momentum while {v_bear} indicate Bearish pressure. "
                f"Opposing forces prevent directional conviction. Agreement is low ({agreement_score:.1f}%)."
            )

        else:  # NEUTRAL
            market_view = "Consolidation Equilibrium — Low Directional Thrust"
            summary = (
                f"Market is in neutral equilibrium with {v_neut} of {v_total} sources balanced. "
                f"Neither buyers nor sellers demonstrate sufficient conviction to overcome range consolidation."
            )

        return market_view, summary

    def _create_failed_consensus(
        self, symbol: str, timeframe: str, now_str: str, error_msg: str, start_t: float
    ) -> ConsensusResult:
        """Fallback for critical failures."""
        elapsed_ms = (time.perf_counter() - start_t) * 1000.0
        return ConsensusResult(
            symbol=symbol,
            timeframe=timeframe,
            timestamp=now_str,
            consensus_signal=ConsensusSignal.NEUTRAL,
            consensus_strength=0.0,
            agreement_level=AgreementLevel.LOW,
            agreement_score=0.0,
            status=ConsensusStatus.FAILED,
            market_view="Consensus Calculation Failed",
            summary_reasoning=f"Consensus could not be established: {error_msg}",
            supporting_evidence=[],
            conflicting_evidence=[],
            ignored_evidence=[{"source": "consensus_engine", "status": "FAILED", "reason": error_msg}],
            agent_tally={"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0},
            strategy_tally={"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0},
            total_evidence_evaluated=0,
            execution_time_ms=round(elapsed_ms, 2),
        )


# Global Consensus Engine Singleton
consensus_engine = ConsensusEngine()
