import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const stage = document.getElementById('stage');
const canvas = document.getElementById('gl');

const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true, powerPreference:'high-performance' });
// 2x on a retina panel is four times the fragment work for detail nobody sees
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

if (!renderer.getContext()){
  document.body.classList.add('model-failed');
}
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);

// studio environment drives the PBR reflections; the lights shape it
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

scene.add(new THREE.HemisphereLight(0xffffff, 0xe6dfd0, 0.55));
const key = new THREE.DirectionalLight(0xfff5ea, 2.4);
key.position.set(1.4, 6.2, 2.6);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 0.5; key.shadow.camera.far = 24;
key.shadow.camera.left = -3; key.shadow.camera.right = 3;
key.shadow.camera.top = 4; key.shadow.camera.bottom = -1;
key.shadow.radius = 3; key.shadow.bias = -0.0012;
scene.add(key);
const fill = new THREE.DirectionalLight(0xe8f0ff, 0.6); fill.position.set(-4, 2.4, 2.6); scene.add(fill);
const rim  = new THREE.DirectionalLight(0xffffff, 1.5); rim.position.set(-1.8, 3.2, -4.4); scene.add(rim);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.22 }));
ground.rotation.x = -Math.PI/2; ground.receiveShadow = true; scene.add(ground);

const pivot = new THREE.Group();
scene.add(pivot);

let ready = false;
const report = {};

