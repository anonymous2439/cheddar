from sqlalchemy import CHAR, Column, DateTime, ForeignKey, String
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class ApiKey(Base):
    __tablename__ = "api_keys"

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    application_id = Column(BIGINT(unsigned=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False)
    key_prefix = Column(String(12), nullable=False)
    key_hash = Column(CHAR(64), nullable=False, unique=True)
    scopes = Column(String(255), nullable=True)
    last_used_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True)
    revoked_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
