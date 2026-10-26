#!/usr/bin/env python3
"""
QwenWave — Sample Library Baker  (vectorised / scipy)
=====================================================
Bakes the royalty-free factory sample library into real WAV assets under
library/packs/**.wav  +  library/manifest.json

These are STATIC AUDIO ASSETS shipped with the DAW. The app never synthesises
them at runtime — it loads the files (and caches decoded AudioBuffers + peaks
in IndexedDB). Users can add their own packs the same way.

Run:  .venv/bin/python tools/synth_lib.py
"""
import os, json, math, struct, wave, hashlib, sys, time
import numpy as np
from scipy import signal as sg

SR = 44100
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "library", "packs")
MANIFEST = os.path.join(ROOT, "library", "manifest.json")
RNG = np.random.default_rng(20261027)

T0 = time.time()
def log(*a):
    print(f"[{time.time()-T0:6.1f}s]", *a, flush=True)

# ============================================================== basic DSP (vectorised)
def t_axis(n): return np.arange(n, dtype=np.float64) / SR
def white(n): return RNG.standard_normal(n)

def pink(n):
    """Paul Kellet pink-noise filter, implemented as a 6-pole IIR (lfilter)."""
    # Cascade approximation of the Kellet economy filter using 3 one-poles + shelf
    b = np.array([0.049922035, 0.095993537, 0.049922035 * 0.095993537 * 4])
    x = white(n)
    y = x.copy()
    for pole, gain in ((0.99886, 0.0555179), (0.99332, 0.0750759), (0.96900, 0.1538520),
                       (0.86650, 0.3104856), (0.55000, 0.5329522)):
        y = y + gain * sg.lfilter([1.0], [1.0, -pole], x)
    y = y + 0.5362 * x
    return y * 0.11

def noise(n, kind="white"):
    return white(n) if kind == "white" else pink(n)

def biquad(x, f0, Q, kind="lowpass", gain_db=0.0, sr=SR):
    """RBJ cookbook biquad — vectorised via lfilter. Stereo-aware."""
    f0 = float(np.clip(f0, 10.0, sr * 0.45))
    Q = max(float(Q), 0.05)
    w0 = 2 * math.pi * f0 / sr
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / (2 * Q)
    A = 10 ** (gain_db / 40)
    if kind in ("lowpass", "lp"):
        b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]; a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind in ("highpass", "hp"):
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]; a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind in ("bandpass", "bp"):
        b = [alpha, 0, -alpha]; a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "peaking":
        b = [1 + alpha * A, -2 * cw, 1 - alpha * A]; a = [1 + alpha / A, -2 * cw, 1 - alpha / A]
    elif kind == "lowshelf":
        s2 = 2 * math.sqrt(A) * alpha
        b = [A * ((A + 1) - (A - 1) * cw + s2), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - s2)]
        a = [(A + 1) + (A - 1) * cw + s2, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - s2]
    elif kind == "highshelf":
        s2 = 2 * math.sqrt(A) * alpha
        b = [A * ((A + 1) + (A - 1) * cw + s2), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - s2)]
        a = [(A + 1) - (A - 1) * cw + s2, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - s2]
    elif kind == "notch":
        b = [1, -2 * cw, 1]; a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "allpass":
        b = [1 - alpha, -2 * cw, 1 + alpha]; a = [1 + alpha, -2 * cw, 1 - alpha]
    else:
        raise ValueError(kind)
    b = np.asarray(b, float) / a[0]; a = np.asarray(a, float) / a[0]
    if x.ndim == 1:
        return sg.lfilter(b, a, x)
    return np.stack([sg.lfilter(b, a, x[:, c]) for c in range(x.shape[1])], 1)

def svf_tv(x, cutoff, res=0.9, mode="lp", block=64):
    """State-variable filter with TIME-VARYING cutoff (block-wise, state carried)."""
    n = len(x)
    cutoff = np.broadcast_to(np.asarray(cutoff, float), (n,)).copy()
    y = np.empty(n); lp = hp = bp = 0.0
    for s in range(0, n, block):
        e = min(s + block, n)
        f = 2 * math.sin(math.pi * float(np.clip(cutoff[s:e].mean(), 20, SR * 0.44)) / SR)
        f = min(max(f, 1e-4), 1.9)
        r = min(max(res, 0.0), 1.95)
        xs = x[s:e]
        hs = xs - lp - r * bp
        bs = f * hs + bp
        ls = f * bs + lp
        lp, bp = ls[-1], bs[-1]
        y[s:e] = {"lp": ls, "hp": hs, "bp": bs}[mode]
    return y

def svf(x, cutoff, res=0.9, mode="lp"):
    c = np.asarray(cutoff, float)
    if c.ndim == 0:
        return biquad(x, float(c), max(0.4, 1.0 / max(res, 0.05)), {"lp": "lowpass", "hp": "highpass", "bp": "bandpass"}[mode])
    return svf_tv(x, c, res, mode)

# --- envelopes ----------------------------------------------------------------
def env_ad(n, a=0.002, d=0.2, curve=3.0):
    an = max(1, int(a * SR)); dn = max(1, n - an)
    e = np.zeros(n)
    e[:an] = np.linspace(0, 1, an)
    e[an:] = np.exp(-curve * np.linspace(0, 1, dn))
    return e

def env_adhd(n, a=0.002, h=0.02, hold=0.0, d=0.2, curve=4.0):
    an = max(1, int(a * SR)); hn = max(1, int(h * SR)); hld = int(hold * SR)
    dn = max(1, n - an - hn - hld)
    e = np.zeros(n); i = 0
    e[i:i+an] = np.linspace(0, 1, an); i += an
    e[i:i+hn] = np.linspace(1, 0.75, hn); i += hn
    if hld: e[i:i+hld] = 0.75; i += hld
    e[i:i+dn] = 0.75 * np.exp(-curve * np.linspace(0, 1, dn))
    return e

def env_adsr(n, a=0.01, d=0.1, s=0.7, r=0.25):
    an = max(1, int(a * SR)); dn = max(1, int(d * SR)); rn = max(1, int(r * SR))
    sus = max(0, n - an - dn - rn)
    e = np.concatenate([np.linspace(0, 1, an), np.linspace(1, s, dn),
                        np.full(sus, s), np.linspace(s, 0, rn)])
    return e[:n] if len(e) >= n else np.concatenate([e, np.zeros(n - len(e))])

def env_perc(n, decay=0.15, curve=5.0):
    return np.exp(-curve * np.linspace(0, 1, n)) * (1 - np.exp(-np.linspace(0, 60, n)))

def fade(x, fi=64, fo=None):
    fo = fi if fo is None else fo
    L = x.shape[0]
    if L < fi + fo + 2: return x
    x = x.copy()
    ramp_in = np.linspace(0, 1, fi)[:, None] if x.ndim == 2 else np.linspace(0, 1, fi)
    ramp_out = np.linspace(1, 0, fo)[:, None] if x.ndim == 2 else np.linspace(1, 0, fo)
    x[:fi] *= ramp_in; x[-fo:] *= ramp_out
    return x

# --- shapers ------------------------------------------------------------------
def tanh_sat(x, drive=2.0):
    return np.tanh(x * drive) / math.tanh(drive)

def soft_clip(x, drive=2.0):
    y = np.clip(x * drive, -3, 3)
    return np.where(np.abs(y) < 1, y - y ** 3 / 3, np.sign(y) * 2 / 3) / (2 / 3)

def bitcrush(x, bits=8):
    st = 2 ** (bits - 1)
    return np.round(x * st) / st

