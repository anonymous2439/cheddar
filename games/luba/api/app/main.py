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
SLASH1_TOTAL_S = 0.330  # SLASH1_WINDUP_MS + SLASH1_CUT_MS
COMBO_WINDOW_S = 3.0
SLASH2_DURATION_S = 0.220
ATTACK_COOLDOWN_S = 1.0


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


class LubaRoom:
    """One per lobby — in-memory only, nothing persisted (an ephemeral
    match's position/combat state has no reason to survive a restart, same
    reasoning the old PokeWorld ConnectionManager and karirs' race sockets
    both used)."""

    def __init__(self, lobby_id: int, duration_s: float) -> None:
        self.lobby_id = lobby_id
        self.players: dict[int, PlayerState] = {}
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


async def _get_room(lobby_id: int) -> LubaRoom:
    async with _rooms_guard:
        room = _rooms.get(lobby_id)
        if room is None:
            duration_s = _match_configs.pop(lobby_id, DEFAULT_MATCH_DURATION_S)
            room = LubaRoom(lobby_id, duration_s)
            _rooms[lobby_id] = room
            asyncio.create_task(_run_match_timer(room))
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


def _check_hit(room: LubaRoom, attacker: PlayerState, blade_points: list[dict], now: float) -> PlayerState | None:
    for other in room.players.values():
        if other.user_id == attacker.user_id or not other.alive or now < other.invulnerable_until:
            continue
        for p in blade_points:
            dx = p["x"] - other.x
            dz = p["z"] - other.z
            horiz = (dx * dx + dz * dz) ** 0.5
            if horiz <= HIT_RADIUS and other.y <= p["y"] <= other.y + PLAYER_HEIGHT + 0.2:
                return other
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
    target = _check_hit(room, me, blade_points, now)
    if target is None:
        return
    me.already_hit_this_swing = True
    if target.is_active_swing and not target.already_hit_this_swing:
        # Both swords clash — a parry, not a hit.
        target.already_hit_this_swing = True
        me.stunned_until = now + PARRY_STUN_S
        target.stunned_until = now + PARRY_STUN_S
        await room.broadcast({"type": "parry", "player1Id": me.user_id, "player2Id": target.user_id})
    else:
        target.alive = False
        me.kills += 1
        await room.broadcast(
            {"type": "death", "userId": target.user_id, "cause": "hit", "attackerId": me.user_id, "attackerKills": me.kills}
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

    except WebSocketDisconnect:
        pass
    finally:
        room.players.pop(user_id, None)
        await room.broadcast({"type": "left", "userId": user_id})
        if not room.players:
            _rooms.pop(lobby_id, None)
