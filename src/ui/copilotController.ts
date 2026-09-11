/**
 * ORBIT Trading Terminal — AI Copilot Controller
 * Manages Copilot Modal, Dedicated Copilot Tab, Telemetry Syncer, and Natural Language Stream
 */

import { aiService } from "../services/aiService";
import { store } from "../state/store";
import { esc, formatCopilotMarkdown } from "../utils/formatters";
import { getElement } from "../utils/dom";

let _copilotConversationId: string | null = null;
let _copilotIsLoading = false;

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

    setTimeout(() => {
        const input = getElement<HTMLInputElement>("copilot-chat-input");
        if (input) input.focus();
    }, 150);
}

export function closeCopilotModal(): void {
    const modal = getElement("orbit-copilot-modal");
    if (modal) modal.classList.add("hidden");
}

export async function refreshCopilotContext(asset?: string, tf?: string): Promise<void> {
    const symbol = asset || store.get("currentAsset") || "BTC-USD";
    const timeframe = tf || store.get("currentTimeframe") || "1d";

    try {
        const d = await aiService.getCopilotContext(symbol, timeframe);
        const stanceEl = getElement("copilot-tel-stance");
        if (stanceEl) {
            stanceEl.textContent = d.decision_stance;
            stanceEl.className = `copilot-stance-tag ${(d.decision_stance || "").toLowerCase().replace(/_/g, "-")}`;
        }
        const confEl = getElement("copilot-tel-confidence");
        if (confEl) confEl.textContent = `${(d.confidence || 0).toFixed(1)}%`;
        const riskEl = getElement("copilot-tel-risk");
        if (riskEl) riskEl.textContent = `${d.risk_level} (${(d.risk_score || 0).toFixed(0)})`;
        const oppEl = getElement("copilot-tel-opportunity");
        if (oppEl) oppEl.textContent = `${(d.opportunity_score || 0).toFixed(0)}/100`;
    } catch (e) {
        console.warn("[Copilot] Error loading context telemetry:", e);
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
            </div>
        `;
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

    // 1. Append User Message Bubble
    if (stream) {
        const userCard = document.createElement("div");
        userCard.className = "copilot-msg-card copilot-user";
        userCard.innerHTML = `
            <div class="copilot-msg-header">
                <i class="fa-solid fa-user text-cyan"></i>
                <strong>You</strong>
                <span class="copilot-msg-time">${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            <div class="copilot-msg-body">${esc(text)}</div>
        `;
        stream.appendChild(userCard);

        // 2. Append Loading Typing Indicator
        const typingCard = document.createElement("div");
        typingCard.className = "copilot-typing-card";
        typingCard.id = "copilot-typing-indicator";
        typingCard.innerHTML = `
            <i class="fa-solid fa-circle-notch fa-spin"></i>
            <span>ORBIT Copilot is reasoning over ${esc(asset)} analysis...</span>
        `;
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
            session_id: _copilotConversationId || undefined
        });

        const indicator = getElement("copilot-typing-indicator");
        if (indicator) indicator.remove();

        _copilotConversationId = d.session_id;
        const formattedAnswer = formatCopilotMarkdown(d.reply);

        const asstCard = document.createElement("div");
        asstCard.className = "copilot-msg-card copilot-assistant";
        asstCard.innerHTML = `
            <div class="copilot-msg-header">
                <i class="fa-solid fa-robot text-green"></i>
                <strong>ORBIT Copilot</strong>
                <span class="copilot-symbol-pill" style="font-size:9.5px;padding:1px 6px;">${esc(d.symbol)}</span>
                <span class="copilot-msg-time">${(d.latency_ms || 0).toFixed(0)} ms</span>
            </div>
            <div class="copilot-msg-body">${formattedAnswer}</div>
        `;
        if (stream) {
            stream.appendChild(asstCard);
            stream.scrollTop = stream.scrollHeight;
        }
    } catch (err: any) {
        console.error("[Copilot] Chat error:", err);
        const indicator = getElement("copilot-typing-indicator");
        if (indicator) indicator.remove();
        if (stream) {
            const errCard = document.createElement("div");
            errCard.className = "copilot-msg-card copilot-assistant";
            errCard.innerHTML = `
                <div class="copilot-msg-header">
                    <i class="fa-solid fa-triangle-exclamation text-red"></i>
                    <strong>ORBIT Copilot</strong>
                </div>
                <div class="copilot-msg-body text-red">Failed to communicate with AI Copilot: ${esc(err.message)}</div>
            `;
            stream.appendChild(errCard);
            stream.scrollTop = stream.scrollHeight;
        }
    } finally {
        _copilotIsLoading = false;
        if (sendBtn) sendBtn.disabled = false;
    }
}

// ==========================================================================
// 2. DEDICATED COPILOT TAB CONTROLLER
// ==========================================================================
export function syncCopilotBalance(): void {
    const balanceEl = getElement("copilot-account-balance");
    const walletEl = getElement("wallet-balance");
    const overviewEl = getElement("overview-balance");
    if (balanceEl) {
        if (walletEl && walletEl.textContent?.trim()) {
            balanceEl.textContent = walletEl.textContent.replace("INR", "").trim();
        } else if (overviewEl && overviewEl.textContent?.trim()) {
            balanceEl.textContent = overviewEl.textContent.replace("INR", "").trim();
        } else {
            balanceEl.textContent = "₹10,00,000.00";
        }
    }
}

let _copilotPageSessionId: string | null = null;
let _copilotPageIsLoading = false;
let _copilotActiveAsset = "AAPL";
let _copilotActiveMarket = "US Stocks";
let _copilotActiveMode = "DETAILED";
let _copilotSearchTimer: any = null;
let _copilotLoadingInterval: any = null;

export async function loadConversationsList(): Promise<void> {
    const listEl = getElement("copilot-history-list");
    if (!listEl) return;

    try {
        const res = await fetch("/api/chat/conversations?limit=40");
        if (!res.ok) throw new Error("Failed to load conversations");
        const json = await res.json();
        const convs: any[] = json.data || [];

        if (convs.length === 0) {
            listEl.innerHTML = `
                <div class="copilot-history-empty">
                    <i class="fa-regular fa-message" style="margin-bottom:6px;font-size:18px;opacity:0.5;"></i>
                    <p style="margin:0;">No previous analyses.</p>
                </div>
            `;
            return;
        }

        const now = new Date();
        const todayStr = now.toDateString();
        const yest = new Date(now);
        yest.setDate(yest.getDate() - 1);
        const yestStr = yest.toDateString();

        const groups: { today: any[]; yesterday: any[]; older: any[] } = {
            today: [],
            yesterday: [],
            older: []
        };

        convs.forEach((c) => {
            const d = new Date(c.updated_at || c.created_at);
            const dStr = d.toDateString();
            if (dStr === todayStr) {
                groups.today.push(c);
            } else if (dStr === yestStr) {
                groups.yesterday.push(c);
            } else {
                groups.older.push(c);
            }
        });

        let html = "";
        const renderGroup = (title: string, items: any[]) => {
            if (!items || items.length === 0) return "";
            return `
                <div class="copilot-history-group">
                    <div class="copilot-history-group-title">${title}</div>
                    ${items
                        .map((c) => {
                            const isActive = c.id === _copilotPageSessionId;
                            const sym = c.selected_asset || "ASSET";
                            const cleanTitle = esc(c.title || `${sym} Analysis`);
                            return `
                                <div class="copilot-history-item ${isActive ? "active" : ""}" onclick="selectConversation('${c.id}')" title="${cleanTitle}">
                                    <div class="copilot-history-item-content">
                                        <div class="copilot-history-title">${cleanTitle}</div>
                                        <div class="copilot-history-meta">
                                            <span class="copilot-history-badge">${esc(sym)}</span>
                                            <span>${esc(c.selected_market || "Market")}</span>
                                        </div>
                                    </div>
                                    <button class="copilot-history-delete-btn" onclick="deleteConversationClick(event, '${c.id}')" title="Delete conversation">
                                        <i class="fa-solid fa-trash-can"></i>
                                    </button>
                                </div>
                            `;
                        })
                        .join("")}
                </div>
            `;
        };

        html += renderGroup("TODAY", groups.today);
        html += renderGroup("YESTERDAY", groups.yesterday);
        html += renderGroup("OLDER", groups.older);

        listEl.innerHTML = html;
    } catch (err) {
        console.warn("[Copilot] Error loading conversations:", err);
    }
}

export async function selectConversation(convId: string): Promise<void> {
    if (!convId) return;
    _copilotPageSessionId = convId;

    try {
        const res = await fetch(`/api/chat/conversations/${convId}`);
        if (!res.ok) throw new Error("Conversation not found");
        const json = await res.json();
        const conversation = json.data;
        const messages = conversation.messages || [];

        if (conversation.selected_asset) {
            _copilotActiveAsset = conversation.selected_asset;
        }
        if (conversation.selected_market) {
            _copilotActiveMarket = conversation.selected_market;
            const mktSelect = getElement<HTMLSelectElement>("copilot-market-select");
            if (mktSelect) mktSelect.value = _copilotActiveMarket;
        }

        updateActiveAssetBanner(_copilotActiveAsset, _copilotActiveMarket);

        const messagesBox = getElement("copilot-page-messages");
        if (messagesBox) {
            messagesBox.innerHTML = "";
            if (messages.length > 0) {
                messages.forEach((m: any) => {
                    const isUser = m.role === "user";
                    const card = document.createElement("div");
                    card.className = `copilot-page-msg-card ${isUser ? "user" : "orbit"}`;
                    const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : "";
                    card.innerHTML = `
                        <div class="copilot-page-msg-header">
                            <i class="fa-solid ${isUser ? "fa-user" : "fa-robot text-emerald"}"></i>
                            <strong>${isUser ? "You" : "ORBIT Copilot"}</strong>
                            ${timeStr ? `<span>&bull; ${timeStr}</span>` : ""}
                        </div>
                        <div class="copilot-page-msg-body">${isUser ? esc(m.content) : formatCopilotMarkdown(m.content)}</div>
                    `;
                    messagesBox.appendChild(card);
                });
                messagesBox.scrollTop = messagesBox.scrollHeight;
            }
        }

        syncCopilotPageView();
        loadConversationsList();
    } catch (err) {
        console.warn("Error selecting conversation:", err);
    }
}

export function createNewAnalysis(): void {
    _copilotPageSessionId = null;
    const messagesBox = getElement("copilot-page-messages");
    if (messagesBox) messagesBox.innerHTML = "";
    syncCopilotPageView();
    loadConversationsList();
    const input = getElement<HTMLInputElement>("copilot-page-input");
    if (input) input.focus();
}

export function toggleCopilotSidebar(): void {
    const sidebar = document.querySelector(".copilot-history-sidebar");
    const container = document.querySelector(".copilot-terminal-container");
    const openBtn = getElement("copilot-sidebar-open-tab");
    if (!sidebar || !container) return;

    const isCollapsed = sidebar.classList.toggle("collapsed");
    container.classList.toggle("sidebar-collapsed", isCollapsed);
    if (openBtn) {
        if (isCollapsed) {
            openBtn.classList.remove("hidden");
        } else {
            openBtn.classList.add("hidden");
        }
    }
}

export async function deleteConversationClick(event: Event, convId: string): Promise<void> {
    if (event) event.stopPropagation();
    if (!convId) return;

    try {
        await fetch(`/api/chat/conversations/${convId}`, { method: "DELETE" });
        if (_copilotPageSessionId === convId) {
            createNewAnalysis();
        } else {
            loadConversationsList();
        }
    } catch (err) {
        console.warn("Delete conversation error:", err);
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
    if (exchEl) exchEl.textContent = `${esc(market || _copilotActiveMarket)}`;
    if (symBadge) symBadge.textContent = esc(sym);
}

export function onAssetSearchInput(query: string): void {
    clearTimeout(_copilotSearchTimer);
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

    _copilotSearchTimer = setTimeout(async () => {
        try {
            const url = `/api/market/search?q=${encodeURIComponent(q)}&market=${encodeURIComponent(_copilotActiveMarket)}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error("Search failed");
            const json = await res.json();
            const results = (json.data && json.data.results) || json.results || (Array.isArray(json.data) ? json.data : []) || [];

            if (results.length === 0) {
                dropdown.innerHTML = `<div class="copilot-search-empty">No matching assets found</div>`;
                return;
            }

            dropdown.innerHTML = results
                .slice(0, 8)
                .map(
                    (r: any) => `
                <div class="copilot-search-item" onclick="selectAsset('${esc(r.symbol)}', '${esc(r.name)}', '${esc(r.exchange)}')">
                    <div class="copilot-search-item-left">
                        <span class="copilot-search-item-sym">${esc(r.symbol)}</span>
                        <span class="copilot-search-item-name">${esc(r.name)}</span>
                    </div>
                    <div class="copilot-search-item-right">${esc(r.exchange || r.type)}</div>
                </div>
            `
                )
                .join("");
        } catch {
            dropdown.innerHTML = `<div class="copilot-search-empty text-ruby">Search temporarily unavailable</div>`;
        }
    }, 280);
}

