/**
 * ORBIT Trading Terminal — Authentication Service
 * Manages database profile sync with Clerk and fallback local credentials
 */

import { apiClient } from "./apiClient";
import {
    SyncAuthRequest,
    SyncAuthResponse,
    ClerkAuthConfig,
    LoginCredentials,
    RegisterCredentials
} from "../types/auth";

export const authService = {
    async syncClerkUser(req: SyncAuthRequest): Promise<SyncAuthResponse> {
        return apiClient.post<SyncAuthResponse>("/api/auth/sync", req);
    },

    async getClerkConfig(): Promise<ClerkAuthConfig> {
        return apiClient.get<ClerkAuthConfig>("/api/auth/config");
    },

    async login(credentials: LoginCredentials): Promise<{ ok: boolean; user_id?: number; username?: string; detail?: string }> {
        return apiClient.post<{ ok: boolean; user_id?: number; username?: string; detail?: string }>("/api/login", credentials);
    },

    async register(credentials: RegisterCredentials): Promise<{ ok: boolean; user_id?: number; username?: string; clerk_token?: string; detail?: string }> {
        return apiClient.post<{ ok: boolean; user_id?: number; username?: string; clerk_token?: string; detail?: string }>("/api/register", credentials);
    }
};
