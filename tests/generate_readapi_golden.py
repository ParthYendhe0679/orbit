"""
Regenerate backend/readapi/testdata/python_golden.json from the Python
ai-service running on PostgreSQL (the production database engine).

    docker run -d --name orbit-parity-pg -e POSTGRES_PASSWORD=parity -p 55432:5432 postgres:16-alpine
    python tests/generate_readapi_golden.py postgresql://postgres:parity@127.0.0.1:55432/postgres

The target database is dropped and recreated (schema "public"), so never point
this at a real database. Afterwards the Go integration test can compare the
gateway against the same data:

    cd backend && ORBIT_TEST_DATABASE_URL=<same url> go test ./readapi -run Integration -v
"""

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import conftest  # noqa: E402  (isolates LLM/news/Valkey env before app imports)

if len(sys.argv) != 2 or not sys.argv[1].startswith("postgres"):
    sys.exit(__doc__)
url = sys.argv[1]
if "neon.tech" in url or "amazonaws" in url:
    sys.exit("Refusing to run against a hosted database; use a disposable local PostgreSQL.")
os.environ["DATABASE_URL"] = url

import psycopg2  # noqa: E402

with psycopg2.connect(url) as _c:
    _c.autocommit = True
with psycopg2.connect(url) as conn:
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")

import main  # noqa: E402
import readapi_contract as contract  # noqa: E402
from models.market import MarketQuote  # noqa: E402

db = main.db
assert db.IS_POSTGRES, "database.py did not pick up the PostgreSQL URL"
db.init_db()


async def _quote(symbol, force_refresh=False):
    p = contract.PRICES[symbol.strip().upper()]
    return MarketQuote(symbol=symbol.upper(), price=p, open=p, high=p, low=p, close=p, previous_close=p,
                       change=0.0, change_percent=0.0, timestamp="now", source="golden")

main.market_service.get_quote = _quote
main.valkey_service.is_connected = False
main.valkey_service._valkey_client = None

ids = contract.seed(db)
client = conftest.GatewayClient(main.app)
golden = contract.capture(client, db, ids)
golden["generated_with"] = "python ai-service on PostgreSQL"

contract.GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
contract.GOLDEN_PATH.write_text(json.dumps(golden, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
print(f"wrote {contract.GOLDEN_PATH}")
