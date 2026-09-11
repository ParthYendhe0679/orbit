/**
 * ORBIT Trading Terminal — AI Intelligence & Analysis Service
 * Manages API communication with Phases 3-12 quantitative engines
 */

import { apiClient } from "./apiClient";
import {
    AgentOrchestrationResult,
    StrategyOrchestrationResult,
    ConsensusResult,
    BrainAnalysisContext,
    RiskEvaluationResult,
    OpportunityEvaluationResult,
    DecisionResult,
    ExplainabilityEvaluationResult,
    CopilotChatRequest,
    CopilotChatResponse,
    CopilotContextResponse
} from "../types/ai";

export const aiService = {
    async analyzeAgents(symbol: string, timeframe: string = "1d"): Promise<AgentOrchestrationResult> {
        return apiClient.get<AgentOrchestrationResult>(
            `/api/agents/analyze?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
        );
    },

    async evaluateStrategies(symbol: string, timeframe: string = "1d"): Promise<StrategyOrchestrationResult> {
        return apiClient.get<StrategyOrchestrationResult>(
            `/api/strategies/evaluate?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
        );
    },

    async evaluateConsensus(symbol: string, timeframe: string = "1d"): Promise<ConsensusResult> {
        return apiClient.get<ConsensusResult>(
            `/api/consensus/evaluate?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
        );
    },

    async analyzeBrain(symbol: string, timeframe: string = "1d"): Promise<BrainAnalysisContext> {
        return apiClient.get<BrainAnalysisContext>(
            `/api/brain/analyze?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
        );
    },

    async evaluateRisk(symbol: string, timeframe: string = "1d"): Promise<RiskEvaluationResult> {
        return apiClient.get<RiskEvaluationResult>(
            `/api/risk/evaluate?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
        );
    },

    async evaluateOpportunity(symbol: string, timeframe: string = "1d"): Promise<OpportunityEvaluationResult> {
        return apiClient.get<OpportunityEvaluationResult>(
            `/api/opportunity/evaluate?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
        );
    },

    async evaluateDecision(symbol: string, timeframe: string = "1d"): Promise<DecisionResult> {
        return apiClient.get<DecisionResult>(
            `/api/decision/evaluate?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
        );
    },

    async evaluateExplainability(symbol: string, timeframe: string = "1d"): Promise<ExplainabilityEvaluationResult> {
        return apiClient.get<ExplainabilityEvaluationResult>(
            `/api/explain/evaluate?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
        );
    },

    async evaluateExplanation(symbol: string, timeframe: string = "1d"): Promise<ExplainabilityEvaluationResult> {
        return this.evaluateExplainability(symbol, timeframe);
    },

    async chatCopilot(req: CopilotChatRequest): Promise<CopilotChatResponse> {
        return apiClient.post<CopilotChatResponse>("/api/copilot/chat", req);
    },

    async getCopilotContext(symbol: string, timeframe: string = "1d"): Promise<CopilotContextResponse> {
        return apiClient.get<CopilotContextResponse>(
            `/api/copilot/context?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`
        );
    },

    async resetCopilotSession(symbol?: string): Promise<{ ok: boolean }> {
        return apiClient.post<{ ok: boolean }>("/api/copilot/reset", { symbol });
    }
};
