// The search panel: query box, filters, and the grid of results you drag onto
// the page.

import { search, imageUrl, imageFallback, cardLabel, setNameOf, state, ART_RARITIES }
  from './data.js';

export function mountSearch(root, { onPick }) {
  root.innerHTML = `
    <div class="search-head">
      <input type="search" id="q" class="search-input" autocomplete="off" spellcheck="false"
             placeholder="Search a card, artist or set" aria-label="Search cards">
      <div class="filter-row">
        <button type="button" id="artOnly" class="chip" aria-pressed="false"
                title="Show only the rarities worth displaying">Binder art</button>
        <select id="setFilter" class="chip select" aria-label="Filter by set">
          <option value="">All sets</option>
        </select>
        <details class="rarity-wrap">
          <summary class="chip" role="button">Rarity</summary>
          <div class="rarity-menu" id="rarityMenu"></div>
        </details>
      </div>
      <p class="result-count" id="count" role="status" aria-live="polite">Loading cards…</p>
    </div>
    <div class="results" id="results" tabindex="-1"></div>`;

  const els = {
    q: root.querySelector('#q'),
    artOnly: root.querySelector('#artOnly'),
    setFilter: root.querySelector('#setFilter'),
    rarityMenu: root.querySelector('#rarityMenu'),
    count: root.querySelector('#count'),
    results: root.querySelector('#results'),
  };

  const chosenRarities = new Set();
  let artOnly = false;

  function fillFilters() {
    const sets = [...state.sets].reverse(); // newest first
    for (const s of sets) {
      const opt = document.createElement('option');
      opt.value = s.i;
      opt.textContent = s.d ? `${s.n} (${s.d.slice(0, 4)})` : s.n;
      els.setFilter.append(opt);
    }
    for (const r of state.rarities) {
      const id = `rar-${r.replace(/\W+/g, '-')}`;
      const label = document.createElement('label');
      label.className = 'rarity-item';
      label.innerHTML =
        `<input type="checkbox" id="${id}" value="${r}"><span>${r}</span>`;
      label.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) chosenRarities.add(r); else chosenRarities.delete(r);
        artOnly = false;
        els.artOnly.setAttribute('aria-pressed', 'false');
        run();
      });
      els.rarityMenu.append(label);
    }
  }

  function activeRarities() {
    if (artOnly) return ART_RARITIES;
    return [...chosenRarities];
  }

  function run() {
    if (!state.ready) return;
    const { total, cards } = search(els.q.value, {
      rarities: activeRarities(),
      setId: els.setFilter.value,
    });

    els.count.textContent = total === 0
      ? 'No cards match. Try a shorter search or clear the filters.'
      : `${total.toLocaleString()} card${total === 1 ? '' : 's'}` +
        (total > cards.length ? ` — showing the first ${cards.length}` : '');

    els.results.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const card of cards) frag.append(resultTile(card));
    els.results.append(frag);
    els.results.scrollTop = 0;
  }

  function resultTile(card) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'result';
    tile.draggable = true;
    tile.dataset.cardId = card.i;
    tile.title = `${cardLabel(card)}${card.a ? ` — art by ${card.a}` : ''}`;

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = card.n;
    img.src = imageUrl(card, 'low');
    img.addEventListener('error', () => {
      // A few older scans have no webp; the png always exists.
      if (!img.dataset.retried) {
        img.dataset.retried = '1';
        img.src = imageFallback(card, 'low');
      } else {
        tile.classList.add('broken');
      }
    }, { once: false });

    const cap = document.createElement('span');
    cap.className = 'result-cap';
    cap.textContent = `${setNameOf(card)} ${card.l}`;

    tile.append(img, cap);
    tile.addEventListener('click', () => onPick(card.i));
    tile.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/michi-card', card.i);
      e.dataTransfer.effectAllowed = 'copy';
      tile.classList.add('dragging');
    });
    tile.addEventListener('dragend', () => tile.classList.remove('dragging'));
    return tile;
  }

  let timer;
  els.q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  });
  els.setFilter.addEventListener('change', run);
  els.artOnly.addEventListener('click', () => {
    artOnly = !artOnly;
    els.artOnly.setAttribute('aria-pressed', String(artOnly));
    if (artOnly) {
      chosenRarities.clear();
      els.rarityMenu.querySelectorAll('input').forEach((i) => { i.checked = false; });
    }
    run();
  });

  return {
    start() { fillFilters(); run(); },
    focus() { els.q.focus(); els.q.select(); },
  };
}
