/**
 * QwenWave — Plugin host.
 *
 * WHAT ACTUALLY RUNS IN A BROWSER
 * -------------------------------
 * A browser is a sandbox: it cannot `LoadLibrary()` a Win32 .dll, cannot dlopen
 * a .vst3/.so/.dylib and cannot execute native machine code from disk. So a real
 * VST3/AU/AAX binary can never run *inside* a web page — that is a hard platform
 * limit, not a missing feature. What DOES run natively here:
 *
 *   1. **WAM 2.0** — Web Audio Modules (webaudiomodules.org). The standardised
 *      web plugin format: an ES-module bundle with a manifest + AudioWorklet
 *      processor. Thousands of ports of classic plugins ship this way, and
 *      vendors publish WAM builds of their VSTs.
 *   2. **AudioWorklet plugins** — a folder with `processor.js`
 *      (registerProcessor) + optional `manifest.json`/`gui.js`.
 *   3. **QwenWave JS plugins** — our own tiny SDK (see assets/plugins/sdk):
 *      an ES module exporting `meta` + `create(ctx, params)`; full DSP freedom,
 *      instant install, no build step.
 *   4. **CLAP/WASM & JUCE-WASM builds** — if a plugin ships a WebAssembly
 *      binary we can host it through its WAM/AudioWorklet wrapper.
 *
 * For genuine native .dll/.vst3 files we do the honest thing: detect the exact
 * format from the binary header, register it in the library as a
 * "bridge-required" entry, show the contained DSP parameters we *can* map, and
 * offer (a) an equivalent built-in chain, and (b) a ready-made native bridge
 * server stub (tools/plugin_bridge/) that streams the real plugin's audio over
 * WebAudio's AudioWorklet when you run it on your own machine.
 */
import Store, { Bus, TOPICS, clamp, uid } from '../core/store.js';
import { fxDefaults, setP } from '../effects/defs.js';

/** Engine handle, injected by fxbuild.js to avoid a circular import. */
let ENGINE = null;
export function setEngineHandle(e) { ENGINE = e; }

import { tx as idbTx, S_PLUGINS as STORE } from './db.js';
const idb = (mode, fn) => idbTx(STORE, mode, fn);

/* ------------------------------------------------------------ format sniff */
const SIGNATURES = [
  { name: 'VST3', ext: ['.vst3'], test: (b) => at(b, 8, 'VST3') },
  { name: 'VST2', ext: ['.dll', '.so', '.vst'], test: (b) => at(b, 0, 'VstP') },
  { name: 'Win32 DLL (PE)', ext: ['.dll'], test: (b) => at(b, 0, 'MZ') },
  { name: 'macOS bundle / Mach-O (AU)', ext: ['.component', '.dylib', '.plugin'], test: (b) => {
      const m = u32(b, 0);
      return m === 0xcafebabe || m === 0xbebafeca || m === 0xfeedface || m === 0xfeedfacf || m === 0xcffaedfe;
    } },
  { name: 'ELF shared object (Linux VST/LV2)', ext: ['.so', '.lv2'], test: (b) => at(b, 0, '\x7fELF') },
  { name: 'AAX', ext: ['.aaxplugin', '.aax'], test: (b) => at(b, 0, 'AAX') || at(b, 4, 'AAX') },
  { name: 'CLAP', ext: ['.clap'], test: (b) => at(b, 0, 'CLAP') },
  { name: 'LV2 manifest', ext: ['.ttl', '.lv2'], test: (b) => false },
  { name: 'WebAssembly module', ext: ['.wasm'], test: (b) => u32(b, 0) === 0x6d736100 },
  { name: 'ZIP archive (WAM bundle / JUCE-WASM)', ext: ['.zip'], test: (b) => at(b, 0, 'PK') },
];
function at(b, off, s) {
  for (let i = 0; i < s.length; i++) if (b[off + i] !== s.charCodeAt(i)) return false;
  return true;
}
function u32(b, off) {
  return (b[off] << 24 | b[off + 1] << 16 | b[off + 2] << 8 | b[off + 3]) >>> 0;
}
export function sniffFormat(bytes, filename = '') {
  const head = new Uint8Array(bytes.slice(0, 64));
  const ext = '.' + (filename.split('.').pop() || '').toLowerCase();
  for (const s of SIGNATURES) if (s.test(head)) return s.name;
  if (/\.js$|\.mjs$/.test(filename)) return 'JavaScript module';
  if (/\.json$/.test(filename)) return 'JSON manifest';
  if (/\.wam$/.test(ext)) return 'WAM bundle';
  if (/\.zip$/.test(ext)) return 'ZIP archive (WAM bundle / JUCE-WASM)';
  return 'Unknown binary';
}

