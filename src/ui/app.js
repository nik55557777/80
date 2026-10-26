/**
 * QwenWave — application shell.
 * Boots the engine + library, mounts every panel, wires global actions and
 * keyboard shortcuts, restores the autosaved session and builds a starter
 * project on very first run so the app is immediately playable.
 */
import Store, { Bus, TOPICS, clamp, uid, makeTrack, makeAudioClip, makeMidiClip, makeFxInstance } from '../core/store.js';
import Engine from '../engine/engine.js';
import Library from '../engine/library.js';
import Transport from '../engine/transport.js';
import Recorder from '../engine/recorder.js';
import PluginManager from '../engine/pluginhost.js';
import Exporter, { encodeWav, downloadBlob, safeName } from '../engine/exporter.js';
import * as P from '../engine/persistence.js';
import { FX_DEFS, fxDefaults, FX_PRESETS } from '../effects/defs.js';
import { SYNTH_PRESETS, SAMPLER_PRESETS } from '../engine/instruments.js';

import { h, $, $$, clear, icon, toast, TRACK_COLORS, colorFor } from './dom.js';
import { Drag, droppable } from './drag.js';
import { mountBrowser, registerActions, handleFiles, showContextMenu } from './browser.js';
import { mountArranger, layout as arrLayout, setZoom, scrollTo, viewState } from './arranger.js';
import { mountMixer } from './mixer.js';
import { openPianoRoll, keyboard as prKeys } from './pianoroll.js';
import { openAudioEditor } from './audioeditor.js';
import { openFxRack, addFxToTrack, applyPresetToTrack, addFxToSelected, applyPresetToSelected } from './fxrack.js';
import { mountRecordPanel } from './recordpanel.js';
import { openExportDialog, openMasteringDialog, openHelp, openNewProjectDialog, openPluginBridgeInfo } from './modals.js';

let colorIdx = 0;
const nextColor = () => TRACK_COLORS[(colorIdx++) % TRACK_COLORS.length];

