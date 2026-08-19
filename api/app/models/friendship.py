from sqlalchemy import Column, DateTime, Enum, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class Friendship(Base):
    __tablename__ = "friendships"
    __table_args__ = (UniqueConstraint("requester_id", "addressee_id", name="uq_friendships_pair"),)

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    requester_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    addressee_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    status = Column(Enum("pending", "accepted", "declined"), nullable=False, default="pending")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
    responded_at = Column(DateTime, nullable=True)
