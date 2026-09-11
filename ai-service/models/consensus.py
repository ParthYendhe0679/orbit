"""
ORBIT Phase 5 - Consensus Engine Data Contracts
Pydantic v2 schemas defining standardized consensus signals, agreement levels,
evidence structures, and unified market view results.
"""

from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class ConsensusSignal(str, Enum):
    """Unified consensus directional bias."""
    BULLISH = "BULLISH"
    BEARISH = "BEARISH"
    NEUTRAL = "NEUTRAL"
    MIXED = "MIXED"


class AgreementLevel(str, Enum):
    """Categorical degree of alignment among contributing evidence."""
    HIGH = "HIGH"        # >= 70% agreement
    MEDIUM = "MEDIUM"    # 50% - 69% agreement
    LOW = "LOW"          # < 50% agreement


class ConsensusStatus(str, Enum):
    """Operational status of consensus calculation."""
    READY = "READY"                                 # Full consensus calculated with ample evidence
    PARTIAL = "PARTIAL"                             # Consensus calculated with some missing/failed sources
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE" # Below minimum required valid inputs (<3)
    FAILED = "FAILED"                               # Calculation crashed or data unretrievable


class EvidenceType(str, Enum):
    """Origin of contributing analytical evidence."""
    AGENT = "AGENT"          # Phase 3 AI Market Intelligence
    STRATEGY = "STRATEGY"    # Phase 4 Quantitative Trade Setup


class EvidenceItem(BaseModel):
    """Individual normalized unit of evidence contributing to consensus."""
    source_id: str = Field(..., description="Machine identifier (e.g. 'trend_agent', 'trend_following')")
    source_name: str = Field(..., description="Human-readable title of agent or strategy")
    evidence_type: EvidenceType = Field(..., description="AGENT or STRATEGY")
    category: str = Field(..., description="Domain category (e.g. 'TREND', 'MOMENTUM', 'BREAKOUT')")
    signal: ConsensusSignal = Field(..., description="Normalized signal: BULLISH, BEARISH, or NEUTRAL")
    confidence: float = Field(..., ge=0.0, le=100.0, description="Source confidence score (0-100)")
    weight: float = Field(..., ge=0.0, le=1.0, description="Normalized mathematical weight in consensus")
    summary: str = Field(..., description="Concise explanation summary from source")
    is_conflicting: bool = Field(default=False, description="True if this item opposes the majority consensus")


class ConsensusResult(BaseModel):
    """
    Standardized payload emitted by the ORBIT Consensus Engine.
    Represents the synthesized market view blending Phase 3 Intelligence and Phase 4 Strategies.
    """
    symbol: str = Field(..., description="Asset ticker symbol evaluated")
    timeframe: str = Field(default="1d", description="Candle timeframe evaluated")
    timestamp: str = Field(..., description="Timestamp when consensus was evaluated")
    consensus_signal: ConsensusSignal = Field(..., description="Primary consensus bias: BULLISH, BEARISH, NEUTRAL, MIXED")
    consensus_strength: float = Field(..., ge=0.0, le=100.0, description="Deterministic conviction strength (0-100)")
    agreement_level: AgreementLevel = Field(..., description="Agreement tier: HIGH, MEDIUM, LOW")
    agreement_score: float = Field(..., ge=0.0, le=100.0, description="Percentage of valid evidence agreeing with leading direction")
    status: ConsensusStatus = Field(..., description="Operational status: READY, PARTIAL, INSUFFICIENT_EVIDENCE, FAILED")
    market_view: str = Field(..., description="Descriptive institutional market summary (e.g. 'Strong Bullish Alignment')")
    summary_reasoning: str = Field(..., description="Deterministic factual reasoning synthesizing the evidence")
    supporting_evidence: List[EvidenceItem] = Field(default_factory=list, description="Evidence items aligning with consensus")
    conflicting_evidence: List[EvidenceItem] = Field(default_factory=list, description="Evidence items opposing consensus")
    ignored_evidence: List[Dict[str, Any]] = Field(default_factory=list, description="Failed, skipped, or insufficient data items")
    agent_tally: Dict[str, int] = Field(default_factory=lambda: {"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0})
    strategy_tally: Dict[str, int] = Field(default_factory=lambda: {"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0})
    total_evidence_evaluated: int = Field(..., description="Count of valid evidence items incorporated")
    execution_time_ms: float = Field(default=0.0, description="Total consensus calculation latency in milliseconds")
