// ====== Background Selection ======
// 'shanshui': endless procedural ink landscape (shanshui/, after LingDong-/shan-shui-inf)
// 'fluid':    Three.js interactive mesh gradient
const BG_MODE = 'shanshui' // 'shanshui'; // 'fluid'
const BG_FPS = 30;  // background frame cap: halves GPU and window-server work vs 60 fps

if (BG_MODE === 'fluid') {
    initFluidBackground();
} else {
    initShanShuiBackground();
}


// ====== Custom WebGL Mesh Gradient ======
function initFluidBackground() {
    if (!window.THREE) {
        const three = document.createElement('script');
        three.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
        three.onload = initFluidBackground;
        document.body.appendChild(three);
        return;
    }

    const oldCanvas = document.getElementById('bg-canvas');
    const scene = new THREE.Scene();

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    // Soft gradient: rendering at Retina resolution costs 4x the GPU work for no visible gain
    renderer.setPixelRatio(1);

    // Replace the old canvas safely
    if(oldCanvas && oldCanvas.parentNode) {
        oldCanvas.parentNode.replaceChild(renderer.domElement, oldCanvas);
        renderer.domElement.id = 'bg-canvas';
        // Must add the class for pos:fixed
        renderer.domElement.className = 'canvas-container';
    }

    const uniforms = {
        uTime: { value: 0 },
        uMouse: { value: new THREE.Vector2(window.innerWidth/2, window.innerHeight/2) },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) }
    };

    const material = new THREE.ShaderMaterial({
        uniforms: uniforms,
        vertexShader: document.getElementById('vertexShader').textContent,
        fragmentShader: document.getElementById('fragmentShader').textContent
    });

    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
    });

    const currentMouse = new THREE.Vector2(window.innerWidth/2, window.innerHeight/2);
    const targetMouse = new THREE.Vector2(window.innerWidth/2, window.innerHeight/2);

    window.addEventListener('mousemove', (e) => {
        targetMouse.x = e.clientX;
        targetMouse.y = window.innerHeight - e.clientY; 
    });
    window.addEventListener('touchmove', (e) => {
        targetMouse.x = e.touches[0].clientX;
        targetMouse.y = window.innerHeight - e.touches[0].clientY;
    });

    const clock = new THREE.Clock();
    let lastDraw = 0;

    function animate(now) {
        requestAnimationFrame(animate);
        if (now - lastDraw < 1000 / BG_FPS - 2) return;
        // Same easing as 0.08 per frame at 60 fps, whatever the frame rate
        const ease = 1 - Math.pow(0.92, Math.min(now - lastDraw, 100) / (1000 / 60));
        lastDraw = now;

        currentMouse.x += (targetMouse.x - currentMouse.x) * ease;
        currentMouse.y += (targetMouse.y - currentMouse.y) * ease;
        
        uniforms.uMouse.value.copy(currentMouse);
        uniforms.uTime.value = clock.getElapsedTime();
        
        renderer.render(scene, camera);
    }
    requestAnimationFrame(animate);
}


