from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.schemas.user import UserOut


class GameCatalogEntry(BaseModel):
    key: str
    name: str
    min_players: int
    max_players: int
    tracks_completion: bool = False


class LobbyParticipantOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user: UserOut
    is_ready: bool
    is_leader: bool
    joined_at: datetime


class LobbyOut(BaseModel):
    id: int
    conversation_id: int
    game_key: str
    game_name: str
    status: str
    leader_id: int | None
    invite_code: str | None = None
    participants: list[LobbyParticipantOut]
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None


class LobbyCreate(BaseModel):
    game_key: str


class LobbyInvite(BaseModel):
    user_id: int


class LobbyJoinByCode(BaseModel):
    invite_code: str


class LobbyReadyUpdate(BaseModel):
    is_ready: bool


class LobbyKick(BaseModel):
    user_id: int


class LobbyLeaderTransfer(BaseModel):
    user_id: int


class SystemMessageCreate(BaseModel):
    """A game module (any authenticated user, in practice a service-minted
    token acting on a game's behalf) reporting something into the lobby's
    own chat — e.g. Karirs posting a "watch the replay" button once a race
    resolves. `action` names what the client should render as a button;
    `action_data` is whatever that action needs (e.g. a race id)."""

    content: str
    action: str
    action_data: dict = {}
