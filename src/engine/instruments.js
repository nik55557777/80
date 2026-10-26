/**
 * QwenWave — instruments (MIDI track voices).
 *
 * Two engines:
 *   • "sampler" — plays any library sample, pitch-mapped from its root key.
 *     Pitched variants are cached (LRU) so repeated notes trigger instantly.
 *   • "synth"   — built-in subtractive poly-synth (unison osc + sub, resonant
 *     filter with envelope, glide, vibrato).
 *
 * Both honour per-track polyphony with oldest-voice stealing and ALWAYS apply
 * a short release ramp, so recycled voices can never click or fight each other.
 *
 * `Voice.play()` returns a handle immediately, even for the async sampler path:
 * if note-off arrives before the sample finished loading, the voice is
 * cancelled instead of sounding late.
 */
import Store, { clamp, midiToHz } from '../core/store.js';
import Engine from './engine.js';
import Library from './library.js';

/* ------------------------------------------------------- pitched buffer cache */
const PITCH_CACHE_MAX = 90;
const _pitchCache = new Map();
const _pitchOrder = [];
let _bufSeq = 0;

function pitchBuffer(ctx, buf, semitones) {
  if (!semitones) return buf;
  if (!buf.__qwId) buf.__qwId = ++_bufSeq;
  const key = `${buf.__qwId}:${semitones.toFixed(2)}`;
  const hit = _pitchCache.get(key);
  if (hit) return hit;
  const rate = Math.pow(2, semitones / 12);
  const len = Math.max(2, Math.floor(buf.length / rate));
  const out = ctx.createBuffer(buf.numberOfChannels, len, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = buf.getChannelData(c), d = out.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const pos = i * rate, i0 = pos | 0, fr = pos - i0;
      const i1 = i0 + 1 < s.length ? i0 + 1 : i0;
      d[i] = s[i0] * (1 - fr) + s[i1] * fr;
    }
  }
  _pitchCache.set(key, out); _pitchOrder.push(key);
  while (_pitchOrder.length > PITCH_CACHE_MAX) _pitchCache.delete(_pitchOrder.shift());
  return out;
}

/* ------------------------------------------------------------------- voice */
class VoiceNode {
  constructor(track, inst) {
    this.track = track;
    this.inst = inst;
    this.nodes = [];
    this.sources = [];
    this.stopped = false;
    this.startedAt = Engine.ctx.currentTime;
    this.release = clamp(inst.release ?? 0.25, 0.006, 8);
  }
  get graphInput() {
    const g = Engine.getGraph(this.track.id);
    return g ? g.input : Engine.masterGraph.input;
  }
  envelope(when, dur, vel, peakBase) {
    const ctx = Engine.ctx;
    const inst = this.inst;
    const amp = ctx.createGain();
    const peak = clamp(peakBase * (vel ?? 0.8), 0.0008, 4);
    const a = clamp(inst.attack ?? 0.005, 0.0005, 4);
    const d = clamp(inst.decay ?? 0.25, 0.005, 10);
    const s = clamp(inst.sustain ?? 0.7, 0.001, 1);
    const r = this.release;
    const hold = when + Math.max(a + 0.002, dur);
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.exponentialRampToValueAtTime(peak, when + a);
    amp.gain.setValueAtTime(peak, hold);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * s), hold + d);
    amp.gain.exponentialRampToValueAtTime(0.0001, hold + d + r);
    this.amp = amp;
    this.nodes.push(amp);
    return { amp, peak, endAt: hold + d + r };
  }
  makeFilter(when, decay) {
    const ctx = Engine.ctx, inst = this.inst;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = clamp(inst.resonance ?? 1.0, 0.05, 24);
    const base = clamp(inst.filterHz ?? 6000, 60, 20000);
    const envAmt = clamp(inst.cutoffEnv ?? 0, -1, 1);
    const start = clamp(base + envAmt * 9000, 60, 20000);
    filter.frequency.setValueAtTime(start, when);
    if (envAmt) filter.frequency.exponentialRampToValueAtTime(Math.max(60, base), when + Math.max(0.02, decay));
    this.nodes.push(filter);
    return filter;
  }
  stop(when, force = false) {
    if (this.stopped) return;
    this.stopped = true;
    const t = Math.max(when ?? Engine.ctx.currentTime, Engine.ctx.currentTime);
    const rel = force ? 0.008 : Math.max(0.006, this.release);
    if (this.amp) {
      try {
        this.amp.gain.cancelScheduledValues(t);
        this.amp.gain.setValueAtTime(Math.max(this.amp.gain.value, 0.0002), t);
        this.amp.gain.exponentialRampToValueAtTime(0.0001, t + rel);
      } catch {}
    }
    for (const s of this.sources) { try { s.stop(t + rel + 0.03); } catch {} }
    setTimeout(() => {
      for (const n of this.nodes) { try { n.disconnect(); } catch {} }
      this._unregister?.();
    }, (rel + 0.08) * 1000);
  }
}

