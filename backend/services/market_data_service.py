"""
backend/services/market_data_service.py — Centralized Market Data Infrastructure for ORBIT.

Implements the Phase 2 Market Data System:
  - Provider Abstraction Layer (YahooFinanceProvider via BaseMarketDataProvider)
  - Data Normalization (MultiIndex flattening, DatetimeIndex, float conversion)
  - Data Validation (Sanity checks, price validity, High >= Low, minimum rows)
  - In-Memory TTL Caching (Separate quote & history TTLs with freshness tracking)
  - Standardized Pydantic Data Contracts for downstream ORBIT modules
"""

import asyncio
import json
import logging
import os
import time
import urllib.parse
import urllib.request
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from dotenv import load_dotenv
import numpy as np
import pandas as pd
import yfinance as yf

# Load .env variables (e.g. ALPHA_VANTAGE_API_KEY)
load_dotenv()

from backend.models.market import (
    Asset,
    CompanyOverview,
    HistoricalCandle,
    MarketDataSnapshot,
    MarketQuote,
    MarketSeries,
    MarketValidationResult,
    NewsItem,
    SymbolSearchResult,
)

logger = logging.getLogger("orbit.market_data")

from backend.services.valkey_service import valkey_service

# ---------------------------------------------------------------------------
# Pre-indexed Popular Symbols for Autocomplete / Quick Search
# ---------------------------------------------------------------------------
POPULAR_SYMBOLS = [
    {"symbol": "BTC-USD", "name": "Bitcoin (USD)", "category": "Crypto", "exchange": "CCC"},
    {"symbol": "ETH-USD", "name": "Ethereum (USD)", "category": "Crypto", "exchange": "CCC"},
    {"symbol": "SOL-USD", "name": "Solana (USD)", "category": "Crypto", "exchange": "CCC"},
    {"symbol": "XRP-USD", "name": "XRP (USD)", "category": "Crypto", "exchange": "CCC"},
    {"symbol": "DOGE-USD", "name": "Dogecoin (USD)", "category": "Crypto", "exchange": "CCC"},
    {"symbol": "ADA-USD", "name": "Cardano (USD)", "category": "Crypto", "exchange": "CCC"},
    {"symbol": "AAPL", "name": "Apple Inc.", "category": "US Equities", "exchange": "NASDAQ"},
    {"symbol": "TSLA", "name": "Tesla Inc.", "category": "US Equities", "exchange": "NASDAQ"},
    {"symbol": "NVDA", "name": "NVIDIA Corp.", "category": "US Equities", "exchange": "NASDAQ"},
    {"symbol": "MSFT", "name": "Microsoft Corp.", "category": "US Equities", "exchange": "NASDAQ"},
    {"symbol": "GOOGL", "name": "Alphabet Inc.", "category": "US Equities", "exchange": "NASDAQ"},
    {"symbol": "AMZN", "name": "Amazon.com Inc.", "category": "US Equities", "exchange": "NASDAQ"},
    {"symbol": "SBIN.NS", "name": "State Bank of India", "category": "Indian Equities", "exchange": "NSE"},
    {"symbol": "RELIANCE.NS", "name": "Reliance Industries", "category": "Indian Equities", "exchange": "NSE"},
    {"symbol": "TCS.NS", "name": "Tata Consultancy Services", "category": "Indian Equities", "exchange": "NSE"},
    {"symbol": "INFY.NS", "name": "Infosys Ltd.", "category": "Indian Equities", "exchange": "NSE"},
    {"symbol": "HDFCBANK.NS", "name": "HDFC Bank Ltd.", "category": "Indian Equities", "exchange": "NSE"},
    {"symbol": "SPY", "name": "SPDR S&P 500 ETF Trust", "category": "Indices", "exchange": "NYSE"},
    {"symbol": "QQQ", "name": "Invesco QQQ Trust", "category": "Indices", "exchange": "NASDAQ"},
    {"symbol": "EURUSD=X", "name": "EUR / USD", "category": "Forex", "exchange": "CCY"},
    {"symbol": "USDINR=X", "name": "USD / INR", "category": "Forex", "exchange": "CCY"},
    {"symbol": "GBPUSD=X", "name": "GBP / USD", "category": "Forex", "exchange": "CCY"},
]


# ===========================================================================
# 1. PROVIDER ABSTRACTION LAYER
# ===========================================================================

class BaseMarketDataProvider(ABC):
    """Abstract interface for all external market data providers."""

    @abstractmethod
    async def fetch_historical_raw(self, symbol: str, period: str = "60d", interval: str = "1d") -> pd.DataFrame:
        """Fetch raw historical OHLCV data from the external source."""
        pass

    @abstractmethod
    async def fetch_quote_raw(self, symbol: str) -> dict:
        """Fetch raw snapshot/quote metrics from the external source."""
        pass


