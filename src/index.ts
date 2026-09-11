/**
 * ORBIT Trading Terminal — Main TypeScript Application Bootstrap
 * Connects UI controllers, services, state and WebSockets, and exposes the
 * window bindings used by index.html's inline handlers.
 */

import { store } from "./state/store";
import { formatINR, formatINRSafe, esc } from "./utils/formatters";
import { getElement } from "./utils/dom";
import { UNAUTHORIZED_EVENT } from "./services/apiClient";
import { authService } from "./services/authService";
import { SOCKET_FAILED_EVENT } from "./websocket/socketManager";

import {
    initClerkAuth,
    syncClerkUserAndEnter,
    enterDashboard,
    launchDemoDirect,
    scrollToLogin,
    switchAuthTab,
    togglePw,
    handleClerkGoogleAuth,
    handleLogin,
    handleSignup,
    logout,
    restoreSession,
    handleUnauthorized
} from "./ui/authController";

import {
    switchToTab,
    initChart,
    setTimeframe,
    drawChartOverlay,
    selectStock,
    confirmTrade,
    rejectTrade,
    initTerminalListeners
} from "./ui/terminalController";

import {
    initTerminalAgentListeners,
    prepareTradeEnvironment,
    runAgentCrew,
    stopAgentCrew,
    handleTick,
    handleHistory,
    handleLevels,
    handleSignal,
    handleMetrics,
    handleSystemStatus
} from "./ui/terminalAgentController";

import { fetchGlobalNews, fetchSymbolNews } from "./ui/newsController";

import {
    loadManageTradesData,
    refreshAllData,
    loadOpenTrades,
    loadPendingOrders,
    cancelPendingOrder,
    loadTradeHistoryPage,
    loadOverviewHistory,
    paginateHistory,
    debouncedHistorySearch,
    openManageTradeModal,
    closeManageTradeModal,
    selectClosePct,
    onCustomCloseInput,
    setMaxCloseQty,
    executePositionClose,
    quickCloseTrade,
    fetchDashboardSummary,
    renderDashboardSummary,
    switchManageSubTab
} from "./ui/manageTradesController";

import {
    openStrategyModal,
    closeStrategyModal,
    refreshStrategyModal,
    openConsensusModal,
    closeConsensusModal,
    refreshConsensusModal,
    openBrainModal,
    closeBrainModal,
    refreshBrainModal,
    openRiskModal,
    closeRiskModal,
    refreshRiskModal,
    openOpportunityModal,
    closeOpportunityModal,
    refreshOpportunityModal,
    openDecisionModal,
    closeDecisionModal,
    refreshDecisionModal,
    openExplainModal,
    closeExplainModal,
    refreshExplainModal,
    initModalKeyboardListeners
} from "./ui/aiModalsController";

import {
    openCopilotModal,
    closeCopilotModal,
    refreshCopilotContext,
    askCopilotPreset,
    clearCopilotChat,
    sendCopilotMessage,
    syncCopilotBalance,
    loadConversationsList,
    selectConversation,
    createNewAnalysis,
    toggleCopilotSidebar,
    deleteConversationClick,
    onCopilotMarketChange,
    onAssetSearchInput,
    selectAsset,
    setResponseMode,
    syncCopilotPageView,
    sendCopilotPageMessage,
    askCopilotPagePreset,
    clearCopilotPageChat
} from "./ui/copilotController";

import {
    logToTerminal,
    updateAgentStatusUI,
    loadBotConfig,
    saveBotConfig,
    initAutoBotListeners,
    initBotControlCenter,
    refreshBotControlCenter,
    startBotSession,
    stopBotSession,
    onBotMarketChange,
    setBotCapitalMax,
    switchBotHistoryTab,
    handleBotEvent,
    handleBotSessionUpdate
} from "./ui/autoBotController";

import {
    loadReport,
    exportReportCsv,
    exportReportJson,
    exportReportPdf,
    initReportsListeners
} from "./ui/reportsController";

import {
    renderSkills,
    renderStrategies,
    filterSkills,
    openSkillModal,
    closeSkillModal,
    triggerAiSimulationDemo,
    closeSimModal,
    drawBtcSparkline,
    initLandingShowcase,
    ULTIMATE_SKILLS_DATA,
    STRATEGIES_DATA
} from "./ui/landingController";

import { threeController } from "./three/scene";

// -------------------------------------------------------------
// Bind All Global Window Handles for index.html inline onclicks
// -------------------------------------------------------------
const w = window as any;

// Auth
w.scrollToLogin = scrollToLogin;
w.launchDemoDirect = launchDemoDirect;
w.switchAuthTab = switchAuthTab;
w.togglePw = togglePw;
w.handleClerkGoogleAuth = handleClerkGoogleAuth;
w.syncClerkUserAndEnter = syncClerkUserAndEnter;
w.enterDashboard = enterDashboard;
w.logout = logout;
w.handleLogin = handleLogin;
w.handleSignup = handleSignup;

