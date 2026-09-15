from datetime import datetime

from pydantic import BaseModel


class RacerStatus(BaseModel):
    name: str
    taken: bool
    taken_by: str | None = None


class ChatMessageOut(BaseModel):
    racer_name: str
    text: str
    created_at: datetime
