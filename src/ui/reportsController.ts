/**
 * ORBIT Trading Terminal — Reports & Analytics Controller
 * KPI cards, SVG charts, the trade ledger and CSV/JSON/PDF exports, all from
 * the ai-service's authoritative report (GET /api/report → report).
 */

import { portfolioService } from "../services/portfolioService";
import { store } from "../state/store";
import { esc } from "../utils/formatters";
import { safeText, getElement } from "../utils/dom";
import { BreakdownRow, EquityPoint, PortfolioReport, ReportSummary, ReportTrade } from "../types/portfolio";

let reportData: PortfolioReport | null = null;

const CHART = {
    green: "#3fb950",
    red: "#e5484d",
    grid: "rgba(255,255,255,0.06)",
    axis: "rgba(255,255,255,0.22)",
    text: "#9ba2ad"
};

function rupees(value: unknown, decimals: number = 2): string {
    const n = Number(value) || 0;
    const sign = n < 0 ? "-" : "";
    return sign + "₹" + Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function signedRupees(value: unknown): string {
    const n = Number(value) || 0;
    return (n >= 0 ? "+" : "") + rupees(n);
}

function signedRupeesShort(value: unknown): string {
    const n = Number(value) || 0;
    return (n >= 0 ? "+" : "") + rupees(n, 0);
}

function pnlClass(value: unknown): string {
    const n = Number(value) || 0;
    return n > 0 ? "text-green" : n < 0 ? "text-red" : "text-muted";
}

function svgWrap(inner: string, width: number, height: number): string {
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" class="report-svg" role="img">${inner}</svg>`;
}

function emptyChart(message: string): string {
    return `<div class="report-chart-empty"><i class="fa-solid fa-chart-line"></i><span>${esc(message)}</span></div>`;
}

function renderEquityCurve(curve: EquityPoint[]): void {
    const host = getElement("chart-equity");
    if (!host) return;
    if (!curve.length) {
        host.innerHTML = emptyChart("No closed trades yet — the equity curve appears once trades settle.");
        return;
    }
    const W = 1000, H = 300, padL = 92, padR = 26, padT = 22, padB = 38;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const values = curve.map((p) => p.cumulative);
    const min = Math.min(0, ...values);
    let max = Math.max(0, ...values);
    if (min === max) max = min + 1;
    const span = max - min;
    const x = (i: number) => padL + (curve.length === 1 ? plotW / 2 : (i / (curve.length - 1)) * plotW);
    const y = (v: number) => padT + plotH - ((v - min) / span) * plotH;

    let grid = "";
    for (let t = 0; t <= 5; t++) {
        const value = min + (span * t) / 5;
        const gy = y(value);
        grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="${CHART.grid}" stroke-width="1"/>`;
        grid += `<text x="${padL - 8}" y="${gy + 4}" fill="${CHART.text}" font-size="11" text-anchor="end" font-family="monospace">${esc(rupees(value, 0))}</text>`;
    }
    const zeroY = y(0);
    grid += `<line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="${CHART.axis}" stroke-width="1.5" stroke-dasharray="4 4"/>`;
    const points = curve.map((p, i) => `${x(i)},${y(p.cumulative)}`).join(" ");
    const lineColor = values[values.length - 1] >= 0 ? CHART.green : CHART.red;
    const area = `${padL},${zeroY} ${points} ${x(curve.length - 1)},${zeroY}`;
    const dots = curve.length > 60 ? "" : curve.map((p, i) =>
        `<circle cx="${x(i)}" cy="${y(p.cumulative)}" r="3" fill="${p.pnl >= 0 ? CHART.green : CHART.red}" stroke="#0b0c0e" stroke-width="1">
            <title>#${p.n} ${esc(p.asset || "")} — trade ${signedRupees(p.pnl)}, running ${signedRupees(p.cumulative)}</title>
         </circle>`).join("");
    host.innerHTML = svgWrap(`
        <defs><linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${lineColor}" stop-opacity="0.35"/><stop offset="100%" stop-color="${lineColor}" stop-opacity="0.02"/>
        </linearGradient></defs>
        ${grid}
        <polygon points="${area}" fill="url(#eqFill)"/>
        <polyline points="${points}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}
        <text x="${padL}" y="${H - 12}" fill="${CHART.text}" font-size="11">trade 1</text>
        <text x="${W - padR}" y="${H - 12}" fill="${CHART.text}" font-size="11" text-anchor="end">trade ${curve.length}</text>`, W, H);
}

function renderPnlBars(curve: EquityPoint[]): void {
    const host = getElement("chart-pnl-bars");
    if (!host) return;
    if (!curve.length) {
        host.innerHTML = emptyChart("No closed trades to chart.");
        return;
    }
    const W = 520, H = 260, padL = 78, padR = 18, padT = 18, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const bound = Math.max(1, ...curve.map((p) => Math.abs(p.pnl)));
    const y = (v: number) => padT + plotH / 2 - (v / bound) * (plotH / 2);
    const midY = padT + plotH / 2;
    const slot = plotW / curve.length;
    const barW = Math.max(2, Math.min(22, slot * 0.7));
    const bars = curve.map((p, i) => {
        const cx = padL + slot * i + slot / 2;
        const top = p.pnl >= 0 ? y(p.pnl) : midY;
        const h = Math.max(1, Math.abs(midY - y(p.pnl)));
        return `<rect x="${cx - barW / 2}" y="${top}" width="${barW}" height="${h}" fill="${p.pnl >= 0 ? CHART.green : CHART.red}" opacity="0.85" rx="2">
                    <title>#${p.n} ${esc(p.asset || "")} — ${signedRupees(p.pnl)}</title></rect>`;
    }).join("");
    host.innerHTML = svgWrap(`
        <line x1="${padL}" y1="${y(bound)}" x2="${W - padR}" y2="${y(bound)}" stroke="${CHART.grid}"/>
        <line x1="${padL}" y1="${y(-bound)}" x2="${W - padR}" y2="${y(-bound)}" stroke="${CHART.grid}"/>
        <text x="${padL - 8}" y="${y(bound) + 4}" fill="${CHART.text}" font-size="10" text-anchor="end" font-family="monospace">${esc(rupees(bound, 0))}</text>
        <text x="${padL - 8}" y="${y(-bound) + 4}" fill="${CHART.text}" font-size="10" text-anchor="end" font-family="monospace">${esc(rupees(-bound, 0))}</text>
        ${bars}
        <line x1="${padL}" y1="${midY}" x2="${W - padR}" y2="${midY}" stroke="${CHART.axis}" stroke-width="1"/>`, W, H);
}

