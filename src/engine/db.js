/**
 * QwenWave — single IndexedDB access point.
 * One database, one version, every object store declared here so no module can
 * open the DB before a store exists (the classic "object store not found").
 */
export const DB_NAME = 'qwenwave';
export const DB_VERSION = 3;
export const STORES = ['manifest', 'buffers', 'samples', 'projects', 'plugins'];

export const S_MANIFEST = 'manifest';
export const S_BUFFERS = 'buffers';
export const S_SAMPLES = 'samples';
export const S_PROJECTS = 'projects';
export const S_PLUGINS = 'plugins';

let _dbp = null;
export function openDB() {
  if (_dbp) return _dbp;
  _dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES)
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { try { db.close(); } catch {} _dbp = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked — close other QwenWave tabs'));
  });
  return _dbp;
}

/** Run a transaction; `fn(objectStore)` may return an IDBRequest. */
export function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(store, mode); }
    catch (e) { reject(e); return; }
    const os = t.objectStore(store);
    let req;
    try { req = fn(os); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : true);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('tx aborted'));
  }));
}

export const idbGet = (store, key) => tx(store, 'readonly', os => os.get(key));
export const idbAll = (store) => tx(store, 'readonly', os => os.getAll());
export const idbPut = (store, value) => tx(store, 'readwrite', os => os.put(value));
export const idbDel = (store, key) => tx(store, 'readwrite', os => os.delete(key));
export const idbClear = (store) => tx(store, 'readwrite', os => os.clear());
export const idbKeys = (store) => tx(store, 'readonly', os => os.getAllKeys());

export default { openDB, tx, idbGet, idbAll, idbPut, idbDel, idbClear, idbKeys,
  DB_NAME, DB_VERSION, STORES, S_MANIFEST, S_BUFFERS, S_SAMPLES, S_PROJECTS, S_PLUGINS };
