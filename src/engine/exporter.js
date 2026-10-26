/**
 * QwenWave — Offline renderer / exporter.
 *
 * Renders the whole arrangement (audio clips + MIDI instruments + every track
 * FX chain + sends + the mastering chain) through an OfflineAudioContext, which
 * means the bounce is deterministic, runs faster than real time and is immune
 * to main-thread hiccups.
 *
 * Also: per-track stem export, WAV encoding with TPDF dither, peak/RMS/LUFS
 * measurement of the result and optional normalisation.
 */
import Store, { Bus, TOPICS, clamp, dbToGain, gainToDb, midiToHz } from '../core/store.js';
import Engine from './engine.js';
import Library from './library.js';
import Transport from './transport.js';
import Voice from './instruments.js';

const TAIL_SEC = 3.0;   // reverb/delay tails

class ExporterImpl {
  constructor() {
    this.busy = false;
    this.progress = 0;
  }

  /* -------------------------------------------------------------- full mix */
  /**
   * @param {object} opts {sampleRate, normalize, tailSec, onProgress, trackIds, includeMasterFx, dither}
   * @returns {Promise<{buffer:AudioBuffer, stats:object}>}
   */
  async render(opts = {}) {
    if (this.busy) throw new Error('Render already in progress');
    this.busy = true; this.progress = 0;
    const onProgress = opts.onProgress || ((p) => { this.progress = p; });

    const liveCtx = Engine.ctx;
    const wasPlaying = Store.playing;
    if (wasPlaying) Transport.stop();

    const project = Store.project;
    const spb = 60 / project.bpm;
    const totalBeats = Store.totalBeats;
    const duration = Math.max(1, totalBeats * spb + (opts.tailSec ?? TAIL_SEC));
    const sr = opts.sampleRate || liveCtx.sampleRate || 44100;

    onProgress(0.02);
    Bus.emit(TOPICS.STATUS, { text: `Rendering ${duration.toFixed(1)}s @ ${sr / 1000} kHz…` });

    // preload every sample the render will need so decoding can't stall it
    await Library.preloadProject(project);
    onProgress(0.12);

    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new Offline(2, Math.ceil(duration * sr), sr);

    // Load the SAME worklet DSP into the offline context so the bounce is
    // bit-identical in character to live playback (real limiter/multiband/etc.,
    // not the native fallbacks). Without this the master chain degrades.
    try {
      await off.audioWorklet.addModule('worklet/processors.js');
    } catch (e) {
      console.warn('[export] offline worklet unavailable, using native fallbacks', e);
    }

    // swap the engine onto the offline context
    const saved = {
      ctx: Engine.ctx, masterGraph: Engine.masterGraph, graphs: Engine.graphs,
      voices: Engine.voices, shared: Engine._sharedConv, irs: Engine._irBuffers,
    };
    Engine.ctx = off;
    Engine.graphs = new Map();
    Engine.voices = new Map();
    Engine._sharedConv = new Map();
    Engine._irBuffers = new Map();
    Engine._buildMaster();
    if (opts.includeMasterFx === false) {
      // bypass the mastering stage for stem bounces
      const g = Engine.masterGraph;
      try { g.sat.disconnect(); g.sat.connect(g.limiter); } catch {}
    }

    try {
      // transport timeline for offline: beat 0 === context time 0
      Transport.startBeat = 0;
      Transport.startTime = 0;
      const tForBeat = (b) => b * spb;

      const only = opts.trackIds ? new Set(opts.trackIds) : null;
      const solo = Store.tracks.some(t => t.solo);

      for (const track of project.tracks) {
        if (only && !only.has(track.id)) continue;
        if (track.frozen) continue;
        const audible = only ? true : (!track.muted && (!solo || track.solo));
        if (!audible) continue;
        Engine.getGraph(track.id);
        Engine.applyTrackState(track);
        onProgress(0.12 + 0.06 * (project.tracks.indexOf(track) / Math.max(1, project.tracks.length)));
      }
      Engine.applyMasterSettings();

      // ---- schedule audio clips
      const jobs = [];
      let idx = 0, total = 0;
      for (const track of project.tracks) {
        if (only && !only.has(track.id)) continue;
        total += track.clips.length;
      }
      for (const track of project.tracks) {
        if (only && !only.has(track.id)) continue;
        // Skip inaudible tracks entirely — scheduling a muted track still runs
        // its FX/voices, and NaN * 0 = NaN would poison the sum. Not scheduling
        // them is both correct and much cheaper.
        const aud = only ? true : (!track.muted && (!solo || track.solo));
        if (!aud) continue;
        const graph = Engine.getGraph(track.id);
        if (!graph) continue;
        for (const clip of track.clips) {
          idx++;
          onProgress(0.18 + 0.5 * (idx / Math.max(1, total)));
          if (clip.type === 'audio') jobs.push(this._scheduleClip(clip, track, graph, tForBeat));
          else if (clip.type === 'midi') this._scheduleMidiClip(clip, track, tForBeat);
        }
      }
      await Promise.all(jobs);

      onProgress(0.85);
      Bus.emit(TOPICS.STATUS, { text: 'Rendering audio graph…' });
      let rendered;
      if (off.startRendering.length === 0) rendered = await off.startRendering();
      else rendered = await new Promise((res) => off.startRendering(res));
      onProgress(0.95);

      let buffer = rendered;
      if (opts.trimTail !== false) buffer = trimTailSilence(buffer, 0.002, 0.35);
      const stats = measure(buffer);
      if (opts.normalize) {
        const target = opts.normalizeTo ?? -0.3;
        const g = dbToGain(target - stats.peakDb);
        buffer = applyGain(buffer, g);
        stats.appliedGainDb = +(20 * Math.log10(g)).toFixed(2);
        Object.assign(stats, measure(buffer));
      }
      onProgress(1);
      return { buffer, stats };
    } finally {
      // restore the live engine
      Engine.ctx = saved.ctx;
      Engine.masterGraph = saved.masterGraph;
      Engine.graphs = saved.graphs;
      Engine.voices = saved.voices;
      Engine._sharedConv = saved.shared;
      Engine._irBuffers = saved.irs;
      for (const t of Store.tracks) Engine.applyTrackState(t);
      this.busy = false;
      Bus.emit(TOPICS.STATUS, { text: 'Render complete' });
      if (wasPlaying) Transport.play();
    }
  }

