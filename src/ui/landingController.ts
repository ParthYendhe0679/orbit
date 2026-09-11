/**
 * ORBIT Trading Terminal — Landing Page Showcase Controller
 * Encapsulates skills catalog, strategy suite grid, AI simulation demo, and canvas sparkline
 */

import { getElement } from "../utils/dom";

export interface SkillItem {
    id: string;
    name: string;
    category: string;
    icon: string;
    iconColor: string;
    desc: string;
    rules: string;
}

export interface StrategyItem {
    id: string;
    name: string;
    type: string;
    formula: string;
    desc: string;
    trigger: string;
}

export const ULTIMATE_SKILLS_DATA: SkillItem[] = [
    {
        id: "ultimate-frontend-design",
        name: "UI/UX Pro Max & Frontend Taste",
        category: "frontend",
        icon: "fa-palette",
        iconColor: "skill-icon-purple",
        desc: "Enforces visual balance, curated color palettes, clean typography, whitespace discipline, and eliminates generic aesthetics.",
        rules: "1. Anti-Slop Discipline: Refuse generic browser defaults and harsh primaries.\n2. Fluid Typography: Scale via clamp() with tailored Google Fonts (Outfit, Inter, JetBrains Mono).\n3. Depth: Multi-layer backdrop blur, hairline gradients, and micro-elevation.\n4. Motion: 60fps micro-interactions with spring physics."
    },
    {
        id: "ultimate-web-animation",
        name: "Web Motion & Physics Springs",
        category: "frontend",
        icon: "fa-wand-magic-sparkles",
        iconColor: "skill-icon-purple",
        desc: "Provides context for physics-based springs, easing curves, continuous orbital loops, gesture response, and performant 60fps animations.",
        rules: "1. CSS Transform Only: Animate translate3d() and scale() to guarantee compositor thread rendering.\n2. Easing: Cubic-bezier(0.16, 1, 0.3, 1) for snappy response.\n3. Accessibility: Respect prefers-reduced-motion media query.\n4. Will-Change: Surgical application to prevent layer explosion."
    },
    {
        id: "ultimate-3d-visuals",
        name: "3D WebGL & Shaders",
        category: "frontend",
        icon: "fa-cube",
        iconColor: "skill-icon-cyan",
        desc: "Specialized in Three.js, WebGL canvas rendering, spatial visualizers, neon market grids, and interactive 3D candlestick meshes.",
        rules: "1. Geometry Pooling: Re-use buffer geometries to prevent GC hitches.\n2. Instanced Rendering: Lightweight box/tube batches for 100+ candlesticks.\n3. Fog & Depth: FogExp2 for atmospheric lighting.\n4. Parallax: Mouse coordinate interpolation via Lerp."
    },
    {
        id: "ultimate-web-gamedev",
        name: "Web Canvas & Realtime Systems",
        category: "frontend",
        icon: "fa-gamepad",
        iconColor: "skill-icon-cyan",
        desc: "High-frequency 60 FPS HTML5 canvas drawing loops, real-time sparklines, matrix math, and vectorized chart overlays.",
        rules: "1. RequestAnimationFrame Loop with delta time clamping.\n2. Pixel Ratio Scaling: window.devicePixelRatio handling for retina sharpness.\n3. Canvas Dirty Rects: Clear only modified sectors during high-rate ticks."
    },
    {
        id: "ultimate-api-architecture",
        name: "High-Performance API Architecture",
        category: "backend",
        icon: "fa-network-wired",
        iconColor: "skill-icon-yellow",
        desc: "Designs high-concurrency FastAPI & Node.js backends, bi-directional WebSocket streaming, and distributed microservices.",
        rules: "1. ASGI Asynchrony: Non-blocking async/await for all network and database I/O.\n2. Streaming Protocols: WebSocket bi-directional channels for tick distribution.\n3. Schema Validation: Pydantic v2 type safety across all endpoints."
    },
    {
        id: "ultimate-postgres-ecosystem",
        name: "PostgreSQL & Neon Cloud DB",
        category: "backend",
        icon: "fa-database",
        iconColor: "skill-icon-yellow",
        desc: "PostgreSQL, Neon serverless cloud databases, complex SQL aggregations, table migrations, and SQLite embedded fallback.",
        rules: "1. Connection Pooling: Efficient connection management with timeouts.\n2. Automated Migrations: Auto-create tables (trades, users, logs) at server startup.\n3. Dual-Persistence: Seamless fallback to SQLite3 when DATABASE_URL is absent."
    },
    {
        id: "ultimate-state-management",
        name: "State Management & Live Stores",
        category: "backend",
        icon: "fa-boxes-stacked",
        iconColor: "skill-icon-yellow",
        desc: "Manages complex frontend and backend state, reactive stores, cache invalidation, and synchronized trade journals.",
        rules: "1. Single Source of Truth: Centralized application state.\n2. Optimistic Updates: Immediate UI reflection on trade trigger followed by backend confirmation."
    },
    {
        id: "ultimate-cloudflare-expert",
        name: "Cloudflare Edge & Workers",
        category: "backend",
        icon: "fa-cloud",
        iconColor: "skill-icon-yellow",
        desc: "Edge functions, Cloudflare D1 databases, R2 storage, edge caching, and global sub-10ms content distribution.",
        rules: "1. Zero Cold Starts: Edge-first deployment patterns.\n2. Resilient Retries: Automatic exponential backoff on upstream network failures."
    },
    {
        id: "ultimate-llm-optimization",
        name: "LLM Context & Failover Pools",
        category: "ai",
        icon: "fa-brain",
        iconColor: "skill-icon-purple",
        desc: "Optimizes prompts, token context, key pooling, round-robin load distribution, and multi-provider failover (Gemini + Groq).",
        rules: "1. Deterministic Extraction: Strict regex and JSON schema enforcement on LLM outputs.\n2. Key Pooling: Auto-cycle through API keys on 429 quota exhaustion.\n3. Multi-Provider Fallback: Seamless Google Gemini -> Groq Cloud Llama-3 failover."
    },
    {
        id: "ultimate-mobile-engineering",
        name: "Mobile & Flutter Engineering",
        category: "frontend",
        icon: "fa-mobile-screen",
        iconColor: "skill-icon-cyan",
        desc: "Cross-platform mobile heuristics, Flutter architecture, responsive touch gestures, and native bridges.",
        rules: "1. Adaptive Breakpoints: Fluid layouts for mobile (320px) through 4K displays.\n2. Touch Targets: Minimum 44x44px clickable areas for mobile terminal interaction."
    },
    {
        id: "ultimate-devops-cicd",
        name: "DevOps & CI/CD Pipelines",
        category: "infra",
        icon: "fa-docker",
        iconColor: "skill-icon-green",
        desc: "Docker containerization, GitHub Actions workflows, multi-stage production builds, and headless daemons.",
        rules: "1. Immutable Builds: Multi-stage Dockerfiles with unprivileged user execution.\n2. Health Checks: Active /health endpoints for orchestrator liveness probes."
    },
    {
        id: "ultimate-security-auditor",
        name: "OWASP Security Auditing",
        category: "infra",
        icon: "fa-shield-halved",
        iconColor: "skill-icon-green",
        desc: "Performs penetration testing, threat modeling, JWT authentication, rate-limiting, and CORS protection.",
        rules: "1. Input Sanitization: Strict parameter validation to eliminate SQL injection.\n2. Secret Security: Zero secrets committed to Git; 100% loaded via .env.\n3. Rate Limiting: Safeguard LLM and execution endpoints from abusive bursts."
    },
    {
        id: "ultimate-sentry-expert",
        name: "Sentry Telemetry & Monitoring",
        category: "infra",
        icon: "fa-chart-pie",
        iconColor: "skill-icon-green",
        desc: "Error tracking, distributed tracing, WebSocket performance telemetry, and automated incident alert routing.",
        rules: "1. Contextual Breadcrumbs: Attach asset ticker, agent step, and timestamp to all exceptions.\n2. Performance Spans: Measure quant strategy evaluation latency."
    },
    {
        id: "ultimate-seo-marketing",
        name: "Agentic SEO & Structured Data",
        category: "frontend",
        icon: "fa-magnifying-glass",
        iconColor: "skill-icon-purple",
        desc: "Technical SEO, Core Web Vitals optimization, OpenGraph social meta tags, and JSON-LD structured schemas.",
        rules: "1. JSON-LD Schemas: SoftwareApplication and FinancialProduct structured metadata.\n2. OpenGraph: Rich preview cards for Twitter and social platforms."
    },
    {
        id: "ultimate-testing-qa",
        name: "Testing QA & Playwright Auditing",
        category: "infra",
        icon: "fa-vial-circle-check",
        iconColor: "skill-icon-green",
        desc: "Unit testing, mathematical indicator verification, Playwright E2E browser tests, and regression prevention.",
        rules: "1. Mathematical Rigor: Verify indicator formulas against benchmark data.\n2. Headless E2E: Automated tests validating login, order placement, and chart rendering."
    },
    {
        id: "ultimate-ux-research",
        name: "UX Research & Cognitive Flow",
        category: "frontend",
        icon: "fa-user-astronaut",
        iconColor: "skill-icon-purple",
        desc: "User discovery, cognitive load reduction, trading HUD ergonomics, and clear telemetry typography.",
        rules: "1. 3-Second Heuristic: A trader must understand market bias, consensus vote, and risk status in under 3 seconds."
    },
    {
        id: "ultimate-git-collaboration",
        name: "Git Collaboration & Discipline",
        category: "infra",
        icon: "fa-code-branch",
        iconColor: "skill-icon-green",
        desc: "Conventional commits, surgical branching, conflict-free pull requests, and atomic change hygiene.",
        rules: "1. Surgical Commits: Group related files by feature layer; never bundle unrelated changes."
    },
    {
        id: "ultimate-firebase-expert",
        name: "Firebase & Cloud BaaS",
        category: "backend",
        icon: "fa-fire",
        iconColor: "skill-icon-yellow",
        desc: "Firestore schema design, Cloud Functions, Security Rules, and real-time document listeners.",
        rules: "1. Security Rules: Strict user-isolated document access policies."
    },
    {
        id: "ultimate-assets-media",
        name: "Media Assets & WebP Optimization",
        category: "frontend",
        icon: "fa-image",
        iconColor: "skill-icon-purple",
        desc: "Asset compression, modern WebP/AVIF images, responsive srcset, and zero-layout-shift lazy loading.",
        rules: "1. Modern Formats: Serve WebP/AVIF with aspect-ratio containers to prevent layout shift."
    }
];

