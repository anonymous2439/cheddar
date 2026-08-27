import random
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.mtg_cards import parse_decklist, resolve_decklist
from app.db.session import get_db
from app.models.game_lobby import GameLobby
from app.models.game_lobby_participant import GameLobbyParticipant
from app.models.mtg_deck_import import MtgDeckImport
from app.models.mtg_game import PHASES, MtgGame
from app.models.mtg_player_state import MtgPlayerState
from app.models.user import User
from app.schemas.mtg import (
    MtgCardOut,
    MtgCounterIn,
    MtgDeckImportIn,
    MtgDeckImportOut,
    MtgDeckStatusEntry,
    MtgDeckStatusOut,
    MtgLifeIn,
    MtgMoveIn,
    MtgPlayerStateOut,
    MtgStateOut,
    MtgTapIn,
)
from app.websocket.manager import manager

router = APIRouter()

ZONES = {"library", "hand", "battlefield", "graveyard", "exile"}
OPENING_HAND_SIZE = 7


def _active_participants(db: Session, lobby_id: int) -> list[GameLobbyParticipant]:
    return (
        db.query(GameLobbyParticipant)
        .filter(GameLobbyParticipant.lobby_id == lobby_id, GameLobbyParticipant.left_at.is_(None))
        .order_by(GameLobbyParticipant.joined_at.asc())
        .all()
    )


def _get_lobby_or_404(db: Session, lobby_id: int) -> GameLobby:
    lobby = db.get(GameLobby, lobby_id)
    if lobby is None or lobby.game_key != "cheddar_mtg":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cheddar MTG lobby not found")
    return lobby


def _require_participant(db: Session, lobby: GameLobby, user: User) -> None:
    ids = {p.user_id for p in _active_participants(db, lobby.id)}
    if user.id not in ids:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not a participant of this lobby")


def _require_leader(lobby: GameLobby, user: User) -> None:
    if lobby.leader_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the lobby leader can do this")


def _get_current_game(db: Session, lobby: GameLobby) -> MtgGame | None:
    if lobby.started_at is None:
        return None
    return db.query(MtgGame).filter(MtgGame.lobby_id == lobby.id, MtgGame.lobby_started_at == lobby.started_at).first()


def _get_game_or_404(db: Session, lobby: GameLobby) -> MtgGame:
    game = _get_current_game(db, lobby)
    if game is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No Cheddar MTG match found for this lobby session")
    return game


def _require_in_progress(game: MtgGame) -> None:
    if game.status != "in_progress":
        raise HTTPException(status.HTTP_409_CONFLICT, "This match has already ended")


def _get_player_state(db: Session, game: MtgGame, user_id: int) -> MtgPlayerState:
    state = (
        db.query(MtgPlayerState).filter(MtgPlayerState.game_id == game.id, MtgPlayerState.user_id == user_id).first()
    )
    if state is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No board state for that player")
    return state


def _zone_list(state: MtgPlayerState, zone: str) -> list[dict]:
    if zone not in ZONES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Invalid zone: {zone}")
    return list(getattr(state, zone))


def _set_zone(state: MtgPlayerState, zone: str, cards: list[dict]) -> None:
    setattr(state, zone, cards)


def _serialize_card(card: dict, *, reveal: bool) -> MtgCardOut:
    return MtgCardOut(
        id=card["id"],
        name=card["name"] if reveal else None,
        image_url=card["image_url"] if reveal else None,
        tapped=card.get("tapped", False),
        counters=card.get("counters", {}),
        x=card.get("x", 0.5),
        y=card.get("y", 0.5),
        face_down=card.get("face_down", False),
    )


def _serialize_player_state(state: MtgPlayerState, viewer_id: int) -> MtgPlayerStateOut:
    is_owner = state.user_id == viewer_id
    return MtgPlayerStateOut(
        user_id=state.user_id,
        life=state.life,
        library_count=len(state.library),
        hand=[_serialize_card(c, reveal=is_owner) for c in state.hand],
        # A face-down permanent is only revealed to its own owner — anyone
        # else just sees that a card is there, not what it is (graveyard/
        # exile stay always-public, same as before).
        battlefield=[_serialize_card(c, reveal=is_owner or not c.get("face_down", False)) for c in state.battlefield],
        graveyard=[_serialize_card(c, reveal=True) for c in state.graveyard],
        exile=[_serialize_card(c, reveal=True) for c in state.exile],
    )


