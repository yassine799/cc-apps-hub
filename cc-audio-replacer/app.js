import { SR, readVideo, readSong, writeVideo } from './media.js';
import { coverage, fileName, formatTime, loudnessGain, mixFinal, nudged, parseTime } from './engine.js';

const $ = (s) => document.querySelector(s);
const FADE = 0.5, PAD = SR / 2, MAX_NUDGE = 400;
const fresh = () => ({ video: null, song: null, bpm: null, matches: [], match: null, padded: null, nudge: 0, level: 0, from: 0, to: 0, liveGain: 1, listen: 'both', split: false, zoom: 'beat', fmt: 'aac', t: 0, playing: false, final: null });
let S = fresh();

/* ---------- Views ---------- */
function show(view) {
  document.body.dataset.view = view;
  for (const el of document.querySelectorAll('[data-for]')) el.hidden = !el.dataset.for.split(' ').includes(view);
  if (view !== 'review') pause();
  requestAnimationFrame(drawAll);
}
const text = (sel, v) => { $(sel).textContent = v; };
const press = (group, v) => { for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === v)); };
const problem = (sel, msg) => { const e = $(sel); e.textContent = msg || ''; e.hidden = !msg; };
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500); }
const size = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const fps = (f) => `${Number(f.toFixed(2))} fps`;
const codecName = (c) => ({ avc: 'H.264', hevc: 'HEVC', prores: 'ProRes', vp9: 'VP9', vp8: 'VP8', av1: 'AV1' })[c] || c;
const videoMeta = (v) => `${formatTime(v.duration)} · ${v.width}×${v.height} · ${fps(v.fps)} · ${size(v.file.size)}`;
const songMeta = (s) => `${formatTime(s.duration)} · ${size(s.file.size)}`;
const bpm = (v) => `${v.toFixed(1)} BPM`;

/* ---------- Adding files ---------- */
let reading = { video: 0, song: 0 };
function slot(kind, label) {
  const drop = $(`#${kind}Drop`), input = $(`#${kind}In`), row = $(`#${kind}File`), err = `#${kind}Err`;
  const title = drop.querySelector('strong').textContent;
  async function take(file) {
    if (!file) return;
    const turn = ++reading[kind];
    problem(err); drop.disabled = true; drop.querySelector('strong').textContent = `Reading ${file.name}`;
    try {
      const got = kind === 'video' ? await readVideo(file) : await readSong(file);
      if (turn !== reading[kind]) return;
      S[kind] = got;
      if (kind === 'video') loadMonitor(file);
    } catch (e) {
      if (turn === reading[kind]) problem(err, e.message);
    } finally {
      if (turn === reading[kind]) { drop.disabled = false; drop.querySelector('strong').textContent = title; input.value = ''; paint(); }
    }
  }
  function clear() { reading[kind]++; S[kind] = null; if (kind === 'video') loadMonitor(null); paint(); }
  function paint() {
    const f = S[kind];
    drop.hidden = !!f; row.hidden = !f;
    if (f) { row.querySelector('.nm').textContent = f.file.name; row.querySelector('.mt').textContent = kind === 'video' ? videoMeta(f) : songMeta(f); }
    refreshAdd();
  }
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => take(input.files[0]));
  row.querySelector('.cc-x').addEventListener('click', () => { clear(); drop.focus(); });
  drop.addEventListener('dragenter', () => drop.classList.add('is-hot'));
  drop.addEventListener('dragleave', () => drop.classList.remove('is-hot'));
  return { take, paint };
}
const slots = { video: slot('video'), song: slot('song') };
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  for (const d of document.querySelectorAll('.is-hot')) d.classList.remove('is-hot');
  if (document.body.dataset.view !== 'add') return;
  for (const f of e.dataTransfer.files) (/^audio\/|\.(wav|aiff?|flac|mp3)$/i.test(f.type || f.name) ? slots.song : slots.video).take(f);
});
function refreshAdd() {
  const { video, song } = S;
  $('#matchBtn').disabled = !(video && song);
  text('#addStatus', video && song ? 'Both files are ready to match.' : video ? 'Now add the official WAV.' : song ? 'Now add the music video.' : 'Add a music video and the official WAV to start.');
}
let monitorUrl = null;
const vid = $('#video');
function loadMonitor(file, sound) {
  if (monitorUrl) URL.revokeObjectURL(monitorUrl);
  monitorUrl = file ? URL.createObjectURL(file) : null;
  vid.hidden = !file; vid.controls = !!sound; vid.muted = !sound;
  vid.playbackRate = 1;
  $('#monitorText').hidden = !!file; text('#monitorText', 'Your video appears here.');
  if (file) vid.src = monitorUrl; else { vid.removeAttribute('src'); vid.load(); }
}
vid.addEventListener('error', () => { if (!vid.getAttribute('src')) return; vid.hidden = true; $('#monitorText').hidden = false; text('#monitorText', 'This browser can’t show the picture, but it can still replace the audio.'); });

