"""
backend/models/copilot.py — Pydantic Schemas for ORBIT AI Market Intelligence Copilot.

Defines validated contracts for user chat messages, categorized intent classification,
structured analytical context summaries, and verified Copilot responses.
"""

from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class CopilotIntent(str, Enum):
    """Categorized analytical question intent for targeted context retrieval."""
    DECISION_STANCE = "DECISION_STANCE"             # Why is the stance bullish/bearish/neutral?
    RISK_CONSTRAINTS = "RISK_CONSTRAINTS"           # What are the biggest risks? Why is confidence low?
    AGENT_DISAGREEMENT = "AGENT_DISAGREEMENT"       # What do the AI agents disagree on?
    OPPORTUNITY_CONFLUENCE = "OPPORTUNITY_CONFLUENCE" # Why is the opportunity score high/low?
    STRATEGY_SETUPS = "STRATEGY_SETUPS"             # Which quantitative strategies triggered?
    EVIDENCE_DATA = "EVIDENCE_DATA"                 # What market evidence supports this?
    INVALIDATION_NEXT_STEPS = "INVALIDATION_NEXT_STEPS" # What would invalidate this analysis?
    SIMPLIFICATION = "SIMPLIFICATION"               # Explain this simply for a beginner
    DEEP_DIVE = "DEEP_DIVE"                         # Detailed institutional breakdown
    GENERAL_QUERY = "GENERAL_QUERY"                 # General analytical question


class CopilotDepth(str, Enum):
    """Response detail depth."""
    SIMPLE = "SIMPLE"
    STANDARD = "STANDARD"
    DEEP = "DEEP"


class ResponseMode(str, Enum):
    """User-selectable analytical response mode."""
    QUICK = "QUICK"
    DETAILED = "DETAILED"
    EXPLAIN_SIMPLY = "EXPLAIN_SIMPLY"


class CopilotMessageRole(str, Enum):
    """Role in the conversation thread."""
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"


class CopilotChatMessage(BaseModel):
    """A single message in the conversation thread."""
    role: CopilotMessageRole = Field(..., description="Message author role")
    content: str = Field(..., description="Plain-text message content")
    timestamp: Optional[str] = Field(default=None, description="ISO timestamp")


class ChatMessageRecord(BaseModel):
    """Persistent chat message representation."""
    id: str
    conversation_id: str
    role: str
    content: str
    timestamp: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


class ConversationCreate(BaseModel):
    """Payload to initialize a new conversation thread."""
    title: Optional[str] = Field(default="New Analysis", description="Conversation display title")
    selected_asset: Optional[str] = Field(default="BTC-USD", description="Initial active asset")
    selected_market: Optional[str] = Field(default="Crypto", description="Initial market category")
    user_id: Optional[int] = Field(default=None, description="User owner ID if authenticated")


class ConversationItem(BaseModel):
    """Summary of a conversation for list/sidebar display."""
    id: str
    user_id: Optional[int] = None
    title: str
    selected_asset: str
    selected_market: str
    created_at: str
    updated_at: str
    message_count: Optional[int] = 0


class ConversationDetail(BaseModel):
    """Complete conversation detail including message history."""
    conversation: ConversationItem
    messages: List[ChatMessageRecord] = Field(default_factory=list)


class CopilotChatRequest(BaseModel):
    """Incoming user chat request to the ORBIT Copilot."""
    message: str = Field(..., min_length=1, description="User question about the active analysis")
    symbol: Optional[str] = Field(default="BTC-USD", description="Target asset ticker symbol")
    selected_asset: Optional[str] = Field(default=None, description="Active selected asset context")
    selected_market: Optional[str] = Field(default="US Stocks", description="Active selected market context")
    timeframe: str = Field(default="1d", description="Analysis candle timeframe (e.g. 1d, 1h)")
    conversation_id: Optional[str] = Field(default=None, description="Session ID for conversation memory")
    depth: Optional[CopilotDepth] = Field(default=None, description="Requested response detail depth")
    response_mode: Optional[str] = Field(default="DETAILED", description="QUICK, DETAILED, or EXPLAIN_SIMPLY")
    user_id: Optional[int] = Field(default=None, description="User owner ID")


class CopilotContextSummary(BaseModel):
    """Snapshot of active ORBIT intelligence context ingested for the response."""
    symbol: str = Field(..., description="Asset symbol")
    timeframe: str = Field(default="1d", description="Timeframe")
    market_stance: str = Field(..., description="Phase 9 market stance (BULLISH, BEARISH, etc.)")
    confidence: float = Field(..., ge=0.0, le=100.0, description="Decision confidence score")
    clarity: str = Field(..., description="Clarity tier (CLEAR, MODERATE, UNCLEAR, INSUFFICIENT)")
    risk_level: str = Field(..., description="Phase 7 risk tier (LOW, MODERATE, HIGH, CRITICAL)")
    risk_score: float = Field(..., ge=0.0, le=100.0, description="Risk score (0-100)")
    opportunity_score: float = Field(..., ge=0.0, le=100.0, description="Opportunity score (0-100)")
    opportunity_level: str = Field(..., description="Opportunity level (HIGH, MODERATE, LOW, etc.)")
    active_setups_count: int = Field(default=0, description="Number of quantitative strategies with active setups")
    conflicts_count: int = Field(default=0, description="Number of detected cross-system conflicts")
    analysis_status: str = Field(default="READY", description="Operational status of ORBIT intelligence")


class CopilotChatResponse(BaseModel):
    """Structured response from the ORBIT Copilot."""
    ok: bool = Field(default=True, description="Success flag")
    answer: str = Field(..., description="Grounded, evidence-based natural language answer")
    symbol: str = Field(..., description="Target asset symbol")
    timeframe: str = Field(default="1d", description="Candle timeframe")
    conversation_id: str = Field(..., description="Active session ID for thread continuity")
    intent: CopilotIntent = Field(default=CopilotIntent.GENERAL_QUERY, description="Classified question intent")
    depth: CopilotDepth = Field(default=CopilotDepth.STANDARD, description="Response detail tier")
    context_summary: Optional[CopilotContextSummary] = Field(default=None, description="Active ORBIT analysis snapshot")
    context_available: bool = Field(default=True, description="True if valid ORBIT analysis was present")
    suggested_followups: List[str] = Field(default_factory=list, description="Context-aware suggested follow-up questions")
    warnings: List[str] = Field(default_factory=list, description="Any safety constraints or data limitations")
    latency_ms: float = Field(default=0.0, description="Total inference and context resolution time (ms)")
