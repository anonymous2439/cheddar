import asyncio
import random
import time
from dataclasses import dataclass

from fastapi import Depends, FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.security import decode_user_id, get_current_user_id

app = FastAPI(title="Luba API")

# Mirrors games/luba/client/src/arena.js + physics.js's own constants —
# kept here as plain numbers rather than importing anything (this is a
# separate Python service, there's nothing to import from the JS client).
PLAYER_HEIGHT = 1.8
HIT_RADIUS = 0.5
RESPAWN_DELAY_S = 3.0
PARRY_STUN_S = 0.9
# A parry needs both players to be "mid-swing at the same time" — but
# requiring the target's is_active_swing to literally be true at the
# exact instant the attacker's message is processed made that window well
# under one network tick wide (two independent clients' messages almost
# never interleave that precisely), so a clash was effectively
# unreachable even once the underlying geometry/facing was correct. This
# grace period is how long a player stays "parry-eligible" *after* their
# last reported isActiveSwing=true, not just an instantaneous flag.
# Mirrored client-side by player.js/player.ts's PARRY_GRACE_MS — keep
# both in sync.
PARRY_GRACE_S = 0.15
# Knockback direction is computed server-side (it already knows both
# players' positions for the hit-check anyway) but *applied* client-side —
# movement is fully client-authoritative in this project (see the plan's
# trust model), so this is just a push vector for each player's own client
# to run through the same movement-override mechanism the dash already
# uses, not a position the server dictates directly.
# Newly (re)spawned players drop in from up here — well above every
# obstacle's top (the tallest, the center jump block, tops out at
# JUMP_HEIGHT*0.85 ~= 1.53) — so landing is a short, visible drop onto
# whatever's below rather than a spawn already embedded in geometry.
SPAWN_Y = 6.0
# Random x/z spawn point kept inboard of the grid's actual edge (the
# floor extends to GRID_RADIUS*TILE_SIZE = 16 from arena.js) so a fresh
# spawn never lands right at — or over — the rim.
SPAWN_XZ_RANGE = 13.0
# "Prepare" window after a respawn: the player can move immediately but
# is excluded from combat entirely in both directions — can't land a hit
# and can't be hit — giving them a moment to get their bearings before
# they're fair game again. See _check_hit/the position handler for the
# actual enforcement; RESPAWN_INVULN_MS (below) is what's broadcast to
# clients so they can render a visible countdown/shield.
RESPAWN_INVULN_S = 2.5
RESPAWN_INVULN_MS = int(RESPAWN_INVULN_S * 1000)

# Smoke skill — a stationary cloud dropped at the caster's current
# position. Purely a *visibility* effect (rendered client-side by
# exploiting normal backface culling: a front-side-only sphere is opaque
# to anyone outside it but invisible to a camera inside it — see
# game.js/game.ts's spawnSmokeCloud), so the server's only job is
# enforcing the cooldown and relaying *when/where* one was cast — it
# never touches hit detection, which stays exactly as it already was.
SMOKE_COOLDOWN_S = 30.0
SMOKE_DURATION_S = 6.0
SMOKE_DURATION_MS = int(SMOKE_DURATION_S * 1000)

# Timed Deathmatch — currently the only mode: everyone can kill everyone,
# respawning at a random point (see _random_spawn above) with no
# kill/death limit, until the clock runs out; whoever has the most kills
# at that point wins. The host picks the match length in the lobby before
# starting (default 3 minutes) — see POST /matches below, called once by
# the host's client right after the generic lobby /start, the same
# "lazily create this game's own session config" pattern beats/mtg/chess
# already use instead of teaching the generic lobby endpoints about every
# game's specific setup.
DEFAULT_MATCH_DURATION_S = 180.0


def _random_spawn() -> dict:
    return {"x": random.uniform(-SPAWN_XZ_RANGE, SPAWN_XZ_RANGE), "y": SPAWN_Y, "z": random.uniform(-SPAWN_XZ_RANGE, SPAWN_XZ_RANGE)}


class MatchConfig(BaseModel):
    lobby_id: int
    duration_s: float


# lobby_id -> chosen duration, consumed (popped) the moment a room is
# actually created for that lobby — a plain dict is fine here (no lock
# needed, every access is a single synchronous dict operation, never
# spanning an await).
_match_configs: dict[int, float] = {}

