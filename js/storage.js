// Saving: binders in localStorage, uploads kept separately, plus file
// export/import and share links.

import { makePage, reseedIds } from './layout.js';
import * as inserts from './inserts.js';

const BINDERS_KEY = 'michi.binders.v1';
const CURRENT_KEY = 'michi.current.v1';

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

// --- file export / import --------------------------------------------------
// Inserts live in IndexedDB, so an export has to inline the pictures to be
// worth anything on another machine.

export async function exportBinder(binder) {
  const used = new Set();
  for (const p of binder.pages) {
    for (const rg of p.regions) if (rg.upload) used.add(rg.upload);
  }

  const packed = [];
  for (const id of used) {
    const item = inserts.get(id);
    const blob = await inserts.blobOf(id);
    if (!item || !blob) continue;
    packed.push({
      id,
      cols: item.cols,
      rows: item.rows,
      name: item.name,
      dataUrl: await inserts.toDataUrl(blob),
    });
  }

  return JSON.stringify(
    { format: 'michi-binder', version: 2, binder, inserts: packed }, null, 2
  );
}

export async function importBinder(text) {
  const data = JSON.parse(text);
  if (data.format !== 'michi-binder' || !data.binder) {
    throw new Error('That file is not a binder export.');
  }
  const binder = data.binder;
  binder.id = uid();

  // Version 1 kept inserts as a flat map with no size, all of them one pocket.
  const incoming = data.version >= 2
    ? (data.inserts || [])
    : Object.entries(data.uploads || {}).map(([id, dataUrl]) => (
        { id, cols: 1, rows: 1, name: 'Insert', dataUrl }
      ));

  // Fresh ids, so importing the same file twice does not collide.
  const remap = {};
  for (const item of incoming) {
    try {
      const saved = await inserts.addFromDataUrl(
        item.dataUrl, item.cols || 1, item.rows || 1, item.name || 'Insert'
      );
      remap[item.id] = saved.id;
    } catch {
      // Skip a picture we cannot read rather than lose the whole binder.
    }
  }
  for (const p of binder.pages) {
    for (const rg of p.regions) {
      if (rg.upload) rg.upload = remap[rg.upload] || null;
    }
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
      pg.name || '',
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
    pages: packed.p.map(([rows, cols, regions, name]) => ({
      rows,
      cols,
      name: name || '',
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
