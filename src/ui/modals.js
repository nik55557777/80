/**
 * QwenWave — dialogs: Export / Mastering analysis / Plugin bridge info / Help.
 */
import Store, { Bus, TOPICS, clamp, dbToGain } from '../core/store.js';
import Engine from '../engine/engine.js';
import Exporter, { encodeWav, measure, downloadBlob, safeName } from '../engine/exporter.js';
import { MASTERING_PRESETS } from '../engine/engine.js';
import PluginManager from '../engine/pluginhost.js';
import * as P from '../engine/persistence.js';
import { h, clear, modal, toast, toggle, select, slider, numInput, fitCanvas } from './dom.js';
import { setLastRenderStats } from './mixer.js';

/* =============================================================== EXPORT */
export function openExportDialog() {
  const opts = {
    mode: 'mix',            // mix | stems
    format: 'wav',
    bits: 24,
    sampleRate: Engine.sampleRate,
    normalize: true,
    normalizeTo: -0.3,
    dither: true,
    mastering: Store.project.master.mastering?.enabled ?? false,
    tail: 3,
  };
  const body = h('div', { class: 'col', style: { gap: '12px' } });
  const progWrap = h('div', { style: { display: 'none' } },
    h('div', { class: 'progress' }, h('i', { id: 'exp-bar' })),
    h('div', { class: 'small muted mono', id: 'exp-status', style: { marginTop: '4px' } }, 'Готово'));
  const resultBox = h('div', { style: { display: 'none' } });

  const rows = h('div', { class: 'grid-2' });
  const modeSel = select({ label: 'Что экспортируем', value: opts.mode, options: [
    { value: 'mix', label: 'Полный микс (master)' },
    { value: 'stems', label: 'Стемы (каждая дорожка отдельно)' },
  ], onChange: (v) => { opts.mode = v; } });
  const srSel = select({ label: 'Sample rate', value: opts.sampleRate, options: [
    { value: 44100, label: '44.1 kHz' }, { value: 48000, label: '48 kHz' }, { value: Engine.sampleRate, label: `${Engine.sampleRate / 1000} kHz (как в проекте)` },
  ], onChange: (v) => { opts.sampleRate = +v; } });
  const bitsSel = select({ label: 'Разрядность', value: opts.bits, options: [
    { value: 16, label: '16-bit' }, { value: 24, label: '24-bit' }, { value: 32, label: '32-bit float' },
  ], onChange: (v) => { opts.bits = +v; } });
  const normTgl = toggle({ label: 'Нормализовать пики', value: opts.normalize, onChange: (v) => opts.normalize = v });
  const normTo = numInput({ label: 'до', value: opts.normalizeTo, min: -20, max: -0.05, step: 0.05, unit: ' dBTP', onChange: (v) => opts.normalizeTo = v });
  const dithTgl = toggle({ label: 'TPDF dither (16-bit)', value: opts.dither, onChange: (v) => opts.dither = v });
  const tailIn = numInput({ label: 'Хвост (reverb/delay)', value: opts.tail, min: 0, max: 20, step: 0.5, unit: ' s', onChange: (v) => opts.tail = v });
  const mastTgl = toggle({ label: 'Включить мастеринг-цепь', value: opts.mastering, onChange: (v) => { opts.mastering = v; } });

  rows.append(modeSel, srSel, bitsSel, tailIn);
  body.append(
    h('div', { class: 'hint' }, `Проект: <b>${Store.project.name}</b> · ${Store.project.bpm} BPM · ${Store.tracks.length} дорожек · ${(Store.durationSec).toFixed(1)} с · офлайн-рендер (быстрее реального времени).`),
    rows,
    h('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap' } }, normTgl, normTo, dithTgl, mastTgl),
    progWrap, resultBox);

  const m = modal({
    title: 'Экспорт проекта',
    body, width: 620,
    actions: [
      { label: 'Отмена', onClick: (close) => close() },
      { label: 'Экспортировать', primary: true, onClick: async (close) => {
          try {
            progWrap.style.display = 'block';
            resultBox.style.display = 'none';
            const onProgress = (p) => {
              $('#exp-bar', progWrap).style.width = (p * 100).toFixed(0) + '%';
            };
            Store.project.master.mastering.enabled = opts.mastering;
            Engine.applyMasterSettings();

            if (opts.mode === 'mix') {
              const { buffer, stats } = await Exporter.render({
                sampleRate: opts.sampleRate, normalize: opts.normalize, normalizeTo: opts.normalizeTo,
                tailSec: opts.tail, onProgress,
              });
              setLastRenderStats(stats);
              const blob = encodeWav(buffer, { bits: opts.bits, dither: opts.dither && opts.bits === 16 });
              const name = `${safeName(Store.project.name)}_${Store.project.bpm}bpm.${opts.bits}bit.wav`;
              downloadBlob(blob, name);
              showResult(resultBox, [{ name, stats, size: blob.size }]);
            } else {
              const stems = await Exporter.renderStems({ sampleRate: opts.sampleRate, normalize: false, tailSec: opts.tail, onProgress });
              const out = [];
              for (const s of stems) {
                const nm = `${safeName(Store.project.name)}_STEM_${safeName(s.track.name)}.wav`;
                const blob = encodeWav(s.buffer, { bits: opts.bits, dither: opts.dither && opts.bits === 16 });
                downloadBlob(blob, nm);
                out.push({ name: nm, stats: s.stats, size: blob.size });
              }
              showResult(resultBox, out);
            }
            toast('success', 'Экспорт завершён');
          } catch (e) {
            console.error(e);
            toast('error', 'Ошибка экспорта: ' + e.message);
            $('#exp-status', progWrap).textContent = 'Ошибка: ' + e.message;
          }
        } },
    ],
  });
}