# Mirrors player.js's combo timing constants — not to replicate the visual
# animation (see the plan's "open problem" note on why that's infeasible
# server-side), just enough to gate *when a new swing is allowed to start*
# as a backstop against a modified client spamming attack_start. The real,
# primary gate is the client's own local state machine, which already
# won't even send attack_start unless its own tryAttack() succeeds — this
# is a sanity check behind that, not the main UX enforcement, so it
# doesn't need to be pixel-perfect in sync with the client's animation.
SLASH1_TOTAL_S = 0.230  # SLASH1_WINDUP_MS + SLASH1_CUT_MS
COMBO_WINDOW_S = 3.0
SLASH2_DURATION_S = 0.150
ATTACK_COOLDOWN_S = 1.0

# Bow — the second weapon (see games/luba/client/src/player.js's own
# switchEquippedWeapon/startBowDraw/releaseBowDraw). Unlike the sword, an
# arrow is a real server-simulated projectile, not a client-reported swept
# blade position — it travels far enough, fast enough, and lives long
# enough that trusting a client's own claimed hit (the sword's model) would
# be trivial to abuse, and a single per-tick point-in-range check (like the
# melee one above) would let a fast arrow tunnel clean through a target
# between position updates. So the server owns the whole flight: every
# active arrow is stepped on its own fixed-rate loop below
# (_run_arrow_tick), independent of any player's own websocket messages.
#
# 20Hz is plenty for a ballistic arc that only needs to look right and land
# within ARROW_HIT_RADIUS of a target — it doesn't need render-frame
# precision the way the client's own visual copy does.
ARROW_TICK_S = 0.05
# Its own gravity constant, not physics.js's player GRAVITY=30 — a flatter,
# more game-y arc reads better for something you're aiming at a distance
# than a heavy, fast-dropping arrow would.
ARROW_GRAVITY = 12.0
# Must match game.js's own BOW_MIN_ARROW_SPEED/BOW_MAX_ARROW_SPEED — draw
# duration there maps 1:1 onto this same range, and the speed a client
# reports is clamped into it here regardless, so a modified client can
# never claim a faster arrow than a full, legitimate draw would produce.
MIN_ARROW_SPEED = 14.0
MAX_ARROW_SPEED = 34.0
# Safety cap independent of hitting the ground (see the tick loop) — covers
# a shot fired flat enough, or steep enough upward, that it would otherwise
# never cross y<=0 within a reasonable time.
ARROW_MAX_LIFETIME_S = 4.0
# Tighter than the sword's own HIT_RADIUS (0.5) — an arrow is a precise
# projectile, not a wide blade sweep, and reads as "skill-based" only if a
# clean miss can actually miss.
ARROW_HIT_RADIUS = 0.4
# Backstop between shots — the client's own bow cooldown (game.js's
# BOW_COOLDOWN_MS) is the primary gate; this just stops a modified client
# from spamming fire_arrow messages faster than a real draw/release cycle
# could ever produce.
ARROW_COOLDOWN_S = 0.25


@dataclass
class PlayerState:
    user_id: int
    websocket: WebSocket
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    facing: float = 0.0
    alive: bool = True
    is_active_swing: bool = False
    # Set to now+PARRY_GRACE_S whenever is_active_swing is reported true —
    # see PARRY_GRACE_S's own comment.
    active_swing_until: float = 0.0
    already_hit_this_swing: bool = False
    # Combo-gate bookkeeping (see SLASH1_TOTAL_S etc. above) — None means
    # "never swung yet", always allowed.
    combo_start_at: float | None = None
    swings_this_combo: int = 0
    next_allowed_swing_at: float = 0.0
    stunned_until: float = 0.0
    # Post-(re)spawn "prepare" window — see RESPAWN_INVULN_S above. Set on
    # every respawn; left at 0.0 (already-expired) for a fresh join, no
    # invulnerability grace period for just connecting mid-match.
    invulnerable_until: float = 0.0
    # Score for this match — landed hits only (a fall is self-inflicted,
    # nobody gets credit for it). Resets to 0 on reconnect, same as
    # everything else here — this is a single ephemeral match's state, not
    # a persisted stat.
    kills: int = 0
    # Cooldown backstop for the smoke skill — the client is the primary
    # gate (same trust model as the sword's cooldown), this just stops a
    # modified client from spamming it.
    smoke_next_allowed_at: float = 0.0
    # Bow cooldown backstop — see ARROW_COOLDOWN_S's own comment.
    next_allowed_arrow_at: float = 0.0
    # Per-player counter used to build this player's own arrow ids
    # (f"{user_id}-{arrow_seq}") — simple, unique within a room without a
    # global counter or randomness, since ids only ever need to be unique
    # per-room for the lifetime of one arrow.
    arrow_seq: int = 0
    # Purely cosmetic (relayed to peers so they can see this player
    # actually holding/aiming a bow — see the "position" handler and its
    # own peer_position broadcast) — never trusted for anything that
    # affects hit resolution, which stays keyed entirely off fire_arrow's
    # own reported origin/direction regardless of what this says.
    equipped_weapon: str = "sword"
    aim_elevation: float = 0.0
    is_drawing_bow: bool = False