function renderWinLoss(summary: ReportSummary): void {
    const host = getElement("chart-winloss");
    if (!host) return;
    const wins = summary.wins || 0;
    const losses = summary.losses || 0;
    const total = wins + losses;
    if (total === 0) {
        host.innerHTML = emptyChart("No settled trades yet.");
        return;
    }
    const W = 520, H = 260, cx = 170, cy = 130, r = 80, thickness = 26, legendX = 353, legendTextX = 373;
    const circumference = 2 * Math.PI * r;
    const winFraction = wins / total;
    host.innerHTML = svgWrap(`
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${CHART.red}" stroke-width="${thickness}"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${CHART.green}" stroke-width="${thickness}"
                stroke-dasharray="${circumference * winFraction} ${circumference}" transform="rotate(-90 ${cx} ${cy})" stroke-linecap="butt"/>
        <text x="${cx}" y="${cy - 2}" fill="#e7e9ec" font-size="32" font-weight="700" text-anchor="middle" font-family="monospace">${(winFraction * 100).toFixed(1)}%</text>
        <text x="${cx}" y="${cy + 22}" fill="${CHART.text}" font-size="12" text-anchor="middle">win rate</text>
        <rect x="${legendX}" y="90" width="13" height="13" rx="3" fill="${CHART.green}"/>
        <text x="${legendTextX}" y="102" fill="#e7e9ec" font-size="14">${wins} wins</text>
        <text x="${legendTextX}" y="121" fill="${CHART.text}" font-size="12" font-family="monospace">${esc(rupees(summary.gross_profit, 0))}</text>
        <rect x="${legendX}" y="152" width="13" height="13" rx="3" fill="${CHART.red}"/>
        <text x="${legendTextX}" y="164" fill="#e7e9ec" font-size="14">${losses} losses</text>
        <text x="${legendTextX}" y="183" fill="${CHART.text}" font-size="12" font-family="monospace">${esc(rupees(-summary.gross_loss, 0))}</text>`, W, H);
}

