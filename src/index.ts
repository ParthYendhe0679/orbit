/**
 * ORBIT Trading Terminal — Main TypeScript Application Bootstrap
 * Seamlessly connects UI controllers, services, state, and WebSockets while exposing window bindings
 */

import { store } from "./state/store";
import { formatINR, esc } from "./utils/formatters";
import { getElement } from "./utils/dom";

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
    logout
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
    loadManageTradesData,
    refreshAllData,
    loadOpenTrades,
    loadPendingOrders,
    cancelPendingOrder,
    loadTradeHistoryPage,
    paginateHistory,
    debouncedHistorySearch,
    openManageTradeModal,
    closeManageTradeModal,
    selectClosePct,
    onCustomCloseInput,
    setMaxCloseQty,
    executePositionClose,
    fetchDashboardSummary,
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

// AutoBot & Terminal
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
function setupWebSocketSubscriptions(): void {
    const sockets = store.sockets;

    sockets.on("tick", (msg: any) => {
        const price = msg.data?.price || (msg.candle ? msg.candle.close : null);
        if (price !== null && price !== undefined) {
            const legendPrice = getElement("legend-price");
            if (legendPrice) legendPrice.textContent = formatINR(price);
        }
    });

    sockets.on("log", (msg: any) => {
        if (msg.agent && msg.message) {
            logToTerminal(msg.agent, msg.message, msg.time);
            updateAgentStatusUI(msg.agent, msg.message);
        }
    });

    sockets.on("positions_updated", () => {
        loadOpenTrades();
        fetchDashboardSummary();
    });

    sockets.on("dashboard_summary", (msg: any) => {
        if (msg.data) {
            store.set("dashboardSummary", msg.data);
        }
    });

    sockets.on("wallet_updated", (msg: any) => {
        if (msg.balance !== undefined) {
            store.set("walletBalance", msg.balance);
            const walletEl = getElement("wallet-balance");
            if (walletEl) walletEl.textContent = formatINR(msg.balance);
        }
    });

    sockets.on("bot_event", (msg: any) => {
        handleBotEvent(msg);
    });

    sockets.on("bot_session_updated", (msg: any) => {
        handleBotSessionUpdate(msg.data);
    });
}

// -------------------------------------------------------------
// Application Lifecycle & Hydration
// -------------------------------------------------------------
function initApp(): void {
    initLandingShowcase();
    initModalKeyboardListeners();
    initTerminalListeners();
    initAutoBotListeners();
    initReportsListeners();
    setupWebSocketSubscriptions();

    // Wire auth form submission listeners
    const loginForm = getElement<HTMLFormElement>("login-form");
    if (loginForm) loginForm.addEventListener("submit", handleLogin);

    const signupForm = getElement<HTMLFormElement>("signup-form");
    if (signupForm) signupForm.addEventListener("submit", handleSignup);

    const logoutBtn = getElement("logout-btn");
    if (logoutBtn) logoutBtn.addEventListener("click", logout);

    // Initialize 3D scene on landing page
    if (!document.body.classList.contains("in-dashboard") && !window.location.hash.includes("dashboard")) {
        if (typeof w.start3D === "function") {
            w.start3D();
        } else {
            threeController.start();
        }
    }

    // Initialize Clerk in background
    initClerkAuth();

    // Check if user is already logged in or navigating to #dashboard
    const savedUsername = localStorage.getItem("orbit_logged_in_username");
    const savedUserId = localStorage.getItem("orbit_user_id");
    const oauthStartedAt = Number(sessionStorage.getItem("orbit_oauth_in_progress") || 0);
    const oauthFresh = oauthStartedAt > 1 && Date.now() - oauthStartedAt < 15 * 60 * 1000;
    const isReturningFromOAuth =
        oauthFresh ||
        window.location.hash.includes("dashboard") ||
        window.location.hash.includes("sso-callback");

    if (savedUsername && (isReturningFromOAuth || window.location.hash === "#dashboard")) {
        enterDashboard(savedUsername, savedUserId);
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
} else {
    initApp();
}