@dataclass
class ArrowState:
    id: str
    owner_id: int
    x: float
    y: float
    z: float
    vx: float
    vy: float
    vz: float
    spawned_at: float


class LubaRoom:
    """One per lobby — in-memory only, nothing persisted (an ephemeral
    match's position/combat state has no reason to survive a restart, same
    reasoning the old PokeWorld ConnectionManager and karirs' race sockets
    both used)."""

    def __init__(self, lobby_id: int, duration_s: float) -> None:
        self.lobby_id = lobby_id
        self.players: dict[int, PlayerState] = {}
        self.arrows: dict[str, ArrowState] = {}
        self.duration_s = duration_s
        # Room creation (the first player's websocket connecting) is what
        # actually starts the clock — close enough to "match start" given
        # everyone connects within a moment of the host pressing Start,
        # the same approximation KarirsGame's "lazily created session
        # state" already relies on elsewhere.
        self.started_at = time.monotonic()
        self.ended = False

    async def broadcast(self, payload: dict, exclude_user_id: int | None = None) -> None:
        for player in list(self.players.values()):
            if player.user_id == exclude_user_id:
                continue
            try:
                await player.websocket.send_json(payload)
            except Exception:
                pass

    def ends_in_ms(self) -> float:
        return max(0.0, (self.started_at + self.duration_s - time.monotonic()) * 1000)


_rooms: dict[int, LubaRoom] = {}
_rooms_guard = asyncio.Lock()


async def _run_match_timer(room: LubaRoom) -> None:
    await asyncio.sleep(room.duration_s)
    if _rooms.get(room.lobby_id) is not room or room.ended:
        return  # room already replaced/torn down (e.g. everyone left)
    room.ended = True
    winner_id: int | None = None
    winner_kills = 0
    is_tie = False
    for p in room.players.values():
        if p.kills > winner_kills:
            winner_id, winner_kills, is_tie = p.user_id, p.kills, False
        elif p.kills == winner_kills and winner_id is not None:
            is_tie = True
    await room.broadcast({"type": "match_over", "winnerId": None if is_tie else winner_id, "winnerKills": winner_kills, "isTie": is_tie})


def _check_arrow_hit(room: LubaRoom, arrow: ArrowState, prev_x: float, prev_y: float, prev_z: float, now: float) -> tuple[PlayerState, bool] | None:
    """Sub-samples the segment the arrow just moved along this tick (not
    just its new endpoint) — same "check discrete points along the path,
    not just the current position" idea _check_hit above uses for the
    sword's own swept blade, just applied to a segment computed from the
    arrow's own last two positions instead of a rig's animated blade
    points. 4 sub-steps is comfortably tighter than ARROW_HIT_RADIUS given
    how far even the fastest arrow (MAX_ARROW_SPEED) travels in one
    ARROW_TICK_S tick."""
    steps = 4
    for i in range(1, steps + 1):
        t = i / steps
        sx = prev_x + (arrow.x - prev_x) * t
        sy = prev_y + (arrow.y - prev_y) * t
        sz = prev_z + (arrow.z - prev_z) * t
        for other in room.players.values():
            if other.user_id == arrow.owner_id or not other.alive or now < other.invulnerable_until:
                continue
            dx = sx - other.x
            dz = sz - other.z
            horiz = (dx * dx + dz * dz) ** 0.5
            if horiz <= ARROW_HIT_RADIUS and other.y <= sy <= other.y + PLAYER_HEIGHT + 0.2:
                return other, sy >= other.y + HEAD_Y_MIN
    return None


