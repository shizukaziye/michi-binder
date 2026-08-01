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
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.tcgdex.net/v2/en"
GRAPHQL = "https://api.tcgdex.net/v2/graphql"
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


def serie_of(set_id):
    """The series folder in the asset path: 'swsh12.5gg' -> 'swsh', 'sm3.5' -> 'sm'."""
    import re
    m = re.match(r"^[a-z]+", set_id)
    return m.group(0) if m else None


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
    """Worth trying to rebuild: a gallery or dotted special set with a card number."""
    if not local_id or not serie_of(set_id):
        return False
    return "." in set_id or any(set_id.endswith(s) for s in GALLERY_SUFFIXES)


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

    # Rebuild the unlinked images from the set's real asset folder, keeping only
    # the ones that actually resolve.
    recovered = 0
    for cid, rec in pending.items():
        serie = serie_of(rec["s"])
        for folder in candidate_folders(rec["s"]):
            base = f"https://assets.tcgdex.net/en/{serie}/{folder}/{rec['l']}"
            if image_exists(f"{base}/high.webp"):
                rec["u"] = base
                cards[cid] = rec
                recovered += 1
                break
    print(f"recovered {recovered} cards (of {len(pending)} null-image candidates)")

    print("fetching sets...")
    raw_sets = get_json(f"{API}/sets")
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
