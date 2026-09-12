"""
Tests for the ORBIT AI Strategy Lab.

The properties that matter here are the ones a backtester is easy to get
quietly wrong:

  * no look-ahead — a signal on candle i must fill at candle i+1's open;
  * the stop loss wins a candle that contains both stop and target;
  * metrics never divide by zero and never invent a ratio;
  * the LLM can only produce a strategy that survives the validator;
  * one account can never read another account's strategies or backtests.

Everything runs against deterministic synthetic candles and the SQLite
fallback, so no test reaches a market API, an LLM provider or a real database.
"""

import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "ai-service") not in sys.path:
    sys.path.insert(0, str(ROOT / "ai-service"))

import database as db  # noqa: E402
import llm  # noqa: E402
from strategy_lab import interpreter, store  # noqa: E402
from strategy_lab.engine import (  # noqa: E402
    EXIT_END,
    EXIT_STOP_LOSS,
    EXIT_STRATEGY,
    EXIT_TAKE_PROFIT,
    run_backtest,
)
from strategy_lab.metrics import compute_metrics, downsample_curve  # noqa: E402
from strategy_lab.schema import StrategyValidationError, validate_strategy_payload  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def candles(closes, highs=None, lows=None, opens=None, start="2024-01-01", freq="D"):
    """A normalized OHLCV frame from explicit series."""
    closes = [float(c) for c in closes]
    index = pd.date_range(start, periods=len(closes), freq=freq)
    return pd.DataFrame(
        {
            "Open": [float(o) for o in (opens if opens is not None else closes)],
            "High": [float(h) for h in (highs if highs is not None else closes)],
            "Low": [float(l) for l in (lows if lows is not None else closes)],
            "Close": closes,
            "Volume": [1000.0] * len(closes),
        },
        index=index,
    )


def sma_cross_strategy(stop=None, take=None, fast=3, slow=5):
    return validate_strategy_payload({
        "strategy_name": "SMA cross",
        "entry": {"logic": "AND", "conditions": [
            {"left": {"indicator": "SMA", "period": fast}, "operator": "crosses_above",
             "right": {"indicator": "SMA", "period": slow}}]},
        "exit": {"logic": "OR", "conditions": [
            {"left": {"indicator": "SMA", "period": fast}, "operator": "crosses_below",
             "right": {"indicator": "SMA", "period": slow}}]},
        "risk": {"stop_loss_percent": stop, "take_profit_percent": take},
    })


@pytest.fixture
def lab_db(tmp_path, monkeypatch):
    """The Strategy Lab tables on a throwaway SQLite file."""
    dbfile = str(tmp_path / "strategy_lab_test.db")
    for mod in (db, sys.modules["database"]):
        monkeypatch.setattr(mod, "DB_PATH", dbfile)
        monkeypatch.setattr(mod, "IS_POSTGRES", False)
    monkeypatch.setattr(store, "_schema_ready", False)
    db.init_db()
    store.ensure_schema()
    return SimpleNamespace(path=dbfile)


# ---------------------------------------------------------------------------
# Schema / validator
# ---------------------------------------------------------------------------

def test_validator_accepts_the_documented_example():
    strategy = validate_strategy_payload({
        "strategy_name": "EMA RSI",
        "entry": {"logic": "AND", "conditions": [
            {"left": {"indicator": "EMA", "period": 20}, "operator": "crosses_above",
             "right": {"indicator": "EMA", "period": 50}},
            {"left": {"indicator": "RSI", "period": 14}, "operator": "<", "right": 70}]},
        "exit": {"logic": "OR", "conditions": [
            {"left": {"indicator": "EMA", "period": 20}, "operator": "crosses_below",
             "right": {"indicator": "EMA", "period": 50}}]},
        "risk": {"stop_loss_percent": 3},
    })
    summary = strategy.summary()
    assert summary["entry"]["conditions"] == ["EMA 20 crosses above EMA 50", "RSI 14 is below 70"]
    assert summary["exit"]["conditions"] == ["EMA 20 crosses below EMA 50"]
    assert "Stop loss: 3%" in summary["risk"]


