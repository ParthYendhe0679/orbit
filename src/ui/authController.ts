/**
 * ORBIT Trading Terminal — Authentication Controller
 * Handles Clerk Headless OAuth, local DB credentials fallback, and session lifecycle
 */

import { authService } from "../services/authService";
import { setAuthTokenProvider } from "../services/apiClient";
import { SessionIdentity } from "../types/auth";
import { store } from "../state/store";
import { safeText, getElement } from "../utils/dom";

let clerkInstance: any = null;
let isClerkActive = false;
let clerkInitPromise: Promise<any> | null = null;
let _clerkSyncInFlight: Promise<boolean> | null = null;

// URL of this single-page app with an optional hash (#dashboard, #sso-callback).
export function clerkAppUrl(hash?: string): string {
    return window.location.origin + window.location.pathname + (hash || "");
}

export function showAuthError(message: string): void {
    const el = document.getElementById("login-error") || document.getElementById("signup-error");
    if (el) {
        el.textContent = message;
        el.classList.remove("hidden");
    }
    const loginSection = document.getElementById("login-section");
    if (loginSection) loginSection.scrollIntoView({ behavior: "smooth" });
}

// True when Clerk's client holds a sign-in/sign-up attempt this page can finish.
export function clerkHasOAuthAttempt(client: any): boolean {
    const signIn = client && client.signIn;
    const signUp = client && client.signUp;
    const ffv = signIn && signIn.firstFactorVerification;
    const ext = signUp && signUp.verifications && signUp.verifications.externalAccount;
    return !!((signIn && signIn.status) || (ffv && ffv.status) || (signUp && signUp.status) || (ext && ext.status));
}

