import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBpm, findMatches, refineAt, snapRatio, coverage, mixFinal, parseTime, formatTime, loudnessGain, downmix, nudged, fileName, firstBeat, limit } from '../cc-audio-replacer/engine.js';
import { makeSong, play, room, concat, rng } from './helpers.mjs';

const SR = 11025;
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: got ${a}, wanted ${b} ± ${tol}`);
// Where the official song sits at the start and end of the video, versus the truth, in ms.
function assertInSync(m, start, ratio, seconds, tolMs = 8) {
  near(m.start * 1000, start * 1000, tolMs, 'start (ms)');
  near((m.start + m.ratio * seconds) * 1000, (start + ratio * seconds) * 1000, tolMs, 'end (ms)');
}

const song = makeSong({ seconds: 180, bpm: 124, seed: 3 });

test('detectBpm finds the tempo of a clean track', () => {
  near(detectBpm(song, SR).bpm, 124, 0.15, 'bpm');
});
test('detectBpm finds the tempo of a 45 s club recording', () => {
  near(detectBpm(room(play(song, SR, 60, 1.02, 45), SR), SR).bpm, 124 * 1.02, 0.5, 'bpm');
});

test('findMatches locates a faster DJ recording', () => {
  const live = room(play(song, SR, 72.34, 1.00968, 45.48), SR);
  const [best] = findMatches(live, song, SR);
  assertInSync(best, 72.34, 1.00968, 45.48);
  assert.ok(best.confident, 'should be confident');
});
test('findMatches locates a slower DJ recording', () => {
  const live = room(play(song, SR, 101.7, 0.94, 30), SR);
  assertInSync(findMatches(live, song, SR)[0], 101.7, 0.94, 30);
});
test('findMatches handles a short 15 s clip', () => {
  const live = room(play(song, SR, 33.21, 1.031, 15), SR);
  assertInSync(findMatches(live, song, SR)[0], 33.21, 1.031, 15);
});
test('findMatches survives loud crowd noise', () => {
  const live = room(play(song, SR, 50.05, 1.0123, 40), SR, { crowd: 0.22 });
  assertInSync(findMatches(live, song, SR)[0], 50.05, 1.0123, 40, 12);
});
test('findMatches leaves the tempo alone when it is the same', () => {
  const live = room(play(song, SR, 72.34, 1, 45), SR);
  const [best] = findMatches(live, song, SR);
  assert.equal(best.ratio, 1);
  near(best.start, 72.34, 0.008, 'start');
});
test('findMatches returns no confident match for a different song', () => {
  const other = makeSong({ seconds: 60, bpm: 126, seed: 77 });
  const m = findMatches(room(other, SR).subarray(0, 40 * SR), song, SR);
  assert.ok(!m.length || !m[0].confident, `false match with score ${m[0]?.score}`);
});
test('findMatches returns no confident match for a different song at the same tempo', () => {
  const other = makeSong({ seconds: 60, bpm: 124, seed: 78 });
  const m = findMatches(room(other, SR).subarray(0, 40 * SR), song, SR);
  assert.ok(!m.length || !m[0].confident, `false match with score ${m[0]?.score}`);
});
test('findMatches lists the other places a repeating song fits', () => {
  const loop = makeSong({ seconds: 180, bpm: 124, seed: 9, unique: false });
  const block = 64 * (60 / 124);
  const live = room(play(loop, SR, 40, 1.01, 25), SR);
  const starts = findMatches(live, loop, SR).map((m) => m.start);
  assert.ok(starts.length >= 3, `found ${starts.length}`);
  for (const s of starts.slice(0, 3)) near(((s - 40 + 10 * block) % block + block / 2) % block - block / 2, 0, 0.02, 'repeat offset');
});
test('findMatches works when the video starts before the song does', () => {
  const r = rng(4), talk = new Float32Array(6 * SR).map(() => (r() * 2 - 1) * 0.05);
  const live = concat(talk, room(play(song, SR, 0, 1.01, 30), SR));
  assertInSync(findMatches(live, song, SR)[0], -6 * 1.01, 1.01, 36);
});

test('match reports where another track plays before the song', () => {
  const other = makeSong({ seconds: 30, bpm: 124 * 1.01, seed: 50 });
  const live = room(concat(other.subarray(0, 12 * SR), play(song, SR, 60, 1.01, 30)), SR);
  const [m] = findMatches(live, song, SR);
  assertInSync(m, 60 - 12 * 1.01, 1.01, 42);
  near(m.from, 12, 2.5, 'official from');
  assert.equal(m.to, 42);
});
test('match reports where another track plays after the song', () => {
  const other = makeSong({ seconds: 30, bpm: 124 * 1.01, seed: 51 });
  const live = room(concat(play(song, SR, 60, 1.01, 30), other.subarray(0, 12 * SR)), SR);
  const [m] = findMatches(live, song, SR);
  assert.equal(m.from, 0);
  near(m.to, 30, 2.5, 'official to');
});
test('match uses the whole video when the song plays throughout', () => {
  const [m] = findMatches(room(play(song, SR, 72.34, 1.00968, 45.48), SR), song, SR);
  assert.equal(m.from, 0);
  near(m.to, 45.48, 0.001, 'to');
});
test('match drift is small for a steady recording', () => {
  const [m] = findMatches(room(play(song, SR, 72.34, 1.00968, 45.48), SR), song, SR);
  assert.ok(m.driftMs < 10, `drift ${m.driftMs}`);
});

test('refineAt locks on from a rough manual start', () => {
  const live = room(play(song, SR, 72.34, 1.00968, 45.48), SR);
  assertInSync(refineAt(live, song, SR, 72.2), 72.34, 1.00968, 45.48);
});

test('snapRatio keeps the original when drift would be inaudible', () => {
  assert.equal(snapRatio(1.00005, 45), 1);
});
test('snapRatio keeps a real tempo change', () => {
  assert.equal(snapRatio(1.0097, 45), 1.0097);
});
test('coverage spans the whole video when the song is long enough', () => {
  assert.deepEqual(coverage(10, 1, 100, 45), { from: 0, to: 45 });
});
test('coverage starts late when the video begins before the song', () => {
  assert.deepEqual(coverage(-6, 1, 100, 45), { from: 6, to: 45 });
});
test('coverage ends early when the song runs out', () => {
  assert.deepEqual(coverage(80, 2, 100, 45), { from: 0, to: 10 });
});

const ch = (v, n) => [new Float32Array(n).fill(v), new Float32Array(n).fill(v)];
test('mixFinal is exactly the official audio when nothing else is needed', () => {
  const r = rng(1), off = [0, 1].map(() => new Float32Array(1000).map(() => r() * 2 - 1));
  const out = mixFinal({ official: off, live: ch(0.5, 1000), sr: 1000, from: 0, to: 1, fade: 0.5, level: 0, liveGain: 1 });
  assert.deepEqual(out, off);
});
test('mixFinal adds live audio at the chosen level', () => {
  const [l] = mixFinal({ official: ch(0.4, 100), live: ch(0.5, 100), sr: 100, from: 0, to: 1, fade: 0.1, level: 0.2, liveGain: 1 });
  near(l[50], 0.5, 1e-6, 'mix');
});
test('mixFinal plays only live audio outside the song', () => {
  const [l] = mixFinal({ official: ch(0.4, 1000), live: ch(0.1, 1000), sr: 100, from: 4, to: 8, fade: 0.5, level: 0, liveGain: 2 });
  near(l[0], 0.2, 1e-6, 'before'); near(l[600], 0.4, 1e-6, 'inside'); near(l[999], 0.2, 1e-6, 'after');
});
test('mixFinal crossfades inside the song', () => {
  const [l] = mixFinal({ official: ch(1, 1000), live: ch(0, 1000), sr: 100, from: 4, to: 10, fade: 0.5, level: 0, liveGain: 1 });
  assert.equal(l[399], 0);
  near(l[425], Math.SQRT1_2, 0.03, 'half way');
  assert.equal(l[450], 1);
});
test('mixFinal never clips', () => {
  const [l] = mixFinal({ official: ch(0.9, 100), live: ch(0.9, 100), sr: 100, from: 0, to: 1, fade: 0.1, level: 0.5, liveGain: 1 });
  assert.ok(Math.max(...l) <= 1);
});
test('mixFinal fades the mixed-in level smoothly into a full-live gap', () => {
  const [l] = mixFinal({ official: ch(0, 1000), live: ch(0.5, 1000), sr: 100, from: 4, to: 10, fade: 0.5, level: 0.2, liveGain: 1 });
  near(l[390], 0.5, 1e-6, 'gap'); near(l[500], 0.1, 1e-6, 'inside');
});

test('loudnessGain matches quiet live audio to the official', () => {
  near(loudnessGain(ch(0.4, 1000), ch(0.2, 1000), 0, 1000), 2, 1e-6, 'gain');
});
test('loudnessGain is limited to 12 dB', () => {
  near(loudnessGain(ch(0.9, 1000), ch(0.001, 1000), 0, 1000), 10 ** (12 / 20), 1e-6, 'gain');
});
test('downmix averages channels and drops the sample rate', () => {
  const n = 48000, tone = new Float32Array(n).map((_, i) => Math.sin((2 * Math.PI * 200 * i) / 48000));
  const out = downmix([tone, tone], 48000, SR);
  assert.equal(out.length, SR);
  near(out[2000], Math.sin((2 * Math.PI * 200 * 2000) / SR), 0.02, 'sample');
});
test('downmix removes what the lower rate cannot hold', () => {
  const tone = new Float32Array(48000).map((_, i) => Math.sin((2 * Math.PI * 9000 * i) / 48000));
  const out = downmix([tone], 48000, SR);
  assert.ok(Math.max(...out.subarray(500, 10500)) < 0.05);
});

test('parseTime reads minutes, seconds and milliseconds', () => { near(parseTime('1:12.340'), 72.34, 1e-9, 't'); });
test('parseTime reads plain seconds', () => { assert.equal(parseTime('72.5'), 72.5); });
test('parseTime reads a negative time', () => { near(parseTime('-0:06.5'), -6.5, 1e-9, 't'); });
test('parseTime rejects text', () => { assert.equal(parseTime('abc'), null); });
test('formatTime writes milliseconds', () => { assert.equal(formatTime(72.34), '1:12.340'); });
test('formatTime writes negative times', () => { assert.equal(formatTime(-6.5), '−0:06.500'); });
test('parseTime reads back what formatTime writes', () => { near(parseTime(formatTime(-6.5)), -6.5, 1e-9, 't'); });

test('match is confident even when the crowd drowns the music', () => {
  const live = room(play(song, SR, 100, 0.98, 60), SR, { crowd: 0.3 });
  const [m] = findMatches(live, song, SR);
  assertInSync(m, 100, 0.98, 60, 12);
  assert.ok(m.confident, `strength ${m.strength} score ${m.score}`);
});
test('match is confident when half the video is another track', () => {
  const other = makeSong({ seconds: 40, bpm: 124 * 1.01, seed: 52 });
  const live = room(concat(play(song, SR, 60, 1.01, 25), other.subarray(0, 25 * SR)), SR);
  const [m] = findMatches(live, song, SR);
  near(m.to, 25, 2.5, 'official to');
  assert.ok(m.confident, `strength ${m.strength} score ${m.score}`);
});
test('match keeps the whole video in heavy crowd noise', () => {
  const long = makeSong({ seconds: 300, bpm: 124, seed: 3 });
  const [m] = findMatches(room(play(long, SR, 200, 0.98, 60), SR, { crowd: 0.3 }), long, SR);
  assert.equal(m.from, 0);
  near(m.to, 60, 0.001, 'to');
});

test('downmix is fast enough for a full song', () => {
  const t = Date.now();
  downmix([new Float32Array(48000 * 360), new Float32Array(48000 * 360)], 48000, SR);
  assert.ok(Date.now() - t < 4000, `${Date.now() - t} ms for 6 minutes`);
});
test('nudged plays the official later for a positive nudge', () => {
  const padded = [Float32Array.from({ length: 30 }, (_, i) => i)];
  assert.deepEqual([...nudged(padded, 10, 3, 5)[0]], [7, 8, 9, 10, 11]);
});
test('nudged plays the official earlier for a negative nudge', () => {
  const padded = [Float32Array.from({ length: 30 }, (_, i) => i)];
  assert.deepEqual([...nudged(padded, 10, -3, 5)[0]], [13, 14, 15, 16, 17]);
});
test('fileName adds a suffix and the right extension', () => {
  assert.equal(fileName('Rooftop set.final.MOV', 'mp4'), 'Rooftop set.final_official-audio.mp4');
});

test('firstBeat finds where the beats fall', () => {
  const B = 60 / 124, at = firstBeat(song, SR, 124, 60.1, 100);
  const off = ((at / B) % 1 + 1) % 1;
  assert.ok(Math.min(off, 1 - off) * B < 0.012, `off by ${Math.min(off, 1 - off) * B} s`);
  assert.ok(at >= 60.1 && at < 60.1 + B);
});
test('match brings the official in exactly where the song starts', () => {
  const r = rng(4), talk = new Float32Array(6 * SR).map(() => (r() * 2 - 1) * 0.02);
  const quiet = Float32Array.from(song, (v, i) => (i < 2 * SR ? v * 0.02 : v));
  const [m] = findMatches(concat(talk, room(play(quiet, SR, 0, 1, 30), SR)), quiet, SR);
  near(m.from, 6, 0.02, 'official from');
});
test('findMatches prefers the section that explains the whole video over a better-fitting half', () => {
  // The same 32-bar drop comes twice. The video shows a quieter breakdown running into the second one.
  const drop = makeSong({ seconds: 60, bpm: 126, seed: 21 }), beat = 60 / 126;
  const bars = (x, n) => x.subarray(0, Math.round(n * 4 * beat * SR));
  const part = (seed, gain) => makeSong({ seconds: 60, bpm: 126, seed }).map((v) => v * gain);
  const long = concat(bars(part(22, 1), 16), bars(drop, 16), bars(part(23, 0.4), 16), bars(drop, 16), bars(part(24, 1), 16));
  const at = 48 * 4 * beat - 14;
  // The first half of the recording is noisier, as crowds are in a breakdown.
  const clean = play(long, SR, at, 1.0158, 27.44), r = rng(8);
  const live = room(clean, SR).map((v, i) => v + (i < 13.5 * SR ? (r() * 2 - 1) * 0.12 : 0));
  const ms = findMatches(live, long, SR);
  assertInSync(ms[0], at, 1.0158, 27.44, 10);
  assert.equal(ms[0].from, 0);
});

const rms = (x, a = 0, z = x.length) => { let s = 0; for (let i = a; i < z; i++) s += x[i] * x[i]; return Math.sqrt(s / (z - a)); };
const peakOf = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
// A tone at 0.6 with a 3 ms spike to 1.6 every half second, like kicks overshooting.
const spiky = () => { const x = new Float32Array(48000 * 4); for (let i = 0; i < x.length; i++) x[i] = (i % 24000 < 144 && i >= 24000 ? 1.6 : 0.6) * Math.sin((2 * Math.PI * 1000 * i) / 48000); return x; };
test('limit never passes the ceiling', () => {
  const [l] = limit([spiky()], 0.98, 48000);
  assert.ok(peakOf(l) <= 0.98 + 1e-6, `peak ${peakOf(l)}`);
});
test('limit leaves audio below the ceiling untouched', () => {
  const x = spiky().map((v) => v * 0.5);
  assert.deepEqual(limit([x], 0.98, 48000)[0], x);
});
test('limit leaves the sound between peaks at full level', () => {
  const x = spiky(), [l] = limit([x], 0.98, 48000);
  near(rms(l, 36000, 46000) / rms(x, 36000, 46000), 1, 0.01, 'level between peaks');
});
test('limit moves both channels together', () => {
  const x = spiky(), quiet = new Float32Array(x.length).fill(0.2);
  const [l, r] = limit([x, quiet], 0.98, 48000);
  const i = 24000 + 60;
  near(r[i] / 0.2, (1.35 * 0.98) / 1.6, 0.03, 'right channel gain at a left peak');
  assert.ok(Math.abs(l[i]) <= 0.98 + 1e-6);
});
test('mixFinal does not turn the whole video down for a few peaks', () => {
  const x = spiky(), zero = new Float32Array(x.length);
  const [l] = mixFinal({ official: [x, x], live: [zero, zero], sr: 48000, from: 0, to: 4, fade: 0.5, level: 0, liveGain: 1 });
  assert.ok(peakOf(l) <= 1);
  near(20 * Math.log10(rms(l) / rms(x)), 0, 0.5, 'loudness change (dB)');
});

test('limit keeps the loudness of kicks that overshoot', () => {
  const x = spiky().map((v, i) => (i % 24000 < 144 ? v * 0.8 : v)), [l] = limit([x], 0.98, 48000);
  for (let k = 1; k < 8; k++) near(20 * Math.log10(rms(l, k * 24000, k * 24000 + 144) / rms(x, k * 24000, k * 24000 + 144)), 0, 1.5, 'kick level (dB)');
});
