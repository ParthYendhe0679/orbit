// Global App Controller for Orbit Trading Terminal

let tvWidget = null;       // TradingView Widget instance
let socket = null;
let currentAsset = "";
let currentTimeframe = "1d";
let currentUsername = "Trader Account";
let currentUserId = null;   // populated after login — fixes bot-config API calls

// WebSocket connection lifecycle variables (hoisted early to prevent TDZ ReferenceErrors)
let _wsReconnectAttempts = 0;
let _wsReconnectTimer = null;
let _wsIntentionallyClosed = false;

// Phase 11 — orbit-stream Go hub secondary WebSocket
// Receives high-frequency tick and metrics from the Go broadcast hub.
// The primary Python WS (:8000/ws) handles signals, wallet, logs, positions.
let _streamSocket = null;
let _streamReconnectTimer = null;

// News Scroll & Cache variables (hoisted early to prevent TDZ ReferenceErrors)
let _newsScrollRAF = null;
let _newsScrollEl = null;
let _newsIsPaused = false;
let _cachedGlobalNews = null;
try {
    const _storedNews = sessionStorage.getItem("orbit_global_news_cache");
    if (_storedNews) _cachedGlobalNews = JSON.parse(_storedNews);
} catch (e) {}
let _symbolNewsCache = {};

// Compatibility stubs (no longer needed for Lightweight Charts)
let chart = null;
let candleSeries = null;
let activePriceLines = [];

// Max number of log lines kept in the console to prevent memory leak
const MAX_LOG_LINES = 200;

// Page Views
const landingPage = document.getElementById("landing-page");
const loginSection = document.getElementById("login-section");
const dashboardPage = document.getElementById("dashboard-page");

// Navigation Sidebar Menu items
const menuBtnDashboard = document.getElementById("menu-btn-dashboard");
const menuBtnTerminal = document.getElementById("menu-btn-terminal");
const menuBtnAutotrade = document.getElementById("menu-btn-autotrade");
const menuBtnManageTrades = document.getElementById("menu-btn-manage-trades");
const menuBtnReports = document.getElementById("menu-btn-reports");
const menuBtnCopilot = document.getElementById("menu-btn-copilot");

// Content containers
const tabContentOverview = document.getElementById("tab-content-overview");
const tabContentTerminal = document.getElementById("tab-content-terminal");
const tabContentAutotrade = document.getElementById("tab-content-autotrade");
const tabContentManageTrades = document.getElementById("tab-content-manage-trades");
const tabContentReports = document.getElementById("tab-content-reports");
const tabContentCopilot = document.getElementById("tab-content-copilot");

// Sub-views for Tab 2
const terminalStockSelectView = document.getElementById("terminal-stock-select-view");
const terminalActiveTradingView = document.getElementById("terminal-active-trading-view");
const activeTickerDisplay = document.getElementById("active-ticker-display");
const btnDrawSR = document.getElementById("btn-draw-sr");
const contentHeaderTitle = document.getElementById("content-header-title");

// Navigation Buttons
const navLoginBtn = document.getElementById("nav-login-btn");
const getStartedBtn = document.getElementById("get-started-btn");
const logoutBtn = document.getElementById("logout-btn");

// Form & Input Elements
const dashboardUser = document.getElementById("dashboard-user");
const assetInput = document.getElementById("terminal-asset-input");
const analyzeBtn = document.getElementById("initialize-agents-btn");
const stopBtn = document.getElementById("stop-btn");

// Element references
const walletBalanceEl = document.getElementById("wallet-balance");
const currentAssetTitle = document.getElementById("current-asset-title");
const legendPrice = document.getElementById("legend-price");
const legendChange = document.getElementById("legend-change");
const consensusSignal = document.getElementById("consensus-signal");
const consensusVotes = document.getElementById("consensus-votes");
const sentimentMeter = document.getElementById("sentiment-meter");
const sentimentBar = document.getElementById("sentiment-bar");
const sentimentScore = document.getElementById("sentiment-score");
const trendStrength = document.getElementById("trend-strength");
const technicalSignals = document.getElementById("technical-signals");
const consoleLogs = document.getElementById("console-logs");
const systemStatus = document.getElementById("system-status");
const positionsTbody = document.getElementById("positions-tbody");
const historyTbody = document.getElementById("history-tbody");

// Escape text that comes from outside the app (news headlines, Gemini
// reasoning, asset symbols) before it goes anywhere near innerHTML.
function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// Safe setter helpers — never crash if element was removed from HTML
function safeText(el, val) { if (el) el.textContent = val; }
function safeClass(el, val) { if (el) el.className = val; }
function safeStyle(el, prop, val) { if (el && el.style) el.style[prop] = val; }
function safeHTML(el, val) { if (el) el.innerHTML = val; }

// Additional State variables
let showSRLevels = false;

// -------------------------------------------------------------
//   NAVIGATION CONTROLLERS
// -------------------------------------------------------------

// Navigation Tab switching logic
function switchToTab(tabName) {
    if (tabName === "dashboard") {
        menuBtnDashboard.classList.add("active");
        menuBtnTerminal.classList.remove("active");
        if(menuBtnAutotrade) menuBtnAutotrade.classList.remove("active");
        if(menuBtnManageTrades) menuBtnManageTrades.classList.remove("active");
        if(menuBtnReports) menuBtnReports.classList.remove("active");
        if(menuBtnCopilot) menuBtnCopilot.classList.remove("active");
        tabContentOverview.classList.remove("hidden-tab");
        tabContentTerminal.classList.add("hidden-tab");
        if(tabContentAutotrade) tabContentAutotrade.classList.add("hidden-tab");
        if(tabContentManageTrades) tabContentManageTrades.classList.add("hidden-tab");
        if(tabContentReports) tabContentReports.classList.add("hidden-tab");
        if(tabContentCopilot) tabContentCopilot.classList.add("hidden-tab");
        contentHeaderTitle.textContent = "Dashboard Overview";
        // Dashboard always shows GLOBAL market news & real-time dashboard summary
        fetchGlobalNews();
        fetchDashboardSummary();
    } else if (tabName === "terminal") {
        menuBtnTerminal.classList.add("active");
        menuBtnDashboard.classList.remove("active");
        if(menuBtnAutotrade) menuBtnAutotrade.classList.remove("active");
        if(menuBtnManageTrades) menuBtnManageTrades.classList.remove("active");
        if(menuBtnReports) menuBtnReports.classList.remove("active");
        if(menuBtnCopilot) menuBtnCopilot.classList.remove("active");
        tabContentTerminal.classList.remove("hidden-tab");
        tabContentOverview.classList.add("hidden-tab");
        if(tabContentAutotrade) tabContentAutotrade.classList.add("hidden-tab");
        if(tabContentManageTrades) tabContentManageTrades.classList.add("hidden-tab");
        if(tabContentReports) tabContentReports.classList.add("hidden-tab");
        if(tabContentCopilot) tabContentCopilot.classList.add("hidden-tab");
        contentHeaderTitle.textContent = "Trade Agent Terminal";
        // TradingView widget uses autosize — no manual resize needed
    } else if (tabName === "autotrade") {
        if(menuBtnAutotrade) menuBtnAutotrade.classList.add("active");
        menuBtnDashboard.classList.remove("active");
        menuBtnTerminal.classList.remove("active");
        if(menuBtnManageTrades) menuBtnManageTrades.classList.remove("active");
        if(menuBtnReports) menuBtnReports.classList.remove("active");
        if(menuBtnCopilot) menuBtnCopilot.classList.remove("active");
        if(tabContentAutotrade) tabContentAutotrade.classList.remove("hidden-tab");
        tabContentTerminal.classList.add("hidden-tab");
        tabContentOverview.classList.add("hidden-tab");
        if(tabContentManageTrades) tabContentManageTrades.classList.add("hidden-tab");
        if(tabContentReports) tabContentReports.classList.add("hidden-tab");
        if(tabContentCopilot) tabContentCopilot.classList.add("hidden-tab");
        contentHeaderTitle.textContent = "Auto-Trade Bot";
        initBotControlCenter();
    } else if (tabName === "manage-trades") {
        if(menuBtnManageTrades) menuBtnManageTrades.classList.add("active");
        menuBtnDashboard.classList.remove("active");
        menuBtnTerminal.classList.remove("active");
        if(menuBtnAutotrade) menuBtnAutotrade.classList.remove("active");
        if(menuBtnReports) menuBtnReports.classList.remove("active");
        if(menuBtnCopilot) menuBtnCopilot.classList.remove("active");
        if(tabContentManageTrades) tabContentManageTrades.classList.remove("hidden-tab");
        tabContentOverview.classList.add("hidden-tab");
        tabContentTerminal.classList.add("hidden-tab");
        if(tabContentAutotrade) tabContentAutotrade.classList.add("hidden-tab");
        if(tabContentReports) tabContentReports.classList.add("hidden-tab");
        if(tabContentCopilot) tabContentCopilot.classList.add("hidden-tab");
        contentHeaderTitle.textContent = "Manage Trades";
        loadManageTradesData();
    } else if (tabName === "reports") {
        if(menuBtnReports) menuBtnReports.classList.add("active");
        menuBtnDashboard.classList.remove("active");
        menuBtnTerminal.classList.remove("active");
        if(menuBtnAutotrade) menuBtnAutotrade.classList.remove("active");
        if(menuBtnManageTrades) menuBtnManageTrades.classList.remove("active");
        if(menuBtnCopilot) menuBtnCopilot.classList.remove("active");
        if(tabContentReports) tabContentReports.classList.remove("hidden-tab");
        tabContentOverview.classList.add("hidden-tab");
        tabContentTerminal.classList.add("hidden-tab");
        if(tabContentAutotrade) tabContentAutotrade.classList.add("hidden-tab");
        if(tabContentManageTrades) tabContentManageTrades.classList.add("hidden-tab");
        if(tabContentCopilot) tabContentCopilot.classList.add("hidden-tab");
        contentHeaderTitle.textContent = "Trade Reports & Analytics";
        loadReport();
    } else if (tabName === "copilot") {
        if(menuBtnCopilot) menuBtnCopilot.classList.add("active");
        menuBtnDashboard.classList.remove("active");
        menuBtnTerminal.classList.remove("active");
        if(menuBtnAutotrade) menuBtnAutotrade.classList.remove("active");
        if(menuBtnManageTrades) menuBtnManageTrades.classList.remove("active");
        if(menuBtnReports) menuBtnReports.classList.remove("active");
        if(tabContentCopilot) tabContentCopilot.classList.remove("hidden-tab");
        tabContentOverview.classList.add("hidden-tab");
        tabContentTerminal.classList.add("hidden-tab");
        if(tabContentAutotrade) tabContentAutotrade.classList.add("hidden-tab");
        if(tabContentManageTrades) tabContentManageTrades.classList.add("hidden-tab");
        if(tabContentReports) tabContentReports.classList.add("hidden-tab");
        contentHeaderTitle.textContent = "ORBIT AI Analyst";
        if (window.aether3D) window.aether3D.stop();
        const threeCanvas = document.getElementById("three-canvas");
        if (threeCanvas) {
            threeCanvas.style.display = "none";
        }
        syncCopilotPageView();
        loadConversationsList();
        syncCopilotBalance();
    }
}

menuBtnDashboard.addEventListener("click", () => switchToTab("dashboard"));
menuBtnTerminal.addEventListener("click", () => switchToTab("terminal"));
if (menuBtnAutotrade) {
    menuBtnAutotrade.addEventListener("click", () => switchToTab("autotrade"));
}
if (menuBtnManageTrades) {
    menuBtnManageTrades.addEventListener("click", () => switchToTab("manage-trades"));
}
if (menuBtnReports) {
    menuBtnReports.addEventListener("click", () => switchToTab("reports"));
}
if (menuBtnCopilot) {
    menuBtnCopilot.addEventListener("click", () => switchToTab("copilot"));
}

// -------------------------------------------------------------
//   AUTO-TRADE BOT CONTROL CENTER
// -------------------------------------------------------------
// Every value on this page comes from the backend: /api/bot/* for sessions,
// configuration and history, plus "bot_event" / "bot_session_updated"
// messages on the /ws socket. The Go gateway schedules the bot and fans the
// events out; nothing here is simulated in the browser.

const BOT_LIVE_STATES = ["STARTING", "SCANNING", "ANALYZING", "OPPORTUNITY_FOUND", "TRADE_ACTIVE", "WAITING", "STOPPING"];
const BOT_ACTIVITY_MAX = 150;
const BOT_EVENT_ICONS = {
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

let _botUniverse = null;
let _botSession = null;
let _botConfig = null;
let _botAvailableBalance = null;
let _botSelectedAssets = new Set();
let _botActiveTradesCache = [];
let _botPollTimer = null;
let _botBusy = false;

function botUserId() {
    return currentUserId || localStorage.getItem("orbit_user_id") || null;
}

function botIsLive(session) {
    return !!(session && BOT_LIVE_STATES.includes(session.status));
}

async function botFetch(url, options) {
    const res = await fetch(url, options);
    let data = {};
    try { data = await res.json(); } catch (e) { /* non-JSON error body */ }
    if (!res.ok || data.ok === false) {
        throw new Error(typeof data.detail === "string" ? data.detail : (data.error || `Request failed (${res.status})`));
    }
    return data;
}

function botPost(url, body) {
    return botFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function botTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function botDateTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function botSigned(value) {
    const n = Number(value || 0);
    return `${n >= 0 ? "+" : ""}${formatINR(n)}`;
}

async function initBotControlCenter() {
    const uid = botUserId();
    if (!uid) return;
    try {
        const universe = _botUniverse ? null : botFetch(`/api/bot/universe?user_id=${encodeURIComponent(uid)}`);
        await refreshBotControlCenter(true, universe);
    } catch (err) {
        showBotConfigError(err.message);
    }
    startBotPolling();
}
window.initBotControlCenter = initBotControlCenter;

async function refreshBotControlCenter(populateForm = false, universeRequest = null) {
    const uid = botUserId();
    if (!uid) return;
    // Independent requests run together; only the activity feed needs the session id.
    const histories = Promise.allSettled([loadBotTradeHistory(), loadBotSessionHistory()]);
    const [data, universe] = await Promise.all([
        botFetch(`/api/bot/session/current?user_id=${encodeURIComponent(uid)}`),
        universeRequest || Promise.resolve(_botUniverse),
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
window.refreshBotControlCenter = refreshBotControlCenter;

function startBotPolling() {
    // WebSocket pushes are the primary update path; this is a safety net while
    // the tab is visible (e.g. right after a socket reconnect).
    clearInterval(_botPollTimer);
    _botPollTimer = setInterval(async () => {
        if (!tabContentAutotrade || tabContentAutotrade.classList.contains("hidden-tab")) return;
        const uid = botUserId();
        if (!uid) return;
        try {
            const data = await botFetch(`/api/bot/session/current?user_id=${encodeURIComponent(uid)}`);
            _botAvailableBalance = data.available_balance;
            renderBotBalanceHint();
            renderBotSession(data.session, data.scheduler_online);
        } catch (e) { /* retry on the next tick */ }
    }, 15000);
}

function populateBotForm() {
    if (!_botUniverse) return;
    const cats = _botUniverse.categories || [];
    const policy = _botUniverse.policy || {};
    const cfg = _botConfig || {};
    const marketSel = document.getElementById("bot-market");
    const levSel = document.getElementById("bot-leverage");
    if (!marketSel || !levSel) return;

    const preferred = cats.find(c => c.supported && c.id === cfg.market_category) || cats.find(c => c.supported);
    marketSel.innerHTML = cats.map(c =>
        `<option value="${esc(c.id)}" ${c.supported ? "" : "disabled"} ${preferred && c.id === preferred.id ? "selected" : ""}>` +
        `${esc(c.label)}${c.supported ? ` (${c.assets.length})` : " — coming soon"}</option>`
    ).join("");

    const allowed = new Set(((preferred && preferred.assets) || []).map(a => a.symbol.toUpperCase()));
    _botSelectedAssets = new Set((cfg.assets_list || []).map(s => String(s).toUpperCase()).filter(s => allowed.has(s)));

    const setVal = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined && v !== null) el.value = v; };
    setVal("bot-capital", cfg.allocated_capital);
    setVal("bot-target", cfg.target_profit);
    setVal("bot-maxloss", cfg.max_loss);

    const levels = policy.supported_leverage || [1];
    const cfgLev = Number(cfg.leverage || 1);
    levSel.innerHTML = levels.map(l => `<option value="${Number(l)}" ${Number(l) === cfgLev ? "selected" : ""}>${Number(l)}x</option>`).join("");
    renderBotAssetChips();
    renderBotBalanceHint();
}

function renderBotAssetChips() {
    const wrap = document.getElementById("bot-asset-chips");
    const marketSel = document.getElementById("bot-market");
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
        btn.addEventListener("click", () => toggleBotAsset(btn.dataset.symbol));
    });
    safeText(document.getElementById("bot-assets-hint"), `${_botSelectedAssets.size} selected`);
}

function onBotMarketChange() {
    _botSelectedAssets = new Set();
    renderBotAssetChips();
}
window.onBotMarketChange = onBotMarketChange;

function toggleBotAsset(symbol) {
    if (botIsLive(_botSession)) return;
    if (_botSelectedAssets.has(symbol)) _botSelectedAssets.delete(symbol);
    else _botSelectedAssets.add(symbol);
    renderBotAssetChips();
}

function renderBotBalanceHint() {
    const ok = _botAvailableBalance !== null && _botAvailableBalance !== undefined;
    safeText(document.getElementById("bot-balance-hint"), ok ? `available ${formatINR(_botAvailableBalance)}` : "");
}

function setBotCapitalMax() {
    const el = document.getElementById("bot-capital");
    if (el && _botAvailableBalance) el.value = Math.floor(Number(_botAvailableBalance) * 100) / 100;
}
window.setBotCapitalMax = setBotCapitalMax;

function readBotForm() {
    return {
        market_category: document.getElementById("bot-market")?.value || "",
        assets: [..._botSelectedAssets],
        allocated_capital: parseFloat(document.getElementById("bot-capital")?.value),
        target_profit: parseFloat(document.getElementById("bot-target")?.value),
        max_loss: parseFloat(document.getElementById("bot-maxloss")?.value),
        leverage: parseFloat(document.getElementById("bot-leverage")?.value || "1"),
    };
}

// Convenience checks only — the server re-validates everything.
function botFormProblem(cfg) {
    if (!cfg.assets.length) return "Select at least one asset.";
    for (const [key, label] of [["allocated_capital", "Allocated capital"], ["target_profit", "Target profit"], ["max_loss", "Max loss"]]) {
        if (!(cfg[key] > 0)) return `${label} must be greater than zero.`;
    }
    if (_botAvailableBalance !== null && _botAvailableBalance !== undefined && cfg.allocated_capital > Number(_botAvailableBalance)) {
        return `Allocated capital exceeds your available balance (${formatINR(_botAvailableBalance)}).`;
    }
    return null;
}

function showBotConfigError(message) {
    const el = document.getElementById("bot-config-error");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("hidden", !message);
}

async function saveBotConfig() {
    const uid = botUserId();
    if (!uid) return;
    const cfg = readBotForm();
    const problem = botFormProblem(cfg);
    if (problem) { showBotConfigError(problem); return; }
    const btn = document.getElementById("bot-save-btn");
    const original = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...'; }
    try {
        const data = await botPost("/api/bot-config", { user_id: Number(uid), ...cfg });
        _botConfig = { ...(_botConfig || {}), ...data.config, assets_list: data.config.assets };
        showBotConfigError(null);
        if (btn) btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
    } catch (err) {
        showBotConfigError(err.message);
    } finally {
        setTimeout(() => { if (btn) { btn.innerHTML = original; updateBotButtons(); } }, 1200);
    }
}
window.saveBotConfig = saveBotConfig;

async function startBotSession() {
    const uid = botUserId();
    if (!uid || _botBusy) return;
    const cfg = readBotForm();
    const problem = botFormProblem(cfg);
    if (problem) { showBotConfigError(problem); return; }
    _botBusy = true;
    updateBotButtons();
    try {
        const data = await botPost("/api/bot/session/start", { user_id: Number(uid), ...cfg });
        showBotConfigError(null);
        renderBotSession(data.session, data.session ? data.session.scheduler_online : undefined);
        if (data.session) await loadBotActivity(data.session.id);
        loadBotSessionHistory();
    } catch (err) {
        showBotConfigError(err.message);
    } finally {
        _botBusy = false;
        updateBotButtons();
    }
}
window.startBotSession = startBotSession;

async function stopBotSession() {
    const uid = botUserId();
    if (!uid || _botBusy) return;
    if (!confirm("Stop the bot? It stops scanning and opening trades. Open auto-trades stay open and remain manageable.")) return;
    _botBusy = true;
    updateBotButtons();
    try {
        const data = await botPost("/api/bot/session/stop", { user_id: Number(uid) });
        renderBotSession(data.session, data.session ? data.session.scheduler_online : undefined);
    } catch (err) {
        showBotConfigError(err.message);
    } finally {
        _botBusy = false;
        updateBotButtons();
    }
}
window.stopBotSession = stopBotSession;

function updateBotButtons() {
    const live = botIsLive(_botSession);
    const startBtn = document.getElementById("bot-start-btn");
    const stopBtn = document.getElementById("bot-stop-btn");
    if (startBtn) startBtn.disabled = _botBusy || live;
    if (stopBtn) stopBtn.disabled = _botBusy || !live || (_botSession && _botSession.status === "STOPPING");
    const lock = document.getElementById("bot-config-lock");
    if (lock) lock.classList.toggle("hidden", !live);
    ["bot-market", "bot-capital", "bot-target", "bot-maxloss", "bot-leverage", "bot-save-btn", "bot-max-btn"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = live;
    });
    document.querySelectorAll(".bot-asset-chip").forEach(b => { b.disabled = live; });
}

function setBotBar(id, pct) {
    const el = document.getElementById(id);
    if (el) el.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
}

function renderBotSession(session, schedulerOnline) {
    _botSession = session || null;
    const s = _botSession;
    const status = s ? s.status : "STOPPED";

    const pill = document.getElementById("bot-status-pill");
    if (pill) pill.className = `bot-status-pill state-${status}`;
    safeText(document.getElementById("bot-status-text"), status.replace(/_/g, " "));

    const sched = document.getElementById("bot-scheduler-pill");
    if (sched && schedulerOnline !== undefined && schedulerOnline !== null) {
        sched.textContent = schedulerOnline ? "GO SCHEDULER ONLINE" : "GO SCHEDULER OFFLINE";
        sched.classList.toggle("online", !!schedulerOnline);
        sched.classList.toggle("offline", !schedulerOnline);
    }

    const meta = document.getElementById("bot-session-meta");
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

    const set = (id, v) => safeText(document.getElementById(id), v);
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
    const pnlEl = document.getElementById("bot-kpi-pnl");
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

function renderBotActiveTrades(trades) {
    _botActiveTradesCache = trades;
    safeText(document.getElementById("bot-active-count"), String(trades.length));
    const tbody = document.getElementById("bot-active-tbody");
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
                <td><strong>${esc(pos.symbol || pos.asset)}</strong></td>
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

function botEventRow(evt) {
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

function renderBotActivity(events) {
    const feed = document.getElementById("bot-activity-feed");
    if (!feed) return;
    feed.innerHTML = events.length
        ? events.slice(0, BOT_ACTIVITY_MAX).map(botEventRow).join("")
        : `<div class="table-empty-message">No activity yet.</div>`;
}

function appendBotEvent(evt) {
    const feed = document.getElementById("bot-activity-feed");
    if (!feed) return;
    const empty = feed.querySelector(".table-empty-message");
    if (empty) empty.remove();
    feed.insertAdjacentHTML("afterbegin", botEventRow(evt));
    while (feed.children.length > BOT_ACTIVITY_MAX) feed.removeChild(feed.lastElementChild);
}

async function loadBotActivity(sessionId) {
    const uid = botUserId();
    if (!uid || !sessionId) return;
    try {
        const data = await botFetch(`/api/bot/session/${encodeURIComponent(sessionId)}/activity?user_id=${encodeURIComponent(uid)}&limit=100`);
        renderBotActivity(data.events || []);
    } catch (err) {
        console.warn("[Bot] activity load failed:", err);
    }
}

function handleBotEvent(evt) {
    if (!evt) return;
    if (_botSession && evt.session_id !== _botSession.id) {
        // A newer session (e.g. started from another tab): reload the page state.
        if (evt.session_id > _botSession.id) refreshBotControlCenter().catch(() => {});
        return;
    }
    appendBotEvent(evt);
    if (["TRADE_CLOSED", "TARGET_REACHED", "MAX_LOSS_REACHED"].includes(evt.event)) {
        loadBotTradeHistory();
        loadBotSessionHistory();
    }
}

function handleBotSessionUpdate(snap) {
    if (!snap) return;
    if (_botSession && snap.id < _botSession.id) return;
    const wasLive = botIsLive(_botSession);
    renderBotSession(snap, snap.scheduler_online);
    if (wasLive && !botIsLive(snap)) loadBotSessionHistory();
}

function switchBotHistoryTab(tab) {
    document.getElementById("bot-hist-btn-trades")?.classList.toggle("active", tab === "trades");
    document.getElementById("bot-hist-btn-sessions")?.classList.toggle("active", tab === "sessions");
    document.getElementById("bot-hist-trades")?.classList.toggle("hidden", tab !== "trades");
    document.getElementById("bot-hist-sessions")?.classList.toggle("hidden", tab !== "sessions");
}
window.switchBotHistoryTab = switchBotHistoryTab;

async function loadBotTradeHistory() {
    const uid = botUserId();
    const tbody = document.getElementById("bot-hist-trades-tbody");
    if (!uid || !tbody) return;
    try {
        const data = await botFetch(`/api/trades/history?user_id=${encodeURIComponent(uid)}&source=bot&limit=25&offset=0`);
        const trades = data.trades || [];
        safeText(document.getElementById("bot-hist-trades-count"), String(data.total || 0));
        tbody.innerHTML = trades.length ? trades.map(t => {
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
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="11" class="table-empty-message text-red">Failed to load auto-trade history: ${esc(err.message)}</td></tr>`;
    }
}

async function loadBotSessionHistory() {
    const uid = botUserId();
    const tbody = document.getElementById("bot-hist-sessions-tbody");
    if (!uid || !tbody) return;
    try {
        const data = await botFetch(`/api/bot/session/history?user_id=${encodeURIComponent(uid)}&limit=20`);
        const sessions = data.sessions || [];
        safeText(document.getElementById("bot-hist-sessions-count"), String(data.total || 0));
        tbody.innerHTML = sessions.length ? sessions.map(s => {
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
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="12" class="table-empty-message text-red">Failed to load session history: ${esc(err.message)}</td></tr>`;
    }
}

// Smooth scroll to login section
function scrollToLogin() {
    if (landingPage && landingPage.classList.contains("hidden")) {
        landingPage.classList.remove("hidden");
    }
    if (dashboardPage && !dashboardPage.classList.contains("hidden")) {
        dashboardPage.classList.add("hidden");
    }
    if (loginSection) {
        loginSection.scrollIntoView({ behavior: 'smooth' });
    }
}
window.scrollToLogin = scrollToLogin;

if (navLoginBtn) navLoginBtn.addEventListener("click", (e) => { e.preventDefault(); scrollToLogin(); });
if (getStartedBtn) getStartedBtn.addEventListener("click", (e) => { e.preventDefault(); scrollToLogin(); });

// -------------------------------------------------------------
//   AUTHENTICATION & PORTAL LOGIC (Login / Sign Up / OTP)
// -------------------------------------------------------------

// -------------------------------------------------------------
// -------------------------------------------------------------
//   CLERK AUTHENTICATION (HEADLESS CUSTOM UI ENGINE)
// -------------------------------------------------------------
let clerkInstance = null;
let isClerkActive = false;
let clerkInitPromise = null;

// Sync Clerk user with PostgreSQL / SQLite database and launch terminal
let _clerkSyncInFlight = null;

// The session listener and the redirect handler can both fire for one sign-in;
// run the database sync and dashboard entry once.
function syncClerkUserAndEnter(u) {
    if (!_clerkSyncInFlight) {
        _clerkSyncInFlight = _syncClerkUserAndEnter(u).finally(() => { _clerkSyncInFlight = null; });
    }
    return _clerkSyncInFlight;
}

async function _syncClerkUserAndEnter(u) {
    if (!u) return false;

    const userEmail = (u.primaryEmailAddress && u.primaryEmailAddress.emailAddress) ||
                      (u.emailAddresses && u.emailAddresses[0] && u.emailAddresses[0].emailAddress) || "";

    let displayName = u.fullName || u.username || "";
    if (!displayName && u.firstName) {
        displayName = u.firstName + (u.lastName ? " " + u.lastName : "");
    }
    if (!displayName && userEmail) {
        displayName = userEmail.split("@")[0];
    }
    if (!displayName) {
        displayName = "Google Trader";
    }

    try {
        const syncRes = await fetch("/api/auth/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: userEmail,
                username: displayName,
                clerk_id: u.id
            })
        });

        const data = await syncRes.json();
        if (data && data.ok && data.user_id) {
            console.log(`[Orbit Auth] Clerk user ${displayName} (${userEmail}) stored in DB user #${data.user_id}`);
            sessionStorage.removeItem("orbit_oauth_in_progress");
            enterDashboard(data.username || displayName, data.user_id);
            return true;
        } else {
            console.warn("[Orbit Auth] DB sync response not ok:", data);
        }
    } catch (err) {
        console.error("[Orbit Auth] Failed to sync Clerk user with database:", err);
    }

    sessionStorage.removeItem("orbit_oauth_in_progress");
    // Never enter without a real account id: this used to fall back to user #18,
    // i.e. somebody else's portfolio.
    showAuthError("Signed in with Google, but your trading account could not be loaded. Please try again.");
    return false;
}
window.syncClerkUserAndEnter = syncClerkUserAndEnter;

// URL of this single-page app with an optional hash (#dashboard, #sso-callback).
function clerkAppUrl(hash) {
    return window.location.origin + window.location.pathname + (hash || "");
}

function showAuthError(message) {
    const el = document.getElementById("login-error") || document.getElementById("signup-error");
    if (el) {
        el.textContent = message;
        el.classList.remove("hidden");
    }
    if (loginSection) loginSection.scrollIntoView({ behavior: "smooth" });
}

// True when Clerk's client holds a sign-in/sign-up attempt this page can finish.
function clerkHasOAuthAttempt(client) {
    const signIn = client && client.signIn;
    const signUp = client && client.signUp;
    const ffv = signIn && signIn.firstFactorVerification;
    const ext = signUp && signUp.verifications && signUp.verifications.externalAccount;
    return !!((signIn && signIn.status) || (ffv && ffv.status) || (signUp && signUp.status) || (ext && ext.status));
}

// Clerk's own view of an unfinished Google attempt, for the error message and console.
function clerkOAuthDiagnosis(client) {
    const parts = [];
    const describe = (label, status, err) => {
        if (!status && !err) return;
        let text = label + ": " + (status || "none");
        if (err) text += " — " + (err.longMessage || err.message || "") + (err.code ? " [" + err.code + "]" : "");
        parts.push(text);
    };
    const signIn = client && client.signIn;
    const signUp = client && client.signUp;
    if (signIn) {
        const ffv = signIn.firstFactorVerification || {};
        describe("sign-in", signIn.status, null);
        describe("Google verification", ffv.status, ffv.error);
    }
    if (signUp) {
        const ext = (signUp.verifications && signUp.verifications.externalAccount) || {};
        describe("sign-up", signUp.status, null);
        describe("Google account", ext.status, ext.error);
    }
    return parts.join("; ");
}

// Same-origin navigations requested by Clerk stay inside this page (no reload,
// no detour through the hosted Account Portal); other origins are followed.
function clerkRouterNavigate(to) {
    const url = new URL(to, window.location.href);
    if (url.origin !== window.location.origin) {
        window.location.href = url.href;
        return;
    }
    history.replaceState(null, "", url.pathname + url.search + url.hash);
}

async function initClerkAuth() {
    if (clerkInitPromise) return clerkInitPromise;
    clerkInitPromise = (async () => {
        try {
            let pubKey = "";
            try {
                const cfgRes = await fetch("/api/auth/config");
                if (cfgRes.ok) {
                    const cfgData = await cfgRes.json();
                    if (cfgData.clerk_publishable_key) {
                        pubKey = cfgData.clerk_publishable_key;
                    }
                }
            } catch (cfgErr) {
                console.warn("[Orbit Auth] Auth config fetch failed:", cfgErr);
            }

            if (!pubKey) {
                console.log("[Orbit Auth] Clerk publishable key not configured in environment.");
                return null;
            }

            const clerkScript = document.querySelector('script[src*="clerk"]');
            if (clerkScript && !clerkScript.getAttribute("data-clerk-publishable-key")) {
                clerkScript.setAttribute("data-clerk-publishable-key", pubKey);
            }

            // Wait for Clerk SDK to be defined in global scope
            let attempts = 0;
            while (!window.Clerk && attempts < 40) {
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }

            if (window.Clerk) {
                const loadOptions = {
                    publishableKey: pubKey,
                    routerPush: clerkRouterNavigate,
                    routerReplace: clerkRouterNavigate,
                };
                if (typeof window.Clerk === "function") {
                    clerkInstance = new window.Clerk(pubKey);
                    await clerkInstance.load(loadOptions);
                } else {
                    clerkInstance = window.Clerk;
                    if (typeof clerkInstance.load === "function") {
                        await clerkInstance.load(loadOptions);
                    }
                }
                isClerkActive = true;
                console.log("[Orbit Auth] Clerk Headless SDK loaded with custom UI.");

                // Only finish a redirect when this tab started "Continue with Google"
                // in the last 15 minutes AND Clerk has that attempt on record. The dev
                // instance adds __clerk_db_jwt to every URL (so "__clerk" in the address
                // proves nothing), and older builds left a "1" marker behind after a
                // failed attempt, which made a plain reload look like an OAuth return.
                const oauthStartedAt = Number(sessionStorage.getItem("orbit_oauth_in_progress") || 0);
                const oauthFresh = oauthStartedAt > 1 && Date.now() - oauthStartedAt < 15 * 60 * 1000;
                const returningFromOAuth = (oauthFresh || window.location.hash.includes("sso-callback"))
                    && clerkHasOAuthAttempt(clerkInstance.client);
                if (!returningFromOAuth) {
                    sessionStorage.removeItem("orbit_oauth_in_progress");
                    if (window.location.hash.includes("sso-")) {
                        history.replaceState(null, "", window.location.pathname + window.location.search);
                    }
                }

                // Enter as soon as a session becomes active.
                if (typeof clerkInstance.addListener === "function") {
                    clerkInstance.addListener(async (state) => {
                        if (state && state.user && state.session) {
                            if (!currentUserId || !document.body.classList.contains("in-dashboard")) {
                                await syncClerkUserAndEnter(state.user);
                            }
                        }
                    });
                }

                if (returningFromOAuth && !clerkInstance.session && typeof clerkInstance.handleRedirectCallback === "function") {
                    // Finish the Google round-trip on this page. Called without URLs,
                    // Clerk sends the user to the instance's hosted default-redirect,
                    // which lands on the marketing page instead of the dashboard.
                    const dashboardUrl = clerkAppUrl("#dashboard");
                    const hereUrl = clerkAppUrl("#login");
                    let unsupportedStep = null;
                    try {
                        await clerkInstance.handleRedirectCallback({
                            signInForceRedirectUrl: dashboardUrl,
                            signUpForceRedirectUrl: dashboardUrl,
                            signInFallbackRedirectUrl: dashboardUrl,
                            signUpFallbackRedirectUrl: dashboardUrl,
                            // Steps this custom UI has no screen for stay on this page.
                            signInUrl: hereUrl,
                            signUpUrl: hereUrl,
                            continueSignUpUrl: clerkAppUrl("#sso-continue"),
                            firstFactorUrl: clerkAppUrl("#sso-factor-one"),
                            secondFactorUrl: clerkAppUrl("#sso-factor-two"),
                            resetPasswordUrl: clerkAppUrl("#sso-reset-password"),
                        }, (to) => {
                            const url = new URL(to, window.location.href);
                            if (url.origin === window.location.origin && url.hash !== "#dashboard") {
                                unsupportedStep = url.hash.replace("#", "");
                            }
                            clerkRouterNavigate(to);
                        });
                    } catch (cbErr) {
                        console.warn("[Orbit Auth] Clerk redirect callback:", cbErr);
                        const detail = (cbErr && cbErr.errors && cbErr.errors[0] && (cbErr.errors[0].longMessage || cbErr.errors[0].message))
                            || (cbErr && cbErr.message) || String(cbErr);
                        showAuthError("Google sign-in could not be completed: " + detail);
                    }

                    if (!clerkInstance.session) {
                        sessionStorage.removeItem("orbit_oauth_in_progress");
                        const signUp = clerkInstance.client && clerkInstance.client.signUp;
                        const diagnosis = clerkOAuthDiagnosis(clerkInstance.client);
                        console.warn("[Orbit Auth] Google sign-in did not finish:", diagnosis || "no details", "| Clerk next step:", unsupportedStep);
                        if (signUp && signUp.status === "missing_requirements") {
                            showAuthError("Google sign-up needs more details (" + (signUp.missingFields || []).join(", ")
                                + "). Adjust the required fields in the Clerk dashboard or sign up with email.");
                        } else {
                            const errEl = document.getElementById("login-error");
                            if (!errEl || errEl.classList.contains("hidden")) {
                                showAuthError("Google sign-in did not finish (" + (diagnosis || "Clerk returned no details")
                                    + "). Please try again.");
                            }
                        }
                        // A reload must not replay the callback.
                        if (window.location.hash.includes("sso-")) {
                            history.replaceState(null, "", window.location.pathname + window.location.search);
                        }
                    }
                }

                // Signed in (just now, or already on #dashboard): sync the account and enter.
                if (clerkInstance.user && clerkInstance.session) {
                    if (returningFromOAuth || window.location.hash.includes("dashboard")) {
                        await syncClerkUserAndEnter(clerkInstance.user);
                    }
                }
            }
        } catch (err) {
            console.warn("[Orbit Auth] Clerk initialization:", err);
            if (window.Clerk) {
                clerkInstance = window.Clerk;
                isClerkActive = true;
            }
        }
        return clerkInstance;
    })();
    return clerkInitPromise;
}

// Immediately initialize Clerk in background
initClerkAuth();

// Helper to transition into the dashboard
function enterDashboard(username, userId) {
    currentUsername = username || "Trader Account";
    currentUserId = userId || null;
    safeText(dashboardUser, currentUsername);
    localStorage.setItem("orbit_logged_in_username", currentUsername);
    if (userId) localStorage.setItem("orbit_user_id", String(userId));
    window.location.hash = "#dashboard";

    // Update body class and stop 3D WebGL candlestick background (only runs on landing and login/signup)
    document.body.classList.add("in-dashboard");
    if (window.aether3D) window.aether3D.stop();
    const threeCanvas = document.getElementById("three-canvas");
    if (threeCanvas) {
        threeCanvas.style.display = "none";
    }

    // Hide landing wrapper & show dashboard
    if (landingPage) {
        landingPage.classList.add("hidden");
        landingPage.style.display = "none";
    }
    if (dashboardPage) {
        dashboardPage.classList.remove("hidden");
        dashboardPage.style.display = "block";
    }

    // Scroll window back to top
    window.scrollTo(0, 0);

    // Initialize connection immediately to sync DB stats and open default tab
    setTimeout(() => {
        try { connectWebSocket(); } catch (e) { console.warn("Socket connect warning:", e); }
        try { connectStreamHub(); } catch (e) { console.warn("[orbit-stream] hub connect warning:", e); }
        try { switchToTab("dashboard"); } catch (e) { console.warn("Tab switch warning:", e); }
        try { fetchGlobalNews(); } catch (e) { console.warn("News fetch warning:", e); }
    }, 50);
}
window.enterDashboard = enterDashboard;

// Direct demo access
function launchDemoDirect() {
    enterDashboard("Demo Trader", 1);
}
window.launchDemoDirect = launchDemoDirect;

// Logout handler
if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
        localStorage.removeItem("orbit_logged_in_username");
        localStorage.removeItem("orbit_user_id");
        if (isClerkActive && clerkInstance) {
            try { await clerkInstance.signOut(); } catch (e) {}
        }
        document.body.classList.remove("in-dashboard");
        const threeCanvas = document.getElementById("three-canvas");
        if (threeCanvas) threeCanvas.style.display = "block";
        if (window.aether3D) window.aether3D.start();
        if (dashboardPage) {
            dashboardPage.classList.add("hidden");
            dashboardPage.style.display = "none";
        }
        if (landingPage) {
            landingPage.classList.remove("hidden");
            landingPage.style.display = "block";
        }
        window.location.hash = "";
        window.scrollTo({ top: 0, behavior: "smooth" });
    });
}

