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

from urllib.parse import parse_qsl, urlsplit  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

GATEWAY_TOKEN = _ISOLATED_ENV["ORBIT_INTERNAL_TOKEN"]


class GatewayClient(TestClient):
    """
    Stands in for the Go gateway: every /api and /ws call carries the shared
    internal token and X-User-ID for the account the gateway would have
    verified (taken from the request's own user_id). /internal/* calls are
    left untouched so their own token checks stay under test.
    """

    def _as_gateway(self, url, kwargs):
        path = urlsplit(str(url)).path
        if path.startswith("/internal/"):
            return kwargs
        uid = None
        body = kwargs.get("json")
        if isinstance(body, dict) and body.get("user_id") is not None:
            uid = body["user_id"]
        params = kwargs.get("params")
        if uid is None and isinstance(params, dict) and params.get("user_id") is not None:
            uid = params["user_id"]
        if uid is None:
            uid = dict(parse_qsl(urlsplit(str(url)).query)).get("user_id")
        headers = dict(kwargs.get("headers") or {})
        headers.setdefault("X-Orbit-Internal-Token", GATEWAY_TOKEN)
        if uid is not None:
            headers.setdefault("X-User-ID", str(uid))
        kwargs["headers"] = headers
        return kwargs

    def request(self, method, url, **kwargs):
        return super().request(method, url, **self._as_gateway(url, kwargs))

    def websocket_connect(self, url, subprotocols=None, **kwargs):
        return super().websocket_connect(url, subprotocols=subprotocols, **self._as_gateway(url, kwargs))
