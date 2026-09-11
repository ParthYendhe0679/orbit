// ====================================================================
//   ORBIT AI - CONTINUOUSLY MOVING FULL-WIDTH 3D CANDLESTICKS
//   Deep vibrant emerald green & crimson red candles streaming
//   continuously across the entire screen behind the centered hero.
// ====================================================================

let scene, camera, renderer;
let candleGroup;
let mouseX = 0, mouseY = 0;
let currentScroll = 0;
let is3DRunning = true;
let candles = [];

const windowHalfX = window.innerWidth / 2;
const windowHalfY = window.innerHeight / 2;

// Shared Materials for maximum rendering performance (60 FPS)
let bullishMat, bearishMat, wickBullMat, wickBearMat;
let whiteGreenMat, wickWhiteGreenMat;

// --------------------------------------------------------------------
//   CURVE PROFILE: Elegant U-Bowl Trajectory
//   High on flanks, gracefully dipping deep in the center till the last text
// --------------------------------------------------------------------
// --------------------------------------------------------------------
//   CURVE PROFILE: U-Bowl Trajectory Matching User's Drawn Path & Video
//   Crests on left flank, swoops deep into clouds under headline & last text,
//   and climbs steep into soaring bullish candles on the right.
// --------------------------------------------------------------------
function getChartBaseY(x) {
    // 1. Far left start & crest wave (rises from low left to crest at x = -21 under left text)
    const leftWave = 6.2 * Math.exp(-Math.pow((x + 21) / 9.5, 2));
    
    // 2. Right flank steep ascent & high plateau (soars sharply from x = 8 to 20, plateaus at x > 20)
    const rightSurge = 18.5 / (1.0 + Math.exp(-(x - 14.0) / 3.4));
    
    // 3. Center deep valley dipping smoothly below the action buttons & last text per user drawing
    const centerDip = -7.2 * Math.exp(-Math.pow((x - 0.5) / 10.2, 2));

    // Base elevation offset: aligns center dip cleanly below buttons and above scroll prompt
    return leftWave + rightSurge + centerDip - 4.8;
}

// --------------------------------------------------------------------
//   INITIALIZATION
// --------------------------------------------------------------------
let particleSystem;

function init3D() {
    const canvas = document.getElementById('three-canvas');
    if (!canvas) return;

    // 1. Scene & Deep Cinematic Black Atmosphere
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020406);
    scene.fog = new THREE.FogExp2(0x020406, 0.009);

    // 2. Camera: Centered framing
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 1000);
    updateCameraFraming();

    // 3. WebGL Renderer with Linear Tone Mapping
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.LinearToneMapping;
    renderer.toneMappingExposure = 1.15;

    // 4. Setup Lighting (Rich Colored Atmosphere)
    setupSceneLighting();

    // 5. Initialize Materials
    initCandleMaterials();

    // 6. Build Slender High-Density Candlestick Array (Video Match)
    buildCandlesticks();

    // 7. Ambient Floating Dust Particles (Video Match)
    buildParticles();

    // 8. Event Listeners
    document.addEventListener('mousemove', onDocumentMouseMove, { passive: true });
    window.addEventListener('resize', onWindowResize, { passive: true });
    window.addEventListener('scroll', onWindowScroll, { passive: true });
}

