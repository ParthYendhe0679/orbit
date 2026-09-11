"""
llm.py — single shared entry point for every LLM call in the project.

Why this exists:
  * The agents each built their own genai.Client on every call and each
    hard-coded the model name. When `gemini-2.0-flash` was retired, all three
    AI agents silently fell back to canned text with no visible failure.
  * Model names now live in ONE place and are overridable with env vars, so a
    future retirement is a one-line change.
  * There are now TWO independent providers — Gemini and Groq. A prompt is
    tried against every model of the first provider, then every model of the
    second. A dead key, an exhausted free-tier quota, or a retired model on
    one provider no longer knocks the agents back to deterministic fallbacks,
    because the other provider picks the call up.

Provider order is set by LLM_PROVIDER_ORDER (default "gemini,groq").
Each provider accepts several keys (GEMINI_API_KEY, GEMINI_API_KEY_2, ... _9 or
GEMINI_API_KEYS="a,b"; same shape for GROQ_*), and calls round-robin across
them so two free keys give roughly double the per-minute quota.

A key that hits its rate limit or quota is benched until the provider says it
may retry, so later calls go straight to the next key; it rejoins the rotation
on its own once the limit window has passed (see "key cooldowns" below).
"""

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request

from dotenv import load_dotenv

load_dotenv()

# Preferred model per provider, overridable via .env. The fallbacks are tried
# in order if the preferred one is retired or unavailable for a given key.
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash").strip()
GEMINI_FALLBACK_MODELS = ["gemini-flash-latest", "gemini-2.5-flash"]

GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b").strip()
GROQ_FALLBACK_MODELS = ["openai/gpt-oss-20b", "groq/compound-mini"]
GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"

PROVIDER_ORDER = [
    p.strip().lower()
    for p in os.environ.get("LLM_PROVIDER_ORDER", "gemini,groq").split(",")
    if p.strip()
]

_gemini_clients = {}        # api key -> genai.Client
_lock = threading.Lock()
_working_model = {}         # provider -> model that last succeeded
_next_key = {}              # provider -> round-robin cursor
_cooldown_until = {}        # (provider, key) -> epoch seconds the key is benched until


# ---------------------------------------------------------------- key pools

def _keys_for(prefix: str) -> list:
    """
    Every key configured for one provider, in priority order, de-duplicated.

    Accepted forms (all optional, all combined), shown for GEMINI:
      GEMINI_API_KEY   = key one
      GEMINI_API_KEY_2 = key two          (also _3 ... _9)
      GEMINI_API_KEYS  = key one,key two  (comma separated)
    """
    raw = [os.environ.get(prefix + "_API_KEY", "")]
    raw += [os.environ.get(prefix + "_API_KEY_" + str(n), "") for n in range(2, 10)]
    raw += os.environ.get(prefix + "_API_KEYS", "").split(",")

    keys, seen = [], set()
    for key in raw:
        key = key.strip()
        if key and key not in seen:
            seen.add(key)
            keys.append(key)
    return keys


def gemini_keys() -> list:
    return _keys_for("GEMINI")


def groq_keys() -> list:
    return _keys_for("GROQ")


def api_keys() -> list:
    """Every key across every provider — used only for the enabled check."""
    return gemini_keys() + groq_keys()


def api_key() -> str:
    """First Gemini key. Kept for callers that only need to know one."""
    keys = gemini_keys()
    return keys[0] if keys else ""


def is_enabled() -> bool:
    return bool(api_keys())


def active_providers() -> list:
    """Providers in call order that actually have at least one key."""
    have = {"gemini": gemini_keys, "groq": groq_keys}
    return [p for p in PROVIDER_ORDER if p in have and have[p]()]


def _ordered_keys(provider: str, keys: list) -> list:
    """Rotate the pool so consecutive calls start on a different key."""
    if not keys:
        return []
    with _lock:
        start = _next_key.get(provider, 0) % len(keys)
        _next_key[provider] = (start + 1) % len(keys)
    return keys[start:] + keys[:start]


