// The insert library panel: drop or paste a picture, crop it to a pocket size,
// then drag it onto the page the same way you drag a card.

import * as inserts from './inserts.js';
import { openCrop } from './crop.js';

export function mountInserts(root, { onPlace, selectionSize, onToast }) {
  root.innerHTML = `
    <div class="drop-zone" id="dropZone" tabindex="0" role="button"
         aria-label="Add an image: drop it here, paste it, or press Enter to browse">
      <strong>Drop an image here</strong>
      <span>or paste with <kbd>Ctrl</kbd>+<kbd>V</kbd>, or click to browse</span>
    </div>
    <p class="result-count" id="insertCount"></p>
    <div class="results inserts" id="insertList"></div>
    <input type="file" id="insertFile" accept="image/*" multiple hidden>`;

  const els = {
    zone: root.querySelector('#dropZone'),
    list: root.querySelector('#insertList'),
    count: root.querySelector('#insertCount'),
    file: root.querySelector('#insertFile'),
  };

  function render() {
    const all = inserts.list();
    els.count.textContent = all.length
      ? `${all.length} insert${all.length === 1 ? '' : 's'} — ${inserts.formatBytes(inserts.usage())}`
      : 'Nothing here yet. Inserts you add are saved in this browser.';

    els.list.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const item of all) frag.append(tile(item));
    els.list.append(frag);
  }

  function tile(item) {
    const wrap = document.createElement('div');
    wrap.className = 'insert-tile';
    // Show the tile at the shape it will occupy on the page.
    wrap.style.gridColumn = `span ${Math.min(item.cols, 2)}`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'result insert-art';
    btn.draggable = true;
    btn.dataset.insertId = item.id;
    btn.title = `${item.name} — fills ${item.cols}×${item.rows}`;

    const img = document.createElement('img');
    img.src = item.url;
    img.alt = item.name;
    img.style.aspectRatio = `${item.cols * 63} / ${item.rows * 88}`;
    btn.append(img);

    const cap = document.createElement('span');
    cap.className = 'result-cap';
    cap.textContent = `${item.cols}×${item.rows}`;
    btn.append(cap);

    btn.addEventListener('click', () => onPlace(item.id));
    btn.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/michi-insert', item.id);
      e.dataTransfer.effectAllowed = 'copy';
      btn.classList.add('dragging');
    });
    btn.addEventListener('dragend', () => btn.classList.remove('dragging'));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'insert-del';
    del.title = `Delete "${item.name}"`;
    del.setAttribute('aria-label', `Delete ${item.name}`);
    del.textContent = '×';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete this insert? Pages using it will lose the picture.`)) return;
      await inserts.remove(item.id);
      render();
      onToast('Insert deleted.');
    });

    wrap.append(btn, del);
    return wrap;
  }

  /**
   * Run each dropped or pasted file through the cropper, one after another.
   * `where` is set when the picture was dropped straight onto a pocket: the
   * cropper opens at that pocket's size and the result lands there.
   */
  async function intake(files, where) {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) {
      onToast('That was not an image.', 'error');
      return;
    }
    for (const file of images) {
      const size = where || selectionSize();
      const result = await openCrop(file, {
        cols: size.cols,
        rows: size.rows,
        name: file.name?.replace(/\.[^.]+$/, '') || 'Insert',
      });
      if (!result) continue;
      try {
        const saved = await inserts.add(
          result.blob, result.cols, result.rows, result.name
        );
        render();
        if (where?.region) {
          onPlace(saved.id, where.region);
          onToast(`Added a ${result.cols}×${result.rows} insert and placed it.`);
        } else {
          onToast(`Added a ${result.cols}×${result.rows} insert. Drag it onto the page.`);
        }
      } catch (err) {
        onToast(err?.message || 'Could not save that insert.', 'error');
      }
    }
  }

  // --- drop, paste, browse -------------------------------------------------

  els.zone.addEventListener('click', () => els.file.click());
  els.zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.file.click(); }
  });
  els.file.addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    intake(files);
  });

  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  root.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    els.zone.classList.add('over');
  });
  root.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  root.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) els.zone.classList.remove('over');
  });
  root.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    els.zone.classList.remove('over');
    intake(e.dataTransfer.files);
  });

  return {
    render,
    intake,
    /** Paste anywhere in the app lands here. */
    handlePaste(clipboard) {
      const files = [...(clipboard?.files || [])];
      if (files.length) { intake(files); return true; }
      const items = [...(clipboard?.items || [])]
        .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .filter(Boolean);
      if (items.length) { intake(items); return true; }
      return false;
    },
  };
}
