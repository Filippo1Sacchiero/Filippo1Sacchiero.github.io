// Virtual background: video-conference style selfie view with MediaPipe Image Segmenter, in the browser.
import { ImageSegmenter, FilesetResolver } from '../vendor/mediapipe-tasks-vision-0.10.21/vision_bundle.mjs';
import {
  PHOTOS, COLORS, INITIAL_STATE, actionForKey, applyAction, isShortcutEvent, blurRadius, describeState, maskToAlpha,
} from './background_logic.js';

const WASM_PATH = 'static/vendor/mediapipe-tasks-vision-0.10.21/wasm';
const MODEL_PATH = 'models/selfie_segmenter_landscape.tflite';
const SEG_WIDTH = 480; // segmentation input width; the mask is upscaled smoothly (soft edges, less CPU)

const $ = (id) => document.getElementById(id);

// ---------------- Elements ----------------
const section = $('backgroundInputSection');
const startBtn = $('bgStartBtn');
const btnSpinner = $('bgBtnSpinner');
const btnText = $('bgBtnText');
const statusLine = $('bgStatus');
const mirrorToggle = $('bgMirror');
const smoothToggle = $('bgSmooth');
const canvas = $('bgCanvas');
const ctx = canvas.getContext('2d');
const placeholder = $('bgPlaceholder');
const toast = $('bgToast');
const badge = $('bgBadge');
const video = $('bgVideo');
const snapshotBtn = $('bgSnapshotBtn');

// Offscreen work canvases
const segCanvas = document.createElement('canvas');
const segCtx = segCanvas.getContext('2d', { willReadFrequently: false });
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d');
const personCanvas = document.createElement('canvas');
const personCtx = personCanvas.getContext('2d');
const blurCanvas = document.createElement('canvas');
const blurCtx = blurCanvas.getContext('2d');
const supportsCanvasFilter = 'filter' in ctx;

// ---------------- State ----------------
let state = { ...INITIAL_STATE };
let segmenter = null;
let stream = null;
let running = false;
let frameHandle = null;
let lastDetectTs = 0;
let lastVideoTime = -1;
let maskData = null;
let prevConf = null;
let toastTimer = null;
let fpsWindow = [];

const photoImages = PHOTOS.map(p => {
  const img = new Image();
  img.src = p.url; // preload so switching is instant
  return img;
});

// ---------------- Model ----------------
async function getSegmenter() {
  if (segmenter) return segmenter;
  setStatus('Loading segmentation model...');
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: 'VIDEO',
    outputConfidenceMasks: true, // confidence mask [0] = person probability
    outputCategoryMask: false,
  });
  try {
    segmenter = await ImageSegmenter.createFromOptions(fileset, options('GPU'));
  } catch (err) {
    console.warn('GPU delegate unavailable, using CPU', err);
    segmenter = await ImageSegmenter.createFromOptions(fileset, options('CPU'));
  }
  setStatus('');
  return segmenter;
}

// ---------------- Start / stop ----------------
startBtn.addEventListener('click', () => {
  if (running) stop();
  else start().catch(showError);
});

['tabImageBtn', 'tabVideoBtn', 'tabFaceBtn', 'tabFitnessBtn', 'tabGestureBtn', 'tabShapesBtn', 'tabParticlesBtn', 'tabTmBtn', 'tabYoloBtn'].forEach(id => $(id).addEventListener('click', stop));

async function start() {
  startBtn.disabled = true;
  btnSpinner.style.display = 'inline-block';
  try {
    await getSegmenter();
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
    prevConf = null;
    placeholder.style.display = 'none';
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
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    placeholder.style.display = 'flex';
    setStatus('');
  }
}

// ---------------- Keyboard & clicks ----------------
document.addEventListener('keydown', (e) => {
  if (section.style.display === 'none') return; // only while the Background tab is open
  const info = {
    key: e.key,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
    repeat: e.repeat,
    targetTag: e.target?.tagName,
    targetType: e.target?.type,
    targetEditable: e.target?.isContentEditable,
  };
  if (!isShortcutEvent(info)) return;
  e.preventDefault();
  dispatch(actionForKey(e.key));
});

document.querySelectorAll('#backgroundInputSection .kbd-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    dispatch(btn.dataset.action === 'none' ? { type: 'none' } : actionForKey(btn.dataset.key));
  });
});

