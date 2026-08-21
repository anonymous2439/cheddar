import asyncio
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from jose import jwt
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.db import Base, SessionLocal, engine, get_db
from app.models import Bet, Race, Wallet
from app.race import compute_race
from app.roster import (
    compute_payout_multipliers,
    pick_racers,
    record_result,
    seed_roster_if_empty,
    speed_factor_for_multiplier,
)
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


def _finish_race(db: Session, race: Race) -> RaceResultOut:
    """Applies payouts and locks in the result. race.steps/winning_name are
    already known (set the moment betting closed) — this just needs to wait
    for the animation's natural duration to elapse before crediting wallets,
    so nobody can learn the outcome early by polling their balance instead
    of watching the race."""
    final_positions = race.steps[-1]["positions"] if race.steps else {}
    winner = race.winning_name
    standings = sorted(race.racer_names, key=lambda n: final_positions.get(n, 0), reverse=True)

    race.status = "resolved"
    race.resolved_at = _now()

    # Per-racer odds, frozen on the race at creation time (see
    # roster.compute_payout_multipliers) — exactly what bettors saw while
    # betting was open, so nothing shifts between what was shown and what
    # pays out. Falls back to the old flat shape only for a race created
    # before this column existed.
    multipliers = race.payout_multipliers or {}
    fallback_multiplier = (len(race.racer_names) - 1) * 0.9

    bets = db.query(Bet).filter(Bet.race_id == race.id).all()
    for bet in bets:
        if bet.racer_name == winner:
            multiplier = multipliers.get(bet.racer_name, fallback_multiplier)
            bet.payout = round(bet.wager * multiplier)
            wallet = _get_or_create_wallet(db, bet.user_id)
            wallet.coins += bet.payout
        else:
            bet.payout = 0

    record_result(db, race.racer_names, winner)

    db.commit()
    db.refresh(race)
    return RaceResultOut(race=race, standings=standings, bets=bets)


def _speed_factors_for_race(race: Race, db: Session) -> dict[str, float]:
    """Derives race.py's per-racer speed bias from this race's frozen payout
    odds (falling back to computing fresh odds for a race created before the
    payout_multipliers column existed, so an old in-flight race doesn't
    error out on the next restart)."""
    multipliers = race.payout_multipliers
    if not multipliers:
        multipliers = compute_payout_multipliers(db, list(race.racer_names))
    field_size = len(race.racer_names)
    return {name: speed_factor_for_multiplier(m, field_size) for name, m in multipliers.items()}


def _run_to_completion_now(db: Session, race: Race) -> RaceResultOut:
    """Used by the manual ops resolve endpoint, and to recover a race whose
    countdown already elapsed by the time we look at it (e.g. a process
    restart). Reuses race.steps if a race already got as far as "racing" —
    it was likely already shipped to a connected client, so recomputing here
    would resolve a *different* outcome than what they were shown. Only
    computes fresh steps for a race that never got that far."""
    if not race.steps:
        speed_factors = _speed_factors_for_race(race, db)
        steps, winner = compute_race(list(race.racer_names), speed_factors)
        race.status = "racing"
        race.winning_name = winner
        race.steps = steps
        db.commit()
        db.refresh(race)
    return _finish_race(db, race)


async def _run_race(race_id: int) -> None:
    with SessionLocal() as db:
        race = db.get(Race, race_id)
        if race is None or race.status != "betting_open":
            _scheduled.discard(race_id)
            return
        speed_factors = _speed_factors_for_race(race, db)
        steps, winner = compute_race(list(race.racer_names), speed_factors)
        race.status = "racing"
        race.winning_name = winner
        race.steps = steps
        db.commit()
        started_at = race.betting_closes_at

    # One shot, not one message per step — the client replays this locally,
    # timed off `started_at`, instead of waiting on a live push per tick.
    await race_sockets.broadcast(
        race_id,
        {
            "type": "steps",
            "steps": steps,
            "total_steps": len(steps),
            "started_at": started_at.isoformat() + "Z",
        },
    )

    # Still wait out the animation's real duration before paying anyone —
    # otherwise a wallet-balance poll would reveal the outcome before the
    # race visually finishes for anyone actually watching it.
    await asyncio.sleep(len(steps) * STEP_DELAY_SECONDS)

    with SessionLocal() as db:
        race = db.get(Race, race_id)
        result = _finish_race(db, race)
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
    await _post_race_replay_message(result.race)
    _scheduled.discard(race_id)


def _mint_cheddar_token(user_id: int) -> str:
    """Mints a token in exactly the shape Cheddar's own login issues (see
    api/app/core/security.py's create_access_token) — Cheddar's /games/*
    endpoints only check the signature and claims, not where the token came
    from, so this is enough to act as that user without a real login. Kept
    short-lived since it only needs to survive one immediate request."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "app": "karirs-service",
        "type": "access",
        "exp": now + timedelta(minutes=2),
        "iat": now,
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


async def _post_race_replay_message(race: RaceOut) -> None:
    """Posts a "watch the replay" system message into the lobby's own chat
    — not a separate feed, so a player doesn't have to go back to the game
    lobby just to see how the race went. Best-effort: a failed notification
    shouldn't break race resolution, it just means the chat doesn't get the
    button this time (the leader can still see the result in-game)."""
    token = _mint_cheddar_token(race.created_by)
    payload = {
        "content": f"\U0001f3c1 {race.winning_name} won the race! Tap below to watch a replay.",
        "action": "karirs_race_replay",
        "action_data": {"race_id": race.id, "winner": race.winning_name},
    }
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{settings.cheddar_api_base_url}/api/v1/games/lobbies/{race.lobby_id}/system-message",
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
            )
    except Exception:
        pass


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

    # Frozen now, while betting is still open — this is the one moment the
    # odds shown to bettors and the odds later used to pay them out are
    # guaranteed to be the exact same numbers.
    payout_multipliers = compute_payout_multipliers(db, racer_names)

    race = Race(
        lobby_id=payload.lobby_id,
        racer_names=racer_names,
        status="betting_open",
        created_by=user_id,
        betting_closes_at=_now() + timedelta(seconds=BETTING_SECONDS),
        payout_multipliers=payout_multipliers,
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


@app.get("/races/{race_id}", response_model=RaceOut)
def get_race(race_id: int, db: Session = Depends(get_db), _user_id: int = Depends(get_current_user_id)):
    """For replaying a specific past race — "current for this lobby" only
    ever gets the latest one, but a lobby can have many races over time
    (every restart deals a fresh one) and a replay button always points at
    one specific historical race by id."""
    race = db.get(Race, race_id)
    if race is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Race not found")
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
    """Sends at most two messages over a race's life: one
    {"type":"steps","steps":[...],"started_at":...} the instant betting
    closes (the whole precomputed animation, for a client to replay locally
    against `started_at`), then one {"type":"resolved",...} once payouts are
    applied. Connect any time — nothing is sent until betting closes. A
    client that connects after "steps" already fired won't get it over this
    socket; it should already have `race.steps` from its own REST fetch by
    then, so this is a supplement to that, not the only source of it."""
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