/* ============================================================== actions */
export const actions = {
  /* ---- tracks ---- */
  addTrack(type = 'audio', partial = {}) {
    const t = makeTrack({
      type,
      name: partial.name || (type === 'midi' ? `Instrument ${Store.tracks.filter(x => x.type === 'midi').length + 1}` : `Audio ${Store.tracks.filter(x => x.type === 'audio').length + 1}`),
      color: partial.color || nextColor(),
      instrument: type === 'midi' ? { ...defaultInstrument(), ...(partial.instrument || {}) } : undefined,
      ...partial,
    });
    Store.addTrack(t);           // emits TRACKS → arranger coalesces the layout
    Engine.applyTrackState(t);
    P.markDirty();
    return t;
  },
  deleteTrack(id) {
    const t = Store.track(id); if (!t) return;
    if (!confirm(`Удалить дорожку «${t.name}» и все её клипы?`)) return;
    if (Recorder.activeTrackId === id) Recorder.closeMic();
    Engine.disposeTrack(id);
    Store.removeTrack(id);
    Transport.invalidate();
    P.markDirty();
    arrLayout();
    Bus.emit(TOPICS.MIXER, {});
  },
  deleteSelectedTrack() {
    const id = Store.project.selection.trackId;
    if (id) actions.deleteTrack(id); else toast('info', 'Дорожка не выбрана');
  },
  duplicateTrack(id) {
    const src = Store.track(id); if (!src) return;
    Store.pushHistory('duplicate track');
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = uid('trk'); copy.name = src.name + ' (copy)'; copy.color = nextColor();
    for (const c of copy.clips) { c.id = uid('clip'); c.trackId = copy.id; if (c.type === 'midi') for (const n of c.notes) n.id = uid('n'); }
    for (const f of copy.fx) f.id = uid('fx');
    const idx = Store.trackIndex(id);
    Store.project.tracks.splice(idx + 1, 0, copy);
    Engine.applyTrackState(copy);
    P.markDirty(); arrLayout(); Transport.invalidate();
    Bus.emit(TOPICS.TRACKS, { added: copy.id });
  },
  clearClips(id) {
    const t = Store.track(id); if (!t) return;
    Store.pushHistory('clear clips');
    t.clips = []; P.markDirty(); arrLayout(); Transport.invalidate();
  },
  async freezeTrack(id) {
    const t = Store.track(id); if (!t) return;
    if (t.frozen) {
      t.frozen = false;
      P.markDirty(); arrLayout(); Engine.applyTrackState(t);
      toast('success', `«${t.name}» разморожена`);
      return;
    }
    toast('info', 'Заморозка: рендер дорожки в аудио…');
    try {
      const { buffer } = await Exporter.render({ trackIds: [id], includeMasterFx: false, normalize: false, tailSec: 1.5 });
      const sample = await import('../engine/recorder.js').then(m => m.saveTakeAsSample(`${t.name}_frozen`, buffer, 'Frozen'));
      t.frozen = true;
      t.clips = [{ id: uid('clip'), type: 'audio', trackId: t.id, start: 0,
        length: buffer.duration / Transport.beatsToSec(1), sampleId: sample.id, sampleName: sample.name,
        offset: 0, playbackRate: 1, pitch: 0, gain: 1, fade: 0.005, loop: false, color: t.color, frozen: true }];
      t._preFreeze = { clips: t.clips };
      P.markDirty(); arrLayout(); Transport.invalidate();
      Engine.applyTrackState(t);
      toast('success', `«${t.name}» заморожена — CPU освобождён (кликните ещё раз для разморозки)`);
    } catch (e) { toast('error', 'Заморозка не удалась: ' + e.message); }
  },
  toggleMute(id) {
    const t = Store.track(id); if (!t) return;
    t.muted = !t.muted;
    Engine.applyAllTracks();
    P.markDirty(); Bus.emit(TOPICS.MIXER, {}); Bus.emit(TOPICS.TRACKS, {});
  },
  toggleSolo(id) {
    const t = Store.track(id); if (!t) return;
    t.solo = !t.solo;
    Engine.applyAllTracks();
    P.markDirty(); Bus.emit(TOPICS.MIXER, {}); Bus.emit(TOPICS.TRACKS, {});
  },
  async toggleMonitor(id) {
    const t = Store.track(id); if (!t) return;
    if (t.type === 'midi') { toast('info', 'Мониторинг доступен для аудиодорожек'); return; }
    t.monitor = !t.monitor;
    if (t.monitor) {
      if (!Recorder.monitorEnabled || Recorder.activeTrackId !== id) {
        t.armed = true;
        try { await Recorder.openMic(t, t.input?.deviceId); } catch (e) { t.monitor = false; return; }
      }
      Engine.rebuildMonitorFx(t);
    }
    Engine._updateMonitor(t);
    P.markDirty();
    Bus.emit(TOPICS.RECORD, {}); Bus.emit(TOPICS.MIXER, {}); Bus.emit(TOPICS.TRACKS, {});
  },

  /* ---- clips ---- */
  addSampleClip(track, sample, atBeat = null) {
    if (!track || !sample) return null;
    Store.pushHistory('add clip');
    const spb = Transport.beatsToSec(1);
    let length = sample.duration / spb;
    if (sample.loop && sample.bpm) length = Math.max(1, Math.round(length / Store.beatsPerBar) * Store.beatsPerBar);
    const start = atBeat !== null && atBeat !== undefined
      ? Math.max(0, atBeat)
      : (Store.playing ? Math.ceil(Store.position / Store.beatsPerBar) * Store.beatsPerBar : snapEnd(track));
    const clip = makeAudioClip({
      trackId: track.id, start, length,
      sampleId: sample.id, sampleName: sample.name,
      warp: !!sample.loop && !!sample.bpm, warpBpm: sample.bpm || null,
      loop: !!sample.loop && !sample.bpm,
      color: track.color,
    });
    track.clips.push(clip);
    Store.project.selection.trackId = track.id;
    Store.project.selection.clipId = clip.id;
    P.markDirty();
    Transport.invalidate();
    arrLayout();
    Bus.emit(TOPICS.SELECTION, {});
    return clip;
  },
  deleteClip(trackId, clipId) {
    const t = Store.track(trackId); if (!t) return;
    Store.pushHistory('delete clip');
    t.clips = t.clips.filter(c => c.id !== clipId);
    if (Store.project.selection.clipId === clipId) Store.project.selection.clipId = null;
    P.markDirty(); Transport.invalidate(); arrLayout();
  },
  duplicateClip(trackId, clipId) {
    const t = Store.track(trackId); const c = t?.clips.find(x => x.id === clipId);
    if (!c) return;
    Store.pushHistory('duplicate clip');
    const copy = JSON.parse(JSON.stringify(c));
    copy.id = uid('clip'); copy.start = c.start + c.length;
    if (copy.type === 'midi') for (const n of copy.notes) n.id = uid('n');
    t.clips.push(copy);
    Store.project.selection.clipId = copy.id;
    P.markDirty(); Transport.invalidate(); arrLayout(); Bus.emit(TOPICS.SELECTION, {});
  },
  quantizeClip(clipId) {
    const c = Store.clip(clipId); if (!c || c.type !== 'midi') return;
    Store.pushHistory('quantize');
    const q = Store.project.quantize || 1 / 16;
    for (const n of c.notes) {
      n.start = Math.max(0, Math.round(n.start / q) * q);
      n.length = Math.max(q, Math.round(n.length / q) * q);
    }
    P.markDirty(); Transport.invalidate(); arrLayout();
    toast('success', `Квантовано ${c.notes.length} нот`);
  },

  /* ---- fx ---- */
  addFx(trackId, type) { addFxToTrack(trackId, type); },
  addFxToSelected(type) { addFxToSelected(type); },
  applyPreset(trackId, name) { applyPresetToTrack(trackId, name); },
  applyPresetToSelected(name) { applyPresetToSelected(name); },

  /* ---- project ---- */
  newProject: () => openNewProjectDialog(),
  saveProject: async () => { await P.saveToSession(); toast('success', `Проект «${Store.project.name}» сохранён в браузере`); },
  saveProjectAs: () => {
    const name = prompt('Имя проекта:', Store.project.name);
    if (!name) return;
    Store.project.name = name;
    P.saveAs(name).then(() => toast('success', `Сохранено как «${name}»`));
  },
  loadProject: async (id) => {
    try { await P.loadFromSession(id); arrLayout(); toast('success', 'Проект загружен'); }
    catch (e) { toast('error', 'Ошибка загрузки: ' + e.message); }
  },
  exportFile: () => P.exportProjectFile(),
  exportBundle: () => P.exportProjectBundle((p, t) => Bus.emit(TOPICS.STATUS, { text: t })),
  exportAudio: () => openExportDialog(),
  mastering: () => openMasteringDialog(),
  help: () => openHelp(),
  pluginInfo: () => openPluginBridgeInfo(),

  /* ---- transport ---- */
  async togglePlay() { await Transport.toggle(); },
  stop() { Transport.stop(); },
  async toggleRecord() {
    if (Store.recording) { await Recorder.stop(); return; }
    const t = Store.tracks.find(x => x.armed) || Store.selectedTrack;
    if (!t) { toast('info', 'Вооружите дорожку (кнопка ●) перед записью'); return; }
    if (t.type === 'audio' && !Recorder.monitorEnabled) { try { await Recorder.openMic(t, t.input?.deviceId); } catch { return; } }
    await Recorder.start(t.id);
  },
  setBpm(v) { Transport.setBpm(v); arrLayout(); },
  setMetronome(v) { Store.metronomeOn = v; Store.project.metronome.enabled = v; P.markDirty(); Bus.emit(TOPICS.TRANSPORT, {}); },
};

