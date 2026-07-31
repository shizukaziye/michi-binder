# Michi Binder

Design Pokémon card binder pages the Michi way: spread one artwork across
several pockets, leave pockets blank on purpose, then print inserts at true
card size.

**Live: https://shizukaziye.github.io/michi-binder/**

## What it does

- Search 21,000+ cards by name, artist or set. The index ships with the page,
  so searching does not hit the network.
- Pages from 1×1 up to 4×4, with 2×2, 3×3 and 4×4 presets.
- Select any rectangle of pockets and **merge** it into one panel. The artwork
  spreads across the whole block and cut guides show where the pockets divide.
- Mark a pocket as **blank on purpose**, which the method treats as a choice
  rather than a gap.
- **Your own inserts.** Drop an image on the panel, paste one, or drop it
  straight onto the page. Choose how many pockets it should fill, frame it in
  the cropper, and it joins a library you can reuse. Drag one onto a page and it
  claims exactly the pockets it was cut for.
- Several named binders, each with as many pages as you like. Everything saves
  in the browser as you go.
- Export a binder to a file, or copy a link that carries the whole design.
- Print at 63×88 mm with the pockets flush, so a panel stays continuous across
  the cards you cut out of it.

## Running it

It is plain HTML, CSS and modules — no build step. The modules need a real
server rather than `file://`:

```bash
python -m http.server 8731
```

## Rebuilding the index

`data/cards.json` and `data/sets.json` come from [TCGdex](https://tcgdex.dev).

```bash
python scripts/build_index.py
```

The REST card dump carries no rarity or artist, and fetching 23,000 cards one
at a time is not worth it, so the script sweeps the rarity list through the
GraphQL endpoint instead — about 40 queries for the whole catalogue. Cards
without artwork are dropped.

A GitHub Action reruns this every Monday and commits anything new.

## Notes

- Card images load from TCGdex's CDN, which sends no CORS header. That is why
  export is print and PDF rather than a PNG: a canvas holding those images is
  tainted and cannot be saved. Printing works regardless, and suits the
  print-inserts-on-cardstock workflow.
- A 4×4 page is 252×352 mm and does not fit A4. Print it on A3, or use
  "fit to page" for a proof you should not cut cards from.
- Inserts are cropped at 744 px across a pocket, which is 300 dpi at 63 mm, and
  kept in IndexedDB. localStorage would be full after a handful — a 2×2 insert
  runs past a megabyte — and IndexedDB stores the image itself rather than
  base64, which is a third smaller again. Anything see-through resolves against
  white, since inserts get printed on white card.
- Share links carry the layout and the card ids, not your inserts. Export
  inlines them into the file instead.

## Credits

Card data and images from [TCGdex](https://tcgdex.dev). Pokémon and all card
artwork are © Nintendo / Creatures Inc. / GAME FREAK inc. This is an unofficial
fan tool with no affiliation and nothing for sale.
