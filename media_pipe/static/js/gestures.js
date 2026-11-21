// Gestures: real-time two-hand gesture recognition with MediaPipe Gesture Recognizer, in the browser.
import { GestureRecognizer, FilesetResolver } from '../vendor/mediapipe-tasks-vision-0.10.21/vision_bundle.mjs';
import {
  GESTURES, HAND_COLORS, FINGER_COLORS, fingerOf, handsFromResult, describeHands, GestureStabilizer,
} from './gesture_logic.js';

const WASM_PATH = 'static/vendor/mediapipe-tasks-vision-0.10.21/wasm';
const MODEL_PATH = 'models/gesture_recognizer.task';
const SIDES = ['Left', 'Right'];
const FINGERTIPS = new Set([4, 8, 12, 16, 20]);
const PALM_COLOR = '#e2e8f0';

const $ = (id) => document.getElementById(id);

// ---------------- Elements ----------------
const startBtn = $('gestStartBtn');
const btnSpinner = $('gestBtnSpinner');
const btnText = $('gestBtnText');
const statusLine = $('gestStatus');
const scoreSlider = $('gestScoreSlider');
const scoreValue = $('gestScoreValue');
const colorMode = $('gestColorMode');
const fingerLegend = $('gestFingerLegend');
const mirrorToggle = $('gestMirror');
const labelsToggle = $('gestLabels');
const summary = $('gestSummary');
const canvas = $('gestCanvas');
const ctx = canvas.getContext('2d');
const placeholder = $('gestPlaceholder');
const video = $('gestVideo');
const log = $('gestLog');
const clearLogBtn = $('gestClearLogBtn');
const handUi = Object.fromEntries(SIDES.map(side => [side, {
  status: $(`gest${side}Status`),
  icon: $(`gest${side}Icon`),
  name: $(`gest${side}Name`),
  score: $(`gest${side}Score`),
  bar: $(`gest${side}Bar`),
}]));

// ---------------- State ----------------
let recognizer = null;
let stream = null;
let running = false;
let frameHandle = null;
let lastDetectTs = 0;
let lastVideoTime = -1;
let fpsWindow = [];
let history = [];
let lastLogged = null;
const stabilizers = { Left: new GestureStabilizer(4), Right: new GestureStabilizer(4) };

// ---------------- Model ----------------
async function getRecognizer() {
  if (recognizer) return recognizer;
  setStatus('Loading gesture model...');
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    recognizer = await GestureRecognizer.createFromOptions(fileset, options('GPU'));
  } catch (err) {
    console.warn('GPU delegate unavailable, using CPU', err);
    recognizer = await GestureRecognizer.createFromOptions(fileset, options('CPU'));
  }
  setStatus('');
  return recognizer;
}

// ---------------- Start / stop ----------------
startBtn.addEventListener('click', () => {
  if (running) stop();
  else start().catch(showError);
});

// Stop the camera when leaving the tab (privacy, CPU, and the camera may be needed elsewhere).
['tabImageBtn', 'tabVideoBtn', 'tabFaceBtn', 'tabFitnessBtn', 'tabBackgroundBtn', 'tabShapesBtn', 'tabParticlesBtn', 'tabTmBtn', 'tabYoloBtn'].forEach(id => $(id).addEventListener('click', stop));

async function start() {
  startBtn.disabled = true;
  btnSpinner.style.display = 'inline-block';
  try {
    await getRecognizer();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a camera.');
    btnText.textContent = 'Waiting for camera...';
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
    await new Promise((resolve) => {
      if (video.readyState >= 2) resolve();
      else video.addEventListener('loadeddata', resolve, { once: true });
    });
    await video.play();
    running = true;
    placeholder.style.display = 'none';
    SIDES.forEach(s => stabilizers[s].reset());
    setSummary('Show your hands to the camera.', 'info');
    scheduleFrame();
  } catch (err) {
    stop();
    throw err;
  } finally {
    btnSpinner.style.display = 'none';
    startBtn.disabled = false;
    btnText.textContent = running ? 'Stop Camera' : 'Start Camera';
  }
}

