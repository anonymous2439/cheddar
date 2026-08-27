from sqlalchemy import Column, DateTime, ForeignKey, Integer, JSON, UniqueConstraint
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class MtgPlayerState(Base):
    """One player's board state within one MtgGame. Each zone is a JSON list
    of card-instance dicts — {id, name, image_url, scryfall_id, tapped,
    counters, x, y} — where `id` is a per-match uuid so a specific physical
    card keeps its identity (position, tap state, counters) across zone
    moves rather than being re-identified by name. `library[0]` is the top
    of the deck; `graveyard`/`exile` are append-ordered (last item = most
    recently added)."""

    __tablename__ = "mtg_player_states"
    __table_args__ = (UniqueConstraint("game_id", "user_id", name="uq_mtg_player_states_game_user"),)

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    game_id = Column(BIGINT(unsigned=True), ForeignKey("mtg_games.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    life = Column(Integer, nullable=False, default=20)
    library = Column(JSON, nullable=False, default=list)
    hand = Column(JSON, nullable=False, default=list)
    battlefield = Column(JSON, nullable=False, default=list)
    graveyard = Column(JSON, nullable=False, default=list)
    exile = Column(JSON, nullable=False, default=list)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
