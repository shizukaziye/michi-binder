// Wiring: binders, pages, the toolbar, and everything that saves.

import * as data from './data.js';
import * as store from './storage.js';
import { makePage, resize, MIN_DIM, MAX_DIM } from './layout.js';
import { mountSearch } from './search.js';
import { mountEditor } from './editor.js';
import { printBinder, oversizeNote, fitsOnA4 } from './print.js';

const $ = (sel) => document.querySelector(sel);

let binders = [];
let current = null;
let pageIndex = 0;
let editor = null;
let searchPanel = null;

const page = () => current.pages[pageIndex];

// --- small helpers ---------------------------------------------------------

let toastTimer;
function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'error' ? 6000 : 3200);
}

let saveTimer;
function save() {
  current.updatedAt = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const res = store.saveBinders(binders);
    if (!res.ok) toast(res.message, 'error');
    store.saveCurrentId(current.id);
  }, 250);
}

function onChange() {
  save();
  refreshChrome();
}

// --- rendering the surrounding controls ------------------------------------

function refreshChrome() {
  const pg = page();

  $('#binderName').value = current.name;
  $('#pageLabel').textContent = `Page ${pageIndex + 1} of ${current.pages.length}`;
  $('#prevPage').disabled = pageIndex === 0;
  $('#nextPage').disabled = pageIndex >= current.pages.length - 1;
  $('#deletePage').disabled = current.pages.length <= 1;

  $('#rows').value = pg.rows;
  $('#cols').value = pg.cols;
  document.querySelectorAll('.preset').forEach((b) => {
    const [r, c] = b.dataset.size.split('x').map(Number);
    b.setAttribute('aria-pressed', String(pg.rows === r && pg.cols === c));
  });

  const note = $('#sizeNote');
  if (fitsOnA4(pg)) {
    note.textContent = '';
    note.hidden = true;
  } else {
    note.textContent = oversizeNote(pg);
    note.hidden = false;
  }

  renderBinderList();
  renderPageStrip();
}

function renderBinderList() {
  const sel = $('#binderPicker');
  sel.replaceChildren();
  for (const b of [...binders].sort((a, z) => z.updatedAt - a.updatedAt)) {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name || 'Untitled binder';
    if (b.id === current.id) opt.selected = true;
    sel.append(opt);
  }
}

function renderPageStrip() {
  const strip = $('#pageStrip');
  strip.replaceChildren();
  current.pages.forEach((pg, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'page-pip';
    b.textContent = String(i + 1);
    b.title = `Page ${i + 1} — ${pg.cols}×${pg.rows}`;
    b.setAttribute('aria-pressed', String(i === pageIndex));
    b.addEventListener('click', () => goToPage(i));
    strip.append(b);
  });
}

function onSelect({ regions, single, canMerge, canSplit }) {
  const any = regions.length > 0;
  $('#merge').disabled = !canMerge;
  $('#split').disabled = !canSplit;
  $('#clear').disabled = !any;
  $('#blank').disabled = !any;
  $('#fit').disabled = !single || !(single.card || single.upload);
  $('#upload').disabled = !single;

  const label = $('#selLabel');
  if (!any) {
    label.textContent = 'Nothing selected';
  } else if (single) {
    const w = single.c1 - single.c0 + 1;
    const h = single.r1 - single.r0 + 1;
    const what = single.card
      ? (data.getCard(single.card)?.n ?? 'card')
      : single.upload ? 'your insert'
      : single.empty ? 'blank on purpose' : 'free pocket';
    label.textContent = `${w}×${h} — ${what}`;
  } else {
    label.textContent = `${regions.length} pockets selected`;
  }

  if (single) {
    $('#fit').textContent = single.fit === 'cover' ? 'Fit: fill' : 'Fit: whole card';
  }
}

// --- page and binder actions ----------------------------------------------

function goToPage(i) {
  pageIndex = Math.max(0, Math.min(current.pages.length - 1, i));
  editor.setPage(page());
  refreshChrome();
}

function openBinder(binder) {
  current = binder;
  pageIndex = 0;
  editor.setPage(page());
  refreshChrome();
  store.saveCurrentId(binder.id);
}