export const STRATEGIES_DATA: StrategyItem[] = [
    {
        id: "01",
        name: "Smart Money Concepts (SMC)",
        type: "Order Flow",
        formula: "BOS(20) + FVG(3-bar gap)",
        desc: "Identifies institutional footprints where price breaks swing structure and creates an unmitigated fair value imbalance gap.",
        trigger: "Trigger: 20-period swing break + return into Fair Value Gap"
    },
    {
        id: "02",
        name: "ICT Strategy",
        type: "Market Structure",
        formula: "MSS + Volume > 1.3x ATR",
        desc: "Market Structure Shift confirmed by high institutional volume expansion followed by mitigation into an imbalance zone.",
        trigger: "Trigger: Volume spike expansion on swing break + FVG"
    },
    {
        id: "03",
        name: "Wyckoff Method",
        type: "Liquidity Sweep",
        formula: "Spring / Upthrust (30-bar)",
        desc: "Catches false breakdowns (Springs) and false breakouts (Upthrusts) that trap retail liquidity before smart money reverses trend.",
        trigger: "Trigger: False breach of 30-bar range with sudden reversal"
    },
    {
        id: "04",
        name: "Price Action Rejections",
        type: "Candlestick Heuristic",
        formula: "Pin Bar & Engulfing at S/R",
        desc: "Monitors hammer/shooting star rejection wicks and engulfing expansion candles occurring within 1.5% of verified support/resistance.",
        trigger: "Trigger: Pin bar with 2x wick-to-body ratio at key level"
    },
    {
        id: "05",
        name: "Supply & Demand",
        type: "Base Retracement",
        formula: "Rally-Base-Rally (15-bar)",
        desc: "Pinpoints high-momentum origin zones where institutional orders caused rapid displacement, buying retests into the base.",
        trigger: "Trigger: Price retracing into unmitigated origin base"
    },
    {
        id: "06",
        name: "Trend Following Ribbon",
        type: "Momentum",
        formula: "EMA(9 > 21 > 50 > 200) + ADX > 22",
        desc: "Multi-timeframe exponential moving average alignment paired with Average Directional Index trend strength filter.",
        trigger: "Trigger: Pullback into EMA21 during aligned expansion"
    },
    {
        id: "07",
        name: "Bollinger Breakout",
        type: "Volatility",
        formula: "Squeeze(BandWidth < 0.05) + Close > UpperBand",
        desc: "Detects extreme volatility contraction followed by high-volume range expansion piercing the upper standard deviation envelope.",
        trigger: "Trigger: Squeeze breakout candle closing outside envelope"
    },
    {
        id: "08",
        name: "Mean Reversion (RSI Extreme)",
        type: "Statistical",
        formula: "RSI(14) < 25 OR > 75 + Bollinger 2.5 SD",
        desc: "Statistical counter-trend reversion system fading exhaustion extremes when RSI diverges at 2.5-sigma envelope boundaries.",
        trigger: "Trigger: RSI curl back from sub-25 or supra-75 extreme"
    },
    {
        id: "09",
        name: "VWAP Institutional Anchors",
        type: "Benchmark",
        formula: "Price vs Session VWAP +/- 1.5 SD Bands",
        desc: "Tracks institutional execution benchmarking; triggers on test of dynamic volume-weighted standard deviation bands.",
        trigger: "Trigger: Retest of -1.5 SD band with volume confirmation"
    },
    {
        id: "10",
        name: "Fibonacci Confluence Matrix",
        type: "Geometry",
        formula: "Retracement 61.8% + Extension 161.8%",
        desc: "Algorithmic multi-swing harmonic overlap clustering identifying golden pocket zones where multiple fibonacci levels intersect.",
        trigger: "Trigger: Rejection candle at 61.8% golden pocket confluence"
    },
    {
        id: "11",
        name: "Liquidity Grab (Stop Hunt)",
        type: "Auction Theory",
        formula: "Sweep of Previous Day High/Low + Rejection",
        desc: "Capitalizes on institutional sweeps of retail stop-loss clusters resting above yesterday's high or below yesterday's low.",
        trigger: "Trigger: Sharp false break of PDH/PDL returning into range"
    },
    {
        id: "12",
        name: "Momentum Divergence (MACD)",
        type: "Indicator",
        formula: "Lower Low in Price + Higher Low in MACD Hist",
        desc: "Identifies exhaustion in the prevailing trend when market velocity slows before structural price reversal occurs.",
        trigger: "Trigger: MACD histogram bullish/bearish crossover divergence"
    }
];

