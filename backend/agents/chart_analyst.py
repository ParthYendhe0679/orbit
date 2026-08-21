import pandas as pd
import numpy as np

def find_support_resistance(df: pd.DataFrame, window=5, log_func=None):
    prices = df['Close'].values
    highs = df['High'].values
    lows = df['Low'].values
    
    raw_supports = []
    raw_resistances = []
    
    # 1. Detect local minima and maxima
    for i in range(window, len(df) - window):
        # Local min (potential support)
        if lows[i] == min(lows[i - window : i + window + 1]):
            raw_supports.append(lows[i])
        # Local max (potential resistance)
        if highs[i] == max(highs[i - window : i + window + 1]):
            raw_resistances.append(highs[i])
            
    # 2. Cluster raw levels that are within 1.5% of each other
    current_price = prices[-1]
    
    def cluster_levels(levels, is_support=True):
        if not levels:
            return []
        levels = sorted(levels)
        clusters = []
        current_cluster = [levels[0]]
        
        for level in levels[1:]:
            # If level is within 1.5% of the cluster average, add it
            avg = np.mean(current_cluster)
            if abs(level - avg) / avg < 0.015:
                current_cluster.append(level)
            else:
                clusters.append(np.mean(current_cluster))
                current_cluster = [level]
        clusters.append(np.mean(current_cluster))
        
        # Filter based on current price
        if is_support:
            # We want supports below current price, sorted descending (closest first)
            filtered = [c for c in clusters if c < current_price]
            filtered = sorted(filtered, reverse=True)
        else:
            # We want resistances above current price, sorted ascending (closest first)
            filtered = [c for c in clusters if c > current_price]
            filtered = sorted(filtered)
            
        return [round(f, 2) for f in filtered[:3]]

    supports = cluster_levels(raw_supports, is_support=True)
    resistances = cluster_levels(raw_resistances, is_support=False)

    # 3. Compute Liquidity Zones — areas just beyond key S/R where stops cluster
    #    (equal highs/lows sweep zones, common ICT concept)
    liquidity_zones = []
    for s in supports[:2]:
        # Stops pool just BELOW support (retail longs place SL there)
        liq = round(s * 0.998, 2)
        liquidity_zones.append(liq)
    for r in resistances[:2]:
        # Stops pool just ABOVE resistance (retail shorts place SL there)
        liq = round(r * 1.002, 2)
        liquidity_zones.append(liq)
    
    # Convert to plain Python floats BEFORE logging, otherwise the terminal
    # shows numpy repr like "[np.float64(62357.14)]" instead of the numbers.
    supports = [float(s) for s in supports]
    resistances = [float(r) for r in resistances]
    liquidity_zones = [float(z) for z in liquidity_zones]

    if log_func:
        log_func("Levels Analyst", f"Calculated major support zones: {supports or 'none below current price'}")
        log_func("Levels Analyst", f"Calculated major resistance zones: {resistances or 'none above current price'}")
        log_func("Levels Analyst", f"Identified liquidity pools: {liquidity_zones or 'none'}")

    return {
        "supports": supports,
        "resistances": resistances,
        "liquidity": liquidity_zones
    }
