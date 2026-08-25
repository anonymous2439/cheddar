from sqlalchemy import Column, DateTime, Enum, ForeignKey, Text, UniqueConstraint
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class ChessGame(Base):
    __tablename__ = "chess_games"
    __table_args__ = (UniqueConstraint("lobby_id", "lobby_started_at", name="uq_chess_games_lobby_session"),)

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    lobby_id = Column(BIGINT(unsigned=True), ForeignKey("game_lobbies.id", ondelete="CASCADE"), nullable=False)
    # Ties this row to one lobby "session" (one Start click) — a restart
    # bumps game_lobbies.started_at, so a fresh row gets created instead of
    # reusing a finished game's moves.
    lobby_started_at = Column(DateTime, nullable=False)
    white_user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    black_user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    # Space-separated UCI moves from the starting position (e.g. "e2e4 e7e5")
    # — replayed through python-chess on every read so check/checkmate/
    # stalemate/draw (incl. threefold repetition, which needs full history,
    # not just the current FEN) can always be recomputed from scratch.
    moves = Column(Text, nullable=False, default="")
    status = Column(
        Enum("in_progress", "checkmate", "stalemate", "draw", "resigned"),
        nullable=False,
        default="in_progress",
    )
    winner_user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