function snapEnd(track) {
  if (!track.clips.length) return Math.ceil(Store.position / Store.beatsPerBar) * Store.beatsPerBar;
  return Math.max(...track.clips.map(c => c.start + c.length));
}

function defaultInstrument() {
  return { engine: 'synth', sampleId: null, rootKey: 60, gain: 0.5, attack: 0.006, decay: 0.25,
    sustain: 0.7, release: 0.3, filterHz: 4000, resonance: 1.0, unison: 1, detune: 7,
    waveform: 'sawtooth', cutoffEnv: 0.35, polyphony: 12, mode: 'oneshot', loop: false, glide: 0,
    sub: true, subLevel: 0.35 };
}

/* ============================================================== shell */
function buildShell() {
  const app = $('#app');
  clear(app);
  app.className = 'app';

  app.append(buildTopbar());

  const bodyEl = h('div', { class: 'app-body' });
  const browserEl = h('aside', { class: 'browser', id: 'browser' });
  const mainEl = h('div', { class: 'app-main', id: 'app-main' });

  const arrEl = h('section', { id: 'arranger' });
  const splitter = h('div', { class: 'splitter', id: 'splitter' });
  const bottom = h('section', { class: 'bottom', id: 'bottom' });

  const btabs = h('div', { class: 'bottom-tabs' });
  const panels = ['pianoroll', 'audio', 'fx', 'mixer', 'record'];
  const labels = { pianoroll: '🎹 Piano Roll', audio: '〰 Аудио / Вокал', fx: '🎛 Эффекты', mixer: '🎚 Микшер', record: '🎙 Запись' };
  for (const p of panels) {
    const b = h('button', { class: 'tab bt' + (p === 'mixer' ? ' active' : ''), dataset: { panel: p } }, labels[p]);
    b.onclick = () => switchBottom(p);
    btabs.append(b);
  }
  btabs.append(h('div', { class: 'spacer' }));
  btabs.append(
    h('button', { class: 'btn btn-sm btn-ghost', title: 'Свернуть нижнюю панель', onclick: () => toggleBottom('collapse') }, '▾'),
    h('button', { class: 'btn btn-sm btn-ghost', title: 'Развернуть', onclick: () => toggleBottom('max') }, '▴'));

  const bbody = h('div', { class: 'bottom-body' });
  for (const p of panels) {
    const panel = h('div', { class: 'bottom-panel' + (p === 'mixer' ? ' active' : ''), id: 'panel-' + p });
    if (p === 'pianoroll' || p === 'fx' || p === 'audio' || p === 'mixer') panel.classList.add('fill');
    bbody.append(panel);
  }
  bottom.append(btabs, bbody);
  mainEl.append(arrEl, splitter, bottom);
  bodyEl.append(browserEl, mainEl);
  app.append(bodyEl);
  app.append(buildStatusbar());

  // splitter drag
  let dragging = false;
  splitter.addEventListener('pointerdown', (e) => {
    dragging = true; splitter.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'row-resize';
  });
  splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = mainEl.getBoundingClientRect();
    const bottomH = clamp(r.bottom - e.clientY, 0, r.height - 130);
    mainEl.style.gridTemplateRows = `minmax(120px, 1fr) 6px ${bottomH}px`;
    mainEl.classList.remove('bottom-collapsed', 'bottom-max');
    Bus.emit(TOPICS.VIEW, { resize: true });
  });
  splitter.addEventListener('pointerup', (e) => { dragging = false; document.body.style.cursor = ''; Bus.emit(TOPICS.VIEW, {}); });

  switchBottom('mixer');
  return { browserEl, arrEl, panels: bbody };
}

