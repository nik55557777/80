/**
 * QwenWave — FX rack (per-track effect chain editor).
 * Insert/reorder/bypass/remove built-ins AND user plugins; every parameter is
 * generated from the effect descriptor and applied live via setTargetAtTime
 * (so turning a knob mid-note can never click).
 */
import Store, { Bus, TOPICS, clamp, uid, dbToGain } from '../core/store.js';
import Engine from '../engine/engine.js';
import Recorder from '../engine/recorder.js';
import PluginManager from '../engine/pluginhost.js';
import { FX_DEFS, fxDefaults, fxTypesByCategory, FX_PRESETS } from '../effects/defs.js';
import * as P from '../engine/persistence.js';
import { h, $, clear, icon, toast, buildParamControl, modal, select, toggle, slider, knob } from './dom.js';
import { showContextMenu } from './browser.js';
import { Drag, droppable } from './drag.js';

let panelEl = null;
let currentTarget = null;      // trackId or '__master__'
let selectedFxId = null;

export function openFxRack(targetId) {
  currentTarget = targetId || Store.project.selection.trackId || '__master__';
  const panel = $('#panel-fx');
  if (!panel) return;
  document.querySelectorAll('.bottom-panel').forEach(p => p.classList.remove('active'));
  panel.classList.add('active');
  document.querySelectorAll('.bt').forEach(b => b.classList.toggle('active', b.dataset.panel === 'fx'));
  panelEl = panel;
  render();
}

export function getTrackFxList() {
  if (currentTarget === '__master__') return Store.project.master.fx;
  const t = Store.track(currentTarget);
  return t ? t.fx : null;
}
export function currentTargetName() {
  if (currentTarget === '__master__') return 'MASTER';
  return Store.track(currentTarget)?.name || '—';
}

export function render() {
  if (!panelEl) return;
  const __act = panelEl.classList.contains('active');
  clear(panelEl);
  panelEl.className = 'bottom-panel fill' + (__act ? ' active' : '');
  panelEl.id = 'panel-fx';
  const list = getTrackFxList();
  if (!list) { panelEl.append(h('div', { class: 'empty-state' }, 'Дорожка не выбрана')); return; }

  const wrap = h('div', { class: 'rack' });
  panelEl.append(wrap);

  /* ---------------------------------------------------- slot list */
  const left = h('div', { class: 'rack-list' });
  const isMaster = currentTarget === '__master__';
  left.append(h('div', { class: 'rack-list-head' },
    icon('fx', 14), h('span', {}, `FX · ${currentTargetName()}`),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn btn-sm btn-primary', onclick: () => openFxPicker(currentTarget) }, '+ Добавить'),
    h('button', { class: 'btn btn-sm', title: 'Пресеты цепочек', onclick: showPresets }, 'Пресеты')));

  const items = h('div', { class: 'rack-items' });
  if (!list.length) {
    items.append(h('div', { class: 'empty-state' },
      h('h4', {}, 'Цепочка пуста'),
      h('div', { class: 'hint' }, 'Добавьте эффект кнопкой «+», перетащите из браузера (вкладка «Эффекты») или примените пресет — например «Vocal → Radio Lead».')));
  }
  list.forEach((inst, i) => {
    const def = FX_DEFS[inst.type];
    const plg = PluginManager.get(inst.type);
    const name = inst.name || def?.name || plg?.name || inst.type;
    const kind = def ? def.cat : (plg ? PluginManager.kindLabel(plg.kind) : 'custom');
    const slot = h('div', { class: 'rack-slot' + (inst.id === selectedFxId ? ' sel' : '') + (inst.bypassed ? ' byp' : ''), draggable: 'true' },
      h('span', { class: 'idx' }, String(i + 1)),
      h('span', { class: 'nm' }, name),
      h('span', { class: 'kind' }, kind));
    slot.addEventListener('click', () => { selectedFxId = inst.id; render(); });
    slot.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      selectedFxId = inst.id;
      showContextMenu(e.clientX, e.clientY, [
        { label: inst.bypassed ? 'Включить' : 'Обойти (bypass)', fn: () => toggleFx(inst) },
        { label: 'Вверх', fn: () => moveFx(i, -1) },
        { label: 'Вниз', fn: () => moveFx(i, 1) },
        { label: 'Дублировать', fn: () => dupFx(i) },
        { label: 'Сбросить параметры', fn: () => { Store.pushHistory('reset fx'); inst.params = { ...fxDefaults(inst.type), ...(plg ? defaultsForPlugin(plg) : {}) }; rebuild(); render(); } },
        { sep: true },
        { label: 'Удалить', danger: true, fn: () => removeFx(i) },
      ]);
      render();
    });
    slot.addEventListener('dragstart', (e) => Drag.start({ kind: 'fxslot', index: i }, e));
    slot.addEventListener('dragend', () => Drag.end());
    droppable(slot, ['fxslot'], (payload) => {
      if (payload.index === i) return;
      Store.pushHistory('reorder fx');
      const [m] = list.splice(payload.index, 1);
      list.splice(i, 0, m);
      rebuild(); render(); P.markDirty();
    });
    droppable(slot, ['fx'], (payload) => { addFxAt(payload.fxType, i); });
    droppable(slot, ['fxpreset'], (payload) => { applyPreset(payload.preset); });
    items.append(slot);
  });
  const dropTail = h('div', { class: 'drop-hint', style: { margin: '8px' } }, '⤓ Перетащите эффект или пресет сюда');
  droppable(dropTail, ['fx'], (payload) => addFx(payload.fxType));
  droppable(dropTail, ['fxpreset'], (payload) => applyPreset(payload.preset));
  items.append(dropTail);
  left.append(items);

  /* ---------------------------------------------------- params */
  const right = h('div', { class: 'rack-params' });
  const inst = list.find(f => f.id === selectedFxId) || list[0];
  if (!inst) {
    right.append(h('div', { class: 'param-empty' }, 'Выберите слот слева или добавьте эффект.'));
  } else {
    selectedFxId = inst.id;
    right.append(buildParamPanel(inst));
  }
  wrap.append(left, right);
}

