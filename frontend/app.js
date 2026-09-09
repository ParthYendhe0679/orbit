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
const menuBtnReports = document.getElementById("menu-btn-reports");

// Content containers
const tabContentOverview = document.getElementById("tab-content-overview");
const tabContentTerminal = document.getElementById("tab-content-terminal");
const tabContentAutotrade = document.getElementById("tab-content-autotrade");
const tabContentReports = document.getElementById("tab-content-reports");

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
        if(menuBtnReports) menuBtnReports.classList.remove("active");
        tabContentOverview.classList.remove("hidden-tab");
        tabContentTerminal.classList.add("hidden-tab");
        if(tabContentAutotrade) tabContentAutotrade.classList.add("hidden-tab");
        if(tabContentReports) tabContentReports.classList.add("hidden-tab");
        contentHeaderTitle.textContent = "Dashboard Overview";
        // Dashboard always shows GLOBAL market news
        fetchGlobalNews();
    } else if (tabName === "terminal") {
        menuBtnTerminal.classList.add("active");
        menuBtnDashboard.classList.remove("active");
        if(menuBtnAutotrade) menuBtnAutotrade.classList.remove("active");
        if(menuBtnReports) menuBtnReports.classList.remove("active");
        tabContentTerminal.classList.remove("hidden-tab");
        tabContentOverview.classList.add("hidden-tab");
        if(tabContentAutotrade) tabContentAutotrade.classList.add("hidden-tab");
        if(tabContentReports) tabContentReports.classList.add("hidden-tab");
        contentHeaderTitle.textContent = "Trade Agent Terminal";
        // TradingView widget uses autosize — no manual resize needed
    } else if (tabName === "autotrade") {
        if(menuBtnAutotrade) menuBtnAutotrade.classList.add("active");
        menuBtnDashboard.classList.remove("active");
        menuBtnTerminal.classList.remove("active");
        if(menuBtnReports) menuBtnReports.classList.remove("active");
        if(tabContentAutotrade) tabContentAutotrade.classList.remove("hidden-tab");
        tabContentTerminal.classList.add("hidden-tab");
        tabContentOverview.classList.add("hidden-tab");
        if(tabContentReports) tabContentReports.classList.add("hidden-tab");
        contentHeaderTitle.textContent = "Auto-Trade Bot Configuration";
        loadBotConfig();
    } else if (tabName === "reports") {
        if(menuBtnReports) menuBtnReports.classList.add("active");
        menuBtnDashboard.classList.remove("active");
        menuBtnTerminal.classList.remove("active");
        if(menuBtnAutotrade) menuBtnAutotrade.classList.remove("active");
        if(tabContentReports) tabContentReports.classList.remove("hidden-tab");
        tabContentOverview.classList.add("hidden-tab");
        tabContentTerminal.classList.add("hidden-tab");
        if(tabContentAutotrade) tabContentAutotrade.classList.add("hidden-tab");
        contentHeaderTitle.textContent = "Trade Reports & Analytics";
        loadReport();
    }
}

menuBtnDashboard.addEventListener("click", () => switchToTab("dashboard"));
menuBtnTerminal.addEventListener("click", () => switchToTab("terminal"));
if (menuBtnAutotrade) {
    menuBtnAutotrade.addEventListener("click", () => switchToTab("autotrade"));
}
if (menuBtnReports) {
    menuBtnReports.addEventListener("click", () => switchToTab("reports"));
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
        launchDemoDirect();
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

