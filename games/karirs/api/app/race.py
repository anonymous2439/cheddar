import random

# Ported from the original karirs race sim (/home/rev/karirs/server.py): each
# racer's speed is re-rolled from a random range every couple of "seconds",
# first to reach the finish line wins. That version ran this as a live
# 10fps broadcast loop for a spectator UI; here we only need the outcome, so
# it's simulated straight through instead of streamed. Deliberately dropped:
# a hardcoded speed override for one specific name in the original — that
# was a personal easter egg, not part of the actual game logic.
FINISH_LINE = 500
TICK_SECONDS = 0.1
SPEED_RANGE = (1, 25)
SPEED_CHANGE_INTERVAL = (2, 5)


def simulate_race(racer_names: list[str]) -> dict:
    positions = {name: 0.0 for name in racer_names}
    speeds = {name: random.uniform(*SPEED_RANGE) for name in racer_names}
    next_speed_change = {name: random.uniform(*SPEED_CHANGE_INTERVAL) for name in racer_names}

    elapsed = 0.0
    winner: str | None = None

    while winner is None:
        elapsed += TICK_SECONDS

        for name in racer_names:
            if elapsed >= next_speed_change[name]:
                speeds[name] = random.uniform(*SPEED_RANGE)
                next_speed_change[name] = elapsed + random.uniform(*SPEED_CHANGE_INTERVAL)

        for name in racer_names:
            if positions[name] < FINISH_LINE:
                positions[name] = min(positions[name] + speeds[name] * TICK_SECONDS, FINISH_LINE)
                if positions[name] >= FINISH_LINE and winner is None:
                    winner = name

    standings = sorted(racer_names, key=lambda n: positions[n], reverse=True)
    return {
        "winner": winner,
        "standings": standings,
        "positions": {name: round(pos, 2) for name, pos in positions.items()},
    }
