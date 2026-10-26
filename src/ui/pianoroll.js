/**
 * QwenWave — Piano Roll (canvas based).
 * Draw / select / erase / resize notes, velocity lane, scale highlighting,
 * quantise, transposition, audition on click, and a play-from-here preview.
 */
import Store, { Bus, TOPICS, clamp, uid, SCALES, snapToScale, noteName } from '../core/store.js';
import Engine from '../engine/engine.js';
import Transport from '../engine/transport.js';
import Voice from '../engine/instruments.js';
import * as P from '../engine/persistence.js';
import { h, $, clear, fitCanvas, observeSize, on, toast } from './dom.js';
import { showContextMenu } from './browser.js';

const KEY_W = 48;
const VEL_H = 74;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlack = (m) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);

let root, gridCv, noteCv, keysCv, scrollEl, wrapEl, velCv;
let clipId = null;
let tool = 'draw';
let pxPerBeat = 34;
let rowH = 15;
let topKey = 96;
let viewStartBeat = 0;
let viewBeats = 32;
let sel = new Set();
let hover = null;
let ghost = null;
let raf = null;
let w = 800, hh = 300;

export function openPianoRoll(id) {
  clipId = id;
  const panel = $('#panel-pianoroll');
  if (!panel) return;
  document.querySelectorAll('.bottom-panel').forEach(p => p.classList.remove('active'));
  panel.classList.add('active');
  document.querySelectorAll('.bt').forEach(b => b.classList.toggle('active', b.dataset.panel === 'pianoroll'));
  sel.clear();
  const firstOpen = !scrollEl;
  build();
  requestAnimationFrame(() => {
    fit(); draw();
    // auto-scroll so the clip's note range is centred in view
    const clip = getClip();
    if (clip && clip.notes.length) {
      let lo = 127, hi = 0;
      for (const n of clip.notes) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
      const target = keyToY(hi) - Math.max(20, (scrollEl.clientHeight - (hi - lo + 4) * rowH) / 2);
      scrollEl.scrollTop = Math.max(0, target);
      syncKeys();
    } else if (firstOpen) {
      scrollEl.scrollTop = keyToY(84) - 60; syncKeys();
    }
  });
  Bus.emit(TOPICS.PIANOROLL, { clipId });
}

export function closePianoRoll() {
  const panel = $('#panel-pianoroll');
  panel?.classList.remove('active');
}

function getClip() { return clipId ? Store.clip(clipId) : null; }

function build() {
  root = $('#panel-pianoroll');
  if (!root || root.dataset.built) { refreshToolbar(); return; }
  root.dataset.built = '1';
  const __act = root.classList.contains('active');
  clear(root);
  root.className = 'bottom-panel fill pr' + (__act ? ' active' : '');
  root.id = 'panel-pianoroll';

  const tb = h('div', { class: 'pr-toolbar' });
  root.append(tb);

  const main = h('div', { class: 'pr-main' });
  const keysWrap = h('div', { class: 'pr-keys' });
  keysCv = h('canvas');
  keysWrap.append(keysCv);
  scrollEl = h('div', { class: 'pr-scroll' });
  wrapEl = h('div', { class: 'pr-grid-wrap' });
  gridCv = h('canvas', { class: 'pr-grid' });
  noteCv = h('canvas', { class: 'pr-notes' });
  velCv = h('canvas', { class: 'pr-notes', style: { top: 'auto', bottom: '0', position: 'absolute', pointerEvents: 'none' } });
  wrapEl.append(gridCv, velCv, noteCv);
  scrollEl.append(wrapEl);
  main.append(keysWrap, scrollEl);
  root.append(main);

  buildToolbar(tb);

  scrollEl.addEventListener('scroll', syncKeys);
  observeSize(scrollEl, () => { fit(); draw(); });
  noteCv.addEventListener('pointerdown', onPointerDown);
  noteCv.addEventListener('pointermove', onPointerMove);
  noteCv.addEventListener('pointerleave', () => { hover = null; drawNotes(); });
  noteCv.addEventListener('contextmenu', onContext);
  noteCv.addEventListener('wheel', onWheel, { passive: false });
  keysCv.addEventListener('pointerdown', onKeyClick);

  Bus.on(TOPICS.TRANSPORT, () => { if (root.classList.contains('active')) drawNotes(); });
}

