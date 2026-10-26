/**
 * QwenWave — Browser panel (left side).
 * Tabs: Samples · FX · Plugins · Projects
 */
import Store, { Bus, TOPICS, clamp } from '../core/store.js';
import Library from '../engine/library.js';
import Transport from '../engine/transport.js';
import PluginManager, { KIND } from '../engine/pluginhost.js';
import { FX_DEFS, fxTypesByCategory, FX_PRESETS } from '../effects/defs.js';
import * as P from '../engine/persistence.js';
import { h, $, clear, icon, drawWaveform, fitCanvas, toast, modal } from './dom.js';
import { Drag, droppable } from './drag.js';
import { openFxPicker } from './fxrack.js';
import { openPluginBridgeInfo } from './modals.js';

let root = null;
let activeTab = 'samples';
const filters = { q: '', category: null, loop: null, bpmMatch: false, keyMatch: false };
let auditionHandle = null;

export function mountBrowser(el) {
  root = el;
  render();
  Bus.on(TOPICS.LIBRARY, () => { if (activeTab === 'samples') renderSamples(); });
  Bus.on(TOPICS.PLUGINS, () => { if (activeTab === 'plugins') renderPlugins(); });
  Bus.on(TOPICS.PROJECT, () => { if (activeTab === 'projects') renderProjects(); });

  // global file drop anywhere in the window
  window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    await handleFiles(e.dataTransfer.files);
  });
}

export async function handleFiles(files) {
  const list = [...files];
  const audio = list.filter(f => /\.(wav|mp3|ogg|oga|flac|m4a|aac|aif|aiff)$/i.test(f.name));
  const plugins = list.filter(f => /\.(dll|vst3|so|dylib|component|wasm|zip|m?js)$/i.test(f.name));
  const projects = list.filter(f => /\.(qwp|qwpz)$/i.test(f.name));

  if (projects.length) {
    for (const f of projects) {
      try {
        if (/\.qwpz$/i.test(f.name)) await P.importProjectBundle(f);
        else await P.importProjectFile(f);
        toast('success', `Проект загружен: ${f.name}`);
      } catch (e) { toast('error', 'Не удалось открыть проект: ' + e.message); }
    }
    return;
  }
  if (plugins.length) {
    switchTab('plugins');
    const r = await PluginManager.install(plugins);
    for (const res of r.results || []) {
      if (!res.ok) toast('error', `${res.name}: ${res.error}`);
      else if (res.runnable) toast('success', `Плагин установлен: ${res.name}`);
      else toast('warn', `${res.name}: ${res.format} — нативный плагин. Зарегистрирован в режиме моста (встроенная эмуляция применена).`, 7000);
    }
    return;
  }
  if (audio.length) {
    switchTab('samples');
    const pack = prompt('Имя пака для импорта:', 'My Samples') || 'My Samples';
    Bus.emit(TOPICS.STATUS, { text: `Importing ${audio.length} sample(s)…` });
    const added = await Library.importFiles(audio, pack);
    toast('success', `Импортировано сэмплов: ${added.length}`);
  }
}

export function switchTab(name) {
  activeTab = name;
  render();
}

function render() {
  if (!root) return;
  clear(root);
  root.className = 'browser';
  const tabs = h('div', { class: 'tabs' },
    ...['samples', 'fx', 'plugins', 'projects'].map(t =>
      h('button', { class: 'tab' + (t === activeTab ? ' active' : ''), onclick: () => switchTab(t) },
        { samples: 'Сэмплы', fx: 'Эффекты', plugins: 'Плагины', projects: 'Проекты' }[t])));
  const body = h('div', { class: 'tab-body' });
  root.append(tabs, body);
  if (activeTab === 'samples') renderSamples(body);
  else if (activeTab === 'fx') renderFx(body);
  else if (activeTab === 'plugins') renderPlugins(body);
  else renderProjects(body);
}

