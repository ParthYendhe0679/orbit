/**
 * ORBIT Trading Terminal — Manage Trades Controller
 * Handles Open Positions, Pending Orders, Paginated Trade History, and Partial/Full Closure Modal
 */

import { tradingService } from "../services/tradingService";
import { portfolioService } from "../services/portfolioService";
import { store } from "../state/store";
import { Position, PendingOrder, ClosedTrade } from "../types/trading";
import { esc, formatINR, formatINRSafe } from "../utils/formatters";
import { DashboardSummary } from "../types/portfolio";
import { safeText, getElement } from "../utils/dom";
import { _botActiveTradesCache, refreshBotControlCenter } from "./autoBotController";

let _isCloseExecuting = false;
let _historySearchDebounceTimer: any = null;

export function switchManageSubTab(subTab: "open" | "pending" | "history"): void {
    const btnOpen = getElement("subtab-btn-open-trades");
    const btnPending = getElement("subtab-btn-pending-orders");
    const btnHistory = getElement("subtab-btn-trade-history");

    const panelOpen = getElement("manage-subtab-open");
    const panelPending = getElement("manage-subtab-pending");
    const panelHistory = getElement("manage-subtab-history");

    if (btnOpen) btnOpen.classList.toggle("active", subTab === "open");
    if (btnPending) btnPending.classList.toggle("active", subTab === "pending");
    if (btnHistory) btnHistory.classList.toggle("active", subTab === "history");

    if (panelOpen) panelOpen.classList.toggle("hidden-subtab", subTab !== "open");
    if (panelPending) panelPending.classList.toggle("hidden-subtab", subTab !== "pending");
    if (panelHistory) panelHistory.classList.toggle("hidden-subtab", subTab !== "history");

    if (subTab === "open") loadOpenTrades();
    else if (subTab === "pending") loadPendingOrders();
    else if (subTab === "history") loadTradeHistoryPage(0);
}

/**
 * Refreshes all Manage Trades tables simultaneously with animated button feedback.
 */
export async function loadManageTradesData(btnElement?: HTMLElement): Promise<void> {
    let originalHtml = "";
    if (btnElement) {
        btnElement.setAttribute("disabled", "true");
        originalHtml = btnElement.innerHTML;
        btnElement.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> <span>Refreshing...</span>';
    }

    try {
        const results = await Promise.allSettled([
            loadOpenTrades(),
            loadPendingOrders(),
            loadTradeHistoryPage(store.get("historyPage") || 0),
            fetchDashboardSummary()
        ]);

        const anyFailed = results.some((r) => r.status === "rejected");
        if (anyFailed) {
            console.warn("[ManageTrades] Some items failed to refresh:", results);
            if (btnElement) {
                btnElement.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-yellow"></i> <span>Partial</span>';
                setTimeout(() => {
                    if (btnElement) {
                        btnElement.innerHTML = originalHtml;
                        btnElement.removeAttribute("disabled");
                    }
                }, 1500);
                return;
            }
        }

        if (btnElement) {
            btnElement.innerHTML = '<i class="fa-solid fa-check text-green"></i> <span>Updated</span>';
            setTimeout(() => {
                if (btnElement) {
                    btnElement.innerHTML = originalHtml;
                    btnElement.removeAttribute("disabled");
                }
            }, 1200);
        }
    } catch (err) {
        console.error("[ManageTrades] Error refreshing data:", err);
        if (btnElement) {
            btnElement.innerHTML = '<i class="fa-solid fa-xmark text-red"></i> <span>Connection error</span>';
            setTimeout(() => {
                if (btnElement) {
                    btnElement.innerHTML = originalHtml;
                    btnElement.removeAttribute("disabled");
                }
            }, 2000);
        }
    } finally {
        if (
            btnElement &&
            !btnElement.innerHTML.includes("text-green") &&
            !btnElement.innerHTML.includes("text-yellow") &&
            !btnElement.innerHTML.includes("text-red")
        ) {
            btnElement.removeAttribute("disabled");
            btnElement.innerHTML = originalHtml;
        }
    }
}

