"""Glophimon — a single persistent shared overworld (same shape as GL Sims
World: see games/glsimsworld/api) for authenticated Cheddar users, but with
a genuinely new piece GL Sims World never needed: real per-account
persistence. Every user gets exactly one character, created once via
POST /me (character creation can never be revisited afterward — enforced
here by /me returning 409 once a row exists), and every session picks up
exactly where it left off: the world socket spawns each connection at its
own saved x/z/facing rather than a fresh/random point.

Movement is fully client-authoritative, same trust level as GL Sims World
and Luba's own movement — this service only relays position broadcasts and
periodically persists them. Unlike GL Sims World there is no claim/scarcity
system at all: every account's character is its own, permanently, so there
is nothing to compete over.

No chat in this phase — not asked for; the creature/battle system itself is
an explicitly separate, later discussion (see the game's own plan file).
"""

import asyncio
import math
import random
import time
from datetime import datetime, timedelta, timezone

import chess
import httpx
from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from jose import jwt as jose_jwt
from pydantic import ValidationError
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool

from app.chess_ai import compute_ai_move
from app.dama_ai import apply_dama_move, has_no_legal_moves
from app.dama_ai import compute_ai_move as compute_dama_ai_move
from app.combat_data import MOVE_BY_KEY, SPECIES, SPECIES_BY_KEY
from app.config import settings
from app.db import Base, SessionLocal, engine
from app.pvp_engine import compute_combatant, effective_stat, resolve_move, tick_effects
from app.karirs_engine import (
    STEP_DELAY_SECONDS,
    compute_payout_multipliers,
    compute_race,
    pick_racers,
    record_result,
    seed_karirs_roster_if_empty,
    speed_factor_for_multiplier,
)
from app.models import GlophimonCharacter, GlophimonInventory, GlophimonOwned, KarirsBet, KarirsRace, KarirsRacer
from app.schemas import (
    ActivateRequest,
    BattleResultOut,
    BattleResultParticipant,
    BattleResultRequest,
    CameraFocusOverrideUpdate,
    CameraOverrideUpdate,
    CatchRequest,
    CharacterCreate,
    CharacterOut,
    DailyClaimOut,
    GlophimonHpUpdate,
    HpUpdate,
    InventoryOut,
    KarirsBetCreate,
    KarirsBetOut,
    KarirsClaimOut,
    KarirsRaceOut,
    KarirsStateOut,
    OwnedGlophimonOut,
    OwnedOut,
    PoseOverrideUpdate,
    ShopBuyCreate,
    SpeciesOut,
    StarterCreate,
)
from app.security import decode_user_id, get_current_user_id

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Glophimon API")

# The 25 Glophimon species now live in games/glophimon/shared/combat_data.json
# (imported above as SPECIES/SPECIES_BY_KEY) — the same file the client's own
# game.js imports directly, so this roster and the client's never drift apart.
# See the PVP Stage 2 plan for why this moved out of a hardcoded literal here.

IV_MIN = 0
IV_MAX = 50  # inclusive — "genetic potential", rolled once at catch/starter time, fixed forever

# EXP/leveling (see apply_battle_result) — Pokémon's real "Medium Fast"
# growth rate (level cubed), uniform across every species since none of
# them have distinct growth rates or base stats of their own yet.
EXP_LEVEL_EXPONENT = 3
MAX_LEVEL = 100
MAX_EXP = MAX_LEVEL**EXP_LEVEL_EXPONENT
# Simplified version of Pokémon's own trainer-battle EXP-yield formula
# (base_yield * defeated_level / 7) — the parts this game has no
# equivalent of (exp-share, multiple participants dividing one award,
# trade bonus) are simply omitted rather than faked.
EXP_BASE_YIELD = {"common": 60, "rare": 100, "legendary": 300}
EXP_YIELD_FACTOR = 7

# EV training (see apply_battle_result) — real Pokémon's own caps.
EV_CAP_PER_STAT = 252
EV_CAP_TOTAL = 510

# Which stat(s) — and how much — defeating/catching each species trains,
# assigned by that species' own `types` (see the SPECIES catalog above):
# dps -> attack/special_attack/speed, tank -> defense/special_defense,
# support -> speed/special_defense, round-robin within each pool in
# SPECIES array order. Legendary/rare yield more than common; the
# legendary (all 3 types) yields a single higher amount rather than
# spreading thin across all of them. Column-name keys so
# apply_battle_result can `getattr`/`setattr` directly.
EV_YIELD_BY_SPECIES: dict[str, list[tuple[str, int]]] = {
    "xiaonix": [("ev_speed", 3)],
    "matando": [("ev_attack", 2)],
    "chaimeleon": [("ev_special_attack", 2)],
    "jonatagan": [("ev_speed", 2)],
    "leosala": [("ev_speed", 2), ("ev_defense", 2)],
    "ashbayra": [("ev_special_defense", 1)],
    "briandra": [("ev_speed", 1)],
    "carltiperral": [("ev_attack", 1)],
    "neaxinto": [("ev_special_attack", 1)],
    "elitajangit": [("ev_speed", 1)],
    "gravellin": [("ev_speed", 1)],
    "jaysmartiz": [("ev_attack", 1)],
    "jeromadel": [("ev_defense", 1)],
    "jhoposas": [("ev_special_defense", 1)],
    "jhonbra": [("ev_speed", 1)],
    "macajohn": [("ev_attack", 1), ("ev_defense", 1)],
    "joshuapaw": [("ev_special_attack", 1)],
    "abicallo": [("ev_speed", 1)],
    "michaeton": [("ev_special_defense", 1)],
    "mikenoza": [("ev_attack", 1)],
    "novachav": [("ev_special_defense", 1)],
    "percivolt": [("ev_defense", 1)],
    "rashperez": [("ev_special_defense", 1)],
    "rolandion": [("ev_special_attack", 1)],
    "trolonsay": [("ev_defense", 1)],
}

# How often (seconds) a connected player's position is written back to the
# DB — position messages arrive roughly every 100ms (see the client's own
# NETWORK_TICK_MS) whether or not the player is actually moving, so this is
# a plain in-process throttle, not a separate background task: the world_ws
# loop just checks elapsed time on each position message it already
# receives. Always persisted once more, unconditionally, on disconnect (see
# the finally block below) so the very latest position is never lost
# between throttled saves.
POSITION_SAVE_INTERVAL_S = 5.0

DEFAULT_SPAWN = {"x": 0.0, "z": 0.0, "facing": 0.0}

# Global chat (see world_ws's own "chat" branch) — a hard length cap plus a
# minimal per-connection cooldown, just enough to stop one client from
# flooding every other connected player; no persistence, no history, no
# profanity filtering — it's purely a live, ephemeral chat-bubble broadcast.
CHAT_MAX_LENGTH = 200
CHAT_MIN_INTERVAL_S = 1.0

# Rodz's daily free Glophiballs (see POST /me/inventory/claim-daily) — a
# flat amount, no scaling with level/tier or anything else yet.
DAILY_CLAIM_GLOPHIBALLS = 5


def _today_utc():
    return datetime.utcnow().date()


def _daily_claim_available(row: GlophimonInventory) -> bool:
    return row.last_daily_claim_date is None or row.last_daily_claim_date < _today_utc()


def _inventory_out(row: GlophimonInventory) -> InventoryOut:
    return InventoryOut(
        glophiballs=row.glophiballs,
        potions=row.potions,
        daily_claim_available=_daily_claim_available(row),
        g_coins=row.g_coins,
    )


class Connection:
    __slots__ = (
        "user_id", "display_name", "appearance", "websocket", "x", "z", "facing", "floor", "last_saved_at", "starter_level", "last_chat_at",
    )

    def __init__(
        self, user_id: int, display_name: str, appearance: dict, websocket: WebSocket, x: float, z: float, facing: float, floor: int, starter_level: int
    ) -> None:
        self.user_id = user_id
        self.display_name = display_name
        self.appearance = appearance  # head_color/body_color/arm_color/leg_color/gender
        self.websocket = websocket
        self.x = x
        self.z = z
        self.facing = facing
        # Which Glophics floor this connection's own character is currently
        # on (0 = ground) — see GlophimonCharacter.floor's own docstring
        # and game.js's own GLOPHICS_FLOORS. Updated from the client's own
        # "position" messages exactly like x/z/facing, relayed to every
        # other connected client the same way, and persisted the same way
        # too (see persist_position below).
        self.floor = floor
        self.last_saved_at = time.monotonic()
        # Global chat's own simple per-connection throttle (see world_ws's
        # "chat" branch) — 0.0 so the very first message is never rate
        # limited.
        self.last_chat_at = 0.0
        # Wild AI's own "is this one hard or easy for whoever's nearby"
        # check (see _wild_tick) — the same level comparison the client
        # used to make against its own single local player, now needing an
        # actual reference value per connected player. Starters don't level
        # up yet (see GlophimonOwned's own docstring), so this is fetched
        # once at connect time and never refreshed.
        self.starter_level = starter_level


# user_id -> the one live Connection for that account — also doubles as the
# "already connected elsewhere" guard, same reasoning as GL Sims World's own
# racer-keyed connections dict, just keyed by account instead of by claim.
connections: dict[int, Connection] = {}
_join_lock = asyncio.Lock()


async def broadcast(payload: dict, exclude: WebSocket | None = None) -> None:
    for conn in list(connections.values()):
        if conn.websocket is exclude:
            continue
        try:
            await conn.websocket.send_json(payload)
        except Exception:
            pass  # its own receive loop's disconnect handling will clean it up


async def send_to(user_id: int, payload: dict) -> bool:
    # The one targeted (not broadcast) send in this file — used by the Luba
    # lobby system and PVP invites below, where an invite/kick/close only
    # ever concerns one specific other connected player, never everyone.
    # Returns whether the send actually landed. This used to swallow both
    # a missing-connection and a failed-write silently and return nothing —
    # fine for most callers, but the PVP invite handler needs to know when
    # delivery to the target actually failed (a stale/half-closed socket
    # whose owning connection's own receive loop hasn't noticed yet), since
    # otherwise the invite vanished with the inviter never told and the
    # target never seeing anything. A failed write here means that
    # connection is already dead, so we drop it from `connections`
    # immediately (guarded by identity, in case the same user_id already
    # reconnected with a fresh Connection in the meantime) rather than
    # waiting for its own receive loop's disconnect handling to catch up —
    # otherwise every send_to for this user_id would keep failing the same
    # silent way until that happens.
    conn = connections.get(user_id)
    if conn is None:
        return False
    try:
        await conn.websocket.send_json(payload)
        return True
    except Exception:
        if connections.get(user_id) is conn:
            connections.pop(user_id, None)
        return False


# --- Shared wild Glophimon population ------------------------------------
# Promoted from a per-client simulation (every player independently
# imagining their own random wild Glophimon) to genuine server-owned state:
# every connected player now sees the exact same creatures at the exact
# same positions, and only one of them can ever actually be mid-battle with
# a given one at a time (see engage_wild/release_wild/wild_caught below).
# The client's own wildSpawns is now purely a *render* of whatever
# wild_tick_loop broadcasts — it no longer runs its own wander/flee/chase
# simulation at all.
#
# A wild that gets engaged is frozen in place (no movement/lifetime/AI)
# until released or caught — see _wild_tick's own early-continue for
# engaged wilds. Everyone except the engaging player renders it at reduced
# opacity in the meantime (a visible "someone's already fighting this one"
# cue), while the engaging player doesn't render it as an ambient spawn at
# all any more — it's now the dedicated rig inside their own battle scene.
# Tuned against the actual wild-spawn roll rate, not picked by feel: the
# shared world holds WILD_SPAWN_TARGET_COUNT=40 wild Glophimon at once, each
# living an average of (WILD_LIFETIME_MIN_S+WILD_LIFETIME_MAX_S)/2=60s before
# despawning and rolling a replacement — that's ~40/60=0.67 rolls/sec
# server-wide, or ~403,200 rolls/week. legendary=0.0004 -> ~1.6 expected
# legendary spawns/week; rare=0.0019 -> ~1 expected rare spawn every ~0.9
# days. Both are *expected* counts, not guarantees — real spawns are still
# independent random rolls, so some weeks/days will have none and some will
# have several.
RARITY_PERCENT = {"legendary": 0.0004, "rare": 0.0019, "common": 99.9977}
_species_tier_counts: dict[str, int] = {}
for _s in SPECIES:
    _species_tier_counts[_s["tier"]] = _species_tier_counts.get(_s["tier"], 0) + 1
SPECIES_WEIGHTS = [RARITY_PERCENT[s["tier"]] / _species_tier_counts[s["tier"]] for s in SPECIES]


def pick_random_species_by_rarity() -> dict:
    roll = random.uniform(0, sum(SPECIES_WEIGHTS))
    for species, weight in zip(SPECIES, SPECIES_WEIGHTS):
        roll -= weight
        if roll <= 0:
            return species
    return SPECIES[-1]  # float rounding backstop only


# Must match the client's own ARENA_HALF_X/Z (game.js) — same
# manually-paired-constant convention as LUBA_X/Z/HALF below.
WORLD_ARENA_HALF_X = 80.0
WORLD_ARENA_HALF_Z = 80.0

# Same walled town footprint the client's own buildTown lays out (see that
# file's own comment for the geometry derivation) — duplicated here so
# spawn placement and wild movement are blocked by it server-side too, the
# same way the client blocks the player from ever walking through a wall.
TOWN_HALF_X = 9.0
TOWN_HALF_Z = 9.0
TOWN_DOOR_HALF_WIDTH = 2.2
TOWN_WALL_THICKNESS = 0.6
TOWN_NO_SPAWN_MARGIN = 8.0
TOWN_NO_SPAWN_HALF_X = TOWN_HALF_X + TOWN_NO_SPAWN_MARGIN
TOWN_NO_SPAWN_HALF_Z = TOWN_HALF_Z + TOWN_NO_SPAWN_MARGIN

# The Karirs field's own footprint — same wall layout as Glophics (see
# buildAreaWalls on the client), just centered on KARIRS_FIELD_X/Z instead
# of the map's origin. Must match the client's own KARIRS_FIELD_X/Z/HALF.
KARIRS_FIELD_X = 28.0
KARIRS_FIELD_Z = -28.0
KARIRS_FIELD_HALF = 7.0
KARIRS_NO_SPAWN_HALF = KARIRS_FIELD_HALF + TOWN_NO_SPAWN_MARGIN

# The racetrack rendered just south of the field itself (see the client's
# own KARIRS_TRACK_* constants/buildKarirsTrack) — open ground, no walls of
# its own, so it needs its own explicit exclusion rather than picking one
# up for free from _build_area_wall_boxes/TOWN_WALL_BOXES below. Must match
# the client's own KARIRS_TRACK_* values exactly.
KARIRS_TRACK_LANE_COUNT = 4
KARIRS_TRACK_LANE_SPACING = 2.4
KARIRS_TRACK_START_Z = KARIRS_FIELD_Z - KARIRS_FIELD_HALF - 3.0
KARIRS_TRACK_LENGTH = 30.0
KARIRS_TRACK_FINISH_Z = KARIRS_TRACK_START_Z - KARIRS_TRACK_LENGTH
KARIRS_TRACK_WIDTH = KARIRS_TRACK_LANE_COUNT * KARIRS_TRACK_LANE_SPACING + 2.0
# A no-spawn margin around the track's own footprint, same TOWN_NO_SPAWN_MARGIN
# every other walled area already uses for "don't spawn right on top of
# it" — the track has no walls to hide a spawn point behind, so this is
# what actually keeps a wild from popping into existence on the finish line.
KARIRS_TRACK_NO_SPAWN_HALF_WIDTH = KARIRS_TRACK_WIDTH / 2 + TOWN_NO_SPAWN_MARGIN
KARIRS_TRACK_NO_SPAWN_MAX_Z = KARIRS_TRACK_START_Z + TOWN_NO_SPAWN_MARGIN
KARIRS_TRACK_NO_SPAWN_MIN_Z = KARIRS_TRACK_FINISH_Z - TOWN_NO_SPAWN_MARGIN


def _is_inside_karirs_track(x: float, z: float) -> bool:
    """The track's own bare rectangle, no door-gapped wall-box thing like
    is_inside_town_walls below — it's open ground with no walls at all, so
    a wild has to be kept out of the whole footprint directly, not just its
    (nonexistent) perimeter. Used for BOTH movement-blocking (see
    _wild_tick, with no margin — right up to the actual track edge is
    fine to walk beside) and, via the margin-padded variant just below, for
    spawn exclusion."""
    return KARIRS_FIELD_X - KARIRS_TRACK_WIDTH / 2 <= x <= KARIRS_FIELD_X + KARIRS_TRACK_WIDTH / 2 and (
        KARIRS_TRACK_FINISH_Z <= z <= KARIRS_TRACK_START_Z
    )


def _is_near_karirs_track(x: float, z: float) -> bool:
    """Same rectangle as _is_inside_karirs_track, padded by
    TOWN_NO_SPAWN_MARGIN on every side — see KARIRS_TRACK_NO_SPAWN_HALF_WIDTH/
    MIN_Z/MAX_Z's own comment. Spawn-exclusion only; movement blocking uses
    the tighter, unpadded rectangle instead."""
    return KARIRS_FIELD_X - KARIRS_TRACK_NO_SPAWN_HALF_WIDTH <= x <= KARIRS_FIELD_X + KARIRS_TRACK_NO_SPAWN_HALF_WIDTH and (
        KARIRS_TRACK_NO_SPAWN_MIN_Z <= z <= KARIRS_TRACK_NO_SPAWN_MAX_Z
    )

# The Luba lobby area's own footprint — same wall layout, mirrored
# diagonally opposite the Karirs field across the origin so neither it nor
# Glophics ever overlaps it. Must match the client's own LUBA_X/Z/HALF.
LUBA_X = -28.0
LUBA_Z = 28.0
LUBA_HALF = 7.0
LUBA_NO_SPAWN_HALF = LUBA_HALF + TOWN_NO_SPAWN_MARGIN

# Tambayan's own footprint — the one remaining open quadrant (Karirs
# top-right, Luba bottom-left, this bottom-right) — but pentagon-shaped
# rather than the square every other walled area here uses, so it gets its
# own small parallel geometry module instead of plugging into
# _build_area_wall_boxes/TOWN_WALL_BOXES/is_inside_town_walls below (see
# this game's own plan file for why). Must match the client's own
# TAMBAYAN_X/Z/RADIUS and use the identical vertex formula.
TAMBAYAN_X = 40.0
TAMBAYAN_Z = 40.0
TAMBAYAN_RADIUS = 14.0
TAMBAYAN_VERTICES = [
    (TAMBAYAN_X + math.cos(-math.pi / 2 + i * (2 * math.pi / 5)) * TAMBAYAN_RADIUS,
     TAMBAYAN_Z + math.sin(-math.pi / 2 + i * (2 * math.pi / 5)) * TAMBAYAN_RADIUS)
    for i in range(5)
]


def _is_inside_tambayan(x: float, z: float) -> bool:
    # Standard even-odd point-in-polygon test — must match the client's own
    # isInsidePolygon exactly (same algorithm, not just the same vertices).
    inside = False
    n = len(TAMBAYAN_VERTICES)
    for i in range(n):
        xi, zi = TAMBAYAN_VERTICES[i]
        xj, zj = TAMBAYAN_VERTICES[i - 1]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
            inside = not inside
    return inside


def _distance_to_segment(px: float, pz: float, x1: float, z1: float, x2: float, z2: float) -> float:
    dx, dz = x2 - x1, z2 - z1
    length_sq = dx * dx + dz * dz
    t = 0.0 if length_sq == 0 else max(0.0, min(1.0, ((px - x1) * dx + (pz - z1) * dz) / length_sq))
    return math.hypot(px - (x1 + t * dx), pz - (z1 + t * dz))


def _build_tambayan_wall_segments() -> list[tuple[float, float, float, float]]:
    # Each of the 5 edges split into two sub-segments around a door gap —
    # must match the client's own TAMBAYAN_WALL_SEGMENTS construction.
    segments = []
    n = len(TAMBAYAN_VERTICES)
    for i in range(n):
        x1, z1 = TAMBAYAN_VERTICES[i]
        x2, z2 = TAMBAYAN_VERTICES[(i + 1) % n]
        edge_length = math.hypot(x2 - x1, z2 - z1)
        ux, uz = (x2 - x1) / edge_length, (z2 - z1) / edge_length
        mid_t = edge_length / 2
        gap_start_t, gap_end_t = mid_t - TOWN_DOOR_HALF_WIDTH, mid_t + TOWN_DOOR_HALF_WIDTH
        segments.append((x1, z1, x1 + ux * gap_start_t, z1 + uz * gap_start_t))
        segments.append((x1 + ux * gap_end_t, z1 + uz * gap_end_t, x2, z2))
    return segments


