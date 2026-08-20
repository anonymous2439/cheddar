import secrets
import string
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.games_catalog import GAMES, GAMES_BY_KEY
from app.db.session import get_db
from app.models.conversation import Conversation
from app.models.conversation_participant import ConversationParticipant
from app.models.friendship import Friendship
from app.models.game_lobby import GameLobby
from app.models.game_lobby_participant import GameLobbyParticipant
from app.models.message import Message
from app.models.user import User
from app.schemas.game import (
    GameCatalogEntry,
    LobbyCreate,
    LobbyInvite,
    LobbyJoinByCode,
    LobbyKick,
    LobbyLeaderTransfer,
    LobbyOut,
    LobbyReadyUpdate,
)
from app.schemas.user import UserOut
from app.websocket.handlers import _serialize_message
from app.websocket.manager import manager

router = APIRouter()

_CODE_ALPHABET = string.ascii_uppercase + string.digits
_CODE_LENGTH = 6


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _active_participants(db: Session, lobby_id: int) -> list[GameLobbyParticipant]:
    return (
        db.query(GameLobbyParticipant)
        .filter(GameLobbyParticipant.lobby_id == lobby_id, GameLobbyParticipant.left_at.is_(None))
        .order_by(GameLobbyParticipant.joined_at.asc())
        .all()
    )


def _active_participant_ids(db: Session, lobby_id: int) -> list[int]:
    return [p.user_id for p in _active_participants(db, lobby_id)]


def _get_active_participant(db: Session, lobby_id: int, user_id: int) -> GameLobbyParticipant | None:
    return (
        db.query(GameLobbyParticipant)
        .filter(
            GameLobbyParticipant.lobby_id == lobby_id,
            GameLobbyParticipant.user_id == user_id,
            GameLobbyParticipant.left_at.is_(None),
        )
        .first()
    )


def _get_lobby_or_404(db: Session, lobby_id: int) -> GameLobby:
    lobby = db.get(GameLobby, lobby_id)
    if lobby is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Lobby not found")
    return lobby


def _require_participant(db: Session, lobby: GameLobby, user: User) -> GameLobbyParticipant:
    participant = _get_active_participant(db, lobby.id, user.id)
    if participant is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not a participant of this lobby")
    return participant


def _require_leader(lobby: GameLobby, user: User) -> None:
    if lobby.leader_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the lobby leader can do this")


def _serialize_lobby(db: Session, lobby: GameLobby) -> LobbyOut:
    participants = _active_participants(db, lobby.id)
    user_ids = [p.user_id for p in participants]
    users_by_id = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    game = GAMES_BY_KEY.get(lobby.game_key, {"name": lobby.game_key})

    return LobbyOut(
        id=lobby.id,
        conversation_id=lobby.conversation_id,
        game_key=lobby.game_key,
        game_name=game["name"],
        status=lobby.status,
        leader_id=lobby.leader_id,
        invite_code=lobby.invite_code,
        participants=[
            {
                "user": UserOut.model_validate(users_by_id[p.user_id]),
                "is_ready": p.is_ready,
                "is_leader": p.user_id == lobby.leader_id,
                "joined_at": p.joined_at,
            }
            for p in participants
            if p.user_id in users_by_id
        ],
        created_at=lobby.created_at,
        updated_at=lobby.updated_at,
        started_at=lobby.started_at,
    )


async def _broadcast_lobby(db: Session, lobby: GameLobby) -> None:
    payload = {"type": "lobby.updated", "data": _serialize_lobby(db, lobby).model_dump(mode="json")}
    await manager.broadcast(_active_participant_ids(db, lobby.id), payload)


def _find_or_create_direct_conversation(db: Session, user_a_id: int, user_b_id: int) -> Conversation:
    """A command-based /invite is delivered as a real message in the
    inviter/invitee's own DM — same conversation /add + messaging already
    use, found the same way conversations.py's own create_conversation does."""
    user_conversation_ids = db.query(ConversationParticipant.conversation_id).filter(
        ConversationParticipant.user_id == user_a_id
    )
    existing = (
        db.query(Conversation)
        .join(ConversationParticipant)
        .filter(
            Conversation.type == "direct",
            Conversation.id.in_(user_conversation_ids),
            ConversationParticipant.user_id == user_b_id,
        )
        .first()
    )
    if existing is not None:
        return existing

    conversation = Conversation(type="direct", created_by=user_a_id)
    db.add(conversation)
    db.flush()
    db.add(ConversationParticipant(conversation_id=conversation.id, user_id=user_a_id))
    db.add(ConversationParticipant(conversation_id=conversation.id, user_id=user_b_id))
    db.flush()
    return conversation


