/**
 * ORBIT Trading Terminal — Authentication Types
 * Matches Clerk headless handshake and /api/auth/* endpoints
 */

export interface SyncAuthRequest {
    email: string;
    username: string;
    clerk_id: string;
    first_name?: string;
    last_name?: string;
}

export interface SyncAuthResponse {
    ok: boolean;
    user_id: number;
    username: string;
    balance: number;
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

export interface AuthSession {
    userId: number;
    username: string;
    email?: string;
    clerkId?: string;
    isAuthenticated: boolean;
}
