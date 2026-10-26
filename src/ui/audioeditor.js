/**
 * QwenWave — Audio clip editor.
 * Waveform view with trim/fades/normalise/reverse/time-stretch plus the
 * VOCAL PROCESSING studio: pitch detection → note segments → scale
 * quantisation → granular re-tune (non-destructive: the corrected take is
 * stored as a new library sample and swapped into the clip).
 */
import Store, { Bus, TOPICS, clamp, uid, SCALES, noteName, snapToScale } from '../core/store.js';
import Engine from '../engine/engine.js';
import Library, { computePeaks } from '../engine/library.js';
import Transport from '../engine/transport.js';
import { saveTakeAsSample, encodeWav } from '../engine/recorder.js';
import { analysePitch, smoothPitchTrack, segmentNotes, correctPitch, notesToMidi, timeStretch } from '../engine/pitchcorrection.js';
import * as P from '../engine/persistence.js';
import { h, $, clear, fitCanvas, observeSize, drawWaveform, toast, buildParamControl, select, toggle, slider, numInput } from './dom.js';
import { showContextMenu } from './browser.js';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
let root, cv, wrapEl, infoEl, toolbarEl;
let clipId = null;
let view = { zoom: 1, offset: 0 };
let analysis = null;      // {frames, notes}
let busy = false;

export function openAudioEditor(id, openPitchTab = false) {
  clipId = id;
  const panel = $('#panel-audio');
  if (!panel) return;
  document.querySelectorAll('.bottom-panel').forEach(p => p.classList.remove('active'));
  panel.classList.add('active');
  document.querySelectorAll('.bt').forEach(b => b.classList.toggle('active', b.dataset.panel === 'audio'));
  build();
  analysis = null;
  requestAnimationFrame(() => { fit(); draw(); });
  if (openPitchTab) switchTab('pitch');
}

function getClip() { return clipId ? Store.clip(clipId) : null; }

let curTab = 'edit';
function switchTab(t) {
  curTab = t;
  buildToolbar(toolbarEl);
  if (t === 'pitch' && !analysis) runAnalysis();
}

function build() {
  root = $('#panel-audio');
  if (!root) return;
  if (root.dataset.built) { buildToolbar(toolbarEl); fit(); draw(); return; }
  root.dataset.built = '1';
  const __act = root.classList.contains('active');
  clear(root);
  root.className = 'bottom-panel fill' + (__act ? ' active' : '');
  root.id = 'panel-audio';
  root.style.flexDirection = 'column';

  toolbarEl = h('div', { class: 'pr-toolbar' });
  const canvasWrap = h('div', { style: { flex: '1', minHeight: '0', position: 'relative', overflow: 'hidden' } });
  cv = h('canvas', { style: { position: 'absolute', inset: '0', width: '100%', height: '100%', cursor: 'crosshair' } });
  infoEl = h('div', { class: 'small muted', style: { position: 'absolute', right: '8px', top: '6px', background: 'rgba(0,0,0,0.5)', padding: '2px 7px', borderRadius: '4px', fontFamily: 'var(--mono)', pointerEvents: 'none' } });
  canvasWrap.append(cv, infoEl);
  root.append(toolbarEl, canvasWrap);
  wrapEl = canvasWrap;

  observeSize(canvasWrap, () => { fit(); draw(); });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = e.deltaY > 0 ? 0.85 : 1.18;
    view.zoom = clamp(view.zoom * f, 1, 400);
    draw();
  }, { passive: false });
  cv.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect();
    const clip = getClip();
    if (!clip) return;
    const frac = (e.clientX - r.left) / r.width;
    const t = frac * clip.length * Transport.beatsToSec(1);
    infoEl.textContent = `${t.toFixed(3)} s  ·  beat ${(clip.start + frac * clip.length).toFixed(2)}`;
  });
  cv.addEventListener('pointerdown', (e) => {
    const r = cv.getBoundingClientRect();
    const clip = getClip(); if (!clip) return;
    const frac = clamp((e.clientX - r.left) / r.width, 0, 1);
    const beat = clip.start + frac * clip.length;
    Transport.seek(beat);
  });
  buildToolbar(toolbarEl);
}

