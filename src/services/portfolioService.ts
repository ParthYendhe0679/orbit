/**
 * ORBIT Trading Terminal — Portfolio Service
 * Authoritative account state (dashboard summary) and the performance report.
 */

import { apiClient } from "./apiClient";
import { DashboardSummaryResponse, PortfolioReport, ReportResponse } from "../types/portfolio";

function userQuery(userId?: number | string | null): string {
    return userId !== null && userId !== undefined && userId !== "" ? `?user_id=${encodeURIComponent(userId)}` : "";
}

export const portfolioService = {
    getDashboardSummary(userId?: number | string | null): Promise<DashboardSummaryResponse> {
        return apiClient.get<DashboardSummaryResponse>(`/api/dashboard/summary${userQuery(userId)}`);
    },

    async getReport(userId?: number | string | null): Promise<PortfolioReport> {
        const res = await apiClient.get<ReportResponse>(`/api/report${userQuery(userId)}`);
        return res.report;
    }
};
