"""Seeds placeholder Cheddar Beats key-sequences — 10 random sequences per
(level, mode) combination, per the initial spec ("10 random arrows per
level ... I can adjust it later on"). A level-N sequence is N symbols long,
drawn from that mode's key alphabet (arrows for 4key; arrows + WASD for
8key) — this is what a player has to press in order before their spacebar
beat-press gets judged. bpm and heartbeat pulse count are host-chosen at
session creation now (see BeatsGame), not stored per-sequence.

Re-run any time to add more variety — it only ever adds rows, never touches
existing ones, so it's safe to run repeatedly without disrupting a running
match.
"""

import random
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db.session import SessionLocal  # noqa: E402
from app.models.beats_arrow_set import BeatsArrowSet  # noqa: E402

SEQUENCES_PER_LEVEL_MODE = 10
# 8key is the 4 arrows plus the 4 diagonals — see beats.py's KEY_ALPHABET
# for why (numpad navigation cluster with Num Lock off).
KEY_ALPHABET = {
    "4key": ["up", "down", "left", "right"],
    "8key": ["up", "down", "left", "right", "up_left", "up_right", "down_left", "down_right"],
}

MOVE_NAMES = [
    "Moonwalk", "Windmill", "Body Roll", "Pop Lock", "Spin", "Freeze",
    "Slide", "Robot", "Floss", "Shuffle", "Wave", "Dab", "Kick Step",
    "Hip Bump", "Twist", "Jump Split", "Arm Wave", "Head Spin", "Glide", "Bounce",
]


def generate_sequence(level: int, mode: str) -> list[str]:
    alphabet = KEY_ALPHABET[mode]
    return [random.choice(alphabet) for _ in range(level)]


def main() -> None:
    db = SessionLocal()
    try:
        created = 0
        for level in range(1, 10):
            for mode in ("4key", "8key"):
                for _ in range(SEQUENCES_PER_LEVEL_MODE):
                    db.add(
                        BeatsArrowSet(
                            level=level,
                            mode=mode,
                            sequence=generate_sequence(level, mode),
                            move_name=random.choice(MOVE_NAMES),
                        )
                    )
                    created += 1
        db.commit()
        print(f"seeded {created} arrow sets")
    finally:
        db.close()


if __name__ == "__main__":
    main()
