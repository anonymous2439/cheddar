"""Loads the single shared source of truth for species/moves/combat
constants (games/glophimon/shared/combat_data.json) — the same file the
client's own game.js imports directly as an esbuild JSON module. Keeping
one file instead of two hand-kept-in-sync copies is what lets pvp_engine.py
stay a faithful port of the client's resolveMove/computeCombatant without
silently drifting from it over time — see the PVP Stage 2 plan.
"""

import json
from pathlib import Path

_DATA_PATH = Path(__file__).resolve().parents[2] / "shared" / "combat_data.json"
with _DATA_PATH.open() as _f:
    _RAW = json.load(_f)

BASE_HP: int = _RAW["baseHp"]
BASE_STAT: int = _RAW["baseStat"]
DEFEND_ACCURACY_PENALTY: float = _RAW["defendAccuracyPenalty"]
DEFEND_DAMAGE_MULTIPLIER: float = _RAW["defendDamageMultiplier"]
ATTACK_MOVE: dict = _RAW["attackMove"]
SPECIES: list[dict] = _RAW["species"]
SPECIES_BY_KEY: dict[str, dict] = {s["key"]: s for s in SPECIES}
MOVES_BY_SPECIES: dict[str, list[dict]] = _RAW["movesBySpecies"]
MOVE_BY_KEY: dict[str, dict] = {
    m["key"]: m
    for m in [ATTACK_MOVE, *[m for moves in MOVES_BY_SPECIES.values() for m in moves]]
}


def moves_for_species(species_key: str) -> list[dict]:
    return [ATTACK_MOVE, *MOVES_BY_SPECIES.get(species_key, [])]