function buildToolbar(tb) {
  if (!tb) return;
  clear(tb);
  const clip = getClip();
  if (!clip) { tb.append(h('div', { class: 'hint' }, 'Выберите аудио-клип на аранжировке (или запишите вокал).')); return; }
  const track = Store.clipTrack(clip.id);
  const s = Library.get(clip.sampleId);

  tb.append(
    h('span', { class: 'badge', style: { background: 'var(--clip-audio)', color: '#fff' } }, 'AUDIO'),
    h('span', { class: 'mono small nowrap' }, clip.sampleName || '—'),
    h('span', { class: 'small muted nowrap' }, s ? `${s.duration?.toFixed(2)}s · ${s.channels}ch · ${s.sampleRate / 1000}k` : 'нет данных'),
    h('div', { class: 'tb-sep' }),
    tabBtn('edit', 'Редактор'),
    tabBtn('pitch', 'Питч-коррекция вокала'),
    h('div', { class: 'spacer' }),
  );

  if (curTab === 'edit') {
    tb.append(
      h('button', { class: 'btn btn-sm', onclick: () => playClip() }, '▶ Прослушать'),
      h('button', { class: 'btn btn-sm', title: 'Нормализовать пики до -0.3 dB', onclick: () => process('normalize') }, 'Normalize'),
      h('button', { class: 'btn btn-sm', title: 'Убрать тишину по краям', onclick: () => process('trim') }, 'Trim silence'),
      h('button', { class: 'btn btn-sm', onclick: () => process('reverse') }, 'Reverse'),
      h('div', { class: 'tb-sep' }),
    );
    const pitch = numInput({ label: 'Pitch', value: clip.pitch || 0, min: -36, max: 36, step: 1, unit: ' st', width: 58,
      onChange: (v) => { Store.pushHistory('pitch', 300); clip.pitch = v; P.markDirty(); Transport.invalidate(); Bus.emit(TOPICS.TRACKS, {}); } });
    const rate = numInput({ label: 'Rate', value: +(clip.playbackRate || 1).toFixed(3), min: 0.25, max: 4, step: 0.01, unit: '×', width: 62,
      onChange: (v) => { Store.pushHistory('rate', 300); clip.playbackRate = v; P.markDirty(); Transport.invalidate(); Bus.emit(TOPICS.TRACKS, {}); } });
    const gain = slider({ label: 'Gain', min: 0, max: 2, step: 0.01, value: clip.gain ?? 1,
      onInput: (v) => { clip.gain = v; P.markDirty(); Transport.invalidate(); } });
    gain.style.width = '130px';
    const fade = numInput({ label: 'Fade', value: +((clip.fade ?? 0.005) * 1000).toFixed(0), min: 0, max: 500, step: 1, unit: ' ms', width: 58,
      onChange: (v) => { clip.fade = v / 1000; P.markDirty(); Transport.invalidate(); } });
    const warp = toggle({ label: 'Warp', value: !!clip.warp, onChange: (v) => { clip.warp = v; if (v && !clip.warpBpm) clip.warpBpm = s?.bpm || Store.project.bpm; P.markDirty(); Transport.invalidate(); Bus.emit(TOPICS.TRACKS, {}); } });
    const warpBpm = numInput({ label: 'Src BPM', value: clip.warpBpm || s?.bpm || Store.project.bpm, min: 20, max: 400, step: 1, width: 60,
      onChange: (v) => { clip.warpBpm = v; P.markDirty(); Transport.invalidate(); } });
    const loop = toggle({ label: 'Loop', value: !!clip.loop, onChange: (v) => { clip.loop = v; P.markDirty(); Transport.invalidate(); } });
    tb.append(pitch, rate, gain, fade, warp, warpBpm, loop);
  } else {
    const scaleSel = select({ label: 'Гамма', options: Object.keys(SCALES), value: track?.pitchCorrection?.scale || Store.project.key.scale,
      onChange: (v) => { (track.pitchCorrection ||= {}).scale = v; P.markDirty(); } });
    const rootSel = select({ label: 'Тоника', options: NOTE_NAMES, value: NOTE_NAMES[track?.pitchCorrection?.root ?? Store.project.key.root],
      onChange: (v) => { (track.pitchCorrection ||= {}).root = NOTE_NAMES.indexOf(v); P.markDirty(); } });
    const strength = slider({ label: 'Сила', min: 0, max: 1, step: 0.01, value: track?.pitchCorrection?.strength ?? 1,
      format: (v) => (v * 100).toFixed(0) + '%',
      onInput: (v) => { (track.pitchCorrection ||= {}).strength = v; P.markDirty(); } });
    strength.style.width = '120px';
    const quant = toggle({ label: 'Квантовать ноты', value: track?.pitchCorrection?.quantize !== false,
      onChange: (v) => { (track.pitchCorrection ||= {}).quantize = v; P.markDirty(); } });
    const flat = slider({ label: 'Убрать вибрато', min: 0, max: 1, step: 0.01, value: track?.pitchCorrection?.flatten ?? 0,
      format: (v) => (v * 100).toFixed(0) + '%',
      onInput: (v) => { (track.pitchCorrection ||= {}).flatten = v; } });
    flat.style.width = '120px';
    const formant = slider({ label: 'Формант', min: -12, max: 12, step: 0.5, value: track?.pitchCorrection?.formant ?? 0,
      format: (v) => v.toFixed(1) + ' st', onInput: (v) => { (track.pitchCorrection ||= {}).formant = v; } });
    formant.style.width = '120px';

    tb.append(scaleSel, rootSel, strength, quant, flat, formant);
    tb.append(h('div', { class: 'tb-sep' }));
    const analyseBtn = h('button', { class: 'btn btn-sm', onclick: () => runAnalysis() }, '🔍 Анализ тона');
    const tuneBtn = h('button', { class: 'btn btn-sm btn-primary', onclick: () => applyCorrection() }, '✨ Применить тюнинг');
    const revertBtn = h('button', { class: 'btn btn-sm', onclick: () => revertTake() }, '↺ Оригинал');
    const toMidiBtn = h('button', { class: 'btn btn-sm', onclick: () => extractMidi() }, '→ MIDI-дорожка');
    tb.append(analyseBtn, tuneBtn, revertBtn, toMidiBtn);
  }
}
function tabBtn(id, label) {
  const b = h('button', { class: 'pr-tool-btn' + (curTab === id ? ' active' : '') }, label);
  b.onclick = () => switchTab(id);
  return b;
}

