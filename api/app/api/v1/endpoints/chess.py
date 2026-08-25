import chess
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.chess_game import ChessGame
from app.models.game_lobby import GameLobby
from app.models.game_lobby_participant import GameLobbyParticipant
from app.models.user import User
from app.schemas.chess import ChessMoveIn, ChessStateOut
from app.websocket.manager import manager

router = APIRouter()


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
    return out


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
