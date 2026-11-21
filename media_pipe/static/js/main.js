document.addEventListener('DOMContentLoaded', () => {
  // ----------------------------------------------------
  // Top Tabs: Image vs Video
  // ----------------------------------------------------
  const tabImageBtn = document.getElementById('tabImageBtn');
  const tabVideoBtn = document.getElementById('tabVideoBtn');
  const imageInputSection = document.getElementById('imageInputSection');
  const videoInputSection = document.getElementById('videoInputSection');
  const imageResultsContent = document.getElementById('imageResultsContent');
  const videoResultsContent = document.getElementById('videoResultsContent');
  const emptyState = document.getElementById('emptyState');
  const loadingState = document.getElementById('loadingState');
  const loadingTitle = document.getElementById('loadingTitle');
  const loadingSubtitle = document.getElementById('loadingSubtitle');
  const resultActions = document.getElementById('resultActions');
  const videoResultActions = document.getElementById('videoResultActions');

  const modes = {
    image: { btn: tabImageBtn, input: imageInputSection, results: imageResultsContent, actions: resultActions },
    video: { btn: tabVideoBtn, input: videoInputSection, results: videoResultsContent, actions: videoResultActions },
    face: {
      btn: document.getElementById('tabFaceBtn'),
      input: document.getElementById('faceInputSection'),
      results: document.getElementById('faceResultsContent'),
      actions: document.getElementById('faceResultActions'),
    },
    fitness: {
      btn: document.getElementById('tabFitnessBtn'),
      input: document.getElementById('fitnessInputSection'),
      results: document.getElementById('fitnessResultsContent'),
      actions: document.getElementById('fitnessResultActions'),
    },
    gesture: {
      btn: document.getElementById('tabGestureBtn'),
      input: document.getElementById('gestureInputSection'),
      results: document.getElementById('gestureResultsContent'),
      actions: document.getElementById('gestureResultActions'),
    },
    background: {
      btn: document.getElementById('tabBackgroundBtn'),
      input: document.getElementById('backgroundInputSection'),
      results: document.getElementById('backgroundResultsContent'),
      actions: document.getElementById('backgroundResultActions'),
    },
    shapes: {
      btn: document.getElementById('tabShapesBtn'),
      input: document.getElementById('shapesInputSection'),
      results: document.getElementById('shapesResultsContent'),
      actions: document.getElementById('shapesResultActions'),
    },
    particles: {
      btn: document.getElementById('tabParticlesBtn'),
      input: document.getElementById('particlesInputSection'),
      results: document.getElementById('particlesResultsContent'),
      actions: document.getElementById('particlesResultActions'),
    },
    tm: {
      btn: document.getElementById('tabTmBtn'),
      input: document.getElementById('tmInputSection'),
      results: document.getElementById('tmResultsContent'),
      actions: document.getElementById('tmResultActions'),
    },
    yolo: {
      btn: document.getElementById('tabYoloBtn'),
      input: document.getElementById('yoloInputSection'),
      results: document.getElementById('yoloResultsContent'),
      actions: document.getElementById('yoloResultActions'),
    },
  };

  function setMode(mode) {
    loadingState.style.display = 'none';
    Object.entries(modes).forEach(([name, m]) => {
      const active = name === mode;
      m.btn.classList.toggle('active', active);
      m.input.style.display = active ? 'block' : 'none';
      const show = active && !!m.results.dataset.hasResults;
      m.results.style.display = show ? 'flex' : 'none';
      m.actions.style.display = show ? 'flex' : 'none';
    });
    emptyState.style.display = modes[mode].results.dataset.hasResults ? 'none' : 'flex';
  }

  Object.entries(modes).forEach(([name, m]) => {
    m.btn.addEventListener('click', () => setMode(name));
  });

  // ----------------------------------------------------
  // Image Detection Logic
  // ----------------------------------------------------
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const dropContent = document.getElementById('dropContent');
  const dropPreview = document.getElementById('dropPreview');
  const previewThumb = document.getElementById('previewThumb');
  const previewName = document.getElementById('previewName');
  const clearSelectionBtn = document.getElementById('clearSelectionBtn');

  const thresholdSlider = document.getElementById('thresholdSlider');
  const thresholdValue = document.getElementById('thresholdValue');
  const maxResultsSelect = document.getElementById('maxResultsSelect');
  const recognizeBtn = document.getElementById('recognizeBtn');
  const btnSpinner = document.getElementById('btnSpinner');
  const btnText = document.getElementById('btnText');

  const metricCount = document.getElementById('metricCount');
  const metricTime = document.getElementById('metricTime');
  const metricRes = document.getElementById('metricRes');

  const annotatedImage = document.getElementById('annotatedImage');
  const originalImage = document.getElementById('originalImage');
  const toggleViewBtn = document.getElementById('toggleViewBtn');
  const downloadAnnotatedBtn = document.getElementById('downloadAnnotatedBtn');
  const detectedItemsList = document.getElementById('detectedItemsList');
  const jsonCode = document.getElementById('jsonCode');

  let currentFile = null;
  let currentSample = null;
  let viewingOriginal = false;
  let originalImageUrl = null;

  thresholdSlider.addEventListener('input', (e) => {
    thresholdValue.textContent = `${e.target.value}%`;
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('dragover');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleFileSelected(files[0]);
    }
  });

  dropZone.addEventListener('click', (e) => {
    if (e.target !== clearSelectionBtn && !dropPreview.contains(e.target)) {
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelected(e.target.files[0]);
    }
  });

  clearSelectionBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    resetSelection();
  });

  function handleFileSelected(file) {
    if (!file.type.startsWith('image/')) {
      alert('Please select a valid image file (JPEG, PNG, WEBP, etc.)');
      return;
    }
    currentFile = file;
    currentSample = null;

    const reader = new FileReader();
    reader.onload = (e) => {
      previewThumb.src = e.target.result;
      previewName.textContent = file.name;
      dropContent.style.display = 'none';
      dropPreview.style.display = 'flex';
      originalImageUrl = e.target.result;

      recognizeBtn.disabled = false;
      btnText.textContent = 'Recognize Objects';
    };
    reader.readAsDataURL(file);
  }

  function resetSelection() {
    currentFile = null;
    currentSample = null;
    fileInput.value = '';
    dropContent.style.display = 'block';
    dropPreview.style.display = 'none';
    recognizeBtn.disabled = true;
    btnText.textContent = 'Select an Image to Recognize';
  }

  document.querySelectorAll('#samplesContainer .sample-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sample = btn.getAttribute('data-sample');
      currentSample = sample;
      currentFile = null;

      previewThumb.src = `static/samples/${sample}`;
      previewName.textContent = `Sample: ${sample}`;
      dropContent.style.display = 'none';
      dropPreview.style.display = 'flex';
      originalImageUrl = `static/samples/${sample}`;

      recognizeBtn.disabled = false;
      btnText.textContent = `Recognize (${sample})`;

      executeRecognition();
    });
  });

  recognizeBtn.addEventListener('click', () => {
    executeRecognition();
  });

  function executeRecognition() {
    if (!currentFile && !currentSample) return;

    recognizeBtn.disabled = true;
    btnSpinner.style.display = 'inline-block';
    btnText.textContent = 'Recognizing...';

    emptyState.style.display = 'none';
    imageResultsContent.style.display = 'none';
    videoResultsContent.style.display = 'none';
    loadingTitle.textContent = 'MediaPipe is analyzing image...';
    loadingSubtitle.textContent = 'Running object detection model locally';
    loadingState.style.display = 'flex';
    resultActions.style.display = 'none';

    const formData = new FormData();
    const threshold = parseFloat(thresholdSlider.value) / 100.0;
    const maxResults = parseInt(maxResultsSelect.value, 10);

    formData.append('threshold', threshold);
    formData.append('max_results', maxResults);

    if (currentFile) {
      formData.append('image', currentFile);
    } else if (currentSample) {
      formData.append('sample', currentSample);
    }

    fetch('/api/recognize', {
      method: 'POST',
      body: formData,
    })
      .then(response => {
        if (!response.ok) {
          return response.json().then(err => { throw new Error(err.error || 'Server error'); });
        }
        return response.json();
      })
      .then(data => {
        renderImageResults(data);
      })
      .catch(error => {
        alert('Recognition failed: ' + error.message);
        emptyState.style.display = 'flex';
      })
      .finally(() => {
        loadingState.style.display = 'none';
        recognizeBtn.disabled = false;
        btnSpinner.style.display = 'none';
        btnText.textContent = 'Recognize Objects';
      });
  }

  function renderImageResults(data) {
    imageResultsContent.dataset.hasResults = 'true';
    imageResultsContent.style.display = 'flex';
    videoResultsContent.style.display = 'none';
    resultActions.style.display = 'flex';
    videoResultActions.style.display = 'none';

    metricCount.textContent = data.total_detected;
    metricTime.textContent = `${data.elapsed_ms} ms`;
    metricRes.innerHTML = `${data.image_width} &times; ${data.image_height}`;

    annotatedImage.src = data.annotated_url;
    annotatedImage.style.display = 'block';
    originalImage.src = originalImageUrl;
    originalImage.style.display = 'none';
    viewingOriginal = false;
    toggleViewBtn.textContent = 'View Original';

    downloadAnnotatedBtn.href = data.annotated_url;

    detectedItemsList.innerHTML = '';
    if (data.objects.length === 0) {
      detectedItemsList.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 16px;">
          No objects matched the confidence threshold (${thresholdSlider.value}%). Try lowering the threshold.
        </div>`;
    } else {
      data.objects.forEach(obj => {
        const itemCard = document.createElement('div');
        itemCard.className = 'object-card';
        itemCard.innerHTML = `
          <div class="object-card-header">
            <div class="object-label-group">
              <span class="color-indicator" style="background-color: ${obj.color};"></span>
              <span class="object-name">${obj.label}</span>
            </div>
            <span class="confidence-val">${obj.confidence}%</span>
          </div>
          <div class="progress-track">
            <div class="progress-bar" style="width: ${obj.confidence}%; background-color: ${obj.color};"></div>
          </div>
          <div class="object-bbox">
            Box: [x: ${obj.box.x}, y: ${obj.box.y}, w: ${obj.box.width}, h: ${obj.box.height}]
          </div>
        `;
        detectedItemsList.appendChild(itemCard);
      });
    }

    jsonCode.textContent = JSON.stringify(data, null, 2);
  }

  toggleViewBtn.addEventListener('click', () => {
    viewingOriginal = !viewingOriginal;
    if (viewingOriginal) {
      annotatedImage.style.display = 'none';
      originalImage.style.display = 'block';
      toggleViewBtn.textContent = 'View Annotated';
    } else {
      annotatedImage.style.display = 'block';
      originalImage.style.display = 'none';
      toggleViewBtn.textContent = 'View Original';
    }
  });

  // ----------------------------------------------------
  // Video & YouTube Detection Logic
  // ----------------------------------------------------
  const subtabYoutube = document.getElementById('subtabYoutube');
  const subtabFileUpload = document.getElementById('subtabFileUpload');
  const youtubeInputArea = document.getElementById('youtubeInputArea');
  const videoFileArea = document.getElementById('videoFileArea');
  const youtubeUrlInput = document.getElementById('youtubeUrlInput');
  const videoThresholdSlider = document.getElementById('videoThresholdSlider');
  const videoThresholdValue = document.getElementById('videoThresholdValue');
  const sampleFpsSelect = document.getElementById('sampleFpsSelect');
  const maxDurationSelect = document.getElementById('maxDurationSelect');
  const processVideoBtn = document.getElementById('processVideoBtn');
  const videoBtnSpinner = document.getElementById('videoBtnSpinner');
  const videoBtnText = document.getElementById('videoBtnText');
  const videoProgressContainer = document.getElementById('videoProgressContainer');
  const videoProgressStatus = document.getElementById('videoProgressStatus');
  const videoProgressPct = document.getElementById('videoProgressPct');
  const videoProgressBar = document.getElementById('videoProgressBar');

  const videoDropZone = document.getElementById('videoDropZone');
  const videoFileInput = document.getElementById('videoFileInput');
  const videoDropContent = document.getElementById('videoDropContent');
  const videoDropPreview = document.getElementById('videoDropPreview');
  const videoPreviewName = document.getElementById('videoPreviewName');
  const clearVideoSelectionBtn = document.getElementById('clearVideoSelectionBtn');

  const resultVideoPlayer = document.getElementById('resultVideoPlayer');
  const videoMetricTitle = document.getElementById('videoMetricTitle');
  const videoMetricFrames = document.getElementById('videoMetricFrames');
  const videoMetricFps = document.getElementById('videoMetricFps');
  const videoUniqueList = document.getElementById('videoUniqueList');
  const timelineList = document.getElementById('timelineList');
  const downloadVideoBtn = document.getElementById('downloadVideoBtn');

  let videoModeType = 'youtube'; // 'youtube' or 'file'
  let currentVideoFile = null;

  subtabYoutube.addEventListener('click', () => {
    videoModeType = 'youtube';
    subtabYoutube.classList.add('active');
    subtabFileUpload.classList.remove('active');
    youtubeInputArea.style.display = 'block';
    videoFileArea.style.display = 'none';
  });

  subtabFileUpload.addEventListener('click', () => {
    videoModeType = 'file';
    subtabFileUpload.classList.add('active');
    subtabYoutube.classList.remove('active');
    youtubeInputArea.style.display = 'none';
    videoFileArea.style.display = 'block';
  });

  videoThresholdSlider.addEventListener('input', (e) => {
    videoThresholdValue.textContent = `${e.target.value}%`;
  });

  // Quick link button
  document.querySelectorAll('.quick-link-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      youtubeUrlInput.value = btn.getAttribute('data-url');
    });
  });

  // Video file drag & drop
  ['dragenter', 'dragover'].forEach(eventName => {
    videoDropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      videoDropZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    videoDropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      videoDropZone.classList.remove('dragover');
    });
  });

  videoDropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleVideoFileSelected(files[0]);
    }
  });

  videoDropZone.addEventListener('click', (e) => {
    if (e.target !== clearVideoSelectionBtn && !videoDropPreview.contains(e.target)) {
      videoFileInput.click();
    }
  });

  videoFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleVideoFileSelected(e.target.files[0]);
    }
  });

  clearVideoSelectionBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    currentVideoFile = null;
    videoFileInput.value = '';
    videoDropContent.style.display = 'block';
    videoDropPreview.style.display = 'none';
  });

  function handleVideoFileSelected(file) {
    currentVideoFile = file;
    videoPreviewName.textContent = file.name;
    videoDropContent.style.display = 'none';
    videoDropPreview.style.display = 'flex';
  }

  // Run Video Recognition submit
  processVideoBtn.addEventListener('click', () => {
    const formData = new FormData();
    const threshold = parseFloat(videoThresholdSlider.value) / 100.0;
    const sampleFps = parseInt(sampleFpsSelect.value, 10);
    const maxDuration = parseInt(maxDurationSelect.value, 10);

    formData.append('threshold', threshold);
    formData.append('sample_fps', sampleFps);
    formData.append('max_duration', maxDuration);

    if (videoModeType === 'youtube') {
      const url = youtubeUrlInput.value.trim();
      if (!url) {
        alert('Please paste a valid YouTube video URL');
        return;
      }
      formData.append('youtube_url', url);
    } else {
      if (!currentVideoFile) {
        alert('Please select or drop a video file');
        return;
      }
      formData.append('video', currentVideoFile);
    }

    // UI state
    processVideoBtn.disabled = true;
    videoBtnSpinner.style.display = 'inline-block';
    videoBtnText.textContent = 'Processing Video...';
    videoProgressContainer.style.display = 'flex';
    videoProgressBar.style.width = '5%';
    videoProgressPct.textContent = '5%';
    videoProgressStatus.textContent = videoModeType === 'youtube' ? 'Fetching YouTube video stream...' : 'Uploading and preparing video...';

    emptyState.style.display = 'none';
    imageResultsContent.style.display = 'none';
    videoResultsContent.style.display = 'none';
    resultActions.style.display = 'none';
    videoResultActions.style.display = 'none';

    fetch('/api/video/start', {
      method: 'POST',
      body: formData,
    })
      .then(res => {
        if (!res.ok) {
          return res.json().then(e => { throw new Error(e.error || 'Server error'); });
        }
        return res.json();
      })
      .then(data => {
        const jobId = data.job_id;
        pollVideoStatus(jobId);
      })
      .catch(err => {
        alert('Error starting video processing: ' + err.message);
        resetVideoProgress();
      });
  });

  function pollVideoStatus(jobId) {
    const interval = setInterval(() => {
      fetch(`/api/video/status/${jobId}`)
        .then(res => res.json())
        .then(data => {
          if (data.status === 'processing' || data.status === 'starting') {
            const pct = data.progress || 10;
            videoProgressBar.style.width = `${pct}%`;
            videoProgressPct.textContent = `${pct}%`;
            videoProgressStatus.textContent = data.message || 'Processing frames...';
          } else if (data.status === 'completed') {
            clearInterval(interval);
            videoProgressBar.style.width = '100%';
            videoProgressPct.textContent = '100%';
            videoProgressStatus.textContent = 'Complete!';
            setTimeout(() => {
              renderVideoResults(data.result);
              resetVideoProgress();
            }, 600);
          } else if (data.status === 'failed') {
            clearInterval(interval);
            alert('Video recognition failed: ' + (data.error || 'Unknown error'));
            resetVideoProgress();
          }
        })
        .catch(err => {
          clearInterval(interval);
          alert('Network error while checking status: ' + err.message);
          resetVideoProgress();
        });
    }, 1500);
  }

  function resetVideoProgress() {
    processVideoBtn.disabled = false;
    videoBtnSpinner.style.display = 'none';
    videoBtnText.textContent = 'Run Video Recognition';
    videoProgressContainer.style.display = 'none';
    videoProgressBar.style.width = '0%';
  }

  function renderVideoResults(res) {
    videoResultsContent.dataset.hasResults = 'true';
    videoResultsContent.style.display = 'flex';
    imageResultsContent.style.display = 'none';
    videoResultActions.style.display = 'flex';
    resultActions.style.display = 'none';

    videoMetricTitle.textContent = res.source_title || 'Video';
    videoMetricFrames.textContent = `${res.frames_processed} (${res.duration_sec}s)`;
    videoMetricFps.textContent = `${res.processing_fps} FPS`;

    resultVideoPlayer.src = res.video_url;
    resultVideoPlayer.load();
    resultVideoPlayer.play().catch(() => {});

    downloadVideoBtn.href = res.video_url;

    // Render unique objects found
    videoUniqueList.innerHTML = '';
    if (!res.unique_objects || res.unique_objects.length === 0) {
      videoUniqueList.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 12px;">
          No objects met the threshold.
        </div>`;
    } else {
      res.unique_objects.forEach(obj => {
        const item = document.createElement('div');
        item.className = 'object-card';
        item.innerHTML = `
          <div class="object-card-header">
            <span class="object-name">${obj.label}</span>
            <span class="confidence-val">${obj.max_confidence}%</span>
          </div>
          <div class="progress-track">
            <div class="progress-bar" style="width: ${obj.max_confidence}%;"></div>
          </div>
          <div class="object-bbox">
            Seen in ${obj.count} frames &bull; First at ${obj.first_seen}
          </div>
        `;
        videoUniqueList.appendChild(item);
      });
    }

    // Render interactive occurrence timeline
    timelineList.innerHTML = '';
    if (!res.timeline || res.timeline.length === 0) {
      timelineList.innerHTML = `<span style="color: var(--text-muted); font-size: 0.8rem;">No events recorded.</span>`;
    } else {
      res.timeline.forEach(event => {
        const pill = document.createElement('button');
        pill.className = 'timeline-pill';
        pill.innerHTML = `
          <span class="timeline-time">${event.time_str}</span>
          <span>${event.objects.slice(0, 3).join(', ')}${event.objects.length > 3 ? '...' : ''}</span>
        `;
        pill.addEventListener('click', () => {
          resultVideoPlayer.currentTime = event.time_sec;
          resultVideoPlayer.play();
        });
        timelineList.appendChild(pill);
      });
    }
  }
});
