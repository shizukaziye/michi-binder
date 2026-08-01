// The print view.
//
// On screen the pockets sit apart so the page is easy to read. In print they
// sit flush at exactly 63x88 mm, so the slices of an insert that covers several
// pockets line back up into the whole picture before you cut them apart.

import { CARD_W, CARD_H, sliceStyle } from './editor.js';
import { getCard, imageUrl, imageFallback, cardLabel } from './data.js';
import * as inserts from './inserts.js';

// A4 minus a 10 mm margin each side: the short edge gives 190 mm, the long 277.
const A4_SHORT = 190;
const A4_LONG = 277;

const printable = (orientation) =>
  orientation === 'landscape' ? { w: A4_LONG, h: A4_SHORT } : { w: A4_SHORT, h: A4_LONG };

export function fitsOnA4(page) {
  return page.cols * CARD_W <= A4_SHORT && page.rows * CARD_H <= A4_LONG;
}

/** The scale that fits a page inside a printable area. 1 means it fits true-size. */
export function scaleFor(page, w = A4_SHORT, h = A4_LONG) {
  return Math.min(1, w / (page.cols * CARD_W), h / (page.rows * CARD_H));
}

/** The sheet orientation that lets the biggest page print largest. */
function bestOrientation(pages) {
  let portrait = 1;
  let landscape = 1;
  for (const pg of pages) {
    portrait = Math.min(portrait, scaleFor(pg, A4_SHORT, A4_LONG));
    landscape = Math.min(landscape, scaleFor(pg, A4_LONG, A4_SHORT));
  }
  return landscape > portrait ? 'landscape' : 'portrait';
}

export function oversizeNote(page) {
  if (fitsOnA4(page)) return '';
  const w = (page.cols * CARD_W).toFixed(0);
  const h = (page.rows * CARD_H).toFixed(0);
  return `A ${page.cols}×${page.rows} page is ${w}×${h} mm — larger than a card-size A4 sheet. ` +
         `Printing shrinks it to fit so every pocket shows; print on A3 for cards at true size.`;
}

function drawPage(page, area) {
  const wrap = document.createElement('section');
  wrap.className = 'print-page';

  // Always scale to fit the sheet so nothing runs off the edge.
  const scale = scaleFor(page, area.w, area.h);
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

    if (src && rg.slice) {
      // Pockets print flush, so the slices of one picture line back up into it.
      const part = document.createElement('div');
      part.className = 'print-slice';
      Object.assign(part.style, sliceStyle(src, rg.slice));
      cell.append(part);
    } else if (src) {
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
export async function printBinder(binder, orientation, container) {
  const orient = (orientation === 'portrait' || orientation === 'landscape')
    ? orientation : bestOrientation(binder.pages);
  const area = printable(orient);

  // Point the sheet the right way for this run; the injected rule wins because
  // it comes after the stylesheet in the cascade.
  let sheet = document.getElementById('print-orientation');
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.id = 'print-orientation';
    document.head.append(sheet);
  }
  sheet.textContent = `@media print { @page { size: A4 ${orient}; margin: 10mm; } }`;

  container.replaceChildren();
  for (const page of binder.pages) container.append(drawPage(page, area));

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
