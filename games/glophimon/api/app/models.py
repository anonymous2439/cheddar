from sqlalchemy import BigInteger, Boolean, Column, Date, DateTime, Enum, Float, ForeignKey, Integer, String, UniqueConstraint, text
from sqlalchemy.dialects.mysql import JSON
from sqlalchemy.sql import func

from app.db import Base


class GlophimonCharacter(Base):
    """One row per Cheddar account, ever — created once via POST /me and
    never edited afterward (no PUT/PATCH this phase), matching the product
    requirement that character creation only ever happens once. x/z/facing
    are the persistence layer that makes "teleported to where they last
    left" work: written on a throttled timer while connected and once more,
    unconditionally, on disconnect (see main.py's world_ws) so the latest
    position always survives even between throttled saves.

    pose_overrides is the one deliberate exception to "never edited
    afterward" above — see PUT/DELETE /me/pose-overrides/{pose_name}. A
    dict keyed by pose name ("idle"/"walk"/"ready"/"attack"/"defend"/
    "cast") to {"keyframes": [...]} , written by the Pose Designer dev
    panel's own "Save to Game" button (see game.js). Missing key or null
    value both mean "no override — use the built-in pose," same as an
    empty dict; the client never needs to distinguish those two.

    camera_overrides is the same idea for the Camera Designer dev panel —
    see PUT/DELETE /me/camera-overrides/{slot_name}. Two different shapes
    live in this one dict, disambiguated purely by which slot_name key
    they're stored under (see ORBIT_CAMERA_SLOTS/FOCUS_CAMERA_SLOTS in
    main.py):
      - "wild"/"team"/"pvp" -> {"radius":..., "elevation":..., "angle":...,
        "autoRotate":..., "rotateSpeed":...} (see CameraOverrideUpdate in
        schemas.py), customizing that battle type's reset/orbit camera — the
        wide "nothing focused" fallback framing.
      - "wild_decide_defend"/"wild_declare"/"wild_attack_scene"/
        "wild_defend_scene" -> {"behind":..., "height":..., "lookY":...,
        "lookAhead":...} (see CameraFocusOverrideUpdate in schemas.py),
        independently customizing one of the wild battle's own focus-camera
        re-aim moments (see game.js's own focusWildCameraOnRig and
        TEAM_FOCUS_CAM_* for the shared defaults each one falls back to).
        The 3v3 team battle's own near-identical focus camera
        (focusCameraOnMember) is NOT covered by any of these — it stays
        hardcoded, out of scope.
    Missing key or null value both mean "no override — use the built-in
    framing," same as pose_overrides above."""

    __tablename__ = "glophimon_characters"

    user_id = Column(BigInteger, primary_key=True)
    display_name = Column(String(64), nullable=False)
    head_color = Column(String(7), nullable=False)
    body_color = Column(String(7), nullable=False)
    arm_color = Column(String(7), nullable=False)
    leg_color = Column(String(7), nullable=False)
    gender = Column(String(20), nullable=False)  # "male" | "female" | "unspecified"
    x = Column(Float, nullable=False, default=0.0)
    z = Column(Float, nullable=False, default=0.0)
    facing = Column(Float, nullable=False, default=0.0)
    # Which Glophics floor this character is currently on (0 = ground) —
    # the first piece of real vertical/Y-axis state in this entire game.
    # Persisted/restored via the exact same throttled-write-while-connected
    # + unconditional-write-on-disconnect mechanism as x/z/facing above
    # (see main.py's world_ws/persist_position), so a reconnecting client
    # resumes on whatever floor of the tower it last left, not always back
    # on the ground. See game.js's own GLOPHICS_FLOORS for what a non-zero
    # value maps to spatially.
    floor = Column(Integer, nullable=False, default=0)
    # The player's own trainer HP (separate from any individual Glophimon's
    # own HP, which is never persisted — it's recomputed fresh from level/
    # IVs/EVs at the start of every battle). Doesn't recharge on its own
    # between battles — see main.py's PLAYER_MAX_HP and POST /me/hp — only
    # Rodz's heal (or blacking out, which heals for free at the cost of a
    # trip back to Glophics) restores it.
    current_hp = Column(Integer, nullable=False, default=200)
    pose_overrides = Column(JSON, nullable=True)
    camera_overrides = Column(JSON, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())


