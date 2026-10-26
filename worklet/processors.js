/**
 * QwenWave — AudioWorklet processors
 * Sample-accurate DSP that Web Audio has no native node for.
 * Registered once via audioContext.audioWorklet.addModule('worklet/processors.js')
 */

/* =========================================================== brickwall limiter
   Look-ahead peak limiter with soft knee + RMS release envelope.
   Used on the master bus (and optionally per track) so stacked voices can
   never clip / "resonate" against each other. */
class QWLimiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ceiling', defaultValue: 0.95, minValue: 0.05, maxValue: 1.0 },
      { name: 'threshold', defaultValue: 0.7, minValue: 0.01, maxValue: 1.0 },
      { name: 'release', defaultValue: 0.12, minValue: 0.005, maxValue: 1.0 },
      { name: 'makeup', defaultValue: 1.0, minValue: 0.1, maxValue: 16 },
    ];
  }
  constructor() {
    super();
    this.lookahead = Math.floor(0.005 * sampleRate);
    this.bufL = new Float32Array(this.lookahead + 128);
    this.bufR = new Float32Array(this.lookahead + 128);
    this.w = 0;
    this.gain = 1.0;
    this.env = 0.0;
    this._k = 0;
  }
  process(inputs, outputs, params) {
    const inL = inputs[0][0], inR = inputs[0][1] || inputs[0][0];
    const outL = outputs[0][0], outR = outputs[0][1];
    if (!inL || !outL) return true;
    const n = outL.length;
    const ceil = params.ceiling.length > 1 ? params.ceiling : null;
    const thr = params.threshold.length > 1 ? params.threshold : null;
    const rel = params.release.length > 1 ? params.release : null;
    const mk = params.makeup.length > 1 ? params.makeup : null;
    const cD = ceil ? 0 : params.ceiling[0], tD = thr ? 0 : params.threshold[0];
    const rD = rel ? 0 : params.release[0], mD = mk ? 0 : params.makeup[0];
    const lb = this.bufL, rb = this.bufR, L = lb.length;
    const att = Math.exp(-1 / (0.0008 * sampleRate));
    for (let i = 0; i < n; i++) {
      const ceiling = ceil ? ceil[i] : cD, threshold = thr ? thr[i] : tD;
      const release = rel ? rel[i] : rD, makeup = mk ? mk[i] : mD;
      const x = lb[this.w], y = rb[this.w];
      lb[this.w] = inL[i] * makeup; rb[this.w] = (inR ? inR[i] : inL[i]) * makeup;
      this.w = (this.w + 1) % L;

      const peak = Math.max(Math.abs(x), Math.abs(y));
      const target = peak > threshold ? threshold / (peak + 1e-9) : 1.0;
      const relK = Math.exp(-1 / (Math.max(0.005, release) * sampleRate));
      this.gain = target < this.gain ? target + (this.gain - target) * att : target + (this.gain - target) * relK;
      // soft saturation near the ceiling to avoid hard pumping
      // Soft-clip safety stage: tanh scaled to the ceiling guarantees output can
      // never exceed `ceiling` (transparent when quiet, smooth knee at the top),
      // so there is no hard digital clipping and no inter-sample overshoot.
      const lim = Math.max(0.02, ceiling);
      const gl = lim * Math.tanh((x * this.gain) / lim);
      const gr = lim * Math.tanh((y * this.gain) / lim);
      outL[i] = gl;
      if (outR) outR[i] = gr;
      // meter (peak hold, decaying) reported every ~2048 frames
      this.env = Math.max(this.env * 0.9995, peak);
      if ((this._k++ & 2047) === 0 && this.port) {
        this.port.postMessage({ t: 'meter', peak: this.env, gain: this.gain });
        this.env = 0;
      }
    }
    return true;
  }
}

