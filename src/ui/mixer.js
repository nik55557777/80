/**
 * QwenWave — Mixer.
 * Master section (mastering chain + spectrum + LUFS) plus one channel strip
 * per track. Meters are drawn from a single rAF loop over cached canvases,
 * so 60+ channels cost one animation frame, not 60.
 */
import Store, { Bus, TOPICS, clamp, dbToGain, gainToDb } from '../core/store.js';
import Engine from '../engine/engine.js';
import Transport from '../engine/transport.js';
import Recorder from '../engine/recorder.js';
import { MASTERING_PRESETS } from '../engine/engine.js';
import { measure } from '../engine/exporter.js';
import * as P from '../engine/persistence.js';
import { h, $, clear, fitCanvas, drawMeter, icon, toast, observeSize, select, toggle, slider } from './dom.js';
import { openFxRack } from './fxrack.js';
import { showContextMenu } from './browser.js';

let root, stripWrap, masterEl;
const chans = new Map();       // trackId -> {el, meterCv, meterCtx, fader, dbLbl, fxLbl, meter}
let raf = null;
let spectrumCv = null, spectrumCtx = null;
let masterStats = { lufs: null, peak: null };

export function mountMixer(el) {
  root = el;
  build();
  Bus.on(TOPICS.TRACKS, () => build());
  Bus.on(TOPICS.MIXER, () => refreshValues());
  Bus.on(TOPICS.MASTER, () => refreshMaster());
  if (!raf) loop();
}

function build() {
  clear(root);
  root.className = 'bottom-panel fill';
  const wrap = h('div', { class: 'mixer' });
  root.append(wrap);
  masterEl = buildMaster();
  wrap.append(masterEl);
  wrap.append(h('div', { style: { width: '1px', background: 'var(--line)', margin: '0 4px', alignSelf: 'stretch' } }));
  stripWrap = h('div', { style: { display: 'flex', gap: '4px', alignItems: 'stretch' } });
  wrap.append(stripWrap);
  chans.clear();
  for (const t of Store.tracks) stripWrap.append(buildChannel(t));
  if (!Store.tracks.length) {
    stripWrap.append(h('div', { class: 'empty-state' }, h('h4', {}, 'Нет дорожек'),
      h('div', { class: 'hint' }, 'Создайте аудио- или MIDI-дорожку на панели аранжировки.')));
  }
}

