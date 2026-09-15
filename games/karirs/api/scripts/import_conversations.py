"""One-time import of a real group chat export (~/downloads/chat.json) into
the conversation_lines table, for GL Sims' chat-bubble flavor feature.

Only ever inserts, and only if the table is completely empty — re-running
after a successful import is a safe no-op rather than a source of
duplicates, matching seed_roster_if_empty's own "seed if empty" convention
in roster.py. Not part of the app's normal startup seeding (unlike that
roster seed) since this is a one-off personal-data import, not small static
reference data — run manually: `venv/bin/python scripts/import_conversations.py`.

Each message carries the export's own stable per-sender "id" plus a "name"
that's their real (occasionally multi-spelling) full name — see models.py's
ConversationLine docstring for why matching is resolved once per id rather
than per individual message. The match itself allows a racer's name tokens
to appear as an in-order (not necessarily contiguous) subsequence of the
chat name's tokens, with each token allowed to match either exactly or as a
prefix (case-insensitive) — covers a plain middle name in between ("Mat
Mitcheil Ando" for racer "Mat Ando"), a nickname-vs-legal-name mismatch on
the *first* token only ("Mary Grace Vellina" for racer "Grace Vellina",
"Mark Troy Alonsagay" for racer "Troy Alonsagay"), and a name mashed
together with a trailing digit ("BrianKeith Lisondra2" for racer "Brian
Lisondra", where "brian" prefix-matches "briankeith" and "lisondra"
prefix-matches "lisondra2").
"""

import json
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.db import Base, SessionLocal, engine  # noqa: E402
from app.models import ConversationLine  # noqa: E402

CHAT_PATH = Path.home() / "downloads" / "chat.json"

# Same roster as roster.py's SEED_RACERS — duplicated here rather than
# imported since this is a one-off data-shape concern (matching against
# names from an external export), not part of the app's own runtime
# behavior; keep both lists in sync by hand if the roster ever changes.
RACERS = [
    "Neil Axinto", "Aby Calago", "Ashley Bayarcal", "Brian Lisondra", "Carl Perral",
    "Chaimel Enjambre", "Elieser Tajanlangit", "Jayson Martinez", "Jerome Madelo", "Jhoewell Posas",
    "Jhon Pabroa", "John Macapaz", "John Leo Salac", "Jonah Taganahan", "Joshua Paulo",
    "Troy Alonsagay", "Grace Vellina", "Mat Ando", "Michael Tonilon", "Mike Miñoza",
    "Novel Chavez", "Percival Mansueto", "Rashed Perez", "Roland Clarion", "Xiao",
]


def _tokens(name: str) -> list[str]:
    return [t.lower() for t in name.split() if t]


def _token_matches(racer_token: str, chat_token: str) -> bool:
    return chat_token == racer_token or chat_token.startswith(racer_token)


def _is_subsequence_match(racer_tokens: list[str], chat_tokens: list[str]) -> bool:
    i = 0
    for racer_token in racer_tokens:
        matched = False
        while i < len(chat_tokens):
            if _token_matches(racer_token, chat_tokens[i]):
                matched = True
                i += 1
                break
            i += 1
        if not matched:
            return False
    return True


def _matching_racers(chat_name: str) -> set[str]:
    chat_tokens = _tokens(chat_name)
    return {racer for racer in RACERS if _is_subsequence_match(_tokens(racer), chat_tokens)}


def resolve_racer_by_person(name_variants: set[str]) -> str | None:
    """A person may post under more than one name spelling (see module
    docstring) — try every observed spelling and only accept the result if
    they all agree on a single racer, so one odd spelling can't override a
    confident match from another."""
    all_matches: set[str] = set()
    for name in name_variants:
        all_matches |= _matching_racers(name)
    return all_matches.pop() if len(all_matches) == 1 else None


def main():
    if not CHAT_PATH.exists():
        print(f"no chat export found at {CHAT_PATH}, nothing to import")
        return

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if db.query(ConversationLine).count() > 0:
            print("conversation_lines already populated, skipping import")
            return

        with open(CHAT_PATH, encoding="utf-8") as f:
            lines = json.load(f)

        variants_by_id: dict[int, set[str]] = {}
        for entry in lines:
            variants_by_id.setdefault(entry["id"], set()).add(entry["name"])
        racer_by_id = {pid: resolve_racer_by_person(names) for pid, names in variants_by_id.items()}

        rows = []
        matched = 0
        for entry in lines:
            racer_name = racer_by_id.get(entry["id"])
            if racer_name:
                matched += 1
            rows.append(
                ConversationLine(
                    person_id=entry["id"],
                    raw_name=entry["name"],
                    message=entry["message"],
                    racer_name=racer_name,
                )
            )

        db.bulk_save_objects(rows)
        db.commit()
        print(f"imported {len(rows)} lines, {matched} matched to a racer, {len(rows) - matched} unmatched")
        print("person_id -> racer:", {pid: racer_by_id[pid] for pid in sorted(racer_by_id)})
    finally:
        db.close()


if __name__ == "__main__":
    main()
