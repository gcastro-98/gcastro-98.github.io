// ====== Shan-shui generation + tile rendering worker ======
// Runs the vendored generator off the main thread and renders the landscape into finished
// bitmap tiles (paper, ink and the night-ink look baked in). The page only slides images:
// no SVG DOM to rasterize and no per-frame CSS filter / blend for the compositor.

const TILE = 256;            // world units per tile (same value in script.js)
const VIEW_H = 800 / 1.142;  // upstream visible scene height (windy / zoom)
const PAPER = 512;           // paper texture period, in world units
const CHUNK = 512;           // upstream MEM.cwid
const OVERHANG = 1300;       // chunks reach up to ~1022 units left of the range they were planned for
const BLEED = 4;             // extra device px on each tile's right edge so neighbours overlap

// hue-rotate(180deg) colour matrix (Filter Effects spec with cos = -1, sin = 0)
const HUE180 = [
    -0.574, 1.430, 0.144,
    0.426, 0.430, 0.144,
    0.426, 1.430, -0.856,
];

const supported = typeof OffscreenCanvas === 'function' &&
    typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function' &&
    !!new OffscreenCanvas(1, 1).getContext('2d');

let paper = null;            // night paper texture (OffscreenCanvas)
let ppu = 0, viewW = 0, cursx = 0, nextTile = 0, pumping = false;
let chunks = [], seq = 0;
let ink, inkCtx, out, outCtx, paperPattern;

const warned = new Set();
function warnOnce(msg) {
    if (warned.has(msg)) return;
    warned.add(msg);
    console.warn('[shan-shui] ' + msg);
}

// Port of upstream's paper texture (the hidden #bgcanv loop), mirrored into 4 quadrants
function paperTexture(reso) {
    const pixels = new Uint8ClampedArray(reso * reso * 4);
    const put = (x, y, r, g, b) => {
        if (x >= reso || y >= reso) return;
        const k = (y * reso + x) * 4;
        pixels[k] = r; pixels[k + 1] = g; pixels[k + 2] = b; pixels[k + 3] = 255;
    };
    for (let i = 0; i < reso / 2 + 1; i++) {
        for (let j = 0; j < reso / 2 + 1; j++) {
            let c = 245 + Noise.noise(i * 0.1, j * 0.1) * 10;
            c -= Math.random() * 20;
            const r = Math.round(c), g = Math.round(c * 0.95), b = Math.round(c * 0.85);
            put(i, j, r, g, b);
            put(reso - i, j, r, g, b);
            put(i, reso - j, r, g, b);
            put(reso - i, reso - j, r, g, b);
        }
    }
    return pixels;
}

// The page used to show multiply(paper, ink) through `filter: invert(1) hue-rotate(180deg)`.
// All ink is neutral grey and the hue matrix leaves greys unchanged, so the same image is
// screen(H·(1 - paper), inverted ink): no canvas filter or pixel readback needed.
function nightPaper(reso) {
    const px = paperTexture(reso);
    for (let k = 0; k < px.length; k += 4) {
        const r = 255 - px[k], g = 255 - px[k + 1], b = 255 - px[k + 2];
        px[k] = HUE180[0] * r + HUE180[1] * g + HUE180[2] * b;
        px[k + 1] = HUE180[3] * r + HUE180[4] * g + HUE180[5] * b;
        px[k + 2] = HUE180[6] * r + HUE180[7] * g + HUE180[8] * b;
    }
    const canvas = new OffscreenCanvas(reso, reso);
    canvas.getContext('2d').putImageData(new ImageData(px, reso, reso), 0, 0);
    return canvas;
}

// Ink colour -> its inverse (white occluders become black, which screen leaves untouched)
const inkCache = new Map();
function nightInk(col) {
    let v = inkCache.get(col);
    if (v !== undefined) return v;
    v = null;
    const c = col.trim();
    const m = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
    if (c === 'white') v = '#000';
    else if (c === 'black') v = '#fff';
    else if (m) {
        const a = m[4] === undefined ? 1 : Math.min(+m[4], 1);
        if (m[1] !== m[2] || m[2] !== m[3]) warnOnce('non-grey colour ' + c);
        if (a > 0) v = `rgba(${255 - m[1]},${255 - m[2]},${255 - m[3]},${a})`;
    } else if (c !== 'none') warnOnce('unexpected colour ' + c);
    inkCache.set(col, v);
    return v;
}

