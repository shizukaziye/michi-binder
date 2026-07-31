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


def main():
    print("fetching rarities...")
    rarities = get_json(f"{API}/rarities")
    print(f"  {len(rarities)} rarities")

    cards = {}
    for i, rarity in enumerate(rarities, 1):
        rows = fetch_rarity(rarity)
        kept = 0
        for c in rows:
            # No artwork means nothing to place in a binder.
            if not c.get("image"):
                continue
            cards[c["id"]] = {
                "i": c["id"],
                "n": c["name"],
                "l": c.get("localId") or "",
                "r": c.get("rarity") or "",
                "a": c.get("illustrator") or "",
                "s": set_id_from_card_id(c["id"]),
                # image base; the site appends /high.webp or /low.webp
                "u": c["image"],
            }
            kept += 1
        print(f"  [{i:2}/{len(rarities)}] {rarity:<32} {len(rows):>5} rows, {kept:>5} with art")

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
