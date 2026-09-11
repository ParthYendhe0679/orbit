"""
ai-service/models/decision.py — ORBIT Phase 9 Decision Engine Data Contracts

Pydantic v2 schemas defining the standardized market stance decisions,
decision clarity tiers, evidence confidence metrics, conflict structures,
and unified analytical conclusions.
"""

from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class MarketStance(str, Enum):
    """
    Categorical market stance conclusion.
    Strict Operational Boundary: Evaluates analytical market stance only.
    Does NOT mean BUY or SELL; does not execute trades or issue orders.
    """
    BULLISH = "BULLISH"                      # Evidence decisively supports upward momentum/trajectory
    BEARISH = "BEARISH"                      # Evidence decisively supports downward momentum/trajectory
    NEUTRAL = "NEUTRAL"                      # Balanced or consolidating conditions; no directional edge
    MIXED = "MIXED"                          # Divergent, opposing forces with strong active setups on both sides
    NO_CLEAR_DECISION = "NO_CLEAR_DECISION"  # Evidence is too conflicted, weak, or high-risk to justify a stance
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"  # Missing market candles or failed upstream analysis pipeline


class DecisionClarity(str, Enum):
    """Categorical degree of clarity and conviction in the evaluated stance."""
    CLEAR = "CLEAR"               # Decisive alignment, ample evidence, low-to-moderate risk
    MODERATE = "MODERATE"         # Established stance with some minor friction or isolated warnings
    UNCLEAR = "UNCLEAR"           # Polar conflict, high analytical risk, or weak opportunity
    INSUFFICIENT = "INSUFFICIENT" # Missing or failed upstream analysis context


class DecisionStatus(str, Enum):
    """Operational evaluation status of the Decision Engine."""
    READY = "READY"                         # Full intelligence stack evaluated with high fidelity
    PARTIAL = "PARTIAL"                     # Evaluated with non-critical missing subsystems
    LIMITED = "LIMITED"                     # Substantial analytical inputs missing, degraded reliability
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA" # Cannot evaluate stance safely due to missing market/pipeline data
    FAILED = "FAILED"                       # Fatal upstream error or unresolvable ticker symbol


class DecisionInputSummary(BaseModel):
    """Summary snapshot of all upstream intelligence ingested by the Decision Engine."""
    consensus_signal: str = Field(..., description="Phase 5 Consensus signal (e.g. BULLISH, BEARISH, MIXED)")
    consensus_strength: float = Field(..., ge=0.0, le=100.0, description="Consensus conviction strength")
    agreement_score: float = Field(..., ge=0.0, le=100.0, description="Percentage cross-model agreement")
    risk_score: float = Field(..., ge=0.0, le=100.0, description="Phase 7 Risk Guard composite score (0-100)")
    risk_level: str = Field(..., description="Phase 7 Risk Guard level (LOW, MODERATE, HIGH, CRITICAL)")
    opportunity_score: float = Field(..., ge=0.0, le=100.0, description="Phase 8 Opportunity Engine score (0-100)")
    opportunity_level: str = Field(..., description="Phase 8 Opportunity Engine level (VERY_LOW to VERY_HIGH)")
    completeness_score: float = Field(..., ge=0.0, le=100.0, description="Phase 6 Brain completeness percentage")
    completeness_tier: str = Field(..., description="Phase 6 Brain completeness tier (COMPLETE, PARTIAL, etc.)")


class DecisionDiagnostics(BaseModel):
    """Operational telemetry and execution metrics for the Decision Engine."""
    decision_latency_ms: float = Field(default=0.0, description="Decision Engine calculation latency (ms)")
    brain_latency_ms: float = Field(default=0.0, description="Upstream Brain latency (ms)")
    risk_latency_ms: float = Field(default=0.0, description="Upstream Risk Guard latency (ms)")
    opportunity_latency_ms: float = Field(default=0.0, description="Upstream Opportunity Engine latency (ms)")
    total_latency_ms: float = Field(default=0.0, description="End-to-end pipeline latency (ms)")
    contexts_reused: bool = Field(default=True, description="True if Brain, Risk, and Opportunity contexts were reused")


class DecisionEvaluationResult(BaseModel):
    """
    Master Decision Engine Output Envelope.
    Provides a standardized, deterministic, explainable, and risk-aware
    market stance synthesizing the entire ORBIT intelligence stack.
    """
    symbol: str = Field(..., description="Asset symbol evaluated")
    timeframe: str = Field(default="1d", description="Evaluated candle timeframe")
    decision: MarketStance = Field(..., description="Evaluated market stance (BULLISH, BEARISH, NEUTRAL, etc.)")
    decision_confidence: float = Field(..., ge=0.0, le=100.0, description="Deterministic evidence confidence score (0-100)")
    decision_clarity: DecisionClarity = Field(..., description="Clarity tier: CLEAR, MODERATE, UNCLEAR, INSUFFICIENT")
    status: DecisionStatus = Field(..., description="Operational status of the evaluation")
    summary: str = Field(..., description="Comprehensive executive explanation of the market stance")
    primary_evidence: List[str] = Field(default_factory=list, description="Top empirical drivers supporting the stance")
    supporting_evidence: List[str] = Field(default_factory=list, description="Corroborating factors and secondary indicators")
    constraints: List[str] = Field(default_factory=list, description="Risk factors and opportunity limitations constraining confidence")
    conflicts: List[str] = Field(default_factory=list, description="Explicit cross-system contradictions detected")
    input_summary: DecisionInputSummary = Field(..., description="Snapshot of all upstream pipeline metrics")
    unavailable_inputs: List[str] = Field(default_factory=list, description="List of any missing upstream intelligence components")
    diagnostics: DecisionDiagnostics = Field(..., description="Execution performance metrics")
    timestamp: str = Field(..., description="Evaluation timestamp")