function stop() {
  const wasRunning = running;
  running = false;
  if (frameHandle != null) {
    if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
    cancelAnimationFrame(frameHandle);
    frameHandle = null;
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  video.srcObject = null;
  fpsWindow = [];
  btnText.textContent = 'Start Camera';
  if (wasRunning) {
    placeholder.style.display = 'flex';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setStatus('');
    setSummary('Camera stopped.', 'info');
    updateHandUi({ Left: null, Right: null });
  }
}

// ---------------- Frame loop ----------------
function scheduleFrame() {
  if (!running) return;
  frameHandle = video.requestVideoFrameCallback
    ? video.requestVideoFrameCallback(onFrame)
    : requestAnimationFrame(onFrame);
}

function onFrame() {
  if (!running) return;
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    processFrame();
  }
  scheduleFrame();
}

function processFrame() {
  // recognizeForVideo needs strictly increasing timestamps.
  const now = performance.now();
  const ts = Math.max(now, lastDetectTs + 1);
  lastDetectTs = ts;

  const result = recognizer.recognizeForVideo(video, ts);
  // Frames are fed un-mirrored; the mirror toggle only affects how they are displayed.
  const hands = handsFromResult(result, { minScore: Number(scoreSlider.value) / 100, inputMirrored: false });

  let changed = false;
  for (const side of SIDES) {
    if (stabilizers[side].update(hands[side]?.gesture)) changed = true;
  }

  draw(hands);
  updateHandUi(hands);
  updateSummary(hands, changed);
  trackFps(now);
}

// ---------------- Results UI ----------------
function updateHandUi(hands) {
  for (const side of SIDES) {
    const ui = handUi[side];
    const hand = hands[side];
    const stable = stabilizers[side].stable;
    const info = GESTURES[stable] || { name: stable, icon: '·' };
    ui.status.textContent = hand ? 'detected' : 'not detected';
    ui.status.dataset.phase = hand ? 'bent' : 'hidden';
    ui.icon.textContent = hand ? info.icon : '·';
    ui.name.textContent = hand ? info.name : '–';
    const pct = hand && hand.gesture !== 'None' ? Math.round(hand.score * 100) : 0;
    ui.score.textContent = hand ? `${Math.round(hand.score * 100)}%` : '–';
    ui.bar.style.width = `${pct}%`;
  }
}

function updateSummary(hands, changed) {
  const text = describeHands(stabilizers.Left.stable, stabilizers.Right.stable);
  if (text) {
    setSummary(text, 'good');
    if (changed && text !== lastLogged) addHistory(text);
  } else if (hands.Left || hands.Right) {
    setSummary('Hands detected, no gesture recognized yet.', 'info');
  } else {
    setSummary('No hands detected. Show your hands to the camera.', 'info');
  }
  if (!text) lastLogged = null;
}

function setSummary(text, kind) {
  if (summary.textContent !== text) summary.textContent = text;
  summary.className = `coach-banner coach-${kind}`;
}

function addHistory(text) {
  lastLogged = text;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  history.unshift({ time, text });
  history = history.slice(0, 50);
  renderHistory();
}