/* ============================================================== SAMPLES */
function renderSamples(body) {
  body = body || $('.tab-body', root);
  clear(body);

  const search = h('div', { class: 'search-box' });
  const inp = h('input', { type: 'search', placeholder: 'Поиск: kick 808, A#3, 140bpm…', value: filters.q });
  let t = null;
  inp.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { filters.q = inp.value; renderList(); }, 130);
  });
  const chipRow = h('div', { class: 'filter-row' });
  const mkChip = (label, key, val) => {
    const c = h('button', { class: 'chip' + (filters[key] === val ? ' on' : '') }, label);
    c.onclick = () => { filters[key] = filters[key] === val ? null : val; render(); };
    return c;
  };
  chipRow.append(
    mkChip('Лупы', 'loop', true), mkChip('One-shot', 'loop', false),
    mkChip('Темп проекта', 'bpmMatch', true), mkChip('Тональность', 'keyMatch', true),
  );
  search.append(inp, chipRow);

  const dropZone = h('div', { class: 'drop-hint' },
    h('div', {}, '⤓ Перетащите сюда аудиофайлы (wav/mp3/flac/ogg) или папку с сэмплами'),
    h('div', { class: 'small muted', style: { marginTop: '4px' } }, 'Файлы сохраняются в IndexedDB — проект остаётся рабочим между сессиями'));
  const fileInp = h('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.flac,.ogg,.aif,.aiff', multiple: true, style: { display: 'none' } });
  fileInp.addEventListener('change', () => { if (fileInp.files.length) handleFiles(fileInp.files); fileInp.value = ''; });
  dropZone.onclick = () => fileInp.click();
  ['dragover', 'dragenter'].forEach(ev => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, () => dropZone.classList.remove('over')));
  dropZone.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

  const listWrap = h('div', { class: 'sample-list' });
  const counter = h('div', { class: 'small muted', style: { padding: '5px 10px' } });
  body.append(search, dropZone, fileInp, counter, listWrap);

  function renderList() {
    clear(listWrap);
    const f = { ...filters };
    if (f.bpmMatch) f.bpm = Store.project.bpm;
    if (f.keyMatch) f.key = keyLabel(Store.project.key);
    const results = Library.search(f.q, {
      category: f.category, loop: f.loop,
      bpm: f.bpm || undefined, key: f.key || undefined,
    });
    counter.textContent = `${results.length} из ${Library.samples.length} сэмплов · кэш: ${Library.cacheInfo.decoded} дек. / ${Library.cacheInfo.mb} MB`;

    // group by pack
    const groups = new Map();
    for (const s of results) {
      const g = s.pack || s.category;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    }
    for (const [gname, items] of groups) {
      const g = h('div', { class: 'tree-group open' });
      const head = h('div', { class: 'tree-head' },
        h('span', { class: 'caret' }, '▶'), h('span', {}, gname),
        h('span', { class: 'count' }, String(items.length)));
      head.onclick = () => g.classList.toggle('open');
      const list = h('div', { class: 'tree-items' });
      for (const s of items.slice(0, 400)) list.append(sampleRow(s));
      if (items.length > 400) list.append(h('div', { class: 'hint', style: { padding: '6px 10px' } }, `…и ещё ${items.length - 400} — уточните поиск`));
      g.append(head, list);
      listWrap.append(g);
    }
    if (!results.length) {
      listWrap.append(h('div', { class: 'empty-state' },
        h('h4', {}, 'Ничего не найдено'),
        h('div', { class: 'hint' }, 'Сбросьте фильтры или импортируйте свои сэмплы.')));
    }
  }
  renderList();
}

function keyLabel(key) {
  const N = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return N[(key?.root ?? 0) % 12];
}

function sampleRow(s) {
  const row = h('div', { class: 'sample', draggable: 'true', title: `${s.name}\n${s.duration?.toFixed(2)}s · ${s.channels}ch · ${(s.bytes / 1024).toFixed(0)} KB${s.rms !== undefined ? ' · ' + s.rms + ' dB RMS' : ''}` });
  const cv = h('canvas', { class: 'sample-wave' });
  const badges = h('div', { class: 'sample-meta' });
  if (s.bpm) badges.append(h('span', { class: 'badge bpm' }, s.bpm + ' BPM'));
  if (s.key) badges.append(h('span', { class: 'badge key' }, s.key));
  if (s.loop) badges.append(h('span', { class: 'badge loop' }, 'LOOP'));
  if (s.isUser) badges.append(h('span', { class: 'badge user' }, 'USER'));
  if (s.isIR) badges.append(h('span', { class: 'badge' }, 'IR'));
  row.append(cv,
    h('div', { class: 'sample-info' }, h('div', { class: 'sample-name' }, s.name), badges));

  // lazy waveform: draw only when scrolled into view
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) {
      io.disconnect();
      const peaks = Library.getPeaks(s.id, 64) || new Array(64).fill(0.15);
      const ctx = fitCanvas(cv, 52, 20);
      drawWaveform(cv, peaks, { color: s.loop ? '#7fd1ff' : '#8fe3b8', bg: 'rgba(255,255,255,0.03)' });
    }
  }, { rootMargin: '120px' });
  io.observe(row);

  row.addEventListener('dragstart', (e) => {
    Drag.start({ kind: 'sample', sampleId: s.id, sample: s }, e);
  });
  row.addEventListener('dragend', () => Drag.end());

  // click = audition, dblclick = add to selected track
  let clickTimer = null;
  row.addEventListener('click', () => {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
    clickTimer = setTimeout(() => { clickTimer = null; toggleAudition(s, row); }, 130);
  });
  row.addEventListener('dblclick', () => {
    addToSelectedTrack(s);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    sampleMenu(s, e.clientX, e.clientY);
  });
  return row;
}

