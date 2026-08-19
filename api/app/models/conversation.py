from sqlalchemy import Column, DateTime, Enum, ForeignKey, String
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    type = Column(Enum("direct", "group"), nullable=False, default="direct")
    name = Column(String(100), nullable=True)
    avatar_url = Column(String(255), nullable=True)
    created_by = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
