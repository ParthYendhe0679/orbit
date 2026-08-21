"""
news_analyst.py — Real-time news fetching using NewsAPI.org
Primary  : NewsAPI.org  (set NEWS_API_KEY in .env — free at newsapi.org/register)
Fallback : Yahoo Finance RSS (no key needed, but may be blocked occasionally)
Final FB : Keyword-based offline sentiment analysis
"""

import os
import re
import json
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
import numpy as np

import backend.llm as llm

# ---------------------------------------------------------------------------
# Sentiment keyword dictionaries
# ---------------------------------------------------------------------------
BULLISH_WORDS = {
    "up", "rise", "gain", "surge", "growth", "jump", "high", "profit",
    "bull", "rally", "buy", "positive", "exceed", "beat", "strong",
    "higher", "soar", "record", "boom", "outperform", "upgrade",
    "breakout", "momentum", "opportunity", "recover", "rebound"
}
BEARISH_WORDS = {
    "down", "fall", "loss", "drop", "slump", "low", "crash", "bear",
    "sell", "negative", "miss", "warn", "weak", "lower", "plunge",
    "decline", "cut", "risk", "trouble", "fear", "concern", "halt",
    "suspend", "lawsuit", "probe", "investigation", "recession", "layoff"
}

# ---------------------------------------------------------------------------
# Symbol → search query mapping
# ---------------------------------------------------------------------------
SYMBOL_TO_QUERY = {
    # Crypto
    "BTC-USD":  "Bitcoin BTC price",
    "ETH-USD":  "Ethereum ETH price",
    "BNB-USD":  "Binance BNB price",
    "SOL-USD":  "Solana SOL price",
    "XRP-USD":  "Ripple XRP price",
    # US stocks
    "AAPL":     "Apple AAPL stock",
    "GOOGL":    "Google Alphabet GOOGL stock",
    "MSFT":     "Microsoft MSFT stock",
    "AMZN":     "Amazon AMZN stock",
    "TSLA":     "Tesla TSLA stock",
    "NVDA":     "Nvidia NVDA stock",
    "META":     "Meta Platforms META stock",
    # Indian stocks
    "RELIANCE.NS": "Reliance Industries stock",
    "TCS.NS":      "TCS Tata Consultancy stock",
    "INFY.NS":     "Infosys INFY stock",
    "SBIN.NS":     "SBI State Bank India stock",
    "HDFC.NS":     "HDFC Bank stock",
}


def _clean_symbol_for_query(symbol: str) -> str:
    """Turn a raw trading symbol into a readable search query."""
    upper = symbol.upper()
    if upper in SYMBOL_TO_QUERY:
        return SYMBOL_TO_QUERY[upper]
    # Indian stocks
    if upper.endswith(".NS") or upper.endswith(".BO"):
        return upper.replace(".NS", "").replace(".BO", "") + " stock India"
    # Crypto
    if "-USD" in upper:
        base = upper.replace("-USD", "")
        return f"{base} crypto price"
    # Generic
    return f"{symbol} stock market"


# ---------------------------------------------------------------------------
# Source 1: NewsAPI.org
# ---------------------------------------------------------------------------
def _fetch_newsapi(symbol: str, log_func=None) -> list:
    api_key = os.environ.get("NEWS_API_KEY", "").strip()
    if not api_key:
        return []

    query = _clean_symbol_for_query(symbol)
    encoded_query = urllib.parse.quote(query)
    url = (
        f"https://newsapi.org/v2/everything"
        f"?q={encoded_query}"
        f"&language=en"
        f"&sortBy=publishedAt"
        f"&pageSize=15"
        f"&apiKey={api_key}"
    )

    if log_func:
        log_func("News Analyst", f"📡 Fetching live news from NewsAPI.org for '{symbol}'...")

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "OrbitTradingTerminal/1.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        articles = data.get("articles", [])
        headlines = []
        for a in articles:
            title = a.get("title", "") or ""
            link  = a.get("url", "#") or "#"
            source = a.get("source", {}).get("name", "NewsAPI") or "NewsAPI"
            published = (a.get("publishedAt") or "")[:10]   # just the date
            if title and "[Removed]" not in title:
                headlines.append({
                    "title":     title,
                    "link":      link,
                    "source":    source,
                    "published": published,
                })

        if log_func:
            log_func("News Analyst", f"✅ NewsAPI.org returned {len(headlines)} articles.")

        return headlines

    except Exception as e:
        if log_func:
            log_func("News Analyst", f"⚠️ NewsAPI.org failed: {e}. Trying Yahoo Finance RSS...")
        return []