export function renderSkills(category: string = "all"): void {
    const grid = getElement("skills-grid");
    if (!grid) return;

    const filtered = category === "all"
        ? ULTIMATE_SKILLS_DATA
        : ULTIMATE_SKILLS_DATA.filter(s => s.category === category);

    grid.innerHTML = filtered.map(s => `
        <div class="skill-card">
            <div>
                <div class="skill-card-top">
                    <div class="skill-icon-box ${s.iconColor}">
                        <i class="fa-solid ${s.icon}"></i>
                    </div>
                    <span class="skill-category-pill">${s.category}</span>
                </div>
                <h4>${s.name}</h4>
                <p>${s.desc}</p>
            </div>
            <div class="skill-card-footer">
                <span class="skill-status-tag"><i class="fa-solid fa-circle-check"></i> Active in Agent</span>
                <button class="skill-inspect-btn" onclick="openSkillModal('${s.id}')">
                    Inspect <i class="fa-solid fa-arrow-right"></i>
                </button>
            </div>
        </div>
    `).join("");
}

export function renderStrategies(): void {
    const grid = getElement("strategies-grid");
    if (!grid) return;

    grid.innerHTML = STRATEGIES_DATA.map(st => `
        <div class="strategy-card">
            <div class="strat-header">
                <span class="strat-id">#${st.id}</span>
                <span class="strat-type-pill">${st.type}</span>
            </div>
            <h4>${st.name}</h4>
            <div class="strat-formula-box">${st.formula}</div>
            <p class="strat-desc">${st.desc}</p>
            <div class="strat-trigger">${st.trigger}</div>
        </div>
    `).join("");
}

