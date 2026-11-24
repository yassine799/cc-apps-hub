// Changes the tempo of the official audio without changing its pitch.
import { limit } from './engine.js';
import SignalsmithStretch from './vendor/signalsmith-stretch.js';

// Returns stereo audio whose sample i plays the song at `start + ratio × i / sr` seconds.
export async function stretch(channels, sr, { start, ratio, length, onProgress }) {
  const src = [channels[0], channels[1] || channels[0]];
  const songLength = src[0].length;
  const out = [new Float32Array(length), new Float32Array(length)];
  if (ratio === 1) {
    const first = Math.round(start * sr);
    out.forEach((o, c) => {
      const a = Math.max(0, first), z = Math.min(songLength, first + length);
      if (z > a) o.set(src[c].subarray(a, z), a - first);
    });
    return out;
  }
  const wasm = await SignalsmithStretch();
  if (wasm._main) wasm._main();
  // 70 ms blocks: sharper hits than the library's 120 ms default, with the bass still clean.
  wasm._configure(2, Math.round(sr * 0.07), Math.round(sr * 0.0175), 0);
  wasm._reset();
  const inLatency = wasm._inputLatency(), outLatency = wasm._outputLatency();
  const size = inLatency + outLatency;
  const pointer = wasm._setBuffers(2, size);
  const view = (slot, n) => new Float32Array((wasm.exports ? wasm.exports.memory : wasm.HEAP8).buffer, pointer + slot * size * 4, n);
  // Song position that must have been read by the time output sample `e` comes out.
  const readTo = (e) => Math.round(start * sr + (e + outLatency) * ratio) + inLatency;
  const load = (from, n) => {
    for (let c = 0; c < 2; c++) {
      const buf = view(c, n);
      buf.fill(0);
      const a = Math.max(0, from), z = Math.min(songLength, from + n);
      if (z > a) buf.set(src[c].subarray(a, z), a - from);
    }
  };
  // Warm up before the first sample so it starts at full strength.
  const step = 1024, warm = Math.ceil(size / step) * step;
  let e = -warm;
  load(readTo(e) - size, size);
  wasm._seek(size, ratio);
  while (e < length) {
    const a = readTo(e), n = readTo(e + step) - a;
    load(a, n);
    wasm._process(n, step);
    for (let c = 0; c < 2; c++) {
      const got = view(2 + c, step), skip = Math.max(0, -e), keep = Math.min(step, length - e);
      if (keep > skip) out[c].set(got.subarray(skip, keep), e + skip);
    }
    e += step;
    if (onProgress && e > 0 && (e / step) % 100 === 0) onProgress(Math.min(1, e / length));
  }
  // Changing the tempo of a limited master pushes some peaks past full scale. Hold them to the master's own peak.
  let peak = 0;
  for (const c of src) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > peak) peak = v; }
  return limit(out, Math.min(1, peak || 1), sr);
}
