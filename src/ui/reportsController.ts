/**
 * ORBIT Trading Terminal — Reports & Analytics Controller
 * Manages Performance Reports, Inline SVG Financial Charts, and CSV/JSON Exports
 */

import { portfolioService } from "../services/portfolioService";
import { store } from "../state/store";
import { esc, formatINR } from "../utils/formatters";
import { safeText, getElement } from "../utils/dom";

let reportData: any = null;

const CHART = {
    green: "#3fb950",
    red: "#e5484d",
    cyan: "#4d7cfe",
    purple: "#a371f7",
    yellow: "#d29922",
    grid: "rgba(255,255,255,0.06)",
    axis: "rgba(255,255,255,0.22)",
    text: "#9ba2ad"
};

function emptyChart(message: string): string {
    return `<div class="report-chart-empty"><i class="fa-solid fa-chart-line"></i><span>${esc(message)}</span></div>`;
}

function renderEquityCurve(curve: any[]): void {
    const host = getElement("chart-equity");
    if (!host) return;
    if (!curve || curve.length === 0) {
        host.innerHTML = emptyChart("No closed trades yet — the equity curve appears once trades settle.");
        return;
    }

    const W = 1000,
        H = 300,
        padL = 92,
        padR = 26,
        padT = 22,
        padB = 38;
    const plotW = W - padL - padR,
        plotH = H - padT - padB;

    const values = curve.map((p) => p.cumulative || p.pnl || 0);
    let min = Math.min(0, ...values);
    let max = Math.max(0, ...values);
    if (min === max) max = min + 1;
    const span = max - min;

    const x = (i: number) => padL + (curve.length === 1 ? plotW / 2 : (i / (curve.length - 1)) * plotW);
    const y = (v: number) => padT + plotH - ((v - min) / span) * plotH;

    const points = curve.map((p, i) => `${x(i).toFixed(1)},${y(p.cumulative || p.pnl || 0).toFixed(1)}`).join(" ");

    host.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="report-svg" role="img">
            <polyline fill="none" stroke="${CHART.green}" stroke-width="2" points="${points}" />
        </svg>
    `;
}

/**
 * Loads full trading performance report for the active user.
 */
export async function loadReport(): Promise<void> {
    const userId = store.get("currentUserId");
    if (!userId) return;

    const reportGenerated = getElement("report-generated");
    const reportTableBody = getElement("report-table-body");

    if (reportGenerated) reportGenerated.textContent = "Generating...";

    try {
        const payload = await portfolioService.getReport(userId);
        reportData = payload;

        if (reportGenerated) {
            safeText(reportGenerated, `Generated ${new Date().toLocaleTimeString()}`);
        }

        const trades = payload.trades || [];
        if (reportTableBody) {
            if (trades.length === 0) {
                reportTableBody.innerHTML = `<tr><td colspan="12" class="report-empty">No trades found.</td></tr>`;
            } else {
                reportTableBody.innerHTML = trades
                    .slice(0, 50)
                    .map((t: any) => {
                        const pnl = Number(t.realized_pnl !== undefined ? t.realized_pnl : t.pnl || 0);
                        const pnlClass = pnl > 0 ? "text-green" : pnl < 0 ? "text-red" : "";
                        return `
                        <tr>
                            <td><strong>${esc(t.asset || t.symbol)}</strong></td>
                            <td>${formatINR(t.entry_price || 0)}</td>
                            <td>${formatINR(t.exit_price || 0)}</td>
                            <td>${Number(t.quantity || 1)}</td>
                            <td class="${pnlClass}"><strong>${pnl >= 0 ? "+" : ""}${formatINR(pnl)}</strong></td>
                            <td>${t.closed_at || t.timestamp ? new Date(t.closed_at || t.timestamp).toLocaleDateString() : "—"}</td>
                        </tr>
                    `;
                    })
                    .join("");
            }
        }

        renderEquityCurve(payload.chart_data || []);
    } catch (err: any) {
        console.error("[Reports] Error loading report:", err);
        if (reportGenerated) reportGenerated.textContent = "Could not load report";
        if (reportTableBody) {
            reportTableBody.innerHTML = `<tr><td colspan="12" class="report-empty text-red">Failed to load report: ${esc(err.message)}</td></tr>`;
        }
    }
}

/**
 * Exports closed trades report as CSV.
 */
export function exportReportCsv(): void {
    if (!reportData || !reportData.trades || reportData.trades.length === 0) {
        alert("No trade data available to export.");
        return;
    }

    const trades = reportData.trades;
    const headers = ["ID", "Asset", "Side", "Quantity", "Entry Price", "Exit Price", "P&L", "Status", "Date"];
    const rows = trades.map((t: any) => [
        t.id,
        t.asset || t.symbol,
        t.side || t.type,
        t.quantity,
        t.entry_price,
        t.exit_price || "",
        t.realized_pnl || t.pnl || 0,
        t.status,
        t.closed_at || t.timestamp || ""
    ]);

    const csvContent =
        "data:text/csv;charset=utf-8," +
        [headers.join(","), ...rows.map((e: any[]) => e.map((x) => `"${x}"`).join(","))].join("\n");

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `orbit_trades_report_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/**
 * Exports closed trades report as JSON.
 */
export function exportReportJson(): void {
    if (!reportData) {
        alert("No trade data available to export.");
        return;
    }

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(reportData, null, 2));
    const link = document.createElement("a");
    link.setAttribute("href", dataStr);
    link.setAttribute("download", `orbit_report_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/**
 * Initializes Reports UI event listeners.
 */
export function initReportsListeners(): void {
    getElement("report-refresh-btn")?.addEventListener("click", () => loadReport());
    getElement("report-export-csv")?.addEventListener("click", () => exportReportCsv());
    getElement("report-export-json")?.addEventListener("click", () => exportReportJson());
}
