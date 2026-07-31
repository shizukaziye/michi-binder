// The crop window: pick how many pockets the picture should fill, frame it,
// and hand back a blob cut to exactly that shape.

import { PX_PER_POCKET } from './inserts.js';
import { CARD_W, CARD_H } from './editor.js';
import { MAX_DIM } from './layout.js';

const FRAME_MAX_W = 430;
const FRAME_MAX_H = 440;

/**
 * @returns {Promise<{blob: Blob, cols: number, rows: number, name: string}|null>}
 *          null when the user backs out.
 */
export function openCrop(file, { cols = 1, rows = 1, name = 'Insert' } = {}) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
      alert('That file is not an image this browser can read.');
    };

    img.onload = () => build(img, url, file, { cols, rows, name }, resolve);
    img.src = url;
  });
}

function build(img, url, file, opts, resolve) {
  let cols = opts.cols;
  let rows = opts.rows;
  let zoom = 1;
  let tx = 0;
  let ty = 0;
  let frameW = 0;
  let frameH = 0;

  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="cropTitle">
      <h2 id="cropTitle">Add an insert</h2>

      <div class="crop-size">
        <span class="tool-label">Fills</span>
        <label class="sr-only" for="cropCols">Pockets across</label>
        <select id="cropCols" class="btn select tiny"></select>
        <span class="times">×</span>
        <label class="sr-only" for="cropRows">Pockets down</label>
        <select id="cropRows" class="btn select tiny"></select>
        <span class="tool-label" id="cropMm"></span>
      </div>

      <div class="crop-stage">
        <div class="crop-frame" id="cropFrame">
          <img id="cropImg" alt="" draggable="false">
          <div class="crop-guides" id="cropGuides"></div>
        </div>
      </div>

      <div class="crop-zoom">
        <label for="cropZoom">Zoom</label>
        <input type="range" id="cropZoom" min="1" max="4" step="0.01" value="1">
        <button type="button" id="cropReset" class="btn">Reset</button>
      </div>

      <p class="crop-hint">Drag the picture to move it. Anything outside the frame is trimmed.</p>

      <div class="modal-actions">
        <button type="button" id="cropCancel" class="btn">Cancel</button>
        <button type="button" id="cropSave" class="btn primary">Add to library</button>
      </div>
    </div>`;

  document.body.append(back);

  const el = {
    cols: back.querySelector('#cropCols'),
    rows: back.querySelector('#cropRows'),
    mm: back.querySelector('#cropMm'),
    frame: back.querySelector('#cropFrame'),
    img: back.querySelector('#cropImg'),
    guides: back.querySelector('#cropGuides'),
    zoom: back.querySelector('#cropZoom'),
    reset: back.querySelector('#cropReset'),
    cancel: back.querySelector('#cropCancel'),
    save: back.querySelector('#cropSave'),
  };

  for (const sel of [el.cols, el.rows]) {
    for (let n = 1; n <= MAX_DIM; n++) {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      sel.append(o);
    }
  }
  el.cols.value = cols;
  el.rows.value = rows;
  el.img.src = url;

  /** Smallest zoom that still covers the frame, in natural-pixel terms. */
  const coverScale = () =>
    Math.max(frameW / img.naturalWidth, frameH / img.naturalHeight);

  function clamp() {
    const scale = coverScale() * zoom;
    const maxX = Math.max(0, (img.naturalWidth * scale - frameW) / 2);
    const maxY = Math.max(0, (img.naturalHeight * scale - frameH) / 2);
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
  }

  function layout() {
    const aspect = (cols * CARD_W) / (rows * CARD_H);
    frameW = Math.min(FRAME_MAX_W, FRAME_MAX_H * aspect);
    frameH = frameW / aspect;
    el.frame.style.width = `${frameW}px`;
    el.frame.style.height = `${frameH}px`;
    el.mm.textContent = `${cols * CARD_W} × ${rows * CARD_H} mm`;

    // Pocket divisions, so you can see where the picture will be cut.
    el.guides.replaceChildren();
    for (let i = 1; i < cols; i++) {
      const v = document.createElement('i');
      v.className = 'crop-v';
      v.style.left = `${(i / cols) * 100}%`;
      el.guides.append(v);
    }
    for (let i = 1; i < rows; i++) {
      const h = document.createElement('i');
      h.className = 'crop-h';
      h.style.top = `${(i / rows) * 100}%`;
      el.guides.append(h);
    }
    paint();
  }

  function paint() {
    clamp();
    const scale = coverScale() * zoom;
    el.img.style.width = `${img.naturalWidth * scale}px`;
    el.img.style.height = `${img.naturalHeight * scale}px`;
    el.img.style.transform =
      `translate(-50%, -50%) translate(${tx}px, ${ty}px)`;
  }

  // --- input ---------------------------------------------------------------

  let panning = false;
  let lastX = 0;
  let lastY = 0;

  el.frame.addEventListener('pointerdown', (e) => {
    panning = true;
    lastX = e.clientX;
    lastY = e.clientY;
    el.frame.setPointerCapture(e.pointerId);
    el.frame.classList.add('grabbing');
  });
  el.frame.addEventListener('pointermove', (e) => {
    if (!panning) return;
    tx += e.clientX - lastX;
    ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    paint();
  });
  const endPan = (e) => {
    if (!panning) return;
    panning = false;
    el.frame.releasePointerCapture?.(e.pointerId);
    el.frame.classList.remove('grabbing');
  };
  el.frame.addEventListener('pointerup', endPan);
  el.frame.addEventListener('pointercancel', endPan);

  el.frame.addEventListener('wheel', (e) => {
    e.preventDefault();
    const next = Math.min(4, Math.max(1, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    // Keep the middle of the frame steady as the picture grows.
    const ratio = next / zoom;
    tx *= ratio;
    ty *= ratio;
    zoom = next;
    el.zoom.value = String(zoom);
    paint();
  }, { passive: false });

  el.zoom.addEventListener('input', () => {
    const next = parseFloat(el.zoom.value);
    const ratio = next / zoom;
    tx *= ratio;
    ty *= ratio;
    zoom = next;
    paint();
  });

  el.reset.addEventListener('click', () => {
    zoom = 1; tx = 0; ty = 0;
    el.zoom.value = '1';
    paint();
  });

  const onSize = () => {
    cols = +el.cols.value;
    rows = +el.rows.value;
    zoom = 1; tx = 0; ty = 0;
    el.zoom.value = '1';
    layout();
  };
  el.cols.addEventListener('change', onSize);
  el.rows.addEventListener('change', onSize);

  // --- finish --------------------------------------------------------------

  function close(result) {
    document.removeEventListener('keydown', onKey);
    back.remove();
    URL.revokeObjectURL(url);
    resolve(result);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(null); }
  }
  document.addEventListener('keydown', onKey);

  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) close(null);
  });
  el.cancel.addEventListener('click', () => close(null));

  el.save.addEventListener('click', () => {
    el.save.disabled = true;
    el.save.textContent = 'Cutting…';

    const outW = Math.round(cols * CARD_W * (PX_PER_POCKET / CARD_W));
    const outH = Math.round(rows * CARD_H * (PX_PER_POCKET / CARD_W));
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    // Inserts get printed on white card, and JPEG has no transparency, so
    // anything see-through resolves against white rather than black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);

    const k = outW / frameW;
    const scale = coverScale() * zoom * k;
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.drawImage(img, outW / 2 + tx * k - dw / 2, outH / 2 + ty * k - dh / 2, dw, dh);

    canvas.toBlob((blob) => {
      if (!blob) { close(null); return; }
      close({ blob, cols, rows, name: opts.name || file.name || 'Insert' });
    }, 'image/jpeg', 0.88);
  });

  layout();
  el.save.focus();
}
