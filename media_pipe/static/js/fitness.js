// Fitness Coach: live arm-curl rep counting with MediaPipe Pose Landmarker, in the browser.
import { PoseLandmarker, FilesetResolver } from '../vendor/mediapipe-tasks-vision-0.10.21/vision_bundle.mjs';
import { ArmRepCounter, elbowAngle, ARM_LANDMARKS } from './rep_counter.js';

const WASM_PATH = 'static/vendor/mediapipe-tasks-vision-0.10.21/wasm';
const SIDES = ['left', 'right'];
const ARM_COLORS = { left: '#38bdf8', right: '#f97316' };
const PHASE_LABELS = {
  unknown: 'straighten to start',
  straight: 'straight',
  bending: 'curling',
  bent: 'bent',
  extending: 'lowering',
};
const MESSAGE_HOLD_MS = 2500;
const MIN_GAP_DEG = 20; // keep "bent" at least this far below "straight"

const $ = (id) => document.getElementById(id);

// ---------------- Elements ----------------
const subtabCamera = $('fitSubtabCamera');
const subtabVideo = $('fitSubtabVideo');
const cameraArea = $('fitCameraArea');
const videoArea = $('fitVideoArea');
const dropZone = $('fitDropZone');
const fileInput = $('fitFileInput');
const dropContent = $('fitDropContent');
const dropPreview = $('fitDropPreview');
const previewName = $('fitPreviewName');
const clearBtn = $('fitClearBtn');
const startBtn = $('fitStartBtn');
const btnSpinner = $('fitBtnSpinner');
const btnText = $('fitBtnText');
const statusLine = $('fitStatus');
const straightSlider = $('fitStraightSlider');
const straightValue = $('fitStraightValue');
const bentSlider = $('fitBentSlider');
const bentValue = $('fitBentValue');
const modelSelect = $('fitModelSelect');
const mirrorToggle = $('fitMirror');
const skeletonToggle = $('fitSkeleton');
const voiceToggle = $('fitVoice');
const resetBtn = $('fitResetBtn');
const coach = $('fitCoach');
const canvas = $('fitCanvas');
const ctx = canvas.getContext('2d');
const placeholder = $('fitPlaceholder');
const video = $('fitVideo');
const player = $('fitPlayer');
const playBtn = $('fitPlayBtn');
const seek = $('fitSeek');
const timeLabel = $('fitTime');
const log = $('fitLog');
const armUi = Object.fromEntries(SIDES.map(side => {
  const cap = side === 'left' ? 'Left' : 'Right';
  return [side, {
    phase: $(`fit${cap}Phase`),
    count: $(`fit${cap}Count`),
    angle: $(`fit${cap}Angle`),
    rom: $(`fit${cap}Rom`),
  }];
}));

// ---------------- State ----------------
let mode = 'camera';      // 'camera' | 'video'
let source = null;        // null | 'camera' | 'video' while running
let stream = null;
let videoFile = null;
let videoUrl = null;
let landmarker = null;
let landmarkerModel = null;
let loadingModel = null;
let lastDetectTs = 0;
let frameHandle = null;
let fpsWindow = [];
let messageUntil = 0;
let lastRepLog = [];

const counters = Object.fromEntries(SIDES.map(s => [s, new ArmRepCounter(s, thresholds())]));

function thresholds() {
  return { straightAngle: Number(straightSlider.value), bentAngle: Number(bentSlider.value) };
}

// ---------------- Model ----------------
async function getLandmarker() {
  const model = modelSelect.value;
  if (landmarker && landmarkerModel === model) return landmarker;
  if (loadingModel) return loadingModel;

  loadingModel = (async () => {
    setStatus(`Loading pose model (${model})...`);
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: `models/pose_landmarker_${model}.task`, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    let created;
    try {
      created = await PoseLandmarker.createFromOptions(fileset, options('GPU'));
    } catch (err) {
      console.warn('GPU delegate unavailable, using CPU', err);
      created = await PoseLandmarker.createFromOptions(fileset, options('CPU'));
    }
    if (landmarker) landmarker.close();
    landmarker = created;
    landmarkerModel = model;
    lastDetectTs = 0;
    setStatus('');
    return landmarker;
  })();

  try {
    return await loadingModel;
  } finally {
    loadingModel = null;
  }
}

modelSelect.addEventListener('change', () => {
  if (source) getLandmarker().catch(showError);
});

// ---------------- Mode switching & inputs ----------------
function setMode(next) {
  if (next === mode) return;
  stop();
  mode = next;
  subtabCamera.classList.toggle('active', mode === 'camera');
  subtabVideo.classList.toggle('active', mode === 'video');
  cameraArea.style.display = mode === 'camera' ? 'block' : 'none';
  videoArea.style.display = mode === 'video' ? 'block' : 'none';
  mirrorToggle.checked = mode === 'camera';
  updateStartButton();
}
subtabCamera.addEventListener('click', () => setMode('camera'));
subtabVideo.addEventListener('click', () => setMode('video'));

