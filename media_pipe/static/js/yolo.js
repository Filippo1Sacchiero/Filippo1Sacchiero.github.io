// YOLO Studio: Ultralytics YOLO26n (exported to end-to-end ONNX) running in the browser with ONNX Runtime Web.
// Sources: webcam, live CCTV (MJPEG/JPEG), YouTube (downloaded by Flask), local video or image.
// Features: class presets, confidence, IoU tracking with IDs + trails, line-crossing counter, live stats, snapshot.
(() => {
  const MODEL_URL = 'models/yolo26n.onnx';
  const SIZE = 640;
  const $ = (id) => document.getElementById(id);

  const PRESETS = {
    all: null,
    people: ['person'],
    vehicles: ['bicycle', 'car', 'motorcycle', 'bus', 'truck', 'train'],
    traffic: ['person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck', 'traffic light', 'stop sign'],
    sports: ['person', 'sports ball', 'tennis racket', 'baseball bat', 'baseball glove', 'frisbee', 'skateboard', 'skis', 'snowboard', 'surfboard', 'kite'],
    animals: ['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'],
  };

  // ---------------- Elements ----------------
  const section = $('yoloInputSection');
  const sourceSel = $('yoloSource');
  const panels = { webcam: $('yoloWebcamPanel'), cctv: $('yoloCctvPanel'), youtube: $('yoloYoutubePanel'), file: $('yoloFilePanel') };
  const cctvUrl = $('yoloCctvUrl');
  const ytUrl = $('yoloYtUrl');
  const fileInput = $('yoloFile');
  const startBtn = $('yoloStartBtn');
  const btnSpinner = $('yoloBtnSpinner');
  const btnText = $('yoloBtnText');
  const statusLine = $('yoloStatus');
  const confSlider = $('yoloConf');
  const confValue = $('yoloConfValue');
  const presetSel = $('yoloPreset');
  const trackToggle = $('yoloTrack');
  const labelsToggle = $('yoloLabels');
  const lineBtn = $('yoloLineBtn');
  const clearLineBtn = $('yoloClearLineBtn');
  const canvas = $('yoloCanvas');
  const ctx = canvas.getContext('2d');
  const placeholder = $('yoloPlaceholder');
  const video = $('yoloVideo');
  const playerRow = $('yoloPlayer');
  const playBtn = $('yoloPlayBtn');
  const seek = $('yoloSeek');
  const ui = { fps: $('yoloFps'), ms: $('yoloMs'), backend: $('yoloBackend'), now: $('yoloNow'), counts: $('yoloCounts'), lineIn: $('yoloLineIn'), lineOut: $('yoloLineOut'), summary: $('yoloSummary') };

  const prep = document.createElement('canvas');
  prep.width = prep.height = SIZE;
  const pctx = prep.getContext('2d', { willReadFrequently: true });

  // ---------------- State ----------------
  let session = null, labels = [], backend = '-';
  let running = false, mode = null, frameHandle = null, inferBusy = false;
  let stream = null, mjpeg = null, still = null; // sources
  let detections = [], tracks = [], nextId = 1, uniqueSeen = {};
  let line = null, linePending = null, lineCounts = { in: 0, out: 0 };
  let renderN = 0, renderT = performance.now(), lastMs = 0;

  confSlider.addEventListener('input', () => { confValue.textContent = `${confSlider.value}%`; });
  sourceSel.addEventListener('change', () => {
    Object.entries(panels).forEach(([k, el]) => { el.style.display = k === sourceSel.value ? '' : 'none'; });
    btnText.textContent = sourceSel.value === 'file' ? 'Choose a file above' : 'Start';
    startBtn.disabled = sourceSel.value === 'file';
  });
  sourceSel.dispatchEvent(new Event('change'));

  // ---------------- Model ----------------
  async function getSession() {
    if (session) return session;
    setStatus('Loading YOLO26n (9.5 MB)...');
    ort.env.wasm.wasmPaths = 'static/vendor/ort/';
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    labels = await (await fetch('static/js/yolo26n_labels.json')).json();
    const tries = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
    for (const ep of tries) {
      try {
        session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: [ep], graphOptimizationLevel: 'all' });
        backend = ep === 'webgpu' ? 'WebGPU (GPU)' : 'WASM (CPU)';
        break;
      } catch (err) { console.warn(`ONNX Runtime: ${ep} failed`, err); }
    }
    if (!session) throw new Error('Could not start ONNX Runtime in this browser.');
    ui.backend.textContent = backend;
    setStatus('');
    return session;
  }

  // ---------------- Inference ----------------
  function sourceSize() {
    if (mode === 'video') return [video.videoWidth, video.videoHeight];
    const img = mode === 'cctv' ? mjpeg?.frame : still;
    return img ? [img.width, img.height] : [0, 0];
  }
  function sourceDrawable() { return mode === 'video' ? video : mode === 'cctv' ? mjpeg?.frame : still; }

  async function infer() {
    const src = sourceDrawable();
    const [w, h] = sourceSize();
    if (!src || !w) return;
    // letterbox to 640x640, gray padding (as Ultralytics does)
    const r = Math.min(SIZE / w, SIZE / h), nw = Math.round(w * r), nh = Math.round(h * r);
    const px = (SIZE - nw) / 2, py = (SIZE - nh) / 2;
    pctx.fillStyle = 'rgb(114,114,114)';
    pctx.fillRect(0, 0, SIZE, SIZE);
    pctx.drawImage(src, px, py, nw, nh);
    const { data } = pctx.getImageData(0, 0, SIZE, SIZE);
    const area = SIZE * SIZE, input = new Float32Array(3 * area);
    for (let i = 0, j = 0; i < area; i++, j += 4) {
      input[i] = data[j] / 255; input[i + area] = data[j + 1] / 255; input[i + 2 * area] = data[j + 2] / 255;
    }
    const t0 = performance.now();
    const out = await session.run({ images: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
    lastMs = performance.now() - t0;
    const o = out.output0.data; // [1, 300, 6] = x1, y1, x2, y2, score, class (NMS-free end-to-end head)
    const minConf = +confSlider.value / 100;
    const allow = PRESETS[presetSel.value];
    const dets = [];
    for (let k = 0; k < o.length; k += 6) {
      const score = o[k + 4];
      if (score < minConf) continue;
      const cls = Math.round(o[k + 5]), name = labels[cls] ?? `class ${cls}`;
      if (allow && !allow.includes(name)) continue;
      const x1 = Math.max(0, (o[k] - px) / r), y1 = Math.max(0, (o[k + 1] - py) / r);
      const x2 = Math.min(w, (o[k + 2] - px) / r), y2 = Math.min(h, (o[k + 3] - py) / r);
      dets.push({ box: [x1, y1, x2, y2], score, cls, name });
    }
    detections = dets;
    if (trackToggle.checked) updateTracks(dets);
    updateStats();
  }

  async function inferLoop() {
    if (!running || inferBusy) return;
    inferBusy = true;
    try { await infer(); } catch (err) { console.error(err); setStatus(`Inference error: ${err.message || err}`); }
    inferBusy = false;
    if (running && mode !== 'image') setTimeout(inferLoop, 0);
  }

  // ---------------- Tracking (greedy IoU, per class) ----------------
  const iou = (a, b) => {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const inter = ix * iy, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    return u > 0 ? inter / u : 0;
  };
  const centerOf = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

  function updateTracks(dets) {
    const pairs = [];
    tracks.forEach((t, ti) => dets.forEach((d, di) => {
      if (t.cls !== d.cls) return;
      const v = iou(t.box, d.box);
      if (v > 0.2) pairs.push([v, ti, di]);
    }));
    pairs.sort((a, b) => b[0] - a[0]);
    const usedT = new Set(), usedD = new Set();
    for (const [, ti, di] of pairs) {
      if (usedT.has(ti) || usedD.has(di)) continue;
      usedT.add(ti); usedD.add(di);
      const t = tracks[ti], d = dets[di];
      const prev = centerOf(t.box);
      t.box = d.box; t.score = d.score; t.misses = 0; t.hits++;
      d.id = t.id;
      const c = centerOf(d.box);
      t.trail.push(c);
      if (t.trail.length > 40) t.trail.shift();
      if (t.hits === 3) uniqueSeen[t.name] = (uniqueSeen[t.name] || 0) + 1;
      if (line) checkCrossing(prev, c);
    }
    tracks.forEach((t, ti) => { if (!usedT.has(ti)) t.misses++; });
    tracks = tracks.filter(t => t.misses < 8);
    dets.forEach((d, di) => {
      if (usedD.has(di)) return;
      const t = { id: nextId++, cls: d.cls, name: d.name, box: d.box, score: d.score, misses: 0, hits: 1, trail: [centerOf(d.box)] };
      d.id = t.id;
      tracks.push(t);
    });
  }

  // ---------------- Line counter ----------------
  const side = (p) => Math.sign((line.b[0] - line.a[0]) * (p[1] - line.a[1]) - (line.b[1] - line.a[1]) * (p[0] - line.a[0]));
  function segmentsCross(p, q) {
    const s1 = side(p), s2 = side(q);
    if (s1 === 0 || s2 === 0 || s1 === s2) return 0;
    // also require the movement to cross within the line's extent
    const d = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    if (d(p, q, line.a) === d(p, q, line.b)) return 0;
    return s1 < 0 ? 1 : -1;
  }
  function checkCrossing(prev, cur) {
    const dir = segmentsCross(prev, cur);
    if (dir > 0) lineCounts.in++;
    if (dir < 0) lineCounts.out++;
    ui.lineIn.textContent = lineCounts.in;
    ui.lineOut.textContent = lineCounts.out;
  }
  lineBtn.addEventListener('click', () => {
    linePending = [];
    setStatus('Click two points on the image to draw the counting line.');
    trackToggle.checked = true;
  });
  clearLineBtn.addEventListener('click', () => {
    line = null; linePending = null; lineCounts = { in: 0, out: 0 };
    ui.lineIn.textContent = ui.lineOut.textContent = '0';
    redrawStill();
  });
  canvas.addEventListener('click', (e) => {
    if (!linePending) return;
    const rect = canvas.getBoundingClientRect();
    linePending.push([(e.clientX - rect.left) * canvas.width / rect.width, (e.clientY - rect.top) * canvas.height / rect.height]);
    if (linePending.length === 2) {
      line = { a: linePending[0], b: linePending[1] };
      linePending = null;
      lineCounts = { in: 0, out: 0 };
      ui.lineIn.textContent = ui.lineOut.textContent = '0';
      setStatus('Counting line set. Tracked objects crossing it are counted.');
      redrawStill();
    }
  });

  // ---------------- Drawing ----------------
  const colorOf = (cls) => `hsl(${(cls * 47) % 360} 90% 55%)`;

  function drawOverlay() {
    const W = canvas.width, H = canvas.height, lw = Math.max(2, W / 400), font = Math.max(12, Math.round(W / 70));
    ctx.font = `600 ${font}px Inter, sans-serif`;
    ctx.textBaseline = 'top';
    if (trackToggle.checked) {
      for (const t of tracks) {
        if (t.misses || t.trail.length < 2) continue;
        ctx.strokeStyle = colorOf(t.cls); ctx.lineWidth = lw; ctx.globalAlpha = 0.7;
        ctx.beginPath(); t.trail.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    for (const d of detections) {
      const [x1, y1, x2, y2] = d.box, col = colorOf(d.cls);
      ctx.strokeStyle = col; ctx.lineWidth = lw;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      if (!labelsToggle.checked) continue;
      const text = `${d.id && trackToggle.checked ? `#${d.id} ` : ''}${d.name} ${Math.round(d.score * 100)}%`;
      const tw = ctx.measureText(text).width + 8;
      const ty = y1 - font - 6 < 0 ? y1 : y1 - font - 6;
      ctx.fillStyle = col; ctx.fillRect(x1, ty, tw, font + 6);
      ctx.fillStyle = '#000'; ctx.fillText(text, x1 + 4, ty + 3);
    }
    if (line) {
      ctx.strokeStyle = '#ffd166'; ctx.lineWidth = lw * 2; ctx.setLineDash([12, 8]);
      ctx.beginPath(); ctx.moveTo(...line.a); ctx.lineTo(...line.b); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#ffd166';
      ctx.fillText(`IN ${lineCounts.in} · OUT ${lineCounts.out}`, line.b[0] + 8, line.b[1] + 4);
    }
    if (linePending?.length === 1) {
      ctx.fillStyle = '#ffd166'; ctx.beginPath(); ctx.arc(...linePending[0], lw * 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  function render() {
    frameHandle = null;
    if (!running) return;
    const src = sourceDrawable();
    const [w, h] = sourceSize();
    if (src && w) {
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.drawImage(src, 0, 0, w, h);
      drawOverlay();
      if (mode === 'video' && video.duration && !seek.matches(':active')) seek.value = (video.currentTime / video.duration) * 1000;
    }
    renderN++;
    const now = performance.now();
    if (now - renderT > 1000) { ui.fps.textContent = Math.round(renderN * 1000 / (now - renderT)); renderN = 0; renderT = now; }
    frameHandle = requestAnimationFrame(render);
  }

  function redrawStill() {
    if (mode !== 'image' || !still) return;
    ctx.drawImage(still, 0, 0);
    drawOverlay();
  }

  function updateStats() {
    const counts = {};
    detections.forEach(d => { counts[d.name] = (counts[d.name] || 0) + 1; });
    ui.ms.textContent = `${Math.round(lastMs)} ms`;
    ui.now.textContent = detections.length;
    const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const seenRows = Object.entries(uniqueSeen).sort((a, b) => b[1] - a[1]);
    ui.counts.innerHTML = rows.length
      ? rows.map(([n, c]) => {
          const cls = labels.indexOf(n);
          return `<div class="yolo-count"><i style="background:${colorOf(cls)}"></i>${n}<b>${c}</b>${trackToggle.checked && uniqueSeen[n] ? `<span>${uniqueSeen[n]} seen</span>` : ''}</div>`;
        }).join('')
      : '<div class="text-muted">Nothing detected</div>';
    ui.summary.textContent = rows.length
      ? rows.map(([n, c]) => `${c} ${n}`).join(' · ') + (trackToggle.checked && seenRows.length ? `  —  total seen: ${seenRows.map(([n, c]) => `${c} ${n}`).join(', ')}` : '')
      : 'No objects detected (check the class filter and confidence).';
  }

  // ---------------- MJPEG / JPEG reader (works in every browser, canvas stays untainted) ----------------
  function openMjpeg(url) {
    const state = { frame: null, abort: new AbortController(), frames: 0, error: null };
    const viaProxy = (u) => `/api/yolo/mjpeg?url=${encodeURIComponent(u)}`;

    async function read(target) {
      const res = await fetch(target, { signal: state.abort.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`Camera returned HTTP ${res.status}`);
      const type = res.headers.get('Content-Type') || '';
      if (type.startsWith('image/')) { // single snapshot camera: poll it
        await showJpeg(new Uint8Array(await res.arrayBuffer()));
        while (!state.abort.signal.aborted) {
          await new Promise(r => setTimeout(r, 500));
          const r2 = await fetch(target, { signal: state.abort.signal, cache: 'no-store' });
          await showJpeg(new Uint8Array(await r2.arrayBuffer()));
        }
        return;
      }
      const reader = res.body.getReader();
      let buf = new Uint8Array(0), decoding = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf); merged.set(value, buf.length); buf = merged;
        // extract complete JPEGs: FF D8 ... FF D9
        for (;;) {
          let s = -1, e = -1;
          for (let i = 0; i < buf.length - 1; i++) if (buf[i] === 0xff && buf[i + 1] === 0xd8) { s = i; break; }
          if (s < 0) { buf = buf.slice(Math.max(0, buf.length - 1)); break; }
          for (let i = s + 2; i < buf.length - 1; i++) if (buf[i] === 0xff && buf[i + 1] === 0xd9) { e = i + 2; break; }
          if (e < 0) { buf = buf.slice(s); break; }
          const jpg = buf.slice(s, e);
          buf = buf.slice(e);
          if (!decoding) { decoding = true; showJpeg(jpg).finally(() => { decoding = false; }); } // drop frames if behind
        }
        if (buf.length > 8e6) buf = new Uint8Array(0); // safety
      }
    }
    async function showJpeg(bytes) {
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const old = state.frame;
      state.frame = bmp;
      state.frames++;
      if (old && old !== bmp) setTimeout(() => old.close(), 200); // keep it alive while an inference may use it
    }
    state.ready = (async () => {
      try { await read(url); }
      catch (err) {
        if (state.abort.signal.aborted) return;
        console.warn('Direct camera read failed, using the server relay', err);
        await read(viaProxy(url));
      }
    })().catch(err => { if (!state.abort.signal.aborted) { state.error = err; setStatus(`Camera error: ${err.message || err}`); } });
    state.close = () => { state.abort.abort(); state.frame?.close?.(); };
    return state;
  }

  // ---------------- Start / stop ----------------
  function resetRun() {
    detections = []; tracks = []; nextId = 1; uniqueSeen = {};
    lineCounts = { in: 0, out: 0 };
    ui.lineIn.textContent = ui.lineOut.textContent = '0';
  }

  async function begin(newMode) {
    mode = newMode;
    running = true;
    placeholder.style.display = 'none';
    playerRow.style.display = mode === 'video' && sourceSel.value !== 'webcam' ? 'flex' : 'none';
    btnText.textContent = 'Stop';
    startBtn.disabled = false;
    frameHandle = requestAnimationFrame(render);
    inferLoop();
  }

  async function start() {
    stop();
    resetRun();
    startBtn.disabled = true;
    btnSpinner.style.display = 'inline-block';
    try {
      await getSession();
      const src = sourceSel.value;
      if (src === 'webcam') {
        btnText.textContent = 'Waiting for camera...';
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        video.srcObject = stream;
        await playVideo();
        await begin('video');
      } else if (src === 'cctv') {
        const url = cctvUrl.value.trim();
        if (!/^https?:\/\//.test(url)) throw new Error('Enter a camera URL starting with http(s)://');
        btnText.textContent = 'Connecting to camera...';
        mjpeg = openMjpeg(url);
        const t0 = performance.now();
        while (!mjpeg.frame && !mjpeg.error && performance.now() - t0 < 20000) await new Promise(r => setTimeout(r, 100));
        if (!mjpeg.frame) throw mjpeg.error || new Error('No image received from the camera within 20 s.');
        setStatus('Live CCTV connected.');
        await begin('cctv');
      } else if (src === 'youtube') {
        const url = ytUrl.value.trim();
        if (!url) throw new Error('Paste a YouTube URL first.');
        btnText.textContent = 'Downloading video...';
        setStatus('The server is downloading the video (can take a minute for long videos)...');
        const res = await fetch('/api/yolo/youtube', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
        const info = await res.json();
        if (!res.ok) throw new Error(info.error || 'Download failed');
        video.src = info.url;
        video.loop = true;
        await playVideo();
        setStatus(`▶ ${info.title}`);
        await begin('video');
      }
    } catch (err) {
      stop();
      setStatus(`Error: ${err.message || err}`);
    } finally {
      btnSpinner.style.display = 'none';
      startBtn.disabled = sourceSel.value === 'file';
      if (!running) btnText.textContent = sourceSel.value === 'file' ? 'Choose a file above' : 'Start';
    }
  }

  async function playVideo() {
    await new Promise((res, rej) => {
      if (video.readyState >= 2) return res();
      video.addEventListener('loadeddata', res, { once: true });
      video.addEventListener('error', () => rej(new Error('The video could not be loaded.')), { once: true });
    });
    await video.play();
    playBtn.textContent = '⏸';
  }

  function stop() {
    running = false;
    if (frameHandle != null) cancelAnimationFrame(frameHandle);
    frameHandle = null;
    stream?.getTracks().forEach(t => t.stop()); stream = null;
    mjpeg?.close(); mjpeg = null;
    video.pause(); video.removeAttribute('src'); video.srcObject = null; video.load();
    playerRow.style.display = 'none';
    if (mode !== 'image') placeholder.style.display = '';
    btnText.textContent = sourceSel.value === 'file' ? 'Choose a file above' : 'Start';
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    stop();
    resetRun();
    try {
      await getSession();
      const url = URL.createObjectURL(file);
      if (file.type.startsWith('image/')) {
        const img = new Image(); img.src = url; await img.decode();
        still = img; mode = 'image';
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        placeholder.style.display = 'none';
        running = true;
        await infer();
        running = false;
        redrawStill();
        setStatus(`Image: ${file.name}`);
      } else {
        video.src = url; video.loop = true;
        await playVideo();
        setStatus(`▶ ${file.name}`);
        await begin('video');
      }
    } catch (err) { setStatus(`Error: ${err.message || err}`); }
    fileInput.value = '';
  });

  // ---------------- Controls ----------------
  startBtn.addEventListener('click', () => (running ? stop() : start()));
  playBtn.addEventListener('click', () => {
    if (video.paused) { video.play(); playBtn.textContent = '⏸'; } else { video.pause(); playBtn.textContent = '▶'; }
  });
  seek.addEventListener('input', () => { if (video.duration) video.currentTime = (seek.value / 1000) * video.duration; tracks = []; });
  [presetSel, confSlider, labelsToggle, trackToggle].forEach(el => el.addEventListener('change', () => { if (mode === 'image' && still) { running = true; infer().then(() => { running = false; redrawStill(); }); } }));
  document.querySelectorAll('[data-yolo-cctv]').forEach(b => b.addEventListener('click', () => { cctvUrl.value = b.dataset.yoloCctv; }));
  document.querySelectorAll('[data-yolo-preset]').forEach(b => b.addEventListener('click', () => { presetSel.value = b.dataset.yoloPreset; }));
  $('yoloSnapshotBtn').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `yolo26n-${Date.now()}.png`;
    a.click();
  });
  $('yoloResetBtn').addEventListener('click', () => { resetRun(); updateStats(); });
  ['tabImageBtn', 'tabVideoBtn', 'tabFaceBtn', 'tabFitnessBtn', 'tabGestureBtn', 'tabBackgroundBtn', 'tabShapesBtn', 'tabParticlesBtn', 'tabTmBtn']
    .forEach(id => $(id)?.addEventListener('click', stop));
  document.addEventListener('keydown', (e) => {
    if (section.style.display === 'none' || !running || e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'Escape' || e.key.toLowerCase() === 'q') { e.preventDefault(); stop(); }
    if (e.key === ' ' && mode === 'video' && sourceSel.value !== 'webcam') { e.preventDefault(); playBtn.click(); }
  });

  function setStatus(t) { statusLine.textContent = t; }
})();
