"""
ai-service/models/market.py — Standardized Market Data Contracts for ORBIT.

Provides uniform, validated data contracts for quotes, historical candles,
and market data snapshots used by the entire ORBIT multi-agent ecosystem.
"""

from typing import List, Optional
from pydantic import BaseModel, Field


class HistoricalCandle(BaseModel):
    """Represents a single OHLCV candlestick with both date string and Unix epoch."""
    time: str = Field(..., description="Date string format YYYY-MM-DD or ISO timestamp")
    timestamp: int = Field(..., description="Unix epoch timestamp in seconds")
    open: float = Field(..., description="Opening price of the candle")
    high: float = Field(..., description="Highest price during the period")
    low: float = Field(..., description="Lowest price during the period")
    close: float = Field(..., description="Closing price of the period")
    volume: float = Field(default=0.0, description="Total volume traded in this candle")


class MarketQuote(BaseModel):
    """Standardized real-time quote for a specific ticker symbol."""
    symbol: str = Field(..., description="Ticker symbol (e.g., BTC-USD, AAPL, SBIN.NS)")
    price: float = Field(..., description="Current or latest traded price")
    open: float = Field(..., description="Session open price")
    high: float = Field(..., description="Session high price")
    low: float = Field(..., description="Session low price")
    close: float = Field(..., description="Latest close price")
    previous_close: float = Field(..., description="Previous session closing price")
    change: float = Field(..., description="Absolute price change from previous close")
    change_percent: float = Field(..., description="Percentage price change from previous close")
    volume: float = Field(default=0.0, description="Session volume")
    timestamp: str = Field(..., description="Timestamp of the quote")
    data_age_seconds: float = Field(default=0.0, description="Age of the data in seconds")
    is_stale: bool = Field(default=False, description="Flag indicating if quote exceeds freshness threshold")
    source: str = Field(default="YahooFinance", description="Data provider source name")


class MarketDataSnapshot(BaseModel):
    """Complete market data bundle containing quote, historical candles, and metadata."""
    symbol: str = Field(..., description="Ticker symbol")
    quote: MarketQuote = Field(..., description="Latest quote summary")
    candles: List[HistoricalCandle] = Field(default_factory=list, description="Ordered list of historical candles")
    count: int = Field(default=0, description="Number of candles in snapshot")
    period: str = Field(default="60d", description="Historical period window requested")
    interval: str = Field(default="1d", description="Candle interval requested")
    source: str = Field(default="YahooFinance", description="Underlying provider")
    fetched_at: float = Field(..., description="Unix timestamp when snapshot was cached/retrieved")
    data_age_seconds: float = Field(default=0.0, description="Seconds since fetch")
    is_stale: bool = Field(default=False, description="Whether snapshot exceeds cache TTL")


class MarketValidationResult(BaseModel):
    """Results of structural and sanity validation on a market dataset."""
    is_valid: bool = Field(..., description="Whether dataset meets all integrity checks")
    candle_count: int = Field(default=0, description="Total candles evaluated")
    error: Optional[str] = Field(default=None, description="Critical failure reason if invalid")
    warnings: List[str] = Field(default_factory=list, description="Non-critical data anomalies detected")


class SymbolSearchResult(BaseModel):
    """Normalized search suggestion result."""
    symbol: str
    name: str
    category: str
    exchange: Optional[str] = None
    asset_type: Optional[str] = Field(default="Equity", description="Asset class/type")
    market: Optional[str] = Field(default=None, description="Target market region or category")
    region: Optional[str] = Field(default=None, description="Country or geographical region")
    currency: Optional[str] = Field(default="USD", description="Quoted currency")


class Asset(BaseModel):
    """Standardized representation of a tradable or analyzable asset."""
    symbol: str = Field(..., description="Unique ticker symbol")
    name: str = Field(..., description="Full descriptive name")
    asset_type: str = Field(default="Equity", description="Asset class (e.g., Stock, Crypto, Forex, Index)")
    exchange: Optional[str] = Field(default=None, description="Primary listing exchange")
    market: str = Field(default="US Stocks", description="Market classification (e.g. US Stocks, Indian Stocks, Crypto)")
    currency: str = Field(default="USD", description="Currency denomination")


class MarketSeries(BaseModel):
    """Normalized multi-candle time series bundle."""
    symbol: str = Field(..., description="Asset ticker symbol")
    interval: str = Field(default="1d", description="Candle interval (e.g., 1d, 1h, 5m)")
    data: List[HistoricalCandle] = Field(default_factory=list, description="Ordered chronological candles")
    timestamp: str = Field(..., description="Series retrieval timestamp")
    source: str = Field(default="AlphaVantage", description="Data provider source")


class NewsItem(BaseModel):
    """Normalized market news headline and sentiment scoring item."""
    title: str = Field(..., description="Headline text")
    summary: Optional[str] = Field(default="", description="Brief article summary")
    url: Optional[str] = Field(default="", description="Link to source article")
    source: str = Field(default="", description="Publisher or provider name")
    published_at: str = Field(..., description="ISO publication timestamp")
    sentiment: str = Field(default="neutral", description="Sentiment direction (bullish, bearish, neutral)")
    sentiment_score: float = Field(default=0.0, description="Normalized sentiment score (-1.0 to +1.0)")


class CompanyOverview(BaseModel):
    """Normalized fundamental profile for equities."""
    symbol: str
    name: str
    description: Optional[str] = ""
    sector: Optional[str] = ""
    industry: Optional[str] = ""
    pe_ratio: Optional[float] = None
    market_cap: Optional[float] = None
    fifty_two_week_high: Optional[float] = None
    fifty_two_week_low: Optional[float] = None
    dividend_yield: Optional[float] = None
    currency: str = "USD"
    source: str = "AlphaVantage"
