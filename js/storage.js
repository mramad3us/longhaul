// ============================================================
// LONGHAUL — IndexedDB storage
// Saves: { id, name, timestamp, version, meta, data (JSON string) }.
// Legacy v0.7 records carry `state` (a structured clone) instead.
// ============================================================

const DB_NAME = 'longhaul_db';
const DB_VERSION = 1;
const SAVES = 'saves';
const SETTINGS = 'settings';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SAVES)) {
        const s = db.createObjectStore(SAVES, { keyPath: 'id' });
        s.createIndex('timestamp', 'timestamp', { unique: false });
        s.createIndex('name', 'name', { unique: false });
      }
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function putSave({ id, name, version, meta, data }) {
  const record = { id, name, timestamp: Date.now(), version, meta, data };
  await run(SAVES, 'readwrite', s => s.put(record));
  return record;
}

export const getSave = (id) => run(SAVES, 'readonly', s => s.get(id));
export const deleteSave = (id) => run(SAVES, 'readwrite', s => s.delete(id));

/** All saves, newest first, without their (large) payloads. */
export async function listSaves() {
  const all = await run(SAVES, 'readonly', s => s.getAll());
  return (all || [])
    .map(r => ({
      id: r.id, name: r.name, timestamp: r.timestamp, version: r.version,
      meta: r.meta || { ship: r.state?.ship?.name, legacy: true },
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

export async function saveSetting(key, value) {
  await run(SETTINGS, 'readwrite', s => s.put({ key, value }));
}

export async function loadSettings() {
  const all = await run(SETTINGS, 'readonly', s => s.getAll());
  const out = {};
  for (const { key, value } of all || []) out[key] = value;
  return out;
}

export const initStorage = openDB;
