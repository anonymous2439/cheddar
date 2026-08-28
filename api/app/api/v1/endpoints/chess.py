from datetime import datetime, timezone

import chess
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_current_user
from app.api.v1.endpoints.games import _serialize_lobby
from app.core.chess_ai import compute_ai_move
from app.db.session import get_db
from app.models.chess_game import ChessGame
from app.models.game_lobby import GameLobby
from app.models.game_lobby_participant import GameLobbyParticipant
from app.models.message import Message
from app.models.user import User
from app.schemas.chess import ChessMoveIn, ChessStateOut, ChessVsAiIn
from app.schemas.game import LobbyOut
from app.websocket.handlers import _serialize_message
from app.websocket.manager import manager

router = APIRouter()

# Never a real login — a reserved, unique username identifies the single
# shared Stockfish opponent account (see _get_or_create_ai_user).
_AI_USERNAME = "cheddar_ai"
_AI_SKILL_MIN = 0
_AI_SKILL_MAX = 20


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
    if lobby is None or lobby.game_key != "chess":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Chess lobby not found")
    return lobby


def _require_participant(db: Session, lobby: GameLobby, user: User) -> None:
    ids = {p.user_id for p in _active_participants(db, lobby.id)}
    if user.id not in ids:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not a participant of this lobby")


def _get_or_create_ai_user(db: Session) -> User:
    bot = db.query(User).filter(User.username == _AI_USERNAME).first()
    if bot is not None:
        return bot
    bot = User(
        username=_AI_USERNAME,
        email="cheddar-ai@cheddar.internal",
        # Not a real bcrypt hash — "!" can never verify against any
        # password, same convention as a disabled Unix account. This user
        # never logs in; it only ever occupies a GameLobbyParticipant seat.
        password_hash="!",
        display_name="Cheddar AI",
        status="online",
        is_bot=True,
    )
    db.add(bot)
    db.commit()
    db.refresh(bot)
    return bot


