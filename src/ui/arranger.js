/**
 * QwenWave — Arranger (timeline + track lanes + clips).
 *
 * Performance notes:
 *   • lane/clip DOM is rebuilt only on TRACKS events, never per frame
 *   • the playhead is a single transform-updated element (no layout thrash)
 *   • waveforms are pre-rendered to offscreen sprites, drawn lazily via
 *     IntersectionObserver, and re-blitted (not recomputed) on redraw
 *   • horizontal virtualisation: only the beat range in view is laid out
 */
import Store, { Bus, TOPICS, clamp, uid, dbToGain, gainToDb, noteName } from '../core/store.js';
import Engine from '../engine/engine.js';
import Library from '../engine/library.js';
import Transport from '../engine/transport.js';
import Recorder from '../engine/recorder.js';
import * as P from '../engine/persistence.js';
import { h, $, clear, icon, fitCanvas, observeSize, waveformSprite, invalidateWave, draggable, on, toast, colorFor, TRACK_COLORS } from './dom.js';
import { Drag, droppable } from './drag.js';
import { showContextMenu, registerActions, addClipToTrack } from './browser.js';
import { openPianoRoll } from './pianoroll.js';
import { openAudioEditor } from './audioeditor.js';
import { openFxRack } from './fxrack.js';
import { selectTrack } from './mixer.js';

const TRACK_H = 74;
const HEADER_W = 208;
let root, scrollEl, gridEl, headersEl, lanesEl, rulerCv, rulerWrap, playheadEl, loopEl, recLineEl;
let width = 800, viewHeight = 400;
let snap = 1 / 4;
let tool = 'select';
let viewStartBeat = 0, viewBeats = 32;
let rafId = null;
let recordingClipEls = new Map();