export function filterSkills(category: string, buttonEl?: HTMLElement): void {
    document.querySelectorAll(".skill-tab").forEach(b => b.classList.remove("active"));
    if (buttonEl) buttonEl.classList.add("active");
    renderSkills(category);
}

export function openSkillModal(skillId: string): void {
    const skill = ULTIMATE_SKILLS_DATA.find(s => s.id === skillId);
    if (!skill) return;

    const modal = getElement("skill-detail-modal");
    const tagEl = getElement("modal-skill-tag");
    const titleEl = getElement("modal-skill-title");
    const descEl = getElement("modal-skill-desc");
    const rulesEl = getElement("modal-skill-rules");

    if (tagEl) tagEl.textContent = skill.category.toUpperCase();
    if (titleEl) titleEl.textContent = skill.name;
    if (descEl) descEl.textContent = skill.desc;
    if (rulesEl) rulesEl.textContent = skill.rules.replace(/\\n/g, "\n");

    if (modal) modal.classList.remove("hidden");
}

export function closeSkillModal(): void {
    const modal = getElement("skill-detail-modal");
    if (modal) modal.classList.add("hidden");
}

export function triggerAiSimulationDemo(): void {
    const modal = getElement("ai-simulation-modal");
    if (modal) modal.classList.remove("hidden");

    for (let i = 1; i <= 6; i++) {
        const stepEl = getElement(`sim-step-${i}`);
        if (stepEl) {
            stepEl.style.opacity = "0.2";
            setTimeout(() => {
                stepEl.style.opacity = "1";
                stepEl.style.transform = "translateX(4px)";
                setTimeout(() => {
                    stepEl.style.transform = "translateX(0)";
                }, 200);
            }, i * 350);
        }
    }
}