@pytest.mark.parametrize("payload, expected", [
    ({"entry": {"conditions": [{"left": {"indicator": "MOONPHASE"}, "operator": ">", "right": 1}]}},
     "not supported"),
    ({"entry": {"conditions": [{"left": {"indicator": "RSI"}, "operator": "is_vibing", "right": 30}]}},
     "not supported"),
    ({"entry": {"conditions": []}}, "no entry condition"),
    # No exit rule, no stop, no target: the position could never be closed.
    ({"entry": {"conditions": [{"left": {"indicator": "RSI"}, "operator": "<", "right": 30}]}},
     "never be closed"),
])
def test_validator_refuses_what_the_engine_cannot_run(payload, expected):
    with pytest.raises(StrategyValidationError) as excinfo:
        validate_strategy_payload(payload)
    reported = (excinfo.value.message + " " + " ".join(excinfo.value.issues)).lower()
    assert expected.lower() in reported


def test_shorting_and_leverage_are_refused():
    base = {"entry": {"conditions": [{"left": {"indicator": "RSI"}, "operator": "<", "right": 30}]},
            "risk": {"stop_loss_percent": 2}}
    with pytest.raises(StrategyValidationError):
        validate_strategy_payload({**base, "direction": "short"})
    with pytest.raises(StrategyValidationError):
        validate_strategy_payload({**base, "risk": {"stop_loss_percent": 2, "position_size_percent": 400}})


# ---------------------------------------------------------------------------
# Execution model
# ---------------------------------------------------------------------------

def test_entry_fills_on_the_next_candle_open_not_the_signal_candle():
    """The candle that produces the signal must not be the candle that fills."""
    closes = [100.0] * 10 + [101, 102, 103, 104, 105, 106, 107, 108, 109, 110] + [111.0] * 10
    frame = candles(closes)
    # Make each open distinguishable from the close that generated the signal.
    frame["Open"] = frame["Close"] - 0.5
    frame["High"] = frame["Close"] + 0.25
    frame["Low"] = frame["Open"] - 0.25

    result = run_backtest(frame, sma_cross_strategy(stop=50), 10_000.0, "TEST")
    assert result.trades, "the crossover should have opened a trade"
    trade = result.trades[0]
    entry_index = list(frame.index.strftime("%Y-%m-%dT%H:%M:%S")).index(trade["entry_time"])
    # The fill price is that candle's OPEN, and the signal came from the close
    # of the candle before it.
    assert trade["entry_price"] == pytest.approx(float(frame["Open"].iloc[entry_index]))
    assert entry_index >= 1


def test_a_signal_on_the_final_candle_never_fills():
    """There is no next candle to fill on, so no trade may be invented."""
    closes = [100.0] * 12 + [101, 103, 106, 110]  # cross happens right at the end
    frame = candles(closes)
    result = run_backtest(frame, sma_cross_strategy(stop=5), 10_000.0, "TEST")
    for trade in result.trades:
        assert trade["entry_time"] != frame.index[-1].isoformat()


def test_stop_loss_wins_when_one_candle_contains_both_stop_and_target():
    """The pessimistic branch is taken; results are never flattered."""
    # Flat, then a cross, then a candle whose range spans -10% and +10%.
    closes = [100.0] * 8 + [101, 102, 103, 104, 105, 105, 105, 105]
    frame = candles(closes)
    wide = len(closes) - 1
    frame.loc[frame.index[wide], "High"] = 200.0   # far above any take profit
    frame.loc[frame.index[wide], "Low"] = 1.0      # far below any stop loss

    result = run_backtest(frame, sma_cross_strategy(stop=3, take=3), 10_000.0, "TEST")
    assert result.trades
    reasons = {t["exit_reason"] for t in result.trades}
    assert EXIT_TAKE_PROFIT not in reasons or EXIT_STOP_LOSS in reasons
    last = result.trades[-1]
    assert last["exit_reason"] == EXIT_STOP_LOSS
    # Filled exactly at the stop, not at the candle low.
    assert last["exit_price"] == pytest.approx(last["entry_price"] * 0.97, rel=1e-6)


