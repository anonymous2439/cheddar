from sqlalchemy import CHAR, Column, DateTime, ForeignKey
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    application_id = Column(BIGINT(unsigned=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False)
    token_hash = Column(CHAR(64), nullable=False, unique=True)
    expires_at = Column(DateTime, nullable=False)
    revoked_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