function buildParamPanel(inst) {
  const def = FX_DEFS[inst.type];
  const plg = PluginManager.get(inst.type);
  const wrap = h('div', {});
  const title = inst.name || def?.name || plg?.name || inst.type;

  const head = h('div', { class: 'row', style: { marginBottom: '10px', gap: '8px', flexWrap: 'wrap' } });
  head.append(
    h('div', { style: { flex: '1', minWidth: '160px' } },
      h('div', { style: { fontSize: '14px', fontWeight: '700' } }, title),
      h('div', { class: 'small muted' }, def ? `${def.cat} · встроенный` : (plg ? `${plg.vendor} · ${PluginManager.kindLabel(plg.kind)}${plg.runnable ? '' : ' · ТРЕБУЕТСЯ МОСТ'}` : 'custom'))),
    toggle({ label: 'Bypass', value: !!inst.bypassed, onChange: () => toggleFx(inst) }),
    h('button', { class: 'btn btn-sm', onclick: () => moveFx(listIndexOf(inst), -1) }, '▲'),
    h('button', { class: 'btn btn-sm', onclick: () => moveFx(listIndexOf(inst), 1) }, '▼'),
    h('button', { class: 'btn btn-sm btn-danger', onclick: () => removeFx(listIndexOf(inst)) }, icon('trash', 12)));
  wrap.append(head);

  if (plg && !plg.runnable) {
    wrap.append(h('div', { class: 'code', style: { marginBottom: '10px' } }, plg.note || 'Нативный плагин'));
    wrap.append(h('div', { class: 'hint' }, 'Дорожка обрабатывается встроенной эмуляцией (EQ → компрессор → сатуратор → лимитер), чтобы звук не пропадал. Подробности — «Плагины → Как подключить VST/DLL».'));
  }

  const specs = def?.params || plg?.params || {};
  const grid = h('div', { class: 'param-grid' });
  let any = false;
  for (const [key, spec] of Object.entries(specs)) {
    any = true;
    const value = inst.params[key] !== undefined ? inst.params[key] : spec.def;
    const ctl = buildParamControl(key, spec, value, (v) => {
      inst.params[key] = v;
      Engine.updateFxParams(currentTarget === '__master__' ? null : currentTarget, inst.id);
      if (currentTarget !== '__master__') Recorder.refreshMonitorFx(Store.track(currentTarget));
      P.markDirty();
    });
    grid.append(ctl);
  }
  if (!any) grid.append(h('div', { class: 'hint' }, 'У этого плагина нет объявленных параметров.'));
  wrap.append(grid);

  // plugin-provided custom GUI (WAM)
  const entry = Engine.graphs.get(currentTarget)?.fxNodes?.find(f => f.inst.id === inst.id);
  if (entry?.node?.getGui) {
    const host = h('div', { style: { marginTop: '12px' } });
    wrap.append(host);
    Promise.resolve(entry.node.getGui()).then(gui => { if (gui) host.append(gui); }).catch(() => {});
  }
  return wrap;
}

