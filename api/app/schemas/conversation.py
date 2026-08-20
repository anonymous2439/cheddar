from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.user import UserOut


class ConversationCreate(BaseModel):
    user_id: int


class ConversationInvite(BaseModel):
    user_id: int


class ConversationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    type: str
    name: str | None
    created_at: datetime
    updated_at: datetime
    participants: list[UserOut] = []
    last_message_id: int | None = None
    last_read_message_id: int | None = None


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    conversation_id: int
    sender_id: int
    type: str
    content: str | None
    metadata: dict | None = None
    reply_to_id: int | None
    edited_at: datetime | None
    created_at: datetime


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=8000)
    type: str = "text"
    reply_to_id: int | None = None
