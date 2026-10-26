/**
 * QwenWave — Pitch correction / vocal tuning.
 *
 * Pipeline (all offline, non-destructive — the original take is never touched):
 *   1. YIN-based f0 detection per frame
 *   2. voiced/unvoiced segmentation + median filtering → "notes"
 *   3. optional scale quantisation (snap every note to project key/scale)
 *   4. granular PSOLA-style re-synthesis: every grain is read at
 *      rate = targetFreq/detectedFreq with a raised-cosine window, so pitch
 *      changes WITHOUT changing timing and without phasey artefacts
 *   5. optional formant shift + vibrato flattening
 *
 * The result is returned as a new AudioBuffer which the DAW stores as a
 * library sample ("…_tuned") and swaps into the clip — original stays intact.
 */
import Store, { clamp, midiToHz, hzToMidi, noteName, snapToScale } from '../core/store.js';
import Engine from './engine.js';

const DEF = {
  frameSize: 1024, hop: 256, grainSize: 2048, grainHop: 512,
  minYin: 60, maxYin: 800, threshold: 0.14,
};

/* ---------------------------------------------------------------- YIN pitch */
export function detectPitch(frame, sampleRate, minF = 60, maxF = 800, threshold = 0.14) {
  const N = frame.length;
  const half = Math.floor(N / 2);
  const tauMin = Math.max(2, Math.floor(sampleRate / maxF));
  const tauMax = Math.min(half - 1, Math.floor(sampleRate / minF));
  if (tauMax <= tauMin) return null;

  // difference function
  const d = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < half; i++) {
      const diff = frame[i] - frame[i + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }
  // cumulative mean normalised difference
  const cmnd = new Float64Array(tauMax + 1);
  cmnd[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    run += d[tau];
    cmnd[tau] = run > 0 ? d[tau] * tau / run : 1;
  }
  // absolute threshold
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t; break;
    }
  }
  if (tau < 0) {
    let best = 1e9;
    for (let t = tauMin; t <= tauMax; t++) if (cmnd[t] < best) { best = cmnd[t]; tau = t; }
    if (best > 0.5) return null;             // unvoiced
  }
  if (tau <= tauMin) return null;
  // parabolic interpolation
  const x1 = cmnd[tau - 1], x2 = cmnd[tau], x3 = cmnd[tau + 1] ?? x2;
  const denom = (x1 + x3 - 2 * x2);
  const delta = denom !== 0 ? 0.5 * (x1 - x3) / denom : 0;
  const t0 = tau + clamp(delta, -1, 1);
  const f0 = sampleRate / t0;
  if (f0 < minF || f0 > maxF) return null;
  const clarity = clamp(1 - cmnd[tau], 0, 1);
  return { f0, clarity };
}

/** Analyse a whole buffer → array of frames {t, f0, midi, clarity, rms, voiced}. */
export function analysePitch(buffer, opts = {}) {
  const o = { ...DEF };
  for (const k in opts) if (opts[k] !== undefined) o[k] = opts[k];
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const frames = [];
  const half = Math.floor(o.frameSize / 2);
  const win = new Float64Array(o.frameSize);
  for (let pos = 0; pos + o.frameSize < data.length; pos += o.hop) {
    let rms = 0;
    for (let i = 0; i < o.frameSize; i++) { const v = data[pos + i]; rms += v * v; }
    rms = Math.sqrt(rms / o.frameSize);
    if (rms < (opts.rmsGate ?? 0.004)) {
      frames.push({ t: pos / sr, f0: 0, midi: 0, clarity: 0, rms, voiced: false });
      continue;
    }
    // pre-emphasis helps consonant/vowel separation
    win[0] = data[pos];
    for (let i = 1; i < o.frameSize; i++) win[i] = data[pos + i] - 0.5 * data[pos + i - 1];
    const r = detectPitch(win, sr, o.minYin, o.maxYin, o.threshold);
    if (r) {
      frames.push({ t: pos / sr, f0: r.f0, midi: hzToMidi(r.f0), clarity: r.clarity, rms, voiced: true });
    } else {
      frames.push({ t: pos / sr, f0: 0, midi: 0, clarity: 0, rms, voiced: false });
    }
  }
  return frames;
}

function median(arr) {
  const a = arr.filter(v => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Smooth a pitch track: median filter + light moving average (removes jitter). */
export function smoothPitchTrack(frames, medWin = 5, avgWin = 3) {
  const out = frames.map(f => ({ ...f }));
  const mid = Math.floor(medWin / 2);
  for (let i = 0; i < out.length; i++) {
    if (!out[i].voiced) continue;
    const win = [];
    for (let j = i - mid; j <= i + mid; j++) {
      const f = frames[j];
      if (f && f.voiced) win.push(f.midi);
    }
    out[i].midiSmooth = median(win);
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i].midiSmooth === undefined) { out[i].midiSmooth = out[i].midi; continue; }
    let s = 0, n = 0;
    for (let j = i - avgWin; j <= i + avgWin; j++) {
      const v = out[j]?.midiSmooth;
      if (Number.isFinite(v) && v > 0) { s += v; n++; }
    }
    if (n) out[i].midiFinal = s / n; else out[i].midiFinal = out[i].midiSmooth;
  }
  return out;
}

