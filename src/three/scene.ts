/**
 * ORBIT Trading Terminal — Three.js 3D Candlestick Background Scene
 * Features U-bowl streaming candlestick trajectory, procedural stardust, and dashboard visibility lifecycle
 */

import { getElement } from "../utils/dom";

export interface CandlestickItem {
    group: any;
    bodyMesh: any;
    x: number;
    z: number;
    bodyH: number;
    isBullish: boolean;
    bobSpeed: number;
    bobPhase: number;
    bobAmp: number;
}

export class ThreeSceneController {
    private scene: any = null;
    private camera: any = null;
    private renderer: any = null;
    private candleGroup: any = null;
    private particleSystem: any = null;

    private mouseX = 0;
    private mouseY = 0;
    private is3DRunning = false;
    private candles: CandlestickItem[] = [];
    private lastTimestamp = 0;

    private bullishMat: any = null;
    private bearishMat: any = null;
    private wickBullMat: any = null;
    private wickBearMat: any = null;

    private windowHalfX = window.innerWidth / 2;
    private windowHalfY = window.innerHeight / 2;

    constructor() {
        this.onDocumentMouseMove = this.onDocumentMouseMove.bind(this);
        this.onWindowResize = this.onWindowResize.bind(this);
        this.animate3D = this.animate3D.bind(this);
    }

    public getChartBaseY(x: number): number {
        // 1. Far left start & crest wave
        const leftWave = 6.2 * Math.exp(-Math.pow((x + 21) / 9.5, 2));
        // 2. Right flank steep ascent & high plateau
        const rightSurge = 18.5 / (1.0 + Math.exp(-(x - 14.0) / 3.4));
        // 3. Center deep valley dipping smoothly below the action buttons
        const centerDip = -7.2 * Math.exp(-Math.pow((x - 0.5) / 10.2, 2));

        return leftWave + rightSurge + centerDip - 4.8;
    }

    public init(): void {
        const canvas = getElement<HTMLCanvasElement>("three-canvas");
        if (!canvas) return;

        const THREE = (window as any).THREE;
        if (!THREE) {
            console.warn("[ThreeScene] Three.js not loaded from CDN.");
            return;
        }

        // 1. Scene & Deep Cinematic Black Atmosphere
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x020406);
        this.scene.fog = new THREE.FogExp2(0x020406, 0.009);