function renderBreakdown(hostId: string, rows: BreakdownRow[], emptyMessage: string): void {
    const host = getElement(hostId);
    if (!host) return;
    if (!rows.length) {
        host.innerHTML = emptyChart(emptyMessage);
        return;
    }
    const shown = rows.slice(0, 8);
    const rowH = 30, padL = 112, padR = 104, W = 520, H = 264;
    const padT = Math.max(12, (H - shown.length * rowH) / 2);
    const plotW = W - padL - padR;
    const bound = Math.max(1, ...shown.map((r) => Math.abs(r.pnl)));
    const midX = padL + plotW / 2;
    const scale = plotW / 2 / bound;
    const bars = shown.map((r, i) => {
        const cy = padT + i * rowH + rowH / 2;
        const w = Math.max(1, Math.abs(r.pnl) * scale);
        const x = r.pnl >= 0 ? midX : midX - w;
        const color = r.pnl >= 0 ? CHART.green : CHART.red;
        const label = String(r.name).length > 15 ? String(r.name).slice(0, 14) + "…" : String(r.name);
        return `
            <text x="${padL - 10}" y="${cy + 4}" fill="${CHART.text}" font-size="11" text-anchor="end">${esc(label)}</text>
            <rect x="${x}" y="${cy - 9}" width="${w}" height="18" fill="${color}" opacity="0.8" rx="2">
                <title>${esc(r.name)} — ${r.trades} trades${r.win_rate !== undefined ? `, ${r.win_rate}% win rate` : ""}, ${signedRupees(r.pnl)}</title>
            </rect>
            <text x="${W - padR + 12}" y="${cy + 4}" fill="${color}" font-size="11" font-family="monospace">${esc(signedRupeesShort(r.pnl))}</text>`;
    }).join("");
    host.innerHTML = svgWrap(`<line x1="${midX}" y1="${padT}" x2="${midX}" y2="${H - padT}" stroke="${CHART.axis}" stroke-width="1"/>${bars}`, W, H);
}

function renderKpis(s: ReportSummary): void {
    const netEl = getElement("rk-net-pnl");
    if (netEl) {
        netEl.textContent = signedRupees(s.net_pnl);
        netEl.className = "report-kpi-value " + pnlClass(s.net_pnl);
    }
    safeText(getElement("rk-net-pnl-sub"), `${s.closed_trades} closed of ${s.total_trades} total`);
    safeText(getElement("rk-win-rate"), `${s.win_rate}%`);
    safeText(getElement("rk-win-rate-sub"), `${s.wins}W / ${s.losses}L`);
    const pfEl = getElement("rk-profit-factor");
    if (pfEl) {
        // null = no losing trade yet, so the ratio is undefined.
        pfEl.textContent = s.profit_factor === null ? "∞" : s.profit_factor.toFixed(2);
        pfEl.className = "report-kpi-value " + (s.profit_factor === null || s.profit_factor >= 1 ? "text-green" : "text-red");
    }
    const expEl = getElement("rk-expectancy");
    if (expEl) {
        expEl.textContent = signedRupees(s.expectancy);
        expEl.className = "report-kpi-value " + pnlClass(s.expectancy);
    }
    safeText(getElement("rk-drawdown"), rupees(s.max_drawdown));
    safeText(getElement("rk-drawdown-sub"), `${s.max_drawdown_pct}% of peak equity`);
    const ratio = s.avg_loss > 0 ? s.avg_win / s.avg_loss : null;
    safeText(getElement("rk-avg-ratio"), ratio === null ? "—" : `${ratio.toFixed(2)} : 1`);
    safeText(getElement("rk-avg-sub"), `${rupees(s.avg_win, 0)} avg win / ${rupees(s.avg_loss, 0)} avg loss`);
    safeText(getElement("rk-best-worst"), `${signedRupeesShort(s.best_trade)} / ${signedRupeesShort(s.worst_trade)}`);
    safeText(getElement("rk-streaks"), `streaks ${s.longest_win_streak}W / ${s.longest_loss_streak}L`);
    safeText(getElement("rk-open"), String(s.open_trades + s.pending_trades));
    safeText(getElement("rk-open-sub"), `${s.open_trades} active · ${s.pending_trades} pending · unrealized ${signedRupeesShort(s.unrealized_pnl)}`);
}

