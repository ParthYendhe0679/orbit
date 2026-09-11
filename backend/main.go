
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/mochatrade/backend/botsched"
	"github.com/mochatrade/backend/handlers"
	"github.com/mochatrade/backend/proxy"
)

// botWakeHook forwards to next, then nudges the bot scheduler after a bot
// start/stop/config request so the change is picked up immediately instead of
// on the next poll.
func botWakeHook(next http.Handler, scheduler *botsched.Supervisor) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		if scheduler != nil && r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/bot") {
			scheduler.Wake()
		}
	})
}

// resolvePath checks multiple candidate locations to find a directory
func resolvePath(candidates ...string) string {
	for _, c := range candidates {
		abs, err := filepath.Abs(c)
		if err == nil {
			if stat, err := os.Stat(abs); err == nil && stat.IsDir() {
				return abs
			}
		}
	}
	return ""
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}

	aiServiceURL := os.Getenv("AI_SERVICE_URL")
	if aiServiceURL == "" {
		aiServiceURL = "http://127.0.0.1:8001"
	}

	log.Printf("[gateway] Initializing Go Backend Gateway on port %s", port)
	log.Printf("[gateway] Python AI Service target: %s", aiServiceURL)

	// Resolve frontend and node_modules directory paths
	frontendDir := os.Getenv("FRONTEND_PATH")
	if frontendDir == "" {
		frontendDir = resolvePath("../frontend", "./frontend")
	}
	if frontendDir != "" {
		log.Printf("[gateway] Serving frontend from: %s", frontendDir)
	} else {
		log.Printf("[gateway] WARNING: frontend directory not found!")
	}

	nodeModulesDir := os.Getenv("NODE_MODULES_PATH")
	if nodeModulesDir == "" {
		nodeModulesDir = resolvePath("../node_modules", "./node_modules")
	}

	// Create reverse proxies
	httpProxy, err := proxy.NewHTTPProxy(aiServiceURL)
	if err != nil {
		log.Fatalf("[gateway] Failed to create HTTP reverse proxy: %v", err)
	}
	internalToken := strings.TrimSpace(os.Getenv("ORBIT_INTERNAL_TOKEN"))
	if internalToken == "" {
		log.Printf("[gateway] ORBIT_INTERNAL_TOKEN not set: /internal/* only accepts loopback callers")
	}

	// Browser sockets are registered by user so user-scoped events (bot
	// activity) can be pushed from here.
	userHub := proxy.NewUserHub()
	wsProxy := proxy.NewWebSocketProxy(aiServiceURL, userHub)

	// Auto-Trade Bot scheduler: all bot concurrency (per-session goroutines,
	// bounded parallelism, per-symbol single-flight analysis, leader lease,
	// graceful stop) runs here; the ai-service executes single steps.
	rootCtx, rootCancel := context.WithCancel(context.Background())
	defer rootCancel()
	var scheduler *botsched.Supervisor
	var schedulerStats func() map[string]any
	if !strings.EqualFold(strings.TrimSpace(os.Getenv("BOT_SCHEDULER_ENABLED")), "false") {
		scheduler = botsched.New(botsched.Config{}, botsched.NewHTTPEngine(aiServiceURL, internalToken))
		schedulerStats = scheduler.Stats
		go scheduler.Run(rootCtx)
		log.Printf("[gateway] Auto-Trade Bot scheduler running (lease owner %s)", scheduler.Owner())
	}

	mux := http.NewServeMux()

	// 1. Health check endpoint (reports Go status and probes Python AI status)
	mux.HandleFunc("/health", handlers.HealthHandler(aiServiceURL))
	mux.HandleFunc("/health/bot-scheduler", handlers.BotSchedulerStatsHandler(schedulerStats))

	// 2. WebSocket endpoint (transparent proxy to AI service preserving contract)
	mux.HandleFunc("/ws", wsProxy)

	// 3. REST API reverse proxy (/api/*)
	mux.Handle("/api/", botWakeHook(httpProxy, scheduler))
	mux.Handle("/api", httpProxy)

	// 4. Internal: ai-service -> gateway user-scoped event fan-out
	mux.HandleFunc("/internal/events/publish", handlers.PublishUserEventHandler(userHub, internalToken))

	// 4. Static node_modules (if present)
	if nodeModulesDir != "" {
		fsNodeModules := http.StripPrefix("/node_modules/", http.FileServer(http.Dir(nodeModulesDir)))
		mux.Handle("/node_modules/", fsNodeModules)
	}

	// 5. Static frontend assets (/frontend/*)
	if frontendDir != "" {
		fsFrontend := http.StripPrefix("/frontend/", http.FileServer(http.Dir(frontendDir)))
		mux.Handle("/frontend/", fsFrontend)

		// Root endpoint / serves frontend/index.html
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				// Check if file exists directly under frontend directory
				relPath := strings.TrimPrefix(r.URL.Path, "/")
				filePath := filepath.Join(frontendDir, relPath)
				if stat, err := os.Stat(filePath); err == nil && !stat.IsDir() {
					setNoCache(w, filePath)
					http.ServeFile(w, r, filePath)
					return
				}
				// 404 handler
				http.NotFound(w, r)
				return
			}

			indexPath := filepath.Join(frontendDir, "index.html")
			setNoCache(w, indexPath)
			http.ServeFile(w, r, indexPath)
		})
	}

	// Wrap mux with CORS, cache control, and logging middleware
	handler := loggingMiddleware(corsMiddleware(mux))

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      handler,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Run server in goroutine
	go func() {
		log.Printf("[gateway] Server listening at http://localhost:%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[gateway] Server listen error: %v", err)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	<-quit

	log.Printf("[gateway] Shutting down gateway server...")
	rootCancel() // bot scheduler: finish in-flight steps, start no new ones
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("[gateway] Server shutdown error: %v", err)
	}
	log.Printf("[gateway] Server cleanly stopped.")
}

func setNoCache(w http.ResponseWriter, path string) {
	if strings.HasSuffix(path, ".html") || strings.HasSuffix(path, ".js") || strings.HasSuffix(path, ".css") || path == "/" {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
	}
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		} else {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Cache-Control")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		// Don't spam logs for frequent static assets or health checks if desired, but keep visible
		next.ServeHTTP(w, r)
		duration := time.Since(start)
		if !strings.HasPrefix(r.URL.Path, "/frontend/") && !strings.HasPrefix(r.URL.Path, "/node_modules/") {
			fmt.Printf("[%s] %s %s - %v\n", time.Now().Format("15:04:05"), r.Method, r.URL.RequestURI(), duration)
		}
	})
}
