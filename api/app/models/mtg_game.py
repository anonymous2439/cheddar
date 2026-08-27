from sqlalchemy import Column, DateTime, Enum, ForeignKey, Integer, UniqueConstraint
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base

# In table-order, one full turn cycle. Advancing off the end passes the
# turn to the other player and wraps back to "untap". Only "untap" (untap
# the new active player's permanents) and "draw" (their draw-for-turn,
# skipped on the very first turn of the match) are automated server-side —
# everything else is purely informational, the same "read the card and do
# what should be done" honor system as the rest of the board.
PHASES = [
    "untap",
    "upkeep",
    "draw",
    "main1",
    "combat_begin",
    "attackers",
    "blockers",
    "damage",
    "combat_end",
    "main2",
    "end",
    "cleanup",
]


class MtgGame(Base):
    __tablename__ = "mtg_games"
    __table_args__ = (UniqueConstraint("lobby_id", "lobby_started_at", name="uq_mtg_games_lobby_session"),)

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    lobby_id = Column(BIGINT(unsigned=True), ForeignKey("game_lobbies.id", ondelete="CASCADE"), nullable=False)
    # Ties this row to one lobby "session" (one Start click) — a restart
    # bumps game_lobbies.started_at, so a fresh row gets created instead of
    # reusing a finished match's board state.
    lobby_started_at = Column(DateTime, nullable=False)
    player1_user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    player2_user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    active_user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    turn_number = Column(Integer, nullable=False, default=1)
    phase = Column(Enum(*PHASES), nullable=False, default="untap")
    status = Column(Enum("in_progress", "finished"), nullable=False, default="in_progress")
    winner_user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
