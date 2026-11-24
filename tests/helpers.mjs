// Synthetic songs and "recorded in the room" versions of them, for the engine tests.
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A four-to-the-floor track: kick, hat, clap, bass, and a lead that changes every bar.
// `unique: false` repeats one 16-bar block so several sections are identical.
export function makeSong({ sr = 11025, seconds = 180, bpm = 124, seed = 1, unique = true } = {}) {
  const n = Math.round(sr * seconds), out = new Float32Array(n), B = 60 / bpm;
  const add = (at, len, fn) => {
    const s0 = Math.round(at * sr), m = Math.round(len * sr);
    for (let i = 0; i < m && s0 + i < n; i++) out[s0 + i] += fn(i / sr);
  };
  const scale = [0, 3, 5, 7, 10, 12, 15];
  const noise = rng(seed + 99);
  const bars = Math.ceil(seconds / (4 * B));
  for (let bar = 0; bar < bars; bar++) {
    const r = rng(seed * 1000 + (unique ? bar : bar % 16));
    const root = 55 * 2 ** ([0, 3, 5, 7][Math.floor(r() * 4)] / 12);
    const kicks = r() > 0.08, clap = r() > 0.25, hats = r() > 0.15;
    for (let b = 0; b < 4; b++) {
      const t = (bar * 4 + b) * B;
      if (kicks) add(t, 0.25, (x) => 0.7 * Math.sin(2 * Math.PI * (48 * x + 4 * (1 - Math.exp(-x * 28)))) * Math.exp(-x * 12));
      if (hats) add(t + B / 2, 0.05, (x) => 0.15 * (noise() * 2 - 1) * Math.exp(-x * 70));
      if (clap && b % 2) add(t, 0.1, (x) => 0.2 * (noise() * 2 - 1) * Math.exp(-x * 30));
      for (let q = 1; q < 4; q++) if (r() > 0.4) add(t + (q * B) / 4, 0.1, (x) => 0.2 * Math.sin(2 * Math.PI * root * 2 * x) * Math.exp(-x * 14));
      for (let q = 0; q < 4; q++) if (r() > 0.6) {
        const f = root * 8 * 2 ** (scale[Math.floor(r() * 7)] / 12);
        add(t + (q * B) / 4, 0.18, (x) => 0.16 * (Math.sin(2 * Math.PI * f * x) + 0.4 * Math.sin(4 * Math.PI * f * x)) * Math.exp(-x * 9));
      }
    }
  }
  for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i]);
  return out;
}

// Reads `src` from `start` seconds at `ratio` speed (pitch moves with it, like a deck without key lock).
export function play(src, sr, start, ratio, seconds) {
  const n = Math.round(seconds * sr), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (start + (i / sr) * ratio) * sr, k = Math.floor(p), f = p - k;
    if (k >= 0 && k + 1 < src.length) out[i] = src[k] * (1 - f) + src[k + 1] * f;
  }
  return out;
}

// Phone-in-a-club: dull, reverberant, clipped, with crowd noise on top.
export function room(x, sr, { seed = 5, crowd = 0.06 } = {}) {
  const r = rng(seed), n = x.length, out = new Float32Array(n);
  const taps = [[0.013, 0.4], [0.031, 0.3], [0.067, 0.22], [0.11, 0.14]].map(([t, g]) => [Math.round(t * sr), g]);
  let lp = 0, c = 0;
  for (let i = 0; i < n; i++) {
    let v = x[i];
    for (const [d, g] of taps) if (i >= d) v += g * x[i - d];
    lp += 0.55 * (v - lp);
    c = 0.8 * c + 0.2 * (r() * 2 - 1);
    out[i] = Math.tanh(lp * 2) * 0.5 + c * crowd * 4;
  }
  return out;
}

export function concat(...parts) {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
