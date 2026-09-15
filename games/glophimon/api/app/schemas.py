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
    current_hp: int


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