function renderHistory() {
  if (!history.length) {
    log.innerHTML = '<span class="text-muted">No gestures yet.</span>';
    return;
  }
  log.innerHTML = history.map(h => `
    <div class="rep-entry">
      <span class="rep-detail" style="flex: 0 0 auto;">${h.time}</span>
      <span class="rep-title">${escapeHtml(h.text)}</span>
    </div>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

clearLogBtn.addEventListener('click', () => {
  history = [];
  lastLogged = null;
  renderHistory();
});

function setStatus(text, isError = false) {
  statusLine.textContent = text;
  statusLine.classList.toggle('fit-status-error', isError);
}

function showError(err) {
  console.error(err);
  const msg = err?.name === 'NotAllowedError'
    ? 'Camera access was blocked. Allow it in the browser\'s address bar and try again.'
    : err?.name === 'NotFoundError'
      ? 'No camera found.'
      : err?.name === 'NotReadableError'
        ? 'The camera is busy (used by another tab or app).'
        : err?.message || String(err);
  setStatus(msg, true);
}

function trackFps(now) {
  fpsWindow.push(now);
  while (fpsWindow.length && now - fpsWindow[0] > 1000) fpsWindow.shift();
  if (fpsWindow.length > 1 && fpsWindow.length % 5 === 0) {
    setStatus(`Recognizing at ${fpsWindow.length} fps`);
  }
}

// ---------------- Settings ----------------
scoreSlider.addEventListener('input', () => {
  scoreValue.textContent = `${scoreSlider.value}%`;
});
colorMode.addEventListener('change', () => {
  fingerLegend.style.display = colorMode.value === 'finger' ? 'flex' : 'none';
});

// ---------------- Drawing ----------------
function connectionColor(a, b, side) {
  if (colorMode.value === 'hand') return HAND_COLORS[side];
  const fa = fingerOf(a);
  const fb = fingerOf(b);
  if (fa === fb) return FINGER_COLORS[fa];
  if ((a === 0 && b === 1) || (a === 1 && b === 0)) return FINGER_COLORS.thumb;
  return PALM_COLOR;
}

function draw(hands) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const mirror = mirrorToggle.checked;
  const unit = Math.max(1, Math.min(w, h) / 480);

  ctx.save();
  if (mirror) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, w, h);
  ctx.lineCap = 'round';

  for (const side of SIDES) {
    const hand = hands[side];
    if (!hand) continue;
    const lm = hand.landmarks;

    ctx.lineWidth = 3 * unit;
    for (const { start, end } of GestureRecognizer.HAND_CONNECTIONS) {
      ctx.strokeStyle = connectionColor(start, end, side);
      ctx.beginPath();
      ctx.moveTo(lm[start].x * w, lm[start].y * h);
      ctx.lineTo(lm[end].x * w, lm[end].y * h);
      ctx.stroke();
    }

    lm.forEach((p, i) => {
      const r = (FINGERTIPS.has(i) ? 6 : 4) * unit;
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
      ctx.fillStyle = colorMode.value === 'hand' ? HAND_COLORS[side] : FINGER_COLORS[fingerOf(i)];
      ctx.fill();
      ctx.lineWidth = 1.5 * unit;
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.stroke();
    });
  }
  ctx.restore();

  // Gesture labels drawn un-mirrored so the text stays readable, above each hand.
  if (!labelsToggle.checked) return;
  ctx.font = `600 ${Math.round(15 * unit)}px Inter, sans-serif`;
  ctx.textBaseline = 'middle';
  for (const side of SIDES) {
    const hand = hands[side];
    if (!hand) continue;
    const xs = hand.landmarks.map(p => (mirror ? 1 - p.x : p.x) * w);
    const top = Math.min(...hand.landmarks.map(p => p.y)) * h;
    const stable = stabilizers[side].stable;
    const info = GESTURES[stable] || { name: stable, icon: '' };
    const text = `${side}: ${stable === 'None' ? '…' : `${info.icon} ${info.name}`}`;
    const tw = ctx.measureText(text).width;
    const pad = 7 * unit;
    const boxH = 24 * unit;
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const bx = Math.min(Math.max(4, cx - tw / 2 - pad), w - tw - pad * 2 - 4);
    const by = Math.max(4, top - boxH - 10 * unit);
    ctx.fillStyle = HAND_COLORS[side];
    ctx.fillRect(bx, by, tw + pad * 2, boxH);
    ctx.fillStyle = '#0f172a';
    ctx.fillText(text, bx + pad, by + boxH / 2);
  }
}

renderHistory();
