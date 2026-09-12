"""
strategy_lab/interpreter.py - natural language to a validated strategy.

SAFETY MODEL
------------
The LLM never produces anything that is executed. It produces ONE JSON object
which is parsed, schema-validated and then either accepted as data or thrown
away. There is no code generation, no Pine Script, no eval, no exec, no
dynamic import, and nothing from the model reaches a shell or an interpreter.
The pipeline is:

    natural language -> LLM -> JSON text -> json.loads -> pydantic schema
                            -> strategy validator -> safe strategy object

Anything that fails at any step becomes a controlled error or a clarifying
question. A failure never crashes the ai-service and never invents rules the
user did not ask for: if the description is ambiguous, ORBIT asks instead of
guessing.
"""

import json
import logging
import re
from typing import Any, Dict, List, Optional

import llm

from .schema import (
    COMPARISON_OPERATORS,
    INDICATOR_SPECS,
    PRICE_FIELDS,
    StrategyDefinition,
    StrategyValidationError,
    validate_strategy_payload,
)

logger = logging.getLogger("orbit.strategy_lab.interpreter")

MAX_DESCRIPTION_CHARS = 2000


class InterpretationResult:
    """Either a validated strategy, or questions ORBIT needs answered."""

    def __init__(
        self,
        status: str,
        strategy: Optional[StrategyDefinition] = None,
        questions: Optional[List[str]] = None,
        suggestions: Optional[List[str]] = None,
        unsupported: Optional[List[str]] = None,
        message: str = "",
        issues: Optional[List[str]] = None,
    ):
        self.status = status  # "ok" | "needs_clarification" | "unsupported" | "error"
        self.strategy = strategy
        self.questions = questions or []
        self.suggestions = suggestions or []
        self.unsupported = unsupported or []
        self.message = message
        self.issues = issues or []

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "status": self.status,
            "message": self.message,
            "questions": self.questions,
            "suggestions": self.suggestions,
            "unsupported": self.unsupported,
            "issues": self.issues,
        }
        if self.strategy is not None:
            payload["strategy"] = self.strategy.model_dump(mode="json")
            payload["understanding"] = self.strategy.summary()
        return payload


def _vocabulary_prompt_block() -> str:
    lines = []
    for name, spec in INDICATOR_SPECS.items():
        outputs = "/".join(spec["fields"])
        lines.append("  - " + name + " (" + spec["label"] + "), outputs: " + outputs
                     + ", period " + str(spec["period_range"][0]) + "-" + str(spec["period_range"][1]))
    return "\n".join(lines)


_SYSTEM_PROMPT = """You are ORBIT's strategy interpreter. You convert a trader's plain-English
description into ONE JSON object. You never write code and you never invent a rule the
trader did not state.

SUPPORTED INDICATORS (nothing else exists):
{indicators}

An operand is one of:
  {{"type":"indicator","indicator":"EMA","period":20,"source":"close","field":"value"}}
  {{"type":"price","field":"close"}}          (field: {price_fields})
  {{"type":"value","value":70}}
MACD operands use "field":"line"|"signal"|"histogram" plus "slow_period" and "signal_period".
Bollinger Bands use "indicator":"BBANDS", "field":"upper"|"middle"|"lower" and "std_dev".

Comparison operators: {operators}
Group logic: AND, OR. Direction: long only (buying); shorting is NOT supported.

Return EXACTLY ONE of these two JSON shapes, with no prose and no markdown fence.

(A) The description is complete and fully expressible:
{{
  "status": "ok",
  "strategy": {{
    "strategy_name": "<short name>",
    "direction": "long",
    "entry": {{"logic":"AND","conditions":[{{"left":<operand>,"operator":"<op>","right":<operand>}}]}},
    "exit":  {{"logic":"OR","conditions":[...]}},
    "risk":  {{"stop_loss_percent": <number or null>,
               "take_profit_percent": <number or null>,
               "position_size_percent": <1-100, default 100>}}
  }}
}}

(B) The description is vague, or it needs something ORBIT does not support:
{{
  "status": "needs_clarification",
  "message": "<one sentence saying what is missing>",
  "questions": ["<specific question>", "..."],
  "suggestions": ["<concrete option the trader could pick, e.g. 'RSI below 30'>"],
  "unsupported": ["<each requested thing ORBIT cannot express, or []>"]
}}

HARD RULES
- If the trader says something vague such as "when the market looks strong", "when it
  dips", "good momentum", DO NOT choose an indicator for them. Return shape (B) and ask
  how ORBIT should measure it, with concrete suggestions.
- If the trader asks for anything outside the supported list (sentiment, news, order
  book, volume profile, Ichimoku, moon phase, shorting, options, leverage), return shape
  (B) and name it in "unsupported".
- Never guess a numeric threshold that was not stated. A standard period for a named
  indicator (RSI 14, MACD 12/26/9) is fine; a missing entry LEVEL is not.
- Every entry rule must have an exit: an exit condition, a stop loss, or a take profit.
  If none was described, ask for one.
- Output raw JSON only.
"""


