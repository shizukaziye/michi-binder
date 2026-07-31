// Saving: binders in localStorage, uploads kept separately, plus file
// export/import and share links.

import { makePage, reseedIds } from './layout.js';

const BINDERS_KEY = 'michi.binders.v1';
const CURRENT_KEY = 'michi.current.v1';
const UPLOADS_KEY = 'michi.uploads.v1';

const uid = () => Math.random().toString(36).slice(2, 10);

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return { ok: true };
  } catch (err) {
    const full = err && (err.name === 'QuotaExceededError' ||
                         err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return {
      ok: false,
      message: full
        ? 'Browser storage is full. Remove some uploaded images or export a binder and delete it.'
        : 'Could not save to this browser.',
    };
  }
}

export function newBinder(name = 'Untitled binder') {
  return { id: uid(), name, pages: [makePage(3, 3)], updatedAt: Date.now() };
}

export function loadBinders() {
  const list = read(BINDERS_KEY, null);
  if (!Array.isArray(list) || list.length === 0) return [newBinder('My binder')];
  reseedIds(list.flatMap((b) => b.pages || []));
  return list;
}

export function saveBinders(binders) {
  return write(BINDERS_KEY, binders);
}

export const loadCurrentId = () => read(CURRENT_KEY, null);
export const saveCurrentId = (id) => write(CURRENT_KEY, id);

// --- uploaded inserts ------------------------------------------------------
// Kept out of the binder objects so a binder stays small and shareable.

export const loadUploads = () => read(UPLOADS_KEY, {});

export function saveUpload(dataUrl) {
  const uploads = loadUploads();
  const key = `u${uid()}`;
  uploads[key] = dataUrl;
  const res = write(UPLOADS_KEY, uploads);
  return res.ok ? { ok: true, key } : res;
}

export function deleteUpload(key) {
  const uploads = loadUploads();
  delete uploads[key];
  write(UPLOADS_KEY, uploads);
}

/** Drop uploads no binder points at any more. */
export function pruneUploads(binders) {
  const used = new Set();
  for (const b of binders) {
    for (const p of b.pages || []) {
      for (const rg of p.regions || []) if (rg.upload) used.add(rg.upload);
    }
  }
  const uploads = loadUploads();
  let changed = false;
  for (const key of Object.keys(uploads)) {
    if (!used.has(key)) { delete uploads[key]; changed = true; }
  }
  if (changed) write(UPLOADS_KEY, uploads);
}

/**
 * Shrink a picked image before storing it. Full-size phone photos blow the
 * localStorage budget after two or three inserts.
 */
export function downscale(file, maxEdge = 900, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image.'));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// --- file export / import --------------------------------------------------

export function exportBinder(binder) {
  const uploads = loadUploads();
  const used = {};
  for (const p of binder.pages) {
    for (const rg of p.regions) {
      if (rg.upload && uploads[rg.upload]) used[rg.upload] = uploads[rg.upload];
    }
  }
  return JSON.stringify({ format: 'michi-binder', version: 1, binder, uploads: used }, null, 2);
}

export function importBinder(text) {
  const data = JSON.parse(text);
  if (data.format !== 'michi-binder' || !data.binder) {
    throw new Error('That file is not a binder export.');
  }
  const binder = data.binder;
  binder.id = uid();

  // Re-key the uploads so importing twice does not collide.
  if (data.uploads && Object.keys(data.uploads).length) {
    const store = loadUploads();
    const remap = {};
    for (const [oldKey, dataUrl] of Object.entries(data.uploads)) {
      const fresh = `u${uid()}`;
      remap[oldKey] = fresh;
      store[fresh] = dataUrl;
    }
    for (const p of binder.pages) {
      for (const rg of p.regions) {
        if (rg.upload && remap[rg.upload]) rg.upload = remap[rg.upload];
      }
    }
    const res = write(UPLOADS_KEY, store);
    if (!res.ok) throw new Error(res.message);
  }
  reseedIds(binder.pages);
  return binder;
}

// --- share links -----------------------------------------------------------
// Compact tuples, gzipped where the browser supports it, then base64url in the
// hash. Uploads are left out: data URLs are far too big for a URL.

const FIT = { cover: 0, contain: 1 };
const FIT_BACK = ['cover', 'contain'];

function packBinder(binder) {
  return {
    v: 1,
    n: binder.name,
    p: binder.pages.map((pg) => [
      pg.rows,
      pg.cols,
      pg.regions.map((rg) => [
        rg.r0, rg.c0, rg.r1, rg.c1,
        rg.card || 0,
        FIT[rg.fit] ?? 0,
        rg.empty ? 1 : 0,
      ]),
    ]),
  };
}

function unpackBinder(packed) {
  if (!packed || packed.v !== 1) throw new Error('Unrecognised share link.');
  let n = 1;
  return {
    id: uid(),
    name: packed.n || 'Shared binder',
    updatedAt: Date.now(),
    pages: packed.p.map(([rows, cols, regions]) => ({
      rows,
      cols,
      regions: regions.map(([r0, c0, r1, c1, card, fit, empty]) => ({
        id: `s${n++}`,
        r0, c0, r1, c1,
        card: card || null,
        upload: null,
        fit: FIT_BACK[fit] || 'cover',
        empty: !!empty,
      })),
    })),
  };
}

const toB64Url = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64Url = (text) => {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
};

async function squeeze(bytes, mode) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(mode));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unsqueeze(bytes, mode) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(mode));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeShare(binder) {
  const json = JSON.stringify(packBinder(binder));
  const raw = new TextEncoder().encode(json);
  const packed = await squeeze(raw, 'gzip');
  // 'z' marks gzipped, 'r' raw, so old links keep working either way.
  return packed && packed.length < raw.length
    ? 'z' + toB64Url(packed)
    : 'r' + toB64Url(raw);
}

export async function decodeShare(code) {
  const flag = code[0];
  const bytes = fromB64Url(code.slice(1));
  const raw = flag === 'z' ? await unsqueeze(bytes, 'gzip') : bytes;
  return unpackBinder(JSON.parse(new TextDecoder().decode(raw)));
}

export function hasUploads(binder) {
  return binder.pages.some((p) => p.regions.some((rg) => rg.upload));
}
