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

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mochatrade/backend/botsched"
	"github.com/mochatrade/backend/cache"
	"github.com/mochatrade/backend/config"
	"github.com/mochatrade/backend/database"
	"github.com/mochatrade/backend/handlers"
	"github.com/mochatrade/backend/middleware"
	"github.com/mochatrade/backend/proxy"
	"github.com/mochatrade/backend/readapi"
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

// gateway holds everything the router needs.
type gateway struct {
	aiURL          string
	streamURL      string
	internalToken  string
	authn          *middleware.Authenticator
	apiProxy       http.Handler
	read           *readapi.Handlers
	hub            *proxy.UserHub
	scheduler      *botsched.Supervisor
	schedulerStats func() map[string]any
	health         http.Handler
	frontendDir    string
	nodeModulesDir string
	allowedOrigins []string
}

func main() {
	loaded := config.LoadDotEnv(filepath.Join("..", ".env"), ".env", filepath.Join("..", "ai-service", ".env"))

	port := config.EnvDefault("PORT", "8000")
	aiServiceURL := config.EnvDefault("AI_SERVICE_URL", "http://127.0.0.1:8001")
	streamURL := config.EnvDefault("STREAM_SERVICE_URL", "http://127.0.0.1:8002")
	internalToken := config.Env("ORBIT_INTERNAL_TOKEN")

	log.Printf("[gateway] Initializing Go Backend Gateway on port %s", port)
	if len(loaded) > 0 {
		log.Printf("[gateway] Environment loaded from %s", strings.Join(loaded, ", "))
	}
	log.Printf("[gateway] Python AI Service target: %s", aiServiceURL)
	log.Printf("[gateway] Stream hub target: %s", streamURL)
	if internalToken == "" {
		log.Printf("[gateway] ORBIT_INTERNAL_TOKEN not set: gateway<->ai-service trust relies on loopback only")
	}

	rootCtx, rootCancel := context.WithCancel(context.Background())
	defer rootCancel()

	// PostgreSQL read layer. Without it every read is proxied to Python.
	var pool *pgxpool.Pool
	dbURL := config.Env("DATABASE_URL")
	dbConfigured := database.IsPostgresURL(dbURL)
	if dbConfigured {
		p, err := database.Connect(rootCtx, dbURL)
		if err != nil {
			log.Printf("[gateway] DATABASE: unavailable (%v); portfolio reads fall back to the ai-service", err)
		} else {
			pool = p
			defer pool.Close()
			log.Printf("[gateway] DATABASE: connected (pgx pool)")
		}
	} else {
		log.Printf("[gateway] DATABASE: DATABASE_URL is not PostgreSQL; the ai-service (SQLite) owns all reads")
	}

	// Valkey live-price cache (written by the ai-service tick scheduler).
	var valkey *cache.Valkey
	valkeyURL := cache.URLFromEnv()
	if valkeyURL != "" {
		v, err := cache.Connect(rootCtx, valkeyURL)
		if err != nil {
			log.Printf("[gateway] VALKEY: unavailable (%v); live-priced reads fall back to the ai-service", err)
		} else {
			valkey = v
			defer valkey.Close()
			log.Printf("[gateway] VALKEY: connected")
		}
	}

	// Authentication.
	sessions, err := middleware.NewSessionManager(config.Env("ORBIT_SESSION_SECRET"), config.EnvDuration("ORBIT_SESSION_TTL", 12*time.Hour))
	if err != nil {
		log.Fatalf("[gateway] %v", err)
	}
	if sessions.Ephemeral() {
		log.Printf("[gateway] ORBIT_SESSION_SECRET not set: using a per-process session key (sign-ins end when the gateway restarts)")
	}
	var clerk *middleware.ClerkVerifier
	issuer := config.Env("CLERK_ISSUER")
	if issuer == "" {
		if pk := config.Env("CLERK_PUBLISHABLE_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"); pk != "" {
			if iss, err := middleware.IssuerFromPublishableKey(pk); err == nil {
				issuer = iss
			} else {
				log.Printf("[gateway] Clerk publishable key unusable: %v", err)
			}
		}
	}
	if issuer != "" {
		parties := config.EnvList("CLERK_AUTHORIZED_PARTIES")
		clerk, err = middleware.NewClerkVerifier(issuer, config.Env("CLERK_JWKS_URL"), parties, config.Env("CLERK_AUDIENCE"))
		if err != nil {
			log.Fatalf("[gateway] Clerk verifier: %v", err)
		}
		log.Printf("[gateway] AUTH: Clerk session tokens verified against %s (JWKS)", clerk.Issuer())
		if len(parties) == 0 {
			log.Printf("[gateway] CLERK_AUTHORIZED_PARTIES not set: the token azp (origin) claim is not restricted")
		}
	} else {
		log.Printf("[gateway] AUTH: Clerk not configured; only gateway password sessions are accepted")
	}
	var resolver middleware.UserResolver
	if pool != nil {
		resolver = middleware.DBResolver{Pool: pool}
	} else {
		resolver = middleware.HTTPResolver{BaseURL: aiServiceURL, Token: internalToken}
	}
	authn := &middleware.Authenticator{
		Sessions: sessions,
		Clerk:    clerk,
		Resolver: &middleware.CachingResolver{Next: resolver, TTL: time.Minute},
	}

	apiProxy, err := proxy.NewHTTPProxy(aiServiceURL, internalToken, authn.IssueSessionOnSuccess)
	if err != nil {
		log.Fatalf("[gateway] Failed to create HTTP reverse proxy: %v", err)
	}

	read := &readapi.Handlers{Fallback: apiProxy}
	if pool != nil {
		read.Store = readapi.PGStore{Pool: pool}
	}
	if valkey != nil {
		read.Prices = valkey
	}

	// Auto-Trade Bot scheduler: all bot concurrency (per-session goroutines,
	// bounded parallelism, per-symbol single-flight analysis, leader lease,
	// graceful stop) runs here; the ai-service executes single steps.
	var scheduler *botsched.Supervisor
	var schedulerStats func() map[string]any
	if !strings.EqualFold(config.Env("BOT_SCHEDULER_ENABLED"), "false") {
		scheduler = botsched.New(botsched.Config{}, botsched.NewHTTPEngine(aiServiceURL, internalToken))
		schedulerStats = scheduler.Stats
		go scheduler.Run(rootCtx)
		log.Printf("[gateway] Auto-Trade Bot scheduler running (lease owner %s)", scheduler.Owner())
	}

	healthDeps := handlers.HealthDeps{
		AIServiceURL: aiServiceURL,
		StreamURL:    streamURL,
		DBConfigured: dbConfigured,
		ValkeyURLSet: valkeyURL != "",
		Clerk:        clerk != nil,
		Ephemeral:    sessions.Ephemeral(),
	}
	if pool != nil {
		healthDeps.DB = pool
	}
	if valkey != nil {
		healthDeps.Valkey = valkey
	}

	frontendDir := config.Env("FRONTEND_PATH")
	if frontendDir == "" {
		frontendDir = resolvePath("../frontend", "./frontend")
	}
	if frontendDir != "" {
		log.Printf("[gateway] Serving frontend from: %s", frontendDir)
	} else {
		log.Printf("[gateway] WARNING: frontend directory not found!")
	}
	nodeModulesDir := config.Env("NODE_MODULES_PATH")
	if nodeModulesDir == "" {
		nodeModulesDir = resolvePath("../node_modules", "./node_modules")
	}

	g := &gateway{
		aiURL:          aiServiceURL,
		streamURL:      streamURL,
		internalToken:  internalToken,
		authn:          authn,
		apiProxy:       apiProxy,
		read:           read,
		hub:            proxy.NewUserHub(),
		scheduler:      scheduler,
		schedulerStats: schedulerStats,
		health:         handlers.HealthHandler(healthDeps),
		frontendDir:    frontendDir,
		nodeModulesDir: nodeModulesDir,
		allowedOrigins: config.EnvList("ORBIT_ALLOWED_ORIGINS"),
	}

	srv := &http.Server{
		Addr:        ":" + port,
		Handler:     g.routes(),
		ReadTimeout: 30 * time.Second,
		// AI analysis and Copilot answers can take tens of seconds.
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		log.Printf("[gateway] Server listening at http://localhost:%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[gateway] Server listen error: %v", err)
		}
	}()

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

