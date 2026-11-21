// Arm rep counting from MediaPipe Pose landmarks.
// Pure logic (no DOM) so it can be unit-tested with Node: see tests/rep_counter.test.mjs

// MediaPipe Pose landmark indices. "left"/"right" are the person's own sides.
export const ARM_LANDMARKS = {
  left: { shoulder: 11, elbow: 13, wrist: 15 },
  right: { shoulder: 12, elbow: 14, wrist: 16 },
};

export const DEFAULTS = {
  straightAngle: 150, // elbow angle (deg) at or above which the arm counts as straight
  bentAngle: 60,      // elbow angle (deg) at or below which the arm counts as bent
  minVisibility: 0.5, // shoulder, elbow and wrist must all be at least this visible
  smoothing: 0.5,     // EMA weight of the newest angle (1 = no smoothing)
  wobbleDeg: 20,      // dips smaller than this below "straight" are ignored, not flagged
  lostResetMs: 1000,  // arm out of view this long -> state resets (avoids phantom reps)
  fastRepMs: 1000,    // full reps quicker than this get a "slow down" cue
};

/** Angle ABC in degrees, at vertex B. Points are {x, y, z?}. */
export function jointAngle(a, b, c) {
  const v1 = [a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)];
  const v2 = [c.x - b.x, c.y - b.y, (c.z || 0) - (b.z || 0)];
  const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  const n1 = Math.hypot(...v1);
  const n2 = Math.hypot(...v2);
  if (!n1 || !n2) return null;
  const cos = Math.min(1, Math.max(-1, dot / (n1 * n2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Elbow angle for one arm.
 * landmarks: normalized landmarks (used for visibility).
 * worldLandmarks: metric 3D landmarks (used for the angle when present).
 * Returns null when the arm is not visible enough.
 */
export function elbowAngle(landmarks, worldLandmarks, side, minVisibility = DEFAULTS.minVisibility) {
  const idx = ARM_LANDMARKS[side];
  const pts = [idx.shoulder, idx.elbow, idx.wrist];
  if (!landmarks || pts.some(i => !landmarks[i])) return null;
  if (pts.some(i => (landmarks[i].visibility ?? 1) < minVisibility)) return null;
  const src = worldLandmarks && pts.every(i => worldLandmarks[i]) ? worldLandmarks : landmarks;
  return jointAngle(src[idx.shoulder], src[idx.elbow], src[idx.wrist]);
}

/**
 * State machine for one arm. A rep is one full cycle:
 *   straight -> (bending) -> bent -> (extending) -> straight
 * Phases: 'unknown' (waiting for a straight arm), 'straight', 'bending', 'bent', 'extending'.
 */
export class ArmRepCounter {
  constructor(side, options = {}) {
    this.side = side;
    this.options = { ...DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.count = 0;
    this.phase = 'unknown';
    this.angle = null;
    this.lastSeenMs = null;
    this.repStartMs = null;
    this.minAngle = null;
    this.maxAngle = null;
  }

  /** Forget the in-progress movement (e.g. after a video seek) but keep the count. */
  interrupt() {
    this.phase = 'unknown';
    this.angle = null;
    this.lastSeenMs = null;
  }

  setOptions(options) {
    Object.assign(this.options, options);
  }

  /**
   * Feed one frame. rawAngle may be null when the arm is not visible.
   * Returns an event or null:
   *   { type: 'rep', count, minAngle, durationMs, fast }
   *   { type: 'partial_curl', minAngle }        bent, but not to the bent threshold
   *   { type: 'partial_extension', maxAngle }   bent again before reaching straight
   *   { type: 'lost' }                           arm out of view; state reset
   */
  update(rawAngle, timeMs) {
    const o = this.options;

    if (rawAngle == null) {
      if (this.phase !== 'unknown' && this.lastSeenMs != null && timeMs - this.lastSeenMs > o.lostResetMs) {
        this.phase = 'unknown';
        this.angle = null;
        return { type: 'lost' };
      }
      return null;
    }
    this.lastSeenMs = timeMs;

    this.angle = this.angle == null ? rawAngle : this.angle + o.smoothing * (rawAngle - this.angle);
    const a = this.angle;

    switch (this.phase) {
      case 'unknown':
        if (a >= o.straightAngle) this.phase = 'straight';
        return null;

      case 'straight':
        if (a < o.straightAngle) {
          this.phase = 'bending';
          this.repStartMs = timeMs;
          this.minAngle = a;
        }
        return null;

      case 'bending':
        this.minAngle = Math.min(this.minAngle, a);
        if (a <= o.bentAngle) {
          this.phase = 'bent';
          return null;
        }
        if (a >= o.straightAngle) {
          this.phase = 'straight';
          // Only flag real attempts, not small wobbles around the straight threshold.
          if (this.minAngle < o.straightAngle - o.wobbleDeg) {
            return { type: 'partial_curl', minAngle: round(this.minAngle) };
          }
        }
        return null;

      case 'bent':
        this.minAngle = Math.min(this.minAngle, a);
        if (a > o.bentAngle) {
          this.phase = 'extending';
          this.maxAngle = a;
        }
        return null;

      case 'extending':
        this.maxAngle = Math.max(this.maxAngle, a);
        if (a >= o.straightAngle) {
          this.phase = 'straight';
          this.count += 1;
          const durationMs = timeMs - this.repStartMs;
          return {
            type: 'rep',
            count: this.count,
            minAngle: round(this.minAngle),
            durationMs,
            fast: durationMs < o.fastRepMs,
          };
        }
        if (a <= o.bentAngle) {
          this.phase = 'bent';
          if (this.maxAngle > o.bentAngle + o.wobbleDeg) {
            return { type: 'partial_extension', maxAngle: round(this.maxAngle) };
          }
        }
        return null;

      default:
        return null;
    }
  }
}

function round(v) {
  return Math.round(v);
}
