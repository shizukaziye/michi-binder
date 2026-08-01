#!/usr/bin/env python3
"""Build the card index the site ships with.

The plain REST dump (/v2/en/cards) gives only id/name/image -- no rarity, no
illustrator -- and fetching 23k cards one at a time is not worth it. The
GraphQL endpoint returns fully resolved cards, and every card has exactly one
rarity, so sweeping the ~40 values from /v2/en/rarities covers the catalogue in
40 queries.

Writes data/cards.json and data/sets.json.
"""

import json
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API = "https://api.tcgdex.net/v2/en"
GRAPHQL = "https://api.tcgdex.net/v2/graphql"

# Second source. TCGdex knows about roughly 2,000 cards it holds no scan for --
# Shiny Vault, the Trainer and Galarian Galleries, and a lot of promos, which is
# exactly the artwork people build display pages from. pokemontcg.io has those
# scans, and its card numbers match TCGdex's, so it fills the gaps.
PTCG_API = "https://api.pokemontcg.io/v2"
PTCG_IMG = "https://images.pokemontcg.io"

OUT = Path(__file__).resolve().parent.parent / "data"

UA = "michi-binder-index-builder (+https://github.com/shizukaziye/michi-binder)"


def get_json(url, data=None, tries=4):
    """GET, or POST when data is given. Retries on transient failures."""
    body = json.dumps(data).encode() if data is not None else None
    headers = {"User-Agent": UA}
    if body:
        headers["Content-Type"] = "application/json"

    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=body, headers=headers)
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read().decode())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt == tries - 1:
                raise
            wait = 2 ** attempt
            print(f"    retry in {wait}s ({exc})", file=sys.stderr)
            time.sleep(wait)


CARD_QUERY = """
query ($rarity: String!) {
  cards(filters: {rarity: $rarity}) {
    id
    localId
    name
    rarity
    illustrator
    image
  }
}
"""


def fetch_rarity(rarity):
    payload = {"query": CARD_QUERY, "variables": {"rarity": rarity}}
    result = get_json(GRAPHQL, payload)
    if "errors" in result:
        raise RuntimeError(f"GraphQL error for {rarity!r}: {result['errors']}")
    return result["data"]["cards"] or []


def set_id_from_card_id(card_id):
    """'sv08-247' -> 'sv08'. Card numbers can contain dashes, set ids cannot."""
    return card_id.rsplit("-", 1)[0]


# TCGdex leaves the image field null for the gallery subsets (Trainer Gallery,
# Galarian Gallery, Shiny Vault) and for some special sets (Shining Legends,
# Dragon Majesty). The scans still exist, but under an asset folder that is not
# the set id: gallery cards sit in the PARENT set's folder (swsh12.5gg -> swsh12.5,
# swsh9.5tg -> swsh9), and dotted sets drop the dot (sm3.5 -> sm35). The mapping
# is not a clean rule, so we try each candidate and keep the one that resolves.
GALLERY_SUFFIXES = ("gg", "tg", "sv")


_serie_cache = {}


def serie_from_detail(set_id):
    """The series id for a set, from its own metadata (cached). The set id is not
    the series folder: 'mep' lives under 'me', 'swsh12.5gg' under 'swsh'."""
    if set_id not in _serie_cache:
        try:
            d = get_json(f"{API}/sets/{set_id}")
            _serie_cache[set_id] = (d.get("serie") or {}).get("id")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            _serie_cache[set_id] = None
    return _serie_cache[set_id]


def candidate_folders(set_id):
    """Asset folders an unlinked image might live under, most likely first."""
    cands = []

    def add(x):
        if x and x not in cands:
            cands.append(x)

    for suf in GALLERY_SUFFIXES:  # gallery cards live under the parent set folder
        if set_id.endswith(suf) and len(set_id) > len(suf):
            base = set_id[: -len(suf)]
            add(base)                              # swsh12.5gg -> swsh12.5
            if "." in base:
                add(base.split(".")[0])            # swsh9.5tg -> swsh9
            add(base.replace(".", ""))
    if "." in set_id:
        add(set_id.replace(".", ""))               # sm3.5 -> sm35
    add(set_id)
    return cands


def recoverable(set_id, local_id):
    """Any card with a number is worth a try; the URL is verified before keeping."""
    return bool(local_id)