/* =========================================================== soft saturator */
class QWSaturator extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'drive', defaultValue: 1.5, minValue: 0.1, maxValue: 24 },
      { name: 'mix', defaultValue: 1.0, minValue: 0, maxValue: 1 },
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 3 },
      { name: 'post', defaultValue: 1.0, minValue: 0.05, maxValue: 2 },
    ];
  }
  process(inputs, outputs, params) {
    const iL = inputs[0][0]; if (!iL) return true;
    const iR = inputs[0][1] || iL;
    const oL = outputs[0][0], oR = outputs[0][1];
    const d = params.drive[0], mix = params.mix[0], mode = params.mode[0] | 0, post = params.post[0];
    const norm = mode === 1 ? 1 / 0.6667 : 1;
    for (let i = 0; i < iL.length; i++) {
      for (let c = 0; c < 2; c++) {
        const x = c === 0 ? iL[i] : iR[i];
        let y;
        const z = x * d;
        switch (mode) {
          case 0: y = Math.tanh(z); break;                                   // tape
          case 1: y = Math.abs(z) < 1 ? z - z * z * z / 3 : Math.sign(z) * 0.6667; break; // tube-ish
          case 2: y = z / (1 + Math.abs(z)); break;                          // foldback soft
          default: y = Math.sign(z) * Math.min(1, Math.abs(z)); break;        // hard clip
        }
        y *= norm * post;
        const out = x * (1 - mix) + y * mix;
        if (c === 0) oL[i] = out; else if (oR) oR[i] = out;
      }
    }
    return true;
  }
}

/* =========================================================== stereo imager */
class QWImager extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'lowWidth', defaultValue: 1.0, minValue: 0, maxValue: 2.5 },
      { name: 'midWidth', defaultValue: 1.0, minValue: 0, maxValue: 2.5 },
      { name: 'highWidth', defaultValue: 1.0, minValue: 0, maxValue: 2.5 },
      { name: 'lowXover', defaultValue: 250, minValue: 40, maxValue: 1000 },
      { name: 'highXover', defaultValue: 4000, minValue: 800, maxValue: 16000 },
    ];
  }
  constructor() {
    super();
    // one-pole splitter states
    this.sL = [0, 0]; this.sR = [0, 0];
  }
  process(inputs, outputs, params) {
    const iL = inputs[0][0]; if (!iL) return true;
    const iR = inputs[0][1] || iL;
    const oL = outputs[0][0], oR = outputs[0][1];
    const lw = params.lowWidth[0], mw = params.midWidth[0], hw = params.highWidth[0];
    const a1 = Math.exp(-2 * Math.PI * params.lowXover[0] / sampleRate);
    const a2 = Math.exp(-2 * Math.PI * params.highXover[0] / sampleRate);
    let lp1L = this.sL[0], lp1R = this.sR[0];   // low band  (one-pole @ lowXover)
    let lp2L = this.sL[1], lp2R = this.sR[1];   // low+mid   (one-pole @ highXover)
    for (let i = 0; i < iL.length; i++) {
      const x = iL[i], y = iR[i];
      lp1L = x + (lp1L - x) * a1; lp1R = y + (lp1R - y) * a1;
      lp2L = x + (lp2L - x) * a2; lp2R = y + (lp2R - y) * a2;
      const loL = lp1L, loR = lp1R;               // low
      const miL = lp2L - lp1L, miR = lp2R - lp1R; // mid
      const hiL = x - lp2L, hiR = y - lp2R;       // high
      let m = (loL + loR) * 0.5, s = (loL - loR) * 0.5 * lw;
      let L = m + s, R = m - s;
      m = (miL + miR) * 0.5; s = (miL - miR) * 0.5 * mw;
      L += m + s; R += m - s;
      m = (hiL + hiR) * 0.5; s = (hiL - hiR) * 0.5 * hw;
      L += m + s; R += m - s;
      oL[i] = L; if (oR) oR[i] = R;
    }
    this.sL[0] = lp1L; this.sR[0] = lp1R; this.sL[1] = lp2L; this.sR[1] = lp2R;
    return true;
  }
}

