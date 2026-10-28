/* ═══════════════════════════════════════════════════════════
   Sitara — marketing site runtime
   three.js photo field + GSAP scroll choreography.
   All imagery is generated in-browser: no bundled photos,
   no screenshots, nothing fetched.
   ═══════════════════════════════════════════════════════════ */

import * as THREE from 'three';

const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;
if (gsap && ScrollTrigger) gsap.registerPlugin(ScrollTrigger);

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ACC = [1.0, 0.42, 0.24];

/* ───────────────────────── seeded rng ───────────────────────── */

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

/* ─────────────────── procedural photography ───────────────────
   Painterly abstractions — sky, light, horizon, strata, haze.
   Twelve palette families keep the field varied but of one world.
   ──────────────────────────────────────────────────────────── */

const PALETTES = [
  { sky: [[14, 16, 28], [74, 52, 70], [226, 132, 84]], land: [[20, 18, 24], [44, 32, 34]], sun: [255, 186, 120] },
  { sky: [[10, 14, 22], [36, 62, 92], [150, 192, 214]], land: [[14, 22, 30], [30, 46, 56]], sun: [206, 232, 246] },
  { sky: [[30, 12, 16], [120, 36, 30], [248, 148, 72]], land: [[26, 14, 14], [58, 28, 24]], sun: [255, 168, 96] },
  { sky: [[8, 12, 14], [26, 48, 44], [120, 170, 150]], land: [[10, 18, 18], [24, 40, 36]], sun: [190, 226, 204] },
  { sky: [[18, 14, 26], [62, 40, 86], [198, 148, 214]], land: [[16, 14, 22], [38, 30, 50]], sun: [230, 196, 240] },
  { sky: [[22, 20, 18], [92, 74, 52], [236, 198, 140]], land: [[20, 18, 14], [50, 42, 30]], sun: [252, 226, 176] },
  { sky: [[10, 10, 12], [40, 40, 46], [168, 170, 178]], land: [[14, 14, 16], [34, 34, 38]], sun: [214, 216, 222] },
  { sky: [[12, 18, 30], [28, 78, 104], [122, 198, 206]], land: [[12, 20, 26], [26, 52, 60]], sun: [176, 230, 236] },
  { sky: [[26, 10, 20], [104, 28, 58], [240, 126, 128]], land: [[22, 12, 16], [56, 24, 32]], sun: [255, 162, 150] },
  { sky: [[14, 16, 16], [52, 66, 50], [182, 204, 146]], land: [[14, 18, 14], [34, 44, 30]], sun: [214, 232, 170] },
  { sky: [[16, 14, 12], [86, 52, 30], [242, 166, 88]], land: [[18, 14, 12], [48, 32, 20]], sun: [255, 196, 124] },
  { sky: [[12, 12, 20], [48, 44, 86], [162, 158, 220]], land: [[12, 12, 18], [30, 28, 48]], sun: [200, 198, 244] },
];

const rgb = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a === undefined ? 1 : a})`;

/** Draw one procedural photograph into ctx, filling w×h. */
function drawPhoto(ctx, w, h, seed) {
  const r = rng(seed * 2654435761 + 12345);
  const P = PALETTES[Math.floor(r() * PALETTES.length) % PALETTES.length];
  const horizon = h * (0.42 + r() * 0.3);

  // sky
  const sky = ctx.createLinearGradient(0, 0, w * (r() * 0.4 - 0.2), horizon);
  sky.addColorStop(0, rgb(P.sky[0]));
  sky.addColorStop(0.55 + r() * 0.2, rgb(P.sky[1]));
  sky.addColorStop(1, rgb(P.sky[2]));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // light source
  const sx = w * (0.12 + r() * 0.76);
  const sy = horizon * (0.3 + r() * 0.55);
  const sr = Math.max(w, h) * (0.3 + r() * 0.42);
  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
  glow.addColorStop(0, rgb(P.sun, 0.85));
  glow.addColorStop(0.22, rgb(P.sun, 0.3));
  glow.addColorStop(0.6, rgb(P.sun, 0.07));
  glow.addColorStop(1, rgb(P.sun, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // cloud banding
  const bands = 3 + Math.floor(r() * 5);
  for (let i = 0; i < bands; i++) {
    const by = horizon * (0.1 + r() * 0.85);
    const bh = h * (0.012 + r() * 0.05);
    const g = ctx.createLinearGradient(0, by, 0, by + bh);
    const tint = r() > 0.5 ? P.sun : P.sky[1];
    g.addColorStop(0, rgb(tint, 0));
    g.addColorStop(0.5, rgb(tint, 0.1 + r() * 0.3));
    g.addColorStop(1, rgb(tint, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(w * (r() * 1.2 - 0.1), by + bh / 2, w * (0.25 + r() * 0.55), bh, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // layered strata below the horizon
  const layers = 3 + Math.floor(r() * 3);
  for (let i = 0; i < layers; i++) {
    const t = i / layers;
    const base = horizon + (h - horizon) * t * 0.55;
    const col = [
      Math.round(P.land[0][0] + (P.land[1][0] - P.land[0][0]) * (1 - t)),
      Math.round(P.land[0][1] + (P.land[1][1] - P.land[0][1]) * (1 - t)),
      Math.round(P.land[0][2] + (P.land[1][2] - P.land[0][2]) * (1 - t)),
    ];
    ctx.fillStyle = rgb(col, 0.92 - t * 0.12);
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(0, base + Math.sin(r() * 6.28) * h * 0.02);
    const steps = 5 + Math.floor(r() * 5);
    for (let s = 1; s <= steps; s++) {
      const x = (w * s) / steps;
      const amp = h * (0.012 + 0.07 * (1 - t));
      ctx.lineTo(x, base + Math.sin(s * (1.1 + r() * 2.4) + i) * amp);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  }

  // water / ground reflection of the light
  if (r() > 0.45) {
    const refl = ctx.createLinearGradient(0, horizon, 0, h);
    refl.addColorStop(0, rgb(P.sun, 0.22));
    refl.addColorStop(0.35, rgb(P.sun, 0.05));
    refl.addColorStop(1, rgb(P.sun, 0));
    ctx.fillStyle = refl;
    ctx.fillRect(sx - w * 0.22, horizon, w * 0.44, h - horizon);
  }

  // atmospheric haze across the horizon line
  const haze = ctx.createLinearGradient(0, horizon - h * 0.08, 0, horizon + h * 0.08);
  haze.addColorStop(0, rgb(P.sky[2], 0));
  haze.addColorStop(0.5, rgb(P.sky[2], 0.2));
  haze.addColorStop(1, rgb(P.sky[2], 0));
  ctx.fillStyle = haze;
  ctx.fillRect(0, horizon - h * 0.08, w, h * 0.16);

  // vignette
  const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,.52)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);

  // grain
  const gn = 220 + Math.floor(r() * 500);
  ctx.globalAlpha = 0.045;
  for (let i = 0; i < gn; i++) {
    ctx.fillStyle = r() > 0.5 ? '#fff' : '#000';
    const px = r() * w, py = r() * h, ps = 1 + r() * 2.2;
    ctx.fillRect(px, py, ps, ps);
  }
  ctx.globalAlpha = 1;
}

/** Offscreen photo pool, reused across every canvas on the page. */
const photoPool = [];
function photo(i) {
  const k = i % 24;
  if (!photoPool[k]) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 342;
    drawPhoto(c.getContext('2d'), 512, 342, k + 7);
    photoPool[k] = c;
  }
  return photoPool[k];
}

/* ───────────────────────── boot ───────────────────────── */

const boot = document.getElementById('boot');
const bootBar = document.querySelector('.boot-bar b');
const bootPct = document.getElementById('bootPct');
document.body.classList.add('booting');

let bootVal = 0;
const bootTick = setInterval(() => {
  bootVal = Math.min(92, bootVal + 6 + Math.random() * 14);
  if (bootBar) bootBar.style.width = bootVal + '%';
  if (bootPct) bootPct.textContent = String(Math.round(bootVal)).padStart(2, '0');
}, 90);

let booted = false;
function finishBoot() {
  if (booted) return;
  booted = true;
  clearInterval(bootTick);
  if (bootBar) bootBar.style.width = '100%';
  if (bootPct) bootPct.textContent = '100';
  document.body.classList.remove('booting');
  if (!gsap) { boot.style.display = 'none'; intro(); return; }
  gsap.to(boot, {
    opacity: 0, duration: 0.6, delay: 0.18, ease: 'power2.out',
    onComplete: () => { boot.style.display = 'none'; },
  });
  intro();
}

/* ───────────────────────── webgl field ───────────────────────── */

const VERT = `
precision highp float;
attribute vec3 aCloud;
attribute vec3 aGrid;
attribute vec3 aRot;
attribute vec2 aTile;
attribute vec2 aSizeA;
attribute vec2 aSizeB;
attribute float aRand;

