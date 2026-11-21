// My Model: object recognition with the Teachable Machine image model (phone / watch / empty / bottle).
// Model files are served locally from /static/tm/ (downloaded from teachablemachine.withgoogle.com/models/zLAhZaFNp/).
(() => {
  const MODEL_URL = 'static/tm/';
  const ICONS = { phone: '📱', watch: '⌚', empty: '∅', bottle: '🍾' };
  const COLORS = ['#00ffd0', '#ff4fa3', '#9fb4ff', '#ffd166', '#9dff3d', '#a66bff'];
  const $ = (id) => document.getElementById(id);

  const section = $('tmInputSection');
  const startBtn = $('tmStartBtn');
  const btnSpinner = $('tmBtnSpinner');
  const btnText = $('tmBtnText');
  const statusLine = $('tmStatus');
  const fileInput = $('tmFile');
  const thresholdSlider = $('tmThreshold');
  const thresholdValue = $('tmThresholdValue');
  const banner = $('tmBanner');
  const bars = $('tmBars');
  const canvas = $('tmCanvas');
  const ctx = canvas.getContext('2d');
  const placeholder = $('tmPlaceholder');
  const video = $('tmVideo');

  let model = null, stream = null, running = false, frameHandle = null, busy = false;
  let fpsT = performance.now(), fpsN = 0, fps = 0;

  thresholdSlider.addEventListener('input', () => { thresholdValue.textContent = `${thresholdSlider.value}%`; });

  async function getModel() {
    if (model) return model;
    statusLine.textContent = 'Loading your Teachable Machine model...';
    model = await tmImage.load(MODEL_URL + 'model.json', MODEL_URL + 'metadata.json');
    buildBars(model.getClassLabels());
    statusLine.textContent = `Model loaded: ${model.getClassLabels().join(', ')}`;
    return model;
  }

  function buildBars(labels) {
    bars.innerHTML = labels.map((l, i) => `
      <div class="tm-row">
        <span class="tm-label">${ICONS[l] || '•'} ${l}</span>
        <div class="tm-bar"><i id="tmBar${i}" style="background:${COLORS[i % COLORS.length]}"></i></div>
        <span class="tm-pct" id="tmPct${i}">0%</span>
      </div>`).join('');
  }

  function showPredictions(preds) {
    preds.forEach((p, i) => {
      const pct = Math.round(p.probability * 100);
      $(`tmBar${i}`).style.width = `${pct}%`;
      $(`tmPct${i}`).textContent = `${pct}%`;
    });
    const best = preds.reduce((a, b) => (b.probability > a.probability ? b : a));
    const pct = Math.round(best.probability * 100);
    if (pct < +thresholdSlider.value) {
      banner.textContent = 'Not sure... show the object more clearly';
      banner.dataset.state = 'unsure';
    } else if (best.className === 'empty') {
      banner.textContent = '∅ Nothing in front of the camera';
      banner.dataset.state = 'empty';
    } else {
      banner.textContent = `${ICONS[best.className] || ''} ${best.className.toUpperCase()} · ${pct}%`;
      banner.dataset.state = 'found';
    }
    return best;
  }

  function drawLabel(best) {
    const pct = Math.round(best.probability * 100);
    const text = `${best.className} ${pct}%${fps ? ` · ${fps} fps` : ''}`;
    ctx.font = `600 ${Math.round(canvas.height / 18)}px Inter, sans-serif`;
    const w = ctx.measureText(text).width + 24, h = canvas.height / 12;
    ctx.fillStyle = 'rgba(5,8,20,0.65)';
    ctx.fillRect(12, 12, w, h);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 24, 12 + h / 2);
  }

  // ---------------- Webcam ----------------
  async function loop() {
    frameHandle = null;
    if (!running) return;
    const W = canvas.width, H = canvas.height;
    ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1); ctx.drawImage(video, 0, 0, W, H); ctx.restore();
    if (!busy) {
      busy = true;
      try {
        // Teachable Machine trains on a mirrored webcam image, so predict on the mirrored canvas.
        const preds = await model.predict(canvas);
        if (running) showPredictions(preds), (loop.best = preds);
      } finally { busy = false; }
      fpsN++;
      const now = performance.now();
      if (now - fpsT > 1000) { fps = Math.round(fpsN * 1000 / (now - fpsT)); fpsT = now; fpsN = 0; }
    }
    if (loop.best) {
      drawLabel(loop.best.reduce((a, b) => (b.probability > a.probability ? b : a)));
    }
    frameHandle = requestAnimationFrame(loop);
  }

  async function start() {
    startBtn.disabled = true;
    btnSpinner.style.display = 'inline-block';
    try {
      await getModel();
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a camera.');
      btnText.textContent = 'Waiting for camera...';
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
      video.srcObject = stream;
      await new Promise((res) => (video.readyState >= 2 ? res() : video.addEventListener('loadeddata', res, { once: true })));
      await video.play();
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      running = true;
      placeholder.style.display = 'none';
      frameHandle = requestAnimationFrame(loop);
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
    loop.best = null;
    btnText.textContent = 'Start Camera';
  }

  // ---------------- Photo upload ----------------
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    stop();
    try {
      await getModel();
      const img = new Image();
      img.src = URL.createObjectURL(file);
      await img.decode();
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      placeholder.style.display = 'none';
      const best = showPredictions(await model.predict(img));
      fps = 0;
      drawLabel(best);
      URL.revokeObjectURL(img.src);
    } catch (err) {
      statusLine.textContent = `Error: ${err.message || err}`;
    }
    fileInput.value = '';
  });

  startBtn.addEventListener('click', () => (running ? stop() : start()));
  $('tmSnapshotBtn').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'my-model-result.png';
    a.click();
  });
  ['tabImageBtn', 'tabVideoBtn', 'tabFaceBtn', 'tabFitnessBtn', 'tabGestureBtn', 'tabBackgroundBtn', 'tabShapesBtn', 'tabParticlesBtn', 'tabYoloBtn'].forEach(id => $(id)?.addEventListener('click', stop));
  document.addEventListener('keydown', (e) => {
    if (section.style.display === 'none' || !running) return;
    if (e.key === 'Escape' || e.key.toLowerCase() === 'q') { e.preventDefault(); stop(); }
  });
})();
