"""
The read endpoints the Go gateway serves natively must keep the ai-service's
contract. This replays the parity portfolio on the ai-service (SQLite) and
checks every response still equals the golden captured on PostgreSQL — the
same golden the Go tests (backend/readapi) are held to. A deliberate Python
contract change fails here until the golden (and the Go port) are updated:
see tests/generate_readapi_golden.py.
"""

import json

import pytest

import main
import readapi_contract as contract
from conftest import GatewayClient
from models.market import MarketQuote

db = main.db


@pytest.fixture
def replay(tmp_path, monkeypatch):
    for mod in (db,):
        monkeypatch.setattr(mod, "DB_PATH", str(tmp_path / "contract.db"))
        monkeypatch.setattr(mod, "IS_POSTGRES", False)
    db.init_db()
    vs = main.valkey_service
    vs._memory_cache.clear()
    vs._memory_sets.clear()
    vs.is_connected = False
    vs._valkey_client = None

    async def quote(symbol, force_refresh=False):
        p = contract.PRICES[symbol.strip().upper()]
        return MarketQuote(symbol=symbol.upper(), price=p, open=p, high=p, low=p, close=p, previous_close=p,
                           change=0.0, change_percent=0.0, timestamp="now", source="contract")

    monkeypatch.setattr(main.market_service, "get_quote", quote)
    ids = contract.seed(db)
    return contract.capture(GatewayClient(main.app), db, ids)


def test_python_responses_match_the_golden(replay):
    golden = json.loads(contract.GOLDEN_PATH.read_text(encoding="utf-8"))
    assert replay["ids"] == golden["ids"]
    assert replay["bot_live_statuses"] == golden["bot_live_statuses"]
    for name, expected in golden["responses"].items():
        got = replay["responses"][name]
        drop = contract.VOLATILE_KEYS | ({"id"} if name == "bot_config_carol_default" else set())
        assert contract.normalize(got, drop) == contract.normalize(expected, drop), name
