import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import MODEL_URL from '../aristotle.glb' with { type: 'file' };
// AsciiEffect is no longer used — we do the ASCII conversion on the GPU in a
// post-processing shader pass instead. See the char atlas + postMaterial
// setup below. The DOM-span approach cost ~70ms/frame in layout+paint on
// Retina displays; GPU post-process is ~2ms/frame for the same result.

const stage = document.getElementById('stage');
const loading = document.getElementById('loading');

const scene = new THREE.Scene();
// Match the page background so AsciiEffect cell-averaging at bust edges
// blends into cream (empty areas become space chars) instead of black.
scene.background = new THREE.Color(0xeeeee4);

// Canvas is a TALL RECTANGLE tightly matching the bust's silhouette (~0.65
// w/h) instead of a square. A square canvas wasted ~35% of its cells on
// empty cream margins flanking the bust — all of which went through the
// per-frame innerHTML rebuild. Bust bbox is ~1.35 × 2.6 × 1.49 world
// units; the worst-case horizontal silhouette during Y-rotation is
// √(x² + z²) ≈ 2.01 as a pure bbox, ~1.7 for the actual mesh shape.
// 1.7 / 2.6 ≈ 0.65.
const BUST_ASPECT = 0.65;
// 2× previous size. Canvas is positioned so its vertical center sits on the
// viewport's bottom edge — the upper half of the bust is visible rising up
// from the bottom of the page, the lower half is clipped offscreen below.
// At ~2000×3080 on a 1080p display that's ~6 MP of fragment work per frame,
// still <2 ms on any modern GPU.
const CANVAS_H = Math.max(
  Math.min(3080, Math.floor(Math.min(window.innerWidth, window.innerHeight) * 3.4)),
  800
);
const CANVAS_W = Math.round(CANVAS_H * BUST_ASPECT);

const camera = new THREE.PerspectiveCamera(
  32,
  CANVAS_W / CANVAS_H, // match canvas aspect so the bust fills vertically without horizontal stretch
  0.1,
  1000
);
// Camera distance unchanged — sizing is done via canvas dimensions, not
// by pulling the camera in (which would crop the model).
camera.position.set(0, 0, 6.5);

// antialias: false — post-process samples at cell center anyway, MSAA on the
// bust render target is wasted. setPixelRatio(1) keeps the framebuffer
// backing store in CSS pixels (avoids the Retina 4× memory / fill cost).
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(CANVAS_W, CANVAS_H);
stage.appendChild(renderer.domElement);

// ASCII ramp from darkest (space) to brightest (#).
const chars = ' .,:;i1tfLCG08@';

// ---- GPU ASCII POST-PROCESSING -----------------------------------------
// 1) Render the bust to an offscreen target (renderTarget).
// 2) Draw a full-screen quad over the real canvas; its fragment shader reads
//    the bust texture, partitions the framebuffer into cells, picks a char
//    from the atlas based on per-cell luminance, and emits colored char
//    pixels. Everything stays on the GPU — no getImageData, no DOM spans.
// Smaller cells = smaller, denser characters. Each pixel only costs a
// handful of texture samples + arithmetic, so going tiny is essentially free.
// 5×8 on a 1000×1540 canvas → ~200 × 192 ≈ 38k chars on screen.
const CELL_W = 5;  // char cell size in CSS pixels (width)
const CELL_H = 8;  // char cell size in CSS pixels (height)

const renderTarget = new THREE.WebGLRenderTarget(CANVAS_W, CANVAS_H, {
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
  // Default (LinearSRGBColorSpace): the bust's shader writes its pre-encode
  // linear colors directly, no sRGB round-trip — cleaner math in the post
  // shader, at the cost of one manual linearToSRGB at output.
});