function buildToolbar(tb) {
  clear(tb);
  const clip = getClip();
  if (!clip) {
    tb.append(h('div', { class: 'hint' }, 'Выберите или создайте MIDI-клип на аранжировке (инструмент «Карандаш» или двойной клик по дорожке).'));
    return;
  }
  const track = Store.clipTrack(clip.id);
  tb.append(
    h('span', { class: 'badge', style: { background: 'var(--clip-midi)', color: '#fff' } }, 'PIANO ROLL'),
    h('span', { class: 'mono small' }, clip.sampleName || `${track?.name || ''} · ${clip.notes.length} нот`),
    h('div', { class: 'tb-sep' }),
  );
  for (const t of [['draw', 'Карандаш'], ['select', 'Выбор'], ['erase', 'Ластик']]) {
    const b = h('button', { class: 'pr-tool-btn' + (tool === t[0] ? ' active' : '') }, t[1]);
    b.onclick = () => { tool = t[0]; buildToolbar(tb); };
    tb.append(b);
  }
  tb.append(h('div', { class: 'tb-sep' }));

  const qSel = h('select', { class: 'sel' },
    ...[[1, '1/1'], [1 / 2, '1/2'], [1 / 4, '1/4'], [1 / 8, '1/8'], [1 / 16, '1/16'], [1 / 32, '1/32'], [1 / 3, '1/3 tri'], [1 / 6, '1/6 tri']]
      .map(([v, l]) => h('option', { value: v, selected: Math.abs(v - (Store.project.quantize || 1 / 4)) < 1e-9 }, l)));
  qSel.onchange = () => { Store.project.quantize = parseFloat(qSel.value); P.markDirty(); draw(); };
  tb.append(h('span', { class: 'ctrl-label' }, 'Квант'), qSel);

  const qb = h('button', { class: 'btn btn-sm', title: 'Квантовать выделенное (Q)' }, 'Квантовать');
  qb.onclick = () => quantize();
  tb.append(qb);

  const scaleSel = h('select', { class: 'sel' },
    ...Object.keys(SCALES).map(s => h('option', { value: s, selected: s === Store.project.key.scale }, s)));
  scaleSel.onchange = () => { Store.project.key.scale = scaleSel.value; P.markDirty(); draw(); };
  const rootSel = h('select', { class: 'sel' },
    ...NOTE_NAMES.map((n, i) => h('option', { value: i, selected: i === Store.project.key.root }, n)));
  rootSel.onchange = () => { Store.project.key.root = +rootSel.value; P.markDirty(); draw(); };
  tb.append(h('span', { class: 'ctrl-label' }, 'Тональность'), rootSel, scaleSel);

  const snapBtn = h('button', { class: 'btn btn-sm' }, 'В гамму');
  snapBtn.title = 'Притянуть выделенные ноты к тональности проекта';
  snapBtn.onclick = () => {
    Store.pushHistory('snap to scale');
    for (const n of selectedNotes()) n.midi = clamp(snapToScale(n.midi, Store.project.key.root, Store.project.key.scale), 0, 127);
    P.markDirty(); draw();
  };
  tb.append(snapBtn);

  tb.append(h('div', { class: 'tb-sep' }));
  for (const [lab, delta] of [['−12', -12], ['−1', -1], ['+1', 1], ['+12', 12]]) {
    const b = h('button', { class: 'btn btn-sm', title: 'Транспонировать ' + lab }, lab);
    b.onclick = () => transpose(delta);
    tb.append(b);
  }
  tb.append(h('div', { class: 'tb-sep' }));

  const vel = h('input', { type: 'range', min: 0.05, max: 1, step: 0.01, value: 0.8, class: 'slider', style: { width: '70px' } });
  const velLbl = h('span', { class: 'mono small muted' }, '0.80');
  vel.oninput = () => { velLbl.textContent = (+vel.value).toFixed(2); };
  const velApply = h('button', { class: 'btn btn-sm', title: 'Применить velocity к выделенным' }, 'Vel→');
  velApply.onclick = () => {
    Store.pushHistory('velocity');
    for (const n of selectedNotes()) n.velocity = +vel.value;
    P.markDirty(); draw();
  };
  tb.append(h('span', { class: 'ctrl-label' }, 'Velocity'), vel, velLbl, velApply);

  tb.append(h('div', { class: 'spacer' }));
  const playHere = h('button', { class: 'btn btn-sm btn-primary' }, '▶ Отсюда');
  playHere.onclick = () => {
    Transport.setLoop(clip.start, clip.start + clip.length, false);
    Transport.play(clip.start);
  };
  const playSel = h('button', { class: 'btn btn-sm', title: 'Прослушать выделенные ноты' }, '▶ Выделение');
  playSel.onclick = () => {
    const notes = selectedNotes();
    if (!notes.length) return;
    const t0 = Engine.ctx.currentTime + 0.03;
    notes.forEach((n, i) => Voice.play(track, n.midi, t0 + i * 0.02, Math.max(0.15, n.length * Transport.beatsToSec(1)), n.velocity));
  };
  const clr = h('button', { class: 'btn btn-sm btn-danger', title: 'Удалить выделенные ноты' }, 'Очистить');
  clr.onclick = () => {
    if (!sel.size) { if (!confirm('Удалить ВСЕ ноты клипа?')) return; Store.pushHistory('clear notes'); clip.notes = []; }
    else { Store.pushHistory('delete notes'); clip.notes = clip.notes.filter(n => !sel.has(n.id)); sel.clear(); }
    P.markDirty(); Transport.invalidate(); draw(); Bus.emit(TOPICS.TRACKS, {});
  };
  tb.append(playHere, playSel, clr);
}
function refreshToolbar() { const tb = $('.pr-toolbar', root); if (tb) buildToolbar(tb); }