def test_take_profit_fills_at_the_target_price():
    closes = [100.0] * 10 + [101, 102, 103, 104, 105, 106, 107, 108, 109, 110] + [111.0] * 10
    frame = candles(closes, highs=[c * 1.01 for c in closes], lows=[c * 0.99 for c in closes])
    result = run_backtest(frame, sma_cross_strategy(stop=2, take=5), 10_000.0, "TEST")
    winner = [t for t in result.trades if t["exit_reason"] == EXIT_TAKE_PROFIT]
    assert winner
    assert winner[0]["exit_price"] == pytest.approx(winner[0]["entry_price"] * 1.05, rel=1e-6)


def test_an_open_position_is_closed_on_the_last_candle():
    closes = [100.0] * 8 + list(np.linspace(101, 140, 20))  # never crosses back down
    frame = candles(closes)
    result = run_backtest(frame, sma_cross_strategy(), 10_000.0, "TEST")
    assert result.trades[-1]["exit_reason"] == EXIT_END
    assert result.trades[-1]["exit_time"] == frame.index[-1].isoformat()


def test_equity_curve_covers_every_traded_candle_and_ends_at_final_equity():
    closes = [100.0] * 8 + list(np.linspace(101, 130, 24)) + list(np.linspace(129, 105, 20))
    frame = candles(closes)
    result = run_backtest(frame, sma_cross_strategy(stop=10), 10_000.0, "TEST")
    assert result.equity_curve
    assert result.equity_curve[-1]["equity"] == pytest.approx(result.metrics["final_equity"], rel=1e-6)
    assert result.equity_curve[0]["time"] <= result.equity_curve[-1]["time"]


def test_warmup_candles_are_not_traded():
    closes = [100.0] * 6 + [101, 102, 103, 104, 105, 106, 107, 108] + [109.0] * 8
    frame = candles(closes)
    result = run_backtest(frame, sma_cross_strategy(stop=5), 10_000.0, "TEST", warmup_candles=12)
    for trade in result.trades:
        assert trade["entry_time"] >= frame.index[12].isoformat()


def test_commission_reduces_the_result():
    closes = [100.0] * 8 + list(np.linspace(101, 130, 24))
    frame = candles(closes)
    free = run_backtest(frame, sma_cross_strategy(), 10_000.0, "TEST", commission_percent=0.0)
    charged = run_backtest(frame, sma_cross_strategy(), 10_000.0, "TEST", commission_percent=0.5)
    assert charged.metrics["final_equity"] < free.metrics["final_equity"]


def test_a_strategy_that_never_triggers_produces_no_trades_and_no_fake_metrics():
    frame = candles([100.0] * 40)  # perfectly flat: no crossover ever
    result = run_backtest(frame, sma_cross_strategy(stop=2), 10_000.0, "TEST")
    assert result.trades == []
    assert result.metrics["total_trades"] == 0
    assert result.metrics["final_equity"] == pytest.approx(10_000.0)
    # Statistics that need trades are absent, not zero-filled.
    for key in ("win_rate", "average_win", "average_loss", "profit_factor"):
        assert result.metrics[key] is None


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def test_metrics_never_divide_by_zero():
    metrics = compute_metrics(10_000.0, [10_000.0], ["2024-01-01T00:00:00"], [])
    assert metrics["profit_factor"] is None
    assert metrics["win_rate"] is None
    assert metrics["max_drawdown_percent"] == 0.0
    assert metrics["sharpe_ratio"] is None and metrics["calmar_ratio"] is None
    assert metrics["notes"]


