// The page canvas: draws the pockets, handles selection, drag and drop.

import * as L from './layout.js';
import { getCard, imageUrl, imageFallback, cardLabel } from './data.js';
import * as inserts from './inserts.js';

export const CARD_W = 63; // mm, standard trading card
export const CARD_H = 88;

/**
 * Show one part of a picture that covers several pockets.
 *
 * Scale the image up by the size of the block, then slide it so this pocket's
 * share lands in view. Percentage background positions align the image's own
 * fraction with the box's, so 0% is the first column and 100% the last.
 */
export function sliceStyle(src, { cols, rows, c, r }) {
  return {
    backgroundImage: `url("${src}")`,
    backgroundSize: `${cols * 100}% ${rows * 100}%`,
    backgroundPosition: `${cols > 1 ? (c / (cols - 1)) * 100 : 0}% ` +
                        `${rows > 1 ? (r / (rows - 1)) * 100 : 0}%`,
    backgroundRepeat: 'no-repeat',
  };
}

export function mountEditor(root, { onChange, onSelect, onNotice, onFileDrop, onMove }) {
  let page = null;
  let anchor = null;     // region the selection started from
  let focus = null;      // region the selection currently reaches
  let down = false;      // the mouse button is held down on this page
  // What the current press is doing: 'select' sweeps a selection (started on an
  // empty pocket), 'pending-move'/'move' relocates a card (started on a filled
  // one). Selection only ever changes while `down` is true.
  let kind = null;
  let start = null;      // { rg, x, y } of the press
  let dropTargetEl = null;

  const MOVE_THRESHOLD = 6; // px of travel before a press counts as a drag

  const grid = document.createElement('div');
  grid.className = 'page-grid';
  root.append(grid);

  /** The rectangle currently selected, or null. */
  function rect() {
    if (!anchor) return null;
    const bR = focus || anchor;
    // Pockets never span, so the rectangle between the two corners is the whole
    // story -- nothing has to grow to avoid slicing a panel in half.
    return L.rectBetween(page, { r: anchor.r0, c: anchor.c0 }, { r: bR.r0, c: bR.c0 });
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
    });
  }

  function setSelection(a, f) {
    anchor = a;
    focus = f;
    paintSelection();
  }

  function artOf(rg) {
    if (rg.upload) {
      const item = inserts.get(rg.upload);
      return item
        ? { src: item.url, alt: item.name || 'Your insert', fallback: null, title: item.name }
        : null;
    }
    if (rg.card) {
      const card = getCard(rg.card);
      if (!card) return null;
      // Low res on screen — the pockets are small. Printing pulls the high-res
      // scans separately, so a page full of cards stays light while you work.
      return {
        src: imageUrl(card, 'low'),
        fallback: imageFallback(card, 'low'),
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
    if (art && rg.slice) {
      el.classList.add('filled', 'sliced');
      const part = document.createElement('div');
      part.className = 'region-slice';
      Object.assign(part.style, sliceStyle(art.src, rg.slice));
      part.title = art.title || art.alt;
      el.append(part);
    } else if (art) {
      el.classList.add('filled', `fit-${rg.fit}`);
      const img = document.createElement('img');
      img.className = 'region-img';
      img.src = art.src;
      img.alt = art.alt;
      img.decoding = 'async';
      // Stop the browser's own image drag: it would hijack our pointer gesture
      // and drop the picture back through the file cropper as a re-upload.
      img.draggable = false;
      if (art.title) img.title = art.title;
      if (art.fallback) {
        img.addEventListener('error', () => {
          if (!img.dataset.retried) { img.dataset.retried = '1'; img.src = art.fallback; }
        });
      }
      el.append(img);
      // Regions are never natively draggable: moving a card is a pointer gesture
      // (a quick drag), so a press-and-hold can rubber-band a selection instead.
    } else if (rg.empty) {
      const note = document.createElement('span');
      note.className = 'region-note';
      note.textContent = 'left blank';
      el.append(note);
    }

    // No cut lines: the gaps between pockets already show where the picture
    // divides, because each pocket really is its own card now.
    wireRegion(el, rg);
    return el;
  }

  const regionEl = (id) => grid.querySelector(`.region[data-id="${id}"]`);

  function setDropTarget(el) {
    const next = el && !el.classList.contains('source') ? el : null;
    if (next === dropTargetEl) return;
    dropTargetEl?.classList.remove('drop-target');
    dropTargetEl = next;
    dropTargetEl?.classList.add('drop-target');
  }

  function endGesture() {
    if (start) regionEl(start.rg.id)?.classList.remove('source');
    setDropTarget(null);
    down = false;
    kind = null;
    start = null;
  }

  function wireRegion(el, rg) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.shiftKey && anchor) { focus = rg; paintSelection(); return; }
      // Press selects this one pocket. Then, while the button stays down, a drag
      // from an EMPTY pocket sweeps a selection; a drag from a FILLED one moves
      // the card. Release ends it — selection never changes with the button up.
      // No pointer capture: the sweep needs pointerenter on the neighbours.
      anchor = rg;
      focus = rg;
      down = true;
      kind = artOf(rg) ? 'pending-move' : 'select';
      start = { rg, x: e.clientX, y: e.clientY };
      paintSelection();
    });

    el.addEventListener('pointerenter', (e) => {
      // Extend the selection only while sweeping with the button held.
      if (!down || kind !== 'select') return;
      // No capture means a release outside the window never reaches us. If the
      // button is up by the time the pointer comes back, the gesture is over —
      // without this the selection would chase the loose mouse forever.
      if (e.buttons === 0) { endGesture(); return; }
      focus = rg;
      paintSelection();
    });

    el.addEventListener('dragover', (e) => {
      const types = [...e.dataTransfer.types];
      const wanted = ['text/michi-card', 'text/michi-insert', 'Files'];
      if (wanted.some((t) => types.includes(t))) {
        e.preventDefault();
        el.classList.add('drop-target');
      }
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      const cardId = e.dataTransfer.getData('text/michi-card');
      const insertId = e.dataTransfer.getData('text/michi-insert');
      const files = [...(e.dataTransfer.files || [])];

      if (insertId) {
        dropInsert(rg, insertId);
        return;
      }
      if (files.length) {
        // Dropping a picture straight onto the page opens the cropper. If it
        // landed inside a selected block, offer to fill the whole block;
        // otherwise it is one picture for one pocket.
        const rc = rect();
        const inside = rc && rg.r0 >= rc.r0 && rg.r0 <= rc.r1 &&
                       rg.c0 >= rc.c0 && rg.c0 <= rc.c1;
        onFileDrop?.(files, {
          cols: inside ? rc.c1 - rc.c0 + 1 : 1,
          rows: inside ? rc.r1 - rc.r0 + 1 : 1,
          region: inside ? L.regionAt(page, rc.r0, rc.c0) : rg,
        });
        return;
      }
      if (cardId) {
        rg.card = cardId;
        rg.upload = null;
        rg.empty = false;
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

  /**
   * Drop an insert so it occupies exactly the pockets it was cropped for.
   * The block is anchored at the pocket you dropped on, then pulled back if it
   * would run off the edge.
   */
  function dropInsert(rg, id) {
    const item = inserts.get(id);
    if (!item) return;
    if (item.cols > page.cols || item.rows > page.rows) {
      onNotice?.(
        `That insert fills ${item.cols}×${item.rows} pockets, more than this ` +
        `${page.cols}×${page.rows} page holds.`, 'error');
      return;
    }

    const touched = L.placeInsert(page, rg.r0, rg.c0, id, item.cols, item.rows);
    if (!touched || !touched.length) return;
    // Select the whole block, so Clear empties the picture rather than a corner.
    anchor = touched[0];
    focus = touched[touched.length - 1];
    commit();
  }

  /**
   * Repaint only the selection outlines. Selecting never changes the page
   * structure, so gestures must not rebuild the grid: a rebuild destroys the
   * element under the pointer mid-press, and the browser then re-fires (or
   * drops) the boundary events against the replacement nodes.
   */
  function paintSelection() {
    if (!page) return;
    const rc = rect();
    for (const rg of page.regions) {
      const on = !!rc &&
        rg.r0 <= rc.r1 && rg.r1 >= rc.r0 && rg.c0 <= rc.c1 && rg.c1 >= rc.c0;
      regionEl(rg.id)?.classList.toggle('selected', on);
    }
    announce();
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

  window.addEventListener('pointermove', (e) => {
    if (!down || !start) return;
    // The same lost-release guard as the sweep: a move with no button held
    // means the pointerup happened somewhere we never heard it.
    if (e.buttons === 0) { endGesture(); return; }
    // A press on a card becomes a move once it travels past the threshold.
    if (kind === 'pending-move') {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) <= MOVE_THRESHOLD) return;
      kind = 'move';
      anchor = start.rg; focus = start.rg; // a move keeps just the source selected
      regionEl(start.rg.id)?.classList.add('source');
      paintSelection();
    }
    if (kind === 'move') {
      const over = document.elementFromPoint(e.clientX, e.clientY);
      setDropTarget(over && over.closest('.region'));
    }
  });

  window.addEventListener('pointerup', (e) => {
    if (!down) return;
    if (kind === 'move') {
      const over = document.elementFromPoint(e.clientX, e.clientY);
      const targetId = over?.closest('.region')?.dataset.id;
      const fromId = start.rg.id;
      endGesture();
      // The target may sit on the other page of a spread, so the app resolves
      // both ends and performs the swap; here we just report the two pockets.
      if (targetId && targetId !== fromId && onMove) onMove(fromId, targetId);
      return;
    }
    // A click or a finished sweep: just stop. The selection stays as it is.
    endGesture();
  });

  // If the OS or browser cancels the pointer (native drag, gesture steal), or
  // the window loses focus mid-press, drop the half-finished gesture so it
  // never keeps tracking the loose mouse.
  window.addEventListener('pointercancel', endGesture);
  window.addEventListener('blur', endGesture);
  // Belt and braces: never let a native drag begin from inside the page grid.
  grid.addEventListener('dragstart', (e) => {
    if (e.target.closest('.region')) e.preventDefault();
  });

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
    /** Select a region on this page by id (used after a cross-page move). */
    selectRegion(id) {
      const rg = L.findRegion(page, id);
      anchor = rg; focus = rg;
      render();
    },

    assignCard(cardId) {
      const regions = selectedRegions();
      const target = regions[0] || page.regions[0];
      if (!target) return;
      target.card = cardId;
      target.upload = null;
      target.slice = null;
      target.empty = false;
      anchor = target; focus = target;
      commit();
    },
    /**
     * Place an insert. Given a region it lands there; otherwise it goes to the
     * current selection.
     */
    placeInsert(id, rg) {
      const target = (rg && L.findRegion(page, rg.id)) || selectedRegions()[0] || page.regions[0];
      if (target) dropInsert(target, id);
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
        if (makeEmpty) { rg.card = null; rg.upload = null; rg.slice = null; }
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
