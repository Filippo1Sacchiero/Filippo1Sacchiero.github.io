// Static-site replacement for the Flask API: intercepts fetch('/api/...') calls
// and answers them in the browser with MediaPipe Tasks (no server needed).
(function () {
  const BASE = document.baseURI;
  const abs = (p) => new URL(p, BASE).href;
  const VISION = abs('static/vendor/mediapipe-tasks-vision-0.10.21/vision_bundle.mjs');
  const WASM = abs('static/vendor/mediapipe-tasks-vision-0.10.21/wasm');
  const COLORS = ['#2563EB', '#16A34A', '#DC2626', '#D97706', '#9333EA',
                  '#0891B2', '#EA580C', '#4F46E5', '#DB2777', '#059669'];

  let visionP = null;
  const vision = () => (visionP ||= import(VISION).then(async (m) => ({
    m, fileset: await m.FilesetResolver.forVisionTasks(WASM),
  })));

  async function create(Task, options) {
    const { fileset } = await vision();
    try {
      return await Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' } });
    } catch (e) {
      return await Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } });
    }
  }

  const cache = {};
  async function objectDetector(threshold, maxResults) {
    const key = 'od';
    const { m } = await vision();
    if (!cache[key]) {
      cache[key] = await create(m.ObjectDetector, {
        baseOptions: { modelAssetPath: abs('models/efficientdet_lite0.tflite') },
        runningMode: 'IMAGE', scoreThreshold: threshold, maxResults,
      });
    } else {
      await cache[key].setOptions({ runningMode: 'IMAGE', scoreThreshold: threshold, maxResults });
    }
    return cache[key];
  }
  async function faceLandmarker(numFaces, minConf) {
    const { m } = await vision();
    if (!cache.fl) {
      cache.fl = await create(m.FaceLandmarker, {
        baseOptions: { modelAssetPath: abs('models/face_landmarker.task') },
        runningMode: 'IMAGE', numFaces, minFaceDetectionConfidence: minConf, minFacePresenceConfidence: minConf,
      });
    } else {
      await cache.fl.setOptions({ runningMode: 'IMAGE', numFaces, minFaceDetectionConfidence: minConf, minFacePresenceConfidence: minConf });
    }
    return cache.fl;
  }

  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const fail = (msg, status = 400) => json({ error: msg }, status);

  function loadImg(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('Could not read image file'));
      img.src = src;
    });
  }
  function imageSource(form) {
    const file = form.get('image');
    if (file && file.size) return { url: URL.createObjectURL(file), name: file.name };
    const sample = form.get('sample');
    if (sample) return { url: abs('static/samples/' + sample.split('/').pop()), name: sample };
    return null;
  }

  // ---------- object detection helpers ----------
  function toObjects(result) {
    return result.detections.map((d, i) => {
      const c = d.categories[0];
      const b = d.boundingBox;
      return {
        id: i + 1, label: c.categoryName || c.displayName || 'object',
        confidence: Math.round(c.score * 10000) / 100,
        box: { x: Math.round(b.originX), y: Math.round(b.originY), width: Math.round(b.width), height: Math.round(b.height) },
        color: COLORS[i % COLORS.length],
      };
    });
  }
  function drawBoxes(ctx, objects, w, h) {
    const fontSize = Math.max(14, Math.round(Math.min(w, h) * 0.025));
    const thick = Math.max(3, Math.round(Math.min(w, h) * 0.005));
    ctx.font = `600 ${fontSize}px Helvetica, Arial, sans-serif`;
    ctx.textBaseline = 'top';
    for (const o of objects) {
      const { x, y, width, height } = o.box;
      ctx.lineWidth = thick;
      ctx.strokeStyle = o.color;
      ctx.strokeRect(x, y, width, height);
      const text = `${o.label} ${o.confidence}%`;
      const tw = ctx.measureText(text).width + 12;
      const th = fontSize + 8;
      const ty = y - th >= 0 ? y - th : y;
      ctx.fillStyle = o.color;
      ctx.fillRect(x, ty, tw, th);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x + 6, ty + 4);
    }
  }

  async function recognize(form) {
    const t0 = performance.now();
    const src = imageSource(form);
    if (!src) return fail('No image file provided in request');
    const threshold = parseFloat(form.get('threshold') || '0.5');
    const maxResults = parseInt(form.get('max_results') || '10', 10);
    const img = await loadImg(src.url);
    const det = await objectDetector(threshold, maxResults);
    const objects = toObjects(det.detect(img));
    const w = img.naturalWidth, h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    drawBoxes(ctx, objects, w, h);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    return json({
      success: true, filename: src.name, elapsed_ms: Math.round((performance.now() - t0) * 10) / 10,
      image_width: w, image_height: h, total_detected: objects.length, objects,
      annotated_url: URL.createObjectURL(blob), threshold_used: threshold,
    });
  }

  // ---------- face mesh ----------
  async function connections() {
    const F = (await vision()).m.FaceLandmarker;
    const p = (list) => list.map((c) => [c.start, c.end]);
    return json({
      tesselation: p(F.FACE_LANDMARKS_TESSELATION),
      contours: {
        face_oval: p(F.FACE_LANDMARKS_FACE_OVAL), lips: p(F.FACE_LANDMARKS_LIPS),
        left_eye: p(F.FACE_LANDMARKS_LEFT_EYE), right_eye: p(F.FACE_LANDMARKS_RIGHT_EYE),
        left_eyebrow: p(F.FACE_LANDMARKS_LEFT_EYEBROW), right_eyebrow: p(F.FACE_LANDMARKS_RIGHT_EYEBROW),
      },
      irises: { left_iris: p(F.FACE_LANDMARKS_LEFT_IRIS), right_iris: p(F.FACE_LANDMARKS_RIGHT_IRIS) },
    });
  }
  const meshSettings = (form) => ({
    maxFaces: Math.min(10, Math.max(1, parseInt(form.get('max_faces') || '1', 10))),
    minConf: Math.min(0.95, Math.max(0.1, parseFloat(form.get('min_confidence') || '0.5'))),
    refine: String(form.get('refine') || 'true').toLowerCase() === 'true',
  });

  async function facemesh(form) {
    const t0 = performance.now();
    const src = imageSource(form);
    if (!src) return fail('No image file provided in request');
    const s = meshSettings(form);
    const img = await loadImg(src.url);
    const fl = await faceLandmarker(s.maxFaces, s.minConf);
    const res = fl.detect(img);
    const w = img.naturalWidth, h = img.naturalHeight;
    const r5 = (v) => Math.round(v * 1e5) / 1e5;
    const faces = res.faceLandmarks.map((lms, i) => {
      const pts = (s.refine ? lms : lms.slice(0, 468)).map((l) => [r5(l.x), r5(l.y), r5(l.z)]);
      const xs = pts.map((p) => p[0] * w), ys = pts.map((p) => p[1] * h);
      const x1 = Math.max(0, Math.floor(Math.min(...xs))), y1 = Math.max(0, Math.floor(Math.min(...ys)));
      const x2 = Math.min(w, Math.floor(Math.max(...xs))), y2 = Math.min(h, Math.floor(Math.max(...ys)));
      return { id: i + 1, landmark_count: pts.length, landmarks: pts, box: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } };
    });
    return json({
      faces, total_faces: faces.length, image_width: w, image_height: h, refined: s.refine,
      success: true, filename: src.name, image_url: src.url,
      elapsed_ms: Math.round((performance.now() - t0) * 10) / 10,
    });
  }

  // ---------- background "jobs" for video ----------
  const jobs = {};
  function startJob(fn) {
    const id = Math.random().toString(16).slice(2, 10);
    const job = jobs[id] = { status: 'processing', progress: 5, message: 'Preparing video...' };
    const progress = (pct, message) => { job.progress = pct; job.message = message; };
    fn(progress).then(
      (result) => Object.assign(job, { status: 'completed', progress: 100, message: 'Complete', result }),
      (e) => Object.assign(job, { status: 'failed', error: e.message || String(e) }),
    );
    return json({ success: true, job_id: id });
  }

  function loadVideoEl(file) {
    return new Promise((res, rej) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.onloadeddata = () => res(v);
      v.onerror = () => rej(new Error('Could not read this video format in the browser (try MP4/WebM)'));
      v.src = URL.createObjectURL(file);
    });
  }
  const seek = (v, t) => new Promise((r) => { const to = setTimeout(r, 3000); v.onseeked = () => { clearTimeout(to); r(); }; v.currentTime = t; });
  const fmt = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

  function videoFile(form) {
    if (form.get('youtube_url')) {
      throw new Error('YouTube links need the Python server and are not available in the online version. Please upload a video file instead.');
    }
    const f = form.get('video');
    if (!f || !f.size) throw new Error('No video file or YouTube URL provided');
    return f;
  }

  function videoRecognize(form) {
    let file;
    try { file = videoFile(form); } catch (e) { return fail(e.message); }
    const threshold = parseFloat(form.get('threshold') || '0.5');
    const sampleFps = parseInt(form.get('sample_fps') || '5', 10);
    const maxDur = parseInt(form.get('max_duration') || '30', 10);

    return startJob(async (progress) => {
      const t0 = performance.now();
      const v = await loadVideoEl(file);
      const det = await objectDetector(threshold, 10);
      const dur = Math.min(v.duration || maxDur, maxDur);
      const fps = sampleFps > 0 ? sampleFps : 30;
      const scale = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');

      // Analyze sampled frames (seek-based, independent of playback speed).
      const frames = [];
      const unique = {};
      const timeline = [];
      const n = Math.max(1, Math.floor(dur * fps));
      for (let i = 0; i < n; i++) {
        const t = i / fps;
        await seek(v, t);
        ctx.drawImage(v, 0, 0, w, h);
        const objects = toObjects(det.detect(canvas));
        objects.forEach((o) => {
          const u = unique[o.label] ||= { label: o.label, count: 0, max_confidence: o.confidence, first_seen: fmt(t), first_seen_sec: Math.round(t * 100) / 100 };
          u.count += 1;
          u.max_confidence = Math.max(u.max_confidence, Math.round(o.confidence * 10) / 10);
        });
        if (objects.length) timeline.push({ time_sec: Math.round(t * 100) / 100, time_str: fmt(t), objects: objects.map((o) => o.label), count: objects.length });
        frames.push({ t, objects });
        progress(Math.min(80, Math.round(5 + 75 * (i + 1) / n)), `Analyzed frame ${i + 1}/${n}...`);
      }

      // Render an annotated video: replay the sampled frames into a recorded canvas.
      progress(82, 'Rendering annotated video...');
      const stream = canvas.captureStream(fps);
      const mime = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
      let videoUrl = URL.createObjectURL(file);
      if (mime) {
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4e6 });
        const chunks = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        const stopped = new Promise((r) => { rec.onstop = r; });
        rec.start();
        for (let i = 0; i < frames.length; i++) {
          await seek(v, frames[i].t);
          ctx.drawImage(v, 0, 0, w, h);
          drawBoxes(ctx, frames[i].objects, w, h);
          await new Promise((r) => setTimeout(r, 1000 / fps));
          progress(Math.min(99, Math.round(82 + 17 * (i + 1) / frames.length)), `Rendering frame ${i + 1}/${frames.length}...`);
        }
        rec.stop();
        await stopped;
        videoUrl = URL.createObjectURL(new Blob(chunks, { type: mime.split(';')[0] }));
      }
      const secs = (performance.now() - t0) / 1000;
      return {
        success: true, frames_processed: frames.length, total_source_frames: frames.length,
        processing_time_sec: Math.round(secs * 100) / 100,
        processing_fps: Math.round(frames.length / secs * 10) / 10,
        duration_sec: Math.round(dur * 10) / 10,
        unique_objects: Object.values(unique), timeline,
        video_url: videoUrl, source_title: file.name,
      };
    });
  }

  function facemeshVideo(form) {
    let file;
    try { file = videoFile(form); } catch (e) { return fail(e.message); }
    const s = meshSettings(form);
    const sampleFps = parseInt(form.get('sample_fps') || '10', 10);
    const maxDur = Math.min(120, Math.max(1, parseInt(form.get('max_duration') || '30', 10)));

    return startJob(async (progress) => {
      const t0 = performance.now();
      const v = await loadVideoEl(file);
      const fl = await faceLandmarker(s.maxFaces, s.minConf);
      const dur = Math.min(v.duration || maxDur, maxDur);
      const fps = sampleFps > 0 ? sampleFps : 30;
      const n = Math.max(1, Math.floor(dur * fps));
      const frames = [];
      let withFaces = 0, maxSeen = 0, lmCount = 0;
      for (let i = 0; i < n; i++) {
        const t = i / fps;
        await seek(v, t);
        const res = fl.detect(v);
        const faces = res.faceLandmarks.map((lms) => {
          const use = s.refine ? lms : lms.slice(0, 468);
          lmCount = use.length;
          const flat = [];
          for (const l of use) flat.push(Math.round(l.x * 10000), Math.round(l.y * 10000));
          return flat;
        });
        if (faces.length) { withFaces++; maxSeen = Math.max(maxSeen, faces.length); }
        frames.push({ t: Math.round(t * 10000) / 10000, faces });
        progress(Math.min(99, Math.round(15 + 84 * (i + 1) / n)), `Analyzed frame ${i + 1}/${n} (${withFaces} with faces)...`);
      }
      const secs = (performance.now() - t0) / 1000;
      const landmarksUrl = URL.createObjectURL(new Blob([JSON.stringify({ frames })], { type: 'application/json' }));
      return {
        width: v.videoWidth, height: v.videoHeight, fps: 30,
        sample_interval_sec: Math.round(1 / fps * 10000) / 10000,
        duration_sec: Math.round(dur * 100) / 100, frames_analyzed: frames.length,
        frames_with_faces: withFaces, max_faces_seen: maxSeen, landmark_count: lmCount,
        processing_time_sec: Math.round(secs * 100) / 100,
        processing_fps: Math.round(frames.length / secs * 10) / 10, refined: s.refine,
        video_url: URL.createObjectURL(file), landmarks_url: landmarksUrl, source_title: file.name,
      };
    });
  }

  // ---------- fetch router ----------
  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init = {}) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const path = new URL(url, BASE).pathname;
    const m = path.match(/\/api\/(.+)$/);
    if (!m || new URL(url, BASE).origin !== location.origin) return realFetch(input, init);
    const route = m[1];
    const form = init.body instanceof FormData ? init.body : new FormData();
    const handle = async () => {
      if (route === 'health') return json({ status: 'ok' });
      if (route === 'recognize') return recognize(form);
      if (route === 'facemesh/connections') return connections();
      if (route === 'facemesh') return facemesh(form);
      if (route === 'facemesh/video/start') return facemeshVideo(form);
      if (route === 'video/start') return videoRecognize(form);
      if (route.startsWith('video/status/')) {
        const job = jobs[route.split('/').pop()];
        return job ? json(job) : fail('Job not found', 404);
      }
      if (route.startsWith('yolo/')) {
        return fail('YouTube and IP-camera streams need the Python server and are not available in the online version. Use the webcam, an image or a video file.');
      }
      return fail('Not available in the online version', 404);
    };
    return handle().catch((e) => fail(e.message || String(e), 500));
  };
})();
