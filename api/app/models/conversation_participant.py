from sqlalchemy import Column, DateTime, Enum, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.sql import func

from app.db.base_class import Base


class ConversationParticipant(Base):
    __tablename__ = "conversation_participants"
    __table_args__ = (UniqueConstraint("conversation_id", "user_id", name="uq_participants_pair"),)

    id = Column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    conversation_id = Column(BIGINT(unsigned=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(BIGINT(unsigned=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role = Column(Enum("member", "admin"), nullable=False, default="member")
    last_read_message_id = Column(BIGINT(unsigned=True), ForeignKey("messages.id", ondelete="SET NULL"), nullable=True)
    muted_until = Column(DateTime, nullable=True)
    joined_at = Column(DateTime, nullable=False, server_default=func.now())
    left_at = Column(DateTime, nullable=True)
