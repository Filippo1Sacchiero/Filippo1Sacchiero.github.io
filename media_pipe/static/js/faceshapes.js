// Face Shapes: MediaPipe Face Detection in the browser. Each of the 6 keypoints gets a shape:
// eyes = concentric circles, nose/mouth/ears = random shapes. Any key reshuffles, Esc/Q stops.
import { FaceDetector, FilesetResolver } from '../vendor/mediapipe-tasks-vision-0.10.21/vision_bundle.mjs';

const WASM_PATH = 'static/vendor/mediapipe-tasks-vision-0.10.21/wasm';
const MODEL_PATH = 'models/blaze_face_short_range.tflite';
// Keypoint order: 0 right eye, 1 left eye, 2 nose tip, 3 mouth, 4 right ear, 5 left ear
const OTHER = [{ idx: 2, name: 'Nose' }, { idx: 3, name: 'Mouth' }, { idx: 4, name: 'Right ear' }, { idx: 5, name: 'Left ear' }];
const COLORS = ['#facc15', '#f472b6', '#fb923c', '#22d3ee'];
const EYE_RINGS = ['#22c55e', '#ffffff', '#ef4444'];
const SHAPES = ['square', 'triangle', 'diamond', 'pentagon', 'hexagon', 'star', 'cross', 'ellipse'];

const $ = (id) => document.getElementById(id);
const section = $('shapesInputSection');
const startBtn = $('shapesStartBtn');
const btnSpinner = $('shapesBtnSpinner');
const btnText = $('shapesBtnText');
const statusLine = $('shapesStatus');
const summary = $('shapesSummary');
const canvas = $('shapesCanvas');
const ctx = canvas.getContext('2d');
const placeholder = $('shapesPlaceholder');
const video = $('shapesVideo');

let detector = null;
let stream = null;
let running = false;
let frameHandle = null;
let lastVideoTime = -1;
let shapes = pickShapes();

function pickShapes() {
  return [...SHAPES].sort(() => Math.random() - 0.5).slice(0, OTHER.length);
}

function showAssignment() {
  summary.textContent = 'Eyes: concentric circles · ' + OTHER.map((o, i) => `${o.name}: ${shapes[i]}`).join(' · ');
}

function shuffle() {
  shapes = pickShapes();
  showAssignment();
}

async function getDetector() {
  if (detector) return detector;
  statusLine.textContent = 'Loading face detection model...';
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: 'VIDEO',
    minDetectionConfidence: 0.5,
  });
  try {
    detector = await FaceDetector.createFromOptions(fileset, options('GPU'));
  } catch (err) {
    console.warn('GPU delegate unavailable, using CPU', err);
    detector = await FaceDetector.createFromOptions(fileset, options('CPU'));
  }
  statusLine.textContent = '';
  return detector;
}

// ---------------- Drawing ----------------
function polygon(cx, cy, r, n, rot = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = rot + (2 * Math.PI * i) / n;
    ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  ctx.closePath();
  ctx.stroke();
}

function drawShape(name, cx, cy, r, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, r / 6);
  switch (name) {
    case 'square': ctx.strokeRect(cx - r, cy - r, 2 * r, 2 * r); break;
    case 'triangle': polygon(cx, cy, r, 3); break;
    case 'diamond': polygon(cx, cy, r, 4); break;
    case 'pentagon': polygon(cx, cy, r, 5); break;
    case 'hexagon': polygon(cx, cy, r, 6); break;
    case 'ellipse':
      ctx.beginPath(); ctx.ellipse(cx, cy, r, r / 2, 0, 0, 2 * Math.PI); ctx.stroke(); break;
    case 'cross':
      ctx.beginPath();
      ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
      ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);
      ctx.stroke(); break;
    case 'star':
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 ? r * 0.45 : r;
        const a = -Math.PI / 2 + (Math.PI * i) / 5;
        ctx.lineTo(cx + rr * Math.cos(a), cy + rr * Math.sin(a));
      }
      ctx.closePath(); ctx.stroke(); break;
  }
}

function drawEye(cx, cy, r) {
  ctx.lineWidth = Math.max(2, r / 8);
  [1, 0.66, 0.33].forEach((k, i) => {
    ctx.strokeStyle = EYE_RINGS[i];
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, r * k), 0, 2 * Math.PI); ctx.stroke();
  });
}

function renderFrame() {
  frameHandle = null;
  if (!running) return;
  const w = video.videoWidth, h = video.videoHeight;
  if (canvas.width !== w) { canvas.width = w; canvas.height = h; }

  // Mirrored, like a mirror/selfie view
  ctx.save();
  ctx.translate(w, 0); ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, w, h);
  ctx.restore();

  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    renderFrame.last = detector.detectForVideo(video, performance.now());
  }
  const detections = renderFrame.last?.detections ?? [];
  for (const det of detections) {
    const kp = det.keypoints.map(p => [(1 - p.x) * w, p.y * h]);
    if (kp.length < 6) continue;
    // Eye size ~ a quarter of the distance between the eyes
    const r = Math.max(4, Math.hypot(kp[0][0] - kp[1][0], kp[0][1] - kp[1][1]) * 0.25);
    drawEye(...kp[0], r);
    drawEye(...kp[1], r);
    OTHER.forEach((o, i) => drawShape(shapes[i], ...kp[o.idx], r, COLORS[i]));
  }
  statusLine.textContent = detections.length ? `${detections.length} face(s) detected` : 'No face detected';
  frameHandle = requestAnimationFrame(renderFrame);
}

// ---------------- Start / stop ----------------
async function start() {
  startBtn.disabled = true;
  btnSpinner.style.display = 'inline-block';
  try {
    await getDetector();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a camera.');
    btnText.textContent = 'Waiting for camera...';
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
    video.srcObject = stream;
    await new Promise((resolve) => {
      if (video.readyState >= 2) resolve();
      else video.addEventListener('loadeddata', resolve, { once: true });
    });
    await video.play();
    running = true;
    placeholder.style.display = 'none';
    showAssignment();
    frameHandle = requestAnimationFrame(renderFrame);
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
  lastVideoTime = -1;
  renderFrame.last = null;
  placeholder.style.display = '';
  btnText.textContent = 'Start Camera';
  summary.textContent = 'Camera stopped. Press Start Camera.';
  statusLine.textContent = '';
}

startBtn.addEventListener('click', () => (running ? stop() : start()));
$('shapesShuffleBtn').addEventListener('click', shuffle);
['tabImageBtn', 'tabVideoBtn', 'tabFaceBtn', 'tabFitnessBtn', 'tabGestureBtn', 'tabBackgroundBtn', 'tabParticlesBtn', 'tabTmBtn', 'tabYoloBtn'].forEach(id => $(id).addEventListener('click', stop));

document.addEventListener('keydown', (e) => {
  if (section.style.display === 'none' || !running) return; // only on this tab, while the camera runs
  if (e.target.closest?.('input, textarea, select')) return;
  if (e.repeat || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
  e.preventDefault();
  if (e.key === 'Escape' || e.key.toLowerCase() === 'q') stop();
  else shuffle();
});
