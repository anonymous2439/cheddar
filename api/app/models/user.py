from sqlalchemy import Boolean, Column, DateTime, Enum, String
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class User(Base):
    __tablename__ = "users"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    username = Column(String(32), nullable=False, unique=True)
    email = Column(String(255), nullable=False, unique=True)
    password_hash = Column(String(255), nullable=False)
    display_name = Column(String(64), nullable=False)
    avatar_url = Column(String(255), nullable=True)
    status = Column(Enum("online", "offline", "away"), nullable=False, default="offline")
    last_seen_at = Column(DateTime, nullable=True)
    # A server-controlled account (currently just the Stockfish chess
    # opponent) — never logs in itself, just occupies a real
    # GameLobbyParticipant seat so the rest of the lobby/game machinery
    # (seat order, turn checks, participant list) works completely
    # unmodified for a "vs AI" game.
    is_bot = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
    deleted_at = Column(DateTime, nullable=True)