def image_exists(url):
    """True if the asset resolves. A one-byte range keeps it off the wire."""
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": UA, "Range": "bytes=0-0"}
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status in (200, 206)
    except urllib.error.HTTPError as exc:
        return exc.code in (200, 206)
    except (urllib.error.URLError, TimeoutError):
        return False


def normalise(name):
    return re.sub(r"[^a-z0-9]+", "", (name or "").lower())


def ptcg_sets():
    """pokemontcg.io's sets, keyed by squashed name.

    Their set ids do not match TCGdex's -- sv08 against sv8, swsh12.5gg against
    swsh12pt5gg -- but the names are identical, so match on those.
    """
    out = {}
    page = 1
    while True:
        data = get_json(f"{PTCG_API}/sets?page={page}&pageSize=250")
        rows = data.get("data") or []
        for s in rows:
            out.setdefault(normalise(s["name"]), s["id"])
        if len(rows) < 250:
            return out
        page += 1


def ptcg_set_candidates(set_id, set_names, ptcg):
    """Which pokemontcg.io set a TCGdex set might be, best guess first."""
    out = []

    def add(x):
        if x and x not in out:
            out.append(x)

    add(ptcg.get(normalise(set_names.get(set_id, ""))))   # names match where both have the set
    add(set_id)                                            # smp, swshp, ecard2 are already the same
    add(set_id.replace(".", ""))                           # sm3.5 -> sm35
    add(set_id.replace(".", "pt"))                         # swsh12.5gg -> swsh12pt5gg
    add(set_id.replace("-", ""))
    return out


def ptcg_number_forms(local_id):
    """Card-number spellings to try.

    pokemontcg.io drops leading zeros where TCGdex keeps them -- svp/85 against
    svp/085 -- which alone accounts for a few hundred cards. Suffixed numbers
    like Aquapolis' 50a are left alone on purpose: 50a and 50b are separate
    cards, and trimming the letter would give them both the same picture.
    """
    forms = [local_id]
    stripped = local_id.lstrip("0")
    if stripped and stripped != local_id:
        forms.append(stripped)
    return forms


def probe_card(pid, local_id):
    """The first URL shape that resolves for this card, or None."""
    for form in ptcg_number_forms(local_id):
        url = f"{PTCG_IMG}/{pid}/{form}"
        if image_exists(f"{url}.png"):
            return url
    return None


def recover_from_ptcg(pending, cards, set_names):
    """Fill in cards TCGdex has no scan for, a set at a time.

    Every URL is checked before it is kept, and a set is only worked through
    once a sample proves the numbering lines up, so a wrong guess costs a few
    requests rather than a few hundred bogus entries.
    """
    try:
        ptcg = ptcg_sets()
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"  pokemontcg.io set list unreachable ({exc})", file=sys.stderr)
        ptcg = {}

    by_set = {}
    for cid, rec in pending.items():
        if cid not in cards and rec.get("l"):
            by_set.setdefault(rec["s"], []).append((cid, rec))

    found = 0
    sets_done = 0
    for set_id, items in sorted(by_set.items()):
        # Settle on one set id by sampling, so the rest of the set is one guess.
        pid = None
        for cand in ptcg_set_candidates(set_id, set_names, ptcg):
            if any(probe_card(cand, rec["l"]) for _c, rec in items[:4]):
                pid = cand
                break
        if not pid:
            continue

        with ThreadPoolExecutor(max_workers=8) as pool:
            urls = list(pool.map(lambda it: probe_card(pid, it[1]["l"]), items))

        hits = 0
        for (cid, rec), url in zip(items, urls):
            if not url:
                continue
            rec["u"] = url
            rec["p"] = "p"        # provider: pokemontcg.io, a different URL shape
            cards[cid] = rec
            hits += 1
        if hits:
            sets_done += 1
            found += hits
            print(f"    {set_id:<14} -> {pid:<14} {hits:>4} scans")
    return found, sets_done


