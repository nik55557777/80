/**
 * QwenWave — audio engine core.
 *
 * Owns the single AudioContext, the master bus (incl. mastering chain) and the
 * per-track node graphs. Designed for a high track count:
 *   • one worklet module load, shared convolver IRs, shared delay buffers
 *   • track graphs are built lazily and disposed on delete (no leaks)
 *   • meters come from cheap worklet taps, not one AnalyserNode per track
 *   • every parameter change uses setTargetAtTime (zipper-free, no clicks)
 */
import Store, { Bus, TOPICS, clamp, dbToGain, gainToDb, midiToHz } from '../core/store.js';
import { FX_DEFS, fxDefaults, setP } from '../effects/defs.js';
import { buildFx } from './fxbuild.js';
import { Library } from './library.js';

class EngineImpl {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.workletReady = false;
    this.workletFailed = false;
    this.graphs = new Map();        // trackId -> graph
    this.masterGraph = null;
    this.voices = new Map();        // trackId -> Set(voice)
    this._sharedConv = new Map();   // irName -> ConvolverNode
    this._irBuffers = new Map();
    this._scheduled = new Set();
    this.suspended = false;
    this._latency = 0;
    this.masterMeter = { l: 0, r: 0, rl: 0, rr: 0, clip: 0, gain: 1, peak: 0 };
    this.trackMeters = new Map();
  }

  /* ------------------------------------------------------------------ boot */
  async init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({
      latencyHint: 'interactive',
      sampleRate: 44100,
    });
    try {
      await this.ctx.audioWorklet.addModule('worklet/processors.js');
      this.workletReady = true;
    } catch (e) {
      this.workletFailed = true;
      console.warn('[engine] AudioWorklet unavailable — falling back to native nodes', e);
      Bus.emit(TOPICS.TOAST, { kind: 'warn', text: 'AudioWorklet недоступен: часть эффектов работает в упрощённом режиме (нужен HTTPS/localhost).' });
    }
    this._latency = (this.ctx.baseLatency || 0) * 1000;
    this._buildMaster();
    document.addEventListener('visibilitychange', () => this._onVisibility());
    Bus.emit(TOPICS.STATUS, { text: `Audio engine ready · ${this.ctx.sampleRate / 1000} kHz · ${this._latency.toFixed(1)} ms latency` });
    return this.ctx;
  }

  async resume() {
    await this.init();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.suspended = false;
  }

  _onVisibility() {
    // Free CPU when the tab is hidden but keep transport position.
    if (!this.ctx) return;
    if (document.hidden && !Store.playing && !Store.recording) {
      this.ctx.suspend().catch(() => {});
      this.suspended = true;
    } else if (this.suspended && !document.hidden) {
      this.ctx.resume().catch(() => {});
      this.suspended = false;
    }
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 44100; }
  get now() { return this.ctx ? this.ctx.currentTime : 0; }
  beatsToSec(b) { return (b * 60) / Store.project.bpm; }
  secToBeats(s) { return (s * Store.project.bpm) / 60; }

  /* ---------------------------------------------------------------- master */
  _buildMaster() {
    const ctx = this.ctx;
    const g = {};
    g.fxNodes = [];                                  // user master inserts
    g.input = ctx.createGain();                      // track sum lands here
    g.hp = ctx.createBiquadFilter(); g.hp.type = 'highpass'; g.hp.frequency.value = 20;
    g.preMaster = ctx.createGain();                  // user FX chain (master inserts)
    g.mbIn = ctx.createGain();
    g.mb = this._worklet('qw-multiband', { lowGain: 1, midGain: 1, highGain: 1, lowThr: .35, midThr: .3, highThr: .25, ratio: 3, xover1: 180, xover2: 2500 });
    g.img = this._worklet('qw-imager', { lowWidth: 1, midWidth: 1, highWidth: 1, lowXover: 250, highXover: 4000 });
    g.sat = this._worklet('qw-saturator', { drive: 1, mix: 0, mode: 0, post: 1 });
    g.limiter = this._worklet('qw-limiter', { ceiling: dbToGain(-0.3), threshold: 0.7, release: 0.12, makeup: 1 });
    g.out = ctx.createGain(); g.out.gain.value = 1;
    g.meter = this._worklet('qw-meter', {});
    g.analyser = ctx.createAnalyser();
    g.analyser.fftSize = 2048; g.analyser.smoothingTimeConstant = 0.75;

    // native fallbacks if worklets unavailable
    if (!g.mb) { g.mb = this._compFallback(0.3, 3); }
    if (!g.img) { g.img = ctx.createGain(); }
    if (!g.sat) { g.sat = ctx.createGain(); }
    if (!g.limiter) {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = -3; c.knee.value = 0; c.ratio.value = 20;
      c.attack.value = 0.001; c.release.value = 0.1;
      g.limiter = c;
    }

    g.input.connect(g.hp);
    g.hp.connect(g.preMaster);
    g.preMaster.connect(g.mb);
    g.mb.connect(g.img);
    g.img.connect(g.sat);
    g.sat.connect(g.limiter);
    g.limiter.connect(g.out);
    g.out.connect(ctx.destination);
    g.out.connect(g.analyser);
    if (g.meter) {
      g.out.connect(g.meter);
      g.meter.port.onmessage = (e) => {
        const d = e.data;
        if (d.t === 'meter') {
          this.masterMeter.l = d.l; this.masterMeter.r = d.r;
          this.masterMeter.rl = d.rl; this.masterMeter.rr = d.rr;
          if (d.clip) this.masterMeter.clip = 1;
        }
      };
    }
    if (g.limiter.port) {
      g.limiter.port.onmessage = (e) => { if (e.data.t === 'meter') this.masterMeter.gain = e.data.gain; };
    }
    this.masterGraph = g;
    this.rebuildMasterFx();
    this.applyMasterSettings();
    return g;
  }

  _compFallback(thr, ratio) {
    const c = this.ctx.createDynamicsCompressor();
    c.threshold.value = gainToDb(thr); c.ratio.value = ratio; c.knee.value = 6;
    c.attack.value = 0.006; c.release.value = 0.15;
    return c;
  }

  /** Build a worklet node, or return null when worklets aren't available. */
  _worklet(name, params) {
    if (!this.workletReady) return null;
    try {
      const n = new AudioWorkletNode(this.ctx, name, {
        numberOfInputs: 1, numberOfOutputs: 1,
        outputChannelCount: [2],
        parameterData: params,
      });
      return n;
    } catch (e) { console.warn('[engine] worklet create failed', name, e); return null; }
  }

  /**
   * Shared convolver per IR name — SYNCHRONOUS handle (so FX chains can be
   * built without awaiting), buffer is streamed in right after. Several reverb
   * instances using the same IR share one ConvolverNode + one decoded buffer.
   */
  getSharedConvolver(name) {
    let conv = this._sharedConv.get(name);
    if (!conv) {
      conv = this.ctx.createConvolver();
      conv.normalize = true;
      conv.__ir = name;
      this._sharedConv.set(name, conv);
      this._loadIR(name, conv);
    }
    return conv;
  }
  ensureConvolver(conv, name) {
    if (!conv) return;
    if (conv.__ir === name && conv.buffer) return;
    conv.__ir = name;
    this._loadIR(name, conv);
  }
  async _loadIR(name, conv) {
    try {
      let buf = this._irBuffers.get(name);
      if (!buf) {
        buf = await Library.getAudioBufferByName(name);
        if (!buf) {
          // synthesise a small fallback IR so the chain never breaks
          const len = Math.floor(this.ctx.sampleRate * 1.4);
          const b = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
          for (let c = 0; c < 2; c++) {
            const d = b.getChannelData(c);
            for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
          }
          buf = b;
        }
        this._irBuffers.set(name, buf);
      }
      conv.buffer = buf;
    } catch (e) { console.warn('[engine] IR load failed', name, e); }
  }

  /** Rebuild the user master-insert chain (hp → [master fx] → mastering). */
  rebuildMasterFx() {
    const g = this.masterGraph;
    if (!g) return;
    for (const f of (g.fxNodes || [])) {
      for (const n of (f.node.nodes || [])) { try { n.stop?.(); } catch {} try { n.disconnect(); } catch {} }
    }
    g.fxNodes = [];
    try { g.hp.disconnect(); } catch {}
    const list = Store.project.master.fx || [];
    let head = g.hp;
    for (const inst of list) {
      const built = buildFx(this, inst);
      if (!built) continue;
      try { head.connect(built.input); } catch {}
      g.fxNodes.push({ inst, node: built });
      head = built.output;
    }
    head.connect(g.preMaster);
  }

  updateMasterFxParams(fxId) {
    const entry = this.masterGraph?.fxNodes?.find(f => f.inst.id === fxId);
    if (entry) entry.node.update?.(entry.inst.params);
  }

  applyMasterSettings() {
    if (!this.masterGraph) return;
    const m = Store.project.master;
    const g = this.masterGraph;
    const t = this.ctx.currentTime;
    setP(g.out.gain, dbToGain(m.volumeDb), t);
    // mastering presets
    const pres = MASTERING_PRESETS[m.mastering?.preset || 'balanced'] || MASTERING_PRESETS.balanced;
    const on = !!m.mastering?.enabled;
    const amt = clamp(m.mastering?.amount ?? 0.6, 0, 1);
    const mix = (a, b) => a + (b - a) * (on ? amt : 0);
    if (g.mb.parameters) {
      setP(g.mb.parameters.lowThr, dbToGain(mix(0, pres.mbLow)), t, 0.05);
      setP(g.mb.parameters.midThr, dbToGain(mix(0, pres.mbMid)), t, 0.05);
      setP(g.mb.parameters.highThr, dbToGain(mix(0, pres.mbHigh)), t, 0.05);
      setP(g.mb.parameters.ratio, mix(1, pres.mbRatio), t, 0.05);
      setP(g.mb.parameters.lowGain, dbToGain(mix(0, pres.mbLowGain)), t, 0.05);
      setP(g.mb.parameters.midGain, dbToGain(mix(0, pres.mbMidGain)), t, 0.05);
      setP(g.mb.parameters.highGain, dbToGain(mix(0, pres.mbHighGain)), t, 0.05);
      setP(g.mb.parameters.xover1, pres.xover1, t, 0.05);
      setP(g.mb.parameters.xover2, pres.xover2, t, 0.05);
    }
    if (g.img.parameters) {
      setP(g.img.parameters.lowWidth, mix(1, pres.widthLow), t, 0.05);
      setP(g.img.parameters.midWidth, mix(1, pres.widthMid), t, 0.05);
      setP(g.img.parameters.highWidth, mix(1, pres.widthHigh), t, 0.05);
    }
    if (g.sat.parameters) {
      setP(g.sat.parameters.drive, mix(1, pres.drive), t, 0.05);
      setP(g.sat.parameters.mix, on ? amt * pres.satMix : 0, t, 0.05);
      setP(g.sat.parameters.post, dbToGain(mix(0, pres.satPost)), t, 0.05);
    }
    if (g.limiter.parameters) {
      setP(g.limiter.parameters.ceiling, dbToGain(m.limiterCeilDb), t, 0.03);
      setP(g.limiter.parameters.threshold, dbToGain(mix(-9, pres.limThr)), t, 0.05);
      setP(g.limiter.parameters.makeup, dbToGain(mix(0, pres.makeup)), t, 0.05);
      setP(g.limiter.parameters.release, pres.release, t, 0.05);
    } else {
      setP(g.limiter.threshold, mix(-6, pres.limThr), t, 0.05);
    }
  }

  /* ------------------------------------------------------- per-track graph */
  /**
   * Graph layout per track:
   *   sources → input → [monitorTap] → fxChain → pan → trim → post(FX) → out → master
   *                                                       ↘ meterTap
   *   recInput → recFxChain → monitorOut (direct, zero-latency monitoring)
   */
  getGraph(trackId) {
    if (!this.ctx) return null;
    let g = this.graphs.get(trackId);
    if (g) return g;
    g = this._buildTrackGraph(trackId);
    this.graphs.set(trackId, g);
    return g;
  }

  _buildTrackGraph(trackId) {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const pan = ctx.createStereoPanner();
    const trim = ctx.createGain();
    const out = ctx.createGain();
    const meter = this._worklet('qw-meter', {});
    input.connect(pan); pan.connect(trim); trim.connect(out);
    out.connect(this.masterGraph.input);
    if (meter) {
      out.connect(meter);
      meter.port.onmessage = (e) => {
        const d = e.data;
        if (d.t === 'meter') this.trackMeters.set(trackId, d);
      };
    }
    const g = {
      trackId, input, pan, trim, out, meter,
      fxNodes: [], fxChainIn: input, fxChainOut: pan,
      recInput: null, recChain: null, monitorGain: null,
      insertedAt: null,
    };
    // FX sit between input and pan so volume/pan/mute (trim) always apply:
    //   sources -> input -> [fx chain] -> pan -> trim -> out -> master
    this._insertFxChain(g, input, pan);
    return g;
  }

  /** Insert the track's FX chain between `from` and `to`. */
  _insertFxChain(g, from, to) {
    const ctx = this.ctx;
    // tear down old
    try { from.disconnect(); } catch {}
    for (const f of g.fxNodes) {
      try { f.node.input?.disconnect(); } catch {}
      try { f.node.output?.disconnect(); } catch {}
      try { f.node.dispose?.(); } catch {}
      for (const n of (f.node.nodes || [])) { try { n.stop?.(); } catch {} try { n.disconnect(); } catch {} }
    }
    g.fxNodes = [];
    const track = Store.track(g.trackId);
    const list = (track?.fx || []);
    let head = from;
    for (const inst of list) {
      const built = buildFx(this, inst);
      if (!built) continue;
      try { head.connect(built.input); } catch (e) { console.warn('fx connect', e); }
      g.fxNodes.push({ inst, node: built });
      head = built.output;
    }
    head.connect(to);
    g.fxChainOut = to;
    return g;
  }

  rebuildTrackFx(trackId) {
    const g = this.graphs.get(trackId);
    if (!g) return;
    this._insertFxChain(g, g.input, g.pan);
  }

  updateFxParams(trackId, fxId) {
    if (!trackId) { this.updateMasterFxParams(fxId); return; }
    const g = this.graphs.get(trackId);
    if (!g) return;
    const entry = g.fxNodes.find(f => f.inst.id === fxId);
    if (entry) entry.node.update?.(entry.inst.params);
  }

  applyTrackState(track) {
    if (!this.ctx) return;
    const g = this.getGraph(track.id);
    const t = this.ctx.currentTime;
    const solo = Store.tracks.some(x => x.solo);
    const audible = !track.muted && (!solo || track.solo);
    const target = audible && !track.frozen ? dbToGain(track.volumeDb) : 0;
    setP(g.trim.gain, target, t, 0.02);
    setP(g.pan.pan, clamp(track.pan, -1, 1), t, 0.02);
    setP(g.out.gain, 1, t, 0.02);
    this._updateMonitor(track);
  }

  applyAllTracks() {
    for (const t of Store.tracks) this.applyTrackState(t);
  }

  disposeTrack(trackId) {
    const g = this.graphs.get(trackId);
    if (!g) return;
    for (const f of g.fxNodes) {
      for (const n of (f.node.nodes || [])) { try { n.stop?.(); } catch {} try { n.disconnect(); } catch {} }
    }
    for (const n of [g.input, g.pan, g.trim, g.out, g.meter, g.monitorGain, g.recInput]) {
      try { n?.disconnect(); } catch {}
    }
    this.graphs.delete(trackId);
    this.trackMeters.delete(trackId);
    this.stopAllVoices(trackId);
  }

  /* ----------------------------------------------------------- monitoring */
  /**
   * Live input monitoring with its OWN FX chain so the user hears themselves
   * processed, at ~0 latency, independently from playback.
   */
  enableMonitor(track, stream) {
    const ctx = this.ctx;
    const g = this.getGraph(track.id);
    if (g.recInput) { try { g.recInput.disconnect(); } catch {} }
    if (!stream) { this.disableMonitor(track); return; }
    const src = ctx.createMediaStreamSource(stream);
    const inGain = ctx.createGain();
    inGain.gain.value = clamp(track.input?.gain ?? 1, 0, 8);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = track.input?.hpz ?? 80; hp.Q.value = 0.7;
    src.connect(inGain); inGain.connect(hp);
    g.recInput = src; g.recInGain = inGain; g.recHp = hp;

    // dedicated monitored FX chain (same plugin list → same sound as the take)
    const monOut = ctx.createGain();
    monOut.gain.value = 0;
    const fakeGraph = { trackId: track.id + '#mon', fxNodes: [], input: hp, out: monOut };
    hp.disconnect();
    const chainIn = ctx.createGain();
    hp.connect(chainIn);
    this._buildMonitorChain(fakeGraph, chainIn, monOut, track);
    monOut.connect(this.masterGraph.input);
    g.monitorChain = fakeGraph;
    g.monitorOut = monOut;
    this._updateMonitor(track);
  }

  _buildMonitorChain(fakeGraph, chainIn, monOut, track) {
    let head = chainIn;
    fakeGraph.fxNodes = [];
    for (const inst of (track.fx || [])) {
      if (inst.bypassed) continue;
      const built = buildFx(this, inst);
      if (!built) continue;
      try { head.connect(built.input); } catch {}
      fakeGraph.fxNodes.push({ inst, node: built });
      head = built.output;
    }
    head.connect(monOut);
    fakeGraph.input = chainIn;
    fakeGraph.out = monOut;
  }

  rebuildMonitorFx(track) {
    const g = this.graphs.get(track.id);
    if (!g || !g.monitorChain) return;
    const chainIn = g.monitorChain.input, monOut = g.monitorOut;
    for (const f of g.monitorChain.fxNodes) {
      for (const n of (f.node.nodes || [])) { try { n.stop?.(); } catch {} try { n.disconnect(); } catch {} }
    }
    try { chainIn.disconnect(); } catch {}
    this._buildMonitorChain(g.monitorChain, chainIn, monOut, track);
    this._updateMonitor(track);
  }

  _updateMonitor(track) {
    const g = this.graphs.get(track.id);
    if (!g) return;
    const t = this.ctx.currentTime;
    const on = !!track.monitor && !!g.monitorOut;
    if (g.monitorOut) setP(g.monitorOut.gain, on ? 1 : 0, t, 0.02);
    if (g.recInGain) setP(g.recInGain.gain, clamp(track.input?.gain ?? 1, 0, 8), t, 0.02);
    if (g.recHp) setP(g.recHp.frequency, track.input?.hpz ?? 80, t, 0.02);
  }

  disableMonitor(track) {
    const g = this.graphs.get(track.id);
    if (!g) return;
    if (g.monitorOut) { try { g.monitorOut.disconnect(); } catch {} }
    for (const f of (g.monitorChain?.fxNodes || [])) {
      for (const n of (f.node.nodes || [])) { try { n.stop?.(); } catch {} try { n.disconnect(); } catch {} }
    }
    if (g.recInput) { try { g.recInput.disconnect(); } catch {} g.recInput = null; }
    g.monitorChain = null; g.monitorOut = null;
  }

  /* -------------------------------------------------------------- voices */
  stopAllVoices(trackId, when = null) {
    const set = this.voices.get(trackId);
    if (!set) return;
    for (const v of set) v.stop(when ?? this.ctx.currentTime);
    set.clear();
  }

  registerVoice(trackId, voice) {
    if (!this.voices.has(trackId)) this.voices.set(trackId, new Set());
    const set = this.voices.get(trackId);
    set.add(voice);
    // polyphony cap + oldest-voice stealing with a fast release (no clicks)
    const track = Store.track(trackId);
    const cap = clamp(track?.instrument?.polyphony ?? 16, 1, 64);
    if (set.size > cap) {
      const arr = [...set].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
      const steal = arr.slice(0, set.size - cap);
      for (const v of steal) { v.stop(this.ctx.currentTime + 0.008, true); set.delete(v); }
    }
    return () => set.delete(voice);
  }

  /* ------------------------------------------------------- master analyse */
  getSpectrum() {
    const a = this.masterGraph?.analyser;
    if (!a) return null;
    const arr = new Uint8Array(a.frequencyBinCount);
    a.getByteFrequencyData(arr);
    return arr;
  }
  getWaveform() {
    const a = this.masterGraph?.analyser;
    if (!a) return null;
    const arr = new Uint8Array(a.fftSize);
    a.getByteTimeDomainData(arr);
    return arr;
  }
}

