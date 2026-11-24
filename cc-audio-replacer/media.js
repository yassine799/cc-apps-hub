// Reading the files and writing the finished video. The picture is copied packet by packet, never re-encoded.
export const SR = 48000;
let mb = null;
async function lib() {
  if (!mb) mb = await import('mediabunny');
  return mb;
}

async function toRate(channels, sr, length) {
  if (sr === SR) return channels.map((c) => { if (c.length === length) return c; const o = new Float32Array(length); o.set(c.subarray(0, length)); return o; });
  const ctx = new OfflineAudioContext(channels.length, length, SR);
  const buf = ctx.createBuffer(channels.length, channels[0].length, sr);
  channels.forEach((c, i) => buf.copyToChannel(c, i));
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination); src.start();
  const out = await ctx.startRendering();
  return channels.map((_, i) => out.getChannelData(i));
}

export async function readVideo(file) {
  const M = await lib();
  let input, video, audio;
  try {
    input = new M.Input({ source: new M.BlobSource(file), formats: M.ALL_FORMATS });
    video = await input.getPrimaryVideoTrack();
    audio = await input.getPrimaryAudioTrack();
  } catch (e) { throw new Error('This file can’t be read as a video. Export it as MP4 or MOV and add it again.'); }
  if (!video) throw new Error('This file has no picture. Add the music video itself.');
  if (!audio) throw new Error('This video has no sound to match against. Add a version with its live audio.');
  const codec = await video.getCodec();
  if (!codec) throw new Error('This video’s format can’t be copied. Export it as H.264, HEVC or ProRes and add it again.');
  if (!(await audio.canDecode())) throw new Error('This browser can’t read the video’s sound. Try Chrome or Edge on a computer.');
  const duration = await video.computeDuration();
  const length = Math.round(duration * SR);
  const stats = await video.computePacketStats(200);
  const srIn = await audio.getSampleRate(), chIn = Math.min(2, await audio.getNumberOfChannels());
  // Place every block by its own timestamp, so a late or early sound track stays where it plays.
  const raw = Array.from({ length: chIn }, () => new Float32Array(Math.ceil(duration * srIn) + srIn));
  const sink = new M.AudioBufferSink(audio);
  for await (const { buffer, timestamp } of sink.buffers(0, duration)) {
    const at = Math.round(timestamp * srIn), skip = Math.max(0, -at);
    for (let c = 0; c < chIn; c++) {
      const data = buffer.getChannelData(c).subarray(skip), room = raw[c].length - (at + skip);
      if (room > 0 && data.length) raw[c].set(data.subarray(0, room), at + skip);
    }
  }
  const live = await toRate(raw, srIn, length);
  if (live.length === 1) live.push(live[0]);
  return {
    file, input, video, codec, duration, length, live,
    width: await video.getDisplayWidth(), height: await video.getDisplayHeight(),
    fps: stats.averagePacketRate,
    isMov: /\.mov$/i.test(file.name),
  };
}

export async function readSong(file) {
  let buf;
  try { buf = await new OfflineAudioContext(2, 1, SR).decodeAudioData(await file.arrayBuffer()); }
  catch (e) { throw new Error('This audio file can’t be read. Export it as a 16 or 24-bit WAV and add it again.'); }
  return {
    file, duration: buf.duration,
    channels: Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c)),
  };
}

async function aacBitrate(M) {
  const ok = (bitrate) => M.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: SR, bitrate });
  if (await ok(320000)) return 320000;
  // Browsers without their own AAC encoder use Mediabunny's.
  const ext = await import('@mediabunny/aac-encoder');
  ext.registerAacEncoder();
  if (await ok(320000)) return 320000;
  throw new Error('This browser can’t write AAC audio. Choose Uncompressed, or use Chrome on a computer.');
}

