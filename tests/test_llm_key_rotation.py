"""
LLM key rotation: a key that hits its limit is benched until the provider's
retry window passes and the next key serves the call; it rejoins by itself.
"""

from types import SimpleNamespace

import pytest

import llm


class FakeProvider:
    """Stands in for _call_groq / _call_gemini: per-key scripted outcomes."""

    def __init__(self, outcomes):
        self.outcomes = outcomes  # key -> Exception to raise, or text to return
        self.calls = []

    def __call__(self, key, model, prompt):
        self.calls.append((key, model))
        outcome = self.outcomes.get(key, "ok-" + key)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


@pytest.fixture
def pools(monkeypatch):
    now = [1_000_000.0]
    monkeypatch.setattr(llm, "time", SimpleNamespace(time=lambda: now[0]))
    monkeypatch.setattr(llm, "_cooldown_until", {})
    monkeypatch.setattr(llm, "_next_key", {})
    monkeypatch.setattr(llm, "_working_model", {})
    monkeypatch.setattr(llm, "PROVIDER_ORDER", ["groq", "gemini"])
    for prefix, keys in (("GROQ", ["g1", "g2", "g3"]), ("GEMINI", ["m1", "m2"])):
        monkeypatch.setenv(f"{prefix}_API_KEYS", "")
        for n in range(1, 10):
            name = f"{prefix}_API_KEY" if n == 1 else f"{prefix}_API_KEY_{n}"
            monkeypatch.setenv(name, keys[n - 1] if n <= len(keys) else "")
    groq, gemini = FakeProvider({}), FakeProvider({})
    monkeypatch.setitem(llm._PROVIDERS, "groq", (llm.groq_keys, "groq-model", [], groq))
    monkeypatch.setitem(llm._PROVIDERS, "gemini", (llm.gemini_keys, "gemini-model", [], gemini))
    return SimpleNamespace(now=now, groq=groq, gemini=gemini)


def test_all_numbered_keys_are_loaded(pools):
    assert llm.groq_keys() == ["g1", "g2", "g3"]
    assert llm.gemini_keys() == ["m1", "m2"]


def test_rate_limited_key_is_skipped_until_its_window_passes(pools):
    pools.groq.outcomes["g1"] = RuntimeError("429 Rate limit reached for model. Please try again in 7.5s.")
    assert llm.generate_text("hi") == "ok-g2"  # g1 failed, g2 served the same call

    for _ in range(6):
        assert llm.generate_text("hi") in ("ok-g2", "ok-g3")
    assert [k for k, _ in pools.groq.calls].count("g1") == 1  # never retried while benched

    pools.now[0] += 8  # past the provider's retry-after
    pools.groq.outcomes.pop("g1")
    served = {llm.generate_text("hi") for _ in range(3)}
    assert "ok-g1" in served  # rejoined the rotation on its own


def test_when_a_provider_is_exhausted_the_next_provider_serves(pools):
    for key in ("g1", "g2", "g3"):
        pools.groq.outcomes[key] = RuntimeError("429 Too Many Requests retry-after=30")
    logs = []
    assert llm.generate_text("hi", log_func=lambda a, m: logs.append(m)) == "ok-m1"
    assert any("Groq key #1 hit its limit" in m for m in logs)

    calls_before = len(pools.groq.calls)
    assert llm.generate_text("hi").startswith("ok-m")
    assert len(pools.groq.calls) == calls_before  # benched Groq keys are not even tried


def test_every_key_cooling_down_returns_the_deterministic_fallback(pools):
    for key in ("g1", "g2", "g3"):
        pools.groq.outcomes[key] = RuntimeError("429 rate_limit_exceeded, try again in 1m0s")
    for key in ("m1", "m2"):
        pools.gemini.outcomes[key] = RuntimeError("429 RESOURCE_EXHAUSTED {'retryDelay': '40s'}")
    assert llm.generate_text("hi") == ""
    total = len(pools.groq.calls) + len(pools.gemini.calls)
    assert llm.generate_text("hi") == ""
    assert len(pools.groq.calls) + len(pools.gemini.calls) == total  # nothing called while all cool down

    pools.now[0] += 45  # Gemini's window has passed, Groq's (60s) has not
    for key in ("m1", "m2"):
        pools.gemini.outcomes.pop(key)
    assert llm.generate_text("hi").startswith("ok-m")


def test_network_errors_do_not_bench_a_key(pools):
    pools.groq.outcomes["g1"] = RuntimeError("<urlopen error timed out>")
    assert llm.generate_text("hi") == "ok-g2"
    assert llm._available_keys("groq", llm.groq_keys()) == ["g1", "g2", "g3"]


def test_a_retired_model_still_falls_back_to_the_next_model_on_the_same_key(pools, monkeypatch):
    fake = FakeProvider({})

    def call(key, model, prompt):
        if model == "gone-model":
            raise RuntimeError("404 model_not_found")
        return fake(key, model, prompt)

    monkeypatch.setitem(llm._PROVIDERS, "groq", (llm.groq_keys, "gone-model", ["live-model"], call))
    assert llm.generate_text("hi") == "ok-g1"
    assert llm._available_keys("groq", llm.groq_keys()) == ["g1", "g2", "g3"]


@pytest.mark.parametrize("message,expected", [
    ("429 Rate limit reached. Please try again in 1m30.5s.", 90.5),
    ("429 {'error': 'RESOURCE_EXHAUSTED', 'retryDelay': '30s'}", 30.0),
    ("429 Too Many Requests retry-after=12", 12.0),
    ("429 Too Many Requests", llm.RATE_LIMIT_DEFAULT_SECONDS),
    ("429 Limit on tokens per day (TPD) reached. Please try again in 5m0s.", llm.LONG_COOLDOWN_SECONDS),
    ("401 invalid_api_key", llm.LONG_COOLDOWN_SECONDS),
    ("400 API key not valid. API_KEY_INVALID", llm.LONG_COOLDOWN_SECONDS),
    ("<urlopen error timed out>", 0.0),
    ("500 internal server error", 0.0),
])
def test_cooldown_follows_the_providers_retry_window(message, expected):
    assert llm._cooldown_for(RuntimeError(message)) == pytest.approx(expected)


def test_pool_status_masks_keys(pools):
    pools.groq.outcomes["g2"] = RuntimeError("429 retry-after=20")
    pools.groq.outcomes["g1"] = RuntimeError("429 retry-after=20")
    llm.generate_text("hi")
    status = llm.key_pool_status()
    assert [s["slot"] for s in status["groq"]] == [1, 2, 3]
    assert all(s["key"].startswith("...") for s in status["groq"])
    assert status["groq"][0]["cooling_for_s"] == 20 and status["groq"][2]["cooling_for_s"] == 0