// ====== Shan-shui Endless Ink Landscape ======
// shanshui/worker.js generates the landscape and renders it into finished bitmap tiles;
// this side only slides those tiles with a compositor transform.
function initShanShuiBackground() {
    const SPEED = 25;               // world units per second
    const TILE = 256;               // world units per tile (same value in worker.js)
    const VIEW_H = 800 / 1.142;     // upstream visible scene height (windy / zoom)
    const REBASE = 4096;            // keeps CSS offsets small over long sessions

    let worker;
    try {
        if (!window.OffscreenCanvas || !document.createElement('canvas').getContext('bitmaprenderer')) {
            throw new Error('OffscreenCanvas / bitmaprenderer not supported');
        }
        worker = new Worker('shanshui/worker.js');
    } catch (err) {
        console.warn('Shan-shui background unavailable, using fluid background', err);
        initFluidBackground();
        return;
    }

    const container = document.querySelector('.canvas-container');
    const oldCanvas = document.getElementById('bg-canvas');
    if (oldCanvas) oldCanvas.remove();
    container.classList.add('shanshui');

    // Black inline logo is unreadable on the night-ink background
    const nebboInline = document.querySelector('.nebbo-inline');
    const nebboSrc = nebboInline && nebboInline.getAttribute('src');
    if (nebboInline) nebboInline.src = 'img/nebbo.inverted.png';

    const strip = document.createElement('div');
    strip.className = 'shanshui-strip';
    container.appendChild(strip);

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tiles = new Map();        // world x -> { canvas, px0, ppu }
    let scale, viewW, dpr, ppu, renderedPpu;
    let cursx = 0, originX = 0, lastDraw = 0, started = false, failed = false;

    function layout() {
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        scale = window.innerHeight / VIEW_H;
        viewW = window.innerWidth / scale;
        ppu = scale * dpr;          // tile pixels per world unit
        tiles.forEach(place);
    }

    // Whole device pixels keep the ink lines crisp while panning
    const snap = px => Math.round(px * dpr) / dpr;

    // Tiles are rendered on a shared device-pixel grid (first pixel px0 = floor(x * ppu))
    function place(tile) {
        const k = scale / tile.ppu;  // CSS px per tile pixel
        const s = tile.canvas.style;
        s.left = `${snap(tile.px0 * k - originX * scale)}px`;
        s.width = `${tile.canvas.width * k}px`;
        s.height = `${tile.canvas.height * k}px`;
    }

    function covered() {
        for (let x = Math.floor(cursx / TILE) * TILE; x < cursx + viewW; x += TILE) {
            if (!tiles.has(x)) return false;
        }
        return true;
    }

    // Tiles left of the first visible one are gone for good (their bleed lies under the next
    // tile); release the bitmap now rather than whenever the canvas gets garbage-collected
    function dropPassedTiles() {
        const firstVisible = Math.floor(cursx / TILE) * TILE;
        tiles.forEach((tile, x) => {
            if (x >= firstVisible) return;
            tile.canvas.width = tile.canvas.height = 1;
            tile.canvas.getContext('bitmaprenderer').transferFromImageBitmap(null);
            tile.canvas.remove();
            tiles.delete(x);
        });
    }

    function requestTiles(restart) {
        worker.postMessage({ cursx, viewW, ppu: renderedPpu, restart });
    }

    function fail(reason) {
        if (failed) return;
        failed = true;
        console.warn('Shan-shui worker failed, using fluid background', reason);
        worker.terminate();
        container.classList.remove('shanshui', 'loaded');
        if (nebboInline) nebboInline.src = nebboSrc;
        strip.remove();
        const canvas = document.createElement('canvas');
        canvas.id = 'bg-canvas';
        container.appendChild(canvas);
        initFluidBackground();
    }

    worker.onerror = (err) => fail(err.message || err);

    worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'unsupported') return fail('no OffscreenCanvas 2D in workers');
        if (msg.x < Math.floor(cursx / TILE) * TILE) return msg.bitmap.close();  // already scrolled past
        let tile = tiles.get(msg.x);
        if (!tile) {
            tile = { canvas: document.createElement('canvas'), px0: 0, ppu: 0 };
            tiles.set(msg.x, tile);
            strip.appendChild(tile.canvas);
        }
        // A re-rendered tile (after a resize) simply replaces the old bitmap
        tile.canvas.width = msg.bitmap.width;
        tile.canvas.height = msg.bitmap.height;
        tile.canvas.getContext('bitmaprenderer', { alpha: false }).transferFromImageBitmap(msg.bitmap);
        tile.px0 = msg.px0;
        tile.ppu = msg.ppu;
        place(tile);
        if (!started && covered()) {
            started = true;
            container.classList.add('loaded');
            if (!reduceMotion) requestAnimationFrame(animate);
        }
    };

    function animate(now) {
        if (failed) return;
        requestAnimationFrame(animate);
        // Frame cap: skipped frames change nothing, so neither the compositor nor the
        // OS window server has anything to redraw
        if (now - lastDraw < 1000 / BG_FPS - 2) return;
        // Clamp so a backgrounded tab doesn't jump ahead on return
        const dt = lastDraw ? Math.min((now - lastDraw) / 1000, 0.1) : 0;
        lastDraw = now;

        const tileBefore = Math.floor(cursx / TILE);
        cursx += SPEED * dt;
        if (cursx - originX > REBASE) {
            originX = Math.round(cursx * ppu) / ppu;  // stays on the device-pixel grid
            tiles.forEach(place);
        }
        strip.style.transform = `translate3d(${-snap((cursx - originX) * scale)}px, 0, 0)`;

        if (Math.floor(cursx / TILE) !== tileBefore) {
            dropPassedTiles();
            requestTiles(false);
        }
    }

    // Old tiles rescale at once; re-render them only if the resolution changed a lot
    // (small changes, e.g. a mobile URL bar, just apply to the tiles still to come)
    let resizeTimer;
    function onResize() {
        layout();
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            const restart = Math.abs(ppu / renderedPpu - 1) > 0.2;
            renderedPpu = ppu;
            requestTiles(restart);
        }, 200);
    }
    window.addEventListener('resize', onResize);
    // Moving the window to a screen with another pixel ratio doesn't always fire 'resize'
    (function watchPixelRatio() {
        window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
            .addEventListener('change', () => { onResize(); watchPixelRatio(); }, { once: true });
    })();

    layout();
    renderedPpu = ppu;
    requestTiles(true);
}


// ====== Timeline Scroll Observer ======
const snapContainer = document.getElementById('snap-container');
const sections = document.querySelectorAll('.section');
const navLinks = document.querySelectorAll('.timeline a');
const indicator = document.getElementById('indicator');

const observerOptions = {
    root: snapContainer,
    rootMargin: '0px',
    threshold: 0.5 
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');

            let activeId = entry.target.id;
            navLinks.forEach(link => {
                link.classList.remove('active');
                if (link.getAttribute('data-section') === activeId) {
                    link.classList.add('active');
                    if(indicator) {
                        const linkRect = link.getBoundingClientRect();
                        const containerRect = document.querySelector('.timeline').getBoundingClientRect();
                        const topOffset = linkRect.top - containerRect.top + (linkRect.height / 2) - 5;
                        indicator.style.top = `${topOffset}px`;
                    }
                }
            });
        }
    });
}, observerOptions);

sections.forEach(section => observer.observe(section));

setTimeout(() => {
    const activeLink = document.querySelector('.timeline a.active');
    if(activeLink && indicator) {
        const linkRect = activeLink.getBoundingClientRect();
        const containerRect = document.querySelector('.timeline').getBoundingClientRect();
        const topOffset = linkRect.top - containerRect.top + (linkRect.height / 2) - 5;
        indicator.style.top = `${topOffset}px`;
    }
}, 300);

navLinks.forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const targetId = this.getAttribute('href').substring(1);
        const targetSection = document.getElementById(targetId);
        if(targetSection) {
            snapContainer.scrollTo({
                top: targetSection.offsetTop,
                behavior: 'smooth'
            });
        }
    });
});