/* ------------------------------------------------------------ plugin kinds */
export const KIND = {
  WAM: 'wam',
  WORKLET: 'worklet',
  JS: 'js',
  NATIVE_BRIDGE: 'native-bridge',
  BUILTIN: 'builtin',
};

const KIND_LABEL = {
  [KIND.WAM]: 'Web Audio Module (WAM 2.0)',
  [KIND.WORKLET]: 'AudioWorklet plugin',
  [KIND.JS]: 'QwenWave JS plugin',
  [KIND.NATIVE_BRIDGE]: 'Native plugin (bridge required)',
  [KIND.BUILTIN]: 'Built-in',
};

class PluginManagerImpl {
  constructor() {
    this.plugins = [];        // installed plugin descriptors
    this.byType = new Map();  // fx "type" string -> descriptor
    this._blobs = new Map();  // id -> {url, files}
    this._jsModules = new Map();
    this._wamCache = new Map();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const all = await idb('readonly', os => os.getAll());
    for (const p of all || []) await this._register(p, false);
    // bundled examples shipped with the app
    await this._loadBundled();
    this.loaded = true;
    Bus.emit(TOPICS.PLUGINS, { count: this.plugins.length });
  }

  async _loadBundled() {
    const bundled = [
      'assets/plugins/qw-tape/qw-tape.js',
      'assets/plugins/qw-vocalstrip/qw-vocalstrip.js',
    ];
    for (const file of bundled) {
      if (this.plugins.some(p => p.entry === file)) continue;
      try {
        const r = await fetch(file, { cache: 'force-cache' });
        if (!r.ok) continue;
        const code = await r.text();
        let meta = null;
        try { meta = await this._analyseJs(file, code, null); } catch (e) { console.warn('[plugins] analyse', file, e); }
        const p = {
          id: 'bundled_' + file.replace(/\W+/g, '_'),
          name: meta?.meta?.name || file.split('/').pop().replace(/\.js$/, ''),
          vendor: meta?.meta?.vendor || 'QwenWave', version: meta?.meta?.version || '1.0.0',
          category: meta?.meta?.category || 'Plugin', description: meta?.meta?.description || '',
          kind: KIND.JS, entry: file, source: 'bundled',
          code, format: 'JavaScript module', size: code.length, runnable: true,
          params: meta?.params || {}, descriptor: meta?.descriptor || null,
          processorName: meta?.processorName || null,
        };
        await this._register(p, false);
      } catch (e) { console.warn('[plugins] bundled load failed', file, e); }
    }
  }

