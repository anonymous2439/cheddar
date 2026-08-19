from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.auth_service import resolve_application, resolve_user_from_access_token
from app.db.session import SessionLocal
from app.websocket.handlers import dispatch_event, mark_offline, mark_online
from app.websocket.manager import manager

router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    token = websocket.query_params.get("token")
    api_key = websocket.query_params.get("api_key")

    with SessionLocal() as db:
        application = resolve_application(db, api_key)
        if application is None:
            await websocket.close(code=4401, reason="Invalid or missing api_key")
            return

        user = resolve_user_from_access_token(db, token)
        if user is None:
            await websocket.close(code=4401, reason="Invalid or missing token")
            return

    await manager.connect(user.id, websocket)
    with SessionLocal() as db:
        await mark_online(db, user)

    try:
        while True:
            event = await websocket.receive_json()
            with SessionLocal() as db:
                await dispatch_event(db, user, event)
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(user.id, websocket)
        if not manager.is_online(user.id):
            with SessionLocal() as db:
                await mark_offline(db, user)
