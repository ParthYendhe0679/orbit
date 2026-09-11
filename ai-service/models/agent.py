"""
ai-service/models/agent.py — Standardized AI Agent Data Contracts for ORBIT.

Establishes uniform, validated data contracts for all specialized quantitative
and intelligence agents, supporting deterministic scoring, explainability,
and future consensus aggregation.
"""

from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class AgentSignal(str, Enum):
    """Normalized analytical direction emitted by an agent."""
    BULLISH = "BULLISH"
    BEARISH = "BEARISH"
    NEUTRAL = "NEUTRAL"


class AgentCategory(str, Enum):
    """Categorical classification of the agent's analytical focus."""
    TREND = "TREND"
    MOMENTUM = "MOMENTUM"
    VOLUME = "VOLUME"
    VOLATILITY = "VOLATILITY"
    REGIME = "REGIME"
    LEVELS = "LEVELS"
    SENTIMENT = "SENTIMENT"


class AgentStatus(str, Enum):
    """Execution status of an individual agent."""
    SUCCESS = "SUCCESS"
    ERROR = "ERROR"
    SKIPPED = "SKIPPED"


class AgentResult(BaseModel):
    """
    Standardized output produced by every ORBIT intelligence agent.
    Guarantees deterministic structure for downstream consumption.
    """
    agent_id: str = Field(..., description="Unique machine-readable identifier (e.g., 'trend_agent')")
    agent_name: str = Field(..., description="Display name of the agent (e.g., 'Trend Analyst')")
    category: AgentCategory = Field(..., description="Analytical category")
    symbol: str = Field(..., description="Ticker symbol analyzed")
    timeframe: str = Field(default="1d", description="Primary timeframe evaluated")
    signal: AgentSignal = Field(..., description="Directional analytical signal")
    confidence: float = Field(..., ge=0.0, le=100.0, description="Deterministic confidence score (0-100)")
    summary: str = Field(..., description="Concise human-readable conclusion")
    reasoning: List[str] = Field(default_factory=list, description="Structured explainability points supporting signal")
    metrics: Dict[str, Any] = Field(default_factory=dict, description="Raw numerical/indicator metrics calculated")
    status: AgentStatus = Field(default=AgentStatus.SUCCESS, description="Execution health status")
    error_message: Optional[str] = Field(default=None, description="Error details if execution failed")
    execution_time_ms: float = Field(default=0.0, description="Time taken to evaluate in milliseconds")
    timestamp: str = Field(..., description="ISO or clock timestamp when analysis completed")


class AgentOrchestrationResult(BaseModel):
    """
    Consolidated payload returned by the Agent Orchestrator.
    Feeds directly into the future Consensus Engine.
    """
    symbol: str = Field(..., description="Asset ticker symbol")
    timestamp: str = Field(..., description="Execution timestamp")
    data_source: str = Field(default="MarketDataService", description="Originating market data gateway")
    agents_total: int = Field(..., description="Total agents registered in the suite")
    agents_succeeded: int = Field(..., description="Number of agents that completed successfully")
    agents_failed: int = Field(default=0, description="Number of agents that threw errors")
    consensus_tally: Dict[str, int] = Field(
        default_factory=lambda: {"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0},
        description="Raw vote distribution across active agents"
    )
    average_confidence: float = Field(default=0.0, description="Mean confidence across succeeding agents")
    execution_time_ms: float = Field(default=0.0, description="Total orchestration time in milliseconds")
    results: List[AgentResult] = Field(default_factory=list, description="Ordered list of individual agent results")
