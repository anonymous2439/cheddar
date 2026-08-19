from sqlalchemy import Column, DateTime, Enum, ForeignKey, String, Text
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class Application(Base):
    __tablename__ = "applications"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    owner_user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    description = Column(Text, nullable=True)
    status = Column(Enum("active", "suspended", "revoked"), nullable=False, default="active")
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
