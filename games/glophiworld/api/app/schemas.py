from datetime import datetime

from pydantic import BaseModel, Field


class CharacterOut(BaseModel):
    display_name: str
    head_color: str
    body_color: str
    arm_color: str
    leg_color: str
    gender: str
    x: float
    z: float
    facing: float
    # Which Glophics floor this character is currently standing on (0 =
    # ground) — see GlophimonCharacter.floor's own docstring and game.js's
    # own GLOPHICS_FLOORS/local.currentFloor. Persisted/restored the exact
    # same way x/z/facing already are, so a reconnecting client resumes on
    # whatever floor it last left the tower on rather than always
    # respawning on the ground floor.
    floor: int = 0
    current_hp: int
    # Keyed by pose name ("idle"/"walk"/"ready"/"attack"/"defend"/"cast") —
    # see GlophimonCharacter.pose_overrides' own docstring and PUT/DELETE
    # /me/pose-overrides/{pose_name}. Missing key = no override for that pose.
    pose_overrides: dict = Field(default_factory=dict)
    # Keyed by slot name — either one of the 3 reset/orbit camera slots
    # ("wild"/"team"/"pvp") or one of the wild battle's 4 focus-camera
    # slots ("wild_decide_defend"/"wild_declare"/"wild_attack_scene"/
    # "wild_defend_scene") — see GlophimonCharacter.camera_overrides' own
    # docstring and PUT/DELETE /me/camera-overrides/{slot_name}. Missing key
    # = no override, use the built-in framing for that slot.
    camera_overrides: dict = Field(default_factory=dict)


# Deliberately not validating keyframe contents beyond "a list of dicts" —
# this is a per-account cosmetic-only client rendering hint (see
# POSE_DESIGNER_PARTS in game.js), server-trusted the same way every other
# purely-visual client payload in this game already is (character colors,
# display name). A malformed entry can only ever break its own owner's own
# animation, never anyone else's, so there's nothing to defend server-side.
class PoseOverrideUpdate(BaseModel):
    keyframes: list[dict] = Field(min_length=1, max_length=64)


# Unlike PoseOverrideUpdate above, this IS validated with real bounds — the
# Camera Designer only ever exposes 5 well-understood numeric/boolean knobs
# (not an open-ended keyframe blob), and each one has a meaningful physical
# range the client's own sliders already enforce (see CAMERA_DESIGNER_FIELDS
# in game.js): radius/elevation bounds mirror the game's own MIN_ELEVATION/
# MAX_ELEVATION clamp and a sane distance range, angle is a full 0..2π
# revolution, rotateSpeed matches the client slider's own 0..1.0 rad/sec cap.
class CameraOverrideUpdate(BaseModel):
    radius: float = Field(ge=2, le=20)
    # Lower bound moved from 0.05 to -0.65 (5% of headroom below the
    # client's own MIN_ELEVATION=-0.6) — game.js's own overworld camera now
    # allows negative pitch (looking up from below the target) so tall
    # spaces like the cinema room are actually viewable up close; this
    # bound needs to allow the same range or a Camera Designer save using
    # it would get rejected here even though the client's own slider let
    # the player pick it.
    elevation: float = Field(ge=-0.65, le=1.5)
    angle: float = Field(ge=0, le=6.2832)
    autoRotate: bool
    rotateSpeed: float = Field(ge=0, le=1.0)
    # Y-axis (heading) rotation above wraps for free via sin/cos, so it can
    # spin forever — pitch can't do that without flipping the camera upside
    # down, so game.js's own advanceOrbitElevation bounces it between
    # MIN_ELEVATION/MAX_ELEVATION instead. Defaulted (not required) so an
    # older saved override written before this field existed still
    # validates as "no vertical rotation," matching the client's own
    # cameraDesignerDefaultValues fallback.
    elevationRotateSpeed: float = Field(ge=0, le=0.5, default=0.0)