// Switch between panels (login, signup)
function switchAuthTab(tab) {
    const tabLoginBtn = document.getElementById("tab-login-btn");
    const tabSignupBtn = document.getElementById("tab-signup-btn");
    const panelLogin = document.getElementById("panel-login");
    const panelSignup = document.getElementById("panel-signup");
    const cardTitle = document.getElementById("auth-card-title");
    const cardSubtitle = document.getElementById("auth-card-subtitle");

    // Hide any showing error messages
    const loginErr = document.getElementById("login-error");
    const signupErr = document.getElementById("signup-error");
    if (loginErr) loginErr.classList.add("hidden");
    if (signupErr) signupErr.classList.add("hidden");

    if (tab === "signup") {
        if (tabLoginBtn) tabLoginBtn.classList.remove("active");
        if (tabSignupBtn) tabSignupBtn.classList.add("active");
        if (panelLogin) panelLogin.classList.remove("active");
        if (panelSignup) panelSignup.classList.add("active");
        safeText(cardTitle, "Create Account");
        safeText(cardSubtitle, "Sign up to unlock the trading console");
    } else {
        if (tabLoginBtn) tabLoginBtn.classList.add("active");
        if (tabSignupBtn) tabSignupBtn.classList.remove("active");
        if (panelLogin) panelLogin.classList.add("active");
        if (panelSignup) panelSignup.classList.remove("active");
        safeText(cardTitle, "Terminal Access");
        safeText(cardSubtitle, "Sign in to unlock the trading console");
    }
}
window.switchAuthTab = switchAuthTab;

// Toggle password text masking
function togglePw(inputId, buttonEl) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const icon = buttonEl.querySelector("i");
    if (input.type === "password") {
        input.type = "text";
        if (icon) icon.className = "fa-solid fa-eye-slash";
    } else {
        input.type = "password";
        if (icon) icon.className = "fa-solid fa-eye";
    }
}
window.togglePw = togglePw;

// Google OAuth Authentication via Clerk
async function handleClerkGoogleAuth() {
    const btn = document.getElementById("login-google-btn") || document.getElementById("signup-google-btn");
    const originalText = btn ? btn.innerHTML : "";
    if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Connecting with Google...</span>';
        btn.style.pointerEvents = "none";
    }

    try {
        await initClerkAuth();

        if (!clerkInstance) {
            throw new Error("Clerk authentication is not ready yet. Please check your internet connection.");
        }

        // If user already has an active Clerk session, sync to DB and launch console
        if (clerkInstance.user && clerkInstance.session) {
            const synced = await syncClerkUserAndEnter(clerkInstance.user);
            if (synced) return;
        }

        // Mark OAuth in progress so the return page knows to complete transition
        sessionStorage.setItem("orbit_oauth_in_progress", String(Date.now()));

        // Google returns to #sso-callback, where initClerkAuth finishes the sign-in.
        const redirectUrl = clerkAppUrl("#sso-callback");
        const redirectUrlComplete = clerkAppUrl("#dashboard");

        const oauthParams = {
            strategy: "oauth_google",
            redirectUrl: redirectUrl,
            redirectUrlComplete: redirectUrlComplete,
            additionalData: {
                prompt: "select_account"
            },
            oidcPrompt: "select_account"
        };

        if (typeof clerkInstance.authenticateWithRedirect === "function") {
            await clerkInstance.authenticateWithRedirect(oauthParams);
            return;
        } else if (clerkInstance.client && clerkInstance.client.signIn && typeof clerkInstance.client.signIn.authenticateWithRedirect === "function") {
            await clerkInstance.client.signIn.authenticateWithRedirect(oauthParams);
            return;
        } else {
            throw new Error("Clerk OAuth redirect method unavailable.");
        }
    } catch (err) {
        console.error("Google auth error:", err);
        sessionStorage.removeItem("orbit_oauth_in_progress");
        const errorEl = document.getElementById("login-error") || document.getElementById("signup-error");
        if (errorEl) {
            errorEl.textContent = "Google login error: " + (err.message || "Failed to connect with Google.");
            errorEl.classList.remove("hidden");
        }
    } finally {
        if (btn) {
            btn.innerHTML = originalText;
            btn.style.pointerEvents = "auto";
        }
    }
}
window.handleClerkGoogleAuth = handleClerkGoogleAuth;

// Handle login submission (Direct login, zero OTP)
async function handleLogin(event) {
    event.preventDefault();
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;
    const errorEl = document.getElementById("login-error");
    const submitBtn = document.getElementById("login-submit-btn");

    if (errorEl) errorEl.classList.add("hidden");
    if (submitBtn) submitBtn.disabled = true;

    // 1. Clerk Headless Custom UI Flow
    if (isClerkActive && clerkInstance) {
        try {
            const signInAttempt = await clerkInstance.client.signIn.create({
                identifier: username,
                password: password
            });

            if (signInAttempt.status === "complete") {
                await clerkInstance.setActive({ session: signInAttempt.createdSessionId });
                const u = clerkInstance.user;
                await syncClerkUserAndEnter(u);
                if (submitBtn) submitBtn.disabled = false;
                return;
            }
        } catch (err) {
            console.warn("[Clerk direct login failed, trying local engine]:", err);
        }
    }

    // 2. Direct Local Auth Engine Fallback
    try {
        const response = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (response.ok) {
            enterDashboard(data.username, data.user_id || data.id || null);
        } else {
            const msg = (typeof data.detail === "string" ? data.detail : data.detail && data.detail.message) || "Invalid credentials.";
            if (errorEl) {
                errorEl.textContent = msg;
                errorEl.classList.remove("hidden");
            }
        }
    } catch (err) {
        console.error("Login request error:", err);
        if (errorEl) {
            errorEl.textContent = "Network error. Make sure backend is running.";
            errorEl.classList.remove("hidden");
        }
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}
window.handleLogin = handleLogin;

// Handle registration submission (Direct account creation, zero OTP)
async function handleSignup(event) {
    event.preventDefault();
    const email = document.getElementById("signup-email").value.trim();
    const username = document.getElementById("signup-username").value.trim();
    const password = document.getElementById("signup-password").value;
    const confirm = document.getElementById("signup-confirm").value;
    const errorEl = document.getElementById("signup-error");
    const submitBtn = document.getElementById("signup-submit-btn");

    if (errorEl) errorEl.classList.add("hidden");

    if (password !== confirm) {
        if (errorEl) {
            errorEl.textContent = "Passwords do not match.";
            errorEl.classList.remove("hidden");
        }
        return;
    }

    if (submitBtn) submitBtn.disabled = true;

    try {
        // Direct registration via backend (creates account, marks active, and syncs with Clerk)
        const response = await fetch("/api/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, email, password })
        });

        const data = await response.json();

        if (response.ok) {
            // Activate Clerk session immediately if ticket returned
            if (data.clerk_token && isClerkActive && clerkInstance) {
                try {
                    const signInAttempt = await clerkInstance.client.signIn.create({
                        ticket: data.clerk_token
                    });
                    if (signInAttempt.status === "complete") {
                        await clerkInstance.setActive({ session: signInAttempt.createdSessionId });
                    }
                } catch (cErr) {
                    console.warn("[Clerk session activation]:", cErr);
                }
            }

            // Direct entry into dashboard with custom UI
            enterDashboard(data.username || username, data.user_id || null);
        } else {
            if (errorEl) {
                errorEl.textContent = data.detail || "Registration failed.";
                errorEl.classList.remove("hidden");
            }
        }
    } catch (err) {
        console.error("Signup error:", err);
        if (errorEl) {
            errorEl.textContent = "Connection error. Please try again.";
            errorEl.classList.remove("hidden");
        }
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}
window.handleSignup = handleSignup;

// Bind methods to window safely so inline onclick attributes resolve without ReferenceErrors
window.switchAuthTab = typeof switchAuthTab === "function" ? switchAuthTab : function() {};
window.togglePw = function(id) {
    const el = document.getElementById(id);
    if (el) el.type = el.type === "password" ? "text" : "password";
};
window.otpInputNext = function() {};
window.otpInputBack = function() {};
window.handleSignup = typeof handleSignup === "function" ? handleSignup : function() {};
window.handleLogin = typeof handleLogin === "function" ? handleLogin : function() {};
window.handleVerifyOtp = function() {};
window.handleResendOtp = function() {};


// Logout Button
logoutBtn.addEventListener("click", async () => {
    if (isClerkActive && clerkInstance) {
        try {
            await clerkInstance.signOut();
        } catch (e) {
            console.warn("Clerk sign out error:", e);
        }
    }
    // Clear persisted login session — leaving orbit_user_id behind meant the
    // next visitor on this browser reconnected as the previous account.
    localStorage.removeItem("orbit_logged_in_username");
    localStorage.removeItem("orbit_user_id");
    currentUserId = null;
    currentUsername = "Trader Account";

    // Stop agent loop if active
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: "stop" }));
    }

    // Close WebSocket and stop the reconnect loop
    _wsIntentionallyClosed = true;
    clearTimeout(_wsReconnectTimer);
    if (socket) {
        socket.close();
        socket = null;
    }

    setAnalyzingMode(false);
    resetGauges();
    clearPriceLines();

    // Reset sub-views
    terminalActiveTradingView.classList.add("hidden-tab");
    terminalStockSelectView.classList.remove("hidden-tab");
    showSRLevels = false;
    btnDrawSR.classList.remove("active-btn");

    // Restart 3D background for landing page
    document.body.classList.remove("in-dashboard");
    const threeCanvas = document.getElementById("three-canvas");
    if (threeCanvas) threeCanvas.style.display = "block";
    if (window.aether3D) window.aether3D.start();

    // Transition back to landing page
    dashboardPage.classList.add("hidden");
    landingPage.classList.remove("hidden");

    // Reset landing page scroll to the top
    window.scrollTo(0, 0);
});

// -------------------------------------------------------------
//  SYMBOL MAPPING  (Yahoo Finance  →  TradingView)
// -------------------------------------------------------------
const SYMBOL_MAP = {
    // Crypto
    "BTC-USD": "BINANCE:BTCUSDT",
    "ETH-USD": "BINANCE:ETHUSDT",
    "BNB-USD": "BINANCE:BNBUSDT",
    "SOL-USD": "BINANCE:SOLUSDT",
    "XRP-USD": "BINANCE:XRPUSDT",
    "ADA-USD": "BINANCE:ADAUSDT",
    "DOGE-USD": "BINANCE:DOGEUSDT",
    "MATIC-USD": "BINANCE:MATICUSDT",
    "DOT-USD": "BINANCE:DOTUSDT",
    "AVAX-USD": "BINANCE:AVAXUSDT",
    "LTC-USD": "BINANCE:LTCUSDT",
    "LINK-USD": "BINANCE:LINKUSDT",
    // US Indices
    "SPY": "AMEX:SPY",
    "QQQ": "NASDAQ:QQQ",
    "DIA": "AMEX:DIA",
    // Forex
    "EURUSD=X": "FX:EURUSD",
    "GBPUSD=X": "FX:GBPUSD",
    "USDINR=X": "FX:USDINR",
    "JPYUSD=X": "FX:USDJPY",
};

function toTVSymbol(raw) {
    const upper = raw.trim().toUpperCase();
    if (SYMBOL_MAP[upper]) return SYMBOL_MAP[upper];
    if (upper.endsWith(".NS")) return "NSE:" + upper.replace(".NS", "");
    if (upper.endsWith(".BO")) return "BSE:" + upper.replace(".BO", "");
    if (upper.includes("-USD")) {
        // Generic crypto: XYZ-USD → BINANCE:XYZUSDT
        return "BINANCE:" + upper.replace("-USD", "USDT");
    }
    // Default: treat as a US stock/index
    return upper;
}

// Initialize (or reinitialize) TradingView Advanced Widget
function initChart(symbol, interval) {
    const container = document.getElementById("tradingview-widget-container");
    if (!container) return;
    container.innerHTML = ""; // Destroy old widget

    // tv.js is loaded from a CDN; if it is blocked the widget constructor
    // throws and takes the rest of prepareTradeEnvironment() down with it.
    if (typeof TradingView === "undefined" || !TradingView.widget) {
        container.innerHTML = '<div class="news-loading">Chart library unavailable — check your network connection. Agent analysis still runs.</div>';
        logToTerminal("SYSTEM", "TradingView chart library could not be loaded. Continuing without the chart.");
        return;
    }

    const tvSymbol = toTVSymbol(symbol || "BTC-USD");
    const tvInterval = interval || currentInterval || "5";

    // The container is absolutely positioned inside chart-body which has fixed height.
    // We can use the container directly as the widget target.
    container.id = "tradingview-widget-container"; // keep id stable

    tvWidget = new TradingView.widget({
        container_id: "tradingview-widget-container",
        autosize: true,
        symbol: tvSymbol,
        interval: tvInterval,
        timezone: "Asia/Kolkata",
        theme: "dark",
        style: "1",
        locale: "en",
        toolbar_bg: "#0e1013",
        enable_publishing: false,
        allow_symbol_change: true,
        hide_side_toolbar: false,
        withdateranges: true,
        save_image: false,
        details: false,
        show_popup_button: true,
        popup_width: "1200",
        popup_height: "800",
        backgroundColor: "#0e1013",
        gridColor: "rgba(35,38,43,0.55)",
        symbol_change_callback: (newSymbol) => {
            const sym = newSymbol.toUpperCase();
            currentAsset = sym;
            currentAssetTitle.textContent = `${sym} Real-Time Chart`;
            activeTickerDisplay.textContent = sym;
            
            // Clear old agent data and overlay since the chart changed
            resetGauges();
            clearPriceLines();
            clearSignalPanel();
            resetAgentTicks();
            window.lastSupports = [];
            window.lastResistances = [];
            window.lastLiquidity = [];
            window._lastSignalEntry = null;
            window._lastSignalSL = null;
            window._lastSignalTarget = null;
            drawChartOverlay(true);
            
            // Fetch news for the new symbol
            fetchNews(sym);
            
            logToTerminal("SYSTEM", `Chart manually switched to ${sym}. Launching AI Crew automatically...`);
            systemStatus.innerHTML = '<span class="status-dot green-glow"></span> READY';
            
            setTimeout(() => {
                runAgentCrew();
            }, 500);
        },
    });
}

// Change chart symbol WITHOUT rebuilding the whole widget
function changeChartSymbol(symbol) {
    const tvSymbol = toTVSymbol(symbol);
    if (tvWidget && tvWidget.chart) {
        tvWidget.chart().setSymbol(tvSymbol, () => {
            console.log("Symbol changed to:", tvSymbol);
        });
    } else {
        initChart(symbol);
    }
}

// -------------------------------------------------------------
//  TIMEFRAME SWITCHER
// -------------------------------------------------------------
let currentInterval = "5"; // default: 5-minute

// Wire up the TF buttons once DOM is ready
document.querySelectorAll(".tf-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const tf = btn.getAttribute("data-tf");
        setTimeframe(tf);
    });
});

function setTimeframe(tf) {
    currentInterval = tf;
    currentTimeframe = tf;

    // Update active button highlight
    document.querySelectorAll(".tf-btn").forEach(b => b.classList.remove("tf-active"));
    const activeBtn = document.querySelector(`.tf-btn[data-tf="${tf}"]`);
    if (activeBtn) activeBtn.classList.add("tf-active");

    // If widget is live, change its interval directly (no full reload)
    if (tvWidget && tvWidget.chart) {
        try {
            tvWidget.chart().setResolution(String(tf), () => {
                console.log("Timeframe set to:", tf);
            });
        } catch (e) {
            // Widget iframe not fully ready — reinit with new interval
            initChart(currentAsset, tf);
        }
    }
}
// Stub functions kept for WebSocket data handlers that still call them
function drawPriceLine() { }
function clearPriceLines() { activePriceLines = []; }
function clearSRLines() { drawChartOverlay(true); }  // clear when called
function drawSRLines() { drawChartOverlay(); }

// ─── CHART OVERLAY — S/R, Liquidity and Trade Zone fills on canvas ───
function drawChartOverlay(clearOnly = false) {
    const canvas = document.getElementById("chart-overlay-canvas");
    if (!canvas) return;
    const container = document.getElementById("chart-container");
    if (!container) return;

    // Match canvas pixel dimensions to its CSS size
    canvas.width = container.offsetWidth;
    canvas.height = container.offsetHeight;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (clearOnly) return;

    const supports = window.lastSupports || [];
    const resistances = window.lastResistances || [];
    const liquidity = window.lastLiquidity || [];
    const entryPrice = window._lastSignalEntry || null;
    const slPrice = window._lastSignalSL || null;
    const targetPrice = window._lastSignalTarget || null;

    // Price range — use all known levels to compute Y mapping
    const allPrices = [...supports, ...resistances, ...liquidity];
    if (entryPrice) allPrices.push(entryPrice);
    if (slPrice) allPrices.push(slPrice);
    if (targetPrice) allPrices.push(targetPrice);
    if (allPrices.length === 0) return;

    const maxP = Math.max(...allPrices);
    const minP = Math.min(...allPrices);
    const padding = (maxP - minP) * 0.18 || 1;
    const priceTop = maxP + padding;
    const priceBottom = minP - padding;
    const priceRange = priceTop - priceBottom;

    function priceToY(p) {
        return canvas.height - ((p - priceBottom) / priceRange) * canvas.height;
    }

    function drawPillLabel(text, x, y, bgColor, textColor, align = "right") {
        ctx.save();
        ctx.font = "bold 10px monospace";
        const textW = ctx.measureText(text).width;
        const padH = 6, padV = 4;
        const bw = textW + padH * 2;
        const bh = 16;
        const bx = align === "right" ? x - bw - 4 : x + 4;
        const by = y - bh / 2;
        ctx.fillStyle = bgColor;
        ctx.globalAlpha = 0.92;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 4);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = textColor || "#000";
        ctx.textAlign = align;
        const tx = align === "right" ? x - padH : x + padH;
        ctx.fillText(text, tx, y + 4);
        ctx.restore();
    }

    function drawLine(price, color, dash, labelText, lineWidth) {
        const y = priceToY(price);
        if (y < -2 || y > canvas.height + 2) return;
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash(dash || []);
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth || 1.5;
        ctx.globalAlpha = 0.88;
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
        ctx.restore();
        if (labelText) {
            drawPillLabel(labelText, canvas.width, y, color, "#000");
        }
    }

    // Draw Support/Resistance as a rectangular zone (square line)
    function drawZone(price, isSupport) {
        const y = priceToY(price);
        if (y < -10 || y > canvas.height + 10) return;

        // Zone width/height (approx 0.5% of asset price range)
        const zoneHeightPrice = (maxP - minP) * 0.012 || 1;
        const yTop = priceToY(price + zoneHeightPrice / 2);
        const yBottom = priceToY(price - zoneHeightPrice / 2);
        const h = Math.abs(yBottom - yTop);

        ctx.save();
        ctx.fillStyle = isSupport ? "rgba(63,185,80,0.06)" : "rgba(229,72,77,0.06)";
        ctx.fillRect(0, yTop, canvas.width, h);

        // Draw dashed outlines for the zone boundary
        ctx.strokeStyle = isSupport ? "rgba(63,185,80,0.35)" : "rgba(229,72,77,0.35)";
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, yTop);
        ctx.lineTo(canvas.width, yTop);
        ctx.moveTo(0, yBottom);
        ctx.lineTo(canvas.width, yBottom);
        ctx.stroke();
        ctx.restore();

        const label = isSupport ? `SUP ZONE ${price.toFixed(2)}` : `RES ZONE ${price.toFixed(2)}`;
        drawPillLabel(label, canvas.width, y, isSupport ? "#3fb950" : "#e5484d", "#000");
    }

    // ─────────────────────────────────────────────
    //  STEP 1: Draw GREEN profit zone (entry → target)
    // ─────────────────────────────────────────────
    if (entryPrice && targetPrice) {
        const yEntry = priceToY(entryPrice);
        const yTarget = priceToY(targetPrice);
        const yTop = Math.min(yEntry, yTarget);
        const yBot = Math.max(yEntry, yTarget);
        const zoneH = yBot - yTop;

        // Gradient fill
        const greenGrad = ctx.createLinearGradient(0, yTop, 0, yBot);
        greenGrad.addColorStop(0, "rgba(63,185,80,0.20)");
        greenGrad.addColorStop(1, "rgba(63,185,80,0.03)");
        ctx.save();
        ctx.fillStyle = greenGrad;
        ctx.fillRect(0, yTop, canvas.width, zoneH);
        ctx.restore();

        // Left badge: profit %
        if (entryPrice > 0 && zoneH > 14) {
            const profitPct = (Math.abs(targetPrice - entryPrice) / entryPrice * 100).toFixed(2);
            const midY = (yTop + yBot) / 2;
            ctx.save();
            ctx.font = "bold 10px monospace";
            const label = `▲ +${profitPct}% PROFIT`;
            const tw = ctx.measureText(label).width + 12;
            ctx.fillStyle = "rgba(63,185,80,0.18)";
            ctx.beginPath();
            ctx.roundRect(6, midY - 9, tw, 17, 4);
            ctx.fill();
            ctx.fillStyle = "#3fb950";
            ctx.globalAlpha = 1;
            ctx.textAlign = "left";
            ctx.fillText(label, 12, midY + 4);
            ctx.restore();
        }
    }

    // ─────────────────────────────────────────────
    //  STEP 2: Draw RED risk zone (entry → SL)
    // ─────────────────────────────────────────────
    if (entryPrice && slPrice) {
        const yEntry = priceToY(entryPrice);
        const ySL = priceToY(slPrice);
        const yTop = Math.min(yEntry, ySL);
        const yBot = Math.max(yEntry, ySL);
        const zoneH = yBot - yTop;

        // Gradient fill (flipped — denser at SL edge)
        const redGrad = ctx.createLinearGradient(0, yTop, 0, yBot);
        redGrad.addColorStop(0, "rgba(229,72,77,0.03)");
        redGrad.addColorStop(1, "rgba(229,72,77,0.22)");
        ctx.save();
        ctx.fillStyle = redGrad;
        ctx.fillRect(0, yTop, canvas.width, zoneH);
        ctx.restore();

        // Left badge: risk %
        if (entryPrice > 0 && zoneH > 14) {
            const riskPct = (Math.abs(entryPrice - slPrice) / entryPrice * 100).toFixed(2);
            const midY = (yTop + yBot) / 2;
            ctx.save();
            ctx.font = "bold 10px monospace";
            const label = `▼ -${riskPct}% RISK`;
            const tw = ctx.measureText(label).width + 12;
            ctx.fillStyle = "rgba(229,72,77,0.18)";
            ctx.beginPath();
            ctx.roundRect(6, midY - 9, tw, 17, 4);
            ctx.fill();
            ctx.fillStyle = "#e5484d";
            ctx.globalAlpha = 1;
            ctx.textAlign = "left";
            ctx.fillText(label, 12, midY + 4);
            ctx.restore();
        }
    }

    // ─────────────────────────────────────────────
    //  STEP 3: S/R zones and Liquidity tags (over zones)
    // ─────────────────────────────────────────────
    supports.forEach(p => drawZone(p, true));
    resistances.forEach(p => drawZone(p, false));

    // Draw Liquidity NOT as a full line, but as small dashed segment on the right side with a $$$ badge
    liquidity.forEach(p => {
        const y = priceToY(p);
        if (y < 0 || y > canvas.height) return;
        ctx.save();

        // Draw a short dotted horizontal line on the right side (width of 80px)
        ctx.beginPath();
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = "#a371f7";
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.75;
        ctx.moveTo(canvas.width - 130, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();

        // Draw a small "$$$" badge to represent liquidity pool
        ctx.fillStyle = "rgba(163,113,247,0.15)";
        ctx.beginPath();
        ctx.roundRect(canvas.width - 165, y - 8, 30, 16, 4);
        ctx.fill();
        ctx.fillStyle = "#a371f7";
        ctx.font = "bold 10px monospace";
        ctx.textAlign = "center";
        ctx.fillText("$$$", canvas.width - 150, y + 4);
        ctx.restore();

        // Draw standard price tag on the far right
        drawPillLabel(`LIQ ${p.toFixed(2)}`, canvas.width, y, "#a371f7", "#000");
    });

    // ─────────────────────────────────────────────
    //  STEP 4: Signal lines (topmost — solid + thick)
    // ─────────────────────────────────────────────
    if (entryPrice) drawLine(entryPrice, "#4d7cfe", [], `● ENTRY   ${entryPrice.toFixed(2)}`, 2.5);
    if (targetPrice) drawLine(targetPrice, "#3fb950", [4, 3], `▲ TARGET  ${targetPrice.toFixed(2)}`, 2.0);
    if (slPrice) drawLine(slPrice, "#e5484d", [4, 3], `▼ SL      ${slPrice.toFixed(2)}`, 2.0);
}

// ─── TRADE CONFIRMATION MODAL ───
let pendingTradeData = null;

function showTradeConfirmModal(data) {
    pendingTradeData = data;
    window._lastSignalEntry = data.entry;
    window._lastSignalSL = data.sl;
    window._lastSignalTarget = data.target;
    drawChartOverlay(); // draw entry/sl/target lines on chart

    const modal = document.getElementById("trade-confirm-modal");
    if (!modal) return;

    const direction = data.direction || (data.entry > data.sl ? "BUY" : "SELL");
    const dirEl = document.getElementById("tc-direction");
    dirEl.textContent = direction.toUpperCase();
    dirEl.className = "tc-val " + (direction === "buy" ? "text-green" : "text-red");

    document.getElementById("tc-entry").textContent = formatINR(data.entry);
    document.getElementById("tc-sl").textContent = formatINR(data.sl);
    document.getElementById("tc-target").textContent = formatINR(data.target);

    const risk = Math.abs(data.entry - data.sl);
    const reward = Math.abs(data.target - data.entry);
    const rr = risk > 0 ? (reward / risk).toFixed(2) : "—";
    document.getElementById("tc-rr").textContent = `${rr} : 1`;

    const capital = data.capital_required || (data.quantity ? data.quantity * data.entry : null);
    document.getElementById("tc-capital").textContent = capital ? formatINR(capital) : "—";

    const maxRisk = data.quantity ? Math.abs(data.entry - data.sl) * data.quantity : null;
    document.getElementById("tc-max-risk").textContent = maxRisk ? formatINR(maxRisk) : "—";

    modal.classList.remove("hidden");
    logToTerminal("Risk Planner", `📋 Trade confirmation required: ${direction.toUpperCase()} @ Entry ${formatINR(data.entry)} | SL ${formatINR(data.sl)} | TP ${formatINR(data.target)}`);
}

function confirmTrade() {
    const modal = document.getElementById("trade-confirm-modal");
    if (modal) modal.classList.add("hidden");

    if (!pendingTradeData) return;
    const d = pendingTradeData;
    pendingTradeData = null;

    // Show in signal panel
    updateSignalPanel(d.entry, d.sl, d.target);

    // Tell backend to execute via websocket confirm message
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            action: "confirm_trade",
            trade_id: d.trade_id || null
        }));
    }
    logToTerminal("Execution Agent", "✅ Trade confirmed by trader. Submitting order...");
}

function rejectTrade() {
    const modal = document.getElementById("trade-confirm-modal");
    if (modal) modal.classList.add("hidden");
    pendingTradeData = null;

    // Cancel on backend
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: "cancel_trade" }));
    }
    // Clear chart lines
    window._lastSignalEntry = null;
    window._lastSignalSL = null;
    window._lastSignalTarget = null;
    drawChartOverlay();
    logToTerminal("Risk Planner", "🚫 Trade skipped by trader.");
}

window.confirmTrade = confirmTrade;
window.rejectTrade = rejectTrade;

// Format currency in INR
function formatINR(number) {
    return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 2
    }).format(number);
}