function filteredTrades(): ReportTrade[] {
    if (!reportData) return [];
    const asset = getElement<HTMLSelectElement>("report-filter-asset")?.value || "all";
    const outcome = getElement<HTMLSelectElement>("report-filter-outcome")?.value || "all";
    return reportData.trades.filter((t) => {
        if (asset !== "all" && t.asset !== asset) return false;
        if (outcome === "win") return t.status === "closed" && Number(t.pnl) > 0;
        if (outcome === "loss") return t.status === "closed" && Number(t.pnl) <= 0;
        if (outcome === "open") return t.status === "active" || t.status === "pending";
        return true;
    });
}

function renderTable(): void {
    const tbody = getElement("report-table-body");
    if (!tbody) return;
    const rows = filteredTrades();
    safeText(getElement("report-row-count"), `${rows.length} trade${rows.length === 1 ? "" : "s"}`);
    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="12" class="report-empty">${reportData ? "No trades match the current filter." : "No report loaded."}</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.slice().reverse().map((t) => {
        const pnl = Number(t.pnl) || 0;
        const isClosed = t.status === "closed";
        return `
            <tr>
                <td class="mono muted">${esc(t.id)}</td>
                <td class="mono">${esc(t.timestamp || "—")}</td>
                <td><strong>${esc(t.asset)}</strong></td>
                <td><span class="report-badge ${t.type === "buy" ? "badge-buy" : "badge-sell"}">${esc(String(t.type || "").toUpperCase())}</span></td>
                <td class="mono">${Number(t.quantity || 0).toFixed(4)}</td>
                <td class="mono">${esc(rupees(t.entry_price))}</td>
                <td class="mono">${t.exit_price ? esc(rupees(t.exit_price)) : "—"}</td>
                <td class="mono text-red">${esc(rupees(t.sl))}</td>
                <td class="mono text-green">${esc(rupees(t.target))}</td>
                <td><span class="report-badge badge-${esc(t.status)}">${esc(String(t.status || "").toUpperCase())}</span></td>
                <td class="muted">${esc(t.outcome ? String(t.outcome).toUpperCase() : "—")}</td>
                <td class="mono ta-right ${isClosed ? pnlClass(pnl) : "text-muted"}">${isClosed ? esc(signedRupees(pnl)) : "—"}</td>
            </tr>`;
    }).join("");
}

/**
 * Loads the full performance report for the signed-in account.
 */
export async function loadReport(): Promise<void> {
    if (!store.get("currentUserId")) return;
    const generated = getElement("report-generated");
    if (generated) generated.textContent = "Generating…";
    try {
        reportData = await portfolioService.getReport(store.get("currentUserId"));
    } catch (err: any) {
        if (generated) generated.textContent = "Could not load report";
        const tbody = getElement("report-table-body");
        if (tbody) tbody.innerHTML = `<tr><td colspan="12" class="report-empty text-red">Failed to load the report: ${esc(err.message)}</td></tr>`;
        return;
    }
    safeText(generated, `Generated ${reportData.generated_at}`);

    const assetFilter = getElement<HTMLSelectElement>("report-filter-asset");
    if (assetFilter) {
        const previous = assetFilter.value;
        const assets = [...new Set(reportData.trades.map((t) => t.asset))].sort();
        assetFilter.innerHTML = `<option value="all">All Assets</option>` + assets.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
        if (assets.includes(previous)) assetFilter.value = previous;
    }
    renderKpis(reportData.summary);
    renderEquityCurve(reportData.equity_curve || []);
    renderPnlBars(reportData.equity_curve || []);
    renderWinLoss(reportData.summary);
    renderBreakdown("chart-by-asset", reportData.by_asset || [], "No closed trades to break down by asset.");
    renderBreakdown("chart-by-month", reportData.by_month || [], "No closed trades to break down by month.");
    renderTable();
}