/* ----------------------------------------------------------------- master */
function buildMaster() {
  const el = h('div', { class: 'chan master' });
  const m = Store.project.master;
  el.append(h('div', { class: 'chan-name', style: { borderTopColor: 'var(--warn)' } }, 'MASTER'));

  spectrumCv = h('canvas', { style: { width: '100%', height: '54px', background: '#05070a', borderRadius: '4px', border: '1px solid var(--line)' } });
  const statsRow = h('div', { class: 'row', style: { justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: '9.5px', color: 'var(--text-3)' } },
    h('span', { id: 'm-lufs' }, 'LUFS —'),
    h('span', { id: 'm-peak' }, 'PEAK —'));
  el.append(spectrumCv, statsRow);

  const masterTgl = toggle({ label: 'Мастеринг', value: !!m.mastering.enabled, onChange: (v) => {
    Store.pushHistory('mastering toggle');
    m.mastering.enabled = v; Engine.applyMasterSettings(); P.markDirty(); refreshMaster();
    Bus.emit(TOPICS.MASTER, {});
  } });
  const presetSel = select({ label: '', options: Object.entries(MASTERING_PRESETS).map(([k, v]) => ({ value: k, label: v.name })),
    value: m.mastering.preset, onChange: (v) => { m.mastering.preset = v; Engine.applyMasterSettings(); P.markDirty(); Bus.emit(TOPICS.MASTER, {}); } });
  presetSel.style.width = '100%';
  const amount = slider({ label: 'Amount', min: 0, max: 1, step: 0.01, value: m.mastering.amount,
    format: (v) => (v * 100).toFixed(0) + '%',
    onInput: (v) => { m.mastering.amount = v; Engine.applyMasterSettings(); P.markDirty(); } });
  el.append(masterTgl, presetSel, amount);

  const ceil = slider({ label: 'Ceiling', min: -12, max: -0.1, step: 0.1, value: m.limiterCeilDb, unit: ' dB',
    onInput: (v) => { m.limiterCeilDb = v; Engine.applyMasterSettings(); P.markDirty(); } });
  el.append(ceil);

  // fader + meter
  const mid = h('div', { class: 'chan-mid' });
  const meterCv = h('canvas', { class: 'meter-canvas' });
  const fcol = h('div', { class: 'fader-col' });
  const fader = h('input', { class: 'fader', type: 'range', min: -60, max: 12, step: 0.5, value: m.volumeDb });
  const dbLbl = h('div', { class: 'db-label' }, m.volumeDb.toFixed(1) + ' dB');
  fader.addEventListener('input', () => {
    m.volumeDb = parseFloat(fader.value);
    dbLbl.textContent = m.volumeDb.toFixed(1) + ' dB';
    Engine.applyMasterSettings(); P.markDirty();
  });
  fader.addEventListener('dblclick', () => { m.volumeDb = 0; fader.value = 0; dbLbl.textContent = '0.0 dB'; Engine.applyMasterSettings(); P.markDirty(); });
  const panKnob = h('div', { class: 'chan-knobs' },
    miniKnob('Width', m.width ?? 100, 0, 250, (v) => { m.width = v; P.markDirty(); Bus.emit(TOPICS.MASTER, {}); }));
  fcol.append(panKnob, fader, dbLbl);
  mid.append(meterCv, fcol);
  el.append(mid);
  el.append(h('div', { class: 'chan-fx' }, `${m.fx.length} insert(s)`));
  el.dataset.master = '1';
  el.addEventListener('dblclick', () => openFxRack('__master__'));

  el._refs = { meterCv, fader, dbLbl, presetSel, amount, ceil, masterTgl };
  observeSize(meterCv, () => {});
  return el;
}

function miniKnob(label, value, min, max, onChange) {
  const wrap = h('div', { class: 'knob-wrap', style: { width: '56px' } });
  const cv = h('canvas', { width: 68, height: 68, style: { width: '34px', height: '34px', cursor: 'ns-resize' } });
  const val = h('div', { class: 'knob-val' }, String(Math.round(value)));
  const lab = h('div', { class: 'knob-label' }, label);
  const ctx = cv.getContext('2d');
  let v = value;
  function draw() {
    const s = 68, c = s / 2, r = s * 0.34;
    ctx.clearRect(0, 0, s, s);
    ctx.lineWidth = s * 0.1; ctx.lineCap = 'round';
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath(); ctx.arc(c, c, r, a0, a1); ctx.stroke();
    const norm = (v - min) / (max - min);
    const end = a0 + clamp(norm, 0, 1) * (a1 - a0);
    ctx.strokeStyle = '#ffc857';
    ctx.beginPath(); ctx.arc(c, c, r, a0, end); ctx.stroke();
    ctx.strokeStyle = '#e8f4ff'; ctx.lineWidth = s * 0.07;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(end) * r * 0.4, c + Math.sin(end) * r * 0.4);
    ctx.lineTo(c + Math.cos(end) * r * 0.85, c + Math.sin(end) * r * 0.85);
    ctx.stroke();
    val.textContent = String(Math.round(v));
  }
  let y0 = 0, v0 = 0;
  cv.addEventListener('pointerdown', (e) => { y0 = e.clientY; v0 = v; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => {
    if (y0 === null) return;
    if (!e.buttons) return;
    v = clamp(v0 - (e.clientY - y0) / 140 * (max - min), min, max);
    draw(); onChange(v);
  });
  cv.addEventListener('pointerup', () => { y0 = null; });
  cv.addEventListener('dblclick', () => { v = value; draw(); onChange(v); });
  draw();
  wrap.append(cv, val, lab);
  wrap.setValue = (x) => { v = x; draw(); };
  return wrap;
}

