import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.db import Base, SessionLocal, engine, get_db
from app.models import Bet, Race, Wallet
from app.race import simulate_race
from app.roster import pick_racers, record_result, seed_roster_if_empty
from app.schemas import BetCreate, BetOut, RaceCreate, RaceOut, RaceResultOut, WalletOut
from app.security import get_current_user_id

Base.metadata.create_all(bind=engine)

BETTING_SECONDS = 30

app = FastAPI(title="Karirs API")

# Tracks in-process auto-resolve timers so a race never gets a second one
# scheduled on top of an existing one (e.g. two players opening the game at
# once both calling sync_race for the same still-open race).
_scheduled: set[int] = set()

# Sync endpoints (the rest of this API, matching the main Cheddar API's own
# style) run in FastAPI's worker threadpool, which has no running event loop
# of its own — asyncio.create_task would fail there. The startup handler is
# async, so it's the one place we can reliably grab the *actual* loop asyncio
# is serving requests on, and hand background timers to it from any thread.
_loop: asyncio.AbstractEventLoop | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _get_or_create_wallet(db: Session, user_id: int) -> Wallet:
    wallet = db.get(Wallet, user_id)
    if wallet is None:
        wallet = Wallet(user_id=user_id, coins=settings.starting_coins)
        db.add(wallet)
        db.commit()
        db.refresh(wallet)
    return wallet


def _do_resolve(db: Session, race: Race) -> RaceResultOut:
    result = simulate_race(race.racer_names)

    race.status = "resolved"
    race.winning_name = result["winner"]
    race.resolved_at = _now()

    # Flat function of field size (no per-racer odds yet — later, once the
    # win/loss stats below are actually used to weight things) with a 10%
    # house edge, same shape as a fair pari-mutuel split minus the house cut.
    multiplier = (len(race.racer_names) - 1) * 0.9

    bets = db.query(Bet).filter(Bet.race_id == race.id).all()
    for bet in bets:
        if bet.racer_name == result["winner"]:
            bet.payout = round(bet.wager * multiplier)
            wallet = _get_or_create_wallet(db, bet.user_id)
            wallet.coins += bet.payout
        else:
            bet.payout = 0

    record_result(db, race.racer_names, result["winner"])

    db.commit()
    db.refresh(race)
    return RaceResultOut(race=race, standings=result["standings"], bets=bets)


async def _auto_resolve_after(race_id: int, delay_seconds: float) -> None:
    await asyncio.sleep(max(delay_seconds, 0))
    with SessionLocal() as db:
        race = db.get(Race, race_id)
        if race is not None and race.status == "betting_open":
            _do_resolve(db, race)
    _scheduled.discard(race_id)


def _schedule_auto_resolve(race: Race) -> None:
    if race.id in _scheduled:
        return
    _scheduled.add(race.id)
    delay = (race.betting_closes_at - _now()).total_seconds()
    assert _loop is not None, "auto-resolve scheduled before app startup ran"
    asyncio.run_coroutine_threadsafe(_auto_resolve_after(race.id, delay), _loop)


@app.on_event("startup")
async def _on_startup() -> None:
    global _loop
    _loop = asyncio.get_running_loop()

    with SessionLocal() as db:
        seed_roster_if_empty(db)

        # A process restart (deploy, crash, pm2 restart) would otherwise
        # strand any race whose in-memory timer got lost mid-countdown.
        open_races = db.query(Race).filter(Race.status == "betting_open").all()
        for race in open_races:
            if race.betting_closes_at <= _now():
                _do_resolve(db, race)
            else:
                _schedule_auto_resolve(race)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/wallet", response_model=WalletOut)
def get_wallet(db: Session = Depends(get_db), user_id: int = Depends(get_current_user_id)):
    wallet = _get_or_create_wallet(db, user_id)
    return WalletOut(user_id=wallet.user_id, coins=wallet.coins)