// Add a log to the terminal (capped at MAX_LOG_LINES to prevent memory leak)
function logToTerminal(agent, message, timestamp) {
    const consoleLogsElement = document.getElementById("console-logs") || consoleLogs;
    if (!consoleLogsElement) return;
    const timeStr = timestamp || new Date().toLocaleTimeString();
    const logLine = document.createElement("div");
    logLine.className = `log-line agent-${agent.toLowerCase().replace(/[^a-z0-9]/g, "-")}-log`;

    logLine.innerHTML = `<span class="log-time">[${esc(timeStr)}]</span> <strong>[${esc(agent)}]</strong>: ${esc(message)}`;
    consoleLogsElement.appendChild(logLine);

    // Trim oldest entries to keep DOM lean
    while (consoleLogsElement.childElementCount > MAX_LOG_LINES) {
        consoleLogsElement.removeChild(consoleLogsElement.firstChild);
    }
    consoleLogsElement.scrollTop = consoleLogsElement.scrollHeight;
}

// Update the 7-Agent visual UI in the right column
function updateAgentStatusUI(agentName, message) {
    if (!agentName || agentName === "SYSTEM") return;

    // Map backend agent names to DOM IDs
    let rowId = null;
    const nameLower = agentName.toLowerCase();

    if (nameLower.includes("chart") || nameLower.includes("level")) rowId = "chart";
    else if (nameLower.includes("indicator")) rowId = "indicators";
    else if (nameLower.includes("news")) rowId = "news";
    else if (nameLower.includes("consensus") || nameLower.includes("judge") || nameLower.includes("strategy")) rowId = "consensus";
    else if (nameLower.includes("risk")) rowId = "risk";
    else if (nameLower.includes("execution")) rowId = "execution";
    else if (nameLower.includes("monitor") || nameLower.includes("p&l") || nameLower.includes("pndl") || nameLower.includes("manager")) rowId = "monitor";

    if (!rowId) return;

    const row = document.getElementById(`agent-row-${rowId}`);
    const statusText = document.getElementById(`agent-status-${rowId}`);
    if (!row || !statusText) return;

    // If it's a detail line starting with space/tab or dash/star, ignore status updates
    const msgTrim = message.trim();
    if (message.startsWith(" ") || message.startsWith("\t") || msgTrim.startsWith("-") || msgTrim.startsWith("*")) {
        return;
    }

    // Mark as active and reset completed state
    row.classList.remove("completed-agent");
    row.classList.add("active-agent");
    statusText.textContent = "Processing...";

    // If the message sounds like a completion, mark as complete (green tick)
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

        // Advance the progress bar
        const pb = document.getElementById("atv-progress-bar");
        if (pb) {
            let cur = parseInt(pb.style.width || "0");
            if (cur < 100) pb.style.width = Math.min(100, cur + 15) + "%";
        }
    }
}


// Reset the Metrics gauges (null-safe — elements may have been removed from UI)
function resetGauges() {
    safeText(consensusSignal, "WAITING");
    safeClass(consensusSignal, "metric-value-box text-blue");
    safeText(consensusVotes, "0 of 12 voted BUY");

    safeText(sentimentMeter, "NEUTRAL");
    safeClass(sentimentMeter, "metric-value-box text-cyan");
    safeStyle(sentimentBar, "width", "50%");
    safeText(sentimentScore, "Score: 0.00");

    safeText(trendStrength, "NEUTRAL");
    safeClass(trendStrength, "metric-value-box text-yellow");
    safeText(technicalSignals, "RSI: -- | MACD: --");
}

// ── GLOBAL market news for the Dashboard panel ──
// Use rAF-based scroll with slow, readable pace (~18-20px per second)
let _newsScrollPos = 0;
function _newsRAFScroll() {
    if (_newsScrollEl && !_newsIsPaused) {
        _newsScrollPos += 0.35;
        const mid = _newsScrollEl.scrollHeight / 2;
        if (mid > 0 && _newsScrollPos >= mid) {
            _newsScrollPos = 0;
        }
        _newsScrollEl.scrollTop = _newsScrollPos;
    }
    _newsScrollRAF = requestAnimationFrame(_newsRAFScroll);
}

function stopNewsScroll() {
    if (typeof _newsScrollRAF !== "undefined" && _newsScrollRAF) {
        cancelAnimationFrame(_newsScrollRAF);
        _newsScrollRAF = null;
    }
    _newsScrollEl = null;
}

function renderGlobalNewsHeadlines(headlines) {
    const dashEl = document.getElementById("news-feed-container");
    if (!dashEl) return;

    if (!headlines || headlines.length === 0) {
        dashEl.innerHTML = `<div class="news-loading">No global headlines available right now.</div>`;
        return;
    }

    // Build fragment off-DOM to avoid layout thrash
    const frag = document.createDocumentFragment();
    headlines.forEach(item => {
        const card = document.createElement("a");
        card.className = "news-item-card";
        card.href = item.link || "#";
        card.target = "_blank";
        card.rel = "noopener noreferrer";

        let badgeClass = "badge-yellow";
        if (item.sentiment === "bullish") badgeClass = "badge-green";
        if (item.sentiment === "bearish") badgeClass = "badge-red";

        const src = item.source || "NewsAPI";
        const date = item.published ? `· ${item.published}` : "";

        card.innerHTML = `
            <div class="news-item-main">
                <h3 class="news-item-title">${esc(item.title)}</h3>
                <div class="news-item-meta">
                    <i class="fa-solid fa-newspaper"></i>
                    <span>${esc(src)} ${esc(date)}</span>
                </div>
            </div>
            <span class="badge ${badgeClass}">${esc(item.sentiment || "neutral").toUpperCase()}</span>
        `;
        frag.appendChild(card);
    });

    stopNewsScroll();
    _newsScrollPos = 0;
    dashEl.scrollTop = 0;
    dashEl.innerHTML = "";
    dashEl.appendChild(frag);

    // Seamless loop: duplicate the content once
    if (headlines.length > 2) {
        dashEl.innerHTML += dashEl.innerHTML;

        if (!dashEl._newsEventsBound) {
            dashEl._newsEventsBound = true;
            dashEl.addEventListener("mouseenter", () => { _newsIsPaused = true; }, { passive: true });
            dashEl.addEventListener("mouseleave", () => { _newsIsPaused = false; }, { passive: true });
            dashEl.addEventListener("scroll", () => {
                if (_newsIsPaused && _newsScrollEl) {
                    _newsScrollPos = _newsScrollEl.scrollTop;
                }
            }, { passive: true });
        }

        _newsScrollEl = dashEl;
        _newsIsPaused = false;
        _newsScrollRAF = requestAnimationFrame(_newsRAFScroll);
    }
}

async function fetchGlobalNews() {
    const dashEl = document.getElementById("news-feed-container");
    const dashLabel = document.getElementById("news-symbol-label");
    if (dashLabel) dashLabel.textContent = "Global Markets";
    if (!dashEl) return;

    // 1. Instant Cache-First Display (0ms visual latency)
    if (_cachedGlobalNews && Array.isArray(_cachedGlobalNews.headlines) && _cachedGlobalNews.headlines.length > 0) {
        renderGlobalNewsHeadlines(_cachedGlobalNews.headlines);
    } else {
        stopNewsScroll();
        dashEl.scrollTop = 0;
        dashEl.innerHTML = `<div class="news-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading market news…</div>`;
    }

    // 2. Background fresh revalidation
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const response = await fetch("/api/news/global", { signal: controller.signal });
        clearTimeout(timer);
        const data = await response.json();

        if (data && data.headlines && data.headlines.length > 0) {
            _cachedGlobalNews = data;
            try { sessionStorage.setItem("orbit_global_news_cache", JSON.stringify(data)); } catch (e) {}
            renderGlobalNewsHeadlines(data.headlines);
        } else if (!_cachedGlobalNews) {
            dashEl.innerHTML = `<div class="news-loading">No global headlines available right now.</div>`;
        }
    } catch (err) {
        console.warn("Global news background revalidation notice:", err.message);
        if (!_cachedGlobalNews || !_cachedGlobalNews.headlines || _cachedGlobalNews.headlines.length === 0) {
            if (dashEl) dashEl.innerHTML = `<div class="news-loading">⚠️ Could not load world market news.</div>`;
        }
    }
}

// ── Stock-specific news for the Trading Terminal vertical scroll ──
function renderSymbolHeadlines(headlines, scrollEl, symbol) {
    if (!scrollEl) return;
    if (!headlines || headlines.length === 0) {
        scrollEl.innerHTML = `<span class="news-ticker-loading">No news found for ${symbol}.</span>`;
        return;
    }

    scrollEl.innerHTML = "";
    headlines.forEach(item => {
        const row = document.createElement("a");
        row.className = "atv-news-item";
        row.href = item.link || "#";
        row.target = "_blank";
        row.rel = "noopener noreferrer";

        row.innerHTML = `
            <span class="atv-news-sentiment-dot ${esc(item.sentiment || "neutral")}"></span>
            <span class="atv-news-title">${esc(item.title)}</span>
            <span class="atv-news-source">${esc(item.source || "NewsAPI")}</span>
        `;
        scrollEl.appendChild(row);
    });

    scrollEl.innerHTML += scrollEl.innerHTML;
    // Slow, comfortable reading speed: ~12-14px per second
    const singleSetHeight = scrollEl.scrollHeight / 2;
    const duration = Math.max(50, Math.floor(singleSetHeight / 14));
    scrollEl.style.animation = `newsScrollUp ${duration}s linear infinite`;
}

async function fetchNews(symbol) {
    const scrollEl = document.getElementById("atv-news-scroll");
    if (!scrollEl) return;

    const upperSym = (symbol || "").toUpperCase();
    if (_symbolNewsCache[upperSym] && _symbolNewsCache[upperSym].length > 0) {
        renderSymbolHeadlines(_symbolNewsCache[upperSym], scrollEl, symbol);
    } else {
        scrollEl.innerHTML = `<span class="news-ticker-loading">📡 Fetching news for ${symbol}…</span>`;
        scrollEl.style.animation = "none";
    }

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3500);
        const response = await fetch(`/api/news?symbol=${encodeURIComponent(symbol)}`, { signal: controller.signal });
        clearTimeout(timer);
        const data = await response.json();

        if (data && data.headlines && data.headlines.length > 0) {
            _symbolNewsCache[upperSym] = data.headlines;
            renderSymbolHeadlines(data.headlines, scrollEl, symbol);
        } else if (!_symbolNewsCache[upperSym]) {
            scrollEl.innerHTML = `<span class="news-ticker-loading">No news found for ${symbol}.</span>`;
        }
    } catch (err) {
        console.warn(`News fetch notice for ${symbol}:`, err.message);
        if (!_symbolNewsCache[upperSym]) {
            scrollEl.innerHTML = `<span class="news-ticker-loading">⚠️ Could not load news for ${symbol}.</span>`;
        }
    }
}


// Update Overview Tab stats and distributions
function updateOverviewMetrics(data) {
    if (data.consensus) {
        const statusEl = document.getElementById("overview-consensus-status");
        const sig = (data.consensus.signal || "").toUpperCase();
        statusEl.textContent = sig;
        statusEl.className = (sig === "BUY" || sig === "BULLISH") ? "text-green" : 
                             (sig === "SELL" || sig === "BEARISH") ? "text-red" : 
                             (sig === "MIXED") ? "text-yellow" : "text-blue";
    }
    if (data.sentiment !== undefined) {
        const statusEl = document.getElementById("overview-sentiment-status");
        statusEl.textContent = data.sentiment > 0.15 ? "BULLISH" : data.sentiment < -0.15 ? "BEARISH" : "NEUTRAL";
        statusEl.className = data.sentiment > 0.15 ? "text-green" : data.sentiment < -0.15 ? "text-red" : "text-cyan";
    }
    if (data.trend) {
        const statusEl = document.getElementById("overview-trend-status");
        statusEl.textContent = data.trend.strength.toUpperCase();
        statusEl.className = data.trend.strength.includes("uptrend") ? "text-green" : data.trend.strength.includes("downtrend") ? "text-red" : "text-yellow";
    }
}

function updateOverviewPositionsStats(positions) {
    // Only count active positions towards current live active count
    const activeCount = positions.filter(p => p.status === 'active').length;
    document.getElementById("overview-active-trades").textContent = activeCount;

    // Sum unrealized P&L
    const unrealizedPnl = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);
    const unrealizedEl = document.getElementById("overview-unrealized-pnl");
    unrealizedEl.textContent = (unrealizedPnl >= 0 ? "+" : "") + formatINR(unrealizedPnl);
    unrealizedEl.className = "stat-value " + (unrealizedPnl >= 0 ? "text-green" : "text-red");
}

function updateOverviewHistoryStats(trades) {
    // Sum realized P&L
    const realizedPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const realizedEl = document.getElementById("overview-realized-pnl");
    realizedEl.textContent = (realizedPnl >= 0 ? "+" : "") + formatINR(realizedPnl);
    realizedEl.className = "stat-value " + (realizedPnl >= 0 ? "text-green" : "text-red");

    // Win Rate Calculation — cancelled orders were never filled, so counting
    // them as losses dragged the win rate down for trades that never happened.
    const closedTrades = trades.filter(t => t.status === 'closed');
    const settledTrades = closedTrades.filter(t => t.outcome !== 'cancelled');
    const wins = settledTrades.filter(t => (t.pnl !== undefined ? t.pnl : t.realized_pnl) > 0).length;
    const losses = settledTrades.filter(t => (t.pnl !== undefined ? t.pnl : t.realized_pnl) <= 0).length;

    const winRateEl = document.getElementById("overview-win-rate");
    const barFill = document.getElementById("overview-winrate-bar");
    if (settledTrades.length > 0) {
        const winRate = (wins / settledTrades.length) * 100;
        if (winRateEl) winRateEl.textContent = `${winRate.toFixed(1)}%`;
        if (barFill) barFill.style.width = `${winRate}%`;
    } else {
        if (winRateEl) winRateEl.textContent = "—";
        if (barFill) barFill.style.width = "0%";
    }

    // Win Loss text
    const winLossText = document.getElementById("overview-win-loss-text");
    if (winLossText) {
        winLossText.textContent = `${wins} Wins | ${losses} Losses`;
    }

    // --- Populate the Overview History Panel ---
    const historyList = document.getElementById("overview-history-list");
    const historyCount = document.getElementById("overview-history-count");

    if (historyCount) {
        historyCount.textContent = `${closedTrades.length} trade${closedTrades.length !== 1 ? "s" : ""}`;
    }

    if (historyList) {
        if (closedTrades.length === 0) {
            historyList.innerHTML = `
                <div class="crew-history-empty">
                    <i class="fa-solid fa-hourglass-half"></i>
                    <p>No completed trades yet</p>
                </div>`;
        } else {
            historyList.innerHTML = "";
            // Show most recent first
            [...closedTrades].reverse().forEach(trade => {
                const pnl = trade.pnl !== undefined ? trade.pnl : (trade.realized_pnl || 0);
                const pnlColor = pnl >= 0 ? "text-green" : "text-red";
                const pnlStr = (pnl >= 0 ? "+" : "") + formatINR(pnl);
                const dirClass = trade.type === "buy" ? "buy" : "sell";
                const dirIcon = trade.type === "buy" ? "▲" : "▼";
                const outcomeClass = trade.outcome === "target" ? "target" : "stop";
                const outcomeLabel = trade.outcome === "target" ? "TP"
                    : trade.outcome === "cancelled" ? "CX" : "SL";
                const timeStr = trade.timestamp ? new Date(trade.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : "—";

                const item = document.createElement("div");
                item.className = "crew-history-item";
                item.innerHTML = `
                    <div class="chi-direction ${dirClass}">${dirIcon}</div>
                    <div class="chi-details">
                        <div class="chi-asset">${esc(trade.asset || trade.symbol || "—")}</div>
                        <div class="chi-time">${timeStr}</div>
                    </div>
                    <span class="chi-pnl ${pnlColor}">${pnlStr}</span>
                    <span class="chi-outcome ${outcomeClass}">${outcomeLabel}</span>`;
                historyList.appendChild(item);
            });
        }
    }
}

// Render centralized dashboard summary (authoritative single source of truth)
function renderDashboardSummary(data) {
    if (!data) return;
    const account = data.account || {};
    const trading = data.trading || {};

    const balanceEl = document.getElementById("overview-balance");
    if (balanceEl && account.total_capital !== undefined) {
        balanceEl.textContent = formatINR(account.total_capital);
    }
    const walletEl = document.getElementById("wallet-balance");
    if (walletEl && account.available_balance !== undefined) {
        walletEl.textContent = formatINR(account.available_balance);
    }

    const activeTradesEl = document.getElementById("overview-active-trades");
    if (activeTradesEl && trading.active_trades !== undefined) {
        activeTradesEl.textContent = trading.active_trades;
    }

    const unrealizedEl = document.getElementById("overview-unrealized-pnl");
    if (unrealizedEl && trading.unrealized_pnl !== undefined) {
        const uPnl = Number(trading.unrealized_pnl);
        unrealizedEl.textContent = (uPnl >= 0 ? "+" : "") + formatINR(uPnl);
        unrealizedEl.className = "stat-value " + (uPnl >= 0 ? "text-green" : "text-red");
    }

    const realizedEl = document.getElementById("overview-realized-pnl");
    if (realizedEl && trading.realized_pnl !== undefined) {
        const rPnl = Number(trading.realized_pnl);
        realizedEl.textContent = (rPnl >= 0 ? "+" : "") + formatINR(rPnl);
        realizedEl.className = "stat-value " + (rPnl >= 0 ? "text-green" : "text-red");
    }

    const winRateEl = document.getElementById("overview-win-rate");
    const barFill = document.getElementById("overview-winrate-bar");
    if (winRateEl) {
        if (trading.total_closed_trades && trading.total_closed_trades > 0 && trading.win_rate !== null && trading.win_rate !== undefined) {
            const wr = Number(trading.win_rate);
            winRateEl.textContent = `${wr.toFixed(1)}%`;
            if (barFill) barFill.style.width = `${Math.min(100, Math.max(0, wr))}%`;
        } else {
            winRateEl.textContent = "—";
            if (barFill) barFill.style.width = "0%";
        }
    }
}
window.renderDashboardSummary = renderDashboardSummary;

// Fetch authoritative dashboard summary from REST endpoint
async function fetchDashboardSummary() {
    try {
        const userId = currentUserId || (typeof localStorage !== "undefined" ? localStorage.getItem("orbit_user_id") : null) || 1;
        const res = await fetch(`/api/dashboard/summary?user_id=${encodeURIComponent(userId)}`);
        if (!res.ok) return;
        const json = await res.json();
        if (json.ok && json.data) {
            renderDashboardSummary(json.data);
        }
    } catch (err) {
        console.warn("[Dashboard] Error fetching summary:", err);
    }
}
window.fetchDashboardSummary = fetchDashboardSummary;

// WebSocket Connection Setup (state variables declared at top of module)
function connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host || "localhost:8000";

    // Identify by the numeric user id from login. Sending only a username made
    // the backend mint a brand new account whenever the name did not match a
    // registered one, so trades landed on a ghost user.
    const params = new URLSearchParams();
    if (currentUserId) params.set("user_id", String(currentUserId));
    if (currentUsername) params.set("username", currentUsername);
    const wsUrl = `${protocol}//${host}/ws?${params.toString()}`;

    _wsIntentionallyClosed = false;
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log("WebSocket connection established");
        _wsReconnectAttempts = 0;
        systemStatus.innerHTML = '<span class="status-dot green-glow"></span> ONLINE';
    };

    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);

        switch (data.type) {
            case "history":
                // Update legend from last candle price
                if (data.candles && data.candles.length > 0) {
                    const latest = data.candles[data.candles.length - 1];
                    updateLegend(latest.close, data.changePercent || 0);
                }
                break;

            case "price_update":
            case "tick":
                // Suppress duplicate tick update if Go high-speed hub is actively streaming
                if (_streamSocket && _streamSocket.readyState === WebSocket.OPEN) {
                    break;
                }
                // Update legend price display
                if (data.candle) {
                    updateLegend(data.candle.close, data.changePercent || 0);
                } else if (data.data && data.data.price) {
                    updateLegend(data.data.price, data.data.change_percent || 0);
                }
                break;

            case "trade_opened":
            case "trade_updated":
            case "trade_closed":
                loadOpenTrades();
                fetchDashboardSummary();
                break;

            case "levels":
                // Save levels on window; display in signals panel
                window.lastSupports = data.supports || [];
                window.lastResistances = data.resistances || [];
                window.lastLiquidity = data.liquidity || [];
                showSRLevels = true;
                if (btnDrawSR) btnDrawSR.classList.add("active-btn");
                updateSRPanel(window.lastSupports, window.lastResistances);
                drawChartOverlay(); // draw lines on canvas
                break;

            case "signal":
                // Show trade confirmation modal — don't auto-place
                if (data.entry && data.sl && data.target) {
                    showTradeConfirmModal(data);
                }
                break;

            case "log":
                logToTerminal(data.agent, data.message, data.time);
                updateAgentStatusUI(data.agent, data.message);
                break;

            case "metrics":
                updateMetrics(data);
                updateOverviewMetrics(data);
                break;

            case "dashboard_summary":
                renderDashboardSummary(data.data || data);
                break;

            case "wallet_updated":
            case "wallet": {
                const bal = data.balance !== undefined ? data.balance : (data.data ? data.data.balance : null);
                if (bal !== null) {
                    const fmt = formatINR(bal);
                    if (walletBalanceEl) walletBalanceEl.textContent = fmt;
                    const ob = document.getElementById("overview-balance");
                    if (ob) ob.textContent = fmt;
                }
                fetchDashboardSummary();
                break;
            }

            case "positions_updated":
            case "position_updated":
            case "positions":
                if (data.positions) {
                    updatePositionsTable(data.positions);
                    updateOverviewPositionsStats(data.positions);
                }
                loadOpenTrades();

                // If there's an active trade for this symbol, draw the green/red profit-loss tool on the chart!
                const activeTrade = data.positions && data.positions.find(p => p.status === "active" && p.asset === currentAsset);
                if (activeTrade) {
                    window._lastSignalEntry = activeTrade.entry_price;
                    window._lastSignalSL = activeTrade.sl;
                    window._lastSignalTarget = activeTrade.target;
                    drawChartOverlay();
                } else {
                    // Check if there's a pending trade for this symbol to keep it showing
                    const pendingTrade = data.positions && data.positions.find(p => p.status === "pending" && p.asset === currentAsset);
                    if (!pendingTrade) {
                        window._lastSignalEntry = null;
                        window._lastSignalSL = null;
                        window._lastSignalTarget = null;
                        drawChartOverlay(); // redraw — keeps S/R lines, removes trade zones
                    }
                }
                break;

            case "history_trades":
                updateHistoryTable(data.trades);
                updateOverviewHistoryStats(data.trades);
                loadTradeHistoryPage(currentHistoryPage || 0);
                break;

            case "bot_event":
                // Auto-Trade Bot activity (delivered by the Go gateway's user hub).
                handleBotEvent(data);
                break;

            case "bot_session_updated":
                handleBotSessionUpdate(data.data);
                break;

            case "auth_error":
                // The backend no longer recognises this session.
                _wsIntentionallyClosed = true;
                logToTerminal("SYSTEM", data.message || "Session expired. Please log in again.");
                localStorage.removeItem("orbit_logged_in_username");
                localStorage.removeItem("orbit_user_id");
                break;

            case "system_status":
                if (data.status === "running") {
                    setAnalyzingMode(true);
                } else {
                    setAnalyzingMode(false);
                }
                break;
        }
    };

    socket.onclose = () => {
        console.log("WebSocket connection disconnected");
        systemStatus.innerHTML = '<span class="status-dot"></span> OFFLINE';

        // Reconnect with backoff. Previously a dropped socket stayed dead until
        // the user reloaded the page, and the dashboard silently stopped updating.
        if (_wsIntentionallyClosed || !currentUserId) return;
        clearTimeout(_wsReconnectTimer);
        const delay = Math.min(30000, 1000 * Math.pow(2, _wsReconnectAttempts));
        _wsReconnectAttempts += 1;
        systemStatus.innerHTML = '<span class="status-dot"></span> RECONNECTING…';
        _wsReconnectTimer = setTimeout(connectWebSocket, delay);
    };

    socket.onerror = (error) => {
        console.error("WebSocket Error:", error);
    };
}

// ---------------------------------------------------------------------------
// Phase 11 — orbit-stream Go hub connection
// Opens a secondary lightweight WebSocket to :8001/ws.  Incoming tick and
// metrics messages are routed to the same handlers as the Python WS so the
// rest of the UI code needs zero changes.  Reconnects automatically.
// Falls back silently if orbit-stream is not running.
// ---------------------------------------------------------------------------
function connectStreamHub() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const hostname = window.location.hostname || "localhost";
    const hubPort = window.ORBIT_HUB_PORT || "8001";
    const hubUrl = `${protocol}//${hostname}:${hubPort}/ws`;

    try {
        _streamSocket = new WebSocket(hubUrl);
    } catch (e) {
        console.warn("[orbit-stream] could not open hub socket:", e);
        return;
    }

    _streamSocket.onopen = () => {
        console.log("[orbit-stream] Go hub connected — high-frequency tick stream active");
    };

    _streamSocket.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        // Route tick and metrics to the existing Python WS handlers.
        // All other message types are ignored here (handled by Python WS).
        if (data.type === "tick" && data.candle) {
            updateLegend(data.candle.close, data.changePercent || 0);
        } else if (data.type === "metrics") {
            updateMetrics(data);
            updateOverviewMetrics(data);
        }
    };

    _streamSocket.onclose = () => {
        if (_wsIntentionallyClosed) return;
        // Reconnect after 3 s — hub may restart independently of Python backend.
        clearTimeout(_streamReconnectTimer);
        _streamReconnectTimer = setTimeout(connectStreamHub, 3000);
    };

    _streamSocket.onerror = () => {
        // Hub not running — fail silently; Python WS fallback handles ticks.
    };
}

// Update the legend pricing info
function updateLegend(price, changePercent) {
    legendPrice.textContent = formatINR(price);
    const sign = changePercent >= 0 ? "+" : "";
    legendChange.textContent = `${sign}${changePercent.toFixed(2)}%`;

    if (changePercent >= 0) {
        legendPrice.className = "legend-val text-green";
        legendChange.className = "legend-val text-green";
    } else {
        legendPrice.className = "legend-val text-red";
        legendChange.className = "legend-val text-red";
    }
}

// Update the metrics display cards (null-safe)
function updateMetrics(data) {
    if (data.consensus) {
        safeText(consensusSignal, data.consensus.signal.toUpperCase());
        // total_signals = the 12 quant strategies plus the specialist agents
        // that voted this round; older payloads without it still read "of 12".
        const totalSignals = data.consensus.total_signals || 12;
        safeText(consensusVotes, `${data.consensus.votes_buy} of ${totalSignals} voted BUY`);

        if (data.consensus.signal === "buy") {
            safeClass(consensusSignal, "metric-value-box text-green");
        } else if (data.consensus.signal === "sell") {
            safeClass(consensusSignal, "metric-value-box text-red");
        } else {
            safeClass(consensusSignal, "metric-value-box text-blue");
        }
    }

    if (data.sentiment !== undefined) {
        const score = data.sentiment;
        safeText(sentimentScore, `Score: ${score.toFixed(2)}`);
        const percentage = ((score + 1) / 2) * 100;
        safeStyle(sentimentBar, "width", `${percentage}%`);

        if (score > 0.15) {
            safeText(sentimentMeter, "BULLISH");
            safeClass(sentimentMeter, "metric-value-box text-green");
        } else if (score < -0.15) {
            safeText(sentimentMeter, "BEARISH");
            safeClass(sentimentMeter, "metric-value-box text-red");
        } else {
            safeText(sentimentMeter, "NEUTRAL");
            safeClass(sentimentMeter, "metric-value-box text-cyan");
        }
    }

    if (data.trend) {
        safeText(trendStrength, data.trend.strength.toUpperCase());
        safeText(technicalSignals, `RSI: ${data.trend.rsi.toFixed(1)} | MA: ${data.trend.ma_alignment}`);

        if (data.trend.strength === "strong uptrend") {
            safeClass(trendStrength, "metric-value-box text-green");
        } else if (data.trend.strength === "strong downtrend") {
            safeClass(trendStrength, "metric-value-box text-red");
        } else {
            safeClass(trendStrength, "metric-value-box text-yellow");
        }
    }
}

// Update active positions table (null-safe)
function updatePositionsTable(positions) {
    if (!positionsTbody) return;
    if (!positions || positions.length === 0) {
        positionsTbody.innerHTML = `
            <tr class="empty-row">
                <td colspan="9">No active positions. The execution agent is scanning for entry points.</td>
            </tr>`;
        return;
    }

    positionsTbody.innerHTML = "";
    positions.forEach(pos => {
        const pnl = pos.pnl;
        const pnlClass = pnl >= 0 ? "text-green" : "text-red";
        const badgeClass = pos.type === "buy" ? "badge-green" : "badge-red";
        const statusClass = pos.status === "active" ? "badge-blue" : "badge-yellow";

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><strong>${esc(pos.asset)}</strong></td>
            <td><span class="badge ${badgeClass}">${esc(pos.type).toUpperCase()}</span></td>
            <td>${pos.quantity}</td>
            <td>${formatINR(pos.entry_price)}</td>
            <td>${formatINR(pos.current_price)}</td>
            <td>${formatINR(pos.sl)}</td>
            <td>${formatINR(pos.target)}</td>
            <td class="${pnlClass}"><strong>${pnl >= 0 ? "+" : ""}${formatINR(pnl)}</strong></td>
            <td><span class="badge ${statusClass}">${pos.status.toUpperCase()}</span></td>
        `;
        positionsTbody.appendChild(tr);
    });
}

// Update trade history table (null-safe)
function updateHistoryTable(trades) {
    if (!historyTbody) return;
    if (!trades || trades.length === 0) {
        historyTbody.innerHTML = `
            <tr class="empty-row">
                <td colspan="7">No history yet. Completed trades will appear here.</td>
            </tr>`;
        return;
    }

    historyTbody.innerHTML = "";
    trades.forEach(trade => {
        const pnl = trade.pnl;
        const pnlClass = pnl >= 0 ? "text-green" : "text-red";
        const badgeClass = trade.type === "buy" ? "badge-green" : "badge-red";
        // outcome is nullable on older rows — .toUpperCase() on null threw and
        // blanked the whole history table.
        const outcome = trade.outcome || "closed";
        const outcomeClass = outcome === "target" ? "badge-green" : outcome === "cancelled" ? "badge-yellow" : "badge-red";
        const ts = trade.timestamp ? new Date(trade.timestamp) : null;
        const date = ts && !isNaN(ts) ? ts.toLocaleTimeString() : "—";

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${date}</td>
            <td><strong>${esc(trade.asset)}</strong></td>
            <td><span class="badge ${badgeClass}">${esc(trade.type).toUpperCase()}</span></td>
            <td>${formatINR(trade.entry_price)}</td>
            <td>${formatINR(trade.exit_price)}</td>
            <td class="${pnlClass}"><strong>${pnl >= 0 ? "+" : ""}${formatINR(pnl)}</strong></td>
            <td><span class="badge ${outcomeClass}">${esc(outcome).toUpperCase()}</span></td>
        `;
        historyTbody.appendChild(tr);
    });
}

// Toggle Dashboard State
function setAnalyzingMode(isAnalyzing) {
    if (isAnalyzing) {
        analyzeBtn.disabled = true;
        stopBtn.disabled = false;
        assetInput.disabled = true;
        systemStatus.innerHTML = '<span class="status-dot green-glow"></span> ANALYZING';
    } else {
        analyzeBtn.disabled = false;
        stopBtn.disabled = true;
        assetInput.disabled = false;
        systemStatus.innerHTML = '<span class="status-dot green-glow"></span> ONLINE';
    }
}

// Start active agent crew analysis for selected asset (Step 2 Prep)
function prepareTradeEnvironment(symbol) {
    if (!symbol) return;

    currentAsset = symbol;
    currentAssetTitle.textContent = `${symbol} Real-Time Chart`;
    activeTickerDisplay.textContent = symbol;
    const statusLabel = document.getElementById("atv-status-label");
    if (statusLabel) statusLabel.textContent = "AI Crew Ready";

    // Switch to step 2: active trading console
    terminalStockSelectView.classList.add("hidden-tab");
    terminalActiveTradingView.classList.remove("hidden-tab");

    // Clear and reset gauges/lines
    resetGauges();
    clearPriceLines();
    clearSignalPanel();
    resetAgentTicks();

    // Reset support/resistance/liquidity overlay parameters for the new asset
    window.lastSupports = [];
    window.lastResistances = [];
    window.lastLiquidity = [];
    window._lastSignalEntry = null;
    window._lastSignalSL = null;
    window._lastSignalTarget = null;
    drawChartOverlay(true); // Clear previous overlay canvas

    // Initialize / reinitialize TradingView Advanced Chart for the new symbol
    initChart(symbol);

    // Fetch asset specific news
    fetchNews(symbol);

    // Auto-run agents immediately when the chart is switched
    logToTerminal("SYSTEM", `Environment ready for ${symbol}. Launching AI Crew automatically...`);
    systemStatus.innerHTML = '<span class="status-dot green-glow"></span> READY';
    
    // Slight delay to let UI transition finish before triggering the socket message
    setTimeout(() => {
        runAgentCrew();
    }, 500);
}

function resetAgentTicks() {
    document.querySelectorAll(".agent-row").forEach(row => {
        row.classList.remove("active-agent", "completed-agent");
        const statusEl = row.querySelector(".agent-row-status");
        if (statusEl) statusEl.textContent = "Waiting…";
    });

    const progressWrap = document.getElementById("atv-progress-wrap");
    const progressBar = document.getElementById("atv-progress-bar");
    if (progressWrap) progressWrap.classList.add("hidden");
    if (progressBar) progressBar.style.width = "0%";
}

function runAgentCrew() {
    if (!currentAsset) return;

    const tradeBtn = document.getElementById("trade-through-agent-btn");
    if (tradeBtn) tradeBtn.disabled = true;

    const progressWrap = document.getElementById("atv-progress-wrap");
    if (progressWrap) progressWrap.classList.remove("hidden");

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            action: "start",
            asset: currentAsset
        }));

        logToTerminal("SYSTEM", `Launching AI pipeline for ${currentAsset}...`);
        setAnalyzingMode(true);
        systemStatus.innerHTML = '<span class="status-dot green-glow"></span> AGENTS ACTIVE';
    } else {
        alert("Server connection is offline. Please wait or reload.");
        if (tradeBtn) tradeBtn.disabled = false;
    }
}

// Handle User Actions
analyzeBtn.addEventListener("click", () => {
    const symbol = assetInput.value.trim().toUpperCase();
    prepareTradeEnvironment(symbol);
});