function onLoaded(gltf){
  restoreImageBitmap();
  const root = gltf.scene;
  root.traverse(o => { if (o.isMesh){ o.castShadow = true; o.receiveShadow = true; } });

  // normalise: centre on origin, stand on the ground, scale to a known height
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const target = 2.4;
  const s = target / size.y;
  root.scale.setScalar(s);
  root.position.set(-centre.x * s, -box.min.y * s, -centre.z * s);
  pivot.add(root);

  const mats = [];
  root.traverse(o => {
    if (o.isMesh && o.material){
      const m = o.material;
      if (!mats.includes(m)) mats.push(m);
      // Prefer the glTF texture name. image.src is a blob: UUID when the model is
      // parsed from memory, which carries no garment information - reading it first
      // silently broke cloth matching once already.
      const tex = (m.map && (m.map.name || (m.map.image && m.map.image.src))) || '';
      m.userData.texName = String(tex).split('/').pop() || '(embedded)';
      m.envMapIntensity = 0.85;
    }
  });

  // the suit cloth is whatever wears the jacket / trouser diffuse; shirt, belt and shoes stay put
  let clothMats = mats.filter(m => /jacket|pants/.test(m.userData.texName));
  // Material names are the fallback identifier: they survive parsing when texture
  // names do not. Material.001 is the jacket, Material.006 the trousers.
  if (!clothMats.length) clothMats = mats.filter(m => /Material\.(001|006)$/.test(m.name || ''));
  if (clothMats.length !== 2){
    console.warn('VESTRA: expected 2 cloth materials, matched ' + clothMats.length +
                 ' - recolouring will be wrong. Materials seen: ' +
                 mats.map(m => (m.name || '?') + '/' + m.userData.texName).join(', '));
  }
  clothMats.forEach(m => {
    m.userData.origMap = m.map;
    m.userData.origColor = m.color.clone();
    m.userData.origRough = m.roughness;
  });
  window.__cloth = clothMats;

  // Recolouring keeps the cloth's shading and replaces only its colour.
  //
  // Tinting over the diffuse was wrong in both directions: multiplying a colour
  // over a near-black charcoal weave crushes everything toward black (navy and
  // charcoal came out identical), and multiplication can never lighten, so ivory
  // was impossible without dropping the texture and going flat.
  //
  // Instead, rebuild the map per cloth: take each pixel's luminance relative to
  // the texture's mean, and apply that ratio to the target colour. Weave, seams
  // and baked shadows survive at any lightness. Canvas work only - no requests.
  const MAX_TEX = 1024;
  // How much of the source texture's light and shade carries into a recoloured
  // cloth. 1 keeps it all and looks dirty on pale colours; 0 is flat plastic.
  const SHADE = 0.42;

  function sourceStats(mat){
    if (mat.userData.stats) return mat.userData.stats;
    const img = mat.userData.origMap && mat.userData.origMap.image;
    if (!img || !img.width) return null;
    const w = Math.min(img.width, MAX_TEX), h = Math.min(img.height, MAX_TEX);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, w, h);
    const data = cx.getImageData(0, 0, w, h);
    let sum = 0;
    const lum = new Float32Array(w * h);
    for (let i = 0, p = 0; i < data.data.length; i += 4, p++){
      const l = (0.2126 * data.data[i] + 0.7152 * data.data[i+1] + 0.0722 * data.data[i+2]) / 255;
      lum[p] = l; sum += l;
    }
    mat.userData.stats = { w, h, lum, mean: Math.max(sum / (w * h), 0.02), alpha: data };
    return mat.userData.stats;
  }

  function tintedMap(mat, hex){
    mat.userData.tints = mat.userData.tints || {};
    if (mat.userData.tints[hex]) return mat.userData.tints[hex];
    const st = sourceStats(mat);
    if (!st) return null;

    const target = new THREE.Color(hex);
    const c = document.createElement('canvas');
    c.width = st.w; c.height = st.h;
    const cx = c.getContext('2d');
    const out = cx.createImageData(st.w, st.h);
    const tr = target.r * 255, tg = target.g * 255, tb = target.b * 255;

    for (let p = 0, i = 0; p < st.lum.length; p++, i += 4){
      // Ratio of this pixel's brightness to the cloth's average, so relative
      // shading is preserved while absolute lightness comes from the target.
      // Pulled toward 1 by SHADE: the raw ratio swings hard on a dark source
      // texture and turns pale cloths blotchy, as if the suit were stained.
      const raw = Math.min(st.lum[p] / st.mean, 2.2);
      const k = 1 + (raw - 1) * SHADE;
      out.data[i]   = Math.min(tr * k, 255);
      out.data[i+1] = Math.min(tg * k, 255);
      out.data[i+2] = Math.min(tb * k, 255);
      out.data[i+3] = st.alpha.data[i+3];
    }
    cx.putImageData(out, 0, 0);

    const src = mat.userData.origMap;
    const tex = new THREE.CanvasTexture(c);
    // glTF maps are flipY:false; a CanvasTexture defaults to true and would
    // render the cloth upside down against the model's UVs
    tex.flipY = src.flipY;
    tex.wrapS = src.wrapS; tex.wrapT = src.wrapT;
    tex.repeat.copy(src.repeat); tex.offset.copy(src.offset);
    tex.colorSpace = src.colorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    mat.userData.tints[hex] = tex;
    return tex;
  }

  window.setCloth = function(hex, rough){
    clothMats.forEach(m => {
      const tex = tintedMap(m, hex);
      if (tex){ m.map = tex; m.color.setHex(0xffffff); }
      else { m.map = null; m.color.set(hex); }   // fallback if the image is unreadable
      m.roughness = rough;
      m.needsUpdate = true;
    });
    if (typeof markDirty === 'function') markDirty();
  };

  report.size = [size.x.toFixed(2), size.y.toFixed(2), size.z.toFixed(2)];
  report.scale = s.toFixed(3);
  report.materials = mats.map(m => ({ name: m.name, tex: m.userData.texName, rough: m.roughness, metal: m.metalness }));
  report.meshes = [];
  root.traverse(o => { if (o.isMesh) report.meshes.push(o.name); });
  // widest silhouette across a full turn: arms-out width, not depth
  window.__model = { root, mats, report, bounds: {
    height: size.y * s,
    width: Math.max(size.x, size.z) * s,
    centreY: (box.min.y + size.y / 2) * s - box.min.y * s
  }};
  computeFit();

  // ---- lookbook plates -------------------------------------------------
  // Render the real garment once per cloth and hand the results to the grid.
  // Framing is derived from the model's bounds exactly as the hero's is, so the
  // collar cannot be clipped; the view is a three-quarter turn so the cards read
  // as garments rather than flat elevations.
  //
  // Read back from a render target, not the canvas: toDataURL() on a WebGL
  // canvas returns a stale buffer unless preserveDrawingBuffer is set, and that
  // taxes every frame for the sake of six one-off captures. No requests are
  // issued, so this stays within the sandbox's CSP.
  function renderPlates(){
    const cards = [...document.querySelectorAll('[data-plate]')];
    if (!cards.length) return;

    const W = 660, H = 825;                        // 4:5, matching the card frame
    const b = window.__model.bounds;
    const vFov = 26 * Math.PI / 180;
    const MARGIN = 1.22;
    const needV = (b.height * MARGIN / 2) / Math.tan(vFov / 2);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (W / H));
    const needH = (b.width * MARGIN / 2) / Math.tan(hFov / 2);

    const cam = new THREE.PerspectiveCamera(26, W / H, 0.1, 100);
    cam.position.set(0, b.centreY, Math.max(needV, needH));
    cam.lookAt(0, b.centreY, 0);

    const rt = new THREE.WebGLRenderTarget(W, H, { colorSpace: THREE.SRGBColorSpace, samples: 4 });
    const flat = document.createElement('canvas');
    flat.width = W; flat.height = H;
    const ctx = flat.getContext('2d');
    const px = new Uint8Array(W * H * 4);
    const img = ctx.createImageData(W, H);

    const heroRot = pivot.rotation.y;
    pivot.rotation.y = -0.46;                      // one three-quarter view for all six

    cards.forEach(card => {
      window.setCloth(card.dataset.plate, parseFloat(card.dataset.rough));

      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
      renderer.setRenderTarget(null);

      // WebGL reads bottom-up; the 2D canvas expects top-down
      for (let y = 0; y < H; y++){
        const src = (H - 1 - y) * W * 4;
        img.data.set(px.subarray(src, src + W * 4), y * W * 4);
      }
      ctx.clearRect(0, 0, W, H);
      ctx.putImageData(img, 0, 0);

      card.style.backgroundImage = 'url(' + flat.toDataURL('image/webp', 0.88) + ')';
      card.classList.add('is-plated');
    });

    rt.dispose();

    // restore the hero exactly as it was
    pivot.rotation.y = heroRot;
    const active = document.querySelector('[data-cloth][aria-pressed="true"]');
    if (active) window.setCloth(active.dataset.cloth, parseFloat(active.dataset.rough));
  }
  requestAnimationFrame(() => requestAnimationFrame(renderPlates));

  // Apply the selected cloth immediately. Left alone the suit shows its raw
  // texture while a swatch claims to be active, so the first click looked like
  // a downgrade rather than a change.
  const first = document.querySelector('[data-cloth][aria-pressed="true"]');
  if (first) window.setCloth(first.dataset.cloth, parseFloat(first.dataset.rough));


  ready = true;
  document.body.classList.add('model-ready');
}