@app.post("/races", response_model=RaceOut, status_code=201)
def create_race(
    payload: RaceCreate,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    # One lobby plays one race at a time — reuse whatever's still open
    # instead of creating a duplicate table every time a player reopens it.
    existing = (
        db.query(Race)
        .filter(Race.lobby_id == payload.lobby_id, Race.status == "betting_open")
        .order_by(Race.id.desc())
        .first()
    )
    if existing is not None:
        _schedule_auto_resolve(existing)
        return existing

    try:
        racer_names = pick_racers(db)
    except ValueError as err:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(err))

    race = Race(
        lobby_id=payload.lobby_id,
        racer_names=racer_names,
        status="betting_open",
        created_by=user_id,
        betting_closes_at=_now() + timedelta(seconds=BETTING_SECONDS),
    )
    db.add(race)
    db.commit()
    db.refresh(race)

    _schedule_auto_resolve(race)
    return race


@app.get("/races/lobby/{lobby_id}/current", response_model=RaceOut)
def get_current_race(lobby_id: int, db: Session = Depends(get_db), _user_id: int = Depends(get_current_user_id)):
    race = db.query(Race).filter(Race.lobby_id == lobby_id).order_by(Race.id.desc()).first()
    if race is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No race for this lobby yet")
    return race


@app.get("/races/{race_id}/pool", response_model=dict[str, int])
def get_pool(race_id: int, db: Session = Depends(get_db), _user_id: int = Depends(get_current_user_id)):
    """Aggregate coins wagered per racer — never who wagered them."""
    race = db.get(Race, race_id)
    if race is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Race not found")

    totals = {name: 0 for name in race.racer_names}
    rows = (
        db.query(Bet.racer_name, func.sum(Bet.wager))
        .filter(Bet.race_id == race_id)
        .group_by(Bet.racer_name)
        .all()
    )
    for racer_name, total in rows:
        totals[racer_name] = int(total)
    return totals


@app.get("/races/{race_id}/bets", response_model=list[BetOut])
def list_my_bets(race_id: int, db: Session = Depends(get_db), user_id: int = Depends(get_current_user_id)):
    """Only the caller's own bets — other players' bets are never exposed,
    by design (see /pool for the anonymized totals everyone can see)."""
    return (
        db.query(Bet)
        .filter(Bet.race_id == race_id, Bet.user_id == user_id)
        .order_by(Bet.id.asc())
        .all()
    )


@app.post("/races/{race_id}/bets", response_model=BetOut, status_code=201)
def place_bet(
    race_id: int,
    payload: BetCreate,
    db: Session = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
):
    race = db.get(Race, race_id)
    if race is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Race not found")
    if race.status != "betting_open" or _now() >= race.betting_closes_at:
        raise HTTPException(status.HTTP_409_CONFLICT, "Betting is closed for this race")
    if payload.racer_name not in race.racer_names:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown racer name")

    existing_bet = db.query(Bet).filter(Bet.race_id == race_id, Bet.user_id == user_id).first()
    if existing_bet is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Already bet on this race")

    wallet = _get_or_create_wallet(db, user_id)
    if wallet.coins < payload.wager:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Not enough coins")

    wallet.coins -= payload.wager
    bet = Bet(race_id=race_id, user_id=user_id, racer_name=payload.racer_name, wager=payload.wager)
    db.add(bet)
    db.commit()
    db.refresh(bet)
    return bet


@app.post("/races/{race_id}/resolve", response_model=RaceResultOut)
def resolve_race(race_id: int, db: Session = Depends(get_db), _user_id: int = Depends(get_current_user_id)):
    """Not used by the normal flow (races resolve on their own 30s after
    creation) — kept as an operational escape hatch for testing/ops."""
    race = db.get(Race, race_id)
    if race is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Race not found")
    if race.status != "betting_open":
        raise HTTPException(status.HTTP_409_CONFLICT, "Race already resolved")
    return _do_resolve(db, race)