// Navigation & Terminal
w.switchToTab = switchToTab;
w.setTimeframe = setTimeframe;
w.selectStock = selectStock;
w.initChart = initChart;
w.drawChartOverlay = drawChartOverlay;
w.confirmTrade = confirmTrade;
w.rejectTrade = rejectTrade;
w.prepareTradeEnvironment = prepareTradeEnvironment;
w.runAgentCrew = runAgentCrew;
w.stopAgentCrew = stopAgentCrew;

// News
w.fetchGlobalNews = fetchGlobalNews;
w.fetchSymbolNews = fetchSymbolNews;

// Manage Trades
w.loadManageTradesData = loadManageTradesData;
w.refreshAllData = refreshAllData;
w.loadOpenTrades = loadOpenTrades;
w.loadPendingOrders = loadPendingOrders;
w.cancelPendingOrder = cancelPendingOrder;
w.loadTradeHistoryPage = loadTradeHistoryPage;
w.paginateHistory = paginateHistory;
w.debouncedHistorySearch = debouncedHistorySearch;
w.openManageTradeModal = openManageTradeModal;
w.closeManageTradeModal = closeManageTradeModal;
w.selectClosePct = selectClosePct;
w.onCustomCloseInput = onCustomCloseInput;
w.setMaxCloseQty = setMaxCloseQty;
w.executePositionClose = executePositionClose;
w.quickCloseTrade = quickCloseTrade;
w.fetchDashboardSummary = fetchDashboardSummary;
w.switchManageSubTab = switchManageSubTab;

// AI Modals
w.openStrategyModal = openStrategyModal;
w.closeStrategyModal = closeStrategyModal;
w.refreshStrategyModal = refreshStrategyModal;
w.openConsensusModal = openConsensusModal;
w.closeConsensusModal = closeConsensusModal;
w.refreshConsensusModal = refreshConsensusModal;
w.openBrainModal = openBrainModal;
w.closeBrainModal = closeBrainModal;
w.refreshBrainModal = refreshBrainModal;
w.openRiskModal = openRiskModal;
w.closeRiskModal = closeRiskModal;
w.refreshRiskModal = refreshRiskModal;
w.openOpportunityModal = openOpportunityModal;
w.closeOpportunityModal = closeOpportunityModal;
w.refreshOpportunityModal = refreshOpportunityModal;
w.openDecisionModal = openDecisionModal;
w.closeDecisionModal = closeDecisionModal;
w.refreshDecisionModal = refreshDecisionModal;
w.openExplainModal = openExplainModal;
w.closeExplainModal = closeExplainModal;
w.refreshExplainModal = refreshExplainModal;

// Copilot
w.openCopilotModal = openCopilotModal;
w.closeCopilotModal = closeCopilotModal;
w.refreshCopilotContext = refreshCopilotContext;
w.askCopilotPreset = askCopilotPreset;
w.clearCopilotChat = clearCopilotChat;
w.sendCopilotMessage = sendCopilotMessage;
w.syncCopilotBalance = syncCopilotBalance;
w.loadConversationsList = loadConversationsList;
w.selectConversation = selectConversation;
w.createNewAnalysis = createNewAnalysis;
w.toggleCopilotSidebar = toggleCopilotSidebar;
w.deleteConversationClick = deleteConversationClick;
w.onCopilotMarketChange = onCopilotMarketChange;
w.onAssetSearchInput = onAssetSearchInput;
w.selectAsset = selectAsset;
w.setResponseMode = setResponseMode;
w.syncCopilotPageView = syncCopilotPageView;
w.sendCopilotPageMessage = sendCopilotPageMessage;
w.askCopilotPagePreset = askCopilotPagePreset;
w.clearCopilotPageChat = clearCopilotPageChat;

// AutoBot & Terminal log
w.logToTerminal = logToTerminal;
w.updateAgentStatusUI = updateAgentStatusUI;
w.loadBotConfig = loadBotConfig;
w.saveBotConfig = saveBotConfig;
w.initBotControlCenter = initBotControlCenter;
w.refreshBotControlCenter = refreshBotControlCenter;
w.startBotSession = startBotSession;
w.stopBotSession = stopBotSession;
w.onBotMarketChange = onBotMarketChange;
w.setBotCapitalMax = setBotCapitalMax;
w.switchBotHistoryTab = switchBotHistoryTab;
w.handleBotEvent = handleBotEvent;
w.handleBotSessionUpdate = handleBotSessionUpdate;

// Reports
w.loadReport = loadReport;
w.exportReportCsv = exportReportCsv;
w.exportReportJson = exportReportJson;
w.exportReportPdf = exportReportPdf;

// Landing Page Showcase & Skills
w.renderSkills = renderSkills;
w.renderStrategies = renderStrategies;
w.filterSkills = filterSkills;
w.openSkillModal = openSkillModal;
w.closeSkillModal = closeSkillModal;
w.triggerAiSimulationDemo = triggerAiSimulationDemo;
w.closeSimModal = closeSimModal;
w.drawBtcSparkline = drawBtcSparkline;
w.ULTIMATE_SKILLS_DATA = ULTIMATE_SKILLS_DATA;
w.STRATEGIES_DATA = STRATEGIES_DATA;