function downloadBlob(content: string, filename: string, mimeType: string): void {
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Exports the report summary and the (filtered) ledger as CSV.
 */
export function exportReportCsv(): void {
    if (!reportData) {
        alert("Load the report first.");
        return;
    }
    const s = reportData.summary;
    const cell = (v: unknown) => {
        const text = String(v === null || v === undefined ? "" : v);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines: string[] = ["ORBIT TRADING TERMINAL - PERFORMANCE REPORT", `Generated,${cell(reportData.generated_at)}`, "", "SUMMARY"];
    ([
        ["Total Trades", s.total_trades], ["Closed Trades", s.closed_trades], ["Open Trades", s.open_trades],
        ["Pending Trades", s.pending_trades], ["Wins", s.wins], ["Losses", s.losses], ["Win Rate %", s.win_rate],
        ["Net Realized P&L", s.net_pnl], ["Gross Profit", s.gross_profit], ["Gross Loss", s.gross_loss],
        ["Profit Factor", s.profit_factor === null ? "N/A (no losses)" : s.profit_factor], ["Expectancy Per Trade", s.expectancy],
        ["Average Win", s.avg_win], ["Average Loss", s.avg_loss], ["Best Trade", s.best_trade], ["Worst Trade", s.worst_trade],
        ["Max Drawdown", s.max_drawdown], ["Max Drawdown %", s.max_drawdown_pct], ["Longest Win Streak", s.longest_win_streak],
        ["Longest Loss Streak", s.longest_loss_streak], ["Unrealized P&L", s.unrealized_pnl]
    ] as Array<[string, unknown]>).forEach(([k, v]) => lines.push(`${cell(k)},${cell(v)}`));
    lines.push("", "TRADE LEDGER", ["ID", "Timestamp", "Asset", "Side", "Quantity", "Entry", "Exit", "Stop Loss", "Target", "Status", "Outcome", "P&L"].join(","));
    filteredTrades().forEach((t) => lines.push([
        t.id, t.timestamp, t.asset, t.type, t.quantity, t.entry_price, t.exit_price ?? "", t.sl, t.target, t.status, t.outcome || "", t.pnl
    ].map(cell).join(",")));
    // The BOM makes Excel read the rupee sign and UTF-8 text correctly.
    downloadBlob("﻿" + lines.join("\r\n"), `orbit-report-${stamp()}.csv`, "text/csv;charset=utf-8");
}

/**
 * Exports the complete report as JSON.
 */
export function exportReportJson(): void {
    if (!reportData) {
        alert("Load the report first.");
        return;
    }
    downloadBlob(JSON.stringify(reportData, null, 2), `orbit-report-${stamp()}.json`, "application/json");
}

/**
 * Prints the report page (the print stylesheet hides everything else).
 */
export function exportReportPdf(): void {
    if (!reportData) return;
    document.body.classList.add("printing-report");
    const cleanup = () => {
        document.body.classList.remove("printing-report");
        window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
    setTimeout(cleanup, 3000);
}

export function initReportsListeners(): void {
    const bind = (id: string, event: string, handler: () => void) => {
        const node = getElement(id);
        if (node && !node.hasAttribute("onclick")) node.addEventListener(event, handler);
    };
    bind("report-refresh-btn", "click", () => void loadReport());
    bind("report-export-csv", "click", exportReportCsv);
    bind("report-export-json", "click", exportReportJson);
    bind("report-export-pdf", "click", exportReportPdf);
    bind("report-filter-asset", "change", renderTable);
    bind("report-filter-outcome", "change", renderTable);
}