// One generator chunk (SVG string) -> polylines; poly() is the only live shape in generator.js
const POLY_RE = /points='([^']*)' style='fill:([^;]*);stroke:([^;]*);stroke-width:([^']*)'/g;
function parseChunk(c) {
    if (c.canv.indexOf('<text') >= 0 || c.canv.indexOf('<circle') >= 0) warnOnce('non-polyline shape skipped');
    const polys = [];
    let left = Infinity, right = -Infinity, m;
    POLY_RE.lastIndex = 0;
    while ((m = POLY_RE.exec(c.canv))) {
        const nums = m[1].trim().split(/[ ,]/);
        if (nums.length < 4) continue;
        const pts = new Float32Array(nums.length);
        let minX = Infinity, maxX = -Infinity;
        for (let i = 0; i < nums.length; i++) {
            const v = +nums[i];
            pts[i] = v;
            if (!(i & 1)) {
                if (v < minX) minX = v;
                if (v > maxX) maxX = v;
            }
        }
        const width = +m[4];
        const fill = nightInk(m[2]);
        // SVG paints nothing for stroke-width 0, canvas would keep the previous width
        const stroke = width > 0 ? nightInk(m[3]) : null;
        if (!fill && !stroke) continue;
        polys.push({ pts, minX, maxX, fill, stroke, width });
        if (minX - width < left) left = minX - width;
        if (maxX + width > right) right = maxX + width;
    }
    return { y: c.y, seq: seq++, left, right, polys };
}

// Make sure everything that can reach into [.., x) has been generated
function generateUpTo(x) {
    if (MEM.xmax - OVERHANG >= x) return;
    const batchStart = MEM.xmax;
    chunkloader(cursx, x + OVERHANG - CHUNK);  // leaves MEM.xmax >= its xmax + CHUNK
    for (const c of MEM.chunks) {
        const p = parseChunk(c);
        if (!p.polys.length) continue;
        if (batchStart > 0 && p.left < batchStart - OVERHANG) warnOnce('chunk overhang beyond ' + OVERHANG);
        chunks.push(p);
    }
    MEM.chunks = [];
}

function ensureCanvases(w, h) {
    if (ink && ink.width === w && ink.height === h) return;
    ink = new OffscreenCanvas(w, h);
    inkCtx = ink.getContext('2d');
    out = new OffscreenCanvas(w, h);
    outCtx = out.getContext('2d', { alpha: false });
    paperPattern = outCtx.createPattern(paper, 'repeat');
}

function renderTile(a) {
    // Tiles share one device-pixel grid (first pixel at floor(a * ppu)), so neighbours line up
    // exactly; constant width so the canvases are reused (the extra pixels just overlap)
    const px0 = Math.floor(a * ppu);
    const w = Math.ceil(TILE * ppu) + 1 + BLEED, h = Math.ceil(VIEW_H * ppu);
    ensureCanvases(w, h);
    const left = px0 / ppu, right = (px0 + w) / ppu;

    // Ink (inverted colours) on a transparent layer, in upstream painter order
    inkCtx.setTransform(1, 0, 0, 1, 0, 0);
    inkCtx.clearRect(0, 0, w, h);
    inkCtx.setTransform(ppu, 0, 0, ppu, -px0, 0);
    inkCtx.lineJoin = 'miter';
    inkCtx.lineCap = 'butt';
    inkCtx.miterLimit = 4;  // SVG default (canvas defaults to 10)
    const visible = chunks
        .filter(c => c.left < right && c.right > left)
        .sort((p, q) => p.y - q.y || p.seq - q.seq);
    for (const c of visible) {
        for (const p of c.polys) {
            const pad = 2 * p.width;
            if (p.maxX + pad < left || p.minX - pad > right) continue;
            const pts = p.pts;
            inkCtx.beginPath();
            inkCtx.moveTo(pts[0], pts[1]);
            for (let i = 2; i < pts.length; i += 2) inkCtx.lineTo(pts[i], pts[i + 1]);
            // No closePath: fill closes implicitly, the SVG stroke stays open
            if (p.fill) { inkCtx.fillStyle = p.fill; inkCtx.fill(); }
            if (p.stroke) { inkCtx.strokeStyle = p.stroke; inkCtx.lineWidth = p.width; inkCtx.stroke(); }
        }
    }

    // Night paper (world-aligned, 512-unit period), then the ink screened on top
    outCtx.globalCompositeOperation = 'source-over';
    outCtx.setTransform(ppu, 0, 0, ppu, -px0, 0);
    outCtx.fillStyle = paperPattern;
    outCtx.fillRect(left, 0, w / ppu, h / ppu);
    outCtx.setTransform(1, 0, 0, 1, 0, 0);
    outCtx.globalCompositeOperation = 'screen';
    outCtx.drawImage(ink, 0, 0);
    outCtx.globalCompositeOperation = 'source-over';

    const bitmap = out.transferToImageBitmap();
    self.postMessage({ type: 'tile', x: a, px0, ppu, bitmap }, [bitmap]);
}

// One tile per task, so resize / advance messages can interleave with rendering
function pump() {
    pumping = false;
    if (!ppu || nextTile >= cursx + viewW + 2 * TILE) return;
    generateUpTo(nextTile + TILE + (2 + BLEED) / ppu);
    renderTile(nextTile);
    nextTile += TILE;
    // Keep only what the first visible tile onwards can still need (also for re-renders)
    const keepFrom = Math.floor(cursx / TILE) * TILE;
    chunks = chunks.filter(c => c.right >= keepFrom);
    schedule();
}

function schedule() {
    if (pumping) return;
    pumping = true;
    setTimeout(pump, 0);
}

if (!supported) {
    self.postMessage({ type: 'unsupported' });
} else {
    // Upstream logs every planned chunk; keep the page console clean
    console.log = function () {};
    importScripts('generator.js');
    Math.seed('' + Date.now());
    // Paper first: same random sequence as before for a given seed
    paper = nightPaper(PAPER);

    // {cursx, viewW, ppu, restart}: restart re-renders from the first visible tile (start or a
    // big resolution change); otherwise a new ppu only applies to the tiles still to come
    self.onmessage = (e) => {
        const msg = e.data;
        cursx = msg.cursx;
        viewW = msg.viewW;
        ppu = msg.ppu;
        const firstVisible = Math.floor(cursx / TILE) * TILE;
        if (msg.restart || nextTile < firstVisible) nextTile = firstVisible;
        schedule();
    };
}
