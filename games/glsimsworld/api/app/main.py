"""GL Sims World — a single persistent shared space, not a per-lobby game:
real logged-in Cheddar users each claim one of the 25 karirs racer skins
(first come, first served — one racer per person, released the instant
their connection drops), walk around, and chat with each other live. See
the vscode extension's own /glsimsworld command for how this gets reached
— there's no lobby/games_catalog integration at all here on purpose.

Movement is fully client-authoritative (this service never simulates
positions, just relays them) — same trust level as Luba's own movement.
The one thing genuinely owned here is the claim itself (so two people
can't both be "Xiao" at once) and the persisted chat log.
"""

import asyncio
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.db import Base, SessionLocal, engine
from app.models import WorldChatMessage
from app.schemas import ChatMessageOut, RacerStatus
from app.security import decode_user_id, get_current_user_id

Base.metadata.create_all(bind=engine)

app = FastAPI(title="GL Sims World API")

# Same 25-racer roster as karirs' roster.py's SEED_RACERS / GL Sims'
# CHARACTER_NAMES — duplicated here rather than imported, same as every
# other service in this project keeps its own copy of this list.
ROSTER = [
    "Neil Axinto", "Aby Calago", "Ashley Bayarcal", "Brian Lisondra", "Carl Perral",
    "Chaimel Enjambre", "Elieser Tajanlangit", "Jayson Martinez", "Jerome Madelo", "Jhoewell Posas",
    "Jhon Pabroa", "John Macapaz", "John Leo Salac", "Jonah Taganahan", "Joshua Paulo",
    "Troy Alonsagay", "Grace Vellina", "Mat Ando", "Michael Tonilon", "Mike Miñoza",
    "Novel Chavez", "Percival Mansueto", "Rashed Perez", "Roland Clarion", "Xiao",
]
ROSTER_SET = set(ROSTER)


class Connection:
    __slots__ = ("user_id", "display_name", "racer", "websocket", "x", "z", "facing")

    def __init__(self, user_id: int, display_name: str, racer: str, websocket: WebSocket) -> None:
        self.user_id = user_id
        self.display_name = display_name
        self.racer = racer
        self.websocket = websocket
        self.x = 0.0
        self.z = 0.0
        self.facing = 0.0


# racer name -> the one Connection currently holding it — this dict *is*
# the claim registry; nothing about who's-connected is ever persisted, it
# resets cleanly (everyone released) on a backend restart, same as Luba's
# in-memory rooms.
connections: dict[str, Connection] = {}
# Guards connections' check-then-insert on join against two WS handshakes
# racing each other for the same racer (asyncio is single-threaded, but
# the accept()/DB-lookup await points below are real yield points another
# connect could interleave with).
_join_lock = asyncio.Lock()


async def broadcast(payload: dict, exclude: WebSocket | None = None) -> None:
    for conn in list(connections.values()):
        if conn.websocket is exclude:
            continue
        try:
            await conn.websocket.send_json(payload)
        except Exception:
            pass  # its own receive loop's disconnect handling will clean it up


@app.get("/status", response_model=list[RacerStatus])
def get_status(_user_id: int = Depends(get_current_user_id)):
    return [
        RacerStatus(name=name, taken=name in connections, taken_by=connections[name].display_name if name in connections else None)
        for name in ROSTER
    ]


@app.get("/chat/recent", response_model=list[ChatMessageOut])
def get_recent_chat(limit: int = 100, _user_id: int = Depends(get_current_user_id)):
    limit = max(1, min(limit, 500))
    db = SessionLocal()
    try:
        rows = (
            db.execute(select(WorldChatMessage).order_by(WorldChatMessage.id.desc()).limit(limit))
            .scalars()
            .all()
        )
        return list(reversed(rows))  # oldest first, for a natural top-to-bottom log
    finally:
        db.close()


