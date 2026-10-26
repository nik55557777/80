/**
 * QwenWave Plugin SDK — EXAMPLE: "Auto-Wah" (envelope filter)
 * ============================================================
 * A fully SELF-CONTAINED plugin: it ships its own AudioWorkletProcessor as a
 * source string, registers it on first use, and exposes a normal param UI.
 * This is exactly how a third-party developer ships a plugin — no dependency
 * on QwenWave's bundled processors.
 *
 * Install: Browser → Plugins → «Установить плагин» → pick this file
 * (or drag it onto the Plugins panel). Then add it from the FX rack.
 *
 * Contract QwenWave expects from a JS plugin:
 *   export const meta = { name, vendor, version, category, description, params }
 *   export function create(ctx, params, host) -> { input, output, nodes, update, dispose }
 *   `create` MAY be async (this example awaits worklet registration).
 */

export const meta = {
  name: 'Auto-Wah',
  vendor: 'QwenWave SDK',
  version: '1.0.0',
  category: 'Modulation',
  description: 'Envelope-following resonant filter (classic funk/auto-wah). Self-contained DSP example.',
  params: {
    sens:     { label: 'Sensitivity', def: 55,  min: 0,    max: 100,  step: 1,    unit: ' %' },
    baseFreq: { label: 'Base freq',   def: 300, min: 80,   max: 2000, step: 5,    unit: ' Hz' },
    range:    { label: 'Sweep range', def: 3000,min: 200,  max: 8000, step: 20,   unit: ' Hz' },
    res:      { label: 'Resonance',   def: 6,   min: 0.5,  max: 20,   step: 0.1,  unit: ' Q' },
    attack:   { label: 'Attack',      def: 8,   min: 0.5,  max: 100,  step: 0.5,  unit: ' ms' },
    release:  { label: 'Release',     def: 220, min: 20,   max: 1200, step: 10,   unit: ' ms' },
    mix:      { label: 'Mix',         def: 100, min: 0,    max: 100,  step: 1,    unit: ' %' },
  },
};

/* ---- the DSP, shipped as source and registered on the audio thread ---- */
const PROCESSOR_NAME = 'qw-example-autowah';
const PROCESSOR_SRC = `
class QWAutoWah extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'sens', defaultValue: 0.55, minValue: 0, maxValue: 1 },
      { name: 'baseFreq', defaultValue: 300, minValue: 40, maxValue: 4000 },
      { name: 'range', defaultValue: 3000, minValue: 0, maxValue: 16000 },
      { name: 'res', defaultValue: 6, minValue: 0.1, maxValue: 24 },
      { name: 'attack', defaultValue: 0.008, minValue: 0.0005, maxValue: 0.2 },
      { name: 'release', defaultValue: 0.22, minValue: 0.01, maxValue: 2 },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1 },
    ];
  }
  constructor() {
    super();
    this.lpL = 0; this.lpR = 0; this.bpL = 0; this.bpR = 0;
    this.env = 0;
  }
  process(inputs, outputs, params) {
    const iL = inputs[0][0]; if (!iL) return true;
    const iR = inputs[0][1] || iL;
    const oL = outputs[0][0], oR = outputs[0][1];
    const p = k => params[k][0];
    const sens = p('sens'), base = p('baseFreq'), range = p('range'), res = p('res');
    const mix = p('mix');
    const att = Math.exp(-1 / (Math.max(p('attack'), 1e-4) * sampleRate));
    const rel = Math.exp(-1 / (Math.max(p('release'), 1e-3) * sampleRate));
    for (let i = 0; i < iL.length; i++) {
      const x = iL[i], y = iR[i];
      const pk = Math.max(Math.abs(x), Math.abs(y));
      this.env = pk > this.env ? pk + (this.env - pk) * att : pk + (this.env - pk) * rel;
      const cut = base + range * Math.pow(this.env * sens * 2.2, 1.4);
      const f = 2 * Math.sin(Math.PI * Math.min(cut, sampleRate * 0.45) / sampleRate);
      const q = Math.max(0.05, 1 / res);
      // state-variable filter (LP + BP), per channel
      const doCh = (inp, lpKey, bpKey) => {
        let lp = this[lpKey], bp = this[bpKey];
        const hp = inp - lp - q * bp;
        bp = f * hp + bp;
        lp = f * bp + lp;
        this[lpKey] = lp; this[bpKey] = bp;
        return bp; // band-pass gives the "wah"
      };
      const wL = doCh(x, 'lpL', 'bpL');
      const wR = doCh(y, 'lpR', 'bpR');
      oL[i] = x * (1 - mix) + wL * mix;
      if (oR) oR[i] = y * (1 - mix) + wR * mix;
    }
    return true;
  }
}
registerProcessor('${PROCESSOR_NAME}', QWAutoWah);
`;

function mapParams(p) {
  return {
    sens: p.sens / 100,
    baseFreq: p.baseFreq,
    range: p.range,
    res: p.res,
    attack: p.attack / 1000,
    release: p.release / 1000,
    mix: p.mix / 100,
  };
}

export async function create(ctx, params, host) {
  // register the processor once per AudioContext
  ctx.__qwWorklets = ctx.__qwWorklets || new Set();
  if (!ctx.__qwWorklets.has(PROCESSOR_NAME)) {
    const url = URL.createObjectURL(new Blob([PROCESSOR_SRC], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    ctx.__qwWorklets.add(PROCESSOR_NAME);
  }
  const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    parameterData: mapParams(params),
  });
  return {
    input: node, output: node, nodes: [node],
    update(p) {
      const m = mapParams({ ...params, ...p });
      for (const k in m) {
        const pr = node.parameters.get(k);
        if (pr) pr.setTargetAtTime(m[k], ctx.currentTime, 0.02);
      }
    },
    dispose() { try { node.disconnect(); } catch {} },
  };
}