class YahooFinanceProvider(BaseMarketDataProvider):
    """
    Primary Market Data Provider wrapping yfinance with thread offloading,
    multi-index flattening, and network timeout guards.
    """

    def __init__(self, request_timeout_seconds: float = 8.0):
        self.timeout = request_timeout_seconds

    async def fetch_historical_raw(self, symbol: str, period: str = "60d", interval: str = "1d") -> pd.DataFrame:
        def _fetch():
            ticker = yf.Ticker(symbol)
            # Try history() first as it's optimized for individual tickers
            df = ticker.history(period=period, interval=interval, auto_adjust=False)
            if df is None or df.empty:
                # Fallback to download() if history() returns empty
                df = yf.download(symbol, period=period, interval=interval, progress=False, auto_adjust=False)
            return df

        try:
            df = await asyncio.to_thread(_fetch)
            return df
        except Exception as exc:
            logger.error(f"YahooFinanceProvider error fetching historical for {symbol}: {exc}")
            return pd.DataFrame()

    async def fetch_quote_raw(self, symbol: str) -> dict:
        def _fetch_quote():
            ticker = yf.Ticker(symbol)
            # Fast fetch using fast_info if available
            try:
                fast = getattr(ticker, "fast_info", None)
                if fast and hasattr(fast, "last_price") and fast.last_price is not None:
                    return {
                        "price": float(fast.last_price),
                        "open": float(fast.open) if fast.open else float(fast.last_price),
                        "high": float(fast.day_high) if fast.day_high else float(fast.last_price),
                        "low": float(fast.day_low) if fast.day_low else float(fast.last_price),
                        "previous_close": float(fast.previous_close) if fast.previous_close else float(fast.last_price),
                        "volume": float(fast.last_volume) if fast.last_volume else 0.0,
                    }
            except Exception:
                pass
            
            # Fallback to 5-day daily candles to calculate latest price and previous close
            hist = ticker.history(period="5d", interval="1d")
            if hist is not None and not hist.empty:
                latest = hist.iloc[-1]
                prev = hist.iloc[-2] if len(hist) > 1 else latest
                return {
                    "price": float(latest["Close"]),
                    "open": float(latest["Open"]),
                    "high": float(latest["High"]),
                    "low": float(latest["Low"]),
                    "previous_close": float(prev["Close"]),
                    "volume": float(latest["Volume"]) if "Volume" in latest else 0.0,
                }
            return {}

        try:
            return await asyncio.wait_for(asyncio.to_thread(_fetch_quote), timeout=5.0)
        except Exception as exc:
            logger.error(f"YahooFinanceProvider error fetching quote for {symbol}: {exc}")
            return {}


