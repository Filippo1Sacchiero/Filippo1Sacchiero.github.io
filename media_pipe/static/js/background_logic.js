// Virtual background helpers. Pure logic (no DOM): see tests/background_logic.test.mjs

export const PHOTOS = [
  { key: '1', name: 'Mountain lake', url: 'static/backgrounds/1_mountain_lake.jpg' },
  { key: '2', name: 'Tropical beach', url: 'static/backgrounds/2_tropical_beach.jpg' },
  { key: '3', name: 'Alpine meadow', url: 'static/backgrounds/3_alpine_meadow.jpg' },
  { key: '4', name: 'Desert dunes', url: 'static/backgrounds/4_desert_dunes.jpg' },
];

export const COLORS = {
  '0': { name: 'Black', value: '#000000' },
  r: { name: 'Red', value: '#dc2626' },
  w: { name: 'White', value: '#ffffff' },
  y: { name: 'Yellow', value: '#facc15' },
  g: { name: 'Green', value: '#16a34a' },
};

// Blur radius per level, in pixels at 720p (scaled to the actual video height).
export const BLUR_LEVELS = [4, 8, 13, 19, 26, 34, 44];

export const INITIAL_STATE = { mode: 'none', photo: null, color: null, blurLevel: 0 };

// Inputs where a key press does not type text, so shortcuts stay active when they have focus.
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file']);

/**
 * True when a keydown should be treated as a background shortcut.
 * e: { key, ctrlKey, metaKey, altKey, repeat, targetTag, targetType, targetEditable }
 */
export function isShortcutEvent(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return false;
  const tag = (e.targetTag || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT' || e.targetEditable) return false;
  if (tag === 'INPUT' && !NON_TEXT_INPUTS.has((e.targetType || 'text').toLowerCase())) return false;
  return actionForKey(e.key) != null;
}

/** Maps a key to an action, or null. Letters are case-insensitive. */
export function actionForKey(key) {
  if (typeof key !== 'string' || key.length !== 1) return null;
  const k = key.toLowerCase();
  const photo = PHOTOS.findIndex(p => p.key === k);
  if (photo >= 0) return { type: 'photo', index: photo };
  if (COLORS[k]) return { type: 'color', key: k };
  if (k === 'b') return { type: 'blur' };
  return null;
}

/**
 * Applies an action. Returns { state, message }.
 * Blur: the first press turns blur on at level 1, each further press goes one level up,
 * capped at the maximum. Choosing a photo or color resets the blur.
 */
export function applyAction(state, action) {
  switch (action?.type) {
    case 'photo': {
      const p = PHOTOS[action.index];
      return { state: { ...INITIAL_STATE, mode: 'photo', photo: action.index }, message: `${p.key} · ${p.name}` };
    }
    case 'color': {
      const c = COLORS[action.key];
      return { state: { ...INITIAL_STATE, mode: 'color', color: action.key }, message: `${action.key.toUpperCase()} · ${c.name}` };
    }
    case 'blur': {
      const max = BLUR_LEVELS.length;
      if (state.mode === 'blur' && state.blurLevel >= max) {
        return { state, message: `B · Blur ${max}/${max} (maximum)` };
      }
      const level = state.mode === 'blur' ? state.blurLevel + 1 : 1;
      return { state: { ...INITIAL_STATE, mode: 'blur', blurLevel: level }, message: `B · Blur ${level}/${max}` };
    }
    case 'none':
      return { state: { ...INITIAL_STATE }, message: 'Original background' };
    default:
      return { state, message: null };
  }
}

/** Blur radius in px for a level and video height. */
export function blurRadius(level, videoHeight) {
  if (!level) return 0;
  const base = BLUR_LEVELS[Math.min(level, BLUR_LEVELS.length) - 1];
  return Math.max(1, Math.round(base * (videoHeight / 720)));
}

/** Short description of the current background, for the status line. */
export function describeState(state) {
  if (state.mode === 'photo') return PHOTOS[state.photo].name;
  if (state.mode === 'color') return `${COLORS[state.color].name} color`;
  if (state.mode === 'blur') return `Blur ${state.blurLevel}/${BLUR_LEVELS.length}`;
  return 'Original';
}

const smoothstep = (lo, hi, x) => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/**
 * Turns a person-confidence mask into the alpha channel of an RGBA buffer.
 * - temporal: blends with the previous frame's confidence (0 = off) to reduce flicker;
 *   `prev` is updated in place.
 * - edges are tightened with a smoothstep between `lo` and `hi`, keeping them soft.
 */
export function maskToAlpha(conf, rgba, prev = null, { temporal = 0.4, lo = 0.25, hi = 0.75 } = {}) {
  for (let i = 0; i < conf.length; i++) {
    let c = conf[i];
    if (prev) {
      c = prev[i] * temporal + c * (1 - temporal);
      prev[i] = c;
    }
    rgba[i * 4 + 3] = Math.round(smoothstep(lo, hi, c) * 255);
  }
  return rgba;
}
