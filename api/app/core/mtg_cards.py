"""Decklist parsing + Scryfall name resolution for Cheddar MTG.

No rules engine lives here (or anywhere in this game) — this module's only
job is turning a pasted decklist into real card names, images, and Scryfall
ids, cached locally so repeat imports of the same cards don't keep re-
hitting Scryfall.
"""

import re

import httpx
from sqlalchemy.orm import Session

from app.models.mtg_card_cache import MtgCardCache

# Matches the plain-text decklist format nearly every deckbuilder (Moxfield,
# Archidekt, TappedOut, MTGGoldfish) and MTG Arena's own export share:
# "<qty>[x] <name>[ (SET) collector-number]". A leading "x" after the
# quantity and a trailing set/collector suffix are both optional.
_LINE_RE = re.compile(r"^(\d+)\s*x?\s+(.+)$", re.IGNORECASE)
_SET_SUFFIX_RE = re.compile(r"\s+\([A-Za-z0-9]{2,6}\)(?:\s+[A-Za-z0-9-]+)?\s*$")
_HEADER_LINES = {"deck", "deck:", "mainboard", "mainboard:", "commander", "commander:"}

SCRYFALL_COLLECTION_URL = "https://api.scryfall.com/cards/collection"
_COLLECTION_BATCH_SIZE = 75


def parse_decklist(text: str) -> list[tuple[int, str]]:
    """Returns [(quantity, name), ...] for the maindeck section only —
    parsing stops at a "Sideboard" header, since Reverse Mode aside, this
    game doesn't model a sideboard (no games between matches to swap for)."""
    entries: list[tuple[int, str]] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        low = line.lower()
        if low.startswith("sideboard"):
            break
        if low in _HEADER_LINES:
            continue
        match = _LINE_RE.match(line)
        if not match:
            continue
        quantity = int(match.group(1))
        name = _SET_SUFFIX_RE.sub("", match.group(2)).strip()
        if name:
            entries.append((quantity, name))
    return entries


def _extract_image_url(card: dict) -> str | None:
    uris = card.get("image_uris")
    if uris:
        return uris.get("normal") or uris.get("large") or uris.get("png")
    # Double-faced cards carry images per-face instead of at the top level —
    # the front face is good enough for a board image (flipping/transform
    # is a manual honor-system action like everything else here).
    faces = card.get("card_faces") or []
    if faces:
        uris = faces[0].get("image_uris")
        if uris:
            return uris.get("normal") or uris.get("large")
    return None


async def _fetch_from_scryfall(names: list[str]) -> tuple[dict[str, dict], list[str]]:
    resolved: dict[str, dict] = {}
    not_found: list[str] = []
    async with httpx.AsyncClient(timeout=15) as client:
        for i in range(0, len(names), _COLLECTION_BATCH_SIZE):
            chunk = names[i : i + _COLLECTION_BATCH_SIZE]
            resp = await client.post(SCRYFALL_COLLECTION_URL, json={"identifiers": [{"name": n} for n in chunk]})
            resp.raise_for_status()
            data = resp.json()
            for card in data.get("data", []):
                resolved[card["name"].lower()] = {
                    "name": card["name"],
                    "scryfall_id": card["id"],
                    "image_url": _extract_image_url(card),
                    "mana_cost": card.get("mana_cost"),
                    "type_line": card.get("type_line"),
                    "oracle_text": card.get("oracle_text"),
                }
            for miss in data.get("not_found", []):
                if miss.get("name"):
                    not_found.append(miss["name"])
    return resolved, not_found


async def resolve_decklist(db: Session, entries: list[tuple[int, str]]) -> tuple[list[dict], list[str]]:
    """Resolves each (quantity, name) pair against the local cache first,
    then Scryfall for whatever's missing. Returns (cards, unresolved_names)
    where `cards` has one {name, scryfall_id, image_url} dict per physical
    copy (quantity already expanded) and `unresolved_names` lists input
    names Scryfall couldn't match at all."""
    unique_names = sorted({name for _, name in entries}, key=str.lower)
    name_keys = [n.lower() for n in unique_names]

    cache_rows = db.query(MtgCardCache).filter(MtgCardCache.name_key.in_(name_keys)).all()
    resolved: dict[str, dict] = {
        row.name_key: {"name": row.name, "scryfall_id": row.scryfall_id, "image_url": row.image_url} for row in cache_rows
    }

    missing = [n for n in unique_names if n.lower() not in resolved]
    not_found: list[str] = []
    if missing:
        fetched, not_found = await _fetch_from_scryfall(missing)
        for key, card in fetched.items():
            db.add(
                MtgCardCache(
                    name_key=key,
                    name=card["name"],
                    scryfall_id=card["scryfall_id"],
                    image_url=card["image_url"],
                    mana_cost=card["mana_cost"],
                    type_line=card["type_line"],
                    oracle_text=card["oracle_text"],
                )
            )
            resolved[key] = {"name": card["name"], "scryfall_id": card["scryfall_id"], "image_url": card["image_url"]}
        db.commit()

    cards: list[dict] = []
    unresolved_names: list[str] = []
    for quantity, name in entries:
        card = resolved.get(name.lower())
        if card is None:
            unresolved_names.append(name)
            continue
        cards.extend({**card} for _ in range(quantity))
    return cards, unresolved_names