const tradeThroughAgentBtn = document.getElementById("trade-through-agent-btn");
if (tradeThroughAgentBtn) {
    tradeThroughAgentBtn.addEventListener("click", runAgentCrew);
}


stopBtn.addEventListener("click", () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            action: "stop"
        }));
        logToTerminal("SYSTEM", `Stopping active agent pipeline.`);
        setAnalyzingMode(false);
    }

    // Return to Step 1: Stock Selection screen
    setTimeout(() => {
        terminalActiveTradingView.classList.add("hidden-tab");
        terminalStockSelectView.classList.remove("hidden-tab");
        // Reset Support/Resistance levels display state
        showSRLevels = false;
        if (btnDrawSR) btnDrawSR.classList.remove("active-btn");
        clearSignalPanel();
    }, 300);
});

// Support/Resistance Levels Draw Toggle Button
btnDrawSR.addEventListener("click", () => {
    showSRLevels = !showSRLevels;
    if (showSRLevels) {
        btnDrawSR.classList.add("active-btn");
        // Re-display SR panel with stored levels AND redraw canvas
        updateSRPanel(window.lastSupports || [], window.lastResistances || []);
        drawChartOverlay(); // includes S/R + any active signal zones
        logToTerminal("SYSTEM", "Displaying Support and Resistance levels on chart.");
    } else {
        btnDrawSR.classList.remove("active-btn");
        clearSRPanel();
        // Keep signal zones but clear S/R lines — clear all and redraw only signal zones
        window.lastSupports = [];
        window.lastResistances = [];
        window.lastLiquidity = [];
        drawChartOverlay(); // redraws just the trade zones if any
        logToTerminal("SYSTEM", "Hiding Support and Resistance levels.");
    }
});

// Quick Pick Ticker buttons click listeners
document.querySelectorAll(".quick-pick-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const ticker = btn.getAttribute("data-ticker");
        if (ticker) {
            assetInput.value = ticker;
            prepareTradeEnvironment(ticker);
        }
    });
});

// -------------------------------------------------------------
//   AUTOCOMPLETE SEARCH  — ticker input
// -------------------------------------------------------------
const AUTOCOMPLETE_LIST = [
    // Crypto
    { t: "BTC-USD", n: "Bitcoin", cat: "Crypto" },
    { t: "ETH-USD", n: "Ethereum", cat: "Crypto" },
    { t: "SOL-USD", n: "Solana", cat: "Crypto" },
    { t: "XRP-USD", n: "Ripple", cat: "Crypto" },
    { t: "DOGE-USD", n: "Dogecoin", cat: "Crypto" },
    { t: "ADA-USD", n: "Cardano", cat: "Crypto" },
    { t: "MATIC-USD", n: "Polygon", cat: "Crypto" },
    { t: "DOT-USD", n: "Polkadot", cat: "Crypto" },
    { t: "AVAX-USD", n: "Avalanche", cat: "Crypto" },
    { t: "LTC-USD", n: "Litecoin", cat: "Crypto" },
    { t: "LINK-USD", n: "Chainlink", cat: "Crypto" },
    { t: "BNB-USD", n: "Binance Coin", cat: "Crypto" },
    // US Stocks
    { t: "AAPL", n: "Apple", cat: "US Stock" },
    { t: "TSLA", n: "Tesla", cat: "US Stock" },
    { t: "NVDA", n: "NVIDIA", cat: "US Stock" },
    { t: "MSFT", n: "Microsoft", cat: "US Stock" },
    { t: "GOOGL", n: "Alphabet", cat: "US Stock" },
    { t: "AMZN", n: "Amazon", cat: "US Stock" },
    { t: "META", n: "Meta", cat: "US Stock" },
    { t: "NFLX", n: "Netflix", cat: "US Stock" },
    { t: "AMD", n: "AMD", cat: "US Stock" },
    { t: "INTC", n: "Intel", cat: "US Stock" },
    // Indian Stocks
    { t: "SBIN.NS", n: "SBI", cat: "NSE" },
    { t: "RELIANCE.NS", n: "Reliance", cat: "NSE" },
    { t: "TCS.NS", n: "TCS", cat: "NSE" },
    { t: "INFY.NS", n: "Infosys", cat: "NSE" },
    { t: "HDFCBANK.NS", n: "HDFC Bank", cat: "NSE" },
    { t: "ICICIBANK.NS", n: "ICICI Bank", cat: "NSE" },
    { t: "WIPRO.NS", n: "Wipro", cat: "NSE" },
    { t: "TATAMOTORS.NS", n: "Tata Motors", cat: "NSE" },
    { t: "BAJFINANCE.NS", n: "Bajaj Finance", cat: "NSE" },
    { t: "ADANIENT.NS", n: "Adani Enterprises", cat: "NSE" },
    // Indices & Forex
    { t: "SPY", n: "S&P 500 ETF", cat: "Index" },
    { t: "QQQ", n: "NASDAQ 100 ETF", cat: "Index" },
    { t: "DIA", n: "Dow Jones ETF", cat: "Index" },
    { t: "EURUSD=X", n: "EUR / USD", cat: "Forex" },
    { t: "GBPUSD=X", n: "GBP / USD", cat: "Forex" },
    { t: "USDINR=X", n: "USD / INR", cat: "Forex" },
    { t: "JPYUSD=X", n: "JPY / USD", cat: "Forex" },
];

const suggestionsEl = document.getElementById("ticker-suggestions");

assetInput.addEventListener("input", () => {
    const q = assetInput.value.trim().toUpperCase();
    if (!q || q.length < 1) { suggestionsEl.classList.add("hidden"); return; }

    const matches = AUTOCOMPLETE_LIST.filter(
        item => item.t.toUpperCase().includes(q) || item.n.toUpperCase().includes(q)
    ).slice(0, 8);

    // Always provide the option to search exactly what the user typed
    const exactMatch = matches.find(m => m.t.toUpperCase() === q);
    if (!exactMatch && q.length > 0) {
        matches.push({ t: q, n: "Search TradingView...", cat: "Custom" });
    }

    if (!matches.length) { suggestionsEl.classList.add("hidden"); return; }

    suggestionsEl.innerHTML = matches.map(m => `
        <div class="suggestion-item" data-ticker="${m.t}">
            <span class="sug-ticker">${m.t}</span>
            <span class="sug-name">${m.n}</span>
            <span class="sug-cat">${m.cat}</span>
        </div>
    `).join("");
    suggestionsEl.classList.remove("hidden");

    suggestionsEl.querySelectorAll(".suggestion-item").forEach(item => {
        item.addEventListener("click", () => {
            const ticker = item.getAttribute("data-ticker");
            assetInput.value = ticker;
            suggestionsEl.classList.add("hidden");
            prepareTradeEnvironment(ticker);
        });
    });
});

// Hide suggestions when clicking outside
document.addEventListener("click", (e) => {
    if (!assetInput.contains(e.target) && !suggestionsEl.contains(e.target)) {
        suggestionsEl.classList.add("hidden");
    }
});

// Enter key triggers analysis from search bar
assetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        suggestionsEl.classList.add("hidden");
        const ticker = assetInput.value.trim().toUpperCase();
        if (ticker) prepareTradeEnvironment(ticker);
    }
});

// -------------------------------------------------------------
//   SIGNAL & S/R PANEL HELPERS (displayed below the TV chart)
// -------------------------------------------------------------

function updateSignalPanel(entry, sl, target) {
    const panel = document.getElementById("signal-levels-panel");
    if (!panel) return;
    panel.classList.remove("hidden");
    document.getElementById("signal-entry").textContent = formatINR(entry);
    document.getElementById("signal-sl").textContent = formatINR(sl);
    document.getElementById("signal-target").textContent = formatINR(target);

    // Calculate risk-reward
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(target - entry);
    const rr = risk > 0 ? (reward / risk).toFixed(2) : "—";
    document.getElementById("signal-rr").textContent = `${rr}:1`;
}

function clearSignalPanel() {
    const panel = document.getElementById("signal-levels-panel");
    if (panel) panel.classList.add("hidden");
}

function updateSRPanel(supports, resistances) {
    const panel = document.getElementById("sr-levels-panel");
    if (!panel) return;
    if (!showSRLevels) return;
    panel.classList.remove("hidden");

    const supEl = document.getElementById("sr-support-list");
    const resEl = document.getElementById("sr-resistance-list");

    supEl.innerHTML = supports.length
        ? supports.map(p => `<span class="sr-badge sr-support">${formatINR(p)}</span>`).join("")
        : "<span class='sr-badge sr-none'>—</span>";

    resEl.innerHTML = resistances.length
        ? resistances.map(p => `<span class="sr-badge sr-resistance">${formatINR(p)}</span>`).join("")
        : "<span class='sr-badge sr-none'>—</span>";
}

function clearSRPanel() {
    const panel = document.getElementById("sr-levels-panel");
    if (panel) panel.classList.add("hidden");
}

// Auto-login on page refresh ONLY if explicitly navigating to #dashboard
document.addEventListener("DOMContentLoaded", () => {
    initClerkAuth();
    if (window.location.hash.includes("dashboard")) {
        document.body.classList.add("in-dashboard");
        if (window.aether3D) window.aether3D.stop();
        const threeCanvas = document.getElementById("three-canvas");
        if (threeCanvas) threeCanvas.style.display = "none";
        try { fetchGlobalNews(); } catch (e) {}
        const savedUsername = localStorage.getItem("orbit_logged_in_username");
        const savedUserId = localStorage.getItem("orbit_user_id");
        if (savedUsername && savedUserId) {
            setTimeout(() => {
                enterDashboard(savedUsername, parseInt(savedUserId, 10) || savedUserId);
            }, 100);
            return;
        }
        // When returning with #dashboard from OAuth, let initClerkAuth finish session hydration
        return;
    }
    // Always ensure landing page is visible on default root visit
    document.body.classList.remove("in-dashboard");
    const threeCanvas = document.getElementById("three-canvas");
    if (threeCanvas) threeCanvas.style.display = "block";
    if (window.aether3D) window.aether3D.start();
    if (landingPage) landingPage.classList.remove("hidden");
    if (dashboardPage) dashboardPage.classList.add("hidden");
});

// Redraw chart overlay on window resize (canvas dimensions go stale otherwise)
let _overlayResizeTimer = null;
window.addEventListener("resize", () => {
    clearTimeout(_overlayResizeTimer);
    _overlayResizeTimer = setTimeout(() => {
        drawChartOverlay();
    }, 120);
});

// =============================================================
//   REPORTS VIEW — performance report, charts and exports
// =============================================================
// The charts here are hand-rolled inline SVG rather than a charting library.
// The app already ships three.js and Font Awesome from a CDN; adding another
// megabyte of dependency for five small charts is not worth it, and building
// the SVG directly means the charts inherit the terminal's CSS colours and
// stay crisp when the report is printed to PDF.

const reportRefreshBtn = document.getElementById("report-refresh-btn");
const reportExportCsvBtn = document.getElementById("report-export-csv");
const reportExportJsonBtn = document.getElementById("report-export-json");
const reportExportPdfBtn = document.getElementById("report-export-pdf");
const reportFilterAsset = document.getElementById("report-filter-asset");
const reportFilterOutcome = document.getElementById("report-filter-outcome");
const reportTableBody = document.getElementById("report-table-body");
const reportRowCount = document.getElementById("report-row-count");
const reportGenerated = document.getElementById("report-generated");

// Last payload from /api/report, kept so filtering and exporting never need
// another round trip.
let reportData = null;

const CHART = {
    green: "#3fb950",
    red: "#e5484d",
    cyan: "#4d7cfe",
    purple: "#a371f7",
    yellow: "#d29922",
    grid: "rgba(255,255,255,0.06)",
    axis: "rgba(255,255,255,0.22)",
    text: "#9ba2ad",
};

// ---------- small formatting helpers -------------------------------------