        // 2. Camera
        this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 1000);
        this.updateCameraFraming();

        // 3. WebGL Renderer
        this.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.toneMapping = THREE.LinearToneMapping;
        this.renderer.toneMappingExposure = 1.15;

        // 4. Setup Lighting
        this.setupSceneLighting();

        // 5. Materials
        this.initCandleMaterials();

        // 6. Candlesticks
        this.buildCandlesticks();

        // 7. Floating particles
        this.buildParticles();

        // 8. Event listeners
        document.addEventListener("mousemove", this.onDocumentMouseMove, { passive: true });
        window.addEventListener("resize", this.onWindowResize, { passive: true });
    }

    private initCandleMaterials(): void {
        const THREE = (window as any).THREE;
        this.bullishMat = new THREE.MeshStandardMaterial({
            color: 0x00e676,
            emissive: 0x00c853,
            emissiveIntensity: 0.52,
            roughness: 0.24,
            metalness: 0.08,
            transparent: false
        });

        this.bearishMat = new THREE.MeshStandardMaterial({
            color: 0xd50000,
            emissive: 0xff1744,
            emissiveIntensity: 0.45,
            roughness: 0.28,
            metalness: 0.08,
            transparent: false
        });

        this.wickBullMat = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
        this.wickBearMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
    }

    private setupSceneLighting(): void {
        const THREE = (window as any).THREE;
        const ambientLight = new THREE.AmbientLight(0x0b1320, 0.48);
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 0.4);
        dirLight.position.set(6, 28, 22);
        this.scene.add(dirLight);

        const rightEmeraldLight = new THREE.PointLight(0x00e676, 2.4, 55);
        rightEmeraldLight.position.set(22, 10, 8);
        this.scene.add(rightEmeraldLight);

        const leftEmeraldLight = new THREE.PointLight(0x00e676, 2.0, 48);
        leftEmeraldLight.position.set(-20, 6, 8);
        this.scene.add(leftEmeraldLight);

        const centerWhiteGreenLight = new THREE.PointLight(0x80ffd4, 2.6, 52);
        centerWhiteGreenLight.position.set(0, -10.0, 9);
        this.scene.add(centerWhiteGreenLight);

        const rubyLight = new THREE.PointLight(0xef4444, 1.4, 40);
        rubyLight.position.set(8, -2, 6);
        this.scene.add(rubyLight);
    }

    private createGlowParticleTexture(): any {
        const THREE = (window as any).THREE;
        const pCanvas = document.createElement("canvas");
        pCanvas.width = 32;
        pCanvas.height = 32;
        const ctx = pCanvas.getContext("2d");
        if (!ctx) return null;

        const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
        grad.addColorStop(0, "rgba(255, 255, 255, 1)");
        grad.addColorStop(0.22, "rgba(180, 255, 220, 0.9)");
        grad.addColorStop(0.55, "rgba(0, 230, 138, 0.32)");
        grad.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 32, 32);
        return new THREE.CanvasTexture(pCanvas);
    }

    private buildParticles(): void {
        const THREE = (window as any).THREE;
        const particleCount = 200;
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(particleCount * 3);
        const colors = new Float32Array(particleCount * 3);

        for (let i = 0; i < particleCount; i++) {
            positions[i * 3] = (Math.random() - 0.5) * 94;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 44;
            positions[i * 3 + 2] = -5 + (Math.random() - 0.5) * 16;

            const rand = Math.random();
            if (rand < 0.45) {
                colors[i * 3] = 0.88;
                colors[i * 3 + 1] = 1.0;
                colors[i * 3 + 2] = 0.94;
            } else if (rand < 0.82) {
                colors[i * 3] = 0.0;
                colors[i * 3 + 1] = 0.96;
                colors[i * 3 + 2] = 0.58;
            } else {
                colors[i * 3] = 0.98;
                colors[i * 3 + 1] = 0.32;
                colors[i * 3 + 2] = 0.42;
            }
        }

        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

        const pMaterial = new THREE.PointsMaterial({
            size: 0.42,
            map: this.createGlowParticleTexture(),
            vertexColors: true,
            transparent: true,
            opacity: 0.72,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });

        this.particleSystem = new THREE.Points(geometry, pMaterial);
        this.scene.add(this.particleSystem);
    }

    private buildCandlesticks(): void {
        const THREE = (window as any).THREE;
        this.candleGroup = new THREE.Group();
        this.candles = [];

        const totalSpan = 88;
        const stepX = 0.96;
        const candleCount = Math.floor(totalSpan / stepX);
        const startX = -totalSpan / 2;
        const candleW = 0.56;
        const candleD = 0.46;

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

            let bodyH = 2.0 + Math.abs(Math.sin(i * 0.68)) * 3.2;
            if (i % 7 === 0) bodyH = 6.4;
            if (i % 4 === 0) bodyH = 4.5;
            if (i % 5 === 0) bodyH = 1.2;

            const singleCandle = new THREE.Group();
            const bodyMaterial = isBullish ? this.bullishMat : this.bearishMat;
            const wickMaterial = isBullish ? this.wickBullMat : this.wickBearMat;

            const bodyGeom = new THREE.BoxGeometry(candleW, bodyH, candleD);
            const bodyMesh = new THREE.Mesh(bodyGeom, bodyMaterial);
            singleCandle.add(bodyMesh);

            const wickLen = bodyH + 2.4 + (i % 3) * 1.0;
            const wickGeom = new THREE.CylinderGeometry(0.038, 0.038, wickLen, 6);
            const wickMesh = new THREE.Mesh(wickGeom, wickMaterial);
            singleCandle.add(wickMesh);

            const z = -2.5 + Math.sin(i * 0.45) * 1.2;
            const initialY = this.getChartBaseY(x);

            singleCandle.position.set(x, initialY, z);
            this.candleGroup.add(singleCandle);

            this.candles.push({
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

        this.scene.add(this.candleGroup);
    }

    private updateCameraFraming(): void {
        if (!this.camera) return;
        const isMobile = window.innerWidth < 960;
        if (isMobile) {
            this.camera.position.set(0, 0.5, 58);
            this.camera.lookAt(0, 0.5, 0);
        } else {
            this.camera.position.set(0, 0.8, 46);
            this.camera.lookAt(0, 0.8, 0);
        }
    }

    private onDocumentMouseMove(event: MouseEvent): void {
        this.mouseX = (event.clientX - this.windowHalfX) / this.windowHalfX;
        this.mouseY = (event.clientY - this.windowHalfY) / this.windowHalfY;
    }

    private onWindowResize(): void {
        if (!this.camera || !this.renderer) return;
        this.windowHalfX = window.innerWidth / 2;
        this.windowHalfY = window.innerHeight / 2;
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.updateCameraFraming();
    }

    public animate3D(time: number): void {
        if (!this.is3DRunning) return;
        requestAnimationFrame(this.animate3D);

        if (!this.renderer || !this.scene || !this.camera) return;

        const delta =
            this.lastTimestamp && time > this.lastTimestamp
                ? Math.min((time - this.lastTimestamp) * 0.001, 0.05)
                : 0.016;
        this.lastTimestamp = time;

        const elapsed = time * 0.001;
        const driftSpeed = 1.05;
        const minBoundX = -44;
        const maxBoundX = 44;
        const span = maxBoundX - minBoundX;

        // 1. Update candlestick positions
        for (let i = 0; i < this.candles.length; i++) {
            const c = this.candles[i];
            c.x -= driftSpeed * delta;
            if (c.x < minBoundX) c.x += span;

            const baseY = this.getChartBaseY(c.x);
            const bob = Math.sin(elapsed * c.bobSpeed + c.bobPhase) * c.bobAmp;

            c.group.position.x = c.x;
            c.group.position.y = baseY + bob;
        }

        // 2. Animate ambient particles
        if (this.particleSystem) {
            this.particleSystem.rotation.y = elapsed * 0.016;
            this.particleSystem.rotation.x = Math.sin(elapsed * 0.18) * 0.012;
            this.particleSystem.position.y = Math.sin(elapsed * 0.28) * 0.45;
        }

        // 3. Parallax
        if (this.candleGroup) {
            this.candleGroup.rotation.y = this.mouseX * 0.035;
            this.candleGroup.rotation.x = -this.mouseY * 0.02;
        }

        const isMobile = window.innerWidth < 960;
        const targetCamX = isMobile ? 0 : this.mouseX * 1.8;
        const targetCamY = isMobile ? 0.5 : 0.8 - this.mouseY * 0.8;

        this.camera.position.x += (targetCamX - this.camera.position.x) * 0.05;
        this.camera.position.y += (targetCamY - this.camera.position.y) * 0.05;

        this.renderer.render(this.scene, this.camera);
    }

    public start(): void {
        if (document.body.classList.contains("in-dashboard") || window.location.hash.includes("dashboard")) {
            this.stop();
            return;
        }
        const canvas = getElement<HTMLCanvasElement>("three-canvas");
        if (canvas) canvas.style.display = "block";

        const THREE = (window as any).THREE;
        if (!THREE) {
            window.addEventListener("load", () => this.start(), { once: true });
            setTimeout(() => this.start(), 150);
            return;
        }

        if (!this.scene) {
            this.init();
        }
        if (!this.is3DRunning) {
            this.is3DRunning = true;
            this.onWindowResize();
            this.lastTimestamp = performance.now();
            requestAnimationFrame(this.animate3D);
        }
    }

    public stop(): void {
        this.is3DRunning = false;
        const canvas = getElement("three-canvas");
        if (canvas) canvas.style.display = "none";
    }
}

export const threeController = new ThreeSceneController();
