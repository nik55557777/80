/**
 * QwenWave — Sample Library manager.
 *
 * The factory library ships as real WAV assets in library/packs/**.
 * On first run the manifest is cached in IndexedDB; decoded AudioBuffers are
 * cached lazily (only samples the user actually touches) and evicted with an
 * LRU so a 500-sample session never blows up RAM.
 *
 * Users can import their own samples/packs — they're stored in the same
 * IndexedDB and show up next to the factory content.
 */
import { Bus, TOPICS, uid } from '../core/store.js';
import { idbGet, idbAll, idbPut, idbDel, idbClear,
  S_MANIFEST, S_BUFFERS, S_SAMPLES, S_PROJECTS } from './db.js';

/* ------------------------------------------------------------------ LRU */
class LRU {
  constructor(maxBytes) { this.max = maxBytes; this.map = new Map(); this.bytes = 0; }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k); this.map.delete(k); this.map.set(k, v);
    return v;
  }
  set(k, v, size) {
    if (this.map.has(k)) this.bytes -= this.map.get(k).__size || 0;
    v.__size = size;
    this.map.set(k, v); this.bytes += size;
    while (this.bytes > this.max && this.map.size > 1) {
      const first = this.map.keys().next().value;
      this.bytes -= this.map.get(first).__size || 0;
      this.map.delete(first);
    }
  }
  has(k) { return this.map.has(k); }
  delete(k) { if (this.map.has(k)) { this.bytes -= this.map.get(k).__size || 0; this.map.delete(k); } }
  clear() { this.map.clear(); this.bytes = 0; }
  get size() { return this.map.size; }
}

const BUFFER_CACHE_BYTES = 260 * 1024 * 1024;   // 260 MB of decoded audio max
const PEAK_CACHE = new LRU(40 * 1024 * 1024);

export class SampleLibrary {
  constructor() {
    this.samples = [];
    this.byName = new Map();
    this.byId = new Map();
    this.packs = {};
    this.meta = {};
    this.buffers = new LRU(BUFFER_CACHE_BYTES);
    this.ready = false;
    this.loading = new Map();
    this._ctx = null;
    this.userPacks = [];
    this.progress = { loaded: 0, total: 0 };
  }

  setContext(ctx) { this._ctx = ctx; }

  /* --------------------------------------------------------------- index */
  async load() {
    if (this.ready) return this;
    Bus.emit(TOPICS.STATUS, { text: 'Loading sample library…' });
    let manifest = await idbGet(S_MANIFEST, 'factory');
    const fresh = await this._fetchManifest();
    if (fresh && (!manifest || manifest.version !== fresh.version || manifest.totalSamples !== fresh.totalSamples)) {
      manifest = { id: 'factory', ...fresh };
      await idbPut(S_MANIFEST, manifest);
    }
    if (!manifest) {
      manifest = await idbGet(S_MANIFEST, 'factory');
    }
    if (manifest) this._ingest(manifest);

    // user samples
    const user = await idbAll(S_SAMPLES);
    for (const u of user) this._addSample(u, true);

    this.ready = true;
    Bus.emit(TOPICS.LIBRARY, { count: this.samples.length });
    Bus.emit(TOPICS.STATUS, { text: `Library ready — ${this.samples.length} samples` });
    return this;
  }

