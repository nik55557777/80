/**
 * QwenWave — tiny DOM helpers + canvas drawing utilities.
 * Kept dependency-free and allocation-light: everything that redraws often
 * (waveforms, meters, ruler, piano roll) goes through cached canvases.
 */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(9)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function on(el, ev, fn, opts) {
  el.addEventListener(ev, fn, opts);
  return () => el.removeEventListener(ev, fn, opts);
}

/** Pointer-drag helper with capture + optional axis lock + pixel→value map. */
export function draggable(el, { onStart, onMove, onEnd, cursor } = {}) {
  let state = null;
  const down = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    state = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, dx: 0, dy: 0, e };
    if (cursor) document.body.style.cursor = cursor;
    el.setPointerCapture?.(e.pointerId);
    onStart?.(state, e);
    const move = (ev) => {
      if (!state) return;
      state.dx = ev.clientX - state.x0;
      state.dy = ev.clientY - state.y0;
      state.x = ev.clientX; state.y = ev.clientY;
      onMove?.(state, ev);
    };
    const up = (ev) => {
      if (!state) return;
      const s = state; state = null;
      if (cursor) document.body.style.cursor = '';
      el.releasePointerCapture?.(ev.pointerId);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      onEnd?.(s, ev);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  el.addEventListener('pointerdown', down);
  return () => el.removeEventListener('pointerdown', down);
}

/* ------------------------------------------------------------------ canvas */
const dprCache = new WeakMap();
export function fitCanvas(canvas, w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const key = `${w}x${h}x${dpr}`;
  if (dprCache.get(canvas) === key) return canvas.getContext('2d');
  dprCache.set(canvas, key);
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function observeSize(el, fn) {
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const r = e.contentRect;
      fn(Math.max(1, Math.floor(r.width)), Math.max(1, Math.floor(r.height)));
    }
  });
  ro.observe(el);
  return () => ro.disconnect();
}

/* --------------------------------------------------------------- waveforms */
const waveCache = new Map();       // `${id}:${w}x${h}` -> offscreen canvas
const WAVE_CACHE_MAX = 260;

export function drawWaveform(canvas, peaks, opts = {}) {
  const w = canvas.clientWidth || canvas.width, hh = canvas.clientHeight || canvas.height;
  const ctx = fitCanvas(canvas, w, hh);
  const { color = '#7fd1ff', bg = 'transparent', progress = null, progressColor = '#ffd479',
    from = 0, to = 1, mirror = true } = opts;
  ctx.clearRect(0, 0, w, hh);
  if (bg !== 'transparent') { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, hh); }
  if (!peaks || !peaks.length) return;
  const s = Math.max(0, Math.floor(from * peaks.length));
  const e = Math.min(peaks.length, Math.ceil(to * peaks.length));
  const n = Math.max(1, e - s);
  const mid = hh / 2;
  const barW = w / n;

  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const v = peaks[s + i] || 0;
    const amp = Math.max(1, v * (hh / 2 - 1));
    const x = i * barW;
    ctx.rect(x, mid - amp, Math.max(0.7, barW - 0.25), amp * (mirror ? 2 : 1));
  }
  ctx.fill();

  if (progress !== null && progress > 0) {
    const px = clampNum(progress, 0, 1) * w;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, px, hh); ctx.clip();
    ctx.fillStyle = progressColor;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const v = peaks[s + i] || 0;
      const amp = Math.max(1, v * (hh / 2 - 1));
      ctx.rect(i * barW, mid - amp, Math.max(0.7, barW - 0.25), amp * (mirror ? 2 : 1));
    }
    ctx.fill();
    ctx.restore();
  }
}

/** Pre-render a waveform into an offscreen canvas for fast blitting. */
export function waveformSprite(id, peaks, w, hh, color = '#9fdcff') {
  const key = `${id}:${w}x${hh}:${color}`;
  const hit = waveCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = Math.max(1, w); c.height = Math.max(1, hh);
  const ctx = c.getContext('2d');
  if (peaks?.length) {
    const n = peaks.length, mid = hh / 2, barW = w / n;
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const amp = Math.max(1, (peaks[i] || 0) * (hh / 2 - 1));
      ctx.fillRect(i * barW, mid - amp, Math.max(0.7, barW - 0.3), amp * 2);
    }
  }
  if (waveCache.size > WAVE_CACHE_MAX) waveCache.delete(waveCache.keys().next().value);
  waveCache.set(key, c);
  return c;
}