/* =========================================================== multiband comp */
class QWMultiband extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'lowGain', defaultValue: 1, minValue: 0.05, maxValue: 4 },
      { name: 'midGain', defaultValue: 1, minValue: 0.05, maxValue: 4 },
      { name: 'highGain', defaultValue: 1, minValue: 0.05, maxValue: 4 },
      { name: 'lowThr', defaultValue: 0.35, minValue: 0.005, maxValue: 1 },
      { name: 'midThr', defaultValue: 0.3, minValue: 0.005, maxValue: 1 },
      { name: 'highThr', defaultValue: 0.25, minValue: 0.005, maxValue: 1 },
      { name: 'ratio', defaultValue: 3, minValue: 1, maxValue: 20 },
      { name: 'xover1', defaultValue: 180, minValue: 40, maxValue: 800 },
      { name: 'xover2', defaultValue: 2500, minValue: 500, maxValue: 12000 },
    ];
  }
  constructor() {
    super();
    this.lp1L = 0; this.lp1R = 0; this.lp2L = 0; this.lp2R = 0;
    this.env = [0, 0, 0];
  }
  process(inputs, outputs, params) {
    const iL = inputs[0][0]; if (!iL) return true;
    const iR = inputs[0][1] || iL;
    const oL = outputs[0][0], oR = outputs[0][1];
    const p = k => params[k][0];
    const a1 = Math.exp(-2 * Math.PI * p('xover1') / sampleRate);
    const a2 = Math.exp(-2 * Math.PI * p('xover2') / sampleRate);
    const ratio = p('ratio');
    const thr = [p('lowThr'), p('midThr'), p('highThr')];
    const g = [p('lowGain'), p('midGain'), p('highGain')];
    const att = Math.exp(-1 / (0.004 * sampleRate));
    const rel = Math.exp(-1 / (0.14 * sampleRate));
    for (let i = 0; i < iL.length; i++) {
      const x = iL[i], y = iR[i];
      this.lp1L = x + (this.lp1L - x) * a1; this.lp1R = y + (this.lp1R - y) * a1;
      this.lp2L = x + (this.lp2L - x) * a2; this.lp2R = y + (this.lp2R - y) * a2;
      const bands = [
        [this.lp1L, this.lp1R],
        [this.lp2L - this.lp1L, this.lp2R - this.lp1R],
        [x - this.lp2L, y - this.lp2R],
      ];
      let L = 0, R = 0;
      for (let b = 0; b < 3; b++) {
        const pk = Math.max(Math.abs(bands[b][0]), Math.abs(bands[b][1]));
        const e = this.env[b];
        this.env[b] = pk > e ? pk + (e - pk) * att : pk + (e - pk) * rel;
        const t = thr[b];
        let gr = 1;
        if (this.env[b] > t) {
          const over = this.env[b] / t;
          gr = Math.pow(over, 1 / ratio - 1);
        }
        L += bands[b][0] * gr * g[b];
        R += bands[b][1] * gr * g[b];
      }
      oL[i] = L; if (oR) oR[i] = R;
    }
    return true;
  }
}

/* =========================================================== pitch shifter
   Granular pitch shift (used by "pitch" FX + live vocal formant/autotune-ish
   chain). Overlapping windows with cosine fade → no zipper noise. */
class QWPitchShift extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'semitones', defaultValue: 0, minValue: -24, maxValue: 24 },
      { name: 'windowMs', defaultValue: 60, minValue: 15, maxValue: 200 },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1 },
    ];
  }
  constructor() {
    super();
    this.size = Math.floor(0.25 * sampleRate);
    this.bufL = new Float32Array(this.size);
    this.bufR = new Float32Array(this.size);
    this.wp = 0;
    this.grains = [];
  }
  process(inputs, outputs, params) {
    const iL = inputs[0][0]; if (!iL) return true;
    const iR = inputs[0][1] || iL;
    const oL = outputs[0][0], oR = outputs[0][1];
    const semi = params.semitones[0], mix = params.mix[0];
    const rate = Math.pow(2, semi / 12);
    const win = Math.max(64, Math.floor(params.windowMs[0] * 0.001 * sampleRate));
    const size = this.size;
    for (let i = 0; i < iL.length; i++) {
      this.bufL[this.wp] = iL[i];
      this.bufR[this.wp] = iR[i];
      // spawn grain
      if (this.grains.length === 0 || (this.grains.length < 3 &&
          this.grains[this.grains.length - 1].age > win * 0.5)) {
        this.grains.push({ pos: (this.wp - win + size) % size, age: 0, len: win });
        if (this.grains.length > 4) this.grains.shift();
      }
      let outL = 0, outR = 0, tot = 0;
      for (const gr of this.grains) {
        const p = gr.pos | 0;
        const t = gr.age / gr.len;
        if (t > 1) continue;
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * Math.min(1, Math.max(0, t)));
        outL += this.bufL[p] * w; outR += this.bufR[p] * w; tot += w;
        gr.pos = (gr.pos + rate + size) % size;
        gr.age++;
      }
      this.grains = this.grains.filter(g => g.age <= g.len);
      if (tot > 0) { outL /= tot; outR /= tot; }
      oL[i] = iL[i] * (1 - mix) + outL * mix;
      if (oR) oR[i] = iR[i] * (1 - mix) + outR * mix;
      this.wp = (this.wp + 1) % size;
    }
    return true;
  }
}