async def _apply_arrow_hit(room: LubaRoom, arrow: ArrowState, target: PlayerState, is_headshot: bool) -> None:
    """Same death broadcast shape _resolve_blade_points' own "hit" branch
    sends — reusing it means every client's existing onDeathMessage/
    decapitation/blood-spray/respawn handling already works for an arrow
    kill with zero new client code, no arrow-specific death path needed.
    No parry equivalent for arrows — an arrow always resolves as a hit,
    never a clash, regardless of what the target was doing."""
    owner = room.players.get(arrow.owner_id)
    if owner is None or not target.alive:
        return
    target.alive = False
    owner.kills += 1
    hdx = target.x - arrow.x
    hdz = target.z - arrow.z
    hdist = (hdx * hdx + hdz * hdz) ** 0.5 or 1.0
    await room.broadcast(
        {
            "type": "death",
            "userId": target.user_id,
            "cause": "hit",
            "attackerId": owner.user_id,
            "attackerKills": owner.kills,
            "isHeadshot": is_headshot,
            "headPushX": hdx / hdist,
            "headPushY": 1.0,
            "headPushZ": hdz / hdist,
        }
    )
    asyncio.create_task(_schedule_respawn(room, target))


async def _run_arrow_tick(room: LubaRoom) -> None:
    """One continuous loop per room, independent of any player's own
    websocket messages — see ARROW_TICK_S's own comment for why this needs
    to be a real simulation loop rather than a per-message check the way
    the sword's hit resolution is. Exits once this room is replaced/torn
    down (same staleness check _run_match_timer uses) or the match ends —
    arrows already in flight when the match ends just silently stop being
    tracked rather than being explicitly expired, since every client's own
    matchOver flag already stops it from mattering visually within a
    moment regardless."""
    while True:
        await asyncio.sleep(ARROW_TICK_S)
        if _rooms.get(room.lobby_id) is not room or room.ended:
            return
        if not room.arrows:
            continue
        now = time.monotonic()
        expired_ids: list[str] = []
        for arrow in list(room.arrows.values()):
            prev_x, prev_y, prev_z = arrow.x, arrow.y, arrow.z
            arrow.vy -= ARROW_GRAVITY * ARROW_TICK_S
            arrow.x += arrow.vx * ARROW_TICK_S
            arrow.y += arrow.vy * ARROW_TICK_S
            arrow.z += arrow.vz * ARROW_TICK_S
            hit = _check_arrow_hit(room, arrow, prev_x, prev_y, prev_z, now)
            if hit is not None:
                target, is_headshot = hit
                await _apply_arrow_hit(room, arrow, target, is_headshot)
                expired_ids.append(arrow.id)
                continue
            if arrow.y <= 0 or now - arrow.spawned_at >= ARROW_MAX_LIFETIME_S:
                expired_ids.append(arrow.id)
        for arrow_id in expired_ids:
            room.arrows.pop(arrow_id, None)
            await room.broadcast({"type": "arrow_expired", "arrowId": arrow_id})


async def _get_room(lobby_id: int) -> LubaRoom:
    async with _rooms_guard:
        room = _rooms.get(lobby_id)
        if room is None:
            duration_s = _match_configs.pop(lobby_id, DEFAULT_MATCH_DURATION_S)
            room = LubaRoom(lobby_id, duration_s)
            _rooms[lobby_id] = room
            asyncio.create_task(_run_match_timer(room))
            asyncio.create_task(_run_arrow_tick(room))
        return room


def _may_start_swing(player: PlayerState, now: float) -> bool:
    if player.combo_start_at is None or now >= player.next_allowed_swing_at:
        # Either the very first swing ever, or enough time has passed
        # since the last combo concluded — this is a fresh slash1.
        player.combo_start_at = now
        player.swings_this_combo = 1
        # Provisional — extended below if a free slash2 never comes and
        # the hold window itself times out (see the periodic sweep in the
        # websocket loop, which advances next_allowed_swing_at once the
        # window lapses unused).
        player.next_allowed_swing_at = now + SLASH1_TOTAL_S + COMBO_WINDOW_S + ATTACK_COOLDOWN_S
        return True
    if player.swings_this_combo == 1 and now <= player.combo_start_at + SLASH1_TOTAL_S + COMBO_WINDOW_S:
        # The free second swing — no additional delay, but this is what
        # actually starts the real cooldown countdown.
        player.swings_this_combo = 2
        player.next_allowed_swing_at = now + SLASH2_DURATION_S + ATTACK_COOLDOWN_S
        return True
    return False