export function invalidateWave(id) {
  for (const k of [...waveCache.keys()]) if (k.startsWith(id + ':')) waveCache.delete(k);
}

function clampNum(v, a, b) { return v < a ? a : v > b ? b : v; }

/* ------------------------------------------------------------------ meters */
export function dbFromLin(v) { return v <= 1e-6 ? -60 : 20 * Math.log10(v); }
export function meterPos(db) {
  // map -60..0 dB to 0..1 with a pleasing curve
  const x = clampNum((db + 60) / 60, 0, 1);
  return Math.pow(x, 0.75);
}

export function drawMeter(ctx, x, y, w, hh, levelL, levelR, clip) {
  const grad = ctx.createLinearGradient(0, y + hh, 0, y);
  grad.addColorStop(0, '#19c37d'); grad.addColorStop(0.62, '#f2c744');
  grad.addColorStop(0.86, '#f2884a'); grad.addColorStop(1, '#ff4d4d');
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(x, y, w, hh);
  for (const [i, lv] of [0, levelL].length ? [[0, levelL], [1, levelR]] : []) {
    const bw = (w - 2) / 2;
    const bx = x + i * (bw + 2);
    const p = meterPos(dbFromLin(lv || 0));
    ctx.fillStyle = grad;
    const h2 = Math.max(0, p * hh);
    ctx.fillRect(bx, y + hh - h2, bw, h2);
  }
  // ticks
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1;
  for (const db of [-40, -24, -12, -6, -3, 0]) {
    const yy = y + hh - meterPos(db) * hh;
    ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke();
  }
  if (clip) { ctx.fillStyle = '#ff4d4d'; ctx.fillRect(x, y - 3, w, 3); }
}

/* ------------------------------------------------------------------- icons */
export const ICON = {
  play: 'M8 5v14l11-7z', pause: 'M6 5h4v14H6zm8 0h4v14h-4z', stop: 'M6 6h12v12H6z',
  record: 'M12 6a6 6 0 100 12 6 6 0 000-12z',
  loop: 'M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z',
  metro: 'M12 3l7 18H5zm0 4.5L8.5 18h7z',
  save: 'M5 3h11l3 3v15H5zm3 0v6h8V3zM8 13h8v8H8z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  trash: 'M6 7h12l-1 14H7zm3-4h6l1 2H8zm-2 4v10h1V7zm3 0v10h1V7zm3 0v10h1V7z',
  mic: 'M12 3a3 3 0 013 3v6a3 3 0 11-6 0V6a3 3 0 013-3zm7 9a7 7 0 01-6 6.92V22h-2v-3.08A7 7 0 015 12h2a5 5 0 0010 0z',
  piano: 'M3 4h18v16H3zm4 0v10h2V4zm4 0v10h2V4zm4 0v10h2V4z',
  mixer: 'M4 4h3v16H4zm6.5 0h3v16h-3zM17 4h3v16h-3zM5 9h1v2H5zm6.5 4h1v2h-1zM18 6h1v2h-1z',
  fx: 'M4 4h16v4H4zm2 6h12v3H6zm2 5h8v3H8z',
  wave: 'M2 12h2l2-6 3 12 3-16 3 20 2-10h3',
  folder: 'M3 6h6l2 2h10v11H3z',
  search: 'M10 3a7 7 0 105.3 11.6l4 4 1.4-1.4-4-4A7 7 0 0010 3zm0 2a5 5 0 110 10 5 5 0 010-10z',
  plug: 'M9 2v6H7v3a5 5 0 004 4.9V21h2v-5.1A5 5 0 0017 11V8h-2V2h-2v6h-2V2z',
  down: 'M12 16l-6-6h4V4h4v6h4z',
  up: 'M12 8l6 6h-4v6h-4v-6H6z',
  scissors: 'M6 3l6 8-6 8 2 1 5-7 5 7 2-1-6-8 6-8-2-1-5 7-5-7z',
  copy: 'M8 3h11v14h-2v3H6V6h2zm0 3v9h7V6z',
  wand: 'M4 20L16 8l-2-2L2 18zm14-14l2 2 2-2-2-2zm-4 0l1 3 3 1-3 1-1 3-1-3-3-1 3-1z',
  master: 'M3 17l4-8 4 5 3-9 4 12H3z',
  gear: 'M12 8a4 4 0 100 8 4 4 0 000-8zm9 4l2 1.5-2 3-2.3-.7a7 7 0 01-1.5.9L15 20h-6l-.2-2.3a7 7 0 01-1.5-.9L5 17.5l-2-3L5 13a7 7 0 010-2L3 9.5l2-3 2.3.7a7 7 0 011.5-.9L9 4h6l.2 2.3a7 7 0 011.5.9l2.3-.7 2 3L19 11a7 7 0 010 2z',
};
export function icon(name, size = 18, color = 'currentColor') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', color);
  svg.classList.add('icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICON[name] || ICON.plus);
  svg.appendChild(p);
  return svg;
}

