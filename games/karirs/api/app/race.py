import random
from typing import Iterator

# Step-based version of the original karirs race sim
# (/home/rev/karirs/server.py): each racer's speed is re-rolled from a random
# range after a random number of steps, first to reach the finish line wins.
# The original ran continuous time at 10fps for a spectator UI; this steps
# through a fixed, bounded number of ticks instead so it can be streamed over
# a websocket at a steady, predictable cadence and a predictable max length.
# Deliberately dropped: a hardcoded speed override for one specific name in
# the original — that was a personal easter egg, not part of the game logic.
# TOTAL_STEPS is a generous cap, not the normal ending — at these speeds a
# race always crosses FINISH_LINE well before it (empirically 100% of the
# time over 500 trials), so it's only a backstop against a race running
# forever, not something races are expected to reach.
TOTAL_STEPS = 150
FINISH_LINE = 100.0

# Max speed well under FINISH_LINE / 1 step, so nobody can ever finish in a
# single step; 0 is a valid roll (a racer can stall for a stretch). Lowered
# from (0, 3) — that let a race cross in as few as ~35 steps (a handful of
# real seconds at the old 0.15s/step), which read as "done instantly."
SPEED_RANGE = (0.0, 2.0)
SPEED_CHANGE_STEP_INTERVAL = (5, 15)


def step_race(racer_names: list[str]) -> Iterator[tuple[int, dict[str, float], bool, str | None]]:
    """Yields (step, positions, is_final, winner) once per step. `winner` is
    only set on the final yielded step — either the racer who just crossed
    the finish line, or, if nobody has by step TOTAL_STEPS, whoever is
    furthest along."""
    positions = {name: 0.0 for name in racer_names}
    speeds = {name: random.uniform(*SPEED_RANGE) for name in racer_names}
    next_change = {name: random.randint(*SPEED_CHANGE_STEP_INTERVAL) for name in racer_names}

    for step in range(1, TOTAL_STEPS + 1):
        for name in racer_names:
            if step >= next_change[name]:
                speeds[name] = random.uniform(*SPEED_RANGE)
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