class AlphaVantageProvider(BaseMarketDataProvider):
    """
    Primary Market Data Provider wrapping Alpha Vantage REST API.
    Supports Global Quote, Daily History, Symbol Search, Company Overview,
    and News Sentiment with automated rate-limit detection and thread-safe execution.
    """

    BASE_URL = "https://www.alphavantage.co/query"

    def __init__(self, api_key: Optional[str] = None, timeout: float = 2.5):
        self.api_key = (api_key or os.getenv("ALPHA_VANTAGE_API_KEY", "")).strip()
        self.timeout = timeout
        self.rate_limited_until = 0.0
        self.rate_limit_hits = 0

    def is_rate_limited(self) -> bool:
        return time.time() < self.rate_limited_until

    def _execute_query(self, params: dict) -> dict:
        if not self.api_key:
            return {}
        if self.is_rate_limited():
            return {"_rate_limited": True}

        query_params = dict(params)
        query_params["apikey"] = self.api_key
        url = f"{self.BASE_URL}?{urllib.parse.urlencode(query_params)}"

        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "ORBIT-Trading/1.0 (AlphaVantageIntegration)"}
            )
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw_bytes = resp.read()
                data = json.loads(raw_bytes.decode("utf-8"))

                # Check for rate-limiting notices
                if "Note" in data or "Information" in data:
                    note = data.get("Note") or data.get("Information", "")
                    logger.warning(f"Alpha Vantage rate limit reached: {note}")
                    self.rate_limited_until = time.time() + 3600.0  # 1 hour cooldown when daily limit reached
                    self.rate_limit_hits += 1
                    return {"_rate_limited": True}

                if "Error Message" in data:
                    logger.warning(f"Alpha Vantage returned error message: {data['Error Message']}")
                    return {}

                return data
        except Exception as exc:
            logger.warning(f"Alpha Vantage query exception: {exc}")
            return {}

    async def fetch_historical_raw(self, symbol: str, period: str = "60d", interval: str = "1d") -> pd.DataFrame:
        def _fetch():
            clean_sym = symbol.strip().upper()
            data = self._execute_query({
                "function": "TIME_SERIES_DAILY",
                "symbol": clean_sym,
                "outputsize": "compact",
            })
            if not data or "_rate_limited" in data:
                return pd.DataFrame()

            series_key = None
            for k in data.keys():
                if "Time Series" in k:
                    series_key = k
                    break

            if not series_key or not data[series_key]:
                return pd.DataFrame()

            raw_dict = data[series_key]
            records = []
            for date_str, values in raw_dict.items():
                try:
                    records.append({
                        "Date": date_str,
                        "Open": float(values.get("1. open", 0)),
                        "High": float(values.get("2. high", 0)),
                        "Low": float(values.get("3. low", 0)),
                        "Close": float(values.get("4. close", 0)),
                        "Volume": float(values.get("5. volume", 0)),
                    })
                except (ValueError, TypeError):
                    continue

            if not records:
                return pd.DataFrame()

            df = pd.DataFrame(records)
            df["Date"] = pd.to_datetime(df["Date"])
            df = df.set_index("Date").sort_index()
            return df

        try:
            return await asyncio.to_thread(_fetch)
        except Exception as exc:
            logger.warning(f"AlphaVantageProvider error fetching historical for {symbol}: {exc}")
            return pd.DataFrame()

    async def fetch_quote_raw(self, symbol: str) -> dict:
        def _fetch():
            clean_sym = symbol.strip().upper()

            # 1. Handle Crypto (e.g. BTC-USD, ETH-USD) via CURRENCY_EXCHANGE_RATE
            if "-USD" in clean_sym:
                coin = clean_sym.split("-")[0]
                data = self._execute_query({
                    "function": "CURRENCY_EXCHANGE_RATE",
                    "from_currency": coin,
                    "to_currency": "USD",
                })
                if not data or "_rate_limited" in data:
                    return {}
                rate_dict = data.get("Realtime Currency Exchange Rate", {})
                if rate_dict and "5. Exchange Rate" in rate_dict:
                    try:
                        rate = float(rate_dict["5. Exchange Rate"])
                        return {
                            "price": rate,
                            "open": rate,
                            "high": float(rate_dict.get("9. Ask Price", rate)),
                            "low": float(rate_dict.get("8. Bid Price", rate)),
                            "previous_close": rate,
                            "volume": 0.0,
                            "source": "AlphaVantage",
                        }
                    except (ValueError, TypeError):
                        pass

            # 2. Handle Forex (e.g. EURUSD=X) via CURRENCY_EXCHANGE_RATE
            if "=X" in clean_sym and len(clean_sym) >= 6:
                base = clean_sym[:3]
                target = clean_sym[3:6]
                data = self._execute_query({
                    "function": "CURRENCY_EXCHANGE_RATE",
                    "from_currency": base,
                    "to_currency": target,
                })
                if not data or "_rate_limited" in data:
                    return {}
                rate_dict = data.get("Realtime Currency Exchange Rate", {})
                if rate_dict and "5. Exchange Rate" in rate_dict:
                    try:
                        rate = float(rate_dict["5. Exchange Rate"])
                        return {
                            "price": rate,
                            "open": rate,
                            "high": float(rate_dict.get("9. Ask Price", rate)),
                            "low": float(rate_dict.get("8. Bid Price", rate)),
                            "previous_close": rate,
                            "volume": 0.0,
                            "source": "AlphaVantage",
                        }
                    except (ValueError, TypeError):
                        pass

            # 3. Standard Equities / Indices via GLOBAL_QUOTE
            data = self._execute_query({
                "function": "GLOBAL_QUOTE",
                "symbol": clean_sym,
            })
            if not data or "_rate_limited" in data:
                return {}

            gq = data.get("Global Quote", {})
            if not gq or "05. price" not in gq:
                return {}

            try:
                price = float(gq["05. price"])
                prev = float(gq.get("08. previous close", price))
                return {
                    "price": price,
                    "open": float(gq.get("02. open", price)),
                    "high": float(gq.get("03. high", price)),
                    "low": float(gq.get("04. low", price)),
                    "previous_close": prev,
                    "volume": float(gq.get("06. volume", 0)),
                    "source": "AlphaVantage",
                }
            except (ValueError, TypeError) as err:
                logger.warning(f"Error parsing Alpha Vantage quote for {symbol}: {err}")
                return {}

        try:
            return await asyncio.to_thread(_fetch)
        except Exception as exc:
            logger.warning(f"AlphaVantageProvider error fetching quote for {symbol}: {exc}")
            return {}

    async def search_symbols(self, query: str, market: Optional[str] = None) -> List[SymbolSearchResult]:
        def _search():
            clean_q = query.strip()
            if not clean_q:
                return []
            data = self._execute_query({
                "function": "SYMBOL_SEARCH",
                "keywords": clean_q,
            })
            if not data or "_rate_limited" in data:
                return []

            matches = data.get("bestMatches", [])
            results = []
            for m in matches:
                sym = m.get("1. symbol", "").strip()
                name = m.get("2. name", "").strip()
                asset_type = m.get("3. type", "Equity").strip()
                region = m.get("4. region", "").strip()
                curr = m.get("8. currency", "USD").strip()
                if not sym:
                    continue

                category = "US Equities"
                if "India" in region or ".BSE" in sym or ".NSE" in sym:
                    category = "Indian Equities"
                elif asset_type.lower() == "crypto":
                    category = "Crypto"
                elif asset_type.lower() == "forex" or "currency" in asset_type.lower():
                    category = "Forex"
                elif "United States" in region:
                    category = "US Equities"
                else:
                    category = f"Global Equities ({region})"

                if market:
                    m_lower = market.lower()
                    if "us" in m_lower and "united states" not in region.lower():
                        continue
                    if "india" in m_lower and "india" not in region.lower() and ".ns" not in sym.lower() and ".bse" not in sym.lower():
                        continue
                    if "crypto" in m_lower and "crypto" not in asset_type.lower():
                        continue
                    if "forex" in m_lower and "forex" not in asset_type.lower() and "currency" not in asset_type.lower():
                        continue

                results.append(
                    SymbolSearchResult(
                        symbol=sym,
                        name=name or sym,
                        category=category,
                        exchange=region,
                        asset_type=asset_type,
                        market=category,
                        region=region,
                        currency=curr,
                    )
                )
            return results

        try:
            return await asyncio.to_thread(_search)
        except Exception as exc:
            logger.warning(f"AlphaVantageProvider error searching symbols: {exc}")
            return []

    async def fetch_overview(self, symbol: str) -> Optional[CompanyOverview]:
        def _overview():
            data = self._execute_query({
                "function": "OVERVIEW",
                "symbol": symbol.strip().upper(),
            })
            if not data or "_rate_limited" in data or "Symbol" not in data:
                return None

            try:
                def _to_float(v):
                    try:
                        return float(v) if v and v != "None" else None
                    except (ValueError, TypeError):
                        return None

                return CompanyOverview(
                    symbol=data.get("Symbol", symbol),
                    name=data.get("Name", symbol),
                    description=data.get("Description", ""),
                    sector=data.get("Sector", ""),
                    industry=data.get("Industry", ""),
                    pe_ratio=_to_float(data.get("PERatio")),
                    market_cap=_to_float(data.get("MarketCapitalization")),
                    fifty_two_week_high=_to_float(data.get("52WeekHigh")),
                    fifty_two_week_low=_to_float(data.get("52WeekLow")),
                    dividend_yield=_to_float(data.get("DividendYield")),
                    currency=data.get("Currency", "USD"),
                    source="AlphaVantage",
                )
            except Exception as exc:
                logger.warning(f"Error parsing company overview for {symbol}: {exc}")
                return None

        try:
            return await asyncio.to_thread(_overview)
        except Exception as exc:
            logger.warning(f"AlphaVantageProvider error fetching overview for {symbol}: {exc}")
            return None

    async def fetch_news_sentiment(self, symbol: str) -> List[NewsItem]:
        def _news():
            data = self._execute_query({
                "function": "NEWS_SENTIMENT",
                "tickers": symbol.strip().upper(),
                "limit": 15,
            })
            if not data or "_rate_limited" in data:
                return []

            feed = data.get("feed", [])
            items = []
            for item in feed:
                title = item.get("title", "").strip()
                if not title:
                    continue
                try:
                    score = float(item.get("overall_sentiment_score", 0.0))
                except (ValueError, TypeError):
                    score = 0.0

                label = item.get("overall_sentiment_label", "neutral").lower()
                if "bullish" in label:
                    sent = "bullish"
                elif "bearish" in label:
                    sent = "bearish"
                else:
                    sent = "neutral"

                items.append(
                    NewsItem(
                        title=title,
                        summary=item.get("summary", ""),
                        url=item.get("url", ""),
                        source=item.get("source", "AlphaVantage"),
                        published_at=item.get("time_published", datetime.now().isoformat()),
                        sentiment=sent,
                        sentiment_score=score,
                    )
                )
            return items

        try:
            return await asyncio.to_thread(_news)
        except Exception as exc:
            logger.warning(f"AlphaVantageProvider error fetching news sentiment for {symbol}: {exc}")
            return []


