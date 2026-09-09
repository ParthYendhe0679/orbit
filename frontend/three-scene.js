// ====================================================================
//   ORBIT AI - MINIMALIST 3D ASCENDING CANDLESTICK CHART SCENE
//   Large, prominent 3D candlesticks elevated higher up into the
//   optical center with deep dark forest green and crimson red colors.
// ====================================================================

let scene, camera, renderer;
let candleGroup, trendlineMesh, volumeGroup;
let dustSystem;
let mouseX = 0, mouseY = 0;
let currentScroll = 0;

// Candle data array for real-time physics & bobbing
let candlesData = [];

// Floating price badges
let floatingBadges = [];

const windowHalfX = window.innerWidth / 2;
const windowHalfY = window.innerHeight / 2;
let is3DRunning = true;

// --------------------------------------------------------------------
//   INITIALIZATION
// --------------------------------------------------------------------
function init3D() {
    const canvas = document.getElementById('three-canvas');
    if (!canvas) return;

    // 1. Scene & Atmosphere (Pure Pitch Black)
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020306);
    scene.fog = new THREE.FogExp2(0x020306, 0.008);

    // 2. Camera: Positioned to frame the large, elevated chart cleanly
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 1000);
    updateCameraFraming();

    // 3. WebGL Renderer with Linear Tone Mapping for Accurate, Rich Dark Colors
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.LinearToneMapping;
    renderer.toneMappingExposure = 1.12;

    // 4. Subtle Floating Star / Market Dust
    createMarketDust();

    // 5. Sweeping Ascending 3D Candlestick Chart (Large, Elevated Higher Up)
    createSweepingAscendingChart();

    // 6. Balanced Lighting (Deep Saturated Colors)
    setupSceneLighting();

    // 7. Event Listeners
    document.addEventListener('mousemove', onDocumentMouseMove);
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('scroll', onWindowScroll);
}

// --------------------------------------------------------------------
//   CAMERA FRAMING (RESPONSIVE)
// --------------------------------------------------------------------
function updateCameraFraming() {
    if (!camera) return;
    const isMobile = window.innerWidth < 960;
    if (isMobile) {
        camera.position.set(6, 6, 62);
        camera.lookAt(6, 5.5, 0);
    } else {
        // Positioned to frame the text on left and large elevated ascending chart on right
        camera.position.set(13, 6.8, 46);
        camera.lookAt(13, 6.2, 0);
    }
}

// --------------------------------------------------------------------
//   BALANCED SCENE LIGHTING
// --------------------------------------------------------------------
function setupSceneLighting() {
    // Brighter ambient light for clear, vibrant visibility of candles
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.72);
    scene.add(ambientLight);

    // Directional light from top-left for crisp 3D form definition
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.95);
    dirLight.position.set(12, 28, 22);
    scene.add(dirLight);

    // Soft cyan rim light from lower left for subtle depth
    const leftFill = new THREE.DirectionalLight(0x38bdf8, 0.35);
    leftFill.position.set(-18, 12, 16);
    scene.add(leftFill);
}

