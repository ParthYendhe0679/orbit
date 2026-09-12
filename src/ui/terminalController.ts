/**
 * ORBIT Trading Terminal — Terminal & Chart Controller
 * Manages Navigation Tabs, TradingView Advanced Widget, S/R Overlay Drawing, and Timeframe switching
 */

import { store } from "../state/store";
import { safeText, getElement } from "../utils/dom";

const SYMBOL_MAP: Record<string, string> = {
    "BTC-USD": "BINANCE:BTCUSDT",
    "ETH-USD": "BINANCE:ETHUSDT",
    "SOL-USD": "BINANCE:SOLUSDT",
    "AAPL": "NASDAQ:AAPL",
    "TSLA": "NASDAQ:TSLA",
    "NVDA": "NASDAQ:NVDA",
    "MSFT": "NASDAQ:MSFT",
    "AMZN": "NASDAQ:AMZN",
    "GOOGL": "NASDAQ:GOOGL",
    "META": "NASDAQ:META",
    "RELIANCE.NS": "NSE:RELIANCE",
    "TCS.NS": "NSE:TCS",
    "HDFCBANK.NS": "NSE:HDFCBANK",
    "INFY.NS": "NSE:INFY",
    "ICICIBANK.NS": "NSE:ICICIBANK"
};

let tvWidget: any = null;

/**
 * Resolves ticker symbols into TradingView widget format.
 */
export function toTVSymbol(raw: string): string {
    const upper = raw.trim().toUpperCase();
    if (SYMBOL_MAP[upper]) return SYMBOL_MAP[upper];
    if (upper.endsWith(".NS")) return "NSE:" + upper.replace(".NS", "");
    if (upper.endsWith(".BO")) return "BSE:" + upper.replace(".BO", "");
    if (upper.includes("-USD")) {
        return "BINANCE:" + upper.replace("-USD", "USDT");
    }
    return upper;
}

/**
 * Switches between navigation tabs.
 */