/* ---------------------------------------------------------------- channel */
function buildChannel(track) {
  const el = h('div', { class: 'chan' + (Store.project.selection.trackId === track.id ? ' sel' : ''), dataset: { id: track.id } });
  el.append(h('div', { class: 'chan-name', style: { borderTopColor: track.color } }, track.name));

  const btns = h('div', { class: 'chan-btns' });
  const mBtn = h('button', { class: 'mini m' + (track.muted ? ' on' : ''), title: 'Mute' }, 'M');
  const sBtn = h('button', { class: 'mini s' + (track.solo ? ' on' : ''), title: 'Solo' }, 'S');
  const rBtn = h('button', { class: 'mini r' + (track.armed ? ' on' : ''), title: 'Record arm' }, '●');
  const monBtn = h('button', { class: 'mini mon' + (track.monitor ? ' on' : ''), title: 'Мониторинг входа (слышать себя)' }, 'M▸');
  mBtn.onclick = () => window.__qw.toggleMute(track.id);
  sBtn.onclick = () => window.__qw.toggleSolo(track.id);
  rBtn.onclick = async () => {
    track.armed = !track.armed; rBtn.classList.toggle('on', track.armed);
    if (track.armed && track.type === 'audio') { try { await Recorder.openMic(track, track.input?.deviceId); } catch {} }
    else if (!track.armed && track.type === 'audio' && !Store.tracks.some(t => t.armed)) Recorder.closeMic();
    Bus.emit(TOPICS.RECORD, {}); P.markDirty();
  };
  monBtn.onclick = () => window.__qw.toggleMonitor(track.id);
  btns.append(mBtn, sBtn, rBtn, monBtn);
  el.append(btns);

  const mid = h('div', { class: 'chan-mid' });
  const meterCv = h('canvas', { class: 'meter-canvas' });
  const fcol = h('div', { class: 'fader-col' });
  const knobs = h('div', { class: 'chan-knobs' });
  const panKnob = miniKnob('Pan', track.pan * 100, -100, 100, (v) => { track.pan = v / 100; Engine.applyTrackState(track); P.markDirty(); });
  knobs.append(panKnob);
  if (track.type === 'midi') {
    knobs.append(miniKnob('Cut', track.instrument.filterHz, 100, 18000, (v) => { track.instrument.filterHz = v; P.markDirty(); }));
    knobs.append(miniKnob('Res', track.instrument.resonance * 10, 0.5, 200, (v) => { track.instrument.resonance = v / 10; P.markDirty(); }));
  } else {
    knobs.append(miniKnob('Gain', (track.input?.gain ?? 1) * 100, 0, 300, (v) => { (track.input ||= {}).gain = v / 100; Engine._updateMonitor(track); P.markDirty(); }));
  }
  const fader = h('input', { class: 'fader', type: 'range', min: -60, max: 12, step: 0.5, value: track.volumeDb });
  const dbLbl = h('div', { class: 'db-label' }, track.volumeDb.toFixed(1));
  fader.addEventListener('input', () => {
    track.volumeDb = parseFloat(fader.value);
    dbLbl.textContent = track.volumeDb.toFixed(1);
    Engine.applyTrackState(track); P.markDirty();
  });
  fader.addEventListener('change', () => Bus.emit(TOPICS.MIXER, {}));
  fader.addEventListener('dblclick', () => { track.volumeDb = 0; fader.value = 0; dbLbl.textContent = '0.0'; Engine.applyTrackState(track); P.markDirty(); });
  fcol.append(knobs, fader, dbLbl);
  mid.append(meterCv, fcol);
  el.append(mid);

  const fxLbl = h('div', { class: 'chan-fx' }, fxLabel(track));
  el.append(fxLbl);

  el.addEventListener('click', () => selectTrack(track.id));
  el.addEventListener('dblclick', (e) => { e.stopPropagation(); openFxRack(track.id); });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Открыть FX-цепочку', fn: () => openFxRack(track.id) },
      { label: 'Дублировать дорожку', fn: () => window.__qw.duplicateTrack(track.id) },
      { label: 'Заморозить / разморозить', fn: () => window.__qw.freezeTrack(track.id) },
      { sep: true },
      { label: 'Сбросить громкость', fn: () => { track.volumeDb = 0; Engine.applyTrackState(track); build(); } },
      { label: 'Удалить дорожку', danger: true, fn: () => window.__qw.deleteTrack(track.id) },
    ]);
  });

  const mctx = meterCv.getContext('2d');
  chans.set(track.id, { el, track, meterCv, mctx, fader, dbLbl, fxLbl, mBtn, sBtn, rBtn, monBtn, panKnob });
  return el;
}