function switchBottom(name) {
  $$('.bt').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
  $$('.bottom-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  Bus.emit(TOPICS.VIEW, { panel: name });
  if (name === 'mixer') Bus.emit(TOPICS.MIXER, {});
  if (name === 'record') Bus.emit(TOPICS.RECORD, {});
  if (name === 'pianoroll') {
    const clip = Store.selectedClip;
    if (clip?.type === 'midi') openPianoRoll(clip.id);
  }
  if (name === 'audio') {
    const clip = Store.selectedClip;
    if (clip?.type === 'audio') openAudioEditor(clip.id);
  }
}
export { switchBottom };

function toggleBottom(mode) {
  const m = $('#app-main');
  if (mode === 'collapse') m.classList.add('bottom-collapsed');
  else if (mode === 'max') { m.classList.remove('bottom-collapsed'); m.classList.add('bottom-max'); }
  else m.classList.remove('bottom-collapsed', 'bottom-max');
  setTimeout(() => Bus.emit(TOPICS.VIEW, {}), 30);
}

function buildTopbar() {
  const bar = h('header', { class: 'topbar' });

  bar.append(
    h('div', { class: 'brand' },
      h('div', { class: 'brand-mark' }, h('span', {}, 'Q')),
      h('div', {}, h('div', {}, 'QwenWave'), h('div', { class: 'brand-sub' }, 'Web DAW'))),
  );

  // transport
  const playBtn = h('button', { class: 'tp-btn play', title: 'Play/Pause (Space)' }, svgPath('M8 5v14l11-7z'));
  const stopBtn = h('button', { class: 'tp-btn', title: 'Stop' }, svgPath('M6 6h12v12H6z'));
  const recBtn = h('button', { class: 'tp-btn rec', title: 'Record (R)' }, svgPath('M12 6a6 6 0 100 12 6 6 0 000-12z'));
  const loopBtn = h('button', { class: 'tp-btn', title: 'Loop (L)' }, svgPath('M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z'));
  const metroBtn = h('button', { class: 'tp-btn', title: 'Метроном' }, svgPath('M12 3l7 18H5z'));
  playBtn.onclick = () => actions.togglePlay();
  stopBtn.onclick = () => actions.stop();
  recBtn.onclick = () => actions.toggleRecord();
  loopBtn.onclick = () => { Transport.setLoop(Store.loopStart, Store.loopEnd, !Store.loopEnabled); loopBtn.classList.toggle('active', Store.loopEnabled); };
  metroBtn.onclick = () => { Store.metronomeOn = !Store.metronomeOn; Store.project.metronome.enabled = Store.metronomeOn; metroBtn.classList.toggle('active', Store.metronomeOn); P.markDirty(); };
  metroBtn.classList.toggle('active', !!Store.metronomeOn);
  loopBtn.classList.toggle('active', !!Store.loopEnabled);
  bar.append(h('div', { class: 'transport' }, playBtn, stopBtn, recBtn, loopBtn, metroBtn));

  // time display
  const timeEl = h('div', { class: 'time-display', id: 'time-display', title: 'Клик — переключить бары/секунды' }, '001:1:0.0');
  let showSec = false;
  timeEl.onclick = () => { showSec = !showSec; timeEl.classList.toggle('beats', showSec); };
  bar.append(timeEl);

  // bpm
  const bpmIn = h('input', { class: 'bpm-input', id: 'bpm-input', type: 'number', min: 20, max: 400, step: 1, value: Store.project.bpm });
  const commitBpm = () => actions.setBpm(clamp(parseFloat(bpmIn.value) || 120, 20, 400));
  bpmIn.addEventListener('change', commitBpm);
  bpmIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commitBpm(); bpmIn.blur(); } e.stopPropagation(); });
  // drag on BPM for fine control
  let dragY = 0, dragV = 0, dragging = false;
  bpmIn.addEventListener('pointerdown', (e) => { if (e.shiftKey) { dragging = true; dragY = e.clientY; dragV = Store.project.bpm; e.preventDefault(); } });
  window.addEventListener('pointermove', (e) => { if (dragging) { const v = clamp(dragV + (dragY - e.clientY) * 0.25, 20, 400); bpmIn.value = v.toFixed(1); actions.setBpm(v); } });
  window.addEventListener('pointerup', () => { dragging = false; });
  const tap = h('button', { class: 'bpm-tap', title: 'Tap tempo' }, 'TAP');
  let taps = [];
  tap.onclick = () => {
    const now = performance.now();
    taps = taps.filter(t => now - t < 2500); taps.push(now);
    if (taps.length >= 2) {
      const iv = []; for (let i = 1; i < taps.length; i++) iv.push(taps[i] - taps[i - 1]);
      const avg = iv.reduce((a, b) => a + b, 0) / iv.length;
      const bpm = clamp(Math.round(60000 / avg), 20, 400);
      bpmIn.value = bpm; actions.setBpm(bpm);
    }
  };
  bar.append(h('div', { class: 'bpm-box' }, h('label', {}, 'BPM'), bpmIn, tap));

  // time signature + key
  const tsSel = h('select', { class: 'sel', title: 'Размер' },
    ...[[4, 4], [3, 4], [6, 8], [2, 4], [5, 4], [7, 8]].map(([a, b]) =>
      h('option', { value: `${a}/${b}`, selected: Store.project.timeSignature[0] === a && Store.project.timeSignature[1] === b }, `${a}/${b}`)));
  tsSel.onchange = () => {
    const [a, b] = tsSel.value.split('/').map(Number);
    Store.pushHistory('time signature');
    Store.project.timeSignature = [a, b];
    P.markDirty(); arrLayout(); Bus.emit(TOPICS.TRANSPORT, {});
  };
  const keySel = h('select', { class: 'sel', title: 'Тональность проекта' },
    ...['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map((n, i) =>
      h('option', { value: i, selected: i === Store.project.key.root }, n)));
  keySel.onchange = () => { Store.project.key.root = +keySel.value; P.markDirty(); Bus.emit(TOPICS.LIBRARY, {}); };
  const scaleSel = h('select', { class: 'sel', title: 'Лад' },
    ...Object.keys({ major: 1, minor: 1, dorian: 1, phrygian: 1, lydian: 1, mixolydian: 1, harmonicMinor: 1, pentMajor: 1, pentMinor: 1, blues: 1 })
      .map(s => h('option', { value: s, selected: s === Store.project.key.scale }, s)));
  scaleSel.onchange = () => { Store.project.key.scale = scaleSel.value; P.markDirty(); Bus.emit(TOPICS.LIBRARY, {}); };
  bar.append(h('div', { class: 'tb-sep' }), tsSel, keySel, scaleSel);

  bar.append(h('div', { class: 'spacer' }));

  // project name + save
  const nameEl = h('input', { class: 'lh-name', id: 'project-name', value: Store.project.name, style: { width: '150px', fontSize: '12px' } });
  nameEl.addEventListener('change', () => { Store.project.name = nameEl.value || 'Untitled'; P.markDirty(); });
  nameEl.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') nameEl.blur(); });
  bar.append(nameEl,
    h('button', { class: 'btn btn-sm', title: 'Сохранить (Ctrl+S)', onclick: () => actions.saveProject() }, icon('save', 13), 'Save'),
    h('button', { class: 'btn btn-sm', title: 'Новый проект', onclick: () => actions.newProject() }, 'New'),
    h('button', { class: 'btn btn-sm btn-primary', title: 'Экспорт аудио (Ctrl+E)', onclick: () => actions.exportAudio() }, icon('down', 13), 'Export'),
    h('button', { class: 'btn btn-sm', title: 'Мастеринг', onclick: () => actions.mastering() }, icon('wand', 13), 'Master'),
    h('button', { class: 'btn btn-sm', title: 'Справка (?)', onclick: () => actions.help() }, '?'));
  return bar;
}