function dispatch(action) {
  const result = applyAction(state, action);
  state = result.state;
  if (result.message) showToast(result.message);
  badge.textContent = describeState(state);
  document.querySelectorAll('#backgroundInputSection .kbd-btn').forEach(btn => {
    const k = btn.dataset.key;
    const active =
      (state.mode === 'photo' && PHOTOS[state.photo].key === k) ||
      (state.mode === 'color' && state.color === k) ||
      (state.mode === 'blur' && k === 'b') ||
      (state.mode === 'none' && btn.dataset.action === 'none');
    btn.classList.toggle('active', active);
  });
  if (!running) showToast(`${result.message ?? ''} (start the camera to see it)`.trim());
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 1400);
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
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  for (const c of [canvas, personCanvas]) {
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
  }

  const now = performance.now();
  trackFps(now);

  // Original background: no segmentation needed.
  if (state.mode === 'none') {
    drawVideo(ctx, video, w, h);
    return;
  }

  // Segment a downscaled copy of the frame.
  const sw = Math.min(SEG_WIDTH, w);
  const sh = Math.round((sw * h) / w);
  if (segCanvas.width !== sw || segCanvas.height !== sh) {
    segCanvas.width = sw;
    segCanvas.height = sh;
    prevConf = null;
  }
  segCtx.drawImage(video, 0, 0, sw, sh);

  const ts = Math.max(now, lastDetectTs + 1); // timestamps must strictly increase
  lastDetectTs = ts;
  segmenter.segmentForVideo(segCanvas, ts, (result) => {
    const mask = result.confidenceMasks?.[0];
    if (!mask) return;
    updateMaskCanvas(mask.getAsFloat32Array(), mask.width, mask.height);
  });

  composite(w, h);
}

function updateMaskCanvas(conf, mw, mh) {
  if (maskCanvas.width !== mw || maskCanvas.height !== mh || !maskData) {
    maskCanvas.width = mw;
    maskCanvas.height = mh;
    maskData = maskCtx.createImageData(mw, mh);
    prevConf = null;
  }
  if (smoothToggle.checked) {
    if (!prevConf || prevConf.length !== conf.length) prevConf = Float32Array.from(conf);
  } else {
    prevConf = null;
  }
  maskToAlpha(conf, maskData.data, prevConf);
  maskCtx.putImageData(maskData, 0, 0);
}

// ---------------- Compositing ----------------
function drawVideo(target, src, w, h) {
  target.save();
  if (mirrorToggle.checked) {
    target.translate(w, 0);
    target.scale(-1, 1);
  }
  target.drawImage(src, 0, 0, w, h);
  target.restore();
}

function drawCover(target, img, w, h) {
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  target.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function drawBackground(w, h) {
  if (state.mode === 'photo') {
    const img = photoImages[state.photo];
    if (img.complete && img.naturalWidth) drawCover(ctx, img, w, h);
    else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
  } else if (state.mode === 'color') {
    ctx.fillStyle = COLORS[state.color].value;
    ctx.fillRect(0, 0, w, h);
  } else if (state.mode === 'blur') {
    drawBlurredVideo(blurRadius(state.blurLevel, h), w, h);
  }
}

function drawBlurredVideo(radius, w, h) {
  ctx.save();
  if (mirrorToggle.checked) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  if (supportsCanvasFilter) {
    // Draw slightly oversized so the blur does not pull dark edges in from outside the frame.
    ctx.filter = `blur(${radius}px)`;
    ctx.drawImage(video, -radius * 2, -radius * 2, w + radius * 4, h + radius * 4);
    ctx.filter = 'none';
  } else {
    // Fallback for browsers without canvas filters: downscale then upscale smoothly.
    const f = Math.max(2, radius / 2);
    const bw = Math.max(1, Math.round(w / f));
    const bh = Math.max(1, Math.round(h / f));
    if (blurCanvas.width !== bw) blurCanvas.width = bw;
    if (blurCanvas.height !== bh) blurCanvas.height = bh;
    blurCtx.drawImage(video, 0, 0, bw, bh);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(blurCanvas, 0, 0, w, h);
  }
  ctx.restore();
}

function composite(w, h) {
  drawBackground(w, h);
  if (!maskData) return; // no mask yet: show only the background for the first frame

  // Person layer: the video, kept only where the mask says "person".
  personCtx.save();
  personCtx.clearRect(0, 0, w, h);
  if (mirrorToggle.checked) {
    personCtx.translate(w, 0);
    personCtx.scale(-1, 1);
  }
  personCtx.drawImage(video, 0, 0, w, h);
  personCtx.globalCompositeOperation = 'destination-in';
  personCtx.imageSmoothingEnabled = true;
  personCtx.imageSmoothingQuality = 'high';
  personCtx.drawImage(maskCanvas, 0, 0, w, h);
  personCtx.restore();

  ctx.drawImage(personCanvas, 0, 0);
}

// ---------------- Misc ----------------
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
    setStatus(`Running at ${fpsWindow.length} fps · ${describeState(state)}`);
  }
}

snapshotBtn.addEventListener('click', () => {
  if (!running) return;
  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'virtual_background.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, 'image/png');
});

dispatch({ type: 'none' });
toast.classList.remove('visible');
