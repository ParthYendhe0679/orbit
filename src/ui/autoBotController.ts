/**
 * ORBIT Trading Terminal — Auto-Trade Bot Control Center & Logger
 * Handles bot sessions, Go scheduler orchestration, real-time activity events,
 * active trade inspection, and terminal log streaming.
 */

import { autoBotService } from "../services/autoBotService";
import { authFetch } from "../services/apiClient";
import { store } from "../state/store";
import { formatINR, esc } from "../utils/formatters";
import { safeText, getElement } from "../utils/dom";
import {
    BotUniverseResponse,
    BotSessionDetail,
    BotActiveTrade,
    BotActivityEvent,
    BotCurrentSessionResponse
} from "../types/autobot";

const MAX_LOG_LINES = 200;
const BOT_LIVE_STATES = ["STARTING", "SCANNING", "ANALYZING", "OPPORTUNITY_FOUND", "TRADE_ACTIVE", "WAITING", "STOPPING"];
const BOT_ACTIVITY_MAX = 150;

const BOT_EVENT_ICONS: Record<string, string> = {
    STATE_CHANGED: "fa-solid fa-shuffle",
    SESSION_RECOVERED: "fa-solid fa-rotate-right",
    SCAN_STARTED: "fa-solid fa-magnifying-glass-chart",
    MARKET_DATA_UPDATED: "fa-solid fa-chart-column",
    MARKET_DATA_FAILED: "fa-solid fa-plug-circle-xmark",
    AGENTS_COMPLETED: "fa-solid fa-robot",
    STRATEGIES_COMPLETED: "fa-solid fa-chess-knight",
    RISK_EVALUATED: "fa-solid fa-shield-halved",
    OPPORTUNITY_EVALUATED: "fa-solid fa-gauge-high",
    DECISION_READY: "fa-solid fa-scale-balanced",
    NO_OPPORTUNITY: "fa-solid fa-hourglass-half",
    OPPORTUNITY_DETECTED: "fa-solid fa-crosshairs",
    RISK_APPROVED: "fa-solid fa-circle-check",
    RISK_REJECTED: "fa-solid fa-ban",
    EXECUTION_REJECTED: "fa-solid fa-triangle-exclamation",
    TRADE_OPENED: "fa-solid fa-bolt",
    POSITION_MANAGED: "fa-solid fa-sliders",
    TRADE_CLOSED: "fa-solid fa-flag-checkered",
    SCAN_COMPLETED: "fa-solid fa-check-double",
    TARGET_REACHED: "fa-solid fa-trophy",
    MAX_LOSS_REACHED: "fa-solid fa-hand",
    ERROR: "fa-solid fa-circle-exclamation",
};

let _botUniverse: BotUniverseResponse | null = null;
let _botSession: BotSessionDetail | null = null;
let _botConfig: any = null;
let _botAvailableBalance: number | null = null;
let _botSelectedAssets: Set<string> = new Set();
export let _botActiveTradesCache: BotActiveTrade[] = [];
let _botPollTimer: any = null;
let _botBusy = false;

function botUserId(): string | number | null {
    return store.get("currentUserId") || null;
}

export function botIsLive(session: BotSessionDetail | null): boolean {
    return !!(session && BOT_LIVE_STATES.includes(session.status));
}

async function botFetch(url: string, options?: RequestInit): Promise<any> {
    const res = await authFetch(url, options);
    let data: any = {};
    try {
        data = await res.json();
    } catch {
        // non-JSON body
    }
    if (!res.ok || data.ok === false) {
        throw new Error(typeof data.detail === "string" ? data.detail : (data.error || `Request failed (${res.status})`));
    }
    return data;
}

function botPost(url: string, body: any): Promise<any> {
    return botFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
}

function botTime(iso?: string): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "—" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function botDateTime(iso?: string): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "—" : d.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function botSigned(value?: number): string {
    const n = Number(value || 0);
    return `${n >= 0 ? "+" : ""}${formatINR(n)}`;
}

export async function initBotControlCenter(): Promise<void> {
    const uid = botUserId();
    if (!uid) return;
    try {
        const universeReq = _botUniverse ? null : botFetch(`/api/bot/universe?user_id=${encodeURIComponent(uid)}`);
        await refreshBotControlCenter(true, universeReq);
    } catch (err: any) {
        showBotConfigError(err.message);
    }
    startBotPolling();
}

