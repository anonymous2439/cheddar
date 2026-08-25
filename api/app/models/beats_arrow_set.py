from sqlalchemy import Column, DateTime, Enum, Integer, JSON, String
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class BeatsArrowSet(Base):
    """A pre-authored key-sequence for one round of Cheddar Beats. `sequence`
    is a JSON list of symbol strings (length == level) drawn from the mode's
    key alphabet (see beats.py's KEY_ALPHABET) that the player must press in
    order before the spacebar beat-press is judged. Seeded with
    placeholder/random data for now (see scripts/seed_beats_arrow_sets.py)."""

    __tablename__ = "beats_arrow_sets"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    level = Column(Integer, nullable=False)
    mode = Column(Enum("4key", "8key"), nullable=False)
    sequence = Column(JSON, nullable=False)
    move_name = Column(String(64), nullable=False)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
