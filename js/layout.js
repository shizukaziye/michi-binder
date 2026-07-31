// The page model.
//
// A page is a rows x cols grid of pockets. It holds regions; a region covers a
// rectangle of pockets and carries one artwork. Every pocket belongs to exactly
// one region, so a fresh page is all 1x1 regions. Merging a rectangle is what
// makes a Michi panel: one picture spread over several pockets.

export const MIN_DIM = 1;
export const MAX_DIM = 4;

let nextId = 1;
const newId = () => `r${nextId++}`;

export function makeRegion(r0, c0, r1, c1) {
  return {
    id: newId(),
    r0, c0, r1, c1,
    card: null,     // card id from the index
    upload: null,   // key into the uploads store
    fit: 'cover',
    empty: false,   // left blank on purpose, not merely unfilled
  };
}

export function makePage(rows = 3, cols = 3) {
  const page = { rows, cols, regions: [] };
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

const overlaps = (rg, rect) =>
  rg.r0 <= rect.r1 && rg.r1 >= rect.r0 && rg.c0 <= rect.c1 && rg.c1 >= rect.c0;

/**
 * Fill any pocket left without a region. Merging drops whole regions that
 * straddle the selection, which can leave holes outside it; those become 1x1s.
 */
function fillGaps(page) {
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

export function canMerge(page, rect) {
  const multi = rect.r1 > rect.r0 || rect.c1 > rect.c0;
  if (!multi) return false;
  // Already exactly one region covering precisely this rectangle?
  const hit = page.regions.filter((rg) => overlaps(rg, rect));
  if (hit.length === 1 && hit[0].r0 === rect.r0 && hit[0].c0 === rect.c0 &&
      hit[0].r1 === rect.r1 && hit[0].c1 === rect.c1) return false;
  return true;
}

/**
 * Collapse a rectangle into one region. Any region touching the rectangle is
 * removed whole; the first artwork found is carried over so a merge started
 * from a filled pocket keeps its picture.
 */
export function merge(page, rect) {
  const touched = page.regions.filter((rg) => overlaps(rg, rect));
  const donor = touched.find((rg) => rg.card || rg.upload);
  page.regions = page.regions.filter((rg) => !overlaps(rg, rect));

  const merged = makeRegion(rect.r0, rect.c0, rect.r1, rect.c1);
  if (donor) {
    merged.card = donor.card;
    merged.upload = donor.upload;
  }
  page.regions.push(merged);
  fillGaps(page);
  return merged;
}

/** Break a region back into 1x1 pockets, keeping the art in the top-left one. */
export function split(page, id) {
  const rg = findRegion(page, id);
  if (!rg || isSingle(rg)) return null;
  page.regions = page.regions.filter((x) => x.id !== id);

  let first = null;
  for (let r = rg.r0; r <= rg.r1; r++) {
    for (let c = rg.c0; c <= rg.c1; c++) {
      const cell = makeRegion(r, c, r, c);
      if (!first) {
        first = cell;
        cell.card = rg.card;
        cell.upload = rg.upload;
        cell.empty = rg.empty;
      }
      page.regions.push(cell);
    }
  }
  sortRegions(page);
  return first;
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
  rg.empty = false;
}

/** Swap the contents of two regions, for dragging art around the page. */
export function swapContents(a, b) {
  const keep = { card: a.card, upload: a.upload, empty: a.empty, fit: a.fit };
  a.card = b.card; a.upload = b.upload; a.empty = b.empty; a.fit = b.fit;
  b.card = keep.card; b.upload = keep.upload; b.empty = keep.empty; b.fit = keep.fit;
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
