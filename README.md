# 🚀 Orbit Trading Terminal (Mochatrade YC P26)

[![Go](https://img.shields.io/badge/Go-1.24+-00ADD8.svg?style=flat&logo=go&logoColor=white)](https://go.dev)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688.svg?style=flat&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6.svg?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB.svg?style=flat&logo=python&logoColor=white)](https://python.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon_Cloud-4169E1.svg?style=flat&logo=postgresql&logoColor=white)](https://neon.tech)
[![Valkey](https://img.shields.io/badge/Valkey-7.2_TLS-CC0000.svg?style=flat&logo=redis&logoColor=white)](https://valkey.io)
[![Three.js](https://img.shields.io/badge/Three.js-r128-000000.svg?style=flat&logo=three.js&logoColor=white)](https://threejs.org)
[![Clerk](https://img.shields.io/badge/Clerk-Headless_Auth-6C47FF.svg?style=flat&logo=clerk&logoColor=white)](https://clerk.com)

**Orbit Trading Terminal** is an institutional-grade, multi-agent autonomous algorithmic trading platform engineered for ultra-low latency execution and deep market intelligence. It unites a **Go API Gateway & Auto-Trade Scheduler**, a **Go WebSocket Tick Broadcast Hub**, a **Python AI Decision & Risk Engine**, an in-memory **Aiven Valkey TLS Cache**, and a strictly-typed **TypeScript/Three.js WebGL Trading Console**.

---

## 🏛️ System Architecture Topology

The platform operates as a decoupled, resilient microservice topology designed for sub-millisecond execution and seamless state synchronization:

```mermaid
flowchart TB
    subgraph ClientLayer["🖥️ Frontend Client Layer"]
        Browser["Trader Web Browser<br/>(TypeScript ES2022 + Three.js + Tailwind Glassmorphism)"]
    end

    subgraph GatewayLayer["🛡️ Go Gateway Layer (:8000)"]
        GoGateway["Go Reverse Proxy & Auth Gateway<br/>(backend/main.go)"]
        BotScheduler["Auto-Trade Bot Scheduler<br/>(backend/botsched)"]
        JWKSValidator["Clerk JWKS Token Verifier"]
        SessionIssuer["HMAC Session Cookie Engine"]
    end

    subgraph StreamLayer["⚡ Stream Service (:8002)"]
        StreamHub["Go WebSocket Tick Broadcast Hub<br/>(go-stream/main.go)"]
    end

    subgraph AIServiceLayer["🧠 Python AI Intelligence Layer (:8001)"]
        AIService["FastAPI Core Engine<br/>(ai-service/main.py)"]
        AgentOrchestrator["12-Agent Quantitative Crew<br/>(Trend, Volume, Volatility, S/R, MTF)"]
        ConsensusEngine["Consensus & Decision Engine<br/>(Brain + Risk Guard + Opportunity)"]
        PositionService["Position & P&L Service<br/>(Atomic Margin & Execution)"]
        DBPool["PostgreSQL ThreadedConnectionPool<br/>(Min: 2, Max: 15 Warm Sockets)"]
    end

    subgraph DataStorageLayer["💾 High-Performance Persistence Layer"]
        NeonDB[("Neon Cloud PostgreSQL<br/>(Authoritative Ledger)")]
        ValkeyCluster[("Aiven Valkey TLS Cluster<br/>(Sub-ms Quotes, State & Active Trades)")]
    end

    %% Client Interactions
    Browser -->|"HTTP / REST (:8000)"| GoGateway
    Browser -->|"WebSocket /ws (Private Account State)"| GoGateway
    Browser -->|"WebSocket /ws/stream (Public Ticks)"| GoGateway

    %% Gateway Routing
    GoGateway -->|"Verify Auth (Clerk JWT / Session Cookie)"| JWKSValidator
    GoGateway -->|"Issue Session Token"| SessionIssuer
    GoGateway -->|"Proxy Public Market Ticks"| StreamHub
    GoGateway -->|"Proxy Scoped API & Private WS (X-User-ID)"| AIService
    GoGateway <-->|"Drive Scheduled Bot Cycles"| BotScheduler
    BotScheduler -->|"Execute Scans & Managed Positions"| AIService

    %% Python AI Service Operations
    AIService -->|"Run AI Orchestration & Risk Checks"| AgentOrchestrator
    AIService -->|"Synthesize Quantitative Signals"| ConsensusEngine
    AIService -->|"Atomic Order Allocation & Closures"| PositionService
    AIService -->|"Sub-ms Cache & Pub/Sub Ticks"| ValkeyCluster
    PositionService -->|"Borrow Warm Connections"| DBPool
    DBPool <-->|"Atomic Read-Check-Write Transactions"| NeonDB
    AIService -->|"Fire-and-Forget Tick Deliveries"| StreamHub
```

---

## ⚡ High-Speed Position Close & Execution Flow

Trade actions (manual buying, selling, and position closures) execute via a non-blocking asynchronous pipeline:

```mermaid
sequenceDiagram
    autonumber
    actor Trader as 🧑‍💻 Trader
    participant UI as 🖥️ TypeScript UI
    participant Gateway as 🛡️ Go Gateway (:8000)
    participant Python as 🧠 AI Service (:8001)
    participant Pool as 🏊 DB Connection Pool
    participant Postgres as 🐘 Neon PostgreSQL
    participant Valkey as ⚡ Valkey Cluster
    participant Hub as 📡 Stream Hub (:8002)

    Trader->>UI: Click "⚡ Close" or Confirm in Modal
    UI->>UI: Dismiss modal immediately (Zero UI freezing)
    UI->>Gateway: POST /api/trades/{id}/close (Cookie / Clerk Bearer)
    Gateway->>Gateway: Verify identity & attach X-User-ID
    Gateway->>Python: Proxied POST with X-Orbit-Internal-Token

    Python->>Pool: Borrow warm PostgreSQL connection
    Pool->>Postgres: Atomic balance credit + trade status='closed' + audit log
    Postgres-->>Pool: Transaction Committed
    Pool-->>Python: Return connection to pool

    Python->>Valkey: Invalidate trade:active and user cache
    Python-->>Gateway: HTTP 200 OK (realized_pnl, refund_amount, remaining_qty)
    Gateway-->>UI: HTTP 200 OK (<300ms)
    UI->>UI: Display instant success & update Open Trades table

    par Asynchronous Background Task (asyncio.create_task)
        Python->>Valkey: Recalculate portfolio equity & KPIs
        Python->>Gateway: Broadcast WebSocket {"type": "trade_closed"}
        Gateway->>Hub: Broadcast updated tick state
        Gateway->>UI: Push live {"type": "wallet", "balance": ...}
    end
```

---

## 🤖 The 12-Agent Quantitative Intelligence Engine

Orbit features 12 specialized quantitative agents running concurrently across unified in-memory market frames:

```mermaid
graph TD
    subgraph MarketIngestion["📊 Ingestion & Normalization"]
        MarketData["MarketDataService<br/>(Yahoo Finance, Single-Flight Cache)"]
    end

    subgraph AnalyticalCrew["🧠 Specialized Analysis Crew"]
        A1["1. Trend Agent (EMA 50/200 Stack)"]
        A2["2. Momentum Agent (RSI + MACD Divergence)"]
        A3["3. Volume Flow Agent (OBV + 20-bar VWAP)"]
        A4["4. Volatility Agent (Bollinger Band Squeeze/Expansion)"]
        A5["5. Levels Analyst (S/R Clusters & Liquidity Sweeps)"]
        A6["6. MTF Trend Agent (Weekly Macro Trend Alignment)"]
        A7["7. Sentiment Agent (Live News NLP + LLM Reasoning)"]
    end

    subgraph QuantitativeStrategies["📐 12 Quantitative Strategies"]
        S1["Smart Money Concepts (SMC)"]
        S2["Inner Circle Trader (ICT Liquidity)"]
        S3["Wyckoff Accumulation/Distribution"]
        S4["Price Action & Multi-Candle Patterns"]
        S5["Supply & Demand Imbalance"]
        S6["SuperTrend & HMA Directional"]
    end

    subgraph DecisionRiskLayer["🛡️ Risk & Consensus Guard"]
        Consensus["ORBIT Consensus Engine<br/>(Weighted Multi-Model Signal)"]
        RiskGuard["ORBIT Risk Guard<br/>(Anti-False-Safety & 1% Capital Protection)"]
        Decision["ORBIT Decision Engine<br/>(Stance: BULLISH / BEARISH / MIXED / NEUTRAL)"]
    end

    MarketData --> AnalyticalCrew
    MarketData --> QuantitativeStrategies
    AnalyticalCrew --> Consensus
    QuantitativeStrategies --> Consensus
    Consensus --> RiskGuard
    RiskGuard --> Decision
```

---

## 🌟 Core Features

- **Go Backend Gateway (`:8000`)**: Authenticates all traffic, verifies Clerk JWTs / HMAC sessions, serves optimized frontend static assets, runs the autonomous background bot scheduler, and reverse-proxies internal endpoints.
- **Go WebSocket Tick Hub (`:8002`)**: Handles ultra-concurrency WebSocket broadcast fanout (`/ws/stream`) with zero GC pause overhead.
- **Python AI Microservice (`:8001`)**: FastAPI service running the 12 quantitative AI agents, trading execution, Valkey caching, and database transactions.
- **PostgreSQL Connection Pooling**: High-speed `ThreadedConnectionPool` eliminating ~1.6s TCP/TLS remote handshake delays on every database query.
- **1-Click "⚡ Quick Close"**: Immediate market order exit directly from the Open Trades table with optimistic UI updates.
- **Auto-Trade Bot Scheduler**: Configurable automated trading bot with autonomous scanning, risk allocation limits, stop-loss, and target profit guards.
- **Interactive Three.js 3D WebGL Scene**: Dynamic candlestick landscape and volumetric hero lighting with automatic throttling when entering the trading dashboard.
- **Headless Clerk & Direct Auth**: Frictionless login via Google OAuth or direct credentials with instant Neon PostgreSQL provisioning.

---

## 🛠️ Quick Start & Local Setup

### Prerequisites
- **Go 1.24+** ([Download Go](https://go.dev/dl/))
- **Python 3.11+** ([Download Python](https://python.org))
- **Node.js 18+ & npm** ([Download Node.js](https://nodejs.org))

### 1. Configure Environment Variables
Copy `.env.example` to `.env` (or configure your database and API keys):
```powershell
copy .env.example .env
```
Key variables in `.env`:
```ini
DATABASE_URL=postgresql://user:password@ep-silent-art-...neon.tech/neondb?sslmode=require
VALKEY_URL=rediss://user:password@orbit-orbittrade.g.aivencloud.com:19859
ORBIT_INTERNAL_TOKEN=orbit_internal_secret_token_f48a9b2c7e1d
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
```

### 2. Install Dependencies & Build Frontend
```powershell
# Frontend TypeScript Dependencies & Build
npm install
npm run build

# Python AI Service Dependencies
pip install -r requirements.txt
```

### 3. One-Click Launch
On Windows, simply double-click or run:
```powershell
.\run_all.bat
```
`run_all.bat` automatically:
1. Builds the TypeScript bundle (`frontend/app.bundle.js`).
2. Starts the TypeScript file watcher.
3. Launches the Go WebSocket Tick Hub on Port **8002**.
4. Launches the Python AI Service on internal Port **8001**.
5. Launches the Go Backend Gateway on Port **8000**.
6. Opens `http://127.0.0.1:8000/` in your browser.

---

## 🔑 Test Account Credentials

A pre-provisioned, fully verified test trading account is available out-of-the-box:

- **Username**: `test123`
- **Password**: `test123`
- **Starting Capital**: `$1,000,000.00`
- **Access URL**: [http://127.0.0.1:8000/](http://127.0.0.1:8000/)

---

## 🧪 Testing & Verification Suite

```powershell
# Run backend Go tests
cd backend
go test ./...

# Run Go Stream Hub tests
cd ../go-stream
go test ./...

# Run Python 12-agent pipeline diagnostics
cd ..
python test_pipeline.py

# Verify complete end-to-end audit
python test_complete_audit.py
```

---

## 📂 Project Directory Structure

```
.
├── backend/                  # Go Backend Gateway & Auto-Trade Scheduler
│   ├── botsched/             # High-concurrency bot supervisor & leader lease
│   ├── database/             # PostgreSQL pgx connection pool
│   ├── handlers/             # Go-native read handlers & health checks
│   ├── middleware/           # Clerk JWT verification, session HMAC, security
│   ├── proxy/                # Reverse proxy for REST & WebSockets
│   └── main.go               # Gateway router & HTTP server (Port 8000)
├── go-stream/                # Go WebSocket Tick Hub (Port 8002)
│   ├── main.go               # Tick fanout broadcast server
│   └── main_test.go          # Tick hub unit tests
├── ai-service/               # Python AI Quantitative Decision Engine (Port 8001)
│   ├── models/               # Pydantic schemas (Market, Agent, Risk, Bot)
│   ├── services/             # Specialized services (Position, Market, Brain, Risk)
│   ├── database.py           # ThreadedConnectionPool & Neon PostgreSQL interface
│   ├── gateway_auth.py       # Loopback & HMAC token gateway verification
│   └── main.py               # FastAPI application & trading execution
├── src/                      # Frontend TypeScript Source (Strict ES2022)
│   ├── services/             # API client, Trading, Auth, AutoBot services
│   ├── state/                # Centralized reactive terminal store
│   ├── types/                # TypeScript interfaces (Trading, Bot, WebSocket)
│   ├── ui/                   # Controllers (ManageTrades, Terminal, Auth, AutoBot)
│   └── index.ts              # Terminal bootstrap & window bindings
├── frontend/                 # Static Assets & Compiled Bundle
│   ├── app.bundle.js         # Compiled ESBuild JavaScript bundle
│   ├── index.html            # Trading Terminal UI shell
│   ├── style.css             # Institutional dark glassmorphic CSS
│   └── three-scene.js        # Three.js 3D WebGL Candlestick Scene
├── run_all.bat               # Automated multi-service launcher script
├── MEMORY.md                 # Architecture ledger, design decisions & lessons learned
└── README.md                 # Complete system documentation & topology
```

---

## 📄 License
This repository is developed for **Mochatrade YC P26 Mumbai Hackathon**. All rights reserved.
