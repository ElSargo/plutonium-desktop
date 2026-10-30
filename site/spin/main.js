// Pluto as a flat illustration: a big cartoon planet that stays where it is and turns half way round for each
// stop. Each stop's scene covers the whole planet; during a turn both are drawn, the new one spreading out from
// its middle as that comes round, blended into the old along a soft edge, and the props of each cut off there.
// The page scrolls; a chapter reaching the reading line turns the planet to its scene.
import * as THREE from './vendor/three.module.js';

const D2R = Math.PI / 180;
const dir = (lat, lon) => new THREE.Vector3(Math.cos(lat * D2R) * Math.sin(lon * D2R), Math.sin(lat * D2R), Math.cos(lat * D2R) * Math.cos(lon * D2R));
const Y = new THREE.Vector3(0, 1, 0);
// the axis it turns on leans back by TILT, so each face is seen a little from above, with its far edge
// standing up against space; and to the side by ROLL
const TILT = 20 * D2R, ROLL = -7 * D2R;
const SUN = new THREE.Vector3(-.68, .55, .5).normalize();   // from the upper left, the text's side
function hash(a, b = 0, c = 0) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
let seed = 1;
const rnd = () => hash(seed++, 77, 3);
const ease = x => x < .5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
const outBack = x => x <= 0 ? 0 : 1 + 2.4 * (x - 1) ** 3 + 1.4 * (x - 1) ** 2;
const clamp01 = x => Math.max(0, Math.min(1, x));
const sub = (x, a, b) => clamp01((x - a) / (b - a));
const lerp = (a, b, f) => a + (b - a) * f;
const wrapPI = a => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

// ---- renderer, camera ------------------------------------------------------------------------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// the resolution: the screen's, up to 2, lowered a step at a time while frames run slow (see pace)
const MAX_PR = Math.min(devicePixelRatio, 2), MIN_PR = Math.min(MAX_PR, .75);
let pr = MAX_PR;
renderer.setPixelRatio(pr);
// if the GPU's reset, the page starts again rather than standing still
canvas.addEventListener('webglcontextlost', e => e.preventDefault());
canvas.addEventListener('webglcontextrestored', () => location.reload());
renderer.autoClear = false; renderer.localClippingEnabled = true;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(16, 1, .1, 100);   // narrow, so it reads as flat as a drawing
// rootG moves the whole scene (the globe's stand and table with it); tiltG holds the planet at its tilt, and
// spinG turns it
const rootG = new THREE.Group(), tiltG = new THREE.Group(), spinG = new THREE.Group();
rootG.add(tiltG); tiltG.add(spinG); scene.add(rootG);
const qBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(-TILT, 0, ROLL, 'ZYX'));

// ---- shading: flat colour, a soft step into a purple shadow, and a rim of light ----------------
const SHADE_GLSL = `
uniform vec3 sunV; uniform float veil;
vec3 shade(vec3 col, vec3 n, vec3 v, float soft) {
  float l = dot(n, sunV);
  float lit = smoothstep(-.1 - soft, .18 + soft, l);
  vec3 c = col * mix(vec3(.34, .29, .62), vec3(1.), lit);
  c *= .9 + .14 * smoothstep(.35, .95, l);
  float fr = pow(1. - max(dot(n, v), 0.), 3.);
  c += vec3(.5, .72, 1.) * fr * mix(.22, .4, lit);
  return mix(c, vec3(.62, .78, 1.), veil * .34);   // seen from Earth, through the air
}`;
const sunV = { value: SUN.clone() }, veil = { value: 0 };
const toonCache = new Map();
function toon(color, { flat = false, side = THREE.FrontSide } = {}) {
  const key = color + ':' + flat + ':' + side;
  if (toonCache.has(key)) return toonCache.get(key);
  const m = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, sunV, veil }, side,
    defines: flat ? { FLAT: 1 } : {},
    vertexShader: `varying vec3 vN, vV, vCol;
#include <clipping_planes_pars_vertex>
void main() {
  vec4 p = vec4(position, 1.); vec3 n = normal; vCol = vec3(1.);
#ifdef USE_INSTANCING
  p = instanceMatrix * p; n = mat3(instanceMatrix) * n;
#endif
#ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
#endif
  vec4 mv = modelViewMatrix * p; vV = mv.xyz; vN = normalMatrix * n;
  gl_Position = projectionMatrix * mv;
  vec4 mvPosition = mv;
#include <clipping_planes_vertex>
}`,
    fragmentShader: `uniform vec3 color; varying vec3 vN, vV, vCol;
#include <clipping_planes_pars_fragment>
${SHADE_GLSL}
void main() {
#include <clipping_planes_fragment>
#ifdef FLAT
  vec3 n = normalize(cross(dFdx(vV), dFdy(vV)));
#else
  vec3 n = normalize(vN) * (gl_FrontFacing ? 1. : -1.);
#endif
  gl_FragColor = vec4(shade(color * vCol, n, normalize(-vV), 0.), 1.);
}`,
  });
  toonCache.set(key, m); return m;
}
const glowMat = c => new THREE.MeshBasicMaterial({ color: c });
const glowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, '#fff'); g.addColorStop(.25, '#fffa'); g.addColorStop(1, '#fff0');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
})();
const halo = (color, size, opacity = 1) => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.setScalar(size); return s;
};
const canvasTex = (w, h, draw) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
};
const roundRect = (x, X, Y, W, H, r, fill) => { x.beginPath(); x.roundRect(X, Y, W, H, r); x.fillStyle = fill; x.fill(); };

const mesh = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; };
const box = (w, h, d, mat, x, y, z) => mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
const cyl = (r, h, mat, x, y, z, seg = 20) => mesh(new THREE.CylinderGeometry(r, r, h, seg), mat, x, y, z);
const limb = (a, b, r, mat) => {   // a capsule from a to b
  const A = new THREE.Vector3(...a), d = new THREE.Vector3(...b).sub(A), m = new THREE.Mesh(new THREE.CapsuleGeometry(r, d.length(), 6, 12), mat);
  m.position.copy(A).addScaledVector(d, .5); m.quaternion.setFromUnitVectors(Y, d.normalize()); return m;
};
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x1a0f3a, transparent: true, opacity: .28, depthWrite: false });
const blob = (rx, rz) => { const m = new THREE.Mesh(new THREE.CircleGeometry(1, 32), shadowMat); m.rotation.x = -Math.PI / 2; m.scale.set(rx, rz, 1); m.position.y = .002; return m; };
const anims = [];   // (t in seconds, dt) => void, each frame

// ---- the scenes a face can hold ---------------------------------------------------------------------
// Each covers the whole planet. COVER: the planet as it is, the heart in the middle. BLUEPRINT: the desktop's
// layout drawn out on sheets. THREADS: the same ground turned round, split into threads by ranges of mountains.
// DUST: red tholins all the way round.
const COVER = 0, BLUEPRINT = 1, THREADS = 2, DUST = 3;
// the threads: one region of the ground each, round a point; the ridges are where two meet. The first five
// are on the face, and play out the loop; the rest go on round the back
const TH = [
  { lat: 30, lon: -40 }, { lat: 34, lon: 28 }, { lat: -12, lon: -48 }, { lat: -6, lon: 14 }, { lat: -42, lon: -8 },
  { lat: 80, lon: 170 }, { lat: 42, lon: 100 }, { lat: 42, lon: 160 }, { lat: 42, lon: -140 },
  { lat: 0, lon: 95 }, { lat: 0, lon: 145 }, { lat: 0, lon: -165 }, { lat: 0, lon: -120 },
  { lat: -40, lon: 85 }, { lat: -40, lon: 135 }, { lat: -40, lon: -175 }, { lat: -40, lon: -125 }, { lat: -80, lon: 60 },
];
const thSeeds = TH.map(r => dir(r.lat, r.lon));

// ---- the layout: the planet tiled in windows, rendered on one side of a split down its axis and drawn as
// their HTML on the other -------------------------------------------------------------------------------
// Two maps of the same desktop, in longitude and latitude: DESK the windows as they look, its colours; BLUE
// the same boxes as a blueprint, in three inks, one to a channel (red the white lines and lettering, green the
// highlights, blue the paler fills), which the shader colours in over its graph paper. The windows go in
// rows round the planet, each row's drawing widened by 1 / cos(latitude), so they come out square on it
const BPW = 4096, BPH = 2048, PXD = BPW / 360;   // the maps' size; pixels to a degree
const BP_ROWS = [-62, -41, -20, 1, 22, 43];   // each row's middle latitude (the face's middle is at -TILT)
const BP_ROW_H = 18;   // a row's height, in degrees
const [deskTex, blueTex] = (() => {
  const mk = () => { const c = document.createElement('canvas'); c.width = BPW; c.height = BPH; return c; };
  const D = mk(), B = mk(), d = D.getContext('2d'), b = B.getContext('2d'), MONO = '"JetBrains Mono", ui-monospace, monospace';
  // the wallpaper, between the windows; and black, no ink, under the blueprint
  const wall = d.createLinearGradient(0, 0, 0, BPH); wall.addColorStop(0, '#6a5cc4'); wall.addColorStop(.5, '#5446a8'); wall.addColorStop(1, '#43378f');
  d.fillStyle = wall; d.fillRect(0, 0, BPW, BPH);
  b.fillStyle = '#000'; b.fillRect(0, 0, BPW, BPH); b.globalCompositeOperation = 'lighter';
  const LINE = '#f00', HI = '#0f0';

  // ---- the rendered side's pen
  const rr = (x, X, Y, W, H, r, fill) => { x.beginPath(); x.roundRect(X, Y, W, H, r); x.fillStyle = fill; x.fill(); };
  const bars = (X, Y, W, n, gap, h, cols, k) => { for (let i = 0; i < n; i++) rr(d, X, Y + i * gap, W * (.35 + .6 * hash(i, k, 3)), h, h / 2, cols[i % cols.length]); };
  const words = (s, X, Y, size, col, w = 600, align = 'left') => { d.font = `${w} ${size}px ${MONO}`; d.textAlign = align; d.textBaseline = 'middle'; d.fillStyle = col; d.fillText(s, X, Y); };
  // a window: a shadow, its frame and title bar, and what's in it, drawn by body in the box under the bar
  function win(W, H, frame, barCol, title, titleCol, body) {
    rr(d, 5, 7, W, H, 12, 'rgba(10,6,30,.35)');
    rr(d, 0, 0, W, H, 12, frame); d.save(); d.beginPath(); d.roundRect(0, 0, W, H, 12); d.clip();
    d.fillStyle = barCol; d.fillRect(0, 0, W, 24);
    ['#ff7f5c', '#ffc861', '#7ef0c1'].forEach((c, i) => { d.beginPath(); d.arc(14 + i * 15, 12, 4.5, 0, 7); d.fillStyle = c; d.fill(); });
    if (title) words(title, W / 2, 13, 11, titleCol, 500, 'center');
    d.translate(0, 24); body(W, H - 24); d.restore();
  }
  // ---- the blueprint's pen
  let ink = LINE;
  const stroke = (w, dash = []) => { b.lineWidth = w; b.strokeStyle = ink; b.setLineDash(dash); b.stroke(); b.setLineDash([]); };
  const rect = (x0, y0, x1, y1, w = 2, dash, r = 0) => { b.beginPath(); b.roundRect(x0, y0, x1 - x0, y1 - y0, r); stroke(w, dash); };
  const fill = (x0, y0, x1, y1, k = .5, r = 0) => { b.beginPath(); b.roundRect(x0, y0, x1 - x0, y1 - y0, r); b.fillStyle = `rgba(0,0,255,${k})`; b.fill(); };
  const line = (pts, w = 2, dash) => { b.beginPath(); pts.forEach(([p, q], i) => i ? b.lineTo(p, q) : b.moveTo(p, q)); stroke(w, dash); };
  const say = (s, X, Y, size = 13, align = 'left', w = 500, a = 1) => {
    b.font = `${w} ${size}px ${MONO}`; b.textAlign = align; b.textBaseline = 'middle';
    b.fillStyle = ink === LINE ? `rgba(255,0,0,${a})` : ink; b.fillText(s, X, Y); return b.measureText(s).width;
  };
  const arrow = (X, Y, a, s = 7) => {
    b.beginPath(); b.moveTo(X, Y); b.lineTo(X - s * Math.cos(a - .4), Y - s * Math.sin(a - .4)); b.lineTo(X - s * Math.cos(a + .4), Y - s * Math.sin(a + .4));
    b.closePath(); b.fillStyle = ink; b.fill();
  };
  const dim = (X0, Y0, X1, Y1, s, size = 11) => {   // ticks at the ends, arrows out to them, the value in a gap
    const L = Math.hypot(X1 - X0, Y1 - Y0);
    b.save(); b.translate((X0 + X1) / 2, (Y0 + Y1) / 2); b.rotate(Math.atan2(Y1 - Y0, X1 - X0));
    b.font = `500 ${size}px ${MONO}`; const tw = b.measureText(s).width + 10;
    line([[-L / 2, 0], [-tw / 2, 0]], 1.2); line([[tw / 2, 0], [L / 2, 0]], 1.2); line([[-L / 2, -6], [-L / 2, 6]], 1.2); line([[L / 2, -6], [L / 2, 6]], 1.2);
    arrow(-L / 2, 0, Math.PI); arrow(L / 2, 0, 0); say(s, 0, 1, size, 'center');
    b.restore();
  };
  const tag = (s, X, Y, size = 12) => {   // an element's name, boxed, in the highlight
    const was = ink; ink = HI; b.font = `500 ${size}px ${MONO}`; const w = b.measureText(s).width + 12;
    rect(X, Y - size * .75, X + w, Y + size * .75, 1.5, [], 4); say(s, X + 6, Y + 1, size); ink = was; return w;
  };
  const bbars = (X, Y, W, n, gap, h, k) => { for (let i = 0; i < n; i++) line([[X, Y + i * gap], [X + W * (.35 + .6 * hash(i, k, 3)), Y + i * gap]], h + 1); };
  const cross = (x0, y0, x1, y1) => { line([[x0, y0], [x1, y1]], 1.8); line([[x1, y0], [x0, y1]], 1.8); };
  // a box as the blueprint draws it: its edge, the title bar's line, its element, and what's in it
  function box(W, H, el, body, bar = true) {
    fill(0, 0, W, H, .45, 12); rect(0, 0, W, H, 3.5, [], 12);
    if (bar) line([[0, 24], [W, 24]], 2);
    tag(el, 8, bar ? 12 : 13, W < 190 ? 10 : 12);
    b.save(); b.translate(0, bar ? 24 : 0); body(W, H - (bar ? 24 : 0)); b.restore();
  }

  // ---- the kinds of window: each drawn both ways, in a box W by H. min: the narrowest it'll go
  const KINDS = {
    term: { min: 200, desk(W, H, k) {
      win(W, H, '#1d1838', '#2b2550', 'foot', '#9b93c9', (w, h) => {
        words('$ plutonium run', 12, 18, 12, '#7ef0c1');
        bars(12, 36, w - 24, Math.floor((h - 50) / 17), 17, 6, ['#e8e4ff', '#b7afe6', '#ffc861', '#e8e4ff', '#ff7f5c'], k);
      });
    }, blue(W, H, k) {
      box(W, H, '<native-window app="foot">', (w, h) => { say('$ plutonium run', 12, 18, 12); bbars(12, 36, w - 24, Math.floor((h - 50) / 17), 17, 3, k); });
      dim(0, H + 12, W, H + 12, `${Math.round(W * 2)}px`);
    } },
    tab: { min: 230, desk(W, H, k) {
      win(W, H, '#fbfaff', '#ece8fb', null, '', (w, h) => {
        rr(d, 60, -19, w - 72, 14, 7, '#fff'); words('plutonium.dev', 70, -12, 9, '#8e86b8', 500);
        const hero = ['#ff7f5c', '#7a6fd0', '#3fc9a0'][k % 3];
        rr(d, 12, 12, w - 24, h * .42, 8, hero); d.beginPath(); d.arc(w * .72, 12 + h * .2, h * .1, 0, 7); d.fillStyle = '#ffc861'; d.fill();
        bars(12, 22 + h * .46, w - 24, Math.floor((h * .5 - 20) / 15), 15, 6, ['#2a2163', '#c9c2e6', '#c9c2e6'], k);
      });
    }, blue(W, H, k) {
      box(W, H, '<embed type="tab">', (w, h) => {
        rect(60, -19, w - 12, -5, 1.2, [], 7); say('https://', 70, -12, 9, 'left', 500, .7);
        fill(12, 12, w - 12, 12 + h * .42, .4, 8); rect(12, 12, w - 12, 12 + h * .42, 1.5, [], 8); cross(12, 12, w - 12, 12 + h * .42);
        say('<img>', w / 2, 12 + h * .21, 12, 'center');
        bbars(12, 22 + h * .46, w - 24, Math.floor((h * .5 - 20) / 15), 15, 3, k);
      });
      dim(W + 12, 0, W + 12, H, `${Math.round(H * 2)}px`);
    } },
    code: { min: 220, desk(W, H, k) {
      win(W, H, '#251f48', '#2e2757', 'shell.css — zed', '#9b93c9', (w, h) => {
        d.fillStyle = '#2e2757'; d.fillRect(0, 0, 30, h);
        const n = Math.floor((h - 14) / 15);
        for (let i = 0; i < n; i++) {
          words(String(i + 1), 24, 12 + i * 15, 8, '#6d64a3', 500, 'right');
          let X = 40 + 12 * (hash(i, k, 5) * 3 | 0);
          for (let j = 0; j < 3; j++) { const w2 = 18 + 40 * hash(i, j, k); if (X + w2 > w - 10) break; rr(d, X, 9 + i * 15, w2, 6, 3, ['#ff7f5c', '#7ef0c1', '#ffc861', '#b7afe6'][(i + j + k) % 4]); X += w2 + 6; }
        }
      });
    }, blue(W, H, k) {
      box(W, H, '<native-window app="zed">', (w, h) => {
        line([[30, 0], [30, h]], 1.2); const n = Math.floor((h - 14) / 15);
        for (let i = 0; i < n; i++) { say(String(i + 1), 24, 12 + i * 15, 8, 'right', 500, .6); line([[40 + 12 * (hash(i, k, 5) * 3 | 0), 12 + i * 15], [40 + 12 * (hash(i, k, 5) * 3 | 0) + 30 + 80 * hash(i, 1, k), 12 + i * 15]], 3); }
      });
    } },
    photo: { min: 150, desk(W, H) {
      d.save(); rr(d, 5, 7, W, H, 10, 'rgba(10,6,30,.35)'); d.beginPath(); d.roundRect(0, 0, W, H, 10); d.clip();
      d.fillStyle = '#8fd3ff'; d.fillRect(0, 0, W, H); d.beginPath(); d.arc(W * .7, H * .3, H * .12, 0, 7); d.fillStyle = '#ffc861'; d.fill();
      d.beginPath(); d.moveTo(0, H * .8); d.lineTo(W * .3, H * .38); d.lineTo(W * .55, H * .75); d.lineTo(W * .75, H * .5); d.lineTo(W, H * .8); d.lineTo(W, H); d.lineTo(0, H); d.fillStyle = '#5b4fb0'; d.fill();
      d.fillStyle = '#7ef0c1'; d.fillRect(0, H * .82, W, H); d.restore();
    }, blue(W, H) {
      box(W, H, '<img>', () => { cross(0, 0, W, H); }, false);
      say(`${Math.round(W * 2)} × ${Math.round(H * 2)}`, W / 2, H / 2 + 14, 11, 'center');
    } },
    music: { min: 150, desk(W, H, k) {
      win(W, H, '#fbfaff', '#ece8fb', null, '', (w, h) => {
        const s = Math.min(w - 24, h - 46); const g = d.createLinearGradient(0, 0, s, s); g.addColorStop(0, ['#ff7f5c', '#7a6fd0', '#3fc9a0'][k % 3]); g.addColorStop(1, '#ffc861');
        rr(d, (w - s) / 2, 10, s, s, 8, g);
        rr(d, 14, s + 20, w - 28, 4, 2, '#e0dbf7'); rr(d, 14, s + 20, (w - 28) * .4, 4, 2, '#7a6fd0');
        d.beginPath(); d.moveTo(w / 2 - 5, s + 29); d.lineTo(w / 2 + 7, s + 35); d.lineTo(w / 2 - 5, s + 41); d.fillStyle = '#2a2163'; d.fill();
      });
    }, blue(W, H) {
      box(W, H, '<audio controls>', (w, h) => {
        const s = Math.min(w - 24, h - 46); rect((w - s) / 2, 10, (w + s) / 2, 10 + s, 1.5, [], 8); cross((w - s) / 2, 10, (w + s) / 2, 10 + s);
        line([[14, s + 22], [w - 14, s + 22]], 2); ink = HI; line([[14, s + 22], [14 + (w - 28) * .4, s + 22]], 3); ink = LINE;
      });
    } },
    chat: { min: 170, desk(W, H, k) {
      win(W, H, '#f3f0ff', '#e4dff8', 'chat', '#8e86b8', (w, h) => {
        for (let i = 0, Y = 10; Y + 22 < h; i++) {
          const me = hash(i, k, 9) > .5, bw = w * (.35 + .35 * hash(i, k, 2)), bh = 16 + 12 * (hash(i, 4, k) > .6);
          rr(d, me ? w - 10 - bw : 10, Y, bw, bh, 8, me ? '#7a6fd0' : '#e0dbf7'); Y += bh + 7;
        }
      });
    }, blue(W, H, k) {
      box(W, H, '<ul class="chat">', (w, h) => {
        for (let i = 0, Y = 10; Y + 22 < h; i++) {
          const me = hash(i, k, 9) > .5, bw = w * (.35 + .35 * hash(i, k, 2)), bh = 16 + 12 * (hash(i, 4, k) > .6);
          rect(me ? w - 10 - bw : 10, Y, me ? w - 10 : 10 + bw, Y + bh, 1.2, [], 8); say('li', me ? w - 16 - bw + 10 : 16, Y + bh / 2, 9, 'left', 500, .7); Y += bh + 7;
        }
      });
    } },
    cal: { min: 170, desk(W, H, k) {
      win(W, H, '#fbfaff', '#ff7f5c', 'november', '#fff', (w, h) => {
        const cw = (w - 16) / 7, ch = (h - 12) / 5;
        for (let r = 0; r < 5; r++) for (let c = 0; c < 7; c++) {
          const on = r * 7 + c === 9 + k % 7;
          if (on) rr(d, 8 + c * cw + 2, 6 + r * ch + 2, cw - 4, ch - 4, 4, '#ff7f5c');
          else rr(d, 8 + c * cw + cw / 2 - 2, 6 + r * ch + ch / 2 - 2, 4, 4, 2, '#c9c2e6');
        }
      });
    }, blue(W, H) {
      box(W, H, '<table>', (w, h) => {
        const cw = (w - 16) / 7, ch = (h - 12) / 5;
        for (let r = 0; r <= 5; r++) line([[8, 6 + r * ch], [w - 8, 6 + r * ch]], 1);
        for (let c = 0; c <= 7; c++) line([[8 + c * cw, 6], [8 + c * cw, 6 + 5 * ch]], 1);
        say('td', 8 + cw / 2, 6 + ch / 2, 9, 'center', 500, .7);
      });
    } },
    files: { min: 190, desk(W, H, k) {
      win(W, H, '#f6f3ff', '#e4dff8', '~/.pluto/shells', '#8e86b8', (w, h) => {
        const n = Math.max(2, Math.floor((w - 12) / 54));
        for (let r = 0; (r + 1) * 46 < h; r++) for (let c = 0; c < n; c++) {
          const X = 12 + c * ((w - 12) / n), Y = 10 + r * 46;
          rr(d, X, Y, 34, 7, 3, '#ffb84a'); rr(d, X, Y + 4, 40, 24, 4, '#ffc861');
          rr(d, X + 4, Y + 32, 32 * (.5 + .5 * hash(r, c, k)), 4, 2, '#8e86b8');
        }
      });
    }, blue(W, H, k) {
      box(W, H, '<native-window app="files">', (w, h) => {
        const n = Math.max(2, Math.floor((w - 12) / 54));
        for (let r = 0; (r + 1) * 46 < h; r++) for (let c = 0; c < n; c++) {
          const X = 12 + c * ((w - 12) / n), Y = 10 + r * 46; rect(X, Y + 4, X + 40, Y + 28, 1.2, [], 4);
        }
        ink = HI; say('display: grid;', 12, h - 10, 10); ink = LINE;
      });
    } },
    clock: { min: 110, small: true, desk(W, H) {
      rr(d, 5, 7, W, H, 12, 'rgba(10,6,30,.35)'); rr(d, 0, 0, W, H, 12, '#1d1838');
      words('14:02', W / 2, H * .46, Math.min(34, H * .42), '#fbfaff', 600, 'center'); words('thu 30 oct', W / 2, H * .78, 10, '#9b93c9', 500, 'center');
    }, blue(W, H) {
      box(W, H, '<time>', () => { say('14:02', W / 2, H * .5, Math.min(30, H * .38), 'center', 600); }, false);
    } },
    bar: { min: 110, small: true, desk(W, H, k) {
      rr(d, 5, 7, W, H, 12, 'rgba(10,6,30,.35)'); rr(d, 0, 0, W, H, 12, '#fbfaff');
      for (let i = 0; i < 3; i++) { d.beginPath(); d.arc(22 + i * 30, H / 2, 9, 0, 7); d.fillStyle = ['#ff7f5c', '#7a6fd0', '#3fc9a0', '#ffc861'][(i + k) % 4]; d.fill(); }
      rr(d, W - 44, H / 2 - 6, 30, 12, 3, '#3fc9a0');
    }, blue(W, H) {
      box(W, H, '<nav>', () => { for (let i = 0; i < 3; i++) { b.beginPath(); b.arc(22 + i * 30, H / 2 + 4, 9, 0, 7); stroke(1.2); } rect(W - 44, H / 2 - 2, W - 14, H / 2 + 10, 1.2, [], 3); }, false);
    } },
  };
  const BIG = ['term', 'tab', 'code', 'tab', 'term', 'chat', 'files', 'cal', 'music', 'photo'], SMALL = ['clock', 'bar', 'photo', 'music'];

  // ---- the rows: windows of varied widths, end to end round the planet, a gap between; some slots two
  // little ones stacked
  let seedK = 0;
  for (const lat of BP_ROWS) {
    const cs = Math.cos(lat * D2R), ring = BPW * cs, H = BP_ROW_H * PXD, gap = 3 * PXD, top = (90 - lat - BP_ROW_H / 2) * PXD;
    // the slots' widths, in pixels as they'll look, filling the ring exactly
    const ws = []; let sum = 0;
    while (sum < ring - 260) { const w = 150 + 230 * hash(seedK++, 31); ws.push(w); sum += w + gap; }
    const k = (ring - ws.length * gap) / ws.reduce((a, w) => a + w, 0); ws.forEach((w, i) => ws[i] = w * k);
    let X = gap / 2;
    for (const w of ws) {
      const n = seedK++, stack = w < 230 && hash(n, 7) > .35;
      const parts = stack ? [[0, H * .42, SMALL[n % SMALL.length]], [H * .42 + gap * .6, H * .58 - gap * .6, BIG.concat(SMALL)[(n * 3 + 1) % 14]]] : [[0, H, BIG[n % BIG.length]]];
      for (const [y0, h, kind0] of parts) {
        const kind = KINDS[kind0].min <= w ? kind0 : 'photo';
        for (const [x, side] of [[d, 'desk'], [b, 'blue']]) {
          x.save(); x.translate(X / cs, top + y0); x.scale(1 / cs, 1);
          KINDS[kind][side](w, h, n); x.restore();
        }
      }
      X += w + gap;
    }
  }
  const tex = (c, srgb) => { const t = new THREE.CanvasTexture(c); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8; t.wrapS = THREE.RepeatWrapping; return t; };
  return [tex(D, true), tex(B, false)];
})();

