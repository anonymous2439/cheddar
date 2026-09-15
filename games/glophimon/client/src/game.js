// Glophimon overworld — a single persistent shared space (same shape as
// GL Sims World, see games/glsimsworld/client/src/game.js, which this file
// closely follows for its camera/movement/peer-easing/network-tick code)
// but with a genuinely new rig (blocky "Roblox-style" avatars, see
// ./character.js) and real per-account persistence: every character here
// is permanent and always spawns at exactly the position the server last
// saved for it (see ctx.character below) — there is no racer claim/
// scarcity system at all, since every account owns its own character
// forever.
//
// Movement is fully client-authoritative (this client decides its own
// position from keyboard input and just broadcasts it — see
// net/glophimonSocket.js); the server only relays it to peers and
// periodically persists it.
//
// No chat in this phase (not asked for) — the creature/battle system is an
// explicitly separate, later discussion (see this game's own plan file).
import * as THREE from "three";
import {
  buildBlockyCharacter,
  applyIdlePose,
  updateWalkCycle,
  applyAttackPose,
  applyDefendPose,
  applyCastPose,
  applyReadyPose,
  syncNameLabel,
  scaleNameLabel,
  disposeRig,
  recolorRig,
  updateTargetFlash,
  buildGlophiballMesh,
  disposeGlophiball,
} from "./character.js";
// The chat-bubble sprite primitives GL Sims World's own conversation
// system uses, reused as-is for Rodz's ambient shout loop (see
// RODZ_SHOUT_TEXT/updateRodzShout) — this game has no ambient-conversation
// system of its own to attach them to, just these building blocks.
import {
  createChatBubble,
  scaleChatBubble,
  positionChatBubbleAt,
  disposeChatBubble,
  computeBubbleAnchorWorld,
} from "../../../glsims/client/src/character.js";
import { connectGlophimonSocket, NETWORK_TICK_MS } from "./net/glophimonSocket.js";
// Single source of truth for species/moves/combat constants, shared with the
// server's own Python port (games/glophimon/api/app/combat_data.py) so the
// two never silently drift apart — see the PVP Stage 2 plan.
import combatData from "../../shared/combat_data.json";

// Doubled from GL Sims World's original 40/40 — big enough to feel like a
// real island once the surrounding ocean is added (see buildGround/the
// ocean plane below). Must stay in sync with the server's own
// WORLD_ARENA_HALF_X/Z (main.py) — same manually-paired-constant convention
// already established for LUBA_X/Z/HALF.
const ARENA_HALF_X = 80;
const ARENA_HALF_Z = 80;
const MOVE_SPEED = 1.3;

// Glophics — the one walled town, sitting at the exact center of the map
// (see buildTown, which lays its walls out via the shared buildAreaWalls —
// the Karirs field, further below, is walled the same way and pushes its
// own segments into this same townWallSegments array). The api's own
// DEFAULT_SPAWN puts every brand-new character at (0,0), which is exactly
// the town's center, so first-time players always start inside its walls.
// Wild Glophimon are never allowed to spawn (or wander/chase/flee) inside
// either walled area's footprint — enforced server-side now (see games/
// glophimon/api's own TOWN_NO_SPAWN_HALF_X/Z + KARIRS_NO_SPAWN_HALF_X/Z and
// is_inside_town_walls, a direct port of this same wall layout) —
// isInsideTownWalls below is what the *player's* own movement resolves
// against, so nobody just walks through a solid wall.
const TOWN_NAME = "Glophics";
const TOWN_HALF_X = 9;
const TOWN_HALF_Z = 9;
const TOWN_WALL_THICKNESS = 0.6;
const TOWN_WALL_HEIGHT = 2.4;
const TOWN_DOOR_HALF_WIDTH = 2.2; // half-width of the gap left in each wall for its doorway
const TOWN_WALL_COLOR = "#8d8d8d";
// Walls stay fully solid by default — only the specific segment(s) that
// actually sit between the camera and your own character fade out, and
// only while they're actually in the way (see updateTownWallFade).
const TOWN_WALL_OCCLUDED_OPACITY = 0.15;
const TOWN_WALL_FADE_RATE = 8; // per-second ease rate for the opacity lerp, so it fades in/out rather than snapping
const TOWN_DOOR_POST_COLOR = "#7c4a2d";
const TOWN_PLAZA_COLOR = "#c9b38c";

// Sprinting — hold Shift while moving to run at SPRINT_SPEED_MULTIPLIER,
// draining a stamina meter; regenerates whenever not sprinting (whether
// standing still or just walking normally). Once stamina hits zero,
// sprinting locks out — and the bar stays red — until it's fully
// recharged back to STAMINA_MAX, not just some partial amount; a full
// recovery reads as a clearer "you're good to go again" cue than the bar
// flipping back to blue partway through regenerating.
const SPRINT_SPEED_MULTIPLIER = 1.9;
const STAMINA_MAX = 100;
const STAMINA_DRAIN_PER_SEC = 28;
const STAMINA_REGEN_PER_SEC = 18;

const CAMERA_RADIUS = 10;
const CAMERA_HEIGHT = 7;
const CAMERA_ELEVATION = Math.atan2(CAMERA_HEIGHT, CAMERA_RADIUS);
const DEFAULT_CAM_ANGLE = 0;
const MIN_ZOOM_RADIUS = 5;
// Bumped alongside the bigger map (see ARENA_HALF_X/Z) — otherwise the
// player could never zoom out far enough to actually see the island's
// coastline/ocean.
const MAX_ZOOM_RADIUS = 70;
const ZOOM_SPEED = 0.02;
const MIN_ELEVATION = 0.1;
const MAX_ELEVATION = 1.45;
const DRAG_SENSITIVITY = 0.006;
const CAMERA_FOLLOW_LERP_SPEED = 6;
const PAN_TARGET_Y = 1;

// Same 25-species catalog as games/glophimon/api/app/main.py's own SPECIES
// — duplicated here rather than fetched, same "every surface keeps its own
// copy of shared reference data" convention as every roster elsewhere in
// this project (see e.g. glsimsworld's own ROSTER). Fetching it live would
// mean a raw browser-context fetch from inside the webview, which is
// exactly the CORS trap Model Viewer's own early mistake already taught
// this project to avoid. Order/keys must be kept in sync by hand with the
// backend's own copy.
const SPECIES = combatData.species;
const SPECIES_BY_KEY = Object.fromEntries(SPECIES.map((s) => [s.key, s]));

// Rarity-weighted species selection — used for the Dev menu's own
// "Simulate Wild Battle" button (the real shared-world ambient spawns are
// rolled server-side, main.py's own RARITY_PERCENT is the actual authority
// there — this copy is kept in sync with it so local dev testing reflects
// the same designed rarity), but deliberately NOT for the 3v3 battle's
// random NPC teammates/opponents, which is a different simulated system
// (team composition), not "you encountered something in the wild." Each
// tier gets a fixed total percentage, split evenly across however many
// species sit in that tier — so adding/removing a species from a tier
// automatically rebalances everyone else in it rather than needing the
// percentages hand-tuned again. Tuned against the actual server-side spawn
// roll rate (see main.py's own comment): legendary=0.0004 -> ~1 expected
// legendary/week, rare=0.0019 -> ~1 expected rare every ~1.5 days — both
// expected counts, not guarantees.
const RARITY_PERCENT = { legendary: 0.0004, rare: 0.0019, common: 99.9977 };
const SPECIES_TIER_COUNTS = SPECIES.reduce((acc, s) => {
  acc[s.tier] = (acc[s.tier] || 0) + 1;
  return acc;
}, {});
const SPECIES_WEIGHTS = SPECIES.map((s) => RARITY_PERCENT[s.tier] / SPECIES_TIER_COUNTS[s.tier]);
const SPECIES_WEIGHT_TOTAL = SPECIES_WEIGHTS.reduce((a, b) => a + b, 0); // sums to 100 — RARITY_PERCENT's own values already do

function pickRandomSpeciesByRarity() {
  let roll = Math.random() * SPECIES_WEIGHT_TOTAL;
  for (let i = 0; i < SPECIES.length; i++) {
    roll -= SPECIES_WEIGHTS[i];
    if (roll <= 0) return SPECIES[i];
  }
  return SPECIES[SPECIES.length - 1]; // float-rounding fallback, not normally reached
}

// Battle — a solo simulation against a scripted wild Glophimon (see the
// game's own plan file): no server involvement at all, HP/PP/outcome are
// all thrown away when the battle ends. BASE_HP/BASE_STAT are explicitly
// provisional placeholders — no real per-species stats have been designed
// yet, so every species uses the same base for now; only IV rolls (and
// eventually EV training) differentiate individuals. Attack is the only
// move that exists this phase (unique moves are deferred).
const BASE_HP = combatData.baseHp;
const BASE_STAT = combatData.baseStat;
const IV_MIN = 0;
const IV_MAX = 50;
// Display-only mirror of the api's own _exp_for_level (level ** 3,
// Pokémon's "Medium Fast" growth rate) — used just to render the stats
// modal's EXP-to-next-level readout; the server is the sole authority on
// when a level-up actually happens (see POST /me/glophimon/battle-result).
const MAX_LEVEL = 100;
function expForLevel(level) {
  return level ** 3;
}
// key/name/kind added so this can sit in the same moves array as every
// species' own special move(s) (see movesForSpecies) — Attack is just the
// one move every Glophimon always has, not a structurally different thing.
const ATTACK_MOVE = combatData.attackMove;
const DEFEND_ACCURACY_PENALTY = combatData.defendAccuracyPenalty;
const DEFEND_DAMAGE_MULTIPLIER = combatData.defendDamageMultiplier;
const WILD_DEFEND_CHANCE = 0.5; // "completely random" wild commands, see the plan

// Every Glophimon's own special move(s), on top of the generic Attack — see
// resolveMove for how each field is interpreted, and combat_data.json for
// the actual per-species data (shared with the server's own Python port).
// kind selects which fields are meaningful: "damage" (power/accuracy/hits/
// recoilPercent/drainPercent/ignoresDefense/flinchChance, routes through the
// same defend-matching pipeline as Attack), "debuff" (targets the opponent
// the same way damage does, but applies debuffStat/debuffPercent/
// debuffTurns or forcedDefenderTurns — a "taunt" that narrows the
// defender-selection UI down to just that one member — instead of
// subtracting HP), or "heal"/"buff" (target: "self"|"ally"|"team", resolves
// immediately at declare-confirm time since there's no opponent to defend
// against a heal — healPercent/buffStat+buffPercent+buffTurns/
// shieldNextHit/reflectPercent/cleanse, any combination the move needs).
const MOVES_BY_SPECIES = combatData.movesBySpecies;
const MOVE_BY_KEY = Object.fromEntries([ATTACK_MOVE, ...Object.values(MOVES_BY_SPECIES).flat()].map((m) => [m.key, m]));
// Every move a given species can use — the generic Attack every Glophimon
// always has, plus whatever special move(s) its own entry in
// MOVES_BY_SPECIES carries. Used both to seed a fresh combatant's
// per-move PP (see computeCombatant) and to build the declare-step's
// move-selection buttons (see showWildDeclareStep/showPlayerDeclareStep).
function movesForSpecies(speciesKey) {
  return [ATTACK_MOVE, ...(MOVES_BY_SPECIES[speciesKey] || [])];
}

const STAT_LABELS = { speed: "Speed", attack: "Attack", special_attack: "Sp. Attack", defense: "Defense", special_defense: "Sp. Defense" };

// A plain-language Pokedex-style description generated straight from a
// move's own data fields (see the MOVES_BY_SPECIES schema) rather than a
// hand-authored string per move — 29 separate descriptions would just be
// the same information restated, and drift out of sync with the real
// mechanics the first time a number changes. Used by the Glophimon stats
// modal (openGlophimonStatsModal) — the only place "what does this move
// actually do" needs to be spelled out for a human.
function describeMove(move) {
  const pct = (fraction) => Math.round(fraction * 100);
  const parts = [];
  if (move.kind === "damage") {
    parts.push(`Deals damage`);
    if (move.hits) parts.push(`hits ${move.hits[0] === move.hits[1] ? move.hits[0] : `${move.hits[0]}-${move.hits[1]}`} times`);
    if (move.ignoresDefense) parts.push(`ignores the target's Defense`);
    if (move.recoilPercent) parts.push(`the user takes ${pct(move.recoilPercent)}% of the damage dealt as recoil`);
    if (move.drainPercent) parts.push(`the user recovers ${pct(move.drainPercent)}% of the damage dealt as HP`);
    if (move.flinchChance) parts.push(`${pct(move.flinchChance)}% chance to make the target flinch (skip its next move)`);
  } else if (move.kind === "heal") {
    const who = move.target === "team" ? "the whole team" : move.target === "ally" ? "an ally" : "itself";
    parts.push(`Restores ${pct(move.healPercent)}% max HP to ${who}`);
    if (move.cleanse) parts.push(`clears the target's negative effects`);
  } else if (move.kind === "buff") {
    const who = move.target === "ally" ? "an ally" : "itself";
    const whosePossessive = move.target === "ally" ? "the ally's" : "its own";
    if (move.healPercent) parts.push(`Restores ${pct(move.healPercent)}% max HP to ${who}`);
    if (move.buffStat) parts.push(`${parts.length ? "raises" : "Raises"} ${whosePossessive} ${STAT_LABELS[move.buffStat]} by ${pct(move.buffPercent)}% for ${move.buffTurns} turns`);
    if (move.shieldNextHit) parts.push(`${parts.length ? "shields" : "Shields"} ${who} from the next hit entirely`);
    if (move.reflectPercent) parts.push(`${parts.length ? "reflects" : "Reflects"} ${pct(move.reflectPercent)}% of incoming damage back at the attacker`);
  } else if (move.kind === "debuff") {
    if (move.debuffStat) parts.push(`Lowers the target's ${STAT_LABELS[move.debuffStat]} by ${pct(move.debuffPercent)}% for ${move.debuffTurns} turns`);
    if (move.forcedDefenderTurns) parts.push(`${parts.length ? "forces" : "Forces"} the target to defend for the next ${move.forcedDefenderTurns} rounds`);
  }
  return parts.join("; ") + ".";
}

// One full-width row per move — the button plus a plain-language
// description (see describeMove) beside it — used by both battle modes'
// own declare step (showWildDeclareStep/showPlayerDeclareStep). A row
// filling the whole container width always starts a new line inside a
// flex-wrap row (dynamicActionsEl/teamActionsEl), so move choices read
// top-to-bottom one per line without needing to touch those containers'
// own layout — the smaller Idle/Back/defend buttons every other step
// already renders there still wrap shoulder-to-shoulder as before.
function buildMoveOptionRow(move, pp, onClick) {
  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.justifyContent = "space-between";
  row.style.gap = "8px";
  row.style.width = "100%";
  const btn = document.createElement("button");
  btn.textContent = `${move.name} (${pp} PP)`;
  btn.style.fontSize = "11px";
  btn.disabled = pp <= 0;
  btn.addEventListener("click", onClick);
  row.appendChild(btn);
  const desc = document.createElement("span");
  desc.style.fontSize = "10px";
  desc.style.color = "#a3a3a3";
  desc.style.textAlign = "right";
  desc.style.flex = "1";
  desc.textContent = describeMove(move);
  row.appendChild(desc);
  return row;
}

// Catching — simulated for now via the Dev menu's "Simulate Wild Battle"
// (real persistence/integration with the actual Glophiball inventory is a
// later step). Catch rate is purely HP-based today: linearly interpolated
// from CATCH_RATE_FULL_HP at full HP down to... rather, UP to
// CATCH_RATE_LOW_HP at 1 HP (lower HP = easier catch), capped at
// CATCH_RATE_MAX overall — the gap between CATCH_RATE_LOW_HP and
// CATCH_RATE_MAX is deliberately left for move/status effects that don't
// exist yet (e.g. a future sleep/paralysis move), so the HP-only formula
// itself never actually reaches the cap yet. A fainted (0 HP) wild
// Glophimon can no longer be caught at all — see computeCatchChance.
// Deliberately low even at near-death — catching used to be a near-
// guarantee once the wild was worn down; a real attempt (several thrown
// balls, not one) should now be the norm.
const CATCH_RATE_FULL_HP = 3;
const CATCH_RATE_LOW_HP = 30; // at 1 HP, the lowest a Glophimon can have before fainting
const CATCH_RATE_MAX = 55; // never 100%, and not reachable by HP alone (see above)

// Catch animation — a Glophiball is thrown at the wild Glophimon (arcs from
// your own Glophimon's position to theirs), which shrinks into it on
// arrival, then the ball shakes in suspense before revealing the outcome
// that was actually already rolled the instant the ball was thrown (same
// "roll first, animate the reveal after" convention as the real games this
// is modeled on) — a successful catch pulses the ball and ends the battle;
// a failed one pops the wild Glophimon back out at full size and hands the
// turn to the wild side, same as before this animation existed.
const CATCH_THROW_MS = 450;
const CATCH_THROW_ARC_HEIGHT = 0.7;
const CATCH_SUCKIN_MS = 350;
const CATCH_SHAKE_MS = 1500;
const CATCH_SHAKE_CYCLES = 4;
const CATCH_SHAKE_AMOUNT = 0.35; // radians
const CATCH_REVEAL_MS = 400; // caught outcome — just a quick confirm pulse, camera doesn't need to go anywhere
const CATCH_POPOUT_MS = 900; // not-caught outcome — long enough for the "getting big again" grow-back to actually read, alongside the camera easing back out
const CATCH_BALL_GROUND_Y = 0.16;

// Battle-opening intro (see startWildBattle's own battle.introAnim and
// updateIntroAnim) — the dome rises from the ground first, then your own
// team pops out of a Glophiball each (reversing the catch system's own
// shrink-into-the-ball animation) — the wild deliberately isn't part of
// this: it's a wild creature, not something you threw a ball at, so it
// gets its own separate "arrive" phase afterward where it simply
// materializes on its own while the camera eases from the wide intro
// framing to its real first-round focus, so beginRound's own snap-to-focus
// lands exactly where the camera already is. Nothing is interactive until
// all of this finishes.
const BATTLE_INTRO_DOME_MS = 500;
const BATTLE_INTRO_SPAWN_MS = 500;
const BATTLE_INTRO_ARRIVE_MS = 700;

// Camera zoom-in on the ball during suckin/shake (see updateCatchAnim) —
// eased continuously toward a target each frame (not a fixed-duration
// tween like the pose/scale animations above), same "ease toward a moving
// target" style as the overworld's own follow-cam, just slow enough to
// read as a deliberate suspense build rather than a snap-cut. Eases back
// out to the battle's normal focus (see battle.focus) the same way if the
// catch fails.
const CATCH_CAM_EASE_RATE = 1.6;
const CATCH_CAM_ZOOM_BEHIND = 0.9; // how far back from the ball the zoomed-in camera sits
const CATCH_CAM_ZOOM_HEIGHT = 1.1;
// Glophimon creature rigs (built with the exact same buildBlockyCharacter
// as player avatars) are scaled down to this fraction of their normal
// height — purely visual, makes it obvious at a glance which rigs are
// actual Glophimon versus real player-controlled avatars (never applied to
// local.rig or any peer's rig). Scaling rig.group (not just rig.visual)
// so the name label's position — a sibling of visual, not a descendant —
// moves down with the now-shorter body instead of floating at full-size
// head height above a shrunken one.
const CREATURE_SCALE = 0.6;

// Roaming wild Glophimon — genuinely shared now: the server (see
// games/glophimon/api's own wild_tick_loop) owns spawning, lifespan, and
// wander/flee/chase movement, broadcasting all of it over the world
// socket so every connected player sees the exact same creatures at the
// exact same positions (see ensureWildSpawn/updateWildSpawns further
// below). What's left purely client-side, per-viewer: the name label
// color (red = higher level than *your own* starter, harder; yellow = at
// or below your level, easy) and the vision-cone wedge's matching color —
// cosmetic only, the actual flee-vs-chase decision is the server's now.
// A wild is exclusive once engaged (see WILD_CONTACT_RADIUS/
// checkWildContact and the api's own /wild/{id}/engage) — only the
// engaging player ever actually battles a given one.
const WILD_LEVEL_MIN = 1;
const WILD_LEVEL_MAX = 20;
const WILD_LABEL_COLOR_HARD = "#ef4444"; // red — higher level than the player, harder to defeat
const WILD_LABEL_COLOR_EASY = "#facc15"; // yellow — at or below the player's level, easy
const WILD_VISION_RANGE = 6; // matches the server's own value, purely for sizing the cosmetic vision wedge
const WILD_VISION_HALF_ANGLE = Math.PI / 4; // 45° either side of their own facing — a 90° cone, not a full circle
const WILD_VISION_WEDGE_COLOR_HARD = 0xef4444;
const WILD_VISION_WEDGE_COLOR_EASY = 0xfacc15;
const WILD_VISION_WEDGE_OPACITY = 0.22;
const WILD_CONTACT_RADIUS = 1.0; // close enough to actually bump into one and trigger a real battle

const MINIMAP_SIZE = 140; // px, square
const MINIMAP_BACKGROUND_COLOR = "#1a2e1a80"; // ~50% opacity — visible as its own panel without fully blocking the view behind it
// Other connected players — a violet distinct from every other minimap dot
// (red/yellow wilds, Rodz's own red, the local player's cyan), with the
// same white outline the local player's own dot gets so it reads as
// "another live player," not just another map marker.
const PEER_MINIMAP_COLOR = "#a78bfa";
const BATTLE_HUD_BACKGROUND_COLOR = "#1a1a1a99"; // ~60% opacity — same "readable but not blocking the view" idea for the floating HP-bar HUD

const BATTLE_DOME_RADIUS = 4.5;
const BATTLE_PLAYER_MON_OFFSET = 1.4; // in front of the player, along their current facing
const BATTLE_WILD_OFFSET = 3.2; // further out along the same line, facing back at the player's Glophimon
// A wild encounter now fields your whole active lineup (1-3, whatever you
// actually have — see getActiveLineup), not always just your starter — and
// every non-fainted member can act independently each of your attack
// rounds (Attack or Idle, same as the 3v3 battle's own per-member declare
// phase — see beginPlayerDeclare), with idling keeping a teammate eligible
// to defend the wild's next attack.
const WILD_TEAM_MAX_SIZE = 3;
const WILD_TEAM_MEMBER_SPACING = 1.1; // lateral gap between your own team's members, same spacing the 3v3 battle's own row uses
const BATTLE_CAM_RADIUS = 4.5; // tighter than the default follow-cam radius — these are small figures, and the attack/defend poses need to actually read
const BATTLE_CAM_ELEVATION = 0.5;
// A pure 90-degree side view (facingAngle + PI/2) foreshortens the attack/
// defend poses almost to nothing, since both swing forward/back along the
// combatants' own facing axis — straight toward/away from a strict side
// camera rather than sweeping across it (confirmed directly: rotation
// values peaked correctly at ~1.5 rad, but were barely visible on screen
// at that angle). A three-quarter angle instead shows enough of the front
// of both rigs for the swing to actually read.
const BATTLE_CAM_ANGLE_OFFSET = Math.PI * 0.35;
const ATTACK_ANIM_MS = 850; // longer, full-blast swing-through (was 500) — long enough for the wider leg-spread stance to actually read
const DEFEND_ANIM_MS = 600;
const CAST_ANIM_MS = 700; // heal/buff/debuff moves — see applyCastPose
const ANIM_SETTLE_MS = Math.max(ATTACK_ANIM_MS, DEFEND_ANIM_MS, CAST_ANIM_MS) + 150; // gives the pose time to actually play before the next round's buttons appear
// How long a win/catch's EXP-award round-trip gets before giving up and
// revealing Continue anyway (see awardBattleResult) — a network hiccup
// should never be able to soft-lock the battle screen.
const BATTLE_RESULT_TIMEOUT_MS = 4000;
const RESET_CAM_ORBIT_SPEED = 0.12; // rad/sec — slow satellite-style drift while the wide/reset battle camera has no specific focus

// 3v3 "PvP-format" battle — the full original battle design (attacker side
// commands each of its 3 Glophimon Attack/Idle, the defender side assigns
// its own idle Glophimon to block specific incoming attacks, anything
// unblocked drains that side's own trainer HP directly) — you control
// "Your Team" (your real starter + 2 random placeholder teammates, since
// there's no multi-Glophimon roster yet), the NPC Team is fully random.
// Kept as a separate `teamBattle` state (below) from the 1-vs-1 wild
// battle's `battle` state rather than unifying two structurally different
// shapes into one.
const TEAM_SIZE = 3;
const PLAYER_MAX_HP = 200; // same "~4-5x a typical hit" placeholder reasoning as the wild battle's own design discussion
const TEAM_ATTACK_CHANCE = 0.8; // each living attacker independently rolls Attack vs Idle
// Layout, front-to-back along the player's facing line: the player stands
// still at their own real position (offset 0 — "the Glophimon are supposed
// to be the defender of the players," not the other way around, so the
// player never stands between the two teams); their own row of 3 sits out
// in front of them; the NPC's row sits further out still, facing back;
// the NPC trainer stands behind their own row, mirroring the player.
const TEAM_PLAYER_ROW_OFFSET = 2.0;
const TEAM_ROW_GAP = 3.0; // battle space between the two rows
const TEAM_NPC_TRAINER_BACK_OFFSET = 2.0; // how far behind their own row the NPC trainer stands
const TEAM_MEMBER_SPACING = 1.1; // lateral gap between the 3 members of one row
const TEAM_DOME_RADIUS = 5.5;
const TEAM_CAM_RADIUS = 7.5; // zoomed in closer than before for the wide "everyone visible" reset framing
const TEAM_STEP_MS = 900; // pause between individual attacker exchanges, so poses/log stay readable
const TEAM_ROUND_PAUSE_MS = 500; // brief pause before each new round's opening log line
// A generic look for the NPC trainer avatar — same default swatch already
// used as the character-creation form's own placeholder colors (see
// vscode/media/chat.html), reused here for a consistent "default person"
// look rather than inventing new colors.
const NPC_TRAINER_COLORS = { head: "#f5d0a9", body: "#4a90d9", arm: "#f5d0a9", leg: "#3a3a3a" };

// A persistent, clickable NPC standing in a fixed spot in the shared
// world — gives out a daily free Glophiball claim and heals the player's
// own trainer HP (see refreshRodzHealSection/rodzHealBtn). Full
// player-avatar scale, not CREATURE_SCALE — it's a trainer, not a
// Glophimon.
const RODZ_NAME = "Rodz";
const RODZ_COLORS = { head: "#f5d0a9", body: "#dc2626", arm: "#f5d0a9", leg: "#1f2937" };
const RODZ_X = 6;
const RODZ_Z = 0;

// Jared — Glophics' shop owner, standing at his own small stall (see
// buildJaredShop) on the opposite side of the plaza from Rodz, mirrored
// across the town's center so the two don't compete for the same space or
// either doorway. Interacting with him opens a "Buy Items" modal (see
// showJaredMenu) — Glophiball is the only item on sale for now, priced in
// G-coins (see GLOPHIBALL_SHOP_PRICE_G and the api's own POST /shop/buy).
const JARED_NAME = "Jared";
const JARED_COLORS = { head: "#f5d0a9", body: "#065f46", arm: "#f5d0a9", leg: "#1f2937" };
const JARED_X = -6;
const JARED_Z = 0;
const GLOPHIBALL_SHOP_PRICE_G = 100;
// How close the player has to be to actually interact with Rodz — same
// rule every NPC/player interaction in this game follows (see
// onCanvasClick), not something special to Rodz alone.
const INTERACTION_RANGE = 2.5;
// Beyond this world-space distance from the local player, name labels and
// chat bubbles declutter rather than stay pinned to the screen no matter
// how far away — applies to players (local + peers), NPCs (Rodz/Karra/
// Jared/Boss Rick), and roaming wild Glophimon alike.
const LABEL_VISIBLE_DISTANCE = 20;
// Must match the api's own DAILY_CLAIM_GLOPHIBALLS (main.py) — used only
// for the optimistic local bump on Yes; ctx.onClaimDaily's real response
// (via the normal glophimon.menu round-trip) is the actual source of truth.
const DAILY_CLAIM_GLOPHIBALLS = 5;
// Rodz's ambient "come claim your reward" loop while unclaimed (see
// updateRodzShout) — a plain show/hide cycle using the same chat-bubble
// sprite technique GL Sims World's own conversation system uses (see
// createChatBubble & friends, imported below), just without that system's
// whole burst/turn-taking machinery — there's only ever one speaker, Rodz,
// and only ever one line, so none of that is needed here.
const RODZ_SHOUT_TEXT = "Claim your free Glophiballs here!";
const RODZ_SHOUT_VISIBLE_MS = 3000;
const RODZ_SHOUT_HIDDEN_MS = 2500;

// Global chat — press Enter to open a focused text box, press Enter again
// to broadcast it as a one-shot expiring chat bubble over your own
// character (see openChatBox/submitChat and the "chat" world-socket
// message type). Every other connected player gets the exact same bubble
// over yours, using the same createChatBubble/scaleChatBubble/
// positionChatBubbleAt/disposeChatBubble machinery Rodz's own ambient
// shout already uses — just a one-shot timer instead of a repeating loop.
// Both anchor themselves via computeBubbleAnchorWorld (also imported from
// glsims' character.js) rather than a flat Y constant, so the bubble
// always clears the name label — which itself floats at a fixed height
// above the head plus the walk-bob offset — instead of sitting at the
// label's own height and covering it.
const CHAT_BUBBLE_DURATION_MS = 6000;
const CHAT_MAX_LENGTH = 200;
const CLICK_DRAG_THRESHOLD_PX = 5; // more mouse movement than this between mousedown/mouseup means it was a camera drag, not a click

// The Karirs field — a shared betting mini-game, top-right on the minimap
// (positive X, negative Z — see worldToMinimap: +X is rightward, +Z is
// downward, so -Z is "up"). One global race at a time, live for everyone,
// entirely server-owned (see games/glophimon/api's own karirs scheduler) —
// this game only ever renders whatever the world socket's karirs_state/
// karirs_race_created/_started/_resolved messages say, the same "purely a
// render of server state" shape wildSpawns already is. Walled the same way
// Glophics is (see buildAreaWalls) — a plaza-style ground patch inside four
// walls with a doorway gap on each side, plus three objects: the bulletin
// board (always-visible last-result sign), the TV (click for a simplified
// live view or the countdown to the next race), and Karra (click to bet or
// claim winnings) — all proximity-gated the same as every other NPC/
// interactable in this game (see INTERACTION_RANGE). Wild Glophimon are
// kept out of its footprint the same way they're kept out of Glophics'
// (see the api's own KARIRS_NO_SPAWN_HALF_X/Z alongside TOWN_NO_SPAWN_HALF_X/Z).
const KARIRS_FIELD_X = 28;
const KARIRS_FIELD_Z = -28;
const KARIRS_FIELD_HALF = 7;
const KARIRS_FIELD_COLOR = "#c2703d";
const KARIRS_FIELD_NAME = "Karirs";
const KARRA_NAME = "Carrin"; // internal identifiers ("karra*"/"KARRA_*") kept as-is — this constant is the one thing that actually renders
const KARRA_COLORS = { head: "#f5d0a9", body: "#f59e0b", arm: "#f5d0a9", leg: "#1f2937" };
const KARRA_X = KARIRS_FIELD_X;
const KARRA_Z = KARIRS_FIELD_Z;
const KARIRS_TV_X = KARIRS_FIELD_X - 3.5;
const KARIRS_TV_Z = KARIRS_FIELD_Z - 2;
const KARIRS_BOARD_X = KARIRS_FIELD_X + 3.5;
const KARIRS_BOARD_Z = KARIRS_FIELD_Z - 2;
const KARIRS_TV_WIDTH = 1.6;
const KARIRS_TV_HEIGHT = 1.1;
const KARIRS_BOARD_WIDTH = 1.8;
const KARIRS_BOARD_HEIGHT = 1.2;
// Must match the api's own STEP_DELAY_SECONDS (karirs_engine.py) — used
// only to replay a race's precomputed steps locally against started_at
// for the TV's simplified live view.
const KARIRS_STEP_DELAY_MS = 300;

// The Luba lobby area — same walled-footprint idea as the Karirs field,
// mirrored diagonally opposite it across the origin. Boss Rick lets any
// player host a Luba deathmatch (see showBossRickMenu/renderBossRickMenu);
// the resulting lobby (invite/accept/ready/kick/start) is driven by the
// api's own Luba-lobby WS messages (see onSocketMessage's own luba_*
// branches) — must match the api's own LUBA_X/Z/HALF.
const LUBA_X = -28;
const LUBA_Z = 28;
const LUBA_HALF = 7;
const LUBA_COLOR = "#3b1f5c";
const LUBA_NAME = "Luba";
const BOSS_RICK_NAME = "Boss Rick";
const BOSS_RICK_COLORS = { head: "#d1a17a", body: "#111827", arm: "#d1a17a", leg: "#1f2937" };
const BOSS_RICK_X = LUBA_X;
const BOSS_RICK_Z = LUBA_Z;
// 3/5/10 min preset buttons (Boss Rick's own "how long" step) — must match
// the api's own LUBA_DURATION_OPTIONS_S.
const LUBA_DURATION_OPTIONS_S = [180, 300, 600];
const LUBA_MAX_MEMBERS = 8;

// Tambayan — the one remaining open quadrant (Karirs top-right, Luba
// bottom-left, this bottom-right). Two physical chessboards inside; a
// fully self-contained real-chess-rules match/spectate system, driven by
// the api's own chess_* WS messages (see onSocketMessage's own chess_*
// branches) — must match the api's own TAMBAYAN_X/Z/RADIUS. Pentagon-
// shaped rather than the square every other walled area here uses — see
// TAMBAYAN_VERTICES and this game's own plan file for why that needed its
// own small geometry module instead of reusing buildAreaWalls.
const TAMBAYAN_X = 40;
const TAMBAYAN_Z = 40;
const TAMBAYAN_RADIUS = 14;
const TAMBAYAN_COLOR = "#4b3621";
const TAMBAYAN_NAME = "Tambayan";
// 5 vertices of a regular pentagon, one pointing due "north" (-Z) — computed
// once from the radius rather than hand-transcribed, so there's no literal
// float list that could ever drift from the api's own identical formula.
const TAMBAYAN_VERTICES = Array.from({ length: 5 }, (_, i) => {
  const angle = -Math.PI / 2 + i * ((2 * Math.PI) / 5);
  return [TAMBAYAN_X + Math.cos(angle) * TAMBAYAN_RADIUS, TAMBAYAN_Z + Math.sin(angle) * TAMBAYAN_RADIUS];
});
const CHESS_BOARD_1_X = TAMBAYAN_X - 5;
const CHESS_BOARD_1_Z = TAMBAYAN_Z;
const CHESS_BOARD_2_X = TAMBAYAN_X + 5;
const CHESS_BOARD_2_Z = TAMBAYAN_Z;
const CHESS_BOARD_SIZE = 1.6; // top surface width/depth
const CHESS_TABLE_HEIGHT = 0.7;

// Standard even-odd point-in-polygon test — used for Tambayan's own no-spawn
// zone, the "clickable from anywhere inside" chess spectate gate, and the
// away-from-the-table leave-timer. Works for any simple polygon, not just
// a pentagon, though this is the only one in the game right now.
function isInsidePolygon(x, z, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const [xi, zi] = vertices[i];
    const [xj, zj] = vertices[j];
    const intersects = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function isInsideTambayan(x, z) {
  return isInsidePolygon(x, z, TAMBAYAN_VERTICES);
}

// Shortest distance from a point to a line segment, clamped to the
// segment's own endpoints — the building block for the pentagon's own
// (diagonal, not axis-aligned) wall collision, since the existing
// isInsideTownWalls/TOWN_WALL_BOXES system only ever tests axis-aligned
// boxes.
function distanceToSegment(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const lengthSq = dx * dx + dz * dz;
  let t = lengthSq === 0 ? 0 : ((px - x1) * dx + (pz - z1) * dz) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const closestX = x1 + t * dx;
  const closestZ = z1 + t * dz;
  return Math.hypot(px - closestX, pz - closestZ);
}

// Each of the 5 edges split into two sub-segments around a door gap (same
// TOWN_DOOR_HALF_WIDTH every other walled area uses) — 10 sub-segments
// total. Computed once at module load, reused by both the collision test
// and the wall-mesh builder (see buildTambayan) so the visual walls and
// the actual movement-blocking geometry can never disagree.
const TAMBAYAN_WALL_SEGMENTS = (() => {
  const segments = [];
  for (let i = 0; i < 5; i++) {
    const [x1, z1] = TAMBAYAN_VERTICES[i];
    const [x2, z2] = TAMBAYAN_VERTICES[(i + 1) % 5];
    const edgeLength = Math.hypot(x2 - x1, z2 - z1);
    const ux = (x2 - x1) / edgeLength;
    const uz = (z2 - z1) / edgeLength;
    const midT = edgeLength / 2;
    const gapStartT = midT - TOWN_DOOR_HALF_WIDTH;
    const gapEndT = midT + TOWN_DOOR_HALF_WIDTH;
    segments.push([x1, z1, x1 + ux * gapStartT, z1 + uz * gapStartT]);
    segments.push([x1 + ux * gapEndT, z1 + uz * gapEndT, x2, z2]);
  }
  return segments;
})();

function isInsideTambayanWalls(x, z) {
  for (const [x1, z1, x2, z2] of TAMBAYAN_WALL_SEGMENTS) {
    if (distanceToSegment(x, z, x1, z1, x2, z2) <= TOWN_WALL_THICKNESS / 2) return true;
  }
  return false;
}

// Uppercase FEN letters are White's pieces, lowercase Black's — same
// convention the FEN standard itself uses, reused directly as the lookup
// key rather than inventing a separate color+kind pair.
const CHESS_UNICODE = {
  K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙",
  k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟",
};

// Parses just the piece-placement field of a FEN string into an 8x8 array
// (row 0 = rank 8 down to row 7 = rank 1, matching how FEN itself is
// ordered), each cell either a piece letter or null. No legal-move
// awareness at all — purely a display concern, same simplicity level the
// real standalone Chess client's own client-side FEN parsing already uses
// (it carries no chess rules of its own either; the server is the sole
// authority — see main.py's own chess_* handlers).
function parseChessFen(fen) {
  const placement = fen.split(" ")[0];
  return placement.split("/").map((rankStr) => {
    const row = [];
    for (const ch of rankStr) {
      if (ch >= "1" && ch <= "8") {
        for (let i = 0; i < Number(ch); i++) row.push(null);
      } else {
        row.push(ch);
      }
    }
    return row;
  });
}

// Commands are declared and resolved one Glophimon at a time, strictly
// left-to-right by row position (not Speed order — Speed only decides
// which *side* opens each turn now). During resolution the camera always
// parks close behind whichever Glophimon is the current attacker — yours
// or the NPC's — looking the same direction that attacker itself faces
// (see focusCameraOnMember); only during the NPC's own *declare* phase
// does the camera stay on the default wide reset framing instead (it
// never needs to follow anyone there, since nothing resolves yet).
// TEAM_FOCUS_CAM_HEIGHT/LOOK_Y raise the camera and aim it down at a
// slight angle rather than a flat eye-level shot. The focused Glophimon is
// made transparent (see setRigTransparent) since it would otherwise sit
// right in front of the camera, blocking the view of everything beyond it.
// teamBattle.focus is null whenever nothing is focused (the default wide
// framing applies).
const TEAM_FOCUS_CAM_BEHIND = 1.2;
const TEAM_FOCUS_CAM_HEIGHT = 2.0;
const TEAM_FOCUS_CAM_LOOK_Y = 0.2;
const TEAM_FOCUS_CAM_LOOK_AHEAD = 3;

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
  return min + Math.random() * (max - min);
}

function rollIVs() {
  return {
    speed: randomInt(IV_MIN, IV_MAX),
    attack: randomInt(IV_MIN, IV_MAX),
    defense: randomInt(IV_MIN, IV_MAX),
  };
}

// HP has no iv/ev column to add in (see GlophimonOwned's own docstring),
// so it reduces to floor(2*BASE_HP*level/100) + level + 10. Shared by
// computeCombatant (a fresh combatant always starts at its own max) and
// every place that needs a max to clamp/display a *persisted* current_hp
// against (see syncOwnedGlophimonHp, refreshRodzHealSection, the
// Glophimon menu panel/stats modal).
function maxHpFor(level) {
  const lvl = level || 1;
  return Math.floor((2 * BASE_HP * lvl) / 100) + lvl + 10;
}

// Real Pokémon's own stat formula, adapted to this game's flat
// placeholder base stat (no species has a unique base stat yet) —
// stat = floor((2*BASE_STAT + iv + floor(ev/4)) * level / 100) + 5. level
// defaults to 1 for any caller that doesn't have a real one yet (matches
// every Glophimon's own persisted default). evs is optional (defaults to
// zero across the board).
function computeCombatant(species, ivs, evs, level) {
  const ev = evs || {};
  const lvl = level || 1;
  const statAt = (iv, evStat) => Math.floor((2 * BASE_STAT + iv + Math.floor((evStat || 0) / 4)) * lvl / 100) + 5;
  const maxHp = maxHpFor(lvl);
  // PP is per-move now (see MOVES_BY_SPECIES/resolveMove) — "attack" is
  // just another entry alongside whatever special moves this species has,
  // not a separate flat field any more (movesForSpecies always includes it).
  const pp = {};
  for (const move of movesForSpecies(species.key)) pp[move.key] = move.pp;
  return {
    name: species.name,
    speciesKey: species.key,
    hp: maxHp,
    maxHp,
    pp,
    speed: statAt(ivs.speed, ev.speed),
    attack: statAt(ivs.attack, ev.attack),
    defense: statAt(ivs.defense, ev.defense),
    // Move-system battle-session state — all fresh every battle, never
    // persisted, same as pp/hp themselves (see resolveMove/effectiveStat/
    // tickEffects).
    effects: [],
    shieldActive: false,
    reflectPercent: 0,
    forcedDefenderTurns: 0,
    forcedIdleNextTurn: false,
    fainted: false,
  };
}

// Reads a combatant's stat with any currently-active buffs/debuffs
// (see MOVES_BY_SPECIES' own buffStat/debuffStat fields) applied
// multiplicatively — computed on demand rather than mutating the base
// combatant fields, so nothing needs to "remember" to undo a buff when it
// expires (see tickEffects). Only used by resolveMove's damage formula;
// the opening turnSide speed comparison (both battle modes) intentionally
// stays base-stat-only since it runs before either side has declared
// anything.
function effectiveStat(combatant, stat) {
  let mult = 1;
  for (const e of combatant.effects) if (e.stat === stat) mult += e.percent;
  return Math.max(1, Math.round(combatant[stat] * mult));
}

// Ages every active buff/debuff on one combatant by a turn, dropping any
// that expire, and counts down a taunt if one's active. Called once per
// round, for every member on both sides (not just whoever's about to
// act), from the exact spot beginRound/beginTeamRound already reset
// lockedFromDefending each round.
function tickEffects(combatant) {
  combatant.effects = combatant.effects.filter((e) => --e.turnsLeft > 0);
  if (combatant.forcedDefenderTurns > 0) combatant.forcedDefenderTurns -= 1;
}

// Heal/buff moves (kind "heal"/"buff") apply directly to one or more
// resolved target combatants — no accuracy roll, no opponent involved,
// since there's nothing to defend against a heal. A single move can
// combine effects freely (e.g. Root Anchor heals *and* raises Defense) —
// each field is applied independently if present, matching the schema's
// own "only the fields relevant to this move are set" shape.
function applyHealOrBuffOn(move, target, ctx) {
  if (move.healPercent) {
    const healed = Math.round(target.maxHp * move.healPercent);
    target.hp = Math.min(target.maxHp, target.hp + healed);
    ctx.log(`${target.name} recovered HP!`);
  }
  if (move.buffStat) {
    target.effects.push({ stat: move.buffStat, percent: move.buffPercent, turnsLeft: move.buffTurns });
    ctx.log(`${target.name}'s ${move.buffStat} rose!`);
  }
  if (move.shieldNextHit) {
    target.shieldActive = true;
    ctx.log(`${target.name} braced for the next hit!`);
  }
  if (move.reflectPercent) {
    target.reflectPercent = move.reflectPercent;
    ctx.log(`${target.name} is ready to retaliate!`);
  }
  if (move.cleanse) {
    const hadDebuff = target.effects.some((e) => e.percent < 0);
    target.effects = target.effects.filter((e) => e.percent >= 0);
    if (hadDebuff) ctx.log(`${target.name}'s negative effects were cleared!`);
  }
}

// targets: array of combatants (already resolved by the caller — self,
// the chosen ally, or the whole team, see showWildDeclareConfirm/
// showPlayerDeclareConfirm and their ally-target-picker sub-step).
function applyHealOrBuff(move, targets, ctx) {
  for (const target of targets) applyHealOrBuffOn(move, target, ctx);
}

// Debuff moves (kind "debuff") route through the exact same
// defend-matching pipeline damage moves do (see resolveMove) — `target`
// here is whichever combatant that matching resolved to, same as a
// damage move's defender.
function applyDebuff(move, target, ctx) {
  if (move.debuffStat) {
    target.effects.push({ stat: move.debuffStat, percent: -move.debuffPercent, turnsLeft: move.debuffTurns });
    ctx.log(`${target.name}'s ${move.debuffStat} fell!`);
  }
  if (move.forcedDefenderTurns) {
    target.forcedDefenderTurns = move.forcedDefenderTurns;
    ctx.log(`${target.name} was taunted!`);
  }
}

// The one shared damage/effect resolver both battle modes call into —
// replaces what used to be 5 hand-duplicated copies of the same formula.
// ctx: { log(msg), onUndefendedDamage(dmg) }. defends: whether the
// defending side is actively guarding this specific hit (same meaning as
// today's wildDefends/defenderMember-present check). targets: only
// meaningful for kind "heal"/"buff" — the already-resolved combatant(s)
// the move actually applies to (self/ally/team — see
// showWildDeclareConfirm/showPlayerDeclareConfirm), defaulting to just
// the caster if omitted.
function resolveMove({ move, attackerCombatant, defenderCombatant, targets, defends, ctx }) {
  if (attackerCombatant.pp[move.key] <= 0) {
    ctx.log(`${attackerCombatant.name} has no PP left for ${move.name}!`);
    return { hit: false };
  }
  attackerCombatant.pp[move.key] -= 1;

  if (move.kind === "heal" || move.kind === "buff") {
    applyHealOrBuff(move, targets || [attackerCombatant], ctx);
    return { hit: true };
  }

  const accuracy = move.accuracy == null ? null : move.accuracy - (defends ? DEFEND_ACCURACY_PENALTY : 0);
  if (accuracy != null && Math.random() * 100 > accuracy) {
    ctx.log(`${attackerCombatant.name}'s ${move.name} missed!`);
    return { hit: false, missed: true };
  }

  if (move.kind === "debuff") {
    if (!defenderCombatant) {
      ctx.log(`${move.name} had no target and fizzled!`);
      return { hit: false };
    }
    applyDebuff(move, defenderCombatant, ctx);
    return { hit: true };
  }

  // damage
  const atk = effectiveStat(attackerCombatant, "attack");
  const def = move.ignoresDefense ? BASE_STAT : effectiveStat(defenderCombatant || { defense: BASE_STAT, effects: [] }, "defense");
  const [minHits, maxHits] = move.hits || [1, 1];
  const hitCount = randomInt(minHits, maxHits);
  let totalDmg = 0;
  for (let n = 0; n < hitCount; n++) {
    let dmg = move.power * (atk / def) * (0.85 + Math.random() * 0.15);
    if (defends) dmg *= DEFEND_DAMAGE_MULTIPLIER;
    totalDmg += Math.max(1, Math.round(dmg));
  }
  if (defenderCombatant) {
    if (defenderCombatant.shieldActive) {
      // Absorbs the whole move-use in one shot — every hit of a
      // multi-hit move together, not per-individual-hit (same as real
      // Pokémon's own Protect-vs-multi-hit behavior).
      defenderCombatant.shieldActive = false;
      totalDmg = 0;
      ctx.log(`${defenderCombatant.name}'s shield absorbed it!`);
    } else if (defenderCombatant.reflectPercent) {
      const reflected = Math.round(totalDmg * defenderCombatant.reflectPercent);
      attackerCombatant.hp = Math.max(0, attackerCombatant.hp - reflected);
      ctx.log(`${attackerCombatant.name} took ${reflected} reflected damage!`);
    }
    defenderCombatant.hp = Math.max(0, defenderCombatant.hp - totalDmg);
  } else {
    ctx.onUndefendedDamage(totalDmg);
    ctx.log("No one defended!");
  }
  if (move.recoilPercent) {
    attackerCombatant.hp = Math.max(0, attackerCombatant.hp - Math.round(totalDmg * move.recoilPercent));
  }
  if (move.drainPercent) {
    attackerCombatant.hp = Math.min(attackerCombatant.maxHp, attackerCombatant.hp + Math.round(totalDmg * move.drainPercent));
  }
  if (move.flinchChance && defenderCombatant && Math.random() < move.flinchChance) {
    // Consumed (not turn-counted like effects/tickEffects) the moment the
    // target's own next declare-step sees it — see
    // showWildDeclareStep/showPlayerDeclareStep.
    defenderCombatant.forcedIdleNextTurn = true;
    ctx.log(`${defenderCombatant.name} flinched!`);
  }
  const hitNote = hitCount > 1 ? ` (${hitCount}x hit)` : "";
  ctx.log(`${attackerCombatant.name} used ${move.name}!${hitNote} (${totalDmg} damage)`);
  return { hit: true, damage: totalDmg };
}

// Ocean half-extent — vastly bigger than the island itself (see
// ARENA_HALF_X/Z) so its own outer edge can never be reached at any zoom
// level; a flat plane this size costs nothing extra to render regardless.
const OCEAN_HALF_EXTENT = 2000;

function buildGround(scene) {
  const groundWidth = (ARENA_HALF_X + 3) * 2;
  const groundDepth = (ARENA_HALF_Z + 3) * 2;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundWidth, groundDepth),
    new THREE.MeshStandardMaterial({ color: "#4a7c4a" }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Sits just under the ground plane (y=0) — the much smaller island simply
  // sits on top of this giant plane, hiding it directly underneath and
  // revealing it all the way around the island's edge, giving a coastline
  // "for free" with no need to cut a hole in either plane. See the ARENA_
  // HALF_X/Z comment above and this game's own plan file for the full
  // island/ocean design.
  const ocean = new THREE.Mesh(
    new THREE.PlaneGeometry(OCEAN_HALF_EXTENT * 2, OCEAN_HALF_EXTENT * 2),
    new THREE.MeshStandardMaterial({ color: "#1d6fa8", roughness: 0.35, metalness: 0.1 }),
  );
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.y = -0.05;
  scene.add(ocean);
}

// Direction the visible sun sprite sits along (see buildSunSprite) — much
// shallower (~12° above the camera's own horizontal plane) than the
// DirectionalLight's own steeper (8,14,6) position (still the same general
// upper-front quadrant): the light's position only needs to work for its
// shadow-camera frustum, but the sprite needs to actually land inside the
// player-facing camera's own view frustum. With a 50° vertical FOV (25°
// half-angle) and the camera always looking down at the player by roughly
// its own elevation angle, the frustum's *upward* reach above true
// horizontal is only (25° - camElevation) — at the default elevation
// (~35°) that's already negative, so the sun (like any real sky) is only
// actually visible once the player drags the camera down toward a flatter
// look (see MIN_ELEVATION) — this is normal/expected, matching how "look
// up to see the sky" already works in most third-person games, not a bug.
const SUN_DIRECTION = new THREE.Vector3(6, 1.3, 4).normalize();

// Only built for the real overworld (see mount()), not the small
// character-color preview (mountPreview) — a full sky dome/sun would be
// wasted detail on a tight close-up preview widget, and its own render
// loop has no need for the extra per-frame upkeep this requires (see
// updateSkyFollowCamera).
const SKY_DOME_RADIUS = 190; // safely inside the camera's own far clip plane (200)
const SUN_DISTANCE = 150; // inside the dome's own radius, so the sun renders in front of it
const SUN_SPRITE_SCALE = 34;

// An inverted, vertex-colored sphere rather than a flat background texture
// (see this game's own plan file for why) — a flat 2D scene.background
// texture never rotates with the camera, so on a game with manual
// camera-drag rotation it would look pasted-on rather than like a sky that
// actually surrounds the world. Vertex colors need no custom shader code —
// MeshBasicMaterial already supports them natively.
function buildSkyDome(scene) {
  const geometry = new THREE.SphereGeometry(SKY_DOME_RADIUS, 24, 16);
  const position = geometry.attributes.position;
  const topColor = new THREE.Color("#3b82c4");
  const horizonColor = new THREE.Color("#dff3ff");
  const colors = new Float32Array(position.count * 3);
  const blended = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const t = Math.max(0, Math.min(1, position.getY(i) / SKY_DOME_RADIUS + 0.1));
    blended.copy(horizonColor).lerp(topColor, t);
    colors[i * 3] = blended.r;
    colors[i * 3 + 1] = blended.g;
    colors[i * 3 + 2] = blended.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const dome = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  scene.add(dome);
  return dome;
}

// Same CanvasTexture-painted-once technique character.js already uses for
// name labels — a small radial gradient (bright warm center fading to
// nothing) rather than a flat disc, so it reads as a glow, not a coin.
function buildSunTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const canvasCtx = canvas.getContext("2d");
  const gradient = canvasCtx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,250,220,1)");
  gradient.addColorStop(0.4, "rgba(255,244,180,0.9)");
  gradient.addColorStop(1, "rgba(255,244,180,0)");
  canvasCtx.fillStyle = gradient;
  canvasCtx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

function buildSunSprite(scene) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: buildSunTexture(), depthWrite: false, fog: false }));
  sprite.scale.set(SUN_SPRITE_SCALE, SUN_SPRITE_SCALE, 1);
  scene.add(sprite);
  return sprite;
}

// Called once per frame (see frame() below) — re-anchors both to the
// camera's current position, the standard "skybox follows the viewer"
// trick, so neither can ever be outrun/have its edge reached no matter how
// far across the (now much bigger) map the player walks.
function updateSkyFollowCamera(skyDome, sunSprite, camera) {
  skyDome.position.set(camera.position.x, 0, camera.position.z);
  // Offset from the camera's own position/height (not world Y=0) — so the
  // sun sits at a fixed angle above the camera's *own* horizontal plane
  // regardless of the camera's current zoom/elevation, rather than
  // apparently drifting up and down relative to the camera as those change.
  sunSprite.position.set(
    camera.position.x + SUN_DIRECTION.x * SUN_DISTANCE,
    camera.position.y + SUN_DIRECTION.y * SUN_DISTANCE,
    camera.position.z + SUN_DIRECTION.z * SUN_DISTANCE,
  );
}

// Standard slab-method segment/AABB test, restricted to the parametric
// segment (t in [0,1]) rather than an infinite ray — used by
// updateTownWallFade to find which wall segment(s), if any, actually sit
// between the camera and the character this frame. Walls always span
// y in [0, TOWN_WALL_HEIGHT], so that axis doesn't need to be part of box.
function segmentIntersectsWallBox(x0, y0, z0, x1, y1, z1, box) {
  const minB = [box.minX, 0, box.minZ];
  const maxB = [box.maxX, TOWN_WALL_HEIGHT, box.maxZ];
  const p = [x0, y0, z0];
  const d = [x1 - x0, y1 - y0, z1 - z0];
  let tMin = 0;
  let tMax = 1;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]) < 1e-9) {
      if (p[axis] < minB[axis] || p[axis] > maxB[axis]) return false;
      continue;
    }
    let t1 = (minB[axis] - p[axis]) / d[axis];
    let t2 = (maxB[axis] - p[axis]) / d[axis];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }
  return true;
}

function buildTownWallSegment(scene, minX, maxX, minZ, maxZ, wallSegments) {
  // Solid/opaque by default — see updateTownWallFade, which is the only
  // thing that ever touches this material's opacity/transparent flag
  // afterward, and only for the segment(s) actually blocking the view of
  // your own character.
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(maxX - minX, TOWN_WALL_HEIGHT, maxZ - minZ),
    new THREE.MeshStandardMaterial({ color: TOWN_WALL_COLOR }),
  );
  mesh.position.set((minX + maxX) / 2, TOWN_WALL_HEIGHT / 2, (minZ + maxZ) / 2);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  wallSegments.push({ mesh, minX, maxX, minZ, maxZ, faded: false });
}

function buildTownDoorPost(scene, x, z) {
  const size = TOWN_WALL_THICKNESS + 0.3;
  const height = TOWN_WALL_HEIGHT * 1.15; // a touch taller than the walls, so the doorway actually reads as one
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size, height, size),
    new THREE.MeshStandardMaterial({ color: TOWN_DOOR_POST_COLOR }),
  );
  mesh.position.set(x, height / 2, z);
  mesh.castShadow = true;
  scene.add(mesh);
}

// A simple always-faces-camera text sign, same canvas-texture-sprite
// technique character.js's own name labels use, just standalone since this
// isn't attached to any rig.
function buildTownSign(text) {
  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");
  const font = "bold 40px sans-serif";
  measureCtx.font = font;
  const textWidth = measureCtx.measureText(text).width;

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(textWidth + 40);
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,0.8)";
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = "#ffe9b3";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 999;
  sprite.scale.set((canvas.width / canvas.height) * 1.1, 1.1, 1);
  return sprite;
}

// Four walls (each split around a door-sized gap) plus their flanking door
// posts, centered on (centerX, centerZ) with the given half-extent (a
// square footprint, same on both axes) — shared by both Glophics
// (buildTown) and the Karirs field (buildKarirsField) so the two walled
// areas' segments end up in the very same wallSegments array, meaning
// isInsideTownWalls/updateTownWallFade automatically cover both without
// knowing there's more than one.
function buildAreaWalls(scene, centerX, centerZ, half, wallSegments) {
  const H = half;
  const T = TOWN_WALL_THICKNESS;
  const D = TOWN_DOOR_HALF_WIDTH;
  const postOffset = D + T / 2 + 0.2;

  // North/south walls — split along x around the doorway.
  for (const zOff of [-H, H]) {
    const z = centerZ + zOff;
    buildTownWallSegment(scene, centerX - H, centerX - D, z - T / 2, z + T / 2, wallSegments);
    buildTownWallSegment(scene, centerX + D, centerX + H, z - T / 2, z + T / 2, wallSegments);
    buildTownDoorPost(scene, centerX - postOffset, z);
    buildTownDoorPost(scene, centerX + postOffset, z);
  }
  // East/west walls — split along z around the doorway.
  for (const xOff of [-H, H]) {
    const x = centerX + xOff;
    buildTownWallSegment(scene, x - T / 2, x + T / 2, centerZ - H, centerZ - D, wallSegments);
    buildTownWallSegment(scene, x - T / 2, x + T / 2, centerZ + D, centerZ + H, wallSegments);
    buildTownDoorPost(scene, x, centerZ - postOffset);
    buildTownDoorPost(scene, x, centerZ + postOffset);
  }
}

// Builds Glophics: its four walls/doors (see buildAreaWalls) plus a
// distinct plaza floor patch and name sign — see TOWN_HALF_X/Z and
// friends above. Returns the wall segments (world-space box + mesh) both
// movement resolution (isInsideTownWalls) and the camera-occlusion fade
// (updateTownWallFade) check against.
function buildTown(scene) {
  const wallSegments = [];
  buildAreaWalls(scene, 0, 0, TOWN_HALF_X, wallSegments);

  const plaza = new THREE.Mesh(
    new THREE.PlaneGeometry(TOWN_HALF_X * 2, TOWN_HALF_Z * 2),
    new THREE.MeshStandardMaterial({ color: TOWN_PLAZA_COLOR }),
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.y = 0.015; // above the base ground/grid (y=0/0.01), avoiding z-fighting with both
  plaza.receiveShadow = true;
  scene.add(plaza);

  const sign = buildTownSign(TOWN_NAME);
  sign.position.set(0, TOWN_WALL_HEIGHT + 1.3, 0); // hovers above the plaza center, readable from any approach
  scene.add(sign);

  return wallSegments;
}

// Jared's shop stall — purely decorative scenery (a counter + a canopy on
// two posts + a floating sign, reusing buildTownSign) sitting just behind
// where his own rig stands (see JARED_X/Z), the same "prop(s) plus a
// separately-built clickable NPC rig" split Karra/the Karirs field already
// uses. No walls of its own — it's inside Glophics, not a second walled
// area.
function buildJaredShop(scene) {
  const counter = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 0.9, 0.8),
    new THREE.MeshStandardMaterial({ color: "#8b5e34" }),
  );
  counter.position.set(JARED_X, 0.45, JARED_Z - 1.3);
  counter.castShadow = true;
  counter.receiveShadow = true;
  scene.add(counter);

  const postMaterial = new THREE.MeshStandardMaterial({ color: "#5c3d21" });
  for (const dx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2.2, 0.15), postMaterial);
    post.position.set(JARED_X + dx, 1.1, JARED_Z - 2);
    post.castShadow = true;
    scene.add(post);
  }
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 0.12, 1.4),
    new THREE.MeshStandardMaterial({ color: "#b91c1c" }),
  );
  roof.position.set(JARED_X, 2.2, JARED_Z - 2);
  roof.castShadow = true;
  scene.add(roof);

  const sign = buildTownSign(`${JARED_NAME}'s Shop`);
  sign.position.set(JARED_X, 2.9, JARED_Z - 2);
  scene.add(sign);
}

// A blank sign whose text gets redrawn in place later (see
// updateKarirsBoardText) rather than a fixed one-shot label like
// buildTownSign — the bulletin board's whole point is to keep showing the
// *last* race's result, which changes every time one resolves.
function buildKarirsBoardSign() {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 96;
  const ctx2d = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 999;
  sprite.scale.set(KARIRS_BOARD_WIDTH * 1.6, KARIRS_BOARD_WIDTH * 0.48, 1);
  return { sprite, canvas, ctx: ctx2d, texture };
}

function updateKarirsBoardText(board, text) {
  const { canvas, ctx: ctx2d, texture } = board;
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  ctx2d.fillStyle = "rgba(0,0,0,0.72)";
  ctx2d.fillRect(0, 0, canvas.width, canvas.height);
  ctx2d.strokeStyle = "#8d8d8d";
  ctx2d.lineWidth = 4;
  ctx2d.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  ctx2d.fillStyle = "#ffe9b3";
  ctx2d.font = "bold 16px sans-serif";
  ctx2d.textAlign = "center";
  ctx2d.textBaseline = "middle";
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const attempt = current ? `${current} ${word}` : word;
    if (ctx2d.measureText(attempt).width > canvas.width - 24 && current) {
      lines.push(current);
      current = word;
    } else {
      current = attempt;
    }
  }
  if (current) lines.push(current);
  const lineHeight = 22;
  const startY = canvas.height / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => ctx2d.fillText(line, canvas.width / 2, startY + i * lineHeight));
  texture.needsUpdate = true;
}

// Builds the Karirs field's static scenery: its four walls/doors (see
// buildAreaWalls — pushed into the same wallSegments array Glophics' own
// walls live in, so both movement collision and the per-segment
// camera-occlusion fade cover this field automatically), a plaza-style
// ground patch (see KARIRS_FIELD_*), the TV prop (a simple standing
// screen — clicking it opens the simplified live-view popup, there's no
// in-world video texture), and the bulletin board (see
// buildKarirsBoardSign above). Karra herself is a normal clickable NPC
// rig, built separately in mount() the same way Rodz's is. Returns the
// board's own {sprite, canvas, ctx, texture} so mount() can update its
// text whenever a race resolves.
function buildKarirsField(scene, wallSegments) {
  buildAreaWalls(scene, KARIRS_FIELD_X, KARIRS_FIELD_Z, KARIRS_FIELD_HALF, wallSegments);

  const plaza = new THREE.Mesh(
    new THREE.PlaneGeometry(KARIRS_FIELD_HALF * 2, KARIRS_FIELD_HALF * 2),
    new THREE.MeshStandardMaterial({ color: KARIRS_FIELD_COLOR }),
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.set(KARIRS_FIELD_X, 0.015, KARIRS_FIELD_Z);
  plaza.receiveShadow = true;
  scene.add(plaza);

  // TV — a dark screen on a short stand, facing back toward the field
  // center so it reads as "something you'd walk up and look at."
  const tvGroup = new THREE.Group();
  const stand = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.9, 0.3),
    new THREE.MeshStandardMaterial({ color: "#4b5563" }),
  );
  stand.position.y = 0.45;
  tvGroup.add(stand);
  const screen = new THREE.Mesh(
    new THREE.BoxGeometry(KARIRS_TV_WIDTH, KARIRS_TV_HEIGHT, 0.1),
    new THREE.MeshStandardMaterial({ color: "#111827" }),
  );
  screen.position.y = 0.9 + KARIRS_TV_HEIGHT / 2;
  tvGroup.add(screen);
  tvGroup.position.set(KARIRS_TV_X, 0, KARIRS_TV_Z);
  const angleToCenter = Math.atan2(KARIRS_FIELD_X - KARIRS_TV_X, KARIRS_FIELD_Z - KARIRS_TV_Z);
  tvGroup.rotation.y = angleToCenter;
  scene.add(tvGroup);

  // Bulletin board — a signpost with the redrawable sign mounted on it.
  const postGroup = new THREE.Group();
  const post = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 1.4, 0.15),
    new THREE.MeshStandardMaterial({ color: "#7c4a2d" }),
  );
  post.position.y = 0.7;
  postGroup.add(post);
  postGroup.position.set(KARIRS_BOARD_X, 0, KARIRS_BOARD_Z);
  const boardAngle = Math.atan2(KARIRS_FIELD_X - KARIRS_BOARD_X, KARIRS_FIELD_Z - KARIRS_BOARD_Z);
  postGroup.rotation.y = boardAngle;
  scene.add(postGroup);

  const board = buildKarirsBoardSign();
  board.sprite.position.set(KARIRS_BOARD_X, 1.5, KARIRS_BOARD_Z);
  updateKarirsBoardText(board, "No races have finished yet.");
  scene.add(board.sprite);

  return { board, tvGroup };
}

// The Luba lobby area's static scenery — same "walls pushed into the
// shared wallSegments array plus a plaza plate plus a signpost" shape as
// buildKarirsField, just without that field's own TV/board props (Boss
// Rick's own popup is the entire interaction surface here, see
// showBossRickMenu). Boss Rick himself is a normal clickable NPC rig,
// built separately in mount() the same way Rodz/Karra/Jared's are.
function buildLubaArea(scene, wallSegments) {
  buildAreaWalls(scene, LUBA_X, LUBA_Z, LUBA_HALF, wallSegments);

  const plaza = new THREE.Mesh(
    new THREE.PlaneGeometry(LUBA_HALF * 2, LUBA_HALF * 2),
    new THREE.MeshStandardMaterial({ color: LUBA_COLOR }),
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.set(LUBA_X, 0.015, LUBA_Z);
  plaza.receiveShadow = true;
  scene.add(plaza);

  const sign = buildTownSign(LUBA_NAME);
  sign.position.set(LUBA_X, TOWN_WALL_HEIGHT + 1.3, LUBA_Z);
  scene.add(sign);
}

// A checkerboard pattern painted once onto a canvas and applied as a
// texture — same "paint once, apply as a flat material" technique the sky
// dome/sun sprite already use, rather than building 64 individual tile
// meshes for something this simple.
function buildChessBoardTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const canvasCtx = canvas.getContext("2d");
  const light = "#e8d3a2";
  const dark = "#6b4423";
  const tile = canvas.width / 8;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      canvasCtx.fillStyle = (row + col) % 2 === 0 ? light : dark;
      canvasCtx.fillRect(col * tile, row * tile, tile, tile);
    }
  }
  return new THREE.CanvasTexture(canvas);
}

// One chess table (a low box "table" plus the checkered top) — returns the
// group so the caller can register it for raycast/highlight use (see
// createNpcHighlightUpdater and onCanvasClick's own chessboard branches).
function buildChessTable(scene, x, z, facingAngle) {
  const group = new THREE.Group();
  const table = new THREE.Mesh(
    new THREE.BoxGeometry(CHESS_BOARD_SIZE + 0.3, CHESS_TABLE_HEIGHT, CHESS_BOARD_SIZE + 0.3),
    new THREE.MeshStandardMaterial({ color: "#3f2a1a" }),
  );
  table.position.y = CHESS_TABLE_HEIGHT / 2;
  table.castShadow = true;
  table.receiveShadow = true;
  group.add(table);

  const boardTop = new THREE.Mesh(
    new THREE.PlaneGeometry(CHESS_BOARD_SIZE, CHESS_BOARD_SIZE),
    new THREE.MeshStandardMaterial({ map: buildChessBoardTexture() }),
  );
  boardTop.rotation.x = -Math.PI / 2;
  boardTop.position.y = CHESS_TABLE_HEIGHT + 0.005;
  boardTop.receiveShadow = true;
  group.add(boardTop);

  group.position.set(x, 0, z);
  group.rotation.y = facingAngle;
  scene.add(group);

  // Status sign — the "already hosted"/"in progress" indicator, visible
  // well before INTERACTION_RANGE (see updateChessBoardSign) so nobody
  // wastes a walk-up to a board that's already spoken for. Reuses the
  // Karirs bulletin board's own redrawable sign-sprite technique verbatim
  // — it was never actually Karirs-specific, just named for its first use.
  const statusSign = buildKarirsBoardSign();
  statusSign.sprite.position.set(x, CHESS_TABLE_HEIGHT + 1.1, z);
  statusSign.sprite.visible = false; // hidden until a board actually has a host (see updateChessBoardSign)
  scene.add(statusSign.sprite);

  return { group, statusSign };
}

// A pentagon-shaped flat floor matching TAMBAYAN_VERTICES exactly (a plain
// PlaneGeometry can only ever be a rectangle) — THREE.Shape/ShapeGeometry
// builds an arbitrary flat polygon instead. DoubleSide sidesteps needing to
// reason precisely about the shape's winding order after the same
// rotation.x=-Math.PI/2 flip every other ground-level plane in this file
// already uses; the cost of rendering both faces of one flat polygon is
// irrelevant.
function buildTambayanPlazaGeometry() {
  const shape = new THREE.Shape();
  // rotation.x = -Math.PI/2 (applied where this geometry is used) maps this
  // shape's local Y to world Z as its negation — negate here so the two
  // flips cancel and the floor's corners land exactly on TAMBAYAN_VERTICES,
  // matching the walls/posts built from the same array with no such flip.
  TAMBAYAN_VERTICES.forEach(([x, z], i) => {
    if (i === 0) shape.moveTo(x - TAMBAYAN_X, -(z - TAMBAYAN_Z));
    else shape.lineTo(x - TAMBAYAN_X, -(z - TAMBAYAN_Z));
  });
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

// A wall segment between two arbitrary (not necessarily axis-aligned)
// points — buildTownWallSegment only ever builds axis-aligned boxes, so
// Tambayan's diagonal pentagon edges need their own builder. Same rotation
// convention (atan2(dx, dz)) the Karirs TV/board props already use to face
// an arbitrary direction.
function buildDiagonalWallSegment(scene, x1, z1, x2, z2) {
  const length = Math.hypot(x2 - x1, z2 - z1);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(TOWN_WALL_THICKNESS, TOWN_WALL_HEIGHT, length),
    new THREE.MeshStandardMaterial({ color: TOWN_WALL_COLOR }),
  );
  mesh.position.set((x1 + x2) / 2, TOWN_WALL_HEIGHT / 2, (z1 + z2) / 2);
  mesh.rotation.y = Math.atan2(x2 - x1, z2 - z1);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// Builds Tambayan: its pentagon walls/doors (see TAMBAYAN_WALL_SEGMENTS —
// a self-contained parallel to buildAreaWalls, not pushed into the shared
// rectangular townWallSegments array at all, since movement collision
// against it is resolved separately too, see isInsideTambayanWalls), a
// distinct pentagon plaza floor, a name sign, and the two chess tables.
// Returns the two tables' groups+status-signs for later raycast/highlight/
// indicator use (see mount()'s own call site), mirroring buildKarirsField's
// own return-groups-for-later-use shape. Deliberately no camera-occlusion
// wall fade here (unlike the rectangular walls) — updateTownWallFade is
// written for axis-aligned AABB tests; a one-time visual gap, not asked for.
function buildTambayan(scene) {
  for (const [x1, z1, x2, z2] of TAMBAYAN_WALL_SEGMENTS) {
    buildDiagonalWallSegment(scene, x1, z1, x2, z2);
  }
  for (const [x, z] of TAMBAYAN_VERTICES) {
    buildTownDoorPost(scene, x, z);
  }

  const plaza = new THREE.Mesh(
    buildTambayanPlazaGeometry(),
    new THREE.MeshStandardMaterial({ color: TAMBAYAN_COLOR, side: THREE.DoubleSide }),
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.set(TAMBAYAN_X, 0.015, TAMBAYAN_Z);
  plaza.receiveShadow = true;
  scene.add(plaza);

  const sign = buildTownSign(TAMBAYAN_NAME);
  sign.position.set(TAMBAYAN_X, TOWN_WALL_HEIGHT + 1.3, TAMBAYAN_Z);
  scene.add(sign);

  const board1 = buildChessTable(scene, CHESS_BOARD_1_X, CHESS_BOARD_1_Z, 0);
  const board2 = buildChessTable(scene, CHESS_BOARD_2_X, CHESS_BOARD_2_Z, 0);

  return { board1Group: board1.group, board1StatusSign: board1.statusSign, board2Group: board2.group, board2StatusSign: board2.statusSign };
}

function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  // Matches the sky dome's own horizon color (see buildSkyDome, built
  // separately by mount() — not here, since this function is also used by
  // the small character-color preview, which doesn't need a full sky/sun)
  // so distant ground/ocean fades believably into the sky rather than an
  // unrelated flat tone. Fallback background color for any extreme angle
  // the dome doesn't cover. Distances bumped for the bigger map (see
  // ARENA_HALF_X/Z) — a longer view distance so the ocean actually reads
  // as stretching toward the horizon before fading, still comfortably
  // inside the camera's own far plane (200) below.
  scene.background = new THREE.Color("#dff3ff");
  scene.fog = new THREE.Fog("#dff3ff", 30, 140);

  scene.add(new THREE.AmbientLight("#ffffff", 0.7));
  const sun = new THREE.DirectionalLight("#fff7e0", 0.8);
  // Deliberately not SUN_DIRECTION (see that constant's own comment) — this
  // light's own position only needs to work for its shadow-camera frustum,
  // and the visible sun sprite (buildSunSprite) is tuned separately for
  // visibility within the player-facing camera instead.
  sun.position.set(8, 14, 6);
  sun.castShadow = true;
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);

  buildGround(scene);

  return { renderer, scene, camera };
}

// Splits a modal/panel "card" element into a header that's pinned in place
// (title + ✕, top right) and a body that's the only part that scrolls —
// shared by every glophimon overlay (the Menu list, Glophimon's PC, Bag,
// per-Glophimon stats) so a long list can never scroll its own title/close
// button out of view along with it. `card` must already be an empty,
// styled container (background/border/padding/width already set); this
// just gives it the flex-column shape and hands back the two pieces to
// build the real header text/content into. Deliberately does NOT touch
// `card.style.display` itself — the Menu list panel IS its own visibility
// toggle (no separate outer wrapper, unlike the other three, which nest
// their card inside an always-"flex"-when-shown dim overlay), so forcing
// "flex" here would make it visible from the moment it's built, before
// its own "none" default (set by the caller beforehand) ever applies.
function setupModalCard(card, maxHeight) {
  card.style.flexDirection = "column";
  card.style.maxHeight = maxHeight;
  card.style.overflow = "hidden";
  const headerRow = document.createElement("div");
  headerRow.style.display = "flex";
  headerRow.style.alignItems = "center";
  headerRow.style.justifyContent = "space-between";
  headerRow.style.flex = "0 0 auto";
  const heading = document.createElement("strong");
  headerRow.appendChild(heading);
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.fontSize = "11px";
  headerRow.appendChild(closeBtn);
  card.appendChild(headerRow);
  const body = document.createElement("div");
  body.style.overflowY = "auto";
  body.style.flex = "1 1 auto";
  body.style.marginTop = "6px";
  card.appendChild(body);
  return { heading, closeBtn, body };
}

export function mount(el, ctx) {
  el.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.position = "relative";

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.gap = "8px";
  header.style.margin = "0 0 6px 0";

  const status = document.createElement("p");
  status.style.fontSize = "12px";
  status.style.margin = "0";
  status.style.color = "#a3a3a3";
  status.textContent = "Connecting…";
  header.appendChild(status);

  // Both moved into the Dev menu below (see devMenuPanelEl) now that real
  // wild encounters trigger a battle on contact (see checkWildContact) —
  // these are testing-only shortcuts, not the main way to start a fight
  // any more.
  const battleButton = document.createElement("button");
  battleButton.textContent = "⚔ Simulate Wild Battle";
  battleButton.style.fontSize = "11px";
  battleButton.style.display = "block";
  battleButton.style.width = "100%";
  battleButton.style.marginTop = "6px";
  battleButton.style.cursor = "pointer";

  const teamBattleButton = document.createElement("button");
  teamBattleButton.textContent = "⚔ Battle 3v3 vs NPC";
  teamBattleButton.style.fontSize = "11px";
  teamBattleButton.style.display = "block";
  teamBattleButton.style.width = "100%";
  teamBattleButton.style.marginTop = "4px";
  teamBattleButton.style.cursor = "pointer";

  // In-canvas menu — the same Active Lineup/PC/Bag data the vscode-side
  // panel shows (see ctx.onOpenMenu/setMenuData below), but reachable
  // without leaving the game view, and with a per-Glophimon stats modal
  // (full IV/EV + a real rotating preview via mountPreview) that the plain
  // HTML panel has no way to offer since it can't render a THREE.js scene.
  const glophimonMenuButton = document.createElement("button");
  glophimonMenuButton.textContent = "🎒 Menu";
  glophimonMenuButton.style.fontSize = "11px";
  glophimonMenuButton.style.padding = "2px 8px";
  glophimonMenuButton.style.cursor = "pointer";
  header.appendChild(glophimonMenuButton);

  // Developer menu — testing-only toggles, kept separate from the player-
  // facing Menu above. Currently just the wild-Glophimon vision-range
  // visualization; more toggles can land here later without needing their
  // own button each time.
  const devMenuButton = document.createElement("button");
  devMenuButton.textContent = "🛠 Dev";
  devMenuButton.style.fontSize = "11px";
  devMenuButton.style.padding = "2px 8px";
  devMenuButton.style.cursor = "pointer";
  header.appendChild(devMenuButton);
  wrap.appendChild(header);

  // A relatively-positioned wrapper for just the canvas — overlays that
  // are meant to sit "inside the canvas" (minimap, stamina bar, the battle
  // HP-bar HUD) anchor to *this*, not the outer `wrap`, since `wrap` also
  // contains normal-flow panels below the canvas (battlePanel,
  // teamBattlePanel) that push its own total height well past the
  // canvas's own bottom edge — a bottom-anchored overlay on `wrap` itself
  // would land past those panels instead of over the canvas, which is
  // exactly the bug this fixes for the battle HP-bar HUD.
  const canvasWrapEl = document.createElement("div");
  canvasWrapEl.style.position = "relative";
  // Matches the canvas's own width/maxWidth exactly — a bare block div
  // would otherwise stretch to fill `wrap`'s full width regardless of the
  // canvas's own 720px cap, leaving right-anchored overlays (like the
  // wild's HP HUD) sitting well outside the canvas's actual visible area.
  canvasWrapEl.style.width = "100%";
  canvasWrapEl.style.maxWidth = "720px";
  wrap.appendChild(canvasWrapEl);

  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  canvas.style.width = "100%";
  canvas.style.maxWidth = "720px";
  canvas.style.display = "block";
  canvas.style.borderRadius = "4px";
  canvasWrapEl.appendChild(canvas);

  // Minimap — a fixed full-world top-down overview (not a following/zoomed
  // view), since the world is now big enough (see ARENA_HALF_X/Z) that
  // knowing where you and everything else currently are is otherwise easy
  // to lose track of. Sparse today by design: only Rodz, any
  // currently-roaming wild Glophimon (colored by the same red/hard,
  // yellow/easy split as their name labels), other connected players, and
  // you — there's no other "places" (zones/landmarks) in the world yet for
  // it to show.
  const minimapCanvas = document.createElement("canvas");
  minimapCanvas.width = MINIMAP_SIZE;
  minimapCanvas.height = MINIMAP_SIZE;
  minimapCanvas.style.position = "absolute";
  minimapCanvas.style.top = "6px";
  minimapCanvas.style.left = "6px";
  minimapCanvas.style.borderRadius = "4px";
  minimapCanvas.style.border = "1px solid #3333334d";
  minimapCanvas.style.zIndex = "15";
  canvasWrapEl.appendChild(minimapCanvas);
  const minimapCtx = minimapCanvas.getContext("2d");

  // Stamina bar — bottom-left overlay, only relevant (and only shown)
  // while actually walking around the world, not mid-battle.
  const staminaBarWrapEl = document.createElement("div");
  staminaBarWrapEl.style.position = "absolute";
  staminaBarWrapEl.style.left = "6px";
  staminaBarWrapEl.style.bottom = "6px";
  staminaBarWrapEl.style.width = "140px";
  staminaBarWrapEl.style.background = "#1a1a1aee";
  staminaBarWrapEl.style.border = "1px solid #3333334d";
  staminaBarWrapEl.style.borderRadius = "4px";
  staminaBarWrapEl.style.padding = "4px 6px";
  staminaBarWrapEl.style.zIndex = "15";
  staminaBarWrapEl.style.fontSize = "10px";
  const staminaLabelEl = document.createElement("span");
  staminaLabelEl.textContent = "Stamina";
  staminaLabelEl.style.display = "block";
  staminaLabelEl.style.marginBottom = "2px";
  staminaLabelEl.style.color = "#a3a3a3";
  staminaBarWrapEl.appendChild(staminaLabelEl);
  const staminaBarOuterEl = document.createElement("div");
  staminaBarOuterEl.style.background = "#3333334d";
  staminaBarOuterEl.style.borderRadius = "3px";
  staminaBarOuterEl.style.height = "6px";
  staminaBarOuterEl.style.overflow = "hidden";
  const staminaBarFillEl = document.createElement("div");
  staminaBarFillEl.style.background = "#38bdf8";
  staminaBarFillEl.style.height = "100%";
  staminaBarFillEl.style.width = "100%";
  staminaBarOuterEl.appendChild(staminaBarFillEl);
  staminaBarWrapEl.appendChild(staminaBarOuterEl);
  canvasWrapEl.appendChild(staminaBarWrapEl);

  function updateStaminaBar() {
    staminaBarWrapEl.style.display = battle || teamBattle || pvpBattle ? "none" : "block";
    staminaBarFillEl.style.width = `${Math.max(0, Math.min(100, (stamina / STAMINA_MAX) * 100))}%`;
    staminaBarFillEl.style.background = staminaExhausted ? "#ef4444" : "#38bdf8";
  }

  // G-coins balance — top-right overlay, shown only while walking around
  // the world (matches the stamina bar's own battle/teamBattle hiding
  // rule), since neither Karirs betting nor anything else spendable is
  // reachable mid-battle anyway.
  const gCoinsHudEl = document.createElement("div");
  gCoinsHudEl.style.position = "absolute";
  gCoinsHudEl.style.top = "6px";
  gCoinsHudEl.style.right = "6px";
  gCoinsHudEl.style.background = "#1a1a1aee";
  gCoinsHudEl.style.border = "1px solid #3333334d";
  gCoinsHudEl.style.borderRadius = "4px";
  gCoinsHudEl.style.padding = "4px 8px";
  gCoinsHudEl.style.zIndex = "15";
  gCoinsHudEl.style.fontSize = "12px";
  gCoinsHudEl.style.fontWeight = "bold";
  gCoinsHudEl.style.color = "#facc15";
  canvasWrapEl.appendChild(gCoinsHudEl);

  function updateGCoinsHud() {
    gCoinsHudEl.style.display = battle || teamBattle || pvpBattle ? "none" : "block";
    gCoinsHudEl.textContent = `🪙 ${menuData.inventory.g_coins} G`;
  }

  // Global chat's own text box — hidden until Enter opens it (see
  // onKeyDown), bottom-center so it doesn't compete with any corner HUD.
  // Its own keydown listener (not the global one) handles Enter-to-submit/
  // Escape-to-cancel, calling stopPropagation so the window-level handler
  // below never sees that keystroke and reopens an already-submitting box.
  const chatInputEl = document.createElement("input");
  chatInputEl.type = "text";
  chatInputEl.maxLength = CHAT_MAX_LENGTH;
  chatInputEl.placeholder = "Say something…";
  chatInputEl.style.position = "absolute";
  chatInputEl.style.left = "50%";
  chatInputEl.style.bottom = "36px";
  chatInputEl.style.transform = "translateX(-50%)";
  chatInputEl.style.width = "min(360px, 70%)";
  chatInputEl.style.zIndex = "20";
  chatInputEl.style.fontSize = "12px";
  chatInputEl.style.padding = "5px 8px";
  chatInputEl.style.borderRadius = "4px";
  chatInputEl.style.border = "1px solid #3333334d";
  chatInputEl.style.background = "#1a1a1aee";
  chatInputEl.style.color = "#f5f5f5";
  chatInputEl.style.display = "none";
  canvasWrapEl.appendChild(chatInputEl);

  function openChatBox() {
    chatInputEl.style.display = "block";
    chatInputEl.value = "";
    chatInputEl.focus();
  }
  function closeChatBox() {
    chatInputEl.style.display = "none";
    chatInputEl.blur();
  }
  chatInputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.stopPropagation();
      event.preventDefault();
      const text = chatInputEl.value.trim().slice(0, CHAT_MAX_LENGTH);
      closeChatBox();
      if (!text) return; // an empty Enter just cancels, same as Escape
      showChatBubbleFor(local, character.display_name, text);
      socket.sendChat(text);
    } else if (event.key === "Escape") {
      event.stopPropagation();
      closeChatBox();
    }
  });

  // Shared by the local player and every peer — a one-shot bubble that
  // outlives its own creation for CHAT_BUBBLE_DURATION_MS then disposes
  // itself, unlike Rodz's own repeating shout loop.
  function showChatBubbleFor(entity, name, text) {
    if (entity.chatBubble) {
      scene.remove(entity.chatBubble);
      disposeChatBubble(entity.chatBubble);
    }
    entity.chatBubble = createChatBubble(name, text, canvas.clientWidth || canvas.width);
    scene.add(entity.chatBubble);
    entity.chatBubbleExpiresAt = performance.now() + CHAT_BUBBLE_DURATION_MS;
  }

  // Called every frame for the local player and every peer (see frame())
  // — a no-op whenever that entity has no active bubble.
  function updateChatBubble(entity) {
    if (!entity.chatBubble) return;
    if (performance.now() >= entity.chatBubbleExpiresAt) {
      scene.remove(entity.chatBubble);
      disposeChatBubble(entity.chatBubble);
      entity.chatBubble = null;
      return;
    }
    entity.chatBubble.visible = Math.hypot(local.x - entity.x, local.z - entity.z) <= LABEL_VISIBLE_DISTANCE;
    if (!entity.chatBubble.visible) return;

    // entity (local or a peer) already has the x/y/z/rig shape
    // computeBubbleAnchorWorld expects — same helper glsims' own player
    // chat uses, so the bubble floats above the name label instead of
    // overlapping it.
    const anchor = computeBubbleAnchorWorld(entity);
    scaleChatBubble(anchor, entity.chatBubble, camera, lastHeight || canvas.height);
    positionChatBubbleAt(entity.chatBubble, anchor);
  }

  function worldToMinimap(x, z) {
    return {
      mx: ((x + ARENA_HALF_X) / (ARENA_HALF_X * 2)) * MINIMAP_SIZE,
      my: ((z + ARENA_HALF_Z) / (ARENA_HALF_Z * 2)) * MINIMAP_SIZE,
    };
  }

  function drawMinimapDot(x, z, radius, color, outline) {
    const { mx, my } = worldToMinimap(x, z);
    minimapCtx.beginPath();
    minimapCtx.arc(mx, my, radius, 0, Math.PI * 2);
    minimapCtx.fillStyle = color;
    minimapCtx.fill();
    if (outline) {
      minimapCtx.lineWidth = 1;
      minimapCtx.strokeStyle = outline;
      minimapCtx.stroke();
    }
  }

  // Shared by both walled areas (Glophics and the Karirs field) — a filled,
  // outlined square with its name labeled just above it.
  function drawMinimapWalledArea(centerX, centerZ, half, fillColor, name) {
    const tl = worldToMinimap(centerX - half, centerZ - half);
    const br = worldToMinimap(centerX + half, centerZ + half);
    minimapCtx.fillStyle = fillColor;
    minimapCtx.fillRect(tl.mx, tl.my, br.mx - tl.mx, br.my - tl.my);
    minimapCtx.strokeStyle = TOWN_WALL_COLOR;
    minimapCtx.lineWidth = 1.5;
    minimapCtx.strokeRect(tl.mx, tl.my, br.mx - tl.mx, br.my - tl.my);
    minimapCtx.fillStyle = "#2b2b2b";
    minimapCtx.font = "bold 8px sans-serif";
    minimapCtx.textAlign = "center";
    minimapCtx.textBaseline = "bottom";
    minimapCtx.fillText(name, (tl.mx + br.mx) / 2, tl.my - 2);
    minimapCtx.textAlign = "start"; // restore the canvas defaults — nothing else on the minimap sets these explicitly
    minimapCtx.textBaseline = "alphabetic";
  }

  // Sibling to drawMinimapWalledArea for Tambayan's own pentagon shape — a
  // plain rectangle draw can't represent it. Takes world-space vertices
  // directly (see TAMBAYAN_VERTICES) rather than a center+half-extent.
  function drawMinimapPolygon(vertices, fillColor, name) {
    minimapCtx.beginPath();
    vertices.forEach(([x, z], i) => {
      const { mx, my } = worldToMinimap(x, z);
      if (i === 0) minimapCtx.moveTo(mx, my);
      else minimapCtx.lineTo(mx, my);
    });
    minimapCtx.closePath();
    minimapCtx.fillStyle = fillColor;
    minimapCtx.fill();
    minimapCtx.strokeStyle = TOWN_WALL_COLOR;
    minimapCtx.lineWidth = 1.5;
    minimapCtx.stroke();
    const center = worldToMinimap(
      vertices.reduce((sum, [x]) => sum + x, 0) / vertices.length,
      vertices.reduce((sum, [, z]) => sum + z, 0) / vertices.length,
    );
    const topMy = Math.min(...vertices.map(([x, z]) => worldToMinimap(x, z).my));
    minimapCtx.fillStyle = "#2b2b2b";
    minimapCtx.font = "bold 8px sans-serif";
    minimapCtx.textAlign = "center";
    minimapCtx.textBaseline = "bottom";
    minimapCtx.fillText(name, center.mx, topMy - 2);
    minimapCtx.textAlign = "start";
    minimapCtx.textBaseline = "alphabetic";
  }

  function renderMinimap() {
    // Hidden entirely during any battle — it's just clutter competing with
    // the HP-bar HUD/action buttons for the same corners, and there's
    // nothing to navigate to while battling anyway (movement is disabled).
    if (battle || teamBattle || pvpBattle) {
      minimapCanvas.style.display = "none";
      return;
    }
    minimapCanvas.style.display = "block";
    minimapCtx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    minimapCtx.fillStyle = MINIMAP_BACKGROUND_COLOR; // translucent, not fully see-through or fully opaque
    minimapCtx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

    // Both walled areas — always the same squares at their fixed centers
    // (see TOWN_HALF_X/Z/buildTown and KARIRS_FIELD_*/buildKarirsField),
    // drawn under the dots so a player/peer standing inside either still
    // shows up on top.
    drawMinimapWalledArea(0, 0, TOWN_HALF_X, TOWN_PLAZA_COLOR, TOWN_NAME);
    drawMinimapWalledArea(KARIRS_FIELD_X, KARIRS_FIELD_Z, KARIRS_FIELD_HALF, KARIRS_FIELD_COLOR, KARIRS_FIELD_NAME);
    drawMinimapWalledArea(LUBA_X, LUBA_Z, LUBA_HALF, LUBA_COLOR, LUBA_NAME);
    drawMinimapPolygon(TAMBAYAN_VERTICES, TAMBAYAN_COLOR, TAMBAYAN_NAME);

    // Each town NPC gets its own dot, colored to match its own rig (same
    // "specific color per NPC" the RODZ_COLORS.body dot already did) —
    // Carrin and Jared previously had no minimap dot at all.
    drawMinimapDot(RODZ_X, RODZ_Z, 3, RODZ_COLORS.body);
    drawMinimapDot(KARRA_X, KARRA_Z, 3, KARRA_COLORS.body);
    drawMinimapDot(JARED_X, JARED_Z, 3, JARED_COLORS.body);
    drawMinimapDot(BOSS_RICK_X, BOSS_RICK_Z, 3, BOSS_RICK_COLORS.body);
    for (const spawn of wildSpawns.values()) {
      drawMinimapDot(spawn.x, spawn.z, 2.5, spawn.difficulty === "hard" ? WILD_LABEL_COLOR_HARD : WILD_LABEL_COLOR_EASY);
    }
    for (const peer of peers.values()) {
      drawMinimapDot(peer.x, peer.z, 2.5, PEER_MINIMAP_COLOR, "#ffffff");
    }

    const { mx, my } = worldToMinimap(local.x, local.z);
    const fx = Math.sin(local.facingAngle);
    const fz = Math.cos(local.facingAngle);
    minimapCtx.strokeStyle = "#ffffff";
    minimapCtx.lineWidth = 1.5;
    minimapCtx.beginPath();
    minimapCtx.moveTo(mx, my);
    minimapCtx.lineTo(mx + fx * 7, my + fz * 7);
    minimapCtx.stroke();
    drawMinimapDot(local.x, local.z, 3.5, "#38bdf8", "#ffffff");
  }

  // Battle panel — hidden until startWildBattle() shows it, torn down (but
  // not removed from the DOM) by endBattle(). See the game's own plan file
  // for the full round-resolution design this drives.
  const battlePanel = document.createElement("div");
  battlePanel.style.display = "none";
  battlePanel.style.margin = "6px 0";
  battlePanel.style.border = "1px solid #3333334d";
  battlePanel.style.borderRadius = "4px";
  battlePanel.style.padding = "6px 8px";
  battlePanel.style.fontSize = "12px";

  function buildHpRowIn(container, label) {
    const row = document.createElement("div");
    row.style.margin = "2px 0";
    const nameEl = document.createElement("span");
    nameEl.textContent = label;
    nameEl.style.display = "block";
    const barOuter = document.createElement("div");
    barOuter.style.background = "#3333334d";
    barOuter.style.borderRadius = "3px";
    barOuter.style.height = "8px";
    barOuter.style.overflow = "hidden";
    const barFill = document.createElement("div");
    barFill.style.background = "#4ade80";
    barFill.style.height = "100%";
    barFill.style.width = "100%";
    barOuter.appendChild(barFill);
    row.appendChild(nameEl);
    row.appendChild(barOuter);
    container.appendChild(row);
    return { row, nameEl, barFill };
  }
  // HP bars float directly over the canvas instead of living in the
  // scrollable panel below it — your own team bottom-left, the wild
  // top-right — so they're always in view without needing to scroll the
  // log/buttons into frame. Translucent background, same "readable but not
  // blocking the view behind it" idea as the minimap.
  const battleHudPlayerEl = document.createElement("div");
  battleHudPlayerEl.style.position = "absolute";
  battleHudPlayerEl.style.left = "6px";
  battleHudPlayerEl.style.bottom = "6px";
  battleHudPlayerEl.style.width = "160px";
  battleHudPlayerEl.style.background = BATTLE_HUD_BACKGROUND_COLOR;
  battleHudPlayerEl.style.border = "1px solid #3333334d";
  battleHudPlayerEl.style.borderRadius = "4px";
  battleHudPlayerEl.style.padding = "4px 6px";
  battleHudPlayerEl.style.zIndex = "16";
  battleHudPlayerEl.style.fontSize = "11px";
  battleHudPlayerEl.style.display = "none";
  canvasWrapEl.appendChild(battleHudPlayerEl);

  const battleHudWildEl = document.createElement("div");
  battleHudWildEl.style.position = "absolute";
  battleHudWildEl.style.right = "6px";
  battleHudWildEl.style.top = "6px";
  battleHudWildEl.style.width = "160px";
  battleHudWildEl.style.background = BATTLE_HUD_BACKGROUND_COLOR;
  battleHudWildEl.style.border = "1px solid #3333334d";
  battleHudWildEl.style.borderRadius = "4px";
  battleHudWildEl.style.padding = "4px 6px";
  battleHudWildEl.style.zIndex = "16";
  battleHudWildEl.style.fontSize = "11px";
  battleHudWildEl.style.display = "none";
  canvasWrapEl.appendChild(battleHudWildEl);

  // Your own trainer HP — see playerHp further up — shown above your
  // team's own rows, since an undefended wild attack now lands on this
  // directly (see resolveWildAttack) rather than a random teammate.
  const playerTrainerHpRow = buildHpRowIn(battleHudPlayerEl, "Trainer");

  // Up to 3 rows for your own team (see WILD_TEAM_MAX_SIZE) — hidden/shown
  // per battle based on how many are actually in your active lineup. All
  // non-fainted members act independently each of your attack rounds (see
  // beginPlayerDeclare) — same Attack/Idle-per-member shape as the 3v3
  // battle, not a single "active" combatant.
  const playerHpRows = [0, 1, 2].map(() => buildHpRowIn(battleHudPlayerEl, "—"));
  const wildHpRow = buildHpRowIn(battleHudWildEl, "Wild Glophimon");

  // Glophiball count during battle — the real bag balance (menuData.inventory),
  // same number the menu's own bag panel shows.
  const glophiballCountEl = document.createElement("p");
  glophiballCountEl.style.fontSize = "11px";
  glophiballCountEl.style.color = "#a3a3a3";
  glophiballCountEl.style.margin = "4px 0";
  battlePanel.appendChild(glophiballCountEl);

  function updateGlophiballCount() {
    glophiballCountEl.textContent = `🔴 Glophiballs: ${menuData.inventory.glophiballs}`;
  }

  const battleLogEl = document.createElement("div");
  battleLogEl.style.maxHeight = "90px";
  battleLogEl.style.overflowY = "auto";
  battleLogEl.style.margin = "6px 0";
  battleLogEl.style.color = "#a3a3a3";
  battlePanel.appendChild(battleLogEl);

  // Top-level per-round choice while it's your turn to attack: Battle
  // (kicks off the per-member Attack/Idle declare sequence — see
  // beginPlayerDeclare; the button reads "Battle", the declare step itself
  // still asks Attack/Idle per member), Catch (see the catch-animation
  // system), or Escape. Hidden in favor of dynamicActionsEl below for the
  // declare and defend steps themselves, same as the 3v3 battle hides its
  // own always-there buttons in favor of teamActionsEl.
  const battleActionsRow = document.createElement("div");
  battleActionsRow.style.display = "flex";
  battleActionsRow.style.gap = "6px";
  const attackBtn = document.createElement("button");
  attackBtn.textContent = "Battle";
  const catchBtn = document.createElement("button");
  catchBtn.textContent = "Catch";
  const escapeBtn = document.createElement("button");
  escapeBtn.textContent = "Escape";
  // Shown only after a successful catch (see finishCatchSequence) so the
  // player actually sees the "Gotcha!" log line — and whatever the catch
  // itself resolved to (added to the lineup vs. sent to the PC) — before
  // the battle scene tears down, instead of it vanishing out from under
  // them the instant the ball animation finishes.
  const postCatchContinueBtn = document.createElement("button");
  postCatchContinueBtn.textContent = "Continue";
  postCatchContinueBtn.style.display = "none";
  battleActionsRow.append(attackBtn, catchBtn, escapeBtn, postCatchContinueBtn);
  battlePanel.appendChild(battleActionsRow);

  // Rebuilt fresh for each declare-step (Attack/Idle/Back per member) and
  // each defend-step (Defend: X per eligible member, Don't Defend, or the
  // "No defenders available!" fallback) — same "throwaway dynamic
  // buttons" convention the 3v3 battle's own teamActionsEl already uses.
  const dynamicActionsEl = document.createElement("div");
  dynamicActionsEl.style.display = "none";
  dynamicActionsEl.style.flexWrap = "wrap";
  dynamicActionsEl.style.gap = "6px";
  dynamicActionsEl.style.margin = "6px 0";
  battlePanel.appendChild(dynamicActionsEl);

  wrap.appendChild(battlePanel);

  // PVP battle HUD/panel (Stage 2) — same floating-HP-bar-over-canvas shape
  // as the wild battle's own battleHudPlayerEl/battleHudWildEl above, just
  // symmetric (self vs opponent, both real players) instead of
  // player-team-vs-wild. Server-authoritative: this UI only ever renders
  // pvp_round_result payloads, never runs resolveMove itself.
  const pvpHudSelfEl = document.createElement("div");
  pvpHudSelfEl.style.position = "absolute";
  pvpHudSelfEl.style.left = "6px";
  pvpHudSelfEl.style.bottom = "6px";
  pvpHudSelfEl.style.width = "160px";
  pvpHudSelfEl.style.background = BATTLE_HUD_BACKGROUND_COLOR;
  pvpHudSelfEl.style.border = "1px solid #3333334d";
  pvpHudSelfEl.style.borderRadius = "4px";
  pvpHudSelfEl.style.padding = "4px 6px";
  pvpHudSelfEl.style.zIndex = "16";
  pvpHudSelfEl.style.fontSize = "11px";
  pvpHudSelfEl.style.display = "none";
  canvasWrapEl.appendChild(pvpHudSelfEl);

  const pvpHudOpponentEl = document.createElement("div");
  pvpHudOpponentEl.style.position = "absolute";
  pvpHudOpponentEl.style.right = "6px";
  pvpHudOpponentEl.style.top = "6px";
  pvpHudOpponentEl.style.width = "160px";
  pvpHudOpponentEl.style.background = BATTLE_HUD_BACKGROUND_COLOR;
  pvpHudOpponentEl.style.border = "1px solid #3333334d";
  pvpHudOpponentEl.style.borderRadius = "4px";
  pvpHudOpponentEl.style.padding = "4px 6px";
  pvpHudOpponentEl.style.zIndex = "16";
  pvpHudOpponentEl.style.fontSize = "11px";
  pvpHudOpponentEl.style.display = "none";
  canvasWrapEl.appendChild(pvpHudOpponentEl);

  const pvpSelfHpRow = buildHpRowIn(pvpHudSelfEl, "You");
  const pvpOpponentHpRow = buildHpRowIn(pvpHudOpponentEl, "Opponent");

  const pvpBattlePanel = document.createElement("div");
  pvpBattlePanel.style.display = "none";
  pvpBattlePanel.style.margin = "6px 0";
  pvpBattlePanel.style.border = "1px solid #3333334d";
  pvpBattlePanel.style.borderRadius = "4px";
  pvpBattlePanel.style.padding = "6px 8px";
  pvpBattlePanel.style.fontSize = "12px";

  const pvpBattleLogEl = document.createElement("div");
  pvpBattleLogEl.style.maxHeight = "90px";
  pvpBattleLogEl.style.overflowY = "auto";
  pvpBattleLogEl.style.margin = "6px 0";
  pvpBattleLogEl.style.color = "#a3a3a3";
  pvpBattlePanel.appendChild(pvpBattleLogEl);

  const pvpStatusEl = document.createElement("p");
  pvpStatusEl.style.fontSize = "11px";
  pvpStatusEl.style.color = "#a3a3a3";
  pvpStatusEl.style.margin = "4px 0";
  pvpBattlePanel.appendChild(pvpStatusEl);

  // Rebuilt fresh every round (see renderPvpMoveSelect) — one
  // buildMoveOptionRow per move plus a Defend button, same "throwaway
  // dynamic buttons" convention dynamicActionsEl already uses above.
  const pvpMoveSelectEl = document.createElement("div");
  pvpMoveSelectEl.style.display = "flex";
  pvpMoveSelectEl.style.flexDirection = "column";
  pvpMoveSelectEl.style.gap = "4px";
  pvpMoveSelectEl.style.margin = "6px 0";
  pvpBattlePanel.appendChild(pvpMoveSelectEl);

  const pvpForfeitBtn = document.createElement("button");
  pvpForfeitBtn.textContent = "Forfeit";
  pvpForfeitBtn.style.fontSize = "11px";
  pvpBattlePanel.appendChild(pvpForfeitBtn);

  const pvpEndBannerEl = document.createElement("div");
  pvpEndBannerEl.style.display = "none";
  pvpEndBannerEl.style.margin = "6px 0";
  const pvpEndTextEl = document.createElement("p");
  pvpEndTextEl.style.fontSize = "13px";
  pvpEndTextEl.style.fontWeight = "bold";
  pvpEndBannerEl.appendChild(pvpEndTextEl);
  const pvpEndDismissBtn = document.createElement("button");
  pvpEndDismissBtn.textContent = "Continue";
  pvpEndBannerEl.appendChild(pvpEndDismissBtn);
  pvpBattlePanel.appendChild(pvpEndBannerEl);

  wrap.appendChild(pvpBattlePanel);

  pvpForfeitBtn.addEventListener("click", () => {
    if (!pvpBattle || pvpBattle.ended) return;
    socket.sendPvpForfeit(pvpBattle.matchId);
  });
  pvpEndDismissBtn.addEventListener("click", () => {
    endPvpBattle();
  });

  // Team battle panel — a separate UI from the wild-battle one above (see
  // the game's own plan file for why the two are kept parallel rather than
  // sharing one structure): two columns (Your Team is always player-
  // controlled, NPC Team is always AI-controlled — sides are fixed, only
  // the attacker/defender *role* alternates each round), each with a
  // trainer HP bar and 3 member HP bars, built once with placeholder
  // labels and re-labeled by renderTeamHpBars() every time a battle
  // starts. teamActionsEl holds whatever commands the player needs to give
  // right now (Attack toggles + Confirm during their attack phase, or one
  // button per available Glophimon + Don't Defend during their defend
  // phase) — populated/cleared per-step by showPlayerAttackerSelection/
  // showPlayerDefenderSelection below, empty and hidden otherwise.
  const teamBattlePanel = document.createElement("div");
  teamBattlePanel.style.display = "none";
  teamBattlePanel.style.margin = "6px 0";
  teamBattlePanel.style.border = "1px solid #3333334d";
  teamBattlePanel.style.borderRadius = "4px";
  teamBattlePanel.style.padding = "6px 8px";
  teamBattlePanel.style.fontSize = "12px";

  const teamColumnsRow = document.createElement("div");
  teamColumnsRow.style.display = "flex";
  teamColumnsRow.style.gap = "10px";

  function buildTeamColumn(label) {
    const col = document.createElement("div");
    col.style.flex = "1";
    const heading = document.createElement("strong");
    heading.textContent = label;
    heading.style.display = "block";
    heading.style.marginBottom = "2px";
    col.appendChild(heading);
    const trainerRow = buildHpRowIn(col, `${label} Trainer`);
    const memberRows = [buildHpRowIn(col, "—"), buildHpRowIn(col, "—"), buildHpRowIn(col, "—")];
    teamColumnsRow.appendChild(col);
    return { heading, trainerRow, memberRows };
  }
  const teamAUi = buildTeamColumn("Your Team");
  const teamBUi = buildTeamColumn("NPC Team");
  teamBattlePanel.appendChild(teamColumnsRow);

  const teamActionsEl = document.createElement("div");
  teamActionsEl.style.display = "none";
  teamActionsEl.style.flexWrap = "wrap";
  teamActionsEl.style.gap = "6px";
  teamActionsEl.style.margin = "6px 0";
  teamBattlePanel.appendChild(teamActionsEl);

  const teamBattleLogEl = document.createElement("div");
  teamBattleLogEl.style.maxHeight = "90px";
  teamBattleLogEl.style.overflowY = "auto";
  teamBattleLogEl.style.margin = "6px 0";
  teamBattleLogEl.style.color = "#a3a3a3";
  teamBattlePanel.appendChild(teamBattleLogEl);

  const stopTeamBattleBtn = document.createElement("button");
  stopTeamBattleBtn.textContent = "Stop Battle";
  teamBattlePanel.appendChild(stopTeamBattleBtn);

  wrap.appendChild(teamBattlePanel);

  // Popup shown when the player clicks the Rodz NPC (see onCanvasClick) —
  // positioned absolutely over the canvas, right where they clicked.
  const rodzMenuEl = document.createElement("div");
  rodzMenuEl.style.position = "absolute";
  rodzMenuEl.style.display = "none";
  rodzMenuEl.style.background = "#1a1a1aee";
  rodzMenuEl.style.border = "1px solid #3333334d";
  rodzMenuEl.style.borderRadius = "4px";
  rodzMenuEl.style.padding = "6px";
  rodzMenuEl.style.zIndex = "10";
  rodzMenuEl.style.fontSize = "12px";
  rodzMenuEl.style.display = "none";
  const rodzMenuLabel = document.createElement("strong");
  rodzMenuLabel.textContent = RODZ_NAME;
  rodzMenuLabel.style.display = "block";
  rodzMenuLabel.style.marginBottom = "4px";
  rodzMenuEl.appendChild(rodzMenuLabel);
  // Daily free-Glophiballs claim (see updateRodzShout/refreshRodzMenu) — the
  // "Claim Daily Glophiballs" option is always offered, whether or not
  // today's claim is still available; rodzClaimTextEl only reveals Rodz's
  // actual answer ("here you go" / "don't be greedy") once the player has
  // actually asked for it (see the click handler below), rather than
  // announcing "already claimed" the instant the popup opens, before the
  // player asked for anything.
  const rodzClaimTextEl = document.createElement("p");
  rodzClaimTextEl.style.margin = "0 0 6px 0";
  rodzClaimTextEl.style.maxWidth = "180px";
  rodzClaimTextEl.style.display = "none";
  rodzMenuEl.appendChild(rodzClaimTextEl);
  const rodzClaimBtn = document.createElement("button");
  rodzClaimBtn.textContent = "Claim Daily Glophiballs";
  rodzClaimBtn.style.fontSize = "11px";
  rodzClaimBtn.style.display = "block";
  rodzClaimBtn.style.marginBottom = "6px";
  rodzMenuEl.appendChild(rodzClaimBtn);
  // Trainer HP heal — see playerHp/PLAYER_MAX_HP further below. Doesn't
  // recharge on its own between battles any more, so Rodz is the
  // deliberate way to top back up (blacking out also heals for free, but
  // at the cost of a trip back to Glophics — see handlePlayerBlackout).
  const rodzHealTextEl = document.createElement("p");
  rodzHealTextEl.style.margin = "0 0 6px 0";
  rodzMenuEl.appendChild(rodzHealTextEl);
  const rodzMenuButtons = document.createElement("div");
  rodzMenuButtons.style.display = "flex";
  rodzMenuButtons.style.gap = "6px";
  const rodzHealBtn = document.createElement("button");
  rodzHealBtn.textContent = "Heal";
  rodzHealBtn.style.fontSize = "11px";
  const rodzCancelBtn = document.createElement("button");
  rodzCancelBtn.textContent = "Cancel";
  rodzCancelBtn.style.fontSize = "11px";
  rodzMenuButtons.append(rodzHealBtn, rodzCancelBtn);
  rodzMenuEl.appendChild(rodzMenuButtons);
  wrap.appendChild(rodzMenuEl);

  // Karra's popup — betting + claiming, shown when the player clicks her
  // (see onCanvasClick). Both sections rebuild their content every time
  // the popup opens (see refreshKarraMenu) since the race/bet/claim state
  // changes independently of anything the player does.
  const karraMenuEl = document.createElement("div");
  karraMenuEl.style.position = "absolute";
  karraMenuEl.style.display = "none";
  karraMenuEl.style.background = "#1a1a1aee";
  karraMenuEl.style.border = "1px solid #3333334d";
  karraMenuEl.style.borderRadius = "4px";
  karraMenuEl.style.padding = "6px";
  karraMenuEl.style.zIndex = "10";
  karraMenuEl.style.fontSize = "12px";
  karraMenuEl.style.width = "220px";
  const karraMenuLabel = document.createElement("strong");
  karraMenuLabel.textContent = KARRA_NAME;
  karraMenuLabel.style.display = "block";
  karraMenuLabel.style.marginBottom = "4px";
  karraMenuEl.appendChild(karraMenuLabel);
  const karraRaceInfoEl = document.createElement("p");
  karraRaceInfoEl.style.margin = "0 0 6px 0";
  karraMenuEl.appendChild(karraRaceInfoEl);
  // One button per current racer (rebuilt fresh each open — the field is
  // different every race) plus a wager input, shown only while betting is
  // open and the player hasn't already bet this race.
  const karraBetSectionEl = document.createElement("div");
  karraBetSectionEl.style.display = "none";
  const karraRacerButtonsEl = document.createElement("div");
  karraRacerButtonsEl.style.display = "flex";
  karraRacerButtonsEl.style.flexWrap = "wrap";
  karraRacerButtonsEl.style.gap = "4px";
  karraRacerButtonsEl.style.marginBottom = "6px";
  karraBetSectionEl.appendChild(karraRacerButtonsEl);
  const karraWagerRow = document.createElement("div");
  karraWagerRow.style.display = "flex";
  karraWagerRow.style.gap = "6px";
  karraWagerRow.style.marginBottom = "6px";
  karraWagerRow.style.alignItems = "center";
  const karraWagerLabel = document.createElement("span");
  karraWagerLabel.textContent = "Wager:";
  const karraWagerInput = document.createElement("input");
  karraWagerInput.type = "number";
  karraWagerInput.min = "1";
  karraWagerInput.value = "1";
  karraWagerInput.style.width = "50px";
  const karraPlaceBetBtn = document.createElement("button");
  karraPlaceBetBtn.textContent = "Place Bet";
  karraPlaceBetBtn.style.fontSize = "11px";
  karraWagerRow.append(karraWagerLabel, karraWagerInput, karraPlaceBetBtn);
  karraBetSectionEl.appendChild(karraWagerRow);
  // Which racer is currently selected via the buttons above — cleared
  // every refresh, set by clicking one of karraRacerButtonsEl's buttons.
  let karraSelectedRacer = null;
  karraMenuEl.appendChild(karraBetSectionEl);
  const karraMyBetTextEl = document.createElement("p");
  karraMyBetTextEl.style.margin = "0 0 6px 0";
  karraMyBetTextEl.style.display = "none";
  karraMenuEl.appendChild(karraMyBetTextEl);
  const karraClaimSectionEl = document.createElement("div");
  karraClaimSectionEl.style.display = "none";
  const karraClaimTextEl = document.createElement("p");
  karraClaimTextEl.style.margin = "0 0 6px 0";
  karraClaimSectionEl.appendChild(karraClaimTextEl);
  const karraClaimBtn = document.createElement("button");
  karraClaimBtn.textContent = "Claim";
  karraClaimBtn.style.fontSize = "11px";
  karraClaimBtn.style.marginBottom = "6px";
  karraClaimSectionEl.appendChild(karraClaimBtn);
  karraMenuEl.appendChild(karraClaimSectionEl);
  const karraCancelBtn = document.createElement("button");
  karraCancelBtn.textContent = "Cancel";
  karraCancelBtn.style.fontSize = "11px";
  karraMenuEl.appendChild(karraCancelBtn);
  wrap.appendChild(karraMenuEl);

  // Jared's shop popup — a "Buy Items" modal, shown when the player
  // clicks him (see onCanvasClick). One row per purchasable item; only
  // Glophiball exists for now, but the row/quantity/Buy layout is generic
  // so a second item later is just another row, not new plumbing.
  const jaredMenuEl = document.createElement("div");
  jaredMenuEl.style.position = "absolute";
  jaredMenuEl.style.display = "none";
  jaredMenuEl.style.background = "#1a1a1aee";
  jaredMenuEl.style.border = "1px solid #3333334d";
  jaredMenuEl.style.borderRadius = "4px";
  jaredMenuEl.style.padding = "6px";
  jaredMenuEl.style.zIndex = "10";
  jaredMenuEl.style.fontSize = "12px";
  jaredMenuEl.style.width = "200px";
  const jaredMenuLabel = document.createElement("strong");
  jaredMenuLabel.textContent = `${JARED_NAME}'s Shop`;
  jaredMenuLabel.style.display = "block";
  jaredMenuLabel.style.marginBottom = "4px";
  jaredMenuEl.appendChild(jaredMenuLabel);
  const jaredItemLabel = document.createElement("div");
  jaredItemLabel.textContent = `🔴 Glophiball — ${GLOPHIBALL_SHOP_PRICE_G} G each`;
  jaredItemLabel.style.fontSize = "11px";
  jaredMenuEl.appendChild(jaredItemLabel);
  const jaredQtyRow = document.createElement("div");
  jaredQtyRow.style.display = "flex";
  jaredQtyRow.style.gap = "6px";
  jaredQtyRow.style.margin = "6px 0";
  jaredQtyRow.style.alignItems = "center";
  const jaredQtyInput = document.createElement("input");
  jaredQtyInput.type = "number";
  jaredQtyInput.min = "1";
  jaredQtyInput.value = "1";
  jaredQtyInput.style.width = "50px";
  const jaredBuyBtn = document.createElement("button");
  jaredBuyBtn.textContent = "Buy";
  jaredBuyBtn.style.fontSize = "11px";
  jaredQtyRow.append(jaredQtyInput, jaredBuyBtn);
  jaredMenuEl.appendChild(jaredQtyRow);
  // Feedback line — "Not enough G-coins", a purchase failure, or a
  // success confirmation. Hidden until the first buy attempt each time
  // the popup opens (see showJaredMenu).
  const jaredMessageEl = document.createElement("p");
  jaredMessageEl.style.fontSize = "10px";
  jaredMessageEl.style.margin = "0 0 6px 0";
  jaredMessageEl.style.display = "none";
  jaredMenuEl.appendChild(jaredMessageEl);
  const jaredCancelBtn = document.createElement("button");
  jaredCancelBtn.textContent = "Close";
  jaredCancelBtn.style.fontSize = "11px";
  jaredMenuEl.appendChild(jaredCancelBtn);
  wrap.appendChild(jaredMenuEl);

  // Boss Rick's popup — the Luba area's own attendant, shown when the
  // player clicks him (see onCanvasClick). Unlike every other NPC popup in
  // this game, his is a genuine multi-step dialogue (host?  -> mode ->
  // time limit), not one fixed set of controls — bossRickMenuBodyEl gets
  // cleared and rebuilt fresh on every step transition (see
  // renderBossRickMenu), the same "clear innerHTML, rebuild fresh"
  // convention the Menu list/Glophimon's PC modal already established.
  const bossRickMenuEl = document.createElement("div");
  bossRickMenuEl.style.position = "absolute";
  bossRickMenuEl.style.display = "none";
  bossRickMenuEl.style.background = "#1a1a1aee";
  bossRickMenuEl.style.border = "1px solid #3333334d";
  bossRickMenuEl.style.borderRadius = "4px";
  bossRickMenuEl.style.padding = "6px";
  bossRickMenuEl.style.zIndex = "10";
  bossRickMenuEl.style.fontSize = "12px";
  bossRickMenuEl.style.width = "200px";
  const bossRickMenuLabel = document.createElement("strong");
  bossRickMenuLabel.textContent = BOSS_RICK_NAME;
  bossRickMenuLabel.style.display = "block";
  bossRickMenuLabel.style.marginBottom = "4px";
  bossRickMenuEl.appendChild(bossRickMenuLabel);
  const bossRickMenuBodyEl = document.createElement("div");
  bossRickMenuEl.appendChild(bossRickMenuBodyEl);
  wrap.appendChild(bossRickMenuEl);

  // Another connected player's popup — same click-positioned shell as
  // Boss Rick's own, but its body is state-driven rather than step-driven:
  // either a plain "Invite to PVP" option, or (once sent) a "Waiting…"/
  // Cancel pair — see renderPlayerOptionsMenu/outgoingPvpInvite. "For now"
  // this is the only option; the header/body split leaves room for more
  // later without needing new plumbing.
  const playerOptionsMenuEl = document.createElement("div");
  playerOptionsMenuEl.style.position = "absolute";
  playerOptionsMenuEl.style.display = "none";
  playerOptionsMenuEl.style.background = "#1a1a1aee";
  playerOptionsMenuEl.style.border = "1px solid #3333334d";
  playerOptionsMenuEl.style.borderRadius = "4px";
  playerOptionsMenuEl.style.padding = "6px";
  playerOptionsMenuEl.style.zIndex = "10";
  playerOptionsMenuEl.style.fontSize = "12px";
  playerOptionsMenuEl.style.width = "180px";
  const playerOptionsMenuLabel = document.createElement("strong");
  playerOptionsMenuLabel.style.display = "block";
  playerOptionsMenuLabel.style.marginBottom = "4px";
  playerOptionsMenuEl.appendChild(playerOptionsMenuLabel);
  const playerOptionsMenuBodyEl = document.createElement("div");
  playerOptionsMenuEl.appendChild(playerOptionsMenuBodyEl);
  wrap.appendChild(playerOptionsMenuEl);

  // Incoming PVP invite — server-pushed, so unlike every popup above it
  // can appear with nothing clicked; a small fixed-position banner (top
  // right, mirroring the Luba lobby modal's own top-left placement) is
  // what fits that "can show up any time" shape.
  const pvpInviteBannerEl = document.createElement("div");
  pvpInviteBannerEl.style.position = "absolute";
  pvpInviteBannerEl.style.display = "none";
  pvpInviteBannerEl.style.top = "8px";
  pvpInviteBannerEl.style.right = "8px";
  pvpInviteBannerEl.style.width = "200px";
  pvpInviteBannerEl.style.background = "#1a1a1aee";
  pvpInviteBannerEl.style.border = "1px solid #3333334d";
  pvpInviteBannerEl.style.borderRadius = "4px";
  pvpInviteBannerEl.style.padding = "6px 8px";
  pvpInviteBannerEl.style.zIndex = "20";
  pvpInviteBannerEl.style.fontSize = "12px";
  const pvpInviteBannerTextEl = document.createElement("p");
  pvpInviteBannerTextEl.style.margin = "0 0 6px 0";
  pvpInviteBannerEl.appendChild(pvpInviteBannerTextEl);
  const pvpInviteAcceptBtn = document.createElement("button");
  pvpInviteAcceptBtn.textContent = "Accept";
  pvpInviteAcceptBtn.style.fontSize = "11px";
  const pvpInviteRejectBtn = document.createElement("button");
  pvpInviteRejectBtn.textContent = "Reject";
  pvpInviteRejectBtn.style.fontSize = "11px";
  pvpInviteBannerEl.append(pvpInviteAcceptBtn, pvpInviteRejectBtn);
  wrap.appendChild(pvpInviteBannerEl);
  pvpInviteAcceptBtn.addEventListener("click", () => {
    if (!incomingPvpInvite) return;
    socket.sendPvpRespond(incomingPvpInvite.inviteId, true);
    hidePvpInviteBanner();
  });
  pvpInviteRejectBtn.addEventListener("click", () => {
    if (!incomingPvpInvite) return;
    socket.sendPvpRespond(incomingPvpInvite.inviteId, false);
    hidePvpInviteBanner();
  });

  // Chessdom — the host-confirm popup, click-positioned like Boss Rick's
  // own single-step version (just Yes/No, no mode/duration sub-steps).
  const chessHostMenuEl = document.createElement("div");
  chessHostMenuEl.style.position = "absolute";
  chessHostMenuEl.style.display = "none";
  chessHostMenuEl.style.background = "#1a1a1aee";
  chessHostMenuEl.style.border = "1px solid #3333334d";
  chessHostMenuEl.style.borderRadius = "4px";
  chessHostMenuEl.style.padding = "6px";
  chessHostMenuEl.style.zIndex = "10";
  chessHostMenuEl.style.fontSize = "12px";
  chessHostMenuEl.style.width = "180px";
  const chessHostMenuLabel = document.createElement("strong");
  chessHostMenuLabel.textContent = "Chess Table";
  chessHostMenuLabel.style.display = "block";
  chessHostMenuLabel.style.marginBottom = "4px";
  chessHostMenuEl.appendChild(chessHostMenuLabel);
  const chessHostMenuBodyEl = document.createElement("div");
  chessHostMenuEl.appendChild(chessHostMenuBodyEl);
  wrap.appendChild(chessHostMenuEl);

  // Join-confirm popup — same shell, asked only of the joining player (the
  // host already implicitly consented by hosting in the first place, same
  // "open hosting, first click joins" shape the user described).
  const chessJoinMenuEl = document.createElement("div");
  chessJoinMenuEl.style.position = "absolute";
  chessJoinMenuEl.style.display = "none";
  chessJoinMenuEl.style.background = "#1a1a1aee";
  chessJoinMenuEl.style.border = "1px solid #3333334d";
  chessJoinMenuEl.style.borderRadius = "4px";
  chessJoinMenuEl.style.padding = "6px";
  chessJoinMenuEl.style.zIndex = "10";
  chessJoinMenuEl.style.fontSize = "12px";
  chessJoinMenuEl.style.width = "180px";
  const chessJoinMenuLabel = document.createElement("strong");
  chessJoinMenuLabel.textContent = "Chess Table";
  chessJoinMenuLabel.style.display = "block";
  chessJoinMenuLabel.style.marginBottom = "4px";
  chessJoinMenuEl.appendChild(chessJoinMenuLabel);
  const chessJoinMenuBodyEl = document.createElement("div");
  chessJoinMenuEl.appendChild(chessJoinMenuBodyEl);
  wrap.appendChild(chessJoinMenuEl);

  // "Waiting for a player…" — host-only, fixed position (bottom-left, the
  // one corner not already claimed by the Luba lobby modal/PVP banner),
  // same setupModalCard shell as the Luba lobby modal.
  const chessWaitingModalEl = document.createElement("div");
  chessWaitingModalEl.style.position = "absolute";
  chessWaitingModalEl.style.display = "none";
  chessWaitingModalEl.style.bottom = "8px";
  chessWaitingModalEl.style.left = "8px";
  chessWaitingModalEl.style.width = "200px";
  chessWaitingModalEl.style.background = "#1a1a1aee";
  chessWaitingModalEl.style.border = "1px solid #3333334d";
  chessWaitingModalEl.style.borderRadius = "4px";
  chessWaitingModalEl.style.padding = "6px 8px";
  chessWaitingModalEl.style.zIndex = "20";
  chessWaitingModalEl.style.fontSize = "12px";
  wrap.appendChild(chessWaitingModalEl);
  const { heading: chessWaitingHeadingEl, closeBtn: chessWaitingCloseBtn, body: chessWaitingBodyEl } =
    setupModalCard(chessWaitingModalEl, "50%");
  chessWaitingHeadingEl.textContent = "Chess";
  chessWaitingCloseBtn.addEventListener("click", () => {
    if (myHostedChessBoardId != null) socket.sendChessCancelHost(myHostedChessBoardId);
  });

  // The actual match/spectate view — outer dim overlay + inner card, same
  // shape as Glophimon's own PC/Bag/Stats modals since this is a dense
  // panel (board + move log), not a tooltip.
  const chessMatchModalEl = document.createElement("div");
  chessMatchModalEl.style.position = "absolute";
  chessMatchModalEl.style.display = "none";
  chessMatchModalEl.style.inset = "0";
  chessMatchModalEl.style.background = "#000000b3";
  chessMatchModalEl.style.zIndex = "26";
  chessMatchModalEl.style.alignItems = "center";
  chessMatchModalEl.style.justifyContent = "center";
  const chessMatchCardEl = document.createElement("div");
  chessMatchCardEl.style.background = "#1a1a1aee";
  chessMatchCardEl.style.border = "1px solid #3333334d";
  chessMatchCardEl.style.borderRadius = "6px";
  chessMatchCardEl.style.padding = "10px";
  chessMatchCardEl.style.width = "300px";
  chessMatchCardEl.style.fontSize = "12px";
  chessMatchCardEl.style.display = "flex";
  chessMatchModalEl.appendChild(chessMatchCardEl);
  wrap.appendChild(chessMatchModalEl);
  const { heading: chessMatchHeadingEl, closeBtn: chessMatchCloseBtn, body: chessMatchBodyEl } =
    setupModalCard(chessMatchCardEl, "80%");
  chessMatchHeadingEl.textContent = "Chess";
  chessMatchCloseBtn.addEventListener("click", () => hideChessMatchModal());

  // The "you left Tambayan mid-game" warning — same fixed-banner shell as
  // the PVP invite banner, since like that one it can appear with nothing
  // clicked. Placed at bottom-right so it doesn't collide with the PVP
  // banner (top-right) or the Luba/chess-waiting modals (top/bottom-left).
  const chessLeaveWarningEl = document.createElement("div");
  chessLeaveWarningEl.style.position = "absolute";
  chessLeaveWarningEl.style.display = "none";
  chessLeaveWarningEl.style.bottom = "8px";
  chessLeaveWarningEl.style.right = "8px";
  chessLeaveWarningEl.style.width = "200px";
  chessLeaveWarningEl.style.background = "#7f1d1dee";
  chessLeaveWarningEl.style.border = "1px solid #3333334d";
  chessLeaveWarningEl.style.borderRadius = "4px";
  chessLeaveWarningEl.style.padding = "6px 8px";
  chessLeaveWarningEl.style.zIndex = "20";
  chessLeaveWarningEl.style.fontSize = "12px";
  const chessLeaveWarningTextEl = document.createElement("p");
  chessLeaveWarningTextEl.style.margin = "0";
  chessLeaveWarningEl.appendChild(chessLeaveWarningTextEl);
  wrap.appendChild(chessLeaveWarningEl);

  // The Luba lobby modal — top-left (distinct from every NPC popup above,
  // which follow the click position), stays open across normal world
  // movement once a lobby exists so the host can walk around inviting
  // nearby players while it's up. Uses the same setupModalCard fixed-
  // header/scrollable-body split as Glophimon's own PC/Bag modals, since
  // an 8-member roster plus pending invites can overflow a short panel.
  const lubaLobbyModalEl = document.createElement("div");
  lubaLobbyModalEl.style.position = "absolute";
  lubaLobbyModalEl.style.display = "none";
  lubaLobbyModalEl.style.top = "8px";
  lubaLobbyModalEl.style.left = "8px";
  lubaLobbyModalEl.style.width = "240px";
  lubaLobbyModalEl.style.background = "#1a1a1aee";
  lubaLobbyModalEl.style.border = "1px solid #3333334d";
  lubaLobbyModalEl.style.borderRadius = "4px";
  lubaLobbyModalEl.style.padding = "6px 8px";
  lubaLobbyModalEl.style.zIndex = "20";
  lubaLobbyModalEl.style.fontSize = "12px";
  wrap.appendChild(lubaLobbyModalEl);
  const { heading: lubaLobbyHeadingEl, closeBtn: lubaLobbyCloseBtn, body: lubaLobbyBodyEl } =
    setupModalCard(lubaLobbyModalEl, "50%");
  lubaLobbyHeadingEl.textContent = "Luba Lobby";
  lubaLobbyCloseBtn.addEventListener("click", () => socket.sendLubaLeave());

  // The TV's popup — a simplified live view (agreed with the player up
  // front: no full 3D picture-in-picture race, just live progress bars),
  // or the countdown to the next race while betting is still open. Its
  // content is rebuilt every frame while visible (see updateKarirsTv),
  // not just on open, since a countdown/live race is constantly changing.
  const karirsTvMenuEl = document.createElement("div");
  karirsTvMenuEl.style.position = "absolute";
  karirsTvMenuEl.style.display = "none";
  karirsTvMenuEl.style.background = "#1a1a1aee";
  karirsTvMenuEl.style.border = "1px solid #3333334d";
  karirsTvMenuEl.style.borderRadius = "4px";
  karirsTvMenuEl.style.padding = "6px";
  karirsTvMenuEl.style.zIndex = "10";
  karirsTvMenuEl.style.fontSize = "12px";
  karirsTvMenuEl.style.width = "200px";
  const karirsTvLabel = document.createElement("strong");
  karirsTvLabel.textContent = "Race TV";
  karirsTvLabel.style.display = "block";
  karirsTvLabel.style.marginBottom = "4px";
  karirsTvMenuEl.appendChild(karirsTvLabel);
  const karirsTvContentEl = document.createElement("div");
  karirsTvMenuEl.appendChild(karirsTvContentEl);
  // Toggles between the normal live/countdown view and a replay of the
  // last race to finish (see karirsTvShowingPreview) — hidden entirely
  // whenever there's no previous race yet to show (see renderKarirsTvContent,
  // which also keeps this button's own label in sync every frame).
  const karirsTvPreviewBtn = document.createElement("button");
  karirsTvPreviewBtn.style.fontSize = "11px";
  karirsTvPreviewBtn.style.marginTop = "6px";
  karirsTvPreviewBtn.style.marginRight = "4px";
  karirsTvMenuEl.appendChild(karirsTvPreviewBtn);
  const karirsTvCloseBtn = document.createElement("button");
  karirsTvCloseBtn.textContent = "Close";
  karirsTvCloseBtn.style.fontSize = "11px";
  karirsTvCloseBtn.style.marginTop = "6px";
  karirsTvMenuEl.appendChild(karirsTvCloseBtn);
  wrap.appendChild(karirsTvMenuEl);

  // In-canvas Glophimon menu — Active Lineup / PC Storage / Bag, populated
  // by setMenuData (see mount()'s own return value) whenever a
  // 'glophimon.menu' message round-trips back from the host (ctx.onOpenMenu
  // requests a fresh fetch each time this is opened, same "fetched fresh
  // every time" convention as the vscode-side panel it mirrors).
  const glophimonMenuPanelEl = document.createElement("div");
  glophimonMenuPanelEl.style.position = "absolute";
  glophimonMenuPanelEl.style.display = "none";
  glophimonMenuPanelEl.style.top = "36px";
  glophimonMenuPanelEl.style.right = "6px";
  glophimonMenuPanelEl.style.width = "220px";
  glophimonMenuPanelEl.style.background = "#1a1a1aee";
  glophimonMenuPanelEl.style.border = "1px solid #3333334d";
  glophimonMenuPanelEl.style.borderRadius = "4px";
  glophimonMenuPanelEl.style.padding = "6px 8px";
  glophimonMenuPanelEl.style.zIndex = "20";
  glophimonMenuPanelEl.style.fontSize = "12px";
  wrap.appendChild(glophimonMenuPanelEl);
  const { heading: glophimonMenuHeadingEl, closeBtn: glophimonMenuCloseBtn, body: glophimonMenuBodyEl } =
    setupModalCard(glophimonMenuPanelEl, "calc(100% - 44px)");
  glophimonMenuHeadingEl.textContent = "🎒 Menu";
  glophimonMenuCloseBtn.addEventListener("click", () => {
    glophimonMenuPanelEl.style.display = "none";
  });

  // Two modals reached from the Menu's own list (see renderGlophimonMenuList)
  // rather than shown inline in the list itself — same full-overlay shape
  // as the stats modal below, just a layer beneath it (zIndex 25 vs 30) so
  // opening a Glophimon's stats from inside the PC modal still renders on
  // top of it instead of behind.
  const glophimonPcModalEl = document.createElement("div");
  glophimonPcModalEl.style.position = "absolute";
  glophimonPcModalEl.style.display = "none";
  glophimonPcModalEl.style.inset = "0";
  glophimonPcModalEl.style.background = "#000000b3";
  glophimonPcModalEl.style.zIndex = "25";
  glophimonPcModalEl.style.alignItems = "center";
  glophimonPcModalEl.style.justifyContent = "center";
  const glophimonPcCardEl = document.createElement("div");
  glophimonPcCardEl.style.background = "#1a1a1aee";
  glophimonPcCardEl.style.border = "1px solid #3333334d";
  glophimonPcCardEl.style.borderRadius = "6px";
  glophimonPcCardEl.style.padding = "10px";
  glophimonPcCardEl.style.width = "260px";
  glophimonPcCardEl.style.fontSize = "12px";
  // Always flex — glophimonPcModalEl (the dim overlay around it) is what
  // actually toggles "none"/"flex" for overall visibility; the card itself
  // just needs the flex-column layout whenever its wrapper happens to show it.
  glophimonPcCardEl.style.display = "flex";
  glophimonPcModalEl.appendChild(glophimonPcCardEl);
  wrap.appendChild(glophimonPcModalEl);
  const { heading: glophimonPcHeadingEl, closeBtn: glophimonPcCloseBtn, body: glophimonPcBodyEl } =
    setupModalCard(glophimonPcCardEl, "80%");
  glophimonPcHeadingEl.textContent = "Glophimon's PC";
  glophimonPcCloseBtn.addEventListener("click", () => closeGlophimonPcModal());

  const glophimonBagModalEl = document.createElement("div");
  glophimonBagModalEl.style.position = "absolute";
  glophimonBagModalEl.style.display = "none";
  glophimonBagModalEl.style.inset = "0";
  glophimonBagModalEl.style.background = "#000000b3";
  glophimonBagModalEl.style.zIndex = "25";
  glophimonBagModalEl.style.alignItems = "center";
  glophimonBagModalEl.style.justifyContent = "center";
  const glophimonBagCardEl = document.createElement("div");
  glophimonBagCardEl.style.background = "#1a1a1aee";
  glophimonBagCardEl.style.border = "1px solid #3333334d";
  glophimonBagCardEl.style.borderRadius = "6px";
  glophimonBagCardEl.style.padding = "10px";
  glophimonBagCardEl.style.width = "220px";
  glophimonBagCardEl.style.fontSize = "12px";
  glophimonBagCardEl.style.display = "flex"; // see glophimonPcCardEl's own comment
  glophimonBagModalEl.appendChild(glophimonBagCardEl);
  wrap.appendChild(glophimonBagModalEl);
  const { heading: glophimonBagHeadingEl, closeBtn: glophimonBagCloseBtn, body: glophimonBagBodyEl } =
    setupModalCard(glophimonBagCardEl, "80%");
  glophimonBagHeadingEl.textContent = "Bag";
  glophimonBagCloseBtn.addEventListener("click", () => closeGlophimonBagModal());

  // Per-Glophimon stats modal — species/tier/types/level + full IV/EV, with
  // a live rotating preview reusing mountPreview (the same function the
  // character-creation and starter-picker screens already use), since only
  // this module can actually render a THREE.js scene — the plain HTML menu
  // panel has no way to offer this.
  const glophimonStatsModalEl = document.createElement("div");
  glophimonStatsModalEl.style.position = "absolute";
  glophimonStatsModalEl.style.display = "none";
  glophimonStatsModalEl.style.inset = "0";
  glophimonStatsModalEl.style.background = "#000000b3";
  glophimonStatsModalEl.style.zIndex = "30";
  glophimonStatsModalEl.style.alignItems = "center";
  glophimonStatsModalEl.style.justifyContent = "center";
  const glophimonStatsCardEl = document.createElement("div");
  glophimonStatsCardEl.style.background = "#1a1a1aee";
  glophimonStatsCardEl.style.border = "1px solid #3333334d";
  glophimonStatsCardEl.style.borderRadius = "6px";
  glophimonStatsCardEl.style.padding = "10px";
  glophimonStatsCardEl.style.width = "300px";
  glophimonStatsCardEl.style.fontSize = "12px";
  glophimonStatsCardEl.style.display = "flex"; // see glophimonPcCardEl's own comment
  glophimonStatsModalEl.appendChild(glophimonStatsCardEl);
  wrap.appendChild(glophimonStatsModalEl);
  const { heading: glophimonStatsHeadingEl, closeBtn: glophimonStatsCloseBtn, body: glophimonStatsBodyEl } =
    setupModalCard(glophimonStatsCardEl, "90%");
  glophimonStatsCloseBtn.addEventListener("click", () => closeGlophimonStatsModal());

  // Developer menu panel — see devMenuButton above.
  const devMenuPanelEl = document.createElement("div");
  devMenuPanelEl.style.position = "absolute";
  devMenuPanelEl.style.display = "none";
  devMenuPanelEl.style.top = "36px";
  devMenuPanelEl.style.left = `${MINIMAP_SIZE + 14}px`; // clear of the minimap, which sits at the same top offset
  devMenuPanelEl.style.background = "#1a1a1aee";
  devMenuPanelEl.style.border = "1px solid #3333334d";
  devMenuPanelEl.style.borderRadius = "4px";
  devMenuPanelEl.style.padding = "6px 8px";
  devMenuPanelEl.style.zIndex = "20";
  devMenuPanelEl.style.fontSize = "12px";
  const devMenuHeading = document.createElement("strong");
  devMenuHeading.textContent = "🛠 Dev";
  devMenuHeading.style.display = "block";
  devMenuHeading.style.marginBottom = "4px";
  devMenuPanelEl.appendChild(devMenuHeading);
  const devVisionLabel = document.createElement("label");
  devVisionLabel.style.display = "flex";
  devVisionLabel.style.alignItems = "center";
  devVisionLabel.style.gap = "4px";
  devVisionLabel.style.cursor = "pointer";
  const devVisionToggle = document.createElement("input");
  devVisionToggle.type = "checkbox";
  devVisionLabel.append(devVisionToggle, document.createTextNode("Show wild Glophimon range"));
  devMenuPanelEl.appendChild(devVisionLabel);
  devMenuPanelEl.appendChild(battleButton);
  devMenuPanelEl.appendChild(teamBattleButton);
  wrap.appendChild(devMenuPanelEl);

  devMenuButton.addEventListener("click", () => {
    devMenuPanelEl.style.display = devMenuPanelEl.style.display === "none" ? "block" : "none";
  });
  devVisionToggle.addEventListener("change", () => {
    showWildVisionRange = devVisionToggle.checked;
  });

  el.appendChild(wrap);

  const { renderer, scene, camera } = createScene(canvas);
  // Only the real overworld gets these (not mountPreview's tight
  // character-color close-up) — see buildSkyDome/buildSunSprite's own
  // comments for why this couldn't just live inside createScene itself.
  const skyDome = buildSkyDome(scene);
  const sunSprite = buildSunSprite(scene);
  const townWallSegments = buildTown(scene);
  buildJaredShop(scene);
  const { board: karirsBoard, tvGroup: karirsTvGroup } = buildKarirsField(scene, townWallSegments);
  buildLubaArea(scene, townWallSegments);
  const {
    board1Group: chessBoard1Group, board1StatusSign: chessBoard1StatusSign,
    board2Group: chessBoard2Group, board2StatusSign: chessBoard2StatusSign,
  } = buildTambayan(scene);
  // Blocks movement into a solid wall segment while leaving the door gaps
  // and the whole interior plaza open — see buildAreaWalls for how these
  // boxes are laid out (both Glophics' and the Karirs field's walls share
  // this one array). Both the local player's own movement and every wild
  // spawn's wander/chase/flee movement resolve against this.
  function isInsideTownWalls(x, z) {
    for (const seg of townWallSegments) {
      if (x >= seg.minX && x <= seg.maxX && z >= seg.minZ && z <= seg.maxZ) return true;
    }
    return false;
  }

  // Fades out ONLY the wall segment(s) actually standing between the
  // camera and whatever's being looked at this frame — every other
  // segment stays fully solid/opaque. targetX/Y/Z defaults to the
  // player's own position (the normal overworld case); called again with
  // the battle dome's own center whenever a battle is active near
  // Glophics, so a wall covering part of the force field fades the same
  // way — see the two call sites in frame()'s own camera block.
  function updateTownWallFade(dt, targetX = local.x, targetY = PAN_TARGET_Y, targetZ = local.z) {
    const ease = Math.min(1, TOWN_WALL_FADE_RATE * dt);
    for (const seg of townWallSegments) {
      const occluding = segmentIntersectsWallBox(
        camera.position.x,
        camera.position.y,
        camera.position.z,
        targetX,
        targetY,
        targetZ,
        seg,
      );
      const targetOpacity = occluding ? TOWN_WALL_OCCLUDED_OPACITY : 1;
      const material = seg.mesh.material;
      material.opacity += (targetOpacity - material.opacity) * ease;
      // Only pay transparent-material's sorting/blending cost while an
      // actual fade is in progress or holding — snap back to a plain
      // opaque draw once it's settled back to fully solid. needsUpdate is
      // required here — three.js doesn't pick up a `transparent` flip on
      // an already-rendered material without it, confirmed the hard way
      // (opacity/transparent were changing correctly every frame, but
      // nothing rendered any different until this was added).
      const faded = material.opacity < 0.99;
      if (faded !== seg.faded) {
        seg.faded = faded;
        material.transparent = faded;
        material.depthWrite = !faded;
        material.needsUpdate = true;
      }
    }
  }

  const character = ctx.character;
  // The player's own trainer HP — real and persistent (see the api's own
  // GlophimonCharacter.current_hp/POST /me/hp), shared by every battle
  // type. Deliberately does NOT reset to full at the start of a new
  // battle any more — see startWildBattle/buildTeamBattleSides, both of
  // which just read whatever this already is. Only Rodz's heal or
  // blacking out (handlePlayerBlackout) restores it.
  let playerHp = character.current_hp ?? PLAYER_MAX_HP;

  function setPlayerHp(newHp) {
    playerHp = Math.max(0, Math.min(PLAYER_MAX_HP, newHp));
    ctx.onSetPlayerHp?.(playerHp);
  }

  // "Blacking out" — trainer HP hit 0 mid-battle. No permanent loss, same
  // as the real games: a free heal, but at the cost of a trip back to
  // Glophics (its exact center, matching the api's own DEFAULT_SPAWN)
  // rather than staying wherever the fight happened to be.
  function handlePlayerBlackout() {
    setPlayerHp(PLAYER_MAX_HP);
    local.x = 0;
    local.z = 0;
    local.facingAngle = 0;
  }

  const localColors = {
    head: character.head_color,
    body: character.body_color,
    arm: character.arm_color,
    leg: character.leg_color,
  };
  const localRig = buildBlockyCharacter(localColors, character.display_name);
  const local = {
    x: character.x,
    y: 0,
    z: character.z,
    facingAngle: character.facing,
    rig: localRig,
    isMoving: false,
    chatBubble: null,
    chatBubbleExpiresAt: 0,
  };
  local.rig.group.position.set(local.x, local.y, local.z);
  local.rig.group.rotation.y = local.facingAngle;
  scene.add(local.rig.group);

  // Sprinting stamina — see SPRINT_SPEED_MULTIPLIER/STAMINA_* above.
  let stamina = STAMINA_MAX;
  let staminaExhausted = false;

  // A persistent, always-there, clickable NPC (see onCanvasClick below) —
  // full scale like a real player, standing at a fixed spot regardless of
  // where the local player happens to be.
  const rodzRig = buildBlockyCharacter(RODZ_COLORS, RODZ_NAME);
  rodzRig.group.position.set(RODZ_X, 0, RODZ_Z);
  scene.add(rodzRig.group);

  // Carrin — the Karirs field's own attendant, same clickable/proximity-
  // gated NPC pattern as Rodz (see onCanvasClick/showKarraMenu). Internal
  // identifiers stay "karra*"/"KARRA_*" — KARRA_NAME is the one thing that
  // actually renders, and it's already "Carrin".
  const karraRig = buildBlockyCharacter(KARRA_COLORS, KARRA_NAME);
  karraRig.group.position.set(KARRA_X, 0, KARRA_Z);
  scene.add(karraRig.group);

  // Jared — Glophics' shop owner, same clickable/proximity-gated NPC
  // pattern as Rodz/Carrin (see onCanvasClick/showJaredMenu).
  const jaredRig = buildBlockyCharacter(JARED_COLORS, JARED_NAME);
  jaredRig.group.position.set(JARED_X, 0, JARED_Z);
  scene.add(jaredRig.group);

  // Boss Rick — the Luba area's own attendant, same clickable/proximity-
  // gated NPC pattern as Rodz/Carrin/Jared (see onCanvasClick/
  // showBossRickMenu).
  const bossRickRig = buildBlockyCharacter(BOSS_RICK_COLORS, BOSS_RICK_NAME);
  bossRickRig.group.position.set(BOSS_RICK_X, 0, BOSS_RICK_Z);
  scene.add(bossRickRig.group);

  // Rodz's ambient shout loop — see RODZ_SHOUT_TEXT/updateRodzShout.
  // rodzShoutBubble is the currently-visible sprite, or null while in the
  // "hidden" half of the cycle (or whenever there's nothing to claim).
  let rodzShoutBubble = null;
  let rodzShoutPhase = "hidden"; // "hidden" | "visible"
  let rodzShoutElapsedMs = 0;

  function hideRodzShoutBubble() {
    if (!rodzShoutBubble) return;
    scene.remove(rodzShoutBubble);
    disposeChatBubble(rodzShoutBubble);
    rodzShoutBubble = null;
    rodzShoutPhase = "hidden";
    rodzShoutElapsedMs = 0;
  }

  // Each player only ever sees their OWN claim state (menuData.inventory
  // is fetched per-account, never shared/broadcast) — so this loop is
  // naturally per-viewer despite Rodz being the same one NPC everyone
  // sees, exactly as asked: everyone can claim their own reward, and
  // seeing someone else already claimed theirs never silences your own
  // shout.
  function updateRodzShout(dt) {
    // Nothing to shout about, or the player is already looking at the
    // popup that answers the question — stay/go quiet.
    if (!menuData.inventory.daily_claim_available || battle || teamBattle || pvpBattle || rodzMenuEl.style.display !== "none") {
      hideRodzShoutBubble();
      return;
    }
    rodzShoutElapsedMs += dt * 1000;
    if (rodzShoutPhase === "hidden") {
      if (rodzShoutElapsedMs >= RODZ_SHOUT_HIDDEN_MS) {
        rodzShoutPhase = "visible";
        rodzShoutElapsedMs = 0;
        rodzShoutBubble = createChatBubble(RODZ_NAME, RODZ_SHOUT_TEXT, canvas.clientWidth || canvas.width);
        scene.add(rodzShoutBubble);
      }
      return;
    }
    rodzShoutBubble.visible = Math.hypot(local.x - RODZ_X, local.z - RODZ_Z) <= LABEL_VISIBLE_DISTANCE;
    if (rodzShoutBubble.visible) {
      const anchor = computeBubbleAnchorWorld({ x: RODZ_X, y: 0, z: RODZ_Z, rig: rodzRig });
      scaleChatBubble(anchor, rodzShoutBubble, camera, lastHeight || canvas.height);
      positionChatBubbleAt(rodzShoutBubble, anchor);
    }
    if (rodzShoutElapsedMs >= RODZ_SHOUT_VISIBLE_MS) {
      hideRodzShoutBubble();
    }
  }

  // Same "close enough to actually interact" range check onCanvasClick
  // itself enforces — this is purely the visual cue so the player can see
  // that from where they're standing, not a separate rule of its own. A
  // gentle held pulse (not a one-shot fade like updateTargetFlash's battle
  // target flash) via the same additive-emissive technique, since there's
  // no fixed end time — it just tracks whether you're in range or not,
  // every frame. Shared by every NPC (Rodz, Carrin, Jared) — each gets its
  // own updater closure below so one NPC's pulse phase never resets just
  // because another one lit up or went dark.
  const NPC_HIGHLIGHT_COLOR = new THREE.Color("#ffd24d");
  const NPC_HIGHLIGHT_PEAK = 0.55;
  const NPC_HIGHLIGHT_PULSE_HZ = 0.6;

  function setRigEmissiveIntensity(rig, intensity) {
    rig.group.traverse((obj) => {
      if (obj.isMesh && obj.material && obj.material.emissive) {
        obj.material.emissive.set(NPC_HIGHLIGHT_COLOR);
        obj.material.emissiveIntensity = intensity;
      }
    });
  }

  // getTargetXZ() -> [x, z], read fresh every call rather than a fixed
  // pair — NPCs pass a trivial constant-returning closure (their position
  // never changes), but this same function is also how a live player's
  // own highlight works (see ensurePeer's own peer.updateHighlight),
  // where the target genuinely moves every frame. extraCondition() is an
  // additional OR'd-in reason to highlight beyond plain proximity — used
  // by the two chess tables so an in-progress game highlights for anyone
  // inside Chessdom, not just someone standing right next to that table
  // (see the chessBoard*Highlight updaters below).
  function createNpcHighlightUpdater(rig, getTargetXZ, extraCondition = () => false) {
    let elapsedMs = 0;
    return (dt) => {
      const [targetX, targetZ] = getTargetXZ();
      const inRange = !battle && !teamBattle && !pvpBattle &&
        (Math.hypot(local.x - targetX, local.z - targetZ) <= INTERACTION_RANGE || extraCondition());
      if (!inRange) {
        elapsedMs = 0;
        setRigEmissiveIntensity(rig, 0);
        return;
      }
      elapsedMs += dt * 1000;
      const pulse = (Math.sin((elapsedMs / 1000) * NPC_HIGHLIGHT_PULSE_HZ * Math.PI * 2) + 1) / 2; // 0..1
      setRigEmissiveIntensity(rig, NPC_HIGHLIGHT_PEAK * (0.4 + 0.6 * pulse)); // never fully off mid-pulse — stays readable as "highlighted" throughout
    };
  }
  const updateRodzHighlight = createNpcHighlightUpdater(rodzRig, () => [RODZ_X, RODZ_Z]);
  const updateCarrinHighlight = createNpcHighlightUpdater(karraRig, () => [KARRA_X, KARRA_Z]);
  const updateJaredHighlight = createNpcHighlightUpdater(jaredRig, () => [JARED_X, JARED_Z]);
  const updateBossRickHighlight = createNpcHighlightUpdater(bossRickRig, () => [BOSS_RICK_X, BOSS_RICK_Z]);

  // Mirrors the last chess_state received per board (see onSocketMessage's
  // own chess_state branch) — {status, hostId, hostDisplayName,
  // whiteUserId, whiteDisplayName, blackUserId, blackDisplayName, fen,
  // turn, moveHistory, outcome}. Starts "empty" until the server's own
  // initial broadcast (sent to every connection on join, see main.py)
  // lands.
  const chessBoards = {
    1: { status: "empty" },
    2: { status: "empty" },
  };
  // setRigEmissiveIntensity expects {group}, same shape a real rig has —
  // these tables aren't rigs, just wrap the raw THREE.Group.
  const updateChessBoard1Highlight = createNpcHighlightUpdater(
    { group: chessBoard1Group },
    () => [CHESS_BOARD_1_X, CHESS_BOARD_1_Z],
    () => chessBoards[1].status === "in_progress" && isInsideTambayan(local.x, local.z),
  );
  const updateChessBoard2Highlight = createNpcHighlightUpdater(
    { group: chessBoard2Group },
    () => [CHESS_BOARD_2_X, CHESS_BOARD_2_Z],
    () => chessBoards[2].status === "in_progress" && isInsideTambayan(local.x, local.z),
  );

  // user_id -> peer state, for everyone *else* currently connected.
  const peers = new Map();

  function ensurePeer(userId, displayName, appearance, x, z, facing) {
    let peer = peers.get(userId);
    if (!peer) {
      const rig = buildBlockyCharacter(
        { head: appearance.head_color, body: appearance.body_color, arm: appearance.arm_color, leg: appearance.leg_color },
        displayName,
      );
      scene.add(rig.group);
      peer = {
        rig,
        displayName,
        x,
        y: 0,
        z,
        facingAngle: facing,
        targetX: x,
        targetZ: z,
        targetFacing: facing,
        isMoving: false,
        chatBubble: null,
        chatBubbleExpiresAt: 0,
      };
      // A live target, unlike every NPC's own fixed one — peer.x/z are
      // updated every frame by the eased-movement loop below, so reading
      // them fresh each call (rather than closing over x/z here, which
      // would freeze at this moment of arrival) is what makes the
      // highlight actually track a moving player.
      peer.updateHighlight = createNpcHighlightUpdater(rig, () => [peer.x, peer.z]);
      peer.rig.group.position.set(x, 0, z);
      peer.rig.group.rotation.y = facing;
      peers.set(userId, peer);
    }
    return peer;
  }

  function removePeer(userId) {
    const peer = peers.get(userId);
    if (!peer) return;
    scene.remove(peer.rig.group);
    disposeRig(peer.rig);
    if (peer.chatBubble) {
      scene.remove(peer.chatBubble);
      disposeChatBubble(peer.chatBubble);
    }
    peers.delete(userId);
  }

  function setPeerHidden(peer, hidden) {
    peer.rig.group.visible = !hidden;
  }

  // Generic version of the "translucent so it doesn't block the view"
  // effect — used both for the player's own avatar (the whole battle
  // through) and, separately, for whichever Glophimon the camera is
  // currently focused directly behind (see TEAM_FOCUS_CAM_* above). Only
  // meshes (not the name-label sprite) are touched, same as disposeRig's
  // own mesh-only traversal.
  function setRigTransparent(rig, on) {
    rig.group.traverse((obj) => {
      if (obj.isMesh) {
        obj.material.transparent = true;
        obj.material.opacity = on ? 0.3 : 1;
        // Confirmed the hard way (see updateTownWallFade's own comment) —
        // three.js doesn't pick up a `transparent` flip on an
        // already-rendered material without this.
        obj.material.needsUpdate = true;
      }
    });
  }

  function setLocalTransparent(on) {
    setRigTransparent(local.rig, on);
  }

  // Roaming wild Glophimon — genuinely shared/server-owned now (see
  // games/glophimon/api's own wild_tick_loop): every connected player sees
  // the exact same creatures at the exact same positions, broadcast over
  // this same world socket (wild_roster/wild_spawn/wild_despawn/wild_tick/
  // wild_engaged/wild_released — see onSocketMessage further below). This
  // map is now purely a *render* of that broadcast state, the same way
  // `peers` already is for other players — no wander/flee/chase/spawn-
  // timer simulation happens client-side any more; ensureWildSpawn just
  // builds the rig, and the per-frame loop below eases toward whatever
  // x/z/facing the server last reported, exactly like a peer.
  const wildSpawns = new Map(); // server wild id -> spawn render state
  let showWildVisionRange = false; // dev-menu toggle, see devVisionToggle below


  function createVisionWedge(color) {
    // A flat pie-slice sector, not a full circle — CircleGeometry's
    // (thetaStart, thetaLength) params draw exactly that. Centered on local
    // -Y (thetaStart offset by -PI/2 - halfAngle) so that, after the child
    // mesh's own rotation.x lays it flat and the wrapper's rotation.y is
    // set to a rig's facingAngle each frame, the sector's centerline ends
    // up pointing the same direction as that facing (fx=sin, fz=cos) —
    // confirmed empirically via a debug hook rather than derived purely by
    // hand, since composing two single-axis rotations this way is easy to
    // get backwards.
    const wrapper = new THREE.Group();
    const geometry = new THREE.CircleGeometry(
      WILD_VISION_RANGE,
      24,
      -Math.PI / 2 - WILD_VISION_HALF_ANGLE,
      WILD_VISION_HALF_ANGLE * 2,
    );
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: WILD_VISION_WEDGE_OPACITY,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    wrapper.add(mesh);
    wrapper.position.y = 0.02; // just above the ground plane/grid, avoiding z-fighting
    wrapper.visible = false;
    scene.add(wrapper);
    return wrapper;
  }

  // Builds (or, if the server later resends one we already have — e.g.
  // re-adding a released wild locally, see releaseEngagedWild — just
  // returns) the render state for one server-owned wild. difficulty/label/
  // wedge color are still a purely local, per-viewer computation (relative
  // to *this* player's own starter level), same as before.
  function ensureWildSpawn(id, speciesKey, level, x, z, facing, engagedByOther) {
    const existing = wildSpawns.get(id);
    if (existing) return existing;
    const species = SPECIES_BY_KEY[speciesKey];
    if (!species) return null; // shouldn't happen — defensive only
    const playerLevel = ctx.starter?.level ?? 1;
    const difficulty = level > playerLevel ? "hard" : "easy";
    const labelColor = difficulty === "hard" ? WILD_LABEL_COLOR_HARD : WILD_LABEL_COLOR_EASY;
    const wedgeColor = difficulty === "hard" ? WILD_VISION_WEDGE_COLOR_HARD : WILD_VISION_WEDGE_COLOR_EASY;

    const rig = buildBlockyCharacter(
      { head: species.head_color, body: species.body_color, arm: species.arm_color, leg: species.leg_color },
      `${species.name} Lv.${level}`,
      labelColor,
    );
    rig.group.scale.setScalar(CREATURE_SCALE);
    rig.group.position.set(x, 0, z);
    rig.group.rotation.y = facing;
    scene.add(rig.group);

    const spawn = {
      id,
      rig,
      species,
      level,
      difficulty,
      x,
      z,
      facingAngle: facing,
      targetX: x,
      targetZ: z,
      targetFacing: facing,
      isMoving: false,
      engagedByOther: !!engagedByOther,
      visionWedge: createVisionWedge(wedgeColor),
    };
    if (spawn.engagedByOther) setRigTransparent(rig, true);
    wildSpawns.set(id, spawn);
    return spawn;
  }

  function removeWildSpawn(id) {
    const spawn = wildSpawns.get(id);
    if (!spawn) return;
    scene.remove(spawn.rig.group);
    disposeRig(spawn.rig);
    scene.remove(spawn.visionWedge);
    spawn.visionWedge.children[0].geometry.dispose();
    spawn.visionWedge.children[0].material.dispose();
    wildSpawns.delete(id);
  }

  // Eases every wild toward wherever the server last placed it (exactly
  // the peers.values() loop's own pattern) — no AI/spawn-timer simulation
  // happens here any more, that's all server-side now (see
  // games/glophimon/api's own wild_tick_loop). The two purely-local
  // rendering rules requested alongside making this shared:
  //  - a wild inside *my own* active battle dome is hidden outright, so it
  //    doesn't wander through my fight and disturb it (identical to how
  //    setPeerHidden already treats other players near the dome);
  //  - a wild engaged by *someone else* renders at reduced opacity
  //    (engagedByOther, set from the wild_engaged broadcast) — still
  //    visibly there, just clearly "already being fought," until it's
  //    released or caught.
  function updateWildSpawns(dt) {
    for (const spawn of wildSpawns.values()) {
      const ease = Math.min(1, 12 * dt);
      spawn.x += (spawn.targetX - spawn.x) * ease;
      spawn.z += (spawn.targetZ - spawn.z) * ease;
      spawn.facingAngle = spawn.targetFacing;
      if (spawn.isMoving) updateWalkCycle(spawn.rig, dt);
      else applyIdlePose(spawn.rig, dt);
      spawn.rig.group.position.set(spawn.x, 0, spawn.z);
      spawn.rig.group.rotation.y = spawn.facingAngle;
      syncNameLabel(spawn.rig);
      scaleNameLabel(spawn.rig, camera, lastHeight || canvas.height, Math.hypot(local.x - spawn.x, local.z - spawn.z) <= LABEL_VISIBLE_DISTANCE);

      spawn.visionWedge.position.set(spawn.x, 0.02, spawn.z);
      spawn.visionWedge.rotation.y = spawn.facingAngle;
      spawn.visionWedge.visible = showWildVisionRange;

      if (battle) {
        const dist = Math.hypot(spawn.x - battle.centerX, spawn.z - battle.centerZ);
        spawn.rig.group.visible = dist > BATTLE_DOME_RADIUS;
      } else if (teamBattle) {
        const dist = Math.hypot(spawn.x - teamBattle.centerX, spawn.z - teamBattle.centerZ);
        spawn.rig.group.visible = dist > TEAM_DOME_RADIUS;
      } else {
        spawn.rig.group.visible = true;
      }
    }
  }

  // Bumping into a roaming wild Glophimon — wandering, fleeing, or mid-
  // chase — starts a real battle using that specific species (see
  // startWildBattle's own speciesOverride param), same battle system the
  // Dev menu's "Simulate Wild Battle" button already exercises. Engaging
  // is exclusive server-side now (see the api's own /wild/{id}/engage) —
  // awaited before the battle actually starts, so a race with another
  // player touching the same wild at the same moment resolves cleanly:
  // whoever loses the race just quietly doesn't start a fight this frame,
  // same as if contact hadn't happened at all.
  let wildContactPending = false;
  // A breather after ANY battle ends (caught, escaped, or the wild
  // otherwise released) before contact can trigger another one — set
  // unconditionally in endBattle, regardless of outcome. Without this,
  // ending a battle right on top of a wild (releasing it puts it back at
  // the exact spot you were just standing on) would immediately re-trigger
  // contact with it — or, in the shared world, whatever else happens to be
  // standing right there — chaining straight into another fight with no
  // real gap in between. Matches the api's own WILD_VISION_IMMUNITY_S,
  // which keeps every wild's own vision check from spotting this player
  // for the same window, so nothing chases/flees from you either while
  // you're meant to be taking a breather.
  const POST_BATTLE_COOLDOWN_MS = 8000;
  let battleCooldownUntil = 0;

  function checkWildContact() {
    if (battle || teamBattle || pvpBattle || !ctx.starter || wildContactPending) return;
    if (performance.now() < battleCooldownUntil) return;
    for (const spawn of wildSpawns.values()) {
      if (spawn.engagedByOther) continue; // someone else already has this one
      const dist = Math.hypot(local.x - spawn.x, local.z - spawn.z);
      if (dist <= WILD_CONTACT_RADIUS) {
        const { id, species, level } = spawn;
        wildContactPending = true;
        Promise.resolve(ctx.onEngageWild?.(id)).then((ok) => {
          wildContactPending = false;
          if (ok) {
            removeWildSpawn(id);
            startWildBattle(species, level, id);
          }
        });
        return;
      }
    }
  }

  function logBattle(text) {
    const p = document.createElement("p");
    p.style.margin = "1px 0";
    p.textContent = text;
    battleLogEl.appendChild(p);
    battleLogEl.scrollTop = battleLogEl.scrollHeight;
  }

  function updateHpBars() {
    if (!battle) return;
    const trainerPct = Math.max(0, Math.round((playerHp / PLAYER_MAX_HP) * 100));
    playerTrainerHpRow.barFill.style.width = `${trainerPct}%`;
    playerTrainerHpRow.nameEl.textContent = `Trainer — ${playerHp}/${PLAYER_MAX_HP} HP`;
    battle.playerTeam.forEach((member, i) => {
      const row = playerHpRows[i];
      row.row.style.display = "";
      const pct = Math.max(0, Math.round((member.combatant.hp / member.combatant.maxHp) * 100));
      row.barFill.style.width = `${pct}%`;
      const faintedMark = member.combatant.fainted ? " (fainted)" : "";
      row.nameEl.textContent = `${member.combatant.name} — ${member.combatant.hp}/${member.combatant.maxHp} HP${faintedMark}`;
    });
    for (let i = battle.playerTeam.length; i < playerHpRows.length; i++) playerHpRows[i].row.style.display = "none";
    const wildPct = Math.max(0, Math.round((battle.wild.hp / battle.wild.maxHp) * 100));
    wildHpRow.barFill.style.width = `${wildPct}%`;
    wildHpRow.nameEl.textContent = `${battle.wild.name} — ${battle.wild.hp}/${battle.wild.maxHp} HP`;
  }

  // battle (wild, 1-vs-1) and teamBattle (3v3 NPC simulation, defined
  // further below) are mutually exclusive — only one of either kind runs
  // at a time, both battle-trigger buttons disable together whichever is
  // active.
  let battle = null;

  // fraction: 0 at 1 HP, 1 at full HP — inverted (1 - fraction) so a nearly-
  // fainted target is the easy end and full HP is the hard end, matching
  // "as the wild Glophimon's HP goes down, the catch rate becomes higher."
  function computeCatchChance(wild) {
    if (wild.hp <= 0) return 0; // already fainted — can't be caught any more
    const fraction = wild.maxHp > 1 ? (wild.hp - 1) / (wild.maxHp - 1) : 0;
    const rate = CATCH_RATE_LOW_HP - fraction * (CATCH_RATE_LOW_HP - CATCH_RATE_FULL_HP);
    return Math.min(CATCH_RATE_MAX, rate);
  }

  function setBattleButtonsDisabled(disabled) {
    battleButton.disabled = disabled;
    teamBattleButton.disabled = disabled;
    glophimonMenuButton.disabled = disabled;
  }

  // Active Lineup / PC Storage / Bag — populated by setMenuData (mount()'s
  // own return value) whenever a 'glophimon.menu' round-trip lands. Kept as
  // plain state here (not re-fetched by this module directly) since only
  // the extension host can actually reach the Glophimon API — see this
  // file's own net/glophimonSocket.js comment on why HTTP goes through the
  // host rather than a direct fetch from the webview.
  let menuData = { glophimon: [], inventory: { glophiballs: 0, potions: 0, daily_claim_available: false, g_coins: 0 } };

  // The Karirs field's own state — karirsRace is purely a render of
  // whatever the world socket's karirs_state/_created/_started/_resolved
  // messages say (see onSocketMessage), same "server owns it, this is
  // just a view" shape wildSpawns already is. karirsMyBet/
  // karirsUnclaimedTotal are per-user and only known after an
  // authenticated fetch (see refreshKarraMenu) — never sent over the
  // shared broadcast, which every connected player receives.
  let karirsRace = null;
  let karirsMyBet = null;
  let karirsUnclaimedTotal = 0;
  // The last race to actually finish before karirsRace — lets the TV offer
  // a "watch the previous race" replay even once betting has reopened and
  // karirsRace itself has moved on (see the api's own previous_race field
  // and karirs_race_resolved below, which is what keeps this current for
  // anyone who was already connected when it happened).
  let karirsPreviousRace = null;
  // Whether the TV popup is currently showing that replay instead of the
  // normal live/countdown view — always reset to false on open (see
  // showKarirsTvMenu) — and, while true, the local wall-clock timestamp
  // the replay itself started at (independent of the race's own real
  // started_at, which the live view replays against instead).
  let karirsTvShowingPreview = false;
  let karirsPreviewStartedAt = 0;
  let statsModalGlophimon = null; // the owned-Glophimon row the stats modal is currently showing, if any
  let releasingId = null; // owned-Glophimon id currently showing "Confirm Release?" in place of its normal row actions
  let actionsForId = null; // owned-Glophimon id currently showing its expanded action list (see makeGlophimonRow)
  let localUserId = null; // this account's own user_id — learned once from the server's own "self" message, needed to tell "me" apart from other Luba lobby members
  let bossRickStep = "closed"; // "closed" | "host_confirm" | "mode_confirm" | "duration_select" — see renderBossRickMenu
  let lubaLobby = null; // the last luba_lobby_state payload received, or null while not in one — see renderLubaLobbyModal
  let playerOptionsMenuUserId = null; // whose popup is currently open, or null — see showPlayerOptionsMenu
  let outgoingPvpInvite = null; // {inviteId, toUserId, toDisplayName} — an invite this player just sent, awaiting response
  let incomingPvpInvite = null; // {inviteId, fromUserId, fromDisplayName} — an invite this player has been asked to accept/reject
  // Stage 2 — the real battle, once an invite is accepted. Sibling to
  // battle/teamBattle, but server-authoritative: this client never runs
  // resolveMove itself, it only renders what pvp_round_result reports.
  // { matchId, opponentUserId, opponentDisplayName, selfCombatant,
  //   opponentCombatant, selfSpeciesKey, opponentSpeciesKey, selfOwnedId,
  //   selfRig, opponentRig, domeMesh, centerX, centerZ, midX, midZ, camAngle,
  //   hasSubmitted, opponentReady, hiddenPeer, ended }
  let pvpBattle = null;

  // Chessdom — see chessBoards (declared alongside the two highlight
  // updaters) for the server-mirrored board state itself; these are just
  // the local UI/popup states.
  let chessHostTargetBoardId = null; // which board's host-confirm popup is open, or null
  let chessJoinTargetBoardId = null; // which board's join-confirm popup is open, or null
  let myHostedChessBoardId = null; // the board I'm currently hosting/waiting on, or null
  let activeChessMatch = null; // {boardId, isSpectator, selectedSquare} while the match/spectate modal is open, else null
  let chessLeaveWarningIntervalId = null; // the setInterval driving the local countdown display, or null while hidden


  // The real active lineup (up to WILD_TEAM_MAX_SIZE, in slot order) —
  // menuData is populated at mount time now (see chat.js's own
  // enterGlophimon, which calls setMenuData right after mount()), not
  // just whenever the player happens to open the Menu, so this is reliably
  // available the moment a wild battle actually starts. Falls back to a
  // single entry synthesized from ctx.starter only if menuData somehow
  // never got populated at all (e.g. the initial fetch failed) — the
  // shape matches an OwnedGlophimonOut row closely enough for
  // startWildBattle's own species/IV/EV lookups.
  function getActiveLineup() {
    const owned = menuData.glophimon
      .filter((g) => g.active_slot !== null)
      .sort((a, b) => a.active_slot - b.active_slot)
      .slice(0, WILD_TEAM_MAX_SIZE);
    if (owned.length > 0) return owned;
    if (!ctx.starter) return [];
    return [{
      id: null,
      species_key: ctx.starter.species_key,
      level: ctx.starter.level,
      iv_speed: ctx.starter.iv_speed,
      iv_attack: ctx.starter.iv_attack,
      iv_special_attack: ctx.starter.iv_special_attack,
      iv_defense: ctx.starter.iv_defense,
      iv_special_defense: ctx.starter.iv_special_defense,
      ev_speed: ctx.starter.ev_speed,
      ev_attack: ctx.starter.ev_attack,
      ev_special_attack: ctx.starter.ev_special_attack,
      ev_defense: ctx.starter.ev_defense,
      ev_special_defense: ctx.starter.ev_special_defense,
    }];
  }

  let statsModalPreview = null;

  function closeGlophimonMenuPanel() {
    glophimonMenuPanelEl.style.display = "none";
    glophimonPcModalEl.style.display = "none";
    glophimonBagModalEl.style.display = "none";
  }

  function closeGlophimonStatsModal() {
    if (statsModalPreview) {
      statsModalPreview.dispose();
      statsModalPreview = null;
    }
    statsModalGlophimon = null;
    glophimonStatsModalEl.style.display = "none";
  }

  function openGlophimonStatsModal(g) {
    closeGlophimonStatsModal();
    statsModalGlophimon = g;
    const species = SPECIES_BY_KEY[g.species_key];
    glophimonStatsHeadingEl.textContent = `${species.name} (Lv. ${g.level})`;
    glophimonStatsBodyEl.innerHTML = "";

    const previewEl = document.createElement("div");
    previewEl.style.margin = "0 auto 6px auto";
    glophimonStatsBodyEl.appendChild(previewEl);
    statsModalPreview = mountPreview(previewEl, {
      head: species.head_color,
      body: species.body_color,
      arm: species.arm_color,
      leg: species.leg_color,
    });

    const subtitle = document.createElement("p");
    const tierLabel = species.tier === "legendary" ? "Legendary" : species.tier === "rare" ? "Rare" : "Common";
    subtitle.textContent = `${tierLabel} — ${species.types.join(", ")}`;
    subtitle.style.margin = "2px 0 8px 0";
    subtitle.style.color = "#a3a3a3";
    glophimonStatsBodyEl.appendChild(subtitle);

    const hp = g.current_hp ?? maxHpFor(g.level);
    const maxHp = maxHpFor(g.level);
    const hpEl = document.createElement("p");
    hpEl.style.margin = "0 0 4px 0";
    hpEl.style.fontSize = "11px";
    hpEl.style.color = hp <= 0 ? "#ef4444" : "#a3a3a3";
    hpEl.textContent = hp <= 0 ? `HP: Fainted (0/${maxHp}) — visit Rodz to heal` : `HP: ${hp}/${maxHp}`;
    glophimonStatsBodyEl.appendChild(hpEl);

    const expEl = document.createElement("p");
    expEl.style.margin = "0 0 8px 0";
    expEl.style.fontSize = "11px";
    expEl.style.color = "#a3a3a3";
    expEl.textContent =
      g.level >= MAX_LEVEL
        ? `${g.experience.toLocaleString()} EXP (max level)`
        : `${g.experience.toLocaleString()} / ${expForLevel(g.level + 1).toLocaleString()} EXP`;
    glophimonStatsBodyEl.appendChild(expEl);

    const statsTable = document.createElement("table");
    statsTable.style.width = "100%";
    statsTable.style.borderCollapse = "collapse";
    statsTable.style.fontSize = "11px";
    const header = document.createElement("tr");
    ["Stat", "IV", "EV"].forEach((h) => {
      const th = document.createElement("th");
      th.textContent = h;
      th.style.textAlign = "left";
      th.style.borderBottom = "1px solid #3333334d";
      th.style.padding = "2px 4px";
      header.appendChild(th);
    });
    statsTable.appendChild(header);
    [
      ["Speed", g.iv_speed, g.ev_speed],
      ["Attack", g.iv_attack, g.ev_attack],
      ["Sp. Attack", g.iv_special_attack, g.ev_special_attack],
      ["Defense", g.iv_defense, g.ev_defense],
      ["Sp. Defense", g.iv_special_defense, g.ev_special_defense],
    ].forEach(([label, iv, ev]) => {
      const row = document.createElement("tr");
      [label, iv, ev].forEach((val) => {
        const td = document.createElement("td");
        td.textContent = String(val);
        td.style.padding = "2px 4px";
        row.appendChild(td);
      });
      statsTable.appendChild(row);
    });
    glophimonStatsBodyEl.appendChild(statsTable);

    const movesHeading = document.createElement("p");
    movesHeading.textContent = "Moves";
    movesHeading.style.fontSize = "11px";
    movesHeading.style.color = "#a3a3a3";
    movesHeading.style.margin = "8px 0 2px 0";
    glophimonStatsBodyEl.appendChild(movesHeading);

    for (const move of movesForSpecies(g.species_key)) {
      const moveCard = document.createElement("div");
      moveCard.style.margin = "0 0 6px 0";
      moveCard.style.padding = "4px 6px";
      moveCard.style.border = "1px solid #3333334d";
      moveCard.style.borderRadius = "4px";

      const nameRow = document.createElement("div");
      nameRow.style.display = "flex";
      nameRow.style.justifyContent = "space-between";
      nameRow.style.fontSize = "11px";
      const nameEl = document.createElement("strong");
      nameEl.textContent = move.name;
      const statsEl = document.createElement("span");
      statsEl.style.color = "#a3a3a3";
      const statBits = [];
      if (move.power) statBits.push(`Pwr ${move.power}`);
      statBits.push(move.accuracy == null ? "Acc —" : `Acc ${move.accuracy}%`);
      statBits.push(`PP ${move.pp}`);
      statsEl.textContent = statBits.join(" · ");
      nameRow.append(nameEl, statsEl);
      moveCard.appendChild(nameRow);

      const descEl = document.createElement("p");
      descEl.style.margin = "2px 0 0 0";
      descEl.style.fontSize = "10px";
      descEl.style.color = "#a3a3a3";
      descEl.textContent = describeMove(move);
      moveCard.appendChild(descEl);

      glophimonStatsBodyEl.appendChild(moveCard);
    }

    glophimonStatsModalEl.style.display = "flex";
  }

  // Top-level Menu — a plain list of options now (Glophimon's PC / Bag /
  // Leave Glophimon), not the Active Lineup/PC/Bag content itself — that
  // content moved into its own modal (see renderGlophimonPcModal/
  // renderGlophimonBagModal below), each reached by tapping its own row
  // here. "Leave Glophimon" used to be a separate vscode-chrome button
  // (see chat.js's own onLeaveGlophimon) — it's just this list's last
  // option now, there being only one Menu button/panel any more.
  function closeGlophimonPcModal() {
    glophimonPcModalEl.style.display = "none";
    releasingId = null;
    actionsForId = null;
  }
  function closeGlophimonBagModal() {
    glophimonBagModalEl.style.display = "none";
  }

  function renderGlophimonMenuList() {
    glophimonMenuBodyEl.innerHTML = "";

    const listEl = document.createElement("ul");
    listEl.style.listStyle = "none";
    listEl.style.padding = "0";
    listEl.style.margin = "0";
    listEl.style.display = "flex";
    listEl.style.flexDirection = "column";
    listEl.style.gap = "4px";

    function addOption(label, onClick) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.fontSize = "12px";
      btn.style.width = "100%";
      btn.style.textAlign = "left";
      btn.style.padding = "6px 8px";
      btn.addEventListener("click", onClick);
      li.appendChild(btn);
      listEl.appendChild(li);
    }

    addOption("Glophimon's PC", () => {
      glophimonPcModalEl.style.display = "flex";
      renderGlophimonPcModal();
    });
    addOption("Bag", () => {
      glophimonBagModalEl.style.display = "flex";
      renderGlophimonBagModal();
    });
    addOption("Leave Glophimon", () => {
      ctx.onLeaveGlophimon?.();
    });

    glophimonMenuBodyEl.appendChild(listEl);
  }

  // actions: [{label, onClick}, ...] — collapsed behind a single "Actions"
  // toggle beside the name (see actionsForId) rather than laid out inline
  // for every row, so a long PC roster doesn't turn into a wall of "To PC/
  // →1/→2/→3/Release" buttons repeated per Glophimon. Expanding shows them
  // as their own row underneath the name; if this row is the one currently
  // mid-release-confirm (see releasingId), that expanded row is replaced
  // with a single "Confirm Release?"/"Cancel" pair instead. No native
  // confirm()/alert() here — untested (and in some webview setups,
  // unsupported) inside a vscode webview, so this reuses the same "swap in
  // a second button pair inline" idea Rodz's own Ask-for-Duel/Cancel menu
  // already established.
  function makeGlophimonRow(g, actions) {
    const li = document.createElement("li");
    li.style.display = "flex";
    li.style.flexDirection = "column";
    li.style.gap = "2px";
    li.style.margin = "2px 0";

    const topRow = document.createElement("div");
    topRow.style.display = "flex";
    topRow.style.alignItems = "center";
    topRow.style.justifyContent = "space-between";
    topRow.style.gap = "4px";
    li.appendChild(topRow);

    const hp = g.current_hp ?? maxHpFor(g.level);
    const maxHp = maxHpFor(g.level);
    const hpLabel = hp <= 0 ? " (Fainted)" : ` — ${hp}/${maxHp} HP`;
    const nameBtn = document.createElement("button");
    nameBtn.textContent = `${SPECIES_BY_KEY[g.species_key]?.name ?? g.species_name} Lv.${g.level}${hpLabel}`;
    nameBtn.style.fontSize = "11px";
    if (hp <= 0) nameBtn.style.color = "#ef4444";
    nameBtn.style.flex = "1";
    nameBtn.style.textAlign = "left";
    nameBtn.addEventListener("click", () => openGlophimonStatsModal(g));
    topRow.appendChild(nameBtn);

    if (g.id === releasingId) {
      const confirmBtn = document.createElement("button");
      confirmBtn.textContent = "Confirm Release?";
      confirmBtn.style.fontSize = "10px";
      confirmBtn.style.color = "#ef4444";
      confirmBtn.addEventListener("click", () => {
        releasingId = null;
        ctx.onReleaseGlophimon?.(g.id);
      });
      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.style.fontSize = "10px";
      cancelBtn.addEventListener("click", () => {
        releasingId = null;
        renderGlophimonPcModal();
      });
      topRow.append(confirmBtn, cancelBtn);
      return li;
    }

    const actionsToggleBtn = document.createElement("button");
    actionsToggleBtn.textContent = g.id === actionsForId ? "▲ Actions" : "▼ Actions";
    actionsToggleBtn.style.fontSize = "10px";
    actionsToggleBtn.addEventListener("click", () => {
      actionsForId = actionsForId === g.id ? null : g.id;
      renderGlophimonPcModal();
    });
    topRow.appendChild(actionsToggleBtn);

    if (g.id === actionsForId) {
      const actionsRow = document.createElement("div");
      actionsRow.style.display = "flex";
      actionsRow.style.flexWrap = "wrap";
      actionsRow.style.gap = "4px";
      actionsRow.style.paddingLeft = "8px";
      for (const { label, onClick } of actions) {
        const actionBtn = document.createElement("button");
        actionBtn.textContent = label;
        actionBtn.style.fontSize = "10px";
        actionBtn.addEventListener("click", onClick);
        actionsRow.appendChild(actionBtn);
      }
      li.appendChild(actionsRow);
    }

    return li;
  }

  function glophimonReleaseAction(g) {
    return {
      label: "Release",
      onClick: () => {
        releasingId = g.id;
        renderGlophimonPcModal();
      },
    };
  }

  // "Glophimon's PC" modal — Active Lineup + PC Storage, the same content
  // (and makeGlophimonRow/glophimonReleaseAction machinery) the old inline
  // panel used to show directly, now behind its own menu option.
  function renderGlophimonPcModal() {
    glophimonPcBodyEl.innerHTML = "";

    const list = menuData.glophimon;
    const active = list.filter((g) => g.active_slot !== null).sort((a, b) => a.active_slot - b.active_slot);
    const boxed = list.filter((g) => g.active_slot === null);

    const activeHeading = document.createElement("p");
    activeHeading.textContent = "Active Lineup";
    activeHeading.style.fontSize = "11px";
    activeHeading.style.color = "#a3a3a3";
    activeHeading.style.margin = "0 0 2px 0";
    glophimonPcBodyEl.appendChild(activeHeading);
    const activeUl = document.createElement("ul");
    activeUl.style.listStyle = "none";
    activeUl.style.padding = "0";
    activeUl.style.margin = "0";
    active.forEach((g) => {
      activeUl.appendChild(makeGlophimonRow(g, [{ label: "To PC", onClick: () => ctx.onDeactivateGlophimon?.(g.id) }, glophimonReleaseAction(g)]));
    });
    glophimonPcBodyEl.appendChild(activeUl);

    const pcHeading = document.createElement("p");
    pcHeading.textContent = "PC Storage";
    pcHeading.style.fontSize = "11px";
    pcHeading.style.color = "#a3a3a3";
    pcHeading.style.margin = "6px 0 2px 0";
    glophimonPcBodyEl.appendChild(pcHeading);
    const pcUl = document.createElement("ul");
    pcUl.style.listStyle = "none";
    pcUl.style.padding = "0";
    pcUl.style.margin = "0";
    boxed.forEach((g) => {
      const slotActions = [0, 1, 2].map((slot) => ({ label: `→${slot + 1}`, onClick: () => ctx.onActivateGlophimon?.(g.id, slot) }));
      pcUl.appendChild(makeGlophimonRow(g, [...slotActions, glophimonReleaseAction(g)]));
    });
    glophimonPcBodyEl.appendChild(pcUl);
  }

  // "Bag" modal — just the item counts, behind its own menu option.
  function renderGlophimonBagModal() {
    glophimonBagBodyEl.innerHTML = "";

    const bagP = document.createElement("p");
    bagP.style.margin = "0";
    bagP.textContent = `🔴 Glophiballs: ${menuData.inventory.glophiballs}   🧪 Potions: ${menuData.inventory.potions}`;
    glophimonBagBodyEl.appendChild(bagP);
  }

  glophimonMenuButton.addEventListener("click", () => {
    glophimonMenuPanelEl.style.display = glophimonMenuPanelEl.style.display === "none" ? "flex" : "none";
    if (glophimonMenuPanelEl.style.display === "flex") {
      renderGlophimonMenuList(); // shows whatever's cached immediately, then refreshes once the fetch round-trips
      ctx.onOpenMenu?.();
    }
  });

  // speciesOverride/levelOverride: passed by checkWildContact when a real
  // roaming wild Glophimon is what triggered this (contact, chase catching
  // you, or walking into a fleeing/wandering one) — otherwise (the Dev
  // menu's own "Simulate Wild Battle" button) a fresh random species/level
  // is picked, same distribution the roaming spawns themselves use, so a
  // caught one from either path ends up with an equally plausible level.
  function startWildBattle(speciesOverride, levelOverride, wildId) {
    if (battle || teamBattle || pvpBattle) return;
    const lineup = getActiveLineup();
    if (lineup.length === 0) return;
    // HP no longer auto-regenerates between battles (see the playerTeam
    // build below) — if the whole active lineup is still hurt from a
    // previous fight and hasn't been healed, there's nothing left to
    // field, same "must heal before you can battle again" rule real
    // Pokémon enforces. Rodz is the way out.
    const anyUsable = lineup.some((owned) => (owned.current_hp ?? maxHpFor(owned.level)) > 0);
    if (!anyUsable) return;
    setBattleButtonsDisabled(true);
    closeGlophimonMenuPanel();
    closeGlophimonStatsModal();

    const wildSpecies = speciesOverride || pickRandomSpeciesByRarity();
    const wildLevel = levelOverride ?? randomInt(WILD_LEVEL_MIN, WILD_LEVEL_MAX);
    const wildIvs = rollIVs();
    const wild = computeCombatant(wildSpecies, wildIvs, null, wildLevel);

    // Both sides sit along the player's current facing line — your own
    // team closer in (spread left-to-right across it), the wild one
    // further out facing back — so the "confrontation" reads clearly
    // regardless of which way the player happened to be facing when the
    // fight started.
    const forwardX = Math.sin(local.facingAngle);
    const forwardZ = Math.cos(local.facingAngle);
    const rightX = Math.cos(local.facingAngle);
    const rightZ = -Math.sin(local.facingAngle);
    const centerX = local.x;
    const centerZ = local.z;
    const playerMonX = centerX + forwardX * BATTLE_PLAYER_MON_OFFSET;
    const playerMonZ = centerZ + forwardZ * BATTLE_PLAYER_MON_OFFSET;
    const wildX = centerX + forwardX * BATTLE_WILD_OFFSET;
    const wildZ = centerZ + forwardZ * BATTLE_WILD_OFFSET;

    const playerTeam = lineup.map((owned, i) => {
      const species = SPECIES_BY_KEY[owned.species_key];
      const ivs = { speed: owned.iv_speed, attack: owned.iv_attack, defense: owned.iv_defense };
      const evs = { speed: owned.ev_speed, attack: owned.ev_attack, defense: owned.ev_defense };
      const combatant = computeCombatant(species, ivs, evs, owned.level);
      // Persisted battle wound, not a fresh full-HP combatant every fight
      // (see GlophimonOwned.current_hp's own docstring) — clamped against
      // this fight's own max in case a level-up since the last battle
      // raised it. A Glophimon already at 0 starts this fight fainted too
      // (see the anyUsable guard above, which only requires *one* teammate
      // still standing).
      if (owned.current_hp != null) combatant.hp = Math.max(0, Math.min(combatant.maxHp, owned.current_hp));
      combatant.fainted = combatant.hp <= 0;
      const rig = buildBlockyCharacter(
        { head: species.head_color, body: species.body_color, arm: species.arm_color, leg: species.leg_color },
        combatant.name,
      );
      // Starts collapsed/hidden — see the intro-anim setup below, which
      // pops each one out of its own Glophiball once the dome has risen.
      rig.group.scale.setScalar(0);
      rig.group.visible = false;
      const lateralOffset = (i - (lineup.length - 1) / 2) * WILD_TEAM_MEMBER_SPACING;
      rig.group.position.set(playerMonX + rightX * lateralOffset, 0, playerMonZ + rightZ * lateralOffset);
      rig.group.rotation.y = local.facingAngle;
      scene.add(rig.group);
      // lockedFromDefending/anim mirror the 3v3 battle's own per-member
      // fields — see beginPlayerDeclare and showPlayerDefenderSelectionWild
      // (no assignedThisRound here — unlike the 3v3 battle's NPC team, the
      // wild side only ever has exactly one attack per round, so there's
      // never a second simultaneous claim on the same defender to guard
      // against).
      return { owned, species, combatant, rig, lockedFromDefending: false, anim: null };
    });

    const wildRig = buildBlockyCharacter(
      { head: wildSpecies.head_color, body: wildSpecies.body_color, arm: wildSpecies.arm_color, leg: wildSpecies.leg_color },
      wild.name,
    );
    wildRig.group.scale.setScalar(0); // grows in alongside your own team — see the intro-anim setup below
    wildRig.group.visible = false;
    wildRig.group.position.set(wildX, 0, wildZ);
    wildRig.group.rotation.y = local.facingAngle + Math.PI;
    scene.add(wildRig.group);

    // Isolation dome — purely decorative/local rendering, not a real
    // collision boundary (movement is disabled entirely while battling
    // anyway, see frame() below) and not networked in any way — other
    // clients never learn this battle is happening at all, matching the
    // "just simulate" scope. Starts flattened/invisible and rises into
    // place (see updateIntroAnim) rather than just appearing at full size.
    const domeGeometry = new THREE.SphereGeometry(BATTLE_DOME_RADIUS, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    const domeMaterial = new THREE.MeshBasicMaterial({
      color: "#bfe3ff", transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    });
    const domeMesh = new THREE.Mesh(domeGeometry, domeMaterial);
    domeMesh.position.set(centerX, 0, centerZ);
    domeMesh.scale.y = 0.001;
    scene.add(domeMesh);

    // One Glophiball per teammate, sitting where that teammate will pop
    // out from once the intro's "spawn" phase begins (see updateIntroAnim).
    const introBalls = playerTeam.map((member) => {
      const ballGroup = buildGlophiballMesh();
      ballGroup.position.set(member.rig.group.position.x, CATCH_BALL_GROUND_Y, member.rig.group.position.z);
      scene.add(ballGroup);
      return { rig: member.rig, ballGroup };
    });

    setLocalTransparent(true);

    battle = {
      // The server-owned wild this battle is actually consuming — see
      // checkWildContact/the api's own /wild/{id}/engage — or undefined
      // for the Dev menu's own instant local simulation, which was never
      // engaged with the server at all. endBattle/finishCatchSequence
      // both guard on this before calling ctx.onReleaseWild/onWildCaught.
      wildId,
      centerX,
      centerZ,
      midX: (playerMonX + wildX) / 2,
      midZ: (playerMonZ + wildZ) / 2,
      camAngle: local.facingAngle + BATTLE_CAM_ANGLE_OFFSET, // fallback wide framing only — see frame()'s own comment
      focus: null, // set every round by beginRound/showWildDeclareStep (see focusWildCameraOnRig) — same camera-follow behavior as the 3v3 battle
      focusedRig: null,
      playerTeam,
      wildRig,
      domeMesh,
      wild,
      wildSpecies,
      wildLevel,
      wildIvs,
      // Whichever side has higher Speed opens the battle (a little payoff
      // for the stat) — every round *after* that strictly alternates
      // regardless of Speed, since this is turn-based, not "whoever's
      // faster always attacks" (that was an earlier bug: recomputing this
      // from Speed every round left a slower player stuck as defender for
      // the whole fight). Speed is compared using your fastest teammate.
      turnSide: Math.max(...playerTeam.map((m) => m.combatant.speed)) >= wild.speed ? "player" : "wild",
      pendingRole: null,
      wildAnim: null,
      ended: false,
      // The wild side can only ever defend once per your attack round (it's
      // a single body, same "one claim per round" idea as the 3v3 battle's
      // own assignedThisRound) — reset at the start of your own attack
      // phase (see beginRound).
      wildDefendedThisRound: false,
      // Declare-phase state for your own team's Attack/Idle sequence — see
      // beginPlayerDeclare/showWildDeclareStep, same shape as the 3v3
      // battle's own teamBattle.declareLiving/declareIndex/declareChoices.
      declareLiving: [],
      declareIndex: 0,
      declareChoices: [],
      pendingSteps: [],
      tickTimer: null,
      // Dome rising, then your team popping out of their Glophiballs while
      // the wild grows in alongside them — see updateIntroAnim, which
      // calls beginRound itself once this finishes. Nothing is
      // interactive (no action buttons, no declare/defend UI) until then.
      introAnim: { phase: "dome", elapsedMs: 0, balls: introBalls },
    };

    battlePanel.style.display = "block";
    battleHudPlayerEl.style.display = "block";
    battleHudWildEl.style.display = "block";
    battleLogEl.innerHTML = "";
    postCatchContinueBtn.style.display = "none";
    dynamicActionsEl.style.display = "none";
    updateHpBars();
    updateGlophiballCount();
    logBattle(`A wild ${wild.name} appeared!`);
  }

  // Per-frame driver for battle.introAnim — see startWildBattle's own
  // setup and the constants this uses (BATTLE_INTRO_DOME_MS/SPAWN_MS/
  // ARRIVE_MS).
  function updateIntroAnim(dt) {
    if (!battle || !battle.introAnim) return;
    const anim = battle.introAnim;
    anim.elapsedMs += dt * 1000;

    if (anim.phase === "dome") {
      const t = Math.min(1, anim.elapsedMs / BATTLE_INTRO_DOME_MS);
      battle.domeMesh.scale.y = Math.max(0.001, t);
      battle.domeMesh.material.opacity = 0.12 * t;
      if (t >= 1) {
        anim.phase = "spawn";
        anim.elapsedMs = 0;
        for (const ball of anim.balls) ball.rig.group.visible = true;
      }
      return;
    }

    if (anim.phase === "spawn") {
      // Only your own team pops out of a ball here — the wild stays
      // hidden at scale 0 throughout, materializing on its own in the
      // "arrive" phase below instead of growing in lockstep with a ball
      // it was never actually thrown at.
      const t = Math.min(1, anim.elapsedMs / BATTLE_INTRO_SPAWN_MS);
      const growScale = CREATURE_SCALE * t;
      for (const ball of anim.balls) {
        ball.rig.group.scale.setScalar(growScale);
        ball.ballGroup.scale.setScalar(Math.max(0.05, 1 - t));
      }
      if (t >= 1) {
        for (const ball of anim.balls) {
          scene.remove(ball.ballGroup);
          disposeGlophiball(ball.ballGroup);
        }
        anim.balls = [];
        anim.phase = "arrive";
        anim.elapsedMs = 0;
        battle.wildRig.group.visible = true;
        // Snapshot where the camera actually is right now (the fallback
        // wide framing) as the ease's start, and compute the real
        // first-round focus (same math as focusWildCameraOnRig) as its
        // target — so by the time beginRound sets battle.focus for real,
        // the camera has already eased to that exact spot.
        const representative = getPlayerRepresentative();
        const fx = Math.sin(local.facingAngle);
        const fz = Math.cos(local.facingAngle);
        const pos = representative.rig.group.position;
        anim.startCamX = camera.position.x;
        anim.startCamY = camera.position.y;
        anim.startCamZ = camera.position.z;
        anim.startLookX = battle.midX;
        anim.startLookY = PAN_TARGET_Y;
        anim.startLookZ = battle.midZ;
        // beginRound aims at the wild itself when the wild opens first,
        // and ahead of your own representative otherwise — match whichever
        // this battle actually rolled so there's no re-snap once it hands
        // off (see beginRound's own two focusWildCameraOnRig call sites).
        const wildPos = battle.wildRig.group.position;
        anim.targetCamX = pos.x - fx * TEAM_FOCUS_CAM_BEHIND;
        anim.targetCamY = TEAM_FOCUS_CAM_HEIGHT;
        anim.targetCamZ = pos.z - fz * TEAM_FOCUS_CAM_BEHIND;
        anim.targetLookX = battle.turnSide === "wild" ? wildPos.x : pos.x + fx * TEAM_FOCUS_CAM_LOOK_AHEAD;
        anim.targetLookY = TEAM_FOCUS_CAM_LOOK_Y;
        anim.targetLookZ = battle.turnSide === "wild" ? wildPos.z : pos.z + fz * TEAM_FOCUS_CAM_LOOK_AHEAD;
      }
      return;
    }

    // "arrive" — the wild materializes on its own (no ball) while the
    // camera eases from the wide intro framing to its steady first-round
    // focus (see frame()'s own camera block, which reads anim.camX/etc.
    // directly while this phase is active).
    const t = Math.min(1, anim.elapsedMs / BATTLE_INTRO_ARRIVE_MS);
    const eased = 1 - (1 - t) * (1 - t); // ease-out — quick start, gentle settle
    battle.wildRig.group.scale.setScalar(CREATURE_SCALE * eased);
    anim.camX = anim.startCamX + (anim.targetCamX - anim.startCamX) * eased;
    anim.camY = anim.startCamY + (anim.targetCamY - anim.startCamY) * eased;
    anim.camZ = anim.startCamZ + (anim.targetCamZ - anim.startCamZ) * eased;
    anim.lookX = anim.startLookX + (anim.targetLookX - anim.startLookX) * eased;
    anim.lookY = anim.startLookY + (anim.targetLookY - anim.startLookY) * eased;
    anim.lookZ = anim.startLookZ + (anim.targetLookZ - anim.startLookZ) * eased;
    if (t >= 1) {
      battle.introAnim = null;
      beginRound();
    }
  }

  // The leftmost still-living teammate — used as the camera anchor/ball-
  // throw origin whenever something needs "a" player-side position rather
  // than a specific declared attacker (matches the 3v3 battle's own
  // "yourRepresentative" convention for its defend-phase camera).
  function getPlayerRepresentative() {
    return battle.playerTeam.find((m) => !m.combatant.fainted);
  }

  // Per-frame driver for a per-member anim field (see resolvePlayerAttack/
  // resolveWildAttack, which set one whenever that rig should play its
  // attack or defend pose) — falls back to the normal idle pose once the
  // animation's own duration elapses, or if nothing is currently set for
  // that rig.
  // "ready" (see processNextTeamStep) is the odd one out: a sustained "it's
  // their turn" cue with no fixed duration — it's cleared out by being
  // overwritten with a real "attack" anim the instant the exchange actually
  // resolves, not by elapsed time.
  function updateBattleRigAnim(battleState, key, rig, dt) {
    const anim = battleState[key];
    if (!anim) {
      applyIdlePose(rig, dt);
      return;
    }
    if (anim.type === "ready") {
      applyReadyPose(rig, dt);
      return;
    }
    anim.elapsedMs += dt * 1000;
    const duration = anim.type === "attack" ? ATTACK_ANIM_MS : anim.type === "cast" ? CAST_ANIM_MS : DEFEND_ANIM_MS;
    if (anim.type === "attack") applyAttackPose(rig, anim.elapsedMs, duration);
    else if (anim.type === "cast") applyCastPose(rig, anim.elapsedMs, duration);
    else applyDefendPose(rig, anim.elapsedMs, duration);
    if (anim.elapsedMs >= duration) battleState[key] = null;
  }

  // Same camera-follow behavior as the 3v3 battle's own focusCameraOnMember
  // (see that function's own comment) — kept as a small parallel set of
  // functions rather than sharing one, same "separate parallel systems"
  // reasoning as `battle`/`teamBattle` themselves. Takes a bare rig (any
  // one of your team's members, or the wild's) rather than a whole member
  // object, so it works the same whether it's anchoring on a specific
  // declaring/attacking member or your defend-phase representative.
  function setWildFocusedRig(rig) {
    if (battle.focusedRig && battle.focusedRig !== rig) {
      setRigTransparent(battle.focusedRig, false);
    }
    battle.focusedRig = rig;
    if (rig) setRigTransparent(rig, true);
  }

  function focusWildCameraOnRig(rig, facingAngle, lookAtPos) {
    setWildFocusedRig(rig);
    const fx = Math.sin(facingAngle);
    const fz = Math.cos(facingAngle);
    const pos = rig.group.position;
    battle.focus = {
      camX: pos.x - fx * TEAM_FOCUS_CAM_BEHIND,
      camZ: pos.z - fz * TEAM_FOCUS_CAM_BEHIND,
      lookX: lookAtPos ? lookAtPos.x : pos.x + fx * TEAM_FOCUS_CAM_LOOK_AHEAD,
      lookZ: lookAtPos ? lookAtPos.z : pos.z + fz * TEAM_FOCUS_CAM_LOOK_AHEAD,
    };
  }

  function unfocusWildCamera() {
    setWildFocusedRig(null);
    battle.focus = null;
  }

  function setActionButtons({ attack, escape, catchable }) {
    attackBtn.style.display = attack ? "inline-block" : "none";
    escapeBtn.style.display = escape ? "inline-block" : "none";
    catchBtn.style.display = catchable ? "inline-block" : "none";
    catchBtn.disabled = menuData.inventory.glophiballs <= 0;
  }

  function beginRound() {
    if (!battle || battle.ended) return;
    dynamicActionsEl.style.display = "none";
    // Buffs/debuffs age one turn every round, for every member on both
    // sides (not just whoever's about to act) — see tickEffects.
    for (const m of battle.playerTeam) tickEffects(m.combatant);
    tickEffects(battle.wild);
    if (battle.turnSide === "player") {
      logBattle("Your turn to attack!");
      battle.pendingRole = "player_attacker";
      // Cleared at the start of your own attack phase, same lock lifecycle
      // as the 3v3 battle's own per-member lockedFromDefending; the wild
      // also gets a fresh "hasn't defended yet this round" slate.
      for (const m of battle.playerTeam) m.lockedFromDefending = false;
      battle.wildDefendedThisRound = false;
      setActionButtons({ attack: true, escape: true, catchable: true });
      // Camera behind whichever of your team is still standing and
      // leftmost — same anchor the 3v3 battle's own defend phase uses —
      // until Attack is actually clicked and focuses per-declaring-member.
      const representative = getPlayerRepresentative();
      if (representative) focusWildCameraOnRig(representative.rig, local.facingAngle);
    } else {
      logBattle(`Wild ${battle.wild.name}'s turn to attack!`);
      battle.pendingRole = "player_defender";
      setActionButtons({ attack: false, escape: true, catchable: false });
      // Anchored on your own leftmost living Glophimon, aimed at the wild
      // attacker — same as the 3v3 battle's own defend-phase camera — plus
      // the wild's "it's my turn" ready pose (steps forward, left arm up)
      // while your team decides.
      const representative = getPlayerRepresentative();
      if (representative) focusWildCameraOnRig(representative.rig, local.facingAngle, battle.wildRig.group.position);
      else unfocusWildCamera();
      battle.wildAnim = { type: "ready", elapsedMs: 0 };
      showPlayerDefenderSelectionWild();
    }
  }

  // Player's declare-phase UI for one Glophimon at a time: Attack or Idle,
  // plus Back (once past the first) to reconsider an earlier choice — same
  // shape as the 3v3 battle's own showWildDeclareStep/Confirm. Idling
  // keeps a teammate eligible to defend the wild's next attack (see
  // showPlayerDefenderSelectionWild); attacking locks them out of it.
  function beginPlayerDeclare() {
    if (!battle || battle.pendingRole !== "player_attacker") return;
    setActionButtons({ attack: false, escape: false, catchable: false });
    const living = battle.playerTeam.filter((m) => !m.combatant.fainted);
    battle.declareLiving = living;
    battle.declareIndex = 0;
    battle.declareChoices = new Array(living.length).fill(null);
    showWildDeclareStep();
  }

  // Living playerTeam members other than `member` itself — the pool an
  // ally-targeted heal/buff move can pick from. Uses the full team (not
  // just battle.declareLiving, which is fixed at round-start and means
  // "who still needs to declare," not "who's alive right now") since an
  // ally who already declared earlier this round is still a valid target.
  function livingAllies(member) {
    return battle.playerTeam.filter((m) => !m.combatant.fainted && m !== member);
  }

  function showWildDeclareStep() {
    const living = battle.declareLiving;
    const i = battle.declareIndex;
    battle.declareSubStep = null;
    if (i >= living.length) {
      showWildDeclareConfirm();
      return;
    }
    const member = living[i];

    // A flinched member skips its own choice entirely — consumed here,
    // one-shot, not turn-counted (see resolveMove's own flinchChance
    // handling).
    if (member.combatant.forcedIdleNextTurn) {
      member.combatant.forcedIdleNextTurn = false;
      logBattle(`${member.combatant.name} flinched and couldn't act!`);
      battle.declareChoices[i] = "idle";
      battle.declareIndex += 1;
      showWildDeclareStep();
      return;
    }

    focusWildCameraOnRig(member.rig, local.facingAngle);
    logBattle(`${member.combatant.name}, what will you do?`);
    dynamicActionsEl.innerHTML = "";
    dynamicActionsEl.style.display = "flex";

    for (const move of movesForSpecies(member.combatant.speciesKey)) {
      const pp = member.combatant.pp[move.key];
      dynamicActionsEl.appendChild(buildMoveOptionRow(move, pp, () => chooseMoveWild(i, member, move)));
    }

    const idleBtn = document.createElement("button");
    idleBtn.textContent = "Idle";
    idleBtn.style.fontSize = "11px";
    idleBtn.addEventListener("click", () => {
      battle.declareChoices[i] = "idle";
      battle.declareIndex += 1;
      showWildDeclareStep();
    });
    dynamicActionsEl.appendChild(idleBtn);

    if (i > 0) {
      const backBtn = document.createElement("button");
      backBtn.textContent = "Back";
      backBtn.style.fontSize = "11px";
      backBtn.addEventListener("click", () => {
        battle.declareIndex -= 1;
        showWildDeclareStep();
      });
      dynamicActionsEl.appendChild(backBtn);
    }
  }

  // A move's target decides what happens next: enemy-targeted (damage/
  // debuff — the overwhelming majority) and self/team-targeted moves need
  // no picker at all; ally-targeted moves auto-target the one other
  // living teammate if there's exactly one, or show a picker sub-step if
  // there's more than one.
  function chooseMoveWild(i, member, move) {
    if (move.target === "ally") {
      const allies = livingAllies(member);
      if (allies.length === 0) {
        // No one to target — treat like Idle rather than wasting the turn
        // on a move that can't do anything.
        battle.declareChoices[i] = "idle";
        battle.declareIndex += 1;
        showWildDeclareStep();
        return;
      }
      if (allies.length === 1) {
        battle.declareChoices[i] = { moveKey: move.key, target: allies[0] };
        battle.declareIndex += 1;
        showWildDeclareStep();
        return;
      }
      showAllyTargetPickerWild(i, member, move, allies);
      return;
    }
    // Self/team/enemy-targeted moves all leave target null — only an
    // ally-targeted move ever stores a real chosen member here (see the
    // branch above); self vs. team vs. enemy is decided purely from the
    // move's own `target`/`kind` at resolve time.
    battle.declareChoices[i] = { moveKey: move.key, target: null };
    battle.declareIndex += 1;
    showWildDeclareStep();
  }

  // Sub-step of the current member's own declare-step — its own Back
  // returns to that member's move list, not the previous member (tracked
  // via battle.declareSubStep purely so Back knows which screen to
  // rebuild; the actual choice/index bookkeeping is unaffected either way).
  function showAllyTargetPickerWild(i, member, move, allies) {
    battle.declareSubStep = { i, move };
    logBattle(`Choose a target for ${move.name}.`);
    dynamicActionsEl.innerHTML = "";
    dynamicActionsEl.style.display = "flex";
    for (const ally of allies) {
      const btn = document.createElement("button");
      btn.textContent = ally.combatant.name;
      btn.style.fontSize = "11px";
      btn.addEventListener("click", () => {
        battle.declareChoices[i] = { moveKey: move.key, target: ally };
        battle.declareIndex += 1;
        showWildDeclareStep();
      });
      dynamicActionsEl.appendChild(btn);
    }
    const backBtn = document.createElement("button");
    backBtn.textContent = "Back";
    backBtn.style.fontSize = "11px";
    backBtn.addEventListener("click", () => showWildDeclareStep());
    dynamicActionsEl.appendChild(backBtn);
  }

  function describeChoiceWild(choice) {
    if (choice === "idle") return "Idle";
    return MOVE_BY_KEY[choice.moveKey].name;
  }

  function showWildDeclareConfirm() {
    unfocusWildCamera();
    const living = battle.declareLiving;
    const summary = living.map((m, i) => `${m.combatant.name}: ${describeChoiceWild(battle.declareChoices[i])}`).join(", ");
    logBattle(`Your commands — ${summary}`);
    dynamicActionsEl.innerHTML = "";
    dynamicActionsEl.style.display = "flex";

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "Confirm Choices";
    confirmBtn.style.fontSize = "11px";
    confirmBtn.addEventListener("click", () => {
      dynamicActionsEl.style.display = "none";
      // Heal/buff moves resolve immediately, in declare order — there's
      // no opposing side to defend against a heal, so they never go
      // through pendingSteps/processNextStep at all.
      const acting = living
        .map((m, i) => ({ member: m, choice: battle.declareChoices[i] }))
        .filter((s) => s.choice !== "idle");
      const healOrBuffSteps = acting.filter((s) => MOVE_BY_KEY[s.choice.moveKey].kind === "heal" || MOVE_BY_KEY[s.choice.moveKey].kind === "buff");
      const attackSteps = acting.filter((s) => !healOrBuffSteps.includes(s));

      for (const { member, choice } of healOrBuffSteps) {
        const move = MOVE_BY_KEY[choice.moveKey];
        const targets =
          move.target === "team" ? [member.combatant, ...livingAllies(member).map((m) => m.combatant)]
          : move.target === "ally" ? [(choice.target || member).combatant]
          : [member.combatant]; // self
        resolveMove({
          move,
          attackerCombatant: member.combatant,
          defenderCombatant: null,
          targets,
          defends: false,
          ctx: { log: logBattle, onUndefendedDamage: () => {} },
        });
        member.anim = { type: "cast", elapsedMs: 0 };
      }

      for (const { member } of attackSteps) member.lockedFromDefending = true; // can't defend the wild's next attack — see beginRound's own comment
      battle.pendingSteps = attackSteps; // {member, choice} pairs, already left-to-right — living was built in row order
      if (acting.length === 0) logBattle("You declare no attacks this round.");
      updateHpBars();
      battle.tickTimer = setTimeout(processNextStep, TEAM_STEP_MS);
    });
    dynamicActionsEl.appendChild(confirmBtn);

    const backBtn = document.createElement("button");
    backBtn.textContent = "Back";
    backBtn.style.fontSize = "11px";
    backBtn.addEventListener("click", () => {
      battle.declareIndex = living.length - 1;
      showWildDeclareStep();
    });
    dynamicActionsEl.appendChild(backBtn);
  }

  // Resolution proceeds left-to-right in declare order — one of your
  // declared attackers at a time, each against the wild's single Glophimon
  // (there's only ever one target). The wild can only defend once per your
  // whole attack round (see battle.wildDefendedThisRound) — a single body
  // can't block more than one of several simultaneous attackers, same "one
  // claim per round" idea as the 3v3 battle's own assignedThisRound.
  function processNextStep() {
    if (!battle || battle.ended) return;
    const step = battle.pendingSteps.shift();
    if (!step) {
      unfocusWildCamera();
      finishPlayerAttackRound();
      return;
    }
    focusWildCameraOnRig(step.member.rig, local.facingAngle);
    let wildDefends = false;
    if (!battle.wildDefendedThisRound) {
      wildDefends = Math.random() < WILD_DEFEND_CHANCE;
      if (wildDefends) battle.wildDefendedThisRound = true;
    }
    resolvePlayerAttack(step.member, MOVE_BY_KEY[step.choice.moveKey], wildDefends);
  }

  // Awards EXP/EV for defeating or catching a real wild encounter (see
  // ctx.onBattleResult/the api's own POST /me/glophimon/battle-result) —
  // shared by the win branch (resolvePlayerAttack) and the catch branch
  // (finishCatchSequence), since both are "you beat this wild" moments
  // that deserve the same announcement. Holds the battle panel open
  // (reusing postCatchContinueBtn, already built for exactly this) so
  // "X gained N EXP!"/"X grew to level Y!" lines actually have time to be
  // read before endBattle() tears everything down. A short timeout
  // fallback reveals Continue anyway if the request hangs or errors, so a
  // network hiccup can never soft-lock the battle screen.
  function awardBattleResult(outcome, participantIds, defeatedSpeciesKey, defeatedLevel, wildId) {
    setActionButtons({ attack: false, defend: false, skip: false, escape: false, catchable: false });
    const reveal = () => {
      postCatchContinueBtn.style.display = "inline-block";
    };
    if (participantIds.length === 0) {
      reveal();
      return;
    }
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      reveal();
    }, BATTLE_RESULT_TIMEOUT_MS);
    Promise.resolve(ctx.onBattleResult?.({ outcome, participantIds, defeatedSpeciesKey, defeatedLevel, wildId: wildId ?? null }))
      .then((result) => {
        clearTimeout(timeoutId);
        if (result?.ok) {
          // Real, authoritative roster from the server — same trust level
          // as every other "the real change already happened server-side"
          // refresh in this file (e.g. Jared's shop). Only touches the
          // battle log if the battle screen is still actually open — the
          // timeout fallback may have already let the player Continue
          // (and endBattle() null out `battle`) before this resolves.
          menuData = { glophimon: result.glophimon, inventory: menuData.inventory };
          if (battle && !battle.ended) {
            for (const p of result.participants) {
              const member = battle.playerTeam.find((m) => m.owned?.id === p.id);
              const name = member ? member.combatant.name : "Your Glophimon";
              if (p.exp_gained > 0) logBattle(`${name} gained ${p.exp_gained} EXP!`);
              if (p.level_after > p.level_before) logBattle(`${name} grew to level ${p.level_after}!`);
            }
          }
        }
        if (!settled) {
          settled = true;
          reveal();
        }
      })
      .catch(() => {
        clearTimeout(timeoutId);
        if (!settled) {
          settled = true;
          reveal();
        }
      });
  }

  function resolvePlayerAttack(attackerMember, move, wildDefends) {
    const attacker = attackerMember.combatant;
    attackerMember.anim = { type: move.kind === "debuff" ? "cast" : "attack", elapsedMs: 0 };
    // Always the wild — your team only ever has one possible target here.
    battle.wildRig.targetAnim = { elapsedMs: 0 };

    const result = resolveMove({
      move,
      attackerCombatant: attacker,
      defenderCombatant: battle.wild,
      defends: wildDefends,
      ctx: { log: logBattle, onUndefendedDamage: () => {} },
    });
    if (wildDefends && result?.hit && move.kind === "damage") battle.wildAnim = { type: "defend", elapsedMs: 0 };
    updateHpBars();

    battle.tickTimer = setTimeout(() => {
      if (!battle || battle.ended) return; // torn down (e.g. Leave) while the animation was playing
      if (battle.wild.hp <= 0) {
        logBattle(`Wild ${battle.wild.name} fainted! You won!`);
        const participantIds = battle.playerTeam.filter((m) => !m.combatant.fainted && m.owned?.id != null).map((m) => m.owned.id);
        awardBattleResult("win", participantIds, battle.wildSpecies.key, battle.wildLevel, battle.wildId);
        return;
      }
      processNextStep();
    }, ANIM_SETTLE_MS);
  }

  function finishPlayerAttackRound() {
    if (!battle || battle.ended) return;
    battle.turnSide = "wild";
    beginRound();
  }

  // Your team's defend-phase UI — one button per still-eligible (living,
  // not locked from defending) Glophimon, plus Don't Defend, or the "No
  // defenders available!" fallback if everyone eligible already spent
  // their last turn attacking — same shape as the 3v3 battle's own
  // showPlayerDefenderSelection.
  function showPlayerDefenderSelectionWild() {
    logBattle(`Wild ${battle.wild.name} is attacking!`);
    dynamicActionsEl.innerHTML = "";
    dynamicActionsEl.style.display = "flex";

    const eligible = battle.playerTeam.filter((m) => !m.combatant.fainted && !m.lockedFromDefending);

    if (eligible.length === 0) {
      const note = document.createElement("p");
      note.textContent = "No defenders available!";
      note.style.fontSize = "11px";
      note.style.color = "#f87171";
      note.style.margin = "2px 0";
      note.style.width = "100%"; // forces its own line in the wrapping flex row, ahead of the button
      dynamicActionsEl.appendChild(note);
      const confirmBtn = document.createElement("button");
      confirmBtn.textContent = "Continue";
      confirmBtn.style.fontSize = "11px";
      confirmBtn.addEventListener("click", () => resolveWildAttack(null));
      dynamicActionsEl.appendChild(confirmBtn);
      return;
    }

    eligible.forEach((m) => {
      const btn = document.createElement("button");
      btn.textContent = `Defend: ${m.combatant.name}`;
      btn.style.fontSize = "11px";
      btn.addEventListener("click", () => resolveWildAttack(m));
      dynamicActionsEl.appendChild(btn);
    });

    const noDefendBtn = document.createElement("button");
    noDefendBtn.textContent = "Don't Defend";
    noDefendBtn.style.fontSize = "11px";
    noDefendBtn.addEventListener("click", () => resolveWildAttack(null));
    dynamicActionsEl.appendChild(noDefendBtn);
  }

  function resolveWildAttack(defenderMember) {
    dynamicActionsEl.style.display = "none";
    battle.wildAnim = { type: "attack", elapsedMs: 0 };
    const attacker = battle.wild;

    // Wild Glophimon only ever use the generic Attack today — their own
    // species moveset exists (computeCombatant seeds PP for it the same
    // as any combatant) but nothing drives an AI choice among them yet;
    // that's a natural follow-up, not required for the move engine itself
    // to be correct. Routes through the same shared resolveMove the
    // player's own moves use, replacing what used to be a third
    // hand-duplicated copy of this exact formula.
    const result = resolveMove({
      move: ATTACK_MOVE,
      attackerCombatant: attacker,
      defenderCombatant: defenderMember ? defenderMember.combatant : null,
      defends: !!defenderMember,
      ctx: { log: logBattle, onUndefendedDamage: (dmg) => setPlayerHp(playerHp - dmg) },
    });
    if (result?.hit && defenderMember) {
      defenderMember.rig.targetAnim = { elapsedMs: 0 };
      defenderMember.anim = { type: "defend", elapsedMs: 0 };
      if (defenderMember.combatant.hp <= 0) {
        defenderMember.combatant.fainted = true;
        logBattle(`Your ${defenderMember.combatant.name} fainted!`);
      }
    }
    updateHpBars();
    battle.tickTimer = setTimeout(advanceAfterWildAttack, ANIM_SETTLE_MS);
  }

  function advanceAfterWildAttack() {
    if (!battle || battle.ended) return;
    const anyAlive = battle.playerTeam.some((m) => !m.combatant.fainted);
    if (!anyAlive || playerHp <= 0) {
      logBattle(anyAlive ? "You blacked out!" : "You have no Glophimon left able to battle! You lost...");
      handlePlayerBlackout();
      endBattle();
      return;
    }
    battle.turnSide = "player";
    beginRound();
  }

  attackBtn.addEventListener("click", beginPlayerDeclare);

  catchBtn.addEventListener("click", () => {
    if (!battle || battle.pendingRole !== "player_attacker" || menuData.inventory.glophiballs <= 0 || battle.wild.hp <= 0 || battle.catchAnim) return;
    const representative = getPlayerRepresentative();
    if (!representative) return;
    // Optimistic/local — a thrown ball is spent whether or not it works,
    // same as the real games. ctx.onUseGlophiball persists the real spend
    // server-side; no need to wait on it before continuing, same
    // client-authoritative trust level movement already gets.
    menuData.inventory.glophiballs -= 1;
    updateGlophiballCount();
    ctx.onUseGlophiball?.();
    // The whole team's turn is spent focusing on the throw, same as
    // everyone attacking would lock them all out of defending next.
    for (const m of battle.playerTeam) m.lockedFromDefending = true;
    setActionButtons({ attack: false, escape: false, catchable: false }); // hidden until the whole catch animation resolves
    const chance = computeCatchChance(battle.wild);
    // Rolled immediately, same as the real games — the shake animation is
    // just theater building up to a result that's already decided.
    const caught = Math.random() * 100 < chance;
    logBattle(`You threw a Glophiball at ${battle.wild.name}! (${Math.round(chance)}% chance)`);

    const ballGroup = buildGlophiballMesh();
    scene.add(ballGroup);
    battle.catchAnim = {
      phase: "throw",
      elapsedMs: 0,
      caught,
      ballGroup,
      fromX: representative.rig.group.position.x,
      fromZ: representative.rig.group.position.z,
      toX: battle.wildRig.group.position.x,
      toZ: battle.wildRig.group.position.z,
      // Camera starts exactly where the normal attack-phase focus already
      // has it (see battle.focus) so easing toward the ball begins from
      // wherever the player is actually looking, not a jump-cut.
      camX: battle.focus.camX,
      camY: TEAM_FOCUS_CAM_HEIGHT,
      camZ: battle.focus.camZ,
      lookX: battle.focus.lookX,
      lookY: TEAM_FOCUS_CAM_LOOK_Y,
      lookZ: battle.focus.lookZ,
    };
  });

  // Per-frame driver for battle.catchAnim (see catchBtn's own click handler,
  // which sets this up) — throw -> suck-in -> shake -> reveal, in that
  // order, only ever touching battle.wildRig's own scale/visibility (never
  // disposed here — a failed catch needs it fully intact to pop back out).
  function updateCatchAnim(dt) {
    if (!battle || !battle.catchAnim) return;
    const anim = battle.catchAnim;
    anim.elapsedMs += dt * 1000;
    let done = false;

    if (anim.phase === "throw") {
      const t = Math.min(1, anim.elapsedMs / CATCH_THROW_MS);
      const x = anim.fromX + (anim.toX - anim.fromX) * t;
      const z = anim.fromZ + (anim.toZ - anim.fromZ) * t;
      const y = CATCH_BALL_GROUND_Y + Math.sin(t * Math.PI) * CATCH_THROW_ARC_HEIGHT;
      anim.ballGroup.position.set(x, y, z);
      anim.ballGroup.rotation.x += dt * 12; // tumbling in flight
      if (t >= 1) {
        anim.phase = "suckin";
        anim.elapsedMs = 0;
      }
    } else if (anim.phase === "suckin") {
      const t = Math.min(1, anim.elapsedMs / CATCH_SUCKIN_MS);
      battle.wildRig.group.scale.setScalar(CREATURE_SCALE * (1 - t));
      anim.ballGroup.position.set(anim.toX, CATCH_BALL_GROUND_Y, anim.toZ);
      anim.ballGroup.rotation.x = 0;
      if (t >= 1) {
        battle.wildRig.group.visible = false;
        anim.phase = "shake";
        anim.elapsedMs = 0;
      }
    } else if (anim.phase === "shake") {
      const t = Math.min(1, anim.elapsedMs / CATCH_SHAKE_MS);
      anim.ballGroup.rotation.z = Math.sin(t * Math.PI * 2 * CATCH_SHAKE_CYCLES) * CATCH_SHAKE_AMOUNT * (1 - t);
      if (t >= 1) {
        anim.ballGroup.rotation.z = 0;
        anim.phase = "reveal";
        anim.elapsedMs = 0;
      }
    } else {
      // "reveal" — a quick confirm pulse if caught (the camera just stays
      // put on the ball, since the battle ends right after anyway), or a
      // longer grow-back if not, giving both the scale-up and the camera
      // easing back out room to actually read rather than snapping.
      const revealMs = anim.caught ? CATCH_REVEAL_MS : CATCH_POPOUT_MS;
      const t = Math.min(1, anim.elapsedMs / revealMs);
      if (anim.caught) {
        anim.ballGroup.scale.setScalar(1 + Math.sin(t * Math.PI) * 0.25);
      } else {
        battle.wildRig.group.scale.setScalar(CREATURE_SCALE * t);
      }
      if (t >= 1) done = true;
    }

    // Camera: eases toward a tight zoom on the ball throughout suck-in and
    // shake (and while caught's own confirm pulse plays), or back out to
    // the battle's normal attack-phase focus once a failed catch starts
    // revealing — continuous easing rather than a fixed-duration tween, so
    // it reads as a deliberate, gradual push-in/pull-out.
    const easingBackOut = anim.phase === "reveal" && !anim.caught;
    let targetCamX;
    let targetCamZ;
    let targetLookX;
    let targetLookZ;
    if (anim.phase === "throw" || easingBackOut) {
      targetCamX = battle.focus.camX;
      targetCamZ = battle.focus.camZ;
      targetLookX = battle.focus.lookX;
      targetLookZ = battle.focus.lookZ;
    } else {
      const fx = Math.sin(local.facingAngle);
      const fz = Math.cos(local.facingAngle);
      targetCamX = anim.toX - fx * CATCH_CAM_ZOOM_BEHIND;
      targetCamZ = anim.toZ - fz * CATCH_CAM_ZOOM_BEHIND;
      targetLookX = anim.toX;
      targetLookZ = anim.toZ;
    }
    const targetCamY = anim.phase === "throw" || easingBackOut ? TEAM_FOCUS_CAM_HEIGHT : CATCH_CAM_ZOOM_HEIGHT;
    const targetLookY = anim.phase === "throw" || easingBackOut ? TEAM_FOCUS_CAM_LOOK_Y : CATCH_BALL_GROUND_Y;
    const camEase = Math.min(1, CATCH_CAM_EASE_RATE * dt);
    anim.camX += (targetCamX - anim.camX) * camEase;
    anim.camY += (targetCamY - anim.camY) * camEase;
    anim.camZ += (targetCamZ - anim.camZ) * camEase;
    anim.lookX += (targetLookX - anim.lookX) * camEase;
    anim.lookY += (targetLookY - anim.lookY) * camEase;
    anim.lookZ += (targetLookZ - anim.lookZ) * camEase;

    if (done) finishCatchSequence();
  }

  function finishCatchSequence() {
    if (!battle || !battle.catchAnim) return;
    const { caught, ballGroup } = battle.catchAnim;
    scene.remove(ballGroup);
    disposeGlophiball(ballGroup);
    battle.catchAnim = null;
    if (caught) {
      logBattle(`Gotcha! ${battle.wild.name} was caught!`);
      ctx.onCatchGlophimon?.({
        speciesKey: battle.wildSpecies.key,
        level: battle.wildLevel,
        ivSpeed: battle.wildIvs.speed,
        ivAttack: battle.wildIvs.attack,
        ivDefense: battle.wildIvs.defense,
      });
      // Snapshot + award BEFORE onWildCaught fires — the battle-result
      // endpoint verifies wild_id against the server's own still-live
      // wild_spawns record (see its own anti-cheat comment), which
      // onWildCaught's own round-trip is what actually removes.
      const caughtWildId = battle.wildId;
      const participantIds = battle.playerTeam.filter((m) => !m.combatant.fainted && m.owned?.id != null).map((m) => m.owned.id);
      awardBattleResult("caught", participantIds, battle.wildSpecies.key, battle.wildLevel, caughtWildId);
      if (caughtWildId != null) {
        // Removes it from the shared world for everyone else too — see
        // the api's own /wild/{id}/caught. Cleared here (rather than left
        // set) so endBattle's own release-on-teardown doesn't also fire
        // for a wild that's already permanently gone.
        ctx.onWildCaught?.(caughtWildId);
        battle.wildId = null;
      }
      return;
    }
    battle.wildRig.group.visible = true;
    logBattle(`Oh no! ${battle.wild.name} broke free!`);
    // A failed throw still spends your turn, same as a real Attack would.
    battle.turnSide = "wild";
    beginRound();
  }
  escapeBtn.addEventListener("click", () => {
    if (!battle) return;
    logBattle("You fled the battle!");
    endBattle();
  });
  postCatchContinueBtn.addEventListener("click", () => {
    if (!battle) return;
    endBattle();
  });
  function onClickStartWildBattle() {
    startWildBattle();
  }
  battleButton.addEventListener("click", onClickStartWildBattle);

  // Persists whatever HP each real (owned.id != null — excludes the
  // getActiveLineup() synthesized-from-starter fallback, which has no
  // server row to update) team member ended the battle with — see
  // GlophimonOwned.current_hp's own docstring. Mutates menuData.glophimon
  // in place first (owned IS the same object reference getActiveLineup()
  // read from, so this is the same "client already knows the real
  // resulting state" optimism every other action here already uses)
  // before the fire-and-forget persist.
  function syncOwnedGlophimonHp(members) {
    const updates = [];
    for (const m of members) {
      if (m.owned?.id == null) continue;
      const hp = Math.max(0, m.combatant.hp);
      m.owned.current_hp = hp;
      updates.push({ id: m.owned.id, current_hp: hp });
    }
    if (updates.length > 0) ctx.onSetGlophimonHp?.(updates);
  }

  function endBattle() {
    if (!battle) return;
    battle.ended = true;
    syncOwnedGlophimonHp(battle.playerTeam);
    // A few moments before the player can be pulled into another battle —
    // see POST_BATTLE_COOLDOWN_MS's own comment — regardless of how this
    // one ended (caught, escaped, or the wild otherwise released).
    battleCooldownUntil = performance.now() + POST_BATTLE_COOLDOWN_MS;
    if (battle.wildId != null) {
      // Not caught (fled, escaped, or the battle was torn down some other
      // way) — hand it back to the shared world so anyone, including this
      // same player again once their own cooldown clears, can go engage it
      // for real. See the api's own /wild/{id}/release; finishCatchSequence
      // already clears wildId on an actual catch, so this never
      // double-fires for that case.
      ctx.onReleaseWild?.(battle.wildId);
      // Reappears in *my own* ambient rendering immediately too, rather
      // than waiting on a wild_tick round-trip — the server already knows
      // to resume ticking it from here on (see release_wild), this just
      // avoids a visible pop-in gap on this client specifically.
      ensureWildSpawn(
        battle.wildId,
        battle.wildSpecies.key,
        battle.wildLevel,
        battle.wildRig.group.position.x,
        battle.wildRig.group.position.z,
        battle.wildRig.group.rotation.y,
        false,
      );
    }
    if (battle.catchAnim) {
      // Only reachable if the battle is torn down externally (e.g. Leave)
      // mid-animation — Escape itself is hidden for the whole catch
      // sequence, same as it is during a normal attack/defend exchange.
      scene.remove(battle.catchAnim.ballGroup);
      disposeGlophiball(battle.catchAnim.ballGroup);
      battle.catchAnim = null;
    }
    if (battle.introAnim) {
      // Same idea — only reachable if torn down externally while the
      // opening spawn animation was still playing.
      for (const ball of battle.introAnim.balls) {
        scene.remove(ball.ballGroup);
        disposeGlophiball(ball.ballGroup);
      }
      battle.introAnim = null;
    }
    unfocusWildCamera();
    for (const member of battle.playerTeam) {
      scene.remove(member.rig.group);
      disposeRig(member.rig);
    }
    scene.remove(battle.wildRig.group);
    disposeRig(battle.wildRig);
    scene.remove(battle.domeMesh);
    battle.domeMesh.geometry.dispose();
    battle.domeMesh.material.dispose();
    setLocalTransparent(false);
    for (const peer of peers.values()) setPeerHidden(peer, false);
    setActionButtons({ attack: false, escape: false, catchable: false });
    postCatchContinueBtn.style.display = "none";
    dynamicActionsEl.style.display = "none";
    battlePanel.style.display = "none";
    battleHudPlayerEl.style.display = "none";
    battleHudWildEl.style.display = "none";
    setBattleButtonsDisabled(false);
    battle = null;
  }

  // teamBattle is null whenever no 3v3 simulation is active — every
  // team-battle-only code path in frame()/cleanup below is guarded on it,
  // same convention as `battle` above.
  let teamBattle = null;

  function logTeamBattle(text) {
    const p = document.createElement("p");
    p.style.margin = "1px 0";
    p.textContent = text;
    teamBattleLogEl.appendChild(p);
    teamBattleLogEl.scrollTop = teamBattleLogEl.scrollHeight;
  }

  function teamUiFor(sideIndex) {
    return sideIndex === 0 ? teamAUi : teamBUi;
  }

  function renderTeamHpBars() {
    if (!teamBattle) return;
    teamBattle.teams.forEach((team, i) => {
      const ui = teamUiFor(i);
      ui.heading.textContent = team.label; // "Your Team" / "NPC Team" — see buildTeamBattleSides
      const trainerPct = Math.max(0, Math.round((team.trainerHp / team.trainerMaxHp) * 100));
      ui.trainerRow.barFill.style.width = `${trainerPct}%`;
      ui.trainerRow.nameEl.textContent = `${team.label} Trainer — ${team.trainerHp}/${team.trainerMaxHp} HP`;
      // Both sides always field the full TEAM_SIZE today (see
      // buildTeamBattleSides) — any rows beyond a team's real member
      // count are hidden rather than left showing stale data from a
      // previous battle, same defensive reasoning as everywhere else.
      ui.memberRows.forEach((row, j) => {
        const m = team.members[j];
        if (!m) {
          row.row.style.display = "none";
          return;
        }
        row.row.style.display = "";
        const pct = m.combatant.fainted ? 0 : Math.max(0, Math.round((m.combatant.hp / m.combatant.maxHp) * 100));
        row.barFill.style.width = `${pct}%`;
        row.nameEl.textContent = m.combatant.fainted
          ? `${m.combatant.name} — fainted`
          : `${m.combatant.name} — ${m.combatant.hp}/${m.combatant.maxHp} HP`;
      });
    });
  }

  function clearTeamActions() {
    teamActionsEl.innerHTML = "";
    teamActionsEl.style.display = "none";
  }

  // yourSpecs: array of {species, combatant} for the player's own team —
  // length varies (1 for a duel against Rodz, where you only field
  // Glophimon you actually own; 3 for the padded "vs NPC" simulation).
  // npcLabel/npcTrainerColors distinguish a generic NPC opponent from the
  // Rodz specifically.
  function buildTeamBattleSides(yourSpecs, npcLabel, npcTrainerColors) {
    const forwardX = Math.sin(local.facingAngle);
    const forwardZ = Math.cos(local.facingAngle);
    const rightX = Math.cos(local.facingAngle);
    const rightZ = -Math.sin(local.facingAngle);
    // The player stands still at their own real position (offset 0) — the
    // Glophimon are the ones defending the player, not the other way
    // around, so the player never stands *between* the two teams. Their
    // own row sits out in front of them; the opponent's row sits further
    // out, facing back; the opponent's trainer stands behind their own
    // row, mirroring the player's own position relative to their row.
    const npcRowOffset = TEAM_PLAYER_ROW_OFFSET + TEAM_ROW_GAP;
    const npcTrainerOffset = npcRowOffset + TEAM_NPC_TRAINER_BACK_OFFSET;

    // rowCount centers the lateral spread on however many are actually in
    // that row — a duel's 1-member row centers on the player directly
    // rather than sitting offset as if two more empty slots were there.
    function placeMember(rowOffset, facing, i, rowCount, combatant, colors) {
      const lateral = (i - (rowCount - 1) / 2) * TEAM_MEMBER_SPACING;
      const x = local.x + forwardX * rowOffset + rightX * lateral;
      const z = local.z + forwardZ * rowOffset + rightZ * lateral;
      const rig = buildBlockyCharacter(colors, combatant.name);
      rig.group.scale.setScalar(CREATURE_SCALE);
      rig.group.position.set(x, 0, z);
      rig.group.rotation.y = facing;
      scene.add(rig.group);
      return { combatant, rig, anim: null, assignedThisRound: false, lockedFromDefending: false };
    }

    const yourMembers = yourSpecs.map(({ species, combatant }, i) =>
      placeMember(TEAM_PLAYER_ROW_OFFSET, local.facingAngle, i, yourSpecs.length, combatant, {
        head: species.head_color, body: species.body_color, arm: species.arm_color, leg: species.leg_color,
      }));
    // Your own side's trainerHp starts at whatever playerHp already was —
    // it's the same real, persistent HP the wild battle uses too (see
    // playerHp further below), not a fresh pool every match; resolveTeamExchange's
    // own undefended branch keeps the two in sync as it changes.
    const yourTeam = { label: "Your Team", members: yourMembers, trainerHp: playerHp, trainerMaxHp: PLAYER_MAX_HP };

    // Opponent team — fully random, same either way.
    const npcMembers = [];
    for (let i = 0; i < TEAM_SIZE; i++) {
      const species = SPECIES[randomInt(0, SPECIES.length - 1)];
      const combatant = computeCombatant(species, rollIVs(), null);
      combatant.fainted = false;
      npcMembers.push(placeMember(npcRowOffset, local.facingAngle + Math.PI, i, TEAM_SIZE, combatant, {
        head: species.head_color, body: species.body_color, arm: species.arm_color, leg: species.leg_color,
      }));
    }
    const npcTeam = { label: npcLabel, members: npcMembers, trainerHp: PLAYER_MAX_HP, trainerMaxHp: PLAYER_MAX_HP };

    // A visible opponent trainer avatar — full scale, like the player,
    // standing behind their own row the same way the player stands behind
    // theirs — "so I can observe everything," a complete two-trainer scene
    // rather than 3 unowned creatures floating on the enemy side.
    const npcTrainerRig = buildBlockyCharacter(npcTrainerColors, npcLabel);
    npcTrainerRig.group.position.set(
      local.x + forwardX * npcTrainerOffset,
      0,
      local.z + forwardZ * npcTrainerOffset,
    );
    npcTrainerRig.group.rotation.y = local.facingAngle + Math.PI;
    scene.add(npcTrainerRig.group);

    // Dome/camera center on the midpoint of the whole scene (player's own
    // spot through the opponent trainer's), not just the player's own
    // position.
    const midOffset = npcTrainerOffset / 2;
    const centerX = local.x + forwardX * midOffset;
    const centerZ = local.z + forwardZ * midOffset;

    const domeGeometry = new THREE.SphereGeometry(TEAM_DOME_RADIUS, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    const domeMaterial = new THREE.MeshBasicMaterial({
      color: "#bfe3ff", transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false,
    });
    const domeMesh = new THREE.Mesh(domeGeometry, domeMaterial);
    domeMesh.position.set(centerX, 0, centerZ);
    scene.add(domeMesh);

    setLocalTransparent(true);

    const maxSpeed = (team) => Math.max(...team.members.map((m) => m.combatant.speed));

    teamBattle = {
      centerX,
      centerZ,
      camAngle: local.facingAngle + BATTLE_CAM_ANGLE_OFFSET,
      domeMesh,
      npcTrainerRig,
      teams: [yourTeam, npcTeam], // index 0 is always the player, index 1 always the opponent — only the attacker/defender *role* (turnSide) alternates
      turnSide: maxSpeed(yourTeam) >= maxSpeed(npcTeam) ? 0 : 1, // opening side only — strictly alternates every round after, same fix as the wild battle
      pendingSteps: [],
      tickTimer: null,
      focus: null, // null = default wide framing; else {camX,camZ,lookX,lookZ} — see focusCameraOnMember
      focusedMember: null,
      ended: false,
    };

    teamBattleLogEl.innerHTML = "";
    clearTeamActions();
    renderTeamHpBars();
    teamBattlePanel.style.display = "block";
  }

  function starterSpec() {
    const species = SPECIES_BY_KEY[ctx.starter.species_key];
    const combatant = computeCombatant(
      species,
      { speed: ctx.starter.iv_speed, attack: ctx.starter.iv_attack, defense: ctx.starter.iv_defense },
      { speed: ctx.starter.ev_speed, attack: ctx.starter.ev_attack, defense: ctx.starter.ev_defense },
      ctx.starter.level,
    );
    combatant.fainted = false;
    return { species, combatant };
  }

  function randomSpec() {
    const species = SPECIES[randomInt(0, SPECIES.length - 1)];
    const combatant = computeCombatant(species, rollIVs(), null);
    combatant.fainted = false;
    return { species, combatant };
  }

  function startTeamBattle() {
    if (battle || teamBattle || pvpBattle || !ctx.starter) return;
    setBattleButtonsDisabled(true);
    closeGlophimonMenuPanel();
    closeGlophimonStatsModal();
    // Your own real starter takes one slot; the other two are random
    // "teammates" — there's no real multi-Glophimon roster to draw from
    // yet (an account only ever owns its one starter so far), so this is
    // a placeholder until a real catch/team system exists.
    buildTeamBattleSides([starterSpec(), randomSpec(), randomSpec()], "NPC Team", NPC_TRAINER_COLORS);
    logTeamBattle("A 3v3 battle begins!");
    beginTeamRound();
  }

  // Shared by every focus function below — restores whichever Glophimon
  // was previously the transparent "camera anchor" before switching to a
  // new one (or to none).
  function setFocusedMember(member) {
    if (teamBattle.focusedMember && teamBattle.focusedMember !== member) {
      setRigTransparent(teamBattle.focusedMember.rig, false);
    }
    teamBattle.focusedMember = member;
    if (member) setRigTransparent(member.rig, true);
  }

  // Parks the camera close behind a specific Glophimon, raised and angled
  // down rather than a flat eye-level shot. That Glophimon is made
  // transparent for the duration, since the camera sitting right behind it
  // would otherwise have its own body blocking the view of everything
  // beyond. lookAtPos is optional — without it, the camera looks out past
  // the member in whatever direction it itself faces (used while declaring
  // or attacking); when defending, processNextTeamStep passes the real
  // attacker's own position instead, so the camera is anchored on *your*
  // Glophimon (the one you're choosing a command for) while still aiming
  // at the actual threat.
  function focusCameraOnMember(member, facingAngle, lookAtPos) {
    setFocusedMember(member);
    const fx = Math.sin(facingAngle);
    const fz = Math.cos(facingAngle);
    const pos = member.rig.group.position;
    teamBattle.focus = {
      camX: pos.x - fx * TEAM_FOCUS_CAM_BEHIND,
      camZ: pos.z - fz * TEAM_FOCUS_CAM_BEHIND,
      lookX: lookAtPos ? lookAtPos.x : pos.x + fx * TEAM_FOCUS_CAM_LOOK_AHEAD,
      lookZ: lookAtPos ? lookAtPos.z : pos.z + fz * TEAM_FOCUS_CAM_LOOK_AHEAD,
    };
  }

  // Back to the default wide framing — used for the confirm-all step,
  // between rounds, and whenever it's the opponent's own turn to declare
  // (their side is never focused on directly, see the game's own plan).
  function unfocusCamera() {
    setFocusedMember(null);
    teamBattle.focus = null;
  }

  function beginTeamRound() {
    if (!teamBattle || teamBattle.ended) return;
    // Buffs/debuffs age one turn every round, for every member on both
    // sides (not just whoever's about to act) — see tickEffects.
    for (const team of teamBattle.teams) for (const m of team.members) tickEffects(m.combatant);
    const attackTeam = teamBattle.teams[teamBattle.turnSide];
    const defendTeam = teamBattle.teams[1 - teamBattle.turnSide];
    teamBattle.attackTeam = attackTeam;
    teamBattle.defendTeam = defendTeam;
    logTeamBattle(`${attackTeam.label}'s turn to attack!`);

    // Clear this team's attack-lockout from two turns ago (see the plan's
    // own strategy note) before this turn's attackers get marked — it's
    // only meant to last exactly one defend phase.
    for (const m of attackTeam.members) m.lockedFromDefending = false;

    // Commands are declared one Glophimon at a time, strictly left-to-right
    // by row position (member array order === row order, index 0 leftmost)
    // — not Speed order any more; Speed now only decides which side opens
    // each turn.
    const living = attackTeam.members.filter((m) => !m.combatant.fainted);
    teamBattle.declareLiving = living;
    teamBattle.declareIndex = 0;
    teamBattle.declareChoices = new Array(living.length).fill(null);

    if (teamBattle.turnSide === 0) {
      showPlayerDeclareStep(local.facingAngle);
    } else {
      showNpcDeclareStep();
    }
  }

  // Living attackTeam members other than `member` — the pool an
  // ally-targeted heal/buff move can pick from (see livingAllies, the
  // wild battle's own equivalent). Deliberately the attacking side's own
  // team, not hardcoded to teams[0], since either side can be "attacking"
  // here.
  function livingTeamAllies(member) {
    return teamBattle.attackTeam.members.filter((m) => !m.combatant.fainted && m !== member);
  }

  // Player's declare-phase UI for one Glophimon at a time: every move it
  // knows (generic Attack + its own special move(s)) plus Idle, plus Back
  // (once past the first) to reconsider an earlier choice — same shape as
  // the wild battle's own showWildDeclareStep. Once every living member
  // has a choice, shows a summary + Confirm/Back.
  function showPlayerDeclareStep(attackerFacing) {
    const living = teamBattle.declareLiving;
    const i = teamBattle.declareIndex;
    teamBattle.declareSubStep = null;
    if (i >= living.length) {
      showPlayerDeclareConfirm();
      return;
    }
    const member = living[i];

    if (member.combatant.forcedIdleNextTurn) {
      member.combatant.forcedIdleNextTurn = false;
      logTeamBattle(`${member.combatant.name} flinched and couldn't act!`);
      teamBattle.declareChoices[i] = "idle";
      teamBattle.declareIndex += 1;
      showPlayerDeclareStep(attackerFacing);
      return;
    }

    focusCameraOnMember(member, attackerFacing);
    logTeamBattle(`${member.combatant.name}, what will you do?`);
    teamActionsEl.innerHTML = "";
    teamActionsEl.style.display = "flex";

    for (const move of movesForSpecies(member.combatant.speciesKey)) {
      const pp = member.combatant.pp[move.key];
      teamActionsEl.appendChild(buildMoveOptionRow(move, pp, () => chooseMoveTeam(i, member, move, attackerFacing)));
    }

    const idleBtn = document.createElement("button");
    idleBtn.textContent = "Idle";
    idleBtn.style.fontSize = "11px";
    idleBtn.addEventListener("click", () => {
      teamBattle.declareChoices[i] = "idle";
      teamBattle.declareIndex += 1;
      showPlayerDeclareStep(attackerFacing);
    });
    teamActionsEl.appendChild(idleBtn);

    if (i > 0) {
      const backBtn = document.createElement("button");
      backBtn.textContent = "Back";
      backBtn.style.fontSize = "11px";
      backBtn.addEventListener("click", () => {
        teamBattle.declareIndex -= 1;
        showPlayerDeclareStep(attackerFacing);
      });
      teamActionsEl.appendChild(backBtn);
    }
  }

  function chooseMoveTeam(i, member, move, attackerFacing) {
    if (move.target === "ally") {
      const allies = livingTeamAllies(member);
      if (allies.length === 0) {
        teamBattle.declareChoices[i] = "idle";
        teamBattle.declareIndex += 1;
        showPlayerDeclareStep(attackerFacing);
        return;
      }
      if (allies.length === 1) {
        teamBattle.declareChoices[i] = { moveKey: move.key, target: allies[0] };
        teamBattle.declareIndex += 1;
        showPlayerDeclareStep(attackerFacing);
        return;
      }
      showAllyTargetPickerTeam(i, member, move, allies, attackerFacing);
      return;
    }
    teamBattle.declareChoices[i] = { moveKey: move.key, target: null };
    teamBattle.declareIndex += 1;
    showPlayerDeclareStep(attackerFacing);
  }

  function showAllyTargetPickerTeam(i, member, move, allies, attackerFacing) {
    teamBattle.declareSubStep = { i, move };
    logTeamBattle(`Choose a target for ${move.name}.`);
    teamActionsEl.innerHTML = "";
    teamActionsEl.style.display = "flex";
    for (const ally of allies) {
      const btn = document.createElement("button");
      btn.textContent = ally.combatant.name;
      btn.style.fontSize = "11px";
      btn.addEventListener("click", () => {
        teamBattle.declareChoices[i] = { moveKey: move.key, target: ally };
        teamBattle.declareIndex += 1;
        showPlayerDeclareStep(attackerFacing);
      });
      teamActionsEl.appendChild(btn);
    }
    const backBtn = document.createElement("button");
    backBtn.textContent = "Back";
    backBtn.style.fontSize = "11px";
    backBtn.addEventListener("click", () => showPlayerDeclareStep(attackerFacing));
    teamActionsEl.appendChild(backBtn);
  }

  function describeChoiceTeam(choice) {
    if (choice === "idle") return "Idle";
    return MOVE_BY_KEY[choice.moveKey].name;
  }

  function showPlayerDeclareConfirm() {
    unfocusCamera();
    const living = teamBattle.declareLiving;
    const summary = living.map((m, i) => `${m.combatant.name}: ${describeChoiceTeam(teamBattle.declareChoices[i])}`).join(", ");
    logTeamBattle(`Your commands — ${summary}`);
    teamActionsEl.innerHTML = "";
    teamActionsEl.style.display = "flex";

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "Confirm Choices";
    confirmBtn.style.fontSize = "11px";
    confirmBtn.addEventListener("click", () => {
      clearTeamActions();
      resolveDeclaredTeamRound(living);
    });
    teamActionsEl.appendChild(confirmBtn);

    const backBtn = document.createElement("button");
    backBtn.textContent = "Back";
    backBtn.style.fontSize = "11px";
    backBtn.addEventListener("click", () => {
      teamBattle.declareIndex = living.length - 1;
      showPlayerDeclareStep(local.facingAngle);
    });
    teamActionsEl.appendChild(backBtn);
  }

  // Shared by both the player's Confirm button and the NPC's own
  // terminal step (see showNpcDeclareStep) — splits declared actions into
  // heal/buff (resolved immediately, no opponent involved) vs
  // damage/debuff (queued into pendingSteps, resolved one at a time
  // through the existing defend-matching pipeline).
  function resolveDeclaredTeamRound(living) {
    const acting = living
      .map((m, i) => ({ member: m, choice: teamBattle.declareChoices[i] }))
      .filter((s) => s.choice !== "idle");
    const healOrBuffSteps = acting.filter((s) => {
      const k = MOVE_BY_KEY[s.choice.moveKey].kind;
      return k === "heal" || k === "buff";
    });
    const attackSteps = acting.filter((s) => !healOrBuffSteps.includes(s));

    for (const { member, choice } of healOrBuffSteps) {
      const move = MOVE_BY_KEY[choice.moveKey];
      const targets =
        move.target === "team" ? [member.combatant, ...livingTeamAllies(member).map((m) => m.combatant)]
        : move.target === "ally" ? [(choice.target || member).combatant]
        : [member.combatant];
      resolveMove({
        move,
        attackerCombatant: member.combatant,
        defenderCombatant: null,
        targets,
        defends: false,
        ctx: { log: logTeamBattle, onUndefendedDamage: () => {} },
      });
      member.anim = { type: "cast", elapsedMs: 0 };
    }

    for (const { member } of attackSteps) member.lockedFromDefending = true; // can't defend next turn — see the plan's own strategy note
    teamBattle.pendingSteps = attackSteps; // {member, choice} pairs, already left-to-right
    if (acting.length === 0) logTeamBattle(`${teamBattle.attackTeam.label} declares no attacks this round.`);
    renderTeamHpBars();
    teamBattle.tickTimer = setTimeout(processNextTeamStep, TEAM_STEP_MS);
  }

  // NPC's own declare phase — same left-to-right one-at-a-time pacing as
  // the player's, still "completely random" (see the plan), but the
  // camera never turns to face the opponent's side at all — it just stays
  // on the default wide reset framing (unfocusCamera) for the whole thing.
  // Only ever picks Attack or Idle (no AI move-selection among a
  // species' own special moves yet — same scoping as wild Glophimon in
  // the other battle mode) but stores its choice in the same
  // {moveKey,target} shape as the player's own so resolveDeclaredTeamRound
  // doesn't need to special-case either side.
  function showNpcDeclareStep() {
    const living = teamBattle.declareLiving;
    const i = teamBattle.declareIndex;
    unfocusCamera();
    if (i >= living.length) {
      resolveDeclaredTeamRound(living);
      return;
    }
    const member = living[i];
    if (member.combatant.forcedIdleNextTurn) {
      member.combatant.forcedIdleNextTurn = false;
      logTeamBattle(`${member.combatant.name} flinched and couldn't act!`);
      teamBattle.declareChoices[i] = "idle";
      teamBattle.declareIndex += 1;
      teamBattle.tickTimer = setTimeout(showNpcDeclareStep, TEAM_STEP_MS);
      return;
    }
    const willAttack = Math.random() < TEAM_ATTACK_CHANCE;
    teamBattle.declareChoices[i] = willAttack ? { moveKey: ATTACK_MOVE.key, target: null } : "idle";
    logTeamBattle(`${member.combatant.name} will ${willAttack ? "attack" : "stay idle"} this turn.`);
    teamBattle.declareIndex += 1;
    teamBattle.tickTimer = setTimeout(showNpcDeclareStep, TEAM_STEP_MS);
  }

  // Player's defend-phase UI — one button per still-available (living,
  // not yet assigned this round) Glophimon to defend with, plus Don't
  // Defend, shown once per incoming attacker (see processNextTeamStep,
  // which already focused the camera behind that attacker before this runs).
  function showPlayerDefenderSelection(attackerMember, move) {
    const attackTeam = teamBattle.attackTeam;
    const defendTeam = teamBattle.defendTeam;
    logTeamBattle(`${attackTeam.label}'s ${attackerMember.combatant.name} is attacking!`);
    teamActionsEl.innerHTML = "";
    teamActionsEl.style.display = "flex";

    // lockedFromDefending excludes anyone who attacked on this team's own
    // last turn — see the plan's own strategy note ("idle some so they
    // stay available to defend the very next attack").
    let eligible = defendTeam.members.filter((m) => !m.combatant.fainted && !m.assignedThisRound && !m.lockedFromDefending);
    // Guardian's Resolve/taunt (see MOVES_BY_SPECIES' own
    // forcedDefenderTurns) narrows the choice down to just the taunted
    // member, rather than replacing the defend-selection UI with new
    // ownership — if that member's already unavailable for an unrelated
    // reason (fainted/assigned/locked), the taunt just doesn't bite this
    // time and the normal eligible set applies.
    const taunted = eligible.find((m) => m.combatant.forcedDefenderTurns > 0);
    if (taunted) eligible = [taunted];

    if (eligible.length === 0) {
      // Nothing left to assign — a real choice ("Don't Defend" sitting
      // alongside real Defend options) would be misleading here since
      // there's nothing to actually choose between, so this collapses to a
      // plain acknowledge-and-continue step with an explanatory note.
      const note = document.createElement("p");
      note.textContent = "No defenders available!";
      note.style.fontSize = "11px";
      note.style.color = "#f87171";
      note.style.margin = "2px 0";
      note.style.width = "100%"; // forces its own line in the wrapping flex row, ahead of the button
      teamActionsEl.appendChild(note);
      const confirmBtn = document.createElement("button");
      confirmBtn.textContent = "Continue";
      confirmBtn.style.fontSize = "11px";
      confirmBtn.addEventListener("click", () => {
        clearTeamActions();
        resolveTeamExchange(attackerMember, move, null);
      });
      teamActionsEl.appendChild(confirmBtn);
      return;
    }

    eligible.forEach((m) => {
      const btn = document.createElement("button");
      btn.textContent = `Defend: ${m.combatant.name}`;
      btn.style.fontSize = "11px";
      btn.addEventListener("click", () => {
        clearTeamActions();
        m.assignedThisRound = true;
        resolveTeamExchange(attackerMember, move, m);
      });
      teamActionsEl.appendChild(btn);
    });

    const noDefendBtn = document.createElement("button");
    noDefendBtn.textContent = "Don't Defend";
    noDefendBtn.style.fontSize = "11px";
    noDefendBtn.addEventListener("click", () => {
      clearTeamActions();
      resolveTeamExchange(attackerMember, move, null);
    });
    teamActionsEl.appendChild(noDefendBtn);
  }

  function processNextTeamStep() {
    if (!teamBattle || teamBattle.ended) return;
    const step = teamBattle.pendingSteps.shift();
    if (!step) {
      unfocusCamera();
      finishTeamRound();
      return;
    }
    const attackerMember = step.member;
    const move = MOVE_BY_KEY[step.choice.moveKey];

    // Resolution proceeds in the same left-to-right order the attacks were
    // declared in (pendingSteps was already built that way).
    if (teamBattle.attackTeam === teamBattle.teams[0]) {
      // Your own attacker acting — camera behind it, looking out the
      // direction it itself faces (no explicit target needed).
      focusCameraOnMember(attackerMember, local.facingAngle);
    } else {
      // NPC attacking, so it's your turn to defend: the camera is
      // anchored on *your* Glophimon (whichever one you'd currently
      // command — the leftmost still-living one, matching the row order
      // the Defend buttons already use) but aimed at the real attacker,
      // not a generic point. The attacker itself gets a "it's my turn"
      // ready pose (steps forward, left arm up) as an extra cue.
      const yourRepresentative = teamBattle.defendTeam.members.find((m) => !m.combatant.fainted);
      if (yourRepresentative) {
        focusCameraOnMember(yourRepresentative, local.facingAngle, attackerMember.rig.group.position);
      } else {
        unfocusCamera();
      }
      attackerMember.anim = { type: "ready", elapsedMs: 0 };
    }

    if (teamBattle.defendTeam === teamBattle.teams[0]) {
      // Player must choose how to defend — pause here; resolveTeamExchange
      // is called once they click a button.
      showPlayerDefenderSelection(attackerMember, move);
      return;
    }

    // NPC defends automatically — same random roll as before.
    const wantsDefend = Math.random() < WILD_DEFEND_CHANCE;
    let defenderMember = null;
    if (wantsDefend) {
      const eligible = teamBattle.defendTeam.members.filter((m) => !m.combatant.fainted && !m.assignedThisRound && !m.lockedFromDefending);
      if (eligible.length > 0) defenderMember = eligible[randomInt(0, eligible.length - 1)];
    }
    if (defenderMember) defenderMember.assignedThisRound = true;
    resolveTeamExchange(attackerMember, move, defenderMember);
  }

  function resolveTeamExchange(attackerMember, move, defenderMember) {
    const attackTeam = teamBattle.attackTeam;
    const defendTeam = teamBattle.defendTeam;
    const attacker = attackerMember.combatant;

    attackerMember.anim = { type: move.kind === "debuff" ? "cast" : "attack", elapsedMs: 0 };
    // Marks the actual target for this exchange, regardless of hit/miss —
    // see character.js's updateTargetFlash. Only meaningful when a specific
    // defender was assigned; an undefended attack drains the trainer HP
    // pool directly with no specific Glophimon target to flash.
    if (defenderMember) defenderMember.rig.targetAnim = { elapsedMs: 0 };

    const result = resolveMove({
      move,
      attackerCombatant: attacker,
      defenderCombatant: defenderMember ? defenderMember.combatant : null,
      defends: !!defenderMember,
      ctx: {
        log: logTeamBattle,
        onUndefendedDamage: (dmg) => {
          // Drains the defending trainer's own HP directly (see the
          // game's own plan/design notes), not a specific Glophimon's HP.
          if (defendTeam === teamBattle.teams[0]) {
            // Your own side — this IS the real, persistent playerHp (see
            // buildTeamBattleSides), not a per-match pool, so it has to
            // go through setPlayerHp to actually persist.
            setPlayerHp(playerHp - dmg);
            defendTeam.trainerHp = playerHp;
          } else {
            defendTeam.trainerHp = Math.max(0, defendTeam.trainerHp - dmg);
          }
        },
      },
    });
    if (result?.hit && defenderMember && move.kind === "damage") {
      defenderMember.anim = { type: "defend", elapsedMs: 0 };
      if (defenderMember.combatant.hp <= 0) {
        defenderMember.combatant.fainted = true;
        logTeamBattle(`${defendTeam.label}'s ${defenderMember.combatant.name} fainted!`);
      }
    }

    renderTeamHpBars();
    teamBattle.tickTimer = setTimeout(processNextTeamStep, TEAM_STEP_MS);
  }

  function finishTeamRound() {
    if (!teamBattle || teamBattle.ended) return;
    for (const team of teamBattle.teams) {
      for (const m of team.members) m.assignedThisRound = false;
    }

    const yourTeamDown = teamBattle.teams[0].members.every((m) => m.combatant.fainted) || teamBattle.teams[0].trainerHp <= 0;
    const npcTeamDown = teamBattle.teams[1].members.every((m) => m.combatant.fainted) || teamBattle.teams[1].trainerHp <= 0;
    if (yourTeamDown || npcTeamDown) {
      if (yourTeamDown && npcTeamDown) logTeamBattle("Both teams are down at once — it's a draw!");
      else logTeamBattle(yourTeamDown ? "NPC Team wins..." : "Your Team wins!");
      if (yourTeamDown) handlePlayerBlackout();
      endTeamBattle();
      return;
    }

    teamBattle.turnSide = 1 - teamBattle.turnSide;
    teamBattle.tickTimer = setTimeout(beginTeamRound, TEAM_ROUND_PAUSE_MS);
  }

  function endTeamBattle() {
    if (!teamBattle) return;
    teamBattle.ended = true;
    if (teamBattle.tickTimer) clearTimeout(teamBattle.tickTimer);
    unfocusCamera();
    clearTeamActions();
    for (const team of teamBattle.teams) {
      for (const m of team.members) {
        scene.remove(m.rig.group);
        disposeRig(m.rig);
      }
    }
    scene.remove(teamBattle.npcTrainerRig.group);
    disposeRig(teamBattle.npcTrainerRig);
    scene.remove(teamBattle.domeMesh);
    teamBattle.domeMesh.geometry.dispose();
    teamBattle.domeMesh.material.dispose();
    setLocalTransparent(false);
    for (const peer of peers.values()) setPeerHidden(peer, false);
    teamBattlePanel.style.display = "none";
    setBattleButtonsDisabled(false);
    teamBattle = null;
  }

  stopTeamBattleBtn.addEventListener("click", () => {
    if (!teamBattle) return;
    logTeamBattle("Battle stopped.");
    endTeamBattle();
  });
  teamBattleButton.addEventListener("click", startTeamBattle);

  // Manual (drag-to-look) is the only camera mode now — the Auto/Manual
  // toggle was removed per explicit request, so there's nothing to reset
  // to; camAngle/camElevation/zoomRadius just persist at whatever the
  // player last dragged them to.
  let camAngle = DEFAULT_CAM_ANGLE;
  let camElevation = CAMERA_ELEVATION;
  let zoomRadius = CAMERA_RADIUS;
  let followX = local.x;
  let followZ = local.z;
  let isDragging = false;
  let lastMouseX = 0;
  let lastMouseY = 0;
  canvas.style.cursor = "grab";

  function onWheel(event) {
    event.preventDefault();
    if (battle || teamBattle || pvpBattle) return; // battle camera is fixed, see frame()
    zoomRadius = Math.min(MAX_ZOOM_RADIUS, Math.max(MIN_ZOOM_RADIUS, zoomRadius + event.deltaY * ZOOM_SPEED));
  }
  canvas.addEventListener("wheel", onWheel, { passive: false });

  // Tracks whether the current mousedown-to-mouseup gesture moved enough
  // to count as a camera drag rather than a click — onCanvasClick (below)
  // uses this to tell "the player dragged the camera through Rodz's
  // position" apart from "the player actually clicked Rodz."
  let mouseDownX = 0;
  let mouseDownY = 0;
  let draggedPastThreshold = false;

  function onMouseDown(event) {
    if (event.button !== 0 || battle || teamBattle || pvpBattle) return;
    isDragging = true;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    mouseDownX = event.clientX;
    mouseDownY = event.clientY;
    draggedPastThreshold = false;
    canvas.style.cursor = "grabbing";
  }
  function onMouseMove(event) {
    if (!isDragging) return;
    const dx = event.clientX - lastMouseX;
    const dy = event.clientY - lastMouseY;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    camAngle -= dx * DRAG_SENSITIVITY;
    camElevation = Math.min(MAX_ELEVATION, Math.max(MIN_ELEVATION, camElevation + dy * DRAG_SENSITIVITY));
    if (Math.hypot(event.clientX - mouseDownX, event.clientY - mouseDownY) > CLICK_DRAG_THRESHOLD_PX) {
      draggedPastThreshold = true;
    }
  }
  function onMouseUp() {
    if (!isDragging) return;
    isDragging = false;
    canvas.style.cursor = "grab";
  }
  canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  const raycaster = new THREE.Raycaster();

  // Called every time the popup actually opens — clears any previous
  // answer Rodz gave (from an earlier visit this session) so a fresh open
  // never shows a stale scold/confirmation before the player has asked for
  // anything this time. The Claim button itself is always visible
  // regardless of menuData.inventory.daily_claim_available — only clicking
  // it (see the click handler below) reveals whether it's actually
  // available or already claimed.
  function refreshRodzClaimSection() {
    rodzClaimTextEl.style.display = "none";
  }

  // Whether any owned Glophimon (active or boxed — healing the whole
  // roster in one visit, same as a real Pokémon Center, is simplest and
  // boxed ones can't take damage anyway until reactivated) is below its
  // own max HP.
  function anyGlophimonNeedsHealing() {
    return menuData.glophimon.some((g) => (g.current_hp ?? maxHpFor(g.level)) < maxHpFor(g.level));
  }

  // Same "refresh every time the popup opens" idea as the claim section —
  // playerHp/menuData.glophimon change constantly (battles, other heals),
  // so this can't be computed once and cached.
  function refreshRodzHealSection() {
    const needsHeal = playerHp < PLAYER_MAX_HP || anyGlophimonNeedsHealing();
    rodzHealTextEl.textContent = needsHeal
      ? `Heal your trainer and your Glophimon? (Trainer: ${playerHp}/${PLAYER_MAX_HP})`
      : `You and your Glophimon are already at full health.`;
    rodzHealBtn.style.display = needsHeal ? "inline-block" : "none";
  }

  function hideRodzMenu() {
    rodzMenuEl.style.display = "none";
  }

  function showRodzMenu(clientX, clientY) {
    refreshRodzClaimSection();
    refreshRodzHealSection();
    const wrapRect = wrap.getBoundingClientRect();
    rodzMenuEl.style.left = `${clientX - wrapRect.left}px`;
    rodzMenuEl.style.top = `${clientY - wrapRect.top}px`;
    rodzMenuEl.style.display = "block";
    // Talking to Rodz already answers "is there anything to claim" —
    // no need for the ambient shout to keep going while the player is
    // looking right at the popup that says so.
    hideRodzShoutBubble();
  }

  function karirsStatusText(race) {
    if (!race) return "No race information yet.";
    if (race.status === "betting_open") return "Betting is open for the next race!";
    if (race.status === "racing") return "A race is underway right now!";
    return `Last race: ${race.winning_name} won!`;
  }

  function formatCountdown(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function hideKarraMenu() {
    karraMenuEl.style.display = "none";
  }

  function hideJaredMenu() {
    jaredMenuEl.style.display = "none";
  }

  function showJaredMenu(clientX, clientY) {
    const wrapRect = wrap.getBoundingClientRect();
    jaredMenuEl.style.left = `${clientX - wrapRect.left}px`;
    jaredMenuEl.style.top = `${clientY - wrapRect.top}px`;
    jaredMenuEl.style.display = "block";
    jaredQtyInput.value = "1";
    jaredMessageEl.style.display = "none";
  }

  // A server-side rejection (already hosting, not standing in the Luba
  // area, target not eligible, lobby full, etc.) surfaces here as a
  // transient line in whichever of Boss Rick's popup / the lobby modal is
  // actually open — there's no dedicated toast system in this file to
  // reuse. Not auto-cleared; the next render of that panel (innerHTML =
  // "") clears it naturally.
  function showLubaError(reason) {
    const p = document.createElement("p");
    p.style.fontSize = "10px";
    p.style.color = "#ef4444";
    p.style.margin = "4px 0 0 0";
    p.textContent = `Error: ${reason}`;
    if (bossRickMenuEl.style.display !== "none") bossRickMenuBodyEl.appendChild(p);
    else if (lubaLobbyModalEl.style.display !== "none") lubaLobbyBodyEl.appendChild(p);
    else console.warn("[luba]", reason);
  }

  // Same shape as showLubaError above, just anchored to the player-options
  // popup instead.
  function showPvpError(reason) {
    const p = document.createElement("p");
    p.style.fontSize = "10px";
    p.style.color = "#ef4444";
    p.style.margin = "4px 0 0 0";
    p.textContent = `Error: ${reason}`;
    if (playerOptionsMenuEl.style.display !== "none") playerOptionsMenuBodyEl.appendChild(p);
    else console.warn("[pvp]", reason);
  }

  // Boss Rick's popup — the Luba area's own attendant. The only NPC in
  // this game with a genuine multi-step dialogue (see bossRickStep):
  // host? -> mode confirm -> time limit. The lobby modal itself only opens
  // once the server's own luba_lobby_state broadcast comes back (see
  // onSocketMessage), not optimistically here, so a server-side rejection
  // (e.g. already hosting) never leaves a stray open lobby.
  function hideBossRickMenu() {
    bossRickMenuEl.style.display = "none";
    bossRickStep = "closed";
  }

  function showBossRickMenu(clientX, clientY) {
    const wrapRect = wrap.getBoundingClientRect();
    bossRickMenuEl.style.left = `${clientX - wrapRect.left}px`;
    bossRickMenuEl.style.top = `${clientY - wrapRect.top}px`;
    bossRickMenuEl.style.display = "block";
    bossRickStep = "host_confirm";
    renderBossRickMenu();
  }

  function renderBossRickMenu() {
    bossRickMenuBodyEl.innerHTML = "";

    function addBtn(label, onClick) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.fontSize = "11px";
      btn.style.display = "block";
      btn.style.width = "100%";
      btn.style.margin = "2px 0";
      btn.addEventListener("click", onClick);
      bossRickMenuBodyEl.appendChild(btn);
    }
    function addLabel(text) {
      const p = document.createElement("p");
      p.style.margin = "0 0 4px 0";
      p.textContent = text;
      bossRickMenuBodyEl.appendChild(p);
    }

    if (bossRickStep === "host_confirm") {
      addLabel("Host a Luba deathmatch?");
      addBtn("Yes", () => {
        bossRickStep = "mode_confirm";
        renderBossRickMenu();
      });
      addBtn("No", () => hideBossRickMenu());
    } else if (bossRickStep === "mode_confirm") {
      addLabel("Mode: Deathmatch");
      addBtn("Confirm", () => {
        bossRickStep = "duration_select";
        renderBossRickMenu();
      });
      addBtn("Back", () => {
        bossRickStep = "host_confirm";
        renderBossRickMenu();
      });
    } else if (bossRickStep === "duration_select") {
      addLabel("How long?");
      for (const durationS of LUBA_DURATION_OPTIONS_S) {
        addBtn(`${Math.round(durationS / 60)} min`, () => {
          socket.sendLubaHostRequest("deathmatch", durationS);
          hideBossRickMenu();
        });
      }
      addBtn("Back", () => {
        bossRickStep = "mode_confirm";
        renderBossRickMenu();
      });
    }
  }

  // --- Chessdom -----------------------------------------------------------
  // Server-authoritative, same shape as PVP Stage 2 — this client never
  // runs chess rules itself, it only renders whatever the latest chess_state
  // broadcast says (see onSocketMessage's own chess_state branch below).

  function showChessError(reason) {
    const p = document.createElement("p");
    p.style.fontSize = "10px";
    p.style.color = "#ef4444";
    p.style.margin = "4px 0 0 0";
    p.textContent = `Error: ${reason}`;
    if (chessHostMenuEl.style.display !== "none") chessHostMenuBodyEl.appendChild(p);
    else if (chessJoinMenuEl.style.display !== "none") chessJoinMenuBodyEl.appendChild(p);
    else console.warn("[chess]", reason);
  }

  // The server is sole authority on the actual 30s timeout (see
  // main.py's own CHESS_LEAVE_GRACE_S/_chess_away_timeout) — this local
  // setInterval only drives the visible countdown text, it never decides
  // anything itself.
  function hideChessLeaveWarning() {
    chessLeaveWarningEl.style.display = "none";
    if (chessLeaveWarningIntervalId != null) {
      clearInterval(chessLeaveWarningIntervalId);
      chessLeaveWarningIntervalId = null;
    }
  }

  function showChessLeaveWarning(seconds) {
    hideChessLeaveWarning();
    let remaining = seconds;
    chessLeaveWarningTextEl.textContent = `You left Tambayan! Auto resignation in ${remaining}s if you don't return.`;
    chessLeaveWarningEl.style.display = "block";
    chessLeaveWarningIntervalId = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        hideChessLeaveWarning();
        return;
      }
      chessLeaveWarningTextEl.textContent = `You left Tambayan! Auto resignation in ${remaining}s if you don't return.`;
    }, 1000);
  }

  // Keeps each table's own status sign in sync — called only when that
  // board's chess_state actually changes, not every frame (matches
  // updateKarirsBoardText's own on-demand-redraw convention).
  function updateChessBoardSign(boardId, board) {
    const sign = boardId === 1 ? chessBoard1StatusSign : chessBoard2StatusSign;
    if (board.status === "empty") {
      sign.sprite.visible = false;
      return;
    }
    sign.sprite.visible = true;
    if (board.status === "waiting") {
      updateKarirsBoardText(sign, `Hosted by ${board.hostDisplayName} — waiting for opponent`);
    } else {
      updateKarirsBoardText(sign, `${board.whiteDisplayName} vs ${board.blackDisplayName} — In Progress`);
    }
  }

  function onChessBoardClick(boardId, clientX, clientY) {
    const board = chessBoards[boardId];
    if (board.status === "empty") {
      showChessHostMenu(boardId, clientX, clientY);
    } else if (board.status === "waiting") {
      if (board.hostId === localUserId) {
        showChessWaitingModal(boardId);
      } else {
        showChessJoinMenu(boardId, clientX, clientY);
      }
    } else if (board.status === "in_progress") {
      const isPlayer = board.whiteUserId === localUserId || board.blackUserId === localUserId;
      showChessMatchModal(boardId, !isPlayer);
    }
  }

  function hideChessHostMenu() {
    chessHostMenuEl.style.display = "none";
    chessHostTargetBoardId = null;
  }

  function showChessHostMenu(boardId, clientX, clientY) {
    chessHostTargetBoardId = boardId;
    const wrapRect = wrap.getBoundingClientRect();
    chessHostMenuEl.style.left = `${clientX - wrapRect.left}px`;
    chessHostMenuEl.style.top = `${clientY - wrapRect.top}px`;
    chessHostMenuEl.style.display = "block";
    renderChessHostMenu();
  }

  function renderChessHostMenu() {
    if (chessHostTargetBoardId == null) return;
    chessHostMenuBodyEl.innerHTML = "";
    function addBtn(label, onClick) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.fontSize = "11px";
      btn.style.display = "block";
      btn.style.width = "100%";
      btn.style.margin = "2px 0";
      btn.addEventListener("click", onClick);
      chessHostMenuBodyEl.appendChild(btn);
    }
    const p = document.createElement("p");
    p.style.margin = "0 0 4px 0";
    p.textContent = "Host a game of chess here?";
    chessHostMenuBodyEl.appendChild(p);
    addBtn("Yes", () => socket.sendChessHostRequest(chessHostTargetBoardId));
    addBtn("No", () => hideChessHostMenu());
  }

  function hideChessJoinMenu() {
    chessJoinMenuEl.style.display = "none";
    chessJoinTargetBoardId = null;
  }

  function showChessJoinMenu(boardId, clientX, clientY) {
    chessJoinTargetBoardId = boardId;
    const wrapRect = wrap.getBoundingClientRect();
    chessJoinMenuEl.style.left = `${clientX - wrapRect.left}px`;
    chessJoinMenuEl.style.top = `${clientY - wrapRect.top}px`;
    chessJoinMenuEl.style.display = "block";
    renderChessJoinMenu();
  }

  function renderChessJoinMenu() {
    if (chessJoinTargetBoardId == null) return;
    chessJoinMenuBodyEl.innerHTML = "";
    function addBtn(label, onClick) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.fontSize = "11px";
      btn.style.display = "block";
      btn.style.width = "100%";
      btn.style.margin = "2px 0";
      btn.addEventListener("click", onClick);
      chessJoinMenuBodyEl.appendChild(btn);
    }
    const board = chessBoards[chessJoinTargetBoardId];
    const p = document.createElement("p");
    p.style.margin = "0 0 4px 0";
    p.textContent = `Play chess with ${board.hostDisplayName}?`;
    chessJoinMenuBodyEl.appendChild(p);
    addBtn("Yes", () => socket.sendChessJoinRequest(chessJoinTargetBoardId));
    addBtn("No", () => hideChessJoinMenu());
  }

  function showChessWaitingModal(boardId) {
    myHostedChessBoardId = boardId;
    chessWaitingModalEl.style.display = "flex";
    renderChessWaitingModal();
  }

  function hideChessWaitingModal() {
    chessWaitingModalEl.style.display = "none";
  }

  function renderChessWaitingModal() {
    if (myHostedChessBoardId == null) return;
    chessWaitingBodyEl.innerHTML = "";
    const p = document.createElement("p");
    p.style.margin = "0";
    p.style.fontSize = "12px";
    p.textContent = "Waiting for a player to join…";
    chessWaitingBodyEl.appendChild(p);
  }

  function showChessMatchModal(boardId, isSpectator) {
    hideChessHostMenu();
    hideChessJoinMenu();
    activeChessMatch = { boardId, isSpectator, selectedSquare: null };
    chessMatchModalEl.style.display = "flex";
    renderChessMatchModal();
  }

  function hideChessMatchModal() {
    chessMatchModalEl.style.display = "none";
    activeChessMatch = null;
  }

  function onChessSquareClick(boardId, square, pieceChar) {
    if (!activeChessMatch || activeChessMatch.boardId !== boardId || activeChessMatch.isSpectator) return;
    const board = chessBoards[boardId];
    if (board.status !== "in_progress" || board.outcome) return;
    const myColor = board.whiteUserId === localUserId ? "white" : board.blackUserId === localUserId ? "black" : null;
    if (myColor == null || board.turn !== myColor) return;

    if (activeChessMatch.selectedSquare == null) {
      if (!pieceChar) return; // must select one of your own pieces first
      const isWhitePiece = pieceChar === pieceChar.toUpperCase();
      if ((isWhitePiece && myColor !== "white") || (!isWhitePiece && myColor !== "black")) return;
      activeChessMatch.selectedSquare = square;
      activeChessMatch.selectedPieceChar = pieceChar;
      renderChessMatchModal();
      return;
    }
    const from = activeChessMatch.selectedSquare;
    if (from === square) {
      activeChessMatch.selectedSquare = null; // clicking the same square again deselects
      renderChessMatchModal();
      return;
    }
    // Auto-queen on promotion — same simplicity convention the real
    // standalone Chess client already uses (no promotion-choice UI). Unlike
    // that client, this server's python-chess actually REJECTS a trailing
    // promotion letter on a non-promoting move (confirmed directly: it's a
    // parse error, not silently ignored) — so the suffix can only be sent
    // when this really is a pawn reaching the last rank.
    const isPromotion = activeChessMatch.selectedPieceChar?.toLowerCase() === "p" && (square[1] === "8" || square[1] === "1");
    socket.sendChessMove(boardId, `${from}${square}${isPromotion ? "q" : ""}`);
    activeChessMatch.selectedSquare = null;
    activeChessMatch.selectedPieceChar = null;
    renderChessMatchModal(); // optimistic clear only — the real board updates once chess_state actually arrives
  }

  function renderChessMatchModal() {
    if (!activeChessMatch) return;
    const board = chessBoards[activeChessMatch.boardId];
    chessMatchBodyEl.innerHTML = "";

    const myColor = board.whiteUserId === localUserId ? "white" : board.blackUserId === localUserId ? "black" : null;
    const whiteName = board.whiteDisplayName || "?";
    const blackName = board.blackDisplayName || "?";
    const info = document.createElement("p");
    info.style.margin = "0 0 6px 0";
    info.style.fontSize = "11px";
    info.textContent = activeChessMatch.isSpectator
      ? `Spectating: ${whiteName} (White) vs ${blackName} (Black)`
      : `You are ${myColor === "white" ? "White" : "Black"} — vs ${myColor === "white" ? blackName : whiteName}`;
    chessMatchBodyEl.appendChild(info);

    // Black sits at the bottom of their own board, same as a real chess set
    // — the draw order (top-to-bottom, left-to-right on screen) stays the
    // same either way; only which underlying (row,col) — and therefore
    // which real algebraic square — lands at each screen position flips.
    // Spectators always get the default white-at-bottom view.
    const flip = !activeChessMatch.isSpectator && myColor === "black";
    const grid = parseChessFen(board.fen);
    const gridEl = document.createElement("div");
    gridEl.style.display = "grid";
    gridEl.style.gridTemplateColumns = "repeat(8, 32px)";
    gridEl.style.gridTemplateRows = "repeat(8, 32px)";
    gridEl.style.margin = "0 0 6px 0";
    for (let screenRow = 0; screenRow < 8; screenRow++) {
      for (let screenCol = 0; screenCol < 8; screenCol++) {
        const row = flip ? 7 - screenRow : screenRow;
        const col = flip ? 7 - screenCol : screenCol;
        const pieceChar = grid[row][col];
        // onChessSquareClick only ever reasons about this real algebraic
        // square, never screen position, so the flip above never needs to
        // touch the click logic itself.
        const square = `${String.fromCharCode(97 + col)}${8 - row}`;
        const sq = document.createElement("div");
        const light = (row + col) % 2 === 0;
        sq.style.width = "32px";
        sq.style.height = "32px";
        sq.style.display = "flex";
        sq.style.alignItems = "center";
        sq.style.justifyContent = "center";
        sq.style.fontSize = "22px";
        sq.style.cursor = activeChessMatch.isSpectator ? "default" : "pointer";
        sq.style.background = activeChessMatch.selectedSquare === square ? "#4ade80" : light ? "#e8d3a2" : "#6b4423";
        if (pieceChar) {
          const isWhitePiece = pieceChar === pieceChar.toUpperCase();
          sq.textContent = CHESS_UNICODE[pieceChar] || "";
          sq.style.color = isWhitePiece ? "#f8fafc" : "#111827";
          // Outlined opposite its own fill — white pieces in black, black
          // pieces in white — so a glyph never blends into a same-toned
          // square. Chromium-only (-webkit-text-stroke), which is fine:
          // this only ever renders inside this game's own webview.
          sq.style.webkitTextStrokeWidth = "1px";
          sq.style.webkitTextStrokeColor = isWhitePiece ? "#111827" : "#f8fafc";
        }
        if (!activeChessMatch.isSpectator) {
          sq.addEventListener("click", () => onChessSquareClick(activeChessMatch.boardId, square, pieceChar));
        }
        gridEl.appendChild(sq);
      }
    }
    chessMatchBodyEl.appendChild(gridEl);

    const historyEl = document.createElement("p");
    historyEl.style.fontSize = "10px";
    historyEl.style.color = "#a3a3a3";
    historyEl.style.margin = "0 0 6px 0";
    historyEl.textContent = board.moveHistory && board.moveHistory.length ? board.moveHistory.join(" ") : "No moves yet.";
    chessMatchBodyEl.appendChild(historyEl);

    if (board.outcome) {
      const reasonText = {
        checkmate: "Checkmate", stalemate: "Stalemate", draw: "Draw",
        resignation: "Resignation", disconnect: "Opponent disconnected",
        auto_resign_away: "Auto resignation (left Tambayan)",
      }[board.outcome.reason] || board.outcome.reason;
      const outcomeEl = document.createElement("p");
      outcomeEl.style.fontWeight = "bold";
      outcomeEl.style.fontSize = "12px";
      if (board.outcome.winnerUserId == null) {
        outcomeEl.textContent = `Game over — ${reasonText}.`;
      } else if (board.outcome.winnerUserId === localUserId) {
        outcomeEl.textContent = `You won — ${reasonText}!`;
      } else if (!activeChessMatch.isSpectator) {
        outcomeEl.textContent = `You lost — ${reasonText}.`;
      } else {
        const winnerName = board.outcome.winnerUserId === board.whiteUserId ? whiteName : blackName;
        outcomeEl.textContent = `${winnerName} won — ${reasonText}.`;
      }
      chessMatchBodyEl.appendChild(outcomeEl);
    } else if (!activeChessMatch.isSpectator) {
      const turnEl = document.createElement("p");
      turnEl.style.fontSize = "11px";
      turnEl.style.color = "#a3a3a3";
      turnEl.textContent = board.turn === myColor ? "Your move." : "Waiting for opponent…";
      chessMatchBodyEl.appendChild(turnEl);
    }

    if (!activeChessMatch.isSpectator && !board.outcome) {
      const resignBtn = document.createElement("button");
      resignBtn.textContent = "Resign";
      resignBtn.style.fontSize = "11px";
      resignBtn.addEventListener("click", () => socket.sendChessResign(activeChessMatch.boardId));
      chessMatchBodyEl.appendChild(resignBtn);
    }
  }

  // Another player's popup — click-positioned like Boss Rick's own, but
  // its content is a plain state switch rather than a step sequence: a
  // fresh "Invite to PVP" option, or (once sent) "Waiting…"/Cancel if
  // there's already an outgoing invite to this same peer.
  function hidePlayerOptionsMenu() {
    playerOptionsMenuEl.style.display = "none";
    playerOptionsMenuUserId = null;
  }

  function showPlayerOptionsMenu(userId, peer, clientX, clientY) {
    playerOptionsMenuUserId = userId;
    playerOptionsMenuLabel.textContent = peer.displayName;
    const wrapRect = wrap.getBoundingClientRect();
    playerOptionsMenuEl.style.left = `${clientX - wrapRect.left}px`;
    playerOptionsMenuEl.style.top = `${clientY - wrapRect.top}px`;
    playerOptionsMenuEl.style.display = "block";
    renderPlayerOptionsMenu();
  }

  function renderPlayerOptionsMenu() {
    if (playerOptionsMenuUserId == null) return;
    playerOptionsMenuBodyEl.innerHTML = "";

    function addBtn(label, onClick) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.fontSize = "11px";
      btn.style.display = "block";
      btn.style.width = "100%";
      btn.style.margin = "2px 0";
      btn.addEventListener("click", onClick);
      playerOptionsMenuBodyEl.appendChild(btn);
    }

    if (outgoingPvpInvite && outgoingPvpInvite.toUserId === playerOptionsMenuUserId) {
      const p = document.createElement("p");
      p.style.margin = "0 0 4px 0";
      p.style.fontSize = "11px";
      p.style.color = "#a3a3a3";
      p.textContent = "Waiting for response…";
      playerOptionsMenuBodyEl.appendChild(p);
      addBtn("Cancel", () => {
        // The server only notifies the *other* side of a cancel
        // (pvp_declined) — the canceller gets nothing back, so this has to
        // clear local state immediately rather than waiting on a round trip.
        socket.sendPvpCancel(outgoingPvpInvite.inviteId);
        outgoingPvpInvite = null;
        renderPlayerOptionsMenu();
      });
    } else {
      addBtn("Invite to PVP", () => socket.sendPvpInvite(playerOptionsMenuUserId));
    }
  }

  function hidePvpInviteBanner() {
    pvpInviteBannerEl.style.display = "none";
    incomingPvpInvite = null;
  }

  function showPvpInviteBanner(fromDisplayName) {
    pvpInviteAcceptBtn.style.display = "inline-block";
    pvpInviteRejectBtn.style.display = "inline-block";
    pvpInviteBannerTextEl.textContent = `${fromDisplayName} invited you to a PVP battle!`;
    pvpInviteBannerEl.style.display = "block";
  }

  // --- PVP Stage 2: the real battle -------------------------------------
  // Server-authoritative — every function below only ever renders a
  // pvp_match_start/pvp_round_result/pvp_match_end payload it already
  // received; none of them run resolveMove or decide an outcome locally.

  function logPvpBattle(text) {
    const p = document.createElement("p");
    p.style.margin = "1px 0";
    p.textContent = text;
    pvpBattleLogEl.appendChild(p);
    pvpBattleLogEl.scrollTop = pvpBattleLogEl.scrollHeight;
  }

  function updatePvpHpBars() {
    if (!pvpBattle) return;
    const self = pvpBattle.selfCombatant;
    const opp = pvpBattle.opponentCombatant;
    pvpSelfHpRow.nameEl.textContent = `${self.name} — ${Math.max(0, self.hp)}/${self.maxHp} HP`;
    pvpSelfHpRow.barFill.style.width = `${Math.max(0, (self.hp / self.maxHp) * 100)}%`;
    pvpOpponentHpRow.nameEl.textContent = `${opp.name} — ${Math.max(0, opp.hp)}/${opp.maxHp} HP`;
    pvpOpponentHpRow.barFill.style.width = `${Math.max(0, (opp.hp / opp.maxHp) * 100)}%`;
  }

  function renderPvpMoveSelect() {
    if (!pvpBattle || pvpBattle.ended) return;
    pvpMoveSelectEl.innerHTML = "";
    if (pvpBattle.hasSubmitted) {
      pvpStatusEl.textContent = pvpBattle.opponentReady ? "Both ready — resolving…" : "Waiting for opponent…";
      return;
    }
    pvpStatusEl.textContent = pvpBattle.opponentReady ? "Opponent has chosen." : "";
    function submit(moveKey) {
      socket.sendPvpMoveChoice(pvpBattle.matchId, moveKey);
      pvpBattle.hasSubmitted = true;
      renderPvpMoveSelect();
    }
    for (const move of movesForSpecies(pvpBattle.selfSpeciesKey)) {
      pvpMoveSelectEl.appendChild(buildMoveOptionRow(move, pvpBattle.selfCombatant.pp[move.key], () => submit(move.key)));
    }
    const defendBtn = document.createElement("button");
    defendBtn.textContent = "Defend";
    defendBtn.style.fontSize = "11px";
    defendBtn.addEventListener("click", () => submit("defend"));
    pvpMoveSelectEl.appendChild(defendBtn);
  }

  // Called on pvp_match_start — builds the isolation dome + both players'
  // Glophimon rigs, same spatial layout startWildBattle uses (your own
  // Glophimon at BATTLE_PLAYER_MON_OFFSET, the opponent's at
  // BATTLE_WILD_OFFSET, both along the local player's current facing
  // line), minus the Glophiball pop-out intro animation — a cosmetic-only
  // simplification, not a functional one.
  function startPvpBattleScene(msg) {
    if (battle || teamBattle || pvpBattle) return;
    closeGlophimonMenuPanel();
    closeGlophimonStatsModal();

    const selfSpecies = SPECIES_BY_KEY[msg.self.species_key];
    const opponentSpecies = SPECIES_BY_KEY[msg.opponent.species_key];
    const selfCombatant = {
      name: msg.self.name, hp: msg.self.hp, maxHp: msg.self.max_hp, pp: { ...msg.self.pp },
    };
    const opponentCombatant = {
      name: msg.opponent.name, hp: msg.opponent.hp, maxHp: msg.opponent.max_hp, pp: { ...msg.opponent.pp },
    };

    const forwardX = Math.sin(local.facingAngle);
    const forwardZ = Math.cos(local.facingAngle);
    const centerX = local.x;
    const centerZ = local.z;
    const selfMonX = centerX + forwardX * BATTLE_PLAYER_MON_OFFSET;
    const selfMonZ = centerZ + forwardZ * BATTLE_PLAYER_MON_OFFSET;
    const opponentMonX = centerX + forwardX * BATTLE_WILD_OFFSET;
    const opponentMonZ = centerZ + forwardZ * BATTLE_WILD_OFFSET;

    const selfRig = buildBlockyCharacter(
      { head: selfSpecies.head_color, body: selfSpecies.body_color, arm: selfSpecies.arm_color, leg: selfSpecies.leg_color },
      selfCombatant.name,
    );
    selfRig.group.scale.setScalar(CREATURE_SCALE);
    selfRig.group.position.set(selfMonX, 0, selfMonZ);
    selfRig.group.rotation.y = local.facingAngle;
    scene.add(selfRig.group);

    const opponentRig = buildBlockyCharacter(
      { head: opponentSpecies.head_color, body: opponentSpecies.body_color, arm: opponentSpecies.arm_color, leg: opponentSpecies.leg_color },
      opponentCombatant.name,
    );
    opponentRig.group.scale.setScalar(CREATURE_SCALE);
    opponentRig.group.position.set(opponentMonX, 0, opponentMonZ);
    opponentRig.group.rotation.y = local.facingAngle + Math.PI;
    scene.add(opponentRig.group);

    const domeGeometry = new THREE.SphereGeometry(BATTLE_DOME_RADIUS, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    const domeMaterial = new THREE.MeshBasicMaterial({
      color: "#f472b6", transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false,
    });
    const domeMesh = new THREE.Mesh(domeGeometry, domeMaterial);
    domeMesh.position.set(centerX, 0, centerZ);
    scene.add(domeMesh);

    setLocalTransparent(true);
    const opponentPeer = peers.get(msg.opponent.user_id);
    if (opponentPeer) setPeerHidden(opponentPeer, true);

    pvpBattle = {
      matchId: msg.match_id,
      opponentUserId: msg.opponent.user_id,
      opponentDisplayName: msg.opponent.display_name,
      selfSpeciesKey: msg.self.species_key,
      opponentSpeciesKey: msg.opponent.species_key,
      selfOwnedId: getActiveLineup()[0]?.id ?? null,
      selfCombatant,
      opponentCombatant,
      selfRig,
      opponentRig,
      domeMesh,
      centerX,
      centerZ,
      midX: (selfMonX + opponentMonX) / 2,
      midZ: (selfMonZ + opponentMonZ) / 2,
      camAngle: local.facingAngle + BATTLE_CAM_ANGLE_OFFSET,
      hasSubmitted: false,
      opponentReady: false,
      ended: false,
    };

    pvpHudSelfEl.style.display = "block";
    pvpHudOpponentEl.style.display = "block";
    pvpBattlePanel.style.display = "block";
    pvpEndBannerEl.style.display = "none";
    pvpBattleLogEl.innerHTML = "";
    logPvpBattle(`A PVP battle against ${msg.opponent.display_name} has begun!`);
    updatePvpHpBars();
    renderPvpMoveSelect();
  }

  function applyPvpRoundResult(msg) {
    if (!pvpBattle || pvpBattle.matchId !== msg.match_id) return;
    pvpBattle.selfCombatant.hp = msg.self_hp;
    pvpBattle.selfCombatant.pp = { ...msg.self_pp };
    pvpBattle.opponentCombatant.hp = msg.opponent_hp;
    pvpBattle.opponentCombatant.pp = { ...msg.opponent_pp };
    for (const line of msg.log) logPvpBattle(line);
    updatePvpHpBars();
    pvpBattle.hasSubmitted = false;
    pvpBattle.opponentReady = false;
    if (msg.ended) {
      showPvpMatchEnd(msg.winner_user_id, "battle");
    } else {
      renderPvpMoveSelect();
    }
  }

  function showPvpMatchEnd(winnerUserId, reason) {
    if (!pvpBattle) return;
    pvpBattle.ended = true;
    pvpMoveSelectEl.innerHTML = "";
    pvpForfeitBtn.style.display = "none";
    let text;
    if (winnerUserId == null) {
      text = "Draw! Both Glophimon fainted at once.";
    } else if (winnerUserId === localUserId) {
      text = reason === "forfeit" ? "You won — your opponent forfeited."
        : reason === "disconnected" ? "Your opponent disconnected — you win!"
        : "You won the battle!";
    } else {
      text = reason === "forfeit" ? "You forfeited the battle." : reason === "disconnected" ? "Your opponent disconnected — you win!" : "You lost the battle.";
    }
    pvpEndTextEl.textContent = text;
    pvpEndBannerEl.style.display = "block";
  }

  function endPvpBattle() {
    if (!pvpBattle) return;
    if (pvpBattle.selfOwnedId != null) {
      const owned = menuData.glophimon.find((g) => g.id === pvpBattle.selfOwnedId);
      if (owned) owned.current_hp = Math.max(0, pvpBattle.selfCombatant.hp);
    }
    scene.remove(pvpBattle.selfRig.group);
    disposeRig(pvpBattle.selfRig);
    scene.remove(pvpBattle.opponentRig.group);
    disposeRig(pvpBattle.opponentRig);
    scene.remove(pvpBattle.domeMesh);
    pvpBattle.domeMesh.geometry.dispose();
    pvpBattle.domeMesh.material.dispose();
    setLocalTransparent(false);
    const opponentPeer = peers.get(pvpBattle.opponentUserId);
    if (opponentPeer) setPeerHidden(opponentPeer, false);
    pvpHudSelfEl.style.display = "none";
    pvpHudOpponentEl.style.display = "none";
    pvpBattlePanel.style.display = "none";
    pvpEndBannerEl.style.display = "none";
    pvpForfeitBtn.style.display = "inline-block";
    pvpBattle = null;
  }

  // The Luba lobby modal — rebuilt from scratch every time a fresh
  // luba_lobby_state arrives (see onSocketMessage), same "clear innerHTML,
  // rebuild fresh" convention as renderGlophimonMenuList/
  // renderGlophimonPcModal.
  function renderLubaLobbyModal() {
    lubaLobbyModalEl.style.display = lubaLobby ? "flex" : "none";
    if (!lubaLobby) return;

    lubaLobbyBodyEl.innerHTML = "";
    const isHost = localUserId === lubaLobby.host_id;

    const membersUl = document.createElement("ul");
    membersUl.style.listStyle = "none";
    membersUl.style.padding = "0";
    membersUl.style.margin = "0 0 6px 0";
    for (const member of lubaLobby.members) {
      const li = document.createElement("li");
      li.style.display = "flex";
      li.style.alignItems = "center";
      li.style.justifyContent = "space-between";
      li.style.gap = "4px";
      li.style.margin = "2px 0";
      const label = document.createElement("span");
      label.style.fontSize = "11px";
      label.style.flex = "1";
      const hostTag = member.user_id === lubaLobby.host_id ? " (Host)" : "";
      label.textContent = `${member.display_name}${hostTag} — ${member.status}`;
      li.appendChild(label);

      if (member.user_id === localUserId && member.status === "invited") {
        const acceptBtn = document.createElement("button");
        acceptBtn.textContent = "Accept";
        acceptBtn.style.fontSize = "10px";
        acceptBtn.addEventListener("click", () => socket.sendLubaRespond(lubaLobby.lobby_id, true));
        const rejectBtn = document.createElement("button");
        rejectBtn.textContent = "Reject";
        rejectBtn.style.fontSize = "10px";
        rejectBtn.addEventListener("click", () => socket.sendLubaRespond(lubaLobby.lobby_id, false));
        li.append(acceptBtn, rejectBtn);
      } else if (member.user_id === localUserId) {
        const readyBtn = document.createElement("button");
        readyBtn.textContent = member.status === "ready" ? "Unready" : "Ready";
        readyBtn.style.fontSize = "10px";
        readyBtn.addEventListener("click", () => socket.sendLubaReady(member.status !== "ready"));
        li.appendChild(readyBtn);
      } else if (isHost) {
        const kickBtn = document.createElement("button");
        kickBtn.textContent = "Kick";
        kickBtn.style.fontSize = "10px";
        kickBtn.addEventListener("click", () => socket.sendLubaKick(member.user_id));
        li.appendChild(kickBtn);
      }
      membersUl.appendChild(li);
    }
    lubaLobbyBodyEl.appendChild(membersUl);

    if (isHost && lubaLobby.members.length < LUBA_MAX_MEMBERS) {
      const inviteHeading = document.createElement("p");
      inviteHeading.style.fontSize = "10px";
      inviteHeading.style.color = "#a3a3a3";
      inviteHeading.style.margin = "4px 0 2px 0";
      inviteHeading.textContent = "Invite (nearby):";
      lubaLobbyBodyEl.appendChild(inviteHeading);

      // First-ever gameplay use of `peers` (previously render-only) — the
      // host's own local view of who's currently standing in the Luba
      // area. Re-checked server-side too (see main.py's own luba_invite
      // handler) since this local view could be stale.
      const memberIds = new Set(lubaLobby.members.map((m) => m.user_id));
      const eligible = [...peers.entries()].filter(
        ([userId, peer]) =>
          !memberIds.has(userId) &&
          Math.abs(peer.x - LUBA_X) <= LUBA_HALF &&
          Math.abs(peer.z - LUBA_Z) <= LUBA_HALF,
      );
      if (eligible.length === 0) {
        const noneP = document.createElement("p");
        noneP.style.fontSize = "10px";
        noneP.style.color = "#a3a3a3";
        noneP.style.margin = "0";
        noneP.textContent = "No one else is nearby.";
        lubaLobbyBodyEl.appendChild(noneP);
      } else {
        for (const [userId, peer] of eligible) {
          const inviteBtn = document.createElement("button");
          inviteBtn.textContent = `Invite ${peer.displayName}`;
          inviteBtn.style.fontSize = "10px";
          inviteBtn.style.display = "block";
          inviteBtn.style.width = "100%";
          inviteBtn.style.margin = "2px 0";
          inviteBtn.addEventListener("click", () => socket.sendLubaInvite(userId));
          lubaLobbyBodyEl.appendChild(inviteBtn);
        }
      }
    }

    if (isHost) {
      const allReady = lubaLobby.members.every((m) => m.status === "ready");
      const startBtn = document.createElement("button");
      startBtn.textContent = "Start";
      startBtn.style.fontSize = "11px";
      startBtn.style.display = "block";
      startBtn.style.width = "100%";
      startBtn.style.margin = "6px 0 0 0";
      startBtn.disabled = !allReady;
      startBtn.addEventListener("click", () => socket.sendLubaStart());
      lubaLobbyBodyEl.appendChild(startBtn);
    }
  }

  // The "Invite (nearby)" list only reflects `peers` at the moment
  // renderLubaLobbyModal last ran — a player who walks into the Luba area
  // afterward (with no lobby-state change of their own to trigger a
  // re-render) would otherwise never appear as invitable until something
  // else happened to redraw it. Throttled rather than done every frame —
  // rebuilding the whole modal 60 times a second for a list that only
  // needs to feel "live" would be wasteful. Only the host's own view has
  // an invite list at all, so there's nothing to refresh for anyone else.
  const LUBA_LOBBY_LIVE_REFRESH_MS = 1000;
  let lubaLobbyLiveRefreshElapsedMs = 0;
  function updateLubaLobbyLive(dt) {
    if (!lubaLobby || lubaLobby.host_id !== localUserId) return;
    lubaLobbyLiveRefreshElapsedMs += dt * 1000;
    if (lubaLobbyLiveRefreshElapsedMs < LUBA_LOBBY_LIVE_REFRESH_MS) return;
    lubaLobbyLiveRefreshElapsedMs = 0;
    renderLubaLobbyModal();
  }

  // Rebuilds every section of the popup from the current karirsRace/
  // karirsMyBet/karirsUnclaimedTotal — called once the authenticated
  // fetch in showKarraMenu resolves, and again after placing a bet or
  // claiming, so the popup never shows stale state.
  function refreshKarraMenu() {
    const race = karirsRace;
    karraRaceInfoEl.textContent = karirsStatusText(race);

    const canBet = !!race && race.status === "betting_open" && !karirsMyBet;
    karraBetSectionEl.style.display = canBet ? "block" : "none";
    if (canBet) {
      karraRacerButtonsEl.innerHTML = "";
      karraSelectedRacer = null;
      for (const name of race.racer_names) {
        const btn = document.createElement("button");
        btn.textContent = `${name} (${race.payout_multipliers[name]}x)`;
        btn.style.fontSize = "10px";
        btn.addEventListener("click", () => {
          karraSelectedRacer = name;
          [...karraRacerButtonsEl.children].forEach((b) => {
            b.style.outline = b === btn ? "2px solid #facc15" : "none";
          });
        });
        karraRacerButtonsEl.appendChild(btn);
      }
      karraWagerInput.max = String(menuData.inventory.g_coins);
    }

    if (karirsMyBet) {
      karraMyBetTextEl.style.display = "block";
      karraMyBetTextEl.textContent =
        karirsMyBet.payout == null
          ? `You bet ${karirsMyBet.wager} G on ${karirsMyBet.racer_name} — waiting for the race.`
          : karirsMyBet.payout > 0
            ? `${karirsMyBet.racer_name} won! You earned ${karirsMyBet.payout} G — claim it below.`
            : `${karirsMyBet.racer_name} didn't win this time.`;
    } else {
      karraMyBetTextEl.style.display = "none";
    }

    const canClaim = karirsUnclaimedTotal > 0;
    karraClaimSectionEl.style.display = canClaim ? "block" : "none";
    if (canClaim) karraClaimTextEl.textContent = `Claim ${karirsUnclaimedTotal} G?`;
  }

  function showKarraMenu(clientX, clientY) {
    const wrapRect = wrap.getBoundingClientRect();
    karraMenuEl.style.left = `${clientX - wrapRect.left}px`;
    karraMenuEl.style.top = `${clientY - wrapRect.top}px`;
    karraMenuEl.style.display = "block";
    karraRaceInfoEl.textContent = "Loading...";
    karraBetSectionEl.style.display = "none";
    karraMyBetTextEl.style.display = "none";
    karraClaimSectionEl.style.display = "none";
    // Fetched fresh every open, same convention the glophimon menu panel
    // already follows — my_bet/unclaimed_total are per-user and never
    // ride along on the shared broadcast every player receives.
    Promise.resolve(ctx.onKarirsFetchState?.()).then((state) => {
      if (!state || karraMenuEl.style.display === "none") return; // closed while the fetch was in flight
      karirsRace = state.race;
      karirsMyBet = state.my_bet;
      karirsUnclaimedTotal = state.unclaimed_total;
      karirsPreviousRace = state.previous_race ?? null;
      refreshKarraMenu();
    });
  }

  function hideKarirsTvMenu() {
    karirsTvMenuEl.style.display = "none";
  }

  // The shared "per-racer progress bars + status line" view — used for
  // both the live race and the previous-race replay (see
  // renderKarirsTvContent); the only difference between the two call
  // sites is which race object and which already-clamped stepIndex get
  // passed in.
  function renderKarirsRaceProgress(race, stepIndex) {
    const positions = race.steps[stepIndex].positions;
    const finished = stepIndex >= race.steps.length - 1;
    for (const name of race.racer_names) {
      const row = document.createElement("div");
      row.style.margin = "3px 0";
      const label = document.createElement("div");
      label.style.fontSize = "10px";
      label.textContent = name;
      row.appendChild(label);
      const barOuter = document.createElement("div");
      barOuter.style.background = "#3333334d";
      barOuter.style.borderRadius = "3px";
      barOuter.style.height = "6px";
      barOuter.style.overflow = "hidden";
      const barFill = document.createElement("div");
      barFill.style.width = `${Math.max(0, Math.min(100, positions[name]))}%`;
      barFill.style.height = "100%";
      barFill.style.background = finished && name === race.winning_name ? "#facc15" : "#4ade80";
      barOuter.appendChild(barFill);
      row.appendChild(barOuter);
      karirsTvContentEl.appendChild(row);
    }
    const statusMsg = document.createElement("p");
    statusMsg.style.margin = "4px 0 0 0";
    statusMsg.textContent = finished ? `${race.winning_name} wins!` : "Racing...";
    karirsTvContentEl.appendChild(statusMsg);
  }

  // Rebuilds the TV's content — a countdown while betting is open, or a
  // simplified live view (per-racer progress bars) once a race has
  // started, replayed locally against started_at exactly the way
  // games/karirs' own client does. Called once on open and then every
  // frame the popup stays visible (see updateKarirsTvPopup) since both a
  // countdown and a live race are constantly changing. karirsTvShowingPreview
  // (toggled by karirsTvPreviewBtn) swaps the whole view over to a replay
  // of karirsPreviousRace instead, stepped against a local start time
  // rather than the race's own real started_at.
  function renderKarirsTvContent() {
    karirsTvContentEl.innerHTML = "";

    karirsTvPreviewBtn.style.display = karirsPreviousRace ? "inline-block" : "none";
    karirsTvPreviewBtn.textContent = karirsTvShowingPreview ? "◀ Back to Live" : "▶ Watch Previous Race";

    if (karirsTvShowingPreview && karirsPreviousRace) {
      const race = karirsPreviousRace;
      if (!race.steps || race.steps.length === 0) {
        karirsTvContentEl.textContent = "No replay available.";
        return;
      }
      const label = document.createElement("p");
      label.style.margin = "0 0 4px 0";
      label.style.fontSize = "11px";
      label.style.color = "#a3a3a3";
      label.textContent = "Previous race replay:";
      karirsTvContentEl.appendChild(label);
      const stepIndex = Math.max(
        0,
        Math.min(race.steps.length - 1, Math.floor((Date.now() - karirsPreviewStartedAt) / KARIRS_STEP_DELAY_MS)),
      );
      renderKarirsRaceProgress(race, stepIndex);
      return;
    }

    const race = karirsRace;
    if (!race) {
      karirsTvContentEl.textContent = "No signal yet.";
      return;
    }

    if (race.status === "betting_open") {
      const closesAt = new Date(`${race.betting_closes_at}Z`).getTime();
      const p = document.createElement("p");
      p.style.margin = "2px 0";
      p.textContent = `Next race starts in ${formatCountdown(closesAt - Date.now())}`;
      karirsTvContentEl.appendChild(p);
      const list = document.createElement("p");
      list.style.margin = "4px 0 0 0";
      list.style.fontSize = "11px";
      list.style.color = "#a3a3a3";
      list.textContent = race.racer_names.map((n) => `${n} (${race.payout_multipliers[n]}x)`).join(", ");
      karirsTvContentEl.appendChild(list);
      return;
    }

    if (!race.steps || race.steps.length === 0) {
      karirsTvContentEl.textContent = "Warming up...";
      return;
    }
    const startedAt = new Date(`${race.started_at}Z`).getTime();
    const stepIndex = Math.max(0, Math.min(race.steps.length - 1, Math.floor((Date.now() - startedAt) / KARIRS_STEP_DELAY_MS)));
    renderKarirsRaceProgress(race, stepIndex);
  }

  karirsTvPreviewBtn.addEventListener("click", () => {
    if (karirsTvShowingPreview) {
      karirsTvShowingPreview = false;
    } else if (karirsPreviousRace) {
      karirsTvShowingPreview = true;
      karirsPreviewStartedAt = Date.now(); // (re)starts the replay from the beginning every time this is clicked
    }
    renderKarirsTvContent();
  });

  function showKarirsTvMenu(clientX, clientY) {
    const wrapRect = wrap.getBoundingClientRect();
    karirsTvMenuEl.style.left = `${clientX - wrapRect.left}px`;
    karirsTvMenuEl.style.top = `${clientY - wrapRect.top}px`;
    karirsTvMenuEl.style.display = "block";
    karirsTvShowingPreview = false; // always opens on the live/countdown view, not mid-replay
    renderKarirsTvContent();
  }

  // Called every frame from frame() itself (not just on open) — a no-op
  // whenever the popup isn't visible.
  function updateKarirsTvPopup() {
    if (karirsTvMenuEl.style.display === "none") return;
    renderKarirsTvContent();
  }

  function onCanvasClick(event) {
    // A drag that happened to pass over Rodz shouldn't pop the menu,
    // and Rodz can't be clicked while any battle already owns the
    // scene/camera.
    if (draggedPastThreshold || battle || teamBattle || pvpBattle) return;
    const rect = canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(mouse, camera);

    const rodzHits = raycaster.intersectObject(rodzRig.group, true);
    // Same proximity rule every NPC/player interaction in this game
    // follows (see INTERACTION_RANGE) — clicking Rodz from across the map
    // does nothing at all, same as clicking empty ground would.
    const rodzInRange = Math.hypot(local.x - RODZ_X, local.z - RODZ_Z) <= INTERACTION_RANGE;
    if (rodzHits.length > 0 && rodzInRange) {
      showRodzMenu(event.clientX, event.clientY);
      return;
    }
    hideRodzMenu();

    const karraHits = raycaster.intersectObject(karraRig.group, true);
    const karraInRange = Math.hypot(local.x - KARRA_X, local.z - KARRA_Z) <= INTERACTION_RANGE;
    if (karraHits.length > 0 && karraInRange) {
      showKarraMenu(event.clientX, event.clientY);
      return;
    }
    hideKarraMenu();

    const tvHits = raycaster.intersectObject(karirsTvGroup, true);
    const tvInRange = Math.hypot(local.x - KARIRS_TV_X, local.z - KARIRS_TV_Z) <= INTERACTION_RANGE;
    if (tvHits.length > 0 && tvInRange) {
      showKarirsTvMenu(event.clientX, event.clientY);
      return;
    }
    hideKarirsTvMenu();

    const jaredHits = raycaster.intersectObject(jaredRig.group, true);
    const jaredInRange = Math.hypot(local.x - JARED_X, local.z - JARED_Z) <= INTERACTION_RANGE;
    if (jaredHits.length > 0 && jaredInRange) {
      showJaredMenu(event.clientX, event.clientY);
      return;
    }
    hideJaredMenu();

    const bossRickHits = raycaster.intersectObject(bossRickRig.group, true);
    const bossRickInRange = Math.hypot(local.x - BOSS_RICK_X, local.z - BOSS_RICK_Z) <= INTERACTION_RANGE;
    if (bossRickHits.length > 0 && bossRickInRange) {
      showBossRickMenu(event.clientX, event.clientY);
      return;
    }
    hideBossRickMenu();

    // The two chess tables — same raycast shape as every NPC/prop above,
    // but the range gate itself depends on that board's own state: a plain
    // proximity check for an empty/waiting board (must walk right up to
    // host/join), or "anywhere inside Chessdom" once a game is actually
    // in_progress (so a spectator can click it from across the yard) —
    // mirrors the exact same OR'd-in condition the highlight updaters use.
    const board1Hits = raycaster.intersectObject(chessBoard1Group, true);
    const board1Clickable = chessBoards[1].status === "in_progress"
      ? isInsideTambayan(local.x, local.z)
      : Math.hypot(local.x - CHESS_BOARD_1_X, local.z - CHESS_BOARD_1_Z) <= INTERACTION_RANGE;
    if (board1Hits.length > 0 && board1Clickable) {
      onChessBoardClick(1, event.clientX, event.clientY);
      return;
    }
    const board2Hits = raycaster.intersectObject(chessBoard2Group, true);
    const board2Clickable = chessBoards[2].status === "in_progress"
      ? isInsideTambayan(local.x, local.z)
      : Math.hypot(local.x - CHESS_BOARD_2_X, local.z - CHESS_BOARD_2_Z) <= INTERACTION_RANGE;
    if (board2Hits.length > 0 && board2Clickable) {
      onChessBoardClick(2, event.clientX, event.clientY);
      return;
    }
    hideChessHostMenu();
    hideChessJoinMenu();

    // Other connected players — same raycast+proximity shape as every NPC
    // above, just iterated over whoever's currently nearby instead of one
    // fixed rig. Whichever peer's rig is actually hit wins; ties (two
    // overlapping peers) aren't a real concern at this game's scale.
    for (const [userId, peer] of peers.entries()) {
      const peerHits = raycaster.intersectObject(peer.rig.group, true);
      const peerInRange = Math.hypot(local.x - peer.x, local.z - peer.z) <= INTERACTION_RANGE;
      if (peerHits.length > 0 && peerInRange) {
        showPlayerOptionsMenu(userId, peer, event.clientX, event.clientY);
        return;
      }
    }
    hidePlayerOptionsMenu();
  }
  canvas.addEventListener("click", onCanvasClick);

  rodzHealBtn.addEventListener("click", () => {
    const needsHeal = playerHp < PLAYER_MAX_HP || anyGlophimonNeedsHealing();
    if (!needsHeal) return; // stale click on an already-answered popup — ignore
    setPlayerHp(PLAYER_MAX_HP);
    // Same "mutate the local reference, then fire-and-forget persist" idea
    // as syncOwnedGlophimonHp — menuData.glophimon rows are the same
    // objects the menu panel/stats modal already read from.
    const updates = menuData.glophimon.map((g) => {
      const full = maxHpFor(g.level);
      g.current_hp = full;
      return { id: g.id, current_hp: full };
    });
    if (updates.length > 0) ctx.onSetGlophimonHp?.(updates);
    hideRodzMenu();
  });
  rodzCancelBtn.addEventListener("click", hideRodzMenu);

  rodzClaimBtn.addEventListener("click", () => {
    // This click IS the ask — Rodz only ever answers (grants it, or scolds
    // for asking twice) once the player has actually requested it, never
    // proactively the instant the popup opens (see refreshRodzClaimSection).
    if (!menuData.inventory.daily_claim_available) {
      rodzClaimTextEl.textContent = "Don't be greedy, you already claimed your Glophiballs.";
      rodzClaimTextEl.style.display = "block";
      return;
    }
    // Optimistic/local, same trust level as the Glophiball-spend flow —
    // ctx.onClaimDaily persists it and refreshes menuData for real via
    // the normal glophimon.menu round-trip.
    menuData.inventory.glophiballs += DAILY_CLAIM_GLOPHIBALLS;
    menuData.inventory.daily_claim_available = false;
    hideRodzMenu();
    ctx.onClaimDaily?.();
  });

  karraPlaceBetBtn.addEventListener("click", () => {
    if (!karraSelectedRacer) return;
    const wager = Math.max(1, Math.floor(Number(karraWagerInput.value) || 0));
    if (wager > menuData.inventory.g_coins) return;
    karraPlaceBetBtn.disabled = true;
    Promise.resolve(ctx.onKarirsPlaceBet?.(karraSelectedRacer, wager)).then((result) => {
      karraPlaceBetBtn.disabled = false;
      if (!result || !result.ok) return; // rejected server-side (e.g. betting just closed) — leave the section open to retry
      // Optimistic/local, same trust level as every other spend in this
      // file — the real deduction already happened server-side by the
      // time this resolves.
      menuData.inventory.g_coins -= wager;
      karirsMyBet = result.bet;
      refreshKarraMenu();
    });
  });
  karraClaimBtn.addEventListener("click", () => {
    karraClaimBtn.disabled = true;
    Promise.resolve(ctx.onKarirsClaim?.()).then((result) => {
      karraClaimBtn.disabled = false;
      if (!result || !result.ok) return;
      menuData.inventory.g_coins = result.g_coins;
      karirsUnclaimedTotal = 0;
      if (karirsMyBet) karirsMyBet.claimed = true;
      refreshKarraMenu();
    });
  });
  karraCancelBtn.addEventListener("click", hideKarraMenu);
  karirsTvCloseBtn.addEventListener("click", hideKarirsTvMenu);

  jaredBuyBtn.addEventListener("click", () => {
    const quantity = Math.max(1, Math.floor(Number(jaredQtyInput.value) || 0));
    const cost = quantity * GLOPHIBALL_SHOP_PRICE_G;
    jaredMessageEl.style.color = "#f87171";
    if (cost > menuData.inventory.g_coins) {
      jaredMessageEl.textContent = "Not enough G-coins.";
      jaredMessageEl.style.display = "block";
      return;
    }
    jaredBuyBtn.disabled = true;
    Promise.resolve(ctx.onShopBuy?.("glophiball", quantity)).then((result) => {
      jaredBuyBtn.disabled = false;
      if (!result || !result.ok) {
        jaredMessageEl.textContent = "Purchase failed — try again.";
        jaredMessageEl.style.display = "block";
        return;
      }
      // Real, authoritative inventory from the server (not just an
      // optimistic local bump) — same trust level as Rodz's daily claim
      // round-trip, since a purchase actually changes two balances at
      // once (glophiballs up, g_coins down).
      menuData.inventory = result.inventory;
      jaredMessageEl.style.color = "#4ade80";
      jaredMessageEl.textContent = `Bought ${quantity} Glophiball${quantity > 1 ? "s" : ""}!`;
      jaredMessageEl.style.display = "block";
    });
  });
  jaredCancelBtn.addEventListener("click", hideJaredMenu);

  const pressed = new Set();
  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
  }
  function onKeyDown(event) {
    if (isTypingTarget(event.target)) return;
    // Enter opens (and focuses) the chat box instead of ever being treated
    // as a movement key — chatInputEl's own keydown listener handles the
    // second Enter (submit) and stopPropagates it, so this branch is only
    // ever reached while the box is closed. No battle guard needed beyond
    // that: nothing chat-related is reachable via any battle UI anyway.
    if (event.code === "Enter") {
      openChatBox();
      return;
    }
    pressed.add(event.code);
  }
  function onKeyUp(event) {
    pressed.delete(event.code);
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  let lastWidth = 0;
  let lastHeight = 0;
  let lastFrameTime = performance.now();
  let lastNetworkTickAt = 0;
  let rafId = 0;
  let disposed = false;

  function onSocketMessage(msg) {
    if (msg.type === "self") {
      localUserId = msg.user_id;
    } else if (msg.type === "roster") {
      for (const p of msg.players) ensurePeer(p.user_id, p.display_name, p, p.x, p.z, p.facing);
      status.textContent = `Connected as ${character.display_name}`;
    } else if (msg.type === "joined") {
      ensurePeer(msg.user_id, msg.display_name, msg, msg.x, msg.z, msg.facing);
    } else if (msg.type === "position") {
      const peer = peers.get(msg.user_id);
      if (!peer) return;
      peer.targetX = msg.x;
      peer.targetZ = msg.z;
      peer.targetFacing = msg.facing;
      peer.isMoving = Math.hypot(msg.x - peer.x, msg.z - peer.z) > 0.01;
    } else if (msg.type === "left") {
      removePeer(msg.user_id);
    } else if (msg.type === "chat") {
      // Always about someone ELSE — the api's own broadcast excludes the
      // sender's own socket, same convention wild_engaged/wild_released
      // already follow, since the sender already showed its own bubble
      // optimistically the instant it hit Enter (see chatInputEl's own
      // keydown listener).
      const peer = peers.get(msg.user_id);
      if (peer) showChatBubbleFor(peer, peer.displayName, msg.text);
    } else if (msg.type === "wild_roster") {
      for (const w of msg.wilds) ensureWildSpawn(w.id, w.species_key, w.level, w.x, w.z, w.facing, w.engaged_by != null);
    } else if (msg.type === "wild_spawn") {
      ensureWildSpawn(msg.id, msg.species_key, msg.level, msg.x, msg.z, msg.facing, false);
    } else if (msg.type === "wild_despawn") {
      removeWildSpawn(msg.id);
    } else if (msg.type === "wild_tick") {
      for (const u of msg.updates) {
        const spawn = wildSpawns.get(u.id);
        if (!spawn) continue;
        spawn.targetX = u.x;
        spawn.targetZ = u.z;
        spawn.targetFacing = u.facing;
        spawn.isMoving = u.moving;
      }
    } else if (msg.type === "wild_engaged") {
      // Always about someone ELSE — the api's own broadcast excludes the
      // engaging player's own socket, since that player already knows the
      // outcome directly from its own /wild/{id}/engage response (see
      // checkWildContact) and has already removed it from its own
      // wildSpawns entirely by this point.
      const spawn = wildSpawns.get(msg.id);
      if (spawn) {
        spawn.engagedByOther = true;
        setRigTransparent(spawn.rig, true);
      }
    } else if (msg.type === "wild_released") {
      const spawn = wildSpawns.get(msg.id);
      if (spawn) {
        spawn.engagedByOther = false;
        setRigTransparent(spawn.rig, false);
      }
    } else if (msg.type === "karirs_state") {
      karirsRace = msg.race;
      karirsPreviousRace = msg.previous_race ?? null;
      if (msg.last_winner) updateKarirsBoardText(karirsBoard, `${msg.last_winner} won the last race!`);
    } else if (msg.type === "karirs_race_created" || msg.type === "karirs_race_started") {
      karirsRace = msg.race;
    } else if (msg.type === "karirs_race_resolved") {
      karirsRace = msg.race;
      // The race that just resolved is now the "previous race" everyone's
      // TV can replay on demand, right up until the next one finishes too.
      karirsPreviousRace = msg.race;
      updateKarirsBoardText(karirsBoard, `${karirsRace.winning_name} won the last race!`);
    } else if (msg.type === "luba_lobby_state") {
      lubaLobby = msg;
      renderLubaLobbyModal();
    } else if (msg.type === "luba_lobby_closed") {
      lubaLobby = null;
      renderLubaLobbyModal();
    } else if (msg.type === "luba_error") {
      showLubaError(msg.reason);
    } else if (msg.type === "luba_start_ack") {
      // The real Luba match is already configured server-side by now (see
      // the api's own luba_start handler) — everything a cross-game mount
      // needs is already sitting in client state from luba_lobby_state/
      // self, no extra round-trip required. chat.js owns the actual
      // hide-Glophimon/mount-Luba handoff (see its own onLubaMatchReady) —
      // no other game's mount has ever been called from inside this one
      // before, so that orchestration deliberately stays outside game.js.
      const participants = lubaLobby ? lubaLobby.members : [];
      const hostId = lubaLobby ? lubaLobby.host_id : null;
      lubaLobby = null;
      ctx.onLubaMatchReady?.({ lobbyId: msg.lobby_id, participants, hostId, selfId: localUserId });
    } else if (msg.type === "pvp_invite_sent") {
      outgoingPvpInvite = { inviteId: msg.invite_id, toUserId: msg.to_user_id, toDisplayName: msg.to_display_name };
      if (playerOptionsMenuUserId === msg.to_user_id) renderPlayerOptionsMenu();
    } else if (msg.type === "pvp_invite_received") {
      if (battle || teamBattle || pvpBattle) {
        // Busy — the cheap client-side half of "can't invite/be invited
        // mid-fight" (see the plan's own noted Stage 1 limitation: the
        // server has no idea a battle is happening at all).
        socket.sendPvpRespond(msg.invite_id, false);
      } else {
        incomingPvpInvite = { inviteId: msg.invite_id, fromUserId: msg.from_user_id, fromDisplayName: msg.from_display_name };
        showPvpInviteBanner(msg.from_display_name);
      }
    } else if (msg.type === "pvp_declined") {
      if (outgoingPvpInvite && outgoingPvpInvite.inviteId === msg.invite_id) {
        outgoingPvpInvite = null;
        if (playerOptionsMenuUserId != null) renderPlayerOptionsMenu();
      }
      if (incomingPvpInvite && incomingPvpInvite.inviteId === msg.invite_id) {
        hidePvpInviteBanner();
      }
    } else if (msg.type === "pvp_match_start") {
      // Stage 2 — replaces Stage 1's pvp_match_ack placeholder entirely.
      outgoingPvpInvite = null;
      incomingPvpInvite = null;
      hidePvpInviteBanner();
      hidePlayerOptionsMenu();
      startPvpBattleScene(msg);
    } else if (msg.type === "pvp_opponent_ready") {
      if (pvpBattle && pvpBattle.matchId === msg.match_id) {
        pvpBattle.opponentReady = true;
        if (!pvpBattle.hasSubmitted) renderPvpMoveSelect();
      }
    } else if (msg.type === "pvp_round_result") {
      applyPvpRoundResult(msg);
    } else if (msg.type === "pvp_match_end") {
      if (pvpBattle && pvpBattle.matchId === msg.match_id) {
        pvpBattle.selfCombatant.hp = msg.self_hp;
        pvpBattle.opponentCombatant.hp = msg.opponent_hp;
        updatePvpHpBars();
        showPvpMatchEnd(msg.winner_user_id, msg.reason);
      }
    } else if (msg.type === "pvp_error") {
      // A failed match start (no_active_glophimon/active_glophimon_fainted)
      // arrives after the invite is already consumed server-side (the
      // accept branch clears it before ever trying to start the match) —
      // so both sides' own invite state needs clearing here too, or the
      // inviter's popup would be stuck showing "Cancel" forever with
      // nothing left server-side to actually cancel.
      outgoingPvpInvite = null;
      incomingPvpInvite = null;
      hidePvpInviteBanner();
      if (playerOptionsMenuUserId != null) renderPlayerOptionsMenu();
      showPvpError(msg.reason);
    } else if (msg.type === "chess_state") {
      const board = {
        status: msg.status,
        hostId: msg.host_id,
        hostDisplayName: msg.host_display_name,
        whiteUserId: msg.white_user_id,
        whiteDisplayName: msg.white_display_name,
        blackUserId: msg.black_user_id,
        blackDisplayName: msg.black_display_name,
        fen: msg.fen,
        turn: msg.turn,
        moveHistory: msg.move_history,
        outcome: msg.outcome ? { winnerUserId: msg.outcome.winner_user_id, reason: msg.outcome.reason } : null,
      };
      chessBoards[msg.board_id] = board;
      updateChessBoardSign(msg.board_id, board);
      // The game ended some other way (checkmate/resign/opponent
      // disconnected) while a leave-warning was still up — it no longer
      // applies.
      if (board.outcome) hideChessLeaveWarning();

      if (board.status === "waiting" && board.hostId === localUserId) {
        myHostedChessBoardId = msg.board_id;
        chessWaitingModalEl.style.display = "flex";
        renderChessWaitingModal();
      } else if (myHostedChessBoardId === msg.board_id) {
        // Moved on from "waiting" (someone joined, host cancelled from
        // elsewhere, or a disconnect reset it) — my own waiting view no
        // longer applies.
        myHostedChessBoardId = null;
        hideChessWaitingModal();
      }

      // outcome must still be null — otherwise a player reconnecting (even
      // in an unrelated new session) after their own game already finished
      // but before the board's own delayed reset fires (see main.py's own
      // CHESS_BOARD_RESET_DELAY_S) would have this stale finished match
      // auto-popped open as a full-screen modal the instant they join,
      // silently blocking every other click on the canvas underneath it.
      const isNewActiveGameIAmIn = board.status === "in_progress" && !board.outcome &&
        (board.whiteUserId === localUserId || board.blackUserId === localUserId);
      if (isNewActiveGameIAmIn && (!activeChessMatch || activeChessMatch.boardId !== msg.board_id)) {
        // The actual "the game commences in a modal" moment for both the
        // host and the joiner — neither ever clicks anything to open it
        // themselves, it just appears once the server confirms the match.
        showChessMatchModal(msg.board_id, false);
      } else if (activeChessMatch && activeChessMatch.boardId === msg.board_id) {
        if (board.status === "empty") {
          // The table auto-clears itself a while after a finished game (see
          // main.py's own CHESS_BOARD_RESET_DELAY_S) — if this modal is
          // still open at that point, just close it rather than re-render
          // into a half-empty "board reset mid-view" state.
          hideChessMatchModal();
        } else {
          activeChessMatch.selectedSquare = null;
          renderChessMatchModal();
        }
      }
    } else if (msg.type === "chess_error") {
      showChessError(msg.reason);
    } else if (msg.type === "chess_leave_warning") {
      showChessLeaveWarning(msg.seconds);
    } else if (msg.type === "chess_leave_cancelled") {
      hideChessLeaveWarning();
    } else if (msg.type === "rejected") {
      const reasons = {
        no_character: "No character found — create one first.",
        already_in_world: "You're already connected in another window.",
        unauthorized: "Not logged in.",
      };
      status.textContent = reasons[msg.reason] || `Could not join (${msg.reason}).`;
      ctx.onRejected?.();
    } else if (msg.type === "_disconnected") {
      status.textContent = "Disconnected from Glophimon.";
    } else if (msg.type === "_error") {
      status.textContent = `Error: ${msg.message}`;
    }
  }

  const socket = connectGlophimonSocket(onSocketMessage);

  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    // Camera-relative movement — same derivation as GL Sims World's own
    // game.js (see that file's own comment for the full reasoning): in
    // Auto mode camAngle stays DEFAULT_CAM_ANGLE (0), reducing this to a
    // fixed -Z-forward mapping; only Manual mode actually rotates with the
    // drag. Suppressed entirely while battling — the player can't wander
    // off mid-fight (see startWildBattle's own comment on why the dome
    // isn't a real collision wall: this is simpler and sufficient).
    if (battle || teamBattle || pvpBattle) {
      local.isMoving = false;
      applyIdlePose(local.rig, dt);
    } else {
      const forwardX = -Math.sin(camAngle);
      const forwardZ = -Math.cos(camAngle);
      const rightX = Math.cos(camAngle);
      const rightZ = -Math.sin(camAngle);
      let moveForward = 0;
      let moveStrafe = 0;
      if (pressed.has("KeyW") || pressed.has("ArrowUp")) moveForward += 1;
      if (pressed.has("KeyS") || pressed.has("ArrowDown")) moveForward -= 1;
      if (pressed.has("KeyA") || pressed.has("ArrowLeft")) moveStrafe -= 1;
      if (pressed.has("KeyD") || pressed.has("ArrowRight")) moveStrafe += 1;
      let moveX = forwardX * moveForward + rightX * moveStrafe;
      let moveZ = forwardZ * moveForward + rightZ * moveStrafe;
      const moveLen = Math.hypot(moveX, moveZ);
      local.isMoving = moveLen > 0.001;
      const wantsSprint = local.isMoving && (pressed.has("ShiftLeft") || pressed.has("ShiftRight")) && !staminaExhausted && stamina > 0;
      const speedMult = wantsSprint ? SPRINT_SPEED_MULTIPLIER : 1;
      if (local.isMoving) {
        moveX /= moveLen;
        moveZ /= moveLen;
        const step = MOVE_SPEED * speedMult * dt;
        const nextX = Math.min(ARENA_HALF_X, Math.max(-ARENA_HALF_X, local.x + moveX * step));
        const nextZ = Math.min(ARENA_HALF_Z, Math.max(-ARENA_HALF_Z, local.z + moveZ * step));
        // Resolved per axis rather than as one combined point, so brushing
        // a wall at an angle slides you along it instead of freezing
        // movement outright — same idea real 2D/3D collision sliding uses.
        if (!isInsideTownWalls(nextX, local.z) && !isInsideTambayanWalls(nextX, local.z)) local.x = nextX;
        if (!isInsideTownWalls(local.x, nextZ) && !isInsideTambayanWalls(local.x, nextZ)) local.z = nextZ;
        local.facingAngle = Math.atan2(moveX, moveZ);
        updateWalkCycle(local.rig, dt, speedMult);
      } else {
        applyIdlePose(local.rig, dt);
      }
      if (wantsSprint) {
        stamina = Math.max(0, stamina - STAMINA_DRAIN_PER_SEC * dt);
        if (stamina <= 0) staminaExhausted = true;
      } else {
        stamina = Math.min(STAMINA_MAX, stamina + STAMINA_REGEN_PER_SEC * dt);
        if (staminaExhausted && stamina >= STAMINA_MAX) staminaExhausted = false;
      }
    }
    updateStaminaBar();
    updateGCoinsHud();
    local.rig.group.position.set(local.x, local.y, local.z);
    local.rig.group.rotation.y = local.facingAngle;
    syncNameLabel(local.rig);
    updateChatBubble(local);

    // Rodz just stands there idling (breathing included) regardless
    // of anything else going on — it's clickable at all times except
    // during a battle (see onCanvasClick's own guard).
    applyIdlePose(rodzRig, dt);
    syncNameLabel(rodzRig);
    updateRodzShout(dt);
    updateRodzHighlight(dt);

    applyIdlePose(karraRig, dt);
    syncNameLabel(karraRig);
    updateKarirsTvPopup();
    updateCarrinHighlight(dt);

    applyIdlePose(jaredRig, dt);
    syncNameLabel(jaredRig);
    updateJaredHighlight(dt);

    applyIdlePose(bossRickRig, dt);
    syncNameLabel(bossRickRig);
    updateBossRickHighlight(dt);
    updateLubaLobbyLive(dt);
    updateChessBoard1Highlight(dt);
    updateChessBoard2Highlight(dt);

    for (const peer of peers.values()) {
      const ease = Math.min(1, 12 * dt);
      peer.x += (peer.targetX - peer.x) * ease;
      peer.z += (peer.targetZ - peer.z) * ease;
      peer.facingAngle = peer.targetFacing;
      if (peer.isMoving) updateWalkCycle(peer.rig, dt);
      else applyIdlePose(peer.rig, dt);
      peer.rig.group.position.set(peer.x, peer.y, peer.z);
      peer.rig.group.rotation.y = peer.facingAngle;
      syncNameLabel(peer.rig);
      updateChatBubble(peer);
      peer.updateHighlight(dt);
      // "Anyone who tries to enter this field will not be seen inside" —
      // a purely local rendering filter on this client only, not a
      // networked exclusion (see startWildBattle's own comment).
      if (battle) {
        const dist = Math.hypot(peer.x - battle.centerX, peer.z - battle.centerZ);
        setPeerHidden(peer, dist <= BATTLE_DOME_RADIUS);
      } else if (teamBattle) {
        const dist = Math.hypot(peer.x - teamBattle.centerX, peer.z - teamBattle.centerZ);
        setPeerHidden(peer, dist <= TEAM_DOME_RADIUS);
      }
    }

    updateWildSpawns(dt);
    checkWildContact();
    renderMinimap();

    if (battle) {
      // Every one of your team's members can independently be attacking,
      // defending, or just idling this frame (see resolvePlayerAttack/
      // resolveWildAttack) — each has its own anim field, same per-member
      // shape as the 3v3 battle's own team members.
      for (const member of battle.playerTeam) {
        updateBattleRigAnim(member, "anim", member.rig, dt);
        updateTargetFlash(member.rig, dt);
        syncNameLabel(member.rig);
      }
      updateBattleRigAnim(battle, "wildAnim", battle.wildRig, dt);
      updateTargetFlash(battle.wildRig, dt);
      if (battle.wildRig.group.visible) syncNameLabel(battle.wildRig); // hidden mid-catch (sucked into the ball) — no label to sync while invisible
      // Last — these can change battle state outright (the intro finishing
      // starts the first real round; a successful catch ends the battle
      // and nulls `battle`) — nothing below this line touches `battle`
      // again this frame, so it's safe for either to happen here.
      updateIntroAnim(dt);
      updateCatchAnim(dt);
    } else if (teamBattle) {
      for (const team of teamBattle.teams) {
        for (const m of team.members) {
          updateBattleRigAnim(m, "anim", m.rig, dt);
          updateTargetFlash(m.rig, dt);
          syncNameLabel(m.rig);
        }
      }
      applyIdlePose(teamBattle.npcTrainerRig, dt);
      syncNameLabel(teamBattle.npcTrainerRig);
    }

    if (now - lastNetworkTickAt >= NETWORK_TICK_MS) {
      lastNetworkTickAt = now;
      socket.sendPosition(local.x, local.z, local.facingAngle);
    }

    const width = canvas.clientWidth || canvas.getBoundingClientRect().width;
    const height = canvas.clientHeight || canvas.getBoundingClientRect().height;
    if (width > 0 && height > 0 && (width !== lastWidth || height !== lastHeight)) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      lastWidth = width;
      lastHeight = height;
    }

    if (battle) {
      if (battle.introAnim && battle.introAnim.camX !== undefined) {
        // "arrive" phase only (dome/spawn don't touch the camera at all) —
        // eased continuously by updateIntroAnim from the wide intro framing
        // to the exact spot beginRound's own focus will land on, so there's
        // no visible snap once the animation hands off.
        camera.position.set(battle.introAnim.camX, battle.introAnim.camY, battle.introAnim.camZ);
        camera.lookAt(battle.introAnim.lookX, battle.introAnim.lookY, battle.introAnim.lookZ);
      } else if (battle.catchAnim) {
        // Eased continuously by updateCatchAnim rather than snapped —
        // see its own comment for the zoom-in/pull-out target logic.
        camera.position.set(battle.catchAnim.camX, battle.catchAnim.camY, battle.catchAnim.camZ);
        camera.lookAt(battle.catchAnim.lookX, battle.catchAnim.lookY, battle.catchAnim.lookZ);
      } else if (battle.focus) {
        // Close behind your own Glophimon — see focusWildCameraOnRig,
        // called every round by beginRound. Same raised, angled-down
        // framing as the 3v3 battle's own focus camera.
        camera.position.set(battle.focus.camX, TEAM_FOCUS_CAM_HEIGHT, battle.focus.camZ);
        camera.lookAt(battle.focus.lookX, TEAM_FOCUS_CAM_LOOK_Y, battle.focus.lookZ);
      } else {
        // Fallback wide framing — not normally reached (beginRound always
        // sets a focus before the first frame renders), kept as a safe
        // default only. Drifts slowly like a satellite rather than sitting
        // at a fixed angle, same as teamBattle's own reset framing below.
        battle.camAngle += RESET_CAM_ORBIT_SPEED * dt;
        camera.position.set(
          battle.midX + Math.sin(battle.camAngle) * Math.cos(BATTLE_CAM_ELEVATION) * BATTLE_CAM_RADIUS,
          PAN_TARGET_Y + Math.sin(BATTLE_CAM_ELEVATION) * BATTLE_CAM_RADIUS,
          battle.midZ + Math.cos(battle.camAngle) * Math.cos(BATTLE_CAM_ELEVATION) * BATTLE_CAM_RADIUS,
        );
        camera.lookAt(battle.midX, PAN_TARGET_Y, battle.midZ);
      }
      // Same idea as the overworld's own updateTownWallFade call (see
      // that function's own comment) — if Glophics happens to be close
      // enough that a wall covers part of the force field from wherever
      // the battle camera is looking this frame, that wall fades too, the
      // exact same way. Targets the dome's own center rather than the
      // player specifically, since the dome (not just you) is "the force
      // field" being asked about here.
      updateTownWallFade(dt, battle.centerX, PAN_TARGET_Y, battle.centerZ);
    } else if (teamBattle) {
      if (teamBattle.focus) {
        // Close behind whichever Glophimon is currently focused — see
        // focusCameraOnMember. Raised and aimed down (TEAM_FOCUS_CAM_LOOK_Y
        // is well below camera height) rather than a flat eye-level shot.
        camera.position.set(teamBattle.focus.camX, TEAM_FOCUS_CAM_HEIGHT, teamBattle.focus.camZ);
        camera.lookAt(teamBattle.focus.lookX, TEAM_FOCUS_CAM_LOOK_Y, teamBattle.focus.lookZ);
      } else {
        // Default wide framing — same fixed-framing idea as the wild
        // battle's camera override, centered on the player's own position
        // with a radius wide enough to fit both rows and both trainers.
        // Drifts slowly like a satellite instead of sitting at a fixed
        // angle, so the "everyone visible" shot doesn't read as frozen.
        teamBattle.camAngle += RESET_CAM_ORBIT_SPEED * dt;
        camera.position.set(
          teamBattle.centerX + Math.sin(teamBattle.camAngle) * Math.cos(BATTLE_CAM_ELEVATION) * TEAM_CAM_RADIUS,
          PAN_TARGET_Y + Math.sin(BATTLE_CAM_ELEVATION) * TEAM_CAM_RADIUS,
          teamBattle.centerZ + Math.cos(teamBattle.camAngle) * Math.cos(BATTLE_CAM_ELEVATION) * TEAM_CAM_RADIUS,
        );
        camera.lookAt(teamBattle.centerX, PAN_TARGET_Y, teamBattle.centerZ);
      }
    } else if (pvpBattle) {
      // Same drifting wide-framing fallback the wild battle's own camera
      // uses when it has no per-turn focus target (see battle.camAngle
      // above) — PVP has no "camera follows whoever's declaring" concept
      // since both sides act simultaneously, so this is the only framing
      // it needs.
      pvpBattle.camAngle += RESET_CAM_ORBIT_SPEED * dt;
      camera.position.set(
        pvpBattle.midX + Math.sin(pvpBattle.camAngle) * Math.cos(BATTLE_CAM_ELEVATION) * BATTLE_CAM_RADIUS,
        PAN_TARGET_Y + Math.sin(BATTLE_CAM_ELEVATION) * BATTLE_CAM_RADIUS,
        pvpBattle.midZ + Math.cos(pvpBattle.camAngle) * Math.cos(BATTLE_CAM_ELEVATION) * BATTLE_CAM_RADIUS,
      );
      camera.lookAt(pvpBattle.midX, PAN_TARGET_Y, pvpBattle.midZ);
      updateTownWallFade(dt, pvpBattle.centerX, PAN_TARGET_Y, pvpBattle.centerZ);
    } else {
      const followEase = Math.min(1, CAMERA_FOLLOW_LERP_SPEED * dt);
      followX += (local.x - followX) * followEase;
      followZ += (local.z - followZ) * followEase;
      camera.position.set(
        followX + Math.sin(camAngle) * Math.cos(camElevation) * zoomRadius,
        PAN_TARGET_Y + Math.sin(camElevation) * zoomRadius,
        followZ + Math.cos(camAngle) * Math.cos(camElevation) * zoomRadius,
      );
      camera.lookAt(followX, PAN_TARGET_Y, followZ);
      updateTownWallFade(dt);
    }

    scaleNameLabel(local.rig, camera, lastHeight || canvas.height, true);
    scaleNameLabel(rodzRig, camera, lastHeight || canvas.height, Math.hypot(local.x - RODZ_X, local.z - RODZ_Z) <= LABEL_VISIBLE_DISTANCE);
    scaleNameLabel(karraRig, camera, lastHeight || canvas.height, Math.hypot(local.x - KARRA_X, local.z - KARRA_Z) <= LABEL_VISIBLE_DISTANCE);
    scaleNameLabel(jaredRig, camera, lastHeight || canvas.height, Math.hypot(local.x - JARED_X, local.z - JARED_Z) <= LABEL_VISIBLE_DISTANCE);
    scaleNameLabel(bossRickRig, camera, lastHeight || canvas.height, Math.hypot(local.x - BOSS_RICK_X, local.z - BOSS_RICK_Z) <= LABEL_VISIBLE_DISTANCE);
    for (const peer of peers.values()) {
      scaleNameLabel(peer.rig, camera, lastHeight || canvas.height, Math.hypot(local.x - peer.x, local.z - peer.z) <= LABEL_VISIBLE_DISTANCE);
    }
    if (battle) {
      for (const member of battle.playerTeam) scaleNameLabel(member.rig, camera, lastHeight || canvas.height);
      scaleNameLabel(battle.wildRig, camera, lastHeight || canvas.height);
    } else if (teamBattle) {
      for (const team of teamBattle.teams) {
        for (const m of team.members) scaleNameLabel(m.rig, camera, lastHeight || canvas.height);
      }
      scaleNameLabel(teamBattle.npcTrainerRig, camera, lastHeight || canvas.height);
    } else if (pvpBattle) {
      scaleNameLabel(pvpBattle.selfRig, camera, lastHeight || canvas.height);
      scaleNameLabel(pvpBattle.opponentRig, camera, lastHeight || canvas.height);
    }

    updateSkyFollowCamera(skyDome, sunSprite, camera);
    renderer.render(scene, camera);
    if (!disposed) rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  el._glophimonCleanup = () => {
    disposed = true;
    cancelAnimationFrame(rafId);
    if (battle) endBattle(); // tears down the wild rig/dome and restores peer visibility/local opacity
    if (teamBattle) endTeamBattle();
    if (pvpBattle) endPvpBattle();
    closeGlophimonStatsModal(); // disposes the modal's own preview rig/RAF loop, if one was open
    socket.dispose();
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("mousedown", onMouseDown);
    canvas.removeEventListener("click", onCanvasClick);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    battleButton.removeEventListener("click", onClickStartWildBattle);
    teamBattleButton.removeEventListener("click", startTeamBattle);
    disposeRig(local.rig);
    disposeRig(rodzRig);
    disposeRig(karraRig);
    disposeRig(jaredRig);
    disposeRig(bossRickRig);
    karirsBoard.texture.dispose();
    karirsBoard.sprite.material.dispose();
    hideRodzShoutBubble();
    if (local.chatBubble) disposeChatBubble(local.chatBubble);
    for (const userId of [...peers.keys()]) removePeer(userId);
    for (const id of [...wildSpawns.keys()]) removeWildSpawn(id);
    renderer.dispose();
  };

  return {
    setMenuData(glophimonList, inventory) {
      menuData = { glophimon: glophimonList, inventory };
      // The top-level list (renderGlophimonMenuList) is static — nothing
      // about its 3 options depends on menuData — so only the two modals
      // (and the stats modal, independently reachable from the PC modal)
      // need a live refresh when fresh data round-trips back in.
      if (glophimonPcModalEl.style.display !== "none") renderGlophimonPcModal();
      if (glophimonBagModalEl.style.display !== "none") renderGlophimonBagModal();
      if (statsModalGlophimon) {
        const stillThere = glophimonList.find((g) => g.id === statsModalGlophimon.id);
        if (stillThere) openGlophimonStatsModal(stillThere);
        else closeGlophimonStatsModal();
      }
    },
  };
}

export function unmount(el) {
  if (el && el._glophimonCleanup) {
    el._glophimonCleanup();
    delete el._glophimonCleanup;
  }
}

const PREVIEW_TARGET_Y = 0.9; // roughly chest height, so the orbit centers the character in frame rather than its feet
const PREVIEW_MIN_RADIUS = 1.4;
const PREVIEW_MAX_RADIUS = 5;
const PREVIEW_DEFAULT_RADIUS = 2.4;
const PREVIEW_DEFAULT_ELEVATION = 0.35;
const PREVIEW_MIN_ELEVATION = -0.4;
const PREVIEW_MAX_ELEVATION = 1.3;

// Character-creation preview — a small standalone rotate-to-inspect view of
// the current color choices, live-updated as the player edits them (see
// setColors below, called from chat.js's own color-input listeners).
// Deliberately not the full mount() above: no network socket, no movement,
// no name label — just one character, always rotatable (no separate Auto/
// Manual toggle, unlike the real world view, since orbiting is this view's
// entire purpose) so every angle can be checked before committing (colors
// can never be changed again once created — see the game's own plan).
export function mountPreview(el, initialColors) {
  el.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  canvas.style.width = "100%";
  canvas.style.maxWidth = "320px";
  canvas.style.display = "block";
  canvas.style.borderRadius = "4px";
  canvas.style.cursor = "grab";
  el.appendChild(canvas);

  const { renderer, scene, camera } = createScene(canvas);
  const rig = buildBlockyCharacter(initialColors, null);
  scene.add(rig.group);

  let camAngle = 0;
  let camElevation = PREVIEW_DEFAULT_ELEVATION;
  let zoomRadius = PREVIEW_DEFAULT_RADIUS;
  let isDragging = false;
  let lastMouseX = 0;
  let lastMouseY = 0;

  function onWheel(event) {
    event.preventDefault();
    zoomRadius = Math.min(PREVIEW_MAX_RADIUS, Math.max(PREVIEW_MIN_RADIUS, zoomRadius + event.deltaY * ZOOM_SPEED));
  }
  canvas.addEventListener("wheel", onWheel, { passive: false });

  function onMouseDown(event) {
    if (event.button !== 0) return;
    isDragging = true;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    canvas.style.cursor = "grabbing";
  }
  function onMouseMove(event) {
    if (!isDragging) return;
    const dx = event.clientX - lastMouseX;
    const dy = event.clientY - lastMouseY;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    camAngle -= dx * DRAG_SENSITIVITY;
    camElevation = Math.min(PREVIEW_MAX_ELEVATION, Math.max(PREVIEW_MIN_ELEVATION, camElevation + dy * DRAG_SENSITIVITY));
  }
  function onMouseUp() {
    isDragging = false;
    canvas.style.cursor = "grab";
  }
  canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  let lastFrameTime = performance.now();
  let lastWidth = 0;
  let lastHeight = 0;
  let rafId = 0;
  let disposed = false;

  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    applyIdlePose(rig, dt); // a light idle bob so the preview doesn't look frozen, same as the real world view's own idle characters

    const width = canvas.clientWidth || canvas.getBoundingClientRect().width;
    const height = canvas.clientHeight || canvas.getBoundingClientRect().height;
    if (width > 0 && height > 0 && (width !== lastWidth || height !== lastHeight)) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      lastWidth = width;
      lastHeight = height;
    }

    camera.position.set(
      Math.sin(camAngle) * Math.cos(camElevation) * zoomRadius,
      PREVIEW_TARGET_Y + Math.sin(camElevation) * zoomRadius,
      Math.cos(camAngle) * Math.cos(camElevation) * zoomRadius,
    );
    camera.lookAt(0, PREVIEW_TARGET_Y, 0);

    renderer.render(scene, camera);
    if (!disposed) rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  el._glophimonPreviewCleanup = () => {
    disposed = true;
    cancelAnimationFrame(rafId);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    disposeRig(rig);
    renderer.dispose();
  };

  return {
    setColors(colors) {
      recolorRig(rig, colors);
    },
    dispose() {
      if (el._glophimonPreviewCleanup) {
        el._glophimonPreviewCleanup();
        delete el._glophimonPreviewCleanup;
      }
    },
  };
}

window.CheddarGames = window.CheddarGames || {};
window.CheddarGames["glophimon"] = { mount, unmount, mountPreview };
