// 3D Three.js Market Grid & Massive Stock Graph Scene Controller (Solid Volatile)

let scene, camera, renderer;
let particleSystem, chartGroup, dustSystem;
let mouseX = 0, mouseY = 0;
let currentScroll = 0;
let pulsingLight;

// References for dynamic scroll-grow chart
let chartPoints = [];
let chartCandles = []; // Array of groups
let trendLine;

const windowHalfX = window.innerWidth / 2;
const windowHalfY = window.innerHeight / 2;

function init3D() {
    const canvas = document.getElementById('three-canvas');
    if (!canvas) return;

    // 1. Scene & Camera
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x06070a, 0.008); // Deep dark background with light fog

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 1000);
    camera.position.set(0, 18, 65);

    // 2. WebGL Renderer
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    // 3. Create Colorful Waving Market Grid (Floor)
    createParticleFloor();

    // 4. Create Atmospheric Market Dust (Drifting stars)
    createMarketDust();

    // 5. Create Massive Bold 3D Stock Graph
    create3DStockChart();

    // 6. Lighting - Dynamic glowing colors
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.02); // Very low ambient to make glow pop
    scene.add(ambientLight);

    pulsingLight = new THREE.PointLight(0x00ff66, 6, 80);
    pulsingLight.position.set(0, 5, 0);
    scene.add(pulsingLight);

    const cyanLight = new THREE.PointLight(0x00f0ff, 4.5, 75);
    cyanLight.position.set(-30, 12, 10);
    scene.add(cyanLight);

    const magentaLight = new THREE.PointLight(0xff3344, 4.5, 75); // Bold Red PointLight
    magentaLight.position.set(30, 12, 10);
    scene.add(magentaLight);

    // 7. Event Listeners
    document.addEventListener('mousemove', onDocumentMouseMove);
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('scroll', onWindowScroll);
}

// -------------------------------------------------------------
//   VOLUMETRIC NEON TUBE GENERATOR
// -------------------------------------------------------------
function createNeonTube(p1, p2, radius, colorHex) {
    const direction = new THREE.Vector3().subVectors(p2, p1);
    const length = direction.length();
    
    const geom = new THREE.CylinderGeometry(radius, radius, length, 6);
    geom.translate(0, length / 2, 0);
    geom.rotateX(Math.PI / 2);
    
    const mat = new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: false,
        opacity: 1.0
    });
    
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(p1);
    mesh.lookAt(p2);
    return mesh;
}

// -------------------------------------------------------------
//   SCENE BUILDERS
// -------------------------------------------------------------

function createParticleFloor() {
    const particleCount = 2000;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);

    const cols = 50;
    const rows = 40;
    const spacingX = 4.2;
    const spacingZ = 4.2;
    
    let index = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const x = (c - cols / 2) * spacingX;
            const z = (r - rows / 2) * spacingZ;
            const y = -14; // Kept lower so it doesn't overlap the big chart

            positions[index] = x;
            positions[index + 1] = y;
            positions[index + 2] = z;

            const color = new THREE.Color();
            const ratio = c / cols;
            // Bold saturated color mapping (Vibrant green -> deep blue -> red)
            if (ratio < 0.3) {
                color.setHSL(0.35 + ratio * 0.1, 0.95, 0.45);
            } else if (ratio < 0.7) {
                color.setHSL(0.55 + (ratio - 0.3) * 0.1, 0.95, 0.45);
            } else {
                color.setHSL(0.98 + (ratio - 0.7) * 0.05, 0.95, 0.45); // Pure red hues
            }
            colors[index] = color.r;
            colors[index + 1] = color.g;
            colors[index + 2] = color.b;

            index += 3;
        }
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        size: 0.55,
        vertexColors: true,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true
    });

    particleSystem = new THREE.Points(geometry, material);
    scene.add(particleSystem);
}

function createMarketDust() {
    const dustCount = 350;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(dustCount * 3);
    const colors = new Float32Array(dustCount * 3);

    for (let i = 0; i < dustCount; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 160;
        positions[i * 3 + 1] = Math.random() * 60 - 15;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 130;

        const color = new THREE.Color(Math.random() > 0.5 ? 0x00ff66 : 0xff3344); // Standard Red and Green
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        size: 0.4,
        vertexColors: true,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending
    });

    dustSystem = new THREE.Points(geometry, material);
    scene.add(dustSystem);
}

