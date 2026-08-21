// Global App Controller for Orbit Trading Terminal

let tvWidget = null;       // TradingView Widget instance
let socket = null;
let currentAsset = "";
let currentUsername = "Trader Account";
let currentUserId = null;   // populated after login — fixes bot-config API calls

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

// Content containers
const tabContentOverview = document.getElementById("tab-content-overview");
const tabContentTerminal = document.getElementById("tab-content-terminal");
const tabContentAutotrade = document.getElementById("tab-content-autotrade");

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
        tabContentOverview.classList.remove("hidden-tab");
        tabContentTerminal.classList.add("hidden-tab");
        if(tabContentAutotrade) tabContentAutotrade.classList.add("hidden-tab");
        contentHeaderTitle.textContent = "Dashboard Overview";
        // Dashboard always shows GLOBAL market news
        fetchGlobalNews();
    } else if (tabName === "terminal") {
        menuBtnTerminal.classList.add("active");
        menuBtnDashboard.classList.remove("active");
        if(menuBtnAutotrade) menuBtnAutotrade.classList.remove("active");
        tabContentTerminal.classList.remove("hidden-tab");
        tabContentOverview.classList.add("hidden-tab");
        if(tabContentAutotrade) tabContentAutotrade.classList.add("hidden-tab");
        contentHeaderTitle.textContent = "Trade Agent Terminal";
        // TradingView widget uses autosize — no manual resize needed
    } else if (tabName === "autotrade") {
        if(menuBtnAutotrade) menuBtnAutotrade.classList.add("active");
        menuBtnDashboard.classList.remove("active");
        menuBtnTerminal.classList.remove("active");
        if(tabContentAutotrade) tabContentAutotrade.classList.remove("hidden-tab");
        tabContentTerminal.classList.add("hidden-tab");
        tabContentOverview.classList.add("hidden-tab");
        contentHeaderTitle.textContent = "Auto-Trade Bot Configuration";
        loadBotConfig();
    }
}

menuBtnDashboard.addEventListener("click", () => switchToTab("dashboard"));
menuBtnTerminal.addEventListener("click", () => switchToTab("terminal"));
if (menuBtnAutotrade) {
    menuBtnAutotrade.addEventListener("click", () => switchToTab("autotrade"));
}

// Auto-Trade Bot Logic
const autotradeSaveBtn = document.getElementById("autotrade-save-btn");
const autotradeStatusText = document.getElementById("autotrade-status-text");

async function loadBotConfig() {
    if (!currentUserId) return;
    try {
        const res = await fetch(`/api/bot-config?user_id=${currentUserId}`);
        const data = await res.json();
        if (data.ok && data.config) {
            document.getElementById("autotrade-assets").value = data.config.assets;
            document.getElementById("autotrade-capital").value = data.config.total_capital;
            document.getElementById("autotrade-min-profit").value = data.config.min_profit_target;
            document.getElementById("autotrade-max-profit").value = data.config.max_profit_target;
            document.getElementById("autotrade-toggle").checked = !!data.config.is_active;
            
            autotradeStatusText.textContent = data.config.is_active ? "Running — scanning market..." : "Currently stopped";
        }
    } catch (e) {
        console.error("Failed to load bot config:", e);
    }
}

