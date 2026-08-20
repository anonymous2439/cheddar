from sqlalchemy import BigInteger, Column, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.dialects.mysql import JSON
from sqlalchemy.sql import func

from app.db import Base


class Wallet(Base):
    __tablename__ = "wallets"

    # No cross-database FK to cheddar.users — user_id is just the "sub" claim
    # from the Cheddar-issued JWT, trusted because we verify it with the same
    # secret Cheddar signs with.
    user_id = Column(BigInteger, primary_key=True)
    coins = Column(BigInteger, nullable=False, default=500)
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())


class Racer(Base):
    """The preset roster — betting doesn't depend on who's in the lobby, it
    depends on this. wins/losses/races_run aren't shown anywhere yet; they're
    recorded after every race so a later change can weight race outcomes by
    a racer's track record."""

    __tablename__ = "racers"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(64), nullable=False, unique=True)
    wins = Column(Integer, nullable=False, default=0)
    losses = Column(Integer, nullable=False, default=0)
    races_run = Column(Integer, nullable=False, default=0)


class Race(Base):
    __tablename__ = "races"

    id = Column(Integer, primary_key=True, autoincrement=True)
    lobby_id = Column(BigInteger, nullable=False)
    racer_names = Column(JSON, nullable=False)
    status = Column(Enum("betting_open", "racing", "resolved"), nullable=False, default="betting_open")
    winning_name = Column(String(64), nullable=True)
    created_by = Column(BigInteger, nullable=False)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    betting_closes_at = Column(DateTime, nullable=False)
    resolved_at = Column(DateTime, nullable=True)


class Bet(Base):
    __tablename__ = "bets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    race_id = Column(Integer, ForeignKey("races.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(BigInteger, nullable=False)
    racer_name = Column(String(64), nullable=False)
    wager = Column(BigInteger, nullable=False)
    payout = Column(BigInteger, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
