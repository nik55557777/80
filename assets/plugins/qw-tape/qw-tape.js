/**
 * QwenWave JS Plugin — "QW Tape Warmth"
 * -------------------------------------
 * Tape-machine emulation: saturation + level-dependent wow/flutter + hiss.
 * Backed by the bundled `qw-tape` AudioWorklet processor, so the DSP runs on
 * the audio thread (no main-thread cost, sample-accurate).
 *
 * Install: Browser → Plugins → «Установить плагин» → pick this file.
 */
export const meta = {
  name: 'QW Tape Warmth',
  vendor: 'QwenWave',
  version: '1.0.0',
  category: 'Colour',
  description: 'Tape saturation with wow/flutter and hiss. Great on vocals, drums and the master bus.',
  // Use a processor already registered by QwenWave's worklet bundle:
  processorName: 'qw-tape',
  params: {
    drive:    { label: 'Drive',     def: 25,  min: 0,   max: 100, step: 1,    unit: ' %' },
    mode:     { label: 'Tape type', def: 0,   type: 'select', options: ['Tape', 'Tape 456', 'Tube', 'Hard'] },
    wowDepth: { label: 'Wow/Flut',  def: 6,   min: 0,   max: 100, step: 1,    unit: ' %' },
    wowRate:  { label: 'Wow rate',  def: 0.45,min: 0.02,max: 4,   step: 0.01, unit: ' Hz' },
    hiss:     { label: 'Hiss',      def: -46, min: -90, max: -20, step: 0.5,  unit: ' dB' },
    lowCut:   { label: 'Low cut',   def: 40,  min: 20,  max: 400, step: 1,    unit: ' Hz' },
    mix:      { label: 'Mix',       def: 100, min: 0,   max: 100, step: 1,    unit: ' %' },
    post:     { label: 'Output',    def: -1,  min: -24, max: 12,  step: 0.5,  unit: ' dB' },
  },
};

const db = (v) => Math.pow(10, v / 20);

/** Map UI-facing params → worklet parameter values. */
export function mapParams(p) {
  return {
    drive: 0.6 + (p.drive / 100) * 4.4,
    mode: typeof p.mode === 'number' ? p.mode : ['Tape', 'Tape 456', 'Tube', 'Hard'].indexOf(p.mode),
    wowDepth: p.wowDepth,
    wowRate: p.wowRate,
    hiss: p.hiss,
    lowCut: p.lowCut,
    mix: p.mix / 100,
    post: db(p.post),
  };
}

export function create(ctx, params, host) {
  const mapped = mapParams(params);
  const node = new AudioWorkletNode(ctx, meta.processorName, {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    parameterData: mapped,
  });
  return {
    input: node,
    output: node,
    nodes: [node],
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
