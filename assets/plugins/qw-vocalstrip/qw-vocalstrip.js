/**
 * QwenWave JS Plugin — "QW Vocal Strip"
 * -------------------------------------
 * A complete broadcast vocal channel in ONE insert:
 *   high-pass → soft drive → compressor → presence → air → makeup.
 * Runs on the bundled `qw-vocalstrip` AudioWorklet processor (audio thread).
 *
 * Drop it on a vocal track and you get a finished, radio-ready voice; combine
 * with the built-in De-esser / Pitch / Reverb for a full chain.
 */
export const meta = {
  name: 'QW Vocal Strip',
  vendor: 'QwenWave',
  version: '1.0.0',
  category: 'Vocal',
  description: 'One-insert vocal channel: HPF, drive, compressor, presence, air, makeup.',
  processorName: 'qw-vocalstrip',
  params: {
    hpf:         { label: 'High-pass', def: 90,   min: 20,   max: 400,   step: 1,   unit: ' Hz' },
    drive:       { label: 'Drive',     def: 30,   min: 0,    max: 100,   step: 1,   unit: ' %' },
    threshold:   { label: 'Comp thr',  def: -22,  min: -60,  max: 0,     step: 0.5, unit: ' dB' },
    ratio:       { label: 'Ratio',     def: 3.5,  min: 1,    max: 20,    step: 0.1, unit: ':1' },
    attack:      { label: 'Attack',    def: 4,    min: 0.5,  max: 100,   step: 0.5, unit: ' ms' },
    release:     { label: 'Release',   def: 140,  min: 10,   max: 800,   step: 5,   unit: ' ms' },
    presence:    { label: 'Pres freq', def: 3000, min: 500,  max: 9000,  step: 10,  unit: ' Hz' },
    presenceAmt: { label: 'Presence',  def: 2.5,  min: -12,  max: 12,    step: 0.1, unit: ' dB' },
    air:         { label: 'Air freq',  def: 12000,min: 4000, max: 18000, step: 100, unit: ' Hz' },
    airAmt:      { label: 'Air',       def: 2,    min: -12,  max: 12,    step: 0.1, unit: ' dB' },
    makeup:      { label: 'Makeup',    def: 1,    min: -12,  max: 18,    step: 0.5, unit: ' dB' },
  },
};

const db = (v) => Math.pow(10, v / 20);

export function mapParams(p) {
  return {
    hpf: p.hpf,
    drive: 0.8 + (p.drive / 100) * 3.2,
    threshold: db(p.threshold),
    ratio: p.ratio,
    attack: p.attack / 1000,
    release: p.release / 1000,
    presence: p.presence,
    presenceAmt: p.presenceAmt,
    air: p.air,
    airAmt: p.airAmt,
    makeup: db(p.makeup),
  };
}

export function create(ctx, params, host) {
  const node = new AudioWorkletNode(ctx, meta.processorName, {
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