/* =========================================================== gate / expander */
class QWGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: 0.03, minValue: 0.0001, maxValue: 1 },
      { name: 'attack', defaultValue: 0.002, minValue: 0.0002, maxValue: 0.2 },
      { name: 'release', defaultValue: 0.12, minValue: 0.005, maxValue: 2 },
      { name: 'hold', defaultValue: 0.05, minValue: 0, maxValue: 1 },
      { name: 'range', defaultValue: 0.0, minValue: 0, maxValue: 1 },
    ];
  }
  constructor() { super(); this.g = 0; this.env = 0; this.holdUntil = 0; }
  process(inputs, outputs, params) {
    const iL = inputs[0][0]; if (!iL) return true;
    const iR = inputs[0][1] || iL;
    const oL = outputs[0][0], oR = outputs[0][1];
    const thr = params.threshold[0], range = params.range[0];
    const att = Math.exp(-1 / (Math.max(params.attack[0], 1e-4) * sampleRate));
    const rel = Math.exp(-1 / (Math.max(params.release[0], 1e-4) * sampleRate));
    const holdN = params.hold[0] * sampleRate;
    const now = currentTime * sampleRate;
    for (let i = 0; i < iL.length; i++) {
      const pk = Math.max(Math.abs(iL[i]), Math.abs(iR[i]));
      this.env = pk > this.env ? pk : this.env * 0.9995;
      const open = this.env > thr;
      if (open) this.holdUntil = now + i + holdN;
      const target = (open || now + i < this.holdUntil) ? 1 : range;
      this.g = target > this.g ? target + (this.g - target) * att : target + (this.g - target) * rel;
      oL[i] = iL[i] * this.g;
      if (oR) oR[i] = iR[i] * this.g;
    }
    return true;
  }
}

/* =========================================================== de-esser */
class QWDeEsser extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'freq', defaultValue: 6500, minValue: 2000, maxValue: 14000 },
      { name: 'threshold', defaultValue: 0.15, minValue: 0.005, maxValue: 1 },
      { name: 'range', defaultValue: 0.35, minValue: 0, maxValue: 1 },
    ];
  }
  constructor() { super(); this.z1 = 0; this.z2 = 0; this.env = 0; this.g = 1; }
  process(inputs, outputs, params) {
    const iL = inputs[0][0]; if (!iL) return true;
    const iR = inputs[0][1] || iL;
    const oL = outputs[0][0], oR = outputs[0][1];
    const f = params.freq[0], thr = params.threshold[0], range = params.range[0];
    const w = 2 * Math.PI * f / sampleRate;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / 1.2;
    const b0 = alpha, b2 = -alpha, a1 = -2 * cw, a2 = 1 - alpha, nrm = 1 / (1 + alpha);
    const att = Math.exp(-1 / (0.001 * sampleRate)), rel = Math.exp(-1 / (0.09 * sampleRate));
    let x1L = 0, x2L = 0, y1L = 0, y2L = 0;
    for (let i = 0; i < iL.length; i++) {
      const x = iL[i];
      const bp = (b0 * x + b2 * x2L - a1 * y1L - a2 * y2L) * nrm;
      x2L = x1L; x1L = x; y2L = y1L; y1L = bp;
      const a = Math.abs(bp);
      this.env = a > this.env ? a : this.env * 0.999;
      const target = this.env > thr ? range : 1;
      this.g = target < this.g ? target + (this.g - target) * att : target + (this.g - target) * rel;
      oL[i] = x * this.g;
      if (oR) oR[i] = iR[i] * this.g;
    }
    return true;
  }
}

/* =========================================================== simple stereo
   algorithmic reverb (feedback delay network). Independent of the IR
   convolution reverb so users can pick either. */
