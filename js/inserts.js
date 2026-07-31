// The insert library: your own images, cropped to a pocket size and kept ready
// to drag onto a page.
//
// These live in IndexedDB rather than localStorage. A 2x2 insert at print
// resolution is over a megabyte, and localStorage would be full after a
// handful; IndexedDB also stores the blob itself instead of base64, which is a
// third smaller again.

const DB_NAME = 'michi-inserts';
const STORE = 'inserts';
const LEGACY_KEY = 'michi.uploads.v1';

/** 300 dpi across a 63 mm pocket, so a printed insert matches the cards. */
export const PX_PER_POCKET = 744;

let dbPromise = null;
const cache = new Map(); // id -> { id, cols, rows, name, added, bytes, url }

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, run) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try {
      result = run(store);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction stopped.'));
  }));
}

const newId = () => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function remember(rec) {
  const entry = {
    id: rec.id,
    cols: rec.cols,
    rows: rec.rows,
    name: rec.name,
    added: rec.added,
    bytes: rec.blob.size,
    url: URL.createObjectURL(rec.blob),
  };
  cache.set(rec.id, entry);
  return entry;
}

/**
 * Load everything into memory once, so the page canvas can look an insert up
 * without waiting. Also sweeps up anything the old localStorage version left.
 */
export async function init() {
  const rows = await tx('readonly', (store) => ({ __req: store.getAll() }));
  for (const rec of rows || []) remember(rec);
  await migrateLegacy();
  return list();
}

async function migrateLegacy() {
  let old;
  try {
    old = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
  } catch {
    old = null;
  }
  if (!old || typeof old !== 'object') return;

  for (const [id, dataUrl] of Object.entries(old)) {
    if (typeof dataUrl !== 'string' || cache.has(id)) continue;
    try {
      const blob = await (await fetch(dataUrl)).blob();
      // The old version had no size, and every one of them filled one pocket.
      const rec = { id, blob, cols: 1, rows: 1, name: 'Insert', added: Date.now() };
      await tx('readwrite', (store) => store.put(rec));
      remember(rec);
    } catch {
      // A single unreadable entry should not stop the rest moving over.
    }
  }
  localStorage.removeItem(LEGACY_KEY);
}

export function list() {
  return [...cache.values()].sort((a, b) => b.added - a.added);
}

export const get = (id) => cache.get(id) || null;
export const urlOf = (id) => cache.get(id)?.url || null;

export async function add(blob, cols, rows, name = 'Insert') {
  const rec = { id: newId(), blob, cols, rows, name, added: Date.now() };
  await tx('readwrite', (store) => store.put(rec));
  return remember(rec);
}

export async function remove(id) {
  const entry = cache.get(id);
  if (entry) URL.revokeObjectURL(entry.url);
  cache.delete(id);
  await tx('readwrite', (store) => store.delete(id));
}

export async function blobOf(id) {
  const rec = await tx('readonly', (store) => ({ __req: store.get(id) }));
  return rec ? rec.blob : null;
}

/** Bytes held by the library, for the meter in the panel. */
export const usage = () => [...cache.values()].reduce((n, e) => n + e.bytes, 0);

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Used by export, which has to inline the picture into the file. */
export function toDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.readAsDataURL(blob);
  });
}

export async function addFromDataUrl(dataUrl, cols, rows, name) {
  const blob = await (await fetch(dataUrl)).blob();
  return add(blob, cols, rows, name);
}
