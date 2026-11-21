// Particles: thousands of particles morph into shapes, driven live by hands + face (MediaPipe in the browser).
//  - Hand openness expands / collapses the shape; the shape follows your palm.
//  - Fist -> open: next shape + palette.   👍 next palette.   ✌️ burst.
//  - Distance to screen (face size) shrinks the particle range as you come closer.
//  - "Face" shape: particles assemble into the Face Shapes figure on your real face.
//  - Any key: random shape.  Esc / Q: stop.
import { GestureRecognizer, FaceDetector, FilesetResolver } from '../vendor/mediapipe-tasks-vision-0.10.21/vision_bundle.mjs';

const WASM_PATH = 'static/vendor/mediapipe-tasks-vision-0.10.21/wasm';
const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

// ---------------- Shapes: unit points for u in [0,1) ----------------
function polyPoint(verts, u) {
  const n = verts.length, s = (u * n) % n, i = Math.floor(s), f = s - i;
  const [a, b] = [verts[i], verts[(i + 1) % n]];
  return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f };
}
const ngon = (n, rot = -Math.PI / 2) => Array.from({ length: n }, (_, i) => [Math.cos(rot + TAU * i / n), Math.sin(rot + TAU * i / n)]);
const starVerts = Array.from({ length: 10 }, (_, i) => {
  const r = i % 2 ? 0.42 : 1, a = -Math.PI / 2 + Math.PI * i / 5;
  return [r * Math.cos(a), r * Math.sin(a)];
});
const MINI = { // the Face Shapes set
  square: (u) => polyPoint([[-1, -1], [1, -1], [1, 1], [-1, 1]], u),
  triangle: (u) => polyPoint(ngon(3), u),
  diamond: (u) => polyPoint(ngon(4), u),
  pentagon: (u) => polyPoint(ngon(5), u),
  hexagon: (u) => polyPoint(ngon(6), u),
  star: (u) => polyPoint(starVerts, u),
  ellipse: (u) => ({ x: Math.cos(u * TAU), y: 0.5 * Math.sin(u * TAU) }),
  cross: (u) => { const t = (u * 2) % 1, s = u < 0.5 ? 1 : -1; return { x: -1 + 2 * t, y: s * (-1 + 2 * t) }; },
};
const MINI_NAMES = Object.keys(MINI);

const SHAPES = [
  { name: 'Heart', fn: (u) => { const t = u * TAU; return { x: 16 * Math.sin(t) ** 3 / 17, y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17 }; } },
  { name: 'Star', fn: MINI.star },
  { name: 'Flower', fn: (u) => { const t = u * TAU, r = Math.abs(Math.cos(2.5 * t)); return { x: r * Math.cos(t), y: r * Math.sin(t) }; } },
  { name: 'Butterfly', fn: (u) => { const s = u * TAU * 6, r = Math.exp(Math.sin(s)) - 2 * Math.cos(4 * s) + Math.sin((2 * s - Math.PI) / 24) ** 5; return { x: Math.sin(s) * r / 4, y: -Math.cos(s) * r / 4 }; } },
  { name: 'Spiral', fn: (u) => { const a = u * TAU * 3; return { x: u * Math.cos(a), y: u * Math.sin(a) }; } },
  { name: 'Galaxy', fn: (u, j) => { const arm = Math.floor(j * 3), r = u, a = r * 5 + arm * TAU / 3; return { x: r * Math.cos(a), y: r * Math.sin(a) * 0.8 }; } },
  { name: 'Face', face: true },
];

const PALETTES = [
  { name: 'Neon Pink', a: '#ff4fa3', b: '#ffd1ec' },
  { name: 'Aqua', a: '#00ffd0', b: '#7aa8ff' },
  { name: 'Sunset', a: '#ff8a3d', b: '#ffd166' },
  { name: 'Lime', a: '#9dff3d', b: '#e8ffb0' },
  { name: 'Violet', a: '#a66bff', b: '#ff9bf5' },
  { name: 'Ice', a: '#ffffff', b: '#7fdcff' },
];

// ---------------- Elements ----------------
const section = $('particlesInputSection');
const startBtn = $('pcStartBtn');
const btnSpinner = $('pcBtnSpinner');
const btnText = $('pcBtnText');
const statusLine = $('pcStatus');
const countSel = $('pcCount');
const videoToggle = $('pcShowVideo');
const skeletonToggle = $('pcShowSkeleton');
const canvas = $('pcCanvas');
const ctx = canvas.getContext('2d');
const placeholder = $('pcPlaceholder');
const video = $('pcVideo');
const ui = {
  clock: $('pcClock'), date: $('pcDate'), hand: $('pcHand'), gesture: $('pcGesture'),
  open: $('pcOpen'), openBar: $('pcOpenBar'), dist: $('pcDist'), distBar: $('pcDistBar'),
  shape: $('pcShape'), color: $('pcColor'), fps: $('pcFps'),
};

