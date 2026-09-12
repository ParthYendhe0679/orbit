"""
strategy_lab/engine.py - the backtest simulator.

This engine is deliberately isolated from every live path in ORBIT. It has no
import of position_service, execution_agent, bot_service or database write
helpers: it cannot open a trade, move a balance, touch margin or reach a
broker. It walks historical candles with simulated capital and returns
numbers.

EXECUTION MODEL (documented, consistent, and applied to every trade)
--------------------------------------------------------------------
1. Conditions are evaluated on the CLOSE of candle i, using only candles up
   to and including i. A crossover compares candle i with candle i-1.
2. The resulting order fills at the OPEN of candle i+1. Nothing ever fills at
   the price that generated the signal - that would be a look-ahead fill.
3. While a position is open, the stop loss and take profit are checked
   against each candle's high/low, starting with the candle the position was
   opened on.
4. If a candle's range contains BOTH the stop loss and the take profit, the
   STOP LOSS is taken. Intra-candle order is unknowable from OHLC, so the
   pessimistic branch is chosen; results are never flattered.
5. A position still open on the final candle is closed at that candle's close
   with the reason END_OF_BACKTEST.
6. Long only, unleveraged, and a position is sized as
   risk.position_size_percent of the equity at fill time.
"""

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from .indicators import build_indicator_frame
from .metrics import compute_metrics, downsample_curve
from .schema import Condition, ConditionGroup, StrategyDefinition, ValueOperand

logger = logging.getLogger("orbit.strategy_lab.engine")

EXIT_STOP_LOSS = "STOP_LOSS"
EXIT_TAKE_PROFIT = "TAKE_PROFIT"
EXIT_STRATEGY = "STRATEGY_EXIT"
EXIT_END = "END_OF_BACKTEST"

# Hard ceiling so one request can never pin a worker to a huge series.
MAX_CANDLES = 120000


@dataclass
class SimulatedTrade:
    trade_id: int
    symbol: str
    side: str
    entry_time: pd.Timestamp
    entry_price: float
    quantity: float
    stop_loss: Optional[float]
    take_profit: Optional[float]
    exit_time: Optional[pd.Timestamp] = None
    exit_price: Optional[float] = None
    exit_reason: Optional[str] = None
    pnl: float = 0.0
    pnl_percent: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        # Every number is cast to a plain float: numpy scalars survive pandas
        # arithmetic and json.dumps cannot serialize them, which would break
        # both the Valkey cache and the database write.
        return {
            "trade_id": int(self.trade_id),
            "symbol": self.symbol,
            "side": self.side,
            "entry_time": self.entry_time.isoformat(),
            "exit_time": self.exit_time.isoformat() if self.exit_time is not None else None,
            "entry_price": round(float(self.entry_price), 8),
            "exit_price": round(float(self.exit_price), 8) if self.exit_price is not None else None,
            "quantity": round(float(self.quantity), 10),
            "pnl": round(float(self.pnl), 4),
            "pnl_percent": round(float(self.pnl_percent), 4),
            "exit_reason": self.exit_reason,
        }


@dataclass
class _Position:
    entry_index: int
    entry_time: pd.Timestamp
    entry_price: float
    quantity: float
    stop_loss: Optional[float]
    take_profit: Optional[float]
    cost: float = 0.0


@dataclass
class BacktestResult:
    metrics: Dict[str, Any]
    trades: List[Dict[str, Any]] = field(default_factory=list)
    equity_curve: List[Dict[str, Any]] = field(default_factory=list)
    execution_model: Dict[str, Any] = field(default_factory=dict)
    signals_skipped_warmup: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "metrics": self.metrics,
            "trades": self.trades,
            "equity_curve": self.equity_curve,
            "execution_model": self.execution_model,
        }


# ---------------------------------------------------------------------------
# Condition evaluation
# ---------------------------------------------------------------------------

def _series_for(operand: Any, frame: pd.DataFrame, length: int) -> np.ndarray:
    if isinstance(operand, ValueOperand):
        return np.full(length, float(operand.value), dtype=float)
    return frame[operand.key()].to_numpy(dtype=float)


