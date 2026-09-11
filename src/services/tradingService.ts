/**
 * ORBIT Trading Terminal — Trading Service
 * Manages open positions, pending orders, trade execution, and closure lifecycle
 */

import { apiClient } from "./apiClient";
import {
    Position,
    PendingOrder,
    PartialCloseRequest,
    PartialCloseResponse,
    FullCloseResponse,
    TradeHistoryResponse,
    TradeHistoryQuery
} from "../types/trading";

export const tradingService = {
    async getOpenPositions(userId: number | string): Promise<Position[]> {
        const res = await apiClient.get<{ positions?: Position[]; trades?: Position[] } | Position[]>(
            `/api/trades/open?user_id=${encodeURIComponent(userId)}`
        );
        if (Array.isArray(res)) return res;
        return res.positions || res.trades || [];
    },

    async getPendingOrders(userId: number | string): Promise<PendingOrder[]> {
        const res = await apiClient.get<{ orders?: PendingOrder[]; pending?: PendingOrder[] } | PendingOrder[]>(
            `/api/trades/pending?user_id=${encodeURIComponent(userId)}`
        );
        if (Array.isArray(res)) return res;
        return res.orders || res.pending || [];
    },

    async getTradeHistory(query: TradeHistoryQuery = {}): Promise<TradeHistoryResponse> {
        const params = new URLSearchParams();
        if (query.user_id !== undefined) params.set("user_id", String(query.user_id));
        if (query.asset) params.set("asset", query.asset);
        if (query.limit !== undefined) params.set("limit", String(query.limit));
        if (query.offset !== undefined) params.set("offset", String(query.offset));

        const res = await apiClient.get<TradeHistoryResponse | { trades?: Position[]; total?: number }>(
            `/api/trades/history?${params.toString()}`
        );

        if ("trades" in res && Array.isArray(res.trades)) {
            return {
                trades: res.trades as unknown as TradeHistoryResponse["trades"],
                total: res.total || res.trades.length,
                page: Math.floor((query.offset || 0) / (query.limit || 10)),
                limit: query.limit || 10
            };
        }
        return { trades: [], total: 0, page: 0, limit: 10 };
    },

    async partialCloseTrade(tradeId: number, req: PartialCloseRequest): Promise<PartialCloseResponse> {
        return apiClient.post<PartialCloseResponse>(`/api/trades/${tradeId}/partial-close`, req);
    },

    async closePositionPartial(tradeId: number, quantity: number, userId?: number | string): Promise<{ ok: boolean; realized_pnl: number }> {
        return apiClient.post<{ ok: boolean; realized_pnl: number }>(`/api/trades/${tradeId}/close`, {
            quantity,
            user_id: userId ? Number(userId) : undefined
        });
    },

    async fullCloseTrade(tradeId: number, userId: number | string): Promise<FullCloseResponse> {
        return apiClient.post<FullCloseResponse>(`/api/trades/${tradeId}/close/full?user_id=${encodeURIComponent(userId)}`);
    },

    async closePositionFull(tradeId: number, userId?: number | string): Promise<{ ok: boolean; realized_pnl: number }> {
        const query = userId ? `?user_id=${encodeURIComponent(userId)}` : "";
        return apiClient.post<{ ok: boolean; realized_pnl: number }>(`/api/trades/${tradeId}/close/full${query}`, {});
    },

    async cancelOrder(orderId: number, userId: number | string): Promise<{ ok: boolean; message?: string }> {
        return apiClient.post<{ ok: boolean; message?: string }>(`/api/orders/${orderId}/cancel`, {
            user_id: userId,
            order_id: orderId
        });
    }
};