function rupees(value, decimals = 2) {
    const n = Number(value) || 0;
    const sign = n < 0 ? "-" : "";
    return sign + "₹" + Math.abs(n).toLocaleString("en-IN", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
}

function signedRupees(value) {
    const n = Number(value) || 0;
    return (n >= 0 ? "+" : "") + rupees(n);
}

// Same, without the paise. Chart labels and the composite KPI cards do not
// have the width for two decimals, and lose nothing by dropping them.
function signedRupeesShort(value) {
    const n = Number(value) || 0;
    return (n >= 0 ? "+" : "") + rupees(n, 0);
}

function pnlClass(value) {
    const n = Number(value) || 0;
    if (n > 0) return "text-green";
    if (n < 0) return "text-red";
    return "text-muted";
}

// Anything interpolated into chart or table markup is escaped — asset symbols
// come from user input on the terminal screen.
function esc(text) {
    return String(text === null || text === undefined ? "" : text)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function svgWrap(inner, width, height) {
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet"
                 class="report-svg" role="img">${inner}</svg>`;
}

function emptyChart(message) {
    return `<div class="report-chart-empty"><i class="fa-solid fa-chart-line"></i><span>${esc(message)}</span></div>`;
}

// ---------- chart 1: equity curve ----------------------------------------

function renderEquityCurve(curve) {
    const host = document.getElementById("chart-equity");
    if (!host) return;
    if (!curve || curve.length === 0) {
        host.innerHTML = emptyChart("No closed trades yet — the equity curve appears once trades settle.");
        return;
    }

    // The viewBox aspect (~3.3:1) matches the shape of the full-width card,
    // so the chart fills it instead of floating in gutters.
    const W = 1000, H = 300, padL = 92, padR = 26, padT = 22, padB = 38;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    const values = curve.map(p => p.cumulative);
    // Always include zero so the baseline is visible and profit/loss read correctly.
    let min = Math.min(0, ...values);
    let max = Math.max(0, ...values);
    if (min === max) { max = min + 1; }
    const span = max - min;

    const x = i => padL + (curve.length === 1 ? plotW / 2 : (i / (curve.length - 1)) * plotW);
    const y = v => padT + plotH - ((v - min) / span) * plotH;

    // Horizontal gridlines with rupee labels.
    let grid = "";
    const TICKS = 5;
    for (let t = 0; t <= TICKS; t++) {
        const value = min + (span * t) / TICKS;
        const gy = y(value);
        grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="${CHART.grid}" stroke-width="1"/>`;
        grid += `<text x="${padL - 8}" y="${gy + 4}" fill="${CHART.text}" font-size="11"
                       text-anchor="end" font-family="monospace">${esc(rupees(value, 0))}</text>`;
    }

    const zeroY = y(0);
    grid += `<line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}"
                   stroke="${CHART.axis}" stroke-width="1.5" stroke-dasharray="4 4"/>`;

    const points = curve.map((p, i) => `${x(i)},${y(p.cumulative)}`).join(" ");
    const finalPositive = values[values.length - 1] >= 0;
    const lineColor = finalPositive ? CHART.green : CHART.red;

    // Filled area between the curve and the zero baseline.
    const area = `${padL},${zeroY} ${points} ${x(curve.length - 1)},${zeroY}`;

    // Past roughly 60 points the markers merge into a solid band and only
    // make the line harder to read, so they are dropped.
    const dots = curve.length > 60 ? "" : curve.map((p, i) =>
        `<circle cx="${x(i)}" cy="${y(p.cumulative)}" r="3"
                 fill="${p.pnl >= 0 ? CHART.green : CHART.red}" stroke="#0b0c0e" stroke-width="1">
            <title>#${p.n} ${esc(p.asset || "")} — trade ${signedRupees(p.pnl)}, running ${signedRupees(p.cumulative)}</title>
         </circle>`).join("");

    const inner = `
        <defs>
            <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="${lineColor}" stop-opacity="0.35"/>
                <stop offset="100%" stop-color="${lineColor}" stop-opacity="0.02"/>
            </linearGradient>
        </defs>
        ${grid}
        <polygon points="${area}" fill="url(#eqFill)"/>
        <polyline points="${points}" fill="none" stroke="${lineColor}" stroke-width="2.5"
                  stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}
        <text x="${padL}" y="${H - 12}" fill="${CHART.text}" font-size="11">trade 1</text>
        <text x="${W - padR}" y="${H - 12}" fill="${CHART.text}" font-size="11"
              text-anchor="end">trade ${curve.length}</text>`;

    host.innerHTML = svgWrap(inner, W, H);
}

// ---------- chart 2: P&L per trade ---------------------------------------

function renderPnlBars(curve) {
    const host = document.getElementById("chart-pnl-bars");
    if (!host) return;
    if (!curve || curve.length === 0) {
        host.innerHTML = emptyChart("No closed trades to chart.");
        return;
    }

    const W = 520, H = 260, padL = 78, padR = 18, padT = 18, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    const values = curve.map(p => p.pnl);
    const bound = Math.max(1, ...values.map(Math.abs));
    const y = v => padT + plotH / 2 - (v / bound) * (plotH / 2);
    const midY = padT + plotH / 2;

    const slot = plotW / curve.length;
    const barW = Math.max(2, Math.min(22, slot * 0.7));

    const bars = curve.map((p, i) => {
        const cx = padL + slot * i + slot / 2;
        const top = p.pnl >= 0 ? y(p.pnl) : midY;
        const h = Math.max(1, Math.abs(midY - y(p.pnl)));
        const color = p.pnl >= 0 ? CHART.green : CHART.red;
        return `<rect x="${cx - barW / 2}" y="${top}" width="${barW}" height="${h}"
                      fill="${color}" opacity="0.85" rx="2">
                    <title>#${p.n} ${esc(p.asset || "")} — ${signedRupees(p.pnl)}</title>
                </rect>`;
    }).join("");

    const inner = `
        <line x1="${padL}" y1="${y(bound)}" x2="${W - padR}" y2="${y(bound)}" stroke="${CHART.grid}"/>
        <line x1="${padL}" y1="${y(-bound)}" x2="${W - padR}" y2="${y(-bound)}" stroke="${CHART.grid}"/>
        <text x="${padL - 8}" y="${y(bound) + 4}" fill="${CHART.text}" font-size="10"
              text-anchor="end" font-family="monospace">${esc(rupees(bound, 0))}</text>
        <text x="${padL - 8}" y="${y(-bound) + 4}" fill="${CHART.text}" font-size="10"
              text-anchor="end" font-family="monospace">${esc(rupees(-bound, 0))}</text>
        ${bars}
        <line x1="${padL}" y1="${midY}" x2="${W - padR}" y2="${midY}" stroke="${CHART.axis}" stroke-width="1"/>`;

    host.innerHTML = svgWrap(inner, W, H);
}

// ---------- chart 3: win/loss donut --------------------------------------

function renderWinLoss(summary) {
    const host = document.getElementById("chart-winloss");
    if (!host) return;

    const wins = summary.wins || 0;
    const losses = summary.losses || 0;
    const total = wins + losses;
    if (total === 0) {
        host.innerHTML = emptyChart("No settled trades yet.");
        return;
    }

    const W = 520, H = 260;
    // Donut left, legend right, with matching outer margins so the pair sits
    // centred in the card rather than hard against the left edge.
    const cx = 170, cy = 130, r = 80, thickness = 26;
    const legendX = 353, legendTextX = 373;
    const circumference = 2 * Math.PI * r;
    const winFraction = wins / total;

    // Two stroked circles offset against each other form the donut — simpler
    // and more robust than arc path maths at the 0% and 100% extremes.
    const inner = `
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${CHART.red}" stroke-width="${thickness}"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${CHART.green}" stroke-width="${thickness}"
                stroke-dasharray="${circumference * winFraction} ${circumference}"
                transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt"/>
        <text x="${cx}" y="${cy - 2}" fill="#e7e9ec" font-size="32" font-weight="700"
              text-anchor="middle" font-family="monospace">${(winFraction * 100).toFixed(1)}%</text>
        <text x="${cx}" y="${cy + 22}" fill="${CHART.text}" font-size="12" text-anchor="middle">win rate</text>

        <rect x="${legendX}" y="90" width="13" height="13" rx="3" fill="${CHART.green}"/>
        <text x="${legendTextX}" y="102" fill="#e7e9ec" font-size="14">${wins} wins</text>
        <text x="${legendTextX}" y="121" fill="${CHART.text}" font-size="12" font-family="monospace">${esc(rupees(summary.gross_profit, 0))}</text>

        <rect x="${legendX}" y="152" width="13" height="13" rx="3" fill="${CHART.red}"/>
        <text x="${legendTextX}" y="164" fill="#e7e9ec" font-size="14">${losses} losses</text>
        <text x="${legendTextX}" y="183" fill="${CHART.text}" font-size="12" font-family="monospace">${esc(rupees(-summary.gross_loss, 0))}</text>`;

    host.innerHTML = svgWrap(inner, W, H);
}

// ---------- charts 4 & 5: horizontal breakdown bars ----------------------

function renderBreakdown(hostId, rows, emptyMessage) {
    const host = document.getElementById(hostId);
    if (!host) return;
    if (!rows || rows.length === 0) {
        host.innerHTML = emptyChart(emptyMessage);
        return;
    }

    const shown = rows.slice(0, 8);
    // A fixed box keeps the "by asset" and "by month" cards the same shape
    // however many rows each happens to have; the rows are centred in it.
    const rowH = 30, padL = 112, padR = 104;
    const W = 520, H = 264;
    const padT = Math.max(12, (H - shown.length * rowH) / 2);
    const plotW = W - padL - padR;

    const bound = Math.max(1, ...shown.map(r => Math.abs(r.pnl)));
    const midX = padL + plotW / 2;
    const scale = (plotW / 2) / bound;

    const bars = shown.map((r, i) => {
        const cy = padT + i * rowH + rowH / 2;
        const w = Math.max(1, Math.abs(r.pnl) * scale);
        const x = r.pnl >= 0 ? midX : midX - w;
        const color = r.pnl >= 0 ? CHART.green : CHART.red;
        const label = String(r.name).length > 15 ? String(r.name).slice(0, 14) + "…" : r.name;
        return `
            <text x="${padL - 10}" y="${cy + 4}" fill="${CHART.text}" font-size="11"
                  text-anchor="end">${esc(label)}</text>
            <rect x="${x}" y="${cy - 9}" width="${w}" height="18" fill="${color}" opacity="0.8" rx="2">
                <title>${esc(r.name)} — ${r.trades} trades, ${r.win_rate}% win rate, ${signedRupees(r.pnl)}</title>
            </rect>
            <text x="${W - padR + 12}" y="${cy + 4}" fill="${color}" font-size="11"
                  font-family="monospace">${esc(signedRupeesShort(r.pnl))}</text>`;
    }).join("");

    const inner = `
        <line x1="${midX}" y1="${padT}" x2="${midX}" y2="${H - padT}" stroke="${CHART.axis}" stroke-width="1"/>
        ${bars}`;

    host.innerHTML = svgWrap(inner, W, H);
}

// ---------- KPI cards -----------------------------------------------------

function renderKpis(summary) {
    const netEl = document.getElementById("rk-net-pnl");
    if (netEl) {
        netEl.textContent = signedRupees(summary.net_pnl);
        netEl.className = "report-kpi-value " + pnlClass(summary.net_pnl);
    }
    safeText(document.getElementById("rk-net-pnl-sub"),
        `${summary.closed_trades} closed of ${summary.total_trades} total`);

    safeText(document.getElementById("rk-win-rate"), `${summary.win_rate}%`);
    safeText(document.getElementById("rk-win-rate-sub"), `${summary.wins}W / ${summary.losses}L`);

    const pfEl = document.getElementById("rk-profit-factor");
    if (pfEl) {
        // null means there were no losses at all, so the ratio is undefined.
        pfEl.textContent = summary.profit_factor === null ? "∞" : summary.profit_factor.toFixed(2);
        pfEl.className = "report-kpi-value " +
            (summary.profit_factor === null || summary.profit_factor >= 1 ? "text-green" : "text-red");
    }

    const expEl = document.getElementById("rk-expectancy");
    if (expEl) {
        expEl.textContent = signedRupees(summary.expectancy);
        expEl.className = "report-kpi-value " + pnlClass(summary.expectancy);
    }

    safeText(document.getElementById("rk-drawdown"), rupees(summary.max_drawdown));
    safeText(document.getElementById("rk-drawdown-sub"), `${summary.max_drawdown_pct}% of peak equity`);


    const ratio = summary.avg_loss > 0 ? (summary.avg_win / summary.avg_loss) : null;
    safeText(document.getElementById("rk-avg-ratio"), ratio === null ? "—" : `${ratio.toFixed(2)} : 1`);
    safeText(document.getElementById("rk-avg-sub"),
        `${rupees(summary.avg_win, 0)} avg win / ${rupees(summary.avg_loss, 0)} avg loss`);

    safeText(document.getElementById("rk-best-worst"),
        `${signedRupeesShort(summary.best_trade)} / ${signedRupeesShort(summary.worst_trade)}`);
    safeText(document.getElementById("rk-streaks"),
        `streaks ${summary.longest_win_streak}W / ${summary.longest_loss_streak}L`);

    safeText(document.getElementById("rk-open"), String(summary.open_trades + summary.pending_trades));
    safeText(document.getElementById("rk-open-sub"),
        `${summary.open_trades} active · ${summary.pending_trades} pending · unrealized ${signedRupeesShort(summary.unrealized_pnl)}`);
}

// ---------- trade ledger --------------------------------------------------

function filteredTrades() {
    if (!reportData) return [];
    const asset = reportFilterAsset ? reportFilterAsset.value : "all";
    const outcome = reportFilterOutcome ? reportFilterOutcome.value : "all";

    return reportData.trades.filter(t => {
        if (asset !== "all" && t.asset !== asset) return false;
        if (outcome === "win") return t.status === "closed" && Number(t.pnl) > 0;
        if (outcome === "loss") return t.status === "closed" && Number(t.pnl) <= 0;
        if (outcome === "open") return t.status === "active" || t.status === "pending";
        return true;
    });
}

function renderTable() {
    if (!reportTableBody) return;
    const rows = filteredTrades();

    safeText(reportRowCount, `${rows.length} trade${rows.length === 1 ? "" : "s"}`);

    if (rows.length === 0) {
        reportTableBody.innerHTML =
            `<tr><td colspan="12" class="report-empty">No trades match the current filter.</td></tr>`;
        return;
    }

    // Newest first reads better in a ledger, even though the report computes
    // its statistics in chronological order.
    reportTableBody.innerHTML = rows.slice().reverse().map(t => {
        const pnl = Number(t.pnl) || 0;
        const isClosed = t.status === "closed";
        const sideClass = t.type === "buy" ? "badge-buy" : "badge-sell";
        return `
            <tr>
                <td class="mono muted">${esc(t.id)}</td>
                <td class="mono">${esc(t.timestamp || "—")}</td>
                <td><strong>${esc(t.asset)}</strong></td>
                <td><span class="report-badge ${sideClass}">${esc(String(t.type || "").toUpperCase())}</span></td>
                <td class="mono">${Number(t.quantity || 0).toFixed(4)}</td>
                <td class="mono">${esc(rupees(t.entry_price))}</td>
                <td class="mono">${t.exit_price ? esc(rupees(t.exit_price)) : "—"}</td>
                <td class="mono text-red">${esc(rupees(t.sl))}</td>
                <td class="mono text-green">${esc(rupees(t.target))}</td>
                <td><span class="report-badge badge-${esc(t.status)}">${esc(String(t.status || "").toUpperCase())}</span></td>
                <td class="muted">${esc(t.outcome ? String(t.outcome).toUpperCase() : "—")}</td>
                <td class="mono ta-right ${isClosed ? pnlClass(pnl) : "text-muted"}">${isClosed ? esc(signedRupees(pnl)) : "—"}</td>
            </tr>`;
    }).join("");
}

// ---------- load & render -------------------------------------------------

async function loadReport() {
    if (!currentUserId) return;

    if (reportGenerated) reportGenerated.textContent = "Generating…";
    try {
        const res = await fetch(`/api/report?user_id=${encodeURIComponent(currentUserId)}`);
        if (!res.ok) throw new Error(`server returned ${res.status}`);
        const payload = await res.json();
        reportData = payload.report;
    } catch (err) {
        if (reportGenerated) reportGenerated.textContent = "Could not load report";
        if (reportTableBody) {
            reportTableBody.innerHTML =
                `<tr><td colspan="12" class="report-empty">Failed to load the report: ${esc(err.message)}</td></tr>`;
        }
        return;
    }

    safeText(reportGenerated, `Generated ${reportData.generated_at}`);

    // Keep the asset filter in sync with whatever has actually been traded.
    if (reportFilterAsset) {
        const previous = reportFilterAsset.value;
        const assets = [...new Set(reportData.trades.map(t => t.asset))].sort();
        reportFilterAsset.innerHTML = `<option value="all">All Assets</option>` +
            assets.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
        if (assets.includes(previous)) reportFilterAsset.value = previous;
    }

    renderKpis(reportData.summary);
    renderEquityCurve(reportData.equity_curve);
    renderPnlBars(reportData.equity_curve);
    renderWinLoss(reportData.summary);
    renderBreakdown("chart-by-asset", reportData.by_asset, "No closed trades to break down by asset.");
    renderBreakdown("chart-by-month", reportData.by_month, "No closed trades to break down by month.");
    renderTable();
}

// ---------- exports -------------------------------------------------------

function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function exportCsv() {
    if (!reportData) return;
    const rows = filteredTrades();
    const summary = reportData.summary;

    // A leading summary block makes the file readable on its own, then the
    // ledger follows as a normal rectangular table Excel can parse.
    const cell = v => {
        const text = String(v === null || v === undefined ? "" : v);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = [];
    lines.push("AETHER TRADING TERMINAL - PERFORMANCE REPORT");
    lines.push(`Generated,${cell(reportData.generated_at)}`);
    lines.push("");
    lines.push("SUMMARY");
    [
        ["Total Trades", summary.total_trades],
        ["Closed Trades", summary.closed_trades],
        ["Open Trades", summary.open_trades],
        ["Pending Trades", summary.pending_trades],
        ["Wins", summary.wins],
        ["Losses", summary.losses],
        ["Win Rate %", summary.win_rate],
        ["Net Realized P&L", summary.net_pnl],
        ["Gross Profit", summary.gross_profit],
        ["Gross Loss", summary.gross_loss],
        ["Profit Factor", summary.profit_factor === null ? "N/A (no losses)" : summary.profit_factor],
        ["Expectancy Per Trade", summary.expectancy],
        ["Average Win", summary.avg_win],
        ["Average Loss", summary.avg_loss],
        ["Best Trade", summary.best_trade],
        ["Worst Trade", summary.worst_trade],
        ["Max Drawdown", summary.max_drawdown],
        ["Max Drawdown %", summary.max_drawdown_pct],
        ["Longest Win Streak", summary.longest_win_streak],
        ["Longest Loss Streak", summary.longest_loss_streak],
        ["Unrealized P&L", summary.unrealized_pnl],
    ].forEach(([k, v]) => lines.push(`${cell(k)},${cell(v)}`));

    lines.push("");
    lines.push("TRADE LEDGER");
    lines.push(["ID", "Timestamp", "Asset", "Side", "Quantity", "Entry", "Exit",
                "Stop Loss", "Target", "Status", "Outcome", "P&L"].join(","));
    rows.forEach(t => lines.push([
        t.id, t.timestamp, t.asset, t.type, t.quantity, t.entry_price,
        t.exit_price === null || t.exit_price === undefined ? "" : t.exit_price,
        t.sl, t.target, t.status, t.outcome || "", t.pnl,
    ].map(cell).join(",")));

    // The BOM makes Excel open the rupee sign and UTF-8 text correctly.
    downloadBlob("﻿" + lines.join("\r\n"), `aether-report-${stamp()}.csv`, "text/csv;charset=utf-8");
}

function exportJson() {
    if (!reportData) return;
    downloadBlob(JSON.stringify(reportData, null, 2),
        `aether-report-${stamp()}.json`, "application/json");
}

function exportPdf() {
    if (!reportData) return;
    // The print stylesheet hides the sidebar and every other tab, so the
    // browser's own "Save as PDF" produces a clean report page.
    document.body.classList.add("printing-report");
    const cleanup = () => {
        document.body.classList.remove("printing-report");
        window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
    // Safety net for browsers that never fire afterprint.
    setTimeout(cleanup, 3000);
}

if (reportRefreshBtn) reportRefreshBtn.addEventListener("click", loadReport);
if (reportExportCsvBtn) reportExportCsvBtn.addEventListener("click", exportCsv);
if (reportExportJsonBtn) reportExportJsonBtn.addEventListener("click", exportJson);
if (reportExportPdfBtn) reportExportPdfBtn.addEventListener("click", exportPdf);
if (reportFilterAsset) reportFilterAsset.addEventListener("change", renderTable);
if (reportFilterOutcome) reportFilterOutcome.addEventListener("change", renderTable);


// ==========================================================================
//   LANDING PAGE CONTROLLERS (DRIBBLE 3D MULTI-AGENT SUITE)
// ==========================================================================

function launchDemoDirect() {
    enterDashboard("Trader Account", null);
}
window.launchDemoDirect = launchDemoDirect;

// Navigation & Hero Launchers
const navDemoBtn = document.getElementById("nav-demo-btn");
if (navDemoBtn) navDemoBtn.addEventListener("click", launchDemoDirect);

const heroLaunchBtn = document.getElementById("hero-launch-btn");
if (heroLaunchBtn) heroLaunchBtn.addEventListener("click", launchDemoDirect);

const getStartedBtnEl = document.getElementById("get-started-btn");
if (getStartedBtnEl) {
    getStartedBtnEl.addEventListener("click", (e) => {
        e.preventDefault();
        scrollToLogin();
    });
}

// -------------------------------------------------------------
//   THE 19 ULTIMATE SKILLS DATA & CATALOG
// -------------------------------------------------------------
const ULTIMATE_SKILLS_DATA = [
    {
        id: "ultimate-frontend-design",
        name: "UI/UX Pro Max & Frontend Taste",
        category: "frontend",
        icon: "fa-palette",
        iconColor: "skill-icon-purple",
        desc: "Enforces human-like visual balance, curated color palettes, clean typography, whitespace discipline, and eliminates generic AI aesthetics.",
        rules: "1. Anti-Slop Discipline: Refuse generic browser defaults and harsh primaries.\n2. Fluid Typography: Scale via clamp() with tailored Google Fonts (Outfit, Inter, JetBrains Mono).\n3. Depth: Multi-layer backdrop blur, hairline gradients, and micro-elevation.\n4. Motion: 60fps micro-interactions with spring physics."
    },
    {
        id: "ultimate-web-animation",
        name: "Web Motion & Physics Springs",
        category: "frontend",
        icon: "fa-wand-magic-sparkles",
        iconColor: "skill-icon-purple",
        desc: "Provides context for physics-based springs, easing curves, continuous orbital loops, gesture response, and performant 60fps animations.",
        rules: "1. CSS Transform Only: Animate translate3d() and scale() to guarantee compositor thread rendering.\n2. Easing: Cubic-bezier(0.16, 1, 0.3, 1) for snappy response.\n3. Accessibility: Respect prefers-reduced-motion media query.\n4. Will-Change: Surgical application to prevent layer explosion."
    },
    {
        id: "ultimate-3d-visuals",
        name: "3D WebGL & Shaders",
        category: "frontend",
        icon: "fa-cube",
        iconColor: "skill-icon-cyan",
        desc: "Specialized in Three.js, WebGL canvas rendering, spatial visualizers, neon market grids, and interactive 3D candlestick meshes.",
        rules: "1. Geometry Pooling: Re-use buffer geometries to prevent GC hitches.\n2. Instanced Rendering: Use InstancedMesh or lightweight box/tube batches for 100+ candlesticks.\n3. Fog & Depth: FogExp2 for atmospheric lighting.\n4. Parallax: Mouse coordinate interpolation via Lerp."
    },
    {
        id: "ultimate-web-gamedev",
        name: "Web Canvas & Realtime Systems",
        category: "frontend",
        icon: "fa-gamepad",
        iconColor: "skill-icon-cyan",
        desc: "High-frequency 60 FPS HTML5 canvas drawing loops, real-time sparklines, matrix math, and vectorized chart overlays.",
        rules: "1. RequestAnimationFrame Loop with delta time clamping.\n2. Pixel Ratio Scaling: window.devicePixelRatio handling for retina sharpness.\n3. Canvas Dirty Rects: Clear only modified sectors during high-rate ticks."
    },
    {
        id: "ultimate-api-architecture",
        name: "High-Performance API Architecture",
        category: "backend",
        icon: "fa-network-wired",
        iconColor: "skill-icon-yellow",
        desc: "Designs high-concurrency FastAPI & Node.js backends, bi-directional WebSocket streaming, and distributed microservices.",
        rules: "1. ASGI Asynchrony: Non-blocking async/await for all network and database I/O.\n2. Streaming Protocols: WebSocket bi-directional channels for tick distribution.\n3. Schema Validation: Pydantic v2 type safety across all endpoints."
    },
    {
        id: "ultimate-postgres-ecosystem",
        name: "PostgreSQL & Neon Cloud DB",
        category: "backend",
        icon: "fa-database",
        iconColor: "skill-icon-yellow",
        desc: "PostgreSQL, Neon serverless cloud databases, complex SQL aggregations, table migrations, and SQLite embedded fallback.",
        rules: "1. Connection Pooling: Efficient psycopg2 connection management with timeouts.\n2. Automated Migrations: Auto-create tables (trades, users, logs) at server startup.\n3. Dual-Persistence: Seamless fallback to SQLite3 when DATABASE_URL is absent."
    },
    {
        id: "ultimate-state-management",
        name: "State Management & Live Stores",
        category: "backend",
        icon: "fa-boxes-stacked",
        iconColor: "skill-icon-yellow",
        desc: "Manages complex frontend and backend state, reactive stores, cache invalidation, and synchronized trade journals.",
        rules: "1. Single Source of Truth: Centralized application state in app.js and database.\n2. Optimistic Updates: Immediate UI reflection on trade trigger followed by backend confirmation."
    },
    {
        id: "ultimate-cloudflare-expert",
        name: "Cloudflare Edge & Workers",
        category: "backend",
        icon: "fa-cloud",
        iconColor: "skill-icon-yellow",
        desc: "Edge functions, Cloudflare D1 databases, R2 storage, edge caching, and global sub-10ms content distribution.",
        rules: "1. Zero Cold Starts: Edge-first deployment patterns.\n2. Resilient Retries: Automatic exponential backoff on upstream network failures."
    },
    {
        id: "ultimate-llm-optimization",
        name: "LLM Context & Failover Pools",
        category: "ai",
        icon: "fa-brain",
        iconColor: "skill-icon-purple",
        desc: "Optimizes prompts, token context, key pooling, round-robin load distribution, and multi-provider failover (Gemini + Groq).",
        rules: "1. Deterministic Extraction: Strict regex and JSON schema enforcement on LLM outputs.\n2. Key Pooling: Auto-cycle through API keys on 429 quota exhaustion.\n3. Multi-Provider Fallback: Seamless Google Gemini -> Groq Cloud Llama-3 failover."
    },
    {
        id: "ultimate-mobile-engineering",
        name: "Mobile & Flutter Engineering",
        category: "frontend",
        icon: "fa-mobile-screen",
        iconColor: "skill-icon-cyan",
        desc: "Cross-platform mobile heuristics, Flutter architecture, responsive touch gestures, and native bridges.",
        rules: "1. Adaptive Breakpoints: Fluid layouts for mobile (320px) through 4K displays.\n2. Touch Targets: Minimum 44x44px clickable areas for mobile terminal interaction."
    },
    {
        id: "ultimate-devops-cicd",
        name: "DevOps & CI/CD Pipelines",
        category: "infra",
        icon: "fa-docker",
        iconColor: "skill-icon-green",
        desc: "Docker containerization, GitHub Actions workflows, multi-stage production builds, and headless daemons.",
        rules: "1. Immutable Builds: Multi-stage Dockerfiles with unprivileged user execution.\n2. Health Checks: Active /health endpoints for orchestrator liveness probes."
    },
    {
        id: "ultimate-security-auditor",
        name: "OWASP Security Auditing",
        category: "infra",
        icon: "fa-shield-halved",
        iconColor: "skill-icon-green",
        desc: "Performs penetration testing, threat modeling, JWT authentication, rate-limiting, and CORS protection.",
        rules: "1. Input Sanitization: Strict parameter validation to eliminate SQL injection.\n2. Secret Security: Zero secrets committed to Git; 100% loaded via .env.\n3. Rate Limiting: Safeguard LLM and execution endpoints from abusive bursts."
    },
    {
        id: "ultimate-sentry-expert",
        name: "Sentry Telemetry & Monitoring",
        category: "infra",
        icon: "fa-chart-pie",
        iconColor: "skill-icon-green",
        desc: "Error tracking, distributed tracing, WebSocket performance telemetry, and automated incident alert routing.",
        rules: "1. Contextual Breadcrumbs: Attach asset ticker, agent step, and timestamp to all exceptions.\n2. Performance Spans: Measure quant strategy evaluation latency."
    },
    {
        id: "ultimate-seo-marketing",
        name: "Agentic SEO & Structured Data",
        category: "frontend",
        icon: "fa-magnifying-glass",
        iconColor: "skill-icon-purple",
        desc: "Technical SEO, Core Web Vitals optimization, OpenGraph social meta tags, and JSON-LD structured schemas.",
        rules: "1. JSON-LD Schemas: SoftwareApplication and FinancialProduct structured metadata.\n2. OpenGraph: Rich preview cards for Twitter and social platforms."
    },
    {
        id: "ultimate-testing-qa",
        name: "Testing QA & Playwright Auditing",
        category: "infra",
        icon: "fa-vial-circle-check",
        iconColor: "skill-icon-green",
        desc: "Unit testing, mathematical indicator verification, Playwright E2E browser tests, and regression prevention.",
        rules: "1. Mathematical Rigor: Verify indicator formulas (RSI, ATR, Bollinger) against benchmark data.\n2. Headless E2E: Automated tests validating login, order placement, and chart rendering."
    },
    {
        id: "ultimate-ux-research",
        name: "UX Research & Cognitive Flow",
        category: "frontend",
        icon: "fa-user-astronaut",
        iconColor: "skill-icon-purple",
        desc: "User discovery, cognitive load reduction, trading HUD ergonomics, and clear telemetry typography.",
        rules: "1. 3-Second Heuristic: A trader must understand market bias, consensus vote, and risk status in under 3 seconds."
    },
    {
        id: "ultimate-git-collaboration",
        name: "Git Collaboration & Discipline",
        category: "infra",
        icon: "fa-code-branch",
        iconColor: "skill-icon-green",
        desc: "Conventional commits, surgical branching, conflict-free pull requests, and atomic change hygiene.",
        rules: "1. Surgical Commits: Group related files by feature layer; never bundle unrelated changes."
    },
    {
        id: "ultimate-firebase-expert",
        name: "Firebase & Cloud BaaS",
        category: "backend",
        icon: "fa-fire",
        iconColor: "skill-icon-yellow",
        desc: "Firestore schema design, Cloud Functions, Security Rules, and real-time document listeners.",
        rules: "1. Security Rules: Strict user-isolated document access policies."
    },
    {
        id: "ultimate-assets-media",
        name: "Media Assets & WebP Optimization",
        category: "frontend",
        icon: "fa-image",
        iconColor: "skill-icon-purple",
        desc: "Asset compression, modern WebP/AVIF images, responsive srcset, and zero-layout-shift lazy loading.",
        rules: "1. Modern Formats: Serve WebP/AVIF with aspect-ratio containers to prevent layout shift."
    }
];

// -------------------------------------------------------------
//   THE 12 QUANTITATIVE TRADING STRATEGIES DATA
// -------------------------------------------------------------
const STRATEGIES_DATA = [
    {
        id: "01",
        name: "Smart Money Concepts (SMC)",
        type: "Order Flow",
        formula: "BOS(20) + FVG(3-bar gap)",
        desc: "Identifies institutional footprints where price breaks swing structure and creates an unmitigated fair value imbalance gap.",
        trigger: "Trigger: 20-period swing break + return into Fair Value Gap"
    },
    {
        id: "02",
        name: "ICT Strategy",
        type: "Market Structure",
        formula: "MSS + Volume > 1.3x ATR",
        desc: "Market Structure Shift confirmed by high institutional volume expansion followed by mitigation into an imbalance zone.",
        trigger: "Trigger: Volume spike expansion on swing break + FVG"
    },
    {
        id: "03",
        name: "Wyckoff Method",
        type: "Liquidity Sweep",
        formula: "Spring / Upthrust (30-bar)",
        desc: "Catches false breakdowns (Springs) and false breakouts (Upthrusts) that trap retail liquidity before smart money reverses trend.",
        trigger: "Trigger: False breach of 30-bar range with sudden reversal"
    },
    {
        id: "04",
        name: "Price Action Rejections",
        type: "Candlestick Heuristic",
        formula: "Pin Bar & Engulfing at S/R",
        desc: "Monitors hammer/shooting star rejection wicks and engulfing expansion candles occurring within 1.5% of verified support/resistance.",
        trigger: "Trigger: Pin bar with 2x wick-to-body ratio at key level"
    },
    {
        id: "05",
        name: "Supply & Demand",
        type: "Base Retracement",
        formula: "Rally-Base-Rally (15-bar)",
        desc: "Pinpoints high-momentum origin zones where institutional orders caused rapid displacement, buying retests into the base.",
        trigger: "Trigger: Price retracing into unmitigated origin base"
    },
    {
        id: "06",
        name: "Trend Following Ribbon",
        type: "Momentum",
        formula: "EMA(9 > 21 > 50 > 200) + ADX > 22",
        desc: "Multi-timeframe exponential moving average alignment paired with Average Directional Index trend strength filter.",
        trigger: "Trigger: Pullback into EMA21 during aligned expansion"
    },
    {
        id: "07",
        name: "Bollinger Breakout",
        type: "Volatility",
        formula: "Close > BB_Upper(20, 2) + Vol > 1.3x",
        desc: "Exploits volatility expansion when price closes outside the 20-period Bollinger Band accompanied by heavy volume confirmation.",
        trigger: "Trigger: Upper/Lower band close with volume surge"
    },
    {
        id: "08",
        name: "Fibonacci Golden Pocket",
        type: "Geometric",
        formula: "50.0% - 61.8% Retracement",
        desc: "Measures 40-bar macro impulse swings and triggers entry when price retraces into the high-probability golden pocket ratio.",
        trigger: "Trigger: Confluence bounce between 0.50 and 0.618 Fib"
    },
    {
        id: "09",
        name: "CVD Order Flow Divergence",
        type: "Volume Delta",
        formula: "Price Low vs CVD High (20-bar)",
        desc: "Detects hidden institutional accumulation when spot price prints lower lows while Cumulative Volume Delta forms higher lows.",
        trigger: "Trigger: Bullish or bearish volume delta divergence"
    },
    {
        id: "10",
        name: "Quantitative Mean Reversion",
        type: "Statistical",
        formula: "Z-Score(SMA20) > |2.0σ|",
        desc: "Calculates statistical standard deviation from 20-period moving average. Triggers fade trades when price reaches overextended extremes.",
        trigger: "Trigger: Z-Score exceeds +/-2.0 sigma with candle exhaustion"
    },
    {
        id: "11",
        name: "SuperTrend Adaptive",
        type: "Trend Trailing",
        formula: "ATR(10) x 2.0 Multiplier",
        desc: "Dynamic volatility-based trailing stop band that flips between bullish support and bearish resistance regimes.",
        trigger: "Trigger: Bar close flipping SuperTrend regime"
    },
    {
        id: "12",
        name: "Hull Moving Average (HMA)",
        type: "Low-Lag Momentum",
        formula: "HMA(9) crossing HMA(21)",
        desc: "High-speed, low-lag smoothed weighted moving average calculating responsive directional crossovers without noise.",
        trigger: "Trigger: Fast HMA9 crossing Slow HMA21"
    }
];

// -------------------------------------------------------------
//   DOM RENDERING & EVENT HANDLERS
// -------------------------------------------------------------

function renderSkills(filterCategory = "all") {
    const grid = document.getElementById("skills-catalog-grid");
    if (!grid) return;

    const filtered = filterCategory === "all" 
        ? ULTIMATE_SKILLS_DATA 
        : ULTIMATE_SKILLS_DATA.filter(s => s.category === filterCategory);

    grid.innerHTML = filtered.map(s => `
        <div class="skill-card">
            <div>
                <div class="skill-card-top">
                    <div class="skill-icon-box ${s.iconColor}">
                        <i class="fa-solid ${s.icon}"></i>
                    </div>
                    <span class="skill-category-pill">${s.category}</span>
                </div>
                <h4>${s.name}</h4>
                <p>${s.desc}</p>
            </div>
            <div class="skill-card-footer">
                <span class="skill-status-tag"><i class="fa-solid fa-circle-check"></i> Active in Agent</span>
                <button class="skill-inspect-btn" onclick="openSkillModal('${s.id}')">
                    Inspect <i class="fa-solid fa-arrow-right"></i>
                </button>
            </div>
        </div>
    `).join("");
}

function renderStrategies() {
    const grid = document.getElementById("strategies-grid");
    if (!grid) return;

    grid.innerHTML = STRATEGIES_DATA.map(st => `
        <div class="strategy-card">
            <div class="strat-header">
                <span class="strat-id">#${st.id}</span>
                <span class="strat-type-pill">${st.type}</span>
            </div>
            <h4>${st.name}</h4>
            <div class="strat-formula-box">${st.formula}</div>
            <p class="strat-desc">${st.desc}</p>
            <div class="strat-trigger">${st.trigger}</div>
        </div>
    `).join("");
}

function filterSkills(category, buttonEl) {
    document.querySelectorAll(".skill-tab").forEach(b => b.classList.remove("active"));
    if (buttonEl) buttonEl.classList.add("active");
    renderSkills(category);
}
window.filterSkills = filterSkills;

// Modal Controls
function openSkillModal(skillId) {
    const skill = ULTIMATE_SKILLS_DATA.find(s => s.id === skillId);
    if (!skill) return;

    const modal = document.getElementById("skill-detail-modal");
    document.getElementById("modal-skill-tag").textContent = skill.category.toUpperCase();
    document.getElementById("modal-skill-title").textContent = skill.name;
    document.getElementById("modal-skill-desc").textContent = skill.desc;
    document.getElementById("modal-skill-rules").textContent = skill.rules.replace(/\\n/g, '\n');

    if (modal) modal.classList.remove("hidden");
}
window.openSkillModal = openSkillModal;

function closeSkillModal() {
    const modal = document.getElementById("skill-detail-modal");
    if (modal) modal.classList.add("hidden");
}
window.closeSkillModal = closeSkillModal;

function triggerAiSimulationDemo() {
    const modal = document.getElementById("ai-simulation-modal");
    if (modal) modal.classList.remove("hidden");

    // Animate steps
    for (let i = 1; i <= 6; i++) {
        const stepEl = document.getElementById(`sim-step-${i}`);
        if (stepEl) {
            stepEl.style.opacity = "0.2";
            setTimeout(() => {
                stepEl.style.opacity = "1";
                stepEl.style.transform = "translateX(4px)";
                setTimeout(() => stepEl.style.transform = "translateX(0)", 200);
            }, i * 350);
        }
    }
}
window.triggerAiSimulationDemo = triggerAiSimulationDemo;

function closeSimModal() {
    const modal = document.getElementById("ai-simulation-modal");
    if (modal) modal.classList.add("hidden");
}
window.closeSimModal = closeSimModal;

// Draw Live Animated Sparkline on Canvas
function drawBtcSparkline() {
    const canvas = document.getElementById("btc-sparkline-canvas");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;

    // Fake realistic sparkline points trending up
    const points = [14, 18, 16, 22, 20, 26, 24, 30, 28, 35, 32, 40, 38, 44];
    const maxVal = Math.max(...points);
    const minVal = Math.min(...points);

    ctx.clearRect(0, 0, width, height);

    // Gradient fill under curve
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "rgba(52, 211, 153, 0.3)");
    gradient.addColorStop(1, "rgba(52, 211, 153, 0.0)");

    ctx.beginPath();
    const stepX = width / (points.length - 1);
    
    points.forEach((val, i) => {
        const x = i * stepX;
        const normalizedY = (val - minVal) / (maxVal - minVal);
        const y = height - 6 - (normalizedY * (height - 12));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });

    // Fill area
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Stroke line
    ctx.beginPath();
    points.forEach((val, i) => {
        const x = i * stepX;
        const normalizedY = (val - minVal) / (maxVal - minVal);
        const y = height - 6 - (normalizedY * (height - 12));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#34d399";
    ctx.lineWidth = 2.5;
    ctx.shadowColor = "#34d399";
    ctx.shadowBlur = 8;
    ctx.stroke();
}

// Initialize Landing Page Components on Load
window.addEventListener("DOMContentLoaded", () => {
    renderSkills("all");
    renderStrategies();
    drawBtcSparkline();
});

// Run once immediately if DOM is already ready
if (document.readyState === "complete" || document.readyState === "interactive") {
    renderSkills("all");
    renderStrategies();
    drawBtcSparkline();
}

// -------------------------------------------------------------
//   PHASE 4: STRATEGY SUITE INSPECTION MODAL
// -------------------------------------------------------------

function openStrategyModal() {
    const modal = document.getElementById("strategy-inspect-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    const sub = document.getElementById("strat-modal-subtitle");
    if (sub) sub.textContent = `Evaluating real-time market setups on ${currentAsset || 'BTC-USD'} (${currentTimeframe || '1d'})`;
    refreshStrategyModal();
}
window.openStrategyModal = openStrategyModal;

function closeStrategyModal() {
    const modal = document.getElementById("strategy-inspect-modal");
    if (modal) modal.classList.add("hidden");
}
window.closeStrategyModal = closeStrategyModal;

async function refreshStrategyModal() {
    const grid = document.getElementById("strategy-modal-grid");
    const tallyEl = document.getElementById("strat-tally-text");
    const timeBadge = document.getElementById("strat-time-badge");
    const sub = document.getElementById("strat-modal-subtitle");

    const asset = currentAsset || "BTC-USD";
    const tf = currentTimeframe || "1d";

    if (sub) sub.textContent = `Evaluating real-time market setups on ${asset} (${tf})`;
    if (tallyEl) tallyEl.innerHTML = `<span class="status-dot green-glow"></span> Querying Market Data System...`;

    try {
        const res = await fetch(`/api/strategies/evaluate?symbol=${encodeURIComponent(asset)}&timeframe=${encodeURIComponent(tf)}`);
        const json = await res.json();

        if (!json.ok || !json.data) {
            if (tallyEl) tallyEl.innerHTML = `<span class="status-dot red-glow"></span> Evaluation failed: ${esc(json.detail || "Server error")}`;
            if (grid) grid.innerHTML = `<div style="padding:24px;text-align:center;color:var(--neg);font-size:12px;">Failed to evaluate strategies. ${esc(json.detail || "")}</div>`;
            return;
        }

        const data = json.data;
        if (timeBadge) timeBadge.textContent = `${data.execution_time_ms.toFixed(1)} ms`;

        const bullCount = data.tally.BULLISH || 0;
        const bearCount = data.tally.BEARISH || 0;
        const setupsFound = data.setups_found || 0;

        if (tallyEl) {
            tallyEl.innerHTML = `<strong>${setupsFound} of ${data.strategies_total}</strong> Setups Active &bull; ` +
                `<span class="text-green">${bullCount} Bullish</span> &bull; ` +
                `<span class="text-red">${bearCount} Bearish</span> &bull; ` +
                `Avg Confidence: <strong>${data.average_confidence}%</strong>`;
        }

        if (grid && Array.isArray(data.results)) {
            grid.innerHTML = data.results.map(r => {
                const isSetup = r.setup_detected;
                const cardClass = isSetup 
                    ? (r.signal === "BULLISH" ? "strat-eval-card setup-active" : "strat-eval-card setup-bearish")
                    : "strat-eval-card";

                const badgeClass = r.signal === "BULLISH" 
                    ? "strat-eval-badge strat-badge-bullish" 
                    : (r.signal === "BEARISH" ? "strat-eval-badge strat-badge-bearish" : "strat-eval-badge strat-badge-neutral");

                const statusTag = isSetup ? "● SETUP ACTIVE" : "○ NO SETUP";
                const conditionsHtml = Object.entries(r.conditions || {}).map(([k, v]) => {
                    const tagClass = v ? "cond-tag cond-true" : "cond-tag cond-false";
                    const icon = v ? "✓" : "✗";
                    return `<span class="${tagClass}">${icon} ${esc(k.replace(/_/g, ' '))}</span>`;
                }).join("");

                return `
                    <div class="${cardClass}">
                        <div class="strat-eval-header">
                            <div class="strat-eval-title">
                                <span class="${badgeClass}">${esc(r.signal)}</span>
                                <span class="strat-eval-name">${esc(r.strategy_name)}</span>
                            </div>
                            <div style="display:flex;align-items:center;gap:8px;">
                                <span style="font-size:11px;font-family:var(--font-mono);font-weight:600;color:${isSetup ? 'var(--accent)' : 'var(--text-3)'}">${statusTag}</span>
                                <span style="font-size:11px;font-family:var(--font-mono);color:var(--text-2);">${r.confidence.toFixed(1)}%</span>
                            </div>
                        </div>
                        <p class="strat-eval-reason">${esc(r.reasoning && r.reasoning[0] ? r.reasoning[0] : "Strategy criteria evaluated.")}</p>
                        ${conditionsHtml ? `<div class="strat-eval-conditions">${conditionsHtml}</div>` : ""}
                    </div>
                `;
            }).join("");
        }
    } catch (err) {
        if (tallyEl) tallyEl.innerHTML = `<span class="status-dot red-glow"></span> Error: ${esc(err.message)}`;
        if (grid) grid.innerHTML = `<div style="padding:24px;text-align:center;color:var(--neg);font-size:12px;">Error connecting to Strategy Engine: ${esc(err.message)}</div>`;
    }
}
window.refreshStrategyModal = refreshStrategyModal;

// -------------------------------------------------------------
//   PHASE 5: CONSENSUS ENGINE RADAR MODAL
// -------------------------------------------------------------

function openConsensusModal() {
    const modal = document.getElementById("consensus-inspect-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    const sub = document.getElementById("consensus-modal-subtitle");
    const asset = currentAsset || "BTC-USD";
    const tf = currentTimeframe || "1d";
    if (sub) sub.textContent = `Unified Market Consensus on ${asset} (${tf})`;
    refreshConsensusModal();
}
window.openConsensusModal = openConsensusModal;

function closeConsensusModal() {
    const modal = document.getElementById("consensus-inspect-modal");
    if (modal) modal.classList.add("hidden");
}
window.closeConsensusModal = closeConsensusModal;

async function refreshConsensusModal() {
    const body = document.getElementById("consensus-modal-body");
    const tallyEl = document.getElementById("consensus-tally-text");
    const timeBadge = document.getElementById("consensus-time-badge");
    const sub = document.getElementById("consensus-modal-subtitle");

    // Banner elements
    const sigPill = document.getElementById("consensus-signal-pill");
    const viewTitle = document.getElementById("consensus-view-title");
    const viewSub = document.getElementById("consensus-view-sub");
    const strengthVal = document.getElementById("consensus-strength-val");
    const agreementVal = document.getElementById("consensus-agreement-val");
    const agreementLevel = document.getElementById("consensus-agreement-level");

    // Force labels & bars
    const bullForceLbl = document.getElementById("consensus-bull-force-lbl");
    const neutForceLbl = document.getElementById("consensus-neutral-force-lbl");
    const bearForceLbl = document.getElementById("consensus-bear-force-lbl");
    const barBull = document.getElementById("consensus-bar-bull");
    const barNeut = document.getElementById("consensus-bar-neut");
    const barBear = document.getElementById("consensus-bar-bear");

    const asset = currentAsset || "BTC-USD";
    const tf = currentTimeframe || "1d";

    if (sub) sub.textContent = `Unified Market Consensus on ${asset} (${tf})`;
    if (tallyEl) tallyEl.innerHTML = `<span class="status-dot green-glow"></span> Running Agents & Quantitative Strategies...`;

    try {
        const res = await fetch(`/api/consensus/evaluate?symbol=${encodeURIComponent(asset)}&timeframe=${encodeURIComponent(tf)}`);
        const json = await res.json();

        if (!json.ok || !json.data) {
            if (tallyEl) tallyEl.innerHTML = `<span class="status-dot red-glow"></span> Evaluation failed: ${esc(json.detail || "Server error")}`;
            if (body) body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--neg);font-size:12px;">Failed to evaluate consensus. ${esc(json.detail || "")}</div>`;
            return;
        }

        const data = json.data;
        if (timeBadge) timeBadge.textContent = `${data.execution_time_ms.toFixed(1)} ms`;

        const sig = data.consensus_signal || data.signal || "NEUTRAL";
        const strength = data.consensus_strength ?? data.strength ?? 0;
        const agreement = data.agreement_score ?? data.agreement_percentage ?? 0;
        const viewTitleText = typeof data.market_view === 'object' ? data.market_view.title : (data.market_view || "Market Equilibrium");
        const viewSummaryText = typeof data.market_view === 'object' ? data.market_view.summary : (data.summary_reasoning || "");

        // Update Overview widget as well if visible
        const overviewConsensus = document.getElementById("overview-consensus-status");
        if (overviewConsensus) {
            overviewConsensus.textContent = `${sig} (${strength.toFixed(0)}%)`;
            overviewConsensus.className = sig === "BULLISH" ? "text-green" : 
                                         sig === "BEARISH" ? "text-red" : 
                                         sig === "MIXED" ? "text-yellow" : "text-blue";
        }

        // 1. Update Hero Banner
        if (sigPill) {
            sigPill.textContent = sig;
            sigPill.className = `consensus-signal-pill ${sig.toLowerCase()}`;
        }
        if (viewTitle) viewTitle.textContent = viewTitleText;
        if (viewSub) viewSub.textContent = viewSummaryText;
        if (strengthVal) strengthVal.textContent = `${strength.toFixed(1)}%`;
        if (agreementVal) agreementVal.textContent = `${agreement.toFixed(1)}%`;
        if (agreementLevel) {
            agreementLevel.textContent = data.agreement_level || "MEDIUM";
            agreementLevel.className = `consensus-metric-val ${data.agreement_level === 'HIGH' ? 'text-green' : data.agreement_level === 'LOW' ? 'text-red' : 'text-yellow'}`;
        }

        // 2. Update Force Bars from tallies
        const bullVotes = (data.agent_tally?.BULLISH || 0) + (data.strategy_tally?.BULLISH || 0);
        const neutVotes = (data.agent_tally?.NEUTRAL || 0) + (data.strategy_tally?.NEUTRAL || 0);
        const bearVotes = (data.agent_tally?.BEARISH || 0) + (data.strategy_tally?.BEARISH || 0);
        const totVotes = bullVotes + neutVotes + bearVotes || 1;
        const pBull = ((bullVotes / totVotes) * 100).toFixed(1);
        const pNeut = ((neutVotes / totVotes) * 100).toFixed(1);
        const pBear = ((bearVotes / totVotes) * 100).toFixed(1);

        if (bullForceLbl) bullForceLbl.innerHTML = `<i class="fa-solid fa-arrow-up"></i> Bullish ${pBull}% (${bullVotes})`;
        if (neutForceLbl) neutForceLbl.textContent = `Neutral ${pNeut}% (${neutVotes})`;
        if (bearForceLbl) bearForceLbl.innerHTML = `Bearish ${pBear}% (${bearVotes}) <i class="fa-solid fa-arrow-down"></i>`;

        if (barBull) barBull.style.width = `${pBull}%`;
        if (barNeut) barNeut.style.width = `${pNeut}%`;
        if (barBear) barBear.style.width = `${pBear}%`;

        // 3. Update Tally Strip
        const totalEvaluated = data.total_evidence_evaluated ?? data.contributing_count ?? totVotes;
        if (tallyEl) {
            tallyEl.innerHTML = `<strong>${totalEvaluated}</strong> Total Sources &bull; ` +
                `<span class="text-green">${bullVotes} Bullish</span> &bull; ` +
                `<span class="text-3">${neutVotes} Neutral</span> &bull; ` +
                `<span class="text-red">${bearVotes} Bearish</span> &bull; ` +
                `Status: <strong>${data.status}</strong>`;
        }

        // 4. Render Evidence Sections
        if (body) {
            let html = "";

            // A. Conflicting Evidence (if any)
            if (Array.isArray(data.conflicting_evidence) && data.conflicting_evidence.length > 0) {
                html += `
                    <div class="consensus-section-header" style="color:#facc15;">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <span>Conflicting Evidence (${data.conflicting_evidence.length})</span>
                    </div>
                    <div class="evidence-grid">
                        ${data.conflicting_evidence.map(e => renderEvidenceCard(e, "conflict")).join("")}
                    </div>
                `;
            }

            // B. Supporting Evidence
            if (Array.isArray(data.supporting_evidence) && data.supporting_evidence.length > 0) {
                html += `
                    <div class="consensus-section-header" style="color:var(--pos);">
                        <i class="fa-solid fa-shield-check"></i>
                        <span>Primary Supporting Evidence (${data.supporting_evidence.length})</span>
                    </div>
                    <div class="evidence-grid">
                        ${data.supporting_evidence.map(e => renderEvidenceCard(e, "supporting")).join("")}
                    </div>
                `;
            }

            // C. Ignored / Failed Evidence (if any)
            if (Array.isArray(data.ignored_evidence) && data.ignored_evidence.length > 0) {
                html += `
                    <div class="consensus-section-header" style="color:var(--text-4);margin-top:12px;">
                        <i class="fa-solid fa-ban"></i>
                        <span>Ignored / Inactive Signals (${data.ignored_evidence.length})</span>
                    </div>
                    <div class="evidence-grid">
                        ${data.ignored_evidence.map(e => `
                            <div class="evidence-card failed">
                                <div class="evidence-card-header">
                                    <div class="evidence-source-info">
                                        <span class="evidence-type-badge">${esc(e.type || "UNKNOWN")}</span>
                                        <span class="evidence-source-name">${esc(e.id || "Source")}</span>
                                    </div>
                                    <span class="strat-eval-badge strat-badge-neutral">${esc(e.reason || "SKIPPED")}</span>
                                </div>
                                <div class="evidence-card-reason">${esc(e.detail || "Source omitted from voting.")}</div>
                            </div>
                        `).join("")}
                    </div>
                `;
            }

            body.innerHTML = html;
        }

    } catch (err) {
        if (tallyEl) tallyEl.innerHTML = `<span class="status-dot red-glow"></span> Error: ${esc(err.message)}`;
        if (body) body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--neg);font-size:12px;">Error connecting to Consensus Engine: ${esc(err.message)}</div>`;
    }
}
window.refreshConsensusModal = refreshConsensusModal;

function renderEvidenceCard(e, modifier) {
    const cardClass = modifier === "conflict" ? "evidence-card conflict" :
                      modifier === "supporting" ? "evidence-card supporting" :
                      modifier === "failed" ? "evidence-card failed" : "evidence-card";

    const badgeClass = e.signal === "BULLISH" ? "strat-eval-badge strat-badge-bullish" :
                       e.signal === "BEARISH" ? "strat-eval-badge strat-badge-bearish" : "strat-eval-badge strat-badge-neutral";

    const srcType = e.evidence_type || e.source_type || "SOURCE";
    const reasonText = e.summary || e.reasoning || "Analysis criteria evaluated.";

    return `
        <div class="${cardClass}">
            <div class="evidence-card-header">
                <div class="evidence-source-info">
                    <span class="evidence-type-badge">${esc(srcType)}</span>
                    <span class="evidence-source-name">${esc(e.source_name)}</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                    <span class="${badgeClass}">${esc(e.signal)}</span>
                    <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-3);">${(e.confidence || 0).toFixed(0)}%</span>
                </div>
            </div>
            <div class="evidence-card-reason">${esc(reasonText)}</div>
        </div>
    `;
}

// -------------------------------------------------------------
//   PHASE 6: ORBIT BRAIN CENTRAL INTELLIGENCE MODAL
// -------------------------------------------------------------

function openBrainModal() {
    const modal = document.getElementById("brain-inspect-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    const sub = document.getElementById("brain-modal-subtitle");
    const asset = currentAsset || "BTC-USD";
    const tf = currentTimeframe || "1d";
    if (sub) sub.textContent = `Central Intelligence Orchestration Dossier on ${asset} (${tf})`;
    refreshBrainModal();
}
window.openBrainModal = openBrainModal;

function closeBrainModal() {
    const modal = document.getElementById("brain-inspect-modal");
    if (modal) modal.classList.add("hidden");
}
window.closeBrainModal = closeBrainModal;

async function refreshBrainModal() {
    const sub = document.getElementById("brain-modal-subtitle");
    const statusTag = document.getElementById("brain-status-tag");
    const biasPill = document.getElementById("brain-bias-pill");
    const convictionPill = document.getElementById("brain-conviction-pill");
    const tierPill = document.getElementById("brain-tier-pill");
    const execText = document.getElementById("brain-exec-summary-text");

    // Market Overview
    const mktPrice = document.getElementById("brain-mkt-price");
    const mktChange = document.getElementById("brain-mkt-change");
    const mktAtr = document.getElementById("brain-mkt-atr");
    const mktRegime = document.getElementById("brain-mkt-regime");

    // Agent Summary
    const agentLeading = document.getElementById("brain-agent-leading");
    const agentBull = document.getElementById("brain-agent-bull");
    const agentNeut = document.getElementById("brain-agent-neut");
    const agentBear = document.getElementById("brain-agent-bear");
    const agentConf = document.getElementById("brain-agent-conf");

    // Strategy Summary
    const stratSetupsTag = document.getElementById("brain-strat-setups-tag");
    const stratActiveCount = document.getElementById("brain-strat-active-count");
    const stratBull = document.getElementById("brain-strat-bull");
    const stratBear = document.getElementById("brain-strat-bear");
    const stratActiveList = document.getElementById("brain-strat-active-list");

    // Consensus Summary
    const consStatusTag = document.getElementById("brain-cons-status-tag");
    const consSig = document.getElementById("brain-cons-sig");
    const consStrength = document.getElementById("brain-cons-strength");
    const consAgree = document.getElementById("brain-cons-agree");
    const consMarketView = document.getElementById("brain-market-view-line");

    // Evidence & Diagnostics
    const evidenceSection = document.getElementById("brain-evidence-section");
    const diagLatency = document.getElementById("brain-diag-latency");
    const diagComp = document.getElementById("brain-diag-comp");

    const asset = currentAsset || "BTC-USD";
    const tf = currentTimeframe || "1d";

    if (sub) sub.textContent = `Central Intelligence Orchestration Dossier on ${asset} (${tf})`;
    if (execText) execText.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i> Orchestrating multi-system intelligence across market data, 7 AI agents, 12 strategies, and consensus...`;

    try {
        const res = await fetch(`/api/brain/analyze?symbol=${encodeURIComponent(asset)}&timeframe=${encodeURIComponent(tf)}`);
        const json = await res.json();

        if (!json.ok || !json.data) {
            if (execText) execText.innerHTML = `<span style="color:var(--neg);">Analysis failed: ${esc(json.detail || "Server error")}</span>`;
            if (statusTag) {
                statusTag.textContent = "FAILED";
                statusTag.style.color = "var(--neg)";
            }
            return;
        }

        const data = json.data;

        // 1. Executive Banner
        if (statusTag) {
            statusTag.textContent = data.analysis_status || "READY";
            statusTag.style.color = data.analysis_status === "READY" ? "var(--pos)" : 
                                    data.analysis_status === "PARTIAL" ? "#facc15" : "var(--neg)";
        }
        if (biasPill) {
            const b = data.overall_bias || "NEUTRAL";
            biasPill.textContent = b;
            biasPill.className = `consensus-signal-pill ${b.toLowerCase()}`;
        }
        if (convictionPill) {
            convictionPill.textContent = `Conviction: ${(data.conviction_strength || 0).toFixed(1)}%`;
        }
        if (tierPill) {
            tierPill.textContent = `${data.completeness_tier} (${(data.completeness_score || 0).toFixed(0)}%)`;
            tierPill.style.color = data.completeness_tier === "COMPLETE" ? "var(--pos)" : 
                                   data.completeness_tier === "PARTIAL" ? "#facc15" : "var(--neg)";
        }
        if (execText) {
            execText.textContent = data.executive_summary || "Complete market analysis synthesized.";
        }

        // 2. Market Overview Card
        const mkt = data.market_summary || {};
        if (mktPrice) mktPrice.textContent = `$${(mkt.current_price || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        if (mktChange) {
            const chgPct = (mkt.price_change_pct || 0);
            const sign = chgPct >= 0 ? "+" : "";
            mktChange.textContent = `${sign}${chgPct.toFixed(2)}%`;
            mktChange.className = chgPct >= 0 ? "brain-sub-val text-green" : "brain-sub-val text-red";
        }
        if (mktAtr) mktAtr.textContent = `${(mkt.volatility_atr || 0).toFixed(2)} (${(mkt.volatility_pct || 0).toFixed(2)}%)`;
        if (mktRegime) mktRegime.textContent = mkt.trend_regime || "REGIME";

        // 3. AI Agent Summary Card
        const ag = data.agent_summary || {};
        const agTally = ag.tally || {};
        if (agentLeading) agentLeading.textContent = ag.leading_signal || "NEUTRAL";
        if (agentBull) agentBull.textContent = agTally.BULLISH || 0;
        if (agentNeut) agentNeut.textContent = agTally.NEUTRAL || 0;
        if (agentBear) agentBear.textContent = agTally.BEARISH || 0;
        if (agentConf) agentConf.textContent = `${(ag.average_confidence || 0).toFixed(0)}%`;

        // 4. Strategy Setup Card
        const st = data.strategy_summary || {};
        const stTally = st.tally || {};
        if (stratSetupsTag) stratSetupsTag.textContent = `${st.setups_found || 0} SETUPS`;
        if (stratActiveCount) stratActiveCount.textContent = `${st.setups_found || 0} / ${st.strategies_evaluated || 12}`;
        if (stratBull) stratBull.textContent = st.bullish_setups || 0;
        if (stratBear) stratBear.textContent = st.bearish_setups || 0;
        if (stratActiveList) {
            if (Array.isArray(st.active_strategies) && st.active_strategies.length > 0) {
                stratActiveList.innerHTML = st.active_strategies.map(name => 
                    `<span class="strat-eval-badge strat-badge-bullish" style="font-size:9.5px;">✓ ${esc(name)}</span>`
                ).join("");
            } else {
                stratActiveList.innerHTML = `<span style="font-size:10.5px;color:var(--text-4);font-style:italic;">No active strategy setups detected</span>`;
            }
        }

        // 5. Consensus Synthesis Card
        const cs = data.consensus_summary || {};
        if (consStatusTag) consStatusTag.textContent = cs.status || "READY";
        if (consSig) {
            consSig.textContent = cs.signal || "NEUTRAL";
            consSig.className = cs.signal === "BULLISH" ? "brain-sub-val text-green" :
                                cs.signal === "BEARISH" ? "brain-sub-val text-red" :
                                cs.signal === "MIXED" ? "brain-sub-val text-yellow" : "brain-sub-val text-blue";
        }
        if (consStrength) consStrength.textContent = `${(cs.strength || 0).toFixed(1)}%`;
        if (consAgree) consAgree.textContent = `${(cs.agreement_score || 0).toFixed(0)}% (${cs.agreement_level || "MED"})`;
        if (consMarketView) consMarketView.textContent = cs.market_view || "Market Equilibrium";

        // 6. Evidence Extraction
        if (evidenceSection) {
            let html = "";
            const sup = data.key_supporting_evidence || [];
            const conf = data.key_conflicting_evidence || [];

            if (conf.length > 0) {
                html += `
                    <div class="consensus-section-header" style="color:#facc15;">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <span>Key Conflicting Evidence (${conf.length})</span>
                    </div>
                    <div class="evidence-grid">
                        ${conf.map(e => renderEvidenceCard(e, "conflict")).join("")}
                    </div>
                `;
            }

            if (sup.length > 0) {
                html += `
                    <div class="consensus-section-header" style="color:var(--pos);margin-top:4px;">
                        <i class="fa-solid fa-shield-check"></i>
                        <span>Key Supporting Evidence (${sup.length})</span>
                    </div>
                    <div class="evidence-grid">
                        ${sup.map(e => renderEvidenceCard(e, "supporting")).join("")}
                    </div>
                `;
            }

            evidenceSection.innerHTML = html;
        }

        // 7. Diagnostics
        const diag = data.diagnostics || {};
        if (diagLatency) diagLatency.textContent = `${(diag.total_pipeline_ms || 0).toFixed(1)} ms`;
        if (diagComp) diagComp.textContent = `${(data.completeness_score || 0).toFixed(1)}%`;

    } catch (err) {
        if (execText) execText.innerHTML = `<span style="color:var(--neg);">Error connecting to ORBIT Brain: ${esc(err.message)}</span>`;
    }
}
window.refreshBrainModal = refreshBrainModal;

// -------------------------------------------------------------
// 12. ORBIT RISK GUARD MODAL CONTROLLER (PHASE 7)
// -------------------------------------------------------------

function openRiskModal() {
    const modal = document.getElementById("risk-guard-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    const sub = document.getElementById("risk-modal-subtitle");
    const asset = currentAsset || "BTC-USD";
    const tf = currentTimeframe || "1d";
    if (sub) sub.textContent = `Analysis Quality & Market Safety Audit on ${asset} (${tf})`;
    refreshRiskModal();
}
window.openRiskModal = openRiskModal;

function closeRiskModal() {
    const modal = document.getElementById("risk-guard-modal");
    if (modal) modal.classList.add("hidden");
}
window.closeRiskModal = closeRiskModal;

async function refreshRiskModal() {
    const sub = document.getElementById("risk-modal-subtitle");
    const statusTag = document.getElementById("risk-status-tag");
    const levelPill = document.getElementById("risk-level-pill");
    const heroTitle = document.getElementById("risk-hero-title");
    const heroSummary = document.getElementById("risk-hero-summary");
    const scoreNum = document.getElementById("risk-score-number");
    const barFill = document.getElementById("risk-meter-bar-fill");
    const dimsGrid = document.getElementById("risk-dimensions-grid");
    const factorsList = document.getElementById("risk-factors-list");
    const factorsCount = document.getElementById("risk-factors-count");
    const safetyList = document.getElementById("safety-factors-list");
    const safetyCount = document.getElementById("safety-factors-count");
    const diagLatency = document.getElementById("risk-diag-latency");
    const diagDims = document.getElementById("risk-diag-dims");

    const asset = currentAsset || "BTC-USD";
    const tf = currentTimeframe || "1d";

    if (sub) sub.textContent = `Analysis Quality & Market Safety Audit on ${asset} (${tf})`;
    if (heroSummary) heroSummary.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i> Evaluating multi-dimensional safety vectors across volatility, conflict, consensus, quality, and data...`;

    try {
        const res = await fetch(`/api/risk/evaluate?symbol=${encodeURIComponent(asset)}&timeframe=${encodeURIComponent(tf)}`);
        const json = await res.json();

        if (!json.ok || !json.data) {
            if (heroSummary) heroSummary.innerHTML = `<span style="color:var(--neg);">Risk audit failed: ${esc(json.detail || "Server error")}</span>`;
            if (statusTag) {
                statusTag.textContent = "FAILED";
                statusTag.style.color = "var(--neg)";
            }
            return;
        }

        const data = json.data;

        // 1. Status tag
        if (statusTag) {
            statusTag.textContent = data.status || "READY";
            statusTag.style.color = data.status === "READY" ? "var(--pos)" : 
                                    data.status === "PARTIAL" ? "#facc15" : "var(--neg)";
        }

        // 2. Risk Level Pill & Hero Title
        const lvl = data.risk_level || "MODERATE";
        if (levelPill) {
            levelPill.textContent = lvl;
            levelPill.className = `risk-level-pill ${lvl.toLowerCase()}`;
        }
        if (heroTitle) {
            heroTitle.textContent = lvl === "LOW" ? "Controlled Risk Profile" :
                                    lvl === "MODERATE" ? "Standard Market Volatility" :
                                    lvl === "HIGH" ? "Elevated Risk Warning" : "CRITICAL RISK ALERT";
        }
        if (heroSummary) {
            heroSummary.textContent = data.summary || "Risk assessment completed.";
        }

        // 3. Score Number & Meter Bar
        const score = data.risk_score || 0;
        if (scoreNum) {
            scoreNum.innerHTML = `${score.toFixed(1)}<span style="font-size:13px;color:var(--text-3);font-weight:400;">/100</span>`;
        }
        if (barFill) {
            barFill.style.width = `${Math.min(100, Math.max(5, score))}%`;
            barFill.style.background = lvl === "LOW" ? "var(--pos)" :
                                       lvl === "MODERATE" ? "#F59E0B" :
                                       lvl === "HIGH" ? "#F97316" : "var(--neg)";
        }

        // 4. 5-Dimension Evaluation Grid
        if (dimsGrid && data.dimensions) {
            const dims = data.dimensions;
            const dimKeys = ["volatility", "signal_conflict", "consensus", "analysis_quality", "data_quality"];
            const dimIcons = {
                volatility: "fa-solid fa-wave-square",
                signal_conflict: "fa-solid fa-code-compare",
                consensus: "fa-solid fa-brain",
                analysis_quality: "fa-solid fa-shield-halved",
                data_quality: "fa-solid fa-database"
            };

            dimsGrid.innerHTML = dimKeys.map(key => {
                const d = dims[key];
                if (!d) return "";
                const dLvl = d.level || "MODERATE";
                const lvlColor = dLvl === "LOW" ? "var(--pos)" :
                                 dLvl === "MODERATE" ? "#F59E0B" :
                                 dLvl === "HIGH" ? "#F97316" : "var(--neg)";
                const icon = dimIcons[key] || "fa-solid fa-cubes";
                return `
                    <div class="risk-dim-card">
                        <div class="risk-dim-header">
                            <div class="risk-dim-title">
                                <i class="${icon}" style="color:${lvlColor};"></i>
                                <span>${esc(d.name)}</span>
                            </div>
                            <span class="risk-dim-score" style="color:${lvlColor};">${(d.score || 0).toFixed(0)}/100</span>
                        </div>
                        <div class="risk-dim-summary">${esc(d.summary)}</div>
                    </div>
                `;
            }).join("");
        }

        // 5. Risk Factors (Warnings)
        const rfList = data.risk_factors || [];
        if (factorsCount) factorsCount.textContent = rfList.length;
        if (factorsList) {
            if (rfList.length === 0) {
                factorsList.innerHTML = `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">✓ No active elevated risk warnings detected in current state.</div>`;
            } else {
                factorsList.innerHTML = rfList.map(rf => `
                    <div class="risk-factor-item">
                        <div class="risk-factor-title">
                            <i class="fa-solid fa-triangle-exclamation"></i>
                            <span>${esc(rf.title)}</span>
                        </div>
                        <div class="risk-factor-detail">${esc(rf.detail)}</div>
                    </div>
                `).join("");
            }
        }

        // 6. Stabilizing Safety Factors
        const sfList = data.safety_factors || [];
        if (safetyCount) safetyCount.textContent = sfList.length;
        if (safetyList) {
            if (sfList.length === 0) {
                safetyList.innerHTML = `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">No specific stabilizing conditions identified.</div>`;
            } else {
                safetyList.innerHTML = sfList.map(sf => `
                    <div class="safety-factor-item">
                        <div class="safety-factor-title">
                            <i class="fa-solid fa-circle-check"></i>
                            <span>${esc(sf.title)}</span>
                        </div>
                        <div class="safety-factor-detail">${esc(sf.detail)}</div>
                    </div>
                `).join("");
            }
        }

        // 7. Diagnostics
        const diag = data.diagnostics || {};
        if (diagLatency) diagLatency.textContent = `${(diag.evaluation_latency_ms || 0).toFixed(1)} ms`;
        if (diagDims) diagDims.textContent = `${diag.dimensions_evaluated || 5}/5`;

    } catch (err) {
        if (heroSummary) heroSummary.innerHTML = `<span style="color:var(--neg);">Error connecting to Risk Guard: ${esc(err.message)}</span>`;
    }
}
window.refreshRiskModal = refreshRiskModal;

// -------------------------------------------------------------
// 13. ORBIT OPPORTUNITY EVALUATION ENGINE MODAL CONTROLLER (PHASE 8)
// -------------------------------------------------------------

function openOpportunityModal() {
    const modal = document.getElementById("opportunity-eval-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    const sub = document.getElementById("opp-modal-subtitle");
    const asset = currentAsset || "BTC-USD";
    const tf = currentTimeframe || "1d";
    if (sub) sub.textContent = `Multi-System Confluence & Setup Quality Assessment on ${asset} (${tf})`;
    refreshOpportunityModal();
}
window.openOpportunityModal = openOpportunityModal;

function closeOpportunityModal() {
    const modal = document.getElementById("opportunity-eval-modal");
    if (modal) modal.classList.add("hidden");
}
window.closeOpportunityModal = closeOpportunityModal;

async function refreshOpportunityModal() {
    const sub = document.getElementById("opp-modal-subtitle");
    const statusTag = document.getElementById("opp-status-tag");
    const levelPill = document.getElementById("opp-level-pill");
    const biasPill = document.getElementById("opp-bias-pill");
    const heroTitle = document.getElementById("opp-hero-title");
    const heroSummary = document.getElementById("opp-hero-summary");
    const scoreNum = document.getElementById("opp-score-number");
    const barFill = document.getElementById("opp-meter-bar-fill");
    const dimsGrid = document.getElementById("opp-dimensions-grid");
    const strengthList = document.getElementById("opp-strength-list");
    const strengthCount = document.getElementById("opp-strength-count");
    const weaknessList = document.getElementById("opp-weakness-list");
    const weaknessCount = document.getElementById("opp-weakness-count");
    const diagLatency = document.getElementById("opp-diag-latency");
    const diagTotal = document.getElementById("opp-diag-total");
    const diagDims = document.getElementById("opp-diag-dims");

    const asset = currentAsset || "BTC-USD";
    const tf = currentTimeframe || "1d";

    if (sub) sub.textContent = `Multi-System Confluence & Setup Quality Assessment on ${asset} (${tf})`;
    if (heroSummary) heroSummary.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i> Evaluating cross-pipeline confluence across consensus, strategies, agents, risk headroom, and data completeness...`;

    try {
        const res = await fetch(`/api/opportunity/evaluate?symbol=${encodeURIComponent(asset)}&timeframe=${encodeURIComponent(tf)}`);
        const json = await res.json();

        if (!json.ok || !json.data) {
            if (heroSummary) heroSummary.innerHTML = `<span style="color:var(--neg);">Opportunity evaluation failed: ${esc(json.detail || "Server error")}</span>`;
            if (statusTag) {
                statusTag.textContent = "FAILED";
                statusTag.style.color = "var(--neg)";
            }
            if (levelPill) {
                levelPill.textContent = "VERY_LOW";
                levelPill.className = "opp-level-pill very-low";
            }
            if (scoreNum) {
                scoreNum.innerHTML = `0.0<span style="font-size:13px;color:var(--text-3);font-weight:400;">/100</span>`;
            }
            return;
        }

        const data = json.data;

        // 1. Status tag
        if (statusTag) {
            statusTag.textContent = data.status || "READY";
            statusTag.style.color = data.status === "READY" ? "var(--pos)" :
                                    data.status === "PARTIAL" ? "#facc15" :
                                    data.status === "LIMITED" ? "#f97316" : "var(--neg)";
        }

        // 2. Opportunity Level & Bias Pills
        const lvl = data.opportunity_level || "MODERATE";
        const lvlNormalized = lvl.toLowerCase().replace("_", "-");
        if (levelPill) {
            levelPill.textContent = lvl.replace("_", " ");
            levelPill.className = `opp-level-pill ${lvlNormalized}`;
        }

        const bias = data.directional_bias || "NEUTRAL";
        if (biasPill) {
            biasPill.textContent = bias;
            biasPill.className = `opp-bias-pill ${bias.toLowerCase()}`;
        }

        // Hero Title & Summary
        if (heroTitle) {
            heroTitle.textContent = lvl === "VERY_HIGH" ? "Exceptional Multi-System Confluence" :
                                    lvl === "HIGH" ? "Strong Analytical Confluence" :
                                    lvl === "MODERATE" ? "Balanced Setup Quality" :
                                    lvl === "LOW" ? "Weak Confluence / High Friction" :
                                    "Minimal Trade Setup Opportunity";
        }
        if (heroSummary) {
            heroSummary.textContent = data.summary || "Opportunity confluence evaluated across ORBIT intelligence stack.";
        }

        // 3. Score Number & Meter Bar
        const score = data.opportunity_score || 0;
        if (scoreNum) {
            scoreNum.innerHTML = `${score.toFixed(1)}<span style="font-size:13px;color:var(--text-3);font-weight:400;">/100</span>`;
        }
        if (barFill) {
            barFill.style.width = `${Math.min(100, Math.max(5, score))}%`;
            barFill.style.background = (lvl === "VERY_HIGH" || lvl === "HIGH") ? "var(--pos)" :
                                       lvl === "MODERATE" ? "#F59E0B" :
                                       lvl === "LOW" ? "#F97316" : "var(--neg)";
        }

        // 4. 5-Dimension Opportunity Grid
        if (dimsGrid && data.dimensions) {
            const dims = data.dimensions;
            const dimKeys = ["consensus_quality", "strategy_confluence", "agent_harmony", "risk_headroom", "analysis_completeness"];
            const dimIcons = {
                consensus_quality: "fa-solid fa-brain",
                strategy_confluence: "fa-solid fa-layer-group",
                agent_harmony: "fa-solid fa-robot",
                risk_headroom: "fa-solid fa-shield-halved",
                analysis_completeness: "fa-solid fa-circle-check"
            };

            dimsGrid.innerHTML = dimKeys.map(key => {
                const d = dims[key];
                if (!d) return "";
                const dScore = d.score || 0;
                const dColor = dScore >= 70 ? "var(--pos)" :
                               dScore >= 50 ? "#06b6d4" :
                               dScore >= 35 ? "#F59E0B" : "var(--neg)";
                const icon = dimIcons[key] || "fa-solid fa-cubes";
                return `
                    <div class="opp-dim-card">
                        <div class="opp-dim-header">
                            <div class="opp-dim-title">
                                <i class="${icon}" style="color:${dColor};"></i>
                                <span>${esc(d.name)}</span>
                            </div>
                            <span class="opp-dim-score" style="color:${dColor};">${dScore.toFixed(0)}/100</span>
                        </div>
                        <div class="opp-dim-summary">${esc(d.summary)}</div>
                    </div>
                `;
            }).join("");
        }

        // 5. Confluence Boosters (Strengths)
        const stList = data.strength_factors || [];
        if (strengthCount) strengthCount.textContent = stList.length;
        if (strengthList) {
            if (stList.length === 0) {
                strengthList.innerHTML = `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">No strong confluence boosters detected in current market state.</div>`;
            } else {
                strengthList.innerHTML = stList.map(st => `
                    <div class="opp-factor-item booster">
                        <div class="opp-factor-title booster">
                            <i class="fa-solid fa-circle-check"></i>
                            <span>${esc(st.title)}</span>
                        </div>
                        <div class="opp-factor-detail">${esc(st.detail)}</div>
                    </div>
                `).join("");
            }
        }

        // 6. Opportunity Headwinds (Weaknesses)
        const wkList = data.weakness_factors || [];
        if (weaknessCount) weaknessCount.textContent = wkList.length;
        if (weaknessList) {
            if (wkList.length === 0) {
                weaknessList.innerHTML = `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">✓ Zero significant headwinds or frictions identified.</div>`;
            } else {
                weaknessList.innerHTML = wkList.map(wk => `
                    <div class="opp-factor-item headwind">
                        <div class="opp-factor-title headwind">
                            <i class="fa-solid fa-triangle-exclamation"></i>
                            <span>${esc(wk.title)}</span>
                        </div>
                        <div class="opp-factor-detail">${esc(wk.detail)}</div>
                    </div>
                `).join("");
            }
        }

        // 7. Diagnostics Strip
        const diag = data.diagnostics || {};
        if (diagLatency) diagLatency.textContent = `${(diag.evaluation_latency_ms || 0).toFixed(2)} ms`;
        if (diagTotal) diagTotal.textContent = `${(diag.total_pipeline_ms || 0).toFixed(1)} ms`;
        if (diagDims) diagDims.textContent = `${diag.dimensions_evaluated || 5}/5`;

    } catch (err) {
        if (heroSummary) heroSummary.innerHTML = `<span style="color:var(--neg);">Error connecting to Opportunity Engine: ${esc(err.message)}</span>`;
    }
}
window.refreshOpportunityModal = refreshOpportunityModal;

// -------------------------------------------------------------
// 14. ORBIT DECISION ENGINE MODAL CONTROLLER (PHASE 9)
// -------------------------------------------------------------

function openDecisionModal() {
    const modal = document.getElementById("decision-eval-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    const sub = document.getElementById("decision-modal-subtitle");
    const asset = currentAsset || "BTC-USD";
    const tf = currentTimeframe || "1d";
    if (sub) sub.textContent = `Evidence-Based Analytical Market Stance Synthesis on ${asset} (${tf})`;
    refreshDecisionModal();
}
window.openDecisionModal = openDecisionModal;

function closeDecisionModal() {
    const modal = document.getElementById("decision-eval-modal");
    if (modal) modal.classList.add("hidden");
}
window.closeDecisionModal = closeDecisionModal;

async function refreshDecisionModal() {
    const sub = document.getElementById("decision-modal-subtitle");
    const statusTag = document.getElementById("decision-status-tag");
    const stanceBadge = document.getElementById("decision-stance-badge");
    const clarityTag = document.getElementById("decision-clarity-tag");
    const heroTitle = document.getElementById("decision-hero-title");
    const heroSummary = document.getElementById("decision-hero-summary");
    const confNum = document.getElementById("decision-confidence-number");
    const barFill = document.getElementById("decision-meter-bar-fill");

    const inConsensus = document.getElementById("dec-in-consensus");
    const inConsensusSub = document.getElementById("dec-in-consensus-sub");
    const inRisk = document.getElementById("dec-in-risk");
    const inRiskSub = document.getElementById("dec-in-risk-sub");
    const inOpp = document.getElementById("dec-in-opp");
    const inOppSub = document.getElementById("dec-in-opp-sub");
    const inPipeline = document.getElementById("dec-in-pipeline");
    const inPipelineSub = document.getElementById("dec-in-pipeline-sub");

    const evidenceList = document.getElementById("decision-evidence-list");
    const evidenceCount = document.getElementById("decision-evidence-count");
    const constraintsList = document.getElementById("decision-constraints-list");
    const constraintsCount = document.getElementById("decision-constraints-count");

    const diagLatency = document.getElementById("dec-diag-latency");
    const diagTotal = document.getElementById("dec-diag-total");
    const diagClarity = document.getElementById("dec-diag-clarity");

    const asset = currentAsset || "BTC-USD";
    const tf = currentTimeframe || "1d";

    if (sub) sub.textContent = `Evidence-Based Analytical Market Stance Synthesis on ${asset} (${tf})`;
    if (heroSummary) heroSummary.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i> Synthesizing market stance across consensus direction, opportunity setup quality, and risk constraints...`;

    try {
        const res = await fetch(`/api/decision/evaluate?symbol=${encodeURIComponent(asset)}&timeframe=${encodeURIComponent(tf)}`);
        const json = await res.json();

        if (!json.ok || !json.data) {
            if (heroSummary) heroSummary.innerHTML = `<span style="color:var(--neg);">Decision synthesis failed: ${esc(json.detail || "Server error")}</span>`;
            if (statusTag) {
                statusTag.textContent = "FAILED";
                statusTag.style.color = "var(--neg)";
            }
            if (stanceBadge) {
                stanceBadge.textContent = "INSUFFICIENT DATA";
                stanceBadge.className = "decision-stance-badge insufficient-data";
            }
            if (clarityTag) {
                clarityTag.textContent = "INSUFFICIENT";
            }
            if (confNum) {
                confNum.innerHTML = `0.0<span style="font-size:13px;color:var(--text-3);font-weight:400;">/100</span>`;
            }
            return;
        }

        const data = json.data;

        // 1. Status tag
        if (statusTag) {
            statusTag.textContent = data.status || "READY";
            statusTag.style.color = data.status === "READY" ? "var(--pos)" :
                                    data.status === "PARTIAL" ? "#facc15" :
                                    data.status === "LIMITED" ? "#f97316" : "var(--neg)";
        }

        // 2. Stance Badge & Clarity Tag
        const stance = data.decision || "NEUTRAL";
        const stanceNormalized = stance.toLowerCase().replace(/_/g, "-");
        if (stanceBadge) {
            stanceBadge.textContent = stance.replace(/_/g, " ");
            stanceBadge.className = `decision-stance-badge ${stanceNormalized}`;
        }

        const clarity = data.decision_clarity || "MODERATE";
        if (clarityTag) {
            clarityTag.textContent = clarity;
            clarityTag.style.color = clarity === "CLEAR" ? "var(--pos)" :
                                     clarity === "MODERATE" ? "#38bdf8" :
                                     clarity === "UNCLEAR" ? "#f59e0b" : "var(--neg)";
        }

        // 3. Hero Title & Summary
        if (heroTitle) {
            heroTitle.textContent = stance === "BULLISH" ? "Authoritative Bullish Market Stance" :
                                    stance === "BEARISH" ? "Authoritative Bearish Market Stance" :
                                    stance === "NEUTRAL" ? "Consolidation Equilibrium (Neutral)" :
                                    stance === "MIXED" ? "Polar Volatility Deadlock (Mixed)" :
                                    stance === "NO_CLEAR_DECISION" ? "Ambiguous Evidence (No Clear Stance)" :
                                    "Insufficient Market Intelligence";
        }
        if (heroSummary) {
            heroSummary.textContent = data.summary || "Market stance synthesized across ORBIT intelligence stack.";
        }

        // 4. Evidence Confidence Number & Meter Bar
        const conf = data.decision_confidence || 0;
        if (confNum) {
            confNum.innerHTML = `${conf.toFixed(1)}<span style="font-size:13px;color:var(--text-3);font-weight:400;">/100</span>`;
        }
        if (barFill) {
            barFill.style.width = `${Math.min(100, Math.max(5, conf))}%`;
            barFill.style.background = (stance === "BULLISH") ? "var(--pos)" :
                                       (stance === "BEARISH") ? "var(--neg)" :
                                       (stance === "NEUTRAL") ? "#F59E0B" : "#A855F7";
        }

        // 5. Input Summary Quad Card Grid
        const inSum = data.input_summary || {};
        if (inConsensus) inConsensus.textContent = inSum.consensus_signal || "--";
        if (inConsensusSub) inConsensusSub.textContent = `Strength: ${(inSum.consensus_strength || 0).toFixed(0)} | Agreement: ${(inSum.agreement_score || 0).toFixed(0)}%`;

        if (inRisk) inRisk.textContent = inSum.risk_level || "--";
        if (inRiskSub) inRiskSub.textContent = `Score: ${(inSum.risk_score || 0).toFixed(1)}/100`;

        if (inOpp) inOpp.textContent = (inSum.opportunity_level || "--").replace("_", " ");
        if (inOppSub) inOppSub.textContent = `Confluence: ${(inSum.opportunity_score || 0).toFixed(1)}/100`;

        if (inPipeline) inPipeline.textContent = `${(inSum.completeness_score || 0).toFixed(0)}%`;
        if (inPipelineSub) inPipelineSub.textContent = `Tier: ${inSum.completeness_tier || "--"}`;

        // 6. Primary & Supporting Evidence List
        const peList = data.primary_evidence || [];
        const seList = data.supporting_evidence || [];
        const totalEvidence = peList.length + seList.length;
        if (evidenceCount) evidenceCount.textContent = totalEvidence;
        if (evidenceList) {
            if (totalEvidence === 0) {
                evidenceList.innerHTML = `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">No active evidence items detected.</div>`;
            } else {
                const peHtml = peList.map(e => `
                    <div class="decision-evidence-card">
                        <i class="fa-solid fa-circle-check text-green" style="margin-top:2px;"></i>
                        <span><strong>Primary:</strong> ${esc(e)}</span>
                    </div>
                `).join("");
                const seHtml = seList.map(e => `
                    <div class="decision-evidence-card" style="border-left-color:var(--cyan);background:rgba(6,182,212,0.04);">
                        <i class="fa-solid fa-plus text-cyan" style="margin-top:2px;"></i>
                        <span><strong>Corroborating:</strong> ${esc(e)}</span>
                    </div>
                `).join("");
                evidenceList.innerHTML = peHtml + seHtml;
            }
        }

        // 7. Constraints, Headwinds & Conflicts List
        const cList = data.constraints || [];
        const fList = data.conflicts || [];
        const totalFriction = cList.length + fList.length;
        if (constraintsCount) constraintsCount.textContent = totalFriction;
        if (constraintsList) {
            if (totalFriction === 0) {
                constraintsList.innerHTML = `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">✓ Zero active analytical constraints or conflicts detected.</div>`;
            } else {
                const fHtml = fList.map(f => `
                    <div class="decision-conflict-card">
                        <i class="fa-solid fa-triangle-exclamation text-red" style="margin-top:2px;"></i>
                        <span><strong>Conflict:</strong> ${esc(f)}</span>
                    </div>
                `).join("");
                const cHtml = cList.map(c => `
                    <div class="decision-constraint-card">
                        <i class="fa-solid fa-shield-halved text-yellow" style="margin-top:2px;"></i>
                        <span><strong>Constraint:</strong> ${esc(c)}</span>
                    </div>
                `).join("");
                constraintsList.innerHTML = fHtml + cHtml;
            }
        }

        // 8. Diagnostics Strip
        const diag = data.diagnostics || {};
        if (diagLatency) diagLatency.textContent = `${(diag.decision_latency_ms || 0).toFixed(2)} ms`;
        if (diagTotal) diagTotal.textContent = `${(diag.total_latency_ms || 0).toFixed(1)} ms`;
        if (diagClarity) diagClarity.textContent = clarity;

    } catch (err) {
        if (heroSummary) heroSummary.innerHTML = `<span style="color:var(--neg);">Error connecting to Decision Engine: ${esc(err.message)}</span>`;
    }
}
window.refreshDecisionModal = refreshDecisionModal;

