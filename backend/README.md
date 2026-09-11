# Mochatrade Backend — ORBIT Go Gateway

The Go gateway is the only public entry point of ORBIT. It serves the
frontend, authenticates every request, serves the read-heavy portfolio
endpoints natively from PostgreSQL + Valkey, proxies everything else to the
Python ai-service, bridges the WebSockets, and schedules the Auto-Trade Bot.

```
browser ──► Go gateway :8000 ──► ai-service :8001 (FastAPI, 12 agents, LLM)
              │  auth (Clerk JWKS / gateway session)      │
              │  native reads ──► PostgreSQL (pgx)         ├──► PostgreSQL / Valkey / market APIs
              │               └─► Valkey (live prices)     │
              │  /ws        ◄──► ai-service /ws (private, per account)
              │  /ws/stream ◄─── orbit-stream :8002 (public ticks) ◄── ai-service tick scheduler
              └─ bot scheduler ──► ai-service /internal/bot/*
```

## Security model

* **Private by default.** Every `/api` route requires a verified identity
  unless `middleware.APIAccess` lists it as public: `/api/health`,
  `/api/auth/config`, `/api/login`, `/api/register`, `/api/auth/logout`,
  `/api/news`, `/api/news/global`, `/api/market/*`.
* **Credentials** (first match wins; an invalid `Authorization` header is
  rejected, never skipped):
  1. `Authorization: Bearer <token>` — a Clerk session JWT (RS256, verified
     against the instance JWKS: signature, `exp`, `nbf`, `iat`, `iss`, `sub`,
     optional `azp`/`aud`) or a gateway session token (HS256).
  2. `orbit_session` cookie — HttpOnly, SameSite=Strict, issued by the gateway
     after `/api/login` or `/api/register` (password verified by the
     ai-service) or `/api/auth/sync` (Clerk token verified by the gateway).
  3. `__session` cookie — the Clerk session token clerk-js keeps refreshed.
* **401** without valid credentials, **403** for a verified Clerk user without
  an ORBIT account yet (only `/api/auth/sync` provisions one) or for a
  `user_id` (query or JSON body) naming another account. Rejected requests
  never reach the ai-service.
* **Trusted headers.** Client copies of `X-User-ID`, `X-User-Clerk-ID`,
  `X-User-Email`, `X-Orbit-Internal-Token`, `Authorization`, `Cookie` and
  `Origin` are stripped from every forwarded request; the gateway then sets
  `X-User-ID` (verified account) and `X-Orbit-Internal-Token`. The ai-service
  (`ai-service/gateway_auth.py`) honours identity headers only from callers
  holding that token (loopback only when no token is configured) and rewrites
  `user_id` to the verified account.
* **WebSockets.** `/ws` is authenticated before the upgrade; the account comes
  from the credentials, never from `?user_id=`, and the origin must be the
  gateway's own (or `ORBIT_ALLOWED_ORIGINS`). `/ws/stream` carries only public
  market ticks.
* **CORS** headers are sent only for `ORBIT_ALLOWED_ORIGINS`; the frontend is
  same-origin.

## Native read endpoints (`readapi/`)

| Route | Source |
|---|---|
| `GET /api/dashboard/summary` (+ `/api/dashboard`, `/api/portfolio/summary`) | PostgreSQL + Valkey `market:price:*` |
| `GET /api/trades/open` (+ `/api/positions`) | PostgreSQL + Valkey `market:price:*` |
| `GET /api/trades/history` | PostgreSQL |
| `GET /api/bot-config` | PostgreSQL |

Responses are the ai-service's JSON contract, field for field. Parity is
enforced against `readapi/testdata/python_golden.json`, captured from the
Python service on PostgreSQL (`tests/generate_readapi_golden.py`); the Python
suite checks the same golden (`tests/test_readapi_contract.py`).

When the gateway cannot answer authoritatively — no PostgreSQL pool, no Valkey,
a held symbol without a fresh price tick, or a query error — the request is
served by the ai-service instead. `X-Orbit-Source: gateway|ai-service` shows
which layer answered.

## Environment

Loaded from the process environment, then `../.env`, `.env`, `../ai-service/.env`
(earlier sources win).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Gateway port |
| `AI_SERVICE_URL` | `http://127.0.0.1:8001` | Python ai-service |
| `STREAM_SERVICE_URL` | `http://127.0.0.1:8002` | orbit-stream tick hub |
| `ORBIT_INTERNAL_TOKEN` | — | Shared secret with the ai-service and orbit-stream (required off loopback) |
| `DATABASE_URL` | — | PostgreSQL (Neon). Without it all reads go to the ai-service |
| `DB_MAX_CONNS` | `10` | pgx pool size |
| `VALKEY_URL` / `REDIS_URL` / `VALKEY_HOST`… | — | Live price cache (Aiven Valkey, TLS) |
| `CLERK_PUBLISHABLE_KEY` | — | Derives the Clerk issuer and JWKS URL |
| `CLERK_ISSUER`, `CLERK_JWKS_URL` | derived | Overrides |
| `CLERK_AUTHORIZED_PARTIES` | — | Allowed `azp` origins (comma-separated) |
| `CLERK_AUDIENCE` | — | Required `aud`, if your Clerk tokens carry one |
| `ORBIT_SESSION_SECRET` | per-process | 32+ chars; keeps sessions across restarts |
| `ORBIT_SESSION_TTL` | `12h` | Session lifetime |
| `ORBIT_ALLOWED_ORIGINS` | — | Extra origins for CORS / WebSockets |
| `BOT_SCHEDULER_ENABLED` | `true` | Run the Auto-Trade Bot scheduler |
| `FRONTEND_PATH`, `NODE_MODULES_PATH` | auto | Static roots |

Neon's pooled endpoint (PgBouncer) is handled with pgx `QueryExecModeExec`;
`channel_binding=require` (unsupported by pgx) is replaced by
`sslmode=verify-full`.

## Health

`GET /health` reports, separately: `gateway` (auth mode), `ai_service`
(status, latency, fields the ai-service reported), `database` (gateway pool
and ai-service), `valkey` (gateway client and ai-service cache mode/TLS) and
`stream_hub`. Probes time out after 5 s (Neon/Aiven TLS cold starts).

## Running and testing

```bash
cd backend
go run .            # needs the ai-service on :8001 and orbit-stream on :8002
go test ./...

# Go SQL vs Python parity on a disposable PostgreSQL:
docker run -d --name orbit-parity-pg -e POSTGRES_PASSWORD=parity -p 55432:5432 postgres:16-alpine
python ../tests/generate_readapi_golden.py postgresql://postgres:parity@127.0.0.1:55432/postgres
ORBIT_TEST_DATABASE_URL="postgresql://postgres:parity@127.0.0.1:55432/postgres?sslmode=disable" go test ./readapi -run Integration -v
```
