"""
strategy_lab/schema.py - the safe strategy vocabulary.

A natural-language description is turned into an instance of
:class:`StrategyDefinition` and nothing else. The LLM may only fill in this
structure; it can never emit code, an expression string, or an indicator the
engine does not implement. Anything outside the vocabulary is rejected here,
before the backtest engine ever sees it.
"""

from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator


class StrategyValidationError(ValueError):
    """A strategy payload is not expressible in the supported vocabulary."""

    def __init__(self, message: str, issues: Optional[List[str]] = None):
        super().__init__(message)
        self.message = message
        self.issues = issues or []


# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------
# Every indicator here is implemented in strategy_lab/indicators.py. Adding a
# name to this table without implementing it is a bug the validator catches.

INDICATOR_SPECS: Dict[str, Dict[str, Any]] = {
    "SMA": {"label": "Simple Moving Average", "fields": ["value"], "default_period": 20, "period_range": (2, 400)},
    "EMA": {"label": "Exponential Moving Average", "fields": ["value"], "default_period": 20, "period_range": (2, 400)},
    "RSI": {"label": "Relative Strength Index", "fields": ["value"], "default_period": 14, "period_range": (2, 100)},
    "MACD": {"label": "MACD", "fields": ["line", "signal", "histogram"], "default_period": 12, "period_range": (2, 100)},
    "BBANDS": {"label": "Bollinger Bands", "fields": ["upper", "middle", "lower"], "default_period": 20, "period_range": (5, 200)},
    "ATR": {"label": "Average True Range", "fields": ["value"], "default_period": 14, "period_range": (2, 100)},
}

PRICE_FIELDS = ("open", "high", "low", "close", "volume")

COMPARISON_OPERATORS = (">", "<", ">=", "<=", "crosses_above", "crosses_below")

LOGIC_OPERATORS = ("AND", "OR")

# Timeframes the historical data layer can actually serve (see data.py).
TIMEFRAMES = ("1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w")

# Market labels shown in the UI. They map onto symbols the existing
# MarketDataService already serves; no new market is invented here.
MARKETS = ("crypto", "us_stocks", "nse", "bse", "forex", "commodities", "indices")

MAX_CONDITIONS_PER_GROUP = 6


# ---------------------------------------------------------------------------
# Operands
# ---------------------------------------------------------------------------

class IndicatorOperand(BaseModel):
    """One indicator series, e.g. EMA(20) or the MACD signal line."""

    type: Literal["indicator"] = "indicator"
    indicator: str
    period: Optional[int] = None
    # Second/third period for multi-period indicators (MACD slow and signal EMAs).
    slow_period: Optional[int] = None
    signal_period: Optional[int] = None
    # Standard-deviation multiplier for Bollinger Bands.
    std_dev: Optional[float] = None
    # Which output of a multi-output indicator to read.
    field: str = "value"
    # Which price series the indicator is computed on.
    source: Literal["open", "high", "low", "close"] = "close"

    @field_validator("indicator", mode="before")
    @classmethod
    def _normalize_name(cls, v: Any) -> Any:
        if isinstance(v, str):
            key = v.strip().upper().replace(" ", "").replace("-", "").replace("_", "")
            aliases = {
                "BB": "BBANDS", "BOLLINGER": "BBANDS", "BOLLINGERBANDS": "BBANDS", "BBAND": "BBANDS",
                "MOVINGAVERAGE": "SMA", "MA": "SMA", "SIMPLEMOVINGAVERAGE": "SMA",
                "EXPONENTIALMOVINGAVERAGE": "EMA",
                "AVERAGETRUERANGE": "ATR",
                "RELATIVESTRENGTHINDEX": "RSI",
            }
            return aliases.get(key, key)
        return v

    @field_validator("field", mode="before")
    @classmethod
    def _normalize_field(cls, v: Any) -> Any:
        if isinstance(v, str):
            text = v.strip().lower()
            return {"macd": "line", "macd_line": "line", "signal_line": "signal",
                    "hist": "histogram", "upper_band": "upper", "lower_band": "lower",
                    "middle_band": "middle", "basis": "middle"}.get(text, text)
        return v

    @model_validator(mode="after")
    def _check(self) -> "IndicatorOperand":
        spec = INDICATOR_SPECS.get(self.indicator)
        if spec is None:
            raise ValueError(
                "Indicator " + str(self.indicator) + " is not supported. Supported indicators: "
                + ", ".join(sorted(INDICATOR_SPECS)) + "."
            )
        if self.field not in spec["fields"]:
            raise ValueError(
                self.indicator + " has no output '" + str(self.field) + "'. Available: "
                + ", ".join(spec["fields"]) + "."
            )
        if self.period is None:
            self.period = spec["default_period"]
        low, high = spec["period_range"]
        if not (low <= self.period <= high):
            raise ValueError(
                self.indicator + " period must be between " + str(low) + " and " + str(high)
                + " (got " + str(self.period) + ")."
            )
        if self.indicator == "MACD":
            self.slow_period = self.slow_period or 26
            self.signal_period = self.signal_period or 9
            if not (2 <= self.slow_period <= 200) or not (2 <= self.signal_period <= 100):
                raise ValueError("MACD slow_period must be 2-200 and signal_period 2-100.")
            if self.slow_period <= self.period:
                raise ValueError("MACD slow_period must be greater than the fast period.")
        if self.indicator == "BBANDS":
            self.std_dev = 2.0 if self.std_dev is None else float(self.std_dev)
            if not (0.1 <= self.std_dev <= 5.0):
                raise ValueError("Bollinger Bands std_dev must be between 0.1 and 5.")
        return self

    def key(self) -> str:
        """Stable identifier for the computed series (used as a column name)."""
        parts = [self.indicator, str(self.period), self.source, self.field]
        if self.indicator == "MACD":
            parts += [str(self.slow_period), str(self.signal_period)]
        if self.indicator == "BBANDS":
            parts += [str(self.std_dev)]
        return ":".join(parts)

    def describe(self) -> str:
        if self.indicator == "MACD":
            base = "MACD(" + str(self.period) + "," + str(self.slow_period) + "," + str(self.signal_period) + ")"
            return base if self.field == "line" else base + " " + self.field
        if self.indicator == "BBANDS":
            return "Bollinger(" + str(self.period) + ", " + str(self.std_dev) + " SD) " + self.field + " band"
        label = self.indicator + " " + str(self.period)
        return label if self.source == "close" else label + " of " + self.source


