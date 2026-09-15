from sqlalchemy import BigInteger, Column, DateTime, Integer, String
from sqlalchemy.sql import func

from app.db import Base


class WorldChatMessage(Base):
    """Persisted chat log for GL Sims World — unlike GL Sims' own
    conversation_lines (a historical, pre-vetted LINE-chat export played
    back locally by each client), this is genuinely live chat between real
    connected people, so it has to actually be stored somewhere as it
    happens. Read back via GET /chat/recent so someone who just joined (or
    missed messages while away) can catch up — the live broadcast over the
    websocket is what keeps everyone already connected up to date after
    that.

    racer_name is whichever of the 25 racers this person had claimed at the
    time — not a persistent per-account identity the way user_id is (kept
    alongside purely for future moderation/reference, never shown to other
    players; only racer_name is ever displayed)."""

    __tablename__ = "world_chat_messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    racer_name = Column(String(64), nullable=False)
    user_id = Column(BigInteger, nullable=False)
    text = Column(String(500), nullable=False)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
