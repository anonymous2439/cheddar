import asyncio
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.db import Base, SessionLocal, engine, get_db
from app.models import Bet, Race, Wallet
from app.race import TOTAL_STEPS, step_race
from app.roster import pick_racers, record_result, seed_roster_if_empty
from app.schemas import BetCreate, BetOut, RaceCreate, RaceOut, RaceResultOut, WalletOut
from app.security import decode_user_id, get_current_user_id

Base.metadata.create_all(bind=engine)

BETTING_SECONDS = 30
STEP_DELAY_SECONDS = 0.3

app = FastAPI(title="Karirs API")

# Same origins as the main Cheddar API — this is the second backend the web
# client talks to directly (vscode/mobile don't need CORS, they aren't
# browsers).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RaceConnectionManager:
    """Per-race websocket fanout for the live step-by-step animation. Nothing
    here is persisted — only the final result matters for the DB; the steps
    in between are ephemeral broadcast state."""

    def __init__(self) -> None:
        self._connections: dict[int, set[WebSocket]] = defaultdict(set)

    async def connect(self, race_id: int, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[race_id].add(websocket)

    def disconnect(self, race_id: int, websocket: WebSocket) -> None:
        self._connections[race_id].discard(websocket)
        if not self._connections[race_id]:
            del self._connections[race_id]

    async def broadcast(self, race_id: int, payload: dict) -> None:
        for websocket in list(self._connections.get(race_id, ())):
            try:
                await websocket.send_json(payload)
            except Exception:
                self.disconnect(race_id, websocket)


race_sockets = RaceConnectionManager()

# Tracks races with an auto-resolve timer or run already scheduled/in-flight,
# so two players opening the game at once don't double-schedule the same
# race.
_scheduled: set[int] = set()

# Sync endpoints (matching the main Cheddar API's own style) run in FastAPI's
# worker threadpool, which has no running event loop of its own — asyncio.
# create_task would fail there. The startup handler is async, so it's the one
# place we can reliably grab the *actual* loop asyncio is serving requests
# on, and hand background work to it from any thread.
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


def _finish_race(db: Session, race: Race, winner: str, final_positions: dict[str, float]) -> RaceResultOut:
    standings = sorted(race.racer_names, key=lambda n: final_positions.get(n, 0), reverse=True)

    race.status = "resolved"
    race.winning_name = winner
    race.resolved_at = _now()

    # Flat function of field size (no per-racer odds yet — later, once the
    # win/loss stats below are actually used to weight things) with a 10%
    # house edge, same shape as a fair pari-mutuel split minus the house cut.
    multiplier = (len(race.racer_names) - 1) * 0.9

    bets = db.query(Bet).filter(Bet.race_id == race.id).all()
    for bet in bets:
        if bet.racer_name == winner:
            bet.payout = round(bet.wager * multiplier)
            wallet = _get_or_create_wallet(db, bet.user_id)
            wallet.coins += bet.payout
        else:
            bet.payout = 0

    record_result(db, race.racer_names, winner)

    db.commit()
    db.refresh(race)
    return RaceResultOut(race=race, standings=standings, bets=bets)


def _run_to_completion_now(db: Session, race: Race) -> RaceResultOut:
    """Runs the whole race instantly with no broadcast/delay — used by the
    manual ops resolve endpoint, and to recover any race whose in-memory
    animation was lost to a process restart (can't resume mid-animation
    positions that were never persisted, so it just concludes)."""
    winner = None
    final_positions: dict[str, float] = {}
    for _step, positions, is_final, step_winner in step_race(list(race.racer_names)):
        if is_final:
            winner, final_positions = step_winner, positions
    return _finish_race(db, race, winner, final_positions)


async def _run_race(race_id: int) -> None:
    with SessionLocal() as db:
        race = db.get(Race, race_id)
        if race is None or race.status != "betting_open":
            _scheduled.discard(race_id)
            return
        race.status = "racing"
        db.commit()
        racer_names = list(race.racer_names)

    winner = None
    final_positions: dict[str, float] = {}
    for step, positions, is_final, step_winner in step_race(racer_names):
        await race_sockets.broadcast(
            race_id, {"type": "step", "step": step, "total_steps": TOTAL_STEPS, "positions": positions}
        )
        if is_final:
            winner, final_positions = step_winner, positions
        await asyncio.sleep(STEP_DELAY_SECONDS)

    with SessionLocal() as db:
        race = db.get(Race, race_id)
        result = _finish_race(db, race, winner, final_positions)
        pool = _pool_totals(db, race)
    # Never broadcast result.bets here — it carries each bet's user_id, and
    # this goes out to every connected watcher. Standings + aggregate pool
    # totals only, same privacy boundary as the /pool endpoint.
    await race_sockets.broadcast(
        race_id,
        {
            "type": "resolved",
            "race": result.race.model_dump(mode="json"),
            "standings": result.standings,
            "pool": pool,
        },
    )
    _scheduled.discard(race_id)


async def _delay_then_run(race_id: int, delay_seconds: float) -> None:
    await asyncio.sleep(max(delay_seconds, 0))
    await _run_race(race_id)


def _schedule_auto_resolve(race: Race) -> None:
    if race.id in _scheduled:
        return
    _scheduled.add(race.id)
    delay = (race.betting_closes_at - _now()).total_seconds()
    assert _loop is not None, "auto-resolve scheduled before app startup ran"
    asyncio.run_coroutine_threadsafe(_delay_then_run(race.id, delay), _loop)


@app.on_event("startup")
async def _on_startup() -> None:
    global _loop
    _loop = asyncio.get_running_loop()

    with SessionLocal() as db:
        seed_roster_if_empty(db)

        # A process restart (deploy, crash, pm2 restart) would otherwise
        # strand a race whose in-memory timer/animation got lost. A race
        # already "racing" can't resume its lost in-flight positions, so it
        # just gets concluded outright; a race still "betting_open" either
        # resolves immediately (if the deadline already passed) or gets
        # rescheduled for whatever time is left.
        for race in db.query(Race).filter(Race.status == "racing").all():
            _run_to_completion_now(db, race)

        for race in db.query(Race).filter(Race.status == "betting_open").all():
            if race.betting_closes_at <= _now():
                _scheduled.add(race.id)
                asyncio.create_task(_run_race(race.id))
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
        .filter(Race.lobby_id == payload.lobby_id, Race.status != "resolved")
        .order_by(Race.id.desc())
        .first()
    )
    if existing is not None:
        if existing.status == "betting_open":
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


