"""
Test isolation for the Auto-Trade Bot suite.

Everything that would reach a cloud service is pointed at a dead local port
BEFORE the application modules are imported: the Neon DATABASE_URL (tests use
a throwaway SQLite file), Aiven Valkey (the in-memory fallback is used), the
LLM providers and the news/market APIs. Market prices are supplied per test.
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AI_SERVICE = ROOT / "ai-service"

_ISOLATED_ENV = {
    "DATABASE_URL": "",
    "VALKEY_URL": "redis://127.0.0.1:1/0",
    "REDIS_URL": "redis://127.0.0.1:1/0",
    "GEMINI_API_KEY": "",
    "GEMINI_API_KEY_2": "",
    "GROQ_API_KEY": "",
    "GROQ_API_KEY_2": "",
    "NEWS_API_KEY": "",
    "ALPHA_VANTAGE_API_KEY": "",
    "STREAM_HUB_URL": "http://127.0.0.1:1/publish",
    "GATEWAY_INTERNAL_URL": "http://127.0.0.1:1",
    "ORBIT_INTERNAL_TOKEN": "test-internal-token",
}
# Every numbered LLM key slot, so .env keys never leak into a test run.
for _prefix in ("GEMINI", "GROQ"):
    _ISOLATED_ENV[f"{_prefix}_API_KEYS"] = ""
    for _n in range(2, 10):
        _ISOLATED_ENV[f"{_prefix}_API_KEY_{_n}"] = ""
os.environ.update(_ISOLATED_ENV)

for p in (str(AI_SERVICE), str(ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)