def _get_or_create_game(db: Session, lobby: GameLobby, *, for_write: bool = False) -> ChessGame:
    # A lobby stays in "finished" (not reset to "waiting") once the game
    # concludes — the same status LobbyRoom uses to keep rendering the final
    # board instead of switching away, so reads need to work in that state
    # too. Only writes (moves/resign) require the game to still be live.
    if lobby.status == "waiting" or (for_write and lobby.status != "in_progress"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Chess isn't in progress for this lobby")

    game = (
        db.query(ChessGame)
        .filter(ChessGame.lobby_id == lobby.id, ChessGame.lobby_started_at == lobby.started_at)
        .first()
    )
    if game is not None:
        return game

    if lobby.status != "in_progress":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No chess game found for this lobby session")

    # Deterministic seat assignment: whoever's been in the lobby longest
    # plays white — same "first mover" rule every session, no coin flip UI.
    participants = _active_participants(db, lobby.id)
    if len(participants) < 2:
        raise HTTPException(status.HTTP_409_CONFLICT, "Chess needs exactly 2 players")

    game = ChessGame(
        lobby_id=lobby.id,
        lobby_started_at=lobby.started_at,
        white_user_id=participants[0].user_id,
        black_user_id=participants[1].user_id,
        moves="",
        status="in_progress",
    )
    db.add(game)
    try:
        db.commit()
    except IntegrityError:
        # Both players' clients fetch state the instant the lobby flips to
        # in_progress, so two near-simultaneous requests can both find "no
        # game yet" and both try to create the session's first row — only
        # one insert wins uq_chess_games_lobby_session. The loser just reads
        # back what the winner created instead of surfacing a 500.
        db.rollback()
        game = (
            db.query(ChessGame)
            .filter(ChessGame.lobby_id == lobby.id, ChessGame.lobby_started_at == lobby.started_at)
            .first()
        )
        if game is None:
            raise
        return game
    db.refresh(game)
    return game


def _board_for(game: ChessGame) -> chess.Board:
    board = chess.Board()
    for uci in game.moves.split():
        board.push_uci(uci)
    return board


def _board_and_san_for(game: ChessGame) -> tuple[chess.Board, list[str]]:
    # board.san(move) reads notation off the position *before* that move is
    # applied (disambiguating which piece moved needs the pre-move board),
    # so it has to be captured move-by-move during replay rather than
    # derived after the fact from the final board.
    board = chess.Board()
    sans = []
    for uci in game.moves.split():
        move = chess.Move.from_uci(uci)
        sans.append(board.san(move))
        board.push(move)
    return board, sans


def _parse_move_text(board: chess.Board, move_text: str) -> chess.Move:
    move_text = move_text.strip()
    try:
        return board.parse_san(move_text)
    except ValueError:
        pass
    try:
        move = chess.Move.from_uci(move_text)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Malformed move")
    if move not in board.legal_moves:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Illegal move")
    return move


def _serialize(game: ChessGame) -> ChessStateOut:
    board, sans = _board_and_san_for(game)
    return ChessStateOut(
        lobby_id=game.lobby_id,
        fen=board.fen(),
        moves=game.moves.split(),
        moves_san=sans,
        turn="white" if board.turn == chess.WHITE else "black",
        white_user_id=game.white_user_id,
        black_user_id=game.black_user_id,
        status=game.status,
        winner_user_id=game.winner_user_id,
        is_check=board.is_check(),
        ai_skill_level=game.ai_skill_level,
        created_at=game.created_at,
        updated_at=game.updated_at,
    )


def _apply_outcome(game: ChessGame, board: chess.Board, mover_id: int) -> None:
    outcome = board.outcome(claim_draw=True)
    if outcome is None:
        return
    if outcome.winner is None:
        game.status = "stalemate" if outcome.termination == chess.Termination.STALEMATE else "draw"
    else:
        game.status = "checkmate"
        game.winner_user_id = mover_id


async def _maybe_play_ai_move(db: Session, lobby: GameLobby, game: ChessGame) -> None:
    """Called right after a human's move — the bot has no websocket
    connection or turn timer of its own, so if it's now the bot's turn the
    server just computes and applies its reply inline, then broadcasts it
    exactly like a second human's move would be."""
    if game.status != "in_progress" or game.ai_skill_level is None:
        return
    board = _board_for(game)
    mover_id = game.white_user_id if board.turn == chess.WHITE else game.black_user_id
    mover = db.get(User, mover_id)
    if mover is None or not mover.is_bot:
        return

    ai_move = await run_in_threadpool(compute_ai_move, board, game.ai_skill_level)
    board.push(ai_move)
    game.moves = (game.moves + " " + ai_move.uci()).strip()
    _apply_outcome(game, board, mover_id)

    db.commit()
    db.refresh(game)

    out = _serialize(game)
    participant_ids = [p.user_id for p in _active_participants(db, lobby.id)]
    await manager.broadcast(participant_ids, {"type": "chess.move", "data": out.model_dump(mode="json")})


@router.get("/{lobby_id}/state", response_model=ChessStateOut)
def get_state(lobby_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    game = _get_or_create_game(db, lobby)
    return _serialize(game)


@router.post("/{lobby_id}/move", response_model=ChessStateOut)
async def make_move(
    lobby_id: int,
    payload: ChessMoveIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    game = _get_or_create_game(db, lobby, for_write=True)

    if game.status != "in_progress":
        raise HTTPException(status.HTTP_409_CONFLICT, "This game has already ended")

    board = _board_for(game)
    is_white_turn = board.turn == chess.WHITE
    mover_id = game.white_user_id if is_white_turn else game.black_user_id
    if user.id != mover_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "It's not your turn")

    move = _parse_move_text(board, payload.move)

    board.push(move)
    game.moves = (game.moves + " " + move.uci()).strip()
    _apply_outcome(game, board, user.id)

    db.commit()
    db.refresh(game)

    out = _serialize(game)
    participant_ids = [p.user_id for p in _active_participants(db, lobby.id)]
    await manager.broadcast(participant_ids, {"type": "chess.move", "data": out.model_dump(mode="json")})

    # If this move handed the turn to the bot, play its reply before
    # responding — the human's own client then sees both moves applied in
    # one round trip instead of waiting on a second websocket event.
    await _maybe_play_ai_move(db, lobby, game)
    return _serialize(game)


@router.post("/{lobby_id}/vs-ai", response_model=LobbyOut)
async def play_vs_ai(
    lobby_id: int,
    payload: ChessVsAiIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Leader-only, solo-lobby-only: fills the second seat with the shared
    Stockfish bot account and starts the game immediately — there's no
    second human to wait on ready-up for, so this skips straight past the
    generic lobby /start flow instead of requiring it first."""
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    if lobby.leader_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the lobby leader can do this")
    if lobby.status != "waiting":
        raise HTTPException(status.HTTP_409_CONFLICT, "Lobby already started")
    if not _AI_SKILL_MIN <= payload.skill_level <= _AI_SKILL_MAX:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Skill level must be between {_AI_SKILL_MIN} and {_AI_SKILL_MAX}")

    participants = _active_participants(db, lobby.id)
    if len(participants) != 1:
        raise HTTPException(status.HTTP_409_CONFLICT, "Playing vs AI requires a solo lobby — no other players joined")

    bot = _get_or_create_ai_user(db)
    db.add(GameLobbyParticipant(lobby_id=lobby.id, user_id=bot.id, is_ready=True))

    lobby.status = "in_progress"
    lobby.started_at = _now()

    game = ChessGame(
        lobby_id=lobby.id,
        lobby_started_at=lobby.started_at,
        white_user_id=user.id,
        black_user_id=bot.id,
        moves="",
        status="in_progress",
        ai_skill_level=payload.skill_level,
    )
    db.add(game)

    message = Message(
        conversation_id=lobby.conversation_id,
        sender_id=user.id,
        type="system",
        content=f"♟️ Chess vs AI (skill {payload.skill_level}) has started!",
    )
    db.add(message)
    db.commit()
    db.refresh(lobby)
    db.refresh(game)
    db.refresh(message)

    participant_ids = [p.user_id for p in _active_participants(db, lobby.id)]
    await manager.broadcast(participant_ids, {"type": "message.new", "data": _serialize_message(message)})
    await manager.broadcast(
        participant_ids,
        {"type": "game.started", "data": {"lobby_id": lobby.id, "game_key": lobby.game_key, "game_name": "Chess"}},
    )
    return _serialize_lobby(db, lobby)


@router.post("/{lobby_id}/resign", response_model=ChessStateOut)
async def resign(lobby_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    game = _get_or_create_game(db, lobby, for_write=True)

    if game.status != "in_progress":
        raise HTTPException(status.HTTP_409_CONFLICT, "This game has already ended")
    if user.id not in (game.white_user_id, game.black_user_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You're not a player in this game")

    game.status = "resigned"
    game.winner_user_id = game.black_user_id if user.id == game.white_user_id else game.white_user_id
    db.commit()
    db.refresh(game)

    out = _serialize(game)
    participant_ids = [p.user_id for p in _active_participants(db, lobby.id)]
    await manager.broadcast(participant_ids, {"type": "chess.move", "data": out.model_dump(mode="json")})
    return out