function svgPath(d) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '17'); s.setAttribute('height', '17');
  s.setAttribute('fill', 'currentColor');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d); s.append(p);
  return s;
}

function buildStatusbar() {
  const bar = h('footer', { class: 'statusbar' });
  const dot = h('span', { class: 'st-dot' });
  const statusText = h('span', { class: 'st st-flex', id: 'status-text' }, 'Инициализация…');
  const voices = h('span', { class: 'st' }, 'voices 0');
  const cache = h('span', { class: 'st' }, 'cache —');
  const cpuBar = h('span', { class: 'cpu-bar' }, h('i'));
  const cpuTxt = h('span', { class: 'st' }, 'cpu —');
  const lat = h('span', { class: 'st' }, '— ms');
  bar.append(h('span', { class: 'st-chip' }, dot, 'QwenWave'), statusText, voices, cache,
    h('span', { class: 'st-chip' }, cpuTxt, cpuBar), lat);

  Bus.on(TOPICS.STATUS, (p) => { if (p?.text) statusText.textContent = p.text; });
  setInterval(() => {
    let v = 0; for (const s of Engine.voices.values()) v += s.size;
    voices.textContent = `voices ${v} · tracks ${Store.tracks.length}`;
    const c = Library.cacheInfo;
    cache.textContent = `cache ${c.decoded}/${c.totalSamples} · ${c.mb}MB`;
    // CPU estimate from frame timing
    const cpu = clamp((perf.frameMs / 16.7) * 100, 0, 100);
    cpuTxt.textContent = `ui ${cpu.toFixed(0)}%`;
    const fill = cpuBar.firstElementChild;
    if (fill) { fill.style.width = cpu + '%'; fill.style.background = cpu > 85 ? 'var(--err)' : cpu > 60 ? 'var(--warn)' : 'var(--ok)'; }
    lat.textContent = Engine.ctx ? `${(Engine.ctx.baseLatency * 1000).toFixed(1)} ms · ${Engine.sampleRate / 1000}k` : 'audio off';
    dot.className = 'st-dot' + (Engine.workletFailed ? ' warn' : '');
  }, 700);
  return bar;
}