function toggleAudition(s, row) {
  if (auditionHandle) { auditionHandle.stop(); auditionHandle = null; }
  document.querySelectorAll('.sample.playing').forEach(e => e.classList.remove('playing'));
  if (auditionRow === row) { auditionRow = null; return; }
  auditionRow = row;
  row.classList.add('playing');
  Transport.audition(s.id, { loop: !!s.loop }).then(h2 => {
    auditionHandle = { stop: () => { h2.stop(); row.classList.remove('playing'); auditionRow = null; } };
  }).catch(e => toast('error', 'Прослушивание не удалось: ' + e.message));
}
let auditionRow = null;

function sampleMenu(s, x, y) {
  const items = [
    { label: 'Добавить на выбранную дорожку', fn: () => addToSelectedTrack(s) },
    { label: 'Создать новую дорожку с этим сэмплом', fn: () => addToNewTrack(s) },
    { label: 'Назначить инструменту MIDI-дорожки', fn: () => assignAsInstrument(s) },
    { label: 'Прослушать (луп)', fn: () => Transport.audition(s.id, { loop: true }) },
    ...(s.isUser ? [{ label: 'Удалить из библиотеки', danger: true, fn: async () => { if (confirm('Удалить сэмпл?')) await Library.deleteSample(s.id); } }] : []),
  ];
  showContextMenu(x, y, items);
}

