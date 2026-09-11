"""
Stage 2 security: the ai-service trusts identity only from the Go gateway.

Covers GatewayIdentityMiddleware (gateway_auth.py) on REST and /ws, account
binding of user_id, conversation isolation, /api/auth/sync hardening, the
gateway's Clerk resolve endpoint, and the "no invented prices" rule.
"""

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import main
from conftest import GATEWAY_TOKEN, GatewayClient
from models.market import MarketQuote

db = main.db


@pytest.fixture
def env(tmp_path, monkeypatch):
    dbfile = str(tmp_path / "orbit_security.db")
    monkeypatch.setattr(db, "DB_PATH", dbfile)
    monkeypatch.setattr(db, "IS_POSTGRES", False)
    db.init_db()
    vs = main.valkey_service
    vs._memory_cache.clear()
    vs._memory_sets.clear()
    vs.is_connected = False
    vs._valkey_client = None

    async def quote(symbol, force_refresh=False):
        return MarketQuote(symbol=symbol.upper(), price=100.0, open=100.0, high=100.0, low=100.0, close=100.0,
                           previous_close=100.0, change=0.0, change_percent=0.0, timestamp="now", source="test")

    async def price(symbol, force_refresh=False):
        return 100.0

    monkeypatch.setattr(main.market_service, "get_quote", quote)
    monkeypatch.setattr(main.market_service, "get_price", price)
    monkeypatch.setattr(main, "_gateway_publish_down_until", float("inf"))
    return monkeypatch


def user(name):
    return db.register_user(name, f"{name}@example.com", "salt:hash")


def as_gateway(uid=None, **extra):
    h = {"X-Orbit-Internal-Token": GATEWAY_TOKEN}
    if uid is not None:
        h["X-User-ID"] = str(uid)
    h.update(extra)
    return h


# ---------------------------------------------------------------------------
# Trusted-gateway identity on REST
# ---------------------------------------------------------------------------

def test_private_routes_refuse_callers_that_are_not_the_gateway(env):
    uid = user("amy")
    raw = TestClient(main.app)
    for path in (f"/api/trades/open?user_id={uid}", f"/api/bot-config?user_id={uid}",
                 f"/api/dashboard/summary?user_id={uid}", "/api/brain/analyze?symbol=BTC-USD"):
        assert raw.get(path).status_code == 401, path                                   # no token
        assert raw.get(path, headers={"X-User-ID": str(uid)}).status_code == 401, path   # spoofed identity
        assert raw.get(path, headers={"X-Orbit-Internal-Token": "wrong", "X-User-ID": str(uid)}).status_code == 401
        assert raw.get(path, headers=as_gateway()).status_code == 401, path              # token, no identity
    # A browser Origin means the call did not come through the gateway.
    assert raw.get(f"/api/trades/open?user_id={uid}",
                   headers=as_gateway(uid, Origin="http://localhost:8000")).status_code == 401


def test_public_routes_stay_public(env):
    raw = TestClient(main.app)
    assert raw.get("/api/auth/config").status_code == 200
    assert raw.get("/api/health").status_code == 200


def test_user_id_is_bound_to_the_verified_account(env):
    a, b = user("ann"), user("ben")
    raw = TestClient(main.app)
    # Another account in the query string or JSON body is refused.
    assert raw.get(f"/api/trades/open?user_id={b}", headers=as_gateway(a)).status_code == 403
    assert raw.get(f"/api/trades/open?user_id={a}&user_id={b}", headers=as_gateway(a)).status_code == 403
    assert raw.post("/api/trade/open", json={"user_id": b, "symbol": "BTC-USD", "quantity": 1},
                    headers=as_gateway(a)).status_code == 403
    assert raw.post("/api/trade/open", json={"user_id": "x", "symbol": "BTC-USD", "quantity": 1},
                    headers=as_gateway(a)).status_code == 403
    # Omitted user_id is filled with the verified account, never defaulted to user 1.
    res = raw.post("/api/trade/open", json={"symbol": "BTC-USD", "quantity": 1}, headers=as_gateway(a))
    assert res.status_code == 200, res.text
    assert db.get_trade(res.json()["trade_id"])["user_id"] == a
    cfg = raw.get("/api/bot-config", headers=as_gateway(a)).json()["config"]
    assert cfg["user_id"] == a
    assert raw.get("/api/trades/open", headers=as_gateway(b)).json()["count"] == 0


def test_trade_is_refused_without_a_live_price(env):
    uid = user("cal")

    async def no_price(symbol, force_refresh=False):
        raise RuntimeError("feed down")

    env.setattr(main.market_service, "get_price", no_price)
    res = GatewayClient(main.app).post("/api/trade/open", json={"user_id": uid, "symbol": "BTC-USD", "quantity": 1})
    assert res.status_code == 503
    assert db.get_active_positions(uid) == []
    assert db.get_user_balance(uid) == 1_000_000.0


# ---------------------------------------------------------------------------
# WebSocket identity
# ---------------------------------------------------------------------------

def test_websocket_identity_comes_only_from_the_gateway(env, monkeypatch):
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def no_lifespan(app):
        yield

    monkeypatch.setattr(main.app.router, "lifespan_context", no_lifespan)
    a, b = user("dan"), user("eve")
    with TestClient(main.app) as raw:
        # Query-string identities are not accepted by themselves.
        for url in (f"/ws?user_id={a}", "/ws?username=dan", f"/ws?user_id={a}&username=dan"):
            with pytest.raises(WebSocketDisconnect):
                with raw.websocket_connect(url) as ws:
                    ws.receive_json()
        # User A cannot open user B's channel.
        with pytest.raises(WebSocketDisconnect):
            with raw.websocket_connect(f"/ws?user_id={b}", headers=as_gateway(a)) as ws:
                ws.receive_json()
        # The verified account gets its own wallet.
        with raw.websocket_connect("/ws", headers=as_gateway(a)) as ws:
            first = ws.receive_json()
            assert first == {"type": "wallet", "balance": 1_000_000.0}
    assert db.get_user_by_username("dan_1") is None  # no ghost account is provisioned