/* ---------- Worker ---------- */
let worker = null, calls = new Map(), nextId = 0;
function call(job, data = {}, onProgress, transfer = []) {
  if (!worker) {
    worker = new Worker(new URL('worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: d }) => {
      const c = calls.get(d.id);
      if (!c) return;
      if ('progress' in d) return c.onProgress && c.onProgress(d.progress);
      calls.delete(d.id);
      if ('error' in d) c.reject(new Error(d.error)); else c.resolve(d.result);
    };
    worker.onerror = (e) => { for (const c of calls.values()) c.reject(new Error(e.message || 'The matching engine failed to load. Reload the page to try again.')); calls.clear(); };
  }
  return new Promise((resolve, reject) => { const id = nextId++; calls.set(id, { resolve, reject, onProgress }); worker.postMessage({ id, job, ...data }, transfer); });
}
function stopWorker() { if (worker) worker.terminate(); worker = null; calls.clear(); }

/* ---------- Matching ---------- */
let run = 0;
function step(i, state, detail) {
  const li = $('#steps').children[i], st = li.querySelector('.cc-st');
  li.dataset.s = state;
  st.textContent = { wait: 'Waiting', on: 'Working', done: 'Done' }[state];
  st.className = `cc-st ${state === 'done' ? 'cc-st-ok' : state === 'on' ? '' : 'cc-st-muted'}`;
  if (detail !== undefined) li.querySelector('.mt').textContent = detail;
}
function progress(sel, p) { const el = $(sel); el.setAttribute('aria-valuenow', Math.round(p * 100)); el.firstElementChild.style.width = `${p * 100}%`; }
async function startMatch() {
  const turn = ++run;
  stopWorker(); problem('#matchErr'); progress('#matchPg', 0);
  S.match = null; S.padded = null; S.matches = [];
  for (let i = 0; i < 4; i++) step(i, 'wait', '');
  show('match');
  try {
    step(0, 'on', 'Detecting BPM in both files');
    const b = await call('load', { live: S.video.live, official: S.song.channels, sr: SR });
    if (turn !== run) return;
    // Half and double tempo describe the same beat.
    while (b.liveBpm / b.officialBpm > 1.42) b.liveBpm /= 2;
    while (b.liveBpm / b.officialBpm < 0.7) b.liveBpm *= 2;
    S.bpm = { live: b.liveBpm, official: b.officialBpm };
    step(0, 'done', `Live ${bpm(b.liveBpm)} · official ${bpm(b.officialBpm)}`);
    progress('#matchPg', 0.2);
    step(1, 'on', `Searching all ${formatTime(S.song.duration)} of the song`);
    S.matches = await call('match', {}, (p) => progress('#matchPg', 0.2 + p * 0.55));
    if (turn !== run) return;
    const m = S.matches[0];
    if (!m || !m.confident) { openPick(true); return; }
    step(1, 'done', `Found at ${formatTime(m.start)} · ${matchWord(m)} match`);
    step(2, 'done', `Within ${Math.max(1, Math.round(m.driftMs))} ms from start to end`);
    drawAll();
    await useMatch(m, turn);
  } catch (e) {
    if (turn === run) problem('#matchErr', `Matching stopped: ${e.message}. Cancel and try again.`);
  }
}
const matchWord = (m) => (m.byHand ? 'set by hand' : m.confident ? (m.strength / m.score > 0.3 ? 'strong' : 'good') : 'weak');
async function useMatch(m, turn = ++run) {
  show('match');
  problem('#matchErr');
  if (!m.byHand) step(1, 'done', `Section from ${formatTime(m.start)}`); else step(1, 'done', `Set by hand at ${formatTime(m.start)}`);
  step(2, 'done', Number.isFinite(m.driftMs) ? `Within ${Math.max(1, Math.round(m.driftMs))} ms from start to end` : 'Not measured');
  step(3, 'on', m.ratio === 1 ? 'Same BPM, copying the audio untouched' : 'Matching the BPM and keeping the pitch');
  // Only the part of the song that is needed, plus a second either side.
  const length = S.video.length + 2 * PAD, start = m.start - (PAD / SR) * m.ratio;
  const a = Math.max(0, Math.floor((start - 1) * SR)), z = Math.min(S.song.channels[0].length, Math.ceil((start + (length / SR) * m.ratio + 1) * SR));
  const part = S.song.channels.map((c) => c.slice(a, Math.max(a + 1, z)));
  S.padded = await call('stretch', { channels: part, sr: SR, start: start - a / SR, ratio: m.ratio, length }, (p) => progress('#matchPg', 0.75 + p * 0.25), part.map((c) => c.buffer));
  const first = await call('beat', { bpm: S.bpm.official, from: m.start, to: m.start + m.ratio * S.video.duration });
  if (turn !== run) return;
  S.beat = (first - m.start) / m.ratio;
  S.match = m; S.nudge = 0; S.t = 0;
  S.from = m.from; S.to = m.to;
  const cov = coverage(m.start, m.ratio, S.song.duration, S.video.duration);
  S.from = Math.max(cov.from, S.from); S.to = Math.min(cov.to, S.to);
  S.liveGain = loudnessGain(official(), S.video.live, Math.round(S.from * SR), Math.round(S.to * SR));
  step(3, 'done'); progress('#matchPg', 1);
  openReview();
}
const official = () => nudged(S.padded, PAD, Math.round((S.nudge / 1000) * SR), S.video.length);

/* ---------- Choosing a section ---------- */
let picked = 0;
function openPick(unsure) {
  picked = 0;
  const n = S.matches.length;
  text('#pickTitle', unsure ? 'No clear match' : n > 1 ? `${n} sections fit this video` : 'Choose another section');
  text('#pickNote', unsure ? `The live audio doesn’t clearly match this song. Check that the files belong together, or type where the video starts.` : n > 1 ? 'The song repeats itself here. Pick the section that matches what you see on screen.' : 'Only one section fits. To use another, type where the video starts in the song.');
  $('#manual').value = ''; manualHint();
  const box = $('#rows');
  box.replaceChildren(...S.matches.map((m, i) => {
    const l = document.createElement('label'), r = document.createElement('input');
    r.type = 'radio'; r.name = 'section'; r.checked = i === 0;
    r.addEventListener('change', () => { picked = i; $('#manual').value = ''; manualHint(); drawAll(); });
    const a = document.createElement('span'), b = document.createElement('span'), c = document.createElement('span');
    a.textContent = `${formatTime(m.start)} to ${formatTime(m.start + m.ratio * S.video.duration)}`;
    b.textContent = matchWord(m).replace(/^./, (x) => x.toUpperCase());
    c.className = 'mt';
    c.textContent = `${i === 0 && n > 1 ? 'Best match · ' : ''}${m.ratio === 1 ? 'same BPM' : `${signed((m.ratio - 1) * 100)}%`}${Number.isFinite(m.driftMs) ? ` · drift ${Math.max(1, Math.round(m.driftMs))} ms` : ''}`;
    l.append(r, a, b, c);
    return l;
  }));
  $('#pickBack').textContent = S.match ? 'Back' : 'Change files';
  $('#pickUse').disabled = !n;
  show('pick');
}
const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;
function manualHint(msg) {
  const h = $('#manualHint');
  h.textContent = msg || 'Time in the official song where the video begins. The sync is refined around it.';
  h.classList.toggle('cc-hint-error', !!msg);
}
$('#manual').addEventListener('input', () => { manualHint(); $('#pickUse').disabled = !S.matches.length && !$('#manual').value.trim(); });
$('#manual').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pickUse').click(); });
$('#pickUse').addEventListener('click', async () => {
  const typed = $('#manual').value.trim();
  const turn = ++run;
  try {
    if (!typed) return await useMatch(S.matches[picked], turn);
    const at = parseTime(typed);
    if (at === null || at > S.song.duration) return manualHint('Write a time inside the song, like 1:12.340.');
    $('#pickUse').disabled = true;
    const m = await call('refine', { start: at });
    if (turn !== run) return;
    $('#pickUse').disabled = false;
    if (m && m.confident) return await useMatch(m, turn);
    const ratio = S.bpm.live / S.bpm.official;
    toast('Couldn’t lock on there. Check the sync and nudge if needed.');
    await useMatch({ start: at, ratio: Math.abs(ratio - 1) < 0.0005 ? 1 : ratio, from: 0, to: S.video.duration, driftMs: Infinity, byHand: true, confident: false, strength: 0, score: 1 }, turn);
  } catch (e) { $('#pickUse').disabled = false; manualHint(e.message); }
});

/* ---------- Sync check ---------- */
function openReview() {
  const { video: v, song: s, match: m } = S, D = v.duration;
  loadMonitor(v.file);
  text('#rvVideo', v.file.name); text('#rvVideoMeta', videoMeta(v)); text('#rvSong', s.file.name); text('#rvSongMeta', songMeta(s));
  text('#bpmSong', bpm(S.bpm.official)); text('#bpmLive', bpm(S.bpm.official * m.ratio));
  text('#bpmAdj', m.ratio === 1 ? 'None, same BPM' : `${signed((m.ratio - 1) * 100)}%, now ${bpm(S.bpm.official * m.ratio)}`);
  text('#secLen', `${formatTime(D)}, same as video`);
  text('#secMatch', `${matchWord(m).replace(/^./, (x) => x.toUpperCase())}${Number.isFinite(m.driftMs) ? ` · drift ${Math.max(1, Math.round(m.driftMs))} ms` : ''}`);
  $('#secMatch').className = m.confident && !(m.driftMs > 25) ? 'ok' : 'warn';
  $('#seek').max = D;
  press($('#listen'), S.listen); press($('#zoom'), S.zoom); press($('#fmt'), S.fmt); $('#split').checked = S.split;
  $('#level').value = Math.round(S.level * 100); text('#levelOut', `${Math.round(S.level * 100)}%`);
  fmtHint(); paintRange(); paintNudge();
  show('review');
  buildFinal(true);
  setTime(0);
}
function paintRange() {
  $('#from').value = formatTime(S.from); $('#to').value = formatTime(S.to);
  const whole = S.from === 0 && S.to >= S.video.duration - 0.001, h = $('#rangeHint');
  h.classList.remove('cc-hint-error');
  h.textContent = whole ? 'The official audio covers the whole video.' : 'Outside these times the live audio plays, with a 0.5 s crossfade.';
}
function setRange(which) {
  const v = parseTime($(`#${which}`).value), D = S.video.duration, cov = coverage(S.match.start, S.match.ratio, S.song.duration, D);
  const from = which === 'from' ? v : S.from, to = which === 'to' ? v : S.to;
  const bad = (msg) => { paintRange(); const h = $('#rangeHint'); h.textContent = msg; h.classList.add('cc-hint-error'); };
  if (v === null) return bad('Write a time in the video, like 0:12.000.');
  if (to - from < 1) return bad('Leave at least 1 second of official audio.');
  S.from = Math.max(cov.from, 0, from); S.to = Math.min(cov.to, D, to);
  paintRange();
  if (from < cov.from - 0.001 || to > cov.to + 0.001) $('#rangeHint').textContent += ' The song doesn’t reach further.';
  drawAll(); buildFinal();
}
for (const w of ['from', 'to']) {
  $(`#${w}`).addEventListener('change', () => setRange(w));
}
function paintNudge() {
  const n = S.nudge, m = S.match;
  text('#nudgeOut', `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)} ms`);
  const start = m.start - (n / 1000) * m.ratio;
  text('#secFrom', formatTime(start)); text('#secTo', formatTime(start + m.ratio * S.video.duration));
}
for (const b of document.querySelectorAll('[data-n]')) b.addEventListener('click', () => {
  const n = Number(b.dataset.n);
  S.nudge = n ? Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, S.nudge + n)) : 0;
  paintNudge(); drawAll(); setBuffers(); buildFinal();
  if (S.playing) startSources(now());
  paintTime();
});
$('#level').addEventListener('input', (e) => {
  S.level = Number(e.target.value) / 100;
  text('#levelOut', `${e.target.value}%`);
  if (S.listen !== 'final') { S.listen = 'final'; press($('#listen'), 'final'); applyGains(); drawAll(); }
  buildFinal();
});
const group = (sel, fn) => $(sel).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { press($(sel), b.dataset.v); fn(b.dataset.v); } });
group('#listen', (v) => { S.listen = v; applyGains(); drawAll(); });
group('#zoom', (v) => { S.zoom = v; drawAll(); });
group('#fmt', (v) => { S.fmt = v; fmtHint(); });
$('#split').addEventListener('change', (e) => { S.split = e.target.checked; applyGains(); });
const asMov = () => S.fmt === 'pcm' || S.video.codec === 'prores';
function fmtHint() { text('#fmtHint', `Saved as ${asMov() ? 'MOV' : 'MP4'}${S.fmt === 'pcm' ? ' with 24-bit audio' : ''}. The picture is copied, not re-encoded.`); }
$('#otherBtn').addEventListener('click', () => openPick(false));