export function showContextMenu(x, y, items) {
  document.querySelectorAll('.ctx-menu').forEach(e => e.remove());
  const menu = h('div', { class: 'ctx-menu' });
  for (const it of items) {
    if (it.sep) { menu.append(h('div', { class: 'ctx-sep' })); continue; }
    menu.append(h('div', { class: 'ctx-item' + (it.danger ? ' danger' : ''), onclick: () => { menu.remove(); it.fn?.(); } }, it.label));
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', off); } };
  setTimeout(() => document.addEventListener('pointerdown', off), 0);
}

/* ------------------------------------------------------------ sample actions */
export function addToSelectedTrack(s) {
  let t = Store.selectedTrack;
  if (!t) { Bus.emit(TOPICS.TOAST, { kind: 'warn', text: 'Сначала выберите или создайте дорожку' }); return; }
  if (t.type === 'midi') {
    t.instrument.engine = 'sampler';
    t.instrument.sampleId = s.id;
    t.instrument.sampleName = s.name;
    if (s.keyMidi) t.instrument.rootKey = s.keyMidi;
    Bus.emit(TOPICS.TRACKS, { updated: t.id });
    Bus.emit(TOPICS.TOAST, { kind: 'success', text: `${s.name} → инструмент дорожки "${t.name}"` });
    return;
  }
  addClipToTrack(t, s);
}
export function addToNewTrack(s) {
  const { addTrack } = require_actions();
  const t = addTrack('audio', { name: s.name.slice(0, 24) });
  addClipToTrack(t, s);
}
export function assignAsInstrument(s) {
  let t = Store.tracks.find(x => x.type === 'midi');
  if (!t) {
    const { addTrack } = require_actions();
    t = addTrack('midi', { name: s.name.slice(0, 24) });
  }
  t.instrument.engine = 'sampler';
  t.instrument.sampleId = s.id;
  t.instrument.sampleName = s.name;
  if (s.keyMidi) t.instrument.rootKey = s.keyMidi;
  Bus.emit(TOPICS.TRACKS, { updated: t.id });
  Bus.emit(TOPICS.TOAST, { kind: 'success', text: `${s.name} → инструмент "${t.name}" (root ${s.key || 'C4'})` });
}
export function addClipToTrack(track, s, atBeat = null) {
  const { actions } = require_actions();
  actions.addSampleClip(track, s, atBeat);
}

let _actions = null;
export function registerActions(a) { _actions = a; }
function require_actions() {
  if (!_actions) throw new Error('actions not registered');
  return { addTrack: _actions.addTrack, actions: _actions };
}

/* ============================================================== FX */
function renderFx(body) {
  body = body || $('.tab-body', root);
  clear(body);
  const head = h('div', { style: { padding: '9px 11px' } },
    h('div', { class: 'section-title' }, 'Встроенные эффекты'),
    h('div', { class: 'hint' }, 'Клик — добавить на выбранную дорожку. Перетащите в миксер или на цепочку FX.'));
  body.append(head);
  const byCat = fxTypesByCategory();
  for (const [cat, list] of Object.entries(byCat)) {
    body.append(h('div', { class: 'fx-cat', style: { padding: '0 11px' } }, cat));
    const grid = h('div', { class: 'fx-picker', style: { padding: '0 11px 6px' } });
    for (const f of list) {
      const el = h('div', { class: 'fx-item', draggable: 'true', title: FX_DEFS[f.id].name }, f.name);
      el.addEventListener('click', () => _actions?.addFxToSelected(f.id));
      el.addEventListener('dragstart', (e) => Drag.start({ kind: 'fx', fxType: f.id }, e));
      el.addEventListener('dragend', () => Drag.end());
      grid.append(el);
    }
    body.append(grid);
  }
  body.append(h('div', { class: 'fx-cat', style: { padding: '10px 11px 4px' } }, 'Пресеты цепочек'));
  const pg = h('div', { class: 'fx-picker', style: { padding: '0 11px 12px' } });
  for (const name of Object.keys(FX_PRESETS)) {
    const el = h('div', { class: 'fx-item', draggable: 'true', title: FX_PRESETS[name].map(x => FX_DEFS[x.type]?.name || x.type).join(' → ') }, name);
    el.addEventListener('click', () => _actions?.applyPresetToSelected(name));
    el.addEventListener('dragstart', (e) => Drag.start({ kind: 'fxpreset', preset: name }, e));
    el.addEventListener('dragend', () => Drag.end());
    pg.append(el);
  }
  body.append(pg);
}

/* ============================================================== PLUGINS */
function renderPlugins(body) {
  body = body || $('.tab-body', root);
  clear(body);
  const head = h('div', { style: { padding: '9px 11px' } });
  head.append(
    h('div', { class: 'section-title' }, 'Плагины'),
    h('div', { class: 'hint' }, 'Поддерживаются Web Audio Module (WAM 2.0), AudioWorklet-процессоры, JS-плагины QwenWave SDK и WASM-сборки. Нативные .dll/.vst3 определяются и подключаются через мост.'),
    h('div', { class: 'row', style: { marginTop: '8px', gap: '6px', flexWrap: 'wrap' } },
      h('button', { class: 'btn btn-primary btn-sm', onclick: () => pluginFileInput.click() }, icon('plus', 13), 'Установить плагин'),
      h('button', { class: 'btn btn-sm', onclick: () => openPluginBridgeInfo() }, 'Как подключить VST/DLL'),
      h('button', { class: 'btn btn-sm', onclick: downloadSdk }, 'Скачать SDK')));
  const pluginFileInput = h('input', {
    type: 'file', multiple: true, style: { display: 'none' },
    accept: '.js,.mjs,.json,.zip,.wasm,.dll,.vst3,.so,.dylib,.component,.clap,.aaxplugin',
  });
  pluginFileInput.addEventListener('change', () => { if (pluginFileInput.files.length) handleFiles(pluginFileInput.files); pluginFileInput.value = ''; });
  body.append(head, pluginFileInput);

  const dropZone = h('div', { class: 'drop-hint' }, '⤓ Перетащите .dll / .vst3 / .wam / .zip / .js сюда');
  ['dragover', 'dragenter'].forEach(ev => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, () => dropZone.classList.remove('over')));
  dropZone.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
  body.append(dropZone);

  const list = PluginManager.list();
  const runnable = list.filter(p => p.runnable);
  const bridged = list.filter(p => !p.runnable);
  body.append(h('div', { class: 'fx-cat', style: { padding: '8px 11px 2px' } }, `Работают в браузере (${runnable.length})`));
  for (const p of runnable) body.append(pluginCard(p));
  body.append(h('div', { class: 'fx-cat', style: { padding: '10px 11px 2px' } }, `Нативные — требуют мост (${bridged.length})`));
  for (const p of bridged) body.append(pluginCard(p));
  if (!list.length) body.append(h('div', { class: 'empty-state' }, h('h4', {}, 'Плагинов пока нет'),
    h('div', { class: 'hint' }, 'Установите WAM-бандл, JS-плагин или перетащите свой .dll — мы определим формат и подскажем дальнейшие шаги.')));
}