export function mountArranger(el) {
  root = el;
  clear(root);
  root.className = 'arranger';

  /* ---------------------------------------------------------- toolbar */
  const top = h('div', { class: 'arr-top' });
  const toolBtns = [
    { id: 'select', label: 'Курсор', key: '1' },
    { id: 'draw', label: 'Карандаш', key: '2' },
    { id: 'erase', label: 'Ластик', key: '3' },
    { id: 'split', label: 'Разрез', key: '4' },
  ];
  const toolGroup = h('div', { class: 'tb-group' });
  for (const t of toolBtns) {
    const b = h('button', { class: 'pr-tool-btn' + (t.id === tool ? ' active' : ''), title: `${t.label} (${t.key})` }, t.label);
    b.onclick = () => { tool = t.id; [...toolGroup.children].forEach(c => c.classList.remove('active')); b.classList.add('active'); Bus.emit(TOPICS.VIEW, { tool }); };
    toolGroup.append(b);
  }

  const snapSel = h('select', { class: 'sel', title: 'Привязка к сетке' },
    ...[['1/1', 1], ['1/2', 1 / 2], ['1/4', 1 / 4], ['1/8', 1 / 8], ['1/16', 1 / 16], ['1/32', 1 / 32], ['1/3', 1 / 3], ['1/6', 1 / 6], ['Такт', Store.beatsPerBar], ['Выкл', 0]]
      .map(([lab, v]) => h('option', { value: v, selected: Math.abs(v - (Store.project.view.snap ?? 1 / 4)) < 1e-9 }, lab)));
  snapSel.onchange = () => { snap = parseFloat(snapSel.value) || 0; Store.project.view.snap = snap; P.markDirty(); };
  snap = Store.project.view.snap ?? 1 / 4;

  const zoomOut = h('button', { class: 'btn btn-sm', title: 'Уменьшить (−)' }, '−');
  const zoomIn = h('button', { class: 'btn btn-sm', title: 'Увеличить (+)' }, '+');
  const zoomFit = h('button', { class: 'btn btn-sm', title: 'По размеру проекта' }, 'Весь');
  zoomOut.onclick = () => setZoom(viewBeats * 1.35);
  zoomIn.onclick = () => setZoom(viewBeats / 1.35);
  zoomFit.onclick = () => { scrollTo(0); setZoom(Math.max(8, Store.totalBeats)); };

  const addAudio = h('button', { class: 'btn btn-sm', onclick: () => window.__qw.addTrack('audio') }, icon('plus', 12), 'Аудио');
  const addMidi = h('button', { class: 'btn btn-sm', onclick: () => window.__qw.addTrack('midi') }, icon('plus', 12), 'MIDI');
  const delTrack = h('button', { class: 'btn btn-sm btn-danger', title: 'Удалить выбранную дорожку (Del)', onclick: () => window.__qw.deleteSelectedTrack() }, icon('trash', 12));

  const followTgl = h('button', { class: 'btn btn-sm' + (Store.project.view.follow ? ' btn-primary' : ''), title: 'Следить за плейхедом' }, 'Follow');
  followTgl.onclick = () => { Store.project.view.follow = !Store.project.view.follow; followTgl.classList.toggle('btn-primary', Store.project.view.follow); };

  top.append(toolGroup, h('div', { class: 'tb-sep' }),
    h('span', { class: 'ctrl-label' }, 'Сетка'), snapSel,
    h('div', { class: 'tb-sep' }), zoomOut, zoomIn, zoomFit,
    h('div', { class: 'tb-sep' }), addAudio, addMidi, delTrack,
    h('div', { class: 'spacer' }), followTgl);

  /* ---------------------------------------------------------- scroller */
  scrollEl = h('div', { class: 'arr-scroll' });
  rulerWrap = h('div', { class: 'ruler-wrap' });
  const corner = h('div', { class: 'ruler-corner' },
    h('span', { class: 'mono', style: { fontSize: '9.5px' } }, 'BAR:BEAT'));
  rulerCv = h('canvas', { class: 'ruler' });
  rulerWrap.append(corner, rulerCv);

  gridEl = h('div', { class: 'arr-grid' });
  headersEl = h('div', { class: 'arr-headers' });
  lanesEl = h('div', { class: 'arr-lanes' });
  gridEl.append(headersEl, lanesEl);

  playheadEl = h('div', { class: 'playhead', style: { display: 'none' } });
  loopEl = h('div', { class: 'loop-region', style: { display: 'none' } });
  recLineEl = h('div', { class: 'rec-line', style: { display: 'none' } });
  lanesEl.append(playheadEl, loopEl, recLineEl);

  scrollEl.append(rulerWrap, gridEl);
  root.append(top, scrollEl);

  scrollEl.addEventListener('scroll', () => { drawRuler(); positionOverlays(); });
  observeSize(scrollEl, (w, hh) => {
    width = w; viewHeight = hh;
    layout(); drawRuler(); positionOverlays();
  });
  rulerCv.addEventListener('pointerdown', onRulerDown);
  lanesEl.addEventListener('pointerdown', onLanesDown);

  Bus.on(TOPICS.TRACKS, () => requestLayout());
  Bus.on(TOPICS.TRANSPORT, (p) => { if (p?.loop) positionOverlays(); if (!Store.playing) positionOverlays(); });
  Bus.on(TOPICS.SELECTION, () => paintSelection());
  Bus.on(TOPICS.VIEW, (p) => { if (p?.tool) { tool = p.tool; [...toolGroup.children].forEach((c, i) => c.classList.toggle('active', toolBtns[i].id === tool)); } });
  Bus.on(TOPICS.RECORD, () => updateRecLine());
  Bus.on(TOPICS.TEMPO, () => { layout(); drawRuler(); });

  startPlayheadLoop();
  layout();
}

/* ------------------------------------------------------------------ layout */
export function pxPerBeat() {
  const usable = Math.max(200, width - HEADER_W);
  return usable / Math.max(1, viewBeats);
}
function beatToX(b) { return (b - viewStartBeat) * pxPerBeat(); }
function xToBeat(x) { return viewStartBeat + x / pxPerBeat(); }
export function snapBeat(b) {
  if (!snap) return b;
  return Math.round(b / snap) * snap;
}

function setZoom(beats) {
  const centre = viewStartBeat + viewBeats / 2;
  viewBeats = clamp(beats, 2, 2048);
  viewStartBeat = Math.max(0, centre - viewBeats / 2);
  Store.project.view.pxPerBeat = pxPerBeat();
  layout(); drawRuler(); positionOverlays();
}
function scrollTo(beat) {
  viewStartBeat = Math.max(0, beat);
  layout(); drawRuler(); positionOverlays();
}
export function ensureVisible(beat) {
  if (beat < viewStartBeat) scrollTo(beat - 2);
  else if (beat > viewStartBeat + viewBeats * 0.85) scrollTo(beat - viewBeats * 0.5);
}

let _layoutQueued = false;
/** Coalesce many TRACKS events into a single layout on the next frame —
 *  turns O(n²) rebuilds into O(n) when adding/removing many tracks. */
export function requestLayout() {
  if (_layoutQueued) return;
  _layoutQueued = true;
  requestAnimationFrame(() => { _layoutQueued = false; layout(); });
}