def _evaluate_condition(condition: Condition, frame: pd.DataFrame, length: int) -> np.ndarray:
    """A boolean array: is this condition true at the close of each candle?

    Every comparison reads index i (and i-1 for crossovers) only. NaN - an
    indicator that has not warmed up - is False, never a signal.
    """
    left = _series_for(condition.left, frame, length)
    right = _series_for(condition.right, frame, length)
    op = condition.operator

    with np.errstate(invalid="ignore"):
        if op == ">":
            out = left > right
        elif op == "<":
            out = left < right
        elif op == ">=":
            out = left >= right
        elif op == "<=":
            out = left <= right
        else:
            prev_left = np.roll(left, 1)
            prev_right = np.roll(right, 1)
            prev_left[0] = np.nan
            prev_right[0] = np.nan
            if op == "crosses_above":
                out = (prev_left <= prev_right) & (left > right)
            else:
                out = (prev_left >= prev_right) & (left < right)
            out = out & ~np.isnan(prev_left) & ~np.isnan(prev_right)

    return np.asarray(out) & ~np.isnan(left) & ~np.isnan(right)


def _evaluate_group(group: ConditionGroup, frame: pd.DataFrame, length: int) -> np.ndarray:
    if not group.conditions:
        return np.zeros(length, dtype=bool)
    results = [_evaluate_condition(c, frame, length) for c in group.conditions]
    combined = results[0]
    for result in results[1:]:
        combined = (combined & result) if group.logic == "AND" else (combined | result)
    return combined


def _ready_mask(frame: pd.DataFrame, length: int) -> np.ndarray:
    """True from the candle where every referenced series has a value."""
    if frame.empty or not len(frame.columns):
        return np.ones(length, dtype=bool)
    return ~frame.isna().any(axis=1).to_numpy()


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------