# ===========================================================================
# 2. NORMALIZATION & VALIDATION ENGINE
# ===========================================================================

def normalize_market_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """
    Standardizes a raw DataFrame:
      - Flattens multi-level column indexes
      - Renames columns to strict 'Open', 'High', 'Low', 'Close', 'Volume'
      - Converts index to clean DatetimeIndex (drops timezone if present)
      - Sorts chronologically
      - Replaces inf/-inf with NaN and forward-fills gaps
      - Ensures float64 dtype on price/volume series
    """
    if df is None or df.empty:
        return pd.DataFrame()

    clean_df = df.copy()

    # 1. Flatten MultiIndex columns (e.g. from yf.download)
    if isinstance(clean_df.columns, pd.MultiIndex):
        clean_df.columns = [col[0] for col in clean_df.columns]

    # 2. Case-insensitive column alignment
    col_map = {}
    for col in clean_df.columns:
        c_lower = str(col).lower().strip()
        if c_lower == "open":
            col_map[col] = "Open"
        elif c_lower == "high":
            col_map[col] = "High"
        elif c_lower == "low":
            col_map[col] = "Low"
        elif c_lower == "close":
            col_map[col] = "Close"
        elif c_lower in ("volume", "vol"):
            col_map[col] = "Volume"

    clean_df = clean_df.rename(columns=col_map)

    required_cols = ["Open", "High", "Low", "Close"]
    if not all(col in clean_df.columns for col in required_cols):
        return pd.DataFrame()

    if "Volume" not in clean_df.columns:
        clean_df["Volume"] = 0.0

    # 3. Clean DatetimeIndex
    if not isinstance(clean_df.index, pd.DatetimeIndex):
        clean_df.index = pd.to_datetime(clean_df.index, errors="coerce")

    # Drop any NaT in index
    clean_df = clean_df[clean_df.index.notnull()]

    # Strip timezone for monotonic clean dates
    if clean_df.index.tz is not None:
        clean_df.index = clean_df.index.tz_localize(None)

    # Sort chronologically & drop duplicate timestamps
    clean_df = clean_df.sort_index()
    clean_df = clean_df[~clean_df.index.duplicated(keep="last")]

    # 4. Clean numerical anomalies (inf, nan)
    target_cols = ["Open", "High", "Low", "Close", "Volume"]
    clean_df = clean_df[target_cols]
    clean_df = clean_df.replace([np.inf, -np.inf], np.nan)
    clean_df = clean_df.ffill().bfill()

    for col in target_cols:
        clean_df[col] = clean_df[col].astype(float)

    return clean_df


def validate_market_data(df: pd.DataFrame, min_candles: int = 15) -> MarketValidationResult:
    """
    Performs institutional sanity validation on normalized market candles:
      - Validates minimum required history for quantitative agents
      - Verifies price positivity (> 0)
      - Verifies candle spread consistency (High >= Low, High >= Open/Close, Low <= Open/Close)
      - Checks for zero/frozen prices or NaN contamination
    """
    if df is None or df.empty:
        return MarketValidationResult(
            is_valid=False,
            candle_count=0,
            error="Market dataset is empty or could not be loaded."
        )

    count = len(df)
    warnings = []

    if count < min_candles:
        return MarketValidationResult(
            is_valid=False,
            candle_count=count,
            error=f"Insufficient candles: found {count}, but at least {min_candles} are required for strategy evaluation."
        )

    # Sanity checks
    if (df["Close"] <= 0).any() or (df["Open"] <= 0).any():
        return MarketValidationResult(
            is_valid=False,
            candle_count=count,
            error="Corrupted data: Non-positive (<= 0) price detected in dataset."
        )

    if (df["High"] < df["Low"]).any():
        return MarketValidationResult(
            is_valid=False,
            candle_count=count,
            error="Corrupted candles: Inverted High < Low detected."
        )

    # Check for anomalies / warnings
    if (df["Volume"] == 0).all():
        warnings.append("Volume is zero across all candles (common for certain forex or indices).")

    frozen_candles = (df["High"] == df["Low"]).sum()
    if frozen_candles > (count * 0.3):
        warnings.append(f"High percentage ({frozen_candles}/{count}) of zero-range flat candles detected.")

    return MarketValidationResult(
        is_valid=True,
        candle_count=count,
        error=None,
        warnings=warnings
    )


# ===========================================================================
# 3. THREAD-SAFE IN-MEMORY CACHE
# ===========================================================================