/** Group voiced frames into notes [{startSample, endSample, midi, targetMidi}]. */
export function segmentNotes(frames, buffer, opts = {}) {
  const sr = buffer.sampleRate;
  const hop = opts.hop || DEF.hop;
  const tol = opts.noteTolerance ?? 0.75;      // semitones
  const minLen = opts.minNoteFrames ?? 4;
  const smooth = smoothPitchTrack(frames);
  const notes = [];
  let cur = null;
  for (let i = 0; i < smooth.length; i++) {
    const f = smooth[i];
    if (!f.voiced || !(f.midiFinal > 0)) {
      if (cur && i - cur.i0 >= minLen) notes.push(closeNote(cur, i, sr, hop));
      cur = null; continue;
    }
    if (!cur) cur = { i0: i, pitches: [], };
    else if (Math.abs(f.midiFinal - median(cur.pitches)) > tol) {
      if (i - cur.i0 >= minLen) notes.push(closeNote(cur, i, sr, hop));
      cur = { i0: i, pitches: [] };
    }
    cur.pitches.push(f.midiFinal);
    cur.i1 = i;
  }
  if (cur && cur.i1 - cur.i0 >= minLen) notes.push(closeNote(cur, smooth.length, sr, hop));
  return notes;

  function closeNote(c, endIdx, sr, hop) {
    const m = median(c.pitches);
    return {
      startSample: c.i0 * hop,
      endSample: Math.min(buffer.length, endIdx * hop),
      startFrame: c.i0, endFrame: endIdx,
      midi: m,
      midiRounded: Math.round(m),
      frames: c.pitches.length,
    };
  }
}

/** Convert detected notes into MIDI clip notes (melody extraction). */
export function notesToMidi(notes, buffer, startBeat = 0) {
  const sr = buffer.sampleRate;
  const spb = 60 / Store.project.bpm;
  const q = Store.project.quantize || 1 / 16;
  return notes.map((n, i) => {
    const durSec = (n.endSample - n.startSample) / sr;
    const startBeatRel = (n.startSample / sr) / spb;
    return {
      id: `det_${i}`,
      start: Math.round(startBeatRel / q) * q,
      length: Math.max(q, Math.round((durSec / spb) / q) * q),
      midi: clamp(Math.round(n.midi), 12, 120),
      velocity: 0.8,
      detected: true,
    };
  });
}

/* ------------------------------------------------------------ correction */
/**
 * Render a pitch-corrected version of `buffer`.
 * @param {AudioBuffer} buffer
 * @param {object} opts {scale, root, strength, quantize, flattenVibrato, formantShift, minNoteFrames}
 * @returns {Promise<{buffer:AudioBuffer, notes:Array, correctionCents:number}>}
 */