// ---------------- State ----------------
let recognizer = null, faceDetector = null, stream = null, running = false, frameHandle = null;
let lastVideoTime = -1, frameNo = 0, fpsT = performance.now(), fpsN = 0;
let particles = [];
let shapeIdx = 0, paletteIdx = 0, faceMinis = pickMinis();
let openness = 0.5, rawOpen = 0.5, distScale = 1, rawDist = 1;
let center = { x: 0.5, y: 0.5 }, rawCenter = { x: 0.5, y: 0.5 };
let handSeen = false, wasFist = false, hand = null, face = null;
let gestureName = '-', gestureStreak = 0, gestureCooldown = 0, burst = 0;

function pickMinis() { return [...MINI_NAMES].sort(() => Math.random() - 0.5).slice(0, 4); }

function makeParticles(n) {
  const w = canvas.width || 1280, h = canvas.height || 720;
  particles = Array.from({ length: n }, (_, i) => ({
    u: i / n, j: Math.random(),
    x: Math.random() * w, y: Math.random() * h, vx: 0, vy: 0,
    jx: Math.random() * 2 - 1, jy: Math.random() * 2 - 1,
    tw: Math.random() * TAU, size: 1 + Math.random() * 1.6, alt: Math.random() < 0.3,
  }));
}

function applyShape() {
  const p = PALETTES[paletteIdx];
  ui.shape.textContent = SHAPES[shapeIdx].name;
  ui.color.textContent = p.name;
  ui.color.style.color = p.a;
  if (SHAPES[shapeIdx].face) faceMinis = pickMinis();
}
function nextShape(random = false) {
  shapeIdx = random ? (shapeIdx + 1 + Math.floor(Math.random() * (SHAPES.length - 1))) % SHAPES.length : (shapeIdx + 1) % SHAPES.length;
  paletteIdx = (paletteIdx + 1) % PALETTES.length;
  applyShape();
}

// ---------------- Models ----------------
async function loadModels() {
  if (recognizer && faceDetector) return;
  statusLine.textContent = 'Loading hand + face models...';
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  const make = async (Task, opts) => {
    try { return await Task.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'GPU' } }); }
    catch (e) { console.warn('GPU unavailable, using CPU', e); return Task.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } }); }
  };
  recognizer = await make(GestureRecognizer, { baseOptions: { modelAssetPath: 'models/gesture_recognizer.task' }, runningMode: 'VIDEO', numHands: 1 });
  faceDetector = await make(FaceDetector, { baseOptions: { modelAssetPath: 'models/blaze_face_short_range.tflite' }, runningMode: 'VIDEO', minDetectionConfidence: 0.5 });
  statusLine.textContent = '';
}

// ---------------- Perception ----------------
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function perceive() {
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  frameNo++;
  const now = performance.now();

  const g = recognizer.recognizeForVideo(video, now);
  hand = g.landmarks?.[0] || null;
  handSeen = !!hand;
  if (hand) {
    // openness: fingertips-to-wrist distance relative to palm size (~1 fist, ~2 open)
    const palm = d2(hand[0], hand[9]) || 1e-3;
    const tips = [4, 8, 12, 16, 20].reduce((s, i) => s + d2(hand[i], hand[0]), 0) / 5;
    rawOpen = clamp((tips / palm - 1.05) / 0.85);
    rawCenter = { x: 1 - (hand[0].x + hand[9].x) / 2, y: (hand[0].y + hand[9].y) / 2 };
    if (!faceRecent()) rawDist = clamp(1.25 - palm * 3, 0.4, 1); // fallback: big palm = close
    // Fist -> open switches shape & palette
    if (rawOpen < 0.2) wasFist = true;
    else if (rawOpen > 0.75 && wasFist) { wasFist = false; nextShape(); }
    handleGesture(g.gestures?.[0]?.[0]);
  } else {
    rawCenter = { x: 0.5, y: 0.5 };
    rawOpen = 0.55;
    handleGesture(null);
  }

  // Face every 2nd frame (cheaper on slow CPUs)
  if (frameNo % 2 === 0) {
    const f = faceDetector.detectForVideo(video, now + 0.5).detections?.[0];
    if (f && f.keypoints.length >= 6) {
      face = { kp: f.keypoints.map(p => ({ x: 1 - p.x, y: p.y })), t: now };
      const eye = d2(face.kp[0], face.kp[1]);           // ~0.06 far .. ~0.2 close
      rawDist = clamp(1.3 - (eye - 0.05) * 5.5, 0.35, 1.15);
    }
  }
}
const faceRecent = () => face && performance.now() - face.t < 500;