function layout() {
  const ppb = pxPerBeat();
  const totalBeats = Math.max(Store.totalBeats, viewStartBeat + viewBeats) + 8;
  const laneW = Math.max(width - HEADER_W, totalBeats * ppb);
  lanesEl.style.width = laneW + 'px';
  gridEl.style.width = (laneW + HEADER_W) + 'px';
  rulerWrap.style.width = (laneW + HEADER_W) + 'px';
  rulerCv.style.width = laneW + 'px';

  renderHeaders();
  renderLanes();
  drawRuler();
  positionOverlays();
}

/* ------------------------------------------------------------------ ruler */
function drawRuler() {
  const laneW = Math.max(1, lanesEl.clientWidth || (width - HEADER_W));
  const ctx = fitCanvas(rulerCv, laneW, 30);
  ctx.clearRect(0, 0, laneW, 30);
  ctx.fillStyle = '#141922'; ctx.fillRect(0, 0, laneW, 30);
  const ppb = pxPerBeat();
  const bpb = Store.beatsPerBar;
  const startBar = Math.floor(viewStartBeat / bpb);
  const endBar = Math.ceil((viewStartBeat + viewBeats) / bpb) + 1;

  // minor grid (beats)
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  for (let b = startBar * bpb; b <= endBar * bpb; b++) {
    const x = Math.round(beatToX(b)) + 0.5;
    if (x < -2 || x > laneW + 2) continue;
    ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, 30); ctx.stroke();
  }
  // bars
  ctx.font = '600 10px ui-monospace, monospace';
  for (let bar = startBar; bar <= endBar; bar++) {
    const b = bar * bpb;
    const x = Math.round(beatToX(b)) + 0.5;
    if (x < -40 || x > laneW + 4) continue;
    ctx.strokeStyle = bar % 4 === 0 ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.moveTo(x, bar % 4 === 0 ? 4 : 12); ctx.lineTo(x, 30); ctx.stroke();
    if (bar % 4 === 0 || ppb * bpb > 56) {
      ctx.fillStyle = bar % 4 === 0 ? '#cfe3f5' : '#6b7c91';
      ctx.fillText(String(bar + 1), x + 4, 12);
    }
  }
  // loop region on ruler
  if (Store.loopEnabled) {
    const x1 = beatToX(Store.loopStart), x2 = beatToX(Store.loopEnd);
    ctx.fillStyle = 'rgba(61,220,151,0.16)';
    ctx.fillRect(Math.max(0, x1), 0, Math.max(1, x2 - x1), 30);
  }
}

function positionOverlays() {
  const ppb = pxPerBeat();
  const b = Store.position;
  const x = beatToX(b);
  const visible = Store.playing || Store.recording || true;
  playheadEl.style.display = visible ? 'block' : 'none';
  playheadEl.style.transform = `translateX(${x}px)`;
  playheadEl.style.left = '0px';
  if (Store.loopEnabled) {
    loopEl.style.display = 'block';
    loopEl.style.transform = `translateX(${beatToX(Store.loopStart)}px)`;
    loopEl.style.width = Math.max(1, (Store.loopEnd - Store.loopStart) * ppb) + 'px';
  } else loopEl.style.display = 'none';
  updateRecLine();

  if (Store.project.view.follow && Store.playing) {
    const sx = scrollEl.scrollLeft;
    if (x < sx + 60 || x > sx + width - 160) scrollEl.scrollLeft = Math.max(0, x - width * 0.3);
  }
}

function updateRecLine() {
  if (!Store.recording) { recLineEl.style.display = 'none'; return; }
  recLineEl.style.display = 'block';
  recLineEl.style.transform = `translateX(${beatToX(Store.position)}px)`;
}

function startPlayheadLoop() {
  const loop = () => {
    rafId = requestAnimationFrame(loop);
    if (Store.playing || Store.recording) positionOverlays();
    drawLaneMeters();
  };
  loop();
}

/* ---------------------------------------------------------------- headers */
function renderHeaders() {
  clear(headersEl);
  headersEl.append(h('div', { style: { height: '30px', borderBottom: '1px solid var(--line)' } }));
  for (const t of Store.tracks) headersEl.append(trackHeader(t));
}

