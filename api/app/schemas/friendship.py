from datetime import datetime

from pydantic import BaseModel

from app.schemas.user import UserOut


class FriendRequestCreate(BaseModel):
    user_id: int


class FriendRequestOut(BaseModel):
    id: int
    status: str
    direction: str
    user: UserOut
    created_at: datetime
    responded_at: datetime | None


class BlockCreate(BaseModel):
    user_id: int


class BlockOut(BaseModel):
    user: UserOut
    created_at: datetime
