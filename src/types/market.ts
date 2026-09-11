/**
 * ORBIT Trading Terminal — Market Data Types
 * Matches ai-service models/market.py and the /api/market/* and /api/news* endpoints.
 */

export interface MarketQuote {
    symbol: string;
    price: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    previous_close?: number;
    change?: number;
    change_percent: number;
    volume?: number;
    timestamp: string;
    source?: string;
    is_stale?: boolean;
}

export interface OHLCV {
    time: number | string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

/** data of GET /api/market/history */
export interface MarketHistorySnapshot {
    symbol: string;
    count: number;
    candles: OHLCV[];
    quote?: MarketQuote;
    data_age_seconds?: number;
}

/** One headline of GET /api/news and /api/news/global. */
export interface NewsHeadline {
    title: string;
    link: string;
    source: string;
    published: string;
    sentiment: "bullish" | "bearish" | "neutral";
}

export interface NewsResponse {
    headlines: NewsHeadline[];
    count: number;
    symbol: string;
}

export interface SymbolSearchResult {
    symbol: string;
    name: string;
    exchange?: string;
    type?: string;
}

export interface SupportResistanceLevels {
    supports: number[];
    resistances: number[];
    liquidity: number[];
}