class GlophimonOwned(Base):
    """One row per Glophimon a player owns — starts with exactly one (their
    starter, created via POST /starter) and will grow via a future catch
    system. species_key looks up the static SPECIES catalog in main.py (not
    its own DB table — a fixed 25-entry roster, same "duplicated constant,
    not a table" convention every other game in this project already uses
    for its own roster).

    IV is rolled once at creation (0-50 per stat, "genetic potential",
    fixed forever) — EV starts at zero and grows through training: winning
    or catching a real wild encounter (see main.py's own
    apply_battle_result/EV_YIELD_BY_SPECIES) awards EV in whichever stat(s)
    the *defeated* species trains, same "who you grind against determines
    what you're training" identity real Pokémon has. HP has no IV/EV of
    its own — it's a fixed-per-species base that grows with level only
    (see SPECIES catalog and main.py's own stat formula/maxHpFor).

    current_hp is the persisted battle wound — nullable, where NULL means
    "full" (max HP is derivable from species+level alone, so there's no
    need to backfill a concrete number at creation time, or recompute it
    here server-side just to store it). No longer reset to full at the
    start of every battle (see the client's own startWildBattle) — only
    Rodz's heal (POST /me/glophimon/hp, same call the client's move engine
    uses to persist battle damage) restores it, matching how
    GlophimonCharacter.current_hp already works for the trainer.

    experience accumulates toward the next level (see main.py's own
    _exp_for_level, level ** 3 — Pokémon's "Medium Fast" growth rate) up to
    level 100; both level and experience are updated by
    apply_battle_result, the only place either ever changes after this row
    is first created.

    speed/attack/special_attack/defense/special_defense are the 5 trainable
    stats (see the game's own plan notes) — deliberately no HP IV/EV
    columns.

    active_slot is 0/1/2 for a spot in the battle lineup, or NULL for
    "boxed" in the PC — the player's menu (GET /me/glophimon) lets them
    move Glophimon between the two (POST .../activate, .../deactivate); a
    future catch system will auto-box a newly caught Glophimon whenever
    all 3 active slots are already taken, per the same rule. The unique
    constraint below is what actually enforces "at most one Glophimon per
    active slot per account" — MySQL treats each NULL as distinct for
    uniqueness purposes, so any number of boxed (NULL) rows for the same
    user coexist fine; only two rows both claiming the *same* real slot
    number would collide."""

    __tablename__ = "glophimon_owned"
    __table_args__ = (UniqueConstraint("user_id", "active_slot", name="uq_glophimon_owned_user_active_slot"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(BigInteger, nullable=False, index=True)
    species_key = Column(String(32), nullable=False)
    level = Column(Integer, nullable=False, default=1)
    experience = Column(Integer, nullable=False, default=0)
    active_slot = Column(Integer, nullable=True)  # 0, 1, 2 = active lineup position; NULL = in the PC
    iv_speed = Column(Integer, nullable=False)
    iv_attack = Column(Integer, nullable=False)
    iv_special_attack = Column(Integer, nullable=False)
    iv_defense = Column(Integer, nullable=False)
    iv_special_defense = Column(Integer, nullable=False)
    ev_speed = Column(Integer, nullable=False, default=0)
    ev_attack = Column(Integer, nullable=False, default=0)
    ev_special_attack = Column(Integer, nullable=False, default=0)
    ev_defense = Column(Integer, nullable=False, default=0)
    ev_special_defense = Column(Integer, nullable=False, default=0)
    current_hp = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())


class GlophimonInventory(Base):
    """The player's bag — one row per account, created alongside their
    starter (see main.py's create_starter). Just item counts for now
    (Glophiballs for catching, Potions for healing) — catching itself, and
    what Potions actually do, are both an explicitly separate later
    discussion; this table only needs to exist and hold a starting stock
    so the bag isn't empty the first time the menu is opened.

    last_daily_claim_date is Rodz's free-Glophiballs claim (see
    POST /me/inventory/claim-daily) — a plain calendar date (UTC), not a
    timestamp: null means never claimed, otherwise the date it was last
    claimed. Eligibility is just today's UTC date != this value.

    g_coins ("G") is the Karirs field's own currency — every account starts
    with 1000, spent placing bets and earned back (with a multiplier) by
    winning them (see main.py's place_karirs_bet/claim_karirs_prize).
    Deliberately a separate balance from glophiballs, which never touch
    Karirs at all. server_default (not just the ORM-side default) so the
    ALTER TABLE that introduced this column could backfill every existing
    account to 1000 in the same migration."""

    __tablename__ = "glophimon_inventory"

    user_id = Column(BigInteger, primary_key=True)
    glophiballs = Column(Integer, nullable=False, default=5)
    potions = Column(Integer, nullable=False, default=0)
    last_daily_claim_date = Column(Date, nullable=True)
    g_coins = Column(Integer, nullable=False, default=1000, server_default=text("1000"))


class KarirsRacer(Base):
    """The Karirs field's own roster — same 25 colleague names/signature
    moves games/karirs uses (see main.py's KARIRS_SEED_RACERS), but its own
    independent win/loss history: this is a genuinely separate race market
    with its own outcomes, not a shared record with that other game."""

    __tablename__ = "karirs_racers"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(64), nullable=False, unique=True)
    wins = Column(Integer, nullable=False, default=0)
    losses = Column(Integer, nullable=False, default=0)
    races_run = Column(Integer, nullable=False, default=0)
    signature_move = Column(String(128), nullable=True)


class KarirsRace(Base):
    """One global race at a time — no lobby concept, this is the one shared
    persistent world's own race, on a fixed hourly cadence rather than
    created on demand (see main.py's karirs scheduler). steps/
    payout_multipliers are frozen the instant betting closes, same "clients
    replay it locally against started_at" design games/karirs already
    proved out."""

    __tablename__ = "karirs_races"

    id = Column(Integer, primary_key=True, autoincrement=True)
    racer_names = Column(JSON, nullable=False)
    status = Column(Enum("betting_open", "racing", "resolved"), nullable=False, default="betting_open")
    winning_name = Column(String(64), nullable=True)
    steps = Column(JSON, nullable=True)
    payout_multipliers = Column(JSON, nullable=True)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    # unique: closes the TOCTOU window where two processes (the known
    # duplicate-spawn-on-restart case) both decide "no pending race, create
    # one" for the same hour boundary — the loser's INSERT now fails
    # instead of leaving two competing races (see main.py's
    # _karirs_create_next_race).
    betting_closes_at = Column(DateTime, nullable=False, unique=True)
    started_at = Column(DateTime, nullable=True)
    resolved_at = Column(DateTime, nullable=True)


class KarirsBet(Base):
    """claimed tracks Karra's own prize-claim flow (see POST
    /karirs/claim) — a won bet's payout sits here, unclaimed, until the
    player actually walks up and claims it; nothing credits their bag
    automatically the instant a race resolves."""

    __tablename__ = "karirs_bets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    race_id = Column(Integer, ForeignKey("karirs_races.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(BigInteger, nullable=False, index=True)
    racer_name = Column(String(64), nullable=False)
    wager = Column(Integer, nullable=False)
    payout = Column(Integer, nullable=True)
    claimed = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, server_default=func.now())