/* ------------------------------------------------------------------ sizing */
function fit() {
  if (!scrollEl) return;
  w = Math.max(200, scrollEl.clientWidth);
  hh = Math.max(120, scrollEl.clientHeight);
  const contentW = Math.max(w, viewBeats * pxPerBeat);
  const contentH = 128 * rowH + VEL_H;
  wrapEl.style.width = contentW + 'px';
  wrapEl.style.height = contentH + 'px';
  fitCanvas(gridCv, contentW, contentH);
  fitCanvas(noteCv, contentW, contentH);
  fitCanvas(velCv, contentW, contentH);
  const keysH = contentH;
  fitCanvas(keysCv, KEY_W, keysH);
  keysCv.parentElement.style.height = hh + 'px';
  keysCv.parentElement.style.overflow = 'hidden';
  syncKeys();
}
function syncKeys() { if (keysCv) keysCv.style.transform = `translateY(${-scrollEl.scrollTop}px)`; }

function beatToX(b) { return b * pxPerBeat; }
function xToBeat(x) { return x / pxPerBeat; }
function keyToY(m) { return (127 - m) * rowH; }
function yToKey(y) { return 127 - Math.floor(y / rowH); }
function snapQ(b) {
  const q = Store.project.quantize || 1 / 16;
  return Math.round(b / q) * q;
}

/* ------------------------------------------------------------------ draw */
function draw() { drawGrid(); drawNotes(); drawKeys(); }