async def _reject(websocket: WebSocket, reason: str, code: int) -> None:
    # A WebSocket closed *before* accept() surfaces to browser/JS clients as
    # a bare HTTP handshake failure (confirmed directly: a python websockets
    # test client saw a plain "HTTP 403", no close code, no message) — there
    # is no way to hand the client a reason that way. So every rejection
    # accepts first, sends one JSON message explaining why, then closes —
    # the close code is still set for completeness, but the message is what
    # the client actually reads to decide what to show.
    await websocket.accept()
    await websocket.send_json({"type": "rejected", "reason": reason})
    await websocket.close(code=code)


@app.websocket("/ws")
async def world_ws(websocket: WebSocket) -> None:
    user_id = decode_user_id(websocket.query_params.get("token"))
    racer = websocket.query_params.get("racer") or ""
    # Client-supplied, same trust level as the extension's own local display
    # of its logged-in user's name — this is flavor text, not anything a
    # spoofed value could actually abuse (the claim itself is keyed on the
    # JWT-verified user_id, not this).
    display_name = (websocket.query_params.get("display_name") or "").strip() or "Someone"

    if user_id is None:
        await _reject(websocket, "unauthorized", 4401)
        return
    if racer not in ROSTER_SET:
        await _reject(websocket, "unknown_racer", 4404)
        return

    async with _join_lock:
        if racer in connections:
            await _reject(websocket, "taken", 4409)  # client shows "pick another"
            return
        if any(c.user_id == user_id for c in connections.values()):
            await _reject(websocket, "already_in_world", 4410)  # this person already holds a different racer
            return

        await websocket.accept()
        conn = Connection(user_id, display_name, racer, websocket)
        connections[racer] = conn

    # Snapshot of everyone *else* already in the world, so the new arrival
    # renders them immediately instead of waiting for each peer's next
    # position tick.
    await websocket.send_json(
        {
            "type": "roster",
            "players": [
                {"racer": c.racer, "display_name": c.display_name, "x": c.x, "z": c.z, "facing": c.facing}
                for c in connections.values()
                if c.racer != racer
            ],
        }
    )
    # Recent chat history piggybacks on this same socket rather than a
    # separate GET /chat/recent call from the client — that call would run
    # from inside the webview's own browser context (unlike every other
    # REST read here, which the extension host makes for it), so it would
    # hit the exact CORS wall Model Viewer's direct-fetch mistake did.
    db = SessionLocal()
    try:
        history = db.execute(select(WorldChatMessage).order_by(WorldChatMessage.id.desc()).limit(50)).scalars().all()
    finally:
        db.close()
    await websocket.send_json(
        {
            "type": "chat_history",
            "messages": [
                {"racer": row.racer_name, "text": row.text, "created_at": row.created_at.isoformat()}
                for row in reversed(history)
            ],
        }
    )
    await broadcast({"type": "joined", "racer": racer, "display_name": display_name}, exclude=websocket)

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
                await broadcast({"type": "position", "racer": racer, "x": conn.x, "z": conn.z, "facing": conn.facing}, exclude=websocket)

            elif msg_type == "chat":
                text = str(msg.get("text", "")).strip()[:500]
                if not text:
                    continue
                db = SessionLocal()
                try:
                    row = WorldChatMessage(racer_name=racer, user_id=user_id, text=text)
                    db.add(row)
                    db.commit()
                    created_at = row.created_at
                finally:
                    db.close()
                # Not excluded — the sender's own client shows its message
                # locally the instant it's typed (optimistic echo) rather
                # than waiting on a round trip, so it's excluded to avoid a
                # double-show for them specifically.
                await broadcast(
                    {
                        "type": "chat",
                        "racer": racer,
                        "text": text,
                        "created_at": (created_at or datetime.now(timezone.utc)).isoformat(),
                    },
                    exclude=websocket,
                )
    except WebSocketDisconnect:
        pass
    finally:
        # No grace period on purpose — the moment this connection is gone,
        # the racer is free for someone else to claim.
        if connections.get(racer) is conn:
            del connections[racer]
        await broadcast({"type": "left", "racer": racer})
