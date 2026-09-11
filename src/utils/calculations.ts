/**
 * ORBIT Trading Terminal — Mathematical & Financial Calculations
 */

import { Position } from "../types/trading";

export interface CloseEstimateResult {
    closeQty: number;
    remainingQty: number;
    estimatedPnl: number;
    releasedMargin: number;
    isFullClose: boolean;
}

/**
 * Calculates unrealized PnL based on position direction and leverage.
 */
export function calculateUnrealizedPnL(
    side: "buy" | "sell" | "long" | "short" | string,
    entryPrice: number,
    currentPrice: number,
    quantity: number,
    leverage: number = 1
): number {
    const isLong = side.toLowerCase() === "buy" || side.toLowerCase() === "long";
    if (isLong) {
        return (currentPrice - entryPrice) * quantity * leverage;
    } else {
        return (entryPrice - currentPrice) * quantity * leverage;
    }
}

/**
 * Calculates margin required for a leveraged position.
 */
export function calculateMarginRequired(price: number, quantity: number, leverage: number = 1): number {
    if (leverage <= 0) leverage = 1;
    return (price * quantity) / leverage;
}

/**
 * Estimates PnL and margin release for closing a given quantity of an open position.
 */
export function estimateCloseMetrics(position: Position, closeQty: number): CloseEstimateResult {
    const remQty = Number(position.remaining_quantity ?? position.quantity ?? 1);
    const entry = Number(position.entry_price ?? 0);
    const current = Number(position.current_price ?? entry);
    const lev = Number(position.leverage ?? 1);
    const marginUsed = Number(position.margin_used ?? 0);
    const side = (position.side || position.type || "buy").toLowerCase();

    const safeCloseQty = Math.min(Math.max(0, closeQty), remQty);
    const isFullClose = safeCloseQty >= remQty;
    const estPnl = calculateUnrealizedPnL(side, entry, current, safeCloseQty, lev);

    const releasedMargin = remQty > 0 ? (marginUsed * (safeCloseQty / remQty)) : 0;
    const afterQty = Math.max(0, remQty - safeCloseQty);

    return {
        closeQty: safeCloseQty,
        remainingQty: afterQty,
        estimatedPnl: estPnl,
        releasedMargin,
        isFullClose
    };
}