// --------------------------------------------------------------------
//   MATERIALS: Rich Glowing Emerald & Ruby (Reference Video Style)
// --------------------------------------------------------------------
function initCandleMaterials() {
    // Radiant White-Green (Luminous Breakout / Impulse Candles)
    whiteGreenMat = new THREE.MeshStandardMaterial({
        color: 0xecfff5,           // Luminous crisp white with subtle mint tint
        emissive: 0x00ff88,        // Radiant electric neon-mint glow
        emissiveIntensity: 0.85,    // High emissive brilliance
        roughness: 0.16,
        metalness: 0.12,
        transparent: false
    });

    wickWhiteGreenMat = new THREE.MeshBasicMaterial({ color: 0x80ffd4 });

    // Rich Glowing Emerald Green (Bullish) - slender & luminous
    bullishMat = new THREE.MeshStandardMaterial({
        color: 0x00e676,
        emissive: 0x00c853,
        emissiveIntensity: 0.52,
        roughness: 0.24,
        metalness: 0.08,
        transparent: false
    });

    // Rich Glowing Crimson Ruby (Bearish) - slender & luminous
    bearishMat = new THREE.MeshStandardMaterial({
        color: 0xd50000,
        emissive: 0xff1744,
        emissiveIntensity: 0.45,
        roughness: 0.28,
        metalness: 0.08,
        transparent: false
    });

    wickBullMat = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
    wickBearMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
}

// --------------------------------------------------------------------
//   LIGHTING: Colored accents for depth and edge highlights
// --------------------------------------------------------------------
function setupSceneLighting() {
    const ambientLight = new THREE.AmbientLight(0x0b1320, 0.48);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.40);
    dirLight.position.set(6, 28, 22);
    scene.add(dirLight);

    const rightEmeraldLight = new THREE.PointLight(0x00e676, 2.4, 55);
    rightEmeraldLight.position.set(22, 10, 8);
    scene.add(rightEmeraldLight);

    const leftEmeraldLight = new THREE.PointLight(0x00e676, 2.0, 48);
    leftEmeraldLight.position.set(-20, 6, 8);
    scene.add(leftEmeraldLight);

    // Radiant white-green mint light illuminating the deep center dip beneath the buttons
    const centerWhiteGreenLight = new THREE.PointLight(0x80ffd4, 2.6, 52);
    centerWhiteGreenLight.position.set(0, -10.0, 9);
    scene.add(centerWhiteGreenLight);

    const rubyLight = new THREE.PointLight(0xef4444, 1.4, 40);
    rubyLight.position.set(8, -2, 6);
    scene.add(rubyLight);
}

// --------------------------------------------------------------------
//   PROCEDURAL SOFT GLOW PARTICLE TEXTURE
// --------------------------------------------------------------------
function createGlowParticleTexture() {
    const pCanvas = document.createElement('canvas');
    pCanvas.width = 32;
    pCanvas.height = 32;
    const ctx = pCanvas.getContext('2d');
    const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.22, 'rgba(180, 255, 220, 0.9)');
    grad.addColorStop(0.55, 'rgba(0, 230, 138, 0.32)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
    const texture = new THREE.CanvasTexture(pCanvas);
    return texture;
}

