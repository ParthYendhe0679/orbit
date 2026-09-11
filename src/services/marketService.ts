/**
 * ORBIT Trading Terminal — Market Data Service
 * Real quotes, OHLCV history, symbol search and news from the ai-service
 * (public endpoints behind the Go gateway).
 */

import { apiClient, authFetch, unwrapData } from "./apiClient";
import { MarketQuote, MarketHistorySnapshot, NewsHeadline, NewsResponse, SymbolSearchResult } from "../types/market";

async function getNews(url: string, signal?: AbortSignal): Promise<NewsHeadline[]> {
    const res = await authFetch(url, { signal });
    if (!res.ok) throw new Error(`News request failed with status ${res.status}`);
    const data = (await res.json()) as Partial<NewsResponse>;
    return Array.isArray(data.headlines) ? data.headlines : [];
}

export const marketService = {
    getQuote(symbol: string): Promise<MarketQuote> {
        return apiClient.get<MarketQuote>(`/api/market/quote?symbol=${encodeURIComponent(symbol)}`);
    },

    async getHistory(symbol: string, period: string = "60d", interval: string = "1d"): Promise<MarketHistorySnapshot> {
        return unwrapData(
            await apiClient.get<{ ok: boolean; data: MarketHistorySnapshot }>(
                `/api/market/history?symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}&interval=${encodeURIComponent(interval)}`
            )
        );
    },

    async searchSymbols(query: string, market?: string): Promise<SymbolSearchResult[]> {
        const params = new URLSearchParams({ q: query });
        if (market) params.set("market", market);
        const res = await apiClient.get<{ ok: boolean; results?: SymbolSearchResult[] }>(`/api/market/search?${params.toString()}`);
        return Array.isArray(res.results) ? res.results : [];
    },

    getGlobalNews(signal?: AbortSignal): Promise<NewsHeadline[]> {
        return getNews("/api/news/global", signal);
    },

    getSymbolNews(symbol: string, signal?: AbortSignal): Promise<NewsHeadline[]> {
        return getNews(`/api/news?symbol=${encodeURIComponent(symbol)}`, signal);
    }
};