const perf = { frameMs: 4, _t: performance.now() };
function perfLoop() {
  const t = performance.now();
  perf.frameMs = perf.frameMs * 0.9 + (t - perf._t) * 0.1;
  perf._t = t;
  requestAnimationFrame(perfLoop);
}

/* ============================================================== keyboard */
function bindKeys() {
  document.addEventListener('keydown', async (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (prKeys(e)) { e.preventDefault(); return; }
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? Store.redo() : Store.undo(); arrLayout(); Bus.emit(TOPICS.MIXER, {}); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); Store.redo(); arrLayout(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); await actions.saveProject(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'e') { e.preventDefault(); actions.exportAudio(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'd') {
      e.preventDefault();
      const c = Store.selectedClip;
      if (c) actions.duplicateClip(Store.clipTrack(c.id).id, c.id);
      return;
    }
    switch (e.key) {
      case ' ': e.preventDefault(); await actions.togglePlay(); return;
      case 'r': case 'R': case 'к': case 'К': e.preventDefault(); await actions.toggleRecord(); return;
      case 'l': case 'L': case 'д': case 'Д': Transport.setLoop(Store.loopStart, Store.loopEnd, !Store.loopEnabled); Bus.emit(TOPICS.TRANSPORT, {}); return;
      case 'm': case 'M': case 'ь': case 'Ь': { const t = Store.selectedTrack; if (t) actions.toggleMute(t.id); return; }
      case 's': case 'S': case 'ы': case 'Ы': {
        if (e.shiftKey) { const t = Store.selectedTrack; if (t) actions.toggleSolo(t.id); return; }
        const c = Store.selectedClip;
        if (c) {
          const t = Store.clipTrack(c.id);
          if (Store.position > c.start && Store.position < c.start + c.length) {
            Store.pushHistory('split');
            const at = Store.position;
            const right = JSON.parse(JSON.stringify(c));
            right.id = uid('clip');
            if (c.type === 'audio') {
              right.offset = (c.offset || 0) + Transport.beatsToSec(at - c.start);
              right.start = at; right.length = c.length - (at - c.start); c.length = at - c.start;
            } else {
              const rel = at - c.start;
              right.notes = c.notes.filter(n => n.start >= rel).map(n => ({ ...n, start: n.start - rel, id: uid('n') }));
              c.notes = c.notes.filter(n => n.start < rel);
              right.start = at; right.length = c.length - rel; c.length = rel;
            }
            t.clips.push(right);
            P.markDirty(); Transport.invalidate(); arrLayout();
          }
        }
        return;
      }
      case 'Delete': case 'Backspace': {
        const c = Store.selectedClip;
        if (c) { const t = Store.clipTrack(c.id); if (t) actions.deleteClip(t.id, c.id); }
        else actions.deleteSelectedTrack();
        return;
      }
      case 'f': case 'F': case 'а': case 'А': { const t = Store.selectedTrack; if (t) actions.freezeTrack(t.id); return; }
      case '1': case '2': case '3': case '4': {
        const tools = ['select', 'draw', 'erase', 'split'];
        Bus.emit(TOPICS.VIEW, { tool: tools[+e.key - 1] });
        window.__qw.setTool?.(tools[+e.key - 1]);
        return;
      }
      case '?': actions.help(); return;
      case 'Escape': Store.project.selection.clipId = null; Bus.emit(TOPICS.SELECTION, {}); return;
    }
    if (e.key === '+' || e.key === '=') { zoomBy(1 / 1.3); return; }
    if (e.key === '-' || e.key === '_') { zoomBy(1.3); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const step = e.shiftKey ? Store.beatsPerBar : (Store.project.quantize || 1 / 4);
      Transport.seek(clamp(Store.position + (e.key === 'ArrowRight' ? step : -step), 0, 1e6));
      e.preventDefault();
    }
  });
}
function zoomBy(f) {
  const st = viewState?.();
  setZoom((st?.viewBeats || 32) * f);
}