function create3DStockChart() {
    chartGroup = new THREE.Group();
    chartPoints = [];
    chartCandles = [];
    
    // Glowing Grid base mesh underneath the entire chart
    const gridHelper = new THREE.GridHelper(100, 24, 0x00f0ff, 0x1d2130);
    gridHelper.position.y = -10;
    gridHelper.material.opacity = 0.35;
    gridHelper.material.transparent = true;
    chartGroup.add(gridHelper);

    const candleCount = 24;
    
    // Generate Stock Coordinates: first going up, then pullback (going down), then breakout rally!
    for (let i = 0; i < candleCount; i++) {
        const x = (i - candleCount / 2) * 4.5; // Wider spacing (4.5) to span the whole screen width
        
        let y = -2;
        if (i < 6) {
            y = Math.sin(i * 0.8) * 3 - 2; // Wave 1: Going UP (first 5-6 candles)
        } else if (i < 13) {
            y = Math.cos((i - 6) * 0.6) * 3 - 3.5; // Wave 2: Pullback DOWN (candles 6 to 12)
        } else {
            y = Math.pow((i - 13) / 2.8, 1.9) - 3.2 + Math.sin(i * 1.5) * 1.5; // Wave 3: Breakout RALLY (candles 13+)
        }
        const z = Math.sin(i * 0.4) * 4;
        
        chartPoints.push(new THREE.Vector3(x, y, z));
        
        // Dynamic candle group
        const singleCandleGroup = new THREE.Group();
        singleCandleGroup.position.set(x, 0, z); // Center position locally
        
        // Alternating proper standard red and green candle colors
        const isGreen = i % 3 !== 2; 
        const candleColor = isGreen ? 0x00ff66 : 0xff3344; // Proper Vivid Emerald Green & Crimson Red
        
        // BOLDER SIZES: High variation height (some tiny Dojis, some giant Breakouts!)
        let candleHeight = 2.5;
        if (i % 6 === 0) {
            candleHeight = 8.5 + Math.random() * 4.0; // Giant Breakout Candle (Big)
        } else if (i % 6 === 3) {
            candleHeight = 0.5 + Math.random() * 0.7; // Tiny Doji Candle (Small)
        } else {
            candleHeight = 2.0 + Math.random() * 3.5; // Medium Candle
        }
        
        // 1. 3D SOLID Candle Core (Opaque Solid Fill)
        const boxGeom = new THREE.BoxGeometry(2.0, candleHeight, 2.0); // Bolder width (2.0)
        const boxMat = new THREE.MeshBasicMaterial({
            color: candleColor,
            transparent: false,
            opacity: 1.0, // Full solid opacity on load
        });
        const candleMesh = new THREE.Mesh(boxGeom, boxMat);
        candleMesh.position.set(0, y, 0); // Position relative to local group center
        singleCandleGroup.add(candleMesh);
        
        // 2. Thick volumetric Edges (Neon Rods) for that ultra-crisp bold look
        const halfH = candleHeight / 2;
        const halfW = 1.0; // Matches geometry width
        
        // Draw the 12 edges of the box as volumetric neon cylinders!
        const corners = [
            [-halfW, -halfH, -halfW], [halfW, -halfH, -halfW],
            [halfW, -halfH, halfW], [-halfW, -halfH, halfW],
            [-halfW, halfH, -halfW], [halfW, halfH, -halfW],
            [halfW, halfH, halfW], [-halfW, halfH, halfW]
        ];
        
        const edgePairs = [
            [0, 1], [1, 2], [2, 3], [3, 0], // Bottom
            [4, 5], [5, 6], [6, 7], [7, 4], // Top
            [0, 4], [1, 5], [2, 6], [3, 7]  // Connectors
        ];
        
        edgePairs.forEach(pair => {
            const c1 = new THREE.Vector3(...corners[pair[0]]).add(new THREE.Vector3(0, y, 0));
            const c2 = new THREE.Vector3(...corners[pair[1]]).add(new THREE.Vector3(0, y, 0));
            const edgeTube = createNeonTube(c1, c2, 0.08, candleColor);
            singleCandleGroup.add(edgeTube);
        });
        
        // 3. Thick Wicks (Cylinders)
        const topWickMesh = createNeonTube(
            new THREE.Vector3(0, y + candleHeight/2, 0),
            new THREE.Vector3(0, y + candleHeight/2 + 2.2, 0),
            0.08,
            candleColor
        );
        const botWickMesh = createNeonTube(
            new THREE.Vector3(0, y - candleHeight/2, 0),
            new THREE.Vector3(0, y - candleHeight/2 - 2.2, 0),
            0.08,
            candleColor
        );
        singleCandleGroup.add(topWickMesh);
        singleCandleGroup.add(botWickMesh);

        // Hide initially (scale Y to near 0)
        singleCandleGroup.scale.y = 0.0001;
        singleCandleGroup.visible = false;
        
        chartGroup.add(singleCandleGroup);
        chartCandles.push(singleCandleGroup);
    }
    
    // Initialize Trendline with the first 5 coordinates
    const trendMat = new THREE.LineBasicMaterial({
        color: 0x00f0ff,
        linewidth: 4,
        transparent: false,
        opacity: 1.0
    });
    
    trendLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(chartPoints.slice(0, 5)), 
        trendMat
    );
    chartGroup.add(trendLine);
    
    // Scale up to span the whole screen width
    chartGroup.scale.set(1.4, 1.4, 1.4);
    chartGroup.position.set(0, 0, -8);
    scene.add(chartGroup);
}

