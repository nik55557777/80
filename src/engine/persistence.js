/**
 * QwenWave — project persistence.
 *
 * Three levels:
 *   • Session autosave → IndexedDB (survives reload / crash)
 *   • .qwp file       → JSON project + embedded user recordings (portable)
 *   • .qwpz bundle    → ZIP with project.json + every referenced sample,
 *                        so a project can be moved between machines
 */
import Store, { Bus, TOPICS, uid, clamp } from '../core/store.js';
import Engine from './engine.js';
import Library, { ProjectStore, computePeaks } from './library.js';
import { idbPut } from './db.js';
import Transport from './transport.js';
import { encodeWav, downloadBlob, safeName } from './exporter.js';

const AUTOSAVE_MS = 45000;
const AUTOSAVE_KEY = 'autosave';

/* ------------------------------------------------------------------- save */
export function serialiseProject(project = Store.project) {
  const p = JSON.parse(JSON.stringify(project));
  p.modified = Date.now();
  p.engine = { version: 3, sampleRate: Engine.sampleRate };
  return p;
}

export async function saveToSession(id = Store.project.id || 'current') {
  Store.project.id = id;
  const data = serialiseProject();
  await ProjectStore.save(id, data.name, data);
  Store.dirty = false;
  Bus.emit(TOPICS.PROJECT, { saved: id });
  return id;
}

export async function saveAs(name) {
  Store.project.name = name || Store.project.name;
  const id = Store.project.id || uid('prj');
  return saveToSession(id);
}

export function newProject(name = 'Untitled Project', { bpm = 120, ts = [4, 4] } = {}) {
  const prev = Store.project;
  const fresh = {
    ...JSON.parse(JSON.stringify({ ...defaultBlank(), name, bpm, timeSignature: ts })),
    id: uid('prj'),
  };
  Store.project = fresh;
  Store.position = 0;
  Transport.stop();
  Engine.graphs.forEach((g, id) => Engine.disposeTrack(id));
  Store.clearHistory();
  Bus.emit(TOPICS.PROJECT, { reason: 'new' });
  Bus.emit(TOPICS.TRACKS, { reason: 'new' });
  return fresh;
}

function defaultBlank() {
  return {
    version: 3, name: 'Untitled Project', bpm: 120, timeSignature: [4, 4],
    key: { root: 0, scale: 'minor' }, length: 32, swing: 0, quantize: 1 / 4,
    created: Date.now(), modified: Date.now(), tracks: [], buses: [],
    master: { volumeDb: 0, fx: [], limiterCeilDb: -0.3, mastering: { enabled: false, preset: 'balanced', amount: 0.6 } },
    metronome: { enabled: false, volume: 0.5, countIn: 0 },
    view: { pxPerBeat: 60, snap: 1 / 4, follow: true },
    selection: { trackId: null, clipId: null },
  };
}

/* ------------------------------------------------------------------- load */
export async function loadFromSession(id) {
  const data = await ProjectStore.get(id);
  if (!data) throw new Error('Project not found');
  return applyProject(data);
}

export async function loadAutosave() {
  try {
    const data = await ProjectStore.get(AUTOSAVE_KEY);
    if (data && data.tracks?.length) return data;
  } catch {}
  return null;
}

export function applyProject(data) {
  const migrated = migrate(data);
  Transport.stop();
  for (const [, g] of Engine.graphs) {
    for (const n of [g.input, g.pan, g.trim, g.out, g.meter]) { try { n?.disconnect(); } catch {} }
  }
  Engine.graphs.clear();
  Engine.voices.clear();
  Store.project = migrated;
  Store.position = 0;
  Store.clearHistory();
  for (const t of migrated.tracks) Engine.applyTrackState(t);
  Engine.applyMasterSettings();
  Transport.invalidate();
  Bus.emit(TOPICS.PROJECT, { reason: 'load' });
  Bus.emit(TOPICS.TRACKS, { reason: 'load' });
  Bus.emit(TOPICS.MIXER, { reason: 'load' });
  Bus.emit(TOPICS.TEMPO, { bpm: migrated.bpm });
  Bus.emit(TOPICS.STATUS, { text: `Loaded "${migrated.name}"` });
  // warm the cache so playback never waits on decode
  Library.preloadProject(migrated).catch(() => {});
  return migrated;
}