if (autotradeSaveBtn) {
    autotradeSaveBtn.addEventListener("click", async () => {
        if (!currentUserId) return;
        
        const maxLoss = parseFloat(document.getElementById("autotrade-max-profit").value);
        const config = {
            user_id: currentUserId,
            assets: document.getElementById("autotrade-assets").value,
            total_capital: parseFloat(document.getElementById("autotrade-capital").value),
            max_risk_per_trade: maxLoss, // Set Max Risk Per Trade to equal overall Max Loss
            min_profit_target: parseFloat(document.getElementById("autotrade-min-profit").value),
            max_profit_target: maxLoss,
            is_active: document.getElementById("autotrade-toggle").checked
        };
        
        const originalBtnText = autotradeSaveBtn.innerHTML;
        autotradeSaveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        
        try {
            const res = await fetch("/api/bot-config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(config)
            });
            const data = await res.json();
            if (data.ok) {
                autotradeStatusText.textContent = config.is_active ? "Running — scanning market..." : "Currently stopped";
                setTimeout(() => { autotradeSaveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Saved!'; }, 500);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setTimeout(() => { autotradeSaveBtn.innerHTML = originalBtnText; }, 2000);
        }
    });
}

// Smooth scroll to login section
function scrollToLogin() {
    if (loginSection) {
        loginSection.scrollIntoView({ behavior: 'smooth' });
    }
}

navLoginBtn.addEventListener("click", scrollToLogin);
getStartedBtn.addEventListener("click", scrollToLogin);

// -------------------------------------------------------------
//   AUTHENTICATION & PORTAL LOGIC (Login / Sign Up / OTP)
// -------------------------------------------------------------

let resendTimer = null;
let resendCooldown = 0;
let currentOtpEmail = "";

// Helper to transition into the dashboard
function enterDashboard(username, userId) {
    currentUsername = username || "Trader Account";
    currentUserId = userId || null;
    safeText(dashboardUser, currentUsername);
    localStorage.setItem("orbit_logged_in_username", currentUsername);
    if (userId) localStorage.setItem("orbit_user_id", String(userId));

    // Stop 3D WebGL background to save GPU cycles
    if (window.aether3D) window.aether3D.stop();

    // Hide landing wrapper & show dashboard
    landingPage.classList.add("hidden");
    dashboardPage.classList.remove("hidden");

    // Scroll window back to top
    window.scrollTo(0, 0);

    // Initialize connection immediately to sync DB stats and open default tab
    setTimeout(() => {
        connectWebSocket();
        switchToTab("dashboard");
    }, 100);
}

// Switch between panels (login, signup, otp)
function switchAuthTab(tab) {
    const tabLoginBtn = document.getElementById("tab-login-btn");
    const tabSignupBtn = document.getElementById("tab-signup-btn");
    const panelLogin = document.getElementById("panel-login");
    const panelSignup = document.getElementById("panel-signup");
    const panelOtp = document.getElementById("panel-otp");
    const authTabs = document.getElementById("auth-tabs");
    const cardTitle = document.getElementById("auth-card-title");
    const cardSubtitle = document.getElementById("auth-card-subtitle");

    // Hide any showing error messages
    document.getElementById("login-error").classList.add("hidden");
    document.getElementById("signup-error").classList.add("hidden");
    document.getElementById("otp-error").classList.add("hidden");

    // Remove active classes
    panelLogin.classList.remove("active");
    panelSignup.classList.remove("active");
    panelOtp.classList.remove("active");
    authTabs.style.display = "flex";

    if (tab === "login") {
        tabLoginBtn.classList.add("active");
        tabSignupBtn.classList.remove("active");
        panelLogin.classList.add("active");
        safeText(cardTitle, "Terminal Access");
        safeText(cardSubtitle, "Sign in to unlock the trading console");
    } else if (tab === "signup") {
        tabLoginBtn.classList.remove("active");
        tabSignupBtn.classList.add("active");
        panelSignup.classList.add("active");
        safeText(cardTitle, "Create Account");
        safeText(cardSubtitle, "Sign up to begin agent-based trading");
    } else if (tab === "otp") {
        authTabs.style.display = "none";
        panelOtp.classList.add("active");
        safeText(cardTitle, "Verify Email");
        safeText(cardSubtitle, "Enter the verification code sent to your email");
        // Focus first OTP field
        setTimeout(() => {
            const firstDigit = document.getElementById("otp-d1");
            if (firstDigit) firstDigit.focus();
        }, 150);
    }
}

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

// Advance focus on OTP entry
function otpInputNext(current, nextId) {
    if (current.value.length >= 1) {
        if (nextId) {
            const nextEl = document.getElementById(nextId);
            if (nextEl) nextEl.focus();
        }
    }
}

// Backspace focus on OTP entry
function otpInputBack(event, current, prevId) {
    if (event.key === "Backspace") {
        if (!current.value && prevId) {
            const prevEl = document.getElementById(prevId);
            if (prevEl) {
                prevEl.focus();
                prevEl.value = "";
            }
        }
    }
}

// Start Resend OTP Cooldown timer
function startOtpTimer(duration) {
    resendCooldown = duration;
    const timerText = document.getElementById("otp-timer-text");
    const resendBtn = document.getElementById("otp-resend-btn");

    resendBtn.classList.add("hidden");
    timerText.style.display = "inline";

    if (resendTimer) clearInterval(resendTimer);

    resendTimer = setInterval(() => {
        if (resendCooldown <= 0) {
            clearInterval(resendTimer);
            timerText.style.display = "none";
            resendBtn.classList.remove("hidden");
        } else {
            timerText.textContent = `Resend in ${resendCooldown}s`;
            resendCooldown--;
        }
    }, 1000);
}

// Handle login submission
async function handleLogin(event) {
    event.preventDefault();
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;
    const errorEl = document.getElementById("login-error");
    const submitBtn = document.getElementById("login-submit-btn");

    errorEl.classList.add("hidden");
    submitBtn.disabled = true;

    try {
        const response = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (response.ok) {
            // Success - enter dashboard (pass user_id if backend returns it)
            enterDashboard(data.username, data.user_id || data.id || null);
        } else if (response.status === 403) {
            // Unverified user - redirect to OTP
            // The 403 body carries the address in detail.email; falling back to
            // the username posted a non-email to /api/verify-otp.
            const detail = data.detail;
            const userEmail = (detail && detail.email) || data.email || username;
            currentOtpEmail = userEmail;
            document.getElementById("otp-email-display").textContent = currentOtpEmail;
            switchAuthTab("otp");
            startOtpTimer(60);
        } else {
            errorEl.textContent = (typeof data.detail === "string" ? data.detail : data.detail && data.detail.message) || "Invalid credentials.";
            errorEl.classList.remove("hidden");
        }
    } catch (err) {
        console.error("Login request error:", err);
        errorEl.textContent = "Network error. Make sure backend is running.";
        errorEl.classList.remove("hidden");
    } finally {
        submitBtn.disabled = false;
    }
}

// Handle registration submission
async function handleSignup(event) {
    event.preventDefault();
    const email = document.getElementById("signup-email").value.trim();
    const username = document.getElementById("signup-username").value.trim();
    const password = document.getElementById("signup-password").value;
    const confirm = document.getElementById("signup-confirm").value;
    const errorEl = document.getElementById("signup-error");
    const submitBtn = document.getElementById("signup-submit-btn");

    errorEl.classList.add("hidden");

    if (password !== confirm) {
        errorEl.textContent = "Passwords do not match.";
        errorEl.classList.remove("hidden");
        return;
    }

    submitBtn.disabled = true;

    try {
        const response = await fetch("/api/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, email, password })
        });

        const data = await response.json();

        if (response.ok) {
            currentOtpEmail = email;
            document.getElementById("otp-email-display").textContent = email;
            switchAuthTab("otp");
            startOtpTimer(60);
        } else {
            errorEl.textContent = data.detail || "Registration failed.";
            errorEl.classList.remove("hidden");
        }
    } catch (err) {
        console.error("Signup error:", err);
        errorEl.textContent = "Connection error. Please try again.";
        errorEl.classList.remove("hidden");
    } finally {
        submitBtn.disabled = false;
    }
}

// Handle verification code submission
async function handleVerifyOtp(event) {
    event.preventDefault();
    const digits = [
        document.getElementById("otp-d1").value,
        document.getElementById("otp-d2").value,
        document.getElementById("otp-d3").value,
        document.getElementById("otp-d4").value,
        document.getElementById("otp-d5").value,
        document.getElementById("otp-d6").value
    ];
    const otp = digits.join("").trim();
    const errorEl = document.getElementById("otp-error");
    const submitBtn = document.getElementById("otp-submit-btn");

    errorEl.classList.add("hidden");

    if (otp.length < 6) {
        errorEl.textContent = "Please fill in all 6 digits.";
        errorEl.classList.remove("hidden");
        return;
    }

    submitBtn.disabled = true;

    try {
        const response = await fetch("/api/verify-otp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: currentOtpEmail, otp })
        });

        const data = await response.json();

        if (response.ok) {
            // Authenticate and proceed
            enterDashboard(data.username, data.user_id || data.id || null);
        } else {
            errorEl.textContent = data.detail || "Invalid or expired code.";
            errorEl.classList.remove("hidden");
        }
    } catch (err) {
        console.error("Verification error:", err);
        errorEl.textContent = "Verification failed. Check network connection.";
        errorEl.classList.remove("hidden");
    } finally {
        submitBtn.disabled = false;
    }
}

