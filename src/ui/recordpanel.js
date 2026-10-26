/**
 * QwenWave — Record / Vocal booth panel.
 * Device selection, input meter + spectrum, ZERO-LATENCY MONITORING through
 * the track FX chain (so you hear yourself *with* plugins), A/B dry↔wet,
 * input cleanup (HPF/gate/gain), one-click vocal chains, take list and the
 * pitch-correction launcher.
 */
import Store, { Bus, TOPICS, clamp, uid, noteName } from '../core/store.js';
import Engine from '../engine/engine.js';
import Recorder from '../engine/recorder.js';
import Library from '../engine/library.js';
import Transport from '../engine/transport.js';
import { FX_PRESETS, FX_DEFS, fxDefaults } from '../effects/defs.js';
import * as P from '../engine/persistence.js';
import { openFxRack, applyPresetToTrack } from './fxrack.js';
import { openAudioEditor } from './audioeditor.js';
import { h, $, clear, fitCanvas, drawMeter, toast, toggle, slider, select, numInput, observeSize } from './dom.js';
import { showContextMenu } from './browser.js';

let root, meterCv, specCv, deviceSel, statusEl, takeList, armedLabel;
let abState = { wet: true };
let raf = null;

export function mountRecordPanel(el) {
  root = el;
  build();
  Bus.on(TOPICS.RECORD, () => refresh());
  Bus.on(TOPICS.TRACKS, () => refresh());
  Bus.on(TOPICS.FX, () => refresh());
  if (!raf) loop();
}

