/**
 * ORBIT Trading Terminal — AI Intelligence & Quantitative Strategy Types
 * Mirrors backend/models/ (agent, strategy, consensus, brain, risk, opportunity, decision, explainability, copilot)
 */

// --- 1. Specialized AI Agents (Phase 3) ---

export type AgentSignal = "BULLISH" | "BEARISH" | "NEUTRAL";
export type AgentCategory = "TREND" | "MOMENTUM" | "VOLUME" | "VOLATILITY" | "REGIME" | "LEVELS" | "SENTIMENT";
export type AgentStatus = "SUCCESS" | "ERROR" | "SKIPPED";

export interface AgentResult {
    agent_id: string;
    agent_name: string;
    category: AgentCategory;
    symbol: string;
    timeframe: string;
    signal: AgentSignal;
    confidence: number;
    summary: string;
    reasoning: string[];
    metrics: Record<string, unknown>;
    status: AgentStatus;
    error_message?: string | null;
    execution_time_ms: number;
    timestamp: string;
}

export interface AgentOrchestrationResult {
    symbol: string;
    timeframe: string;
    total_agents: number;
    successful_agents: number;
    failed_agents: number;
    results: Record<string, AgentResult>;
    leading_signal: AgentSignal;
    average_confidence: number;
    execution_time_ms: number;
    timestamp: string;
}

// --- 2. Quantitative Strategies (Phase 4) ---

export type StrategySignal = "BULLISH" | "BEARISH" | "NEUTRAL";
export type StrategyCategory = "MARKET_STRUCTURE" | "PRICE_ACTION" | "FLOW_VOLATILITY" | "TREND_MOMENTUM";
export type StrategyStatus = "SUCCESS" | "ERROR" | "SKIPPED";

export interface StrategyResult {
    strategy_id: string;
    strategy_name: string;
    category: StrategyCategory;
    symbol: string;
    timeframe: string;
    setup_detected: boolean;
    signal: StrategySignal;
    confidence: number;
    setup_name: string;
    conditions_met: string[];
    conditions_pending: string[];
    conditions?: Record<string, boolean>;
    reasoning?: string[];
    suggested_entry?: number | null;
    suggested_sl?: number | null;
    suggested_tp?: number | null;
    risk_reward_ratio?: number | null;
    status: StrategyStatus;
    error_message?: string | null;
    execution_time_ms: number;
    timestamp: string;
}

export interface StrategyOrchestrationResult {
    symbol: string;
    timeframe: string;
    total_strategies: number;
    successful_strategies: number;
    failed_strategies: number;
    setups_detected_count: number;
    results: Record<string, StrategyResult> | StrategyResult[];
    execution_time_ms: number;
    timestamp: string;
    tally?: { BULLISH?: number; BEARISH?: number; NEUTRAL?: number };
    setups_found?: number;
    strategies_total?: number;
    average_confidence?: number;
}

// --- 3. Consensus Engine (Phase 5) ---

export type ConsensusSignal = "BULLISH" | "BEARISH" | "NEUTRAL" | "MIXED" | "INSUFFICIENT_EVIDENCE";
export type AgreementLevel = "STRONG_AGREEMENT" | "MODERATE_AGREEMENT" | "WEAK_AGREEMENT" | "POLAR_CONFLICT" | "INSUFFICIENT_DATA";

export interface EvidenceItem {
    source_id: string;
    source_name: string;
    source_type: "AGENT" | "STRATEGY";
    signal: "BULLISH" | "BEARISH" | "NEUTRAL";
    confidence: number;
    weight: number;
    weighted_score: number;
    key_reason: string;
}

export interface ConsensusResult {
    symbol: string;
    timeframe: string;
    status: string;
    consensus_signal: ConsensusSignal;
    signal?: string;
    confidence?: number;
    rationale?: string;
    agreement_level: AgreementLevel;
    conviction_score: number;
    agreement_score: number;
    bullish_force: number;
    bearish_force: number;
    total_signals_evaluated: number;
    contributing_sources_count: number;
    supporting_evidence: EvidenceItem[];
    opposing_evidence: EvidenceItem[];
    neutral_evidence: EvidenceItem[];
    institutional_view: string;
    execution_time_ms: number;
    timestamp: string;
}

// --- 4. ORBIT Brain Unified Context (Phase 6) ---

export type CompletenessTier = "COMPLETE" | "PARTIAL" | "LIMITED" | "FAILED";
export type BrainStatus = "READY" | "PARTIAL" | "LIMITED" | "INSUFFICIENT_DATA" | "FAILED";

