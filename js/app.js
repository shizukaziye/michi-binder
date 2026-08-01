// Wiring: binders, pages, the toolbar, and everything that saves.

import * as data from './data.js';
import * as store from './storage.js';
import * as inserts from './inserts.js';
import { makePage, resize, spanCols, spanRows, reseedIds, fillGaps, MIN_DIM, MAX_DIM } from './layout.js';
import { mountSearch } from './search.js';
import { mountEditor } from './editor.js';
import { mountInserts } from './insertsPanel.js';
import { printBinder, oversizeNote, fitsOnA4 } from './print.js';

const $ = (sel) => document.querySelector(sel);

let binders = [];
let current = null;
let pageIndex = 0;
let editor = null;      // the active editor the toolbar acts on
let editorL = null;     // left page
let editorR = null;     // right page (spread view only)
let spread = false;     // showing two facing pages
let activeTag = 'L';
let searchPanel = null;
let insertPanel = null;

const page = () => current.pages[pageIndex];

/** A spread page (made by Combine) is worth two binder faces. */
const isSpreadPage = (pg) => !!pg && !!pg.spread;

/**
 * Lay the pages into binder openings. Page 1 sits alone, like a real binder's
 * first face; after that pages pair two to an opening — except a wide spread
 * page fills a whole opening on its own. Returns an array of [idx] or [idx, idx].
 */
function buildOpenings() {
  const pages = current.pages;
  const openings = [];
  let i = 0;
  if (pages.length) { openings.push([0]); i = 1; }
  while (i < pages.length) {
    if (isSpreadPage(pages[i])) { openings.push([i]); i += 1; }
    else if (i + 1 < pages.length && !isSpreadPage(pages[i + 1])) { openings.push([i, i + 1]); i += 2; }
    else { openings.push([i]); i += 1; }
  }
  return openings;
}

function openingOf(i) {
  const openings = buildOpenings();
  const idx = openings.findIndex((o) => o.includes(i));
  return { openings, idx: idx < 0 ? 0 : idx };
}

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
  recordHistory();
  save();
  refreshChrome();
}

// --- undo / redo -----------------------------------------------------------
// History holds deep copies of the current binder's pages. `present` always
// matches what is on screen; an edit pushes it onto `past` and takes a fresh
// snapshot. Switching binders starts a fresh history.

const HISTORY_LIMIT = 80;
let past = [];
let future = [];
let present = null;

const snapshot = () => structuredClone(current.pages);

function resetHistory() {
  past = [];
  future = [];
  present = snapshot();
  refreshUndoButtons();
}

function recordHistory() {
  if (present) {
    past.push(present);
    if (past.length > HISTORY_LIMIT) past.shift();
  }
  future = [];
  present = snapshot();
  refreshUndoButtons();
}

function restore(pages) {
  current.pages = structuredClone(pages);
  reseedIds(current.pages);
  pageIndex = Math.max(0, Math.min(current.pages.length - 1, pageIndex));
  goToPage(pageIndex);
  save();
}

function undo() {
  if (!past.length) return;
  future.unshift(present);
  present = past.pop();
  restore(present);
  refreshUndoButtons();
}

function redo() {
  if (!future.length) return;
  past.push(present);
  present = future.shift();
  restore(present);
  refreshUndoButtons();
}

function refreshUndoButtons() {
  const u = $('#undo');
  const r = $('#redo');
  if (u) u.disabled = past.length === 0;
  if (r) r.disabled = future.length === 0;
}

// --- rendering the surrounding controls ------------------------------------