def main():
    print("fetching rarities...")
    rarities = get_json(f"{API}/rarities")
    print(f"  {len(rarities)} rarities")

    cards = {}
    pending = {}  # gallery cards with a null image, recovered after the sweep
    for i, rarity in enumerate(rarities, 1):
        rows = fetch_rarity(rarity)
        kept = 0
        for c in rows:
            rec = {
                "i": c["id"],
                "n": c["name"],
                "l": c.get("localId") or "",
                "r": c.get("rarity") or "",
                "a": c.get("illustrator") or "",
                "s": set_id_from_card_id(c["id"]),
            }
            if c.get("image"):
                # image base; the site appends /high.webp or /low.webp
                rec["u"] = c["image"]
                cards[c["id"]] = rec
                kept += 1
            elif recoverable(rec["s"], rec["l"]):
                # A gallery / dotted set whose image we may rebuild by hand.
                pending[c["id"]] = rec
        print(f"  [{i:2}/{len(rarities)}] {rarity:<32} {len(rows):>5} rows, {kept:>5} with art")

    # Rebuild the unlinked images from each set's real asset folder. The series
    # and folder are not the set id (mep lives at me/mep, sm3.5 at sm/sm35,
    # gallery cards under the parent set), so resolve the series from cards that
    # do have images, fall back to set metadata, and verify every URL. Work a set
    # at a time and skip whole sets that have no scans, to keep the build quick.
    serie_by_set = {}
    for c in cards.values():
        parts = c["u"].split("/")
        if "en" in parts:
            j = parts.index("en")
            if j + 1 < len(parts):
                serie_by_set.setdefault(c["s"], parts[j + 1])

    by_set = {}
    for cid, rec in pending.items():
        by_set.setdefault(rec["s"], []).append((cid, rec))

    recovered = 0
    sets_done = 0
    for set_id, items in by_set.items():
        serie = serie_by_set.get(set_id) or serie_from_detail(set_id)
        if not serie:
            continue
        folders = candidate_folders(set_id)
        # Find which folder these images live in by probing a few of the cards.
        working = None
        for _cid, rec in items[:4]:
            for folder in folders:
                if image_exists(f"https://assets.tcgdex.net/en/{serie}/{folder}/{rec['l']}/high.webp"):
                    working = folder
                    break
            if working:
                break
        if not working:
            continue
        sets_done += 1
        for cid, rec in items:
            base = f"https://assets.tcgdex.net/en/{serie}/{working}/{rec['l']}"
            if image_exists(f"{base}/high.webp"):
                rec["u"] = base
                cards[cid] = rec
                recovered += 1
    print(f"recovered {recovered} cards from {sets_done} sets "
          f"({len(pending)} null-image candidates)")

    print("fetching sets...")
    raw_sets = get_json(f"{API}/sets")
    set_names = {s["id"]: s["name"] for s in raw_sets}

    # Whatever TCGdex simply has no scan for, try the second source.
    still_missing = sum(1 for cid in pending if cid not in cards)
    print(f"filling {still_missing} remaining gaps from pokemontcg.io...")
    borrowed, borrowed_sets = recover_from_ptcg(pending, cards, set_names)
    print(f"  added {borrowed} cards from {borrowed_sets} sets")

    sets = {}
    for s in raw_sets:
        sets[s["id"]] = {
            "i": s["id"],
            "n": s["name"],
            "d": (s.get("releaseDate") or ""),
        }

    # Any set id we derived but that the sets list does not know about still
    # needs a display name, or the UI shows a blank.
    for c in cards.values():
        if c["s"] not in sets:
            sets[c["s"]] = {"i": c["s"], "n": c["s"], "d": ""}

    OUT.mkdir(parents=True, exist_ok=True)
    card_list = sorted(cards.values(), key=lambda c: (c["n"].lower(), c["i"]))
    set_list = sorted(sets.values(), key=lambda s: (s["d"] or "", s["i"]))

    (OUT / "cards.json").write_text(
        json.dumps(card_list, separators=(",", ":"), ensure_ascii=False), encoding="utf-8"
    )
    (OUT / "sets.json").write_text(
        json.dumps(set_list, separators=(",", ":"), ensure_ascii=False), encoding="utf-8"
    )

    cards_kb = (OUT / "cards.json").stat().st_size / 1024
    artists = {c["a"] for c in card_list if c["a"]}
    print(
        f"\nwrote {len(card_list)} cards ({cards_kb:.0f} KB), "
        f"{len(set_list)} sets, {len(artists)} artists"
    )
    if len(card_list) < 15000:
        print("WARNING: card count looks low, check the API", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