export async function refreshBotControlCenter(populateForm: boolean = false, universeRequest: Promise<any> | null = null): Promise<void> {
    const uid = botUserId();
    if (!uid) return;

    const histories = Promise.allSettled([loadBotTradeHistory(), loadBotSessionHistory()]);
    const [data, universe] = await Promise.all([
        botFetch(`/api/bot/session/current?user_id=${encodeURIComponent(uid)}`) as Promise<BotCurrentSessionResponse>,
        universeRequest || Promise.resolve(_botUniverse)
    ]);

    if (universe) _botUniverse = universe;
    _botConfig = data.config || null;
    _botAvailableBalance = data.available_balance;

    if (populateForm || !document.querySelector("#bot-market option")) populateBotForm();
    renderBotSession(data.session, data.scheduler_online);
    renderBotBalanceHint();

    if (data.session) {
        await loadBotActivity(data.session.id);
    } else {
        renderBotActivity([]);
    }
    await histories;
}

function startBotPolling(): void {
    clearInterval(_botPollTimer);
    _botPollTimer = setInterval(async () => {
        const tabContentAutotrade = getElement("tab-content-autotrade");
        if (!tabContentAutotrade || tabContentAutotrade.classList.contains("hidden-tab")) return;
        const uid = botUserId();
        if (!uid) return;
        try {
            const data: BotCurrentSessionResponse = await botFetch(`/api/bot/session/current?user_id=${encodeURIComponent(uid)}`);
            _botAvailableBalance = data.available_balance;
            renderBotBalanceHint();
            renderBotSession(data.session, data.scheduler_online);
        } catch {
            // retry on next tick
        }
    }, 15000);
}

function populateBotForm(): void {
    if (!_botUniverse) return;
    const cats = _botUniverse.categories || [];
    const policy = _botUniverse.policy || { supported_leverage: [1], default_leverage: 1 };
    const cfg = _botConfig || {};
    const marketSel = getElement<HTMLSelectElement>("bot-market");
    const levSel = getElement<HTMLSelectElement>("bot-leverage");
    if (!marketSel || !levSel) return;

    const preferred = cats.find(c => c.supported && c.id === cfg.market_category) || cats.find(c => c.supported);
    marketSel.innerHTML = cats.map(c =>
        `<option value="${esc(c.id)}" ${c.supported ? "" : "disabled"} ${preferred && c.id === preferred.id ? "selected" : ""}>` +
        `${esc(c.label)}${c.supported ? ` (${c.assets.length})` : " — coming soon"}</option>`
    ).join("");

    const allowed = new Set(((preferred && preferred.assets) || []).map(a => a.symbol.toUpperCase()));
    _botSelectedAssets = new Set((cfg.assets_list || []).map((s: string) => String(s).toUpperCase()).filter((s: string) => allowed.has(s)));

    const setVal = (id: string, v: any) => {
        const el = getElement<HTMLInputElement>(id);
        if (el && v !== undefined && v !== null) el.value = String(v);
    };
    setVal("bot-capital", cfg.allocated_capital);
    setVal("bot-target", cfg.target_profit);
    setVal("bot-maxloss", cfg.max_loss);

    const levels = policy.supported_leverage || [1];
    const cfgLev = Number(cfg.leverage || 1);
    levSel.innerHTML = levels.map(l => `<option value="${Number(l)}" ${Number(l) === cfgLev ? "selected" : ""}>${Number(l)}x</option>`).join("");
    renderBotAssetChips();
    renderBotBalanceHint();
}

function renderBotAssetChips(): void {
    const wrap = getElement("bot-asset-chips");
    const marketSel = getElement<HTMLSelectElement>("bot-market");
    if (!wrap || !marketSel || !_botUniverse) return;

    const cat = (_botUniverse.categories || []).find(c => c.id === marketSel.value);
    const locked = botIsLive(_botSession);
    if (!cat || !cat.supported) {
        wrap.innerHTML = `<div class="bot-chip-empty">${esc((cat && cat.reason) || "Select a supported market.")}</div>`;
        return;
    }

    wrap.innerHTML = cat.assets.map(a => {
        const sym = a.symbol.toUpperCase();
        return `<button type="button" class="bot-asset-chip${_botSelectedAssets.has(sym) ? " selected" : ""}" ${locked ? "disabled" : ""} data-symbol="${esc(sym)}" title="${esc(a.name)}">
                    <strong>${esc(sym)}</strong><span>${esc(a.name)}</span>
                </button>`;
    }).join("");

    wrap.querySelectorAll(".bot-asset-chip").forEach(btn => {
        btn.addEventListener("click", () => {
            const sym = btn.getAttribute("data-symbol");
            if (sym) toggleBotAsset(sym);
        });
    });

    safeText(getElement("bot-assets-hint"), `${_botSelectedAssets.size} selected`);
}

