/**
 * QwenWave — Effect registry & graph factory.
 * Every built-in processor declares its parameters (auto-generates UI) and a
 * builder that returns {input, output, nodes, update(params), dispose()}.
 *
 * Native Web Audio nodes are used where they're cheaper than a worklet;
 * AudioWorklet processors are used where sample-accurate DSP is required.
 */
import { clamp, dbToGain } from '../core/store.js';

export const P = (label, def = 0, min = 0, max = 1, step = 0.01, unit = '', type = 'range') =>
  ({ label, def, min, max, step, unit, type });

export const FX_DEFS = {
  /* ------------------------------------------------------------ dynamics */
  compressor: {
    name: 'Compressor', cat: 'Dynamics', worklet: false,
    params: {
      threshold: P('Threshold', -18, -60, 0, 0.5, ' dB'),
      knee: P('Knee', 12, 0, 40, 0.5, ' dB'),
      ratio: P('Ratio', 3, 1, 20, 0.1, ':1'),
      attack: P('Attack', 0.006, 0.0005, 0.4, 0.0005, ' s'),
      release: P('Release', 0.16, 0.01, 1.5, 0.005, ' s'),
      makeup: P('Makeup', 0, -12, 24, 0.5, ' dB'),
      mix: P('Mix', 100, 0, 100, 1, ' %'),
    },
    build(ctx, p) {
      const input = ctx.createGain(), output = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      const dry = ctx.createGain(), wet = ctx.createGain(), pre = ctx.createGain();
      input.connect(pre); pre.connect(dry); dry.connect(output);
      pre.connect(comp); comp.connect(wet); wet.connect(output);
      return {
        input, output, nodes: [input, pre, comp, dry, wet, output],
        update(p) {
          const t = now(ctx);
          setP(comp.threshold, p.threshold, t); setP(comp.knee, p.knee, t);
          setP(comp.ratio, p.ratio, t); setP(comp.attack, p.attack, t); setP(comp.release, p.release, t);
          const m = p.mix / 100;
          setP(dry.gain, 1 - m, t); setP(wet.gain, m, t); setP(output.gain, dbToGain(p.makeup), t);
        },
        readout: () => null,
      };
    },
  },

  gate: {
    name: 'Noise Gate', cat: 'Dynamics', worklet: 'qw-gate',
    params: {
      threshold: P('Threshold', -48, -90, 0, 0.5, ' dB'),
      attack: P('Attack', 0.002, 0.0002, 0.1, 0.0005, ' s'),
      hold: P('Hold', 0.06, 0, 1, 0.01, ' s'),
      release: P('Release', 0.15, 0.005, 2, 0.005, ' s'),
      range: P('Range', -60, -96, 0, 1, ' dB'),
    },
    map(p) {
      return { threshold: dbToGain(p.threshold), attack: p.attack, hold: p.hold,
        release: p.release, range: dbToGain(p.range) };
    },
  },

  multiband: {
    name: 'Multiband Compressor', cat: 'Dynamics', worklet: 'qw-multiband',
    params: {
      lowThr: P('Low Thr', -22, -60, 0, 0.5, ' dB'),
      midThr: P('Mid Thr', -24, -60, 0, 0.5, ' dB'),
      highThr: P('High Thr', -26, -60, 0, 0.5, ' dB'),
      ratio: P('Ratio', 3, 1, 20, 0.1, ':1'),
      lowGain: P('Low Gain', 0, -12, 12, 0.1, ' dB'),
      midGain: P('Mid Gain', 0, -12, 12, 0.1, ' dB'),
      highGain: P('High Gain', 0, -12, 12, 0.1, ' dB'),
      xover1: P('Low Xover', 180, 40, 800, 1, ' Hz'),
      xover2: P('High Xover', 2500, 500, 12000, 10, ' Hz'),
    },
    map(p) {
      return { lowThr: dbToGain(p.lowThr), midThr: dbToGain(p.midThr), highThr: dbToGain(p.highThr),
        ratio: p.ratio, lowGain: dbToGain(p.lowGain), midGain: dbToGain(p.midGain),
        highGain: dbToGain(p.highGain), xover1: p.xover1, xover2: p.xover2 };
    },
  },

  /* ------------------------------------------------------------ EQ / filter */
  eq3: {
    name: 'EQ (3-band)', cat: 'EQ', worklet: false,
    params: {
      lowF: P('Low Freq', 120, 40, 400, 1, ' Hz'), lowG: P('Low Gain', 0, -18, 18, 0.1, ' dB'),
      midF: P('Mid Freq', 1000, 200, 5000, 1, ' Hz'), midG: P('Mid Gain', 0, -18, 18, 0.1, ' dB'), midQ: P('Mid Q', 1, 0.2, 12, 0.05),
      highF: P('High Freq', 8000, 3000, 18000, 10, ' Hz'), highG: P('High Gain', 0, -18, 18, 0.1, ' dB'),
    },
    build(ctx, p) {
      const input = ctx.createGain(), output = ctx.createGain();
      const lo = ctx.createBiquadFilter(), mi = ctx.createBiquadFilter(), hi = ctx.createBiquadFilter();
      lo.type = 'lowshelf'; mi.type = 'peaking'; hi.type = 'highshelf';
      input.connect(lo); lo.connect(mi); mi.connect(hi); hi.connect(output);
      return {
        input, output, nodes: [input, lo, mi, hi, output],
        update(p) {
          const t = now(ctx);
          setP(lo.frequency, p.lowF, t); setP(lo.gain, p.lowG, t);
          setP(mi.frequency, p.midF, t); setP(mi.gain, p.midG, t); setP(mi.Q, p.midQ, t);
          setP(hi.frequency, p.highF, t); setP(hi.gain, p.highG, t);
        },
      };
    },
  },

  eq8: {
    name: 'EQ (8-band Pro)', cat: 'EQ', worklet: false,
    params: (() => {
      const o = {};
      const bands = [[32, 'lowshelf'], [100, 'peaking'], [250, 'peaking'], [630, 'peaking'],
        [1600, 'peaking'], [4000, 'peaking'], [8000, 'peaking'], [14000, 'highshelf']];
      bands.forEach(([f, ty], i) => {
        o[`f${i}`] = P(`Band ${i + 1} Hz`, f, 20, 20000, 1, ' Hz');
        o[`g${i}`] = P(`Band ${i + 1} dB`, 0, -24, 24, 0.1, ' dB');
        o[`q${i}`] = P(`Band ${i + 1} Q`, ty === 'peaking' ? 1.2 : 0.7, 0.1, 18, 0.05);
      });
      return o;
    })(),
    build(ctx, p) {
      const input = ctx.createGain(), output = ctx.createGain();
      const tys = ['lowshelf', 'peaking', 'peaking', 'peaking', 'peaking', 'peaking', 'peaking', 'highshelf'];
      const filters = tys.map(t => { const f = ctx.createBiquadFilter(); f.type = t; return f; });
      let prev = input;
      for (const f of filters) { prev.connect(f); prev = f; }
      prev.connect(output);
      return {
        input, output, nodes: [input, ...filters, output],
        update(p) {
          const t = now(ctx);
          filters.forEach((f, i) => {
            setP(f.frequency, p[`f${i}`], t); setP(f.gain, p[`g${i}`], t); setP(f.Q, p[`q${i}`], t);
          });
        },
      };
    },
  },

  filter: {
    name: 'Filter', cat: 'EQ', worklet: false,
    params: {
      type: { label: 'Type', def: 'lowpass', type: 'select',
        options: ['lowpass', 'highpass', 'bandpass', 'notch', 'lowshelf', 'highshelf', 'peaking', 'allpass'] },
      freq: P('Cutoff', 1200, 20, 20000, 1, ' Hz'),
      q: P('Resonance', 1, 0.1, 24, 0.05),
      gain: P('Gain', 0, -24, 24, 0.1, ' dB'),
      lfoRate: P('LFO Rate', 0, 0, 20, 0.01, ' Hz'),
      lfoDepth: P('LFO Depth', 0, 0, 1, 0.01),
    },
    build(ctx, p) {
      const input = ctx.createGain(), output = ctx.createGain();
      const f = ctx.createBiquadFilter();
      const lfo = ctx.createOscillator(), lfoAmt = ctx.createGain();
      lfo.frequency.value = 0; lfoAmt.gain.value = 0;
      lfo.connect(lfoAmt); lfoAmt.connect(f.frequency); lfo.start();
      input.connect(f); f.connect(output);
      return {
        input, output, nodes: [input, f, output, lfo, lfoAmt],
        update(p) {
          const t = now(ctx);
          if (f.type !== p.type) f.type = p.type;
          setP(f.frequency, p.freq, t); setP(f.Q, p.q, t); setP(f.gain, p.gain, t);
          setP(lfo.frequency, p.lfoRate, t); setP(lfoAmt.gain, p.lfoDepth * p.freq, t);
        },
      };
    },
  },

  /* ------------------------------------------------------------ time based */
  reverb: {
    name: 'Reverb (Convolution)', cat: 'Space', worklet: false, shared: true,
    params: {
      ir: { label: 'Impulse', def: 'IR_Hall', type: 'select', options: ['IR_Hall', 'IR_Room', 'IR_Plate', 'IR_Spring', 'IR_Cathedral'] },
      predelay: P('Pre-delay', 20, 0, 120, 1, ' ms'),
      size: P('Size / Trim', 100, 20, 200, 1, ' %'),
      damp: P('Damping', 4000, 500, 18000, 10, ' Hz'),
      mix: P('Mix', 30, 0, 100, 1, ' %'),
      level: P('Level', 0, -36, 12, 0.5, ' dB'),
    },
    build(ctx, p, api) {
      const input = ctx.createGain(), output = ctx.createGain();
      const dry = ctx.createGain(), wet = ctx.createGain();
      const conv = api.getSharedConvolver(p.ir || 'IR_Hall');
      conv.__ir = p.ir || 'IR_Hall';
      const dampF = ctx.createBiquadFilter(); dampF.type = 'lowpass';
      const pre = ctx.createDelay(0.25);
      const trim = ctx.createGain();
      input.connect(pre); pre.connect(dry); dry.connect(output);
      pre.connect(conv); conv.connect(dampF); dampF.connect(trim); trim.connect(wet); wet.connect(output);
      return {
        input, output, nodes: [input, pre, dry, dampF, trim, wet, output],
        keep: [conv],
        update(p) {
          const t = now(ctx);
          const m = p.mix / 100;
          setP(dry.gain, 1 - m, t); setP(wet.gain, m, t);
          setP(pre.delayTime, p.predelay / 1000, t);
          setP(dampF.frequency, p.damp, t);
          setP(trim.gain, dbToGain(p.level) * (p.size / 100), t);
          api.ensureConvolver(conv, p.ir);
        },
      };
    },
  },

  verbAlgo: {
    name: 'Reverb (Algorithmic)', cat: 'Space', worklet: 'qw-verb',
    params: {
      size: P('Size', 60, 5, 100, 1, ' %'),
      damp: P('Damping', 40, 0, 100, 1, ' %'),
      predelay: P('Pre-delay', 20, 0, 200, 1, ' ms'),
      mix: P('Mix', 30, 0, 100, 1, ' %'),
    },
    map(p) { return { size: p.size / 100, damp: p.damp / 100, mix: p.mix / 100, predelay: p.predelay / 1000 }; },
  },

  delay: {
    name: 'Delay', cat: 'Space', worklet: false,
    params: {
      timeMode: { label: 'Sync', def: 'beat', type: 'select', options: ['beat', 'ms'] },
      beats: { label: 'Time', def: 0.75, type: 'select', options: [0.125, 0.25, 1 / 3, 0.5, 0.75, 1, 1.5, 2, 3, 4] },
      timeMs: P('Time (ms)', 300, 10, 2000, 1, ' ms'),
      feedback: P('Feedback', 35, 0, 92, 1, ' %'),
      damp: P('Damping', 3500, 400, 16000, 10, ' Hz'),
      mix: P('Mix', 28, 0, 100, 1, ' %'),
      level: P('Level', 0, -36, 12, 0.5, ' dB'),
      pingpong: { label: 'Ping-pong', def: false, type: 'bool' },
    },
    build(ctx, p, api) {
      const input = ctx.createGain(), output = ctx.createGain();
      const dry = ctx.createGain(), wet = ctx.createGain();
      const dL = ctx.createDelay(4), dR = ctx.createDelay(4);
      const fbL = ctx.createGain(), fbR = ctx.createGain();
      const dampL = ctx.createBiquadFilter(), dampR = ctx.createBiquadFilter();
      dampL.type = dampR.type = 'lowpass';
      const merger = ctx.createChannelMerger(2), splitter = ctx.createChannelSplitter(2);
      input.connect(dry); dry.connect(output);
      input.connect(splitter);
      splitter.connect(dL, 0); splitter.connect(dR, 1);
      dL.connect(dampL); dampL.connect(fbL); fbL.connect(dR);
      dR.connect(dampR); dampR.connect(fbR); fbR.connect(dL);
      dampL.connect(wet); dampR.connect(wet); wet.connect(output);
      const MIN_D = 0.005, MAX_D = 3.9;   // > one render quantum so the feedback
      const initTime = clampNum(p.timeMode === 'beat' ? api.beatsToSec(p.beats) : p.timeMs / 1000, MIN_D, MAX_D);
      // loop always has enough delay (a 0-length delay in a feedback loop = NaN)
      dL.delayTime.value = initTime; dR.delayTime.value = initTime;
      return {
        input, output, nodes: [input, dry, wet, dL, dR, fbL, fbR, dampL, dampR, output, splitter, merger],
        update(p) {
          const t = now(ctx);
          const time = clampNum(p.timeMode === 'beat' ? api.beatsToSec(p.beats) : p.timeMs / 1000, MIN_D, MAX_D);
          // immediate (no ramp-from-zero) so the loop delay is never < quantum
          try { dL.delayTime.setValueAtTime(time, t); dR.delayTime.setValueAtTime(time, t); } catch { dL.delayTime.value = time; dR.delayTime.value = time; }
          const fb = clampNum(p.feedback / 100, 0, 0.92);
          setP(fbL.gain, fb, t); setP(fbR.gain, fb, t);
          setP(dampL.frequency, p.damp, t); setP(dampR.frequency, p.damp, t);
          const m = p.mix / 100;
          setP(dry.gain, 1 - m, t); setP(wet.gain, m * dbToGain(p.level), t);
        },
      };
    },
  },

  chorus: {
    name: 'Chorus', cat: 'Modulation', worklet: 'qw-chorus',
    params: {
      rate: P('Rate', 0.6, 0.02, 12, 0.01, ' Hz'),
      depth: P('Depth', 50, 0, 100, 1, ' %'),
      delay: P('Delay', 12, 1, 50, 0.5, ' ms'),
      mix: P('Mix', 40, 0, 100, 1, ' %'),
    },
    map(p) { return { rate: p.rate, depth: p.depth / 100, delay: p.delay / 1000, mix: p.mix / 100 }; },
  },

  phaser: {
    name: 'Phaser', cat: 'Modulation', worklet: false,
    params: {
      rate: P('Rate', 0.4, 0.01, 10, 0.01, ' Hz'),
      depth: P('Depth', 60, 0, 100, 1, ' %'),
      freq: P('Centre', 900, 100, 6000, 5, ' Hz'),
      q: P('Q', 4, 0.2, 20, 0.1),
      stages: P('Stages', 4, 1, 6, 1),
      mix: P('Mix', 55, 0, 100, 1, ' %'),
    },
    build(ctx, p) {
      const input = ctx.createGain(), output = ctx.createGain();
      const dry = ctx.createGain(), wet = ctx.createGain();
      const lfo = ctx.createOscillator(), lfoG = ctx.createGain();
      lfo.start();
      const stages = [];
      let prev = input;
      for (let i = 0; i < 6; i++) {
        const ap = ctx.createBiquadFilter(); ap.type = 'allpass';
        prev.connect(ap); prev = ap; stages.push(ap);
      }
      prev.connect(wet); wet.connect(output);
      input.connect(dry); dry.connect(output);
      lfo.connect(lfoG);
      for (const ap of stages) lfoG.connect(ap.frequency);
      return {
        input, output, nodes: [input, dry, wet, lfo, lfoG, ...stages, output],
        update(p) {
          const t = now(ctx);
          const n = Math.max(1, Math.min(6, Math.round(p.stages)));
          stages.forEach((ap, i) => {
            ap.gain.value = i < n ? 0 : -1000;
            setP(ap.frequency, p.freq * (1 + i * 0.35), t);
            setP(ap.Q, p.q, t);
          });
          setP(lfo.frequency, p.rate, t);
          setP(lfoG.gain, p.depth * p.freq * 0.7, t);
          const m = p.mix / 100;
          setP(dry.gain, 1 - m, t); setP(wet.gain, m, t);
        },
      };
    },
  },

  flanger: {
    name: 'Flanger', cat: 'Modulation', worklet: false,
    params: {
      rate: P('Rate', 0.25, 0.01, 8, 0.01, ' Hz'),
      depth: P('Depth', 60, 0, 100, 1, ' %'),
      delay: P('Base Delay', 4, 0.5, 20, 0.1, ' ms'),
      feedback: P('Feedback', 40, -90, 90, 1, ' %'),
      mix: P('Mix', 55, 0, 100, 1, ' %'),
    },
    build(ctx, p) {
      const input = ctx.createGain(), output = ctx.createGain();
      const dry = ctx.createGain(), wet = ctx.createGain();
      const dl = ctx.createDelay(0.05), fb = ctx.createGain();
      const lfo = ctx.createOscillator(), lfoG = ctx.createGain();
      lfo.start(); lfo.connect(lfoG); lfoG.connect(dl.delayTime);
      input.connect(dry); dry.connect(output);
      input.connect(dl); dl.connect(fb); fb.connect(dl); dl.connect(wet); wet.connect(output);
      dl.delayTime.value = clampNum(p.delay / 1000, 0.0005, 0.045);   // never 0 in a feedback loop
      return {
        input, output, nodes: [input, dry, wet, dl, fb, lfo, lfoG, output],
        update(p) {
          const t = now(ctx);
          const base = clampNum(p.delay / 1000, 0.0005, 0.045);
          dl.delayTime.setTargetAtTime(base, t, 0.02);
          setP(lfo.frequency, p.rate, t);
          setP(lfoG.gain, (p.depth / 100) * base * 0.9, t);
          setP(fb.gain, p.feedback / 100, t);
          const m = p.mix / 100;
          setP(dry.gain, 1 - m, t); setP(wet.gain, m, t);
        },
      };
    },
  },

  tremolo: {
    name: 'Tremolo / Auto-pan', cat: 'Modulation', worklet: false,
    params: {
      rate: P('Rate', 6, 0.05, 24, 0.01, ' Hz'),
      depth: P('Depth', 50, 0, 100, 1, ' %'),
      shape: { label: 'Shape', def: 'sine', type: 'select', options: ['sine', 'square', 'sawtooth', 'triangle'] },
      pan: { label: 'Pan mode', def: false, type: 'bool' },
      sync: { label: 'Tempo sync', def: true, type: 'bool' },
      div: { label: 'Sync div', def: 1, type: 'select', options: [0.25, 0.5, 1, 2, 4] },
    },
    build(ctx, p, api) {
      const input = ctx.createGain(), output = ctx.createGain();
      const amp = ctx.createGain();
      const lfo = ctx.createOscillator(), lfoG = ctx.createGain();
      const panL = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      lfo.start();
      input.connect(amp);
      if (panL) { amp.connect(panL); panL.connect(output); lfo.connect(lfoG); lfoG.connect(panL.pan); }
      else { amp.connect(output); lfo.connect(lfoG); lfoG.connect(amp.gain); }
      return {
        input, output, nodes: [input, amp, lfo, lfoG, output, panL].filter(Boolean),
        update(p) {
          const t = now(ctx);
          const rate = p.sync ? api.bpm / 60 / p.div : p.rate;
          setP(lfo.frequency, rate, t);
          if (lfo.type !== p.shape) lfo.type = p.shape;
          if (panL) setP(lfoG.gain, p.depth / 100, t);
          else { amp.gain.value = 1 - p.depth / 200; setP(lfoG.gain, p.depth / 200, t); lfo.connect(lfoG); lfoG.connect(amp.gain); }
        },
      };
    },
  },

  /* ------------------------------------------------------------ colour */
  saturator: {
    name: 'Saturator', cat: 'Colour', worklet: 'qw-saturator',
    params: {
      drive: P('Drive', 4, 1, 240, 0.1, '%'),
      mode: { label: 'Mode', def: 0, type: 'select', options: ['Tape', 'Tube', 'Soft', 'Hard'] },
      post: P('Output', 0, -24, 12, 0.5, ' dB'),
      mix: P('Mix', 100, 0, 100, 1, ' %'),
    },
    map(p) {
      const opt = typeof p.mode === 'number' ? p.mode : ['Tape', 'Tube', 'Soft', 'Hard'].indexOf(p.mode);
      return { drive: 0.5 + (p.drive / 100) * 6, mix: p.mix / 100, mode: Math.max(0, opt), post: dbToGain(p.post) };
    },
  },

  distortion: {
    name: 'Distortion', cat: 'Colour', worklet: false,
    params: {
      drive: P('Drive', 20, 0, 100, 1, ' %'),
      tone: P('Tone', 3000, 200, 12000, 10, ' Hz'),
      mix: P('Mix', 100, 0, 100, 1, ' %'),
      level: P('Output', -6, -36, 12, 0.5, ' dB'),
    },
    build(ctx, p) {
      const input = ctx.createGain(), output = ctx.createGain();
      const dry = ctx.createGain(), wet = ctx.createGain();
      const pre = ctx.createGain();
      const shaper = ctx.createWaveShaper();
      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
      const post = ctx.createGain();
      input.connect(dry); dry.connect(output);
      input.connect(pre); pre.connect(shaper); shaper.connect(tone); tone.connect(post); post.connect(wet); wet.connect(output);
      const makeCurve = (amt) => {
        const n = 1024, c = new Float32Array(n), k = amt * 4 + 0.5;
        for (let i = 0; i < n; i++) {
          const x = (i * 2) / n - 1;
          c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
        }
        return c;
      };
      shaper.curve = makeCurve(0.2); shaper.oversample = '4x';
      return {
        input, output, nodes: [input, dry, wet, pre, shaper, tone, post, output],
        update(p) {
          const t = now(ctx);
          shaper.curve = makeCurve(p.drive / 100);
          setP(pre.gain, 1 + p.drive / 25, t);
          setP(tone.frequency, p.tone, t);
          const m = p.mix / 100;
          setP(dry.gain, 1 - m, t); setP(wet.gain, m, t);
          setP(post.gain, dbToGain(p.level), t);
        },
      };
    },
  },

  bitcrusher: {
    name: 'Bitcrusher', cat: 'Colour', worklet: false,
    params: {
      bits: P('Bits', 8, 1, 16, 1, ' bit'),
      reduce: P('Sample reduce', 1, 1, 40, 1, '×'),
      mix: P('Mix', 100, 0, 100, 1, ' %'),
    },
    build(ctx, p) {
      const input = ctx.createGain(), output = ctx.createGain();
      const dry = ctx.createGain(), wet = ctx.createGain();
      const shaper = ctx.createWaveShaper(); shaper.oversample = 'none';
      input.connect(dry); dry.connect(output);
      input.connect(shaper); shaper.connect(wet); wet.connect(output);
      const buildCurve = (bits) => {
        const n = 2048, c = new Float32Array(n), st = Math.pow(2, bits - 1);
        for (let i = 0; i < n; i++) {
          const x = (i * 2) / n - 1;
          c[i] = Math.round(x * st) / st;
        }
        return c;
      };
      return {
        input, output, nodes: [input, dry, wet, shaper, output],
        update(p) {
          const t = now(ctx);
          shaper.curve = buildCurve(Math.max(1, Math.round(p.bits)));
          const m = p.mix / 100;
          setP(dry.gain, 1 - m, t); setP(wet.gain, m, t);
        },
      };
    },
  },

  /* ------------------------------------------------------------ vocal */
  deesser: {
    name: 'De-esser', cat: 'Vocal', worklet: 'qw-deesser',
    params: {
      freq: P('Freq', 6500, 2000, 14000, 50, ' Hz'),
      threshold: P('Threshold', -32, -70, 0, 0.5, ' dB'),
      range: P('Range', -12, -40, 0, 0.5, ' dB'),
    },
    map(p) { return { freq: p.freq, threshold: dbToGain(p.threshold), range: dbToGain(p.range) }; },
  },

  pitch: {
    name: 'Pitch / Formant Shift', cat: 'Vocal', worklet: 'qw-pitchshift',
    params: {
      semitones: P('Semitones', 0, -24, 24, 0.1, ' st'),
      windowMs: P('Window', 60, 15, 200, 1, ' ms'),
      mix: P('Mix', 100, 0, 100, 1, ' %'),
    },
    map(p) { return { semitones: p.semitones, windowMs: p.windowMs, mix: p.mix / 100 }; },
  },

  /* ------------------------------------------------------------ utility */
  utility: {
    name: 'Utility', cat: 'Utility', worklet: false,
    params: {
      gain: P('Gain', 0, -36, 24, 0.1, ' dB'),
      pan: P('Pan', 0, -100, 100, 1, ' %'),
      width: P('Width', 100, 0, 250, 1, ' %'),
      phaseL: { label: 'Invert L', def: false, type: 'bool' },
      phaseR: { label: 'Invert R', def: false, type: 'bool' },
      mono: { label: 'Force mono', def: false, type: 'bool' },
    },
    build(ctx, p) {
      const input = ctx.createGain(), output = ctx.createGain();
      const g = ctx.createGain();
      const splitter = ctx.createChannelSplitter(2), merger = ctx.createChannelMerger(2);
      const gL = ctx.createGain(), gR = ctx.createGain();
      const panL = ctx.createStereoPanner(), panR = ctx.createStereoPanner();
      input.connect(g); g.connect(splitter);
      splitter.connect(gL, 0); splitter.connect(gR, 1);
      gL.connect(panL); gR.connect(panR);
      panL.connect(merger, 0, 0); panR.connect(merger, 0, 1);
      merger.connect(output);
      return {
        input, output, nodes: [input, g, splitter, merger, gL, gR, panL, panR, output],
        update(p) {
          const t = now(ctx);
          setP(g.gain, dbToGain(p.gain), t);
          const w = p.width / 100;
          const mid = 0.5, side = w * 0.5;
          // mid/side via per-channel gain + pan
          const pan = clamp(p.pan / 100, -1, 1);
          if (p.mono) {
            setP(gL.gain, mid + side, t); setP(gR.gain, mid + side, t);
            setP(panL.pan, pan * 0.5, t); setP(panR.pan, pan * 0.5, t);
          } else {
            setP(gL.gain, (mid + side) * (p.phaseL ? -1 : 1), t);
            setP(gR.gain, (mid - side) * (p.phaseR ? -1 : 1), t);
            setP(panL.pan, clamp(pan - 0.0, -1, 1), t);
            setP(panR.pan, clamp(pan + 0.0, -1, 1), t);
          }
        },
      };
    },
  },

  limiter: {
    name: 'Brickwall Limiter', cat: 'Dynamics', worklet: 'qw-limiter',
    params: {
      ceiling: P('Ceiling', -0.3, -12, -0.1, 0.1, ' dB'),
      threshold: P('Threshold', -6, -40, 0, 0.5, ' dB'),
      release: P('Release', 120, 5, 1000, 1, ' ms'),
      makeup: P('Makeup', 0, 0, 24, 0.5, ' dB'),
    },
    map(p) {
      return { ceiling: dbToGain(p.ceiling), threshold: dbToGain(p.threshold),
        release: p.release / 1000, makeup: dbToGain(p.makeup) };
    },
  },

  imager: {
    name: 'Stereo Imager', cat: 'Utility', worklet: 'qw-imager',
    params: {
      lowWidth: P('Low width', 60, 0, 250, 1, ' %'),
      midWidth: P('Mid width', 100, 0, 250, 1, ' %'),
      highWidth: P('High width', 120, 0, 250, 1, ' %'),
      lowXover: P('Low xover', 250, 40, 1000, 5, ' Hz'),
      highXover: P('High xover', 4000, 800, 16000, 20, ' Hz'),
    },
    map(p) {
      return { lowWidth: p.lowWidth / 100, midWidth: p.midWidth / 100, highWidth: p.highWidth / 100,
        lowXover: p.lowXover, highXover: p.highXover };
    },
  },
};

