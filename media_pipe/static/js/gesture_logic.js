// Gesture Recognizer helpers. Pure logic (no DOM): see tests/gesture_logic.test.mjs

// The 7 built-in gestures of MediaPipe's canned model, plus "None".
export const GESTURES = {
  None: { name: 'No gesture', icon: '·' },
  Closed_Fist: { name: 'Closed fist', icon: '✊' },
  Open_Palm: { name: 'Open palm', icon: '✋' },
  Pointing_Up: { name: 'Pointing up', icon: '☝️' },
  Thumb_Down: { name: 'Thumb down', icon: '👎' },
  Thumb_Up: { name: 'Thumb up', icon: '👍' },
  Victory: { name: 'Victory', icon: '✌️' },
  ILoveYou: { name: 'I love you', icon: '🤟' },
};

// Named combinations when both hands show a gesture (order-independent).
const COMBOS = [
  [['Thumb_Up', 'Thumb_Up'], 'Double thumbs up 👍👍'],
  [['Thumb_Down', 'Thumb_Down'], 'Double thumbs down 👎👎'],
  [['Open_Palm', 'Open_Palm'], 'Both hands open (stop / hands up) 🙌'],
  [['Closed_Fist', 'Closed_Fist'], 'Both fists ✊✊'],
  [['Victory', 'Victory'], 'Double victory ✌️✌️'],
  [['Pointing_Up', 'Pointing_Up'], 'Both pointing up ☝️☝️'],
  [['ILoveYou', 'ILoveYou'], 'Double I love you 🤟🤟'],
  [['Thumb_Up', 'Thumb_Down'], 'Mixed thumbs 👍👎'],
  [['Open_Palm', 'Closed_Fist'], 'Palm and fist ✋✊'],
];

// Hand landmark index -> finger (0 is the wrist).
export const FINGERS = ['wrist', 'thumb', 'index', 'middle', 'ring', 'pinky'];
export function fingerOf(landmarkIndex) {
  if (landmarkIndex === 0) return 'wrist';
  return FINGERS[Math.ceil(landmarkIndex / 4)];
}

export const HAND_COLORS = { Left: '#38bdf8', Right: '#f97316' };
export const FINGER_COLORS = {
  wrist: '#e2e8f0',
  thumb: '#f43f5e',
  index: '#facc15',
  middle: '#22c55e',
  ring: '#38bdf8',
  pinky: '#a78bfa',
};

/**
 * Real-world side of a detected hand.
 * MediaPipe labels handedness assuming a mirrored (selfie) input image. Webcam frames
 * and normal videos are not mirrored before detection, so the label must be swapped.
 */
export function handSide(mediapipeLabel, inputMirrored = false) {
  if (inputMirrored) return mediapipeLabel;
  return mediapipeLabel === 'Left' ? 'Right' : mediapipeLabel === 'Right' ? 'Left' : mediapipeLabel;
}

/**
 * Turns one GestureRecognizer result into per-side hand data:
 *   { Left: { gesture, score, handednessScore, landmarks } | null, Right: ... }
 * Gestures scoring below minScore are reported as 'None'.
 * If both hands get the same side label, the more confident one keeps it and the
 * other takes the opposite side.
 */
export function handsFromResult(result, { minScore = 0.5, inputMirrored = false } = {}) {
  const hands = { Left: null, Right: null };
  const detected = (result?.landmarks || []).map((landmarks, i) => {
    const hd = result.handedness?.[i]?.[0] || result.handednesses?.[i]?.[0];
    const g = result.gestures?.[i]?.[0];
    const score = g ? g.score : 0;
    return {
      side: handSide(hd?.categoryName || 'Right', inputMirrored),
      handednessScore: hd?.score ?? 0,
      gesture: g && score >= minScore ? g.categoryName : 'None',
      score,
      landmarks,
    };
  });

  detected.sort((a, b) => b.handednessScore - a.handednessScore);
  for (const hand of detected) {
    let side = hand.side;
    if (hands[side]) side = side === 'Left' ? 'Right' : 'Left';
    if (hands[side]) continue; // more than two hands: ignore extras
    hands[side] = { ...hand, side };
  }
  return hands;
}

/** Human-readable summary of both hands' (stable) gestures. */
export function describeHands(left, right) {
  const l = left && left !== 'None' ? left : null;
  const r = right && right !== 'None' ? right : null;
  if (l && r) {
    for (const [[a, b], label] of COMBOS) {
      if ((l === a && r === b) || (l === b && r === a)) return label;
    }
    return `Left: ${GESTURES[l]?.name ?? l} · Right: ${GESTURES[r]?.name ?? r}`;
  }
  if (l) return `Left hand: ${GESTURES[l]?.name ?? l} ${GESTURES[l]?.icon ?? ''}`.trim();
  if (r) return `Right hand: ${GESTURES[r]?.name ?? r} ${GESTURES[r]?.icon ?? ''}`.trim();
  return null;
}

/**
 * Debounces per-frame gestures: a new gesture becomes the stable one only after
 * it has been seen in `holdFrames` consecutive frames. Missing hands count as 'None'.
 */
export class GestureStabilizer {
  constructor(holdFrames = 4) {
    this.holdFrames = holdFrames;
    this.stable = 'None';
    this.candidate = 'None';
    this.streak = 0;
  }

  /** Returns true when the stable gesture changed on this frame. */
  update(gesture) {
    const g = gesture || 'None';
    if (g === this.stable) {
      this.candidate = g;
      this.streak = 0;
      return false;
    }
    if (g === this.candidate) {
      this.streak += 1;
    } else {
      this.candidate = g;
      this.streak = 1;
    }
    if (this.streak >= this.holdFrames) {
      this.stable = g;
      this.streak = 0;
      return true;
    }
    return false;
  }

  reset() {
    this.stable = 'None';
    this.candidate = 'None';
    this.streak = 0;
  }
}
