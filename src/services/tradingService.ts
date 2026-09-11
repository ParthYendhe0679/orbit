/**
 * ORBIT Trading Terminal — Trading Service
 * Open positions, pending orders, trade history and position closes.
 *
 * user_id is optional everywhere: the gateway scopes every request to the
 * signed-in account and refuses a user_id that names anyone else.
 */

import { apiClient } from "./apiClient";
import { Position, PendingOrder, TradeHistoryResponse, TradeHistoryQuery } from "../types/trading";

type UserId = number | string | null | undefined;

function withUser(path: string, userId: UserId, params: URLSearchParams = new URLSearchParams()): string {
    if (userId !== null && userId !== undefined && userId !== "") params.set("user_id", String(userId));
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
}

export interface CloseResult {
    ok: boolean;
    realized_pnl?: number;
    [key: string]: unknown;
}

export const tradingService = {
    async getOpenPositions(userId?: UserId): Promise<Position[]> {
        const res = await apiClient.get<{ positions?: Position[]; trades?: Position[] }>(withUser("/api/trades/open", userId));
        return res.positions || res.trades || [];
    },

    async getPendingOrders(userId?: UserId): Promise<PendingOrder[]> {
        const res = await apiClient.get<{ orders?: PendingOrder[] }>(withUser("/api/trades/pending", userId));
        return res.orders || [];
    },

    async getTradeHistory(query: TradeHistoryQuery = {}): Promise<TradeHistoryResponse> {
        const params = new URLSearchParams();
        const limit = query.limit ?? 20;
        const offset = query.offset ?? 0;
        params.set("limit", String(limit));
        params.set("offset", String(offset));
        for (const key of ["symbol", "market", "side", "outcome", "source"] as const) {
            const value = query[key];
            if (value) params.set(key, value);
        }
        const res = await apiClient.get<{ trades?: TradeHistoryResponse["trades"]; total?: number }>(
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

    closePositionPartial(tradeId: number, quantity: number, userId?: UserId): Promise<CloseResult> {
        const body: Record<string, unknown> = { quantity };
        if (userId !== null && userId !== undefined && userId !== "") body.user_id = Number(userId);
        return apiClient.post<CloseResult>(`/api/trades/${tradeId}/close`, body);
    },

    closePositionFull(tradeId: number, userId?: UserId): Promise<CloseResult> {
        return apiClient.post<CloseResult>(withUser(`/api/trades/${tradeId}/close/full`, userId), {});
    }
};