def _build_prompt(description: str, context: Dict[str, Any], repair_issues: Optional[List[str]] = None) -> str:
    system = _SYSTEM_PROMPT.format(
        indicators=_vocabulary_prompt_block(),
        price_fields=", ".join(PRICE_FIELDS),
        operators=", ".join(COMPARISON_OPERATORS),
    )
    parts = [system, "", "CONTEXT (for naming only; do not turn it into a rule):",
             "  symbol: " + str(context.get("symbol", "")),
             "  market: " + str(context.get("market", "")),
             "  timeframe: " + str(context.get("timeframe", "")),
             "", "TRADER'S DESCRIPTION:", description.strip()]
    if repair_issues:
        parts += [
            "",
            "Your previous answer was rejected by ORBIT's validator for these reasons:",
            "\n".join("  - " + issue for issue in repair_issues),
            "Return corrected JSON in the same shape. If the description genuinely cannot be "
            "expressed with the supported vocabulary, return shape (B) instead.",
        ]
    return "\n".join(parts)


_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def extract_json_object(text: str) -> Optional[Dict[str, Any]]:
    """The first JSON object in an LLM answer, or None.

    The text is only ever parsed as data. Nothing here evaluates it.
    """
    if not text:
        return None
    candidates: List[str] = []
    fence = _JSON_FENCE.search(text)
    if fence:
        candidates.append(fence.group(1))
    candidates.append(text)
    for candidate in candidates:
        candidate = candidate.strip()
        start = candidate.find("{")
        if start == -1:
            continue
        # Walk to the matching brace so trailing prose cannot break the parse.
        depth, in_string, escaped = 0, False, False
        for i in range(start, len(candidate)):
            ch = candidate[i]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        parsed = json.loads(candidate[start:i + 1])
                    except (ValueError, TypeError):
                        break
                    if isinstance(parsed, dict):
                        return parsed
                    break
    return None


def _clarification_from(payload: Dict[str, Any]) -> InterpretationResult:
    unsupported = [str(u) for u in (payload.get("unsupported") or []) if str(u).strip()]
    questions = [str(q) for q in (payload.get("questions") or []) if str(q).strip()]
    message = str(payload.get("message") or "").strip()
    if not message:
        message = (
            "This strategy uses something ORBIT cannot express yet."
            if unsupported
            else "I need more information before I can define this strategy."
        )
    if not questions and not unsupported:
        questions = ["Which indicator and level should trigger the entry?"]
    return InterpretationResult(
        status="unsupported" if unsupported and not questions else "needs_clarification",
        questions=questions,
        suggestions=[str(s) for s in (payload.get("suggestions") or []) if str(s).strip()],
        unsupported=unsupported,
        message=message,
    )


def interpret_strategy(description: str, context: Optional[Dict[str, Any]] = None) -> InterpretationResult:
    """Turn a description into a validated strategy, a question, or an error.

    Runs synchronously (the LLM call is blocking); callers use
    asyncio.to_thread so the event loop is never blocked.
    """
    text = (description or "").strip()
    if not text:
        return InterpretationResult(
            status="needs_clarification",
            message="Describe the strategy you want to test.",
            questions=["What should trigger a buy, and what should close the position?"],
            suggestions=["Buy when the 20 EMA crosses above the 50 EMA and RSI is below 70. "
                         "Exit on the reverse cross. Use a 3% stop loss."],
        )
    if len(text) > MAX_DESCRIPTION_CHARS:
        return InterpretationResult(
            status="error",
            message="That description is longer than " + str(MAX_DESCRIPTION_CHARS)
                    + " characters. Please shorten it to the entry, exit and risk rules.",
        )
    if not llm.is_enabled():
        return InterpretationResult(
            status="error",
            message="The strategy interpreter is unavailable: no AI provider is configured. "
                    "You can still build a strategy with the manual rule editor.",
        )

    ctx = context or {}
    issues: Optional[List[str]] = None
    last_message = ""

    # One interpretation attempt, plus one repair attempt seeded with the exact
    # validator complaints. Two attempts bound the latency of a single request.
    for attempt in range(2):
        prompt = _build_prompt(text, ctx, repair_issues=issues)
        try:
            raw = llm.generate_text(prompt, agent_name="Strategy Lab")
        except Exception as exc:  # provider chain already swallows most failures
            logger.warning("Strategy Lab LLM call failed: %s", exc)
            raw = ""
        if not raw:
            return InterpretationResult(
                status="error",
                message="The AI interpreter is temporarily unavailable (every provider refused or "
                        "timed out). Please try again in a moment.",
            )

        payload = extract_json_object(raw)
        if payload is None:
            issues = ["The answer was not valid JSON. Return a single raw JSON object."]
            last_message = "The interpreter returned an unreadable answer."
            continue

        status = str(payload.get("status", "")).strip().lower()
        if status in ("needs_clarification", "clarification", "unsupported", "ambiguous"):
            return _clarification_from(payload)

        candidate = payload.get("strategy") if isinstance(payload.get("strategy"), dict) else payload
        try:
            strategy = validate_strategy_payload(candidate)
        except StrategyValidationError as exc:
            issues = exc.issues or [exc.message]
            last_message = exc.message
            continue

        return InterpretationResult(
            status="ok",
            strategy=strategy,
            message="Strategy understood.",
        )

    return InterpretationResult(
        status="needs_clarification",
        message=last_message or "ORBIT could not express this strategy with its supported rules.",
        questions=[
            "Could you restate the strategy using a supported indicator "
            "(" + ", ".join(sorted(INDICATOR_SPECS)) + ") with explicit levels?"
        ],
        issues=issues or [],
    )