def run_backtest(
    df: pd.DataFrame,
    strategy: StrategyDefinition,
    initial_capital: float,
    symbol: str,
    warmup_candles: int = 0,
    commission_percent: float = 0.0,
) -> BacktestResult:
    """Walk the candles once, forward in time, and report what happened."""
    if df is None or df.empty:
        raise ValueError("No candles to backtest.")
    if len(df) > MAX_CANDLES:
        df = df.iloc[-MAX_CANDLES:]
    if initial_capital <= 0:
        raise ValueError("Initial capital must be greater than zero.")

    length = len(df)
    frame = build_indicator_frame(df, strategy)
    entry_signal = _evaluate_group(strategy.entry, frame, length)
    exit_signal = _evaluate_group(strategy.exit, frame, length)
    ready = _ready_mask(frame, length)

    opens = df["Open"].to_numpy(dtype=float)
    highs = df["High"].to_numpy(dtype=float)
    lows = df["Low"].to_numpy(dtype=float)
    closes = df["Close"].to_numpy(dtype=float)
    times = df.index

    # Trading starts after the requested warm-up prefix AND after every
    # indicator has a value. Signals before that point are not tradable.
    first_tradable = max(int(warmup_candles), 0)
    ready_indices = np.nonzero(ready)[0]
    if ready_indices.size == 0:
        raise ValueError(
            "The indicators never warmed up over this data. Use a longer backtest period "
            "or shorter indicator periods."
        )
    first_tradable = max(first_tradable, int(ready_indices[0]))
    if first_tradable >= length - 1:
        raise ValueError(
            "After indicator warm-up there are no candles left to trade. "
            "Use a longer backtest period or shorter indicator periods."
        )

    skipped = int(np.count_nonzero(entry_signal[:first_tradable]))

    size_fraction = float(strategy.risk.position_size_percent) / 100.0
    stop_pct = strategy.risk.stop_loss_percent
    take_pct = strategy.risk.take_profit_percent
    fee = max(0.0, float(commission_percent)) / 100.0

    cash = float(initial_capital)
    position: Optional[_Position] = None
    trades: List[SimulatedTrade] = []
    equity_times: List[pd.Timestamp] = []
    equity_values: List[float] = []
    trade_seq = 0

    # An order decided on candle i-1 fills on candle i's open.
    pending: Optional[str] = None  # "ENTRY" or "EXIT"

    def open_position(index: int) -> None:
        nonlocal cash, position, trade_seq
        price = float(opens[index])
        if not np.isfinite(price) or price <= 0:
            return
        budget = cash * size_fraction
        quantity = float(budget) / (float(price) * (1.0 + fee))
        if quantity <= 0:
            return
        cost = float(quantity * price * (1.0 + fee))
        cash -= float(cost)
        trade_seq += 1
        position = _Position(
            entry_index=index,
            entry_time=times[index],
            entry_price=price,
            quantity=quantity,
            stop_loss=price * (1.0 - stop_pct / 100.0) if stop_pct else None,
            take_profit=price * (1.0 + take_pct / 100.0) if take_pct else None,
            cost=cost,
        )

    def close_position(index: int, price: float, reason: str) -> None:
        nonlocal cash, position
        if position is None:
            return
        proceeds = position.quantity * float(price) * (1.0 - fee)
        cash += float(proceeds)
        pnl = proceeds - position.cost
        trade = SimulatedTrade(
            trade_id=trade_seq,
            symbol=symbol,
            side="LONG",
            entry_time=position.entry_time,
            entry_price=position.entry_price,
            quantity=position.quantity,
            stop_loss=position.stop_loss,
            take_profit=position.take_profit,
            exit_time=times[index],
            exit_price=float(price),
            exit_reason=reason,
            pnl=float(pnl),
            pnl_percent=float(pnl / position.cost * 100.0) if position.cost > 0 else 0.0,
        )
        trades.append(trade)
        position = None

    for i in range(first_tradable, length):
        # 1. Fill the order decided on the previous candle, at this candle's open.
        if pending == "ENTRY" and position is None:
            open_position(i)
        elif pending == "EXIT" and position is not None:
            close_position(i, opens[i], EXIT_STRATEGY)
        pending = None

        # 2. Protective exits, checked against this candle's range (including
        #    the candle the position was opened on).
        if position is not None:
            hit_stop = position.stop_loss is not None and lows[i] <= position.stop_loss
            hit_take = position.take_profit is not None and highs[i] >= position.take_profit
            if hit_stop and hit_take:
                # Both inside one candle: assume the stop was reached first.
                close_position(i, position.stop_loss, EXIT_STOP_LOSS)
            elif hit_stop:
                close_position(i, position.stop_loss, EXIT_STOP_LOSS)
            elif hit_take:
                close_position(i, position.take_profit, EXIT_TAKE_PROFIT)

        # 3. Decide the next candle's order from this candle's close.
        if i < length - 1:
            if position is not None:
                if exit_signal[i]:
                    pending = "EXIT"
            elif entry_signal[i]:
                pending = "ENTRY"

        # 4. Mark to market at this candle's close.
        equity = cash + (position.quantity * closes[i] if position is not None else 0.0)
        equity_times.append(times[i])
        equity_values.append(float(equity))

    # 5. Anything still open is closed on the last candle's close.
    if position is not None:
        last = length - 1
        close_position(last, closes[last], EXIT_END)
        equity_values[-1] = float(cash)

    trade_dicts = [t.to_dict() for t in trades]
    metrics = compute_metrics(
        initial_capital=float(initial_capital),
        equity_values=equity_values,
        equity_times=[t.isoformat() for t in equity_times],
        trades=trade_dicts,
    )

    return BacktestResult(
        metrics=metrics,
        trades=trade_dicts,
        equity_curve=downsample_curve(equity_times, equity_values),
        execution_model={
            "signal_evaluated_on": "candle close",
            "order_filled_at": "next candle open",
            "stop_and_target_checked_on": "each candle high/low, from the entry candle",
            "same_candle_stop_and_target": "stop loss assumed first (conservative)",
            "open_position_at_end": "closed at the final candle close (END_OF_BACKTEST)",
            "direction": "long only, unleveraged",
            "position_size_percent": strategy.risk.position_size_percent,
            "commission_percent": round(float(commission_percent), 6),
            "warmup_candles_skipped": first_tradable,
        },
        signals_skipped_warmup=skipped,
    )