class SamplerVoice extends VoiceNode {
  constructor(track, buf, midi, when, dur, vel) {
    const inst = track.instrument || {};
    super(track, inst);
    const ctx = Engine.ctx;
    const root = clamp(inst.rootKey ?? 60, 0, 127);
    const pitched = pitchBuffer(ctx, buf, clamp(midi - root, -60, 60));
    const src = ctx.createBufferSource();
    src.buffer = pitched;
    src.playbackRate.value = clamp(inst.fineRate ?? 1, 0.25, 4);
    this.sources = [src];
    const { amp, endAt } = this.envelope(when, dur, vel, inst.gain ?? 0.85);
    const filter = this.makeFilter(when, inst.decay ?? 0.2);
    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(inst.panSpread ?? 0, -1, 1);
    src.connect(filter); filter.connect(amp); amp.connect(pan); pan.connect(this.graphInput);
    this.nodes.push(src, pan);
    if (inst.loop) {
      src.loop = true;
      src.loopStart = inst.loopStart ?? 0;
      src.loopEnd = inst.loopEnd ?? Math.max(0.05, pitched.duration);
    } else {
      src.stop(Math.min(endAt + 0.05, when + pitched.duration + 0.05));
    }
    src.start(when);
  }
}

class SynthVoice extends VoiceNode {
  constructor(track, midi, when, dur, vel) {
    const inst = track.instrument || {};
    super(track, inst);
    const ctx = Engine.ctx;
    const f = midiToHz(midi);
    const unison = clamp(Math.round(inst.unison ?? 1), 1, 7);
    const det = (inst.detune ?? 7) / 100;
    const wave = inst.waveform || 'saw';
    const { amp, peak, endAt } = this.envelope(when, dur, vel, (inst.gain ?? 0.5) / Math.sqrt(unison));
    const filter = this.makeFilter(when, inst.decay ?? 0.25);
    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(inst.panSpread ?? 0, -1, 1);
    filter.connect(amp); amp.connect(pan); pan.connect(this.graphInput);
    this.nodes.push(pan);

    const glide = clamp(inst.glide ?? 0, 0, 1) * 0.12;
    for (let i = 0; i < unison; i++) {
      const osc = ctx.createOscillator();
      osc.type = wave;
      const spread = unison === 1 ? 0 : (i - (unison - 1) / 2);
      if (glide > 0) {
        osc.frequency.setValueAtTime(Math.max(20, f * (1 - glide)), when);
        osc.frequency.exponentialRampToValueAtTime(f, when + glide);
      } else osc.frequency.setValueAtTime(f, when);
      osc.detune.setValueAtTime(spread * det * 100, when);
      const og = ctx.createGain(); og.gain.value = 1 / unison;
      osc.connect(og); og.connect(filter);
      osc.start(when); osc.stop(endAt + 0.05);
      this.sources.push(osc); this.nodes.push(osc, og);
      if (i === 0) this._firstOsc = osc;
    }
    if (inst.sub !== false) {
      const sub = ctx.createOscillator(); sub.type = 'sine';
      sub.frequency.setValueAtTime(f / 2, when);
      const sg = ctx.createGain(); sg.gain.value = clamp(inst.subLevel ?? 0.35, 0, 1) * 0.6;
      sub.connect(sg); sg.connect(filter);
      sub.start(when); sub.stop(endAt + 0.05);
      this.sources.push(sub); this.nodes.push(sub, sg);
    }
    const vr = inst.vibratoRate ?? 0;
    if (vr > 0 && this._firstOsc) {
      const lfo = ctx.createOscillator(), lg = ctx.createGain();
      lfo.frequency.value = vr;
      lg.gain.setValueAtTime(0, when);
      lg.gain.linearRampToValueAtTime(inst.vibratoDepth ?? 8, when + (inst.vibratoDelay ?? 0.4));
      lfo.connect(lg);
      for (const s of this.sources) { if (s.detune) lg.connect(s.detune); }
      lfo.start(when); lfo.stop(endAt + 0.05);
      this.sources.push(lfo); this.nodes.push(lfo, lg);
    }
  }
}

