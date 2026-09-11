// orbit-stream — ORBIT Phase 11 Go WebSocket Tick Hub
//
// Role: high-concurrency broadcast server sitting between the Python backend
//       and browser clients. Python POSTs tick/metric payloads to /publish;
//       all registered WebSocket clients receive them in < 1 ms.
//
// Endpoints:
//   GET  /ws      — browser WebSocket connection
//   POST /publish — Python backend delivers a JSON payload to broadcast
//   GET  /health  — liveness probe
//
// Build:  go build -o orbit-stream .
// Run:    ./orbit-stream --port 8001
package main

import (
	"encoding/json"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"sync"

	"github.com/gorilla/websocket"
)

// ---------------------------------------------------------------------------
// Hub — central fanout registry
// ---------------------------------------------------------------------------

type Hub struct {
	mu        sync.RWMutex
	clients   map[*Client]bool
	broadcast chan []byte
}

func newHub() *Hub {
	return &Hub{
		clients:   make(map[*Client]bool),
		broadcast: make(chan []byte, 256),
	}
}

func (h *Hub) register(c *Client) {
	h.mu.Lock()
	h.clients[c] = true
	h.mu.Unlock()
	log.Printf("[hub] client connected — total: %d", len(h.clients))
}

func (h *Hub) unregister(c *Client) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
	}
	h.mu.Unlock()
	log.Printf("[hub] client disconnected — total: %d", len(h.clients))
}

// run drains the broadcast channel and fans out to every client.
// Runs in its own goroutine for the lifetime of the process.
func (h *Hub) run() {
	for msg := range h.broadcast {
		h.mu.RLock()
		for c := range h.clients {
			select {
			case c.send <- msg:
			default:
				// Slow client: drop one frame rather than block the hub.
				log.Printf("[hub] slow client — dropped frame")
			}
		}
		h.mu.RUnlock()
	}
}

// ---------------------------------------------------------------------------
// Client — one goroutine per browser WebSocket
// ---------------------------------------------------------------------------

type Client struct {
	conn *websocket.Conn
	send chan []byte // per-client outbound buffer
}

var upgrader = websocket.Upgrader{
	// Allow all origins — orbit-stream is local-only (localhost)
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
}

// writePump drains the client send channel and writes to the WebSocket.
// One goroutine per client — zero shared mutable state.
func (c *Client) writePump(h *Hub) {
	defer func() {
		c.conn.Close()
	}()
	for msg := range c.send {
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			return
		}
	}
}

// readPump consumes incoming frames (ping/close/browser messages).
// We don't act on browser→hub messages; we just need to drain them
// so the WebSocket stack can send pong responses and detect disconnects.
func (c *Client) readPump(h *Hub) {
	defer h.unregister(c)
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
	}
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

func wsHandler(h *Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("[ws] upgrade error: %v", err)
			return
		}
		c := &Client{conn: conn, send: make(chan []byte, 128)}
		h.register(c)
		go c.writePump(h)
		c.readPump(h) // blocks until socket closes; unregisters on return
	}
}

// publishHandler receives a JSON payload from the Python backend and
// enqueues it for broadcast to all connected browser WebSockets.
//
// Python calls:
//
//	httpx.post("http://localhost:8001/publish", json=payload, timeout=0.05)
func publishHandler(h *Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 64*1024))
		if err != nil || !json.Valid(body) {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		select {
		case h.broadcast <- body:
		default:
			log.Printf("[publish] broadcast channel full — dropped frame")
		}
		w.WriteHeader(http.StatusNoContent) // 204 — accepted, no response body
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true,"service":"orbit-stream"}`))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

func main() {
	defaultPort := "8001"
	if envPort := os.Getenv("PORT"); envPort != "" {
		defaultPort = envPort
	} else if envStreamPort := os.Getenv("STREAM_PORT"); envStreamPort != "" {
		defaultPort = envStreamPort
	}
	port := flag.String("port", defaultPort, "TCP port to listen on")
	flag.Parse()

	hub := newHub()
	go hub.run()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", wsHandler(hub))
	mux.HandleFunc("/publish", publishHandler(hub))
	mux.HandleFunc("/health", healthHandler)

	addr := ":" + *port
	log.Printf("[orbit-stream] listening on %s  (ws://%s/ws | POST :%s/publish)", addr, addr, *port)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("[orbit-stream] fatal: %v", err)
	}
}
