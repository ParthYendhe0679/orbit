"use strict";
(() => {
  // src/websocket/socketManager.ts
  var SocketManager = class {
    primarySocket = null;
    streamSocket = null;
    primaryReconnectTimer = null;
    streamReconnectTimer = null;
    intentionallyClosed = false;
    reconnectAttempts = 0;
    maxReconnectAttempts = 30;
    listeners = /* @__PURE__ */ new Map();
    currentUserId = null;
    currentUsername = null;
    constructor() {
      this.listeners.set("all", /* @__PURE__ */ new Set());
    }
    on(event, listener) {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, /* @__PURE__ */ new Set());
      }
      const set = this.listeners.get(event);
      set.add(listener);
      return () => set.delete(listener);
    }
    emit(event, message) {
      const specific = this.listeners.get(event);
      if (specific) {
        specific.forEach((cb) => {
          try {
            cb(message);
          } catch (err) {
            console.error(`[WS emit error ${event}]:`, err);
          }
        });
      }
      const all = this.listeners.get("all");
      if (all) {
        all.forEach((cb) => {
          try {
            cb(message);
          } catch (err) {
            console.error("[WS emit all error]:", err);
          }
        });
      }
    }
    connect(userId, username) {
      this.currentUserId = userId;
      this.currentUsername = username;
      this.intentionallyClosed = false;
      this.connectPrimary();
      this.connectStreamHub();
    }
    disconnect() {
      this.intentionallyClosed = true;
      if (this.primaryReconnectTimer) {
        clearTimeout(this.primaryReconnectTimer);
        this.primaryReconnectTimer = null;
      }
      if (this.streamReconnectTimer) {
        clearTimeout(this.streamReconnectTimer);
        this.streamReconnectTimer = null;
      }
      if (this.primarySocket) {
        try {
          if (this.primarySocket.readyState === WebSocket.OPEN) {
            this.primarySocket.send(JSON.stringify({ action: "stop" }));
          }
          this.primarySocket.close();
        } catch {
        }
        this.primarySocket = null;
      }
      if (this.streamSocket) {
        try {
          this.streamSocket.close();
        } catch {
        }
        this.streamSocket = null;
      }
      this.reconnectAttempts = 0;
    }
    send(action) {
      if (this.primarySocket && this.primarySocket.readyState === WebSocket.OPEN) {
        try {
          this.primarySocket.send(JSON.stringify(action));
          return true;
        } catch (err) {
          console.warn("[WS send error]:", err);
        }
      }
      return false;
    }
    sendPrimaryAction(action) {
      return this.send(action);
    }
    connectPrimary() {
      if (!this.currentUserId) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.hostname || "127.0.0.1";
      const wsUrl = `${protocol}//${host}:8000/ws?user_id=${encodeURIComponent(this.currentUserId)}&username=${encodeURIComponent(this.currentUsername || "Trader")}`;
      try {
        this.primarySocket = new WebSocket(wsUrl);
      } catch (err) {
        console.warn("[WS connect error]:", err);
        this.schedulePrimaryReconnect();
        return;
      }
      this.primarySocket.onopen = () => {
        console.log("[WS] Connected to primary ORBIT engine");
        this.reconnectAttempts = 0;
      };
      this.primarySocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (!data || !data.type) return;
          if ((data.type === "tick" || data.type === "price_update") && this.isStreamHubOpen()) {
            return;
          }
          this.emit(data.type, data);
        } catch (parseErr) {
          console.warn("[WS message parse error]:", parseErr);
        }
      };
      this.primarySocket.onclose = () => {
        if (this.intentionallyClosed) return;
        this.schedulePrimaryReconnect();
      };
      this.primarySocket.onerror = (err) => {
        console.warn("[WS primary error]:", err);
      };
    }
    schedulePrimaryReconnect() {
      if (this.intentionallyClosed) return;
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        console.warn("[WS] Max reconnect attempts reached");
        return;
      }
      const delay = Math.min(1e3 * Math.pow(1.5, this.reconnectAttempts), 1e4);
      this.reconnectAttempts++;
      if (this.primaryReconnectTimer) clearTimeout(this.primaryReconnectTimer);
      this.primaryReconnectTimer = window.setTimeout(() => {
        this.connectPrimary();
      }, delay);
    }
    connectStreamHub() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.hostname || "127.0.0.1";
      const hubUrl = `${protocol}//${host}:8001/ws`;
      try {
        this.streamSocket = new WebSocket(hubUrl);
      } catch {
        return;
      }
      this.streamSocket.onopen = () => {
        console.log("[orbit-stream] Go hub connected \u2014 high-frequency tick stream active");
      };
      this.streamSocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (!data || !data.type) return;
          if (data.type === "tick" || data.type === "metrics") {
            this.emit(data.type, data);
          }
        } catch {
        }
      };
      this.streamSocket.onclose = () => {
        if (this.intentionallyClosed) return;
        if (this.streamReconnectTimer) clearTimeout(this.streamReconnectTimer);
        this.streamReconnectTimer = window.setTimeout(() => {
          this.connectStreamHub();
        }, 3e3);
      };
      this.streamSocket.onerror = () => {
      };
    }
    isPrimaryOpen() {
      return !!this.primarySocket && this.primarySocket.readyState === WebSocket.OPEN;
    }
    isStreamHubOpen() {
      return !!this.streamSocket && this.streamSocket.readyState === WebSocket.OPEN;
    }
  };
  var socketManager = new SocketManager();

  // src/state/store.ts
  var StateStore = class {
    state;
    listeners = /* @__PURE__ */ new Map();
    sockets;
    constructor() {
      this.sockets = socketManager;
      let savedUserId = null;
      let savedUsername = null;
      try {
        if (typeof localStorage !== "undefined") {
          savedUserId = localStorage.getItem("orbit_user_id");
          savedUsername = localStorage.getItem("orbit_username");
        }
      } catch {
      }
      this.state = {
        currentAsset: "BTC-USD",
        currentTimeframe: "1d",
        currentUsername: savedUsername || "Trader Account",
        currentUserId: savedUserId ? isNaN(Number(savedUserId)) ? savedUserId : Number(savedUserId) : null,
        walletBalance: 1e5,
        openTrades: [],
        pendingOrders: [],
        tradeHistory: [],
        historyPage: 0,
        totalHistoryPages: 1,
        activeManageTrade: null,
        closeSelectedPct: 50,
        showSRLevels: false,
        botRunning: false,
        dashboardSummary: null
      };
    }
    get(key) {
      return this.state[key];
    }
    getAll() {
      return this.state;
    }
    set(key, value) {
      const prev = this.state[key];
      if (prev === value) return;
      this.state[key] = value;
      if (key === "currentUserId") {
        try {
          if (value !== null && typeof localStorage !== "undefined") {
            localStorage.setItem("orbit_user_id", String(value));
          }
        } catch {
        }
      }
      if (key === "currentUsername") {
        try {
          if (value && typeof localStorage !== "undefined") {
            localStorage.setItem("orbit_username", String(value));
          }
        } catch {
        }
      }
      const keyListeners = this.listeners.get(key);
      if (keyListeners) {
        keyListeners.forEach((listener) => {
          try {
            listener(value, this.state);
          } catch (err) {
            console.error(`[StateStore] Error in listener for "${key}":`, err);
          }
        });
      }
    }
    subscribe(key, listener) {
      if (!this.listeners.has(key)) {
        this.listeners.set(key, /* @__PURE__ */ new Set());
      }
      this.listeners.get(key).add(listener);
      return () => {
        const set = this.listeners.get(key);
        if (set) set.delete(listener);
      };
    }
  };
  var store = new StateStore();

  // src/utils/formatters.ts
  function esc(value) {
    if (value === null || value === void 0) return "";
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function formatINR(number) {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 2
    }).format(number);
  }
  function formatCopilotMarkdown(raw) {
    if (!raw) return "";
    let formatted = esc(raw);
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    formatted = formatted.replace(/\*(.*?)\*/g, "<em>$1</em>");
    formatted = formatted.replace(/`([^`]+)`/g, '<code class="copilot-inline-code">$1</code>');
    formatted = formatted.replace(/^[\*\-]\s+(.+)$/gm, '<li class="copilot-bullet-item">$1</li>');
    formatted = formatted.replace(/^\d+\.\s+(.+)$/gm, '<li class="copilot-numbered-item">$1</li>');
    formatted = formatted.replace(/(<li class="copilot-bullet-item">.*?<\/li>)+/gs, '<ul class="copilot-list">$&</ul>');
    formatted = formatted.replace(/(<li class="copilot-numbered-item">.*?<\/li>)+/gs, '<ol class="copilot-list">$&</ol>');
    formatted = formatted.replace(/\n\n/g, "<br><br>");
    return formatted;
  }

  // src/utils/dom.ts
  function safeText(el, val) {
    if (el) el.textContent = String(val);
  }
  function getElement(id) {
    return document.getElementById(id);
  }

  // src/services/apiClient.ts
  var ApiError = class extends Error {
    constructor(status, message, data) {
      super(message);
      this.status = status;
      this.message = message;
      this.data = data;
      this.name = "ApiError";
    }
    status;
    message;
    data;
  };
  async function request(endpoint, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && typeof options.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const config = {
      ...options,
      headers
    };
    try {
      const response = await fetch(endpoint, config);
      if (!response.ok) {
        let errorDetail = `Request failed with status ${response.status}`;
        let errorData = null;
        try {
          errorData = await response.json();
          if (errorData && typeof errorData === "object" && "detail" in errorData) {
            errorDetail = String(errorData.detail);
          }
        } catch {
        }
        throw new ApiError(response.status, errorDetail, errorData);
      }
      return await response.json();
    } catch (err) {
      if (err instanceof ApiError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : "Network connection error";
      throw new ApiError(0, message);
    }
  }
  var apiClient = {
    get: (url, headers) => request(url, { method: "GET", headers }),
    post: (url, body, headers) => request(url, {
      method: "POST",
      headers,
      body: body !== void 0 ? JSON.stringify(body) : void 0
    }),
    delete: (url, headers) => request(url, { method: "DELETE", headers })
  };

  // src/services/authService.ts
  var authService = {
    async syncClerkUser(req) {
      return apiClient.post("/api/auth/sync", req);
    },
    async getClerkConfig() {
      return apiClient.get("/api/auth/config");
    },
    async login(credentials) {
      return apiClient.post("/api/login", credentials);
    },
    async register(credentials) {
      return apiClient.post("/api/register", credentials);
    }
  };

  // src/ui/authController.ts
  var clerkInstance = null;
  var isClerkActive = false;
  var clerkInitPromise = null;
  var _clerkSyncInFlight = null;
  function clerkAppUrl(hash) {
    return window.location.origin + window.location.pathname + (hash || "");
  }
  function showAuthError(message) {
    const el = document.getElementById("login-error") || document.getElementById("signup-error");
    if (el) {
      el.textContent = message;
      el.classList.remove("hidden");
    }
    const loginSection = document.getElementById("login-section");
    if (loginSection) loginSection.scrollIntoView({ behavior: "smooth" });
  }
  function clerkHasOAuthAttempt(client) {
    const signIn = client && client.signIn;
    const signUp = client && client.signUp;
    const ffv = signIn && signIn.firstFactorVerification;
    const ext = signUp && signUp.verifications && signUp.verifications.externalAccount;
    return !!(signIn && signIn.status || ffv && ffv.status || signUp && signUp.status || ext && ext.status);
  }
  function clerkOAuthDiagnosis(client) {
    const parts = [];
    const describe = (label, status, err) => {
      if (!status && !err) return;
      let text = label + ": " + (status || "none");
      if (err) text += " \u2014 " + (err.longMessage || err.message || "") + (err.code ? " [" + err.code + "]" : "");
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
      const ext = signUp.verifications && signUp.verifications.externalAccount || {};
      describe("sign-up", signUp.status, null);
      describe("Google account", ext.status, ext.error);
    }
    return parts.join("; ");
  }
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
          pubKey = "pk_test_aGlwLWNhbWVsLTk3ODQuY2xlcmsuYWNjb3VudHMuZGV2JA";
        }
        const clerkScript = document.querySelector('script[src*="clerk"]');
        if (clerkScript && !clerkScript.getAttribute("data-clerk-publishable-key")) {
          clerkScript.setAttribute("data-clerk-publishable-key", pubKey);
        }
        let attempts = 0;
        while (!window.Clerk && attempts < 40) {
          await new Promise((r) => setTimeout(r, 100));
          attempts++;
        }
        if (window.Clerk) {
          const loadOptions = {
            publishableKey: pubKey,
            routerPush: clerkRouterNavigate,
            routerReplace: clerkRouterNavigate
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
          const oauthStartedAt = Number(sessionStorage.getItem("orbit_oauth_in_progress") || 0);
          const oauthFresh = oauthStartedAt > 1 && Date.now() - oauthStartedAt < 15 * 60 * 1e3;
          const returningFromOAuth = (oauthFresh || window.location.hash.includes("sso-callback")) && clerkHasOAuthAttempt(clerkInstance.client);
          if (!returningFromOAuth) {
            sessionStorage.removeItem("orbit_oauth_in_progress");
            if (window.location.hash.includes("sso-")) {
              history.replaceState(null, "", window.location.pathname + window.location.search);
            }
          }
          if (typeof clerkInstance.addListener === "function") {
            clerkInstance.addListener(async (state) => {
              if (state && state.user && state.session) {
                if (!store.get("currentUserId") || !document.body.classList.contains("in-dashboard")) {
                  await syncClerkUserAndEnter(state.user);
                }
              }
            });
          }
          if (returningFromOAuth && !clerkInstance.session && typeof clerkInstance.handleRedirectCallback === "function") {
            const dashboardUrl = clerkAppUrl("#dashboard");
            const hereUrl = clerkAppUrl("#login");
            let unsupportedStep = null;
            try {
              await clerkInstance.handleRedirectCallback({
                signInForceRedirectUrl: dashboardUrl,
                signUpForceRedirectUrl: dashboardUrl,
                signInFallbackRedirectUrl: dashboardUrl,
                signUpFallbackRedirectUrl: dashboardUrl,
                signInUrl: hereUrl,
                signUpUrl: hereUrl,
                continueSignUpUrl: clerkAppUrl("#sso-continue"),
                firstFactorUrl: clerkAppUrl("#sso-factor-one"),
                secondFactorUrl: clerkAppUrl("#sso-factor-two"),
                resetPasswordUrl: clerkAppUrl("#sso-reset-password")
              }, (to) => {
                const url = new URL(to, window.location.href);
                if (url.origin === window.location.origin && url.hash !== "#dashboard") {
                  unsupportedStep = url.hash.replace("#", "");
                }
                clerkRouterNavigate(to);
              });
            } catch (cbErr) {
              console.warn("[Orbit Auth] Clerk redirect callback:", cbErr);
              const detail = cbErr && cbErr.errors && cbErr.errors[0] && (cbErr.errors[0].longMessage || cbErr.errors[0].message) || cbErr && cbErr.message || String(cbErr);
              showAuthError("Google sign-in could not be completed: " + detail);
            }
            if (!clerkInstance.session) {
              sessionStorage.removeItem("orbit_oauth_in_progress");
              const signUp = clerkInstance.client && clerkInstance.client.signUp;
              const diagnosis = clerkOAuthDiagnosis(clerkInstance.client);
              console.warn("[Orbit Auth] Google sign-in did not finish:", diagnosis || "no details", "| Clerk next step:", unsupportedStep);
              if (signUp && signUp.status === "missing_requirements") {
                showAuthError("Google sign-up needs more details (" + (signUp.missingFields || []).join(", ") + "). Adjust the required fields in the Clerk dashboard or sign up with email.");
              } else {
                const errEl = document.getElementById("login-error");
                if (!errEl || errEl.classList.contains("hidden")) {
                  showAuthError("Google sign-in did not finish (" + (diagnosis || "Clerk returned no details") + "). Please try again.");
                }
              }
              if (window.location.hash.includes("sso-")) {
                history.replaceState(null, "", window.location.pathname + window.location.search);
              }
            }
          }
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
  function syncClerkUserAndEnter(u) {
    if (!_clerkSyncInFlight) {
      _clerkSyncInFlight = _syncClerkUserAndEnter(u).finally(() => {
        _clerkSyncInFlight = null;
      });
    }
    return _clerkSyncInFlight;
  }
  async function _syncClerkUserAndEnter(u) {
    if (!u) return false;
    const userEmail = u.primaryEmailAddress && u.primaryEmailAddress.emailAddress || u.emailAddresses && u.emailAddresses[0] && u.emailAddresses[0].emailAddress || "";
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
      const data = await authService.syncClerkUser({
        email: userEmail,
        username: displayName,
        clerk_id: u.id
      });
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
    showAuthError("Signed in with Google, but your trading account could not be loaded. Please try again.");
    return false;
  }
  function enterDashboard(username, userId) {
    const finalUsername = username || "Trader Account";
    const finalUserId = userId || null;
    store.set("currentUsername", finalUsername);
    store.set("currentUserId", finalUserId);
    safeText(getElement("dashboard-user"), finalUsername);
    localStorage.setItem("orbit_logged_in_username", finalUsername);
    if (finalUserId) localStorage.setItem("orbit_user_id", String(finalUserId));
    window.location.hash = "#dashboard";
    document.body.classList.add("in-dashboard");
    if (window.aether3D && typeof window.aether3D.stop === "function") {
      window.aether3D.stop();
    }
    const threeCanvas = getElement("three-canvas");
    if (threeCanvas) {
      threeCanvas.style.display = "none";
    }
    const landingPage = getElement("landing-page");
    const dashboardPage = getElement("dashboard-page");
    if (landingPage) {
      landingPage.classList.add("hidden");
      landingPage.style.display = "none";
    }
    if (dashboardPage) {
      dashboardPage.classList.remove("hidden");
      dashboardPage.style.display = "block";
    }
    window.scrollTo(0, 0);
    setTimeout(() => {
      store.sockets.connect(finalUserId || 1, finalUsername);
      if (typeof window.switchToTab === "function") {
        window.switchToTab("dashboard");
      }
      if (typeof window.fetchGlobalNews === "function") {
        window.fetchGlobalNews();
      }
      if (typeof window.refreshAllData === "function") {
        window.refreshAllData();
      }
    }, 50);
  }
  function launchDemoDirect() {
    enterDashboard("Demo Trader", 1);
  }
  function scrollToLogin() {
    const landingPage = getElement("landing-page");
    const dashboardPage = getElement("dashboard-page");
    const loginSection = getElement("login-section");
    if (landingPage && landingPage.classList.contains("hidden")) {
      landingPage.classList.remove("hidden");
    }
    if (dashboardPage && !dashboardPage.classList.contains("hidden")) {
      dashboardPage.classList.add("hidden");
    }
    if (loginSection) {
      loginSection.scrollIntoView({ behavior: "smooth" });
    }
  }
  function switchAuthTab(tab) {
    const tabLoginBtn = getElement("tab-login-btn");
    const tabSignupBtn = getElement("tab-signup-btn");
    const panelLogin = getElement("panel-login");
    const panelSignup = getElement("panel-signup");
    const cardTitle = getElement("auth-card-title");
    const cardSubtitle = getElement("auth-card-subtitle");
    const loginErr = getElement("login-error");
    const signupErr = getElement("signup-error");
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
  function togglePw(inputId, buttonEl) {
    const input = getElement(inputId);
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
  async function handleClerkGoogleAuth() {
    const btn = getElement("login-google-btn") || getElement("signup-google-btn");
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
      if (clerkInstance.user && clerkInstance.session) {
        const synced = await syncClerkUserAndEnter(clerkInstance.user);
        if (synced) return;
      }
      sessionStorage.setItem("orbit_oauth_in_progress", String(Date.now()));
      const redirectUrl = clerkAppUrl("#sso-callback");
      const redirectUrlComplete = clerkAppUrl("#dashboard");
      const oauthParams = {
        strategy: "oauth_google",
        redirectUrl,
        redirectUrlComplete,
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
      const errorEl = getElement("login-error") || getElement("signup-error");
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
  async function handleLogin(event) {
    event.preventDefault();
    const usernameInput = getElement("login-username");
    const passwordInput = getElement("login-password");
    const errorEl = getElement("login-error");
    const submitBtn = getElement("login-submit-btn");
    const username = usernameInput ? usernameInput.value.trim() : "";
    const password = passwordInput ? passwordInput.value : "";
    if (errorEl) errorEl.classList.add("hidden");
    if (submitBtn) submitBtn.disabled = true;
    if (isClerkActive && clerkInstance) {
      try {
        const signInAttempt = await clerkInstance.client.signIn.create({
          identifier: username,
          password
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
    try {
      const data = await authService.login({ username, password });
      enterDashboard(data.username || username, data.user_id || null);
    } catch (err) {
      console.error("Login request error:", err);
      if (errorEl) {
        errorEl.textContent = err.message || "Invalid credentials.";
        errorEl.classList.remove("hidden");
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }
  async function handleSignup(event) {
    event.preventDefault();
    const emailInput = getElement("signup-email");
    const usernameInput = getElement("signup-username");
    const passwordInput = getElement("signup-password");
    const confirmInput = getElement("signup-confirm");
    const errorEl = getElement("signup-error");
    const submitBtn = getElement("signup-submit-btn");
    const email = emailInput ? emailInput.value.trim() : "";
    const username = usernameInput ? usernameInput.value.trim() : "";
    const password = passwordInput ? passwordInput.value : "";
    const confirm2 = confirmInput ? confirmInput.value : "";
    if (errorEl) errorEl.classList.add("hidden");
    if (password !== confirm2) {
      if (errorEl) {
        errorEl.textContent = "Passwords do not match.";
        errorEl.classList.remove("hidden");
      }
      return;
    }
    if (submitBtn) submitBtn.disabled = true;
    try {
      const data = await authService.register({ username, email, password });
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
      enterDashboard(data.username || username, data.user_id || null);
    } catch (err) {
      console.error("Signup error:", err);
      if (errorEl) {
        errorEl.textContent = err.message || "Registration failed.";
        errorEl.classList.remove("hidden");
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }
  async function logout() {
    localStorage.removeItem("orbit_logged_in_username");
    localStorage.removeItem("orbit_user_id");
    if (isClerkActive && clerkInstance) {
      try {
        await clerkInstance.signOut();
      } catch (e) {
      }
    }
    document.body.classList.remove("in-dashboard");
    const threeCanvas = getElement("three-canvas");
    if (threeCanvas) threeCanvas.style.display = "block";
    if (window.aether3D && typeof window.aether3D.start === "function") {
      window.aether3D.start();
    }
    const dashboardPage = getElement("dashboard-page");
    const landingPage = getElement("landing-page");
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
  }

  // src/ui/terminalController.ts
  var SYMBOL_MAP = {
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
  var tvWidget = null;
  function toTVSymbol(raw) {
    const upper = raw.trim().toUpperCase();
    if (SYMBOL_MAP[upper]) return SYMBOL_MAP[upper];
    if (upper.endsWith(".NS")) return "NSE:" + upper.replace(".NS", "");
    if (upper.endsWith(".BO")) return "BSE:" + upper.replace(".BO", "");
    if (upper.includes("-USD")) {
      return "BINANCE:" + upper.replace("-USD", "USDT");
    }
    return upper;
  }
  function switchToTab(tabName) {
    const menuBtnDashboard = getElement("menu-btn-dashboard");
    const menuBtnTerminal = getElement("menu-btn-terminal");
    const menuBtnAutotrade = getElement("menu-btn-autotrade");
    const menuBtnManageTrades = getElement("menu-btn-manage-trades");
    const menuBtnReports = getElement("menu-btn-reports");
    const menuBtnCopilot = getElement("menu-btn-copilot");
    const tabContentOverview = getElement("tab-content-overview");
    const tabContentTerminal = getElement("tab-content-terminal");
    const tabContentAutotrade = getElement("tab-content-autotrade");
    const tabContentManageTrades = getElement("tab-content-manage-trades");
    const tabContentReports = getElement("tab-content-reports");
    const tabContentCopilot = getElement("tab-content-copilot");
    const contentHeaderTitle = getElement("content-header-title");
    const allButtons = [
      menuBtnDashboard,
      menuBtnTerminal,
      menuBtnAutotrade,
      menuBtnManageTrades,
      menuBtnReports,
      menuBtnCopilot
    ];
    const allContents = [
      tabContentOverview,
      tabContentTerminal,
      tabContentAutotrade,
      tabContentManageTrades,
      tabContentReports,
      tabContentCopilot
    ];
    allButtons.forEach((b) => b?.classList.remove("active"));
    allContents.forEach((c) => c?.classList.add("hidden-tab"));
    if (tabName === "dashboard") {
      menuBtnDashboard?.classList.add("active");
      tabContentOverview?.classList.remove("hidden-tab");
      safeText(contentHeaderTitle, "Dashboard Overview");
      if (typeof window.fetchGlobalNews === "function") window.fetchGlobalNews();
      if (typeof window.fetchDashboardSummary === "function") window.fetchDashboardSummary();
    } else if (tabName === "terminal") {
      menuBtnTerminal?.classList.add("active");
      tabContentTerminal?.classList.remove("hidden-tab");
      safeText(contentHeaderTitle, "Trade Agent Terminal");
    } else if (tabName === "autotrade") {
      menuBtnAutotrade?.classList.add("active");
      tabContentAutotrade?.classList.remove("hidden-tab");
      safeText(contentHeaderTitle, "Auto-Trade Bot");
      if (typeof window.initBotControlCenter === "function") {
        window.initBotControlCenter();
      } else if (typeof window.loadBotConfig === "function") {
        window.loadBotConfig();
      }
    } else if (tabName === "manage-trades") {
      menuBtnManageTrades?.classList.add("active");
      tabContentManageTrades?.classList.remove("hidden-tab");
      safeText(contentHeaderTitle, "Manage Trades");
      if (typeof window.loadManageTradesData === "function") window.loadManageTradesData();
    } else if (tabName === "reports") {
      menuBtnReports?.classList.add("active");
      tabContentReports?.classList.remove("hidden-tab");
      safeText(contentHeaderTitle, "Trade Reports & Analytics");
      if (typeof window.loadReport === "function") window.loadReport();
    } else if (tabName === "copilot") {
      menuBtnCopilot?.classList.add("active");
      tabContentCopilot?.classList.remove("hidden-tab");
      safeText(contentHeaderTitle, "ORBIT AI Analyst");
      if (window.aether3D && typeof window.aether3D.stop === "function") window.aether3D.stop();
      const threeCanvas = getElement("three-canvas");
      if (threeCanvas) threeCanvas.style.display = "none";
      if (typeof window.loadConversationsList === "function") window.loadConversationsList();
      if (typeof window.syncCopilotBalance === "function") window.syncCopilotBalance();
    }
  }
  function initChart(symbol, interval) {
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
  function setTimeframe(tf) {
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
  function drawChartOverlay(clearOnly = false) {
    const canvas = getElement("chart-overlay-canvas");
    const container = getElement("chart-container");
    if (!canvas || !container) return;
    canvas.width = container.offsetWidth;
    canvas.height = container.offsetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (clearOnly) return;
    const supports = window.lastSupports || [];
    const resistances = window.lastResistances || [];
    const allPrices = [...supports, ...resistances];
    if (allPrices.length === 0) return;
    const maxP = Math.max(...allPrices);
    const minP = Math.min(...allPrices);
    const padding = (maxP - minP) * 0.18 || 1;
    const priceTop = maxP + padding;
    const priceBottom = minP - padding;
    const priceRange = priceTop - priceBottom;
    function priceToY(p) {
      return canvas.height - (p - priceBottom) / priceRange * canvas.height;
    }
    supports.forEach((price) => {
      const y = priceToY(price);
      ctx.save();
      ctx.strokeStyle = "rgba(0, 230, 138, 0.7)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
      ctx.restore();
    });
    resistances.forEach((price) => {
      const y = priceToY(price);
      ctx.save();
      ctx.strokeStyle = "rgba(255, 51, 102, 0.7)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
      ctx.restore();
    });
  }
  function selectStock(symbol) {
    const sym = symbol.toUpperCase();
    store.set("currentAsset", sym);
    const assetTitle = getElement("current-asset-title");
    const activeTickerDisplay = getElement("active-ticker-display");
    safeText(assetTitle, `${sym} Real-Time Chart`);
    safeText(activeTickerDisplay, sym);
    initChart(sym, store.get("currentTimeframe"));
  }
  function confirmTrade() {
    const modal = getElement("trade-confirm-modal");
    if (modal) modal.classList.add("hidden");
    store.sockets.sendPrimaryAction({
      action: "confirm_trade"
    });
    if (typeof window.logToTerminal === "function") {
      window.logToTerminal("Execution Agent", "Trade confirmed by user. Dispatching order to exchange...");
    }
  }
  function rejectTrade() {
    const modal = getElement("trade-confirm-modal");
    if (modal) modal.classList.add("hidden");
    store.sockets.sendPrimaryAction({
      action: "reject_trade"
    });
    if (typeof window.logToTerminal === "function") {
      window.logToTerminal("Risk Guard", "Trade rejected by user. Safety constraints enforced.");
    }
  }
  function initTerminalListeners() {
    getElement("menu-btn-dashboard")?.addEventListener("click", () => switchToTab("dashboard"));
    getElement("menu-btn-terminal")?.addEventListener("click", () => switchToTab("terminal"));
    getElement("menu-btn-autotrade")?.addEventListener("click", () => switchToTab("autotrade"));
    getElement("menu-btn-manage-trades")?.addEventListener("click", () => switchToTab("manage-trades"));
    getElement("menu-btn-reports")?.addEventListener("click", () => switchToTab("reports"));
    getElement("menu-btn-copilot")?.addEventListener("click", () => switchToTab("copilot"));
    document.querySelectorAll(".tf-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tf = btn.getAttribute("data-tf");
        if (tf) setTimeframe(tf);
      });
    });
  }

  // src/services/tradingService.ts
  var tradingService = {
    async getOpenPositions(userId) {
      const res = await apiClient.get(
        `/api/trades/open?user_id=${encodeURIComponent(userId)}`
      );
      if (Array.isArray(res)) return res;
      return res.positions || res.trades || [];
    },
    async getPendingOrders(userId) {
      const res = await apiClient.get(
        `/api/trades/pending?user_id=${encodeURIComponent(userId)}`
      );
      if (Array.isArray(res)) return res;
      return res.orders || res.pending || [];
    },
    async getTradeHistory(query = {}) {
      const params = new URLSearchParams();
      if (query.user_id !== void 0) params.set("user_id", String(query.user_id));
      if (query.asset) params.set("asset", query.asset);
      if (query.limit !== void 0) params.set("limit", String(query.limit));
      if (query.offset !== void 0) params.set("offset", String(query.offset));
      const res = await apiClient.get(
        `/api/trades/history?${params.toString()}`
      );
      if ("trades" in res && Array.isArray(res.trades)) {
        return {
          trades: res.trades,
          total: res.total || res.trades.length,
          page: Math.floor((query.offset || 0) / (query.limit || 10)),
          limit: query.limit || 10
        };
      }
      return { trades: [], total: 0, page: 0, limit: 10 };
    },
    async partialCloseTrade(tradeId, req) {
      return apiClient.post(`/api/trades/${tradeId}/partial-close`, req);
    },
    async closePositionPartial(tradeId, quantity, userId) {
      return apiClient.post(`/api/trades/${tradeId}/close`, {
        quantity,
        user_id: userId ? Number(userId) : void 0
      });
    },
    async fullCloseTrade(tradeId, userId) {
      return apiClient.post(`/api/trades/${tradeId}/close/full?user_id=${encodeURIComponent(userId)}`);
    },
    async closePositionFull(tradeId, userId) {
      const query = userId ? `?user_id=${encodeURIComponent(userId)}` : "";
      return apiClient.post(`/api/trades/${tradeId}/close/full${query}`, {});
    },
    async cancelOrder(orderId, userId) {
      return apiClient.post(`/api/orders/${orderId}/cancel`, {
        user_id: userId,
        order_id: orderId
      });
    }
  };

  // src/services/portfolioService.ts
  var portfolioService = {
    async getDashboardSummary(userId) {
      return apiClient.get(`/api/dashboard/summary?user_id=${encodeURIComponent(userId)}`);
    },
    async getReport(userId) {
      return apiClient.get(`/api/report?user_id=${encodeURIComponent(userId)}`);
    }
  };

  // src/services/autoBotService.ts
  var autoBotService = {
    async getConfig(userId) {
      return apiClient.get(`/api/bot-config?user_id=${encodeURIComponent(userId)}`);
    },
    async saveConfig(config) {
      const payload = {
        ...config,
        allocated_capital: Math.max(0, Number(config.allocated_capital) || 0),
        target_profit: Math.max(0, Number(config.target_profit) || 0),
        max_loss: Math.max(0, Number(config.max_loss) || 0),
        leverage: Math.max(1, Number(config.leverage) || 1)
      };
      return apiClient.post("/api/bot-config", payload);
    }
  };

  // src/ui/autoBotController.ts
  var MAX_LOG_LINES = 200;
  var BOT_LIVE_STATES = ["STARTING", "SCANNING", "ANALYZING", "OPPORTUNITY_FOUND", "TRADE_ACTIVE", "WAITING", "STOPPING"];
  var BOT_ACTIVITY_MAX = 150;
  var BOT_EVENT_ICONS = {
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
    ERROR: "fa-solid fa-circle-exclamation"
  };
  var _botUniverse = null;
  var _botSession = null;
  var _botConfig = null;
  var _botAvailableBalance = null;
  var _botSelectedAssets = /* @__PURE__ */ new Set();
  var _botActiveTradesCache = [];
  var _botPollTimer = null;
  var _botBusy = false;
  function botUserId() {
    return store.get("currentUserId") || localStorage.getItem("orbit_user_id") || null;
  }
  function botIsLive(session) {
    return !!(session && BOT_LIVE_STATES.includes(session.status));
  }
  async function botFetch(url, options) {
    const res = await fetch(url, options);
    let data = {};
    try {
      data = await res.json();
    } catch {
    }
    if (!res.ok || data.ok === false) {
      throw new Error(typeof data.detail === "string" ? data.detail : data.error || `Request failed (${res.status})`);
    }
    return data;
  }
  function botPost(url, body) {
    return botFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }
  function botTime(iso) {
    if (!iso) return "\u2014";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "\u2014" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function botDateTime(iso) {
    if (!iso) return "\u2014";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "\u2014" : d.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function botSigned(value) {
    const n = Number(value || 0);
    return `${n >= 0 ? "+" : ""}${formatINR(n)}`;
  }
  async function initBotControlCenter() {
    const uid = botUserId();
    if (!uid) return;
    try {
      const universeReq = _botUniverse ? null : botFetch(`/api/bot/universe?user_id=${encodeURIComponent(uid)}`);
      await refreshBotControlCenter(true, universeReq);
    } catch (err) {
      showBotConfigError(err.message);
    }
    startBotPolling();
  }
  async function refreshBotControlCenter(populateForm = false, universeRequest = null) {
    const uid = botUserId();
    if (!uid) return;
    const histories = Promise.allSettled([loadBotTradeHistory(), loadBotSessionHistory()]);
    const [data, universe] = await Promise.all([
      botFetch(`/api/bot/session/current?user_id=${encodeURIComponent(uid)}`),
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
  function startBotPolling() {
    clearInterval(_botPollTimer);
    _botPollTimer = setInterval(async () => {
      const tabContentAutotrade = getElement("tab-content-autotrade");
      if (!tabContentAutotrade || tabContentAutotrade.classList.contains("hidden-tab")) return;
      const uid = botUserId();
      if (!uid) return;
      try {
        const data = await botFetch(`/api/bot/session/current?user_id=${encodeURIComponent(uid)}`);
        _botAvailableBalance = data.available_balance;
        renderBotBalanceHint();
        renderBotSession(data.session, data.scheduler_online);
      } catch {
      }
    }, 15e3);
  }
  function populateBotForm() {
    if (!_botUniverse) return;
    const cats = _botUniverse.categories || [];
    const policy = _botUniverse.policy || { supported_leverage: [1], default_leverage: 1 };
    const cfg = _botConfig || {};
    const marketSel = getElement("bot-market");
    const levSel = getElement("bot-leverage");
    if (!marketSel || !levSel) return;
    const preferred = cats.find((c) => c.supported && c.id === cfg.market_category) || cats.find((c) => c.supported);
    marketSel.innerHTML = cats.map(
      (c) => `<option value="${esc(c.id)}" ${c.supported ? "" : "disabled"} ${preferred && c.id === preferred.id ? "selected" : ""}>${esc(c.label)}${c.supported ? ` (${c.assets.length})` : " \u2014 coming soon"}</option>`
    ).join("");
    const allowed = new Set((preferred && preferred.assets || []).map((a) => a.symbol.toUpperCase()));
    _botSelectedAssets = new Set((cfg.assets_list || []).map((s) => String(s).toUpperCase()).filter((s) => allowed.has(s)));
    const setVal = (id, v) => {
      const el = getElement(id);
      if (el && v !== void 0 && v !== null) el.value = String(v);
    };
    setVal("bot-capital", cfg.allocated_capital);
    setVal("bot-target", cfg.target_profit);
    setVal("bot-maxloss", cfg.max_loss);
    const levels = policy.supported_leverage || [1];
    const cfgLev = Number(cfg.leverage || 1);
    levSel.innerHTML = levels.map((l) => `<option value="${Number(l)}" ${Number(l) === cfgLev ? "selected" : ""}>${Number(l)}x</option>`).join("");
    renderBotAssetChips();
    renderBotBalanceHint();
  }
  function renderBotAssetChips() {
    const wrap = getElement("bot-asset-chips");
    const marketSel = getElement("bot-market");
    if (!wrap || !marketSel || !_botUniverse) return;
    const cat = (_botUniverse.categories || []).find((c) => c.id === marketSel.value);
    const locked = botIsLive(_botSession);
    if (!cat || !cat.supported) {
      wrap.innerHTML = `<div class="bot-chip-empty">${esc(cat && cat.reason || "Select a supported market.")}</div>`;
      return;
    }
    wrap.innerHTML = cat.assets.map((a) => {
      const sym = a.symbol.toUpperCase();
      return `<button type="button" class="bot-asset-chip${_botSelectedAssets.has(sym) ? " selected" : ""}" ${locked ? "disabled" : ""} data-symbol="${esc(sym)}" title="${esc(a.name)}">
                    <strong>${esc(sym)}</strong><span>${esc(a.name)}</span>
                </button>`;
    }).join("");
    wrap.querySelectorAll(".bot-asset-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sym = btn.getAttribute("data-symbol");
        if (sym) toggleBotAsset(sym);
      });
    });
    safeText(getElement("bot-assets-hint"), `${_botSelectedAssets.size} selected`);
  }
  function onBotMarketChange() {
    _botSelectedAssets = /* @__PURE__ */ new Set();
    renderBotAssetChips();
  }
  function toggleBotAsset(symbol) {
    if (botIsLive(_botSession)) return;
    if (_botSelectedAssets.has(symbol)) _botSelectedAssets.delete(symbol);
    else _botSelectedAssets.add(symbol);
    renderBotAssetChips();
  }
  function renderBotBalanceHint() {
    const ok = _botAvailableBalance !== null && _botAvailableBalance !== void 0;
    safeText(getElement("bot-balance-hint"), ok ? `available ${formatINR(_botAvailableBalance)}` : "");
  }
  function setBotCapitalMax() {
    const el = getElement("bot-capital");
    if (el && _botAvailableBalance) el.value = String(Math.floor(Number(_botAvailableBalance) * 100) / 100);
  }
  function readBotForm() {
    return {
      market_category: getElement("bot-market")?.value || "",
      assets: [..._botSelectedAssets],
      allocated_capital: parseFloat(getElement("bot-capital")?.value || "0"),
      target_profit: parseFloat(getElement("bot-target")?.value || "0"),
      max_loss: parseFloat(getElement("bot-maxloss")?.value || "0"),
      leverage: parseFloat(getElement("bot-leverage")?.value || "1")
    };
  }
  function botFormProblem(cfg) {
    if (!cfg.assets.length) return "Select at least one asset.";
    for (const [key, label] of [["allocated_capital", "Allocated capital"], ["target_profit", "Target profit"], ["max_loss", "Max loss"]]) {
      if (!(cfg[key] > 0)) return `${label} must be greater than zero.`;
    }
    if (_botAvailableBalance !== null && _botAvailableBalance !== void 0 && cfg.allocated_capital > Number(_botAvailableBalance)) {
      return `Allocated capital exceeds your available balance (${formatINR(_botAvailableBalance)}).`;
    }
    return null;
  }
  function showBotConfigError(message) {
    const el = getElement("bot-config-error");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("hidden", !message);
  }
  async function saveBotConfig() {
    const uid = botUserId();
    if (!uid) return;
    const cfg = readBotForm();
    const problem = botFormProblem(cfg);
    if (problem) {
      showBotConfigError(problem);
      return;
    }
    const btn = getElement("bot-save-btn");
    const original = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    }
    try {
      const data = await botPost("/api/bot-config", { user_id: Number(uid), ...cfg });
      _botConfig = { ..._botConfig || {}, ...data.config, assets_list: data.config.assets };
      showBotConfigError(null);
      if (btn) btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
    } catch (err) {
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
  async function startBotSession() {
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
      renderBotSession(data.session, data.session ? data.session.scheduler_online : void 0);
      if (data.session) await loadBotActivity(data.session.id);
      loadBotSessionHistory();
    } catch (err) {
      showBotConfigError(err.message);
    } finally {
      _botBusy = false;
      updateBotButtons();
    }
  }
  async function stopBotSession() {
    const uid = botUserId();
    if (!uid || _botBusy) return;
    if (!confirm("Stop the bot? It stops scanning and opening trades. Open auto-trades stay open and remain manageable.")) return;
    _botBusy = true;
    updateBotButtons();
    try {
      const data = await botPost("/api/bot/session/stop", { user_id: Number(uid) });
      renderBotSession(data.session, data.session ? data.session.scheduler_online : void 0);
    } catch (err) {
      showBotConfigError(err.message);
    } finally {
      _botBusy = false;
      updateBotButtons();
    }
  }
  function updateBotButtons() {
    const live = botIsLive(_botSession);
    const startBtn = getElement("bot-start-btn");
    const stopBtn = getElement("bot-stop-btn");
    if (startBtn) startBtn.disabled = !!(_botBusy || live);
    if (stopBtn) stopBtn.disabled = !!(_botBusy || !live || _botSession?.status === "STOPPING");
    const lock = getElement("bot-config-lock");
    if (lock) lock.classList.toggle("hidden", !live);
    ["bot-market", "bot-capital", "bot-target", "bot-maxloss", "bot-leverage", "bot-save-btn", "bot-max-btn"].forEach((id) => {
      const el = getElement(id);
      if (el) el.disabled = live;
    });
    document.querySelectorAll(".bot-asset-chip").forEach((b) => {
      b.disabled = live;
    });
  }
  function setBotBar(id, pct) {
    const el = getElement(id);
    if (el) el.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
  }
  function renderBotSession(session, schedulerOnline) {
    _botSession = session || null;
    const s = _botSession;
    const status = s ? s.status : "STOPPED";
    const pill = getElement("bot-status-pill");
    if (pill) pill.className = `bot-status-pill state-${status}`;
    safeText(getElement("bot-status-text"), status.replace(/_/g, " "));
    const sched = getElement("bot-scheduler-pill");
    if (sched && schedulerOnline !== void 0 && schedulerOnline !== null) {
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
        if (s.entries_allowed && s.next_scan_in_seconds !== null && s.next_scan_in_seconds !== void 0) {
          parts.push(s.next_scan_in_seconds > 0 ? `next scan in ~${Math.round(s.next_scan_in_seconds)}s` : "scan due");
        }
        if (!botIsLive(s) && s.stopped_at) parts.push(`ended ${botDateTime(s.stopped_at)}`);
        if (s.stop_reason && !s.entries_allowed) parts.push(s.stop_reason);
        if (s.last_error) parts.push(`error: ${s.last_error}`);
        meta.textContent = parts.filter(Boolean).join("  \xB7  ");
      }
    }
    const set = (id, v) => safeText(getElement(id), v);
    if (!s) {
      ["bot-kpi-allocated", "bot-kpi-available", "bot-kpi-pnl", "bot-kpi-target", "bot-kpi-loss", "bot-kpi-trades"].forEach((id) => set(id, "\u2014"));
      ["bot-kpi-allocated-sub", "bot-kpi-used", "bot-kpi-pnl-sub", "bot-kpi-target-sub", "bot-kpi-loss-sub", "bot-kpi-trades-sub"].forEach((id) => set(id, ""));
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
    set("bot-kpi-pnl-sub", `realized ${botSigned(s.realized_pnl)} \xB7 unrealized ${botSigned(s.unrealized_pnl)}`);
    set("bot-kpi-target", formatINR(s.target_profit));
    set("bot-kpi-target-sub", `${Number(s.target_progress_pct).toFixed(1)}% reached (realized)`);
    setBotBar("bot-target-bar", s.target_progress_pct);
    set("bot-kpi-loss", `${formatINR(s.session_loss)} / ${formatINR(s.max_loss)}`);
    set("bot-kpi-loss-sub", `${Number(s.loss_progress_pct).toFixed(1)}% of limit (${String(s.loss_basis || "").replace(/_/g, " ")})`);
    setBotBar("bot-loss-bar", s.loss_progress_pct);
    set("bot-kpi-trades", String(s.total_trades));
    set("bot-kpi-trades-sub", `${s.winning_trades}W / ${s.losing_trades}L \xB7 ${s.open_trades} open`);
    renderBotActiveTrades(s.active_trades || []);
    updateBotButtons();
    renderBotAssetChips();
  }
  function renderBotActiveTrades(trades) {
    _botActiveTradesCache = trades;
    safeText(getElement("bot-active-count"), String(trades.length));
    const tbody = getElement("bot-active-tbody");
    if (!tbody) return;
    if (!trades.length) {
      tbody.innerHTML = `<tr><td colspan="12" class="table-empty-message">No active auto-trades.</td></tr>`;
      return;
    }
    tbody.innerHTML = trades.map((pos) => {
      const pnl = Number(pos.unrealized_pnl || 0);
      const side = String(pos.side || pos.type || "buy").toUpperCase();
      const isLong = side === "BUY" || side === "LONG";
      const margin = Number(pos.margin_used || 0);
      const pct = margin > 0 ? (pnl / margin * 100).toFixed(2) : "0.00";
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
    const feed = getElement("bot-activity-feed");
    if (!feed) return;
    feed.innerHTML = events.length ? events.slice(0, BOT_ACTIVITY_MAX).map(botEventRow).join("") : `<div class="table-empty-message">No activity yet.</div>`;
  }
  function appendBotEvent(evt) {
    const feed = getElement("bot-activity-feed");
    if (!feed) return;
    const empty = feed.querySelector(".table-empty-message");
    if (empty) empty.remove();
    feed.insertAdjacentHTML("afterbegin", botEventRow(evt));
    while (feed.children.length > BOT_ACTIVITY_MAX) {
      if (feed.lastElementChild) feed.removeChild(feed.lastElementChild);
    }
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
      if (evt.session_id && evt.session_id > _botSession.id) {
        refreshBotControlCenter().catch(() => {
        });
      }
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
    getElement("bot-hist-btn-trades")?.classList.toggle("active", tab === "trades");
    getElement("bot-hist-btn-sessions")?.classList.toggle("active", tab === "sessions");
    getElement("bot-hist-trades")?.classList.toggle("hidden", tab !== "trades");
    getElement("bot-hist-sessions")?.classList.toggle("hidden", tab !== "sessions");
  }
  async function loadBotTradeHistory() {
    const uid = botUserId();
    const tbody = getElement("bot-hist-trades-tbody");
    if (!uid || !tbody) return;
    try {
      const data = await botFetch(`/api/trades/history?user_id=${encodeURIComponent(uid)}&source=bot&limit=25&offset=0`);
      const trades = data.trades || [];
      safeText(getElement("bot-hist-trades-count"), String(data.total || 0));
      tbody.innerHTML = trades.length ? trades.map((t) => {
        const pnl = Number(t.realized_pnl !== void 0 && t.realized_pnl !== null ? t.realized_pnl : t.pnl || 0);
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
                    <td>${t.exit_price !== null && t.exit_price !== void 0 ? formatINR(t.exit_price) : "\u2014"}</td>
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
    const tbody = getElement("bot-hist-sessions-tbody");
    if (!uid || !tbody) return;
    try {
      const data = await botFetch(`/api/bot/session/history?user_id=${encodeURIComponent(uid)}&limit=20`);
      const sessions = data.sessions || [];
      safeText(getElement("bot-hist-sessions-count"), String(data.total || 0));
      tbody.innerHTML = sessions.length ? sessions.map((s) => {
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
  function logToTerminal(agent, message, timestamp) {
    const consoleLogsElement = getElement("console-logs");
    if (!consoleLogsElement) return;
    const timeStr = timestamp || (/* @__PURE__ */ new Date()).toLocaleTimeString();
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
  function updateAgentStatusUI(agentName, message) {
    if (!agentName || agentName === "SYSTEM") return;
    let rowId = null;
    const nameLower = agentName.toLowerCase();
    if (nameLower.includes("chart") || nameLower.includes("level")) rowId = "chart";
    else if (nameLower.includes("indicator")) rowId = "indicators";
    else if (nameLower.includes("news")) rowId = "news";
    else if (nameLower.includes("consensus") || nameLower.includes("judge") || nameLower.includes("strategy")) rowId = "consensus";
    else if (nameLower.includes("risk")) rowId = "risk";
    else if (nameLower.includes("execution")) rowId = "execution";
    else if (nameLower.includes("monitor") || nameLower.includes("p&l") || nameLower.includes("pndl") || nameLower.includes("manager"))
      rowId = "monitor";
    if (!rowId) return;
    const row = getElement(`agent-row-${rowId}`);
    const statusText = getElement(`agent-status-${rowId}`);
    if (!row || !statusText) return;
    const msgTrim = message.trim();
    if (message.startsWith(" ") || message.startsWith("	") || msgTrim.startsWith("-") || msgTrim.startsWith("*")) {
      return;
    }
    row.classList.remove("completed-agent");
    row.classList.add("active-agent");
    statusText.textContent = "Processing...";
    const msgLower = message.toLowerCase();
    if (msgLower.includes("complete") || msgLower.includes("found") || msgLower.includes("calculated") || msgLower.includes("signal generated") || msgLower.includes("sentiment score") || msgLower.includes("sentiment:") || msgLower.includes("monitoring active") || msgLower.includes("placed") || msgLower.includes("waiting") || msgLower.includes("verdict:") || msgLower.includes("conclusion:") || msgLower.includes("no trade planned") || msgLower.includes("planning") || msgLower.includes("no pending orders") || msgLower.includes("order filled") || msgLower.includes("no active positions") || msgLower.includes("position closed") || msgLower.includes("holding") || msgLower.includes("analyzed")) {
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
  async function loadBotConfig() {
    const userId = store.get("currentUserId");
    if (!userId) return;
    try {
      const config = await autoBotService.getConfig(userId);
      if (config) {
        const assetsEl = getElement("autotrade-assets");
        const capEl = getElement("autotrade-capital");
        const minProfEl = getElement("autotrade-min-profit");
        const maxProfEl = getElement("autotrade-max-profit");
        const toggleEl = getElement("autotrade-toggle");
        const statusEl = getElement("autotrade-status-text");
        if (assetsEl && config.assets) assetsEl.value = config.assets;
        if (capEl && config.total_capital) capEl.value = String(config.total_capital);
        if (minProfEl && config.min_profit_target) minProfEl.value = String(config.min_profit_target);
        if (maxProfEl && config.max_profit_target) maxProfEl.value = String(config.max_profit_target);
        if (toggleEl) toggleEl.checked = !!config.is_active;
        if (statusEl) {
          statusEl.textContent = config.is_active ? "Running \u2014 scanning market..." : "Currently stopped";
        }
      }
    } catch (e) {
      console.error("Failed to load bot config:", e);
    }
  }
  function initAutoBotListeners() {
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

  // src/ui/manageTradesController.ts
  var _isCloseExecuting = false;
  var _historySearchDebounceTimer = null;
  function switchManageSubTab(subTab) {
    const btnOpen = getElement("subtab-btn-open-trades");
    const btnPending = getElement("subtab-btn-pending-orders");
    const btnHistory = getElement("subtab-btn-trade-history");
    const panelOpen = getElement("manage-subtab-open");
    const panelPending = getElement("manage-subtab-pending");
    const panelHistory = getElement("manage-subtab-history");
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
  async function loadManageTradesData(btnElement) {
    let originalHtml = "";
    if (btnElement) {
      btnElement.setAttribute("disabled", "true");
      originalHtml = btnElement.innerHTML;
      btnElement.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> <span>Refreshing...</span>';
    }
    try {
      const results = await Promise.allSettled([
        loadOpenTrades(),
        loadPendingOrders(),
        loadTradeHistoryPage(store.get("historyPage") || 0),
        fetchDashboardSummary()
      ]);
      const anyFailed = results.some((r) => r.status === "rejected");
      if (anyFailed) {
        console.warn("[ManageTrades] Some items failed to refresh:", results);
        if (btnElement) {
          btnElement.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-yellow"></i> <span>Partial</span>';
          setTimeout(() => {
            if (btnElement) {
              btnElement.innerHTML = originalHtml;
              btnElement.removeAttribute("disabled");
            }
          }, 1500);
          return;
        }
      }
      if (btnElement) {
        btnElement.innerHTML = '<i class="fa-solid fa-check text-green"></i> <span>Updated</span>';
        setTimeout(() => {
          if (btnElement) {
            btnElement.innerHTML = originalHtml;
            btnElement.removeAttribute("disabled");
          }
        }, 1200);
      }
    } catch (err) {
      console.error("[ManageTrades] Error refreshing data:", err);
      if (btnElement) {
        btnElement.innerHTML = '<i class="fa-solid fa-xmark text-red"></i> <span>Connection error</span>';
        setTimeout(() => {
          if (btnElement) {
            btnElement.innerHTML = originalHtml;
            btnElement.removeAttribute("disabled");
          }
        }, 2e3);
      }
    } finally {
      if (btnElement && !btnElement.innerHTML.includes("text-green") && !btnElement.innerHTML.includes("text-yellow") && !btnElement.innerHTML.includes("text-red")) {
        btnElement.removeAttribute("disabled");
        btnElement.innerHTML = originalHtml;
      }
    }
  }
  async function refreshAllData(btnElement) {
    let originalHtml = "";
    if (btnElement) {
      btnElement.setAttribute("disabled", "true");
      originalHtml = btnElement.innerHTML;
      btnElement.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> <span>Refreshing...</span>';
    }
    try {
      const results = await Promise.allSettled([
        fetchDashboardSummary(),
        loadOpenTrades(),
        loadPendingOrders(),
        loadTradeHistoryPage(store.get("historyPage") || 0),
        typeof window.fetchGlobalNews === "function" ? window.fetchGlobalNews() : Promise.resolve()
      ]);
      const anyFailed = results.some((r) => r.status === "rejected");
      if (anyFailed) {
        console.warn("[Refresh] Some requests failed:", results);
        if (btnElement) {
          btnElement.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-yellow"></i> <span>Partial</span>';
          setTimeout(() => {
            if (btnElement) {
              btnElement.innerHTML = originalHtml;
              btnElement.removeAttribute("disabled");
            }
          }, 1500);
          return;
        }
      }
      if (btnElement) {
        btnElement.innerHTML = '<i class="fa-solid fa-check text-green"></i> <span>Updated</span>';
        setTimeout(() => {
          if (btnElement) {
            btnElement.innerHTML = originalHtml;
            btnElement.removeAttribute("disabled");
          }
        }, 1200);
      }
    } catch (err) {
      console.error("[Refresh] Error refreshing system data:", err);
      if (btnElement) {
        btnElement.innerHTML = '<i class="fa-solid fa-xmark text-red"></i> <span>Connection error</span>';
        setTimeout(() => {
          if (btnElement) {
            btnElement.innerHTML = originalHtml;
            btnElement.removeAttribute("disabled");
          }
        }, 2e3);
      }
    } finally {
      if (btnElement && !btnElement.innerHTML.includes("text-green") && !btnElement.innerHTML.includes("text-yellow") && !btnElement.innerHTML.includes("text-red")) {
        btnElement.removeAttribute("disabled");
        btnElement.innerHTML = originalHtml;
      }
    }
  }
  async function loadOpenTrades() {
    const tbody = getElement("open-trades-tbody");
    const countBadge = getElement("manage-open-count");
    const overviewActiveEl = getElement("overview-active-trades");
    try {
      const userId = store.get("currentUserId") || 1;
      const positions = await tradingService.getOpenPositions(userId);
      store.set("openTrades", positions);
      if (countBadge) countBadge.textContent = String(positions.length);
      if (overviewActiveEl) overviewActiveEl.textContent = String(positions.length);
      if (!tbody) return;
      if (positions.length === 0) {
        tbody.innerHTML = `
                <tr>
                    <td colspan="13" class="table-empty-message">No active positions. Execute a trade from the Terminal or Auto-Trade Bot to begin.</td>
                </tr>
            `;
        return;
      }
      tbody.innerHTML = positions.map((pos) => {
        const pnl = Number(pos.unrealized_pnl || pos.pnl || 0);
        const pnlClass = pnl >= 0 ? "text-green" : "text-red";
        const side = (pos.side || pos.type || "buy").toUpperCase();
        const sideClass = side === "BUY" || side === "LONG" ? "badge-green" : "badge-red";
        const sideLabel = side === "BUY" ? "LONG" : side === "SELL" ? "SHORT" : side;
        const market = pos.market || "Crypto";
        const lev = pos.leverage || 1;
        const posSize = Number(pos.remaining_quantity || pos.quantity || 0) * Number(pos.current_price || pos.entry_price || 0);
        const marginUsed = Number(pos.margin_used || 0);
        const pnlPct = marginUsed > 0 ? (pnl / marginUsed * 100).toFixed(2) : "0.00";
        const openTime = pos.timestamp ? new Date(pos.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        }) : "\u2014";
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
  async function loadPendingOrders() {
    const tbody = getElement("pending-orders-tbody");
    const countBadge = getElement("manage-pending-count");
    try {
      const userId = store.get("currentUserId") || 1;
      const orders = await tradingService.getPendingOrders(userId);
      store.set("pendingOrders", orders);
      if (countBadge) countBadge.textContent = String(orders.length);
      if (!tbody) return;
      if (orders.length === 0) {
        tbody.innerHTML = `
                <tr>
                    <td colspan="10" class="table-empty-message">No pending orders. Limit and trigger orders awaiting execution will appear here.</td>
                </tr>
            `;
        return;
      }
      tbody.innerHTML = orders.map((ord) => {
        const side = (ord.type || "BUY").toUpperCase();
        const sideClass = side === "BUY" ? "badge-green" : "badge-red";
        const created = ord.timestamp ? new Date(ord.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "\u2014";
        return `
                <tr>
                    <td><code>#${ord.id}</code></td>
                    <td><strong>${esc(ord.asset)}</strong></td>
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
  async function cancelPendingOrder(orderId) {
    if (!confirm("Are you sure you want to cancel this pending order?")) return;
    store.sockets.sendPrimaryAction({
      action: "cancel_trade",
      trade_id: orderId
    });
    setTimeout(() => {
      loadPendingOrders();
      fetchDashboardSummary();
    }, 300);
  }
  async function loadTradeHistoryPage(page) {
    if (page !== void 0) {
      store.set("historyPage", page);
    }
    const currentPage = store.get("historyPage");
    const tbody = getElement("trade-history-tbody");
    const countBadge = getElement("manage-history-count");
    const prevBtn = getElement("history-prev-btn");
    const nextBtn = getElement("history-next-btn");
    const pageInfo = getElement("history-page-info");
    const search = (getElement("history-filter-symbol")?.value || "").trim();
    const market = getElement("history-filter-market")?.value || "";
    const side = getElement("history-filter-side")?.value || "";
    const outcome = getElement("history-filter-outcome")?.value || "";
    const limit = 15;
    const offset = currentPage * limit;
    try {
      const userId = store.get("currentUserId") || 1;
      const res = await tradingService.getTradeHistory({
        user_id: userId,
        limit,
        offset,
        symbol: search || void 0,
        market: market || void 0,
        side: side || void 0,
        outcome: outcome || void 0
      });
      const trades = res.trades || [];
      const total = res.total || 0;
      store.set("tradeHistory", trades);
      if (countBadge) countBadge.textContent = String(total);
      const totalHistoryPages = Math.max(1, Math.ceil(total / limit));
      store.set("totalHistoryPages", totalHistoryPages);
      if (pageInfo) pageInfo.textContent = `Page ${currentPage + 1} of ${totalHistoryPages}`;
      if (prevBtn) prevBtn.disabled = currentPage <= 0;
      if (nextBtn) nextBtn.disabled = currentPage >= totalHistoryPages - 1;
      if (!tbody) return;
      if (trades.length === 0) {
        tbody.innerHTML = `
                <tr>
                    <td colspan="12" class="table-empty-message">No completed trades match your filter criteria.</td>
                </tr>
            `;
        return;
      }
      tbody.innerHTML = trades.map((trade) => {
        const pnl = Number(trade.realized_pnl !== void 0 ? trade.realized_pnl : trade.pnl || 0);
        const pnlClass = pnl > 0 ? "text-green" : pnl < 0 ? "text-red" : "";
        const tradeSide = (trade.side || trade.type || "buy").toUpperCase();
        const sideLabel = tradeSide === "BUY" ? "LONG" : tradeSide === "SELL" ? "SHORT" : tradeSide;
        const sideClass = tradeSide === "BUY" || tradeSide === "LONG" ? "badge-green" : "badge-red";
        const tradeOutcome = trade.outcome || (pnl > 0 ? "profit" : pnl < 0 ? "loss" : "closed");
        const outcomeClass = tradeOutcome === "target" || tradeOutcome === "profit" ? "badge-green" : tradeOutcome === "cancelled" ? "badge-yellow" : "badge-red";
        const openTime = trade.opened_at || trade.timestamp ? new Date(trade.opened_at || trade.timestamp).toLocaleDateString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        }) : "\u2014";
        const closeTime = trade.closed_at ? new Date(trade.closed_at).toLocaleDateString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        }) : "\u2014";
        const lev = trade.leverage || 1;
        const exitPrice = trade.exit_price !== null && trade.exit_price !== void 0 ? formatINR(trade.exit_price) : "\u2014";
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
                    <td><span class="badge ${outcomeClass}">${esc(tradeOutcome).toUpperCase()}</span></td>
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
  function paginateHistory(direction) {
    const targetPage = store.get("historyPage") + direction;
    const totalPages = store.get("totalHistoryPages");
    if (targetPage >= 0 && targetPage < totalPages) {
      loadTradeHistoryPage(targetPage);
    }
  }
  function debouncedHistorySearch() {
    clearTimeout(_historySearchDebounceTimer);
    _historySearchDebounceTimer = setTimeout(() => {
      loadTradeHistoryPage(0);
    }, 300);
  }
  function openManageTradeModal(tradeId) {
    const openTrades = store.get("openTrades");
    const trade = openTrades.find((p) => p.id === tradeId) || _botActiveTradesCache.find((p) => p.id === tradeId);
    if (!trade) {
      console.warn("[ManageTrades] Trade not found in cache:", tradeId);
      return;
    }
    store.set("activeManageTrade", trade);
    store.set("closeSelectedPct", null);
    const modal = getElement("manage-trade-modal");
    if (!modal) return;
    const symbol = trade.symbol || trade.asset || "";
    safeText(getElement("mmodal-symbol-sub"), `${symbol} \u2022 ${trade.market || "Spot"} Market`);
    const side = (trade.side || trade.type || "buy").toUpperCase();
    const sideBadge = getElement("mmodal-side-badge");
    if (sideBadge) {
      sideBadge.textContent = side === "BUY" ? "LONG" : side === "SELL" ? "SHORT" : side;
      sideBadge.className = `trade-side-badge ${side === "BUY" || side === "LONG" ? "buy" : "sell"}`;
    }
    safeText(getElement("mmodal-status-badge"), "OPEN");
    safeText(getElement("mmodal-entry-price"), formatINR(trade.entry_price || 0));
    safeText(getElement("mmodal-current-price"), formatINR(trade.current_price || 0));
    safeText(getElement("mmodal-total-qty"), String(trade.original_quantity || trade.quantity || 1));
    safeText(getElement("mmodal-remaining-qty"), String(trade.remaining_quantity || trade.quantity || 1));
    safeText(getElement("mmodal-leverage"), `${trade.leverage || 1}x`);
    const uPnl = Number(trade.unrealized_pnl || trade.pnl || 0);
    const uPnlEl = getElement("mmodal-unrealized-pnl");
    if (uPnlEl) {
      uPnlEl.textContent = (uPnl >= 0 ? "+" : "") + formatINR(uPnl);
      uPnlEl.className = `mmodal-metric-val ${uPnl >= 0 ? "text-green" : "text-red"}`;
    }
    selectClosePct(50);
    modal.classList.remove("hidden");
  }
  function closeManageTradeModal() {
    const modal = getElement("manage-trade-modal");
    if (modal) modal.classList.add("hidden");
    store.set("activeManageTrade", null);
    store.set("closeSelectedPct", null);
  }
  function selectClosePct(pct) {
    const trade = store.get("activeManageTrade");
    if (!trade) return;
    store.set("closeSelectedPct", pct);
    document.querySelectorAll(".close-pct-btn-group .pct-btn").forEach((btn) => {
      const text = btn.textContent ? btn.textContent.trim() : "";
      const matches = pct === 100 && text.includes("FULL") || text.includes(`${pct}%`);
      btn.classList.toggle("active-pct", matches);
    });
    const remQty = Number(trade.remaining_quantity || trade.quantity || 1);
    let closeQty = remQty * (pct / 100);
    if (Number.isInteger(remQty)) {
      closeQty = Math.max(1, Math.round(closeQty));
      if (pct < 100 && closeQty >= remQty) {
        closeQty = Math.max(1, remQty - 1);
      }
    } else {
      closeQty = Number(closeQty.toFixed(4));
    }
    if (pct === 100) closeQty = remQty;
    const input = getElement("custom-close-qty");
    if (input) input.value = String(closeQty);
    recalculateCloseEstimates(closeQty);
  }
  function onCustomCloseInput() {
    const trade = store.get("activeManageTrade");
    if (!trade) return;
    document.querySelectorAll(".close-pct-btn-group .pct-btn").forEach((btn) => btn.classList.remove("active-pct"));
    store.set("closeSelectedPct", null);
    const input = getElement("custom-close-qty");
    const val = parseFloat(input?.value || "0");
    const remQty = Number(trade.remaining_quantity || trade.quantity || 1);
    if (isNaN(val) || val <= 0) {
      recalculateCloseEstimates(0);
      return;
    }
    const safeQty = Math.min(val, remQty);
    if (val > remQty && input) {
      input.value = String(safeQty);
    }
    recalculateCloseEstimates(safeQty);
  }
  function setMaxCloseQty() {
    const trade = store.get("activeManageTrade");
    if (!trade) return;
    selectClosePct(100);
  }
  function recalculateCloseEstimates(closeQty) {
    const trade = store.get("activeManageTrade");
    if (!trade) return;
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
    const marginPortion = remQty > 0 ? closeQty / remQty * marginUsed : 0;
    const totalRefund = marginPortion + estPnl;
    safeText(getElement("est-close-qty"), String(closeQty));
    safeText(getElement("est-exit-price"), formatINR(current));
    const pnlEl = getElement("est-realized-pnl");
    if (pnlEl) {
      pnlEl.textContent = (estPnl >= 0 ? "+" : "") + formatINR(estPnl);
      pnlEl.className = estPnl >= 0 ? "text-green" : "text-red";
    }
    safeText(getElement("est-margin-refund"), formatINR(Math.max(0, totalRefund)));
  }
  async function executePositionClose() {
    if (_isCloseExecuting) return;
    const trade = store.get("activeManageTrade");
    if (!trade) return;
    const tradeId = trade.id;
    const remQty = Number(trade.remaining_quantity || trade.quantity || 1);
    const input = getElement("custom-close-qty");
    const closeQty = parseFloat(input?.value || "0");
    if (isNaN(closeQty) || closeQty <= 0) {
      alert("Please specify a valid quantity to close greater than zero.");
      return;
    }
    if (closeQty > remQty) {
      alert(`Cannot close more than the remaining quantity (${remQty}).`);
      return;
    }
    const isFullClose = closeQty >= remQty;
    const confirmMsg = isFullClose ? `Confirm FULL CLOSE of ${trade.symbol || trade.asset} (${remQty} units)?` : `Confirm partial close of ${closeQty} units of ${trade.symbol || trade.asset}?`;
    if (!confirm(confirmMsg)) return;
    _isCloseExecuting = true;
    const btn = getElement("btn-confirm-close");
    const btnText = getElement("btn-confirm-close-text");
    if (btn) btn.disabled = true;
    if (btnText) btnText.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Closing...';
    try {
      const uid = store.get("currentUserId") || localStorage.getItem("orbit_user_id") || 1;
      let realizedPnl = 0;
      if (isFullClose) {
        const res = await tradingService.closePositionFull(tradeId, uid);
        realizedPnl = res.realized_pnl;
      } else {
        const res = await tradingService.closePositionPartial(tradeId, closeQty, uid);
        realizedPnl = res.realized_pnl;
      }
      closeManageTradeModal();
      await Promise.all([
        loadOpenTrades(),
        fetchDashboardSummary(),
        loadTradeHistoryPage(0),
        trade.source === "bot" ? refreshBotControlCenter().catch(() => {
        }) : Promise.resolve()
      ]);
      if (typeof window.logToTerminal === "function") {
        window.logToTerminal(
          "Execution Agent",
          `\u2705 Position #${tradeId} (${trade.symbol || trade.asset}) ${isFullClose ? "fully" : "partially"} closed. Realized P&L: ${formatINR(realizedPnl)}`
        );
      }
    } catch (err) {
      console.error("[ManageTrades] Close execution error:", err);
      alert(`Close order failed: ${err.message}`);
    } finally {
      _isCloseExecuting = false;
      if (btn) btn.disabled = false;
      if (btnText) btnText.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Close';
    }
  }
  async function fetchDashboardSummary() {
    try {
      const userId = store.get("currentUserId") || 1;
      const summary = await portfolioService.getDashboardSummary(userId);
      store.set("dashboardSummary", summary);
      safeText(getElement("overview-equity"), formatINR(summary.equity));
      safeText(getElement("overview-cash-balance"), formatINR(summary.balance));
      safeText(getElement("overview-used-margin"), formatINR(summary.used_margin));
      safeText(getElement("wallet-balance"), formatINR(summary.balance));
      const uPnl = summary.unrealized_pnl ?? summary.total_unrealized_pnl;
      const rPnl = summary.realized_pnl ?? summary.total_realized_pnl;
      const pnlEl = getElement("overview-unrealized-pnl");
      if (pnlEl) {
        pnlEl.textContent = (uPnl >= 0 ? "+" : "") + formatINR(uPnl);
        pnlEl.className = uPnl >= 0 ? "metric-val text-green" : "metric-val text-red";
      }
      const realizedEl = getElement("overview-realized-pnl");
      if (realizedEl) {
        realizedEl.textContent = (rPnl >= 0 ? "+" : "") + formatINR(rPnl);
        realizedEl.className = rPnl >= 0 ? "metric-val text-green" : "metric-val text-red";
      }
      const winRateEl = getElement("overview-win-rate");
      if (winRateEl) {
        winRateEl.textContent = summary.win_rate !== null && summary.win_rate !== void 0 ? `${summary.win_rate.toFixed(1)}%` : "\u2014";
      }
    } catch (err) {
      console.error("[Dashboard] Error fetching summary:", err);
    }
  }

  // src/services/aiService.ts
  var aiService = {
    async analyzeAgents(symbol, timeframe = "1d") {
      return apiClient.get(
        `/api/agents/analyze?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
      );
    },
    async evaluateStrategies(symbol, timeframe = "1d") {
      return apiClient.get(
        `/api/strategies/evaluate?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
      );
    },
    async evaluateConsensus(symbol, timeframe = "1d") {
      return apiClient.get(
        `/api/consensus/evaluate?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
      );
    },
    async analyzeBrain(symbol, timeframe = "1d") {
      return apiClient.get(
        `/api/brain/analyze?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
      );
    },
    async evaluateRisk(symbol, timeframe = "1d") {
      return apiClient.get(
        `/api/risk/evaluate?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
      );
    },
    async evaluateOpportunity(symbol, timeframe = "1d") {
      return apiClient.get(
        `/api/opportunity/evaluate?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
      );
    },
    async evaluateDecision(symbol, timeframe = "1d") {
      return apiClient.get(
        `/api/decision/evaluate?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
      );
    },
    async evaluateExplainability(symbol, timeframe = "1d") {
      return apiClient.get(
        `/api/explain/evaluate?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
      );
    },
    async evaluateExplanation(symbol, timeframe = "1d") {
      return this.evaluateExplainability(symbol, timeframe);
    },
    async chatCopilot(req) {
      return apiClient.post("/api/copilot/chat", req);
    },
    async getCopilotContext(symbol, timeframe = "1d") {
      return apiClient.get(
        `/api/copilot/context?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
      );
    },
    async resetCopilotSession(symbol) {
      return apiClient.post("/api/copilot/reset", { symbol });
    }
  };

  // src/ui/aiModalsController.ts
  function openStrategyModal() {
    const modal = getElement("strategy-inspect-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    const sub = getElement("strat-modal-subtitle");
    if (sub) {
      sub.textContent = `Evaluating real-time market setups on ${store.get("currentAsset") || "BTC-USD"} (${store.get("currentTimeframe") || "1d"})`;
    }
    refreshStrategyModal();
  }
  function closeStrategyModal() {
    const modal = getElement("strategy-inspect-modal");
    if (modal) modal.classList.add("hidden");
  }
  async function refreshStrategyModal() {
    const grid = getElement("strategy-modal-grid");
    const tallyEl = getElement("strat-tally-text");
    const timeBadge = getElement("strat-time-badge");
    const sub = getElement("strat-modal-subtitle");
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";
    if (sub) sub.textContent = `Evaluating real-time market setups on ${asset} (${tf})`;
    if (tallyEl) tallyEl.innerHTML = `<span class="status-dot green-glow"></span> Querying Market Data System...`;
    try {
      const data = await aiService.evaluateStrategies(asset, tf);
      if (timeBadge) timeBadge.textContent = `${data.execution_time_ms.toFixed(1)} ms`;
      const bullCount = data.tally?.BULLISH || 0;
      const bearCount = data.tally?.BEARISH || 0;
      const setupsFound = data.setups_found || data.setups_detected_count || 0;
      const totalStrats = data.strategies_total || data.total_strategies || 12;
      const avgConf = data.average_confidence !== void 0 ? data.average_confidence : 0;
      if (tallyEl) {
        tallyEl.innerHTML = `<strong>${setupsFound} of ${totalStrats}</strong> Setups Active &bull; <span class="text-green">${bullCount} Bullish</span> &bull; <span class="text-red">${bearCount} Bearish</span> &bull; Avg Confidence: <strong>${avgConf}%</strong>`;
      }
      if (grid && Array.isArray(data.results)) {
        grid.innerHTML = data.results.map((r) => {
          const isSetup = r.setup_detected;
          const cardClass = isSetup ? r.signal === "BULLISH" ? "strat-eval-card setup-active" : "strat-eval-card setup-bearish" : "strat-eval-card";
          const badgeClass = r.signal === "BULLISH" ? "strat-eval-badge strat-badge-bullish" : r.signal === "BEARISH" ? "strat-eval-badge strat-badge-bearish" : "strat-eval-badge strat-badge-neutral";
          const statusTag = isSetup ? "\u25CF SETUP ACTIVE" : "\u25CB NO SETUP";
          const conditionsHtml = Object.entries(r.conditions || {}).map(([k, v]) => {
            const tagClass = v ? "cond-tag cond-true" : "cond-tag cond-false";
            const icon = v ? "\u2713" : "\u2717";
            return `<span class="${tagClass}">${icon} ${esc(k.replace(/_/g, " "))}</span>`;
          }).join("");
          return `
                    <div class="${cardClass}">
                        <div class="strat-eval-header">
                            <div class="strat-eval-title">
                                <span class="${badgeClass}">${esc(r.signal)}</span>
                                <span class="strat-eval-name">${esc(r.strategy_name)}</span>
                            </div>
                            <div style="display:flex;align-items:center;gap:8px;">
                                <span style="font-size:11px;font-family:var(--font-mono);font-weight:600;color:${isSetup ? "var(--accent)" : "var(--text-3)"}">${statusTag}</span>
                                <span style="font-size:11px;font-family:var(--font-mono);color:var(--text-2);">${r.confidence.toFixed(
            1
          )}%</span>
                            </div>
                        </div>
                        <p class="strat-eval-reason">${esc(
            r.reasoning && r.reasoning[0] ? r.reasoning[0] : "Strategy criteria evaluated."
          )}</p>
                        ${conditionsHtml ? `<div class="strat-eval-conditions">${conditionsHtml}</div>` : ""}
                    </div>
                `;
        }).join("");
      }
    } catch (err) {
      console.error("[StrategyModal] Error:", err);
      if (tallyEl) tallyEl.innerHTML = `<span class="status-dot red-glow"></span> Evaluation failed: ${esc(err.message)}`;
      if (grid) grid.innerHTML = `<div style="padding:24px;text-align:center;color:var(--neg);font-size:12px;">Failed to evaluate strategies. ${esc(err.message)}</div>`;
    }
  }
  function openConsensusModal() {
    const modal = getElement("consensus-inspect-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    refreshConsensusModal();
  }
  function closeConsensusModal() {
    const modal = getElement("consensus-inspect-modal");
    if (modal) modal.classList.add("hidden");
  }
  async function refreshConsensusModal() {
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";
    const sub = getElement("consensus-modal-subtitle");
    if (sub) sub.textContent = `Synthesizing AI Agents & Quant Strategies for ${asset} (${tf})`;
    try {
      const data = await aiService.evaluateConsensus(asset, tf);
      const signal = data.signal || data.consensus_signal || "NEUTRAL";
      const confidence = data.confidence !== void 0 ? data.confidence : data.conviction_score || 0;
      safeText(getElement("consensus-primary-signal"), signal);
      safeText(getElement("consensus-agreement-score"), `${data.agreement_score.toFixed(1)}%`);
      safeText(getElement("consensus-time-badge"), `${data.execution_time_ms.toFixed(1)} ms`);
      const badge = getElement("consensus-primary-signal");
      if (badge) {
        badge.className = `consensus-status-badge ${signal === "BULLISH" ? "status-bullish" : signal === "BEARISH" ? "status-bearish" : "status-neutral"}`;
      }
      const bar = getElement("consensus-force-fill");
      if (bar) {
        bar.style.width = `${Math.min(100, Math.max(0, confidence))}%`;
        bar.style.backgroundColor = signal === "BULLISH" ? "var(--pos)" : signal === "BEARISH" ? "var(--neg)" : "var(--accent)";
      }
      const reasonEl = getElement("consensus-explanation-text");
      if (reasonEl) {
        reasonEl.textContent = data.rationale || data.institutional_view || "Consensus synthesized across quantitative engines.";
      }
    } catch (err) {
      console.error("[ConsensusModal] Error:", err);
    }
  }
  function openBrainModal() {
    const modal = getElement("brain-inspect-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    refreshBrainModal();
  }
  function closeBrainModal() {
    const modal = getElement("brain-inspect-modal");
    if (modal) modal.classList.add("hidden");
  }
  async function refreshBrainModal() {
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";
    const sub = getElement("brain-modal-subtitle");
    if (sub) sub.textContent = `Central Intelligence Orchestrator \u2022 ${asset} (${tf})`;
    try {
      const data = await aiService.analyzeBrain(asset, tf);
      safeText(getElement("brain-completeness-score"), `${data.completeness_score.toFixed(0)}%`);
      const price = data.market?.current_price ?? data.market_summary?.current_price;
      safeText(getElement("brain-market-price"), price !== void 0 ? `$${price.toLocaleString()}` : "\u2014");
      const lat = data.diagnostics?.execution_time_ms ?? data.diagnostics?.subsystem_latencies_ms?.total ?? 0;
      safeText(getElement("brain-time-badge"), `${lat.toFixed(1)} ms`);
      const bar = getElement("brain-completeness-fill");
      if (bar) bar.style.width = `${data.completeness_score}%`;
    } catch (err) {
      console.error("[BrainModal] Error:", err);
    }
  }
  function openRiskModal() {
    const modal = getElement("risk-guard-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    refreshRiskModal();
  }
  function closeRiskModal() {
    const modal = getElement("risk-guard-modal");
    if (modal) modal.classList.add("hidden");
  }
  async function refreshRiskModal() {
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";
    try {
      const data = await aiService.evaluateRisk(asset, tf);
      safeText(getElement("risk-score-value"), `${data.risk_score.toFixed(1)}`);
      safeText(getElement("risk-level-badge"), data.risk_level);
      const lat = data.diagnostics?.execution_time_ms ?? data.execution_time_ms ?? 0;
      safeText(getElement("risk-time-badge"), `${lat.toFixed(1)} ms`);
      const levelBadge = getElement("risk-level-badge");
      if (levelBadge) {
        levelBadge.className = `risk-badge ${data.risk_level === "LOW" ? "badge-green" : data.risk_level === "MODERATE" ? "badge-yellow" : "badge-red"}`;
      }
    } catch (err) {
      console.error("[RiskModal] Error:", err);
    }
  }
  function openOpportunityModal() {
    const modal = getElement("opportunity-eval-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    refreshOpportunityModal();
  }
  function closeOpportunityModal() {
    const modal = getElement("opportunity-eval-modal");
    if (modal) modal.classList.add("hidden");
  }
  async function refreshOpportunityModal() {
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";
    try {
      const data = await aiService.evaluateOpportunity(asset, tf);
      safeText(getElement("opp-score-value"), `${data.opportunity_score.toFixed(1)}`);
      safeText(getElement("opp-level-badge"), data.opportunity_level);
      const lat = data.diagnostics?.execution_time_ms ?? data.execution_time_ms ?? 0;
      safeText(getElement("opp-time-badge"), `${lat.toFixed(1)} ms`);
    } catch (err) {
      console.error("[OpportunityModal] Error:", err);
    }
  }
  function openDecisionModal() {
    const modal = getElement("decision-inspect-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    refreshDecisionModal();
  }
  function closeDecisionModal() {
    const modal = getElement("decision-inspect-modal");
    if (modal) modal.classList.add("hidden");
  }
  async function refreshDecisionModal() {
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";
    try {
      const data = await aiService.evaluateDecision(asset, tf);
      const stance = data.market_stance || data.stance || "NEUTRAL";
      const conf = data.decision_confidence !== void 0 ? data.decision_confidence : data.confidence || 0;
      safeText(getElement("decision-stance-badge"), stance);
      safeText(getElement("decision-confidence-val"), `${conf.toFixed(1)}%`);
      const lat = data.diagnostics?.execution_time_ms ?? data.execution_time_ms ?? 0;
      safeText(getElement("decision-time-badge"), `${lat.toFixed(1)} ms`);
    } catch (err) {
      console.error("[DecisionModal] Error:", err);
    }
  }
  function openExplainModal() {
    const modal = getElement("explain-eval-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    refreshExplainModal();
  }
  function closeExplainModal() {
    const modal = getElement("explain-eval-modal");
    if (modal) modal.classList.add("hidden");
  }
  async function refreshExplainModal() {
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";
    try {
      const data = await aiService.evaluateExplanation(asset, tf);
      const stance = data.input_summary?.market_stance || data.stance || "NEUTRAL";
      safeText(getElement("explain-stance-badge"), stance);
      safeText(getElement("explain-headline"), data.headline);
      const lat = data.diagnostics?.execution_time_ms ?? data.execution_time_ms ?? 0;
      safeText(getElement("explain-time-badge"), `${lat.toFixed(1)} ms`);
    } catch (err) {
      console.error("[ExplainModal] Error:", err);
    }
  }
  function initModalKeyboardListeners() {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeStrategyModal();
        closeConsensusModal();
        closeBrainModal();
        closeRiskModal();
        closeOpportunityModal();
        closeDecisionModal();
        closeExplainModal();
      }
    });
  }

  // src/ui/copilotController.ts
  var _copilotConversationId = null;
  var _copilotIsLoading = false;
  function openCopilotModal() {
    const modal = getElement("orbit-copilot-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";
    const badge = getElement("copilot-active-symbol-badge");
    if (badge) badge.textContent = `${asset} (${tf})`;
    const welcomeSym = getElement("copilot-welcome-symbol");
    if (welcomeSym) welcomeSym.textContent = asset;
    refreshCopilotContext(asset, tf);
    setTimeout(() => {
      const input = getElement("copilot-chat-input");
      if (input) input.focus();
    }, 150);
  }
  function closeCopilotModal() {
    const modal = getElement("orbit-copilot-modal");
    if (modal) modal.classList.add("hidden");
  }
  async function refreshCopilotContext(asset, tf) {
    const symbol = asset || store.get("currentAsset") || "BTC-USD";
    const timeframe = tf || store.get("currentTimeframe") || "1d";
    try {
      const d = await aiService.getCopilotContext(symbol, timeframe);
      const stanceEl = getElement("copilot-tel-stance");
      if (stanceEl) {
        stanceEl.textContent = d.decision_stance;
        stanceEl.className = `copilot-stance-tag ${(d.decision_stance || "").toLowerCase().replace(/_/g, "-")}`;
      }
      const confEl = getElement("copilot-tel-confidence");
      if (confEl) confEl.textContent = `${(d.confidence || 0).toFixed(1)}%`;
      const riskEl = getElement("copilot-tel-risk");
      if (riskEl) riskEl.textContent = `${d.risk_level} (${(d.risk_score || 0).toFixed(0)})`;
      const oppEl = getElement("copilot-tel-opportunity");
      if (oppEl) oppEl.textContent = `${(d.opportunity_score || 0).toFixed(0)}/100`;
    } catch (e) {
      console.warn("[Copilot] Error loading context telemetry:", e);
    }
  }
  function askCopilotPreset(query) {
    const input = getElement("copilot-chat-input");
    if (input) {
      input.value = query;
      sendCopilotMessage();
    }
  }
  function clearCopilotChat() {
    _copilotConversationId = null;
    const stream = getElement("copilot-chat-stream");
    const asset = store.get("currentAsset") || "BTC-USD";
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
  async function sendCopilotMessage() {
    if (_copilotIsLoading) return;
    const input = getElement("copilot-chat-input");
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const stream = getElement("copilot-chat-stream");
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";
    if (stream) {
      const userCard = document.createElement("div");
      userCard.className = "copilot-msg-card copilot-user";
      userCard.innerHTML = `
            <div class="copilot-msg-header">
                <i class="fa-solid fa-user text-cyan"></i>
                <strong>You</strong>
                <span class="copilot-msg-time">${(/* @__PURE__ */ new Date()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            <div class="copilot-msg-body">${esc(text)}</div>
        `;
      stream.appendChild(userCard);
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
    const sendBtn = getElement("copilot-send-btn");
    if (sendBtn) sendBtn.disabled = true;
    try {
      const d = await aiService.chatCopilot({
        message: text,
        symbol: asset,
        timeframe: tf,
        session_id: _copilotConversationId || void 0
      });
      const indicator = getElement("copilot-typing-indicator");
      if (indicator) indicator.remove();
      _copilotConversationId = d.session_id;
      const formattedAnswer = formatCopilotMarkdown(d.reply);
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
      if (stream) {
        stream.appendChild(asstCard);
        stream.scrollTop = stream.scrollHeight;
      }
    } catch (err) {
      console.error("[Copilot] Chat error:", err);
      const indicator = getElement("copilot-typing-indicator");
      if (indicator) indicator.remove();
      if (stream) {
        const errCard = document.createElement("div");
        errCard.className = "copilot-msg-card copilot-assistant";
        errCard.innerHTML = `
                <div class="copilot-msg-header">
                    <i class="fa-solid fa-triangle-exclamation text-red"></i>
                    <strong>ORBIT Copilot</strong>
                </div>
                <div class="copilot-msg-body text-red">Failed to communicate with AI Copilot: ${esc(err.message)}</div>
            `;
        stream.appendChild(errCard);
        stream.scrollTop = stream.scrollHeight;
      }
    } finally {
      _copilotIsLoading = false;
      if (sendBtn) sendBtn.disabled = false;
    }
  }
  function syncCopilotBalance() {
    const balanceEl = getElement("copilot-account-balance");
    const walletEl = getElement("wallet-balance");
    const overviewEl = getElement("overview-balance");
    if (balanceEl) {
      if (walletEl && walletEl.textContent?.trim()) {
        balanceEl.textContent = walletEl.textContent.replace("INR", "").trim();
      } else if (overviewEl && overviewEl.textContent?.trim()) {
        balanceEl.textContent = overviewEl.textContent.replace("INR", "").trim();
      } else {
        balanceEl.textContent = "\u20B910,00,000.00";
      }
    }
  }
  var _copilotPageSessionId = null;
  var _copilotPageIsLoading = false;
  var _copilotActiveAsset = "AAPL";
  var _copilotActiveMarket = "US Stocks";
  var _copilotActiveMode = "DETAILED";
  var _copilotSearchTimer = null;
  var _copilotLoadingInterval = null;
  async function loadConversationsList() {
    const listEl = getElement("copilot-history-list");
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
      const now = /* @__PURE__ */ new Date();
      const todayStr = now.toDateString();
      const yest = new Date(now);
      yest.setDate(yest.getDate() - 1);
      const yestStr = yest.toDateString();
      const groups = {
        today: [],
        yesterday: [],
        older: []
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
                    ${items.map((c) => {
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
        }).join("")}
                </div>
            `;
      };
      html += renderGroup("TODAY", groups.today);
      html += renderGroup("YESTERDAY", groups.yesterday);
      html += renderGroup("OLDER", groups.older);
      listEl.innerHTML = html;
    } catch (err) {
      console.warn("[Copilot] Error loading conversations:", err);
    }
  }
  async function selectConversation(convId) {
    if (!convId) return;
    _copilotPageSessionId = convId;
    try {
      const res = await fetch(`/api/chat/conversations/${convId}`);
      if (!res.ok) throw new Error("Conversation not found");
      const json = await res.json();
      const conversation = json.data;
      const messages = conversation.messages || [];
      if (conversation.selected_asset) {
        _copilotActiveAsset = conversation.selected_asset;
      }
      if (conversation.selected_market) {
        _copilotActiveMarket = conversation.selected_market;
        const mktSelect = getElement("copilot-market-select");
        if (mktSelect) mktSelect.value = _copilotActiveMarket;
      }
      updateActiveAssetBanner(_copilotActiveAsset, _copilotActiveMarket);
      const messagesBox = getElement("copilot-page-messages");
      if (messagesBox) {
        messagesBox.innerHTML = "";
        if (messages.length > 0) {
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
      syncCopilotPageView();
      loadConversationsList();
    } catch (err) {
      console.warn("Error selecting conversation:", err);
    }
  }
  function createNewAnalysis() {
    _copilotPageSessionId = null;
    const messagesBox = getElement("copilot-page-messages");
    if (messagesBox) messagesBox.innerHTML = "";
    syncCopilotPageView();
    loadConversationsList();
    const input = getElement("copilot-page-input");
    if (input) input.focus();
  }
  function toggleCopilotSidebar() {
    const sidebar = document.querySelector(".copilot-history-sidebar");
    const container = document.querySelector(".copilot-terminal-container");
    const openBtn = getElement("copilot-sidebar-open-tab");
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
  function onCopilotMarketChange(marketVal) {
    _copilotActiveMarket = marketVal;
    updateActiveAssetBanner(_copilotActiveAsset, marketVal);
    const searchInput = getElement("copilot-asset-search");
    if (searchInput) searchInput.placeholder = `Search in ${marketVal}...`;
  }
  function updateActiveAssetBanner(sym, market, name) {
    const titleEl = getElement("copilot-active-asset-title");
    const exchEl = getElement("copilot-active-asset-exchange");
    const symBadge = getElement("copilot-page-symbol");
    if (titleEl) titleEl.innerHTML = `${esc(sym)} &bull; <span>${esc(name || sym)}</span>`;
    if (exchEl) exchEl.textContent = `${esc(market || _copilotActiveMarket)}`;
    if (symBadge) symBadge.textContent = esc(sym);
  }
  function onAssetSearchInput(query) {
    clearTimeout(_copilotSearchTimer);
    const dropdown = getElement("copilot-search-dropdown");
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
        const results = json.data && json.data.results || json.results || (Array.isArray(json.data) ? json.data : []) || [];
        if (results.length === 0) {
          dropdown.innerHTML = `<div class="copilot-search-empty">No matching assets found</div>`;
          return;
        }
        dropdown.innerHTML = results.slice(0, 8).map(
          (r) => `
                <div class="copilot-search-item" onclick="selectAsset('${esc(r.symbol)}', '${esc(r.name)}', '${esc(r.exchange)}')">
                    <div class="copilot-search-item-left">
                        <span class="copilot-search-item-sym">${esc(r.symbol)}</span>
                        <span class="copilot-search-item-name">${esc(r.name)}</span>
                    </div>
                    <div class="copilot-search-item-right">${esc(r.exchange || r.type)}</div>
                </div>
            `
        ).join("");
      } catch {
        dropdown.innerHTML = `<div class="copilot-search-empty text-ruby">Search temporarily unavailable</div>`;
      }
    }, 280);
  }
  function selectAsset(symbol, name, exchange) {
    _copilotActiveAsset = symbol.trim().toUpperCase();
    if (exchange) _copilotActiveMarket = exchange;
    updateActiveAssetBanner(_copilotActiveAsset, exchange || _copilotActiveMarket, name);
    const dropdown = getElement("copilot-search-dropdown");
    if (dropdown) dropdown.classList.add("hidden");
    const searchInput = getElement("copilot-asset-search");
    if (searchInput) searchInput.value = "";
    syncCopilotPageView();
  }
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
  async function syncCopilotPageView() {
    const symBadge = getElement("copilot-page-symbol");
    const statusBadge = getElement("copilot-page-analysis-status");
    const stanceEl = getElement("copilot-page-stance");
    const confEl = getElement("copilot-page-confidence");
    const riskEl = getElement("copilot-page-risk");
    const oppEl = getElement("copilot-page-opportunity");
    const setupsEl = getElement("copilot-page-setups");
    const messagesBox = getElement("copilot-page-messages");
    syncCopilotBalance();
    const activeSym = _copilotActiveAsset || store.get("currentAsset") || "AAPL";
    _copilotActiveAsset = activeSym;
    if (symBadge) symBadge.textContent = esc(activeSym);
    try {
      const tf = store.get("currentTimeframe") || "1d";
      const d = await aiService.getCopilotContext(activeSym, tf);
      if (statusBadge) {
        statusBadge.className = "copilot-status-badge live";
        statusBadge.innerHTML = '<span class="copilot-status-pulse"></span> Pipeline Live';
      }
      if (stanceEl) {
        stanceEl.textContent = d.decision_stance || "NEUTRAL";
        stanceEl.className = `copilot-metric-pill stance-${(d.decision_stance || "").toLowerCase()}`;
      }
      if (confEl) confEl.textContent = `${Number(d.confidence || 0).toFixed(1)}%`;
      if (riskEl) {
        riskEl.textContent = `${d.risk_level || "MODERATE"} (${Number(d.risk_score || 0).toFixed(0)})`;
        riskEl.className = `copilot-metric-pill risk-${(d.risk_level || "").toLowerCase()}`;
      }
      if (oppEl) {
        oppEl.textContent = `${Number(d.opportunity_score || 0).toFixed(0)}/100`;
        oppEl.className = `copilot-metric-pill opp-${(d.opportunity_level || "").toLowerCase()}`;
      }
      if (setupsEl) {
        const count = d.active_setups?.length || 0;
        setupsEl.textContent = `${count} Active`;
      }
      if (messagesBox && messagesBox.childElementCount === 0) {
        const welcomeCard = document.createElement("div");
        welcomeCard.className = "copilot-page-msg-card orbit";
        welcomeCard.innerHTML = `
                <div class="copilot-page-msg-header">
                    <i class="fa-solid fa-robot text-emerald"></i>
                    <strong>ORBIT Copilot</strong>
                    <span>&bull; ${activeSym} Context Active</span>
                </div>
                <div class="copilot-page-msg-body">
                    <p>Connected to <strong>${esc(activeSym)}</strong> in <strong>${esc(_copilotActiveMarket)}</strong> via Alpha Vantage and ORBIT analytical pipeline.</p>
                    <p>Current Stance: <strong>${d.decision_stance}</strong> (${Number(d.confidence).toFixed(1)}% Confidence).<br>
                    Analytical Risk is <strong>${d.risk_level}</strong> (${Number(d.risk_score).toFixed(1)}/100) and Opportunity is <strong>${Number(d.opportunity_score).toFixed(1)}/100</strong>.</p>
                    <p>Ask any question about <strong>${esc(activeSym)}</strong> or choose a suggested question above.</p>
                </div>
            `;
        messagesBox.appendChild(welcomeCard);
      }
    } catch {
      if (statusBadge) {
        statusBadge.className = "copilot-status-badge not-available";
        statusBadge.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Ready';
      }
    }
  }
  async function sendCopilotPageMessage() {
    if (_copilotPageIsLoading) return;
    const input = getElement("copilot-page-input");
    const sendBtn = getElement("copilot-page-send-btn");
    const loadingBar = getElement("copilot-page-loading");
    const loadingText = getElement("copilot-loading-text");
    const errorBanner = getElement("copilot-page-error");
    const messagesBox = getElement("copilot-page-messages");
    const message = input ? input.value.trim() : "";
    if (!message) return;
    const activeSym = _copilotActiveAsset || "AAPL";
    if (messagesBox) {
      const userCard = document.createElement("div");
      userCard.className = "copilot-page-msg-card user";
      userCard.innerHTML = `
            <div class="copilot-page-msg-header">
                <i class="fa-solid fa-user"></i>
                <strong>You</strong>
                <span>&bull; ${(/* @__PURE__ */ new Date()).toLocaleTimeString()}</span>
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
    const stages = [
      "Loading market data from Alpha Vantage...",
      "Analyzing market context & indicators...",
      "Evaluating risk guard & consensus...",
      "Generating ORBIT analytical view..."
    ];
    let stageIdx = 0;
    if (loadingText) loadingText.textContent = stages[0];
    clearInterval(_copilotLoadingInterval);
    _copilotLoadingInterval = setInterval(() => {
      stageIdx = (stageIdx + 1) % stages.length;
      if (loadingText) loadingText.textContent = stages[stageIdx];
    }, 1500);
    try {
      const tf = store.get("currentTimeframe") || "1d";
      const d = await aiService.chatCopilot({
        message,
        symbol: activeSym,
        timeframe: tf,
        session_id: _copilotPageSessionId || void 0,
        response_mode: _copilotActiveMode
      });
      clearInterval(_copilotLoadingInterval);
      if (loadingBar) loadingBar.classList.add("hidden");
      _copilotPageSessionId = d.session_id;
      if (messagesBox) {
        const orbitCard = document.createElement("div");
        orbitCard.className = "copilot-page-msg-card orbit";
        const latencyTag = d.latency_ms ? `<span>&bull; ${d.latency_ms}ms</span>` : "";
        orbitCard.innerHTML = `
                <div class="copilot-page-msg-header">
                    <i class="fa-solid fa-robot text-emerald"></i>
                    <strong>ORBIT Copilot</strong>
                    ${latencyTag}
                </div>
                <div class="copilot-page-msg-body">${formatCopilotMarkdown(d.reply)}</div>
            `;
        messagesBox.appendChild(orbitCard);
        messagesBox.scrollTop = messagesBox.scrollHeight;
      }
      loadConversationsList();
    } catch (err) {
      clearInterval(_copilotLoadingInterval);
      if (loadingBar) loadingBar.classList.add("hidden");
      if (errorBanner) {
        const errMsg = getElement("copilot-page-error-msg");
        if (errMsg) errMsg.textContent = `ORBIT Copilot notice: ${err.message}`;
        errorBanner.classList.remove("hidden");
      }
    } finally {
      _copilotPageIsLoading = false;
      if (sendBtn) sendBtn.disabled = false;
    }
  }
  function askCopilotPagePreset(query) {
    const input = getElement("copilot-page-input");
    if (input) {
      input.value = query;
      sendCopilotPageMessage();
    }
  }
  function clearCopilotPageChat() {
    createNewAnalysis();
  }

  // src/ui/reportsController.ts
  var reportData = null;
  var CHART = {
    green: "#3fb950",
    red: "#e5484d",
    cyan: "#4d7cfe",
    purple: "#a371f7",
    yellow: "#d29922",
    grid: "rgba(255,255,255,0.06)",
    axis: "rgba(255,255,255,0.22)",
    text: "#9ba2ad"
  };
  function emptyChart(message) {
    return `<div class="report-chart-empty"><i class="fa-solid fa-chart-line"></i><span>${esc(message)}</span></div>`;
  }
  function renderEquityCurve(curve) {
    const host = getElement("chart-equity");
    if (!host) return;
    if (!curve || curve.length === 0) {
      host.innerHTML = emptyChart("No closed trades yet \u2014 the equity curve appears once trades settle.");
      return;
    }
    const W = 1e3, H = 300, padL = 92, padR = 26, padT = 22, padB = 38;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const values = curve.map((p) => p.cumulative || p.pnl || 0);
    let min = Math.min(0, ...values);
    let max = Math.max(0, ...values);
    if (min === max) max = min + 1;
    const span = max - min;
    const x = (i) => padL + (curve.length === 1 ? plotW / 2 : i / (curve.length - 1) * plotW);
    const y = (v) => padT + plotH - (v - min) / span * plotH;
    const points = curve.map((p, i) => `${x(i).toFixed(1)},${y(p.cumulative || p.pnl || 0).toFixed(1)}`).join(" ");
    host.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="report-svg" role="img">
            <polyline fill="none" stroke="${CHART.green}" stroke-width="2" points="${points}" />
        </svg>
    `;
  }
  async function loadReport() {
    const userId = store.get("currentUserId");
    if (!userId) return;
    const reportGenerated = getElement("report-generated");
    const reportTableBody = getElement("report-table-body");
    if (reportGenerated) reportGenerated.textContent = "Generating...";
    try {
      const payload = await portfolioService.getReport(userId);
      reportData = payload;
      if (reportGenerated) {
        safeText(reportGenerated, `Generated ${(/* @__PURE__ */ new Date()).toLocaleTimeString()}`);
      }
      const trades = payload.trades || [];
      if (reportTableBody) {
        if (trades.length === 0) {
          reportTableBody.innerHTML = `<tr><td colspan="12" class="report-empty">No trades found.</td></tr>`;
        } else {
          reportTableBody.innerHTML = trades.slice(0, 50).map((t) => {
            const pnl = Number(t.realized_pnl !== void 0 ? t.realized_pnl : t.pnl || 0);
            const pnlClass = pnl > 0 ? "text-green" : pnl < 0 ? "text-red" : "";
            return `
                        <tr>
                            <td><strong>${esc(t.asset || t.symbol)}</strong></td>
                            <td>${formatINR(t.entry_price || 0)}</td>
                            <td>${formatINR(t.exit_price || 0)}</td>
                            <td>${Number(t.quantity || 1)}</td>
                            <td class="${pnlClass}"><strong>${pnl >= 0 ? "+" : ""}${formatINR(pnl)}</strong></td>
                            <td>${t.closed_at || t.timestamp ? new Date(t.closed_at || t.timestamp).toLocaleDateString() : "\u2014"}</td>
                        </tr>
                    `;
          }).join("");
        }
      }
      renderEquityCurve(payload.chart_data || []);
    } catch (err) {
      console.error("[Reports] Error loading report:", err);
      if (reportGenerated) reportGenerated.textContent = "Could not load report";
      if (reportTableBody) {
        reportTableBody.innerHTML = `<tr><td colspan="12" class="report-empty text-red">Failed to load report: ${esc(err.message)}</td></tr>`;
      }
    }
  }
  function exportReportCsv() {
    if (!reportData || !reportData.trades || reportData.trades.length === 0) {
      alert("No trade data available to export.");
      return;
    }
    const trades = reportData.trades;
    const headers = ["ID", "Asset", "Side", "Quantity", "Entry Price", "Exit Price", "P&L", "Status", "Date"];
    const rows = trades.map((t) => [
      t.id,
      t.asset || t.symbol,
      t.side || t.type,
      t.quantity,
      t.entry_price,
      t.exit_price || "",
      t.realized_pnl || t.pnl || 0,
      t.status,
      t.closed_at || t.timestamp || ""
    ]);
    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map((e) => e.map((x) => `"${x}"`).join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `orbit_trades_report_${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
  function exportReportJson() {
    if (!reportData) {
      alert("No trade data available to export.");
      return;
    }
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(reportData, null, 2));
    const link = document.createElement("a");
    link.setAttribute("href", dataStr);
    link.setAttribute("download", `orbit_report_${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
  function initReportsListeners() {
    getElement("report-refresh-btn")?.addEventListener("click", () => loadReport());
    getElement("report-export-csv")?.addEventListener("click", () => exportReportCsv());
    getElement("report-export-json")?.addEventListener("click", () => exportReportJson());
  }

  // src/ui/landingController.ts
  var ULTIMATE_SKILLS_DATA = [
    {
      id: "ultimate-frontend-design",
      name: "UI/UX Pro Max & Frontend Taste",
      category: "frontend",
      icon: "fa-palette",
      iconColor: "skill-icon-purple",
      desc: "Enforces visual balance, curated color palettes, clean typography, whitespace discipline, and eliminates generic aesthetics.",
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
      rules: "1. Geometry Pooling: Re-use buffer geometries to prevent GC hitches.\n2. Instanced Rendering: Lightweight box/tube batches for 100+ candlesticks.\n3. Fog & Depth: FogExp2 for atmospheric lighting.\n4. Parallax: Mouse coordinate interpolation via Lerp."
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
      rules: "1. Connection Pooling: Efficient connection management with timeouts.\n2. Automated Migrations: Auto-create tables (trades, users, logs) at server startup.\n3. Dual-Persistence: Seamless fallback to SQLite3 when DATABASE_URL is absent."
    },
    {
      id: "ultimate-state-management",
      name: "State Management & Live Stores",
      category: "backend",
      icon: "fa-boxes-stacked",
      iconColor: "skill-icon-yellow",
      desc: "Manages complex frontend and backend state, reactive stores, cache invalidation, and synchronized trade journals.",
      rules: "1. Single Source of Truth: Centralized application state.\n2. Optimistic Updates: Immediate UI reflection on trade trigger followed by backend confirmation."
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
      rules: "1. Mathematical Rigor: Verify indicator formulas against benchmark data.\n2. Headless E2E: Automated tests validating login, order placement, and chart rendering."
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
  var STRATEGIES_DATA = [
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
      formula: "Squeeze(BandWidth < 0.05) + Close > UpperBand",
      desc: "Detects extreme volatility contraction followed by high-volume range expansion piercing the upper standard deviation envelope.",
      trigger: "Trigger: Squeeze breakout candle closing outside envelope"
    },
    {
      id: "08",
      name: "Mean Reversion (RSI Extreme)",
      type: "Statistical",
      formula: "RSI(14) < 25 OR > 75 + Bollinger 2.5 SD",
      desc: "Statistical counter-trend reversion system fading exhaustion extremes when RSI diverges at 2.5-sigma envelope boundaries.",
      trigger: "Trigger: RSI curl back from sub-25 or supra-75 extreme"
    },
    {
      id: "09",
      name: "VWAP Institutional Anchors",
      type: "Benchmark",
      formula: "Price vs Session VWAP +/- 1.5 SD Bands",
      desc: "Tracks institutional execution benchmarking; triggers on test of dynamic volume-weighted standard deviation bands.",
      trigger: "Trigger: Retest of -1.5 SD band with volume confirmation"
    },
    {
      id: "10",
      name: "Fibonacci Confluence Matrix",
      type: "Geometry",
      formula: "Retracement 61.8% + Extension 161.8%",
      desc: "Algorithmic multi-swing harmonic overlap clustering identifying golden pocket zones where multiple fibonacci levels intersect.",
      trigger: "Trigger: Rejection candle at 61.8% golden pocket confluence"
    },
    {
      id: "11",
      name: "Liquidity Grab (Stop Hunt)",
      type: "Auction Theory",
      formula: "Sweep of Previous Day High/Low + Rejection",
      desc: "Capitalizes on institutional sweeps of retail stop-loss clusters resting above yesterday's high or below yesterday's low.",
      trigger: "Trigger: Sharp false break of PDH/PDL returning into range"
    },
    {
      id: "12",
      name: "Momentum Divergence (MACD)",
      type: "Indicator",
      formula: "Lower Low in Price + Higher Low in MACD Hist",
      desc: "Identifies exhaustion in the prevailing trend when market velocity slows before structural price reversal occurs.",
      trigger: "Trigger: MACD histogram bullish/bearish crossover divergence"
    }
  ];
  function renderSkills(category = "all") {
    const grid = getElement("skills-grid");
    if (!grid) return;
    const filtered = category === "all" ? ULTIMATE_SKILLS_DATA : ULTIMATE_SKILLS_DATA.filter((s) => s.category === category);
    grid.innerHTML = filtered.map((s) => `
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
    const grid = getElement("strategies-grid");
    if (!grid) return;
    grid.innerHTML = STRATEGIES_DATA.map((st) => `
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
    document.querySelectorAll(".skill-tab").forEach((b) => b.classList.remove("active"));
    if (buttonEl) buttonEl.classList.add("active");
    renderSkills(category);
  }
  function openSkillModal(skillId) {
    const skill = ULTIMATE_SKILLS_DATA.find((s) => s.id === skillId);
    if (!skill) return;
    const modal = getElement("skill-detail-modal");
    const tagEl = getElement("modal-skill-tag");
    const titleEl = getElement("modal-skill-title");
    const descEl = getElement("modal-skill-desc");
    const rulesEl = getElement("modal-skill-rules");
    if (tagEl) tagEl.textContent = skill.category.toUpperCase();
    if (titleEl) titleEl.textContent = skill.name;
    if (descEl) descEl.textContent = skill.desc;
    if (rulesEl) rulesEl.textContent = skill.rules.replace(/\\n/g, "\n");
    if (modal) modal.classList.remove("hidden");
  }
  function closeSkillModal() {
    const modal = getElement("skill-detail-modal");
    if (modal) modal.classList.add("hidden");
  }
  function triggerAiSimulationDemo() {
    const modal = getElement("ai-simulation-modal");
    if (modal) modal.classList.remove("hidden");
    for (let i = 1; i <= 6; i++) {
      const stepEl = getElement(`sim-step-${i}`);
      if (stepEl) {
        stepEl.style.opacity = "0.2";
        setTimeout(() => {
          stepEl.style.opacity = "1";
          stepEl.style.transform = "translateX(4px)";
          setTimeout(() => {
            stepEl.style.transform = "translateX(0)";
          }, 200);
        }, i * 350);
      }
    }
  }
  function closeSimModal() {
    const modal = getElement("ai-simulation-modal");
    if (modal) modal.classList.add("hidden");
  }
  function drawBtcSparkline() {
    const canvas = getElement("btc-sparkline-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    const points = [14, 18, 16, 22, 20, 26, 24, 30, 28, 35, 32, 40, 38, 44];
    const maxVal = Math.max(...points);
    const minVal = Math.min(...points);
    ctx.clearRect(0, 0, width, height);
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "rgba(52, 211, 153, 0.3)");
    gradient.addColorStop(1, "rgba(52, 211, 153, 0.0)");
    ctx.beginPath();
    const stepX = width / (points.length - 1);
    points.forEach((val, i) => {
      const x = i * stepX;
      const normalizedY = (val - minVal) / (maxVal - minVal);
      const y = height - 6 - normalizedY * (height - 12);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.beginPath();
    points.forEach((val, i) => {
      const x = i * stepX;
      const normalizedY = (val - minVal) / (maxVal - minVal);
      const y = height - 6 - normalizedY * (height - 12);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#34d399";
    ctx.lineWidth = 2.5;
    ctx.shadowColor = "#34d399";
    ctx.shadowBlur = 8;
    ctx.stroke();
  }
  function initLandingShowcase() {
    renderSkills("all");
    renderStrategies();
    drawBtcSparkline();
  }

  // src/three/scene.ts
  var ThreeSceneController = class {
    scene = null;
    camera = null;
    renderer = null;
    candleGroup = null;
    particleSystem = null;
    mouseX = 0;
    mouseY = 0;
    is3DRunning = false;
    candles = [];
    lastTimestamp = 0;
    bullishMat = null;
    bearishMat = null;
    wickBullMat = null;
    wickBearMat = null;
    windowHalfX = window.innerWidth / 2;
    windowHalfY = window.innerHeight / 2;
    constructor() {
      this.onDocumentMouseMove = this.onDocumentMouseMove.bind(this);
      this.onWindowResize = this.onWindowResize.bind(this);
      this.animate3D = this.animate3D.bind(this);
    }
    getChartBaseY(x) {
      const leftWave = 6.2 * Math.exp(-Math.pow((x + 21) / 9.5, 2));
      const rightSurge = 18.5 / (1 + Math.exp(-(x - 14) / 3.4));
      const centerDip = -7.2 * Math.exp(-Math.pow((x - 0.5) / 10.2, 2));
      return leftWave + rightSurge + centerDip - 4.8;
    }
    init() {
      const canvas = getElement("three-canvas");
      if (!canvas) return;
      const THREE = window.THREE;
      if (!THREE) {
        console.warn("[ThreeScene] Three.js not loaded from CDN.");
        return;
      }
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(132102);
      this.scene.fog = new THREE.FogExp2(132102, 9e-3);
      this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 1e3);
      this.updateCameraFraming();
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.toneMapping = THREE.LinearToneMapping;
      this.renderer.toneMappingExposure = 1.15;
      this.setupSceneLighting();
      this.initCandleMaterials();
      this.buildCandlesticks();
      this.buildParticles();
      document.addEventListener("mousemove", this.onDocumentMouseMove, { passive: true });
      window.addEventListener("resize", this.onWindowResize, { passive: true });
    }
    initCandleMaterials() {
      const THREE = window.THREE;
      this.bullishMat = new THREE.MeshStandardMaterial({
        color: 58998,
        emissive: 51283,
        emissiveIntensity: 0.52,
        roughness: 0.24,
        metalness: 0.08,
        transparent: false
      });
      this.bearishMat = new THREE.MeshStandardMaterial({
        color: 13959168,
        emissive: 16717636,
        emissiveIntensity: 0.45,
        roughness: 0.28,
        metalness: 0.08,
        transparent: false
      });
      this.wickBullMat = new THREE.MeshBasicMaterial({ color: 65416 });
      this.wickBearMat = new THREE.MeshBasicMaterial({ color: 16726832 });
    }
    setupSceneLighting() {
      const THREE = window.THREE;
      const ambientLight = new THREE.AmbientLight(725792, 0.48);
      this.scene.add(ambientLight);
      const dirLight = new THREE.DirectionalLight(16777215, 0.4);
      dirLight.position.set(6, 28, 22);
      this.scene.add(dirLight);
      const rightEmeraldLight = new THREE.PointLight(58998, 2.4, 55);
      rightEmeraldLight.position.set(22, 10, 8);
      this.scene.add(rightEmeraldLight);
      const leftEmeraldLight = new THREE.PointLight(58998, 2, 48);
      leftEmeraldLight.position.set(-20, 6, 8);
      this.scene.add(leftEmeraldLight);
      const centerWhiteGreenLight = new THREE.PointLight(8454100, 2.6, 52);
      centerWhiteGreenLight.position.set(0, -10, 9);
      this.scene.add(centerWhiteGreenLight);
      const rubyLight = new THREE.PointLight(15680580, 1.4, 40);
      rubyLight.position.set(8, -2, 6);
      this.scene.add(rubyLight);
    }
    createGlowParticleTexture() {
      const THREE = window.THREE;
      const pCanvas = document.createElement("canvas");
      pCanvas.width = 32;
      pCanvas.height = 32;
      const ctx = pCanvas.getContext("2d");
      if (!ctx) return null;
      const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
      grad.addColorStop(0, "rgba(255, 255, 255, 1)");
      grad.addColorStop(0.22, "rgba(180, 255, 220, 0.9)");
      grad.addColorStop(0.55, "rgba(0, 230, 138, 0.32)");
      grad.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 32, 32);
      return new THREE.CanvasTexture(pCanvas);
    }
    buildParticles() {
      const THREE = window.THREE;
      const particleCount = 200;
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(particleCount * 3);
      const colors = new Float32Array(particleCount * 3);
      for (let i = 0; i < particleCount; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 94;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 44;
        positions[i * 3 + 2] = -5 + (Math.random() - 0.5) * 16;
        const rand = Math.random();
        if (rand < 0.45) {
          colors[i * 3] = 0.88;
          colors[i * 3 + 1] = 1;
          colors[i * 3 + 2] = 0.94;
        } else if (rand < 0.82) {
          colors[i * 3] = 0;
          colors[i * 3 + 1] = 0.96;
          colors[i * 3 + 2] = 0.58;
        } else {
          colors[i * 3] = 0.98;
          colors[i * 3 + 1] = 0.32;
          colors[i * 3 + 2] = 0.42;
        }
      }
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const pMaterial = new THREE.PointsMaterial({
        size: 0.42,
        map: this.createGlowParticleTexture(),
        vertexColors: true,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      this.particleSystem = new THREE.Points(geometry, pMaterial);
      this.scene.add(this.particleSystem);
    }
    buildCandlesticks() {
      const THREE = window.THREE;
      this.candleGroup = new THREE.Group();
      this.candles = [];
      const totalSpan = 88;
      const stepX = 0.96;
      const candleCount = Math.floor(totalSpan / stepX);
      const startX = -totalSpan / 2;
      const candleW = 0.56;
      const candleD = 0.46;
      const pattern = [
        true,
        true,
        false,
        true,
        false,
        false,
        true,
        true,
        true,
        false,
        true,
        false,
        true,
        true,
        false,
        false,
        false,
        true,
        true,
        false,
        true,
        true,
        true,
        false,
        false,
        true,
        false,
        true,
        true,
        true,
        true,
        false,
        false,
        true,
        true,
        true,
        false,
        true,
        false,
        true,
        true,
        true,
        false,
        false,
        true,
        true,
        true,
        true,
        false,
        true
      ];
      for (let i = 0; i < candleCount; i++) {
        const x = startX + i * stepX;
        const isBullish = pattern[i % pattern.length];
        let bodyH = 2 + Math.abs(Math.sin(i * 0.68)) * 3.2;
        if (i % 7 === 0) bodyH = 6.4;
        if (i % 4 === 0) bodyH = 4.5;
        if (i % 5 === 0) bodyH = 1.2;
        const singleCandle = new THREE.Group();
        const bodyMaterial = isBullish ? this.bullishMat : this.bearishMat;
        const wickMaterial = isBullish ? this.wickBullMat : this.wickBearMat;
        const bodyGeom = new THREE.BoxGeometry(candleW, bodyH, candleD);
        const bodyMesh = new THREE.Mesh(bodyGeom, bodyMaterial);
        singleCandle.add(bodyMesh);
        const wickLen = bodyH + 2.4 + i % 3 * 1;
        const wickGeom = new THREE.CylinderGeometry(0.038, 0.038, wickLen, 6);
        const wickMesh = new THREE.Mesh(wickGeom, wickMaterial);
        singleCandle.add(wickMesh);
        const z = -2.5 + Math.sin(i * 0.45) * 1.2;
        const initialY = this.getChartBaseY(x);
        singleCandle.position.set(x, initialY, z);
        this.candleGroup.add(singleCandle);
        this.candles.push({
          group: singleCandle,
          bodyMesh,
          x,
          z,
          bodyH,
          isBullish,
          bobSpeed: 0.65 + i % 5 * 0.15,
          bobPhase: i * 0.55,
          bobAmp: 0.28 + i % 4 * 0.1
        });
      }
      this.scene.add(this.candleGroup);
    }
    updateCameraFraming() {
      if (!this.camera) return;
      const isMobile = window.innerWidth < 960;
      if (isMobile) {
        this.camera.position.set(0, 0.5, 58);
        this.camera.lookAt(0, 0.5, 0);
      } else {
        this.camera.position.set(0, 0.8, 46);
        this.camera.lookAt(0, 0.8, 0);
      }
    }
    onDocumentMouseMove(event) {
      this.mouseX = (event.clientX - this.windowHalfX) / this.windowHalfX;
      this.mouseY = (event.clientY - this.windowHalfY) / this.windowHalfY;
    }
    onWindowResize() {
      if (!this.camera || !this.renderer) return;
      this.windowHalfX = window.innerWidth / 2;
      this.windowHalfY = window.innerHeight / 2;
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.updateCameraFraming();
    }
    animate3D(time) {
      if (!this.is3DRunning) return;
      requestAnimationFrame(this.animate3D);
      if (!this.renderer || !this.scene || !this.camera) return;
      const delta = this.lastTimestamp && time > this.lastTimestamp ? Math.min((time - this.lastTimestamp) * 1e-3, 0.05) : 0.016;
      this.lastTimestamp = time;
      const elapsed = time * 1e-3;
      const driftSpeed = 1.05;
      const minBoundX = -44;
      const maxBoundX = 44;
      const span = maxBoundX - minBoundX;
      for (let i = 0; i < this.candles.length; i++) {
        const c = this.candles[i];
        c.x -= driftSpeed * delta;
        if (c.x < minBoundX) c.x += span;
        const baseY = this.getChartBaseY(c.x);
        const bob = Math.sin(elapsed * c.bobSpeed + c.bobPhase) * c.bobAmp;
        c.group.position.x = c.x;
        c.group.position.y = baseY + bob;
      }
      if (this.particleSystem) {
        this.particleSystem.rotation.y = elapsed * 0.016;
        this.particleSystem.rotation.x = Math.sin(elapsed * 0.18) * 0.012;
        this.particleSystem.position.y = Math.sin(elapsed * 0.28) * 0.45;
      }
      if (this.candleGroup) {
        this.candleGroup.rotation.y = this.mouseX * 0.035;
        this.candleGroup.rotation.x = -this.mouseY * 0.02;
      }
      const isMobile = window.innerWidth < 960;
      const targetCamX = isMobile ? 0 : this.mouseX * 1.8;
      const targetCamY = isMobile ? 0.5 : 0.8 - this.mouseY * 0.8;
      this.camera.position.x += (targetCamX - this.camera.position.x) * 0.05;
      this.camera.position.y += (targetCamY - this.camera.position.y) * 0.05;
      this.renderer.render(this.scene, this.camera);
    }
    start() {
      if (document.body.classList.contains("in-dashboard") || window.location.hash.includes("dashboard")) {
        this.stop();
        return;
      }
      const canvas = getElement("three-canvas");
      if (canvas) canvas.style.display = "block";
      const THREE = window.THREE;
      if (!THREE) {
        window.addEventListener("load", () => this.start(), { once: true });
        setTimeout(() => this.start(), 150);
        return;
      }
      if (!this.scene) {
        this.init();
      }
      if (!this.is3DRunning) {
        this.is3DRunning = true;
        this.onWindowResize();
        this.lastTimestamp = performance.now();
        requestAnimationFrame(this.animate3D);
      }
    }
    stop() {
      this.is3DRunning = false;
      const canvas = getElement("three-canvas");
      if (canvas) canvas.style.display = "none";
    }
  };
  var threeController = new ThreeSceneController();

  // src/index.ts
  var w = window;
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
  w.switchToTab = switchToTab;
  w.setTimeframe = setTimeframe;
  w.selectStock = selectStock;
  w.initChart = initChart;
  w.drawChartOverlay = drawChartOverlay;
  w.confirmTrade = confirmTrade;
  w.rejectTrade = rejectTrade;
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
  w.loadReport = loadReport;
  w.exportReportCsv = exportReportCsv;
  w.exportReportJson = exportReportJson;
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
  w.formatINR = formatINR;
  w.esc = esc;
  if (!w.aether3D) {
    w.aether3D = {
      stop: () => threeController.stop(),
      start: () => threeController.start()
    };
  }
  if (!w.stop3D) w.stop3D = () => w.aether3D?.stop ? w.aether3D.stop() : threeController.stop();
  if (!w.start3D) w.start3D = () => w.aether3D?.start ? w.aether3D.start() : threeController.start();
  function setupWebSocketSubscriptions() {
    const sockets = store.sockets;
    sockets.on("tick", (msg) => {
      const price = msg.data?.price || (msg.candle ? msg.candle.close : null);
      if (price !== null && price !== void 0) {
        const legendPrice = getElement("legend-price");
        if (legendPrice) legendPrice.textContent = formatINR(price);
      }
    });
    sockets.on("log", (msg) => {
      if (msg.agent && msg.message) {
        logToTerminal(msg.agent, msg.message, msg.time);
        updateAgentStatusUI(msg.agent, msg.message);
      }
    });
    sockets.on("positions_updated", () => {
      loadOpenTrades();
      fetchDashboardSummary();
    });
    sockets.on("dashboard_summary", (msg) => {
      if (msg.data) {
        store.set("dashboardSummary", msg.data);
      }
    });
    sockets.on("wallet_updated", (msg) => {
      if (msg.balance !== void 0) {
        store.set("walletBalance", msg.balance);
        const walletEl = getElement("wallet-balance");
        if (walletEl) walletEl.textContent = formatINR(msg.balance);
      }
    });
    sockets.on("bot_event", (msg) => {
      handleBotEvent(msg);
    });
    sockets.on("bot_session_updated", (msg) => {
      handleBotSessionUpdate(msg.data);
    });
  }
  function initApp() {
    initLandingShowcase();
    initModalKeyboardListeners();
    initTerminalListeners();
    initAutoBotListeners();
    initReportsListeners();
    setupWebSocketSubscriptions();
    const loginForm = getElement("login-form");
    if (loginForm) loginForm.addEventListener("submit", handleLogin);
    const signupForm = getElement("signup-form");
    if (signupForm) signupForm.addEventListener("submit", handleSignup);
    const logoutBtn = getElement("logout-btn");
    if (logoutBtn) logoutBtn.addEventListener("click", logout);
    if (!document.body.classList.contains("in-dashboard") && !window.location.hash.includes("dashboard")) {
      if (typeof w.start3D === "function") {
        w.start3D();
      } else {
        threeController.start();
      }
    }
    initClerkAuth();
    const savedUsername = localStorage.getItem("orbit_logged_in_username");
    const savedUserId = localStorage.getItem("orbit_user_id");
    const oauthStartedAt = Number(sessionStorage.getItem("orbit_oauth_in_progress") || 0);
    const oauthFresh = oauthStartedAt > 1 && Date.now() - oauthStartedAt < 15 * 60 * 1e3;
    const isReturningFromOAuth = oauthFresh || window.location.hash.includes("dashboard") || window.location.hash.includes("sso-callback");
    if (savedUsername && (isReturningFromOAuth || window.location.hash === "#dashboard")) {
      enterDashboard(savedUsername, savedUserId);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})();
//# sourceMappingURL=app.bundle.js.map