// Handle OTP resend click
async function handleResendOtp() {
    const errorEl = document.getElementById("otp-error");
    errorEl.classList.add("hidden");

    try {
        const response = await fetch("/api/resend-otp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: currentOtpEmail })
        });

        const data = await response.json();

        if (response.ok) {
            startOtpTimer(60);
            alert("A new verification code has been sent!");
        } else {
            errorEl.textContent = data.detail || "Failed to resend code.";
            errorEl.classList.remove("hidden");
        }
    } catch (err) {
        console.error("Resend error:", err);
        errorEl.textContent = "Could not contact verification server.";
        errorEl.classList.remove("hidden");
    }
}

// Bind methods to window so inline onclick attributes resolve properly
window.switchAuthTab = switchAuthTab;
window.togglePw = togglePw;
window.otpInputNext = otpInputNext;
window.otpInputBack = otpInputBack;
window.handleSignup = handleSignup;
window.handleLogin = handleLogin;
window.handleVerifyOtp = handleVerifyOtp;
window.handleResendOtp = handleResendOtp;


// Logout Button
logoutBtn.addEventListener("click", () => {
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
        toolbar_bg: "#0f1015",
        enable_publishing: false,
        allow_symbol_change: true,
        hide_side_toolbar: false,
        withdateranges: true,
        save_image: false,
        details: false,
        show_popup_button: true,
        popup_width: "1200",
        popup_height: "800",
        backgroundColor: "#0f1015",
        gridColor: "rgba(42,46,57,0.3)",
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
        ctx.fillStyle = isSupport ? "rgba(0, 230, 118, 0.06)" : "rgba(255, 64, 96, 0.06)";
        ctx.fillRect(0, yTop, canvas.width, h);

        // Draw dashed outlines for the zone boundary
        ctx.strokeStyle = isSupport ? "rgba(0, 230, 118, 0.35)" : "rgba(255, 64, 96, 0.35)";
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
        drawPillLabel(label, canvas.width, y, isSupport ? "#00e676" : "#ff4060", "#000");
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
        greenGrad.addColorStop(0, "rgba(0,255,102,0.20)");
        greenGrad.addColorStop(1, "rgba(0,255,102,0.03)");
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
            ctx.fillStyle = "rgba(0,255,102,0.18)";
            ctx.beginPath();
            ctx.roundRect(6, midY - 9, tw, 17, 4);
            ctx.fill();
            ctx.fillStyle = "#00ff66";
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
        redGrad.addColorStop(0, "rgba(255,51,102,0.03)");
        redGrad.addColorStop(1, "rgba(255,51,102,0.22)");
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
            ctx.fillStyle = "rgba(255,51,102,0.18)";
            ctx.beginPath();
            ctx.roundRect(6, midY - 9, tw, 17, 4);
            ctx.fill();
            ctx.fillStyle = "#ff3366";
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
        ctx.strokeStyle = "#c77dff";
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.75;
        ctx.moveTo(canvas.width - 130, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();

        // Draw a small "$$$" badge to represent liquidity pool
        ctx.fillStyle = "rgba(199, 125, 255, 0.15)";
        ctx.beginPath();
        ctx.roundRect(canvas.width - 165, y - 8, 30, 16, 4);
        ctx.fill();
        ctx.fillStyle = "#c77dff";
        ctx.font = "bold 10px monospace";
        ctx.textAlign = "center";
        ctx.fillText("$$$", canvas.width - 150, y + 4);
        ctx.restore();

        // Draw standard price tag on the far right
        drawPillLabel(`LIQ ${p.toFixed(2)}`, canvas.width, y, "#c77dff", "#000");
    });

    // ─────────────────────────────────────────────
    //  STEP 4: Signal lines (topmost — solid + thick)
    // ─────────────────────────────────────────────
    if (entryPrice) drawLine(entryPrice, "#00f0ff", [], `● ENTRY   ${entryPrice.toFixed(2)}`, 2.5);
    if (targetPrice) drawLine(targetPrice, "#00ff66", [4, 3], `▲ TARGET  ${targetPrice.toFixed(2)}`, 2.0);
    if (slPrice) drawLine(slPrice, "#ff3366", [4, 3], `▼ SL      ${slPrice.toFixed(2)}`, 2.0);
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
// Use rAF-based scroll instead of setInterval to avoid blocking the main thread
let _newsScrollRAF = null;
let _newsScrollEl = null;
let _newsIsPaused = false;

function _newsRAFScroll() {
    if (_newsScrollEl && !_newsIsPaused) {
        _newsScrollEl.scrollTop += 0.5;
        const mid = _newsScrollEl.scrollHeight / 2;
        if (_newsScrollEl.scrollTop >= mid) _newsScrollEl.scrollTop = 0;
    }
    _newsScrollRAF = requestAnimationFrame(_newsRAFScroll);
}

function stopNewsScroll() {
    if (_newsScrollRAF) { cancelAnimationFrame(_newsScrollRAF); _newsScrollRAF = null; }
    _newsScrollEl = null;
}

async function fetchGlobalNews() {
    const dashEl = document.getElementById("news-feed-container");
    const dashLabel = document.getElementById("news-symbol-label");
    if (dashLabel) dashLabel.textContent = "Global Markets";
    if (!dashEl) return;

    // Cancel any running scroll animation
    stopNewsScroll();
    dashEl.scrollTop = 0;

    dashEl.innerHTML = `<div class="news-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading world market news…</div>`;

    try {
        const response = await fetch("/api/news/global");
        const data = await response.json();

        if (!data.headlines || data.headlines.length === 0) {
            dashEl.innerHTML = `<div class="news-loading">No global headlines available right now.</div>`;
            return;
        }

        // Build fragment off-DOM to avoid layout thrash
        const frag = document.createDocumentFragment();
        data.headlines.forEach(item => {
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

        dashEl.innerHTML = "";
        dashEl.appendChild(frag);

        // Seamless loop: duplicate the content once
        if (data.headlines.length > 2) {
            dashEl.innerHTML += dashEl.innerHTML;

            dashEl.addEventListener("mouseenter", () => { _newsIsPaused = true; }, { passive: true });
            dashEl.addEventListener("mouseleave", () => { _newsIsPaused = false; }, { passive: true });

            _newsScrollEl = dashEl;
            _newsIsPaused = false;
            _newsScrollRAF = requestAnimationFrame(_newsRAFScroll);
        }

    } catch (err) {
        console.error("Error fetching global news:", err);
        if (dashEl) dashEl.innerHTML = `<div class="news-loading">⚠️ Could not load world market news.</div>`;
    }
}

// ── Stock-specific news for the Trading Terminal vertical scroll ──
async function fetchNews(symbol) {
    // Only populates the trading terminal vertical scroll
    const scrollEl = document.getElementById("atv-news-scroll");
    if (!scrollEl) return;

    scrollEl.innerHTML = `<span class="news-ticker-loading">📡 Fetching news for ${symbol}…</span>`;
    scrollEl.style.animation = "none";

    try {
        const response = await fetch(`/api/news?symbol=${encodeURIComponent(symbol)}`);
        const data = await response.json();

        if (!data.headlines || data.headlines.length === 0) {
            scrollEl.innerHTML = `<span class="news-ticker-loading">No news found for ${symbol}.</span>`;
            return;
        }

        scrollEl.innerHTML = "";
        data.headlines.forEach(item => {
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

        // Duplicate for seamless loop
        scrollEl.innerHTML += scrollEl.innerHTML;

        // ~8px per second — very slow, easy to read
        const duration = Math.max(60, Math.floor(scrollEl.scrollHeight / 8));
        scrollEl.style.animation = `newsScrollUp ${duration}s linear infinite`;

    } catch (err) {
        console.error("Error fetching news:", err);
        scrollEl.innerHTML = `<span class="news-ticker-loading">⚠️ Could not load news for ${symbol}.</span>`;
    }
}


// Update Overview Tab stats and distributions
function updateOverviewMetrics(data) {
    if (data.consensus) {
        const statusEl = document.getElementById("overview-consensus-status");
        statusEl.textContent = data.consensus.signal.toUpperCase();
        statusEl.className = data.consensus.signal === "buy" ? "text-green" : data.consensus.signal === "sell" ? "text-red" : "text-blue";
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
    const wins = settledTrades.filter(t => t.pnl > 0).length;
    const losses = settledTrades.filter(t => t.pnl <= 0).length;

    const winRate = settledTrades.length > 0 ? (wins / settledTrades.length) * 100 : 0.0;
    document.getElementById("overview-win-rate").textContent = `${winRate.toFixed(1)}%`;

    // Win Rate progress bar fill
    const barFill = document.getElementById("overview-winrate-bar");
    if (barFill) {
        barFill.style.width = `${winRate}%`;
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
                const pnl = trade.pnl || 0;
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
                        <div class="chi-asset">${esc(trade.asset || "—")}</div>
                        <div class="chi-time">${timeStr}</div>
                    </div>
                    <span class="chi-pnl ${pnlColor}">${pnlStr}</span>
                    <span class="chi-outcome ${outcomeClass}">${outcomeLabel}</span>`;
                historyList.appendChild(item);
            });
        }
    }
}

// WebSocket Connection Setup
let _wsReconnectAttempts = 0;
let _wsReconnectTimer = null;
let _wsIntentionallyClosed = false;

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

            case "tick":
                // Update legend price display
                if (data.candle) {
                    updateLegend(data.candle.close, data.changePercent || 0);
                }
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

            case "wallet": {
                const fmt = formatINR(data.balance);
                if (walletBalanceEl) walletBalanceEl.textContent = fmt;
                const ob = document.getElementById("overview-balance");
                if (ob) ob.textContent = fmt;
                break;
            }

            case "positions":
                updatePositionsTable(data.positions);
                updateOverviewPositionsStats(data.positions);

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

// Auto-login on page refresh if previously logged in
document.addEventListener("DOMContentLoaded", () => {
    const savedUsername = localStorage.getItem("orbit_logged_in_username");
    const savedUserId = localStorage.getItem("orbit_user_id");
    // Without a user id the socket cannot authenticate, so treat a half-stored
    // session as logged out rather than dropping into a dead dashboard.
    if (savedUsername && savedUserId) {
        // Delay slightly to let standard scripts / 3D backgrounds load
        setTimeout(() => {
            enterDashboard(savedUsername, parseInt(savedUserId, 10));
        }, 200);
    } else if (savedUsername) {
        localStorage.removeItem("orbit_logged_in_username");
    }
});

// Redraw chart overlay on window resize (canvas dimensions go stale otherwise)
let _overlayResizeTimer = null;
window.addEventListener("resize", () => {
    clearTimeout(_overlayResizeTimer);
    _overlayResizeTimer = setTimeout(() => {
        drawChartOverlay();
    }, 120);
});