# The wild battle's own focus camera (see focusWildCameraOnRig/
# TEAM_FOCUS_CAM_BEHIND/HEIGHT/LOOK_Y/LOOK_AHEAD in game.js) got 4
# independently-tunable re-aim slots of its own alongside the 3 orbit slots
# above — "wild_decide_defend"/"wild_declare"/"wild_attack_scene"/
# "wild_defend_scene" (see main.py's own FOCUS_CAMERA_SLOTS). Bounds are
# centered around those same shared defaults (behind=1.2, height=2.0,
# lookY=0.2, lookAhead=3) with enough headroom for a genuinely different
# shot (e.g. a lower, closer "attack scene") while still keeping the camera
# from ending up inside a rig or aimed at empty sky/ground.
#
# angle/autoRotate/rotateSpeed/heightRotateSpeed (new) give a focus shot the
# same orbit-around-the-subject capability CameraOverrideUpdate's own
# angle/autoRotate/rotateSpeed/elevationRotateSpeed already give the 3 orbit
# slots — see game.js's own computeFocusCameraFrame (theta parameter) and
# advanceFocusOrbit. Bounds mirror CameraOverrideUpdate's own field-by-field
# (angle: full 0..2π revolution, rotateSpeed: same 0..1.0 rad/sec cap),
# except heightRotateSpeed, which bounces game.js's own FOCUS_CAM_HEIGHT_MIN/
# MAX (0.5..5) instead of MIN_ELEVATION/MAX_ELEVATION — same 0..0.5 cap as
# elevationRotateSpeed either way. All 4 are defaulted (not required), same
# reasoning as elevationRotateSpeed's own default above — an older saved
# focus override predating these fields must still validate, as "no
# rotation," matching the client's own cameraDesignerDefaultValues fallback
# (rotateSpeed/heightRotateSpeed default to 0 here, not RESET_CAM_ORBIT_SPEED
# — a focus shot never rotated at all before this).
class CameraFocusOverrideUpdate(BaseModel):
    behind: float = Field(ge=0.2, le=4)
    height: float = Field(ge=0.2, le=6)
    lookY: float = Field(ge=-2, le=3)
    lookAhead: float = Field(ge=0, le=10)
    angle: float = Field(ge=0, le=6.2832, default=0.0)
    autoRotate: bool = True
    rotateSpeed: float = Field(ge=0, le=1.0, default=0.0)
    heightRotateSpeed: float = Field(ge=0, le=0.5, default=0.0)


class CharacterCreate(BaseModel):
    display_name: str = Field(min_length=1, max_length=64)
    head_color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    body_color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    arm_color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    leg_color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    gender: str = Field(pattern=r"^(male|female|unspecified)$")


class HpUpdate(BaseModel):
    current_hp: int = Field(ge=0)


class SpeciesOut(BaseModel):
    key: str
    name: str
    tier: str  # "legendary" | "rare" | "common"
    types: list[str]  # any of "tank" | "dps" | "support", possibly more than one
    head_color: str
    body_color: str
    arm_color: str
    leg_color: str


class StarterCreate(BaseModel):
    species_key: str


class OwnedOut(BaseModel):
    species_key: str
    level: int
    experience: int
    iv_speed: int
    iv_attack: int
    iv_special_attack: int
    iv_defense: int
    iv_special_defense: int
    ev_speed: int
    ev_attack: int
    ev_special_attack: int
    ev_defense: int
    ev_special_defense: int


class OwnedGlophimonOut(BaseModel):
    id: int
    species_key: str
    species_name: str
    tier: str
    types: list[str]
    level: int
    experience: int
    active_slot: int | None
    iv_speed: int
    iv_attack: int
    iv_special_attack: int
    iv_defense: int
    iv_special_defense: int
    ev_speed: int
    ev_attack: int
    ev_special_attack: int
    ev_defense: int
    ev_special_defense: int
    # None means "full" — see GlophimonOwned.current_hp's own docstring.
    # The client derives max HP from species+level (maxHpFor) and clamps
    # against it, same trust level the rest of battle simulation already
    # has client-side.
    current_hp: int | None = None


class ActivateRequest(BaseModel):
    slot: int = Field(ge=0, le=2)