function drawGrid() {
  const clip = getClip();
  const cw = gridCv.width / (window.devicePixelRatio || 1), chh = gridCv.height / (window.devicePixelRatio || 1);
  const ctx = fitCanvas(gridCv, cw, chh);
  ctx.fillStyle = '#0b0e13'; ctx.fillRect(0, 0, cw, chh);
  const root = Store.project.key.root, scale = SCALES[Store.project.key.scale] || SCALES.minor;
  const scaleSet = new Set(scale.map(s => (root + s) % 12));

  // rows
  for (let m = 0; m < 128; m++) {
    const y = keyToY(m);
    const black = isBlack(m);
    const inScale = scaleSet.has(((m % 12) + 12) % 12);
    ctx.fillStyle = black ? (inScale ? '#161b24' : '#12161d') : (inScale ? '#1d2430' : '#191f29');
    if (m % 12 === 0) ctx.fillStyle = '#252d3b';
    ctx.fillRect(0, y, cw, rowH);
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + rowH - 0.5); ctx.lineTo(cw, y + rowH - 0.5); ctx.stroke();
  }
  // beats / bars
  const bpb = Store.beatsPerBar;
  const maxBeat = clip ? clip.length : viewBeats;
  for (let b = 0; b <= maxBeat + 1; b += 1 / 4) {
    const x = Math.round(beatToX(b)) + 0.5;
    if (x > cw) break;
    const isBar = Math.abs(b % bpb) < 1e-6;
    const isBeat = Math.abs(b % 1) < 1e-6;
    ctx.strokeStyle = isBar ? 'rgba(255,255,255,0.22)' : isBeat ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.035)';
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, chh - VEL_H); ctx.stroke();
  }
  // velocity lane bg
  ctx.fillStyle = '#0f141b';
  ctx.fillRect(0, chh - VEL_H, cw, VEL_H);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath(); ctx.moveTo(0, chh - VEL_H + 0.5); ctx.lineTo(cw, chh - VEL_H + 0.5); ctx.stroke();
  ctx.fillStyle = '#6b7c91'; ctx.font = '9px ui-monospace, monospace';
  ctx.fillText('VELOCITY', 6, chh - VEL_H + 12);

  // clip end marker
  if (clip) {
    const x = beatToX(clip.length);
    ctx.fillStyle = 'rgba(255,93,108,0.10)';
    ctx.fillRect(x, 0, cw - x, chh - VEL_H);
    ctx.strokeStyle = 'rgba(255,93,108,0.5)';
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, chh - VEL_H); ctx.stroke();
  }
}

function drawKeys() {
  if (!keysCv) return;
  const chh = keysCv.height / (window.devicePixelRatio || 1);
  const ctx = fitCanvas(keysCv, KEY_W, chh);
  ctx.clearRect(0, 0, KEY_W, chh);
  const root = Store.project.key.root, scale = SCALES[Store.project.key.scale] || SCALES.minor;
  const scaleSet = new Set(scale.map(s => (root + s) % 12));
  for (let m = 0; m < 128; m++) {
    const y = keyToY(m);
    const black = isBlack(m);
    ctx.fillStyle = black ? '#1a1f28' : '#e8eef5';
    if (m % 12 === 0) ctx.fillStyle = black ? '#1a1f28' : '#ffffff';
    ctx.fillRect(0, y, KEY_W - 1, rowH - 1);
    if (!black) {
      const inScale = scaleSet.has(((m % 12) + 12) % 12);
      if (inScale) { ctx.fillStyle = 'rgba(89,200,255,0.30)'; ctx.fillRect(KEY_W - 14, y, 13, rowH - 1); }
    }
    if (m % 12 === 0) {
      ctx.fillStyle = '#0a0d12';
      ctx.font = '700 9px ui-monospace, monospace';
      ctx.fillText(noteName(m), 4, y + rowH - 4);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath(); ctx.moveTo(0, y + rowH - 0.5); ctx.lineTo(KEY_W, y + rowH - 0.5); ctx.stroke();
  }
}

function drawNotes() {
  const clip = getClip();
  if (!noteCv) return;
  const cw = noteCv.width / (window.devicePixelRatio || 1), chh = noteCv.height / (window.devicePixelRatio || 1);
  const ctx = fitCanvas(noteCv, cw, chh);
  ctx.clearRect(0, 0, cw, chh);
  const track = clip ? Store.clipTrack(clip.id) : null;
  const color = track?.color || '#7a5fd0';

  if (clip) {
    for (const n of clip.notes) {
      const x = beatToX(n.start), y = keyToY(n.midi);
      const nw = Math.max(3, beatToX(n.length));
      const isSel = sel.has(n.id);
      const isHov = hover?.id === n.id;
      const grad = ctx.createLinearGradient(0, y, 0, y + rowH);
      grad.addColorStop(0, isSel ? '#ffffff' : isHov ? '#d8c9ff' : color);
      grad.addColorStop(1, isSel ? '#9fd8ff' : shade(color, -0.32));
      ctx.fillStyle = grad;
      roundRect(ctx, x + 0.5, y + 1, nw - 1, rowH - 2, 2.5);
      ctx.fill();
      ctx.strokeStyle = isSel ? '#fff' : 'rgba(0,0,0,0.55)';
      ctx.lineWidth = isSel ? 1.4 : 0.8;
      ctx.stroke();
      // velocity bar tint
      ctx.fillStyle = `rgba(255,255,255,${0.1 + (n.velocity ?? 0.8) * 0.35})`;
      ctx.fillRect(x + 1, y + 2, Math.max(1, nw - 2), 1.6);
      // detected (pitch-corrected) marker
      if (n.detected) {
        ctx.fillStyle = 'rgba(255,200,87,0.9)';
        ctx.fillRect(x + 1, y + rowH - 3.5, 3, 2.5);
      }
      if (nw > 26) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.font = '600 8.5px system-ui';
        ctx.fillText(noteName(n.midi), x + 4, y + rowH - 4);
      }
    }
  }
  // ghost while drawing
  if (ghost) {
    const x = beatToX(ghost.start), y = keyToY(ghost.midi);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeStyle = '#fff';
    roundRect(ctx, x + 0.5, y + 1, Math.max(3, beatToX(ghost.length)) - 1, rowH - 2, 2.5);
    ctx.fill(); ctx.stroke();
  }
  // velocity lane
  if (clip) {
    const vy = chh - VEL_H;
    for (const n of clip.notes) {
      const x = beatToX(n.start);
      const nw = Math.max(2.5, beatToX(n.length));
      const v = clamp(n.velocity ?? 0.8, 0, 1);
      const bh = v * (VEL_H - 12);
      ctx.fillStyle = sel.has(n.id) ? '#ffffff' : `hsl(${200 - v * 160} 80% 58%)`;
      ctx.fillRect(x, vy + VEL_H - 4 - bh, Math.max(2, nw * 0.32), bh);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(x, vy + VEL_H - 6 - bh, Math.max(2, nw * 0.32), 2);
    }
  }
  // playhead
  if (clip && (Store.playing || Store.recording)) {
    const pb = Transport.beatForCtxTime(Engine.ctx.currentTime) - clip.start;
    if (pb >= 0 && pb <= clip.length) {
      const x = beatToX(pb);
      ctx.strokeStyle = '#ffc857'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, chh); ctx.stroke();
    }
  }
}

