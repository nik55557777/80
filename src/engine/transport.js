/**
 * QwenWave — Transport & scheduler.
 *
 * Classic look-ahead scheduling: a 20 ms timer walks the arrangement and
 * creates AudioBufferSourceNodes / synth voices a few hundred ms in advance,
 * all timestamped with AudioContext time → sample-accurate, drift-free, and
 * unaffected by main-thread jank (the browser can be busy drawing 60 tracks
 * and the audio stays locked).
 *
 * Long clips are scheduled in CHUNKS so a 4-minute recording doesn't allocate
 * one giant node graph, and so tempo/loop changes take effect quickly.
 */
import Store, { Bus, TOPICS, clamp, dbToGain, midiToHz } from '../core/store.js';
import Engine from './engine.js';
import Library from './library.js';
import { Voice } from './instruments.js';

const LOOKAHEAD_MS = 22;
const SCHEDULE_AHEAD = 0.18;     // seconds of audio scheduled ahead
const CHUNK_BEATS = 16;          // long clips are scheduled 16 beats at a time

class TransportImpl {
  constructor() {
    this.timer = null;
    this.startTime = 0;          // ctx time of `startBeat`
    this.startBeat = 0;
    this.queue = [];             // upcoming events {beat, kind, ...}
    this.scheduled = new Map();  // audio: clipId->nextChunkBeat ; midi: noteKey->true
    this.activeSources = [];
    this.metroGain = null;
    this.metroScheduled = new Set();
    this._metronomeBuffers = null;
    this.recording = false;
    this.countInBeats = 0;
    this.onPlay = null;
    this._rafPending = false;
  }

  /* ------------------------------------------------------------ timing */
  get ctx() { return Engine.ctx; }
  get playing() { return Store.playing; }
  get position() { return Store.position; }

  ctxTimeForBeat(beat) {
    return this.startTime + ((beat - this.startBeat) * 60) / Store.project.bpm;
  }
  beatForCtxTime(t) {
    return this.startBeat + ((t - this.startTime) * Store.project.bpm) / 60;
  }
  beatsToSec(b) { return (b * 60) / Store.project.bpm; }

  /* ------------------------------------------------------------ control */
  async play(fromBeat = null) {
    await Engine.resume();
    const ctx = Engine.ctx;
    this.stopSources(true);
    this.queue.length = 0; this.scheduled.clear(); this.metroScheduled.clear();
    if (fromBeat !== null && fromBeat !== undefined) this.seek(fromBeat);
    this.startTime = ctx.currentTime + 0.06;
    this.startBeat = Store.position;
    Store.playing = true;
    // count-in for recording
    if (this.recording && Store.project.metronome.countIn > 0) {
      this.countInBeats = Store.project.metronome.countIn * Store.beatsPerBar;
      this.startTime += this.beatsToSec(this.countInBeats);
    } else this.countInBeats = 0;
    this._buildQueue();
    this._startTimer();
    Bus.emit(TOPICS.TRANSPORT, { playing: true });
    this.onPlay?.();
  }

  stop() {
    Store.playing = false;
    this._stopTimer();
    this.stopSources(false);
    this.queue.length = 0; this.scheduled.clear(); this.metroScheduled.clear();
    Bus.emit(TOPICS.TRANSPORT, { playing: false });
  }

  async toggle() { Store.playing ? this.stop() : await this.play(); }

  seek(beat) {
    const b = Math.max(0, beat);
    Store.position = b;
    if (Store.playing) {
      this.stopSources(true);
      this.queue.length = 0; this.scheduled.clear(); this.metroScheduled.clear();
      this.startTime = this.ctx.currentTime + 0.02;
      this.startBeat = b;
      this._buildQueue();
    }
    Bus.emit(TOPICS.TRANSPORT, { position: b });
  }

