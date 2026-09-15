/**
 * ORBIT Trading Terminal — Trade Agent Terminal
 *
 * Starts and stops the ai-service's 12-agent pipeline over the private /ws
 * channel ({"action": "start", "asset"} / {"action": "stop"}) and renders what
 * it streams back: live price legend, support/resistance levels, the trade
 * proposal awaiting confirmation, agent metrics, pipeline status, and the
 * symbol's news ticker.
 */

import { store, PendingSignal } from "../state/store";
import { marketService } from "../services/marketService";
import { esc, formatINR, formatINRSafe } from "../utils/formatters";
import { getElement, safeText } from "../utils/dom";
import { initChart, drawChartOverlay } from "./terminalController";
import { logToTerminal } from "./autoBotController";
import { fetchSymbolNews, stopSymbolNewsRefresh } from "./newsController";

let terminalAsset: string | null = null;
let searchTimer: number | undefined;

type Msg = any;

function overlayWindow(): { lastSupports?: number[]; lastResistances?: number[]; lastLiquidity?: number[] } {
    return window as any;
}

// ---------------------------------------------------------------------------
// Price legend
// ---------------------------------------------------------------------------

export function updateLegend(price: number, changePercent: number): void {
    const cls = changePercent >= 0 ? "legend-val text-green" : "legend-val text-red";
    const priceEl = getElement("legend-price");
    if (priceEl) {
        priceEl.textContent = formatINR(price);
        priceEl.className = cls;
    }
    const changeEl = getElement("legend-change");
    if (changeEl) {
        changeEl.textContent = `${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%`;
        changeEl.className = cls;
    }
}

/** Real quote ticks (terminal pipeline or the public tick stream), filtered to the active asset. */
export function handleTick(msg: Msg): void {
    if (!terminalAsset) return;
    const symbol = typeof msg.symbol === "string" ? msg.symbol.toUpperCase() : terminalAsset;
    if (symbol !== terminalAsset) return;
    const price = Number(msg.candle?.close ?? msg.data?.price);
    if (!Number.isFinite(price) || price <= 0) return;
    updateLegend(price, Number(msg.changePercent ?? msg.data?.change_percent ?? 0));
}

/** The pipeline's opening OHLCV snapshot. */
export function handleHistory(msg: Msg): void {
    if (!terminalAsset || !Array.isArray(msg.candles) || !msg.candles.length) return;
    const last = msg.candles[msg.candles.length - 1];
    updateLegend(Number(last.close), Number(msg.changePercent || 0));
}

// ---------------------------------------------------------------------------
// Support / resistance
// ---------------------------------------------------------------------------

function renderSRPanel(): void {
    const panel = getElement("sr-levels-panel");
    if (!panel) return;
    if (!store.get("showSRLevels")) {
        panel.classList.add("hidden");
        return;
    }
    panel.classList.remove("hidden");
    const w = overlayWindow();
    const badges = (levels: number[] | undefined, cls: string) =>
        levels && levels.length
            ? levels.map((p) => `<span class="sr-badge ${cls}">${esc(formatINR(p))}</span>`).join("")
            : "<span class='sr-badge sr-none'>—</span>";
    const sup = getElement("sr-support-list");
    if (sup) sup.innerHTML = badges(w.lastSupports, "sr-support");
    const res = getElement("sr-resistance-list");
    if (res) res.innerHTML = badges(w.lastResistances, "sr-resistance");
}

export function handleLevels(msg: Msg): void {
    const w = overlayWindow();
    w.lastSupports = Array.isArray(msg.supports) ? msg.supports : [];
    w.lastResistances = Array.isArray(msg.resistances) ? msg.resistances : [];
    w.lastLiquidity = Array.isArray(msg.liquidity) ? msg.liquidity : [];
    store.set("showSRLevels", true);
    getElement("btn-draw-sr")?.classList.add("active-btn");
    renderSRPanel();
    drawChartOverlay();
}

function toggleSRLevels(): void {
    const showLevels = !store.get("showSRLevels");
    store.set("showSRLevels", showLevels);
    getElement("btn-draw-sr")?.classList.toggle("active-btn", showLevels);
    renderSRPanel();
    drawChartOverlay(!showLevels);
    logToTerminal("SYSTEM", showLevels ? "Displaying Support and Resistance levels on chart." : "Hiding Support and Resistance levels.");
}

// ---------------------------------------------------------------------------
// Trade proposal (confirmation required)
// ---------------------------------------------------------------------------