// ---- the planet: a scene, or two blended along the edge between them ---------------------------------
// the turn's far edge, the one that goes round the back, is a fade this wide (radians of longitude)
const FADE = 1;
const heartAt = dir(-14, -4);
const craters = [];
while (craters.length < 30) {
  const d = dir(Math.asin(rnd() * 2 - 1) / D2R, rnd() * 360), r = (2.2 + 5 * rnd() ** 2) * D2R;
  if (heartAt.angleTo(d) > 30 * D2R + r) craters.push(new THREE.Vector4(d.x, d.y, d.z, r));
}
const plutoMat = new THREE.ShaderMaterial({
  uniforms: {
    sunV, veil, heart: { value: heartAt }, craters: { value: craters }, bpDesk: { value: deskTex }, bpBlue: { value: blueTex }, bpPsi: { value: 0 },
    scA: { value: COVER }, scB: { value: COVER }, thA: { value: 0 }, thB: { value: 0 }, wipe: { value: new THREE.Vector4(0, 0, 1, -2) }, blend: { value: 0 },
  },
  vertexShader: `varying vec3 vP, vN, vV;
void main() { vP = position; vec4 mv = modelViewMatrix * vec4(position, 1.); vV = mv.xyz; vN = normalMatrix * normal; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying vec3 vP, vN, vV;
uniform vec3 heart; uniform vec4 craters[30], wipe; uniform float scA, scB, thA, thB, blend; uniform sampler2D bpDesk, bpBlue; uniform float bpPsi;
${SHADE_GLSL}
// 3D simplex noise (Ashima Arts / Stefan Gustavson)
vec4 perm(vec4 x) { return mod(((x * 34.) + 1.) * x, 289.); }
float snoise(vec3 v) {
  const vec2 C = vec2(1. / 6., 1. / 3.); const vec4 D = vec4(0., .5, 1., 2.);
  vec3 i = floor(v + dot(v, C.yyy)), x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz), l = 1. - g, i1 = min(g.xyz, l.zxy), i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx, x2 = x0 - i2 + C.yyy, x3 = x0 - D.yyy;
  i = mod(i, 289.);
  vec4 p = perm(perm(perm(i.z + vec4(0., i1.z, i2.z, 1.)) + i.y + vec4(0., i1.y, i2.y, 1.)) + i.x + vec4(0., i1.x, i2.x, 1.));
  vec3 ns = .142857142857 * D.wyz - D.xzx;
  vec4 j = p - 49. * floor(p * ns.z * ns.z), x_ = floor(j * ns.z), y_ = floor(j - 7. * x_);
  vec4 x = x_ * ns.x + ns.yyyy, y = y_ * ns.x + ns.yyyy, h = 1. - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy), b1 = vec4(x.zw, y.zw), s0 = floor(b0) * 2. + 1., s1 = floor(b1) * 2. + 1., sh = -step(h, vec4(0.));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy, a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x), p1 = vec3(a0.zw, h.y), p2 = vec3(a1.xy, h.z), p3 = vec3(a1.zw, h.w);
  vec4 nr = inversesqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= nr.x; p1 *= nr.y; p2 *= nr.z; p3 *= nr.w;
  vec4 m = max(.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.); m *= m;
  return 42. * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
float fbm(vec3 p) { return .62 * snoise(p) + .28 * snoise(p * 2.1 + 3.) + .1 * snoise(p * 4.7 + 9.); }
// 1 where d < 0, with an edge a pixel wide
float inside(float d) { float w = fwidth(d) * .7; return smoothstep(w, -w, d); }
// p in flat coordinates around c (east, north), in units of tan(angle)
vec2 flatAt(vec3 p, vec3 c) { vec3 e = normalize(cross(vec3(0., 1., 0.), c)), n = cross(c, e), q = p / max(dot(p, c), .05) - c; return vec2(dot(q, e), dot(q, n)); }
vec2 h2(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
float cells(vec2 x) {   // distance to the edge between cells
  vec2 n = floor(x), f = fract(x); float f1 = 8., f2 = 8.;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(i, j), o = h2(n + g) * .7 + .15; float d = length(g + o - f);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return f2 - f1;
}
float dot2(vec2 v) { return dot(v, v); }
float sdHeart(vec2 p) {   // Inigo Quilez's: the tip at the origin, the lobes up to y = 1
  p.x = abs(p.x);
  if (p.y + p.x > 1.) return sqrt(dot2(p - vec2(.25, .75))) - sqrt(2.) / 4.;
  return sqrt(min(dot2(p - vec2(0., 1.)), dot2(p - .5 * max(p.x + p.y, 0.)))) * sign(p.x - p.y);
}
const vec3 ICE = vec3(.96, .98, 1.), ICE_LINE = vec3(.7, .78, .94);
// craters: a dark floor, a darker crescent of inner wall, a light rim
vec3 cratered(vec3 col, vec3 p) {
  for (int i = 0; i < 30; i++) {
    vec4 c = craters[i]; if (dot(p, c.xyz) < cos(c.w * 1.3)) continue;   // (far from it: no acos)
    float a = acos(clamp(dot(p, c.xyz), -1., 1.));
    vec3 nth = normalize(vec3(0., 1., 0.) - c.xyz * c.y), sh = normalize(c.xyz - nth * c.w * .3 + cross(c.xyz, nth) * c.w * .15);
    float d = a - c.w, d2 = acos(clamp(dot(p, sh), -1., 1.)) - c.w * .92;
    col = mix(col, col * 1.08 + .04, inside(d - c.w * .16) - inside(d));
    col = mix(col, col * .91, inside(d));
    col = mix(col, col * .8, inside(d) * (1. - inside(d2)));
  }
  return col;
}
// the plains: white ice, a little blue-grey in places, a thin pink wash of tholins here and there, and a
// broken belt of crimson tholins below the heart, deepest at its middle; a frosted north; craters
vec3 plains(vec3 p, float withHeart) {
  float warp = .06 * snoise(p * 7.);
  vec3 col = vec3(.97, .97, .99);
  col = mix(col, vec3(.88, .89, .95), inside(.38 - fbm(p * 1.7 + 11.) - warp));
  col = mix(col, vec3(.98, .87, .84), inside(.34 - fbm(p * 2.2 + 4.) - warp));
  float belt = fbm(p * 1.8) + .55 - 1.9 * abs(p.y + .5) + .7 * snoise(p * .9 + 20.) - .12;
  col = mix(col, vec3(.86, .4, .42), inside(.12 - belt - warp));
  col = mix(col, vec3(.72, .13, .2), inside(.3 - belt - warp));
  col = mix(col, vec3(.52, .07, .15), inside(.62 - belt - warp));
  col = mix(col, vec3(.98, .93, .8), inside(.66 - p.y - .12 * fbm(p * 3.)));
  col = cratered(col, p);
  // the heart: Sputnik Planitia's glacier on the west, paler cream on the east
  if (withHeart > .5 && dot(p, heart) > .3) {
    vec2 q = flatAt(p, heart) + .04 * vec2(snoise(p * 6.), snoise(p * 6. + 5.));
    vec2 hp = q / .9 + vec2(0., .55);
    float d = sdHeart(hp) * .9, west = inside(hp.x + .05 - .12 * (hp.y - .5));
    vec3 east = vec3(1., .97, .94), ice = mix(ICE, ICE_LINE, inside(cells(q * 16.) - .07));
    col = mix(col, mix(east, ice, west), inside(d));
  }
  return col;
}
// the threads: the plains, turned some way round, without the heart
vec3 sheet(vec3 p) { return plains(vec3(cos(2.1) * p.x + sin(2.1) * p.z, p.y, cos(2.1) * p.z - sin(2.1) * p.x), 0.); }
// red dust: tholins in three crimsons, a paler wash and a little ice where they thin out, and craters
vec3 dust(vec3 p) {
  float warp = .06 * snoise(p * 7.), n = fbm(p * 1.7 + 31.) + .35 * snoise(p * .8 + 5.);
  vec3 col = vec3(.72, .13, .2);
  col = mix(col, vec3(.86, .4, .42), inside(n + .22 + warp));
  col = mix(col, vec3(.98, .87, .84), inside(n + .5 + warp));
  col = mix(col, vec3(.97, .97, .99), inside(n + .64 + warp));
  col = mix(col, vec3(.52, .07, .15), inside(.22 - n - warp));
  col = mix(col, vec3(.4, .05, .12), inside(.52 - n - warp));
  return cratered(col, p);
}
// the layout: the windows in rows round the planet, rendered west of the split (a meridian, at longitude
// bpPsi) and drawn as their HTML east of it, along a line of light. The maps are sampled with gradients from a
// copy of the longitude whose seam is round the other side, so they go on smoothly over the back's
vec3 blueprint(vec3 p) {
  float lon = atan(p.x, p.z), lat = asin(clamp(p.y, -1., 1.));
  vec2 uv = vec2(lon / 6.2831853 + .5, lat / 3.1415927 + .5), gx = dFdx(uv), gy = dFdy(uv);
  float u2 = fract(uv.x + .5), g2x = dFdx(u2), g2y = dFdy(u2);
  if (abs(g2x) + abs(g2y) < abs(gx.x) + abs(gy.x)) { gx.x = g2x; gy.x = g2y; }
  vec3 desk = textureGrad(bpDesk, uv, gx, gy).rgb, ink = textureGrad(bpBlue, uv, gx, gy).rgb;
  // graph paper, on the faces of a cube round it: a fine rule, a bolder one every fourth, the fine one fading
  // out where it would be too close
  vec3 a = abs(p), N, U, V = vec3(0., 1., 0.);
  if (a.z >= a.x && a.z >= a.y) { N = vec3(0., 0., sign(p.z)); U = vec3(sign(p.z), 0., 0.); }
  else if (a.x >= a.y) { N = vec3(sign(p.x), 0., 0.); U = vec3(0., 0., -sign(p.x)); }
  else { N = vec3(0., sign(p.y), 0.); U = vec3(1., 0., 0.); V = vec3(0., 0., -sign(p.y)); }
  float pn = dot(p, N); vec2 q = vec2(dot(p, U), dot(p, V)) / pn, k = 1.2732 / (1. + q * q);
  vec3 dx = dFdx(p), dy = dFdy(p);
  vec2 sx = k * (vec2(dot(dx, U), dot(dx, V)) - q * dot(dx, N)) / pn, sy = k * (vec2(dot(dy, U), dot(dy, V)) - q * dot(dy, N)) / pn;
  vec2 st = atan(q) * 1.2732, fw = abs(sx) + abs(sy);
  vec2 l1 = abs(fract(st * 8. + .5) - .5) / (fw * 8.), l2 = abs(fract(st * 32. + .5) - .5) / (fw * 32.);
  float major = 1. - clamp(min(l1.x, l1.y) - .5, 0., 1.);
  float minor = (1. - clamp(min(l2.x, l2.y) - .3, 0., 1.)) * clamp(2. - max(fw.x, fw.y) * 160., 0., 1.);
  vec3 paper = vec3(.11, .3, .64) * (.92 + .08 * fbm(p * 3. + 7.));
  vec3 blue = paper + vec3(.04, .07, .1) * minor + vec3(.07, .11, .15) * major;
  blue = mix(blue, paper * 1.12 + vec3(.08, .13, .19), ink.b * .85);
  blue = mix(blue, vec3(.92, .96, 1.), ink.r);
  blue = mix(blue, vec3(1., .8, .42), ink.g);
  // which side of the split, and the line along it
  float side = dot(p, vec3(cos(bpPsi), 0., -sin(bpPsi))), fs = fwidth(side);
  vec3 col = mix(desk, blue, smoothstep(-fs, fs, side));
  col += vec3(.3, .55, 1.) * .45 * exp(-abs(side) * 30.);
  return mix(col, vec3(.88, .95, 1.), 1. - smoothstep(fs * .8, fs * 2.2, abs(side)));
}
// p in a scene's own frame: turned back by th, the way its props are turned
vec3 unturn(vec3 p, float th) { float c = cos(th), s = sin(th); return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z); }
vec3 ground(float sc, float th, vec3 p) {
  if (sc < .5) return plains(unturn(p, th), 1.);
  if (sc < 1.5) return blueprint(unturn(p, th));
  if (sc < 2.5) return sheet(unturn(p, th));
  return dust(p);
}
void main() {
  vec3 p = normalize(vP);
  vec3 col;
  if (blend < .5) col = ground(scB, thB, p);
  else {   // B behind the meridian wipe.xyz, the lead, across a ragged edge with a line of light along it; and
    // short of the far edge, wipe.w round from the lead, which goes round the back but can be seen near the
    // south pole and the limbs, so it's a fade FADE wide (the raggedness and the light come in as the wedge
    // opens and go as it closes)
    vec2 h = p.xz;
    float ph = mod(atan(dot(h, vec2(wipe.z, -wipe.x)), dot(h, wipe.xz)), 6.2832);
    float s = ph < 3.1416 ? ph : ph - 6.2832;   // from the lead, behind it positive
    float amp = clamp(min(wipe.w, 6.2832 - wipe.w) / .3, 0., 1.);
    float k = smoothstep(0., .05, s + amp * (.05 * snoise(p * 5. + 3.) + .02 * snoise(p * 17.)));
    float far = ${(FADE / 2).toFixed(3)};
    float tb = smoothstep(wipe.w + far, wipe.w - far, max(s, 0.)), ta = smoothstep(wipe.w + far, wipe.w - far, s < 0. ? s + 6.2832 : 6.2832);
    float m = mix(ta, tb, k);
    col = mix(ground(scA, thA, p), ground(scB, thB, p), m);
    col += vec3(.75, .9, 1.) * .3 * amp * (tb - ta) * exp(-abs(s - .025) * 70.);
  }
  gl_FragColor = vec4(shade(col, normalize(vN), normalize(-vV), .06), 1.);
}`,
});
const pluto = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 120), plutoMat);
spinG.add(pluto);