function build() {
  const __act = root.classList.contains('active');
  clear(root);
  root.className = 'bottom-panel' + (__act ? ' active' : '');
  root.style.padding = '12px';

  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '340px 1fr 300px', gap: '14px', alignItems: 'start' } });
  root.append(grid);

  /* ------------------------------------------------ input column */
  const input = h('div', { class: 'col' });
  input.append(h('div', { class: 'insp-title' }, 'Вход / микрофон'));
  deviceSel = h('select', { class: 'sel', style: { width: '100%' } });
  deviceSel.onchange = async () => {
    const t = armedTrack();
    if (!t) return;
    t.input.deviceId = deviceSel.value || null;
    if (Recorder.monitorEnabled) { await Recorder.openMic(t, t.input.deviceId); }
    P.markDirty();
  };
  input.append(h('div', { class: 'ctrl-label' }, 'Устройство'), deviceSel,
    h('button', { class: 'btn btn-sm', onclick: loadDevices }, '↻ Обновить список'));

  meterCv = h('canvas', { style: { width: '100%', height: '64px', background: '#05070a', borderRadius: '5px', border: '1px solid var(--line)' } });
  specCv = h('canvas', { style: { width: '100%', height: '74px', background: '#05070a', borderRadius: '5px', border: '1px solid var(--line)' } });
  statusEl = h('div', { class: 'small muted mono' }, 'Микрофон не открыт');
  input.append(h('div', { class: 'ctrl-label' }, 'Уровень входа'), meterCv, specCv, statusEl);

  const gain = slider({ label: 'Input gain', min: 0, max: 300, step: 1, value: 100, unit: ' %',
    onInput: (v) => { const t = armedTrack(); if (t) { (t.input ||= {}).gain = v / 100; Engine._updateMonitor(t); P.markDirty(); } } });
  const hpf = slider({ label: 'High-pass', min: 20, max: 400, step: 1, value: 80, unit: ' Hz',
    onInput: (v) => { const t = armedTrack(); if (t) { (t.input ||= {}).hpz = v; Engine._updateMonitor(t); P.markDirty(); } } });
  input.append(gain, hpf);

  const openBtn = h('button', { class: 'btn btn-primary', onclick: toggleMic }, iconMic(), ' Открыть микрофон');
  const recBtn = h('button', { class: 'btn btn-danger', onclick: () => window.__qw.toggleRecord() }, '● Запись');
  input.append(h('div', { class: 'row', style: { marginTop: '4px' } }, openBtn, recBtn));
  grid.append(input);

  /* ------------------------------------------------ monitoring column */
  const mon = h('div', { class: 'col' });
  mon.append(h('div', { class: 'insp-title' }, 'Мониторинг — слышать себя'));
  armedLabel = h('div', { class: 'mono small' }, '—');
  mon.append(armedLabel);

  const monTgl = toggle({ label: 'Мониторинг входа (zero-latency)', value: false, onChange: (v) => {
    const t = armedTrack();
    if (!t) { toast('info', 'Сначала вооружите аудиодорожку'); monTgl.setValue(false); return; }
    window.__qw.toggleMonitor(t.id);
  } });
  mon.append(monTgl);

  const abRow = h('div', { class: 'row', style: { gap: '6px' } });
  const wetBtn = h('button', { class: 'btn btn-sm btn-primary' }, 'WET (с эффектами)');
  const dryBtn = h('button', { class: 'btn btn-sm' }, 'DRY (без эффектов)');
  const setAB = (wet) => {
    abState.wet = wet;
    wetBtn.classList.toggle('btn-primary', wet);
    dryBtn.classList.toggle('btn-primary', !wet);
    const t = armedTrack();
    if (!t) return;
    const g = Engine.graphs.get(t.id);
    if (g?.monitorChain) {
      // rebuild the monitored chain with or without the plugin list —
      // guarantees the A/B is exact and leaves no half-muted nodes behind
      Engine.rebuildMonitorFx({ ...t, fx: wet ? t.fx : [] });
      Engine._updateMonitor(t);
    }
    toast('info', wet ? 'Мониторинг: вы + эффекты' : 'Мониторинг: сухой сигнал');
  };
  wetBtn.onclick = () => setAB(true);
  dryBtn.onclick = () => setAB(false);
  abRow.append(wetBtn, dryBtn);
  mon.append(h('div', { class: 'ctrl-label' }, 'A/B прослушивание'), abRow);

  mon.append(h('div', { class: 'insp-title', style: { marginTop: '10px' } }, 'Быстрая обработка вокала'));
  const vocalPresets = Object.keys(FX_PRESETS).filter(k => k.toLowerCase().includes('vocal'));
  const pg = h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '5px' } });
  for (const name of vocalPresets) {
    const b = h('button', { class: 'btn btn-sm', title: FX_PRESETS[name].map(x => FX_DEFS[x.type]?.name || x.type).join(' → ') }, name.replace('Vocal → ', ''));
    b.onclick = () => {
      const t = armedTrack();
      if (!t) { toast('info', 'Вооружите аудиодорожку'); return; }
      applyPresetToTrack(t.id, name);
      toast('success', `Цепочка применена — звук слышен сразу в мониторинге`);
    };
    pg.append(b);
  }
  const editBtn = h('button', { class: 'btn btn-sm', onclick: () => {
    const t = armedTrack();
    if (!t) { toast('info', 'Вооружите аудиодорожку'); return; }
    openFxRack(t.id);
  } }, 'Редактировать цепочку…');
  mon.append(pg, editBtn);

  mon.append(h('div', { class: 'hint', style: { marginTop: '8px' } },
    'Мониторинг идёт отдельной цепочкой напрямую в мастер-шину — задержка равна аппаратной (обычно 5–20 мс). ',
    'Слышно ровно то, что пишется: те же плагины, тот же порядок. Кнопка DRY временно убирает эффекты, чтобы сравнить.'));
  grid.append(mon);

  /* ------------------------------------------------ takes column */
  const takes = h('div', { class: 'col' });
  takes.append(h('div', { class: 'insp-title' }, 'Тейки / записи'));
  takeList = h('div', { style: { maxHeight: '260px', overflowY: 'auto' } });
  takes.append(takeList);
  const pitchBtn = h('button', { class: 'btn btn-sm btn-primary', onclick: () => {
    const clip = Store.selectedClip;
    if (!clip || clip.type !== 'audio') { toast('info', 'Выберите аудио-клип на аранжировке'); return; }
    openAudioEditor(clip.id, true);
  } }, '✨ Питч-коррекция выбранного тейка');
  takes.append(pitchBtn);
  const extractBtn = h('button', { class: 'btn btn-sm', onclick: () => {
    const clip = Store.selectedClip;
    if (!clip || clip.type !== 'audio') { toast('info', 'Выберите аудио-клип'); return; }
    openAudioEditor(clip.id, true);
    toast('info', 'Во вкладке «Питч-коррекция» нажмите «→ MIDI-дорожка»');
  } }, '→ Мелодия в MIDI');
  takes.append(extractBtn);
  grid.append(takes);

  refresh();
}

function iconMic() { const s = document.createElement('span'); s.textContent = '🎙'; return s; }

function armedTrack() {
  return Store.tracks.find(t => t.armed) || (Store.selectedTrack?.type === 'audio' ? Store.selectedTrack : null);
}

async function loadDevices() {
  const devs = await Recorder.listDevices();
  clear(deviceSel);
  deviceSel.append(h('option', { value: '' }, 'По умолчанию'));
  for (const d of devs) deviceSel.append(h('option', { value: d.deviceId }, d.label || `Микрофон ${d.deviceId.slice(0, 6)}`));
  const t = armedTrack();
  if (t?.input?.deviceId) deviceSel.value = t.input.deviceId;
  if (!devs.length) statusEl.textContent = 'Устройства не найдены — проверьте разрешения браузера';
  else statusEl.textContent = `Найдено устройств: ${devs.length}`;
}

