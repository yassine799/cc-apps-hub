// Heavy work off the main thread: matching and tempo change.
import { downmix, detectBpm, findMatches, firstBeat, refineAt } from './engine.js';
import { stretch } from './stretch.js';

const SR = 11025;
let live, official;

const jobs = {
  load(d) {
    live = downmix(d.live, d.sr, SR);
    official = downmix(d.official, d.sr, SR);
    return { liveBpm: detectBpm(live, SR).bpm, officialBpm: detectBpm(official, SR).bpm };
  },
  match(d, progress) { return findMatches(live, official, SR, progress); },
  refine(d) { return refineAt(live, official, SR, d.start); },
  beat(d) { return firstBeat(official, SR, d.bpm, Math.max(0, d.from), d.to); },
  async stretch(d, progress) { return stretch(d.channels, d.sr, { ...d, onProgress: progress }); },
};

onmessage = async ({ data }) => {
  const { id, job } = data;
  try {
    const result = await jobs[job](data, (p) => postMessage({ id, progress: p }));
    postMessage({ id, result }, job === 'stretch' ? result.map((c) => c.buffer) : []);
  } catch (e) {
    postMessage({ id, error: String((e && e.message) || e) });
  }
};