function pluginCard(p) {
  const card = h('div', { class: 'plugin-card ' + (p.runnable ? 'ok' : 'native') });
  card.append(
    h('div', { class: 'pc-head' },
      h('span', { class: 'badge ' + (p.runnable ? 'loop' : 'native') }, p.runnable ? 'READY' : 'BRIDGE'),
      h('span', { class: 'pc-name' }, p.name),
      h('button', { class: 'icon-btn', title: 'Добавить на выбранную дорожку', onclick: (e) => { e.stopPropagation(); if (p.runnable) _actions?.addFxToSelected(p.type); else openPluginBridgeInfo(p); } }, '+'),
      p.source === 'bundled' ? null : h('button', { class: 'icon-btn', title: 'Удалить', onclick: async (e) => { e.stopPropagation(); if (confirm('Удалить плагин?')) await PluginManager.remove(p.id); } }, '✕')),
    h('div', { class: 'pc-meta' }, `${p.vendor || '—'} · v${p.version} · ${PluginManager.kindLabel(p.kind)} · ${p.format} · ${((p.size || 0) / 1024).toFixed(0)} KB`),
    p.note ? h('div', { class: 'hint', style: { marginTop: '5px', whiteSpace: 'pre-line' } }, p.note) : null,
  );
  card.addEventListener('dragstart', (e) => Drag.start({ kind: 'fx', fxType: p.type }, e));
  card.draggable = true;
  return card;
}

async function downloadSdk() {
  try {
    const files = ['assets/plugins/sdk/qwenwave-plugin-sdk.js', 'assets/plugins/sdk/example-plugin.js', 'assets/plugins/sdk/README.md'];
    const packed = [];
    for (const f of files) {
      const r = await fetch(f);
      if (r.ok) packed.push([f.split('/').pop(), await r.text()]);
    }
    const { buildZipBlob } = await import('./zipout.js');
    const blob = buildZipBlob(packed);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'qwenwave-plugin-sdk.zip'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) { toast('error', 'SDK недоступен: ' + e.message); }
}

/* ============================================================== PROJECTS */
function renderProjects(body) {
  body = body || $('.tab-body', root);
  clear(body);
  const head = h('div', { style: { padding: '9px 11px' } },
    h('div', { class: 'section-title' }, 'Проекты'),
    h('div', { class: 'row', style: { marginTop: '6px', gap: '6px', flexWrap: 'wrap' } },
      h('button', { class: 'btn btn-primary btn-sm', onclick: () => _actions?.newProject() }, icon('plus', 13), 'Новый'),
      h('button', { class: 'btn btn-sm', onclick: () => _actions?.saveProject() }, icon('save', 13), 'Сохранить'),
      h('button', { class: 'btn btn-sm', onclick: () => _actions?.saveProjectAs() }, 'Сохранить как…'),
      h('button', { class: 'btn btn-sm', onclick: () => _actions?.exportFile() }, 'Экспорт .qwp'),
      h('button', { class: 'btn btn-sm', onclick: () => _actions?.exportBundle() }, 'Экспорт .qwpz')));
  body.append(head);
  const list = h('div', {});
  body.append(list);
  (async () => {
    const { ProjectStore } = await import('../engine/library.js');
    const items = await ProjectStore.list();
    clear(list);
    if (!items.length) { list.append(h('div', { class: 'empty-state' }, h('h4', {}, 'Сохранённых проектов нет'),
      h('div', { class: 'hint' }, 'Нажмите «Сохранить», чтобы проект появился здесь и пережил перезагрузку страницы.'))); return; }
    for (const it of items) {
      const row = h('div', { class: 'plugin-card' },
        h('div', { class: 'pc-head' },
          h('span', { class: 'pc-name' }, it.name),
          h('button', { class: 'btn btn-sm', onclick: () => _actions?.loadProject(it.id) }, 'Открыть'),
          it.id !== 'autosave' ? h('button', { class: 'icon-btn', title: 'Удалить', onclick: async () => { if (confirm('Удалить проект?')) { await ProjectStore.remove(it.id); renderProjects(body); } } }, '✕') : null),
        h('div', { class: 'pc-meta' }, `${it.bpm || '—'} BPM · ${new Date(it.modified || Date.now()).toLocaleString('ru-RU')} · ${((it.size || 0) / 1024).toFixed(0)} KB${it.id === 'autosave' ? ' · автосохранение' : ''}`));
      list.append(row);
    }
  })();
}

export default { mountBrowser, handleFiles, switchTab, registerActions, addToSelectedTrack, addToNewTrack, showContextMenu };