export function onBotMarketChange(): void {
    _botSelectedAssets = new Set();
    renderBotAssetChips();
}

export function toggleBotAsset(symbol: string): void {
    if (botIsLive(_botSession)) return;
    if (_botSelectedAssets.has(symbol)) _botSelectedAssets.delete(symbol);
    else _botSelectedAssets.add(symbol);
    renderBotAssetChips();
}

function renderBotBalanceHint(): void {
    const ok = _botAvailableBalance !== null && _botAvailableBalance !== undefined;
    safeText(getElement("bot-balance-hint"), ok ? `available ${formatINR(_botAvailableBalance!)}` : "");
}

export function setBotCapitalMax(): void {
    const el = getElement<HTMLInputElement>("bot-capital");
    if (el && _botAvailableBalance) el.value = String(Math.floor(Number(_botAvailableBalance) * 100) / 100);
}

function readBotForm(): any {
    return {
        market_category: getElement<HTMLSelectElement>("bot-market")?.value || "",
        assets: [..._botSelectedAssets],
        allocated_capital: parseFloat(getElement<HTMLInputElement>("bot-capital")?.value || "0"),
        target_profit: parseFloat(getElement<HTMLInputElement>("bot-target")?.value || "0"),
        max_loss: parseFloat(getElement<HTMLInputElement>("bot-maxloss")?.value || "0"),
        leverage: parseFloat(getElement<HTMLSelectElement>("bot-leverage")?.value || "1"),
    };
}

function botFormProblem(cfg: any): string | null {
    if (!cfg.assets.length) return "Select at least one asset.";
    for (const [key, label] of [["allocated_capital", "Allocated capital"], ["target_profit", "Target profit"], ["max_loss", "Max loss"]]) {
        if (!(cfg[key] > 0)) return `${label} must be greater than zero.`;
    }
    if (_botAvailableBalance !== null && _botAvailableBalance !== undefined && cfg.allocated_capital > Number(_botAvailableBalance)) {
        return `Allocated capital exceeds your available balance (${formatINR(_botAvailableBalance)}).`;
    }
    return null;
}

function showBotConfigError(message: string | null): void {
    const el = getElement("bot-config-error");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("hidden", !message);
}

export async function saveBotConfig(): Promise<void> {
    const uid = botUserId();
    if (!uid) return;
    const cfg = readBotForm();
    const problem = botFormProblem(cfg);
    if (problem) {
        showBotConfigError(problem);
        return;
    }
    const btn = getElement<HTMLButtonElement>("bot-save-btn");
    const original = btn ? btn.innerHTML : "";
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    }
    try {
        const data = await botPost("/api/bot-config", { user_id: Number(uid), ...cfg });
        _botConfig = { ...(_botConfig || {}), ...data.config, assets_list: data.config.assets };
        showBotConfigError(null);
        if (btn) btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
    } catch (err: any) {
        showBotConfigError(err.message);
    } finally {
        setTimeout(() => {
            if (btn) {
                btn.innerHTML = original;
                updateBotButtons();
            }
        }, 1200);
    }
}

export async function startBotSession(): Promise<void> {
    const uid = botUserId();
    if (!uid || _botBusy) return;
    const cfg = readBotForm();
    const problem = botFormProblem(cfg);
    if (problem) {
        showBotConfigError(problem);
        return;
    }
    _botBusy = true;
    updateBotButtons();
    try {
        const data = await botPost("/api/bot/session/start", { user_id: Number(uid), ...cfg });
        showBotConfigError(null);
        renderBotSession(data.session, data.session ? data.session.scheduler_online : undefined);
        if (data.session) await loadBotActivity(data.session.id);
        loadBotSessionHistory();
    } catch (err: any) {
        showBotConfigError(err.message);
    } finally {
        _botBusy = false;
        updateBotButtons();
    }
}