// --------------------------------------------------------------------
//   BUILD PARTICLES (Ambient Floating Micro-Dust & Star Sparks)
// --------------------------------------------------------------------
function buildParticles() {
    const particleCount = 200; // Delicate luminous micro-particles across the site
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 94;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 44;
        positions[i * 3 + 2] = -5 + (Math.random() - 0.5) * 16;

        const rand = Math.random();
        if (rand < 0.45) {
            // Radiant white-green / mint stardust
            colors[i * 3] = 0.88;
            colors[i * 3 + 1] = 1.0;
            colors[i * 3 + 2] = 0.94;
        } else if (rand < 0.82) {
            // Emerald neon green
            colors[i * 3] = 0.0;
            colors[i * 3 + 1] = 0.96;
            colors[i * 3 + 2] = 0.58;
        } else {
            // Soft ruby / rose amber glow
            colors[i * 3] = 0.98;
            colors[i * 3 + 1] = 0.32;
            colors[i * 3 + 2] = 0.42;
        }
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const pMaterial = new THREE.PointsMaterial({
        size: 0.42,
        map: createGlowParticleTexture(),
        vertexColors: true,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    particleSystem = new THREE.Points(geometry, pMaterial);
    scene.add(particleSystem);
}

// --------------------------------------------------------------------
//   BUILD FULL-WIDTH CANDLESTICKS: Slender Width, Tall Height (Video Match)
// --------------------------------------------------------------------
function buildCandlesticks() {
    candleGroup = new THREE.Group();
    candles = [];

    const totalSpan = 88;     // From x = -44 to +44
    const stepX = 0.96;       // Slender spacing for realistic financial density (~91 candles)
    const candleCount = Math.floor(totalSpan / stepX);
    const startX = -totalSpan / 2;

    // "candle side small": Slim, elegant width and depth
    const candleW = 0.56;
    const candleD = 0.46;

    // Classic financial market sequence strictly of bullish (green) & bearish (red) action
    const pattern = [
        true, true, false, true, false, false, true, true, true, false,
        true, false, true, true, false, false, false, true, true, false,
        true, true, true, false, false, true, false, true, true, true,
        true, false, false, true, true, true, false, true, false, true,
        true, true, false, false, true, true, true, true, false, true
    ];

    for (let i = 0; i < candleCount; i++) {
        const x = startX + i * stepX;
        const isBullish = pattern[i % pattern.length];

        // "big in size": Taller height variation (breakout bars, impulse waves)
        let bodyH = 2.0 + Math.abs(Math.sin(i * 0.68)) * 3.2;
        if (i % 7 === 0) bodyH = 6.4; // Tall breakout candle
        if (i % 4 === 0) bodyH = 4.5; // Momentum candle
        if (i % 5 === 0) bodyH = 1.2; // Small consolidation bar

        const singleCandle = new THREE.Group();

        // Strictly Red & Green materials
        const bodyMaterial = isBullish ? bullishMat : bearishMat;
        const wickMaterial = isBullish ? wickBullMat : wickBearMat;

        // 1. Candlestick 3D Box Body (slender width, tall height)
        const bodyGeom = new THREE.BoxGeometry(candleW, bodyH, candleD);
        const bodyMesh = new THREE.Mesh(bodyGeom, bodyMaterial);
        singleCandle.add(bodyMesh);

        // 2. Candlestick Wicks (Upper & Lower)
        const wickLen = bodyH + 2.4 + (i % 3) * 1.0;
        const wickGeom = new THREE.CylinderGeometry(0.038, 0.038, wickLen, 6);
        const wickMesh = new THREE.Mesh(wickGeom, wickMaterial);
        singleCandle.add(wickMesh);

        // Subtle organic Z-depth variation
        const z = -2.5 + Math.sin(i * 0.45) * 1.2;
        const initialY = getChartBaseY(x);

        singleCandle.position.set(x, initialY, z);
        candleGroup.add(singleCandle);

        candles.push({
            group: singleCandle,
            bodyMesh: bodyMesh,
            x: x,
            z: z,
            bodyH: bodyH,
            isBullish: isBullish,
            bobSpeed: 0.65 + (i % 5) * 0.15,
            bobPhase: i * 0.55,
            bobAmp: 0.28 + (i % 4) * 0.10
        });
    }

    scene.add(candleGroup);
}

// --------------------------------------------------------------------
//   CAMERA FRAMING (CENTERED)
// --------------------------------------------------------------------
function updateCameraFraming() {
    if (!camera) return;
    const isMobile = window.innerWidth < 960;
    if (isMobile) {
        camera.position.set(0, 0.5, 58);
        camera.lookAt(0, 0.5, 0);
    } else {
        camera.position.set(0, 0.8, 46);
        camera.lookAt(0, 0.8, 0);
    }
}

// --------------------------------------------------------------------
//   INTERACTION EVENT LISTENERS
// --------------------------------------------------------------------
function onDocumentMouseMove(event) {
    mouseX = (event.clientX - windowHalfX) / windowHalfX;
    mouseY = (event.clientY - windowHalfY) / windowHalfY;
}

function onWindowResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    updateCameraFraming();
}

function onWindowScroll() {
    const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
    if (scrollHeight > 0) {
        currentScroll = window.scrollY / scrollHeight;
    }
}

// --------------------------------------------------------------------
//   ANIMATION LOOP: CONTINUOUS HORIZONTAL DRIFT & TICK BREATHING
// --------------------------------------------------------------------
let lastTimestamp = 0;

function animate3D(time) {
    if (!is3DRunning) return;
    requestAnimationFrame(animate3D);

    if (!renderer || !scene || !camera) return;

    const delta = (lastTimestamp && time > lastTimestamp) ? Math.min((time - lastTimestamp) * 0.001, 0.05) : 0.016;
    lastTimestamp = time;

    const elapsed = time * 0.001;

    // Movement speed: calibrated slow, serene, and majestic conveyor flow per user directive
    const driftSpeed = 1.05; // Units per second (reduced for calm, gentle, slow pace)
    const minBoundX = -44;
    const maxBoundX = 44;
    const span = maxBoundX - minBoundX;

    // 1. Update every candlestick position and elevation
    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];

        // Move candle continuously leftwards
        c.x -= driftSpeed * delta;

        // Wrap around seamlessly from left to right
        if (c.x < minBoundX) {
            c.x += span;
        }

        // Dynamically compute elevation along the chart profile curve
        const baseY = getChartBaseY(c.x);

        // Real-time market tick breathing oscillation
        const bob = Math.sin(elapsed * c.bobSpeed + c.bobPhase) * c.bobAmp;

        c.group.position.x = c.x;
        c.group.position.y = baseY + bob;
    }

    // 2. Animate ambient floating luminous micro-particles (matching video)
    if (particleSystem) {
        particleSystem.rotation.y = elapsed * 0.016;
        particleSystem.rotation.x = Math.sin(elapsed * 0.18) * 0.012;
        particleSystem.position.y = Math.sin(elapsed * 0.28) * 0.45;
    }

    // 3. Subtle Parallax and Cursor Response
    if (candleGroup) {
        candleGroup.rotation.y = mouseX * 0.035;
        candleGroup.rotation.x = -mouseY * 0.02;
    }

    // 3. Smooth Camera Lerp (kept centered so candles flow seamlessly behind both hero and auth portal)
    const isMobile = window.innerWidth < 960;
    const targetCamX = isMobile ? 0 : (mouseX * 1.8);
    const targetCamY = isMobile ? 0.5 : (0.8 - mouseY * 0.8);

    camera.position.x += (targetCamX - camera.position.x) * 0.05;
    camera.position.y += (targetCamY - camera.position.y) * 0.05;

    renderer.render(scene, camera);
}