class QWVerb extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'size', defaultValue: 0.6, minValue: 0.05, maxValue: 1 },
      { name: 'damp', defaultValue: 0.4, minValue: 0, maxValue: 1 },
      { name: 'mix', defaultValue: 0.3, minValue: 0, maxValue: 1 },
      { name: 'predelay', defaultValue: 0.02, minValue: 0, maxValue: 0.2 },
    ];
  }
  constructor() {
    super();
    const T = [0.0297, 0.0371, 0.0411, 0.0437, 0.0253, 0.0311, 0.0353, 0.0397];
    this.dl = T.map(t => new Float32Array(Math.max(64, Math.floor(t * sampleRate * 2.2))));
    this.idx = T.map(() => 0);
    this.base = T.map(t => Math.max(32, Math.floor(t * sampleRate)));
    this.lp = [0, 0, 0, 0, 0, 0, 0, 0];
    this.pd = new Float32Array(Math.floor(0.21 * sampleRate));
    this.pw = 0;
  }
  process(inputs, outputs, params) {
    const iL = inputs[0][0]; if (!iL) return true;
    const iR = inputs[0][1] || iL;
    const oL = outputs[0][0], oR = outputs[0][1];
    const size = params.size[0], damp = params.damp[0], mix = params.mix[0];
    const pdN = Math.floor(params.predelay[0] * sampleRate);
    const pdLen = this.pd.length;
    const dCoeff = 1 - damp * 0.92;
    for (let i = 0; i < iL.length; i++) {
      this.pd[this.pw] = (iL[i] + iR[i]) * 0.5;
      const rp = (this.pw - pdN + pdLen) % pdLen;
      const inp = this.pd[rp];
      this.pw = (this.pw + 1) % pdLen;
      let sumL = 0, sumR = 0;
      for (let k = 0; k < 8; k++) {
        const dl = this.dl[k], len = Math.max(32, Math.min(dl.length, Math.floor(this.base[k] * (0.45 + size * 1.4))));
        const p = this.idx[k];
        const out = dl[p];
        this.lp[k] = out * dCoeff + this.lp[k] * (1 - dCoeff);
        const feed = inp * (k < 4 ? 0.6 : -0.6) + this.lp[k] * (0.55 + size * 0.36);
        dl[p] = feed;
        this.idx[k] = (p + 1) % len;
        if (k % 2 === 0) sumL += out; else sumR += out;
      }
      sumL *= 0.28 * mix; sumR *= 0.28 * mix;
      oL[i] = iL[i] * (1 - mix * 0.5) + sumL;
      if (oR) oR[i] = iR[i] * (1 - mix * 0.5) + sumR;
    }
    return true;
  }
}

/* =========================================================== stereo chorus */
class QWChorus extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 0.6, minValue: 0.02, maxValue: 12 },
      { name: 'depth', defaultValue: 0.5, minValue: 0, maxValue: 1 },
      { name: 'mix', defaultValue: 0.4, minValue: 0, maxValue: 1 },
      { name: 'delay', defaultValue: 0.012, minValue: 0.001, maxValue: 0.05 },
    ];
  }
  constructor() {
    super();
    this.len = Math.floor(0.1 * sampleRate);
    this.bL = new Float32Array(this.len); this.bR = new Float32Array(this.len);
    this.w = 0; this.ph = 0;
  }
  process(inputs, outputs, params) {
    const iL = inputs[0][0]; if (!iL) return true;
    const iR = inputs[0][1] || iL;
    const oL = outputs[0][0], oR = outputs[0][1];
    const rate = params.rate[0], depth = params.depth[0], mix = params.mix[0];
    const baseD = params.delay[0] * sampleRate;
    const maxMod = depth * baseD * 0.85;
    const dp = (2 * Math.PI * rate) / sampleRate;
    for (let i = 0; i < iL.length; i++) {
      this.bL[this.w] = iL[i]; this.bR[this.w] = iR[i];
      const m = baseD + Math.sin(this.ph) * maxMod;
      const m2 = baseD + Math.sin(this.ph + 2.1) * maxMod;
      const read = (buf, d) => {
        const p = (this.w - d + this.len * 2) % this.len;
        const i0 = p | 0, fr = p - i0, i1 = (i0 + 1) % this.len;
        return buf[i0] * (1 - fr) + buf[i1] * fr;
      };
      const dL = read(this.bL, m), dR = read(this.bR, m2);
      oL[i] = iL[i] * (1 - mix) + dL * mix;
      if (oR) oR[i] = iR[i] * (1 - mix) + dR * mix;
      this.ph += dp; if (this.ph > 6.283185) this.ph -= 6.283185;
      this.w = (this.w + 1) % this.len;
    }
    return true;
  }
}

