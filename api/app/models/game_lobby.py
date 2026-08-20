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
    # Generated lazily on first request (see games.py get_invite_code), not at
    # creation — most lobbies are invited into directly by username and never
    # need one. Anyone holding the code can join without being friends with
    # anyone already there; that's the point of a shareable code as opposed
    # to the friend-gated /invite.
    invite_code = Column(String(12), nullable=True, unique=True)
    status = Column(Enum("waiting", "in_progress", "finished"), nullable=False, default="waiting")
    leader_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
    started_at = Column(DateTime, nullable=True)
