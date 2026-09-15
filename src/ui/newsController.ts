/**
 * ORBIT Trading Terminal — News Controller
 * Dashboard world-market feed (GET /api/news/global) and the terminal's
 * per-symbol ticker (GET /api/news?symbol=). Headlines come from NewsAPI /
 * Yahoo Finance via the ai-service; when no source answers the panel says so.
 */

import { marketService } from "../services/marketService";
import { NewsHeadline } from "../types/market";
import { esc } from "../utils/formatters";
import { getElement } from "../utils/dom";

let scrollRAF: number | null = null;
let scrollPos = 0;
let scrollPaused = false;
let scrollEl: HTMLElement | null = null;
const boundFeeds = new WeakSet<HTMLElement>();

let cachedGlobal: NewsHeadline[] | null = null;
const symbolCache: Record<string, NewsHeadline[]> = {};

// A cold provider fetch (NewsAPI, then the Yahoo RSS fallback) plus a busy
// server can legitimately outrun a short deadline, so give each attempt room
// and retry instead of leaving a dead-end error on screen.
const NEWS_TIMEOUT_MS = 20000;
const NEWS_RETRY_DELAYS_MS = [1500, 4000];
const SYMBOL_NEWS_REFRESH_MS = 180000; // matches the ai-service headline cache TTL

let symbolRefreshTimer: number | null = null;
let symbolRequestId = 0;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * One news request with a deadline. The timer is cleared on every exit path so
 * a slow-but-successful response never aborts a later attempt.
 */
async function requestHeadlines(fetcher: (signal: AbortSignal) => Promise<NewsHeadline[]>): Promise<NewsHeadline[]> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), NEWS_TIMEOUT_MS);
    try {
        return await fetcher(controller.signal);
    } finally {
        window.clearTimeout(timer);
    }
}

/** Retries a news request a couple of times before giving up on the panel. */
async function requestHeadlinesWithRetry(
    fetcher: (signal: AbortSignal) => Promise<NewsHeadline[]>,
    label: string,
    isStale: () => boolean
): Promise<NewsHeadline[]> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= NEWS_RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) {
            await delay(NEWS_RETRY_DELAYS_MS[attempt - 1]);
            if (isStale()) return [];
        }
        try {
            return await requestHeadlines(fetcher);
        } catch (err) {
            lastErr = err;
            if (isStale()) return [];
            console.warn(`[News] ${label} attempt ${attempt + 1} failed:`, err);
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`${label} unavailable`);
}

function stopNewsScroll(): void {
    if (scrollRAF !== null) {
        cancelAnimationFrame(scrollRAF);
        scrollRAF = null;
    }
    scrollEl = null;
}

function autoScrollStep(): void {
    if (scrollEl && !scrollPaused) {
        scrollPos += 0.35;
        const mid = scrollEl.scrollHeight / 2;
        if (mid > 0 && scrollPos >= mid) scrollPos = 0;
        scrollEl.scrollTop = scrollPos;
    }
    scrollRAF = requestAnimationFrame(autoScrollStep);
}

function sentimentBadge(sentiment: string | undefined): string {
    if (sentiment === "bullish") return "badge-green";
    if (sentiment === "bearish") return "badge-red";
    return "badge-yellow";
}

/** Renders the dashboard feed as a slowly auto-scrolling, pausable list. */
export function renderGlobalNewsHeadlines(headlines: NewsHeadline[]): void {
    const feed = getElement("news-feed-container");
    if (!feed) return;
    stopNewsScroll();
    scrollPos = 0;
    feed.scrollTop = 0;

    if (!headlines.length) {
        feed.innerHTML = `<div class="news-loading">No global headlines available right now.</div>`;
        return;
    }

    const cards = headlines
        .map((item) => {
            const date = item.published ? ` · ${item.published}` : "";
            const href = item.link && item.link !== "#" ? item.link : "";
            return `
            <a class="news-item-card" ${href ? `href="${esc(href)}" target="_blank" rel="noopener noreferrer"` : ""}>
                <div class="news-item-main">
                    <h3 class="news-item-title">${esc(item.title)}</h3>
                    <div class="news-item-meta">
                        <i class="fa-solid fa-newspaper"></i>
                        <span>${esc(item.source || "")}${esc(date)}</span>
                    </div>
                </div>
                <span class="badge ${sentimentBadge(item.sentiment)}">${esc((item.sentiment || "neutral").toUpperCase())}</span>
            </a>`;
        })
        .join("");

    // Seamless loop: the list is duplicated once and the scroll wraps at the midpoint.
    feed.innerHTML = headlines.length > 2 ? cards + cards : cards;
    if (headlines.length > 2) {
        if (!boundFeeds.has(feed)) {
            boundFeeds.add(feed);
            feed.addEventListener("mouseenter", () => { scrollPaused = true; }, { passive: true });
            feed.addEventListener("mouseleave", () => { scrollPaused = false; }, { passive: true });
            feed.addEventListener("scroll", () => {
                if (scrollPaused && scrollEl) scrollPos = scrollEl.scrollTop;
            }, { passive: true });
        }
        scrollEl = feed;
        scrollPaused = false;
        scrollRAF = requestAnimationFrame(autoScrollStep);
    }
}