export function showResult(box, items) {
  box.style.display = 'block';
  clear(box);
  box.append(h('div', { class: 'insp-title', style: { marginTop: '10px' } }, 'Результат рендера'));
  const t = h('table', { style: { width: '100%', fontSize: '11.5px', borderCollapse: 'collapse', fontFamily: 'var(--mono)' } });
  t.append(h('thead', {}, h('tr', {},
    ...['Файл', 'Размер', 'LUFS', 'Peak', 'RMS', 'Длит.'].map(x => h('th', { style: { textAlign: 'left', color: 'var(--text-3)', fontWeight: '600', padding: '3px 6px', borderBottom: '1px solid var(--line)' } }, x)))));
  const tb = h('tbody');
  for (const it of items) {
    const st = it.stats || {};
    const warn = st.lufs > -6 || st.peakDb > -0.05;
    tb.append(h('tr', {},
      h('td', { style: { padding: '3px 6px' } }, it.name),
      h('td', { style: { padding: '3px 6px' } }, (it.size / 1e6).toFixed(1) + ' MB'),
      h('td', { style: { padding: '3px 6px', color: warn ? 'var(--warn)' : 'var(--ok)' } }, (st.lufs ?? 0).toFixed(2)),
      h('td', { style: { padding: '3px 6px', color: st.peakDb > -0.05 ? 'var(--err)' : '' } }, (st.peakDb ?? 0).toFixed(2) + ' dB'),
      h('td', { style: { padding: '3px 6px' } }, (st.rmsDb ?? 0).toFixed(2) + ' dB'),
      h('td', { style: { padding: '3px 6px' } }, (st.durationSec ?? 0).toFixed(1) + 's')));
  }
  t.append(tb);
  box.append(t);
  const first = items[0]?.stats;
  if (first) {
    let verdict = 'Хороший баланс громкости для стриминга.';
    if (first.lufs > -6) verdict = 'Очень громко — вероятны искажения/«плоский» звук. Снизьте mastering amount или ceiling.';
    else if (first.lufs < -20) verdict = 'Тихо для современных стандартов. Поднимите mastering amount/limit threshold.';
    if (first.peakDb > -0.05) verdict += ' Пик выше −0.05 dBTP — есть риск клиппинга на конвертации.';
    box.append(h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Анализ: ' + verdict + ' (интегральная громкость по ITU-R BS.1770, K-weighting, −0.691 offset).'));
  }
}

/* ======================================================= MASTERING LAB */
export function openMasteringDialog() {
  const m0 = Store.project.master;
  const body = h('div', { class: 'col', style: { gap: '12px' } });
  body.append(h('div', { class: 'hint' },
    'Мастеринг-цепь мастер-шины: <b>HP 20 Hz → ваши инсерты → мультибэнд-компрессор → стерео-имейджер → сатуратор → brickwall-лимитер</b>. ',
    'Всё считается в AudioWorklet, sample-accurate, без перегрузок между полосами.'));

  const on = toggle({ label: 'Мастеринг включён', value: !!m0.mastering.enabled, onChange: (v) => {
    Store.pushHistory('mastering');
    m0.mastering.enabled = v; Engine.applyMasterSettings(); Bus.emit(TOPICS.MASTER, {}); P.markDirty();
  } });
  const preset = select({ label: 'Пресет', value: m0.mastering.preset,
    options: Object.entries(MASTERING_PRESETS).map(([k, v]) => ({ value: k, label: v.name })),
    onChange: (v) => { m0.mastering.preset = v; Engine.applyMasterSettings(); Bus.emit(TOPICS.MASTER, {}); P.markDirty(); drawInfo(); } });
  const amount = slider({ label: 'Amount', min: 0, max: 1, step: 0.01, value: m0.mastering.amount,
    format: (v) => (v * 100).toFixed(0) + ' %',
    onInput: (v) => { m0.mastering.amount = v; Engine.applyMasterSettings(); Bus.emit(TOPICS.MASTER, {}); P.markDirty(); } });
  const ceil = slider({ label: 'Ceiling', min: -12, max: -0.1, step: 0.1, value: m0.limiterCeilDb, unit: ' dBTP',
    onInput: (v) => { m0.limiterCeilDb = v; Engine.applyMasterSettings(); Bus.emit(TOPICS.MASTER, {}); P.markDirty(); } });
  const vol = slider({ label: 'Master volume', min: -30, max: 12, step: 0.1, value: m0.volumeDb, unit: ' dB',
    onInput: (v) => { m0.volumeDb = v; Engine.applyMasterSettings(); P.markDirty(); } });
  body.append(on, h('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap' } }, preset, amount, ceil, vol));

  const info = h('div', { class: 'code' });
  function drawInfo() {
    const p = MASTERING_PRESETS[m0.mastering.preset] || MASTERING_PRESETS.balanced;
    const amt = m0.mastering.enabled ? m0.mastering.amount : 0;
    const mixv = (a, b) => (a + (b - a) * amt);
    info.textContent =
`ПРЕСЕТ: ${p.name}   (amount ${(amt * 100).toFixed(0)}%)
─────────────────────────────────────────────
Multiband   low ${mixv(0, p.mbLow).toFixed(1)} dB  mid ${mixv(0, p.mbMid).toFixed(1)} dB  high ${mixv(0, p.mbHigh).toFixed(1)} dB
            ratio ${mixv(1, p.mbRatio).toFixed(2)}:1   xover ${p.xover1}/${p.xover2} Hz
Imager      low ${mixv(1, p.widthLow).toFixed(2)}×  mid ${mixv(1, p.widthMid).toFixed(2)}×  high ${mixv(1, p.widthHigh).toFixed(2)}×
Saturation  drive ${mixv(1, p.drive).toFixed(2)}  mix ${(amt * p.satMix * 100).toFixed(0)}%
Limiter     thr ${mixv(-9, p.limThr).toFixed(1)} dB  ceiling ${m0.limiterCeilDb.toFixed(1)} dBTP  makeup ${mixv(0, p.makeup).toFixed(1)} dB  rel ${p.release * 1000 | 0} ms`;
  }
  drawInfo();
  body.append(info);

  const an = h('div', { class: 'row', style: { gap: '8px' } });
  const anBtn = h('button', { class: 'btn btn-primary btn-sm' }, '▶ Отрендерить и измерить');
  const anOut = h('div', { class: 'small muted mono' }, '—');
  const anResult = h('div', {});
  anBtn.onclick = async () => {
    anBtn.disabled = true; anOut.textContent = 'Рендер…';
    try {
      const { buffer, stats } = await Exporter.render({ normalize: false });
      setLastRenderStats(stats);
      anOut.textContent = `${stats.lufs.toFixed(2)} LUFS · peak ${stats.peakDb.toFixed(2)} dB · rms ${stats.rmsDb.toFixed(2)} dB · ${stats.durationSec.toFixed(1)}s`;
      showResult(anResult, [{ name: '(offline render)', stats, size: buffer.length * buffer.numberOfChannels * 4 }]);
    } catch (e) { anOut.textContent = 'Ошибка: ' + e.message; }
    anBtn.disabled = false;
  };
  an.append(anBtn, anOut);
  body.append(an, anResult);

  const targets = h('div', { class: 'hint' },
    'Ориентиры громкости: Spotify/Apple ≈ −14 LUFS · YouTube ≈ −14 · клубная EDM-мастеринг ≈ −8…−6 · вокальный поп ≈ −10…−8.');
  body.append(targets);

  modal({ title: 'Мастеринг проекта', body, width: 700, actions: [
    { label: 'Открыть FX мастер-шины', onClick: async (close) => { close(); const { openFxRack } = await import('./fxrack.js'); openFxRack('__master__'); } },
    { label: 'Готово', primary: true, onClick: (close) => close() },
  ] });
}