class PriceOperand(BaseModel):
    """A raw price or volume series."""

    type: Literal["price"] = "price"
    field: Literal["open", "high", "low", "close", "volume"] = "close"

    @field_validator("field", mode="before")
    @classmethod
    def _lower(cls, v: Any) -> Any:
        return v.strip().lower() if isinstance(v, str) else v

    def key(self) -> str:
        return "PRICE:" + self.field

    def describe(self) -> str:
        return "Volume" if self.field == "volume" else self.field.capitalize() + " price"


class ValueOperand(BaseModel):
    """A constant number, e.g. the 70 in 'RSI is below 70'."""

    type: Literal["value"] = "value"
    value: float

    def key(self) -> str:
        return "VALUE:" + repr(self.value)

    def describe(self) -> str:
        return ("%g" % self.value)


Operand = Union[IndicatorOperand, PriceOperand, ValueOperand]


def _coerce_operand(raw: Any) -> Any:
    """Accept the shapes an LLM realistically produces; reject everything else."""
    if isinstance(raw, BaseModel):
        return raw
    if isinstance(raw, bool):
        raise ValueError("A boolean is not a supported operand.")
    if isinstance(raw, (int, float)):
        return ValueOperand(value=float(raw))
    if isinstance(raw, str):
        text = raw.strip().lower()
        if text in PRICE_FIELDS:
            return PriceOperand(field=text)
        try:
            return ValueOperand(value=float(text))
        except ValueError:
            raise ValueError("'" + raw + "' is not a supported operand. Use an indicator, a price field or a number.")
    if isinstance(raw, dict):
        kind = str(raw.get("type", "")).strip().lower()
        if "indicator" in raw and kind != "price":
            return IndicatorOperand(**raw)
        if kind == "price" or ("field" in raw and "value" not in raw):
            return PriceOperand(field=str(raw.get("field", "close")).strip().lower())
        if kind == "value" or "value" in raw:
            return ValueOperand(value=float(raw["value"]))
    raise ValueError("An operand must be an indicator, a price series, or a number.")


# ---------------------------------------------------------------------------
# Conditions
# ---------------------------------------------------------------------------