def _generate_invite_code(db: Session) -> str:
    for _ in range(10):
        code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LENGTH))
        if db.query(GameLobby).filter(GameLobby.invite_code == code).first() is None:
            return code
    raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Could not generate a unique invite code, try again")


@router.get("/catalog", response_model=list[GameCatalogEntry])
def list_games():
    return GAMES


@router.post("/lobbies", response_model=LobbyOut, status_code=201)
async def create_lobby(
    payload: LobbyCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    game = GAMES_BY_KEY.get(payload.game_key)
    if game is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown game")

    conversation = Conversation(type="group", name=f"{game['name']} lobby", created_by=user.id)
    db.add(conversation)
    db.flush()
    db.add(ConversationParticipant(conversation_id=conversation.id, user_id=user.id))

    lobby = GameLobby(
        conversation_id=conversation.id,
        game_key=game["key"],
        status="waiting",
        leader_id=user.id,
        created_by=user.id,
    )
    db.add(lobby)
    db.flush()
    db.add(GameLobbyParticipant(lobby_id=lobby.id, user_id=user.id, is_ready=False))
    db.commit()
    db.refresh(lobby)
    return _serialize_lobby(db, lobby)


@router.get("/lobbies", response_model=list[LobbyOut])
def list_my_lobbies(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    lobby_ids = db.query(GameLobbyParticipant.lobby_id).filter(
        GameLobbyParticipant.user_id == user.id, GameLobbyParticipant.left_at.is_(None)
    )
    lobbies = (
        db.query(GameLobby)
        .filter(GameLobby.id.in_(lobby_ids), GameLobby.status != "finished")
        .order_by(GameLobby.updated_at.desc())
        .all()
    )
    return [_serialize_lobby(db, lobby) for lobby in lobbies]


@router.get("/lobbies/{lobby_id}", response_model=LobbyOut)
def get_lobby(lobby_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    return _serialize_lobby(db, lobby)


@router.post("/lobbies/{lobby_id}/invite", response_model=LobbyOut)
async def invite_to_lobby(
    lobby_id: int,
    payload: LobbyInvite,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)

    if lobby.status != "waiting":
        raise HTTPException(status.HTTP_409_CONFLICT, "Lobby is no longer accepting players")

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

    if _get_active_participant(db, lobby.id, target.id) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "User is already in this lobby")

    game = GAMES_BY_KEY.get(lobby.game_key, {"max_players": 99})
    if len(_active_participants(db, lobby.id)) >= game.get("max_players", 99):
        raise HTTPException(status.HTTP_409_CONFLICT, "Lobby is full")

    conv_participant = (
        db.query(ConversationParticipant)
        .filter(
            ConversationParticipant.conversation_id == lobby.conversation_id,
            ConversationParticipant.user_id == target.id,
        )
        .first()
    )
    if conv_participant is not None:
        conv_participant.left_at = None
    else:
        db.add(ConversationParticipant(conversation_id=lobby.conversation_id, user_id=target.id))

    lobby_participant = (
        db.query(GameLobbyParticipant)
        .filter(GameLobbyParticipant.lobby_id == lobby.id, GameLobbyParticipant.user_id == target.id)
        .first()
    )
    if lobby_participant is not None:
        lobby_participant.left_at = None
        lobby_participant.is_ready = False
    else:
        db.add(GameLobbyParticipant(lobby_id=lobby.id, user_id=target.id, is_ready=False))

    # Delivered as a real message in the inviter/invitee's own DM, not just a
    # silent add + a log line — the invitee can click straight into the
    # lobby from their chat history, same as any other message.
    direct_conversation = _find_or_create_direct_conversation(db, user.id, target.id)
    invite_message = Message(
        conversation_id=direct_conversation.id,
        sender_id=user.id,
        type="lobby_invite",
        content=f"🎮 invited you to play {game.get('name', lobby.game_key)}",
        metadata_={"lobby_id": lobby.id, "game_key": lobby.game_key, "game_name": game.get("name", lobby.game_key)},
    )
    db.add(invite_message)

    db.commit()
    db.refresh(lobby)
    db.refresh(invite_message)

    out = _serialize_lobby(db, lobby)
    invite_message_out = _serialize_message(invite_message)
    await manager.broadcast([user.id, target.id], {"type": "message.new", "data": invite_message_out})
    await manager.send_to_user(target.id, {"type": "lobby.invited", "data": out.model_dump(mode="json")})
    await _broadcast_lobby(db, lobby)
    return out


@router.post("/lobbies/{lobby_id}/invite-code", response_model=LobbyOut)
def get_invite_code(lobby_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Anyone already in the lobby can pull its code to paste into any chat —
    unlike /invite, joining with it doesn't require being friends with
    anyone there first. Generated once and reused after that."""
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)

    if lobby.invite_code is None:
        lobby.invite_code = _generate_invite_code(db)
        db.commit()
        db.refresh(lobby)

    return _serialize_lobby(db, lobby)


@router.post("/lobbies/join", response_model=LobbyOut)
async def join_lobby_by_code(
    payload: LobbyJoinByCode,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    lobby = db.query(GameLobby).filter(GameLobby.invite_code == payload.invite_code.strip().upper()).first()
    if lobby is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invalid invite code")
    if lobby.status != "waiting":
        raise HTTPException(status.HTTP_409_CONFLICT, "Lobby is no longer accepting players")

    if _get_active_participant(db, lobby.id, user.id) is not None:
        return _serialize_lobby(db, lobby)

    game = GAMES_BY_KEY.get(lobby.game_key, {"max_players": 99})
    if len(_active_participants(db, lobby.id)) >= game.get("max_players", 99):
        raise HTTPException(status.HTTP_409_CONFLICT, "Lobby is full")

    conv_participant = (
        db.query(ConversationParticipant)
        .filter(
            ConversationParticipant.conversation_id == lobby.conversation_id,
            ConversationParticipant.user_id == user.id,
        )
        .first()
    )
    if conv_participant is not None:
        conv_participant.left_at = None
    else:
        db.add(ConversationParticipant(conversation_id=lobby.conversation_id, user_id=user.id))

    lobby_participant = (
        db.query(GameLobbyParticipant)
        .filter(GameLobbyParticipant.lobby_id == lobby.id, GameLobbyParticipant.user_id == user.id)
        .first()
    )
    if lobby_participant is not None:
        lobby_participant.left_at = None
        lobby_participant.is_ready = False
    else:
        db.add(GameLobbyParticipant(lobby_id=lobby.id, user_id=user.id, is_ready=False))

    db.commit()
    db.refresh(lobby)

    await _broadcast_lobby(db, lobby)
    return _serialize_lobby(db, lobby)


@router.post("/lobbies/{lobby_id}/ready", response_model=LobbyOut)
async def set_ready(
    lobby_id: int,
    payload: LobbyReadyUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    lobby = _get_lobby_or_404(db, lobby_id)
    participant = _require_participant(db, lobby, user)

    if lobby.status != "waiting":
        raise HTTPException(status.HTTP_409_CONFLICT, "Lobby is no longer accepting ready changes")

    participant.is_ready = payload.is_ready
    db.commit()

    await _broadcast_lobby(db, lobby)
    return _serialize_lobby(db, lobby)


@router.post("/lobbies/{lobby_id}/kick", response_model=LobbyOut)
async def kick_from_lobby(
    lobby_id: int,
    payload: LobbyKick,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    _require_leader(lobby, user)

    if payload.user_id == user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot kick yourself — use leave instead")

    target_participant = _get_active_participant(db, lobby.id, payload.user_id)
    if target_participant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User is not in this lobby")

    now = _now()
    target_participant.left_at = now
    conv_participant = (
        db.query(ConversationParticipant)
        .filter(
            ConversationParticipant.conversation_id == lobby.conversation_id,
            ConversationParticipant.user_id == payload.user_id,
        )
        .first()
    )
    if conv_participant is not None:
        conv_participant.left_at = now
    db.commit()

    await manager.send_to_user(payload.user_id, {"type": "lobby.kicked", "data": {"lobby_id": lobby.id}})
    await _broadcast_lobby(db, lobby)
    return _serialize_lobby(db, lobby)


@router.post("/lobbies/{lobby_id}/leader", response_model=LobbyOut)
async def transfer_leader(
    lobby_id: int,
    payload: LobbyLeaderTransfer,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    _require_leader(lobby, user)

    target_participant = _get_active_participant(db, lobby.id, payload.user_id)
    if target_participant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User is not in this lobby")

    lobby.leader_id = payload.user_id
    db.commit()

    await _broadcast_lobby(db, lobby)
    return _serialize_lobby(db, lobby)


@router.post("/lobbies/{lobby_id}/leave", response_model=LobbyOut)
async def leave_lobby(lobby_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    lobby = _get_lobby_or_404(db, lobby_id)
    participant = _require_participant(db, lobby, user)

    now = _now()
    participant.left_at = now
    conv_participant = (
        db.query(ConversationParticipant)
        .filter(
            ConversationParticipant.conversation_id == lobby.conversation_id,
            ConversationParticipant.user_id == user.id,
        )
        .first()
    )
    if conv_participant is not None:
        conv_participant.left_at = now

    remaining = [p for p in _active_participants(db, lobby.id) if p.user_id != user.id]
    if lobby.leader_id == user.id:
        lobby.leader_id = remaining[0].user_id if remaining else None
    if not remaining:
        lobby.status = "finished"
    db.commit()
    db.refresh(lobby)

    await _broadcast_lobby(db, lobby)
    return _serialize_lobby(db, lobby)


@router.post("/lobbies/{lobby_id}/start", response_model=LobbyOut)
async def start_lobby(lobby_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    _require_leader(lobby, user)

    if lobby.status != "waiting":
        raise HTTPException(status.HTTP_409_CONFLICT, "Lobby already started")

    participants = _active_participants(db, lobby.id)
    game = GAMES_BY_KEY.get(lobby.game_key, {"min_players": 1, "name": lobby.game_key})
    if len(participants) < game.get("min_players", 1):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Need at least {game.get('min_players', 1)} players to start")
    if not all(p.is_ready for p in participants):
        raise HTTPException(status.HTTP_409_CONFLICT, "All players must be ready to start")

    lobby.status = "in_progress"
    lobby.started_at = _now()

    message = Message(
        conversation_id=lobby.conversation_id,
        sender_id=user.id,
        type="system",
        content=f"\U0001f3ae {game.get('name', lobby.game_key)} has started!",
    )
    db.add(message)
    db.commit()
    db.refresh(lobby)
    db.refresh(message)

    participant_ids = _active_participant_ids(db, lobby.id)
    await manager.broadcast(participant_ids, {"type": "message.new", "data": _serialize_message(message)})
    await manager.broadcast(
        participant_ids,
        {
            "type": "game.started",
            "data": {"lobby_id": lobby.id, "game_key": lobby.game_key, "game_name": game.get("name", lobby.game_key)},
        },
    )
    return _serialize_lobby(db, lobby)


@router.post("/lobbies/{lobby_id}/restart", response_model=LobbyOut)
async def restart_lobby(lobby_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Leader-only: takes a lobby back to "waiting" after a game session so
    everyone can ready up and play again, without having to leave and
    re-invite everyone into a brand new lobby."""
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    _require_leader(lobby, user)

    if lobby.status != "in_progress":
        raise HTTPException(status.HTTP_409_CONFLICT, "Lobby isn't in a game right now")

    lobby.status = "waiting"
    lobby.started_at = None
    for participant in _active_participants(db, lobby.id):
        participant.is_ready = False

    game = GAMES_BY_KEY.get(lobby.game_key, {"name": lobby.game_key})
    message = Message(
        conversation_id=lobby.conversation_id,
        sender_id=user.id,
        type="system",
        content=f"\U0001f501 Back to the lobby — ready up to play {game.get('name', lobby.game_key)} again!",
    )
    db.add(message)
    db.commit()
    db.refresh(lobby)
    db.refresh(message)

    participant_ids = _active_participant_ids(db, lobby.id)
    await manager.broadcast(participant_ids, {"type": "message.new", "data": _serialize_message(message)})
    await _broadcast_lobby(db, lobby)
    return _serialize_lobby(db, lobby)
