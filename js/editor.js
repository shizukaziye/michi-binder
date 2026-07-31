// The page canvas: draws the pockets, handles selection, drag and drop.

import * as L from './layout.js';
import { getCard, imageUrl, imageFallback, cardLabel } from './data.js';
import { loadUploads } from './storage.js';

export const CARD_W = 63; // mm, standard trading card
export const CARD_H = 88;

/**
 * Where the i-th pocket boundary falls inside a region spanning n pockets.
 * The region swallows the grid gaps it covers, so an even i/n split would drift
 * off the real seam; this puts the line down the middle of the gap.
 */
function boundary(i, n) {
  return `calc((100% - ${n - 1} * var(--gap)) / ${n} * ${i}` +
         ` + ${i - 1} * var(--gap) + var(--gap) / 2)`;
}

export function mountEditor(root, { onChange, onSelect }) {
  let page = null;
  let anchor = null;   // region the selection started from
  let focus = null;    // region the selection currently reaches
  let dragging = false;

  const grid = document.createElement('div');
  grid.className = 'page-grid';
  root.append(grid);

  /** The rectangle currently selected, or null. */
  function rect() {
    if (!anchor) return null;
    const a = { r: anchor.r0, c: anchor.c0 };
    const bR = focus || anchor;
    // Reach the far corner of the focused region so partial spans still merge.
    const b = { r: bR.r1, c: bR.c1 };
    const base = L.rectBetween(page, a, b);
    // Grow to cover every region the rectangle touches, so a merge never
    // slices an existing panel in half.
    let changed = true;
    while (changed) {
      changed = false;
      for (const rg of page.regions) {
        const hits = rg.r0 <= base.r1 && rg.r1 >= base.r0 &&
                     rg.c0 <= base.c1 && rg.c1 >= base.c0;
        if (!hits) continue;
        if (rg.r0 < base.r0) { base.r0 = rg.r0; changed = true; }
        if (rg.c0 < base.c0) { base.c0 = rg.c0; changed = true; }
        if (rg.r1 > base.r1) { base.r1 = rg.r1; changed = true; }
        if (rg.c1 > base.c1) { base.c1 = rg.c1; changed = true; }
      }
    }
    return base;
  }

  function selectedRegions() {
    const rc = rect();
    if (!rc) return [];
    return page.regions.filter(
      (rg) => rg.r0 <= rc.r1 && rg.r1 >= rc.r0 && rg.c0 <= rc.c1 && rg.c1 >= rc.c0
    );
  }

  function announce() {
    const rc = rect();
    const regions = selectedRegions();
    onSelect({
      rect: rc,
      regions,
      single: regions.length === 1 ? regions[0] : null,
      canMerge: rc ? L.canMerge(page, rc) : false,
      canSplit: regions.length === 1 && !L.isSingle(regions[0]),
    });
  }

  function setSelection(a, f) {
    anchor = a;
    focus = f;
    render();
  }

  function artOf(rg) {
    if (rg.upload) {
      const url = loadUploads()[rg.upload];
      return url ? { src: url, alt: 'Your uploaded insert', fallback: null } : null;
    }
    if (rg.card) {
      const card = getCard(rg.card);
      if (!card) return null;
      return {
        src: imageUrl(card, 'high'),
        fallback: imageFallback(card, 'high'),
        alt: cardLabel(card),
        title: `${cardLabel(card)}${card.a ? ` — art by ${card.a}` : ''}`,
      };
    }
    return null;
  }

  function drawRegion(rg, selRect) {
    const el = document.createElement('div');
    el.className = 'region';
    el.dataset.id = rg.id;
    el.style.gridArea = `${rg.r0 + 1} / ${rg.c0 + 1} / ${rg.r1 + 2} / ${rg.c1 + 2}`;

    const selected = selRect &&
      rg.r0 <= selRect.r1 && rg.r1 >= selRect.r0 &&
      rg.c0 <= selRect.c1 && rg.c1 >= selRect.c0;
    if (selected) el.classList.add('selected');
    if (rg.empty) el.classList.add('is-empty-by-design');

    const art = artOf(rg);
    if (art) {
      el.classList.add('filled', `fit-${rg.fit}`);
      const img = document.createElement('img');
      img.className = 'region-img';
      img.src = art.src;
      img.alt = art.alt;
      img.decoding = 'async';
      if (art.title) img.title = art.title;
      if (art.fallback) {
        img.addEventListener('error', () => {
          if (!img.dataset.retried) { img.dataset.retried = '1'; img.src = art.fallback; }
        });
      }
      el.append(img);
      el.draggable = true;
    } else if (rg.empty) {
      const note = document.createElement('span');
      note.className = 'region-note';
      note.textContent = 'left blank';
      el.append(note);
    }

    // Pocket boundaries drawn over spanned art, so you can see where to cut.
    const rows = L.spanRows(rg);
    const cols = L.spanCols(rg);
    if (rows > 1 || cols > 1) {
      const lines = document.createElement('div');
      lines.className = 'cut-lines';
      for (let i = 1; i < rows; i++) {
        const line = document.createElement('i');
        line.className = 'cut-h';
        line.style.top = boundary(i, rows);
        lines.append(line);
      }
      for (let i = 1; i < cols; i++) {
        const line = document.createElement('i');
        line.className = 'cut-v';
        line.style.left = boundary(i, cols);
        lines.append(line);
      }
      el.append(lines);
      const badge = document.createElement('span');
      badge.className = 'span-badge';
      badge.textContent = `${cols}×${rows}`;
      el.append(badge);
    }

    wireRegion(el, rg);
    return el;
  }

  function wireRegion(el, rg) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.shiftKey && anchor) {
        focus = rg;
        render();
        return;
      }
      // A filled region starts an art drag instead of a rubber-band select.
      if (!el.draggable) {
        dragging = true;
        el.setPointerCapture?.(e.pointerId);
      }
      anchor = rg;
      focus = rg;
      render();
    });

    el.addEventListener('pointerenter', () => {
      if (!dragging) return;
      focus = rg;
      render();
    });

    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/michi-region', rg.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));

    el.addEventListener('dragover', (e) => {
      const types = e.dataTransfer.types;
      if (types.includes('text/michi-card') || types.includes('text/michi-region')) {
        e.preventDefault();
        el.classList.add('drop-target');
      }
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      const cardId = e.dataTransfer.getData('text/michi-card');
      const fromId = e.dataTransfer.getData('text/michi-region');
      if (cardId) {
        rg.card = cardId;
        rg.upload = null;
        rg.empty = false;
      } else if (fromId && fromId !== rg.id) {
        const from = L.findRegion(page, fromId);
        if (from) L.swapContents(from, rg);
      } else {
        return;
      }
      anchor = rg; focus = rg;
      commit();
    });
  }

  /**
   * Give the rows an exact height so a pocket keeps true card proportions.
   * An aspect-ratio on the grid cannot do this: the gaps and padding are fixed
   * pixels, so they skew the ratio of the pockets inside it.
   */
  function sizeRows() {
    if (!page) return;
    const cs = getComputedStyle(grid);
    const gap = parseFloat(cs.columnGap) || 0;
    const inner = grid.clientWidth -
      (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (inner <= 0) return;
    const cellW = (inner - (page.cols - 1) * gap) / page.cols;
    const cellH = (cellW * CARD_H) / CARD_W;
    grid.style.gridTemplateRows = `repeat(${page.rows}, ${cellH.toFixed(3)}px)`;
  }

  function render() {
    if (!page) return;
    grid.style.setProperty('--rows', page.rows);
    grid.style.setProperty('--cols', page.cols);

    const selRect = rect();
    const frag = document.createDocumentFragment();
    for (const rg of page.regions) frag.append(drawRegion(rg, selRect));
    grid.replaceChildren(frag);
    sizeRows();
    announce();
  }

  function commit() {
    render();
    onChange();
  }

  window.addEventListener('pointerup', () => { dragging = false; });
  new ResizeObserver(sizeRows).observe(grid);
  // The observer covers layout changes around the grid; the window event covers
  // the viewport height, which the grid's own width cap depends on.
  window.addEventListener('resize', sizeRows);

  return {
    setPage(next) {
      page = next;
      anchor = null;
      focus = null;
      render();
    },
    getPage: () => page,
    render,
    selection: () => ({ rect: rect(), regions: selectedRegions() }),

    merge() {
      const rc = rect();
      if (!rc || !L.canMerge(page, rc)) return;
      const merged = L.merge(page, rc);
      anchor = merged; focus = merged;
      commit();
    },
    split() {
      const regions = selectedRegions();
      if (regions.length !== 1 || L.isSingle(regions[0])) return;
      const first = L.split(page, regions[0].id);
      anchor = first; focus = first;
      commit();
    },
    assignCard(cardId) {
      const regions = selectedRegions();
      const target = regions[0] || page.regions[0];
      if (!target) return;
      target.card = cardId;
      target.upload = null;
      target.empty = false;
      anchor = target; focus = target;
      commit();
    },
    assignUpload(key) {
      const target = selectedRegions()[0];
      if (!target) return;
      target.upload = key;
      target.card = null;
      target.empty = false;
      commit();
    },
    clearSelected() {
      const regions = selectedRegions();
      if (!regions.length) return;
      regions.forEach(L.clearRegion);
      commit();
    },
    toggleEmpty() {
      const regions = selectedRegions();
      if (!regions.length) return;
      const makeEmpty = !regions.every((rg) => rg.empty);
      for (const rg of regions) {
        rg.empty = makeEmpty;
        if (makeEmpty) { rg.card = null; rg.upload = null; }
      }
      commit();
    },
    toggleFit() {
      const regions = selectedRegions();
      if (regions.length !== 1) return;
      regions[0].fit = regions[0].fit === 'cover' ? 'contain' : 'cover';
      commit();
    },
    selectAll() {
      if (!page.regions.length) return;
      setSelection(
        L.regionAt(page, 0, 0),
        L.regionAt(page, page.rows - 1, page.cols - 1)
      );
    },
    clearSelection() { setSelection(null, null); },
  };
}
