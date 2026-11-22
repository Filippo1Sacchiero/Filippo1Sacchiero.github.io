// CCTV Traffic Intelligence core: vehicle tracker, line counter, speed estimate, heatmap, CSV log.
// Pure logic (no DOM), so it can be tested in Node. Works with low-FPS CCTV (≈1 fps) by predicting
// each vehicle's motion instead of relying on overlapping boxes between frames.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TrafficCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const VEHICLES = ['car', 'motorcycle', 'bus', 'truck', 'bicycle'];

  const group = (n) => (n === 'motorcycle' || n === 'bicycle' ? 'two' : 'four');
  const center = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const diag = (b) => Math.hypot(b[2] - b[0], b[3] - b[1]);
  function iou(a, b) {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const inter = ix * iy, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    return u > 0 ? inter / u : 0;
  }

  class TrafficCounter {
    constructor(opts = {}) {
      this.lineY = opts.lineY ?? 0.55;        // counting line, fraction of frame height
      this.mPerPx = opts.mPerPx ?? 0.06;      // perspective scale (meters per pixel)
      this.speedLimit = opts.speedLimit ?? 60; // km/h
      this.maxAge = opts.maxAge ?? 2.5;       // seconds a track survives without detections
      this.heatW = opts.heatW ?? 80;
      this.heatH = opts.heatH ?? 45;
      this.heatTau = opts.heatTau ?? 90;      // seconds for the heatmap to fade
      this.reset();
    }

    reset() {
      this.tracks = [];
      this.nextId = 1;
      this.inflow = 0;   // crossed the line moving down
      this.outflow = 0;  // crossed the line moving up
      this.byClass = {};
      this.events = [];
      this.heat = new Float32Array(this.heatW * this.heatH);
      this.heatMax = 0;
      this.lastT = null;
      this.startT = null;
    }

    get total() { return this.inflow + this.outflow; }

    // dets: [{box:[x1,y1,x2,y2], name, score}] in source pixels; t: seconds; W,H: frame size
    update(dets, t, W, H) {
      if (this.startT == null) this.startT = t;
      if (this.lastT != null && t < this.lastT) this.tracks = []; // video looped or jumped back: restart tracking, keep counts
      const vehicles = dets.filter((d) => VEHICLES.includes(d.name));
      this._match(vehicles, t);
      this._speeds(t);
      this._count(t, H);
      this._heat(t, W, H);
      this.lastT = t;
      return this.tracks;
    }

    _match(dets, t) {
      const pairs = [];
      this.tracks.forEach((tr, ti) => {
        const dt = Math.max(0, t - tr.t);
        const pred = [tr.c[0] + tr.v[0] * dt, tr.c[1] + tr.v[1] * dt];
        dets.forEach((d, di) => {
          const c = center(d.box);
          // A car never becomes a scooter (car/bus/truck may be confused with each other).
          if (group(tr.name) !== group(d.name)) return;
          // Search radius in "vehicle sizes": far-away (small) vehicles move fewer pixels than near ones.
          // Two-wheelers are short, so they cover more of their own lengths per second.
          const size = (diag(tr.box) + diag(d.box)) / 2;
          const perSec = (group(d.name) === 'two' ? 2 : 1) * (tr.hits === 1 ? 2.5 : 0.8);
          const gate = Math.max(40, size * (tr.hits === 1 ? 1.0 : 0.8)) + perSec * size * Math.min(dt, 1.2);
          const dist = Math.hypot(c[0] - pred[0], c[1] - pred[1]);
          const ov = iou(tr.box, d.box);
          if (dist > gate && ov < 0.1) return;
          // ...and its size must change consistently with the motion: moving down the image (towards the
          // camera) it grows, moving up it shrinks. This blocks jumps from a near vehicle to a far one.
          const ratio = diag(d.box) / diag(tr.box);
          if (dist > size * 1.5) {
            const towards = c[1] > tr.c[1];
            if (towards ? (ratio < 0.8 || ratio > 4.5) : (ratio > 1.25 || ratio < 0.55)) return;
          } else if (ratio < 0.45 || ratio > 2.2) return;
          pairs.push([dist / gate - ov, ti, di]);
        });
      });
      pairs.sort((a, b) => a[0] - b[0]);
      const usedT = new Set(), usedD = new Set();
      for (const [, ti, di] of pairs) {
        if (usedT.has(ti) || usedD.has(di)) continue;
        usedT.add(ti); usedD.add(di);
        const tr = this.tracks[ti], d = dets[di];
        const c = center(d.box), dt = t - tr.t;
        if (dt > 0) {
          const v = [(c[0] - tr.c[0]) / dt, (c[1] - tr.c[1]) / dt];
          const a = tr.hits > 1 ? 0.5 : 1;   // smooth velocity after the first update
          tr.v = [tr.v[0] * (1 - a) + v[0] * a, tr.v[1] * (1 - a) + v[1] * a];
        }
        tr.prev = tr.c; tr.c = c; tr.box = d.box; tr.t = t; tr.hits++; tr.seen = true;
        if (d.score >= tr.score) { tr.name = d.name; tr.score = d.score; }
        tr.trail.push([c[0], c[1], t]);
        if (tr.trail.length > 30) tr.trail.shift();
        d.id = tr.id;
      }
      this.tracks.forEach((tr, ti) => { if (!usedT.has(ti)) { tr.seen = false; tr.prev = null; } });
      this.tracks = this.tracks.filter((tr) => t - tr.t <= this.maxAge);
      dets.forEach((d, di) => {
        if (usedD.has(di)) return;
        const c = center(d.box);
        const tr = { id: this.nextId++, name: d.name, score: d.score, box: d.box, c, prev: null, v: [0, 0], t, hits: 1,
                     seen: true, trail: [[c[0], c[1], t]], speed: null, counted: false };
        d.id = tr.id;
        this.tracks.push(tr);
      });
    }

    _count(t, H) {
      const L = this.lineY * H, m = Math.max(8, H * 0.025); // margin: ignore boxes wobbling on the line
      for (const tr of this.tracks) {
        if (!tr.seen || !tr.prev || tr.counted) continue;
        const [, y0] = tr.prev, [, y1] = tr.c;
        const origin = tr.trail[0][1];        // where the track started
        let dir = null;
        if (y0 < L && y1 >= L && origin < L - m && y1 - origin > 2 * m) dir = 'in';
        else if (y0 > L && y1 <= L && origin > L + m && origin - y1 > 2 * m) dir = 'out';
        if (!dir) continue;
        tr.counted = true;
        if (dir === 'in') this.inflow++; else this.outflow++;
        this.byClass[tr.name] = (this.byClass[tr.name] || 0) + 1;
        this.events.push({ t, id: tr.id, name: tr.name, dir, speed: tr.speed });
      }
    }

    _speeds(t) {
      for (const tr of this.tracks) {
        if (!tr.seen) continue;
        // displacement over the last ~3 s of the trail
        const recent = tr.trail.filter((p) => t - p[2] <= 3);
        if (recent.length < 2) continue;
        const a = recent[0], b = recent[recent.length - 1], dt = b[2] - a[2];
        if (dt < 0.25) continue;
        const kmh = Math.hypot(b[0] - a[0], b[1] - a[1]) / dt * this.mPerPx * 3.6;
        tr.speed = tr.speed == null ? kmh : tr.speed * 0.5 + kmh * 0.5;
      }
    }

    // Vehicles that are visible now and actually moving
    active() { return this.tracks.filter((tr) => tr.seen && tr.hits >= 2 && tr.speed != null && tr.speed > 2); }
    avgSpeed() {
      const a = this.active();
      return a.length ? a.reduce((s, tr) => s + tr.speed, 0) / a.length : null;
    }
    isSpeeding(tr) { return tr.speed != null && tr.speed > this.speedLimit; }

    _heat(t, W, H) {
      const dt = this.lastT == null ? 0 : Math.max(0, t - this.lastT);
      const k = Math.exp(-dt / this.heatTau);
      const h = this.heat, gw = this.heatW, gh = this.heatH;
      let max = 0;
      for (let i = 0; i < h.length; i++) { h[i] *= k; if (h[i] > max) max = h[i]; }
      const r = 2.2; // splat radius in grid cells
      for (const tr of this.tracks) {
        if (!tr.seen) continue;
        const gx = tr.c[0] / W * gw, gy = tr.box[3] / H * gh; // bottom of the box = where it touches the road
        for (let y = Math.floor(gy - r * 2); y <= Math.ceil(gy + r * 2); y++) {
          if (y < 0 || y >= gh) continue;
          for (let x = Math.floor(gx - r * 2); x <= Math.ceil(gx + r * 2); x++) {
            if (x < 0 || x >= gw) continue;
            const w = Math.exp(-((x - gx) ** 2 + (y - gy) ** 2) / (2 * r * r));
            const v = (h[y * gw + x] += w);
            if (v > max) max = v;
          }
        }
      }
      this.heatMax = max;
    }

    // RGBA pixels (heatW x heatH) for drawing; transparent where there is no traffic
    heatPixels() {
      const n = this.heatW * this.heatH, out = new Uint8ClampedArray(n * 4), max = Math.max(1, this.heatMax);
      const stops = [[0, [0, 40, 255]], [0.35, [0, 200, 255]], [0.55, [0, 230, 80]], [0.75, [255, 230, 0]], [1, [255, 30, 0]]];
      for (let i = 0; i < n; i++) {
        const v = Math.min(1, this.heat[i] / max);
        if (v < 0.04) continue;
        let j = 1; while (j < stops.length - 1 && v > stops[j][0]) j++;
        const [p0, c0] = stops[j - 1], [p1, c1] = stops[j], f = (v - p0) / (p1 - p0 || 1);
        out[i * 4] = c0[0] + (c1[0] - c0[0]) * f;
        out[i * 4 + 1] = c0[1] + (c1[1] - c0[1]) * f;
        out[i * 4 + 2] = c0[2] + (c1[2] - c0[2]) * f;
        out[i * 4 + 3] = Math.min(255, 60 + v * 195);
      }
      return out;
    }

    csv(startDate = new Date()) {
      const rows = [['timestamp', 'seconds_since_start', 'vehicle_id', 'class', 'direction', 'speed_kmh']];
      for (const e of this.events) {
        const sec = e.t - this.startT;
        rows.push([new Date(startDate.getTime() + sec * 1000).toISOString(), sec.toFixed(2), e.id, e.name,
                   e.dir === 'in' ? 'inflow_down' : 'outflow_up', e.speed == null ? '' : e.speed.toFixed(1)]);
      }
      rows.push([]);
      rows.push(['summary', '', '', 'total', this.total, '']);
      rows.push(['summary', '', '', 'inflow_down', this.inflow, '']);
      rows.push(['summary', '', '', 'outflow_up', this.outflow, '']);
      Object.entries(this.byClass).forEach(([k, v]) => rows.push(['summary', '', '', k, v, '']));
      return rows.map((r) => r.join(',')).join('\n');
    }
  }

  return { TrafficCounter, VEHICLES };
});
