/**
 * ORBIT Trading Terminal — AI Analysis & Intelligence Modals Controller
 * Strategy Suite, Consensus Radar, ORBIT Brain, Risk Guard, Opportunity,
 * Decision and Explainability modals, rendered from the ai-service results
 * (aiService unwraps the {"ok", "data"} envelope). Field names follow the
 * ai-service Pydantic models; element ids follow frontend/index.html.
 */

import { aiService } from "../services/aiService";
import { store } from "../state/store";
import { esc } from "../utils/formatters";
import { getElement } from "../utils/dom";

type Json = any;

const el = (id: string): HTMLElement | null => getElement(id);

function num(value: unknown, fallback: number = 0): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function activeContext(): { asset: string; tf: string } {
    return { asset: store.get("currentAsset") || "BTC-USD", tf: store.get("currentTimeframe") || "1d" };
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function statusColor(status: string | undefined, ready: string = "var(--pos)"): string {
    if (status === "READY") return ready;
    if (status === "PARTIAL") return "#facc15";
    if (status === "LIMITED") return "#f97316";
    return "var(--neg)";
}

function scoreHtml(value: number, decimals: number = 1): string {
    return `${value.toFixed(decimals)}<span style="font-size:13px;color:var(--text-3);font-weight:400;">/100</span>`;
}

function show(id: string): boolean {
    const modal = el(id);
    if (!modal) return false;
    modal.classList.remove("hidden");
    return true;
}

function hide(id: string): void {
    el(id)?.classList.add("hidden");
}

function renderEvidenceCard(e: Json, modifier: "conflict" | "supporting" | "failed"): string {
    const cardClass = `evidence-card ${modifier}`;
    const badgeClass =
        e.signal === "BULLISH" ? "strat-eval-badge strat-badge-bullish"
            : e.signal === "BEARISH" ? "strat-eval-badge strat-badge-bearish"
                : "strat-eval-badge strat-badge-neutral";
    const srcType = e.evidence_type || e.source_type || "SOURCE";
    const reasonText = e.summary || e.reasoning || "Analysis criteria evaluated.";
    return `
        <div class="${cardClass}">
            <div class="evidence-card-header">
                <div class="evidence-source-info">
                    <span class="evidence-type-badge">${esc(srcType)}</span>
                    <span class="evidence-source-name">${esc(e.source_name)}</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                    <span class="${badgeClass}">${esc(e.signal)}</span>
                    <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-3);">${num(e.confidence).toFixed(0)}%</span>
                </div>
            </div>
            <div class="evidence-card-reason">${esc(reasonText)}</div>
        </div>`;
}

function factorList(items: Json[], itemClass: string, titleClass: string, icon: string, empty: string): string {
    if (!items.length) {
        return `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">${empty}</div>`;
    }
    return items
        .map(
            (f) => `
            <div class="${itemClass}">
                <div class="${titleClass}">
                    <i class="${icon}"></i>
                    <span>${esc(f.title)}</span>
                </div>
                <div class="${titleClass.replace("-title", "-detail").split(" ")[0]}">${esc(f.detail)}</div>
            </div>`
        )
        .join("");
}

// ==========================================================================
// 1. STRATEGY SUITE MODAL
// ==========================================================================
export function openStrategyModal(): void {
    if (show("strategy-inspect-modal")) refreshStrategyModal();
}

export function closeStrategyModal(): void {
    hide("strategy-inspect-modal");
}

export async function refreshStrategyModal(): Promise<void> {
    const grid = el("strategy-modal-grid");
    const tallyEl = el("strat-tally-text");
    const timeBadge = el("strat-time-badge");
    const { asset, tf } = activeContext();

    const sub = el("strat-modal-subtitle");
    if (sub) sub.textContent = `Evaluating real-time market setups on ${asset} (${tf})`;
    if (tallyEl) tallyEl.innerHTML = `<span class="status-dot green-glow"></span> Querying Market Data System...`;

    try {
        const data: Json = await aiService.evaluateStrategies(asset, tf);
        if (timeBadge) timeBadge.textContent = `${num(data.execution_time_ms).toFixed(1)} ms`;
        const tally = data.tally || {};
        if (tallyEl) {
            tallyEl.innerHTML =
                `<strong>${num(data.setups_found)} of ${num(data.strategies_total)}</strong> Setups Active &bull; ` +
                `<span class="text-green">${num(tally.BULLISH)} Bullish</span> &bull; ` +
                `<span class="text-red">${num(tally.BEARISH)} Bearish</span> &bull; ` +
                `Avg Confidence: <strong>${num(data.average_confidence)}%</strong>`;
        }
        if (grid && Array.isArray(data.results)) {
            grid.innerHTML = data.results
                .map((r: Json) => {
                    const isSetup = !!r.setup_detected;
                    const cardClass = isSetup
                        ? r.signal === "BULLISH" ? "strat-eval-card setup-active" : "strat-eval-card setup-bearish"
                        : "strat-eval-card";
                    const badgeClass =
                        r.signal === "BULLISH" ? "strat-eval-badge strat-badge-bullish"
                            : r.signal === "BEARISH" ? "strat-eval-badge strat-badge-bearish"
                                : "strat-eval-badge strat-badge-neutral";
                    const conditionsHtml = Object.entries(r.conditions || {})
                        .map(([k, v]) => `<span class="cond-tag ${v ? "cond-true" : "cond-false"}">${v ? "✓" : "✗"} ${esc(k.replace(/_/g, " "))}</span>`)
                        .join("");
                    return `
                    <div class="${cardClass}">
                        <div class="strat-eval-header">
                            <div class="strat-eval-title">
                                <span class="${badgeClass}">${esc(r.signal)}</span>
                                <span class="strat-eval-name">${esc(r.strategy_name)}</span>
                            </div>
                            <div style="display:flex;align-items:center;gap:8px;">
                                <span style="font-size:11px;font-family:var(--font-mono);font-weight:600;color:${isSetup ? "var(--accent)" : "var(--text-3)"}">${isSetup ? "● SETUP ACTIVE" : "○ NO SETUP"}</span>
                                <span style="font-size:11px;font-family:var(--font-mono);color:var(--text-2);">${num(r.confidence).toFixed(1)}%</span>
                            </div>
                        </div>
                        <p class="strat-eval-reason">${esc(r.reasoning && r.reasoning[0] ? r.reasoning[0] : "Strategy criteria evaluated.")}</p>
                        ${conditionsHtml ? `<div class="strat-eval-conditions">${conditionsHtml}</div>` : ""}
                    </div>`;
                })
                .join("");
        }
    } catch (err) {
        if (tallyEl) tallyEl.innerHTML = `<span class="status-dot red-glow"></span> Evaluation failed: ${esc(errorText(err))}`;
        if (grid) grid.innerHTML = `<div style="padding:24px;text-align:center;color:var(--neg);font-size:12px;">Failed to evaluate strategies. ${esc(errorText(err))}</div>`;
    }
}

// ==========================================================================
// 2. CONSENSUS RADAR MODAL
// ==========================================================================
export function openConsensusModal(): void {
    if (show("consensus-inspect-modal")) refreshConsensusModal();
}

export function closeConsensusModal(): void {
    hide("consensus-inspect-modal");
}

export async function refreshConsensusModal(): Promise<void> {
    const body = el("consensus-modal-body");
    const tallyEl = el("consensus-tally-text");
    const { asset, tf } = activeContext();
    const sub = el("consensus-modal-subtitle");
    if (sub) sub.textContent = `Unified Market Consensus on ${asset} (${tf})`;
    if (tallyEl) tallyEl.innerHTML = `<span class="status-dot green-glow"></span> Running Agents & Quantitative Strategies...`;

    try {
        const data: Json = await aiService.evaluateConsensus(asset, tf);
        const timeBadge = el("consensus-time-badge");
        if (timeBadge) timeBadge.textContent = `${num(data.execution_time_ms).toFixed(1)} ms`;

        const sig: string = data.consensus_signal || "NEUTRAL";
        const strength = num(data.consensus_strength);
        const agreement = num(data.agreement_score);
        const view = data.market_view;
        const viewTitle = view && typeof view === "object" ? view.title : view || "Market Equilibrium";
        const viewSummary = view && typeof view === "object" ? view.summary : data.summary_reasoning || "";

        const overview = el("overview-consensus-status");
        if (overview) {
            overview.textContent = `${sig} (${strength.toFixed(0)}%)`;
            overview.className = sig === "BULLISH" ? "text-green" : sig === "BEARISH" ? "text-red" : sig === "MIXED" ? "text-yellow" : "text-blue";
        }
        const pill = el("consensus-signal-pill");
        if (pill) {
            pill.textContent = sig;
            pill.className = `consensus-signal-pill ${sig.toLowerCase()}`;
        }
        const titleEl = el("consensus-view-title");
        if (titleEl) titleEl.textContent = String(viewTitle || "");
        const subEl = el("consensus-view-sub");
        if (subEl) subEl.textContent = String(viewSummary || "");
        const strengthEl = el("consensus-strength-val");
        if (strengthEl) strengthEl.textContent = `${strength.toFixed(1)}%`;
        const agreementEl = el("consensus-agreement-val");
        if (agreementEl) agreementEl.textContent = `${agreement.toFixed(1)}%`;
        const levelEl = el("consensus-agreement-level");
        if (levelEl) {
            const level = String(data.agreement_level || "—");
            levelEl.textContent = level;
            levelEl.className = `consensus-metric-val ${level.includes("STRONG") ? "text-green" : level.includes("CONFLICT") || level.includes("INSUFFICIENT") ? "text-red" : "text-yellow"}`;
        }

        const bull = num(data.agent_tally?.BULLISH) + num(data.strategy_tally?.BULLISH);
        const neut = num(data.agent_tally?.NEUTRAL) + num(data.strategy_tally?.NEUTRAL);
        const bear = num(data.agent_tally?.BEARISH) + num(data.strategy_tally?.BEARISH);
        const total = bull + neut + bear || 1;
        const pBull = ((bull / total) * 100).toFixed(1);
        const pNeut = ((neut / total) * 100).toFixed(1);
        const pBear = ((bear / total) * 100).toFixed(1);
        const bullLbl = el("consensus-bull-force-lbl");
        if (bullLbl) bullLbl.innerHTML = `<i class="fa-solid fa-arrow-up"></i> Bullish ${pBull}% (${bull})`;
        const neutLbl = el("consensus-neutral-force-lbl");
        if (neutLbl) neutLbl.textContent = `Neutral ${pNeut}% (${neut})`;
        const bearLbl = el("consensus-bear-force-lbl");
        if (bearLbl) bearLbl.innerHTML = `Bearish ${pBear}% (${bear}) <i class="fa-solid fa-arrow-down"></i>`;
        const setWidth = (id: string, pct: string) => {
            const bar = el(id);
            if (bar) bar.style.width = `${pct}%`;
        };
        setWidth("consensus-bar-bull", pBull);
        setWidth("consensus-bar-neut", pNeut);
        setWidth("consensus-bar-bear", pBear);

        if (tallyEl) {
            tallyEl.innerHTML =
                `<strong>${num(data.total_evidence_evaluated, total)}</strong> Total Sources &bull; ` +
                `<span class="text-green">${bull} Bullish</span> &bull; <span class="text-3">${neut} Neutral</span> &bull; ` +
                `<span class="text-red">${bear} Bearish</span> &bull; Status: <strong>${esc(data.status)}</strong>`;
        }

        if (body) {
            let html = "";
            const conflicting: Json[] = Array.isArray(data.conflicting_evidence) ? data.conflicting_evidence : [];
            const supporting: Json[] = Array.isArray(data.supporting_evidence) ? data.supporting_evidence : [];
            const ignored: Json[] = Array.isArray(data.ignored_evidence) ? data.ignored_evidence : [];
            if (conflicting.length) {
                html += `<div class="consensus-section-header" style="color:#facc15;"><i class="fa-solid fa-triangle-exclamation"></i><span>Conflicting Evidence (${conflicting.length})</span></div>
                    <div class="evidence-grid">${conflicting.map((e) => renderEvidenceCard(e, "conflict")).join("")}</div>`;
            }
            if (supporting.length) {
                html += `<div class="consensus-section-header" style="color:var(--pos);"><i class="fa-solid fa-shield-check"></i><span>Primary Supporting Evidence (${supporting.length})</span></div>
                    <div class="evidence-grid">${supporting.map((e) => renderEvidenceCard(e, "supporting")).join("")}</div>`;
            }
            if (ignored.length) {
                html += `<div class="consensus-section-header" style="color:var(--text-4);margin-top:12px;"><i class="fa-solid fa-ban"></i><span>Ignored / Inactive Signals (${ignored.length})</span></div>
                    <div class="evidence-grid">${ignored
                        .map(
                            (e) => `
                        <div class="evidence-card failed">
                            <div class="evidence-card-header">
                                <div class="evidence-source-info">
                                    <span class="evidence-type-badge">${esc(e.type || e.evidence_type || "UNKNOWN")}</span>
                                    <span class="evidence-source-name">${esc(e.id || e.source_name || "Source")}</span>
                                </div>
                                <span class="strat-eval-badge strat-badge-neutral">${esc(e.reason || "SKIPPED")}</span>
                            </div>
                            <div class="evidence-card-reason">${esc(e.detail || e.summary || "Source omitted from voting.")}</div>
                        </div>`
                        )
                        .join("")}</div>`;
            }
            body.innerHTML = html || `<div style="padding:24px;text-align:center;color:var(--text-3);font-size:12px;">No evidence items were produced for ${esc(asset)}.</div>`;
        }
    } catch (err) {
        if (tallyEl) tallyEl.innerHTML = `<span class="status-dot red-glow"></span> Error: ${esc(errorText(err))}`;
        if (body) body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--neg);font-size:12px;">Error connecting to Consensus Engine: ${esc(errorText(err))}</div>`;
    }
}