  async _fetchManifest() {
    try {
      const r = await fetch('library/manifest.json', { cache: 'force-cache' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  _ingest(manifest) {
    this.meta = manifest;
    this.packs = manifest.packs || {};
    for (const s of manifest.samples || []) this._addSample(s, false);
  }

  _addSample(s, isUser) {
    if (this.byId.has(s.id)) return;
    s.isUser = !!isUser;
    this.samples.push(s);
    this.byId.set(s.id, s);
    if (s.name) this.byName.set(s.name, s);
  }

  /* --------------------------------------------------------------- query */
  get(idOrName) { return this.byId.get(idOrName) || this.byName.get(idOrName) || null; }

  search(q = '', filters = {}) {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const s of this.samples) {
      if (filters.category && s.category !== filters.category) continue;
      if (filters.subcategory && s.subcategory !== filters.subcategory) continue;
      if (filters.pack && s.pack !== filters.pack) continue;
      if (filters.key && s.key && s.key !== filters.key) continue;
      if (filters.bpm) {
        if (!s.bpm) continue;
        const b = filters.bpm;
        const ok = Math.abs(s.bpm - b) < 0.5 || Math.abs(s.bpm * 2 - b) < 0.5 || Math.abs(s.bpm / 2 - b) < 0.5;
        if (!ok) continue;
      }
      if (filters.loop === true && !s.loop) continue;
      if (filters.loop === false && s.loop) continue;
      if (filters.oneShot === true && !s.oneShot) continue;
      if (terms.length) {
        const hay = `${s.name} ${s.pack} ${s.category} ${s.subcategory} ${(s.tags || []).join(' ')} ${s.key || ''} ${s.bpm || ''}`.toLowerCase();
        if (!terms.every(t => hay.includes(t))) continue;
      }
      out.push(s);
    }
    return out;
  }

  categories() {
    const m = new Map();
    for (const s of this.samples) {
      const c = m.get(s.category) || { name: s.category, count: 0, subs: new Map() };
      c.count++;
      const sub = c.subs.get(s.subcategory || 'Other') || { name: s.subcategory || 'Other', count: 0 };
      sub.count++; c.subs.set(sub.name, sub);
      m.set(s.category, c);
    }
    return [...m.values()].map(c => ({ ...c, subs: [...c.subs.values()] }));
  }

  /* --------------------------------------------------------- decode/load */
  async getBuffer(sampleId) {
    const s = this.get(sampleId);
    if (!s) throw new Error(`Unknown sample: ${sampleId}`);
    const cached = this.buffers.get(s.id);
    if (cached) return cached;
    if (this.loading.has(s.id)) return this.loading.get(s.id);

    const p = (async () => {
      let ab = null;
      if (s.isUser) {
        const rec = await idbGet(S_SAMPLES, s.id);
        ab = rec?.data;
      } else {
        // try decoded cache first
        const c = await idbGet(S_BUFFERS, s.id);
        if (c?.buffer) ab = c.buffer;
        else {
          const r = await fetch(`library/packs/${s.file}`, { cache: 'force-cache' });
          if (!r.ok) throw new Error(`Failed to load ${s.file} (${r.status})`);
          ab = await r.arrayBuffer();
        }
      }
      if (!ab) throw new Error('No audio data');
      const ctx = this._ctx || (await import('./engine.js')).default.ctx;
      if (!ctx) throw new Error('Audio context not ready');
      const buf = await ctx.decodeAudioData(ab.slice(0));
      this.buffers.set(s.id, buf, buf.length * buf.numberOfChannels * 4);
      return buf;
    })();
    this.loading.set(s.id, p);
    try { return await p; } finally { this.loading.delete(s.id); }
  }

  async getAudioBufferByName(name) {
    const s = this.byName.get(name);
    if (!s) return null;
    try { return await this.getBuffer(s.id); } catch { return null; }
  }

  /** Cheap peak data for waveforms (from manifest when available). */
  getPeaks(sampleId, n = 256) {
    const key = `${sampleId}:${n}`;
    const c = PEAK_CACHE.get(key);
    if (c) return c;
    const s = this.get(sampleId);
    let p = s?.peaks;
    if (!p) return null;
    if (p.length !== n) {
      // resample the peak array
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.floor((i / n) * p.length), b = Math.max(a + 1, Math.floor(((i + 1) / n) * p.length));
        let m = 0;
        for (let j = a; j < b && j < p.length; j++) m = Math.max(m, p[j]);
        out[i] = m;
      }
      p = out;
    }
    PEAK_CACHE.set(key, p, n * 4);
    return p;
  }

  /* ------------------------------------------------------------- imports */
  /**
   * Import user audio files (wav/mp3/ogg/flac/aif). Files are stored in
   * IndexedDB so projects referencing them keep working across sessions.
   */
  async importFiles(fileList, packName = 'My Samples') {
    const files = [...fileList].filter(f => /\.(wav|mp3|ogg|oga|flac|m4a|aac|aif|aiff|webm)$/i.test(f.name) || f.type.startsWith('audio'));
    const ctx = this._ctx || (await import('./engine.js')).default.ctx;
    if (!ctx) throw new Error('Audio engine not initialised');
    const added = [];
    let i = 0;
    for (const f of files) {
      i++;
      Bus.emit(TOPICS.STATUS, { text: `Importing ${i}/${files.length}: ${f.name}` });
      try {
        const data = await f.arrayBuffer();
        const buf = await ctx.decodeAudioData(data.slice(0));
        const name = f.name.replace(/\.[^.]+$/, '');
        const peaks = computePeaks(buf, 128);
        const rec = {
          id: uid('usmp'), name, pack: packName, file: name, category: 'My Samples',
          subcategory: guessSub(name, packName), tags: guessTags(name, packName),
          duration: +buf.duration.toFixed(4), channels: buf.numberOfChannels,
          sampleRate: buf.sampleRate, bytes: data.byteLength, isUser: true,
          rms: rmsDb(buf), peaks, key: guessKey(name), bpm: guessBpm(name),
          loop: /loop/i.test(name), oneShot: !/loop/i.test(name),
          data,
        };
        await idbPut(S_SAMPLES, rec);
        const meta = { ...rec }; delete meta.data;
        this._addSample(meta, true);
        this.buffers.set(rec.id, buf, buf.length * buf.numberOfChannels * 4);
        added.push(meta);
      } catch (e) {
        console.warn('import failed', f.name, e);
        Bus.emit(TOPICS.TOAST, { kind: 'error', text: `Не удалось импортировать ${f.name}` });
      }
    }
    Bus.emit(TOPICS.LIBRARY, { added: added.length });
    Bus.emit(TOPICS.STATUS, { text: `Imported ${added.length} sample(s)` });
    return added;
  }

  async deleteSample(id) {
    const s = this.get(id);
    if (!s || !s.isUser) return false;
    await idbDel(S_SAMPLES, id);
    this.buffers.delete(id);
    this.byId.delete(id); this.byName.delete(s.name);
    const i = this.samples.indexOf(s); if (i >= 0) this.samples.splice(i, 1);
    Bus.emit(TOPICS.LIBRARY, { removed: id });
    return true;
  }

  async renamePack(oldName, newName) {
    const all = await idbAll(S_SAMPLES);
    for (const s of all) if (s.pack === oldName) { s.pack = newName; await idbPut(S_SAMPLES, s); }
    for (const s of this.samples) if (s.pack === oldName) s.pack = newName;
    Bus.emit(TOPICS.LIBRARY, {});
  }

  /* -------------------------------------------------------- cache control */
  async preload(ids) {
    await Promise.all(ids.map(id => this.getBuffer(id).catch(() => null)));
  }
  /** Preload everything a project needs before playback for glitch-free starts. */
  async preloadProject(project) {
    const ids = new Set();
    for (const t of project.tracks) {
      for (const c of t.clips) if (c.type === 'audio' && c.sampleId) ids.add(c.sampleId);
      if (t.type === 'midi' && t.instrument?.sampleId) ids.add(t.instrument.sampleId);
      for (const f of t.fx) if (f.type === 'reverb' && f.params?.ir) {
        const s = this.byName.get(f.params.ir); if (s) ids.add(s.id);
      }
    }
    this.progress = { loaded: 0, total: ids.size };
    for (const id of ids) {
      await this.getBuffer(id).catch(() => null);
      this.progress.loaded++;
      Bus.emit(TOPICS.STATUS, { text: `Preloading samples ${this.progress.loaded}/${this.progress.total}` });
    }
    Bus.emit(TOPICS.STATUS, { text: 'Samples ready' });
  }
  get cacheInfo() {
    return { decoded: this.buffers.size, mb: (this.buffers.bytes / 1e6).toFixed(1),
      maxMb: (BUFFER_CACHE_BYTES / 1e6).toFixed(0), totalSamples: this.samples.length };
  }
}

export function computePeaks(buf, n = 256) {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const out = new Array(n).fill(0);
  const chunk = Math.max(1, Math.floor(len / n));
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let m = 0;
    const a = i * chunk, b = Math.min(len, a + chunk);
    for (let c = 0; c < ch; c++) {
      const d = data[c];
      for (let j = a; j < b; j += 4) { const v = Math.abs(d[j]); if (v > m) m = v; }
    }
    out[i] = +m.toFixed(4);
  }
  return out;
}

function rmsDb(buf) {
  let s = 0, n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i += 8) { s += d[i] * d[i]; n++; }
  }
  return +(20 * Math.log10(Math.sqrt(s / Math.max(1, n)) + 1e-12)).toFixed(2);
}

