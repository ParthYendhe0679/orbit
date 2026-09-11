/**
 * ORBIT Trading Terminal — Dual WebSocket Connection Manager
 * Coordinates primary Python WebSocket (:8000/ws) and Go stream hub (:8001/ws)
 */

import {
    WebSocketEventType,
    WebSocketInboundMessage,
    WebSocketOutboundAction
} from "../types/websocket";

export type WebSocketListener<T extends WebSocketInboundMessage = WebSocketInboundMessage> = (message: T) => void;

export class SocketManager {
    private primarySocket: WebSocket | null = null;
    private streamSocket: WebSocket | null = null;

    private primaryReconnectTimer: number | null = null;
    private streamReconnectTimer: number | null = null;

    private intentionallyClosed: boolean = false;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 30;

    private listeners: Map<WebSocketEventType | "all", Set<WebSocketListener>> = new Map();

    private currentUserId: number | string | null = null;
    private currentUsername: string | null = null;

    constructor() {
        this.listeners.set("all", new Set());
    }

    public on<T extends WebSocketInboundMessage>(
        event: WebSocketEventType | "all",
        listener: WebSocketListener<T>
    ): () => void {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        const set = this.listeners.get(event)!;
        set.add(listener as WebSocketListener);
        return () => set.delete(listener as WebSocketListener);
    }

    private emit(event: WebSocketEventType, message: WebSocketInboundMessage): void {
        const specific = this.listeners.get(event);
        if (specific) {
            specific.forEach(cb => {
                try { cb(message); } catch (err) { console.error(`[WS emit error ${event}]:`, err); }
            });
        }
        const all = this.listeners.get("all");
        if (all) {
            all.forEach(cb => {
                try { cb(message); } catch (err) { console.error("[WS emit all error]:", err); }
            });
        }
    }

    public connect(userId: number | string, username: string): void {
        this.currentUserId = userId;
        this.currentUsername = username;
        this.intentionallyClosed = false;

        this.connectPrimary();
        this.connectStreamHub();
    }

    public disconnect(): void {
        this.intentionallyClosed = true;

        if (this.primaryReconnectTimer) {
            clearTimeout(this.primaryReconnectTimer);
            this.primaryReconnectTimer = null;
        }
        if (this.streamReconnectTimer) {
            clearTimeout(this.streamReconnectTimer);
            this.streamReconnectTimer = null;
        }

        if (this.primarySocket) {
            try {
                if (this.primarySocket.readyState === WebSocket.OPEN) {
                    this.primarySocket.send(JSON.stringify({ action: "stop" }));
                }
                this.primarySocket.close();
            } catch {
                // Ignore close errors
            }
            this.primarySocket = null;
        }

        if (this.streamSocket) {
            try { this.streamSocket.close(); } catch { /* Ignore */ }
            this.streamSocket = null;
        }

        this.reconnectAttempts = 0;
    }

    public send(action: WebSocketOutboundAction): boolean {
        if (this.primarySocket && this.primarySocket.readyState === WebSocket.OPEN) {
            try {
                this.primarySocket.send(JSON.stringify(action));
                return true;
            } catch (err) {
                console.warn("[WS send error]:", err);
            }
        }
        return false;
    }

    public sendPrimaryAction(action: WebSocketOutboundAction): boolean {
        return this.send(action);
    }

    private connectPrimary(): void {
        if (!this.currentUserId) return;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const host = window.location.hostname || "127.0.0.1";
        const wsUrl = `${protocol}//${host}:8000/ws?user_id=${encodeURIComponent(this.currentUserId)}&username=${encodeURIComponent(this.currentUsername || "Trader")}`;

        try {
            this.primarySocket = new WebSocket(wsUrl);
        } catch (err) {
            console.warn("[WS connect error]:", err);
            this.schedulePrimaryReconnect();
            return;
        }

        this.primarySocket.onopen = () => {
            console.log("[WS] Connected to primary ORBIT engine");
            this.reconnectAttempts = 0;
        };

        this.primarySocket.onmessage = (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data) as WebSocketInboundMessage;
                if (!data || !data.type) return;

                // Deduplicate tick updates if Go high-speed hub is actively streaming
                if ((data.type === "tick" || data.type === "price_update") && this.isStreamHubOpen()) {
                    return;
                }

                this.emit(data.type, data);
            } catch (parseErr) {
                console.warn("[WS message parse error]:", parseErr);
            }
        };

        this.primarySocket.onclose = () => {
            if (this.intentionallyClosed) return;
            this.schedulePrimaryReconnect();
        };

        this.primarySocket.onerror = (err) => {
            console.warn("[WS primary error]:", err);
        };
    }

    private schedulePrimaryReconnect(): void {
        if (this.intentionallyClosed) return;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.warn("[WS] Max reconnect attempts reached");
            return;
        }

        const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);
        this.reconnectAttempts++;

        if (this.primaryReconnectTimer) clearTimeout(this.primaryReconnectTimer);
        this.primaryReconnectTimer = window.setTimeout(() => {
            this.connectPrimary();
        }, delay);
    }

    private connectStreamHub(): void {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const host = window.location.hostname || "127.0.0.1";
        const hubUrl = `${protocol}//${host}:8001/ws`;

        try {
            this.streamSocket = new WebSocket(hubUrl);
        } catch {
            return;
        }

        this.streamSocket.onopen = () => {
            console.log("[orbit-stream] Go hub connected — high-frequency tick stream active");
        };

        this.streamSocket.onmessage = (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data) as WebSocketInboundMessage;
                if (!data || !data.type) return;

                // Route tick & metrics from Go hub
                if (data.type === "tick" || data.type === "metrics") {
                    this.emit(data.type, data);
                }
            } catch {
                // Ignore malformed hub frames
            }
        };

        this.streamSocket.onclose = () => {
            if (this.intentionallyClosed) return;
            if (this.streamReconnectTimer) clearTimeout(this.streamReconnectTimer);
            this.streamReconnectTimer = window.setTimeout(() => {
                this.connectStreamHub();
            }, 3000);
        };

        this.streamSocket.onerror = () => {
            // Fail silently; primary Python WebSocket handles ticks seamlessly as fallback
        };
    }

    public isPrimaryOpen(): boolean {
        return !!this.primarySocket && this.primarySocket.readyState === WebSocket.OPEN;
    }

    public isStreamHubOpen(): boolean {
        return !!this.streamSocket && this.streamSocket.readyState === WebSocket.OPEN;
    }
}

export const socketManager = new SocketManager();
