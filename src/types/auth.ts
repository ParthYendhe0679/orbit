/**
 * ORBIT Trading Terminal — Authentication Types
 * Matches the Go gateway (/api/auth/me, /api/auth/logout) and the ai-service
 * account endpoints it forwards (/api/auth/sync, /api/login, /api/register).
 */

/**
 * Body of POST /api/auth/sync. The Clerk user id is taken from the verified
 * Clerk session token by the gateway, never from this body; the username is
 * only a display name for a newly created account.
 */
export interface SyncAuthRequest {
    username?: string;
    email?: string;
    first_name?: string;
    last_name?: string;
}

export interface SyncAuthResponse {
    ok: boolean;
    user_id: number;
    username: string;
    balance: number | null;
}

export interface ClerkAuthConfig {
    clerk_publishable_key: string;
    is_clerk_configured: boolean;
}

export interface LoginCredentials {
    username: string;
    password: string;
}

export interface RegisterCredentials {
    username: string;
    email: string;
    password: string;
}

/** GET /api/auth/me — the account the gateway verified for this browser. */
export interface SessionIdentity {
    ok: boolean;
    user_id: number;
    username: string;
    method: "session" | "clerk";
}

export interface AuthSession {
    userId: number;
    username: string;
    email?: string;
    clerkId?: string;
    isAuthenticated: boolean;
}