/* ------------------------------------------------------------------ render */
function fit() {
  if (!cv || !wrapEl) return;
  fitCanvas(cv, wrapEl.clientWidth, wrapEl.clientHeight);
}

async function draw() {
  const clip = getClip();
  if (!clip || !cv) return;
  const w2 = cv.clientWidth, h2 = cv.clientHeight;
  const ctx = fitCanvas(cv, w2, h2);
  ctx.clearRect(0, 0, w2, h2);
  ctx.fillStyle = '#0a0d12'; ctx.fillRect(0, 0, w2, h2);
  if (!clip.sampleId) {
    ctx.fillStyle = '#6b7c91'; ctx.font = '12px system-ui';
    ctx.fillText('Пустой клип — перетащите сэмпл из браузера', 14, h2 / 2);
    return;
  }
  let buf;
  try { buf = await Library.getBuffer(clip.sampleId); } catch { return; }
  const peaks = computePeaks(buf, Math.min(2400, Math.max(200, Math.floor(w2 * 1.6))));
  const rate = clipRate(clip);
  const visSec = clip.length * Transport.beatsToSec(1) * rate;
  const offSec = clip.offset || 0;
  const from = clamp(offSec / buf.duration, 0, 0.999);
  const to = clamp((offSec + visSec) / buf.duration, from + 0.001, 1);
  drawWaveform(cv, peaks, { color: clip.take ? '#ff9fb0' : '#8fd0ff', bg: 'transparent', from, to });

  // pitch overlay
  if (curTab === 'pitch' && analysis) drawPitchOverlay(ctx, w2, h2, clip);
}

