/**
 * ORBIT Trading Terminal — Portfolio & Performance Types
 * Matches /api/dashboard/summary and /api/report endpoints
 */

import { Position, ClosedTrade } from "./trading";

export interface DashboardSummary {
    user_id: number;
    username: string;
    balance: number;
    equity: number;
    used_margin: number;
    available_margin: number;
    active_trades_count: number;
    total_unrealized_pnl: number;
    total_realized_pnl: number;
    unrealized_pnl?: number;
    realized_pnl?: number;
    win_rate: number | null; // null when 0 closed trades exist
    trades: Position[];
}

export interface PortfolioReport {
    user_id: number;
    total_trades: number;
    winning_trades: number;
    losing_trades: number;
    win_rate: number | null;
    total_realized_pnl: number;
    total_unrealized_pnl: number;
    profit_factor: number | null;
    max_drawdown: number;
    trades: ClosedTrade[];
    chart_data?: Array<{
        time: string;
        pnl: number;
    }>;
}

export interface WalletState {
    balance: number;
    currency: string;
    formatted: string;
}