async function toggleMic() {
  const t = armedTrack();
  if (!t) { toast('info', 'Создайте аудиодорожку и нажмите ● (arm)'); return; }
  if (Recorder.monitorEnabled && Recorder.activeTrackId === t.id) {
    Recorder.closeMic();
    Store.tracks.forEach(x => x.armed = false);
    t.monitor = false;
    toast('info', 'Микрофон закрыт');
  } else {
    t.armed = true;
    try {
      await Recorder.openMic(t, t.input?.deviceId);
      t.monitor = true;
      Engine._updateMonitor(t);
      toast('success', `Микрофон открыт → мониторинг на "${t.name}"`);
    } catch (e) { toast('error', 'Не удалось открыть микрофон: ' + e.message); return; }
  }
  P.markDirty();
  refresh();
  Bus.emit(TOPICS.TRACKS, {});
}

function refresh() {
  if (!root) return;
  const t = armedTrack();
  if (armedLabel) {
    armedLabel.textContent = t
      ? `Дорожка: ${t.name} · FX: ${t.fx?.length || 0} · монитор: ${t.monitor ? 'ВКЛ' : 'выкл'} · вход: ${Recorder.monitorEnabled ? 'активен' : 'закрыт'}`
      : 'Дорожка не вооружена — нажмите ● на аудиодорожке';
  }
  if (deviceSel && !deviceSel.options.length) loadDevices();
  // takes list
  if (takeList) {
    clear(takeList);
    const recs = Library.samples.filter(s => s.pack === 'Recordings' || s.pack === 'Corrected' || s.pack === 'Processed');
    if (!recs.length) takeList.append(h('div', { class: 'hint' }, 'Записей пока нет.'));
    for (const s of recs.slice(-60).reverse()) {
      const row = h('div', { class: 'rack-slot', style: { cursor: 'pointer' } },
        h('span', { class: 'nm' }, s.name),
        h('span', { class: 'kind' }, `${s.duration?.toFixed(1)}s · ${s.pack}`));
      row.onclick = () => Transport.audition(s.id);
      row.oncontextmenu = (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Прослушать', fn: () => Transport.audition(s.id) },
          { label: 'Добавить на дорожку', fn: () => {
              const tr = Store.selectedTrack?.type === 'audio' ? Store.selectedTrack : Store.tracks.find(x => x.type === 'audio');
              if (!tr) { toast('info', 'Нет аудиодорожки'); return; }
              window.__qw.addSampleClip(tr, s);
            } },
          { label: 'Удалить из библиотеки', danger: true, fn: async () => { await Library.deleteSample(s.id); refresh(); } },
        ]);
      };
      takeList.append(row);
    }
  }
}

function loop() {
  raf = requestAnimationFrame(loop);
  if (!root.classList.contains('active')) return;
  // input meter
  if (meterCv) {
    const r = meterCv.getBoundingClientRect();
    if (r.width > 4) {
      const ctx = fitCanvas(meterCv, r.width, r.height);
      ctx.clearRect(0, 0, r.width, r.height);
      const lv = Recorder.inputLevel;
      drawMeter(ctx, 8, 4, 26, r.height - 8, lv.peak, lv.rms * 1.4, lv.clip);
      if (lv.clip) { lv.clip = false; }
      // numeric readout
      const db = lv.peak > 1e-5 ? 20 * Math.log10(lv.peak) : -60;
      ctx.fillStyle = db > -1 ? '#ff5d6c' : '#8fe3b8';
      ctx.font = '600 15px ui-monospace, monospace';
      ctx.fillText(db.toFixed(1) + ' dB', 46, r.height / 2 + 5);
      ctx.fillStyle = '#6b7c91'; ctx.font = '9px ui-monospace, monospace';
      ctx.fillText('PEAK IN', 46, r.height / 2 + 20);
      if (statusEl) statusEl.textContent = Recorder.monitorEnabled
        ? `Вход активен · ${Recorder.devices.length || 0} устр. · мониторинг ${armedTrack()?.monitor ? 'ВКЛ' : 'выкл'}`
        : 'Микрофон не открыт';
    }
  }
  if (specCv) {
    const r = specCv.getBoundingClientRect();
    if (r.width > 4) {
      const ctx = fitCanvas(specCv, r.width, r.height);
      ctx.clearRect(0, 0, r.width, r.height);
      ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, r.width, r.height);
      const data = Recorder.getSpectrum();
      if (data) {
        const n = data.length;
        const grad = ctx.createLinearGradient(0, r.height, 0, 0);
        grad.addColorStop(0, 'rgba(89,200,255,0.5)'); grad.addColorStop(1, 'rgba(255,107,157,0.95)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.moveTo(0, r.height);
        for (let px = 0; px < r.width; px++) {
          const idx = clamp(Math.floor(Math.pow(px / r.width, 1.8) * n), 0, n - 1);
          const v = data[idx] / 255;
          ctx.lineTo(px, r.height - Math.pow(v, 0.9) * (r.height - 4));
        }
        ctx.lineTo(r.width, r.height); ctx.closePath(); ctx.fill();
      } else {
        ctx.fillStyle = '#3a4553'; ctx.font = '10px system-ui';
        ctx.fillText('Спектр входа (откройте микрофон)', 10, r.height / 2);
      }
    }
  }
}

export default { mountRecordPanel, refresh, loadDevices };