// -------------------------------------------------------------
// 15. ORBIT EXPLAINABILITY & INSIGHT ENGINE CONTROLLER (PHASE 10)
// -------------------------------------------------------------

function openExplainModal() {
    const modal = document.getElementById("explain-eval-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    const sub = document.getElementById("explain-modal-subtitle");
    const asset = (typeof currentAsset !== "undefined" && currentAsset) ? currentAsset : "BTC-USD";
    const tf = (typeof currentTimeframe !== "undefined" && currentTimeframe) ? currentTimeframe : "1d";
    if (sub) sub.textContent = `Institutional Explainability & Traceable Intelligence on ${asset} (${tf})`;
    refreshExplainModal();
}
window.openExplainModal = openExplainModal;

function closeExplainModal() {
    const modal = document.getElementById("explain-eval-modal");
    if (modal) modal.classList.add("hidden");
}
window.closeExplainModal = closeExplainModal;

async function refreshExplainModal() {
    const sub = document.getElementById("explain-modal-subtitle");
    const statusTag = document.getElementById("explain-status-tag");
    const stanceBadge = document.getElementById("explain-stance-badge");
    const clarityTag = document.getElementById("explain-clarity-tag");
    const heroTitle = document.getElementById("explain-hero-title");
    const headline = document.getElementById("explain-headline");
    const thesisList = document.getElementById("explain-thesis-list");
    const confNum = document.getElementById("explain-confidence-number");
    const barFill = document.getElementById("explain-meter-bar-fill");

    const inConsensus = document.getElementById("exp-in-consensus");
    const inConsensusSub = document.getElementById("exp-in-consensus-sub");
    const inRisk = document.getElementById("exp-in-risk");
    const inRiskSub = document.getElementById("exp-in-risk-sub");
    const inOpp = document.getElementById("exp-in-opp");
    const inOppSub = document.getElementById("exp-in-opp-sub");
    const inPipeline = document.getElementById("exp-in-pipeline");
    const inPipelineSub = document.getElementById("exp-in-pipeline-sub");

    const evidenceList = document.getElementById("explain-evidence-list");
    const evidenceCount = document.getElementById("explain-evidence-count");
    const conflictsList = document.getElementById("explain-conflicts-list");
    const conflictsCount = document.getElementById("explain-conflicts-count");
    const risksList = document.getElementById("explain-risks-list");
    const risksCount = document.getElementById("explain-risks-count");

    const diagLatency = document.getElementById("exp-diag-latency");
    const diagDecLatency = document.getElementById("exp-diag-dec-latency");
    const diagTotal = document.getElementById("exp-diag-total");

    const asset = (typeof currentAsset !== "undefined" && currentAsset) ? currentAsset : "BTC-USD";
    const tf = (typeof currentTimeframe !== "undefined" && currentTimeframe) ? currentTimeframe : "1d";

    if (sub) sub.textContent = `Institutional Explainability & Traceable Intelligence on ${asset} (${tf})`;
    if (headline) headline.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i> Synthesizing traceable insights across consensus, strategies, risk, and decision matrices...`;

    try {
        const res = await fetch(`/api/explain/evaluate?symbol=${encodeURIComponent(asset)}&timeframe=${encodeURIComponent(tf)}`);
        const json = await res.json();

        if (!json.ok || !json.data) {
            if (headline) headline.innerHTML = `<span style="color:var(--neg);">Explainability synthesis failed: ${esc(json.detail || "Server error")}</span>`;
            if (statusTag) {
                statusTag.textContent = "FAILED";
                statusTag.style.color = "var(--neg)";
            }
            if (stanceBadge) {
                stanceBadge.textContent = "INSUFFICIENT DATA";
                stanceBadge.className = "explain-stance-badge insufficient-data";
            }
            if (clarityTag) clarityTag.textContent = "INSUFFICIENT";
            if (confNum) confNum.innerHTML = `0.0<span style="font-size:13px;color:var(--text-3);font-weight:400;">/100</span>`;
            if (thesisList) thesisList.innerHTML = `<li>No analytical thesis could be constructed due to missing market intelligence.</li>`;
            return;
        }

        const data = json.data;

        // 1. Status tag
        if (statusTag) {
            statusTag.textContent = data.status || "READY";
            statusTag.style.color = data.status === "READY" ? "#22d3ee" :
                                    data.status === "PARTIAL" ? "#facc15" :
                                    data.status === "LIMITED" ? "#f97316" : "var(--neg)";
        }

        // 2. Stance Badge & Clarity Tag
        const stance = data.market_stance || "NEUTRAL";
        const stanceNormalized = stance.toLowerCase().replace(/_/g, "-");
        if (stanceBadge) {
            stanceBadge.textContent = stance.replace(/_/g, " ");
            stanceBadge.className = `explain-stance-badge ${stanceNormalized}`;
        }

        const clarity = data.decision_clarity || "MODERATE";
        if (clarityTag) {
            clarityTag.textContent = clarity;
            clarityTag.style.color = clarity === "CLEAR" ? "var(--pos)" :
                                     clarity === "MODERATE" ? "#38bdf8" :
                                     clarity === "UNCLEAR" ? "#f59e0b" : "var(--neg)";
        }

        // 3. Hero Title & Headline
        if (heroTitle) {
            heroTitle.textContent = stance === "BULLISH" ? "Authoritative Bullish Explanation" :
                                    stance === "BEARISH" ? "Authoritative Bearish Explanation" :
                                    stance === "NEUTRAL" ? "Consolidation Equilibrium (Neutral) Explanation" :
                                    stance === "MIXED" ? "Polar Volatility Deadlock (Mixed) Explanation" :
                                    stance === "NO_CLEAR_DECISION" ? "Ambiguous Evidence (No Clear Stance)" :
                                    "Insufficient Market Intelligence";
        }
        if (headline) {
            headline.textContent = data.headline || "Comprehensive multi-system market insight synthesis.";
        }

        // 4. Core Analytical Thesis (Why ORBIT Reached This Conclusion)
        if (thesisList) {
            const whyItems = data.why || [];
            if (whyItems.length === 0) {
                thesisList.innerHTML = `<li>Analytical conclusion synthesized from baseline market inputs.</li>`;
            } else {
                thesisList.innerHTML = whyItems.map(item => `<li>${esc(item)}</li>`).join("");
            }
        }

        // 5. Evidence Confidence Number & Meter Bar
        const conf = data.decision_confidence || 0;
        if (confNum) {
            confNum.innerHTML = `${conf.toFixed(1)}<span style="font-size:13px;color:var(--text-3);font-weight:400;">/100</span>`;
        }
        if (barFill) {
            barFill.style.width = `${Math.min(100, Math.max(5, conf))}%`;
            barFill.style.background = (stance === "BULLISH") ? "var(--pos)" :
                                       (stance === "BEARISH") ? "var(--neg)" :
                                       (stance === "NEUTRAL") ? "#F59E0B" : "#A855F7";
        }

        // 6. Ingested Intelligence Stack Snapshot (Quad Cards)
        const inSum = data.input_summary || {};
        if (inConsensus) inConsensus.textContent = inSum.consensus_signal || "--";
        if (inConsensusSub) inConsensusSub.textContent = `Strength: ${(inSum.consensus_strength || 0).toFixed(0)} | Agreement: ${(inSum.agreement_score || 0).toFixed(0)}%`;

        if (inRisk) inRisk.textContent = inSum.risk_level || "--";
        if (inRiskSub) inRiskSub.textContent = `Score: ${(inSum.risk_score || 0).toFixed(1)}/100`;

        if (inOpp) inOpp.textContent = (inSum.opportunity_level || "--").replace("_", " ");
        if (inOppSub) inOppSub.textContent = `Confluence: ${(inSum.opportunity_score || 0).toFixed(1)}/100`;

        if (inPipeline) inPipeline.textContent = `${(inSum.completeness_score || 0).toFixed(0)}%`;
        if (inPipelineSub) inPipelineSub.textContent = `Tier: ${inSum.completeness_tier || "--"}`;

        // 7. Column 1: Traceable Supporting Evidence (Primary + Supporting)
        const peList = data.primary_evidence || [];
        const seList = data.supporting_evidence || [];
        const allEvidence = [...peList, ...seList];
        if (evidenceCount) evidenceCount.textContent = allEvidence.length;
        if (evidenceList) {
            if (allEvidence.length === 0) {
                evidenceList.innerHTML = `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">No corroborating evidence items detected.</div>`;
            } else {
                evidenceList.innerHTML = allEvidence.map(item => {
                    const isPrimary = peList.includes(item);
                    const sourceClean = (item.source || "UNKNOWN").replace(/_/g, " ");
                    const catClean = (item.category || "").replace(/_/g, " ");
                    const icon = isPrimary ? "fa-circle-check text-green" : "fa-plus text-cyan";
                    const borderColor = isPrimary ? "var(--pos)" : "var(--cyan)";
                    const bgTint = isPrimary ? "rgba(0, 230, 138, 0.04)" : "rgba(6, 182, 212, 0.04)";

                    return `
                        <div class="explain-evidence-card" style="border-left-color:${borderColor};background:${bgTint};">
                            <div class="explain-evidence-card-header">
                                <div style="display:flex;align-items:center;gap:6px;">
                                    <i class="fa-solid ${icon}"></i>
                                    <span style="font-weight:700;font-size:10px;text-transform:uppercase;color:var(--text-1);">${isPrimary ? "PRIMARY EVIDENCE" : "SUPPORTING"}</span>
                                </div>
                                <span class="explain-source-badge">${esc(sourceClean)}</span>
                            </div>
                            <div style="color:var(--text-2);font-size:11px;line-height:1.45;">${esc(item.message)}</div>
                            <div style="display:flex;align-items:center;gap:8px;font-size:9.5px;color:var(--text-4);font-family:var(--font-mono);">
                                <span>Tag: ${esc(catClean)}</span>
                                ${item.direction ? `<span>Dir: ${esc(item.direction)}</span>` : ""}
                            </div>
                        </div>
                    `;
                }).join("");
            }
        }

        // 8. Column 2: Model Conflicts & Clashes
        const cList = data.conflicts || [];
        if (conflictsCount) conflictsCount.textContent = cList.length;
        if (conflictsList) {
            if (cList.length === 0) {
                conflictsList.innerHTML = `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">✓ Zero model conflicts or cross-system divergences detected. Full consensus alignment.</div>`;
            } else {
                conflictsList.innerHTML = cList.map(conf => {
                    const subs = (conf.subsystems || []).map(s => `<span class="explain-source-badge" style="background:rgba(239,68,68,0.1);color:#fca5a5;border-color:rgba(239,68,68,0.3);">${esc(s.replace(/_/g, " "))}</span>`).join(" ");
                    return `
                        <div class="explain-conflict-card">
                            <div class="explain-evidence-card-header">
                                <div style="display:flex;align-items:center;gap:6px;">
                                    <i class="fa-solid fa-triangle-exclamation text-red"></i>
                                    <strong style="font-size:10.5px;color:#fca5a5;">${esc(conf.title || "Conflict")}</strong>
                                </div>
                                <span class="explain-source-badge" style="color:var(--neg);">${esc(conf.severity || "MODERATE")}</span>
                            </div>
                            <div style="color:var(--text-2);font-size:11px;line-height:1.45;">${esc(conf.description)}</div>
                            ${subs ? `<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:2px;">${subs}</div>` : ""}
                        </div>
                    `;
                }).join("");
            }
        }

        // 9. Column 3: Risk Constraints & Uncertainties
        const rcList = data.risk_constraints || [];
        const unList = data.uncertainties || [];
        const totalRisks = rcList.length + unList.length;
        if (risksCount) risksCount.textContent = totalRisks;
        if (risksList) {
            if (totalRisks === 0) {
                risksList.innerHTML = `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">✓ No active risk constraints or epistemic uncertainties limiting analysis.</div>`;
            } else {
                const rcHtml = rcList.map(rc => `
                    <div class="explain-uncertainty-card" style="border-left-color:#EAB308;">
                        <div class="explain-evidence-card-header">
                            <div style="display:flex;align-items:center;gap:6px;">
                                <i class="fa-solid fa-shield-halved text-yellow"></i>
                                <strong style="font-size:10.5px;color:#fde047;">Risk Constraint</strong>
                            </div>
                            <span class="explain-source-badge">${esc((rc.source || "RISK_GUARD").replace(/_/g, " "))}</span>
                        </div>
                        <div style="color:var(--text-2);font-size:11px;line-height:1.45;">${esc(rc.message)}</div>
                    </div>
                `).join("");

                const unHtml = unList.map(un => `
                    <div class="explain-uncertainty-card" style="border-left-color:#A855F7;background:rgba(168,85,247,0.04);">
                        <div class="explain-evidence-card-header">
                            <div style="display:flex;align-items:center;gap:6px;">
                                <i class="fa-solid fa-circle-question text-purple"></i>
                                <strong style="font-size:10.5px;color:#d8b4fe;">${esc(un.category ? un.category.replace(/_/g, " ") : "Uncertainty")}</strong>
                            </div>
                            <span class="explain-source-badge" style="color:#d8b4fe;">${esc((un.source || "ORBIT_BRAIN").replace(/_/g, " "))}</span>
                        </div>
                        <div style="color:var(--text-2);font-size:11px;line-height:1.45;">${esc(un.description)}</div>
                    </div>
                `).join("");

                risksList.innerHTML = rcHtml + unHtml;
            }
        }

        // 10. Diagnostics Strip
        const diag = data.diagnostics || {};
        if (diagLatency) diagLatency.textContent = `${(diag.explain_latency_ms || 0).toFixed(2)} ms`;
        if (diagDecLatency) diagDecLatency.textContent = `${(diag.decision_latency_ms || 0).toFixed(2)} ms`;
        if (diagTotal) diagTotal.textContent = `${(diag.total_latency_ms || 0).toFixed(1)} ms`;

    } catch (err) {
        if (headline) headline.innerHTML = `<span style="color:var(--neg);">Error connecting to Explainability Engine: ${esc(err.message)}</span>`;
    }
}
window.refreshExplainModal = refreshExplainModal;