/* ------------------------------------------------------------ FX presets */
export const FX_PRESETS = {
  'Vocal → Radio Lead': [
    { type: 'gate', params: { threshold: -52, attack: 0.002, hold: 0.06, release: 0.18, range: -60 } },
    { type: 'eq8', params: { f0: 32, g0: -18, f1: 100, g1: -2.5, f2: 250, g2: -2, f3: 630, g3: -1, f4: 1600, g4: 1.5, f5: 4000, g5: 2.5, f6: 8000, g6: 3, f7: 14000, g7: 2 } },
    { type: 'deesser', params: { freq: 6800, threshold: -34, range: -14 } },
    { type: 'compressor', params: { threshold: -20, knee: 8, ratio: 3.5, attack: 0.008, release: 0.14, makeup: 3, mix: 100 } },
    { type: 'saturator', params: { drive: 12, mode: 1, post: -2, mix: 35 } },
    { type: 'delay', params: { timeMode: 'beat', beats: 0.75, feedback: 26, damp: 3200, mix: 18, level: -3, pingpong: true } },
    { type: 'reverb', params: { ir: 'IR_Plate', predelay: 28, size: 100, damp: 4200, mix: 22, level: -2 } },
    { type: 'compressor', params: { threshold: -14, knee: 6, ratio: 2.5, attack: 0.02, release: 0.2, makeup: 1, mix: 60 } },
  ],
  'Vocal → Telephone': [
    { type: 'filter', params: { type: 'highpass', freq: 600, q: 0.8, gain: 0, lfoRate: 0, lfoDepth: 0 } },
    { type: 'filter', params: { type: 'lowpass', freq: 2600, q: 0.8, gain: 0, lfoRate: 0, lfoDepth: 0 } },
    { type: 'bitcrusher', params: { bits: 6, reduce: 2, mix: 45 } },
    { type: 'saturator', params: { drive: 30, mode: 2, post: -4, mix: 70 } },
  ],
  'Vocal → Auto-tune Style': [
    { type: 'gate', params: { threshold: -50, attack: 0.001, hold: 0.05, release: 0.12, range: -60 } },
    { type: 'deesser', params: { freq: 7000, threshold: -32, range: -12 } },
    { type: 'pitch', params: { semitones: 0, windowMs: 35, mix: 100 } },
    { type: 'compressor', params: { threshold: -22, knee: 4, ratio: 6, attack: 0.003, release: 0.09, makeup: 4, mix: 100 } },
    { type: 'chorus', params: { rate: 0.45, depth: 22, delay: 9, mix: 18 } },
    { type: 'reverb', params: { ir: 'IR_Hall', predelay: 35, size: 110, damp: 5200, mix: 26, level: -1 } },
  ],
  'Vocal → Doubling / Wide': [
    { type: 'chorus', params: { rate: 0.35, depth: 45, delay: 16, mix: 45 } },
    { type: 'imager', params: { lowWidth: 40, midWidth: 100, highWidth: 165, lowXover: 300, highXover: 4500 } },
    { type: 'delay', params: { timeMode: 'ms', timeMs: 24, feedback: 0, damp: 6000, mix: 40, level: -4, pingpong: true } },
  ],
  'Drums → Punch': [
    { type: 'eq8', params: { f0: 32, g0: 3, f1: 100, g1: 2.5, f2: 250, g2: -3.5, f3: 630, g3: -1, f4: 1600, g4: 1, f5: 4000, g5: 2.5, f6: 8000, g6: 2, f7: 14000, g7: 1 } },
    { type: 'compressor', params: { threshold: -16, knee: 4, ratio: 4, attack: 0.008, release: 0.12, makeup: 3, mix: 100 } },
    { type: 'saturator', params: { drive: 18, mode: 0, post: -2, mix: 40 } },
  ],
  'Guitar → Amp Stack': [
    { type: 'distortion', params: { drive: 55, tone: 3800, mix: 100, level: -8 } },
    { type: 'eq8', params: { f0: 32, g0: -12, f1: 100, g1: 2, f2: 250, g2: -4, f3: 630, g3: 1.5, f4: 1600, g4: -1, f5: 4000, g5: 3, f6: 8000, g6: -3, f7: 14000, g7: -12 } },
    { type: 'chorus', params: { rate: 0.8, depth: 30, delay: 11, mix: 22 } },
    { type: 'reverb', params: { ir: 'IR_Room', predelay: 12, size: 90, damp: 3500, mix: 20, level: -3 } },
  ],
  'Synth → Wide Pad': [
    { type: 'chorus', params: { rate: 0.25, depth: 65, delay: 20, mix: 55 } },
    { type: 'imager', params: { lowWidth: 35, midWidth: 110, highWidth: 180, lowXover: 280, highXover: 3800 } },
    { type: 'verbAlgo', params: { size: 78, damp: 45, predelay: 45, mix: 40 } },
  ],
  'Bass → Clean Low End': [
    { type: 'filter', params: { type: 'lowpass', freq: 320, q: 0.9, gain: 0, lfoRate: 0, lfoDepth: 0 } },
    { type: 'compressor', params: { threshold: -18, knee: 3, ratio: 5, attack: 0.01, release: 0.15, makeup: 2, mix: 100 } },
    { type: 'saturator', params: { drive: 14, mode: 1, post: -3, mix: 45 } },
  ],
  'Lo-Fi Tape': [
    { type: 'filter', params: { type: 'lowpass', freq: 6500, q: 0.7, gain: 0, lfoRate: 0, lfoDepth: 0 } },
    { type: 'saturator', params: { drive: 26, mode: 0, post: -4, mix: 80 } },
    { type: 'bitcrusher', params: { bits: 12, reduce: 2, mix: 30 } },
    { type: 'chorus', params: { rate: 0.35, depth: 70, delay: 14, mix: 30 } },
  ],
};

/* ------------------------------------------------------------ helpers */
const now = (ctx) => ctx.currentTime;
const clampNum = (v, a, b) => (v < a ? a : v > b ? b : v);
function setP(param, value, t, smooth = 0.012) {
  if (!param) return;
  const v = Number.isFinite(value) ? value : 0;
  try {
    param.cancelScheduledValues(t);
    param.setTargetAtTime(v, t, smooth);
  } catch { try { param.value = v; } catch {} }
}
function setImmediate(param, value) { if (param) { try { param.value = value; } catch {} } }

export function fxDefaults(type) {
  const def = FX_DEFS[type];
  if (!def) return {};
  const o = {};
  for (const k in def.params) o[k] = def.params[k].def;
  return o;
}

export function fxTypesByCategory() {
  const out = {};
  for (const [k, v] of Object.entries(FX_DEFS)) (out[v.cat] ||= []).push({ id: k, name: v.name });
  return out;
}

export { setP, setImmediate };