function shade(hex, amt) {
  const c = hex.replace('#', '');
  const n = parseInt(c.length === 3 ? c.split('').map(x => x + x).join('') : c, 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = clamp(Math.round(r + 255 * amt), 0, 255); g = clamp(Math.round(g + 255 * amt), 0, 255); b = clamp(Math.round(b + 255 * amt), 0, 255);
  return `rgb(${r},${g},${b})`;
}
function roundRect(ctx, x, y, w2, h2, r) {
  r = Math.min(r, w2 / 2, h2 / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w2, y, x + w2, y + h2, r);
  ctx.arcTo(x + w2, y + h2, x, y + h2, r);
  ctx.arcTo(x, y + h2, x, y, r);
  ctx.arcTo(x, y, x + w2, y, r);
  ctx.closePath();
}

/* --------------------------------------------------------------- pointer */
function localPt(e) {
  const r = noteCv.getBoundingClientRect();
  return { x: e.clientX - r.left + 0, y: e.clientY - r.top + 0, sx: e.clientX - r.left, sy: e.clientY - r.top };
}
function noteAt(x, y) {
  const clip = getClip();
  if (!clip) return null;
  const b = xToBeat(x), m = yToKey(y);
  let best = null;
  for (const n of clip.notes) {
    if (n.midi !== m) continue;
    if (b >= n.start - 0.02 && b <= n.start + n.length) { if (!best || n.start > best.start) best = n; }
  }
  return best;
}
function isVelLane(y) {
  const chh = noteCv.clientHeight;
  return y > chh - VEL_H;
}

let drag = null;
function onPointerDown(e) {
  const clip = getClip();
  if (!clip) { toast('info', 'MIDI-клип не выбран'); return; }
  const track = Store.clipTrack(clip.id);
  const { x, y } = localPt(e);
  e.preventDefault();

  // velocity lane drag
  if (isVelLane(y)) {
    const b = xToBeat(x);
    const n = clip.notes.find(nn => b >= nn.start && b <= nn.start + nn.length);
    if (!n) return;
    Store.pushHistory('velocity edit', 300);
    const setVel = (ev) => {
      const r = noteCv.getBoundingClientRect();
      const chh = noteCv.clientHeight;
      const vy = ev.clientY - r.top;
      n.velocity = clamp(1 - (vy - (chh - VEL_H + 4)) / (VEL_H - 12), 0.02, 1);
      drawNotes();
    };
    setVel(e);
    const move = (ev) => setVel(ev);
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); P.markDirty(); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    return;
  }

  const hit = noteAt(x, y);

  if (tool === 'erase') {
    if (hit) { Store.pushHistory('erase note'); clip.notes = clip.notes.filter(n => n.id !== hit.id); sel.delete(hit.id); P.markDirty(); Transport.invalidate(); draw(); refreshToolbar(); }
    return;
  }

  if (tool === 'draw') {
    if (hit) {
      // resize existing
      const grabX = x - beatToX(hit.start + hit.length);
      if (Math.abs(grabX) < 8) { startResize(hit, clip, e); return; }
      startMove([hit], clip, e);
      return;
    }
    const m = clamp(yToKey(y), 0, 127);
    const startB = snapQ(xToBeat(x));
    const len = Store.project.quantize || 1 / 4;
    if (startB >= clip.length) {
      // extend clip to fit
      Store.pushHistory('extend clip');
      clip.length = Math.ceil((startB + len) / Store.beatsPerBar) * Store.beatsPerBar;
      Bus.emit(TOPICS.TRACKS, {}); P.markDirty();
    }
    const n = { id: uid('n'), start: startB, length: len, midi: m, velocity: 0.8 };
    Store.pushHistory('add note');
    clip.notes.push(n);
    P.markDirty(); Transport.invalidate();
    sel.clear(); sel.add(n.id);
    draw(); refreshToolbar();
    Voice.play(track, m, Engine.ctx.currentTime + 0.005, 0.35, 0.8);
    startResize(n, clip, e);
    return;
  }

  // select tool
  if (hit) {
    if (e.shiftKey) { sel.has(hit.id) ? sel.delete(hit.id) : sel.add(hit.id); drawNotes(); return; }
    if (!sel.has(hit.id)) { sel.clear(); sel.add(hit.id); }
    drawNotes();
    startMove([...sel].map(id => clip.notes.find(n => n.id === id)).filter(Boolean), clip, e);
    return;
  }
  // marquee selection
  if (!e.shiftKey) sel.clear();
  drawNotes();
  const start = { x, y, sx: e.clientX, sy: e.clientY };
  const box = h('div', { style: { position: 'absolute', border: '1px solid var(--accent)', background: 'rgba(89,200,255,0.12)', pointerEvents: 'none', zIndex: 5 } });
  wrapEl.append(box);
  const move = (ev) => {
    const r = noteCv.getBoundingClientRect();
    const cx = ev.clientX - r.left, cy = ev.clientY - r.top;
    const x1 = Math.min(start.x, cx), y1 = Math.min(start.y, cy);
    const x2 = Math.max(start.x, cx), y2 = Math.max(start.y, cy);
    Object.assign(box.style, { left: x1 + 'px', top: y1 + 'px', width: (x2 - x1) + 'px', height: (y2 - y1) + 'px' });
    sel.clear();
    for (const n of clip.notes) {
      const nx = beatToX(n.start), ny = keyToY(n.midi), nw = beatToX(n.length);
      if (nx + nw >= x1 && nx <= x2 && ny + rowH >= y1 && ny <= y2) sel.add(n.id);
    }
    drawNotes();
  };
  const up = () => { box.remove(); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
}

function startMove(notes, clip, e) {
  const track = Store.clipTrack(clip.id);
  const orig = notes.map(n => ({ n, start: n.start, midi: n.midi }));
  Store.pushHistory('move notes', 350);
  const x0 = e.clientX, y0 = e.clientY;
  const move = (ev) => {
    const db = (ev.clientX - x0) / pxPerBeat;
    const dk = Math.round((y0 - ev.clientY) / rowH);
    for (const o of orig) {
      o.n.start = Math.max(0, snapQ(o.start + db));
      o.n.midi = clamp(o.midi + dk, 0, 127);
    }
    drawNotes();
  };
  const up = () => {
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
    for (const o of orig) if (o.n.start + o.n.length > clip.length) clip.length = Math.ceil((o.n.start + o.n.length) / Store.beatsPerBar) * Store.beatsPerBar;
    P.markDirty(); Transport.invalidate(); draw(); Bus.emit(TOPICS.TRACKS, {}); refreshToolbar();
  };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  // audition
  if (track) notes.slice(0, 8).forEach(n => Voice.play(track, n.midi, Engine.ctx.currentTime + 0.005, 0.25, n.velocity));
}

function startResize(note, clip, e) {
  const x0 = e.clientX;
  const len0 = note.length;
  Store.pushHistory('resize note', 350);
  const move = (ev) => {
    const db = (ev.clientX - x0) / pxPerBeat;
    note.length = Math.max(Store.project.quantize || 1 / 16, snapQ(len0 + db));
    drawNotes();
  };
  const up = () => {
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
    if (note.start + note.length > clip.length) { clip.length = Math.ceil((note.start + note.length) / Store.beatsPerBar) * Store.beatsPerBar; Bus.emit(TOPICS.TRACKS, {}); }
    P.markDirty(); Transport.invalidate(); draw(); refreshToolbar();
  };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
}

function onPointerMove(e) {
  const { x, y } = localPt(e);
  if (isVelLane(y)) { noteCv.style.cursor = 'ns-resize'; return; }
  const hit = noteAt(x, y);
  noteCv.style.cursor = tool === 'draw' ? 'crosshair' : tool === 'erase' ? 'not-allowed' : hit ? 'grab' : 'default';
  if (hit && hit !== hover) { hover = hit; drawNotes(); }
  else if (!hit && hover) { hover = null; drawNotes(); }
}

function onContext(e) {
  e.preventDefault();
  const clip = getClip(); if (!clip) return;
  const { x, y } = localPt(e);
  const hit = noteAt(x, y);
  if (hit && !sel.has(hit.id)) { sel.clear(); sel.add(hit.id); drawNotes(); }
  showContextMenu(e.clientX, e.clientY, [
    { label: `Квантовать (${sel.size || 'все'})`, fn: quantize },
    { label: 'В гамму проекта', fn: () => { for (const n of selectedNotes()) n.midi = clamp(snapToScale(n.midi, Store.project.key.root, Store.project.key.scale), 0, 127); P.markDirty(); draw(); } },
    { label: 'Дублировать', fn: duplicateSel },
    { label: 'Удалить', danger: true, fn: () => { Store.pushHistory('del notes'); clip.notes = clip.notes.filter(n => !sel.has(n.id)); sel.clear(); P.markDirty(); Transport.invalidate(); draw(); refreshToolbar(); } },
    { sep: true },
    { label: 'Выделить все', fn: () => { clip.notes.forEach(n => sel.add(n.id)); drawNotes(); } },
    { label: 'Chord: из выделенной ноты', fn: () => makeChord() },
  ]);
}

function onWheel(e) {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const factor = e.deltaY > 0 ? 0.86 : 1.16;
    const { x } = localPt(e);
    const anchor = xToBeat(x + scrollEl.scrollLeft);
    pxPerBeat = clamp(pxPerBeat * factor, 4, 400);
    viewBeats = w / pxPerBeat;
    fit(); draw();
    scrollEl.scrollLeft = Math.max(0, beatToX(anchor) - x);
  } else if (e.shiftKey) {
    scrollEl.scrollLeft += e.deltaY;
  } else {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      const r = noteCv.getBoundingClientRect();
      if (e.altKey) { rowH = clamp(rowH - Math.sign(e.deltaY) * 1.5, 5, 44); fit(); draw(); return; }
      scrollEl.scrollTop += e.deltaY;
    } else scrollEl.scrollLeft += e.deltaX;
  }
  syncKeys();
}

