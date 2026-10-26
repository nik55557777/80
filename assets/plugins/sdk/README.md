# QwenWave Plugin SDK

Способы добавить свой эффект/инструмент в QwenWave. Всё устанавливается прямо в
браузере — перетащите файл в панель **Plugins** (или «Установить плагин»).

---

## Какие форматы реально работают в браузере

| Формат | Запускается в браузере | Как подключить |
|---|---|---|
| **JS-плагин QwenWave** (этот SDK) | ✅ да, нативно | перетащить `.js` |
| **AudioWorklet-плагин** (`processor.js` + `manifest.json`) | ✅ да | перетащить папку/`.zip` |
| **Web Audio Module (WAM 2.0)** | ✅ да | перетащить бандл `.zip`/`.js` |
| **WASM-сборка (CLAP/JUCE-WASM)** | ✅ через её WAM/AudioWorklet-обёртку | как WAM |
| **Нативный `.dll` / `.vst3` / `.component` / `.so`** | ❌ не исполняется в песочнице | через локальный **мост** (см. ниже) |

> Браузер не может вызвать `LoadLibrary()`/`dlopen()` и не исполняет нативный
> машинный код с диска — это ограничение платформы. QwenWave определяет формат
> нативного файла по заголовку, регистрирует его, применяет к дорожке встроенную
> эмуляцию (чтобы звук не пропадал) и предлагает поднять мост.

---

## 1. JS-плагин за 30 секунд

Минимальный контракт — два экспорта:

```js
export const meta = {
  name: 'My Gain',
  vendor: 'You',
  version: '1.0.0',
  category: 'Utility',
  params: {
    gain: { label: 'Gain', def: 0, min: -24, max: 24, step: 0.1, unit: ' dB' },
  },
};

export function create(ctx, params, host) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(output);
  const apply = (p) => output.gain.setTargetAtTime(Math.pow(10, p.gain / 20), ctx.currentTime, 0.02);
  apply(params);
  return { input, output, nodes: [input, output], update: apply, dispose() { input.disconnect(); output.disconnect(); } };
}
```

`create(ctx, params, host)` получает:
- `ctx` — общий `AudioContext`;
- `params` — стартовые значения ручек (из `meta.params`);
- `host` — `{ bpm(), beatsToSec(b), engine, store }`.

Вернуть нужно `{ input, output, nodes, update(params), dispose() }`.
`create` может быть **async** (например, если регистрируете свой AudioWorklet —
см. `example-plugin.js`).

### Типы параметров
```js
{ label, def, min, max, step, unit, type: 'range' }     // ручка (по умолчанию)
{ label, def, options: [...], type: 'select' }          // выпадающий список
{ label, def: false, type: 'bool' }                     // переключатель
```

---

## 2. Плагин со своим DSP (AudioWorklet)

См. **`example-plugin.js`** — полностью автономный «Auto-Wah»: он везёт исходник
своего `AudioWorkletProcessor` строкой, регистрирует его через
`ctx.audioWorklet.addModule(blobURL)` и отдаёт ноду. DSP крутится в аудиопотоке,
не нагружая главный поток.

Хелперы в `qwenwave-plugin-sdk.js`:
```js
import { registerWorklet, graph, makeProcessor, param } from './qwenwave-plugin-sdk.js';

const src = makeProcessor('my-proc',
  [{ name: 'amount', defaultValue: 0.5, minValue: 0, maxValue: 1 }],
  `out = x * params.amount[0]; outR = y * params.amount[0];`);

export async function create(ctx, params) {
  const node = await registerWorklet(ctx, 'my-proc', src, { amount: params.amount });
  return graph(node, params, null, (p) => ({ amount: p.amount }));
}
```

---

## 3. Web Audio Module (WAM 2.0)

Положите в `.zip`: `manifest.json` (`{ "name", "vendor", "uri", "entry": "index.js" }`)
и ES-модуль, экспортирующий класс `WebAudioModule` с `createAudioNode()`.
QwenWave импортирует модуль, создаёт инстанс и встраивает его в FX-цепочку.
Это стандарт [webaudiomodules.org](https://webaudiomodules.org) — многие вендоры
публикуют веб-порты своих VST именно так.

---

## 4. Нативный мост для настоящих VST3/DLL

`tools/plugin_bridge/bridge_server.py` — локальный хост-процесс: грузит реальный
плагин (через [`pedalboard`](https://github.com/spotify/pedalboard) или DAW-хост),
рендерит его аудио и стримит по WebSocket в AudioWorklet-ноду `qw-bridge`.

```bash
pip install pedalboard websockets soundfile numpy
python3 tools/plugin_bridge/bridge_server.py \
    --vst3 "/path/to/YourPlugin.vst3" --port 9123
```

Затем в QwenWave: **Plugins → «Как подключить VST/DLL»** — укажите
`ws://127.0.0.1:9123`. Плагин появится в FX-рейке как «… (bridge)» и будет
обрабатывать звук «по-настоящему». Требует запущенного локального процесса —
в чистом вебе нативный код недоступен физически.

---

## Советы по производительности
- Держите DSP в AudioWorklet, а не в `create()` на главном потоке.
- Меняйте параметры через `setTargetAtTime`/`linearRamp` — никаких щелчков.
- Не создавайте ноды в `process()`; аллокации только в конструкторе.
- Один плагин = одна нода; QwenWave сам освободит её при удалении дорожки.
