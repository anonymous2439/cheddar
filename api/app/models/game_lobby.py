from sqlalchemy import Column, DateTime, Enum, ForeignKey, String
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class GameLobby(Base):
    __tablename__ = "game_lobbies"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    conversation_id = Column(
        BIGINT(unsigned=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    game_key = Column(String(50), nullable=False)
    status = Column(Enum("waiting", "in_progress", "finished"), nullable=False, default="waiting")
    leader_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
    started_at = Column(DateTime, nullable=True)