export async function stopBotSession(): Promise<void> {
    const uid = botUserId();
    if (!uid || _botBusy) return;
    if (!confirm("Stop the bot? It stops scanning and opening trades. Open auto-trades stay open and remain manageable.")) return;
    _botBusy = true;
    updateBotButtons();
    try {
        const data = await botPost("/api/bot/session/stop", { user_id: Number(uid) });
        renderBotSession(data.session, data.session ? data.session.scheduler_online : undefined);
    } catch (err: any) {
        showBotConfigError(err.message);
    } finally {
        _botBusy = false;
        updateBotButtons();
    }
}

function updateBotButtons(): void {
    const live = botIsLive(_botSession);
    const startBtn = getElement<HTMLButtonElement>("bot-start-btn");
    const stopBtn = getElement<HTMLButtonElement>("bot-stop-btn");
    if (startBtn) startBtn.disabled = !!(_botBusy || live);
    if (stopBtn) stopBtn.disabled = !!(_botBusy || !live || (_botSession?.status === "STOPPING"));
    const lock = getElement("bot-config-lock");
    if (lock) lock.classList.toggle("hidden", !live);
    ["bot-market", "bot-capital", "bot-target", "bot-maxloss", "bot-leverage", "bot-save-btn", "bot-max-btn"].forEach(id => {
        const el = getElement<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(id);
        if (el) el.disabled = live;
    });
    document.querySelectorAll(".bot-asset-chip").forEach(b => {
        (b as HTMLButtonElement).disabled = live;
    });
}

function setBotBar(id: string, pct?: number): void {
    const el = getElement(id);
    if (el) el.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
}

export function renderBotSession(session: BotSessionDetail | null, schedulerOnline?: boolean): void {
    _botSession = session || null;
    const s = _botSession;
    const status = s ? s.status : "STOPPED";

    const pill = getElement("bot-status-pill");
    if (pill) pill.className = `bot-status-pill state-${status}`;
    safeText(getElement("bot-status-text"), status.replace(/_/g, " "));

    const sched = getElement("bot-scheduler-pill");
    if (sched && schedulerOnline !== undefined && schedulerOnline !== null) {
        sched.textContent = schedulerOnline ? "GO SCHEDULER ONLINE" : "GO SCHEDULER OFFLINE";
        sched.classList.toggle("online", !!schedulerOnline);
        sched.classList.toggle("offline", !schedulerOnline);
    }

    const meta = getElement("bot-session-meta");
    if (meta) {
        if (!s) {
            meta.textContent = "No session yet. Configure the bot below and start it.";
        } else {
            const parts = [`Session #${s.id}`, s.market_category, (s.assets || []).join(", "), `${Number(s.leverage)}x`, `started ${botDateTime(s.started_at)}`];
            if (s.scan_count) parts.push(`${s.scan_count} scan${s.scan_count === 1 ? "" : "s"}`);
            if (s.entries_allowed && s.next_scan_in_seconds !== null && s.next_scan_in_seconds !== undefined) {
                parts.push(s.next_scan_in_seconds > 0 ? `next scan in ~${Math.round(s.next_scan_in_seconds)}s` : "scan due");
            }
            if (!botIsLive(s) && s.stopped_at) parts.push(`ended ${botDateTime(s.stopped_at)}`);
            if (s.stop_reason && !s.entries_allowed) parts.push(s.stop_reason);
            if (s.last_error) parts.push(`error: ${s.last_error}`);
            meta.textContent = parts.filter(Boolean).join("  ·  ");
        }
    }

    const set = (id: string, v: string) => safeText(getElement(id), v);
    if (!s) {
        ["bot-kpi-allocated", "bot-kpi-available", "bot-kpi-pnl", "bot-kpi-target", "bot-kpi-loss", "bot-kpi-trades"].forEach(id => set(id, "—"));
        ["bot-kpi-allocated-sub", "bot-kpi-used", "bot-kpi-pnl-sub", "bot-kpi-target-sub", "bot-kpi-loss-sub", "bot-kpi-trades-sub"].forEach(id => set(id, ""));
        setBotBar("bot-target-bar", 0);
        setBotBar("bot-loss-bar", 0);
        renderBotActiveTrades([]);
        updateBotButtons();
        renderBotAssetChips();
        return;
    }

    set("bot-kpi-allocated", formatINR(s.allocated_capital));
    set("bot-kpi-allocated-sub", `${Number(s.leverage)}x leverage`);
    set("bot-kpi-available", formatINR(s.available_bot_capital));
    set("bot-kpi-used", `${formatINR(s.used_capital)} in open margin`);

    const pnlEl = getElement("bot-kpi-pnl");
    if (pnlEl) {
        pnlEl.textContent = botSigned(s.total_pnl);
        pnlEl.className = `bot-kpi-val ${Number(s.total_pnl) >= 0 ? "text-green" : "text-red"}`;
    }
    set("bot-kpi-pnl-sub", `realized ${botSigned(s.realized_pnl)} · unrealized ${botSigned(s.unrealized_pnl)}`);
    set("bot-kpi-target", formatINR(s.target_profit));
    set("bot-kpi-target-sub", `${Number(s.target_progress_pct).toFixed(1)}% reached (realized)`);
    setBotBar("bot-target-bar", s.target_progress_pct);
    set("bot-kpi-loss", `${formatINR(s.session_loss)} / ${formatINR(s.max_loss)}`);
    set("bot-kpi-loss-sub", `${Number(s.loss_progress_pct).toFixed(1)}% of limit (${String(s.loss_basis || "").replace(/_/g, " ")})`);
    setBotBar("bot-loss-bar", s.loss_progress_pct);
    set("bot-kpi-trades", String(s.total_trades));
    set("bot-kpi-trades-sub", `${s.winning_trades}W / ${s.losing_trades}L · ${s.open_trades} open`);

    renderBotActiveTrades(s.active_trades || []);
    updateBotButtons();
    renderBotAssetChips();
}

