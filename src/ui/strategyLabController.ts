/**
 * ORBIT AI Strategy Lab — frontend controller.
 *
 * Describe a strategy in plain English, pick a market/asset/timeframe/period,
 * see exactly what ORBIT understood, then backtest it against real historical
 * candles.
 *
 * Every call goes through the shared apiClient to /api/strategy-lab/*, so the
 * Go gateway authenticates it and scopes it to the signed-in account exactly
 * like every other ORBIT request. Nothing here can open a real trade: the
 * endpoints it talks to are simulation-only.
 */

import { apiClient, unwrapData, ApiError } from "../services/apiClient";
import { getElement, safeText } from "../utils/dom";
import { esc } from "../utils/formatters";

// ---------------------------------------------------------------------------
// Types (mirrors of the ai-service contracts)
// ---------------------------------------------------------------------------

interface SupportedIndicator {
    name: string;
    label: string;
    fields: string[];
    default_period: number;
    period_range: number[];
}

interface MarketOption {
    value: string;
    label: string;
    search_market: string;
    examples: string[];
}

interface TimeframeOption {
    value: string;
    label: string;
    max_lookback_days: number;
}

interface PeriodOption {
    value: string;
    label: string;
    days: number | null;
}

interface SupportedPayload {
    vocabulary: { indicators: SupportedIndicator[]; operators: string[]; timeframes: string[] };
    markets: MarketOption[];
    timeframes: TimeframeOption[];
    periods: PeriodOption[];
    capital: { min: number; max: number; default: number };
    execution_model: Record<string, string>;
    examples: string[];
}

interface Understanding {
    strategy_name: string;
    direction: string;
    entry: { logic: string; conditions: string[] };
    exit: { logic: string; conditions: string[] };
    risk: string[];
}

interface InterpretPayload {
    status: "ok" | "needs_clarification" | "unsupported" | "error";
    message: string;
    questions: string[];
    suggestions: string[];
    unsupported: string[];
    issues: string[];
    strategy?: Record<string, unknown>;
    understanding?: Understanding;
}

interface BacktestMetrics {
    [key: string]: number | string | string[] | null;
}

interface BacktestTrade {
    trade_id: number;
    symbol: string;
    side: string;
    entry_time: string;
    exit_time: string | null;
    entry_price: number;
    exit_price: number | null;
    quantity: number;
    pnl: number;
    pnl_percent: number;
    exit_reason: string;
}

interface BacktestPayload {
    backtest_id?: number | null;
    persistence_error?: string;
    symbol: string;
    market: string;
    timeframe: string;
    start_date: string;
    end_date: string;
    initial_capital: number;
    metrics: BacktestMetrics;
    trades: BacktestTrade[];
    equity_curve: { time: string; equity: number }[];
    execution_model: Record<string, string | number>;
    understanding: Understanding;
    strategy: Record<string, unknown>;
    data: { source: string; candles: number; notes: string[]; timeframe_label: string };
    cached: boolean;
}

interface SearchResult {
    symbol: string;
    name?: string;
    exchange?: string;
    region?: string;
}