// -------------------------------------------------------------
//   INTERACTIONS & RENDER LOOP
// -------------------------------------------------------------

function onDocumentMouseMove(event) {
    mouseX = (event.clientX - windowHalfX) / 100;
    mouseY = (event.clientY - windowHalfY) / 100;
}

function onWindowResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function onWindowScroll() {
    const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
    if (scrollHeight > 0) {
        currentScroll = window.scrollY / scrollHeight;
    }
}

let is3DRunning = true;

function animate3D(time) {
    if (!is3DRunning) return;
    requestAnimationFrame(animate3D);

    if (!renderer || !scene) return;

    const elapsed = time * 0.001;

    // 1. Volatile waves on the floor grid
    if (particleSystem) {
        const positions = particleSystem.geometry.attributes.position.array;
        let index = 0;
        const cols = 50;
        const rows = 40;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const primaryWave = Math.sin(c * 0.15 + elapsed * 1.5) * Math.cos(r * 0.15 + elapsed * 1.5) * 3.5;
                const secondaryWave = Math.sin((c + r) * 0.08 + elapsed * 0.7) * 1.8;
                
                positions[index + 1] = primaryWave + secondaryWave - 14;
                index += 3;
            }
        }
        particleSystem.geometry.attributes.position.needsUpdate = true;
    }

    // 2. Slow rotation / floating of atmospheric Market Dust
    if (dustSystem) {
        dustSystem.rotation.y = elapsed * 0.025;
        dustSystem.rotation.x = Math.sin(elapsed * 0.04) * 0.04;
    }

    // 3. Scroll-Revealed Candles & Smooth Growing Trendline
    const candleCount = 24;
    const visibleFraction = 5.0 + currentScroll * (candleCount - 5);
    const intPart = Math.floor(visibleFraction);
    const fracPart = visibleFraction - intPart;
    
    // Set candle group visibilities and growth scales
    for (let i = 0; i < candleCount; i++) {
        const group = chartCandles[i];
        if (i < intPart) {
            group.visible = true;
            group.scale.y += (1.0 - group.scale.y) * 0.15;
        } 
        else if (i === intPart) {
            group.visible = true;
            const targetScale = Math.max(0.0001, fracPart);
            group.scale.y += (targetScale - group.scale.y) * 0.15;
        } 
        else {
            group.visible = false;
            group.scale.y = 0.0001;
        }
    }

    // Update dynamic growing trendline connecting active points
    if (trendLine) {
        let activePoints = chartPoints.slice(0, intPart);
        
        // Interpolate the next point segment smoothly along the path
        if (intPart < candleCount && fracPart > 0) {
            const lastPoint = chartPoints[intPart - 1];
            const nextPoint = chartPoints[intPart];
            const interpolatedPoint = new THREE.Vector3().lerpVectors(lastPoint, nextPoint, fracPart);
            activePoints.push(interpolatedPoint);
        }
        
        // Rebuild trendline geometry
        trendLine.geometry.dispose();
        trendLine.geometry = new THREE.BufferGeometry().setFromPoints(activePoints);
    }

    // 4. Parallax rotation of the central chart group
    if (chartGroup) {
        chartGroup.rotation.y = -0.05 + Math.cos(elapsed * 0.12) * 0.06;
        chartGroup.position.y = Math.sin(elapsed * 0.35) * 0.5;
    }

    // 5. Pulsing lighting logic
    if (pulsingLight) {
        pulsingLight.intensity = 4.5 + Math.sin(elapsed * 3.5) * 2.0;
        pulsingLight.position.y = 5 + Math.sin(elapsed) * 3.0;
    }

    // 6. Camera Coordinates path based on Scroll position
    // Scroll goes 0.0 (top) to 1.0 (bottom)
    const targetZ = 65 - (currentScroll * 40); // Zoom closer
    const targetY = 18 - (currentScroll * 15);  // Pan down
    const targetX = (currentScroll * 15);       // Center camera behind login card at bottom
    
    const targetRotationY = mouseX * 0.12 + (currentScroll * 0.20); 
    const targetRotationX = -mouseY * 0.08 - (currentScroll * 0.30);

    // Interpolate (Lerp)
    camera.position.x += (targetX - camera.position.x) * 0.05;
    camera.position.y += (targetY - camera.position.y) * 0.05;
    camera.position.z += (targetZ - camera.position.z) * 0.05;

    camera.rotation.y += (targetRotationY - camera.rotation.y) * 0.05;
    camera.rotation.x += (targetRotationX - camera.rotation.x) * 0.05;

    renderer.render(scene, camera);
}

// Auto-run when the script loads
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