class Condition(BaseModel):
    """left <operator> right, evaluated candle by candle."""

    left: Operand
    operator: str
    right: Operand

    @field_validator("left", "right", mode="before")
    @classmethod
    def _operand(cls, v: Any) -> Any:
        return _coerce_operand(v)

    @field_validator("operator", mode="before")
    @classmethod
    def _operator(cls, v: Any) -> Any:
        if not isinstance(v, str):
            raise ValueError("operator must be a string.")
        text = v.strip().lower().replace(" ", "_")
        aliases = {
            "above": ">", "greater_than": ">", "gt": ">", "is_above": ">", "rises_above": ">",
            "below": "<", "less_than": "<", "lt": "<", "is_below": "<", "under": "<",
            "gte": ">=", "greater_than_or_equal": ">=", "at_least": ">=",
            "lte": "<=", "less_than_or_equal": "<=", "at_most": "<=",
            "crossover": "crosses_above", "cross_above": "crosses_above", "crossabove": "crosses_above",
            "crosses_over": "crosses_above", "crosses_above": "crosses_above",
            "crossunder": "crosses_below", "cross_below": "crosses_below", "crossbelow": "crosses_below",
            "crosses_under": "crosses_below", "crosses_below": "crosses_below",
        }
        op = aliases.get(text, v.strip())
        if op not in COMPARISON_OPERATORS:
            raise ValueError(
                "Operator '" + str(v) + "' is not supported. Supported: " + ", ".join(COMPARISON_OPERATORS) + "."
            )
        return op

    @model_validator(mode="after")
    def _check(self) -> "Condition":
        if isinstance(self.left, ValueOperand) and isinstance(self.right, ValueOperand):
            raise ValueError("A condition comparing two constants can never be a trading signal.")
        if self.operator in ("crosses_above", "crosses_below") and isinstance(self.left, ValueOperand):
            raise ValueError("Only a series can cross a level, not a constant. Put the series on the left.")
        return self

    def describe(self) -> str:
        words = {
            ">": "is above", "<": "is below", ">=": "is at or above", "<=": "is at or below",
            "crosses_above": "crosses above", "crosses_below": "crosses below",
        }
        return self.left.describe() + " " + words[self.operator] + " " + self.right.describe()


class ConditionGroup(BaseModel):
    """A set of conditions combined with a single logical operator."""

    logic: Literal["AND", "OR"] = "AND"
    conditions: List[Condition] = Field(default_factory=list)

    @field_validator("logic", mode="before")
    @classmethod
    def _logic(cls, v: Any) -> Any:
        if isinstance(v, str) and v.strip().upper() in LOGIC_OPERATORS:
            return v.strip().upper()
        raise ValueError("logic must be AND or OR.")

    @field_validator("conditions", mode="before")
    @classmethod
    def _limit(cls, v: Any) -> Any:
        if isinstance(v, list) and len(v) > MAX_CONDITIONS_PER_GROUP:
            raise ValueError(
                "At most " + str(MAX_CONDITIONS_PER_GROUP) + " conditions are supported per rule set."
            )
        return v

    def describe(self) -> List[str]:
        return [c.describe() for c in self.conditions]


# ---------------------------------------------------------------------------
# Risk
# ---------------------------------------------------------------------------

class RiskSettings(BaseModel):
    stop_loss_percent: Optional[float] = None
    take_profit_percent: Optional[float] = None
    # Share of current equity committed per trade. No leverage, ever.
    position_size_percent: float = 100.0

    @model_validator(mode="after")
    def _check(self) -> "RiskSettings":
        for name in ("stop_loss_percent", "take_profit_percent"):
            v = getattr(self, name)
            if v is not None:
                v = float(v)
                if not (0 < v <= 90):
                    raise ValueError(name + " must be greater than 0 and at most 90.")
                setattr(self, name, round(v, 4))
        size = float(self.position_size_percent)
        if not (1 <= size <= 100):
            raise ValueError("position_size_percent must be between 1 and 100.")
        self.position_size_percent = round(size, 4)
        return self

    def describe(self) -> List[str]:
        out: List[str] = []
        if self.stop_loss_percent:
            out.append("Stop loss: %g%%" % self.stop_loss_percent)
        if self.take_profit_percent:
            out.append("Take profit: %g%%" % self.take_profit_percent)
        out.append("Position size: %g%% of equity" % self.position_size_percent)
        if not self.stop_loss_percent and not self.take_profit_percent:
            out.append("No stop loss or take profit - positions close on the exit rules only")
        return out


# ---------------------------------------------------------------------------
# Strategy
# ---------------------------------------------------------------------------

