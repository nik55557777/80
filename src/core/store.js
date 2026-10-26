/**
 * QwenWave — central store: project state, pub/sub bus, undo/redo history.
 * All UI modules subscribe to granular topics so a change re-renders only
 * what it needs (key part of the "no freeze at 60 tracks" requirement).
 */

export const TOPICS = {
  PROJECT: 'project', TRACKS: 'tracks', TRANSPORT: 'transport', SELECTION: 'selection',
  MIXER: 'mixer', LIBRARY: 'library', PIANOROLL: 'pianoroll', FX: 'fx', PLUGINS: 'plugins',
  METERS: 'meters', RECORD: 'record', TEMPO: 'tempo', TOAST: 'toast', STATUS: 'status',
  MASTER: 'master', VIEW: 'view',
};

const listeners = new Map();
export const Bus = {
  on(topic, fn) {
    if (!listeners.has(topic)) listeners.set(topic, new Set());
    listeners.get(topic).add(fn);
    return () => listeners.get(topic)?.delete(fn);
  },
  emit(topic, payload) {
    const set = listeners.get(topic);
    if (set) for (const fn of set) { try { fn(payload); } catch (e) { console.error('[bus]', topic, e); } }
  },
};

let _id = 0;
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}_${(_id++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dbToGain = (db) => (db <= -144 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g) => (g <= 1e-7 ? -144 : 20 * Math.log10(g));
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const hzToMidi = (f) => 69 + 12 * Math.log2(Math.max(f, 1e-6) / 440);
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (m) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11], melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  pentMajor: [0, 2, 4, 7, 9], pentMinor: [0, 3, 5, 7, 10], blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/** Snap a MIDI note to the nearest scale degree of `root`. */
export function snapToScale(midi, root = 0, scale = 'minor') {
  const set = SCALES[scale] || SCALES.minor;
  let best = midi, bestD = 1e9;
  for (const oct of [-1, 0, 1]) for (const d of set) {
    const cand = root + ((d + oct * 12 + 120) % 12) + 12 * Math.floor((midi - root) / 12) + oct * 12;
    const dist = Math.abs(cand - midi);
    if (dist < bestD) { bestD = dist; best = cand; }
  }
  return best;
}

export const DEFAULT_FX = () => [];

/* ------------------------------------------------------------------ factories */
export function makeTrack(partial = {}) {
  return {
    id: uid('trk'),
    name: 'Track',
    type: 'audio',            // 'audio' | 'midi' | 'bus' | 'master'
    color: '#4aa3ff',
    muted: false, solo: false, armed: false, monitor: false,
    volumeDb: 0, pan: 0,
    width: 100,
    fx: [],                   // [{id,type,params:{},bypassed,name}]
    sends: [],                // [{busId, amountDb}]
    clips: [],
    automation: [],           // [{param, points:[[time,value]]}]
    frozen: false,
    // midi/instrument specific
    instrument: { engine: 'sampler', sampleId: null, rootKey: 60, gain: 0.8, attack: 0.004,
      decay: 0.2, sustain: 0.7, release: 0.25, filterHz: 12000, resonance: 0.8,
      unison: 1, detune: 7, waveform: 'saw', cutoffEnv: 0, polyphony: 12,
      mode: 'oneshot', loop: false, glide: 0 },
    // audio specific
    input: { deviceId: null, gain: 1, hpz: 80, noiseGate: false, gateThreshold: -50 },
    pitchCorrection: { enabled: false, scale: 'minor', root: 0, strength: 1, quantize: true },
    panMode: 'stereo',
    ...partial,
  };
}

export function makeAudioClip(partial = {}) {
  return {
    id: uid('clip'), type: 'audio',
    trackId: null, start: 0, length: 4,
    sampleId: null, sampleName: '',
    offset: 0, playbackRate: 1, pitch: 0,      // pitch = semitones (recalculates rate)
    gain: 1, fade: 0.005, loop: false,
    reversed: false, warp: true, warpBpm: null,
    color: null,
    ...partial,
  };
}

export function makeMidiClip(partial = {}) {
  return {
    id: uid('clip'), type: 'midi',
    trackId: null, start: 0, length: 4,
    notes: [],            // {id, start(beats rel clip), length(beats), midi, velocity(0..1)}
    automation: {},       // {param: [[t,v],...]}
    color: null,
    ...partial,
  };
}

export function makeFxInstance(type, params = {}) {
  return { id: uid('fx'), type, params: { ...params }, bypassed: false, name: null };
}

export function defaultProject(name = 'Untitled Project') {
  return {
    version: 3,
    name,
    bpm: 120,
    timeSignature: [4, 4],
    key: { root: 0, scale: 'minor' },
    length: 32,                 // bars
    swing: 0,
    quantize: 1 / 4,            // 1/16
    created: Date.now(),
    modified: Date.now(),
    tracks: [],
    buses: [],
    master: {
      volumeDb: 0, fx: [], limiterCeilDb: -0.3,
      mastering: { enabled: false, preset: 'balanced', amount: 0.6 },
    },
    metronome: { enabled: false, volume: 0.5, countIn: 0 },
    view: { pxPerBeat: 60, snap: 1 / 4, follow: true },
    selection: { trackId: null, clipId: null },
  };
}

/* ------------------------------------------------------------------ store */
class StoreImpl {
  constructor() {
    this.project = defaultProject();
    this.playing = false;
    this.recording = false;
    this.position = 0;          // beats
    this.loopEnabled = false;
    this.loopStart = 0;
    this.loopEnd = 8;
    this.metronomeOn = false;
    this.monitorOn = false;
    this.cpu = 0;
    this.latencyMs = 0;
    this.dirty = false;
    this._history = [];
    this._future = [];
    this._historyEnabled = true;
    this._lastSnapshotAt = 0;
  }

  /* ---- history (snapshot based, coalesced) ---- */
  snapshot() {
    return JSON.stringify({ t: this.project.tracks, b: this.project.bpm, m: this.project.master,
      ts: this.project.timeSignature, len: this.project.length, sw: this.project.swing,
      q: this.project.quantize, k: this.project.key, sel: this.project.selection });
  }
  restore(snap) {
    const o = JSON.parse(snap);
    this.project.tracks = o.t; this.project.bpm = o.b; this.project.master = o.m;
    this.project.timeSignature = o.ts; this.project.length = o.len; this.project.swing = o.sw;
    this.project.quantize = o.q; this.project.key = o.k; this.project.selection = o.sel;
  }
  /** Call BEFORE a mutation to record undo state. */
  pushHistory(label = 'edit', coalesceMs = 0) {
    if (!this._historyEnabled) return;
    const now = performance.now();
    if (coalesceMs && now - this._lastSnapshotAt < coalesceMs && this._history.length) {
      this._lastSnapshotAt = now;
      return;
    }
    this._lastSnapshotAt = now;
    this._history.push({ label, snap: this.snapshot() });
    if (this._history.length > 80) this._history.shift();
    this._future.length = 0;
  }
  undo() {
    const h = this._history.pop();
    if (!h) return false;
    this._future.push({ label: h.label, snap: this.snapshot() });
    this._historyEnabled = false; this.restore(h.snap); this._historyEnabled = true;
    Bus.emit(TOPICS.PROJECT, { reason: 'undo' });
    Bus.emit(TOPICS.TRACKS, { reason: 'undo' });
    Bus.emit(TOPICS.MIXER, { reason: 'undo' });
    return true;
  }
  redo() {
    const f = this._future.pop();
    if (!f) return false;
    this._history.push({ label: f.label, snap: this.snapshot() });
    this._historyEnabled = false; this.restore(f.snap); this._historyEnabled = true;
    Bus.emit(TOPICS.PROJECT, { reason: 'redo' });
    Bus.emit(TOPICS.TRACKS, { reason: 'redo' });
    Bus.emit(TOPICS.MIXER, { reason: 'redo' });
    return true;
  }
  get canUndo() { return this._history.length > 0; }
  get canRedo() { return this._future.length > 0; }
  clearHistory() { this._history.length = 0; this._future.length = 0; }

  /* ---- accessors ---- */
  get tracks() { return this.project.tracks; }
  track(id) { return this.project.tracks.find(t => t.id === id) || null; }
  trackIndex(id) { return this.project.tracks.findIndex(t => t.id === id); }
  clip(id) {
    for (const t of this.project.tracks) {
      const c = t.clips.find(c => c.id === id);
      if (c) return c;
    }
    return null;
  }
  clipTrack(id) { return this.project.tracks.find(t => t.clips.some(c => c.id === id)) || null; }
  get selectedTrack() { return this.track(this.project.selection.trackId); }
  get selectedClip() { return this.project.selection.clipId ? this.clip(this.project.selection.clipId) : null; }

  addTrack(track) {
    this.pushHistory('add track');
    this.project.tracks.push(track);
    this.project.selection.trackId = track.id;
    Bus.emit(TOPICS.TRACKS, { added: track.id });
    Bus.emit(TOPICS.SELECTION, {});
    return track;
  }
  removeTrack(id) {
    const i = this.trackIndex(id);
    if (i < 0) return;
    this.pushHistory('remove track');
    this.project.tracks.splice(i, 1);
    if (this.project.selection.trackId === id) this.project.selection.trackId = null;
    if (this.project.selection.clipId && !this.clip(this.project.selection.clipId)) this.project.selection.clipId = null;
    Bus.emit(TOPICS.TRACKS, { removed: id });
    Bus.emit(TOPICS.SELECTION, {});
  }
  moveTrack(id, dir) {
    const i = this.trackIndex(id); const j = i + dir;
    if (i < 0 || j < 0 || j >= this.project.tracks.length) return;
    this.pushHistory('move track');
    const [t] = this.project.tracks.splice(i, 1);
    this.project.tracks.splice(j, 0, t);
    Bus.emit(TOPICS.TRACKS, { moved: id });
  }

  /* ---- timing helpers ---- */
  get beatsPerBar() { return this.project.timeSignature[0] * (4 / this.project.timeSignature[1]); }
  beatsToSeconds(b) { return (b * 60) / this.project.bpm; }
  secondsToBeats(s) { return (s * this.project.bpm) / 60; }
  get totalBeats() {
    let end = this.project.length * this.beatsPerBar;
    for (const t of this.project.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.length);
    return end;
  }
  get durationSec() { return this.beatsToSeconds(this.totalBeats) + 2.5; }
}

export const Store = new StoreImpl();
export default Store;
