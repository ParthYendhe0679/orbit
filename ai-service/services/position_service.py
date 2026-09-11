"""
ai-service/services/position_service.py — Single Source of Truth for Positions, P&L, and Portfolio State.

Authoritative layer for:
  - Open positions with live market valuation and P&L
  - Centralized Dashboard summary (Equity, Cash, Margin, Unrealized/Realized P&L, Win Rate)
  - Partial and Full Position Closures with atomic DB updates
  - Paginated Trade History and Pending Orders
"""

from datetime import datetime
from typing import Any, Dict, List, Optional
import logging
import asyncio

from database import (
    get_user_balance,
    get_open_positions,
    get_position_by_id,
    get_pending_orders,
    get_closed_trade_history_paginated,
    get_total_realized_pnl,
    get_all_trades,
    open_active_trade_atomic,
    partially_close_position,
    fully_close_position,
)
from services.market_data_service import MarketDataService, market_service
from services.valkey_service import valkey_service, cache_service

logger = logging.getLogger("orbit.position_service")



class PositionService:
    """
    Authoritative service governing active trades, portfolio equity, and execution lifecycle.
    Consumes live quotes from MarketDataService and ensures single source of truth across ORBIT.
    """

    def __init__(self, mkt_svc: Optional[MarketDataService] = None):
        self.market_service = mkt_svc or market_service

    async def get_live_open_positions(self, user_id: int = 1) -> List[Dict[str, Any]]:
        """
        Fetch all open positions for user, pricing each position with live cached market data.
        Calculates exact unrealized P&L and return percentage without duplicate leverage multiplication.
        """
        cache_key = f"positions:{user_id}"
        cached = cache_service.get(cache_key)
        if cached is not None and isinstance(cached, list):
            return cached

        raw_positions = await asyncio.to_thread(get_open_positions, user_id)
        live_positions = []

        # Deduplicate and batch quote retrieval across distinct symbols to eliminate N sequential lookups
        unique_symbols = {p.get("asset", "BTC-USD") for p in raw_positions}
        quotes = {}
        for sym in unique_symbols:
            try:
                q = await asyncio.wait_for(self.market_service.get_quote(sym), timeout=2.0)
                if q and q.price > 0:
                    quotes[sym] = q
            except Exception as e:
                logger.warning(f"Failed to fetch live quote for {sym}, using last price: {e}")

        for p in raw_positions:
            sym = p.get("asset", "BTC-USD")
            current_price = float(p.get("current_price", 0.0))
            is_live = False

            if sym in quotes:
                current_price = float(quotes[sym].price)
                is_live = not quotes[sym].is_stale

            entry_price = float(p.get("entry_price", 0.0))
            rem_qty = float(p.get("remaining_quantity") if p.get("remaining_quantity") is not None else p.get("quantity", 0.0))
            orig_qty = float(p.get("original_quantity") if p.get("original_quantity") is not None else p.get("quantity", 0.0))
            leverage = float(p.get("leverage") or 1.0)
            trade_type = str(p.get("type", "buy")).lower()

            # P&L calculation: (current - entry) * qty * leverage
            if trade_type == "buy":
                unrealized_pnl = (current_price - entry_price) * rem_qty * leverage
            else:
                unrealized_pnl = (entry_price - current_price) * rem_qty * leverage

            margin_used = float(p.get("margin_used") or ((rem_qty * entry_price) / leverage))
            position_size = rem_qty * current_price * leverage
            unrealized_pnl_pct = (unrealized_pnl / margin_used * 100.0) if margin_used > 0 else 0.0

            opened_at = p.get("timestamp", "")
            duration_str = ""
            if opened_at:
                try:
                    opened_dt = datetime.fromisoformat(opened_at)
                    delta = datetime.now() - opened_dt
                    total_seconds = int(delta.total_seconds())
                    if total_seconds < 60:
                        duration_str = f"{total_seconds}s"
                    elif total_seconds < 3600:
                        duration_str = f"{total_seconds // 60}m"
                    elif total_seconds < 86400:
                        duration_str = f"{total_seconds // 3600}h {(total_seconds % 3600) // 60}m"
                    else:
                        duration_str = f"{total_seconds // 86400}d {(total_seconds % 86400) // 3600}h"
                except Exception:
                    pass

            pos_item = {
                "id": p["id"],
                "trade_id": p["id"],
                "user_id": user_id,
                "symbol": sym,
                "asset": sym,
                "market": p.get("market", "Crypto" if "-" in sym else "Stock"),
                "type": p.get("type", "BUY"),
                "side": p.get("type", "BUY"),
                "status": p.get("status", "active"),
                "entry_price": round(entry_price, 4),
                "current_price": round(current_price, 4),
                "quantity": rem_qty,
                "original_quantity": orig_qty,
                "remaining_quantity": rem_qty,
                "leverage": leverage,
                "position_size": round(position_size, 2),
                "margin_used": round(margin_used, 2),
                "unrealized_pnl": round(unrealized_pnl, 2),
                "unrealized_pnl_pct": round(unrealized_pnl_pct, 2),
                "unrealized_pnl_percent": round(unrealized_pnl_pct, 2),
                "realized_pnl": round(float(p.get("realized_pnl") or 0.0), 2),
                "sl": float(p.get("sl") or 0.0),
                "target": float(p.get("target") or 0.0),
                "opened_at": opened_at,
                "updated_at": datetime.now().isoformat(),
                "duration": duration_str,
                "is_live": is_live,
                "source": p.get("source") or "manual",
                "bot_session_id": p.get("bot_session_id"),
            }
            live_positions.append(pos_item)

            # Maintain active trade structures in Valkey (Phase 8, 9 & 27: 300s rolling TTL)
            tid_str = str(p["id"])
            valkey_service.set(f"trade:active:{tid_str}", pos_item, ttl_seconds=300)
            valkey_service.sadd(f"user:{user_id}:active_trades", tid_str)
            valkey_service.sadd(f"symbol:{sym}:active_trades", tid_str)

        cache_service.set(cache_key, live_positions, ttl_seconds=10)
        return live_positions


    async def get_account_and_dashboard_summary(self, user_id: int = 1) -> Dict[str, Any]:
        """
        Calculates unified financial state:
          - Available cash from user balance
          - Margin used across all active positions
          - Net unrealized P&L
          - Equity = cash + margin_used + unrealized_pnl
          - Active trade count
          - Cumulative realized P&L
          - Win rate % (displays None / '—' when 0 completed trades)
        """
        cache_key = f"portfolio:{user_id}"
        cached = cache_service.get(cache_key)
        if cached is not None and isinstance(cached, dict):
            return cached

        open_positions = await self.get_live_open_positions(user_id)

        # Offload remaining DB queries to parallel worker threads to prevent event loop blocking
        cash, total_realized_pnl, all_closed = await asyncio.gather(
            asyncio.to_thread(get_user_balance, user_id),
            asyncio.to_thread(get_total_realized_pnl, user_id),
            asyncio.to_thread(get_all_trades, user_id, "closed")
        )

        total_margin_used = sum(p["margin_used"] for p in open_positions)
        total_unrealized_pnl = sum(p["unrealized_pnl"] for p in open_positions)
        total_equity = cash + total_margin_used + total_unrealized_pnl

        active_trades_count = len(open_positions)

        # Win rate calculation over completed closed trades (excluding cancelled)
        valid_closed = [t for t in all_closed if t.get("outcome") != "cancelled"]
        closed_count = len(valid_closed)

        if closed_count == 0:
            win_rate = None
            win_rate_str = "—"
            winning_count = 0
            losing_count = 0
        else:
            winning_count = sum(1 for t in valid_closed if float(t.get("realized_pnl") or t.get("pnl") or 0.0) > 0)
            losing_count = closed_count - winning_count
            win_rate = (winning_count / closed_count) * 100.0
            win_rate_str = f"{win_rate:.1f}%"

        summary = {
            "account": {
                "total_capital": round(total_equity, 2),
                "available_balance": round(cash, 2),
                "used_margin": round(total_margin_used, 2),
                "equity": round(total_equity, 2)
            },
            "trading": {
                "active_trades": active_trades_count,
                "unrealized_pnl": round(total_unrealized_pnl, 2),
                "realized_pnl": round(total_realized_pnl, 2),
                "win_rate": round(win_rate, 2) if win_rate is not None else None,
                "win_rate_str": win_rate_str,
                "closed_trades_count": closed_count,
                "total_closed_trades": closed_count,
                "winning_trades_count": winning_count,
                "winning_trades": winning_count,
                "losing_trades_count": losing_count
            },
            "open_positions": open_positions,
            "timestamp": datetime.now().isoformat(),
            # Flat top-level aliases for universal contract compatibility
            "total_capital": round(total_equity, 2),
            "available_balance": round(cash, 2),
            "used_margin": round(total_margin_used, 2),
            "equity": round(total_equity, 2),
            "active_trades": active_trades_count,
            "unrealized_pnl": round(total_unrealized_pnl, 2),
            "realized_pnl": round(total_realized_pnl, 2),
            "win_rate": round(win_rate, 2) if win_rate is not None else None,
            "win_rate_str": win_rate_str
        }
        cache_service.set(cache_key, summary, ttl_seconds=10)
        # Populate fast dashboard metrics in Valkey (Phase 11 & 27: 10s TTL)
        valkey_service.set(f"dashboard:{user_id}:metrics", {
            "total_capital": summary["account"]["total_capital"],
            "available_balance": summary["account"]["available_balance"],
            "used_margin": summary["account"]["used_margin"],
            "active_trades": summary["trading"]["active_trades"],
            "unrealized_pnl": summary["trading"]["unrealized_pnl"],
            "realized_pnl": summary["trading"]["realized_pnl"],
            "win_rate": summary["trading"]["win_rate"],
            "win_rate_str": summary["trading"]["win_rate_str"],
            "updated_at": summary["timestamp"]
        }, ttl_seconds=10)
        return summary

    async def close_position_partially(self, trade_id: int, user_id: int, close_qty: float) -> Dict[str, Any]:
        """Validate ownership and partially close position at latest authoritative market quote."""
        pos = await asyncio.to_thread(get_position_by_id, trade_id, user_id)
        if not pos:
            raise ValueError(f"Position #{trade_id} not found or unauthorized.")

        sym = pos.get("asset", "BTC-USD")
        exit_price = float(pos.get("current_price", 0.0))
        try:
            quote = await asyncio.wait_for(self.market_service.get_quote(sym), timeout=2.0)
            if quote and quote.price > 0:
                exit_price = float(quote.price)
        except Exception as e:
            logger.warning(f"Could not fetch live exit quote for {sym}, using last price: {e}")

        result = await asyncio.to_thread(partially_close_position, trade_id, user_id, close_qty, exit_price)
        # Update active trade state in Valkey
        valkey_service.set(f"trade:active:{trade_id}", result, ttl_seconds=60)
        valkey_service.invalidate_user_cache(user_id)
        summary = await self.get_account_and_dashboard_summary(user_id)
        result["summary"] = summary
        result["ok"] = True
        return result

    async def close_position_fully(self, trade_id: int, user_id: int) -> Dict[str, Any]:
        """Validate ownership and fully close position at latest authoritative market quote."""
        pos = await asyncio.to_thread(get_position_by_id, trade_id, user_id)
        if not pos:
            raise ValueError(f"Position #{trade_id} not found or unauthorized.")

        sym = pos.get("asset", "BTC-USD")
        exit_price = float(pos.get("current_price", 0.0))
        try:
            quote = await asyncio.wait_for(self.market_service.get_quote(sym), timeout=2.0)
            if quote and quote.price > 0:
                exit_price = float(quote.price)
        except Exception as e:
            logger.warning(f"Could not fetch live exit quote for {sym}, using last price: {e}")

        result = await asyncio.to_thread(fully_close_position, trade_id, user_id, exit_price, outcome="manual_close")
        # Remove active trade from Valkey structures (Phase 8 & 13)
        valkey_service.delete(f"trade:active:{trade_id}")
        valkey_service.srem(f"user:{user_id}:active_trades", str(trade_id))
        valkey_service.srem(f"symbol:{sym}:active_trades", str(trade_id))
        valkey_service.invalidate_user_cache(user_id)
        summary = await self.get_account_and_dashboard_summary(user_id)
        result["summary"] = summary
        result["ok"] = True
        return result

    async def open_market_position(
        self,
        user_id: int,
        symbol: str,
        side: str,
        quantity: float,
        leverage: float = 1.0,
        sl: float = 0.0,
        target: float = 0.0,
        market: Optional[str] = None,
        price: Optional[float] = None,
        source: str = "manual",
        bot_session_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Single execution path for market orders (manual REST and the Auto-Trade Bot).

        Reserves margin atomically in the database (with the bot guard when
        bot_session_id is set), then mirrors the position into the Valkey
        live-state indices used by the tick scheduler. Without an explicit
        price the latest quote is used; a missing quote refuses the order.
        Raises ValueError when the order is refused.
        """
        if price is None:
            price = await self.market_service.get_price(symbol)
        price = float(price or 0.0)
        if price <= 0:
            raise ValueError(f"No valid market price available for {symbol}.")
        lev = max(1.0, float(leverage or 1.0))
        mkt = market or ("Crypto" if "-" in symbol else "Stock")

        trade_id, res = await asyncio.to_thread(
            open_active_trade_atomic, user_id, symbol, side, quantity, price, lev,
            sl or 0.0, target or 0.0, mkt, source, bot_session_id,
        )
        if not trade_id:
            raise ValueError(str(res))

        now_iso = datetime.now().isoformat()
        trade_dict = {
            "id": trade_id,
            "trade_id": trade_id,
            "user_id": user_id,
            "symbol": symbol,
            "side": side,
            "market": mkt,
            "entry_price": price,
            "current_price": price,
            "quantity": quantity,
            "remaining_quantity": quantity,
            "leverage": lev,
            "margin_used": (quantity * price) / lev,
            "position_size": quantity * price,
            "sl": sl or 0.0,
            "target": target or 0.0,
            "unrealized_pnl": 0.0,
            "unrealized_pnl_percent": 0.0,
            "status": "active",
            "source": "bot" if bot_session_id is not None else source,
            "bot_session_id": bot_session_id,
            "opened_at": now_iso,
            "updated_at": now_iso,
        }
        valkey_service.set(f"trade:active:{trade_id}", trade_dict, ttl_seconds=300)
        valkey_service.sadd(f"user:{user_id}:active_trades", str(trade_id))
        valkey_service.sadd(f"symbol:{symbol}:active_trades", str(trade_id))
        valkey_service.invalidate_user_cache(user_id)
        return {"trade": trade_dict, "balance": res}

    async def get_pending_orders_list(self, user_id: int = 1) -> List[Dict[str, Any]]:
        """Fetch pending orders for user and index active pending orders in Valkey."""
        orders = get_pending_orders(user_id)
        for o in orders:
            oid_str = str(o["id"])
            valkey_service.set(f"order:pending:{oid_str}", o, ttl_seconds=60)
            valkey_service.sadd(f"user:{user_id}:pending_orders", oid_str)
        return orders


    async def get_trade_history_paginated(
        self,
        user_id: int = 1,
        symbol: Optional[str] = None,
        market: Optional[str] = None,
        side: Optional[str] = None,
        outcome: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
        source: Optional[str] = None,
        bot_session_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """Fetch paginated closed trades (optionally only bot or manual trades, or one bot session's)."""
        return get_closed_trade_history_paginated(
            user_id=user_id,
            symbol=symbol,
            market=market,
            side=side,
            outcome=outcome,
            limit=limit,
            offset=offset,
            source=source,
            bot_session_id=bot_session_id
        )


position_service = PositionService()
