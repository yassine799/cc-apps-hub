// Matching engine for the Audio replacer. Pure functions on sample arrays: no DOM, no network.
// Times are seconds. `ratio` is how fast the official song runs in the video:
//   official time = start + ratio × video time

/* ---------- FFT ---------- */
const plans = new Map();
function plan(n) {
  let p = plans.get(n);
  if (!p) {
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), rev = new Uint32Array(n);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; }
    plans.set(n, (p = { cos, sin, rev }));
  }
  return p;
}
function fft(re, im) {
  const n = re.length, { cos, sin, rev } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half, c = cos[k], s = sin[k];
        const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}
const pow2 = (n) => 2 ** Math.ceil(Math.log2(n));
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/* ---------- Features: onsets in 16 bands ---------- */
const WIN = 512, HOP = 64, BANDS = 16, POOL = 4;
const cache = new WeakMap();
function features(x, sr) {
  let f = cache.get(x);
  if (f) return f;
  const frames = Math.max(1, Math.floor(x.length / HOP)), half = WIN / 2;
  const hann = new Float64Array(WIN).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN));
  const edges = Array.from({ length: BANDS + 1 }, (_, b) => Math.max(b + 1, Math.round(((40 * (5000 / 40) ** (b / BANDS)) / sr) * WIN)));
  for (let b = 1; b <= BANDS; b++) edges[b] = Math.max(edges[b], edges[b - 1] + 1);
  let rms = 0;
  for (let i = 0; i < x.length; i++) rms += x[i] * x[i];
  const gain = 1 / (Math.sqrt(rms / Math.max(1, x.length)) || 1);
  const level = Array.from({ length: BANDS }, () => new Float32Array(frames));
  const re = new Float64Array(WIN), im = new Float64Array(WIN);
  // Two frames per transform: one in the real part, one in the imaginary part.
  for (let t = 0; t < frames; t += 2) {
    for (let i = 0; i < WIN; i++) {
      const a = t * HOP - half + i, b = a + HOP;
      re[i] = a >= 0 && a < x.length ? x[a] * hann[i] * gain : 0;
      im[i] = b >= 0 && b < x.length ? x[b] * hann[i] * gain : 0;
    }
    fft(re, im);
    for (let b = 0; b < BANDS; b++) {
      let e0 = 0, e1 = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) {
        const m = WIN - k, ar = (re[k] + re[m]) / 2, ai = (im[k] - im[m]) / 2, br = (im[k] + im[m]) / 2, bi = (re[m] - re[k]) / 2;
        e0 += ar * ar + ai * ai; e1 += br * br + bi * bi;
      }
      level[b][t] = Math.log(1 + e0 / (edges[b + 1] - edges[b]));
      if (t + 1 < frames) level[b][t + 1] = Math.log(1 + e1 / (edges[b + 1] - edges[b]));
    }
  }
  const fps = sr / HOP, lag = 3, around = Math.round(fps * 0.5);
  const fine = level.map((lv) => {
    const flux = new Float32Array(frames);
    for (let t = lag; t < frames; t++) flux[t] = Math.max(0, lv[t] - lv[t - lag]);
    return whiten(flux, around);
  });
  const coarse = fine.map((b) => {
    const out = new Float32Array(Math.ceil(frames / POOL));
    for (let t = 0; t < out.length; t++) { let s = 0; for (let k = 0; k < POOL; k++) s += b[t * POOL + k] || 0; out[t] = s / POOL; }
    return out;
  });
  f = { fine, coarse, fps, coarseFps: fps / POOL, frames, seconds: x.length / sr, energy: cumEnergy(fine), coarseEnergy: cumEnergy(coarse) };
  cache.set(x, f);
  return f;
}
// Remove the local average, then scale to unit variance so every band counts the same.
function whiten(v, around) {
  const n = v.length, out = new Float32Array(n);
  let sum = 0, count = 0, sq = 0;
  for (let i = 0; i < Math.min(n, around); i++) { sum += v[i]; count++; }
  for (let t = 0; t < n; t++) {
    if (t + around < n) { sum += v[t + around]; count++; }
    if (t - around - 1 >= 0) { sum -= v[t - around - 1]; count--; }
    out[t] = v[t] - sum / count;
    sq += out[t] * out[t];
  }
  const k = 1 / (Math.sqrt(sq / n) || 1);
  for (let t = 0; t < n; t++) out[t] = Math.min(4, out[t] * k);
  return out;
}
function cumEnergy(bands) {
  const n = bands[0].length, c = new Float64Array(n + 1);
  for (let t = 0; t < n; t++) { let s = 0; for (const b of bands) s += b[t] * b[t]; c[t + 1] = c[t] + s; }
  return c;
}