export function switchToTab(tabName: string): void {
    const menuBtnDashboard = getElement("menu-btn-dashboard");
    const menuBtnTerminal = getElement("menu-btn-terminal");
    const menuBtnAutotrade = getElement("menu-btn-autotrade");
    const menuBtnManageTrades = getElement("menu-btn-manage-trades");
    const menuBtnReports = getElement("menu-btn-reports");
    const menuBtnCopilot = getElement("menu-btn-copilot");
    const menuBtnStrategyLab = getElement("menu-btn-strategy-lab");

    const tabContentOverview = getElement("tab-content-overview");
    const tabContentTerminal = getElement("tab-content-terminal");
    const tabContentAutotrade = getElement("tab-content-autotrade");
    const tabContentManageTrades = getElement("tab-content-manage-trades");
    const tabContentReports = getElement("tab-content-reports");
    const tabContentCopilot = getElement("tab-content-copilot");
    const tabContentStrategyLab = getElement("tab-content-strategy-lab");
    const contentHeaderTitle = getElement("content-header-title");

    const allButtons = [
        menuBtnDashboard,
        menuBtnTerminal,
        menuBtnAutotrade,
        menuBtnManageTrades,
        menuBtnReports,
        menuBtnCopilot,
        menuBtnStrategyLab
    ];
    const allContents = [
        tabContentOverview,
        tabContentTerminal,
        tabContentAutotrade,
        tabContentManageTrades,
        tabContentReports,
        tabContentCopilot,
        tabContentStrategyLab
    ];

    allButtons.forEach((b) => b?.classList.remove("active"));
    allContents.forEach((c) => c?.classList.add("hidden-tab"));

    if (tabName === "dashboard") {
        menuBtnDashboard?.classList.add("active");
        tabContentOverview?.classList.remove("hidden-tab");
        safeText(contentHeaderTitle, "Dashboard Overview");
        if (typeof (window as any).fetchGlobalNews === "function") (window as any).fetchGlobalNews();
        if (typeof (window as any).fetchDashboardSummary === "function") (window as any).fetchDashboardSummary();
    } else if (tabName === "terminal") {
        menuBtnTerminal?.classList.add("active");
        tabContentTerminal?.classList.remove("hidden-tab");
        safeText(contentHeaderTitle, "Trade Agent Terminal");
    } else if (tabName === "autotrade") {
        menuBtnAutotrade?.classList.add("active");
        tabContentAutotrade?.classList.remove("hidden-tab");
        safeText(contentHeaderTitle, "Auto-Trade Bot");
        if (typeof (window as any).initBotControlCenter === "function") {
            (window as any).initBotControlCenter();
        } else if (typeof (window as any).loadBotConfig === "function") {
            (window as any).loadBotConfig();
        }
    } else if (tabName === "manage-trades") {
        menuBtnManageTrades?.classList.add("active");
        tabContentManageTrades?.classList.remove("hidden-tab");
        safeText(contentHeaderTitle, "Manage Trades");
        if (typeof (window as any).loadManageTradesData === "function") (window as any).loadManageTradesData();
    } else if (tabName === "reports") {
        menuBtnReports?.classList.add("active");
        tabContentReports?.classList.remove("hidden-tab");
        safeText(contentHeaderTitle, "Trade Reports & Analytics");
        if (typeof (window as any).loadReport === "function") (window as any).loadReport();
    } else if (tabName === "copilot") {
        menuBtnCopilot?.classList.add("active");
        tabContentCopilot?.classList.remove("hidden-tab");
        safeText(contentHeaderTitle, "ORBIT AI Analyst");
        if (window.aether3D && typeof window.aether3D.stop === "function") window.aether3D.stop();
        const threeCanvas = getElement("three-canvas");
        if (threeCanvas) threeCanvas.style.display = "none";
        if (typeof (window as any).loadConversationsList === "function") (window as any).loadConversationsList();
        if (typeof (window as any).syncCopilotBalance === "function") (window as any).syncCopilotBalance();
    } else if (tabName === "strategy-lab") {
        menuBtnStrategyLab?.classList.add("active");
        tabContentStrategyLab?.classList.remove("hidden-tab");
        safeText(contentHeaderTitle, "ORBIT AI Strategy Lab");
        if (typeof (window as any).initStrategyLab === "function") (window as any).initStrategyLab();
    }
}

/**
 * Initializes or re-initializes TradingView Advanced Widget with institutional dark theme.
 */
export function initChart(symbol: string, interval?: string): void {
    const container = getElement("tradingview-widget-container");
    if (!container) return;
    container.innerHTML = "";

    if (!window.TradingView) {
        console.warn("[TradingView] Advanced Widget library not yet loaded from CDN.");
        return;
    }

    const currentTf = interval || store.get("currentTimeframe") || "1d";
    const tvSymbol = toTVSymbol(symbol || store.get("currentAsset") || "BTC-USD");

    try {
        tvWidget = new window.TradingView.widget({
            autosize: true,
            symbol: tvSymbol,
            interval: currentTf === "1d" ? "D" : currentTf === "1w" ? "W" : currentTf,
            timezone: "Etc/UTC",
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
            container_id: "tradingview-widget-container"
        });
    } catch (err) {
        console.error("[TradingView] Widget initialization error:", err);
    }
}

/**
 * Changes active chart timeframe resolution.
 */
export function setTimeframe(tf: string): void {
    store.set("currentTimeframe", tf);

    document.querySelectorAll(".tf-btn").forEach((b) => b.classList.remove("tf-active"));
    const activeBtn = document.querySelector(`.tf-btn[data-tf="${tf}"]`);
    if (activeBtn) activeBtn.classList.add("tf-active");

    if (tvWidget && tvWidget.chart) {
        try {
            tvWidget.chart().setResolution(String(tf), () => {
                console.log("Timeframe set to:", tf);
            });
        } catch {
            initChart(store.get("currentAsset"), tf);
        }
    }
}

/**
 * Draws Support / Resistance rectangular price zones on chart canvas.
 */
