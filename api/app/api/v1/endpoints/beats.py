import random
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.beats_arrow_set import BeatsArrowSet
from app.models.beats_game import BeatsGame
from app.models.beats_score import BeatsScore
from app.models.game_lobby import GameLobby
from app.models.game_lobby_participant import GameLobbyParticipant
from app.models.user import User
from app.schemas.beats import (
    BeatsAttemptAck,
    BeatsAttemptIn,
    BeatsRoundOut,
    BeatsSessionCreate,
    BeatsStandingEntry,
    BeatsStandingOut,
    BeatsStateOut,
)
from app.websocket.manager import manager

router = APIRouter()

# A few seconds' buffer between session creation and the shared match-clock
# anchor, so every participant's client has time to receive the
# beats.session_started broadcast and show a countdown before the 60s window
# actually starts — the same reasoning as Karirs' betting_closes_at anchor.
COUNTDOWN_SECONDS = 3
DEFAULT_DURATION_SECONDS = 60

_POINTS_BY_JUDGMENT = {"miss": 0, "bad": 10, "cool": 40, "great": 70, "perfect": 100}
_VALID_JUDGMENTS = set(_POINTS_BY_JUDGMENT)
_VALID_MODES = {"4key", "8key"}
# Host-selectable at session creation — "we show only a few beats like
# 80bpm up to 130bpm" from the original spec, now chosen rather than
# randomized. pulse_count is how many times the target circle's heartbeat
# glow pulses over one round's sweep.
_VALID_BPM = {80, 90, 100, 110, 120, 130}
_VALID_PULSE_COUNT = set(range(1, 11))

# The key alphabet a sequence's symbols are drawn from, per mode — matches
# what each frontend binds to actual keyboard keys. 8key is the 4 arrows
# plus the 4 diagonals, reachable from the numpad's navigation cluster with
# Num Lock off (7/9/1/3 send Home/PageUp/End/PageDown — the corners of the
# 7-8-9/4-5-6/1-2-3 grid, diagonal to the arrow keys at 8/4/6/2).
KEY_ALPHABET = {
    "4key": ["up", "down", "left", "right"],
    "8key": ["up", "down", "left", "right", "up_left", "up_right", "down_left", "down_right"],
}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _active_participants(db: Session, lobby_id: int) -> list[GameLobbyParticipant]:
    return (
        db.query(GameLobbyParticipant)
        .filter(GameLobbyParticipant.lobby_id == lobby_id, GameLobbyParticipant.left_at.is_(None))
        .order_by(GameLobbyParticipant.joined_at.asc())
        .all()
    )


def _get_lobby_or_404(db: Session, lobby_id: int) -> GameLobby:
    lobby = db.get(GameLobby, lobby_id)
    if lobby is None or lobby.game_key != "cheddar_beats":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cheddar Beats lobby not found")
    return lobby


def _require_participant(db: Session, lobby: GameLobby, user: User) -> None:
    ids = {p.user_id for p in _active_participants(db, lobby.id)}
    if user.id not in ids:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not a participant of this lobby")


def _require_leader(lobby: GameLobby, user: User) -> None:
    if lobby.leader_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the lobby leader can do this")


def _get_current_session(db: Session, lobby: GameLobby) -> BeatsGame | None:
    if lobby.started_at is None:
        return None
    return (
        db.query(BeatsGame)
        .filter(BeatsGame.lobby_id == lobby.id, BeatsGame.lobby_started_at == lobby.started_at)
        .first()
    )


def _standings_for(db: Session, game: BeatsGame, active_ids: set[int]) -> list[BeatsStandingEntry]:
    rows = (
        db.query(BeatsScore.user_id, BeatsScore.points)
        .filter(BeatsScore.game_id == game.id, BeatsScore.user_id.in_(active_ids))
        .all()
    )
    totals = {uid: 0 for uid in active_ids}
    for uid, points in rows:
        totals[uid] += points
    ranked = sorted(active_ids, key=lambda uid: (-totals[uid], uid))
    return [BeatsStandingEntry(user_id=uid, score=totals[uid], rank=i + 1) for i, uid in enumerate(ranked)]


def _serialize_state(db: Session, lobby: GameLobby, game: BeatsGame) -> BeatsStateOut:
    active_ids = {p.user_id for p in _active_participants(db, lobby.id)}
    return BeatsStateOut(
        lobby_id=game.lobby_id,
        mode=game.mode,
        bpm=game.bpm,
        pulse_count=game.pulse_count,
        started_at=game.started_at,
        duration_seconds=game.duration_seconds,
        standings=_standings_for(db, game, active_ids),
    )