// routes builds the gateway's HTTP handler.
//
// Security model: every /api route is private unless middleware.APIAccess
// lists it as public. Private routes need a verified identity (gateway session
// or Clerk JWT) bound to an ORBIT account, and are scoped to that account
// before they reach a Go handler or the ai-service.
func (g *gateway) routes() http.Handler {
	mux := http.NewServeMux()
	user := func(h http.HandlerFunc) http.Handler {
		return g.authn.RequireUser(middleware.EnforceUserScope(h))
	}
	origins := proxy.SameOriginOrAllowed(g.allowedOrigins)

	// 1. Health
	mux.Handle("/health", g.health)
	mux.HandleFunc("/health/bot-scheduler", handlers.BotSchedulerStatsHandler(g.schedulerStats))

	// 2. Session endpoints owned by the gateway
	mux.Handle("POST /api/auth/logout", g.authn.LogoutHandler())
	mux.Handle("GET /api/auth/me", g.authn.RequireUser(middleware.MeHandler()))

	// 3. Go-native PostgreSQL reads (same contract as the ai-service)
	for _, p := range []string{"/api/dashboard/summary", "/api/dashboard", "/api/portfolio/summary"} {
		mux.Handle("GET "+p, user(g.read.DashboardSummary))
	}
	for _, p := range []string{"/api/trades/open", "/api/positions"} {
		mux.Handle("GET "+p, user(g.read.OpenTrades))
	}
	mux.Handle("GET /api/trades/history", user(g.read.TradesHistory))
	mux.Handle("GET /api/bot-config", user(g.read.BotConfig))

	// 4. Everything else under /api -> ai-service, by access policy
	mux.Handle("/api/", botWakeHook(g.apiGateway(), g.scheduler))

	// 5. WebSockets: private user channel (ai-service) and public tick stream
	mux.Handle("/ws", g.authn.RequireUser(proxy.NewWebSocketProxy(g.aiURL, g.hub, g.internalToken, origins)))
	mux.Handle("/ws/stream", proxy.NewStreamProxy(g.streamURL, origins))

	// 6. Internal: ai-service -> gateway user-scoped event fan-out
	mux.HandleFunc("/internal/events/publish", handlers.PublishUserEventHandler(g.hub, g.internalToken))

	// 7. Static node_modules (if present)
	if g.nodeModulesDir != "" {
		mux.Handle("/node_modules/", http.StripPrefix("/node_modules/", http.FileServer(http.Dir(g.nodeModulesDir))))
	}

	// 8. Static frontend
	if g.frontendDir != "" {
		frontendDir := g.frontendDir
		mux.Handle("/frontend/", http.StripPrefix("/frontend/", http.FileServer(http.Dir(frontendDir))))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				relPath := strings.TrimPrefix(filepath.Clean(r.URL.Path), string(filepath.Separator))
				relPath = strings.TrimPrefix(relPath, "/")
				filePath := filepath.Join(frontendDir, relPath)
				if strings.HasPrefix(filePath, frontendDir) {
					if stat, err := os.Stat(filePath); err == nil && !stat.IsDir() {
						setNoCache(w, filePath)
						http.ServeFile(w, r, filePath)
						return
					}
				}
				http.NotFound(w, r)
				return
			}
			indexPath := filepath.Join(frontendDir, "index.html")
			setNoCache(w, indexPath)
			http.ServeFile(w, r, indexPath)
		})
	}

	return loggingMiddleware(corsMiddleware(g.allowedOrigins, securityHeaders(mux)))
}

