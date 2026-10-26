/**
 * QwenWave Plugin SDK — helper utilities.
 *
 * Import nothing: this file is a plain reference you can copy from, OR import
 * it if you host your plugin alongside QwenWave. It removes the boilerplate of
 * registering an inline AudioWorklet processor and wiring parameter updates.
 *
 * A minimal plugin needs just:
 *
 *   export const meta = { name, vendor, version, params: { ... } };
 *   export async function create(ctx, params, host) {
 *     const node = await registerWorklet(ctx, 'my-proc', PROCESSOR_SRC, params);
 *     return graph(node, params, meta.params);
 *   }
 */

/** Register an AudioWorkletProcessor from source text (once per context). */
const _registered = new WeakSet();
export async function registerWorklet(ctx, name, processorSource, initialParams = {}) {
  // addModule is idempotent per URL but throws on duplicate processor names in
  // some browsers, so guard with a per-context registry.
  ctx.__qwWorklets = ctx.__qwWorklets || new Set();
  if (!ctx.__qwWorklets.has(name)) {
    const url = URL.createObjectURL(new Blob([processorSource], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    ctx.__qwWorklets.add(name);
  }
  return new AudioWorkletNode(ctx, name, {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    parameterData: initialParams,
  });
}

/**
 * Wrap a single AudioWorkletNode into a QwenWave FX node with automatic
 * parameter updates. `paramMap(uiParams)` converts UI values → worklet params.
 */
export function graph(node, params, paramDefs, paramMap) {
  const apply = (p) => {
    const mapped = paramMap ? paramMap(p) : p;
    for (const k in mapped) {
      const pr = node.parameters.get(k);
      if (pr) {
        try { pr.setTargetAtTime(mapped[k], node.context.currentTime, 0.02); }
        catch { try { pr.value = mapped[k]; } catch {} }
      }
    }
  };
  return {
    input: node, output: node, nodes: [node],
    update(p) { apply({ ...params, ...p }); },
    dispose() { try { node.disconnect(); } catch {} },
  };
}

/** Build a param descriptor quickly. */
export const param = (label, def, min, max, step = 0.01, unit = '') =>
  ({ label, def, min, max, step, unit, type: 'range' });
export const selectParam = (label, def, options) => ({ label, def, options, type: 'select' });
export const boolParam = (label, def = false) => ({ label, def, type: 'bool' });

/** dB → linear */
export const dbToLin = (db) => Math.pow(10, db / 20);
/** linear → dB */
export const linToDb = (g) => (g <= 1e-7 ? -144 : 20 * Math.log10(g));

/**
 * Helper to generate the AudioWorkletProcessor source for a simple per-sample
 * DSP callback. Keeps you from writing the full class boilerplate.
 *
 *   const src = makeProcessor('my-proc', [
 *     { name: 'amount', defaultValue: 0.5, minValue: 0, maxValue: 1 }
 *   ], `out = in * params.amount[0];`);
 *
 * The `body` receives: x (L in), y (R in), out (write L), outR (write R),
 * params (the Float32Array map), i (sample index), and persists state on `S`.
 */
export function makeProcessor(name, descriptors, body) {
  const pd = JSON.stringify(descriptors);
  return `
class P extends AudioWorkletProcessor {
  static get parameterDescriptors() { return ${pd}; }
  constructor(){ super(); this.S = {}; }
  process(inputs, outputs, params){
    const inp = inputs[0]; if(!inp || !inp[0]) return true;
    const iL = inp[0], iR = inp[1] || inp[0];
    const oL = outputs[0][0], oR = outputs[0][1];
    const S = this.S;
    for (let i = 0; i < iL.length; i++) {
      const x = iL[i], y = iR[i];
      let out = x, outR = y;
      ${body}
      oL[i] = out; if (oR) oR[i] = outR;
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(name)}, P);
`;
}
