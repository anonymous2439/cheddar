import random

from sqlalchemy.orm import Session

from app.models import Racer

DEFAULT_RACER_COUNT = 4

# Same 10% cut the old flat multiplier used ((field_size - 1) * 0.9, back
# when every racer had identical odds) — now applied per-racer against each
# one's own estimated win probability instead of a shared field-size shape.
HOUSE_EDGE_FACTOR = 0.9

# How many "virtual races" of a neutral (1 / field size) win rate a racer's
# real record is blended with. Keeps a thin or empty history from reading as
# a sure thing or a lock — right now every racer is at 0 races/0 wins, so
# everyone starts out exactly at the neutral rate (identical odds, matching
# today's behavior) and only drifts as real results accumulate.
PRIOR_STRENGTH = 4.0

# A racer's speed is re-rolled ~10 times over the course of a race (see
# race.py's SPEED_CHANGE_STEP_INTERVAL), and the finish is essentially the
# sum of all those rolls — the law of large numbers means even a modest,
# *consistent* per-roll bias compounds into a near-certain outcome by the
# end (empirically: a raw relative-skill multiplier, clamped to [0.8, 1.3]
# and applied every reroll, turned a racer with a genuine 45% win
# probability into one that actually won ~80% of the time). SPEED_FACTOR_
# DAMPING compresses relative skill toward 1.0 (relative ** DAMPING) before
# it's applied, so the *simulated* win frequency ends up close to the
# probability the payout odds actually promise, instead of wildly
# overshooting it. 0.10 was picked by simulating real race trials across
# lopsided, moderate, and near-even fields and checking actual win rate
# against intended probability (see games/karirs conversation history for
# the sweep) — it's the tuning knob if this ever needs revisiting: lower
# = less predictable, higher = more.
SPEED_FACTOR_DAMPING = 0.10
# Backstop only — the damping above already keeps every realistic case well
# inside this range; it exists so a pathological input (e.g. an unusually
# large field) can't push the bias somewhere silly.
MIN_SPEED_FACTOR = 0.75
MAX_SPEED_FACTOR = 1.3

# Seeded once on first startup if the table is empty — easy to grow later
# by just inserting more rows into `racers`.
SEED_NAMES = [
    "Neil Axinto", "Aby Calago", "Ashley Bayarcal", "Brian Lisondra",
    "Carl Perral", "Chaimel Enjambre", "Elieser Tajanlangit", "Jayson Martinez",
    "Jerome Madelo", "Jhoewell Posas", "Jhon Pabroa", "John Macapaz",
    "John Leo Salac", "Jonah Taganahan", "Joshua Paulo", "Troy Alonsagay",
    "Grace Vellina", "Mat Ando", "Michael Tonilon", "Mike Miñoza",
    "Novel Chavez", "Percival Mansueto", "Rashed Perez", "Roland Clarion",
    "Xiao",
]


def seed_roster_if_empty(db: Session) -> None:
    if db.query(Racer).count() > 0:
        return
    db.add_all(Racer(name=name) for name in SEED_NAMES)
    db.commit()


def pick_racers(db: Session, count: int = DEFAULT_RACER_COUNT) -> list[str]:
    racers = db.query(Racer).all()
    if len(racers) < 2:
        raise ValueError("not enough racers in the roster to run a race")
    chosen = random.sample(racers, k=min(count, len(racers)))
    return [r.name for r in chosen]


def record_result(db: Session, racer_names: list[str], winner: str) -> None:
    rows = db.query(Racer).filter(Racer.name.in_(racer_names)).all()
    for racer in rows:
        racer.races_run += 1
        if racer.name == winner:
            racer.wins += 1
        else:
            racer.losses += 1


def compute_payout_multipliers(db: Session, racer_names: list[str]) -> dict[str, float]:
    """Turns each racer's overall win/loss record into fixed payout odds for
    this specific field: HOUSE_EDGE_FACTOR / estimated P(win), where P(win)
    is a Bayesian-smoothed win rate (real wins/races_run blended with a
    neutral 1/field-size prior, weight PRIOR_STRENGTH) normalized so the
    field's probabilities sum to 1. A racer with a stronger track record
    than the rest of this field pays out less; a longshot pays out more.
    Computed once at race creation and frozen on the Race row — this is the
    single source of truth both for what bettors see and for what payouts
    actually use."""
    rows = db.query(Racer).filter(Racer.name.in_(racer_names)).all()
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


def speed_factor_for_multiplier(multiplier: float, field_size: int) -> float:
    """Reverses compute_payout_multipliers' math to recover the relative
    skill implied by a racer's (already-frozen) payout multiplier, damped
    (see SPEED_FACTOR_DAMPING) so the sim's actual win frequency tracks the
    probability the payout odds promise instead of overshooting it, then
    clamped to [MIN_SPEED_FACTOR, MAX_SPEED_FACTOR] as a backstop. Keeps the
    sim and the odds bettors were shown driven by the exact same numbers
    instead of two separate computations that could drift apart."""
    neutral = 1.0 / field_size
    probability = HOUSE_EDGE_FACTOR / multiplier
    relative = probability / neutral
    damped = relative**SPEED_FACTOR_DAMPING
    return max(MIN_SPEED_FACTOR, min(MAX_SPEED_FACTOR, damped))
