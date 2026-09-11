"""
ai-service/models/explainability.py — ORBIT Phase 10 Explainability & Insight Engine Data Contracts

Pydantic v2 schemas defining structured, traceable, human-understandable market insights,
evidence categorization, conflict analysis, and plain-English market stance explanations.
"""

from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

from models.decision import DecisionClarity, MarketStance


class SourceSubsystem(str, Enum):
    """Originating subsystem for an evidence or constraint item."""
    DECISION_ENGINE = "DECISION_ENGINE"
    ORBIT_BRAIN = "ORBIT_BRAIN"
    RISK_GUARD = "RISK_GUARD"
    OPPORTUNITY_ENGINE = "OPPORTUNITY_ENGINE"
    CONSENSUS_ENGINE = "CONSENSUS_ENGINE"
    STRATEGY_ENGINE = "STRATEGY_ENGINE"
    AGENT_SYSTEM = "AGENT_SYSTEM"


class InsightCategory(str, Enum):
    """Categorical classification of an analytical insight."""
    POSITIVE_ALIGNMENT = "POSITIVE_ALIGNMENT"
    NEGATIVE_ALIGNMENT = "NEGATIVE_ALIGNMENT"
    NEUTRAL_EQUILIBRIUM = "NEUTRAL_EQUILIBRIUM"
    CONFLICT_ALERT = "CONFLICT_ALERT"
    RISK_CONSTRAINT = "RISK_CONSTRAINT"
    UNCERTAINTY_WARNING = "UNCERTAINTY_WARNING"
    MISSING_DATA_NOTICE = "MISSING_DATA_NOTICE"
    INFORMATIONAL = "INFORMATIONAL"


class ExplainabilityStatus(str, Enum):
    """Operational status of the explainability pipeline."""
    READY = "READY"
    PARTIAL = "PARTIAL"
    LIMITED = "LIMITED"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"
    FAILED = "FAILED"


class TraceableEvidenceItem(BaseModel):
    """Normalized empirical evidence item with strict upstream source attribution."""
    source: SourceSubsystem = Field(..., description="Subsystem that generated this evidence")
    category: InsightCategory = Field(..., description="Insight category classification")
    title: str = Field(..., description="Concise headline summary of the evidence")
    detail: str = Field(..., description="Factual, data-driven narrative detail")
    message: Optional[str] = Field(default=None, description="Direct display message (defaults to detail)")
    direction: Optional[str] = Field(default=None, description="Directional bias: BULLISH, BEARISH, NEUTRAL")
    impact: str = Field(default="MEDIUM", description="Impact tier: HIGH, MEDIUM, LOW")
    metrics: Dict[str, Any] = Field(default_factory=dict, description="Underlying quantitative metrics")

    def model_post_init(self, __context: Any) -> None:
        if self.message is None:
            self.message = self.detail


class ConflictExplanation(BaseModel):
    """Structured explanation of cross-system disagreement or trigger clash."""
    conflict_type: str = Field(..., description="Slug or classification of the conflict")
    title: Optional[str] = Field(default=None, description="Human-readable title for UI display")
    description: str = Field(..., description="Detailed description of what contradicts what")
    implication: str = Field(default="", description="Analytical impact on conviction or clarity")
    severity: str = Field(default="MODERATE", description="Severity tier: LOW, MODERATE, HIGH")
    conflicting_parties: List[str] = Field(default_factory=list, description="Subsystems or models in opposition")
    subsystems: List[str] = Field(default_factory=list, description="Subsystem names involved in conflict")

    def model_post_init(self, __context: Any) -> None:
        if not self.title:
            self.title = self.conflict_type.replace("_", " ").title()
        if not self.subsystems and self.conflicting_parties:
            self.subsystems = list(self.conflicting_parties)


class UncertaintyReason(BaseModel):
    """Factual explanation of analytical ambiguity or confidence constraint."""
    factor: str = Field(..., description="Underlying uncertainty driver")
    explanation: str = Field(..., description="Plain-English explanation of why this creates uncertainty")
    category: Optional[str] = Field(default=None, description="Category classification for UI tag")
    description: Optional[str] = Field(default=None, description="Display description (defaults to explanation)")
    source: str = Field(default="ORBIT_BRAIN", description="Originating subsystem")
    severity: str = Field(default="MODERATE", description="Severity tier: LOW, MODERATE, HIGH")

    def model_post_init(self, __context: Any) -> None:
        if self.category is None:
            self.category = self.factor
        if self.description is None:
            self.description = self.explanation


