"""
ORBIT AI Strategy Lab — natural-language strategy interpretation and backtesting.

This package is ADDITIVE and self-contained. It never imports the live trading
path (position_service, execution_agent, bot_service) and never opens a real
trade: everything here is simulation over historical candles.

Modules:
    schema       strict, safe strategy definition (the only thing the LLM may emit)
    indicators   deterministic indicator maths (pandas, no look-ahead)
    data         historical OHLCV provider on top of the existing market service
    engine       sequential backtest simulator
    metrics      performance statistics
    interpreter  natural language -> validated schema (LLM output is data, never code)
    store        PostgreSQL/SQLite persistence, always user-scoped
    routes       FastAPI router mounted at /api/strategy-lab by main.py
"""

from .schema import (
    SUPPORTED_VOCABULARY,
    StrategyDefinition,
    StrategyValidationError,
    validate_strategy_payload,
)

__all__ = [
    "SUPPORTED_VOCABULARY",
    "StrategyDefinition",
    "StrategyValidationError",
    "validate_strategy_payload",
]