/**
 * Universal refresh function for dashboard & system state.
 */
export async function refreshAllData(btnElement?: HTMLElement): Promise<void> {
    let originalHtml = "";
    if (btnElement) {
        btnElement.setAttribute("disabled", "true");
        originalHtml = btnElement.innerHTML;
        btnElement.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> <span>Refreshing...</span>';
    }

    try {
        const results = await Promise.allSettled([
            fetchDashboardSummary(),
            loadOpenTrades(),
            loadPendingOrders(),
            loadTradeHistoryPage(store.get("historyPage") || 0),
            loadOverviewHistory(),
            typeof (window as any).fetchGlobalNews === "function" ? (window as any).fetchGlobalNews() : Promise.resolve()
        ]);

        const anyFailed = results.some((r) => r.status === "rejected");
        if (anyFailed) {
            console.warn("[Refresh] Some requests failed:", results);
            if (btnElement) {
                btnElement.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-yellow"></i> <span>Partial</span>';
                setTimeout(() => {
                    if (btnElement) {
                        btnElement.innerHTML = originalHtml;
                        btnElement.removeAttribute("disabled");
                    }
                }, 1500);
                return;
            }
        }

        if (btnElement) {
            btnElement.innerHTML = '<i class="fa-solid fa-check text-green"></i> <span>Updated</span>';
            setTimeout(() => {
                if (btnElement) {
                    btnElement.innerHTML = originalHtml;
                    btnElement.removeAttribute("disabled");
                }
            }, 1200);
        }
    } catch (err) {
        console.error("[Refresh] Error refreshing system data:", err);
        if (btnElement) {
            btnElement.innerHTML = '<i class="fa-solid fa-xmark text-red"></i> <span>Connection error</span>';
            setTimeout(() => {
                if (btnElement) {
                    btnElement.innerHTML = originalHtml;
                    btnElement.removeAttribute("disabled");
                }
            }, 2000);
        }
    } finally {
        if (
            btnElement &&
            !btnElement.innerHTML.includes("text-green") &&
            !btnElement.innerHTML.includes("text-yellow") &&
            !btnElement.innerHTML.includes("text-red")
        ) {
            btnElement.removeAttribute("disabled");
            btnElement.innerHTML = originalHtml;
        }
    }
}

/**
 * Loads active open positions from server.
 */
