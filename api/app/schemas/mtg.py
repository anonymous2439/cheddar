from pydantic import BaseModel


class MtgDeckImportIn(BaseModel):
    decklist: str


class MtgDeckImportOut(BaseModel):
    card_count: int
    unresolved_names: list[str]


class MtgCardOut(BaseModel):
    id: str
    # None for a card in an opponent's hand, or a face-down battlefield
    # permanent viewed by anyone but its owner — the client renders a
    # card-back placeholder rather than the real name/image.
    name: str | None = None
    image_url: str | None = None
    tapped: bool = False
    counters: dict[str, int] = {}
    x: float = 0.5
    y: float = 0.5
    # Battlefield-only — always sent (even to non-owners, alongside a
    # nulled-out name/image) so the client can tell "hidden because it's
    # face-down" apart from "hidden because it's someone else's hand".
    face_down: bool = False


class MtgPlayerStateOut(BaseModel):
    user_id: int
    life: int
    library_count: int
    hand: list[MtgCardOut]
    battlefield: list[MtgCardOut]
    graveyard: list[MtgCardOut]
    exile: list[MtgCardOut]


class MtgStateOut(BaseModel):
    lobby_id: int
    turn_number: int
    active_user_id: int
    phase: str
    status: str
    winner_user_id: int | None
    # The fixed reference seat battlefield (x, y) coordinates are stored
    # relative to — the client rotates the whole board 180° when the
    # viewer isn't this player, so each player always sees their own side
    # at the bottom and the opponent's at the top, regardless of who
    # actually placed a given card.
    player1_user_id: int
    players: list[MtgPlayerStateOut]


class MtgMoveIn(BaseModel):
    instance_id: str
    # Whose zone this card lives in — not necessarily the acting player (an
    # opponent's removal/bounce spell moves a card between *its owner's*
    # zones, honor-system trusted the same as everything else here).
    owner_user_id: int
    from_zone: str
    to_zone: str
    x: float | None = None
    y: float | None = None
    # Only meaningful for hand -> battlefield (summoning) — whether to play
    # the card face-down (hidden from everyone but its owner) or face-up.
    face_down: bool = False


class MtgTapIn(BaseModel):
    instance_id: str
    owner_user_id: int
    tapped: bool


class MtgCounterIn(BaseModel):
    instance_id: str
    owner_user_id: int
    counter_type: str
    delta: int


class MtgLifeIn(BaseModel):
    target_user_id: int
    delta: int


class MtgDeckStatusEntry(BaseModel):
    user_id: int
    card_count: int


class MtgDeckStatusOut(BaseModel):
    players: list[MtgDeckStatusEntry]