  async _scheduleClip(clip, track, graph, tForBeat) {
    let buf;
    try { buf = await Library.getBuffer(clip.sampleId); }
    catch (e) { Bus.emit(TOPICS.TOAST, { kind: 'warn', text: `Missing sample in bounce: ${clip.sampleName}` }); return; }
    const off = Engine.ctx;
    const when = tForBeat(clip.start);
    const dur = clip.length * (60 / Store.project.bpm);
    let rate = clip.playbackRate ?? 1;
    if (clip.pitch) rate *= Math.pow(2, clip.pitch / 12);
    if (clip.warp && clip.warpBpm) rate *= Store.project.bpm / clip.warpBpm;
    rate = clamp(rate, 0.0625, 16);

    const src = off.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = off.createGain();
    const peak = clip.gain ?? 1;
    const fade = Math.min(clip.fade ?? 0.005, dur / 2);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + Math.max(0.002, fade));
    g.gain.setValueAtTime(peak, Math.max(when + fade, when + dur - Math.max(0.002, fade)));
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    const pan = off.createStereoPanner();
    pan.pan.value = clamp(clip.pan ?? 0, -1, 1);
    src.connect(g); g.connect(pan); pan.connect(graph.input);
    let srcOffset = (clip.offset || 0);
    if (clip.loop && buf.duration - srcOffset > 0.02) {
      src.loop = true; src.loopStart = srcOffset; src.loopEnd = buf.duration;
    }
    try { src.start(when, srcOffset); } catch (e) { return; }
    if (!src.loop) src.stop(when + dur + 0.05);
    else src.stop(when + dur + 0.05);
  }

  _scheduleMidiClip(clip, track, tForBeat) {
    for (const n of clip.notes) {
      const when = tForBeat(clip.start + n.start);
      const dur = Math.max(0.02, n.length * (60 / Store.project.bpm));
      Voice.play(track, n.midi, when, dur, n.velocity ?? 0.8);
    }
  }

  /* ----------------------------------------------------------------- stems */
  async renderStems(opts = {}) {
    const out = [];
    const tracks = Store.tracks.filter(t => !t.frozen);
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      Bus.emit(TOPICS.STATUS, { text: `Stem ${i + 1}/${tracks.length}: ${t.name}` });
      const r = await this.render({ ...opts, trackIds: [t.id], includeMasterFx: opts.includeMasterFx ?? false,
        onProgress: (p) => opts.onProgress?.((i + p) / tracks.length) });
      out.push({ track: t, buffer: r.buffer, stats: r.stats });
    }
    return out;
  }
}

/* ------------------------------------------------------------------ WAV IO */
export function encodeWav(buffer, { bits = 24, dither = true } = {}) {
  const nCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const bytesPer = bits / 8;
  const dataSize = len * nCh * bytesPer;
  const ab = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, nCh, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * nCh * bytesPer, true); dv.setUint16(32, nCh * bytesPer, true);
  dv.setUint16(34, bits, true); w(36, 'data'); dv.setUint32(40, dataSize, true);

  const chans = [];
  for (let c = 0; c < nCh; c++) chans.push(buffer.getChannelData(c));
  const scale = bits === 24 ? 8388607 : 32767;
  const ditherAmp = dither ? 1 / scale : 0;
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      let s = chans[c][i];
      if (ditherAmp) {
        // TPDF dither — removes quantisation distortion on quiet tails
        s += (Math.random() + Math.random() - 1) * ditherAmp;
      }
      s = Math.max(-1, Math.min(1, s));
      const v = Math.round(s * scale);
      if (bits === 24) {
        dv.setUint8(off++, v & 0xff);
        dv.setUint8(off++, (v >> 8) & 0xff);
        dv.setUint8(off++, (v >> 16) & 0xff);
      } else {
        dv.setInt16(off, v, true); off += 2;
      }
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/** Lightweight AudioBuffer-shaped object (no context needed → works offline). */
function makePlainBuffer(ch, len, sr) {
  const data = [];
  for (let c = 0; c < ch; c++) data.push(new Float32Array(len));
  return {
    numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr,
    getChannelData: (c) => data[c],
    copyToChannel: (src, c) => data[c].set(src.subarray(0, Math.min(len, src.length))),
    __plain: true,
  };
}

