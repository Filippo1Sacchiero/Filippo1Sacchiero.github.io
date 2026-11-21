document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  // Shared result-panel elements
  const emptyState = $('emptyState');
  const loadingState = $('loadingState');
  const loadingTitle = $('loadingTitle');
  const loadingSubtitle = $('loadingSubtitle');
  const resultsContent = $('faceResultsContent');
  const resultActions = $('faceResultActions');

  // Sub-mode (image / video) input areas
  const subtabImage = $('faceSubtabImage');
  const subtabVideo = $('faceSubtabVideo');
  const imageArea = $('faceImageArea');
  const videoArea = $('faceVideoArea');
  const samplesSection = $('faceSamplesSection');

  // Image input
  const dropZone = $('faceDropZone');
  const fileInput = $('faceFileInput');
  const dropContent = $('faceDropContent');
  const dropPreview = $('faceDropPreview');
  const previewThumb = $('facePreviewThumb');
  const previewName = $('facePreviewName');
  const clearBtn = $('faceClearBtn');

  // Video input
  const videoDropZone = $('faceVideoDropZone');
  const videoFileInput = $('faceVideoFileInput');
  const videoDropContent = $('faceVideoDropContent');
  const videoDropPreview = $('faceVideoDropPreview');
  const videoPreviewName = $('faceVideoPreviewName');
  const videoClearBtn = $('faceVideoClearBtn');
  const sampleFpsSelect = $('faceSampleFpsSelect');
  const maxDurationSelect = $('faceMaxDurationSelect');
  const progressContainer = $('faceProgressContainer');
  const progressStatus = $('faceProgressStatus');
  const progressPct = $('faceProgressPct');
  const progressBar = $('faceProgressBar');

  // Shared detection settings
  const confidenceSlider = $('faceConfidenceSlider');
  const confidenceValue = $('faceConfidenceValue');
  const maxFacesSelect = $('maxFacesSelect');
  const refineSelect = $('refineSelect');
  const runBtn = $('faceRunBtn');
  const btnSpinner = $('faceBtnSpinner');
  const btnText = $('faceBtnText');

  // Style controls
  const style = {
    background: $('faceBackgroundSelect'),
    mesh: $('layerMesh'), meshColor: $('colorMesh'),
    contours: $('layerContours'), contourColor: $('colorContours'),
    irises: $('layerIrises'), irisColor: $('colorIrises'),
    points: $('layerPoints'), pointColor: $('colorPoints'),
    boxes: $('layerBoxes'), boxColor: $('colorBoxes'),
    contourMode: $('contourModeSelect'),
    lineWidth: $('lineWidthSlider'),
    meshOpacity: $('meshOpacitySlider'),
    pointSize: $('pointSizeSlider'),
    interpolate: $('interpolateToggle'),
  };
  const lineWidthValue = $('lineWidthValue');
  const meshOpacityValue = $('meshOpacityValue');
  const pointSizeValue = $('pointSizeValue');

  // Output
  const canvas = $('faceCanvas');
  const ctx = canvas.getContext('2d');
  const video = $('faceVideo');
  const player = $('facePlayer');
  const playBtn = $('facePlayBtn');
  const seek = $('faceSeek');
  const timeLabel = $('faceTime');
  const metricCountLabel = $('faceMetricCountLabel');
  const metricCount = $('faceMetricCount');
  const metricLandmarks = $('faceMetricLandmarks');
  const metricTimeLabel = $('faceMetricTimeLabel');
  const metricTime = $('faceMetricTime');
  const faceList = $('faceList');
  const jsonCode = $('faceJsonCode');
  const downloadBtn = $('downloadFaceBtn');
  const exportBtn = $('exportFaceVideoBtn');

  const FEATURE_COLORS = {
    face_oval: '#a78bfa',
    lips: '#f43f5e',
    left_eye: '#38bdf8',
    right_eye: '#38bdf8',
    left_eyebrow: '#facc15',
    right_eyebrow: '#facc15',
  };

  let subMode = 'image';
  let currentFile = null;
  let currentSample = null;
  let currentVideoFile = null;
  let busy = false;
  let recording = false;

  // What is on screen. Faces are Float32Arrays of normalized [x0, y0, x1, y1, ...].
  // { kind: 'image', meta, img, faces } or { kind: 'video', meta, frames: [{ t, faces }] }
  let current = null;

  const connectionsReady = fetch('/api/facemesh/connections').then(r => r.json());
  let connections = null;
  connectionsReady.then(c => { connections = c; });

  // ---------------- Sub-mode switching ----------------
  function setSubMode(mode) {
    subMode = mode;
    subtabImage.classList.toggle('active', mode === 'image');
    subtabVideo.classList.toggle('active', mode === 'video');
    imageArea.style.display = mode === 'image' ? 'block' : 'none';
    samplesSection.style.display = mode === 'image' ? 'block' : 'none';
    videoArea.style.display = mode === 'video' ? 'block' : 'none';
    updateRunButton();
  }
  subtabImage.addEventListener('click', () => setSubMode('image'));
  subtabVideo.addEventListener('click', () => setSubMode('video'));

  function updateRunButton() {
    if (busy) return;
    if (subMode === 'image') {
      runBtn.disabled = !(currentFile || currentSample);
      btnText.textContent = runBtn.disabled ? 'Select a Face Image' : 'Run Face Mesh';
    } else {
      runBtn.disabled = !currentVideoFile;
      btnText.textContent = runBtn.disabled ? 'Select a Video File' : 'Run Face Mesh on Video';
    }
  }

  // Pause playback when leaving the Face Mesh tab.
  ['tabImageBtn', 'tabVideoBtn', 'tabFitnessBtn', 'tabGestureBtn', 'tabBackgroundBtn', 'tabShapesBtn', 'tabParticlesBtn', 'tabTmBtn', 'tabYoloBtn'].forEach(id => $(id).addEventListener('click', () => {
    if (!recording) video.pause();
  }));

  // ---------------- Input handling ----------------
  confidenceSlider.addEventListener('input', (e) => {
    confidenceValue.textContent = `${e.target.value}%`;
  });

  function wireDropZone(zone, input, preview, onFile) {
    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
    }));
    zone.addEventListener('drop', (e) => {
      if (e.dataTransfer.files.length) onFile(e.dataTransfer.files[0]);
    });
    zone.addEventListener('click', (e) => {
      if (!preview.contains(e.target)) input.click();
    });
    input.addEventListener('change', (e) => {
      if (e.target.files.length) onFile(e.target.files[0]);
    });
  }

  wireDropZone(dropZone, fileInput, dropPreview, selectImageFile);
  wireDropZone(videoDropZone, videoFileInput, videoDropPreview, selectVideoFile);

  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    currentFile = null;
    currentSample = null;
    fileInput.value = '';
    dropContent.style.display = 'block';
    dropPreview.style.display = 'none';
    updateRunButton();
  });

  videoClearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    currentVideoFile = null;
    videoFileInput.value = '';
    videoDropContent.style.display = 'block';
    videoDropPreview.style.display = 'none';
    updateRunButton();
  });

  function showImagePreview(src, name) {
    previewThumb.src = src;
    previewName.textContent = name;
    dropContent.style.display = 'none';
    dropPreview.style.display = 'flex';
    updateRunButton();
  }

  function selectImageFile(file) {
    if (!file.type.startsWith('image/')) {
      alert('Please select a valid image file (JPEG, PNG, WEBP, etc.)');
      return;
    }
    currentFile = file;
    currentSample = null;
    const reader = new FileReader();
    reader.onload = (e) => showImagePreview(e.target.result, file.name);
    reader.readAsDataURL(file);
  }

  function selectVideoFile(file) {
    const ok = file.type.startsWith('video/') || /\.(mp4|mov|avi|webm|mkv|m4v)$/i.test(file.name);
    if (!ok) {
      alert('Please select a video file (MP4, MOV, WEBM, AVI, MKV)');
      return;
    }
    currentVideoFile = file;
    videoPreviewName.textContent = file.name;
    videoDropContent.style.display = 'none';
    videoDropPreview.style.display = 'flex';
    updateRunButton();
  }

  document.querySelectorAll('.face-sample-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (busy) return;
      currentSample = btn.dataset.sample;
      currentFile = null;
      showImagePreview(`static/samples/${currentSample}`, `Sample: ${currentSample}`);
      runImage();
    });
  });

  runBtn.addEventListener('click', () => (subMode === 'image' ? runImage() : runVideo()));

  // ---------------- Shared run-state helpers ----------------
  function startBusy(label) {
    busy = true;
    video.pause();
    runBtn.disabled = true;
    btnSpinner.style.display = 'inline-block';
    btnText.textContent = label;
    emptyState.style.display = 'none';
    resultsContent.style.display = 'none';
    resultActions.style.display = 'none';
  }

  function endBusy() {
    busy = false;
    btnSpinner.style.display = 'none';
    loadingState.style.display = 'none';
    progressContainer.style.display = 'none';
    updateRunButton();
  }

  function restorePreviousResults() {
    if (resultsContent.dataset.hasResults) {
      resultsContent.style.display = 'flex';
      resultActions.style.display = 'flex';
    } else {
      emptyState.style.display = 'flex';
    }
  }

  function checkedJson(res) {
    return res.json().then(body => {
      if (!res.ok) throw new Error(body.error || 'Server error');
      return body;
    });
  }

  function settingsForm() {
    const form = new FormData();
    form.append('min_confidence', parseFloat(confidenceSlider.value) / 100);
    form.append('max_faces', maxFacesSelect.value);
    form.append('refine', refineSelect.value);
    return form;
  }

  // ---------------- Image detection ----------------
  function runImage() {
    if (busy || (!currentFile && !currentSample)) return;
    startBusy('Detecting landmarks...');
    loadingTitle.textContent = 'MediaPipe Face Mesh is running...';
    loadingSubtitle.textContent = 'Estimating 3D facial landmarks locally';
    loadingState.style.display = 'flex';

    const form = settingsForm();
    if (currentFile) form.append('image', currentFile);
    else form.append('sample', currentSample);

    fetch('/api/facemesh', { method: 'POST', body: form })
      .then(checkedJson)
      .then(data => Promise.all([data, loadImage(data.image_url), connectionsReady]))
      .then(([data, img]) => {
        current = {
          kind: 'image',
          meta: data,
          img,
          faces: data.faces.map(f => Float32Array.from(f.landmarks.flatMap(p => [p[0], p[1]]))),
        };
        showResults();
      })
      .catch(err => {
        alert('Face mesh failed: ' + err.message);
        restorePreviousResults();
      })
      .finally(endBusy);
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load image'));
      img.src = url;
    });
  }

  // ---------------- Video detection ----------------
  function runVideo() {
    if (busy || !currentVideoFile) return;
    startBusy('Processing video...');
    loadingTitle.textContent = 'Running Face Mesh on video...';
    loadingSubtitle.textContent = 'Uploading and analyzing frames locally';
    loadingState.style.display = 'flex';
    setProgress(5, 'Uploading video...');
    progressContainer.style.display = 'flex';

    const form = settingsForm();
    form.append('sample_fps', sampleFpsSelect.value);
    form.append('max_duration', maxDurationSelect.value);
    form.append('video', currentVideoFile);

    fetch('/api/facemesh/video/start', { method: 'POST', body: form })
      .then(checkedJson)
      .then(({ job_id }) => pollJob(job_id))
      .then(result => {
        setProgress(100, 'Loading landmarks and video...');
        return Promise.all([
          result,
          fetch(result.landmarks_url).then(checkedJson),
          loadVideo(result.video_url),
          connectionsReady,
        ]);
      })
      .then(([meta, landmarks]) => {
        current = {
          kind: 'video',
          meta,
          frames: landmarks.frames.map(fr => ({
            t: fr.t,
            faces: fr.faces.map(arr => Float32Array.from(arr, v => v / 10000)),
          })),
        };
        showResults();
      })
      .catch(err => {
        alert('Face mesh video failed: ' + err.message);
        restorePreviousResults();
      })
      .finally(endBusy);
  }

  function setProgress(pct, message) {
    progressBar.style.width = `${pct}%`;
    progressPct.textContent = `${pct}%`;
    progressStatus.textContent = message;
  }

  function pollJob(jobId) {
    return new Promise((resolve, reject) => {
      const tick = () => {
        fetch(`/api/video/status/${jobId}`)
          .then(checkedJson)
          .then(job => {
            if (job.status === 'completed') return resolve(job.result);
            if (job.status === 'failed') return reject(new Error(job.error || 'Unknown error'));
            setProgress(job.progress || 15, job.message || 'Analyzing frames...');
            setTimeout(tick, 1000);
          })
          .catch(reject);
      };
      tick();
    });
  }

  function loadVideo(url) {
    return new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('Could not load processed video')); };
      const cleanup = () => {
        video.removeEventListener('loadeddata', done);
        video.removeEventListener('error', fail);
      };
      video.addEventListener('loadeddata', done);
      video.addEventListener('error', fail);
      video.src = url;
      video.load();
    });
  }

  // ---------------- Results panel ----------------
  function showResults() {
    resultsContent.dataset.hasResults = 'true';
    resultsContent.style.display = 'flex';
    resultActions.style.display = 'flex';
    faceList.innerHTML = '';

    const isVideo = current.kind === 'video';
    player.style.display = isVideo ? 'flex' : 'none';
    exportBtn.style.display = isVideo && window.MediaRecorder ? 'inline-flex' : 'none';
    downloadBtn.textContent = isVideo ? 'Snapshot PNG' : 'Download PNG';

    if (isVideo) showVideoSummary();
    else showImageSummary();

    if (isVideo) {
      video.currentTime = 0;
      updatePlayerUi();
    }
    draw();
  }

  function emptyNote(text) {
    faceList.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 16px;">${text}</div>`;
  }

  function showImageSummary() {
    const data = current.meta;
    metricCountLabel.textContent = 'Faces Found';
    metricCount.textContent = data.total_faces;
    metricLandmarks.textContent = data.faces.length ? data.faces[0].landmark_count : '–';
    metricTimeLabel.textContent = 'Processing Time';
    metricTime.textContent = `${data.elapsed_ms} ms`;

    if (!data.faces.length) {
      emptyNote('No face found. Try a clearer, front-facing photo or lower the detection confidence.');
    }
    data.faces.forEach(face => {
      const zs = face.landmarks.map(p => p[2]);
      const card = document.createElement('div');
      card.className = 'object-card';
      card.innerHTML = `
        <div class="object-card-header">
          <span class="object-name">Face #${face.id}</span>
          <span class="confidence-val">${face.landmark_count} pts</span>
        </div>
        <div class="object-bbox">
          Box: [x: ${face.box.x}, y: ${face.box.y}, w: ${face.box.width}, h: ${face.box.height}]
        </div>
        <div class="object-bbox">
          Depth (z) range: ${Math.min(...zs).toFixed(3)} … ${Math.max(...zs).toFixed(3)}
        </div>`;
      faceList.appendChild(card);
    });

    // Landmarks are long; show a compact preview in the JSON panel.
    const preview = {
      ...data,
      faces: data.faces.map(f => ({ ...f, landmarks: [...f.landmarks.slice(0, 5), `… ${f.landmarks.length - 5} more`] })),
    };
    jsonCode.textContent = JSON.stringify(preview, null, 2);
  }

  function showVideoSummary() {
    const m = current.meta;
    metricCountLabel.textContent = 'Frames with Faces';
    metricCount.textContent = `${m.frames_with_faces} / ${m.frames_analyzed}`;
    metricLandmarks.textContent = m.landmark_count || '–';
    metricTimeLabel.textContent = 'Analysis Speed';
    metricTime.textContent = `${m.processing_fps} fps`;

    if (!m.frames_with_faces) {
      emptyNote('No face found in any analyzed frame. Try a clip with a clearer, front-facing face or lower the detection confidence.');
    }
    const card = document.createElement('div');
    card.className = 'object-card';
    card.innerHTML = `
      <div class="object-card-header">
        <span class="object-name">${escapeHtml(m.source_title || 'Video')}</span>
        <span class="confidence-val">${m.duration_sec}s</span>
      </div>
      <div class="object-bbox">Resolution: ${m.width} × ${m.height} @ ${m.fps} fps</div>
      <div class="object-bbox">Analyzed every ${(m.sample_interval_sec * 1000).toFixed(0)} ms • up to ${m.max_faces_seen} face(s) at once</div>
      <div class="object-bbox">Processing time: ${m.processing_time_sec}s</div>`;
    faceList.appendChild(card);

    jsonCode.textContent = JSON.stringify(m, null, 2);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- Video playback ----------------
  function fmt(sec) {
    if (!isFinite(sec)) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function updatePlayerUi() {
    const d = video.duration || current?.meta?.duration_sec || 0;
    seek.value = d ? Math.round((video.currentTime / d) * 1000) : 0;
    timeLabel.textContent = `${fmt(video.currentTime)} / ${fmt(d)}`;
    playBtn.textContent = video.paused ? 'Play' : 'Pause';
  }

  playBtn.addEventListener('click', () => {
    if (recording) return;
    if (video.paused) {
      if (video.ended) video.currentTime = 0;
      video.play();
    } else {
      video.pause();
    }
  });

  seek.addEventListener('input', () => {
    if (recording || !video.duration) return;
    video.currentTime = (seek.value / 1000) * video.duration;
  });

  function loop() {
    if (video.paused || video.ended) return;
    draw();
    updatePlayerUi();
    requestAnimationFrame(loop);
  }
  video.addEventListener('play', () => { updatePlayerUi(); requestAnimationFrame(loop); });
  ['pause', 'ended', 'seeked'].forEach(ev => video.addEventListener(ev, () => {
    if (current?.kind === 'video') { draw(); updatePlayerUi(); }
  }));

  // Faces at a given time: the last analyzed frame at or before t, optionally
  // blended toward the next one so motion stays smooth at low sampling rates.
  function facesAt(t) {
    const frames = current.frames;
    let lo = 0;
    let hi = frames.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t <= t + 1e-3) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (idx < 0) return [];
    const a = frames[idx];
    const b = frames[idx + 1];
    if (t - a.t > current.meta.sample_interval_sec * 2) return [];
    if (!style.interpolate.checked || !b || b.faces.length !== a.faces.length || !a.faces.length) {
      return a.faces;
    }
    const k = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    return a.faces.map((fa, i) => {
      const fb = b.faces[i];
      if (fb.length !== fa.length) return fa;
      const out = new Float32Array(fa.length);
      for (let j = 0; j < fa.length; j++) out[j] = fa[j] + (fb[j] - fa[j]) * k;
      return out;
    });
  }

  // ---------------- Drawing ----------------
  function strokeConnections(xy, pairs, w, h) {
    const n = xy.length / 2;
    ctx.beginPath();
    for (const [a, b] of pairs) {
      if (a >= n || b >= n) continue;
      ctx.moveTo(xy[a * 2] * w, xy[a * 2 + 1] * h);
      ctx.lineTo(xy[b * 2] * w, xy[b * 2 + 1] * h);
    }
    ctx.stroke();
  }

  function draw() {
    if (!current || !connections) return;
    const isVideo = current.kind === 'video';
    const w = isVideo ? current.meta.width : current.meta.image_width;
    const h = isVideo ? current.meta.height : current.meta.image_height;
    const source = isVideo ? video : current.img;
    const faces = isVideo ? facesAt(video.currentTime) : current.faces;

    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    // Scale strokes so they look the same regardless of resolution.
    const unit = Math.max(1, Math.min(w, h) / 600);
    const lineWidth = parseFloat(style.lineWidth.value) * unit;
    const pointRadius = parseFloat(style.pointSize.value) * unit;

    const bg = style.background.value;
    if (bg === 'black' || (isVideo && video.readyState < 2)) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.drawImage(source, 0, 0, w, h);
      if (bg === 'dim') {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.fillRect(0, 0, w, h);
      }
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const xy of faces) {
      const n = xy.length / 2;

      if (style.mesh.checked) {
        ctx.globalAlpha = parseInt(style.meshOpacity.value, 10) / 100;
        ctx.strokeStyle = style.meshColor.value;
        ctx.lineWidth = lineWidth;
        strokeConnections(xy, connections.tesselation, w, h);
        ctx.globalAlpha = 1;
      }

      if (style.contours.checked) {
        ctx.lineWidth = lineWidth * 2;
        for (const [feature, pairs] of Object.entries(connections.contours)) {
          ctx.strokeStyle = style.contourMode.value === 'feature'
            ? FEATURE_COLORS[feature]
            : style.contourColor.value;
          strokeConnections(xy, pairs, w, h);
        }
      }

      if (style.irises.checked && n > 468) {
        ctx.lineWidth = lineWidth * 2;
        ctx.strokeStyle = style.irisColor.value;
        for (const pairs of Object.values(connections.irises)) strokeConnections(xy, pairs, w, h);
      }

      if (style.points.checked) {
        ctx.fillStyle = style.pointColor.value;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = xy[i * 2] * w;
          const y = xy[i * 2 + 1] * h;
          ctx.moveTo(x + pointRadius, y);
          ctx.arc(x, y, pointRadius, 0, Math.PI * 2);
        }
        ctx.fill();
      }

      if (style.boxes.checked) {
        let x1 = 1, y1 = 1, x2 = 0, y2 = 0;
        for (let i = 0; i < n; i++) {
          x1 = Math.min(x1, xy[i * 2]); x2 = Math.max(x2, xy[i * 2]);
          y1 = Math.min(y1, xy[i * 2 + 1]); y2 = Math.max(y2, xy[i * 2 + 1]);
        }
        ctx.strokeStyle = style.boxColor.value;
        ctx.lineWidth = lineWidth * 2.5;
        ctx.strokeRect(x1 * w, y1 * h, (x2 - x1) * w, (y2 - y1) * h);
      }
    }
  }

  function syncStyleLabels() {
    lineWidthValue.textContent = parseFloat(style.lineWidth.value).toFixed(2).replace(/0$/, '');
    meshOpacityValue.textContent = `${style.meshOpacity.value}%`;
    pointSizeValue.textContent = parseFloat(style.pointSize.value).toFixed(1);
  }

  Object.values(style).forEach(el => {
    el.addEventListener('input', () => { syncStyleLabels(); draw(); });
    el.addEventListener('change', draw);
  });
  syncStyleLabels();

  // ---------------- Downloads ----------------
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  downloadBtn.addEventListener('click', () => {
    canvas.toBlob(blob => saveBlob(blob, 'face_mesh.png'), 'image/png');
  });

  // Records exactly what the canvas shows (current style) by playing the clip once.
  exportBtn.addEventListener('click', () => {
    if (recording || current?.kind !== 'video') return;
    const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
      .find(t => MediaRecorder.isTypeSupported(t));
    if (!mime) {
      alert('Video export is not supported in this browser.');
      return;
    }
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const stream = canvas.captureStream(Math.min(60, Math.round(current.meta.fps) || 30));
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      recording = false;
      exportBtn.disabled = false;
      exportBtn.textContent = 'Export Video';
      saveBlob(new Blob(chunks, { type: mime.split(';')[0] }), `face_mesh.${ext}`);
    };

    recording = true;
    exportBtn.disabled = true;
    exportBtn.textContent = 'Recording…';
    video.pause();
    video.currentTime = 0;
    video.addEventListener('seeked', () => {
      draw();
      recorder.start();
      video.play();
      video.addEventListener('ended', () => recorder.stop(), { once: true });
    }, { once: true });
  });
});