  /** Tempo change while playing — re-anchor the timeline so no jump occurs. */
  setBpm(bpm) {
    const b = clamp(bpm, 20, 400);
    if (Store.playing && this.ctx) {
      const cur = this.beatForCtxTime(this.ctx.currentTime);
      this.startBeat = cur;
      this.startTime = this.ctx.currentTime;
      Store.position = cur;
    }
    Store.project.bpm = b;
    if (Store.playing) { this.queue.length = 0; this.scheduled.clear(); this.metroScheduled.clear(); this._buildQueue(); }
    Engine.applyMasterSettings();
    Bus.emit(TOPICS.TEMPO, { bpm: b });
    Bus.emit(TOPICS.TRANSPORT, { bpm: b });
  }

  setLoop(start, end, enabled = true) {
    Store.loopStart = Math.max(0, start);
    Store.loopEnd = Math.max(Store.loopStart + 1, end);
    Store.loopEnabled = enabled;
    Bus.emit(TOPICS.TRANSPORT, { loop: [Store.loopStart, Store.loopEnd, enabled] });
  }

  _startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), LOOKAHEAD_MS);
    this._tick();
  }
  _stopTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /* ------------------------------------------------------------ queue */
  /** Build a flat, beat-sorted event list for the whole arrangement. */
  _buildQueue() {
    this.queue.length = 0;
    for (const track of Store.tracks) {
      if (track.frozen && track._frozenBuffer) continue; // handled separately
      for (const clip of track.clips) {
        if (clip.type === 'audio') {
          this.queue.push({ beat: clip.start, kind: 'audio', track, clip });
        } else if (clip.type === 'midi') {
          for (const n of clip.notes) {
            this.queue.push({ beat: clip.start + n.start, kind: 'note', track, clip, note: n,
              endBeat: clip.start + n.start + n.length });
          }
        }
      }
    }
    this.queue.sort((a, b) => a.beat - b.beat);
  }

  invalidate() { this.queue.length = 0; this.scheduled.clear(); if (Store.playing) this._buildQueue(); }

  _tick() {
    if (!Store.playing || !this.ctx) return;
    const ctx = this.ctx;
    const nowT = ctx.currentTime;
    const horizon = nowT + SCHEDULE_AHEAD;
    const horizonBeat = this.beatForCtxTime(horizon);
    const curBeat = this.beatForCtxTime(nowT);
    Store.position = curBeat;

    // looping
    if (Store.loopEnabled && curBeat >= Store.loopEnd) {
      this.seek(Store.loopStart);
      return;
    }
    if (Store.metronomeOn || Store.project.metronome?.enabled || this.recording) this._scheduleMetronome(curBeat, horizonBeat);

    for (let i = 0; i < this.queue.length; i++) {
      const ev = this.queue[i];
      if (ev.beat > horizonBeat) break;
      if (ev.__done) continue;
      if (ev.beat < curBeat - 0.02 && ev.kind === 'note') { ev.__done = true; continue; }
      if (ev.kind === 'audio') this._scheduleAudioClip(ev, horizonBeat, i);
      else this._scheduleNote(ev, i);
    }
    if (!this._rafPending) {
      this._rafPending = true;
      requestAnimationFrame(() => { this._rafPending = false; Bus.emit(TOPICS.TRANSPORT, { position: Store.position }); });
    }
  }

  /* ------------------------------------------------------------ audio clip */
  _scheduleAudioClip(ev, horizonBeat, idx) {
    const { track, clip } = ev;
    const key = clip.id;
    const chunkStartBeat = this.scheduled.get(key) ?? clip.start;
    if (chunkStartBeat >= clip.start + clip.length) { ev.__done = true; return; }
    if (chunkStartBeat > horizonBeat) return;

    const fromBeat = Math.max(chunkStartBeat, clip.start);
    const chunkEnd = Math.min(clip.start + clip.length, fromBeat + CHUNK_BEATS, horizonBeat + CHUNK_BEATS);
    const when = this.ctxTimeForBeat(fromBeat);
    if (when < this.ctx.currentTime - 0.05) { this.scheduled.set(key, chunkEnd); return; }

    this._startAudioChunk(track, clip, fromBeat, chunkEnd - fromBeat, when);
    this.scheduled.set(key, chunkEnd);
    if (chunkEnd >= clip.start + clip.length) ev.__done = true;
  }

  async _startAudioChunk(track, clip, fromBeat, lengthBeats, when) {
    const graph = Engine.getGraph(track.id);
    if (!graph) return;
    const solo = Store.tracks.some(t => t.solo);
    if (track.muted || (solo && !track.solo)) return;

    let buf;
    try { buf = await Library.getBuffer(clip.sampleId); }
    catch (e) { Bus.emit(TOPICS.TOAST, { kind: 'error', text: `Sample missing: ${clip.sampleName || clip.sampleId}` }); return; }
    if (!Store.playing) return;

    const ctx = Engine.ctx;
    // if the buffer finished loading late, skip if it's already in the past
    const now = ctx.currentTime;
    if (when < now - 0.05) when = now + 0.005;

    const rate = this._clipRate(clip);
    const offsetBeats = fromBeat - clip.start;
    let srcOffset = this.beatsToSec(offsetBeats) * rate + (clip.offset || 0);
    const chunkDur = this.beatsToSec(lengthBeats);
    if (srcOffset < 0) srcOffset = 0;
    if (srcOffset >= buf.duration) return;

    const src = ctx.createBufferSource();
    src.buffer = clip.reversed ? reverseBuffer(ctx, buf) : buf;
    src.playbackRate.value = rate;
    if (clip.reversed) srcOffset = Math.max(0, buf.duration - srcOffset - chunkDur * rate);

    const g = ctx.createGain();
    const peak = clip.gain ?? 1;
    g.gain.setValueAtTime(0, when);
    const fade = Math.min(clip.fade ?? 0.005, chunkDur / 2);
    g.gain.linearRampToValueAtTime(peak, when + Math.max(0.0015, fade));
    const endTime = when + chunkDur;
    g.gain.setValueAtTime(peak, Math.max(when + fade, endTime - Math.max(0.0015, fade)));
    g.gain.linearRampToValueAtTime(0.0001, endTime);

    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp((clip.pan ?? 0), -1, 1);

    src.connect(g); g.connect(panner); panner.connect(graph.input);

    if (clip.loop && buf.duration > 0) {
      const loopLen = buf.duration - srcOffset;
      if (loopLen > 0.02) { src.loop = true; src.loopStart = srcOffset; src.loopEnd = buf.duration; }
    }
    try { src.start(when, srcOffset); } catch (e) { console.warn('start failed', e); return; }
    src.stop(endTime + 0.02);
    const rec = { src, nodes: [src, g, panner], endsAt: endTime };
    this.activeSources.push(rec);
    src.onended = () => {
      const i = this.activeSources.indexOf(rec);
      if (i >= 0) this.activeSources.splice(i, 1);
      for (const n of rec.nodes) { try { n.disconnect(); } catch {} }
    };
  }

  _clipRate(clip) {
    let rate = clip.playbackRate ?? 1;
    const pitch = clip.pitch ?? 0;
    if (pitch) rate *= Math.pow(2, pitch / 12);
    // tempo warp: keep musical length when project tempo ≠ sample tempo
    if (clip.warp && clip.warpBpm) rate *= Store.project.bpm / clip.warpBpm;
    return clamp(rate, 0.0625, 16);
  }

  /* ------------------------------------------------------------ midi notes */
  _scheduleNote(ev, idx) {
    const key = `${ev.clip.id}:${ev.note.id}`;
    if (this.scheduled.has(key)) { ev.__done = true; return; }
    this.scheduled.set(key, true);
    ev.__done = true;
    const { track, clip, note } = ev;
    const solo = Store.tracks.some(t => t.solo);
    if (track.muted || (solo && !track.solo)) return;
    const when = this.ctxTimeForBeat(ev.beat);
    const dur = this.beatsToSec(note.length);
    Voice.play(track, note.midi, when, dur, note.velocity ?? 0.8, clip);
  }

  /* ------------------------------------------------------------ metronome */
  async _ensureMetroBuffers() {
    if (this._metronomeBuffers) return this._metronomeBuffers;
    const ctx = Engine.ctx;
    const mk = (f, dur) => {
      const b = ctx.createBuffer(1, Math.floor(dur * ctx.sampleRate), ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) {
        const t = i / ctx.sampleRate;
        d[i] = (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * f * 2 * t)) * Math.exp(-t * 60);
      }
      return b;
    };
    this._metronomeBuffers = { accent: mk(2100, 0.05), beat: mk(1400, 0.04) };
    return this._metronomeBuffers;
  }

  async _scheduleMetronome(fromBeat, toBeat) {
    if (!Store.metronomeOn && !this.recording) return;
    if (!Store.project.metronome.enabled && !this.recording) return;
    const bufs = await this._ensureMetroBuffers();
    const bpb = Store.beatsPerBar;
    const sub = 1; // quarter notes
    const first = Math.max(0, Math.ceil(fromBeat / sub)) * sub;
    for (let b = first; b <= toBeat; b += sub) {
      const key = Math.round(b * 1000);
      if (this.metroScheduled.has(key)) continue;
      this.metroScheduled.add(key);
      if (b < this.startBeat - 0.01) continue;
      const when = this.ctxTimeForBeat(b);
      if (when < Engine.ctx.currentTime) continue;
      const accent = Math.abs((b % bpb)) < 0.001;
      const src = Engine.ctx.createBufferSource();
      src.buffer = accent ? bufs.accent : bufs.beat;
      const g = Engine.ctx.createGain();
      g.gain.value = clamp(Store.project.metronome.volume, 0, 1) * (accent ? 1 : 0.7);
      src.connect(g); g.connect(Engine.masterGraph.input);
      src.start(when); src.stop(when + 0.08);
      const rec = { src, nodes: [src, g], endsAt: when + 0.1 };
      this.activeSources.push(rec);
      src.onended = () => { const i = this.activeSources.indexOf(rec); if (i >= 0) this.activeSources.splice(i, 1); };
    }
    if (this.metroScheduled.size > 4000) this.metroScheduled.clear();
  }

  /* ------------------------------------------------------------ teardown */
  stopSources(immediate) {
    const t = Engine.ctx ? Engine.ctx.currentTime : 0;
    for (const rec of this.activeSources) {
      try {
        if (immediate) rec.src.stop(t);
        else { rec.src.stop(Math.min(t + 0.02, rec.endsAt)); }
      } catch {}
    }
    this.activeSources.length = 0;
    for (const [, set] of Engine.voices) for (const v of set) { try { v.stop(t); } catch {} }
    Engine.voices.clear();
  }

  /** One-shot audition (browser preview click). */
  async audition(sampleId, { track = null, loop = false } = {}) {
    await Engine.resume();
    const buf = await Library.getBuffer(sampleId);
    const ctx = Engine.ctx;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = 0.9;
    const dest = track ? Engine.getGraph(track.id).input : Engine.masterGraph.input;
    src.connect(g); g.connect(dest);
    src.loop = loop;
    src.start();
    const rec = { src, nodes: [src, g], endsAt: ctx.currentTime + buf.duration };
    this.activeSources.push(rec);
    src.onended = () => { const i = this.activeSources.indexOf(rec); if (i >= 0) this.activeSources.splice(i, 1); };
    return { stop: () => { try { src.stop(); } catch {} } };
  }

  /** Play a single MIDI note immediately (audition from piano roll). */
  async previewNote(track, midi, dur = 0.6, vel = 0.8) {
    await Engine.resume();
    Voice.play(track, midi, Engine.ctx.currentTime + 0.01, dur, vel, null);
  }
}

/* ------------------------------------------------------------ utils */
const _revCache = new WeakMap();
function reverseBuffer(ctx, buf) {
  if (_revCache.has(buf)) return _revCache.get(buf);
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = buf.getChannelData(c), d = out.getChannelData(c);
    for (let i = 0, j = s.length - 1; i < s.length; i++, j--) d[i] = s[j];
  }
  _revCache.set(buf, out);
  return out;
}

export const Transport = new TransportImpl();
export default Transport;
