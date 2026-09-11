/**
 * ORBIT Trading Terminal — AI Copilot contract
 * Matches ai-service models/copilot.py and the /api/copilot/* and
 * /api/chat/conversations* endpoints (each wraps its payload in {"ok", "data"}).
 */

export interface CopilotChatRequest {
    message: string;
    symbol?: string;
    selected_asset?: string;
    selected_market?: string;
    timeframe?: string;
    /** Continue an existing conversation (one the signed-in user owns). */
    conversation_id?: string;
    response_mode?: "QUICK" | "DETAILED" | "EXPLAIN_SIMPLY" | string;
}

export interface CopilotContextSummary {
    symbol: string;
    timeframe: string;
    market_stance: string;
    confidence: number;
    clarity: string;
    risk_level: string;
    risk_score: number;
    opportunity_score: number;
    opportunity_level: string;
    active_setups_count: number;
    conflicts_count: number;
    analysis_status: string;
}

export interface CopilotChatResponse {
    ok: boolean;
    answer: string;
    symbol: string;
    timeframe: string;
    conversation_id: string;
    intent: string;
    depth: string;
    context_summary: CopilotContextSummary | null;
    context_available: boolean;
    suggested_followups: string[];
    warnings: string[];
    latency_ms: number;
}

/** data of GET /api/copilot/context */
export interface CopilotContext {
    symbol: string;
    timeframe: string;
    market_stance: string;
    confidence: number;
    clarity: string;
    risk_level: string;
    risk_score: number;
    opportunity_score: number;
    opportunity_level: string;
    headline: string;
    why: string[];
    suggested_questions: string[];
}

export interface ConversationItem {
    id: string;
    user_id: number | null;
    title: string;
    selected_asset: string;
    selected_market: string;
    created_at: string;
    updated_at: string;
}

export interface ChatMessageRecord {
    id: string;
    conversation_id: string;
    role: "user" | "assistant" | "system" | string;
    content: string;
    timestamp: string;
    metadata: Record<string, unknown>;
}

export interface ConversationDetail {
    conversation: ConversationItem;
    messages: ChatMessageRecord[];
}