/* ---------- Tempo ---------- */
export function detectBpm(x, sr) {
  const f = features(x, sr), n = f.frames, size = pow2(n * 2);
  const ac = new Float64Array(n), re = new Float64Array(size), im = new Float64Array(size);
  for (let b = 0; b < BANDS; b++) {
    re.fill(0); im.fill(0); re.set(f.fine[b]);
    fft(re, im);
    for (let i = 0; i < size; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
    fft(re, im);
    for (let i = 0; i < n; i++) ac[i] += re[i] / (n - i + 1);
  }
  const at = (lag) => { const k = Math.floor(lag), r = lag - k; return k + 1 < n ? ac[k] * (1 - r) + ac[k + 1] * r : 0; };
  const score = (bpm, beats) => {
    const lag = (60 / bpm) * f.fps;
    let s = 0, c = 0;
    for (let k = 1; k <= beats && k * lag < n * 0.6; k++) { s += at(k * lag); c++; }
    return c ? s / c : 0;
  };
  let best = 0, top = -1;
  for (let bpm = 85; bpm <= 175; bpm += 0.25) {
    const s = score(bpm, 8) * Math.exp(-0.5 * (Math.log2(bpm / 122) / 0.6) ** 2);
    if (s > top) { top = s; best = bpm; }
  }
  for (const [span, step, beats] of [[1, 0.05, 24], [0.15, 0.005, 96]]) {
    let local = -Infinity, pick = best;
    for (let bpm = best - span; bpm <= best + span; bpm += step) { const s = score(bpm, beats); if (s > local) { local = s; pick = bpm; } }
    best = pick;
  }
  return { bpm: best, strength: ac[0] ? top / ac[0] : 0 };
}

// The first beat after `from`, judged on the low bands where the kick lives.
export function firstBeat(x, sr, bpm, from, to) {
  const f = features(x, sr), beat = 60 / bpm, t0 = Math.max(0, Math.round(from * f.fps)), t1 = Math.min(f.frames, Math.round(to * f.fps));
  const bins = new Float64Array(200);
  for (let t = t0; t < t1; t++) {
    const v = f.fine[0][t] + f.fine[1][t] + f.fine[2][t];
    if (v > 0) bins[Math.floor(((((t / f.fps - from) / beat) % 1 + 1) % 1) * 200) % 200] += v;
  }
  let best = 0, top = -1;
  for (let i = 0; i < 200; i++) {
    let s = 0;
    for (let d = -4; d <= 4; d++) s += bins[(i + d + 200) % 200] * (5 - Math.abs(d));
    if (s > top) { top = s; best = i; }
  }
  return from + (best / 200) * beat;
}

/* ---------- Coarse search: which part of the song, at which speed ---------- */
const RATIOS = Array.from({ length: 61 }, (_, i) => 1 + (i - 30) * 0.004);
function coarseSeeds(L, O, accept, onProgress) {
  const fps = L.coarseFps, total = L.coarse[0].length, n = O.coarse[0].length;
  const len = Math.min(total, Math.round(12 * fps));
  const count = Math.max(1, Math.min(6, Math.ceil(total / len)));
  const maxLen = Math.ceil(len * 1.13), size = pow2(n + 2 * maxLen);
  // Song spectra once. Bands travel in pairs, one real and one imaginary.
  const spectra = [];
  for (let b = 0; b < BANDS; b += 2) {
    const re = new Float64Array(size), im = new Float64Array(size);
    re.set(O.coarse[b], maxLen); im.set(O.coarse[b + 1], maxLen);
    fft(re, im);
    spectra.push([re, im]);
  }
  const seeds = [], re = new Float64Array(size), im = new Float64Array(size), ar = new Float64Array(size), ai = new Float64Array(size);
  for (let s = 0; s < count; s++) {
    const first = count === 1 ? 0 : Math.round((s * (total - len)) / (count - 1));
    for (let ri = 0; ri < RATIOS.length; ri++) {
      const ratio = RATIOS[ri], m = Math.floor(len * ratio);
      ar.fill(0); ai.fill(0);
      let energy = 0;
      for (let b = 0; b < BANDS; b += 2) {
        re.fill(0); im.fill(0);
        for (let u = 0; u < m; u++) {
          const p = first + u / ratio, k = Math.floor(p), r = p - k, k1 = Math.min(total - 1, k + 1);
          re[u] = L.coarse[b][k] * (1 - r) + L.coarse[b][k1] * r;
          im[u] = L.coarse[b + 1][k] * (1 - r) + L.coarse[b + 1][k1] * r;
          energy += re[u] * re[u] + im[u] * im[u];
        }
        fft(re, im);
        // Real part of O·conj(L) sums both bands' correlations.
        const [or, oi] = spectra[b / 2];
        for (let i = 0; i < size; i++) { ar[i] += or[i] * re[i] + oi[i] * im[i]; ai[i] += oi[i] * re[i] - or[i] * im[i]; }
      }
      // Inverse transform by conjugation.
      for (let i = 0; i < size; i++) ai[i] = -ai[i];
      fft(ar, ai);
      const floor = (O.coarseEnergy[n] / n) * m * 0.25;
      const ncc = (i) => {
        const a = Math.max(0, i - maxLen), z = Math.min(n, i - maxLen + m);
        if (z - a < m * 0.5) return 0;
        return ar[i] / size / Math.sqrt(energy * Math.max(floor, O.coarseEnergy[z] - O.coarseEnergy[a]) + 1e-9);
      };
      const local = [];
      let prev = 0, cur = ncc(0);
      for (let i = 1; i < n + maxLen; i++) {
        const next = ncc(i);
        if (cur > prev && cur >= next && cur > 0.08) {
          const start = (i - 1 - maxLen) / fps - (ratio * first) / fps;
          if (!accept || accept(start)) local.push({ start, ratio, score: cur, video: (first + len / 2) / fps });
        }
        prev = cur; cur = next;
      }
      local.sort((a, b) => b.score - a.score);
      seeds.push(...local.slice(0, 10));
      if (onProgress) onProgress((s * RATIOS.length + ri + 1) / (count * RATIOS.length));
    }
  }
  return seeds.sort((a, b) => b.score - a.score);
}

/* ---------- Fine alignment ---------- */
// How well a stretch of video fits the song at a given position, for a range of small shifts.
function correlate(L, O, video, seconds, start, ratio, shifts) {
  const fps = L.fps, v0 = Math.max(0, Math.round((video - seconds / 2) * fps)), v1 = Math.min(L.frames, Math.round((video + seconds / 2) * fps));
  let energy = 0;
  for (const b of L.fine) for (let v = v0; v < v1; v++) energy += b[v] * b[v];
  return shifts.map((shift) => {
    let dot = 0, oe = 0, used = 0;
    const base = (start + shift) * fps;
    for (let v = v0; v < v1; v++) {
      const p = base + ratio * v, k = Math.floor(p), r = p - k;
      if (k < 0 || k + 1 >= O.frames) continue;
      used++;
      for (let b = 0; b < BANDS; b++) {
        const o = O.fine[b][k] * (1 - r) + O.fine[b][k + 1] * r;
        dot += o * L.fine[b][v]; oe += o * o;
      }
    }
    return used < (v1 - v0) * 0.5 ? 0 : dot / Math.sqrt(energy * oe + 1e-9);
  });
}
function bestShift(L, O, video, seconds, start, ratio, reach) {
  const step = 1 / L.fps, n = Math.ceil(reach / step), shifts = [];
  for (let i = -n; i <= n; i++) shifts.push(i * step);
  const c = correlate(L, O, video, seconds, start, ratio, shifts);
  let k = 0;
  for (let i = 1; i < c.length; i++) if (c[i] > c[k]) k = i;
  let frac = 0;
  if (k > 0 && k < c.length - 1) { const d = c[k - 1] - 2 * c[k] + c[k + 1]; if (d < 0) frac = (0.5 * (c[k - 1] - c[k + 1])) / d; }
  return { shift: shifts[k] + frac * step, score: c[k], edge: k === 0 || k === c.length - 1 };
}
// Weighted line through (video time, song time), ignoring windows that disagree.
function fitLine(points) {
  let w = points.map((p) => Math.max(0, p.score) ** 2), line = null;
  for (let pass = 0; pass < 6; pass++) {
    let sw = 0, sx = 0, sy = 0;
    points.forEach((p, i) => { sw += w[i]; sx += w[i] * p.video; sy += w[i] * p.song; });
    const mx = sx / sw, my = sy / sw;
    let sxx = 0, sxy = 0;
    points.forEach((p, i) => { sxx += w[i] * (p.video - mx) ** 2; sxy += w[i] * (p.video - mx) * (p.song - my); });
    const ratio = sxx > 1e-9 ? sxy / sxx : line ? line.ratio : 1;
    line = { ratio, start: my - ratio * mx };
    const res = points.map((p) => Math.abs(p.song - line.start - line.ratio * p.video));
    const scale = Math.max(0.002, 1.5 * median(res));
    w = points.map((p, i) => Math.max(0, p.score) ** 2 / (1 + (res[i] / scale) ** 2) ** 2);
  }
  return line;
}
function refine(L, O, seed) {
  const D = L.seconds, win = Math.min(6, D), step = Math.min(2, Math.max(0.5, D / 12));
  const centers = [];
  for (let v = win / 2; v <= D - win / 2 + 1e-6; v += step) centers.push(v);
  if (!centers.length) centers.push(D / 2);
  let line = { start: seed.start, ratio: seed.ratio };
  // Grow outwards from where the seed was found, so a small speed error never outruns the search.
  const byDistance = [...centers].sort((a, b) => Math.abs(a - seed.video) - Math.abs(b - seed.video));
  let points = [];
  byDistance.forEach((v, i) => {
    const r = bestShift(L, O, v, win, line.start, line.ratio, i < 4 ? 0.06 : 0.035);
    if (r.score > 0.1 && !r.edge) points.push({ video: v, song: line.start + r.shift + line.ratio * v, score: r.score });
    const spread = points.length > 2 ? Math.max(...points.map((p) => p.video)) - Math.min(...points.map((p) => p.video)) : 0;
    if (spread >= Math.min(4, D / 4)) {
      const next = fitLine(points);
      if (Math.abs(next.ratio / seed.ratio - 1) < 0.012) line = next;
    }
  });
  if (points.length < 2) return null;
  for (const reach of [0.03, 0.02]) {
    points = [];
    for (const v of centers) {
      const r = bestShift(L, O, v, win, line.start, line.ratio, reach);
      if (r.score > 0.1 && !r.edge) points.push({ video: v, song: line.start + r.shift + line.ratio * v, score: r.score });
    }
    if (points.length < 2) return null;
    const next = fitLine(points);
    if (Math.abs(next.ratio / line.ratio - 1) < 0.004) line = next;
  }
  return { ...line, points };
}

/* ---------- Is the song really playing here? ---------- */
// Compares each window with the same song a few beats away. A different track mixed to the same
// beat fits every beat equally well; the real one fits only here.
function presence(L, O, line, beat) {
  const D = L.seconds, win = Math.min(4, D), out = [];
  const beats = [-11, -9, -7, -6, -5, -3, -2, -1, 1, 2, 3, 5, 6, 7, 9, 11].map((k) => k * beat);
  for (let v = win / 2; v <= D - win / 2 + 1e-6; v += 1) {
    const c = correlate(L, O, v, win, line.start, line.ratio, [0, ...beats]);
    out.push({ video: v, score: c[0], lead: c[0] - median(c.slice(1).filter((s) => s !== 0)) });
  }
  return { windows: out, win };
}
function range(p, D, cover) {
  const usable = p.windows.filter((w) => w.video > cover.from && w.video < cover.to);
  const typical = median(usable.map((w) => w.lead).filter((l) => l > 0.03));
  const on = p.windows.map((w) => w.lead > Math.max(0.03, typical * 0.45));
  let first = on.findIndex((v, i) => v && (on[i + 1] || i === on.length - 1));
  let last = on.length - 1 - [...on].reverse().findIndex((v, i, r) => v && (r[i + 1] || i === r.length - 1));
  if (first < 0) return cover;
  if (last >= on.length) last = first;
  let from = p.windows[first].video, to = p.windows[last].video;
  // Windows straddling the change already show it, so the edge sits near the window's centre.
  // Noise alone dims the whole recording, so only trim what is clearly weaker than the rest.
  const mean = (a, z) => { const w = p.windows.filter((q) => q.video >= a && q.video <= z); return w.reduce((t, q) => t + q.lead, 0) / Math.max(1, w.length); };
  const inside = mean(from, to);
  if (from - p.win / 2 < 3 || mean(0, from - 1) > inside * 0.3) from = 0;
  if (D - (to + p.win / 2) < 3 || mean(to + 1, D) > inside * 0.3) to = D;
  // A quiet first or last bar is still the song.
  if (from - cover.from < 4) from = cover.from;
  if (cover.to - to < 4) to = cover.to;
  return { from: Math.max(cover.from, from), to: Math.min(cover.to, to) };
}

/* ---------- Public: matching ---------- */
function finish(L, O, bpm, seed) {
  const line = refine(L, O, seed);
  if (!line) return null;
  const D = L.seconds;
  let { start, ratio } = line;
  const snapped = snapRatio(ratio, D);
  if (snapped !== ratio) { start += (ratio - snapped) * (D / 2); ratio = snapped; }
  const p = presence(L, O, { start, ratio }, 60 / bpm);
  const good = line.points.filter((q) => Math.abs(q.song - start - ratio * q.video) < 0.03);
  const r = range(p, D, coverage(start, ratio, O.seconds, D));
  // Judge only the stretch where the song plays. `lead` is how much better this spot fits than its
  // neighbours; as a share of the fit it stays put however noisy the recording is.
  const inside = p.windows.filter((w) => w.video >= r.from && w.video <= r.to);
  const mean = (key) => inside.reduce((t, w) => t + w[key], 0) / Math.max(1, inside.length);
  const score = mean('score'), strength = mean('lead');
  const residuals = good.filter((q) => q.video >= r.from && q.video <= r.to).map((q) => Math.abs(q.song - start - ratio * q.video));
  return {
    start, ratio, score, strength, from: r.from, to: r.to,
    driftMs: residuals.length ? 1000 * residuals.sort((a, b) => a - b)[Math.floor(residuals.length * 0.9)] : Infinity,
    agree: good.length / Math.max(1, line.points.length),
    confident: strength > 0.025 && strength / score > 0.22 && r.to - r.from > Math.min(5, D / 2),
  };
}
export function findMatches(live, official, sr, onProgress) {
  return search(features(live, sr), features(official, sr), detectBpm(official, sr).bpm, null, onProgress);
}
export function refineAt(live, official, sr, start) {
  const found = search(features(live, sr), features(official, sr), detectBpm(official, sr).bpm, (s) => Math.abs(s - start) < 0.6);
  return found[0] || null;
}
function search(L, O, bpm, accept, onProgress) {
  const seeds = coarseSeeds(L, O, accept, onProgress);
  const picked = [];
  for (const s of seeds) {
    // Same place in the song, seen from this part of the video, means the same guess.
    const at = s.start + s.ratio * s.video;
    if (picked.some((q) => Math.abs(q.start + q.ratio * s.video - at) < 0.25)) continue;
    picked.push(s);
    if (picked.length >= 14) break;
  }
  const out = [];
  for (const s of picked) {
    const m = finish(L, O, bpm, s);
    if (m && !out.some((q) => Math.abs(q.start - m.start) < 0.25)) out.push(m);
  }
  // How much of the video a section explains counts as much as how well it fits there.
  const evidence = (m) => m.strength * (m.to - m.from);
  out.sort((a, b) => b.confident - a.confident || evidence(b) - evidence(a));
  return out.filter((m, i) => i === 0 || (m.confident && evidence(m) > evidence(out[0]) * 0.3)).slice(0, 5);
}

export function snapRatio(ratio, seconds) {
  return Math.abs(ratio - 1) * seconds < 0.008 ? 1 : ratio;
}
// The part of the video the song is long enough to cover.
export function coverage(start, ratio, songSeconds, videoSeconds) {
  const from = Math.max(0, -start / ratio), to = Math.min(videoSeconds, (songSeconds - start) / ratio);
  return { from, to: Math.max(from, to) };
}

/* ---------- Public: audio ---------- */
// Official audio between `from` and `to`, live audio elsewhere, equal-power crossfades inside the song.
export function mixFinal({ official, live, sr, from, to, fade, level, liveGain }) {
  const n = official[0].length, a = Math.round(from * sr), z = Math.min(n, Math.round(to * sr));
  const f = Math.max(1, Math.min(Math.round(fade * sr), Math.floor((z - a) / 2)));
  const fadeIn = a > 0, fadeOut = z < n;
  let peak = 0;
  const out = official.map((o, c) => {
    const l = live[Math.min(c, live.length - 1)], y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let g = i < a || i >= z ? 0 : 1;
      if (g && fadeIn && i < a + f) g = (i - a) / f;
      if (g && fadeOut && i >= z - f) g = Math.min(g, (z - i) / f);
      const song = g === 1 ? 1 : g === 0 ? 0 : Math.sin((g * Math.PI) / 2);
      const under = g === 1 ? level : g === 0 ? 1 : Math.sqrt(level * level + (1 - level * level) * Math.cos((g * Math.PI) / 2) ** 2);
      y[i] = (song ? o[i] * song : 0) + (under ? (l[i] || 0) * under * liveGain : 0);
      const m = Math.abs(y[i]);
      if (m > peak) peak = m;
    }
    return y;
  });
  return peak > 1 ? limit(out, 0.98, sr) : out;
}
// Keeps peaks under the ceiling without turning the music down. Small overshoots are rounded off, as the master
// already was; only what is far over ducks both channels for a few milliseconds.
export function limit(channels, ceiling, sr) {
  const n = channels[0].length, need = new Float32Array(n), duck = 1.35 * ceiling, knee = 0.9 * ceiling, rest = ceiling - knee;
  let any = false;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const c of channels) { const v = Math.abs(c[i]); if (v > m) m = v; }
    need[i] = m > duck ? duck / m : 1;
    if (m > ceiling) any = true;
  }
  if (!any) return channels;
  const ahead = Math.max(1, Math.round(sr * 0.0015)), release = 1 - Math.exp(-1 / (sr * 0.03));
  // Lowest gain needed within the look-ahead either side, then a moving average: smooth, and never too high.
  const low = new Float32Array(n), queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n + ahead; i++) {
    if (i < n) { while (tail > head && need[queue[tail - 1]] >= need[i]) tail--; queue[tail++] = i; }
    const at = i - ahead;
    if (at < 0) continue;
    while (queue[head] < at - ahead) head++;
    low[at] = need[queue[head]];
  }
  let g = 1;
  for (let i = 0; i < n; i++) { g = low[i] < g ? low[i] : g + (low[i] - g) * release; low[i] = g; }
  const gain = new Float64Array(n), width = 2 * ahead + 1;
  let sum = 0;
  for (let k = -ahead; k <= ahead; k++) sum += low[Math.min(n - 1, Math.max(0, k))];
  for (let i = 0; i < n; i++) { gain[i] = sum / width; sum += low[Math.min(n - 1, i + ahead + 1)] - low[Math.max(0, i - ahead)]; }
  return channels.map((c) => {
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = c[i] * Math.min(1, gain[i]), m = Math.abs(v);
      y[i] = m <= knee ? v : Math.sign(v) * (knee + rest * Math.tanh((m - knee) / rest));
    }
    return y;
  });
}
export function loudnessGain(official, live, a, z) {
  const rms = (chs) => {
    let s = 0, n = 0;
    for (const c of chs) for (let i = a; i < Math.min(z, c.length); i++) { s += c[i] * c[i]; n++; }
    return Math.sqrt(s / Math.max(1, n));
  };
  const max = 10 ** (12 / 20), o = rms(official), l = rms(live);
  return l > 0 && o > 0 ? Math.min(max, Math.max(1 / max, o / l)) : 1;
}
export function downmix(channels, srIn, srOut) {
  const n = channels[0].length, mono = new Float32Array(n), g = 1 / channels.length;
  for (const c of channels) for (let i = 0; i < n; i++) mono[i] += c[i] * g;
  if (srIn === srOut) return mono;
  // Windowed-sinc filter, one set of weights per fractional position.
  const gcd = (a, b) => (b ? gcd(b, a % b) : a), d = gcd(srIn, srOut), up = srOut / d, down = srIn / d;
  const taps = Math.ceil(16 * Math.max(1, down / up)), cut = 0.92 / Math.max(1, down / up), width = 2 * taps;
  const weights = new Float32Array(up * width);
  for (let phase = 0; phase < up; phase++) {
    for (let j = 0; j < width; j++) {
      const t = phase / up - (j - taps + 1), x = t * cut;
      const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      weights[phase * width + j] = cut * sinc * (0.5 + 0.5 * Math.cos((Math.PI * t) / (taps + 1)));
    }
  }
  const out = new Float32Array(Math.round((n * up) / down));
  for (let i = 0; i < out.length; i++) {
    const at = i * down, base = Math.floor(at / up), w = (at % up) * width, first = base - taps + 1;
    let s = 0;
    for (let j = Math.max(0, -first), z = Math.min(width, n - first); j < z; j++) s += mono[first + j] * weights[w + j];
    out[i] = s;
  }
  return out;
}

// `padded` holds `pad` extra samples on each side so the official can slide without a re-render.
export function nudged(padded, pad, samples, length) {
  return padded.map((c) => c.subarray(pad - samples, pad - samples + length));
}
export function fileName(name, ext) {
  return `${name.replace(/\.[^.]+$/, '')}_official-audio.${ext}`;
}

/* ---------- Public: times ---------- */
export function parseTime(text) {
  const m = /^\s*([-−])?(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(String(text));
  if (!m) return null;
  return (m[1] ? -1 : 1) * ((m[2] ? Number(m[2]) * 60 : 0) + Number(m[3]));
}
export function formatTime(s) {
  const ms = Math.round(Math.abs(s) * 1000);
  return `${s < 0 && ms ? '−' : ''}${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
