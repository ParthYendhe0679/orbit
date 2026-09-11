/**
 * ORBIT Trading Terminal — Authentication Service
 * Clerk account provisioning, password sign-in, and the gateway session.
 */

import { apiClient } from "./apiClient";
import {
    SyncAuthRequest,
    SyncAuthResponse,
    ClerkAuthConfig,
    LoginCredentials,
    RegisterCredentials,
    SessionIdentity
} from "../types/auth";

export const authService = {
    /** Provisions/links the ORBIT account for the verified Clerk user; the gateway then issues its session cookie. */
    async syncClerkUser(req: SyncAuthRequest): Promise<SyncAuthResponse> {
        return apiClient.post<SyncAuthResponse>("/api/auth/sync", req);
    },

    async getClerkConfig(): Promise<ClerkAuthConfig> {
        return apiClient.get<ClerkAuthConfig>("/api/auth/config");
    },

    async login(credentials: LoginCredentials): Promise<{ ok: boolean; user_id?: number; username?: string; detail?: string }> {
        return apiClient.post<{ ok: boolean; user_id?: number; username?: string; detail?: string }>("/api/login", credentials);
    },

    async register(credentials: RegisterCredentials): Promise<{ ok: boolean; user_id?: number; username?: string; clerk_token?: string | null; detail?: string }> {
        return apiClient.post<{ ok: boolean; user_id?: number; username?: string; clerk_token?: string | null; detail?: string }>("/api/register", credentials);
    },

    /** The account the gateway verified for this browser, or an ApiError(401). */
    async me(): Promise<SessionIdentity> {
        return apiClient.get<SessionIdentity>("/api/auth/me");
    },

    /** Ends the gateway session (clears the HttpOnly cookie). */
    async logout(): Promise<void> {
        try {
            await apiClient.post<{ ok: boolean }>("/api/auth/logout");
        } catch {
            // Already signed out or offline: nothing to clear server-side.
        }
    }
};
