/**
 * ORBIT Trading Terminal — Real-Time WebSocket Message Contracts
 * Handles bidirectional frames from Python FastAPI (:8000/ws) and Go Stream Hub (:8001/ws)
 */

import { Position, ClosedTrade } from "./trading";
import { DashboardSummary } from "./portfolio";
import { OHLCV } from "./market";

export type WebSocketEventType =
    | "tick"
    | "price_update"
    | "trade_opened"
    | "trade_updated"
    | "trade_closed"
    | "levels"
    | "signal"
    | "log"
    | "metrics"
    | "dashboard_summary"
    | "wallet_updated"
    | "wallet"
    | "positions_updated"
    | "position_updated"
    | "positions"
    | "history_trades"
    | "bot_status"
    | "autotrade_status"
    | "bot_event"
    | "bot_session_updated"
    | "auth_error";

export interface WSTickMessage {
    type: "tick" | "price_update";
    candle?: OHLCV;
    changePercent?: number;
    data?: {
        price?: number;
        change_percent?: number;
    };
}

export interface WSTradeLifecycleMessage {
    type: "trade_opened" | "trade_updated" | "trade_closed";
    trade?: Position;
    data?: unknown;
}

export interface WSLevelsMessage {
    type: "levels";
    supports: number[];
    resistances: number[];
    liquidity: number[];
}

export interface WSSignalMessage {
    type: "signal";
    asset?: string;
    action?: string;
    entry: number;
    sl: number;
    target: number;
    leverage?: number;
    margin?: number;
    confidence?: number;
    timeframe?: string;
    agent?: string;
}

export interface WSLogMessage {
    type: "log";
    agent: string;
    message: string;
    time: string;
}

export interface WSMetricsMessage {
    type: "metrics";
    consensus?: {
        signal: string;
        votes_buy: number;
        total_signals?: number;
    };
    sentiment?: number;
    trend?: {
        strength?: string;
        direction?: string;
    };
}

export interface WSDashboardSummaryMessage {
    type: "dashboard_summary";
    data: DashboardSummary;
}

export interface WSWalletMessage {
    type: "wallet_updated" | "wallet";
    balance?: number;
    data?: {
        balance?: number;
    };
}

export interface WSPositionsMessage {
    type: "positions_updated" | "position_updated" | "positions";
    positions: Position[];
}

export interface WSHistoryTradesMessage {
    type: "history_trades";
    trades: ClosedTrade[];
}

export interface WSBotStatusMessage {
    type: "bot_status" | "autotrade_status";
    status: string;
    details?: string;
}

export interface WSAuthErrorMessage {
    type: "auth_error";
    message: string;
}

export type WebSocketInboundMessage =
    | WSTickMessage
    | WSTradeLifecycleMessage
    | WSLevelsMessage
    | WSSignalMessage
    | WSLogMessage
    | WSMetricsMessage
    | WSDashboardSummaryMessage
    | WSWalletMessage
    | WSPositionsMessage
    | WSHistoryTradesMessage
    | WSBotStatusMessage
    | WSAuthErrorMessage;

export interface WebSocketOutboundAction {
    action: "start" | "stop" | "analyze" | "ping" | "cancel_trade" | "confirm_trade" | "reject_trade";
    symbol?: string;
    timeframe?: string;
    trade_id?: number;
    [key: string]: any;
}
