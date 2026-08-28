from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.schemas.user import UserOut


class GameCatalogEntry(BaseModel):
    key: str
    name: str
    min_players: int
    max_players: int
    tracks_completion: bool = False
    # Which clients actually have a playable UI for this game — each client
    # filters its own "Host a game" list against this so it doesn't offer
    # to host something it can't render (e.g. Cheddar MTG is web-only for
    # now). A lobby for a game missing from the current client's platform
    # can still be joined/viewed (LobbyRoom falls back to a "not available
    # here" message) — this only gates *hosting a new one*.
    platforms: list[str] = ["web", "vscode"]


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
    # Display name for this lobby's chat — defaults to "{game_name} lobby"
    # at creation (see games.py's create_lobby) and is renameable by the
    # leader afterward (see rename_lobby); always populated, never null.
    name: str
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


class LobbyRename(BaseModel):
    name: str


class SystemMessageCreate(BaseModel):
    """A game module (any authenticated user, in practice a service-minted
    token acting on a game's behalf) reporting something into the lobby's
    own chat — e.g. Karirs posting a "watch the replay" button once a race
    resolves. `action` names what the client should render as a button;
    `action_data` is whatever that action needs (e.g. a race id)."""

    content: str
    action: str
    action_data: dict = {}