export async function loadOpenTrades(): Promise<void> {
    const tbody = getElement("open-trades-tbody");
    const countBadge = getElement("manage-open-count");
    const overviewActiveEl = getElement("overview-active-trades");

    try {
        const userId = store.get("currentUserId");
        const positions = await tradingService.getOpenPositions(userId);
        store.set("openTrades", positions);

        if (countBadge) countBadge.textContent = String(positions.length);
        if (overviewActiveEl) overviewActiveEl.textContent = String(positions.length);

        if (!tbody) return;
        if (positions.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="13" class="table-empty-message">No active positions. Execute a trade from the Terminal or Auto-Trade Bot to begin.</td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = positions
            .map((pos: Position) => {
                const pnl = Number(pos.unrealized_pnl || pos.pnl || 0);
                const pnlClass = pnl >= 0 ? "text-green" : "text-red";
                const side = (pos.side || pos.type || "buy").toUpperCase();
                const sideClass = side === "BUY" || side === "LONG" ? "badge-green" : "badge-red";
                const sideLabel = side === "BUY" ? "LONG" : side === "SELL" ? "SHORT" : side;
                const market = pos.market || "Crypto";
                const lev = pos.leverage || 1;
                const posSize =
                    Number(pos.remaining_quantity || pos.quantity || 0) *
                    Number(pos.current_price || pos.entry_price || 0);
                const marginUsed = Number(pos.margin_used || 0);
                const pnlPct = marginUsed > 0 ? ((pnl / marginUsed) * 100).toFixed(2) : "0.00";
                const openTime = pos.timestamp
                    ? new Date(pos.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit"
                      })
                    : "—";

                return `
                <tr>
                    <td><strong>${esc(pos.symbol || pos.asset)}</strong></td>
                    <td><span class="badge badge-blue">${esc(market)}</span></td>
                    <td><span class="badge ${sideClass}">${esc(sideLabel)}</span></td>
                    <td><span class="badge badge-blue">OPEN</span>${pos.source === "bot" ? ' <span class="badge badge-open" title="Opened by Auto-Trade Bot session #' + esc(pos.bot_session_id) + '">BOT</span>' : ""}</td>
                    <td>${formatINR(pos.entry_price)}</td>
                    <td><strong>${formatINR(pos.current_price)}</strong></td>
                    <td>${Number(pos.remaining_quantity || pos.quantity)} <span style="opacity:0.6;font-size:11px;">/ ${Number(pos.original_quantity || pos.quantity)}</span></td>
                    <td><span class="text-cyan font-bold">${lev}x</span></td>
                    <td>${formatINR(posSize)}</td>
                    <td>${formatINR(marginUsed)}</td>
                    <td class="${pnlClass}"><strong>${pnl >= 0 ? "+" : ""}${formatINR(pnl)}</strong> <span style="font-size:11px;opacity:0.8;">(${pnl >= 0 ? "+" : ""}${pnlPct}%)</span></td>
                    <td>${openTime}</td>
                    <td>
                        <div style="display:inline-flex;gap:6px;align-items:center;">
                            <button class="glow-btn btn-danger btn-sm" onclick="quickCloseTrade(${pos.id})" title="Fast 1-Click Close at Market" style="padding:4px 8px;font-size:11px;background:rgba(239,68,68,0.2);border:1px solid rgba(239,68,68,0.5);color:#fca5a5;border-radius:4px;cursor:pointer;">
                                <i class="fa-solid fa-bolt"></i> Close
                            </button>
                            <button class="glow-btn btn-manage-action" onclick="openManageTradeModal(${pos.id})" style="padding:4px 8px;font-size:11px;">
                                <i class="fa-solid fa-sliders"></i> Manage
                            </button>
                        </div>
                    </td>
                </tr>
            `;
            })
            .join("");
    } catch (err: any) {
        console.error("[ManageTrades] Error loading open positions:", err);
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="13" class="table-empty-message text-red">Failed to load active trades: ${esc(err.message)}</td></tr>`;
        }
    }
}

/**
 * Loads pending limit/trigger orders.
 */
export async function loadPendingOrders(): Promise<void> {
    const tbody = getElement("pending-orders-tbody");
    const countBadge = getElement("manage-pending-count");

    try {
        const userId = store.get("currentUserId");
        const orders = await tradingService.getPendingOrders(userId);
        store.set("pendingOrders", orders);

        if (countBadge) countBadge.textContent = String(orders.length);

        if (!tbody) return;
        if (orders.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="10" class="table-empty-message">No pending orders. Limit and trigger orders awaiting execution will appear here.</td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = orders
            .map((ord: PendingOrder) => {
                const side = (ord.type || "BUY").toUpperCase();
                const sideClass = side === "BUY" ? "badge-green" : "badge-red";
                const created = ord.timestamp
                    ? new Date(ord.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                    : "—";

                return `
                <tr>
                    <td><code>#${ord.id}</code></td>
                    <td><strong>${esc(ord.asset)}</strong></td>
                    <td><span class="badge ${sideClass}">${esc(side)}</span></td>
                    <td>${Number(ord.quantity || 1)}</td>
                    <td>${formatINR(ord.entry_price || 0)}</td>
                    <td>${formatINR(ord.sl || 0)}</td>
                    <td>${formatINR(ord.target || 0)}</td>
                    <td>${created}</td>
                    <td><span class="badge badge-yellow">PENDING</span></td>
                    <td>
                        <button class="glow-btn btn-secondary btn-sm" onclick="cancelPendingOrder(${ord.id})">
                            <i class="fa-solid fa-ban"></i> Cancel
                        </button>
                    </td>
                </tr>
            `;
            })
            .join("");
    } catch (err: any) {
        console.error("[ManageTrades] Error loading pending orders:", err);
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="10" class="table-empty-message text-red">Failed to load pending orders: ${esc(err.message)}</td></tr>`;
        }
    }
}