/** Forward-compat migrations; keeps old sessions loadable. */
function migrate(data) {
  const base = defaultBlank();
  const p = { ...base, ...data };
  p.master = { ...base.master, ...(data.master || {}) };
  p.master.mastering = { ...base.master.mastering, ...(data.master?.mastering || {}) };
  p.metronome = { ...base.metronome, ...(data.metronome || {}) };
  p.view = { ...base.view, ...(data.view || {}) };
  p.key = { ...base.key, ...(data.key || {}) };
  p.timeSignature = Array.isArray(data.timeSignature) ? data.timeSignature : [4, 4];
  p.bpm = clamp(+data.bpm || 120, 20, 400);
  p.tracks = (data.tracks || []).map(t => ({
    ...t,
    fx: t.fx || [], clips: t.clips || [], sends: t.sends || [], automation: t.automation || [],
    instrument: { ...base.tracks?.instrument, ...(t.instrument || {}) },
    input: { gain: 1, hpz: 80, ...(t.input || {}) },
    pitchCorrection: { enabled: false, scale: 'minor', root: 0, strength: 1, quantize: true, ...(t.pitchCorrection || {}) },
  }));
  for (const t of p.tracks) for (const c of t.clips) {
    c.trackId = t.id;
    if (c.type === 'midi' && !Array.isArray(c.notes)) c.notes = [];
    if (c.type === 'midi') for (const n of c.notes) if (!n.id) n.id = uid('n');
  }
  if (!p.id) p.id = uid('prj');
  return p;
}

/* --------------------------------------------------------- .qwp (JSON) */
export async function exportProjectFile() {
  const data = serialiseProject();
  // embed user recordings so the file is portable
  data.embedded = {};
  const ids = referencedSampleIds(data);
  for (const id of ids) {
    const s = Library.get(id);
    if (!s?.isUser) continue;
    try {
      const buf = await Library.getBuffer(id);
      const blob = encodeWav(buf, { bits: 16, dither: false });
      data.embedded[id] = { meta: stripAudio(s), b64: await blobToBase64(blob) };
    } catch (e) { console.warn('embed failed', id, e); }
  }
  const json = JSON.stringify(data);
  const blob = new Blob([json], { type: 'application/json' });
  downloadBlob(blob, `${safeName(data.name)}.qwp`);
  Bus.emit(TOPICS.TOAST, { kind: 'success', text: `Проект сохранён: ${safeName(data.name)}.qwp (${(json.length / 1e6).toFixed(2)} MB)` });
  return blob;
}

export async function importProjectFile(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (data.embedded) {
    for (const [id, e] of Object.entries(data.embedded)) {
      try {
        const bin = base64ToBytes(e.b64);
        const rec = { ...e.meta, id, data: bin.buffer, isUser: true };
        await idbPut('samples', rec);
        Library._addSample({ ...e.meta, id, isUser: true }, true);
      } catch (err) { console.warn('restore sample failed', id, err); }
    }
  }
  return applyProject(data);
}

/* ------------------------------------------------- .qwpz bundle (ZIP) */
export async function exportProjectBundle(onProgress) {
  const data = serialiseProject();
  const ids = referencedSampleIds(data);
  const files = [['project.json', JSON.stringify(data, null, 1)]];
  let i = 0;
  for (const id of ids) {
    i++;
    onProgress?.(i / Math.max(1, ids.length), `Packing sample ${i}/${ids.length}`);
    const s = Library.get(id);
    if (!s) continue;
    try {
      if (s.isUser) {
        const buf = await Library.getBuffer(id);
        files.push([`samples/${s.name}.wav`, new Uint8Array(await encodeWav(buf, { bits: 16, dither: false }).arrayBuffer())]);
      } else {
        const r = await fetch(`library/packs/${s.file}`, { cache: 'force-cache' });
        if (r.ok) files.push([`samples/${s.file}`, new Uint8Array(await r.arrayBuffer())]);
      }
      files.push([`samples/${id}.json`, JSON.stringify(stripAudio(s))]);
    } catch (e) { console.warn('bundle sample failed', id, e); }
  }
  const zip = buildZip(files);
  downloadBlob(zip, `${safeName(data.name)}.qwpz`);
  Bus.emit(TOPICS.TOAST, { kind: 'success', text: `Бандл проекта сохранён (${(zip.size / 1e6).toFixed(1)} MB)` });
  return zip;
}

