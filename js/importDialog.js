// Asked on import: keep the file as its own binder, or add its pages to the end
// of one you already have.

/**
 * @returns {Promise<{mode: 'new'|'append', binderId?: string}|null>}
 *          null when the user backs out.
 */
export function askImport({ name, pageCount, binders, currentId }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    const pages = `${pageCount} page${pageCount === 1 ? '' : 's'}`;

    back.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="impTitle">
        <h2 id="impTitle">Import “${escapeHtml(name)}”</h2>
        <p class="crop-hint">${pages} to bring in.</p>

        <div class="choice-list" role="radiogroup" aria-labelledby="impTitle">
          <label class="choice">
            <input type="radio" name="impMode" value="new" checked>
            <span>
              <strong>As its own binder</strong>
              <small>Keeps it separate from everything else.</small>
            </span>
          </label>
          <label class="choice">
            <input type="radio" name="impMode" value="append">
            <span>
              <strong>Add to the end of an existing binder</strong>
              <small>The pages go on the back, and the binder keeps its name.</small>
            </span>
          </label>
        </div>

        <label class="sr-only" for="impTarget">Binder to add to</label>
        <select id="impTarget" class="btn select" disabled></select>

        <div class="modal-actions">
          <button type="button" id="impCancel" class="btn">Cancel</button>
          <button type="button" id="impGo" class="btn primary">Import</button>
        </div>
      </div>`;

    document.body.append(back);

    const target = back.querySelector('#impTarget');
    for (const b of binders) {
      const opt = document.createElement('option');
      opt.value = b.id;
      const n = b.pages?.length || 0;
      opt.textContent = `${b.name || 'Untitled binder'} (${n} page${n === 1 ? '' : 's'})`;
      if (b.id === currentId) opt.selected = true;
      target.append(opt);
    }

    const modeOf = () => back.querySelector('input[name="impMode"]:checked').value;
    back.querySelectorAll('input[name="impMode"]').forEach((r) => {
      r.addEventListener('change', () => {
        const append = modeOf() === 'append';
        target.disabled = !append;
        if (append) target.focus();
      });
    });

    function close(result) {
      document.removeEventListener('keydown', onKey);
      back.remove();
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
    }
    document.addEventListener('keydown', onKey);

    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(null); });
    back.querySelector('#impCancel').addEventListener('click', () => close(null));
    back.querySelector('#impGo').addEventListener('click', () => {
      const mode = modeOf();
      close(mode === 'append' ? { mode, binderId: target.value } : { mode });
    });

    back.querySelector('#impGo').focus();
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
