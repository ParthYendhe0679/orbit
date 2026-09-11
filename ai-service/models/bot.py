"""
backend/models/bot.py — ORBIT Auto-Trade Bot Session Contracts

A bot run is a user-scoped session with an explicit state machine. Its
configuration is snapshotted when it starts; its P&L and trade counts are
derived from the trades it opened (trades.bot_session_id).
"""

from enum import Enum
from typing import List, Optional
from pydantic import BaseModel, Field


class BotSessionStatus(str, Enum):
    """Lifecycle state of one bot session."""
    STOPPED = "STOPPED"                      # Terminal: stopped by the user. No scanning, no new trades.
    STARTING = "STARTING"                    # Session created; the runtime has not picked it up yet.
    SCANNING = "SCANNING"                    # Fetching market data for the selected assets.
    ANALYZING = "ANALYZING"                  # Brain / Risk Guard / Opportunity / Decision are running.
    OPPORTUNITY_FOUND = "OPPORTUNITY_FOUND"  # A directional candidate exists but is not yet approved.
    TRADE_ACTIVE = "TRADE_ACTIVE"            # Between scans with at least one open bot position.
    WAITING = "WAITING"                      # Between scans; no valid opportunity and no open position.
    TARGET_REACHED = "TARGET_REACHED"        # Terminal: realized session profit reached the target.
    MAX_LOSS_REACHED = "MAX_LOSS_REACHED"    # Terminal: the session loss limit was reached.
    STOPPING = "STOPPING"                    # Stop requested; in-flight work is finishing.
    ERROR = "ERROR"                          # Terminal: the session cannot continue safely.


# States in which the session scans and may open new trades.
ENTRY_STATES = frozenset({
    BotSessionStatus.STARTING,
    BotSessionStatus.SCANNING,
    BotSessionStatus.ANALYZING,
    BotSessionStatus.OPPORTUNITY_FOUND,
    BotSessionStatus.TRADE_ACTIVE,
    BotSessionStatus.WAITING,
})
# Every non-terminal state (at most one such session per user).
LIVE_STATES = ENTRY_STATES | {BotSessionStatus.STOPPING}
TERMINAL_STATES = frozenset({
    BotSessionStatus.STOPPED,
    BotSessionStatus.TARGET_REACHED,
    BotSessionStatus.MAX_LOSS_REACHED,
    BotSessionStatus.ERROR,
})


class BotEventType(str, Enum):
    """Activity events streamed to the owner over the /ws socket as {"type": "bot_event"}."""
    STATE_CHANGED = "STATE_CHANGED"
    SESSION_RECOVERED = "SESSION_RECOVERED"
    SCAN_STARTED = "SCAN_STARTED"
    MARKET_DATA_UPDATED = "MARKET_DATA_UPDATED"
    MARKET_DATA_FAILED = "MARKET_DATA_FAILED"
    AGENTS_COMPLETED = "AGENTS_COMPLETED"
    STRATEGIES_COMPLETED = "STRATEGIES_COMPLETED"
    RISK_EVALUATED = "RISK_EVALUATED"
    OPPORTUNITY_EVALUATED = "OPPORTUNITY_EVALUATED"
    DECISION_READY = "DECISION_READY"
    NO_OPPORTUNITY = "NO_OPPORTUNITY"
    OPPORTUNITY_DETECTED = "OPPORTUNITY_DETECTED"
    RISK_APPROVED = "RISK_APPROVED"
    RISK_REJECTED = "RISK_REJECTED"
    EXECUTION_REJECTED = "EXECUTION_REJECTED"
    TRADE_OPENED = "TRADE_OPENED"
    POSITION_MANAGED = "POSITION_MANAGED"   # P&L Manager action on an open bot position (e.g. break-even stop)
    TRADE_CLOSED = "TRADE_CLOSED"
    SCAN_COMPLETED = "SCAN_COMPLETED"
    TARGET_REACHED = "TARGET_REACHED"
    MAX_LOSS_REACHED = "MAX_LOSS_REACHED"
    ERROR = "ERROR"


class BotStartRequest(BaseModel):
    """Configuration snapshot for a new session. Validated server-side before anything is stored."""
    user_id: int
    market_category: str = Field(..., description="One of the supported market categories")
    assets: List[str] = Field(..., description="Symbols from the category's supported universe")
    allocated_capital: float = Field(..., description="Trading budget; must not exceed the wallet balance")
    target_profit: float = Field(..., description="Cumulative realized session profit that ends the session")
    max_loss: float = Field(..., description="Cumulative session loss that ends the session")
    leverage: float = Field(default=1.0, description="One of the supported leverage values")


class BotStopRequest(BaseModel):
    user_id: int
    reason: Optional[str] = None
