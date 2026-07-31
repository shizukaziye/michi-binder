// The print view.
//
// On screen the pockets sit apart so the page is easy to read. In print they
// sit flush at exactly 63x88 mm with hairline cut guides, because a panel has
// to stay continuous across the cards you cut out of it.

import { CARD_W, CARD_H } from './editor.js';
import { getCard, imageUrl, imageFallback, cardLabel } from './data.js';
import * as inserts from './inserts.js';
import { spanRows, spanCols } from './layout.js';

// A4 minus a 10 mm margin each side, the usable area for one binder page.
const SHEET_W = 190;
const SHEET_H = 277;

export function fitsOnA4(page) {
  return page.cols * CARD_W <= SHEET_W && page.rows * CARD_H <= SHEET_H;
}

/** How far a page has to shrink to sit on A4. 1 means it already fits. */
export function scaleFor(page) {
  return Math.min(1, SHEET_W / (page.cols * CARD_W), SHEET_H / (page.rows * CARD_H));
}

export function oversizeNote(page) {
  if (fitsOnA4(page)) return '';
  const w = (page.cols * CARD_W).toFixed(0);
  const h = (page.rows * CARD_H).toFixed(0);
  const pct = Math.round(scaleFor(page) * 100);
  return `A ${page.cols}×${page.rows} page is ${w}×${h} mm and will not fit A4 at true size. ` +
         `Print it on A3, or choose "fit to page" to shrink it to ${pct}% — handy as a proof, ` +
         `but do not cut cards from it.`;
}

function drawPage(page, mode) {
  const wrap = document.createElement('section');
  wrap.className = 'print-page';

  const scale = mode === 'fit' ? scaleFor(page) : 1;
  const grid = document.createElement('div');
  grid.className = 'print-grid';
  grid.style.width = `${page.cols * CARD_W * scale}mm`;
  grid.style.height = `${page.rows * CARD_H * scale}mm`;
  grid.style.gridTemplateColumns = `repeat(${page.cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${page.rows}, 1fr)`;

  for (const rg of page.regions) {
    const cell = document.createElement('div');
    cell.className = 'print-region';
    cell.style.gridArea = `${rg.r0 + 1} / ${rg.c0 + 1} / ${rg.r1 + 2} / ${rg.c1 + 2}`;

    let src = null;
    let alt = '';
    let fallback = null;
    const item = rg.upload ? inserts.get(rg.upload) : null;
    if (item) {
      src = item.url;
      alt = item.name || 'Insert';
    } else if (rg.card) {
      const card = getCard(rg.card);
      if (card) {
        src = imageUrl(card, 'high');
        fallback = imageFallback(card, 'high');
        alt = cardLabel(card);
      }
    }

    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = alt;
      img.className = `print-img fit-${rg.fit}`;
      if (fallback) {
        img.addEventListener('error', () => {
          if (!img.dataset.retried) { img.dataset.retried = '1'; img.src = fallback; }
        });
      }
      cell.append(img);
    }

    // Cut guides inside a spanned region.
    const rows = spanRows(rg);
    const cols = spanCols(rg);
    for (let i = 1; i < rows; i++) {
      const line = document.createElement('i');
      line.className = 'print-cut-h';
      line.style.top = `${(i / rows) * 100}%`;
      cell.append(line);
    }
    for (let i = 1; i < cols; i++) {
      const line = document.createElement('i');
      line.className = 'print-cut-v';
      line.style.left = `${(i / cols) * 100}%`;
      cell.append(line);
    }
    grid.append(cell);
  }

  wrap.append(grid);
  return wrap;
}

/**
 * Render every page of the binder into the print container, then hand off to
 * the browser's print dialogue. Images are given a moment to decode first, or
 * the sheet prints with gaps.
 */
export async function printBinder(binder, mode, container) {
  container.replaceChildren();
  for (const page of binder.pages) container.append(drawPage(page, mode));

  const images = [...container.querySelectorAll('img')];
  const settled = Promise.all(images.map((img) =>
    img.complete ? Promise.resolve() : new Promise((done) => {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    })
  ));
  // Never let one stalled image hold the dialogue shut; print what we have.
  await Promise.race([settled, new Promise((r) => setTimeout(r, 8000))]);
  // One frame so layout settles before the dialogue snapshots the page.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.print();
}