function addBinder(binder, message) {
  binders.push(binder);
  const res = store.saveBinders(binders);
  if (!res.ok) { toast(res.message, 'error'); return; }
  openBinder(binder);
  if (message) toast(message);
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (s) =>
  (s || 'binder').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'binder';

// --- start up --------------------------------------------------------------

async function boot() {
  editor = mountEditor($('#canvas'), { onChange, onSelect });
  searchPanel = mountSearch($('#searchPanel'), {
    onPick: (cardId) => editor.assignCard(cardId),
  });

  binders = store.loadBinders();
  const savedId = store.loadCurrentId();
  current = binders.find((b) => b.id === savedId) || binders[0];
  pageIndex = 0;
  editor.setPage(page());
  refreshChrome();

  wireControls();

  // A share link wins over whatever was open last.
  if (location.hash.length > 2) {
    try {
      const shared = await store.decodeShare(location.hash.slice(1));
      binders.push(shared);
      store.saveBinders(binders);
      openBinder(shared);
      history.replaceState(null, '', location.pathname + location.search);
      toast(`Opened the shared binder "${shared.name}" and saved a copy.`);
    } catch {
      toast('That share link could not be read.', 'error');
    }
  }

  try {
    await data.load();
    searchPanel.start();
    editor.render();
    store.pruneUploads(binders);
  } catch (err) {
    $('#searchPanel').querySelector('#count').textContent =
      'The card index did not load. Check your connection and reload.';
    toast(String(err.message || err), 'error');
  }
}

function wireControls() {
  $('#merge').addEventListener('click', () => editor.merge());
  $('#split').addEventListener('click', () => editor.split());
  $('#clear').addEventListener('click', () => editor.clearSelected());
  $('#blank').addEventListener('click', () => editor.toggleEmpty());
  $('#fit').addEventListener('click', () => editor.toggleFit());

  $('#upload').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await store.downscale(file);
      const res = store.saveUpload(dataUrl);
      if (!res.ok) { toast(res.message, 'error'); return; }
      editor.assignUpload(res.key);
      toast('Insert added.');
    } catch (err) {
      toast(err.message || 'Could not use that image.', 'error');
    }
  });

  // Grid size
  document.querySelectorAll('.preset').forEach((b) => {
    b.addEventListener('click', () => {
      const [r, c] = b.dataset.size.split('x').map(Number);
      applySize(r, c);
    });
  });
  $('#rows').addEventListener('change', () => applySize(+$('#rows').value, page().cols));
  $('#cols').addEventListener('change', () => applySize(page().rows, +$('#cols').value));

  // Pages
  $('#prevPage').addEventListener('click', () => goToPage(pageIndex - 1));
  $('#nextPage').addEventListener('click', () => goToPage(pageIndex + 1));
  $('#addPage').addEventListener('click', () => {
    const pg = page();
    current.pages.splice(pageIndex + 1, 0, makePage(pg.rows, pg.cols));
    save();
    goToPage(pageIndex + 1);
  });
  $('#duplicatePage').addEventListener('click', () => {
    const copy = structuredClone(page());
    copy.regions.forEach((rg, i) => { rg.id = `d${Date.now()}_${i}`; });
    current.pages.splice(pageIndex + 1, 0, copy);
    save();
    goToPage(pageIndex + 1);
    toast('Page duplicated.');
  });
  $('#deletePage').addEventListener('click', () => {
    if (current.pages.length <= 1) return;
    if (!confirm(`Delete page ${pageIndex + 1}? This cannot be undone.`)) return;
    current.pages.splice(pageIndex, 1);
    save();
    goToPage(Math.min(pageIndex, current.pages.length - 1));
  });

  // Binders
  $('#binderPicker').addEventListener('change', (e) => {
    const next = binders.find((b) => b.id === e.target.value);
    if (next) openBinder(next);
  });
  $('#binderName').addEventListener('input', (e) => {
    current.name = e.target.value;
    save();
    renderBinderList();
  });
  $('#newBinder').addEventListener('click', () =>
    addBinder(store.newBinder(`Binder ${binders.length + 1}`), 'New binder started.'));
  $('#deleteBinder').addEventListener('click', () => {
    if (binders.length <= 1) { toast('Keep at least one binder.', 'error'); return; }
    if (!confirm(`Delete "${current.name}"? This cannot be undone.`)) return;
    binders = binders.filter((b) => b.id !== current.id);
    store.saveBinders(binders);
    store.pruneUploads(binders);
    openBinder(binders[0]);
    toast('Binder deleted.');
  });

  // Files and links
  $('#export').addEventListener('click', () => {
    download(`${slug(current.name)}.michi.json`, store.exportBinder(current));
    toast('Binder exported.');
  });
  $('#import').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      addBinder(store.importBinder(await file.text()), 'Binder imported.');
    } catch (err) {
      toast(err.message || 'That file could not be read.', 'error');
    }
  });

  $('#share').addEventListener('click', async () => {
    try {
      const code = await store.encodeShare(current);
      const url = `${location.origin}${location.pathname}#${code}`;
      if (url.length > 12000) {
        toast('This binder is too big for a link. Use Export instead.', 'error');
        return;
      }
      await navigator.clipboard.writeText(url);
      toast(store.hasUploads(current)
        ? 'Link copied. Your uploaded inserts are not included — use Export to keep those.'
        : 'Share link copied to the clipboard.');
    } catch {
      toast('Could not copy the link.', 'error');
    }
  });

  $('#print').addEventListener('click', async () => {
    const mode = $('#printMode').value;
    await printBinder(current, mode, $('#printArea'));
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (typing) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault(); searchPanel.focus(); return;
    }
    switch (e.key) {
      case 'm': editor.merge(); break;
      case 's': editor.split(); break;
      case 'b': editor.toggleEmpty(); break;
      case 'Delete': case 'Backspace': e.preventDefault(); editor.clearSelected(); break;
      case 'Escape': editor.clearSelection(); break;
      case 'a': if (e.ctrlKey || e.metaKey) { e.preventDefault(); editor.selectAll(); } break;
      case 'ArrowLeft': if (pageIndex > 0) goToPage(pageIndex - 1); break;
      case 'ArrowRight': if (pageIndex < current.pages.length - 1) goToPage(pageIndex + 1); break;
    }
  });
}

function applySize(rows, cols) {
  rows = Math.min(MAX_DIM, Math.max(MIN_DIM, rows || 3));
  cols = Math.min(MAX_DIM, Math.max(MIN_DIM, cols || 3));
  const pg = page();
  const losing = pg.regions.filter(
    (rg) => (rg.r1 >= rows || rg.c1 >= cols) && (rg.card || rg.upload)
  ).length;
  if (losing && !confirm(
    `Shrinking to ${cols}×${rows} drops ${losing} placed ${losing === 1 ? 'card' : 'cards'}. Continue?`
  )) {
    refreshChrome();
    return;
  }
  resize(pg, rows, cols);
  editor.setPage(pg);
  onChange();
}

boot();