def _serialize_state_for(db: Session, lobby: GameLobby, game: MtgGame, viewer_id: int) -> MtgStateOut:
    states = db.query(MtgPlayerState).filter(MtgPlayerState.game_id == game.id).all()
    return MtgStateOut(
        lobby_id=lobby.id,
        turn_number=game.turn_number,
        active_user_id=game.active_user_id,
        phase=game.phase,
        status=game.status,
        winner_user_id=game.winner_user_id,
        player1_user_id=game.player1_user_id,
        players=[_serialize_player_state(s, viewer_id) for s in states],
    )


async def _broadcast_state(db: Session, lobby: GameLobby, game: MtgGame) -> None:
    # Each participant gets their OWN filtered view (their hand revealed,
    # the other's hidden) — unlike Beats/Chess's single shared broadcast,
    # this can't be one payload for everyone.
    for uid in {p.user_id for p in _active_participants(db, lobby.id)}:
        out = _serialize_state_for(db, lobby, game, uid)
        await manager.send_to_user(uid, {"type": "mtg.state", "data": out.model_dump(mode="json")})


@router.post("/{lobby_id}/deck", response_model=MtgDeckImportOut)
async def import_deck(
    lobby_id: int,
    payload: MtgDeckImportIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)

    entries = parse_decklist(payload.decklist)
    if not entries:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Couldn't find any cards in that decklist")
    cards, unresolved = await resolve_decklist(db, entries)
    if not cards:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "None of those cards could be found on Scryfall")

    existing = (
        db.query(MtgDeckImport).filter(MtgDeckImport.lobby_id == lobby.id, MtgDeckImport.user_id == user.id).first()
    )
    if existing is None:
        existing = MtgDeckImport(lobby_id=lobby.id, user_id=user.id, decklist_text=payload.decklist)
        db.add(existing)
    existing.decklist_text = payload.decklist
    existing.cards = cards
    existing.unresolved_names = unresolved
    db.commit()
    return MtgDeckImportOut(card_count=len(cards), unresolved_names=unresolved)


