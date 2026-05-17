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
// Match the page background so cell sampling at bust edges blends into navy
// (empty areas resolve to the lowest luminance → space glyph).
scene.background = new THREE.Color(0x0b1f33);

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
  Math.min(3080, Math.floor(Math.max(window.innerWidth, window.innerHeight) * 2.2)),
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

// Size the stage to just enclose the 45°-rotated bust silhouette. The bust's
// unrotated bbox in the canvas is ≈ 0.40·H × 0.70·H, so its on-screen bbox
// after rotation is (0.40+0.70)/√2 ≈ 0.78·H; 0.85·H leaves a small vertical
// margin. Horizontal bleed still runs off the viewport edges (clipped by
// body's overflow-x). This makes the page taller than one viewport, so iOS
// Safari can collapse its bottom chrome on scroll.
stage.style.height = `${Math.ceil(CANVAS_H * 0.85)}px`;

// Brand symbol ramp, slot order brightest→darkest input. Shape changes in
// coarse bands while color steps a fine gradient, so each shape spans several
// shades:
//   0 serif "O" · 1-3 filled square · 4-5 empty square
//   · 6-7 solid circle · 8 small circle · 9 space
// Multiple slots reuse a glyph shape, differing only in color (see paletteFor).
// The post shader maps each cell's luminance to a slot and tints it.
const GLYPH_COUNT = 10;

// ---- GPU SYMBOL POST-PROCESSING ----------------------------------------
// 1) Render the bust to an offscreen target (renderTarget).
// 2) Draw a full-screen quad over the real canvas; its fragment shader reads
//    the bust texture, partitions the framebuffer into cells, picks a glyph
//    from the atlas based on per-cell luminance, and emits brand-colored
//    glyph pixels. Everything stays on the GPU — no getImageData, no DOM spans.
// Smaller cells = smaller, denser symbols. Each pixel only costs a handful of
// texture samples + arithmetic, so going tiny is essentially free. The cell is
// SQUARE so the round glyphs (serif O, circles) stay round instead of being
// stretched into ellipses. This is the main density knob — larger = chunkier,
// fewer symbols; tune against the brand reference.
const CELL_SIZE = 12; // symbol cell size in CSS pixels (square)

const renderTarget = new THREE.WebGLRenderTarget(CANVAS_W, CANVAS_H, {
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
  // Default (LinearSRGBColorSpace): the bust shader writes a plain grayscale
  // shade here; the post shader reads it back as a luminance signal only.
});