# Mirrors player.js/player.ts's rig proportions (LEG_H=0.7 + TORSO_H=0.65
# = 1.35, the head's own bottom edge) with a little margin below for a
# generous headshot band — this only decides which death animation plays
# (decapitation vs. the normal fall), it never changes whether a hit
# lands at all, which is still governed entirely by HIT_RADIUS above.
HEAD_Y_MIN = 1.3


def _check_hit(room: LubaRoom, attacker: PlayerState, blade_points: list[dict], now: float) -> tuple[PlayerState, bool] | None:
    for other in room.players.values():
        if other.user_id == attacker.user_id or not other.alive or now < other.invulnerable_until:
            continue
        for p in blade_points:
            dx = p["x"] - other.x
            dz = p["z"] - other.z
            horiz = (dx * dx + dz * dz) ** 0.5
            if horiz <= HIT_RADIUS and other.y <= p["y"] <= other.y + PLAYER_HEIGHT + 0.2:
                is_headshot = p["y"] >= other.y + HEAD_Y_MIN
                return other, is_headshot
    return None


async def _resolve_blade_points(room: LubaRoom, me: PlayerState, blade_points: list[dict] | None, now: float) -> None:
    """Shared by both the regular "position" tick and the denser
    "attack_sample" channel (see NETWORK_TICK_MS/ATTACK_SAMPLE_MS's own
    comment for why a swing needs its own higher-frequency channel) — same
    hit/parry/kill resolution either way, just triggered more often
    on-swing. already_hit_this_swing already gates this to at most one
    resolved outcome per swing, so calling it redundantly from both
    channels for the same instant is harmless, not a double-hit risk."""
    if (
        room.ended
        or not blade_points
        or me.already_hit_this_swing
        or not me.alive
        or now < me.stunned_until
        or now < me.invulnerable_until
    ):
        return
    result = _check_hit(room, me, blade_points, now)
    if result is None:
        return
    target, is_headshot = result
    me.already_hit_this_swing = True
    target_engaged = target.is_active_swing or now < target.active_swing_until
    if target_engaged and not target.already_hit_this_swing:
        # Both swords clash — a parry, not a hit. Push direction: away
        # from each other, along the line between their two current
        # positions (falls back to +X if they're exactly on top of each
        # other, an edge case that never legitimately happens but would
        # otherwise divide by zero).
        target.already_hit_this_swing = True
        me.stunned_until = now + PARRY_STUN_S
        target.stunned_until = now + PARRY_STUN_S
        dx = target.x - me.x
        dz = target.z - me.z
        dist = (dx * dx + dz * dz) ** 0.5 or 1.0
        push_x, push_z = dx / dist, dz / dist
        await room.broadcast(
            {
                "type": "parry",
                "player1Id": me.user_id,
                "player2Id": target.user_id,
                "player1PushX": -push_x,
                "player1PushZ": -push_z,
                "player2PushX": push_x,
                "player2PushZ": push_z,
            }
        )
    else:
        target.alive = False
        me.kills += 1
        # Launch direction for the decapitation effect (only meaningful
        # when is_headshot — clients ignore it otherwise): away from the
        # attacker, same reasoning as the parry knockback direction above,
        # plus a fixed upward component so it actually pops up and off
        # rather than just sliding sideways.
        hdx = target.x - me.x
        hdz = target.z - me.z
        hdist = (hdx * hdx + hdz * hdz) ** 0.5 or 1.0
        await room.broadcast(
            {
                "type": "death",
                "userId": target.user_id,
                "cause": "hit",
                "attackerId": me.user_id,
                "attackerKills": me.kills,
                "isHeadshot": is_headshot,
                "headPushX": hdx / hdist,
                "headPushY": 1.0,
                "headPushZ": hdz / hdist,
            }
        )
        asyncio.create_task(_schedule_respawn(room, target))