function handleGesture(cat) {
  const name = cat && cat.score > 0.6 && cat.categoryName !== 'None' ? cat.categoryName : '-';
  gestureStreak = name === gestureName ? gestureStreak + 1 : 0;
  gestureName = name;
  ui.gesture.textContent = { Thumb_Up: '👍', Victory: '✌️', Closed_Fist: '✊', Open_Palm: '✋', Pointing_Up: '☝️', Thumb_Down: '👎', ILoveYou: '🤟' }[name] || '-';
  if (gestureCooldown > 0 || gestureStreak !== 5) return;
  if (name === 'Thumb_Up') { paletteIdx = (paletteIdx + 1) % PALETTES.length; applyShape(); gestureCooldown = 30; }
  if (name === 'Victory') { burst = 1; gestureCooldown = 30; }
}

// ---------------- Targets ----------------
function faceTarget(p, W, H, r) {
  // 6 groups: two eyes (3 rings) + nose, mouth, ears with the random Face Shapes
  const kp = face.kp, g = Math.floor(p.u * 6), u = (p.u * 6) % 1;
  const k = kp[g];
  if (g < 2) {
    const ring = [1, 0.66, 0.33][Math.floor(u * 3)], a = ((u * 3) % 1) * TAU;
    return { x: k.x * W + Math.cos(a) * r * ring, y: k.y * H + Math.sin(a) * r * ring };
  }
  const pt = MINI[faceMinis[g - 2]](u);
  return { x: k.x * W + pt.x * r, y: k.y * H + pt.y * r };
}

// ---------------- Render loop ----------------
function frame() {
  frameHandle = null;
  if (!running) return;
  perceive();
  const W = canvas.width, H = canvas.height, time = performance.now() / 1000;

  openness += (rawOpen - openness) * 0.12;
  distScale += (rawDist - distScale) * 0.08;
  center.x += (rawCenter.x - center.x) * 0.1;
  center.y += (rawCenter.y - center.y) * 0.1;
  burst *= 0.93;
  if (gestureCooldown > 0) gestureCooldown--;

  // background: dimmed mirrored camera or plain dark
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  if (videoToggle.checked) {
    ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1); ctx.drawImage(video, 0, 0, W, H); ctx.restore();
    ctx.fillStyle = 'rgba(5,8,20,0.72)'; ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = 'rgba(5,8,20,0.35)'; ctx.fillRect(0, 0, W, H); // trails
  }

  const shape = SHAPES[shapeIdx];
  const useFace = shape.face && faceRecent();
  const baseR = Math.min(W, H) * 0.42 * distScale;
  const scale = baseR * (0.08 + 0.92 * openness);
  const scatter = (Math.max(0, openness - 0.6) * 2.5 + burst * 4) * baseR;
  const cx = center.x * W, cy = center.y * H;
  const eyeR = useFace ? Math.max(6, d2(face.kp[0], face.kp[1]) * W * 0.25) : 0;
  const pal = PALETTES[paletteIdx];

  ctx.globalCompositeOperation = 'lighter';
  for (const p of particles) {
    let tx, ty;
    if (useFace) {
      ({ x: tx, y: ty } = faceTarget(p, W, H, eyeR));
      tx += p.jx * burst * baseR; ty += p.jy * burst * baseR;
    } else if (shape.face) { // Face mode but no face yet: slow orbit
      const a = p.u * TAU + time * 0.3;
      tx = cx + Math.cos(a) * scale * (0.6 + p.j * 0.4); ty = cy + Math.sin(a) * scale * (0.6 + p.j * 0.4);
    } else {
      const pt = shape.fn(p.u, p.j);
      tx = cx + pt.x * scale + p.jx * scatter;
      ty = cy + pt.y * scale + p.jy * scatter;
    }
    // spring + damping => smooth morphing between shapes
    p.vx = (p.vx + (tx - p.x) * 0.06) * 0.82;
    p.vy = (p.vy + (ty - p.y) * 0.06) * 0.82;
    p.x += p.vx + Math.sin(time * 2 + p.tw) * 0.3;
    p.y += p.vy + Math.cos(time * 2 + p.tw) * 0.3;
    ctx.globalAlpha = (0.55 + 0.45 * Math.sin(time * 3 + p.tw)) * (useFace ? 0.9 : 0.35 + 0.65 * openness);
    ctx.fillStyle = p.alt ? pal.b : pal.a;
    ctx.fillRect(p.x, p.y, p.size, p.size);
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  if (skeletonToggle.checked && hand) drawHand(W, H);
  updateHud();
  frameHandle = requestAnimationFrame(frame);
}

