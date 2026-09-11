/**
 * ORBIT Trading Terminal — Manage Trades Controller
 * Handles Open Positions, Pending Orders, Paginated Trade History, and Partial/Full Closure Modal
 */

import { tradingService } from "../services/tradingService";
import { portfolioService } from "../services/portfolioService";
import { store } from "../state/store";
import { Position, PendingOrder, ClosedTrade } from "../types/trading";
import { esc, formatINR } from "../utils/formatters";
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
        const userId = store.get("currentUserId") || 1;
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
                        <button class="glow-btn btn-manage-action" onclick="openManageTradeModal(${pos.id})">
                            <i class="fa-solid fa-sliders"></i> Manage
                        </button>
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
        const userId = store.get("currentUserId") || 1;
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
        const userId = store.get("currentUserId") || 1;
        const res = await tradingService.getTradeHistory({
            user_id: userId,
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
    const confirmMsg = isFullClose
        ? `Confirm FULL CLOSE of ${trade.symbol || trade.asset} (${remQty} units)?`
        : `Confirm partial close of ${closeQty} units of ${trade.symbol || trade.asset}?`;

    if (!confirm(confirmMsg)) return;

    _isCloseExecuting = true;
    const btn = getElement<HTMLButtonElement>("btn-confirm-close");
    const btnText = getElement("btn-confirm-close-text");
    if (btn) btn.disabled = true;
    if (btnText) btnText.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Closing...';

    try {
        const uid = store.get("currentUserId") || localStorage.getItem("orbit_user_id") || 1;
        let realizedPnl = 0;
        if (isFullClose) {
            const res = await tradingService.closePositionFull(tradeId, uid);
            realizedPnl = res.realized_pnl;
        } else {
            const res = await tradingService.closePositionPartial(tradeId, closeQty, uid);
            realizedPnl = res.realized_pnl;
        }

        // Close modal
        closeManageTradeModal();

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
    } finally {
        _isCloseExecuting = false;
        if (btn) btn.disabled = false;
        if (btnText) btnText.innerHTML = '<i class="fa-solid fa-check"></i> Confirm Close';
    }
}

/**
 * Fetches dashboard summary and updates KPI cards.
 */
export async function fetchDashboardSummary(): Promise<void> {
    try {
        const userId = store.get("currentUserId") || 1;
        const summary = await portfolioService.getDashboardSummary(userId);
        store.set("dashboardSummary", summary);

        safeText(getElement("overview-equity"), formatINR(summary.equity));
        safeText(getElement("overview-cash-balance"), formatINR(summary.balance));
        safeText(getElement("overview-used-margin"), formatINR(summary.used_margin));
        safeText(getElement("wallet-balance"), formatINR(summary.balance));

        const uPnl = summary.unrealized_pnl ?? summary.total_unrealized_pnl;
        const rPnl = summary.realized_pnl ?? summary.total_realized_pnl;

        const pnlEl = getElement("overview-unrealized-pnl");
        if (pnlEl) {
            pnlEl.textContent = (uPnl >= 0 ? "+" : "") + formatINR(uPnl);
            pnlEl.className = uPnl >= 0 ? "metric-val text-green" : "metric-val text-red";
        }

        const realizedEl = getElement("overview-realized-pnl");
        if (realizedEl) {
            realizedEl.textContent = (rPnl >= 0 ? "+" : "") + formatINR(rPnl);
            realizedEl.className = rPnl >= 0 ? "metric-val text-green" : "metric-val text-red";
        }

        const winRateEl = getElement("overview-win-rate");
        if (winRateEl) {
            winRateEl.textContent = summary.win_rate !== null && summary.win_rate !== undefined ? `${summary.win_rate.toFixed(1)}%` : "—";
        }
    } catch (err) {
        console.error("[Dashboard] Error fetching summary:", err);
    }
}
