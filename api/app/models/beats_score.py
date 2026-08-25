from sqlalchemy import Column, DateTime, Enum, ForeignKey, Integer
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class BeatsScore(Base):
    """One player's judged result for one round (an "attempt" — complete the
    level's key sequence, then time the spacebar press against the sliding
    gauge). Rounds aren't synchronized across players — each player submits
    these at their own pace — so there's no note_index/barrier here, just an
    append-only log the leaderboard sums per user. The client is trusted for
    *timing* (only it knows the real input event time, same simplification
    every client-authoritative rhythm judgment makes); `points` is still
    looked up server-side from `judgment` (see beats.py's
    _POINTS_BY_JUDGMENT) rather than trusting a client-submitted score."""

    __tablename__ = "beats_scores"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    game_id = Column(BIGINT(unsigned=True), ForeignKey("beats_games.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    level = Column(Integer, nullable=False)
    judgment = Column(Enum("miss", "bad", "cool", "great", "perfect"), nullable=False)
    points = Column(Integer, nullable=False)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
