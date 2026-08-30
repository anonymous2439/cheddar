from collections import defaultdict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app.security import decode_user_id

app = FastAPI(title="PokeWorld API")

# Same origins as the main Cheddar API and karirs-api — this is a third
# backend the web client talks to directly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class WorldConnectionManager:
    """Fanout for live player positions, keyed by map (not by a lobby/race —
    this service has no concept of either). Nothing here is persisted —
    this is a first slice with a single always-on world, not durable state;
    a reconnect just re-announces position once the client sends its next
    "pos" message. Keyed by user_id (not just a socket set, unlike karirs'
    RaceConnectionManager) because a late joiner needs a snapshot of
    everyone already standing on that map, and because a reconnect should
    replace a stale socket for the same user rather than accumulate one."""

    def __init__(self) -> None:
        self._connections: dict[int, dict[int, WebSocket]] = defaultdict(dict)
        self._last_pos: dict[int, dict[int, dict]] = defaultdict(dict)
        # Which map each currently-connected user is on right now — lets a
        # player move between maps mid-session (they leave the old map's
        # roster/broadcast, join the new one) instead of only ever
        # supporting one map per connection for its whole lifetime.
        self._user_map: dict[int, int] = {}

    async def handle_pos(self, user_id: int, websocket: WebSocket, payload: dict) -> None:
        map_id = payload["map_id"]
        prev_map = self._user_map.get(user_id)

        if prev_map != map_id:
            if prev_map is not None:
                await self._leave_map(prev_map, user_id)
            # Newly present on this map (first message ever, or just
            # switched maps) — register them, then send a one-time snapshot
            # of everyone already here so a late joiner doesn't have to
            # wait for those players to move again before seeing them.
            self._connections[map_id][user_id] = websocket
            self._user_map[user_id] = map_id
            for existing in list(self._last_pos[map_id].values()):
                if existing["user_id"] != user_id:
                    await websocket.send_json(existing)

        pos_payload = {
            "type": "pos",
            "user_id": user_id,
            "map_id": map_id,
            "x": payload["x"],
            "y": payload["y"],
            "facing": payload.get("facing", "down"),
        }
        self._last_pos[map_id][user_id] = pos_payload
        await self._broadcast(map_id, pos_payload, exclude_user_id=user_id)

    async def disconnect(self, user_id: int) -> None:
        map_id = self._user_map.pop(user_id, None)
        if map_id is not None:
            await self._leave_map(map_id, user_id)

    async def _leave_map(self, map_id: int, user_id: int) -> None:
        self._connections.get(map_id, {}).pop(user_id, None)
        self._last_pos.get(map_id, {}).pop(user_id, None)
        if not self._connections.get(map_id):
            self._connections.pop(map_id, None)
            self._last_pos.pop(map_id, None)
        await self._broadcast(map_id, {"type": "leave", "user_id": user_id, "map_id": map_id})

    async def _broadcast(self, map_id: int, payload: dict, exclude_user_id: int | None = None) -> None:
        for uid, websocket in list(self._connections.get(map_id, {}).items()):
            if uid == exclude_user_id:
                continue
            try:
                await websocket.send_json(payload)
            except Exception:
                await self._leave_map(map_id, uid)


world_sockets = WorldConnectionManager()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.websocket("/ws")
async def world_ws(websocket: WebSocket) -> None:
    """Token goes in the query string (not an Authorization header) because
    a WebSocket upgrade request can't carry a custom header from browser
    JS — same constraint karirs' race_ws works around the same way. No REST
    surface beyond /health: this slice has no state that needs a
    request/response round trip, only live position fanout."""
    user_id = decode_user_id(websocket.query_params.get("token"))
    if user_id is None:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") == "pos":
                await world_sockets.handle_pos(user_id, websocket, data)
    except WebSocketDisconnect:
        pass
    finally:
        await world_sockets.disconnect(user_id)