function defaultsForPlugin(p) {
  const o = {};
  for (const [k, v] of Object.entries(p.params || {})) o[k] = v.def;
  return o;
}
function listIndexOf(inst) { return getTrackFxList().findIndex(f => f.id === inst.id); }

/* ------------------------------------------------------------------ ops */
export function addFxToSelected(type) {
  const id = Store.project.selection.trackId || currentTarget;
  if (!id) { toast('info', 'Выберите дорожку'); return; }
  addFxToTrack(id, type);
}
export function addFxToTrack(trackId, type) {
  const list = trackId === '__master__' ? Store.project.master.fx : Store.track(trackId)?.fx;
  if (!list) { toast('info', 'Выберите дорожку'); return; }
  addFxTo(list, type, trackId);
}
function addFxTo(list, type, trackId) {
  const def = FX_DEFS[type];
  const plg = PluginManager.get(type);
  if (!def && !plg) { toast('error', 'Неизвестный эффект: ' + type); return; }
  Store.pushHistory('add fx');
  const inst = {
    id: uid('fx'), type,
    params: def ? { ...fxDefaults(type) } : { ...defaultsForPlugin(plg) },
    bypassed: false, name: null,
  };
  list.push(inst);
  selectedFxId = inst.id;
  rebuild(trackId);
  render();
  Bus.emit(TOPICS.MIXER, {});
  P.markDirty();
  toast('success', `Добавлен: ${def?.name || plg?.name || type}`);
}
export function addFxAt(type, index) {
  const list = getTrackFxList(); if (!list) return;
  const def = FX_DEFS[type]; const plg = PluginManager.get(type);
  if (!def && !plg) return;
  Store.pushHistory('insert fx');
  list.splice(index, 0, { id: uid('fx'), type, params: def ? { ...fxDefaults(type) } : { ...defaultsForPlugin(plg) }, bypassed: false });
  rebuild(); render(); P.markDirty();
}
function toggleFx(inst) {
  Store.pushHistory('toggle fx');
  inst.bypassed = !inst.bypassed;
  rebuild(); render(); Bus.emit(TOPICS.MIXER, {}); P.markDirty();
}
function moveFx(i, dir) {
  const list = getTrackFxList(); if (!list) return;
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  Store.pushHistory('move fx');
  const [m] = list.splice(i, 1); list.splice(j, 0, m);
  rebuild(); render(); P.markDirty();
}
function dupFx(i) {
  const list = getTrackFxList(); if (!list) return;
  Store.pushHistory('dup fx');
  const c = JSON.parse(JSON.stringify(list[i])); c.id = uid('fx');
  list.splice(i + 1, 0, c);
  rebuild(); render(); P.markDirty();
}
function removeFx(i) {
  const list = getTrackFxList(); if (!list) return;
  Store.pushHistory('remove fx');
  list.splice(i, 1);
  selectedFxId = null;
  rebuild(); render(); Bus.emit(TOPICS.MIXER, {}); P.markDirty();
}

function rebuild(trackId = currentTarget) {
  if (trackId === '__master__') { Engine.rebuildMasterFx?.(); Engine.applyMasterSettings(); return; }
  const t = Store.track(trackId);
  if (!t) return;
  Engine.rebuildTrackFx(trackId);
  Engine.applyTrackState(t);
  Recorder.refreshMonitorFx(t);
}