export function drawChartOverlay(clearOnly: boolean = false): void {
    const canvas = getElement<HTMLCanvasElement>("chart-overlay-canvas");
    const container = getElement("chart-container");
    if (!canvas || !container) return;

    canvas.width = container.offsetWidth;
    canvas.height = container.offsetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (clearOnly) return;

    const supports: number[] = (window as any).lastSupports || [];
    const resistances: number[] = (window as any).lastResistances || [];

    const allPrices = [...supports, ...resistances];
    if (allPrices.length === 0) return;

    const maxP = Math.max(...allPrices);
    const minP = Math.min(...allPrices);
    const padding = (maxP - minP) * 0.18 || 1;
    const priceTop = maxP + padding;
    const priceBottom = minP - padding;
    const priceRange = priceTop - priceBottom;

    function priceToY(p: number): number {
        return canvas!.height - ((p - priceBottom) / priceRange) * canvas!.height;
    }

    // Draw Support lines (Green)
    supports.forEach((price) => {
        const y = priceToY(price);
        ctx.save();
        ctx.strokeStyle = "rgba(0, 230, 138, 0.7)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas!.width, y);
        ctx.stroke();
        ctx.restore();
    });

    // Draw Resistance lines (Red)
    resistances.forEach((price) => {
        const y = priceToY(price);
        ctx.save();
        ctx.strokeStyle = "rgba(255, 51, 102, 0.7)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas!.width, y);
        ctx.stroke();
        ctx.restore();
    });
}

/**
 * Selects an asset and switches chart to it.
 */
export function selectStock(symbol: string): void {
    const sym = symbol.toUpperCase();
    store.set("currentAsset", sym);

    const assetTitle = getElement("current-asset-title");
    const activeTickerDisplay = getElement("active-ticker-display");

    safeText(assetTitle, `${sym} Real-Time Chart`);
    safeText(activeTickerDisplay, sym);

    initChart(sym, store.get("currentTimeframe"));
}

/**
 * Confirms a pending AI trade recommendation.
 */
export function confirmTrade(): void {
    const modal = getElement("trade-confirm-modal");
    if (modal) modal.classList.add("hidden");

    const signal = store.get("pendingSignal");
    store.sockets.sendPrimaryAction({
        action: "confirm_trade",
        trade_id: signal && signal.trade_id !== null ? signal.trade_id : undefined
    });
    store.set("pendingSignal", null);

    if (typeof (window as any).logToTerminal === "function") {
        (window as any).logToTerminal("Execution Agent", "Trade confirmed by user. Filling the proposed order...");
    }
}

/**
 * Rejects a pending AI trade recommendation.
 */
export function rejectTrade(): void {
    const modal = getElement("trade-confirm-modal");
    if (modal) modal.classList.add("hidden");

    const signal = store.get("pendingSignal");
    store.sockets.sendPrimaryAction({
        action: "cancel_trade",
        trade_id: signal && signal.trade_id !== null ? signal.trade_id : undefined
    });
    store.set("pendingSignal", null);

    if (typeof (window as any).logToTerminal === "function") {
        (window as any).logToTerminal("Risk Guard", "Trade rejected by user. Safety constraints enforced.");
    }
}

/**
 * Sets up terminal tab listeners and timeframe buttons.
 */
export function initTerminalListeners(): void {
    getElement("menu-btn-dashboard")?.addEventListener("click", () => switchToTab("dashboard"));
    getElement("menu-btn-terminal")?.addEventListener("click", () => switchToTab("terminal"));
    getElement("menu-btn-autotrade")?.addEventListener("click", () => switchToTab("autotrade"));
    getElement("menu-btn-manage-trades")?.addEventListener("click", () => switchToTab("manage-trades"));
    getElement("menu-btn-reports")?.addEventListener("click", () => switchToTab("reports"));
    getElement("menu-btn-copilot")?.addEventListener("click", () => switchToTab("copilot"));
    getElement("menu-btn-strategy-lab")?.addEventListener("click", () => switchToTab("strategy-lab"));

    document.querySelectorAll(".tf-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            const tf = btn.getAttribute("data-tf");
            if (tf) setTimeframe(tf);
        });
    });
}