// apiGateway applies the access policy to /api routes without a Go-native
// handler, then forwards them to the ai-service.
func (g *gateway) apiGateway() http.Handler {
	userChain := g.authn.RequireUser(middleware.EnforceUserScope(g.apiProxy))
	clerkChain := g.authn.RequireClerk(g.apiProxy)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := strings.ToLower(r.URL.RawPath)
		if strings.Contains(raw, "%2e") || strings.Contains(raw, "%2f") || strings.Contains(raw, "%5c") {
			middleware.WriteError(w, http.StatusBadRequest, "Invalid path.")
			return
		}
		switch middleware.APIAccess(r.URL.Path) {
		case middleware.AccessPublic:
			g.apiProxy.ServeHTTP(w, r)
		case middleware.AccessClerk:
			clerkChain.ServeHTTP(w, r)
		default:
			userChain.ServeHTTP(w, r)
		}
	})
}

func setNoCache(w http.ResponseWriter, path string) {
	if strings.HasSuffix(path, ".html") || strings.HasSuffix(path, ".js") || strings.HasSuffix(path, ".css") || path == "/" {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
	}
}

// corsMiddleware answers cross-origin requests only for ORBIT_ALLOWED_ORIGINS.
// The frontend is served by this gateway (same origin), so by default no CORS
// headers are sent: reflecting any Origin with credentials would let any site
// act on a signed-in user's session.
func corsMiddleware(allowed []string, next http.Handler) http.Handler {
	set := map[string]bool{}
	for _, o := range allowed {
		set[strings.TrimRight(o, "/")] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && set[strings.TrimRight(origin, "/")] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Cache-Control")
			w.Header().Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		next.ServeHTTP(w, r)
	})
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if !strings.HasPrefix(r.URL.Path, "/frontend/") && !strings.HasPrefix(r.URL.Path, "/node_modules/") {
			// Path only: query strings are never logged.
			fmt.Printf("[%s] %s %s - %v\n", time.Now().Format("15:04:05"), r.Method, r.URL.Path, time.Since(start))
		}
	})
}