function onFailed(err){
  restoreImageBitmap();
  console.error('GLB load failed', err);
  document.body.classList.add('model-failed');
  const box = document.querySelector('.loading');
  if (box) box.innerHTML = '<span style="font-family:var(--display);font-size:22px">Model failed to load</span>'
    + '<span class="lbl" style="max-width:34ch;text-align:center;line-height:1.7">'
    + String((err && (err.message || err)) || 'unknown error').slice(0, 200) + '</span>';
}

// GLTFLoader reaches for ImageBitmapLoader when it can, which fetch()es a blob: URL
// per texture. Sandboxed embeds forbid that under connect-src, so every texture fails.
// Hiding createImageBitmap forces the <img> path, which is governed by img-src instead.
const _createImageBitmap = window.createImageBitmap;
window.createImageBitmap = undefined;
const restoreImageBitmap = () => { window.createImageBitmap = _createImageBitmap; };

const loader = new GLTFLoader();

// Decode in memory and parse the bytes directly. Fetching a data: URI trips the
// content-security policy in sandboxed embeds, so we never make a request at all.
function base64ToArrayBuffer(b64){
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

try {
  if (window.__MODEL_B64){
    loader.parse(base64ToArrayBuffer(window.__MODEL_B64), '', onLoaded, onFailed);
  } else {
    loader.load(MODEL_URL, onLoaded, (e) => {
      const el = document.getElementById('load-pct');
      if (el && e.total) el.textContent = Math.round(e.loaded / e.total * 100) + '%';
    }, onFailed);
  }
} catch (err) { onFailed(err); }

/* ---------- scroll lock drives rotation ---------- */
const clamp = (v,a,b)=>Math.min(b,Math.max(a,v));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
// A full turn used to cost 2600px of wheel before the lock would release,
// which left the rest of the page unreachable long enough to read as broken.
const SCRUB = 1250;
let target = reduced ? 0.5 : 0, current = target, spin = 0;
let locked = false, lockedY = 0, touchY = 0;

function engage(){
  if (locked || reduced || !ready) return;
  locked = true; lockedY = scrollY;
  const b = document.body.style;
  b.position='fixed'; b.top = `-${lockedY}px`; b.left='0'; b.right='0'; b.width='100%';
  document.body.classList.add('is-locked');
}
function release(){
  if (!locked) return;
  locked = false;
  const b = document.body.style;
  b.position=''; b.top=''; b.left=''; b.right=''; b.width='';
  scrollTo(0, lockedY);
  document.body.classList.remove('is-locked');
}
function advance(d){
  target = clamp(target + d/SCRUB, 0, 1);
  if (target >= 1 && d > 0) release();
}
addEventListener('wheel', e => {
  if (locked){ advance(e.deltaY); e.preventDefault(); return; }
  if (!reduced && ready && e.deltaY < 0 && scrollY <= 2 && current > 0.001){ engage(); advance(e.deltaY); e.preventDefault(); }
}, { passive:false });
addEventListener('touchstart', e => { touchY = e.touches[0] ? e.touches[0].clientY : 0; }, { passive:true });
addEventListener('touchmove', e => {
  const y = e.touches[0] ? e.touches[0].clientY : touchY, d = (touchY - y) * 2.2; touchY = y;
  if (locked){ advance(d); e.preventDefault(); return; }
  if (!reduced && ready && d < 0 && scrollY <= 2 && current > 0.001){ engage(); advance(d); e.preventDefault(); }
}, { passive:false });
addEventListener('keydown', e => {
  if (!locked) return;
  if (['ArrowDown','PageDown',' '].includes(e.key)){ advance(220); e.preventDefault(); }
  else if (['ArrowUp','PageUp'].includes(e.key)){ advance(-220); e.preventDefault(); }
  else if (['Escape','End','Tab'].includes(e.key)){ target = 1; release(); }
});
document.querySelectorAll('[data-cloth]').forEach(btn => {
  btn.addEventListener('click', () => {
    const d = btn.dataset;
    if (window.setCloth) window.setCloth(d.cloth, parseFloat(d.rough));
    document.querySelectorAll('[data-cloth]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    const n = document.getElementById('m-cloth'); if (n) n.textContent = d.name;
    const w = document.getElementById('m-weight'); if (w) w.textContent = d.weight;
  });
});

// Any in-page link must release the lock before scrolling. While locked the
// body is position:fixed, so an anchor changes the hash and moves nothing.
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const el = document.querySelector(a.getAttribute('href'));
    if (!el) return;
    e.preventDefault();
    target = 1;
    release();
    requestAnimationFrame(() => el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' }));
  });
});

