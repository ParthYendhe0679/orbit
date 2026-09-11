"""
backend/models/risk.py — ORBIT Phase 7 Risk Guard Data Contracts

Pydantic v2 schemas defining the standardized risk evaluation contracts,
dimension assessments (volatility, conflict, consensus, analysis quality,
data quality), risk warnings, and positive safety factors.
"""

from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class RiskLevel(str, Enum):
    """Categorical risk severity level."""
    LOW = "LOW"             # Score 0.0 - 29.9: High analytical confidence, low volatility, unanimous signals
    MODERATE = "MODERATE"   # Score 30.0 - 54.9: Standard market conditions, manageable conflict
    HIGH = "HIGH"           # Score 55.0 - 74.9: Elevated volatility, polarized signals, or degraded analysis
    CRITICAL = "CRITICAL"   # Score 75.0 - 100.0: Severe volatility, extreme conflict, or insufficient data


class RiskStatus(str, Enum):
    """Operational evaluation status of the Risk Guard."""
    READY = "READY"                         # All 5 dimensions evaluated with high fidelity
    PARTIAL = "PARTIAL"                     # Minor dimensions unavailable, evaluated with partial inputs
    LIMITED = "LIMITED"                     # Substantial analytical inputs missing, degraded reliability
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA" # Cannot evaluate safely due to missing market/candle data
    FAILED = "FAILED"                       # Fatal upstream error or unresolvable ticker symbol


class FactorSeverity(str, Enum):
    """Severity tier for specific risk warnings."""
    INFO = "INFO"
    CAUTION = "CAUTION"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class DimensionAssessment(BaseModel):
    """Detailed assessment of an individual risk dimension."""
    dimension_id: str = Field(..., description="Unique dimension identifier")
    name: str = Field(..., description="Display title of the dimension")
    score: float = Field(..., ge=0.0, le=100.0, description="Risk score for this dimension (0=Safe, 100=Extreme Risk)")
    level: RiskLevel = Field(..., description="Categorical risk level for this dimension")
    weight: float = Field(..., ge=0.0, le=1.0, description="Relative contribution weight to composite score")
    summary: str = Field(..., description="Factual explanation of the dimensional risk score")
    metrics: Dict[str, Any] = Field(default_factory=dict, description="Raw quantitative metrics underlying this dimension")
    status: str = Field(default="EVALUATED", description="Status: 'EVALUATED', 'PARTIAL', 'UNAVAILABLE'")


class RiskDimensions(BaseModel):
    """Container for the 5 core evaluated risk dimensions."""
    volatility: DimensionAssessment = Field(..., description="Volatility and price range expansion risk")
    signal_conflict: DimensionAssessment = Field(..., description="Agent & strategy directional divergence risk")
    consensus: DimensionAssessment = Field(..., description="Consensus strength and conviction uncertainty risk")
    analysis_quality: DimensionAssessment = Field(..., description="Subsystem completeness and pipeline error risk")
    data_quality: DimensionAssessment = Field(..., description="Historical candle sufficiency and freshness risk")


class RiskFactor(BaseModel):
    """Factual risk warning or vulnerability detected in the analysis."""
    factor_id: str = Field(..., description="Unique factor slug")
    category: str = Field(..., description="Dimension category (e.g. 'VOLATILITY', 'CONFLICT')")
    severity: FactorSeverity = Field(..., description="Severity level")
    title: str = Field(..., description="Concise headline")
    detail: str = Field(..., description="Factual narrative explanation")


class SafetyFactor(BaseModel):
    """Factual stabilizing condition or positive analytical factor."""
    factor_id: str = Field(..., description="Unique factor slug")
    category: str = Field(..., description="Dimension category (e.g. 'CONSENSUS', 'QUALITY')")
    title: str = Field(..., description="Concise headline")
    detail: str = Field(..., description="Factual explanation of why this condition lowers analytical risk")


class RiskDiagnostics(BaseModel):
    """Telemetry and execution metrics for the Risk Guard."""
    evaluation_latency_ms: float = Field(default=0.0, description="Risk Guard computation time (ms)")
    brain_latency_ms: float = Field(default=0.0, description="Upstream ORBIT Brain execution time (ms)")
    total_latency_ms: float = Field(default=0.0, description="Total end-to-end latency (ms)")
    brain_context_reused: bool = Field(default=True, description="True if existing Brain context was supplied directly")
    dimensions_evaluated: int = Field(default=5, description="Count of successfully evaluated dimensions")


class RiskEvaluationResult(BaseModel):
    """
    Standardized master envelope for Phase 7 ORBIT Risk Guard.
    Provides a comprehensive, deterministic, and explainable safety analysis
    of the current market context.
    """
    symbol: str = Field(..., description="Asset ticker symbol")
    timeframe: str = Field(default="1d", description="Evaluated candle timeframe")
    timestamp: str = Field(..., description="Timestamp of evaluation generation")
    risk_level: RiskLevel = Field(..., description="Overall composite risk level")
    risk_score: float = Field(..., ge=0.0, le=100.0, description="Deterministic risk score (0=Min Risk, 100=Max Risk)")
    status: RiskStatus = Field(..., description="Operational status of the risk evaluation")
    summary: str = Field(..., description="Executive risk assessment narrative")
    dimensions: RiskDimensions = Field(..., description="Breakdown of all 5 risk dimensions")
    risk_factors: List[RiskFactor] = Field(default_factory=list, description="Specific risk warnings and headwinds")
    safety_factors: List[SafetyFactor] = Field(default_factory=list, description="Specific stabilizing and positive factors")
    unavailable_dimensions: List[str] = Field(default_factory=list, description="Names of any dimensions that could not be evaluated")
    diagnostics: RiskDiagnostics = Field(..., description="Operational performance metrics")
