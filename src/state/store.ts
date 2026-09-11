/**
 * ORBIT Trading Terminal — Central Reactive State Store
 * Lightweight pub/sub state container preserving zero-dependency minimalism.
 *
 * Nothing here is authoritative: identity comes from the gateway session and
 * every balance / P&L / position from the backend. The store only caches the
 * last server answer for rendering.
 */

import { Position, PendingOrder, ClosedTrade } from "../types/trading";
import { DashboardSummary } from "../types/portfolio";
import { SocketManager, socketManager } from "../websocket/socketManager";

/** The AI trade proposal awaiting the trader's confirmation (WS "signal"). */
export interface PendingSignal {
    trade_id: number | null;
    direction: string;
    entry: number;
    sl: number;
    target: number;
    quantity?: number;
    capital_required?: number;
    max_risk?: number;
}

export interface OrbitState {
    currentAsset: string;
    currentTimeframe: string;
    currentUsername: string;
    /** Set only from a server-verified identity (/api/auth/me, login, sync). */
    currentUserId: number | string | null;
    /** Available cash from the last authoritative summary; null until loaded. */
    walletBalance: number | null;
    openTrades: Position[];
    pendingOrders: PendingOrder[];
    tradeHistory: ClosedTrade[];
    historyPage: number;
    totalHistoryPages: number;
    activeManageTrade: Position | null;
    closeSelectedPct: number | null;
    showSRLevels: boolean;
    botRunning: boolean;
    dashboardSummary: DashboardSummary | null;
    pendingSignal: PendingSignal | null;
}

export type StateListener<K extends keyof OrbitState> = (value: OrbitState[K], state: OrbitState) => void;

class StateStore {
    private state: OrbitState;
    private listeners: Map<keyof OrbitState, Set<StateListener<any>>> = new Map();
    public readonly sockets: SocketManager;

    constructor() {
        this.sockets = socketManager;
        this.state = {
            currentAsset: "BTC-USD",
            currentTimeframe: "1d",
            currentUsername: "",
            currentUserId: null,
            walletBalance: null,
            openTrades: [],
            pendingOrders: [],
            tradeHistory: [],
            historyPage: 0,
            totalHistoryPages: 1,
            activeManageTrade: null,
            closeSelectedPct: 50,
            showSRLevels: false,
            botRunning: false,
            dashboardSummary: null,
            pendingSignal: null
        };
    }

    public get<K extends keyof OrbitState>(key: K): OrbitState[K] {
        return this.state[key];
    }

    public getAll(): Readonly<OrbitState> {
        return this.state;
    }

    public set<K extends keyof OrbitState>(key: K, value: OrbitState[K]): void {
        if (this.state[key] === value) return;
        this.state[key] = value;
        const keyListeners = this.listeners.get(key);
        if (keyListeners) {
            keyListeners.forEach((listener) => {
                try {
                    listener(value, this.state);
                } catch (err) {
                    console.error(`[StateStore] Error in listener for "${key}":`, err);
                }
            });
        }
    }

    public subscribe<K extends keyof OrbitState>(key: K, listener: StateListener<K>): () => void {
        if (!this.listeners.has(key)) {
            this.listeners.set(key, new Set());
        }
        this.listeners.get(key)!.add(listener);
        return () => {
            const set = this.listeners.get(key);
            if (set) set.delete(listener);
        };
    }
}

export const store = new StateStore();