@router.get("/{lobby_id}/deck-status", response_model=MtgDeckStatusOut)
def deck_status(lobby_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    participants = _active_participants(db, lobby.id)
    imports = {d.user_id: d for d in db.query(MtgDeckImport).filter(MtgDeckImport.lobby_id == lobby.id).all()}
    return MtgDeckStatusOut(
        players=[
            MtgDeckStatusEntry(user_id=p.user_id, card_count=len(imports[p.user_id].cards) if p.user_id in imports else 0)
            for p in participants
        ]
    )


@router.post("/{lobby_id}/session", response_model=MtgStateOut)
async def create_session(lobby_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Leader-only: called right after the generic lobby /start succeeds
    (mirrors beats.py/chess.py's lazy per-session setup)."""
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    _require_leader(lobby, user)

    if lobby.status != "in_progress" or lobby.started_at is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Start the lobby before creating a Cheddar MTG match")

    existing = _get_current_game(db, lobby)
    if existing is not None:
        return _serialize_state_for(db, lobby, existing, user.id)

    participants = _active_participants(db, lobby.id)
    if len(participants) != 2:
        raise HTTPException(status.HTTP_409_CONFLICT, "Cheddar MTG needs exactly 2 players")

    deck_imports = {d.user_id: d for d in db.query(MtgDeckImport).filter(MtgDeckImport.lobby_id == lobby.id).all()}
    for p in participants:
        imp = deck_imports.get(p.user_id)
        if imp is None or not imp.cards:
            raise HTTPException(status.HTTP_409_CONFLICT, "Both players must import a deck before starting")

    # Deterministic seat assignment, same reasoning as chess's white/black:
    # whoever's been in the lobby longest goes first.
    game = MtgGame(
        lobby_id=lobby.id,
        lobby_started_at=lobby.started_at,
        player1_user_id=participants[0].user_id,
        player2_user_id=participants[1].user_id,
        active_user_id=participants[0].user_id,
        turn_number=1,
        phase="untap",
        status="in_progress",
    )
    db.add(game)
    try:
        db.commit()
    except IntegrityError:
        # Both clients fetch/create the instant the lobby flips to
        # in_progress — same race as beats.py/chess.py, same fix: the loser
        # just reads back what the winner created.
        db.rollback()
        game = _get_current_game(db, lobby)
        if game is None:
            raise
        return _serialize_state_for(db, lobby, game, user.id)
    db.refresh(game)

    for p in participants:
        cards = deck_imports[p.user_id].cards
        instances = [
            {
                "id": str(uuid.uuid4()),
                "name": c["name"],
                "image_url": c["image_url"],
                "scryfall_id": c["scryfall_id"],
                "tapped": False,
                "counters": {},
                "x": 0.5,
                "y": 0.5,
            }
            for c in cards
        ]
        random.shuffle(instances)
        hand = instances[:OPENING_HAND_SIZE]
        library = instances[OPENING_HAND_SIZE:]
        db.add(
            MtgPlayerState(
                game_id=game.id,
                user_id=p.user_id,
                life=20,
                library=library,
                hand=hand,
                battlefield=[],
                graveyard=[],
                exile=[],
            )
        )
    db.commit()

    out = _serialize_state_for(db, lobby, game, user.id)
    await _broadcast_state(db, lobby, game)
    return out


@router.get("/{lobby_id}/state", response_model=MtgStateOut)
def get_state(lobby_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    game = _get_game_or_404(db, lobby)
    return _serialize_state_for(db, lobby, game, user.id)


@router.post("/{lobby_id}/draw", response_model=MtgStateOut)
async def draw_card(lobby_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    game = _get_game_or_404(db, lobby)
    _require_in_progress(game)

    state = _get_player_state(db, game, user.id)
    if not state.library:
        raise HTTPException(status.HTTP_409_CONFLICT, "Library is empty")
    library = list(state.library)
    card = library.pop(0)
    state.library = library
    state.hand = list(state.hand) + [card]
    db.commit()

    out = _serialize_state_for(db, lobby, game, user.id)
    await _broadcast_state(db, lobby, game)
    return out


@router.post("/{lobby_id}/shuffle", response_model=MtgStateOut)
async def shuffle_library(lobby_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    game = _get_game_or_404(db, lobby)
    _require_in_progress(game)

    state = _get_player_state(db, game, user.id)
    library = list(state.library)
    random.shuffle(library)
    state.library = library
    db.commit()

    out = _serialize_state_for(db, lobby, game, user.id)
    await _broadcast_state(db, lobby, game)
    return out


@router.post("/{lobby_id}/move", response_model=MtgStateOut)
async def move_card(
    lobby_id: int,
    payload: MtgMoveIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    game = _get_game_or_404(db, lobby)
    _require_in_progress(game)

    owner_state = _get_player_state(db, game, payload.owner_user_id)
    from_cards = _zone_list(owner_state, payload.from_zone)
    match = next((c for c in from_cards if c["id"] == payload.instance_id), None)
    if match is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found in the given zone")
    _set_zone(owner_state, payload.from_zone, [c for c in from_cards if c["id"] != payload.instance_id])

    moved = dict(match)
    if payload.to_zone == "battlefield":
        moved["x"] = payload.x if payload.x is not None else moved.get("x", 0.5)
        moved["y"] = payload.y if payload.y is not None else moved.get("y", 0.5)
        if payload.from_zone == "hand":
            # Only summoning (hand -> battlefield) offers a face-down
            # choice — repositioning an already-battlefield card keeps
            # whatever face_down state it already had.
            moved["face_down"] = payload.face_down
    else:
        # A card's tap state, counters, and face-down status don't mean
        # anything outside the battlefield — leaving it (destroyed,
        # bounced, discarded) is a new object by MTG's own rules, so it
        # resets clean for whenever it returns.
        moved["tapped"] = False
        moved["counters"] = {}
        moved["face_down"] = False

    to_cards = _zone_list(owner_state, payload.to_zone)
    _set_zone(owner_state, payload.to_zone, to_cards + [moved])
    db.commit()

    out = _serialize_state_for(db, lobby, game, user.id)
    await _broadcast_state(db, lobby, game)
    return out


@router.post("/{lobby_id}/tap", response_model=MtgStateOut)
async def set_tapped(
    lobby_id: int,
    payload: MtgTapIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    game = _get_game_or_404(db, lobby)
    _require_in_progress(game)

    owner_state = _get_player_state(db, game, payload.owner_user_id)
    battlefield = list(owner_state.battlefield)
    found = False
    new_battlefield = []
    for c in battlefield:
        if c["id"] == payload.instance_id:
            c = {**c, "tapped": payload.tapped}
            found = True
        new_battlefield.append(c)
    if not found:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found on the battlefield")
    owner_state.battlefield = new_battlefield
    db.commit()

    out = _serialize_state_for(db, lobby, game, user.id)
    await _broadcast_state(db, lobby, game)
    return out


@router.post("/{lobby_id}/counter", response_model=MtgStateOut)
async def update_counter(
    lobby_id: int,
    payload: MtgCounterIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    game = _get_game_or_404(db, lobby)
    _require_in_progress(game)

    owner_state = _get_player_state(db, game, payload.owner_user_id)
    battlefield = list(owner_state.battlefield)
    found = False
    new_battlefield = []
    for c in battlefield:
        if c["id"] == payload.instance_id:
            counters = dict(c.get("counters", {}))
            new_value = counters.get(payload.counter_type, 0) + payload.delta
            if new_value <= 0:
                counters.pop(payload.counter_type, None)
            else:
                counters[payload.counter_type] = new_value
            c = {**c, "counters": counters}
            found = True
        new_battlefield.append(c)
    if not found:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Card not found on the battlefield")
    owner_state.battlefield = new_battlefield
    db.commit()

    out = _serialize_state_for(db, lobby, game, user.id)
    await _broadcast_state(db, lobby, game)
    return out


@router.post("/{lobby_id}/life", response_model=MtgStateOut)
async def adjust_life(
    lobby_id: int,
    payload: MtgLifeIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    game = _get_game_or_404(db, lobby)
    _require_in_progress(game)

    target_state = _get_player_state(db, game, payload.target_user_id)
    target_state.life = target_state.life + payload.delta
    db.commit()

    out = _serialize_state_for(db, lobby, game, user.id)
    await _broadcast_state(db, lobby, game)
    return out


@router.post("/{lobby_id}/phase", response_model=MtgStateOut)
async def advance_phase(lobby_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Any participant can advance the phase (trusted, honor-system, same as
    every other action here) — handy if the active player forgets. Only the
    structural, non-card-text parts of the turn cycle are automated:
    untapping the new active player's permanents, and their draw-for-turn
    (skipped on the very first turn, per the standard rule for the player
    going first)."""
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    game = _get_game_or_404(db, lobby)
    _require_in_progress(game)

    idx = PHASES.index(game.phase)
    if idx == len(PHASES) - 1:
        game.turn_number += 1
        game.active_user_id = (
            game.player2_user_id if game.active_user_id == game.player1_user_id else game.player1_user_id
        )
        game.phase = PHASES[0]
    else:
        game.phase = PHASES[idx + 1]

    if game.phase == "untap":
        active_state = _get_player_state(db, game, game.active_user_id)
        active_state.battlefield = [{**c, "tapped": False} for c in active_state.battlefield]
    elif game.phase == "draw" and game.turn_number > 1:
        active_state = _get_player_state(db, game, game.active_user_id)
        if active_state.library:
            library = list(active_state.library)
            card = library.pop(0)
            active_state.library = library
            active_state.hand = list(active_state.hand) + [card]

    db.commit()

    out = _serialize_state_for(db, lobby, game, user.id)
    await _broadcast_state(db, lobby, game)
    return out


@router.post("/{lobby_id}/concede", response_model=MtgStateOut)
async def concede(lobby_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    lobby = _get_lobby_or_404(db, lobby_id)
    _require_participant(db, lobby, user)
    game = _get_game_or_404(db, lobby)
    _require_in_progress(game)

    game.status = "finished"
    game.winner_user_id = game.player2_user_id if user.id == game.player1_user_id else game.player1_user_id
    db.commit()

    out = _serialize_state_for(db, lobby, game, user.id)
    await _broadcast_state(db, lobby, game)
    return out