['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
}));
dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) selectVideo(e.dataTransfer.files[0]);
});
dropZone.addEventListener('click', (e) => {
  if (!dropPreview.contains(e.target)) fileInput.click();
});
fileInput.addEventListener('change', (e) => {
  if (e.target.files.length) selectVideo(e.target.files[0]);
});
clearBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  stop();
  videoFile = null;
  fileInput.value = '';
  dropContent.style.display = 'block';
  dropPreview.style.display = 'none';
  updateStartButton();
});

function selectVideo(file) {
  if (!file.type.startsWith('video/')) {
    setStatus('Please choose a video file.', true);
    return;
  }
  stop();
  videoFile = file;
  previewName.textContent = file.name;
  dropContent.style.display = 'none';
  dropPreview.style.display = 'flex';
  setStatus('');
  updateStartButton();
}

function updateStartButton() {
  startBtn.disabled = false;
  if (source) {
    btnText.textContent = source === 'camera' ? 'Stop Camera' : 'Stop Analysis';
  } else if (mode === 'camera') {
    btnText.textContent = 'Start Camera';
  } else {
    btnText.textContent = videoFile ? 'Analyze Video' : 'Select a Video File';
    startBtn.disabled = !videoFile;
  }
}

startBtn.addEventListener('click', () => {
  if (source) stop();
  else start().catch(showError);
});

// Stop the camera when leaving the tab (privacy, CPU).
['tabImageBtn', 'tabVideoBtn', 'tabFaceBtn', 'tabGestureBtn', 'tabBackgroundBtn', 'tabShapesBtn', 'tabParticlesBtn', 'tabTmBtn', 'tabYoloBtn'].forEach(id => $(id).addEventListener('click', stop));

// ---------------- Start / stop ----------------
async function start() {
  startBtn.disabled = true;
  btnSpinner.style.display = 'inline-block';
  try {
    await getLandmarker();
    if (mode === 'camera') {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a camera.');
      btnText.textContent = 'Waiting for camera...';
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      });
      video.srcObject = stream;
      player.style.display = 'none';
    } else {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      videoUrl = URL.createObjectURL(videoFile);
      video.srcObject = null;
      video.src = videoUrl;
      video.loop = false;
      resetCounts();
      player.style.display = 'flex';
    }
    await waitForVideo();
    await video.play();
    source = mode;
    placeholder.style.display = 'none';
    showMessage(mode === 'camera'
      ? 'Arms straight to start. Each straight → bent → straight cycle is one rep.'
      : 'Analyzing video...', 'info', 0);
    scheduleFrame();
  } catch (err) {
    stop();
    throw err;
  } finally {
    btnSpinner.style.display = 'none';
    updateStartButton();
  }
}

function waitForVideo() {
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('Could not play this video in the browser.')); };
    const cleanup = () => {
      video.removeEventListener('loadeddata', ok);
      video.removeEventListener('error', fail);
    };
    video.addEventListener('loadeddata', ok);
    video.addEventListener('error', fail);
  });
}

function stop() {
  const wasRunning = !!source;
  source = null;
  if (frameHandle != null) {
    if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
    cancelAnimationFrame(frameHandle);
    frameHandle = null;
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
    video.srcObject = null;
  }
  video.pause();
  fpsWindow = [];
  if (wasRunning) {
    setStatus('');
    showMessage(totalReps() ? `Stopped. Left ${counters.left.count}, right ${counters.right.count} reps.` : 'Stopped.', 'info', 0);
  }
  updateStartButton();
}

// ---------------- Frame loop ----------------
function scheduleFrame() {
  if (!source) return;
  frameHandle = video.requestVideoFrameCallback
    ? video.requestVideoFrameCallback(onFrame)
    : requestAnimationFrame(onFrame);
}

let lastVideoTime = -1;
function onFrame() {
  if (!source) return;
  if (landmarker && !loadingModel && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    processFrame();
  }
  if (source === 'video') updatePlayer();
  scheduleFrame();
}

function processFrame() {
  // detectForVideo needs strictly increasing timestamps.
  const now = performance.now();
  const ts = Math.max(now, lastDetectTs + 1);
  lastDetectTs = ts;

  const result = landmarker.detectForVideo(video, ts);
  const lm = result.landmarks?.[0];
  const world = result.worldLandmarks?.[0];

  // Rep timing follows the video's own clock for files, wall clock for the camera.
  const repClock = source === 'video' ? video.currentTime * 1000 : now;
  const angles = {};
  for (const side of SIDES) {
    angles[side] = lm ? elbowAngle(lm, world, side) : null;
    const event = counters[side].update(angles[side], repClock);
    if (event) handleEvent(side, event);
  }

  draw(lm, angles);
  updateArmUi(angles);
  updateAmbientMessage(lm, angles);
  trackFps(now);
}