@router.post("/{lobby_id}/session", response_model=BeatsStateOut)
async def create_session(
    lobby_id: int,
    payload: BeatsSessionCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Leader-only: called right after the generic lobby /start succeeds (so
    lobby.started_at is already set — that's the key this match gets scoped
    to, same as chess's lobby_started_at)."""
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    _require_leader(lobby, user)

    if lobby.status != "in_progress" or lobby.started_at is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Start the lobby before creating a Cheddar Beats match")
    if payload.mode not in _VALID_MODES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid mode")
    if payload.bpm not in _VALID_BPM:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid bpm")
    if payload.pulse_count not in _VALID_PULSE_COUNT:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid pulse_count")

    existing = _get_current_session(db, lobby)
    if existing is not None:
        return _serialize_state(db, lobby, existing)

    game = BeatsGame(
        lobby_id=lobby.id,
        lobby_started_at=lobby.started_at,
        mode=payload.mode,
        bpm=payload.bpm,
        pulse_count=payload.pulse_count,
        started_at=_now() + timedelta(seconds=COUNTDOWN_SECONDS),
        duration_seconds=DEFAULT_DURATION_SECONDS,
    )
    db.add(game)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        game = _get_current_session(db, lobby)
        if game is None:
            raise
        return _serialize_state(db, lobby, game)
    db.refresh(game)

    out = _serialize_state(db, lobby, game)
    participant_ids = [p.user_id for p in _active_participants(db, lobby.id)]
    await manager.broadcast(participant_ids, {"type": "beats.session_started", "data": out.model_dump(mode="json")})
    return out


@router.get("/{lobby_id}/state", response_model=BeatsStateOut)
def get_state(lobby_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)

    game = _get_current_session(db, lobby)
    if game is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "The host hasn't started a match yet")
    return _serialize_state(db, lobby, game)


@router.get("/{lobby_id}/round", response_model=BeatsRoundOut)
def get_round(
    lobby_id: int,
    level: int = Query(..., ge=1, le=9),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Fetches a fresh random key-sequence for the given level — called each
    time a player's own round progresses to a new level. Rounds aren't
    synchronized across players, so this is stateless: nothing is recorded
    here, only /attempt records anything."""
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)

    game = _get_current_session(db, lobby)
    if game is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "No match is currently running")
    if _now() > game.started_at + timedelta(seconds=game.duration_seconds):
        raise HTTPException(status.HTTP_409_CONFLICT, "This match has already ended")

    candidates = (
        db.query(BeatsArrowSet).filter(BeatsArrowSet.level == level, BeatsArrowSet.mode == game.mode).all()
    )
    if not candidates:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No sequences available for that level/mode yet")
    chosen = random.choice(candidates)
    return BeatsRoundOut(level=level, mode=game.mode, sequence=chosen.sequence, move_name=chosen.move_name)


@router.post("/{lobby_id}/attempt", response_model=BeatsAttemptAck)
async def submit_attempt(
    lobby_id: int,
    payload: BeatsAttemptIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Records this player's judgment for one round and immediately
    broadcasts the updated leaderboard to the whole lobby — no waiting for
    other players (unlike chess's move-by-move sync, rounds here aren't on a
    shared timeline, so there's nothing to barrier against)."""
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)

    game = _get_current_session(db, lobby)
    if game is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "No match is currently running")
    if _now() > game.started_at + timedelta(seconds=game.duration_seconds):
        raise HTTPException(status.HTTP_409_CONFLICT, "This match has already ended")
    if not 1 <= payload.level <= 9:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Level must be between 1 and 9")
    if payload.judgment not in _VALID_JUDGMENTS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid judgment")

    points = _POINTS_BY_JUDGMENT[payload.judgment]
    db.add(BeatsScore(game_id=game.id, user_id=user.id, level=payload.level, judgment=payload.judgment, points=points))
    db.commit()

    active_ids = {p.user_id for p in _active_participants(db, lobby.id)}
    standings = _standings_for(db, game, active_ids)
    total_score = next((s.score for s in standings if s.user_id == user.id), 0)

    out = BeatsStandingOut(lobby_id=lobby.id, standings=standings)
    await manager.broadcast(list(active_ids), {"type": "beats.standing", "data": out.model_dump(mode="json")})
    return BeatsAttemptAck(judgment=payload.judgment, points=points, total_score=total_score)
