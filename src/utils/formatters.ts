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
 * Renders the inline Markdown inside a single line: code spans, links, bold
 * and italic. Everything is HTML-escaped first, so the result is safe to
 * inject — the only tags present are the ones produced here.
 */
function formatInlineMarkdown(text: string): string {
    // Code spans are lifted out before escaping so their contents are shown
    // literally instead of being re-parsed as bold/italic.
    const codeSpans: string[] = [];
    let s = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
        codeSpans.push(esc(code));
        return `\u0000CODE${codeSpans.length - 1}\u0000`;
    });

    s = esc(s);

    // [label](https://example.com)
    s = s.replace(
        /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );

    // Bold runs first so ** is never eaten by the single-asterisk italic rule.
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");

    return s.replace(
        /\u0000CODE(\d+)\u0000/g,
        (_match, i: string) => `<code class="copilot-inline-code">${codeSpans[Number(i)]}</code>`
    );
}

/** Splits "| a | b |" into its cells. */
function markdownTableCells(line: string): string[] {
    return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

/**
 * Formats a Markdown Copilot answer into safe semantic HTML.
 *
 * Block-level syntax is parsed line by line rather than with a pile of global
 * regexes, so headings (`### WHY`) and rules (`---`) become real elements
 * instead of leaking into the chat as raw characters.
 */
export function formatCopilotMarkdown(raw: string): string {
    if (!raw) return "";

    const lines = String(raw).replace(/\r\n?/g, "\n").split("\n");
    const out: string[] = [];
    let paragraph: string[] = [];
    let quote: string[] = [];
    let listTag: "ul" | "ol" | null = null;

    const closeParagraph = (): void => {
        if (paragraph.length) {
            out.push(`<p>${paragraph.join("<br>")}</p>`);
            paragraph = [];
        }
    };
    const closeQuote = (): void => {
        if (quote.length) {
            out.push(`<blockquote class="copilot-quote">${quote.join("<br>")}</blockquote>`);
            quote = [];
        }
    };
    const closeList = (): void => {
        if (listTag) {
            out.push(`</${listTag}>`);
            listTag = null;
        }
    };
    const closeAll = (): void => {
        closeParagraph();
        closeQuote();
        closeList();
    };
    const openList = (tag: "ul" | "ol"): void => {
        if (listTag === tag) return;
        closeList();
        out.push(`<${tag} class="copilot-list">`);
        listTag = tag;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // ``` fenced code block ```
        if (line.startsWith("```")) {
            closeAll();
            const body: string[] = [];
            i++;
            while (i < lines.length && !lines[i].trim().startsWith("```")) {
                body.push(lines[i]);
                i++;
            }
            out.push(`<pre class="copilot-code-block"><code>${esc(body.join("\n"))}</code></pre>`);
            continue;
        }

        // A blank line closes whatever block is open.
        if (!line) {
            closeAll();
            continue;
        }

        // Horizontal rule — checked before lists so "---" is never read as a bullet.
        if (/^(?:-{3,}|\*{3,}|_{3,}|={3,})$/.test(line)) {
            closeAll();
            out.push('<hr class="copilot-rule">');
            continue;
        }

        // # Heading … ###### Heading
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            closeAll();
            const level = heading[1].length;
            const tag = level <= 1 ? "h2" : level >= 4 ? "h4" : "h3";
            const title = heading[2].replace(/\s*#+\s*$/, "");
            out.push(`<${tag}>${formatInlineMarkdown(title)}</${tag}>`);
            continue;
        }

        // | table | with | a header separator row underneath
        if (/^\|.*\|$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
            closeAll();
            const headers = markdownTableCells(line);
            const rows: string[][] = [];
            i += 2;
            while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
                rows.push(markdownTableCells(lines[i]));
                i++;
            }
            i--;
            const head = headers.map((h) => `<th>${formatInlineMarkdown(h)}</th>`).join("");
            const body = rows
                .map((r) => `<tr>${r.map((c) => `<td>${formatInlineMarkdown(c)}</td>`).join("")}</tr>`)
                .join("");
            out.push(`<table class="copilot-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
            continue;
        }

        // - bullet / * bullet / • bullet
        const bullet = /^[-*+\u2022]\s+(.*)$/.exec(line);
        if (bullet) {
            closeParagraph();
            closeQuote();
            openList("ul");
            out.push(`<li class="copilot-bullet-item">${formatInlineMarkdown(bullet[1])}</li>`);
            continue;
        }

        // 1. numbered / 1) numbered
        const numbered = /^\d{1,3}[.)]\s+(.*)$/.exec(line);
        if (numbered) {
            closeParagraph();
            closeQuote();
            openList("ol");
            out.push(`<li class="copilot-numbered-item">${formatInlineMarkdown(numbered[1])}</li>`);
            continue;
        }

        // > quote
        const blockquote = /^>\s?(.*)$/.exec(line);
        if (blockquote) {
            closeParagraph();
            closeList();
            quote.push(formatInlineMarkdown(blockquote[1]));
            continue;
        }

        closeQuote();
        closeList();
        paragraph.push(formatInlineMarkdown(line));
    }

    closeAll();
    return out.join("");
}