// ---------------- Coaching ----------------
function sideName(side) {
  return side === 'left' ? 'Left arm' : 'Right arm';
}

function handleEvent(side, ev) {
  const t = thresholds();
  if (ev.type === 'rep') {
    const tempo = (ev.durationMs / 1000).toFixed(1);
    showMessage(
      `${sideName(side)}: rep ${ev.count}!${ev.fast ? ' Slow down and control the movement.' : ''}`,
      ev.fast ? 'warn' : 'good',
    );
    addLog(side, ev.count, `${tempo} s · deepest ${ev.minAngle}°`, ev.fast ? 'fast' : null);
    flash(side);
    speak(`${side} ${ev.count}`);
  } else if (ev.type === 'partial_curl') {
    showMessage(`${sideName(side)}: curl higher. You reached ${ev.minAngle}°, a rep needs ${t.bentAngle}° or less. Not counted.`, 'warn');
  } else if (ev.type === 'partial_extension') {
    showMessage(`${sideName(side)}: straighten fully at the bottom. You reached ${ev.maxAngle}°, a rep needs ${t.straightAngle}° or more.`, 'warn');
  } else if (ev.type === 'lost') {
    showMessage(`${sideName(side)} left the frame. Counting for that arm restarts from a straight arm.`, 'info');
  }
}

function showMessage(text, kind = 'info', holdMs = MESSAGE_HOLD_MS) {
  coach.textContent = text;
  coach.className = `coach-banner coach-${kind}`;
  messageUntil = performance.now() + holdMs;
}

function updateAmbientMessage(lm, angles) {
  if (performance.now() < messageUntil) return;
  if (!lm) {
    showMessage('I can\'t see you. Step into the frame.', 'info', 0);
  } else if (angles.left == null && angles.right == null) {
    showMessage('Make sure your shoulders, elbows and wrists are visible.', 'info', 0);
  } else if (SIDES.every(s => counters[s].phase === 'unknown' || angles[s] == null)) {
    showMessage('Straighten your arms to start counting.', 'info', 0);
  } else {
    showMessage(`Keep going! Left ${counters.left.count} · Right ${counters.right.count}`, 'info', 0);
  }
}

function speak(text) {
  if (!voiceToggle.checked || !window.speechSynthesis) return;
  if (speechSynthesis.pending) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.15;
  speechSynthesis.speak(u);
}

// ---------------- UI updates ----------------
function updateArmUi(angles) {
  const t = thresholds();
  for (const side of SIDES) {
    const ui = armUi[side];
    const c = counters[side];
    const a = angles[side] == null ? null : c.angle;
    ui.count.textContent = c.count;
    ui.phase.textContent = angles[side] == null ? 'not visible' : PHASE_LABELS[c.phase];
    ui.phase.dataset.phase = angles[side] == null ? 'hidden' : c.phase;
    ui.angle.textContent = a == null ? '–' : `${Math.round(a)}°`;
    const pct = a == null ? 0 : Math.min(100, Math.max(0, ((t.straightAngle - a) / (t.straightAngle - t.bentAngle)) * 100));
    ui.rom.style.width = `${pct}%`;
    ui.rom.classList.toggle('rom-full', pct >= 100);
  }
}

function flash(side) {
  const card = armUi[side].count.closest('.arm-card');
  card.classList.remove('arm-flash');
  void card.offsetWidth; // restart the animation
  card.classList.add('arm-flash');
}

function addLog(side, count, detail, badge) {
  lastRepLog.unshift({ side, count, detail, badge });
  lastRepLog = lastRepLog.slice(0, 50);
  renderLog();
}

function renderLog() {
  if (!lastRepLog.length) {
    log.innerHTML = '<span class="text-muted">No reps yet.</span>';
    return;
  }
  log.innerHTML = lastRepLog.map(r => `
    <div class="rep-entry">
      <span class="rep-dot" style="background:${ARM_COLORS[r.side]}"></span>
      <span class="rep-title">${sideName(r.side)} #${r.count}</span>
      <span class="rep-detail">${r.detail}</span>
      ${r.badge ? `<span class="rep-badge">${r.badge}</span>` : ''}
    </div>`).join('');
}

function totalReps() {
  return counters.left.count + counters.right.count;
}

function resetCounts() {
  SIDES.forEach(s => counters[s].reset());
  lastRepLog = [];
  renderLog();
  updateArmUi({ left: null, right: null });
}

