from sqlalchemy import Column, DateTime, ForeignKey, JSON, Text, UniqueConstraint
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class MtgDeckImport(Base):
    """A player's most recently imported decklist for one lobby, stored
    before the match itself starts — there's no MtgGame row yet to hang it
    off, and unlike Beats' host-chosen bpm/mode (one value, chosen once at
    session creation), here *each* player submits their own independently,
    so it needs its own row per lobby+user rather than living in the
    session-start request."""

    __tablename__ = "mtg_deck_imports"
    __table_args__ = (UniqueConstraint("lobby_id", "user_id", name="uq_mtg_deck_imports_lobby_user"),)

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    lobby_id = Column(BIGINT(unsigned=True), ForeignKey("game_lobbies.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    decklist_text = Column(Text, nullable=False)
    # Resolved card templates ready to be copied into a fresh library at
    # session-start — {name, image_url, scryfall_id} per copy (quantity
    # already expanded), not yet shuffled or assigned per-instance ids.
    cards = Column(JSON, nullable=False, default=list)
    unresolved_names = Column(JSON, nullable=False, default=list)
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