function refreshChrome() {
  const pg = page();

  $('#binderName').value = current.name;
  $('#pageName').value = page().name || '';
  const total = current.pages.length;
  if (spread) {
    const { openings, idx } = openingOf(pageIndex);
    const op = openings[idx];
    const nums = op.map((x) => x + 1);
    const wide = op.length === 1 && isSpreadPage(current.pages[op[0]]);
    $('#pageLabel').textContent = op.length > 1
      ? `Pages ${nums[0]}–${nums[1]} of ${total}`
      : `Page ${nums[0]}${wide ? ' · spread' : ''} of ${total}`;
    $('#prevPage').disabled = idx === 0;
    $('#nextPage').disabled = idx >= openings.length - 1;
  } else {
    $('#pageLabel').textContent = `Page ${pageIndex + 1} of ${total}`;
    $('#prevPage').disabled = pageIndex === 0;
    $('#nextPage').disabled = pageIndex >= total - 1;
  }
  $('#deletePage').disabled = total <= 1;
  $('#combineNext').disabled = pageIndex >= total - 1;

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
    const nm = (pg.name || '').trim();
    const num = document.createElement('span');
    num.className = 'pip-num';
    num.textContent = String(i + 1);
    const label = document.createElement('span');
    label.className = 'pip-name';
    label.textContent = nm || 'Untitled page';
    if (!nm) label.classList.add('unnamed');
    const size = document.createElement('span');
    size.className = 'pip-size';
    size.textContent = `${pg.cols}×${pg.rows}`;
    b.append(num, label, size);
    b.title = `Page ${i + 1}${nm ? ` — ${nm}` : ''} · drag to reorder`;
    b.setAttribute('aria-pressed', String(i === pageIndex));
    b.draggable = true;
    b.addEventListener('click', () => goToPage(i));
    b.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/michi-page', String(i));
      e.dataTransfer.effectAllowed = 'move';
      b.classList.add('dragging');
    });
    b.addEventListener('dragend', () => b.classList.remove('dragging'));
    b.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('text/michi-page')) return;
      e.preventDefault();
      b.classList.add('drop-into');
    });
    b.addEventListener('dragleave', () => b.classList.remove('drop-into'));
    b.addEventListener('drop', (e) => {
      e.preventDefault();
      b.classList.remove('drop-into');
      const from = Number(e.dataTransfer.getData('text/michi-page'));
      if (Number.isInteger(from)) movePage(from, i);
    });
    strip.append(b);
  });
}

/** Move a page to a new slot, keeping the same page in view. */
function movePage(from, to) {
  const pages = current.pages;
  if (from === to || from < 0 || from >= pages.length || to < 0 || to >= pages.length) return;
  const staying = pages[pageIndex];
  const moved = pages.splice(from, 1)[0];
  pages.splice(to, 0, moved);
  pageIndex = pages.indexOf(staying);
  recordHistory();
  save();
  goToPage(pageIndex);
  toast(`Moved page to slot ${to + 1}.`);
}