const HAND_LINKS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
function drawHand(W, H) {
  const P = (i) => [(1 - hand[i].x) * W, hand[i].y * H];
  ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [a, b] of HAND_LINKS) { ctx.moveTo(...P(a)); ctx.lineTo(...P(b)); }
  ctx.stroke();
  ctx.fillStyle = PALETTES[paletteIdx].a;
  for (let i = 0; i < 21; i++) { const [x, y] = P(i); ctx.beginPath(); ctx.arc(x, y, 3, 0, TAU); ctx.fill(); }
}

function updateHud() {
  const pct = Math.round(openness * 100);
  ui.hand.textContent = handSeen ? (openness < 0.25 ? 'Fist' : openness > 0.7 ? 'Open' : 'Half open') : 'Not detected';
  ui.hand.dataset.state = handSeen ? (openness < 0.25 ? 'closed' : 'open') : 'none';
  ui.open.textContent = handSeen ? `${pct}%` : '--';
  ui.openBar.style.width = `${pct}%`;
  const closeness = clamp((1.15 - distScale) / 0.8);
  ui.dist.textContent = faceRecent() || handSeen ? (closeness > 0.66 ? 'Close' : closeness > 0.33 ? 'Medium' : 'Far') : '--';
  ui.distBar.style.width = `${Math.round(closeness * 100)}%`;
  fpsN++;
  const now = performance.now();
  if (now - fpsT > 1000) { ui.fps.textContent = `${Math.round(fpsN * 1000 / (now - fpsT))} fps`; fpsT = now; fpsN = 0; }
}

function tickClock() {
  const n = new Date();
  ui.clock.textContent = n.toLocaleTimeString([], { hour12: false });
  ui.date.textContent = n.toLocaleDateString([], { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
}
tickClock();
setInterval(tickClock, 1000);
applyShape();

// ---------------- Start / stop ----------------
async function start() {
  startBtn.disabled = true;
  btnSpinner.style.display = 'inline-block';
  try {
    await loadModels();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a camera.');
    btnText.textContent = 'Waiting for camera...';
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' }, audio: false });
    video.srcObject = stream;
    await new Promise((res) => (video.readyState >= 2 ? res() : video.addEventListener('loadeddata', res, { once: true })));
    await video.play();
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    makeParticles(+countSel.value);
    running = true;
    placeholder.style.display = 'none';
    frameHandle = requestAnimationFrame(frame);
  } catch (err) {
    stop();
    statusLine.textContent = `Error: ${err.message || err}`;
  } finally {
    btnSpinner.style.display = 'none';
    startBtn.disabled = false;
    btnText.textContent = running ? 'Stop Camera' : 'Start Camera';
  }
}

function stop() {
  running = false;
  if (frameHandle != null) cancelAnimationFrame(frameHandle);
  frameHandle = null;
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  lastVideoTime = -1; hand = null; face = null; handSeen = false;
  placeholder.style.display = '';
  btnText.textContent = 'Start Camera';
  updateHud();
}

startBtn.addEventListener('click', () => (running ? stop() : start()));
countSel.addEventListener('change', () => running && makeParticles(+countSel.value));
$('pcNextBtn').addEventListener('click', () => nextShape());
['tabImageBtn', 'tabVideoBtn', 'tabFaceBtn', 'tabFitnessBtn', 'tabGestureBtn', 'tabBackgroundBtn', 'tabShapesBtn', 'tabTmBtn', 'tabYoloBtn'].forEach(id => $(id)?.addEventListener('click', stop));

document.addEventListener('keydown', (e) => {
  if (section.style.display === 'none' || !running) return;
  if (e.target.closest?.('input, textarea, select')) return;
  if (e.repeat || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
  e.preventDefault();
  if (e.key === 'Escape' || e.key.toLowerCase() === 'q') stop();
  else nextShape(true);
});
