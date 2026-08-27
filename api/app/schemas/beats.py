from datetime import datetime

from pydantic import BaseModel


class BeatsSessionCreate(BaseModel):
    mode: str  # "4key" | "8key"
    bpm: int
    pulse_count: int


class BeatsStandingEntry(BaseModel):
    user_id: int
    score: int
    rank: int


class BeatsStateOut(BaseModel):
    lobby_id: int
    mode: str
    bpm: int
    pulse_count: int
    started_at: datetime
    duration_seconds: int
    standings: list[BeatsStandingEntry]


class BeatsRoundOut(BaseModel):
    level: int
    mode: str
    sequence: list[str]
    move_name: str


class BeatsAttemptIn(BaseModel):
    level: int
    judgment: str  # "miss" | "bad" | "cool" | "great" | "perfect"
    # Client-asserted, like `judgment` — the server trusts this the same
    # way (Reverse Mode is a player-toggled challenge with no server-side
    # state of its own), and just applies the fixed +10% bonus to whatever
    # it says.
    rev_active: bool = False


class BeatsAttemptAck(BaseModel):
    judgment: str
    points: int
    total_score: int
    # Consecutive-perfect streak length after this attempt (0 once broken).
    # The multiplier is this value once it reaches 2+ — a lone perfect (1)
    # scores at the normal, unmultiplied rate.
    chain: int
    # The actual effective multiplier applied to this attempt's points
    # (chain multiplier, times 1.1 on top if Reverse Mode was active) —
    # sent back so the client just displays it rather than recomputing.
    multiplier: float
    rev_active: bool


class BeatsStandingOut(BaseModel):
    lobby_id: int
    standings: list[BeatsStandingEntry]