function trackHeader(track) {
  const sel = Store.project.selection.trackId === track.id;
  const head = h('div', { class: 'lane-head' + (sel ? ' selected' : '') + (track.armed ? ' armed' : ''),
    style: { height: TRACK_H + 'px' }, dataset: { id: track.id } });

  const color = h('div', { class: 'lh-color', style: { background: track.color }, title: 'Цвет дорожки' });
  color.onclick = (e) => {
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, TRACK_COLORS.map((c, i) => ({
      label: 'Цвет ' + (i + 1), fn: () => { track.color = c; P.markDirty(); layout(); Bus.emit(TOPICS.MIXER, {}); },
    })));
  };

  const name = h('input', { class: 'lh-name', value: track.name, title: track.name });
  name.addEventListener('change', () => { track.name = name.value || 'Track'; P.markDirty(); Bus.emit(TOPICS.MIXER, {}); });
  name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
  name.addEventListener('focus', () => select(track.id));

  const type = h('span', { class: 'lh-type' }, track.type === 'midi' ? (track.instrument?.engine === 'synth' ? 'SYNTH' : 'SAMPLER') : track.type.toUpperCase());

  const row1 = h('div', { class: 'lh-row1' }, color, name, type);

  const mk = (cls, label, title, state, fn) => {
    const b = h('button', { class: 'mini ' + cls + (state ? ' on' : ''), title }, label);
    b.onclick = (e) => { e.stopPropagation(); fn(b); };
    return b;
  };
  const mBtn = mk('m', 'M', 'Mute (M)', track.muted, () => window.__qw.toggleMute(track.id));
  const sBtn = mk('s', 'S', 'Solo (S)', track.solo, () => window.__qw.toggleSolo(track.id));
  const rBtn = mk('r', '●', 'Record / Arm (R)', track.armed, async () => {
    track.armed = !track.armed;
    rBtn.classList.toggle('on', track.armed);
    if (track.armed) {
      if (track.type === 'audio') { try { await Recorder.openMic(track, track.input?.deviceId); } catch {} }
      else await Recorder.initMidi();
    } else if (track.type === 'audio' && !Store.tracks.some(t => t.armed)) Recorder.closeMic();
    Bus.emit(TOPICS.RECORD, { armed: track.id });
    P.markDirty();
  });
  const monBtn = mk('mon', 'MON', 'Мониторинг входа — слышать себя (через FX дорожки)', track.monitor, () => {
    window.__qw.toggleMonitor(track.id);
    monBtn.classList.toggle('on', track.monitor);
  });
  const fxBtn = h('button', { class: 'mini', title: 'Открыть цепочку эффектов', onclick: (e) => { e.stopPropagation(); select(track.id); openFxRack(track.id); } }, 'FX');
  const fxCount = track.fx?.length ? h('span', { class: 'mini-fx' }, `${track.fx.length} fx`) : null;

  const vol = h('input', { class: 'slider lh-vol', type: 'range', min: -60, max: 12, step: 0.5, value: track.volumeDb, title: `Громкость: ${track.volumeDb.toFixed(1)} dB` });
  vol.addEventListener('input', () => { track.volumeDb = parseFloat(vol.value); vol.title = `${track.volumeDb.toFixed(1)} dB`; Engine.applyTrackState(track); P.markDirty(); });
  vol.addEventListener('change', () => Bus.emit(TOPICS.MIXER, { volume: track.id }));
  vol.addEventListener('pointerdown', (e) => e.stopPropagation());

  const meter = h('div', { class: 'lh-meter' }, h('i'));
  meter.dataset.track = track.id;

  const row2 = h('div', { class: 'lh-row2' }, mBtn, sBtn, rBtn, monBtn, fxBtn, vol, meter, fxCount);
  head.append(row1, row2);
  head.addEventListener('pointerdown', (e) => { if (e.target === head || e.target === type) select(track.id); });
  head.addEventListener('dblclick', () => { select(track.id); openFxRack(track.id); });
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Дублировать дорожку', fn: () => window.__qw.duplicateTrack(track.id) },
      { label: 'Очистить клипы', fn: () => window.__qw.clearClips(track.id) },
      { label: 'Открыть эффекты', fn: () => openFxRack(track.id) },
      { sep: true },
      { label: 'Заморозить (freeze)', fn: () => window.__qw.freezeTrack(track.id) },
      { sep: true },
      { label: 'Удалить дорожку', danger: true, fn: () => window.__qw.deleteTrack(track.id) },
    ]);
  });
  droppable(head, ['sample'], (payload) => {
    const s = Library.get(payload.sampleId);
    if (track.type === 'midi') {
      track.instrument.engine = 'sampler';
      track.instrument.sampleId = s.id; track.instrument.sampleName = s.name;
      if (s.keyMidi) track.instrument.rootKey = s.keyMidi;
      Bus.emit(TOPICS.TRACKS, { updated: track.id });
      toast('success', `${s.name} назначен инструментом`);
    } else addClipToTrack(track, s);
    P.markDirty();
  });
  droppable(head, ['fx'], (payload) => { window.__qw.addFx(track.id, payload.fxType); });
  droppable(head, ['fxpreset'], (payload) => { window.__qw.applyPreset(track.id, payload.preset); });
  return head;
}

