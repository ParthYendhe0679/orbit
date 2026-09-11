"""
ai-service/models/brain.py — ORBIT Phase 6 Brain Data Contracts

Pydantic v2 schemas defining the unified intelligence context, market summary,
AI agent summary, strategy summary, consensus summary, key evidence items,
and deterministic completeness scoring.
"""

from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

from models.consensus import ConsensusSignal, AgreementLevel, ConsensusStatus


class CompletenessTier(str, Enum):
    """Categorical tier for intelligence completeness."""
    COMPLETE = "COMPLETE"    # 90-100% of expected subsystems executed successfully
    PARTIAL = "PARTIAL"      # 60-89% available (some agents/strategies errored)
    LIMITED = "LIMITED"      # 30-59% available (sparse evidence)
    FAILED = "FAILED"        # <30% available or critical market data failure


class BrainStatus(str, Enum):
    """Operational status of the ORBIT Brain analysis."""
    READY = "READY"                         # All subsystems green, full intelligence synthesized
    PARTIAL = "PARTIAL"                     # Analysis synthesized with non-critical subsystem errors
    LIMITED = "LIMITED"                     # Insufficient evidence to produce authoritative context
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA" # Market candles below minimum threshold (<50)
    FAILED = "FAILED"                       # Market data retrieval or fatal execution error


class MarketSummary(BaseModel):
    """Normalized real-time market data summary."""
    symbol: str = Field(..., description="Asset ticker symbol")
    current_price: float = Field(..., description="Latest spot price")
    price_change: float = Field(..., description="Absolute price change over requested timeframe")
    price_change_pct: float = Field(..., description="Percentage price change over timeframe")
    high: float = Field(..., description="Highest traded price in current window")
    low: float = Field(..., description="Lowest traded price in current window")
    volume: float = Field(default=0.0, description="Latest candle volume")
    volatility_atr: float = Field(..., description="14-period Average True Range")
    volatility_pct: float = Field(..., description="ATR relative to spot price (%)")
    trend_regime: str = Field(..., description="Baseline trend classification (e.g. 'UPTREND', 'DOWNTREND', 'CONSOLIDATION')")
    data_points: int = Field(..., description="Total historical candles evaluated")
    timestamp: str = Field(..., description="Timestamp of latest candle")


class AgentIntelligenceSummary(BaseModel):
    """Consolidated summary of Phase 3 AI Agent findings."""
    total_agents: int = Field(..., description="Total agents evaluated (nominally 7)")
    successful_agents: int = Field(..., description="Count of agents that completed successfully")
    failed_agents: int = Field(..., description="Count of agents that encountered errors")
    leading_signal: str = Field(..., description="Dominant agent directional bias (BULLISH, BEARISH, NEUTRAL)")
    average_confidence: float = Field(..., ge=0.0, le=100.0, description="Average confidence score across agents")
    tally: Dict[str, int] = Field(default_factory=lambda: {"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0})
    key_findings: List[str] = Field(default_factory=list, description="Top bulleted analytical conclusions from agents")


class StrategySummary(BaseModel):
    """Consolidated summary of Phase 4 Trading Strategy setups."""
    strategies_evaluated: int = Field(..., description="Total strategies evaluated (nominally 12)")
    setups_found: int = Field(..., description="Number of strategies with active entry setups detected")
    bullish_setups: int = Field(..., description="Count of active bullish setups")
    bearish_setups: int = Field(..., description="Count of active bearish setups")
    average_confidence: float = Field(..., ge=0.0, le=100.0, description="Average confidence score across strategies")
    tally: Dict[str, int] = Field(default_factory=lambda: {"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0})
    active_strategies: List[str] = Field(default_factory=list, description="Names of strategies with active setups")


class ConsensusSummary(BaseModel):
    """Consolidated snapshot of Phase 5 Consensus Engine result."""
    signal: ConsensusSignal = Field(..., description="Synthesized consensus signal")
    strength: float = Field(..., ge=0.0, le=100.0, description="Deterministic conviction strength (0-100)")
    agreement_score: float = Field(..., ge=0.0, le=100.0, description="Percentage of valid inputs in agreement")
    agreement_level: AgreementLevel = Field(..., description="Agreement tier: HIGH, MEDIUM, LOW")
    status: ConsensusStatus = Field(..., description="Consensus calculation status")
    market_view: str = Field(..., description="Institutional descriptive view (e.g. 'Consolidation Equilibrium')")


class KeyEvidence(BaseModel):
    """Normalized evidence item tagged with origin subsystem."""
    source_id: str = Field(..., description="Identifier of agent or strategy")
    source_name: str = Field(..., description="Display title")
    source_type: str = Field(..., description="'AGENT' or 'STRATEGY'")
    signal: ConsensusSignal = Field(..., description="Normalized direction: BULLISH, BEARISH, NEUTRAL")
    confidence: float = Field(..., ge=0.0, le=100.0, description="Confidence percentage")
    summary: str = Field(..., description="Concise explanation of the signal")
    is_conflicting: bool = Field(default=False, description="True if opposing majority view")


class BrainDiagnostics(BaseModel):
    """Operational telemetry and execution performance metrics."""
    market_data_ms: float = Field(default=0.0, description="Market data retrieval latency (ms)")
    agents_ms: float = Field(default=0.0, description="Agents execution latency (ms)")
    strategies_ms: float = Field(default=0.0, description="Strategies execution latency (ms)")
    consensus_ms: float = Field(default=0.0, description="Consensus synthesis latency (ms)")
    total_pipeline_ms: float = Field(default=0.0, description="End-to-end ORBIT Brain latency (ms)")
    data_reused: bool = Field(default=True, description="True if single in-memory DataFrame was shared across engines")
    failed_subsystems: List[str] = Field(default_factory=list, description="List of any errored components")


class BrainAnalysisContext(BaseModel):
    """
    Unified ORBIT Brain Master Intelligence Envelope.
    Synthesizes Market Data, AI Agents, Trading Strategies, and Consensus into
    one coherent, explainable, deterministic analysis context.
    """
    symbol: str = Field(..., description="Asset symbol evaluated")
    timeframe: str = Field(default="1d", description="Evaluated candle timeframe")
    timestamp: str = Field(..., description="Timestamp of analysis generation")
    analysis_status: BrainStatus = Field(..., description="Overall operational status")
    completeness_score: float = Field(..., ge=0.0, le=100.0, description="Deterministic completeness score (0-100)")
    completeness_tier: CompletenessTier = Field(..., description="Completeness classification")
    overall_bias: ConsensusSignal = Field(..., description="Primary directional market bias")
    conviction_strength: float = Field(..., ge=0.0, le=100.0, description="Synthesized directional conviction")
    executive_summary: str = Field(..., description="Structured institutional overview of the current market state")
    market_summary: MarketSummary = Field(..., description="Normalized price action and volatility metrics")
    agent_summary: AgentIntelligenceSummary = Field(..., description="Multi-agent intelligence findings")
    strategy_summary: StrategySummary = Field(..., description="Quantitative trade setups detected")
    consensus_summary: ConsensusSummary = Field(..., description="Consensus Engine synthesis")
    key_supporting_evidence: List[KeyEvidence] = Field(default_factory=list, description="Top evidence confirming leading bias")
    key_conflicting_evidence: List[KeyEvidence] = Field(default_factory=list, description="Top evidence opposing leading bias")
    diagnostics: BrainDiagnostics = Field(..., description="Execution telemetry and subsystem metrics")
