/**
 * QwenWave — Recorder.
 *
 *  • microphone acquisition (device picker, gain, high-pass, noise gate)
 *  • ZERO-LATENCY MONITORING through the track's own FX chain, so you hear
 *    yourself *with* the plugins while recording (and can A/B bypass)
 *  • audio take capture → decoded → stored as a library sample → new clip
 *  • MIDI capture from on-screen keyboard / hardware MIDI input
 *  • take comping: every take is kept, so you can switch between them
 */
import Store, { Bus, TOPICS, clamp, uid } from '../core/store.js';
import Engine from './engine.js';
import Library, { computePeaks } from './library.js';
import { idbPut, S_SAMPLES } from './db.js';
import Transport from './transport.js';
import Voice from './instruments.js';

class RecorderImpl {
  constructor() {
    this.stream = null;
    this.devices = [];
    this.recording = false;
    this.activeTrackId = null;
    this._recorder = null;
    this._chunks = [];
    this._startedAtBeat = 0;
    this._startedAtCtx = 0;
    this._analyser = null;
    this._meterRaf = null;
    this.inputLevel = { peak: 0, rms: 0, clip: false };
    this.midi = { access: null, inputs: [], lastNote: null, listeners: new Set() };
    this._midiNotes = [];
    this._midiHeld = new Map();
    this.monitorEnabled = false;
  }

  /* --------------------------------------------------------------- devices */
  async listDevices() {
    try {
      // a permission prompt is required before labels are exposed
      const all = await navigator.mediaDevices.enumerateDevices();
      this.devices = all.filter(d => d.kind === 'audioinput');
      if (this.devices.every(d => !d.label)) {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach(t => t.stop());
        const all2 = await navigator.mediaDevices.enumerateDevices();
        this.devices = all2.filter(d => d.kind === 'audioinput');
      }
    } catch (e) {
      console.warn('enumerateDevices failed', e);
      Bus.emit(TOPICS.TOAST, { kind: 'error', text: 'Нет доступа к аудиоустройствам: ' + e.message });
    }
    return this.devices;
  }