// ==========================================================================
// 3. ORBIT BRAIN MODAL
// ==========================================================================
export function openBrainModal(): void {
    if (show("brain-inspect-modal")) refreshBrainModal();
}

export function closeBrainModal(): void {
    hide("brain-inspect-modal");
}

export async function refreshBrainModal(): Promise<void> {
    const { asset, tf } = activeContext();
    const sub = el("brain-modal-subtitle");
    if (sub) sub.textContent = `Central Intelligence Orchestration Dossier on ${asset} (${tf})`;
    const execText = el("brain-exec-summary-text");
    const statusTag = el("brain-status-tag");
    if (execText) execText.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i> Orchestrating market data, AI agents, strategies and consensus...`;

    try {
        const data: Json = await aiService.analyzeBrain(asset, tf);
        if (statusTag) {
            statusTag.textContent = data.analysis_status || "READY";
            statusTag.style.color = statusColor(data.analysis_status);
        }
        const bias: string = data.overall_bias || "NEUTRAL";
        const biasPill = el("brain-bias-pill");
        if (biasPill) {
            biasPill.textContent = bias;
            biasPill.className = `consensus-signal-pill ${bias.toLowerCase()}`;
        }
        const conviction = el("brain-conviction-pill");
        if (conviction) conviction.textContent = `Conviction: ${num(data.conviction_strength).toFixed(1)}%`;
        const tier = el("brain-tier-pill");
        if (tier) {
            tier.textContent = `${data.completeness_tier || "—"} (${num(data.completeness_score).toFixed(0)}%)`;
            tier.style.color = data.completeness_tier === "COMPLETE" ? "var(--pos)" : data.completeness_tier === "PARTIAL" ? "#facc15" : "var(--neg)";
        }
        if (execText) execText.textContent = data.executive_summary || "";

        const mkt: Json = data.market_summary || {};
        const price = el("brain-mkt-price");
        if (price) price.textContent = mkt.current_price !== undefined && mkt.current_price !== null
            ? num(mkt.current_price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : "—";
        const change = el("brain-mkt-change");
        if (change) {
            const pct = num(mkt.price_change_pct);
            change.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
            change.className = pct >= 0 ? "brain-sub-val text-green" : "brain-sub-val text-red";
        }
        const atr = el("brain-mkt-atr");
        if (atr) atr.textContent = `${num(mkt.volatility_atr).toFixed(2)} (${num(mkt.volatility_pct).toFixed(2)}%)`;
        const regime = el("brain-mkt-regime");
        if (regime) regime.textContent = mkt.trend_regime || "—";

        const ag: Json = data.agent_summary || {};
        const agTally: Json = ag.tally || {};
        const setText = (id: string, text: string) => {
            const node = el(id);
            if (node) node.textContent = text;
        };
        setText("brain-agent-leading", ag.leading_signal || "—");
        setText("brain-agent-bull", String(num(agTally.BULLISH)));
        setText("brain-agent-neut", String(num(agTally.NEUTRAL)));
        setText("brain-agent-bear", String(num(agTally.BEARISH)));
        setText("brain-agent-conf", `${num(ag.average_confidence).toFixed(0)}%`);

        const st: Json = data.strategy_summary || {};
        setText("brain-strat-setups-tag", `${num(st.setups_found)} SETUPS`);
        setText("brain-strat-active-count", `${num(st.setups_found)} / ${num(st.strategies_evaluated)}`);
        setText("brain-strat-bull", String(num(st.bullish_setups)));
        setText("brain-strat-bear", String(num(st.bearish_setups)));
        const activeList = el("brain-strat-active-list");
        if (activeList) {
            const names: string[] = Array.isArray(st.active_strategies) ? st.active_strategies : [];
            activeList.innerHTML = names.length
                ? names.map((n) => `<span class="strat-eval-badge strat-badge-bullish" style="font-size:9.5px;">✓ ${esc(n)}</span>`).join("")
                : `<span style="font-size:10.5px;color:var(--text-4);font-style:italic;">No active strategy setups detected</span>`;
        }

        const cs: Json = data.consensus_summary || {};
        setText("brain-cons-status-tag", cs.status || "—");
        const consSig = el("brain-cons-sig");
        if (consSig) {
            consSig.textContent = cs.signal || "—";
            consSig.className = cs.signal === "BULLISH" ? "brain-sub-val text-green" : cs.signal === "BEARISH" ? "brain-sub-val text-red" : cs.signal === "MIXED" ? "brain-sub-val text-yellow" : "brain-sub-val text-blue";
        }
        setText("brain-cons-strength", `${num(cs.strength).toFixed(1)}%`);
        setText("brain-cons-agree", `${num(cs.agreement_score).toFixed(0)}% (${cs.agreement_level || "—"})`);
        setText("brain-market-view-line", cs.market_view || "");

        const evidence = el("brain-evidence-section");
        if (evidence) {
            const supporting: Json[] = data.key_supporting_evidence || [];
            const conflicting: Json[] = data.key_conflicting_evidence || [];
            let html = "";
            if (conflicting.length) {
                html += `<div class="consensus-section-header" style="color:#facc15;"><i class="fa-solid fa-triangle-exclamation"></i><span>Key Conflicting Evidence (${conflicting.length})</span></div>
                    <div class="evidence-grid">${conflicting.map((e) => renderEvidenceCard(e, "conflict")).join("")}</div>`;
            }
            if (supporting.length) {
                html += `<div class="consensus-section-header" style="color:var(--pos);margin-top:4px;"><i class="fa-solid fa-shield-check"></i><span>Key Supporting Evidence (${supporting.length})</span></div>
                    <div class="evidence-grid">${supporting.map((e) => renderEvidenceCard(e, "supporting")).join("")}</div>`;
            }
            evidence.innerHTML = html;
        }
        const diag: Json = data.diagnostics || {};
        setText("brain-diag-latency", `${num(diag.total_pipeline_ms).toFixed(1)} ms`);
        setText("brain-diag-comp", `${num(data.completeness_score).toFixed(1)}%`);
    } catch (err) {
        if (execText) execText.innerHTML = `<span style="color:var(--neg);">Analysis failed: ${esc(errorText(err))}</span>`;
        if (statusTag) {
            statusTag.textContent = "FAILED";
            statusTag.style.color = "var(--neg)";
        }
    }
}

// ==========================================================================
// 4. RISK GUARD MODAL
// ==========================================================================
export function openRiskModal(): void {
    if (show("risk-guard-modal")) refreshRiskModal();
}

export function closeRiskModal(): void {
    hide("risk-guard-modal");
}

const RISK_LEVEL_COLOR: Record<string, string> = { VERY_LOW: "var(--pos)", LOW: "var(--pos)", MODERATE: "#F59E0B", HIGH: "#F97316", CRITICAL: "var(--neg)" };

export async function refreshRiskModal(): Promise<void> {
    const { asset, tf } = activeContext();
    const sub = el("risk-modal-subtitle");
    if (sub) sub.textContent = `Analysis Quality & Market Safety Audit on ${asset} (${tf})`;
    const heroSummary = el("risk-hero-summary");
    const statusTag = el("risk-status-tag");
    if (heroSummary) heroSummary.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i> Evaluating volatility, conflict, consensus, quality and data...`;

    try {
        const data: Json = await aiService.evaluateRisk(asset, tf);
        if (statusTag) {
            statusTag.textContent = data.status || "READY";
            statusTag.style.color = statusColor(data.status);
        }
        const lvl: string = data.risk_level || "MODERATE";
        const pill = el("risk-level-pill");
        if (pill) {
            pill.textContent = lvl.replace(/_/g, " ");
            pill.className = `risk-level-pill ${lvl.toLowerCase().replace(/_/g, "-")}`;
        }
        const title = el("risk-hero-title");
        if (title) {
            title.textContent = lvl === "LOW" || lvl === "VERY_LOW" ? "Controlled Risk Profile"
                : lvl === "MODERATE" ? "Standard Market Volatility"
                    : lvl === "HIGH" ? "Elevated Risk Warning" : "CRITICAL RISK ALERT";
        }
        if (heroSummary) heroSummary.textContent = data.summary || "";
        const score = num(data.risk_score);
        const scoreEl = el("risk-score-number");
        if (scoreEl) scoreEl.innerHTML = scoreHtml(score);
        const bar = el("risk-meter-bar-fill");
        if (bar) {
            bar.style.width = `${Math.min(100, Math.max(5, score))}%`;
            bar.style.background = RISK_LEVEL_COLOR[lvl] || "var(--neg)";
        }

        const grid = el("risk-dimensions-grid");
        if (grid && data.dimensions) {
            const icons: Record<string, string> = {
                volatility: "fa-solid fa-wave-square",
                signal_conflict: "fa-solid fa-code-compare",
                consensus: "fa-solid fa-brain",
                analysis_quality: "fa-solid fa-shield-halved",
                data_quality: "fa-solid fa-database"
            };
            grid.innerHTML = Object.keys(icons)
                .map((key) => {
                    const d: Json = data.dimensions[key];
                    if (!d) return "";
                    const color = RISK_LEVEL_COLOR[d.level] || "var(--neg)";
                    return `
                    <div class="risk-dim-card">
                        <div class="risk-dim-header">
                            <div class="risk-dim-title"><i class="${icons[key]}" style="color:${color};"></i><span>${esc(d.name)}</span></div>
                            <span class="risk-dim-score" style="color:${color};">${num(d.score).toFixed(0)}/100</span>
                        </div>
                        <div class="risk-dim-summary">${esc(d.summary)}</div>
                    </div>`;
                })
                .join("");
        }
        const riskFactors: Json[] = data.risk_factors || [];
        const rfCount = el("risk-factors-count");
        if (rfCount) rfCount.textContent = String(riskFactors.length);
        const rfList = el("risk-factors-list");
        if (rfList) rfList.innerHTML = factorList(riskFactors, "risk-factor-item", "risk-factor-title", "fa-solid fa-triangle-exclamation",
            "✓ No active elevated risk warnings detected in current state.");
        const safety: Json[] = data.safety_factors || [];
        const sfCount = el("safety-factors-count");
        if (sfCount) sfCount.textContent = String(safety.length);
        const sfList = el("safety-factors-list");
        if (sfList) sfList.innerHTML = factorList(safety, "safety-factor-item", "safety-factor-title", "fa-solid fa-circle-check",
            "No specific stabilizing conditions identified.");

        const diag: Json = data.diagnostics || {};
        const latency = el("risk-diag-latency");
        if (latency) latency.textContent = `${num(diag.evaluation_latency_ms).toFixed(1)} ms`;
        const dims = el("risk-diag-dims");
        if (dims) dims.textContent = `${num(diag.dimensions_evaluated)}/5`;
    } catch (err) {
        if (heroSummary) heroSummary.innerHTML = `<span style="color:var(--neg);">Risk audit failed: ${esc(errorText(err))}</span>`;
        if (statusTag) {
            statusTag.textContent = "FAILED";
            statusTag.style.color = "var(--neg)";
        }
    }
}

