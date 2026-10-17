/**
 * FYLO Core — Storage
 * IndexedDB wrapper. All persistence flows through this module.
 * Feature modules import the typed helpers (FileStorage, etc.) — never raw IDB.
 */

import { DB_NAME, DB_VERSION, DB_STORES } from './constants.js';
import { createLogger } from './logger.js';
import { bus, EVENTS } from './eventBus.js';
import { Actions } from './state.js';

const log = createLogger('Storage');

let _db = null;  // module-private singleton

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initStorage() {
  return new Promise((resolve, reject) => {
    // Guard against IndexedDB open() hanging indefinitely — a known Android
    // WebView behaviour where neither onsuccess nor onerror ever fires.
    // After 5 s the Promise rejects; bootstrap's existing catch() continues.
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.error('IndexedDB open timed out (5 s) — storage unavailable');
      reject(new Error('IndexedDB open timed out'));
    }, 5000);

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = ({ target: { result: db } }) => {
      const stores = Object.values(DB_STORES);
      stores.forEach(name => {
        if (!db.objectStoreNames.contains(name))
          db.createObjectStore(name, { keyPath: 'id' });
      });
      // settings store uses 'key' as keyPath
      if (!db.objectStoreNames.contains('settings_kv')) {
        db.createObjectStore('settings_kv', { keyPath: 'key' });
      }
    };
    req.onsuccess = ({ target: { result: db } }) => {
      if (settled) return;   // timeout already fired — do not double-settle
      clearTimeout(timer);
      settled = true;
      _db = db;
      Actions.setDB(db);
      log.info('IndexedDB ready');
      resolve(db);
    };
    req.onerror = ({ target: { error } }) => {
      if (settled) return;   // timeout already fired — do not double-settle
      clearTimeout(timer);
      settled = true;
      log.error('IndexedDB open failed:', error);
      bus.emit(EVENTS.STORAGE_ERROR, { error });
      reject(error);
    };
  });
}

// ── Generic CRUD ──────────────────────────────────────────────────────────────
function _tx(storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    if (!_db) { reject(new Error('DB not initialised — call initStorage() first')); return; }
    try {
      const tx  = _db.transaction(storeName, mode);
      const st  = tx.objectStore(storeName);
      const req = fn(st);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}

export const storage = {
  get:    (store, key)  => _tx(store, 'readonly',  s => s.get(key)),
  put:    (store, data) => _tx(store, 'readwrite', s => s.put(data)),
  delete: (store, key)  => _tx(store, 'readwrite', s => s.delete(key)),
  getAll: (store)       => _tx(store, 'readonly',  s => s.getAll()),
  clear:  (store)       => _tx(store, 'readwrite', s => s.clear()),
};

// ── Typed helpers — import these in feature modules ───────────────────────────

export const FileStorage = {
  save:    file    => storage.put(DB_STORES.FILES, file),
  load:    id      => storage.get(DB_STORES.FILES, id),
  remove:  id      => storage.delete(DB_STORES.FILES, id),
  loadAll: ()      => storage.getAll(DB_STORES.FILES),
};

export const BookmarkStorage = {
  save: (fileId, pagesSet) =>
    storage.put(DB_STORES.BOOKMARKS, { id: fileId, pages: [...pagesSet] }),
  load: fileId => storage.get(DB_STORES.BOOKMARKS, fileId),
};

export const ThumbStorage = {
  save: (fileId, dataUrl) =>
    storage.put(DB_STORES.THUMBS, { id: fileId, dataUrl }),
  load: fileId => storage.get(DB_STORES.THUMBS, fileId),
};

// Settings: key-value store (uses separate keyPath 'key')
export const SettingsStorage = {
  save: (key, value) => _tx('settings_kv', 'readwrite', s => s.put({ key, value })),
  load: async key => {
    const r = await _tx('settings_kv', 'readonly', s => s.get(key));
    return r?.value ?? null;
  },
};