interface HistoryRow {
    id: number;
    strategy_name: string;
    symbol: string;
    timeframe: string;
    initial_capital: number;
    created_at: string;
    metrics: BacktestMetrics;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let supported: SupportedPayload | null = null;
let currentStrategy: Record<string, unknown> | null = null;
let currentUnderstanding: Understanding | null = null;
let lastResult: BacktestPayload | null = null;
let initialized = false;
let interpreting = false;
let backtesting = false;
let searchTimer: number | null = null;

const el = getElement;

function setBusy(id: string, busy: boolean, idleHtml: string, busyHtml: string): void {
    const button = el<HTMLButtonElement>(id);
    if (!button) return;
    button.disabled = busy;
    button.innerHTML = busy ? busyHtml : idleHtml;
}

function money(value: number | null | undefined, currency = "$"): string {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    const num = Number(value);
    const sign = num < 0 ? "-" : "";
    return sign + currency + Math.abs(num).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function pct(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    return Number(value).toFixed(2) + "%";
}

function num(value: unknown): string {
    if (value === null || value === undefined || value === "" || Number.isNaN(Number(value))) return "—";
    return String(value);
}

function when(iso: string | null): string {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return esc(iso);
    return date.toLocaleString(undefined, {
        year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit"
    });
}

function showStatus(message: string, kind: "info" | "error" | "success" = "info"): void {
    const box = el("slab-status");
    if (!box) return;
    if (!message) {
        box.className = "slab-status hidden";
        box.innerHTML = "";
        return;
    }
    const icon = kind === "error" ? "fa-triangle-exclamation"
        : kind === "success" ? "fa-circle-check" : "fa-circle-info";
    box.className = "slab-status slab-status-" + kind;
    box.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${esc(message)}</span>`;
}

function errorText(err: unknown): string {
    if (err instanceof ApiError) return err.message;
    if (err instanceof Error) return err.message;
    return "Something went wrong. Please try again.";
}

// ---------------------------------------------------------------------------
// Capability bootstrap
// ---------------------------------------------------------------------------

/** Loads what the Lab supports and fills the selectors. Runs once. */
export async function initStrategyLab(): Promise<void> {
    if (initialized) {
        void loadStrategyLabHistory();
        return;
    }
    initialized = true;
    try {
        const res = await apiClient.get<{ ok: boolean; data: SupportedPayload }>("/api/strategy-lab/supported");
        supported = unwrapData(res);
    } catch (err) {
        initialized = false;
        showStatus("Could not load the Strategy Lab: " + errorText(err), "error");
        return;
    }

    const marketSelect = el<HTMLSelectElement>("slab-market");
    if (marketSelect) {
        marketSelect.innerHTML = supported.markets
            .map((m) => `<option value="${esc(m.value)}">${esc(m.label)}</option>`)
            .join("");
    }
    const tfSelect = el<HTMLSelectElement>("slab-timeframe");
    if (tfSelect) {
        tfSelect.innerHTML = supported.timeframes
            .map((t) => `<option value="${esc(t.value)}"${t.value === "1d" ? " selected" : ""}>${esc(t.label)}</option>`)
            .join("");
    }
    const periodSelect = el<HTMLSelectElement>("slab-period");
    if (periodSelect) {
        periodSelect.innerHTML = supported.periods
            .map((p) => `<option value="${esc(p.value)}"${p.value === "1y" ? " selected" : ""}>${esc(p.label)}</option>`)
            .join("");
    }
    const capital = el<HTMLInputElement>("slab-capital");
    if (capital && !capital.value) capital.value = String(supported.capital.default);

    renderSupportedVocabulary();
    renderExamples();
    onStrategyLabMarketChange();
    void loadStrategyLabHistory();
}

function renderSupportedVocabulary(): void {
    const box = el("slab-supported-list");
    if (!box || !supported) return;
    box.innerHTML = supported.vocabulary.indicators
        .map((i) => `<span class="slab-chip" title="${esc(i.label)}">${esc(i.name)}</span>`)
        .join("");
}

function renderExamples(): void {
    const box = el("slab-examples");
    if (!box || !supported) return;
    box.innerHTML = supported.examples
        .map((text) => `<button type="button" class="slab-example" data-example="${esc(text)}">${esc(text)}</button>`)
        .join("");
    box.querySelectorAll<HTMLButtonElement>(".slab-example").forEach((button) => {
        button.addEventListener("click", () => {
            const input = el<HTMLTextAreaElement>("slab-description");
            if (input) {
                input.value = button.getAttribute("data-example") || "";
                input.focus();
            }
        });
    });
}

// ---------------------------------------------------------------------------
// Market & asset selection
// ---------------------------------------------------------------------------

/** Swaps the example assets when the market changes. */
export function onStrategyLabMarketChange(): void {
    const market = el<HTMLSelectElement>("slab-market")?.value || "crypto";
    const option = supported?.markets.find((m) => m.value === market);
    const box = el("slab-asset-examples");
    if (!box || !option) return;
    box.innerHTML = option.examples
        .map((s) => `<button type="button" class="slab-chip slab-chip-btn" data-symbol="${esc(s)}">${esc(s)}</button>`)
        .join("");
    box.querySelectorAll<HTMLButtonElement>(".slab-chip-btn").forEach((button) => {
        button.addEventListener("click", () => selectStrategyLabAsset(button.getAttribute("data-symbol") || ""));
    });
}

/** Debounced symbol search against the existing /api/market/search endpoint. */
export function onStrategyLabAssetInput(value: string): void {
    if (searchTimer) window.clearTimeout(searchTimer);
    const query = (value || "").trim();
    const results = el("slab-asset-results");
    if (!results) return;
    if (query.length < 2) {
        results.innerHTML = "";
        results.classList.add("hidden");
        return;
    }
    searchTimer = window.setTimeout(async () => {
        const market = el<HTMLSelectElement>("slab-market")?.value || "crypto";
        const searchMarket = supported?.markets.find((m) => m.value === market)?.search_market || "";
        try {
            const res = await apiClient.get<{ ok: boolean; results: SearchResult[] }>(
                `/api/market/search?q=${encodeURIComponent(query)}&market=${encodeURIComponent(searchMarket)}`
            );
            const rows = (res.results || []).slice(0, 8);
            if (!rows.length) {
                results.innerHTML = `<div class="slab-asset-empty">No matching symbol.</div>`;
            } else {
                results.innerHTML = rows
                    .map((r) => `<button type="button" class="slab-asset-row" data-symbol="${esc(r.symbol)}">
                        <strong>${esc(r.symbol)}</strong>
                        <span>${esc(r.name || r.exchange || "")}</span>
                    </button>`)
                    .join("");
                results.querySelectorAll<HTMLButtonElement>(".slab-asset-row").forEach((button) => {
                    button.addEventListener("click", () =>
                        selectStrategyLabAsset(button.getAttribute("data-symbol") || ""));
                });
            }
            results.classList.remove("hidden");
        } catch {
            results.innerHTML = `<div class="slab-asset-empty">Symbol search is unavailable right now.</div>`;
            results.classList.remove("hidden");
        }
    }, 260);
}

export function selectStrategyLabAsset(symbol: string): void {
    const input = el<HTMLInputElement>("slab-asset");
    if (input) input.value = symbol;
    const results = el("slab-asset-results");
    if (results) {
        results.innerHTML = "";
        results.classList.add("hidden");
    }
}

/** Shows the custom date inputs only for the custom period. */
export function onStrategyLabPeriodChange(): void {
    const custom = el<HTMLSelectElement>("slab-period")?.value === "custom";
    el("slab-custom-range")?.classList.toggle("hidden", !custom);
}

// ---------------------------------------------------------------------------
// Step 1 — interpretation
// ---------------------------------------------------------------------------

/** Sends the description to ORBIT and renders what it understood. */
export async function generateStrategy(): Promise<void> {
    if (interpreting) return;
    const description = el<HTMLTextAreaElement>("slab-description")?.value.trim() || "";
    if (!description) {
        showStatus("Describe your strategy first.", "error");
        return;
    }
    interpreting = true;
    showStatus("");
    setBusy("slab-generate-btn", true,
        `<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Strategy`,
        `<i class="fa-solid fa-circle-notch fa-spin"></i> Reading your strategy…`);
    el("slab-understanding")?.classList.add("hidden");
    el("slab-clarify")?.classList.add("hidden");

    try {
        const res = await apiClient.post<{ ok: boolean; data: InterpretPayload }>("/api/strategy-lab/interpret", {
            description,
            symbol: el<HTMLInputElement>("slab-asset")?.value || "",
            market: el<HTMLSelectElement>("slab-market")?.value || "",
            timeframe: el<HTMLSelectElement>("slab-timeframe")?.value || ""
        });
        const data = unwrapData(res);
        if (data.status === "ok" && data.strategy && data.understanding) {
            currentStrategy = data.strategy;
            currentUnderstanding = data.understanding;
            renderUnderstanding(data.understanding);
            showStatus("Strategy understood. Review it, then run the backtest.", "success");
        } else if (data.status === "error") {
            showStatus(data.message, "error");
        } else {
            currentStrategy = null;
            renderClarification(data);
        }
    } catch (err) {
        showStatus(errorText(err), "error");
    } finally {
        interpreting = false;
        setBusy("slab-generate-btn", false,
            `<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Strategy`, "");
    }
}

function renderUnderstanding(u: Understanding): void {
    const box = el("slab-understanding");
    if (!box) return;
    const list = (items: string[], icon: string) =>
        items.length
            ? items.map((c) => `<li><i class="fa-solid ${icon}"></i> ${esc(c)}</li>`).join("")
            : `<li class="slab-muted">None</li>`;

    box.innerHTML = `
        <div class="slab-understood-head">
            <h3><i class="fa-solid fa-clipboard-check text-emerald"></i> What ORBIT Understood</h3>
            <span class="slab-strategy-name">${esc(u.strategy_name)}</span>
        </div>
        <div class="slab-understood-grid">
            <div class="slab-rule-card">
                <div class="slab-rule-title">Entry Conditions
                    <span class="slab-logic">${esc(u.entry.logic)}</span></div>
                <ul class="slab-rule-list">${list(u.entry.conditions, "fa-check")}</ul>
            </div>
            <div class="slab-rule-card">
                <div class="slab-rule-title">Exit Conditions
                    <span class="slab-logic">${esc(u.exit.logic)}</span></div>
                <ul class="slab-rule-list">${list(u.exit.conditions, "fa-check")}</ul>
            </div>
            <div class="slab-rule-card">
                <div class="slab-rule-title">Risk Management</div>
                <ul class="slab-rule-list">${list(u.risk, "fa-shield-halved")}</ul>
            </div>
        </div>
        <div class="slab-understood-actions">
            <button type="button" class="glow-btn btn-secondary" id="slab-edit-btn">
                <i class="fa-solid fa-pen-to-square"></i> Edit Strategy
            </button>
            <button type="button" class="glow-btn btn-primary" id="slab-run-btn">
                <i class="fa-solid fa-play"></i> Run Backtest
            </button>
        </div>
        <div class="slab-editor hidden" id="slab-editor">
            <label for="slab-editor-json">Strategy definition (validated before it runs)</label>
            <textarea id="slab-editor-json" spellcheck="false" rows="14"></textarea>
            <div class="slab-editor-actions">
                <button type="button" class="glow-btn btn-secondary" id="slab-editor-cancel">Cancel</button>
                <button type="button" class="glow-btn btn-primary" id="slab-editor-apply">
                    <i class="fa-solid fa-check"></i> Validate &amp; Apply
                </button>
            </div>
            <div class="slab-editor-issues hidden" id="slab-editor-issues"></div>
        </div>`;
    box.classList.remove("hidden");

    el("slab-run-btn")?.addEventListener("click", () => void runStrategyBacktest());
    el("slab-edit-btn")?.addEventListener("click", openStrategyEditor);
    el("slab-editor-cancel")?.addEventListener("click", () => el("slab-editor")?.classList.add("hidden"));
    el("slab-editor-apply")?.addEventListener("click", () => void applyStrategyEdit());
}

function renderClarification(data: InterpretPayload): void {
    const box = el("slab-clarify");
    if (!box) return;
    const questions = data.questions.length
        ? `<ul class="slab-question-list">${data.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>`
        : "";
    const unsupported = data.unsupported.length
        ? `<div class="slab-unsupported">
             <strong>Not supported yet:</strong>
             ${data.unsupported.map((u) => `<span class="slab-chip slab-chip-warn">${esc(u)}</span>`).join("")}
           </div>`
        : "";
    const suggestions = data.suggestions.length
        ? `<div class="slab-suggestions">
             <span class="slab-muted">Try one of these:</span>
             ${data.suggestions.map((s) =>
                `<button type="button" class="slab-suggestion" data-text="${esc(s)}">${esc(s)}</button>`).join("")}
           </div>`
        : "";

    box.innerHTML = `
        <div class="slab-clarify-head">
            <i class="fa-solid fa-circle-question"></i>
            <div>
                <h3>ORBIT needs a bit more detail</h3>
                <p>${esc(data.message)}</p>
            </div>
        </div>
        ${unsupported}
        ${questions}
        ${suggestions}`;
    box.classList.remove("hidden");

    box.querySelectorAll<HTMLButtonElement>(".slab-suggestion").forEach((button) => {
        button.addEventListener("click", () => {
            const input = el<HTMLTextAreaElement>("slab-description");
            if (!input) return;
            const addition = button.getAttribute("data-text") || "";
            input.value = (input.value.trim() + " " + addition).trim();
            input.focus();
        });
    });
}

// ---------------------------------------------------------------------------
// Manual editing — still validated server-side before anything runs
// ---------------------------------------------------------------------------

function openStrategyEditor(): void {
    const editor = el("slab-editor");
    const textarea = el<HTMLTextAreaElement>("slab-editor-json");
    if (!editor || !textarea || !currentStrategy) return;
    textarea.value = JSON.stringify(currentStrategy, null, 2);
    editor.classList.remove("hidden");
}

async function applyStrategyEdit(): Promise<void> {
    const textarea = el<HTMLTextAreaElement>("slab-editor-json");
    const issues = el("slab-editor-issues");
    if (!textarea || !issues) return;
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(textarea.value);
    } catch (err) {
        issues.innerHTML = `<strong>That is not valid JSON.</strong> ${esc(errorText(err))}`;
        issues.classList.remove("hidden");
        return;
    }
    try {
        const res = await apiClient.post<{ ok: boolean; data: any }>("/api/strategy-lab/validate", { strategy: parsed });
        const data = unwrapData(res);
        if (!data.valid) {
            issues.innerHTML = `<strong>${esc(data.message)}</strong><ul>${(data.issues || [])
                .map((i: string) => `<li>${esc(i)}</li>`).join("")}</ul>`;
            issues.classList.remove("hidden");
            return;
        }
        currentStrategy = data.strategy;
        currentUnderstanding = data.understanding;
        issues.classList.add("hidden");
        renderUnderstanding(data.understanding);
        showStatus("Edited strategy validated.", "success");
    } catch (err) {
        issues.innerHTML = `<strong>${esc(errorText(err))}</strong>`;
        issues.classList.remove("hidden");
    }
}

// ---------------------------------------------------------------------------
// Step 2 — backtest
// ---------------------------------------------------------------------------

export async function runStrategyBacktest(): Promise<void> {
    if (backtesting) return;
    if (!currentStrategy) {
        showStatus("Generate a strategy before running a backtest.", "error");
        return;
    }
    const symbol = el<HTMLInputElement>("slab-asset")?.value.trim().toUpperCase() || "";
    if (!symbol) {
        showStatus("Choose an asset to backtest.", "error");
        return;
    }
    const period = el<HTMLSelectElement>("slab-period")?.value || "1y";
    const body: Record<string, unknown> = {
        strategy: currentStrategy,
        symbol,
        market: el<HTMLSelectElement>("slab-market")?.value || "crypto",
        timeframe: el<HTMLSelectElement>("slab-timeframe")?.value || "1d",
        period,
        initial_capital: Number(el<HTMLInputElement>("slab-capital")?.value || 10000),
        commission_percent: Number(el<HTMLInputElement>("slab-commission")?.value || 0),
        description: el<HTMLTextAreaElement>("slab-description")?.value.trim() || ""
    };
    if (period === "custom") {
        body.start_date = el<HTMLInputElement>("slab-start-date")?.value || "";
        body.end_date = el<HTMLInputElement>("slab-end-date")?.value || "";
        if (!body.start_date || !body.end_date) {
            showStatus("A custom range needs both a start and an end date.", "error");
            return;
        }
    }

    backtesting = true;
    showStatus("");
    const runButton = el<HTMLButtonElement>("slab-run-btn");
    if (runButton) {
        runButton.disabled = true;
        runButton.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Running backtest…`;
    }
    el("slab-results")?.classList.add("hidden");

    try {
        const res = await apiClient.post<{ ok: boolean; data: BacktestPayload }>("/api/strategy-lab/backtest", body);
        lastResult = unwrapData(res);
        renderResults(lastResult);
        void loadStrategyLabHistory();
    } catch (err) {
        showStatus(errorText(err), "error");
    } finally {
        backtesting = false;
        if (runButton) {
            runButton.disabled = false;
            runButton.innerHTML = `<i class="fa-solid fa-play"></i> Run Backtest`;
        }
    }
}

function metricTile(label: string, value: string, tone: "" | "pos" | "neg" = ""): string {
    return `<div class="slab-metric ${tone ? "slab-metric-" + tone : ""}">
        <span class="slab-metric-label">${esc(label)}</span>
        <strong class="slab-metric-value">${esc(value)}</strong>
    </div>`;
}

function renderResults(result: BacktestPayload): void {
    const box = el("slab-results");
    if (!box) return;
    const m = result.metrics;
    const netProfit = Number(m.net_profit ?? 0);
    const tone = netProfit > 0 ? "pos" : netProfit < 0 ? "neg" : "";

    const notes = (result.data.notes || []);
    const metricNotes = (m.notes as string[] | undefined) || [];
    const allNotes = notes.concat(metricNotes);

    const exec = result.execution_model || {};
    const trades = result.trades || [];
    const tradeRows = trades.length
        ? trades.slice(0, 200).map((t) => `
            <tr>
                <td class="mono">${t.trade_id}</td>
                <td>${when(t.entry_time)}</td>
                <td>${when(t.exit_time)}</td>
                <td class="mono">${t.entry_price}</td>
                <td class="mono">${t.exit_price ?? "—"}</td>
                <td class="mono">${t.quantity}</td>
                <td class="mono ${t.pnl >= 0 ? "slab-pos" : "slab-neg"}">${money(t.pnl)}</td>
                <td class="mono ${t.pnl >= 0 ? "slab-pos" : "slab-neg"}">${pct(t.pnl_percent)}</td>
                <td><span class="slab-reason slab-reason-${esc(t.exit_reason.toLowerCase())}">${esc(t.exit_reason.replace(/_/g, " "))}</span></td>
            </tr>`).join("")
        : `<tr><td colspan="9" class="slab-muted slab-center">
             This strategy produced no trades over the selected period.
           </td></tr>`;

    box.innerHTML = `
        <div class="slab-results-head">
            <div>
                <h3><i class="fa-solid fa-chart-line text-emerald"></i> Backtest Results</h3>
                <p class="slab-muted">
                    ${esc(result.understanding.strategy_name)} ·
                    <strong>${esc(result.symbol)}</strong> ·
                    ${esc(result.data.timeframe_label)} ·
                    ${when(result.start_date)} → ${when(result.end_date)} ·
                    ${result.data.candles.toLocaleString()} candles from ${esc(result.data.source)}
                    ${result.cached ? ' · <span class="slab-chip">cached</span>' : ""}
                </p>
            </div>
            <div class="slab-results-actions">
                <button type="button" class="glow-btn btn-secondary" id="slab-save-btn">
                    <i class="fa-solid fa-bookmark"></i> Save Strategy
                </button>
                <button type="button" class="glow-btn btn-secondary" id="slab-export-btn">
                    <i class="fa-solid fa-download"></i> Export JSON
                </button>
            </div>
        </div>

        ${allNotes.length ? `<div class="slab-notes">${allNotes
            .map((n) => `<div><i class="fa-solid fa-circle-info"></i> ${esc(n)}</div>`).join("")}</div>` : ""}
        ${result.persistence_error ? `<div class="slab-notes slab-notes-warn">
            <div><i class="fa-solid fa-triangle-exclamation"></i> ${esc(result.persistence_error)}</div></div>` : ""}

        <div class="slab-metrics-grid">
            ${metricTile("Initial Capital", money(Number(m.initial_capital)))}
            ${metricTile("Final Equity", money(Number(m.final_equity)), tone)}
            ${metricTile("Net Profit", money(netProfit), tone)}
            ${metricTile("Net Profit %", pct(m.net_profit_percent as number), tone)}
            ${metricTile("Total Trades", num(m.total_trades))}
            ${metricTile("Win Rate", pct(m.win_rate as number))}
            ${metricTile("Winning Trades", num(m.winning_trades))}
            ${metricTile("Losing Trades", num(m.losing_trades))}
            ${metricTile("Average Win", money(m.average_win as number))}
            ${metricTile("Average Loss", money(m.average_loss as number))}
            ${metricTile("Largest Win", money(m.largest_win as number))}
            ${metricTile("Largest Loss", money(m.largest_loss as number))}
            ${metricTile("Average Trade", money(m.average_trade as number))}
            ${metricTile("Profit Factor", num(m.profit_factor))}
            ${metricTile("Max Drawdown", pct(m.max_drawdown_percent as number), "neg")}
            ${metricTile("Sharpe Ratio", num(m.sharpe_ratio))}
            ${metricTile("Sortino Ratio", num(m.sortino_ratio))}
            ${metricTile("Calmar Ratio", num(m.calmar_ratio))}
        </div>

        <div class="slab-chart-card">
            <div class="slab-chart-head">
                <span>Equity Curve</span>
                <span class="slab-muted">${result.equity_curve.length} plotted points</span>
            </div>
            <canvas id="slab-equity-canvas" height="220"></canvas>
        </div>

        <div class="slab-analysis-card">
            <div class="slab-analysis-head">
                <h4>Trades analysis</h4>
                <div class="slab-tabs">
                    <button type="button" class="slab-tab active" data-tab="distribution">Distribution</button>
                    <button type="button" class="slab-tab" data-tab="streaks">Streaks</button>
                    <button type="button" class="slab-tab" data-tab="time">Time patterns</button>
                </div>
            </div>
            <div class="slab-tabpanel" id="slab-tab-distribution"></div>
            <div class="slab-tabpanel hidden" id="slab-tab-streaks"></div>
            <div class="slab-tabpanel hidden" id="slab-tab-time"></div>
        </div>

        <div class="slab-exec-model">
            <strong>Execution assumptions:</strong>
            signal on ${esc(String(exec.signal_evaluated_on ?? "candle close"))},
            fill at ${esc(String(exec.order_filled_at ?? "next candle open"))},
            ${esc(String(exec.same_candle_stop_and_target ?? ""))},
            ${esc(String(exec.direction ?? "long only"))},
            commission ${esc(String(exec.commission_percent ?? 0))}%.
        </div>

        <div class="slab-trades-card">
            <div class="slab-chart-head">
                <span>Simulated Trades</span>
                <span class="slab-muted">${trades.length} total${trades.length > 200 ? " (showing first 200)" : ""}</span>
            </div>
            <div class="slab-table-scroll">
                <table class="slab-table">
                    <thead><tr>
                        <th>#</th><th>Entry Time</th><th>Exit Time</th><th>Entry</th><th>Exit</th>
                        <th>Qty</th><th>P&amp;L</th><th>P&amp;L %</th><th>Exit Reason</th>
                    </tr></thead>
                    <tbody>${tradeRows}</tbody>
                </table>
            </div>
        </div>`;
    box.classList.remove("hidden");

    el("slab-save-btn")?.addEventListener("click", () => void saveCurrentStrategy());
    el("slab-export-btn")?.addEventListener("click", exportResultJson);
    drawEquityCurve(result.equity_curve);
    renderTradesAnalysis(trades);
    box.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Plain canvas line chart — no new chart dependency for one sparkline. */
function drawEquityCurve(points: { time: string; equity: number }[]): void {
    const canvas = el<HTMLCanvasElement>("slab-equity-canvas");
    if (!canvas || !points.length) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || canvas.parentElement?.clientWidth || 600;
    const height = 220;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = "100%";
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);

    const values = points.map((p) => p.equity);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const padding = { top: 14, right: 12, bottom: 20, left: 58 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;
    const x = (i: number) => padding.left + (i / Math.max(1, points.length - 1)) * plotW;
    const y = (v: number) => padding.top + plotH - ((v - min) / span) * plotH;

    const styles = getComputedStyle(document.documentElement);
    const line = styles.getPropertyValue("--line-soft").trim() || "#141E1A";
    const accent = styles.getPropertyValue("--accent").trim() || "#00E68A";
    const negative = styles.getPropertyValue("--neg").trim() || "#FF4D4D";
    const dim = styles.getPropertyValue("--text-4").trim() || "#55635D";
    const up = values[values.length - 1] >= values[0];
    const stroke = up ? accent : negative;

    // Horizontal gridlines with value labels.
    ctx.strokeStyle = line;
    ctx.fillStyle = dim;
    ctx.lineWidth = 1;
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "right";
    for (let step = 0; step <= 4; step++) {
        const value = min + (span * step) / 4;
        const py = Math.round(y(value)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(padding.left, py);
        ctx.lineTo(width - padding.right, py);
        ctx.stroke();
        ctx.fillText(Math.round(value).toLocaleString(), padding.left - 8, py + 3);
    }

    // Filled area then the line itself.
    ctx.beginPath();
    ctx.moveTo(x(0), y(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(x(i), y(values[i]));
    ctx.lineTo(x(values.length - 1), padding.top + plotH);
    ctx.lineTo(x(0), padding.top + plotH);
    ctx.closePath();
    ctx.fillStyle = up ? "rgba(0, 230, 138, 0.10)" : "rgba(255, 77, 77, 0.10)";
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x(0), y(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(x(i), y(values[i]));
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Start and end dates.
    ctx.fillStyle = dim;
    ctx.textAlign = "left";
    ctx.fillText(String(points[0].time).slice(0, 10), padding.left, height - 6);
    ctx.textAlign = "right";
    ctx.fillText(String(points[points.length - 1].time).slice(0, 10), width - padding.right, height - 6);
}

// ---------------------------------------------------------------------------
// Trades analysis — distribution, streaks and time patterns
// ---------------------------------------------------------------------------
//
// Everything below is derived from the simulated trades already in the
// response. No extra request, and no statistic is shown that the trade list
// cannot actually support: with too few trades a panel says so instead of
// drawing a chart of noise.

let analysisTrades: BacktestTrade[] = [];
let activeAnalysisTab = "distribution";

function mean(values: number[]): number | null {
    if (!values.length) return null;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Linear-interpolated quantile of an already-sorted array. */
function quantile(sorted: number[], q: number): number {
    if (!sorted.length) return 0;
    const position = (sorted.length - 1) * q;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    if (low === high) return sorted[low];
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function themeColors() {
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    return {
        win: read("--pos", "#00E68A"),
        loss: read("--neg", "#FF4D4D"),
        flat: read("--warn", "#F5A524"),
        line: read("--line-soft", "#141E1A"),
        grid: read("--line", "#1A2621"),
        dim: read("--text-4", "#55635D"),
        text: read("--text-2", "#C0C9C4")
    };
}

/** Sizes a canvas for the device pixel ratio and returns a ready 2D context. */
function prepCanvas(id: string, height: number) {
    const canvas = el<HTMLCanvasElement>(id);
    if (!canvas) return null;
    const width = canvas.clientWidth || canvas.parentElement?.clientWidth || 480;
    if (width < 40) return null; // hidden panel: draw when it becomes visible
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = "100%";
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    return { ctx, width, height };
}

function statTile(label: string, primary: string, secondary = "", tone: "" | "pos" | "neg" = "", hint = ""): string {
    return `<div class="slab-astat"${hint ? ` title="${esc(hint)}"` : ""}>
        <span class="slab-astat-label">${esc(label)}</span>
        <span class="slab-astat-value ${tone ? "slab-" + tone : ""}">
            ${esc(primary)}${secondary ? `<em>${esc(secondary)}</em>` : ""}
        </span>
    </div>`;
}

function emptyPanel(message: string): string {
    return `<div class="slab-muted slab-center">${esc(message)}</div>`;
}

export function renderTradesAnalysis(trades: BacktestTrade[]): void {
    analysisTrades = trades || [];
    const head = document.querySelector<HTMLElement>(".slab-analysis-head");
    head?.querySelectorAll<HTMLButtonElement>(".slab-tab").forEach((button) => {
        button.addEventListener("click", () => switchAnalysisTab(button.getAttribute("data-tab") || "distribution"));
    });
    renderDistributionPanel();
    renderStreaksPanel();
    renderTimePanel();
    switchAnalysisTab("distribution");
}

export function switchAnalysisTab(tab: string): void {
    activeAnalysisTab = tab;
    document.querySelectorAll<HTMLButtonElement>(".slab-analysis-head .slab-tab").forEach((button) => {
        button.classList.toggle("active", button.getAttribute("data-tab") === tab);
    });
    for (const name of ["distribution", "streaks", "time"]) {
        el("slab-tab-" + name)?.classList.toggle("hidden", name !== tab);
    }
    // Canvases can only be measured once their panel is visible.
    if (tab === "distribution") {
        drawReturnsHistogram();
        drawTradesDonut();
    } else if (tab === "streaks") {
        drawStreakRibbon();
    } else {
        drawTimeCharts();
    }
}

// ---- Distribution ---------------------------------------------------------

function renderDistributionPanel(): void {
    const panel = el("slab-tab-distribution");
    if (!panel) return;
    if (!analysisTrades.length) {
        panel.innerHTML = emptyPanel("No trades to analyse.");
        return;
    }

    const pnls = analysisTrades.map((t) => t.pnl);
    const pcts = analysisTrades.map((t) => t.pnl_percent);
    const winners = analysisTrades.filter((t) => t.pnl > 0);
    const losers = analysisTrades.filter((t) => t.pnl < 0);
    const breakevens = analysisTrades.filter((t) => t.pnl === 0);

    const expectancy = mean(pnls);
    const expectancyPct = mean(pcts);

    // Tukey fence: a trade further than 1.5 x IQR outside the quartiles is an
    // outlier. Reporting their combined P&L shows how much of the result rests
    // on a handful of exceptional trades.
    const sorted = [...pnls].sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const fence = 1.5 * (q3 - q1);
    const outliers = analysisTrades.filter((t) => t.pnl < q1 - fence || t.pnl > q3 + fence);
    const outlierPnl = outliers.reduce((sum, t) => sum + t.pnl, 0);
    const outlierPct = outliers.reduce((sum, t) => sum + t.pnl_percent, 0);

    const largestWin = winners.length ? Math.max(...winners.map((t) => t.pnl)) : null;
    const largestLoss = losers.length ? Math.min(...losers.map((t) => t.pnl)) : null;
    const avgProfitPct = mean(winners.map((t) => t.pnl_percent));
    const avgLossPct = mean(losers.map((t) => t.pnl_percent));

    const total = analysisTrades.length;
    const share = (count: number) => total ? ((count / total) * 100).toFixed(2) + "%" : "—";

    panel.innerHTML = `
        <div class="slab-astat-row">
            ${statTile("Expectancy", money(expectancy), expectancyPct === null ? "" : pct(expectancyPct),
                (expectancy ?? 0) > 0 ? "pos" : (expectancy ?? 0) < 0 ? "neg" : "",
                "Average result per trade across all " + total + " trades.")}
            ${statTile("Outliers P&L", money(outlierPnl), outliers.length ? pct(outlierPct) : "",
                outlierPnl > 0 ? "pos" : outlierPnl < 0 ? "neg" : "",
                outliers.length
                    ? outliers.length + " trade(s) beyond 1.5x the interquartile range contributed this much."
                    : "No statistical outliers in this run.")}
            ${statTile("Largest profit", money(largestWin), "", "pos")}
            ${statTile("Largest loss", money(largestLoss), "", "neg")}
        </div>

        <div class="slab-analysis-grid">
            <div class="slab-analysis-block">
                <h5>Returns distribution</h5>
                <canvas id="slab-hist-canvas" height="200"></canvas>
                <div class="slab-analysis-legend">
                    <span><i class="slab-dot slab-dot-loss"></i> Losers</span>
                    <span><i class="slab-dot slab-dot-win"></i> Winners</span>
                    <span class="slab-legend-dash slab-neg">--- Average loss
                        <strong>${esc(pct(avgLossPct))}</strong></span>
                    <span class="slab-legend-dash slab-pos">--- Average profit
                        <strong>${esc(pct(avgProfitPct))}</strong></span>
                </div>
            </div>

            <div class="slab-analysis-block">
                <h5>Trades distribution</h5>
                <div class="slab-donut-wrap">
                    <div class="slab-donut-holder">
                        <canvas id="slab-donut-canvas" height="200"></canvas>
                        <div class="slab-donut-center">
                            <strong>${total}</strong>
                            <span>Total trades</span>
                        </div>
                    </div>
                    <ul class="slab-donut-legend">
                        <li><i class="slab-dot slab-dot-win"></i> Winners
                            <b>${winners.length} trades</b> <span>${share(winners.length)}</span></li>
                        <li><i class="slab-dot slab-dot-loss"></i> Losers
                            <b>${losers.length} trades</b> <span>${share(losers.length)}</span></li>
                        <li><i class="slab-dot slab-dot-flat"></i> Breakevens
                            <b>${breakevens.length} trades</b> <span>${share(breakevens.length)}</span></li>
                    </ul>
                </div>
            </div>
        </div>`;
}

function drawReturnsHistogram(): void {
    if (!analysisTrades.length) return;
    const prepared = prepCanvas("slab-hist-canvas", 200);
    if (!prepared) return;
    const { ctx, width, height } = prepared;
    const colors = themeColors();

    const values = analysisTrades.map((t) => t.pnl_percent);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max - min || 1;
    const bins = Math.min(14, Math.max(5, Math.ceil(Math.sqrt(values.length))));
    const step = spread / bins;
    const counts = new Array(bins).fill(0);
    for (const value of values) {
        const index = Math.min(bins - 1, Math.floor((value - min) / step));
        counts[index] += 1;
    }
    const peak = Math.max(...counts) || 1;

    const pad = { top: 12, right: 38, bottom: 26, left: 10 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const xOf = (value: number) => pad.left + ((value - min) / spread) * plotW;

    // Gridlines and count axis on the right, as in a standard histogram.
    ctx.strokeStyle = colors.line;
    ctx.fillStyle = colors.dim;
    ctx.textAlign = "left";
    for (let i = 0; i <= 3; i++) {
        const value = (peak * i) / 3;
        const y = Math.round(pad.top + plotH - (value / peak) * plotH) + 0.5;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(width - pad.right, y);
        ctx.stroke();
        ctx.fillText(String(Math.round(value)), width - pad.right + 6, y + 3);
    }

    const barWidth = Math.max(2, plotW / bins - 3);
    for (let i = 0; i < bins; i++) {
        if (!counts[i]) continue;
        const center = min + step * (i + 0.5);
        const barHeight = (counts[i] / peak) * plotH;
        const x = pad.left + (plotW / bins) * i + 1.5;
        ctx.fillStyle = center < 0 ? colors.loss : colors.win;
        ctx.fillRect(x, pad.top + plotH - barHeight, barWidth, barHeight);
    }

    // Dashed averages for losing and winning trades.
    const drawAverage = (value: number | null, color: string) => {
        if (value === null || !Number.isFinite(value)) return;
        const x = Math.round(xOf(value)) + 0.5;
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, pad.top + plotH);
        ctx.stroke();
        ctx.restore();
    };
    drawAverage(mean(analysisTrades.filter((t) => t.pnl < 0).map((t) => t.pnl_percent)), colors.loss);
    drawAverage(mean(analysisTrades.filter((t) => t.pnl > 0).map((t) => t.pnl_percent)), colors.win);

    // Zero line plus min/max labels.
    if (min < 0 && max > 0) {
        const zero = Math.round(xOf(0)) + 0.5;
        ctx.strokeStyle = colors.grid;
        ctx.beginPath();
        ctx.moveTo(zero, pad.top);
        ctx.lineTo(zero, pad.top + plotH);
        ctx.stroke();
    }
    ctx.fillStyle = colors.dim;
    ctx.textAlign = "left";
    ctx.fillText(min.toFixed(2) + "%", pad.left, height - 8);
    ctx.textAlign = "right";
    ctx.fillText(max.toFixed(2) + "%", width - pad.right, height - 8);
}

function drawTradesDonut(): void {
    if (!analysisTrades.length) return;
    const prepared = prepCanvas("slab-donut-canvas", 200);
    if (!prepared) return;
    const { ctx, width, height } = prepared;
    const colors = themeColors();

    const winners = analysisTrades.filter((t) => t.pnl > 0).length;
    const losers = analysisTrades.filter((t) => t.pnl < 0).length;
    const breakevens = analysisTrades.length - winners - losers;
    const slices = [
        { value: winners, color: colors.win },
        { value: losers, color: colors.loss },
        { value: breakevens, color: colors.flat }
    ].filter((s) => s.value > 0);

    const total = analysisTrades.length;
    const cx = width / 2;
    const cy = height / 2;
    const outer = Math.min(width, height) / 2 - 6;
    const inner = outer * 0.66;

    let angle = -Math.PI / 2;
    for (const slice of slices) {
        const sweep = (slice.value / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, outer, angle, angle + sweep);
        ctx.arc(cx, cy, inner, angle + sweep, angle, true);
        ctx.closePath();
        ctx.fillStyle = slice.color;
        ctx.fill();
        angle += sweep;
    }
}

// ---- Streaks --------------------------------------------------------------

interface Streak { kind: "win" | "loss" | "flat"; length: number; }

function buildStreaks(): Streak[] {
    const streaks: Streak[] = [];
    for (const trade of analysisTrades) {
        const kind: Streak["kind"] = trade.pnl > 0 ? "win" : trade.pnl < 0 ? "loss" : "flat";
        const last = streaks[streaks.length - 1];
        if (last && last.kind === kind) last.length += 1;
        else streaks.push({ kind, length: 1 });
    }
    return streaks;
}

function renderStreaksPanel(): void {
    const panel = el("slab-tab-streaks");
    if (!panel) return;
    if (analysisTrades.length < 2) {
        panel.innerHTML = emptyPanel("At least two trades are needed to measure streaks.");
        return;
    }
    const streaks = buildStreaks();
    const winStreaks = streaks.filter((s) => s.kind === "win").map((s) => s.length);
    const lossStreaks = streaks.filter((s) => s.kind === "loss").map((s) => s.length);
    const current = streaks[streaks.length - 1];
    const currentLabel = current.length + " " +
        (current.kind === "win" ? "win" : current.kind === "loss" ? "loss" : "breakeven") +
        (current.length === 1 ? "" : "s");

    // The worst run of consecutive losses, measured in money.
    let worstRun = 0;
    let running = 0;
    for (const trade of analysisTrades) {
        running = trade.pnl < 0 ? running + trade.pnl : 0;
        worstRun = Math.min(worstRun, running);
    }

    panel.innerHTML = `
        <div class="slab-astat-row">
            ${statTile("Longest win streak", winStreaks.length ? String(Math.max(...winStreaks)) : "0", "", "pos")}
            ${statTile("Longest loss streak", lossStreaks.length ? String(Math.max(...lossStreaks)) : "0", "", "neg")}
            ${statTile("Current streak", currentLabel, "",
                current.kind === "win" ? "pos" : current.kind === "loss" ? "neg" : "")}
            ${statTile("Average win streak", winStreaks.length ? (mean(winStreaks) as number).toFixed(2) : "—")}
            ${statTile("Average loss streak", lossStreaks.length ? (mean(lossStreaks) as number).toFixed(2) : "—")}
            ${statTile("Worst losing run", money(worstRun), "", "neg",
                "Combined P&L of the worst uninterrupted sequence of losing trades.")}
        </div>
        <div class="slab-analysis-block">
            <h5>Trade sequence <span class="slab-muted">oldest to newest</span></h5>
            <canvas id="slab-streak-canvas" height="86"></canvas>
            <div class="slab-analysis-legend">
                <span><i class="slab-dot slab-dot-win"></i> Winning trade</span>
                <span><i class="slab-dot slab-dot-loss"></i> Losing trade</span>
                <span class="slab-muted">Bar height is the size of the trade's return</span>
            </div>
        </div>`;
}

function drawStreakRibbon(): void {
    if (analysisTrades.length < 2) return;
    const prepared = prepCanvas("slab-streak-canvas", 86);
    if (!prepared) return;
    const { ctx, width, height } = prepared;
    const colors = themeColors();

    const values = analysisTrades.map((t) => t.pnl_percent);
    const scale = Math.max(...values.map((v) => Math.abs(v))) || 1;
    const mid = Math.round(height / 2) + 0.5;
    const slot = width / analysisTrades.length;
    const barWidth = Math.max(1, Math.min(10, slot - 1));

    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();

    analysisTrades.forEach((trade, index) => {
        const magnitude = (Math.abs(trade.pnl_percent) / scale) * (height / 2 - 6);
        const x = index * slot + (slot - barWidth) / 2;
        ctx.fillStyle = trade.pnl > 0 ? colors.win : trade.pnl < 0 ? colors.loss : colors.flat;
        if (trade.pnl >= 0) ctx.fillRect(x, mid - magnitude, barWidth, Math.max(1, magnitude));
        else ctx.fillRect(x, mid, barWidth, Math.max(1, magnitude));
    });
}

// ---- Time patterns --------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function bucketBy(keyOf: (date: Date) => number, size: number) {
    const totals = new Array(size).fill(0);
    const counts = new Array(size).fill(0);
    for (const trade of analysisTrades) {
        const date = new Date(trade.entry_time);
        if (Number.isNaN(date.getTime())) continue;
        const key = keyOf(date);
        totals[key] += trade.pnl;
        counts[key] += 1;
    }
    return { totals, counts };
}

function humanDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "—";
    const minutes = ms / 60000;
    if (minutes < 60) return minutes.toFixed(0) + " min";
    const hours = minutes / 60;
    if (hours < 48) return hours.toFixed(1) + " h";
    return (hours / 24).toFixed(1) + " days";
}

function renderTimePanel(): void {
    const panel = el("slab-tab-time");
    if (!panel) return;
    if (!analysisTrades.length) {
        panel.innerHTML = emptyPanel("No trades to analyse.");
        return;
    }

    const durations = analysisTrades
        .filter((t) => t.exit_time)
        .map((t) => new Date(t.exit_time as string).getTime() - new Date(t.entry_time).getTime())
        .filter((d) => Number.isFinite(d) && d > 0);

    const byDay = bucketBy((d) => d.getDay(), 7);
    const byHour = bucketBy((d) => d.getHours(), 24);
    const bestDay = byDay.totals.reduce((best, value, i) => (value > byDay.totals[best] ? i : best), 0);
    const worstDay = byDay.totals.reduce((worst, value, i) => (value < byDay.totals[worst] ? i : worst), 0);
    const activeHours = byHour.counts.filter((c) => c > 0).length;

    panel.innerHTML = `
        <div class="slab-astat-row">
            ${statTile("Average holding time", humanDuration(mean(durations) ?? 0))}
            ${statTile("Longest hold", humanDuration(durations.length ? Math.max(...durations) : 0))}
            ${statTile("Shortest hold", humanDuration(durations.length ? Math.min(...durations) : 0))}
            ${statTile("Best entry day", byDay.counts[bestDay] ? WEEKDAYS[bestDay] : "—",
                byDay.counts[bestDay] ? money(byDay.totals[bestDay]) : "", "pos")}
            ${statTile("Worst entry day", byDay.counts[worstDay] ? WEEKDAYS[worstDay] : "—",
                byDay.counts[worstDay] ? money(byDay.totals[worstDay]) : "", "neg")}
        </div>
        <div class="slab-analysis-grid">
            <div class="slab-analysis-block">
                <h5>P&amp;L by entry weekday</h5>
                <canvas id="slab-weekday-canvas" height="180"></canvas>
            </div>
            <div class="slab-analysis-block">
                <h5>P&amp;L by entry hour
                    <span class="slab-muted">${activeHours} active hour${activeHours === 1 ? "" : "s"}</span></h5>
                <canvas id="slab-hour-canvas" height="180"></canvas>
            </div>
        </div>
        <div class="slab-analysis-legend">
            <span class="slab-muted">Timestamps are the candle times returned by the data provider (UTC),
                rendered in your local time zone.</span>
        </div>`;
}

/** Signed bar chart with a zero baseline, used by both time-pattern charts. */
function drawSignedBars(canvasId: string, labels: string[], values: number[], counts: number[]): void {
    const prepared = prepCanvas(canvasId, 180);
    if (!prepared) return;
    const { ctx, width, height } = prepared;
    const colors = themeColors();

    const scale = Math.max(...values.map((v) => Math.abs(v)), 1);
    const pad = { top: 10, right: 6, bottom: 22, left: 46 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const mid = pad.top + plotH / 2;
    const slot = plotW / labels.length;
    const barWidth = Math.max(2, Math.min(26, slot - 4));

    ctx.strokeStyle = colors.line;
    ctx.fillStyle = colors.dim;
    ctx.textAlign = "right";
    for (const [value, y] of [[scale, pad.top], [0, mid], [-scale, pad.top + plotH]] as [number, number][]) {
        const line = Math.round(y) + 0.5;
        ctx.beginPath();
        ctx.moveTo(pad.left, line);
        ctx.lineTo(width - pad.right, line);
        ctx.stroke();
        ctx.fillText(Math.round(value).toLocaleString(), pad.left - 6, line + 3);
    }

    labels.forEach((label, index) => {
        const x = pad.left + slot * index + (slot - barWidth) / 2;
        if (counts[index]) {
            const magnitude = (Math.abs(values[index]) / scale) * (plotH / 2);
            ctx.fillStyle = values[index] >= 0 ? colors.win : colors.loss;
            if (values[index] >= 0) ctx.fillRect(x, mid - magnitude, barWidth, Math.max(1, magnitude));
            else ctx.fillRect(x, mid, barWidth, Math.max(1, magnitude));
        }
        // Label every bar when there is room, otherwise every third one.
        if (slot > 22 || index % 3 === 0) {
            ctx.fillStyle = counts[index] ? colors.text : colors.dim;
            ctx.textAlign = "center";
            ctx.fillText(label, x + barWidth / 2, height - 7);
        }
    });
}

function drawTimeCharts(): void {
    if (!analysisTrades.length) return;
    const byDay = bucketBy((d) => d.getDay(), 7);
    const byHour = bucketBy((d) => d.getHours(), 24);
    drawSignedBars("slab-weekday-canvas", WEEKDAYS, byDay.totals, byDay.counts);
    drawSignedBars(
        "slab-hour-canvas",
        Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")),
        byHour.totals,
        byHour.counts
    );
}

function exportResultJson(): void {
    if (!lastResult) return;
    const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `orbit-backtest-${lastResult.symbol}-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Saved strategies & history
// ---------------------------------------------------------------------------

export async function saveCurrentStrategy(): Promise<void> {
    if (!currentStrategy || !currentUnderstanding) {
        showStatus("Generate a strategy before saving it.", "error");
        return;
    }
    try {
        await apiClient.post("/api/strategy-lab/strategies", {
            name: currentUnderstanding.strategy_name,
            description: el<HTMLTextAreaElement>("slab-description")?.value.trim() || "",
            strategy: currentStrategy,
            market: el<HTMLSelectElement>("slab-market")?.value || "",
            symbol: el<HTMLInputElement>("slab-asset")?.value || "",
            timeframe: el<HTMLSelectElement>("slab-timeframe")?.value || ""
        });
        showStatus("Strategy saved to your library.", "success");
    } catch (err) {
        showStatus(errorText(err), "error");
    }
}

export async function loadStrategyLabHistory(): Promise<void> {
    const box = el("slab-history-list");
    if (!box) return;
    try {
        const res = await apiClient.get<{ ok: boolean; data: HistoryRow[] }>("/api/strategy-lab/backtests?limit=20");
        const rows = unwrapData(res);
        if (!rows.length) {
            box.innerHTML = `<div class="slab-muted slab-center">No backtests yet. Your runs appear here.</div>`;
            return;
        }
        box.innerHTML = rows.map((row) => {
            const profit = Number(row.metrics?.net_profit_percent ?? 0);
            const tone = profit > 0 ? "slab-pos" : profit < 0 ? "slab-neg" : "";
            return `<button type="button" class="slab-history-row" data-id="${row.id}">
                <div class="slab-history-main">
                    <strong>${esc(row.strategy_name || "Strategy")}</strong>
                    <span class="slab-muted">${esc(row.symbol)} · ${esc(row.timeframe)} · ${when(row.created_at)}</span>
                </div>
                <div class="slab-history-stats">
                    <span class="${tone}">${pct(profit)}</span>
                    <span class="slab-muted">${num(row.metrics?.total_trades)} trades</span>
                </div>
            </button>`;
        }).join("");
        box.querySelectorAll<HTMLButtonElement>(".slab-history-row").forEach((button) => {
            button.addEventListener("click", () =>
                void openBacktest(Number(button.getAttribute("data-id"))));
        });
    } catch (err) {
        box.innerHTML = `<div class="slab-muted slab-center">${esc(errorText(err))}</div>`;
    }
}

/** Re-opens a stored backtest from the history list. */
export async function openBacktest(backtestId: number): Promise<void> {
    if (!backtestId) return;
    try {
        const res = await apiClient.get<{ ok: boolean; data: any }>(`/api/strategy-lab/backtests/${backtestId}`);
        const row = unwrapData(res);
        const definition = row.definition || {};
        currentStrategy = definition;
        const payload: BacktestPayload = {
            backtest_id: row.id,
            symbol: row.symbol,
            market: row.market,
            timeframe: row.timeframe,
            start_date: row.start_date,
            end_date: row.end_date,
            initial_capital: row.initial_capital,
            metrics: row.metrics || {},
            trades: row.trades || [],
            equity_curve: row.equity_curve || [],
            execution_model: row.execution_model || {},
            understanding: { strategy_name: row.strategy_name, direction: "long",
                entry: { logic: "AND", conditions: [] }, exit: { logic: "OR", conditions: [] }, risk: [] },
            strategy: definition,
            data: {
                source: (row.data_meta && row.data_meta.source) || "stored",
                candles: (row.data_meta && row.data_meta.candles) || 0,
                notes: [],
                timeframe_label: (row.data_meta && row.data_meta.timeframe_label) || row.timeframe
            },
            cached: false
        };
        lastResult = payload;
        renderResults(payload);
    } catch (err) {
        showStatus(errorText(err), "error");
    }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function initStrategyLabListeners(): void {
    el("slab-generate-btn")?.addEventListener("click", () => void generateStrategy());
    el("slab-market")?.addEventListener("change", onStrategyLabMarketChange);
    el("slab-period")?.addEventListener("change", onStrategyLabPeriodChange);
    el("slab-refresh-history")?.addEventListener("click", () => void loadStrategyLabHistory());
    el<HTMLInputElement>("slab-asset")?.addEventListener("input", (event) =>
        onStrategyLabAssetInput((event.target as HTMLInputElement).value));

    // Ctrl/Cmd+Enter in the description box generates the strategy.
    el<HTMLTextAreaElement>("slab-description")?.addEventListener("keydown", (event) => {
        const keyboard = event as KeyboardEvent;
        if ((keyboard.ctrlKey || keyboard.metaKey) && keyboard.key === "Enter") {
            keyboard.preventDefault();
            void generateStrategy();
        }
    });

    // Close the symbol dropdown when clicking elsewhere.
    document.addEventListener("click", (event) => {
        const results = el("slab-asset-results");
        const input = el("slab-asset");
        if (!results || results.classList.contains("hidden")) return;
        const target = event.target as Node;
        if (input !== target && !results.contains(target)) {
            results.classList.add("hidden");
        }
    });

    // Keep every canvas crisp when the window is resized. Only the visible
    // analysis tab is redrawn; a hidden canvas has no measurable width.
    let resizeTimer: number | null = null;
    window.addEventListener("resize", () => {
        if (!lastResult || el("slab-results")?.classList.contains("hidden")) return;
        if (resizeTimer) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
            drawEquityCurve(lastResult!.equity_curve);
            switchAnalysisTab(activeAnalysisTab);
        }, 150);
    });

    safeText(el("slab-year"), String(new Date().getFullYear()));
}