// -------------------------------------------------------------
// 16. ORBIT AI MARKET INTELLIGENCE COPILOT CONTROLLER (PHASE 12)
// -------------------------------------------------------------

let _copilotConversationId = null;
let _copilotIsLoading = false;

function openCopilotModal() {
    const modal = document.getElementById("orbit-copilot-modal");
    if (!modal) return;
    modal.classList.remove("hidden");

    const asset = (typeof currentAsset !== "undefined" && currentAsset) ? currentAsset : "BTC-USD";
    const tf = (typeof currentTimeframe !== "undefined" && currentTimeframe) ? currentTimeframe : "1d";

    const badge = document.getElementById("copilot-active-symbol-badge");
    if (badge) badge.textContent = `${asset} (${tf})`;

    const welcomeSym = document.getElementById("copilot-welcome-symbol");
    if (welcomeSym) welcomeSym.textContent = asset;

    refreshCopilotContext(asset, tf);

    setTimeout(() => {
        const input = document.getElementById("copilot-chat-input");
        if (input) input.focus();
    }, 150);
}
window.openCopilotModal = openCopilotModal;

function closeCopilotModal() {
    const modal = document.getElementById("orbit-copilot-modal");
    if (modal) modal.classList.add("hidden");
}
window.closeCopilotModal = closeCopilotModal;

async function refreshCopilotContext(asset, tf) {
    const symbol = asset || currentAsset || "BTC-USD";
    const timeframe = tf || currentTimeframe || "1d";

    try {
        const res = await fetch(`/api/copilot/context?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`);
        const json = await res.json();
        if (json.ok && json.data) {
            const d = json.data;
            const stanceEl = document.getElementById("copilot-tel-stance");
            if (stanceEl) {
                stanceEl.textContent = d.market_stance;
                stanceEl.className = `copilot-stance-tag ${(d.market_stance || "").toLowerCase().replace(/_/g, "-")}`;
            }
            const confEl = document.getElementById("copilot-tel-confidence");
            if (confEl) confEl.textContent = `${(d.confidence || 0).toFixed(1)}%`;
            const riskEl = document.getElementById("copilot-tel-risk");
            if (riskEl) riskEl.textContent = `${d.risk_level} (${(d.risk_score || 0).toFixed(0)})`;
            const oppEl = document.getElementById("copilot-tel-opportunity");
            if (oppEl) oppEl.textContent = `${(d.opportunity_score || 0).toFixed(0)}/100`;
        }
    } catch (e) {
        console.warn("[Copilot] Error loading context telemetry:", e);
    }
}
window.refreshCopilotContext = refreshCopilotContext;

function askCopilotPreset(query) {
    const input = document.getElementById("copilot-chat-input");
    if (input) {
        input.value = query;
        sendCopilotMessage();
    }
}
window.askCopilotPreset = askCopilotPreset;

function clearCopilotChat() {
    _copilotConversationId = null;
    const stream = document.getElementById("copilot-chat-stream");
    const asset = (typeof currentAsset !== "undefined" && currentAsset) ? currentAsset : "BTC-USD";
    if (stream) {
        stream.innerHTML = `
            <div class="copilot-msg-card copilot-assistant">
                <div class="copilot-msg-header">
                    <i class="fa-solid fa-robot text-green"></i>
                    <strong>ORBIT Copilot</strong>
                    <span class="copilot-msg-time">Reset</span>
                </div>
                <div class="copilot-msg-body">
                    Conversation reset. I am ready to answer questions about the active analysis for <strong>${esc(asset)}</strong>.
                </div>
            </div>
        `;
    }
}
window.clearCopilotChat = clearCopilotChat;

async function sendCopilotMessage() {
    if (_copilotIsLoading) return;
    const input = document.getElementById("copilot-chat-input");
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    input.value = "";
    const stream = document.getElementById("copilot-chat-stream");
    const asset = (typeof currentAsset !== "undefined" && currentAsset) ? currentAsset : "BTC-USD";
    const tf = (typeof currentTimeframe !== "undefined" && currentTimeframe) ? currentTimeframe : "1d";

    // 1. Append User Message Bubble
    if (stream) {
        const userCard = document.createElement("div");
        userCard.className = "copilot-msg-card copilot-user";
        userCard.innerHTML = `
            <div class="copilot-msg-header">
                <i class="fa-solid fa-user text-cyan"></i>
                <strong>You</strong>
                <span class="copilot-msg-time">${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
            </div>
            <div class="copilot-msg-body">${esc(text)}</div>
        `;
        stream.appendChild(userCard);

        // 2. Append Loading Typing Indicator
        const typingCard = document.createElement("div");
        typingCard.className = "copilot-typing-card";
        typingCard.id = "copilot-typing-indicator";
        typingCard.innerHTML = `
            <i class="fa-solid fa-circle-notch fa-spin"></i>
            <span>ORBIT Copilot is reasoning over ${esc(asset)} analysis...</span>
        `;
        stream.appendChild(typingCard);
        stream.scrollTop = stream.scrollHeight;
    }

    _copilotIsLoading = true;
    const sendBtn = document.getElementById("copilot-send-btn");
    if (sendBtn) sendBtn.disabled = true;

    try {
        const payload = {
            message: text,
            symbol: asset,
            timeframe: tf,
            conversation_id: _copilotConversationId,
        };

        const res = await fetch("/api/copilot/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        const json = await res.json();
        const indicator = document.getElementById("copilot-typing-indicator");
        if (indicator) indicator.remove();

        if (json.ok && json.data) {
            const d = json.data;
            _copilotConversationId = d.conversation_id;

            // Render Markdown-ish answer safely
            let formattedAnswer = esc(d.answer)
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.*?)\*/g, '<em>$1</em>')
                .replace(/^### (.*$)/gim, '<h3 style="margin:8px 0 4px;color:#00e68a;">$1</h3>')
                .replace(/^- (.*$)/gim, '<li>$1</li>')
                .replace(/\n\n/g, '<br><br>')
                .replace(/\n/g, '<br>');

            const asstCard = document.createElement("div");
            asstCard.className = "copilot-msg-card copilot-assistant";
            asstCard.innerHTML = `
                <div class="copilot-msg-header">
                    <i class="fa-solid fa-robot text-green"></i>
                    <strong>ORBIT Copilot</strong>
                    <span class="copilot-symbol-pill" style="font-size:9.5px;padding:1px 6px;">${esc(d.symbol)}</span>
                    <span class="copilot-msg-time">${(d.latency_ms || 0).toFixed(0)} ms</span>
                </div>
                <div class="copilot-msg-body">${formattedAnswer}</div>
            `;
            if (stream) stream.appendChild(asstCard);

            // Update suggestions if provided
            if (d.suggested_followups && d.suggested_followups.length > 0) {
                const chipsBox = document.getElementById("copilot-chips-container");
                if (chipsBox) {
                    chipsBox.innerHTML = `
                        <span class="copilot-chips-label"><i class="fa-solid fa-lightbulb"></i> Next:</span>
                        ${d.suggested_followups.map(s => `<button class="copilot-chip" onclick="askCopilotPreset('${esc(s)}')">${esc(s)}</button>`).join("")}
                    `;
                }
            }
        } else {
            const errCard = document.createElement("div");
            errCard.className = "copilot-msg-card copilot-assistant";
            errCard.style.borderLeftColor = "var(--neg)";
            errCard.innerHTML = `
                <div class="copilot-msg-header">
                    <i class="fa-solid fa-triangle-exclamation text-red"></i>
                    <strong style="color:var(--neg);">Copilot Error</strong>
                </div>
                <div class="copilot-msg-body">${esc(json.detail || "Error communicating with Copilot service.")}</div>
            `;
            if (stream) stream.appendChild(errCard);
        }
    } catch (err) {
        const indicator = document.getElementById("copilot-typing-indicator");
        if (indicator) indicator.remove();
        const errCard = document.createElement("div");
        errCard.className = "copilot-msg-card copilot-assistant";
        errCard.style.borderLeftColor = "var(--neg)";
        errCard.innerHTML = `
            <div class="copilot-msg-header">
                <i class="fa-solid fa-triangle-exclamation text-red"></i>
                <strong style="color:var(--neg);">Network Error</strong>
            </div>
            <div class="copilot-msg-body">Failed to reach ORBIT backend: ${esc(err.message)}</div>
        `;
        if (stream) stream.appendChild(errCard);
    } finally {
        _copilotIsLoading = false;
        if (sendBtn) sendBtn.disabled = false;
        if (stream) stream.scrollTop = stream.scrollHeight;
    }
}
window.sendCopilotMessage = sendCopilotMessage;

// Keyboard listener to close modals via Escape key
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        closeCopilotModal();
        closeExplainModal();
        closeDecisionModal();
        closeOpportunityModal();
        closeRiskModal();
        closeBrainModal();
        closeConsensusModal();
        closeStrategyModal();
    }
});

// ============================================================
//   DEDICATED ORBIT COPILOT PAGE CONTROLLER (PHASE 12 REDESIGN)
// ============================================================
let _copilotPageSessionId = null;
let _copilotPageIsLoading = false;
let _copilotActiveAsset = "AAPL";
let _copilotActiveMarket = "US Stocks";
let _copilotActiveMode = "DETAILED";
let _copilotSearchTimer = null;
let _copilotLoadingInterval = null;

function formatCopilotMarkdown(raw) {
    if (!raw) return "";
    let html = esc(raw);
    // Headers: ### Header
    html = html.replace(/^### (.*$)/gim, '<h3 class="copilot-h3">$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h3 class="copilot-h3">$1</h3>');
    // Bold: **text**
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Bullet points: - item or • item
    html = html.replace(/^[•\-\*] (.*$)/gim, '<li>$1</li>');
    // Numbered lists: 1. item
    html = html.replace(/^\d+\. (.*$)/gim, '<li>$1</li>');
    // Group consecutive list items into ul
    html = html.replace(/(<li>.*?<\/li>)+/gs, (match) => `<ul>${match}</ul>`);
    // Paragraph breaks
    html = html.replace(/\n\n/g, '<p></p>');
    html = html.replace(/\n/g, '<br>');
    return html;
}

// ── 2.2 Balance Display Synchronization ──
function syncCopilotBalance() {
    const balanceEl = document.getElementById("copilot-account-balance");
    const walletEl = document.getElementById("wallet-balance");
    const overviewEl = document.getElementById("overview-balance");
    if (balanceEl) {
        if (walletEl && walletEl.textContent.trim()) {
            balanceEl.textContent = walletEl.textContent.replace("INR", "").trim();
        } else if (overviewEl && overviewEl.textContent.trim()) {
            balanceEl.textContent = overviewEl.textContent.replace("INR", "").trim();
        } else {
            balanceEl.textContent = "₹10,00,000.00";
        }
    }
}
window.syncCopilotBalance = syncCopilotBalance;

// ── 2.1 Chat History Sidebar Management ──
async function loadConversationsList() {
    const listEl = document.getElementById("copilot-history-list");
    if (!listEl) return;

    try {
        const res = await fetch("/api/chat/conversations?limit=40");
        if (!res.ok) throw new Error("Failed to load conversations");
        const json = await res.json();
        const convs = json.data || [];

        if (convs.length === 0) {
            listEl.innerHTML = `
                <div class="copilot-history-empty">
                    <i class="fa-regular fa-message" style="margin-bottom:6px;font-size:18px;opacity:0.5;"></i>
                    <p style="margin:0;">No previous analyses.</p>
                </div>
            `;
            return;
        }

        // Group into Today, Yesterday, Older
        const now = new Date();
        const todayStr = now.toDateString();
        const yest = new Date(now);
        yest.setDate(yest.getDate() - 1);
        const yestStr = yest.toDateString();

        const groups = {
            today: [],
            yesterday: [],
            older: [],
        };

        convs.forEach((c) => {
            const d = new Date(c.updated_at || c.created_at);
            const dStr = d.toDateString();
            if (dStr === todayStr) {
                groups.today.push(c);
            } else if (dStr === yestStr) {
                groups.yesterday.push(c);
            } else {
                groups.older.push(c);
            }
        });

        let html = "";
        const renderGroup = (title, items) => {
            if (!items || items.length === 0) return "";
            return `
                <div class="copilot-history-group">
                    <div class="copilot-history-group-title">${title}</div>
                    ${items
                        .map((c) => {
                            const isActive = c.id === _copilotPageSessionId;
                            const sym = c.selected_asset || "ASSET";
                            const cleanTitle = esc(c.title || `${sym} Analysis`);
                            return `
                                <div class="copilot-history-item ${isActive ? "active" : ""}" onclick="selectConversation('${c.id}')" title="${cleanTitle}">
                                    <div class="copilot-history-item-content">
                                        <div class="copilot-history-title">${cleanTitle}</div>
                                        <div class="copilot-history-meta">
                                            <span class="copilot-history-badge">${esc(sym)}</span>
                                            <span>${esc(c.selected_market || "Market")}</span>
                                        </div>
                                    </div>
                                    <button class="copilot-history-delete-btn" onclick="deleteConversationClick(event, '${c.id}')" title="Delete conversation">
                                        <i class="fa-solid fa-trash-can"></i>
                                    </button>
                                </div>
                            `;
                        })
                        .join("")}
                </div>
            `;
        };

        html += renderGroup("TODAY", groups.today);
        html += renderGroup("YESTERDAY", groups.yesterday);
        html += renderGroup("OLDER", groups.older);

        listEl.innerHTML = html;
    } catch (err) {
        listEl.innerHTML = `<div class="copilot-history-empty text-ruby">History offline</div>`;
    }
}
window.loadConversationsList = loadConversationsList;

async function selectConversation(convId) {
    if (!convId) return;
    _copilotPageSessionId = convId;

    try {
        const res = await fetch(`/api/chat/conversations/${convId}`);
        if (!res.ok) throw new Error("Could not load conversation");
        const json = await res.json();
        const { conversation, messages } = json.data;

        // Update active asset & market
        if (conversation.selected_asset) {
            _copilotActiveAsset = conversation.selected_asset;
        }
        if (conversation.selected_market) {
            _copilotActiveMarket = conversation.selected_market;
            const mktSelect = document.getElementById("copilot-market-select");
            if (mktSelect) mktSelect.value = _copilotActiveMarket;
        }

        // Update Active Asset Banner
        updateActiveAssetBanner(_copilotActiveAsset, _copilotActiveMarket);

        // Render historical messages
        const messagesBox = document.getElementById("copilot-page-messages");
        if (messagesBox) {
            messagesBox.innerHTML = "";
            if (messages && messages.length > 0) {
                messages.forEach((m) => {
                    const isUser = m.role === "user";
                    const card = document.createElement("div");
                    card.className = `copilot-page-msg-card ${isUser ? "user" : "orbit"}`;
                    const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : "";
                    card.innerHTML = `
                        <div class="copilot-page-msg-header">
                            <i class="fa-solid ${isUser ? "fa-user" : "fa-robot text-emerald"}"></i>
                            <strong>${isUser ? "You" : "ORBIT Copilot"}</strong>
                            ${timeStr ? `<span>&bull; ${timeStr}</span>` : ""}
                        </div>
                        <div class="copilot-page-msg-body">${isUser ? esc(m.content) : formatCopilotMarkdown(m.content)}</div>
                    `;
                    messagesBox.appendChild(card);
                });
                messagesBox.scrollTop = messagesBox.scrollHeight;
            }
        }

        // Sync analysis context and highlight active
        syncCopilotPageView();
        loadConversationsList();
    } catch (err) {
        console.warn("Error selecting conversation:", err);
    }
}
window.selectConversation = selectConversation;

function createNewAnalysis() {
    _copilotPageSessionId = null;
    const messagesBox = document.getElementById("copilot-page-messages");
    if (messagesBox) messagesBox.innerHTML = "";
    syncCopilotPageView();
    loadConversationsList();
    const input = document.getElementById("copilot-page-input");
    if (input) input.focus();
}
window.createNewAnalysis = createNewAnalysis;

function toggleCopilotSidebar() {
    const sidebar = document.querySelector(".copilot-history-sidebar");
    const container = document.querySelector(".copilot-terminal-container");
    const openBtn = document.getElementById("copilot-sidebar-open-tab");
    if (!sidebar || !container) return;

    const isCollapsed = sidebar.classList.toggle("collapsed");
    container.classList.toggle("sidebar-collapsed", isCollapsed);
    if (openBtn) {
        if (isCollapsed) {
            openBtn.classList.remove("hidden");
        } else {
            openBtn.classList.add("hidden");
        }
    }
}
window.toggleCopilotSidebar = toggleCopilotSidebar;

async function deleteConversationClick(event, convId) {
    if (event) event.stopPropagation();
    if (!convId) return;

    try {
        await fetch(`/api/chat/conversations/${convId}`, { method: "DELETE" });
        if (_copilotPageSessionId === convId) {
            createNewAnalysis();
        } else {
            loadConversationsList();
        }
    } catch (err) {
        console.warn("Delete conversation error:", err);
    }
}
window.deleteConversationClick = deleteConversationClick;

// ── 3. Asset & Market Selection System ──
function onCopilotMarketChange(marketVal) {
    _copilotActiveMarket = marketVal;
    updateActiveAssetBanner(_copilotActiveAsset, marketVal);
    const searchInput = document.getElementById("copilot-asset-search");
    if (searchInput) searchInput.placeholder = `Search in ${marketVal}...`;
}
window.onCopilotMarketChange = onCopilotMarketChange;

function updateActiveAssetBanner(sym, market, name) {
    const titleEl = document.getElementById("copilot-active-asset-title");
    const exchEl = document.getElementById("copilot-active-asset-exchange");
    const symBadge = document.getElementById("copilot-page-symbol");
    if (titleEl) titleEl.innerHTML = `${esc(sym)} &bull; <span>${esc(name || sym)}</span>`;
    if (exchEl) exchEl.textContent = `${esc(market || _copilotActiveMarket)}`;
    if (symBadge) symBadge.textContent = esc(sym);
}

function onAssetSearchInput(query) {
    clearTimeout(_copilotSearchTimer);
    const dropdown = document.getElementById("copilot-search-dropdown");
    if (!dropdown) return;

    const q = query.trim();
    if (!q) {
        dropdown.classList.add("hidden");
        dropdown.innerHTML = "";
        return;
    }

    dropdown.classList.remove("hidden");
    dropdown.innerHTML = `<div class="copilot-search-loading"><i class="fa-solid fa-spinner fa-spin"></i> Searching ${esc(_copilotActiveMarket)}...</div>`;

    _copilotSearchTimer = setTimeout(async () => {
        try {
            const url = `/api/market/search?q=${encodeURIComponent(q)}&market=${encodeURIComponent(_copilotActiveMarket)}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error("Search failed");
            const json = await res.json();
            const results = (json.data && json.data.results) || json.results || (Array.isArray(json.data) ? json.data : []) || [];

            if (results.length === 0) {
                dropdown.innerHTML = `<div class="copilot-search-empty">No matching assets found</div>`;
                return;
            }

            dropdown.innerHTML = results
                .slice(0, 8)
                .map(
                    (r) => `
                <div class="copilot-search-item" onclick="selectAsset('${esc(r.symbol)}', '${esc(r.name)}', '${esc(r.exchange)}')">
                    <div class="copilot-search-item-left">
                        <span class="copilot-search-item-sym">${esc(r.symbol)}</span>
                        <span class="copilot-search-item-name">${esc(r.name)}</span>
                    </div>
                    <div class="copilot-search-item-right">${esc(r.exchange || r.type)}</div>
                </div>
            `
                )
                .join("");
        } catch (err) {
            dropdown.innerHTML = `<div class="copilot-search-empty text-ruby">Search temporarily unavailable</div>`;
        }
    }, 280);
}
window.onAssetSearchInput = onAssetSearchInput;

function selectAsset(symbol, name, exchange) {
    _copilotActiveAsset = symbol.trim().toUpperCase();
    updateActiveAssetBanner(_copilotActiveAsset, _copilotActiveMarket, name);

    const dropdown = document.getElementById("copilot-search-dropdown");
    if (dropdown) dropdown.classList.add("hidden");
    const searchInput = document.getElementById("copilot-asset-search");
    if (searchInput) searchInput.value = "";

    // Sync context for newly selected asset
    syncCopilotPageView();
}
window.selectAsset = selectAsset;

// ── 14. Response Modes ──
function setResponseMode(mode) {
    _copilotActiveMode = mode;
    const btns = document.querySelectorAll(".copilot-mode-btn");
    btns.forEach((b) => {
        if (b.getAttribute("data-mode") === mode) {
            b.classList.add("active");
        } else {
            b.classList.remove("active");
        }
    });
}
window.setResponseMode = setResponseMode;

// ── Context Synchronization ──
async function syncCopilotPageView() {
    const symBadge = document.getElementById("copilot-page-symbol");
    const statusBadge = document.getElementById("copilot-page-analysis-status");
    const stanceEl = document.getElementById("copilot-page-stance");
    const confEl = document.getElementById("copilot-page-confidence");
    const riskEl = document.getElementById("copilot-page-risk");
    const oppEl = document.getElementById("copilot-page-opportunity");
    const setupsEl = document.getElementById("copilot-page-setups");
    const messagesBox = document.getElementById("copilot-page-messages");

    syncCopilotBalance();

    let activeSym = _copilotActiveAsset || 
                    (currentAsset && currentAsset.trim()) || 
                    (activeTickerDisplay && activeTickerDisplay.textContent.trim() !== "--" && activeTickerDisplay.textContent.trim()) || 
                    "AAPL";
    _copilotActiveAsset = activeSym;

    if (symBadge) symBadge.textContent = activeSym;
    updateActiveAssetBanner(activeSym, _copilotActiveMarket);

    if (statusBadge) {
        statusBadge.className = "copilot-status-badge";
        statusBadge.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Checking Context...';
    }

    try {
        const tf = currentTimeframe || "1d";
        const res = await fetch(`/api/copilot/context?symbol=${encodeURIComponent(activeSym)}&timeframe=${encodeURIComponent(tf)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const d = json.data;

        if (statusBadge) {
            statusBadge.className = "copilot-status-badge available";
            statusBadge.innerHTML = '<i class="fa-solid fa-circle-check"></i> Analysis Available';
        }

        if (stanceEl) {
            stanceEl.textContent = d.market_stance;
            stanceEl.className = `telem-val ${d.market_stance.toLowerCase().includes("bull") ? "text-emerald" : d.market_stance.toLowerCase().includes("bear") ? "text-ruby" : "text-amber"}`;
        }
        if (confEl) confEl.textContent = `${Number(d.confidence).toFixed(1)}%`;
        if (riskEl) riskEl.textContent = `${d.risk_level} (${Number(d.risk_score).toFixed(0)})`;
        if (oppEl) oppEl.textContent = `${Number(d.opportunity_score).toFixed(0)}/100`;
        if (setupsEl) setupsEl.textContent = d.active_setups_count !== undefined ? d.active_setups_count : "--";

        // Update suggested chips
        if (d.suggested_questions && d.suggested_questions.length > 0) {
            const chipsBar = document.getElementById("copilot-page-suggestions");
            if (chipsBar) {
                chipsBar.innerHTML = `
                    <span class="suggestions-label"><i class="fa-solid fa-lightbulb text-amber"></i> Suggested:</span>
                    ${d.suggested_questions.map((q) => `<button class="copilot-chip" onclick="askCopilotPagePreset('${esc(q)}')">${esc(q)}</button>`).join("")}
                `;
            }
        }

        // Add initial welcome card if messages box is empty
        if (messagesBox && messagesBox.children.length === 0) {
            const welcomeCard = document.createElement("div");
            welcomeCard.className = "copilot-page-msg-card orbit";
            welcomeCard.innerHTML = `
                <div class="copilot-page-msg-header">
                    <i class="fa-solid fa-robot text-emerald"></i>
                    <strong>ORBIT AI Analyst</strong>
                    <span>&bull; ${activeSym} Context Active</span>
                </div>
                <div class="copilot-page-msg-body">
                    <p>Connected to <strong>${esc(activeSym)}</strong> in <strong>${esc(_copilotActiveMarket)}</strong> via Alpha Vantage and ORBIT analytical pipeline.</p>
                    <p>Current Stance: <strong>${d.market_stance}</strong> (${Number(d.confidence).toFixed(1)}% Confidence | ${d.clarity} Clarity).<br>
                    Analytical Risk is <strong>${d.risk_level}</strong> (${Number(d.risk_score).toFixed(1)}/100) and Opportunity is <strong>${Number(d.opportunity_score).toFixed(1)}/100</strong>.</p>
                    <p>Ask any question about <strong>${esc(activeSym)}</strong> or choose a suggested question above.</p>
                </div>
            `;
            messagesBox.appendChild(welcomeCard);
        }
    } catch (err) {
        if (statusBadge) {
            statusBadge.className = "copilot-status-badge not-available";
            statusBadge.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Ready';
        }
    }
}
window.syncCopilotPageView = syncCopilotPageView;

// ── Send Message Execution with Loading Stages ──
async function sendCopilotPageMessage() {
    if (_copilotPageIsLoading) return;
    const input = document.getElementById("copilot-page-input");
    const sendBtn = document.getElementById("copilot-page-send-btn");
    const loadingBar = document.getElementById("copilot-page-loading");
    const loadingText = document.getElementById("copilot-loading-text");
    const errorBanner = document.getElementById("copilot-page-error");
    const messagesBox = document.getElementById("copilot-page-messages");

    const message = input ? input.value.trim() : "";
    if (!message) return;

    const activeSym = _copilotActiveAsset || "AAPL";

    // Append user message
    if (messagesBox) {
        const userCard = document.createElement("div");
        userCard.className = "copilot-page-msg-card user";
        userCard.innerHTML = `
            <div class="copilot-page-msg-header">
                <i class="fa-solid fa-user"></i>
                <strong>You</strong>
                <span>&bull; ${new Date().toLocaleTimeString()}</span>
            </div>
            <div class="copilot-page-msg-body">${esc(message)}</div>
        `;
        messagesBox.appendChild(userCard);
        messagesBox.scrollTop = messagesBox.scrollHeight;
    }

    if (input) input.value = "";
    if (sendBtn) sendBtn.disabled = true;
    if (loadingBar) loadingBar.classList.remove("hidden");
    if (errorBanner) errorBanner.classList.add("hidden");
    _copilotPageIsLoading = true;

    // 20. Loading stages rotation
    const stages = [
        "Loading market data from Alpha Vantage...",
        "Analyzing market context & indicators...",
        "Evaluating risk guard & consensus...",
        "Generating ORBIT analytical view...",
    ];
    let stageIdx = 0;
    if (loadingText) loadingText.textContent = stages[0];
    clearInterval(_copilotLoadingInterval);
    _copilotLoadingInterval = setInterval(() => {
        stageIdx = (stageIdx + 1) % stages.length;
        if (loadingText) loadingText.textContent = stages[stageIdx];
    }, 1500);

    try {
        const tf = currentTimeframe || "1d";
        const payload = {
            message: message,
            symbol: activeSym,
            selected_asset: activeSym,
            selected_market: _copilotActiveMarket,
            timeframe: tf,
            conversation_id: _copilotPageSessionId || undefined,
            response_mode: _copilotActiveMode,
        };

        const res = await fetch("/api/copilot/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        const json = await res.json();
        if (!res.ok || !json.ok) {
            throw new Error(json.detail || "Copilot response failed.");
        }

        const d = json.data;
        _copilotPageSessionId = d.conversation_id;

        // Append ORBIT response
        if (messagesBox) {
            const orbitCard = document.createElement("div");
            orbitCard.className = "copilot-page-msg-card orbit";
            const stanceBadge = d.context_summary ? `<span class="copilot-tag">${esc(d.context_summary.market_stance)}</span>` : "";
            const latencyTag = d.latency_ms ? `<span>&bull; ${d.latency_ms}ms</span>` : "";
            orbitCard.innerHTML = `
                <div class="copilot-page-msg-header">
                    <i class="fa-solid fa-robot text-emerald"></i>
                    <strong>ORBIT Copilot</strong>
                    ${stanceBadge}
                    ${latencyTag}
                </div>
                <div class="copilot-page-msg-body">${formatCopilotMarkdown(d.answer)}</div>
            `;
            messagesBox.appendChild(orbitCard);
            messagesBox.scrollTop = messagesBox.scrollHeight;
        }

        // Update suggestions if provided
        if (d.suggested_followups && d.suggested_followups.length > 0) {
            const chipsBar = document.getElementById("copilot-page-suggestions");
            if (chipsBar) {
                chipsBar.innerHTML = `
                    <span class="suggestions-label"><i class="fa-solid fa-lightbulb text-amber"></i> Next:</span>
                    ${d.suggested_followups.map((q) => `<button class="copilot-chip" onclick="askCopilotPagePreset('${esc(q)}')">${esc(q)}</button>`).join("")}
                `;
            }
        }

        // Refresh conversation history in sidebar to update title
        loadConversationsList();
    } catch (err) {
        if (errorBanner) {
            const errMsg = document.getElementById("copilot-page-error-msg");
            if (errMsg) errMsg.textContent = `ORBIT Copilot notice: ${err.message}`;
            errorBanner.classList.remove("hidden");
        }
        if (messagesBox) {
            const errCard = document.createElement("div");
            errCard.className = "copilot-page-msg-card orbit";
            errCard.style.borderColor = "var(--neg, #ff4d4d)";
            errCard.innerHTML = `
                <div class="copilot-page-msg-header">
                    <i class="fa-solid fa-triangle-exclamation text-ruby"></i>
                    <strong style="color:var(--neg, #ff4d4d);">Copilot Service Notice</strong>
                </div>
                <div class="copilot-page-msg-body">
                    <p>Market data or analytical engine output is temporarily unavailable for <strong>${esc(activeSym)}</strong>: ${esc(err.message)}.</p>
                </div>
            `;
            messagesBox.appendChild(errCard);
            messagesBox.scrollTop = messagesBox.scrollHeight;
        }
    } finally {
        _copilotPageIsLoading = false;
        clearInterval(_copilotLoadingInterval);
        if (sendBtn) sendBtn.disabled = false;
        if (loadingBar) loadingBar.classList.add("hidden");
    }
}
window.sendCopilotPageMessage = sendCopilotPageMessage;

function askCopilotPagePreset(question) {
    const input = document.getElementById("copilot-page-input");
    if (input) input.value = question;
    sendCopilotPageMessage();
}
window.askCopilotPagePreset = askCopilotPagePreset;

async function clearCopilotPageChat() {
    if (_copilotPageSessionId) {
        try {
            await fetch("/api/copilot/reset", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ conversation_id: _copilotPageSessionId }),
            });
        } catch (e) {}
    }
    createNewAnalysis();
}
window.clearCopilotPageChat = clearCopilotPageChat;

// Initialize Copilot listeners & load history on tab open
document.addEventListener("DOMContentLoaded", () => {
    const pageInput = document.getElementById("copilot-page-input");
    if (pageInput) {
        pageInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendCopilotPageMessage();
            }
        });
    }

    // Close search dropdown on click outside
    document.addEventListener("click", (e) => {
        const searchWrap = document.querySelector(".copilot-search-wrap");
        const dropdown = document.getElementById("copilot-search-dropdown");
        if (dropdown && searchWrap && !searchWrap.contains(e.target)) {
            dropdown.classList.add("hidden");
        }
    });

    // Initial conversation load
    loadConversationsList();
    syncCopilotBalance();
    fetchDashboardSummary();
});