// the haze: a ring of blue light round the limb, stronger on the sunlit side
const hazeMat = new THREE.ShaderMaterial({
  uniforms: { sunV, amount: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `varying vec2 vU; void main() { vU = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
  fragmentShader: `varying vec2 vU; uniform vec3 sunV; uniform float amount;
void main() {
  float r = length(vU), side = dot(vU / max(r, 1e-3), normalize(sunV.xy));
  float g = smoothstep(.97, 1.005, r) * exp(-max(r - 1., 0.) * 16.) + .25 * exp(-max(r - 1., 0.) * 5.) * step(.99, r);
  gl_FragColor = vec4(vec3(.45, .7, 1.) * g * (.35 + .65 * smoothstep(-.7, .8, side)) * amount, 1.);
}`,
});
const haze = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), hazeMat);
scene.add(haze);

// ---- the moons, one for each shell ---------------------------------------------------------------
// Most of the time Charon hangs back in the distance and the small ones ride an orbit drawn in dashes. At the
// shells' stop the planet shrinks back and all five come round in front of it on a wider orbit, big enough to
// point at; pointing at one projects its shell above it.
const charonMat = new THREE.ShaderMaterial({
  uniforms: { sunV, veil },
  vertexShader: plutoMat.vertexShader,
  fragmentShader: `varying vec3 vP, vN, vV;
${SHADE_GLSL}

void main() {
  vec3 p = normalize(vP);
  float n = sin(p.x * 9. + sin(p.z * 7.)) * sin(p.z * 8. + p.y * 5.) * .5;
  vec3 col = mix(vec3(.66, .66, .76), vec3(.75, .75, .84), step(.1, n));
  float w = fwidth(p.y);   // Mordor Macula, the red cap
  col = mix(col, vec3(.55, .27, .3), smoothstep(.82 - w, .82 + w, p.y + .06 * sin(p.x * 11.) * sin(p.z * 9.)));
  gl_FragColor = vec4(shade(col, normalize(vN), normalize(-vV), .04), 1.);
}`,
});
const charon = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), charonMat);
charon.rotation.set(.5, 0, .3);
function lump(sx, sy, sz, k) {   // a small moon: a knobbly, stretched ball about 1 across each way
  const g = new THREE.IcosahedronGeometry(1, 5), p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(1 + .07 * Math.sin(v.x * 4 + k) * Math.sin(v.y * 3.3 + 2 * k) + .05 * Math.sin(v.z * 5.1 + 3 * k));
    p.setXYZ(i, v.x * sx, v.y * sy, v.z * sz);
  }
  g.computeVertexNormals(); return g;
}
// small: its radius on the little orbit; big: at the shells' stop; a: where it starts on the little orbit
const MOONS = [
  { name: 'Styx', what: 'Scrolling tiles', small: .022, big: .085, a: .3, body: mesh(lump(1.3, .9, .95, 1), toon(0xd9d4ec)) },
  { name: 'Charon', what: 'Floating windows', small: 1, big: .19, body: charon },
  { name: 'Hydra', what: 'Coding agents', small: .035, big: .1, a: 1.7, body: mesh(lump(1.45, .82, .9, 2), toon(0xeeeaff)) },
  { name: 'Kerberos', what: 'Reference', small: .025, big: .09, a: 3.4, body: new THREE.Group().add(
    mesh(lump(.72, .7, .7, 3), toon(0xbab3d6), -.42, 0, 0), mesh(lump(.6, .58, .6, 4), toon(0xbab3d6), .52, .06, 0)) },
  { name: 'Nix', what: 'Yours', small: .03, big: .085, a: 4.6, body: mesh(lump(1.3, .95, .9, 5), toon(0xe6e0f4)) },
];
const SLOT = [168, 129, 90, 51, 12].map(a => a * D2R), RM = 1.25;   // on the wide orbit, left to right across the front
const qMoon = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 17.5 * D2R);   // seen from a little above
const qOrbit = new THREE.Quaternion().setFromEuler(new THREE.Euler(-54 * D2R, 0, ROLL, 'ZYX'));   // the little orbit, seen well from above
for (const m of MOONS) { m.g = new THREE.Group(); m.g.add(m.body); rootG.add(m.g); }
const orbit = new THREE.Group(); rootG.add(orbit);
const orbitMat = new THREE.LineDashedMaterial({ color: 0xb9b0ee, dashSize: .025, gapSize: .03, transparent: true, opacity: .45 });
{ const pts = []; for (let i = 0; i <= 256; i++) { const a = i / 256 * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a))); }
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), orbitMat);
  line.computeLineDistances(); orbit.add(line); }

// ---- props, planted on a face ---------------------------------------------------------------------
// plant(obj, lat, lon, yaw, sink, parent): stand obj on the ground there, x east, y up, z south; yaw turns it
// about its up. lat and lon are in the face's own frame, its middle at (0, 0).
function frameAt(lat, lon, q = new THREE.Quaternion()) {
  const n = dir(lat, lon), e = Y.clone().cross(n).normalize(), s = e.clone().cross(n);
  return q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(e, n, s));
}
const qYaw = new THREE.Quaternion();
function place(obj, lat, lon, yaw = 0, lift = 0) {
  obj.position.copy(dir(lat, lon)).multiplyScalar(1 + lift);
  frameAt(lat, lon, obj.quaternion).multiply(qYaw.setFromAxisAngle(Y, yaw));
  return obj;
}
function plant(obj, lat, lon, yaw = 0, sink = 0, parent = spinG) { place(obj, lat, lon, yaw, -sink); parent.add(obj); return obj; }

// ---- flat icons and windows, drawn on canvases --------------------------------------------------------
const icons = {};
function icon(kind) {
  if (icons[kind]) return icons[kind];
  const wide = kind === 'win';
  return icons[kind] = canvasTex(wide ? 192 : 128, 128, (x, W, H) => {
    const rr = (X, Y_, w, h, r, f) => roundRect(x, X, Y_, w, h, r, f);
    const bars = (X, Y_, w, n, f, k = 0) => { for (let i = 0; i < n; i++) rr(X, Y_ + i * 13, w * (.5 + .5 * hash(i, k, 7)), 6, 3, f); };
    switch (kind) {
      case 'term':
        rr(4, 4, 120, 120, 22, '#1d1838'); rr(4, 4, 120, 22, [22, 22, 0, 0], '#2f2858');
        x.font = '700 46px "JetBrains Mono", ui-monospace, monospace'; x.fillStyle = '#7cf08e'; x.fillText('>_', 18, 88); break;
      case 'tab':
        rr(4, 4, 120, 120, 22, '#f6f3ff'); rr(14, 12, 56, 20, 8, '#cfc7f0'); rr(4, 28, 120, 8, 0, '#cfc7f0');
        x.strokeStyle = '#5b6fd8'; x.lineWidth = 6; x.beginPath(); x.arc(64, 80, 28, 0, 7); x.stroke();
        x.beginPath(); x.ellipse(64, 80, 12, 28, 0, 0, 7); x.stroke(); x.beginPath(); x.moveTo(36, 80); x.lineTo(92, 80); x.stroke(); break;
      case 'doc':
        rr(4, 4, 120, 120, 22, '#ffc861');
        x.beginPath(); x.moveTo(30, 16); x.lineTo(80, 16); x.lineTo(98, 34); x.lineTo(98, 112); x.lineTo(30, 112); x.closePath(); x.fillStyle = '#fffaf0'; x.fill();
        x.beginPath(); x.moveTo(80, 16); x.lineTo(80, 34); x.lineTo(98, 34); x.closePath(); x.fillStyle = '#e8d9b8'; x.fill();
        bars(40, 48, 48, 5, '#b9a98a', 1); break;
      case 'office':   // a document in LibreOffice's blue
        rr(4, 4, 120, 120, 22, '#2a6fdb');
        x.beginPath(); x.moveTo(30, 16); x.lineTo(80, 16); x.lineTo(98, 34); x.lineTo(98, 112); x.lineTo(30, 112); x.closePath(); x.fillStyle = '#ffffff'; x.fill();
        rr(40, 46, 48, 14, 3, '#2a6fdb'); bars(40, 70, 48, 3, '#9cb8ec', 2); break;
      case 'app':
        rr(4, 4, 120, 120, 22, '#2b2456'); rr(4, 4, 120, 26, [22, 22, 0, 0], '#4a3f86');
        ['#ff6b57', '#ffc861', '#7cf08e'].forEach((f, i) => { x.beginPath(); x.arc(22 + i * 16, 17, 5, 0, 7); x.fillStyle = f; x.fill(); });
        rr(16, 42, 44, 66, 8, '#ff9b7a'); bars(70, 44, 42, 5, '#b9b0ee', 3); break;
      case 'agent':   // a spark: an agent at work
        rr(4, 4, 120, 120, 22, '#3a2f6e');
        x.beginPath(); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 - Math.PI / 2, r = i % 2 ? 12 : 42; x.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r); }
        x.closePath(); x.fillStyle = '#ffc861'; x.fill();
        x.beginPath(); x.arc(98, 30, 7, 0, 7); x.fillStyle = '#7ff3ff'; x.fill(); break;
      case 'win':   // the document, open in its app's window
        rr(4, 4, W - 8, 120, 18, '#2b2456'); rr(4, 4, W - 8, 24, [18, 18, 0, 0], '#4a3f86');
        ['#ff6b57', '#ffc861', '#7cf08e'].forEach((f, i) => { x.beginPath(); x.arc(20 + i * 15, 16, 5, 0, 7); x.fillStyle = f; x.fill(); });
        rr(14, 36, W - 28, 80, 6, '#fffaf0'); bars(30, 50, W - 60, 5, '#b9a98a', 4); break;
    }
  });
}
// an app's window, as a screen on a rover: a terminal, a page, or a sheet
function windowTex(kind) {
  return canvasTex(512, 340, x => {
    const rr = (X, Y_, W, H, r, f) => roundRect(x, X, Y_, W, H, r, f);
    rr(0, 0, 512, 340, 30, '#2b2456'); rr(10, 50, 492, 280, 20, kind === 1 ? '#f6f3ff' : kind === 2 ? '#fbfbf6' : '#17132f');
    ['#ff6b57', '#ffc861', '#7cf08e'].forEach((f, i) => { x.beginPath(); x.arc(34 + i * 30, 26, 9, 0, 7); x.fillStyle = f; x.fill(); });
    if (kind === 1) {
      rr(30, 70, 452, 26, 13, '#ded8f4'); rr(30, 116, 200, 120, 12, '#ff9b7a'); rr(250, 116, 232, 22, 8, '#c9c2e6'); rr(250, 150, 190, 22, 8, '#c9c2e6');
      rr(250, 184, 210, 22, 8, '#c9c2e6'); rr(30, 256, 452, 22, 8, '#ded8f4'); rr(30, 288, 300, 22, 8, '#ded8f4');
    } else if (kind === 2) {
      for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) rr(30 + c * 92, 70 + r * 36, 84, 28, 4, r === 0 ? '#9ed9a8' : c === 0 ? '#e4e8d8' : '#eef0e6');
      rr(214, 178, 84, 28, 4, '#7cf08e');
    } else {
      const ws = [[34, 120, '#7cf08e'], [34, 200, '#c9c2e6'], [34, 160, '#c9c2e6'], [34, 260, '#7fd8ff'], [34, 90, '#c9c2e6'], [34, 220, '#c9c2e6']];
      ws.forEach(([X, W, f], i) => rr(X, 76 + i * 38, W, 18, 9, f)); rr(34, 76 + 6 * 38, 18, 18, 3, '#ff7f5c');
    }
  });
}

// ---- threads: the planet's own ground, split into threads by ranges of mountains ------------------------
// Each region is a thread, with what's open in it as little blocks, their icons on top. Signals hop between the blocks of a thread in its colour, and never over a range. On a loop: a
// terminal's link becomes a tab beside it; a document flips over into its app's window where it is; and
// LibreOffice, started in two threads, gets a copy on each side of the range between them.
const threadsG = new THREE.Group(); spinG.add(threadsG);
const thread = { blocks: TH.map(() => []), cols: TH.map((_, k) => [0xff8a6b, 0xffc861, 0x7fe0a0, 0x7fd8ff, 0xc9a6ff][k % 5]) };
{
  // where the ranges go: on a sphere the edges between the regions are arcs of great circles; each pair's,
  // where those two are the nearest
  const ridges = [];
  for (let i = 0; i < TH.length; i++) for (let j = i + 1; j < TH.length; j++) {
    const a = thSeeds[i], b = thSeeds[j], n = a.clone().sub(b).normalize();
    const u = new THREE.Vector3(1, 0, 0).projectOnPlane(n).normalize(), w = n.clone().cross(u);
    const N = 1440, runs = []; let run = null;
    for (let k = 0; k <= N; k++) {
      const th = k / N * Math.PI * 2, c = u.clone().multiplyScalar(Math.cos(th)).addScaledVector(w, Math.sin(th));
      const d = c.dot(a), ok = thSeeds.every((s, m) => m === i || m === j || c.dot(s) < d - 1e-6);
      if (ok) { if (!run) { runs.push(run = []); run.k0 = k; } run.push(c); } else run = null;
    }
    if (run && runs.length > 1 && runs[0].k0 === 0) { runs.pop(); run.pop(); runs[0] = run.concat(runs[0]); }   // across θ = 0
    for (const r of runs) if (r.length > 3) ridges.push({ i, j, pts: r });
  }
  // the ranges: low-poly peaks along each edge, close enough to overlap, smaller toward the ends, with snow on
  // the tall ones
  const peaks = [];
  for (const { i, j, pts } of ridges) {
    for (let k = 0; k < pts.length; k += 9 + Math.floor(rnd() * 5)) {
      const p = pts[k], fade = Math.min(1, .45 + k / 30, .45 + (pts.length - k) / 30);
      if (fade < .08) continue;
      const side = p.clone().cross(pts[Math.min(pts.length - 1, k + 1)].clone().sub(pts[Math.max(0, k - 1)])).normalize();
      const h = (.06 + .06 * rnd()) * (.7 + .3 * Math.sin(k * .05 + i * 2 + j)) * fade;
      peaks.push({ p: p.clone().addScaledVector(side, (rnd() - .5) * .02).normalize(), h, r: h * (.62 + .2 * rnd()) });
      for (const sd of [-1, 1]) if (rnd() < .55) peaks.push({ p: p.clone().addScaledVector(side, sd * (.03 + .015 * rnd())).normalize(), h: h * (.45 + .2 * rnd()), r: h * .45 });
    }
  }
  const cone = new THREE.ConeGeometry(1, 1, 5, 1).translate(0, .5, 0);
  const body = new THREE.InstancedMesh(cone, toon(0xffffff, { flat: true }), peaks.length);
  const snow = new THREE.InstancedMesh(cone, toon(0xf7f5ff, { flat: true }), peaks.length);
  const tints = [0xa6a8dc, 0x9ea2d8, 0xb4b4e2, 0xadb0e0, 0x989cd4].map(c => new THREE.Color(c));
  const o = new THREE.Object3D(), q = new THREE.Quaternion();
  peaks.forEach((pk, n) => {
    q.setFromUnitVectors(Y, pk.p); const rot = rnd() * 6.28;
    o.position.copy(pk.p).multiplyScalar(.996); o.quaternion.copy(q).multiply(qYaw.setFromAxisAngle(Y, rot));
    o.scale.set(pk.r, pk.h, pk.r * (.8 + .3 * rnd())); o.updateMatrix(); body.setMatrixAt(n, o.matrix); body.setColorAt(n, tints[n % 5]);
    const tall = pk.h > .055;   // the snow: the top of the same cone, a little bigger so it sits on it
    o.position.copy(pk.p).multiplyScalar(.996).addScaledVector(pk.p, pk.h * .62);
    o.scale.set(pk.r * .39, tall ? pk.h * .38 : 0, o.scale.z * .39); o.updateMatrix(); snow.setMatrixAt(n, o.matrix);
  });
  threadsG.add(body, snow);

  // an app: a block with rounded corners, 3 by 1 by 3, its icon on top
  const BODY = { term: 0x2b2456, tab: 0xd9d2f2, doc: 0xf0b44a, office: 0x2a6fdb, app: 0x4a3f86, agent: 0x3a2f6e, win: 0x4a3f86 };
  const geos = {};
  function slab(kind) {
    const W = kind === 'win' ? .15 : .09, D = .09, R = .02, g = new THREE.Group();
    if (!geos[W]) {
      const s = new THREE.Shape(), x = -W / 2, y = -D / 2;
      s.moveTo(x + R, y); s.lineTo(x + W - R, y); s.quadraticCurveTo(x + W, y, x + W, y + R); s.lineTo(x + W, y + D - R);
      s.quadraticCurveTo(x + W, y + D, x + W - R, y + D); s.lineTo(x + R, y + D); s.quadraticCurveTo(x, y + D, x, y + D - R);
      s.lineTo(x, y + R); s.quadraticCurveTo(x, y, x + R, y);
      geos[W] = new THREE.ExtrudeGeometry(s, { depth: .018, bevelEnabled: true, bevelThickness: .006, bevelSize: .006, bevelSegments: 3, curveSegments: 5 }).rotateX(-Math.PI / 2).translate(0, .006, 0);
    }
    g.add(mesh(geos[W], toon(BODY[kind])));
    const top = mesh(new THREE.PlaneGeometry(W + .004, D + .004).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: icon(kind), transparent: true }), 0, .0305, 0);
    g.add(top); return g;
  }
  function block(kind, k, lat, lon, still = true) {
    const g = new THREE.Group(), lift = new THREE.Group();
    lift.add(slab(kind)); g.add(lift, blob(.07, .07));
    plant(g, lat, lon, (rnd() - .5) * .5, 0, threadsG);
    g.userData = { lift, k }; if (still) thread.blocks[k].push(g); return g;
  }
  const at = (k, dlat, dlon) => [TH[k].lat + dlat, TH[k].lon + dlon];
  // what's open in each
  [[0, 'app', 8, 10], [1, 'agent', 6, -10], [1, 'term', -4, 12], [2, 'tab', 4, 13], [2, 'term', 8, -8],
   [3, 'app', 6, -10], [3, 'tab', 6, 10], [4, 'agent', 6, -12], [4, 'tab', 4, 12], [4, 'term', 1, 1]].forEach(([k, kind, a, b]) => block(kind, k, ...at(k, a, b)));
  // and in the ones round the back, two or three of anything
  const KINDS = ['app', 'agent', 'term', 'tab', 'doc', 'office'];
  for (let k = 5; k < TH.length; k++) {
    const n = 2 + (rnd() < .5), a0 = rnd() * 6.28;
    for (let i = 0; i < n; i++) {
      const a = a0 + i * 6.28 / n, r = 7 + 3 * rnd();
      block(KINDS[Math.floor(rnd() * KINDS.length)], k, TH[k].lat + r * Math.sin(a), TH[k].lon + r * Math.cos(a) / Math.max(.3, Math.cos(TH[k].lat * D2R)));
    }
  }
  // 1: the terminal, and the tab its link opens
  thread.term = block('term', 0, ...at(0, 2, -10));
  thread.tab = block('tab', 0, ...at(0, -2, 6), false);
  const ring = mesh(new THREE.RingGeometry(.82, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x5fd8ff, transparent: true, depthWrite: false }), 0, .004, 0);
  thread.term.add(ring); thread.ring = ring;
  const spark = new THREE.Group(); spark.add(mesh(new THREE.SphereGeometry(.009, 12, 8), glowMat(0xffffff)), halo(0x5fd8ff, .08)); threadsG.add(spark);
  thread.spark = spark;
  // 2: the document, and its window
  thread.doc = block('doc', 2, ...at(2, 2, 2));
  const win = slab('win'); win.visible = false; thread.doc.userData.lift.add(win);
  thread.docFace = thread.doc.userData.lift.children[0]; thread.winFace = win;
  // 3: LibreOffice, a copy each side of the range between threads 1 and 3
  const a = thSeeds[1], b = thSeeds[3], ll = v => [Math.asin(v.y) / D2R, Math.atan2(v.x, v.z) / D2R];
  thread.offices = [[.34, 1], [.66, 3]].map(([f, k]) => {
    const s = block('office', k, ...ll(a.clone().lerp(b, f).normalize()), false);
    const r = ring.clone(); r.material = ring.material.clone(); s.add(r); s.userData.ring = r; return s;
  });
  // the range between them lights up: a curtain of light along it
  const between = ridges.find(r => r.i === 1 && r.j === 3);
  if (between) {
    const pts = between.pts.filter((_, k) => k % 4 === 0 && between.pts[k].z > .32), pos = [], uv = [], idx = [];
    pts.forEach((p, k) => {
      pos.push(...p.clone().multiplyScalar(.998).toArray(), ...p.clone().multiplyScalar(1.13).toArray()); uv.push(k / (pts.length - 1), 0, k / (pts.length - 1), 1);
      if (k) { const o = 2 * k; idx.push(o - 2, o - 1, o, o, o - 1, o + 1); }
    });
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx);
    thread.wall = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: { opacity: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: `varying vec2 vUv;
#include <clipping_planes_pars_vertex>
void main() { vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(position, 1.); gl_Position = projectionMatrix * mvPosition;
#include <clipping_planes_vertex>
}`,
      fragmentShader: `uniform float opacity; varying vec2 vUv;
#include <clipping_planes_pars_fragment>
void main() {
#include <clipping_planes_fragment>
  float a = (1. - vUv.y) * (.6 + .4 * sin(vUv.y * 40. - vUv.x * 6.)) * smoothstep(0., .08, vUv.x) * smoothstep(1., .92, vUv.x);
  gl_FragColor = vec4(vec3(.5, .95, 1.) * a * opacity, 1.); }`,
    }));
    threadsG.add(thread.wall);
  }
  // the signals: two to a thread, hopping from block to block
  thread.signals = TH.flatMap((_, k) => [0, 1].map(i => {
    const g = new THREE.Group(); g.add(mesh(new THREE.SphereGeometry(.009, 10, 8), glowMat(0xffffff)), halo(thread.cols[k], .11)); threadsG.add(g);
    return { g, k, from: null, to: null, t0: -1, dur: 1, wait: i * .6 };
  }));
}
const LOOP = 12;
function threadsAt(T) {   // the loop, T seconds in (or -1 before it starts: everything at rest)
  const show = (o, s) => { o.visible = s > .002; o.scale.setScalar(Math.max(.002, s)); };
  const out = 1 - ease(sub(T, 10.4, 11));
  // a link in the terminal: a pulse, a spark over to the tab, and the tab comes up
  const p = sub(T, .4, 1.4);
  thread.ring.visible = p > 0 && p < 1; thread.ring.scale.setScalar(.03 + .12 * p); thread.ring.material.opacity = .9 * (1 - p);
  const f = sub(T, .8, 1.7), A = thread.term.position, B = thread.tab.position;
  thread.spark.visible = f > 0 && f < 1;
  thread.spark.position.lerpVectors(A, B, ease(f)).normalize().multiplyScalar(1.05 + .1 * Math.sin(Math.PI * f));
  show(thread.tab, outBack(sub(T, 1.6, 2.1)) * out);
  // the document hops, turns over, and lands as its app's window
  const fl = clamp01(sub(T, 4, 4.8) - sub(T, 10.4, 11.2)), lift = thread.doc.userData.lift;
  thread.docFace.visible = fl < .5; thread.winFace.visible = fl >= .5;
  lift.position.y = .06 * Math.sin(Math.PI * fl); lift.rotation.z = Math.PI * ease(fl) - (fl >= .5 ? Math.PI : 0);
  // LibreOffice, twice; the range between them lights up
  const o = outBack(sub(T, 6.6, 7.1)) * out;
  for (const s of thread.offices) {
    show(s, o); const q = sub(T, 6.9, 7.9), r = s.userData.ring;
    r.visible = q > 0 && q < 1; r.scale.setScalar(.03 + .14 * q); r.material.opacity = .9 * (1 - q);
  }
  if (thread.wall) thread.wall.material.uniforms.opacity.value = .8 * Math.sin(Math.PI * sub(T, 7, 9.6));
}
const vH = new THREE.Vector3();
function signalsAt(t) {   // each signal hops on to another block of its thread that's showing, in an arc
  for (const s of thread.signals) {
    const here = [...thread.blocks[s.k], ...[thread.tab, ...thread.offices].filter(b => b.userData.k === s.k && b.visible && b.scale.x > .9)];
    if (t - s.t0 > s.dur + s.wait || !here.includes(s.to)) {
      s.from = here.includes(s.to) ? s.to : here[Math.floor(Math.random() * here.length)];
      const next = here.filter(b => b !== s.from); s.to = next[Math.floor(Math.random() * next.length)] || s.from;
      s.t0 = t; s.dur = .45 + .25 * Math.random() + s.from.position.distanceTo(s.to.position) * 2; s.wait = .1 + .5 * Math.random();
    }
    const f = clamp01((t - s.t0) / s.dur), d = s.from.position.distanceTo(s.to.position);
    s.g.position.lerpVectors(s.from.position, s.to.position, ease(f)).normalize().multiplyScalar(1.035 + (.03 + d * .5) * Math.sin(Math.PI * f));
    s.g.scale.setScalar(f < 1 ? 1 : Math.max(.01, 1 - (t - s.t0 - s.dur) / s.wait));
  }
}

// ---- agents: an astronaut on a board, towed over the dust by rovers ----------------------------------
// They stay where they are on the face while the planet turns under them. The rovers are in AI labs' colours,
// each with the window it's driving on a screen on its back; the astronaut only holds the bar. Each carve
// throws up a spray of dust, and the board and the wheels leave tracks.
const agentsG = new THREE.Group(); tiltG.add(agentsG);
const TREAD = 1;   // how fast the planet turns under them, radians a second
function rover(body, top, kind, s) {   // built in its own units, about 1.1 long, x forward; scaled by s
  const g = new THREE.Group(), white = toon(top), dark = toon(0x3a3358), mid = toon(0x6a6896);
  g.add(box(1, .3, .62, toon(body), 0, .44, 0), box(.92, .06, .56, white, 0, .62, 0), box(.42, .04, .5, toon(0x2c3a7a), .18, .68, 0));
  const wheels = [];
  for (let i = 0; i < 6; i++) {
    const wg = new THREE.Group(); wg.position.set((i % 3 - 1) * .38, .16, i < 3 ? .38 : -.38);
    const w = cyl(.16, .12, dark, 0, 0, 0, 10); w.rotation.x = Math.PI / 2;
    const hub = cyl(.07, .13, mid, 0, 0, 0, 8); hub.rotation.x = Math.PI / 2;
    wg.add(w, hub, box(.28, .05, .135, mid, 0, 0, 0)); g.add(wg); wheels.push(wg);
  }
  g.add(box(.9, .05, .06, mid, 0, .3, .38), box(.9, .05, .06, mid, 0, .3, -.38));
  g.add(cyl(.035, .5, white, .32, .9, 0, 10));
  const head = new THREE.Group(); head.position.set(.32, 1.18, 0);
  head.add(box(.24, .14, .3, white, 0, 0, 0));
  for (const z of [-.07, .07]) { const e = cyl(.045, .04, glowMat(0x7ff3ff), .12, 0, z, 14); e.rotation.z = Math.PI / 2; head.add(e); }
  g.add(head);
  // the screen on its back, tipped toward the camera's side
  const screen = new THREE.Group(); screen.position.set(-.26, 1.02, .05); screen.rotation.set(-.3, .25, 0);
  screen.add(box(.66, .45, .03, toon(0x2b2456), 0, 0, -.016), mesh(new THREE.PlaneGeometry(.62, .41), new THREE.MeshBasicMaterial({ map: windowTex(kind), transparent: true })));
  g.add(screen, cyl(.025, .35, mid, -.26, .72, 0, 8), blob(.75, .55));
  g.scale.setScalar(s); g.userData = { head, wheels }; return g;
}
function surfer() {   // built in its own units, about 2.3 tall, the board along x, facing +z (the camera's side)
  const g = new THREE.Group(), body = new THREE.Group(), suit = toon(0xf4f1fb), grey = toon(0xc9c2e6), dark = toon(0x3a3358);
  const sh = new THREE.Shape();
  sh.moveTo(-1.2, 0); sh.quadraticCurveTo(-1.25, .34, -.6, .38); sh.quadraticCurveTo(.9, .4, 1.45, 0);
  sh.quadraticCurveTo(.9, -.4, -.6, -.38); sh.quadraticCurveTo(-1.25, -.34, -1.2, 0);
  const bg = new THREE.ExtrudeGeometry(sh, { depth: .08, bevelEnabled: true, bevelThickness: .03, bevelSize: .03, bevelSegments: 2 }).rotateX(Math.PI / 2).translate(0, .12, 0);
  const board = new THREE.Group(); board.add(mesh(bg, toon(0xff7f5c)), box(2.1, .012, .09, toon(0xfff4e8), .1, .126, 0)); g.add(board, body);
  // jointed, at rest in the riding pose: hips and knees (back leg first), the waist, the head, shoulders and
  // elbows (far arm first), and a hand at the end of each
  const joint = (parent, x, y, z) => { const j = new THREE.Group(); j.position.set(x, y, z); parent.add(j); return j; };
  const hips = [], knees = [], shoulders = [], elbows = [], hands = [];
  for (const s of [-1, 1]) {   // legs, knees toward the camera, and boots
    const hip = joint(body, s * .16, 1.02, 0); hip.add(limb([0, 0, 0], [s * .26, -.4, .2], .14, suit));
    const knee = joint(hip, s * .26, -.4, .2); knee.add(limb([0, 0, 0], [s * .13, -.42, -.2], .13, suit), box(.3, .14, .22, dark, s * .16, -.43, -.2));
    hips.push(hip); knees.push(knee);
  }
  const waist = joint(body, 0, 1.05, 0);
  waist.add(limb([0, 0, 0], [-.1, .47, 0], .32, suit), box(.46, .56, .26, grey, -.12, .27, -.32));
  const head = joint(waist, -.14, .97, 0);
  head.add(mesh(new THREE.SphereGeometry(.31, 24, 16), suit), mesh(new THREE.SphereGeometry(.23, 24, 16), toon(0xffbe55), .12, .02, .14));
  for (const z of [-.2, .2]) {
    const sh = joint(waist, -.08, .57, z); sh.add(limb([0, 0, 0], [.34, -.12, -z * .25], .1, suit));
    const el = joint(sh, .34, -.12, -z * .25); el.add(limb([0, 0, 0], [.36, -.1, -z * .25], .1, suit));
    shoulders.push(sh); elbows.push(el); hands.push(joint(el, .36, -.1, -z * .25));
  }
  const bar = cyl(.03, .64, dark, 0, 0, 0, 8); bar.rotation.x = Math.PI / 2; g.add(bar);   // the tow bar: in his hands, or let go of
  g.userData = { body, board, bar, hips, knees, waist, head, shoulders, elbows, hands }; return g;
}
// a pose, from keyframes [t, {channel: value}] (channels missing are 0, the riding pose), eased between
function posed(keys, t, out = {}) {
  let i = 0; while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const [t0, a] = keys[i], [t1, b] = keys[i + 1], f = ease(clamp01((t - t0) / (t1 - t0)));
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = lerp(a[k] ?? 0, b[k] ?? 0, f);
  return out;
}
// the fall. bz: the body pitched over (a quarter turn is on his side); wz: bent at the waist; hz: the head;
// az: both arms up from the bar (round toward over his head), fl: how far they flail apart; ez: the elbows;
// lb, lf: the back and front legs swung forward of under him; kn: the knees bent
const FALL_KEYS = [
  [0, {}],
  [.1, { bz: -.4, wz: -.35, hz: .35, az: 1.4, fl: .3, ez: .4, lb: .2, lf: -.2, kn: .3 }],        // stopped dead: pitched on, arms up
  [.32, { bz: -1.05, wz: -.15, hz: .5, az: 2.3, fl: .9, ez: .9, lb: .7, lf: -.4, kn: .7 }],       // over the nose, flailing, legs kicked up
  [.55, { bz: -1.75, wz: .05, hz: -.1, az: 1.5, fl: .2, ez: .1, lb: .5, lf: -.5, kn: .4 }],       // arms out for the ground
  [.68, { bz: -1.78, wz: .3, hz: .35, az: 1.9, fl: .5, ez: .7, lb: .3, lf: -.65, kn: .9 }],       // down: the legs whip up, and flop
  [.95, { bz: -1.78, wz: .1, hz: .1, az: 2, fl: .2, ez: .4, lb: .65, lf: -.28, kn: .45 }],        // sprawled
];
// on his feet: arms down, then the hop: crouched, arms swung back; up, knees tucked; and down on the board
const STAND = { az: -1.35, ez: .3, fl: .1, lb: .2, lf: -.2 };
const HOP_KEYS = [
  [0, STAND],
  [.16, { az: -2, ez: .2, wz: -.3, kn: .7, lb: .2, lf: -.2 }],
  [.38, { az: .6, ez: .5, wz: -.1, kn: 1.1, lb: -.5, lf: .5, hz: .2 }],
  [.55, { kn: .25 }],
];
const astro = surfer(); astro.scale.setScalar(.09); agentsG.add(astro);
const ASTRO = { lat: 13, lon: -34, swing: 7, w: 1.9 };
const ROVERS = [
  { body: 0xd97757, top: 0xf0eee6, lat: 30, lon: 2, ph: 0 },      // clay
  { body: 0x16151c, top: 0xf6f6f6, lat: 2, lon: 4, ph: 2.1 },    // black and white
  { body: 0x4285f4, top: 0xf6f8ff, lat: 16, lon: 15, ph: 4.2 },   // blue
  { body: 0xfa520f, top: 0xfff1e6, lat: 33, lon: 28, ph: 1.3 },   // orange
  { body: 0xc9cdd6, top: 0x1d1d22, lat: 4, lon: 32, ph: 3.4 },   // silver and black
].map((r, i) => { r.g = rover(r.body, r.top, i % 3, .15); agentsG.add(r.g); return r; });
// the tow lines: a thin tube from the bar to each rover's hitch
const ropeMat = toon(0xf4f1fb), RS = 18, RR = 5;
for (const r of ROVERS) {
  const geo = new THREE.BufferGeometry(), idx = [];
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((RS + 1) * RR * 3), 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array((RS + 1) * RR * 3), 3));
  for (let i = 0; i < RS; i++) for (let k = 0; k < RR; k++) { const a = i * RR + k, b = i * RR + (k + 1) % RR; idx.push(a, b, a + RR, b, b + RR, a + RR); }
  geo.setIndex(idx); r.rope = new THREE.Mesh(geo, ropeMat); r.rope.frustumCulled = false; agentsG.add(r.rope);
}
const vR = new THREE.Vector3(), vS = new THREE.Vector3(), vT = new THREE.Vector3(), vU = new THREE.Vector3(), vW = new THREE.Vector3();
function setRope(rope, a, b, sag) {
  const P = rope.geometry.attributes.position, Nn = rope.geometry.attributes.normal;
  vT.subVectors(b, a).normalize(); vU.copy(a).add(b).normalize(); vW.crossVectors(vT, vU).normalize(); vU.crossVectors(vW, vT);
  for (let i = 0; i <= RS; i++) {
    const f = i / RS; vR.lerpVectors(a, b, f).addScaledVector(vU, -sag * 4 * f * (1 - f));
    for (let k = 0; k < RR; k++) {
      const th = k / RR * Math.PI * 2; vS.copy(vU).multiplyScalar(Math.cos(th)).addScaledVector(vW, Math.sin(th));
      Nn.setXYZ(i * RR + k, vS.x, vS.y, vS.z); P.setXYZ(i * RR + k, vR.x + vS.x * .0028, vR.y + vS.y * .0028, vR.z + vS.z * .0028);
    }
  }
  P.needsUpdate = Nn.needsUpdate = true;
}
// the spray: bits of dust thrown up from the board's tail, falling back
const SPRAY = 320, sprayMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), toon(0xffffff, { flat: true }), SPRAY);
const sprayCols = [0xc8323f, 0xe0566a, 0x9c1a2c, 0xf08a90, 0xb52235].map(c => new THREE.Color(c));
const bits = Array.from({ length: SPRAY }, (_, i) => { sprayMesh.setColorAt(i, sprayCols[i % 5]); return { p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1, s: 0 }; });
sprayMesh.frustumCulled = false; agentsG.add(sprayMesh);
let nextBit = 0, sprayDebt = 0;
const bitO = new THREE.Object3D();
// the tracks, left on the ground: they turn with the planet, so they trail away behind
const trailMat = (color, opacity) => new THREE.ShaderMaterial({
  uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: opacity } }, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  vertexShader: `attribute float alpha; varying float vA;
#include <clipping_planes_pars_vertex>
void main() { vA = alpha; vec4 mvPosition = modelViewMatrix * vec4(position, 1.); gl_Position = projectionMatrix * mvPosition;
#include <clipping_planes_vertex>
}`,
  fragmentShader: `uniform vec3 color; uniform float opacity; varying float vA;
#include <clipping_planes_pars_fragment>
void main() {
#include <clipping_planes_fragment>
  gl_FragColor = vec4(color, vA * opacity); }`,
});
const dustG = new THREE.Group(); spinG.add(dustG);
const TRAIL_N = 200, TRAIL_LIFE = 7;
function trail(width, color, opacity) {
  const geo = new THREE.BufferGeometry(), idx = [];
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(TRAIL_N * 2 * 3), 3));
  geo.setAttribute('alpha', new THREE.Float32BufferAttribute(new Float32Array(TRAIL_N * 2), 1));
  for (let i = 0; i < TRAIL_N - 1; i++) { const a = 2 * i; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  geo.setIndex(idx);
  const m = new THREE.Mesh(geo, trailMat(color, opacity)); m.frustumCulled = false; dustG.add(m);
  return { m, width, opacity, pts: [] };
}
const trails = [trail(.014, 0x5a0716, .55), ...ROVERS.flatMap(() => [trail(.006, 0x4a0614, .5), trail(.006, 0x4a0614, .5)])];
function drawTrail(tr, t) {
  const P = tr.m.geometry.attributes.position, A = tr.m.geometry.attributes.alpha, pts = tr.pts;
  while (pts.length && t - pts[0].t > TRAIL_LIFE) pts.shift();
  for (let i = 0; i < TRAIL_N; i++) {
    const k = pts.length - 1 - i;
    if (k < 0) { for (const s of [0, 1]) { P.setXYZ(2 * i + s, 0, 0, 0); A.setX(2 * i + s, 0); } continue; }
    const p = pts[k].p, q = pts[Math.max(0, k - 1)].p, r = pts[Math.min(pts.length - 1, k + 1)].p;
    vT.subVectors(r, q); if (vT.lengthSq() < 1e-12) vT.set(1, 0, 0);
    vW.crossVectors(p, vT).normalize();
    const a = (1 - (t - pts[k].t) / TRAIL_LIFE) * Math.min(1, i / 3);
    for (const s of [0, 1]) { vR.copy(p).multiplyScalar(1.0015).addScaledVector(vW, (s ? 1 : -1) * tr.width); P.setXYZ(2 * i + s, vR.x, vR.y, vR.z); A.setX(2 * i + s, a); }
  }
  P.needsUpdate = A.needsUpdate = true;
}
// phi: how far round from the front they are (radians, east positive); the ground carries them, and riding,
// the rovers pull them east over it at s, as fast as gets them back to the front. Stop the planet in a hand and
// the astronaut's thrown off; he lies where he fell, goes round with the ground, and comes back round on his
// feet, to hop on again. state: ride, fall, stand or hop, st seconds in; carve and roll, how far the astronaut's
// and the rovers' weaving has got, which goes with the speed.
const agent = { phi: Infinity, s: 0, lastA: 0, state: 'ride', st: 0, carve: 0, roll: 0, lastSample: 0, fade: 0, bar0: new THREE.Vector3() };
const S_MIN = .5, S_MAX = 2.8, BACK = 2.2, FALL = .6, HOP = .55;   // BACK: carried this far past the left, they're coming round on the right
function agentsTo(phi) { Object.assign(agent, { phi, s: phi === 0 ? TREAD : 0, lastA: spin.a, state: 'ride', st: 0 }); }
function agentsMove(dt) {
  const A = agent, d = spin.a - A.lastA; A.lastA = spin.a;
  if (!isFinite(A.phi)) return;
  A.phi += d + A.s * dt; A.st += dt;
  if (cur !== AGENTS) { A.s = 0; if (Math.abs(A.phi) > 1.9) A.phi = Infinity; return; }   // left behind, and gone
  if (A.phi < -BACK || A.phi > 2 * Math.PI - BACK) {   // round the back
    A.phi = THREE.MathUtils.euclideanModulo(A.phi + BACK, 2 * Math.PI) - BACK;
    if (A.state === 'fall') { A.state = 'stand'; A.st = 0; }
  }
  if (A.state === 'ride' && spin.drag && Math.abs(spin.w) < .1 && Math.abs(A.phi) < 1.6) { A.state = 'fall'; A.st = 0; }
  else if (A.state === 'stand' && A.phi < 1) { A.state = 'hop'; A.st = 0; }
  else if (A.state === 'hop' && A.st > HOP) { A.state = 'ride'; A.st = 0; }
  // riding, back toward the front, and never quite still; out of sight round the right, at the usual pace while
  // the ground brings them
  const want = A.state !== 'ride' ? 0 : A.phi > 1.9 ? TREAD : THREE.MathUtils.clamp(-spin.w - 1.5 * A.phi, S_MIN, S_MAX);
  A.s += (want - A.s) * (1 - Math.exp(-dt * (A.state === 'ride' ? 3 : 30)));
}
const vG = new THREE.Vector3(), vN = new THREE.Vector3(), vE = new THREE.Vector3(), vZ = new THREE.Vector3();
function agentsAt(t, dt, here) {
  const A = agent, riding = here && A.state === 'ride', r = Math.min(2, A.s / TREAD);   // r: the pace, 1 the usual
  A.carve += dt * ASTRO.w * r; A.roll += dt * 1.3 * r;
  // the astronaut carves: swinging north and south as the ground goes by, the board along the way it's going
  const lat = ASTRO.lat + ASTRO.swing * Math.sin(A.carve);
  const vNorth = ASTRO.swing * ASTRO.w * Math.cos(A.carve), aNorth = -ASTRO.swing * ASTRO.w * ASTRO.w * r * r * Math.sin(A.carve);
  const ahead = TREAD / D2R * Math.cos(lat * D2R);   // degrees a second, along the ground, at the usual pace
  place(astro, lat, ASTRO.lon, Math.atan2(vNorth, ahead));
  const U = astro.userData, { body, board, bar } = U;
  body.position.set(0, 0, 0); body.rotation.set(0, 0, 0); board.position.set(0, 0, 0); board.rotation.set(0, 0, 0);
  let burst = false, p = {};
  if (A.state === 'ride') {   // leaning into the carve, and back on the bar when he's pulled hard
    body.rotation.x = THREE.MathUtils.clamp(aNorth * .0035, -.32, .32); board.rotation.x = body.rotation.x * .6;
    body.rotation.z = THREE.MathUtils.clamp((r - 1) * .14, 0, .24);
  } else if (A.state === 'fall') {   // thrown on over the nose, down on his side in the dust; the board skids on
    const u = Math.min(1, A.st / FALL), b = Math.min(1, A.st / .9), k = Math.max(0, A.st - FALL);
    posed(FALL_KEYS, A.st, p);
    p.fl *= Math.sin(A.st * 30);   // the flailing
    if (A.st > 1.6) {   // dazed: the head comes up, and a hand, now and then, to say he's all right
      const w = Math.max(0, Math.sin((A.st - 1.6) * 1.4)) ** 2;
      p.hz += .5 * w; p.wave = 1.3 * w; p.wx = .7 * w * Math.sin(A.st * 9); p.ez += .6 * w;
    }
    body.position.set(1.1 * u * (2 - u), .3 * u + 2.8 * u * (1 - u) + .14 * Math.abs(Math.sin(k * 12)) * Math.exp(-k * 8), .2 * u);
    body.rotation.set(.25 * Math.sin(Math.PI * u), 0, p.bz);
    board.position.x = .5 * b * (2 - b); board.rotation.z = .3 * Math.sin(Math.PI * b); board.rotation.y = .25 * b;
    burst = A.st >= FALL && A.st - dt < FALL;
  } else {   // on his feet by the board, dusting himself off; then up, and on
    const h = A.state === 'hop' ? A.st / HOP : 0, e = ease(h);
    if (A.state === 'hop') posed(HOP_KEYS, A.st, p); else Object.assign(p, STAND, { ez: .3 + .5 * Math.max(0, Math.sin(t * 9)), hz: .1 * Math.sin(t * 2) });
    body.position.set(-.25 * (1 - e), -.12 * (1 - e) + 1.2 * 4 * h * (1 - h) - .18 * (p.kn ?? 0) * (1 - 4 * h * (1 - h)), .8 * (1 - e));
    body.rotation.y = .4 * (1 - e);
  }
  // the joints
  const fl = p.fl ?? 0, kn = p.kn ?? 0;
  U.hips[0].rotation.set(-kn, 0, p.lb ?? 0); U.hips[1].rotation.set(-kn, 0, p.lf ?? 0);
  for (const k of U.knees) k.rotation.x = 2 * kn;
  U.waist.rotation.z = p.wz ?? 0; U.head.rotation.z = p.hz ?? 0;
  U.shoulders.forEach((s, i) => s.rotation.set(i ? p.wx ?? 0 : 0, 0, (p.az ?? 0) + (i ? fl + (p.wave ?? 0) : -fl)));
  U.elbows.forEach((e, i) => e.rotation.z = (p.ez ?? 0) * (i ? 1 : .7));
  // the bar: in his hands; let go of, it drops in front of the board and lies there; picked up on the hop
  const inAstro = (o, v) => { v.set(0, 0, 0); for (; o !== astro; o = o.parent) { o.updateMatrix(); v.applyMatrix4(o.matrix); } return v; };
  inAstro(U.hands[0], vS).add(inAstro(U.hands[1], vT)).multiplyScalar(.5);   // between his hands
  if (A.state === 'ride' || A.state === 'fall' && A.st < .08) { bar.position.copy(vS); A.bar0.copy(vS); }
  else if (A.state === 'fall') { const k = clamp01((A.st - .08) / .45); bar.position.lerpVectors(A.bar0, vT.set(3.6, .05, 0), k); bar.position.y += .8 * k * (1 - k); }
  else bar.position.lerpVectors(vT.set(1.8, .05, 0), vS, A.state === 'hop' ? ease(clamp01((A.st / HOP - .5) / .35)) : 0);
  astro.updateMatrix();
  vG.copy(bar.position).applyMatrix4(astro.matrix);
  // the rovers weave a little, and bounce, going; the lines from the bar to their hitches, slack when he's off
  ROVERS.forEach(rv => {
    const rl = rv.lat + 2.4 * Math.sin(A.roll + rv.ph), vn = 2.4 * 1.3 * Math.cos(A.roll + rv.ph);
    place(rv.g, rl, rv.lon, Math.atan2(vn, ahead), .0025 * Math.min(1, r) * Math.abs(Math.sin(t * 9 + rv.ph)));
    rv.g.updateMatrix();
    for (const w of rv.g.userData.wheels) w.rotation.z -= dt * 7 * r;
    rv.g.userData.head.rotation.y = .3 * Math.sin(t * 1.1 + rv.ph);
    // (slack, it lies along the ground: bowed out by as far as the ground bulges between its ends)
    const hitch = vS.set(-.56, .45, 0).applyMatrix4(rv.g.matrix).clone();
    setRope(rv.rope, vG, hitch, A.state === 'ride' ? .008 : Math.cos(vG.angleTo(hitch) / 2) - 1.002);
  });
  // where he lands, a puff of dust
  if (burst) for (let n = 0; n < 60; n++) {
    const b = bits[nextBit = (nextBit + 1) % SPRAY];
    b.p.set(1.4 + 1.6 * Math.random(), .1, (Math.random() - .5) * .8).applyMatrix4(astro.matrix);
    vN.copy(b.p).normalize(); vE.set(Math.random() - .5, 0, Math.random() - .5).applyQuaternion(astro.quaternion);
    b.v.copy(vN).multiplyScalar(.2 + .4 * Math.random()).addScaledVector(vE, .5);
    b.life = 0; b.max = .4 + .5 * Math.random(); b.s = .004 + .006 * Math.random();
  }
  // the spray, from the tail on the outside of the turn
  const side = Math.sign(-aNorth) || 1, strength = .3 + .7 * Math.abs(Math.sin(A.carve));
  sprayDebt += dt * (riding ? (120 + 260 * strength) * Math.min(1.5, r) : 0);
  const q = astro.quaternion;
  while (sprayDebt >= 1) {
    sprayDebt--;
    const b = bits[nextBit = (nextBit + 1) % SPRAY];
    b.p.set(-1.05 + .3 * Math.random(), .12, side * -.36).applyMatrix4(astro.matrix);
    vN.copy(b.p).normalize(); vZ.set(0, 0, side * -1).applyQuaternion(q); vE.set(1, 0, 0).applyQuaternion(q);
    b.v.copy(vN).multiplyScalar(.35 + .45 * Math.random() * strength).addScaledVector(vZ, .18 + .3 * Math.random() * strength).addScaledVector(vE, -.25 - .2 * Math.random());
    b.life = 0; b.max = .45 + .45 * Math.random(); b.s = .004 + .007 * Math.random();
  }
  const o = bitO;
  bits.forEach((b, i) => {
    if (b.life < b.max) {
      b.life += dt; vN.copy(b.p).normalize(); b.v.addScaledVector(vN, -2.6 * dt); b.p.addScaledVector(b.v, dt);
      if (b.p.length() < 1) b.life = b.max;
    }
    const k = b.life < b.max ? Math.min(1, (b.max - b.life) * 4) : 0;
    o.position.copy(b.p); o.rotation.set(i, i * 2, b.life * 6); o.scale.setScalar(Math.max(1e-4, b.s * k)); o.updateMatrix();
    sprayMesh.setMatrixAt(i, o.matrix);
  });
  sprayMesh.instanceMatrix.needsUpdate = true;
  // the tracks: points on the ground under the board and the wheels, kept where they are on the planet
  if (riding && t - agent.lastSample > 1 / 40) {
    agent.lastSample = t;
    const turn = agentsG.rotation.y - spinG.rotation.y, mark = (tr, v) => tr.pts.push({ t, p: v.normalize().applyAxisAngle(Y, turn) });
    mark(trails[0], vS.set(-.9, 0, 0).applyMatrix4(astro.matrix).clone());
    ROVERS.forEach((r, i) => { for (const s of [0, 1]) mark(trails[1 + 2 * i + s], vS.set(-.38, 0, s ? .38 : -.38).applyMatrix4(r.g.matrix).clone()); });
  }
  // leaving, the tracks fade out, and are gone
  agent.fade = clamp01(agent.fade + (here ? dt : -dt) / .8);
  for (const tr of trails) {
    if (!agent.fade && !here) tr.pts.length = 0;
    tr.m.visible = tr.pts.length > 0; tr.m.material.uniforms.opacity.value = tr.opacity * agent.fade;
    if (tr.m.visible) drawTrail(tr, t);
  }
}

// ---- the open source stop: the planet is set on a stand, as a globe, on a table --------------------------
// The stand comes together round it: the axle slides through the poles, the half ring sweeps round from the
// north pole to the south, and the table rises underneath with the foot on it. On the globe, the roadmap: a
// trail of pins, planted where it's been, and a dashed string on to what's next.
const qGlobe = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -23.4 * D2R));   // the axis leans right
const BRASS = toon(0xf0bd5e), BRASS_D = toon(0xc98f3c), TABLE_Y = -1.8, MER_R = 1.3;   // the ring well clear of the pins' flags
const mount = new THREE.Group(); mount.quaternion.copy(qGlobe); rootG.add(mount);   // the axle and the ring, tilted
const axle = new THREE.Group(); mount.add(axle);
axle.add(cyl(.022, 2 * MER_R + .12, BRASS, 0, 0, 0, 12));
for (const s of [-1, 1]) axle.add(mesh(new THREE.SphereGeometry(.05, 16, 12), BRASS, 0, s * (MER_R + .08), 0));
const meridian = new THREE.Mesh(new THREE.BufferGeometry(), BRASS); mount.add(meridian);
let merArc = -1;
function setArc(f) {   // the half ring, drawn round from the north pole a fraction f of the way to the south
  if (Math.abs(f - merArc) < 1e-3) return;
  merArc = f; meridian.visible = f > .002; meridian.geometry.dispose();
  meridian.geometry = new THREE.TorusGeometry(MER_R, .04, 10, Math.max(2, Math.round(96 * f)), Math.PI * f);
  meridian.rotation.z = Math.PI / 2 - Math.PI * f;
}
// marks round the ring, every 15°, that come with it
const ticks = new THREE.Group(); mount.add(ticks);
for (let i = 1; i < 12; i++) {
  const a = Math.PI / 2 - i * Math.PI / 12, tk = box(.012, .07, .09, BRASS_D, Math.cos(a) * MER_R, Math.sin(a) * MER_R, 0);
  tk.rotation.z = a - Math.PI / 2; tk.userData.f = i / 12; ticks.add(tk);
}
// the roadmap's pins, on the cover's face: green planted flags for what works, amber for what's next, hollow
// for later; a string through the planted ones, dashes on from there
function flag(color, h, hollow) {
  const g = new THREE.Group();
  g.add(cyl(.005, h, toon(0xf4f1fb), 0, h / 2, 0, 6), mesh(new THREE.SphereGeometry(.014, 12, 8), toon(color), 0, .006, 0));
  const shape = new THREE.Shape(); shape.moveTo(0, 0); shape.lineTo(h * .5, -h * .14); shape.lineTo(0, -h * .3); shape.closePath();
  const cloth = new THREE.Group(); cloth.position.y = h;
  cloth.add(mesh(new THREE.ShapeGeometry(shape), hollow ? new THREE.MeshBasicMaterial({ color, wireframe: true }) : toon(color, { side: THREE.DoubleSide })));
  g.add(cloth);
  const ph = rnd() * 6; anims.push(t => { cloth.rotation.y = .35 * Math.sin(t * 2.4 + ph); });
  return g;
}
const pinsG = new THREE.Group(); spinG.add(pinsG);
const ROUTE = [[-42, -58, 0], [-30, -40, 0], [-16, -26, 0], [-2, -12, 0], [14, 2, 1], [28, 14, 1], [40, 30, 1], [48, 50, 2], [52, 72, 2]];
const pins = ROUTE.map(([lat, lon, k]) => plant(flag([0x7cf08e, 0xffc861, 0xb9b0ee][k], .16, k === 2), lat, lon, -.4, 0, pinsG));
const strings = [];
{
  const arc = (a, b) => { const A = dir(...a), B = dir(...b), pts = []; for (let i = 0; i <= 16; i++) pts.push(A.clone().lerp(B, i / 16).normalize().multiplyScalar(1.004)); return pts; };
  const done = ROUTE.filter(r => r[2] === 0), ahead = ROUTE.slice(done.length - 1);
  // a string: a thin tube along the ground; dashed, as short tubes with gaps
  const tube = (pts, dashed) => {
    const geos = [];
    if (!dashed) geos.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, .006, 5));
    else for (let i = 0; i + 1 < pts.length; i += 2) geos.push(new THREE.TubeGeometry(new THREE.LineCurve3(pts[i], pts[i + 1]), 1, .006, 5));
    return geos.map(g => mesh(g, new THREE.MeshBasicMaterial({ color: 0x7a3550, transparent: true })));
  };
  const along = (route, n) => route.slice(1).flatMap((r, i) => arc(route[i], r).slice(i ? 1 : 0)).filter((_, k) => k % n === 0);
  for (const m of [...tube(along(done, 1), false), ...tube(along(ahead, 3), true)]) { pinsG.add(m); strings.push(m); }
}
// the table, and on it the foot of the stand and a few things
const desk = new THREE.Group(); rootG.add(desk);
{
  const top = toon(0x6e3f63), wood = toon(0x8e4e3c);
  desk.add(box(24, .18, 3.6, top, 0, TABLE_Y - .09, .1));
  const foot = mesh(new THREE.LatheGeometry([[0, 0], [.46, 0], [.47, .05], [.4, .09], [.22, .14], [.12, .2], [.09, .26], [0, .26]].map(([x, y]) => new THREE.Vector2(x, y)), 40), wood, 0, TABLE_Y, 0);
  const post = -MER_R - .04;
  desk.add(foot, cyl(.042, post - (TABLE_Y + .26), BRASS, 0, (post + TABLE_Y + .26) / 2, 0, 16), cyl(.07, .05, BRASS_D, 0, TABLE_Y + .27, 0, 20));
  const shadow = blob(.62, .5); shadow.position.y = TABLE_Y + .004; desk.add(shadow);
}
const deskProps = [];   // each pops up in turn once the table's there
{
  const white = toon(0xf4f1fb), ink = '#3b3a6e', serif = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
  const flatTex = (tex, w, d) => mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex }));
  const stack = new THREE.Group();
  [[.95, .17, .64, 0xff7f5c, .05], [.86, .15, .6, 0x5b6fd8, -.08], [.9, .13, .62, 0xffc861, .12]].reduce((y, [w, h, d, c, yaw]) => {
    const b = new THREE.Group(); b.position.y = y + h / 2; b.rotation.y = yaw;
    b.add(box(w, h, d, toon(c), 0, 0, 0), box(w - .06, h * .7, d + .012, white, .03, 0, 0)); stack.add(b); return y + h;
  }, 0);
  stack.position.set(2.1, TABLE_Y, .3); stack.rotation.y = -.3; desk.add(stack); deskProps.push(stack);
  // an open notebook: the roadmap as a checklist, what's done ticked off
  const page = lines => canvasTex(256, 340, (x, W, H) => {
    x.fillStyle = '#fbf7ee'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#c9d6f2'; for (let y = 70; y < H; y += 34) x.fillRect(0, y, W, 2);
    let y = 54;
    for (const [mark, s] of lines) {
      if (mark === '#') { x.font = `italic 30px ${serif}`; x.fillStyle = '#c0413f'; x.fillText(s, 22, y); y += 34; continue; }
      x.font = `italic 22px ${serif}`; x.fillStyle = mark ? '#2e9e57' : '#9b97b8';
      x.fillText(mark ? '✓' : '○', 22, y); x.fillStyle = ink; x.fillText(s, 50, y); y += 34;
    }
  });
  const book = new THREE.Group();
  book.add(box(1.36, .03, .94, toon(0x5b6fd8), 0, .015, 0));
  const left = page([['#', 'Now'], [1, 'Several monitors'], [1, 'Screen sharing'], [1, 'File picker'], [1, 'Printing, input'], [1, 'Your own shells']]);
  const right = page([['#', 'Next'], [0, 'Builds by CI'], [0, 'More portals'], [0, 'More hardware'], ['#', 'Later'], [0, 'Passwords'], [0, 'HiDPI, a11y']]);
  for (const [s, tex] of [[-1, left], [1, right]]) {
    const pg = new THREE.Group(); pg.position.set(s * .33, .045, 0); pg.rotation.z = -s * .05;
    pg.add(box(.64, .03, .88, white, 0, 0, 0)); const f = flatTex(tex, .62, .84); f.position.y = .016; pg.add(f); book.add(pg);
  }
  book.position.set(-2.15, TABLE_Y, .45); book.rotation.y = .32; desk.add(book); deskProps.push(book);
  // a mug, steaming
  const mug = new THREE.Group();
  mug.add(cyl(.16, .34, toon(0x7fd8ff), 0, .17, 0, 28), mesh(new THREE.CircleGeometry(.14, 28), toon(0x4a2a2a), 0, .33, 0));
  mug.children[1].rotation.x = -Math.PI / 2;
  const handle = mesh(new THREE.TorusGeometry(.085, .025, 8, 20, Math.PI), toon(0x7fd8ff), .16, .17, 0); handle.rotation.z = -Math.PI / 2; mug.add(handle);
  const puffs = [0, 1, 2].map(() => { const p = halo(0xffffff, .14, .5); mug.add(p); return p; });
  anims.push(t => puffs.forEach((p, i) => { const f = (t * .35 + i / 3) % 1; p.position.set(.04 * Math.sin(t * 2 + i * 2), .4 + f * .5, 0); p.material.opacity = .45 * Math.sin(f * Math.PI); p.scale.setScalar(.1 + .14 * f); }));
  mug.position.set(-1.25, TABLE_Y, 1.1); desk.add(mug); deskProps.push(mug);
  // the patch series: a stack of numbered cards, and the first one on its own
  const card = (n, sub) => canvasTex(256, 176, (x, W, H) => {
    x.fillStyle = '#fbfaff'; x.fillRect(0, 0, W, H); x.fillStyle = '#ff7f5c'; x.fillRect(0, 0, W, 14);
    x.font = '600 64px "JetBrains Mono", ui-monospace, monospace'; x.fillStyle = ink; x.textAlign = 'center'; x.fillText(n, W / 2, 104);
    x.font = '500 18px "JetBrains Mono", ui-monospace, monospace'; x.letterSpacing = '4px'; x.fillStyle = '#8e86b8'; x.fillText(sub, W / 2, 146);
  });
  const cards = new THREE.Group(), N = 9;
  for (let i = 0; i < N; i++) { const c = box(.52, .016, .36, toon(i % 2 ? 0xf6f3ff : 0xe6e0f6), 0, .008 + i * .018, 0); c.rotation.y = (hash(i, 21) - .5) * .3; cards.add(c); }
  const topCard = flatTex(card('0093', 'PATCH'), .5, .34); topCard.position.y = N * .018 + .001; topCard.rotation.y = cards.children[N - 1].rotation.y; cards.add(topCard);
  const first = new THREE.Group(); first.add(box(.52, .016, .36, toon(0xf6f3ff), 0, .008, 0)); const ff = flatTex(card('0001', 'PATCH'), .5, .34); ff.position.y = .017; first.add(ff);
  first.position.set(.62, 0, .14); first.rotation.y = -.45; cards.add(first);
  cards.position.set(-.62, TABLE_Y, 1.3); cards.rotation.y = .15; desk.add(cards); deskProps.push(cards);
  // a pencil
  const pencil = new THREE.Group();
  pencil.add(cyl(.028, .7, toon(0xffc861), 0, 0, 0, 6), mesh(new THREE.ConeGeometry(.028, .1, 6), toon(0xf2d3a8), 0, .4, 0), cyl(.029, .08, toon(0xff7f5c), 0, -.39, 0, 6));
  pencil.rotation.set(Math.PI / 2, 0, .7); pencil.position.set(1.35, TABLE_Y + .03, 1.15); desk.add(pencil); deskProps.push(pencil);
}
for (const p of deskProps) p.userData.s = p.scale.clone();

// ---- the layout stop: the split between the rendered windows and their HTML ---------------------------
// It's a meridian, at longitude psi in the scene's own frame. While the scene turns in, it's the scene's middle
// one, coming round with the ground; once it's landed it eases to the middle of the face and stays there, the
// planet turning under it (drift, or a drag), so the windows go through it; when the scene turns away it's left
// where it is on the ground, and goes round with it
const bpG = new THREE.Group(); spinG.add(bpG);   // (nothing stands on this ground)
const bp = { psi: 0, psi0: 0, lock: 0 };
function splitAt(dt) {
  const th = SCENES[BLUEPRINT].th;
  if (wipe.on && wipe.B === BLUEPRINT) { bp.psi = 0; bp.lock = 0; }
  else if (!wipe.on && wipe.B === BLUEPRINT) {
    if (bp.lock === 0) bp.psi0 = bp.psi;
    bp.lock = Math.min(1, bp.lock + dt / .7);
    bp.psi = bp.psi0 + wrapPI(-(spin.a + th) - bp.psi0) * ease(bp.lock);
  }
  plutoMat.uniforms.bpPsi.value = bp.psi;
}

// ---- each scene's things, and the planes that cut them off mid-turn -------------------------------------
// Every material in a scene's groups is its own copy, clipped by the scene's planes: during a turn, the new
// scene keeps what's on its side of the wipe and the old one the rest. th turns the scene's groups (all but
// the agents', which ride in and then stay put) so that its middle is wherever the turn that brought it ends.
// At the far edge, which can be seen where it passes near a limb or a pole, things don't stop at the plane:
// they sink into the ground as it comes, and come up out of it after (sink, in view space: the planet's
// middle and radius; the lead meridian and the one a quarter on, and which side is the scene's; how wide a
// band they sink over; whether a turn's on, and how far round from the lead the far edge is).
const SINK_GLSL = name => `{
  vec3 d = mvPosition.xyz - ${name}[0].xyz; float r = length(d), r0 = ${name}[0].w * .96;
  if (${name}[3].x > .5 && r > r0) {
    float ph = mod(atan(dot(d, ${name}[2].xyz), dot(d, ${name}[1].xyz)), 6.2832);
    float s = 1. - smoothstep(0., ${name}[2].w, ${name}[1].w * (ph - ${name}[3].y));
    mvPosition.xyz = ${name}[0].xyz + d * (r0 + (r - r0) * (1. - s)) / r;
    gl_Position = projectionMatrix * mvPosition;
  }
}`;
const SCENES = { [COVER]: { groups: [pinsG], th: 0 }, [BLUEPRINT]: { groups: [bpG], th: 0 }, [THREADS]: { groups: [threadsG], th: 0 }, [DUST]: { groups: [agentsG, dustG], th: 0 } };
for (const [k, sc] of Object.entries(SCENES)) {
  sc.planes = [new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e3), new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e3)];
  sc.sink = { value: new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0) };
  const name = 'sink' + k, own = new Map(), mine = m => {
    if (!own.has(m)) {
      const c = m.clone(); c.clippingPlanes = sc.planes;
      if (m.isShaderMaterial) { c.uniforms = m.uniforms; c.clipping = true; }   // the same uniforms: the sun, the veil, the time
      c.onBeforeCompile = sh => {
        sh.uniforms[name] = sc.sink;
        sh.vertexShader = `uniform mat4 ${name};\n` + sh.vertexShader.replace('#include <clipping_planes_vertex>', SINK_GLSL(name) + '\n#include <clipping_planes_vertex>');
      };
      c.customProgramCacheKey = () => name;
      own.set(m, c);
    }
    return own.get(m);
  };
  for (const g of sc.groups) g.traverse(o => { if (o.material) o.material = Array.isArray(o.material) ? o.material.map(mine) : mine(o.material); });
  sc.mats = [...own.values()];
}

// ---- the shells' holograms: a moon pointed at projects its shell's layout above it, playing --------------
const HW = 512, HH = 360, SX = 14, SY = 48, SW = 484, SH = 298;   // the canvas, and the screen drawn on it
const holoCanvas = document.createElement('canvas'); holoCanvas.width = HW; holoCanvas.height = HH;
const hx = holoCanvas.getContext('2d'), holoTex = new THREE.CanvasTexture(holoCanvas);
// everything is drawn in white, its alpha the light's strength; the shader colours it
function rr(x, y, w, h, r, fill, stroke) {
  hx.beginPath(); hx.roundRect(x, y, w, h, r);
  if (fill) { hx.fillStyle = `rgba(255,255,255,${fill})`; hx.fill(); }
  if (stroke) { hx.strokeStyle = `rgba(255,255,255,${stroke})`; hx.stroke(); }
}
function text(s, x, y, size, a, align = 'left') {
  hx.font = `500 ${size}px "JetBrains Mono", ui-monospace, monospace`; hx.letterSpacing = size > 14 ? '4px' : '2px';
  hx.textAlign = align; hx.fillStyle = `rgba(255,255,255,${a})`; hx.fillText(s, x, y); return hx.measureText(s).width;
}
function bars(x, y, w, h, a, k = 0) {   // lines of text, as bars
  for (let i = 0; y + i * 12 + 4 < y + h; i++) rr(x, y + i * 12, w * (.45 + .55 * hash(i, k, w | 0)), 4, 2, a);
}
function win(x, y, w, h, a = 1, k = 0, body = true) {   // a window: a frame, a title bar, and text
  rr(x, y, w, h, 7, .07 * a, .7 * a); rr(x, y, w, 15, [7, 7, 0, 0], .2 * a);
  if (body) bars(x + 10, y + 25, w - 20, h - 33, .26 * a, k);
}
function pointer(x, y, a = 1) {
  hx.beginPath(); hx.moveTo(x, y); hx.lineTo(x, y + 17); hx.lineTo(x + 4.5, y + 13); hx.lineTo(x + 8, y + 20); hx.lineTo(x + 11, y + 18.5);
  hx.lineTo(x + 7.5, y + 12); hx.lineTo(x + 13, y + 12); hx.closePath(); hx.fillStyle = `rgba(255,255,255,${a})`; hx.fill();
}
const at = (pts, T) => {   // keyframes [[time, x, y], ...]: the point at time T, eased between them
  let i = 0; while (i < pts.length - 1 && T > pts[i + 1][0]) i++;
  const [t0, x0, y0] = pts[i], [t1, x1, y1] = pts[Math.min(i + 1, pts.length - 1)], f = t1 > t0 ? ease(clamp01((T - t0) / (t1 - t0))) : 1;
  return [lerp(x0, x1, f), lerp(y0, y1, f)];
};
const SHELLS = [
  // Styx: columns on a strip that scrolls sideways to the focused one; the strip in miniature underneath
  t => {
    const cols = [150, 210, 170, 240, 160, 200, 180], gap = 12, xs = [], step = 1.6, n = cols.length;
    let x = 0; for (const w of cols) { xs.push(x); x += w + gap; }
    const span = SW - 2 * gap, view = c => Math.max(0, Math.min(x - gap - span, xs[c] + cols[c] / 2 - span / 2));
    const i = Math.floor(t / step), c = i % n, p = (i + n - 1) % n, f = i ? ease(sub(t % step, 0, .55)) : 1;
    const scroll = lerp(view(p), view(c), f), top = SY + 14, h = SH - 50;
    cols.forEach((w, j) => {
      const X = SX + gap + xs[j] - scroll; if (X > SX + SW || X + w < SX) return;
      const on = j === c ? f : j === p ? 1 - f : 0, a = .5 + .5 * on;
      if (j % 3 === 1) { win(X, top, w, h / 2 - 5, a, j); win(X, top + h / 2 + 5, w, h / 2 - 5, a, j + 9); } else win(X, top, w, h, a, j);
      if (on > .01) { hx.lineWidth = 3; rr(X - 4, top - 4, w + 8, h + 8, 10, 0, on); hx.lineWidth = 2; }
    });
    const k = 150 / (x - gap), mX = SX + SW / 2 - 75, mY = SY + SH - 22;
    cols.forEach((w, j) => rr(mX + xs[j] * k, mY, w * k, 7, 2, j === c ? .8 : .28));
    rr(mX + scroll * k - 3, mY - 4, span * k + 6, 15, 4, 0, .75);
  },
  // Charon: floating windows; one is dragged, then the overview lays them out, and one is picked
  t => {
    const T = t % 7.5, base = [[40, 38, 190, 132], [212, 66, 214, 150], [104, 140, 182, 118]];
    const d = T < 4.4 ? ease(sub(T, 1.1, 2.7)) : 0, ov = ease(sub(T, 3.3, 4)) * (1 - ease(sub(T, 5.6, 6.3)));
    const wins = base.map(([x, y, w, h], j) => {
      if (j === 1) { x -= 70 * d; y += 46 * d; }
      const gx = 18 + j * 154, gy = 84, gw = 140, gh = 96;
      return [SX + lerp(x, gx, ov), SY + lerp(y, gy, ov), lerp(w, gw, ov), lerp(h, gh, ov)];
    });
    if (ov > 0) rr(SX, SY, SW, SH, 0, .07 * ov);
    for (const j of [0, 2, 1]) win(...wins[j], j === 1 ? 1 : .65, j);
    const pick = T > 4.6 && T < 5.6 ? ease(sub(T, 4.6, 4.9)) : 0;
    if (pick) { hx.lineWidth = 3; rr(wins[0][0] - 5, wins[0][1] - 5, wins[0][2] + 10, wins[0][3] + 10, 10, 0, pick); hx.lineWidth = 2; }
    const B = wins[1], A = wins[0];
    const [cx, cy] = T < 1.1 ? at([[0, 400, 250], [1, B[0] + 70, B[1] + 7]], T) : T < 2.9 ? [B[0] + 70, B[1] + 7]
      : at([[2.9, B[0] + 70, B[1] + 7], [4.5, A[0] + 70, A[1] + 50], [6.3, A[0] + 70, A[1] + 50], [7.4, 400, 250]], T);
    pointer(cx, cy);
    for (let j = 0; j < 3; j++) rr(SX + SW / 2 - 24 + j * 20, SY + SH - 18, 8, 8, 4, j ? .3 : .9);
  },
  // Hydra: conversations down the side, one being written, and the agent's window beside it, driven
  t => {
    const T = t % 8;
    rr(SX, SY, 112, SH, 0, .07);
    for (let i = 0; i < 6; i++) {
      const y = SY + 14 + i * 38, on = i === 1;
      rr(SX + 10, y, 92, 28, 6, on ? .2 : .06, on ? .8 : 0); rr(SX + 20, y + 8, 42 + 30 * hash(i, 4), 4, 2, on ? .8 : .4); rr(SX + 20, y + 17, 30 + 20 * hash(i, 5), 4, 2, .25);
      if (on) { hx.beginPath(); hx.arc(SX + 90, y + 14, 5, t * 5, t * 5 + 4); hx.strokeStyle = 'rgba(255,255,255,.9)'; hx.stroke(); }
    }
    const msgs = [[1, 110, 1], [0, 150, 3], [0, 120, 2], [1, 80, 1], [0, 156, 4], [0, 100, 2]];
    const shown = Math.min(msgs.length, Math.floor(T / 1.1) + 1), f = ease(sub(T % 1.1, 0, .35));
    let y = SY + SH - 48;
    for (let i = shown - 1; i >= 0; i--) {
      const [me, w, n] = msgs[i], h = 12 + n * 10, a = i === shown - 1 && shown < msgs.length ? f : 1, x = me ? SX + 300 - w : SX + 124;
      y -= h + 8; if (y < SY) break;
      rr(x, y, w, h, 9, (me ? .2 : .07) * a, me ? 0 : .5 * a); bars(x + 10, y + 8, w - 20, h - 10, .45 * a, i);
    }
    rr(SX + 124, SY + SH - 36, 178, 24, 12, .05, .5);
    const wx = SX + 314, wy = SY + 12, ww = 158, wh = SH - 24;
    win(wx, wy, ww, wh, .95, 7, false);
    rr(wx + 10, wy + 24, ww - 20, 22, 11, .14, .7); text('AGENT AT WORK', wx + ww / 2, wy + 39, 9, .9, 'center');
    const btn = [[wx + 14, wy + 62, 60, 26], [wx + 84, wy + 62, 60, 26], [wx + 14, wy + 100, 130, 26], [wx + 14, wy + 138, 130, 60]];
    btn.forEach(([x, y, w, h]) => rr(x, y, w, h, 6, .08, .5));
    bars(wx + 14, wy + 214, ww - 28, wh - 226, .25, 3);
    const [px, py] = at([[0, wx + 44, wy + 75], [1.6, wx + 44, wy + 75], [2.4, wx + 114, wy + 75], [4, wx + 114, wy + 75], [4.8, wx + 79, wy + 113], [6.4, wx + 79, wy + 113], [7.4, wx + 44, wy + 75]], T);
    hx.beginPath(); hx.arc(px, py, 6, 0, 7); hx.fillStyle = 'rgba(255,255,255,.95)'; hx.fill();
    for (const tc of [1.2, 3.6, 6]) { const k = sub(T, tc, tc + .5); if (k > 0 && k < 1) { hx.beginPath(); hx.arc(px, py, 6 + 18 * k, 0, 7); hx.strokeStyle = `rgba(255,255,255,${1 - k})`; hx.stroke(); } }
  },
  // Kerberos: the smallest shell, one window and its tabs, with its source beside it, read line by line
  t => {
    const T = t % 6, k = Math.floor(T / 2), f = ease(sub(T % 2, 0, .4));
    const x = SX + 16, y = SY + 16, w = 290, h = SH - 32;
    rr(x, y, w, h, 7, .07, .75);
    for (let i = 0; i < 3; i++) rr(x + 8 + i * 72, y + 7, 64, 16, 5, i === k ? .3 : .08, i === k ? .8 : 0);
    rr(x + 8 + lerp((k + 2) % 3, k, f) * 72, y + 26, 64, 2, 1, .9);
    hx.globalAlpha = f; bars(x + 14, y + 42, w - 28, h - 54, .3, k); hx.globalAlpha = 1;
    const cx = x + w + 16, cw = SX + SW - 16 - cx;
    rr(cx, y, cw, h, 7, .04, .45); text('shell.html', cx + 10, y + 18, 10, .7);
    const line = Math.floor(t * 2.5) % 18;
    for (let i = 0; i < 18; i++) {
      const ly = y + 34 + i * 13;
      if (i === line) rr(cx + 4, ly - 4, cw - 8, 12, 3, .16);
      rr(cx + 10 + 10 * (hash(i, 8) * 3 | 0), ly, (cw - 50) * (.3 + .7 * hash(i, 9)), 4, 2, i === line ? .9 : .32);
    }
  },
  // Nix: unclaimed; a layout of your own drawn out, box by box, and cleared again
  t => {
    const T = t % 7, fade = 1 - sub(T, 6.1, 6.8);
    hx.setLineDash([8, 7]); rr(SX + 12, SY + 12, SW - 24, SH - 24, 9, 0, .45); hx.setLineDash([]);
    const boxes = [[30, 28, 170, 238], [214, 28, 238, 112], [214, 154, 238, 112]];
    let cur = null;
    boxes.forEach(([x, y, w, h], j) => {
      const s = .5 + j * 1.5, p = ease(sub(T, s, s + 1)); if (p <= 0) return;
      const X = SX + x, Y = SY + y, W = w * p, H = h * p;
      if (p < 1) { hx.setLineDash([6, 5]); rr(X, Y, W, H, 6, .05 * fade, .9 * fade); hx.setLineDash([]); cur = [X + W, Y + H]; }
      else { win(X, Y, w, h, fade, j); }
    });
    if (T < .5 || T > 6.8) text('unclaimed' + (t % 1 < .5 ? '_' : ' '), SX + SW / 2, SY + SH / 2 + 6, 16, .8, 'center');
    if (cur) pointer(cur[0] - 2, cur[1] - 2);
  },
];
function drawShell(k, t) {
  hx.clearRect(0, 0, HW, HH); hx.lineWidth = 2;
  const w = text(MOONS[k].name.toUpperCase(), SX, 30, 18, 1);
  text(MOONS[k].what.toUpperCase(), SX + w + 16, 30, 11, .6);
  rr(SX, SY, SW, SH, 12, .05, .6);
  hx.save(); hx.beginPath(); hx.roundRect(SX, SY, SW, SH, 12); hx.clip();
  SHELLS[k](t);
  hx.restore();
  holoTex.needsUpdate = true;
}
const holoMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: holoTex }, on: { value: 0 }, time: { value: 0 }, amount: { value: 0 } },
  transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
  fragmentShader: `uniform sampler2D map; uniform float on, time, amount; varying vec2 vUv;
float h1(float x) { return fract(sin(x * 91.3) * 43758.5); }
void main() {
  // it opens out from a line across the middle, and now and then a band of it slips sideways
  float open = abs(vUv.y - .5) - on * .5;
  float slip = step(.9, h1(floor(time * 14.))) * step(.8, h1(floor(vUv.y * 24.) + floor(time * 14.))) * .012;
  float a = texture2D(map, vUv + vec2(slip, 0.)).a;
  float scan = .74 + .26 * sin(gl_FragCoord.y * 1.7), flick = .93 + .07 * sin(time * 41.) * sin(time * 17.);
  vec3 c = vec3(.38, .84, 1.) * (a * 1.15 + .05) * scan * flick;
  vec2 e = min(vUv, 1. - vUv); c += vec3(.4, .85, 1.) * .5 * exp(-min(e.x * 1.42, e.y) * 70.);
  c *= step(open, 0.);
  c += vec3(.75, .95, 1.) * exp(-abs(open) * 160.) * (1. - on * on) * 2.;   // the edge, while it opens
  gl_FragColor = vec4(c * amount, 1.);
}`,
});
const holo = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 1.05 * HH / HW), holoMat);
holo.renderOrder = 10; holo.visible = false; rootG.add(holo);
// the beam it's projected in, from the moon's top up to the panel's bottom
const beamGeo = new THREE.BufferGeometry();
beamGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
beamGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2)); beamGeo.setIndex([0, 1, 2, 2, 1, 3]);
const beamMat = new THREE.ShaderMaterial({
  uniforms: { amount: { value: 0 }, time: holoMat.uniforms.time },
  transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  vertexShader: holoMat.vertexShader,
  fragmentShader: `uniform float amount, time; varying vec2 vUv;
void main() {
  float across = 1. - abs(vUv.x - .5) * 2., rays = .7 + .3 * sin(vUv.x * 40. + time * 3.);
  float up = .25 + .75 * smoothstep(0., 1., vUv.y), rise = .8 + .2 * sin(vUv.y * 30. - time * 8.);
  gl_FragColor = vec4(vec3(.35, .8, 1.) * .3 * pow(across, .6) * up * rays * rise * amount, 1.);
}`,
});
const beam = new THREE.Mesh(beamGeo, beamMat); beam.frustumCulled = false; beam.renderOrder = 9; beam.visible = false; rootG.add(beam);

// ---- liftoff: back on Earth, looking up at it through the air, under the trees -------------------------
// The branches are drawn as flat silhouettes on the page, in the corners, and come in when the sky does.
function branchSVG(W, H, x0, y0, a0, len, k) {
  let n = k * 997; const r = () => hash(n++, 61, 5);
  const wood = [], leaves = [[], []];
  const P = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`;
  function leaf(x, y, a, s, layer) {
    const c = Math.cos(a), sn = Math.sin(a), tx = x + c * s, ty = y + sn * s, mx = x + c * s * .5, my = y + sn * s * .5, w = s * .32;
    leaves[layer].push(`M${P(x, y)}Q${P(mx - sn * w, my + c * w)} ${P(tx, ty)}Q${P(mx + sn * w, my - c * w)} ${P(x, y)}Z`);
  }
  function limb(x, y, a, l, w, d) {
    const bend = (r() - .5) * .6, x2 = x + Math.cos(a) * l, y2 = y + Math.sin(a) * l;
    const mx = x + Math.cos(a + bend * .5) * l * .5, my = y + Math.sin(a + bend * .5) * l * .5;
    const w2 = w * .62, nx = -Math.sin(a), ny = Math.cos(a), wm = (w + w2) / 4;
    wood.push(`M${P(x + nx * w / 2, y + ny * w / 2)}Q${P(mx + nx * wm, my + ny * wm)} ${P(x2 + nx * w2 / 2, y2 + ny * w2 / 2)}L${P(x2 - nx * w2 / 2, y2 - ny * w2 / 2)}Q${P(mx - nx * wm, my - ny * wm)} ${P(x - nx * w / 2, y - ny * w / 2)}Z`);
    if (d <= 1) for (let i = 0; i < 5; i++) {   // leaves along the twig, and a bunch at its end
      const f = .3 + .7 * i / 4, lx = x + (x2 - x) * f, ly = y + (y2 - y) * f, side = i % 2 ? 1 : -1;
      leaf(lx, ly, a + side * (.6 + .6 * r()), 18 + 16 * r(), r() < .35 ? 1 : 0);
    }
    if (d === 0) { for (let i = 0; i < 3; i++) leaf(x2, y2, a + (i - 1) * .6, 22 + 12 * r(), i % 2); return; }
    const kids = r() < .7 ? 1 : 2;
    for (let i = 0; i < kids; i++) {
      const f = .3 + .6 * (i + 1) / (kids + 1), side = (i + k) % 2 ? 1 : -1;
      limb(x + (x2 - x) * f, y + (y2 - y) * f, a + side * (.45 + .45 * r()), l * (.42 + .2 * r()), w * .5, d - 1);
    }
    limb(x2, y2, a + (r() - .5) * .5, l * .72, w2, d - 1);
  }
  limb(x0, y0, a0, len, len * .12, 4);
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><g class="sway" style="transform-origin:${x0}px ${y0}px">
<path fill="#163a86" d="${leaves[1].join('')}"/><path fill="#081538" d="${wood.join('')}"/><path fill="#0b1c48" d="${leaves[0].join('')}"/></g></svg>`;
}
for (const [cls, W, H, x, y, a, len, k] of [['tr', 640, 520, 660, 10, 2.8, 230, 1], ['br', 460, 420, 480, 330, 3.5, 170, 2], ['tl', 380, 300, -20, 20, .5, 130, 3]]) {
  const el = document.createElement('div'); el.className = 'branch ' + cls; el.innerHTML = branchSVG(W, H, x, y, a, len, k);
  document.body.appendChild(el);
}

// ---- the sky: a gradient, a glow behind the planet, stars and the odd four-pointed sparkle; and at the
// install stop, the blue of Earth's sky closing in from the edges ------------------------------------------
const bgScene = new THREE.Scene(), bgCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const bgMat = new THREE.ShaderMaterial({
  uniforms: { res: { value: new THREE.Vector2() }, time: { value: 0 }, center: { value: new THREE.Vector2() }, rad: { value: 1 }, dpr: { value: 1 }, sky: { value: 0 }, textW: { value: 0 } },
  depthTest: false, depthWrite: false,
  vertexShader: `void main() { gl_Position = vec4(position.xy, 0., 1.); }`,
  fragmentShader: `uniform vec2 res, center; uniform float time, rad, dpr, sky, textW;
vec2 h2(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
vec3 stars(vec2 fc, float cell, float density, float big) {
  vec2 g = floor(fc / cell), h = h2(g); if (h.x > density) return vec3(0.);
  vec2 o = (g + .15 + .7 * h2(g + 7.)) * cell, d = fc - o;
  float size = mix(.5, 1.6, pow(h.y, 3.) * big) * dpr, tw = .65 + .35 * sin(time * (.6 + 2. * h.x) + h.y * 40.);
  vec3 c = mix(vec3(1., .86, .8), vec3(.75, .85, 1.), h2(g + 3.).x);
  return c * smoothstep(size + dpr, size * .3, length(d)) * tw;
}
void main() {
  vec2 fc = gl_FragCoord.xy, uv = fc / res;
  vec3 c = mix(vec3(.065, .035, .12), vec3(.015, .015, .05), uv.y);
  float r = length(fc - center) / rad;
  c += vec3(.28, .18, .55) * .3 * exp(-max(r - 1., 0.) * 1.5);
  c += stars(fc, 38. * dpr, .32, .6) * .8 + stars(fc + 911., 90. * dpr, .5, 1.);
  // sparkles
  float cell = 230. * dpr; vec2 g = floor(fc / cell), h = h2(g + 19.);
  if (h.x < .35) {
    vec2 d = fc - (g + .2 + .6 * h2(g + 5.)) * cell; d /= dpr;
    float tw = .5 + .5 * sin(time * (.5 + h.y) + h.x * 30.), s = 5. + 6. * tw;
    float x = exp(-abs(d.x) / s) * exp(-abs(d.y) * 1.1) + exp(-abs(d.y) / s) * exp(-abs(d.x) * 1.1);
    c += vec3(1., .93, .85) * (x * .9 + .6 * exp(-dot(d, d) / 3.)) * (.4 + .6 * tw);
  }
  // Earth's sky: deep blue overhead, paler low down, a soft brightening round the planet, and a little
  // darker behind the text; it closes in from the edges toward the planet
  vec3 day = mix(vec3(.2, .45, .86), vec3(.07, .22, .58), pow(uv.y, .8));
  day += vec3(.3, .42, .6) * .22 * exp(-max(r - 1., 0.) * 1.2);
  day *= 1. - .22 * smoothstep(textW + 80. * dpr, textW * .4, fc.x) * step(1., textW);
  float edge = length((fc - center) / res.y), reach = mix(1.5, -.45, sky);
  c = mix(c, day, smoothstep(reach, reach + .35, edge));
  gl_FragColor = vec4(c, 1.);
}`,
});
bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat));

// ---- layout: where the planet sits on the screen, and how big ------------------------------------
const view = { cx: 0, cy: 0, r: 1, D: 1 };
const charonHome = new THREE.Vector3();
function resize() {
  const W = innerWidth, H = innerHeight, wide = W > 900;
  renderer.setSize(W, H, false);
  const text = wide ? 40 + Math.min(560, W - 80) + 40 : 0;   // main's margin, width and a gap
  view.r = wide ? Math.min(H * .31, (W - text) * .34) : Math.min(W * .34, H * .24);
  view.cx = wide ? text + (W - text) * .5 : W * .5; view.cy = wide ? H * .58 : H * .32;
  // the distance at which the sphere's outline is r pixels across, and the frustum shifted so it's centred there
  camera.aspect = W / H; camera.updateProjectionMatrix();
  const k = view.r * Math.tan(camera.fov * D2R / 2) / (H / 2), D = view.D = Math.sqrt(1 / (k * k) + 1);
  camera.position.set(0, 0, D); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const pm = camera.projectionMatrix.elements; pm[8] = -(view.cx / W * 2 - 1); pm[9] = -(1 - view.cy / H * 2);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  sunV.value.copy(SUN).transformDirection(camera.matrixWorldInverse);
  // Charon's place: up and to the right of the planet, further back
  const cpos = new THREE.Vector3(wide ? Math.min(W - 70, view.cx + view.r * 1.55) : W * .85, wide ? H * .19 : H * .08, 0);
  const ndc = new THREE.Vector3(cpos.x / W * 2 - 1, 1 - cpos.y / H * 2, .5).unproject(camera).sub(camera.position).normalize();
  charonHome.copy(camera.position).addScaledVector(ndc, D + 4); MOONS[1].small = .24 * (D + 4) / D;
  const dpr = renderer.getPixelRatio();
  bgMat.uniforms.res.value.set(W * dpr, H * dpr); bgMat.uniforms.dpr.value = dpr; bgMat.uniforms.textW.value = text * dpr;
}

// ---- the stops: a chapter reaching the reading line turns the planet to its scene ----------------------
// The planet always drifts round slowly, and anything faster is slowed by friction till it's back to the
// drift. A new scene comes with a push that friction lets carry it half a turn, always forward (east coming in
// from the right), and is set so that its middle is at the front when the push has run out. It's painted on
// the ground as the ground comes round: the stop's turns don't overlap, and one asked for mid-turn waits, the
// latest only, for the turn on to finish. A stop with the scene that's on already gets a push the short way
// round to its middle. Two stops change the scene as well: the planet becomes a globe on a desk (GLOBE),
// flung round a few times on the way from wherever it was, or is seen from Earth (SKY). And it can be spun by
// hand: dragged, and let go.
const panels = [...document.querySelectorAll('.panel')];
const navs = [...document.querySelectorAll('header nav a, .dots a')];
const LAYOUT = 1, SHELLS_STOP = 2, THREADS_STOP = 3, AGENTS = 4, GLOBE = 5, SKY = 6;
const SCENE_OF = [COVER, BLUEPRINT, COVER, THREADS, DUST, COVER, COVER];
const MODE_OF = ['', '', 'm', '', '', 'g', 's'], MODE_SECS = { m: 1.1, g: 1.7, s: 1.8 };
const mode = { m: 0, g: 0, s: 0 };   // how far into each stop's change of scene, 0 to 1, linear in time
const LINE = .6;
function reading() {
  const y = innerHeight * LINE; let k = 0;
  panels.forEach((el, j) => { if (el.getBoundingClientRect().top < y) k = j; });
  return k;
}
if (location.hash) { const k = +location.hash.slice(1); if (panels[k]) panels[k].scrollIntoView(); }
let cur = reading(), want = cur, wantSince = 0, navUntil = 0, threadsT0 = 0;
// a: how far it's turned; w: how fast; k: the friction, the rate the speed over the drift dies away at; drag:
// the hand on it
const spin = { a: 0, w: 0, k: 2, drag: null };
const FRICTION = 2, DRIFT = -.035, GLOBE_TURNS = 2, GLOBE_FRICTION = .75;
const drift = () => cur === AGENTS ? -TREAD : DRIFT;   // at the agents' stop, the dust going by
// a push that friction k lets carry it d further than the drift would
const push = (d, k = FRICTION) => { spin.k = k; spin.w = drift() + k * d; };
// the turn between scenes, from A to B, from where it was turned to at a0. B is on a wedge of longitude behind
// a meridian, lead, that starts at the right-hand edge, where the ground comes round from the back, and goes
// across the face with the ground; the wedge's other side, e, goes the other way round the back, so that the
// wedge, w wide, is the whole planet half a turn on. That side can be seen round the south pole, over the top
// and at the limbs as it starts and ends, so it's never a line: the ground fades across it, FADE wide, and the
// things on either side sink into the ground as it comes and come up out of it after. It's all in how far
// round the planet is, not the time.
const wipe = { on: false, A: SCENE_OF[cur], B: SCENE_OF[cur], a0: 0, w: 0, e: 0, lead: new THREE.Vector3(1, 0, 0) };
const CUT = 10 * D2R;   // things wait for the ground: this far inside their scene's edge at the lead
const SINK = FADE / 2;   // and at the far edge, sink into it over this much of the fade
let queued = null;   // the stop asked for while a turn is on
for (const k in mode) mode[k] = MODE_OF[cur] === k ? 1 : 0;
if (cur === AGENTS) agentsTo(0);
function go(j) {
  j = Math.max(0, Math.min(panels.length - 1, j));
  if (wipe.on) { queued = j === cur ? null : j; return; }
  queued = null;
  if (j === cur) return;
  const sc = SCENE_OF[j], now = performance.now() / 1000;
  cur = j; spin.drag = null;
  let to;   // where its middle comes to the front, over the drift
  // a turn forward of at least far: as far as it's going anyway, if that's further, else a push
  const fling = (far, k) => {
    const carry = (drift() - spin.w) / spin.k;
    if (carry > far) return spin.a - carry;
    push(-far, k); return spin.a - far;
  };
  if (sc !== wipe.B) {
    // (a little over the half turn, so the turn isn't waiting on the last of the push)
    to = fling(j === GLOBE ? Math.PI * (1 + 2 * GLOBE_TURNS) : Math.PI + .2, j === GLOBE ? GLOBE_FRICTION : FRICTION);
    Object.assign(wipe, { on: true, B: sc, a0: spin.a, w: 0 }); wipe.lead.set(1, 0, 0).applyAxisAngle(Y, -spin.a);
    SCENES[sc].th = -to;
  } else if (j === GLOBE) {   // the scene on already, but flung round all the same, its middle at the front at the end
    const far = 2 * Math.PI * GLOBE_TURNS + THREE.MathUtils.euclideanModulo(spin.a + SCENES[sc].th, 2 * Math.PI);
    to = fling(far, GLOBE_FRICTION);
  } else if (sc !== DUST) {   // on already: the short way round to its middle
    to = spin.a + wrapPI(-SCENES[sc].th - spin.a); push(to - spin.a);
  }
  if (j === AGENTS) agentsTo(spin.a - (to ?? spin.a));   // on the dust's middle, coming round
  if (j === THREADS_STOP) threadsT0 = now + (to === undefined ? 0 : Math.min(1.2, Math.abs(to - spin.a) * .3));
  navs.forEach(n => n.classList.toggle('on', +n.dataset.go === j));
  document.body.classList.toggle('sky', j === SKY);
  history.replaceState(null, '', '#' + j);
}
document.querySelectorAll('[data-go]').forEach(a => a.addEventListener('click', () => {
  const j = +a.dataset.go; want = j; go(j); navUntil = performance.now() + 1500;   // the chapters scrolled past on the way don't count
  scrollTo({ top: j ? scrollY + panels[j].querySelector('h2, h3').getBoundingClientRect().top - innerHeight * .3 : 0, behavior: 'smooth' });
}));
addEventListener('scroll', () => {
  const k = reading(), now = performance.now();
  if (now < navUntil && k !== cur) return;
  navUntil = 0; if (k !== want) { want = k; wantSince = now; }
}, { passive: true });

// friction: the speed over the drift dies away exponentially (exactly, whatever the step); in a hand, it goes
// where it's dragged
function stepSpin(dt, now) {
  if (spin.drag) {
    if (now - spin.drag.t > 80) spin.drag.v *= Math.exp(-12 * dt);   // held still
    spin.w = spin.drag.v; return;
  }
  const c = drift(), e = Math.exp(-spin.k * dt), over = (spin.w - c) * (1 - e) / spin.k;
  spin.a += c * dt + over; spin.w = c + (spin.w - c) * e;
}
function stepModes(dt) {
  for (const k in mode) {
    const to = MODE_OF[cur] === k ? 1 : 0, d = dt / MODE_SECS[k];
    mode[k] = to > mode[k] ? Math.min(to, mode[k] + d) : Math.max(to, mode[k] - d);
  }
}

// ---- pointing at the moons -------------------------------------------------------------------------
const moonLabels = MOONS.map(m => {
  const el = document.createElement('div'); el.className = 'moon'; el.innerHTML = `${m.name}<small>${m.what}</small>`;
  document.body.appendChild(el); return el;
});
const moonScr = MOONS.map(() => ({ x: -1e4, y: -1e4, r: 0 }));
let hovMoon = -1, hovList = -1;
function moonAt(x, y) {
  if (mode.m < .9) return -1;
  let best = -1, bd = 1e9;
  moonScr.forEach((s, i) => {
    const dx = x - s.x, dy = y - s.y, inLabel = Math.abs(dx) < 60 && dy > 0 && dy < s.r + 46, d = Math.hypot(dx, dy);
    if ((d < s.r + 22 || inLabel) && d < bd) { best = i; bd = d; }
  });
  return best;
}
const listItems = [...document.querySelectorAll('[data-moon]')];
listItems.forEach(li => {
  li.addEventListener('pointerenter', () => { hovList = +li.dataset.moon; });
  li.addEventListener('pointerleave', () => { hovList = -1; });
});
addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') hovMoon = moonAt(e.clientX, e.clientY); });

const mouse = new THREE.Vector2(), look = new THREE.Vector2();
const onPlanet = (x, y) => Math.hypot(x - planetScr.x, y - planetScr.y) < planetScr.r * 1.08;
addEventListener('pointermove', e => {
  mouse.set(e.clientX / innerWidth * 2 - 1, e.clientY / innerHeight * 2 - 1);
  if (e.pointerType === 'mouse') {
    hovMoon = moonAt(e.clientX, e.clientY); document.body.classList.toggle('pointing', hovMoon >= 0);
    document.body.classList.toggle('grab', hovMoon < 0 && e.target === canvas && onPlanet(e.clientX, e.clientY));
  }
});

// ---- spinning it by hand: the surface follows the pointer across; let go, and it keeps the speed it had --------
canvas.style.touchAction = 'pan-y';   // up and down still scrolls the page
canvas.addEventListener('pointerdown', e => {
  if (e.button || moonAt(e.clientX, e.clientY) >= 0 || !onPlanet(e.clientX, e.clientY)) return;
  e.preventDefault(); try { canvas.setPointerCapture(e.pointerId); } catch {}
  spin.drag = { id: e.pointerId, x: e.clientX, t: performance.now(), v: spin.w };
  document.body.classList.add('grabbing');
});
canvas.addEventListener('pointermove', e => {
  const d = spin.drag; if (!d || d.id !== e.pointerId) return;
  const now = performance.now(), da = (e.clientX - d.x) / Math.max(40, planetScr.r);
  spin.a += da;
  d.v = lerp(d.v, da / Math.max(.004, (now - d.t) / 1000), .5); d.x = e.clientX; d.t = now;
});
const letGo = e => {
  const d = spin.drag; if (!d || d.id !== e.pointerId) return;
  spin.w = THREE.MathUtils.clamp(d.v, -25, 25); spin.k = FRICTION; spin.drag = null;
  if (wipe.on) {   // let go partway through a turn: if it isn't going to get round by itself, on round it goes
    const th = wipe.a0 - spin.a, carry = (drift() - spin.w) / spin.k;
    if (th + carry < Math.PI + .02) push(-(Math.PI + .02 - th));
  }
  document.body.classList.remove('grabbing');
};
canvas.addEventListener('pointerup', letGo); canvas.addEventListener('pointercancel', letGo);

// ---- liftoff: copying the install command sends a rocket up from under the branches to the planet ---------
const rocket = document.querySelector('.rocket'), planetScr = { x: 0, y: 0, r: 0 };
let launchAt = -1, lastPuff = 0;
const copyBtn = document.querySelector('[data-copy]');
copyBtn?.addEventListener('click', () => {
  const text = document.getElementById(copyBtn.dataset.copy).textContent.trim();
  navigator.clipboard?.writeText(text).catch(() => {});
  copyBtn.textContent = 'Copied'; clearTimeout(copyBtn.t); copyBtn.t = setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800);
  if (launchAt < 0) launchAt = performance.now();
});
function flyRocket(now) {
  if (launchAt < 0) return;
  const f = (now - launchAt) / 3400;
  if (f >= 1 || cur !== SKY) { launchAt = -1; rocket.style.opacity = 0; return; }
  // a curve from below the bottom right, up and over to the planet, quicker as it goes, and smaller
  const W = innerWidth, H = innerHeight, s = f ** 1.5;
  const P0 = [W - Math.min(160, W * .2), H + 60], P1 = [W - Math.min(200, W * .25), planetScr.y + (H - planetScr.y) * .05], P2 = [planetScr.x, planetScr.y];
  const at = s => P0.map((v, i) => (1 - s) ** 2 * v + 2 * (1 - s) * s * P1[i] + s * s * P2[i]);
  const [x, y] = at(s), [x2, y2] = at(Math.min(1, s + .01)), size = lerp(1, .12, s);
  rocket.style.opacity = 1 - sub(f, .88, 1);
  rocket.style.transform = `translate(${x}px, ${y}px) rotate(${Math.atan2(y2 - y, x2 - x) + Math.PI / 2}rad) scale(${size}) translate(-50%, -50%)`;
  if (now - lastPuff > 40 && f < .9) {   // smoke, left behind
    lastPuff = now;
    const p = document.createElement('i'); p.className = 'puff';
    p.style.setProperty('--at', `translate(${x - (x2 - x) * 2.5}px, ${y - (y2 - y) * 2.5}px)`); p.style.setProperty('--s', size);
    p.addEventListener('animationend', () => p.remove()); document.body.appendChild(p);
  }
}

const qLook = new THREE.Quaternion(), eLook = new THREE.Euler();
const qPitch = new THREE.Quaternion(), X_AXIS = new THREE.Vector3(1, 0, 0);
const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
let holoK = -1, holoOn = 0, holoStart = 0;
function toScreen(v) { vC.copy(v).project(camera); return [(vC.x + 1) / 2 * innerWidth, (1 - vC.y) / 2 * innerHeight]; }

// keep a scene's things to the wedge of longitude from start, width wide, behind the turn's lead meridian:
// two planes through the axis, both kept to (or, wider than half round, either)
const vP1 = new THREE.Vector3();
function cutTo(sc, start, width) {
  const [p1, p2] = sc.planes;
  if (width >= 2 * Math.PI - 1e-6) { p1.set(vW.set(0, 0, 1), 1e3); p2.set(vW, 1e3); }
  else if (width <= 0) { p1.set(vW.set(0, 0, 1), -1e3); p2.set(vW, 1e3); }
  else {
    vP1.set(wipe.lead.z, 0, -wipe.lead.x);   // the lead turned a quarter on, into the wedge
    p1.normal.copy(vP1).applyAxisAngle(Y, start); p1.constant = 0;
    p2.normal.copy(vP1).applyAxisAngle(Y, start + width).negate(); p2.constant = 0;
    p1.applyMatrix4(spinG.matrixWorld); p2.applyMatrix4(spinG.matrixWorld);
  }
  const either = width > Math.PI && width < 2 * Math.PI - 1e-6;
  if (sc.mats[0]?.clipIntersection !== either) for (const m of sc.mats) m.clipIntersection = either;
}

// the sink at the far edge, for each scene on (see SINK_GLSL), from where the planet is now
const mSink = new THREE.Matrix4(), vL = new THREE.Vector3(), vQ = new THREE.Vector3();
function sinkAt() {
  mSink.multiplyMatrices(camera.matrixWorldInverse, spinG.matrixWorld);
  const R = vW.setFromMatrixColumn(mSink, 0).length();
  vC.setFromMatrixPosition(mSink);
  vL.copy(wipe.lead).transformDirection(mSink); vQ.set(wipe.lead.z, 0, -wipe.lead.x).transformDirection(mSink);
  for (const [k, sc] of Object.entries(SCENES)) {
    const side = +k === wipe.B ? -1 : 1;
    sc.sink.value.set(
      vC.x, vL.x, vQ.x, +wipe.on,
      vC.y, vL.y, vQ.y, wipe.e,
      vC.z, vL.z, vQ.z, 0,
      R, side, SINK, 0);
  }
}

let last = 0, hold = false;
function frame(time) {
  const t = time / 1000, dt = Math.min(.05, Math.max(0, t - last)); last = t;
  if (!hold && want !== cur && time - wantSince > 120) go(want);
  stepModes(dt);
  const em = ease(mode.m), g = mode.g, es = ease(mode.s);
  const g1 = ease(sub(g, 0, .42)), g2 = ease(sub(g, .22, .5)), g3 = ease(sub(g, .36, .7)), g4 = sub(g, .5, .82), gone = ease(sub(g, 0, .3));
  stepSpin(dt, time); agentsMove(dt);
  // the turn between scenes: how far it's got, the planet's blend, and each scene's cut
  if (wipe.on) {   // how far round it's turned since the turn began, and so how wide B's wedge is
    const th = wipe.a0 - spin.a;
    wipe.w = THREE.MathUtils.clamp(2 * th, 0, 2 * Math.PI);
    // the far edge, its fade from all A to all B over the turn
    wipe.e = wipe.w * (1 + FADE / (2 * Math.PI)) - FADE / 2;
    if (th >= Math.PI) {   // all round
      wipe.A = wipe.B; wipe.on = false;
      if (queued !== null) go(queued);
    }
  }
  const U = plutoMat.uniforms;
  U.scA.value = wipe.A; U.scB.value = wipe.B; U.thA.value = SCENES[wipe.A].th; U.thB.value = SCENES[wipe.B].th;
  U.wipe.value.set(wipe.lead.x, 0, wipe.lead.z, wipe.e); U.blend.value = wipe.on ? 1 : 0;
  spinG.updateMatrixWorld(true);
  for (const [k, sc] of Object.entries(SCENES)) {
    const on = +k === wipe.A || +k === wipe.B;
    for (const g of sc.groups) g.visible = on;
    // a scene's things go a little inside its ground's edge, so none stand on the other's
    if (!wipe.on) cutTo(sc, 0, 2 * Math.PI);
    else if (+k === wipe.B) cutTo(sc, CUT, Math.min(2 * Math.PI, wipe.e - CUT));
    else cutTo(sc, wipe.e, 2 * Math.PI - CUT - wipe.e);
  }
  threadsG.rotation.y = SCENES[THREADS].th; pinsG.rotation.y = SCENES[COVER].th; bpG.rotation.y = SCENES[BLUEPRINT].th;
  if (threadsG.visible) { threadsAt(cur === THREADS_STOP && t > threadsT0 ? (t - threadsT0) % LOOP : -1); signalsAt(t); }
  // the split between the rendered windows and the blueprint
  splitAt(dt);
  look.lerp(mouse, 1 - Math.exp(-dt * 3));

  // the whole scene: drawn back for the globe and its table, which it tips forward to show the top of, and
  // further back and up for the view from Earth
  const S = lerp(1, .6, g1) * lerp(1, .42, es);
  rootG.scale.setScalar(S); rootG.position.set(0, .3 * g1 + .55 * es, 0);
  qLook.setFromEuler(eLook.set(look.y * .04, look.x * .05, 0)); qPitch.setFromAxisAngle(X_AXIS, .3 * g1);
  rootG.quaternion.copy(qLook).multiply(qPitch);
  // the planet: smaller and a little up at the shells' stop; upright on the globe's axle
  tiltG.quaternion.slerpQuaternions(qBase, qGlobe, g1);
  tiltG.scale.setScalar(lerp(1, .44, em)); tiltG.position.y = .14 * em;
  spinG.rotation.y = spin.a;
  agentsG.visible &&= Math.abs(agent.phi) < 1.9; if (agentsG.visible) agentsG.rotation.y = agent.phi;
  if (agentsG.visible || agent.fade > 0) agentsAt(t, dt, cur === AGENTS);

  // the globe's stand, coming together, and the roadmap's pins on it
  mount.visible = g > 0; axle.visible = g2 > 0; axle.scale.set(1, Math.max(1e-3, g2), 1); setArc(g3);
  ticks.children.forEach(tk => { tk.visible = g3 >= tk.userData.f; });
  desk.visible = g4 > 0; desk.position.y = -3.2 * (1 - outBack(g4));
  deskProps.forEach((p, i) => p.scale.copy(p.userData.s).multiplyScalar(Math.max(1e-3, outBack(sub(g, .8 + .04 * i, .94 + .04 * i)))));
  pinsG.visible &&= g > .7;
  pins.forEach((p, i) => p.scale.setScalar(Math.max(1e-3, outBack(sub(g, .74 + .025 * i, .84 + .025 * i)))));
  for (const s of strings) s.material.opacity = sub(g, .9, 1);

  // the moons, from their places to their slots on the wide orbit, one after another
  orbit.quaternion.slerpQuaternions(qOrbit, qMoon, em); orbit.position.copy(tiltG.position);
  orbit.scale.setScalar(lerp(1.62, RM, em)); orbitMat.opacity = .45 * (1 - gone) * (1 - es); orbit.visible = orbitMat.opacity > .01;
  MOONS.forEach((m, i) => {
    const e = ease(sub(mode.m, .07 * i, .72 + .07 * i));
    if (m.a === undefined) vA.copy(charonHome);
    else { const a = m.a + t * (.05 + .02 * i); vA.set(Math.cos(a) * 1.62, 0, Math.sin(a) * 1.62).applyQuaternion(qOrbit); }
    vB.set(Math.cos(SLOT[i]) * RM, 0, Math.sin(SLOT[i]) * RM).applyQuaternion(qMoon); vB.y += tiltG.position.y + .012 * Math.sin(t * 1.3 + i * 1.7);
    m.g.position.lerpVectors(vA, vB, e);
    const size = lerp(m.small, m.big, e) * (1 - gone) * (m.a === undefined ? 1 : 1 - es);
    m.g.scale.setScalar(Math.max(1e-4, size)); m.g.visible = size > 1e-4;
    m.body.rotation.y = t * (m.a === undefined ? .03 : .25) + i;
    // where it is on the screen, for pointing at, and its name under it
    m.g.updateMatrixWorld(); vC.setFromMatrixPosition(m.g.matrixWorld);
    const [x, y] = toScreen(vC), s = moonScr[i]; s.x = x; s.y = y; s.r = m.big * S * view.r;
    const el = moonLabels[i]; el.style.opacity = sub(em, .6, 1); el.style.transform = `translate(${x}px, ${y + s.r + 12}px) translate(-50%, 0)`;
  });

  // the hologram: switches off, then on again with the next moon's shell
  const hov = em > .95 ? (hovList >= 0 ? hovList : hovMoon) : -1;
  moonLabels.forEach((el, i) => el.classList.toggle('on', i === hov));
  listItems.forEach(li => li.classList.toggle('on', +li.dataset.moon === hov));
  if (hov !== holoK) { holoOn = Math.max(0, holoOn - dt * 7); if (holoOn === 0) { holoK = hov; holoStart = t; } }
  else if (holoK >= 0) holoOn = Math.min(1, holoOn + dt * 2.6);
  holo.visible = beam.visible = holoK >= 0 && holoOn > 0;
  if (holo.visible) {
    // on a narrow screen it's bigger, and over the middle
    const narrow = innerWidth <= 900, m = MOONS[holoK], on = ease(holoOn), hw = narrow ? 1.45 : 1.05, hh = hw * HH / HW;
    holo.scale.setScalar(hw / 1.05);
    holo.position.set(narrow ? 0 : Math.max(-.7, Math.min(.7, m.g.position.x)), narrow ? 1.2 : .98, .6);
    holoMat.uniforms.on.value = on; holoMat.uniforms.amount.value = em; holoMat.uniforms.time.value = t;
    beamMat.uniforms.amount.value = on * em;
    drawShell(holoK, t - holoStart);
    const p = beamGeo.attributes.position, top = m.g.position.y + m.big * .8, bot = holo.position.y - hh / 2 * on;
    p.setXYZ(0, m.g.position.x - m.big * .45, top, m.g.position.z); p.setXYZ(1, m.g.position.x + m.big * .45, top, m.g.position.z);
    p.setXYZ(2, holo.position.x - hw * .42, bot, holo.position.z); p.setXYZ(3, holo.position.x + hw * .42, bot, holo.position.z);
    p.needsUpdate = true;
  }

  // the planet's haze and the glow behind it, where the planet is now
  rootG.updateMatrixWorld(); vA.setFromMatrixPosition(tiltG.matrixWorld);
  sinkAt();
  const [px, py] = toScreen(vA), pr = view.r * S * tiltG.scale.x;
  planetScr.x = px; planetScr.y = py; planetScr.r = pr;
  haze.position.copy(vA); haze.scale.setScalar(S * tiltG.scale.x); hazeMat.uniforms.amount.value = (1 - g1) * (1 - .5 * es);
  const dpr = renderer.getPixelRatio();
  bgMat.uniforms.center.value.set(px * dpr, (innerHeight - py) * dpr); bgMat.uniforms.rad.value = pr * dpr;
  bgMat.uniforms.sky.value = es; veil.value = es;
  for (const f of anims) f(t, dt);
  bgMat.uniforms.time.value = t;
  flyRocket(time);
}
function draw() {
  renderer.setRenderTarget(null); renderer.clear();
  renderer.render(bgScene, bgCam); renderer.clearDepth(); renderer.render(scene, camera);
}
addEventListener('resize', resize); resize();
// every material compiled now, rather than with a stall the first time each comes into view
for (const sc of Object.values(SCENES)) for (const g of sc.groups) g.visible = true;
holo.visible = beam.visible = mount.visible = desk.visible = true;
renderer.compile(scene, camera); renderer.compile(bgScene, bgCam);
navs.forEach(n => n.classList.toggle('on', +n.dataset.go === cur));
document.body.classList.toggle('sky', cur === SKY);
// the pace: the median gap between frames over a second and a half; two slow ones running (under about 40
// frames a second) and the resolution comes down a step. (A stall, hidden or compiling, isn't counted.)
const gaps = []; let lastTick = 0, slow = 0;
function pace(time) {
  const g = time - lastTick; lastTick = time;
  if (document.hidden || g <= 0 || g > 250) return;
  gaps.push(g); if (gaps.length < 90) return;
  const m = gaps.sort((a, b) => a - b)[45]; gaps.length = 0;
  slow = m > 25 ? slow + 1 : 0;
  if (slow < 2 || pr <= MIN_PR) return;
  slow = 0; pr = Math.max(MIN_PR, pr * .8); renderer.setPixelRatio(pr); resize();
}
function tick(time) {
  requestAnimationFrame(tick); pace(time || 0);
  try { frame(time || 0); draw(); } catch (e) { window.__err = String(e.stack || e); }
}
tick();

// for checking frames: __shot(k, secs) renders stop k, landed and changed, after secs of its animation;
// __shotAt(angle in degrees) any turn; __shotMid(k, f) partway into k's change of scene; __hover(i) points at
// moon i
function settle(k) {
  hold = true; cur = want = k; spin.a = 0; spin.drag = null;
  wipe.A = wipe.B = SCENE_OF[k]; wipe.on = false; bp.psi = bp.lock = 0; queued = null; for (const sc of Object.values(SCENES)) sc.th = 0;
  for (const m in mode) mode[m] = MODE_OF[k] === m ? 1 : 0;
  agentsTo(k === AGENTS ? 0 : Infinity); agent.fade = +(k === AGENTS); for (const tr of trails) { tr.pts.length = 0; tr.m.visible = false; }
  document.body.classList.toggle('sky', k === SKY);
}
const shoot = () => { draw(); return canvas.toDataURL('image/jpeg', .9); };
function run(secs) { const t0 = performance.now(); threadsT0 = t0 / 1000; spin.w = drift(); last = t0 / 1000; for (let s = 0; s <= secs; s += 1 / 30) frame(t0 + s * 1000); }
window.__shot = (k, secs = 0) => { settle(k); if (holoK >= 0) holoOn = 1; run(secs); return shoot(); };
window.__shotAt = (deg, k = cur) => { settle(k); spin.a = -deg * D2R; spin.w = drift(); frame(performance.now()); return shoot(); };
// the turn from stop a to stop b, a fraction f of the way
window.__shotTurn = (a, b, f) => {
  settle(a); spin.w = drift(); go(b);
  let t = performance.now(); last = t / 1000;
  for (let i = 0; i < 600 && wipe.on && wipe.a0 - spin.a < f * Math.PI; i++) frame(t += 1000 / 60);
  return shoot();
};
window.__hover = i => { hovList = i; };
window.__shotMid = (k, f) => { settle(k); mode[MODE_OF[k]] = f; frame(performance.now()); return shoot(); };
window.__mode = mode;
window.__release = () => { hold = false; };
window.__go = go; window.__spin = spin; window.__wipe = wipe; window.__agent = agent; window.__snap = () => { draw(); return canvas; };
window.__ready = true;