/** Loads the dashboard's world-market headlines. */
export async function fetchGlobalNews(): Promise<void> {
    const feed = getElement("news-feed-container");
    if (!feed) return;
    if (cachedGlobal && cachedGlobal.length) {
        renderGlobalNewsHeadlines(cachedGlobal);
    } else {
        stopNewsScroll();
        feed.innerHTML = `<div class="news-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading market news…</div>`;
    }

    try {
        const headlines = await requestHeadlinesWithRetry(
            (signal) => marketService.getGlobalNews(signal),
            "Global news",
            () => false
        );
        if (headlines.length) {
            cachedGlobal = headlines;
            renderGlobalNewsHeadlines(headlines);
        } else if (!cachedGlobal) {
            feed.innerHTML = `<div class="news-loading">No global headlines available right now.</div>`;
        }
    } catch (err) {
        console.warn("[News] Global news unavailable:", err);
        if (!cachedGlobal) {
            feed.innerHTML = `<div class="news-loading">⚠️ Could not load world market news. <button type="button" class="news-retry-btn" data-news-retry="global">Retry</button></div>`;
        }
    }
}

function renderSymbolHeadlines(headlines: NewsHeadline[], ticker: HTMLElement, symbol: string): void {
    if (!headlines.length) {
        ticker.innerHTML = `<span class="news-ticker-loading">No news found for ${esc(symbol)}.</span>`;
        ticker.style.animation = "none";
        return;
    }
    const rows = headlines
        .map((item) => {
            const href = item.link && item.link !== "#" ? item.link : "";
            return `
            <a class="atv-news-item" ${href ? `href="${esc(href)}" target="_blank" rel="noopener noreferrer"` : ""}>
                <span class="atv-news-sentiment-dot ${esc(item.sentiment || "neutral")}"></span>
                <span class="atv-news-title">${esc(item.title)}</span>
                <span class="atv-news-source">${esc(item.source || "")}</span>
            </a>`;
        })
        .join("");
    ticker.innerHTML = rows + rows;
    // ~14 px per second, a comfortable reading speed.
    const duration = Math.max(50, Math.floor(ticker.scrollHeight / 2 / 14));
    ticker.style.animation = `newsScrollUp ${duration}s linear infinite`;
}

/** Stops the terminal ticker's periodic refresh (on symbol change or exit). */
export function stopSymbolNewsRefresh(): void {
    if (symbolRefreshTimer !== null) {
        window.clearInterval(symbolRefreshTimer);
        symbolRefreshTimer = null;
    }
    symbolRequestId++;
}

/**
 * Loads the terminal's news ticker for one symbol, retrying a transient
 * failure and then refreshing on a timer, so a single slow response no longer
 * leaves "Could not load news" on screen until the user switches symbols.
 */
export async function fetchSymbolNews(symbol: string): Promise<void> {
    const ticker = getElement("atv-news-scroll");
    if (!ticker || !symbol) return;
    const key = symbol.toUpperCase();

    stopSymbolNewsRefresh();
    const requestId = symbolRequestId;
    const isStale = () => requestId !== symbolRequestId;

    if (symbolCache[key]?.length) {
        renderSymbolHeadlines(symbolCache[key], ticker, symbol);
    } else {
        ticker.innerHTML = `<span class="news-ticker-loading">📡 Fetching news for ${esc(symbol)}…</span>`;
        ticker.style.animation = "none";
    }

    try {
        const headlines = await requestHeadlinesWithRetry(
            (signal) => marketService.getSymbolNews(symbol, signal),
            `${symbol} news`,
            isStale
        );
        if (isStale()) return;
        if (headlines.length) symbolCache[key] = headlines;
        if (headlines.length || !symbolCache[key]) renderSymbolHeadlines(headlines, ticker, symbol);
    } catch (err) {
        if (isStale()) return;
        console.warn(`[News] ${symbol} news unavailable:`, err);
        if (!symbolCache[key]?.length) {
            ticker.style.animation = "none";
            ticker.innerHTML =
                `<span class="news-ticker-loading">⚠️ Could not load news for ${esc(symbol)}. ` +
                `<button type="button" class="news-retry-btn" data-news-retry="${esc(key)}">Retry</button></span>`;
        }
    }

    // Keep the ticker current for as long as this symbol stays selected.
    if (!isStale()) {
        symbolRefreshTimer = window.setInterval(() => {
            if (isStale()) return;
            marketService
                .getSymbolNews(symbol)
                .then((fresh) => {
                    if (isStale() || !fresh.length) return;
                    symbolCache[key] = fresh;
                    const el = getElement("atv-news-scroll");
                    if (el) renderSymbolHeadlines(fresh, el, symbol);
                })
                .catch((err) => console.warn(`[News] ${symbol} refresh skipped:`, err));
        }, SYMBOL_NEWS_REFRESH_MS);
    }
}

/**
 * Retry buttons rendered into the news panels. Delegated from the document so
 * the handler survives every re-render of the panel contents.
 */
document.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest?.("[data-news-retry]") as HTMLElement | null;
    if (!btn) return;
    ev.preventDefault();
    const target = btn.getAttribute("data-news-retry") || "";
    if (target === "global") {
        cachedGlobal = null;
        void fetchGlobalNews();
    } else if (target) {
        delete symbolCache[target];
        void fetchSymbolNews(target);
    }
});
