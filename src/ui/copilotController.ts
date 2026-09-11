/**
 * ORBIT Trading Terminal — AI Copilot Controller
 * The Copilot modal (terminal) and the dedicated Copilot tab. Answers and
 * context come from the ai-service, grounded in the ORBIT analysis pipeline;
 * conversation history is private to the signed-in account.
 */

import { aiService } from "../services/aiService";
import { marketService } from "../services/marketService";
import { store } from "../state/store";
import { esc, formatCopilotMarkdown, formatINRSafe } from "../utils/formatters";
import { getElement } from "../utils/dom";
import { ChatMessageRecord, ConversationItem } from "../types/copilot";

let _copilotConversationId: string | null = null;
let _copilotIsLoading = false;

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// ==========================================================================
// 1. FLOATING COPILOT MODAL
// ==========================================================================
export function openCopilotModal(): void {
    const modal = getElement("orbit-copilot-modal");
    if (!modal) return;
    modal.classList.remove("hidden");

    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";
    const badge = getElement("copilot-active-symbol-badge");
    if (badge) badge.textContent = `${asset} (${tf})`;
    const welcomeSym = getElement("copilot-welcome-symbol");
    if (welcomeSym) welcomeSym.textContent = asset;

    refreshCopilotContext(asset, tf);
    setTimeout(() => getElement<HTMLInputElement>("copilot-chat-input")?.focus(), 150);
}

export function closeCopilotModal(): void {
    getElement("orbit-copilot-modal")?.classList.add("hidden");
}

export async function refreshCopilotContext(asset?: string, tf?: string): Promise<void> {
    const symbol = asset || store.get("currentAsset") || "BTC-USD";
    const timeframe = tf || store.get("currentTimeframe") || "1d";
    try {
        const d = await aiService.getCopilotContext(symbol, timeframe);
        const stanceEl = getElement("copilot-tel-stance");
        if (stanceEl) {
            stanceEl.textContent = d.market_stance;
            stanceEl.className = `copilot-stance-tag ${(d.market_stance || "").toLowerCase().replace(/_/g, "-")}`;
        }
        const confEl = getElement("copilot-tel-confidence");
        if (confEl) confEl.textContent = `${Number(d.confidence || 0).toFixed(1)}%`;
        const riskEl = getElement("copilot-tel-risk");
        if (riskEl) riskEl.textContent = `${d.risk_level} (${Number(d.risk_score || 0).toFixed(0)})`;
        const oppEl = getElement("copilot-tel-opportunity");
        if (oppEl) oppEl.textContent = `${Number(d.opportunity_score || 0).toFixed(0)}/100`;
    } catch (e) {
        console.warn("[Copilot] Context telemetry unavailable:", e);
    }
}

export function askCopilotPreset(query: string): void {
    const input = getElement<HTMLInputElement>("copilot-chat-input");
    if (input) {
        input.value = query;
        sendCopilotMessage();
    }
}

export function clearCopilotChat(): void {
    if (_copilotConversationId) {
        aiService.resetCopilotSession(_copilotConversationId).catch(() => {});
    }
    _copilotConversationId = null;
    const stream = getElement("copilot-chat-stream");
    const asset = store.get("currentAsset") || "BTC-USD";
    if (stream) {
        stream.innerHTML = `
            <div class="copilot-msg-card copilot-assistant">
                <div class="copilot-msg-header">
                    <i class="fa-solid fa-robot text-green"></i>
                    <strong>ORBIT Copilot</strong>
                    <span class="copilot-msg-time">Reset</span>
                </div>
                <div class="copilot-msg-body">
                    Conversation reset. I am ready to answer questions about the active analysis for <strong>${esc(asset)}</strong>.
                </div>
            </div>`;
    }
}

