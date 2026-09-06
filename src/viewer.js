import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const stage = document.getElementById('stage');
const canvas = document.getElementById('gl');

const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.5; key.shadow.camera.far = 24;
key.shadow.camera.left = -3; key.shadow.camera.right = 3;
key.shadow.camera.top = 4; key.shadow.camera.bottom = -1;
key.shadow.radius = 5; key.shadow.bias = -0.0012;
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
      // ratio of this pixel's brightness to the cloth's average, so relative
      // shading is preserved while absolute lightness comes from the target
      const k = Math.min(st.lum[p] / st.mean, 2.2);
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
  };

  report.size = [size.x.toFixed(2), size.y.toFixed(2), size.z.toFixed(2)];
  report.scale = s.toFixed(3);
  report.materials = mats.map(m => ({ name: m.name, tex: m.userData.texName, rough: m.roughness, metal: m.metalness }));
  report.meshes = [];
  root.traverse(o => { if (o.isMesh) report.meshes.push(o.name); });
  window.__model = { root, mats, report };

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
const SCRUB = 2600;
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

const skip = document.getElementById('skip');
if (skip) skip.addEventListener('click', () => { target = 1; release(); });

// grab and spin, the way the Sketchfab viewer does
let dragging = false, lastX = 0;
stage.addEventListener('pointerdown', e => { dragging = true; lastX = e.clientX; stage.setPointerCapture(e.pointerId); });
stage.addEventListener('pointermove', e => { if (dragging){ spin += (e.clientX - lastX) * 0.009; lastX = e.clientX; } });
['pointerup','pointercancel'].forEach(ev => stage.addEventListener(ev, () => { dragging = false; }));

function resize(){
  const r = stage.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

const bar = document.getElementById('scrub-bar');
const mRot = document.getElementById('m-rot'), mChap = document.getElementById('m-chap'), mStep = document.getElementById('m-step');
const chapters = [...document.querySelectorAll('[data-chapter]')];
const STEPS = ['Front','Three-quarter','Profile','Back'];
let lastChap = -1;

resize();
(function frame(){
  current += (target - current) * (reduced ? 1 : 0.12);
  const p = current;
  pivot.rotation.y = p * Math.PI * 2 + spin;

  camera.position.set(0, 1.26, 4.62 - 0.30 * Math.sin(p * Math.PI));
  camera.lookAt(0, 1.10, 0);

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
  requestAnimationFrame(frame);
})();

if (!reduced) setTimeout(() => { if (ready) engage(); }, 400);
