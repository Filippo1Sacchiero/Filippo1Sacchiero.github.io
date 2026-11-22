// Runs the fast-neural-style Torch models (.t7) with OpenCV.js, off the main thread.
// Same math as style_transfer.py: blobFromImage(mean subtraction, BGR) -> forward -> add mean back.
const MEAN = [103.939, 116.779, 123.68];
let ready;
const loaded = {};   // style name -> cv.dnn_Net

function init() {
  return ready ||= new Promise((resolve) => {
    importScripts('opencv.js');
    const done = () => resolve();
    if (cv.Mat) return done();
    cv.onRuntimeInitialized = done;
    const poll = setInterval(() => { if (cv.Mat) { clearInterval(poll); done(); } }, 200);
  });
}

async function getNet(style) {
  if (loaded[style]) return loaded[style];
  postMessage({ type: 'status', text: `Downloading the ${style.replace(/_/g, ' ')} model...` });
  const res = await fetch(`models/${style}.t7`);
  if (!res.ok) throw new Error(`Could not download model (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const file = `${style}.t7`;
  try { cv.FS_unlink('/' + file); } catch (e) {}
  cv.FS_createDataFile('/', file, bytes, true, false, false);
  loaded[style] = cv.readNetFromTorch(file);
  cv.FS_unlink('/' + file);   // the net keeps its own copy; free the file memory
  return loaded[style];
}

onmessage = async ({ data }) => {
  try {
    await init();
    const { id, style, width, height, rgba } = data;
    const net = await getNet(style);
    postMessage({ type: 'status', text: 'Painting... this can take several seconds' });

    const src = new cv.Mat(height, width, cv.CV_8UC4);
    src.data.set(new Uint8Array(rgba));
    const bgr = new cv.Mat();
    cv.cvtColor(src, bgr, cv.COLOR_RGBA2BGR);
    const blob = cv.blobFromImage(bgr, 1.0, new cv.Size(width, height), new cv.Scalar(...MEAN), false, false);
    const t0 = performance.now();
    net.setInput(blob);
    const out = net.forward();
    const ms = Math.round(performance.now() - t0);

    // out is 1x3xHxW float (BGR planes); H/W can differ slightly from the input. Convert to RGBA.
    const [, , outH, outW] = out.matSize;
    const f = out.data32F;
    const plane = outW * outH;
    const pixels = new Uint8ClampedArray(plane * 4);
    for (let i = 0; i < plane; i++) {
      pixels[i * 4] = f[2 * plane + i] + MEAN[2];
      pixels[i * 4 + 1] = f[plane + i] + MEAN[1];
      pixels[i * 4 + 2] = f[i] + MEAN[0];
      pixels[i * 4 + 3] = 255;
    }
    [src, bgr, blob, out].forEach((m) => m.delete());
    postMessage({ type: 'result', id, width: outW, height: outH, inWidth: width, inHeight: height, pixels, ms }, [pixels.buffer]);
  } catch (e) {
    postMessage({ type: 'error', id: data.id, text: (e && e.message) || String(e) });
  }
};