export interface BrainAnalysisContext {
    symbol: string;
    timeframe: string;
    status: BrainStatus;
    completeness_score: number;
    completeness_tier: CompletenessTier;
    market?: { current_price?: number; [key: string]: any };
    market_summary: {
        symbol: string;
        current_price: number;
        price_change: number;
        price_change_pct: number;
        high: number;
        low: number;
        volume: number;
        volatility_atr: number;
        volatility_pct: number;
        trend_regime: string;
        data_points: number;
        timestamp: string;
    };
    agent_summary: {
        total_agents: number;
        successful_agents: number;
        failed_agents: number;
        leading_signal: string;
        average_confidence: number;
        tally: Record<string, number>;
        key_findings: string[];
    };
    strategy_summary: {
        total_strategies: number;
        successful_strategies: number;
        failed_strategies: number;
        setups_detected: number;
        leading_setup_signal: string;
        active_setups: string[];
    };
    consensus_summary: {
        signal: ConsensusSignal;
        agreement_level: AgreementLevel;
        conviction_score: number;
        agreement_score: number;
        bullish_force: number;
        bearish_force: number;
        institutional_view: string;
    };
    key_evidence: {
        primary_supporting_factors: string[];
        primary_conflicting_factors: string[];
        total_evidence_count: number;
    };
    diagnostics: {
        execution_time_ms: number;
        subsystem_latencies_ms: Record<string, number>;
        timestamp: string;
    };
}

// --- 5. Risk Guard (Phase 7) ---

export type RiskLevel = "VERY_LOW" | "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

export interface RiskEvaluationResult {
    symbol: string;
    timeframe: string;
    status: string;
    risk_level: RiskLevel;
    risk_score: number; // 0 (safest) to 100 (most hazardous)
    headline: string;
    summary: string;
    dimensions: {
        volatility_risk: { score: number; level: string; summary: string };
        conflict_risk: { score: number; level: string; summary: string };
        consensus_risk: { score: number; level: string; summary: string };
        completeness_risk: { score: number; level: string; summary: string };
        data_quality_risk: { score: number; level: string; summary: string };
    };
    risk_warnings: string[];
    safety_stabilizers: string[];
    execution_time_ms: number;
    diagnostics?: { execution_time_ms: number; [key: string]: any };
    timestamp: string;
}

// --- 6. Opportunity Evaluation Engine (Phase 8) ---

export type OpportunityLevel = "VERY_HIGH" | "HIGH" | "MODERATE" | "LOW" | "VERY_LOW";

export interface OpportunityEvaluationResult {
    symbol: string;
    timeframe: string;
    status: string;
    opportunity_level: OpportunityLevel;
    opportunity_score: number; // 0 (weakest) to 100 (strongest confluence)
    headline: string;
    summary: string;
    confluence_boosters: string[];
    opportunity_headwinds: string[];
    dimensions: {
        consensus_quality: { score: number; quality: string; summary: string };
        strategy_confluence: { score: number; quality: string; summary: string };
        agent_harmony: { score: number; quality: string; summary: string };
        risk_headroom: { score: number; quality: string; summary: string };
        analysis_completeness: { score: number; quality: string; summary: string };
    };
    execution_time_ms: number;
    diagnostics?: { execution_time_ms: number; [key: string]: any };
    timestamp: string;
}

// --- 7. Decision Engine (Phase 9) ---

export type DecisionStance = "BULLISH" | "BEARISH" | "NEUTRAL" | "MIXED" | "NO_CLEAR_DECISION" | "INSUFFICIENT_DATA";
export type ClarityLevel = "HIGH" | "MODERATE" | "LOW" | "VERY_LOW";
export type ExecutionAction = "EXECUTE_LONG" | "EXECUTE_SHORT" | "HOLD_POSITION" | "STAND_BY" | "REDUCE_RISK";

export interface DecisionResult {
    symbol: string;
    timeframe: string;
    status: string;
    stance: DecisionStance;
    market_stance?: string;
    clarity: ClarityLevel;
    confidence: number;
    decision_confidence?: number;
    headline: string;
    summary: string;
    action_suggestion: ExecutionAction;
    constraints: string[];
    key_drivers: string[];
    execution_time_ms: number;
    diagnostics?: { execution_time_ms: number; [key: string]: any };
    timestamp: string;
}

// --- 8. Explainability Engine (Phase 10) ---

export interface TraceableInsight {
    category: string;
    source: string;
    point: string;
    evidence_tag: string;
}

export interface ExplainabilityEvaluationResult {
    symbol: string;
    timeframe: string;
    status: string;
    stance: DecisionStance;
    input_summary?: { market_stance: string; [key: string]: any };
    clarity: ClarityLevel;
    confidence: number;
    headline: string;
    core_thesis: string[];
    insights: TraceableInsight[];
    conflicts_explained: string[];
    risk_constraints_explained: string[];
    uncertainties_highlighted: string[];
    execution_time_ms: number;
    diagnostics?: { execution_time_ms: number; [key: string]: any };
    timestamp: string;
}

// --- 9. AI Market Copilot (Phase 12) ---

export interface CopilotChatMessage {
    role: "user" | "assistant" | "system";
    content: string;
    timestamp?: string;
}

export interface CopilotChatRequest {
    message: string;
    symbol?: string;
    timeframe?: string;
    session_id?: string;
    response_mode?: string;
    selected_asset?: string;
    selected_market?: string;
}

export interface CopilotChatResponse {
    reply: string;
    intent: string;
    depth: string;
    symbol: string;
    timeframe: string;
    session_id: string;
    latency_ms: number;
    model_used?: string;
}

export interface CopilotContextResponse {
    symbol: string;
    timeframe: string;
    decision_stance: string;
    confidence: number;
    risk_level: string;
    risk_score: number;
    opportunity_level: string;
    opportunity_score: number;
    active_setups: string[];
}
