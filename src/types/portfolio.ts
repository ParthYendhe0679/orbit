/**
 * ORBIT Trading Terminal — Portfolio & Performance Types
 *
 * DashboardSummary is the contract of GET /api/dashboard/summary. The Go
 * gateway serves it natively from PostgreSQL + Valkey and the ai-service
 * serves it otherwise; both return exactly this shape (see
 * backend/readapi/testdata/python_golden.json).
 */

import { Position } from "./trading";

export interface AccountSummary {
    total_capital: number;
    available_balance: number;
    used_margin: number;
    equity: number;
}

export interface TradingSummary {
    active_trades: number;
    unrealized_pnl: number;
    realized_pnl: number;
    win_rate: number | null; // null until a trade has closed
    win_rate_str: string;
    closed_trades_count: number;
    total_closed_trades: number;
    winning_trades_count: number;
    winning_trades: number;
    losing_trades_count: number;
}

export interface DashboardSummary {
    account: AccountSummary;
    trading: TradingSummary;
    open_positions: Position[];
    timestamp: string;
    total_capital: number;
    available_balance: number;
    used_margin: number;
    equity: number;
    active_trades: number;
    unrealized_pnl: number;
    realized_pnl: number;
    win_rate: number | null;
    win_rate_str: string;
}

export interface DashboardSummaryResponse extends DashboardSummary {
    ok: boolean;
    data: DashboardSummary;
    source: string;
}

/** report.summary of GET /api/report (ai-service reporting.build_report). */
export interface ReportSummary {
    total_trades: number;
    closed_trades: number;
    open_trades: number;
    pending_trades: number;
    wins: number;
    losses: number;
    win_rate: number;
    net_pnl: number;
    gross_profit: number;
    gross_loss: number;
    profit_factor: number | null;
    expectancy: number;
    avg_win: number;
    avg_loss: number;
    best_trade: number;
    worst_trade: number;
    max_drawdown: number;
    max_drawdown_pct: number;
    longest_win_streak: number;
    longest_loss_streak: number;
    unrealized_pnl: number;
    starting_balance: number;
}

export interface EquityPoint {
    n: number;
    trade_id: number;
    timestamp: string;
    asset: string;
    pnl: number;
    cumulative: number;
    balance: number;
}

export interface BreakdownRow {
    name: string;
    trades: number;
    wins: number;
    pnl: number;
    win_rate?: number;
}

export interface ReportTrade {
    id: number;
    timestamp: string;
    asset: string;
    type: string;
    status: string;
    outcome: string | null;
    quantity: number;
    entry_price: number;
    exit_price: number | null;
    sl: number;
    target: number;
    pnl: number;
}

export interface PortfolioReport {
    generated_at: string;
    summary: ReportSummary;
    equity_curve: EquityPoint[];
    by_asset: BreakdownRow[];
    by_direction: BreakdownRow[];
    by_outcome: BreakdownRow[];
    by_month: BreakdownRow[];
    trades: ReportTrade[];
}

export interface ReportResponse {
    ok: boolean;
    report: PortfolioReport;
}

export interface WalletState {
    balance: number;
    currency: string;
    formatted: string;
}