# ---------------------------------------------------------------------------
# Source 2: Yahoo Finance RSS (fallback)
# ---------------------------------------------------------------------------
def _fetch_yahoo_rss(symbol: str, log_func=None) -> list:
    clean_sym = symbol.replace("/", "-")
    rss_url = f"https://finance.yahoo.com/rss/headline?s={clean_sym}"

    if log_func:
        log_func("News Analyst", f"📡 Fetching news from Yahoo Finance RSS for '{symbol}'...")

    try:
        req = urllib.request.Request(
            rss_url,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        )
        with urllib.request.urlopen(req, timeout=6) as response:
            xml_data = response.read()

        root = ET.fromstring(xml_data)
        headlines = []
        for item in root.findall(".//item"):
            title_el = item.find("title")
            link_el  = item.find("link")
            pub_el   = item.find("pubDate")
            if title_el is not None and title_el.text:
                headlines.append({
                    "title":     title_el.text.strip(),
                    "link":      link_el.text if link_el is not None else "#",
                    "source":    "Yahoo Finance",
                    "published": (pub_el.text[:16] if pub_el is not None else ""),
                })

        if log_func:
            log_func("News Analyst", f"✅ Yahoo Finance returned {len(headlines)} articles.")

        return headlines

    except Exception as e:
        if log_func:
            log_func("News Analyst", f"⚠️ Yahoo Finance RSS also failed: {e}. Using fallback data.")
        return []


# ---------------------------------------------------------------------------
# Source 3: Offline simulated fallback (always works)
# ---------------------------------------------------------------------------
def _simulated_headlines(symbol: str) -> list:
    base = symbol.replace("-USD", "").replace(".NS", "").replace(".BO", "")
    return [
        {"title": f"{base} market digests recent price action amid broad volatility", "link": "#", "source": "Simulated", "published": ""},
        {"title": f"Analysts weigh in on {base} outlook as macro conditions shift",   "link": "#", "source": "Simulated", "published": ""},
        {"title": f"Institutional interest in {base} sees steady momentum",            "link": "#", "source": "Simulated", "published": ""},
    ]


# ---------------------------------------------------------------------------
# Public function: get_headlines
# ---------------------------------------------------------------------------
def get_headlines(symbol: str, log_func=None) -> list:
    """
    Fetch real news headlines for a given trading symbol.
    Priority: NewsAPI.org → Yahoo Finance RSS → Simulated fallback
    """
    # Try NewsAPI.org first
    headlines = _fetch_newsapi(symbol, log_func)
    if headlines:
        return headlines

    # Try Yahoo Finance RSS
    headlines = _fetch_yahoo_rss(symbol, log_func)
    if headlines:
        return headlines

    # Offline fallback
    if log_func:
        log_func("News Analyst", "⚠️ All live sources failed. Using simulated headlines.")
    return _simulated_headlines(symbol)


# ---------------------------------------------------------------------------
# Offline keyword-based sentiment scoring
# ---------------------------------------------------------------------------
def analyze_sentiment_offline(headlines: list) -> float:
    scores = []
    for h in headlines:
        text = h["title"].lower()
        words = re.findall(r'\w+', text)
        pos = sum(1 for w in words if w in BULLISH_WORDS)
        neg = sum(1 for w in words if w in BEARISH_WORDS)
        total = pos + neg
        scores.append((pos - neg) / total if total > 0 else 0.0)
    return float(np.mean(scores)) if scores else 0.0


# ---------------------------------------------------------------------------
# Public function: analyze_sentiment (used by main agent pipeline)
# ---------------------------------------------------------------------------
def analyze_sentiment(symbol: str, log_func=None) -> dict:
    headlines = get_headlines(symbol, log_func)
    if not headlines:
        return {"score": 0.0, "headlines": []}

    score = 0.0
    used_gemini = False

    if llm.is_enabled():
        if log_func:
            log_func("News Analyst", "Sending headlines to Google Gemini for contextual sentiment analysis...")

        text_to_analyze = "\n".join([f"- {h['title']}" for h in headlines[:12]])
        prompt = (
            "You are a financial sentiment analyzer. Read these news headlines and output a single score "
            "between -1.0 (extremely bearish) and 1.0 (extremely bullish) representing the aggregate market sentiment. "
            "Output ONLY the numeric score as a float, nothing else.\n\n"
            f"Headlines:\n{text_to_analyze}"
        )

        answer = llm.generate_text(prompt, log_func=log_func, agent_name="News Analyst")
        match = re.search(r"[-+]?\d*\.?\d+", answer) if answer else None
        if match:
            score = float(match.group())
            used_gemini = True
        else:
            # No key, request failed, or the reply had no parsable number —
            # fall back to the lexicon instead of reporting a fake 0.0 score.
            if answer and log_func:
                log_func("News Analyst", f"Could not parse a score from the Gemini reply. Using lexicon.")
            score = analyze_sentiment_offline(headlines)
    else:
        if log_func:
            log_func("News Analyst", "No Gemini API key found. Using offline keyword-based sentiment analysis.")
        score = analyze_sentiment_offline(headlines)

    score = max(-1.0, min(1.0, score))
    label = "BULLISH" if score > 0.15 else "BEARISH" if score < -0.15 else "NEUTRAL"

    if log_func:
        source = "Google Gemini" if used_gemini else "Keyword Lexicon"
        log_func("News Analyst",
                 f"📊 Analyzed {len(headlines)} headlines via {source}. "
                 f"Sentiment: {label} ({score:+.2f})")

    return {"score": score, "headlines": headlines}