function select(trackId, clipId = null) {
  Store.project.selection.trackId = trackId;
  if (clipId !== null) Store.project.selection.clipId = clipId;
  Bus.emit(TOPICS.SELECTION, {});
  Bus.emit(TOPICS.MIXER, { select: trackId });
}

function paintSelection() {
  for (const el of headersEl.children) {
    if (!el.dataset?.id) continue;
    el.classList.toggle('selected', el.dataset.id === Store.project.selection.trackId);
  }
  for (const el of lanesEl.querySelectorAll('.clip')) {
    el.classList.toggle('selected', el.dataset.clipId === Store.project.selection.clipId);
  }
}

function drawLaneMeters() {
  for (const el of headersEl.querySelectorAll('.lh-meter')) {
    const m = Engine.trackMeters.get(el.dataset.track);
    const bar = el.firstElementChild;
    if (!bar) continue;
    const lv = Math.max(m?.l || 0, m?.r || 0);
    const pct = clamp(Math.pow(lv, 0.6) * 100, 0, 100);
    bar.style.width = pct + '%';
  }
}

/* ------------------------------------------------------------------ lanes */
function renderLanes() {
  // keep overlays
  const keep = [playheadEl, loopEl, recLineEl];
  for (const c of [...lanesEl.children]) if (!keep.includes(c)) c.remove();
  for (const track of Store.tracks) {
    let lane = lanesEl.querySelector(`.lane[data-id="${track.id}"]`);
    if (!lane) {
      lane = h('div', { class: 'lane', dataset: { id: track.id }, style: { height: TRACK_H + 'px' } });
      lanesEl.insertBefore(lane, playheadEl);
      setupLaneDrops(lane, track);
    }
    lane.classList.toggle('muted', !!track.muted);
    lane.style.setProperty('--track-h', TRACK_H + 'px');
    renderClips(lane, track);
  }
  // remove lanes of deleted tracks
  for (const lane of [...lanesEl.querySelectorAll('.lane')]) {
    if (!Store.track(lane.dataset.id)) lane.remove();
  }
}

function renderClips(lane, track) {
  const ppb = pxPerBeat();
  const existing = new Map([...lane.querySelectorAll('.clip')].map(e => [e.dataset.clipId, e]));
  const seen = new Set();
  for (const clip of track.clips) {
    seen.add(clip.id);
    const x = beatToX(clip.start);
    const w = Math.max(3, clip.length * ppb);
    let el = existing.get(clip.id);
    if (!el) {
      el = buildClipEl(clip, track);
      lane.append(el);
    }
    el.style.transform = `translateX(${x}px)`;
    el.style.width = w + 'px';
    el.style.left = '0px';
    updateClipBody(el, clip, track, w);
  }
  for (const [id, el] of existing) if (!seen.has(id)) el.remove();
}

function buildClipEl(clip, track) {
  const el = h('div', {
    class: `clip ${clip.type}` + (clip.take ? ' recorded' : '') + (clip.id === Store.project.selection.clipId ? ' selected' : ''),
    dataset: { clipId: clip.id, trackId: track.id },
  });
  const head = h('div', { class: 'clip-head' },
    h('span', { class: 'clip-title' }, clip.sampleName || (clip.type === 'midi' ? `MIDI · ${clip.notes.length} нот` : 'clip')));
  const body = h('div', { class: 'clip-body' });
  const cv = h('canvas');
  body.append(cv);
  const hl = h('div', { class: 'clip-handle l' }), hr = h('div', { class: 'clip-handle r' });
  el.append(head, body, hl, hr);

  attachClipDrag(el, clip, track);
  attachClipResize(hl, hr, el, clip, track);

  el.addEventListener('pointerdown', (e) => {
    if (e.target === hl || e.target === hr) return;
    e.stopPropagation();
    select(track.id, clip.id);
  });
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    select(track.id, clip.id);
    if (clip.type === 'midi') openPianoRoll(clip.id);
    else openAudioEditor(clip.id);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    select(track.id, clip.id);
    clipMenu(clip, track, e.clientX, e.clientY);
  });
  return el;
}

