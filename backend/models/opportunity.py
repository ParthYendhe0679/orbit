"""
backend/models/opportunity.py — ORBIT Phase 8 Opportunity Engine Data Contracts

Pydantic v2 schemas defining the standardized trade opportunity evaluation contracts,
opportunity levels, dimensional breakdowns (consensus, strategy, agent, risk, quality),
strength factors, and weakness factors.
"""

from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class OpportunityLevel(str, Enum):
    """Categorical opportunity quality level."""
    VERY_HIGH = "VERY_HIGH" # Score 80.0 - 100.0: High confluence, multiple setups, low risk, complete analysis
    HIGH = "HIGH"           # Score 65.0 - 79.9: Strong confluence, active strategy setups, favorable risk profile
    MODERATE = "MODERATE"   # Score 45.0 - 64.9: Standard opportunity, isolated setups, manageable risk
    LOW = "LOW"             # Score 25.0 - 44.9: Weak opportunity, no clear setups, mixed consensus, elevated risk
    VERY_LOW = "VERY_LOW"   # Score 0.0 - 24.9: Minimal opportunity, consensus deadlock (MIXED), or high risk/errors


class OpportunityStatus(str, Enum):
    """Operational evaluation status of the Opportunity Engine."""
    READY = "READY"                         # All dimensions evaluated with full upstream data
    PARTIAL = "PARTIAL"                     # Minor dimensions unavailable or evaluated with partial inputs
    LIMITED = "LIMITED"                     # Sparse evidence, limited strategy/agent confluence
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA" # Market data or upstream context missing; opportunity cannot be evaluated
    FAILED = "FAILED"                       # Fatal upstream error or unresolvable ticker symbol


class FactorImpact(str, Enum):
    """Direction of factor contribution to opportunity quality."""
    POSITIVE = "POSITIVE"   # Enhances opportunity quality (strength factor)
    NEGATIVE = "NEGATIVE"   # Suppresses opportunity quality (weakness factor)


class OpportunityDimension(BaseModel):
    """Detailed assessment of an individual opportunity dimension."""
    dimension_id: str = Field(..., description="Unique dimension identifier")
    name: str = Field(..., description="Display title of the dimension")
    score: float = Field(..., ge=0.0, le=100.0, description="Opportunity score for this dimension (0=Weak, 100=Max Confluence)")
    weight: float = Field(..., ge=0.0, le=1.0, description="Relative contribution weight to composite score")
    summary: str = Field(..., description="Factual explanation of the dimensional contribution")
    metrics: Dict[str, Any] = Field(default_factory=dict, description="Raw quantitative metrics underlying this dimension")
    status: str = Field(default="EVALUATED", description="Status: 'EVALUATED', 'PARTIAL', 'UNAVAILABLE'")


class OpportunityDimensions(BaseModel):
    """Container for the 5 core evaluated opportunity dimensions."""
    consensus_quality: OpportunityDimension = Field(..., description="Consensus strength, agreement, and clarity")
    strategy_confluence: OpportunityDimension = Field(..., description="Active strategy setups and directional alignment")
    agent_harmony: OpportunityDimension = Field(..., description="Multi-agent alignment and perspective confluence")
    risk_headroom: OpportunityDimension = Field(..., description="Risk Guard safety headroom (100 - risk_score)")
    analysis_completeness: OpportunityDimension = Field(..., description="Upstream pipeline verification and data integrity")


class OpportunityFactor(BaseModel):
    """Concrete data-backed factor explaining opportunity quality."""
    factor_id: str = Field(..., description="Unique factor slug")
    category: str = Field(..., description="Dimension category (e.g. 'STRATEGY', 'CONSENSUS', 'RISK')")
    impact: FactorImpact = Field(..., description="POSITIVE (Strength) or NEGATIVE (Weakness)")
    title: str = Field(..., description="Concise headline")
    detail: str = Field(..., description="Factual narrative explanation")


class OpportunityDiagnostics(BaseModel):
    """Telemetry and execution metrics for the Opportunity Engine."""
    opportunity_latency_ms: float = Field(default=0.0, description="Opportunity Engine calculation latency (ms)")
    brain_latency_ms: float = Field(default=0.0, description="Upstream Brain latency (ms)")
    risk_latency_ms: float = Field(default=0.0, description="Upstream Risk Guard latency (ms)")
    total_latency_ms: float = Field(default=0.0, description="End-to-end latency (ms)")
    contexts_reused: bool = Field(default=True, description="True if Brain and Risk contexts were reused directly")
    dimensions_evaluated: int = Field(default=5, description="Count of successfully evaluated dimensions")


class OpportunityEvaluationResult(BaseModel):
    """
    Standardized master envelope for Phase 8 ORBIT Opportunity Evaluation Engine.
    Provides a comprehensive, deterministic, and explainable evaluation of current
    market opportunity quality without issuing trade execution orders.
    """
    symbol: str = Field(..., description="Asset ticker symbol")
    timeframe: str = Field(default="1d", description="Evaluated candle timeframe")
    timestamp: str = Field(..., description="Timestamp of evaluation generation")
    opportunity_level: OpportunityLevel = Field(..., description="Overall categorical opportunity level")
    opportunity_score: float = Field(..., ge=0.0, le=100.0, description="Deterministic opportunity score (0-100)")
    status: OpportunityStatus = Field(..., description="Operational status of the opportunity evaluation")
    leading_bias: str = Field(..., description="Dominant directional market bias (e.g. 'BULLISH', 'BEARISH', 'NEUTRAL')")
    summary: str = Field(..., description="Executive narrative summary of the opportunity profile")
    dimensions: OpportunityDimensions = Field(..., description="Breakdown of all 5 opportunity dimensions")
    strength_factors: List[OpportunityFactor] = Field(default_factory=list, description="Concrete factors boosting opportunity")
    weakness_factors: List[OpportunityFactor] = Field(default_factory=list, description="Concrete factors suppressing opportunity")
    unavailable_dimensions: List[str] = Field(default_factory=list, description="Names of any dimensions that could not be evaluated")
    diagnostics: OpportunityDiagnostics = Field(..., description="Execution telemetry and performance metrics")