def test_risk_ratios_need_enough_observations():
    times = pd.date_range("2024-01-01", periods=10, freq="D").strftime("%Y-%m-%dT%H:%M:%S").tolist()
    metrics = compute_metrics(10_000.0, list(np.linspace(10_000, 11_000, 10)), times, [])
    assert metrics["sharpe_ratio"] is None
    assert any("Sharpe" in note for note in metrics["notes"])


def test_max_drawdown_is_peak_to_trough():
    equity = [100.0, 120.0, 60.0, 90.0]
    metrics = compute_metrics(100.0, equity, [f"2024-01-0{i + 1}T00:00:00" for i in range(4)], [])
    assert metrics["max_drawdown_percent"] == pytest.approx(50.0)
    assert metrics["max_drawdown_value"] == pytest.approx(60.0)


def test_downsampling_keeps_the_first_and_last_point():
    times = pd.date_range("2024-01-01", periods=5000, freq="h")
    values = list(np.linspace(10_000, 20_000, 5000))
    curve = downsample_curve(list(times), values)
    assert len(curve) <= 601
    assert curve[0]["equity"] == pytest.approx(values[0])
    assert curve[-1]["equity"] == pytest.approx(values[-1])


# ---------------------------------------------------------------------------
# Interpreter — the LLM may only produce validated data
# ---------------------------------------------------------------------------

def test_interpreter_reports_an_error_when_no_provider_is_configured(monkeypatch):
    monkeypatch.setattr(llm, "is_enabled", lambda: False)
    result = interpreter.interpret_strategy("buy when RSI is below 30, sell at 5% profit")
    assert result.status == "error"
    assert result.strategy is None


def test_interpreter_accepts_a_valid_structured_answer(monkeypatch):
    payload = """```json
    {"status": "ok", "strategy": {"strategy_name": "RSI dip",
      "entry": {"logic": "AND", "conditions": [
        {"left": {"indicator": "RSI", "period": 14}, "operator": "<", "right": 30}]},
      "exit": {"logic": "OR", "conditions": []},
      "risk": {"stop_loss_percent": 3, "take_profit_percent": 6}}}
    ```"""
    monkeypatch.setattr(llm, "is_enabled", lambda: True)
    monkeypatch.setattr(llm, "generate_text", lambda *a, **k: payload)
    result = interpreter.interpret_strategy("buy the dip on RSI 30, 3% stop, 6% target")
    assert result.status == "ok"
    assert result.strategy is not None
    assert result.strategy.risk.stop_loss_percent == 3


def test_interpreter_passes_through_a_clarification_instead_of_guessing(monkeypatch):
    payload = ('{"status": "needs_clarification", "message": "How should strength be measured?",'
               ' "questions": ["Which indicator defines a strong market?"],'
               ' "suggestions": ["RSI above 55"], "unsupported": []}')
    monkeypatch.setattr(llm, "is_enabled", lambda: True)
    monkeypatch.setattr(llm, "generate_text", lambda *a, **k: payload)
    result = interpreter.interpret_strategy("buy bitcoin when the market looks strong")
    assert result.status == "needs_clarification"
    assert result.strategy is None
    assert result.questions


def test_an_unsupported_indicator_from_the_llm_is_rejected_not_executed(monkeypatch):
    """Even a well-formed answer naming an unknown indicator must not run."""
    payload = ('{"status": "ok", "strategy": {"entry": {"conditions": ['
               '{"left": {"indicator": "MOON_PHASE"}, "operator": ">", "right": 0.5}]},'
               ' "risk": {"stop_loss_percent": 2}}}')
    monkeypatch.setattr(llm, "is_enabled", lambda: True)
    monkeypatch.setattr(llm, "generate_text", lambda *a, **k: payload)
    result = interpreter.interpret_strategy("buy when the moon phase is favourable")
    assert result.status != "ok"
    assert result.strategy is None


