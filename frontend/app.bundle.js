"use strict";
(() => {
  // src/websocket/socketManager.ts
  var SOCKET_FAILED_EVENT = "orbit:socket-failed";
  var SocketManager = class _SocketManager {
    primarySocket = null;
    streamSocket = null;
    primaryReconnectTimer = null;
    streamReconnectTimer = null;
    intentionallyClosed = false;
    reconnectAttempts = 0;
    maxReconnectAttempts = 30;
    listeners = /* @__PURE__ */ new Map();
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
    url(path) {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${protocol}//${window.location.host}${path}`;
    }
    static live(socket) {
      return !!socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
    }
    /** Opens both sockets (idempotent: an open or connecting socket is kept). */
    connect() {
      this.intentionallyClosed = false;
      if (!_SocketManager.live(this.primarySocket)) this.connectPrimary();
      if (!_SocketManager.live(this.streamSocket)) this.connectStreamHub();
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
      let socket;
      let opened = false;
      try {
        socket = new WebSocket(this.url("/ws"));
      } catch (err) {
        console.warn("[WS connect error]:", err);
        this.schedulePrimaryReconnect();
        return;
      }
      this.primarySocket = socket;
      socket.onopen = () => {
        opened = true;
        this.reconnectAttempts = 0;
      };
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (!data || !data.type) return;
          if (data.type === "auth_error") {
            this.intentionallyClosed = true;
          }
          this.emit(data.type, data);
        } catch (parseErr) {
          console.warn("[WS message parse error]:", parseErr);
        }
      };
      socket.onclose = () => {
        if (this.primarySocket === socket) this.primarySocket = null;
        if (this.intentionallyClosed) return;
        if (!opened) window.dispatchEvent(new CustomEvent(SOCKET_FAILED_EVENT));
        this.schedulePrimaryReconnect();
      };
      socket.onerror = () => {
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
      this.primaryReconnectTimer = window.setTimeout(() => this.connectPrimary(), delay);
    }
    connectStreamHub() {
      let socket;
      try {
        socket = new WebSocket(this.url("/ws/stream"));
      } catch {
        return;
      }
      this.streamSocket = socket;
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data && data.type === "tick") this.emit("tick", data);
        } catch {
        }
      };
      socket.onclose = () => {
        if (this.streamSocket === socket) this.streamSocket = null;
        if (this.intentionallyClosed) return;
        if (this.streamReconnectTimer) clearTimeout(this.streamReconnectTimer);
        this.streamReconnectTimer = window.setTimeout(() => this.connectStreamHub(), 3e3);
      };
      socket.onerror = () => {
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
      this.state = {
        currentAsset: "BTC-USD",
        currentTimeframe: "1d",
        currentUsername: "",
        currentUserId: null,
        walletBalance: null,
        openTrades: [],
        pendingOrders: [],
        tradeHistory: [],
        historyPage: 0,
        totalHistoryPages: 1,
        activeManageTrade: null,
        closeSelectedPct: 50,
        showSRLevels: false,
        botRunning: false,
        dashboardSummary: null,
        pendingSignal: null
      };
    }
    get(key) {
      return this.state[key];
    }
    getAll() {
      return this.state;
    }
    set(key, value) {
      if (this.state[key] === value) return;
      this.state[key] = value;
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
  function formatINRSafe(value) {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    return Number.isFinite(n) ? formatINR(n) : "\u2014";
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
  function safeText(el2, val) {
    if (el2) el2.textContent = String(val);
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
  var tokenProvider = null;
  function setAuthTokenProvider(provider) {
    tokenProvider = provider;
  }
  var UNAUTHORIZED_EVENT = "orbit:unauthorized";
  async function authHeaders(base) {
    const headers = new Headers(base || {});
    if (tokenProvider && !headers.has("Authorization")) {
      try {
        const token = await tokenProvider();
        if (token) headers.set("Authorization", `Bearer ${token}`);
      } catch {
      }
    }
    return headers;
  }
  async function authFetch(input, init = {}) {
    const headers = await authHeaders(init.headers);
    const response = await fetch(input, { ...init, headers, credentials: "same-origin" });
    if (response.status === 401 && !input.startsWith("/api/login") && !input.startsWith("/api/register")) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: { url: input } }));
    }
    return response;
  }
  async function request(endpoint, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && typeof options.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    try {
      const response = await authFetch(endpoint, { ...options, headers });
      if (!response.ok) {
        let errorDetail = `Request failed with status ${response.status}`;
        let errorData = null;
        try {
          errorData = await response.json();
          if (errorData && typeof errorData === "object" && "detail" in errorData) {
            const detail = errorData.detail;
            errorDetail = typeof detail === "string" ? detail : JSON.stringify(detail);
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
  function unwrapData(res) {
    if (!res || res.ok === false || res.data === void 0 || res.data === null) {
      const detail = res && typeof res.detail === "string" ? res.detail : "The service returned no data.";
      throw new ApiError(502, detail, res);
    }
    return res.data;
  }

  // src/services/authService.ts
  var authService = {
    /** Provisions/links the ORBIT account for the verified Clerk user; the gateway then issues its session cookie. */
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
    },
    /** The account the gateway verified for this browser, or an ApiError(401). */
    async me() {
      return apiClient.get("/api/auth/me");
    },
    /** Ends the gateway session (clears the HttpOnly cookie). */
    async logout() {
      try {
        await apiClient.post("/api/auth/logout");
      } catch {
      }
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
    const el2 = document.getElementById("login-error") || document.getElementById("signup-error");
    if (el2) {
      el2.textContent = message;
      el2.classList.remove("hidden");
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
        while (!window.Clerk && attempts < 15) {
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
          } else {
            clerkInstance = window.Clerk;
          }
          if (clerkInstance && typeof clerkInstance.load === "function") {
            await Promise.race([
              clerkInstance.load(loadOptions),
              new Promise((_, reject) => setTimeout(() => reject(new Error("Clerk load timed out")), 2500))
            ]).catch((loadErr) => {
              console.warn("[Orbit Auth] Clerk load warning:", loadErr);
            });
          }
          isClerkActive = true;
          console.log("[Orbit Auth] Clerk Headless SDK loaded with custom UI.");
          setAuthTokenProvider(
            async () => clerkInstance && clerkInstance.session ? clerkInstance.session.getToken() : null
          );
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
        username: displayName
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
      store.sockets.connect();
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
  async function launchDemoDirect() {
    if (await restoreSession()) return;
    scrollToLogin();
    showAuthError("Sign in or create an account to open the live trading terminal.");
  }
  async function restoreSession() {
    try {
      const me = await authService.me();
      if (me && me.ok && me.user_id) {
        enterDashboard(me.username, me.user_id);
        return me;
      }
    } catch {
    }
    if (window.location.hash.includes("dashboard")) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    return null;
  }
  var _sessionRecovery = null;
  async function handleUnauthorized() {
    if (!document.body.classList.contains("in-dashboard")) return;
    if (!_sessionRecovery) {
      _sessionRecovery = (async () => {
        const user = clerkInstance && clerkInstance.session ? clerkInstance.user : null;
        if (!user) return false;
        try {
          const email = user.primaryEmailAddress && user.primaryEmailAddress.emailAddress || "";
          const data = await authService.syncClerkUser({ email, username: user.username || user.fullName || "" });
          return !!(data && data.ok);
        } catch {
          return false;
        }
      })();
      _sessionRecovery.finally(() => {
        window.setTimeout(() => {
          _sessionRecovery = null;
        }, 5e3);
      });
    }
    if (await _sessionRecovery) {
      store.sockets.connect();
      return;
    }
    await logout();
    showAuthError("Your session has ended. Please sign in again.");
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
    let resetTimer = setTimeout(() => {
      if (btn) {
        btn.innerHTML = originalText;
        btn.style.pointerEvents = "auto";
      }
    }, 4500);
    try {
      await initClerkAuth();
      if (clerkInstance && clerkInstance.user && clerkInstance.session) {
        clearTimeout(resetTimer);
        const synced = await syncClerkUserAndEnter(clerkInstance.user);
        if (synced) return;
      }
      if (clerkInstance) {
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
        }
      }
      throw new Error("Google sign-in is unavailable because the Clerk SDK could not be loaded.");
    } catch (err) {
      clearTimeout(resetTimer);
      console.error("Google auth error:", err);
      sessionStorage.removeItem("orbit_oauth_in_progress");
      const errorEl = getElement("login-error") || getElement("signup-error");
      if (errorEl) {
        errorEl.textContent = "Google login error: " + (err.message || "Failed to connect with Google.");
        errorEl.classList.remove("hidden");
      }
    } finally {
      clearTimeout(resetTimer);
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
    try {
      const data = await authService.login({ username, password });
      if (data && data.ok) {
        enterDashboard(data.username || username, data.user_id || null);
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
    } catch (err) {
      console.warn("[Orbit Auth] Local DB login check:", err.message || err);
    }
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
    if (errorEl) {
      errorEl.textContent = "Invalid username or password.";
      errorEl.classList.remove("hidden");
    }
    if (submitBtn) submitBtn.disabled = false;
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
    await authService.logout();
    store.sockets.disconnect();
    store.set("currentUserId", null);
    store.set("dashboardSummary", null);
    store.set("walletBalance", null);
    localStorage.removeItem("orbit_logged_in_username");
    localStorage.removeItem("orbit_user_id");
    localStorage.removeItem("orbit_username");
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
    const signal = store.get("pendingSignal");
    store.sockets.sendPrimaryAction({
      action: "confirm_trade",
      trade_id: signal && signal.trade_id !== null ? signal.trade_id : void 0
    });
    store.set("pendingSignal", null);
    if (typeof window.logToTerminal === "function") {
      window.logToTerminal("Execution Agent", "Trade confirmed by user. Filling the proposed order...");
    }
  }
  function rejectTrade() {
    const modal = getElement("trade-confirm-modal");
    if (modal) modal.classList.add("hidden");
    const signal = store.get("pendingSignal");
    store.sockets.sendPrimaryAction({
      action: "cancel_trade",
      trade_id: signal && signal.trade_id !== null ? signal.trade_id : void 0
    });
    store.set("pendingSignal", null);
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

  // src/services/marketService.ts
  async function getNews(url, signal) {
    const res = await authFetch(url, { signal });
    if (!res.ok) throw new Error(`News request failed with status ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.headlines) ? data.headlines : [];
  }
  var marketService = {
    getQuote(symbol) {
      return apiClient.get(`/api/market/quote?symbol=${encodeURIComponent(symbol)}`);
    },
    async getHistory(symbol, period = "60d", interval = "1d") {
      return unwrapData(
        await apiClient.get(
          `/api/market/history?symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}&interval=${encodeURIComponent(interval)}`
        )
      );
    },
    async searchSymbols(query, market) {
      const params = new URLSearchParams({ q: query });
      if (market) params.set("market", market);
      const res = await apiClient.get(`/api/market/search?${params.toString()}`);
      return Array.isArray(res.results) ? res.results : [];
    },
    getGlobalNews(signal) {
      return getNews("/api/news/global", signal);
    },
    getSymbolNews(symbol, signal) {
      return getNews(`/api/news?symbol=${encodeURIComponent(symbol)}`, signal);
    }
  };

  // src/services/autoBotService.ts
  var autoBotService = {
    async getConfig(userId) {
      const q = userId !== null && userId !== void 0 && userId !== "" ? `?user_id=${encodeURIComponent(userId)}` : "";
      const res = await apiClient.get(`/api/bot-config${q}`);
      return res.config;
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
    return store.get("currentUserId") || null;
  }
  function botIsLive(session) {
    return !!(session && BOT_LIVE_STATES.includes(session.status));
  }
  async function botFetch(url, options) {
    const res = await authFetch(url, options);
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
      const el2 = getElement(id);
      if (el2 && v !== void 0 && v !== null) el2.value = String(v);
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
    const el2 = getElement("bot-capital");
    if (el2 && _botAvailableBalance) el2.value = String(Math.floor(Number(_botAvailableBalance) * 100) / 100);
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
    const el2 = getElement("bot-config-error");
    if (!el2) return;
    el2.textContent = message || "";
    el2.classList.toggle("hidden", !message);
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
      const el2 = getElement(id);
      if (el2) el2.disabled = live;
    });
    document.querySelectorAll(".bot-asset-chip").forEach((b) => {
      b.disabled = live;
    });
  }
  function setBotBar(id, pct) {
    const el2 = getElement(id);
    if (el2) el2.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
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

  // src/ui/newsController.ts
  var scrollRAF = null;
  var scrollPos = 0;
  var scrollPaused = false;
  var scrollEl = null;
  var boundFeeds = /* @__PURE__ */ new WeakSet();
  var cachedGlobal = null;
  var symbolCache = {};
  function stopNewsScroll() {
    if (scrollRAF !== null) {
      cancelAnimationFrame(scrollRAF);
      scrollRAF = null;
    }
    scrollEl = null;
  }
  function autoScrollStep() {
    if (scrollEl && !scrollPaused) {
      scrollPos += 0.35;
      const mid = scrollEl.scrollHeight / 2;
      if (mid > 0 && scrollPos >= mid) scrollPos = 0;
      scrollEl.scrollTop = scrollPos;
    }
    scrollRAF = requestAnimationFrame(autoScrollStep);
  }
  function sentimentBadge(sentiment) {
    if (sentiment === "bullish") return "badge-green";
    if (sentiment === "bearish") return "badge-red";
    return "badge-yellow";
  }
  function renderGlobalNewsHeadlines(headlines) {
    const feed = getElement("news-feed-container");
    if (!feed) return;
    stopNewsScroll();
    scrollPos = 0;
    feed.scrollTop = 0;
    if (!headlines.length) {
      feed.innerHTML = `<div class="news-loading">No global headlines available right now.</div>`;
      return;
    }
    const cards = headlines.map((item) => {
      const date = item.published ? ` \xB7 ${item.published}` : "";
      const href = item.link && item.link !== "#" ? item.link : "";
      return `
            <a class="news-item-card" ${href ? `href="${esc(href)}" target="_blank" rel="noopener noreferrer"` : ""}>
                <div class="news-item-main">
                    <h3 class="news-item-title">${esc(item.title)}</h3>
                    <div class="news-item-meta">
                        <i class="fa-solid fa-newspaper"></i>
                        <span>${esc(item.source || "")}${esc(date)}</span>
                    </div>
                </div>
                <span class="badge ${sentimentBadge(item.sentiment)}">${esc((item.sentiment || "neutral").toUpperCase())}</span>
            </a>`;
    }).join("");
    feed.innerHTML = headlines.length > 2 ? cards + cards : cards;
    if (headlines.length > 2) {
      if (!boundFeeds.has(feed)) {
        boundFeeds.add(feed);
        feed.addEventListener("mouseenter", () => {
          scrollPaused = true;
        }, { passive: true });
        feed.addEventListener("mouseleave", () => {
          scrollPaused = false;
        }, { passive: true });
        feed.addEventListener("scroll", () => {
          if (scrollPaused && scrollEl) scrollPos = scrollEl.scrollTop;
        }, { passive: true });
      }
      scrollEl = feed;
      scrollPaused = false;
      scrollRAF = requestAnimationFrame(autoScrollStep);
    }
  }
  async function fetchGlobalNews() {
    const feed = getElement("news-feed-container");
    if (!feed) return;
    if (cachedGlobal && cachedGlobal.length) {
      renderGlobalNewsHeadlines(cachedGlobal);
    } else {
      stopNewsScroll();
      feed.innerHTML = `<div class="news-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading market news\u2026</div>`;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8e3);
    try {
      const headlines = await marketService.getGlobalNews(controller.signal);
      if (headlines.length) {
        cachedGlobal = headlines;
        renderGlobalNewsHeadlines(headlines);
      } else if (!cachedGlobal) {
        feed.innerHTML = `<div class="news-loading">No global headlines available right now.</div>`;
      }
    } catch (err) {
      console.warn("[News] Global news unavailable:", err);
      if (!cachedGlobal) feed.innerHTML = `<div class="news-loading">\u26A0\uFE0F Could not load world market news.</div>`;
    } finally {
      window.clearTimeout(timer);
    }
  }
  function renderSymbolHeadlines(headlines, ticker, symbol) {
    if (!headlines.length) {
      ticker.innerHTML = `<span class="news-ticker-loading">No news found for ${esc(symbol)}.</span>`;
      ticker.style.animation = "none";
      return;
    }
    const rows = headlines.map((item) => {
      const href = item.link && item.link !== "#" ? item.link : "";
      return `
            <a class="atv-news-item" ${href ? `href="${esc(href)}" target="_blank" rel="noopener noreferrer"` : ""}>
                <span class="atv-news-sentiment-dot ${esc(item.sentiment || "neutral")}"></span>
                <span class="atv-news-title">${esc(item.title)}</span>
                <span class="atv-news-source">${esc(item.source || "")}</span>
            </a>`;
    }).join("");
    ticker.innerHTML = rows + rows;
    const duration = Math.max(50, Math.floor(ticker.scrollHeight / 2 / 14));
    ticker.style.animation = `newsScrollUp ${duration}s linear infinite`;
  }
  async function fetchSymbolNews(symbol) {
    const ticker = getElement("atv-news-scroll");
    if (!ticker || !symbol) return;
    const key = symbol.toUpperCase();
    if (symbolCache[key]?.length) {
      renderSymbolHeadlines(symbolCache[key], ticker, symbol);
    } else {
      ticker.innerHTML = `<span class="news-ticker-loading">\u{1F4E1} Fetching news for ${esc(symbol)}\u2026</span>`;
      ticker.style.animation = "none";
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8e3);
    try {
      const headlines = await marketService.getSymbolNews(symbol, controller.signal);
      if (headlines.length) symbolCache[key] = headlines;
      if (headlines.length || !symbolCache[key]) renderSymbolHeadlines(headlines, ticker, symbol);
    } catch (err) {
      console.warn(`[News] ${symbol} news unavailable:`, err);
      if (!symbolCache[key]) ticker.innerHTML = `<span class="news-ticker-loading">\u26A0\uFE0F Could not load news for ${esc(symbol)}.</span>`;
    } finally {
      window.clearTimeout(timer);
    }
  }

  // src/ui/terminalAgentController.ts
  var terminalAsset = null;
  var searchTimer;
  function overlayWindow() {
    return window;
  }
  function updateLegend(price, changePercent) {
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
  function handleTick(msg) {
    if (!terminalAsset) return;
    const symbol = typeof msg.symbol === "string" ? msg.symbol.toUpperCase() : terminalAsset;
    if (symbol !== terminalAsset) return;
    const price = Number(msg.candle?.close ?? msg.data?.price);
    if (!Number.isFinite(price) || price <= 0) return;
    updateLegend(price, Number(msg.changePercent ?? msg.data?.change_percent ?? 0));
  }
  function handleHistory(msg) {
    if (!terminalAsset || !Array.isArray(msg.candles) || !msg.candles.length) return;
    const last = msg.candles[msg.candles.length - 1];
    updateLegend(Number(last.close), Number(msg.changePercent || 0));
  }
  function renderSRPanel() {
    const panel = getElement("sr-levels-panel");
    if (!panel) return;
    if (!store.get("showSRLevels")) {
      panel.classList.add("hidden");
      return;
    }
    panel.classList.remove("hidden");
    const w2 = overlayWindow();
    const badges = (levels, cls) => levels && levels.length ? levels.map((p) => `<span class="sr-badge ${cls}">${esc(formatINR(p))}</span>`).join("") : "<span class='sr-badge sr-none'>\u2014</span>";
    const sup = getElement("sr-support-list");
    if (sup) sup.innerHTML = badges(w2.lastSupports, "sr-support");
    const res = getElement("sr-resistance-list");
    if (res) res.innerHTML = badges(w2.lastResistances, "sr-resistance");
  }
  function handleLevels(msg) {
    const w2 = overlayWindow();
    w2.lastSupports = Array.isArray(msg.supports) ? msg.supports : [];
    w2.lastResistances = Array.isArray(msg.resistances) ? msg.resistances : [];
    w2.lastLiquidity = Array.isArray(msg.liquidity) ? msg.liquidity : [];
    store.set("showSRLevels", true);
    getElement("btn-draw-sr")?.classList.add("active-btn");
    renderSRPanel();
    drawChartOverlay();
  }
  function toggleSRLevels() {
    const showLevels = !store.get("showSRLevels");
    store.set("showSRLevels", showLevels);
    getElement("btn-draw-sr")?.classList.toggle("active-btn", showLevels);
    renderSRPanel();
    drawChartOverlay(!showLevels);
    logToTerminal("SYSTEM", showLevels ? "Displaying Support and Resistance levels on chart." : "Hiding Support and Resistance levels.");
  }
  function handleSignal(msg) {
    const entry = Number(msg.entry), sl = Number(msg.sl), target = Number(msg.target);
    if (!(entry > 0 && sl > 0 && target > 0)) return;
    const signal = {
      trade_id: typeof msg.trade_id === "number" ? msg.trade_id : null,
      direction: String(msg.direction || (entry > sl ? "buy" : "sell")),
      entry,
      sl,
      target,
      quantity: typeof msg.quantity === "number" ? msg.quantity : void 0,
      capital_required: typeof msg.capital_required === "number" ? msg.capital_required : void 0,
      max_risk: typeof msg.max_risk === "number" ? msg.max_risk : void 0
    };
    store.set("pendingSignal", signal);
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(target - entry);
    const rr = risk > 0 ? `${(reward / risk).toFixed(2)} : 1` : "\u2014";
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
    safeText(getElement("tc-capital"), formatINRSafe(signal.capital_required ?? (signal.quantity ? signal.quantity * entry : void 0)));
    safeText(getElement("tc-max-risk"), formatINRSafe(signal.max_risk ?? (signal.quantity ? risk * signal.quantity : void 0)));
    getElement("trade-confirm-modal")?.classList.remove("hidden");
    logToTerminal("Risk Planner", `\u{1F4CB} Trade confirmation required: ${dir} @ Entry ${formatINR(entry)} | SL ${formatINR(sl)} | TP ${formatINR(target)}`);
  }
  function clearSignal() {
    store.set("pendingSignal", null);
    getElement("signal-levels-panel")?.classList.add("hidden");
    getElement("trade-confirm-modal")?.classList.add("hidden");
  }
  function handleMetrics(msg) {
    if (msg.consensus && msg.consensus.signal) {
      const sig = String(msg.consensus.signal).toUpperCase();
      const el2 = getElement("overview-consensus-status");
      if (el2) {
        el2.textContent = sig;
        el2.className = sig === "BUY" || sig === "BULLISH" ? "text-green" : sig === "SELL" || sig === "BEARISH" ? "text-red" : sig === "MIXED" ? "text-yellow" : "text-blue";
      }
    }
    if (typeof msg.sentiment === "number") {
      const s = msg.sentiment;
      const el2 = getElement("overview-sentiment-status");
      if (el2) {
        el2.textContent = s > 0.15 ? "BULLISH" : s < -0.15 ? "BEARISH" : "NEUTRAL";
        el2.className = s > 0.15 ? "text-green" : s < -0.15 ? "text-red" : "text-cyan";
      }
    }
    if (msg.trend && typeof msg.trend.strength === "string") {
      const strength = msg.trend.strength;
      const el2 = getElement("overview-trend-status");
      if (el2) {
        el2.textContent = strength.toUpperCase();
        el2.className = strength.includes("uptrend") ? "text-green" : strength.includes("downtrend") ? "text-red" : "text-yellow";
      }
    }
  }
  function setAnalyzingMode(isAnalyzing) {
    const analyzeBtn = getElement("initialize-agents-btn");
    if (analyzeBtn) analyzeBtn.disabled = isAnalyzing;
    const stopBtn = getElement("stop-btn");
    if (stopBtn) stopBtn.disabled = !isAnalyzing;
    const input = getElement("terminal-asset-input");
    if (input) input.disabled = isAnalyzing;
    const tradeBtn = getElement("trade-through-agent-btn");
    if (tradeBtn) tradeBtn.disabled = isAnalyzing;
    const status = getElement("system-status");
    if (status) status.innerHTML = `<span class="status-dot green-glow"></span> ${isAnalyzing ? "ANALYZING" : "ONLINE"}`;
    safeText(getElement("atv-status-label"), isAnalyzing ? "AI Crew Active" : "AI Crew Ready");
  }
  function handleSystemStatus(msg) {
    setAnalyzingMode(msg.status === "running");
  }
  function resetAgentTicks() {
    document.querySelectorAll(".agent-row").forEach((row) => {
      row.classList.remove("active-agent", "completed-agent");
      const statusEl = row.querySelector(".agent-row-status");
      if (statusEl) statusEl.textContent = "Waiting\u2026";
    });
    getElement("atv-progress-wrap")?.classList.add("hidden");
    const bar = getElement("atv-progress-bar");
    if (bar) bar.style.width = "0%";
  }
  function prepareTradeEnvironment(rawSymbol) {
    const symbol = (rawSymbol || "").trim().toUpperCase();
    if (!symbol) return;
    terminalAsset = symbol;
    store.set("currentAsset", symbol);
    safeText(getElement("current-asset-title"), `${symbol} Real-Time Chart`);
    safeText(getElement("active-ticker-display"), symbol);
    safeText(getElement("legend-price"), "\u2014");
    safeText(getElement("legend-change"), "");
    getElement("terminal-stock-select-view")?.classList.add("hidden-tab");
    getElement("terminal-active-trading-view")?.classList.remove("hidden-tab");
    resetAgentTicks();
    clearSignal();
    const w2 = overlayWindow();
    w2.lastSupports = [];
    w2.lastResistances = [];
    w2.lastLiquidity = [];
    store.set("showSRLevels", false);
    getElement("btn-draw-sr")?.classList.remove("active-btn");
    renderSRPanel();
    drawChartOverlay(true);
    initChart(symbol);
    fetchSymbolNews(symbol);
    logToTerminal("SYSTEM", `Environment ready for ${symbol}. Launching AI Crew...`);
    window.setTimeout(runAgentCrew, 400);
  }
  function runAgentCrew() {
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
  function stopAgentCrew() {
    store.sockets.send({ action: "stop" });
    logToTerminal("SYSTEM", "Stopping active agent pipeline.");
    setAnalyzingMode(false);
    terminalAsset = null;
    clearSignal();
    window.setTimeout(() => {
      getElement("terminal-active-trading-view")?.classList.add("hidden-tab");
      getElement("terminal-stock-select-view")?.classList.remove("hidden-tab");
      store.set("showSRLevels", false);
      getElement("btn-draw-sr")?.classList.remove("active-btn");
      renderSRPanel();
    }, 300);
  }
  function hideSuggestions() {
    getElement("ticker-suggestions")?.classList.add("hidden");
  }
  function onAssetInput(input) {
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
        box.querySelectorAll(".suggestion-item").forEach((item) => {
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
  function initTerminalAgentListeners() {
    const input = getElement("terminal-asset-input");
    getElement("initialize-agents-btn")?.addEventListener("click", () => prepareTradeEnvironment(input?.value || ""));
    if (input) {
      input.addEventListener("keydown", (e) => {
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
    document.querySelectorAll(".quick-pick-btn").forEach((btn) => {
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
    document.addEventListener("click", (e) => {
      const box = getElement("ticker-suggestions");
      const target = e.target;
      if (box && target && !box.contains(target) && !(input && input.contains(target))) hideSuggestions();
    });
  }

  // src/services/tradingService.ts
  function withUser(path, userId, params = new URLSearchParams()) {
    if (userId !== null && userId !== void 0 && userId !== "") params.set("user_id", String(userId));
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  }
  var tradingService = {
    async getOpenPositions(userId) {
      const res = await apiClient.get(withUser("/api/trades/open", userId));
      return res.positions || res.trades || [];
    },
    async getPendingOrders(userId) {
      const res = await apiClient.get(withUser("/api/trades/pending", userId));
      return res.orders || [];
    },
    async getTradeHistory(query = {}) {
      const params = new URLSearchParams();
      const limit = query.limit ?? 20;
      const offset = query.offset ?? 0;
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      for (const key of ["symbol", "market", "side", "outcome", "source"]) {
        const value = query[key];
        if (value) params.set(key, value);
      }
      const res = await apiClient.get(
        withUser("/api/trades/history", query.user_id, params)
      );
      const trades = Array.isArray(res.trades) ? res.trades : [];
      return {
        trades,
        total: typeof res.total === "number" ? res.total : trades.length,
        page: limit > 0 ? Math.floor(offset / limit) : 0,
        limit
      };
    },
    closePositionPartial(tradeId, quantity, userId) {
      const body = { quantity };
      if (userId !== null && userId !== void 0 && userId !== "") body.user_id = Number(userId);
      return apiClient.post(`/api/trades/${tradeId}/close`, body);
    },
    closePositionFull(tradeId, userId) {
      return apiClient.post(withUser(`/api/trades/${tradeId}/close/full`, userId), {});
    }
  };

  // src/services/portfolioService.ts
  function userQuery(userId) {
    return userId !== null && userId !== void 0 && userId !== "" ? `?user_id=${encodeURIComponent(userId)}` : "";
  }
  var portfolioService = {
    getDashboardSummary(userId) {
      return apiClient.get(`/api/dashboard/summary${userQuery(userId)}`);
    },
    async getReport(userId) {
      const res = await apiClient.get(`/api/report${userQuery(userId)}`);
      return res.report;
    }
  };

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
        loadOverviewHistory(),
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
      const userId = store.get("currentUserId");
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
        const pnlClass2 = pnl >= 0 ? "text-green" : "text-red";
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
                    <td class="${pnlClass2}"><strong>${pnl >= 0 ? "+" : ""}${formatINR(pnl)}</strong> <span style="font-size:11px;opacity:0.8;">(${pnl >= 0 ? "+" : ""}${pnlPct}%)</span></td>
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
      const userId = store.get("currentUserId");
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
      const userId = store.get("currentUserId");
      const res = await tradingService.getTradeHistory({
        user_id: userId ?? void 0,
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
        const pnlClass2 = pnl > 0 ? "text-green" : pnl < 0 ? "text-red" : "";
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
                    <td class="${pnlClass2}"><strong>${pnl >= 0 ? "+" : ""}${formatINR(pnl)}</strong></td>
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
      const uid = store.get("currentUserId");
      let realizedPnl = 0;
      if (isFullClose) {
        const res = await tradingService.closePositionFull(tradeId, uid);
        realizedPnl = Number(res.realized_pnl ?? 0);
      } else {
        const res = await tradingService.closePositionPartial(tradeId, closeQty, uid);
        realizedPnl = Number(res.realized_pnl ?? 0);
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
  function renderDashboardSummary(summary) {
    if (!summary || !summary.account || !summary.trading) return;
    store.set("dashboardSummary", summary);
    const { account, trading } = summary;
    safeText(getElement("overview-balance"), formatINRSafe(account.total_capital));
    store.set("walletBalance", Number.isFinite(account.available_balance) ? account.available_balance : null);
    safeText(getElement("wallet-balance"), formatINRSafe(account.available_balance));
    safeText(getElement("copilot-account-balance"), formatINRSafe(account.available_balance));
    safeText(getElement("overview-active-trades"), String(trading.active_trades ?? 0));
    const setPnl = (id, value) => {
      const el2 = getElement(id);
      if (!el2) return;
      el2.textContent = (value >= 0 ? "+" : "") + formatINR(value);
      el2.className = "stat-value " + (value >= 0 ? "text-green" : "text-red");
    };
    setPnl("overview-unrealized-pnl", Number(trading.unrealized_pnl) || 0);
    setPnl("overview-realized-pnl", Number(trading.realized_pnl) || 0);
    const winRateEl = getElement("overview-win-rate");
    const bar = getElement("overview-winrate-bar");
    if (trading.win_rate !== null && trading.win_rate !== void 0 && trading.total_closed_trades > 0) {
      if (winRateEl) winRateEl.textContent = `${Number(trading.win_rate).toFixed(1)}%`;
      if (bar) bar.style.width = `${Math.min(100, Math.max(0, Number(trading.win_rate)))}%`;
    } else {
      if (winRateEl) winRateEl.textContent = "\u2014";
      if (bar) bar.style.width = "0%";
    }
    safeText(getElement("overview-win-loss-text"), `${trading.winning_trades_count ?? 0} Wins | ${trading.losing_trades_count ?? 0} Losses`);
  }
  async function fetchDashboardSummary() {
    try {
      renderDashboardSummary(await portfolioService.getDashboardSummary(store.get("currentUserId")));
    } catch (err) {
      console.error("[Dashboard] Error fetching summary:", err);
    }
  }
  async function loadOverviewHistory() {
    const list = getElement("overview-history-list");
    const count = getElement("overview-history-count");
    if (!list && !count) return;
    try {
      const res = await tradingService.getTradeHistory({ user_id: store.get("currentUserId") ?? void 0, limit: 10, offset: 0 });
      if (count) count.textContent = `${res.total} trade${res.total === 1 ? "" : "s"}`;
      if (!list) return;
      if (!res.trades.length) {
        list.innerHTML = `<div class="crew-history-empty"><i class="fa-solid fa-hourglass-half"></i><p>No completed trades yet</p></div>`;
        return;
      }
      list.innerHTML = res.trades.map((t) => {
        const pnl = Number(t.realized_pnl ?? t.pnl ?? 0);
        const isBuy = String(t.type || "").toLowerCase() === "buy";
        const outcome = t.outcome === "target" ? "TP" : t.outcome === "cancelled" ? "CX" : t.outcome === "sl" ? "SL" : "MC";
        const time = t.closed_at || t.timestamp;
        return `
                <div class="crew-history-item">
                    <div class="chi-direction ${isBuy ? "buy" : "sell"}">${isBuy ? "\u25B2" : "\u25BC"}</div>
                    <div class="chi-details">
                        <div class="chi-asset">${esc(t.symbol || t.asset || "\u2014")}</div>
                        <div class="chi-time">${time ? new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "\u2014"}</div>
                    </div>
                    <span class="chi-pnl ${pnl >= 0 ? "text-green" : "text-red"}">${pnl >= 0 ? "+" : ""}${formatINR(pnl)}</span>
                    <span class="chi-outcome ${t.outcome === "target" ? "target" : "stop"}">${outcome}</span>
                </div>`;
      }).join("");
    } catch (err) {
      console.warn("[Dashboard] Recent trades unavailable:", err);
    }
  }

  // src/services/aiService.ts
  function analysisUrl(path, symbol, timeframe) {
    return `${path}?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`;
  }
  async function getData(url) {
    return unwrapData(await apiClient.get(url));
  }
  var aiService = {
    analyzeAgents(symbol, timeframe = "1d") {
      return getData(analysisUrl("/api/agents/analyze", symbol, timeframe));
    },
    evaluateStrategies(symbol, timeframe = "1d") {
      return getData(analysisUrl("/api/strategies/evaluate", symbol, timeframe));
    },
    evaluateConsensus(symbol, timeframe = "1d") {
      return getData(analysisUrl("/api/consensus/evaluate", symbol, timeframe));
    },
    analyzeBrain(symbol, timeframe = "1d") {
      return getData(analysisUrl("/api/brain/analyze", symbol, timeframe));
    },
    evaluateRisk(symbol, timeframe = "1d") {
      return getData(analysisUrl("/api/risk/evaluate", symbol, timeframe));
    },
    evaluateOpportunity(symbol, timeframe = "1d") {
      return getData(analysisUrl("/api/opportunity/evaluate", symbol, timeframe));
    },
    evaluateDecision(symbol, timeframe = "1d") {
      return getData(analysisUrl("/api/decision/evaluate", symbol, timeframe));
    },
    evaluateExplanation(symbol, timeframe = "1d") {
      return getData(analysisUrl("/api/explain/evaluate", symbol, timeframe));
    },
    async chatCopilot(req) {
      return unwrapData(await apiClient.post("/api/copilot/chat", req));
    },
    getCopilotContext(symbol, timeframe = "1d") {
      return getData(analysisUrl("/api/copilot/context", symbol, timeframe));
    },
    async resetCopilotSession(conversationId) {
      await apiClient.post("/api/copilot/reset", { conversation_id: conversationId });
    },
    listConversations(limit = 40) {
      return getData(`/api/chat/conversations?limit=${encodeURIComponent(limit)}`);
    },
    getConversation(conversationId) {
      return getData(`/api/chat/conversations/${encodeURIComponent(conversationId)}`);
    },
    async deleteConversation(conversationId) {
      await apiClient.delete(`/api/chat/conversations/${encodeURIComponent(conversationId)}`);
    }
  };

  // src/ui/aiModalsController.ts
  var el = (id) => getElement(id);
  function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  function activeContext() {
    return { asset: store.get("currentAsset") || "BTC-USD", tf: store.get("currentTimeframe") || "1d" };
  }
  function errorText(err) {
    return err instanceof Error ? err.message : String(err);
  }
  function statusColor(status, ready = "var(--pos)") {
    if (status === "READY") return ready;
    if (status === "PARTIAL") return "#facc15";
    if (status === "LIMITED") return "#f97316";
    return "var(--neg)";
  }
  function scoreHtml(value, decimals = 1) {
    return `${value.toFixed(decimals)}<span style="font-size:13px;color:var(--text-3);font-weight:400;">/100</span>`;
  }
  function show(id) {
    const modal = el(id);
    if (!modal) return false;
    modal.classList.remove("hidden");
    return true;
  }
  function hide(id) {
    el(id)?.classList.add("hidden");
  }
  function renderEvidenceCard(e, modifier) {
    const cardClass = `evidence-card ${modifier}`;
    const badgeClass = e.signal === "BULLISH" ? "strat-eval-badge strat-badge-bullish" : e.signal === "BEARISH" ? "strat-eval-badge strat-badge-bearish" : "strat-eval-badge strat-badge-neutral";
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
                    <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-3);">${num(e.confidence).toFixed(0)}%</span>
                </div>
            </div>
            <div class="evidence-card-reason">${esc(reasonText)}</div>
        </div>`;
  }
  function factorList(items, itemClass, titleClass, icon, empty) {
    if (!items.length) {
      return `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">${empty}</div>`;
    }
    return items.map(
      (f) => `
            <div class="${itemClass}">
                <div class="${titleClass}">
                    <i class="${icon}"></i>
                    <span>${esc(f.title)}</span>
                </div>
                <div class="${titleClass.replace("-title", "-detail").split(" ")[0]}">${esc(f.detail)}</div>
            </div>`
    ).join("");
  }
  function openStrategyModal() {
    if (show("strategy-inspect-modal")) refreshStrategyModal();
  }
  function closeStrategyModal() {
    hide("strategy-inspect-modal");
  }
  async function refreshStrategyModal() {
    const grid = el("strategy-modal-grid");
    const tallyEl = el("strat-tally-text");
    const timeBadge = el("strat-time-badge");
    const { asset, tf } = activeContext();
    const sub = el("strat-modal-subtitle");
    if (sub) sub.textContent = `Evaluating real-time market setups on ${asset} (${tf})`;
    if (tallyEl) tallyEl.innerHTML = `<span class="status-dot green-glow"></span> Querying Market Data System...`;
    try {
      const data = await aiService.evaluateStrategies(asset, tf);
      if (timeBadge) timeBadge.textContent = `${num(data.execution_time_ms).toFixed(1)} ms`;
      const tally = data.tally || {};
      if (tallyEl) {
        tallyEl.innerHTML = `<strong>${num(data.setups_found)} of ${num(data.strategies_total)}</strong> Setups Active &bull; <span class="text-green">${num(tally.BULLISH)} Bullish</span> &bull; <span class="text-red">${num(tally.BEARISH)} Bearish</span> &bull; Avg Confidence: <strong>${num(data.average_confidence)}%</strong>`;
      }
      if (grid && Array.isArray(data.results)) {
        grid.innerHTML = data.results.map((r) => {
          const isSetup = !!r.setup_detected;
          const cardClass = isSetup ? r.signal === "BULLISH" ? "strat-eval-card setup-active" : "strat-eval-card setup-bearish" : "strat-eval-card";
          const badgeClass = r.signal === "BULLISH" ? "strat-eval-badge strat-badge-bullish" : r.signal === "BEARISH" ? "strat-eval-badge strat-badge-bearish" : "strat-eval-badge strat-badge-neutral";
          const conditionsHtml = Object.entries(r.conditions || {}).map(([k, v]) => `<span class="cond-tag ${v ? "cond-true" : "cond-false"}">${v ? "\u2713" : "\u2717"} ${esc(k.replace(/_/g, " "))}</span>`).join("");
          return `
                    <div class="${cardClass}">
                        <div class="strat-eval-header">
                            <div class="strat-eval-title">
                                <span class="${badgeClass}">${esc(r.signal)}</span>
                                <span class="strat-eval-name">${esc(r.strategy_name)}</span>
                            </div>
                            <div style="display:flex;align-items:center;gap:8px;">
                                <span style="font-size:11px;font-family:var(--font-mono);font-weight:600;color:${isSetup ? "var(--accent)" : "var(--text-3)"}">${isSetup ? "\u25CF SETUP ACTIVE" : "\u25CB NO SETUP"}</span>
                                <span style="font-size:11px;font-family:var(--font-mono);color:var(--text-2);">${num(r.confidence).toFixed(1)}%</span>
                            </div>
                        </div>
                        <p class="strat-eval-reason">${esc(r.reasoning && r.reasoning[0] ? r.reasoning[0] : "Strategy criteria evaluated.")}</p>
                        ${conditionsHtml ? `<div class="strat-eval-conditions">${conditionsHtml}</div>` : ""}
                    </div>`;
        }).join("");
      }
    } catch (err) {
      if (tallyEl) tallyEl.innerHTML = `<span class="status-dot red-glow"></span> Evaluation failed: ${esc(errorText(err))}`;
      if (grid) grid.innerHTML = `<div style="padding:24px;text-align:center;color:var(--neg);font-size:12px;">Failed to evaluate strategies. ${esc(errorText(err))}</div>`;
    }
  }
  function openConsensusModal() {
    if (show("consensus-inspect-modal")) refreshConsensusModal();
  }
  function closeConsensusModal() {
    hide("consensus-inspect-modal");
  }
  async function refreshConsensusModal() {
    const body = el("consensus-modal-body");
    const tallyEl = el("consensus-tally-text");
    const { asset, tf } = activeContext();
    const sub = el("consensus-modal-subtitle");
    if (sub) sub.textContent = `Unified Market Consensus on ${asset} (${tf})`;
    if (tallyEl) tallyEl.innerHTML = `<span class="status-dot green-glow"></span> Running Agents & Quantitative Strategies...`;
    try {
      const data = await aiService.evaluateConsensus(asset, tf);
      const timeBadge = el("consensus-time-badge");
      if (timeBadge) timeBadge.textContent = `${num(data.execution_time_ms).toFixed(1)} ms`;
      const sig = data.consensus_signal || "NEUTRAL";
      const strength = num(data.consensus_strength);
      const agreement = num(data.agreement_score);
      const view = data.market_view;
      const viewTitle = view && typeof view === "object" ? view.title : view || "Market Equilibrium";
      const viewSummary = view && typeof view === "object" ? view.summary : data.summary_reasoning || "";
      const overview = el("overview-consensus-status");
      if (overview) {
        overview.textContent = `${sig} (${strength.toFixed(0)}%)`;
        overview.className = sig === "BULLISH" ? "text-green" : sig === "BEARISH" ? "text-red" : sig === "MIXED" ? "text-yellow" : "text-blue";
      }
      const pill = el("consensus-signal-pill");
      if (pill) {
        pill.textContent = sig;
        pill.className = `consensus-signal-pill ${sig.toLowerCase()}`;
      }
      const titleEl = el("consensus-view-title");
      if (titleEl) titleEl.textContent = String(viewTitle || "");
      const subEl = el("consensus-view-sub");
      if (subEl) subEl.textContent = String(viewSummary || "");
      const strengthEl = el("consensus-strength-val");
      if (strengthEl) strengthEl.textContent = `${strength.toFixed(1)}%`;
      const agreementEl = el("consensus-agreement-val");
      if (agreementEl) agreementEl.textContent = `${agreement.toFixed(1)}%`;
      const levelEl = el("consensus-agreement-level");
      if (levelEl) {
        const level = String(data.agreement_level || "\u2014");
        levelEl.textContent = level;
        levelEl.className = `consensus-metric-val ${level.includes("STRONG") ? "text-green" : level.includes("CONFLICT") || level.includes("INSUFFICIENT") ? "text-red" : "text-yellow"}`;
      }
      const bull = num(data.agent_tally?.BULLISH) + num(data.strategy_tally?.BULLISH);
      const neut = num(data.agent_tally?.NEUTRAL) + num(data.strategy_tally?.NEUTRAL);
      const bear = num(data.agent_tally?.BEARISH) + num(data.strategy_tally?.BEARISH);
      const total = bull + neut + bear || 1;
      const pBull = (bull / total * 100).toFixed(1);
      const pNeut = (neut / total * 100).toFixed(1);
      const pBear = (bear / total * 100).toFixed(1);
      const bullLbl = el("consensus-bull-force-lbl");
      if (bullLbl) bullLbl.innerHTML = `<i class="fa-solid fa-arrow-up"></i> Bullish ${pBull}% (${bull})`;
      const neutLbl = el("consensus-neutral-force-lbl");
      if (neutLbl) neutLbl.textContent = `Neutral ${pNeut}% (${neut})`;
      const bearLbl = el("consensus-bear-force-lbl");
      if (bearLbl) bearLbl.innerHTML = `Bearish ${pBear}% (${bear}) <i class="fa-solid fa-arrow-down"></i>`;
      const setWidth = (id, pct) => {
        const bar = el(id);
        if (bar) bar.style.width = `${pct}%`;
      };
      setWidth("consensus-bar-bull", pBull);
      setWidth("consensus-bar-neut", pNeut);
      setWidth("consensus-bar-bear", pBear);
      if (tallyEl) {
        tallyEl.innerHTML = `<strong>${num(data.total_evidence_evaluated, total)}</strong> Total Sources &bull; <span class="text-green">${bull} Bullish</span> &bull; <span class="text-3">${neut} Neutral</span> &bull; <span class="text-red">${bear} Bearish</span> &bull; Status: <strong>${esc(data.status)}</strong>`;
      }
      if (body) {
        let html = "";
        const conflicting = Array.isArray(data.conflicting_evidence) ? data.conflicting_evidence : [];
        const supporting = Array.isArray(data.supporting_evidence) ? data.supporting_evidence : [];
        const ignored = Array.isArray(data.ignored_evidence) ? data.ignored_evidence : [];
        if (conflicting.length) {
          html += `<div class="consensus-section-header" style="color:#facc15;"><i class="fa-solid fa-triangle-exclamation"></i><span>Conflicting Evidence (${conflicting.length})</span></div>
                    <div class="evidence-grid">${conflicting.map((e) => renderEvidenceCard(e, "conflict")).join("")}</div>`;
        }
        if (supporting.length) {
          html += `<div class="consensus-section-header" style="color:var(--pos);"><i class="fa-solid fa-shield-check"></i><span>Primary Supporting Evidence (${supporting.length})</span></div>
                    <div class="evidence-grid">${supporting.map((e) => renderEvidenceCard(e, "supporting")).join("")}</div>`;
        }
        if (ignored.length) {
          html += `<div class="consensus-section-header" style="color:var(--text-4);margin-top:12px;"><i class="fa-solid fa-ban"></i><span>Ignored / Inactive Signals (${ignored.length})</span></div>
                    <div class="evidence-grid">${ignored.map(
            (e) => `
                        <div class="evidence-card failed">
                            <div class="evidence-card-header">
                                <div class="evidence-source-info">
                                    <span class="evidence-type-badge">${esc(e.type || e.evidence_type || "UNKNOWN")}</span>
                                    <span class="evidence-source-name">${esc(e.id || e.source_name || "Source")}</span>
                                </div>
                                <span class="strat-eval-badge strat-badge-neutral">${esc(e.reason || "SKIPPED")}</span>
                            </div>
                            <div class="evidence-card-reason">${esc(e.detail || e.summary || "Source omitted from voting.")}</div>
                        </div>`
          ).join("")}</div>`;
        }
        body.innerHTML = html || `<div style="padding:24px;text-align:center;color:var(--text-3);font-size:12px;">No evidence items were produced for ${esc(asset)}.</div>`;
      }
    } catch (err) {
      if (tallyEl) tallyEl.innerHTML = `<span class="status-dot red-glow"></span> Error: ${esc(errorText(err))}`;
      if (body) body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--neg);font-size:12px;">Error connecting to Consensus Engine: ${esc(errorText(err))}</div>`;
    }
  }
  function openBrainModal() {
    if (show("brain-inspect-modal")) refreshBrainModal();
  }
  function closeBrainModal() {
    hide("brain-inspect-modal");
  }
  async function refreshBrainModal() {
    const { asset, tf } = activeContext();
    const sub = el("brain-modal-subtitle");
    if (sub) sub.textContent = `Central Intelligence Orchestration Dossier on ${asset} (${tf})`;
    const execText = el("brain-exec-summary-text");
    const statusTag = el("brain-status-tag");
    if (execText) execText.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i> Orchestrating market data, AI agents, strategies and consensus...`;
    try {
      const data = await aiService.analyzeBrain(asset, tf);
      if (statusTag) {
        statusTag.textContent = data.analysis_status || "READY";
        statusTag.style.color = statusColor(data.analysis_status);
      }
      const bias = data.overall_bias || "NEUTRAL";
      const biasPill = el("brain-bias-pill");
      if (biasPill) {
        biasPill.textContent = bias;
        biasPill.className = `consensus-signal-pill ${bias.toLowerCase()}`;
      }
      const conviction = el("brain-conviction-pill");
      if (conviction) conviction.textContent = `Conviction: ${num(data.conviction_strength).toFixed(1)}%`;
      const tier = el("brain-tier-pill");
      if (tier) {
        tier.textContent = `${data.completeness_tier || "\u2014"} (${num(data.completeness_score).toFixed(0)}%)`;
        tier.style.color = data.completeness_tier === "COMPLETE" ? "var(--pos)" : data.completeness_tier === "PARTIAL" ? "#facc15" : "var(--neg)";
      }
      if (execText) execText.textContent = data.executive_summary || "";
      const mkt = data.market_summary || {};
      const price = el("brain-mkt-price");
      if (price) price.textContent = mkt.current_price !== void 0 && mkt.current_price !== null ? num(mkt.current_price).toLocaleString(void 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "\u2014";
      const change = el("brain-mkt-change");
      if (change) {
        const pct = num(mkt.price_change_pct);
        change.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
        change.className = pct >= 0 ? "brain-sub-val text-green" : "brain-sub-val text-red";
      }
      const atr = el("brain-mkt-atr");
      if (atr) atr.textContent = `${num(mkt.volatility_atr).toFixed(2)} (${num(mkt.volatility_pct).toFixed(2)}%)`;
      const regime = el("brain-mkt-regime");
      if (regime) regime.textContent = mkt.trend_regime || "\u2014";
      const ag = data.agent_summary || {};
      const agTally = ag.tally || {};
      const setText = (id, text) => {
        const node = el(id);
        if (node) node.textContent = text;
      };
      setText("brain-agent-leading", ag.leading_signal || "\u2014");
      setText("brain-agent-bull", String(num(agTally.BULLISH)));
      setText("brain-agent-neut", String(num(agTally.NEUTRAL)));
      setText("brain-agent-bear", String(num(agTally.BEARISH)));
      setText("brain-agent-conf", `${num(ag.average_confidence).toFixed(0)}%`);
      const st = data.strategy_summary || {};
      setText("brain-strat-setups-tag", `${num(st.setups_found)} SETUPS`);
      setText("brain-strat-active-count", `${num(st.setups_found)} / ${num(st.strategies_evaluated)}`);
      setText("brain-strat-bull", String(num(st.bullish_setups)));
      setText("brain-strat-bear", String(num(st.bearish_setups)));
      const activeList = el("brain-strat-active-list");
      if (activeList) {
        const names = Array.isArray(st.active_strategies) ? st.active_strategies : [];
        activeList.innerHTML = names.length ? names.map((n) => `<span class="strat-eval-badge strat-badge-bullish" style="font-size:9.5px;">\u2713 ${esc(n)}</span>`).join("") : `<span style="font-size:10.5px;color:var(--text-4);font-style:italic;">No active strategy setups detected</span>`;
      }
      const cs = data.consensus_summary || {};
      setText("brain-cons-status-tag", cs.status || "\u2014");
      const consSig = el("brain-cons-sig");
      if (consSig) {
        consSig.textContent = cs.signal || "\u2014";
        consSig.className = cs.signal === "BULLISH" ? "brain-sub-val text-green" : cs.signal === "BEARISH" ? "brain-sub-val text-red" : cs.signal === "MIXED" ? "brain-sub-val text-yellow" : "brain-sub-val text-blue";
      }
      setText("brain-cons-strength", `${num(cs.strength).toFixed(1)}%`);
      setText("brain-cons-agree", `${num(cs.agreement_score).toFixed(0)}% (${cs.agreement_level || "\u2014"})`);
      setText("brain-market-view-line", cs.market_view || "");
      const evidence = el("brain-evidence-section");
      if (evidence) {
        const supporting = data.key_supporting_evidence || [];
        const conflicting = data.key_conflicting_evidence || [];
        let html = "";
        if (conflicting.length) {
          html += `<div class="consensus-section-header" style="color:#facc15;"><i class="fa-solid fa-triangle-exclamation"></i><span>Key Conflicting Evidence (${conflicting.length})</span></div>
                    <div class="evidence-grid">${conflicting.map((e) => renderEvidenceCard(e, "conflict")).join("")}</div>`;
        }
        if (supporting.length) {
          html += `<div class="consensus-section-header" style="color:var(--pos);margin-top:4px;"><i class="fa-solid fa-shield-check"></i><span>Key Supporting Evidence (${supporting.length})</span></div>
                    <div class="evidence-grid">${supporting.map((e) => renderEvidenceCard(e, "supporting")).join("")}</div>`;
        }
        evidence.innerHTML = html;
      }
      const diag = data.diagnostics || {};
      setText("brain-diag-latency", `${num(diag.total_pipeline_ms).toFixed(1)} ms`);
      setText("brain-diag-comp", `${num(data.completeness_score).toFixed(1)}%`);
    } catch (err) {
      if (execText) execText.innerHTML = `<span style="color:var(--neg);">Analysis failed: ${esc(errorText(err))}</span>`;
      if (statusTag) {
        statusTag.textContent = "FAILED";
        statusTag.style.color = "var(--neg)";
      }
    }
  }
  function openRiskModal() {
    if (show("risk-guard-modal")) refreshRiskModal();
  }
  function closeRiskModal() {
    hide("risk-guard-modal");
  }
  var RISK_LEVEL_COLOR = { VERY_LOW: "var(--pos)", LOW: "var(--pos)", MODERATE: "#F59E0B", HIGH: "#F97316", CRITICAL: "var(--neg)" };
  async function refreshRiskModal() {
    const { asset, tf } = activeContext();
    const sub = el("risk-modal-subtitle");
    if (sub) sub.textContent = `Analysis Quality & Market Safety Audit on ${asset} (${tf})`;
    const heroSummary = el("risk-hero-summary");
    const statusTag = el("risk-status-tag");
    if (heroSummary) heroSummary.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i> Evaluating volatility, conflict, consensus, quality and data...`;
    try {
      const data = await aiService.evaluateRisk(asset, tf);
      if (statusTag) {
        statusTag.textContent = data.status || "READY";
        statusTag.style.color = statusColor(data.status);
      }
      const lvl = data.risk_level || "MODERATE";
      const pill = el("risk-level-pill");
      if (pill) {
        pill.textContent = lvl.replace(/_/g, " ");
        pill.className = `risk-level-pill ${lvl.toLowerCase().replace(/_/g, "-")}`;
      }
      const title = el("risk-hero-title");
      if (title) {
        title.textContent = lvl === "LOW" || lvl === "VERY_LOW" ? "Controlled Risk Profile" : lvl === "MODERATE" ? "Standard Market Volatility" : lvl === "HIGH" ? "Elevated Risk Warning" : "CRITICAL RISK ALERT";
      }
      if (heroSummary) heroSummary.textContent = data.summary || "";
      const score = num(data.risk_score);
      const scoreEl = el("risk-score-number");
      if (scoreEl) scoreEl.innerHTML = scoreHtml(score);
      const bar = el("risk-meter-bar-fill");
      if (bar) {
        bar.style.width = `${Math.min(100, Math.max(5, score))}%`;
        bar.style.background = RISK_LEVEL_COLOR[lvl] || "var(--neg)";
      }
      const grid = el("risk-dimensions-grid");
      if (grid && data.dimensions) {
        const icons = {
          volatility: "fa-solid fa-wave-square",
          signal_conflict: "fa-solid fa-code-compare",
          consensus: "fa-solid fa-brain",
          analysis_quality: "fa-solid fa-shield-halved",
          data_quality: "fa-solid fa-database"
        };
        grid.innerHTML = Object.keys(icons).map((key) => {
          const d = data.dimensions[key];
          if (!d) return "";
          const color = RISK_LEVEL_COLOR[d.level] || "var(--neg)";
          return `
                    <div class="risk-dim-card">
                        <div class="risk-dim-header">
                            <div class="risk-dim-title"><i class="${icons[key]}" style="color:${color};"></i><span>${esc(d.name)}</span></div>
                            <span class="risk-dim-score" style="color:${color};">${num(d.score).toFixed(0)}/100</span>
                        </div>
                        <div class="risk-dim-summary">${esc(d.summary)}</div>
                    </div>`;
        }).join("");
      }
      const riskFactors = data.risk_factors || [];
      const rfCount = el("risk-factors-count");
      if (rfCount) rfCount.textContent = String(riskFactors.length);
      const rfList = el("risk-factors-list");
      if (rfList) rfList.innerHTML = factorList(
        riskFactors,
        "risk-factor-item",
        "risk-factor-title",
        "fa-solid fa-triangle-exclamation",
        "\u2713 No active elevated risk warnings detected in current state."
      );
      const safety = data.safety_factors || [];
      const sfCount = el("safety-factors-count");
      if (sfCount) sfCount.textContent = String(safety.length);
      const sfList = el("safety-factors-list");
      if (sfList) sfList.innerHTML = factorList(
        safety,
        "safety-factor-item",
        "safety-factor-title",
        "fa-solid fa-circle-check",
        "No specific stabilizing conditions identified."
      );
      const diag = data.diagnostics || {};
      const latency = el("risk-diag-latency");
      if (latency) latency.textContent = `${num(diag.evaluation_latency_ms).toFixed(1)} ms`;
      const dims = el("risk-diag-dims");
      if (dims) dims.textContent = `${num(diag.dimensions_evaluated)}/5`;
    } catch (err) {
      if (heroSummary) heroSummary.innerHTML = `<span style="color:var(--neg);">Risk audit failed: ${esc(errorText(err))}</span>`;
      if (statusTag) {
        statusTag.textContent = "FAILED";
        statusTag.style.color = "var(--neg)";
      }
    }
  }
  function openOpportunityModal() {
    if (show("opportunity-eval-modal")) refreshOpportunityModal();
  }
  function closeOpportunityModal() {
    hide("opportunity-eval-modal");
  }
  async function refreshOpportunityModal() {
    const { asset, tf } = activeContext();
    const sub = el("opp-modal-subtitle");
    if (sub) sub.textContent = `Multi-System Confluence & Setup Quality Assessment on ${asset} (${tf})`;
    const heroSummary = el("opp-hero-summary");
    const statusTag = el("opp-status-tag");
    if (heroSummary) heroSummary.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i> Evaluating cross-pipeline confluence...`;
    try {
      const data = await aiService.evaluateOpportunity(asset, tf);
      if (statusTag) {
        statusTag.textContent = data.status || "READY";
        statusTag.style.color = statusColor(data.status);
      }
      const lvl = data.opportunity_level || "MODERATE";
      const pill = el("opp-level-pill");
      if (pill) {
        pill.textContent = lvl.replace(/_/g, " ");
        pill.className = `opp-level-pill ${lvl.toLowerCase().replace(/_/g, "-")}`;
      }
      const bias = data.leading_bias || "NEUTRAL";
      const biasPill = el("opp-bias-pill");
      if (biasPill) {
        biasPill.textContent = bias;
        biasPill.className = `opp-bias-pill ${bias.toLowerCase()}`;
      }
      const title = el("opp-hero-title");
      if (title) {
        title.textContent = lvl === "VERY_HIGH" ? "Exceptional Multi-System Confluence" : lvl === "HIGH" ? "Strong Analytical Confluence" : lvl === "MODERATE" ? "Balanced Setup Quality" : lvl === "LOW" ? "Weak Confluence / High Friction" : "Minimal Trade Setup Opportunity";
      }
      if (heroSummary) heroSummary.textContent = data.summary || "";
      const score = num(data.opportunity_score);
      const scoreEl = el("opp-score-number");
      if (scoreEl) scoreEl.innerHTML = scoreHtml(score);
      const bar = el("opp-meter-bar-fill");
      if (bar) {
        bar.style.width = `${Math.min(100, Math.max(5, score))}%`;
        bar.style.background = lvl === "VERY_HIGH" || lvl === "HIGH" ? "var(--pos)" : lvl === "MODERATE" ? "#F59E0B" : lvl === "LOW" ? "#F97316" : "var(--neg)";
      }
      const grid = el("opp-dimensions-grid");
      if (grid && data.dimensions) {
        const icons = {
          consensus_quality: "fa-solid fa-brain",
          strategy_confluence: "fa-solid fa-layer-group",
          agent_harmony: "fa-solid fa-robot",
          risk_headroom: "fa-solid fa-shield-halved",
          analysis_completeness: "fa-solid fa-circle-check"
        };
        grid.innerHTML = Object.keys(icons).map((key) => {
          const d = data.dimensions[key];
          if (!d) return "";
          const s = num(d.score);
          const color = s >= 70 ? "var(--pos)" : s >= 50 ? "#06b6d4" : s >= 35 ? "#F59E0B" : "var(--neg)";
          return `
                    <div class="opp-dim-card">
                        <div class="opp-dim-header">
                            <div class="opp-dim-title"><i class="${icons[key]}" style="color:${color};"></i><span>${esc(d.name)}</span></div>
                            <span class="opp-dim-score" style="color:${color};">${s.toFixed(0)}/100</span>
                        </div>
                        <div class="opp-dim-summary">${esc(d.summary)}</div>
                    </div>`;
        }).join("");
      }
      const strengths = data.strength_factors || [];
      const stCount = el("opp-strength-count");
      if (stCount) stCount.textContent = String(strengths.length);
      const stList = el("opp-strength-list");
      if (stList) stList.innerHTML = factorList(
        strengths,
        "opp-factor-item booster",
        "opp-factor-title booster",
        "fa-solid fa-circle-check",
        "No strong confluence boosters detected in current market state."
      );
      const weaknesses = data.weakness_factors || [];
      const wkCount = el("opp-weakness-count");
      if (wkCount) wkCount.textContent = String(weaknesses.length);
      const wkList = el("opp-weakness-list");
      if (wkList) wkList.innerHTML = factorList(
        weaknesses,
        "opp-factor-item headwind",
        "opp-factor-title headwind",
        "fa-solid fa-triangle-exclamation",
        "\u2713 Zero significant headwinds or frictions identified."
      );
      const diag = data.diagnostics || {};
      const latency = el("opp-diag-latency");
      if (latency) latency.textContent = `${num(diag.evaluation_latency_ms).toFixed(2)} ms`;
      const totalEl = el("opp-diag-total");
      if (totalEl) totalEl.textContent = `${num(diag.total_pipeline_ms).toFixed(1)} ms`;
      const dims = el("opp-diag-dims");
      if (dims) dims.textContent = `${num(diag.dimensions_evaluated)}/5`;
    } catch (err) {
      if (heroSummary) heroSummary.innerHTML = `<span style="color:var(--neg);">Opportunity evaluation failed: ${esc(errorText(err))}</span>`;
      if (statusTag) {
        statusTag.textContent = "FAILED";
        statusTag.style.color = "var(--neg)";
      }
    }
  }
  function openDecisionModal() {
    if (show("decision-eval-modal")) refreshDecisionModal();
  }
  function closeDecisionModal() {
    hide("decision-eval-modal");
  }
  var STANCE_TITLE = {
    BULLISH: "Authoritative Bullish Market Stance",
    BEARISH: "Authoritative Bearish Market Stance",
    NEUTRAL: "Consolidation Equilibrium (Neutral)",
    MIXED: "Polar Volatility Deadlock (Mixed)",
    NO_CLEAR_DECISION: "Ambiguous Evidence (No Clear Stance)"
  };
  function clarityColor(clarity) {
    return clarity === "CLEAR" ? "var(--pos)" : clarity === "MODERATE" ? "#38bdf8" : clarity === "UNCLEAR" ? "#f59e0b" : "var(--neg)";
  }
  function stanceBarColor(stance) {
    return stance === "BULLISH" ? "var(--pos)" : stance === "BEARISH" ? "var(--neg)" : stance === "NEUTRAL" ? "#F59E0B" : "#A855F7";
  }
  function renderInputQuad(prefix, inSum) {
    const set = (id, text) => {
      const node = el(`${prefix}-${id}`);
      if (node) node.textContent = text;
    };
    set("consensus", inSum.consensus_signal || "--");
    set("consensus-sub", `Strength: ${num(inSum.consensus_strength).toFixed(0)} | Agreement: ${num(inSum.agreement_score).toFixed(0)}%`);
    set("risk", inSum.risk_level || "--");
    set("risk-sub", `Score: ${num(inSum.risk_score).toFixed(1)}/100`);
    set("opp", String(inSum.opportunity_level || "--").replace(/_/g, " "));
    set("opp-sub", `Confluence: ${num(inSum.opportunity_score).toFixed(1)}/100`);
    set("pipeline", `${num(inSum.completeness_score).toFixed(0)}%`);
    set("pipeline-sub", `Tier: ${inSum.completeness_tier || "--"}`);
  }
  async function refreshDecisionModal() {
    const { asset, tf } = activeContext();
    const sub = el("decision-modal-subtitle");
    if (sub) sub.textContent = `Evidence-Based Analytical Market Stance Synthesis on ${asset} (${tf})`;
    const heroSummary = el("decision-hero-summary");
    const statusTag = el("decision-status-tag");
    if (heroSummary) heroSummary.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i> Synthesizing market stance across consensus, opportunity and risk...`;
    try {
      const data = await aiService.evaluateDecision(asset, tf);
      if (statusTag) {
        statusTag.textContent = data.status || "READY";
        statusTag.style.color = statusColor(data.status);
      }
      const stance = data.decision || "NEUTRAL";
      const badge = el("decision-stance-badge");
      if (badge) {
        badge.textContent = stance.replace(/_/g, " ");
        badge.className = `decision-stance-badge ${stance.toLowerCase().replace(/_/g, "-")}`;
      }
      const clarity = data.decision_clarity || "\u2014";
      const clarityTag = el("decision-clarity-tag");
      if (clarityTag) {
        clarityTag.textContent = clarity;
        clarityTag.style.color = clarityColor(clarity);
      }
      const title = el("decision-hero-title");
      if (title) title.textContent = STANCE_TITLE[stance] || "Insufficient Market Intelligence";
      if (heroSummary) heroSummary.textContent = data.summary || "";
      const conf = num(data.decision_confidence);
      const confEl = el("decision-confidence-number");
      if (confEl) confEl.innerHTML = scoreHtml(conf);
      const bar = el("decision-meter-bar-fill");
      if (bar) {
        bar.style.width = `${Math.min(100, Math.max(5, conf))}%`;
        bar.style.background = stanceBarColor(stance);
      }
      renderInputQuad("dec-in", data.input_summary || {});
      const primary = data.primary_evidence || [];
      const supporting = data.supporting_evidence || [];
      const evCount = el("decision-evidence-count");
      if (evCount) evCount.textContent = String(primary.length + supporting.length);
      const evList = el("decision-evidence-list");
      if (evList) {
        evList.innerHTML = primary.length + supporting.length === 0 ? `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">No active evidence items detected.</div>` : primary.map((e) => `<div class="decision-evidence-card"><i class="fa-solid fa-circle-check text-green" style="margin-top:2px;"></i><span><strong>Primary:</strong> ${esc(e)}</span></div>`).join("") + supporting.map((e) => `<div class="decision-evidence-card" style="border-left-color:var(--cyan);background:rgba(6,182,212,0.04);"><i class="fa-solid fa-plus text-cyan" style="margin-top:2px;"></i><span><strong>Corroborating:</strong> ${esc(e)}</span></div>`).join("");
      }
      const constraints = data.constraints || [];
      const conflicts = data.conflicts || [];
      const cCount = el("decision-constraints-count");
      if (cCount) cCount.textContent = String(constraints.length + conflicts.length);
      const cList = el("decision-constraints-list");
      if (cList) {
        cList.innerHTML = constraints.length + conflicts.length === 0 ? `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">\u2713 Zero active analytical constraints or conflicts detected.</div>` : conflicts.map((f) => `<div class="decision-conflict-card"><i class="fa-solid fa-triangle-exclamation text-red" style="margin-top:2px;"></i><span><strong>Conflict:</strong> ${esc(f)}</span></div>`).join("") + constraints.map((c) => `<div class="decision-constraint-card"><i class="fa-solid fa-shield-halved text-yellow" style="margin-top:2px;"></i><span><strong>Constraint:</strong> ${esc(c)}</span></div>`).join("");
      }
      const diag = data.diagnostics || {};
      const latency = el("dec-diag-latency");
      if (latency) latency.textContent = `${num(diag.decision_latency_ms).toFixed(2)} ms`;
      const totalEl = el("dec-diag-total");
      if (totalEl) totalEl.textContent = `${num(diag.total_latency_ms).toFixed(1)} ms`;
      const diagClarity = el("dec-diag-clarity");
      if (diagClarity) diagClarity.textContent = clarity;
    } catch (err) {
      if (heroSummary) heroSummary.innerHTML = `<span style="color:var(--neg);">Decision synthesis failed: ${esc(errorText(err))}</span>`;
      if (statusTag) {
        statusTag.textContent = "FAILED";
        statusTag.style.color = "var(--neg)";
      }
    }
  }
  function openExplainModal() {
    if (show("explain-eval-modal")) refreshExplainModal();
  }
  function closeExplainModal() {
    hide("explain-eval-modal");
  }
  async function refreshExplainModal() {
    const { asset, tf } = activeContext();
    const sub = el("explain-modal-subtitle");
    if (sub) sub.textContent = `Institutional Explainability & Traceable Intelligence on ${asset} (${tf})`;
    const headline = el("explain-headline");
    const statusTag = el("explain-status-tag");
    if (headline) headline.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i> Synthesizing traceable insights...`;
    try {
      const data = await aiService.evaluateExplanation(asset, tf);
      if (statusTag) {
        statusTag.textContent = data.status || "READY";
        statusTag.style.color = statusColor(data.status, "#22d3ee");
      }
      const stance = data.market_stance || "NEUTRAL";
      const badge = el("explain-stance-badge");
      if (badge) {
        badge.textContent = stance.replace(/_/g, " ");
        badge.className = `explain-stance-badge ${stance.toLowerCase().replace(/_/g, "-")}`;
      }
      const clarity = data.decision_clarity || "\u2014";
      const clarityTag = el("explain-clarity-tag");
      if (clarityTag) {
        clarityTag.textContent = clarity;
        clarityTag.style.color = clarityColor(clarity);
      }
      const title = el("explain-hero-title");
      if (title) title.textContent = STANCE_TITLE[stance] ? STANCE_TITLE[stance].replace("Market Stance", "Explanation") : "Insufficient Market Intelligence";
      if (headline) headline.textContent = data.headline || "";
      const thesis = el("explain-thesis-list");
      if (thesis) {
        const why = data.why || [];
        thesis.innerHTML = why.length ? why.map((w2) => `<li>${esc(w2)}</li>`).join("") : `<li>No thesis items were produced for this analysis.</li>`;
      }
      const conf = num(data.decision_confidence);
      const confEl = el("explain-confidence-number");
      if (confEl) confEl.innerHTML = scoreHtml(conf);
      const bar = el("explain-meter-bar-fill");
      if (bar) {
        bar.style.width = `${Math.min(100, Math.max(5, conf))}%`;
        bar.style.background = stanceBarColor(stance);
      }
      renderInputQuad("exp-in", data.input_summary || {});
      const primary = data.primary_evidence || [];
      const supporting = data.supporting_evidence || [];
      const all = [...primary, ...supporting];
      const evCount = el("explain-evidence-count");
      if (evCount) evCount.textContent = String(all.length);
      const evList = el("explain-evidence-list");
      if (evList) {
        evList.innerHTML = all.length === 0 ? `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">No corroborating evidence items detected.</div>` : all.map((item) => {
          const isPrimary = primary.includes(item);
          const border = isPrimary ? "var(--pos)" : "var(--cyan)";
          const tint = isPrimary ? "rgba(0, 230, 138, 0.04)" : "rgba(6, 182, 212, 0.04)";
          return `
                    <div class="explain-evidence-card" style="border-left-color:${border};background:${tint};">
                        <div class="explain-evidence-card-header">
                            <div style="display:flex;align-items:center;gap:6px;">
                                <i class="fa-solid ${isPrimary ? "fa-circle-check text-green" : "fa-plus text-cyan"}"></i>
                                <span style="font-weight:700;font-size:10px;text-transform:uppercase;color:var(--text-1);">${isPrimary ? "PRIMARY EVIDENCE" : "SUPPORTING"}</span>
                            </div>
                            <span class="explain-source-badge">${esc(String(item.source || "UNKNOWN").replace(/_/g, " "))}</span>
                        </div>
                        <div style="color:var(--text-2);font-size:11px;line-height:1.45;">${esc(item.message)}</div>
                        <div style="display:flex;align-items:center;gap:8px;font-size:9.5px;color:var(--text-4);font-family:var(--font-mono);">
                            <span>Tag: ${esc(String(item.category || "").replace(/_/g, " "))}</span>
                            ${item.direction ? `<span>Dir: ${esc(item.direction)}</span>` : ""}
                        </div>
                    </div>`;
        }).join("");
      }
      const conflicts = data.conflicts || [];
      const cfCount = el("explain-conflicts-count");
      if (cfCount) cfCount.textContent = String(conflicts.length);
      const cfList = el("explain-conflicts-list");
      if (cfList) {
        cfList.innerHTML = conflicts.length === 0 ? `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">\u2713 Zero model conflicts or cross-system divergences detected.</div>` : conflicts.map((c) => {
          const subs = (c.subsystems || []).map((s) => `<span class="explain-source-badge" style="background:rgba(239,68,68,0.1);color:#fca5a5;border-color:rgba(239,68,68,0.3);">${esc(String(s).replace(/_/g, " "))}</span>`).join(" ");
          return `
                    <div class="explain-conflict-card">
                        <div class="explain-evidence-card-header">
                            <div style="display:flex;align-items:center;gap:6px;"><i class="fa-solid fa-triangle-exclamation text-red"></i><strong style="font-size:10.5px;color:#fca5a5;">${esc(c.title || "Conflict")}</strong></div>
                            <span class="explain-source-badge" style="color:var(--neg);">${esc(c.severity || "\u2014")}</span>
                        </div>
                        <div style="color:var(--text-2);font-size:11px;line-height:1.45;">${esc(c.description)}</div>
                        ${subs ? `<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:2px;">${subs}</div>` : ""}
                    </div>`;
        }).join("");
      }
      const constraints = data.risk_constraints || [];
      const uncertainties = data.uncertainties || [];
      const rkCount = el("explain-risks-count");
      if (rkCount) rkCount.textContent = String(constraints.length + uncertainties.length);
      const rkList = el("explain-risks-list");
      if (rkList) {
        rkList.innerHTML = constraints.length + uncertainties.length === 0 ? `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">\u2713 No active risk constraints or uncertainties limiting analysis.</div>` : constraints.map((rc) => `
                    <div class="explain-uncertainty-card" style="border-left-color:#EAB308;">
                        <div class="explain-evidence-card-header">
                            <div style="display:flex;align-items:center;gap:6px;"><i class="fa-solid fa-shield-halved text-yellow"></i><strong style="font-size:10.5px;color:#fde047;">Risk Constraint</strong></div>
                            <span class="explain-source-badge">${esc(String(rc.source || "RISK_GUARD").replace(/_/g, " "))}</span>
                        </div>
                        <div style="color:var(--text-2);font-size:11px;line-height:1.45;">${esc(rc.message)}</div>
                    </div>`).join("") + uncertainties.map((un) => `
                    <div class="explain-uncertainty-card" style="border-left-color:#A855F7;background:rgba(168,85,247,0.04);">
                        <div class="explain-evidence-card-header">
                            <div style="display:flex;align-items:center;gap:6px;"><i class="fa-solid fa-circle-question text-purple"></i><strong style="font-size:10.5px;color:#d8b4fe;">${esc(un.category ? String(un.category).replace(/_/g, " ") : "Uncertainty")}</strong></div>
                            <span class="explain-source-badge" style="color:#d8b4fe;">${esc(String(un.source || "ORBIT_BRAIN").replace(/_/g, " "))}</span>
                        </div>
                        <div style="color:var(--text-2);font-size:11px;line-height:1.45;">${esc(un.description)}</div>
                    </div>`).join("");
      }
      const diag = data.diagnostics || {};
      const set = (id, text) => {
        const node = el(id);
        if (node) node.textContent = text;
      };
      set("exp-diag-latency", `${num(diag.explain_latency_ms).toFixed(2)} ms`);
      set("exp-diag-dec-latency", `${num(diag.decision_latency_ms).toFixed(2)} ms`);
      set("exp-diag-total", `${num(diag.total_latency_ms).toFixed(1)} ms`);
    } catch (err) {
      if (headline) headline.innerHTML = `<span style="color:var(--neg);">Explainability synthesis failed: ${esc(errorText(err))}</span>`;
      if (statusTag) {
        statusTag.textContent = "FAILED";
        statusTag.style.color = "var(--neg)";
      }
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
  function errorText2(err) {
    return err instanceof Error ? err.message : String(err);
  }
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
    setTimeout(() => getElement("copilot-chat-input")?.focus(), 150);
  }
  function closeCopilotModal() {
    getElement("orbit-copilot-modal")?.classList.add("hidden");
  }
  async function refreshCopilotContext(asset, tf) {
    const symbol = asset || store.get("currentAsset") || "BTC-USD";
    const timeframe = tf || store.get("currentTimeframe") || "1d";
    try {
      const d = await aiService.getCopilotContext(symbol, timeframe);
      const stanceEl = getElement("copilot-tel-stance");
      if (stanceEl) {
        stanceEl.textContent = d.market_stance;
        stanceEl.className = `copilot-stance-tag ${(d.market_stance || "").toLowerCase().replace(/_/g, "-")}`;
      }
      const confEl = getElement("copilot-tel-confidence");
      if (confEl) confEl.textContent = `${Number(d.confidence || 0).toFixed(1)}%`;
      const riskEl = getElement("copilot-tel-risk");
      if (riskEl) riskEl.textContent = `${d.risk_level} (${Number(d.risk_score || 0).toFixed(0)})`;
      const oppEl = getElement("copilot-tel-opportunity");
      if (oppEl) oppEl.textContent = `${Number(d.opportunity_score || 0).toFixed(0)}/100`;
    } catch (e) {
      console.warn("[Copilot] Context telemetry unavailable:", e);
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
    if (_copilotConversationId) {
      aiService.resetCopilotSession(_copilotConversationId).catch(() => {
      });
    }
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
            </div>`;
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
            <div class="copilot-msg-body">${esc(text)}</div>`;
      stream.appendChild(userCard);
      const typingCard = document.createElement("div");
      typingCard.className = "copilot-typing-card";
      typingCard.id = "copilot-typing-indicator";
      typingCard.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i><span>ORBIT Copilot is reasoning over ${esc(asset)} analysis...</span>`;
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
        conversation_id: _copilotConversationId || void 0
      });
      getElement("copilot-typing-indicator")?.remove();
      _copilotConversationId = d.conversation_id;
      const card = document.createElement("div");
      card.className = "copilot-msg-card copilot-assistant";
      card.innerHTML = `
            <div class="copilot-msg-header">
                <i class="fa-solid fa-robot text-green"></i>
                <strong>ORBIT Copilot</strong>
                <span class="copilot-symbol-pill" style="font-size:9.5px;padding:1px 6px;">${esc(d.symbol)}</span>
                <span class="copilot-msg-time">${Number(d.latency_ms || 0).toFixed(0)} ms</span>
            </div>
            <div class="copilot-msg-body">${formatCopilotMarkdown(d.answer)}</div>`;
      if (stream) {
        stream.appendChild(card);
        stream.scrollTop = stream.scrollHeight;
      }
    } catch (err) {
      console.error("[Copilot] Chat error:", err);
      getElement("copilot-typing-indicator")?.remove();
      if (stream) {
        const errCard = document.createElement("div");
        errCard.className = "copilot-msg-card copilot-assistant";
        errCard.innerHTML = `
                <div class="copilot-msg-header">
                    <i class="fa-solid fa-triangle-exclamation text-red"></i>
                    <strong>ORBIT Copilot</strong>
                </div>
                <div class="copilot-msg-body text-red">Failed to communicate with AI Copilot: ${esc(errorText2(err))}</div>`;
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
    if (balanceEl) balanceEl.textContent = formatINRSafe(store.get("dashboardSummary")?.available_balance);
  }
  var _copilotPageSessionId = null;
  var _copilotPageIsLoading = false;
  var _copilotActiveAsset = "AAPL";
  var _copilotActiveMarket = "US Stocks";
  var _copilotActiveMode = "DETAILED";
  var _copilotSearchTimer;
  var _copilotLoadingInterval;
  async function loadConversationsList() {
    const listEl = getElement("copilot-history-list");
    if (!listEl) return;
    try {
      const convs = await aiService.listConversations(40);
      if (!convs.length) {
        listEl.innerHTML = `
                <div class="copilot-history-empty">
                    <i class="fa-regular fa-message" style="margin-bottom:6px;font-size:18px;opacity:0.5;"></i>
                    <p style="margin:0;">No previous analyses.</p>
                </div>`;
        return;
      }
      const now = /* @__PURE__ */ new Date();
      const todayStr = now.toDateString();
      const yest = new Date(now);
      yest.setDate(yest.getDate() - 1);
      const yestStr = yest.toDateString();
      const groups = { today: [], yesterday: [], older: [] };
      convs.forEach((c) => {
        const dStr = new Date(c.updated_at || c.created_at).toDateString();
        if (dStr === todayStr) groups.today.push(c);
        else if (dStr === yestStr) groups.yesterday.push(c);
        else groups.older.push(c);
      });
      const renderGroup = (title, items) => !items.length ? "" : `
            <div class="copilot-history-group">
                <div class="copilot-history-group-title">${title}</div>
                ${items.map((c) => {
        const sym = c.selected_asset || "ASSET";
        const cleanTitle = esc(c.title || `${sym} Analysis`);
        const id = esc(c.id);
        return `
                    <div class="copilot-history-item ${c.id === _copilotPageSessionId ? "active" : ""}" onclick="selectConversation('${id}')" title="${cleanTitle}">
                        <div class="copilot-history-item-content">
                            <div class="copilot-history-title">${cleanTitle}</div>
                            <div class="copilot-history-meta">
                                <span class="copilot-history-badge">${esc(sym)}</span>
                                <span>${esc(c.selected_market || "Market")}</span>
                            </div>
                        </div>
                        <button class="copilot-history-delete-btn" onclick="deleteConversationClick(event, '${id}')" title="Delete conversation">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>`;
      }).join("")}
            </div>`;
      listEl.innerHTML = renderGroup("TODAY", groups.today) + renderGroup("YESTERDAY", groups.yesterday) + renderGroup("OLDER", groups.older);
    } catch (err) {
      console.warn("[Copilot] Error loading conversations:", err);
    }
  }
  async function selectConversation(convId) {
    if (!convId) return;
    try {
      const detail = await aiService.getConversation(convId);
      _copilotPageSessionId = detail.conversation.id;
      if (detail.conversation.selected_asset) _copilotActiveAsset = detail.conversation.selected_asset;
      if (detail.conversation.selected_market) {
        _copilotActiveMarket = detail.conversation.selected_market;
        const mktSelect = getElement("copilot-market-select");
        if (mktSelect) mktSelect.value = _copilotActiveMarket;
      }
      updateActiveAssetBanner(_copilotActiveAsset, _copilotActiveMarket);
      const messagesBox = getElement("copilot-page-messages");
      if (messagesBox) {
        messagesBox.innerHTML = "";
        detail.messages.forEach((m) => {
          const isUser = m.role === "user";
          const card = document.createElement("div");
          card.className = `copilot-page-msg-card ${isUser ? "user" : "orbit"}`;
          const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : "";
          card.innerHTML = `
                    <div class="copilot-page-msg-header">
                        <i class="fa-solid ${isUser ? "fa-user" : "fa-robot text-emerald"}"></i>
                        <strong>${isUser ? "You" : "ORBIT Copilot"}</strong>
                        ${timeStr ? `<span>&bull; ${esc(timeStr)}</span>` : ""}
                    </div>
                    <div class="copilot-page-msg-body">${isUser ? esc(m.content) : formatCopilotMarkdown(m.content)}</div>`;
          messagesBox.appendChild(card);
        });
        messagesBox.scrollTop = messagesBox.scrollHeight;
      }
      syncCopilotPageView();
      loadConversationsList();
    } catch (err) {
      console.warn("[Copilot] Error selecting conversation:", err);
    }
  }
  function createNewAnalysis() {
    _copilotPageSessionId = null;
    const messagesBox = getElement("copilot-page-messages");
    if (messagesBox) messagesBox.innerHTML = "";
    syncCopilotPageView();
    loadConversationsList();
    getElement("copilot-page-input")?.focus();
  }
  function toggleCopilotSidebar() {
    const sidebar = document.querySelector(".copilot-history-sidebar");
    const container = document.querySelector(".copilot-terminal-container");
    const openBtn = getElement("copilot-sidebar-open-tab");
    if (!sidebar || !container) return;
    const isCollapsed = sidebar.classList.toggle("collapsed");
    container.classList.toggle("sidebar-collapsed", isCollapsed);
    if (openBtn) openBtn.classList.toggle("hidden", !isCollapsed);
  }
  async function deleteConversationClick(event, convId) {
    if (event) event.stopPropagation();
    if (!convId) return;
    try {
      await aiService.deleteConversation(convId);
      if (_copilotPageSessionId === convId) createNewAnalysis();
      else loadConversationsList();
    } catch (err) {
      console.warn("[Copilot] Delete conversation error:", err);
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
    if (exchEl) exchEl.textContent = market || _copilotActiveMarket;
    if (symBadge) symBadge.textContent = sym;
  }
  function onAssetSearchInput(query) {
    window.clearTimeout(_copilotSearchTimer);
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
    _copilotSearchTimer = window.setTimeout(async () => {
      try {
        const results = await marketService.searchSymbols(q, _copilotActiveMarket);
        if (!results.length) {
          dropdown.innerHTML = `<div class="copilot-search-empty">No matching assets found</div>`;
          return;
        }
        dropdown.innerHTML = results.slice(0, 8).map((r) => `
                <div class="copilot-search-item" onclick="selectAsset('${esc(r.symbol)}', '${esc(r.name)}', '${esc(r.exchange || "")}')">
                    <div class="copilot-search-item-left">
                        <span class="copilot-search-item-sym">${esc(r.symbol)}</span>
                        <span class="copilot-search-item-name">${esc(r.name)}</span>
                    </div>
                    <div class="copilot-search-item-right">${esc(r.exchange || r.type || "")}</div>
                </div>`).join("");
      } catch {
        dropdown.innerHTML = `<div class="copilot-search-empty text-ruby">Search temporarily unavailable</div>`;
      }
    }, 280);
  }
  function selectAsset(symbol, name, exchange) {
    _copilotActiveAsset = symbol.trim().toUpperCase();
    if (exchange) _copilotActiveMarket = exchange;
    updateActiveAssetBanner(_copilotActiveAsset, exchange || _copilotActiveMarket, name);
    getElement("copilot-search-dropdown")?.classList.add("hidden");
    const searchInput = getElement("copilot-asset-search");
    if (searchInput) searchInput.value = "";
    syncCopilotPageView();
  }
  function setResponseMode(mode) {
    _copilotActiveMode = mode;
    document.querySelectorAll(".copilot-mode-btn").forEach((b) => b.classList.toggle("active", b.getAttribute("data-mode") === mode));
  }
  async function syncCopilotPageView() {
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
    const symBadge = getElement("copilot-page-symbol");
    if (symBadge) symBadge.textContent = activeSym;
    try {
      const d = await aiService.getCopilotContext(activeSym, store.get("currentTimeframe") || "1d");
      if (statusBadge) {
        statusBadge.className = "copilot-status-badge live";
        statusBadge.innerHTML = '<span class="copilot-status-pulse"></span> Pipeline Live';
      }
      if (stanceEl) {
        stanceEl.textContent = d.market_stance;
        stanceEl.className = `copilot-metric-pill stance-${(d.market_stance || "").toLowerCase()}`;
      }
      if (confEl) confEl.textContent = `${Number(d.confidence || 0).toFixed(1)}%`;
      if (riskEl) {
        riskEl.textContent = `${d.risk_level} (${Number(d.risk_score || 0).toFixed(0)})`;
        riskEl.className = `copilot-metric-pill risk-${(d.risk_level || "").toLowerCase()}`;
      }
      if (oppEl) {
        oppEl.textContent = `${Number(d.opportunity_score || 0).toFixed(0)}/100`;
        oppEl.className = `copilot-metric-pill opp-${(d.opportunity_level || "").toLowerCase()}`;
      }
      if (setupsEl) setupsEl.textContent = d.clarity || "\u2014";
      if (messagesBox && messagesBox.childElementCount === 0) {
        const welcome = document.createElement("div");
        welcome.className = "copilot-page-msg-card orbit";
        welcome.innerHTML = `
                <div class="copilot-page-msg-header">
                    <i class="fa-solid fa-robot text-emerald"></i>
                    <strong>ORBIT Copilot</strong>
                    <span>&bull; ${esc(activeSym)} Context Active</span>
                </div>
                <div class="copilot-page-msg-body">
                    <p>Connected to <strong>${esc(activeSym)}</strong> in <strong>${esc(_copilotActiveMarket)}</strong> through the ORBIT analysis pipeline.</p>
                    <p>${esc(d.headline || "")}</p>
                    <p>Current Stance: <strong>${esc(d.market_stance)}</strong> (${Number(d.confidence).toFixed(1)}% confidence).
                    Risk is <strong>${esc(d.risk_level)}</strong> (${Number(d.risk_score).toFixed(1)}/100) and Opportunity is <strong>${Number(d.opportunity_score).toFixed(1)}/100</strong>.</p>
                </div>`;
        messagesBox.appendChild(welcome);
      }
    } catch (err) {
      if (statusBadge) {
        statusBadge.className = "copilot-status-badge not-available";
        statusBadge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${esc(errorText2(err)).slice(0, 80) || "Unavailable"}`;
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
            <div class="copilot-page-msg-body">${esc(message)}</div>`;
      messagesBox.appendChild(userCard);
      messagesBox.scrollTop = messagesBox.scrollHeight;
    }
    if (input) input.value = "";
    if (sendBtn) sendBtn.disabled = true;
    if (loadingBar) loadingBar.classList.remove("hidden");
    if (errorBanner) errorBanner.classList.add("hidden");
    _copilotPageIsLoading = true;
    const stages = [
      "Loading market data...",
      "Running agents & strategies...",
      "Evaluating risk guard & consensus...",
      "Generating ORBIT analytical view..."
    ];
    let stageIdx = 0;
    if (loadingText) loadingText.textContent = stages[0];
    window.clearInterval(_copilotLoadingInterval);
    _copilotLoadingInterval = window.setInterval(() => {
      stageIdx = (stageIdx + 1) % stages.length;
      if (loadingText) loadingText.textContent = stages[stageIdx];
    }, 1500);
    try {
      const d = await aiService.chatCopilot({
        message,
        symbol: activeSym,
        selected_asset: activeSym,
        selected_market: _copilotActiveMarket,
        timeframe: store.get("currentTimeframe") || "1d",
        conversation_id: _copilotPageSessionId || void 0,
        response_mode: _copilotActiveMode
      });
      window.clearInterval(_copilotLoadingInterval);
      if (loadingBar) loadingBar.classList.add("hidden");
      _copilotPageSessionId = d.conversation_id;
      if (messagesBox) {
        const card = document.createElement("div");
        card.className = "copilot-page-msg-card orbit";
        card.innerHTML = `
                <div class="copilot-page-msg-header">
                    <i class="fa-solid fa-robot text-emerald"></i>
                    <strong>ORBIT Copilot</strong>
                    ${d.latency_ms ? `<span>&bull; ${Number(d.latency_ms).toFixed(0)}ms</span>` : ""}
                </div>
                <div class="copilot-page-msg-body">${formatCopilotMarkdown(d.answer)}</div>`;
        messagesBox.appendChild(card);
        messagesBox.scrollTop = messagesBox.scrollHeight;
      }
      loadConversationsList();
    } catch (err) {
      window.clearInterval(_copilotLoadingInterval);
      if (loadingBar) loadingBar.classList.add("hidden");
      if (errorBanner) {
        const errMsg = getElement("copilot-page-error-msg");
        if (errMsg) errMsg.textContent = `ORBIT Copilot notice: ${errorText2(err)}`;
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
    if (_copilotPageSessionId) aiService.resetCopilotSession(_copilotPageSessionId).catch(() => {
    });
    createNewAnalysis();
  }

  // src/ui/reportsController.ts
  var reportData = null;
  var CHART = {
    green: "#3fb950",
    red: "#e5484d",
    grid: "rgba(255,255,255,0.06)",
    axis: "rgba(255,255,255,0.22)",
    text: "#9ba2ad"
  };
  function rupees(value, decimals = 2) {
    const n = Number(value) || 0;
    const sign = n < 0 ? "-" : "";
    return sign + "\u20B9" + Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  function signedRupees(value) {
    const n = Number(value) || 0;
    return (n >= 0 ? "+" : "") + rupees(n);
  }
  function signedRupeesShort(value) {
    const n = Number(value) || 0;
    return (n >= 0 ? "+" : "") + rupees(n, 0);
  }
  function pnlClass(value) {
    const n = Number(value) || 0;
    return n > 0 ? "text-green" : n < 0 ? "text-red" : "text-muted";
  }
  function svgWrap(inner, width, height) {
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" class="report-svg" role="img">${inner}</svg>`;
  }
  function emptyChart(message) {
    return `<div class="report-chart-empty"><i class="fa-solid fa-chart-line"></i><span>${esc(message)}</span></div>`;
  }
  function renderEquityCurve(curve) {
    const host = getElement("chart-equity");
    if (!host) return;
    if (!curve.length) {
      host.innerHTML = emptyChart("No closed trades yet \u2014 the equity curve appears once trades settle.");
      return;
    }
    const W = 1e3, H = 300, padL = 92, padR = 26, padT = 22, padB = 38;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const values = curve.map((p) => p.cumulative);
    const min = Math.min(0, ...values);
    let max = Math.max(0, ...values);
    if (min === max) max = min + 1;
    const span = max - min;
    const x = (i) => padL + (curve.length === 1 ? plotW / 2 : i / (curve.length - 1) * plotW);
    const y = (v) => padT + plotH - (v - min) / span * plotH;
    let grid = "";
    for (let t = 0; t <= 5; t++) {
      const value = min + span * t / 5;
      const gy = y(value);
      grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="${CHART.grid}" stroke-width="1"/>`;
      grid += `<text x="${padL - 8}" y="${gy + 4}" fill="${CHART.text}" font-size="11" text-anchor="end" font-family="monospace">${esc(rupees(value, 0))}</text>`;
    }
    const zeroY = y(0);
    grid += `<line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="${CHART.axis}" stroke-width="1.5" stroke-dasharray="4 4"/>`;
    const points = curve.map((p, i) => `${x(i)},${y(p.cumulative)}`).join(" ");
    const lineColor = values[values.length - 1] >= 0 ? CHART.green : CHART.red;
    const area = `${padL},${zeroY} ${points} ${x(curve.length - 1)},${zeroY}`;
    const dots = curve.length > 60 ? "" : curve.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.cumulative)}" r="3" fill="${p.pnl >= 0 ? CHART.green : CHART.red}" stroke="#0b0c0e" stroke-width="1">
            <title>#${p.n} ${esc(p.asset || "")} \u2014 trade ${signedRupees(p.pnl)}, running ${signedRupees(p.cumulative)}</title>
         </circle>`).join("");
    host.innerHTML = svgWrap(`
        <defs><linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${lineColor}" stop-opacity="0.35"/><stop offset="100%" stop-color="${lineColor}" stop-opacity="0.02"/>
        </linearGradient></defs>
        ${grid}
        <polygon points="${area}" fill="url(#eqFill)"/>
        <polyline points="${points}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}
        <text x="${padL}" y="${H - 12}" fill="${CHART.text}" font-size="11">trade 1</text>
        <text x="${W - padR}" y="${H - 12}" fill="${CHART.text}" font-size="11" text-anchor="end">trade ${curve.length}</text>`, W, H);
  }
  function renderPnlBars(curve) {
    const host = getElement("chart-pnl-bars");
    if (!host) return;
    if (!curve.length) {
      host.innerHTML = emptyChart("No closed trades to chart.");
      return;
    }
    const W = 520, H = 260, padL = 78, padR = 18, padT = 18, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const bound = Math.max(1, ...curve.map((p) => Math.abs(p.pnl)));
    const y = (v) => padT + plotH / 2 - v / bound * (plotH / 2);
    const midY = padT + plotH / 2;
    const slot = plotW / curve.length;
    const barW = Math.max(2, Math.min(22, slot * 0.7));
    const bars = curve.map((p, i) => {
      const cx = padL + slot * i + slot / 2;
      const top = p.pnl >= 0 ? y(p.pnl) : midY;
      const h = Math.max(1, Math.abs(midY - y(p.pnl)));
      return `<rect x="${cx - barW / 2}" y="${top}" width="${barW}" height="${h}" fill="${p.pnl >= 0 ? CHART.green : CHART.red}" opacity="0.85" rx="2">
                    <title>#${p.n} ${esc(p.asset || "")} \u2014 ${signedRupees(p.pnl)}</title></rect>`;
    }).join("");
    host.innerHTML = svgWrap(`
        <line x1="${padL}" y1="${y(bound)}" x2="${W - padR}" y2="${y(bound)}" stroke="${CHART.grid}"/>
        <line x1="${padL}" y1="${y(-bound)}" x2="${W - padR}" y2="${y(-bound)}" stroke="${CHART.grid}"/>
        <text x="${padL - 8}" y="${y(bound) + 4}" fill="${CHART.text}" font-size="10" text-anchor="end" font-family="monospace">${esc(rupees(bound, 0))}</text>
        <text x="${padL - 8}" y="${y(-bound) + 4}" fill="${CHART.text}" font-size="10" text-anchor="end" font-family="monospace">${esc(rupees(-bound, 0))}</text>
        ${bars}
        <line x1="${padL}" y1="${midY}" x2="${W - padR}" y2="${midY}" stroke="${CHART.axis}" stroke-width="1"/>`, W, H);
  }
  function renderWinLoss(summary) {
    const host = getElement("chart-winloss");
    if (!host) return;
    const wins = summary.wins || 0;
    const losses = summary.losses || 0;
    const total = wins + losses;
    if (total === 0) {
      host.innerHTML = emptyChart("No settled trades yet.");
      return;
    }
    const W = 520, H = 260, cx = 170, cy = 130, r = 80, thickness = 26, legendX = 353, legendTextX = 373;
    const circumference = 2 * Math.PI * r;
    const winFraction = wins / total;
    host.innerHTML = svgWrap(`
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${CHART.red}" stroke-width="${thickness}"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${CHART.green}" stroke-width="${thickness}"
                stroke-dasharray="${circumference * winFraction} ${circumference}" transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt"/>
        <text x="${cx}" y="${cy - 2}" fill="#e7e9ec" font-size="32" font-weight="700" text-anchor="middle" font-family="monospace">${(winFraction * 100).toFixed(1)}%</text>
        <text x="${cx}" y="${cy + 22}" fill="${CHART.text}" font-size="12" text-anchor="middle">win rate</text>
        <rect x="${legendX}" y="90" width="13" height="13" rx="3" fill="${CHART.green}"/>
        <text x="${legendTextX}" y="102" fill="#e7e9ec" font-size="14">${wins} wins</text>
        <text x="${legendTextX}" y="121" fill="${CHART.text}" font-size="12" font-family="monospace">${esc(rupees(summary.gross_profit, 0))}</text>
        <rect x="${legendX}" y="152" width="13" height="13" rx="3" fill="${CHART.red}"/>
        <text x="${legendTextX}" y="164" fill="#e7e9ec" font-size="14">${losses} losses</text>
        <text x="${legendTextX}" y="183" fill="${CHART.text}" font-size="12" font-family="monospace">${esc(rupees(-summary.gross_loss, 0))}</text>`, W, H);
  }
  function renderBreakdown(hostId, rows, emptyMessage) {
    const host = getElement(hostId);
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = emptyChart(emptyMessage);
      return;
    }
    const shown = rows.slice(0, 8);
    const rowH = 30, padL = 112, padR = 104, W = 520, H = 264;
    const padT = Math.max(12, (H - shown.length * rowH) / 2);
    const plotW = W - padL - padR;
    const bound = Math.max(1, ...shown.map((r) => Math.abs(r.pnl)));
    const midX = padL + plotW / 2;
    const scale = plotW / 2 / bound;
    const bars = shown.map((r, i) => {
      const cy = padT + i * rowH + rowH / 2;
      const w2 = Math.max(1, Math.abs(r.pnl) * scale);
      const x = r.pnl >= 0 ? midX : midX - w2;
      const color = r.pnl >= 0 ? CHART.green : CHART.red;
      const label = String(r.name).length > 15 ? String(r.name).slice(0, 14) + "\u2026" : String(r.name);
      return `
            <text x="${padL - 10}" y="${cy + 4}" fill="${CHART.text}" font-size="11" text-anchor="end">${esc(label)}</text>
            <rect x="${x}" y="${cy - 9}" width="${w2}" height="18" fill="${color}" opacity="0.8" rx="2">
                <title>${esc(r.name)} \u2014 ${r.trades} trades${r.win_rate !== void 0 ? `, ${r.win_rate}% win rate` : ""}, ${signedRupees(r.pnl)}</title>
            </rect>
            <text x="${W - padR + 12}" y="${cy + 4}" fill="${color}" font-size="11" font-family="monospace">${esc(signedRupeesShort(r.pnl))}</text>`;
    }).join("");
    host.innerHTML = svgWrap(`<line x1="${midX}" y1="${padT}" x2="${midX}" y2="${H - padT}" stroke="${CHART.axis}" stroke-width="1"/>${bars}`, W, H);
  }
  function renderKpis(s) {
    const netEl = getElement("rk-net-pnl");
    if (netEl) {
      netEl.textContent = signedRupees(s.net_pnl);
      netEl.className = "report-kpi-value " + pnlClass(s.net_pnl);
    }
    safeText(getElement("rk-net-pnl-sub"), `${s.closed_trades} closed of ${s.total_trades} total`);
    safeText(getElement("rk-win-rate"), `${s.win_rate}%`);
    safeText(getElement("rk-win-rate-sub"), `${s.wins}W / ${s.losses}L`);
    const pfEl = getElement("rk-profit-factor");
    if (pfEl) {
      pfEl.textContent = s.profit_factor === null ? "\u221E" : s.profit_factor.toFixed(2);
      pfEl.className = "report-kpi-value " + (s.profit_factor === null || s.profit_factor >= 1 ? "text-green" : "text-red");
    }
    const expEl = getElement("rk-expectancy");
    if (expEl) {
      expEl.textContent = signedRupees(s.expectancy);
      expEl.className = "report-kpi-value " + pnlClass(s.expectancy);
    }
    safeText(getElement("rk-drawdown"), rupees(s.max_drawdown));
    safeText(getElement("rk-drawdown-sub"), `${s.max_drawdown_pct}% of peak equity`);
    const ratio = s.avg_loss > 0 ? s.avg_win / s.avg_loss : null;
    safeText(getElement("rk-avg-ratio"), ratio === null ? "\u2014" : `${ratio.toFixed(2)} : 1`);
    safeText(getElement("rk-avg-sub"), `${rupees(s.avg_win, 0)} avg win / ${rupees(s.avg_loss, 0)} avg loss`);
    safeText(getElement("rk-best-worst"), `${signedRupeesShort(s.best_trade)} / ${signedRupeesShort(s.worst_trade)}`);
    safeText(getElement("rk-streaks"), `streaks ${s.longest_win_streak}W / ${s.longest_loss_streak}L`);
    safeText(getElement("rk-open"), String(s.open_trades + s.pending_trades));
    safeText(getElement("rk-open-sub"), `${s.open_trades} active \xB7 ${s.pending_trades} pending \xB7 unrealized ${signedRupeesShort(s.unrealized_pnl)}`);
  }
  function filteredTrades() {
    if (!reportData) return [];
    const asset = getElement("report-filter-asset")?.value || "all";
    const outcome = getElement("report-filter-outcome")?.value || "all";
    return reportData.trades.filter((t) => {
      if (asset !== "all" && t.asset !== asset) return false;
      if (outcome === "win") return t.status === "closed" && Number(t.pnl) > 0;
      if (outcome === "loss") return t.status === "closed" && Number(t.pnl) <= 0;
      if (outcome === "open") return t.status === "active" || t.status === "pending";
      return true;
    });
  }
  function renderTable() {
    const tbody = getElement("report-table-body");
    if (!tbody) return;
    const rows = filteredTrades();
    safeText(getElement("report-row-count"), `${rows.length} trade${rows.length === 1 ? "" : "s"}`);
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="12" class="report-empty">${reportData ? "No trades match the current filter." : "No report loaded."}</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.slice().reverse().map((t) => {
      const pnl = Number(t.pnl) || 0;
      const isClosed = t.status === "closed";
      return `
            <tr>
                <td class="mono muted">${esc(t.id)}</td>
                <td class="mono">${esc(t.timestamp || "\u2014")}</td>
                <td><strong>${esc(t.asset)}</strong></td>
                <td><span class="report-badge ${t.type === "buy" ? "badge-buy" : "badge-sell"}">${esc(String(t.type || "").toUpperCase())}</span></td>
                <td class="mono">${Number(t.quantity || 0).toFixed(4)}</td>
                <td class="mono">${esc(rupees(t.entry_price))}</td>
                <td class="mono">${t.exit_price ? esc(rupees(t.exit_price)) : "\u2014"}</td>
                <td class="mono text-red">${esc(rupees(t.sl))}</td>
                <td class="mono text-green">${esc(rupees(t.target))}</td>
                <td><span class="report-badge badge-${esc(t.status)}">${esc(String(t.status || "").toUpperCase())}</span></td>
                <td class="muted">${esc(t.outcome ? String(t.outcome).toUpperCase() : "\u2014")}</td>
                <td class="mono ta-right ${isClosed ? pnlClass(pnl) : "text-muted"}">${isClosed ? esc(signedRupees(pnl)) : "\u2014"}</td>
            </tr>`;
    }).join("");
  }
  async function loadReport() {
    if (!store.get("currentUserId")) return;
    const generated = getElement("report-generated");
    if (generated) generated.textContent = "Generating\u2026";
    try {
      reportData = await portfolioService.getReport(store.get("currentUserId"));
    } catch (err) {
      if (generated) generated.textContent = "Could not load report";
      const tbody = getElement("report-table-body");
      if (tbody) tbody.innerHTML = `<tr><td colspan="12" class="report-empty text-red">Failed to load the report: ${esc(err.message)}</td></tr>`;
      return;
    }
    safeText(generated, `Generated ${reportData.generated_at}`);
    const assetFilter = getElement("report-filter-asset");
    if (assetFilter) {
      const previous = assetFilter.value;
      const assets = [...new Set(reportData.trades.map((t) => t.asset))].sort();
      assetFilter.innerHTML = `<option value="all">All Assets</option>` + assets.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
      if (assets.includes(previous)) assetFilter.value = previous;
    }
    renderKpis(reportData.summary);
    renderEquityCurve(reportData.equity_curve || []);
    renderPnlBars(reportData.equity_curve || []);
    renderWinLoss(reportData.summary);
    renderBreakdown("chart-by-asset", reportData.by_asset || [], "No closed trades to break down by asset.");
    renderBreakdown("chart-by-month", reportData.by_month || [], "No closed trades to break down by month.");
    renderTable();
  }
  function downloadBlob(content, filename, mimeType) {
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }
  function stamp() {
    const d = /* @__PURE__ */ new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }
  function exportReportCsv() {
    if (!reportData) {
      alert("Load the report first.");
      return;
    }
    const s = reportData.summary;
    const cell = (v) => {
      const text = String(v === null || v === void 0 ? "" : v);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = ["ORBIT TRADING TERMINAL - PERFORMANCE REPORT", `Generated,${cell(reportData.generated_at)}`, "", "SUMMARY"];
    [
      ["Total Trades", s.total_trades],
      ["Closed Trades", s.closed_trades],
      ["Open Trades", s.open_trades],
      ["Pending Trades", s.pending_trades],
      ["Wins", s.wins],
      ["Losses", s.losses],
      ["Win Rate %", s.win_rate],
      ["Net Realized P&L", s.net_pnl],
      ["Gross Profit", s.gross_profit],
      ["Gross Loss", s.gross_loss],
      ["Profit Factor", s.profit_factor === null ? "N/A (no losses)" : s.profit_factor],
      ["Expectancy Per Trade", s.expectancy],
      ["Average Win", s.avg_win],
      ["Average Loss", s.avg_loss],
      ["Best Trade", s.best_trade],
      ["Worst Trade", s.worst_trade],
      ["Max Drawdown", s.max_drawdown],
      ["Max Drawdown %", s.max_drawdown_pct],
      ["Longest Win Streak", s.longest_win_streak],
      ["Longest Loss Streak", s.longest_loss_streak],
      ["Unrealized P&L", s.unrealized_pnl]
    ].forEach(([k, v]) => lines.push(`${cell(k)},${cell(v)}`));
    lines.push("", "TRADE LEDGER", ["ID", "Timestamp", "Asset", "Side", "Quantity", "Entry", "Exit", "Stop Loss", "Target", "Status", "Outcome", "P&L"].join(","));
    filteredTrades().forEach((t) => lines.push([
      t.id,
      t.timestamp,
      t.asset,
      t.type,
      t.quantity,
      t.entry_price,
      t.exit_price ?? "",
      t.sl,
      t.target,
      t.status,
      t.outcome || "",
      t.pnl
    ].map(cell).join(",")));
    downloadBlob("\uFEFF" + lines.join("\r\n"), `orbit-report-${stamp()}.csv`, "text/csv;charset=utf-8");
  }
  function exportReportJson() {
    if (!reportData) {
      alert("Load the report first.");
      return;
    }
    downloadBlob(JSON.stringify(reportData, null, 2), `orbit-report-${stamp()}.json`, "application/json");
  }
  function exportReportPdf() {
    if (!reportData) return;
    document.body.classList.add("printing-report");
    const cleanup = () => {
      document.body.classList.remove("printing-report");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
    setTimeout(cleanup, 3e3);
  }
  function initReportsListeners() {
    const bind = (id, event, handler) => {
      const node = getElement(id);
      if (node && !node.hasAttribute("onclick")) node.addEventListener(event, handler);
    };
    bind("report-refresh-btn", "click", () => void loadReport());
    bind("report-export-csv", "click", exportReportCsv);
    bind("report-export-json", "click", exportReportJson);
    bind("report-export-pdf", "click", exportReportPdf);
    bind("report-filter-asset", "change", renderTable);
    bind("report-filter-outcome", "change", renderTable);
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
  async function drawBtcSparkline() {
    const canvas = getElement("btc-sparkline-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let points = [];
    try {
      const res = await fetch("/api/market/history?symbol=BTC-USD&period=30d&interval=1d", { credentials: "same-origin" });
      if (res.ok) {
        const json = await res.json();
        const candles = json && json.data && json.data.candles || [];
        points = candles.slice(-14).map((c) => Number(c.close)).filter((v) => Number.isFinite(v) && v > 0);
      }
    } catch {
      points = [];
    }
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    if (points.length < 2) return;
    const maxVal = Math.max(...points);
    const minVal = Math.min(...points);
    const range = maxVal - minVal || 1;
    const stepX = width / (points.length - 1);
    const yOf = (val) => height - 6 - (val - minVal) / range * (height - 12);
    const rising = points[points.length - 1] >= points[0];
    const color = rising ? "#34d399" : "#f87171";
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, rising ? "rgba(52, 211, 153, 0.3)" : "rgba(248, 113, 113, 0.3)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.beginPath();
    points.forEach((val, i) => i === 0 ? ctx.moveTo(0, yOf(val)) : ctx.lineTo(i * stepX, yOf(val)));
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.beginPath();
    points.forEach((val, i) => i === 0 ? ctx.moveTo(0, yOf(val)) : ctx.lineTo(i * stepX, yOf(val)));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = color;
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
  w.prepareTradeEnvironment = prepareTradeEnvironment;
  w.runAgentCrew = runAgentCrew;
  w.stopAgentCrew = stopAgentCrew;
  w.fetchGlobalNews = fetchGlobalNews;
  w.fetchSymbolNews = fetchSymbolNews;
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
  w.exportReportPdf = exportReportPdf;
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
  function throttle(fn, ms) {
    let last = 0;
    let timer = null;
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
  var refreshPortfolio = throttle(() => {
    loadOpenTrades();
    loadPendingOrders();
    fetchDashboardSummary();
  }, 1500);
  var refreshLivePnl = throttle(() => {
    loadOpenTrades();
    fetchDashboardSummary();
  }, 5e3);
  var refreshHistory = throttle(() => {
    loadTradeHistoryPage(store.get("historyPage") || 0);
    loadOverviewHistory();
  }, 3e3);
  function setupWebSocketSubscriptions() {
    const sockets = store.sockets;
    sockets.on("tick", (msg) => handleTick(msg));
    sockets.on("history", (msg) => handleHistory(msg));
    sockets.on("levels", (msg) => handleLevels(msg));
    sockets.on("signal", (msg) => handleSignal(msg));
    sockets.on("metrics", (msg) => handleMetrics(msg));
    sockets.on("system_status", (msg) => handleSystemStatus(msg));
    sockets.on("log", (msg) => {
      if (msg.agent && msg.message) {
        logToTerminal(msg.agent, msg.message, msg.time);
        updateAgentStatusUI(msg.agent, msg.message);
      }
    });
    sockets.on("dashboard_summary", (msg) => {
      if (msg.data) renderDashboardSummary(msg.data);
    });
    const onWallet = (msg) => {
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
    for (const evt of ["positions", "positions_updated", "trade_opened", "trade_closed"]) {
      sockets.on(evt, () => refreshPortfolio());
    }
    for (const evt of ["trade_updated", "position_updated"]) {
      sockets.on(evt, () => refreshLivePnl());
    }
    sockets.on("history_trades", () => refreshHistory());
    sockets.on("bot_event", (msg) => handleBotEvent(msg));
    sockets.on("bot_session_updated", (msg) => handleBotSessionUpdate(msg.data));
    sockets.on("auth_error", () => {
      void handleUnauthorized();
    });
  }
  function initApp() {
    initLandingShowcase();
    initModalKeyboardListeners();
    initTerminalListeners();
    initTerminalAgentListeners();
    initAutoBotListeners();
    initReportsListeners();
    setupWebSocketSubscriptions();
    getElement("login-form")?.addEventListener("submit", handleLogin);
    getElement("signup-form")?.addEventListener("submit", handleSignup);
    getElement("logout-btn")?.addEventListener("click", logout);
    window.addEventListener(UNAUTHORIZED_EVENT, () => {
      void handleUnauthorized();
    });
    window.addEventListener(SOCKET_FAILED_EVENT, () => {
      if (document.body.classList.contains("in-dashboard")) authService.me().catch(() => {
      });
    });
    if (!document.body.classList.contains("in-dashboard") && !window.location.hash.includes("dashboard")) {
      if (typeof w.start3D === "function") w.start3D();
      else threeController.start();
    }
    initClerkAuth();
    if (window.location.hash.includes("dashboard")) {
      void restoreSession();
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})();
//# sourceMappingURL=app.bundle.js.map