def _candidate_models(provider: str, preferred: str, fallbacks: list):
    """Last-known-good model first, then the preferred one, then fallbacks."""
    good = _working_model.get(provider)
    if good:
        yield good
    seen = {good}
    for m in [preferred] + fallbacks:
        if m and m not in seen:
            seen.add(m)
            yield m


# ------------------------------------------------------------ key cooldowns
#
# Without this, a key that had hit its limit was still tried first on every
# call that the round-robin handed it, wasting a request (and the provider's
# latency) before moving on. Now the key is benched for as long as the provider
# asks — Groq's "try again in 1m30s" / retry-after, Gemini's retryDelay — and
# skipped until then. Daily quotas and rejected keys are re-probed hourly rather
# than dropped for good, so every key comes back by itself once it can serve.

RATE_LIMIT_DEFAULT_SECONDS = 60.0   # 429 without a stated delay (per-minute windows)
LONG_COOLDOWN_SECONDS = 3600.0      # daily quota exhausted, or key rejected

_RATE_LIMIT_MARKERS = ("429", "resource_exhausted", "rate limit", "rate_limit", "quota", "too many requests")
_DAILY_MARKERS = ("per day", "perday", "daily")
_AUTH_MARKERS = ("401", "403", "api_key_invalid", "invalid api key", "invalid_api_key",
                 "permission_denied", "unauthenticated")
_RETRY_AFTER = re.compile(r"retry-after=(\d+(?:\.\d+)?)", re.I)
_RETRY_IN = re.compile(r"(?:try again|retry) in (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s", re.I)
_RETRY_DELAY = re.compile(r"retryDelay['\"]?\s*[:=]\s*['\"]?(\d+(?:\.\d+)?)s", re.I)


def _retry_delay(text: str):
    """The wait the provider asked for, in seconds, or None if it did not say."""
    m = _RETRY_AFTER.search(text)
    if m:
        return float(m.group(1))
    m = _RETRY_IN.search(text)
    if m:
        return float(m.group(1) or 0) * 3600 + float(m.group(2) or 0) * 60 + float(m.group(3))
    m = _RETRY_DELAY.search(text)
    if m:
        return float(m.group(1))
    return None


def _cooldown_for(error) -> float:
    """Seconds to bench a key after `error`; 0 when the failure is not the key's limit."""
    text = str(error).lower()
    if any(marker in text for marker in _AUTH_MARKERS):
        return LONG_COOLDOWN_SECONDS
    if not any(marker in text for marker in _RATE_LIMIT_MARKERS):
        return 0.0  # network / server errors: try the next key now, but keep this one
    delay = _retry_delay(str(error))
    if any(marker in text for marker in _DAILY_MARKERS):
        return max(delay or 0.0, LONG_COOLDOWN_SECONDS)
    return min(max(delay if delay is not None else RATE_LIMIT_DEFAULT_SECONDS, 5.0), LONG_COOLDOWN_SECONDS)


def _bench(provider: str, key: str, seconds: float) -> None:
    with _lock:
        _cooldown_until[(provider, key)] = time.time() + seconds


def _available_keys(provider: str, keys: list) -> list:
    """Keys that are not currently benched, in configured order."""
    now = time.time()
    with _lock:
        return [k for k in keys if _cooldown_until.get((provider, k), 0.0) <= now]


def _key_label(provider: str, key: str) -> str:
    """Human-readable, non-secret name for a key: its slot number."""
    keys = _PROVIDERS[provider][0]()
    slot = keys.index(key) + 1 if key in keys else "?"
    return f"{provider.title()} key #{slot}"


def key_pool_status() -> dict:
    """Per-provider key health for diagnostics (keys masked to their last 4 characters)."""
    now = time.time()
    status = {}
    for provider, (get_keys, _model, _fallbacks, _call) in _PROVIDERS.items():
        with _lock:
            status[provider] = [
                {"slot": i + 1, "key": "..." + k[-4:],
                 "cooling_for_s": max(0, round(_cooldown_until.get((provider, k), 0.0) - now))}
                for i, k in enumerate(get_keys())
            ]
    return status


# ------------------------------------------------------------- gemini calls