/* ------------------------------------------------------------------ modals */
export function modal({ title, body, actions = [], width = 560, onClose }) {
  const back = h('div', { class: 'modal-backdrop' });
  const box = h('div', { class: 'modal', style: { width: width + 'px' } });
  const head = h('div', { class: 'modal-head' }, h('h3', {}, title),
    h('button', { class: 'icon-btn', title: 'Close', onclick: () => close() }, '✕'));
  const content = h('div', { class: 'modal-body' }, body);
  const foot = h('div', { class: 'modal-foot' }, actions.map(a =>
    h('button', { class: 'btn ' + (a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : ''), onclick: () => { a.onClick?.(close); } }, a.label)));
  box.append(head, content, foot);
  back.append(box);
  document.body.append(back);
  requestAnimationFrame(() => back.classList.add('show'));
  function close() {
    back.classList.remove('show');
    setTimeout(() => back.remove(), 140);
    onClose?.();
  }
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  const esc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
  return { close, body: content, el: box };
}

/* ------------------------------------------------------------------ toasts */
let toastRoot = null;
export function toast(kind, text, ms = 3600) {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toasts' });
    document.body.append(toastRoot);
  }
  const t = h('div', { class: `toast toast-${kind}` }, text);
  toastRoot.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, ms);
  return t;
}

/* ------------------------------------------------------------------ misc UI */
export function slider({ label, min, max, step = 1, value = 0, unit = '', onInput, format }) {
  const val = h('span', { class: 'slider-val' }, (format ? format(value) : value + unit));
  const inp = h('input', { type: 'range', min, max, step, value, class: 'slider' });
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    val.textContent = format ? format(v) : v + unit;
    onInput?.(v);
  });
  const wrap = h('label', { class: 'ctrl' }, h('span', { class: 'ctrl-label' }, label), inp, val);
  wrap.setValue = (v) => { inp.value = v; val.textContent = format ? format(v) : v + unit; };
  return wrap;
}

export function knob({ label, min, max, value = 0, step = 0.01, unit = '', size = 46, onInput, format, bipolar = false }) {
  const wrap = h('div', { class: 'knob-wrap' });
  const cv = h('canvas', { class: 'knob', width: size * 2, height: size * 2, style: { width: size + 'px', height: size + 'px' } });
  const valEl = h('div', { class: 'knob-val' }, fmt(value));
  const labEl = h('div', { class: 'knob-label' }, label);
  wrap.append(cv, valEl, labEl);
  const ctx = cv.getContext('2d');
  let v = value;

  function fmt(x) { return format ? format(x) : (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2)) + unit; }
  function draw() {
    const s = size * 2, c = s / 2, r = s * 0.34;
    ctx.clearRect(0, 0, s, s);
    ctx.lineWidth = s * 0.09; ctx.lineCap = 'round';
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.arc(c, c, r, a0, a1); ctx.stroke();
    const norm = bipolar ? (v - (min + max) / 2) / ((max - min) / 2) : (v - min) / (max - min);
    const mid = bipolar ? (a0 + a1) / 2 : a0;
    const end = bipolar ? mid + norm * ((a1 - a0) / 2) : a0 + clampNum(norm, 0, 1) * (a1 - a0);
    ctx.strokeStyle = norm < 0 && bipolar ? '#ff9f6b' : '#59c8ff';
    ctx.beginPath();
    ctx.arc(c, c, r, Math.min(mid, end), Math.max(mid, end));
    ctx.stroke();
    // pointer
    const ang = bipolar ? end : end;
    ctx.strokeStyle = '#e8f4ff'; ctx.lineWidth = s * 0.06;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(ang) * r * 0.42, c + Math.sin(ang) * r * 0.42);
    ctx.lineTo(c + Math.cos(ang) * r * 0.86, c + Math.sin(ang) * r * 0.86);
    ctx.stroke();
    valEl.textContent = fmt(v);
  }
  draggable(cv, {
    cursor: 'ns-resize',
    onStart: () => cv.classList.add('active'),
    onMove: (s, e) => {
      const range = max - min;
      const delta = (-s.dy + (e.shiftKey ? 0 : 0)) / 180;
      v = clampNum(v + delta * range * (e.shiftKey ? 0.2 : 1), min, max);
      v = Math.round(v / step) * step;
      draw(); onInput?.(v);
    },
    onEnd: () => cv.classList.remove('active'),
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const range = max - min;
    v = clampNum(v - Math.sign(e.deltaY) * range * (e.shiftKey ? 0.002 : 0.01), min, max);
    v = Math.round(v / step) * step;
    draw(); onInput?.(v);
  }, { passive: false });
  cv.addEventListener('dblclick', () => { v = value; draw(); onInput?.(v); });
  wrap.setValue = (x) => { v = x; draw(); };
  draw();
  return wrap;
}

