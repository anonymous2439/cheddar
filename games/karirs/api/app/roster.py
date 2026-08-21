import random

from sqlalchemy.orm import Session

from app.models import Racer

DEFAULT_RACER_COUNT = 4

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