export function handleSignal(msg: Msg): void {
    const entry = Number(msg.entry), sl = Number(msg.sl), target = Number(msg.target);
    if (!(entry > 0 && sl > 0 && target > 0)) return;
    const signal: PendingSignal = {
        trade_id: typeof msg.trade_id === "number" ? msg.trade_id : null,
        direction: String(msg.direction || (entry > sl ? "buy" : "sell")),
        entry, sl, target,
        quantity: typeof msg.quantity === "number" ? msg.quantity : undefined,
        capital_required: typeof msg.capital_required === "number" ? msg.capital_required : undefined,
        max_risk: typeof msg.max_risk === "number" ? msg.max_risk : undefined
    };
    store.set("pendingSignal", signal);

    const risk = Math.abs(entry - sl);
    const reward = Math.abs(target - entry);
    const rr = risk > 0 ? `${(reward / risk).toFixed(2)} : 1` : "—";
    const dir = signal.direction.toUpperCase();

    getElement("signal-levels-panel")?.classList.remove("hidden");
    safeText(getElement("signal-entry"), formatINR(entry));
    safeText(getElement("signal-sl"), formatINR(sl));
    safeText(getElement("signal-target"), formatINR(target));
    safeText(getElement("signal-rr"), rr);

    const dirEl = getElement("tc-direction");
    if (dirEl) {
        dirEl.textContent = dir;
        dirEl.className = "tc-val " + (dir === "BUY" ? "text-green" : "text-red");
    }
    safeText(getElement("tc-entry"), formatINR(entry));
    safeText(getElement("tc-sl"), formatINR(sl));
    safeText(getElement("tc-target"), formatINR(target));
    safeText(getElement("tc-rr"), rr);
    safeText(getElement("tc-capital"), formatINRSafe(signal.capital_required ?? (signal.quantity ? signal.quantity * entry : undefined)));
    safeText(getElement("tc-max-risk"), formatINRSafe(signal.max_risk ?? (signal.quantity ? risk * signal.quantity : undefined)));
    getElement("trade-confirm-modal")?.classList.remove("hidden");

    logToTerminal("Risk Planner", `📋 Trade confirmation required: ${dir} @ Entry ${formatINR(entry)} | SL ${formatINR(sl)} | TP ${formatINR(target)}`);
}

