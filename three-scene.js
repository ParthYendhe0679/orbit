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

// --------------------------------------------------------------------
//   CURVE PROFILE: Elegant U-Bowl Trajectory
//   High on flanks, gracefully dipping deep in the center
// --------------------------------------------------------------------
// --------------------------------------------------------------------
//   CURVE PROFILE: U-Bowl Trajectory Matching User's Drawn Path & Video
//   Crests on left flank, swoops deep into clouds under headline/buttons,
//   and climbs steep into soaring bullish candles on the right.
// --------------------------------------------------------------------
function getChartBaseY(x) {
    // Left flank wave (crest around x = -22)
    const leftFlank = 6.5 * Math.exp(-Math.pow((x + 22) / 8.5, 2));
    // Right flank surge (rising high from x = 10 to 36)
    const rightFlank = 16.5 / (1.0 + Math.exp(-(x - 14) / 5.0));
    // Deep center dip that drops below center headline & buttons into clouds
    const centerDip = -7.5 * Math.exp(-Math.pow(x / 11.5, 2));

    return leftFlank + rightFlank + centerDip - 6.2;
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
    // Rich Glowing Emerald Green (Bullish) - slender & luminous
    bullishMat = new THREE.MeshStandardMaterial({
        color: 0x00c853,
        emissive: 0x00e676,
        emissiveIntensity: 0.45,
        roughness: 0.28,
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
    const ambientLight = new THREE.AmbientLight(0x0b1320, 0.45);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.35);
    dirLight.position.set(6, 28, 22);
    scene.add(dirLight);

    const rightEmeraldLight = new THREE.PointLight(0x00e676, 2.2, 50);
    rightEmeraldLight.position.set(22, 10, 6);
    scene.add(rightEmeraldLight);

    const leftEmeraldLight = new THREE.PointLight(0x00e676, 1.8, 45);
    leftEmeraldLight.position.set(-20, 6, 6);
    scene.add(leftEmeraldLight);

    const rubyLight = new THREE.PointLight(0xef4444, 1.5, 40);
    rubyLight.position.set(8, -2, 6);
    scene.add(rubyLight);
}

// --------------------------------------------------------------------
//   BUILD PARTICLES (Ambient Floating Dust Like in Video)
// --------------------------------------------------------------------
function buildParticles() {
    const particleCount = 75;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 88;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 36;
        positions[i * 3 + 2] = -4 + (Math.random() - 0.5) * 14;

        const isEmerald = Math.random() > 0.4;
        colors[i * 3] = isEmerald ? 0.0 : 0.85;
        colors[i * 3 + 1] = isEmerald ? 0.95 : 0.95;
        colors[i * 3 + 2] = isEmerald ? 0.55 : 1.0;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const pMaterial = new THREE.PointsMaterial({
        size: 0.32,
        vertexColors: true,
        transparent: true,
        opacity: 0.60,
        blending: THREE.AdditiveBlending
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

    // Real-market sequence with realistic clusters of bullish & bearish action
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
        if (i % 5 === 0) bodyH = 1.1; // Small consolidation bar

        const singleCandle = new THREE.Group();

        // 1. Candlestick 3D Box Body (slender width, tall height)
        const bodyGeom = new THREE.BoxGeometry(candleW, bodyH, candleD);
        const bodyMesh = new THREE.Mesh(bodyGeom, isBullish ? bullishMat : bearishMat);
        singleCandle.add(bodyMesh);

        // 2. Candlestick Wicks (Upper & Lower)
        const wickLen = bodyH + 2.4 + (i % 3) * 1.0;
        const wickGeom = new THREE.CylinderGeometry(0.038, 0.038, wickLen, 6);
        const wickMesh = new THREE.Mesh(wickGeom, isBullish ? wickBullMat : wickBearMat);
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
            bobSpeed: 1.1 + (i % 5) * 0.20,
            bobPhase: i * 0.55,
            bobAmp: 0.28 + (i % 4) * 0.14
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

    const delta = lastTimestamp ? Math.min((time - lastTimestamp) * 0.001, 0.1) : 0.016;
    lastTimestamp = time;

    const elapsed = time * 0.001;

    // Movement speed: steady horizontal conveyor flow
    const driftSpeed = 1.35; // Units per second
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

    // 2. Animate ambient floating dust particles (matching video)
    if (particleSystem) {
        particleSystem.rotation.y = elapsed * 0.012;
        particleSystem.position.y = Math.sin(elapsed * 0.25) * 0.35;
    }

    // 3. Subtle Parallax and Cursor Response
    if (candleGroup) {
        candleGroup.rotation.y = mouseX * 0.035;
        candleGroup.rotation.x = -mouseY * 0.02;
    }

    // 3. Smooth Camera Lerp
    const isMobile = window.innerWidth < 960;
    const targetCamX = isMobile ? 0 : (mouseX * 1.8);
    const targetCamY = isMobile ? 0.5 : (0.8 - mouseY * 0.8 - currentScroll * 8);

    camera.position.x += (targetCamX - camera.position.x) * 0.05;
    camera.position.y += (targetCamY - camera.position.y) * 0.05;

    renderer.render(scene, camera);
}

// --------------------------------------------------------------------
//   LIFECYCLE CONTROLS
// --------------------------------------------------------------------
window.addEventListener('load', () => {
    init3D();
    animate3D(0);
});

function stop3D() {
    is3DRunning = false;
    const canvas = document.getElementById('three-canvas');
    if (canvas) canvas.style.display = 'none';
}

function start3D() {
    if (!is3DRunning) {
        is3DRunning = true;
        const canvas = document.getElementById('three-canvas');
        if (canvas) canvas.style.display = 'block';
        onWindowResize();
        animate3D(0);
    }
}

window.aether3D = {
    stop: stop3D,
    start: start3D
};