// --------------------------------------------------------------------
//   SWEEPING ASCENDING 3D CANDLESTICK CHART (BIG & ELEVATED)
// --------------------------------------------------------------------
function createSweepingAscendingChart() {
    candleGroup = new THREE.Group();
    candlesData = [];

    // Elevated path profiles: Raised further (+1.8 units) so the chart sits prominently higher up
    const pathProfiles = [
        -1.7, -2.4, -1.8, -1.2, -1.9, -0.6,  0.2, -0.2,  1.0,  2.0,
         1.4,  3.0,  4.0,  3.5,  5.0,  6.6,  5.9,  7.6,  9.0,  8.3,
        10.0, 11.6, 10.8, 12.7, 14.4, 16.0, 15.3, 17.2, 18.8, 20.6
    ];

    const candleCount = pathProfiles.length;
    const startX = 2.0;    // Starts cleanly just past the center, covering right half
    const stepX = 1.75;    // Generous horizontal spacing between candle centers
    const candleW = 1.35;  // Bigger candle width (noticeable presence)
    const candleD = 1.25;  // Substantial 3D depth

    const curvePoints = [];

    // SOLID, BRIGHT RICH EMERALD GREEN (BULLISH)
    const bullishMat = new THREE.MeshStandardMaterial({
        color: 0x16a34a, // Vibrant rich emerald green
        emissive: 0x052e16,
        emissiveIntensity: 0.32,
        roughness: 0.65,
        metalness: 0.08,
        transparent: false
    });

    // SOLID, BRIGHT RICH CRIMSON RED (BEARISH)
    const bearishMat = new THREE.MeshStandardMaterial({
        color: 0xdc2626, // Vibrant rich crimson red
        emissive: 0x450a0a,
        emissiveIntensity: 0.32,
        roughness: 0.65,
        metalness: 0.08,
        transparent: false
    });

    const wickBullMat = new THREE.MeshBasicMaterial({ color: 0x22c55e });
    const wickBearMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });

    volumeGroup = new THREE.Group();

    for (let i = 0; i < candleCount; i++) {
        const x = startX + i * stepX;
        const currentClose = pathProfiles[i];
        const prevClose = i > 0 ? pathProfiles[i - 1] : currentClose - 0.6;
        const isBullish = currentClose >= prevClose;

        // Larger, more prominent body height
        let bodyH = Math.min(Math.max(Math.abs(currentClose - prevClose) * 2.0, 1.4), 4.5);
        if (i === 14 || i === 23) bodyH = 4.8; // Breakout big candle
        if (i === 4 || i === 10 || i === 19) bodyH = 0.65; // Clean Doji

        const singleCandle = new THREE.Group();

        // 1. Candlestick 3D Box Body (Bigger)
        const bodyGeom = new THREE.BoxGeometry(candleW, bodyH, candleD);
        const bodyMesh = new THREE.Mesh(bodyGeom, isBullish ? bullishMat : bearishMat);
        singleCandle.add(bodyMesh);

        // 2. Candlestick Wicks (Thicker & Taller)
        const wickExtra = 1.4 + (i % 3) * 0.6;
        const totalWickLen = bodyH + wickExtra * 2;
        const wickGeom = new THREE.CylinderGeometry(0.08, 0.08, totalWickLen, 8);
        const wickMesh = new THREE.Mesh(wickGeom, isBullish ? wickBullMat : wickBearMat);
        singleCandle.add(wickMesh);

        // 3. Gentle Z depth for 3D realism
        const z = -2.0 + Math.sin(i * 0.35) * 1.1;
        singleCandle.position.set(x, currentClose, z);

        candleGroup.add(singleCandle);

        // Trendline curve point
        curvePoints.push(new THREE.Vector3(x, currentClose, z + 0.7));

        // 4. Baseline Volume Microbars (Elevated cleanly above bottom margin)
        const volH = 1.0 + Math.abs(currentClose - prevClose) * 1.5 + (i % 3) * 0.5;
        const volGeom = new THREE.BoxGeometry(candleW * 0.85, volH, candleD * 0.85);
        const volMat = new THREE.MeshBasicMaterial({
            color: isBullish ? 0x16a34a : 0xdc2626,
            transparent: true,
            opacity: 0.65
        });
        const volMesh = new THREE.Mesh(volGeom, volMat);
        volMesh.position.set(x, -6.5 + volH / 2, z);
        volumeGroup.add(volMesh);

        candlesData.push({
            group: singleCandle,
            bodyMesh: bodyMesh,
            baseY: currentClose,
            speed: 0.65 + (i % 4) * 0.18,
            phase: i * 0.45,
            amplitude: 0.45 + (i % 3) * 0.22
        });
    }

    candleGroup.add(volumeGroup);

    // 5. Flowing Moving Average Trendline Ribbon (Bolder)
    if (curvePoints.length > 2) {
        const curve = new THREE.CatmullRomCurve3(curvePoints);
        const tubeGeom = new THREE.TubeGeometry(curve, 90, 0.18, 8, false);
        const tubeMat = new THREE.MeshStandardMaterial({
            color: 0x0284c7, // Muted deep cyan ribbon
            emissive: 0x0369a1,
            emissiveIntensity: 0.65,
            roughness: 0.35,
            metalness: 0.1
        });
        trendlineMesh = new THREE.Mesh(tubeGeom, tubeMat);
        candleGroup.add(trendlineMesh);

        // Pulse Peak Indicator Point at the top-right apex
        const lastPt = curvePoints[curvePoints.length - 1];
        const peakGeom = new THREE.SphereGeometry(0.75, 16, 16);
        const peakMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
        const peakMesh = new THREE.Mesh(peakGeom, peakMat);
        peakMesh.position.copy(lastPt);
        candleGroup.add(peakMesh);
    }

    // 6. Floating Order Badges (Bigger & Positioned Cleanly)
    createFloatingChartBadges(curvePoints);

    scene.add(candleGroup);
}