function drawPitchOverlay(ctx, w2, h2, clip) {
  const a = analysis;
  if (!a?.notes?.length) return;
  let lo = 127, hi = 0;
  for (const n of a.notes) { lo = Math.min(lo, Math.floor(n.midi)); hi = Math.max(hi, Math.ceil(n.midi)); }
  lo -= 2; hi += 2;
  const span = Math.max(4, hi - lo);
  const dur = (clip.length * Transport.beatsToSec(1)) || 1;

  // note blocks
  ctx.globalAlpha = 0.22;
  for (const n of a.notes) {
    const x = ((n.startSample / clip.sampleRateOfSource) / dur) * w2;
    const wd = ((n.endSample - n.startSample) / clip.sampleRateOfSource / dur) * w2;
    const y = h2 - ((n.midi - lo) / span) * h2;
    const bh = (1 / span) * h2;
    ctx.fillStyle = '#b28dff';
    ctx.fillRect(x, y - bh, Math.max(2, wd), bh);
    // target (quantised)
    const tgt = snapToScale(n.midiRounded, Store.project.key.root, Store.project.key.scale);
    ctx.fillStyle = '#3ddc97';
    const ty = h2 - ((tgt - lo) / span) * h2;
    ctx.fillRect(x, ty - bh, Math.max(2, wd), 1.5);
  }
  ctx.globalAlpha = 1;
  // pitch curve
  ctx.strokeStyle = 'rgba(255,200,87,0.75)'; ctx.lineWidth = 1.2;
  ctx.beginPath();
  let started = false;
  for (const f of a.frames) {
    if (!f.voiced || !(f.midiFinal > 0)) { started = false; continue; }
    const x = (f.t / dur) * w2;
    const y = h2 - ((f.midiFinal - lo) / span) * h2;
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function clipRate(clip) {
  let r = clip.playbackRate ?? 1;
  if (clip.pitch) r *= Math.pow(2, clip.pitch / 12);
  if (clip.warp && clip.warpBpm) r *= Store.project.bpm / clip.warpBpm;
  return clamp(r, 0.0625, 16);
}

/* ---------------------------------------------------------------- actions */
async function playClip() {
  const clip = getClip(); if (!clip) return;
  Transport.seek(clip.start);
  await Transport.play();
  const stopAt = clip.start + clip.length;
  const iv = setInterval(() => { if (Store.position >= stopAt || !Store.playing) { clearInterval(iv); Transport.stop(); } }, 60);
}

async function runAnalysis() {
  const clip = getClip(); if (!clip?.sampleId) return;
  setBusy(true, 'Анализ тональности (YIN)…');
  try {
    const buf = await Library.getBuffer(clip.sampleId);
    const frames = smoothPitchTrack(analysePitch(buf));
    const notes = segmentNotes(frames, buf);
    clip.sampleRateOfSource = buf.sampleRate;
    analysis = { frames, notes, buffer: buf };
    const voiced = frames.filter(f => f.voiced).length;
    toast('info', `Обнаружено нот: ${notes.length} · voiced кадров: ${voiced}/${frames.length}` +
      (notes.length ? ` · диапазон ${noteName(Math.min(...notes.map(n => n.midi)))}–${noteName(Math.max(...notes.map(n => n.midi)))}` : ''));
    draw();
  } catch (e) {
    console.error(e);
    toast('error', 'Анализ не удался: ' + e.message);
  } finally { setBusy(false); }
}

async function applyCorrection() {
  const clip = getClip();
  const track = Store.clipTrack(clip?.id);
  if (!clip?.sampleId || !track) { toast('info', 'Нет клипа'); return; }
  const pc = track.pitchCorrection || {};
  setBusy(true, 'Рендер питч-коррекции…');
  try {
    const buf = await Library.getBuffer(clip.sampleId);
    const res = await correctPitch(buf, {
      scale: pc.scale || Store.project.key.scale,
      root: pc.root ?? Store.project.key.root,
      strength: pc.strength ?? 1,
      quantize: pc.quantize !== false,
      flattenVibrato: pc.flatten || 0,
      formantShift: pc.formant || 0,
    });
    const baseName = (clip.sampleName || 'take').replace(/_tuned(_\d+)?$/, '');
    let n = 1, name = `${baseName}_tuned`;
    while (Library.get(name)) { n++; name = `${baseName}_tuned${n}`; }
    const sample = await saveTakeAsSample(name, res.buffer, 'Corrected');
    clip.sampleId = sample.id;
    clip.sampleName = sample.name;
    clip._originalSampleId = clip._originalSampleId || clip.sampleId;
    clip.length = sample.duration / Transport.beatsToSec(1);
    P.markDirty(); Transport.invalidate();
    Bus.emit(TOPICS.TRACKS, {});
    analysis = null;
    draw();
    toast('success', `Вокал оттюнен: ${res.notes.length} нот · среднее смещение ${res.correctionCents.toFixed(1)} cent · макс ${res.maxCents.toFixed(0)} cent`);
  } catch (e) {
    console.error(e);
    toast('error', 'Коррекция не удалась: ' + e.message);
  } finally { setBusy(false); }
}

function revertTake() {
  const clip = getClip(); if (!clip) return;
  if (!clip._originalSampleId) { toast('info', 'Оригинал не сохранён для этого клипа'); return; }
  const s = Library.get(clip._originalSampleId);
  clip.sampleId = clip._originalSampleId;
  clip.sampleName = s?.name || 'original';
  analysis = null;
  P.markDirty(); Transport.invalidate(); Bus.emit(TOPICS.TRACKS, {}); draw();
  toast('success', 'Возврат к исходной записи');
}

async function extractMidi() {
  const clip = getClip(); if (!clip) return;
  if (!analysis) await runAnalysis();
  if (!analysis?.notes?.length) { toast('warn', 'Ноты не обнаружены'); return; }
  const track = Store.clipTrack(clip.id);
  const midiNotes = notesToMidi(analysis.notes, analysis.buffer, clip.start);
  const midiTrack = window.__qw.addTrack('midi', { name: (track?.name || 'Vocal') + ' → MIDI', color: '#b28dff' });
  const midiClip = {
    id: uid('clip'), type: 'midi', trackId: midiTrack.id, start: clip.start,
    length: Math.ceil(Math.max(...midiNotes.map(n => n.start + n.length)) / Store.beatsPerBar) * Store.beatsPerBar,
    notes: midiNotes, automation: {}, color: '#b28dff',
  };
  midiTrack.clips.push(midiClip);
  Store.project.selection.trackId = midiTrack.id;
  Store.project.selection.clipId = midiClip.id;
  P.markDirty(); Transport.invalidate();
  Bus.emit(TOPICS.TRACKS, { added: midiTrack.id });
  Bus.emit(TOPICS.SELECTION, {});
  toast('success', `Мелодия извлечена: ${midiNotes.length} нот → новая MIDI-дорожка`);
  const { openPianoRoll } = await import('./pianoroll.js');
  openPianoRoll(midiClip.id);
}

/** Destructive buffer ops → saved as a NEW sample so history stays intact. */
async function process(kind) {
  const clip = getClip();
  if (!clip?.sampleId) return;
  setBusy(true, 'Обработка…');
  try {
    const buf = await Library.getBuffer(clip.sampleId);
    let out = buf;
    if (kind === 'normalize') out = normalizeBuffer(buf, -0.3);
    else if (kind === 'trim') out = trimBuffer(buf);
    else if (kind === 'reverse') out = reverseBuffer(buf);
    else if (kind === 'stretch') {
      const factor = parseFloat(prompt('Коэффициент растяжения (2 = вдвое длиннее):', '1.5'));
      if (!factor) return;
      out = toRealBuffer(timeStretch(buf, factor));
    }
    const baseName = (clip.sampleName || 'clip').replace(/_(norm|trim|rev|str)$/, '');
    let n = 1, name = `${baseName}_${{ normalize: 'norm', trim: 'trim', reverse: 'rev', stretch: 'str' }[kind]}`;
    while (Library.get(name)) { n++; name = `${baseName}_${{ normalize: 'norm', trim: 'trim', reverse: 'rev', stretch: 'str' }[kind]}${n}`; }
    const sample = await saveTakeAsSample(name, out, 'Processed');
    clip.sampleId = sample.id; clip.sampleName = sample.name;
    clip.length = sample.duration / Transport.beatsToSec(1);
    P.markDirty(); Transport.invalidate(); Bus.emit(TOPICS.TRACKS, {});
    analysis = null; draw(); buildToolbar(toolbarEl);
    toast('success', `Готово: ${name}`);
  } catch (e) {
    console.error(e); toast('error', 'Ошибка обработки: ' + e.message);
  } finally { setBusy(false); }
}

function normalizeBuffer(buf, peakDb = -0.3) {
  const target = Math.pow(10, peakDb / 20);
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
  }
  if (peak < 1e-7) return buf;
  const g = target / peak;
  const out = Engine.ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = buf.getChannelData(c), d = out.getChannelData(c);
    for (let i = 0; i < s.length; i++) d[i] = clamp(s[i] * g, -1, 1);
  }
  return out;
}
function trimBuffer(buf, thresh = 0.004) {
  const ch = buf.numberOfChannels, sr = buf.sampleRate;
  const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  const step = Math.max(1, Math.floor(sr / 500));
  let start = 0, end = buf.length, found = false;
  for (let i = 0; i < buf.length && !found; i += step)
    for (let c = 0; c < ch; c++) if (Math.abs(data[c][i]) > thresh) { start = Math.max(0, i - step); found = true; break; }
  found = false;
  for (let i = buf.length - 1; i > start && !found; i -= step)
    for (let c = 0; c < ch; c++) if (Math.abs(data[c][i]) > thresh) { end = Math.min(buf.length, i + step * 2); found = true; break; }
  if (end - start < sr * 0.02) return buf;
  const out = Engine.ctx.createBuffer(ch, end - start, sr);
  for (let c = 0; c < ch; c++) out.copyToChannel(data[c].subarray(start, end), c);
  return out;
}
function reverseBuffer(buf) {
  const out = Engine.ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = buf.getChannelData(c), d = out.getChannelData(c);
    for (let i = 0, j = s.length - 1; i < s.length; i++, j--) d[i] = s[j];
  }
  return out;
}
function toRealBuffer(plain) {
  if (!plain.__plain) return plain;
  const out = Engine.ctx.createBuffer(plain.numberOfChannels, plain.length, plain.sampleRate);
  for (let c = 0; c < plain.numberOfChannels; c++) out.copyToChannel(plain.getChannelData(c), c);
  return out;
}

function setBusy(v, text) {
  busy = v;
  Bus.emit(TOPICS.STATUS, { text: v ? text : 'Готово', busy: v });
  if (v) toast('info', text, 1800);
}

export default { openAudioEditor };
