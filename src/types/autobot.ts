/**
 * ORBIT Trading Terminal — Auto-Trade Bot Domain Types
 * Matches /api/bot-config and autotrade background loop contracts
 */

export type AssetCategory = "Crypto" | "Stock" | "Forex" | "Commodity" | "Index";

export type BotExecutionStatus = 
    | "ACTIVE"
    | "STOPPED"
    | "SEARCHING"
    | "EXECUTING"
    | "TARGET_REACHED"
    | "MAX_LOSS_REACHED"
    | "MANUALLY_STOPPED";

export interface AutoBotConfig {
    user_id: number;
    assets: string;
    total_capital: number;
    max_risk_per_trade: number;
    min_profit_target: number;
    max_profit_target: number;
    is_active: boolean;
    asset_category?: AssetCategory;
    selected_assets?: string[];
    allocated_capital?: number;
    target_profit?: number;
    max_loss?: number;
    leverage?: number;
    status?: "ACTIVE" | "STOPPED";
    created_at?: string;
    updated_at?: string;
}

export interface BotAssetInfo {
    symbol: string;
    name: string;
}

export interface BotMarketCategory {
    id: string;
    label: string;
    supported: boolean;
    reason?: string;
    assets: BotAssetInfo[];
}

export interface BotUniverseResponse {
    categories: BotMarketCategory[];
    policy: {
        supported_leverage: number[];
        default_leverage: number;
        max_active_trades_per_session?: number;
        min_capital?: number;
    };
}

export interface BotActiveTrade {
    id: number;
    symbol?: string;
    asset?: string;
    side?: string;
    type?: string;
    entry_price: number;
    current_price: number;
    quantity: number;
    original_quantity?: number;
    remaining_quantity?: number;
    leverage?: number;
    position_size?: number;
    margin_used?: number;
    unrealized_pnl?: number;
    opened_at?: string;
    source?: string;
    bot_session_id?: number;
}

export interface BotSessionDetail {
    id: number;
    user_id: number;
    status: string;
    market_category: string;
    assets: string[];
    allocated_capital: number;
    available_bot_capital: number;
    used_capital: number;
    target_profit: number;
    max_loss: number;
    leverage: number;
    total_pnl: number;
    realized_pnl: number;
    unrealized_pnl: number;
    session_loss: number;
    target_progress_pct: number;
    loss_progress_pct: number;
    loss_basis?: string;
    total_trades: number;
    winning_trades: number;
    losing_trades: number;
    open_trades: number;
    scan_count: number;
    entries_allowed: boolean;
    next_scan_in_seconds?: number | null;
    started_at?: string;
    stopped_at?: string;
    stop_reason?: string;
    last_error?: string;
    active_trades?: BotActiveTrade[];
    created_at?: string;
    scheduler_online?: boolean;
}

export interface BotActivityEvent {
    id?: number;
    session_id?: number;
    event: string;
    level: string;
    message: string;
    symbol?: string;
    ts?: string;
}

export interface BotCurrentSessionResponse {
    ok?: boolean;
    session: BotSessionDetail | null;
    config: any;
    available_balance: number;
    scheduler_online?: boolean;
}