async def _schedule_respawn(room: LubaRoom, player: PlayerState) -> None:
    await asyncio.sleep(RESPAWN_DELAY_S)
    if room.players.get(player.user_id) is not player:
        return  # disconnected in the meantime
    player.alive = True
    spawn = _random_spawn()
    player.x, player.y, player.z = spawn["x"], spawn["y"], spawn["z"]
    player.invulnerable_until = time.monotonic() + RESPAWN_INVULN_S
    player.already_hit_this_swing = False
    player.is_active_swing = False
    player.active_swing_until = 0.0
    await room.broadcast(
        {"type": "respawn", "userId": player.user_id, "invulnerableMs": RESPAWN_INVULN_MS, **spawn}
    )


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/matches")
def set_match_config(config: MatchConfig, _user_id: int = Depends(get_current_user_id)) -> dict:
    """Called once by the host's client right after the generic lobby
    /start, before anyone's websocket connects — see the plan note by
    DEFAULT_MATCH_DURATION_S. Doesn't check that the caller is actually
    this lobby's leader (matching the rest of this service's trust
    model — Cheddar's own lobby /start already enforces that; a
    non-leader hitting this early is harmless, worst case a room gets a
    duration nobody asked for)."""
    _match_configs[config.lobby_id] = config.duration_s
    return {"status": "ok"}