export function renderBotActiveTrades(trades: BotActiveTrade[]): void {
    _botActiveTradesCache = trades;
    safeText(getElement("bot-active-count"), String(trades.length));
    const tbody = getElement("bot-active-tbody");
    if (!tbody) return;
    if (!trades.length) {
        tbody.innerHTML = `<tr><td colspan="12" class="table-empty-message">No active auto-trades.</td></tr>`;
        return;
    }
    tbody.innerHTML = trades.map(pos => {
        const pnl = Number(pos.unrealized_pnl || 0);
        const side = String(pos.side || pos.type || "buy").toUpperCase();
        const isLong = side === "BUY" || side === "LONG";
        const margin = Number(pos.margin_used || 0);
        const pct = margin > 0 ? ((pnl / margin) * 100).toFixed(2) : "0.00";
        return `
            <tr>
                <td><strong>${esc(pos.symbol || pos.asset || "")}</strong></td>
                <td><span class="badge ${isLong ? "badge-green" : "badge-red"}">${isLong ? "LONG" : "SHORT"}</span></td>
                <td>${formatINR(pos.entry_price)}</td>
                <td><strong>${formatINR(pos.current_price)}</strong></td>
                <td>${Number(pos.remaining_quantity || pos.quantity)} <span style="opacity:0.6;font-size:11px;">/ ${Number(pos.original_quantity || pos.quantity)}</span></td>
                <td><span class="text-cyan font-bold">${esc(pos.leverage || 1)}x</span></td>
                <td>${formatINR(pos.position_size || 0)}</td>
                <td>${formatINR(margin)}</td>
                <td class="${pnl >= 0 ? "text-green" : "text-red"}"><strong>${botSigned(pnl)}</strong> <span style="font-size:11px;opacity:0.8;">(${pnl >= 0 ? "+" : ""}${pct}%)</span></td>
                <td>${botTime(pos.opened_at)}</td>
                <td><span class="badge badge-blue">OPEN</span> <span class="badge badge-open">BOT</span></td>
                <td>
                    <button class="glow-btn btn-manage-action" onclick="openManageTradeModal(${Number(pos.id)})">
                        <i class="fa-solid fa-sliders"></i> Manage
                    </button>
                </td>
            </tr>`;
    }).join("");
}

function botEventRow(evt: BotActivityEvent): string {
    const icon = BOT_EVENT_ICONS[evt.event] || "fa-solid fa-circle-info";
    const level = ["success", "warning", "error"].includes(evt.level) ? evt.level : "info";
    return `
        <div class="bot-event bot-event-${level}">
            <i class="${icon} bot-event-icon"></i>
            <div class="bot-event-body">
                <div class="bot-event-head">
                    <span class="bot-event-type">${esc(String(evt.event || "").replace(/_/g, " "))}</span>
                    ${evt.symbol ? `<span class="bot-event-symbol">${esc(evt.symbol)}</span>` : ""}
                    <span class="bot-event-time">${botTime(evt.ts)}</span>
                </div>
                <div class="bot-event-msg">${esc(evt.message)}</div>
            </div>
        </div>`;
}

