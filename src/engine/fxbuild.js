/**
 * QwenWave — FX node factory.
 * Builds either a built-in effect (from effects/defs.js) or a user plugin
 * (via PluginManager). Returns {input, output, nodes, update, dispose}.
 * Kept in its own module to avoid a circular import between engine ↔ plugins.
 */
import Store, { Bus, clamp, dbToGain } from '../core/store.js';
import { FX_DEFS, fxDefaults, setP } from '../effects/defs.js';
import PluginManager, { setEngineHandle, setBuildFx } from './pluginhost.js';

/* --------------------------------------------------------- generic builder */
export function buildFx(engine, inst) {
  wireFx(engine);
  if (String(inst.type).startsWith('plg:')) {
    // plugins are built asynchronously; return a live placeholder that is
    // swapped in as soon as the module resolves (graph stays connected)
    return buildPluginPlaceholder(engine, inst);
  }
  const def = FX_DEFS[inst.type];
  if (!def) return null;
  const ctx = engine.ctx;
  const params = { ...fxDefaults(inst.type), ...(inst.params || {}) };
  const api = {
    beatsToSec: (b) => engine.beatsToSec(b),
    get bpm() { return Store.project.bpm; },
    getSharedConvolver: (n) => engine.getSharedConvolver(n),
    ensureConvolver: (conv, n) => engine.ensureConvolver(conv, n),
  };

  if (def.worklet && engine.workletReady) {
    const mapped = def.map ? def.map(params) : params;
    const node = engine._worklet(def.worklet, mapped);
    if (node) {
      const bypass = ctx.createGain();
      const wrap = {
        input: node, output: node, nodes: [node], isWorklet: true,
        update(p) {
          const m = def.map ? def.map(p) : p;
          for (const k in m) {
            const pr = node.parameters.get(k);
            if (pr) setP(pr, m[k], ctx.currentTime, 0.02);
          }
        },
        dispose() { try { node.disconnect(); } catch {} },
      };
      if (inst.bypassed) node.gain = 0;
      return wrap;
    }
  }

  if (def.build) {
    const built = def.build(ctx, params, api);
    built.update = built.update || (() => {});
    const origUpdate = built.update;
    // bypass support: keep a parallel dry path
    if (inst.bypassed) {
      const dry = ctx.createGain(); dry.gain.value = 1;
      const wetMute = ctx.createGain(); wetMute.gain.value = 0;
      try { built.input.disconnect(); } catch {}
      built.input.connect(dry); dry.connect(built.output);
      built.nodes.push(dry, wetMute);
      built.update = (p) => { origUpdate(p); };
    }
    return built;
  }
  // absolute fallback: pass-through gain
  const g = ctx.createGain();
  return { input: g, output: g, nodes: [g], update() {}, dispose() {} };
}


/* ------------------------------------------------------------------ wiring
   Give the plugin host a handle to the engine + this factory. Done lazily on
   first use so module evaluation order can never create a circular hazard. */
let _wired = false;
export function wireFx(engine) {
  if (_wired) return;
  _wired = true;
  setEngineHandle(engine);
  setBuildFx(buildFx);
}

/**
 * Plugin nodes load asynchronously (dynamic import / worklet registration).
 * To keep the FX chain synchronously connectable we insert a 2-gain
 * placeholder and splice the real plugin in when it resolves.
 */
function buildPluginPlaceholder(engine, inst) {
  const ctx = engine.ctx;
  const input = ctx.createGain();
  const output = ctx.createGain();
  const bridgeIn = ctx.createGain();
  const bridgeOut = ctx.createGain();
  input.connect(bridgeIn); bridgeIn.connect(output);
  const holder = {
    input, output, nodes: [input, output, bridgeIn, bridgeOut],
    isPlugin: true, pluginId: inst.type, loading: true, real: null,
    update(p) { if (holder.real) holder.real.update?.(p); else holder.pending = p; },
    dispose() {
      holder.real?.dispose?.();
      for (const n of holder.nodes) { try { n.disconnect(); } catch {} }
    },
  };
  Promise.resolve(PluginManager.instantiate(inst.type, inst)).then((real) => {
    if (!real) { holder.loading = false; return; }
    holder.loading = false; holder.real = real;
    try { bridgeIn.disconnect(); } catch {}
    bridgeIn.connect(real.input); real.output.connect(output);
    holder.nodes.push(real.input, real.output, ...(real.nodes || []));
    if (holder.pending) real.update?.(holder.pending);
    Bus_emit_plugins(inst.type);
  }).catch(e => {
    holder.loading = false;
    console.warn('[plugin] instantiate failed', e);
  });
  return holder;
}
function Bus_emit_plugins(t) {
  try { Bus.emit('plugins', { instantiated: t }); } catch {}
}