/* ---------- Playback: everything on one audio clock, the picture follows it ---------- */
let ctx = null, nodes = null, buffers = {}, sources = [], zero = 0, raf = 0, finalTimer = 0;
function audio() {
  if (ctx) return;
  ctx = new AudioContext({ sampleRate: SR });
  nodes = {};
  for (const k of ['live', 'official', 'final']) {
    const gain = ctx.createGain(), pan = ctx.createStereoPanner();
    gain.gain.value = 0; gain.connect(pan); pan.connect(ctx.destination);
    nodes[k] = { gain, pan };
  }
}
function toBuffer(chs) { const b = new AudioBuffer({ numberOfChannels: 2, length: chs[0].length, sampleRate: SR }); chs.forEach((c, i) => b.copyToChannel(c, i)); return b; }
function setBuffers() { buffers.official = toBuffer(official()); buffers.live = buffers.live || toBuffer(S.video.live); }
function buildFinal(first) {
  clearTimeout(finalTimer);
  const go = () => {
    if (!S.padded) return;
    S.final = mixFinal({ official: official(), live: S.video.live, sr: SR, from: S.from, to: S.to, fade: FADE, level: S.level, liveGain: S.liveGain });
    buffers.final = toBuffer(S.final);
    if (first) { buffers.live = null; setBuffers(); }
    if (S.playing) startSources(now());
  };
  if (first) go(); else finalTimer = setTimeout(go, 80);
}
function applyGains() {
  if (!ctx) return;
  const both = S.listen === 'both', at = ctx.currentTime;
  const set = (p, v) => p.setTargetAtTime(v, at, 0.008);
  set(nodes.live.gain.gain, S.listen === 'live' ? S.liveGain : both ? 0.5 * S.liveGain : 0);
  set(nodes.official.gain.gain, both ? 0.5 : 0);
  set(nodes.final.gain.gain, S.listen === 'final' ? 1 : 0);
  set(nodes.live.pan.pan, both && S.split ? -1 : 0);
  set(nodes.official.pan.pan, both && S.split ? 1 : 0);
}
function stopSources() { for (const s of sources) { try { s.stop(); } catch (e) { /* not started */ } s.disconnect(); } sources = []; }
function startSources(t) {
  stopSources();
  const at = ctx.currentTime + 0.06;
  for (const k of ['live', 'official', 'final']) {
    const s = ctx.createBufferSource();
    s.buffer = buffers[k]; s.connect(nodes[k].gain); s.start(at, t);
    sources.push(s);
  }
  zero = at - t;
}
const now = () => Math.max(0, Math.min(S.video.duration, ctx.currentTime - zero));
async function playNow() {
  audio();
  await ctx.resume();
  applyGains();
  if (S.t >= S.video.duration - 0.05) S.t = 0;
  startSources(S.t);
  S.playing = true; paintPlay();
  vid.currentTime = S.t;
  vid.play().catch(() => {});
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(follow);
}
function pause() {
  if (!S.playing) return;
  S.t = now();
  S.playing = false; stopSources(); cancelAnimationFrame(raf); vid.pause(); vid.playbackRate = 1; paintPlay();
}
function follow() {
  if (!S.playing) return;
  const t = now();
  if (t >= S.video.duration - 0.01) { pause(); setTime(0); return; }
  const heard = t - (ctx.outputLatency || ctx.baseLatency || 0), off = vid.currentTime - heard;
  if (!vid.seeking && !vid.hidden && heard > 0) {
    if (Math.abs(off) > 0.2) vid.currentTime = heard;
    else vid.playbackRate = Math.abs(off) > 0.012 ? 1 - Math.max(-0.06, Math.min(0.06, off * 0.8)) : 1;
    if (vid.paused) vid.play().catch(() => {});
  }
  S.t = t; paintTime();
  raf = requestAnimationFrame(follow);
}
function setTime(t) {
  S.t = Math.max(0, Math.min(S.video.duration, t));
  if (S.playing) startSources(S.t);
  vid.currentTime = S.t;
  paintTime();
}
function paintPlay() {
  $('#play').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
  $('#play path').setAttribute('d', S.playing ? 'M4 3H7V13H4ZM9 3H12V13H9Z' : 'M5 3L13 8L5 13Z');
}
$('#play').addEventListener('click', () => (S.playing ? pause() : playNow()));
$('#seek').addEventListener('input', (e) => setTime(Number(e.target.value)));
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || document.body.dataset.view !== 'review' || (e.target !== document.body && !e.target.matches('#seek'))) return;
  e.preventDefault(); $('#play').click();
});

