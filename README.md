# 🪐 ORBIT // Institutional Multi-Agent Autonomous Algorithmic Trading Platform

<div align="center">

[![Go](https://img.shields.io/badge/Go-1.24+-00ADD8.svg?style=for-the-badge&logo=go&logoColor=white)](https://go.dev)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688.svg?style=for-the-badge&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB.svg?style=for-the-badge&logo=python&logoColor=white)](https://python.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon_Cloud-4169E1.svg?style=for-the-badge&logo=postgresql&logoColor=white)](https://neon.tech)
[![Valkey](https://img.shields.io/badge/Valkey-7.2_TLS-CC0000.svg?style=for-the-badge&logo=redis&logoColor=white)](https://valkey.io)
[![Three.js](https://img.shields.io/badge/Three.js-WebGL-000000.svg?style=for-the-badge&logo=three.js&logoColor=white)](https://threejs.org)
[![Clerk](https://img.shields.io/badge/Clerk-Headless_Auth-6C47FF.svg?style=for-the-badge&logo=clerk&logoColor=white)](https://clerk.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

<p align="center">
  <strong>An institutional-grade, multi-agent autonomous algorithmic trading platform engineered for ultra-low latency execution, quantitative consensus intelligence, and real-time market risk management.</strong>
</p>

<p align="center">
  <a href="#-system-architecture-topology">Architecture</a> •
  <a href="#-the-12-agent-quantitative-intelligence-matrix">12-Agent Matrix</a> •
  <a href="#-high-speed-trade-execution-pipeline">Execution Pipeline</a> •
  <a href="#-autonomous-auto-trade-bot-scheduler">Auto-Trade Bot</a> •
  <a href="#-ai-strategy-lab--backtester">Strategy Lab</a> •
  <a href="#-interactive-3d-webgl-engine">3D WebGL Scene</a> •
  <a href="#-quick-start--local-setup">Quick Start</a> •
  <a href="#-author">Author</a>
</p>

</div>

---

## 📖 Executive Summary

**ORBIT** is a high-frequency, multi-asset trading terminal and quantitative decision platform. Engineered from the ground up for financial institutions, hedge fund strategies, and active traders, ORBIT decouples execution, real-time telemetry, and quantitative intelligence across a resilient microservice mesh:

1. **Go API Gateway & Bot Scheduler (`:8000`)**: Authenticates sessions (Clerk JWTs & HMAC cookies), serves optimized frontend assets, schedules high-concurrency background auto-trade bot scans, and proxies authenticated traffic.
2. **Go WebSocket Tick Hub (`:8002`)**: Dedicated ultra-concurrency tick broadcast engine streaming live quotes to connected clients with sub-millisecond fanout and zero GC pause overhead.
3. **Python AI Quantitative Core (`:8001`)**: High-performance FastAPI engine orchestrating a 12-agent quantitative consensus matrix, risk evaluation guards, margin allocations, and atomic database execution.
4. **Neon Serverless PostgreSQL**: Authoritative transaction ledger with warm connection pooling (`ThreadedConnectionPool`) eliminating remote TLS handshake latencies.
5. **Aiven Valkey TLS Cache**: Sub-millisecond in-memory cache indexing active trades, live quotes, and user portfolio metrics for instantaneous $O(1)$ lookup.
6. **Institutional WebGL Frontend**: Strictly-typed TypeScript ES2022 console with TradingView Lightweight Charts and an interactive Three.js 3D candlestick environment.

---

## 🏛️ System Architecture Topology

The microservice topology is strictly decoupled to guarantee sub-millisecond execution, fault tolerance, and non-blocking asynchronous event distribution:

```mermaid
flowchart TB
    subgraph ClientLayer["🖥️ Client Interface Layer"]
        Browser["Trader Web Browser<br/>(TypeScript ES2022 + Three.js 3D + TradingView Charts)"]
    end

    subgraph GatewayLayer["🛡️ Go API Gateway & Bot Scheduler (:8000)"]
        GoGateway["Go Reverse Proxy & Auth Gateway<br/>(backend/main.go)"]
        BotScheduler["Autonomous Bot Supervisor<br/>(backend/botsched)"]
        JWKSValidator["Clerk JWKS Token Verifier"]
        SessionIssuer["HMAC Session Cookie Engine"]
    end

    subgraph StreamLayer["⚡ Stream Service (:8002)"]
        StreamHub["Go WebSocket Tick Broadcast Hub<br/>(go-stream/main.go)"]
    end

    subgraph AIServiceLayer["🧠 Python AI Intelligence Core (:8001)"]
        AIService["FastAPI Core Engine<br/>(ai-service/main.py)"]
        AgentOrchestrator["12-Agent Quantitative Crew<br/>(Trend, Momentum, Volume, Volatility, Levels, MTF, Sentiment)"]
        StrategyEngine["Quantitative Strategy Engine<br/>(SMC, ICT, Wyckoff, Price Action, Supply/Demand)"]
        ConsensusEngine["Consensus & Decision Engine<br/>(Brain Matrix + Risk Guard + Opportunity Engine)"]
        PositionService["Position & P&L Engine<br/>(Atomic Margin & Execution)"]
        DBPool["PostgreSQL ThreadedConnectionPool<br/>(Min: 2, Max: 15 Warm Sockets)"]
        StrategyLab["AI Strategy Lab & Backtester<br/>(Natural-Language Strategy Parsing & Simulation)"]
    end

    subgraph DataStorageLayer["💾 High-Performance Persistence Layer"]
        NeonDB[("Neon Cloud PostgreSQL<br/>(Authoritative Ledger & Accounts)")]
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

    %% Python AI Operations
    AIService -->|"Run Agent Orchestration"| AgentOrchestrator
    AIService -->|"Evaluate Technical Strategies"| StrategyEngine
    AgentOrchestrator -->|"Synthesize Intelligence"| ConsensusEngine
    StrategyEngine -->|"Synthesize Setups"| ConsensusEngine
    AIService -->|"Execute Custom Strategies"| StrategyLab
    AIService -->|"Atomic Order Allocation & Closures"| PositionService
    AIService -->|"Sub-ms Cache & Pub/Sub Ticks"| ValkeyCluster
    PositionService -->|"Borrow Warm Connections"| DBPool
    DBPool <-->|"Atomic Read-Check-Write Transactions"| NeonDB
    AIService -->|"Fire-and-Forget Tick Deliveries"| StreamHub
```

---

## ⚡ High-Speed Trade Execution Pipeline

Trades execute via an asynchronous, non-blocking pipeline where order confirmation and margin adjustments return in `<300ms`, while non-critical telemetry and aggregate updates run in background worker tasks:

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

    Trader->>UI: Click "⚡ Quick Close" (or Confirm in Order Modal)
    UI->>UI: Optimistic UI state update (Zero UI freeze)
    UI->>Gateway: POST /api/trades/{id}/close (Session Cookie / Bearer)
    Gateway->>Gateway: Verify identity & attach X-User-ID
    Gateway->>Python: Proxied POST with X-Orbit-Internal-Token

    Python->>Pool: Borrow warm PostgreSQL connection (0ms handshake)
    Pool->>Postgres: Atomic balance credit + trade status='closed' + audit log
    Postgres-->>Pool: Transaction Committed
    Pool-->>Python: Return connection to pool

    Python->>Valkey: Invalidate trade:active and user cache
    Python-->>Gateway: HTTP 200 OK (realized_pnl, refund_amount, remaining_qty)
    Gateway-->>UI: HTTP 200 OK (<300ms total turnaround)
    UI->>UI: Display instant success toast & update Open Trades grid

    par Asynchronous Background Task (asyncio.create_task)
        Python->>Valkey: Recalculate portfolio equity & KPIs
        Python->>Gateway: Broadcast WebSocket {"type": "trade_closed"}
        Gateway->>Hub: Broadcast updated tick state
        Gateway->>UI: Push live {"type": "wallet", "balance": ...}
    end
```

---

## 🤖 The 12-Agent Quantitative Intelligence Matrix

Orbit executes 12 independent quantitative agents and strategy algorithms concurrently over standardized in-memory market frames:

```mermaid
graph TD
    subgraph MarketIngestion["📊 Market Data Ingestion"]
        MarketData["MarketDataService<br/>(Yahoo Finance, Single-Flight Request Coalescing)"]
    end

    subgraph AnalyticalCrew["🧠 Specialized Analysis Crew"]
        A1["1. Trend Agent (EMA 50/200 Stack)"]
        A2["2. Momentum Agent (RSI + MACD Divergence)"]
        A3["3. Volume Flow Agent (OBV + 20-bar VWAP)"]
        A4["4. Volatility Agent (Bollinger Band Squeeze/Expansion)"]
        A5["5. Levels Analyst (S/R Clusters & Liquidity Sweeps)"]
        A6["6. MTF Trend Agent (Weekly Macro Alignment)"]
        A7["7. Sentiment Agent (Live News NLP + LLM Reasoning)"]
    end

    subgraph QuantitativeStrategies["📐 Quantitative Strategies"]
        S1["Smart Money Concepts (SMC)"]
        S2["Inner Circle Trader (ICT Liquidity)"]
        S3["Wyckoff Accumulation/Distribution"]
        S4["Price Action & Multi-Candle Patterns"]
        S5["Supply & Demand Imbalance"]
        S6["SuperTrend & HMA Directional"]
    end

    subgraph DecisionRiskLayer["🛡️ Risk & Consensus Guard"]
        Consensus["ORBIT Consensus Engine<br/>(45% Agents, 55% Strategies, Weighted Matrix)"]
        RiskGuard["ORBIT Risk Guard<br/>(5-Pillar Assessment & Anti-False-Safety)"]
        Opportunity["ORBIT Opportunity Engine<br/>(Setup Confluence & Quality Scoring)"]
        Decision["ORBIT Decision Engine<br/>(Authoritative Stance: BULLISH / BEARISH / MIXED / NEUTRAL)"]
        Explain["Explainability & Insights Engine<br/>(Traceable Evidence & Core Thesis)"]
    end

    MarketData --> AnalyticalCrew
    MarketData --> QuantitativeStrategies
    AnalyticalCrew --> Consensus
    QuantitativeStrategies --> Consensus
    Consensus --> RiskGuard
    Consensus --> Opportunity
    RiskGuard --> Decision
    Opportunity --> Decision
    Decision --> Explain
```

### Analytical Agent Roster

| Agent | Focus Area | Mathematical / Algorithmic Basis | Confidence Metric |
| :--- | :--- | :--- | :--- |
| **Trend Agent** | Directional Momentum | EMA 50/200 Golden/Death Cross & Slope Angle | 0–100% Normalized |
| **Momentum Agent** | Oscillator Divergence | 14-period RSI Overbought/Oversold + MACD Histogram | Momentum Vector |
| **Volume Flow Agent** | Institutional Flow | On-Balance Volume (OBV) + 20-bar Rolling VWAP | Volume Delta |
| **Volatility Agent** | Volatility Cycles | Bollinger Band Width & ATR Squeeze/Expansion | Band Ratio |
| **Levels Analyst** | Liquidity & Structure | Support/Resistance Clusters & Prior High/Low Sweeps | Cluster Density |
| **MTF Trend Agent** | Macro Confirmation | Higher-Timeframe (Weekly/Daily) Multi-Candle Alignment | Multi-Timeframe Index |
| **Sentiment Agent** | Market Psychology | Real-time Financial News NLP Sentiment & NewsAPI Feed | Sentiment Polarity |

---

## 📡 Real-Time WebSocket Tick Streaming Architecture

Market ticks stream through a high-throughput, low-latency broadcast pipeline designed for thousands of concurrent sessions:

```mermaid
flowchart LR
    subgraph Providers["External Feeds"]
        YF["Yahoo Finance"]
        AV["Alpha Vantage"]
    end

    subgraph PythonCore["Python AI Service (:8001)"]
        MDS["MarketDataService<br/>Single-Flight Cache"]
        PubTick["publish_tick()<br/>Non-blocking urllib"]
    end

    subgraph GoHub["Go Stream Hub (:8002)"]
        Listener["/publish Handler"]
        Broadcaster["Goroutine Fanout Hub<br/>(Lock-free Client Map)"]
    end

    subgraph Clients["Connected Terminals"]
        C1["Client 1 (/ws/stream)"]
        C2["Client 2 (/ws/stream)"]
        CN["Client N (/ws/stream)"]
    end

    Providers --> MDS
    MDS --> PubTick
    PubTick -->|HTTP POST 2ms| Listener
    Listener --> Broadcaster
    Broadcaster --> C1
    Broadcaster --> C2
    Broadcaster --> CN
```

---

## 🔬 AI Strategy Lab & Backtester

ORBIT features a natural-language Strategy Lab enabling quantitative traders to describe custom strategies in plain English without writing a line of code:

```mermaid
flowchart TD
    Prompt["Trader Prompt:<br/>'Buy when RSI < 30 and price is above EMA 200, exit when RSI > 70'"]
    Parser["NLP Strategy Parser<br/>(Extracts Indicators, Entry/Exit Rules & Thresholds)"]
    Engine["Deterministic Backtesting Engine<br/>(Historical Candle-by-Candle Simulation)"]
    Metrics["Institutional Metrics Engine<br/>(CAGR, Sharpe Ratio, Max Drawdown, Profit Factor, Win Rate)"]
    EquityCurve["Interactive Equity Curve & Trade Logs<br/>(Persisted to Neon Cloud PostgreSQL)"]

    Prompt --> Parser
    Parser --> Engine
    Engine --> Metrics
    Metrics --> EquityCurve
```

---

## 🌐 Interactive 3D WebGL Engine

The terminal's hero landing viewport incorporates a Three.js 3D WebGL scene:
- **Volumetric Candlestick Field**: Over 90 floating 3D candlestick geometries with emissive illumination (`#16a34a` emerald / `#dc2626` crimson).
- **Smooth Flow Trajectory**: Dynamic mathematical wave trajectory framing the hero headline and action CTAs.
- **Ambient Celestial Particles**: Procedural glowing star motes rendered via soft-glow radial textures and additive blending.
- **Smart Resource Throttling**: The WebGL animation loop automatically halts and frees GPU cycles the instant the user enters the active trading console.

---

## 🛠️ Technology Stack

| Layer | Technology | Version | Purpose |
| :--- | :--- | :--- | :--- |
| **API Gateway** | Go | 1.24+ | Reverse proxy, bot supervisor, Clerk JWKS verification, session cookies |
| **Stream Hub** | Go | 1.24+ | Ultra-low latency WebSocket tick fanout broadcast engine |
| **AI Intelligence** | Python / FastAPI | 3.11+ / 0.115+ | 12-agent quantitative consensus, risk evaluation, order execution |
| **Database** | PostgreSQL | Neon Serverless | Authoritative persistent storage with `ThreadedConnectionPool` |
| **Cache & State** | Valkey | 7.2 TLS (Aiven) | In-memory real-time quote caching, trade indexing, and KPI metrics |
| **Frontend UI** | TypeScript | 5.7+ (ES2022) | Strictly-typed reactive trading console bundled via `esbuild` |
| **Charting** | Lightweight Charts | 5.2.0 | Institutional financial candlestick charts and technical overlays |
| **3D Visuals** | Three.js | r185 | Volumetric WebGL candlestick landscape and atmospheric particles |
| **Authentication**| Clerk | 6.31+ | Headless user authentication with instant PostgreSQL synchronization |

---

## 📂 Project Directory Structure

```
.
├── backend/                      # Go Backend Gateway & Auto-Trade Scheduler
│   ├── botsched/                 # High-concurrency bot supervisor & session manager
│   ├── database/                 # PostgreSQL pgx connection pool interface
│   ├── handlers/                 # Health checks & native Go read endpoints
│   ├── middleware/               # Clerk JWT verification, HMAC cookies, security headers
│   ├── proxy/                    # Reverse proxy for REST endpoints & WebSockets
│   └── main.go                   # Gateway router & HTTP server (Port 8000)
├── go-stream/                    # Go WebSocket Tick Hub (Port 8002)
│   ├── main.go                   # Tick broadcast fanout server
│   └── main_test.go              # WebSocket stream unit tests
├── ai-service/                   # Python AI Quantitative Decision Core (Port 8001)
│   ├── models/                   # Strict Pydantic schemas (Agent, Market, Risk, Copilot)
│   ├── services/                 # Specialized services (Position, Market, Brain, Risk, Copilot)
│   ├── strategy_lab/             # Natural-language backtesting & strategy engine
│   ├── database.py               # ThreadedConnectionPool & Neon PostgreSQL interface
│   ├── gateway_auth.py           # Loopback security & internal token verification
│   └── main.py                   # FastAPI application & trading execution
├── src/                          # Frontend TypeScript Source (Strict ES2022)
│   ├── services/                 # API client, Trading, Auth, AutoBot, StrategyLab
│   ├── state/                    # Centralized reactive terminal store
│   ├── types/                    # TypeScript interfaces (Trading, Bot, WebSocket)
│   ├── ui/                       # Controllers (Terminal, ManageTrades, Copilot, StrategyLab)
│   ├── utils/                    # Formatters, DOM helpers, semantic markdown parsers
│   └── index.ts                  # Terminal bootstrap & window bindings
├── frontend/                     # Static Assets & Compiled Bundle
│   ├── app.bundle.js             # Compiled ESBuild JavaScript bundle
│   ├── index.html                # Institutional dark glassmorphic terminal shell
│   ├── style.css                 # Institutional dark fintech CSS design system
│   └── three-scene.js            # Three.js 3D WebGL Candlestick Scene
├── scripts/                      # Diagnostic and maintenance utilities
├── tests/                        # Automated unit and integration test suite
├── docker-compose.yml            # Multi-service containerized deployment specification
├── run_all.bat                   # 1-Click Windows automated launcher script
├── MEMORY.md                     # Architectural ledger, design decisions & lessons learned
├── package.json                  # Frontend dependencies & build scripts
└── README.md                     # Comprehensive platform documentation & topology
```

---

## 🚀 Quick Start & Local Setup

### Prerequisites
- **Go 1.24+** ([Download Go](https://go.dev/dl/))
- **Python 3.11+** ([Download Python](https://python.org))
- **Node.js 18+ & npm** ([Download Node.js](https://nodejs.org))

### 1. Clone the Repository
```bash
git clone https://github.com/ParthYendhe0679/orbit.git
cd orbit
```

### 2. Configure Environment Variables
Create your `.env` configuration file from `.env.example`:
```powershell
copy .env.example .env
```

Ensure your `.env` contains the required keys:
```ini
DATABASE_URL=postgresql://user:password@ep-silent-art-...neon.tech/neondb?sslmode=require
VALKEY_URL=rediss://user:password@orbit-orbittrade.g.aivencloud.com:19859
ORBIT_INTERNAL_TOKEN=orbit_internal_secret_token_f48a9b2c7e1d
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
```

### 3. Install Dependencies & Build Frontend
```bash
# Install frontend TypeScript dependencies and compile bundle
npm install
npm run build

# Install Python AI Service dependencies
pip install -r requirements.txt
```

### 4. 1-Click Launch (Windows)
Double-click `run_all.bat` or run:
```powershell
.\run_all.bat
```

`run_all.bat` automatically:
1. Compiles the TypeScript bundle (`frontend/app.bundle.js`).
2. Starts the TypeScript incremental watcher.
3. Launches the Go WebSocket Tick Hub on Port **8002**.
4. Launches the Python AI Quantitative Service on internal Port **8001**.
5. Launches the Go Backend Gateway on Port **8000**.
6. Opens `http://127.0.0.1:8000/` in your browser.

---

## 🔑 Pre-Configured Test Credentials

A pre-provisioned, fully verified institutional test account is available out-of-the-box:

- **Username**: `test123`
- **Password**: `test123`
- **Starting Capital**: `$1,000,000.00`
- **Access URL**: [http://127.0.0.1:8000/](http://127.0.0.1:8000/)

---

## 🧪 Testing & Verification Suite

ORBIT maintains an automated test suite across all services:

```bash
# 1. Typecheck TypeScript codebase
npm run typecheck

# 2. Run Go Gateway tests
cd backend && go test ./... && cd ..

# 3. Run Go Stream Hub tests
cd go-stream && go test ./... && cd ..

# 4. Run Python 12-agent pipeline diagnostics
python test_pipeline.py

# 5. Run complete end-to-end audit
python test_complete_audit.py
```

---

## 👤 Author

**Parth Yendhe**
- GitHub: [@ParthYendhe0679](https://github.com/ParthYendhe0679)
- Email: [yendheparth081@gmail.com](mailto:yendheparth081@gmail.com)

---

## 📄 License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.