def test_prose_and_broken_json_never_become_a_strategy(monkeypatch):
    monkeypatch.setattr(llm, "is_enabled", lambda: True)
    monkeypatch.setattr(llm, "generate_text", lambda *a, **k: "Sure! Here is some Python:\nimport os")
    result = interpreter.interpret_strategy("buy low sell high")
    assert result.status != "ok"
    assert result.strategy is None


def test_extract_json_object_ignores_trailing_prose():
    assert interpreter.extract_json_object('noise {"a": {"b": 1}} trailing words') == {"a": {"b": 1}}
    assert interpreter.extract_json_object("no json here at all") is None


# ---------------------------------------------------------------------------
# Persistence and user scoping
# ---------------------------------------------------------------------------

def _user(name):
    row = db.get_or_create_user(name)
    return row[0] if isinstance(row, (tuple, list)) else row["id"]


def test_strategies_and_backtests_are_scoped_to_their_owner(lab_db):
    alice, bob = _user("lab_alice"), _user("lab_bob")
    definition = sma_cross_strategy(stop=3).model_dump(mode="json")

    saved = store.save_strategy(alice, "Alice strategy", "desc", definition, "crypto", "BTC-USD", "1h")
    assert store.get_strategy(alice, saved["id"])["name"] == "Alice strategy"
    # Bob can neither read nor delete it, and it is invisible in his list.
    assert store.get_strategy(bob, saved["id"]) is None
    assert store.delete_strategy(bob, saved["id"]) is False
    assert store.list_strategies(bob) == []

    backtest_id = store.save_backtest(
        alice, saved["id"], "Alice strategy", definition, "crypto", "BTC-USD", "1h",
        "2024-01-01T00:00:00", "2024-06-01T00:00:00", 10_000.0,
        {"net_profit": 100.0, "total_trades": 1}, [{"time": "2024-01-01T00:00:00", "equity": 10_000.0}],
        [{"trade_id": 1, "symbol": "BTC-USD", "side": "LONG", "entry_time": "2024-01-02T00:00:00",
          "exit_time": "2024-01-03T00:00:00", "entry_price": 1.0, "exit_price": 2.0, "quantity": 1.0,
          "pnl": 1.0, "pnl_percent": 100.0, "exit_reason": EXIT_STRATEGY}],
        {"source": "test"}, {"fill": "next candle open"},
    )
    record = store.get_backtest(alice, backtest_id)
    assert record["metrics"]["total_trades"] == 1
    assert len(record["trades"]) == 1

    assert store.get_backtest(bob, backtest_id) is None
    assert store.delete_backtest(bob, backtest_id) is False
    assert store.list_backtests(bob) == []
    assert [r["id"] for r in store.list_backtests(alice)] == [backtest_id]

    assert store.delete_backtest(alice, backtest_id) is True
    assert store.get_backtest(alice, backtest_id) is None


def test_backtest_results_survive_a_round_trip_through_the_database(lab_db):
    """A real engine result must be JSON-serializable and come back unchanged."""
    owner = _user("lab_roundtrip")
    closes = [100.0] * 8 + list(np.linspace(101, 130, 24)) + list(np.linspace(129, 110, 12))
    frame = candles(closes)
    strategy = sma_cross_strategy(stop=5, take=9)
    result = run_backtest(frame, strategy, 10_000.0, "BTC-USD")

    backtest_id = store.save_backtest(
        owner, None, strategy.strategy_name, strategy.model_dump(mode="json"), "crypto",
        "BTC-USD", "1d", frame.index[0].isoformat(), frame.index[-1].isoformat(), 10_000.0,
        result.metrics, result.equity_curve, result.trades, {"source": "test"}, result.execution_model,
    )
    stored = store.get_backtest(owner, backtest_id)
    assert stored["metrics"]["total_trades"] == result.metrics["total_trades"]
    assert len(stored["trades"]) == len(result.trades)
    assert stored["execution_model"]["order_filled_at"] == "next candle open"