def downsample_hold(x, factor):
    factor = max(1, int(factor))
    idx = (np.arange(x.shape[0]) // factor) * factor
    return x[idx]

# --- oscillators --------------------------------------------------------------
def freq(n, f): return np.sin(2 * math.pi * f * t_axis(n))

def phasor(n, f0, f1=None):
    if f1 is None: f1 = f0
    return np.sin(2 * math.pi * np.cumsum(np.linspace(f0, f1, n)) / SR)

def exp_phasor(n, f0, f1):
    t = np.arange(n) / SR
    k = math.log(max(f1, 1e-6) / max(f0, 1e-6)) / max(n / SR, 1e-9)
    return np.sin(2 * math.pi * np.cumsum(f0 * np.exp(k * t)) / SR)

def saw(f, n, phase=0.0):
    return 2 * ((f * t_axis(n) + phase) % 1) - 1

def pulse(f, n, pw=0.5, phase=0.0):
    return np.where(((f * t_axis(n) + phase) % 1) < pw, 1.0, -1.0)

def midi_hz(m): return 440.0 * 2 ** ((m - 69) / 12.0)
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
def note_name(m): return f"{NAMES[int(m) % 12]}{int(m) // 12 - 1}"

def pitch_shift_resample(x, semitones):
    r = 2 ** (semitones / 12.0)
    n_out = max(2, int(round(x.shape[0] / r)))
    idx = np.linspace(0, x.shape[0] - 1, n_out)
    i0 = np.floor(idx).astype(int); fr = idx - i0
    i1 = np.minimum(i0 + 1, x.shape[0] - 1)
    if x.ndim == 1: return x[i0] * (1 - fr) + x[i1] * fr
    return np.stack([x[i0, c] * (1 - fr) + x[i1, c] * fr for c in range(x.shape[1])], 1)

def to_stereo(x, width=0.0):
    if x.ndim == 2: return x
    if width <= 0.001:
        return np.stack([x, x], 1)
    d = max(1, int(0.0007 * SR))
    dec = np.concatenate([np.zeros(d), x[:-d]])
    side = (x - dec) * width
    return np.stack([x + side, x - side], 1)

def normalize(x, peak_db=-1.0, rms_db=None):
    p = np.max(np.abs(x)) + 1e-12
    y = x * (10 ** (peak_db / 20) / p)
    if rms_db is not None:
        r = np.sqrt(np.mean(y ** 2)) + 1e-12
        y = y * (10 ** (rms_db / 20) / r)
        p2 = np.max(np.abs(y)) + 1e-12
        lim = 10 ** (peak_db / 20)
        if p2 > lim: y *= lim / p2
    return np.clip(y, -1.0, 1.0)

def dc_block(x):
    return sg.lfilter([1.0, -1.0], [1.0, -0.995], x, axis=0)

# ============================================================== WAV IO
def write_wav(path, x, sr=SR, bits=16):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if x.ndim == 1: x = x[:, None]
    x = np.ascontiguousarray(np.clip(x, -1.0, 1.0), dtype=np.float64)
    n_ch = x.shape[1]
    if bits == 24:
        # correct 24-bit little-endian two's-complement packing
        d = np.clip(np.rint(x * 8388607.0), -8388608, 8388607).astype(np.int32)
        b0 = (d & 0xff).astype(np.uint8)
        b1 = ((d >> 8) & 0xff).astype(np.uint8)
        b2 = ((d >> 16) & 0xff).astype(np.uint8)
        raw = np.stack([b0, b1, b2], axis=-1).ravel().tobytes()
        sw = 3
    else:
        raw = np.clip(np.rint(x * 32767.0), -32768, 32767).astype("<i2").tobytes(); sw = 2
    with wave.open(path, "wb") as w:
        w.setnchannels(n_ch); w.setsampwidth(sw); w.setframerate(sr); w.writeframes(raw)
    return os.path.getsize(path)

def peaks(x, n=128):
    m = np.abs(x).max(axis=1) if x.ndim == 2 else np.abs(x)
    cs = max(1, len(m) // n)
    m = m[:cs * n].reshape(n, cs)
    return [round(float(v), 4) for v in m.max(axis=1)]

def rms_db(x):
    x = np.nan_to_num(np.asarray(x, float), nan=0.0, posinf=0.0, neginf=0.0)
    v = float(np.sqrt(np.mean(x ** 2)))
    return round(20 * math.log10(v + 1e-12), 2)

# ============================================================== registry
LIB = []
_bytes = 0
def trim_tail(x, thresh_db=-72.0, keep=0.01):
    m = np.abs(x).max(axis=1) if x.ndim == 2 else np.abs(x)
    th = 10 ** (thresh_db / 20)
    nz = np.nonzero(m > th)[0]
    if len(nz) == 0: return x
    end = min(len(m), nz[-1] + 1 + int(keep * SR))
    return x[:end]

def emit(pack, name, x, **meta):
    global _bytes
    if x.ndim == 1: x = x[:, None]
    x = dc_block(np.asarray(x, float))
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)   # safety net
    # dc_block is a high-pass that can push transients above full scale;
    # re-normalise so the stored WAV never hard-clips and manifest peaks match.
    pk = float(np.max(np.abs(x)))
    if pk > 0.999:
        x = x * (0.999 / pk)
    if pk < 1e-6:
        print(f"  !! WARN near-silent/NaN sample: {pack}/{name}")
    if not str(pack).startswith("Loops") and not meta.get("loop"):
        x = trim_tail(x)
    rel = f"{pack}/{name}.wav"
    bits = 16 if (str(pack).startswith("Loops") or str(pack).startswith("Pads") or str(pack).startswith("FX")) else 24
    sz = write_wav(os.path.join(OUT, rel), x, bits=bits)
    e = {"id": "s_" + hashlib.sha1(rel.encode()).hexdigest()[:12], "name": name, "pack": pack,
         "file": rel, "duration": round(x.shape[0] / SR, 4), "channels": int(x.shape[1]),
         "sampleRate": SR, "bitDepth": bits, "bytes": sz, "rms": rms_db(x), "peaks": peaks(x, 128)}
    e.update(meta)
    LIB.append(e); _bytes += sz
    return x

# ============================================================== INSTRUMENT BUILDERS
def kick_808(f_start=120.0, f_end=44.0, decay=0.55, click=0.9, drive=3.0, tail=0.5):
    n = int((decay + tail) * SR)
    sig = exp_phasor(n, f_start, f_end) * env_adhd(n, 0.0008, 0.006, 0, decay + tail, 6.5)
    cn = max(2, int(0.004 * SR))
    sig[:cn] += noise(cn) * np.exp(-np.linspace(0, 30, cn)) * click
    return normalize(fade(tanh_sat(sig, drive), 8, 400), -1.0)

def kick_punch(f0=200, f1=52, decay=0.28, click=1.0):
    n = int((decay + 0.12) * SR)
    sig = exp_phasor(n, f0, f1) * env_adhd(n, 0.0006, 0.004, 0, decay + 0.12, 7.5)
    cn = max(2, int(0.006 * SR))
    sig[:cn] += biquad(noise(cn), 2500, 0.8, "bandpass") * np.exp(-np.linspace(0, 25, cn)) * click
    return normalize(fade(tanh_sat(sig, 2.2), 8, 300), -1.0)

def kick_acoustic(decay=0.35):
    n = int((decay + 0.2) * SR)
    sig = exp_phasor(n, 95, 48) * env_adhd(n, 0.001, 0.01, 0, decay + 0.2, 5.0)
    sig += 0.35 * exp_phasor(n, 190, 90) * env_perc(n, decay * 0.4)
    sig += biquad(noise(n), 900, 0.9, "bandpass") * env_perc(n, 0.03) * 0.25
    cn = max(2, int(0.01 * SR))
    sig[:cn] += biquad(noise(cn), 3200, 0.7, "bandpass") * np.exp(-np.linspace(0, 18, cn)) * 0.8
    return normalize(fade(soft_clip(sig, 1.8), 8, 400), -1.5)

def snare(tune=210, decay=0.19, noise_amt=0.85, bright=5200):
    n = int((decay + 0.25) * SR)
    tone = (np.sin(2*math.pi*tune*t_axis(n)) + 0.4*np.sin(2*math.pi*tune*1.62*t_axis(n))) * env_adhd(n, 0.001, 0.006, 0, decay, 6.0)
    nz = biquad(noise(n), bright, 0.55, "highpass") * env_adhd(n, 0.0008, 0.01, 0, decay + 0.16, 7.0) * noise_amt
    body = biquad(noise(n), tune * 1.6, 1.4, "bandpass") * env_adhd(n, 0.001, 0.005, 0, decay * 0.8, 6.0) * 0.5
    return normalize(fade(tanh_sat(tone * (1 - noise_amt * 0.5) + nz + body, 1.7), 8, 500), -1.0)

def clap(decay=0.28, layers=4):
    n = int((decay + 0.35) * SR)
    sig = np.zeros(n)
    for i in range(layers):
        off = int(i * 0.0095 * SR); ln = min(int(0.02 * SR), n - off)
        if ln <= 10: break
        sig[off:off+ln] += biquad(noise(ln), 1250 + i * 90, 1.1, "bandpass") * np.exp(-np.linspace(0, 22, ln)) * (0.9 if i < layers-1 else 0.6)
    sig += biquad(noise(n), 1100, 0.6, "bandpass") * np.exp(-np.linspace(0, 9, n)) * 0.55
    return normalize(fade(sig, 8, 700), -1.2)

def hat(open_=False, tone=8200, decay=0.06, metallic=1.0):
    d = decay * (5 if open_ else 1)
    n = int((d + 0.12) * SR)
    sig = np.zeros(n)
    for i, r in enumerate([2.0, 3.01, 4.17, 5.43, 6.79, 8.21]):
        f = tone * r / 2
        if f > SR * 0.44: continue
        sig += np.sin(2*math.pi*f*t_axis(n) + i) * (0.5 / (1 + i * 0.4)) * metallic
    sig = biquad(sig, tone * 0.75, 0.8, "highpass")
    nz = biquad(noise(n), tone, 0.7, "highpass") * 0.9
    e = np.exp(-np.linspace(0, 4.5 if open_ else 14, n))
    return normalize(fade((sig * 0.55 + nz) * e, 4, 200), -2.0)

def ride(decay=1.6):
    n = int((decay + 0.5) * SR)
    sig = np.zeros(n)
    for i, f in enumerate([3400, 4700, 5900, 7300, 8600, 10200]):
        sig += np.sin(2*math.pi*f*t_axis(n) + i * 1.7) * (0.4 / (1 + i * 0.35))
    sig = biquad(sig, 3200, 0.7, "highpass") * np.exp(-np.linspace(0, 3.0, n))
    ping = np.sin(2*math.pi*5200*t_axis(n)) * np.exp(-np.linspace(0, 6, n)) * 0.8
    nz = biquad(noise(n), 6500, 0.6, "highpass") * np.exp(-np.linspace(0, 8, n)) * 0.5
    return normalize(fade(sig + ping + nz, 4, 900), -3.0)

def crash(decay=2.4):
    n = int((decay + 0.8) * SR)
    sig = np.zeros(n)
    for i, r in enumerate([1.0, 1.34, 1.71, 2.13, 2.66, 3.2, 3.9, 4.7]):
        f = 4200 * r
        if f > SR * 0.44: continue
        sig += np.sin(2*math.pi*f*t_axis(n) + i * 2.3) * (0.5 / (1 + i * 0.25))
    sig = biquad(sig, 3500, 0.6, "highpass") * np.exp(-np.linspace(0, 2.6, n))
    sig += biquad(noise(n), 5000, 0.5, "highpass") * np.exp(-np.linspace(0, 5.5, n)) * 0.75
    return normalize(fade(sig, 4, 2000), -3.0)

def tom(f0=160, decay=0.4):
    n = int((decay + 0.3) * SR)
    sig = exp_phasor(n, f0, f0 * 0.55) * env_adhd(n, 0.002, 0.01, 0, decay + 0.2, 5.0)
    sig += biquad(noise(n), f0 * 3, 0.8, "bandpass") * env_perc(n, decay * 0.35) * 0.3
    return normalize(fade(tanh_sat(sig, 1.8), 8, 500), -1.5)

def rim(tune=1750):
    n = int(0.09 * SR)
    sig = np.sin(2*math.pi*tune*t_axis(n)) * np.exp(-np.linspace(0, 45, n))
    sig += 0.6 * np.sin(2*math.pi*tune*2.7*t_axis(n)) * np.exp(-np.linspace(0, 70, n))
    cn = max(2, int(0.002 * SR)); sig[:cn] += noise(cn) * 0.5
    return normalize(fade(sig, 4, 60), -1.5)

def shaker(decay=0.13):
    n = int((decay + 0.08) * SR)
    sig = biquad(noise(n), 7000, 0.7, "bandpass")
    return normalize(fade(sig * np.sin(np.linspace(0, math.pi, n)) ** 0.7 * np.exp(-np.linspace(0, 3, n)), 4, 200), -4.0)

def cowbell(f0=540, decay=0.35):
    n = int((decay + 0.2) * SR)
    sig = biquad(np.sign(np.sin(2*math.pi*f0*t_axis(n))) + 0.8*np.sign(np.sin(2*math.pi*f0*1.48*t_axis(n))), f0, 1.2, "bandpass")
    return normalize(fade(tanh_sat(sig * np.exp(-np.linspace(0, 12, n)), 2.0), 4, 400), -2.0)

def perc_metallic(f0=2100, decay=0.25):
    n = int((decay + 0.15) * SR)
    sig = np.zeros(n)
    for i, r in enumerate([1.0, 1.51, 2.02, 2.73, 3.41]):
        sig += np.sin(2*math.pi*f0*r*t_axis(n) + i) * (0.6 / (1 + i * 0.4))
    sig = svf(sig, np.linspace(f0 * 2, f0 * 0.5, n), 1.1, "bp") * np.exp(-np.linspace(0, 16, n))
    return normalize(fade(sig, 4, 400), -3.0)

def sub_drop(f0=90, f1=30, decay=1.4):
    n = int((decay + 0.4) * SR)
    sig = exp_phasor(n, f0, f1) * env_adhd(n, 0.01, 0.1, 0, decay, 3.0)
    sig += 0.25 * exp_phasor(n, f0 * 2, f1 * 2) * env_adhd(n, 0.005, 0.05, 0, decay * 0.6, 4.0)
    return normalize(fade(tanh_sat(sig, 1.6), 16, 800), -1.5)

def bass_808(m, decay=1.2, drive=2.5):
    f = midi_hz(m); n = int((decay + 0.35) * SR)
    sig = exp_phasor(n, f * 2.2, f) * env_adsr(n, 0.004, 0.06, 0.92, 0.3)
    sig += 0.32 * np.sin(2*math.pi*f*2*t_axis(n)) * env_adsr(n, 0.004, 0.05, 0.5, 0.2)
    sig += 0.12 * np.sin(2*math.pi*f*3*t_axis(n)) * env_adsr(n, 0.004, 0.04, 0.3, 0.15)
    sig = biquad(tanh_sat(sig, drive), min(f * 9, 12000), 0.7, "lowpass")
    return normalize(fade(sig, 16, 900), -1.2)

def bass_reese(m, decay=1.6, detune=9):
    f = midi_hz(m); n = int((decay + 0.4) * SR); t = t_axis(n); d = detune / 100.0
    a = np.sin(2*math.pi*f*(1+d)*t) + 0.7 * np.sign(np.sin(2*math.pi*f*(1-d)*t))
    lfo = 1 + 0.25 * np.sin(2*math.pi*0.35*t)
    sig = svf_tv(a, np.linspace(700, 320, n) * lfo, 1.5, "lp") * env_adsr(n, 0.01, 0.1, 0.9, 0.35)
    return normalize(fade(tanh_sat(sig, 2.0), 32, 900), -1.5)

def bass_fm(m, decay=0.9, ratio=2.0, idx=3.0):
    f = midi_hz(m); n = int((decay + 0.3) * SR); t = t_axis(n)
    sig = np.sin(2*math.pi*f*t + np.sin(2*math.pi*f*ratio*t) * idx * np.exp(-np.linspace(0, 7, n)))
    sig = biquad(sig * env_adsr(n, 0.003, 0.08, 0.7, 0.25), min(f*8, 9000), 0.7, "lowpass")
    return normalize(fade(tanh_sat(sig, 1.8), 16, 700), -1.5)

def bass_acid(m, decay=0.6, cutoff=380, res=6.5):
    f = midi_hz(m); n = int((decay + 0.25) * SR)
    ce = np.exp(-np.linspace(0, 6.5, n))
    sig = svf_tv(saw(f, n), cutoff + 3200 * ce, res, "lp") * env_adsr(n, 0.002, 0.05, 0.8, 0.15)
    return normalize(fade(tanh_sat(sig, 2.4), 8, 500), -1.5)

def bass_pluck(m, decay=0.7):
    f = midi_hz(m); n = int((decay + 0.3) * SR); t = t_axis(n)
    sig = np.zeros(n)
    for h, amp in ((1, 1.0), (2, 0.55), (3, 0.3), (4, 0.18), (5, 0.09)):
        sig += amp * np.sin(2*math.pi*f*h*t + h) * np.exp(-np.linspace(0, 4 + h * 2, n))
    sig = biquad(sig, min(f*7, 8000), 0.8, "lowpass") * env_adhd(n, 0.002, 0.01, 0, decay, 4.0)
    return normalize(fade(sig, 16, 700), -1.5)

def bass_synth(m, decay=1.0):
    f = midi_hz(m); n = int((decay + 0.3) * SR); t = t_axis(n)
    sig = svf_tv(saw(f, n) + saw(f * 1.004, n) * 0.8, np.linspace(1800, 300, n), 1.1, "lp")
    sig *= env_adsr(n, 0.006, 0.09, 0.85, 0.3)
    sig += np.sin(2*math.pi*f*0.5*t) * 0.5 * env_adsr(n, 0.006, 0.08, 0.9, 0.3)
    return normalize(fade(tanh_sat(sig, 1.9), 24, 800), -1.5)

def saw_stack(m, decay=1.0, voices=5, detune=11, bright=0.6):
    f = midi_hz(m); n = int((decay + 0.6) * SR); t = t_axis(n)
    sig = np.zeros(n)
    for v in range(voices):
        d = (v - (voices - 1) / 2) * detune / 100.0
        sig += saw(f * (1 + d), n, v * 0.13) / voices
    ce = np.exp(-np.linspace(0, 2.2, n))
    sig = svf_tv(sig, 500 + bright * 6500 * ce, 0.9, "lp") * env_adsr(n, 0.012, 0.18, 0.75, 0.5)
    return normalize(fade(sig, 48, 1400), -2.0)

def square_lead(m, decay=0.8, pw=0.35):
    f = midi_hz(m); n = int((decay + 0.4) * SR); t = t_axis(n)
    vib = 1 + 0.004 * np.sin(2*math.pi*5.2*t) * np.minimum(1, t / 0.25)
    sig = np.where(((f * np.cumsum(vib) / SR) % 1) < pw, 1.0, -1.0)
    sig = svf_tv(sig, np.linspace(4200, 1600, n), 1.0, "lp") * env_adsr(n, 0.006, 0.1, 0.8, 0.35)
    return normalize(fade(tanh_sat(sig, 1.7), 32, 900), -2.0)

def sine_lead(m, decay=1.2):
    f = midi_hz(m); n = int((decay + 0.5) * SR); t = t_axis(n)
    vib = 1 + 0.006 * np.sin(2*math.pi*5.5*t) * np.minimum(1, t / 0.35)
    sig = np.sin(2*math.pi*f*np.cumsum(vib)/SR)
    sig += 0.18 * np.sin(2*math.pi*f*2*t) * np.exp(-np.linspace(0, 5, n))
    return normalize(fade(sig * env_adsr(n, 0.02, 0.15, 0.85, 0.45), 64, 1200), -2.5)

def bell_fm(m, decay=2.2, ratio=3.5, idx=4.5):
    f = midi_hz(m); n = int((decay + 0.6) * SR); t = t_axis(n)
    sig = np.sin(2*math.pi*f*t + np.sin(2*math.pi*f*ratio*t) * idx * np.exp(-np.linspace(0, 4.0, n)))
    sig += 0.3 * np.sin(2*math.pi*f*2*t) * np.exp(-np.linspace(0, 6, n))
    sig += 0.15 * np.sin(2*math.pi*f*5.4*t) * np.exp(-np.linspace(0, 12, n))
    sig = to_stereo(sig * env_adhd(n, 0.002, 0.01, 0, decay, 2.6), 0.7)
    return normalize(fade(sig, 8, 1500), -3.0)

def pluck_karplus(m, decay=0.8, damp=0.498):
    f = midi_hz(m); N = max(2, int(SR / f)); n = int((decay + 0.4) * SR)
    buf = noise(N).copy()
    out = np.zeros(n); idx = 0
    # vectorised-ish Karplus: process in blocks carrying the delay line
    blk = max(1, N // 4)
    for s in range(0, n, blk):
        e = min(s + blk, n)
        for i in range(s, e):
            cur = buf[idx]; nxt = buf[(idx + 1) % N]
            buf[idx] = (cur + nxt) * damp
            out[i] = cur
            idx = (idx + 1) % N
    out = biquad(out, min(f * 8, 11000), 0.7, "lowpass")
    return normalize(fade(out, 8, 900), -2.5)

def epiano(m, decay=1.8):
    f = midi_hz(m); n = int((decay + 0.6) * SR); t = t_axis(n)
    sig = np.sin(2*math.pi*f*t) * np.exp(-np.linspace(0, 2.0, n))
    sig += 0.5 * np.sin(2*math.pi*f*2*t + 0.4) * np.exp(-np.linspace(0, 4.5, n))
    sig += 0.28 * np.sin(2*math.pi*f*3*t) * np.exp(-np.linspace(0, 7.5, n))
    sig += 0.14 * np.sin(2*math.pi*f*4.07*t) * np.exp(-np.linspace(0, 11, n))
    sig *= env_adhd(n, 0.004, 0.02, 0, decay, 2.0) * (1 + 0.09 * np.sin(2*math.pi*4.6*t))
    return normalize(fade(to_stereo(tanh_sat(sig, 1.5), 0.35), 16, 1500), -3.0)

def organ(m, decay=1.0):
    f = midi_hz(m); n = int((decay + 0.5) * SR); t = t_axis(n)
    sig = np.zeros(n); tot = 0.0
    for mult, amp in ((0.5, 1.0), (1, 0.8), (1.5, 0.5), (2, 0.7), (3, 0.35), (4, 0.3), (6, 0.18)):
        ff = f * mult
        if ff > SR * 0.42: continue
        sig += amp * np.sin(2*math.pi*ff*t); tot += amp
    sig = (sig / max(tot, 1e-6)) * env_adsr(n, 0.02, 0.05, 0.9, 0.2)
    return normalize(fade(tanh_sat(sig, 1.4), 32, 700), -3.0)

def pad_grain(m, dur=3.0, density=90):
    f = midi_hz(m); n = int((dur + 1.2) * SR); sig = np.zeros(n)
    for _ in range(density):
        gl = min(int(RNG.uniform(0.12, 0.4) * SR), n - 1)
        if gl < 512: continue
        pos = int(RNG.integers(0, max(1, n - gl)))
        det = RNG.uniform(-14, 14); ff = f * 2 ** (det / 1200)
        g = np.sin(2*math.pi*ff*t_axis(gl)) + 0.35 * np.sin(2*math.pi*ff*1.5*t_axis(gl))
        sig[pos:pos+gl] += g * np.sin(np.linspace(0, math.pi, gl)) ** 1.4 * RNG.uniform(0.25, 0.6)
    ce = np.exp(-np.linspace(0, 1.2, n))
    sig = svf_tv(sig, 700 + 2600 * ce, 0.8, "lp") * env_adsr(n, 0.9, 0.4, 0.9, 1.0)
    return normalize(fade(to_stereo(sig, 0.9), 256, 4000), -4.0)

def choir(m, dur=2.6):
    f = midi_hz(m); n = int((dur + 1.0) * SR); t = t_axis(n); sig = np.zeros(n)
    for det, fms, amps in ((1, [700, 1220, 2600], [1.0, 0.5, 0.3]),
                           (1.005, [660, 1120, 2500], [0.9, 0.45, 0.28]),
                           (0.997, [740, 1300, 2700], [0.85, 0.42, 0.25])):
        src = sum(np.sin(2*math.pi*f*det*h*t + h * 1.1) / h for h in range(1, 9))
        for fm, amp in zip(fms, amps):
            src = src + amp * biquad(src, fm, 5.0, "peaking", gain_db=9)
        sig += src * (1 + 0.004 * np.sin(2*math.pi*RNG.uniform(4.4, 5.8)*t + RNG.uniform(0, 6)))
    sig = biquad(sig / 3 * env_adsr(n, 0.5, 0.3, 0.95, 0.8), 5000, 0.7, "lowpass")
    return normalize(fade(to_stereo(sig, 0.85), 256, 3000), -4.0)

def strings(m, dur=2.2):
    f = midi_hz(m); n = int((dur + 0.8) * SR); t = t_axis(n); sig = np.zeros(n)
    for v in range(3):
        d = (v - 1) * 7 / 100.0
        s = biquad(saw(f * (1 + d), n, v * 0.31), 900 + v * 250, 0.9, "lowpass")
        sig += s * (1 + 0.0035 * np.sin(2*math.pi*(4.8 + v * 0.4)*t))
    ce = np.minimum(1, t / 0.25) * np.exp(-np.linspace(0, 0.8, n))
    sig = svf_tv(sig / 3, 500 + 2200 * ce, 0.85, "lp") * env_adsr(n, 0.18, 0.25, 0.9, 0.5)
    return normalize(fade(to_stereo(sig, 0.6), 128, 2000), -3.5)

def vowel_tone(m, vowel="a", dur=1.4, vibrato=5.2):
    f = midi_hz(m); n = int((dur + 0.5) * SR); t = t_axis(n)
    FORM = {"a": [(700, 1.0, 8), (1220, 0.6, 9), (2600, 0.3, 10), (3700, 0.12, 11)],
            "e": [(530, 1.0, 8), (1840, 0.5, 9), (2480, 0.28, 10), (3600, 0.1, 11)],
            "i": [(270, 1.0, 8), (2290, 0.42, 9), (3010, 0.25, 10), (3800, 0.09, 11)],
            "o": [(570, 1.0, 8), (840, 0.55, 9), (2410, 0.22, 10), (3300, 0.08, 11)],
            "u": [(300, 1.0, 8), (870, 0.4, 9), (2240, 0.16, 10), (3100, 0.06, 11)]}[vowel]
    src = sum(np.sin(2*math.pi*f*h*t + h * 0.7) / (h ** 0.85) for h in range(1, 26))
    sig = np.zeros(n)
    for ff, amp, q in FORM:
        if ff > SR * 0.4: continue
        sig += amp * biquad(src, ff, q, "peaking", gain_db=14)
    vib = 1 + 0.008 * np.sin(2*math.pi*vibrato*t) * np.minimum(1, t / 0.4)
    sig = sig / (len(FORM) * 1.6) * (0.7 + 0.3 * vib)
    sig += biquad(noise(n), 2600, 0.5, "bandpass") * 0.02
    sig = to_stereo(sig * env_adsr(n, 0.06, 0.12, 0.92, 0.3), 0.3)
    return normalize(fade(sig, 256, 1500), -4.0)

# ============================================================== FX / transitions
def riser(dur=2.0, f0=200, f1=7000, noise_amt=0.8):
    n = int((dur + 0.25) * SR); t = t_axis(n); ce = (t / dur) ** 2.0
    sig = svf_tv(noise(n) * noise_amt, 200 + (f1 - 200) * ce, 1.6, "bp")
    sig += phasor(n, f0, f1) * 0.35
    sig *= np.linspace(0.05, 1.0, n) ** 1.6 * env_adhd(n, 0.05, 0.1, 0, dur, 1.2)
    return normalize(fade(to_stereo(sig, 0.5), 64, 300), -3.0)

def downlifter(dur=1.6):
    n = int((dur + 0.4) * SR)
    sig = exp_phasor(n, 900, 45) * 0.7 + svf_tv(noise(n), np.linspace(6000, 250, n), 1.1, "lp") * 0.55
    return normalize(fade(to_stereo(sig * np.exp(-np.linspace(0, 2.2, n)), 0.4), 32, 700), -3.0)

def impact(dur=2.6):
    n = int(dur * SR); t = t_axis(n)
    sig = exp_phasor(n, 140, 32) * np.exp(-np.linspace(0, 3.2, n))
    sig += svf_tv(noise(n), np.linspace(7000, 900, n), 0.7, "lp") * np.exp(-np.linspace(0, 4.5, n)) * 0.8
    for i, f in enumerate((1800, 2450, 3300, 4100)):
        sig += np.sin(2*math.pi*f*t + i) * np.exp(-np.linspace(0, 9, n)) * 0.2
    return normalize(fade(to_stereo(tanh_sat(sig, 2.2), 0.8), 16, 1200), -2.0)

def noise_sweep_down(dur=1.2):
    n = int(dur * SR)
    sig = svf_tv(noise(n), np.linspace(9000, 400, n), 1.3, "bp") * np.exp(-np.linspace(0, 3.0, n))
    return normalize(fade(to_stereo(sig, 0.6), 16, 500), -3.5)

def vinyl_crackle(dur=3.0):
    n = int(dur * SR)
    sig = biquad(noise(n), 400, 0.7, "highpass") * 0.06
    for _ in range(int(dur * 22)):
        ln = int(RNG.integers(30, 180)); p = int(RNG.integers(0, max(1, n - ln)))
        sig[p:p+ln] += noise(ln) * np.exp(-np.linspace(0, 25, ln)) * RNG.uniform(0.15, 0.5)
    sig = biquad(sig + np.sin(2*math.pi*50*t_axis(n)) * 0.012, 9000, 0.6, "lowpass")
    return normalize(to_stereo(sig, 0.35), -12.0)

def impulse_response(dur=2.2, decay=3.0, predelay=0.018, damp=0.5, kind="hall"):
    n = int((dur + predelay) * SR); pd = int(predelay * SR); sig = np.zeros(n)
    m = n - pd
    if kind == "hall":
        sig[pd:] = noise(m) * np.exp(-np.linspace(0, decay, m))
        for dl, g in ((0.029, .5), (0.041, .42), (0.057, .36), (0.073, .3), (0.097, .24), (0.131, .18)):
            o = pd + int(dl * SR)
            if o + 400 < n: sig[o:o+400] += noise(400) * g * np.exp(-np.linspace(0, 20, 400))
    elif kind == "room":
        sig[pd:] = noise(m) * np.exp(-np.linspace(0, decay * 1.8, m))
    elif kind == "plate":
        sig[pd:] = noise(m) * np.exp(-np.linspace(0, decay * 0.8, m)) * 1.2
    else:
        sig[pd:] = noise(m) * np.exp(-np.linspace(0, decay, m))
        for f in (420, 780, 1350):
            sig[pd:] += np.sin(2*math.pi*f*t_axis(m)) * np.exp(-np.linspace(0, 12, m)) * 0.25
    sig = biquad(sig, 9000 * (1 - damp * 0.6), 0.7, "lowpass")
    sig = biquad(sig, 250, 0.7, "highpass")
    return normalize(fade(to_stereo(sig, 0.85), 8, 800), -6.0)

def click_tone(f=1600, dur=0.045):
    n = max(8, int(dur * SR)); t = t_axis(n)
    s = np.sin(2*math.pi*f*t) * np.exp(-np.linspace(0, 32, n))
    s += 0.4 * np.sin(2*math.pi*f*2*t) * np.exp(-np.linspace(0, 45, n))
    return normalize(fade(s, 4, 20), -1.0)

# ============================================================== LOOPS
def loop_len(bars, bpm): return int(round(bars * 4 * 60.0 / bpm * SR))

KITS = {}
def kit_for(name):
    if name in KITS: return KITS[name]
    if name == "acoustic":
        KITS[name] = dict(kick=lambda: kick_acoustic(0.32), snare=lambda: snare(190, .17, .8, 5200),
                          hat=lambda: hat(False, 7200, .045, .8), ohat=lambda: hat(True, 7600, .12, .8),
                          clap=lambda: clap(.22))
    elif name == "trap":
        KITS[name] = dict(kick=lambda: kick_808(130, 42, .4, .85, 2.6, .3), snare=lambda: snare(250, .12, 1.0, 8200),
                          hat=lambda: hat(False, 9200, .03, 1.1), ohat=lambda: hat(True, 8600, .1, 1.0),
                          clap=lambda: clap(.2))
    else:
        KITS[name] = dict(kick=lambda: kick_punch(200, 55, .26, 1.0), snare=lambda: snare(230, .14, .95, 7000),
                          hat=lambda: hat(False, 8600, .035, 1.0), ohat=lambda: hat(True, 8000, .11, 1.0),
                          clap=lambda: clap(.24))
    return KITS[name]

def drum_loop(bpm, bars=2, pattern=None, kit="acoustic", swing=0.0):
    n = loop_len(bars, bpm); step = n // (bars * 16)
    L = np.zeros(n); R = np.zeros(n)
    k = kit_for(kit)
    snd = {key: fn() for key, fn in k.items()}
    pat = pattern or {"kick": [1,0,0,0]*4, "snare": [0,0,0,0,1,0,0,0]*2, "hat": [1,0,1,0]*4}
    for b in range(bars):
        for i in range(16):
            off = int((b * 16 + i) * step + (swing * step * 0.5 if i % 2 else 0))
            if off >= n: continue
            for nm, g, p in (("kick", 1.0, 0.0), ("snare", 0.85, 0.05), ("hat", 0.42, -0.25),
                             ("ohat", 0.40, 0.25), ("clap", 0.70, 0.0)):
                if nm not in pat or not pat[nm][i % 16]: continue
                s = snd[nm]
                if s.ndim == 2: s = s.mean(axis=1)
                e = min(off + len(s), n); seg = s[:e - off]
                L[off:e] += seg * g * (1 - p) * 0.5
                R[off:e] += seg * g * (1 + p) * 0.5
    out = tanh_sat(np.stack([L, R], 1), 1.25)
    return fade(normalize(out, -3.0, rms_db=-13.0), 64, 64)

def bass_loop(bpm, bars=2, root=33, seq=(0, 0, 3, 0, 5, 0, 3, 0), kind="808"):
    n = loop_len(bars, bpm); steps = bars * 8; step = n // steps
    L = np.zeros(n); R = np.zeros(n)
    fn = {"808": lambda m, d: bass_808(m, d, 2.4), "acid": lambda m, d: bass_acid(m, d),
          "pluck": lambda m, d: bass_pluck(m, d), "synth": lambda m, d: bass_synth(m, d)}[kind]
    notes = (list(seq) * bars)[:steps]
    for i, semi in enumerate(notes):
        off = i * step
        if off >= n: break
        s = fn(root + semi, min(step / SR * (0.95 if kind != "pluck" else 1.1), 1.2))
        if s.ndim == 1: s = s[:, None]
        e = min(off + len(s), n)
        L[off:e] += s[:e-off, 0] * 0.9
        R[off:e] += s[:e-off, min(1, s.shape[1]-1)] * 0.9
    return fade(normalize(np.stack([L, R], 1), -2.5, rms_db=-14.0), 64, 64)

def chord_loop(bpm, bars=2, root=57, chords=((0,4,7),(-2,2,5),(3,7,10),(5,9,12)), kind="pad"):
    n = loop_len(bars, bpm); step = n // bars
    L = np.zeros(n); R = np.zeros(n)
    for b, ch in enumerate(chords[:bars]):
        off = b * step
        acc = np.zeros(step + int(0.5 * SR))
        for semi in ch:
            m = root + semi
            if kind == "pad":      s = pad_grain(m, dur=step / SR * 0.9, density=45)
            elif kind == "pluck":  s = pluck_karplus(m, decay=min(1.1, step / SR))
            elif kind == "epiano": s = epiano(m, decay=min(1.6, step / SR * 1.1))
            else:                  s = saw_stack(m, decay=min(1.4, step / SR), voices=4, detune=8)
            if s.ndim == 1: s = s[:, None]
            mm = min(len(s), len(acc))
            acc[:mm] += s[:mm].mean(axis=1) * 0.34
        e = min(off + len(acc), n)
        L[off:e] += acc[:e-off]; R[off:e] += acc[:e-off]
    out = biquad(np.stack([L, R], 1), 9000, 0.7, "lowpass")
    return fade(normalize(out, -3.0, rms_db=-17.0), 256, 256)

def melody_loop(bpm, bars=2, root=69, seq=None, kind="pluck"):
    n = loop_len(bars, bpm); steps = bars * 8; step = n // steps
    L = np.zeros(n); R = np.zeros(n)
    if seq is None:
        seq = [0, 3, 7, 3, 10, 7, 3, 0, 2, 5, 9, 5, 12, 9, 5, 2][:steps]
    for i, semi in enumerate(seq[:steps]):
        if semi is None: continue
        off = i * step
        if off >= n: break
        m = root + semi; d = step / SR
        if kind == "pluck":   s = pluck_karplus(m, decay=min(d * 1.4, 1.0))
        elif kind == "bell":  s = bell_fm(m, decay=min(d * 2, 1.6))
        elif kind == "lead":  s = saw_stack(m, decay=d, voices=3, detune=7)
        else:                 s = sine_lead(m, decay=d * 1.2)
        if s.ndim == 1: s = s[:, None]
        e = min(off + len(s), n)
        L[off:e] += s[:e-off, 0] * 0.8
        R[off:e] += s[:e-off, min(1, s.shape[1]-1)] * 0.8
    return fade(normalize(np.stack([L, R], 1), -3.0, rms_db=-16.0), 64, 64)

def perc_loop(bpm, bars=2):
    n = loop_len(bars, bpm); step = n // (bars * 16)
    L = np.zeros(n); R = np.zeros(n)
    sh, rm, mt, tm, cw = shaker(.11), rim(1700), perc_metallic(2400, .2), tom(140, .3), cowbell(560, .25)
    seq = [(0, sh, .50, -.30), (2, sh, .35, .30), (4, rm, .60, -.20), (6, sh, .40, .35),
           (8, mt, .45, .25), (10, sh, .35, -.30), (11, cw, .30, .10), (12, rm, .60, .20),
           (14, sh, .40, -.35), (15, tm, .50, .15)]
    for b in range(bars):
        for i, s, g, p in seq:
            off = int((b * 16 + i) * step)
            if off >= n: continue
            if s.ndim == 2: s = s.mean(axis=1)
            e = min(off + len(s), n); seg = s[:e-off]
            L[off:e] += seg * g * (1 - p) * 0.5
            R[off:e] += seg * g * (1 + p) * 0.5
    return fade(normalize(np.stack([L, R], 1), -4.0, rms_db=-19.0), 32, 32)

# ============================================================== BUILD ALL
log("drums…")
for i, (fs, fe, dec, cl, dr) in enumerate([(125,45,.62,.85,3.2),(150,50,.50,1.0,2.6),(105,38,.85,.6,3.6),(180,52,.34,1.1,2.2),(95,42,1.1,.5,4.0)]):
    emit("Drums/Kicks", f"808_Kick_{i+1:02d}", kick_808(fs, fe, dec, cl, dr, .4),
         category="Drums", subcategory="Kick", tags=["808","trap","sub","kick"], key=None, bpm=None, loop=False, oneShot=True)
for i, (f0,f1,dec) in enumerate([(200,55,.26),(170,48,.30),(230,62,.20),(150,44,.40)]):
    emit("Drums/Kicks", f"Electro_Kick_{i+1:02d}", kick_punch(f0,f1,dec,1.0),
         category="Drums", subcategory="Kick", tags=["electro","house","punch","kick"], key=None, bpm=None, loop=False, oneShot=True)
for i, dec in enumerate([.30,.40,.50]):
    emit("Drums/Kicks", f"Acoustic_Kick_{i+1:02d}", kick_acoustic(dec),
         category="Drums", subcategory="Kick", tags=["acoustic","live","rock","kick"], key=None, bpm=None, loop=False, oneShot=True)
emit("Drums/Kicks", "Sub_Drop_01", sub_drop(95,28,1.6), category="FX", subcategory="Sub",
     tags=["sub","drop","808","cinematic"], key=None, bpm=None, loop=False, oneShot=True)

for i,(tn,dec,na,br) in enumerate([(190,.17,.80,5200),(230,.13,.95,7000),(255,.11,1.0,8500),(165,.22,.70,4200),(300,.09,.90,9500)]):
    emit("Drums/Snares", f"Snare_{i+1:02d}", snare(tn,dec,na,br),
         category="Drums", subcategory="Snare", tags=["snare","trap" if i>=2 else "acoustic","backbeat"], key=None, bpm=None, loop=False, oneShot=True)
for i,dec in enumerate([.22,.30,.42]):
    emit("Drums/Claps", f"Clap_{i+1:02d}", clap(dec), category="Drums", subcategory="Clap",
         tags=["clap","house","hands"], key=None, bpm=None, loop=False, oneShot=True)
emit("Drums/Snares", "Rimshot_01", rim(1750), category="Drums", subcategory="Rim", tags=["rim","percussion"], key=None, bpm=None, loop=False, oneShot=True)
emit("Drums/Snares", "Rimshot_02", rim(2300), category="Drums", subcategory="Rim", tags=["rim","percussion"], key=None, bpm=None, loop=False, oneShot=True)

for i,(op,tn,dec) in enumerate([(False,8600,.035),(False,9200,.028),(False,7600,.05),(True,8200,.14),(True,7400,.22)]):
    emit("Drums/Hats", f"{'Open' if op else 'Closed'}_Hat_{i+1:02d}", hat(op,tn,dec,1.0),
         category="Drums", subcategory="Open Hat" if op else "Closed Hat",
         tags=["hat","cymbal","trap" if dec<.04 else "house"], key=None, bpm=None, loop=False, oneShot=True)
emit("Drums/Cymbals", "Ride_01", ride(1.8), category="Drums", subcategory="Ride", tags=["ride","cymbal","jazz"], key=None, bpm=None, loop=False, oneShot=True)
for i,dec in enumerate([1.8,2.6,3.4]):
    emit("Drums/Cymbals", f"Crash_{i+1:02d}", crash(dec), category="Drums", subcategory="Crash", tags=["crash","cymbal"], key=None, bpm=None, loop=False, oneShot=True)
emit("Drums/Cymbals", "Reverse_Crash_01", fade(crash(1.6)[::-1].copy(), 8, 8), category="FX", subcategory="Reverse",
     tags=["reverse","crash","transition"], key=None, bpm=None, loop=False, oneShot=True)

for i,f in enumerate([95,130,175]):
    emit("Drums/Toms", f"Tom_{['Low','Mid','High'][i]}", tom(f, .5-i*.08), category="Drums", subcategory="Tom",
         tags=["tom","percussion"], key=None, bpm=None, loop=False, oneShot=True)
for i in range(3):
    emit("Drums/Percussion", f"Shaker_{i+1:02d}", shaker(.1+i*.03), category="Drums", subcategory="Shaker",
         tags=["shaker","percussion","latin"], key=None, bpm=None, loop=False, oneShot=True)
emit("Drums/Percussion", "Cowbell_01", cowbell(540,.35), category="Drums", subcategory="Cowbell",
     tags=["cowbell","percussion","funk"], key=None, bpm=None, loop=False, oneShot=True)
for i,f in enumerate([1800,2600,3600]):
    emit("Drums/Percussion", f"Metal_Perc_{i+1:02d}", perc_metallic(f,.22+i*.06), category="Drums", subcategory="Metal Perc",
         tags=["metal","percussion","industrial"], key=None, bpm=None, loop=False, oneShot=True)

log("bass…")
for semi in (0,3,5,7,10):
    m = 33+semi
    emit("Bass/808", f"808_Bass_{note_name(m)}", bass_808(m, 1.4, 2.6), category="Bass", subcategory="808",
         tags=["808","sub","trap","bass"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)
for semi in (0,3,5,7):
    m = 33+semi
    emit("Bass/Reese", f"Reese_Bass_{note_name(m)}", bass_reese(m, 1.8), category="Bass", subcategory="Reese",
         tags=["reese","dnb","neuro","bass"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)
for semi in (0,5,7,12):
    m = 33+semi
    emit("Bass/FM", f"FM_Bass_{note_name(m)}", bass_fm(m, 1.0), category="Bass", subcategory="FM",
         tags=["fm","synth","bass"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)
for semi in (0,3,7,10):
    m = 33+semi
    emit("Bass/Acid", f"Acid_Bass_{note_name(m)}", bass_acid(m, .7), category="Bass", subcategory="Acid",
         tags=["acid","303","techno","bass"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)
for semi in (0,5,7,12):
    m = 33+semi
    emit("Bass/Pluck", f"Pluck_Bass_{note_name(m)}", bass_pluck(m, .8), category="Bass", subcategory="Pluck",
         tags=["pluck","bass","melodic"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)
for semi in (0,3,7,10):
    m = 33+semi
    emit("Bass/Synth", f"Synth_Bass_{note_name(m)}", bass_synth(m, 1.1), category="Bass", subcategory="Synth",
         tags=["synth","bass","electro"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)

log("leads / keys / pads…")
for semi in (0,2,4,5,7,9,11,12):
    m = 60+semi
    emit("Leads/Saw", f"Saw_Lead_{note_name(m)}", saw_stack(m, 1.1, 5, 11), category="Leads", subcategory="Saw",
         tags=["saw","lead","supersaw","edm"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)
for semi in (0,4,7,12):
    m = 64+semi
    emit("Leads/Square", f"Square_Lead_{note_name(m)}", square_lead(m, .9), category="Leads", subcategory="Square",
         tags=["square","chiptune","lead","retro"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)
for semi in (0,5,7,12):
    m = 69+semi
    emit("Leads/Sine", f"Sine_Lead_{note_name(m)}", sine_lead(m, 1.3), category="Leads", subcategory="Sine",
         tags=["sine","flute","lead","smooth"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)
for semi in (0,7,12,19):
    m = 72+semi
    emit("Keys/Bells", f"Bell_{note_name(m)}", bell_fm(m, 2.4), category="Keys", subcategory="Bell",
         tags=["bell","fm","glass","keys"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)
for semi in (0,4,7,12,16):
    m = 60+semi
    emit("Keys/Pluck", f"Pluck_{note_name(m)}", pluck_karplus(m, .9), category="Keys", subcategory="Pluck",
         tags=["pluck","karplus","string","keys"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)
for semi in (0,4,7,12):
    m = 60+semi
    emit("Keys/EPiano", f"EPiano_{note_name(m)}", epiano(m, 2.0), category="Keys", subcategory="E-Piano",
         tags=["epiano","rhodes","keys","soul"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)
for semi in (0,7,12):
    m = 57+semi
    emit("Keys/Organ", f"Organ_{note_name(m)}", organ(m, 1.4), category="Keys", subcategory="Organ",
         tags=["organ","drawbar","keys","gospel"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)
for semi in (0,5,7,12):
    m = 57+semi
    emit("Pads/Grain", f"Pad_Grain_{note_name(m)}", pad_grain(m, 2.4), category="Pads", subcategory="Granular",
         tags=["pad","granular","ambient","atmos"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)
for semi in (0,4,7):
    m = 60+semi
    emit("Pads/Choir", f"Choir_{note_name(m)}", choir(m, 2.2), category="Pads", subcategory="Choir",
         tags=["choir","vocal","pad","cinematic"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)
for semi in (0,7,12):
    m = 55+semi
    emit("Pads/Strings", f"Strings_{note_name(m)}", strings(m, 2.2), category="Pads", subcategory="Strings",
         tags=["strings","orchestral","pad","cinematic"], key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)

log("vocal tones…")
for v in "aeiou":
    for semi in (0,7):
        m = 62+semi
        emit("Vocal/Vowels", f"Vowel_{v.upper()}_{note_name(m)}", vowel_tone(m, v, 1.5),
             category="Vocal", subcategory="Vowel", tags=["vocal","vowel","formant","synth-voice"],
             key=note_name(m), keyMidi=int(m), bpm=None, loop=False, oneShot=True)

log("FX / transitions / IRs…")
for i,dur in enumerate([1.6,2.4,3.2]):
    emit("FX/Risers", f"Riser_{i+1:02d}", riser(dur), category="FX", subcategory="Riser",
         tags=["riser","build","transition","edm"], key=None, bpm=None, loop=False, oneShot=True)
for i,dur in enumerate([1.2,2.0]):
    emit("FX/Downlifters", f"Downlifter_{i+1:02d}", downlifter(dur), category="FX", subcategory="Downlifter",
         tags=["downlifter","drop","transition"], key=None, bpm=None, loop=False, oneShot=True)
for i,dur in enumerate([2.2,3.2]):
    emit("FX/Impacts", f"Impact_{i+1:02d}", impact(dur), category="FX", subcategory="Impact",
         tags=["impact","cinematic","hit","trailer"], key=None, bpm=None, loop=False, oneShot=True)
emit("FX/Sweeps", "Noise_Sweep_Down_01", noise_sweep_down(1.4), category="FX", subcategory="Sweep",
     tags=["sweep","noise","transition"], key=None, bpm=None, loop=False, oneShot=True)
emit("FX/Textures", "Vinyl_Crackle_01", vinyl_crackle(4.0), category="FX", subcategory="Texture",
     tags=["vinyl","crackle","lofi","texture"], key=None, bpm=None, loop=True, loopBeats=0, oneShot=False)
for kind,dur,dec in (("Hall",2.8,3.2),("Room",0.9,4.5),("Plate",1.8,3.6),("Spring",2.0,4.0),("Cathedral",4.5,2.2)):
    emit("FX/Impulses", f"IR_{kind}", impulse_response(dur,dec,.02,.5,kind.lower()), category="FX", subcategory="Impulse Response",
         tags=["ir","reverb",kind.lower(),"convolution"], key=None, bpm=None, loop=False, oneShot=True, isIR=True)
emit("Utility", "Metronome_Accent", click_tone(2100,.05), category="Utility", subcategory="Metronome",
     tags=["metronome","click","utility"], key=None, bpm=None, loop=False, oneShot=True, isUtility=True)
emit("Utility", "Metronome_Beat", click_tone(1350,.04), category="Utility", subcategory="Metronome",
     tags=["metronome","click","utility"], key=None, bpm=None, loop=False, oneShot=True, isUtility=True)

log("loops…")
PATTERNS = {
 "House": {"kick":[1,0,0,0]*4, "snare":[0]*16, "clap":[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], "hat":[0,0,1,0]*4, "ohat":[0,0,0,0,0,0,1,0]*2},
 "Trap":  {"kick":[1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0], "snare":[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], "hat":[1,1,0,1,1,0,1,1,0,1,1,0,1,0,1,1], "ohat":[0]*16},
 "Rock":  {"kick":[1,0,0,0,0,0,1,0,1,0,0,0,0,0,0,0], "snare":[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], "hat":[1,0,1,0]*4, "ohat":[0]*16},
 "DnB":   {"kick":[1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0], "snare":[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,1], "hat":[1,1,1,0,1,1,1,0]*2, "ohat":[0]*16},
}
KITMAP = {"House":"electro","Trap":"trap","Rock":"acoustic","DnB":"electro"}
BPM_STYLE = {"House":[124,140], "Trap":[90,140], "Rock":[90,124], "DnB":[174]}
for bpm in (90,124,140,174):
    for pname, pat in PATTERNS.items():
        if bpm not in BPM_STYLE[pname]: continue
        emit("Loops/Drums", f"{pname}_Drums_{bpm}bpm_2bar", drum_loop(bpm, 2, pat, KITMAP[pname], .12 if pname=="House" else 0),
             category="Loops", subcategory="Drum Loop", tags=["loop","drums",pname.lower(),f"{bpm}bpm"],
             key=None, bpm=bpm, loop=True, loopBeats=8, oneShot=False)
    for kind in ("808","acid","pluck","synth"):
        emit("Loops/Bass", f"{kind.capitalize()}_Bass_Loop_{bpm}bpm_2bar", bass_loop(bpm, 2, 33, kind=kind),
             category="Loops", subcategory="Bass Loop", tags=["loop","bass",kind.lower(),f"{bpm}bpm"],
             key="A1", bpm=bpm, loop=True, loopBeats=8, oneShot=False)
    for kind in ("pad","pluck","epiano","saw"):
        emit("Loops/Chords", f"{kind.capitalize()}_Chords_{bpm}bpm_2bar", chord_loop(bpm, 2, 57, kind=kind),
             category="Loops", subcategory="Chord Loop", tags=["loop","chords",kind,f"{bpm}bpm"],
             key="A3", bpm=bpm, loop=True, loopBeats=8, oneShot=False)
    for kind in ("pluck","bell","lead","sine"):
        emit("Loops/Melody", f"{kind.capitalize()}_Melody_{bpm}bpm_2bar", melody_loop(bpm, 2, 69, kind=kind),
             category="Loops", subcategory="Melody Loop", tags=["loop","melody",kind,f"{bpm}bpm"],
             key="A4", bpm=bpm, loop=True, loopBeats=8, oneShot=True)
    emit("Loops/Percussion", f"Percussion_Loop_{bpm}bpm_2bar", perc_loop(bpm, 2),
         category="Loops", subcategory="Perc Loop", tags=["loop","percussion","latin",f"{bpm}bpm"],
         key=None, bpm=bpm, loop=True, loopBeats=8, oneShot=False)

# ============================================================== MANIFEST
packs = {}
for e in LIB:
    p = e["pack"].split("/")[0]
    d = packs.setdefault(p, {"name": p, "count": 0, "bytes": 0})
    d["count"] += 1; d["bytes"] += e["bytes"]

manifest = {
    "name": "QwenWave Factory Library", "version": "1.0.0", "generated": "2026-10-27",
    "sampleRate": SR, "totalSamples": len(LIB), "totalBytes": _bytes,
    "license": "Royalty-free — bake of the QwenWave DAW factory library. Use freely in your music.",
    "packs": packs, "categories": sorted({e["category"] for e in LIB}),
    "subcategories": sorted({e.get("subcategory","") for e in LIB}),
    "samples": LIB,
}
os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
with open(MANIFEST, "w") as f:
    json.dump(manifest, f, separators=(",", ":"), allow_nan=False)

log(f"DONE: {len(LIB)} samples, {_bytes/1e6:.2f} MB -> library/")
