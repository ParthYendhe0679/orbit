/**
 * ORBIT Trading Terminal — WebSocket Connection Manager
 *
 * Both sockets go to the Go gateway on the page's own origin:
 *   /ws         private channel (wallet, positions, bot events, agent pipeline).
 *               The gateway authenticates the handshake from the session
 *               cookie and binds it to that account; no identity is sent.
 *   /ws/stream  public market ticks from the orbit-stream hub.
 */

import {
    WebSocketEventType,
    WebSocketInboundMessage,
    WebSocketOutboundAction
} from "../types/websocket";

export type WebSocketListener<T extends WebSocketInboundMessage = WebSocketInboundMessage> = (message: T) => void;

/** Fired when the private socket closes without ever opening (rejected handshake or outage). */
export const SOCKET_FAILED_EVENT = "orbit:socket-failed";

export class SocketManager {
    private primarySocket: WebSocket | null = null;
    private streamSocket: WebSocket | null = null;

    private primaryReconnectTimer: number | null = null;
    private streamReconnectTimer: number | null = null;

    private intentionallyClosed: boolean = false;
    private reconnectAttempts: number = 0;
    private readonly maxReconnectAttempts: number = 30;

    private listeners: Map<WebSocketEventType | "all", Set<WebSocketListener>> = new Map();

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
            specific.forEach((cb) => {
                try { cb(message); } catch (err) { console.error(`[WS emit error ${event}]:`, err); }
            });
        }
        const all = this.listeners.get("all");
        if (all) {
            all.forEach((cb) => {
                try { cb(message); } catch (err) { console.error("[WS emit all error]:", err); }
            });
        }
    }

    private url(path: string): string {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        return `${protocol}//${window.location.host}${path}`;
    }

    private static live(socket: WebSocket | null): boolean {
        return !!socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
    }

    /** Opens both sockets (idempotent: an open or connecting socket is kept). */
    public connect(): void {
        this.intentionallyClosed = false;
        if (!SocketManager.live(this.primarySocket)) this.connectPrimary();
        if (!SocketManager.live(this.streamSocket)) this.connectStreamHub();
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
        let socket: WebSocket;
        let opened = false;
        try {
            socket = new WebSocket(this.url("/ws"));
        } catch (err) {
            console.warn("[WS connect error]:", err);
            this.schedulePrimaryReconnect();
            return;
        }
        this.primarySocket = socket;

        socket.onopen = () => {
            opened = true;
            this.reconnectAttempts = 0;
        };

        socket.onmessage = (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data) as WebSocketInboundMessage;
                if (!data || !data.type) return;
                if (data.type === "auth_error") {
                    // The account is no longer recognised: stop reconnecting.
                    this.intentionallyClosed = true;
                }
                this.emit(data.type, data);
            } catch (parseErr) {
                console.warn("[WS message parse error]:", parseErr);
            }
        };

        socket.onclose = () => {
            if (this.primarySocket === socket) this.primarySocket = null;
            if (this.intentionallyClosed) return;
            if (!opened) window.dispatchEvent(new CustomEvent(SOCKET_FAILED_EVENT));
            this.schedulePrimaryReconnect();
        };

        socket.onerror = () => {
            // onclose follows and handles reconnection.
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
        this.primaryReconnectTimer = window.setTimeout(() => this.connectPrimary(), delay);
    }

    private connectStreamHub(): void {
        let socket: WebSocket;
        try {
            socket = new WebSocket(this.url("/ws/stream"));
        } catch {
            return;
        }
        this.streamSocket = socket;

        socket.onmessage = (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data) as WebSocketInboundMessage;
                if (data && data.type === "tick") this.emit("tick", data);
            } catch {
                // Ignore malformed hub frames
            }
        };

        socket.onclose = () => {
            if (this.streamSocket === socket) this.streamSocket = null;
            if (this.intentionallyClosed) return;
            if (this.streamReconnectTimer) clearTimeout(this.streamReconnectTimer);
            this.streamReconnectTimer = window.setTimeout(() => this.connectStreamHub(), 3000);
        };

        socket.onerror = () => {
            // The private socket still delivers the terminal's own ticks.
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