// --------------------------------------------------------------------
//   LIFECYCLE CONTROLS (Candlesticks only on Landing & Login/Signup)
// --------------------------------------------------------------------
function initAndStart3D() {
    if (document.body.classList.contains('in-dashboard') || window.location.hash.includes('dashboard')) {
        stop3D();
        return;
    }
    if (!scene) {
        init3D();
    }
    if (is3DRunning) {
        lastTimestamp = performance.now();
        requestAnimationFrame(animate3D);
    }
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initAndStart3D();
} else {
    window.addEventListener('load', initAndStart3D);
}

function stop3D() {
    is3DRunning = false;
    const canvas = document.getElementById('three-canvas');
    if (canvas) canvas.style.display = 'none';
}

function start3D() {
    // Only allow starting if NOT in dashboard
    if (document.body.classList.contains('in-dashboard') || window.location.hash.includes('dashboard')) {
        stop3D();
        return;
    }
    const canvas = document.getElementById('three-canvas');
    if (canvas) canvas.style.display = 'block';
    if (!scene) {
        init3D();
    }
    if (!is3DRunning) {
        is3DRunning = true;
        onWindowResize();
        lastTimestamp = performance.now();
        requestAnimationFrame(animate3D);
    }
}

window.aether3D = {
    stop: stop3D,
    start: start3D
};