/* ---------- Timeline ---------- */
function win() {
  const D = S.video.duration;
  if (S.zoom === 'all') return { t0: 0, span: D };
  const span = Math.min(D, (4 * 60) / (S.bpm.official * S.match.ratio));
  const lead = S.beat - 0.06;
  return { t0: Math.max(0, Math.min(lead + Math.floor((S.t - lead) / span) * span, D - span)), span };
}
let drawn = '';
function paintTime() {
  if (!S.match) return;
  text('#time', `Video ${formatTime(S.t)} · Song ${formatTime(S.match.start + S.match.ratio * (S.t - S.nudge / 1000))}`);
  $('#seek').value = S.t;
  if (document.body.dataset.view === 'review') drawLanes();
}
function surface(canvas) {
  const r = canvas.getBoundingClientRect(), k = devicePixelRatio || 1, w = Math.round(r.width * k), h = Math.round(r.height * k);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const g = canvas.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, w, h);
  return { g, w, h, k };
}
// Peak per pixel column, remembered until the view changes.
const peakCache = new Map();
function peaks(key, data, a, z, w) {
  const id = `${key}|${a}|${z}|${w}`;
  let p = peakCache.get(id);
  if (!p) {
    p = new Float32Array(w);
    const step = (z - a) / w, skip = Math.max(1, Math.floor(step / 400));
    for (let i = 0; i < w; i++) {
      let m = 0;
      for (let j = Math.floor(a + i * step), e = Math.floor(a + (i + 1) * step); j < e; j += skip) { const v = Math.abs(data[j] || 0); if (v > m) m = v; }
      p[i] = m;
    }
    if (peakCache.size > 60) peakCache.clear();
    peakCache.set(id, p);
  }
  return p;
}
function wave(g, p, w, h, colour, gain, bar = 1) {
  g.fillStyle = colour;
  for (let i = 0; i < w; i += bar) { const v = Math.max(1, Math.min(1, p[i] * gain) * (h * 0.46)); g.fillRect(i, h / 2 - v, Math.max(1, bar - 1), 2 * v); }
}
const loudest = new WeakMap();
function scale(data) { if (!loudest.has(data)) { let m = 0; for (let i = 0; i < data.length; i += 7) { const v = Math.abs(data[i]); if (v > m) m = v; } loudest.set(data, m ? 1 / m : 1); } return loudest.get(data); }
function drawLanes() {
  const { t0, span } = win(), v = S.video, n = Math.round((S.nudge / 1000) * SR);
  for (const [lane, key, data, shift, colour] of [['#laneLive', 'live', v.live[0], 0, '#948c87'], ['#laneOff', 'off', S.padded[0], PAD - n, '#f5f2ef']]) {
    const { g, w, h, k } = surface($(`${lane} canvas`));
    const beat = 60 / (S.bpm.official * S.match.ratio), every = S.zoom === 'all' ? beat * 4 : beat;
    if ((every / span) * w > 4) { g.fillStyle = '#3a3535'; for (let b = Math.ceil((t0 - S.beat) / every); S.beat + b * every < t0 + span; b++) g.fillRect(Math.round(((S.beat + b * every - t0) / span) * w), 0, k, h); }
    const a = Math.round(t0 * SR) + shift;
    wave(g, peaks(`${key}${S.match.start}`, data, a, a + Math.round(span * SR), w), w, h, colour, scale(data));
    if (key === 'off') {
      g.fillStyle = 'rgba(13,12,12,.78)';
      const x = (t) => ((t - t0) / span) * w;
      if (S.from > t0) g.fillRect(0, 0, x(S.from), h);
      if (S.to < t0 + span) g.fillRect(x(S.to), 0, w - x(S.to), h);
    }
    g.fillStyle = '#e0141f'; g.fillRect(Math.round(((S.t - t0) / span) * w) - k, 0, 2 * k, h);
  }
  $('#laneLive').classList.toggle('off', S.listen === 'final' && S.level === 0 && S.from === 0 && S.to >= v.duration - 0.001);
  $('#laneOff').classList.toggle('off', S.listen === 'live');
  const key = `${t0}|${span}`;
  if (key !== drawn) { drawn = key; [t0, t0 + span / 2, t0 + span].forEach((t, i) => { $('#ruler').children[i].textContent = formatTime(t); }); }
}
function drawSong(canvas, regions) {
  const { g, w, h, k } = surface(canvas), data = S.song.channels[0], bar = Math.max(2, Math.round(3 * k));
  wave(g, peaks(`song${S.song.file.name}${S.song.file.lastModified}`, data, 0, data.length, Math.ceil(w / bar) * bar), w, h, '#948c87', scale(data), bar);
  for (const r of regions) {
    const x = Math.max(0, (r.start / S.song.duration) * w), e = Math.min(w, ((r.start + r.ratio * S.video.duration) / S.song.duration) * w), lw = (r.on ? 2 : 1) * k;
    g.fillStyle = r.on ? 'rgba(245,242,239,.16)' : 'rgba(245,242,239,.04)'; g.fillRect(x, 0, e - x, h);
    g.strokeStyle = r.on ? '#f5f2ef' : '#948c87'; g.lineWidth = lw; g.strokeRect(x + lw / 2, lw / 2, Math.max(2, e - x - lw), h - lw);
  }
}
function drawAll() {
  const view = document.body.dataset.view;
  if (view === 'review' && S.match) {
    drawSong($('#songSmall'), [{ ...S.match, on: true }]);
    drawLanes();
  } else if ((view === 'match' || view === 'pick') && S.song) {
    drawSong($('#songBig'), view === 'pick' ? S.matches.map((m, i) => ({ ...m, on: i === picked && !$('#manual').value.trim() })) : S.matches.slice(0, 1).filter((m) => m.confident).map((m) => ({ ...m, on: true })));
    const D = S.song.duration;
    if ($('#songRuler').dataset.d !== String(D)) { $('#songRuler').dataset.d = D; $('#songRuler').replaceChildren(...[0, 0.25, 0.5, 0.75, 1].map((f) => { const s = document.createElement('span'); s.textContent = formatTime(D * f).replace(/\.\d+$/, ''); return s; })); }
  }
}
addEventListener('resize', drawAll);
for (const lane of ['#laneLive', '#laneOff']) $(lane).addEventListener('pointerdown', (e) => {
  const r = e.currentTarget.getBoundingClientRect(), { t0, span } = win();
  setTime(t0 + ((e.clientX - r.left) / r.width) * span);
});