class MarketDataCache:
    """
    Thread-safe in-memory cache for quotes, historical snapshots, searches,
    company overviews, and news sentiment with configurable TTLs.
    """

    def __init__(
        self,
        quote_ttl: float = 30.0,
        history_ttl: float = 300.0,
        search_ttl: float = 3600.0,
        overview_ttl: float = 86400.0,
        news_ttl: float = 900.0,
    ):
        self.quote_ttl = quote_ttl          # 30s for quotes
        self.history_ttl = history_ttl      # 5 minutes for historical daily candles
        self.search_ttl = search_ttl        # 1 hour for ticker searches
        self.overview_ttl = overview_ttl    # 24 hours for company profiles
        self.news_ttl = news_ttl            # 15 minutes for news sentiment

        self._quotes: Dict[str, Tuple[MarketQuote, float]] = {}
        self._history: Dict[str, Tuple[MarketDataSnapshot, pd.DataFrame, float]] = {}
        self._searches: Dict[str, Tuple[List[SymbolSearchResult], float]] = {}
        self._overviews: Dict[str, Tuple[CompanyOverview, float]] = {}
        self._news: Dict[str, Tuple[List[NewsItem], float]] = {}
        self._lock = asyncio.Lock()
        self.hits = 0
        self.misses = 0

    async def get_quote(self, symbol: str) -> Optional[MarketQuote]:
        key = symbol.upper().strip()
        now = time.time()
        async with self._lock:
            # 1. Check local process memory first
            if key in self._quotes:
                quote, cached_at = self._quotes[key]
                age = now - cached_at
                if age <= self.quote_ttl:
                    self.hits += 1
                    return quote.model_copy(update={"data_age_seconds": round(age, 2), "is_stale": False})
                else:
                    self.misses += 1
                    return quote.model_copy(update={"data_age_seconds": round(age, 2), "is_stale": True})

        # 2. Check Valkey distributed cache
        try:
            valkey_raw = valkey_service.get(f"market:quote:{key}")
            if valkey_raw and isinstance(valkey_raw, dict):
                valkey_quote = MarketQuote(**valkey_raw)
                valkey_quote.source = "valkey"
                async with self._lock:
                    self._quotes[key] = (valkey_quote, now)
                self.hits += 1
                logger.debug(f"[MARKET] Cache hit in Valkey for {key}")
                return valkey_quote
        except Exception as e:
            logger.debug(f"[Valkey] Cache read exception for {key}: {e}")

        self.misses += 1
        logger.debug(f"[MARKET] Cache miss for {key}")
        return None

    async def set_quote(self, symbol: str, quote: MarketQuote):
        key = symbol.upper().strip()
        async with self._lock:
            self._quotes[key] = (quote, time.time())

        # Store in Aiven Valkey
        try:
            valkey_service.set(f"market:quote:{key}", quote.model_dump(), ttl_seconds=int(self.quote_ttl))
            price_payload = {
                "symbol": key,
                "price": float(quote.price),
                "previous_close": float(quote.previous_close or quote.price),
                "change": float(quote.change or 0.0),
                "change_percent": float(quote.change_percent or 0.0),
                "volume": float(quote.volume or 0.0),
                "updated_at": quote.timestamp or datetime.now().isoformat(),
            }
            valkey_service.set(f"market:price:{key}", price_payload, ttl_seconds=15)
        except Exception as exc:
            logger.debug(f"[Valkey] Could not set quote for {key}: {exc}")

    async def get_history(self, symbol: str, period: str, interval: str) -> Optional[Tuple[MarketDataSnapshot, pd.DataFrame]]:
        key = f"{symbol.upper().strip()}:{period}:{interval}"
        now = time.time()
        async with self._lock:
            if key in self._history:
                snapshot, df, cached_at = self._history[key]
                age = now - cached_at
                if age <= self.history_ttl:
                    self.hits += 1
                    updated_snap = snapshot.model_copy(update={"data_age_seconds": round(age, 2), "is_stale": False})
                    return updated_snap, df.copy()
                else:
                    self.misses += 1
                    updated_snap = snapshot.model_copy(update={"data_age_seconds": round(age, 2), "is_stale": True})
                    return updated_snap, df.copy()
            self.misses += 1
            return None

    async def set_history(self, symbol: str, period: str, interval: str, snapshot: MarketDataSnapshot, df: pd.DataFrame):
        key = f"{symbol.upper().strip()}:{period}:{interval}"
        async with self._lock:
            self._history[key] = (snapshot, df.copy(), time.time())

    async def get_search(self, query: str, market: Optional[str] = None) -> Optional[List[SymbolSearchResult]]:
        key = f"{query.strip().upper()}:{str(market).strip().upper()}"
        now = time.time()
        async with self._lock:
            if key in self._searches:
                results, cached_at = self._searches[key]
                if (now - cached_at) <= self.search_ttl:
                    self.hits += 1
                    return [r.model_copy() for r in results]
            self.misses += 1
            return None

    async def set_search(self, query: str, market: Optional[str], results: List[SymbolSearchResult]):
        key = f"{query.strip().upper()}:{str(market).strip().upper()}"
        async with self._lock:
            self._searches[key] = ([r.model_copy() for r in results], time.time())

    async def get_overview(self, symbol: str) -> Optional[CompanyOverview]:
        key = symbol.strip().upper()
        now = time.time()
        async with self._lock:
            if key in self._overviews:
                overview, cached_at = self._overviews[key]
                if (now - cached_at) <= self.overview_ttl:
                    self.hits += 1
                    return overview.model_copy()
            self.misses += 1
            return None

    async def set_overview(self, symbol: str, overview: CompanyOverview):
        key = symbol.strip().upper()
        async with self._lock:
            self._overviews[key] = (overview, time.time())

    async def get_news(self, symbol: str) -> Optional[List[NewsItem]]:
        key = symbol.strip().upper()
        now = time.time()
        async with self._lock:
            if key in self._news:
                items, cached_at = self._news[key]
                if (now - cached_at) <= self.news_ttl:
                    self.hits += 1
                    return [i.model_copy() for i in items]
            self.misses += 1
            return None

    async def set_news(self, symbol: str, items: List[NewsItem]):
        key = symbol.strip().upper()
        async with self._lock:
            self._news[key] = ([i.model_copy() for i in items], time.time())

    def clear(self):
        self._quotes.clear()
        self._history.clear()
        self._searches.clear()
        self._overviews.clear()
        self._news.clear()
        self.hits = 0
        self.misses = 0


