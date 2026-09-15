from sqlalchemy import BigInteger, Column, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.dialects.mysql import JSON
from sqlalchemy.orm import object_session
from sqlalchemy.sql import func

from app.db import Base


class Wallet(Base):
    __tablename__ = "wallets"

    # No cross-database FK to cheddar.users — user_id is just the "sub" claim
    # from the Cheddar-issued JWT, trusted because we verify it with the same
    # secret Cheddar signs with.
    user_id = Column(BigInteger, primary_key=True)
    coins = Column(BigInteger, nullable=False, default=500)
    # When the daily 250-coin bonus was last claimed — null means never.
    # Claiming is only allowed once DAILY_BONUS_INTERVAL has passed since
    # this (see main.py's _daily_bonus_available).
    last_claimed_at = Column(DateTime, nullable=True)
    # When the "your daily bonus is ready" chat reminder was last posted —
    # separate from last_claimed_at so re-entering the game (or vscode's
    # periodic re-sync during betting) doesn't repost the same reminder
    # every time; only a *new* claim window (one that opened after this
    # timestamp) triggers another one.
    daily_bonus_notified_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())


class Racer(Base):
    """The preset roster — betting doesn't depend on who's in the lobby, it
    depends on this. wins/losses/races_run are recorded after every race so
    race outcomes and payouts can be weighted by a racer's track record (see
    roster.compute_payout_multipliers). signature_move is the catchphrase
    they shout at peak speed (race.py's PEAK_SPEED_THRESHOLD) — stored here
    (not hardcoded per-client) so web/vscode/the PowerShell client all read
    the exact same line straight off the race API response, and it can be
    edited without redeploying any client."""

    __tablename__ = "racers"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(64), nullable=False, unique=True)
    wins = Column(Integer, nullable=False, default=0)
    losses = Column(Integer, nullable=False, default=0)
    races_run = Column(Integer, nullable=False, default=0)
    signature_move = Column(String(128), nullable=True)
    # Static link for now (no upload flow yet) — a flat decal on the 3D
    # racer's head, not a UV-wrap of the whole sphere (see render3d.ts on
    # the client, same reasoning as the eye dots there: a photo wrapped
    # around a full sphere distorts badly toward the sides/back).
    face_image_url = Column(String(255), nullable=True)


class Race(Base):
    __tablename__ = "races"

    id = Column(Integer, primary_key=True, autoincrement=True)
    lobby_id = Column(BigInteger, nullable=False)
    racer_names = Column(JSON, nullable=False)
    status = Column(Enum("betting_open", "racing", "resolved"), nullable=False, default="betting_open")
    winning_name = Column(String(64), nullable=True)
    # The whole race, precomputed the instant betting closes (index 0 = step
    # 1) — clients replay it locally against betting_closes_at as the anchor
    # instead of us live-broadcasting one step at a time.
    steps = Column(JSON, nullable=True)
    # Frozen at race creation (see roster.compute_payout_multipliers) so the
    # odds a bettor saw before wagering are exactly what pays out later, even
    # if the racers' overall stats move on in the meantime.
    payout_multipliers = Column(JSON, nullable=True)
    created_by = Column(BigInteger, nullable=False)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    betting_closes_at = Column(DateTime, nullable=False)
    resolved_at = Column(DateTime, nullable=True)

    @property
    def signature_moves(self) -> dict[str, str]:
        """Every racer's catchphrase for THIS race's roster, read straight
        off their Racer row — object_session finds the same Session this
        Race was loaded through (still open for the life of the request),
        so this doesn't need its own db argument threaded in from every
        caller. Falls back to a generic line only if a racer somehow has
        none set (or the session is unexpectedly gone) — not the normal
        case, every seeded racer has one."""
        session = object_session(self)
        by_name: dict[str, str] = {}
        if session is not None:
            rows = session.query(Racer).filter(Racer.name.in_(self.racer_names)).all()
            by_name = {r.name: r.signature_move for r in rows if r.signature_move}
        return {name: by_name.get(name, f"{name}'s Signature Move!") for name in self.racer_names}

    @property
    def face_image_urls(self) -> dict[str, str | None]:
        """Same pattern as signature_moves above — read straight off each
        racer's row for this race's roster. Unlike signature_moves there's
        no generic fallback text; a racer with nothing set just gets None,
        and the client falls back to its plain colored head."""
        session = object_session(self)
        by_name: dict[str, str | None] = {}
        if session is not None:
            rows = session.query(Racer).filter(Racer.name.in_(self.racer_names)).all()
            by_name = {r.name: r.face_image_url for r in rows}
        return {name: by_name.get(name) for name in self.racer_names}


