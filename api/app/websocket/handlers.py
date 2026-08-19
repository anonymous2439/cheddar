from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.conversation_participant import ConversationParticipant
from app.models.message import Message
from app.models.user import User
from app.websocket.manager import manager


def _serialize_message(message: Message) -> dict:
    return {
        "id": message.id,
        "conversation_id": message.conversation_id,
        "sender_id": message.sender_id,
        "type": message.type,
        "content": message.content,
        "metadata": message.metadata_,
        "reply_to_id": message.reply_to_id,
        "created_at": message.created_at.isoformat(),
    }


def _participant_ids(db: Session, conversation_id: int) -> list[int]:
    rows = (
        db.query(ConversationParticipant.user_id)
        .filter(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.left_at.is_(None),
        )
        .all()
    )
    return [row[0] for row in rows]


def _is_participant(db: Session, conversation_id: int, user_id: int) -> bool:
    return (
        db.query(ConversationParticipant)
        .filter(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == user_id,
            ConversationParticipant.left_at.is_(None),
        )
        .first()
        is not None
    )


async def handle_message_send(db: Session, user: User, data: dict) -> None:
    conversation_id = data.get("conversation_id")
    content = (data.get("content") or "").strip()

    if not conversation_id or not content:
        await manager.send_to_user(
            user.id, {"type": "error", "data": {"message": "conversation_id and content are required"}}
        )
        return

    if not _is_participant(db, conversation_id, user.id):
        await manager.send_to_user(
            user.id, {"type": "error", "data": {"message": "Not a participant of this conversation"}}
        )
        return

    message = Message(
        conversation_id=conversation_id,
        sender_id=user.id,
        type=data.get("message_type", "text"),
        content=content,
        reply_to_id=data.get("reply_to_id"),
    )
    db.add(message)
    db.commit()
    db.refresh(message)

    payload = {"type": "message.new", "data": _serialize_message(message)}
    await manager.broadcast(_participant_ids(db, conversation_id), payload)


async def handle_typing(db: Session, user: User, data: dict) -> None:
    conversation_id = data.get("conversation_id")
    state = data.get("state")

    if not conversation_id or state not in ("start", "stop"):
        return
    if not _is_participant(db, conversation_id, user.id):
        return

    payload = {
        "type": "typing",
        "data": {"conversation_id": conversation_id, "user_id": user.id, "state": state},
    }
    await manager.broadcast(_participant_ids(db, conversation_id), payload, exclude_user_id=user.id)


async def handle_message_read(db: Session, user: User, data: dict) -> None:
    conversation_id = data.get("conversation_id")
    message_id = data.get("message_id")

    if not conversation_id or not message_id:
        return

    participant = (
        db.query(ConversationParticipant)
        .filter(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == user.id,
        )
        .first()
    )
    if participant is None:
        return

    participant.last_read_message_id = message_id
    db.commit()

    payload = {
        "type": "message.read",
        "data": {"conversation_id": conversation_id, "user_id": user.id, "message_id": message_id},
    }
    await manager.broadcast(_participant_ids(db, conversation_id), payload, exclude_user_id=user.id)


async def dispatch_event(db: Session, user: User, event: dict) -> None:
    event_type = event.get("type")
    data = event.get("data") or {}

    handlers = {
        "message.send": handle_message_send,
        "typing": handle_typing,
        "message.read": handle_message_read,
    }
    handler = handlers.get(event_type)
    if handler is None:
        await manager.send_to_user(
            user.id, {"type": "error", "data": {"message": f"Unknown event type: {event_type}"}}
        )
        return

    await handler(db, user, data)


def _peer_ids(db: Session, user_id: int) -> list[int]:
    conversation_ids = db.query(ConversationParticipant.conversation_id).filter(
        ConversationParticipant.user_id == user_id
    )
    rows = (
        db.query(ConversationParticipant.user_id)
        .filter(
            ConversationParticipant.conversation_id.in_(conversation_ids),
            ConversationParticipant.user_id != user_id,
        )
        .distinct()
        .all()
    )
    return [row[0] for row in rows]


async def mark_online(db: Session, user: User) -> None:
    db_user = db.get(User, user.id)
    db_user.status = "online"
    db.commit()
    payload = {"type": "presence", "data": {"user_id": user.id, "status": "online"}}
    await manager.broadcast(_peer_ids(db, user.id), payload)


async def mark_offline(db: Session, user: User) -> None:
    db_user = db.get(User, user.id)
    db_user.status = "offline"
    db_user.last_seen_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    payload = {"type": "presence", "data": {"user_id": user.id, "status": "offline"}}
    await manager.broadcast(_peer_ids(db, user.id), payload)
