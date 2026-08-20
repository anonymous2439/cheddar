from sqlalchemy import Boolean, Column, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class GameLobbyParticipant(Base):
    __tablename__ = "game_lobby_participants"
    __table_args__ = (UniqueConstraint("lobby_id", "user_id", name="uq_lobby_participants_pair"),)

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    lobby_id = Column(BIGINT(unsigned=True), ForeignKey("game_lobbies.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    is_ready = Column(Boolean, nullable=False, default=False)
    joined_at = Column(DateTime, nullable=False, server_default=func.now())
    left_at = Column(DateTime, nullable=True)
