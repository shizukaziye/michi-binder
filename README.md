# Michi Binder

Design Pokémon card binder pages the Michi way: spread one artwork across
several pockets, leave pockets blank on purpose, then print inserts at true
card size.

**Live: https://shizukaziye.github.io/michi-binder/**

## What it does

- Search 21,000+ cards by name, artist or set. The index ships with the page,
  so searching does not hit the network.
- Pages from 1×1 up to 4×4, with 2×2, 3×3 and 4×4 presets.
- **A pocket is always one pocket.** Nothing on a page spans two, which is how a
  binder really works: artwork covering a block is cut into separate cards and
  sleeved one by one.
- Mark a pocket as **blank on purpose**, which the method treats as a choice
  rather than a gap.
- **Your own inserts.** Drop an image on the panel, paste one, or drop it
  straight onto the page. Choose how many pockets it should fill, frame it in
  the cropper, and it joins a library you can reuse. Drag one onto a page and it
  divides itself across the pockets it was cut for, a piece to each — so you can
  clear or replace one piece without disturbing the rest.
- Several named binders, each with as many pages as you like. Everything saves
  in the browser as you go.
- Export a binder to a file, or copy a link that carries the whole design.
  Importing asks whether the file should be its own binder or have its pages
  added to the back of one you already have.
- Print at 63×88 mm with the pockets flush, so the pieces of an insert line back
  up into the whole picture before you cut them apart.

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
GraphQL endpoint instead — about 40 queries for the whole catalogue.

TCGdex knows about roughly 2,000 cards it holds no scan for, and they are not
obscure ones: Shiny Vault, the Trainer and Galarian Galleries, and a lot of
promos, which is exactly the artwork people build display pages from. The script
fills those gaps twice over:

1. Some are simply filed under a folder that is not the set id — gallery cards
   sit under the parent set, dotted sets drop the dot. Those are rebuilt and
   checked against the TCGdex CDN.
2. The rest are borrowed from [pokemontcg.io](https://pokemontcg.io), matched by
   set name, since the two number their cards the same way. Cards borrowed this
   way carry a `p` flag, because that CDN shapes its URLs differently:
   `_hires.png` on the card rather than `/high.webp` on a folder.

Every URL is then checked, borrowed or not. A non-null image field from TCGdex
is a claim rather than a promise: the whole of Pitch Black (`me05`) was listed
with image URLs long before any scan was uploaded, and all 120 of them 404.
Anything that fails is checked twice before being dropped, so a momentary
network fault cannot quietly delete half the index, and a build that loses more
than a tenth of the catalogue refuses to write at all.

Cards no source has a scan for are dropped rather than shown blank — they are
no use in a tool for choosing artwork. The weekly rebuild picks them up as soon
as the scans appear.

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