class ConversationLine(Base):
    """One line from a real group chat export (~/downloads/chat.json, ~20k
    lines), imported once via scripts/import_conversations.py — id order
    matches the original chat's top-to-bottom order, which GL Sims' playback
    depends on to read like an actual back-and-forth rather than shuffled
    non-sequiturs.

    person_id is the export's own stable per-sender id — the same real
    person can show up under more than one "name" spelling (id 37 posts as
    both "xiao xiao" and "Sem N"; id 18 as both "Chaimel Enjambre" and
    "Chaimel Enjambre2"), so racer_name is resolved once per person_id
    (matching *any* of that person's observed name spellings against the
    roster, see import_conversations.py) and applied to every line of
    theirs, rather than re-matching each line's own raw_name independently.
    Real chat names often carry a middle name the roster doesn't ("Mat
    Mitcheil Ando" for racer "Mat Ando", "Mary Grace Vellina" for racer
    "Grace Vellina") — the match allows the racer's own name tokens to
    appear as an in-order subsequence of the chat name's tokens, not just
    an exact match. Null when no racer's name subsequence-matches any of a
    person's spellings — GL Sims just skips those lines rather than
    guessing, per explicit instruction; they're kept here anyway since the
    ask was to save the full export, not a filtered subset.
    message is kept byte-for-byte as exported — Messenger's own system
    notices ("X added Y to the group.") are still in there; filtering those
    out for actual playback is a presentation-layer concern that lives in
    the export-to-GL-Sims script instead, so this table stays a faithful
    copy of the source file."""

    __tablename__ = "conversation_lines"

    id = Column(Integer, primary_key=True, autoincrement=True)
    person_id = Column(Integer, nullable=False)
    raw_name = Column(String(64), nullable=False)
    message = Column(String(4000), nullable=False)
    # Matches Racer.name in spirit (a plain string, not a FK) — same
    # convention Race.winning_name and Bet.racer_name already use.
    racer_name = Column(String(64), nullable=True)


class FilteredMessage(Base):
    """User-editable exact-match exclusion list for GL Sims' live
    conversation feed (see main.py's get_glsims_conversations) — a message
    whose text matches one of these rows (case-insensitive, after
    stripping) is dropped from playback, same idea as "Photos"/"unsent a
    message." needing to disappear without actually deleting the row from
    conversation_lines. Edited directly from names.php, which is also the
    only place with a DB session against karirs_game outside this app.

    Deliberately just plain exact strings, not regex — the *structural*
    system-notice detection (Messenger's "X added Y to the group.", "X
    unsent a message.", etc.) stays hardcoded in main.py's own
    SYSTEM_NOTICE_PATTERNS; this table is for the day-to-day "also filter
    this one" case, not for editing that parsing logic from a web form.
    """

    __tablename__ = "filtered_messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    message = Column(String(500), nullable=False, unique=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())


class ChatParticipant(Base):
    """Known chat-export name spellings, edited directly from names.php's
    admin panel — same reasoning as FilteredMessage above (a small
    exclusion/inclusion list that shouldn't need a code change to update).

    This is *not* the racer-matching list (see import_conversations.py's
    RACERS and names.php's own $racers array, which resolve racer_name and
    are unaffected by this table) — it's what names.php's client-side
    chat-to-JSON parser uses to find message boundaries in the raw pasted
    export at all. That format is just "HH:MM Name Message" on one line
    with no other delimiter, so a name has to be recognized up front to
    know where it ends and the message begins — a participant missing from
    this list has every one of their lines silently skipped during
    parsing, before racer-matching or upload ever sees them, regardless of
    whether they're one of the 25 racers.

    person_id is the chat export's own stable per-sender id (see
    ConversationLine's docstring) — the same real person can post under
    more than one name spelling, hence multiple rows sharing one
    person_id, same shape as that table.

    proxy_name, when set, is what GL Sims' live feed actually displays
    for this person instead of their real parsed name — resolved live in
    main.py's get_glsims_conversations (a join against the name already
    stored on each ConversationLine row, not baked in at parse/save time),
    so editing it here takes effect immediately for every line they've
    ever said, past or future, with no reprocessing step needed. Only
    applies when racer_name isn't already set — a matched racer already
    shows a clean roster name, unaffected by this.
    """

    __tablename__ = "chat_participants"

    id = Column(Integer, primary_key=True, autoincrement=True)
    person_id = Column(Integer, nullable=False)
    name = Column(String(128), nullable=False, unique=True)
    proxy_name = Column(String(128), nullable=True)


class Bet(Base):
    __tablename__ = "bets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    race_id = Column(Integer, ForeignKey("races.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(BigInteger, nullable=False)
    racer_name = Column(String(64), nullable=False)
    wager = Column(BigInteger, nullable=False)
    payout = Column(BigInteger, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
