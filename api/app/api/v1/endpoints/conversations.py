import mimetypes
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.api.v1.endpoints.games import invite_to_lobby, leave_lobby
from app.core.config import settings
from app.db.session import get_db
from app.models.conversation import Conversation
from app.models.conversation_participant import ConversationParticipant
from app.models.friendship import Friendship
from app.models.game_lobby import GameLobby
from app.models.game_lobby_participant import GameLobbyParticipant
from app.models.message import Message
from app.models.user import User
from app.schemas.conversation import ConversationCreate, ConversationInvite, ConversationOut, MessageOut
from app.schemas.game import LobbyInvite
from app.schemas.user import UserOut
from app.websocket.manager import manager

router = APIRouter()

UPLOAD_DIR = Path(settings.upload_dir)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
MAX_UPLOAD_BYTES = settings.max_upload_size_mb * 1024 * 1024


def _serialize_message(message: Message) -> MessageOut:
    return MessageOut(
        id=message.id,
        conversation_id=message.conversation_id,
        sender_id=message.sender_id,
        type=message.type,
        content=message.content,
        metadata=message.metadata_,
        reply_to_id=message.reply_to_id,
        edited_at=message.edited_at,
        created_at=message.created_at,
    )


def _find_direct_conversation(db: Session, user_id: int, other_id: int) -> Conversation | None:
    user_conversation_ids = db.query(ConversationParticipant.conversation_id).filter(
        ConversationParticipant.user_id == user_id
    )
    return (
        db.query(Conversation)
        .join(ConversationParticipant)
        .filter(
            Conversation.type == "direct",
            Conversation.id.in_(user_conversation_ids),
            ConversationParticipant.user_id == other_id,
        )
        .first()
    )


def _serialize_conversations(
    db: Session, conversations: list[Conversation], viewer_id: int
) -> list[ConversationOut]:
    if not conversations:
        return []

    conversation_ids = [c.id for c in conversations]
    participant_rows = (
        db.query(ConversationParticipant.conversation_id, User)
        .join(User, User.id == ConversationParticipant.user_id)
        .filter(ConversationParticipant.conversation_id.in_(conversation_ids))
        .all()
    )
    participants_by_conversation: dict[int, list[User]] = {}
    for conversation_id, participant_user in participant_rows:
        participants_by_conversation.setdefault(conversation_id, []).append(participant_user)

    last_message_rows = (
        db.query(Message.conversation_id, func.max(Message.id))
        .filter(Message.conversation_id.in_(conversation_ids), Message.deleted_at.is_(None))
        .group_by(Message.conversation_id)
        .all()
    )
    last_message_by_conversation = {row[0]: row[1] for row in last_message_rows}

    viewer_participant_rows = (
        db.query(ConversationParticipant.conversation_id, ConversationParticipant.last_read_message_id)
        .filter(
            ConversationParticipant.conversation_id.in_(conversation_ids),
            ConversationParticipant.user_id == viewer_id,
        )
        .all()
    )
    last_read_by_conversation = {row[0]: row[1] for row in viewer_participant_rows}

    return [
        ConversationOut(
            id=c.id,
            type=c.type,
            name=c.name,
            created_at=c.created_at,
            updated_at=c.updated_at,
            participants=[UserOut.model_validate(u) for u in participants_by_conversation.get(c.id, [])],
            last_message_id=last_message_by_conversation.get(c.id),
            last_read_message_id=last_read_by_conversation.get(c.id),
        )
        for c in conversations
    ]