function clearSignal(): void {
    store.set("pendingSignal", null);
    getElement("signal-levels-panel")?.classList.add("hidden");
    getElement("trade-confirm-modal")?.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Agent metrics and pipeline status
// ---------------------------------------------------------------------------

export function handleMetrics(msg: Msg): void {
    if (msg.consensus && msg.consensus.signal) {
        const sig = String(msg.consensus.signal).toUpperCase();
        const el = getElement("overview-consensus-status");
        if (el) {
            el.textContent = sig;
            el.className = sig === "BUY" || sig === "BULLISH" ? "text-green" : sig === "SELL" || sig === "BEARISH" ? "text-red" : sig === "MIXED" ? "text-yellow" : "text-blue";
        }
    }
    if (typeof msg.sentiment === "number") {
        const s = msg.sentiment;
        const el = getElement("overview-sentiment-status");
        if (el) {
            el.textContent = s > 0.15 ? "BULLISH" : s < -0.15 ? "BEARISH" : "NEUTRAL";
            el.className = s > 0.15 ? "text-green" : s < -0.15 ? "text-red" : "text-cyan";
        }
    }
    if (msg.trend && typeof msg.trend.strength === "string") {
        const strength: string = msg.trend.strength;
        const el = getElement("overview-trend-status");
        if (el) {
            el.textContent = strength.toUpperCase();
            el.className = strength.includes("uptrend") ? "text-green" : strength.includes("downtrend") ? "text-red" : "text-yellow";
        }
    }
}

export function setAnalyzingMode(isAnalyzing: boolean): void {
    const analyzeBtn = getElement<HTMLButtonElement>("initialize-agents-btn");
    if (analyzeBtn) analyzeBtn.disabled = isAnalyzing;
    const stopBtn = getElement<HTMLButtonElement>("stop-btn");
    if (stopBtn) stopBtn.disabled = !isAnalyzing;
    const input = getElement<HTMLInputElement>("terminal-asset-input");
    if (input) input.disabled = isAnalyzing;
    const tradeBtn = getElement<HTMLButtonElement>("trade-through-agent-btn");
    if (tradeBtn) tradeBtn.disabled = isAnalyzing;
    const status = getElement("system-status");
    if (status) status.innerHTML = `<span class="status-dot green-glow"></span> ${isAnalyzing ? "ANALYZING" : "ONLINE"}`;
    safeText(getElement("atv-status-label"), isAnalyzing ? "AI Crew Active" : "AI Crew Ready");
}

export function handleSystemStatus(msg: Msg): void {
    setAnalyzingMode(msg.status === "running");
}

function resetAgentTicks(): void {
    document.querySelectorAll(".agent-row").forEach((row) => {
        row.classList.remove("active-agent", "completed-agent");
        const statusEl = row.querySelector(".agent-row-status");
        if (statusEl) statusEl.textContent = "Waiting…";
    });
    getElement("atv-progress-wrap")?.classList.add("hidden");
    const bar = getElement("atv-progress-bar");
    if (bar) bar.style.width = "0%";
}

// ---------------------------------------------------------------------------
// Pipeline lifecycle
// ---------------------------------------------------------------------------

/** Switches the terminal to one asset and launches the agent crew on it. */
export function prepareTradeEnvironment(rawSymbol: string): void {
    const symbol = (rawSymbol || "").trim().toUpperCase();
    if (!symbol) return;
    terminalAsset = symbol;
    store.set("currentAsset", symbol);

    safeText(getElement("current-asset-title"), `${symbol} Real-Time Chart`);
    safeText(getElement("active-ticker-display"), symbol);
    safeText(getElement("legend-price"), "—");
    safeText(getElement("legend-change"), "");
    getElement("terminal-stock-select-view")?.classList.add("hidden-tab");
    getElement("terminal-active-trading-view")?.classList.remove("hidden-tab");

    resetAgentTicks();
    clearSignal();
    const w = overlayWindow();
    w.lastSupports = [];
    w.lastResistances = [];
    w.lastLiquidity = [];
    store.set("showSRLevels", false);
    getElement("btn-draw-sr")?.classList.remove("active-btn");
    renderSRPanel();
    drawChartOverlay(true);

    initChart(symbol);
    fetchSymbolNews(symbol);
    logToTerminal("SYSTEM", `Environment ready for ${symbol}. Launching AI Crew...`);
    window.setTimeout(runAgentCrew, 400);
}

/** Starts (or restarts) the pipeline for the active asset. */
export function runAgentCrew(): void {
    if (!terminalAsset) return;
    getElement("atv-progress-wrap")?.classList.remove("hidden");
    if (store.sockets.send({ action: "start", asset: terminalAsset })) {
        logToTerminal("SYSTEM", `Launching AI pipeline for ${terminalAsset}...`);
        setAnalyzingMode(true);
        return;
    }
    logToTerminal("SYSTEM", "The live connection to the ORBIT engine is not open yet; retrying...");
    const asset = terminalAsset;
    window.setTimeout(() => {
        if (terminalAsset === asset && store.sockets.isPrimaryOpen()) runAgentCrew();
        else if (terminalAsset === asset) logToTerminal("SYSTEM", "Could not reach the ORBIT engine. Check the connection and press Trade Through Agent.");
    }, 2500);
}

/** Stops the pipeline and returns to asset selection. Open positions are untouched. */
export function stopAgentCrew(): void {
    store.sockets.send({ action: "stop" });
    logToTerminal("SYSTEM", "Stopping active agent pipeline.");
    setAnalyzingMode(false);
    terminalAsset = null;
    clearSignal();
    stopSymbolNewsRefresh();
    window.setTimeout(() => {
        getElement("terminal-active-trading-view")?.classList.add("hidden-tab");
        getElement("terminal-stock-select-view")?.classList.remove("hidden-tab");
        store.set("showSRLevels", false);
        getElement("btn-draw-sr")?.classList.remove("active-btn");
        renderSRPanel();
    }, 300);
}

// ---------------------------------------------------------------------------
// Asset search (GET /api/market/search)
// ---------------------------------------------------------------------------

function hideSuggestions(): void {
    getElement("ticker-suggestions")?.classList.add("hidden");
}

function onAssetInput(input: HTMLInputElement): void {
    window.clearTimeout(searchTimer);
    const box = getElement("ticker-suggestions");
    const q = input.value.trim();
    if (!box || !q) {
        hideSuggestions();
        return;
    }
    searchTimer = window.setTimeout(async () => {
        try {
            const results = await marketService.searchSymbols(q);
            if (!results.length || input.value.trim() !== q) {
                if (!results.length) hideSuggestions();
                return;
            }
            box.innerHTML = results.slice(0, 8).map((r) => `
                <div class="suggestion-item" data-ticker="${esc(r.symbol)}">
                    <strong>${esc(r.symbol)}</strong>
                    <span>${esc(r.name)}</span>
                    <span>${esc(r.exchange || r.type || "")}</span>
                </div>`).join("");
            box.classList.remove("hidden");
            box.querySelectorAll<HTMLElement>(".suggestion-item").forEach((item) => {
                item.addEventListener("click", () => {
                    const ticker = item.getAttribute("data-ticker") || "";
                    input.value = ticker;
                    hideSuggestions();
                    prepareTradeEnvironment(ticker);
                });
            });
        } catch {
            hideSuggestions();
        }
    }, 250);
}

export function initTerminalAgentListeners(): void {
    const input = getElement<HTMLInputElement>("terminal-asset-input");
    getElement("initialize-agents-btn")?.addEventListener("click", () => prepareTradeEnvironment(input?.value || ""));
    if (input) {
        input.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter") {
                e.preventDefault();
                hideSuggestions();
                prepareTradeEnvironment(input.value);
            } else if (e.key === "Escape") {
                hideSuggestions();
            }
        });
        input.addEventListener("input", () => onAssetInput(input));
    }
    document.querySelectorAll<HTMLElement>(".quick-pick-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            const ticker = btn.getAttribute("data-ticker");
            if (!ticker) return;
            if (input) input.value = ticker;
            prepareTradeEnvironment(ticker);
        });
    });
    getElement("stop-btn")?.addEventListener("click", stopAgentCrew);
    getElement("btn-draw-sr")?.addEventListener("click", toggleSRLevels);
    getElement("trade-through-agent-btn")?.addEventListener("click", runAgentCrew);
    document.addEventListener("click", (e: MouseEvent) => {
        const box = getElement("ticker-suggestions");
        const target = e.target as Node | null;
        if (box && target && !box.contains(target) && !(input && input.contains(target))) hideSuggestions();
    });
}