// =============================================================
//   MANAGE TRADES TERMINAL CONTROLLERS & LIFECYCLE
// =============================================================

let _currentManageSubTab = "open";
let _openTradesCache = [];
let _activeManageTrade = null;
let _closeSelectedPct = null;
let _isCloseExecuting = false;
let currentHistoryPage = 0;
let totalHistoryPages = 1;
let _historySearchDebounceTimer = null;

// Sub-tab switcher
function switchManageSubTab(subTab) {
    _currentManageSubTab = subTab;
    const btnOpen = document.getElementById("subtab-btn-open-trades");
    const btnPending = document.getElementById("subtab-btn-pending-orders");
    const btnHistory = document.getElementById("subtab-btn-trade-history");

    const panelOpen = document.getElementById("manage-subtab-open");
    const panelPending = document.getElementById("manage-subtab-pending");
    const panelHistory = document.getElementById("manage-subtab-history");

    if (btnOpen) btnOpen.classList.toggle("active", subTab === "open");
    if (btnPending) btnPending.classList.toggle("active", subTab === "pending");
    if (btnHistory) btnHistory.classList.toggle("active", subTab === "history");

    if (panelOpen) panelOpen.classList.toggle("hidden-subtab", subTab !== "open");
    if (panelPending) panelPending.classList.toggle("hidden-subtab", subTab !== "pending");
    if (panelHistory) panelHistory.classList.toggle("hidden-subtab", subTab !== "history");

    if (subTab === "open") loadOpenTrades();
    else if (subTab === "pending") loadPendingOrders();
    else if (subTab === "history") loadTradeHistoryPage(0);
}
window.switchManageSubTab = switchManageSubTab;

// Load all Manage Trades views
async function loadManageTradesData(btnElement) {
    let originalHtml = "";
    if (btnElement) {
        btnElement.disabled = true;
        originalHtml = btnElement.innerHTML;
        btnElement.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> <span>Refreshing...</span>';
    }
    try {
        const results = await Promise.allSettled([
            loadOpenTrades(),
            loadPendingOrders(),
            loadTradeHistoryPage(currentHistoryPage || 0),
            fetchDashboardSummary()
        ]);
        const anyFailed = results.some(r => r.status === "rejected");
        if (anyFailed) {
            console.warn("[ManageTrades] Some items failed to refresh:", results);
            if (btnElement) {
                btnElement.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-yellow"></i> <span>Partial</span>';
                setTimeout(() => { if (btnElement) { btnElement.innerHTML = originalHtml; btnElement.disabled = false; } }, 1500);
                return;
            }
        }
        if (btnElement) {
            btnElement.innerHTML = '<i class="fa-solid fa-check text-green"></i> <span>Updated</span>';
            setTimeout(() => { if (btnElement) { btnElement.innerHTML = originalHtml; btnElement.disabled = false; } }, 1200);
        }
    } catch (err) {
        console.error("[ManageTrades] Error refreshing data:", err);
        if (btnElement) {
            btnElement.innerHTML = '<i class="fa-solid fa-xmark text-red"></i> <span>Connection error</span>';
            setTimeout(() => { if (btnElement) { btnElement.innerHTML = originalHtml; btnElement.disabled = false; } }, 2000);
        }
    } finally {
        if (btnElement && !btnElement.innerHTML.includes("text-green") && !btnElement.innerHTML.includes("text-yellow") && !btnElement.innerHTML.includes("text-red")) {
            btnElement.disabled = false;
            btnElement.innerHTML = originalHtml;
        }
    }
}
window.loadManageTradesData = loadManageTradesData;

// Universal refresh function for dashboard & system state
async function refreshAllData(btnElement) {
    let originalHtml = "";
    if (btnElement) {
        btnElement.disabled = true;
        originalHtml = btnElement.innerHTML;
        btnElement.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> <span>Refreshing...</span>';
    }
    try {
        const results = await Promise.allSettled([
            fetchDashboardSummary(),
            loadOpenTrades(),
            loadPendingOrders(),
            loadTradeHistoryPage(currentHistoryPage || 0),
            typeof fetchGlobalNews === "function" ? fetchGlobalNews() : Promise.resolve()
        ]);
        const anyFailed = results.some(r => r.status === "rejected");
        if (anyFailed) {
            console.warn("[Refresh] Some requests failed:", results);
            if (btnElement) {
                btnElement.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-yellow"></i> <span>Partial</span>';
                setTimeout(() => { if (btnElement) { btnElement.innerHTML = originalHtml; btnElement.disabled = false; } }, 1500);
                return;
            }
        }
        if (btnElement) {
            btnElement.innerHTML = '<i class="fa-solid fa-check text-green"></i> <span>Updated</span>';
            setTimeout(() => { if (btnElement) { btnElement.innerHTML = originalHtml; btnElement.disabled = false; } }, 1200);
        }
    } catch (err) {
        console.error("[Refresh] Error refreshing system data:", err);
        if (btnElement) {
            btnElement.innerHTML = '<i class="fa-solid fa-xmark text-red"></i> <span>Connection error</span>';
            setTimeout(() => { if (btnElement) { btnElement.innerHTML = originalHtml; btnElement.disabled = false; } }, 2000);
        }
    } finally {
        if (btnElement && !btnElement.innerHTML.includes("text-green") && !btnElement.innerHTML.includes("text-yellow") && !btnElement.innerHTML.includes("text-red")) {
            btnElement.disabled = false;
            btnElement.innerHTML = originalHtml;
        }
    }
}
window.refreshAllData = refreshAllData;

// Load Open Trades (Unified with Single Source of Truth)
async function loadOpenTrades() {
    const tbody = document.getElementById("open-trades-tbody");
    const countBadge = document.getElementById("manage-open-count");
    const overviewActiveEl = document.getElementById("overview-active-trades");
    try {
        const userId = currentUserId || (typeof localStorage !== "undefined" ? localStorage.getItem("orbit_user_id") : null) || 1;
        const res = await fetch(`/api/trades/open?user_id=${encodeURIComponent(userId)}`);
        if (!res.ok) throw new Error("Failed to load open positions");
        const json = await res.json();
        const positions = json.positions || json.trades || [];
        _openTradesCache = positions;

        if (countBadge) countBadge.textContent = positions.length;
        if (overviewActiveEl) overviewActiveEl.textContent = positions.length;

        if (!tbody) return;
        if (positions.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="13" class="table-empty-message">No active positions. Execute a trade from the Terminal or Auto-Trade Bot to begin.</td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = positions.map(pos => {
            const pnl = Number(pos.unrealized_pnl || 0);
            const pnlClass = pnl >= 0 ? "text-green" : "text-red";
            const side = (pos.side || pos.type || "buy").toUpperCase();
            const sideClass = side === "BUY" || side === "LONG" ? "badge-green" : "badge-red";
            const sideLabel = side === "BUY" ? "LONG" : side === "SELL" ? "SHORT" : side;
            const market = pos.market || "Crypto";
            const lev = pos.leverage || 1;
            const posSize = Number(pos.remaining_quantity || pos.quantity || 0) * Number(pos.current_price || pos.entry_price || 0);
            const marginUsed = Number(pos.margin_used || 0);
            const pnlPct = marginUsed > 0 ? ((pnl / marginUsed) * 100).toFixed(2) : "0.00";
            const openTime = pos.opened_at ? new Date(pos.opened_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'}) : "—";

            return `
                <tr>
                    <td><strong>${esc(pos.symbol || pos.asset)}</strong></td>
                    <td><span class="badge badge-blue">${esc(market)}</span></td>
                    <td><span class="badge ${sideClass}">${esc(sideLabel)}</span></td>
                    <td><span class="badge badge-blue">OPEN</span>${pos.source === "bot" ? ' <span class="badge badge-open" title="Opened by Auto-Trade Bot session #' + esc(pos.bot_session_id) + '">BOT</span>' : ""}</td>
                    <td>${formatINR(pos.entry_price)}</td>
                    <td><strong>${formatINR(pos.current_price)}</strong></td>
                    <td>${Number(pos.remaining_quantity || pos.quantity)} <span style="opacity:0.6;font-size:11px;">/ ${Number(pos.original_quantity || pos.quantity)}</span></td>
                    <td><span class="text-cyan font-bold">${lev}x</span></td>
                    <td>${formatINR(posSize)}</td>
                    <td>${formatINR(marginUsed)}</td>
                    <td class="${pnlClass}"><strong>${pnl >= 0 ? "+" : ""}${formatINR(pnl)}</strong> <span style="font-size:11px;opacity:0.8;">(${pnl >= 0 ? "+" : ""}${pnlPct}%)</span></td>
                    <td>${openTime}</td>
                    <td>
                        <button class="glow-btn btn-manage-action" onclick="openManageTradeModal(${pos.id})">
                            <i class="fa-solid fa-sliders"></i> Manage
                        </button>
                    </td>
                </tr>
            `;
        }).join("");
    } catch (err) {
        console.error("[ManageTrades] Error loading open positions:", err);
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="13" class="table-empty-message text-red">Failed to load active trades: ${esc(err.message)}</td></tr>`;
        }
    }
}
window.loadOpenTrades = loadOpenTrades;

// Load Pending Orders
async function loadPendingOrders() {
    const tbody = document.getElementById("pending-orders-tbody");
    const countBadge = document.getElementById("manage-pending-count");
    try {
        const userId = currentUserId || (typeof localStorage !== "undefined" ? localStorage.getItem("orbit_user_id") : null) || 1;
        const res = await fetch(`/api/trades/pending?user_id=${encodeURIComponent(userId)}`);
        if (!res.ok) throw new Error("Failed to load pending orders");
        const json = await res.json();
        const orders = json.orders || [];

        if (countBadge) countBadge.textContent = orders.length;

        if (!tbody) return;
        if (orders.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="10" class="table-empty-message">No pending orders. Limit and trigger orders awaiting execution will appear here.</td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = orders.map(ord => {
            const side = (ord.type || ord.side || "BUY").toUpperCase();
            const sideClass = side === "BUY" ? "badge-green" : "badge-red";
            const created = ord.timestamp ? new Date(ord.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : "—";
            return `
                <tr>
                    <td><code>#${ord.id}</code></td>
                    <td><strong>${esc(ord.asset || ord.symbol)}</strong></td>
                    <td><span class="badge ${sideClass}">${esc(side)}</span></td>
                    <td>${Number(ord.quantity || 1)}</td>
                    <td>${formatINR(ord.entry_price || 0)}</td>
                    <td>${formatINR(ord.sl || 0)}</td>
                    <td>${formatINR(ord.target || 0)}</td>
                    <td>${created}</td>
                    <td><span class="badge badge-yellow">PENDING</span></td>
                    <td>
                        <button class="glow-btn btn-secondary btn-sm" onclick="cancelPendingOrder(${ord.id})">
                            <i class="fa-solid fa-ban"></i> Cancel
                        </button>
                    </td>
                </tr>
            `;
        }).join("");
    } catch (err) {
        console.error("[ManageTrades] Error loading pending orders:", err);
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="10" class="table-empty-message text-red">Failed to load pending orders: ${esc(err.message)}</td></tr>`;
        }
    }
}
window.loadPendingOrders = loadPendingOrders;

// Cancel Pending Order
async function cancelPendingOrder(orderId) {
    if (!confirm("Are you sure you want to cancel this pending order?")) return;
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: "cancel_trade", trade_id: orderId }));
    }
    setTimeout(() => {
        loadPendingOrders();
        fetchDashboardSummary();
    }, 300);
}
window.cancelPendingOrder = cancelPendingOrder;

// Load Paginated Trade History
async function loadTradeHistoryPage(page) {
    if (page !== undefined) currentHistoryPage = page;
    const tbody = document.getElementById("trade-history-tbody");
    const countBadge = document.getElementById("manage-history-count");
    const prevBtn = document.getElementById("history-prev-btn");
    const nextBtn = document.getElementById("history-next-btn");
    const pageInfo = document.getElementById("history-page-info");

    const search = (document.getElementById("history-filter-symbol")?.value || "").trim();
    const market = document.getElementById("history-filter-market")?.value || "";
    const side = document.getElementById("history-filter-side")?.value || "";
    const outcome = document.getElementById("history-filter-outcome")?.value || "";

    const limit = 15;
    const offset = currentHistoryPage * limit;

    try {
        const userId = currentUserId || (typeof localStorage !== "undefined" ? localStorage.getItem("orbit_user_id") : null) || 1;
        const queryParams = new URLSearchParams({
            user_id: String(userId),
            limit: String(limit),
            offset: String(offset)
        });
        if (search) queryParams.append("symbol", search);
        if (market) queryParams.append("market", market);
        if (side) queryParams.append("side", side);
        if (outcome) queryParams.append("outcome", outcome);

        const res = await fetch(`/api/trades/history?${queryParams.toString()}`);
        if (!res.ok) throw new Error("Failed to load trade history");
        const json = await res.json();
        const trades = json.trades || [];
        const total = json.total || 0;

        if (countBadge) countBadge.textContent = total;

        totalHistoryPages = Math.max(1, Math.ceil(total / limit));
        if (pageInfo) pageInfo.textContent = `Page ${currentHistoryPage + 1} of ${totalHistoryPages}`;
        if (prevBtn) prevBtn.disabled = currentHistoryPage <= 0;
        if (nextBtn) nextBtn.disabled = currentHistoryPage >= totalHistoryPages - 1;

        if (!tbody) return;
        if (trades.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="12" class="table-empty-message">No completed trades match your filter criteria.</td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = trades.map(trade => {
            const pnl = Number(trade.realized_pnl !== undefined ? trade.realized_pnl : (trade.pnl || 0));
            const pnlClass = pnl > 0 ? "text-green" : pnl < 0 ? "text-red" : "";
            const side = (trade.side || trade.type || "buy").toUpperCase();
            const sideLabel = side === "BUY" ? "LONG" : side === "SELL" ? "SHORT" : side;
            const sideClass = side === "BUY" || side === "LONG" ? "badge-green" : "badge-red";
            const outcome = trade.outcome || (pnl > 0 ? "profit" : pnl < 0 ? "loss" : "closed");
            const outcomeClass = outcome === "target" || outcome === "profit" ? "badge-green" : outcome === "cancelled" ? "badge-yellow" : "badge-red";
            const openTime = trade.opened_at || trade.timestamp ? new Date(trade.opened_at || trade.timestamp).toLocaleDateString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}) : "—";
            const closeTime = trade.closed_at ? new Date(trade.closed_at).toLocaleDateString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}) : "—";
            const lev = trade.leverage || 1;
            const exitPrice = trade.exit_price !== null && trade.exit_price !== undefined ? formatINR(trade.exit_price) : "—";

            return `
                <tr>
                    <td><strong>${esc(trade.symbol || trade.asset)}</strong></td>
                    <td><span class="badge badge-blue">${esc(trade.market || "Crypto")}</span></td>
                    <td><span class="badge ${sideClass}">${esc(sideLabel)}</span></td>
                    <td>${formatINR(trade.entry_price || 0)}</td>
                    <td><strong>${exitPrice}</strong></td>
                    <td>${Number(trade.quantity || 0)}</td>
                    <td><span class="text-cyan font-bold">${lev}x</span></td>
                    <td class="${pnlClass}"><strong>${pnl >= 0 ? "+" : ""}${formatINR(pnl)}</strong></td>
                    <td><span class="badge ${outcomeClass}">${esc(outcome).toUpperCase()}</span></td>
                    <td>${openTime}</td>
                    <td>${closeTime}</td>
                    <td><span class="badge badge-yellow">${esc(trade.status || "CLOSED").toUpperCase()}</span></td>
                </tr>
            `;
        }).join("");
    } catch (err) {
        console.error("[ManageTrades] Error loading history:", err);
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="12" class="table-empty-message text-red">Failed to load history: ${esc(err.message)}</td></tr>`;
        }
    }
}
window.loadTradeHistoryPage = loadTradeHistoryPage;

function paginateHistory(direction) {
    const targetPage = currentHistoryPage + direction;
    if (targetPage >= 0 && targetPage < totalHistoryPages) {
        loadTradeHistoryPage(targetPage);
    }
}
window.paginateHistory = paginateHistory;

function debouncedHistorySearch() {
    clearTimeout(_historySearchDebounceTimer);
    _historySearchDebounceTimer = setTimeout(() => {
        loadTradeHistoryPage(0);
    }, 300);
}
window.debouncedHistorySearch = debouncedHistorySearch;

// Manage Trade Modal Operations
function openManageTradeModal(tradeId) {
    const trade = _openTradesCache.find(p => p.id === tradeId) || _botActiveTradesCache.find(p => p.id === tradeId);
    if (!trade) {
        console.warn("[ManageTrades] Trade not found in cache:", tradeId);
        return;
    }
    _activeManageTrade = trade;
    _closeSelectedPct = null;

    const modal = document.getElementById("manage-trade-modal");
    if (!modal) return;

    // Populate header & specs
    const symbol = trade.symbol || trade.asset || "";
    safeText(document.getElementById("mmodal-symbol-sub"), `${symbol} • ${trade.market || "Spot"} Market`);
    const side = (trade.side || trade.type || "buy").toUpperCase();
    const sideBadge = document.getElementById("mmodal-side-badge");
    if (sideBadge) {
        sideBadge.textContent = side === "BUY" ? "LONG" : side === "SELL" ? "SHORT" : side;
        sideBadge.className = `trade-side-badge ${side === "BUY" || side === "LONG" ? "buy" : "sell"}`;
    }
    safeText(document.getElementById("mmodal-status-badge"), "OPEN");

    safeText(document.getElementById("mmodal-entry-price"), formatINR(trade.entry_price || 0));
    safeText(document.getElementById("mmodal-current-price"), formatINR(trade.current_price || 0));
    safeText(document.getElementById("mmodal-total-qty"), String(trade.original_quantity || trade.quantity || 1));
    safeText(document.getElementById("mmodal-remaining-qty"), String(trade.remaining_quantity || trade.quantity || 1));
    safeText(document.getElementById("mmodal-leverage"), `${trade.leverage || 1}x`);

    const uPnl = Number(trade.unrealized_pnl || 0);
    const uPnlEl = document.getElementById("mmodal-unrealized-pnl");
    if (uPnlEl) {
        uPnlEl.textContent = (uPnl >= 0 ? "+" : "") + formatINR(uPnl);
        uPnlEl.className = `mmodal-metric-val ${uPnl >= 0 ? "text-green" : "text-red"}`;
    }

    // Default select 50%
    selectClosePct(50);

    modal.classList.remove("hidden");
}
window.openManageTradeModal = openManageTradeModal;

function closeManageTradeModal() {
    const modal = document.getElementById("manage-trade-modal");
    if (modal) modal.classList.add("hidden");
    _activeManageTrade = null;
    _closeSelectedPct = null;
}
window.closeManageTradeModal = closeManageTradeModal;

function selectClosePct(pct) {
    if (!_activeManageTrade) return;
    _closeSelectedPct = pct;

    // Update active style on pct buttons
    document.querySelectorAll(".close-pct-btn-group .pct-btn").forEach(btn => {
        const text = btn.textContent.trim();
        const matches = (pct === 100 && text.includes("FULL")) || text.includes(`${pct}%`);
        btn.classList.toggle("active-pct", matches);
    });

    const remQty = Number(_activeManageTrade.remaining_quantity || _activeManageTrade.quantity || 1);
    let closeQty = (remQty * (pct / 100));
    if (Number.isInteger(remQty)) {
        closeQty = Math.max(1, Math.round(closeQty));
        if (pct < 100 && closeQty >= remQty) {
            closeQty = Math.max(1, remQty - 1);
        }
    } else {
        closeQty = Number(closeQty.toFixed(4));
    }
    if (pct === 100) closeQty = remQty;

    const input = document.getElementById("custom-close-qty");
    if (input) input.value = closeQty;

    recalculateCloseEstimates(closeQty);
}
window.selectClosePct = selectClosePct;

function onCustomCloseInput() {
    if (!_activeManageTrade) return;
    document.querySelectorAll(".close-pct-btn-group .pct-btn").forEach(btn => btn.classList.remove("active-pct"));
    _closeSelectedPct = null;

    const input = document.getElementById("custom-close-qty");
    const val = parseFloat(input.value);
    const remQty = Number(_activeManageTrade.remaining_quantity || _activeManageTrade.quantity || 1);

    if (isNaN(val) || val <= 0) {
        recalculateCloseEstimates(0);
        return;
    }
    const safeQty = Math.min(val, remQty);
    if (val > remQty) {
        input.value = safeQty;
    }
    recalculateCloseEstimates(safeQty);
}
window.onCustomCloseInput = onCustomCloseInput;

function setMaxCloseQty() {
    if (!_activeManageTrade) return;
    selectClosePct(100);
}
window.setMaxCloseQty = setMaxCloseQty;

function recalculateCloseEstimates(closeQty) {
    if (!_activeManageTrade) return;
    const trade = _activeManageTrade;
    const entry = Number(trade.entry_price || 0);
    const current = Number(trade.current_price || entry);
    const lev = Number(trade.leverage || 1);
    const remQty = Number(trade.remaining_quantity || trade.quantity || 1);
    const marginUsed = Number(trade.margin_used || 0);
    const side = (trade.side || trade.type || "buy").toLowerCase();

    let estPnl = 0;
    if (side === "buy" || side === "long") {
        estPnl = (current - entry) * closeQty * lev;
    } else {
        estPnl = (entry - current) * closeQty * lev;
    }

    const marginPortion = remQty > 0 ? (closeQty / remQty) * marginUsed : 0;
    const totalRefund = marginPortion + estPnl;

    safeText(document.getElementById("est-close-qty"), String(closeQty));
    safeText(document.getElementById("est-exit-price"), formatINR(current));

    const pnlEl = document.getElementById("est-realized-pnl");
    if (pnlEl) {
        pnlEl.textContent = (estPnl >= 0 ? "+" : "") + formatINR(estPnl);
        pnlEl.className = estPnl >= 0 ? "text-green" : "text-red";
    }
    safeText(document.getElementById("est-margin-refund"), formatINR(Math.max(0, totalRefund)));
}

async function executePositionClose() {
    if (_isCloseExecuting) return;
    if (!_activeManageTrade) return;

    const trade = _activeManageTrade;
    const tradeId = trade.id;
    const remQty = Number(trade.remaining_quantity || trade.quantity || 1);
    const input = document.getElementById("custom-close-qty");
    const closeQty = parseFloat(input?.value || "0");

    if (isNaN(closeQty) || closeQty <= 0) {
        alert("Please specify a valid quantity to close greater than zero.");
        return;
    }
    if (closeQty > remQty) {
        alert(`Cannot close more than the remaining quantity (${remQty}).`);
        return;
    }

    const isFullClose = (closeQty >= remQty);
    const confirmMsg = isFullClose 
        ? `Confirm FULL CLOSE of ${trade.symbol || trade.asset} (${remQty} units)?`
        : `Confirm partial close of ${closeQty} units of ${trade.symbol || trade.asset}?`;

    if (!confirm(confirmMsg)) return;

    _isCloseExecuting = true;
    const btn = document.getElementById("btn-confirm-close");
    const btnText = document.getElementById("btn-confirm-close-text");
    if (btn) btn.disabled = true;
    if (btnText) btnText.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Closing...';

    try {
        // The close endpoints check ownership against user_id; omitting it made
        // the backend fall back to user 1 and reject every other account.
        const uid = currentUserId || localStorage.getItem("orbit_user_id") || 1;
        const endpoint = isFullClose
            ? `/api/trades/${tradeId}/close/full?user_id=${encodeURIComponent(uid)}`
            : `/api/trades/${tradeId}/close`;
        const payload = isFullClose ? {} : { quantity: closeQty, user_id: Number(uid) };

        const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
            throw new Error(data.detail || data.error || "Failed to execute close order");
        }

        // Close modal
        closeManageTradeModal();

        // Refresh all relevant views immediately
        await Promise.all([
            loadOpenTrades(),
            fetchDashboardSummary(),
            loadTradeHistoryPage(0),
            trade.source === "bot" ? refreshBotControlCenter().catch(() => {}) : Promise.resolve()
        ]);

        logToTerminal("Execution Agent", `✅ Position #${tradeId} (${trade.symbol || trade.asset}) ${isFullClose ? "fully" : "partially"} closed. Realized P&L: ${formatINR(data.realized_pnl || 0)}`);
    } catch (err) {
        console.error("[ManageTrades] Close execution error:", err);
        alert(`Close order failed: ${err.message}`);
    } finally {
        _isCloseExecuting = false;
        if (btn) btn.disabled = false;
        if (btnText) btnText.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Close';
    }
}
window.executePositionClose = executePositionClose;



