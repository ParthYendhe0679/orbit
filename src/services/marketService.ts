/**
 * ORBIT Trading Terminal — Market Data Service
 * Interfaces with Alpha Vantage quotes, historical OHLCV candles, and cached financial news
 */

import { apiClient } from "./apiClient";
import { MarketQuote, MarketHistoryResponse, NewsArticle } from "../types/market";

export const marketService = {
    async getQuote(symbol: string): Promise<MarketQuote> {
        return apiClient.get<MarketQuote>(`/api/market/quote?symbol=${encodeURIComponent(symbol)}`);
    },

    async getHistory(symbol: string, timeframe: string = "1d"): Promise<MarketHistoryResponse> {
        return apiClient.get<MarketHistoryResponse>(
            `/api/market/history?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
        );
    },

    async getGlobalNews(signal?: AbortSignal): Promise<NewsArticle[]> {
        const res = await fetch("/api/news/global", { signal });
        if (!res.ok) throw new Error(`Global news failed with status ${res.status}`);
        const data = await res.json();
        return Array.isArray(data) ? data : data.news || data.articles || [];
    },

    async getSymbolNews(symbol: string, signal?: AbortSignal): Promise<NewsArticle[]> {
        const res = await fetch(`/api/news?symbol=${encodeURIComponent(symbol)}`, { signal });
        if (!res.ok) throw new Error(`Symbol news failed with status ${res.status}`);
        const data = await res.json();
        return Array.isArray(data) ? data : data.news || data.articles || [];
    }
};