export function renderBotActivity(events: BotActivityEvent[]): void {
    const feed = getElement("bot-activity-feed");
    if (!feed) return;
    feed.innerHTML = events.length
        ? events.slice(0, BOT_ACTIVITY_MAX).map(botEventRow).join("")
        : `<div class="table-empty-message">No activity yet.</div>`;
}

export function appendBotEvent(evt: BotActivityEvent): void {
    const feed = getElement("bot-activity-feed");
    if (!feed) return;
    const empty = feed.querySelector(".table-empty-message");
    if (empty) empty.remove();
    feed.insertAdjacentHTML("afterbegin", botEventRow(evt));
    while (feed.children.length > BOT_ACTIVITY_MAX) {
        if (feed.lastElementChild) feed.removeChild(feed.lastElementChild);
    }
}

export async function loadBotActivity(sessionId: number): Promise<void> {
    const uid = botUserId();
    if (!uid || !sessionId) return;
    try {
        const data = await botFetch(`/api/bot/session/${encodeURIComponent(sessionId)}/activity?user_id=${encodeURIComponent(uid)}&limit=100`);
        renderBotActivity(data.events || []);
    } catch (err) {
        console.warn("[Bot] activity load failed:", err);
    }
}

export function handleBotEvent(evt: BotActivityEvent): void {
    if (!evt) return;
    if (_botSession && evt.session_id !== _botSession.id) {
        if (evt.session_id && evt.session_id > _botSession.id) {
            refreshBotControlCenter().catch(() => {});
        }
        return;
    }
    appendBotEvent(evt);
    if (["TRADE_CLOSED", "TARGET_REACHED", "MAX_LOSS_REACHED"].includes(evt.event)) {
        loadBotTradeHistory();
        loadBotSessionHistory();
    }
}

export function handleBotSessionUpdate(snap: BotSessionDetail): void {
    if (!snap) return;
    if (_botSession && snap.id < _botSession.id) return;
    const wasLive = botIsLive(_botSession);
    renderBotSession(snap, snap.scheduler_online);
    if (wasLive && !botIsLive(snap)) loadBotSessionHistory();
}

export function switchBotHistoryTab(tab: "trades" | "sessions"): void {
    getElement("bot-hist-btn-trades")?.classList.toggle("active", tab === "trades");
    getElement("bot-hist-btn-sessions")?.classList.toggle("active", tab === "sessions");
    getElement("bot-hist-trades")?.classList.toggle("hidden", tab !== "trades");
    getElement("bot-hist-sessions")?.classList.toggle("hidden", tab !== "sessions");
}

export async function loadBotTradeHistory(): Promise<void> {
    const uid = botUserId();
    const tbody = getElement("bot-hist-trades-tbody");
    if (!uid || !tbody) return;
    try {
        const data = await botFetch(`/api/trades/history?user_id=${encodeURIComponent(uid)}&source=bot&limit=25&offset=0`);
        const trades = data.trades || [];
        safeText(getElement("bot-hist-trades-count"), String(data.total || 0));
        tbody.innerHTML = trades.length ? trades.map((t: any) => {
            const pnl = Number(t.realized_pnl !== undefined && t.realized_pnl !== null ? t.realized_pnl : (t.pnl || 0));
            const side = String(t.type || "buy").toUpperCase();
            const isLong = side === "BUY" || side === "LONG";
            const outcome = String(t.outcome || "closed").toUpperCase();
            const outcomeClass = outcome === "TARGET" ? "badge-green" : outcome === "SL" ? "badge-red" : "badge-yellow";
            return `
                <tr>
                    <td><strong>${esc(t.asset || t.symbol)}</strong></td>
                    <td><code>#${esc(t.bot_session_id)}</code></td>
                    <td><span class="badge ${isLong ? "badge-green" : "badge-red"}">${isLong ? "LONG" : "SHORT"}</span></td>
                    <td>${formatINR(t.entry_price || 0)}</td>
                    <td>${t.exit_price !== null && t.exit_price !== undefined ? formatINR(t.exit_price) : "—"}</td>
                    <td>${Number(t.original_quantity || t.quantity || 0)}</td>
                    <td><span class="text-cyan font-bold">${esc(t.leverage || 1)}x</span></td>
                    <td class="${pnl > 0 ? "text-green" : pnl < 0 ? "text-red" : ""}"><strong>${botSigned(pnl)}</strong></td>
                    <td><span class="badge ${outcomeClass}">${esc(outcome)}</span></td>
                    <td>${botDateTime(t.timestamp)}</td>
                    <td>${botDateTime(t.closed_at)}</td>
                </tr>`;
        }).join("") : `<tr><td colspan="11" class="table-empty-message">No completed auto-trades yet.</td></tr>`;
    } catch (err: any) {
        tbody.innerHTML = `<tr><td colspan="11" class="table-empty-message text-red">Failed to load auto-trade history: ${esc(err.message)}</td></tr>`;
    }
}