/* ---------- Export ---------- */
let abort = null, finished = null;
const rows = (sel, list) => $(sel).replaceChildren(...list.map(([k, v]) => { const d = document.createElement('div'), t = document.createElement('dt'), x = document.createElement('dd'); t.textContent = k; x.textContent = v; d.append(t, x); return d; }));
async function startExport() {
  pause(); clearTimeout(finalTimer);
  const { video: v, match: m } = S, pcm = S.fmt === 'pcm';
  S.final = mixFinal({ official: official(), live: v.live, sr: SR, from: S.from, to: S.to, fade: FADE, level: S.level, liveGain: S.liveGain });
  const name = fileName(v.file.name, asMov() ? 'mov' : 'mp4');
  text('#exTitle', 'Writing the video'); text('#exName', name); text('#exMeta', videoMeta(v).replace(/ · [^·]*$/, ''));
  $('#exReady').hidden = true; $('#exPg').hidden = false; progress('#exPg', 0); problem('#exErr'); $('#saveBtn').disabled = true; text('#saveBtn', asMov() ? 'Save MOV' : 'Save MP4');
  const start = m.start - (S.nudge / 1000) * m.ratio, whole = S.from === 0 && S.to >= v.duration - 0.001;
  rows('#exKept', [['Picture', `${codecName(v.codec)}, copied as is`], ['Size', `${v.width}×${v.height}`], ['Length', formatTime(v.duration)]]);
  rows('#exNew', [['From', S.song.file.name], ['Section', `${formatTime(start)} to ${formatTime(start + m.ratio * v.duration)}`], ['Tempo', m.ratio === 1 ? 'Unchanged' : `${S.bpm.official.toFixed(1)} to ${bpm(S.bpm.official * m.ratio)}`], ['Pitch', 'Original'], ['Live audio', S.level ? `${Math.round(S.level * 100)}% under the official` : whole ? 'None' : 'Only outside the song'], ['Format', pcm ? '24-bit · 48 kHz' : 'AAC 320 kbps · 48 kHz']]);
  show('export');
  abort = new AbortController();
  const mine = abort;
  finished = null;
  try {
    const out = await writeVideo(v, S.final, { uncompressed: pcm, name, signal: mine.signal, onProgress: (p) => progress('#exPg', p) });
    if (mine.signal.aborted) return;
    finished = out.file;
    rows('#exKept', [['Picture', `${codecName(v.codec)}, copied as is`], ['Frames', `${out.frames.toLocaleString('en')} copied`], ['Size', `${v.width}×${v.height}`], ['Length', formatTime(v.duration)]]);
    text('#exTitle', 'Finished video'); text('#exMeta', videoMeta(v).replace(/[^·]*$/, ` ${size(out.file.size)}`));
    $('#exPg').hidden = true; $('#exReady').hidden = false; $('#saveBtn').disabled = false;
    loadMonitor(out.file, true);
  } catch (e) {
    if (mine.signal.aborted) return;
    $('#exPg').hidden = true; text('#exTitle', 'Export stopped');
    problem('#exErr', `The video couldn’t be written: ${e.message} Go back to the sync check and try again.`);
  }
}
$('#exportBtn').addEventListener('click', startExport);
$('#saveBtn').addEventListener('click', () => {
  if (!finished) return;
  const a = document.createElement('a'), url = URL.createObjectURL(finished);
  a.href = url; a.download = finished.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast(`Saved ${finished.name}`);
});
function leaveExport() { if (abort) abort.abort(); abort = null; finished = null; vid.pause(); }
$('#exportBack').addEventListener('click', () => { leaveExport(); const t = S.t; openReview(); setTime(t); });

/* ---------- Moving around ---------- */
$('#matchBtn').addEventListener('click', startMatch);
$('#cancelMatch').addEventListener('click', () => { run++; stopWorker(); S.match = null; show('add'); });
$('#pickBack').addEventListener('click', () => { run++; if (S.match) openReview(); else show('add'); });
function reset() {
  pause(); run++; stopWorker(); leaveExport();
  S = fresh(); buffers = {}; peakCache.clear();
  loadMonitor(null); slots.video.paint(); slots.song.paint(); problem('#videoErr'); problem('#songErr');
  show('add');
}
$('#startOver').addEventListener('click', reset);
$('#another').addEventListener('click', reset);
if (typeof AudioDecoder === 'undefined' || typeof AudioEncoder === 'undefined') { const b = $('#banner'); b.hidden = false; b.textContent = 'This browser can’t read video sound here. Open the app in Chrome or Edge on a computer.'; }