TAMBAYAN_WALL_SEGMENTS = _build_tambayan_wall_segments()


def _is_inside_tambayan_walls(x: float, z: float) -> bool:
    return any(_distance_to_segment(x, z, *seg) <= TOWN_WALL_THICKNESS / 2 for seg in TAMBAYAN_WALL_SEGMENTS)


# How close two players (or a player and an NPC) need to be to interact —
# used server-side only for the PVP invite proximity re-check (see
# _handle_pvp_message). Must match the client's own INTERACTION_RANGE.
INTERACTION_RANGE = 2.5


def _build_area_wall_boxes(center_x: float, center_z: float, half: float) -> list[tuple[float, float, float, float]]:
    h, t, d = half, TOWN_WALL_THICKNESS, TOWN_DOOR_HALF_WIDTH
    boxes = []
    for z_off in (-h, h):
        z = center_z + z_off
        boxes.append((center_x - h, center_x - d, z - t / 2, z + t / 2))
        boxes.append((center_x + d, center_x + h, z - t / 2, z + t / 2))
    for x_off in (-h, h):
        x = center_x + x_off
        boxes.append((x - t / 2, x + t / 2, center_z - h, center_z - d))
        boxes.append((x - t / 2, x + t / 2, center_z + d, center_z + h))
    return boxes


# The rectangular walled areas' wall boxes together (Tambayan's own pentagon
# walls are checked separately, see _is_inside_tambayan_walls) —
# is_inside_town_walls (and therefore both player and wild movement) treats
# these three identically.
TOWN_WALL_BOXES = (
    _build_area_wall_boxes(0.0, 0.0, TOWN_HALF_X)
    + _build_area_wall_boxes(KARIRS_FIELD_X, KARIRS_FIELD_Z, KARIRS_FIELD_HALF)
    + _build_area_wall_boxes(LUBA_X, LUBA_Z, LUBA_HALF)
)


def is_inside_town_walls(x: float, z: float) -> bool:
    return any(min_x <= x <= max_x and min_z <= z <= max_z for min_x, max_x, min_z, max_z in TOWN_WALL_BOXES)


WILD_SPAWN_TARGET_COUNT = 40
WILD_TICK_INTERVAL_S = 0.15
WILD_LIFETIME_MIN_S = 40.0
WILD_LIFETIME_MAX_S = 80.0
WILD_LEVEL_MIN = 1
WILD_LEVEL_MAX = 20
WILD_MOVE_SPEED = 0.8
WILD_TERRITORY_RADIUS = 5.0  # wander radius around the spawn point while undisturbed
WILD_WANDER_PAUSE_MIN_S = 1.5
WILD_WANDER_PAUSE_MAX_S = 4.0
WILD_ARRIVE_THRESHOLD = 0.25
WILD_VISION_RANGE = 6.0  # how far in front of them they can spot a player
WILD_VISION_HALF_ANGLE = math.pi / 4  # 45° either side of facing — a 90° cone
WILD_FLEE_SPEED_MULT = 1.5
WILD_CHASE_SPEED_MULT = 1.15
WILD_FLEE_DESPAWN_DISTANCE = WILD_VISION_RANGE * 3  # "runs until it disappears"

# A breather right after a battle ends (release_wild/wild_caught both set
# this) — matches the client's own POST_BATTLE_COOLDOWN_MS. No wild's own
# vision check (see _wild_tick) can spot this player at all for the
# duration, on top of the client's own separate re-engage cooldown, so
# nothing chases/flees from someone who's meant to be taking a breather.
WILD_VISION_IMMUNITY_S = 8.0
battle_cooldown_until: dict[int, float] = {}


def _grant_battle_cooldown(user_id: int) -> None:
    battle_cooldown_until[user_id] = time.monotonic() + WILD_VISION_IMMUNITY_S


class WildSpawn:
    __slots__ = (
        "id", "species_key", "level", "x", "z", "facing", "state",
        "spawn_x", "spawn_z", "wander_target_x", "wander_target_z",
        "wander_paused_until", "spawned_at", "lifetime_s",
        "reactor_user_id", "engaged_by", "is_moving",
    )

    def __init__(self, wild_id: int, species_key: str, level: int, x: float, z: float, now: float) -> None:
        self.id = wild_id
        self.species_key = species_key
        self.level = level
        self.x = x
        self.z = z
        self.facing = random.uniform(0, math.pi * 2)
        self.state = "wander"  # "wander" | "flee" | "chase" | "engaged"
        self.spawn_x = x
        self.spawn_z = z
        self.wander_target_x = x
        self.wander_target_z = z
        self.wander_paused_until = now + random.uniform(WILD_WANDER_PAUSE_MIN_S, WILD_WANDER_PAUSE_MAX_S)
        self.spawned_at = now
        self.lifetime_s = random.uniform(WILD_LIFETIME_MIN_S, WILD_LIFETIME_MAX_S)
        self.reactor_user_id = None  # which connected player it's currently fleeing/chasing, if any
        self.engaged_by = None  # user_id currently battling it, or None
        self.is_moving = False


wild_spawns: dict[int, WildSpawn] = {}
_next_wild_id = 1

# Full spectator mode for wild battles — battling_user_id -> the latest full
# snapshot of that fight, exactly as the battling client itself last
# narrated it (see _handle_wild_battle_message below). Unlike wild_spawns
# (genuinely server-owned) the fight *contents* here are still entirely
# client-side/non-authoritative — the wild's stats, moves, HP, turn order
# and RNG are all simulated locally by the battling player's own client
# (games/glophimon/client's own startWildBattle/resolvePlayerAttack/
# resolveWildAttack), exactly like it always has been. This dict doesn't
# change that trust model at all; it just gives every OTHER connected
# player visibility into a fight already happening, the same way position
# broadcasts let everyone see where everyone else is standing without the
# server ever validating *how* they got there. Always a full snapshot, not
# a delta — see wild_battle_start/_update's own broadcast below — so any
# client (including one that only just connected, see world_ws's own
# wild_battle_roster send) can render a spectated battle from a single
# message with no history to reconcile. Popped on wild_battle_end or on
# disconnect (see world_ws's own finally block) — a battle with no entry
# here just means nobody's spectating anything for that user right now.
active_wild_battles: dict[int, dict] = {}


# --- Floor 2 cinema: shared projectionist role + screen URL -------------
# Mirrors game.js's own CINEMA_SCREEN_FLOOR_INDEX (= GLOPHICS_FLOORS[0].index,
# currently 1) — kept as a plain server-side constant rather than importing
# anything from the client, same as every other cross-referenced-by-comment
# constant in this file. Used to re-check "is this connection actually
# standing in the cinema right now" server-side rather than trusting
# whatever the client claims (see _handle_cinema_message's own
# cinema_claim_projectionist branch), and to detect the projectionist
# walking away from the floor entirely (see world_ws's own "position"
# branch below).
CINEMA_FLOOR_INDEX = 1
# Same default the client used to hardcode as CINEMA_YOUTUBE_EMBED_URL
# before this feature existed — kept identical so a fresh server boot (or
# a server restart mid-session, which clears this in-memory state exactly
# like active_wild_battles) falls back to the same placeholder video rather
# than an empty screen.
CINEMA_DEFAULT_SCREEN_URL = (
    "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&mute=1&loop=1&playlist=dQw4w9WgXcQ&controls=0&enablejsapi=1"
)
# {"user_id": int, "display_name": str} for whoever currently holds the
# projectionist role, or None if it's vacant. In-memory shared world state,
# not per-account persisted state — exactly like active_wild_battles, this
# resets on server restart, which is fine (no worse than any other live
# connection state getting dropped on a restart).
cinema_projectionist: dict | None = None
# The current shared screen content for floor 2's cinema — starts at the
# same placeholder every client used to hardcode, changeable at runtime
# only by whoever currently holds cinema_projectionist (see
# _handle_cinema_message's own cinema_set_url branch).
cinema_screen_url: str = CINEMA_DEFAULT_SCREEN_URL
# Basic string-level sanity bound on a projectionist-submitted URL — not a
# real max URL length limit (browsers/servers tolerate much longer), just
# enough to reject someone pasting something absurd. Deliberately no
# fetch/HEAD request to validate the URL actually resolves to anything —
# that would mean this server making an outbound request to a URL supplied
# by a client, which is a textbook SSRF risk for essentially no benefit
# (an iframe that fails to load is a harmless dead screen, not a security
# problem).
CINEMA_URL_MAX_LENGTH = 500


def _is_valid_cinema_url(url: str) -> bool:
    return isinstance(url, str) and 0 < len(url) <= CINEMA_URL_MAX_LENGTH and (url.startswith("http://") or url.startswith("https://"))


async def _cinema_release_if_projectionist(user_id: int) -> None:
    """Shared by both places the projectionist role can be involuntarily
    vacated — the player walking off floor 2 (world_ws's own "position"
    branch) and the player disconnecting outright (world_ws's own finally
    block) — same "one clearing helper, two call sites" shape
    _chess_disconnect_cleanup already uses elsewhere in this file."""
    global cinema_projectionist
    if cinema_projectionist is not None and cinema_projectionist["user_id"] == user_id:
        cinema_projectionist = None
        await broadcast({"type": "cinema_projectionist_state", "projectionist": None})


async def _handle_cinema_message(user_id: int, conn: "Connection", msg: dict) -> None:
    """Floor 2 cinema's own message handler — dispatched from world_ws for
    every cinema_* type, the same "one handler per feature, matched by
    prefix" shape _handle_wild_battle_message/_handle_pvp_message already
    use. Both branches re-validate everything server-side rather than
    trusting the client's own optimistic UI state, the same "never trust a
    client claiming a role/position it might not actually have" pattern the
    wild-battle-engage and PVP-invite handlers already follow."""
    global cinema_projectionist, cinema_screen_url
    msg_type = msg.get("type")

    if msg_type == "cinema_claim_projectionist":
        if conn.floor != CINEMA_FLOOR_INDEX:
            await send_to(user_id, {"type": "cinema_error", "reason": "not_in_cinema"})
            return
        if cinema_projectionist is not None:
            await send_to(user_id, {"type": "cinema_error", "reason": "already_taken"})
            return
        cinema_projectionist = {"user_id": user_id, "display_name": conn.display_name}
        # Not excluding the claimer's own socket, unlike most other
        # broadcasts in this file — they need this same confirmation back
        # (it's what flips their own Usher popup from the hiring pitch to
        # the URL-change controls), not just everyone else.
        await broadcast({"type": "cinema_projectionist_state", "projectionist": cinema_projectionist})
        return

    if msg_type == "cinema_set_url":
        if cinema_projectionist is None or cinema_projectionist["user_id"] != user_id:
            await send_to(user_id, {"type": "cinema_error", "reason": "not_projectionist"})
            return
        url = str(msg.get("url", "")).strip()
        if not _is_valid_cinema_url(url):
            await send_to(user_id, {"type": "cinema_error", "reason": "invalid_url"})
            return
        cinema_screen_url = url
        await broadcast({"type": "cinema_screen_state", "url": cinema_screen_url})
        return


def _random_wild_spawn_point() -> tuple[float, float]:
    # Rejection-sampled so a wild never spawns inside (or right up against)
    # Glophics or the Karirs field — same margin reasoning as the client's
    # own TOWN_NO_SPAWN_HALF_X/Z.
    while True:
        x = random.uniform(-WORLD_ARENA_HALF_X, WORLD_ARENA_HALF_X)
        z = random.uniform(-WORLD_ARENA_HALF_Z, WORLD_ARENA_HALF_Z)
        if abs(x) < TOWN_NO_SPAWN_HALF_X and abs(z) < TOWN_NO_SPAWN_HALF_Z:
            continue
        if abs(x - KARIRS_FIELD_X) < KARIRS_NO_SPAWN_HALF and abs(z - KARIRS_FIELD_Z) < KARIRS_NO_SPAWN_HALF:
            continue
        if abs(x - LUBA_X) < LUBA_NO_SPAWN_HALF and abs(z - LUBA_Z) < LUBA_NO_SPAWN_HALF:
            continue
        # A simple circular margin around Tambayan's own pentagon (not an
        # exact "outside the pentagon plus a margin" polygon offset — a
        # generously-sized circle is a cheap, sufficient approximation for
        # a rejection-sampling no-spawn zone).
        if math.hypot(x - TAMBAYAN_X, z - TAMBAYAN_Z) < TAMBAYAN_RADIUS + TOWN_NO_SPAWN_MARGIN:
            continue
        if _is_near_karirs_track(x, z):
            continue
        return x, z


def _pick_new_wander_target(wild: WildSpawn) -> None:
    angle = random.uniform(0, math.pi * 2)
    r = random.uniform(0, WILD_TERRITORY_RADIUS)
    wild.wander_target_x = wild.spawn_x + math.cos(angle) * r
    wild.wander_target_z = wild.spawn_z + math.sin(angle) * r
    wild.wander_paused_until = 0  # walking now; a fresh pause is set on arrival


async def _spawn_wild(now: float) -> None:
    global _next_wild_id
    species = pick_random_species_by_rarity()
    level = random.randint(WILD_LEVEL_MIN, WILD_LEVEL_MAX)
    x, z = _random_wild_spawn_point()
    wild = WildSpawn(_next_wild_id, species["key"], level, x, z, now)
    _next_wild_id += 1
    wild_spawns[wild.id] = wild
    await broadcast(
        {"type": "wild_spawn", "id": wild.id, "species_key": wild.species_key, "level": wild.level, "x": wild.x, "z": wild.z, "facing": wild.facing}
    )


def _normalize_angle(angle: float) -> float:
    return math.atan2(math.sin(angle), math.cos(angle))


async def _wild_tick(dt: float, now: float) -> None:
    players = list(connections.values())
    # Anyone still within their post-battle breather is invisible to every
    # wild's own vision check (see WILD_VISION_IMMUNITY_S) — a separate
    # list rather than filtering `players` itself, since chase/flee target
    # resolution further below still needs to look up *already-reacting*
    # players by id regardless (a wild already chasing someone doesn't
    # un-notice them just because they later entered a new battle elsewhere).
    visible_players = [p for p in players if now >= battle_cooldown_until.get(p.user_id, 0)]
    updates = []
    to_despawn = []

    for wild in list(wild_spawns.values()):
        if wild.engaged_by is not None:
            continue  # frozen mid-battle — no movement/AI/lifetime while engaged

        if now - wild.spawned_at > wild.lifetime_s:
            to_despawn.append(wild.id)
            continue

        # Vision check only while undisturbed — once it's already fleeing
        # or chasing, it stays committed to that reaction (matches the
        # client's own original single-player behavior).
        if wild.state == "wander":
            for p in visible_players:
                dx = p.x - wild.x
                dz = p.z - wild.z
                dist = math.hypot(dx, dz)
                if dist <= WILD_VISION_RANGE:
                    angle_to_player = math.atan2(dx, dz)
                    angle_diff = _normalize_angle(angle_to_player - wild.facing)
                    if abs(angle_diff) <= WILD_VISION_HALF_ANGLE:
                        wild.state = "chase" if wild.level > p.starter_level else "flee"
                        wild.reactor_user_id = p.user_id
                        break

        reactor = connections.get(wild.reactor_user_id) if wild.reactor_user_id is not None else None
        if wild.state in ("chase", "flee") and reactor is None:
            # Whoever it was reacting to disconnected mid-reaction — settle back down.
            wild.state = "wander"
            wild.reactor_user_id = None

        if wild.state == "chase":
            target_x, target_z, speed = reactor.x, reactor.z, WILD_MOVE_SPEED * WILD_CHASE_SPEED_MULT
        elif wild.state == "flee":
            dx, dz = wild.x - reactor.x, wild.z - reactor.z
            dist = math.hypot(dx, dz) or 1.0
            if dist > WILD_FLEE_DESPAWN_DISTANCE:
                to_despawn.append(wild.id)
                continue
            target_x = wild.x + (dx / dist) * WILD_FLEE_DESPAWN_DISTANCE
            target_z = wild.z + (dz / dist) * WILD_FLEE_DESPAWN_DISTANCE
            speed = WILD_MOVE_SPEED * WILD_FLEE_SPEED_MULT
        else:
            dist_to_wander_target = math.hypot(wild.wander_target_x - wild.x, wild.wander_target_z - wild.z)
            if dist_to_wander_target <= WILD_ARRIVE_THRESHOLD:
                if wild.wander_paused_until == 0:
                    wild.wander_paused_until = now + random.uniform(WILD_WANDER_PAUSE_MIN_S, WILD_WANDER_PAUSE_MAX_S)
                elif now >= wild.wander_paused_until:
                    _pick_new_wander_target(wild)
            target_x, target_z, speed = wild.wander_target_x, wild.wander_target_z, WILD_MOVE_SPEED

        dx, dz = target_x - wild.x, target_z - wild.z
        dist_to_target = math.hypot(dx, dz)
        wild.is_moving = dist_to_target > WILD_ARRIVE_THRESHOLD
        if wild.is_moving:
            nx, nz = dx / dist_to_target, dz / dist_to_target
            step = speed * dt
            next_x = min(WORLD_ARENA_HALF_X, max(-WORLD_ARENA_HALF_X, wild.x + nx * step))
            next_z = min(WORLD_ARENA_HALF_Z, max(-WORLD_ARENA_HALF_Z, wild.z + nz * step))
            if (
                not is_inside_town_walls(next_x, wild.z)
                and not _is_inside_tambayan_walls(next_x, wild.z)
                and not _is_inside_karirs_track(next_x, wild.z)
            ):
                wild.x = next_x
            if (
                not is_inside_town_walls(wild.x, next_z)
                and not _is_inside_tambayan_walls(wild.x, next_z)
                and not _is_inside_karirs_track(wild.x, next_z)
            ):
                wild.z = next_z
            wild.facing = math.atan2(nx, nz)

        updates.append({"id": wild.id, "x": wild.x, "z": wild.z, "facing": wild.facing, "state": wild.state, "moving": wild.is_moving})

    for wild_id in to_despawn:
        wild_spawns.pop(wild_id, None)

    if len(wild_spawns) < WILD_SPAWN_TARGET_COUNT:
        await _spawn_wild(now)

    if updates:
        await broadcast({"type": "wild_tick", "updates": updates})
    for wild_id in to_despawn:
        await broadcast({"type": "wild_despawn", "id": wild_id})


async def wild_tick_loop() -> None:
    last = time.monotonic()
    while True:
        await asyncio.sleep(WILD_TICK_INTERVAL_S)
        now = time.monotonic()
        dt = now - last
        last = now
        try:
            await _wild_tick(dt, now)
        except Exception:
            pass  # never let one bad tick take the whole background loop down


@app.on_event("startup")
async def _start_wild_tick_loop() -> None:
    asyncio.create_task(wild_tick_loop())


@app.post("/wild/{wild_id}/engage")
async def engage_wild(wild_id: int, user_id: int = Depends(get_current_user_id)):
    """Called the instant a client's own contact-with-a-wandering-wild
    check fires (see the client's own checkWildContact) — exclusive: only
    one player can ever be mid-battle with a given wild at a time. On
    success the caller proceeds to actually start its local battle
    simulation (unchanged, client-authoritative — see the game's own plan
    notes on why); on failure (409 — someone else got there first) the
    caller just quietly skips this contact, same as if it hadn't touched
    the wild at all this frame."""
    wild = wild_spawns.get(wild_id)
    if wild is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That Glophimon isn't there any more")
    if wild.engaged_by is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Someone's already battling that one")
    wild.engaged_by = user_id
    wild.state = "engaged"
    requester = connections.get(user_id)
    await broadcast({"type": "wild_engaged", "id": wild_id, "by_user_id": user_id}, exclude=requester.websocket if requester else None)
    return {"species_key": wild.species_key, "level": wild.level}