export function selectAsset(symbol: string, name?: string, exchange?: string): void {
    _copilotActiveAsset = symbol.trim().toUpperCase();
    if (exchange) _copilotActiveMarket = exchange;
    updateActiveAssetBanner(_copilotActiveAsset, exchange || _copilotActiveMarket, name);

    const dropdown = getElement("copilot-search-dropdown");
    if (dropdown) dropdown.classList.add("hidden");
    const searchInput = getElement<HTMLInputElement>("copilot-asset-search");
    if (searchInput) searchInput.value = "";

    syncCopilotPageView();
}

export function setResponseMode(mode: string): void {
    _copilotActiveMode = mode;
    const btns = document.querySelectorAll(".copilot-mode-btn");
    btns.forEach((b) => {
        if (b.getAttribute("data-mode") === mode) {
            b.classList.add("active");
        } else {
            b.classList.remove("active");
        }
    });
}

export async function syncCopilotPageView(): Promise<void> {
    const symBadge = getElement("copilot-page-symbol");
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

    if (symBadge) symBadge.textContent = esc(activeSym);

    try {
        const tf = store.get("currentTimeframe") || "1d";
        const d = await aiService.getCopilotContext(activeSym, tf);

        if (statusBadge) {
            statusBadge.className = "copilot-status-badge live";
            statusBadge.innerHTML = '<span class="copilot-status-pulse"></span> Pipeline Live';
        }
        if (stanceEl) {
            stanceEl.textContent = d.decision_stance || "NEUTRAL";
            stanceEl.className = `copilot-metric-pill stance-${(d.decision_stance || "").toLowerCase()}`;
        }
        if (confEl) confEl.textContent = `${Number(d.confidence || 0).toFixed(1)}%`;
        if (riskEl) {
            riskEl.textContent = `${d.risk_level || "MODERATE"} (${Number(d.risk_score || 0).toFixed(0)})`;
            riskEl.className = `copilot-metric-pill risk-${(d.risk_level || "").toLowerCase()}`;
        }
        if (oppEl) {
            oppEl.textContent = `${Number(d.opportunity_score || 0).toFixed(0)}/100`;
            oppEl.className = `copilot-metric-pill opp-${(d.opportunity_level || "").toLowerCase()}`;
        }
        if (setupsEl) {
            const count = d.active_setups?.length || 0;
            setupsEl.textContent = `${count} Active`;
        }

        if (messagesBox && messagesBox.childElementCount === 0) {
            const welcomeCard = document.createElement("div");
            welcomeCard.className = "copilot-page-msg-card orbit";
            welcomeCard.innerHTML = `
                <div class="copilot-page-msg-header">
                    <i class="fa-solid fa-robot text-emerald"></i>
                    <strong>ORBIT Copilot</strong>
                    <span>&bull; ${activeSym} Context Active</span>
                </div>
                <div class="copilot-page-msg-body">
                    <p>Connected to <strong>${esc(activeSym)}</strong> in <strong>${esc(_copilotActiveMarket)}</strong> via Alpha Vantage and ORBIT analytical pipeline.</p>
                    <p>Current Stance: <strong>${d.decision_stance}</strong> (${Number(d.confidence).toFixed(1)}% Confidence).<br>
                    Analytical Risk is <strong>${d.risk_level}</strong> (${Number(d.risk_score).toFixed(1)}/100) and Opportunity is <strong>${Number(d.opportunity_score).toFixed(1)}/100</strong>.</p>
                    <p>Ask any question about <strong>${esc(activeSym)}</strong> or choose a suggested question above.</p>
                </div>
            `;
            messagesBox.appendChild(welcomeCard);
        }
    } catch {
        if (statusBadge) {
            statusBadge.className = "copilot-status-badge not-available";
            statusBadge.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Ready';
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
            <div class="copilot-page-msg-body">${esc(message)}</div>
        `;
        messagesBox.appendChild(userCard);
        messagesBox.scrollTop = messagesBox.scrollHeight;
    }

    if (input) input.value = "";
    if (sendBtn) sendBtn.disabled = true;
    if (loadingBar) loadingBar.classList.remove("hidden");
    if (errorBanner) errorBanner.classList.add("hidden");
    _copilotPageIsLoading = true;

    const stages = [
        "Loading market data from Alpha Vantage...",
        "Analyzing market context & indicators...",
        "Evaluating risk guard & consensus...",
        "Generating ORBIT analytical view..."
    ];
    let stageIdx = 0;
    if (loadingText) loadingText.textContent = stages[0];
    clearInterval(_copilotLoadingInterval);
    _copilotLoadingInterval = setInterval(() => {
        stageIdx = (stageIdx + 1) % stages.length;
        if (loadingText) loadingText.textContent = stages[stageIdx];
    }, 1500);

    try {
        const tf = store.get("currentTimeframe") || "1d";
        const d = await aiService.chatCopilot({
            message: message,
            symbol: activeSym,
            timeframe: tf,
            session_id: _copilotPageSessionId || undefined,
            response_mode: _copilotActiveMode
        });

        clearInterval(_copilotLoadingInterval);
        if (loadingBar) loadingBar.classList.add("hidden");

        _copilotPageSessionId = d.session_id;

        if (messagesBox) {
            const orbitCard = document.createElement("div");
            orbitCard.className = "copilot-page-msg-card orbit";
            const latencyTag = d.latency_ms ? `<span>&bull; ${d.latency_ms}ms</span>` : "";
            orbitCard.innerHTML = `
                <div class="copilot-page-msg-header">
                    <i class="fa-solid fa-robot text-emerald"></i>
                    <strong>ORBIT Copilot</strong>
                    ${latencyTag}
                </div>
                <div class="copilot-page-msg-body">${formatCopilotMarkdown(d.reply)}</div>
            `;
            messagesBox.appendChild(orbitCard);
            messagesBox.scrollTop = messagesBox.scrollHeight;
        }

        loadConversationsList();
    } catch (err: any) {
        clearInterval(_copilotLoadingInterval);
        if (loadingBar) loadingBar.classList.add("hidden");
        if (errorBanner) {
            const errMsg = getElement("copilot-page-error-msg");
            if (errMsg) errMsg.textContent = `ORBIT Copilot notice: ${err.message}`;
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
    createNewAnalysis();
}