/* ------------------------------------------------------------------- manager */
const active = new Map();       // `${trackId}:${midi}` -> handle
const held = new Map();         // trackId -> Set(midi) for on-screen keyboard

function register(track, midi, handle) {
  const k = `${track.id}:${midi}`;
  const prev = active.get(k);
  if (prev && prev !== handle) prev.stop(Engine.ctx.currentTime, true);
  active.set(k, handle);
  handle._unregister = () => { if (active.get(k) === handle) active.delete(k); };
}

export const Voice = {
  SamplerVoice, SynthVoice,

  /** Trigger a note. Always returns a handle with .stop(). */
  play(track, midi, when, dur, vel = 0.8) {
    if (!Engine.ctx || !track) return null;
    const inst = track.instrument || {};
    const ctx = Engine.ctx;
    const t = Math.max(when, ctx.currentTime + 0.001);
    const useSampler = inst.engine === 'sampler' && inst.sampleId;

    if (!useSampler) {
      const v = new SynthVoice(track, midi, t, dur, vel);
      v._unregister = Engine.registerVoice(track.id, v);
      const wrapped = wrap(v);
      register(track, midi, wrapped);
      return wrapped;
    }

    // async sampler path
    let cancelled = false, real = null;
    Library.getBuffer(inst.sampleId).then(buf => {
      if (cancelled) return;
      const tt = Math.max(t, ctx.currentTime + 0.004);
      try {
        real = new SamplerVoice(track, buf, midi, tt, dur, vel);
        real._unregister = Engine.registerVoice(track.id, real);
        handle.voice = real;
        if (handle.stopRequested) real.stop(ctx.currentTime, true);
      } catch (e) { console.warn('[sampler]', e); }
    }).catch(e => console.warn('[sampler] load failed', e));

    const handle = {
      voice: null, stopRequested: false,
      stop(when, force) {
        this.stopRequested = true;
        if (real) real.stop(when, force);
      },
      get startedAt() { return real?.startedAt ?? t; },
    };
    handle._unregister = () => {};
    register(track, midi, handle);
    return handle;
  },

  noteOff(track, midi) {
    const k = `${track.id}:${midi}`;
    const h = active.get(k);
    if (h) { h.stop(Engine.ctx.currentTime); active.delete(k); }
    const s = held.get(track.id); if (s) s.delete(midi);
  },
  noteOffAll(track) {
    const s = held.get(track.id);
    if (s) for (const m of s) this.noteOff(track, m);
    s?.clear();
  },
  hold(track, midi) {
    if (!held.has(track.id)) held.set(track.id, new Set());
    held.get(track.id).add(midi);
  },
  stopAll(track) {
    for (const [k, h] of [...active]) if (k.startsWith(track.id + ':')) { h.stop(Engine.ctx.currentTime, true); active.delete(k); }
    held.get(track.id)?.clear();
    Engine.stopAllVoices(track.id);
  },
  get activeCount() {
    let n = 0; for (const set of Engine.voices.values()) n += set.size; return n;
  },
};

function wrap(v) {
  return {
    voice: v, stopRequested: false,
    stop(when, force) { this.stopRequested = true; v.stop(when, force); },
    get startedAt() { return v.startedAt; },
  };
}

