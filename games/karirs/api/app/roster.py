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
# end (empirically: an early, undamped version turned a racer with a
# genuine 45% win probability into one that actually won ~80% of the time).
#
# A first fix damped relative skill toward 1.0 via a single exponent
# (relative ** 0.10) before applying it as the per-roll speed_factor. That
# got the *average* case close, but left a real, measured directional bias
# at the extremes: favorites underperformed their priced odds and
# underdogs overperformed theirs, badly enough that "always bet the
# biggest underdog in the field" was a genuine positive-EV exploit (~+12%
# per bet, confirmed at 20,000 simulated trials) rather than the flat ~10%
# house edge every racer is supposed to carry.
#
# _CALIBRATION_TABLE replaces that formula with the real measured curve: for
# a battery of candidate speed_factors, one racer was set to that factor
# against three racers held at neutral (factor 1.0) in a 4-racer field, and
# its actual win rate was measured over 10,000 simulated races per point
# (see games/karirs conversation history for the sweep). _speed_factor_for_
# win_rate inverts this table via linear interpolation, so "what speed_
# factor produces win rate P" is answered from real simulation data instead
# of a formula that only approximately fit it. Revisit by re-running that
# sweep (games/karirs/api, using app.race.compute_race directly) if the sim
# itself ever changes in a way that could shift the curve.
_CALIBRATION_TABLE: list[tuple[float, float]] = [
    # (speed_factor, measured win rate in a 4-racer field)
    (0.20, 0.0000),
    (0.60, 0.0003),
    (0.65, 0.0018),
    (0.70, 0.0069),
    (0.75, 0.0183),
    (0.80, 0.0438),
    (0.85, 0.0784),
    (0.90, 0.1277),
    (0.95, 0.1884),
    (1.00, 0.2607),
    (1.05, 0.3251),
    (1.10, 0.4069),
    (1.15, 0.4850),
    (1.20, 0.5493),
    (1.25, 0.6142),
    (1.30, 0.6625),
    (1.35, 0.7051),
    (1.40, 0.7483),
    (1.50, 0.8202),
    (1.60, 0.8788),
    (1.65, 0.8933),
    (1.80, 0.9365),
    (2.00, 0.9669),
    (2.20, 0.9806),
    (2.50, 0.9927),
    (2.80, 0.9962),
    (3.20, 0.9987),
    (3.60, 0.9994),
    (4.00, 0.9996),
]


def _interp(table: list[tuple[float, float]], x: float) -> float:
    """Linear interpolation over a table of (x, y) pairs sorted by x,
    clamped to the table's own range at the extremes rather than
    extrapolating past what was actually measured."""
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
    return table[-1][1]  # unreachable — x is within [table[0][0], table[-1][0]] by the checks above


def _speed_factor_for_win_rate(target: float) -> float:
    """Inverts _CALIBRATION_TABLE via linear interpolation between the
    nearest measured points."""
    inverted = [(w, f) for f, w in _CALIBRATION_TABLE]
    return _interp(inverted, target)


# _CALIBRATION_TABLE was measured with one racer's speed_factor varied
# against three others held at neutral (1.0) — clean to measure, but real
# races never actually look like that: all four racers get their own
# distinct factor at once, each racer's *opponents* are also shifted away
# from neutral, and that interaction matters. Applying the isolated table
# directly measurably overcorrected: simulating real 4-racer fields sampled
# from the actual roster showed favorites now *over*-performing their
# priced odds and underdogs *under*-performing (the mirror image of the
# original uncalibrated bug). _FIELD_CORRECTION maps a racer's true priced
# probability to the probability that, once run through the isolated
# table, actually lands on target — measured by bucketing every racer in
# 15,000 simulated real-roster races by priced-probability decile and
# comparing to its actual win rate (see games/karirs conversation history).
# The (0.0, 0.0) and (1.0, 1.0) anchors are assumed, not measured — the
# real roster hasn't produced fields skewed enough to populate deciles
# beyond ~0.55, but both curves must agree at the certain-loss/certain-win
# limits regardless.
_FIELD_CORRECTION_TABLE: list[tuple[float, float]] = [
    (0.0, 0.0),
    (0.081, 0.058),
    (0.158, 0.133),
    (0.247, 0.239),
    (0.344, 0.373),
    (0.433, 0.496),
    (0.522, 0.627),
    (1.0, 1.0),
]


def _corrected_probability(target_probability: float) -> float:
    """Given a racer's true priced win probability (the target we actually
    want them to win at), returns the adjusted probability that, fed
    through the isolated _CALIBRATION_TABLE, actually realizes that target
    in a real (all-four-racers-deviating) field — the inverse of
    _FIELD_CORRECTION_TABLE's measured (true -> realized) relationship."""
    inverted = [(realized, true) for true, realized in _FIELD_CORRECTION_TABLE]
    return _interp(inverted, target_probability)

# Seeded once on first startup if the table is empty — easy to grow later by
# just inserting more rows into `racers`. Each racer's signature_move lives
# on the row itself (see Race.signature_moves in models.py), so it's part of
# this seed data too, rather than a separate hardcoded map any client would
# need its own copy of.
SEED_RACERS = [
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


def seed_roster_if_empty(db: Session) -> None:
    if db.query(Racer).count() > 0:
        return
    db.add_all(Racer(name=name, signature_move=move) for name, move in SEED_RACERS)
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


def speed_factor_for_multiplier(multiplier: float) -> float:
    """Reverses compute_payout_multipliers' math to recover the win
    probability implied by a racer's (already-frozen) payout multiplier,
    corrects it for the real-field interaction effect (see
    _corrected_probability), then looks up the speed_factor that
    empirically produces that in a 4-racer field (see _CALIBRATION_TABLE)
    — the only field size this game currently deals (DEFAULT_RACER_COUNT).
    Keeps the sim and the odds bettors were shown driven by the exact same
    numbers instead of two separate computations that could drift apart."""
    probability = HOUSE_EDGE_FACTOR / multiplier
    adjusted = _corrected_probability(probability)
    return _speed_factor_for_win_rate(adjusted)