def get_client(key: str = ""):
    """Lazily build one shared Gemini client per key (one per call is wasteful)."""
    key = key or api_key()
    if key not in _gemini_clients:
        with _lock:
            if key not in _gemini_clients:
                from google import genai as google_genai
                _gemini_clients[key] = google_genai.Client(api_key=key)
    return _gemini_clients[key]


def _call_gemini(key: str, model: str, prompt: str) -> str:
    response = get_client(key).models.generate_content(model=model, contents=prompt)
    return (response.text or "").strip()


# --------------------------------------------------------------- groq calls

def _call_groq(key: str, model: str, prompt: str) -> str:
    """
    Groq's OpenAI-compatible chat endpoint, called over stdlib urllib so the
    project picks up no new dependency.
    """
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")

    request = urllib.request.Request(
        GROQ_ENDPOINT,
        data=body,
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            # Groq sits behind Cloudflare, which rejects the default
            # "Python-urllib/x.y" agent with a 403 (error code 1010).
            "User-Agent": "trading-sim-agents/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Surface the API's own message; the bare status alone is useless when
        # deciding whether this was a quota, an auth, or a bad-model failure.
        # Retry-After (sent with 429s) decides how long the key is benched.
        detail = exc.read().decode("utf-8", "replace")[:200]
        retry_after = exc.headers.get("retry-after") if exc.headers else None
        suffix = (" retry-after=" + retry_after) if retry_after else ""
        raise RuntimeError(str(exc.code) + " " + detail + suffix) from exc

    return (payload["choices"][0]["message"]["content"] or "").strip()


# ------------------------------------------------------------- public entry

_PROVIDERS = {
    "gemini": (gemini_keys, GEMINI_MODEL, GEMINI_FALLBACK_MODELS, _call_gemini),
    "groq":   (groq_keys,   GROQ_MODEL,   GROQ_FALLBACK_MODELS,   _call_groq),
}

# Errors that mean "this model is wrong" — worth retrying another model on the
# same key. Everything else (quota, auth, network) fails identically on every
# model, so it should jump straight to the next key or provider.
_MODEL_ERRORS = ("NOT_FOUND", "404", "model_not_found", "does not exist", "decommissioned")


def generate_text(prompt: str, log_func=None, agent_name: str = "LLM") -> str:
    """
    Run a prompt through the provider chain and return the plain-text answer.

    Every available key of every configured provider is tried, and for each key
    every candidate model, before giving up. Keys benched for a rate limit are
    skipped until their cooldown ends. Returns "" only when the whole chain
    fails (no keys, network down, every key/model rejected or cooling down) so
    that callers can fall back to their deterministic logic. Failures are
    reported through log_func so they stay visible in the terminal.
    """
    providers = active_providers()
    if not providers:
        return ""

    last_error = None
    for provider in providers:
        get_keys, preferred, fallbacks, call = _PROVIDERS[provider]
        all_keys = get_keys()
        keys = _available_keys(provider, all_keys)
        if not keys:
            last_error = f"all {len(all_keys)} {provider.title()} key(s) are cooling down after hitting their limits"
        for key in _ordered_keys(provider, keys):
            for model in _candidate_models(provider, preferred, fallbacks):
                try:
                    text = call(key, model, prompt)
                    if text:
                        _working_model[provider] = model
                        return text
                    last_error = "empty response"
                except Exception as exc:      # noqa: BLE001 - report and try next
                    last_error = exc
                    if any(t in str(exc) for t in _MODEL_ERRORS):
                        continue  # wrong model for this key: try the next model
                    wait = _cooldown_for(exc)
                    if wait:
                        _bench(provider, key, wait)
                        if log_func:
                            log_func(agent_name, _key_label(provider, key) + " hit its limit ("
                                     + str(exc)[:80] + "). Switching to the next key; it rejoins in "
                                     + str(round(wait)) + "s.")
                    break
        if log_func and provider != providers[-1]:
            nxt = providers[providers.index(provider) + 1]
            log_func(agent_name, provider.title() + " unavailable (" + str(last_error)[:120] + "). Falling back to " + nxt.title() + ".")

    if log_func:
        log_func(agent_name, "All LLM providers failed (" + str(last_error)[:160] + "). Using deterministic fallback.")
    return ""
