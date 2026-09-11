/**
 * ORBIT Trading Terminal — Core Trading Domain Types
 * Exactly matches backend schema in backend/database.py and FastAPI trade endpoints
 */

export type TradeSide = "buy" | "sell" | "BUY" | "SELL";
export type TradeStatus = "pending" | "active" | "closed";
export type TradeOutcome = "target" | "sl" | "stopped" | "cancelled" | "manual_close" | "profit" | "loss" | "closed";

export interface Position {
    id: number;
    user_id: number;
    asset: string;
    symbol?: string;
    type: TradeSide;
    side?: TradeSide;
    quantity: number;
    original_quantity?: number;
    remaining_quantity?: number;
    entry_price: number;
    current_price: number;
    exit_price?: number | null;
    sl: number;
    target: number;
    pnl: number;
    realized_pnl?: number;
    unrealized_pnl?: number;
    leverage: number;
    margin_used?: number;
    market?: string;
    status: TradeStatus;
    outcome?: TradeOutcome | null;
    source?: string;
    bot_session_id?: number | string | null;
    timestamp: string;
    opened_at?: string | null;
    closed_at?: string | null;
}

export interface PendingOrder {
    id: number;
    user_id: number;
    asset: string;
    type: TradeSide;
    quantity: number;
    entry_price: number;
    sl: number;
    target: number;
    leverage: number;
    status: "pending";
    timestamp: string;
}

export interface ClosedTrade extends Position {
    status: "closed";
    exit_price: number;
    closed_at: string;
    outcome: TradeOutcome;
}

export interface PartialCloseRequest {
    user_id: number;
    percentage: number; // 25, 50, 75, 100
    reason?: string;
}

export interface PartialCloseResponse {
    success: boolean;
    trade_id: number;
    closed_quantity: number;
    remaining_quantity: number;
    exit_price: number;
    realized_pnl: number;
    margin_released: number;
    message?: string;
}

export interface FullCloseResponse {
    success: boolean;
    trade_id: number;
    closed_quantity: number;
    exit_price: number;
    realized_pnl: number;
    margin_released: number;
    outcome: string;
    message?: string;
}

export interface OpenTradeSignalPayload {
    asset: string;
    action: TradeSide;
    price: number;
    sl: number;
    target: number;
    leverage?: number;
    margin?: number;
    agent?: string;
    confidence?: number;
    timeframe?: string;
}

export interface TradeHistoryQuery {
    user_id?: number | string;
    asset?: string;
    symbol?: string;
    market?: string;
    side?: string;
    outcome?: string;
    limit?: number;
    offset?: number;
}

export interface TradeHistoryResponse {
    trades: ClosedTrade[];
    total: number;
    page: number;
    limit: number;
}