export async function loadBotSessionHistory(): Promise<void> {
    const uid = botUserId();
    const tbody = getElement("bot-hist-sessions-tbody");
    if (!uid || !tbody) return;
    try {
        const data = await botFetch(`/api/bot/session/history?user_id=${encodeURIComponent(uid)}&limit=20`);
        const sessions = data.sessions || [];
        safeText(getElement("bot-hist-sessions-count"), String(data.total || 0));
        tbody.innerHTML = sessions.length ? sessions.map((s: any) => {
            const pnl = Number(s.realized_pnl || 0);
            return `
                <tr>
                    <td><code>#${esc(s.id)}</code></td>
                    <td>${botDateTime(s.started_at || s.created_at)}</td>
                    <td>${botDateTime(s.stopped_at)}</td>
                    <td><span class="badge badge-blue">${esc(s.market_category)}</span></td>
                    <td>${esc((s.assets || []).join(", "))}</td>
                    <td>${formatINR(s.allocated_capital)}</td>
                    <td>${formatINR(s.target_profit)}</td>
                    <td>${formatINR(s.max_loss)}</td>
                    <td><span class="text-cyan font-bold">${esc(Number(s.leverage))}x</span></td>
                    <td><span class="bot-state-tag state-${esc(s.status)}">${esc(String(s.status).replace(/_/g, " "))}</span></td>
                    <td>${esc(s.total_trades)} <span style="opacity:0.7;font-size:11px;">(${esc(s.winning_trades)}W / ${esc(s.losing_trades)}L)</span></td>
                    <td class="${pnl > 0 ? "text-green" : pnl < 0 ? "text-red" : ""}"><strong>${botSigned(pnl)}</strong></td>
                </tr>`;
        }).join("") : `<tr><td colspan="12" class="table-empty-message">No bot sessions yet.</td></tr>`;
    } catch (err: any) {
        tbody.innerHTML = `<tr><td colspan="12" class="table-empty-message text-red">Failed to load session history: ${esc(err.message)}</td></tr>`;
    }
}

/**
 * Appends a formatted log entry to the terminal console, capping entries to prevent memory leaks.
 */
export function logToTerminal(agent: string, message: string, timestamp?: string): void {
    const consoleLogsElement = getElement("console-logs");
    if (!consoleLogsElement) return;

    const timeStr = timestamp || new Date().toLocaleTimeString();
    const logLine = document.createElement("div");
    logLine.className = `log-line agent-${agent.toLowerCase().replace(/[^a-z0-9]/g, "-")}-log`;
    logLine.innerHTML = `<span class="log-time">[${esc(timeStr)}]</span> <strong>[${esc(agent)}]</strong>: ${esc(message)}`;
    consoleLogsElement.appendChild(logLine);

    while (consoleLogsElement.childElementCount > MAX_LOG_LINES) {
        if (consoleLogsElement.firstChild) {
            consoleLogsElement.removeChild(consoleLogsElement.firstChild);
        }
    }
    consoleLogsElement.scrollTop = consoleLogsElement.scrollHeight;
}

/**
 * Updates the 7-Agent visual UI in the right column.
 */