// Formatters & Utils
w.formatINR = formatINR;
w.esc = esc;

// 3D Scene Handle
if (!w.aether3D) {
    w.aether3D = {
        stop: () => threeController.stop(),
        start: () => threeController.start()
    };
}
if (!w.stop3D) w.stop3D = () => (w.aether3D?.stop ? w.aether3D.stop() : threeController.stop());
if (!w.start3D) w.start3D = () => (w.aether3D?.start ? w.aether3D.start() : threeController.start());

// -------------------------------------------------------------
// WebSocket Listeners & Reactive Data Stream Wiring
// -------------------------------------------------------------

/** Runs fn at most once per `ms`, always delivering the latest trailing call. */
function throttle(fn: () => void, ms: number): () => void {
    let last = 0;
    let timer: number | null = null;
    return () => {
        const wait = ms - (Date.now() - last);
        if (wait <= 0 && timer === null) {
            last = Date.now();
            fn();
            return;
        }
        if (timer === null) {
            timer = window.setTimeout(() => {
                timer = null;
                last = Date.now();
                fn();
            }, Math.max(0, wait));
        }
    };
}

// Portfolio changes (fills, closes, wallet moves) refresh the authoritative views.
const refreshPortfolio = throttle(() => {
    loadOpenTrades();
    loadPendingOrders();
    fetchDashboardSummary();
}, 1500);
// Per-tick P&L pushes arrive every few seconds per position; coalesce them.
const refreshLivePnl = throttle(() => {
    loadOpenTrades();
    fetchDashboardSummary();
}, 5000);
const refreshHistory = throttle(() => {
    loadTradeHistoryPage(store.get("historyPage") || 0);
    loadOverviewHistory();
}, 3000);

function setupWebSocketSubscriptions(): void {
    const sockets = store.sockets;

    sockets.on("tick", (msg: any) => handleTick(msg));
    sockets.on("history", (msg: any) => handleHistory(msg));
    sockets.on("levels", (msg: any) => handleLevels(msg));
    sockets.on("signal", (msg: any) => handleSignal(msg));
    sockets.on("metrics", (msg: any) => handleMetrics(msg));
    sockets.on("system_status", (msg: any) => handleSystemStatus(msg));

    sockets.on("log", (msg: any) => {
        if (msg.agent && msg.message) {
            logToTerminal(msg.agent, msg.message, msg.time);
            updateAgentStatusUI(msg.agent, msg.message);
        }
    });

    sockets.on("dashboard_summary", (msg: any) => {
        if (msg.data) renderDashboardSummary(msg.data);
    });

    const onWallet = (msg: any) => {
        const balance = typeof msg.balance === "number" ? msg.balance : msg.data?.balance;
        if (typeof balance === "number") {
            store.set("walletBalance", balance);
            const walletEl = getElement("wallet-balance");
            if (walletEl) walletEl.textContent = formatINRSafe(balance);
        }
        refreshPortfolio();
    };
    sockets.on("wallet", onWallet);
    sockets.on("wallet_updated", onWallet);

    for (const evt of ["positions", "positions_updated", "trade_opened", "trade_closed"] as const) {
        sockets.on(evt, () => refreshPortfolio());
    }
    for (const evt of ["trade_updated", "position_updated"] as const) {
        sockets.on(evt, () => refreshLivePnl());
    }
    sockets.on("history_trades", () => refreshHistory());

    sockets.on("bot_event", (msg: any) => handleBotEvent(msg));
    sockets.on("bot_session_updated", (msg: any) => handleBotSessionUpdate(msg.data));
    sockets.on("auth_error", () => {
        void handleUnauthorized();
    });
}

// -------------------------------------------------------------
// Application Lifecycle & Hydration
// -------------------------------------------------------------
function initApp(): void {
    initLandingShowcase();
    initModalKeyboardListeners();
    initTerminalListeners();
    initTerminalAgentListeners();
    initAutoBotListeners();
    initReportsListeners();
    setupWebSocketSubscriptions();

    getElement<HTMLFormElement>("login-form")?.addEventListener("submit", handleLogin);
    getElement<HTMLFormElement>("signup-form")?.addEventListener("submit", handleSignup);
    getElement("logout-btn")?.addEventListener("click", logout);

    // The gateway rejected the session (REST 401) or the private socket could
    // not be opened: re-check the session, recover it from Clerk, or sign out.
    window.addEventListener(UNAUTHORIZED_EVENT, () => {
        void handleUnauthorized();
    });
    window.addEventListener(SOCKET_FAILED_EVENT, () => {
        if (document.body.classList.contains("in-dashboard")) authService.me().catch(() => {});
    });

    if (!document.body.classList.contains("in-dashboard") && !window.location.hash.includes("dashboard")) {
        if (typeof w.start3D === "function") w.start3D();
        else threeController.start();
    }

    initClerkAuth();

    // Re-open the dashboard only for a session the gateway still accepts
    // (its HttpOnly cookie) — never from a user id kept in the browser.
    if (window.location.hash.includes("dashboard")) {
        void restoreSession();
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
} else {
    initApp();
}