resetBtn.addEventListener('click', () => {
  resetCounts();
  showMessage('Counts reset.', 'info');
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
      : err?.message || String(err);
  setStatus(msg, true);
}

function trackFps(now) {
  fpsWindow.push(now);
  while (fpsWindow.length && now - fpsWindow[0] > 1000) fpsWindow.shift();
  if (fpsWindow.length > 1 && fpsWindow.length % 5 === 0) {
    setStatus(`Tracking at ${fpsWindow.length} fps · model: ${landmarkerModel}`);
  }
}

// ---------------- Thresholds ----------------
function syncThresholds(changed) {
  let straight = Number(straightSlider.value);
  let bent = Number(bentSlider.value);
  if (straight - bent < MIN_GAP_DEG) {
    if (changed === 'straight') bent = straight - MIN_GAP_DEG;
    else straight = bent + MIN_GAP_DEG;
    straightSlider.value = straight;
    bentSlider.value = bent;
  }
  straightValue.textContent = `${straightSlider.value}°`;
  bentValue.textContent = `${bentSlider.value}°`;
  SIDES.forEach(s => counters[s].setOptions(thresholds()));
}
straightSlider.addEventListener('input', () => syncThresholds('straight'));
bentSlider.addEventListener('input', () => syncThresholds('bent'));
syncThresholds();

// ---------------- Drawing ----------------
function draw(lm, angles) {
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

  if (lm) {
    ctx.lineCap = 'round';
    if (skeletonToggle.checked) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 2 * unit;
      ctx.beginPath();
      for (const { start, end } of PoseLandmarker.POSE_CONNECTIONS) {
        if (start <= 10 || end <= 10) continue; // skip face points
        const a = lm[start];
        const b = lm[end];
        if ((a.visibility ?? 1) < 0.5 || (b.visibility ?? 1) < 0.5) continue;
        ctx.moveTo(a.x * w, a.y * h);
        ctx.lineTo(b.x * w, b.y * h);
      }
      ctx.stroke();
    }

    // Arms, highlighted per side
    for (const side of SIDES) {
      const idx = ARM_LANDMARKS[side];
      const pts = [lm[idx.shoulder], lm[idx.elbow], lm[idx.wrist]];
      const visible = angles[side] != null;
      ctx.strokeStyle = visible ? ARM_COLORS[side] : 'rgba(148, 163, 184, 0.6)';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 5 * unit;
      ctx.beginPath();
      ctx.moveTo(pts[0].x * w, pts[0].y * h);
      ctx.lineTo(pts[1].x * w, pts[1].y * h);
      ctx.lineTo(pts[2].x * w, pts[2].y * h);
      ctx.stroke();
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 5 * unit, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();

  // Angle labels drawn un-mirrored so the text stays readable.
  if (lm) {
    ctx.font = `600 ${Math.round(14 * unit)}px Inter, sans-serif`;
    ctx.textBaseline = 'middle';
    for (const side of SIDES) {
      if (angles[side] == null) continue;
      const e = lm[ARM_LANDMARKS[side].elbow];
      const x = (mirror ? 1 - e.x : e.x) * w;
      const y = e.y * h;
      const text = `${Math.round(counters[side].angle)}°`;
      const tw = ctx.measureText(text).width;
      const pad = 6 * unit;
      const bx = x + 10 * unit;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
      ctx.fillRect(bx, y - 11 * unit, tw + pad * 2, 22 * unit);
      ctx.fillStyle = ARM_COLORS[side];
      ctx.fillText(text, bx + pad, y);
    }
  }
}

// ---------------- Video file player ----------------
function fmt(sec) {
  if (!isFinite(sec)) sec = 0;
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

function updatePlayer() {
  const d = video.duration || 0;
  seek.value = d ? Math.round((video.currentTime / d) * 1000) : 0;
  timeLabel.textContent = `${fmt(video.currentTime)} / ${fmt(d)}`;
  playBtn.textContent = video.paused ? 'Play' : 'Pause';
}

playBtn.addEventListener('click', () => {
  if (source !== 'video') return;
  if (video.paused) {
    if (video.ended) video.currentTime = 0;
    video.play();
  } else {
    video.pause();
  }
  updatePlayer();
});

seek.addEventListener('input', () => {
  if (source !== 'video' || !video.duration) return;
  video.currentTime = (seek.value / 1000) * video.duration;
});

// A jump in the video breaks the movement; don't let it complete a rep.
video.addEventListener('seeking', () => SIDES.forEach(s => counters[s].interrupt()));
video.addEventListener('ended', () => {
  if (source !== 'video') return;
  updatePlayer();
  showMessage(`Video finished. Left ${counters.left.count} · Right ${counters.right.count} reps.`, 'good', 0);
  messageUntil = Infinity;
});
video.addEventListener('play', () => {
  if (messageUntil === Infinity) messageUntil = 0;
});

updateStartButton();
renderLog();