/* ==================================================== PLUGIN BRIDGE INFO */
export function openPluginBridgeInfo(plugin) {
  const body = h('div', { class: 'col', style: { gap: '12px' } });
  body.append(h('div', { class: 'section-title' }, 'Почему .dll / .vst3 не запускается прямо в браузере'));
  body.append(h('div', { class: 'hint' },
    'Браузер — песочница. Он не может вызвать ', h('code', {}, 'LoadLibrary()'), ' для Win32 DLL, не может ',
    h('code', {}, 'dlopen'), ' для .vst3/.so/.dylib и не исполняет нативный машинный код с диска. Это ограничение платформы, а не отсутствующая функция. ',
    'Поэтому QwenWave поддерживает три реально работающих способа подключения плагинов и четвёртый — мост.'));

  const items = [
    ['1. Web Audio Module (WAM 2.0)', 'Стандарт веб-плагинов (webaudiomodules.org): ES-модуль + AudioWorklet-процессор. Так публикуют веб-версии своих плагинов многие вендоры. Перетащите бандл (.zip или .js) в панель «Плагины» — он установится и появится в FX-рейке наравне со встроенными эффектами.'],
    ['2. AudioWorklet-плагин', 'Папка с processor.js (registerProcessor) + manifest.json. Самый простой способ добавить собственную DSP.'],
    ['3. QwenWave JS SDK', 'Наш мини-SDK: ES-модуль, экспортирующий meta + create(ctx, params). Полный доступ к Web Audio, установка в один клик, без сборки. Кнопка «Скачать SDK» в панели «Плагины» отдаёт шаблон и пример.'],
    ['4. Нативный мост (для настоящих .dll/.vst3)', 'Локальный хост-процесс (tools/plugin_bridge) грузит реальный VST3/AU/DLL через DAW-хост (например Carla/Element/Pedalboard), рендерит его аудио и стримит по WebSocket в AudioWorklet-ноду браузера. Плагин тогда работает «по-настоящему», но требует запущенного локального процесса — в чистом вебе это физически невозможно.'],
  ];
  for (const [t, d] of items) {
    body.append(h('div', { class: 'plugin-card ok' },
      h('div', { class: 'pc-name' }, t),
      h('div', { class: 'hint', style: { marginTop: '4px' } }, d)));
  }

  if (plugin) {
    body.append(h('div', { class: 'insp-title', style: { marginTop: '6px' } }, 'Обнаруженный файл'));
    body.append(h('div', { class: 'code' },
`${plugin.name}
формат:  ${plugin.format}
размер:  ${((plugin.size || 0) / 1024).toFixed(0)} KB
статус:  зарегистрирован как «native bridge»
поведение: дорожка обрабатывается встроенной эмуляцией
           (EQ → компрессор → сатуратор → лимитер),
           чтобы звук не пропадал, пока не поднят мост.`));
  }

  body.append(h('div', { class: 'insp-title' }, 'Мост: быстрый старт'));
  body.append(h('div', { class: 'code' },
`# 1) поднять локальный хост-мост (в комплекте проекта)
python3 tools/plugin_bridge/bridge_server.py --port 9123

# 2) в QwenWave: Плагины → «Мост» → указать ws://127.0.0.1:9123
# 3) плагин появляется в FX-рейке как «… (bridge)» и управляется
#    параметрами, проброшенными хостом`));

  modal({ title: 'Плагины: форматы и мост', body, width: 760, actions: [
    { label: 'Скачать SDK', onClick: async () => {
        try {
          const r = await fetch('assets/plugins/sdk/README.md');
          const txt = await r.text();
          downloadBlob(new Blob([txt], { type: 'text/markdown' }), 'qwenwave-plugin-sdk-README.md');
        } catch { toast('error', 'SDK недоступен'); }
      } },
    { label: 'Закрыть', primary: true, onClick: (c) => c() },
  ] });
}

