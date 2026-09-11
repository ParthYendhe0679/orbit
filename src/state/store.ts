/**
 * ORBIT Trading Terminal — Central Reactive State Store
 * Lightweight pub/sub state container preserving zero-dependency minimalism
 */

import { Position, PendingOrder, ClosedTrade } from "../types/trading";
import { DashboardSummary } from "../types/portfolio";
import { SocketManager, socketManager } from "../websocket/socketManager";

export interface OrbitState {
    currentAsset: string;
    currentTimeframe: string;
    currentUsername: string;
    currentUserId: number | string | null;
    walletBalance: number;
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
}

export type StateListener<K extends keyof OrbitState> = (value: OrbitState[K], state: OrbitState) => void;

class StateStore {
    private state: OrbitState;
    private listeners: Map<keyof OrbitState, Set<StateListener<any>>> = new Map();
    public readonly sockets: SocketManager;

    constructor() {
        this.sockets = socketManager;

        // Restore persisted user if available
        let savedUserId: string | null = null;
        let savedUsername: string | null = null;
        try {
            if (typeof localStorage !== "undefined") {
                savedUserId = localStorage.getItem("orbit_user_id");
                savedUsername = localStorage.getItem("orbit_username");
            }
        } catch {
            // Ignore storage errors in restricted contexts
        }

        this.state = {
            currentAsset: "BTC-USD",
            currentTimeframe: "1d",
            currentUsername: savedUsername || "Trader Account",
            currentUserId: savedUserId ? (isNaN(Number(savedUserId)) ? savedUserId : Number(savedUserId)) : null,
            walletBalance: 100000,
            openTrades: [],
            pendingOrders: [],
            tradeHistory: [],
            historyPage: 0,
            totalHistoryPages: 1,
            activeManageTrade: null,
            closeSelectedPct: 50,
            showSRLevels: false,
            botRunning: false,
            dashboardSummary: null
        };
    }

    public get<K extends keyof OrbitState>(key: K): OrbitState[K] {
        return this.state[key];
    }

    public getAll(): Readonly<OrbitState> {
        return this.state;
    }

    public set<K extends keyof OrbitState>(key: K, value: OrbitState[K]): void {
        const prev = this.state[key];
        if (prev === value) return;

        this.state[key] = value;

        // Sync auth persistence
        if (key === "currentUserId") {
            try {
                if (value !== null && typeof localStorage !== "undefined") {
                    localStorage.setItem("orbit_user_id", String(value));
                }
            } catch {
                // Ignore localStorage errors
            }
        }
        if (key === "currentUsername") {
            try {
                if (value && typeof localStorage !== "undefined") {
                    localStorage.setItem("orbit_username", String(value));
                }
            } catch {
                // Ignore localStorage errors
            }
        }

        // Notify listeners
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
