from sqlalchemy import Column, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class UserBlock(Base):
    __tablename__ = "user_blocks"
    __table_args__ = (UniqueConstraint("blocker_id", "blocked_id", name="uq_user_blocks_pair"),)

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    blocker_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    blocked_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
