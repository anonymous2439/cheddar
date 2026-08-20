from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class WalletOut(BaseModel):
    user_id: int
    coins: int


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


class RaceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    lobby_id: int
    racer_names: list[str]
    status: str
    winning_name: str | None
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