/* ---------------------------------------------------------------- picker */
export function openFxPicker(targetId) {
  const body = h('div', {});
  const search = h('input', { type: 'search', class: 'sel', style: { width: '100%', marginBottom: '8px' }, placeholder: 'Поиск эффектов и плагинов…' });
  const listWrap = h('div', {});
  body.append(search, listWrap);

  const draw = (q = '') => {
    clear(listWrap);
    const qq = q.toLowerCase();
    const byCat = fxTypesByCategory();
    for (const [cat, list] of Object.entries(byCat)) {
      const filtered = list.filter(f => !qq || f.name.toLowerCase().includes(qq) || cat.toLowerCase().includes(qq));
      if (!filtered.length) continue;
      listWrap.append(h('div', { class: 'fx-cat' }, cat));
      const g = h('div', { class: 'fx-picker' });
      for (const f of filtered) {
        const el = h('div', { class: 'fx-item', title: describeFx(f.id) }, f.name);
        el.onclick = () => { m.close(); addFxToTrack(targetId, f.id); };
        g.append(el);
      }
      listWrap.append(g);
    }
    const plgs = PluginManager.runnable().filter(p => !qq || p.name.toLowerCase().includes(qq));
    if (plgs.length) {
      listWrap.append(h('div', { class: 'fx-cat' }, 'Плагины пользователя'));
      const g = h('div', { class: 'fx-picker' });
      for (const p of plgs) {
        const el = h('div', { class: 'fx-item', title: `${p.vendor} · ${PluginManager.kindLabel(p.kind)}` }, '🔌 ' + p.name);
        el.onclick = () => { m.close(); addFxToTrack(targetId, p.type); };
        g.append(el);
      }
      listWrap.append(g);
    }
  };
  search.addEventListener('input', () => draw(search.value));
  draw();
  const m = modal({ title: `Добавить эффект — ${Store.track(targetId)?.name || 'MASTER'}`, body, width: 640, actions: [{ label: 'Закрыть' }] });
}

function describeFx(id) {
  const d = FX_DEFS[id];
  if (!d) return id;
  const ps = Object.values(d.params).slice(0, 5).map(p => p.label).join(', ');
  return `${d.cat} · ${ps}`;
}

function showPresets() {
  const body = h('div', {});
  body.append(h('div', { class: 'hint', style: { marginBottom: '8px' } },
    'Пресет заменяет текущую цепочку дорожки. Обработка вокала доступна в пресетах «Vocal → …».'));
  const g = h('div', { class: 'fx-picker' });
  for (const [name, chain] of Object.entries(FX_PRESETS)) {
    const el = h('div', { class: 'fx-item', title: chain.map(c => FX_DEFS[c.type]?.name || c.type).join(' → ') }, name);
    el.style.gridColumn = 'span 2';
    el.onclick = () => { m.close(); applyPreset(name); };
    g.append(el);
  }
  body.append(g);
  const m = modal({ title: 'Пресеты цепочек эффектов', body, width: 620, actions: [{ label: 'Закрыть' }] });
}

export function applyPresetToSelected(name) {
  const id = Store.project.selection.trackId || currentTarget;
  if (!id) { toast('info', 'Выберите дорожку'); return; }
  applyPresetToTrack(id, name);
}
export function applyPresetToTrack(trackId, name) {
  const chain = FX_PRESETS[name];
  if (!chain) return;
  const list = trackId === '__master__' ? Store.project.master.fx : Store.track(trackId)?.fx;
  if (!list) return;
  Store.pushHistory('apply preset');
  list.length = 0;
  for (const c of chain) list.push({ id: uid('fx'), type: c.type, params: { ...fxDefaults(c.type), ...c.params }, bypassed: false, name: null });
  rebuild(trackId);
  if (currentTarget === trackId) render();
  Bus.emit(TOPICS.MIXER, {});
  Bus.emit(TOPICS.TRACKS, { updated: trackId });
  P.markDirty();
  toast('success', `Пресет «${name}» применён (${chain.length} модулей)`);
}
function applyPreset(name) { applyPresetToTrack(currentTarget, name); }

export default { openFxRack, render, addFxToSelected, applyPresetToSelected, addFxToTrack, applyPresetToTrack };