// Glyph atlas: the brand symbols drawn to their own horizontal slot in a
// single canvas, then uploaded as a Three.js texture. Each glyph is rendered
// white — a pure shape mask — and the post shader tints it with the matching
// brand color (so one shape can fill several slots at different colors). The
// shader samples by computing (charIdx + cellLocalX) / charCount as the U
// coord. Glyph metrics are tunable to match the reference.
const ATLAS_CHAR_PX = 48; // generous; linear downsample handles small display sizes
function makeCharAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = GLYPH_COUNT * ATLAS_CHAR_PX;
  canvas.height = ATLAS_CHAR_PX;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'white';
  ctx.strokeStyle = 'white';
  const S = ATLAS_CHAR_PX;
  const cy = S / 2;
  const cx = (slot) => slot * S + S / 2;

  // Rounded square, pre-rotated 45°. The canvas is CSS-rotated 45°, so a square
  // drawn at 45° lands at 90° on screen — i.e. reads as an upright square.
  // fill=false strokes only, leaving the interior transparent so the post
  // shader fills it with the navy bg ("hollow"/"empty" square).
  const square = (slot, fill) => {
    const side = S * 0.66;
    ctx.save();
    ctx.translate(cx(slot), cy);
    ctx.rotate(Math.PI / 4);
    ctx.beginPath();
    ctx.roundRect(-side / 2, -side / 2, side, side, S * 0.11);
    if (fill) {
      ctx.fill();
    } else {
      ctx.lineWidth = S * 0.14;
      ctx.stroke();
    }
    ctx.restore();
  };
  const circle = (slot, r) => {
    ctx.beginPath();
    ctx.arc(cx(slot), cy, r, 0, Math.PI * 2);
    ctx.fill();
  };

  // slot 0 — serif uppercase "O". Pre-rotated -45° to cancel the canvas's +45°
  // CSS rotation so it reads upright; drawn in the page's serif stack so it
  // carries real typographic stroke contrast (not a geometric ring).
  ctx.save();
  ctx.translate(cx(0), cy);
  ctx.rotate(-Math.PI / 4);
  ctx.font = `${Math.round(S * 1.05)}px 'Times New Roman', Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('O', 0, 0);
  ctx.restore();

  square(1, true);     // slot 1 — filled square (pale coral)
  square(2, true);     // slot 2 — filled square (coral)
  square(3, true);     // slot 3 — filled square (rose)
  square(4, false);    // slot 4 — empty square (mauve)
  square(5, false);    // slot 5 — empty square (dusty purple)
  circle(6, S * 0.28); // slot 6 — solid circle (purple)
  circle(7, S * 0.28); // slot 7 — solid circle (indigo)
  circle(8, S * 0.13); // slot 8 — small circle (dark blue)
  // slot 9 — space: left empty

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
    cellSize:   { value: new THREE.Vector2(CELL_SIZE, CELL_SIZE) },
    charCount:  { value: GLYPH_COUNT },
    // Raw sRGB values (hex / 255) — written straight to the canvas in sRGB.
    bgColor:    { value: new THREE.Vector3(11/255, 31/255, 51/255) },
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
    // Brand color for each glyph slot, sRGB display values. A step()/mix
    // chain rather than an indexed array — portable across GLSL ES versions
    // and the indices are compile-time constants anyway.
    vec3 paletteFor(float idx) {
      vec3 c = vec3(1.0, 1.0, 1.0);                                          // 0 serif "O"     — white
      c = mix(c, vec3(246.0/255.0, 192.0/255.0, 181.0/255.0), step(0.5, idx)); // 1 filled square — pale coral
      c = mix(c, vec3(240.0/255.0, 133.0/255.0, 133.0/255.0), step(1.5, idx)); // 2 filled square — coral
      c = mix(c, vec3(212.0/255.0, 128.0/255.0, 142.0/255.0), step(2.5, idx)); // 3 filled square — rose
      c = mix(c, vec3(182.0/255.0, 126.0/255.0, 149.0/255.0), step(3.5, idx)); // 4 empty square  — mauve
      c = mix(c, vec3(148.0/255.0, 116.0/255.0, 143.0/255.0), step(4.5, idx)); // 5 empty square  — dusty purple
      c = mix(c, vec3(110.0/255.0,  97.0/255.0, 130.0/255.0), step(5.5, idx)); // 6 solid circle  — purple
      c = mix(c, vec3( 78.0/255.0,  79.0/255.0, 115.0/255.0), step(6.5, idx)); // 7 solid circle  — indigo
      c = mix(c, vec3( 53.0/255.0,  71.0/255.0, 101.0/255.0), step(7.5, idx)); // 8 small circle  — dark blue
      return c; // slot 9 (space) — unused, its glyph mask is empty
    }
    void main() {
      vec2 fragCoord = vUv * resolution;
      // Snap to symbol cell
      vec2 cellOrigin = floor(fragCoord / cellSize) * cellSize;
      vec2 cellCenterUV = (cellOrigin + cellSize * 0.5) / resolution;
      // The bust render is grayscale — sample its shade once per cell.
      float lum = texture2D(tDiffuse, cellCenterUV).r;
      // Luminance drives the slot pick: bright = serif "O" (0), dark = space (last)
      float charIdx = clamp(floor((1.0 - lum) * charCount), 0.0, charCount - 1.0);
      // Position within this cell, 0..1
      vec2 cellLocal = (fragCoord - cellOrigin) / cellSize;
      // Map to the atlas U (one glyph per slot)
      vec2 charUV = vec2((charIdx + cellLocal.x) / charCount, cellLocal.y);
      float charMask = texture2D(tChars, charUV).a;
      // bgColor and the palette are both sRGB display values — mix directly.
      gl_FragColor = vec4(mix(bgColor, paletteFor(charIdx), charMask), 1.0);
    }
  `,
});
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial));
// -----------------------------------------------------------------------