// ==========================================================================
// 5. OPPORTUNITY MODAL
// ==========================================================================
export function openOpportunityModal(): void {
    if (show("opportunity-eval-modal")) refreshOpportunityModal();
}

export function closeOpportunityModal(): void {
    hide("opportunity-eval-modal");
}

export async function refreshOpportunityModal(): Promise<void> {
    const { asset, tf } = activeContext();
    const sub = el("opp-modal-subtitle");
    if (sub) sub.textContent = `Multi-System Confluence & Setup Quality Assessment on ${asset} (${tf})`;
    const heroSummary = el("opp-hero-summary");
    const statusTag = el("opp-status-tag");
    if (heroSummary) heroSummary.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i> Evaluating cross-pipeline confluence...`;

    try {
        const data: Json = await aiService.evaluateOpportunity(asset, tf);
        if (statusTag) {
            statusTag.textContent = data.status || "READY";
            statusTag.style.color = statusColor(data.status);
        }
        const lvl: string = data.opportunity_level || "MODERATE";
        const pill = el("opp-level-pill");
        if (pill) {
            pill.textContent = lvl.replace(/_/g, " ");
            pill.className = `opp-level-pill ${lvl.toLowerCase().replace(/_/g, "-")}`;
        }
        const bias: string = data.leading_bias || "NEUTRAL";
        const biasPill = el("opp-bias-pill");
        if (biasPill) {
            biasPill.textContent = bias;
            biasPill.className = `opp-bias-pill ${bias.toLowerCase()}`;
        }
        const title = el("opp-hero-title");
        if (title) {
            title.textContent = lvl === "VERY_HIGH" ? "Exceptional Multi-System Confluence"
                : lvl === "HIGH" ? "Strong Analytical Confluence"
                    : lvl === "MODERATE" ? "Balanced Setup Quality"
                        : lvl === "LOW" ? "Weak Confluence / High Friction" : "Minimal Trade Setup Opportunity";
        }
        if (heroSummary) heroSummary.textContent = data.summary || "";
        const score = num(data.opportunity_score);
        const scoreEl = el("opp-score-number");
        if (scoreEl) scoreEl.innerHTML = scoreHtml(score);
        const bar = el("opp-meter-bar-fill");
        if (bar) {
            bar.style.width = `${Math.min(100, Math.max(5, score))}%`;
            bar.style.background = lvl === "VERY_HIGH" || lvl === "HIGH" ? "var(--pos)" : lvl === "MODERATE" ? "#F59E0B" : lvl === "LOW" ? "#F97316" : "var(--neg)";
        }

        const grid = el("opp-dimensions-grid");
        if (grid && data.dimensions) {
            const icons: Record<string, string> = {
                consensus_quality: "fa-solid fa-brain",
                strategy_confluence: "fa-solid fa-layer-group",
                agent_harmony: "fa-solid fa-robot",
                risk_headroom: "fa-solid fa-shield-halved",
                analysis_completeness: "fa-solid fa-circle-check"
            };
            grid.innerHTML = Object.keys(icons)
                .map((key) => {
                    const d: Json = data.dimensions[key];
                    if (!d) return "";
                    const s = num(d.score);
                    const color = s >= 70 ? "var(--pos)" : s >= 50 ? "#06b6d4" : s >= 35 ? "#F59E0B" : "var(--neg)";
                    return `
                    <div class="opp-dim-card">
                        <div class="opp-dim-header">
                            <div class="opp-dim-title"><i class="${icons[key]}" style="color:${color};"></i><span>${esc(d.name)}</span></div>
                            <span class="opp-dim-score" style="color:${color};">${s.toFixed(0)}/100</span>
                        </div>
                        <div class="opp-dim-summary">${esc(d.summary)}</div>
                    </div>`;
                })
                .join("");
        }
        const strengths: Json[] = data.strength_factors || [];
        const stCount = el("opp-strength-count");
        if (stCount) stCount.textContent = String(strengths.length);
        const stList = el("opp-strength-list");
        if (stList) stList.innerHTML = factorList(strengths, "opp-factor-item booster", "opp-factor-title booster", "fa-solid fa-circle-check",
            "No strong confluence boosters detected in current market state.");
        const weaknesses: Json[] = data.weakness_factors || [];
        const wkCount = el("opp-weakness-count");
        if (wkCount) wkCount.textContent = String(weaknesses.length);
        const wkList = el("opp-weakness-list");
        if (wkList) wkList.innerHTML = factorList(weaknesses, "opp-factor-item headwind", "opp-factor-title headwind", "fa-solid fa-triangle-exclamation",
            "✓ Zero significant headwinds or frictions identified.");

        const diag: Json = data.diagnostics || {};
        const latency = el("opp-diag-latency");
        if (latency) latency.textContent = `${num(diag.evaluation_latency_ms).toFixed(2)} ms`;
        const totalEl = el("opp-diag-total");
        if (totalEl) totalEl.textContent = `${num(diag.total_pipeline_ms).toFixed(1)} ms`;
        const dims = el("opp-diag-dims");
        if (dims) dims.textContent = `${num(diag.dimensions_evaluated)}/5`;
    } catch (err) {
        if (heroSummary) heroSummary.innerHTML = `<span style="color:var(--neg);">Opportunity evaluation failed: ${esc(errorText(err))}</span>`;
        if (statusTag) {
            statusTag.textContent = "FAILED";
            statusTag.style.color = "var(--neg)";
        }
    }
}

// ==========================================================================
// 6. DECISION ENGINE MODAL
// ==========================================================================
export function openDecisionModal(): void {
    if (show("decision-eval-modal")) refreshDecisionModal();
}

export function closeDecisionModal(): void {
    hide("decision-eval-modal");
}

const STANCE_TITLE: Record<string, string> = {
    BULLISH: "Authoritative Bullish Market Stance",
    BEARISH: "Authoritative Bearish Market Stance",
    NEUTRAL: "Consolidation Equilibrium (Neutral)",
    MIXED: "Polar Volatility Deadlock (Mixed)",
    NO_CLEAR_DECISION: "Ambiguous Evidence (No Clear Stance)"
};

function clarityColor(clarity: string): string {
    return clarity === "CLEAR" ? "var(--pos)" : clarity === "MODERATE" ? "#38bdf8" : clarity === "UNCLEAR" ? "#f59e0b" : "var(--neg)";
}

function stanceBarColor(stance: string): string {
    return stance === "BULLISH" ? "var(--pos)" : stance === "BEARISH" ? "var(--neg)" : stance === "NEUTRAL" ? "#F59E0B" : "#A855F7";
}

function renderInputQuad(prefix: string, inSum: Json): void {
    const set = (id: string, text: string) => {
        const node = el(`${prefix}-${id}`);
        if (node) node.textContent = text;
    };
    set("consensus", inSum.consensus_signal || "--");
    set("consensus-sub", `Strength: ${num(inSum.consensus_strength).toFixed(0)} | Agreement: ${num(inSum.agreement_score).toFixed(0)}%`);
    set("risk", inSum.risk_level || "--");
    set("risk-sub", `Score: ${num(inSum.risk_score).toFixed(1)}/100`);
    set("opp", String(inSum.opportunity_level || "--").replace(/_/g, " "));
    set("opp-sub", `Confluence: ${num(inSum.opportunity_score).toFixed(1)}/100`);
    set("pipeline", `${num(inSum.completeness_score).toFixed(0)}%`);
    set("pipeline-sub", `Tier: ${inSum.completeness_tier || "--"}`);
}

export async function refreshDecisionModal(): Promise<void> {
    const { asset, tf } = activeContext();
    const sub = el("decision-modal-subtitle");
    if (sub) sub.textContent = `Evidence-Based Analytical Market Stance Synthesis on ${asset} (${tf})`;
    const heroSummary = el("decision-hero-summary");
    const statusTag = el("decision-status-tag");
    if (heroSummary) heroSummary.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i> Synthesizing market stance across consensus, opportunity and risk...`;

    try {
        const data: Json = await aiService.evaluateDecision(asset, tf);
        if (statusTag) {
            statusTag.textContent = data.status || "READY";
            statusTag.style.color = statusColor(data.status);
        }
        const stance: string = data.decision || "NEUTRAL";
        const badge = el("decision-stance-badge");
        if (badge) {
            badge.textContent = stance.replace(/_/g, " ");
            badge.className = `decision-stance-badge ${stance.toLowerCase().replace(/_/g, "-")}`;
        }
        const clarity: string = data.decision_clarity || "—";
        const clarityTag = el("decision-clarity-tag");
        if (clarityTag) {
            clarityTag.textContent = clarity;
            clarityTag.style.color = clarityColor(clarity);
        }
        const title = el("decision-hero-title");
        if (title) title.textContent = STANCE_TITLE[stance] || "Insufficient Market Intelligence";
        if (heroSummary) heroSummary.textContent = data.summary || "";
        const conf = num(data.decision_confidence);
        const confEl = el("decision-confidence-number");
        if (confEl) confEl.innerHTML = scoreHtml(conf);
        const bar = el("decision-meter-bar-fill");
        if (bar) {
            bar.style.width = `${Math.min(100, Math.max(5, conf))}%`;
            bar.style.background = stanceBarColor(stance);
        }
        renderInputQuad("dec-in", data.input_summary || {});

        const primary: Json[] = data.primary_evidence || [];
        const supporting: Json[] = data.supporting_evidence || [];
        const evCount = el("decision-evidence-count");
        if (evCount) evCount.textContent = String(primary.length + supporting.length);
        const evList = el("decision-evidence-list");
        if (evList) {
            evList.innerHTML = primary.length + supporting.length === 0
                ? `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">No active evidence items detected.</div>`
                : primary.map((e) => `<div class="decision-evidence-card"><i class="fa-solid fa-circle-check text-green" style="margin-top:2px;"></i><span><strong>Primary:</strong> ${esc(e)}</span></div>`).join("") +
                  supporting.map((e) => `<div class="decision-evidence-card" style="border-left-color:var(--cyan);background:rgba(6,182,212,0.04);"><i class="fa-solid fa-plus text-cyan" style="margin-top:2px;"></i><span><strong>Corroborating:</strong> ${esc(e)}</span></div>`).join("");
        }
        const constraints: Json[] = data.constraints || [];
        const conflicts: Json[] = data.conflicts || [];
        const cCount = el("decision-constraints-count");
        if (cCount) cCount.textContent = String(constraints.length + conflicts.length);
        const cList = el("decision-constraints-list");
        if (cList) {
            cList.innerHTML = constraints.length + conflicts.length === 0
                ? `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">✓ Zero active analytical constraints or conflicts detected.</div>`
                : conflicts.map((f) => `<div class="decision-conflict-card"><i class="fa-solid fa-triangle-exclamation text-red" style="margin-top:2px;"></i><span><strong>Conflict:</strong> ${esc(f)}</span></div>`).join("") +
                  constraints.map((c) => `<div class="decision-constraint-card"><i class="fa-solid fa-shield-halved text-yellow" style="margin-top:2px;"></i><span><strong>Constraint:</strong> ${esc(c)}</span></div>`).join("");
        }
        const diag: Json = data.diagnostics || {};
        const latency = el("dec-diag-latency");
        if (latency) latency.textContent = `${num(diag.decision_latency_ms).toFixed(2)} ms`;
        const totalEl = el("dec-diag-total");
        if (totalEl) totalEl.textContent = `${num(diag.total_latency_ms).toFixed(1)} ms`;
        const diagClarity = el("dec-diag-clarity");
        if (diagClarity) diagClarity.textContent = clarity;
    } catch (err) {
        if (heroSummary) heroSummary.innerHTML = `<span style="color:var(--neg);">Decision synthesis failed: ${esc(errorText(err))}</span>`;
        if (statusTag) {
            statusTag.textContent = "FAILED";
            statusTag.style.color = "var(--neg)";
        }
    }
}