/* ============================================================== boot */
export async function boot() {
  const splash = $('#splash');
  const setStage = (t, p) => {
    const el = $('#splash-status'); if (el) el.textContent = t;
    const bar = $('#splash-bar'); if (bar) bar.style.width = (p * 100) + '%';
  };

  setStage('Инициализация аудио-движка…', 0.05);
  await Engine.init();
  Library.setContext(Engine.ctx);

  setStage('Загрузка библиотеки сэмплов…', 0.18);
  await Library.load();

  setStage('Загрузка плагинов…', 0.4);
  await PluginManager.load();
  await Recorder.initMidi().catch(() => {});

  setStage('Восстановление сессии…', 0.55);
  const saved = await P.loadAutosave();
  const shell = buildShell();
  mountBrowser(shell.browserEl);
  mountArranger($('#arranger'));
  mountMixer($('#panel-mixer'));
  mountRecordPanel($('#panel-record'));
  openFxRack('__master__');
  switchBottom('mixer');

  // expose global action surface (also handy for console/debug)
  window.__qw = { Store, Engine, Library, Transport, Recorder, PluginManager, Exporter, actions, ...actions,
    setTool: (t) => Bus.emit(TOPICS.VIEW, { tool: t }), switchBottom };
  registerActions(actions);

  bindKeys();
  perfLoop();
  P.startAutosave();

  if (saved && saved.tracks?.length) {
    setStage('Открытие сохранённого проекта…', 0.75);
    P.applyProject(saved);
  } else {
    setStage('Создание стартового проекта…', 0.75);
    await buildStarterProject();
  }

  // engine-wide state sync
  // (arranger subscribes to TRACKS itself with a coalesced requestLayout —
  //  no need for a second full re-layout here)
  Bus.on(TOPICS.TOAST, (t) => toast(t.kind || 'info', t.text, t.ms));
  Bus.on(TOPICS.TRANSPORT, (p) => {
    const el = $('#time-display');
    if (el) {
      const bpb = Store.beatsPerBar;
      const b = Store.position;
      const bar = Math.floor(b / bpb) + 1;
      const beat = Math.floor(b % bpb) + 1;
      const tick = Math.floor((b % 1) * 4);
      if (el.classList.contains('beats')) el.textContent = `${Transport.beatsToSec(b).toFixed(2)} s`;
      else el.textContent = `${String(bar).padStart(3, '0')}:${beat}:${tick}`;
    }
    const pb = $('.tp-btn.play');
    pb?.classList.toggle('active', Store.playing);
    $('.tp-btn.rec')?.classList.toggle('active', Store.recording);
  });
  setInterval(() => Bus.emit(TOPICS.TRANSPORT, {}), Store.playing ? 60 : 250);

  setStage('Готово', 1);
  setTimeout(() => {
    splash?.classList.add('hide');
    setTimeout(() => splash?.remove(), 500);
  }, 260);

  // first interaction unlocks audio (browser autoplay policy)
  const unlock = async () => {
    await Engine.resume();
    document.removeEventListener('pointerdown', unlock);
    document.removeEventListener('keydown', unlock);
    Bus.emit(TOPICS.STATUS, { text: `Готово · ${Engine.sampleRate / 1000} kHz · задержка ${(Engine.ctx.baseLatency * 1000).toFixed(1)} ms · ${Library.samples.length} сэмплов` });
  };
  document.addEventListener('pointerdown', unlock);
  document.addEventListener('keydown', unlock);

  arrLayout();
  return shell;
}