// Scene lights are omitted — the onBeforeCompile hook below computes its own
// single key-light Lambert term from the surface normal and writes a plain
// grayscale. The post shader reads that shade as a luminance signal and maps
// it to a brand symbol per cell (bright = serif "O", dark = space). A manual light
// (rather than camera depth) is what gives the bust real form, so the symbol
// ramp reads as a side-lit portrait instead of a depth bullseye.
const bustMaterial = new THREE.MeshPhongMaterial({
  color: 0xffffff,
  shininess: 12,
  flatShading: false,
});
bustMaterial.onBeforeCompile = (shader) => {
  // `normal` is the view-space normal that <normal_fragment_begin> leaves in
  // scope; <colorspace_fragment> runs late in main(), so it is still defined.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <colorspace_fragment>',
    `
     // Key light from the left, fixed in view space. Mostly lateral (small z)
     // so the bust has a genuine lit side and shadow side rather than a
     // frontal wash — the shadow side is what gives the circle slots real
     // coverage. The bust turntable-spins through it, sweeping the highlight.
     // Half-Lambert (×0.5+0.5) maps the full surface to 0..1 and keeps the
     // shadow side graded; used linearly so the 10 symbol slots spread evenly
     // across the bust instead of the shadow collapsing onto the last slots.
     vec3 _L = normalize(vec3(-0.85, 0.33, 0.30));
     float _shade = dot(normal, _L) * 0.5 + 0.5;
     gl_FragColor.rgb = vec3(_shade);
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

      // Start the auto-spin with the face toward the camera (GLB's default
      // front is -Z away from us; a half-turn brings the face forward).
      bust.rotation.y = Math.PI;

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

// Pointer-driven rotation with momentum. While dragging, horizontal screen
// delta rotates the bust directly. On release, the recent drag velocity
// becomes angular velocity, which then damps back toward AUTO_SPIN_RATE so
// the idle contemplative spin resumes on its own.
const AUTO_SPIN_RATE = 0.2;   // rad/s — idle spin
const DRAG_SENSITIVITY = 0.01; // rad per CSS pixel of horizontal drag
const SPIN_DAMP = 1.2;         // higher = faster return to AUTO_SPIN_RATE
const MAX_FLING = 12;          // rad/s cap on post-release velocity
let dragging = false;
let lastPointerX = 0;
let angVel = AUTO_SPIN_RATE;
const velSamples = []; // { t, d } pairs over the last ~100 ms

stage.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastPointerX = e.clientX;
  velSamples.length = 0;
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!dragging || !bust) return;
  const dx = e.clientX - lastPointerX;
  lastPointerX = e.clientX;
  const d = dx * DRAG_SENSITIVITY;
  bust.rotation.y += d;
  velSamples.push({ t: performance.now(), d });
  const cutoff = performance.now() - 100;
  while (velSamples.length && velSamples[0].t < cutoff) velSamples.shift();
});
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  if (velSamples.length >= 2) {
    const total = velSamples.reduce((s, v) => s + v.d, 0);
    const dur = (velSamples[velSamples.length - 1].t - velSamples[0].t) / 1000;
    if (dur > 0) angVel = Math.max(-MAX_FLING, Math.min(MAX_FLING, total / dur));
  }
  velSamples.length = 0;
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

// Throttle to ~30 fps (33 ms frame budget).
const FRAME_MS = 1000 / 30;
let rafId = 0;
let running = true;
let last = 0;
function animate(now) {
  if (!running) return;
  rafId = requestAnimationFrame(animate);
  if (now - last < FRAME_MS) return;
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (bust && !dragging) {
    angVel += (AUTO_SPIN_RATE - angVel) * Math.min(1, dt * SPIN_DAMP);
    bust.rotation.y += angVel * dt;
  }
  const cvs = renderer.domElement;
  if (cvs.width > 0 && cvs.height > 0) {
    try {
      // Pass 1: bust to offscreen render target
      renderer.setRenderTarget(renderTarget);
      renderer.render(scene, camera);
      // Pass 2: full-screen quad with ASCII post-process shader → real canvas
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCamera);
    } catch { /* transient size race */ }
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
