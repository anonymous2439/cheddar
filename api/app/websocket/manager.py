from collections import defaultdict

from fastapi import WebSocket


class ConnectionManager:
    """In-memory per-process connection registry.

    Fine for a single instance. Scaling to multiple API processes/nodes will
    need a pub/sub layer (e.g. Redis) so a message can reach a user whose
    socket lives on a different process than the sender's.
    """

    def __init__(self) -> None:
        self._connections: dict[int, set[WebSocket]] = defaultdict(set)

    async def connect(self, user_id: int, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[user_id].add(websocket)

    def disconnect(self, user_id: int, websocket: WebSocket) -> None:
        self._connections[user_id].discard(websocket)
        if not self._connections[user_id]:
            del self._connections[user_id]

    def is_online(self, user_id: int) -> bool:
        return user_id in self._connections

    async def send_to_user(self, user_id: int, payload: dict) -> None:
        for websocket in list(self._connections.get(user_id, ())):
            try:
                await websocket.send_json(payload)
            except Exception:
                self.disconnect(user_id, websocket)

    async def broadcast(self, user_ids, payload: dict, exclude_user_id: int | None = None) -> None:
        for user_id in user_ids:
            if user_id == exclude_user_id:
                continue
            await self.send_to_user(user_id, payload)


manager = ConnectionManager()