export async function importProjectBundle(file) {
  const { files } = await readZip(file);
  const pj = files.find(f => f.name.endsWith('project.json'));
  if (!pj) throw new Error('project.json not found in bundle');
  const data = JSON.parse(new TextDecoder().decode(pj.data));
  // restore samples
  for (const f of files) {
    if (!/^samples\//.test(f.name)) continue;
    if (!/\.wav$/i.test(f.name)) continue;
    const id = f.name.split('/').pop().replace(/\.wav$/i, '');
    const metaFile = files.find(x => x.name === `samples/${id}.json`);
    const meta = metaFile ? JSON.parse(new TextDecoder().decode(metaFile.data)) : { name: id };
    try {
      const rec = { ...meta, id: meta.id || id, data: f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength), isUser: true };
      await idbPut('samples', rec);
      if (!Library.get(rec.id)) Library._addSample({ ...meta, id: rec.id, isUser: true }, true);
    } catch (e) { console.warn('bundle sample restore failed', f.name, e); }
  }
  return applyProject(data);
}

/* ------------------------------------------------------------------ utils */
function referencedSampleIds(project) {
  const ids = new Set();
  for (const t of project.tracks) {
    for (const c of t.clips) if (c.sampleId) ids.add(c.sampleId);
    if (t.instrument?.sampleId) ids.add(t.instrument.sampleId);
  }
  return [...ids];
}
function stripAudio(s) { const o = { ...s }; delete o.data; delete o.peaks; return o; }

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}



/* ---------------------------------------------------------- minimal ZIP out */
function buildZip(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = content instanceof Uint8Array ? content : enc.encode(content);
    const nameB = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameB.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true); // stored
    dv.setUint16(10, 0, true); dv.setUint16(12, 0, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameB.length, true); dv.setUint16(28, 0, true);
    local.set(nameB, 30);
    chunks.push(local, data);
    const c = new Uint8Array(46 + nameB.length);
    const cd = new DataView(c.buffer);
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint16(8, 0, true); cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true); cd.setUint16(14, 0, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameB.length, true);
    cd.setUint32(42, offset, true);
    c.set(nameB, 46);
    central.push(c);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const ed = new DataView(eocd.buffer);
  ed.setUint32(0, 0x06054b50, true);
  ed.setUint16(8, files.length, true); ed.setUint16(10, files.length, true);
  ed.setUint32(12, centralSize, true); ed.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, eocd], { type: 'application/zip' });
}

let _crcTable = null;
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      _crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function readZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lNameLen = dv.getUint16(lho + 26, true), lExtraLen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflate(raw);
    else throw new Error('Unsupported zip method ' + method);
    files.push({ name, data });
  }
  return { files };
}
async function inflate(raw) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([raw]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ------------------------------------------------------------- autosave */
export function startAutosave() {
  setInterval(async () => {
    if (!Store.dirty) return;
    try {
      await ProjectStore.save(AUTOSAVE_KEY, `Autosave — ${Store.project.name}`, serialiseProject());
      Store.dirty = false;
      Bus.emit(TOPICS.STATUS, { text: 'Autosaved' });
    } catch (e) { console.warn('autosave failed', e); }
  }, AUTOSAVE_MS);
  window.addEventListener('beforeunload', () => {
    if (Store.dirty) {
      try { ProjectStore.save(AUTOSAVE_KEY, `Autosave — ${Store.project.name}`, serialiseProject()); } catch {}
    }
  });
}

export function markDirty() {
  Store.dirty = true;
  Bus.emit(TOPICS.PROJECT, { dirty: true });
}

export default { saveToSession, saveAs, newProject, loadFromSession, loadAutosave, applyProject,
  exportProjectFile, importProjectFile, exportProjectBundle, importProjectBundle, startAutosave, markDirty };