function soundBlocks(channels) {
  const total = channels[0].length, blocks = [];
  for (let at = 0; at < total; at += SR) {
    const n = Math.min(SR, total - at);
    blocks.push(() => {
      const buf = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate: SR });
      channels.forEach((c, i) => buf.copyToChannel(c.subarray(at, at + n), i));
      return buf;
    });
  }
  return blocks;
}
// AAC comes in blocks of 1024 samples, so the last one runs past the end. Encode first, then cut the
// last block's duration so the sound is exactly as long as the picture.
async function encodeAac(M, channels, signal) {
  const bitrate = await aacBitrate(M), end = channels[0].length / SR;
  const target = new M.BufferTarget(), output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: false }), target });
  const sound = new M.AudioBufferSource({ codec: 'aac', bitrate });
  output.addAudioTrack(sound);
  await output.start();
  for (const block of soundBlocks(channels)) {
    if (signal && signal.aborted) { await output.cancel(); throw new DOMException('Cancelled', 'AbortError'); }
    await sound.add(block());
  }
  await output.finalize();
  const input = new M.Input({ source: new M.BufferSource(target.buffer), formats: M.ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack(), packets = [];
  for await (const p of new M.EncodedPacketSink(track).packets()) {
    if (p.timestamp >= end - 1e-6) continue;
    packets.push(p.timestamp + p.duration > end ? p.clone({ duration: end - p.timestamp }) : p);
  }
  return { packets, meta: { decoderConfig: await track.getDecoderConfig() } };
}

// A file on disk where the browser allows it, so long videos don't have to fit in memory.
async function openTarget(M, name) {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const key of root.keys()) if (key.startsWith('audio-replacer-')) await root.removeEntry(key).catch(() => {});
    const handle = await root.getFileHandle(`audio-replacer-${Date.now()}`, { create: true });
    const writable = await handle.createWritable();
    return { target: new M.StreamTarget(writable, { chunked: true }), result: async (type) => new File([await handle.getFile()], name, { type }) };
  } catch (e) {
    const target = new M.BufferTarget();
    return { target, result: async (type) => new File([target.buffer], name, { type }) };
  }
}

export async function writeVideo(v, channels, { uncompressed, name, onProgress, signal }) {
  const M = await lib();
  const aac = uncompressed ? null : await encodeAac(M, channels, signal);
  const mov = uncompressed || v.codec === 'prores';
  const { target, result } = await openTarget(M, name);
  const output = new M.Output({ format: mov ? new M.MovOutputFormat({ fastStart: false }) : new M.Mp4OutputFormat({ fastStart: false }), target });
  try {
    const picture = new M.EncodedVideoPacketSource(v.codec);
    output.addVideoTrack(picture, { transformationMatrix: await v.video.getTransformationMatrix(), languageCode: await v.video.getLanguageCode() });
    const sound = aac ? new M.EncodedAudioPacketSource('aac') : new M.AudioBufferSource({ codec: 'pcm-s24' });
    output.addAudioTrack(sound);
    await output.start();
    const meta = { decoderConfig: await v.video.getDecoderConfig() };
    const blocks = aac ? aac.packets : soundBlocks(channels);
    let frames = 0, next = 0;
    const addSound = async (until) => {
      for (; next < blocks.length && (aac ? blocks[next].timestamp : next) < until; next++) {
        if (aac) await sound.add(blocks[next], next === 0 ? aac.meta : undefined); else await sound.add(blocks[next]());
      }
    };
    for await (const packet of new M.EncodedPacketSink(v.video).packets()) {
      if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      await picture.add(packet, frames === 0 ? meta : undefined);
      frames++;
      await addSound(packet.timestamp + 1);
      if (onProgress && frames % 25 === 0) onProgress(Math.min(1, packet.timestamp / v.duration));
    }
    picture.close();
    await addSound(Infinity);
    sound.close();
    await output.finalize();
    return { file: await result(mov ? 'video/quicktime' : 'video/mp4'), frames, mov };
  } catch (e) {
    if (output.state !== 'finalized') await output.cancel().catch(() => {});
    throw e;
  }
}