/* ------------------------------------------------- starter demo project */
async function buildStarterProject() {
  const byName = (n) => Library.samples.find(s => s.name === n);
  const tDrums = actions.addTrack('audio', { name: 'Drums', color: '#ff8f5e' });
  const tBass = actions.addTrack('audio', { name: '808 Bass', color: '#ffc857' });
  const tChords = actions.addTrack('audio', { name: 'Chords', color: '#5fd39a' });
  const tLead = actions.addTrack('midi', { name: 'Lead Synth', color: '#b28dff',
    instrument: { ...defaultInstrument(), ...SYNTH_PRESETS['Pluck'], gain: 0.42, filterHz: 3200, resonance: 2.4 } });
  const tVox = actions.addTrack('audio', { name: 'Vocal', color: '#ff6b9d' });

  // arm the vocal track for instant mic use
  tVox.armed = false; tVox.monitor = false;

  const bpm = Store.project.bpm;
  const loopDrums = byName(`House_Drums_${bpm}bpm_2bar`) || byName('House_Drums_124bpm_2bar') || Library.samples.find(s => s.subcategory === 'Drum Loop');
  const loopBass = Library.samples.find(s => s.subcategory === 'Bass Loop' && s.bpm === (loopDrums?.bpm || bpm)) || Library.samples.find(s => s.subcategory === 'Bass Loop');
  const loopChords = Library.samples.find(s => s.subcategory === 'Chord Loop' && s.bpm === (loopDrums?.bpm || bpm)) || Library.samples.find(s => s.subcategory === 'Chord Loop');

  if (loopDrums) actions.addSampleClip(tDrums, loopDrums, 0);
  if (loopBass) actions.addSampleClip(tBass, loopBass, 0);
  if (loopChords) actions.addSampleClip(tChords, loopChords, 0);

  // a small lead melody in the project key
  const root = 69, scale = [0, 3, 5, 7, 10];
  const seq = [0, 3, 7, 3, 10, 7, 3, 0, 5, 3, 0, -2, 0, 3, 5, 7];
  const notes = seq.map((d, i) => ({
    id: uid('n'), start: i * 0.5, length: 0.45,
    midi: clamp(root + d, 24, 108), velocity: 0.62 + (i % 4 === 0 ? 0.22 : 0),
  }));
  const midiClip = makeMidiClip({ trackId: tLead.id, start: 0, length: 8, notes, color: tLead.color });
  tLead.clips.push(midiClip);

  // ready-made chains so it sounds mixed out of the box
  applyPresetToTrack(tVox.id, 'Vocal → Radio Lead');
  applyPresetToTrack(tDrums.id, 'Drums → Punch');
  addFxToTrack(tLead.id, 'delay');
  addFxToTrack(tLead.id, 'reverb');
  addFxToTrack(tChords.id, 'reverb');

  Store.project.master.mastering = { enabled: true, preset: 'balanced', amount: 0.55 };
  Store.project.metronome = { enabled: false, volume: 0.5, countIn: 0 };
  Store.project.length = 16;
  Transport.setLoop(0, 8, true);
  Store.project.name = 'Demo Project';
  const nameEl = $('#project-name'); if (nameEl) nameEl.value = Store.project.name;
  Engine.applyMasterSettings();
  Store.clearHistory();
  P.markDirty();
  arrLayout();
  Bus.emit(TOPICS.TRACKS, {});
  setTimeout(() => toast('info', 'Стартовый проект загружен: нажмите Space. Вокал — дорожка «Vocal» (кнопка ●, затем MON).', 9000), 900);
}

/* ============================================================== start
   NOTE: boot() is invoked once by src/main.js (the real entry point).
   Do NOT auto-boot here — that would run the whole startup twice. */