class StrategyDefinition(BaseModel):
    """The complete, validated strategy the backtest engine executes."""

    strategy_name: str = "Untitled Strategy"
    # Long-only in this version: the simulator has no short borrow model.
    direction: Literal["long"] = "long"
    entry: ConditionGroup
    exit: ConditionGroup = Field(default_factory=ConditionGroup)
    risk: RiskSettings = Field(default_factory=RiskSettings)

    @field_validator("strategy_name", mode="before")
    @classmethod
    def _name(cls, v: Any) -> Any:
        text = str(v or "").strip()[:120]
        return text or "Untitled Strategy"

    @field_validator("direction", mode="before")
    @classmethod
    def _direction(cls, v: Any) -> Any:
        if v is None:
            return "long"
        text = str(v).strip().lower()
        if text in ("long", "buy"):
            return "long"
        raise ValueError("Only long (buy) strategies are supported in this version.")

    @model_validator(mode="after")
    def _check(self) -> "StrategyDefinition":
        if not self.entry.conditions:
            raise ValueError("The strategy has no entry condition, so it would never open a trade.")
        if not self.exit.conditions and not self.risk.stop_loss_percent and not self.risk.take_profit_percent:
            raise ValueError(
                "The strategy has no exit rule, stop loss or take profit, so a position would never be closed."
            )
        return self

    def indicator_operands(self) -> List[IndicatorOperand]:
        out: List[IndicatorOperand] = []
        for group in (self.entry, self.exit):
            for cond in group.conditions:
                for side in (cond.left, cond.right):
                    if isinstance(side, IndicatorOperand):
                        out.append(side)
        return out

    def warmup_bars(self) -> int:
        """Candles the indicators need before a signal can be trusted."""
        need = 1
        for op in self.indicator_operands():
            span = op.period or 20
            if op.indicator == "MACD":
                span = (op.slow_period or 26) + (op.signal_period or 9)
            need = max(need, span * 3)
        return min(need, 400)

    def summary(self) -> Dict[str, Any]:
        """The 'what ORBIT understood' panel, in plain English."""
        return {
            "strategy_name": self.strategy_name,
            "direction": self.direction,
            "entry": {"logic": self.entry.logic, "conditions": self.entry.describe()},
            "exit": {"logic": self.exit.logic, "conditions": self.exit.describe()},
            "risk": self.risk.describe(),
        }


def validate_strategy_payload(payload: Any) -> StrategyDefinition:
    """Validate an untrusted dict (LLM output or a user edit) into a strategy.

    Raises StrategyValidationError carrying human-readable issues, so no raw
    pydantic error ever reaches an API response.
    """
    if not isinstance(payload, dict):
        raise StrategyValidationError("The strategy definition must be a JSON object.")
    try:
        return StrategyDefinition(**payload)
    except ValidationError as exc:
        issues: List[str] = []
        for err in exc.errors():
            loc = ".".join(str(p) for p in err.get("loc", ()) if not str(p).startswith("function-"))
            msg = str(err.get("msg", "invalid value"))
            msg = msg.split("Value error, ", 1)[-1]
            issues.append((loc + ": " + msg) if loc else msg)
        # De-duplicate: a Union operand reports the same problem once per member.
        seen, unique = set(), []
        for issue in issues:
            if issue not in seen:
                seen.add(issue)
                unique.append(issue)
        raise StrategyValidationError("This strategy is not supported as written.", unique) from exc
    except ValueError as exc:
        raise StrategyValidationError(str(exc)) from exc


SUPPORTED_VOCABULARY: Dict[str, Any] = {
    "indicators": [
        {
            "name": name,
            "label": spec["label"],
            "fields": spec["fields"],
            "default_period": spec["default_period"],
            "period_range": list(spec["period_range"]),
        }
        for name, spec in INDICATOR_SPECS.items()
    ],
    "price_fields": list(PRICE_FIELDS),
    "operators": list(COMPARISON_OPERATORS),
    "logic": list(LOGIC_OPERATORS),
    "timeframes": list(TIMEFRAMES),
    "markets": list(MARKETS),
    "risk": ["stop_loss_percent", "take_profit_percent", "position_size_percent"],
    "direction": ["long"],
    "limits": {
        "max_conditions_per_group": MAX_CONDITIONS_PER_GROUP,
        "max_position_size_percent": 100,
        "leverage": "not supported - backtests are unleveraged",
        "shorting": "not supported in this version",
    },
}