function fxLabel(track) {
  const fx = track.fx || [];
  if (!fx.length) return track.type === 'midi' ? (track.instrument?.engine === 'synth' ? 'synth · no fx' : 'sampler · no fx') : 'no fx';
  const names = fx.map(f => (f.bypassed ? '○' : '●') + (f.name || f.type));
  return names.length > 2 ? `${names.slice(0, 2).join(' ')} +${names.length - 2}` : names.join(' ');
}

/* ------------------------------------------------------------------ sync */
export function selectTrack(id) {
  Store.project.selection.trackId = id;
  Bus.emit(TOPICS.SELECTION, {});
  Bus.emit(TOPICS.TRACKS, {});
}

function refreshValues() {
  for (const [id, c] of chans) {
    const t = Store.track(id);
    if (!t) { c.el.remove(); chans.delete(id); continue; }
    c.mBtn.classList.toggle('on', t.muted);
    c.sBtn.classList.toggle('on', t.solo);
    c.rBtn.classList.toggle('on', t.armed);
    c.monBtn.classList.toggle('on', t.monitor);
    c.el.classList.toggle('sel', Store.project.selection.trackId === id);
    if (document.activeElement !== c.fader) { c.fader.value = t.volumeDb; c.dbLbl.textContent = t.volumeDb.toFixed(1); }
    c.fxLbl.textContent = fxLabel(t);
    const nm = $('.chan-name', c.el);
    if (nm && nm.textContent !== t.name) { nm.textContent = t.name; nm.style.borderTopColor = t.color; }
  }
}

function refreshMaster() {
  if (!masterEl?._refs) return;
  const m = Store.project.master;
  const r = masterEl._refs;
  r.masterTgl.setValue?.(m.mastering.enabled);
  r.presetSel.setValue?.(m.mastering.preset);
  r.amount.setValue?.(m.mastering.amount);
  r.ceil.setValue?.(m.limiterCeilDb);
  if (document.activeElement !== r.fader) { r.fader.value = m.volumeDb; r.dbLbl.textContent = m.volumeDb.toFixed(1) + ' dB'; }
}