# ---------------------------------------------------------------------------
# Conversations are private
# ---------------------------------------------------------------------------

def test_conversations_are_isolated_per_account(env):
    a, b = user("fay"), user("gil")
    raw = TestClient(main.app)
    cid = raw.post("/api/chat/conversations", json={"title": "Mine", "user_id": a},
                   headers=as_gateway(a)).json()["data"]["id"]
    db.create_conversation(conversation_id="legacy-unowned", title="Old", user_id=None)

    listed_b = [c["id"] for c in raw.get("/api/chat/conversations", headers=as_gateway(b)).json()["data"]]
    listed_a = [c["id"] for c in raw.get("/api/chat/conversations", headers=as_gateway(a)).json()["data"]]
    assert cid in listed_a and cid not in listed_b and "legacy-unowned" not in listed_a + listed_b

    assert raw.get(f"/api/chat/conversations/{cid}", headers=as_gateway(b)).status_code == 404
    assert raw.delete(f"/api/chat/conversations/{cid}", headers=as_gateway(b)).status_code == 404
    assert raw.post(f"/api/copilot/reset?conversation_id={cid}", headers=as_gateway(b)).status_code == 404
    assert db.get_conversation(cid) is not None
    assert raw.get(f"/api/chat/conversations/{cid}", headers=as_gateway(a)).status_code == 200

    # Chatting into someone else's conversation is refused before any reasoning runs.
    with pytest.raises(PermissionError):
        main.copilot_service.get_or_create_session(cid, "BTC-USD", user_id=b)
    main.copilot_service.get_or_create_session(cid, "BTC-USD", user_id=a)
    with pytest.raises(PermissionError):  # the in-memory session is guarded too
        main.copilot_service.get_or_create_session(cid, "BTC-USD", user_id=b)
    assert raw.delete(f"/api/chat/conversations/{cid}", headers=as_gateway(a)).json()["deleted"] is True


# ---------------------------------------------------------------------------
# Clerk account provisioning
# ---------------------------------------------------------------------------

def test_auth_sync_trusts_only_the_gateway_verified_clerk_id(env):
    victim = user("hal")
    raw = TestClient(main.app)
    body = {"email": "hal@example.com", "username": "hal", "clerk_id": "user_attacker_choice"}

    assert raw.post("/api/auth/sync", json=body).status_code == 401
    assert raw.post("/api/auth/sync", json=body, headers=as_gateway()).status_code == 401

    # No Clerk-verified email -> the victim's account (same email/username) is not linked.
    env.setattr(main, "_clerk_verified_email", lambda clerk_id: None)
    res = raw.post("/api/auth/sync", json=body, headers=as_gateway(**{"X-User-Clerk-ID": "user_real"}))
    assert res.status_code == 200, res.text
    assert res.json()["user_id"] != victim
    assert db.get_user_by_id(victim).get("clerk_id") is None
    assert db.get_user_by_clerk_id("user_real")["id"] == res.json()["user_id"]
    assert db.get_user_by_clerk_id("user_attacker_choice") is None

    # A Clerk-verified email links the existing account.
    env.setattr(main, "_clerk_verified_email", lambda clerk_id: "hal@example.com")
    res = raw.post("/api/auth/sync", json=body, headers=as_gateway(**{"X-User-Clerk-ID": "user_hal"}))
    assert res.json()["user_id"] == victim


def test_internal_resolve_maps_clerk_users_for_the_gateway(env):
    uid = user("ivy")
    env.setattr(main, "_clerk_verified_email", lambda clerk_id: "ivy@example.com")
    raw = TestClient(main.app)
    raw.post("/api/auth/sync", json={"username": "ivy"}, headers=as_gateway(**{"X-User-Clerk-ID": "user_ivy"}))
    tok = {"X-Orbit-Internal-Token": GATEWAY_TOKEN}
    assert raw.get("/internal/auth/resolve?clerk_id=user_ivy", headers=tok).json() == {"user_id": uid, "username": "ivy"}
    assert raw.get("/internal/auth/resolve?clerk_id=user_nobody", headers=tok).status_code == 404
    assert raw.get("/internal/auth/resolve?clerk_id=user_ivy").status_code == 403


def test_removed_fake_endpoints_are_gone(env):
    raw = TestClient(main.app)
    # /api/verify-otp answered {"user_id": 1} for any unknown email.
    assert raw.post("/api/verify-otp", json={"email": "x@y.z", "otp": "1"}, headers=as_gateway(1)).status_code in (404, 405)
    assert raw.post("/api/resend-otp", json={"email": "x@y.z"}, headers=as_gateway(1)).status_code in (404, 405)


def test_no_invented_news(env, monkeypatch):
    from agents import news_analyst
    monkeypatch.setattr(news_analyst, "_fetch_newsapi", lambda *a, **k: [])
    monkeypatch.setattr(news_analyst, "_fetch_yahoo_rss", lambda *a, **k: [])
    news_analyst._SYMBOL_HEADLINES_CACHE.clear()
    assert news_analyst.get_headlines("ZZZ-USD") == []
    assert "ZZZ-USD" not in news_analyst._SYMBOL_HEADLINES_CACHE