export async function sendCopilotMessage(): Promise<void> {
    if (_copilotIsLoading) return;
    const input = getElement<HTMLInputElement>("copilot-chat-input");
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";

    const stream = getElement("copilot-chat-stream");
    const asset = store.get("currentAsset") || "BTC-USD";
    const tf = store.get("currentTimeframe") || "1d";

    if (stream) {
        const userCard = document.createElement("div");
        userCard.className = "copilot-msg-card copilot-user";
        userCard.innerHTML = `
            <div class="copilot-msg-header">
                <i class="fa-solid fa-user text-cyan"></i>
                <strong>You</strong>
                <span class="copilot-msg-time">${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            <div class="copilot-msg-body">${esc(text)}</div>`;
        stream.appendChild(userCard);
        const typingCard = document.createElement("div");
        typingCard.className = "copilot-typing-card";
        typingCard.id = "copilot-typing-indicator";
        typingCard.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i><span>ORBIT Copilot is reasoning over ${esc(asset)} analysis...</span>`;
        stream.appendChild(typingCard);
        stream.scrollTop = stream.scrollHeight;
    }

    _copilotIsLoading = true;
    const sendBtn = getElement<HTMLButtonElement>("copilot-send-btn");
    if (sendBtn) sendBtn.disabled = true;

    try {
        const d = await aiService.chatCopilot({
            message: text,
            symbol: asset,
            timeframe: tf,
            conversation_id: _copilotConversationId || undefined
        });
        getElement("copilot-typing-indicator")?.remove();
        _copilotConversationId = d.conversation_id;

        const card = document.createElement("div");
        card.className = "copilot-msg-card copilot-assistant";
        card.innerHTML = `
            <div class="copilot-msg-header">
                <i class="fa-solid fa-robot text-green"></i>
                <strong>ORBIT Copilot</strong>
                <span class="copilot-symbol-pill" style="font-size:9.5px;padding:1px 6px;">${esc(d.symbol)}</span>
                <span class="copilot-msg-time">${Number(d.latency_ms || 0).toFixed(0)} ms</span>
            </div>
            <div class="copilot-msg-body">${formatCopilotMarkdown(d.answer)}</div>`;
        if (stream) {
            stream.appendChild(card);
            stream.scrollTop = stream.scrollHeight;
        }
    } catch (err) {
        console.error("[Copilot] Chat error:", err);
        getElement("copilot-typing-indicator")?.remove();
        if (stream) {
            const errCard = document.createElement("div");
            errCard.className = "copilot-msg-card copilot-assistant";
            errCard.innerHTML = `
                <div class="copilot-msg-header">
                    <i class="fa-solid fa-triangle-exclamation text-red"></i>
                    <strong>ORBIT Copilot</strong>
                </div>
                <div class="copilot-msg-body text-red">Failed to communicate with AI Copilot: ${esc(errorText(err))}</div>`;
            stream.appendChild(errCard);
            stream.scrollTop = stream.scrollHeight;
        }
    } finally {
        _copilotIsLoading = false;
        if (sendBtn) sendBtn.disabled = false;
    }
}

// ==========================================================================
// 2. DEDICATED COPILOT TAB
// ==========================================================================

/** Shows the authoritative available balance (or "—" before it has loaded). */
export function syncCopilotBalance(): void {
    const balanceEl = getElement("copilot-account-balance");
    if (balanceEl) balanceEl.textContent = formatINRSafe(store.get("dashboardSummary")?.available_balance);
}

let _copilotPageSessionId: string | null = null;
let _copilotPageIsLoading = false;
let _copilotActiveAsset = "AAPL";
let _copilotActiveMarket = "US Stocks";
let _copilotActiveMode = "DETAILED";
let _copilotSearchTimer: number | undefined;
let _copilotLoadingInterval: number | undefined;

export async function loadConversationsList(): Promise<void> {
    const listEl = getElement("copilot-history-list");
    if (!listEl) return;
    try {
        const convs: ConversationItem[] = await aiService.listConversations(40);
        if (!convs.length) {
            listEl.innerHTML = `
                <div class="copilot-history-empty">
                    <i class="fa-regular fa-message" style="margin-bottom:6px;font-size:18px;opacity:0.5;"></i>
                    <p style="margin:0;">No previous analyses.</p>
                </div>`;
            return;
        }
        const now = new Date();
        const todayStr = now.toDateString();
        const yest = new Date(now);
        yest.setDate(yest.getDate() - 1);
        const yestStr = yest.toDateString();
        const groups: { today: ConversationItem[]; yesterday: ConversationItem[]; older: ConversationItem[] } = { today: [], yesterday: [], older: [] };
        convs.forEach((c) => {
            const dStr = new Date(c.updated_at || c.created_at).toDateString();
            if (dStr === todayStr) groups.today.push(c);
            else if (dStr === yestStr) groups.yesterday.push(c);
            else groups.older.push(c);
        });
        const renderGroup = (title: string, items: ConversationItem[]) => !items.length ? "" : `
            <div class="copilot-history-group">
                <div class="copilot-history-group-title">${title}</div>
                ${items.map((c) => {
                    const sym = c.selected_asset || "ASSET";
                    const cleanTitle = esc(c.title || `${sym} Analysis`);
                    const id = esc(c.id);
                    return `
                    <div class="copilot-history-item ${c.id === _copilotPageSessionId ? "active" : ""}" onclick="selectConversation('${id}')" title="${cleanTitle}">
                        <div class="copilot-history-item-content">
                            <div class="copilot-history-title">${cleanTitle}</div>
                            <div class="copilot-history-meta">
                                <span class="copilot-history-badge">${esc(sym)}</span>
                                <span>${esc(c.selected_market || "Market")}</span>
                            </div>
                        </div>
                        <button class="copilot-history-delete-btn" onclick="deleteConversationClick(event, '${id}')" title="Delete conversation">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>`;
                }).join("")}
            </div>`;
        listEl.innerHTML = renderGroup("TODAY", groups.today) + renderGroup("YESTERDAY", groups.yesterday) + renderGroup("OLDER", groups.older);
    } catch (err) {
        console.warn("[Copilot] Error loading conversations:", err);
    }
}

export async function selectConversation(convId: string): Promise<void> {
    if (!convId) return;
    try {
        const detail = await aiService.getConversation(convId);
        _copilotPageSessionId = detail.conversation.id;
        if (detail.conversation.selected_asset) _copilotActiveAsset = detail.conversation.selected_asset;
        if (detail.conversation.selected_market) {
            _copilotActiveMarket = detail.conversation.selected_market;
            const mktSelect = getElement<HTMLSelectElement>("copilot-market-select");
            if (mktSelect) mktSelect.value = _copilotActiveMarket;
        }
        updateActiveAssetBanner(_copilotActiveAsset, _copilotActiveMarket);

        const messagesBox = getElement("copilot-page-messages");
        if (messagesBox) {
            messagesBox.innerHTML = "";
            detail.messages.forEach((m: ChatMessageRecord) => {
                const isUser = m.role === "user";
                const card = document.createElement("div");
                card.className = `copilot-page-msg-card ${isUser ? "user" : "orbit"}`;
                const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : "";
                card.innerHTML = `
                    <div class="copilot-page-msg-header">
                        <i class="fa-solid ${isUser ? "fa-user" : "fa-robot text-emerald"}"></i>
                        <strong>${isUser ? "You" : "ORBIT Copilot"}</strong>
                        ${timeStr ? `<span>&bull; ${esc(timeStr)}</span>` : ""}
                    </div>
                    <div class="copilot-page-msg-body">${isUser ? esc(m.content) : formatCopilotMarkdown(m.content)}</div>`;
                messagesBox.appendChild(card);
            });
            messagesBox.scrollTop = messagesBox.scrollHeight;
        }
        syncCopilotPageView();
        loadConversationsList();
    } catch (err) {
        console.warn("[Copilot] Error selecting conversation:", err);
    }
}

export function createNewAnalysis(): void {
    _copilotPageSessionId = null;
    const messagesBox = getElement("copilot-page-messages");
    if (messagesBox) messagesBox.innerHTML = "";
    syncCopilotPageView();
    loadConversationsList();
    getElement<HTMLInputElement>("copilot-page-input")?.focus();
}

export function toggleCopilotSidebar(): void {
    const sidebar = document.querySelector(".copilot-history-sidebar");
    const container = document.querySelector(".copilot-terminal-container");
    const openBtn = getElement("copilot-sidebar-open-tab");
    if (!sidebar || !container) return;
    const isCollapsed = sidebar.classList.toggle("collapsed");
    container.classList.toggle("sidebar-collapsed", isCollapsed);
    if (openBtn) openBtn.classList.toggle("hidden", !isCollapsed);
}

export async function deleteConversationClick(event: Event, convId: string): Promise<void> {
    if (event) event.stopPropagation();
    if (!convId) return;
    try {
        await aiService.deleteConversation(convId);
        if (_copilotPageSessionId === convId) createNewAnalysis();
        else loadConversationsList();
    } catch (err) {
        console.warn("[Copilot] Delete conversation error:", err);
    }
}

export function onCopilotMarketChange(marketVal: string): void {
    _copilotActiveMarket = marketVal;
    updateActiveAssetBanner(_copilotActiveAsset, marketVal);
    const searchInput = getElement<HTMLInputElement>("copilot-asset-search");
    if (searchInput) searchInput.placeholder = `Search in ${marketVal}...`;
}

function updateActiveAssetBanner(sym: string, market: string, name?: string): void {
    const titleEl = getElement("copilot-active-asset-title");
    const exchEl = getElement("copilot-active-asset-exchange");
    const symBadge = getElement("copilot-page-symbol");
    if (titleEl) titleEl.innerHTML = `${esc(sym)} &bull; <span>${esc(name || sym)}</span>`;
    if (exchEl) exchEl.textContent = market || _copilotActiveMarket;
    if (symBadge) symBadge.textContent = sym;
}

export function onAssetSearchInput(query: string): void {
    window.clearTimeout(_copilotSearchTimer);
    const dropdown = getElement("copilot-search-dropdown");
    if (!dropdown) return;
    const q = query.trim();
    if (!q) {
        dropdown.classList.add("hidden");
        dropdown.innerHTML = "";
        return;
    }
    dropdown.classList.remove("hidden");
    dropdown.innerHTML = `<div class="copilot-search-loading"><i class="fa-solid fa-spinner fa-spin"></i> Searching ${esc(_copilotActiveMarket)}...</div>`;
    _copilotSearchTimer = window.setTimeout(async () => {
        try {
            const results = await marketService.searchSymbols(q, _copilotActiveMarket);
            if (!results.length) {
                dropdown.innerHTML = `<div class="copilot-search-empty">No matching assets found</div>`;
                return;
            }
            dropdown.innerHTML = results.slice(0, 8).map((r) => `
                <div class="copilot-search-item" onclick="selectAsset('${esc(r.symbol)}', '${esc(r.name)}', '${esc(r.exchange || "")}')">
                    <div class="copilot-search-item-left">
                        <span class="copilot-search-item-sym">${esc(r.symbol)}</span>
                        <span class="copilot-search-item-name">${esc(r.name)}</span>
                    </div>
                    <div class="copilot-search-item-right">${esc(r.exchange || r.type || "")}</div>
                </div>`).join("");
        } catch {
            dropdown.innerHTML = `<div class="copilot-search-empty text-ruby">Search temporarily unavailable</div>`;
        }
    }, 280);
}

export function selectAsset(symbol: string, name?: string, exchange?: string): void {
    _copilotActiveAsset = symbol.trim().toUpperCase();
    if (exchange) _copilotActiveMarket = exchange;
    updateActiveAssetBanner(_copilotActiveAsset, exchange || _copilotActiveMarket, name);
    getElement("copilot-search-dropdown")?.classList.add("hidden");
    const searchInput = getElement<HTMLInputElement>("copilot-asset-search");
    if (searchInput) searchInput.value = "";
    syncCopilotPageView();
}

export function setResponseMode(mode: string): void {
    _copilotActiveMode = mode;
    document.querySelectorAll(".copilot-mode-btn").forEach((b) => b.classList.toggle("active", b.getAttribute("data-mode") === mode));
}

export async function syncCopilotPageView(): Promise<void> {
    const statusBadge = getElement("copilot-page-analysis-status");
    const stanceEl = getElement("copilot-page-stance");
    const confEl = getElement("copilot-page-confidence");
    const riskEl = getElement("copilot-page-risk");
    const oppEl = getElement("copilot-page-opportunity");
    const setupsEl = getElement("copilot-page-setups");
    const messagesBox = getElement("copilot-page-messages");

    syncCopilotBalance();
    const activeSym = _copilotActiveAsset || store.get("currentAsset") || "AAPL";
    _copilotActiveAsset = activeSym;
    const symBadge = getElement("copilot-page-symbol");
    if (symBadge) symBadge.textContent = activeSym;

    try {
        const d = await aiService.getCopilotContext(activeSym, store.get("currentTimeframe") || "1d");
        if (statusBadge) {
            statusBadge.className = "copilot-status-badge live";
            statusBadge.innerHTML = '<span class="copilot-status-pulse"></span> Pipeline Live';
        }
        if (stanceEl) {
            stanceEl.textContent = d.market_stance;
            stanceEl.className = `copilot-metric-pill stance-${(d.market_stance || "").toLowerCase()}`;
        }
        if (confEl) confEl.textContent = `${Number(d.confidence || 0).toFixed(1)}%`;
        if (riskEl) {
            riskEl.textContent = `${d.risk_level} (${Number(d.risk_score || 0).toFixed(0)})`;
            riskEl.className = `copilot-metric-pill risk-${(d.risk_level || "").toLowerCase()}`;
        }
        if (oppEl) {
            oppEl.textContent = `${Number(d.opportunity_score || 0).toFixed(0)}/100`;
            oppEl.className = `copilot-metric-pill opp-${(d.opportunity_level || "").toLowerCase()}`;
        }
        // The context endpoint reports decision clarity, not a setup count.
        if (setupsEl) setupsEl.textContent = d.clarity || "—";

        if (messagesBox && messagesBox.childElementCount === 0) {
            const welcome = document.createElement("div");
            welcome.className = "copilot-page-msg-card orbit";
            welcome.innerHTML = `
                <div class="copilot-page-msg-header">
                    <i class="fa-solid fa-robot text-emerald"></i>
                    <strong>ORBIT Copilot</strong>
                    <span>&bull; ${esc(activeSym)} Context Active</span>
                </div>
                <div class="copilot-page-msg-body">
                    <p>Connected to <strong>${esc(activeSym)}</strong> in <strong>${esc(_copilotActiveMarket)}</strong> through the ORBIT analysis pipeline.</p>
                    <p>${esc(d.headline || "")}</p>
                    <p>Current Stance: <strong>${esc(d.market_stance)}</strong> (${Number(d.confidence).toFixed(1)}% confidence).
                    Risk is <strong>${esc(d.risk_level)}</strong> (${Number(d.risk_score).toFixed(1)}/100) and Opportunity is <strong>${Number(d.opportunity_score).toFixed(1)}/100</strong>.</p>
                </div>`;
            messagesBox.appendChild(welcome);
        }
    } catch (err) {
        if (statusBadge) {
            statusBadge.className = "copilot-status-badge not-available";
            statusBadge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${esc(errorText(err)).slice(0, 80) || "Unavailable"}`;
        }
    }
}

