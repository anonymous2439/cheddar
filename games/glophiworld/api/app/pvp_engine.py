"""Server-authoritative port of the client's own combat engine
(games/glophimon/client/src/game.js: computeCombatant/effectiveStat/
tickEffects/resolveMove) — a faithful line-by-line translation, not a
reimplementation from scratch, so PVP battles behave identically to what a
player already knows from wild battles. See the PVP Stage 2 plan for the
formula-by-formula verification this was ported against.

_js_round exists because Python's builtin round() is banker's-rounding
(round-half-to-even) while JS Math.round always rounds half away from zero
— every value rounded here is non-negative, so floor(x + 0.5) matches JS
exactly where round() would silently disagree on .5 boundaries.
"""

import math
import random

from app.combat_data import (
    ATTACK_MOVE,  # noqa: F401 (re-exported for callers that only import this module)
    BASE_HP,
    BASE_STAT,
    DEFEND_ACCURACY_PENALTY,
    DEFEND_DAMAGE_MULTIPLIER,
    MOVE_BY_KEY,  # noqa: F401
    moves_for_species,
)


def _js_round(x: float) -> int:
    return math.floor(x + 0.5)


def max_hp_for(level: int | None) -> int:
    lvl = level or 1
    return math.floor((2 * BASE_HP * lvl) / 100) + lvl + 10


def compute_combatant(species: dict, ivs: dict, evs: dict | None, level: int | None) -> dict:
    ev = evs or {}
    lvl = level or 1

    def stat_at(iv: int, ev_stat) -> int:
        return math.floor((2 * BASE_STAT + iv + math.floor((ev_stat or 0) / 4)) * lvl / 100) + 5

    max_hp = max_hp_for(lvl)
    pp = {move["key"]: move["pp"] for move in moves_for_species(species["key"])}
    return {
        "name": species["name"],
        "species_key": species["key"],
        "hp": max_hp,
        "max_hp": max_hp,
        "pp": pp,
        "speed": stat_at(ivs["speed"], ev.get("speed")),
        "attack": stat_at(ivs["attack"], ev.get("attack")),
        "defense": stat_at(ivs["defense"], ev.get("defense")),
        "effects": [],  # [{stat, percent, turns_left}]
        "shield_active": False,
        "reflect_percent": 0,
        "forced_defender_turns": 0,
        "forced_idle_next_turn": False,
        "fainted": False,
    }


def effective_stat(combatant: dict, stat: str) -> int:
    mult = 1.0
    for e in combatant["effects"]:
        if e["stat"] == stat:
            mult += e["percent"]
    return max(1, _js_round(combatant[stat] * mult))


def tick_effects(combatant: dict) -> None:
    kept = []
    for e in combatant["effects"]:
        e["turns_left"] -= 1
        if e["turns_left"] > 0:
            kept.append(e)
    combatant["effects"] = kept
    if combatant["forced_defender_turns"] > 0:
        combatant["forced_defender_turns"] -= 1


def _apply_heal_or_buff_on(move: dict, target: dict, log: list[str]) -> None:
    if move.get("healPercent"):
        healed = _js_round(target["max_hp"] * move["healPercent"])
        target["hp"] = min(target["max_hp"], target["hp"] + healed)
        log.append(f"{target['name']} recovered HP!")
    if move.get("buffStat"):
        target["effects"].append(
            {"stat": move["buffStat"], "percent": move["buffPercent"], "turns_left": move["buffTurns"]}
        )
        log.append(f"{target['name']}'s {move['buffStat']} rose!")
    if move.get("shieldNextHit"):
        target["shield_active"] = True
        log.append(f"{target['name']} braced for the next hit!")
    if move.get("reflectPercent"):
        target["reflect_percent"] = move["reflectPercent"]
        log.append(f"{target['name']} is ready to retaliate!")
    if move.get("cleanse"):
        had_debuff = any(e["percent"] < 0 for e in target["effects"])
        target["effects"] = [e for e in target["effects"] if e["percent"] >= 0]
        if had_debuff:
            log.append(f"{target['name']}'s negative effects were cleared!")


