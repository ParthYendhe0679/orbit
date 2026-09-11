/**
 * ORBIT Trading Terminal — AI Analysis & Intelligence Modals Controller
 * Manages Strategy Suite, Consensus Radar, ORBIT Brain, Risk Guard, Opportunity, Decision, and Explainability
 */

import { aiService } from "../services/aiService";
import { store } from "../state/store";
import { esc } from "../utils/formatters";
import { safeText, getElement } from "../utils/dom";

// ==========================================================================
// 1. STRATEGY SUITE MODAL
// ==========================================================================
export function openStrategyModal(): void {
    const modal = getElement("strategy-inspect-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    const sub = getElement("strat-modal-subtitle");
    if (sub) {
        sub.textContent = `Evaluating real-time market setups on ${store.get("currentAsset") || "BTC-USD"} (${store.get("currentTimeframe") || "1d"})`;
    }
    refreshStrategyModal();
}

export function closeStrategyModal(): void {
    const modal = getElement("strategy-inspect-modal");
    if (modal) modal.classList.add("hidden");
}

export async function refreshStrategyModal(): Promise<void> {
    const grid = getElement("strategy-modal-grid");
    const tallyEl = getElement("strat-tally-text");
    const timeBadge = getElement("strat-time-badge");
    const sub = getElement("strat-modal-subtitle");

    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";

    if (sub) sub.textContent = `Evaluating real-time market setups on ${asset} (${tf})`;
    if (tallyEl) tallyEl.innerHTML = `<span class="status-dot green-glow"></span> Querying Market Data System...`;

    try {
        const data = await aiService.evaluateStrategies(asset, tf);
        if (timeBadge) timeBadge.textContent = `${data.execution_time_ms.toFixed(1)} ms`;

        const bullCount = data.tally?.BULLISH || 0;
        const bearCount = data.tally?.BEARISH || 0;
        const setupsFound = data.setups_found || data.setups_detected_count || 0;
        const totalStrats = data.strategies_total || data.total_strategies || 12;
        const avgConf = data.average_confidence !== undefined ? data.average_confidence : 0;

        if (tallyEl) {
            tallyEl.innerHTML =
                `<strong>${setupsFound} of ${totalStrats}</strong> Setups Active &bull; ` +
                `<span class="text-green">${bullCount} Bullish</span> &bull; ` +
                `<span class="text-red">${bearCount} Bearish</span> &bull; ` +
                `Avg Confidence: <strong>${avgConf}%</strong>`;
        }

        if (grid && Array.isArray(data.results)) {
            grid.innerHTML = data.results
                .map((r) => {
                    const isSetup = r.setup_detected;
                    const cardClass = isSetup
                        ? r.signal === "BULLISH"
                            ? "strat-eval-card setup-active"
                            : "strat-eval-card setup-bearish"
                        : "strat-eval-card";

                    const badgeClass =
                        r.signal === "BULLISH"
                            ? "strat-eval-badge strat-badge-bullish"
                            : r.signal === "BEARISH"
                            ? "strat-eval-badge strat-badge-bearish"
                            : "strat-eval-badge strat-badge-neutral";

                    const statusTag = isSetup ? "● SETUP ACTIVE" : "○ NO SETUP";
                    const conditionsHtml = Object.entries(r.conditions || {})
                        .map(([k, v]) => {
                            const tagClass = v ? "cond-tag cond-true" : "cond-tag cond-false";
                            const icon = v ? "✓" : "✗";
                            return `<span class="${tagClass}">${icon} ${esc(k.replace(/_/g, " "))}</span>`;
                        })
                        .join("");

                    return `
                    <div class="${cardClass}">
                        <div class="strat-eval-header">
                            <div class="strat-eval-title">
                                <span class="${badgeClass}">${esc(r.signal)}</span>
                                <span class="strat-eval-name">${esc(r.strategy_name)}</span>
                            </div>
                            <div style="display:flex;align-items:center;gap:8px;">
                                <span style="font-size:11px;font-family:var(--font-mono);font-weight:600;color:${
                                    isSetup ? "var(--accent)" : "var(--text-3)"
                                }">${statusTag}</span>
                                <span style="font-size:11px;font-family:var(--font-mono);color:var(--text-2);">${r.confidence.toFixed(
                                    1
                                )}%</span>
                            </div>
                        </div>
                        <p class="strat-eval-reason">${esc(
                            r.reasoning && r.reasoning[0] ? r.reasoning[0] : "Strategy criteria evaluated."
                        )}</p>
                        ${conditionsHtml ? `<div class="strat-eval-conditions">${conditionsHtml}</div>` : ""}
                    </div>
                `;
                })
                .join("");
        }
    } catch (err: any) {
        console.error("[StrategyModal] Error:", err);
        if (tallyEl) tallyEl.innerHTML = `<span class="status-dot red-glow"></span> Evaluation failed: ${esc(err.message)}`;
        if (grid) grid.innerHTML = `<div style="padding:24px;text-align:center;color:var(--neg);font-size:12px;">Failed to evaluate strategies. ${esc(err.message)}</div>`;
    }
}

// ==========================================================================
// 2. CONSENSUS RADAR MODAL
// ==========================================================================
export function openConsensusModal(): void {
    const modal = getElement("consensus-inspect-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    refreshConsensusModal();
}

export function closeConsensusModal(): void {
    const modal = getElement("consensus-inspect-modal");
    if (modal) modal.classList.add("hidden");
}

export async function refreshConsensusModal(): Promise<void> {
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";

    const sub = getElement("consensus-modal-subtitle");
    if (sub) sub.textContent = `Synthesizing AI Agents & Quant Strategies for ${asset} (${tf})`;

    try {
        const data = await aiService.evaluateConsensus(asset, tf);
        const signal = data.signal || data.consensus_signal || "NEUTRAL";
        const confidence = data.confidence !== undefined ? data.confidence : data.conviction_score || 0;

        safeText(getElement("consensus-primary-signal"), signal);
        safeText(getElement("consensus-agreement-score"), `${data.agreement_score.toFixed(1)}%`);
        safeText(getElement("consensus-time-badge"), `${data.execution_time_ms.toFixed(1)} ms`);

        const badge = getElement("consensus-primary-signal");
        if (badge) {
            badge.className = `consensus-status-badge ${
                signal === "BULLISH"
                    ? "status-bullish"
                    : signal === "BEARISH"
                    ? "status-bearish"
                    : "status-neutral"
            }`;
        }

        const bar = getElement("consensus-force-fill");
        if (bar) {
            bar.style.width = `${Math.min(100, Math.max(0, confidence))}%`;
            bar.style.backgroundColor =
                signal === "BULLISH" ? "var(--pos)" : signal === "BEARISH" ? "var(--neg)" : "var(--accent)";
        }

        const reasonEl = getElement("consensus-explanation-text");
        if (reasonEl) {
            reasonEl.textContent = data.rationale || data.institutional_view || "Consensus synthesized across quantitative engines.";
        }
    } catch (err: any) {
        console.error("[ConsensusModal] Error:", err);
    }
}

// ==========================================================================
// 3. ORBIT BRAIN MODAL
// ==========================================================================
export function openBrainModal(): void {
    const modal = getElement("brain-inspect-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    refreshBrainModal();
}

export function closeBrainModal(): void {
    const modal = getElement("brain-inspect-modal");
    if (modal) modal.classList.add("hidden");
}

export async function refreshBrainModal(): Promise<void> {
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";

    const sub = getElement("brain-modal-subtitle");
    if (sub) sub.textContent = `Central Intelligence Orchestrator • ${asset} (${tf})`;

    try {
        const data = await aiService.analyzeBrain(asset, tf);
        safeText(getElement("brain-completeness-score"), `${data.completeness_score.toFixed(0)}%`);
        const price = data.market?.current_price ?? data.market_summary?.current_price;
        safeText(getElement("brain-market-price"), price !== undefined ? `$${price.toLocaleString()}` : "—");
        const lat = data.diagnostics?.execution_time_ms ?? data.diagnostics?.subsystem_latencies_ms?.total ?? 0;
        safeText(getElement("brain-time-badge"), `${lat.toFixed(1)} ms`);

        const bar = getElement("brain-completeness-fill");
        if (bar) bar.style.width = `${data.completeness_score}%`;
    } catch (err: any) {
        console.error("[BrainModal] Error:", err);
    }
}

// ==========================================================================
// 4. RISK GUARD MODAL
// ==========================================================================
export function openRiskModal(): void {
    const modal = getElement("risk-guard-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    refreshRiskModal();
}

export function closeRiskModal(): void {
    const modal = getElement("risk-guard-modal");
    if (modal) modal.classList.add("hidden");
}

export async function refreshRiskModal(): Promise<void> {
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";

    try {
        const data = await aiService.evaluateRisk(asset, tf);
        safeText(getElement("risk-score-value"), `${data.risk_score.toFixed(1)}`);
        safeText(getElement("risk-level-badge"), data.risk_level);
        const lat = data.diagnostics?.execution_time_ms ?? data.execution_time_ms ?? 0;
        safeText(getElement("risk-time-badge"), `${lat.toFixed(1)} ms`);

        const levelBadge = getElement("risk-level-badge");
        if (levelBadge) {
            levelBadge.className = `risk-badge ${
                data.risk_level === "LOW"
                    ? "badge-green"
                    : data.risk_level === "MODERATE"
                    ? "badge-yellow"
                    : "badge-red"
            }`;
        }
    } catch (err: any) {
        console.error("[RiskModal] Error:", err);
    }
}

// ==========================================================================
// 5. OPPORTUNITY MODAL
// ==========================================================================
export function openOpportunityModal(): void {
    const modal = getElement("opportunity-eval-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    refreshOpportunityModal();
}

export function closeOpportunityModal(): void {
    const modal = getElement("opportunity-eval-modal");
    if (modal) modal.classList.add("hidden");
}

export async function refreshOpportunityModal(): Promise<void> {
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";

    try {
        const data = await aiService.evaluateOpportunity(asset, tf);
        safeText(getElement("opp-score-value"), `${data.opportunity_score.toFixed(1)}`);
        safeText(getElement("opp-level-badge"), data.opportunity_level);
        const lat = data.diagnostics?.execution_time_ms ?? data.execution_time_ms ?? 0;
        safeText(getElement("opp-time-badge"), `${lat.toFixed(1)} ms`);
    } catch (err: any) {
        console.error("[OpportunityModal] Error:", err);
    }
}

// ==========================================================================
// 6. DECISION ENGINE MODAL
// ==========================================================================
export function openDecisionModal(): void {
    const modal = getElement("decision-inspect-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    refreshDecisionModal();
}

export function closeDecisionModal(): void {
    const modal = getElement("decision-inspect-modal");
    if (modal) modal.classList.add("hidden");
}

export async function refreshDecisionModal(): Promise<void> {
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";

    try {
        const data = await aiService.evaluateDecision(asset, tf);
        const stance = data.market_stance || data.stance || "NEUTRAL";
        const conf = data.decision_confidence !== undefined ? data.decision_confidence : data.confidence || 0;
        safeText(getElement("decision-stance-badge"), stance);
        safeText(getElement("decision-confidence-val"), `${conf.toFixed(1)}%`);
        const lat = data.diagnostics?.execution_time_ms ?? data.execution_time_ms ?? 0;
        safeText(getElement("decision-time-badge"), `${lat.toFixed(1)} ms`);
    } catch (err: any) {
        console.error("[DecisionModal] Error:", err);
    }
}

// ==========================================================================
// 7. EXPLAINABILITY & INSIGHTS MODAL
// ==========================================================================
export function openExplainModal(): void {
    const modal = getElement("explain-eval-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    refreshExplainModal();
}

export function closeExplainModal(): void {
    const modal = getElement("explain-eval-modal");
    if (modal) modal.classList.add("hidden");
}

export async function refreshExplainModal(): Promise<void> {
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";

    try {
        const data = await aiService.evaluateExplanation(asset, tf);
        const stance = data.input_summary?.market_stance || data.stance || "NEUTRAL";
        safeText(getElement("explain-stance-badge"), stance);
        safeText(getElement("explain-headline"), data.headline);
        const lat = data.diagnostics?.execution_time_ms ?? data.execution_time_ms ?? 0;
        safeText(getElement("explain-time-badge"), `${lat.toFixed(1)} ms`);
    } catch (err: any) {
        console.error("[ExplainModal] Error:", err);
    }
}

/**
 * Initializes global Escape key listener to close active AI modals.
 */
export function initModalKeyboardListeners(): void {
    document.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            closeStrategyModal();
            closeConsensusModal();
            closeBrainModal();
            closeRiskModal();
            closeOpportunityModal();
            closeDecisionModal();
            closeExplainModal();
        }
    });
}