export async function correctPitch(buffer, opts = {}) {
  const o = {
    scale: Store.project.key?.scale || 'minor',
    root: Store.project.key?.root || 0,
    strength: 1,
    quantize: true,
    flattenVibrato: 0,
    formantShift: 0,
    ...opts,
  };
  const sr = buffer.sampleRate;
  const frames = analysePitch(buffer, { hop: opts.hop });
  const notes = segmentNotes(frames, buffer, { minNoteFrames: opts.minNoteFrames });
  const smooth = smoothPitchTrack(frames);

  // build per-frame target MIDI
  const hop = DEF.hop;
  const nFrames = Math.ceil(buffer.length / hop) + 4;
  const target = new Float64Array(nFrames);
  const centsTotal = [];
  for (let i = 0; i < nFrames; i++) {
    const f = smooth[i];
    if (!f || !f.voiced || !(f.midiFinal > 0)) { target[i] = NaN; continue; }
    let tm = f.midiFinal;
    // find the note this frame belongs to
    const note = notes.find(n => i >= n.startFrame && i < n.endFrame);
    if (note) {
      let base = note.midi;
      if (o.quantize) base = snapToScale(note.midiRounded, o.root, o.scale);
      const dev = f.midiFinal - note.midi;
      const vib = o.flattenVibrato ? dev * (1 - o.flattenVibrato) : dev;
      tm = base + vib;
      centsTotal.push((tm - f.midiFinal) * 100);
    }
    target[i] = f.midiFinal + (tm - f.midiFinal) * clamp(o.strength, 0, 1);
  }

  // granular re-synthesis with per-grain pitch ratio (plain DSP on typed
  // arrays — no OfflineAudioContext needed, so this never blocks the graph)
  const out = (Engine.ctx || { createBuffer: makeBufferShim })
    .createBuffer(buffer.numberOfChannels, buffer.length, sr);
  const grain = o.grainSize || DEF.grainSize;
  const gHop = o.grainHop || DEF.grainHop;
  const window = new Float64Array(grain);
  for (let i = 0; i < grain; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grain - 1));

  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const outs = [];
  for (let c = 0; c < out.numberOfChannels; c++) outs.push(out.getChannelData(c));

  for (let pos = 0; pos + grain < buffer.length; pos += gHop) {
    const frameIdx = Math.floor(pos / hop);
    let tm = target[frameIdx];
    if (!Number.isFinite(tm)) {
      // unvoiced: copy through unchanged
      for (let c = 0; c < chans.length; c++) {
        const src = chans[c], dst = outs[c];
        for (let i = 0; i < grain; i++) dst[pos + i] += src[pos + i] * window[i];
      }
      continue;
    }
    const srcMidi = smooth[frameIdx]?.midiFinal ?? tm;
    const shift = (tm - srcMidi) + o.formantShift * 0.35;
    const rate = Math.pow(2, clamp(shift, -24, 24) / 12);
    // read pointer walks `rate`× faster/slower than the write pointer → pitch
    // change at constant duration. Centre-anchored to keep alignment.
    const centre = pos + grain / 2;
    for (let c = 0; c < chans.length; c++) {
      const src = chans[c], dst = outs[c];
      for (let i = 0; i < grain; i++) {
        const rp = centre + (i - grain / 2) * rate;
        const i0 = Math.floor(rp);
        if (i0 < 0 || i0 + 1 >= src.length) continue;
        const fr = rp - i0;
        const v = src[i0] * (1 - fr) + src[i0 + 1] * fr;
        dst[pos + i] += v * window[i];
      }
    }
  }
  // normalise window overlap sum (≈1.0 for 75% overlap; correct anyway)
  const norm = 1 / overlapSum(grain, gHop);
  for (let c = 0; c < outs.length; c++) for (let i = 0; i < outs[c].length; i++) outs[c][i] *= norm;

  // safety: prevent any sample exceeding full scale after overlap-add
  let peak = 0;
  for (const d of outs) for (let i = 0; i < d.length; i += 7) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
  if (peak > 0.999) {
    const g = 0.999 / peak;
    for (const d of outs) for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  const avgCents = centsTotal.length ? centsTotal.reduce((a, b) => a + b, 0) / centsTotal.length : 0;
  return { buffer: out, notes, frames: smooth, correctionCents: avgCents, maxCents: centsTotal.length ? Math.max(...centsTotal.map(Math.abs)) : 0 };
}

function overlapSum(grain, hop) {
  let s = 0;
  for (let i = 0; i < grain; i++) {
    let v = 0;
    for (let k = -2; k <= 2; k++) {
      const p = i + k * hop;
      if (p >= 0 && p < grain) v += 0.5 - 0.5 * Math.cos((2 * Math.PI * p) / (grain - 1));
    }
    s = Math.max(s, v);
  }
  return Math.max(0.5, s);
}

/* --------------------------------------------------- simple time-stretch */
/** WSOLA-lite time stretch (keeps pitch, changes duration). */
export function timeStretch(buffer, factor, opts = {}) {
  const grain = opts.grain || 2048, hop = opts.hop || 512;
  const sr = buffer.sampleRate;
  const outLen = Math.floor(buffer.length * factor);
  const out = makeBuffer(buffer.numberOfChannels, outLen, sr);
  const win = new Float64Array(grain);
  for (let i = 0; i < grain; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grain - 1));
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c), dst = out.getChannelData(c);
    for (let op = 0; op + grain < outLen; op += hop) {
      const centre = op / factor;
      // search a small window for the best correlation match (WSOLA)
      let bestOff = 0, bestScore = -Infinity;
      const search = Math.min(Math.floor(hop * 1.5), Math.floor(grain / 2));
      for (let off = -search; off <= search; off += 8) {
        const p = Math.floor(centre + off);
        if (p < 0 || p + grain >= src.length) continue;
        let s = 0;
        for (let i = 0; i < grain; i += 4) s += src[p + i] * win[i];
        if (s > bestScore) { bestScore = s; bestOff = off; }
      }
      const p = Math.max(0, Math.min(src.length - grain - 1, Math.floor(centre + bestOff)));
      for (let i = 0; i < grain; i++) dst[op + i] += src[p + i] * win[i];
    }
  }
  const norm = 1 / overlapSum(grain, hop);
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = clamp(d[i] * norm, -1, 1);
  }
  return out;
}

function makeBufferShim(ch, len, sr) { return makeBuffer(ch, len, sr); }

function makeBuffer(ch, len, sr) {
  const data = [];
  for (let c = 0; c < ch; c++) data.push(new Float32Array(len));
  return {
    numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr,
    getChannelData: (c) => data[c],
    __raw: data,
  };
}