class ExplainabilityInputSummary(BaseModel):
    """Consolidated snapshot of all upstream intelligence ingested by Phase 10."""
    market_stance: str = Field(..., description="Phase 9 evaluated market stance")
    decision_confidence: float = Field(..., ge=0.0, le=100.0, description="Evidence confidence score (0-100)")
    decision_clarity: str = Field(..., description="Clarity tier (CLEAR, MODERATE, UNCLEAR, INSUFFICIENT)")
    decision_status: str = Field(..., description="Operational status of the decision")
    consensus_signal: str = Field(..., description="Phase 5 consensus direction")
    consensus_strength: float = Field(..., ge=0.0, le=100.0, description="Consensus conviction strength")
    agreement_score: float = Field(..., ge=0.0, le=100.0, description="Model agreement percentage")
    risk_score: float = Field(..., ge=0.0, le=100.0, description="Phase 7 risk score")
    risk_level: str = Field(..., description="Phase 7 risk level (LOW, MODERATE, HIGH, CRITICAL)")
    opportunity_score: float = Field(..., ge=0.0, le=100.0, description="Phase 8 opportunity score")
    opportunity_level: str = Field(..., description="Phase 8 opportunity level")
    completeness_score: float = Field(..., ge=0.0, le=100.0, description="Phase 6 Brain completeness percentage")
    completeness_tier: str = Field(..., description="Phase 6 Brain completeness tier")


class ExplainabilityDiagnostics(BaseModel):
    """Operational telemetry and execution performance metrics."""
    explainability_latency_ms: float = Field(default=0.0, description="Phase 10 computation latency (ms)")
    explain_latency_ms: float = Field(default=0.0, description="Convenience alias for latency (ms)")
    decision_latency_ms: float = Field(default=0.0, description="Upstream Decision Engine latency (ms)")
    total_latency_ms: float = Field(default=0.0, description="End-to-end pipeline latency (ms)")
    contexts_reused: bool = Field(default=True, description="True if all upstream contexts were reused without recomputation")
    upstream_reused: bool = Field(default=True, description="Convenience alias for upstream reuse verification")

    def model_post_init(self, __context: Any) -> None:
        if self.explain_latency_ms == 0.0 and self.explainability_latency_ms > 0.0:
            self.explain_latency_ms = self.explainability_latency_ms
        elif self.explainability_latency_ms == 0.0 and self.explain_latency_ms > 0.0:
            self.explainability_latency_ms = self.explain_latency_ms
        self.upstream_reused = self.contexts_reused


class ExplainabilityEvaluationResult(BaseModel):
    """
    Master Explainability & Insight Envelope.
    Provides structured, traceable, and human-understandable market insights
    explaining the WHAT, WHY, SUPPORT, CONFLICTS, RISKS, and UNCERTAINTIES of ORBIT.
    """
    symbol: str = Field(..., description="Asset symbol evaluated")
    timeframe: str = Field(default="1d", description="Evaluated candle timeframe")
    timestamp: str = Field(..., description="Evaluation timestamp")
    status: ExplainabilityStatus = Field(default=ExplainabilityStatus.READY, description="Operational status")
    market_stance: MarketStance = Field(..., description="Synthesized stance (BULLISH, BEARISH, NEUTRAL, etc.)")
    decision_confidence: float = Field(..., ge=0.0, le=100.0, description="Evidence confidence score (0-100)")
    decision_clarity: DecisionClarity = Field(..., description="Clarity tier (CLEAR, MODERATE, UNCLEAR, INSUFFICIENT)")
    headline: str = Field(..., description="Institutional headline summarizing the market situation")
    executive_summary: str = Field(..., description="Comprehensive narrative explanation of the stance")
    why: List[str] = Field(default_factory=list, description="Top 2-3 bullet points answering 'WHY'")
    core_thesis: List[str] = Field(default_factory=list, description="Core analytical thesis points")
    primary_evidence: List[TraceableEvidenceItem] = Field(default_factory=list, description="Top traceable empirical drivers")
    supporting_evidence: List[TraceableEvidenceItem] = Field(default_factory=list, description="Corroborating factors across agents/strategies")
    conflicts: List[ConflictExplanation] = Field(default_factory=list, description="Cross-system contradictions detected")
    risk_constraints: List[TraceableEvidenceItem] = Field(default_factory=list, description="Risk factors and opportunity limitations")
    uncertainties: List[UncertaintyReason] = Field(default_factory=list, description="Reasons limiting conviction or clarity")
    missing_information: List[str] = Field(default_factory=list, description="Explicit list of unavailable data inputs")
    input_summary: ExplainabilityInputSummary = Field(..., description="Snapshot of upstream stack metrics")
    diagnostics: ExplainabilityDiagnostics = Field(..., description="Telemetry and execution metrics")

    def model_post_init(self, __context: Any) -> None:
        if not self.why and self.core_thesis:
            self.why = list(self.core_thesis)
        elif not self.core_thesis and self.why:
            self.core_thesis = list(self.why)