uniform float uProg;
uniform float uTime;
uniform vec2  uMouse;

varying vec2  vUv;
varying vec2  vTile;
varying float vDepth;
varying float vSettle;
varying float vRim;

mat3 rotXYZ(vec3 r){
  float cx=cos(r.x), sx=sin(r.x);
  float cy=cos(r.y), sy=sin(r.y);
  float cz=cos(r.z), sz=sin(r.z);
  mat3 rx = mat3(1.,0.,0., 0.,cx,-sx, 0.,sx,cx);
  mat3 ry = mat3(cy,0.,sy, 0.,1.,0., -sy,0.,cy);
  mat3 rz = mat3(cz,-sz,0., sz,cz,0., 0.,0.,1.);
  return rz * ry * rx;
}

void main(){
  // staggered arrival: each plane settles over its own slice of the scroll
  float t = clamp((uProg - aRand * 0.34) / 0.66, 0.0, 1.0);
  float e = t * t * (3.0 - 2.0 * t);

  vec3 c = aCloud;
  float drift = 1.0 - e;
  c.x += cos(uTime * 0.17 + aRand * 31.4) * 0.42 * drift;
  c.y += sin(uTime * 0.21 + aRand * 17.7) * 0.5  * drift;
  c.z += sin(uTime * 0.13 + aRand * 9.1)  * 0.3  * drift;
  // the cloud leans with the pointer, the grid does not
  c.xy += uMouse * (0.55 + aRand * 0.7) * drift;

  vec3 pos = mix(c, aGrid, e);
  vec2 sz  = mix(aSizeA, aSizeB, e);
  vec3 local = vec3(position.xy * sz, 0.0);
  vec3 world = rotXYZ(aRot * drift) * local + pos;

  vec4 mv = modelViewMatrix * vec4(world, 1.0);

  vUv = uv;
  vTile = aTile;
  vDepth = -mv.z;
  vSettle = e;
  vRim = aRand;

  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
precision highp float;
uniform sampler2D uAtlas;
uniform vec3  uBg;
uniform vec3  uAcc;
uniform float uNear;
uniform float uFar;
uniform float uTime;

varying vec2  vUv;
varying vec2  vTile;
varying float vDepth;
varying float vSettle;
varying float vRim;

void main(){
  // atlas is 4×4; inset a hair to stop neighbours bleeding in
  vec2 uv = vTile + (vUv * 0.994 + 0.003) * 0.25;
  vec3 col = texture2D(uAtlas, uv).rgb;

  vec2 q = abs(vUv - 0.5) * 2.0;
  float edge = max(q.x, q.y);

  // hairline frame, warm on the planes that have settled
  float frame = smoothstep(0.975, 0.999, edge);
  vec3 frameCol = mix(vec3(1.0), uAcc, 0.35 + 0.65 * vSettle);
  col = mix(col, frameCol, frame * (0.22 + 0.4 * vSettle));

  // a few planes carry an accent bloom, like a selection in the app
  float pick = step(0.93, vRim);
  col += uAcc * pick * (0.1 + 0.1 * sin(uTime * 1.4 + vRim * 40.0)) * (1.0 - frame);

  // depth: dissolve into the page background instead of using alpha,
  // so the field stays opaque and sorts correctly
  float fog = clamp((vDepth - uNear) / (uFar - uNear), 0.0, 1.0);
  col = mix(col, uBg, fog * fog);

  // drifting planes sit back a little until they land
  col = mix(col * 0.52, col, 0.45 + 0.55 * vSettle);

  gl_FragColor = vec4(col, 1.0);
}`;

const STAR_FRAG = `
precision highp float;
uniform float uTime;
uniform vec3  uAcc;
uniform float uFade;
varying vec2 vUv;

void main(){
  vec2 p = (vUv - 0.5) * 2.0;
  float d = length(p);
  float a = atan(p.y, p.x);

  // four-pointed star: the mark from the app icon
  float spike = pow(abs(cos(2.0 * a)), 0.42);
  float reach = mix(0.1, 1.0, spike);
  float star = smoothstep(reach, 0.0, d);
  float halo = pow(max(0.0, 1.0 - d), 5.0);
  float core = smoothstep(0.075, 0.0, d);

  float pulse = 0.86 + 0.14 * sin(uTime * 0.85);
  vec3 col = uAcc * (star * 0.5 + halo * 0.42) * pulse + vec3(1.0) * core * 0.5;
  gl_FragColor = vec4(col * uFade, 1.0);
}`;

const STAR_VERT = `
precision highp float;
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const field = { ready: false, visible: true };

function buildField() {
  const canvas = document.getElementById('gl');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    canvas.style.display = 'none';
    return null;
  }
  renderer.setClearColor(0x070708, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 120);
  camera.position.set(0, 0, 5.4);
  scene.add(camera);

  /* atlas: 4×4 procedural photographs */
  const A = document.createElement('canvas');
  A.width = A.height = 2048;
  const actx = A.getContext('2d');
  for (let i = 0; i < 16; i++) {
    const x = (i % 4) * 512, y = Math.floor(i / 4) * 512;
    actx.save();
    actx.translate(x, y);
    actx.beginPath();
    actx.rect(0, 0, 512, 512);
    actx.clip();
    drawPhoto(actx, 512, 512, i * 31 + 3);
    actx.restore();
  }
  const atlas = new THREE.CanvasTexture(A);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.generateMipmaps = true;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  atlas.magFilter = THREE.LinearFilter;
  atlas.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());

  /* justified grid targets — the app's own layout, in 3D */
  const r = rng(99173);
  const ROW_H = 0.92, TOTAL_W = 13.6, ROWS = 11, GAP = 0.055;
  const cells = [];
  for (let row = 0; row < ROWS; row++) {
    const n = 6 + Math.floor(r() * 4);
    const aspects = [];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const a = 0.68 + r() * 0.95;
      aspects.push(a); sum += a;
    }
    const usable = TOTAL_W - GAP * (n - 1);
    const h = usable / sum;
    let x = -TOTAL_W / 2;
    const y = (ROWS / 2 - row - 0.5) * (ROW_H + GAP);
    for (let i = 0; i < n; i++) {
      const w = aspects[i] * h;
      cells.push({ x: x + w / 2, y, w, h: ROW_H });
      x += w + GAP;
    }
  }

  const COUNT = cells.length;
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  geo.instanceCount = COUNT;

  const aCloud = new Float32Array(COUNT * 3);
  const aGrid = new Float32Array(COUNT * 3);
  const aRot = new Float32Array(COUNT * 3);
  const aTile = new Float32Array(COUNT * 2);
  const aSizeA = new Float32Array(COUNT * 2);
  const aSizeB = new Float32Array(COUNT * 2);
  const aRand = new Float32Array(COUNT);

  for (let i = 0; i < COUNT; i++) {
    const c = cells[i];

    // scattered start: a shell of photographs drifting around the camera
    const ang = r() * Math.PI * 2;
    const rad = 2.4 + Math.pow(r(), 0.65) * 11;
    aCloud[i * 3] = Math.cos(ang) * rad * 0.92;
    aCloud[i * 3 + 1] = (r() - 0.5) * 11;
    aCloud[i * 3 + 2] = -22 + r() * 26;

    aGrid[i * 3] = c.x;
    aGrid[i * 3 + 1] = c.y;
    aGrid[i * 3 + 2] = (r() - 0.5) * 0.04;

    aRot[i * 3] = (r() - 0.5) * 1.5;
    aRot[i * 3 + 1] = (r() - 0.5) * 2.2;
    aRot[i * 3 + 2] = (r() - 0.5) * 1.1;

    const t = Math.floor(r() * 16);
    aTile[i * 2] = (t % 4) * 0.25;
    aTile[i * 2 + 1] = Math.floor(t / 4) * 0.25;

    const s = 0.7 + r() * 1.5;
    aSizeA[i * 2] = s * (0.8 + r() * 0.7);
    aSizeA[i * 2 + 1] = s;
    aSizeB[i * 2] = c.w;
    aSizeB[i * 2 + 1] = c.h;

    aRand[i] = r();
  }

  const ia = (arr, n) => new THREE.InstancedBufferAttribute(arr, n);
  geo.setAttribute('aCloud', ia(aCloud, 3));
  geo.setAttribute('aGrid', ia(aGrid, 3));
  geo.setAttribute('aRot', ia(aRot, 3));
  geo.setAttribute('aTile', ia(aTile, 2));
  geo.setAttribute('aSizeA', ia(aSizeA, 2));
  geo.setAttribute('aSizeB', ia(aSizeB, 2));
  geo.setAttribute('aRand', ia(aRand, 1));

  const uni = {
    uProg: { value: 0 },
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector2() },
    uAtlas: { value: atlas },
    uBg: { value: new THREE.Color(0x070708) },
    uAcc: { value: new THREE.Vector3(...ACC) },
    uNear: { value: 7 },
    uFar: { value: 30 },
  };

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: uni, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);

  /* the mark, glowing behind everything */
  const starUni = { uTime: { value: 0 }, uAcc: { value: new THREE.Vector3(...ACC) }, uFade: { value: 1 } };
  const star = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 26),
    new THREE.ShaderMaterial({
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, uniforms: starUni,
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false,
    })
  );
  star.position.z = -16;
  star.renderOrder = -10;
  camera.add(star);

  /* dust */
  const DUST = 900;
  const dpos = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) {
    dpos[i * 3] = (r() - 0.5) * 40;
    dpos[i * 3 + 1] = (r() - 0.5) * 26;
    dpos[i * 3 + 2] = (r() - 0.5) * 40;
  }
  const dgeo = new THREE.BufferGeometry();
  dgeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
  const dust = new THREE.Points(dgeo, new THREE.PointsMaterial({
    size: 0.03, color: 0xffb79a, transparent: true, opacity: 0.4,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  }));
  scene.add(dust);

  const state = { camZ: 5.4, camY: 0, rotX: 0, rotY: 0, starFade: 1 };
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // keep the assembled grid framed on narrow screens
    const need = TOTAL_W / 2 / Math.tan((camera.fov * Math.PI / 180) / 2) / camera.aspect;
    state.gridZ = Math.max(9.4, need * 1.02);
    camera.updateProjectionMatrix();
  }
  resize();

  const clock = new THREE.Clock();
  function frame() {
    const t = clock.getElapsedTime();
    uni.uTime.value = t;
    starUni.uTime.value = t;
    starUni.uFade.value = state.starFade;

    pointer.x += (pointer.tx - pointer.x) * 0.055;
    pointer.y += (pointer.ty - pointer.y) * 0.055;
    uni.uMouse.value.set(pointer.x, pointer.y);

    camera.position.z = state.camZ;
    camera.position.y = state.camY;
    camera.position.x = pointer.x * 0.5 * (1 - uni.uProg.value * 0.7);
    camera.rotation.y = state.rotY + pointer.x * 0.045;
    camera.rotation.x = state.rotX - pointer.y * 0.035;

    dust.rotation.y = t * 0.012;
    dust.position.z = ((t * 0.35) % 8) - 4;

    renderer.render(scene, camera);
  }

  window.addEventListener('resize', () => { resize(); if (!field.visible) frame(); }, { passive: true });
  window.addEventListener('pointermove', (e) => {
    pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2;
    pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  field.ready = true;
  return { renderer, uni, state, frame, resize };
}

/* ───────────────────────── split text ───────────────────────── */

function split(el) {
  const words = el.textContent.split(/(\s+)/);
  el.textContent = '';
  const out = [];
  for (const w of words) {
    if (!w) continue;
    if (/^\s+$/.test(w)) { el.appendChild(document.createTextNode(' ')); continue; }
    const wrap = document.createElement('span');
    wrap.className = 'word';
    for (const ch of w) {
      const c = document.createElement('span');
      c.className = 'char';
      c.textContent = ch;
      wrap.appendChild(c);
      out.push(c);
    }
    el.appendChild(wrap);
  }
  return out;
}

/* ───────────────────────── intro ───────────────────────── */

function intro() {
  const heroChars = [];
  document.querySelectorAll('[data-split]').forEach((el) => {
    const chars = split(el);
    if (el.closest('#hero')) heroChars.push(...chars);
    else el.__chars = chars;
  });

  if (!gsap || REDUCED) {
    document.querySelectorAll('.reveal').forEach((e) => { e.style.opacity = 1; e.style.transform = 'none'; });
    document.querySelectorAll('.step').forEach((e) => { e.style.opacity = 1; e.style.transform = 'none'; });
    return;
  }

  gsap.timeline({ delay: 0.1 })
    .from(heroChars, {
      yPercent: 115, rotate: 5, opacity: 0, duration: 1.05,
      ease: 'expo.out', stagger: { each: 0.016, from: 'start' },
    })
    .fromTo('#hero .reveal',
      { y: 26, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.9, ease: 'power3.out', stagger: 0.09 }, 0.35)
    .from('#nav', { y: -24, opacity: 0, duration: 0.8, ease: 'power3.out' }, 0.2)
    .from('.scroll-cue, .hero-edge', { opacity: 0, duration: 0.8, ease: 'power2.out' }, 0.9);
}

/* ───────────────────────── scroll choreography ───────────────────────── */

function choreograph(fieldApi) {
  if (!gsap || !ScrollTrigger) return;

  /* nav + progress */
  const bar = document.querySelector('#progress b');
  ScrollTrigger.create({
    start: 0, end: 'max',
    onUpdate: (self) => { if (bar) bar.style.width = (self.progress * 100).toFixed(2) + '%'; },
  });
  ScrollTrigger.create({
    start: 'top -40px', end: 'max',
    onToggle: (self) => document.getElementById('nav').classList.toggle('stuck', self.isActive),
  });

  if (REDUCED) {
    if (fieldApi) { fieldApi.uni.uProg.value = 1; fieldApi.state.camZ = fieldApi.state.gridZ || 10; fieldApi.frame(); }
    gsap.utils.toArray('.reveal').forEach((e) => gsap.set(e, { opacity: 1, y: 0 }));
    return;
  }

  /* generic reveals */
  gsap.utils.toArray('.reveal:not(#hero .reveal), .sec-note').forEach((el) => {
    gsap.fromTo(el,
      { y: 28, opacity: 0 },
      { y: 0, opacity: 1, duration: 1, ease: 'power3.out',
        scrollTrigger: { trigger: el, start: 'top 88%' } });
  });

  /* headline splits outside the hero */
  gsap.utils.toArray('[data-split]').forEach((el) => {
    if (!el.__chars) return;
    gsap.fromTo(el.__chars,
      { yPercent: 110, opacity: 0 },
      { yPercent: 0, opacity: 1, duration: 0.9, ease: 'expo.out',
        stagger: { each: 0.014 },
        scrollTrigger: { trigger: el, start: 'top 90%' } });
  });

  /* ghost numerals drift */
  gsap.utils.toArray('.ghost').forEach((g) => {
    gsap.fromTo(g, { yPercent: -8 }, {
      yPercent: 14, ease: 'none',
      scrollTrigger: { trigger: g.closest('section'), start: 'top bottom', end: 'bottom top', scrub: true },
    });
  });

  /* hero exit */
  gsap.to('.hero-in', {
    y: -90, opacity: 0, ease: 'none',
    scrollTrigger: { trigger: '#hero', start: 'top top', end: 'bottom 30%', scrub: true },
  });
  gsap.to('.scroll-cue', {
    opacity: 0, ease: 'none',
    scrollTrigger: { trigger: '#hero', start: 'top top', end: '18% top', scrub: true },
  });

  /* ── the field assembles across #scene ── */
  if (fieldApi) {
    const { uni, state } = fieldApi;
    gsap.timeline({
      scrollTrigger: {
        trigger: '#scene', start: 'top bottom', end: 'bottom bottom',
        scrub: 1, invalidateOnRefresh: true,
      },
    })
      .to(uni.uProg, { value: 1, duration: 0.72, ease: 'none' }, 0)
      .to(state, { camZ: () => state.gridZ || 10.2, duration: 0.72, ease: 'power1.inOut' }, 0)
      .to(state, { starFade: 0.25, duration: 0.5, ease: 'none' }, 0)
      .to(uni.uNear, { value: 11, duration: 0.72, ease: 'none' }, 0);
  }

  // past the field, the scrim goes solid and the loop idles
  ScrollTrigger.create({
    trigger: '.marquee', start: 'top 25%', end: 99999999,
    onToggle: (self) => {
      document.body.classList.toggle('past-scene', self.isActive);
      field.visible = !self.isActive;
    },
  });

  /* scene steps */
  const steps = gsap.utils.toArray('.step');
  const stl = gsap.timeline({
    scrollTrigger: { trigger: '#scene', start: 'top top', end: 'bottom bottom', scrub: 0.6 },
  });
  steps.forEach((s, i) => {
    stl.fromTo(s, { opacity: 0, y: 34 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power2.out' }, i * 1.1 + 0.15);
    if (i < steps.length - 1) stl.to(s, { opacity: 0, y: -30, duration: 0.5, ease: 'power2.in' }, i * 1.1 + 0.85);
  });
  stl.to({}, { duration: 0.5 });

  /* ── horizontal library rail ── */
  const track = document.querySelector('.rail-track');
  if (track && window.innerWidth > 760) {
    const dist = () => Math.max(0, track.scrollWidth - window.innerWidth + 90);
    gsap.to(track, {
      x: () => -dist(), ease: 'none',
      scrollTrigger: {
        trigger: '#library', start: 'top top', end: () => '+=' + (dist() + window.innerHeight * 0.5),
        pin: true, scrub: 1, anticipatePin: 1, invalidateOnRefresh: true,
      },
    });
    gsap.fromTo('[data-card]',
      { y: 60, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.9, ease: 'power3.out', stagger: 0.07,
        scrollTrigger: { trigger: '#library', start: 'top 60%' } });
  } else if (track) {
    gsap.fromTo('[data-card]',
      { y: 40, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.8, ease: 'power3.out', stagger: 0.08,
        scrollTrigger: { trigger: '.rail-wrap', start: 'top 85%' } });
  }

  /* marquee */
  const mq = document.querySelector('.marquee-in');
  if (mq) {
    mq.innerHTML += mq.innerHTML;
    const w = mq.scrollWidth / 2;
    gsap.fromTo(mq, { x: 0 }, { x: -w, duration: 26, ease: 'none', repeat: -1 });
  }

  /* editor mock */
  gsap.fromTo('[data-mock="editor"]',
    { y: 70, opacity: 0, rotateX: 9 },
    { y: 0, opacity: 1, rotateX: 0, duration: 1.2, ease: 'power3.out',
      scrollTrigger: { trigger: '#editor', start: 'top 70%' } });
  gsap.to('[data-mock="editor"]', {
    y: -40, ease: 'none',
    scrollTrigger: { trigger: '#editor', start: 'top bottom', end: 'bottom top', scrub: true },
  });

  /* ai cards + gpu bars */
  gsap.fromTo('[data-tilt]',
    { y: 50, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.85, ease: 'power3.out', stagger: 0.05,
      scrollTrigger: { trigger: '.ai-grid', start: 'top 82%' } });
  gsap.utils.toArray('.bar b').forEach((b) => {
    gsap.to(b, {
      width: b.dataset.w + '%', duration: 1.4, ease: 'expo.out',
      scrollTrigger: { trigger: '.gpu', start: 'top 75%' },
    });
  });

  /* privacy, keys, roadmap, platforms */
  gsap.fromTo('.pc',
    { y: 40, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.8, ease: 'power3.out', stagger: 0.07,
      scrollTrigger: { trigger: '.priv-cards', start: 'top 85%' } });
  gsap.fromTo('.priv-diagram > *',
    { opacity: 0, scale: 0.94 },
    { opacity: 1, scale: 1, duration: 0.9, ease: 'power3.out', stagger: 0.12,
      scrollTrigger: { trigger: '.priv-diagram', start: 'top 82%' } });
  gsap.fromTo('.kg',
    { y: 44, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.85, ease: 'power3.out', stagger: 0.08,
      scrollTrigger: { trigger: '.keys-grid', start: 'top 84%' } });
  gsap.fromTo('.road li',
    { x: -34, opacity: 0 },
    { x: 0, opacity: 1, duration: 0.8, ease: 'power3.out', stagger: 0.07,
      scrollTrigger: { trigger: '.road', start: 'top 82%' } });
  gsap.fromTo('.pcard',
    { y: 54, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.9, ease: 'power3.out', stagger: 0.09,
      scrollTrigger: { trigger: '.plat', start: 'top 85%' } });
  gsap.fromTo('.verify',
    { y: 30, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.8, ease: 'power3.out',
      scrollTrigger: { trigger: '.verify', start: 'top 92%' } });

  /* counters */
  gsap.utils.toArray('[data-count]').forEach((el) => {
    const end = parseFloat(el.dataset.count);
    const pre = el.dataset.pre || '';
    const post = el.dataset.post || '';
    const o = { v: 0 };
    gsap.to(o, {
      v: end, duration: 1.8, ease: 'expo.out',
      scrollTrigger: { trigger: el, start: 'top 92%' },
      onUpdate: () => { el.textContent = pre + Math.round(o.v) + post; },
    });
  });
}

/* ───────────────────────── card artwork ───────────────────────── */

function paint(canvas, draw) {
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = Math.max(240, Math.round(rect.width));
  const h = Math.max(140, Math.round(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#0a0a0c';
  ctx.fillRect(0, 0, w, h);
  draw(ctx, w, h);
}

function cover(ctx, img, x, y, w, h, radius) {
  ctx.save();
  if (radius) {
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, h, radius) : ctx.rect(x, y, w, h);
    ctx.clip();
  } else {
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  }
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s, dh = img.height * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

const ART = {
  timeline(ctx, w, h) {
    const pad = 10, railW = 22;
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.font = '600 9px "Geist Mono", monospace';
    ctx.fillText('AUGUST 2025', pad, pad + 8);
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    ctx.fillText('1,284', w - railW - 34, pad + 8);

    const top = pad + 18, gap = 3;
    const avail = w - pad * 2 - railW;
    let y = top, k = 0;
    const r = rng(4242);
    while (y < h - pad) {
      const n = 3 + Math.floor(r() * 2);
      const aspects = [];
      let sum = 0;
      for (let i = 0; i < n; i++) { const a = 0.7 + r() * 0.9; aspects.push(a); sum += a; }
      const rh = (avail - gap * (n - 1)) / sum;
      if (y + rh > h - pad) break;
      let x = pad;
      for (let i = 0; i < n; i++) {
        const cw = aspects[i] * rh;
        cover(ctx, photo(k++), x, y, cw, rh, 3);
        x += cw + gap;
      }
      y += rh + gap;
    }

    // year rail
    const rx = w - pad - railW + 8;
    ctx.font = '500 7px "Geist Mono", monospace';
    const years = ['25', '24', '23', '22', '21'];
    years.forEach((yr, i) => {
      const yy = top + 6 + i * ((h - top - pad) / years.length);
      ctx.fillStyle = i === 0 ? '#ff6b3d' : 'rgba(255,255,255,.3)';
      ctx.fillText(yr, rx, yy);
      ctx.fillRect(rx + 12, yy - 3, i === 0 ? 8 : 4, i === 0 ? 2 : 1);
    });
  },

  viewer(ctx, w, h) {
    cover(ctx, photo(3), 0, 0, w, h, 0);
    const g = ctx.createLinearGradient(0, h * 0.4, 0, h);
    g.addColorStop(0, 'rgba(7,7,8,0)');
    g.addColorStop(1, 'rgba(7,7,8,.92)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // histogram panel
    const pw = 76, ph = 40, px = w - pw - 10, py = 10;
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.strokeStyle = 'rgba(255,255,255,.1)';
    ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.fill(); ctx.stroke();
    const r = rng(77);
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    for (let i = 0; i < 34; i++) {
      const t = i / 34;
      const v = Math.exp(-Math.pow((t - 0.45) * 3.1, 2)) * (0.65 + r() * 0.35);
      ctx.fillRect(px + 4 + i * 2.1, py + ph - 4 - v * (ph - 10), 1.6, v * (ph - 10));
    }

    // exif chips
    const chips = ['ƒ/1.8', '1/250', 'ISO 400', '35 mm'];
    ctx.font = '400 7.5px "Geist Mono", monospace';
    let cx = 10;
    chips.forEach((c) => {
      const cwid = ctx.measureText(c).width + 12;
      ctx.fillStyle = 'rgba(255,255,255,.08)';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(cx, h - 24, cwid, 15, 7) : ctx.rect(cx, h - 24, cwid, 15);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.72)';
      ctx.fillText(c, cx + 6, h - 13.5);
      cx += cwid + 5;
    });

    // palette swatches
    const sw = ['#2a1a16', '#6d3a26', '#c87a4a', '#f0c49a'];
    sw.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(w - 18 - i * 15, h - 17, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.stroke();
    });
  },

  slideshow(ctx, w, h) {
    cover(ctx, photo(8), 0, 0, w, h, 0);
    ctx.fillStyle = 'rgba(7,7,8,.4)';
    ctx.fillRect(0, 0, w, h);

    // ken burns frame
    ctx.strokeStyle = 'rgba(255,255,255,.4)';
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(w * 0.14, h * 0.16, w * 0.62, h * 0.56);
    ctx.setLineDash([]);
    ctx.strokeStyle = '#ff6b3d';
    ctx.strokeRect(w * 0.26, h * 0.3, w * 0.5, h * 0.44);

    // caption
    ctx.font = '600 11px Geist, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.fillText('Ken Burns', 12, h - 40);
    ctx.font = '400 7.5px "Geist Mono", monospace';
    ctx.fillStyle = '#ff6b3d';
    ctx.fillText('AUTO · CUTS ON THE BEAT', 12, h - 28);

    // waveform + progress
    const r = rng(1212);
    const bw = w - 24;
    for (let i = 0; i < 44; i++) {
      const v = (0.25 + r() * 0.75) * 11;
      ctx.fillStyle = i < 26 ? 'rgba(255,107,61,.9)' : 'rgba(255,255,255,.22)';
      ctx.fillRect(12 + i * (bw / 44), h - 16 - v / 2, bw / 44 - 1.6, v);
    }
  },

  albums(ctx, w, h) {
    const pad = 10;
    const cw = (w - pad * 3) / 2, chh = (h - pad * 3) / 2;
    const labels = [['Trips', '12 places'], ['Places', '38 cities'], ['Favorites', '610'], ['Night', '204']];
    labels.forEach((L, i) => {
      const x = pad + (i % 2) * (cw + pad);
      const y = pad + Math.floor(i / 2) * (chh + pad);
      cover(ctx, photo(i * 5 + 2), x, y, cw, chh, 6);
      const g = ctx.createLinearGradient(0, y + chh * 0.35, 0, y + chh);
      g.addColorStop(0, 'rgba(7,7,8,0)');
      g.addColorStop(1, 'rgba(7,7,8,.9)');
      ctx.save();
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, cw, chh, 6) : ctx.rect(x, y, cw, chh);
      ctx.clip();
      ctx.fillStyle = g;
      ctx.fillRect(x, y, cw, chh);
      ctx.restore();
      ctx.font = '600 10px Geist, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,.96)';
      ctx.fillText(L[0], x + 8, y + chh - 16);
      ctx.font = '400 7px "Geist Mono", monospace';
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.fillText(L[1].toUpperCase(), x + 8, y + chh - 7);
      if (i === 0) {
        ctx.strokeStyle = '#ff6b3d';
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x + 0.5, y + 0.5, cw - 1, chh - 1, 6) : ctx.rect(x, y, cw, chh);
        ctx.stroke();
      }
    });
  },

  cleanup(ctx, w, h) {
    const pad = 10;
    const n = 4, gap = 6;
    const cw = (w - pad * 2 - gap * (n - 1)) / n;
    const chh = Math.min(h - pad * 2 - 26, cw * 1.3);
    ctx.font = '400 7.5px "Geist Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,.4)';
    ctx.fillText('SIMILAR SHOTS · 4 IN GROUP', pad, pad + 7);

    for (let i = 0; i < n; i++) {
      const x = pad + i * (cw + gap);
      const y = pad + 14;
      cover(ctx, photo(6), x, y, cw, chh, 5);
      if (i === 1) {
        ctx.strokeStyle = '#ff6b3d'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x + 0.75, y + 0.75, cw - 1.5, chh - 1.5, 5) : ctx.rect(x, y, cw, chh);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = '#ff6b3d';
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x + 4, y + 4, 30, 12, 6) : ctx.rect(x + 4, y + 4, 30, 12);
        ctx.fill();
        ctx.fillStyle = '#150904';
        ctx.font = '600 7px "Geist Mono", monospace';
        ctx.fillText('BEST', x + 9, y + 12.5);
      } else {
        ctx.fillStyle = 'rgba(7,7,8,.55)';
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x, y, cw, chh, 5) : ctx.rect(x, y, cw, chh);
        ctx.fill();
        // marked for the bin
        ctx.strokeStyle = 'rgba(255,255,255,.4)';
        ctx.beginPath();
        ctx.arc(x + cw / 2, y + chh / 2, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + cw / 2 - 3, y + chh / 2 - 3);
        ctx.lineTo(x + cw / 2 + 3, y + chh / 2 + 3);
        ctx.moveTo(x + cw / 2 + 3, y + chh / 2 - 3);
        ctx.lineTo(x + cw / 2 - 3, y + chh / 2 + 3);
        ctx.stroke();
      }
    }

    ctx.font = '400 7.5px "Geist Mono", monospace';
    ctx.fillStyle = 'rgba(255,255,255,.34)';
    ctx.fillText('ENTER RECYCLES 3 · UNDO AVAILABLE', pad, h - pad);
  },
};

