"""The Karirs field's own race simulation + betting-odds engine — ported
from games/karirs/api's own app/race.py and app/roster.py essentially
unchanged (the simulation itself has no lobby/DB coupling at all, and the
odds math only needs a roster of win/loss records, which this game tracks
independently via KarirsRacer — see that model's own docstring for why).

Kept as a single file, not re-imported cross-service, since these two
services don't share a Python environment or database — copying the
(already carefully calibrated) logic is simpler and more robust than
reaching across a service boundary for it. If the sim in games/karirs ever
changes in a way that could shift the calibration curve below, re-run the
same sweep this file's own comments describe against *this* copy too.
"""

import random
from typing import Iterator

from sqlalchemy.orm import Session

from app.models import KarirsRacer

# --- Race simulation (games/karirs/api/app/race.py) ----------------------
TOTAL_STEPS = 150
FINISH_LINE = 100.0
SPEED_RANGE = (0.0, 2.0)
SPEED_CHANGE_STEP_INTERVAL = (5, 15)
STEP_DELAY_SECONDS = 0.3  # real seconds per step when a client replays `steps` against `started_at`


def step_race(
    racer_names: list[str], speed_factors: dict[str, float] | None = None
) -> Iterator[tuple[int, dict[str, float], bool, str | None]]:
    """Yields (step, positions, is_final, winner) once per step. `winner` is
    only set on the final yielded step — either whoever just crossed the
    finish line, or, if nobody has by step TOTAL_STEPS, whoever is furthest
    along. speed_factors biases each racer's actual movement toward their
    priced odds (see speed_factor_for_multiplier)."""
    factors = speed_factors or {}
    positions = {name: 0.0 for name in racer_names}
    speeds = {name: random.uniform(*SPEED_RANGE) * factors.get(name, 1.0) for name in racer_names}
    next_change = {name: random.randint(*SPEED_CHANGE_STEP_INTERVAL) for name in racer_names}

    for step in range(1, TOTAL_STEPS + 1):
        for name in racer_names:
            if step >= next_change[name]:
                speeds[name] = random.uniform(*SPEED_RANGE) * factors.get(name, 1.0)
                next_change[name] = step + random.randint(*SPEED_CHANGE_STEP_INTERVAL)

        crossed: str | None = None
        for name in racer_names:
            if positions[name] < FINISH_LINE:
                positions[name] = min(positions[name] + speeds[name], FINISH_LINE)
                if positions[name] >= FINISH_LINE and crossed is None:
                    crossed = name

        is_final = crossed is not None or step == TOTAL_STEPS
        winner = crossed
        if winner is None and is_final:
            winner = max(positions, key=lambda n: positions[n])

        yield step, {name: round(pos, 2) for name, pos in positions.items()}, is_final, winner

        if is_final:
            return


def compute_race(racer_names: list[str], speed_factors: dict[str, float] | None = None) -> tuple[list[dict], str]:
    """Runs the whole race immediately and returns every step in order (index
    0 = step 1) plus the winner — ships to clients in one shot instead of
    being live-broadcast tick by tick; they replay it locally against
    `started_at` instead."""
    steps: list[dict] = []
    winner = None
    for _step, positions, is_final, step_winner in step_race(racer_names, speed_factors):
        steps.append({"positions": positions})
        if is_final:
            winner = step_winner
    return steps, winner


# --- Betting odds (games/karirs/api/app/roster.py) ------------------------
DEFAULT_RACER_COUNT = 4  # the calibration table below was measured for exactly this field size
HOUSE_EDGE_FACTOR = 0.9
PRIOR_STRENGTH = 4.0

_CALIBRATION_TABLE: list[tuple[float, float]] = [
    (0.20, 0.0000), (0.60, 0.0003), (0.65, 0.0018), (0.70, 0.0069), (0.75, 0.0183),
    (0.80, 0.0438), (0.85, 0.0784), (0.90, 0.1277), (0.95, 0.1884), (1.00, 0.2607),
    (1.05, 0.3251), (1.10, 0.4069), (1.15, 0.4850), (1.20, 0.5493), (1.25, 0.6142),
    (1.30, 0.6625), (1.35, 0.7051), (1.40, 0.7483), (1.50, 0.8202), (1.60, 0.8788),
    (1.65, 0.8933), (1.80, 0.9365), (2.00, 0.9669), (2.20, 0.9806), (2.50, 0.9927),
    (2.80, 0.9962), (3.20, 0.9987), (3.60, 0.9994), (4.00, 0.9996),
]

_FIELD_CORRECTION_TABLE: list[tuple[float, float]] = [
    (0.0, 0.0), (0.081, 0.058), (0.158, 0.133), (0.247, 0.239), (0.344, 0.373),
    (0.433, 0.496), (0.522, 0.627), (1.0, 1.0),
]