export function closeSimModal(): void {
    const modal = getElement("ai-simulation-modal");
    if (modal) modal.classList.add("hidden");
}

export function drawBtcSparkline(): void {
    const canvas = getElement<HTMLCanvasElement>("btc-sparkline-canvas");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    const points = [14, 18, 16, 22, 20, 26, 24, 30, 28, 35, 32, 40, 38, 44];
    const maxVal = Math.max(...points);
    const minVal = Math.min(...points);

    ctx.clearRect(0, 0, width, height);

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "rgba(52, 211, 153, 0.3)");
    gradient.addColorStop(1, "rgba(52, 211, 153, 0.0)");

    ctx.beginPath();
    const stepX = width / (points.length - 1);

    points.forEach((val, i) => {
        const x = i * stepX;
        const normalizedY = (val - minVal) / (maxVal - minVal);
        const y = height - 6 - (normalizedY * (height - 12));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });

    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    points.forEach((val, i) => {
        const x = i * stepX;
        const normalizedY = (val - minVal) / (maxVal - minVal);
        const y = height - 6 - (normalizedY * (height - 12));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#34d399";
    ctx.lineWidth = 2.5;
    ctx.shadowColor = "#34d399";
    ctx.shadowBlur = 8;
    ctx.stroke();
}

export function initLandingShowcase(): void {
    renderSkills("all");
    renderStrategies();
    drawBtcSparkline();
}
