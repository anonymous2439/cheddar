from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class WalletOut(BaseModel):
    user_id: int
    coins: int
    # Computed, not stored — whether 24h has passed since last_claimed_at
    # (or the user has never claimed at all). Server-computed so clients
    # never have to reason about clock skew or the naive-datetime-needs-a-
    # timezone gotcha themselves.
    daily_bonus_available: bool = False


class RaceCreate(BaseModel):
    lobby_id: int


class BetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    race_id: int
    user_id: int
    racer_name: str
    wager: int
    payout: int | None
    created_at: datetime


class RaceStepOut(BaseModel):
    positions: dict[str, float]
    # Racers whose speed is currently at/above race.py's PEAK_SPEED_THRESHOLD
    # this step — i.e. shouting their signature move (see RaceOut.signature_moves
    # for the actual line). Not interpolated like positions are: it's a
    # discrete "yes/no right now" flag, so a client should read it off
    # whichever step index it's currently in, not blend it with neighbors.
    shouting: list[str]


class RaceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    lobby_id: int
    racer_names: list[str]
    status: str
    winning_name: str | None
    steps: list[RaceStepOut] | None
    # Every racer's catchphrase for this race's roster — derived from
    # racer_names, not stored, so clients never need their own hardcoded
    # name->line map (see Race.signature_moves).
    signature_moves: dict[str, str]
    # Fixed payout odds per racer, frozen at race creation (see
    # roster.compute_payout_multipliers) — a favorite pays less, a longshot
    # pays more, both derived from that racer's overall win/loss record.
    payout_multipliers: dict[str, float]
    created_by: int
    created_at: datetime
    betting_closes_at: datetime
    resolved_at: datetime | None


class BetCreate(BaseModel):
    racer_name: str
    wager: int = Field(gt=0)


class RaceResultOut(BaseModel):
    race: RaceOut
    standings: list[str]
    bets: list[BetOut]


class HallOfFameEntryOut(BaseModel):
    display_name: str
    racer_name: str
    wager: int
    payout: int
    created_at: datetime
