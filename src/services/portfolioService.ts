/**
 * ORBIT Trading Terminal — Portfolio Service
 * Retrieves real-time capital balance, margin utilization, and performance reports
 */

import { apiClient } from "./apiClient";
import { DashboardSummary, PortfolioReport } from "../types/portfolio";

export const portfolioService = {
    async getDashboardSummary(userId: number | string): Promise<DashboardSummary> {
        return apiClient.get<DashboardSummary>(`/api/dashboard/summary?user_id=${encodeURIComponent(userId)}`);
    },

    async getReport(userId: number | string): Promise<PortfolioReport> {
        return apiClient.get<PortfolioReport>(`/api/report?user_id=${encodeURIComponent(userId)}`);
    }
};
