from sqlalchemy import Column, DateTime, Enum, ForeignKey, Integer, UniqueConstraint
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class BeatsGame(Base):
    """One played match of Cheddar Beats behind a lobby — analogous to
    ChessGame. `lobby_started_at` scopes this row to one lobby "session" (one
    Start click), same reasoning as chess: a restart bumps
    game_lobbies.started_at, so a fresh row gets created instead of reusing a
    finished match's scores.

    Unlike chess, players don't share one synchronized timeline — each
    player independently cycles level 1→9→1... at their own pace within the
    same 60s window. `started_at` is still the shared match-clock anchor (set
    a few seconds in the future so every client can start its countdown
    together), and `duration_seconds` is how long the match runs — everyone's
    match ends at the same wall-clock moment even though each player's own
    round/level progress differs.

    `bpm` (gauge sweep speed) and `pulse_count` (how many times the target
    circle's heartbeat glow pulses per sweep) are host-chosen once at
    session creation and fixed for the whole match — no longer randomized
    per round the way they briefly were on BeatsArrowSet."""

    __tablename__ = "beats_games"
    __table_args__ = (UniqueConstraint("lobby_id", "lobby_started_at", name="uq_beats_games_lobby_session"),)

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    lobby_id = Column(BIGINT(unsigned=True), ForeignKey("game_lobbies.id", ondelete="CASCADE"), nullable=False)
    lobby_started_at = Column(DateTime, nullable=False)
    mode = Column(Enum("4key", "8key"), nullable=False)
    bpm = Column(Integer, nullable=False)
    pulse_count = Column(Integer, nullable=False)
    started_at = Column(DateTime, nullable=False)
    duration_seconds = Column(Integer, nullable=False, default=60)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