// Cleanly Positioned Floating Badges (Larger Scale)
function createFloatingChartBadges(curvePoints) {
    if (!curvePoints || curvePoints.length < 3) return;

    // 1. Apex Price Badge (Floats cleanly next to the final peak, inside viewport)
    const lastPt = curvePoints[curvePoints.length - 1];
    const priceBadge = createBadgeSprite('BTC/USD', '$68,415.70', '#076e3b', '#ffffff');
    priceBadge.position.set(lastPt.x - 4.2, lastPt.y + 1.0, 2.5);
    candleGroup.add(priceBadge);
    floatingBadges.push({ sprite: priceBadge, baseY: lastPt.y + 1.0, speed: 0.8, phase: 0 });

    // 2. Buy Badge (Floats above mid-wave breakout)
    const midIdx = Math.floor(curvePoints.length * 0.62);
    const midPt = curvePoints[midIdx];
    const buyBadge = createBadgeSprite('BUY', '72.19', '#d97706', '#ffffff');
    buyBadge.position.set(midPt.x - 2.8, midPt.y + 3.6, 3.5);
    candleGroup.add(buyBadge);
    floatingBadges.push({ sprite: buyBadge, baseY: midPt.y + 3.6, speed: 0.85, phase: 1.6 });

    // 3. Sell Badge (Floats below lower consolidation)
    const lowIdx = Math.floor(curvePoints.length * 0.25);
    const lowPt = curvePoints[lowIdx];
    const sellBadge = createBadgeSprite('SELL', '92.18', '#0284c7', '#ffffff');
    sellBadge.position.set(lowPt.x - 1.8, lowPt.y - 3.4, 3.0);
    candleGroup.add(sellBadge);
    floatingBadges.push({ sprite: sellBadge, baseY: lowPt.y - 3.4, speed: 0.75, phase: 3.2 });
}

function createBadgeSprite(tag, price, bgColor, textColor) {
    const canvas = document.createElement('canvas');
    canvas.width = 280;
    canvas.height = 120;
    const ctx = canvas.getContext('2d');

    // Rounded Pill background
    ctx.fillStyle = bgColor;
    ctx.shadowColor = bgColor;
    ctx.shadowBlur = 12;
    roundRect(ctx, 16, 16, 248, 88, 44, true, false);
    ctx.shadowBlur = 0;

    // Inner tag text
    ctx.fillStyle = textColor;
    ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${tag} ${price}`, 140, 70);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.95 });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(6.8, 2.9, 1.0); // Bigger badge scale
    return sprite;
}

// Canvas Helper: Rounded Rectangle
function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
}

// Floating Background Pixel Dots (Tech Atmosphere matching user screenshot)
function createMarketDust() {
    const dustCount = 130;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(dustCount * 3);

    for (let i = 0; i < dustCount; i++) {
        // Spread cleanly across full screen viewport
        positions[i * 3] = (Math.random() - 0.28) * 90;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 50;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 25;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // Crisp square micro-dots (2D canvas texture for pixel-sharp squares)
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#94a3b8';
    ctx.fillRect(2, 2, 12, 12);
    const dotTex = new THREE.CanvasTexture(canvas);

    const material = new THREE.PointsMaterial({
        map: dotTex,
        color: 0xffffff,
        size: 1.15,
        transparent: true,
        opacity: 0.60,
        blending: THREE.NormalBlending,
        depthWrite: false
    });

    dustSystem = new THREE.Points(geometry, material);
    scene.add(dustSystem);
}

// --------------------------------------------------------------------
//   INTERACTIONS & EVENT HANDLERS
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
//   ANIMATION RENDER LOOP (PHYSICS & BOBBING)
// --------------------------------------------------------------------
function animate3D(time) {
    if (!is3DRunning) return;
    requestAnimationFrame(animate3D);

    if (!renderer || !scene || !camera) return;

    const elapsed = time * 0.001;

    // 1. Harmonic vertical bobbing on candlesticks
    if (candlesData.length > 0) {
        for (let i = 0; i < candlesData.length; i++) {
            const item = candlesData[i];
            item.group.position.y = item.baseY + Math.sin(elapsed * item.speed + item.phase) * item.amplitude;
        }
    }

    // 2. Floating Badges Harmonic Bobbing
    if (floatingBadges.length > 0) {
        for (let i = 0; i < floatingBadges.length; i++) {
            const b = floatingBadges[i];
            b.sprite.position.y = b.baseY + Math.sin(elapsed * b.speed + b.phase) * 0.45;
        }
    }

    // 3. Gentle Sway in response to cursor
    if (candleGroup) {
        candleGroup.rotation.y = mouseX * 0.05 + Math.sin(elapsed * 0.3) * 0.01;
        candleGroup.rotation.x = -mouseY * 0.035;
    }

    // 4. Atmospheric Dust Gentle Drift
    if (dustSystem) {
        dustSystem.rotation.y = elapsed * 0.01;
    }

    // 5. Smooth Camera Parallax Response (Lerp)
    const isMobile = window.innerWidth < 960;
    const targetCamX = isMobile ? 6 : (13 + mouseX * 1.8);
    const targetCamY = isMobile ? 6 : (6.8 - mouseY * 1.0 - currentScroll * 10);

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