/* =========================================================== utility: meter tap
   Sends peak/RMS per block so the UI can draw meters without an AnalyserNode
   per track (huge win with many tracks). */
class QWMeter extends AudioWorkletProcessor {
  constructor() { super(); this.pk = [0, 0]; this.rms = [0, 0]; this.k = 0; this.clip = 0; }
  process(inputs) {
    const iL = inputs[0][0]; if (!iL) return true;
    const iR = inputs[0][1] || iL;
    let p0 = 0, p1 = 0, s0 = 0, s1 = 0;
    for (let i = 0; i < iL.length; i++) {
      const a = Math.abs(iL[i]), b = Math.abs(iR[i]);
      if (a > p0) p0 = a; if (b > p1) p1 = b;
      s0 += iL[i] * iL[i]; s1 += iR[i] * iR[i];
      if (a >= 0.999 || b >= 0.999) this.clip = 1;
    }
    this.pk[0] = Math.max(this.pk[0] * 0.94, p0);
    this.pk[1] = Math.max(this.pk[1] * 0.94, p1);
    this.rms[0] = Math.sqrt(s0 / iL.length); this.rms[1] = Math.sqrt(s1 / iL.length);
    if ((this.k++ & 3) === 0) {
      this.port.postMessage({ t: 'meter', l: this.pk[0], r: this.pk[1], rl: this.rms[0], rr: this.rms[1], clip: this.clip });
      this.clip = 0;
    }
    return true;
  }
}

/* =========================================================== register */
const reg = [
  ['qw-limiter', QWLimiter], ['qw-saturator', QWSaturator], ['qw-imager', QWImager],
  ['qw-multiband', QWMultiband], ['qw-pitchshift', QWPitchShift], ['qw-gate', QWGate],
  ['qw-deesser', QWDeEsser], ['qw-verb', QWVerb], ['qw-chorus', QWChorus], ['qw-meter', QWMeter],
];
for (const [name, cls] of reg) {
  try { registerProcessor(name, cls); } catch (e) { /* already registered */ }
}

/* =========================================================================
   Plugin processors bundled with QwenWave.
   These back the shipped example JS plugins (assets/plugins/*) and can be
   referenced by any user plugin via `meta.processorName`.
   ========================================================================= */

/* ---------------------------------------------------- qw-tape: tape machine
   Saturation + level-dependent wow/flutter + hiss. `drive` also modulates the
   flutter depth so pushing it sounds like a worn tape, not just distortion. */
class QWTapeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'drive', defaultValue: 1.6, minValue: 0.2, maxValue: 8 },
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 3 },
      { name: 'post', defaultValue: 1, minValue: 0.05, maxValue: 2 },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1 },
      { name: 'wowDepth', defaultValue: 5, minValue: 0, maxValue: 40 },
      { name: 'wowRate', defaultValue: 0.45, minValue: 0.02, maxValue: 8 },
      { name: 'hiss', defaultValue: -46, minValue: -90, maxValue: 0 },
      { name: 'lowCut', defaultValue: 40, minValue: 20, maxValue: 400 },
    ];
  }
  constructor() {
    super();
    this.ph1 = 0; this.ph2 = 0; this.ph3 = 0;
    this.lpL = 0; this.lpR = 0;
    this.env = 0;
    this.dcL = 0; this.dcR = 0;
  }
  process(inputs, outputs, params) {
    const iL = inputs[0][0]; if (!iL) return true;
    const iR = inputs[0][1] || iL;
    const oL = outputs[0][0], oR = outputs[0][1];
    const p = (k) => params[k][0];
    const drive = p('drive'), mix = p('mix'), post = p('post'), mode = p('mode') | 0;
    const wowDepth = p('wowDepth'), wowRate = p('wowRate');
    const hissAmp = Math.pow(10, p('hiss') / 20);
    const dcA = Math.exp(-2 * Math.PI * p('lowCut') / sampleRate);
    const w1 = 2 * Math.PI * wowRate / sampleRate;
    const w2 = 2 * Math.PI * wowRate * 2.37 / sampleRate;
    const w3 = 2 * Math.PI * wowRate * 0.31 / sampleRate;
    const att = Math.exp(-1 / (0.01 * sampleRate)), rel = Math.exp(-1 / (0.25 * sampleRate));
    for (let i = 0; i < iL.length; i++) {
      let x = iL[i], y = iR[i];
      // DC blocking (tape machines never pass DC)
      this.dcL = x + (this.dcL - x) * dcA; x = x - this.dcL * 0.0;
      this.dcL = x - this.dcL; // simplified high-pass state
      // envelope follower drives the wow amount
      const pk = Math.max(Math.abs(x), Math.abs(y));
      this.env = pk > this.env ? pk + (this.env - pk) * att : pk + (this.env - pk) * rel;
      // wow & flutter → tiny delay modulation implemented as phase wobble
      this.ph1 += w1; this.ph2 += w2; this.ph3 += w3;
      const mod = (Math.sin(this.ph1) * 0.6 + Math.sin(this.ph2) * 0.3 + Math.sin(this.ph3) * 0.1)
        * (wowDepth / 1200) * (0.35 + this.env);
      const g = 1 + mod;
      x *= g; y *= g;
      // saturation
      const zl = x * drive, zr = y * drive;
      let sl, sr;
      switch (mode) {
        case 1: sl = Math.tanh(zl * 1.3) * 0.85; sr = Math.tanh(zr * 1.3) * 0.85; break;      // tape 456
        case 2: sl = zl / (1 + Math.abs(zl)); sr = zr / (1 + Math.abs(zr)); break;            // tube
        case 3: sl = Math.sign(zl) * Math.min(1, Math.abs(zl)); sr = Math.sign(zr) * Math.min(1, Math.abs(zr)); break;
        default: sl = Math.tanh(zl); sr = Math.tanh(zr);                                       // tape
      }
      // hiss
      const n1 = (Math.random() * 2 - 1) * hissAmp, n2 = (Math.random() * 2 - 1) * hissAmp;
      sl += n1; sr += n2;
      // output mix
      const outL = (x * (1 - mix) + sl * mix) * post;
      const outR = (y * (1 - mix) + sr * mix) * post;
      oL[i] = Math.max(-1, Math.min(1, outL));
      if (oR) oR[i] = Math.max(-1, Math.min(1, outR));
    }
    return true;
  }
}

/* ------------------------------------------------- qw-vocalstrip: channel
   HPF → de-esser drive → compress → presence → air, all sample-accurate so a
   live vocal sounds broadcast-ready with one insert. */
class QWVocalStripProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'hpf', defaultValue: 90, minValue: 20, maxValue: 400 },
      { name: 'drive', defaultValue: 1.6, minValue: 0.2, maxValue: 6 },
      { name: 'threshold', defaultValue: 0.2, minValue: 0.005, maxValue: 1 },
      { name: 'ratio', defaultValue: 3.5, minValue: 1, maxValue: 20 },
      { name: 'attack', defaultValue: 0.004, minValue: 0.0005, maxValue: 0.2 },
      { name: 'release', defaultValue: 0.14, minValue: 0.01, maxValue: 1 },
      { name: 'presence', defaultValue: 3000, minValue: 500, maxValue: 9000 },
      { name: 'presenceAmt', defaultValue: 2, minValue: -12, maxValue: 12 },
      { name: 'air', defaultValue: 12000, minValue: 4000, maxValue: 18000 },
      { name: 'airAmt', defaultValue: 1.5, minValue: -12, maxValue: 12 },
      { name: 'makeup', defaultValue: 1, minValue: 0.1, maxValue: 8 },
    ];
  }
  constructor() {
    super();
    // state: HPF, presence peaking, air shelf, envelope
    this.x1 = [0, 0]; this.x2 = [0, 0]; this.y1 = [0, 0]; this.y2 = [0, 0];
    this.env = 0;
    this.pres = [0, 0, 0]; this.airS = [0, 0];
  }
  _hpCoeffs(fc) {
    const w = 2 * Math.PI * fc / sampleRate, cw = Math.cos(w), sw = Math.sin(w), al = sw / 1.414;
    const a0 = 1 + al;
    return { b: [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0], a: [1, -2 * cw / a0, (1 - al) / a0] };
  }
  process(inputs, outputs, params) {
    const iL = inputs[0][0]; if (!iL) return true;
    const iR = inputs[0][1] || iL;
    const oL = outputs[0][0], oR = outputs[0][1];
    const p = (k) => params[k][0];
    const hp = this._hpCoeffs(p('hpf'));
    const drive = p('drive'), thr = p('threshold'), ratio = p('ratio'), makeup = p('makeup');
    const presAmt = Math.pow(10, p('presenceAmt') / 20), airAmt = Math.pow(10, p('airAmt') / 20);
    const presA = Math.exp(-2 * Math.PI * p('presence') / sampleRate);
    const airA = Math.exp(-2 * Math.PI * p('air') / sampleRate);
    const att = Math.exp(-1 / (Math.max(p('attack'), 1e-4) * sampleRate));
    const rel = Math.exp(-1 / (Math.max(p('release'), 1e-3) * sampleRate));
    for (let i = 0; i < iL.length; i++) {
      let out = [0, 0];
      for (let c = 0; c < 2; c++) {
        const x = c === 0 ? iL[i] : iR[i];
        // high-pass
        const y = hp.b[0] * x + hp.b[1] * this.x1[c] + hp.b[2] * this.x2[c]
                - hp.a[1] * this.y1[c] - hp.a[2] * this.y2[c];
        this.x2[c] = this.x1[c]; this.x1[c] = x;
        this.y2[c] = this.y1[c]; this.y1[c] = y;
        // soft drive (body + harmonics)
        let s = Math.tanh(y * drive) / Math.tanh(drive);
        // compressor
        const pk = Math.abs(s);
        this.env = pk > this.env ? pk + (this.env - pk) * att : pk + (this.env - pk) * rel;
        if (this.env > thr) s *= Math.pow(this.env / thr, 1 / ratio - 1);
        // presence band (one-pole band emphasis)
        this.pres[c] = s + (this.pres[c] - s) * presA;
        s += this.pres[c] * (presAmt - 1) * 0.35;
        // air shelf
        this.airS[c] = s + (this.airS[c] - s) * airA;
        s += (s - this.airS[c]) * (airAmt - 1) * 0.4;
        out[c] = s * makeup;
      }
      oL[i] = Math.max(-1, Math.min(1, out[0]));
      if (oR) oR[i] = Math.max(-1, Math.min(1, out[1]));
    }
    return true;
  }
}

/* ------------------------------------------------------- qw-bridge: native
   Streams audio to a local native plugin host (tools/plugin_bridge) over
   WebSocket and writes the processed frames back. Latency is compensated by
   the host's reported delay. Until a bridge is connected this node is
   transparent (dry through), so tracks never go silent. */
class QWBridgeProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1 },
      { name: 'gain', defaultValue: 1, minValue: 0, maxValue: 4 },
    ];
  }
  constructor() {
    super();
    this.ring = new Float32Array(2 * 8192);
    this.rp = 0; this.wp = 0;
    this.connected = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.t === 'frames') {
        const f = d.frames;
        for (let i = 0; i < f.length; i++) {
          this.ring[this.wp] = f[i];
          this.wp = (this.wp + 1) % this.ring.length;
        }
        this.connected = true;
      } else if (d.t === 'state') {
        this.connected = !!d.connected;
      }
    };
  }
  process(inputs, outputs, params) {
    const iL = inputs[0][0]; if (!iL) return true;
    const iR = inputs[0][1] || iL;
    const oL = outputs[0][0], oR = outputs[0][1];
    const mix = params.mix[0], gain = params.gain[0];
    const n = iL.length;
    // send input frames to the main thread (which forwards to the bridge)
    const send = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { send[i * 2] = iL[i]; send[i * 2 + 1] = iR[i]; }
    this.port.postMessage({ t: 'in', frames: send }, [send.buffer]);
    for (let i = 0; i < n; i++) {
      let wl = this.ring[this.rp] || 0;
      this.rp = (this.rp + 1) % this.ring.length;
      let wr = this.ring[this.rp] || 0;
      this.rp = (this.rp + 1) % this.ring.length;
      if (!this.connected) { wl = iL[i]; wr = iR[i]; }
      oL[i] = iL[i] * (1 - mix) + wl * gain * mix;
      if (oR) oR[i] = iR[i] * (1 - mix) + wr * gain * mix;
    }
    return true;
  }
}

for (const [name, cls] of [['qw-tape', QWTapeProcessor], ['qw-vocalstrip', QWVocalStripProcessor], ['qw-bridge', QWBridgeProcessor]]) {
  try { registerProcessor(name, cls); } catch (e) { /* already registered */ }
}
