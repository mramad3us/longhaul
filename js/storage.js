// ============================================================
// LONGHAUL — IndexedDB Storage Layer
// Persistent save game storage for the long haul
// ============================================================

const DB_NAME = 'longhaul_db';
const DB_VERSION = 1;
const STORE_SAVES = 'saves';
const STORE_SETTINGS = 'settings';

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const database = e.target.result;

      if (!database.objectStoreNames.contains(STORE_SAVES)) {
        const saveStore = database.createObjectStore(STORE_SAVES, { keyPath: 'id' });
        saveStore.createIndex('timestamp', 'timestamp', { unique: false });
        saveStore.createIndex('name', 'name', { unique: false });
      }

      if (!database.objectStoreNames.contains(STORE_SETTINGS)) {
        database.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };

    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };

    request.onerror = (e) => {
      console.error('IndexedDB error:', e.target.error);
      reject(e.target.error);
    };
  });
}

function tx(storeName, mode = 'readonly') {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- Save Games ----

export async function saveGame(gameState, saveName = 'Quicksave') {
  await openDB();
  const saveData = {
    id: `save_${Date.now()}`,
    name: saveName,
    timestamp: Date.now(),
    version: '0.1.1',
    state: structuredClone(gameState),
  };
  await promisify(tx(STORE_SAVES, 'readwrite').put(saveData));
  return saveData.id;
}

export async function loadGame(saveId) {
  await openDB();
  const data = await promisify(tx(STORE_SAVES).get(saveId));
  if (!data) throw new Error(`Save not found: ${saveId}`);
  return data;
}

export async function listSaves() {
  await openDB();
  const store = tx(STORE_SAVES);
  const all = await promisify(store.index('timestamp').getAll());
  // Return sorted newest first
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

export async function deleteSave(saveId) {
  await openDB();
  await promisify(tx(STORE_SAVES, 'readwrite').delete(saveId));
}

// ---- Settings ----

export async function saveSetting(key, value) {
  await openDB();
  await promisify(tx(STORE_SETTINGS, 'readwrite').put({ key, value }));
}

export async function loadSetting(key, defaultValue = null) {
  await openDB();
  const result = await promisify(tx(STORE_SETTINGS).get(key));
  return result ? result.value : defaultValue;
}

export async function loadAllSettings() {
  await openDB();
  const all = await promisify(tx(STORE_SETTINGS).getAll());
  const settings = {};
  for (const item of all) {
    settings[item.key] = item.value;
  }
  return settings;
}

// ---- Init ----

export async function initStorage() {
  await openDB();
  console.log('[Storage] IndexedDB initialized');
}