@app.post("/wild/{wild_id}/release")
async def release_wild(wild_id: int, user_id: int = Depends(get_current_user_id)):
    """The battle ended without a catch (fled, escaped, or the player just
    left) — hands the wild back to the shared world so anyone (including
    the same player again) can go engage it for real."""
    _grant_battle_cooldown(user_id)
    wild = wild_spawns.get(wild_id)
    if wild is None:
        return {"ok": True}  # already gone (e.g. its lifetime quietly expired mid-battle) — nothing to release
    if wild.engaged_by != user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You aren't the one battling that Glophimon")
    wild.engaged_by = None
    wild.state = "wander"
    now = time.monotonic()
    # Resumes wandering from wherever the battle left it, not its original
    # spawn point — same "settle back into normal life" idea the rest of
    # this game already uses when releasing something back to the world.
    wild.spawn_x = wild.x
    wild.spawn_z = wild.z
    wild.wander_target_x = wild.x
    wild.wander_target_z = wild.z
    wild.wander_paused_until = now + random.uniform(WILD_WANDER_PAUSE_MIN_S, WILD_WANDER_PAUSE_MAX_S)
    requester = connections.get(user_id)
    await broadcast({"type": "wild_released", "id": wild_id}, exclude=requester.websocket if requester else None)
    return {"ok": True}


@app.post("/wild/{wild_id}/caught")
async def wild_caught(wild_id: int, user_id: int = Depends(get_current_user_id)):
    """Called alongside (not instead of) the existing POST /me/glophimon
    catch — that endpoint persists the new ownership row; this one just
    removes the now-caught creature from the shared world for everyone."""
    _grant_battle_cooldown(user_id)
    wild = wild_spawns.get(wild_id)
    if wild is None or wild.engaged_by != user_id:
        # Already gone, or was never this player's to claim — a no-op
        # rather than an error, since the real ownership record (the
        # /me/glophimon call) already happened by the time this is called
        # and shouldn't be undone over a bookkeeping mismatch here.
        return {"ok": True}
    del wild_spawns[wild_id]
    requester = connections.get(user_id)
    await broadcast({"type": "wild_despawn", "id": wild_id}, exclude=requester.websocket if requester else None)
    return {"ok": True}


async def _handle_wild_battle_message(user_id: int, conn: "Connection", msg: dict) -> None:
    """Full spectator mode's own message handler — dispatched from world_ws
    for every wild_battle_* type, same "one handler per feature, matched by
    prefix" shape _handle_luba_message/_handle_pvp_message already use.
    Deliberately does no validation of the snapshot's own contents beyond
    what's needed to key/route it: the wild fight itself is still entirely
    client-side/non-authoritative (see active_wild_battles' own docstring),
    so this is just relaying whatever the battling client already computed
    locally, the exact same trust level a bare "position" message already
    gets. wild_battle_start and wild_battle_update are handled identically
    on purpose — the client only distinguishes them for its own log-reading
    clarity (start vs. an in-progress change), the server doesn't care which
    one it was since both just replace the whole stored snapshot outright.
    """
    msg_type = msg.get("type")

    if msg_type in ("wild_battle_start", "wild_battle_update"):
        # Pulled out field-by-field (rather than trusting the whole `msg`
        # dict wholesale) so a stray extra key the client happens to send
        # (e.g. its own "type") never leaks into the stored snapshot or the
        # rebroadcast payload below — every key here must match game.js's
        # own buildBattleSnapshot exactly, both what it sends and what
        # onSocketMessage's own wild_battle_state handler reads back.
        snapshot = {
            "wild_id": msg.get("wild_id"),
            "wild_species_key": msg.get("wild_species_key"),
            "wild_level": msg.get("wild_level"),
            "wild_hp": msg.get("wild_hp"),
            "wild_max_hp": msg.get("wild_max_hp"),
            "x": msg.get("x"),
            "z": msg.get("z"),
            "facing_angle": msg.get("facing_angle"),
            "player_team": msg.get("player_team") or [],
            "active_anim": msg.get("active_anim"),
        }
        active_wild_battles[user_id] = snapshot
        await broadcast({"type": "wild_battle_state", "by_user_id": user_id, **snapshot}, exclude=conn.websocket)
        return

    if msg_type == "wild_battle_end":
        # Popped unconditionally (not just when present) — the battling
        # client sends this exactly once per real (server-tracked) battle,
        # right as its own endBattle() tears the fight down, so there's
        # nothing to guard against double-sends being harmful either way.
        active_wild_battles.pop(user_id, None)
        await broadcast({"type": "wild_battle_end", "by_user_id": user_id}, exclude=conn.websocket)
        return


# --- The Karirs field --------------------------------------------------
# One global race at a time, shared by every connected player (no lobby
# concept — see KarirsRace's own docstring), on a fixed hourly cadence.
# Betting/payout math is games/karirs' own already-calibrated engine (see
# app/karirs_engine.py's own header comment for why it's copied rather than
# imported cross-service). Wagers/payouts are plain Glophiballs — no new
# currency — and a won payout sits unclaimed (KarirsBet.claimed) until the
# player actually walks up to Karra and claims it (see POST /karirs/claim),
# rather than crediting the bag automatically the instant a race resolves.
def _next_hour_boundary(now: datetime) -> datetime:
    candidate = now.replace(minute=0, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(hours=1)
    return candidate


def _karirs_signature_moves(db, racer_names: list[str]) -> dict[str, str]:
    rows = db.query(KarirsRacer).filter(KarirsRacer.name.in_(racer_names)).all()
    by_name = {r.name: r.signature_move for r in rows if r.signature_move}
    return {name: by_name.get(name, f"{name}'s Signature Move!") for name in racer_names}


def _karirs_race_out(db, race: KarirsRace) -> KarirsRaceOut:
    return KarirsRaceOut(
        id=race.id,
        racer_names=list(race.racer_names),
        status=race.status,
        winning_name=race.winning_name,
        steps=race.steps,
        payout_multipliers=race.payout_multipliers or {},
        signature_moves=_karirs_signature_moves(db, list(race.racer_names)),
        betting_closes_at=race.betting_closes_at,
        started_at=race.started_at,
        resolved_at=race.resolved_at,
    )


def _karirs_bet_out(bet: KarirsBet) -> KarirsBetOut:
    return KarirsBetOut(id=bet.id, race_id=bet.race_id, racer_name=bet.racer_name, wager=bet.wager, payout=bet.payout, claimed=bet.claimed)


def _karirs_previous_race_out(db, current_race_id: int) -> KarirsRaceOut | None:
    """The last race to actually finish before current_race_id — excludes
    that id itself so the narrow window between a race resolving and the
    next one being created (where the "current"/latest race briefly *is*
    the just-resolved one) never reports a race as its own previous race."""
    prev = (
        db.query(KarirsRace)
        .filter(KarirsRace.status == "resolved", KarirsRace.id != current_race_id)
        .order_by(KarirsRace.id.desc())
        .first()
    )
    return _karirs_race_out(db, prev) if prev is not None else None


async def _karirs_create_next_race(betting_closes_at: datetime) -> None:
    db = SessionLocal()
    try:
        racer_names = pick_racers(db)
        multipliers = compute_payout_multipliers(db, racer_names)
        race = KarirsRace(racer_names=racer_names, betting_closes_at=betting_closes_at, payout_multipliers=multipliers)
        db.add(race)
        try:
            db.commit()
        except IntegrityError:
            # Another process already created the race for this exact hour
            # boundary (confirmed happening in practice via the known
            # duplicate-spawn-on-restart case) — its own creation already
            # broadcast and scheduled the auto-resolve, so there's nothing
            # left for this caller to do.
            db.rollback()
            return
        db.refresh(race)
        race_id = race.id
        race_out = _karirs_race_out(db, race)
    finally:
        db.close()
    await broadcast({"type": "karirs_race_created", "race": race_out.model_dump(mode="json")})
    _schedule_karirs_auto_resolve(race_id, betting_closes_at)


def _schedule_karirs_auto_resolve(race_id: int, betting_closes_at: datetime) -> None:
    delay = (betting_closes_at - datetime.utcnow()).total_seconds()
    asyncio.create_task(_karirs_delay_then_run(race_id, delay))


async def _karirs_delay_then_run(race_id: int, delay_seconds: float) -> None:
    await asyncio.sleep(max(delay_seconds, 0))
    await _run_karirs_race(race_id)


def _finish_karirs_race(db, race: KarirsRace) -> None:
    """Applies payouts (left unclaimed — see POST /karirs/claim) and locks
    in the result. Only ever called once betting has genuinely closed and
    race.steps/winning_name are already known."""
    winner = race.winning_name
    multipliers = race.payout_multipliers or {}
    race.status = "resolved"
    race.resolved_at = datetime.utcnow()
    bets = db.query(KarirsBet).filter(KarirsBet.race_id == race.id).all()
    for bet in bets:
        bet.payout = round(bet.wager * multipliers.get(bet.racer_name, 1.0)) if bet.racer_name == winner else 0
    record_result(db, list(race.racer_names), winner)
    db.commit()
    db.refresh(race)


async def _run_karirs_race(race_id: int) -> None:
    db = SessionLocal()
    try:
        # Atomic claim (UPDATE ... WHERE status='betting_open'), not a plain
        # read-then-write — confirmed in practice that two processes (the
        # known duplicate-spawn-on-restart case) can both read
        # "betting_open" before either commits its own transition to
        # "racing", each then computing and broadcasting its own race. Only
        # the caller whose UPDATE actually matches a row proceeds.
        result = db.execute(
            text("UPDATE karirs_races SET status = 'racing', started_at = :started_at WHERE id = :id AND status = 'betting_open'"),
            {"started_at": datetime.utcnow(), "id": race_id},
        )
        db.commit()
        if result.rowcount == 0:
            return  # already handled (e.g. by a startup recovery pass) — don't double-run it
        race = db.get(KarirsRace, race_id)
        speed_factors = {name: speed_factor_for_multiplier(m) for name, m in (race.payout_multipliers or {}).items()}
        steps, winner = compute_race(list(race.racer_names), speed_factors)
        race.winning_name = winner
        race.steps = steps
        db.commit()
        race_out = _karirs_race_out(db, race)
    finally:
        db.close()

    await broadcast({"type": "karirs_race_started", "race": race_out.model_dump(mode="json")})

    # Real-time duration of the animation every watching client is replaying
    # locally — waited out here too so payouts (and the "resolved"
    # broadcast) never land before the race has actually finished playing.
    await asyncio.sleep(len(steps) * STEP_DELAY_SECONDS)

    db = SessionLocal()
    try:
        race = db.get(KarirsRace, race_id)
        _finish_karirs_race(db, race)
        race_out = _karirs_race_out(db, race)
    finally:
        db.close()

    await broadcast({"type": "karirs_race_resolved", "race": race_out.model_dump(mode="json")})

    # Immediately queues up next hour's race — there's always either a
    # betting-open or in-progress race, never a gap.
    await _karirs_create_next_race(_next_hour_boundary(datetime.utcnow()))


def _karirs_startup(db) -> None:
    seed_karirs_roster_if_empty(db)
    now = datetime.utcnow()

    # Guards against exactly the kind of double-run this project's own
    # near-simultaneous restart spawn can cause (see the deploy notes on a
    # duplicate process briefly existing before losing the port bind) —
    # harmless for the wild-spawn system (purely in-memory, the losing
    # process's state just vanishes with it), but this writes a real,
    # persistent race — two overlapping startups both seeing "no pending
    # race" and each creating one would leave a genuine duplicate behind
    # (confirmed the hard way). A MySQL named lock, not a plain in-process
    # Lock, since the duplicate here is cross-*process*.
    db.execute(text("SELECT GET_LOCK('glophimon_karirs_startup', 10)"))
    try:
        # A race already "racing" when the process last stopped can't resume
        # its lost in-flight animation timer — just conclude it immediately,
        # same recovery idea the wild-spawn system doesn't need (nothing
        # there persists across a restart) but a real-money-like betting
        # system does.
        for race in db.query(KarirsRace).filter(KarirsRace.status == "racing").all():
            if race.steps:
                _finish_karirs_race(db, race)

        pending = db.query(KarirsRace).filter(KarirsRace.status == "betting_open").order_by(KarirsRace.id.desc()).first()
        if pending is None:
            asyncio.create_task(_karirs_create_next_race(_next_hour_boundary(now)))
        elif pending.betting_closes_at <= now:
            asyncio.create_task(_run_karirs_race(pending.id))
        else:
            _schedule_karirs_auto_resolve(pending.id, pending.betting_closes_at)
    finally:
        db.execute(text("SELECT RELEASE_LOCK('glophimon_karirs_startup')"))


@app.on_event("startup")
async def _start_karirs() -> None:
    db = SessionLocal()
    try:
        _karirs_startup(db)
    finally:
        db.close()


@app.get("/karirs/state", response_model=KarirsStateOut)
def get_karirs_state(user_id: int = Depends(get_current_user_id)):
    db = SessionLocal()
    try:
        race = db.query(KarirsRace).order_by(KarirsRace.id.desc()).first()
        if race is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No race yet")
        my_bet = db.query(KarirsBet).filter(KarirsBet.race_id == race.id, KarirsBet.user_id == user_id).first()
        unclaimed_total = (
            db.query(func.sum(KarirsBet.payout))
            .filter(KarirsBet.user_id == user_id, KarirsBet.claimed.is_(False), KarirsBet.payout > 0)
            .scalar()
            or 0
        )
        return KarirsStateOut(
            race=_karirs_race_out(db, race),
            my_bet=_karirs_bet_out(my_bet) if my_bet else None,
            unclaimed_total=int(unclaimed_total),
            previous_race=_karirs_previous_race_out(db, race.id),
        )
    finally:
        db.close()


@app.post("/karirs/bet", response_model=KarirsBetOut, status_code=201)
def place_karirs_bet(body: KarirsBetCreate, user_id: int = Depends(get_current_user_id)):
    db = SessionLocal()
    try:
        race = db.query(KarirsRace).order_by(KarirsRace.id.desc()).first()
        if race is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No race yet")
        if race.status != "betting_open" or race.betting_closes_at <= datetime.utcnow():
            raise HTTPException(status.HTTP_409_CONFLICT, "Betting is closed for this race")
        if body.racer_name not in race.racer_names:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown racer name")
        existing = db.query(KarirsBet).filter(KarirsBet.race_id == race.id, KarirsBet.user_id == user_id).first()
        if existing is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "Already bet on this race")

        inventory = db.get(GlophimonInventory, user_id)
        if inventory is None:
            inventory = GlophimonInventory(user_id=user_id)
            db.add(inventory)
            db.flush()
        if inventory.g_coins < body.wager:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Not enough G-coins")
        inventory.g_coins -= body.wager

        bet = KarirsBet(race_id=race.id, user_id=user_id, racer_name=body.racer_name, wager=body.wager)
        db.add(bet)
        db.commit()
        db.refresh(bet)
        return _karirs_bet_out(bet)
    finally:
        db.close()


@app.post("/karirs/claim", response_model=KarirsClaimOut)
def claim_karirs_prize(user_id: int = Depends(get_current_user_id)):
    db = SessionLocal()
    try:
        bets = (
            db.query(KarirsBet)
            .filter(KarirsBet.user_id == user_id, KarirsBet.claimed.is_(False), KarirsBet.payout > 0)
            .all()
        )
        total = sum(b.payout for b in bets)
        if total <= 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nothing to claim")
        for b in bets:
            b.claimed = True

        inventory = db.get(GlophimonInventory, user_id)
        if inventory is None:
            inventory = GlophimonInventory(user_id=user_id)
            db.add(inventory)
            db.flush()
        inventory.g_coins += total
        db.commit()
        db.refresh(inventory)
        return KarirsClaimOut(claimed_amount=total, inventory=_inventory_out(inventory))
    finally:
        db.close()


def _character_out(row: GlophimonCharacter) -> CharacterOut:
    return CharacterOut(
        display_name=row.display_name,
        head_color=row.head_color,
        body_color=row.body_color,
        arm_color=row.arm_color,
        leg_color=row.leg_color,
        gender=row.gender,
        x=row.x,
        z=row.z,
        facing=row.facing,
        floor=row.floor,
        current_hp=row.current_hp,
        pose_overrides=row.pose_overrides or {},
        camera_overrides=row.camera_overrides or {},
    )


# The only 6 pose slots the client's own Pose Designer offers — see
# game.js's own POSE_DESIGNER_PARTS/mount() and character.js's pose
# functions. Enforced here too (not just in the client's own <select>) so a
# stray/hand-crafted request can't wedge in an arbitrary key the client-side
# playback dispatch would never recognize anyway.
POSE_OVERRIDE_SLOTS = {"idle", "walk", "ready", "attack", "defend", "cast"}