// Clerk's own view of an unfinished Google attempt, for the error message and console.
export function clerkOAuthDiagnosis(client: any): string {
    const parts: string[] = [];
    const describe = (label: string, status: any, err: any) => {
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

// Same-origin navigations requested by Clerk stay inside this page
export function clerkRouterNavigate(to: string): void {
    const url = new URL(to, window.location.href);
    if (url.origin !== window.location.origin) {
        window.location.href = url.href;
        return;
    }
    history.replaceState(null, "", url.pathname + url.search + url.hash);
}

/**
 * Initializes Clerk Headless JS SDK with publishable key and OAuth callback handlers.
 */
export async function initClerkAuth(maxWaitMs = 1500): Promise<any> {
    if (clerkInstance && isClerkActive) return clerkInstance;
    if (clerkInitPromise) {
        const res = await clerkInitPromise;
        if (res && clerkInstance) return clerkInstance;
    }

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

            // Wait for Clerk SDK to be defined in global scope
            const maxAttempts = Math.max(15, Math.floor(maxWaitMs / 100));
            let attempts = 0;
            while (!window.Clerk && attempts < maxAttempts) {
                await new Promise((r) => setTimeout(r, 100));
                attempts++;
            }

            if (window.Clerk) {
                const loadOptions = {
                    publishableKey: pubKey,
                    routerPush: clerkRouterNavigate,
                    routerReplace: clerkRouterNavigate,
                };
                if (typeof window.Clerk === "function") {
                    clerkInstance = new (window.Clerk as any)(pubKey);
                } else {
                    clerkInstance = window.Clerk;
                }
                if (clerkInstance && typeof clerkInstance.load === "function") {
                    await Promise.race([
                        clerkInstance.load(loadOptions),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Clerk load timed out")), 3500))
                    ]).catch((loadErr) => {
                        console.warn("[Orbit Auth] Clerk load warning:", loadErr);
                    });
                }
                isClerkActive = true;
                console.log("[Orbit Auth] Clerk Headless SDK loaded with custom UI.");
                // API calls carry the Clerk session token; the gateway verifies it (JWKS).
                setAuthTokenProvider(async () =>
                    clerkInstance && clerkInstance.session ? clerkInstance.session.getToken() : null
                );

                const oauthStartedAt = Number(sessionStorage.getItem("orbit_oauth_in_progress") || 0);
                const oauthFresh = oauthStartedAt > 1 && Date.now() - oauthStartedAt < 15 * 60 * 1000;
                const isCallbackHash = window.location.hash.includes("sso-callback") || window.location.search.includes("__clerk_");
                const returningFromOAuth = (oauthFresh || isCallbackHash)
                    && (clerkHasOAuthAttempt(clerkInstance.client) || isCallbackHash);
                if (!returningFromOAuth && !isCallbackHash) {
                    sessionStorage.removeItem("orbit_oauth_in_progress");
                    if (window.location.hash.includes("sso-")) {
                        history.replaceState(null, "", window.location.pathname + window.location.search);
                    }
                }

                // Enter as soon as a session becomes active.
                if (typeof clerkInstance.addListener === "function") {
                    clerkInstance.addListener(async (state: any) => {
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
                    let unsupportedStep: string | null = null;
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
                            resetPasswordUrl: clerkAppUrl("#sso-reset-password"),
                        }, (to: string) => {
                            const url = new URL(to, window.location.href);
                            if (url.origin === window.location.origin && url.hash !== "#dashboard") {
                                unsupportedStep = url.hash.replace("#", "");
                            }
                            clerkRouterNavigate(to);
                        });
                    } catch (cbErr: any) {
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

/**
 * Synchronizes Clerk user profile with PostgreSQL / SQLite backend database and transitions to dashboard.
 * Uses a single-flight guard to prevent duplicate concurrent DB sync calls.
 */
export function syncClerkUserAndEnter(u: any): Promise<boolean> {
    if (!_clerkSyncInFlight) {
        _clerkSyncInFlight = _syncClerkUserAndEnter(u).finally(() => {
            _clerkSyncInFlight = null;
        });
    }
    return _clerkSyncInFlight;
}

async function _syncClerkUserAndEnter(u: any): Promise<boolean> {
    if (!u) return false;

    const userEmail =
        (u.primaryEmailAddress && u.primaryEmailAddress.emailAddress) ||
        (u.emailAddresses && u.emailAddresses[0] && u.emailAddresses[0].emailAddress) ||
        "";

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
        // The gateway takes the Clerk user id from the verified session token.
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

/**
 * Transitions application from 3D landing page into trading dashboard.
 */
export function enterDashboard(username: string, userId?: string | number | null): void {
    const finalUsername = username || "Trader Account";
    const finalUserId = userId || null;

    store.set("currentUsername", finalUsername);
    store.set("currentUserId", finalUserId);

    safeText(getElement("dashboard-user"), finalUsername);
    window.location.hash = "#dashboard";

    // Update body class and stop 3D WebGL candlestick background (only runs on landing and login/signup)
    document.body.classList.add("in-dashboard");
    if (window.aether3D && typeof window.aether3D.stop === "function") {
        window.aether3D.stop();
    }
    const threeCanvas = getElement("three-canvas");
    if (threeCanvas) {
        threeCanvas.style.display = "none";
    }

    // Hide landing wrapper & show dashboard
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

    // Scroll window back to top
    window.scrollTo(0, 0);

    // Initialize connection and UI state
    setTimeout(() => {
        store.sockets.connect();
        if (typeof (window as any).switchToTab === "function") {
            (window as any).switchToTab("dashboard");
        }
        if (typeof (window as any).fetchGlobalNews === "function") {
            (window as any).fetchGlobalNews();
        }
        if (typeof (window as any).refreshAllData === "function") {
            (window as any).refreshAllData();
        }
    }, 50);
}

/**
 * Opens the live terminal for an existing session; otherwise asks the visitor
 * to sign in (there is no shared demo account).
 */
export async function launchDemoDirect(): Promise<void> {
    if (await restoreSession()) return;
    scrollToLogin();
    showAuthError("Sign in or create an account to open the live trading terminal.");
}

/**
 * Restores the dashboard from the session the gateway verifies (HttpOnly
 * cookie or Clerk token) — never from a user id kept in the browser.
 */
export async function restoreSession(): Promise<SessionIdentity | null> {
    try {
        const me = await authService.me();
        if (me && me.ok && me.user_id) {
            enterDashboard(me.username, me.user_id);
            return me;
        }
    } catch {
        // No valid session.
    }
    if (window.location.hash.includes("dashboard")) {
        history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    return null;
}

let _sessionRecovery: Promise<boolean> | null = null;

/**
 * Called when the gateway rejects the session (HTTP 401 / socket auth error).
 * A live Clerk session is exchanged for a fresh gateway session; otherwise
 * the user is signed out.
 */
export async function handleUnauthorized(): Promise<void> {
    if (!document.body.classList.contains("in-dashboard")) return;
    if (!_sessionRecovery) {
        _sessionRecovery = (async () => {
            const user = clerkInstance && clerkInstance.session ? clerkInstance.user : null;
            if (!user) return false;
            try {
                const email = (user.primaryEmailAddress && user.primaryEmailAddress.emailAddress) || "";
                const data = await authService.syncClerkUser({ email, username: user.username || user.fullName || "" });
                return !!(data && data.ok);
            } catch {
                return false;
            }
        })();
        _sessionRecovery.finally(() => {
            window.setTimeout(() => {
                _sessionRecovery = null;
            }, 5000);
        });
    }
    if (await _sessionRecovery) {
        store.sockets.connect();
        return;
    }
    await logout();
    showAuthError("Your session has ended. Please sign in again.");
}

/**
 * Smoothly scrolls landing page down to the login card.
 */
export function scrollToLogin(): void {
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

/**
 * Switches tab between Login and Sign Up.
 */
export function switchAuthTab(tab: "login" | "signup"): void {
    const tabLoginBtn = getElement("tab-login-btn");
    const tabSignupBtn = getElement("tab-signup-btn");
    const panelLogin = getElement("panel-login");
    const panelSignup = getElement("panel-signup");
    const cardTitle = getElement("auth-card-title");
    const cardSubtitle = getElement("auth-card-subtitle");

    // Hide any showing error messages
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

/**
 * Toggles visibility masking of password inputs.
 */
export function togglePw(inputId: string, buttonEl: HTMLElement): void {
    const input = getElement<HTMLInputElement>(inputId);
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

/**
 * Initiates 1-Click Clerk Google OAuth authentication.
 */
export async function handleClerkGoogleAuth(): Promise<void> {
    const btn = getElement("login-google-btn") || getElement("signup-google-btn");
    const originalText = btn ? btn.innerHTML : "";
    if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Connecting with Google...</span>';
        btn.style.pointerEvents = "none";
    }

    let isRedirecting = false;
    let resetTimer = setTimeout(() => {
        if (btn) {
            btn.innerHTML = originalText;
            btn.style.pointerEvents = "auto";
        }
    }, 6000);

    try {
        await initClerkAuth(5000);

        // If user already has an active Clerk session, sync to DB and launch console
        if (clerkInstance && clerkInstance.user && clerkInstance.session) {
            clearTimeout(resetTimer);
            const synced = await syncClerkUserAndEnter(clerkInstance.user);
            if (synced) return;
        }

        // Try Clerk OAuth redirect if available
        if (clerkInstance) {
            sessionStorage.setItem("orbit_oauth_in_progress", String(Date.now()));
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
                isRedirecting = true;
                if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Redirecting to Google...</span>';
                await clerkInstance.authenticateWithRedirect(oauthParams);
                return;
            } else if (
                clerkInstance.client &&
                clerkInstance.client.signIn &&
                typeof clerkInstance.client.signIn.authenticateWithRedirect === "function"
            ) {
                isRedirecting = true;
                if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Redirecting to Google...</span>';
                await clerkInstance.client.signIn.authenticateWithRedirect(oauthParams);
                return;
            }
        }

        // No Clerk SDK means no verified Google identity: never create an account without one.
        throw new Error("Google sign-in is unavailable because the Clerk SDK could not be loaded. Please ensure internet access to Clerk or use username/password login.");
    } catch (err: any) {
        isRedirecting = false;
        clearTimeout(resetTimer);
        console.error("Google auth error:", err);
        sessionStorage.removeItem("orbit_oauth_in_progress");
        const errorEl = getElement("login-error") || getElement("signup-error");
        if (errorEl) {
            errorEl.textContent = "Google login error: " + (err.message || "Failed to connect with Google.");
            errorEl.classList.remove("hidden");
        }
    } finally {
        if (!isRedirecting) {
            clearTimeout(resetTimer);
            if (btn) {
                btn.innerHTML = originalText;
                btn.style.pointerEvents = "auto";
            }
        }
    }
}

/**
 * Handles credentials login submission.
 */
export async function handleLogin(event: Event): Promise<void> {
    event.preventDefault();
    const usernameInput = getElement<HTMLInputElement>("login-username");
    const passwordInput = getElement<HTMLInputElement>("login-password");
    const errorEl = getElement("login-error");
    const submitBtn = getElement<HTMLButtonElement>("login-submit-btn");

    const username = usernameInput ? usernameInput.value.trim() : "";
    const password = passwordInput ? passwordInput.value : "";

    if (errorEl) errorEl.classList.add("hidden");
    if (submitBtn) submitBtn.disabled = true;

    // 1. Direct Local DB Engine first for instantaneous access (<50ms)
    try {
        const data = await authService.login({ username, password });
        if (data && data.ok) {
            enterDashboard(data.username || username, data.user_id || null);
            if (submitBtn) submitBtn.disabled = false;
            return;
        }
    } catch (err: any) {
        console.warn("[Orbit Auth] Local DB login check:", err.message || err);
    }

    // 2. Clerk Headless Custom UI Flow fallback
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

    if (errorEl) {
        errorEl.textContent = "Invalid username or password.";
        errorEl.classList.remove("hidden");
    }
    if (submitBtn) submitBtn.disabled = false;
}

/**
 * Handles registration submission.
 */
export async function handleSignup(event: Event): Promise<void> {
    event.preventDefault();
    const emailInput = getElement<HTMLInputElement>("signup-email");
    const usernameInput = getElement<HTMLInputElement>("signup-username");
    const passwordInput = getElement<HTMLInputElement>("signup-password");
    const confirmInput = getElement<HTMLInputElement>("signup-confirm");
    const errorEl = getElement("signup-error");
    const submitBtn = getElement<HTMLButtonElement>("signup-submit-btn");

    const email = emailInput ? emailInput.value.trim() : "";
    const username = usernameInput ? usernameInput.value.trim() : "";
    const password = passwordInput ? passwordInput.value : "";
    const confirm = confirmInput ? confirmInput.value : "";

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
        const data = await authService.register({ username, email, password });

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

        enterDashboard(data.username || username, data.user_id || null);
    } catch (err: any) {
        console.error("Signup error:", err);
        if (errorEl) {
            errorEl.textContent = err.message || "Registration failed.";
            errorEl.classList.remove("hidden");
        }
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

/**
 * Logs out user and returns to 3D landing page.
 */
export async function logout(): Promise<void> {
    // End the gateway session (HttpOnly cookie) and the live sockets first.
    await authService.logout();
    store.sockets.disconnect();
    store.set("currentUserId", null);
    store.set("dashboardSummary", null);
    store.set("walletBalance", null);
    // Legacy keys from builds that trusted a user id kept in the browser.
    localStorage.removeItem("orbit_logged_in_username");
    localStorage.removeItem("orbit_user_id");
    localStorage.removeItem("orbit_username");

    if (isClerkActive && clerkInstance) {
        try {
            await clerkInstance.signOut();
        } catch (e) {}
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