function updateClipBody(el, clip, track, w) {
  const body = $('.clip-body', el);
  const cv = $('canvas', body);
  const hh = TRACK_H - 14 - 8;
  const title = $('.clip-title', el);
  if (title) title.textContent = clip.sampleName || (clip.type === 'midi' ? `MIDI · ${clip.notes?.length || 0} нот` : 'clip');

  if (clip.type === 'audio') {
    const peaks = Library.getPeaks(clip.sampleId, Math.max(32, Math.min(400, Math.floor(w / 3))));
    if (peaks) {
      const sprite = waveformSprite(clip.sampleId, peaks, Math.max(4, Math.floor(w)), hh,
        clip.take ? '#ffb3bc' : '#cfe9ff');
      const ctx = fitCanvas(cv, Math.max(4, Math.floor(w)), hh);
      ctx.clearRect(0, 0, w, hh);
      // handle offset / rate: draw a sub-range of the sprite
      const rate = clipRate(clip);
      const fullDurBeats = beatsOfSample(clip);
      const frac = fullDurBeats > 0 ? clamp(clip.length / fullDurBeats, 0.02, 1) : 1;
      const off = fullDurBeats > 0 ? clamp((clip.offset || 0) / (beatsOfSampleSeconds(clip) || 1), 0, 0.98) : 0;
      ctx.drawImage(sprite, Math.floor(off * sprite.width), 0, Math.max(2, Math.floor(sprite.width * frac)), sprite.height,
        0, 0, w, hh);
    } else {
      const ctx = fitCanvas(cv, Math.max(4, Math.floor(w)), hh);
      ctx.clearRect(0, 0, w, hh);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(0, hh / 2 - 1, w, 2);
      if (!cv.__loading) {
        cv.__loading = true;
        Library.getBuffer(clip.sampleId).then(() => { cv.__loading = false; invalidateWave(clip.sampleId); layout(); }).catch(() => { cv.__loading = false; });
      }
    }
  } else {
    const ctx = fitCanvas(cv, Math.max(4, Math.floor(w)), hh);
    ctx.clearRect(0, 0, w, hh);
    drawMiniNotes(ctx, clip, w, hh);
  }
}

function drawMiniNotes(ctx, clip, w, hh) {
  if (!clip.notes?.length) return;
  let lo = 127, hi = 0;
  for (const n of clip.notes) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
  if (lo === hi) { lo -= 2; hi += 2; }
  const span = Math.max(1, hi - lo);
  ctx.fillStyle = '#e3d6ff';
  for (const n of clip.notes) {
    const x = (n.start / clip.length) * w;
    const nw = Math.max(1.2, (n.length / clip.length) * w);
    const y = hh - ((n.midi - lo) / span) * (hh - 4) - 3;
    ctx.globalAlpha = 0.35 + 0.6 * clamp(n.velocity ?? 0.8, 0, 1);
    ctx.fillRect(x, y, nw, 2.4);
  }
  ctx.globalAlpha = 1;
}

function clipRate(clip) {
  let r = clip.playbackRate ?? 1;
  if (clip.pitch) r *= Math.pow(2, clip.pitch / 12);
  return r;
}
function beatsOfSampleSeconds(clip) {
  const s = Library.get(clip.sampleId);
  if (!s) return 0;
  return s.duration / clipRate(clip);
}
function beatsOfSample(clip) {
  const sec = beatsOfSampleSeconds(clip);
  return sec ? sec / Transport.beatsToSec(1) : 0;
}

/* ------------------------------------------------------------ clip gestures */
function attachClipDrag(el, clip, track) {
  let startBeat = 0, startLane = null, ghost = null, moved = false;
  draggable(el, {
    onStart: (s, e) => {
      if (tool === 'split') { splitClip(track, clip, xToBeat(e.clientX - lanesEl.getBoundingClientRect().left + scrollEl.scrollLeft - HEADER_W)); return; }
      if (tool === 'erase') { window.__qw.deleteClip(track.id, clip.id); return; }
      if (e.target.classList.contains('clip-handle')) return;
      startBeat = clip.start;
      startLane = track.id;
      moved = false;
      Store.pushHistory('move clip', 400);
    },
    onMove: (s, e) => {
      if (tool === 'split' || tool === 'erase') return;
      if (e.target?.classList?.contains('clip-handle')) return;
      moved = true;
      el.classList.add('dragging');
      const db = s.dx / pxPerBeat();
      clip.start = Math.max(0, snapBeat(startBeat + db));
      el.style.transform = `translateX(${beatToX(clip.start)}px)`;
      // cross-lane move
      const lanes = [...lanesEl.querySelectorAll('.lane')];
      const y = e.clientY;
      for (const lane of lanes) {
        const r = lane.getBoundingClientRect();
        if (y >= r.top && y <= r.bottom && lane.dataset.id !== track.id) {
          const t2 = Store.track(lane.dataset.id);
          if (t2 && ((t2.type === 'midi') === (clip.type === 'midi'))) {
            moveClipToTrack(clip, t2);
            return;
          }
        }
      }
    },
    onEnd: () => {
      el.classList.remove('dragging');
      if (moved) { P.markDirty(); layout(); Bus.emit(TOPICS.TRANSPORT, {}); }
      Transport.invalidate();
    },
  });
}

