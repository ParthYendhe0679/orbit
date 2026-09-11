/**
 * ORBIT Trading Terminal — Ambient Declarations for CDN Globals
 * Provides strict typings for Three.js, TradingView, and Clerk headless SDK
 */

export interface ClerkUser {
    id: string;
    fullName?: string | null;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    primaryEmailAddress?: { emailAddress: string } | null;
    emailAddresses?: Array<{ emailAddress: string }>;
}

export interface ClerkSession {
    id: string;
    status: string;
}

export interface ClerkClient {
    signIn: {
        create: (params: Record<string, unknown>) => Promise<{
            status: string;
            createdSessionId: string;
        }>;
        authenticateWithRedirect: (params: Record<string, unknown>) => Promise<void>;
    };
    signUp: {
        create: (params: Record<string, unknown>) => Promise<{
            status: string;
            createdSessionId: string;
        }>;
        authenticateWithRedirect: (params: Record<string, unknown>) => Promise<void>;
    };
}

export interface ClerkInstance {
    loaded: boolean;
    user: ClerkUser | null;
    session: ClerkSession | null;
    client: ClerkClient;
    load: (options?: { publishableKey?: string }) => Promise<void>;
    setActive: (params: { session: string | null }) => Promise<void>;
    signOut: () => Promise<void>;
    authenticateWithRedirect: (params: Record<string, unknown>) => Promise<void>;
    handleRedirectCallback: () => Promise<void>;
    addListener: (callback: (state: { user: ClerkUser | null; session: ClerkSession | null }) => void) => () => void;
    openSignIn?: (options?: Record<string, unknown>) => void;
    openSignUp?: (options?: Record<string, unknown>) => void;
}

export interface Aether3DScene {
    initAndStart3D: () => void;
    start: () => void;
    stop: () => void;
    resize: () => void;
}

declare global {
    interface Window {
        Clerk?: ClerkInstance | (new (pubKey: string) => ClerkInstance);
        TradingView?: {
            widget: new (options: Record<string, unknown>) => unknown;
        };
        THREE?: unknown;
        aether3D?: Aether3DScene;
        lastSupports?: number[];
        lastResistances?: number[];
        lastLiquidity?: number[];
        _lastSignalEntry?: number | null;
        _lastSignalSL?: number | null;
        _lastSignalTarget?: number | null;
        handleClerkGoogleAuth?: () => Promise<void>;
        syncClerkUserAndEnter?: (u: unknown) => Promise<boolean>;
        enterDashboard?: (username: string, userId: number | string) => void;
        launchDemoDirect?: () => void;
        switchAuthTab?: (tab: string) => void;
        togglePw?: (id: string, btn?: HTMLElement) => void;
        executeModalTrade?: () => void;
        closeTradeConfirmModal?: () => void;
        closeRiskGuardModal?: () => void;
    }
}

export {};