def _pool_totals(db: Session, race: Race) -> dict[str, int]:
    """Aggregate coins wagered per racer — never who wagered them. Shared by
    the REST endpoint below and the race websocket's final broadcast, since
    that broadcast must never carry the raw per-user bets list."""
    totals = {name: 0 for name in race.racer_names}
    rows = (
        db.query(Bet.racer_name, func.sum(Bet.wager))
        .filter(Bet.race_id == race.id)
        .group_by(Bet.racer_name)
        .all()
    )
    for racer_name, total in rows:
        totals[racer_name] = int(total)
    return totals


@app.get("/races/{race_id}/pool", response_model=dict[str, int])
def get_pool(race_id: int, db: Session = Depends(get_db), _user_id: int = Depends(get_current_user_id)):
    race = db.get(Race, race_id)
    if race is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Race not found")
    return _pool_totals(db, race)


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
    """Not used by the normal flow (races run/resolve on their own, 30s after
    creation) — kept as an operational escape hatch for testing/ops. Runs
    the race to completion instantly, with no animation."""
    race = db.get(Race, race_id)
    if race is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Race not found")
    if race.status == "resolved":
        raise HTTPException(status.HTTP_409_CONFLICT, "Race already resolved")
    return _run_to_completion_now(db, race)


@app.websocket("/races/{race_id}/ws")
async def race_ws(websocket: WebSocket, race_id: int) -> None:
    """Streams {"type":"step",...} messages while the race runs, then one
    {"type":"resolved","data":RaceResultOut}. Connect any time after a race
    exists — nothing is sent until betting closes and it actually starts."""
    user_id = decode_user_id(websocket.query_params.get("token"))
    if user_id is None:
        await websocket.close(code=4401)
        return

    await race_sockets.connect(race_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        race_sockets.disconnect(race_id, websocket)