function moveClipToTrack(clip, newTrack) {
  const old = Store.clipTrack(clip.id);
  if (!old || old.id === newTrack.id) return;
  old.clips = old.clips.filter(c => c.id !== clip.id);
  clip.trackId = newTrack.id;
  newTrack.clips.push(clip);
  Store.project.selection.trackId = newTrack.id;
  layout();
  P.markDirty();
}

function attachClipResize(hl, hr, el, clip, track) {
  const setup = (handle, side) => {
    let startBeat = 0, startLen = 0, startOff = 0;
    draggable(handle, {
      onStart: () => { startBeat = clip.start; startLen = clip.length; startOff = clip.offset || 0; Store.pushHistory('resize clip', 400); },
      onMove: (s) => {
        const db = s.dx / pxPerBeat();
        if (side === 'r') {
          clip.length = Math.max(snap || 1 / 16, snapBeat(startLen + db));
        } else {
          const nb = Math.max(0, Math.min(startBeat + startLen - (snap || 1 / 16), snapBeat(startBeat + db)));
          const delta = nb - startBeat;
          clip.start = nb;
          clip.length = Math.max(snap || 1 / 16, startLen - delta);
          if (clip.type === 'audio') clip.offset = Math.max(0, startOff + Transport.beatsToSec(delta) * clipRate(clip));
        }
        el.style.width = Math.max(3, clip.length * pxPerBeat()) + 'px';
        el.style.transform = `translateX(${beatToX(clip.start)}px)`;
        updateClipBody(el, clip, track, Math.max(3, clip.length * pxPerBeat()));
      },
      onEnd: () => { P.markDirty(); Transport.invalidate(); layout(); },
    });
  };
  setup(hl, 'l'); setup(hr, 'r');
}

function splitClip(track, clip, atBeat) {
  Store.pushHistory('split clip');
  const rel = atBeat - clip.start;
  if (rel <= 0.01 || rel >= clip.length - 0.01) return;
  const right = JSON.parse(JSON.stringify(clip));
  right.id = uid('clip');
  if (clip.type === 'audio') {
    right.offset = (clip.offset || 0) + Transport.beatsToSec(rel) * clipRate(clip);
    right.start = clip.start + rel;
    right.length = clip.length - rel;
    clip.length = rel;
  } else {
    right.notes = clip.notes.filter(n => n.start >= rel).map(n => ({ ...n, start: n.start - rel }));
    clip.notes = clip.notes.filter(n => n.start < rel).map(n => ({ ...n, length: Math.min(n.length, rel - n.start) }));
    right.start = clip.start + rel;
    right.length = clip.length - rel;
    clip.length = rel;
  }
  track.clips.push(right);
  P.markDirty(); Transport.invalidate(); layout();
  Bus.emit(TOPICS.TOAST, { kind: 'info', text: 'Клип разделён' });
}

function clipMenu(clip, track, x, y) {
  const items = [
    { label: 'Открыть в редакторе', fn: () => clip.type === 'midi' ? openPianoRoll(clip.id) : openAudioEditor(clip.id) },
    { label: 'Дублировать (Ctrl+D)', fn: () => window.__qw.duplicateClip(track.id, clip.id) },
    { label: 'Разделить по плейхеду (S)', fn: () => splitClip(track, clip, Store.position) },
    { sep: true },
  ];
  if (clip.type === 'audio') {
    items.push(
      { label: 'Включить/выключить луп', fn: () => { clip.loop = !clip.loop; P.markDirty(); Transport.invalidate(); layout(); } },
      { label: 'Реверс', fn: () => { clip.reversed = !clip.reversed; invalidateWave(clip.sampleId); P.markDirty(); layout(); } },
      { label: 'Подогнать под темп (warp)', fn: () => {
          const s = Library.get(clip.sampleId);
          clip.warp = !clip.warp;
          if (clip.warp && !clip.warpBpm) clip.warpBpm = s?.bpm || Store.project.bpm;
          P.markDirty(); Transport.invalidate(); layout();
          toast('info', clip.warp ? `Warp вкл · ${clip.warpBpm} BPM → ${Store.project.bpm} BPM` : 'Warp выкл');
        } },
      { label: 'Тональность +1', fn: () => { clip.pitch = (clip.pitch || 0) + 1; P.markDirty(); layout(); } },
      { label: 'Тональность −1', fn: () => { clip.pitch = (clip.pitch || 0) - 1; P.markDirty(); layout(); } },
      { sep: true },
      { label: 'Питч-коррекция / тюнинг вокала…', fn: () => openAudioEditor(clip.id, true) },
    );
  } else {
    items.push(
      { label: 'Квантовать ноты', fn: () => { window.__qw.quantizeClip(clip.id); } },
      { label: 'Транспонировать +12', fn: () => { for (const n of clip.notes) n.midi = clamp(n.midi + 12, 0, 127); P.markDirty(); layout(); } },
      { label: 'Транспонировать −12', fn: () => { for (const n of clip.notes) n.midi = clamp(n.midi - 12, 0, 127); P.markDirty(); layout(); } },
    );
  }
  items.push({ sep: true }, { label: 'Удалить клип', danger: true, fn: () => window.__qw.deleteClip(track.id, clip.id) });
  showContextMenu(x, y, items);
}