def _interp(table: list[tuple[float, float]], x: float) -> float:
    if x <= table[0][0]:
        return table[0][1]
    if x >= table[-1][0]:
        return table[-1][1]
    for (x0, y0), (x1, y1) in zip(table, table[1:]):
        if x0 <= x <= x1:
            if x1 == x0:
                return y0
            t = (x - x0) / (x1 - x0)
            return y0 + t * (y1 - y0)
    return table[-1][1]  # unreachable


def _speed_factor_for_win_rate(target: float) -> float:
    inverted = [(w, f) for f, w in _CALIBRATION_TABLE]
    return _interp(inverted, target)


def _corrected_probability(target_probability: float) -> float:
    inverted = [(realized, true) for true, realized in _FIELD_CORRECTION_TABLE]
    return _interp(inverted, target_probability)


def speed_factor_for_multiplier(multiplier: float) -> float:
    """Reverses compute_payout_multipliers' math to recover the win
    probability a racer's frozen payout multiplier implies, corrects it for
    the real-field interaction effect, then looks up the speed_factor that
    empirically produces that in a 4-racer field."""
    probability = HOUSE_EDGE_FACTOR / multiplier
    adjusted = _corrected_probability(probability)
    return _speed_factor_for_win_rate(adjusted)


def pick_racers(db: Session, count: int = DEFAULT_RACER_COUNT) -> list[str]:
    racers = db.query(KarirsRacer).all()
    if len(racers) < 2:
        raise ValueError("not enough racers in the roster to run a race")
    chosen = random.sample(racers, k=min(count, len(racers)))
    return [r.name for r in chosen]


def record_result(db: Session, racer_names: list[str], winner: str) -> None:
    rows = db.query(KarirsRacer).filter(KarirsRacer.name.in_(racer_names)).all()
    for racer in rows:
        racer.races_run += 1
        if racer.name == winner:
            racer.wins += 1
        else:
            racer.losses += 1


def compute_payout_multipliers(db: Session, racer_names: list[str]) -> dict[str, float]:
    """Turns each racer's overall win/loss record into fixed payout odds for
    this field: HOUSE_EDGE_FACTOR / estimated P(win), Bayesian-smoothed
    against a neutral prior and normalized to sum to 1 across the field.
    Computed once at race creation and frozen on the race row."""
    rows = db.query(KarirsRacer).filter(KarirsRacer.name.in_(racer_names)).all()
    racers_by_name = {r.name: r for r in rows}
    neutral = 1.0 / len(racer_names)

    raw = {}
    for name in racer_names:
        racer = racers_by_name.get(name)
        wins = racer.wins if racer else 0
        races_run = racer.races_run if racer else 0
        raw[name] = (wins + PRIOR_STRENGTH * neutral) / (races_run + PRIOR_STRENGTH)

    total = sum(raw.values())
    return {name: round(HOUSE_EDGE_FACTOR / (raw[name] / total), 2) for name in racer_names}


# Same 25-name "colleague roster" every game in this project draws from,
# portmantea'd differently per game (see main.py's own SPECIES) — kept as
# its own literal list here rather than importing games/karirs (a separate
# service/deploy entirely) for it.
KARIRS_SEED_RACERS = [
    ("Neil Axinto", "🚀 Turbo Neil!"),
    ("Aby Calago", "🌪️ Aby Cyclone!"),
    ("Ashley Bayarcal", "✨ Starlight Dash!"),
    ("Brian Lisondra", "🔥 Blazing Brian!"),
    ("Carl Perral", "⚡ Carl's Overdrive!"),
    ("Chaimel Enjambre", "💀 Newbie Slayer!"),
    ("Elieser Tajanlangit", "🌊 Tidal Elieser!"),
    ("Jayson Martinez", "🎯 Bullseye Blitz!"),
    ("Jerome Madelo", "🥷 Shadow Step!"),
    ("Jhoewell Posas", "🐉 Dragon's Roar!"),
    ("Jhon Pabroa", "🌀 Whirlwind Jhon!"),
    ("John Macapaz", "💥 Sonic Boom!"),
    ("John Leo Salac", "🦁 Lion's Pride!"),
    ("Jonah Taganahan", "🌟 Falling Star!"),
    ("Joshua Paulo", "⚔️ Blade Rush!"),
    ("Troy Alonsagay", "🏹 Arrow of Troy!"),
    ("Grace Vellina", "👑 Graceful Fury!"),
    ("Mat Ando", "🔨 Hammer Time!"),
    ("Michael Tonilon", "🚨 Code Red!"),
    ("Mike Miñoza", "🎸 Rockstar Rev!"),
    ("Novel Chavez", "📖 Plot Twist!"),
    ("Percival Mansueto", "🛡️ Iron Wall Charge!"),
    ("Rashed Perez", "💨 Rashed Rocket!"),
    ("Roland Clarion", "🔔 Clarion Call!"),
    ("Xiao", "🐼 Panda Dash!"),
]


def seed_karirs_roster_if_empty(db: Session) -> None:
    if db.query(KarirsRacer).count() > 0:
        return
    db.add_all(KarirsRacer(name=name, signature_move=move) for name, move in KARIRS_SEED_RACERS)
    db.commit()