@app.websocket("/ws")
async def luba_ws(websocket: WebSocket, lobby_id: int, token: str | None = None) -> None:
    user_id = decode_user_id(token)
    if user_id is None:
        await websocket.close(code=4401)
        return

    room = await _get_room(lobby_id)
    spawn = _random_spawn()
    me = PlayerState(user_id=user_id, websocket=websocket, x=spawn["x"], y=spawn["y"], z=spawn["z"])
    room.players[user_id] = me
    await websocket.accept()

    # Roster + everyone else's current state, so a client joining mid-match
    # sees who's already there instead of waiting for their next tick. Also
    # carries the connecting player's *own* randomly-assigned spawn point
    # (selfX/Y/Z) — without this, the client had no way to know what
    # random spot the server just picked for `me` above, so it fell back
    # to starting its own local physics at a fixed hardcoded point instead
    # (only actual respawns, which explicitly broadcast a fresh position,
    # ever got randomized in practice).
    await websocket.send_json(
        {
            "type": "roster",
            "selfId": user_id,
            "selfX": me.x,
            "selfY": me.y,
            "selfZ": me.z,
            "matchEndsInMs": room.ends_in_ms(),
            "players": [
                {
                    "userId": p.user_id,
                    "x": p.x,
                    "y": p.y,
                    "z": p.z,
                    "facing": p.facing,
                    "alive": p.alive,
                    "kills": p.kills,
                    "equippedWeapon": p.equipped_weapon,
                    "aimElevation": p.aim_elevation,
                }
                for p in room.players.values()
                if p.user_id != user_id
            ],
        }
    )
    await room.broadcast({"type": "joined", "userId": user_id, "x": me.x, "y": me.y, "z": me.z}, exclude_user_id=user_id)

    try:
        while True:
            msg = await websocket.receive_json()
            msg_type = msg.get("type")
            now = time.monotonic()

            if msg_type == "position":
                me.x, me.y, me.z, me.facing = msg["x"], msg["y"], msg["z"], msg["facing"]
                me.is_active_swing = bool(msg.get("isActiveSwing"))
                if me.is_active_swing:
                    me.active_swing_until = now + PARRY_GRACE_S
                # Cosmetic-only (see PlayerState's own comment) — validated
                # just enough that a malformed/malicious value can't corrupt
                # what every OTHER client renders for this player, same
                # "trust but sanitize" level the rest of this handler
                # already applies to facing/isActiveSwing.
                equipped_weapon = msg.get("equippedWeapon")
                me.equipped_weapon = equipped_weapon if equipped_weapon in ("sword", "bow") else "sword"
                try:
                    me.aim_elevation = max(-1.6, min(1.6, float(msg.get("aimElevation", 0.0))))
                except (TypeError, ValueError):
                    me.aim_elevation = 0.0
                me.is_drawing_bow = bool(msg.get("isDrawingBow"))
                await room.broadcast(
                    {
                        "type": "peer_position",
                        "userId": user_id,
                        "x": me.x,
                        "y": me.y,
                        "z": me.z,
                        "facing": me.facing,
                        # Lets other clients locally mirror the swing
                        "isActiveSwing": me.is_active_swing,
                        "equippedWeapon": me.equipped_weapon,
                        "aimElevation": me.aim_elevation,
                        "isDrawingBow": me.is_drawing_bow,
                    },
                    exclude_user_id=user_id,
                )

                await _resolve_blade_points(room, me, msg.get("bladePoints"), now)

            elif msg_type == "attack_sample":
                # Denser than "position" — sent every render frame while
                # the swing is actually active (see the client's own
                # comment on ATTACK_SAMPLE_MS), specifically to catch a
                # fast continuous blade sweep that a swing's brief ~200ms
                # active window might otherwise only sample 2-3 times at
                # the regular ~15/sec position tick rate — especially
                # against a moving target, whose last-known server-side
                # position is itself only as fresh as their own last
                # position tick.
                await _resolve_blade_points(room, me, msg.get("bladePoints"), now)

            elif msg_type == "attack_start":
                if not room.ended and _may_start_swing(me, now):
                    me.already_hit_this_swing = False

            elif msg_type == "fell":
                if me.alive:
                    me.alive = False
                    await room.broadcast({"type": "death", "userId": user_id, "cause": "fall", "attackerId": None})
                    asyncio.create_task(_schedule_respawn(room, me))

            elif msg_type == "smoke_start":
                if not room.ended and me.alive and now >= me.smoke_next_allowed_at:
                    me.smoke_next_allowed_at = now + SMOKE_COOLDOWN_S
                    await room.broadcast(
                        {
                            "type": "smoke",
                            "userId": user_id,
                            "x": me.x,
                            "y": me.y,
                            "z": me.z,
                            "durationMs": SMOKE_DURATION_MS,
                        }
                    )

            elif msg_type == "fire_arrow":
                # Same restriction set the sword's own attack_start/position
                # handlers already enforce (alive, not stunned, not still in
                # the post-respawn prepare window) plus its own cooldown
                # backstop — see ARROW_COOLDOWN_S. The client is expected to
                # already gate all of this itself (see game.js's own
                # isInvulnerable/playerStunned/matchOver checks before ever
                # sending fire_arrow); this is the same not-the-primary-gate
                # backstop role _may_start_swing plays for the sword.
                if (
                    not room.ended
                    and me.alive
                    and now >= me.stunned_until
                    and now >= me.invulnerable_until
                    and now >= me.next_allowed_arrow_at
                ):
                    me.next_allowed_arrow_at = now + ARROW_COOLDOWN_S
                    speed = max(MIN_ARROW_SPEED, min(MAX_ARROW_SPEED, float(msg.get("speed", MIN_ARROW_SPEED))))
                    dir_x, dir_y, dir_z = float(msg["dirX"]), float(msg["dirY"]), float(msg["dirZ"])
                    dir_len = (dir_x * dir_x + dir_y * dir_y + dir_z * dir_z) ** 0.5 or 1.0
                    arrow_id = f"{user_id}-{me.arrow_seq}"
                    me.arrow_seq += 1
                    arrow = ArrowState(
                        id=arrow_id,
                        owner_id=user_id,
                        x=float(msg["originX"]),
                        y=float(msg["originY"]),
                        z=float(msg["originZ"]),
                        vx=(dir_x / dir_len) * speed,
                        vy=(dir_y / dir_len) * speed,
                        vz=(dir_z / dir_len) * speed,
                        spawned_at=now,
                    )
                    room.arrows[arrow_id] = arrow
                    # vx/vy/vz broadcast directly (already direction*speed)
                    # rather than separate dir+speed — clients replay the
                    # exact same position += v*dt; v.y -= ARROW_GRAVITY*dt
                    # step this tick loop uses (see game.js's own
                    # ARROW_GRAVITY_CLIENT, kept in sync with the constant
                    # above), so the visual arrow tracks what the server is
                    # actually simulating instead of drifting from it.
                    await room.broadcast(
                        {
                            "type": "arrow_spawned",
                            "arrowId": arrow_id,
                            "ownerId": user_id,
                            "x": arrow.x,
                            "y": arrow.y,
                            "z": arrow.z,
                            "vx": arrow.vx,
                            "vy": arrow.vy,
                            "vz": arrow.vz,
                        }
                    )

    except WebSocketDisconnect:
        pass
    finally:
        room.players.pop(user_id, None)
        await room.broadcast({"type": "left", "userId": user_id})
        if not room.players:
            _rooms.pop(lobby_id, None)