export function select({ label, options, value, onChange }) {
  const sel = h('select', { class: 'sel' },
    options.map(o => h('option', { value: typeof o === 'object' ? o.value : o, selected: String(typeof o === 'object' ? o.value : o) === String(value) },
      typeof o === 'object' ? o.label : o)));
  sel.addEventListener('change', () => onChange?.(sel.value));
  const wrap = label ? h('label', { class: 'ctrl ctrl-inline' }, h('span', { class: 'ctrl-label' }, label), sel) : sel;
  wrap.setValue = (v) => { sel.value = v; };
  return wrap;
}

export function toggle({ label, value = false, onChange }) {
  const box = h('button', { class: 'toggle' + (value ? ' on' : ''), role: 'switch', 'aria-checked': String(value) },
    h('span', { class: 'toggle-knob' }));
  box.addEventListener('click', () => {
    const nv = !box.classList.contains('on');
    box.classList.toggle('on', nv);
    box.setAttribute('aria-checked', String(nv));
    onChange?.(nv);
  });
  box.setValue = (v) => { box.classList.toggle('on', !!v); box.setAttribute('aria-checked', String(!!v)); };
  return label ? h('label', { class: 'ctrl ctrl-inline' }, h('span', { class: 'ctrl-label' }, label), box) : box;
}

export function numInput({ label, value, min, max, step = 1, unit = '', onChange, width = 74 }) {
  const inp = h('input', { type: 'number', class: 'num', value, min, max, step, style: { width: width + 'px' } });
  const commit = () => {
    let v = parseFloat(inp.value);
    if (!Number.isFinite(v)) v = value;
    v = clampNum(v, min, max);
    inp.value = v;
    onChange?.(v);
  };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); inp.blur(); } });
  const suffix = unit ? h('span', { class: 'num-unit' }, unit) : null;
  const wrap = h('label', { class: 'ctrl ctrl-inline' }, label ? h('span', { class: 'ctrl-label' }, label) : null, inp, suffix);
  wrap.setValue = (v) => { inp.value = v; };
  return wrap;
}

export function buildParamControl(key, spec, value, onChange) {
  if (spec.type === 'select') {
    return select({
      label: spec.label, value, options: spec.options,
      onChange: (v) => {
        const num = Number(v);
        onChange(Number.isNaN(num) ? v : num);
      },
    });
  }
  if (spec.type === 'bool') {
    return toggle({ label: spec.label, value: !!value, onChange });
  }
  return knob({
    label: spec.label, min: spec.min, max: spec.max, step: spec.step || 0.01,
    value, unit: spec.unit || '',
    bipolar: spec.min < 0 && spec.max > 0,
    format: (v) => (spec.unit === ' dB' || spec.unit === ' %' || spec.unit === ' Hz' || spec.unit === ' s' || spec.unit === ' ms'
      ? (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(spec.step < 0.1 ? 3 : 1))) + spec.unit
      : v.toFixed(2) + (spec.unit || '')),
    onInput: onChange,
  });
}

export function colorFor(str) {
  let sum = 0;
  for (let i = 0; i < str.length; i++) sum = (sum * 31 + str.charCodeAt(i)) >>> 0;
  const hsl = sum % 360;
  return `hsl(${hsl} 62% 56%)`;
}
export const TRACK_COLORS = ['#4aa3ff', '#ff6b9d', '#5fd39a', '#ffc857', '#b28dff', '#ff8f5e', '#57d9e8', '#a3e05b', '#ff7a7a', '#7f9cff'];