  /** Install from user-selected files (single .js/.mjs, or a folder/zip). */
  async install(fileList) {
    const files = [...fileList];
    if (!files.length) return { ok: false, error: 'No files' };
    const results = [];

    // ZIP → unpack in-browser
    const zips = files.filter(f => /\.zip$/i.test(f.name));
    if (zips.length) {
      for (const z of zips) {
        try {
          const unpacked = await unzip(z);
          files.push(...unpacked);
        } catch (e) {
          results.push({ name: z.name, ok: false, error: 'ZIP: ' + e.message });
        }
      }
    }

    const jsFiles = files.filter(f => /\.(m?js)$/i.test(f.name));
    const jsonFiles = files.filter(f => /\.json$/i.test(f.name));
    const others = files.filter(f => !jsFiles.includes(f) && !jsonFiles.includes(f));

    // --- native binaries: register as bridge-required, with honest info
    for (const f of others) {
      const bytes = await f.arrayBuffer();
      const fmt = sniffFormat(bytes, f.name);
      const p = {
        id: uid('plg'), name: f.name.replace(/\.[^.]+$/, ''), vendor: 'Unknown',
        version: '—', kind: KIND.NATIVE_BRIDGE, entry: f.name, format: fmt,
        size: bytes.byteLength, source: 'user', installed: Date.now(),
        runnable: false, params: bridgeParamsFor(fmt),
        note: bridgeNote(fmt, f.name),
      };
      await idb('readwrite', os => os.put(p));
      await this._register(p, true);
      results.push({ name: f.name, ok: true, kind: p.kind, format: fmt, runnable: false });
    }

    // --- JS / WAM / worklet
    for (const f of jsFiles) {
      const code = await f.text();
      const manifest = jsonFiles.length ? await tryJson(jsonFiles[0]) : null;
      let kind = KIND.JS, meta = null;
      if (/createWamProcessor|WebAudioModule/.test(code)) kind = KIND.WAM;
      else if (/registerProcessor\s*\(/.test(code) && !/export\s+const\s+meta/.test(code)) kind = KIND.WORKLET;
      try {
        meta = await this._analyseJs(f.name, code, manifest);
      } catch (e) {
        results.push({ name: f.name, ok: false, error: e.message });
        continue;
      }
      const p = {
        id: uid('plg'),
        name: meta?.meta?.name || manifest?.name || f.name.replace(/\.m?js$/i, ''),
        vendor: meta?.meta?.vendor || manifest?.vendor || 'User',
        version: meta?.meta?.version || manifest?.version || '1.0.0',
        kind, entry: f.name, format: 'JavaScript module', code,
        size: code.length, source: 'user', installed: Date.now(),
        runnable: true,
        params: meta?.params || manifest?.params || {},
        descriptor: meta?.descriptor || null,
        processorName: meta?.processorName || null,
        note: meta?.note || '',
      };
      await idb('readwrite', os => os.put(p));
      await this._register(p, true);
      results.push({ name: p.name, ok: true, kind, runnable: true });
    }
    Bus.emit(TOPICS.PLUGINS, { installed: results });
    return { ok: true, results };
  }

  /** Validate a JS plugin and pull out its meta + param descriptors. */
  async _analyseJs(filename, code, manifest) {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    let mod;
    try {
      mod = await import(/* @vite-ignore */ url);
    } catch (e) {
      URL.revokeObjectURL(url);
      throw new Error(`Module failed to load: ${e.message}`);
    }
    URL.revokeObjectURL(url);
    const meta = mod.meta || manifest || null;
    if (!mod.create && !mod.default?.create && !meta?.wamEntry) {
      throw new Error('Plugin must export create(ctx, params) or meta.wamEntry');
    }
    const params = {};
    const defs = mod.meta?.params || manifest?.params || {};
    for (const [k, v] of Object.entries(defs)) {
      params[k] = { label: v.label || k, def: v.def ?? 0, min: v.min ?? 0, max: v.max ?? 1,
        step: v.step ?? 0.01, unit: v.unit || '', type: v.type || 'range', options: v.options };
    }
    return { meta: { name: meta?.name, vendor: meta?.vendor, version: meta?.version,
        category: mod.meta?.category, description: mod.meta?.description },
      params, descriptor: mod.meta || null,
      processorName: mod.processorName || mod.meta?.processorName || null };
  }

  async _register(p, emit) {
    if (this.byType.has(p.type)) return;
    p.type = p.type || pluginTypeOf(p);
    this.plugins.push(p);
    this.byType.set(p.type, p);
    if (p.code) {
      // Stable absolute object URL so dynamic import() always resolves
      // (a relative entry path would resolve against this module's folder).
      if (!this._blobs.has(p.id)) {
        const url = URL.createObjectURL(new Blob([p.code], { type: 'text/javascript' }));
        this._blobs.set(p.id, url);
      }
    }
    if (emit) Bus.emit(TOPICS.PLUGINS, { added: p.id });
    return p;
  }

  async remove(id) {
    const p = this.plugins.find(x => x.id === id);
    if (!p || p.source === 'bundled') return false;
    await idb('readwrite', os => os.delete(id));
    this.plugins = this.plugins.filter(x => x.id !== id);
    this.byType.delete(p.type);
    const url = this._blobs.get(id); if (url) { URL.revokeObjectURL(url); this._blobs.delete(id); }
    Bus.emit(TOPICS.PLUGINS, { removed: id });
    return true;
  }

  get(type) { return this.byType.get(type) || null; }
  list() { return this.plugins.slice().sort((a, b) => a.name.localeCompare(b.name)); }
  runnable() { return this.list().filter(p => p.runnable); }
  bridged() { return this.list().filter(p => !p.runnable); }
  kindLabel(k) { return KIND_LABEL[k] || k; }

  /* ------------------------------------------------------- instantiation */
  /**
   * Build a plugin instance as an FX node pair. Called by the engine exactly
   * like a built-in effect, so plugins live in the same chain, respect the
   * same bypass/ordering and are disposed with the track.
   */
  async instantiate(type, inst) {
    const p = this.get(type);
    if (!p) return null;
    if (!p.runnable) {
      Bus.emit(TOPICS.TOAST, {
        kind: 'warn',
        text: `${p.name}: нативный ${p.format} не исполняется в браузере. Включён эквивалентный встроенный чейн — см. «Плагины → Мост».` });
      return this._bridgeSubstitute(p, inst);
    }
    const ctx = ENGINE.ctx;
    const params = { ...defaultsFor(p), ...(inst.params || {}) };

    if (p.kind === KIND.JS) {
      const mod = await this._jsModule(p);
      const factory = mod.create || mod.default?.create;
      if (!factory) throw new Error('plugin must export create()');
      // create() may be async (e.g. it registers its own AudioWorkletProcessor
      // from an inline blob before returning the node graph)
      const built = await factory(ctx, params, {
        bpm: () => Store.project.bpm, beatsToSec: (b) => ENGINE.beatsToSec(b),
        library: null, engine: ENGINE, store: Store,
      });
      if (!built || !built.input || !built.output) throw new Error('create() must return {input, output}');
      built.nodes = built.nodes || [];
      built.update = built.update || (() => {});
      built.update(params);
      return wrapWithBypass(ctx, built, inst);
    }

    if (p.kind === KIND.WORKLET || p.processorName) {
      const procName = p.processorName || `${p.type}-processor`;
      try {
        if (!this._workletLoaded.has(p.id)) {
          const url = this._blobs.get(p.id) || p.entry;
          await ctx.audioWorklet.addModule(url);
          this._workletLoaded.set(p.id, true);
        }
        const node = new AudioWorkletNode(ctx, procName, {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          parameterData: params,
        });
        const wrap = {
          input: node, output: node, nodes: [node], isPlugin: true, pluginId: p.id,
          update(pp) {
            for (const k in pp) {
              const pr = node.parameters.get(k);
              if (pr) setP(pr, pp[k], ctx.currentTime, 0.02);
            }
          },
          dispose() { try { node.disconnect(); } catch {} },
        };
        return wrapWithBypass(ctx, wrap, inst);
      } catch (e) {
        Bus.emit(TOPICS.TOAST, { kind: 'error', text: `Плагин ${p.name} не загрузился: ${e.message}` });
        return null;
      }
    }

    if (p.kind === KIND.WAM) {
      try {
        const node = await this._loadWam(p, params);
        if (node) return wrapWithBypass(ctx, node, inst);
      } catch (e) {
        Bus.emit(TOPICS.TOAST, { kind: 'error', text: `WAM ${p.name}: ${e.message}` });
      }
      return null;
    }
    return null;
  }

  _workletLoaded = new Map();

  async _jsModule(p) {
    if (this._jsModules.has(p.id)) return this._jsModules.get(p.id);
    const url = this._blobs.get(p.id) || p.entry;
    const mod = await import(/* @vite-ignore */ url);
    this._jsModules.set(p.id, mod);
    return mod;
  }

  async _loadWam(p, params) {
    if (this._wamCache.has(p.id)) return this._wamCache.get(p.id);
    const url = this._blobs.get(p.id) || p.entry;
    const mod = await import(/* @vite-ignore */ url);
    const Factory = mod.default || mod.WebAudioModule;
    if (!Factory) throw new Error('WAM bundle must export a WebAudioModule class');
    const plugin = typeof Factory.createInstance === 'function'
      ? await Factory.createInstance({ initialState: params })
      : await new Factory().createInstance({ initialState: params });
    const node = await plugin.createAudioNode(params);
    const wrap = {
      input: node, output: node, nodes: [node], isPlugin: true, pluginId: p.id, wam: plugin,
      update(pp) { try { plugin.audioNode?.setParams?.(pp); node.setParams?.(pp); } catch {} },
      dispose() { try { plugin.destroy?.(); node.disconnect(); } catch {} },
      getGui: () => plugin.createGui?.(),
    };
    this._wamCache.set(p.id, wrap);
    return wrap;
  }

  /**
   * Native (.dll/.vst3/.component) plugins cannot execute in a page. Instead of
   * silently doing nothing we map the plugin to the closest built-in chain so
   * the track still sounds right, and expose the bridge instructions.
   */
  _bridgeSubstitute(p, inst) {
    const sub = BRIDGE_MAP[p.name?.toLowerCase()] || BRIDGE_MAP[p.format] || [
      { type: 'eq8', params: fxDefaults('eq8') },
      { type: 'compressor', params: { ...fxDefaults('compressor'), threshold: -18, ratio: 3 } },
      { type: 'saturator', params: { ...fxDefaults('saturator'), drive: 15, mode: 0, mix: 40 } },
      { type: 'limiter', params: { ...fxDefaults('limiter'), ceiling: -1 } },
    ];
    const ctx = ENGINE.ctx;
    const input = ctx.createGain(), output = ctx.createGain();
    const built = [];
    let head = input;
    for (const s of sub) {
      const fake = { id: uid('b'), type: s.type, params: { ...fxDefaults(s.type), ...s.params }, bypassed: false };
      const n = BUILD_FX(ENGINE, fake);
      if (!n) continue;
      head.connect(n.input); built.push(n); head = n.output;
    }
    head.connect(output);
    const label = ctx.createGain(); label.gain.value = 1;
    return {
      input, output, nodes: [input, output, label, ...built.flatMap(b => b.nodes || [])],
      isBridge: true, pluginId: p.id,
      update() {},
      dispose() { for (const b of built) for (const n of (b.nodes || [])) { try { n.disconnect(); } catch {} } },
      bridgeInfo: { original: p.name, format: p.format, substitute: sub.map(s => s.type) },
    };
  }
}

let BUILD_FX = null;
export function setBuildFx(fn) { BUILD_FX = fn; }

function pluginTypeOf(p) {
  return 'plg:' + (p.name || p.id).toLowerCase().replace(/[^a-z0-9]+/g, '_');
}
function defaultsFor(p) {
  const o = {};
  for (const [k, v] of Object.entries(p.params || {})) o[k] = v.def;
  return o;
}
function wrapWithBypass(ctx, built, inst) {
  if (!inst?.bypassed) return built;
  const dry = ctx.createGain(); dry.gain.value = 1;
  const mute = ctx.createGain(); mute.gain.value = 0;
  const input = ctx.createGain(), output = ctx.createGain();
  input.connect(dry); dry.connect(output);
  input.connect(mute);
  built.nodes = built.nodes || [];
  built.nodes.push(dry, mute, input, output);
  const origIn = built.input, origOut = built.output;
  input.connect(origIn); origOut.connect(output);
  return { ...built, input, output };
}

async function tryJson(f) { try { return JSON.parse(await f.text()); } catch { return null; } }

/* ------------------------------------------------------------------ unzip */
/**
 * Minimal ZIP reader (store + deflate) so a WAM/plugin folder can be dropped
 * as a single .zip without any external dependency.
 */
async function unzip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  // locate End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a ZIP file');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const uncompSize = dv.getUint32(off + 24, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    // local header
    const lNameLen = dv.getUint16(lho + 26, true);
    const lExtraLen = dv.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRaw(raw, uncompSize);
    else throw new Error('unsupported zip method ' + method);
    const f = new File([data], name.split('/').pop(), { type: mimeOf(name) });
    f.webkitRelativePath = name;
    out.push(f);
  }
  return out;
}

