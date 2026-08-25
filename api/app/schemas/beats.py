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


class BeatsAttemptAck(BaseModel):
    judgment: str
    points: int
    total_score: int


class BeatsStandingOut(BaseModel):
    lobby_id: int
    standings: list[BeatsStandingEntry]
