"""
ORBIT Phase 4 - Strategy Engine Data Contracts
Pydantic v2 schemas defining standardized strategy outputs, setup detection states,
and orchestration payloads.
"""

from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class StrategySignal(str, Enum):
    """Directional setup signal produced by a quantitative trading strategy."""
    BULLISH = "BULLISH"
    BEARISH = "BEARISH"
    NEUTRAL = "NEUTRAL"


class StrategyCategory(str, Enum):
    """Categorical classification of trading strategy mechanics."""
    TREND = "TREND"
    MOMENTUM = "MOMENTUM"
    BREAKOUT = "BREAKOUT"
    MEAN_REVERSION = "MEAN_REVERSION"
    ORDER_FLOW = "ORDER_FLOW"
    PRICE_ACTION = "PRICE_ACTION"
    STRUCTURE = "STRUCTURE"
    GEOMETRIC = "GEOMETRIC"


class StrategyStatus(str, Enum):
    """Execution status of a strategy evaluation."""
    SUCCESS = "SUCCESS"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"
    ERROR = "ERROR"
    SKIPPED = "SKIPPED"


class StrategyResult(BaseModel):
    """
    Standardized result contract for an individual trading strategy.
    Answers: 'Does this strategy currently detect a valid market setup?'
    """
    strategy_id: str = Field(..., description="Unique machine identifier for strategy (e.g. 'smc', 'trend_following')")
    strategy_name: str = Field(..., description="Human-readable strategy title")
    category: StrategyCategory = Field(..., description="Strategy classification category")
    symbol: str = Field(..., description="Asset ticker symbol evaluated")
    timeframe: str = Field(default="1d", description="Candle interval evaluated (e.g. '1d', '1h')")
    setup_detected: bool = Field(..., description="True if entry conditions are satisfied, False otherwise")
    signal: StrategySignal = Field(..., description="Analytical directional bias: BULLISH, BEARISH, or NEUTRAL")
    confidence: float = Field(..., ge=0.0, le=100.0, description="Deterministic rule-based confidence score (0-100)")
    entry_context: Dict[str, Any] = Field(
        default_factory=dict,
        description="Contextual setup parameters (reference price, trigger level, stop reference)"
    )
    conditions: Dict[str, bool] = Field(
        default_factory=dict,
        description="Status of individual condition checks evaluated by the strategy"
    )
    metrics: Dict[str, Any] = Field(
        default_factory=dict,
        description="Raw mathematical and indicator values evaluated (e.g. EMAs, Z-Score, ADX)"
    )
    reasoning: List[str] = Field(
        default_factory=list,
        description="Structured, deterministic explanation bullet points justifying the setup decision"
    )
    status: StrategyStatus = Field(default=StrategyStatus.SUCCESS, description="Execution health status")
    error_message: Optional[str] = Field(default=None, description="Error details if execution encountered an exception")
    execution_time_ms: float = Field(default=0.0, description="Evaluation duration in milliseconds")
    timestamp: str = Field(..., description="ISO 8601 or clock timestamp when evaluation completed")


class StrategyOrchestrationResult(BaseModel):
    """
    Consolidated payload emitted by the Strategy Engine.
    Feeds directly into the future Consensus Engine (Phase 5).
    """
    symbol: str = Field(..., description="Asset ticker symbol")
    timeframe: str = Field(default="1d", description="Timeframe interval")
    timestamp: str = Field(..., description="Execution timestamp")
    data_source: str = Field(default="MarketDataService", description="Originating market data provider")
    strategies_total: int = Field(..., description="Total strategies registered in the suite")
    strategies_evaluated: int = Field(..., description="Number of strategies evaluated")
    setups_found: int = Field(..., description="Number of strategies that detected an active trade setup")
    tally: Dict[str, int] = Field(
        default_factory=lambda: {"BULLISH": 0, "BEARISH": 0, "NEUTRAL": 0},
        description="Directional setup distribution across evaluated strategies"
    )
    average_confidence: float = Field(default=0.0, description="Mean confidence across succeeding strategies")
    execution_time_ms: float = Field(default=0.0, description="Total strategy evaluation time in milliseconds")
    results: List[StrategyResult] = Field(default_factory=list, description="List of individual strategy results")