export function updateAgentStatusUI(agentName: string, message: string): void {
    if (!agentName || agentName === "SYSTEM") return;

    let rowId: string | null = null;
    const nameLower = agentName.toLowerCase();

    if (nameLower.includes("chart") || nameLower.includes("level")) rowId = "chart";
    else if (nameLower.includes("indicator")) rowId = "indicators";
    else if (nameLower.includes("news")) rowId = "news";
    else if (nameLower.includes("consensus") || nameLower.includes("judge") || nameLower.includes("strategy")) rowId = "consensus";
    else if (nameLower.includes("risk")) rowId = "risk";
    else if (nameLower.includes("execution")) rowId = "execution";
    else if (
        nameLower.includes("monitor") ||
        nameLower.includes("p&l") ||
        nameLower.includes("pndl") ||
        nameLower.includes("manager")
    )
        rowId = "monitor";

    if (!rowId) return;

    const row = getElement(`agent-row-${rowId}`);
    const statusText = getElement(`agent-status-${rowId}`);
    if (!row || !statusText) return;

    const msgTrim = message.trim();
    if (message.startsWith(" ") || message.startsWith("\t") || msgTrim.startsWith("-") || msgTrim.startsWith("*")) {
        return;
    }

    row.classList.remove("completed-agent");
    row.classList.add("active-agent");
    statusText.textContent = "Processing...";

    const msgLower = message.toLowerCase();
    if (
        msgLower.includes("complete") ||
        msgLower.includes("found") ||
        msgLower.includes("calculated") ||
        msgLower.includes("signal generated") ||
        msgLower.includes("sentiment score") ||
        msgLower.includes("sentiment:") ||
        msgLower.includes("monitoring active") ||
        msgLower.includes("placed") ||
        msgLower.includes("waiting") ||
        msgLower.includes("verdict:") ||
        msgLower.includes("conclusion:") ||
        msgLower.includes("no trade planned") ||
        msgLower.includes("planning") ||
        msgLower.includes("no pending orders") ||
        msgLower.includes("order filled") ||
        msgLower.includes("no active positions") ||
        msgLower.includes("position closed") ||
        msgLower.includes("holding") ||
        msgLower.includes("analyzed")
    ) {
        row.classList.remove("active-agent");
        row.classList.add("completed-agent");
        statusText.textContent = "Task Completed";

        const pb = getElement("atv-progress-bar");
        if (pb) {
            const cur = parseInt(pb.style.width || "0");
            if (cur < 100) pb.style.width = Math.min(100, cur + 15) + "%";
        }
    }
}

/**
 * Loads legacy AutoBot configuration.
 */
export async function loadBotConfig(): Promise<void> {
    const userId = store.get("currentUserId");
    if (!userId) return;

    try {
        const config = await autoBotService.getConfig(userId);
        if (config) {
            const assetsEl = getElement<HTMLInputElement>("autotrade-assets");
            const capEl = getElement<HTMLInputElement>("autotrade-capital");
            const minProfEl = getElement<HTMLInputElement>("autotrade-min-profit");
            const maxProfEl = getElement<HTMLInputElement>("autotrade-max-profit");
            const toggleEl = getElement<HTMLInputElement>("autotrade-toggle");
            const statusEl = getElement("autotrade-status-text");

            if (assetsEl && config.assets) assetsEl.value = config.assets;
            if (capEl && config.total_capital) capEl.value = String(config.total_capital);
            if (minProfEl && config.min_profit_target) minProfEl.value = String(config.min_profit_target);
            if (maxProfEl && config.max_profit_target) maxProfEl.value = String(config.max_profit_target);
            if (toggleEl) toggleEl.checked = !!config.is_active;

            if (statusEl) {
                statusEl.textContent = config.is_active ? "Running — scanning market..." : "Currently stopped";
            }
        }
    } catch (e) {
        console.error("Failed to load bot config:", e);
    }
}

/**
 * Initializes AutoBot UI event listeners.
 */
export function initAutoBotListeners(): void {
    const startBtn = getElement("bot-start-btn");
    if (startBtn) startBtn.addEventListener("click", startBotSession);

    const stopBtn = getElement("bot-stop-btn");
    if (stopBtn) stopBtn.addEventListener("click", stopBotSession);

    const saveBtn = getElement("bot-save-btn");
    if (saveBtn) saveBtn.addEventListener("click", saveBotConfig);

    const marketSel = getElement("bot-market");
    if (marketSel) marketSel.addEventListener("change", onBotMarketChange);

    const maxBtn = getElement("bot-max-btn");
    if (maxBtn) maxBtn.addEventListener("click", setBotCapitalMax);
}
