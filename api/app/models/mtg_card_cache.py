from sqlalchemy import Column, DateTime, String, Text
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class MtgCardCache(Base):
    """Local cache of Scryfall name lookups, keyed by lowercased exact name —
    avoids re-hitting Scryfall's API for the same card on every deck import.
    Never expires; a printing's image/rules text doesn't change often
    enough to warrant TTL logic for a casual hobby tool."""

    __tablename__ = "mtg_card_cache"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    name_key = Column(String(190), nullable=False, unique=True)
    name = Column(String(190), nullable=False)
    scryfall_id = Column(String(36), nullable=False)
    image_url = Column(String(500), nullable=True)
    mana_cost = Column(String(100), nullable=True)
    type_line = Column(String(200), nullable=True)
    oracle_text = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