function onSelect({ regions, single, canMerge, canSplit }) {
  const any = regions.length > 0;
  $('#merge').disabled = !canMerge;
  $('#split').disabled = !canSplit;
  $('#clear').disabled = !any;
  $('#blank').disabled = !any;
  $('#fit').disabled = !single || !(single.card || single.upload);

  const label = $('#selLabel');
  if (!any) {
    label.textContent = 'Nothing selected';
  } else if (single) {
    const w = single.c1 - single.c0 + 1;
    const h = single.r1 - single.r0 + 1;
    const what = single.card
      ? (data.getCard(single.card)?.n ?? 'card')
      : single.upload ? (inserts.get(single.upload)?.name || 'your insert')
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
  const pages = current.pages;

  if (!spread) {
    editorL.setPage(page());
    editorR.setPage(null);
    $('#colR').hidden = true;
    editor = editorL;
    activeTag = 'L';
  } else {
    const { openings, idx } = openingOf(pageIndex);
    const op = openings[idx];
    const l = op[0];
    const r = op.length > 1 ? op[1] : null;
    editorL.setPage(pages[l]);
    editorR.setPage(r != null ? pages[r] : null);
    $('#colR').hidden = r == null; // a lone or wide page fills the whole opening
    // Focus the side that actually holds the current page.
    activeTag = (pageIndex === r) ? 'R' : 'L';
    editor = activeTag === 'R' ? editorR : editorL;
  }
  markActive();
  updateCaptions();
  refreshChrome();
}

/** The "Page N · name" caption over a canvas. */
function pageCaption(pg) {
  if (!pg) return '';
  const i = current.pages.indexOf(pg);
  const name = (pg.name || '').trim();
  return `Page ${i + 1}${name ? ` · ${name}` : ''}`;
}

function updateCaptions() {
  $('#captionL').textContent = pageCaption(editorL.getPage());
  $('#captionR').textContent = pageCaption(editorR.getPage());
}

/**
 * Switch which page the toolbar and shortcuts act on (spread view). Called from
 * the canvas pointerdown, so it must not re-render that editor mid-press — the
 * region's own pointerdown updates the toolbar a moment later.
 */
function setActiveTag(tag) {
  if (!spread) { activeTag = 'L'; editor = editorL; return; }
  const ed = tag === 'R' ? editorR : editorL;
  if (!ed.getPage()) return; // ignore a blank face
  activeTag = tag;
  editor = ed;
  pageIndex = current.pages.indexOf(ed.getPage());
  markActive();
  refreshChrome();
}

function markActive() {
  $('#canvasL').classList.toggle('active-canvas', spread && activeTag === 'L');
  $('#canvasR').classList.toggle('active-canvas', spread && activeTag === 'R');
}

function setSpread(on) {
  spread = on;
  $('#spreadToggle').setAttribute('aria-pressed', String(on));
  $('#spreadToggle').textContent = on ? 'Single page' : 'Spread view';
  goToPage(pageIndex);
}

function stepPage(dir) {
  if (!spread) return goToPage(pageIndex + dir);
  const { openings, idx } = openingOf(pageIndex);
  const next = Math.max(0, Math.min(openings.length - 1, idx + dir));
  goToPage(openings[next][0]);
}

function openBinder(binder) {
  current = binder;
  pageIndex = 0;
  goToPage(0);
  resetHistory();
  store.saveCurrentId(binder.id);
}

/** Lay the next page beside this one, making one wider spread page. */
function combineWithNext() {
  if (pageIndex >= current.pages.length - 1) {
    toast('Move to a page that has another page after it, then combine.', 'error');
    return;
  }
  const a = page();
  const b = current.pages[pageIndex + 1];
  const rows = Math.max(a.rows, b.rows);
  const cols = a.cols + b.cols;
  if (cols > MAX_DIM || rows > MAX_DIM) {
    toast(
      `That would make a ${cols}×${rows} page, past the ${MAX_DIM}×${MAX_DIM} limit. ` +
      'Shrink one of the pages first.', 'error');
    return;
  }

  let n = 0;
  const lift = (rg, dc) => {
    const copy = structuredClone(rg);
    copy.id = `k${n++}`;
    copy.c0 += dc;
    copy.c1 += dc;
    return copy;
  };
  const merged = {
    rows,
    cols,
    name: a.name || b.name || '',
    spread: true, // two faces: fills a whole opening in spread view
    regions: [
      ...a.regions.map((rg) => lift(rg, 0)),
      ...b.regions.map((rg) => lift(rg, a.cols)),
    ],
  };
  fillGaps(merged); // cover any pockets a row-count mismatch left open

  current.pages.splice(pageIndex, 2, merged);
  reseedIds(current.pages);
  recordHistory();
  save();
  goToPage(pageIndex);
  toast('Pages combined into a spread. Wider than A4 — print on A3 or use "Fit to page".');
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

/** The size of the current selection, used to pre-set the cropper. */
function selectionSize() {
  const rg = editor?.selection().regions[0];
  return rg ? { cols: spanCols(rg), rows: spanRows(rg) } : { cols: 1, rows: 1 };
}

async function boot() {
  const handlers = (tag) => ({
    onChange,
    // Only the active page drives the toolbar.
    onSelect: (sel) => { if (activeTag === tag) onSelect(sel); },
    onNotice: toast,
    // A picture dropped straight onto the page goes through the cropper first.
    onFileDrop: (files, where) => {
      setActiveTag(tag);
      showTab('inserts');
      insertPanel.intake(files, where);
    },
  });
  editorL = mountEditor($('#canvasL'), handlers('L'));
  editorR = mountEditor($('#canvasR'), handlers('R'));
  editor = editorL;
  $('#canvasL').addEventListener('pointerdown', () => setActiveTag('L'), true);
  $('#canvasR').addEventListener('pointerdown', () => setActiveTag('R'), true);
  searchPanel = mountSearch($('#searchPanel'), {
    onPick: (cardId) => editor.assignCard(cardId),
  });
  insertPanel = mountInserts($('#insertsPanel'), {
    onPlace: (id, region) => editor.placeInsert(id, region),
    selectionSize,
    onToast: toast,
  });

  // Inserts first: the canvas looks them up synchronously while it draws.
  try {
    await inserts.init();
    insertPanel.render();
  } catch {
    toast('Your saved inserts could not be opened in this browser.', 'error');
  }

  binders = store.loadBinders();
  const savedId = store.loadCurrentId();
  current = binders.find((b) => b.id === savedId) || binders[0];
  pageIndex = 0;
  goToPage(0);
  resetHistory();

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
  } catch (err) {
    $('#searchPanel').querySelector('#count').textContent =
      'The card index did not load. Check your connection and reload.';
    toast(String(err.message || err), 'error');
  }
}

function wireControls() {
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#merge').addEventListener('click', () => editor.merge());
  $('#split').addEventListener('click', () => editor.split());
  $('#clear').addEventListener('click', () => editor.clearSelected());
  $('#blank').addEventListener('click', () => editor.toggleEmpty());
  $('#fit').addEventListener('click', () => editor.toggleFit());

  // Panel tabs
  $('#tabCards').addEventListener('click', () => showTab('cards'));
  $('#tabInserts').addEventListener('click', () => showTab('inserts'));

  // Paste an image anywhere that is not a text field.
  document.addEventListener('paste', (e) => {
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (insertPanel.handlePaste(e.clipboardData)) {
      e.preventDefault();
      showTab('inserts');
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
  $('#prevPage').addEventListener('click', () => stepPage(-1));
  $('#nextPage').addEventListener('click', () => stepPage(1));
  $('#spreadToggle').addEventListener('click', () => setSpread(!spread));
  $('#pageName').addEventListener('input', (e) => {
    page().name = e.target.value;
    save();
    renderPageStrip();
    updateCaptions();
  });
  $('#addPage').addEventListener('click', () => {
    const pg = page();
    current.pages.splice(pageIndex + 1, 0, makePage(pg.rows, pg.cols));
    recordHistory();
    save();
    goToPage(pageIndex + 1);
  });
  $('#duplicatePage').addEventListener('click', () => {
    const copy = structuredClone(page());
    copy.regions.forEach((rg, i) => { rg.id = `d${Date.now()}_${i}`; });
    current.pages.splice(pageIndex + 1, 0, copy);
    recordHistory();
    save();
    goToPage(pageIndex + 1);
    toast('Page duplicated.');
  });
  $('#combineNext').addEventListener('click', combineWithNext);
  $('#deletePage').addEventListener('click', () => {
    if (current.pages.length <= 1) return;
    if (!confirm(`Delete page ${pageIndex + 1}? You can undo this.`)) return;
    current.pages.splice(pageIndex, 1);
    recordHistory();
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
  $('#export').addEventListener('click', async () => {
    try {
      download(`${slug(current.name)}.michi.json`, await store.exportBinder(current));
      toast('Binder exported, inserts included.');
    } catch (err) {
      toast(err.message || 'Could not export that binder.', 'error');
    }
  });
  $('#import').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const binder = await store.importBinder(await file.text());
      insertPanel.render();
      addBinder(binder, 'Binder imported.');
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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault(); e.shiftKey ? redo() : undo(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault(); redo(); return;
    }
    switch (e.key) {
      case 'm': editor.merge(); break;
      case 's': editor.split(); break;
      case 'b': editor.toggleEmpty(); break;
      case 'Delete': case 'Backspace': e.preventDefault(); editor.clearSelected(); break;
      case 'Escape': editor.clearSelection(); break;
      case 'a': if (e.ctrlKey || e.metaKey) { e.preventDefault(); editor.selectAll(); } break;
      case 'ArrowLeft': stepPage(-1); break;
      case 'ArrowRight': stepPage(1); break;
    }
  });
}

function showTab(which) {
  const cards = which === 'cards';
  $('#tabCards').setAttribute('aria-selected', String(cards));
  $('#tabInserts').setAttribute('aria-selected', String(!cards));
  $('#searchPanel').hidden = !cards;
  $('#insertsPanel').hidden = cards;
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
  pg.spread = false; // a hand-sized page is a native page, not a combined spread
  goToPage(pageIndex);
  onChange();
}

boot();