@app.put("/me/pose-overrides/{pose_name}", response_model=CharacterOut)
def save_pose_override(pose_name: str, body: PoseOverrideUpdate, user_id: int = Depends(get_current_user_id)):
    if pose_name not in POSE_OVERRIDE_SLOTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown pose slot")
    db = SessionLocal()
    try:
        row = db.get(GlophimonCharacter, user_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No character yet")
        # Reassigned wholesale (not mutated in place) — SQLAlchemy only
        # detects a JSON column's own dirty state on assignment, not on
        # mutating a dict it already handed back from a previous read.
        overrides = dict(row.pose_overrides or {})
        overrides[pose_name] = {"keyframes": body.keyframes}
        row.pose_overrides = overrides
        db.commit()
        db.refresh(row)
        return _character_out(row)
    finally:
        db.close()


@app.delete("/me/pose-overrides/{pose_name}", response_model=CharacterOut)
def reset_pose_override(pose_name: str, user_id: int = Depends(get_current_user_id)):
    if pose_name not in POSE_OVERRIDE_SLOTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown pose slot")
    db = SessionLocal()
    try:
        row = db.get(GlophimonCharacter, user_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No character yet")
        overrides = dict(row.pose_overrides or {})
        overrides.pop(pose_name, None)
        row.pose_overrides = overrides
        db.commit()
        db.refresh(row)
        return _character_out(row)
    finally:
        db.close()


# The client's own Camera Designer offers 3 reset/orbit slots (the original
# "nothing focused" wide framing per battle type) plus 4 focus-camera slots
# now, all belonging to the wild battle only — see game.js's own
# CAMERA_OVERRIDE_SLOTS/focusWildCameraOnRig and mount(). Kept as two
# separate sets (rather than one combined CAMERA_OVERRIDE_SLOTS, which is
# still their union for the membership check both the PUT and DELETE
# handlers need) so save_camera_override below knows which of the two
# request shapes — CameraOverrideUpdate vs CameraFocusOverrideUpdate — a
# given slot_name's body must validate against. Enforced here too, same
# reasoning as POSE_OVERRIDE_SLOTS above, so a stray request can't wedge in
# an arbitrary key none of the real per-frame battle camera code would ever
# actually read.
ORBIT_CAMERA_SLOTS = {"wild", "team", "pvp"}
FOCUS_CAMERA_SLOTS = {"wild_decide_defend", "wild_declare", "wild_attack_scene", "wild_defend_scene"}
CAMERA_OVERRIDE_SLOTS = ORBIT_CAMERA_SLOTS | FOCUS_CAMERA_SLOTS


@app.put("/me/camera-overrides/{slot_name}", response_model=CharacterOut)
def save_camera_override(slot_name: str, body: dict, user_id: int = Depends(get_current_user_id)):
    if slot_name not in CAMERA_OVERRIDE_SLOTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown camera slot")
    # FastAPI can't pick a request-body model per path parameter at route-
    # declaration time, so this takes the raw dict and validates it by hand
    # against whichever of the two real shapes this slot_name belongs to —
    # still real Field(ge=..., le=...) bounds either way (see
    # CameraOverrideUpdate/CameraFocusOverrideUpdate in schemas.py), just
    # picked here instead of in the signature.
    model = CameraOverrideUpdate if slot_name in ORBIT_CAMERA_SLOTS else CameraFocusOverrideUpdate
    try:
        validated = model(**body)
    except ValidationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
    db = SessionLocal()
    try:
        row = db.get(GlophimonCharacter, user_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No character yet")
        # Reassigned wholesale (not mutated in place) — same reasoning as
        # save_pose_override above: SQLAlchemy only detects a JSON column's
        # own dirty state on assignment, never on mutating a dict it already
        # handed back from a previous read.
        overrides = dict(row.camera_overrides or {})
        overrides[slot_name] = validated.model_dump()
        row.camera_overrides = overrides
        db.commit()
        db.refresh(row)
        return _character_out(row)
    finally:
        db.close()


@app.delete("/me/camera-overrides/{slot_name}", response_model=CharacterOut)
def reset_camera_override(slot_name: str, user_id: int = Depends(get_current_user_id)):
    if slot_name not in CAMERA_OVERRIDE_SLOTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown camera slot")
    db = SessionLocal()
    try:
        row = db.get(GlophimonCharacter, user_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No character yet")
        overrides = dict(row.camera_overrides or {})
        overrides.pop(slot_name, None)
        row.camera_overrides = overrides
        db.commit()
        db.refresh(row)
        return _character_out(row)
    finally:
        db.close()


# The player's own trainer HP, shared by every battle type (wild and the
# 3v3-vs-NPC simulation alike) — same value GlophimonCharacter.current_hp
# defaults to. Doesn't recharge between battles on its own; see
# POST /me/hp, which the client calls both to persist damage taken and to
# apply Rodz's heal (or the free heal that comes with blacking out).
PLAYER_MAX_HP = 200


@app.post("/me/hp", response_model=CharacterOut)
def set_hp(body: HpUpdate, user_id: int = Depends(get_current_user_id)):
    db = SessionLocal()
    try:
        row = db.get(GlophimonCharacter, user_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No character yet")
        row.current_hp = min(body.current_hp, PLAYER_MAX_HP)
        db.commit()
        db.refresh(row)
        return _character_out(row)
    finally:
        db.close()


@app.get("/me", response_model=CharacterOut)
def get_me(user_id: int = Depends(get_current_user_id)):
    db = SessionLocal()
    try:
        row = db.get(GlophimonCharacter, user_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No character yet")
        return _character_out(row)
    finally:
        db.close()


@app.post("/me", response_model=CharacterOut)
def create_me(body: CharacterCreate, user_id: int = Depends(get_current_user_id)):
    db = SessionLocal()
    try:
        if db.get(GlophimonCharacter, user_id) is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "Character already created")
        row = GlophimonCharacter(
            user_id=user_id,
            display_name=body.display_name.strip()[:64] or "Trainer",
            head_color=body.head_color,
            body_color=body.body_color,
            arm_color=body.arm_color,
            leg_color=body.leg_color,
            gender=body.gender,
            x=DEFAULT_SPAWN["x"],
            z=DEFAULT_SPAWN["z"],
            facing=DEFAULT_SPAWN["facing"],
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return _character_out(row)
    finally:
        db.close()


@app.get("/species", response_model=list[SpeciesOut])
def list_species(_user_id: int = Depends(get_current_user_id)):
    return [SpeciesOut(**s) for s in SPECIES]


def _owned_out(row: GlophimonOwned) -> OwnedOut:
    return OwnedOut(
        species_key=row.species_key,
        level=row.level,
        experience=row.experience,
        iv_speed=row.iv_speed,
        iv_attack=row.iv_attack,
        iv_special_attack=row.iv_special_attack,
        iv_defense=row.iv_defense,
        iv_special_defense=row.iv_special_defense,
        ev_speed=row.ev_speed,
        ev_attack=row.ev_attack,
        ev_special_attack=row.ev_special_attack,
        ev_defense=row.ev_defense,
        ev_special_defense=row.ev_special_defense,
    )


@app.get("/starter", response_model=OwnedOut)
def get_starter(user_id: int = Depends(get_current_user_id)):
    # "Do you own anything yet at all" doubles as "have you picked your
    # starter" — starter selection is always the very first thing a new
    # account owns, and a future catch system only becomes reachable after
    # this step, so there's no separate flag needed.
    db = SessionLocal()
    try:
        row = db.execute(
            select(GlophimonOwned).where(GlophimonOwned.user_id == user_id).order_by(GlophimonOwned.id).limit(1)
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No Glophimon yet")
        return _owned_out(row)
    finally:
        db.close()


@app.post("/starter", response_model=OwnedOut)
def create_starter(body: StarterCreate, user_id: int = Depends(get_current_user_id)):
    species = SPECIES_BY_KEY.get(body.species_key)
    if species is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown species")
    if species["tier"] != "common":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Starters must be a Common-tier Glophimon")

    db = SessionLocal()
    try:
        # Defensive backstop, same reasoning as the WS endpoint's own
        # no_character check — the real vscode client always completes
        # character creation before ever reaching the starter picker.
        if db.get(GlophimonCharacter, user_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "No character yet")

        existing = db.execute(
            select(GlophimonOwned).where(GlophimonOwned.user_id == user_id).limit(1)
        ).scalar_one_or_none()
        if existing is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "Already have a starter")

        row = GlophimonOwned(
            user_id=user_id,
            species_key=body.species_key,
            level=1,
            active_slot=0,  # the only Glophimon so far — automatically active
            iv_speed=random.randint(IV_MIN, IV_MAX),
            iv_attack=random.randint(IV_MIN, IV_MAX),
            iv_special_attack=random.randint(IV_MIN, IV_MAX),
            iv_defense=random.randint(IV_MIN, IV_MAX),
            iv_special_defense=random.randint(IV_MIN, IV_MAX),
        )
        db.add(row)

        # The bag starts stocked exactly once, alongside the starter —
        # catching (a Glophiball) and what Potions actually do are both a
        # separate later discussion; this just makes sure GET /me/inventory
        # always has something real to show.
        if db.get(GlophimonInventory, user_id) is None:
            db.add(GlophimonInventory(user_id=user_id))

        db.commit()
        db.refresh(row)
        return _owned_out(row)
    finally:
        db.close()


def _owned_glophimon_out(row: GlophimonOwned) -> OwnedGlophimonOut:
    species = SPECIES_BY_KEY[row.species_key]
    return OwnedGlophimonOut(
        id=row.id,
        species_key=row.species_key,
        species_name=species["name"],
        tier=species["tier"],
        types=species["types"],
        level=row.level,
        experience=row.experience,
        active_slot=row.active_slot,
        iv_speed=row.iv_speed,
        iv_attack=row.iv_attack,
        iv_special_attack=row.iv_special_attack,
        iv_defense=row.iv_defense,
        iv_special_defense=row.iv_special_defense,
        ev_speed=row.ev_speed,
        ev_attack=row.ev_attack,
        ev_special_attack=row.ev_special_attack,
        ev_defense=row.ev_defense,
        ev_special_defense=row.ev_special_defense,
        current_hp=row.current_hp,
    )


@app.get("/me/glophimon", response_model=list[OwnedGlophimonOut])
def list_my_glophimon(user_id: int = Depends(get_current_user_id)):
    db = SessionLocal()
    try:
        rows = db.execute(
            select(GlophimonOwned)
            .where(GlophimonOwned.user_id == user_id)
            # Active slots first (in slot order), boxed ones after — NULLS
            # LAST isn't portable across every DB but MySQL's own default
            # ASC ordering already sorts NULL first, so invert with a
            # simple "is it boxed" flag instead of relying on that quirk.
            .order_by((GlophimonOwned.active_slot.is_(None)).asc(), GlophimonOwned.active_slot.asc(), GlophimonOwned.id.asc())
        ).scalars().all()
        return [_owned_glophimon_out(row) for row in rows]
    finally:
        db.close()


@app.post("/me/glophimon/{owned_id}/activate", response_model=list[OwnedGlophimonOut])
def activate_glophimon(owned_id: int, body: ActivateRequest, user_id: int = Depends(get_current_user_id)):
    db = SessionLocal()
    try:
        target = db.get(GlophimonOwned, owned_id)
        if target is None or target.user_id != user_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such Glophimon")

        # Whoever currently holds that slot gets bumped to the PC — this is
        # a swap, not a rejection, so the menu can always just say "put
        # this one in slot N" without the player first manually clearing it.
        occupant = db.execute(
            select(GlophimonOwned).where(
                GlophimonOwned.user_id == user_id,
                GlophimonOwned.active_slot == body.slot,
                GlophimonOwned.id != owned_id,
            )
        ).scalar_one_or_none()
        if occupant is not None:
            occupant.active_slot = None

        target.active_slot = body.slot
        db.commit()

        rows = db.execute(
            select(GlophimonOwned)
            .where(GlophimonOwned.user_id == user_id)
            .order_by((GlophimonOwned.active_slot.is_(None)).asc(), GlophimonOwned.active_slot.asc(), GlophimonOwned.id.asc())
        ).scalars().all()
        return [_owned_glophimon_out(row) for row in rows]
    finally:
        db.close()


@app.post("/me/glophimon/{owned_id}/deactivate", response_model=list[OwnedGlophimonOut])
def deactivate_glophimon(owned_id: int, user_id: int = Depends(get_current_user_id)):
    db = SessionLocal()
    try:
        target = db.get(GlophimonOwned, owned_id)
        if target is None or target.user_id != user_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such Glophimon")
        if target.active_slot is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Already in the PC")

        active_count = db.execute(
            select(GlophimonOwned).where(GlophimonOwned.user_id == user_id, GlophimonOwned.active_slot.is_not(None))
        ).scalars().all()
        if len(active_count) <= 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Must keep at least one active Glophimon")

        target.active_slot = None
        db.commit()

        rows = db.execute(
            select(GlophimonOwned)
            .where(GlophimonOwned.user_id == user_id)
            .order_by((GlophimonOwned.active_slot.is_(None)).asc(), GlophimonOwned.active_slot.asc(), GlophimonOwned.id.asc())
        ).scalars().all()
        return [_owned_glophimon_out(row) for row in rows]
    finally:
        db.close()


@app.post("/me/glophimon", response_model=list[OwnedGlophimonOut])
def catch_glophimon(body: CatchRequest, user_id: int = Depends(get_current_user_id)):
    # A successful catch in the wild-battle simulation lands here — see the
    # client's own catch animation/chance system (game.js). Auto-assigned
    # to the first free active slot (0/1/2), same "space in the lineup, or
    # the PC otherwise" rule the model's own docstring already describes;
    # special_attack/special_defense are rolled fresh since the current
    # battle simulation doesn't track either at all.
    species = SPECIES_BY_KEY.get(body.species_key)
    if species is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown species")

    db = SessionLocal()
    try:
        if db.get(GlophimonCharacter, user_id) is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "No character yet")

        taken_slots = {
            row.active_slot
            for row in db.execute(
                select(GlophimonOwned).where(GlophimonOwned.user_id == user_id, GlophimonOwned.active_slot.is_not(None))
            ).scalars().all()
        }
        free_slot = next((slot for slot in (0, 1, 2) if slot not in taken_slots), None)

        row = GlophimonOwned(
            user_id=user_id,
            species_key=body.species_key,
            level=body.level,
            active_slot=free_slot,
            iv_speed=body.iv_speed,
            iv_attack=body.iv_attack,
            iv_special_attack=random.randint(IV_MIN, IV_MAX),
            iv_defense=body.iv_defense,
            iv_special_defense=random.randint(IV_MIN, IV_MAX),
        )
        db.add(row)
        db.commit()

        rows = db.execute(
            select(GlophimonOwned)
            .where(GlophimonOwned.user_id == user_id)
            .order_by((GlophimonOwned.active_slot.is_(None)).asc(), GlophimonOwned.active_slot.asc(), GlophimonOwned.id.asc())
        ).scalars().all()
        return [_owned_glophimon_out(row) for row in rows]
    finally:
        db.close()


def _exp_for_level(level: int) -> int:
    return level**EXP_LEVEL_EXPONENT


def _apply_battle_result(row: GlophimonOwned, species: dict, defeated_level: int) -> tuple[int, int, int]:
    """Awards EXP (from defeating/catching `species` at `defeated_level`)
    and this species' own EV yield to `row`, mutating it in place. Returns
    (exp_gained, level_before, level_after) for the caller's response —
    the client needs these to announce what just happened without
    re-deriving any of this math itself."""
    level_before = row.level
    if row.level >= MAX_LEVEL:
        return 0, level_before, level_before  # already maxed — no more EXP possible

    exp_gained = (EXP_BASE_YIELD[species["tier"]] * defeated_level) // EXP_YIELD_FACTOR
    row.experience = min(row.experience + exp_gained, MAX_EXP)
    while row.level < MAX_LEVEL and row.experience >= _exp_for_level(row.level + 1):
        row.level += 1

    # EV yield — capped per-stat (252) and in total (510), clamped rather
    # than discarded outright: applied in the species' own listed stat
    # order so a Glophimon near the total cap still uses whatever room is
    # left instead of losing the whole award to one stat hogging it.
    current_total = row.ev_speed + row.ev_attack + row.ev_special_attack + row.ev_defense + row.ev_special_defense
    remaining_total = max(0, EV_CAP_TOTAL - current_total)
    for field, amount in EV_YIELD_BY_SPECIES.get(species["key"], []):
        if remaining_total <= 0:
            break
        current_stat = getattr(row, field)
        gain = min(amount, EV_CAP_PER_STAT - current_stat, remaining_total)
        if gain > 0:
            setattr(row, field, current_stat + gain)
            remaining_total -= gain

    return exp_gained, level_before, row.level


@app.post("/me/glophimon/battle-result", response_model=BattleResultOut)
def apply_battle_result(body: BattleResultRequest, user_id: int = Depends(get_current_user_id)):
    # Client-claimed species/level is trusted only for the Dev-menu
    # "Simulate Wild Battle" path (no real wild_id there). Whenever wild_id
    # IS present, the server's own record is the only thing trusted — a
    # missing/mismatched wild is rejected outright rather than silently
    # falling back to the client's claim, which would just reopen the same
    # exploit (claim a real-looking wild_id that's already gone, plus a
    # fabricated species/level). The client must call this before
    # /wild/{id}/caught or /wild/{id}/release, while the record still
    # exists — same authority pattern those two endpoints already use.
    species_key, defeated_level = body.defeated_species_key, body.defeated_level
    if body.wild_id is not None:
        wild = wild_spawns.get(body.wild_id)
        if wild is None or wild.engaged_by != user_id:
            raise HTTPException(status.HTTP_409_CONFLICT, "That wild encounter is no longer valid")
        species_key, defeated_level = wild.species_key, wild.level

    species = SPECIES_BY_KEY.get(species_key)
    if species is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown species")

    db = SessionLocal()
    try:
        rows = db.execute(
            select(GlophimonOwned).where(GlophimonOwned.user_id == user_id, GlophimonOwned.id.in_(body.participant_ids))
        ).scalars().all()

        participants = []
        for row in rows:
            exp_gained, level_before, level_after = _apply_battle_result(row, species, defeated_level)
            participants.append(BattleResultParticipant(id=row.id, exp_gained=exp_gained, level_before=level_before, level_after=level_after))
        db.commit()

        all_rows = db.execute(
            select(GlophimonOwned)
            .where(GlophimonOwned.user_id == user_id)
            .order_by((GlophimonOwned.active_slot.is_(None)).asc(), GlophimonOwned.active_slot.asc(), GlophimonOwned.id.asc())
        ).scalars().all()
        return BattleResultOut(glophimon=[_owned_glophimon_out(row) for row in all_rows], participants=participants)
    finally:
        db.close()


@app.post("/me/glophimon/hp", response_model=list[OwnedGlophimonOut])
def set_glophimon_hp(body: GlophimonHpUpdate, user_id: int = Depends(get_current_user_id)):
    # Persists Glophimon HP the same way POST /me/hp already does for the
    # trainer — fire-and-forget from the client, called at the end of every
    # battle (see game.js's own syncOwnedGlophimonHp, invoked from
    # endBattle regardless of outcome) and by Rodz's heal (which sends the
    # whole roster back to full in one call). No max-HP clamp here — the
    # client is the one source of truth for what max HP a given species/
    # level combination has (see maxHpFor), same trust level the rest of
    # battle simulation already has client-side; only >=0 is enforced
    # (GlophimonHpEntry.current_hp). Ids not owned by this account (or not
    # owned at all) are silently skipped rather than erroring the whole
    # batch, so one stale id can't block the rest of a real update.
    db = SessionLocal()
    try:
        by_id = {entry.id: entry.current_hp for entry in body.updates}
        rows = db.execute(
            select(GlophimonOwned).where(GlophimonOwned.user_id == user_id, GlophimonOwned.id.in_(by_id.keys()))
        ).scalars().all()
        for row in rows:
            row.current_hp = by_id[row.id]
        db.commit()

        all_rows = db.execute(
            select(GlophimonOwned)
            .where(GlophimonOwned.user_id == user_id)
            .order_by((GlophimonOwned.active_slot.is_(None)).asc(), GlophimonOwned.active_slot.asc(), GlophimonOwned.id.asc())
        ).scalars().all()
        return [_owned_glophimon_out(row) for row in all_rows]
    finally:
        db.close()


@app.post("/me/glophimon/{owned_id}/release", response_model=list[OwnedGlophimonOut])
def release_glophimon(owned_id: int, user_id: int = Depends(get_current_user_id)):
    # Permanently dumps an unwanted Glophimon — active or boxed, doesn't
    # matter (nothing currently reads "must have an active lineup" the way
    # battles are still built directly off the starter, see the game's own
    # notes on that), except the account's very last one, so nobody can
    # release themselves down to owning nothing at all.
    db = SessionLocal()
    try:
        target = db.get(GlophimonOwned, owned_id)
        if target is None or target.user_id != user_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such Glophimon")

        total_count = db.execute(
            select(GlophimonOwned).where(GlophimonOwned.user_id == user_id)
        ).scalars().all()
        if len(total_count) <= 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Can't release your only Glophimon")

        db.delete(target)
        db.commit()

        rows = db.execute(
            select(GlophimonOwned)
            .where(GlophimonOwned.user_id == user_id)
            .order_by((GlophimonOwned.active_slot.is_(None)).asc(), GlophimonOwned.active_slot.asc(), GlophimonOwned.id.asc())
        ).scalars().all()
        return [_owned_glophimon_out(row) for row in rows]
    finally:
        db.close()


@app.get("/me/inventory", response_model=InventoryOut)
def get_inventory(user_id: int = Depends(get_current_user_id)):
    db = SessionLocal()
    try:
        row = db.get(GlophimonInventory, user_id)
        if row is None:
            # Defensive backstop — every real account gets one created
            # alongside its starter (see create_starter above).
            row = GlophimonInventory(user_id=user_id)
            db.add(row)
            db.commit()
            db.refresh(row)
        return _inventory_out(row)
    finally:
        db.close()


@app.post("/me/inventory/use-glophiball", response_model=InventoryOut)
def use_glophiball(user_id: int = Depends(get_current_user_id)):
    """Spends one real Glophiball from the bag — called whenever a wild
    battle actually throws one, whether or not the catch itself succeeds
    (a thrown ball is spent either way, same as the real games)."""
    db = SessionLocal()
    try:
        row = db.get(GlophimonInventory, user_id)
        if row is None:
            row = GlophimonInventory(user_id=user_id)
            db.add(row)
            db.flush()
        if row.glophiballs <= 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "No Glophiballs left")
        row.glophiballs -= 1
        db.commit()
        db.refresh(row)
        return _inventory_out(row)
    finally:
        db.close()


@app.post("/me/inventory/claim-daily", response_model=DailyClaimOut)
def claim_daily(user_id: int = Depends(get_current_user_id)):
    """Rodz's free Glophiballs — once per UTC calendar date (see
    _daily_claim_available)."""
    db = SessionLocal()
    try:
        row = db.get(GlophimonInventory, user_id)
        if row is None:
            row = GlophimonInventory(user_id=user_id)
            db.add(row)
            db.flush()
        if not _daily_claim_available(row):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Already claimed today")
        row.glophiballs += DAILY_CLAIM_GLOPHIBALLS
        row.last_daily_claim_date = _today_utc()
        db.commit()
        db.refresh(row)
        return DailyClaimOut(inventory=_inventory_out(row))
    finally:
        db.close()


# Jared's shop, inside Glophics (see the client's own JARED_NAME/
# buildJaredShop) — priced in G-coins, not Glophiballs, so buying more
# catching stock is one of the things Karirs winnings are actually good
# for. Only one item exists today; a second is just another dict entry
# plus, if it credits a different inventory column, one more branch below.
SHOP_ITEMS = {"glophiball": {"price_g_coins": 100, "inventory_field": "glophiballs"}}


@app.post("/shop/buy", response_model=InventoryOut)
def buy_shop_item(body: ShopBuyCreate, user_id: int = Depends(get_current_user_id)):
    item = SHOP_ITEMS.get(body.item_key)
    if item is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown item")
    cost = item["price_g_coins"] * body.quantity
    db = SessionLocal()
    try:
        row = db.get(GlophimonInventory, user_id)
        if row is None:
            row = GlophimonInventory(user_id=user_id)
            db.add(row)
            db.flush()
        if row.g_coins < cost:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Not enough G-coins")
        row.g_coins -= cost
        field = item["inventory_field"]
        setattr(row, field, getattr(row, field) + body.quantity)
        db.commit()
        db.refresh(row)
        return _inventory_out(row)
    finally:
        db.close()


# --- Luba lobby (Stage 1: hosting/inviting/readying, no match handoff yet) -
# Entirely in-memory, no DB table — same "ephemeral shared world state"
# shape as wild_spawns/WildSpawn above, just keyed by a synthetic lobby id
# instead of a wild id. A future stage consumes a lobby once every member
# is ready to actually start a real Luba match; this stage only gets it to
# that point.
class LubaLobbyMember:
    __slots__ = ("user_id", "display_name", "status")

    def __init__(self, user_id: int, display_name: str, status: str) -> None:
        self.user_id = user_id
        self.display_name = display_name
        self.status = status  # "invited" | "accepted" | "ready"


class LubaLobbyState:
    __slots__ = ("id", "host_id", "mode", "duration_s", "members", "created_at")

    def __init__(self, lobby_id: int, host_id: int, host_name: str, mode: str, duration_s: int) -> None:
        self.id = lobby_id
        self.host_id = host_id
        self.mode = mode
        self.duration_s = duration_s
        # The host starts at "accepted", not auto-"ready" — "start once
        # everyone has chosen ready" reads as applying to the host too, so
        # no special-cased exemption from readying up.
        self.members: dict[int, LubaLobbyMember] = {host_id: LubaLobbyMember(host_id, host_name, "accepted")}
        self.created_at = time.monotonic()


LUBA_MAX_MEMBERS = 8
LUBA_DURATION_OPTIONS_S = (180, 300, 600)  # 3/5/10 min preset buttons — must match the client's own list

luba_lobbies: dict[int, LubaLobbyState] = {}
# Starts far above anything Cheddar's own real game_lobbies.id sequence
# will ever reach — Luba's own backend keys _rooms/_match_configs by a bare,
# unnamespaced int with no origin-tracking (see the game's own plan file),
# so a small counter here could otherwise collide with a real Cheddar-
# hosted Luba match using the same small id and silently merge the two.
_next_luba_lobby_id = 900_000_000
# user_id -> lobby_id, so a disconnect/leave/re-host request can find a
# player's current lobby (as host or member) in O(1) instead of scanning
# luba_lobbies.values() — same "keyed lookup over scan" preference
# connections/wild_spawns already follow.
_luba_member_lobby: dict[int, int] = {}


def _is_inside_luba(x: float, z: float) -> bool:
    return abs(x - LUBA_X) <= LUBA_HALF and abs(z - LUBA_Z) <= LUBA_HALF


async def _broadcast_lobby(lobby: LubaLobbyState) -> None:
    payload = {
        "type": "luba_lobby_state",
        "lobby_id": lobby.id,
        "host_id": lobby.host_id,
        "mode": lobby.mode,
        "duration_s": lobby.duration_s,
        "members": [
            {"user_id": m.user_id, "display_name": m.display_name, "status": m.status} for m in lobby.members.values()
        ],
    }
    for member_id in list(lobby.members.keys()):
        await send_to(member_id, payload)


async def _remove_from_luba_lobby(lobby: LubaLobbyState, user_id: int) -> None:
    # Removes user_id from the lobby, whether they were the host or a plain
    # member. If the host is the one leaving and others remain, the next
    # member (dict insertion order — first one who joined after the
    # now-departed host) is promoted rather than dissolving the whole
    # lobby out from under everyone else — a host leaving (or dropping)
    # shouldn't end the party for people still there and ready to play.
    # Only actually dissolves if this would otherwise leave it empty.
    # Deliberately does NOT notify user_id themselves — callers differ on
    # whether they even still have a live connection to notify (an explicit
    # luba_leave does; a disconnect cleanup doesn't), so that's on them.
    was_host = lobby.host_id == user_id
    lobby.members.pop(user_id, None)
    _luba_member_lobby.pop(user_id, None)
    if not lobby.members:
        luba_lobbies.pop(lobby.id, None)
        return
    if was_host:
        lobby.host_id = next(iter(lobby.members))
    await _broadcast_lobby(lobby)


async def _handle_luba_message(user_id: int, conn: "Connection", msg: dict) -> None:
    msg_type = msg.get("type")

    if msg_type == "luba_host_request":
        if user_id in _luba_member_lobby:
            await send_to(user_id, {"type": "luba_error", "reason": "already_in_lobby"})
            return
        if not _is_inside_luba(conn.x, conn.z):
            await send_to(user_id, {"type": "luba_error", "reason": "not_in_luba_area"})
            return
        mode = msg.get("mode")
        duration_s = msg.get("duration_s")
        if mode != "deathmatch" or duration_s not in LUBA_DURATION_OPTIONS_S:
            await send_to(user_id, {"type": "luba_error", "reason": "invalid_host_request"})
            return
        global _next_luba_lobby_id
        lobby_id = _next_luba_lobby_id
        _next_luba_lobby_id += 1
        lobby = LubaLobbyState(lobby_id, user_id, conn.display_name, mode, duration_s)
        luba_lobbies[lobby_id] = lobby
        _luba_member_lobby[user_id] = lobby_id
        await _broadcast_lobby(lobby)
        return

    lobby_id = _luba_member_lobby.get(user_id)
    lobby = luba_lobbies.get(lobby_id) if lobby_id is not None else None

    if msg_type == "luba_invite":
        if lobby is None or lobby.host_id != user_id:
            await send_to(user_id, {"type": "luba_error", "reason": "not_hosting"})
            return
        target_id = msg.get("target_user_id")
        if len(lobby.members) >= LUBA_MAX_MEMBERS:
            await send_to(user_id, {"type": "luba_error", "reason": "lobby_full"})
            return
        if target_id in lobby.members:
            await send_to(user_id, {"type": "luba_error", "reason": "already_in_lobby"})
            return
        target_conn = connections.get(target_id)
        # Re-checked server-side rather than trusting the host's own local
        # peers-map proximity filter, which could be stale.
        if target_conn is None or not _is_inside_luba(target_conn.x, target_conn.z):
            await send_to(user_id, {"type": "luba_error", "reason": "target_not_in_luba_area"})
            return
        lobby.members[target_id] = LubaLobbyMember(target_id, target_conn.display_name, "invited")
        _luba_member_lobby[target_id] = lobby.id
        await _broadcast_lobby(lobby)
        return

    if msg_type == "luba_respond":
        target_lobby = luba_lobbies.get(msg.get("lobby_id"))
        member = target_lobby.members.get(user_id) if target_lobby else None
        if target_lobby is None or member is None or member.status != "invited":
            await send_to(user_id, {"type": "luba_error", "reason": "no_pending_invite"})
            return
        if msg.get("accept"):
            member.status = "accepted"
        else:
            del target_lobby.members[user_id]
            _luba_member_lobby.pop(user_id, None)
        await _broadcast_lobby(target_lobby)
        return

    if msg_type == "luba_ready":
        member = lobby.members.get(user_id) if lobby else None
        if lobby is None or member is None or member.status == "invited":
            await send_to(user_id, {"type": "luba_error", "reason": "must_accept_first"})
            return
        member.status = "ready" if msg.get("ready") else "accepted"
        await _broadcast_lobby(lobby)
        return

    if msg_type == "luba_leave":
        if lobby is None:
            return
        # The leaver's own client needs to hear this too, same as a kicked
        # member does — _remove_from_luba_lobby only broadcasts to whoever
        # is LEFT, so without this the leaver's own modal would just sit
        # there forever looking like the button did nothing.
        await send_to(user_id, {"type": "luba_lobby_closed", "lobby_id": lobby.id, "reason": "left"})
        await _remove_from_luba_lobby(lobby, user_id)
        return

    if msg_type == "luba_kick":
        if lobby is None or lobby.host_id != user_id:
            await send_to(user_id, {"type": "luba_error", "reason": "not_hosting"})
            return
        target_id = msg.get("target_user_id")
        if target_id == lobby.host_id or target_id not in lobby.members:
            await send_to(user_id, {"type": "luba_error", "reason": "no_such_member"})
            return
        del lobby.members[target_id]
        _luba_member_lobby.pop(target_id, None)
        await send_to(target_id, {"type": "luba_lobby_closed", "lobby_id": lobby.id, "reason": "kicked"})
        await _broadcast_lobby(lobby)
        return

    if msg_type == "luba_start":
        if lobby is None or lobby.host_id != user_id:
            await send_to(user_id, {"type": "luba_error", "reason": "not_hosting"})
            return
        if not all(m.status == "ready" for m in lobby.members.values()):
            await send_to(user_id, {"type": "luba_error", "reason": "not_everyone_ready"})
            return
        # Configures the real Luba match's duration BEFORE any client learns
        # this lobby_id — this ordering is what makes it race-free: nobody
        # can connect to Luba's own /ws and have _get_room lazily create the
        # room with its own DEFAULT_MATCH_DURATION_S fallback before this
        # lands, because luba_start_ack (below) is the only way any client
        # ever finds out what lobby_id to connect with. Server-to-server
        # only — this token is never sent to any client.
        match_token = jose_jwt.encode(
            {"sub": str(lobby.host_id), "type": "access", "exp": int(time.time()) + 60},
            settings.jwt_secret_key,
            algorithm=settings.jwt_algorithm,
        )
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.post(
                    f"{settings.luba_api_base_url}/matches",
                    json={"lobby_id": lobby.id, "duration_s": float(lobby.duration_s)},
                    headers={"Authorization": f"Bearer {match_token}"},
                )
            resp.raise_for_status()
        except Exception:
            await send_to(user_id, {"type": "luba_error", "reason": "luba_unreachable"})
            return
        member_ids = list(lobby.members.keys())
        for member_id in member_ids:
            await send_to(member_id, {"type": "luba_start_ack", "lobby_id": lobby.id})
        # The lobby's whole purpose is served the instant everyone's been
        # told where to connect — unlike Stage 1, which deliberately left
        # this alive for a later stage (this one) to consume and clean up.
        for member_id in member_ids:
            _luba_member_lobby.pop(member_id, None)
        luba_lobbies.pop(lobby.id, None)
        return


# --- Player-to-player PVP invites (Stage 1: invite/accept/reject/cancel
# only — no real battle engine yet, see the game's own plan file) ---------
# Same in-memory, no-DB-table shape as the Luba lobby above, simplified:
# PVP is strictly 1-on-1, so there's no roster/ready/host/kick concept at
# all, just a single pending invite between exactly two accounts.
class PvpInvite:
    __slots__ = ("id", "from_user_id", "to_user_id")

    def __init__(self, invite_id: int, from_user_id: int, to_user_id: int) -> None:
        self.id = invite_id
        self.from_user_id = from_user_id
        self.to_user_id = to_user_id


pvp_invites: dict[int, PvpInvite] = {}
_next_pvp_invite_id = 1
# user_id (either side of a pending invite) -> invite_id — a user can only
# ever be part of one pending PVP invite at a time (as inviter or
# invitee), same "keyed lookup, one active thing per user" shape
# _luba_member_lobby already established. No lobby-id-style namespacing
# concern here (unlike Luba) — this state never leaves this process.
_user_pending_pvp_invite: dict[int, int] = {}


async def _clear_pvp_invite(invite: PvpInvite) -> None:
    _user_pending_pvp_invite.pop(invite.from_user_id, None)
    _user_pending_pvp_invite.pop(invite.to_user_id, None)
    pvp_invites.pop(invite.id, None)


# --- PVP Stage 2: the real server-authoritative battle -----------------
# The server is the sole source of truth for every round (see the game's
# own plan file for why — no client's JS is trusted to decide a real PVP
# outcome). compute_combatant/resolve_move/tick_effects/effective_stat
# (app/pvp_engine.py) are a faithful port of the client's own
# computeCombatant/resolveMove — the client only ever renders what this
# module tells it happened, it never re-derives a result itself.
class PvpMatch:
    __slots__ = (
        "id", "player_a_id", "player_b_id",
        "combatant_a", "combatant_b",
        "owned_a_id", "owned_b_id",
        "species_a_key", "species_b_key",
        "level_a", "level_b",
        "pending_moves", "round_number", "log",
    )

    def __init__(
        self, match_id, player_a_id, player_b_id, combatant_a, combatant_b,
        owned_a_id, owned_b_id, species_a_key, species_b_key, level_a, level_b,
    ) -> None:
        self.id = match_id
        self.player_a_id = player_a_id
        self.player_b_id = player_b_id
        self.combatant_a = combatant_a
        self.combatant_b = combatant_b
        self.owned_a_id = owned_a_id
        self.owned_b_id = owned_b_id
        self.species_a_key = species_a_key
        self.species_b_key = species_b_key
        self.level_a = level_a
        self.level_b = level_b
        self.pending_moves: dict[int, str] = {}
        self.round_number = 0
        self.log: list[str] = []

    def combatant_for(self, user_id: int) -> dict:
        return self.combatant_a if user_id == self.player_a_id else self.combatant_b

    def opponent_id(self, user_id: int) -> int:
        return self.player_b_id if user_id == self.player_a_id else self.player_a_id


pvp_matches: dict[int, PvpMatch] = {}
_next_pvp_match_id = 1
# Same "one active thing per user" shape as _user_pending_pvp_invite —
# checked before starting/accepting anything else PVP-related.
_user_active_pvp_match: dict[int, int] = {}


def _active_slot0_glophimon(db, user_id: int):
    return db.execute(
        select(GlophimonOwned)
        .where(GlophimonOwned.user_id == user_id, GlophimonOwned.active_slot.isnot(None))
        .order_by(GlophimonOwned.active_slot.asc())
        .limit(1)
    ).scalars().first()


def _pvp_ivs(row) -> dict:
    return {"speed": row.iv_speed, "attack": row.iv_attack, "defense": row.iv_defense}


def _pvp_evs(row) -> dict:
    return {"speed": row.ev_speed, "attack": row.ev_attack, "defense": row.ev_defense}


def _pvp_self_snapshot(combatant: dict, species_key: str, level: int) -> dict:
    return {
        "species_key": species_key, "level": level, "name": combatant["name"],
        "hp": combatant["hp"], "max_hp": combatant["max_hp"], "pp": dict(combatant["pp"]),
    }


async def _start_pvp_match(invite: PvpInvite) -> None:
    conn_a = connections.get(invite.from_user_id)
    conn_b = connections.get(invite.to_user_id)
    if conn_a is None or conn_b is None:
        return  # one side vanished between accept and here — nothing to start

    db = SessionLocal()
    try:
        owned_a = _active_slot0_glophimon(db, invite.from_user_id)
        owned_b = _active_slot0_glophimon(db, invite.to_user_id)
        if owned_a is None or owned_b is None:
            await send_to(invite.from_user_id, {"type": "pvp_error", "reason": "no_active_glophimon"})
            await send_to(invite.to_user_id, {"type": "pvp_error", "reason": "no_active_glophimon"})
            return

        species_a = SPECIES_BY_KEY[owned_a.species_key]
        species_b = SPECIES_BY_KEY[owned_b.species_key]
        combatant_a = compute_combatant(species_a, _pvp_ivs(owned_a), _pvp_evs(owned_a), owned_a.level)
        combatant_b = compute_combatant(species_b, _pvp_ivs(owned_b), _pvp_evs(owned_b), owned_b.level)
        if owned_a.current_hp is not None:
            combatant_a["hp"] = max(0, min(combatant_a["max_hp"], owned_a.current_hp))
        if owned_b.current_hp is not None:
            combatant_b["hp"] = max(0, min(combatant_b["max_hp"], owned_b.current_hp))

        if combatant_a["hp"] <= 0 or combatant_b["hp"] <= 0:
            # Mirrors startWildBattle's own anyUsable guard client-side — a
            # fainted active Glophimon can't be fielded, and Stage 2 has no
            # switching, so this is fatal to starting at all.
            await send_to(invite.from_user_id, {"type": "pvp_error", "reason": "active_glophimon_fainted"})
            await send_to(invite.to_user_id, {"type": "pvp_error", "reason": "active_glophimon_fainted"})
            return

        global _next_pvp_match_id
        match_id = _next_pvp_match_id
        _next_pvp_match_id += 1
        match = PvpMatch(
            match_id, invite.from_user_id, invite.to_user_id, combatant_a, combatant_b,
            owned_a.id, owned_b.id, owned_a.species_key, owned_b.species_key, owned_a.level, owned_b.level,
        )
        pvp_matches[match_id] = match
        _user_active_pvp_match[invite.from_user_id] = match_id
        _user_active_pvp_match[invite.to_user_id] = match_id

        await send_to(invite.from_user_id, {
            "type": "pvp_match_start", "match_id": match_id,
            "self": _pvp_self_snapshot(combatant_a, owned_a.species_key, owned_a.level),
            "opponent": {
                "user_id": invite.to_user_id, "display_name": conn_b.display_name,
                **_pvp_self_snapshot(combatant_b, owned_b.species_key, owned_b.level),
            },
        })
        await send_to(invite.to_user_id, {
            "type": "pvp_match_start", "match_id": match_id,
            "self": _pvp_self_snapshot(combatant_b, owned_b.species_key, owned_b.level),
            "opponent": {
                "user_id": invite.from_user_id, "display_name": conn_a.display_name,
                **_pvp_self_snapshot(combatant_a, owned_a.species_key, owned_a.level),
            },
        })
    finally:
        db.close()


async def _persist_pvp_match_hp(match: PvpMatch) -> None:
    # Same SessionLocal()/select/mutate/commit/close shape POST
    # /me/glophimon/hp already uses, just triggered from inside the WS
    # handler at match end instead of an HTTP route. No EXP/EV writes —
    # PVP awards no rewards yet, per the locked Stage 2 scope.
    db = SessionLocal()
    try:
        rows = db.execute(
            select(GlophimonOwned).where(GlophimonOwned.id.in_([match.owned_a_id, match.owned_b_id]))
        ).scalars().all()
        hp_by_owned_id = {match.owned_a_id: match.combatant_a["hp"], match.owned_b_id: match.combatant_b["hp"]}
        for row in rows:
            row.current_hp = hp_by_owned_id[row.id]
        db.commit()
    finally:
        db.close()


async def _end_pvp_match(match: PvpMatch) -> None:
    _user_active_pvp_match.pop(match.player_a_id, None)
    _user_active_pvp_match.pop(match.player_b_id, None)
    pvp_matches.pop(match.id, None)
    await _persist_pvp_match_hp(match)


async def _resolve_pvp_round(match: PvpMatch) -> None:
    match.round_number += 1
    log: list[str] = []
    a_id, b_id = match.player_a_id, match.player_b_id
    ca, cb = match.combatant_a, match.combatant_b
    choice_a, choice_b = match.pending_moves[a_id], match.pending_moves[b_id]
    match.pending_moves = {}

    tick_effects(ca)
    tick_effects(cb)

    # Flinch overrides whatever was submitted — one-shot, same
    # consume-on-declare semantics as the client's own forcedIdleNextTurn.
    if ca["forced_idle_next_turn"]:
        ca["forced_idle_next_turn"] = False
        choice_a = "idle"
        log.append(f"{ca['name']} flinched and couldn't act!")
    if cb["forced_idle_next_turn"]:
        cb["forced_idle_next_turn"] = False
        choice_b = "idle"
        log.append(f"{cb['name']} flinched and couldn't act!")

    speed_a = effective_stat(ca, "speed")
    speed_b = effective_stat(cb, "speed")
    a_first = speed_a > speed_b or (speed_a == speed_b and random.random() < 0.5)
    order = (
        [(a_id, ca, choice_a, cb), (b_id, cb, choice_b, ca)]
        if a_first
        else [(b_id, cb, choice_b, ca), (a_id, ca, choice_a, cb)]
    )

    actions = []
    for actor_id, actor, choice, opponent in order:
        if actor["fainted"] or actor["hp"] <= 0:
            continue  # already knocked out before its turn came up this round
        if choice in ("defend", "idle"):
            if choice == "defend":
                log.append(f"{actor['name']} braced to defend!")
            actions.append({"user_id": actor_id, "action": choice, "hit": None, "missed": False, "damage": 0})
            continue
        move = MOVE_BY_KEY[choice]
        opponent_choice = choice_b if actor_id == a_id else choice_a
        defends = opponent_choice == "defend"
        target_for_damage = opponent if move["kind"] in ("damage", "debuff") else None
        targets_for_heal = [actor] if move["kind"] in ("heal", "buff") else None
        result = resolve_move(
            move=move, attacker=actor, defender=target_for_damage,
            targets=targets_for_heal, defends=defends, log=log,
        )
        actions.append({
            "user_id": actor_id, "action": choice,
            "hit": result.get("hit"), "missed": result.get("missed", False),
            "damage": result.get("damage", 0),
        })
        if opponent["hp"] <= 0:
            opponent["fainted"] = True

    match.log.extend(log)

    winner_id = None
    ended = ca["hp"] <= 0 or cb["hp"] <= 0
    if ca["hp"] <= 0 and cb["hp"] <= 0:
        winner_id = None  # simultaneous KO — a real draw
    elif ca["hp"] <= 0:
        winner_id = b_id
    elif cb["hp"] <= 0:
        winner_id = a_id

    payload_base = {
        "type": "pvp_round_result", "match_id": match.id, "round": match.round_number,
        "actions": actions, "log": log, "ended": ended, "winner_user_id": winner_id,
    }
    await send_to(a_id, {**payload_base, "self_hp": ca["hp"], "opponent_hp": cb["hp"], "self_pp": dict(ca["pp"]), "opponent_pp": dict(cb["pp"])})
    await send_to(b_id, {**payload_base, "self_hp": cb["hp"], "opponent_hp": ca["hp"], "self_pp": dict(cb["pp"]), "opponent_pp": dict(ca["pp"])})

    if ended:
        await _end_pvp_match(match)


async def _pvp_forfeit_or_disconnect(match: PvpMatch, leaving_user_id: int, reason: str) -> None:
    remaining_id = match.opponent_id(leaving_user_id)
    winner_combatant = match.combatant_for(remaining_id)
    loser_combatant = match.combatant_for(leaving_user_id)
    loser_combatant["hp"] = 0
    loser_combatant["fainted"] = True
    await send_to(remaining_id, {
        "type": "pvp_match_end", "match_id": match.id, "winner_user_id": remaining_id, "reason": reason,
        "self_hp": winner_combatant["hp"], "opponent_hp": 0,
    })
    if reason == "forfeit":
        # The forfeiter's own socket is still open — give them a definitive
        # end too, mirroring the already-shipped Luba "leave mid-match" UX.
        await send_to(leaving_user_id, {
            "type": "pvp_match_end", "match_id": match.id, "winner_user_id": remaining_id, "reason": reason,
            "self_hp": 0, "opponent_hp": winner_combatant["hp"],
        })
    await _end_pvp_match(match)


async def _handle_pvp_message(user_id: int, conn: "Connection", msg: dict) -> None:
    msg_type = msg.get("type")

    if msg_type == "pvp_invite":
        if user_id in _user_pending_pvp_invite:
            await send_to(user_id, {"type": "pvp_error", "reason": "already_pending"})
            return
        target_id = msg.get("target_user_id")
        if target_id == user_id:
            await send_to(user_id, {"type": "pvp_error", "reason": "invalid_target"})
            return
        if target_id in _user_pending_pvp_invite:
            await send_to(user_id, {"type": "pvp_error", "reason": "target_busy"})
            return
        target_conn = connections.get(target_id)
        # Re-checked server-side rather than trusting the inviter's own
        # local peers-map proximity/click, which could be stale — same
        # reasoning as the Luba lobby's own luba_invite handler.
        if target_conn is None or math.hypot(target_conn.x - conn.x, target_conn.z - conn.z) > INTERACTION_RANGE:
            await send_to(user_id, {"type": "pvp_error", "reason": "target_not_nearby"})
            return
        global _next_pvp_invite_id
        invite_id = _next_pvp_invite_id
        _next_pvp_invite_id += 1
        pvp_invites[invite_id] = PvpInvite(invite_id, user_id, target_id)
        _user_pending_pvp_invite[user_id] = invite_id
        _user_pending_pvp_invite[target_id] = invite_id
        delivered = await send_to(target_id, {
            "type": "pvp_invite_received", "invite_id": invite_id,
            "from_user_id": user_id, "from_display_name": conn.display_name,
        })
        if not delivered:
            # target_conn looked alive a few lines up, but send_to re-fetches
            # connections fresh and it just failed for real (see send_to's
            # own comment) — don't leave a phantom invite around that the
            # target can now never respond to and the inviter would
            # otherwise just wait on forever with no feedback.
            del pvp_invites[invite_id]
            del _user_pending_pvp_invite[user_id]
            _user_pending_pvp_invite.pop(target_id, None)
            await send_to(user_id, {"type": "pvp_error", "reason": "target_unreachable"})
            return
        await send_to(user_id, {
            "type": "pvp_invite_sent", "invite_id": invite_id,
            "to_user_id": target_id, "to_display_name": target_conn.display_name,
        })
        return

    if msg_type == "pvp_respond":
        invite = pvp_invites.get(msg.get("invite_id"))
        if invite is None or invite.to_user_id != user_id:
            await send_to(user_id, {"type": "pvp_error", "reason": "no_pending_invite"})
            return
        await _clear_pvp_invite(invite)
        if msg.get("accept"):
            # Stage 2: this is the real hand-off now — _start_pvp_match
            # fetches both players' active Glophimon, builds server-side
            # combatants, and sends pvp_match_start to both sides. Replaces
            # Stage 1's pvp_match_ack placeholder entirely.
            await _start_pvp_match(invite)
        else:
            await send_to(invite.from_user_id, {"type": "pvp_declined", "invite_id": invite.id, "reason": "declined"})
        return

    if msg_type == "pvp_cancel":
        invite = pvp_invites.get(msg.get("invite_id"))
        if invite is None or invite.from_user_id != user_id:
            await send_to(user_id, {"type": "pvp_error", "reason": "no_pending_invite"})
            return
        await _clear_pvp_invite(invite)
        await send_to(invite.to_user_id, {"type": "pvp_declined", "invite_id": invite.id, "reason": "cancelled"})
        return

    if msg_type == "pvp_move_choice":
        match = pvp_matches.get(msg.get("match_id"))
        if match is None or user_id not in (match.player_a_id, match.player_b_id):
            await send_to(user_id, {"type": "pvp_error", "reason": "no_active_match"})
            return
        if user_id in match.pending_moves:
            return  # already submitted this round — extra clicks are silently ignored
        move_key = msg.get("move_key")
        combatant = match.combatant_for(user_id)
        if move_key != "defend" and move_key not in combatant["pp"]:
            await send_to(user_id, {"type": "pvp_error", "reason": "invalid_move"})
            return
        if move_key != "defend" and combatant["pp"][move_key] <= 0:
            await send_to(user_id, {"type": "pvp_error", "reason": "no_pp"})
            return
        match.pending_moves[user_id] = move_key
        # Tells the other client "they've locked in" without revealing what
        # — the reveal only happens once both are in (see _resolve_pvp_round).
        await send_to(match.opponent_id(user_id), {"type": "pvp_opponent_ready", "match_id": match.id})
        if len(match.pending_moves) == 2:
            await _resolve_pvp_round(match)
        return

    if msg_type == "pvp_forfeit":
        match = pvp_matches.get(msg.get("match_id"))
        if match is None or user_id not in (match.player_a_id, match.player_b_id):
            return
        await _pvp_forfeit_or_disconnect(match, user_id, "forfeit")
        return


# --- Chessdom: two physical chessboards, fully self-contained real chess ---
# Server-authoritative via the real python-chess library — the same one the
# main Cheddar API's own standalone Chess game uses, just a separate,
# independent instance/state owned entirely by Glophimon (see the game's
# own plan file for why this doesn't call into the real Chess backend: no
# lightweight match-creation API there, a hard 2-player cap, and no
# spectating support at all — every one of which this needs). No DB
# persistence — pure in-memory session state, same trust level as Luba
# lobbies and PVP matches.
def _chess_outcome_reason(termination: "chess.Termination") -> str:
    if termination == chess.Termination.CHECKMATE:
        return "checkmate"
    if termination == chess.Termination.STALEMATE:
        return "stalemate"
    return "draw"  # insufficient material / repetition / fifty-move, etc. — one bucket is enough for display


# How long a finished game's board keeps showing its final position (so
# players/spectators actually get to see the result) before the table
# clears itself for a new game — see _reset_chess_board_after_delay and
# (now shared with Dama, which hosts on the same two tables — see
# DamaBoardState's own comment) _reset_dama_board_after_delay. With no
# reset at all, a finished board would stay stuck forever with no way to
# host a new game on it.
BOARD_RESET_DELAY_S = 15.0

# How long a player has to return to Tambayan after wandering off mid-game
# before they're auto-resigned — see _check_chess_away/_chess_away_timeout.
CHESS_LEAVE_GRACE_S = 30.0

# The third table — a standing AI match, always available, no opponent to
# wait for (see chess_ai_start/dama_ai_start below). Game-agnostic id (not
# AI_CHESS_BOARD_ID any more) since Phase 3 made this table dual-purpose —
# the host now picks Chess (Stockfish) or Dama (this project's own
# minimax/alpha-beta search, see dama_ai.py) fresh each time, same as boards
# 1/2 already let the host pick Chess or Dama. One fixed skill level for
# Stockfish rather than exposing a picker — not asked for; matches the main
# Cheddar Chess game's own default "vs AI" skill. Dama's own AI has no
# equivalent skill level (see dama_ai.py's fixed think-time budget instead).
AI_BOARD_ID = 3
STOCKFISH_NAME = "Stockfish"
DAMA_AI_NAME = "Dama AI"
AI_SKILL_LEVEL = 10


class ChessBoardState:
    __slots__ = (
        "id", "status", "host_id", "host_display_name",
        "white_user_id", "white_display_name",
        "black_user_id", "black_display_name",
        "board", "move_history", "outcome",
        "draw_offered_by", "undo_requested_by",
    )

    def __init__(self, board_id: int) -> None:
        self.id = board_id
        self.reset()

    def reset(self) -> None:
        self.status = "empty"  # "empty" | "waiting" | "in_progress"
        self.host_id: int | None = None
        self.host_display_name: str | None = None
        self.white_user_id: int | None = None
        self.white_display_name: str | None = None
        self.black_user_id: int | None = None
        self.black_display_name: str | None = None
        self.board: chess.Board | None = None
        self.move_history: list[str] = []
        self.outcome: dict | None = None  # {"winner_user_id": int|None, "reason": str}
        # A draw offer or undo request from one player, awaiting the other's
        # response (see chess_draw_offer/chess_undo_request below) — at most
        # one of these two is ever non-None at a time (each request handler
        # itself refuses to start a second kind while one's already pending),
        # so the client never has to reconcile overlapping prompts.
        self.draw_offered_by: int | None = None
        self.undo_requested_by: int | None = None


# Always exactly 3, fixed ids — no dynamic creation, matching the three
# physical tables built client-side (see CHESS_BOARD_1_X/Z etc., game.js).
# Board 3 is the standing AI table (see AI_BOARD_ID).
chess_boards: dict[int, ChessBoardState] = {1: ChessBoardState(1), 2: ChessBoardState(2), 3: ChessBoardState(3)}


# Dama (Phase 2 — see this game's own plan file) shares physical tables 1
# and 2 with Chess rather than getting its own separate board: the host
# picks Chess or Dama fresh each time they host an empty one (see
# dama_host_request / chess_host_request's own board-free check below).
# Deliberately its OWN parallel state/message set, not a generalization of
# ChessBoardState — same "give it its own thing" reasoning as Chessdom's
# original build, the Stockfish board, and Tambayan's own pentagon geometry
# all already followed this session, rather than risk the working Chess
# boards by bending their code to cover a second, differently-shaped game.
#
# board is a plain 8x8 list of rows, each cell either None or
# {"side": "white"|"black", "king": bool} — exactly the shape the client's
# own dama.js already produces/consumes. Move *legality* is validated
# entirely client-side (dama.js, already covered by its own Phase 1 tests);
# this server is authoritative only over turn order, who's allowed to move,
# and the resulting board state each move actually produces — the same
# trust level this project's other client-authoritative systems (movement,
# GL Sims World, Luba) already use, and a deliberate scope choice for this
# phase given there's no Python equivalent of python-chess to lean on here.
class DamaBoardState:
    __slots__ = (
        "id", "status", "host_id", "host_display_name",
        "white_user_id", "white_display_name",
        "black_user_id", "black_display_name",
        "board", "side_to_move", "move_history", "outcome",
        "draw_offered_by", "undo_requested_by", "undo_accept_pending_for", "last_move",
    )

    def __init__(self, board_id: int) -> None:
        self.id = board_id
        self.reset()

    def reset(self) -> None:
        self.status = "empty"  # "empty" | "waiting" | "in_progress"
        self.host_id: int | None = None
        self.host_display_name: str | None = None
        self.white_user_id: int | None = None
        self.white_display_name: str | None = None
        self.black_user_id: int | None = None
        self.black_display_name: str | None = None
        self.board: list[list[dict | None]] | None = None
        self.side_to_move = "white"
        self.move_history: list[str] = []
        self.outcome: dict | None = None  # {"winner_user_id": int|None, "reason": str}
        # Same "at most one pending at a time" shape as ChessBoardState's own
        # pair — see that class's own comment.
        self.draw_offered_by: int | None = None
        self.undo_requested_by: int | None = None
        # Dama stays client-authoritative even for undo (see this class's
        # own comment on why Dama trusts the acting client's board rather
        # than re-deriving moves itself): once the *other* player accepts an
        # undo request, this holds the *requester's* own user_id so their
        # client — the only one that still has the pre-move board in memory
        # (see game.js's own activeDamaMatch.lastTurnSnapshot) — knows to
        # send it back via dama_undo_commit, and so the server can verify
        # that's really who's sending it.
        self.undo_accept_pending_for: int | None = None
        # {"from": [row, col], "to": [row, col]} | None — the last full
        # turn's own start/end squares, for the client's own highlight (see
        # dama_move's own last_move — set fresh by the ACTING client itself
        # since the server never derives Dama moves on its own).
        self.last_move: dict | None = None


# Same physical ids as chess_boards — see the class comment above for why
# this shares tables with Chess instead of getting its own. Board 3 (the
# standing AI table, see AI_BOARD_ID) is included here too as of Phase 3 —
# it's dual-purpose now, so it needs to be trackable as a Dama board exactly
# like 1/2 already are, alongside its existing chess_boards[3] entry.
dama_boards: dict[int, DamaBoardState] = {1: DamaBoardState(1), 2: DamaBoardState(2), 3: DamaBoardState(3)}


def _create_initial_dama_board() -> list[list[dict | None]]:
    board: list[list[dict | None]] = [[None] * 8 for _ in range(8)]
    for row in range(8):
        for col in range(8):
            if (row + col) % 2 != 1:
                continue  # dark squares only
            if row <= 2:
                board[row][col] = {"side": "black", "king": False}
            elif row >= 5:
                board[row][col] = {"side": "white", "king": False}
    return board


# The two host-able tables (1 and 2) are shared between Chess and Dama —
# "free" means neither game currently has anything going on it, checked
# here rather than each one only checking its own dict, or hosting Chess on
# a table already mid-Dama-game (or vice versa) would silently clobber it.
def _physical_board_free(board_id: int) -> bool:
    chess_board = chess_boards.get(board_id)
    dama_board = dama_boards.get(board_id)
    return (chess_board is None or chess_board.status == "empty") and (dama_board is None or dama_board.status == "empty")


# A board that's already decided (status still "in_progress", but outcome
# is set) just sits there for BOARD_RESET_DELAY_S waiting on its own
# delayed reset (see _reset_chess_board_after_delay/_reset_dama_board_
# after_delay) — _physical_board_free alone treats that as "not free" for
# that whole window, which is exactly what made the client's own "New
# Game" button need to wait out that delay before it could do anything.
# Lets either participant of THAT SAME just-finished game immediately
# host/start a fresh one on it instead, without waiting — board.reset()
# at each call site (not here) is what actually clears the stale result
# before the new game's own fields get set.
def _board_finished_for_user(board, user_id: int) -> bool:
    return board.status == "in_progress" and board.outcome is not None and user_id in (board.white_user_id, board.black_user_id)


def _dama_state_payload(board: DamaBoardState) -> dict:
    return {
        "type": "dama_state",
        "board_id": board.id,
        "status": board.status,
        "host_id": board.host_id,
        "host_display_name": board.host_display_name,
        "white_user_id": board.white_user_id,
        "white_display_name": board.white_display_name,
        "black_user_id": board.black_user_id,
        "black_display_name": board.black_display_name,
        "board": board.board if board.board is not None else _create_initial_dama_board(),
        "turn": board.side_to_move,
        "move_history": board.move_history,
        "outcome": board.outcome,
        "draw_offered_by": board.draw_offered_by,
        "undo_requested_by": board.undo_requested_by,
        "undo_accept_pending_for": board.undo_accept_pending_for,
        "last_move": board.last_move,
    }


async def _broadcast_dama_state(board: DamaBoardState) -> None:
    # Broadcast to everyone, not just the two players — same reasoning as
    # _broadcast_chess_state (nearby spectators' own click/highlight state
    # needs to stay correct without the server tracking who's watching).
    await broadcast(_dama_state_payload(board))


async def _reset_dama_board_after_delay(board: DamaBoardState) -> None:
    await asyncio.sleep(BOARD_RESET_DELAY_S)
    if board.outcome is None:
        return  # somehow already reset/reused — don't clobber whatever's there now
    board.reset()
    await _broadcast_dama_state(board)


# The Dama AI's own "turn" on the AI board — mirrors _play_ai_move above,
# but runs entirely in-process (dama_ai.compute_ai_move is pure Python, no
# subprocess) rather than against a fixed skill level; still routed through
# run_in_threadpool since it's a blocking CPU-bound search (see dama_ai.py's
# own think-time budget). Called right after dama_ai_start whenever the
# human drew black, and again after every one of the human's own moves in
# dama_move below — in both cases it's already necessarily the AI's turn by
# construction, no turn check needed here. hops is a whole turn (>1 entries
# for a forced multi-jump chain, see dama_ai.get_full_moves), applied here in
# one shot rather than one broadcast per hop — the human never gets to react
# mid-chain to an AI move the way two humans do to each other's, and there's
# no reason to give it that treatment.
async def _play_dama_ai_move(board: DamaBoardState) -> None:
    if board.board is None or board.outcome is not None:
        return  # game ended (e.g. the human's own last move was a win) before this ran
    ai_side = board.side_to_move
    hops = await run_in_threadpool(compute_dama_ai_move, board.board, ai_side)
    # Re-check after the (up to ~1s) search, not just before it: dama_resign
    # has no turn check at all, so the human resigning WHILE this was
    # computing in the background is entirely legal and already ended the
    # game by the time control gets back here — applying a move computed
    # against the board as it was before that would silently move a piece
    # on top of an already-decided game and schedule a second, redundant
    # reset.
    if board.board is None or board.outcome is not None:
        return
    result_board = board.board
    for hop in hops:
        result_board, _ = apply_dama_move(result_board, hop)
    board.board = result_board
    # Same "whole turn, not just the last hop" shape the human side's own
    # dama_move sends (see that handler's own last_move field) — spans the
    # piece's starting square through wherever the full chain ended, so a
    # multi-jump AI capture highlights start-to-finish rather than just its
    # final hop. Without this, board.last_move silently stayed whatever the
    # HUMAN's own last move was — the highlight never moved to reflect the
    # AI's own move at all, which read as "did the AI even move?" (see this
    # bug's own report) even though board.board itself was already correct.
    if hops:
        board.last_move = {"from": hops[0]["from"], "to": hops[-1]["to"], "by": ai_side}
    board.move_history.append(f"{ai_side[0].upper()}{len(hops)}" if len(hops) > 1 else ai_side[0].upper())
    other_side = "black" if ai_side == "white" else "white"
    board.side_to_move = other_side
    if has_no_legal_moves(board.board, other_side):
        winner_id = board.white_user_id if ai_side == "white" else board.black_user_id
        board.outcome = {"winner_user_id": winner_id, "reason": "no_moves"}
    await _broadcast_dama_state(board)
    if board.outcome is not None:
        asyncio.create_task(_reset_dama_board_after_delay(board))


def _find_dama_board_for_user(user_id: int) -> DamaBoardState | None:
    for board in dama_boards.values():
        if board.status == "waiting" and board.host_id == user_id:
            return board
        if board.status == "in_progress" and board.outcome is None and user_id in (board.white_user_id, board.black_user_id):
            return board
    return None


def _chess_state_payload(board: ChessBoardState) -> dict:
    return {
        "type": "chess_state",
        "board_id": board.id,
        "status": board.status,
        "host_id": board.host_id,
        "host_display_name": board.host_display_name,
        "white_user_id": board.white_user_id,
        "white_display_name": board.white_display_name,
        "black_user_id": board.black_user_id,
        "black_display_name": board.black_display_name,
        "fen": board.board.fen() if board.board is not None else chess.Board().fen(),
        "turn": ("white" if board.board.turn else "black") if board.board is not None else "white",
        "move_history": board.move_history,
        "outcome": board.outcome,
        "draw_offered_by": board.draw_offered_by,
        "undo_requested_by": board.undo_requested_by,
        "last_move": _chess_last_move(board),
    }


# python-chess's own move_stack already IS the undo history — chess_undo_*
# below pops it directly rather than this project keeping a parallel
# snapshot the way Dama has to (see DamaBoardState's own comment on why
# Dama can't do that). {"from": "e2", "to": "e4"} in algebraic notation,
# matching what the client's own square strings already look like
# (onChessSquareClick's own `square` values) — not a promotion suffix,
# purely for a highlight so extra detail isn't needed.
def _chess_last_move(board: ChessBoardState) -> dict | None:
    if board.board is None or not board.board.move_stack:
        return None
    mv = board.board.move_stack[-1]
    return {"from": chess.square_name(mv.from_square), "to": chess.square_name(mv.to_square)}


async def _broadcast_chess_state(board: ChessBoardState) -> None:
    # Broadcast to *everyone*, not just the two players — this is exactly
    # what lets any nearby player's own highlight/click state stay correct
    # without the server ever having to track who's currently spectating
    # (see this game's own plan file). Cheap: moves are infrequent and the
    # payload is tiny, same reasoning wild_tick already broadcasts globally
    # at a much higher frequency.
    await broadcast(_chess_state_payload(board))


async def _reset_chess_board_after_delay(board: ChessBoardState) -> None:
    await asyncio.sleep(BOARD_RESET_DELAY_S)
    if board.outcome is None:
        return  # somehow already reset/reused — don't clobber whatever's there now
    board.reset()
    await _broadcast_chess_state(board)


# Stockfish's own "turn" on the AI board — run_in_threadpool because
# compute_ai_move blocks the whole event loop otherwise (it spawns and waits
# on a Stockfish subprocess). Called right after chess_ai_start whenever the
# human drew black, and again after every one of the human's own moves in
# chess_move below — in both cases it's already necessarily Stockfish's turn
# by construction, no turn check needed here.
async def _play_ai_move(board: ChessBoardState) -> None:
    if board.board is None or board.outcome is not None:
        return  # game ended (e.g. the human's own last move was checkmate) before this ran
    move = await run_in_threadpool(compute_ai_move, board.board, AI_SKILL_LEVEL)
    san = board.board.san(move)
    board.board.push(move)
    board.move_history.append(san)
    result = board.board.outcome(claim_draw=True)
    if result is not None:
        winner_id = None
        if result.winner is not None:
            winner_id = board.white_user_id if result.winner else board.black_user_id
        board.outcome = {"winner_user_id": winner_id, "reason": _chess_outcome_reason(result.termination)}
    await _broadcast_chess_state(board)
    if board.outcome is not None:
        asyncio.create_task(_reset_chess_board_after_delay(board))


def _find_chess_board_for_user(user_id: int) -> ChessBoardState | None:
    # Only 2 boards ever exist — a plain scan is simplest, no keyed lookup
    # dict needed at this scale (unlike _luba_member_lobby/
    # _user_active_pvp_match, where the population can be much larger).
    for board in chess_boards.values():
        if board.status == "waiting" and board.host_id == user_id:
            return board
        # outcome is None guards against a already-finished game (waiting on
        # its own delayed reset, see _reset_chess_board_after_delay) being
        # treated as still "active" — without this, disconnecting any time
        # after a real result (checkmate/resign/etc.) but before the board
        # actually resets would overwrite that real outcome with a bogus
        # "disconnect" forfeit, and re-schedule a second reset timer.
        if board.status == "in_progress" and board.outcome is None and user_id in (board.white_user_id, board.black_user_id):
            return board
    return None


# user_id -> the asyncio.Task counting down their grace period after
# wandering outside Tambayan mid-game (see _check_chess_away). Only ever
# holds an entry while a timer is actually running — cancelled/popped the
# moment the player returns, the game ends some other way, or they
# disconnect (see _chess_disconnect_cleanup).
_chess_away_timers: dict[int, asyncio.Task] = {}


async def _chess_away_timeout(user_id: int, board_id: int) -> None:
    try:
        await asyncio.sleep(CHESS_LEAVE_GRACE_S)
    except asyncio.CancelledError:
        return
    _chess_away_timers.pop(user_id, None)
    board = chess_boards.get(board_id)
    if board is None or board.status != "in_progress" or board.outcome is not None:
        return  # game already ended some other way in the meantime
    if user_id not in (board.white_user_id, board.black_user_id):
        return
    winner_id = board.black_user_id if user_id == board.white_user_id else board.white_user_id
    board.outcome = {"winner_user_id": winner_id, "reason": "auto_resign_away"}
    await _broadcast_chess_state(board)
    asyncio.create_task(_reset_chess_board_after_delay(board))


async def _check_chess_away(user_id: int, conn: "Connection") -> None:
    # Cheap by construction: _find_chess_board_for_user is an O(2) scan (only
    # 2 boards ever exist) and this only runs off the already-frequent
    # "position" message, no separate polling loop needed.
    board = _find_chess_board_for_user(user_id)
    is_active_player = board is not None and board.status == "in_progress" and board.outcome is None
    existing_task = _chess_away_timers.get(user_id)
    if is_active_player and not _is_inside_tambayan(conn.x, conn.z):
        if existing_task is None:
            _chess_away_timers[user_id] = asyncio.create_task(_chess_away_timeout(user_id, board.id))
            await send_to(user_id, {"type": "chess_leave_warning", "board_id": board.id, "seconds": int(CHESS_LEAVE_GRACE_S)})
    elif existing_task is not None:
        existing_task.cancel()
        del _chess_away_timers[user_id]
        await send_to(user_id, {"type": "chess_leave_cancelled"})


async def _handle_chess_message(user_id: int, conn: "Connection", msg: dict) -> None:
    msg_type = msg.get("type")
    board = chess_boards.get(msg.get("board_id"))
    if board is None:
        await send_to(user_id, {"type": "chess_error", "reason": "invalid_board"})
        return

    if msg_type == "chess_host_request":
        # _physical_board_free, not board.status alone — boards 1/2 are
        # shared with Dama now (see DamaBoardState's own comment), so a
        # Dama game already running on this same table must block a fresh
        # Chess host here too, not just another Chess one. The "New Game"
        # button (see this game's own plan file) sends this exact same
        # message once a match ends, so a just-finished game this user was
        # a participant in is ALSO accepted here (see
        # _board_finished_for_user) rather than making them wait out
        # BOARD_RESET_DELAY_S first.
        was_finished = _board_finished_for_user(board, user_id)
        if not _physical_board_free(board.id) and not was_finished:
            await send_to(user_id, {"type": "chess_error", "reason": "board_not_empty"})
            return
        if not _is_inside_tambayan(conn.x, conn.z):
            await send_to(user_id, {"type": "chess_error", "reason": "not_in_tambayan"})
            return
        if not was_finished and _find_chess_board_for_user(user_id) is not None:
            await send_to(user_id, {"type": "chess_error", "reason": "already_playing"})
            return
        if was_finished:
            board.reset()
        board.status = "waiting"
        board.host_id = user_id
        board.host_display_name = conn.display_name
        await _broadcast_chess_state(board)
        return

    if msg_type == "chess_ai_start":
        if board.id != AI_BOARD_ID:
            await send_to(user_id, {"type": "chess_error", "reason": "not_ai_board"})
            return
        was_finished = _board_finished_for_user(board, user_id)
        if not _physical_board_free(board.id) and not was_finished:
            await send_to(user_id, {"type": "chess_error", "reason": "board_not_empty"})
            return
        if not _is_inside_tambayan(conn.x, conn.z):
            await send_to(user_id, {"type": "chess_error", "reason": "not_in_tambayan"})
            return
        if not was_finished and _find_chess_board_for_user(user_id) is not None:
            await send_to(user_id, {"type": "chess_error", "reason": "already_playing"})
            return
        if was_finished:
            board.reset()
        board.board = chess.Board()
        board.host_id = user_id
        board.host_display_name = conn.display_name
        # Random white/black against Stockfish, per the user's own spec —
        # same coin flip chess_join_request uses between two humans. The
        # AI's own seat keeps a null user_id (never equals a real user_id
        # anywhere else this is compared, e.g. _find_chess_board_for_user).
        if random.random() < 0.5:
            board.white_user_id, board.white_display_name = user_id, conn.display_name
            board.black_user_id, board.black_display_name = None, STOCKFISH_NAME
        else:
            board.white_user_id, board.white_display_name = None, STOCKFISH_NAME
            board.black_user_id, board.black_display_name = user_id, conn.display_name
        board.status = "in_progress"
        await _broadcast_chess_state(board)
        if board.white_user_id is None:
            asyncio.create_task(_play_ai_move(board))  # Stockfish drew white — it moves first
        return

    if msg_type == "chess_cancel_host":
        if board.status != "waiting" or board.host_id != user_id:
            await send_to(user_id, {"type": "chess_error", "reason": "not_your_board"})
            return
        board.reset()
        await _broadcast_chess_state(board)
        return

    if msg_type == "chess_join_request":
        if board.status != "waiting":
            await send_to(user_id, {"type": "chess_error", "reason": "board_not_waiting"})
            return
        if board.host_id == user_id:
            await send_to(user_id, {"type": "chess_error", "reason": "cannot_join_own_board"})
            return
        if _find_chess_board_for_user(user_id) is not None:
            await send_to(user_id, {"type": "chess_error", "reason": "already_playing"})
            return
        board.board = chess.Board()
        # Random white/black between host and joiner, per the user's own
        # spec — cached display names (not a live connections lookup) so a
        # later disconnect mid-game can still report who was who.
        if random.random() < 0.5:
            board.white_user_id, board.white_display_name = board.host_id, board.host_display_name
            board.black_user_id, board.black_display_name = user_id, conn.display_name
        else:
            board.white_user_id, board.white_display_name = user_id, conn.display_name
            board.black_user_id, board.black_display_name = board.host_id, board.host_display_name
        board.status = "in_progress"
        await _broadcast_chess_state(board)
        return

    if msg_type == "chess_move":
        if board.status != "in_progress" or board.outcome is not None:
            await send_to(user_id, {"type": "chess_error", "reason": "no_active_game"})
            return
        is_white = board.white_user_id == user_id
        if not is_white and board.black_user_id != user_id:
            await send_to(user_id, {"type": "chess_error", "reason": "not_a_player"})
            return
        if board.board.turn != is_white:
            await send_to(user_id, {"type": "chess_error", "reason": "not_your_turn"})
            return
        try:
            move = board.board.parse_uci(str(msg.get("move", "")))
        except ValueError:
            await send_to(user_id, {"type": "chess_error", "reason": "illegal_move"})
            return
        san = board.board.san(move)
        board.board.push(move)
        board.move_history.append(san)
        # A fresh move retires any earlier draw offer/undo request outright
        # — it's already too late to accept either against the position
        # they were made against (this matches ordinary chess client
        # behavior: making a move implicitly withdraws your own pending
        # offer too, not just the opponent's).
        board.draw_offered_by = None
        board.undo_requested_by = None
        result = board.board.outcome(claim_draw=True)
        if result is not None:
            winner_id = None
            if result.winner is not None:
                winner_id = board.white_user_id if result.winner else board.black_user_id
            board.outcome = {"winner_user_id": winner_id, "reason": _chess_outcome_reason(result.termination)}
        await _broadcast_chess_state(board)
        if board.outcome is not None:
            asyncio.create_task(_reset_chess_board_after_delay(board))
        elif board.id == AI_BOARD_ID:
            # The human can only ever move on their own turn (checked
            # above), so the game not being over here means it's now
            # necessarily Stockfish's turn.
            asyncio.create_task(_play_ai_move(board))
        return

    if msg_type == "chess_resign":
        if board.status != "in_progress" or board.outcome is not None:
            return
        if user_id not in (board.white_user_id, board.black_user_id):
            return
        winner_id = board.black_user_id if user_id == board.white_user_id else board.white_user_id
        board.outcome = {"winner_user_id": winner_id, "reason": "resignation"}
        await _broadcast_chess_state(board)
        asyncio.create_task(_reset_chess_board_after_delay(board))
        return

    # Draw offer / undo request — human-vs-human boards only (never offered
    # in the client's own UI for the AI table, but guarded here too rather
    # than trusting that): at most one of the two ever pending at a time,
    # enforced by each handler refusing to start one while the other (or
    # its own kind) is already outstanding.
    if msg_type == "chess_draw_offer":
        if board.id == AI_BOARD_ID or board.status != "in_progress" or board.outcome is not None:
            return
        if user_id not in (board.white_user_id, board.black_user_id):
            return
        if board.draw_offered_by is not None or board.undo_requested_by is not None:
            return
        board.draw_offered_by = user_id
        await _broadcast_chess_state(board)
        return

    if msg_type == "chess_draw_respond":
        # outcome check matters here specifically: the offer could have gone
        # stale if the OTHER player resigned (or disconnected, or ran out
        # the away-timer) instead of ever responding to it — none of those
        # paths clear draw_offered_by themselves, so without this a late
        # "accept" could silently overwrite an already-decided resignation
        # with a draw.
        if board.draw_offered_by is None or board.draw_offered_by == user_id or board.outcome is not None:
            return  # only the OTHER player answers their own offer
        if user_id not in (board.white_user_id, board.black_user_id):
            return
        if msg.get("accept"):
            board.outcome = {"winner_user_id": None, "reason": "draw_agreed"}
            board.draw_offered_by = None
            await _broadcast_chess_state(board)
            asyncio.create_task(_reset_chess_board_after_delay(board))
        else:
            board.draw_offered_by = None
            await _broadcast_chess_state(board)
        return

    if msg_type == "chess_undo_request":
        if board.id == AI_BOARD_ID or board.status != "in_progress" or board.outcome is not None:
            return
        if board.board is None or not board.board.move_stack:
            return  # nothing to undo yet
        is_white = board.white_user_id == user_id
        if not is_white and board.black_user_id != user_id:
            return
        # Only the player who just moved may ask for it back — board.turn
        # being the OTHER color is exactly what "I just moved" means here.
        if board.board.turn == is_white:
            return
        if board.draw_offered_by is not None or board.undo_requested_by is not None:
            return
        board.undo_requested_by = user_id
        await _broadcast_chess_state(board)
        return

    if msg_type == "chess_undo_respond":
        # Same stale-request guard as chess_draw_respond above.
        if board.undo_requested_by is None or board.undo_requested_by == user_id or board.outcome is not None:
            return
        if user_id not in (board.white_user_id, board.black_user_id):
            return
        if msg.get("accept"):
            if board.board is not None and board.board.move_stack:
                board.board.pop()
                if board.move_history:
                    board.move_history.pop()
            board.undo_requested_by = None
            await _broadcast_chess_state(board)
        else:
            board.undo_requested_by = None
            await _broadcast_chess_state(board)
        return


async def _chess_disconnect_cleanup(user_id: int) -> None:
    # A real disconnect always wins over a pending away-timer for the same
    # user — otherwise the timer could still fire later and try to
    # re-resign a game this same disconnect is about to resolve anyway.
    away_task = _chess_away_timers.pop(user_id, None)
    if away_task is not None:
        away_task.cancel()
    board = _find_chess_board_for_user(user_id)
    if board is None:
        return
    if board.status == "waiting":
        board.reset()
        await _broadcast_chess_state(board)
        return
    # in_progress — the other player wins by forfeit, same shape as PVP's
    # own _pvp_forfeit_or_disconnect.
    winner_id = board.black_user_id if user_id == board.white_user_id else board.white_user_id
    board.outcome = {"winner_user_id": winner_id, "reason": "disconnect"}
    await _broadcast_chess_state(board)
    asyncio.create_task(_reset_chess_board_after_delay(board))


# Dama — mirrors _handle_chess_message's own request shape (host/cancel/
# join/move/resign) closely, but dama_move trusts the *client's* own
# already-tested dama.js rules engine for legality (see DamaBoardState's
# own comment on why): the acting client sends the resulting board state
# and whether its own turn continues (a mid-chain capture) or passes, and
# this just stores + broadcasts it, the same trust level this project's
# other client-authoritative systems already use elsewhere.
async def _handle_dama_message(user_id: int, conn: "Connection", msg: dict) -> None:
    msg_type = msg.get("type")
    board = dama_boards.get(msg.get("board_id"))
    if board is None:
        await send_to(user_id, {"type": "dama_error", "reason": "invalid_board"})
        return

    if msg_type == "dama_host_request":
        was_finished = _board_finished_for_user(board, user_id)
        if not _physical_board_free(board.id) and not was_finished:
            await send_to(user_id, {"type": "dama_error", "reason": "board_not_empty"})
            return
        if not _is_inside_tambayan(conn.x, conn.z):
            await send_to(user_id, {"type": "dama_error", "reason": "not_in_tambayan"})
            return
        if not was_finished and (_find_dama_board_for_user(user_id) is not None or _find_chess_board_for_user(user_id) is not None):
            await send_to(user_id, {"type": "dama_error", "reason": "already_playing"})
            return
        if was_finished:
            board.reset()
        board.status = "waiting"
        board.host_id = user_id
        board.host_display_name = conn.display_name
        await _broadcast_dama_state(board)
        return

    if msg_type == "dama_ai_start":
        if board.id != AI_BOARD_ID:
            await send_to(user_id, {"type": "dama_error", "reason": "not_ai_board"})
            return
        was_finished = _board_finished_for_user(board, user_id)
        if not _physical_board_free(board.id) and not was_finished:
            await send_to(user_id, {"type": "dama_error", "reason": "board_not_empty"})
            return
        if not _is_inside_tambayan(conn.x, conn.z):
            await send_to(user_id, {"type": "dama_error", "reason": "not_in_tambayan"})
            return
        if not was_finished and (_find_dama_board_for_user(user_id) is not None or _find_chess_board_for_user(user_id) is not None):
            await send_to(user_id, {"type": "dama_error", "reason": "already_playing"})
            return
        if was_finished:
            board.reset()
        board.board = _create_initial_dama_board()
        board.side_to_move = "white"
        board.host_id = user_id
        board.host_display_name = conn.display_name
        # Random white/black against the AI, same coin flip chess_ai_start
        # uses against Stockfish. The AI's own seat keeps a null user_id
        # (never equals a real user_id anywhere else this is compared, e.g.
        # _find_dama_board_for_user).
        if random.random() < 0.5:
            board.white_user_id, board.white_display_name = user_id, conn.display_name
            board.black_user_id, board.black_display_name = None, DAMA_AI_NAME
        else:
            board.white_user_id, board.white_display_name = None, DAMA_AI_NAME
            board.black_user_id, board.black_display_name = user_id, conn.display_name
        board.status = "in_progress"
        await _broadcast_dama_state(board)
        if board.white_user_id is None:
            asyncio.create_task(_play_dama_ai_move(board))  # AI drew white — it moves first
        return

    if msg_type == "dama_cancel_host":
        if board.status != "waiting" or board.host_id != user_id:
            await send_to(user_id, {"type": "dama_error", "reason": "not_your_board"})
            return
        board.reset()
        await _broadcast_dama_state(board)
        return

    if msg_type == "dama_join_request":
        if board.status != "waiting":
            await send_to(user_id, {"type": "dama_error", "reason": "board_not_waiting"})
            return
        if board.host_id == user_id:
            await send_to(user_id, {"type": "dama_error", "reason": "cannot_join_own_board"})
            return
        if _find_dama_board_for_user(user_id) is not None or _find_chess_board_for_user(user_id) is not None:
            await send_to(user_id, {"type": "dama_error", "reason": "already_playing"})
            return
        board.board = _create_initial_dama_board()
        board.side_to_move = "white"
        if random.random() < 0.5:
            board.white_user_id, board.white_display_name = board.host_id, board.host_display_name
            board.black_user_id, board.black_display_name = user_id, conn.display_name
        else:
            board.white_user_id, board.white_display_name = user_id, conn.display_name
            board.black_user_id, board.black_display_name = board.host_id, board.host_display_name
        board.status = "in_progress"
        await _broadcast_dama_state(board)
        return

    if msg_type == "dama_move":
        if board.status != "in_progress" or board.outcome is not None:
            await send_to(user_id, {"type": "dama_error", "reason": "no_active_game"})
            return
        is_white = board.white_user_id == user_id
        if not is_white and board.black_user_id != user_id:
            await send_to(user_id, {"type": "dama_error", "reason": "not_a_player"})
            return
        if board.side_to_move != ("white" if is_white else "black"):
            await send_to(user_id, {"type": "dama_error", "reason": "not_your_turn"})
            return
        new_board = msg.get("board")
        if not isinstance(new_board, list) or len(new_board) != 8 or any(not isinstance(r, list) or len(r) != 8 for r in new_board):
            await send_to(user_id, {"type": "dama_error", "reason": "malformed_board"})
            return
        board.board = new_board
        move_text = msg.get("move_text")
        if isinstance(move_text, str) and move_text:
            board.move_history.append(move_text[:16])
        last_move = msg.get("last_move")
        if (
            isinstance(last_move, dict)
            and isinstance(last_move.get("from"), list) and len(last_move["from"]) == 2
            and isinstance(last_move.get("to"), list) and len(last_move["to"]) == 2
        ):
            # "by" is server-assigned, never trusted from the client — this
            # acting connection's own already-verified side (is_white,
            # checked above), not whatever the message claims. Lets the
            # client highlight "your last move" vs "the opponent's/AI's
            # last move" distinctly without having to infer it from
            # board.turn, which alone can't tell a continued multi-jump
            # hop (same side moves again, turn never flips) apart from an
            # actual turn change.
            board.last_move = {"from": last_move["from"], "to": last_move["to"], "by": "white" if is_white else "black"}
        # A fresh move retires any earlier draw offer/undo request outright
        # — same reasoning as chess_move's own identical guard. Also clears
        # a pending undo_accept_pending_for: if the OTHER player accepted an
        # undo and then immediately moved again before the requester's own
        # dama_undo_commit round trip completed, that now-stale commit must
        # not be allowed to silently roll back this newer move too.
        board.draw_offered_by = None
        board.undo_requested_by = None
        board.undo_accept_pending_for = None
        # continued: true means the same side just took one hop of a
        # multi-jump capture and must keep moving the same piece — the
        # client's own dama.js already enforces this locally before it
        # ever lets the player send a second dama_move; the turn only
        # actually passes once continued is false.
        if not msg.get("continued"):
            board.side_to_move = "black" if is_white else "white"
        outcome = msg.get("outcome")
        if isinstance(outcome, dict):
            winner_side = outcome.get("winner_side")
            winner_id = None
            if winner_side == "white":
                winner_id = board.white_user_id
            elif winner_side == "black":
                winner_id = board.black_user_id
            board.outcome = {"winner_user_id": winner_id, "reason": str(outcome.get("reason", "no_moves"))[:32]}
        await _broadcast_dama_state(board)
        if board.outcome is not None:
            asyncio.create_task(_reset_dama_board_after_delay(board))
        elif board.id == AI_BOARD_ID and not msg.get("continued"):
            # continued being true means this was only one hop of the
            # human's OWN still-ongoing multi-jump capture — side_to_move
            # deliberately wasn't flipped above, so it's still their turn,
            # not the AI's. Without this check, EVERY intermediate hop of a
            # human capture chain against the AI would also fire this,
            # computing and applying a move for the human's own side
            # (ai_side = board.side_to_move reads THEIR color mid-chain) —
            # silently finishing their turn on their behalf and leaving
            # side_to_move flipped to something that no longer matches
            # what their own client (still mid-chain locally, still
            # expecting to pick the next hop itself) is about to send,
            # which then gets rejected as "not_your_turn" — the game
            # appears to freeze on "AI is thinking…" with nothing arriving
            # to unstick it, exactly this bug's own reported symptom.
            asyncio.create_task(_play_dama_ai_move(board))
        return

    if msg_type == "dama_resign":
        if board.status != "in_progress" or board.outcome is not None:
            return
        if user_id not in (board.white_user_id, board.black_user_id):
            return
        winner_id = board.black_user_id if user_id == board.white_user_id else board.white_user_id
        board.outcome = {"winner_user_id": winner_id, "reason": "resignation"}
        await _broadcast_dama_state(board)
        asyncio.create_task(_reset_dama_board_after_delay(board))
        return

    # Draw offer — same shape as Chess's own (see _handle_chess_message),
    # human-vs-human boards only.
    if msg_type == "dama_draw_offer":
        if board.id == AI_BOARD_ID or board.status != "in_progress" or board.outcome is not None:
            return
        if user_id not in (board.white_user_id, board.black_user_id):
            return
        if board.draw_offered_by is not None or board.undo_requested_by is not None:
            return
        board.draw_offered_by = user_id
        await _broadcast_dama_state(board)
        return

    if msg_type == "dama_draw_respond":
        # Same stale-request guard as chess_draw_respond's own.
        if board.draw_offered_by is None or board.draw_offered_by == user_id or board.outcome is not None:
            return
        if user_id not in (board.white_user_id, board.black_user_id):
            return
        if msg.get("accept"):
            board.outcome = {"winner_user_id": None, "reason": "draw_agreed"}
            board.draw_offered_by = None
            await _broadcast_dama_state(board)
            asyncio.create_task(_reset_dama_board_after_delay(board))
        else:
            board.draw_offered_by = None
            await _broadcast_dama_state(board)
        return

    # Undo request — Dama stays client-authoritative even here (see
    # DamaBoardState's own comment on undo_accept_pending_for): accepting
    # doesn't revert anything itself, it just authorizes the REQUESTER's own
    # client to send back the board it already has in memory from before
    # its last move, via dama_undo_commit below.
    if msg_type == "dama_undo_request":
        if board.id == AI_BOARD_ID or board.status != "in_progress" or board.outcome is not None:
            return
        # move_history isn't a reliable "has anyone moved yet" check here —
        # it only ever grows off an optional move_text the client doesn't
        # actually send in real play (see dama_move's own handling above);
        # last_move is set on every real move though, so check that instead.
        if board.last_move is None:
            return  # nothing to undo yet
        is_white = board.white_user_id == user_id
        if not is_white and board.black_user_id != user_id:
            return
        # Only the player who just moved may ask for it back — side_to_move
        # being the OTHER color is exactly what "I just moved" means here.
        if board.side_to_move == ("white" if is_white else "black"):
            return
        if board.draw_offered_by is not None or board.undo_requested_by is not None:
            return
        board.undo_requested_by = user_id
        await _broadcast_dama_state(board)
        return

    if msg_type == "dama_undo_respond":
        # Same stale-request guard as chess_undo_respond's own.
        if board.undo_requested_by is None or board.undo_requested_by == user_id or board.outcome is not None:
            return
        if user_id not in (board.white_user_id, board.black_user_id):
            return
        if msg.get("accept"):
            board.undo_accept_pending_for = board.undo_requested_by
            board.undo_requested_by = None
            await _broadcast_dama_state(board)
        else:
            board.undo_requested_by = None
            await _broadcast_dama_state(board)
        return

    if msg_type == "dama_undo_commit":
        if board.undo_accept_pending_for != user_id or board.outcome is not None:
            return  # not this user's turn to commit, or the game ended some other way meanwhile
        new_board = msg.get("board")
        if not isinstance(new_board, list) or len(new_board) != 8 or any(not isinstance(r, list) or len(r) != 8 for r in new_board):
            return
        side_to_move = msg.get("side_to_move")
        if side_to_move not in ("white", "black"):
            return
        board.board = new_board
        board.side_to_move = side_to_move
        if board.move_history:
            board.move_history.pop()
        board.last_move = None  # the move before that one isn't tracked — the highlight just clears
        board.undo_accept_pending_for = None
        await _broadcast_dama_state(board)
        return


async def _dama_disconnect_cleanup(user_id: int) -> None:
    board = _find_dama_board_for_user(user_id)
    if board is None:
        return
    if board.status == "waiting":
        board.reset()
        await _broadcast_dama_state(board)
        return
    winner_id = board.black_user_id if user_id == board.white_user_id else board.white_user_id
    board.outcome = {"winner_user_id": winner_id, "reason": "disconnect"}
    await _broadcast_dama_state(board)
    asyncio.create_task(_reset_dama_board_after_delay(board))


async def _reject(websocket: WebSocket, reason: str, code: int) -> None:
    # Same fix GL Sims World's own _reject established: a WebSocket closed
    # *before* accept() surfaces to browser/JS clients as a bare HTTP
    # handshake failure with no code or message at all, so every rejection
    # accepts first, sends one JSON message explaining why, then closes.
    await websocket.accept()
    await websocket.send_json({"type": "rejected", "reason": reason})
    await websocket.close(code=code)


@app.websocket("/ws")
async def world_ws(websocket: WebSocket) -> None:
    user_id = decode_user_id(websocket.query_params.get("token"))
    if user_id is None:
        await _reject(websocket, "unauthorized", 4401)
        return

    db = SessionLocal()
    try:
        row = db.get(GlophimonCharacter, user_id)
        starter_row = db.execute(
            select(GlophimonOwned).where(GlophimonOwned.user_id == user_id).order_by(GlophimonOwned.id).limit(1)
        ).scalar_one_or_none()
    finally:
        db.close()
    if row is None:
        # Defensive backstop only — the vscode client always completes
        # character creation via POST /me before ever opening this socket.
        await _reject(websocket, "no_character", 4404)
        return

    async with _join_lock:
        if user_id in connections:
            await _reject(websocket, "already_in_world", 4410)
            return

        await websocket.accept()
        conn = Connection(
            user_id,
            row.display_name,
            {
                "head_color": row.head_color,
                "body_color": row.body_color,
                "arm_color": row.arm_color,
                "leg_color": row.leg_color,
                "gender": row.gender,
            },
            websocket,
            row.x,
            row.z,
            row.facing,
            row.floor,
            starter_row.level if starter_row is not None else 1,
        )
        connections[user_id] = conn

    # Sent once, before roster — the client has never needed to know its own
    # user_id for anything before the Luba lobby system (which needs it to
    # tell "am I the host"/"is this invite for me" apart from every other
    # member in a luba_lobby_state broadcast).
    await websocket.send_json({"type": "self", "user_id": user_id})

    await websocket.send_json(
        {
            "type": "roster",
            "players": [
                {
                    "user_id": c.user_id,
                    "display_name": c.display_name,
                    "x": c.x,
                    "z": c.z,
                    "facing": c.facing,
                    "floor": c.floor,
                    **c.appearance,
                }
                for c in connections.values()
                if c.user_id != user_id
            ],
        }
    )
    await websocket.send_json(
        {
            "type": "wild_roster",
            "wilds": [
                {
                    "id": w.id,
                    "species_key": w.species_key,
                    "level": w.level,
                    "x": w.x,
                    "z": w.z,
                    "facing": w.facing,
                    "engaged_by": w.engaged_by,
                }
                for w in wild_spawns.values()
            ],
        }
    )
    # Full spectator mode's own late-join catch-up — without this, a client
    # that connects (or, on the extension side, just mounted this webview)
    # mid-fight would see nothing at all about any battle already in
    # progress until that battler's next wild_battle_update happens to fire,
    # which could be a while if the fight's current round is just sitting on
    # a defend-selection or intro pause. Sent as its own message (rather than
    # folded into wild_roster above) since it's keyed by battling user_id,
    # not by wild id — a wild's own wild_roster entry already exists
    # separately and unconditionally regardless of whether anyone's
    # currently fighting it. Each entry is exactly the same shape a live
    # wild_battle_state push carries (by_user_id plus the snapshot fields —
    # see _handle_wild_battle_message), so the client's own onSocketMessage
    # can hand every one of these to the identical per-battle handler a live
    # push already uses.
    await websocket.send_json(
        {
            "type": "wild_battle_roster",
            "battles": [{"by_user_id": uid, **snapshot} for uid, snapshot in active_wild_battles.items()],
        }
    )
    # The current Karirs race's public state (no bets — those are per-user
    # and only ever fetched over the authenticated GET /karirs/state) — a
    # newly-connecting client would otherwise see nothing at all until the
    # next race event fires, which could be up to an hour away.
    karirs_db = SessionLocal()
    try:
        current_race = karirs_db.query(KarirsRace).order_by(KarirsRace.id.desc()).first()
        if current_race is not None:
            # The bulletin board needs the *previous* race's winner even
            # when the current one (almost always, since a new one is
            # created the instant the previous resolves) is already back
            # to betting_open — otherwise a client that joins mid-betting-
            # window would just show the default "no results yet" text
            # forever. The TV's own "watch the previous race" replay (see
            # game.js's own karirsPreviousRace) needs the full race, not
            # just its winner's name, for exactly the same reason.
            previous_race = _karirs_previous_race_out(karirs_db, current_race.id)
            await websocket.send_json(
                {
                    "type": "karirs_state",
                    "race": _karirs_race_out(karirs_db, current_race).model_dump(mode="json"),
                    "last_winner": previous_race.winning_name if previous_race else None,
                    "previous_race": previous_race.model_dump(mode="json") if previous_race else None,
                }
            )
    finally:
        karirs_db.close()
    # Both Chessdom boards' current state — otherwise a client connecting
    # while a game is already in progress (or waiting) would only find out
    # about it on the next actual mutation, leaving its own highlight/click
    # gating wrong in the meantime.
    for board in chess_boards.values():
        await websocket.send_json(_chess_state_payload(board))
    for board in dama_boards.values():
        await websocket.send_json(_dama_state_payload(board))
    # Floor 2 cinema's own late-join catch-up — sent as the exact same
    # message shapes a live cinema_projectionist_state/cinema_screen_state
    # broadcast already uses (see _handle_cinema_message), so the client's
    # existing onSocketMessage handlers for those two types just work here
    # too, with no separate "initial snapshot" shape to reconcile. Without
    # this, a client connecting (or the game just mounting) after someone
    # already claimed the role or changed the URL would show the stale
    # default until the next actual change happened to broadcast.
    await websocket.send_json({"type": "cinema_projectionist_state", "projectionist": cinema_projectionist})
    await websocket.send_json({"type": "cinema_screen_state", "url": cinema_screen_url})
    await broadcast(
        {
            "type": "joined",
            "user_id": user_id,
            "display_name": conn.display_name,
            "x": conn.x,
            "z": conn.z,
            "facing": conn.facing,
            "floor": conn.floor,
            **conn.appearance,
        },
        exclude=websocket,
    )

    def persist_position() -> None:
        db = SessionLocal()
        try:
            character = db.get(GlophimonCharacter, user_id)
            if character is not None:
                character.x = conn.x
                character.z = conn.z
                character.facing = conn.facing
                character.floor = conn.floor
                db.commit()
        finally:
            db.close()

    try:
        while True:
            msg = await websocket.receive_json()
            msg_type = msg.get("type")

            if msg_type == "position":
                try:
                    conn.x = float(msg["x"])
                    conn.z = float(msg["z"])
                    conn.facing = float(msg["facing"])
                except (KeyError, TypeError, ValueError):
                    continue
                # Defensive fallback only (every client sends this from here
                # on) — a missing/malformed floor keeps this connection's
                # last-known value rather than snapping it back to ground.
                try:
                    conn.floor = int(msg["floor"])
                except (KeyError, TypeError, ValueError):
                    pass
                else:
                    # Auto-vacate the cinema projectionist role the instant
                    # they leave floor 2 — only reachable when the floor
                    # parse above actually succeeded (the `else`), since an
                    # unparsed/missing floor leaves conn.floor at its last
                    # known value and shouldn't be treated as "just left".
                    if conn.floor != CINEMA_FLOOR_INDEX:
                        await _cinema_release_if_projectionist(user_id)
                await broadcast(
                    {"type": "position", "user_id": user_id, "x": conn.x, "z": conn.z, "facing": conn.facing, "floor": conn.floor},
                    exclude=websocket,
                )
                await _check_chess_away(user_id, conn)
                now = time.monotonic()
                if now - conn.last_saved_at >= POSITION_SAVE_INTERVAL_S:
                    conn.last_saved_at = now
                    persist_position()

            elif msg_type == "chat":
                text = str(msg.get("text", "")).strip()[:CHAT_MAX_LENGTH]
                if not text:
                    continue
                now = time.monotonic()
                if now - conn.last_chat_at < CHAT_MIN_INTERVAL_S:
                    continue  # simple flood guard — silently dropped, not queued/delayed
                conn.last_chat_at = now
                # Excludes the sender's own socket — it already showed its
                # own bubble optimistically the instant it hit Enter (see
                # game.js's own chatInputEl keydown listener), same
                # convention "position" above already follows.
                await broadcast({"type": "chat", "user_id": user_id, "text": text}, exclude=websocket)

            elif msg_type is not None and msg_type.startswith("luba_"):
                await _handle_luba_message(user_id, conn, msg)

            elif msg_type is not None and msg_type.startswith("pvp_"):
                await _handle_pvp_message(user_id, conn, msg)

            elif msg_type is not None and msg_type.startswith("wild_battle_"):
                await _handle_wild_battle_message(user_id, conn, msg)

            elif msg_type is not None and msg_type.startswith("chess_"):
                await _handle_chess_message(user_id, conn, msg)

            elif msg_type is not None and msg_type.startswith("dama_"):
                await _handle_dama_message(user_id, conn, msg)

            elif msg_type is not None and msg_type.startswith("cinema_"):
                await _handle_cinema_message(user_id, conn, msg)
    except WebSocketDisconnect:
        pass
    finally:
        # Unconditional final save — the "teleported back to where they
        # last left" guarantee depends on this, not just the throttled
        # timer above, which may not have fired since the last real move.
        persist_position()
        if connections.get(user_id) is conn:
            del connections[user_id]
        # A disconnect (crash, closed tab, network drop) is the only way a
        # wild this player was mid-battle with could otherwise get stuck
        # "engaged" forever — release_wild itself only ever runs when the
        # client cleanly finishes its own battle, which never happens here.
        for wild in wild_spawns.values():
            if wild.engaged_by == user_id:
                wild.engaged_by = None
                wild.state = "wander"
                now = time.monotonic()
                wild.spawn_x = wild.x
                wild.spawn_z = wild.z
                wild.wander_target_x = wild.x
                wild.wander_target_z = wild.z
                wild.wander_paused_until = now + random.uniform(WILD_WANDER_PAUSE_MIN_S, WILD_WANDER_PAUSE_MAX_S)
                await broadcast({"type": "wild_released", "id": wild.id})
        # Same reasoning again — a disconnect (crash, closed tab, network
        # drop) is the only way a spectated wild battle could otherwise get
        # stuck showing on every OTHER connected client forever: the
        # battling player's own client is the only thing that ever sends
        # wild_battle_end (see endBattle()'s own guard on battle.wildId),
        # and that obviously never runs once its own connection is already
        # gone. Every client currently rendering this as a peerBattles entry
        # tears its own dome/rigs down and restores that player's normal
        # overworld avatar the instant this arrives (see game.js's own
        # onSocketMessage wild_battle_end handler).
        if user_id in active_wild_battles:
            del active_wild_battles[user_id]
            await broadcast({"type": "wild_battle_end", "by_user_id": user_id})
        # Same reasoning as the wild-release cleanup above — a disconnect is
        # the only way a Luba lobby this player was hosting/in could
        # otherwise get stuck around forever. No connection left to notify
        # the disconnecting player themselves, unlike an explicit
        # luba_leave — everyone else still gets the usual update (host
        # promotion included, see _remove_from_luba_lobby's own comment).
        lobby_id = _luba_member_lobby.get(user_id)
        if lobby_id is not None:
            lobby = luba_lobbies.get(lobby_id)
            if lobby is not None:
                await _remove_from_luba_lobby(lobby, user_id)
        # Same reasoning again — a disconnect is the only way a pending PVP
        # invite involving this player could otherwise get stuck around
        # forever (the other party left waiting with no response coming).
        pvp_invite_id = _user_pending_pvp_invite.get(user_id)
        if pvp_invite_id is not None:
            invite = pvp_invites.get(pvp_invite_id)
            if invite is not None:
                other_id = invite.to_user_id if invite.from_user_id == user_id else invite.from_user_id
                await _clear_pvp_invite(invite)
                await send_to(other_id, {"type": "pvp_declined", "invite_id": invite.id, "reason": "disconnected"})
        # Same reasoning again — a disconnect mid-match immediately ends it,
        # remaining player wins, HP persisted as of the last resolved round.
        pvp_match_id = _user_active_pvp_match.get(user_id)
        if pvp_match_id is not None:
            match = pvp_matches.get(pvp_match_id)
            if match is not None:
                await _pvp_forfeit_or_disconnect(match, user_id, "disconnected")
        # Same reasoning again — a disconnect either frees up a board this
        # player was hosting/waiting on, or ends their in-progress game by
        # forfeit (see _chess_disconnect_cleanup).
        await _chess_disconnect_cleanup(user_id)
        await _dama_disconnect_cleanup(user_id)
        # Same reasoning again — a disconnect (crash, closed tab, network
        # drop) is the only way the cinema projectionist role could
        # otherwise get stuck held by someone no longer even connected,
        # let alone still standing on floor 2. Shared with the "walked off
        # floor 2" vacate path above (see _cinema_release_if_projectionist).
        await _cinema_release_if_projectionist(user_id)
        await broadcast({"type": "left", "user_id": user_id})