const KEY_RE = /(?:^|[_\-\s])([A-G][#b]?)(?:[\s_\-]*(maj|min|m|major|minor))?/i;
function guessKey(name) {
  const m = name.match(KEY_RE);
  return m ? `${m[1].toUpperCase()}${m[2] || ''}` : null;
}
function guessBpm(name) {
  const m = name.match(/(\d{2,3})\s*(?:bpm|BPM)/);
  return m ? +m[1] : null;
}
function guessSub(name, pack) {
  const n = name.toLowerCase();
  if (/kick|bd|808/.test(n)) return 'Kick';
  if (/snare|sd/.test(n)) return 'Snare';
  if (/hat|hh/.test(n)) return 'Hat';
  if (/clap/.test(n)) return 'Clap';
  if (/bass|sub/.test(n)) return 'Bass';
  if (/loop/.test(n)) return 'Loop';
  if (/vox|vocal|voice/.test(n)) return 'Vocal';
  return pack || 'Samples';
}
function guessTags(name, pack) {
  const t = [pack.toLowerCase(), 'user'];
  for (const w of name.toLowerCase().split(/[^a-z0-9]+/)) if (w.length > 2) t.push(w);
  return [...new Set(t)];
}

/* ------------------------------------------------------------ project store */
export const ProjectStore = {
  async list() {
    const all = await idbAll(S_PROJECTS);
    return all.map(p => ({ id: p.id, name: p.name, modified: p.modified, bpm: p.data?.bpm, size: p.size || 0 }))
      .sort((a, b) => (b.modified || 0) - (a.modified || 0));
  },
  async save(id, name, data) {
    const json = JSON.stringify(data);
    const rec = { id, name, modified: Date.now(), size: json.length, data };
    await idbPut(S_PROJECTS, rec);
    return rec;
  },
  async get(id) { const r = await idbGet(S_PROJECTS, id); return r?.data || null; },
  async remove(id) { await idbDel(S_PROJECTS, id); },
  async clear() { await idbClear(S_PROJECTS); },
};

export const Library = new SampleLibrary();
export default Library;
