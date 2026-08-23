from sqlalchemy import BigInteger, Column, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.dialects.mysql import JSON
from sqlalchemy.orm import object_session
from sqlalchemy.sql import func

from app.db import Base


class Wallet(Base):
    __tablename__ = "wallets"

    # No cross-database FK to cheddar.users — user_id is just the "sub" claim
    # from the Cheddar-issued JWT, trusted because we verify it with the same
    # secret Cheddar signs with.
    user_id = Column(BigInteger, primary_key=True)
    coins = Column(BigInteger, nullable=False, default=500)
    # When the daily 250-coin bonus was last claimed — null means never.
    # Claiming is only allowed once DAILY_BONUS_INTERVAL has passed since
    # this (see main.py's _daily_bonus_available).
    last_claimed_at = Column(DateTime, nullable=True)
    # When the "your daily bonus is ready" chat reminder was last posted —
    # separate from last_claimed_at so re-entering the game (or vscode's
    # periodic re-sync during betting) doesn't repost the same reminder
    # every time; only a *new* claim window (one that opened after this
    # timestamp) triggers another one.
    daily_bonus_notified_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())


class Racer(Base):
    """The preset roster — betting doesn't depend on who's in the lobby, it
    depends on this. wins/losses/races_run are recorded after every race so
    race outcomes and payouts can be weighted by a racer's track record (see
    roster.compute_payout_multipliers). signature_move is the catchphrase
    they shout at peak speed (race.py's PEAK_SPEED_THRESHOLD) — stored here
    (not hardcoded per-client) so web/vscode/the PowerShell client all read
    the exact same line straight off the race API response, and it can be
    edited without redeploying any client."""

    __tablename__ = "racers"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(64), nullable=False, unique=True)
    wins = Column(Integer, nullable=False, default=0)
    losses = Column(Integer, nullable=False, default=0)
    races_run = Column(Integer, nullable=False, default=0)
    signature_move = Column(String(128), nullable=True)


class Race(Base):
    __tablename__ = "races"

    id = Column(Integer, primary_key=True, autoincrement=True)
    lobby_id = Column(BigInteger, nullable=False)
    racer_names = Column(JSON, nullable=False)
    status = Column(Enum("betting_open", "racing", "resolved"), nullable=False, default="betting_open")
    winning_name = Column(String(64), nullable=True)
    # The whole race, precomputed the instant betting closes (index 0 = step
    # 1) — clients replay it locally against betting_closes_at as the anchor
    # instead of us live-broadcasting one step at a time.
    steps = Column(JSON, nullable=True)
    # Frozen at race creation (see roster.compute_payout_multipliers) so the
    # odds a bettor saw before wagering are exactly what pays out later, even
    # if the racers' overall stats move on in the meantime.
    payout_multipliers = Column(JSON, nullable=True)
    created_by = Column(BigInteger, nullable=False)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    betting_closes_at = Column(DateTime, nullable=False)
    resolved_at = Column(DateTime, nullable=True)

    @property
    def signature_moves(self) -> dict[str, str]:
        """Every racer's catchphrase for THIS race's roster, read straight
        off their Racer row — object_session finds the same Session this
        Race was loaded through (still open for the life of the request),
        so this doesn't need its own db argument threaded in from every
        caller. Falls back to a generic line only if a racer somehow has
        none set (or the session is unexpectedly gone) — not the normal
        case, every seeded racer has one."""
        session = object_session(self)
        by_name: dict[str, str] = {}
        if session is not None:
            rows = session.query(Racer).filter(Racer.name.in_(self.racer_names)).all()
            by_name = {r.name: r.signature_move for r in rows if r.signature_move}
        return {name: by_name.get(name, f"{name}'s Signature Move!") for name in self.racer_names}


class Bet(Base):
    __tablename__ = "bets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    race_id = Column(Integer, ForeignKey("races.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(BigInteger, nullable=False)
    racer_name = Column(String(64), nullable=False)
    wager = Column(BigInteger, nullable=False)
    payout = Column(BigInteger, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