/* ============================================================ HELP */
export function openHelp() {
  const body = h('div', { class: 'col', style: { gap: '10px' } });
  const keys = [
    ['Space', 'Play / Stop'], ['R', 'Запись (на вооружённую дорожку)'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / Redo'],
    ['Ctrl+S', 'Сохранить проект'], ['Ctrl+D', 'Дублировать клип/ноты'], ['S', 'Разделить клип по плейхеду'],
    ['Del', 'Удалить выбранное'], ['1…4', 'Инструменты аранжировки'], ['Q', 'Квантовать (в Piano Roll)'],
    ['Ctrl+колесо', 'Зум'], ['Shift+drag по линейке', 'Задать луп-регион'], ['M', 'Mute дорожки'], ['Shift+M', 'Solo'],
    ['F', 'Заморозить дорожку'], ['Ctrl+E', 'Экспорт'], ['?', 'Эта справка'],
  ];
  const dl = h('dl', { class: 'kb-help' });
  for (const [k, v] of keys) dl.append(h('dt', {}, h('span', { class: 'kbd' }, k)), h('dd', {}, v));
  body.append(h('div', { class: 'section-title' }, 'Горячие клавиши'), dl);

  body.append(h('div', { class: 'insp-title', style: { marginTop: '8px' } }, 'Типовой рабочий процесс'));
  body.append(h('div', { class: 'hint' }, h('ol', { style: { paddingLeft: '18px', lineHeight: '1.75' } },
    h('li', {}, 'Создайте дорожки: «+ Аудио» для вокала/сэмплов, «+ MIDI» для инструментов.'),
    h('li', {}, 'Перетащите лупы и one-shot’ы из браузера «Сэмплы» на дорожки — лупы с меткой BPM автоматически warp-ятся под темп проекта.'),
    h('li', {}, 'Для мелодий: двойной клик по MIDI-клипу → Piano Roll (рисование нот, квантование, привязка к гамме).'),
    h('li', {}, 'Для вокала: ● (arm) на аудиодорожке → «Мониторинг» → пресет «Vocal → Radio Lead» → запись (R). Слышно себя сразу с эффектами, кнопка DRY сравнивает.'),
    h('li', {}, 'Обработка: вкладка «Эффекты» → добавьте EQ/компрессор/реверб, или перетащите готовый пресет цепочки.'),
    h('li', {}, 'Питч-коррекция: двойной клик по тейку → «Питч-коррекция вокала» → Анализ → Применить тюнинг (недеструктивно, оригинал сохраняется).'),
    h('li', {}, 'Мастеринг: мастер-секция микшера → пресет и amount, либо «Мастеринг проекта» для анализа LUFS.'),
    h('li', {}, 'Экспорт: Ctrl+E → микс или стемы, 16/24/32-bit, с нормализацией и замером LUFS.'),
  )));

  body.append(h('div', { class: 'insp-title', style: { marginTop: '8px' } }, 'Производительность'));
  const info = Engine.ctx ? {
    sr: Engine.sampleRate, lat: (Engine.ctx.baseLatency * 1000).toFixed(1),
    voices: Engine.voices.size, cache: Library_cache(),
  } : null;
  body.append(h('div', { class: 'code' },
`Аудиоконтекст   ${info ? info.sr / 1000 + ' kHz, base latency ' + info.lat + ' ms' : 'не инициализирован (кликните Play)'}
Worklet DSP     ${Engine.workletReady ? 'активен (лимитер/мультибэнд/имейджер/сатуратор/гейт/де-эссер/хорус/верб/питч)' : 'недоступен — нужны HTTPS или localhost'}
Кэш сэмплов     ${info ? info.cache : '—'}
Планировщик     look-ahead 180 мс, тик 22 мс, чанки клипов по 16 тактов
Полифония       лимит на дорожку + voice stealing с release-фейдом
Метры           один rAF-цикл на весь микшер (worklet-тэпы вместо AnalyserNode на канал)`));

  modal({ title: 'QwenWave — справка', body, width: 720, actions: [{ label: 'Закрыть', primary: true, onClick: (c) => c() }] });
}
function Library_cache() {
  try {
    const c = (window.__qw?.Library || {}).cacheInfo;
    return c ? `${c.decoded} декодировано, ${c.mb} MB из ${c.maxMb} MB лимита, всего ${c.totalSamples} сэмплов` : '—';
  } catch { return '—'; }
}

/* ======================================================= NEW PROJECT */
export function openNewProjectDialog() {
  let bpm = 120, ts = 4, name = 'Untitled Project';
  const body = h('div', { class: 'col', style: { gap: '10px' } });
  body.append(
    numInput({ label: 'Название', value: name, min: 0, max: 0, step: 1, width: 260, onChange: (v) => name = v }),
  );
  const nameInp = $('input', body.lastChild);
  if (nameInp) { nameInp.type = 'text'; nameInp.value = name; nameInp.onchange = () => name = nameInp.value; }
  body.append(numInput({ label: 'BPM', value: bpm, min: 20, max: 400, step: 1, onChange: (v) => bpm = v }));
  body.append(select({ label: 'Размер', value: ts, options: [{ value: 4, label: '4/4' }, { value: 3, label: '3/4' }, { value: 6, label: '6/8' }, { value: 2, label: '2/4' }], onChange: (v) => ts = +v }));
  body.append(h('div', { class: 'hint' }, 'Текущий проект можно сначала сохранить — см. вкладку «Проекты» в браузере.'));
  modal({ title: 'Новый проект', body, width: 460, actions: [
    { label: 'Отмена', onClick: (c) => c() },
    { label: 'Создать', primary: true, onClick: async (c) => {
        if (Store.tracks.length && !confirm('Создать новый проект? Несохранённые изменения текущего будут потеряны.')) return;
        await P.saveToSession(Store.project.id || 'current');
        P.newProject(name || 'Untitled Project', { bpm, ts: [ts, 4] });
        c();
        toast('success', 'Создан новый проект');
      } },
  ] });
}

export default { openExportDialog, openMasteringDialog, openPluginBridgeInfo, openHelp, openNewProjectDialog };
