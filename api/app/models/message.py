from sqlalchemy import Column, DateTime, Enum, ForeignKey, Index, Text
from sqlalchemy.dialects.mysql import BIGINT, JSON
from sqlalchemy.sql import func

from app.db.base_class import Base


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (Index("idx_messages_conversation_created", "conversation_id", "created_at"),)

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    conversation_id = Column(BIGINT(unsigned=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    sender_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    type = Column(Enum("text", "image", "file", "system"), nullable=False, default="text")
    content = Column(Text, nullable=True)
    metadata_ = Column("metadata", JSON, nullable=True)
    reply_to_id = Column(BIGINT(unsigned=True), ForeignKey("messages.id", ondelete="SET NULL"), nullable=True)
    edited_at = Column(DateTime, nullable=True)
    deleted_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
