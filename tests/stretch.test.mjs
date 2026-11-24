import test from 'node:test';
import assert from 'node:assert/strict';
import { stretch } from '../cc-audio-replacer/stretch.js';

const SR = 48000;
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: got ${a}, wanted ${b} ± ${tol}`);
const tone = (hz, seconds) => new Float32Array(seconds * SR).map((_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / SR));
function frequency(x, from, to) {
  let first = -1, last = -1, n = 0;
  for (let i = from * SR; i < to * SR; i++) if (x[i] <= 0 && x[i + 1] > 0) { const p = i - x[i] / (x[i + 1] - x[i]); if (first < 0) first = p; else n++; last = p; }
  return (n * SR) / (last - first);
}
// Short bursts; returns the energy centre of each one found near the expected time.
const bursts = (times, seconds) => { const x = new Float32Array(seconds * SR); for (const t of times) for (let i = 0; i < 240; i++) x[Math.round(t * SR) + i - 120] = Math.sin(i * 0.6) * Math.sin((Math.PI * i) / 240); return x; };
function centre(x, t) {
  let s = 0, e = 0;
  for (let i = Math.round((t - 0.1) * SR); i < (t + 0.1) * SR; i++) { const v = (x[i] || 0) ** 2; s += v * i; e += v; }
  return s / e / SR;
}

test('stretch returns the requested length', async () => {
  const [l, r] = await stretch([tone(440, 4), tone(440, 4)], SR, { start: 0.5, ratio: 1.01, length: 96001 });
  assert.equal(l.length, 96001); assert.equal(r.length, 96001);
});
test('stretch keeps the pitch when speeding up', async () => {
  const [l] = await stretch([tone(440, 8), tone(440, 8)], SR, { start: 1, ratio: 1.06, length: 5 * SR });
  near(frequency(l, 1, 4), 440, 0.5, 'Hz');
});
test('stretch keeps the pitch when slowing down', async () => {
  const [l] = await stretch([tone(440, 8), tone(440, 8)], SR, { start: 1, ratio: 0.94, length: 5 * SR });
  near(frequency(l, 1, 4), 440, 0.5, 'Hz');
});
for (const ratio of [0.94, 1.00968, 1.05]) {
  test(`stretch puts every hit on time at ratio ${ratio}`, async () => {
    const at = [0.4, 2, 5, 9, 14, 18], x = bursts(at.map((t) => 10 + t * ratio), 32);
    const [l] = await stretch([x, x], SR, { start: 10, ratio, length: 20 * SR });
    for (const t of at) near(centre(l, t) * 1000, t * 1000, 4, 'hit (ms)');
  });
}
test('stretch starts without a fade-in', async () => {
  const [l] = await stretch([tone(440, 8), tone(440, 8)], SR, { start: 2, ratio: 1.01, length: 3 * SR });
  let e = 0; for (let i = 0; i < 2400; i++) e += l[i] ** 2;
  near(Math.sqrt(e / 2400), 0.5 * Math.SQRT1_2, 0.06, 'first 50 ms');
});
test('stretch is silent before the song begins', async () => {
  const [l] = await stretch([tone(440, 8), tone(440, 8)], SR, { start: -2, ratio: 1.01, length: 4 * SR });
  let m = 0; for (let i = 0; i < 1.8 * SR; i++) m = Math.max(m, Math.abs(l[i]));
  assert.ok(m < 0.02, `peak ${m}`);
});
test('stretch copies the samples untouched at ratio 1', async () => {
  const x = tone(440, 4);
  const [l] = await stretch([x, x], SR, { start: 1, ratio: 1, length: SR });
  assert.deepEqual(l, x.slice(SR, 2 * SR));
});
test('stretch accepts a mono song', async () => {
  const out = await stretch([tone(440, 4)], SR, { start: 0, ratio: 1.02, length: SR });
  assert.equal(out.length, 2);
});
test('stretch keeps left and right separate', async () => {
  const [l, r] = await stretch([tone(440, 6), new Float32Array(6 * SR)], SR, { start: 0.5, ratio: 1.02, length: 4 * SR });
  const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak(l) > 0.4); assert.ok(peak(r) < 0.01);
});

test('stretch is never louder than the peaks of a limited master', async () => {
  // Kicks clipped by about 3 dB, as on a loud club master: the kind whose peaks overshoot when the tempo changes.
  const x = new Float32Array(10 * SR);
  for (let i = 0; i < x.length; i++) { const p = (i / SR) % 0.476, k = 1.3 * Math.sin(2 * Math.PI * (48 * p + 4 * (1 - Math.exp(-p * 28)))) * Math.exp(-p * 8); x[i] = Math.max(-0.97, Math.min(0.97, k + 0.3 * Math.sin(2 * Math.PI * 110 * i / SR) + 0.15 * Math.sin(2 * Math.PI * 1234 * i / SR))); }
  const [l] = await stretch([x, x], SR, { start: 0.5, ratio: 1.0158, length: 8 * SR });
  const peak = (y) => y.reduce((m, v) => Math.max(m, Math.abs(v)), 0), rms = (y) => Math.sqrt(y.reduce((q, v) => q + v * v, 0) / y.length);
  assert.ok(peak(l) <= 0.9701, `peak ${peak(l)}`);
  near(20 * Math.log10(rms(l) / rms(x.subarray(SR / 2, 8.6 * SR))), 0, 0.7, 'loudness change (dB)');
});
