# Orbit (Aether) Trading Terminal

[![FastAPI](https://img.shields.io/badge/FastAPI-0.115.0+-009688.svg?style=flat&logo=FastAPI&logoColor=white)](https://fastapi.tiangolo.com)
[![Python](https://img.shields.io/badge/Python-3.10+-3776AB.svg?style=flat&logo=python&logoColor=white)](https://python.org)
[![Three.js](https://img.shields.io/badge/Three.js-r128-black.svg?style=flat&logo=three.js&logoColor=white)](https://threejs.org)
[![TradingView](https://img.shields.io/badge/TradingView-Advanced_Chart-blue.svg?style=flat&logo=tradingview&logoColor=white)](https://tradingview.com)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg?style=flat&logo=docker&logoColor=white)](https://docker.com)

**Orbit Trading Terminal** is a high-performance multi-agent autonomous trading simulation platform. It integrates a **12-agent quantitative AI decision engine**, real-time market data streaming, institutional risk modeling, LLM-powered market sentiment and reasoning, an interactive 3D WebGL landing portal, an embedded TradingView workspace with custom canvas overlays, an autonomous background auto-trading bot, and an institutional performance analytics and reporting suite.

---

## 📖 Complete Documentation

> [!NOTE]
> For the comprehensive technical manual, formulas, database schemas, workflow diagrams, and API references, see **[DOCUMENTATION.md](file:///c:/Users/yendh/OneDrive/Desktop/Project/testttai/DOCUMENTATION.md)**.

---

## ⚡ Quick Start

### 1. Clone & Configure Environment
```powershell
# Copy the environment template
copy .env.example .env
```

Edit `.env` and provide your API keys (Google Gemini, Groq, NewsAPI, or Gmail SMTP for OTP emails).

### 2. Local Run
```powershell
# Install backend dependencies
pip install -r backend/requirements.txt

# Start the FastAPI ASGI server
python -m uvicorn backend.main:app --reload --port 8000
```
Open **[http://localhost:8000](http://localhost:8000)** in your browser.

### Auto-Trade Bot (needs the Go gateway)
The bot is scheduled by the Go gateway (`backend/botsched`): one goroutine per
session, bounded parallelism, per-symbol shared analysis and a leader lease.
The ai-service only executes single steps, so run the three processes:

```powershell
# ai-service (AI + trading engine)
cd ai-service; python -m uvicorn main:app --port 8002
# gateway on :8000 (serves the UI, proxies /api + /ws, runs the bot scheduler)
cd backend; $env:AI_SERVICE_URL="http://127.0.0.1:8002"; go run .
# optional tick hub on :8001
cd go-stream; go run .
```
Set the same `ORBIT_INTERNAL_TOKEN` on the gateway and the ai-service whenever
they are not both on loopback (always in docker-compose). Bot tests:
`python -m pytest tests -q` and `cd backend; go test ./...`.

### 3. Docker Deployment
```powershell
docker-compose up --build
```

---

## 🤖 The 12-Agent Intelligence Engine

1. **[Levels Analyst](file:///c:/Users/yendh/OneDrive/Desktop/Project/testttai/backend/agents/chart_analyst.py)** — Calculates support & resistance clusters and locates institutional stop-hunt liquidity pools.
2. **[Indicator Analyst](file:///c:/Users/yendh/OneDrive/Desktop/Project/testttai/backend/agents/indicator_analyst.py)** — Computes Wilder's RSI, MACD crossovers, and 50/200 EMA macro alignment.
3. **[News Analyst](file:///c:/Users/yendh/OneDrive/Desktop/Project/testttai/backend/agents/news_analyst.py)** — Scrapes live news feeds and scores contextual sentiment $[-1.0, +1.0]$ via Gemini / Groq with NLP lexicon fallback.
4. **[Momentum Candle Analyst](file:///c:/Users/yendh/OneDrive/Desktop/Project/testttai/backend/agents/momentum_candle_analyst.py)** — Grades Big Bars ($\ge 1.5\times$ ATR), Marubozu, and rejection pin wicks with volume confirmation.
5. **[EMA Ribbon Analyst](file:///c:/Users/yendh/OneDrive/Desktop/Project/testttai/backend/agents/ema_ribbon_analyst.py)** — Maps fast 5/9/15 EMA ribbon stacking, fresh crossovers, and compression squeezes.
6. **[Volatility Analyst](file:///c:/Users/yendh/OneDrive/Desktop/Project/testttai/backend/agents/volatility_analyst.py)** — Grades Bollinger bandwidth percentiles to detect Squeeze vs Expansion regimes.
7. **[Volume Flow Analyst](file:///c:/Users/yendh/OneDrive/Desktop/Project/testttai/backend/agents/volume_flow_analyst.py)** — Measures On-Balance Volume (OBV) accumulation, 20-bar VWAP, and volume divergence.
8. **[MTF Trend Analyst](file:///c:/Users/yendh/OneDrive/Desktop/Project/testttai/backend/agents/mtf_trend_analyst.py)** — Resamples candles to weekly (`'W'`) to enforce higher-timeframe trend alignment.
9. **[Strategy Judge](file:///c:/Users/yendh/OneDrive/Desktop/Project/testttai/backend/agents/strategy_judge.py)** — Evaluates 12 quantitative institutional strategies (SMC, ICT, Wyckoff, Price Action, Supply/Demand, 4-EMA, BB Breakout, Fibonacci, CVD Order Flow, Z-Score, SuperTrend, HMA) to form mathematical consensus.
10. **[Risk Planner](file:///c:/Users/yendh/OneDrive/Desktop/Project/testttai/backend/agents/risk_planner.py)** — Enforces 1% equity risk cap, 1:2 Risk-to-Reward ratio, S/R stop placement, and sentiment vetoes.
11. **[Execution Agent](file:///c:/Users/yendh/OneDrive/Desktop/Project/testttai/backend/agents/execution_agent.py)** — Order-desk agent monitoring pending trades and canceling stale orders ($>2\%$ price drift).
12. **[Portfolio Monitor](file:///c:/Users/yendh/OneDrive/Desktop/Project/testttai/backend/agents/portfolio_monitor.py)** — Mark-to-market P&L tracker, automatic break-even trailing stop adjustment ($+1.5\%$ profit), and SL/Target exit execution.

---

## 🧪 Testing

```powershell
# Run the 12-agent pipeline diagnostic
python test_pipeline.py

# Test WebSocket real-time event streaming
python test_ws.py
```