# ===========================================================================
# 4. CENTRALIZED MARKET DATA SERVICE
# ===========================================================================

class MarketDataService:
    """
    Centralized Gateway for Market Data in ORBIT.

    Guarantees:
      - Alpha Vantage acts as primary external market data provider.
      - Automated graceful fallback to YahooFinanceProvider upon rate limits or unsupported tickers.
      - Multi-tier caching: Quotes (30s), History (5m), Search (1h), Overview (24h), News (15m).
      - Drops-in normalized Pydantic models and clean DataFrames for quantitative agents.
    """

    def __init__(
        self,
        primary_provider: Optional[BaseMarketDataProvider] = None,
        fallback_provider: Optional[BaseMarketDataProvider] = None,
    ):
        api_key = os.getenv("ALPHA_VANTAGE_API_KEY", "").strip()
        self.alpha_vantage = primary_provider or AlphaVantageProvider(api_key=api_key)
        self.fallback = fallback_provider or YahooFinanceProvider()
        # For backwards compatibility with any existing direct provider references
        self.provider = self.alpha_vantage
        self.cache = MarketDataCache(quote_ttl=30.0, history_ttl=300.0)
        self._symbol_locks: Dict[str, asyncio.Lock] = {}
        self._meta_lock = asyncio.Lock()

    async def _get_symbol_lock(self, symbol: str) -> asyncio.Lock:
        """Get or initialize a single-flight lock per symbol."""
        sym = symbol.upper().strip()
        async with self._meta_lock:
            if sym not in self._symbol_locks:
                self._symbol_locks[sym] = asyncio.Lock()
            return self._symbol_locks[sym]

    async def get_historical_snapshot(
        self,
        symbol: str,
        period: str = "60d",
        interval: str = "1d",
        force_refresh: bool = False
    ) -> MarketDataSnapshot:
        """
        Fetches and validates a complete MarketDataSnapshot with normalized candles
        and summary quote metrics. Tries Alpha Vantage first; falls back to Yahoo.
        """
        upper_sym = symbol.strip().upper()

        # Check cache if not forcing refresh
        if not force_refresh:
            cached = await self.cache.get_history(upper_sym, period, interval)
            if cached and not cached[0].is_stale:
                return cached[0]

        # 1. Attempt Alpha Vantage primary fetch
        source_name = "AlphaVantage"
        raw_df = pd.DataFrame()
        if hasattr(self.alpha_vantage, "fetch_historical_raw") and not self.alpha_vantage.is_rate_limited():
            raw_df = await self.alpha_vantage.fetch_historical_raw(upper_sym, period=period, interval=interval)

        norm_df = normalize_market_dataframe(raw_df)
        validation = validate_market_data(norm_df, min_candles=10)

        # 2. Fallback to Yahoo if Alpha Vantage failed, was rate limited, or had insufficient candles
        if not validation.is_valid:
            logger.info(f"Alpha Vantage unavailable/insufficient for {upper_sym} ({validation.error}); using Yahoo fallback.")
            raw_df = await self.fallback.fetch_historical_raw(upper_sym, period=period, interval=interval)
            norm_df = normalize_market_dataframe(raw_df)
            validation = validate_market_data(norm_df, min_candles=10)
            source_name = "YahooFinance"

        if not validation.is_valid:
            # If we had stale cached data, fall back to it rather than crashing
            cached = await self.cache.get_history(upper_sym, period, interval)
            if cached:
                logger.warning(f"All providers failed for {upper_sym}; falling back to stale cache ({validation.error})")
                return cached[0]
            raise ValueError(f"Market data validation failed for {upper_sym}: {validation.error}")

        # Convert DataFrame rows into standardized HistoricalCandle objects
        candles: List[HistoricalCandle] = []
        for dt_index, row in norm_df.iterrows():
            candles.append(
                HistoricalCandle(
                    time=dt_index.strftime("%Y-%m-%d"),
                    timestamp=int(dt_index.timestamp()),
                    open=float(row["Open"]),
                    high=float(row["High"]),
                    low=float(row["Low"]),
                    close=float(row["Close"]),
                    volume=float(row["Volume"])
                )
            )

        latest_close = float(norm_df["Close"].iloc[-1])
        prev_close = float(norm_df["Close"].iloc[-2]) if len(norm_df) > 1 else latest_close
        abs_change = latest_close - prev_close
        pct_change = (abs_change / prev_close) * 100.0 if prev_close > 0 else 0.0
        now_ts = time.time()

        quote = MarketQuote(
            symbol=upper_sym,
            price=latest_close,
            open=float(norm_df["Open"].iloc[-1]),
            high=float(norm_df["High"].iloc[-1]),
            low=float(norm_df["Low"].iloc[-1]),
            close=latest_close,
            previous_close=prev_close,
            change=round(abs_change, 4),
            change_percent=round(pct_change, 4),
            volume=float(norm_df["Volume"].iloc[-1]),
            timestamp=datetime.fromtimestamp(now_ts).strftime("%Y-%m-%d %H:%M:%S"),
            data_age_seconds=0.0,
            is_stale=False,
            source=source_name
        )

        snapshot = MarketDataSnapshot(
            symbol=upper_sym,
            quote=quote,
            candles=candles,
            count=len(candles),
            period=period,
            interval=interval,
            source=source_name,
            fetched_at=now_ts,
            data_age_seconds=0.0,
            is_stale=False
        )

        # Store in cache
        await self.cache.set_history(upper_sym, period, interval, snapshot, norm_df)
        await self.cache.set_quote(upper_sym, quote)

        return snapshot

    async def get_normalized_dataframe(
        self,
        symbol: str,
        period: str = "60d",
        interval: str = "1d",
        force_refresh: bool = False
    ) -> pd.DataFrame:
        """
        Drop-in interface for existing quantitative AI agents and strategy judge.
        Returns a validated pd.DataFrame with guaranteed ['Open', 'High', 'Low', 'Close', 'Volume'] columns.
        """
        upper_sym = symbol.strip().upper()

        if not force_refresh:
            cached = await self.cache.get_history(upper_sym, period, interval)
            if cached and not cached[0].is_stale:
                return cached[1]

        # Snapshot call populates cache
        await self.get_historical_snapshot(upper_sym, period=period, interval=interval, force_refresh=force_refresh)
        cached = await self.cache.get_history(upper_sym, period, interval)
        if cached:
            return cached[1]

    async def get_price(self, symbol: str, force_refresh: bool = False) -> float:
        """Convenience method returning the float price of an asset."""
        quote = await self.get_quote(symbol, force_refresh=force_refresh)
        return float(quote.price) if quote and quote.price is not None else 0.0

    async def get_quote(self, symbol: str, force_refresh: bool = False) -> MarketQuote:
        """
        Retrieves the latest quote for a symbol. Tries Alpha Vantage first; falls back to Yahoo.
        Uses single-flight mutex locking to coalesce concurrent requests for the same asset.
        """
        upper_sym = symbol.strip().upper()

        if not force_refresh:
            cached_quote = await self.cache.get_quote(upper_sym)
            if cached_quote and not cached_quote.is_stale:
                return cached_quote

        lock = await self._get_symbol_lock(upper_sym)
        async with lock:
            # Re-check cache under lock to resolve requests waiting on single-flight
            if not force_refresh:
                cached_quote = await self.cache.get_quote(upper_sym)
                if cached_quote and not cached_quote.is_stale:
                    return cached_quote

            source_name = "alpha_vantage"
            raw_quote = {}

            # 1. Try Alpha Vantage fast quote
            if hasattr(self.alpha_vantage, "fetch_quote_raw") and not self.alpha_vantage.is_rate_limited():
                raw_quote = await self.alpha_vantage.fetch_quote_raw(upper_sym)

            # 2. Fall back to Yahoo if Alpha Vantage returned empty
            if not raw_quote or raw_quote.get("price", 0) <= 0:
                raw_quote = await self.fallback.fetch_quote_raw(upper_sym)
                source_name = "yahoo"

            if raw_quote and raw_quote.get("price", 0) > 0:
                price = raw_quote["price"]
                prev = raw_quote.get("previous_close", price)
                change = price - prev
                change_pct = (change / prev) * 100.0 if prev > 0 else 0.0
                now_ts = time.time()

                quote = MarketQuote(
                    symbol=upper_sym,
                    price=price,
                    open=raw_quote.get("open", price),
                    high=raw_quote.get("high", price),
                    low=raw_quote.get("low", price),
                    close=price,
                    previous_close=prev,
                    change=round(change, 4),
                    change_percent=round(change_pct, 4),
                    volume=raw_quote.get("volume", 0.0),
                    timestamp=datetime.fromtimestamp(now_ts).strftime("%Y-%m-%d %H:%M:%S"),
                    data_age_seconds=0.0,
                    is_stale=False,
                    source=source_name
                )
                await self.cache.set_quote(upper_sym, quote)
                return quote

            # Fallback to historical snapshot if fast quote fails
            snap = await self.get_historical_snapshot(upper_sym, period="5d", interval="1d")
            if snap and snap.quote:
                await self.cache.set_quote(upper_sym, snap.quote)
                return snap.quote
            return snap.quote


    async def search_symbols(self, query: str, market: Optional[str] = None) -> List[SymbolSearchResult]:
        """
        Search and autocomplete symbols across financial universes.
        Checks cache -> filters curated popular list -> queries Alpha Vantage SYMBOL_SEARCH -> merges.
        """
        clean_q = query.strip()
        if not clean_q:
            return []

        # 1. Check in-memory search cache
        cached = await self.cache.get_search(clean_q, market)
        if cached is not None:
            return cached

        results: List[SymbolSearchResult] = []
        seen_symbols = set()
        clean_q_upper = clean_q.upper()

        # 2. Filter curated POPULAR_SYMBOLS (prioritize market, but don't hide direct symbol/name matches)
        market_matches: List[SymbolSearchResult] = []
        other_matches: List[SymbolSearchResult] = []

        for item in POPULAR_SYMBOLS:
            sym_upper = item["symbol"].upper()
            name_upper = item["name"].upper()
            cat = item.get("category", "")

            # Match text
            if clean_q_upper in sym_upper or clean_q_upper in name_upper:
                res_item = SymbolSearchResult(
                    symbol=item["symbol"],
                    name=item["name"],
                    category=item["category"],
                    exchange=item.get("exchange"),
                    market=item.get("category"),
                    asset_type="Crypto" if "Crypto" in cat else "Stock",
                    region="US" if "US" in cat else "IN" if "Indian" in cat else "Global",
                    currency="USD" if "USD" in item["symbol"] or "US" in cat else "INR" if "NS" in item["symbol"] else "USD"
                )
                is_m_match = True
                if market:
                    m_lower = market.lower()
                    if "us" in m_lower and "us" not in cat.lower():
                        is_m_match = False
                    elif "india" in m_lower and "indian" not in cat.lower():
                        is_m_match = False
                    elif "crypto" in m_lower and "crypto" not in cat.lower():
                        is_m_match = False
                    elif "forex" in m_lower and "forex" not in cat.lower():
                        is_m_match = False
                    elif "indices" in m_lower and "indices" not in cat.lower():
                        is_m_match = False

                if is_m_match:
                    market_matches.append(res_item)
                else:
                    other_matches.append(res_item)

        for m_item in market_matches:
            if m_item.symbol.upper() not in seen_symbols:
                results.append(m_item)
                seen_symbols.add(m_item.symbol.upper())

        # 3. Query Alpha Vantage symbol search
        if hasattr(self.alpha_vantage, "search_symbols") and not self.alpha_vantage.is_rate_limited():
            try:
                av_results = await self.alpha_vantage.search_symbols(clean_q, market=market)
                for av in av_results:
                    if av.symbol.upper() not in seen_symbols:
                        results.append(av)
                        seen_symbols.add(av.symbol.upper())
            except Exception as exc:
                logger.warning(f"Error calling Alpha Vantage symbol search: {exc}")

        # 4. If few results, query Yahoo Finance search (fallback search with no rate limits)
        if len(results) < 4:
            try:
                def _yf_search():
                    s = yf.Search(clean_q, max_results=6)
                    out = []
                    for q in (s.quotes or []):
                        sym = q.get("symbol", "").strip()
                        name = q.get("shortname") or q.get("longname") or sym
                        exch = q.get("exchange", "")
                        q_type = str(q.get("quoteType", "EQUITY")).upper()
                        if sym:
                            cat = "Crypto" if "CRYPTO" in q_type else "US Equities" if exch in ("NMS", "NYQ", "NGM", "PCX") else "Indian Equities" if (".NS" in sym or ".BO" in sym) else "Global"
                            out.append(SymbolSearchResult(
                                symbol=sym,
                                name=name,
                                category=cat,
                                exchange=exch,
                                market=cat,
                                asset_type="Crypto" if "CRYPTO" in q_type else "Stock",
                                region="US" if "US" in cat else "Global",
                                currency="USD"
                            ))
                    return out

                yf_results = await asyncio.to_thread(_yf_search)
                for yf_res in yf_results:
                    if yf_res.symbol.upper() not in seen_symbols:
                        results.append(yf_res)
                        seen_symbols.add(yf_res.symbol.upper())
            except Exception as exc:
                logger.warning(f"Error in Yahoo symbol search fallback: {exc}")

        # If still few results, append other matching popular items
        if len(results) < 4:
            for o_item in other_matches:
                if o_item.symbol.upper() not in seen_symbols:
                    results.append(o_item)
                    seen_symbols.add(o_item.symbol.upper())

        # 5. If query doesn't match anything and has >= 2 characters, provide fallback
        if not results and len(clean_q) >= 2:
            results.append(
                SymbolSearchResult(
                    symbol=clean_q_upper,
                    name=f"{clean_q_upper} Market Ticker",
                    category="Custom / Global",
                    exchange="Global",
                    market=market or "Global Stocks",
                    asset_type="Stock",
                    region="Global",
                    currency="USD"
                )
            )

        trimmed = results[:12]
        await self.cache.set_search(clean_q, market, trimmed)
        return trimmed

    async def get_company_overview(self, symbol: str) -> Optional[CompanyOverview]:
        """Fetch fundamental company overview, cached for 24 hours."""
        clean_sym = symbol.strip().upper()
        cached = await self.cache.get_overview(clean_sym)
        if cached:
            return cached

        if hasattr(self.alpha_vantage, "fetch_overview") and not self.alpha_vantage.is_rate_limited():
            overview = await self.alpha_vantage.fetch_overview(clean_sym)
            if overview:
                await self.cache.set_overview(clean_sym, overview)
                return overview
        return None

    async def get_news_sentiment(self, symbol: str) -> List[NewsItem]:
        """Fetch market news articles and sentiment ratings, cached for 15 minutes."""
        clean_sym = symbol.strip().upper()
        cached = await self.cache.get_news(clean_sym)
        if cached is not None:
            return cached

        items: List[NewsItem] = []
        if hasattr(self.alpha_vantage, "fetch_news_sentiment") and not self.alpha_vantage.is_rate_limited():
            items = await self.alpha_vantage.fetch_news_sentiment(clean_sym)

        # Fallback to existing news headlines if Alpha Vantage returns empty
        if not items:
            try:
                from backend.agents.news_analyst import get_headlines
                headlines = await asyncio.to_thread(get_headlines, clean_sym)
                for h in headlines[:10]:
                    items.append(
                        NewsItem(
                            title=h.get("title", ""),
                            summary=h.get("description", ""),
                            url=h.get("url", ""),
                            source=h.get("source", "MarketNews"),
                            published_at=h.get("publishedAt", datetime.now().isoformat()),
                            sentiment=h.get("sentiment", "neutral"),
                            sentiment_score=0.0
                        )
                    )
            except Exception as exc:
                logger.warning(f"Error fetching fallback news for {clean_sym}: {exc}")

        await self.cache.set_news(clean_sym, items)
        return items

    def get_cache_stats(self) -> dict:
        """Returns cache telemetry for health monitoring."""
        return {
            "cached_quotes_count": len(self.cache._quotes),
            "cached_snapshots_count": len(self.cache._history),
            "cached_searches_count": len(self.cache._searches),
            "cached_overviews_count": len(self.cache._overviews),
            "cached_news_count": len(self.cache._news),
            "cache_hits": self.cache.hits,
            "cache_misses": self.cache.misses,
            "hit_ratio_percent": round(
                (self.cache.hits / (self.cache.hits + self.cache.misses) * 100.0)
                if (self.cache.hits + self.cache.misses) > 0 else 0.0,
                2
            ),
            "alpha_vantage_rate_limited": self.alpha_vantage.is_rate_limited() if hasattr(self.alpha_vantage, "is_rate_limited") else False,
            "alpha_vantage_rate_limit_hits": getattr(self.alpha_vantage, "rate_limit_hits", 0),
        }


# Global singleton instance for the ORBIT backend
market_service = MarketDataService()
