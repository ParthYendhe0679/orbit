"""
gateway_auth.py — trusted-gateway identity for the ai-service.

The Go gateway (backend/) authenticates every browser request (Clerk JWT or
gateway session), then forwards it here with:

    X-Orbit-Internal-Token  the shared ORBIT_INTERNAL_TOKEN
    X-User-ID               the verified ORBIT account id
    X-User-Clerk-ID         the verified Clerk user id (/api/auth/sync)

This ASGI middleware only honours those headers on requests that provably
come from the gateway. With ORBIT_INTERNAL_TOKEN set the token must match;
without one only loopback callers qualify. Requests carrying a browser Origin
never qualify (the gateway strips Origin before forwarding), so a page cannot
call the ai-service directly and claim an identity.

Every private /api route (anything not in PUBLIC_PATHS, mirroring the
gateway's middleware.APIAccess) and the /ws socket require a gateway identity.
The request is then bound to that account: a user_id in the query string or
JSON body naming another account is refused with 403, and user_id is set to
the verified account before the endpoint runs — so no endpoint can be reached
with a client-chosen user_id.
"""

import hmac
import json
import os
from typing import Optional, Tuple
from urllib.parse import parse_qsl, urlencode

PUBLIC_PATHS = frozenset({
    "/health", "/api/health", "/api/auth/config", "/api/login", "/api/register",
    "/api/news", "/api/news/global",
})
PUBLIC_PREFIXES = ("/api/market/",)
CLERK_PATHS = frozenset({"/api/auth/sync"})

MAX_SCOPED_BODY = 1 << 20
LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")


def internal_token() -> str:
    return os.getenv("ORBIT_INTERNAL_TOKEN", "").strip()


def _headers(scope) -> dict:
    return {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}


def is_loopback_host(host: Optional[str]) -> bool:
    if not host:
        return False
    h = host.strip()
    if h.startswith("[") and "]" in h:
        h = h[1:h.index("]")]
    elif ":" in h and not h.startswith("::") and h.count(":") == 1:
        h = h.split(":")[0]
    return h in LOOPBACK_HOSTS or h.startswith("127.")


def is_trusted_gateway(headers: dict, client_host: Optional[str]) -> bool:
    """True when the request comes from the Go gateway (or another internal caller)."""
    if headers.get("origin"):
        return False
    token = internal_token()
    if token:
        return hmac.compare_digest(headers.get("x-orbit-internal-token", ""), token)
    return is_loopback_host(client_host)


def classify(path: str) -> str:
    """'public', 'clerk', 'user' or 'passthrough' (static files, /internal/*)."""
    if path in PUBLIC_PATHS or path == "/api/market" or path.startswith(PUBLIC_PREFIXES):
        return "public"
    if path in CLERK_PATHS:
        return "clerk"
    if path == "/ws" or path == "/api" or path.startswith("/api/"):
        return "user"
    return "passthrough"


def _normalize_user_id(value) -> Tuple[Optional[str], bool]:
    """(canonical id, valid). None values are absent, not invalid."""
    if value is None:
        return None, True
    if isinstance(value, bool):
        return None, False
    if isinstance(value, int):
        return str(value), True
    if isinstance(value, float):
        return (str(int(value)), True) if value.is_integer() else (None, False)
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return str(int(value.strip())), True
    return None, False


def _state(scope) -> dict:
    state = scope.get("state")
    if state is None:
        state = {}
        scope["state"] = state
    return state


class GatewayIdentityMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)

        path = scope.get("path", "")
        kind = classify(path)
        if kind in ("public", "passthrough"):
            return await self.app(scope, receive, send)

        headers = _headers(scope)
        client = scope.get("client")
        if not is_trusted_gateway(headers, client[0] if client else None):
            return await self._reject(scope, send, 401, "Requests must come through the ORBIT gateway.")

        if kind == "clerk":
            clerk_id = headers.get("x-user-clerk-id", "").strip()
            if not clerk_id:
                return await self._reject(scope, send, 401, "A verified Clerk session is required.")
            _state(scope)["gateway_clerk_id"] = clerk_id
            return await self.app(scope, receive, send)

        uid, valid = _normalize_user_id(headers.get("x-user-id"))
        if not uid or not valid or int(uid) <= 0:
            return await self._reject(scope, send, 401, "Authentication required.")

        scope = dict(scope)
        pairs = parse_qsl(scope.get("query_string", b"").decode("latin-1"), keep_blank_values=True)
        for key, value in pairs:
            if key == "user_id" and _normalize_user_id(value) != (uid, True):
                return await self._reject(scope, send, 403, "user_id does not match the signed-in account.")
        pairs = [(k, v) for k, v in pairs if k != "user_id"] + [("user_id", uid)]
        scope["query_string"] = urlencode(pairs).encode("latin-1")

        state = _state(scope)
        state["gateway_user_id"] = int(uid)
        if headers.get("x-user-clerk-id"):
            state["gateway_clerk_id"] = headers["x-user-clerk-id"].strip()

        if scope["type"] == "http" and "json" in headers.get("content-type", "").lower():
            body, too_large = await self._read_body(receive)
            if too_large:
                return await self._reject(scope, send, 413, "Request body too large.")
            if body:
                try:
                    payload = json.loads(body)
                except (ValueError, UnicodeDecodeError):
                    payload = None
                if isinstance(payload, dict):
                    claimed, ok = _normalize_user_id(payload.get("user_id"))
                    if not ok or (claimed is not None and claimed != uid):
                        return await self._reject(scope, send, 403, "user_id does not match the signed-in account.")
                    payload["user_id"] = int(uid)
                    body = json.dumps(payload).encode("utf-8")
            scope["headers"] = [(k, v) for k, v in scope["headers"] if k.lower() != b"content-length"]
            scope["headers"].append((b"content-length", str(len(body)).encode("latin-1")))
            receive = self._replay(body, receive)

        return await self.app(scope, receive, send)

    @staticmethod
    async def _read_body(receive):
        chunks, size = [], 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                break
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > MAX_SCOPED_BODY:
                return b"", True
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        return b"".join(chunks), False

    @staticmethod
    def _replay(body: bytes, receive):
        sent = False

        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        return replay

    @staticmethod
    async def _reject(scope, send, status: int, detail: str):
        if scope["type"] == "websocket":
            # Refusing before accept fails the handshake (HTTP 403 to the client).
            await send({"type": "websocket.close", "code": 1008, "reason": detail})
            return
        body = json.dumps({"detail": detail}).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        })
        await send({"type": "http.response.body", "body": body})


def gateway_user_id(conn) -> Optional[int]:
    """The verified account id for a Request/WebSocket, set by the middleware."""
    return getattr(conn.state, "gateway_user_id", None)


def gateway_clerk_id(conn) -> Optional[str]:
    return getattr(conn.state, "gateway_clerk_id", None)