def _apply_heal_or_buff(move: dict, targets: list[dict], log: list[str]) -> None:
    for target in targets:
        _apply_heal_or_buff_on(move, target, log)


def _apply_debuff(move: dict, target: dict, log: list[str]) -> None:
    if move.get("debuffStat"):
        target["effects"].append(
            {"stat": move["debuffStat"], "percent": -move["debuffPercent"], "turns_left": move["debuffTurns"]}
        )
        log.append(f"{target['name']}'s {move['debuffStat']} fell!")
    if move.get("forcedDefenderTurns"):
        target["forced_defender_turns"] = move["forcedDefenderTurns"]
        log.append(f"{target['name']} was taunted!")


def resolve_move(
    *,
    move: dict,
    attacker: dict,
    defender: dict | None,
    targets: list[dict] | None,
    defends: bool,
    log: list[str],
) -> dict:
    if attacker["pp"][move["key"]] <= 0:
        log.append(f"{attacker['name']} has no PP left for {move['name']}!")
        return {"hit": False}
    attacker["pp"][move["key"]] -= 1

    if move["kind"] in ("heal", "buff"):
        _apply_heal_or_buff(move, targets or [attacker], log)
        return {"hit": True}

    accuracy = None if move.get("accuracy") is None else move["accuracy"] - (DEFEND_ACCURACY_PENALTY if defends else 0)
    if accuracy is not None and random.random() * 100 > accuracy:
        log.append(f"{attacker['name']}'s {move['name']} missed!")
        return {"hit": False, "missed": True}

    if move["kind"] == "debuff":
        if defender is None:
            log.append(f"{move['name']} had no target and fizzled!")
            return {"hit": False}
        _apply_debuff(move, defender, log)
        return {"hit": True}

    # damage
    atk = effective_stat(attacker, "attack")
    if move.get("ignoresDefense"):
        deff = BASE_STAT
    elif defender is not None:
        deff = effective_stat(defender, "defense")
    else:
        deff = BASE_STAT  # unreachable in 1v1 PVP — there's always exactly one opponent body

    min_hits, max_hits = move.get("hits", [1, 1])
    hit_count = random.randint(min_hits, max_hits)  # inclusive both ends, matches the JS randomInt
    total_dmg = 0
    for _ in range(hit_count):
        dmg = move["power"] * (atk / deff) * (0.85 + random.random() * 0.15)
        if defends:
            dmg *= DEFEND_DAMAGE_MULTIPLIER
        total_dmg += max(1, _js_round(dmg))

    if defender is not None:
        if defender["shield_active"]:
            # Absorbs the whole move-use in one shot, not per individual hit
            # of a multi-hit move.
            defender["shield_active"] = False
            total_dmg = 0
            log.append(f"{defender['name']}'s shield absorbed it!")
        elif defender["reflect_percent"]:
            reflected = _js_round(total_dmg * defender["reflect_percent"])
            attacker["hp"] = max(0, attacker["hp"] - reflected)
            log.append(f"{attacker['name']} took {reflected} reflected damage!")
        defender["hp"] = max(0, defender["hp"] - total_dmg)
    else:
        log.append("No one defended!")  # unreachable in 1v1 PVP

    if move.get("recoilPercent"):
        attacker["hp"] = max(0, attacker["hp"] - _js_round(total_dmg * move["recoilPercent"]))
    if move.get("drainPercent"):
        attacker["hp"] = min(attacker["max_hp"], attacker["hp"] + _js_round(total_dmg * move["drainPercent"]))
    if move.get("flinchChance") and defender is not None and random.random() < move["flinchChance"]:
        # One-shot, consumed the next time that side would act — not a
        # turns_left-counted effect like buffs/debuffs.
        defender["forced_idle_next_turn"] = True
        log.append(f"{defender['name']} flinched!")

    hit_note = f" ({hit_count}x hit)" if hit_count > 1 else ""
    log.append(f"{attacker['name']} used {move['name']}!{hit_note} ({total_dmg} damage)")
    return {"hit": True, "damage": total_dmg}