/* ------------------------------------------------------------ lane gestures */
function setupLaneDrops(lane, track) {
  droppable(lane, ['sample'], (payload, e) => {
    const s = Library.get(payload.sampleId);
    if (!s) return;
    const rect = lanesEl.getBoundingClientRect();
    const beat = snapBeat(xToBeat(e.clientX - rect.left));
    if (track.type === 'midi') {
      track.instrument.engine = 'sampler';
      track.instrument.sampleId = s.id; track.instrument.sampleName = s.name;
      if (s.keyMidi) track.instrument.rootKey = s.keyMidi;
      Bus.emit(TOPICS.TRACKS, { updated: track.id });
      toast('success', `${s.name} → инструмент дорожки`);
    } else {
      addClipToTrack(track, s, beat);
    }
    P.markDirty();
  });
  droppable(lane, ['fx'], (payload) => window.__qw.addFx(track.id, payload.fxType));
}

function onLanesDown(e) {
  if (e.target !== lanesEl && !e.target.classList.contains('lane')) return;
  const rect = lanesEl.getBoundingClientRect();
  const beat = xToBeat(e.clientX - rect.left);
  if (tool === 'draw') {
    const track = Store.track(e.target.dataset?.id) || Store.selectedTrack;
    if (track && track.type === 'midi') {
      const clip = { id: uid('clip'), type: 'midi', trackId: track.id, start: snapBeat(beat), length: Store.beatsPerBar, notes: [], automation: {}, color: track.color };
      Store.pushHistory('draw clip');
      track.clips.push(clip);
      P.markDirty(); layout(); Transport.invalidate();
      select(track.id, clip.id);
      openPianoRoll(clip.id);
      return;
    }
    if (track && track.type === 'audio') {
      const clip = { id: uid('clip'), type: 'audio', trackId: track.id, start: snapBeat(beat), length: Store.beatsPerBar,
        sampleId: null, sampleName: '(пусто)', offset: 0, playbackRate: 1, pitch: 0, gain: 1, fade: 0.005, loop: false, color: track.color };
      Store.pushHistory('draw clip');
      track.clips.push(clip);
      P.markDirty(); layout(); Transport.invalidate();
      select(track.id, clip.id);
      toast('info', 'Перетащите сэмпл из браузера на этот клип');
      return;
    }
  }
  Store.project.selection.clipId = null;
  if (e.target.dataset?.id) select(e.target.dataset.id, null);
  else Store.project.selection.trackId = null;
  Bus.emit(TOPICS.SELECTION, {});
  Transport.seek(snapBeat(beat));
}

function onRulerDown(e) {
  const rect = rulerCv.getBoundingClientRect();
  const beat = Math.max(0, xToBeat(e.clientX - rect.left));
  const isShift = e.shiftKey;
  if (isShift) {
    // drag loop region
    const start = snapBeat(beat);
    const move = (ev) => {
      const b2 = Math.max(0, snapBeat(xToBeat(ev.clientX - rect.left)));
      Transport.setLoop(Math.min(start, b2), Math.max(start + snap, b2), true);
      drawRuler(); positionOverlays();
    };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    Transport.setLoop(start, start + Store.beatsPerBar, true);
  } else {
    Transport.seek(snapBeat(beat));
    const move = (ev) => Transport.seek(Math.max(0, snapBeat(xToBeat(ev.clientX - rect.left))));
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }
  drawRuler(); positionOverlays();
}

export function viewState() { return { viewStartBeat, viewBeats, pxPerBeat: pxPerBeat(), tool, snap }; }
export { TRACK_H, HEADER_W, xToBeat, beatToX, layout, setZoom, scrollTo };
export default { mountArranger, layout, setZoom, scrollTo, ensureVisible };
