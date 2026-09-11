// orbit-stream — ORBIT Go WebSocket Tick Hub
//
// Role: broadcast server for public market ticks. The ai-service's market
// tick scheduler POSTs real quotes to /publish; every connected client
// receives them. Browsers reach /ws through the Go gateway (/ws/stream), so
// this service needs no public port.
//
// Endpoints:
//
//	GET  /ws      — subscriber WebSocket (via the gateway)
//	POST /publish — ai-service delivers a JSON frame to broadcast
//	GET  /health  — liveness probe
//
// /publish requires the shared ORBIT_INTERNAL_TOKEN (X-Orbit-Internal-Token);
// without a token configured it accepts loopback callers only. It never
// accepts browser (Origin-bearing) requests, so no page can inject ticks.
//
// Build:  go build -o orbit-stream .
// Run:    ./orbit-stream --port 8002
package main

import (
	"crypto/subtle"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
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
	n := len(h.clients)
	h.mu.Unlock()
	log.Printf("[hub] client connected — total: %d", n)
}

func (h *Hub) unregister(c *Client) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
	}
	n := len(h.clients)
	h.mu.Unlock()
	log.Printf("[hub] client disconnected — total: %d", n)
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
// Client — one goroutine per subscriber WebSocket
// ---------------------------------------------------------------------------

type Client struct {
	conn *websocket.Conn
	send chan []byte // per-client outbound buffer
}

var upgrader = websocket.Upgrader{
	// Subscribers arrive through the gateway, which enforces the origin policy.
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
}

// writePump drains the client send channel and writes to the WebSocket.
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

// readPump consumes incoming frames (ping/close) so the WebSocket stack can
// answer pings and detect disconnects; subscriber messages are ignored.
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

// publishAuthorized accepts the ai-service: the shared token when one is
// configured, otherwise loopback callers; browser requests never.
func publishAuthorized(r *http.Request, token string) bool {
	if r.Header.Get("Origin") != "" {
		return false
	}
	if token != "" {
		supplied := r.Header.Get("X-Orbit-Internal-Token")
		return subtle.ConstantTimeCompare([]byte(supplied), []byte(token)) == 1
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// publishHandler receives a JSON payload from the ai-service and enqueues it
// for broadcast to all connected subscribers.
func publishHandler(h *Hub, token string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !publishAuthorized(r, token) {
			http.Error(w, "forbidden", http.StatusForbidden)
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
	// 8002 by default: 8000 is the gateway and 8001 the ai-service.
	defaultPort := "8002"
	if envPort := os.Getenv("PORT"); envPort != "" {
		defaultPort = envPort
	} else if envStreamPort := os.Getenv("STREAM_PORT"); envStreamPort != "" {
		defaultPort = envStreamPort
	}
	port := flag.String("port", defaultPort, "TCP port to listen on")
	flag.Parse()

	token := strings.TrimSpace(os.Getenv("ORBIT_INTERNAL_TOKEN"))
	if token == "" {
		log.Printf("[orbit-stream] ORBIT_INTERNAL_TOKEN not set: /publish accepts loopback callers only")
	}

	hub := newHub()
	go hub.run()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", wsHandler(hub))
	mux.HandleFunc("/publish", publishHandler(hub, token))
	mux.HandleFunc("/health", healthHandler)

	addr := ":" + *port
	log.Printf("[orbit-stream] listening on %s  (ws://%s/ws | POST :%s/publish)", addr, addr, *port)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("[orbit-stream] fatal: %v", err)
	}
}