// ==========================================================================
// 7. EXPLAINABILITY & INSIGHTS MODAL
// ==========================================================================
export function openExplainModal(): void {
    if (show("explain-eval-modal")) refreshExplainModal();
}

export function closeExplainModal(): void {
    hide("explain-eval-modal");
}

export async function refreshExplainModal(): Promise<void> {
    const { asset, tf } = activeContext();
    const sub = el("explain-modal-subtitle");
    if (sub) sub.textContent = `Institutional Explainability & Traceable Intelligence on ${asset} (${tf})`;
    const headline = el("explain-headline");
    const statusTag = el("explain-status-tag");
    if (headline) headline.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i> Synthesizing traceable insights...`;

    try {
        const data: Json = await aiService.evaluateExplanation(asset, tf);
        if (statusTag) {
            statusTag.textContent = data.status || "READY";
            statusTag.style.color = statusColor(data.status, "#22d3ee");
        }
        const stance: string = data.market_stance || "NEUTRAL";
        const badge = el("explain-stance-badge");
        if (badge) {
            badge.textContent = stance.replace(/_/g, " ");
            badge.className = `explain-stance-badge ${stance.toLowerCase().replace(/_/g, "-")}`;
        }
        const clarity: string = data.decision_clarity || "—";
        const clarityTag = el("explain-clarity-tag");
        if (clarityTag) {
            clarityTag.textContent = clarity;
            clarityTag.style.color = clarityColor(clarity);
        }
        const title = el("explain-hero-title");
        if (title) title.textContent = STANCE_TITLE[stance] ? STANCE_TITLE[stance].replace("Market Stance", "Explanation") : "Insufficient Market Intelligence";
        if (headline) headline.textContent = data.headline || "";
        const thesis = el("explain-thesis-list");
        if (thesis) {
            const why: Json[] = data.why || [];
            thesis.innerHTML = why.length ? why.map((w) => `<li>${esc(w)}</li>`).join("") : `<li>No thesis items were produced for this analysis.</li>`;
        }
        const conf = num(data.decision_confidence);
        const confEl = el("explain-confidence-number");
        if (confEl) confEl.innerHTML = scoreHtml(conf);
        const bar = el("explain-meter-bar-fill");
        if (bar) {
            bar.style.width = `${Math.min(100, Math.max(5, conf))}%`;
            bar.style.background = stanceBarColor(stance);
        }
        renderInputQuad("exp-in", data.input_summary || {});

        const primary: Json[] = data.primary_evidence || [];
        const supporting: Json[] = data.supporting_evidence || [];
        const all = [...primary, ...supporting];
        const evCount = el("explain-evidence-count");
        if (evCount) evCount.textContent = String(all.length);
        const evList = el("explain-evidence-list");
        if (evList) {
            evList.innerHTML = all.length === 0
                ? `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">No corroborating evidence items detected.</div>`
                : all.map((item) => {
                    const isPrimary = primary.includes(item);
                    const border = isPrimary ? "var(--pos)" : "var(--cyan)";
                    const tint = isPrimary ? "rgba(0, 230, 138, 0.04)" : "rgba(6, 182, 212, 0.04)";
                    return `
                    <div class="explain-evidence-card" style="border-left-color:${border};background:${tint};">
                        <div class="explain-evidence-card-header">
                            <div style="display:flex;align-items:center;gap:6px;">
                                <i class="fa-solid ${isPrimary ? "fa-circle-check text-green" : "fa-plus text-cyan"}"></i>
                                <span style="font-weight:700;font-size:10px;text-transform:uppercase;color:var(--text-1);">${isPrimary ? "PRIMARY EVIDENCE" : "SUPPORTING"}</span>
                            </div>
                            <span class="explain-source-badge">${esc(String(item.source || "UNKNOWN").replace(/_/g, " "))}</span>
                        </div>
                        <div style="color:var(--text-2);font-size:11px;line-height:1.45;">${esc(item.message)}</div>
                        <div style="display:flex;align-items:center;gap:8px;font-size:9.5px;color:var(--text-4);font-family:var(--font-mono);">
                            <span>Tag: ${esc(String(item.category || "").replace(/_/g, " "))}</span>
                            ${item.direction ? `<span>Dir: ${esc(item.direction)}</span>` : ""}
                        </div>
                    </div>`;
                }).join("");
        }
        const conflicts: Json[] = data.conflicts || [];
        const cfCount = el("explain-conflicts-count");
        if (cfCount) cfCount.textContent = String(conflicts.length);
        const cfList = el("explain-conflicts-list");
        if (cfList) {
            cfList.innerHTML = conflicts.length === 0
                ? `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">✓ Zero model conflicts or cross-system divergences detected.</div>`
                : conflicts.map((c) => {
                    const subs = (c.subsystems || []).map((s: string) => `<span class="explain-source-badge" style="background:rgba(239,68,68,0.1);color:#fca5a5;border-color:rgba(239,68,68,0.3);">${esc(String(s).replace(/_/g, " "))}</span>`).join(" ");
                    return `
                    <div class="explain-conflict-card">
                        <div class="explain-evidence-card-header">
                            <div style="display:flex;align-items:center;gap:6px;"><i class="fa-solid fa-triangle-exclamation text-red"></i><strong style="font-size:10.5px;color:#fca5a5;">${esc(c.title || "Conflict")}</strong></div>
                            <span class="explain-source-badge" style="color:var(--neg);">${esc(c.severity || "—")}</span>
                        </div>
                        <div style="color:var(--text-2);font-size:11px;line-height:1.45;">${esc(c.description)}</div>
                        ${subs ? `<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:2px;">${subs}</div>` : ""}
                    </div>`;
                }).join("");
        }
        const constraints: Json[] = data.risk_constraints || [];
        const uncertainties: Json[] = data.uncertainties || [];
        const rkCount = el("explain-risks-count");
        if (rkCount) rkCount.textContent = String(constraints.length + uncertainties.length);
        const rkList = el("explain-risks-list");
        if (rkList) {
            rkList.innerHTML = constraints.length + uncertainties.length === 0
                ? `<div style="font-size:11px;color:var(--text-4);font-style:italic;padding:8px 0;">✓ No active risk constraints or uncertainties limiting analysis.</div>`
                : constraints.map((rc) => `
                    <div class="explain-uncertainty-card" style="border-left-color:#EAB308;">
                        <div class="explain-evidence-card-header">
                            <div style="display:flex;align-items:center;gap:6px;"><i class="fa-solid fa-shield-halved text-yellow"></i><strong style="font-size:10.5px;color:#fde047;">Risk Constraint</strong></div>
                            <span class="explain-source-badge">${esc(String(rc.source || "RISK_GUARD").replace(/_/g, " "))}</span>
                        </div>
                        <div style="color:var(--text-2);font-size:11px;line-height:1.45;">${esc(rc.message)}</div>
                    </div>`).join("") +
                  uncertainties.map((un) => `
                    <div class="explain-uncertainty-card" style="border-left-color:#A855F7;background:rgba(168,85,247,0.04);">
                        <div class="explain-evidence-card-header">
                            <div style="display:flex;align-items:center;gap:6px;"><i class="fa-solid fa-circle-question text-purple"></i><strong style="font-size:10.5px;color:#d8b4fe;">${esc(un.category ? String(un.category).replace(/_/g, " ") : "Uncertainty")}</strong></div>
                            <span class="explain-source-badge" style="color:#d8b4fe;">${esc(String(un.source || "ORBIT_BRAIN").replace(/_/g, " "))}</span>
                        </div>
                        <div style="color:var(--text-2);font-size:11px;line-height:1.45;">${esc(un.description)}</div>
                    </div>`).join("");
        }
        const diag: Json = data.diagnostics || {};
        const set = (id: string, text: string) => {
            const node = el(id);
            if (node) node.textContent = text;
        };
        set("exp-diag-latency", `${num(diag.explain_latency_ms).toFixed(2)} ms`);
        set("exp-diag-dec-latency", `${num(diag.decision_latency_ms).toFixed(2)} ms`);
        set("exp-diag-total", `${num(diag.total_latency_ms).toFixed(1)} ms`);
    } catch (err) {
        if (headline) headline.innerHTML = `<span style="color:var(--neg);">Explainability synthesis failed: ${esc(errorText(err))}</span>`;
        if (statusTag) {
            statusTag.textContent = "FAILED";
            statusTag.style.color = "var(--neg)";
        }
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