function buildArt() {
  document.querySelectorAll('.card-art').forEach((host) => {
    const kind = host.dataset.art;
    if (!ART[kind]) return;
    const c = document.createElement('canvas');
    host.appendChild(c);
    paint(c, ART[kind]);
  });
}

/* ───────────────────────── editor mock ───────────────────────── */

const SLIDERS = [
  ['Exposure', 0.35, 62], ['Contrast', 18, 70], ['Highlights', -24, 36],
  ['Shadows', 31, 74], ['Temperature', 240, 78], ['Vibrance', 22, 68],
  ['Clarity', 14, 60], ['Dehaze', 8, 55], ['Vignette', -18, 40],
];

function buildEditor() {
  const mock = document.querySelector('[data-mock="editor"]');
  if (!mock) return;

  /* imagery: one source, developed two ways */
  const after = mock.querySelector('.ba-after');
  const before = mock.querySelector('.ba-before');
  const W = 760, H = 500;
  const src = document.createElement('canvas');
  src.width = W; src.height = H;
  drawPhoto(src.getContext('2d'), W, H, 5);

  const actx = after.getContext('2d', { willReadFrequently: true });
  const bctx = before.getContext('2d', { willReadFrequently: true });
  actx.drawImage(src, 0, 0);
  bctx.drawImage(src, 0, 0);

  // "before": flat, cool, low contrast — an undeveloped RAW
  const bd = bctx.getImageData(0, 0, W, H);
  const p = bd.data;
  for (let i = 0; i < p.length; i += 4) {
    const lum = p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114;
    for (let c = 0; c < 3; c++) {
      let v = p[i + c];
      v = lum + (v - lum) * 0.52;            // desaturate
      v = 128 + (v - 128) * 0.68 + 26;       // flatten + lift
      if (c === 0) v -= 10; else if (c === 2) v += 12;  // cool it off
      p[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  bctx.putImageData(bd, 0, 0);

  // "after": graded
  const ad = actx.getImageData(0, 0, W, H);
  const q = ad.data;
  for (let i = 0; i < q.length; i += 4) {
    const lum = q[i] * 0.299 + q[i + 1] * 0.587 + q[i + 2] * 0.114;
    for (let c = 0; c < 3; c++) {
      let v = q[i + c] / 255;
      v = v * 1.08;                                  // exposure
      v = v < 0.5 ? 2 * v * v : 1 - 2 * (1 - v) * (1 - v); // contrast
      v = Math.pow(v, 0.94);
      let o = v * 255;
      o = lum + (o - lum) * 1.22;                    // vibrance
      if (c === 0) o += 9; else if (c === 2) o -= 7; // warm it up
      q[i + c] = o < 0 ? 0 : o > 255 ? 255 : o;
    }
  }
  actx.putImageData(ad, 0, 0);

  /* histogram from the graded frame */
  const hc = mock.querySelector('.mock-hist canvas');
  if (hc) {
    const bins = new Float32Array(48);
    const d = actx.getImageData(0, 0, W, H).data;
    for (let i = 0; i < d.length; i += 4 * 17) {
      const l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
      bins[Math.min(47, Math.floor(l * 48))]++;
    }
    let max = 0;
    for (const v of bins) max = Math.max(max, v);
    const hx = hc.getContext('2d');
    hc.width = 220; hc.height = 64;
    hx.clearRect(0, 0, 220, 64);
    hx.fillStyle = 'rgba(255,255,255,.62)';
    bins.forEach((v, i) => {
      const bh = (v / (max || 1)) * 56;
      hx.fillRect(2 + i * 4.5, 62 - bh, 3.4, bh);
    });
  }

  /* slider rows */
  const host = mock.querySelector('.sliders');
  SLIDERS.forEach(([name, val, pct]) => {
    const row = document.createElement('div');
    row.className = 'sl-row';
    row.innerHTML =
      `<div class="sl-top"><span>${name}</span><b>${val > 0 ? '+' : ''}${val}</b></div>` +
      `<div class="sl-track"><b></b><i></i></div>`;
    host.appendChild(row);
    const fill = row.querySelector('.sl-track b');
    const knob = row.querySelector('.sl-track i');
    const from = Math.min(50, pct), to = pct;
    fill.style.left = Math.min(from, 50) + '%';
    fill.style.width = Math.abs(50 - from) + '%';
    knob.style.left = from + '%';
    row.__set = (v) => {
      fill.style.left = Math.min(v, 50) + '%';
      fill.style.width = Math.abs(50 - v) + '%';
      knob.style.left = v + '%';
    };
    row.__to = to;
  });

  if (gsap && ScrollTrigger && !REDUCED) {
    gsap.utils.toArray('.sl-row').forEach((row, i) => {
      const o = { v: 50 };
      gsap.to(o, {
        v: row.__to, duration: 1.1, ease: 'expo.out', delay: i * 0.05,
        scrollTrigger: { trigger: mock, start: 'top 72%' },
        onUpdate: () => row.__set(o.v),
      });
    });
  } else {
    document.querySelectorAll('.sl-row').forEach((row) => row.__set(row.__to));
  }

  /* before/after split */
  const stage = mock.querySelector('.mock-stage');
  const handle = mock.querySelector('.ba-handle');
  let pos = 55;
  const apply = (v) => {
    pos = Math.max(2, Math.min(98, v));
    before.style.clipPath = `inset(0 ${100 - pos}% 0 0)`;
    handle.style.left = pos + '%';
    handle.setAttribute('aria-valuenow', Math.round(pos));
  };
  apply(pos);

  let dragging = false;
  const fromEvent = (e) => {
    const r = stage.getBoundingClientRect();
    apply(((e.clientX - r.left) / r.width) * 100);
  };
  stage.addEventListener('pointerdown', (e) => { dragging = true; stage.setPointerCapture(e.pointerId); fromEvent(e); });
  stage.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
  stage.addEventListener('pointerup', () => { dragging = false; });
  stage.addEventListener('pointercancel', () => { dragging = false; });
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { apply(pos - 4); e.preventDefault(); }
    if (e.key === 'ArrowRight') { apply(pos + 4); e.preventDefault(); }
  });

  // one unprompted sweep when it first scrolls in, so the control explains itself
  if (gsap && ScrollTrigger && !REDUCED) {
    ScrollTrigger.create({
      trigger: mock, start: 'top 68%', once: true,
      onEnter: () => {
        const o = { v: 55 };
        gsap.timeline({ delay: 0.5 })
          .to(o, { v: 16, duration: 1.1, ease: 'power2.inOut', onUpdate: () => { if (!dragging) apply(o.v); } })
          .to(o, { v: 55, duration: 1.3, ease: 'power2.inOut', onUpdate: () => { if (!dragging) apply(o.v); } });
      },
    });
  }
}

/* ───────────────────────── AI prompt typing ───────────────────────── */

const PROMPTS = [
  { text: 'warmer, a bit moodier, bluer sky', chips: ['temperature +240', 'vibrance +18', 'sky mask', 'saturation +22'] },
  { text: 'brighten her face and blur the background', chips: ['face mask', 'exposure +0.4', 'subject mask', 'lens blur 38'] },
  { text: 'restore this 1974 print', chips: ['denoise', 'face restoration', 'colourise', 'upscale ×4'] },
  { text: 'remove the sign on the left', chips: ['brush mask', 'object removal', 'inpaint'] },
];

function buildPrompt() {
  const out = document.getElementById('typed');
  const chipHost = document.getElementById('chips');
  if (!out || !chipHost) return;

  if (REDUCED || !gsap) {
    out.textContent = PROMPTS[0].text;
    PROMPTS[0].chips.forEach((c) => {
      const s = document.createElement('span');
      s.className = 'chip' + (c.includes('mask') ? ' mask' : '');
      s.textContent = c;
      chipHost.appendChild(s);
    });
    return;
  }

  let idx = 0, running = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function cycle() {
    running = true;
    for (;;) {
      const p = PROMPTS[idx % PROMPTS.length];
      chipHost.innerHTML = '';
      out.textContent = '';
      for (let i = 0; i < p.text.length; i++) {
        out.textContent = p.text.slice(0, i + 1);
        await sleep(26 + Math.random() * 48);
      }
      await sleep(340);
      for (const c of p.chips) {
        const s = document.createElement('span');
        s.className = 'chip' + (c.includes('mask') ? ' mask' : '');
        s.textContent = c;
        chipHost.appendChild(s);
        gsap.from(s, { y: 10, opacity: 0, scale: 0.9, duration: 0.4, ease: 'back.out(2)' });
        await sleep(130);
      }
      await sleep(2600);
      await gsap.to([out, chipHost], { opacity: 0, duration: 0.3 }).then();
      gsap.set([out, chipHost], { opacity: 1 });
      idx++;
    }
  }

  if (ScrollTrigger) {
    ScrollTrigger.create({
      trigger: '.prompt-box', start: 'top 85%', once: true,
      onEnter: () => { if (!running) cycle(); },
    });
  } else {
    cycle();
  }
}

/* ───────────────────────── small interactions ───────────────────────── */

function interactions() {
  /* custom cursor + magnetic targets */
  const fine = window.matchMedia('(pointer: fine)').matches;
  const cur = document.getElementById('cursor');
  if (fine && !REDUCED && gsap) {
    document.body.classList.add('fine-pointer');
    const qx = gsap.quickTo(cur, 'x', { duration: 0.22, ease: 'power3' });
    const qy = gsap.quickTo(cur, 'y', { duration: 0.22, ease: 'power3' });
    window.addEventListener('pointermove', (e) => { qx(e.clientX); qy(e.clientY); }, { passive: true });

    document.querySelectorAll('[data-mag], button, summary').forEach((el) => {
      el.addEventListener('pointerenter', () => cur.classList.add('on'));
      el.addEventListener('pointerleave', () => cur.classList.remove('on'));
    });

    document.querySelectorAll('[data-mag]').forEach((el) => {
      const mx = gsap.quickTo(el, 'x', { duration: 0.4, ease: 'power3' });
      const my = gsap.quickTo(el, 'y', { duration: 0.4, ease: 'power3' });
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        mx((e.clientX - (r.left + r.width / 2)) * 0.18);
        my((e.clientY - (r.top + r.height / 2)) * 0.22);
      });
      el.addEventListener('pointerleave', () => { mx(0); my(0); });
    });

    /* card tilt */
    document.querySelectorAll('[data-tilt]').forEach((el) => {
      const rx = gsap.quickTo(el, 'rotateX', { duration: 0.5, ease: 'power3' });
      const ry = gsap.quickTo(el, 'rotateY', { duration: 0.5, ease: 'power3' });
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        ry(((e.clientX - (r.left + r.width / 2)) / r.width) * 11);
        rx(-((e.clientY - (r.top + r.height / 2)) / r.height) * 11);
      });
      el.addEventListener('pointerleave', () => { rx(0); ry(0); });
    });
  }

  /* copy buttons */
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        const was = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('done');
        setTimeout(() => { btn.textContent = was; btn.classList.remove('done'); }, 1800);
      } catch (_) {
        btn.textContent = 'Press ⌘C';
      }
    });
  });

  /* accordion keeps one open and re-measures the scroll */
  document.querySelectorAll('.acc-list details').forEach((d) => {
    d.addEventListener('toggle', () => {
      if (d.open) {
        d.parentElement.querySelectorAll('details').forEach((o) => { if (o !== d) o.open = false; });
      }
      if (ScrollTrigger) ScrollTrigger.refresh();
    });
  });

  /* anchor scrolling that respects the fixed nav */
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (!id || id === '#') return;
      const t = document.querySelector(id);
      if (!t) return;
      e.preventDefault();
      const y = t.getBoundingClientRect().top + window.scrollY - 84;
      window.scrollTo({ top: y, behavior: REDUCED ? 'auto' : 'smooth' });
    });
  });
}

/* ───────────────────────── go ───────────────────────── */

let api = null;
try {
  api = buildField();
} catch (err) {
  console.warn('[sitara] WebGL field unavailable:', err);
  const c = document.getElementById('gl');
  if (c) c.style.display = 'none';
}

buildEditor();
buildPrompt();
interactions();
choreograph(api);

/* render loop — only while the field is on screen */
if (api) {
  if (REDUCED) {
    api.uni.uProg.value = 1;
    api.state.camZ = api.state.gridZ || 10.2;
    api.state.starFade = 0.3;
    api.frame();
  } else {
    const loop = () => {
      if (field.visible) api.frame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

/* fonts and layout settled → drop the curtain */
let painted = false;
const done = () => {
  if (!painted) { painted = true; buildArt(); }
  if (ScrollTrigger) ScrollTrigger.refresh();
  finishBoot();
};
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => setTimeout(done, 120));
  setTimeout(done, 2600); // never hold the page hostage to a font
} else {
  window.addEventListener('load', done);
  setTimeout(done, 2600);
}

window.addEventListener('load', () => { if (ScrollTrigger) ScrollTrigger.refresh(); });