class CatchRequest(BaseModel):
    # Only the 3 IVs the battle/catch system actually tracks (speed/attack/
    # defense — see main.py's own computeCombatant equivalent on the client)
    # come from the encounter itself; special_attack/special_defense are
    # rolled fresh server-side, same as a starter's, since nothing in the
    # current battle simulation tracks them at all.
    species_key: str
    level: int = Field(ge=1, le=999)
    iv_speed: int = Field(ge=0, le=50)
    iv_attack: int = Field(ge=0, le=50)
    iv_defense: int = Field(ge=0, le=50)


class InventoryOut(BaseModel):
    glophiballs: int
    potions: int
    daily_claim_available: bool
    g_coins: int


class DailyClaimOut(BaseModel):
    inventory: InventoryOut


class KarirsRaceOut(BaseModel):
    id: int
    racer_names: list[str]
    status: str  # "betting_open" | "racing" | "resolved"
    winning_name: str | None
    # Only populated once betting has closed (see the game's own "clients
    # replay it locally against started_at" design) — null while
    # betting_open.
    steps: list[dict] | None
    payout_multipliers: dict[str, float]
    signature_moves: dict[str, str]
    betting_closes_at: datetime
    started_at: datetime | None
    resolved_at: datetime | None


class KarirsBetOut(BaseModel):
    id: int
    race_id: int
    racer_name: str
    wager: int
    payout: int | None
    claimed: bool


class KarirsStateOut(BaseModel):
    race: KarirsRaceOut
    my_bet: KarirsBetOut | None
    # Sum of every won-but-not-yet-claimed payout across *all* resolved
    # races, not just the current one — Karra's own claim prompt (see
    # POST /karirs/claim) is a single lump sum, not per-race.
    unclaimed_total: int
    # The last race to actually finish before `race` — null only when the
    # server has never resolved one yet. Lets the TV offer a "watch the
    # previous race" replay even once betting has reopened and `race`
    # itself has moved on to the next one.
    previous_race: KarirsRaceOut | None


class KarirsBetCreate(BaseModel):
    racer_name: str
    wager: int = Field(ge=1)


class KarirsClaimOut(BaseModel):
    claimed_amount: int
    inventory: InventoryOut


class ShopBuyCreate(BaseModel):
    item_key: str
    quantity: int = Field(ge=1, le=99)


class BattleResultRequest(BaseModel):
    # Client-claimed defeated species/level — trusted only for the Dev-menu
    # "Simulate Wild Battle" path (no real wild_id); whenever wild_id is
    # present the server overrides both from its own wild_spawns record
    # (see main.py's apply_battle_result), the same authority pattern
    # /wild/{id}/release and /wild/{id}/caught already use.
    defeated_species_key: str
    defeated_level: int = Field(ge=1, le=999)
    outcome: str = Field(pattern=r"^(win|caught)$")
    participant_ids: list[int] = Field(min_length=1, max_length=3)
    wild_id: int | None = None


class BattleResultParticipant(BaseModel):
    id: int
    exp_gained: int
    level_before: int
    level_after: int


class GlophimonHpEntry(BaseModel):
    id: int
    current_hp: int = Field(ge=0)


class GlophimonHpUpdate(BaseModel):
    # Bulk, same shape the client's own syncOwnedGlophimonHp batches up —
    # one call at the end of every battle (win, catch, escape, or loss) for
    # every real (owned) team member that fought, plus Rodz's heal sending
    # the whole roster back to full in one shot.
    updates: list[GlophimonHpEntry] = Field(min_length=1, max_length=200)


class BattleResultOut(BaseModel):
    # The full re-sorted roster, same shape/convention every other
    # roster-mutating endpoint (activate/deactivate/catch/release) already
    # returns — lets the client refresh its menu state the same way it
    # already does for those. participants carries the per-Glophimon
    # EXP/level-up deltas the battle log needs to actually announce, since
    # OwnedGlophimonOut alone (an end-state snapshot) can't tell the client
    # how much just changed.
    glophimon: list[OwnedGlophimonOut]
    participants: list[BattleResultParticipant]