/**
 * Cancels a pending order.
 */
export async function cancelPendingOrder(orderId: number): Promise<void> {
    if (!confirm("Are you sure you want to cancel this pending order?")) return;

    store.sockets.sendPrimaryAction({
        action: "cancel_trade",
        trade_id: orderId
    });

    setTimeout(() => {
        loadPendingOrders();
        fetchDashboardSummary();
    }, 300);
}

/**
 * Loads paginated trade history with filters.
 */
export async function loadTradeHistoryPage(page?: number): Promise<void> {
    if (page !== undefined) {
        store.set("historyPage", page);
    }
    const currentPage = store.get("historyPage");

    const tbody = getElement("trade-history-tbody");
    const countBadge = getElement("manage-history-count");
    const prevBtn = getElement<HTMLButtonElement>("history-prev-btn");
    const nextBtn = getElement<HTMLButtonElement>("history-next-btn");
    const pageInfo = getElement("history-page-info");

    const search = ((getElement<HTMLInputElement>("history-filter-symbol")?.value) || "").trim();
    const market = getElement<HTMLSelectElement>("history-filter-market")?.value || "";
    const side = getElement<HTMLSelectElement>("history-filter-side")?.value || "";
    const outcome = getElement<HTMLSelectElement>("history-filter-outcome")?.value || "";

    const limit = 15;
    const offset = currentPage * limit;

    try {
        const userId = store.get("currentUserId");
        const res = await tradingService.getTradeHistory({
            user_id: userId ?? undefined,
            limit,
            offset,
            symbol: search || undefined,
            market: market || undefined,
            side: side || undefined,
            outcome: outcome || undefined
        });

        const trades = res.trades || [];
        const total = res.total || 0;
        store.set("tradeHistory", trades);

        if (countBadge) countBadge.textContent = String(total);

        const totalHistoryPages = Math.max(1, Math.ceil(total / limit));
        store.set("totalHistoryPages", totalHistoryPages);

        if (pageInfo) pageInfo.textContent = `Page ${currentPage + 1} of ${totalHistoryPages}`;
        if (prevBtn) prevBtn.disabled = currentPage <= 0;
        if (nextBtn) nextBtn.disabled = currentPage >= totalHistoryPages - 1;

        if (!tbody) return;
        if (trades.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="12" class="table-empty-message">No completed trades match your filter criteria.</td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = trades
            .map((trade: ClosedTrade) => {
                const pnl = Number(trade.realized_pnl !== undefined ? trade.realized_pnl : (trade.pnl || 0));
                const pnlClass = pnl > 0 ? "text-green" : pnl < 0 ? "text-red" : "";
                const tradeSide = (trade.side || trade.type || "buy").toUpperCase();
                const sideLabel = tradeSide === "BUY" ? "LONG" : tradeSide === "SELL" ? "SHORT" : tradeSide;
                const sideClass = tradeSide === "BUY" || tradeSide === "LONG" ? "badge-green" : "badge-red";
                const tradeOutcome = trade.outcome || (pnl > 0 ? "profit" : pnl < 0 ? "loss" : "closed");
                const outcomeClass =
                    tradeOutcome === "target" || tradeOutcome === "profit"
                        ? "badge-green"
                        : tradeOutcome === "cancelled"
                        ? "badge-yellow"
                        : "badge-red";
                const openTime = trade.opened_at || trade.timestamp
                    ? new Date(trade.opened_at || trade.timestamp).toLocaleDateString([], {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit"
                      })
                    : "—";
                const closeTime = trade.closed_at
                    ? new Date(trade.closed_at).toLocaleDateString([], {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit"
                      })
                    : "—";
                const lev = trade.leverage || 1;
                const exitPrice =
                    trade.exit_price !== null && trade.exit_price !== undefined ? formatINR(trade.exit_price) : "—";

                return `
                <tr>
                    <td><strong>${esc(trade.symbol || trade.asset)}</strong></td>
                    <td><span class="badge badge-blue">${esc(trade.market || "Crypto")}</span></td>
                    <td><span class="badge ${sideClass}">${esc(sideLabel)}</span></td>
                    <td>${formatINR(trade.entry_price || 0)}</td>
                    <td><strong>${exitPrice}</strong></td>
                    <td>${Number(trade.quantity || 0)}</td>
                    <td><span class="text-cyan font-bold">${lev}x</span></td>
                    <td class="${pnlClass}"><strong>${pnl >= 0 ? "+" : ""}${formatINR(pnl)}</strong></td>
                    <td><span class="badge ${outcomeClass}">${esc(tradeOutcome).toUpperCase()}</span></td>
                    <td>${openTime}</td>
                    <td>${closeTime}</td>
                    <td><span class="badge badge-yellow">${esc(trade.status || "CLOSED").toUpperCase()}</span></td>
                </tr>
            `;
            })
            .join("");
    } catch (err: any) {
        console.error("[ManageTrades] Error loading history:", err);
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="12" class="table-empty-message text-red">Failed to load history: ${esc(err.message)}</td></tr>`;
        }
    }
}

export function paginateHistory(direction: number): void {
    const targetPage = store.get("historyPage") + direction;
    const totalPages = store.get("totalHistoryPages");
    if (targetPage >= 0 && targetPage < totalPages) {
        loadTradeHistoryPage(targetPage);
    }
}

export function debouncedHistorySearch(): void {
    clearTimeout(_historySearchDebounceTimer);
    _historySearchDebounceTimer = setTimeout(() => {
        loadTradeHistoryPage(0);
    }, 300);
}

/**
 * Opens Manage Trade modal for a given position ID.
 */
export function openManageTradeModal(tradeId: number): void {
    const openTrades = store.get("openTrades");
    const trade = openTrades.find((p) => p.id === tradeId) || (_botActiveTradesCache.find((p) => p.id === tradeId) as unknown as Position);
    if (!trade) {
        console.warn("[ManageTrades] Trade not found in cache:", tradeId);
        return;
    }

    store.set("activeManageTrade", trade);
    store.set("closeSelectedPct", null);

    const modal = getElement("manage-trade-modal");
    if (!modal) return;

    // Populate header & specs
    const symbol = trade.symbol || trade.asset || "";
    safeText(getElement("mmodal-symbol-sub"), `${symbol} • ${trade.market || "Spot"} Market`);
    const side = (trade.side || trade.type || "buy").toUpperCase();
    const sideBadge = getElement("mmodal-side-badge");
    if (sideBadge) {
        sideBadge.textContent = side === "BUY" ? "LONG" : side === "SELL" ? "SHORT" : side;
        sideBadge.className = `trade-side-badge ${side === "BUY" || side === "LONG" ? "buy" : "sell"}`;
    }
    safeText(getElement("mmodal-status-badge"), "OPEN");

    safeText(getElement("mmodal-entry-price"), formatINR(trade.entry_price || 0));
    safeText(getElement("mmodal-current-price"), formatINR(trade.current_price || 0));
    safeText(getElement("mmodal-total-qty"), String(trade.original_quantity || trade.quantity || 1));
    safeText(getElement("mmodal-remaining-qty"), String(trade.remaining_quantity || trade.quantity || 1));
    safeText(getElement("mmodal-leverage"), `${trade.leverage || 1}x`);

    const uPnl = Number(trade.unrealized_pnl || trade.pnl || 0);
    const uPnlEl = getElement("mmodal-unrealized-pnl");
    if (uPnlEl) {
        uPnlEl.textContent = (uPnl >= 0 ? "+" : "") + formatINR(uPnl);
        uPnlEl.className = `mmodal-metric-val ${uPnl >= 0 ? "text-green" : "text-red"}`;
    }

    // Default select 50%
    selectClosePct(50);
    modal.classList.remove("hidden");
}

export function closeManageTradeModal(): void {
    const modal = getElement("manage-trade-modal");
    if (modal) modal.classList.add("hidden");
    store.set("activeManageTrade", null);
    store.set("closeSelectedPct", null);
}

export function selectClosePct(pct: number): void {
    const trade = store.get("activeManageTrade");
    if (!trade) return;

    store.set("closeSelectedPct", pct);

    // Update active style on pct buttons
    document.querySelectorAll(".close-pct-btn-group .pct-btn").forEach((btn) => {
        const text = btn.textContent ? btn.textContent.trim() : "";
        const matches = (pct === 100 && text.includes("FULL")) || text.includes(`${pct}%`);
        btn.classList.toggle("active-pct", matches);
    });

    const remQty = Number(trade.remaining_quantity || trade.quantity || 1);
    let closeQty = remQty * (pct / 100);
    if (Number.isInteger(remQty)) {
        closeQty = Math.max(1, Math.round(closeQty));
        if (pct < 100 && closeQty >= remQty) {
            closeQty = Math.max(1, remQty - 1);
        }
    } else {
        closeQty = Number(closeQty.toFixed(4));
    }
    if (pct === 100) closeQty = remQty;

    const input = getElement<HTMLInputElement>("custom-close-qty");
    if (input) input.value = String(closeQty);

    recalculateCloseEstimates(closeQty);
}

export function onCustomCloseInput(): void {
    const trade = store.get("activeManageTrade");
    if (!trade) return;

    document.querySelectorAll(".close-pct-btn-group .pct-btn").forEach((btn) => btn.classList.remove("active-pct"));
    store.set("closeSelectedPct", null);

    const input = getElement<HTMLInputElement>("custom-close-qty");
    const val = parseFloat(input?.value || "0");
    const remQty = Number(trade.remaining_quantity || trade.quantity || 1);

    if (isNaN(val) || val <= 0) {
        recalculateCloseEstimates(0);
        return;
    }
    const safeQty = Math.min(val, remQty);
    if (val > remQty && input) {
        input.value = String(safeQty);
    }
    recalculateCloseEstimates(safeQty);
}

export function setMaxCloseQty(): void {
    const trade = store.get("activeManageTrade");
    if (!trade) return;
    selectClosePct(100);
}

export function recalculateCloseEstimates(closeQty: number): void {
    const trade = store.get("activeManageTrade");
    if (!trade) return;

    const entry = Number(trade.entry_price || 0);
    const current = Number(trade.current_price || entry);
    const lev = Number(trade.leverage || 1);
    const remQty = Number(trade.remaining_quantity || trade.quantity || 1);
    const marginUsed = Number(trade.margin_used || 0);
    const side = (trade.side || trade.type || "buy").toLowerCase();

    let estPnl = 0;
    if (side === "buy" || side === "long") {
        estPnl = (current - entry) * closeQty * lev;
    } else {
        estPnl = (entry - current) * closeQty * lev;
    }

    const marginPortion = remQty > 0 ? (closeQty / remQty) * marginUsed : 0;
    const totalRefund = marginPortion + estPnl;

    safeText(getElement("est-close-qty"), String(closeQty));
    safeText(getElement("est-exit-price"), formatINR(current));

    const pnlEl = getElement("est-realized-pnl");
    if (pnlEl) {
        pnlEl.textContent = (estPnl >= 0 ? "+" : "") + formatINR(estPnl);
        pnlEl.className = estPnl >= 0 ? "text-green" : "text-red";
    }
    safeText(getElement("est-margin-refund"), formatINR(Math.max(0, totalRefund)));
}

/**
 * 1-Click high-speed position closure directly from the Open Trades table.
 */
export async function quickCloseTrade(tradeId: number): Promise<void> {
    const posList = (store.get("openTrades") as Position[]) || [];
    const targetPos = posList.find((p: Position) => p.id === tradeId);
    const sym = targetPos ? (targetPos.symbol || targetPos.asset) : `Position #${tradeId}`;

    if (typeof (window as any).logToTerminal === "function") {
        (window as any).logToTerminal("Execution Agent", `⚡ Fast Closing ${sym} at market price...`);
    }

    try {
        const uid = store.get("currentUserId");
        const res = await tradingService.closePositionFull(tradeId, uid);
        const realizedPnl = Number(res.realized_pnl ?? 0);

        if (typeof (window as any).logToTerminal === "function") {
            (window as any).logToTerminal(
                "Execution Agent",
                `✅ ${sym} closed instantly! Realized P&L: ${formatINR(realizedPnl)}`
            );
        }

        await Promise.all([
            loadOpenTrades(),
            fetchDashboardSummary(),
            loadTradeHistoryPage(0)
        ]);
    } catch (err: any) {
        console.error("[ManageTrades] Quick close error:", err);
        alert(`Quick close failed: ${err.message || err}`);
        await loadOpenTrades();
    }
}

/**
 * Submits partial or full position close to backend API.
 */
export async function executePositionClose(): Promise<void> {
    if (_isCloseExecuting) return;
    const trade = store.get("activeManageTrade");
    if (!trade) return;

    const tradeId = trade.id;
    const remQty = Number(trade.remaining_quantity || trade.quantity || 1);
    const input = getElement<HTMLInputElement>("custom-close-qty");
    const closeQty = parseFloat(input?.value || "0");

    if (isNaN(closeQty) || closeQty <= 0) {
        alert("Please specify a valid quantity to close greater than zero.");
        return;
    }
    if (closeQty > remQty) {
        alert(`Cannot close more than the remaining quantity (${remQty}).`);
        return;
    }

    const isFullClose = closeQty >= remQty;

    _isCloseExecuting = true;
    const btn = getElement<HTMLButtonElement>("btn-confirm-close");
    const btnText = getElement("btn-confirm-close-text");
    if (btn) btn.disabled = true;
    if (btnText) btnText.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Closing...';

    // Close modal immediately so the user is never stuck looking at a spinning button
    closeManageTradeModal();

    if (typeof (window as any).logToTerminal === "function") {
        (window as any).logToTerminal(
            "Execution Agent",
            `⚡ Submitting ${isFullClose ? "full" : "partial"} close for ${trade.symbol || trade.asset}...`
        );
    }

    try {
        const uid = store.get("currentUserId");
        let realizedPnl = 0;
        if (isFullClose) {
            const res = await tradingService.closePositionFull(tradeId, uid);
            realizedPnl = Number(res.realized_pnl ?? 0);
        } else {
            const res = await tradingService.closePositionPartial(tradeId, closeQty, uid);
            realizedPnl = Number(res.realized_pnl ?? 0);
        }

        // Refresh all relevant views immediately
        await Promise.all([
            loadOpenTrades(),
            fetchDashboardSummary(),
            loadTradeHistoryPage(0),
            (trade as any).source === "bot" ? refreshBotControlCenter().catch(() => {}) : Promise.resolve()
        ]);

        if (typeof (window as any).logToTerminal === "function") {
            (window as any).logToTerminal(
                "Execution Agent",
                `✅ Position #${tradeId} (${trade.symbol || trade.asset}) ${isFullClose ? "fully" : "partially"} closed. Realized P&L: ${formatINR(realizedPnl)}`
            );
        }
    } catch (err: any) {
        console.error("[ManageTrades] Close execution error:", err);
        alert(`Close order failed: ${err.message}`);
        await loadOpenTrades();
    } finally {
        _isCloseExecuting = false;
        if (btn) btn.disabled = false;
        if (btnText) btnText.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Close';
    }
}

/**
 * Renders the authoritative account summary (GET /api/dashboard/summary or the
 * WebSocket "dashboard_summary" push — the same contract either way).
 */
export function renderDashboardSummary(summary: DashboardSummary | null | undefined): void {
    if (!summary || !summary.account || !summary.trading) return;
    store.set("dashboardSummary", summary);
    const { account, trading } = summary;

    safeText(getElement("overview-balance"), formatINRSafe(account.total_capital));
    store.set("walletBalance", Number.isFinite(account.available_balance) ? account.available_balance : null);
    safeText(getElement("wallet-balance"), formatINRSafe(account.available_balance));
    safeText(getElement("copilot-account-balance"), formatINRSafe(account.available_balance));
    safeText(getElement("overview-active-trades"), String(trading.active_trades ?? 0));

    const setPnl = (id: string, value: number) => {
        const el = getElement(id);
        if (!el) return;
        el.textContent = (value >= 0 ? "+" : "") + formatINR(value);
        el.className = "stat-value " + (value >= 0 ? "text-green" : "text-red");
    };
    setPnl("overview-unrealized-pnl", Number(trading.unrealized_pnl) || 0);
    setPnl("overview-realized-pnl", Number(trading.realized_pnl) || 0);

    const winRateEl = getElement("overview-win-rate");
    const bar = getElement("overview-winrate-bar");
    if (trading.win_rate !== null && trading.win_rate !== undefined && trading.total_closed_trades > 0) {
        if (winRateEl) winRateEl.textContent = `${Number(trading.win_rate).toFixed(1)}%`;
        if (bar) bar.style.width = `${Math.min(100, Math.max(0, Number(trading.win_rate)))}%`;
    } else {
        if (winRateEl) winRateEl.textContent = "—";
        if (bar) bar.style.width = "0%";
    }
    safeText(getElement("overview-win-loss-text"), `${trading.winning_trades_count ?? 0} Wins | ${trading.losing_trades_count ?? 0} Losses`);
}

/**
 * Fetches the dashboard summary and updates the KPI cards.
 */
export async function fetchDashboardSummary(): Promise<void> {
    try {
        renderDashboardSummary(await portfolioService.getDashboardSummary(store.get("currentUserId")));
    } catch (err) {
        console.error("[Dashboard] Error fetching summary:", err);
    }
}

/**
 * The dashboard's recent-trades panel: the ten latest closed trades.
 */
export async function loadOverviewHistory(): Promise<void> {
    const list = getElement("overview-history-list");
    const count = getElement("overview-history-count");
    if (!list && !count) return;
    try {
        const res = await tradingService.getTradeHistory({ user_id: store.get("currentUserId") ?? undefined, limit: 10, offset: 0 });
        if (count) count.textContent = `${res.total} trade${res.total === 1 ? "" : "s"}`;
        if (!list) return;
        if (!res.trades.length) {
            list.innerHTML = `<div class="crew-history-empty"><i class="fa-solid fa-hourglass-half"></i><p>No completed trades yet</p></div>`;
            return;
        }
        list.innerHTML = res.trades.map((t: ClosedTrade) => {
            const pnl = Number(t.realized_pnl ?? t.pnl ?? 0);
            const isBuy = String(t.type || "").toLowerCase() === "buy";
            const outcome = t.outcome === "target" ? "TP" : t.outcome === "cancelled" ? "CX" : t.outcome === "sl" ? "SL" : "MC";
            const time = t.closed_at || t.timestamp;
            return `
                <div class="crew-history-item">
                    <div class="chi-direction ${isBuy ? "buy" : "sell"}">${isBuy ? "▲" : "▼"}</div>
                    <div class="chi-details">
                        <div class="chi-asset">${esc(t.symbol || t.asset || "—")}</div>
                        <div class="chi-time">${time ? new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</div>
                    </div>
                    <span class="chi-pnl ${pnl >= 0 ? "text-green" : "text-red"}">${pnl >= 0 ? "+" : ""}${formatINR(pnl)}</span>
                    <span class="chi-outcome ${t.outcome === "target" ? "target" : "stop"}">${outcome}</span>
                </div>`;
        }).join("");
    } catch (err) {
        console.warn("[Dashboard] Recent trades unavailable:", err);
    }
}
