/**
 * ORBIT Trading Terminal — Auto-Trade Bot Service
 * Manages autonomous bot settings, asset lists, capital limits, and status
 */

import { apiClient } from "./apiClient";
import { AutoBotConfig } from "../types/autobot";

export const autoBotService = {
    async getConfig(userId: number | string): Promise<AutoBotConfig> {
        return apiClient.get<AutoBotConfig>(`/api/bot-config?user_id=${encodeURIComponent(userId)}`);
    },

    async saveConfig(config: AutoBotConfig): Promise<{ ok: boolean; message?: string }> {
        // Enforce sanitized numeric values
        const payload: AutoBotConfig = {
            ...config,
            allocated_capital: Math.max(0, Number(config.allocated_capital) || 0),
            target_profit: Math.max(0, Number(config.target_profit) || 0),
            max_loss: Math.max(0, Number(config.max_loss) || 0),
            leverage: Math.max(1, Number(config.leverage) || 1)
        };
        return apiClient.post<{ ok: boolean; message?: string }>("/api/bot-config", payload);
    }
};