@router.post("", response_model=ConversationOut, status_code=201)
def create_conversation(
    payload: ConversationCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if payload.user_id == user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot start a conversation with yourself")

    other = db.get(User, payload.user_id)
    if other is None or other.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    existing = _find_direct_conversation(db, user.id, other.id)
    if existing is not None:
        return _serialize_conversations(db, [existing], user.id)[0]

    conversation = Conversation(type="direct", created_by=user.id)
    db.add(conversation)
    db.flush()

    db.add(ConversationParticipant(conversation_id=conversation.id, user_id=user.id))
    db.add(ConversationParticipant(conversation_id=conversation.id, user_id=other.id))
    db.commit()
    db.refresh(conversation)
    return _serialize_conversations(db, [conversation], user.id)[0]


@router.get("", response_model=list[ConversationOut])
def list_conversations(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    conversation_ids = db.query(ConversationParticipant.conversation_id).filter(
        ConversationParticipant.user_id == user.id, ConversationParticipant.left_at.is_(None)
    )
    conversations = (
        db.query(Conversation)
        .filter(Conversation.id.in_(conversation_ids))
        .order_by(Conversation.updated_at.desc())
        .all()
    )
    return _serialize_conversations(db, conversations, user.id)


@router.post("/{conversation_id}/leave", status_code=204)
async def leave_conversation(
    conversation_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    participant = (
        db.query(ConversationParticipant)
        .filter(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == user.id,
            ConversationParticipant.left_at.is_(None),
        )
        .first()
    )
    if participant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not a participant of this conversation")

    # A lobby's chat and its roster are two views of the same membership —
    # leaving one without the other would leave you ready/counted in the
    # lobby but deaf to its chat, or vice versa. Delegate so both stay in sync.
    lobby = db.query(GameLobby).filter(GameLobby.conversation_id == conversation_id).first()
    if lobby is not None:
        lobby_participant = (
            db.query(GameLobbyParticipant)
            .filter(
                GameLobbyParticipant.lobby_id == lobby.id,
                GameLobbyParticipant.user_id == user.id,
                GameLobbyParticipant.left_at.is_(None),
            )
            .first()
        )
        if lobby_participant is not None:
            await leave_lobby(lobby.id, db, user)
            return None

    participant.left_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    return None


@router.post("/{conversation_id}/invite", response_model=ConversationOut)
async def invite_to_conversation(
    conversation_id: int,
    payload: ConversationInvite,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    conversation = db.get(Conversation, conversation_id)
    if conversation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    if conversation.type != "group":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Only group chats support inviting more people")

    requester_participant = (
        db.query(ConversationParticipant)
        .filter(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == user.id,
            ConversationParticipant.left_at.is_(None),
        )
        .first()
    )
    if requester_participant is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not a participant of this conversation")

    # Same reasoning as leave: if this group chat backs a game lobby, route
    # through the lobby invite so friend/capacity checks and the lobby
    # roster stay consistent with who's actually in the chat.
    lobby = db.query(GameLobby).filter(GameLobby.conversation_id == conversation_id).first()
    if lobby is not None:
        await invite_to_lobby(lobby.id, LobbyInvite(user_id=payload.user_id), db, user)
        db.refresh(conversation)
        return _serialize_conversations(db, [conversation], user.id)[0]

    target = db.get(User, payload.user_id)
    if target is None or target.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    friendship = (
        db.query(Friendship)
        .filter(
            Friendship.status == "accepted",
            or_(
                (Friendship.requester_id == user.id) & (Friendship.addressee_id == target.id),
                (Friendship.requester_id == target.id) & (Friendship.addressee_id == user.id),
            ),
        )
        .first()
    )
    if friendship is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only invite friends")

    existing = (
        db.query(ConversationParticipant)
        .filter(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == target.id,
        )
        .first()
    )
    if existing is not None and existing.left_at is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "User is already in this chat")
    if existing is not None:
        existing.left_at = None
    else:
        db.add(ConversationParticipant(conversation_id=conversation_id, user_id=target.id))
    db.commit()
    db.refresh(conversation)

    out = _serialize_conversations(db, [conversation], user.id)[0]
    await manager.send_to_user(
        target.id, {"type": "conversation.invited", "data": out.model_dump(mode="json")}
    )
    return out


@router.get("/{conversation_id}/messages", response_model=list[MessageOut])
def get_messages(
    conversation_id: int,
    limit: int = 50,
    before_id: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    participant = (
        db.query(ConversationParticipant)
        .filter(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == user.id,
        )
        .first()
    )
    if participant is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not a participant of this conversation")

    query = db.query(Message).filter(
        Message.conversation_id == conversation_id, Message.deleted_at.is_(None)
    )
    if before_id is not None:
        query = query.filter(Message.id < before_id)

    messages = query.order_by(Message.id.desc()).limit(min(limit, 100)).all()
    return [_serialize_message(m) for m in reversed(messages)]


@router.post("/{conversation_id}/attachments", response_model=MessageOut, status_code=201)
async def upload_attachment(
    conversation_id: int,
    file: UploadFile = File(...),
    caption: str | None = Form(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    participant = (
        db.query(ConversationParticipant)
        .filter(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == user.id,
        )
        .first()
    )
    if participant is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not a participant of this conversation")

    contents = await file.read()
    if not contents:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Empty file")
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"File exceeds {settings.max_upload_size_mb}MB limit",
        )

    original_name = file.filename or "attachment"
    extension = Path(original_name).suffix.lower()
    stored_name = f"{uuid.uuid4().hex}{extension}"
    (UPLOAD_DIR / stored_name).write_bytes(contents)

    content_type = file.content_type or mimetypes.guess_type(original_name)[0] or "application/octet-stream"
    message_type = "image" if content_type.startswith("image/") else "file"

    message = Message(
        conversation_id=conversation_id,
        sender_id=user.id,
        type=message_type,
        content=caption,
        metadata_={
            "url": f"/uploads/{stored_name}",
            "filename": original_name,
            "size": len(contents),
            "mime_type": content_type,
        },
    )
    db.add(message)
    db.commit()
    db.refresh(message)

    out = _serialize_message(message)

    participant_ids = [
        row[0]
        for row in db.query(ConversationParticipant.user_id)
        .filter(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.left_at.is_(None),
        )
        .all()
    ]
    await manager.broadcast(participant_ids, {"type": "message.new", "data": out.model_dump(mode="json")})

    return out