function applyGain(buffer, g) {
  const out = makePlainBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const s = buffer.getChannelData(c), d = out.getChannelData(c);
    for (let i = 0; i < s.length; i++) d[i] = clamp(s[i] * g, -1, 1);
  }
  return out;
}

function trimTailSilence(buffer, thresh = 0.002, minSec = 0.2) {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  let end = data.length;
  const keepMin = Math.floor(minSec * sr);
  for (let i = data.length - 1; i > keepMin; i--) {
    if (Math.abs(data[i]) > thresh) { end = Math.min(data.length, i + Math.floor(0.3 * sr)); break; }
  }
  if (end >= data.length) return buffer;
  const out = makePlainBuffer(buffer.numberOfChannels, end, sr);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.copyToChannel(buffer.getChannelData(c).subarray(0, end), c);
  }
  return out;
}

/* ------------------------------------------------------------- measurement */
/** Peak / RMS / true-peak / integrated LUFS (ITU-R BS.1770 K-weighting). */
export function measure(buffer) {
  const sr = buffer.sampleRate;
  const nCh = buffer.numberOfChannels;
  let peak = 0, sum = 0, n = 0;
  const chans = [];
  for (let c = 0; c < nCh; c++) { chans.push(buffer.getChannelData(c)); }
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < nCh; c++) {
      const v = chans[c][i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v; n++;
    }
  }
  // K-weighting: high-shelf (+4 dB @ 1.6 kHz) then high-pass @ 38 Hz
  const k = kWeighted(chans, sr);
  const lufs = gatedLoudness(k, sr, nCh);
  return {
    peak: +peak.toFixed(4),
    peakDb: +(20 * Math.log10(peak + 1e-12)).toFixed(2),
    truePeakDb: +(20 * Math.log10(peak + 1e-12)).toFixed(2), // 1× oversampled proxy
    rmsDb: +(20 * Math.log10(Math.sqrt(sum / Math.max(1, n)) + 1e-12)).toFixed(2),
    lufs: +lufs.toFixed(2),
    durationSec: +buffer.duration.toFixed(3),
    sampleRate: sr, channels: nCh,
  };
}

function biquadFilter(chans, sr, f0, Q, type, gainDb = 0) {
  const w0 = 2 * Math.PI * f0 / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Q), A = Math.pow(10, gainDb / 40);
  let b, a;
  if (type === 'highshelf') {
    const s2 = 2 * Math.sqrt(A) * alpha;
    b = [A * ((A + 1) + (A - 1) * cw + s2), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - s2)];
    a = [(A + 1) - (A - 1) * cw + s2, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - s2];
  } else { // highpass
    b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
    a = [1 + alpha, -2 * cw, 1 - alpha];
  }
  b = b.map(v => v / a[0]); a = a.map(v => v / a[0]);
  return chans.map(ch => {
    const out = new Float32Array(ch.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      out[i] = y;
    }
    return out;
  });
}

function kWeighted(chans, sr) {
  let x = biquadFilter(chans, sr, 1681.97, 0.7072, 'highshelf', 3.9998);
  x = biquadFilter(x, sr, 38.14, 0.5003, 'highpass');
  return x;
}

function gatedLoudness(chans, sr, nCh) {
  const block = Math.floor(0.4 * sr);
  const hop = Math.floor(0.1 * sr);
  const G = [1.0, 1.0, 1.0, 1.41, 1.41][0] || 1;
  const weights = nCh >= 2 ? [1.0, 1.0] : [1.0];
  const blocks = [];
  for (let s = 0; s + block <= chans[0].length; s += hop) {
    let sum = 0;
    for (let c = 0; c < Math.min(nCh, 2); c++) {
      let e = 0;
      const d = chans[c];
      for (let i = s; i < s + block; i++) e += d[i] * d[i];
      sum += (weights[c] || 1) * (e / block);
    }
    blocks.push(sum);
  }
  if (!blocks.length) return -Infinity;
  const abs = blocks.reduce((a, b) => a + b, 0) / blocks.length;
  if (abs <= 0) return -Infinity;
  const absGate = -0.691 + 10 * Math.log10(abs);
  const rel = blocks.filter(b => 10 * Math.log10(b + 1e-12) > absGate);
  if (!rel.length) return -Infinity;
  const mean = rel.reduce((a, b) => a + b, 0) / rel.length;
  return -0.691 + 10 * Math.log10(mean + 1e-12);
}

/* --------------------------------------------------------------- downloads */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

export function safeName(name) {
  return (name || 'QwenWave').replace(/[^\w\d\-. ]+/g, '_').trim() || 'QwenWave';
}

export const Exporter = new ExporterImpl();
export default Exporter;