/* ------------------------------------------------------------------- presets */
export const SYNTH_PRESETS = {
  'Init': { engine: 'synth', waveform: 'sawtooth', unison: 1, detune: 7, filterHz: 4000, resonance: 1.0,
    attack: 0.006, decay: 0.25, sustain: 0.7, release: 0.3, cutoffEnv: 0.35, gain: 0.5, sub: true, subLevel: 0.35, polyphony: 12 },
  'Super Saw': { engine: 'synth', waveform: 'sawtooth', unison: 7, detune: 16, filterHz: 6500, resonance: 0.9,
    attack: 0.012, decay: 0.4, sustain: 0.8, release: 0.6, cutoffEnv: 0.3, gain: 0.34, sub: true, subLevel: 0.3, polyphony: 8 },
  'Warm Pad': { engine: 'synth', waveform: 'sawtooth', unison: 3, detune: 9, filterHz: 1800, resonance: 1.4,
    attack: 0.7, decay: 1.2, sustain: 0.9, release: 1.6, cutoffEnv: 0.12, gain: 0.36, sub: true, subLevel: 0.25,
    vibratoRate: 0.4, vibratoDepth: 5, vibratoDelay: 1.2, polyphony: 10 },
  'Pluck': { engine: 'synth', waveform: 'square', unison: 1, detune: 5, filterHz: 2600, resonance: 3.5,
    attack: 0.002, decay: 0.22, sustain: 0.02, release: 0.25, cutoffEnv: 0.75, gain: 0.6, sub: false, polyphony: 12 },
  'Deep Bass': { engine: 'synth', waveform: 'sawtooth', unison: 2, detune: 6, filterHz: 420, resonance: 2.2,
    attack: 0.004, decay: 0.3, sustain: 0.6, release: 0.2, cutoffEnv: 0.5, gain: 0.7, sub: true, subLevel: 0.6, polyphony: 4 },
  'Acid 303': { engine: 'synth', waveform: 'sawtooth', unison: 1, detune: 0, filterHz: 700, resonance: 12,
    attack: 0.001, decay: 0.18, sustain: 0.15, release: 0.12, cutoffEnv: 0.85, gain: 0.65, sub: false, glide: 0.08, polyphony: 1 },
  'E-Piano': { engine: 'synth', waveform: 'sine', unison: 2, detune: 4, filterHz: 3200, resonance: 0.8,
    attack: 0.004, decay: 0.9, sustain: 0.25, release: 0.7, cutoffEnv: 0.2, gain: 0.55, sub: true, subLevel: 0.2,
    vibratoRate: 4.8, vibratoDepth: 4, vibratoDelay: 0.5, polyphony: 12 },
  'Flute': { engine: 'synth', waveform: 'sine', unison: 1, detune: 3, filterHz: 5200, resonance: 0.7,
    attack: 0.06, decay: 0.15, sustain: 0.9, release: 0.3, cutoffEnv: 0.1, gain: 0.5, sub: false,
    vibratoRate: 5.4, vibratoDepth: 9, vibratoDelay: 0.3, polyphony: 6 },
  'Organ': { engine: 'synth', waveform: 'sine', unison: 3, detune: 2, filterHz: 5200, resonance: 0.6,
    attack: 0.02, decay: 0.05, sustain: 1.0, release: 0.12, cutoffEnv: 0, gain: 0.4, sub: true, subLevel: 0.5, polyphony: 10 },
};

/** Sampler presets: pick a library one-shot and map it across the keyboard. */
export const SAMPLER_PRESETS = {
  '808 Bass (mapped)': { engine: 'sampler', sampleName: '808_Bass_A1', rootKey: 33, gain: 0.95, attack: 0.003, decay: 0.4, sustain: 0.9, release: 0.2, filterHz: 9000, resonance: 0.7, polyphony: 4 },
  'Pluck Keys': { engine: 'sampler', sampleName: 'Pluck_C4', rootKey: 60, gain: 0.8, attack: 0.002, decay: 0.3, sustain: 0.2, release: 0.3, filterHz: 8000, resonance: 0.9, polyphony: 12 },
  'E-Piano Keys': { engine: 'sampler', sampleName: 'EPiano_C4', rootKey: 60, gain: 0.75, attack: 0.004, decay: 0.6, sustain: 0.4, release: 0.5, filterHz: 7000, resonance: 0.7, polyphony: 12 },
  'Bell Keys': { engine: 'sampler', sampleName: 'Bell_C5', rootKey: 72, gain: 0.7, attack: 0.002, decay: 0.8, sustain: 0.3, release: 0.6, filterHz: 12000, resonance: 0.6, polyphony: 10 },
  'Strings Pad': { engine: 'sampler', sampleName: 'Strings_G3', rootKey: 55, gain: 0.65, attack: 0.25, decay: 0.6, sustain: 0.9, release: 0.9, filterHz: 5000, resonance: 0.8, polyphony: 8, loop: false },
  'Vocal Aah': { engine: 'sampler', sampleName: 'Vowel_A_D4', rootKey: 62, gain: 0.8, attack: 0.08, decay: 0.4, sustain: 0.85, release: 0.5, filterHz: 6000, resonance: 0.7, polyphony: 8 },
};

export default Voice;