// Char atlas: each char drawn to its own horizontal slot in a single canvas,
// then uploaded as a Three.js texture. The shader samples from this by
// computing (charIdx + cellLocalX) / charCount as the U coord.
const ATLAS_CHAR_PX = 48; // generous; linear downsample handles small display sizes
function makeCharAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = chars.length * ATLAS_CHAR_PX;
  canvas.height = ATLAS_CHAR_PX;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = `bold ${Math.floor(ATLAS_CHAR_PX * 0.85)}px 'Courier New', ui-monospace, monospace`;
  ctx.fillStyle = 'white';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], i * ATLAS_CHAR_PX + ATLAS_CHAR_PX / 2, ATLAS_CHAR_PX / 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const charAtlas = makeCharAtlas();

// Full-screen post-process scene
const postScene = new THREE.Scene();
const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const postMaterial = new THREE.ShaderMaterial({
  uniforms: {
    tDiffuse:   { value: renderTarget.texture },
    tChars:     { value: charAtlas },
    resolution: { value: new THREE.Vector2(CANVAS_W, CANVAS_H) },
    cellSize:   { value: new THREE.Vector2(CELL_W, CELL_H) },
    charCount:  { value: chars.length },
    // Raw sRGB values (hex / 255). With the linearToSRGB step gone, the
    // shader output is written straight to the canvas in sRGB space.
    bgColor:    { value: new THREE.Vector3(238/255, 238/255, 228/255) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tChars;
    uniform vec2 resolution;
    uniform vec2 cellSize;
    uniform float charCount;
    uniform vec3 bgColor;
    varying vec2 vUv;
    // Manual sRGB encode at the very end — a bare ShaderMaterial does NOT
    // include Three's <colorspace_fragment>, so without this the linear
    // values we compute get displayed raw and look dim. Using simple gamma
    // 2.2 (vs the piecewise sRGB curve) — both visually indistinguishable
    // for opaque colors.
    vec3 linearToSRGB_(vec3 c) {
      return pow(max(c, vec3(0.0)), vec3(1.0/2.2));
    }
    void main() {
      vec2 fragCoord = vUv * resolution;
      // Snap to character cell
      vec2 cellOrigin = floor(fragCoord / cellSize) * cellSize;
      vec2 cellCenterUV = (cellOrigin + cellSize * 0.5) / resolution;
      // Sample bust color at cell center (once per cell, via the texel lookup
      // being the same for every pixel within a cell)
      vec3 cellColor = texture2D(tDiffuse, cellCenterUV).rgb;
      // Luminance drives char-density pick; invert:false semantics (bright = space, dark = '@')
      float lum = dot(cellColor, vec3(0.3, 0.59, 0.11));
      float charIdx = clamp(floor((1.0 - lum) * charCount), 0.0, charCount - 1.0);
      // Position within this cell, 0..1
      vec2 cellLocal = (fragCoord - cellOrigin) / cellSize;
      // Map to char atlas U (one char per slot)
      vec2 charUV = vec2((charIdx + cellLocal.x) / charCount, cellLocal.y);
      float charMask = texture2D(tChars, charUV).a;
      // bgColor is sRGB (raw display values). cellColor from RT is linear —
      // encode only the bust color to sRGB, then mix directly in sRGB space.
      vec3 cellSRGB = linearToSRGB_(cellColor);
      gl_FragColor = vec4(mix(bgColor, cellSRGB, charMask), 1.0);
    }
  `,
});
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial));
// -----------------------------------------------------------------------

// Lights intentionally omitted: the onBeforeCompile hook below overwrites
// gl_FragColor.rgb with a pure depth tint, so any Phong lighting terms are
// discarded before they reach the framebuffer. Skipping lights saves a
// light-loop pass in the fragment shader per pixel.

// Palette selector — press 1–9 to cycle. Each palette is a combination of:
//   near/mid/far : depth-based color stops (mid optional; smoothstep blend)
//   rim          : optional fresnel-based highlight color on silhouette edges
//   rimStrength  : 0 disables the rim lookup
// Colors here are sRGB hex; converted to linear on apply.
// Palettes need a WIDE luma range between near & far so the char-density
// picker reads visible gradation; hue-only shifts look "flat" because every
// cell picks the same char.  Each near is pushed toward bright, each far
// toward near-black.
//
// Per-palette optional fields:
//   mid            — adds a 3-stop smoothstep blend
//   rim, rimStrength — fresnel silhouette highlight
//   driftSpeed     — rad/s of hue rotation around the luminance axis
const PALETTES = [
  { name: 'Salmon / Black (original)',
    near: 0xffa595, far: 0x1a0201 },
  { name: 'Terracotta / Cobalt',
    near: 0xf48851, far: 0x081a2a },
  { name: 'Amber / Aubergine',
    near: 0xeaa94a, far: 0x14081e },
  { name: 'Bronze / Gunmetal',
    near: 0xdc9a58, far: 0x0a1116 },
  { name: '3-stop: Salmon → Burgundy → Charcoal',
    near: 0xef8070, mid: 0x6a1a10, far: 0x080808 },
  { name: 'Rim-lit Burgundy + Gold',
    near: 0x9f2424, far: 0x120303, rim: 0xf5ca6e, rimStrength: 1.6 },
  { name: 'Oxblood / Teal-Ink',
    near: 0xc44536, far: 0x061f24 },
  { name: '3-stop Hues: Terracotta → Plum → Cobalt',
    near: 0xe87a4a, mid: 0x6c3540, far: 0x08263c },
  { name: 'Salmon / Black + Hue Drift (1 + drift)',
    near: 0xffa595, far: 0x1a0201, driftSpeed: 0.12 },
];

// Stable uniform-value objects — the shader hook references these once at
// compile time; applyPalette() mutates them in place so updates are live.
const paletteState = {
  near:        { value: new THREE.Color() },
  mid:         { value: new THREE.Color() },
  far:         { value: new THREE.Color() },
  useMid:      { value: 0 },
  rim:         { value: new THREE.Color() },
  rimStrength: { value: 0 },
  driftSpeed:  { value: 0 },
  time:        { value: 0 }, // seconds since load; ticked each frame
  minDepth:    { value: 5.70 },
  maxDepth:    { value: 6.50 },
};

function applyPalette(p) {
  paletteState.near.value.set(p.near).convertSRGBToLinear();
  paletteState.far.value.set(p.far).convertSRGBToLinear();
  paletteState.useMid.value = p.mid != null ? 1 : 0;
  if (p.mid != null) paletteState.mid.value.set(p.mid).convertSRGBToLinear();
  paletteState.rimStrength.value = p.rim != null ? (p.rimStrength ?? 1.0) : 0;
  if (p.rim != null) paletteState.rim.value.set(p.rim).convertSRGBToLinear();
  paletteState.driftSpeed.value = p.driftSpeed || 0;
}
let currentPaletteIdx = 0;
function setPalette(idx) {
  currentPaletteIdx = ((idx % PALETTES.length) + PALETTES.length) % PALETTES.length;
  const p = PALETTES[currentPaletteIdx];
  applyPalette(p);
  const nameEl = document.getElementById('palette-name');
  if (nameEl) nameEl.textContent = `${currentPaletteIdx + 1}. ${p.name}`;
}
// Wire 1–9 keys → palette switching
window.addEventListener('keydown', (e) => {
  if (e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key, 10) - 1;
    if (idx < PALETTES.length) setPalette(idx);
  }
});
setPalette(0); // boot with the original

const bustMaterial = new THREE.MeshPhongMaterial({
  color: 0xffffff,
  shininess: 12,
  flatShading: false,
});
bustMaterial.onBeforeCompile = (shader) => {
  // Expose palette state as real uniforms — names prefixed `uMF_` to avoid
  // collisions with anything in Three's built-in Phong uniform dictionary.
  shader.uniforms.uMF_near        = paletteState.near;
  shader.uniforms.uMF_mid         = paletteState.mid;
  shader.uniforms.uMF_far         = paletteState.far;
  shader.uniforms.uMF_useMid      = paletteState.useMid;
  shader.uniforms.uMF_rim         = paletteState.rim;
  shader.uniforms.uMF_rimStrength = paletteState.rimStrength;
  shader.uniforms.uMF_driftSpeed  = paletteState.driftSpeed;
  shader.uniforms.uMF_time        = paletteState.time;
  shader.uniforms.uMF_minDepth    = paletteState.minDepth;
  shader.uniforms.uMF_maxDepth    = paletteState.maxDepth;

  shader.vertexShader = 'varying float vDepth;\nvarying vec3 vViewNormal;\n' + shader.vertexShader.replace(
    '#include <project_vertex>',
    '#include <project_vertex>\nvDepth = -mvPosition.z;\nvViewNormal = normalize(normalMatrix * normal);'
  );
  shader.fragmentShader =
    'varying float vDepth;\n' +
    'varying vec3 vViewNormal;\n' +
    'uniform vec3 uMF_near;\n' +
    'uniform vec3 uMF_mid;\n' +
    'uniform vec3 uMF_far;\n' +
    'uniform float uMF_useMid;\n' +
    'uniform vec3 uMF_rim;\n' +
    'uniform float uMF_rimStrength;\n' +
    'uniform float uMF_driftSpeed;\n' +
    'uniform float uMF_time;\n' +
    'uniform float uMF_minDepth;\n' +
    'uniform float uMF_maxDepth;\n' +
    // Rodrigues rotation around the luminance axis (1,1,1) — cheap hue shift
    // that preserves perceived brightness; used by the temporal-drift palette.
    'vec3 _hueShift(vec3 c, float a) {\n' +
    '  vec3 k = vec3(0.57735);\n' +
    '  float cs = cos(a); float sn = sin(a);\n' +
    '  return c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);\n' +
    '}\n' +
    shader.fragmentShader.replace(
      '#include <colorspace_fragment>',
      `
       float _t = clamp((vDepth - uMF_minDepth) / (uMF_maxDepth - uMF_minDepth), 0.0, 1.0);
       // smoothstep() eases the two linear-mix transitions so there's no
       // visible seam at the stops — big upgrade over raw linear mix.
       vec3 _depthColor;
       if (uMF_useMid > 0.5) {
         if (_t < 0.5) {
           _depthColor = mix(uMF_near, uMF_mid, smoothstep(0.0, 1.0, _t * 2.0));
         } else {
           _depthColor = mix(uMF_mid, uMF_far, smoothstep(0.0, 1.0, (_t - 0.5) * 2.0));
         }
       } else {
         _depthColor = mix(uMF_near, uMF_far, smoothstep(0.0, 1.0, _t));
       }
       // Optional fresnel rim: surfaces whose normal is perpendicular to
       // view (silhouette edges) get the rim color mixed in. Power-2 keeps
       // the rim wider so it's clearly visible instead of hairline.
       if (uMF_rimStrength > 0.0) {
         float _facing = abs(normalize(vViewNormal).z);
         float _rim = pow(1.0 - _facing, 2.0);
         _depthColor = mix(_depthColor, uMF_rim, _rim * uMF_rimStrength);
       }
       // Optional temporal hue drift — slow rotation around luma axis.
       if (uMF_driftSpeed > 0.0) {
         _depthColor = _hueShift(_depthColor, uMF_time * uMF_driftSpeed);
       }
       gl_FragColor.rgb = _depthColor;
       #include <colorspace_fragment>`
    );
};

let bust;
const loader = new GLTFLoader();

(async () => {
  try {
    loading.textContent = 'LOADING';
    const res = await fetch(MODEL_URL);
    const buf = await res.arrayBuffer();

    loader.parse(buf, '', (gltf) => {
      bust = gltf.scene;

      bust.traverse((child) => {
        if (child.isMesh) {
          child.material = bustMaterial;
        }
      });

      // Size first, scale to target height, then recompute center post-scale
      // so the bust sits on the origin (not offset by scaled-away GLB pivot).
      const preBox = new THREE.Box3().setFromObject(bust);
      const preSize = preBox.getSize(new THREE.Vector3());
      const targetHeight = 2.6;
      bust.scale.setScalar(targetHeight / preSize.y);

      const postBox = new THREE.Box3().setFromObject(bust);
      const postCenter = postBox.getCenter(new THREE.Vector3());
      bust.position.sub(postCenter);

      scene.add(bust);
      loading.style.display = 'none';
    }, (err) => {
      console.error('Parse failed:', err);
      loading.textContent = 'PARSE FAILED — check console';
    });
  } catch (err) {
    console.error('Fetch failed:', err);
    loading.textContent = 'FETCH FAILED — check console';
  }
})();

// Throttle to ~30 fps (33 ms frame budget).
const FRAME_MS = 1000 / 30;
let rafId = 0;
let running = true;
let last = 0;

// ---- Perf instrumentation (remove when done debugging) ----
// One-time init snapshot — copy along with the per-second lines below.
console.log(
  `[init] canvas=${CANVAS_W}×${CANVAS_H} ` +
  `viewport=${window.innerWidth}×${window.innerHeight} ` +
  `dpr=${window.devicePixelRatio} ` +
  `cell=${CELL_W}×${CELL_H} ` +
  `ua="${navigator.userAgent}"`
);
let perfRafCount = 0;
const perfRenderTimes = [];
let perfWindowStart = 0;
// -----------------------------------------------------------

function animate(now) {
  if (!running) return;
  rafId = requestAnimationFrame(animate);
  perfRafCount++; // instrumentation: RAF wake-ups (untouched by the throttle)
  if (now - last < FRAME_MS) return;
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (bust) bust.rotation.y += 0.2 * dt; // ~0.2 rad/s — slow contemplative spin, framerate-independent
  paletteState.time.value = now * 0.001; // seconds — feeds the temporal-drift palette
  const cvs = renderer.domElement;
  if (cvs.width > 0 && cvs.height > 0) {
    const t0 = performance.now(); // instrumentation
    try {
      // Pass 1: bust to offscreen render target
      renderer.setRenderTarget(renderTarget);
      renderer.render(scene, camera);
      // Pass 2: full-screen quad with ASCII post-process shader → real canvas
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCamera);
    } catch { /* transient size race */ }
    perfRenderTimes.push(performance.now() - t0);
  }

  // Instrumentation: once-per-second aggregate
  if (perfWindowStart === 0) perfWindowStart = now;
  if (now - perfWindowStart >= 1000) {
    const elapsed = (now - perfWindowStart) / 1000;
    const rafFps = (perfRafCount / elapsed).toFixed(1);
    const renders = perfRenderTimes.length;
    const renderFps = (renders / elapsed).toFixed(1);
    let sum = 0, max = 0, min = Infinity;
    for (const t of perfRenderTimes) {
      sum += t;
      if (t > max) max = t;
      if (t < min) min = t;
    }
    const avg = renders ? (sum / renders).toFixed(1) : '—';
    const minStr = renders ? min.toFixed(1) : '—';
    const maxStr = renders ? max.toFixed(1) : '—';
    const cellsX = Math.floor(CANVAS_W / CELL_W);
    const cellsY = Math.floor(CANVAS_H / CELL_H);
    console.log(
      `[perf] raf=${rafFps}fps  render=${renderFps}fps  ` +
      `gpu.render avg=${avg}ms min=${minStr}ms max=${maxStr}ms  ` +
      `grid=${cellsX}×${cellsY}=${cellsX*cellsY}`
    );
    perfRafCount = 0;
    perfRenderTimes.length = 0;
    perfWindowStart = now;
  }
}
rafId = requestAnimationFrame(animate);

// Canvas dimensions are fixed at module-eval time, but we reapply on the
// next frame to handle the one-time "layout was 0x0 during eval" iframe race.
const applySize = () => {
  camera.updateProjectionMatrix();
  renderer.setSize(CANVAS_W, CANVAS_H);
  renderTarget.setSize(CANVAS_W, CANVAS_H);
  postMaterial.uniforms.resolution.value.set(CANVAS_W, CANVAS_H);
};
requestAnimationFrame(applySize);

// HMR: tear down the old instance on hot update so animation loops,
// WebGL contexts, and DOM nodes don't pile up across edits.
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    running = false;
    cancelAnimationFrame(rafId);
    renderTarget.dispose();
    charAtlas.dispose();
    postMaterial.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  });
}