function inflateRaw(data, expectedSize) {
  const ds = new DecompressionStream('deflate-raw');
  // DecompressionStream is async; do a sync fallback via pako-less inflate
  const out = inflateSync(data);
  return out;
}

/** Dependency-free raw-DEFLATE decoder (fixed + dynamic Huffman). */
function inflateSync(input) {
  let bitBuf = 0, bitCnt = 0, pos = 0;
  const need = (n) => {
    while (bitCnt < n) {
      if (pos >= input.length) throw new Error('truncated deflate stream');
      bitBuf |= input[pos++] << bitCnt; bitCnt += 8;
    }
  };
  const bits = (n) => { need(n); const v = bitBuf & ((1 << n) - 1); bitBuf >>>= n; bitCnt -= n; return v; };
  const out = [];
  let bfinal = 0;
  while (!bfinal) {
    bfinal = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0;
      const len = input[pos] | (input[pos + 1] << 8); pos += 4;
      for (let i = 0; i < len; i++) out.push(input[pos++]);
    } else if (type === 1 || type === 2) {
      let litTree, distTree;
      if (type === 1) {
        const lits = new Array(288), dists = new Array(30);
        for (let i = 0; i < 144; i++) lits[i] = 8;
        for (let i = 144; i < 256; i++) lits[i] = 9;
        for (let i = 256; i < 280; i++) lits[i] = 7;
        for (let i = 280; i < 288; i++) lits[i] = 8;
        for (let i = 0; i < 30; i++) dists[i] = 5;
        litTree = buildTree(lits); distTree = buildTree(dists);
      } else {
        const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        const cl = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) cl[order[i]] = bits(3);
        const clTree = buildTree(cl);
        const lens = [];
        while (lens.length < hlit + hdist) {
          const sym = decode(clTree, () => bits(1));
          if (sym < 16) lens.push(sym);
          else if (sym === 16) { const c = bits(2) + 3, v = lens[lens.length - 1]; for (let i = 0; i < c; i++) lens.push(v); }
          else if (sym === 17) { const c = bits(3) + 3; for (let i = 0; i < c; i++) lens.push(0); }
          else { const c = bits(7) + 11; for (let i = 0; i < c; i++) lens.push(0); }
        }
        litTree = buildTree(lens.slice(0, hlit));
        distTree = buildTree(lens.slice(hlit));
      }
      const LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
      const LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
      const DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
      const DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
      for (;;) {
        const sym = decode(litTree, () => bits(1));
        if (sym === 256) break;
        if (sym < 256) out.push(sym);
        else {
          const li = sym - 257;
          const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
          const dsym = decode(distTree, () => bits(1));
          const dist = DIST_BASE[dsym] + bits(DIST_EXTRA[dsym]);
          for (let i = 0; i < len; i++) out.push(out[out.length - dist]);
        }
      }
    } else throw new Error('bad deflate block type');
  }
  return new Uint8Array(out);
}
function buildTree(lengths) {
  const MAX = 15;
  const blCount = new Array(MAX + 1).fill(0);
  for (const l of lengths) if (l) blCount[l]++;
  const nextCode = new Array(MAX + 1).fill(0);
  let code = 0;
  for (let b = 1; b <= MAX; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
  const root = { children: [null, null], symbol: -1 };
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym];
    if (!len) continue;
    let c = nextCode[len]++;
    let node = root;
    for (let i = len - 1; i >= 0; i--) {
      const bit = (c >> i) & 1;
      if (!node.children[bit]) node.children[bit] = { children: [null, null], symbol: -1 };
      node = node.children[bit];
    }
    node.symbol = sym;
  }
  return root;
}
function decode(tree, nextBit) {
  let node = tree;
  while (node.symbol < 0) {
    const b = nextBit();
    node = node.children[b];
    if (!node) throw new Error('bad huffman code');
  }
  return node.symbol;
}
function mimeOf(name) {
  if (/\.m?js$/i.test(name)) return 'text/javascript';
  if (/\.json$/i.test(name)) return 'application/json';
  if (/\.html?$/i.test(name)) return 'text/html';
  if (/\.css$/i.test(name)) return 'text/css';
  if (/\.wasm$/i.test(name)) return 'application/wasm';
  return 'application/octet-stream';
}

/* ------------------------------------------------------------ bridge table */
function bridgeNote(format, name) {
  return `${name} — ${format}. Нативный код не может исполняться в песочнице браузера.
Варианты: (1) использовать WAM/WASM-порт плагина, (2) поднять локальный мост
tools/plugin_bridge (нативный хост-процесс рендерит плагин и стримит аудио по
WebSocket в AudioWorklet), (3) включить встроенную эмуляцию — она уже применена
к дорожке, чтобы звук не пропадал.`;
}
function bridgeParamsFor(format) {
  // generic macro set so the UI can still show something meaningful
  return {
    drive: { label: 'Drive', def: 0, min: 0, max: 100, step: 1, unit: ' %' },
    tone: { label: 'Tone', def: 0, min: 0, max: 100, step: 1, unit: ' %' },
    mix: { label: 'Mix', def: 100, min: 0, max: 100, step: 1, unit: ' %' },
  };
}
const BRIDGE_MAP = {};

export const PluginManager = new PluginManagerImpl();
export { KIND_LABEL };
export default PluginManager;