function onKeyClick(e) {
  const r = keysCv.getBoundingClientRect();
  const y = e.clientY - r.top;
  const m = clamp(yToKey(y), 0, 127);
  const clip = getClip();
  const track = clip ? Store.clipTrack(clip.id) : Store.selectedTrack;
  if (!track) return;
  Voice.play(track, m, Engine.ctx.currentTime + 0.004, 0.5, 0.85);
}

/* ---------------------------------------------------------------- actions */
function selectedNotes() {
  const clip = getClip(); if (!clip) return [];
  return sel.size ? clip.notes.filter(n => sel.has(n.id)) : clip.notes;
}
function quantize() {
  const clip = getClip(); if (!clip) return;
  Store.pushHistory('quantize');
  const q = Store.project.quantize || 1 / 16;
  for (const n of selectedNotes()) {
    n.start = Math.max(0, Math.round(n.start / q) * q);
    if (!sel.size || sel.has(n.id)) n.length = Math.max(q, Math.round(n.length / q) * q);
  }
  P.markDirty(); Transport.invalidate(); draw();
  toast('success', `Квантовано: ${selectedNotes().length} нот (сетка ${q >= 1 ? q : '1/' + Math.round(1 / q)})`);
}
function transpose(delta) {
  const notes = selectedNotes();
  if (!notes.length) return;
  Store.pushHistory('transpose');
  for (const n of notes) n.midi = clamp(n.midi + delta, 0, 127);
  P.markDirty(); draw();
}
function duplicateSel() {
  const clip = getClip(); if (!clip) return;
  const notes = selectedNotes();
  if (!notes.length) return;
  Store.pushHistory('duplicate notes');
  const maxEnd = Math.max(...notes.map(n => n.start + n.length));
  const off = snapQ(maxEnd - Math.min(...notes.map(n => n.start))) || (Store.project.quantize || 1 / 4);
  const copies = notes.map(n => ({ ...n, id: uid('n'), start: n.start + off }));
  clip.notes.push(...copies);
  clip.length = Math.max(clip.length, Math.ceil(Math.max(...copies.map(n => n.start + n.length)) / Store.beatsPerBar) * Store.beatsPerBar);
  sel.clear(); copies.forEach(c => sel.add(c.id));
  P.markDirty(); Transport.invalidate(); draw(); Bus.emit(TOPICS.TRACKS, {}); refreshToolbar();
}
function makeChord() {
  const clip = getClip(); if (!clip) return;
  const notes = selectedNotes();
  if (notes.length !== 1) { toast('info', 'Выделите одну ноту'); return; }
  const base = notes[0];
  const root = Store.project.key.root, scale = SCALES[Store.project.key.scale] || SCALES.minor;
  const idx = scale.indexOf(((base.midi - root) % 12 + 12) % 12);
  const third = scale[(idx + 2) % scale.length] + 12 * Math.floor((idx + 2) / scale.length);
  const fifth = scale[(idx + 4) % scale.length] + 12 * Math.floor((idx + 4) / scale.length);
  Store.pushHistory('chord');
  for (const off of [third, fifth]) {
    const m = clamp(root + off + 12 * Math.floor((base.midi - root) / 12), 0, 127);
    clip.notes.push({ id: uid('n'), start: base.start, length: base.length, midi: m, velocity: base.velocity * 0.92 });
  }
  P.markDirty(); Transport.invalidate(); draw(); Bus.emit(TOPICS.TRACKS, {});
}

export function keyboard(e) {
  if (!root?.classList.contains('active')) return false;
  const clip = getClip(); if (!clip) return false;
  if (e.key === 'q' || e.key === 'Q' || e.key === 'й' || e.key === 'Й') { quantize(); return true; }
  if ((e.key === 'd' || e.key === 'D' || e.key === 'в' || e.key === 'В') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); duplicateSel(); return true; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!sel.size) return false;
    Store.pushHistory('delete notes');
    clip.notes = clip.notes.filter(n => !sel.has(n.id)); sel.clear();
    P.markDirty(); Transport.invalidate(); draw(); refreshToolbar();
    return true;
  }
  if (e.key === 'a' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); clip.notes.forEach(n => sel.add(n.id)); drawNotes(); return true; }
  if (['1', '2', '3'].includes(e.key)) { tool = ['draw', 'select', 'erase'][+e.key - 1]; refreshToolbar(); return true; }
  return false;
}

export default { openPianoRoll, closePianoRoll, keyboard, draw };