const skip = document.getElementById('skip');
if (skip) skip.addEventListener('click', () => { target = 1; release(); });

// grab and spin, the way the Sketchfab viewer does
let dragging = false, lastX = 0;
stage.addEventListener('pointerdown', e => { dragging = true; lastX = e.clientX; stage.setPointerCapture(e.pointerId); });
stage.addEventListener('pointermove', e => { if (dragging){ spin += (e.clientX - lastX) * 0.009; lastX = e.clientX; } });
['pointerup','pointercancel'].forEach(ev => stage.addEventListener(ev, () => { dragging = false; }));

// Framing is computed from the model's own bounds rather than hard-coded, so
// no rotation or viewport ratio can crop the collar. The horizontal term uses
// the widest silhouette (arms out), which is what a quarter turn presents.
const fit = { y: 1.2, dist: 5, dolly: 0.3, half: 1.2, wide: 0.9 };
// (fit is read directly by the render loop)

function computeFit(){
  if (!window.__model) return;
  const b = window.__model.bounds;
  if (!b) return;
  const r = stage.getBoundingClientRect();
  const aspect = Math.max(r.width / Math.max(r.height, 1), 0.2);
  const vFov = camera.fov * Math.PI / 180;
  const MARGIN = 1.16;
  const needV = (b.height * MARGIN / 2) / Math.tan(vFov / 2);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const needH = (b.width * MARGIN / 2) / Math.tan(hFov / 2);
  fit.dist = Math.max(needV, needH);
  fit.y = b.centreY;
  fit.dolly = Math.min(0.3, fit.dist * 0.06);
}

