/**
 * ORBIT Trading Terminal — String & Value Formatting Utilities
 */

/**
 * Escapes unsafe characters for HTML injection to prevent XSS.
 */
export function esc(value: unknown): string {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Formats a currency value into Indian Rupee (INR) representation.
 */
export function formatINR(number: number): string {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 2
    }).format(number);
}

/**
 * Formats an authoritative amount, or "—" when the value is missing — never a
 * made-up default or "₹NaN".
 */
export function formatINRSafe(value: unknown): string {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    return Number.isFinite(n) ? formatINR(n) : "—";
}

/** Signed variant of formatINRSafe ("+₹1,200.00" / "-₹40.00" / "—"). */
export function formatSignedINR(value: unknown): string {
    const text = formatINRSafe(value);
    return text !== "—" && Number(value) >= 0 ? `+${text}` : text;
}

/**
 * Formats a percentage value with signed symbol (+/-).
 */
export function formatPercent(value: number, decimals: number = 2): string {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(decimals)}%`;
}

/**
 * Formats an ISO date string or timestamp into a short localized string.
 */
export function formatDateTime(dateStr?: string | number | null): string {
    if (!dateStr) return "—";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

/**
 * Formats Markdown syntax in AI Copilot responses into safe semantic HTML.
 */
export function formatCopilotMarkdown(raw: string): string {
    if (!raw) return "";
    let formatted = esc(raw);

    // Bold text (**text**)
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

    // Italic text (*text*)
    formatted = formatted.replace(/\*(.*?)\*/g, "<em>$1</em>");

    // Inline code (`code`)
    formatted = formatted.replace(/`([^`]+)`/g, '<code class="copilot-inline-code">$1</code>');

    // Bullet points (- item or * item)
    formatted = formatted.replace(/^[\*\-]\s+(.+)$/gm, '<li class="copilot-bullet-item">$1</li>');

    // Numbered lists (1. item)
    formatted = formatted.replace(/^\d+\.\s+(.+)$/gm, '<li class="copilot-numbered-item">$1</li>');

    // Wrap consecutive list items in <ul> or <ol>
    formatted = formatted.replace(/(<li class="copilot-bullet-item">.*?<\/li>)+/gs, '<ul class="copilot-list">$&</ul>');
    formatted = formatted.replace(/(<li class="copilot-numbered-item">.*?<\/li>)+/gs, '<ol class="copilot-list">$&</ol>');

    // Paragraph line breaks
    formatted = formatted.replace(/\n\n/g, "<br><br>");

    return formatted;
}
