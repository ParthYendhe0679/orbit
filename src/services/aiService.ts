/**
 * ORBIT Trading Terminal — AI Intelligence & Analysis Service
 *
 * The ai-service answers every analysis endpoint as {"ok": true, "data": result};
 * these helpers return the result itself (or throw with the server's detail).
 */

import { apiClient, unwrapData } from "./apiClient";
import {
    AgentOrchestrationResult,
    StrategyOrchestrationResult,
    ConsensusResult,
    BrainAnalysisContext,
    RiskEvaluationResult,
    OpportunityEvaluationResult,
    DecisionResult,
    ExplainabilityEvaluationResult
} from "../types/ai";
import {
    CopilotChatRequest,
    CopilotChatResponse,
    CopilotContext,
    ConversationDetail,
    ConversationItem
} from "../types/copilot";

type Envelope<T> = { ok?: boolean; data?: T; detail?: unknown };

function analysisUrl(path: string, symbol: string, timeframe: string): string {
    return `${path}?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`;
}

async function getData<T>(url: string): Promise<T> {
    return unwrapData(await apiClient.get<Envelope<T>>(url));
}

export const aiService = {
    analyzeAgents(symbol: string, timeframe: string = "1d"): Promise<AgentOrchestrationResult> {
        return getData(analysisUrl("/api/agents/analyze", symbol, timeframe));
    },

    evaluateStrategies(symbol: string, timeframe: string = "1d"): Promise<StrategyOrchestrationResult> {
        return getData(analysisUrl("/api/strategies/evaluate", symbol, timeframe));
    },

    evaluateConsensus(symbol: string, timeframe: string = "1d"): Promise<ConsensusResult> {
        return getData(analysisUrl("/api/consensus/evaluate", symbol, timeframe));
    },

    analyzeBrain(symbol: string, timeframe: string = "1d"): Promise<BrainAnalysisContext> {
        return getData(analysisUrl("/api/brain/analyze", symbol, timeframe));
    },

    evaluateRisk(symbol: string, timeframe: string = "1d"): Promise<RiskEvaluationResult> {
        return getData(analysisUrl("/api/risk/evaluate", symbol, timeframe));
    },

    evaluateOpportunity(symbol: string, timeframe: string = "1d"): Promise<OpportunityEvaluationResult> {
        return getData(analysisUrl("/api/opportunity/evaluate", symbol, timeframe));
    },

    evaluateDecision(symbol: string, timeframe: string = "1d"): Promise<DecisionResult> {
        return getData(analysisUrl("/api/decision/evaluate", symbol, timeframe));
    },

    evaluateExplanation(symbol: string, timeframe: string = "1d"): Promise<ExplainabilityEvaluationResult> {
        return getData(analysisUrl("/api/explain/evaluate", symbol, timeframe));
    },

    async chatCopilot(req: CopilotChatRequest): Promise<CopilotChatResponse> {
        return unwrapData(await apiClient.post<Envelope<CopilotChatResponse>>("/api/copilot/chat", req));
    },

    getCopilotContext(symbol: string, timeframe: string = "1d"): Promise<CopilotContext> {
        return getData(analysisUrl("/api/copilot/context", symbol, timeframe));
    },

    async resetCopilotSession(conversationId: string): Promise<void> {
        await apiClient.post<{ ok: boolean }>("/api/copilot/reset", { conversation_id: conversationId });
    },

    listConversations(limit: number = 40): Promise<ConversationItem[]> {
        return getData(`/api/chat/conversations?limit=${encodeURIComponent(limit)}`);
    },

    getConversation(conversationId: string): Promise<ConversationDetail> {
        return getData(`/api/chat/conversations/${encodeURIComponent(conversationId)}`);
    },

    async deleteConversation(conversationId: string): Promise<void> {
        await apiClient.delete<{ ok: boolean }>(`/api/chat/conversations/${encodeURIComponent(conversationId)}`);
    }
};