  async openMic(track, deviceId = null) {
    await Engine.resume();
    const constraints = {
      audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: 2,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    };
    try {
      if (this.stream) this.closeMic();
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // retry mono / default device
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e2) {
        Bus.emit(TOPICS.TOAST, { kind: 'error', text: `Микрофон недоступен: ${e2.message}` });
        throw e2;
      }
    }
    this.activeTrackId = track.id;
    Engine.enableMonitor(track, this.stream);
    this.monitorEnabled = true;
    this._startInputMeter();
    Bus.emit(TOPICS.RECORD, { mic: true, trackId: track.id });
    Bus.emit(TOPICS.STATUS, { text: `Микрофон открыт → мониторинг на "${track.name}"` });
    return this.stream;
  }

  closeMic() {
    this._stopInputMeter();
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    const t = this.activeTrackId ? Store.track(this.activeTrackId) : null;
    if (t) Engine.disableMonitor(t);
    this.monitorEnabled = false;
    this.activeTrackId = null;
    Bus.emit(TOPICS.RECORD, { mic: false });
  }

  setMonitor(track, on) {
    track.monitor = !!on;
    Engine._updateMonitor(track);
    Bus.emit(TOPICS.RECORD, { monitor: !!on });
  }

  /** Rebuild the monitored FX chain (after adding/removing/bypassing a plugin). */
  refreshMonitorFx(track) {
    if (this.stream && this.activeTrackId === track.id) Engine.rebuildMonitorFx(track);
  }

  _startInputMeter() {
    const ctx = Engine.ctx;
    const src = ctx.createMediaStreamSource(this.stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    this._analyser = an;
    this._analyserSrc = src;
    const data = new Float32Array(an.fftSize);
    const loop = () => {
      if (!this._analyser) return;
      this._analyser.getFloatTimeDomainData(data);
      let peak = 0, sum = 0;
      for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; sum += data[i] * data[i]; }
      this.inputLevel.peak = Math.max(peak, this.inputLevel.peak * 0.86);
      this.inputLevel.rms = Math.sqrt(sum / data.length);
      if (peak > 0.995) this.inputLevel.clip = true;
      this._meterRaf = requestAnimationFrame(loop);
    };
    loop();
  }
  _stopInputMeter() {
    if (this._meterRaf) cancelAnimationFrame(this._meterRaf);
    this._meterRaf = null;
    try { this._analyserSrc?.disconnect(); } catch {}
    this._analyser = null;
  }
  getSpectrum() {
    if (!this._analyser) return null;
    const arr = new Uint8Array(this._analyser.frequencyBinCount);
    this._analyser.getByteFrequencyData(arr);
    return arr;
  }

  /* ---------------------------------------------------------------- record */
  canRecord() {
    return !!this.stream && !!this.activeTrackId;
  }

  async start(trackId = null) {
    const track = Store.track(trackId || this.activeTrackId);
    if (!track) { Bus.emit(TOPICS.TOAST, { kind: 'error', text: 'Нет дорожки для записи' }); return false; }
    if (track.type === 'midi') return this.startMidi(track);
    if (!this.stream || this.activeTrackId !== track.id) await this.openMic(track, track.input?.deviceId);
    await Engine.resume();

    this._chunks = [];
    const mime = pickMime();
    this._recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 320000 } : undefined);
    this._recorder.ondataavailable = (e) => { if (e.data && e.data.size) this._chunks.push(e.data); };
    this._recorder.onstop = () => this._finalise(track);

    // Align the take with the transport grid so it lands exactly on a beat.
    if (!Store.playing) {
      const beat = Math.round(Store.position / Store.project.quantize) * Store.project.quantize;
      Store.position = beat;
    }
    this._startedAtBeat = Store.position;
    this._startedAtCtx = Engine.ctx.currentTime + (Store.playing ? 0 : 0.001);
    this.recording = true;
    Store.recording = true;
    track.armed = true;
    this._recorder.start(200);
    Bus.emit(TOPICS.RECORD, { recording: true, trackId: track.id });
    Bus.emit(TOPICS.TOAST, { kind: 'info', text: '● Запись… ' + track.name });
    if (!Store.playing) await Transport.play(Store.position);
    return true;
  }

  async stop() {
    if (!this.recording) return null;
    this.recording = false;
    Store.recording = false;
    Bus.emit(TOPICS.RECORD, { recording: false });
    if (this._midiRecording) return this.stopMidi();
    try { this._recorder?.stop(); } catch {}
    Transport.stop();
    return this._pendingTake || null;
  }

  async _finalise(track) {
    if (!this._chunks.length) { Bus.emit(TOPICS.TOAST, { kind: 'warn', text: 'Пустая запись' }); return; }
    Bus.emit(TOPICS.STATUS, { text: 'Обработка записи…' });
    const blob = new Blob(this._chunks, { type: this._recorder.mimeType || 'audio/webm' });
    const ctx = Engine.ctx;
    let buffer;
    try {
      const ab = await blob.arrayBuffer();
      buffer = await ctx.decodeAudioData(ab);
    } catch (e) {
      Bus.emit(TOPICS.TOAST, { kind: 'error', text: 'Не удалось декодировать запись: ' + e.message });
      return;
    }
    // trim leading silence so the take starts on the transient
    const trimmed = trimSilence(ctx, buffer, 0.006);
    const name = `Take_${track.name.replace(/[^\w\d]+/g, '_')}_${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
    const sample = await saveTakeAsSample(name, trimmed, 'Recordings');
    const clip = {
      id: uid('clip'), type: 'audio', trackId: track.id,
      start: Math.max(0, this._startedAtBeat), length: trimmed.duration / Transport.beatsToSec(1),
      sampleId: sample.id, sampleName: sample.name,
      offset: 0, playbackRate: 1, pitch: 0, gain: 1, fade: 0.006,
      loop: false, reversed: false, warp: false, warpBpm: null,
      color: track.color, take: true, takeName: name,
    };
    Store.pushHistory('record take');
    track.clips.push(clip);
    Store.project.selection.clipId = clip.id;
    Store.project.selection.trackId = track.id;
    Bus.emit(TOPICS.TRACKS, { recorded: clip.id });
    Bus.emit(TOPICS.SELECTION, {});
    this._pendingTake = clip;
    Bus.emit(TOPICS.TOAST, { kind: 'success', text: `Записано: ${name} (${trimmed.duration.toFixed(1)}s)` });
    Bus.emit(TOPICS.STATUS, { text: `Take saved — ${name}` });
    return clip;
  }

  /* ------------------------------------------------------------- MIDI rec */
  async startMidi(track) {
    await Engine.resume();
    await this.initMidi();
    this.recording = true; Store.recording = true;
    this._midiRecording = track;
    this._midiNotes = [];
    this._midiHeld.clear();
    if (!Store.playing) {
      Store.position = Math.round(Store.position / Store.project.quantize) * Store.project.quantize;
      await Transport.play(Store.position);
    }
    this._midiStartBeat = Store.position;
    this._midiStartCtx = Engine.ctx.currentTime;
    Bus.emit(TOPICS.RECORD, { recording: true, midi: true, trackId: track.id });
    Bus.emit(TOPICS.TOAST, { kind: 'info', text: '● MIDI-запись… играйте на клавиатуре' });
    return true;
  }

  stopMidi() {
    const track = this._midiRecording;
    this.recording = false; Store.recording = false;
    this._midiRecording = null;
    Transport.stop();
    Bus.emit(TOPICS.RECORD, { recording: false });
    if (!track || !this._midiNotes.length) {
      Bus.emit(TOPICS.TOAST, { kind: 'warn', text: 'MIDI-запись пуста' });
      return null;
    }
    const endBeat = Math.max(...this._midiNotes.map(n => n.start + n.length)) + 1;
    const len = Math.max(1, Math.ceil(endBeat / Store.beatsPerBar) * Store.beatsPerBar);
    const clip = {
      id: uid('clip'), type: 'midi', trackId: track.id,
      start: this._midiStartBeat, length: len,
      notes: this._midiNotes.map(n => ({ ...n, start: n.start - this._midiStartBeat })),
      automation: {}, color: track.color,
    };
    Store.pushHistory('midi record');
    track.clips.push(clip);
    Store.project.selection.clipId = clip.id;
    Bus.emit(TOPICS.TRACKS, { recorded: clip.id });
    Bus.emit(TOPICS.TOAST, { kind: 'success', text: `MIDI-запись: ${clip.notes.length} нот` });
    return clip;
  }

  /* --------------------------------------------------------------- MIDI IO */
  async initMidi() {
    if (this.midi.access || !navigator.requestMIDIAccess) return this.midi.access;
    try {
      this.midi.access = await navigator.requestMIDIAccess({ sysex: false });
      this._bindMidiInputs();
      this.midi.access.onstatechange = () => this._bindMidiInputs();
    } catch (e) { console.warn('MIDI unavailable', e); }
    return this.midi.access;
  }
  _bindMidiInputs() {
    if (!this.midi.access) return;
    this.midi.inputs = [...this.midi.access.inputs.values()];
    for (const inp of this.midi.inputs) inp.onmidimessage = (e) => this._onMidiMessage(e.data, inp.name);
    Bus.emit(TOPICS.RECORD, { midiInputs: this.midi.inputs.map(i => i.name) });
  }
  _onMidiMessage(data, srcName) {
    const [status, d1, d2] = data;
    const cmd = status & 0xf0;
    if (cmd === 0x90 && d2 > 0) this.onNoteOn(d1, d2 / 127, srcName);
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) this.onNoteOff(d1, srcName);
    else if (cmd === 0xb0) Bus.emit(TOPICS.RECORD, { cc: d1, value: d2 / 127 });
  }

  /** Central note-on used by MIDI hardware AND the on-screen/computer keyboard. */
  onNoteOn(midi, vel = 0.8, source = 'keyboard') {
    const track = Store.selectedTrack && Store.selectedTrack.type === 'midi' ? Store.selectedTrack : null;
    if (!track) { Bus.emit(TOPICS.RECORD, { noteOn: midi, vel, unassigned: true }); return; }
    Voice.hold(track, midi);
    Voice.play(track, midi, Engine.ctx.currentTime + 0.004, 30, vel);
    Bus.emit(TOPICS.RECORD, { noteOn: midi, vel });
    if (this._midiRecording && this._midiRecording.id === track.id) {
      const beat = this._ctxToBeat(Engine.ctx.currentTime);
      this._midiHeld.set(midi, beat);
    }
  }
  onNoteOff(midi) {
    const track = Store.selectedTrack;
    if (track) Voice.noteOff(track, midi);
    Bus.emit(TOPICS.RECORD, { noteOff: midi });
    if (this._midiRecording && this._midiHeld.has(midi)) {
      const start = this._midiHeld.get(midi);
      const end = this._ctxToBeat(Engine.ctx.currentTime);
      const q = Store.project.quantize || 1 / 16;
      this._midiNotes.push({
        id: uid('n'), start, length: Math.max(q, Math.round((end - start) / q) * q),
        midi, velocity: 0.8,
      });
      this._midiHeld.delete(midi);
    }
  }
  _ctxToBeat(t) {
    if (!Store.playing) return this._midiStartBeat + (t - this._midiStartCtx) / Transport.beatsToSec(1);
    return Transport.beatForCtxTime(t);
  }
}

/* ---------------------------------------------------------------- helpers */
function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const m of cands) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return null;
}

function trimSilence(ctx, buffer, thresh = 0.006) {
  const ch = buffer.numberOfChannels;
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
  let start = 0, end = buffer.length;
  const step = Math.max(1, Math.floor(ctx.sampleRate / 400));
  let found = false;
  for (let i = 0; i < buffer.length && !found; i += step) {
    for (let c = 0; c < ch; c++) if (Math.abs(data[c][i]) > thresh) { start = Math.max(0, i - step); found = true; break; }
  }
  found = false;
  for (let i = buffer.length - 1; i > start && !found; i -= step) {
    for (let c = 0; c < ch; c++) if (Math.abs(data[c][i]) > thresh) { end = Math.min(buffer.length, i + step * 2); found = true; break; }
  }
  if (end - start < ctx.sampleRate * 0.05) return buffer;
  const out = ctx.createBuffer(ch, end - start, buffer.sampleRate);
  for (let c = 0; c < ch; c++) out.copyToChannel(data[c].subarray(start, end), c);
  return out;
}

/** Encode an AudioBuffer to 16-bit WAV (used to persist takes in IndexedDB). */
export function encodeWav(buffer) {
  const nCh = buffer.numberOfChannels;
  const len = buffer.length;
  const sr = buffer.sampleRate;
  const bytes = 44 + len * nCh * 2;
  const ab = new ArrayBuffer(bytes);
  const dv = new DataView(ab);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, nCh, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * nCh * 2, true); dv.setUint16(32, nCh * 2, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, len * nCh * 2, true);
  const chans = [];
  for (let c = 0; c < nCh; c++) chans.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      let s = Math.max(-1, Math.min(1, chans[c][i]));
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/** Persist a recorded take into the library (so projects can reference it). */
export async function saveTakeAsSample(name, buffer, pack = 'Recordings') {
  const blob = encodeWav(buffer);
  const data = await blob.arrayBuffer();
  const peaksArr = computePeaks(buffer, 128);
  let rms = 0, n = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i += 8) { rms += d[i] * d[i]; n++; }
  }
  const rec = {
    id: uid('usmp'), name, pack, file: name, category: 'My Samples', subcategory: pack,
    tags: ['recording', 'take', pack.toLowerCase()], duration: +buffer.duration.toFixed(4),
    channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate, bytes: data.byteLength,
    isUser: true, rms: +(20 * Math.log10(Math.sqrt(rms / Math.max(1, n)) + 1e-12)).toFixed(2),
    peaks: peaksArr, key: null, bpm: null, loop: false, oneShot: true, data,
  };
  await idbPutSample(rec);
  const meta = { ...rec }; delete meta.data;
  Library._addSample(meta, true);
  Library.buffers.set(rec.id, buffer, buffer.length * buffer.numberOfChannels * 4);
  Bus.emit(TOPICS.LIBRARY, { added: 1 });
  return meta;
}

const idbPutSample = (rec) => idbPut(S_SAMPLES, rec);

export const Recorder = new RecorderImpl();
export default Recorder;