/* ------------------------------------------------------------- rAF meters */
let lastStats = 0;
function loop() {
  raf = requestAnimationFrame(loop);
  if (!root.classList.contains('active')) return;
  const mm = Engine.masterMeter;
  // track meters
  for (const [id, c] of chans) {
    const d = Engine.trackMeters.get(id);
    const r = c.meterCv.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const ctx = fitCanvas(c.meterCv, r.width, r.height);
    ctx.clearRect(0, 0, r.width, r.height);
    if (d) drawMeter(ctx, 0, 0, r.width, r.height, d.l, d.r, d.clip);
    // input meter while recording/monitoring
    if (c.track.armed && Recorder.monitorEnabled && Recorder.activeTrackId === id) {
      const lv = Recorder.inputLevel.peak;
      ctx.fillStyle = 'rgba(255,59,82,0.85)';
      const hh = clamp(Math.pow(lv, 0.6), 0, 1) * r.height;
      ctx.fillRect(r.width - 3, r.height - hh, 3, hh);
    }
  }
  // master meter + spectrum
  if (masterEl?._refs) {
    const c = masterEl._refs.meterCv;
    const r = c.getBoundingClientRect();
    if (r.width > 2) {
      const ctx = fitCanvas(c, r.width, r.height);
      ctx.clearRect(0, 0, r.width, r.height);
      drawMeter(ctx, 0, 0, r.width, r.height, mm.l, mm.r, mm.clip);
      if (mm.clip) { setTimeout(() => { mm.clip = 0; }, 400); }
    }
  }
  drawSpectrum();
  const now = performance.now();
  if (now - lastStats > 900) {
    lastStats = now;
    updateStats();
  }
}

function drawSpectrum() {
  if (!spectrumCv) return;
  const r = spectrumCv.getBoundingClientRect();
  if (r.width < 4) return;
  const ctx = fitCanvas(spectrumCv, r.width, r.height);
  ctx.clearRect(0, 0, r.width, r.height);
  ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, r.width, r.height);
  const data = Engine.getSpectrum();
  // grid
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
  const sr = Engine.sampleRate;
  for (const f of [100, 500, 1000, 5000, 10000]) {
    const x = logX(f, sr, r.width);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, r.height); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.font = '8px ui-monospace, monospace';
    ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), x + 2, r.height - 2);
  }
  if (!data) return;
  const n = data.length;
  ctx.beginPath();
  ctx.moveTo(0, r.height);
  const grad = ctx.createLinearGradient(0, r.height, 0, 0);
  grad.addColorStop(0, 'rgba(89,200,255,0.35)');
  grad.addColorStop(1, 'rgba(178,141,255,0.9)');
  for (let px = 0; px < r.width; px++) {
    const f = Math.pow(10, (px / r.width) * Math.log10(sr / 2)) * 20;
    const idx = clamp(Math.floor((f / (sr / 2)) * n), 0, n - 1);
    const v = data[idx] / 255;
    const y = r.height - Math.pow(v, 0.85) * (r.height - 4);
    ctx.lineTo(px, y);
  }
  ctx.lineTo(r.width, r.height);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.strokeStyle = 'rgba(200,240,255,0.75)'; ctx.lineWidth = 1;
  ctx.stroke();
}
function logX(f, sr, w) {
  return (Math.log10(f / 20) / Math.log10((sr / 2) / 20)) * w;
}

async function updateStats() {
  const lufsEl = $('#m-lufs'), peakEl = $('#m-peak');
  if (!lufsEl) return;
  const mm = Engine.masterMeter;
  peakEl.textContent = `PEAK ${gainToDb(Math.max(mm.l, mm.r)).toFixed(1)} dB`;
  peakEl.style.color = Math.max(mm.l, mm.r) > 0.98 ? 'var(--err)' : '';
  // rough integrated LUFS from short-window RMS when idle measurement isn't run
  if (Store.playing) {
    const rms = Math.max(mm.rl || 0, mm.rr || 0);
    const approx = -0.691 + 10 * Math.log10(Math.max(rms * rms, 1e-9));
    lufsEl.textContent = `≈ ${approx.toFixed(1)} LUFS`;
  } else if (masterStats.lufs !== null) {
    lufsEl.textContent = `${masterStats.lufs.toFixed(1)} LUFS`;
  }
}

export function setLastRenderStats(stats) {
  masterStats = stats || { lufs: null, peak: null };
  const el = $('#m-lufs');
  if (el && stats?.lufs != null) el.textContent = `${stats.lufs.toFixed(2)} LUFS`;
}

export function refreshMixer() { build(); }
export default { mountMixer, selectTrack, refreshMixer, refreshValues, setLastRenderStats };