export async function sendCopilotPageMessage(): Promise<void> {
    if (_copilotPageIsLoading) return;
    const input = getElement<HTMLInputElement>("copilot-page-input");
    const sendBtn = getElement<HTMLButtonElement>("copilot-page-send-btn");
    const loadingBar = getElement("copilot-page-loading");
    const loadingText = getElement("copilot-loading-text");
    const errorBanner = getElement("copilot-page-error");
    const messagesBox = getElement("copilot-page-messages");

    const message = input ? input.value.trim() : "";
    if (!message) return;
    const activeSym = _copilotActiveAsset || "AAPL";

    if (messagesBox) {
        const userCard = document.createElement("div");
        userCard.className = "copilot-page-msg-card user";
        userCard.innerHTML = `
            <div class="copilot-page-msg-header">
                <i class="fa-solid fa-user"></i>
                <strong>You</strong>
                <span>&bull; ${new Date().toLocaleTimeString()}</span>
            </div>
            <div class="copilot-page-msg-body">${esc(message)}</div>`;
        messagesBox.appendChild(userCard);
        messagesBox.scrollTop = messagesBox.scrollHeight;
    }
    if (input) input.value = "";
    if (sendBtn) sendBtn.disabled = true;
    if (loadingBar) loadingBar.classList.remove("hidden");
    if (errorBanner) errorBanner.classList.add("hidden");
    _copilotPageIsLoading = true;

    const stages = [
        "Loading market data...",
        "Running agents & strategies...",
        "Evaluating risk guard & consensus...",
        "Generating ORBIT analytical view..."
    ];
    let stageIdx = 0;
    if (loadingText) loadingText.textContent = stages[0];
    window.clearInterval(_copilotLoadingInterval);
    _copilotLoadingInterval = window.setInterval(() => {
        stageIdx = (stageIdx + 1) % stages.length;
        if (loadingText) loadingText.textContent = stages[stageIdx];
    }, 1500);

    try {
        const d = await aiService.chatCopilot({
            message,
            symbol: activeSym,
            selected_asset: activeSym,
            selected_market: _copilotActiveMarket,
            timeframe: store.get("currentTimeframe") || "1d",
            conversation_id: _copilotPageSessionId || undefined,
            response_mode: _copilotActiveMode
        });
        window.clearInterval(_copilotLoadingInterval);
        if (loadingBar) loadingBar.classList.add("hidden");
        _copilotPageSessionId = d.conversation_id;

        if (messagesBox) {
            const card = document.createElement("div");
            card.className = "copilot-page-msg-card orbit";
            card.innerHTML = `
                <div class="copilot-page-msg-header">
                    <i class="fa-solid fa-robot text-emerald"></i>
                    <strong>ORBIT Copilot</strong>
                    ${d.latency_ms ? `<span>&bull; ${Number(d.latency_ms).toFixed(0)}ms</span>` : ""}
                </div>
                <div class="copilot-page-msg-body">${formatCopilotMarkdown(d.answer)}</div>`;
            messagesBox.appendChild(card);
            messagesBox.scrollTop = messagesBox.scrollHeight;
        }
        loadConversationsList();
    } catch (err) {
        window.clearInterval(_copilotLoadingInterval);
        if (loadingBar) loadingBar.classList.add("hidden");
        if (errorBanner) {
            const errMsg = getElement("copilot-page-error-msg");
            if (errMsg) errMsg.textContent = `ORBIT Copilot notice: ${errorText(err)}`;
            errorBanner.classList.remove("hidden");
        }
    } finally {
        _copilotPageIsLoading = false;
        if (sendBtn) sendBtn.disabled = false;
    }
}

export function askCopilotPagePreset(query: string): void {
    const input = getElement<HTMLInputElement>("copilot-page-input");
    if (input) {
        input.value = query;
        sendCopilotPageMessage();
    }
}

export function clearCopilotPageChat(): void {
    if (_copilotPageSessionId) aiService.resetCopilotSession(_copilotPageSessionId).catch(() => {});
    createNewAnalysis();
}