export const MASTERING_PRESETS = {
  clean:     { name: 'Clean / Transparent', mbLow: -12, mbMid: -14, mbHigh: -16, mbRatio: 1.6, mbLowGain: 0, mbMidGain: 0, mbHighGain: 0, xover1: 200, xover2: 3000, widthLow: 0.7, widthMid: 1, widthHigh: 1.05, drive: 1, satMix: 0, satPost: 0, limThr: -8, makeup: 0, release: 0.14 },
  balanced:  { name: 'Balanced', mbLow: -16, mbMid: -18, mbHigh: -20, mbRatio: 2.4, mbLowGain: 0.5, mbMidGain: 0, mbHighGain: 0.8, xover1: 180, xover2: 2800, widthLow: 0.6, widthMid: 1.02, widthHigh: 1.15, drive: 1.6, satMix: 0.12, satPost: -1, limThr: -8, makeup: 1.5, release: 0.12 },
  loud:      { name: 'Loud / Club', mbLow: -12, mbMid: -15, mbHigh: -18, mbRatio: 4.0, mbLowGain: 1.5, mbMidGain: 0.5, mbHighGain: 1.5, xover1: 150, xover2: 2500, widthLow: 0.45, widthMid: 1.05, widthHigh: 1.3, drive: 2.4, satMix: 0.2, satPost: -1.5, limThr: -4.5, makeup: 4, release: 0.08 },
  radio:     { name: 'Radio / Streaming', mbLow: -14, mbMid: -17, mbHigh: -19, mbRatio: 2.8, mbLowGain: 0.8, mbMidGain: 0.3, mbHighGain: 1.2, xover1: 170, xover2: 3200, widthLow: 0.55, widthMid: 1.03, widthHigh: 1.18, drive: 1.8, satMix: 0.14, satPost: -1, limThr: -6, makeup: 2.5, release: 0.11 },
  warm:      { name: 'Warm / Analog', mbLow: -13, mbMid: -16, mbHigh: -22, mbRatio: 2.2, mbLowGain: 1.2, mbMidGain: 0.6, mbHighGain: -1.0, xover1: 220, xover2: 2400, widthLow: 0.7, widthMid: 1.0, widthHigh: 1.05, drive: 2.8, satMix: 0.3, satPost: -2, limThr: -7, makeup: 2, release: 0.16 },
  vocal:     { name: 'Vocal Focus', mbLow: -18, mbMid: -13, mbHigh: -17, mbRatio: 3.0, mbLowGain: -0.5, mbMidGain: 1.5, mbHighGain: 0.6, xover1: 200, xover2: 3600, widthLow: 0.5, widthMid: 1.0, widthHigh: 1.2, drive: 1.7, satMix: 0.16, satPost: -1.2, limThr: -6.5, makeup: 2.2, release: 0.12 },
};

/* --------------------------------------------------------- generic builder */
export { buildFx } from './fxbuild.js';

export const Engine = new EngineImpl();
export default Engine;