function resize(){
  const r = stage.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
addEventListener('resize', () => { resize(); computeFit(); });

const bar = document.getElementById('scrub-bar');
const mRot = document.getElementById('m-rot'), mChap = document.getElementById('m-chap'), mStep = document.getElementById('m-step');
const chapters = [...document.querySelectorAll('[data-chapter]')];
const STEPS = ['Front','Three-quarter','Profile','Back'];
let lastChap = -1;

resize();

// The loop used to redraw forever at full resolution with shadows, including
// while the suit sat still and while it was scrolled far off screen. That is a
// constant GPU load for no visible gain, and it makes the whole page feel heavy.
// Render only when the stage is on screen and something has actually changed.
let onScreen = true;
let dirty = true;
const markDirty = () => { dirty = true; };

new IntersectionObserver(es => {
  es.forEach(e => { onScreen = e.isIntersecting; if (onScreen) markDirty(); });
}, { rootMargin: '120px' }).observe(stage);

const _setCloth = () => markDirty();
['pointerdown','pointermove','pointerup'].forEach(ev => stage.addEventListener(ev, markDirty));
addEventListener('wheel', markDirty, { passive: true });
addEventListener('touchmove', markDirty, { passive: true });
addEventListener('keydown', markDirty);
addEventListener('resize', markDirty);
document.querySelectorAll('[data-cloth]').forEach(b => b.addEventListener('click', markDirty));

(function frame(){
  requestAnimationFrame(frame);

  const settling = Math.abs(target - current) > 0.0004;
  if (settling) markDirty();
  if (!onScreen || !dirty){ return; }
  if (!settling) dirty = false;          // one last frame, then idle

  current += (target - current) * (reduced ? 1 : 0.12);
  const p = current;
  pivot.rotation.y = p * Math.PI * 2 + spin;

  const f = fit;
  camera.position.set(0, f.y, f.dist - f.dolly * Math.sin(p * Math.PI));
  camera.lookAt(0, f.y, 0);

  if (bar) bar.style.transform = `scaleX(${p})`;
  const hint = document.getElementById('hint');
  if (hint) hint.style.opacity = p > 0.01 ? '0' : '1';
  document.querySelector('.nav').classList.toggle('is-stuck', locked ? p > 0.04 : scrollY > 40);

  const deg = Math.round((((pivot.rotation.y * 180/Math.PI) % 360) + 360) % 360);
  if (mRot) mRot.textContent = String(deg).padStart(3,'0') + '°';
  const ch = deg < 45 || deg >= 315 ? 0 : deg < 135 ? 1 : deg < 225 ? 2 : 3;
  if (ch !== lastChap){
    lastChap = ch;
    if (mChap) mChap.textContent = '0' + (ch+1) + ' / 04';
    if (mStep) mStep.textContent = STEPS[ch];
    chapters.forEach((el,i) => el.classList.toggle('is-on', i === ch));
  }

  renderer.render(scene, camera);
})();

if (!reduced) setTimeout(() => { if (ready) engage(); }, 400);
