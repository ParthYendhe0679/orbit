/**
 * ORBIT Trading Terminal — Market Data & Indicator Types
 * Matches backend/models/market.py and market service endpoints
 */

export interface MarketQuote {
    symbol: string;
    price: number;
    change_24h: number;
    change_percent: number;
    high_24h: number;
    low_24h: number;
    volume_24h: number;
    timestamp: string;
}

export interface OHLCV {
    time: number | string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface MarketDataStats {
    symbol: string;
    current_price: number;
    sma_20?: number;
    ema_50?: number;
    ema_200?: number;
    rsi_14?: number;
    atr_14?: number;
    volatility_pct?: number;
    trend_bias?: "BULLISH" | "BEARISH" | "NEUTRAL";
}

export interface MarketHistoryResponse {
    symbol: string;
    timeframe: string;
    count: number;
    candles: OHLCV[];
}

export interface NewsArticle {
    title: string;
    description?: string;
    source: string;
    url: string;
    published_at: string;
    sentiment: "bullish" | "bearish" | "neutral";
    sentiment_score?: number;
    symbols?: string[];
}

export interface SupportResistanceLevels {
    supports: number[];
    resistances: number[];
    liquidity: number[];
}
