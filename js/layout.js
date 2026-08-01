// The page model.
//
// A page is a rows x cols grid of pockets, and a pocket is always one pocket --
// nothing on a page ever spans two. That matches the real thing: artwork
// covering a block gets cut into separate cards, each sleeved on its own.
//
// A picture spread over several pockets is therefore not one big region but a
// block of ordinary pockets, each carrying the same insert plus a `slice`
// saying which part of it to show.

export const MIN_DIM = 1;
// Up to 8 so two pages can combine into a spread (e.g. 4x3 + 4x3 = 8x3).
export const MAX_DIM = 8;

let nextId = 1;
const newId = () => `r${nextId++}`;

export function makeRegion(r0, c0, r1, c1) {
  return {
    id: newId(),
    r0, c0, r1, c1,
    card: null,     // card id from the index
    upload: null,   // key into the uploads store
    // Which part of a multi-pocket picture this pocket shows, as
    // { cols, rows, c, r }. Null when the art fills this pocket on its own.
    slice: null,
    fit: 'cover',
    empty: false,   // left blank on purpose, not merely unfilled
  };
}

/** A pocket at (r, c) holding nothing. */
export const makeCell = (r, c) => makeRegion(r, c, r, c);

export function makePage(rows = 3, cols = 3) {
  const page = { rows, cols, name: '', spread: false, regions: [] };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) page.regions.push(makeRegion(r, c, r, c));
  }
  return page;
}

export const spanRows = (rg) => rg.r1 - rg.r0 + 1;
export const spanCols = (rg) => rg.c1 - rg.c0 + 1;
export const isSingle = (rg) => spanRows(rg) === 1 && spanCols(rg) === 1;

export function regionAt(page, r, c) {
  return page.regions.find(
    (rg) => r >= rg.r0 && r <= rg.r1 && c >= rg.c0 && c <= rg.c1
  ) || null;
}

export function findRegion(page, id) {
  return page.regions.find((rg) => rg.id === id) || null;
}

/** Normalised rectangle spanning two pockets, clamped to the page. */
export function rectBetween(page, a, b) {
  return {
    r0: Math.max(0, Math.min(a.r, b.r)),
    c0: Math.max(0, Math.min(a.c, b.c)),
    r1: Math.min(page.rows - 1, Math.max(a.r, b.r)),
    c1: Math.min(page.cols - 1, Math.max(a.c, b.c)),
  };
}

/**
 * Fill any pocket left without a region. Merging drops whole regions that
 * straddle the selection, which can leave holes outside it; those become 1x1s.
 */
export function fillGaps(page) {
  for (let r = 0; r < page.rows; r++) {
    for (let c = 0; c < page.cols; c++) {
      if (!regionAt(page, r, c)) page.regions.push(makeRegion(r, c, r, c));
    }
  }
  sortRegions(page);
}

function sortRegions(page) {
  page.regions.sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0);
}

/**
 * Break any region that still spans several pockets into single ones.
 *
 * Pages saved before pockets were always 1x1 can hold spanning regions, so
 * every page is run through this on load. The look is preserved rather than
 * lost: the art is sliced across the pockets it used to cover, which is what
 * placing it today would produce anyway.
 */
export function flatten(page) {
  const out = [];
  for (const rg of page.regions) {
    if (isSingle(rg)) {
      out.push(rg);
      continue;
    }
    const cols = spanCols(rg);
    const rows = spanRows(rg);
    const art = rg.card || rg.upload;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = makeCell(rg.r0 + r, rg.c0 + c);
        if (art) {
          cell.card = rg.card;
          cell.upload = rg.upload;
          cell.slice = { cols, rows, c, r };
        } else if (r === 0 && c === 0) {
          cell.empty = rg.empty;
        }
        out.push(cell);
      }
    }
  }
  page.regions = out;
  sortRegions(page);
  return page;
}

/**
 * Change the grid size. Regions that still fit are kept, the rest are dropped
 * and the freed pockets become 1x1s, so shrinking never leaves art half off-page.
 */
export function resize(page, rows, cols) {
  rows = Math.min(MAX_DIM, Math.max(MIN_DIM, rows));
  cols = Math.min(MAX_DIM, Math.max(MIN_DIM, cols));
  page.rows = rows;
  page.cols = cols;
  page.regions = page.regions.filter((rg) => rg.r1 < rows && rg.c1 < cols);
  fillGaps(page);
  return page;
}

export function clearRegion(rg) {
  rg.card = null;
  rg.upload = null;
  rg.slice = null;
  rg.empty = false;
}

/** Swap the contents of two regions, for dragging art around the page. */
export function swapContents(a, b) {
  const keep = {
    card: a.card, upload: a.upload, slice: a.slice, empty: a.empty, fit: a.fit,
  };
  a.card = b.card; a.upload = b.upload; a.slice = b.slice;
  a.empty = b.empty; a.fit = b.fit;
  b.card = keep.card; b.upload = keep.upload; b.slice = keep.slice;
  b.empty = keep.empty; b.fit = keep.fit;
}

/**
 * Lay an insert across the block of pockets it was cropped for, one slice each.
 *
 * The block is anchored at (r0, c0) and pulled back if it would run off the
 * page. Returns the pockets written to, or null when the page is too small.
 */
export function placeInsert(page, r0, c0, uploadId, cols, rows) {
  if (cols > page.cols || rows > page.rows) return null;
  const startC = Math.min(Math.max(0, c0), page.cols - cols);
  const startR = Math.min(Math.max(0, r0), page.rows - rows);

  const touched = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = regionAt(page, startR + r, startC + c);
      if (!cell) continue;
      cell.card = null;
      cell.upload = uploadId;
      // A single-pocket insert needs no slice; it simply fills its pocket.
      cell.slice = cols > 1 || rows > 1 ? { cols, rows, c, r } : null;
      cell.empty = false;
      touched.push(cell);
    }
  }
  return touched;
}

/** Every pocket showing the same insert as this one, itself included. */
export function sliceSiblings(page, rg) {
  if (!rg.upload || !rg.slice) return [rg];
  return page.regions.filter(
    (x) => x.upload === rg.upload && x.slice &&
           x.slice.cols === rg.slice.cols && x.slice.rows === rg.slice.rows
  );
}

export function filledCount(page) {
  return page.regions.filter((rg) => rg.card || rg.upload).length;
}

/** Re-seat the id counter after loading saved pages, so new ids stay unique. */
export function reseedIds(pages) {
  let max = 0;
  for (const p of pages) {
    for (const rg of p.regions) {
      const n = parseInt(String(rg.id).slice(1), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  nextId = max + 1;
}
