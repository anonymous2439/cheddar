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
// CSS3DRenderer/CSS3DObject — three.js's own addon for rendering real DOM
// elements (here, a YouTube <iframe>) as a camera-matched layer alongside
// the normal WebGL scene. Needed only for the floor-2 cinema screen (see
// CINEMA_YOUTUBE_VIDEO_ID/buildCinemaScreenObject below) — a YouTube
// player can't be captured into a THREE.VideoTexture/CanvasTexture
// (cross-origin), so there's no way to put it on a normal WebGL mesh.
// Resolved by build.sh's own --alias:three flag the same way plain "three"
// imports are (confirmed by node --check + a real esbuild build — see that
// script's own comment for why the alias exists at all).
import { CSS3DRenderer, CSS3DObject } from "three/examples/jsm/renderers/CSS3DRenderer.js";
// Only for the Karirs racer rigs (see buildKarirsRacerRig) — ported from
// games/karirs/client/src/render3d.js's own identical import, same
// resolution mechanism as CSS3DRenderer's own import just above (the
// --alias:three build.sh flag only intercepts the bare "three" specifier,
// not this deep subpath, so it resolves via this package's own
// node_modules/three exactly like that one already does).
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import {
  buildBlockyCharacter,
  applyIdlePose,
  updateWalkCycle,
  applyAttackPose,
  applyFlinchPose,
  applyDeathPose,
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
  buildFaceMarker,
  buildBackMarker,
} from "./character.js";
// Phase 1 of Dama (see this game's own plan file) — a pure rules engine,
// no rendering/networking of its own yet; exercised here only via the
// Dev menu's self-play test modal (see damaTestButton below).
import { createInitialDamaBoard, getAllLegalMoves, applyDamaMove, hasNoLegalMoves } from "./dama.js";
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
import { connectGlophiworldSocket, NETWORK_TICK_MS } from "./net/glophiworldSocket.js";
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
// only while they're actually in the way (see updateTownWallFade). Low
// enough to read as fully gone rather than a visible see-through wall —
// still a smooth opacity lerp (see TOWN_WALL_FADE_RATE), not a hard
// visible/invisible snap, since this re-evaluates continuously as the
// camera angle changes and an instant on/off would flicker.
const TOWN_WALL_OCCLUDED_OPACITY = 0.02;
const TOWN_WALL_FADE_RATE = 8; // per-second ease rate for the opacity lerp, so it fades in/out rather than snapping
const TOWN_DOOR_POST_COLOR = "#7c4a2d";
const TOWN_PLAZA_COLOR = "#c9b38c";

// --- Glophics tower (multi-story) ------------------------------------------
// The first thing in this entire codebase to model real vertical (Y-axis)
// space — everything else (every peer, NPC, wild spawn, battle rig) has
// always lived at a literal y=0. Floor 0 is the existing ground floor
// (buildTown's own walls/plaza below) and isn't listed here; this list is
// only the floors ABOVE it. Deliberately data-driven: adding a floor 3
// later means appending one entry to GLOPHICS_FLOORS and nothing else —
// wall/floor-slab building (buildGlophicsFloor), collision
// (townWallSegmentsByFloor/isInsideTownWalls), cutaway transparency
// (applyGlophicsFloorCutaway), and the stairs (GLOPHICS_STAIR_TRANSITIONS)
// all derive from this array rather than hardcoding "floor 1"/"floor 2".
// Exactly TOWN_WALL_HEIGHT — floor 2's own slab sits flush on top of the
// ground floor's wall tops, the way a real building's next floor sits
// directly on the one below it, with no visible gap between them. This
// used to be a larger fixed value (3.5) meant as "headroom plus room for a
// floor slab," but the slab itself is a paper-thin PlaneGeometry (no real
// thickness to make room for) — that extra margin just left an empty
// 1.1-unit gap floating between the two floors, which is exactly the
// "floor 2 looks like it's floating" bug this fixes.
const FLOOR_HEIGHT = TOWN_WALL_HEIGHT;
// Floor 2's own wallColor/floorColor recolored to a cinema theme (a
// lightened dark slate-gray wall, a lightened dark carpet-red floor — see
// this session's own "lighten the color a bit" request) to go with the
// actual cinema screen built onto its south wall — see CINEMA_YOUTUBE_VIDEO_ID/
// buildCinemaScreenObject and buildCinemaSeats below. Plain color swap only,
// same geometry as before.
const GLOPHICS_FLOORS = [
  // wallHeight doubled (TOWN_WALL_HEIGHT*2) and hasDoors:false per explicit
  // request — a taller cinema room, reachable only via the stairs, never
  // through a walk-in doorway like the ground floor's four.
  // wallHeight raised from TOWN_WALL_HEIGHT*2 to *6 so the cinema screen
  // (CINEMA_SCREEN_WORLD_WIDTH/HEIGHT below) can span the wall at its own
  // real 16:9 proportions instead of being squashed to fit a shorter room —
  // see that constant's own comment for why a screen this wide needs this
  // much headroom once it's not being stretched.
  { index: 1, y: FLOOR_HEIGHT, wallColor: "#3a3a45", floorColor: "#7a2e2e", wallHeight: TOWN_WALL_HEIGHT * 6, hasDoors: false },
  // Future floors just append here, e.g.
  // { index: 2, y: FLOOR_HEIGHT * 2, wallColor: ..., floorColor: ..., wallHeight: TOWN_WALL_HEIGHT, hasDoors: false }.
];
// Which GLOPHICS_FLOORS entry the cinema screen/seats live on — referenced
// instead of a bare "1" everywhere below so both the screen's own placement
// and its visibility gating (see frame()'s own cinemaScreenVisible check)
// stay correct without changes if floor ordering/indices are ever reworked.
const CINEMA_SCREEN_FLOOR_INDEX = GLOPHICS_FLOORS[0].index;
// The roof sits directly on top of whichever floor is currently topmost —
// that floor's own y plus its own wallHeight (not a uniform FLOOR_HEIGHT
// multiple, since floors can now have independently different wallHeights,
// e.g. floor 2's doubled one) — so it rises correctly no matter what a
// future floor's own wallHeight is.
const GLOPHICS_TOPMOST_FLOOR = GLOPHICS_FLOORS[GLOPHICS_FLOORS.length - 1];
const GLOPHICS_ROOF_Y = GLOPHICS_TOPMOST_FLOOR.y + (GLOPHICS_TOPMOST_FLOOR.wallHeight ?? TOWN_WALL_HEIGHT);
const GLOPHICS_ROOF_COLOR = "#6b3f2a";
// One virtual "floor index" higher than any real floor in GLOPHICS_FLOORS —
// lets applyGlophicsFloorCutaway treat "the roof" as just another entry
// that's always above the topmost real floor, no special case needed.
const GLOPHICS_ROOF_INDEX = GLOPHICS_FLOORS.length + 1;

// Stairs — 2 tiles per floor transition (an "up" tile on the lower floor, a
// "down" tile at the SAME X/Z on the floor above), Pokémon Center/Gym
// style. Placed in the plaza's south-east corner: clear of Rodz (RODZ_X/Z
// = 6/0), clear of Jared's shop (JARED_X/Z = -6/0 — its counter/posts/roof
// all sit within x in [-7,-5], z in [-3,-1]), and clear of every door gap
// (each wall's gap is centered on that wall's own midpoint, ±
// TOWN_DOOR_HALF_WIDTH — this corner is nowhere near any of the four
// midpoints).
const GLOPHICS_STAIRS_X = 6;
const GLOPHICS_STAIRS_Z = 6;
const STAIRS_CONTACT_RADIUS = 0.9; // tighter than WILD_CONTACT_RADIUS (1.0) — shouldn't trigger from just brushing past
const STAIRS_COOLDOWN_MS = 1200; // same "don't immediately re-trigger" reasoning as POST_BATTLE_COOLDOWN_MS, just much shorter — this is a floor change, not a fight
const STAIRS_STEP_AWAY = 1.4; // how far the player is nudged off the tile after a floor change
// One entry per floor transition (ground<->floor1, floor1<->floor2, ...),
// derived from GLOPHICS_FLOORS so a future floor there automatically gets
// its own stairs pair here too — same X/Z on every floor, a single
// straight stairwell running up through the tower like the real games.
const GLOPHICS_STAIR_TRANSITIONS = GLOPHICS_FLOORS.map((floor, i) => ({
  belowFloor: i === 0 ? 0 : GLOPHICS_FLOORS[i - 1].index,
  belowY: i === 0 ? 0 : GLOPHICS_FLOORS[i - 1].y,
  aboveFloor: floor.index,
  aboveY: floor.y,
  x: GLOPHICS_STAIRS_X,
  z: GLOPHICS_STAIRS_Z,
}));

// The single source of truth for "what world-space Y does floor N sit at" —
// local.y, every peer's own .y, and the stairs' belowY/aboveY above all
// ultimately trace back to this (ground is always 0; anything else is
// looked up from GLOPHICS_FLOORS by its own index). Returns 0 for an
// unrecognized index rather than throwing, since a peer's floor field is
// network input and shouldn't be able to crash rendering.
function glophicsFloorY(floorIndex) {
  if (!floorIndex) return 0;
  return GLOPHICS_FLOORS.find((f) => f.index === floorIndex)?.y ?? 0;
}

// --- Floor 2 cinema screen ---------------------------------------------
// A real, actual embedded YouTube video playing on floor 2's south wall —
// see buildCinemaScreenObject and mount()'s own cssRenderer/cssScene
// wiring (search "CSS3DRenderer(" inside mount()) for how a DOM <iframe>
// ends up perspective-matched into the 3D scene at all. Known, accepted
// limitation: this is a separate DOM layer, not a WebGL mesh, so it gets no
// real depth-occlusion against the rest of the scene (something walking
// "in front of" it on the WebGL side won't visually block it) — a tradeoff
// of the CSS3DRenderer technique itself, not something fixed here.
//
// PLACEHOLDER VIDEO — explicitly authorized this session as a stand-in
// (Rick Astley, "Never Gonna Give You Up"). No longer the only thing that
// can ever play here: this is now just the DEFAULT the screen falls back
// to before any connected player has ever claimed the projectionist role
// and changed it (see the Usher/USHER_NAME section above, and
// cinemaScreenUrl/cinema_screen_state in mount() below) — must match the
// api's own CINEMA_DEFAULT_SCREEN_URL (main.py) so a freshly-restarted
// server and a freshly-loaded client agree on the same starting point.
const CINEMA_YOUTUBE_VIDEO_ID = "dQw4w9WgXcQ";
// autoplay=1 requires mute=1 — browsers block unmuted autoplay outright.
// loop=1 alone only loops within a playlist context, so the documented
// trick for looping a SINGLE video forever is playlist=<that same video
// ID>. controls=0 since nothing here is meant to be interacted with (see
// the pointer-events:none on the CSS3D container in mount()). enablejsapi=1
// is required for the postMessage pauseVideo/playVideo commands frame()
// sends the iframe when the screen is hidden/shown (see cinemaScreenShown)
// — without it, hiding the screen via display:none stops it being DRAWN
// but does NOT stop YouTube's own player from continuing to decode/play
// in the background, which would otherwise waste real CPU/memory the
// entire time this game panel is mounted, not just while on floor 2.
const CINEMA_YOUTUBE_EMBED_URL =
  `https://www.youtube.com/embed/${CINEMA_YOUTUBE_VIDEO_ID}?autoplay=1&mute=1&loop=1&playlist=${CINEMA_YOUTUBE_VIDEO_ID}&controls=0&enablejsapi=1`;
// The YouTube IFrame Player API's documented postMessage command protocol
// (https://developers.google.com/youtube/iframe_api_reference#Commands) —
// origin-scoped to the real youtube.com embed, not "*", since this is
// commanding a specific known frame, not broadcasting.
function sendCinemaScreenCommand(iframe, func) {
  iframe.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args: [] }), "https://www.youtube.com");
}
// Now that the projectionist can point the screen at ANY http(s) URL (see
// USHER_NAME's own section above), sendCinemaScreenCommand's YouTube-
// specific postMessage protocol can't be assumed to do anything useful —
// most embedded sites don't implement it at all. Every call site below
// checks this first and, for a non-YouTube URL, just shows/hides the
// iframe with no attempt at a controllable play state (a graceful
// degradation, not an error — an arbitrary embedded page has no obligation
// to expose one). Origin-matched against the exact embed host this file
// itself builds URLs against, not a generic "contains youtube" substring
// check, so this can't be tricked by a URL that merely mentions youtube.com
// somewhere in a query string.
function isYoutubeEmbedUrl(url) {
  return typeof url === "string" && url.startsWith("https://www.youtube.com/");
}
// CSS-pixel size of the actual <iframe> element (16:9) — CSS3DObject
// positions/sizes things in CSS pixels by default, so this gets scaled down
// to CINEMA_SCREEN_WORLD_WIDTH/HEIGHT world units via the object's own
// .scale in buildCinemaScreenObject, the same way any CSS3DRenderer scene
// object has to be sized into a 3D world.
const CINEMA_SCREEN_PIXEL_WIDTH = 480;
const CINEMA_SCREEN_PIXEL_HEIGHT = 270;
// Spans left-to-right across almost the entire south wall — floor 2 has no
// doorway to avoid any more (hasDoors:false above), so the screen no longer
// needs to dodge a door gap and can sit centered on the wall instead. Full
// wall width is TOWN_HALF_X*2 = 18; inset by one wall-thickness on each
// side so the screen doesn't visually poke past the wall's own corners.
// Height is derived from the iframe's own real 16:9 pixel aspect — NOT set
// independently any more (an earlier version picked a fixed, shorter
// height here, which stretched/squashed the video to fit; a screen this
// wide at true 16:9 needs real headroom, which is exactly why floor 2's
// own wallHeight above was raised to *6 rather than compressing the video
// instead).
const CINEMA_SCREEN_WORLD_WIDTH = TOWN_HALF_X * 2 - TOWN_WALL_THICKNESS * 2;
const CINEMA_SCREEN_WORLD_HEIGHT = CINEMA_SCREEN_WORLD_WIDTH * (CINEMA_SCREEN_PIXEL_HEIGHT / CINEMA_SCREEN_PIXEL_WIDTH);
// Placed on floor 2's south wall (z = -TOWN_HALF_Z) — the wall farthest
// from the stairs' floor-2 landing (world (GLOPHICS_STAIRS_X, 6), stepped
// off to z = 6 - STAIRS_STEP_AWAY = 4.6 by goToGlophicsFloor), so the
// screen never crowds the stairwell. Centered on the wall (x = 0) now that
// there's no door gap to dodge.
const CINEMA_SCREEN_X = 0;
const CINEMA_SCREEN_Z = -TOWN_HALF_Z + TOWN_WALL_THICKNESS / 2 + 0.05; // just in front of the wall's inner face
// Bottom edge sits CINEMA_SCREEN_BOTTOM_CLEARANCE above the floor — lower
// than centering it in floor 2's own tall wallHeight (which put its bottom
// edge well above head height), reading more like a real cinema screen you
// walk up to rather than one mounted near the ceiling. Derived from the
// screen's own height rather than a second hardcoded center value, so it
// stays anchored to the floor if the screen's own proportions ever change.
const CINEMA_SCREEN_BOTTOM_CLEARANCE = 0.8;
const CINEMA_SCREEN_Y_OFFSET = CINEMA_SCREEN_BOTTOM_CLEARANCE + CINEMA_SCREEN_WORLD_HEIGHT / 2;

// Sprinting — hold Shift while moving to run at SPRINT_SPEED_MULTIPLIER,
// draining a stamina meter; regenerates whenever not sprinting (whether
// standing still or just walking normally). Once stamina hits zero,
// sprinting locks out — and the bar stays red — until it's fully
// recharged back to STAMINA_MAX, not just some partial amount; a full
// recovery reads as a clearer "you're good to go again" cue than the bar
// flipping back to blue partway through regenerating.
const SPRINT_SPEED_MULTIPLIER = 1.9;
// Was 100 (only ~3.6s of sprint at the drain rate below) — too short per
// explicit feedback. Doubled rather than slowing the drain rate itself, so
// the bar still empties/refills at the same visual speed, just holds more
// before running out.
const STAMINA_MAX = 200;
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
// Was 0.1 — always at least slightly above the look target's own height
// (PAN_TARGET_Y), so the camera could never tilt up far enough to see
// anything tall from up close (e.g. the cinema's own screen, now that
// floor 2's room is much taller). Negative values put the camera BELOW
// the look target, angled upward at it — same orbit formula as before
// (Math.sin/cos(camElevation)), just extended past level instead of only
// ever looking flat or down.
const MIN_ELEVATION = -0.6;
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
const FLINCH_ANIM_MS = 350; // a quick snap-back, not a held stagger — see applyFlinchPose
// A wild's own death sequence (see startWildDeath) — the collapse itself
// (applyDeathPose) finishes well within DEATH_HOLD_MS, so most of this is
// just holding on the ground before DEATH_FADE_MS eases it out of view.
const DEATH_HOLD_MS = 2200;
const DEATH_FADE_MS = 1000;
// Per-action-slot cooldown weighting — faithful mirror of the api's own
// ACTION_WEIGHTS/REFERENCE_SPEED/_action_cooldown_s (see main.py), purely
// so THIS client can show the right countdown clock the instant a
// companion is summoned (see showCompanionSummonModal) without waiting on
// a round trip; the server's own copy is still the one that actually
// enforces it (see _handle_companion_message's own companion_attack
// branch) — this is display-only, a spoofed client could draw whatever
// clock it wants and the real cooldown still holds.
const COMPANION_ATTACK_COOLDOWN_S = 1.0;
const ACTION_WEIGHTS = { 1: 1.0 };
const REFERENCE_SPEED = 20;
const MIN_ACTION_COOLDOWN_S = 0.3;
const MAX_ACTION_COOLDOWN_S = 4.0;

function actionCooldownS(weight, speed) {
  const raw = COMPANION_ATTACK_COOLDOWN_S * weight * (REFERENCE_SPEED / Math.max(1, speed));
  return Math.max(MIN_ACTION_COOLDOWN_S, Math.min(MAX_ACTION_COOLDOWN_S, raw));
}
const ANIM_SETTLE_BUFFER_MS = 150; // grace after a pose's own duration before the next round's buttons/camera re-aim appear
const ANIM_SETTLE_MS = Math.max(ATTACK_ANIM_MS, DEFEND_ANIM_MS, CAST_ANIM_MS) + ANIM_SETTLE_BUFFER_MS; // no longer used by the wild battle's own round-advance timers (see effectivePoseDurationMs) now that a saved pose override can run longer than any of these fixed durations — still correct as a plain default for anything not yet made duration-aware
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
// Rodz's own parting line once a claim actually succeeds — picked at
// random purely for a little variety, not because any of them mean
// anything different (see rodzClaimBtn's own click handler below).
const RODZ_CLAIM_SEND_OFFS = [
  "Happy Glophimon catching!",
  "Take care out there!",
  "Go get 'em, trainer!",
  "Good luck on your next catch!",
];
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
// More mouse movement than this between mousedown/mouseup means it was a
// camera drag, not a click — was 5, which is tight enough that ordinary
// hand tremor/mouse jitter during a perfectly-intended click routinely
// crossed it, silently discarding the whole click (onCanvasClick's own
// very first line bails out on draggedPastThreshold with no feedback at
// all) — this is what made clicking a wild (or any NPC) feel randomly
// unresponsive. 12px is still far short of an actual camera-orbit drag
// (typically tens to hundreds of pixels) so a real drag still reads as one.
const CLICK_DRAG_THRESHOLD_PX = 12;

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

// Practice races — see karirsPracticeState/onKarraPracticeClick/
// simulateKarirsPracticeRace. Entirely client-local (no server call at
// all), so blocking it is purely a courtesy against a practice race
// visually clashing with the real one on the same shared track, not an
// actual resource the server needs protected.
const KARIRS_PRACTICE_COUNTDOWN_MS = 10000;
// "the next race will start in 1 minute" — if the real race is either
// already running, or about to (betting closes within this window), Karra
// declines instead of starting the countdown.
const KARIRS_PRACTICE_BLOCK_WINDOW_MS = 60000;
// How long a finished practice race's final standings stay on the track
// before automatically reverting to whatever the real karirsRace is doing.
const KARIRS_PRACTICE_RESULT_HOLD_MS = 6000;
const KARIRS_PRACTICE_FALLBACK_NAMES = ["Practice Runner A", "Practice Runner B", "Practice Runner C", "Practice Runner D"];
// Mirrors karirs_engine.py's own step_race constants exactly (TOTAL_STEPS/
// SPEED_RANGE/SPEED_CHANGE_STEP_INTERVAL/FINISH_LINE) — a practice race
// should feel like a real one, just simulated locally instead of fetched
// from the server, with no betting/payout math attached to it at all.
const KARIRS_PRACTICE_TOTAL_STEPS = 150;
const KARIRS_PRACTICE_SPEED_MIN = 0;
const KARIRS_PRACTICE_SPEED_MAX = 2;
const KARIRS_PRACTICE_SPEED_CHANGE_MIN = 5;
const KARIRS_PRACTICE_SPEED_CHANGE_MAX = 15;
const KARIRS_PRACTICE_FINISH_LINE = 100;

// A direct port of karirs_engine.py's own step_race/compute_race — same
// algorithm, run client-side instead of server-side, since a practice race
// has no odds/payouts to protect and never needs to be trusted. Returns
// the same { steps: [{positions}], winner } shape a real race's own
// steps/winning_name already have, so updateKarirsTrackVisual's own
// step-interpolation/gait code can render either one identically without
// caring which kind it's looking at.
function simulateKarirsPracticeRace(racerNames) {
  const positions = {};
  const speeds = {};
  const nextChange = {};
  for (const name of racerNames) {
    positions[name] = 0;
    speeds[name] = KARIRS_PRACTICE_SPEED_MIN + Math.random() * (KARIRS_PRACTICE_SPEED_MAX - KARIRS_PRACTICE_SPEED_MIN);
    nextChange[name] =
      KARIRS_PRACTICE_SPEED_CHANGE_MIN + Math.floor(Math.random() * (KARIRS_PRACTICE_SPEED_CHANGE_MAX - KARIRS_PRACTICE_SPEED_CHANGE_MIN + 1));
  }
  const steps = [];
  let winner = null;
  for (let step = 1; step <= KARIRS_PRACTICE_TOTAL_STEPS; step++) {
    for (const name of racerNames) {
      if (step >= nextChange[name]) {
        speeds[name] = KARIRS_PRACTICE_SPEED_MIN + Math.random() * (KARIRS_PRACTICE_SPEED_MAX - KARIRS_PRACTICE_SPEED_MIN);
        nextChange[name] =
          step + KARIRS_PRACTICE_SPEED_CHANGE_MIN + Math.floor(Math.random() * (KARIRS_PRACTICE_SPEED_CHANGE_MAX - KARIRS_PRACTICE_SPEED_CHANGE_MIN + 1));
      }
    }
    let crossed = null;
    for (const name of racerNames) {
      if (positions[name] < KARIRS_PRACTICE_FINISH_LINE) {
        positions[name] = Math.min(positions[name] + speeds[name], KARIRS_PRACTICE_FINISH_LINE);
        if (positions[name] >= KARIRS_PRACTICE_FINISH_LINE && crossed === null) crossed = name;
      }
    }
    const isFinal = crossed !== null || step === KARIRS_PRACTICE_TOTAL_STEPS;
    steps.push({ positions: { ...positions } });
    if (isFinal) {
      winner = crossed ?? racerNames.reduce((best, n) => (positions[n] > positions[best] ? n : best), racerNames[0]);
      break;
    }
  }
  return { steps, winner };
}

// A real racetrack rendered directly in the world just south of the field
// itself (see buildKarirsTrack/updateKarirsTrackVisual) — lets anyone
// standing nearby watch a race happen live without ever opening the TV
// popup, which stays exactly as it was (a closer, exact-numbers view) for
// anyone who wants it. Purely a second *rendering* of the same already-
// synced karirsRace/steps data the TV already replays locally against
// started_at — no new network state at all, since every client already
// has everything needed to compute any racer's live percent-complete.
// Extends south from the field's own south wall, safely inside the
// island's own ARENA_HALF_Z=80 bound (see buildGround).
const KARIRS_TRACK_LANE_COUNT = 4; // must match the api's own karirs_engine.DEFAULT_RACER_COUNT
const KARIRS_TRACK_LANE_SPACING = 2.4;
const KARIRS_TRACK_START_Z = KARIRS_FIELD_Z - KARIRS_FIELD_HALF - 3;
const KARIRS_TRACK_LENGTH = 30;
const KARIRS_TRACK_FINISH_Z = KARIRS_TRACK_START_Z - KARIRS_TRACK_LENGTH;
const KARIRS_TRACK_WIDTH = KARIRS_TRACK_LANE_COUNT * KARIRS_TRACK_LANE_SPACING + 2;
// One racer marker's own lane offset from KARIRS_FIELD_X, centered on the
// track's own width — e.g. 4 lanes at spacing 2.4 gives [-3.6,-1.2,1.2,3.6].
const KARIRS_TRACK_LANE_OFFSETS = Array.from(
  { length: KARIRS_TRACK_LANE_COUNT },
  (_, i) => (i - (KARIRS_TRACK_LANE_COUNT - 1) / 2) * KARIRS_TRACK_LANE_SPACING,
);
// Position itself needs no separate easing — see updateKarirsTrackVisual's
// own step-interpolation (ported from games/karirs' own currentStepInfo()),
// which already produces a frame-smooth value every frame, not a value
// that jumps once every KARIRS_STEP_DELAY_MS and needs smoothing after
// the fact.

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

// The cinema's own greeter — floor 2's "projectionist" feature (see the
// CINEMA_YOUTUBE_VIDEO_ID/buildCinemaScreenObject section below for the
// screen itself) is entirely driven through him: click him to see who
// currently holds the projectionist role (server-shared, via
// cinema_projectionist_state), claim the role yourself if it's vacant, or —
// if you're already holding it — change what's playing. His own popup
// content is state-driven rather than step-driven, the same shape the
// player-options popup (renderPlayerOptionsMenu) already uses, not Boss
// Rick's own multi-step dialogue. Dark "uniform" colors (near-black body/
// legs) to read as staff rather than a trainer, same idea as Boss Rick's
// own dark suit.
const USHER_NAME = "Usher";
const USHER_COLORS = { head: "#d1a17a", body: "#1c1c24", arm: "#d1a17a", leg: "#0d0d12" };
// Standing just past the stairs' floor-2 landing (world
// (GLOPHICS_STAIRS_X, GLOPHICS_STAIRS_Z - STAIRS_STEP_AWAY) = (6, 4.6) —
// see goToGlophicsFloor), offset well off to the side in -X so he's never
// standing ON the exact tile a player is nudged onto when arriving, and
// well north (larger Z) of both the bench rows (CINEMA_SEAT_ROW_Z tops out
// at z=3.3) and the screen itself (CINEMA_SCREEN_Z, deep in -Z against the
// south wall) — he's positioned right in the little gap between the
// landing and the first row of seats, exactly where a real usher would
// stand to greet people walking in before they head further into the room.
const USHER_X = 3.5;
const USHER_Z = 4.6;

// Simple square-footprint AABB test — used by isInsideGlophicsFootprint
// (Glophics specifically, half=TOWN_HALF_X==TOWN_HALF_Z so one half works
// for both axes), part of the Glophics floor-cutaway feature (see
// applyGlophicsFloorCutaway/updateGlophicsExteriorCutaway below).
function isInsideAreaFootprint(x, z, centerX, centerZ, half) {
  return Math.abs(x - centerX) <= half && Math.abs(z - centerZ) <= half;
}

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
// The third table — a standing AI match (see the api's own AI_BOARD_ID/
// chess_ai_start/dama_ai_start), on the south side of the plaza so it
// doesn't crowd the two player-hosted boards along the center line above.
// Dual-purpose as of Dama Phase 3 — the host picks Chess (Stockfish) or
// Dama (this project's own minimax search) fresh each time, same as
// boards 1/2 already let the host pick Chess or Dama.
const CHESS_BOARD_3_X = TAMBAYAN_X;
const CHESS_BOARD_3_Z = TAMBAYAN_Z + 6;
const AI_BOARD_ID = 3;
const CHESS_BOARD_SIZE = 1.6; // top surface width/depth
const CHESS_TABLE_HEIGHT = 0.7;
// Matches the table box buildChessTable actually renders (CHESS_BOARD_SIZE +
// 0.3 per side, axis-aligned, centered on the board's own x/z — facingAngle
// is always 0 for every board, see buildTambayan).
const CHESS_TABLE_HALF = (CHESS_BOARD_SIZE + 0.3) / 2;

function isInsideChessTables(x, z) {
  return (
    (Math.abs(x - CHESS_BOARD_1_X) <= CHESS_TABLE_HALF && Math.abs(z - CHESS_BOARD_1_Z) <= CHESS_TABLE_HALF) ||
    (Math.abs(x - CHESS_BOARD_2_X) <= CHESS_TABLE_HALF && Math.abs(z - CHESS_BOARD_2_Z) <= CHESS_TABLE_HALF) ||
    (Math.abs(x - CHESS_BOARD_3_X) <= CHESS_TABLE_HALF && Math.abs(z - CHESS_BOARD_3_Z) <= CHESS_TABLE_HALF)
  );
}

// Stockfish — stands just past its own table facing back toward it/the
// plaza center, always "waiting for an opponent" (a plain idle pose, same
// as every other standing NPC here). Not clickable itself — per spec, the
// battle is started by clicking the board, same interaction shape as the
// two player-hosted tables.
const STOCKFISH_NAME = "Stockfish";
const STOCKFISH_COLORS = { head: "#d1d5db", body: "#111827", arm: "#d1d5db", leg: "#1f2937" };
const STOCKFISH_X = CHESS_BOARD_3_X;
const STOCKFISH_Z = CHESS_BOARD_3_Z + 1.3;
// The AI board's own Dama opponent name (see the api's own DAMA_AI_NAME) —
// no separate standing NPC model for it, unlike Stockfish's own; the board's
// dual purpose is communicated by the host-choice menu instead (see
// renderChessHostMenu's isAiBoard branch).
const DAMA_AI_NAME = "Dama AI";

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

// Which walled area (if any) a world position is inside — "town" (the
// Glophics building/plaza, any floor — this is purely an X/Z footprint
// test, so it can't tell floor 0 from the cinema above it; callers that
// care about that (Rodz/Jared/Usher's own labels, peers' floor field) AND
// this with their own floor check), "karirs"/"luba" (simple AABB, see
// isInsideAreaFootprint), "tambayan" (pentagon, see isInsideTambayan), or
// null when standing outside all of them (open plains). A single source of
// truth for the "labels/signs belonging to a building should only be
// visible to someone actually inside that same building" rule — every
// world-space label/sign sprite in this file uses a depthTest:false
// SpriteMaterial (see buildTownSign/buildKarirsBoardSign), so none of them
// are ever occluded by wall/floor geometry the normal WebGL depth-test way;
// distance alone (LABEL_VISIBLE_DISTANCE) let one building's labels bleed
// through another building's walls whenever the two happened to be within
// range of each other, which this closes off explicitly instead.
function getAreaKey(x, z) {
  if (isInsideAreaFootprint(x, z, 0, 0, TOWN_HALF_X)) return "town";
  if (isInsideAreaFootprint(x, z, KARIRS_FIELD_X, KARIRS_FIELD_Z, KARIRS_FIELD_HALF)) return "karirs";
  if (isInsideAreaFootprint(x, z, LUBA_X, LUBA_Z, LUBA_HALF)) return "luba";
  if (isInsideTambayan(x, z)) return "tambayan";
  return null;
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

// Same "green" board theme the real standalone Cheddar Chess client offers
// (games/chess/client/src/game.js's own BOARD_THEMES.green) — picked as a
// fixed look here rather than a picker, since nothing asked for a per-player
// preference.
const TAMBAYAN_BOARD_LIGHT = "#eeeed2";
const TAMBAYAN_BOARD_DARK = "#769656";
// Last-move highlight, shared by both Chess's and Dama's own match modals —
// a solid tint that REPLACES the square's own light/dark background
// (rather than a translucent overlay, since nothing sits behind these
// square divs to blend with) so it reads the same regardless of which
// square color it lands on.
const TAMBAYAN_LAST_MOVE_TINT = "#baca44";
// Dama's own distinct "that was the opponent's (or the AI's) move" tint —
// see board.lastMove.by below (dama_move/_play_dama_ai_move both now stamp
// last_move.by with whichever side actually moved). Chess has no AI-vs-
// human ambiguity worth solving the same way (its own move history already
// reads unambiguously via SAN), so this is Dama-only.
const TAMBAYAN_LAST_MOVE_OPPONENT_TINT = "#c97b4a";

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

// Height's own valid range for a focus shot's camera — mirrors
// CAMERA_FOCUS_FIELDS' own "Height" slider bounds (see below) so that
// slider and a height-bounce (heightRotateSpeed, see advanceFocusOrbit)
// can never disagree about where the top/bottom of the bounce is, same
// "one shared constant, not two copies of the same number" reasoning as
// MIN_ELEVATION/MAX_ELEVATION for the orbit cameras' own pitch bounce.
const FOCUS_CAM_HEIGHT_MIN = 0.5;
const FOCUS_CAM_HEIGHT_MAX = 5;

// Shared position/lookAt math for the wild battle's own focus camera —
// factored out so mount()'s real focusWildCameraOnRig (which reads a live
// rig's actual position) and the Camera Designer's own live preview for a
// kind:"focus" slot (which has no real battle rig, just two stand-in
// preview rigs at fixed positions — see PREVIEW_BATTLE_WILD_Z/PLAYER_Z)
// both produce the exact same shot for a given set of behind/height/lookY/
// lookAhead values, instead of two hand-written copies of this formula
// drifting apart. `pos`/`lookAtPos` are bare {x,z} positions, not rigs, so
// callers with no rig object at all (the preview) can use this too.
//
// `theta` (added alongside the orbit slots' own rotation support) swings
// the camera around the anchor position while leaving the lookAt target
// completely alone — that's what makes it read as "orbiting the subject"
// instead of just panning the whole shot sideways. `theta = 0` (the
// default, and the value every existing call site used to implicitly use
// before this parameter existed) must reproduce today's exact "directly
// behind" placement: facingAngle+PI+0 has sin/cos exactly -sin(facingAngle)/
// -cos(facingAngle), i.e. -fx/-fz, which is exactly the original
// `pos - fx*behind`/`pos - fz*behind` formula below.
function computeFocusCameraFrame(pos, facingAngle, lookAtPos, params, theta = 0) {
  const fx = Math.sin(facingAngle);
  const fz = Math.cos(facingAngle);
  const orbitAngle = facingAngle + Math.PI + theta;
  return {
    camX: pos.x + Math.sin(orbitAngle) * params.behind,
    camY: params.height,
    camZ: pos.z + Math.cos(orbitAngle) * params.behind,
    lookX: lookAtPos ? lookAtPos.x : pos.x + fx * params.lookAhead,
    lookY: params.lookY,
    lookZ: lookAtPos ? lookAtPos.z : pos.z + fz * params.lookAhead,
  };
}

// Continuous per-frame rotation for whichever focus-camera shot is
// currently active (see CAMERA_FOCUS_FIELDS' angle/rotateSpeed/
// heightRotateSpeed, added alongside the 3 orbit slots' own rotateSpeed/
// elevationRotateSpeed). Called every frame from the `else if
// (battle.focus)` render branch — deliberately NOT from
// focusWildCameraOnRig's own one-shot re-aim, because a re-aim only fires
// once per game event (declaring, an attack landing, ...), not once per
// frame, so advancing rotation there would only tick once per re-aim
// instead of animating continuously while the shot stays on screen.
// battle.focus already carries everything needed to keep recomputing the
// shot (anchorRig/facingAngle/lookAtPos/params, stashed by
// focusWildCameraOnRig) — this just re-derives camX/camY/camZ/lookX/lookY/
// lookZ from those plus an advancing angle/height and overwrites them in
// place, mutating the same object the render block reads a moment later.
//
// Runtime angle/height state is keyed by slot id on battle.focusOrbitState
// (NOT on battle.focus itself, which gets wholesale-replaced by every
// re-aim) so a slot's rotation keeps advancing across re-aims of that same
// slot within a round, and resumes where it left off if the active slot
// changes away and later comes back, rather than snapping to theta=0 every
// single re-aim.
//
// A shot with no rotation configured (rotateSpeed and heightRotateSpeed
// both 0, or autoRotate off) — the default for all 4 focus slots until a
// player customizes one — bails out immediately and leaves the static
// snapshot focusWildCameraOnRig already computed completely untouched, so
// today's exact behavior is unaffected until rotation is actually turned
// on.
function advanceFocusOrbit(battle, focus, dt) {
  const params = focus.params;
  if (!params || !params.autoRotate) return;
  if (params.rotateSpeed <= 0 && params.heightRotateSpeed <= 0) return;
  if (!focus.anchorRig) return; // shouldn't normally happen — every focusWildCameraOnRig call passes a rig
  battle.focusOrbitState = battle.focusOrbitState || {};
  const key = focus.slotId || "_default";
  const state = battle.focusOrbitState[key] || (battle.focusOrbitState[key] = { angle: params.angle ?? 0, camElevation: params.height, camElevationDir: 1 });
  state.angle += params.rotateSpeed * dt;
  const height = advanceOrbitElevation(state, params.height, params.heightRotateSpeed, dt, FOCUS_CAM_HEIGHT_MIN, FOCUS_CAM_HEIGHT_MAX);
  const frame = computeFocusCameraFrame(focus.anchorRig.group.position, focus.facingAngle, focus.lookAtPos, { ...params, height }, state.angle);
  focus.camX = frame.camX;
  focus.camY = frame.camY;
  focus.camZ = frame.camZ;
  focus.lookX = frame.lookX;
  focus.lookY = frame.lookY;
  focus.lookZ = frame.lookZ;
}

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

// --- Procedural terrain (hills/mountains/desert) ------------------------
// Every open stretch of the island — away from Town/Karirs/Luba/Tambayan,
// the racetrack connecting Karirs to its own finish line, and the
// coastline — gets real elevation instead of being flat, so the "plains"
// actually reads as land instead of a green floor. A broad, slow-varying
// "biome" value per position decides whether that patch reads as desert
// (low, gentle dunes), hills (moderate rolling bumps), or mountains (tall,
// rocky/snow-capped peaks), blended smoothly rather than in hard bands so
// one biome fades into the next. Every existing built area stays exactly
// as flat as it always was — this only ever ADDS elevation in the open
// space between them, via a smooth "how far outside every protected area
// am I" factor (see terrainFlattenFactor) that's 0 right at each area's
// own edge, ramps up to full elevation over TERRAIN_FLATTEN_MARGIN, and
// ramps back down to 0 again right at the coastline so the ground still
// meets the ocean plane cleanly with no cliff/gap.
//
// Hand-written value-noise rather than a noise library dependency — no
// noise package exists in this project's own deps, and this needs nothing
// fancier than smoothed, deterministic, seed-free pseudo-randomness — same
// "small hand-written thing instead of a new dependency" choice this
// project already made elsewhere (e.g. the Dama AI's own search, see
// dama_ai.py). Deterministic is what actually matters here: every client
// (and the server, which never touches height at all) independently
// computes the exact same Y for any given X/Z, so this needs zero network
// protocol changes — walking/wild-movement/collision all stay pure X/Z
// exactly as before, this is a purely visual layer on top.

// Pseudo-random in [0,1) from integer grid coordinates — a fixed
// bit-mixing function, not an RNG with state, so it's trivially
// deterministic and needs no seed.
function terrainHash(x, z) {
  let h = (x * 374761393 + z * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

// Smoothstep-interpolated between the 4 surrounding integer grid points'
// own hashes — one "octave" of noise.
function terrainSmoothNoise(x, z) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const sx = x - x0;
  const sz = z - z0;
  const n00 = terrainHash(x0, z0);
  const n10 = terrainHash(x0 + 1, z0);
  const n01 = terrainHash(x0, z0 + 1);
  const n11 = terrainHash(x0 + 1, z0 + 1);
  const ux = sx * sx * (3 - 2 * sx);
  const uz = sz * sz * (3 - 2 * sz);
  const nx0 = n00 + (n10 - n00) * ux;
  const nx1 = n01 + (n11 - n01) * ux;
  return nx0 + (nx1 - nx0) * uz;
}

// Layered ("fractal") noise — a few octaves of the smooth noise above at
// increasing frequency and decreasing weight, which is what actually
// gives natural-looking terrain instead of one uniform wave pattern.
function terrainFractalNoise(x, z, octaves, scale) {
  let total = 0;
  let amplitude = 1;
  let frequency = scale;
  let maxValue = 0;
  for (let i = 0; i < octaves; i++) {
    total += terrainSmoothNoise(x * frequency, z * frequency) * amplitude;
    maxValue += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / maxValue; // normalized to [0,1)
}

function terrainSmooth01(t) {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

// A broad, slow-varying [0,1) value deciding the local biome — sampled far
// from the elevation noise's own coordinates (+5000/-5000) so the two are
// uncorrelated; otherwise biome boundaries would always land exactly on
// elevation contours, which looks artificial rather than like real,
// independently-varying land and climate. scale=0.006 (a wavelength close
// to the whole island's own diameter) was tried first and confirmed, by
// directly scanning it, to only ever reach ~0.30-0.61 across the entire
// map — never actually crossing the desert/mountain thresholds below, so
// every open stretch of land rendered as "hills" no matter where you went.
// 0.025 (checked the same way) spans ~0.11-0.92, comfortably covering both
// biome extremes in patches large enough to read as real regions rather
// than tiny scattered speckles.
function terrainBiomeValue(x, z) {
  return terrainFractalNoise(x + 5000, z - 5000, 3, 0.025);
}

// desert (gentle dunes) below ~0.38, mountains (tall peaks) above ~0.62,
// hills in between — the thresholds themselves are blended across via
// terrainSmooth01 rather than switched on abruptly, so nothing snaps.
function terrainBiomeAmplitude(biome) {
  const DESERT_AMPLITUDE = 1.2;
  const HILL_AMPLITUDE = 4.5;
  const MOUNTAIN_AMPLITUDE = 13;
  if (biome < 0.5) {
    return DESERT_AMPLITUDE + (HILL_AMPLITUDE - DESERT_AMPLITUDE) * terrainSmooth01((biome - 0.3) / 0.2);
  }
  return HILL_AMPLITUDE + (MOUNTAIN_AMPLITUDE - HILL_AMPLITUDE) * terrainSmooth01((biome - 0.5) / 0.2);
}

// How many units it takes each protected area's edge (or the coastline) to
// fade between "fully flat" and "full open-terrain elevation."
const TERRAIN_FLATTEN_MARGIN = 10;

// 0 = fully flat/protected (inside or right at an existing built area's
// own edge, or right at the coastline), 1 = full open-terrain elevation.
// Every one of those systems already has its own exact footprint test
// (walls, collision, no-spawn zones); this only needs a rough "how far
// past that footprint's edge am I," so plain axis-aligned/circular
// distance checks against the very same center/half-extent constants
// those already use is enough — no need to share their own more precise
// shape logic.
function terrainFlattenFactor(x, z) {
  let factor = 1;
  factor = Math.min(factor, terrainSmooth01(Math.max(Math.abs(x) - TOWN_HALF_X, Math.abs(z) - TOWN_HALF_Z) / TERRAIN_FLATTEN_MARGIN));
  factor = Math.min(factor, terrainSmooth01(Math.max(Math.abs(x - KARIRS_FIELD_X) - KARIRS_FIELD_HALF, Math.abs(z - KARIRS_FIELD_Z) - KARIRS_FIELD_HALF) / TERRAIN_FLATTEN_MARGIN));
  factor = Math.min(factor, terrainSmooth01(Math.max(Math.abs(x - LUBA_X) - LUBA_HALF, Math.abs(z - LUBA_Z) - LUBA_HALF) / TERRAIN_FLATTEN_MARGIN));
  factor = Math.min(factor, terrainSmooth01((Math.hypot(x - TAMBAYAN_X, z - TAMBAYAN_Z) - TAMBAYAN_RADIUS) / TERRAIN_FLATTEN_MARGIN));
  // The Karirs racetrack corridor — a straight strip running from the
  // field's own south edge down to the finish line (see KARIRS_TRACK_*),
  // not just a circle around one point like every other area above.
  const trackHalfWidth = KARIRS_TRACK_WIDTH / 2;
  const distX = Math.abs(x - KARIRS_FIELD_X) - trackHalfWidth;
  const distZ = z > KARIRS_TRACK_START_Z ? z - KARIRS_TRACK_START_Z : z < KARIRS_TRACK_FINISH_Z ? KARIRS_TRACK_FINISH_Z - z : 0;
  factor = Math.min(factor, terrainSmooth01(Math.max(distX, distZ) / TERRAIN_FLATTEN_MARGIN));
  // Coastline — fades back to 0 near the island's own edge too, so hills
  // never jut into the ocean or leave a cliff/gap at the shoreline.
  const distFromEdge = Math.min(ARENA_HALF_X - Math.abs(x), ARENA_HALF_Z - Math.abs(z));
  factor = Math.min(factor, terrainSmooth01(distFromEdge / TERRAIN_FLATTEN_MARGIN));
  return factor;
}

// The single source of truth for "how tall is the ground at this X/Z" —
// used to build the ground mesh itself (see buildGround) and to place
// every entity that stands on it (the local player, peers, wild
// Glophimon) at the correct height each frame (see entityGroundY).
function terrainHeight(x, z) {
  const flatten = terrainFlattenFactor(x, z);
  if (flatten <= 0) return 0;
  const biome = terrainBiomeValue(x, z);
  // 0..1, deliberately never negative — real hills/mountains rise ABOVE a
  // base plain, they don't dip below it. The ocean plane sits at a fixed
  // y just under the whole island (see buildGround's own comment); a
  // height that ever went negative here would sink part of the ground
  // mesh below it, which looks exactly like flood water sitting in a
  // valley in the middle of dry land — confirmed as a real bug via an
  // actual screenshot before this fix, not just a theoretical concern.
  const detail = terrainFractalNoise(x, z, 4, 0.035);
  return detail * terrainBiomeAmplitude(biome) * flatten;
}

// floor 0 is the actual outdoor ground, which now has real elevation (see
// terrainHeight above); every other floor still just sits at its own
// fixed GLOPHICS_FLOORS Y (glophicsFloorY) — this is the one place that
// distinction is made, used everywhere a player/peer's own Y needs
// setting for whatever floor they're currently on.
function entityGroundY(floorIndex, x, z) {
  return floorIndex === 0 ? terrainHeight(x, z) : glophicsFloorY(floorIndex);
}

const TERRAIN_COLOR_GRASS = new THREE.Color("#4a7c4a");
const TERRAIN_COLOR_DIRT = new THREE.Color("#8a6d4a");
const TERRAIN_COLOR_SAND = new THREE.Color("#d9c58a");
const TERRAIN_COLOR_ROCK = new THREE.Color("#767068");
const TERRAIN_COLOR_SNOW = new THREE.Color("#f2f2f2");

// Grass near sea level fading to dirt as elevation rises, skewed toward
// sand in desert biomes regardless of elevation, and toward bare rock —
// snow-capped at the very top — at real altitude regardless of biome
// (a tall enough peak reads as rock/snow even inside an otherwise "hill"
// region, same as real mountains).
function terrainColorAt(height, biome) {
  const color = TERRAIN_COLOR_GRASS.clone();
  color.lerp(TERRAIN_COLOR_DIRT, terrainSmooth01(height / 3));
  color.lerp(TERRAIN_COLOR_SAND, terrainSmooth01((0.4 - biome) / 0.15));
  color.lerp(TERRAIN_COLOR_ROCK, terrainSmooth01((height - 5) / 4));
  color.lerp(TERRAIN_COLOR_SNOW, terrainSmooth01((height - 10) / 3));
  return color;
}

// Ocean half-extent — vastly bigger than the island itself (see
// ARENA_HALF_X/Z) so its own outer edge can never be reached at any zoom
// level; a flat plane this size costs nothing extra to render regardless.
const OCEAN_HALF_EXTENT = 2000;

// Vertex spacing on the displaced ground mesh below — 128 segments across
// a ~166-unit island is a little under 1.3 units/vertex, smooth enough for
// hills/mountains to read as real curved terrain rather than faceted
// blocks, without pushing vertex count (129² ≈ 16.6k) anywhere near a real
// cost for a one-time build.
const TERRAIN_MESH_SEGMENTS = 128;

function buildGround(scene) {
  const groundWidth = (ARENA_HALF_X + 3) * 2;
  const groundDepth = (ARENA_HALF_Z + 3) * 2;
  const geometry = new THREE.PlaneGeometry(groundWidth, groundDepth, TERRAIN_MESH_SEGMENTS, TERRAIN_MESH_SEGMENTS);
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    // PlaneGeometry's own vertices start flat in local (x, y, 0) — rotating
    // by -Math.PI/2 around X below is what turns this into a horizontal
    // ground plane, and per this project's own established convention for
    // that exact rotation (see e.g. buildTambayanPlazaGeometry's own
    // comment), it maps local x -> world x unchanged, local y -> world -z,
    // and (whatever we set this vertex's own local z to right here) ->
    // world y. So: sample terrain height at the vertex's real WORLD x/z,
    // then store it in local z for the rotation to turn into world height.
    const localX = positions.getX(i);
    const localY = positions.getY(i);
    const worldX = localX;
    const worldZ = -localY;
    const height = terrainHeight(worldX, worldZ);
    positions.setZ(i, height);
    const biome = terrainBiomeValue(worldX, worldZ);
    const color = terrainColorAt(height, biome);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.computeVertexNormals();
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const ground = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true }),
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
// between the camera and the character this frame. Reads the box's own
// baseY/wallHeight (see buildTownWallSegment) rather than a hardcoded
// [0, TOWN_WALL_HEIGHT] range, since an upper Glophics floor's walls sit at
// a raised baseY and, for floor 2, a taller wallHeight than the ground
// floor's own walls.
function segmentIntersectsWallBox(x0, y0, z0, x1, y1, z1, box) {
  const baseY = box.baseY ?? 0;
  const wallHeight = box.wallHeight ?? TOWN_WALL_HEIGHT;
  const minB = [box.minX, baseY, box.minZ];
  const maxB = [box.maxX, baseY + wallHeight, box.maxZ];
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

// baseY raises the whole wall segment onto an upper floor (0 = ground,
// the only case before the Glophics tower existed) — the geometry/height
// itself never changes, just where its vertical center sits. color lets an
// upper floor use a different wall material than the ground floor's own
// TOWN_WALL_COLOR (see GLOPHICS_FLOORS' own wallColor).
function buildTownWallSegment(scene, minX, maxX, minZ, maxZ, wallSegments, baseY = 0, color = TOWN_WALL_COLOR, wallHeight = TOWN_WALL_HEIGHT) {
  // Solid/opaque by default — see updateTownWallFade, which is the only
  // thing that ever touches a GROUND-FLOOR segment's opacity/transparent
  // flag afterward (only for the segment(s) actually blocking the view of
  // your own character) — upper floors are instead faded as a whole group
  // by applyGlophicsFloorCutaway, never per-segment like this.
  // wallHeight defaults to TOWN_WALL_HEIGHT for every existing caller
  // (ground floor, Karirs, Luba) — floor 2 passes its own taller value (see
  // GLOPHICS_FLOORS' own wallHeight field) so its walls/ceiling can differ
  // from the ground floor's without a second copy of this function.
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(maxX - minX, wallHeight, maxZ - minZ),
    new THREE.MeshStandardMaterial({ color }),
  );
  mesh.position.set((minX + maxX) / 2, baseY + wallHeight / 2, (minZ + maxZ) / 2);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  wallSegments.push({ mesh, minX, maxX, minZ, maxZ, baseY, wallHeight, faded: false });
}

function buildTownDoorPost(scene, x, z, baseY = 0) {
  const size = TOWN_WALL_THICKNESS + 0.3;
  const height = TOWN_WALL_HEIGHT * 1.15; // a touch taller than the walls, so the doorway actually reads as one
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size, height, size),
    new THREE.MeshStandardMaterial({ color: TOWN_DOOR_POST_COLOR }),
  );
  mesh.position.set(x, baseY + height / 2, z);
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
// Generic "translucent so it doesn't block the view" toggle over an
// arbitrary THREE.Group — the mechanics setRigTransparent (inside mount())
// wraps for a character rig's own .group, generalized here to module scope
// since applyGlophicsFloorCutaway needs to apply the exact same treatment
// to plain scenery groups (an upper Glophics floor's walls+slab, or the
// roof) that were never built via buildBlockyCharacter. Only meshes are
// touched, same as disposeRig's own mesh-only traversal.
function setGroupTransparent(group, on) {
  group.traverse((obj) => {
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

// A full, hard removal — used by applyGlophicsFloorCutaway instead of
// setGroupTransparent above, since a floor-above-you being merely 30%
// see-through (setGroupTransparent's own opacity) still reads as "there,
// just faint" rather than actually gone. This is a discrete state flip
// (a floor change is a one-off event, not something re-evaluated every
// frame the way the wall-occlusion fade is), so there's no need for the
// smooth opacity lerp that mechanic uses — just hide the whole group
// outright. setGroupTransparent itself is untouched and still used as-is
// for the battle-avatar fade (setRigTransparent/setLocalTransparent),
// which really does want a translucent "still there, just faded" look,
// not a hard disappearance.
function setGroupHidden(group, hidden) {
  group.visible = !hidden;
}

// posts, centered on (centerX, centerZ) with the given half-extent (a
// square footprint, same on both axes) — shared by both Glophics
// (buildTown) and the Karirs field (buildKarirsField) so the two walled
// areas' segments end up in the very same wallSegments array, meaning
// isInsideTownWalls/updateTownWallFade automatically cover both without
// knowing there's more than one.
// baseY/color let this same builder produce an upper Glophics floor's own
// walls (see buildGlophicsFloor) — raised onto that floor's own Y, in that
// floor's own wall color — without duplicating any of the door-gap layout
// math below. Every other caller (buildTown's ground floor, the Karirs
// field, the Luba area) just leans on the baseY=0/color=TOWN_WALL_COLOR
// defaults, so this is a pure generalization, not a behavior change for them.
// wallHeight/hasDoors are the same kind of opt-in generalization, added for
// floor 2's own request: doubled ceiling height, and no doorways at all
// (only reachable via the stairs) — hasDoors=false skips the gap/door-post
// layout entirely and just builds each side as one continuous solid wall.
function buildAreaWalls(scene, centerX, centerZ, half, wallSegments, baseY = 0, color = TOWN_WALL_COLOR, wallHeight = TOWN_WALL_HEIGHT, hasDoors = true) {
  const H = half;
  const T = TOWN_WALL_THICKNESS;
  const D = TOWN_DOOR_HALF_WIDTH;
  const postOffset = D + T / 2 + 0.2;

  if (!hasDoors) {
    // Four full, ungapped walls — nothing to walk through, matching the
    // ask that floor 2 only ever be reachable via the stairs.
    for (const zOff of [-H, H]) {
      const z = centerZ + zOff;
      buildTownWallSegment(scene, centerX - H, centerX + H, z - T / 2, z + T / 2, wallSegments, baseY, color, wallHeight);
    }
    for (const xOff of [-H, H]) {
      const x = centerX + xOff;
      buildTownWallSegment(scene, x - T / 2, x + T / 2, centerZ - H, centerZ + H, wallSegments, baseY, color, wallHeight);
    }
    return;
  }

  // North/south walls — split along x around the doorway.
  for (const zOff of [-H, H]) {
    const z = centerZ + zOff;
    buildTownWallSegment(scene, centerX - H, centerX - D, z - T / 2, z + T / 2, wallSegments, baseY, color, wallHeight);
    buildTownWallSegment(scene, centerX + D, centerX + H, z - T / 2, z + T / 2, wallSegments, baseY, color, wallHeight);
    buildTownDoorPost(scene, centerX - postOffset, z, baseY);
    buildTownDoorPost(scene, centerX + postOffset, z, baseY);
  }
  // East/west walls — split along z around the doorway.
  for (const xOff of [-H, H]) {
    const x = centerX + xOff;
    buildTownWallSegment(scene, x - T / 2, x + T / 2, centerZ - H, centerZ - D, wallSegments, baseY, color, wallHeight);
    buildTownWallSegment(scene, x - T / 2, x + T / 2, centerZ + D, centerZ + H, wallSegments, baseY, color, wallHeight);
    buildTownDoorPost(scene, x, centerZ - postOffset, baseY);
    buildTownDoorPost(scene, x, centerZ + postOffset, baseY);
  }
}

// One above-ground Glophics floor: its own walls (same X/Z footprint as
// the ground floor, see buildAreaWalls) plus a floor slab, all parented
// under one THREE.Group so applyGlophicsFloorCutaway can fade the entire
// floor transparent/opaque as a single unit rather than walking every mesh
// in the scene by hand. Pushes this floor's own wall segments into
// wallSegmentsByFloor[floor.index] — a SEPARATE array from every other
// floor's — so isInsideTownWalls only ever tests the one array that
// actually matters for whichever floor the player is standing on.
function buildGlophicsFloor(scene, floor, wallSegmentsByFloor) {
  const group = new THREE.Group();
  scene.add(group);
  const segments = [];
  // group.add works exactly like scene.add here (both are THREE.Object3D) —
  // buildAreaWalls/buildTownWallSegment/buildTownDoorPost don't need to know
  // or care which one they were handed.
  buildAreaWalls(group, 0, 0, TOWN_HALF_X, segments, floor.y, floor.wallColor, floor.wallHeight ?? TOWN_WALL_HEIGHT, floor.hasDoors ?? true);
  wallSegmentsByFloor[floor.index] = segments;

  const slab = new THREE.Mesh(
    new THREE.PlaneGeometry(TOWN_HALF_X * 2, TOWN_HALF_Z * 2),
    new THREE.MeshStandardMaterial({ color: floor.floorColor }),
  );
  slab.rotation.x = -Math.PI / 2;
  slab.position.y = floor.y + 0.015; // same z-fighting offset the ground plaza uses below
  slab.receiveShadow = true;
  slab.castShadow = true; // this slab is also the ceiling of the floor below it
  group.add(slab);

  return group;
}

// The tower's cap — a flat slab at GLOPHICS_ROOF_Y, same footprint (plus a
// small overhang) as every floor below it. Its own group, so it fades via
// applyGlophicsFloorCutaway exactly like an upper floor's group does (see
// GLOPHICS_ROOF_INDEX).
function buildGlophicsRoof(scene) {
  const group = new THREE.Group();
  scene.add(group);
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(TOWN_HALF_X * 2 + TOWN_WALL_THICKNESS * 2, 0.3, TOWN_HALF_Z * 2 + TOWN_WALL_THICKNESS * 2),
    new THREE.MeshStandardMaterial({ color: GLOPHICS_ROOF_COLOR }),
  );
  roof.position.y = GLOPHICS_ROOF_Y;
  roof.castShadow = true;
  roof.receiveShadow = true;
  group.add(roof);
  return group;
}

// A small canvas-texture ground decal (UP/DOWN, color-coded) for a stair
// tile — same canvas-texture technique buildTownSign/buildKarirsBoardSign
// already use, just laid flat instead of billboarded, and deliberately
// simple (a colored square + a border + a text label) rather than a real
// modeled staircase, matching this session's "don't over-engineer the
// visual" instruction.
function buildStairsTileTexture(label, color) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx2d = canvas.getContext("2d");
  ctx2d.fillStyle = color;
  ctx2d.fillRect(0, 0, canvas.width, canvas.height);
  ctx2d.strokeStyle = "rgba(0,0,0,0.55)";
  ctx2d.lineWidth = 8;
  ctx2d.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  ctx2d.fillStyle = "rgba(0,0,0,0.8)";
  ctx2d.font = "bold 30px sans-serif";
  ctx2d.textAlign = "center";
  ctx2d.textBaseline = "middle";
  ctx2d.fillText(label, canvas.width / 2, canvas.height / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

// 2 tiles per entry in GLOPHICS_STAIR_TRANSITIONS (an "up" tile on the
// lower floor, a "down" tile at the same X/Z on the floor above) — see
// checkStairsContact for the actual proximity-triggered floor change these
// are purely a visual cue for. Each tile is parented under its OWN floor's
// group (falling back to the scene directly for the ground floor, which
// has no group of its own to fade) so it fades/hides in lockstep with the
// rest of that floor if that floor is ever faded.
function buildGlophicsStairs(scene, glophicsFloorGroups) {
  const groupForFloor = (floorIndex) => glophicsFloorGroups.find((f) => f.index === floorIndex)?.group;
  for (const t of GLOPHICS_STAIR_TRANSITIONS) {
    const upTile = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 1.4),
      new THREE.MeshBasicMaterial({ map: buildStairsTileTexture("UP", "#f2c94c") }),
    );
    upTile.rotation.x = -Math.PI / 2;
    upTile.position.set(t.x, t.belowY + 0.02, t.z);
    (groupForFloor(t.belowFloor) || scene).add(upTile);

    const downTile = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 1.4),
      new THREE.MeshBasicMaterial({ map: buildStairsTileTexture("DOWN", "#f2994a") }),
    );
    downTile.rotation.x = -Math.PI / 2;
    downTile.position.set(t.x, t.aboveY + 0.02, t.z);
    (groupForFloor(t.aboveFloor) || scene).add(downTile);
  }
}

// The actual cinema screen — a real YouTube <iframe> wrapped in a
// CSS3DObject (see CINEMA_YOUTUBE_VIDEO_ID's own comment for why this can't
// just be a textured WebGL mesh). Returns both the CSS3DObject (to add to
// mount()'s own cssScene) and the raw iframe element (so mount()'s cleanup
// can blank its src before removal — see that comment for why that matters).
function buildCinemaScreenObject() {
  const iframe = document.createElement("iframe");
  iframe.width = String(CINEMA_SCREEN_PIXEL_WIDTH);
  iframe.height = String(CINEMA_SCREEN_PIXEL_HEIGHT);
  iframe.src = CINEMA_YOUTUBE_EMBED_URL;
  iframe.style.border = "0";
  iframe.allow = "autoplay; encrypted-media";
  // Baseline safety net now that the projectionist can point this at ANY
  // http(s) URL, not just a fixed known-safe YouTube embed: allow-scripts
  // (needed for embedded players, including YouTube's own, to run at all)
  // + allow-same-origin (needed for a site's own embed to use its own
  // storage/fetch the way it normally would — without it lots of embeds,
  // YouTube included, silently break) + allow-presentation (fullscreen/
  // Picture-in-Picture, harmless). Deliberately NOT allow-top-navigation or
  // allow-popups — an arbitrary embedded page has no business hijacking
  // this game's own tab or spawning popups, sandboxed or not. This trio is
  // expected to leave the existing YouTube embed's autoplay/loop/
  // enablejsapi behavior intact — sandboxing an iframe never blocks
  // postMessage delivered TO it from the parent, which is all
  // sendCinemaScreenCommand above ever needs — but this has NOT been
  // click-tested in a live browser session; if YouTube's own autoplay ever
  // regresses, allow-same-origin is the first flag to double-check (some
  // embeds also want allow-forms for their own settings gear, which this
  // deliberately leaves out unless it turns out to be needed).
  iframe.sandbox = "allow-scripts allow-same-origin allow-presentation";

  const cssObject = new CSS3DObject(iframe);
  cssObject.position.set(
    CINEMA_SCREEN_X,
    glophicsFloorY(CINEMA_SCREEN_FLOOR_INDEX) + CINEMA_SCREEN_Y_OFFSET,
    CINEMA_SCREEN_Z,
  );
  // No rotation needed: a CSS3DObject's own default (unrotated) orientation
  // already faces +Z, and floor 2's south wall (z = -TOWN_HALF_Z) faces
  // straight into the room along +Z too — they already line up. If this
  // screen ever moves to a different wall, rotation.y would need to be set
  // to that wall's own inward-facing normal angle instead.
  cssObject.scale.set(
    CINEMA_SCREEN_WORLD_WIDTH / CINEMA_SCREEN_PIXEL_WIDTH,
    CINEMA_SCREEN_WORLD_HEIGHT / CINEMA_SCREEN_PIXEL_HEIGHT,
    1,
  );
  return { cssObject, iframe };
}

// A handful of plain bench-row boxes facing the cinema screen — purely
// decorative, deliberately modest (3 boxes, not a modeled theater). Called
// directly from buildTown for floor 2's own group specifically rather than
// folded into buildGlophicsFloor's generic per-floor builder, since this is
// a one-off floor-2 decoration (like Jared's shop or Rodz on the ground
// floor), not something a future floor 3 should automatically inherit.
// Rows sit at z = -1/1/3 — clear of both the screen (CINEMA_SCREEN_Z, well
// behind them in -Z) and the stairs landing (world (6, ~4.6), see
// GLOPHICS_STAIRS_X/Z) since every row's own x is centered on
// CINEMA_SCREEN_X (-5), nowhere near x = 6.
const CINEMA_SEAT_ROW_Z = [-1, 1, 3];
const CINEMA_SEAT_COLOR = "#2b2b33";
function buildCinemaSeats(group, floorY) {
  for (const z of CINEMA_SEAT_ROW_Z) {
    const bench = new THREE.Mesh(
      new THREE.BoxGeometry(4, 0.5, 0.6),
      new THREE.MeshStandardMaterial({ color: CINEMA_SEAT_COLOR }),
    );
    bench.position.set(CINEMA_SCREEN_X, floorY + 0.27, z);
    bench.castShadow = true;
    bench.receiveShadow = true;
    group.add(bench);
  }
}

// The Usher — a normal clickable NPC rig (see USHER_NAME's own comment for
// why he's positioned where he is), but unlike Rodz/Jared/Karra/Boss Rick
// he's built here, inside buildTown, rather than later in mount() — those
// other NPCs are added straight to `scene` since they live on the ground
// floor, which is never faded; the Usher lives on floor 2 and needs to
// fade/reappear in lockstep with the rest of that floor (seats, walls,
// screen) via applyGlophicsFloorCutaway, which only ever walks
// glophicsFloorGroups' own group hierarchies — so his rig's .group has to
// be parented under cinemaFloorGroup at construction time, exactly like
// buildCinemaSeats' benches just above. Returns the rig itself (not void,
// unlike buildCinemaSeats) since mount() still needs it for click/
// proximity/highlight/name-label handling, the same as every other NPC rig.
function buildCinemaUsher(group, floorY) {
  const rig = buildBlockyCharacter(USHER_COLORS, USHER_NAME);
  rig.group.position.set(USHER_X, floorY, USHER_Z);
  group.add(rig.group);
  return rig;
}

// Builds Glophics: its ground floor (four walls/doors via buildAreaWalls, a
// distinct plaza floor patch, the name sign — see TOWN_HALF_X/Z and
// friends above), every above-ground floor and the roof (see
// GLOPHICS_FLOORS/buildGlophicsFloor/buildGlophicsRoof), and the stairs
// connecting them (buildGlophicsStairs). Returns:
//   - wallSegmentsByFloor: {0: [...], 1: [...], ...} — floor index ->
//     world-space box+mesh wall segments, used both by movement resolution
//     (isInsideTownWalls) and, for floor 0 only, the camera-occlusion fade
//     (updateTownWallFade — see that function's own comment for why it
//     stays scoped to the ground floor).
//   - glophicsFloorGroups: [{index, group}, ...] for every ABOVE-ground
//     floor plus the roof (never floor 0 — the ground floor is never
//     faded) — what applyGlophicsFloorCutaway iterates.
function buildTown(scene) {
  const wallSegmentsByFloor = { 0: [] };
  buildAreaWalls(scene, 0, 0, TOWN_HALF_X, wallSegmentsByFloor[0]);

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

  const glophicsFloorGroups = GLOPHICS_FLOORS.map((floor) => ({
    index: floor.index,
    group: buildGlophicsFloor(scene, floor, wallSegmentsByFloor),
  }));
  glophicsFloorGroups.push({ index: GLOPHICS_ROOF_INDEX, group: buildGlophicsRoof(scene) });
  buildGlophicsStairs(scene, glophicsFloorGroups);

  // Floor 2's cinema theming (seats only — the actual screen is a separate
  // CSS3D DOM layer, built/wired up by mount() itself, not here — see
  // buildCinemaScreenObject). Parented under floor 2's own group so it
  // fades/reappears in lockstep with the rest of that floor via
  // applyGlophicsFloorCutaway, same as everything else built into it.
  const cinemaFloor = GLOPHICS_FLOORS.find((f) => f.index === CINEMA_SCREEN_FLOOR_INDEX);
  const cinemaFloorGroup = glophicsFloorGroups.find((f) => f.index === CINEMA_SCREEN_FLOOR_INDEX)?.group;
  let cinemaUsherRig = null;
  if (cinemaFloor && cinemaFloorGroup) {
    buildCinemaSeats(cinemaFloorGroup, cinemaFloor.y);
    cinemaUsherRig = buildCinemaUsher(cinemaFloorGroup, cinemaFloor.y);
  }

  return { wallSegmentsByFloor, glophicsFloorGroups, sign, cinemaUsherRig };
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
  return sign;
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

// The real racetrack (see KARIRS_TRACK_* constants' own comment) — just a
// clay strip (reusing KARIRS_FIELD_COLOR for a matching theme), lane
// dividers, and start/finish crossbars. No walls, no collision — purely
// decorative ground detail a player can freely walk across, same as any
// other flat floor patch in this file.
function buildKarirsTrack(scene) {
  const centerZ = (KARIRS_TRACK_START_Z + KARIRS_TRACK_FINISH_Z) / 2;
  const trackLength = KARIRS_TRACK_START_Z - KARIRS_TRACK_FINISH_Z;

  const dirt = new THREE.Mesh(
    new THREE.PlaneGeometry(KARIRS_TRACK_WIDTH, trackLength),
    new THREE.MeshStandardMaterial({ color: KARIRS_FIELD_COLOR }),
  );
  dirt.rotation.x = -Math.PI / 2;
  dirt.position.set(KARIRS_FIELD_X, 0.01, centerZ);
  dirt.receiveShadow = true;
  scene.add(dirt);

  // One more divider than there are lanes — fences both edges too, not
  // just the gaps between racers.
  const laneLineMat = new THREE.MeshBasicMaterial({ color: "#f5f5f4" });
  for (let i = 0; i <= KARIRS_TRACK_LANE_COUNT; i++) {
    const x = KARIRS_FIELD_X + (i - KARIRS_TRACK_LANE_COUNT / 2) * KARIRS_TRACK_LANE_SPACING;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.08, trackLength), laneLineMat);
    line.rotation.x = -Math.PI / 2;
    line.position.set(x, 0.02, centerZ);
    scene.add(line);
  }

  const startLine = new THREE.Mesh(
    new THREE.PlaneGeometry(KARIRS_TRACK_WIDTH, 0.4),
    new THREE.MeshBasicMaterial({ color: "#f5f5f4" }),
  );
  startLine.rotation.x = -Math.PI / 2;
  startLine.position.set(KARIRS_FIELD_X, 0.02, KARIRS_TRACK_START_Z);
  scene.add(startLine);

  const finishLine = new THREE.Mesh(
    new THREE.PlaneGeometry(KARIRS_TRACK_WIDTH, 0.4),
    new THREE.MeshBasicMaterial({ color: "#facc15" }),
  );
  finishLine.rotation.x = -Math.PI / 2;
  finishLine.position.set(KARIRS_FIELD_X, 0.02, KARIRS_TRACK_FINISH_Z);
  scene.add(finishLine);
}

const KARIRS_RACER_COLORS = ["#f59e0b", "#3b82f6", "#ef4444", "#10b981"];

// Rig + gait ported from games/karirs/client/src/render3d.js's own
// buildRacerRig/update (itself a port of the web app's render3d.ts — see
// that file's own header) — same constants, same math, minus the parts
// with no equivalent data here: no per-racer face photo (faceImageUrl/
// faceDecal), no bet-marker torus, and no "shouting"/signature-move ninja
// pose or chat bubble, since main.py's own step_race only ever yields
// {positions}, never a per-step shouting flag the way games/karirs' own
// separate race engine does — there is nothing here to drive that pose
// with. The core "how a racer's own instantaneous speed drives idle vs.
// walk vs. sprint vs. exhausted" gait is unchanged from the source.
const KARIRS_GAIT_SPRINT_SPEED = 6.7; // race.py's SPEED_RANGE tops out at 2.0/~300ms tick ≈ 6.7/sec — "full sprint" for normalizing
const KARIRS_GAIT_STOP_SPEED_THRESHOLD = 0.35;
const KARIRS_GAIT_WALK_FREQUENCY = 3.5;
const KARIRS_GAIT_SPRINT_FREQUENCY = 9;
const KARIRS_GAIT_SPRINT_STRIDE = 0.55;
const KARIRS_GAIT_SPRINT_BOUNCE = 0.12;
const KARIRS_GAIT_HEAD_BOB = 0.055;
const KARIRS_GAIT_EXHAUSTED_SPEED_THRESHOLD = 1.4;
const KARIRS_GAIT_EXHAUSTED_LEAN = 0.38;
const KARIRS_GAIT_EXHAUSTED_HEAD_DROOP = 0.22;
const KARIRS_GAIT_EXHAUSTED_ARM_FORWARD = -1.05;
const KARIRS_GAIT_EXHAUSTED_TREMBLE = 0.06;
const KARIRS_GAIT_EXHAUSTED_BREATH_FREQUENCY = 2.6;
const KARIRS_GAIT_EXHAUSTED_BREATH_AMPLITUDE = 0.05;
const KARIRS_GAIT_POSE_EASE_RATE = 4;
const KARIRS_RACER_TORSO_Y = 0.82;

// One lane's own runner — a real humanoid rig (torso/head/two arms/two
// legs with hands and shoes, not a placeholder capsule), plus a
// redrawable name-label sprite above it, same canvas-texture-redraw
// technique buildKarirsBoardSign already uses for the bulletin board (the
// racer occupying a given lane changes every race, so the label has to be
// redrawable in place, not a one-shot buildTownSign-style sprite).
//
// Built facing local +Z, legs/arms swinging in the local YZ (fore-aft)
// plane — same convention render3d.js's own buildRacerRig uses — then
// rotated 180° (not that source's own 90°, since its track runs along
// world +X and this one runs along world -Z) so "facing forward" actually
// means "facing the finish line" for this track's own orientation.
function buildKarirsRacerRig(scene, color) {
  const group = new THREE.Group();
  group.rotation.y = Math.PI;

  const torsoMaterial = new THREE.MeshStandardMaterial({ color });
  const torso = new THREE.Mesh(new RoundedBoxGeometry(0.7, 0.9, 0.46, 3, 0.09), torsoMaterial);
  const torsoTop = KARIRS_RACER_TORSO_Y + 0.9 / 2;
  torso.position.y = KARIRS_RACER_TORSO_Y;
  torso.castShadow = true;
  group.add(torso);

  // Child of the torso, not the group, so the exhausted lean (torso.rotation.x)
  // carries the head along with it instead of leaving it locked upright
  // while the torso tilts out from under it.
  const headMaterial = new THREE.MeshStandardMaterial({ color });
  const headSize = 0.62;
  const headBaseY = torsoTop + headSize / 2 - torso.position.y;
  const head = new THREE.Mesh(new RoundedBoxGeometry(headSize, headSize, headSize, 3, 0.07), headMaterial);
  head.position.y = headBaseY;
  head.castShadow = true;
  torso.add(head);

  const eyeMaterial = new THREE.MeshBasicMaterial({ color: "#171717" });
  const eyeGeometry = new THREE.SphereGeometry(0.05, 8, 8);
  const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
  leftEye.position.set(-0.13, 0.03, headSize / 2 + 0.01);
  const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
  rightEye.position.set(0.13, 0.03, headSize / 2 + 0.01);
  head.add(leftEye, rightEye);

  const limbMaterial = new THREE.MeshStandardMaterial({ color: "#262626" });
  const shoeMaterial = new THREE.MeshStandardMaterial({ color: "#f5f5f5" });
  const handMaterial = new THREE.MeshStandardMaterial({ color });
  function limb(w, h, d, x, y, cap) {
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(w, d) * 0.25), limbMaterial);
    mesh.position.set(x, y, 0);
    // Pivot at the top (hip/shoulder), not center, so rotating swings the
    // limb like a real joint instead of clipping through the torso.
    mesh.geometry.translate(0, -h / 2, 0);
    mesh.castShadow = true;
    const capMesh =
      cap === "shoe"
        ? new THREE.Mesh(new RoundedBoxGeometry(w * 1.2, h * 0.22, d * 1.5, 2, 0.03), shoeMaterial)
        : new THREE.Mesh(new THREE.SphereGeometry(w * 0.62, 10, 8), handMaterial);
    capMesh.position.set(0, cap === "shoe" ? -h + (h * 0.22) / 2 : -h, cap === "shoe" ? d * 0.18 : 0);
    capMesh.castShadow = true;
    mesh.add(capMesh);
    return mesh;
  }
  const leftLeg = limb(0.22, 0.56, 0.22, -0.18, 0.38, "shoe");
  const rightLeg = limb(0.22, 0.56, 0.22, 0.18, 0.38, "shoe");
  const leftArm = limb(0.16, 0.46, 0.16, -0.43, 1.2, "hand");
  const rightArm = limb(0.16, 0.46, 0.16, 0.43, 1.2, "hand");
  group.add(leftLeg, rightLeg, leftArm, rightArm);

  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx2d = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const labelMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const label = new THREE.Sprite(labelMaterial);
  label.renderOrder = 999;
  label.scale.set(1.6, 0.4, 1);
  label.position.y = 2.15; // matches render3d.js's own name-sprite height above its identical rig
  group.add(label);

  group.position.set(KARIRS_FIELD_X, 0, KARIRS_TRACK_START_Z);
  scene.add(group);
  return {
    group,
    torso,
    torsoMaterial,
    head,
    headBaseY,
    leftLeg,
    rightLeg,
    leftArm,
    rightArm,
    canvas,
    ctx: ctx2d,
    texture,
    label,
    currentName: null,
    z: KARIRS_TRACK_START_Z,
    // Gait state — see updateKarirsTrackVisual's own per-frame block,
    // ported from render3d.js's update() almost line-for-line.
    prevPos: NaN,
    gaitPhase: 0,
    exhaustedBlend: 0,
  };
}

function updateKarirsRacerLabel(marker, name) {
  const { canvas, ctx: ctx2d, texture } = marker;
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  ctx2d.fillStyle = "rgba(0,0,0,0.6)";
  ctx2d.fillRect(0, 0, canvas.width, canvas.height);
  ctx2d.fillStyle = "#ffffff";
  ctx2d.font = "bold 28px sans-serif";
  ctx2d.textAlign = "center";
  ctx2d.textBaseline = "middle";
  ctx2d.fillText(name, canvas.width / 2, canvas.height / 2);
  texture.needsUpdate = true;
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

  return { sign };
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
// distinct pentagon plaza floor, a name sign, and all three chess tables
// (two player-hosted, one a standing AI match — see AI_BOARD_ID).
// Returns each table's group+status-sign for later raycast/highlight/
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
  const board3 = buildChessTable(scene, CHESS_BOARD_3_X, CHESS_BOARD_3_Z, 0);

  return {
    board1Group: board1.group, board1StatusSign: board1.statusSign,
    board2Group: board2.group, board2StatusSign: board2.statusSign,
    board3Group: board3.group, board3StatusSign: board3.statusSign,
  };
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

  // No longer shown anywhere (see devMenuPanelEl's own comment below) — the
  // element/its startTeamBattle wiring stay intact since nothing else
  // depends on removing them, just unreachable from any menu now.
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
  // canvas's own cap, leaving right-anchored overlays (like the wild's HP
  // HUD) sitting well outside the canvas's actual visible area. The cap
  // itself is generous (was 720px) rather than removed outright — this is
  // a per-frame-resized WebGL canvas (see frame()'s own renderer.setSize),
  // so it genuinely renders sharper at a bigger size rather than just
  // stretching a fixed image, but an *unbounded* one would still render at
  // a needlessly huge resolution on a very wide monitor once the chat log
  // is hidden (see /chats hide) and this becomes the panel's only content.
  canvasWrapEl.style.width = "100%";
  canvasWrapEl.style.maxWidth = "1400px";
  wrap.appendChild(canvasWrapEl);

  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  canvas.style.width = "100%";
  canvas.style.maxWidth = "1400px";
  canvas.style.display = "block";
  canvas.style.borderRadius = "4px";
  canvasWrapEl.appendChild(canvas);

  // CSS3D overlay — a second, DOM-based render layer sitting exactly over
  // the WebGL canvas, used only for the floor-2 cinema screen's real
  // YouTube <iframe> (see CINEMA_YOUTUBE_VIDEO_ID/buildCinemaScreenObject).
  // Absolutely positioned to match the canvas's own rect exactly, resized
  // in lockstep with it down in frame() (see that function's own
  // cssRenderer.setSize call, right next to renderer.setSize). pointer-
  // events:none on the container itself is important — without it this
  // layer would sit on top of the canvas and swallow clicks meant for the
  // game's own canvas-raycast interactions (NPCs, chess boards, etc.); the
  // video has nothing to click anyway (controls=0, autoplay+loop).
  const cssRenderer = new CSS3DRenderer();
  cssRenderer.domElement.style.position = "absolute";
  cssRenderer.domElement.style.top = "0";
  cssRenderer.domElement.style.left = "0";
  cssRenderer.domElement.style.pointerEvents = "none";
  cssRenderer.setSize(canvas.width, canvas.height);
  canvasWrapEl.appendChild(cssRenderer.domElement);
  // A separate, minimal scene just for CSS3DObjects — CSS3DRenderer only
  // needs its target(s) to live in *a* THREE.Scene for its own traversal,
  // it doesn't need to share the main WebGL `scene` at all.
  const cssScene = new THREE.Scene();
  const cinemaScreen = buildCinemaScreenObject();
  cssScene.add(cinemaScreen.cssObject);
  // Tracks the CSS3D layer's own shown/hidden state so frame() only ever
  // touches domElement.style.display on an actual change — see
  // cinemaScreenVisible in frame() for the exact gating conditions
  // (floor >= CINEMA_SCREEN_FLOOR_INDEX, and no battle of any kind active).
  // A per-frame occlusion raycast against the player's own rig used to also
  // factor into this (hiding the screen whenever the player stood in front
  // of it, so their character wouldn't render "behind" it) — removed by
  // explicit request after it caused a severe bug (a client resuming
  // directly on floor 1 could hit it before the player's rig had a valid
  // world matrix yet, throwing and freezing the entire game). Simpler and
  // safer to just always show the screen while on floor 2, same as before
  // that feature ever existed.
  let cinemaScreenShown = true;
  // The cinema's actual current screen URL — starts at the same default
  // both this client and the api's own CINEMA_DEFAULT_SCREEN_URL fall back
  // to, then kept in sync with the shared, server-owned value via
  // cinema_screen_state (see onSocketMessage) for as long as this session
  // stays connected. Read by isYoutubeEmbedUrl's own call sites below to
  // decide whether sendCinemaScreenCommand's YouTube-only postMessage
  // protocol is even worth attempting.
  let cinemaScreenUrl = CINEMA_YOUTUBE_EMBED_URL;
  // Who currently holds the cinema's projectionist role — {user_id,
  // display_name}, or null while it's vacant. Kept in sync with the
  // shared, server-owned cinema_projectionist via cinema_projectionist_state
  // (see onSocketMessage). Drives the Usher's own popup content entirely
  // (see renderUsherMenu) — this client never decides on its own who holds
  // the role, it only ever reflects the last thing the server said.
  let cinemaProjectionist = null;

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

  // The current area's own name, beside the minimap — "Plains" out in the
  // open world, or whichever real walled area (see AREA_LABELS/
  // updateAreaLabels) local.x/z is currently inside. Same small-badge look
  // as the minimap itself so the two read as one HUD cluster.
  const minimapAreaLabelEl = document.createElement("div");
  minimapAreaLabelEl.style.position = "absolute";
  minimapAreaLabelEl.style.top = "6px";
  minimapAreaLabelEl.style.left = `${MINIMAP_SIZE + 6 + 6}px`; // minimap's own left(6) + its width + a matching gap
  minimapAreaLabelEl.style.padding = "3px 8px";
  minimapAreaLabelEl.style.borderRadius = "4px";
  minimapAreaLabelEl.style.background = "#00000066";
  minimapAreaLabelEl.style.color = "#ffffffcc";
  minimapAreaLabelEl.style.fontSize = "11px";
  minimapAreaLabelEl.style.fontFamily = "inherit";
  minimapAreaLabelEl.style.pointerEvents = "none";
  minimapAreaLabelEl.style.zIndex = "15";
  minimapAreaLabelEl.textContent = "Plains";
  canvasWrapEl.appendChild(minimapAreaLabelEl);

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

  // The player's own trainer HP — always visible now (a wild mob can melee
  // this account's own body directly, out in the open world, any time —
  // there's no more separate battle screen to show it inside, see this
  // game's own plan file). Top-right, stacked directly above the G-coins
  // HUD (see gCoinsHudEl below, pushed down to top: 38px to make room) —
  // the single most glanceable corner for "is my own body in danger."
  const playerHpHudEl = document.createElement("div");
  playerHpHudEl.style.position = "absolute";
  playerHpHudEl.style.right = "6px";
  playerHpHudEl.style.top = "6px";
  playerHpHudEl.style.width = "140px";
  playerHpHudEl.style.background = "#1a1a1aee";
  playerHpHudEl.style.border = "1px solid #3333334d";
  playerHpHudEl.style.borderRadius = "4px";
  playerHpHudEl.style.padding = "4px 6px";
  playerHpHudEl.style.zIndex = "15";
  playerHpHudEl.style.fontSize = "10px";
  const playerHpLabelEl = document.createElement("span");
  playerHpLabelEl.style.display = "block";
  playerHpLabelEl.style.marginBottom = "2px";
  playerHpLabelEl.style.color = "#a3a3a3";
  playerHpHudEl.appendChild(playerHpLabelEl);
  const playerHpBarOuterEl = document.createElement("div");
  playerHpBarOuterEl.style.background = "#3333334d";
  playerHpBarOuterEl.style.borderRadius = "3px";
  playerHpBarOuterEl.style.height = "6px";
  playerHpBarOuterEl.style.overflow = "hidden";
  const playerHpBarFillEl = document.createElement("div");
  playerHpBarFillEl.style.height = "100%";
  playerHpBarFillEl.style.width = "100%";
  playerHpBarOuterEl.appendChild(playerHpBarFillEl);
  playerHpHudEl.appendChild(playerHpBarOuterEl);
  canvasWrapEl.appendChild(playerHpHudEl);

  function refreshPlayerHpHud() {
    const pct = Math.max(0, Math.min(100, (playerHp / PLAYER_MAX_HP) * 100));
    playerHpBarFillEl.style.width = `${pct}%`;
    playerHpBarFillEl.style.background = pct <= 25 ? "#ef4444" : pct <= 50 ? "#facc15" : "#4ade80";
    playerHpLabelEl.textContent = `HP ${playerHp}/${PLAYER_MAX_HP}`;
  }

  // The currently left-clicked wild (see onCanvasClick's own wild branch)
  // — id only, not a direct spawn reference, since the spawn itself can be
  // torn down (despawn/capture) out from under a stale reference at any
  // time; every read goes through wildSpawns.get(selectedWildId) fresh.
  // Selecting a mob is independent of having a companion summoned (unlike
  // companion_target, which is a no-op without one) — it only drives this
  // info panel and which mob "T" throws a Glophiball at.
  let selectedWildId = null;

  // Floating selected-mob info panel — top-center, shown only while a wild
  // is actually selected. Same inline-styled-div HUD convention as every
  // other overlay in this file (see playerHpHudEl above).
  const selectedWildHudEl = document.createElement("div");
  selectedWildHudEl.style.position = "absolute";
  selectedWildHudEl.style.left = "50%";
  selectedWildHudEl.style.top = "6px";
  selectedWildHudEl.style.transform = "translateX(-50%)";
  selectedWildHudEl.style.width = "180px";
  selectedWildHudEl.style.background = "#1a1a1aee";
  selectedWildHudEl.style.border = "1px solid #3333334d";
  selectedWildHudEl.style.borderRadius = "4px";
  selectedWildHudEl.style.padding = "4px 8px";
  selectedWildHudEl.style.zIndex = "15";
  selectedWildHudEl.style.fontSize = "11px";
  selectedWildHudEl.style.display = "none";
  selectedWildHudEl.style.textAlign = "center";
  const selectedWildNameEl = document.createElement("div");
  selectedWildNameEl.style.marginBottom = "2px";
  selectedWildHudEl.appendChild(selectedWildNameEl);
  const selectedWildHpBarOuterEl = document.createElement("div");
  selectedWildHpBarOuterEl.style.background = "#3333334d";
  selectedWildHpBarOuterEl.style.borderRadius = "3px";
  selectedWildHpBarOuterEl.style.height = "6px";
  selectedWildHpBarOuterEl.style.overflow = "hidden";
  const selectedWildHpBarFillEl = document.createElement("div");
  selectedWildHpBarFillEl.style.height = "100%";
  selectedWildHpBarFillEl.style.width = "100%";
  selectedWildHpBarOuterEl.appendChild(selectedWildHpBarFillEl);
  selectedWildHudEl.appendChild(selectedWildHpBarOuterEl);
  canvasWrapEl.appendChild(selectedWildHudEl);

  // Re-reads the live spawn every call (rather than trusting whatever was
  // true at selection time) — hp/level/species never go stale, and a
  // despawned/captured target (spawn no longer in wildSpawns) clears the
  // selection outright instead of leaving a panel pointed at nothing.
  function refreshSelectedWildHud() {
    const spawn = selectedWildId != null ? wildSpawns.get(selectedWildId) : null;
    if (!spawn) {
      selectedWildId = null;
      selectedWildHudEl.style.display = "none";
      return;
    }
    selectedWildHudEl.style.display = "block";
    selectedWildNameEl.textContent = `${spawn.species.name} Lv.${spawn.level}`;
    const pct = Math.max(0, Math.min(100, (spawn.hp / spawn.maxHp) * 100));
    selectedWildHpBarFillEl.style.width = `${pct}%`;
    selectedWildHpBarFillEl.style.background = pct <= 25 ? "#ef4444" : pct <= 50 ? "#facc15" : "#4ade80";
  }

  // Companion action bar — '1' is the summoned companion's basic melee
  // attack (see onKeyDown); slots 2-9 are reserved for future skills and
  // stay completely inert for now (see this game's own plan file).
  const actionBarEl = document.createElement("div");
  actionBarEl.style.position = "absolute";
  actionBarEl.style.left = "152px";
  actionBarEl.style.bottom = "6px";
  actionBarEl.style.display = "flex";
  actionBarEl.style.gap = "4px";
  actionBarEl.style.zIndex = "15";
  const actionSlot1El = document.createElement("div");
  actionSlot1El.textContent = "1";
  actionSlot1El.style.position = "relative"; // anchors actionSlot1CooldownEl below
  actionSlot1El.style.width = "28px";
  actionSlot1El.style.height = "28px";
  actionSlot1El.style.display = "flex";
  actionSlot1El.style.alignItems = "center";
  actionSlot1El.style.justifyContent = "center";
  actionSlot1El.style.background = "#1a1a1aee";
  actionSlot1El.style.border = "1px solid #3333334d";
  actionSlot1El.style.borderRadius = "4px";
  actionSlot1El.style.fontSize = "12px";
  actionSlot1El.title = "Companion attack";
  // The cooldown clock — a shrinking dark pie slice swept clockwise by a
  // conic-gradient (see refreshActionBar), covering the whole icon the
  // instant it's used and clearing back to nothing exactly when it's ready
  // again, like a rotating clock hand revealing the icon underneath.
  // pointer-events:none so it never steals the click/key the slot itself
  // responds to.
  const actionSlot1CooldownEl = document.createElement("div");
  actionSlot1CooldownEl.style.position = "absolute";
  actionSlot1CooldownEl.style.inset = "0";
  actionSlot1CooldownEl.style.borderRadius = "4px";
  actionSlot1CooldownEl.style.pointerEvents = "none";
  actionSlot1CooldownEl.style.display = "none";
  actionSlot1El.appendChild(actionSlot1CooldownEl);
  actionBarEl.appendChild(actionSlot1El);
  canvasWrapEl.appendChild(actionBarEl);

  // This client's own last-known speed stat for whichever Glophimon is
  // currently summoned (see showCompanionSummonModal) — null when nothing
  // is summoned. Purely local display state, same "mirrors the api's own
  // formula for instant feedback, server still the real authority" shape
  // as actionCooldownS itself.
  let companionActionSpeed = null;
  // performance.now()-keyed "ready again at" timestamp per action slot —
  // only slot 1 (Attack) is ever actually set today, but keyed by slot
  // number (not a single flat value) so a future skill on another slot
  // gets its own independent cooldown for free.
  const actionCooldownUntil = {};

  function refreshActionBar() {
    const summoned = companionSpawns.has(localUserId);
    actionSlot1El.style.opacity = summoned ? "1" : "0.4";

    const readyAt = actionCooldownUntil[1];
    const totalS = companionActionSpeed != null ? actionCooldownS(ACTION_WEIGHTS[1], companionActionSpeed) : null;
    const remainingMs = readyAt != null ? readyAt - performance.now() : 0;
    if (!summoned || totalS == null || remainingMs <= 0) {
      actionSlot1CooldownEl.style.display = "none";
    } else {
      const remainingFraction = Math.min(1, remainingMs / (totalS * 1000));
      actionSlot1CooldownEl.style.display = "block";
      actionSlot1CooldownEl.style.background = `conic-gradient(#000000cc ${remainingFraction * 360}deg, transparent ${remainingFraction * 360}deg)`;
    }
  }

  // A brief non-blocking toast for a capture attempt's own outcome (see
  // onSocketMessage's own wild_capture_result handling) — never a modal,
  // since capturing must never pause movement/gameplay the way Glophimon's
  // own turn-based catch animation used to.
  const captureToastEl = document.createElement("div");
  captureToastEl.style.position = "absolute";
  captureToastEl.style.left = "50%";
  captureToastEl.style.top = "72px";
  captureToastEl.style.transform = "translateX(-50%)";
  captureToastEl.style.background = "#1a1a1aee";
  captureToastEl.style.border = "1px solid #3333334d";
  captureToastEl.style.borderRadius = "4px";
  captureToastEl.style.padding = "4px 10px";
  captureToastEl.style.fontSize = "12px";
  captureToastEl.style.zIndex = "17";
  captureToastEl.style.display = "none";
  canvasWrapEl.appendChild(captureToastEl);

  let captureToastHideTimer = null;
  function showCaptureToast(text) {
    captureToastEl.textContent = text;
    captureToastEl.style.display = "block";
    clearTimeout(captureToastHideTimer);
    captureToastHideTimer = setTimeout(() => {
      captureToastEl.style.display = "none";
    }, 2200);
  }

  // Companion picker — opened by pressing E (see onKeyDown). Lists the same
  // 3 active-lineup slots getActiveLineup() already exposes for battle-team
  // display; picking one sends companion_summon and always swaps outright
  // (only one companion can ever be summoned at a time, per this game's own
  // plan file), so there's no "already summoned" special case to show here.
  const companionSummonModalEl = document.createElement("div");
  companionSummonModalEl.style.position = "absolute";
  companionSummonModalEl.style.left = "50%";
  companionSummonModalEl.style.top = "50%";
  companionSummonModalEl.style.transform = "translate(-50%, -50%)";
  companionSummonModalEl.style.background = "#1a1a1aee";
  companionSummonModalEl.style.border = "1px solid #3333334d";
  companionSummonModalEl.style.borderRadius = "6px";
  companionSummonModalEl.style.padding = "10px";
  companionSummonModalEl.style.zIndex = "20";
  companionSummonModalEl.style.fontSize = "12px";
  companionSummonModalEl.style.minWidth = "160px";
  companionSummonModalEl.style.display = "none";
  const companionSummonTitleEl = document.createElement("strong");
  companionSummonTitleEl.textContent = "Summon Companion";
  companionSummonTitleEl.style.display = "block";
  companionSummonTitleEl.style.marginBottom = "6px";
  companionSummonModalEl.appendChild(companionSummonTitleEl);
  const companionSummonListEl = document.createElement("div");
  companionSummonListEl.style.display = "flex";
  companionSummonListEl.style.flexDirection = "column";
  companionSummonListEl.style.gap = "4px";
  companionSummonModalEl.appendChild(companionSummonListEl);
  const companionSummonCloseBtn = document.createElement("button");
  companionSummonCloseBtn.textContent = "Cancel";
  companionSummonCloseBtn.style.fontSize = "11px";
  companionSummonCloseBtn.style.marginTop = "8px";
  companionSummonModalEl.appendChild(companionSummonCloseBtn);
  canvasWrapEl.appendChild(companionSummonModalEl);

  function hideCompanionSummonModal() {
    companionSummonModalEl.style.display = "none";
  }
  companionSummonCloseBtn.addEventListener("click", hideCompanionSummonModal);

  function showCompanionSummonModal() {
    if (battle || teamBattle || pvpBattle) return;
    companionSummonListEl.innerHTML = "";
    const lineup = getActiveLineup();
    if (lineup.length === 0) {
      const emptyEl = document.createElement("p");
      emptyEl.textContent = "No Glophimon in your active lineup.";
      emptyEl.style.margin = "0";
      companionSummonListEl.appendChild(emptyEl);
    }
    lineup.forEach((g, slot) => {
      const species = SPECIES_BY_KEY[g.species_key];
      const btn = document.createElement("button");
      btn.textContent = `${species?.name ?? g.species_key} Lv.${g.level}`;
      btn.style.fontSize = "11px";
      btn.style.textAlign = "left";
      btn.addEventListener("click", () => {
        socket.sendCompanionSummon(slot);
        // Mirrors the api's own companion_summon branch (same
        // computeCombatant formula, same iv/ev/level inputs) purely so
        // this client's own action-bar cooldown clock (see
        // refreshActionBar) knows this companion's real speed stat the
        // instant it's summoned, without waiting on a round trip. A fresh
        // companion always starts fully ready — swapping clears whatever
        // cooldown the PREVIOUS one was on.
        const ivs = { speed: g.iv_speed, attack: g.iv_attack, defense: g.iv_defense };
        const evs = { speed: g.ev_speed, attack: g.ev_attack, defense: g.ev_defense };
        companionActionSpeed = computeCombatant(species, ivs, evs, g.level).speed;
        for (const key of Object.keys(actionCooldownUntil)) delete actionCooldownUntil[key];
        hideCompanionSummonModal();
      });
      companionSummonListEl.appendChild(btn);
    });
    companionSummonModalEl.style.display = "block";
  }

  // G-coins balance — top-right overlay, shown only while walking around
  // the world (matches the stamina bar's own battle/teamBattle hiding
  // rule), since neither Karirs betting nor anything else spendable is
  // reachable mid-battle anyway.
  const gCoinsHudEl = document.createElement("div");
  gCoinsHudEl.style.position = "absolute";
  gCoinsHudEl.style.top = "38px"; // below playerHpHudEl above — see its own comment
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
    // entity.floor only exists on a peer object (ensurePeer's own shape) —
    // undefined here means this is being called for `local` itself (see
    // frame()'s own two call sites), which is trivially always "on my own
    // floor," hence the ?? fallback. A separate scene object, not a child
    // of entity.rig.group (see disposeChatBubble/scene.remove above), so
    // hiding a floor-mismatched peer's rig via setPeerHidden does NOT
    // retroactively hide an already-shown bubble the way a real child
    // object would — this needs its own explicit floor check rather than
    // relying on that unrelated mechanism.
    const entityFloor = entity.floor ?? local.currentFloor;
    // Also require the two of you to be inside the same walled area (or
    // both outdoors) — see getAreaKey's own comment for why distance/floor
    // alone let a bubble bleed through a totally different building's
    // walls (e.g. Karirs Field) whenever it was within LABEL_VISIBLE_DISTANCE.
    const sameArea = getAreaKey(entity.x, entity.z) === getAreaKey(local.x, local.z);
    entity.chatBubble.visible =
      sameArea && entityFloor === local.currentFloor && Math.hypot(local.x - entity.x, local.z - entity.z) <= LABEL_VISIBLE_DISTANCE;
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
    minimapCtx.fillStyle = "#ffffff";
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
    minimapCtx.fillStyle = "#ffffff";
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
    drawMinimapDot(USHER_X, USHER_Z, 3, USHER_COLORS.body);
    // Same declutter rule as their name labels (LABEL_VISIBLE_DISTANCE) —
    // a wild far from the player doesn't need to show up on the minimap
    // either.
    for (const spawn of wildSpawns.values()) {
      if (Math.hypot(local.x - spawn.x, local.z - spawn.z) > LABEL_VISIBLE_DISTANCE) continue;
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
  // PVP battle HUD/panel (Stage 2) — a floating-HP-bar-over-canvas shape
  // (see buildHpRowIn above), symmetric (self vs opponent, both real
  // players) instead of player-team-vs-wild. Server-authoritative: this UI
  // only ever renders
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
  // Practice race — see karirsPracticeState/onKarraPracticeClick. Its own
  // section, independent of the betting section above (you can bet AND
  // practice, or neither) — hidden only while a practice is already
  // counting down/running, so the button can't be double-clicked into two
  // overlapping countdowns.
  const karraPracticeSectionEl = document.createElement("div");
  const karraPracticeMsgEl = document.createElement("p");
  karraPracticeMsgEl.style.margin = "0 0 6px 0";
  karraPracticeMsgEl.style.display = "none";
  karraPracticeSectionEl.appendChild(karraPracticeMsgEl);
  const karraPracticeBtn = document.createElement("button");
  karraPracticeBtn.textContent = "Practice Race";
  karraPracticeBtn.style.fontSize = "11px";
  karraPracticeBtn.style.marginBottom = "6px";
  karraPracticeSectionEl.appendChild(karraPracticeBtn);
  karraMenuEl.appendChild(karraPracticeSectionEl);
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

  // The Usher's popup — same click-positioned shell as every NPC popup
  // above, state-driven (like playerOptionsMenuEl) rather than step-driven
  // (like bossRickMenuEl): its body is entirely a function of the shared
  // cinemaProjectionist value (see renderUsherMenu), not any local
  // multi-step flow of its own.
  const usherMenuEl = document.createElement("div");
  usherMenuEl.style.position = "absolute";
  usherMenuEl.style.display = "none";
  usherMenuEl.style.background = "#1a1a1aee";
  usherMenuEl.style.border = "1px solid #3333334d";
  usherMenuEl.style.borderRadius = "4px";
  usherMenuEl.style.padding = "6px";
  usherMenuEl.style.zIndex = "10";
  usherMenuEl.style.fontSize = "12px";
  usherMenuEl.style.width = "220px";
  const usherMenuLabel = document.createElement("strong");
  usherMenuLabel.textContent = USHER_NAME;
  usherMenuLabel.style.display = "block";
  usherMenuLabel.style.marginBottom = "4px";
  usherMenuEl.appendChild(usherMenuLabel);
  const usherMenuBodyEl = document.createElement("div");
  usherMenuEl.appendChild(usherMenuBodyEl);
  wrap.appendChild(usherMenuEl);

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

  // Dama Phase 2 (see this game's own plan file) — networked, sharing
  // tables 1/2 with Chess (see the api's own DamaBoardState comment).
  // Same shells/positions as the chess popups above, kept as separate
  // elements/functions rather than generalizing chess's own — this
  // session's own established "give it its own thing" pattern, so a bug
  // here can never touch the already-working Chess boards.
  //
  // Board-choice popup, shown instead of chessHostMenuEl specifically for
  // an EMPTY table 1/2 (board 3, the Stockfish table, keeps using
  // chessHostMenuEl/onChessBoardClick completely unchanged — it's always
  // chess, never offered a choice).
  const boardHostChoiceMenuEl = document.createElement("div");
  boardHostChoiceMenuEl.style.position = "absolute";
  boardHostChoiceMenuEl.style.display = "none";
  boardHostChoiceMenuEl.style.background = "#1a1a1aee";
  boardHostChoiceMenuEl.style.border = "1px solid #3333334d";
  boardHostChoiceMenuEl.style.borderRadius = "4px";
  boardHostChoiceMenuEl.style.padding = "6px";
  boardHostChoiceMenuEl.style.zIndex = "10";
  boardHostChoiceMenuEl.style.fontSize = "12px";
  boardHostChoiceMenuEl.style.width = "180px";
  const boardHostChoiceLabel = document.createElement("strong");
  boardHostChoiceLabel.textContent = "Host a game here";
  boardHostChoiceLabel.style.display = "block";
  boardHostChoiceLabel.style.marginBottom = "4px";
  boardHostChoiceMenuEl.appendChild(boardHostChoiceLabel);
  const boardHostChoiceBodyEl = document.createElement("div");
  boardHostChoiceMenuEl.appendChild(boardHostChoiceBodyEl);
  wrap.appendChild(boardHostChoiceMenuEl);

  const damaJoinMenuEl = document.createElement("div");
  damaJoinMenuEl.style.position = "absolute";
  damaJoinMenuEl.style.display = "none";
  damaJoinMenuEl.style.background = "#1a1a1aee";
  damaJoinMenuEl.style.border = "1px solid #3333334d";
  damaJoinMenuEl.style.borderRadius = "4px";
  damaJoinMenuEl.style.padding = "6px";
  damaJoinMenuEl.style.zIndex = "10";
  damaJoinMenuEl.style.fontSize = "12px";
  damaJoinMenuEl.style.width = "180px";
  const damaJoinMenuLabel = document.createElement("strong");
  damaJoinMenuLabel.textContent = "Dama Table";
  damaJoinMenuLabel.style.display = "block";
  damaJoinMenuLabel.style.marginBottom = "4px";
  damaJoinMenuEl.appendChild(damaJoinMenuLabel);
  const damaJoinMenuBodyEl = document.createElement("div");
  damaJoinMenuEl.appendChild(damaJoinMenuBodyEl);
  wrap.appendChild(damaJoinMenuEl);

  const damaWaitingModalEl = document.createElement("div");
  damaWaitingModalEl.style.position = "absolute";
  damaWaitingModalEl.style.display = "none";
  damaWaitingModalEl.style.bottom = "8px";
  damaWaitingModalEl.style.left = "8px";
  damaWaitingModalEl.style.width = "200px";
  damaWaitingModalEl.style.background = "#1a1a1aee";
  damaWaitingModalEl.style.border = "1px solid #3333334d";
  damaWaitingModalEl.style.borderRadius = "4px";
  damaWaitingModalEl.style.padding = "6px 8px";
  damaWaitingModalEl.style.zIndex = "20";
  damaWaitingModalEl.style.fontSize = "12px";
  wrap.appendChild(damaWaitingModalEl);
  const { heading: damaWaitingHeadingEl, closeBtn: damaWaitingCloseBtn, body: damaWaitingBodyEl } =
    setupModalCard(damaWaitingModalEl, "50%");
  damaWaitingHeadingEl.textContent = "Dama";
  damaWaitingCloseBtn.addEventListener("click", () => {
    if (myHostedDamaBoardId != null) socket.sendDamaCancelHost(myHostedDamaBoardId);
  });

  const damaMatchModalEl = document.createElement("div");
  damaMatchModalEl.style.position = "absolute";
  damaMatchModalEl.style.display = "none";
  damaMatchModalEl.style.inset = "0";
  damaMatchModalEl.style.background = "#000000b3";
  damaMatchModalEl.style.zIndex = "26";
  damaMatchModalEl.style.alignItems = "center";
  damaMatchModalEl.style.justifyContent = "center";
  const damaMatchCardEl = document.createElement("div");
  damaMatchCardEl.style.background = "#1a1a1aee";
  damaMatchCardEl.style.border = "1px solid #3333334d";
  damaMatchCardEl.style.borderRadius = "6px";
  damaMatchCardEl.style.padding = "10px";
  damaMatchCardEl.style.width = "300px";
  damaMatchCardEl.style.fontSize = "12px";
  damaMatchCardEl.style.display = "flex";
  damaMatchModalEl.appendChild(damaMatchCardEl);
  wrap.appendChild(damaMatchModalEl);
  const { heading: damaMatchHeadingEl, closeBtn: damaMatchCloseBtn, body: damaMatchBodyEl } =
    setupModalCard(damaMatchCardEl, "80%");
  damaMatchHeadingEl.textContent = "Dama";
  damaMatchCloseBtn.addEventListener("click", () => hideDamaMatchModal());

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
  // teamBattleButton itself (see its own declaration above) is intentionally
  // NOT appended here any more — 3v3-vs-NPC is a leftover test shortcut from
  // before real-time combat existed, dropped from this menu, though the
  // button/feature itself stays wired (setBattleButtonsDisabled etc.) since
  // nothing else actually depends on it being reachable from here.
  //
  // Character Movements (idle/walk/ready/attack/defend/cast pose preview)
  // is gone too — superseded by the Pose Designer below, which now edits
  // and live-previews exactly the two poses this game's real-time combat
  // still actually plays (Walk, Attack), not the full old battle-pose set.
  const poseDesignerButton = document.createElement("button");
  poseDesignerButton.textContent = "🎨 Pose Designer";
  poseDesignerButton.style.fontSize = "11px";
  poseDesignerButton.style.display = "block";
  poseDesignerButton.style.width = "100%";
  poseDesignerButton.style.marginTop = "4px";
  poseDesignerButton.style.cursor = "pointer";
  devMenuPanelEl.appendChild(poseDesignerButton);
  const cameraDesignerButton = document.createElement("button");
  cameraDesignerButton.textContent = "🎥 Camera Designer";
  cameraDesignerButton.style.fontSize = "11px";
  cameraDesignerButton.style.display = "block";
  cameraDesignerButton.style.width = "100%";
  cameraDesignerButton.style.marginTop = "4px";
  cameraDesignerButton.style.cursor = "pointer";
  devMenuPanelEl.appendChild(cameraDesignerButton);
  // Dama Phase 1 (see this game's own plan file) — a pure rules-engine
  // test via self-play, no hosting/networking/AI yet. Same self-contained
  // "own thing" pattern as everything else in this menu.
  const damaTestButton = document.createElement("button");
  damaTestButton.textContent = "🀄 Test Dama";
  damaTestButton.style.fontSize = "11px";
  damaTestButton.style.display = "block";
  damaTestButton.style.width = "100%";
  damaTestButton.style.marginTop = "4px";
  damaTestButton.style.cursor = "pointer";
  devMenuPanelEl.appendChild(damaTestButton);
  wrap.appendChild(devMenuPanelEl);

  devMenuButton.addEventListener("click", () => {
    devMenuPanelEl.style.display = devMenuPanelEl.style.display === "none" ? "block" : "none";
  });
  devVisionToggle.addEventListener("change", () => {
    showWildVisionRange = devVisionToggle.checked;
  });

  // Pose Designer — sliders drive the live preview rig directly (see
  // poseDesignerValues/applyPoseDesignerValues); "Add Keyframe" snapshots
  // the current slider values into a timeline; "Play" loops through that
  // timeline, blending linearly between consecutive keyframes over each
  // one's own transition time (wrapping from the last keyframe back to the
  // first). "Export" is the actual point of this tool — it's not meant to
  // run in-game forever, just to let a real pose function get authored
  // visually and then handed off as a spec (see this feature's own
  // discussion) rather than hand-picked numbers guessed blind.
  //
  // State intentionally lives here in mount()'s own closure, not reset
  // each time the modal opens/closes, so closing it (even by accident)
  // never loses work in progress — only the explicit Clear button does.
  const poseDesignerValues = poseDesignerDefaultValues();
  let poseDesignerKeyframes = [];
  let poseDesignerPlaying = false;
  let poseDesignerPlaybackMs = 0;
  let poseDesignerPreview = null;

  function poseDesignerFrame(rig, dt) {
    if (poseDesignerPlaying && poseDesignerKeyframes.length > 0) {
      poseDesignerPlaybackMs += dt * 1000;
      playPoseKeyframes(rig, poseDesignerKeyframes, poseDesignerPlaybackMs);
    } else {
      applyPoseDesignerValues(rig, poseDesignerValues);
    }
  }

  const poseDesignerModalEl = document.createElement("div");
  poseDesignerModalEl.style.position = "absolute";
  poseDesignerModalEl.style.display = "none";
  poseDesignerModalEl.style.inset = "0";
  poseDesignerModalEl.style.background = "#000000b3";
  poseDesignerModalEl.style.zIndex = "26";
  poseDesignerModalEl.style.alignItems = "center";
  poseDesignerModalEl.style.justifyContent = "center";
  const poseDesignerCardEl = document.createElement("div");
  poseDesignerCardEl.style.background = "#1a1a1aee";
  poseDesignerCardEl.style.border = "1px solid #3333334d";
  poseDesignerCardEl.style.borderRadius = "6px";
  poseDesignerCardEl.style.padding = "10px";
  // Wide enough to let the preview and controls sit side by side (see
  // poseDesignerLayoutEl's own flex-wrap below) whenever there's room —
  // capped relative to the viewport so it still fits a normal, narrow
  // panel width, where flex-wrap just falls back to the original stacked
  // layout on its own, no separate breakpoint logic needed.
  poseDesignerCardEl.style.width = "min(94vw, 760px)";
  poseDesignerCardEl.style.fontSize = "11px";
  poseDesignerCardEl.style.display = "flex";
  poseDesignerModalEl.appendChild(poseDesignerCardEl);
  wrap.appendChild(poseDesignerModalEl);
  const { heading: poseDesignerHeadingEl, closeBtn: poseDesignerCloseBtn, body: poseDesignerBodyEl } =
    setupModalCard(poseDesignerCardEl, "85%");
  poseDesignerHeadingEl.textContent = "Pose Designer";
  // setupModalCard defaults the body itself to overflowY:auto — one shared
  // scrollbar for everything in it. Overridden here so each column below
  // gets its own independent one instead (see poseDesignerPreviewColEl/
  // poseDesignerControlsColEl) — scrolling through the sliders must never
  // carry the preview along with it.
  poseDesignerBodyEl.style.overflow = "hidden";

  // Side by side whenever the card is wide enough to fit both comfortably
  // (see poseDesignerCardEl's own width above), stacked otherwise — plain
  // flex-wrap, not a manual width breakpoint, so it degrades gracefully at
  // any in-between size too. The whole point (see this feature's own
  // discussion): the preview never has to be scrolled past to reach the
  // sliders once there's room for both at once.
  const poseDesignerLayoutEl = document.createElement("div");
  poseDesignerLayoutEl.style.display = "flex";
  poseDesignerLayoutEl.style.flexWrap = "wrap";
  poseDesignerLayoutEl.style.gap = "10px";
  poseDesignerBodyEl.appendChild(poseDesignerLayoutEl);

  const poseDesignerPreviewColEl = document.createElement("div");
  poseDesignerPreviewColEl.style.flex = "0 0 320px";
  // A fixed-aspect canvas never actually grows past this, but bounding it
  // the same way as the controls column keeps both columns' scroll
  // behavior consistent rather than one of them being a special case.
  poseDesignerPreviewColEl.style.maxHeight = "70vh";
  poseDesignerPreviewColEl.style.overflowY = "auto";
  poseDesignerLayoutEl.appendChild(poseDesignerPreviewColEl);

  const poseDesignerControlsColEl = document.createElement("div");
  poseDesignerControlsColEl.style.flex = "1 1 280px";
  poseDesignerControlsColEl.style.minWidth = "260px";
  poseDesignerControlsColEl.style.maxHeight = "70vh";
  poseDesignerControlsColEl.style.overflowY = "auto";
  poseDesignerLayoutEl.appendChild(poseDesignerControlsColEl);

  const poseDesignerPreviewEl = document.createElement("div");
  poseDesignerPreviewColEl.appendChild(poseDesignerPreviewEl);

  const poseDesignerNameLabel = document.createElement("label");
  poseDesignerNameLabel.style.display = "flex";
  poseDesignerNameLabel.style.gap = "6px";
  poseDesignerNameLabel.style.alignItems = "center";
  poseDesignerNameLabel.style.margin = "8px 0 4px 0";
  const poseDesignerNameInput = document.createElement("input");
  poseDesignerNameInput.type = "text";
  poseDesignerNameInput.placeholder = "e.g. wave, bow, taunt";
  poseDesignerNameInput.style.flex = "1";
  poseDesignerNameLabel.append(document.createTextNode("Name"), poseDesignerNameInput);
  poseDesignerControlsColEl.appendChild(poseDesignerNameLabel);

  // The only 3 pose slots real-time combat actually plays any more (see
  // this game's own plan file) — Walk drives the local player's own
  // overworld avatar (see tryPlayLocalOverride); Attack drives BOTH a
  // wild's own attack-on-player swing and a summoned companion's own
  // attack-on-wild swing; Flinch drives the hit-react on whichever actually
  // took the damage — the local player's own body (see frame()'s own
  // playerFlinchElapsedMs) or a wild (see updateWildSpawns) — for every
  // connected client rendering that fight, not just whoever's involved (see
  // updateWildSpawns/updateCompanionSpawns' own tryPlayBattlePoseOverride
  // calls) — since it's a purely local rendering preference, not something
  // synced to other players' own clients. Idle/Ready/Defend/Cast were the
  // old turn-based battle system's own pose slots — dropped from this list
  // since nothing in glophiworld plays them any more (Idle still has its
  // own hardcoded built-in, same as always; it just isn't designer-
  // overridable here — Flinch is its own new slot, not a revival of Defend,
  // even though applyFlinchPose's built-in fallback is cut from the same
  // cloth as the old applyDefendPose).
  const POSE_OVERRIDE_SLOTS = [
    { id: "walk", label: "Walk" },
    { id: "attack", label: "Attack" },
    { id: "flinch", label: "Flinch" },
  ];
  const poseDesignerSlotLabel = document.createElement("label");
  poseDesignerSlotLabel.style.display = "flex";
  poseDesignerSlotLabel.style.gap = "6px";
  poseDesignerSlotLabel.style.alignItems = "center";
  poseDesignerSlotLabel.style.margin = "0 0 4px 0";
  const poseDesignerSlotSelect = document.createElement("select");
  poseDesignerSlotSelect.style.flex = "1";
  const poseDesignerNoSlotOpt = document.createElement("option");
  poseDesignerNoSlotOpt.value = "";
  poseDesignerNoSlotOpt.textContent = "(not saved to the game — export/import only)";
  poseDesignerSlotSelect.appendChild(poseDesignerNoSlotOpt);
  for (const slot of POSE_OVERRIDE_SLOTS) {
    const opt = document.createElement("option");
    opt.value = slot.id;
    opt.textContent = slot.label;
    poseDesignerSlotSelect.appendChild(opt);
  }
  poseDesignerSlotLabel.append(document.createTextNode("Pose slot"), poseDesignerSlotSelect);
  poseDesignerControlsColEl.appendChild(poseDesignerSlotLabel);

  const poseDesignerSlotBtnsRowEl = document.createElement("div");
  poseDesignerSlotBtnsRowEl.style.display = "flex";
  poseDesignerSlotBtnsRowEl.style.gap = "4px";
  poseDesignerSlotBtnsRowEl.style.marginBottom = "4px";
  const poseDesignerSaveToGameBtn = document.createElement("button");
  poseDesignerSaveToGameBtn.textContent = "Save to Game";
  poseDesignerSaveToGameBtn.style.fontSize = "11px";
  poseDesignerSaveToGameBtn.style.flex = "1";
  poseDesignerSaveToGameBtn.style.cursor = "pointer";
  const poseDesignerResetToDefaultBtn = document.createElement("button");
  poseDesignerResetToDefaultBtn.textContent = "Reset to Default";
  poseDesignerResetToDefaultBtn.style.fontSize = "11px";
  poseDesignerResetToDefaultBtn.style.flex = "1";
  poseDesignerResetToDefaultBtn.style.cursor = "pointer";
  poseDesignerSlotBtnsRowEl.append(poseDesignerSaveToGameBtn, poseDesignerResetToDefaultBtn);
  poseDesignerControlsColEl.appendChild(poseDesignerSlotBtnsRowEl);

  // "Recreate" the built-in animation as editable keyframes (see
  // sampleBuiltinPoseKeyframes) — loads it into the sliders/keyframe list
  // and starts playing it, same as picking an already-saved pose does, but
  // sourced from the real procedural pose instead of a saved override.
  // Purely local until Save to Game is actually clicked afterward.
  const poseDesignerRecreateBtn = document.createElement("button");
  poseDesignerRecreateBtn.textContent = "Recreate Built-in as Keyframes";
  poseDesignerRecreateBtn.style.fontSize = "11px";
  poseDesignerRecreateBtn.style.display = "block";
  poseDesignerRecreateBtn.style.width = "100%";
  poseDesignerRecreateBtn.style.marginBottom = "4px";
  poseDesignerRecreateBtn.style.cursor = "pointer";
  poseDesignerControlsColEl.appendChild(poseDesignerRecreateBtn);

  poseDesignerRecreateBtn.addEventListener("click", () => {
    const slotId = poseDesignerSlotSelect.value;
    if (!slotId) {
      poseDesignerSlotStatusEl.style.color = "#a3a3a3";
      poseDesignerSlotStatusEl.textContent = "Pick a pose slot above first.";
      return;
    }
    poseDesignerKeyframes = sampleBuiltinPoseKeyframes(slotId);
    loadPoseDesignerValues(poseDesignerKeyframes[0].values);
    poseDesignerPlaying = poseDesignerKeyframes.length > 1;
    poseDesignerPlaybackMs = 0;
    poseDesignerPlayBtn.textContent = poseDesignerPlaying ? "⏹ Stop" : "▶ Play";
    renderPoseDesignerKeyframes();
    poseDesignerSlotStatusEl.style.color = "#a3a3a3";
    poseDesignerSlotStatusEl.textContent = "Loaded the built-in animation — edit freely, then Save to Game when ready.";
  });

  const poseDesignerSlotStatusEl = document.createElement("p");
  poseDesignerSlotStatusEl.style.fontSize = "10px";
  poseDesignerSlotStatusEl.style.margin = "0 0 6px 0";
  poseDesignerControlsColEl.appendChild(poseDesignerSlotStatusEl);

  poseDesignerSlotSelect.addEventListener("change", () => {
    poseDesignerSlotStatusEl.textContent = "";
    const slotId = poseDesignerSlotSelect.value;
    const existing = slotId ? poseOverrides[slotId] : null;
    if (existing && existing.keyframes && existing.keyframes.length > 0) {
      poseDesignerKeyframes = existing.keyframes.map((kf) => ({
        values: { ...poseDesignerDefaultValues(), ...kf.values },
        transitionMs: kf.transitionMs,
      }));
      loadPoseDesignerValues(poseDesignerKeyframes[0].values);
      // Choosing an already-saved pose should show what it actually looks
      // like in motion right away — a static first-keyframe pose plus a
      // list of ms numbers doesn't really answer "what does this sequence
      // do." Playing (not just Loading) is also what lets you scrub in and
      // Save over whatever you land on, same as authoring a new one.
      poseDesignerPlaying = true;
      poseDesignerPlaybackMs = 0;
      poseDesignerPlayBtn.textContent = "⏹ Stop";
    } else if (slotId) {
      // No custom override saved yet for a real pose slot — start from the
      // real built-in animation (see sampleBuiltinPoseKeyframes) rather
      // than a blank slate, so there's always something to look at and
      // tweak instead of an extra manual step to get there.
      poseDesignerKeyframes = sampleBuiltinPoseKeyframes(slotId);
      loadPoseDesignerValues(poseDesignerKeyframes[0].values);
      poseDesignerPlaying = poseDesignerKeyframes.length > 1;
      poseDesignerPlaybackMs = 0;
      poseDesignerPlayBtn.textContent = poseDesignerPlaying ? "⏹ Stop" : "▶ Play";
    } else {
      // "(not saved to the game)" — a genuine blank slate for a one-off
      // export/import-only pose, unrelated to any of the 6 real slots.
      poseDesignerKeyframes = [];
      loadPoseDesignerValues(poseDesignerDefaultValues());
      poseDesignerPlaying = false;
      poseDesignerPlayBtn.textContent = "▶ Play";
    }
    poseDesignerNameInput.value = slotId ? POSE_OVERRIDE_SLOTS.find((s) => s.id === slotId).label : "";
    renderPoseDesignerKeyframes();
  });

  poseDesignerSaveToGameBtn.addEventListener("click", async () => {
    const slotId = poseDesignerSlotSelect.value;
    if (!slotId) {
      poseDesignerSlotStatusEl.style.color = "#a3a3a3";
      poseDesignerSlotStatusEl.textContent = "Pick a pose slot above first.";
      return;
    }
    if (poseDesignerKeyframes.length === 0) {
      poseDesignerSlotStatusEl.style.color = "#a3a3a3";
      poseDesignerSlotStatusEl.textContent = "Add at least one keyframe first.";
      return;
    }
    poseDesignerSlotStatusEl.style.color = "#a3a3a3";
    poseDesignerSlotStatusEl.textContent = "Saving…";
    const keyframes = poseDesignerKeyframes.map((kf) => ({ values: { ...kf.values }, transitionMs: kf.transitionMs }));
    const result = await ctx.onSavePoseOverride?.(slotId, keyframes);
    if (result && result.ok) {
      // Takes effect immediately — the very next time tryPlayLocalOverride
      // checks this slot, not just on your next reconnect.
      poseOverrides = result.poseOverrides || {};
      poseDesignerSlotStatusEl.style.color = "#4ade80";
      const label = POSE_OVERRIDE_SLOTS.find((s) => s.id === slotId).label;
      poseDesignerSlotStatusEl.textContent = `Saved — your ${label} will use this now.`;
    } else {
      poseDesignerSlotStatusEl.style.color = "#ef4444";
      poseDesignerSlotStatusEl.textContent = "Could not save — try again?";
    }
  });

  poseDesignerResetToDefaultBtn.addEventListener("click", async () => {
    const slotId = poseDesignerSlotSelect.value;
    if (!slotId) {
      poseDesignerSlotStatusEl.style.color = "#a3a3a3";
      poseDesignerSlotStatusEl.textContent = "Pick a pose slot above first.";
      return;
    }
    poseDesignerSlotStatusEl.style.color = "#a3a3a3";
    poseDesignerSlotStatusEl.textContent = "Resetting…";
    const result = await ctx.onResetPoseOverride?.(slotId);
    if (result && result.ok) {
      poseOverrides = result.poseOverrides || {};
      poseDesignerKeyframes = [];
      loadPoseDesignerValues(poseDesignerDefaultValues());
      renderPoseDesignerKeyframes();
      poseDesignerSlotStatusEl.style.color = "#4ade80";
      const label = POSE_OVERRIDE_SLOTS.find((s) => s.id === slotId).label;
      poseDesignerSlotStatusEl.textContent = `Reset — your ${label} is back to the built-in animation.`;
    } else {
      poseDesignerSlotStatusEl.style.color = "#ef4444";
      poseDesignerSlotStatusEl.textContent = "Could not reset — try again?";
    }
  });

  const poseDesignerSlidersEl = document.createElement("div");
  poseDesignerSlidersEl.style.display = "flex";
  poseDesignerSlidersEl.style.flexDirection = "column";
  poseDesignerSlidersEl.style.gap = "3px";
  poseDesignerControlsColEl.appendChild(poseDesignerSlidersEl);

  const poseDesignerSliderEls = {};
  for (const spec of POSE_DESIGNER_PARTS) {
    const row = document.createElement("div");
    const topRow = document.createElement("div");
    topRow.style.display = "flex";
    topRow.style.justifyContent = "space-between";
    const labelEl = document.createElement("span");
    labelEl.textContent = spec.label;
    const valueEl = document.createElement("span");
    valueEl.style.color = "#a3a3a3";
    valueEl.textContent = "0.00";
    topRow.append(labelEl, valueEl);
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(spec.min);
    slider.max = String(spec.max);
    slider.step = String(spec.step);
    slider.value = "0";
    slider.style.width = "100%";
    slider.addEventListener("input", () => {
      const v = parseFloat(slider.value);
      poseDesignerValues[spec.key] = v;
      valueEl.textContent = v.toFixed(2);
    });
    row.append(topRow, slider);
    poseDesignerSlidersEl.appendChild(row);
    poseDesignerSliderEls[spec.key] = { slider, valueEl };
  }

  function loadPoseDesignerValues(values) {
    for (const spec of POSE_DESIGNER_PARTS) {
      const v = values[spec.key] ?? 0;
      poseDesignerValues[spec.key] = v;
      const { slider, valueEl } = poseDesignerSliderEls[spec.key];
      slider.value = String(v);
      valueEl.textContent = v.toFixed(2);
    }
  }

  const poseDesignerActionsRowEl = document.createElement("div");
  poseDesignerActionsRowEl.style.display = "flex";
  poseDesignerActionsRowEl.style.gap = "4px";
  poseDesignerActionsRowEl.style.margin = "8px 0 4px 0";
  const poseDesignerAddBtn = document.createElement("button");
  poseDesignerAddBtn.textContent = "+ Keyframe";
  poseDesignerAddBtn.style.fontSize = "11px";
  poseDesignerAddBtn.style.cursor = "pointer";
  const poseDesignerPlayBtn = document.createElement("button");
  poseDesignerPlayBtn.textContent = "▶ Play";
  poseDesignerPlayBtn.style.fontSize = "11px";
  poseDesignerPlayBtn.style.cursor = "pointer";
  const poseDesignerClearBtn = document.createElement("button");
  poseDesignerClearBtn.textContent = "Clear";
  poseDesignerClearBtn.style.fontSize = "11px";
  poseDesignerClearBtn.style.cursor = "pointer";
  poseDesignerActionsRowEl.append(poseDesignerAddBtn, poseDesignerPlayBtn, poseDesignerClearBtn);
  poseDesignerControlsColEl.appendChild(poseDesignerActionsRowEl);

  const poseDesignerKeyframesEl = document.createElement("div");
  poseDesignerKeyframesEl.style.display = "flex";
  poseDesignerKeyframesEl.style.flexDirection = "column";
  poseDesignerKeyframesEl.style.gap = "2px";
  poseDesignerKeyframesEl.style.margin = "4px 0";
  poseDesignerControlsColEl.appendChild(poseDesignerKeyframesEl);

  function renderPoseDesignerKeyframes() {
    poseDesignerKeyframesEl.innerHTML = "";
    poseDesignerKeyframes.forEach((kf, i) => {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "4px";
      const label = document.createElement("span");
      label.textContent = `${i + 1}.`;
      const msInput = document.createElement("input");
      msInput.type = "number";
      msInput.min = "1";
      msInput.step = "50";
      msInput.value = String(kf.transitionMs);
      msInput.style.width = "60px";
      msInput.addEventListener("input", () => {
        kf.transitionMs = Math.max(1, parseInt(msInput.value, 10) || 1);
      });
      const msSuffix = document.createElement("span");
      msSuffix.textContent = "ms";
      const loadBtn = document.createElement("button");
      loadBtn.textContent = "Load";
      loadBtn.style.fontSize = "10px";
      loadBtn.style.cursor = "pointer";
      loadBtn.addEventListener("click", () => loadPoseDesignerValues(kf.values));
      // The other half of Load: after loading a keyframe onto the sliders
      // and tweaking them, this writes the sliders' *current* values back
      // into this same keyframe slot — Load and Save are deliberately two
      // separate buttons rather than one "edit mode" toggle, since it also
      // lets you load one keyframe as a starting point and save the result
      // into a different one.
      const saveBtn = document.createElement("button");
      saveBtn.textContent = "Save";
      saveBtn.style.fontSize = "10px";
      saveBtn.style.cursor = "pointer";
      saveBtn.addEventListener("click", () => {
        kf.values = { ...poseDesignerValues };
      });
      const delBtn = document.createElement("button");
      delBtn.textContent = "✕";
      delBtn.style.fontSize = "10px";
      delBtn.style.cursor = "pointer";
      delBtn.addEventListener("click", () => {
        poseDesignerKeyframes.splice(i, 1);
        renderPoseDesignerKeyframes();
      });
      row.append(label, msInput, msSuffix, loadBtn, saveBtn, delBtn);
      poseDesignerKeyframesEl.appendChild(row);
    });
  }

  poseDesignerAddBtn.addEventListener("click", () => {
    poseDesignerKeyframes.push({ values: { ...poseDesignerValues }, transitionMs: 400 });
    renderPoseDesignerKeyframes();
  });
  poseDesignerPlayBtn.addEventListener("click", () => {
    poseDesignerPlaying = !poseDesignerPlaying;
    poseDesignerPlaybackMs = 0;
    poseDesignerPlayBtn.textContent = poseDesignerPlaying ? "⏹ Stop" : "▶ Play";
  });
  poseDesignerClearBtn.addEventListener("click", () => {
    poseDesignerPlaying = false;
    poseDesignerPlayBtn.textContent = "▶ Play";
    poseDesignerKeyframes = [];
    poseDesignerNameInput.value = "";
    loadPoseDesignerValues(poseDesignerDefaultValues());
    renderPoseDesignerKeyframes();
  });

  // Export and Import share this one textarea rather than each getting
  // their own — the whole "save and continue later" workflow this is for
  // is: Export, copy the JSON out somewhere, come back another day, paste
  // it into this same box, Import. Read-only would only get in the way of
  // the second half of that.
  const poseDesignerIoRowEl = document.createElement("div");
  poseDesignerIoRowEl.style.display = "flex";
  poseDesignerIoRowEl.style.gap = "4px";
  poseDesignerIoRowEl.style.marginTop = "6px";
  const poseDesignerExportBtn = document.createElement("button");
  poseDesignerExportBtn.textContent = "Export";
  poseDesignerExportBtn.style.fontSize = "11px";
  poseDesignerExportBtn.style.flex = "1";
  poseDesignerExportBtn.style.cursor = "pointer";
  const poseDesignerImportBtn = document.createElement("button");
  poseDesignerImportBtn.textContent = "Import";
  poseDesignerImportBtn.style.fontSize = "11px";
  poseDesignerImportBtn.style.flex = "1";
  poseDesignerImportBtn.style.cursor = "pointer";
  poseDesignerIoRowEl.append(poseDesignerExportBtn, poseDesignerImportBtn);
  poseDesignerControlsColEl.appendChild(poseDesignerIoRowEl);

  const poseDesignerExportEl = document.createElement("textarea");
  poseDesignerExportEl.placeholder = "Export writes here — or paste a previously exported pose here and hit Import.";
  poseDesignerExportEl.style.width = "100%";
  poseDesignerExportEl.style.height = "70px";
  poseDesignerExportEl.style.marginTop = "4px";
  poseDesignerExportEl.style.fontSize = "10px";
  poseDesignerControlsColEl.appendChild(poseDesignerExportEl);

  const poseDesignerIoErrorEl = document.createElement("p");
  poseDesignerIoErrorEl.style.color = "#ef4444";
  poseDesignerIoErrorEl.style.fontSize = "10px";
  poseDesignerIoErrorEl.style.margin = "4px 0 0 0";
  poseDesignerIoErrorEl.style.display = "none";
  poseDesignerControlsColEl.appendChild(poseDesignerIoErrorEl);

  poseDesignerExportBtn.addEventListener("click", () => {
    poseDesignerIoErrorEl.style.display = "none";
    const payload = {
      name: poseDesignerNameInput.value.trim() || "untitled",
      keyframes: poseDesignerKeyframes.map((kf) => ({ values: { ...kf.values }, transitionMs: kf.transitionMs })),
    };
    const json = JSON.stringify(payload, null, 2);
    poseDesignerExportEl.value = json;
    poseDesignerExportEl.focus();
    poseDesignerExportEl.select();
    navigator.clipboard?.writeText(json).catch(() => {}); // best-effort — the textarea above is the reliable fallback either way
  });

  poseDesignerImportBtn.addEventListener("click", () => {
    poseDesignerIoErrorEl.style.display = "none";
    let payload;
    try {
      payload = JSON.parse(poseDesignerExportEl.value);
    } catch {
      poseDesignerIoErrorEl.textContent = "Not valid JSON — paste an export from this same tool.";
      poseDesignerIoErrorEl.style.display = "block";
      return;
    }
    if (!Array.isArray(payload?.keyframes)) {
      poseDesignerIoErrorEl.textContent = 'Missing a "keyframes" array — paste an export from this same tool.';
      poseDesignerIoErrorEl.style.display = "block";
      return;
    }
    poseDesignerPlaying = false;
    poseDesignerPlayBtn.textContent = "▶ Play";
    poseDesignerNameInput.value = typeof payload.name === "string" ? payload.name : "";
    // Merged with defaults (not used as-is) so importing an older export —
    // from before a slider existed — doesn't leave that slider's value
    // undefined; it just falls back to 0 same as a brand new keyframe would.
    poseDesignerKeyframes = payload.keyframes.map((kf) => ({
      values: { ...poseDesignerDefaultValues(), ...kf.values },
      transitionMs: Math.max(1, parseInt(kf.transitionMs, 10) || 400),
    }));
    if (poseDesignerKeyframes.length > 0) loadPoseDesignerValues(poseDesignerKeyframes[0].values);
    renderPoseDesignerKeyframes();
  });

  function hidePoseDesignerModal() {
    poseDesignerModalEl.style.display = "none";
    poseDesignerPreview?.dispose();
    poseDesignerPreview = null;
  }
  poseDesignerCloseBtn.addEventListener("click", hidePoseDesignerModal);
  poseDesignerButton.addEventListener("click", () => {
    devMenuPanelEl.style.display = "none";
    poseDesignerModalEl.style.display = "flex";
    poseDesignerPreview = mountPreview(poseDesignerPreviewEl, localColors, { showFrontMarker: true });
    poseDesignerPreview.setCustomPose(poseDesignerFrame);
    renderPoseDesignerKeyframes();
  });

  // Camera Designer — modeled exactly on the Pose Designer above (same
  // modal shape via setupModalCard, same two-column preview/controls
  // layout, same slot-select + Save to Game/Reset to Default pipeline),
  // but far simpler: no keyframe timeline, since the reset/orbit camera is
  // just 4 numbers plus an on/off toggle, not a posable rig. This only ever
  // customizes each battle type's own wide "nothing focused" fallback
  // framing (see the per-frame battle camera blocks in frame() below,
  // where cameraOverrides is actually read) — the focus camera that
  // follows whoever's declaring/acting is untouched and not exposed here.
  const cameraDesignerModalEl = document.createElement("div");
  cameraDesignerModalEl.style.position = "absolute";
  cameraDesignerModalEl.style.display = "none";
  cameraDesignerModalEl.style.inset = "0";
  cameraDesignerModalEl.style.background = "#000000b3";
  cameraDesignerModalEl.style.zIndex = "26";
  cameraDesignerModalEl.style.alignItems = "center";
  cameraDesignerModalEl.style.justifyContent = "center";
  const cameraDesignerCardEl = document.createElement("div");
  cameraDesignerCardEl.style.background = "#1a1a1aee";
  cameraDesignerCardEl.style.border = "1px solid #3333334d";
  cameraDesignerCardEl.style.borderRadius = "6px";
  cameraDesignerCardEl.style.padding = "10px";
  cameraDesignerCardEl.style.width = "min(94vw, 760px)";
  cameraDesignerCardEl.style.fontSize = "11px";
  cameraDesignerCardEl.style.display = "flex";
  cameraDesignerModalEl.appendChild(cameraDesignerCardEl);
  wrap.appendChild(cameraDesignerModalEl);
  const { heading: cameraDesignerHeadingEl, closeBtn: cameraDesignerCloseBtn, body: cameraDesignerBodyEl } =
    setupModalCard(cameraDesignerCardEl, "85%");
  cameraDesignerHeadingEl.textContent = "Camera Designer";
  cameraDesignerBodyEl.style.overflow = "hidden";

  const cameraDesignerLayoutEl = document.createElement("div");
  cameraDesignerLayoutEl.style.display = "flex";
  cameraDesignerLayoutEl.style.flexWrap = "wrap";
  cameraDesignerLayoutEl.style.gap = "10px";
  cameraDesignerBodyEl.appendChild(cameraDesignerLayoutEl);

  const cameraDesignerPreviewColEl = document.createElement("div");
  cameraDesignerPreviewColEl.style.flex = "0 0 320px";
  cameraDesignerPreviewColEl.style.maxHeight = "70vh";
  cameraDesignerPreviewColEl.style.overflowY = "auto";
  cameraDesignerLayoutEl.appendChild(cameraDesignerPreviewColEl);

  const cameraDesignerControlsColEl = document.createElement("div");
  cameraDesignerControlsColEl.style.flex = "1 1 280px";
  cameraDesignerControlsColEl.style.minWidth = "260px";
  cameraDesignerControlsColEl.style.maxHeight = "70vh";
  cameraDesignerControlsColEl.style.overflowY = "auto";
  cameraDesignerLayoutEl.appendChild(cameraDesignerControlsColEl);

  const cameraDesignerPreviewEl = document.createElement("div");
  cameraDesignerPreviewColEl.appendChild(cameraDesignerPreviewEl);

  // The real slots this actually plugs into live — the original 3
  // kind:"orbit" reset/orbit cameras plus the wild battle's own 4
  // kind:"focus" re-aim moments (see CAMERA_OVERRIDE_SLOTS, now module-level
  // alongside CAMERA_DESIGNER_FIELDS/CAMERA_FOCUS_FIELDS, and cameraOverrides
  // below) — no "(not saved to the game)" blank-slate option like the Pose
  // Designer's own select, since there's no export/import concept here;
  // picking a slot always means "customize this camera moment."
  const cameraDesignerSlotLabel = document.createElement("label");
  cameraDesignerSlotLabel.style.display = "flex";
  cameraDesignerSlotLabel.style.gap = "6px";
  cameraDesignerSlotLabel.style.alignItems = "center";
  cameraDesignerSlotLabel.style.margin = "0 0 4px 0";
  const cameraDesignerSlotSelect = document.createElement("select");
  cameraDesignerSlotSelect.style.flex = "1";
  const cameraDesignerNoSlotOpt = document.createElement("option");
  cameraDesignerNoSlotOpt.value = "";
  cameraDesignerNoSlotOpt.textContent = "(pick a battle type below)";
  cameraDesignerSlotSelect.appendChild(cameraDesignerNoSlotOpt);
  for (const slot of CAMERA_OVERRIDE_SLOTS) {
    const opt = document.createElement("option");
    opt.value = slot.id;
    opt.textContent = slot.label;
    cameraDesignerSlotSelect.appendChild(opt);
  }
  cameraDesignerSlotLabel.append(document.createTextNode("Battle type"), cameraDesignerSlotSelect);
  cameraDesignerControlsColEl.appendChild(cameraDesignerSlotLabel);

  const cameraDesignerSlotBtnsRowEl = document.createElement("div");
  cameraDesignerSlotBtnsRowEl.style.display = "flex";
  cameraDesignerSlotBtnsRowEl.style.gap = "4px";
  cameraDesignerSlotBtnsRowEl.style.marginBottom = "4px";
  const cameraDesignerSaveToGameBtn = document.createElement("button");
  cameraDesignerSaveToGameBtn.textContent = "Save to Game";
  cameraDesignerSaveToGameBtn.style.fontSize = "11px";
  cameraDesignerSaveToGameBtn.style.flex = "1";
  cameraDesignerSaveToGameBtn.style.cursor = "pointer";
  const cameraDesignerResetToDefaultBtn = document.createElement("button");
  cameraDesignerResetToDefaultBtn.textContent = "Reset to Default";
  cameraDesignerResetToDefaultBtn.style.fontSize = "11px";
  cameraDesignerResetToDefaultBtn.style.flex = "1";
  cameraDesignerResetToDefaultBtn.style.cursor = "pointer";
  cameraDesignerSlotBtnsRowEl.append(cameraDesignerSaveToGameBtn, cameraDesignerResetToDefaultBtn);
  cameraDesignerControlsColEl.appendChild(cameraDesignerSlotBtnsRowEl);

  const cameraDesignerStatusEl = document.createElement("p");
  cameraDesignerStatusEl.style.fontSize = "10px";
  cameraDesignerStatusEl.style.margin = "0 0 6px 0";
  cameraDesignerControlsColEl.appendChild(cameraDesignerStatusEl);

  // State lives here in mount()'s own closure (not reset on modal close),
  // same "don't lose in-progress tweaking by accident" reasoning as the
  // Pose Designer's own poseDesignerValues. cameraDesignerPreviewAngle is
  // separate from cameraDesignerValues.angle — it's the *live* preview
  // angle (which keeps advancing every frame while autoRotate is on),
  // while .angle is the *saved* starting angle a fresh battle should open
  // on; see cameraDesignerDriver below for how the two relate. Both
  // cameraDesignerValues and cameraDesignerFields are `let`, not `const` —
  // switching a kind:"orbit" slot to a kind:"focus" one (or back) replaces
  // both wholesale (see renderCameraDesignerSliders/loadCameraDesignerValues
  // below) rather than merging mismatched shapes into one object.
  let cameraDesignerValues = cameraDesignerDefaultValues("wild");
  let cameraDesignerFields = CAMERA_DESIGNER_FIELDS;
  let cameraDesignerPreviewAngle = cameraDesignerValues.angle;
  // Vertical-axis counterpart to cameraDesignerPreviewAngle above — passed
  // straight into the shared advanceOrbitElevation (same function the real
  // battle cameras use), so the preview bounces between MIN_ELEVATION/
  // MAX_ELEVATION exactly the same way a real orbit slot's own "Rotation
  // Speed (X axis)" would, rather than a second hand-rolled copy of that
  // bounce logic.
  const cameraDesignerPreviewElevationState = { camElevation: cameraDesignerValues.elevation, camElevationDir: 1 };
  // Focus-slot counterparts to cameraDesignerPreviewAngle/
  // cameraDesignerPreviewElevationState above — a focus slot now supports
  // its own orbit (angle/rotateSpeed) and height-bounce (heightRotateSpeed)
  // too (see CAMERA_FOCUS_FIELDS), so the preview needs its own live
  // running angle/height state for that shape, kept separate from the
  // orbit shape's own state above since the two kinds can be switched
  // between at any time without one clobbering the other's progress.
  let cameraDesignerFocusPreviewAngle = cameraDesignerValues.angle ?? 0;
  const cameraDesignerFocusPreviewHeightState = { camElevation: TEAM_FOCUS_CAM_HEIGHT, camElevationDir: 1 };
  let cameraDesignerPreview = null;

  const cameraDesignerSlidersEl = document.createElement("div");
  cameraDesignerSlidersEl.style.display = "flex";
  cameraDesignerSlidersEl.style.flexDirection = "column";
  cameraDesignerSlidersEl.style.gap = "3px";
  cameraDesignerControlsColEl.appendChild(cameraDesignerSlidersEl);

  // Rebuilt wholesale — not just re-valued — every time the slot <select>
  // switches to a different `kind` (see the "change" handler below), since
  // CAMERA_DESIGNER_FIELDS (orbit) and CAMERA_FOCUS_FIELDS (focus) don't
  // share keys, ranges, or labels at all. cameraDesignerSliderEls is
  // likewise rebuilt each time so nothing keeps a reference to a slider
  // already removed from the DOM by the previous kind's own render.
  let cameraDesignerSliderEls = {};
  function renderCameraDesignerSliders(fields) {
    cameraDesignerFields = fields;
    cameraDesignerSlidersEl.innerHTML = "";
    cameraDesignerSliderEls = {};
    for (const spec of fields) {
      const row = document.createElement("div");
      const topRow = document.createElement("div");
      topRow.style.display = "flex";
      topRow.style.justifyContent = "space-between";
      const labelEl = document.createElement("span");
      labelEl.textContent = spec.label;
      const valueEl = document.createElement("span");
      valueEl.style.color = "#a3a3a3";
      valueEl.textContent = "0.00";
      topRow.append(labelEl, valueEl);
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = String(spec.min);
      slider.max = String(spec.max);
      slider.step = String(spec.step);
      slider.value = "0";
      slider.style.width = "100%";
      slider.addEventListener("input", () => {
        const v = parseFloat(slider.value);
        cameraDesignerValues[spec.key] = v;
        valueEl.textContent = v.toFixed(2);
        // Moving the Starting Angle slider while paused (autoRotate off)
        // should visibly relocate the preview right away rather than
        // waiting for rotation to carry it there — see cameraDesignerDriver,
        // which only reads cameraDesignerPreviewAngle/
        // cameraDesignerFocusPreviewAngle (not .angle directly) so it can
        // keep spinning smoothly while autoRotate is on. Both kinds have an
        // "angle" field now (orbit's own starting angle, and a focus shot's
        // new orbit offset — see CAMERA_FOCUS_FIELDS), so this picks
        // whichever live preview-angle variable matches the currently
        // rendered field set.
        if (spec.key === "angle" && !cameraDesignerValues.autoRotate) {
          if (cameraDesignerFields === CAMERA_DESIGNER_FIELDS) cameraDesignerPreviewAngle = v;
          else cameraDesignerFocusPreviewAngle = v;
        }
      });
      row.append(topRow, slider);
      cameraDesignerSlidersEl.appendChild(row);
      cameraDesignerSliderEls[spec.key] = { slider, valueEl };
    }
  }
  renderCameraDesignerSliders(CAMERA_DESIGNER_FIELDS);

  // autoRotate now applies to both kinds — a kind:"focus" slot got its own
  // angle/rotateSpeed/heightRotateSpeed too (see CAMERA_FOCUS_FIELDS), so
  // this control is no longer hidden for those slots (see the slot-select
  // "change" handler, which used to force-hide it via
  // `slot.kind === "focus" ? "none" : "flex"` — that special-casing is
  // gone now that a focus shot can orbit its own anchor rig just like the
  // 3 orbit slots orbit their own reset framing).
  const cameraDesignerAutoRotateLabel = document.createElement("label");
  cameraDesignerAutoRotateLabel.style.display = "flex";
  cameraDesignerAutoRotateLabel.style.gap = "6px";
  cameraDesignerAutoRotateLabel.style.alignItems = "center";
  cameraDesignerAutoRotateLabel.style.margin = "6px 0 0 0";
  const cameraDesignerAutoRotateToggle = document.createElement("input");
  cameraDesignerAutoRotateToggle.type = "checkbox";
  cameraDesignerAutoRotateLabel.append(cameraDesignerAutoRotateToggle, document.createTextNode("Auto-rotate (satellite drift)"));
  cameraDesignerControlsColEl.appendChild(cameraDesignerAutoRotateLabel);

  cameraDesignerAutoRotateToggle.addEventListener("change", () => {
    cameraDesignerValues.autoRotate = cameraDesignerAutoRotateToggle.checked;
    // Rotation Speed is meaningless while not rotating — greyed out (not
    // hidden) so its own last value is still visible/rememberable, same as
    // any other disabled-but-not-cleared control.
    cameraDesignerSliderEls.rotateSpeed.slider.disabled = !cameraDesignerValues.autoRotate;
    // Resume spinning from wherever the static preview was left sitting
    // (its current angle/height), not a stale position from before it was
    // paused — whichever kind is currently active.
    if (cameraDesignerValues.autoRotate) {
      if (cameraDesignerFields === CAMERA_DESIGNER_FIELDS) {
        cameraDesignerPreviewAngle = cameraDesignerValues.angle;
      } else {
        cameraDesignerFocusPreviewAngle = cameraDesignerValues.angle;
        cameraDesignerFocusPreviewHeightState.camElevation = cameraDesignerValues.height;
        cameraDesignerFocusPreviewHeightState.camElevationDir = 1;
      }
    }
  });

  // Reassigns cameraDesignerValues wholesale (rather than merging into the
  // existing object) so switching kinds never leaves a stale key from the
  // previous shape lying around (e.g. a leftover "radius" surviving a
  // switch to a focus slot) — see cameraDesignerFields above for which
  // field spec set is currently authoritative. autoRotate/rotateSpeed now
  // apply to both shapes (see CAMERA_FOCUS_FIELDS), so this is no longer
  // gated to CAMERA_DESIGNER_FIELDS specifically.
  function loadCameraDesignerValues(values) {
    const next = {};
    for (const spec of cameraDesignerFields) {
      const v = values[spec.key] ?? 0;
      next[spec.key] = v;
      const { slider, valueEl } = cameraDesignerSliderEls[spec.key];
      slider.value = String(v);
      valueEl.textContent = v.toFixed(2);
    }
    next.autoRotate = values.autoRotate !== false;
    cameraDesignerValues = next;
    cameraDesignerAutoRotateToggle.checked = cameraDesignerValues.autoRotate;
    cameraDesignerSliderEls.rotateSpeed.slider.disabled = !cameraDesignerValues.autoRotate;
    if (cameraDesignerFields === CAMERA_DESIGNER_FIELDS) {
      cameraDesignerPreviewAngle = cameraDesignerValues.angle;
    } else {
      cameraDesignerFocusPreviewAngle = cameraDesignerValues.angle;
      cameraDesignerFocusPreviewHeightState.camElevation = cameraDesignerValues.height;
      cameraDesignerFocusPreviewHeightState.camElevationDir = 1;
    }
  }
  loadCameraDesignerValues(cameraDesignerValues);

  cameraDesignerSlotSelect.addEventListener("change", () => {
    cameraDesignerStatusEl.textContent = "";
    const slotId = cameraDesignerSlotSelect.value;
    // Falls back to "wild" (kind:"orbit") for the blank "(pick a battle
    // type below)" placeholder option, same fallback the rest of this
    // handler already used before focus slots existed.
    const slot = CAMERA_OVERRIDE_SLOTS.find((s) => s.id === slotId) || CAMERA_OVERRIDE_SLOTS.find((s) => s.id === "wild");
    renderCameraDesignerSliders(slot.kind === "focus" ? CAMERA_FOCUS_FIELDS : CAMERA_DESIGNER_FIELDS);
    const defaults = cameraDesignerDefaultValues(slotId || "wild");
    // Merged with this slot's own defaults (not used as-is) so a saved
    // override captured before some field existed doesn't leave it
    // undefined — same "fill the gap, don't guess 0" reasoning as the Pose
    // Designer's own poseDesignerDefaultValues merge.
    const existing = slotId ? cameraOverrides[slotId] : null;
    loadCameraDesignerValues(existing ? { ...defaults, ...existing } : defaults);
  });

  cameraDesignerSaveToGameBtn.addEventListener("click", async () => {
    const slotId = cameraDesignerSlotSelect.value;
    if (!slotId) {
      cameraDesignerStatusEl.style.color = "#a3a3a3";
      cameraDesignerStatusEl.textContent = "Pick a battle type above first.";
      return;
    }
    cameraDesignerStatusEl.style.color = "#a3a3a3";
    cameraDesignerStatusEl.textContent = "Saving…";
    const values = { ...cameraDesignerValues };
    const result = await ctx.onSaveCameraOverride?.(slotId, values);
    if (result && result.ok) {
      // Takes effect immediately — the very next battle of this type reads
      // cameraOverrides fresh (see frame()'s own per-battle camera blocks),
      // not just on your next reconnect.
      cameraOverrides = result.cameraOverrides || {};
      cameraDesignerStatusEl.style.color = "#4ade80";
      const label = CAMERA_OVERRIDE_SLOTS.find((s) => s.id === slotId).label;
      cameraDesignerStatusEl.textContent = `Saved — ${label}'s camera will use this now.`;
    } else {
      cameraDesignerStatusEl.style.color = "#ef4444";
      cameraDesignerStatusEl.textContent = "Could not save — try again?";
    }
  });

  cameraDesignerResetToDefaultBtn.addEventListener("click", async () => {
    const slotId = cameraDesignerSlotSelect.value;
    if (!slotId) {
      cameraDesignerStatusEl.style.color = "#a3a3a3";
      cameraDesignerStatusEl.textContent = "Pick a battle type above first.";
      return;
    }
    cameraDesignerStatusEl.style.color = "#a3a3a3";
    cameraDesignerStatusEl.textContent = "Resetting…";
    const result = await ctx.onResetCameraOverride?.(slotId);
    if (result && result.ok) {
      cameraOverrides = result.cameraOverrides || {};
      loadCameraDesignerValues(cameraDesignerDefaultValues(slotId));
      cameraDesignerStatusEl.style.color = "#4ade80";
      const label = CAMERA_OVERRIDE_SLOTS.find((s) => s.id === slotId).label;
      cameraDesignerStatusEl.textContent = `Reset — ${label}'s camera is back to the built-in framing.`;
    } else {
      cameraDesignerStatusEl.style.color = "#ef4444";
      cameraDesignerStatusEl.textContent = "Could not reset — try again?";
    }
  });

  // Drives the shared mountPreview camera (see that function's own
  // options.cameraDriver hook) from these live slider values instead of
  // mouse drag. For a kind:"orbit" slot this is the exact same position/
  // lookAt formula shape the real per-battle reset cameras use (see
  // frame()'s own cameraOverrides blocks below), just centered on the
  // preview's own origin instead of a battle's centerX/centerZ. For a
  // kind:"focus" slot it instead demonstrates the focus formula itself via
  // computeFocusCameraFrame — the exact same shared function
  // focusWildCameraOnRig calls — anchored on one of the preview's own two
  // battle-scene rigs (see PREVIEW_BATTLE_WILD_Z/PLAYER_Z in mountPreview;
  // read as plain {x,z} positions here since this preview never gets a
  // handle to the real rig objects, only mountPreview's own fixed layout of
  // them), now also demonstrating a focus slot's own orbit
  // (angle/rotateSpeed) and height-bounce (heightRotateSpeed) the same way
  // the orbit branch below does for its own rotateSpeed/
  // elevationRotateSpeed — see cameraDesignerFocusPreviewAngle/
  // cameraDesignerFocusPreviewHeightState above. NOTE: there was no live
  // three.js rendering available while writing this branch — the math
  // mirrors the real formula exactly, but it needs an actual click-through
  // in the Camera Designer to confirm the resulting shot (and its
  // rotation, now) looks right for all 4 focus slots.
  function cameraDesignerDriver(camera, dt) {
    const slotId = cameraDesignerSlotSelect.value;
    const slot = CAMERA_OVERRIDE_SLOTS.find((s) => s.id === slotId);
    if (slot && slot.kind === "focus") {
      const playerPos = { x: 0, z: PREVIEW_BATTLE_PLAYER_Z };
      const wildPos = { x: 0, z: PREVIEW_BATTLE_WILD_Z };
      // "wild_decide_defend"/"wild_declare"/"wild_attack_scene" all anchor
      // on the player-side rig looking at the wild — matching (or, for
      // wild_declare, illustrating a clearer version of) their own real
      // call sites in beginRound/showWildDeclareStep/resolvePlayerAttack.
      // "wild_defend_scene" anchors on the wild rig instead, looking back
      // at the player — mirroring that slot's own "the wild is defending"
      // real variant (resolvePlayerAttack's own wild_defend_scene call) and
      // giving this slot a visibly distinct preview shot from the other 3.
      let anchorPos = playerPos;
      let anchorFacing = 0; // the preview's own player-side rig faces forward, unrotated — see mountPreview's battleScenePreview branch
      let lookAtPos = wildPos;
      if (slotId === "wild_defend_scene") {
        anchorPos = wildPos;
        anchorFacing = Math.PI; // matches mountPreview's own wildRig.group.rotation.y for the battle-scene preview
        lookAtPos = playerPos;
      }
      if (cameraDesignerValues.autoRotate) {
        cameraDesignerFocusPreviewAngle += (cameraDesignerValues.rotateSpeed ?? 0) * dt;
      }
      const theta = cameraDesignerValues.autoRotate ? cameraDesignerFocusPreviewAngle : (cameraDesignerValues.angle ?? 0);
      const heightRotateSpeed = cameraDesignerValues.autoRotate ? (cameraDesignerValues.heightRotateSpeed ?? 0) : 0;
      const height = advanceOrbitElevation(cameraDesignerFocusPreviewHeightState, cameraDesignerValues.height, heightRotateSpeed, dt, FOCUS_CAM_HEIGHT_MIN, FOCUS_CAM_HEIGHT_MAX);
      const frame = computeFocusCameraFrame(anchorPos, anchorFacing, lookAtPos, { ...cameraDesignerValues, height }, theta);
      camera.position.set(frame.camX, frame.camY, frame.camZ);
      camera.lookAt(frame.lookX, frame.lookY, frame.lookZ);
      return;
    }
    if (cameraDesignerValues.autoRotate) {
      cameraDesignerPreviewAngle += cameraDesignerValues.rotateSpeed * dt;
    }
    const angle = cameraDesignerValues.autoRotate ? cameraDesignerPreviewAngle : cameraDesignerValues.angle;
    const radius = cameraDesignerValues.radius;
    const elevationRotateSpeed = cameraDesignerValues.autoRotate ? (cameraDesignerValues.elevationRotateSpeed ?? 0) : 0;
    const elevation = advanceOrbitElevation(cameraDesignerPreviewElevationState, cameraDesignerValues.elevation, elevationRotateSpeed, dt, MIN_ELEVATION, MAX_ELEVATION);
    camera.position.set(
      Math.sin(angle) * Math.cos(elevation) * radius,
      PREVIEW_TARGET_Y + Math.sin(elevation) * radius,
      Math.cos(angle) * Math.cos(elevation) * radius,
    );
    camera.lookAt(0, PREVIEW_TARGET_Y, 0);
  }

  function hideCameraDesignerModal() {
    cameraDesignerModalEl.style.display = "none";
    cameraDesignerPreview?.dispose();
    cameraDesignerPreview = null;
  }
  cameraDesignerCloseBtn.addEventListener("click", hideCameraDesignerModal);
  cameraDesignerButton.addEventListener("click", () => {
    devMenuPanelEl.style.display = "none";
    cameraDesignerModalEl.style.display = "flex";
    // battleScenePreview — see mountPreview's own option — replaces the
    // single centered character every other preview caller gets with a
    // small randomized "battle" (a wild-side rig + a your-side rig) so the
    // Camera Designer actually frames something battle-shaped, not a lone
    // character spinning in place. Re-mounted fresh (new random species)
    // every time the panel opens, same as re-picking a wild encounter.
    cameraDesignerPreview = mountPreview(cameraDesignerPreviewEl, localColors, {
      cameraDriver: cameraDesignerDriver,
      battleScenePreview: true,
    });
  });

  // Dama Phase 1 — a self-play test modal for the pure rules engine (see
  // dama.js). No hosting, no networking, no AI: the same player just moves
  // both sides, purely to prove the rules/board actually work before any
  // of that gets built. board/sideToMove/etc. all live here in mount()'s
  // own closure, same shape as every other Dev-menu tool's state.
  let damaBoard = null;
  let damaSideToMove = "white";
  let damaSelectedSquare = null; // {row, col} | null
  let damaLegalMoves = []; // getAllLegalMoves(damaBoard, damaSideToMove) — already capture-only if any capture exists
  let damaMidChain = false; // true while a multi-jump capture must continue with the same piece
  let damaWinner = null; // "white" | "black" | null

  const damaModalEl = document.createElement("div");
  damaModalEl.style.position = "absolute";
  damaModalEl.style.display = "none";
  damaModalEl.style.inset = "0";
  damaModalEl.style.background = "#000000b3";
  damaModalEl.style.zIndex = "26";
  damaModalEl.style.alignItems = "center";
  damaModalEl.style.justifyContent = "center";
  const damaCardEl = document.createElement("div");
  damaCardEl.style.background = "#1a1a1aee";
  damaCardEl.style.border = "1px solid #3333334d";
  damaCardEl.style.borderRadius = "6px";
  damaCardEl.style.padding = "10px";
  damaCardEl.style.width = "320px";
  damaCardEl.style.fontSize = "12px";
  damaCardEl.style.display = "flex";
  damaModalEl.appendChild(damaCardEl);
  wrap.appendChild(damaModalEl);
  const { heading: damaHeadingEl, closeBtn: damaCloseBtn, body: damaBodyEl } = setupModalCard(damaCardEl, "85%");
  damaHeadingEl.textContent = "Dama (test — self-play)";

  const damaStatusEl = document.createElement("p");
  damaStatusEl.style.fontSize = "11px";
  damaStatusEl.style.margin = "0 0 6px 0";
  damaBodyEl.appendChild(damaStatusEl);

  const damaGridEl = document.createElement("div");
  damaGridEl.style.display = "grid";
  damaGridEl.style.gridTemplateColumns = "repeat(8, 36px)";
  damaGridEl.style.gridTemplateRows = "repeat(8, 36px)";
  damaGridEl.style.width = "288px";
  damaBodyEl.appendChild(damaGridEl);

  const damaNewGameBtn = document.createElement("button");
  damaNewGameBtn.textContent = "New Game";
  damaNewGameBtn.style.fontSize = "11px";
  damaNewGameBtn.style.marginTop = "8px";
  damaNewGameBtn.style.cursor = "pointer";
  damaBodyEl.appendChild(damaNewGameBtn);

  function resetDamaGame() {
    damaBoard = createInitialDamaBoard();
    damaSideToMove = "white";
    damaSelectedSquare = null;
    damaMidChain = false;
    damaWinner = null;
    damaLegalMoves = getAllLegalMoves(damaBoard, damaSideToMove);
  }

  function renderDamaModal() {
    damaGridEl.innerHTML = "";
    const destinations = damaSelectedSquare
      ? damaLegalMoves.filter((m) => m.from.row === damaSelectedSquare.row && m.from.col === damaSelectedSquare.col).map((m) => m.to)
      : [];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const sq = document.createElement("div");
        sq.style.width = "36px";
        sq.style.height = "36px";
        sq.style.display = "flex";
        sq.style.alignItems = "center";
        sq.style.justifyContent = "center";
        sq.style.position = "relative";
        sq.style.cursor = "pointer";
        const light = (row + col) % 2 === 0;
        sq.style.background = light ? TAMBAYAN_BOARD_LIGHT : TAMBAYAN_BOARD_DARK;
        const isSelected = damaSelectedSquare && damaSelectedSquare.row === row && damaSelectedSquare.col === col;
        sq.style.boxShadow = isSelected ? "inset 0 0 0 2px orange" : "none";
        const piece = damaBoard[row][col];
        if (piece) {
          const disc = document.createElement("div");
          disc.style.width = "26px";
          disc.style.height = "26px";
          disc.style.borderRadius = "50%";
          disc.style.display = "flex";
          disc.style.alignItems = "center";
          disc.style.justifyContent = "center";
          disc.style.fontSize = "13px";
          disc.style.background = piece.side === "white" ? "#f5f5f5" : "#1f2937";
          disc.style.border = piece.side === "white" ? "2px solid #1f2937" : "2px solid #f5f5f5";
          if (piece.king) {
            disc.textContent = "★";
            disc.style.color = piece.side === "white" ? "#1f2937" : "#f5f5f5";
          }
          sq.appendChild(disc);
        }
        if (destinations.some((d) => d.row === row && d.col === col)) {
          const dot = document.createElement("div");
          dot.style.position = "absolute";
          dot.style.width = "10px";
          dot.style.height = "10px";
          dot.style.borderRadius = "50%";
          dot.style.background = "#4ade8099";
          sq.appendChild(dot);
        }
        sq.addEventListener("click", () => onDamaSquareClick(row, col));
        damaGridEl.appendChild(sq);
      }
    }
    if (damaWinner) {
      damaStatusEl.textContent = `${damaWinner === "white" ? "White" : "Black"} wins!`;
    } else {
      const mandatory = damaLegalMoves.length > 0 && damaLegalMoves[0].captured;
      const turnText = `${damaSideToMove === "white" ? "White" : "Black"}'s turn`;
      damaStatusEl.textContent = damaMidChain
        ? `${turnText} — continue capturing with the same piece`
        : mandatory
          ? `${turnText} — capture available (mandatory)`
          : turnText;
    }
  }

  function onDamaSquareClick(row, col) {
    if (!damaBoard || damaWinner) return;
    const piece = damaBoard[row][col];

    if (damaSelectedSquare) {
      const move = damaLegalMoves.find(
        (m) => m.from.row === damaSelectedSquare.row && m.from.col === damaSelectedSquare.col && m.to.row === row && m.to.col === col,
      );
      if (move) {
        const result = applyDamaMove(damaBoard, move);
        damaBoard = result.board;
        if (result.continuedCaptureFrom) {
          damaMidChain = true;
          damaSelectedSquare = result.continuedCaptureFrom;
          damaLegalMoves = getAllLegalMoves(damaBoard, damaSideToMove, damaSelectedSquare);
        } else {
          damaMidChain = false;
          damaSelectedSquare = null;
          damaSideToMove = damaSideToMove === "white" ? "black" : "white";
          damaLegalMoves = getAllLegalMoves(damaBoard, damaSideToMove);
          if (damaLegalMoves.length === 0) damaWinner = damaSideToMove === "white" ? "black" : "white";
        }
        renderDamaModal();
        return;
      }
      if (damaMidChain) return; // must keep capturing with the same piece — ignore anything else
      if (piece && piece.side === damaSideToMove && damaLegalMoves.some((m) => m.from.row === row && m.from.col === col)) {
        damaSelectedSquare = { row, col };
      } else {
        damaSelectedSquare = null;
      }
      renderDamaModal();
      return;
    }

    if (piece && piece.side === damaSideToMove && damaLegalMoves.some((m) => m.from.row === row && m.from.col === col)) {
      damaSelectedSquare = { row, col };
      renderDamaModal();
    }
  }

  damaNewGameBtn.addEventListener("click", () => {
    resetDamaGame();
    renderDamaModal();
  });
  damaCloseBtn.addEventListener("click", () => {
    damaModalEl.style.display = "none";
  });
  damaTestButton.addEventListener("click", () => {
    devMenuPanelEl.style.display = "none";
    damaModalEl.style.display = "flex";
    resetDamaGame();
    renderDamaModal();
  });

  el.appendChild(wrap);

  const { renderer, scene, camera } = createScene(canvas);
  // Only the real overworld gets these (not mountPreview's tight
  // character-color close-up) — see buildSkyDome/buildSunSprite's own
  // comments for why this couldn't just live inside createScene itself.
  const skyDome = buildSkyDome(scene);
  const sunSprite = buildSunSprite(scene);
  // See buildTown's own comment — townWallSegmentsByFloor is keyed by
  // floor index (0 = ground), and glophicsFloorGroups is every ABOVE-ground
  // floor's + the roof's own THREE.Group (see applyGlophicsFloorCutaway).
  // groundWallSegments is just a convenience alias for the one array that
  // existed before floors did — the Karirs field/Luba area are both
  // ground-only, so their own walls get folded into that same array
  // exactly like before this feature existed.
  const { wallSegmentsByFloor: townWallSegmentsByFloor, glophicsFloorGroups, sign: townSign, cinemaUsherRig: usherRig } = buildTown(scene);
  const groundWallSegments = townWallSegmentsByFloor[0];
  const jaredSign = buildJaredShop(scene);
  const { board: karirsBoard, tvGroup: karirsTvGroup } = buildKarirsField(scene, groundWallSegments);
  buildKarirsTrack(scene);
  const karirsRacerMarkers = KARIRS_TRACK_LANE_OFFSETS.map((_, i) =>
    buildKarirsRacerRig(scene, KARIRS_RACER_COLORS[i % KARIRS_RACER_COLORS.length]),
  );
  const { sign: lubaSign } = buildLubaArea(scene, groundWallSegments);
  // Every real walled area's own floating name sign (Karirs has none —
  // buildKarirsField never built one, so `sign` stays null there and the
  // fade below just skips it) plus its footprint, used by updateAreaLabels
  // (frame()'s own per-frame call) to fade the FLOATING 3D sign out while
  // you're standing inside that area and drive the flat 2D label beside
  // the minimap instead — "Plains" whenever you're inside none of them.
  const AREA_LABELS = [
    { name: TOWN_NAME, x: 0, z: 0, half: TOWN_HALF_X, sign: townSign },
    { name: KARIRS_FIELD_NAME, x: KARIRS_FIELD_X, z: KARIRS_FIELD_Z, half: KARIRS_FIELD_HALF, sign: null },
    { name: LUBA_NAME, x: LUBA_X, z: LUBA_Z, half: LUBA_HALF, sign: lubaSign },
  ];
  const {
    board1Group: chessBoard1Group, board1StatusSign: chessBoard1StatusSign,
    board2Group: chessBoard2Group, board2StatusSign: chessBoard2StatusSign,
    board3Group: chessBoard3Group, board3StatusSign: chessBoard3StatusSign,
  } = buildTambayan(scene);
  // Blocks movement into a solid wall segment while leaving the door gaps
  // and the whole interior plaza open — see buildAreaWalls for how these
  // boxes are laid out (both Glophics' ground floor and the Karirs field's
  // walls share groundWallSegments/townWallSegmentsByFloor[0]). Both the
  // local player's own movement and every wild spawn's wander/chase/flee
  // movement resolve against this — floor defaults to 0 (ground) since
  // every wild spawn and every other walled area (Karirs, Luba, Tambayan)
  // only ever exists on the ground; only the local player's own movement
  // resolution (see frame()'s own per-axis block) ever passes a non-zero
  // floor, once they've gone upstairs inside Glophics.
  function isInsideTownWalls(x, z, floor = 0) {
    const segs = townWallSegmentsByFloor[floor];
    if (!segs) return false;
    for (const seg of segs) {
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
  //
  // Checks EVERY floor's own wall segments, not just whichever one the
  // target (usually the player) currently happens to be on — this used to
  // key off local.currentFloor (before that, it was hardcoded to the
  // ground floor outright), on the assumption the ONLY wall that could
  // ever occlude the camera-to-target line was one belonging to the same
  // floor the target was standing on. That's false the moment the target
  // is OUTSIDE the tower on the ground floor and the camera/target line
  // happens to pass through floor 2's own (taller, and further away
  // vertically) walls anyway — a real, reported case, not a hypothetical
  // one. segmentIntersectsWallBox already reads each segment's own
  // baseY/wallHeight and does a real 3D segment/AABB test, so there's
  // nothing floor-specific about the actual math — restricting *which*
  // segments it's allowed to even look at was the only bug. A wall
  // belonging to a floor that's currently hidden entirely (see
  // applyGlophicsFloorCutaway/setGroupHidden) fading under the hood is
  // harmless — an invisible parent's own child mesh never renders
  // regardless of its own material.opacity.
  function updateTownWallFade(dt, targetX = local.x, targetY = local.y + PAN_TARGET_Y, targetZ = local.z) {
    const ease = Math.min(1, TOWN_WALL_FADE_RATE * dt);
    // Ground floor only (townWallSegmentsByFloor[0]) — shared by Glophics'
    // own ground level, Karirs, and Luba, none of which are tall enough for
    // this per-segment partial-opacity fade to matter much either way.
    // Glophics' own ABOVE-ground floor(s) are deliberately excluded here:
    // they're each many times taller (see GLOPHICS_FLOORS' own wallHeight),
    // and the discrete whole-group hide updateGlophicsExteriorCutaway
    // already applies to them (both for "player standing inside" and now
    // "camera occluded from outside," see isGlophicsVolumeOccludingView)
    // is the right tool for geometry that size — running BOTH systems on
    // the same tall wall at once meant this fade's own continuous
    // transparent-material churn kept fighting the group-level hide,
    // which is what was actually behind the reported "camera swings
    // through the tower and the view locks up" bug, not just a visual
    // glitch.
    const segs = townWallSegmentsByFloor[0] ?? [];
    for (const seg of segs) {
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
  // GlophimonCharacter.current_hp/POST /me/hp), shared by PVP and real-time
  // wild combat alike. Wild combat itself is server-authoritative now (see
  // this game's own plan file) — every actual hit arrives as a pushed
  // hp_update/player_blackout (see onSocketMessage) rather than a local
  // setPlayerHp call; this function stays the one path for the two
  // LOCAL-initiated changes that remain (Rodz's heal, and blacking out's own
  // full-heal-and-teleport).
  let playerHp = character.current_hp ?? PLAYER_MAX_HP;
  // Non-null for effectivePoseDurationMs("flinch") right after this
  // account's own body takes a mob hit (see onSocketMessage's own
  // hp_update handling) — same decaying red flash + recoil pose as a
  // wild's own flinch (see updateWildSpawns), applied to local.rig instead
  // inside frame().
  let playerFlinchElapsedMs = null;

  // The server resolves a hit the instant the attack message arrives, but
  // the SWING itself still takes effectivePoseDurationMs("attack") to
  // actually connect on screen (longer still with a saved Pose Designer
  // override) — applying hp_update/player_blackout the moment they arrive
  // would make the player's own body react to damage well before the mob's
  // swing visually lands. Both are buffered here instead (see wild_attack's
  // own handler, which sets this the instant the mob's swing starts) and
  // only actually applied once that same local animation finishes (see
  // frame()'s own countdown) — a purely client-side, per-viewer visual
  // sync; the hp VALUE itself is still the server's own authoritative one,
  // just held briefly before it's shown.
  let pendingWildAttackDelayMs = null;
  let pendingPlayerHp = null; // {currentHp, delayMs}
  let pendingPlayerBlackout = null; // {delayMs}
  // Same idea, the other direction — a companion's own swing at a wild
  // (see companion_attack_landed's own handler below, and
  // updateWildSpawns' own countdown). The actual pending hp/kill data
  // lives on the wild's own spawn object (pendingHp/pendingDeath, see
  // ensureWildSpawn) since — unlike the player's own body — there can be
  // many wilds at once; this single flat variable only ever bridges the
  // one companion_attack_landed message to the wild_hp_update/wild_despawn
  // message that always immediately follows it from the same server-side
  // handler call.
  let pendingCompanionAttackDelayMs = null;

  function setPlayerHp(newHp) {
    playerHp = Math.max(0, Math.min(PLAYER_MAX_HP, newHp));
    ctx.onSetPlayerHp?.(playerHp);
    refreshPlayerHpHud();
  }

  // "Blacking out" — trainer HP hit 0. No permanent loss, same as the real
  // games: a free heal, but at the cost of a trip back to Glophics (its
  // exact center, matching the api's own DEFAULT_SPAWN) rather than staying
  // wherever the hit landed. Also drops the player back to the ground
  // floor — wild combat only ever happens outdoors (nothing spawns inside
  // the tower), so this should never actually fire while currentFloor is
  // non-zero, but it's a one-line safety net rather than an assumption
  // worth leaving unenforced.
  function handlePlayerBlackout() {
    setPlayerHp(PLAYER_MAX_HP);
    local.x = 0;
    local.z = 0;
    local.facingAngle = 0;
    if (local.currentFloor !== 0) {
      local.currentFloor = 0;
      local.y = 0;
      applyGlophicsFloorCutaway(0);
    }
  }

  const localColors = {
    head: character.head_color,
    body: character.body_color,
    arm: character.arm_color,
    leg: character.leg_color,
  };
  const localRig = buildBlockyCharacter(localColors, character.display_name);
  // character.floor is this account's own persisted floor (see the api's
  // own GlophimonCharacter.floor/CharacterOut.floor) — a freshly-connecting
  // client resumes on whatever floor it last left the tower on, the same
  // "pick up exactly where you left off" treatment x/z/facing already get.
  const initialFloor = character.floor ?? 0;
  const local = {
    x: character.x,
    y: entityGroundY(initialFloor, character.x, character.z),
    z: character.z,
    facingAngle: character.facing,
    // currentFloor is the FIRST piece of real vertical state in this whole
    // codebase — 0 is the ground floor (identical to how every peer/NPC/
    // wild spawn/battle rig has always implicitly lived), a positive index
    // matches one of GLOPHICS_FLOORS' own `index` values. Everything that
    // needs to know "what floor is the player on" (movement collision,
    // the camera's own Y offset, cutaway transparency, the stairs, and the
    // network position broadcast) reads this one field.
    currentFloor: initialFloor,
    rig: localRig,
    isMoving: false,
    chatBubble: null,
    chatBubbleExpiresAt: 0,
  };
  local.rig.group.position.set(local.x, local.y, local.z);
  local.rig.group.rotation.y = local.facingAngle;
  scene.add(local.rig.group);
  // Establishes the correct initial transparency state for a client that
  // connects already partway up the tower (see initialFloor above) —
  // every other call site only runs on a subsequent floor CHANGE via the
  // stairs, so without this a client resuming on floor 1 would see it (and
  // the roof) rendered fully opaque until the next time they used the
  // stairs.
  applyGlophicsFloorCutaway(local.currentFloor);

  // Sprinting stamina — see SPRINT_SPEED_MULTIPLIER/STAMINA_* above.
  let stamina = STAMINA_MAX;
  let staminaExhausted = false;

  // Per-account pose overrides (see the api's own CharacterOut.pose_overrides
  // and the Pose Designer dev panel's "Save to Game") — {} until something's
  // actually been saved. Only ever applied to the LOCAL player's own rig
  // (see tryPlayOverride below); NPCs and wild Glophimon have no account to
  // key an override by, so they always keep the built-in poses. Reassigned
  // wholesale (not mutated) by saves/resets below, same reasoning the api's
  // own PUT/DELETE handlers already use for their own copy.
  let poseOverrides = { ...(ctx.poseOverrides || {}) };
  // Per-account camera overrides (see the api's own
  // CharacterOut.camera_overrides and the Camera Designer dev panel's "Save
  // to Game") — {} until something's actually been saved. Keyed by battle
  // type ("wild"/"team"/"pvp"), read every frame by the per-battle reset/
  // orbit camera blocks below, falling back to the same hardcoded defaults
  // as always whenever a given slot has no override. Reassigned wholesale
  // (not mutated) by saves/resets, same reasoning as poseOverrides above.
  let cameraOverrides = { ...(ctx.cameraOverrides || {}) };
  // elapsedMs per pose slot — reset to 0 whenever the local player switches
  // which slot is currently playing, so a keyframe loop always restarts
  // cleanly from its own beginning rather than resuming mid-cycle.
  const poseOverrideElapsedMs = {};
  let activePoseOverrideName = null;

  function tryPlayLocalOverride(poseName, dt) {
    const override = poseOverrides[poseName];
    if (!override || !override.keyframes || override.keyframes.length === 0) return false;
    if (activePoseOverrideName !== poseName) {
      activePoseOverrideName = poseName;
      poseOverrideElapsedMs[poseName] = 0;
    }
    poseOverrideElapsedMs[poseName] += dt * 1000;
    return playPoseKeyframes(local.rig, override.keyframes, poseOverrideElapsedMs[poseName]);
  }

  // Battle-creature counterpart to tryPlayLocalOverride above — plays a
  // saved Ready/Attack/Defend/Cast override on an arbitrary rig, whether
  // it's one of the local player's own Glophimon or the wild/opponent side
  // (see updateBattleRigAnim) — a purely local rendering choice, same as
  // any other pose override. `hold` clamps playback just short of the
  // recorded keyframes' own total length instead of letting
  // playPoseKeyframes wrap it, so a one-shot attack/defend/cast pose
  // freezes on its last frame the same way the built-in applyAttackPose/
  // applyDefendPose/applyCastPose do, rather than looping mid-swing.
  function poseOverrideTotalMs(keyframes) {
    return keyframes.reduce((sum, kf) => sum + Math.max(1, kf.transitionMs), 0);
  }

  function tryPlayBattlePoseOverride(rig, poseName, elapsedMs, hold) {
    const override = poseOverrides[poseName];
    if (!override || !override.keyframes || override.keyframes.length === 0) return false;
    let playElapsed = elapsedMs;
    if (hold) {
      playElapsed = Math.min(elapsedMs, poseOverrideTotalMs(override.keyframes) - 1);
    }
    return playPoseKeyframes(rig, override.keyframes, playElapsed);
  }

  // How long a given battle-creature pose slot will ACTUALLY play for, from
  // this local viewer's own perspective — mirrors updateBattleRigAnim's own
  // duration calc exactly (a saved override plays out over its own recorded
  // length; only the built-in poses use the fixed ATTACK_ANIM_MS/CAST_ANIM_MS/
  // DEFEND_ANIM_MS). Used to size the wild battle's own round-advance timers
  // (see resolvePlayerAttack/resolveWildAttack) so the round can't advance —
  // and the camera can't re-aim/reset away from the current shot — before
  // whatever's actually playing has actually finished, which the old fixed
  // ANIM_SETTLE_MS couldn't guarantee once a saved pose could run longer
  // than any of the built-in durations it was originally sized around.
  function effectivePoseDurationMs(type) {
    const override = poseOverrides[type];
    if (override && override.keyframes && override.keyframes.length > 0) {
      return poseOverrideTotalMs(override.keyframes);
    }
    return type === "attack" ? ATTACK_ANIM_MS : type === "cast" ? CAST_ANIM_MS : type === "flinch" ? FLINCH_ANIM_MS : DEFEND_ANIM_MS;
  }

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

  // Stockfish — just a standing decoration facing back toward its own
  // table, unlike Rodz/Carrin/Jared/Boss Rick above: the battle itself is
  // started by clicking the BOARD (see onCanvasClick's board3 branch), not
  // by clicking this rig, so it gets no menu/highlight-on-hover of its own.
  const stockfishRig = buildBlockyCharacter(STOCKFISH_COLORS, STOCKFISH_NAME);
  stockfishRig.group.position.set(STOCKFISH_X, 0, STOCKFISH_Z);
  stockfishRig.group.rotation.y = Math.PI;
  scene.add(stockfishRig.group);

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
    // Rodz stands on the Glophics ground floor (see his own group.position.set
    // above, y=0) — gated on being inside Town on floor 0 (see getAreaKey's
    // own comment), same as a peer's chat bubble's sameArea/entityFloor
    // checks, so this bubble doesn't show through the floor to someone up
    // in the cinema, or through Town's own wall to someone in a different
    // building entirely.
    rodzShoutBubble.visible =
      getAreaKey(local.x, local.z) === "town" &&
      local.currentFloor === 0 &&
      Math.hypot(local.x - RODZ_X, local.z - RODZ_Z) <= LABEL_VISIBLE_DISTANCE;
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

  // A brief red emissive flash on a hit landing (see onSocketMessage's own
  // wild_hp_update/hp_update handling below), alongside the actual Flinch
  // pose (see FLINCH_ANIM_MS/applyFlinchPose/POSE_OVERRIDE_SLOTS) — takes
  // visual priority over the proximity highlight below for its own short
  // duration since "I was just hit" is more urgent feedback than "you could
  // click this."
  const FLINCH_COLOR = new THREE.Color("#ff3b3b");
  const FLINCH_PEAK = 0.9;

  // color defaults to the NPC highlight's own yellow — a wild's own
  // proximity highlight (see updateWildSpawns) reuses that default, while
  // flinch flashes (see FLINCH_COLOR) pass their own red instead.
  function setRigEmissiveIntensity(rig, intensity, color = NPC_HIGHLIGHT_COLOR) {
    rig.group.traverse((obj) => {
      if (obj.isMesh && obj.material && obj.material.emissive) {
        obj.material.emissive.set(color);
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
  const updateUsherHighlight = createNpcHighlightUpdater(usherRig, () => [USHER_X, USHER_Z]);

  // Mirrors the last chess_state received per board (see onSocketMessage's
  // own chess_state branch) — {status, hostId, hostDisplayName,
  // whiteUserId, whiteDisplayName, blackUserId, blackDisplayName, fen,
  // turn, moveHistory, outcome}. Starts "empty" until the server's own
  // initial broadcast (sent to every connection on join, see main.py)
  // lands.
  const chessBoards = {
    1: { status: "empty" },
    2: { status: "empty" },
    3: { status: "empty" },
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
  const updateChessBoard3Highlight = createNpcHighlightUpdater(
    { group: chessBoard3Group },
    () => [CHESS_BOARD_3_X, CHESS_BOARD_3_Z],
    () => chessBoards[3].status === "in_progress" && isInsideTambayan(local.x, local.z),
  );
  const CHESS_BOARD_SIGNS = { 1: chessBoard1StatusSign, 2: chessBoard2StatusSign, 3: chessBoard3StatusSign };

  // user_id -> peer state, for everyone *else* currently connected.
  const peers = new Map();

  // Full spectator mode for OTHER players' wild battles — user_id (the
  // battling player, not this client's own) -> that battle's render state.
  // Populated/updated by applySpectatorBattleSnapshot (see onSocketMessage's
  // own wild_battle_state/wild_battle_roster handling) and torn down by
  // teardownSpectatorBattleEntry (wild_battle_end). Wild battles are still
  // entirely client-side/non-authoritative — the battling player's own
  // client is the only thing that ever actually simulates the fight (see
  // startWildBattle/resolvePlayerAttack/resolveWildAttack below); this map
  // is purely a *render* of whatever that client's own buildBattleSnapshot
  // last narrated to the server, the same "server just relays, this client
  // just renders" relationship `peers` and `wildSpawns` themselves already
  // have with position/wild_tick broadcasts. Never has an entry for this
  // client's own battle (that's `battle` below, rendered completely
  // differently — full intro animation, interactive UI, etc.) or for the
  // dev-only "Simulate Wild Battle" shortcut (never sent to the server at
  // all, see startWildBattle's own wildId guard).
  const peerBattles = new Map();

  function ensurePeer(userId, displayName, appearance, x, z, facing, floor = 0) {
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
        y: entityGroundY(floor, x, z),
        z,
        facingAngle: facing,
        targetX: x,
        targetZ: z,
        targetFacing: facing,
        // Which Glophics floor this peer is currently on (see the api's
        // own CharacterOut/position-message "floor" field) — defaults to 0
        // defensively for a message predating this field, though every
        // client should send it from here on. Kept up to date by
        // onSocketMessage's own "position" handling below; used every
        // frame (see the peers render loop in frame()) to hide this peer
        // outright whenever it differs from local.currentFloor.
        floor,
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
      peer.rig.group.position.set(x, peer.y, z);
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
  // own mesh-only traversal. Just a thin wrapper over setGroupTransparent
  // (a rig's own .group) — see that function for the actual mechanics,
  // generalized so applyGlophicsFloorCutaway can reuse the exact same
  // opacity/transparent/needsUpdate dance on a plain scenery THREE.Group
  // that was never built via buildBlockyCharacter.
  function setRigTransparent(rig, on) {
    setGroupTransparent(rig.group, on);
  }

  function setLocalTransparent(on) {
    setRigTransparent(local.rig, on);
  }

  // Real vertical cutaway, Pokémon Center/Gym style — every above-ground
  // Glophics floor group (each entry in glophicsFloorGroups, built once by
  // buildTown: every floor in GLOPHICS_FLOORS plus the roof at
  // GLOPHICS_ROOF_INDEX) goes translucent once the player is standing on
  // or above it, opaque again once they're not. "index > currentFloor"
  // is the whole rule and generalizes to any number of floors without
  // change: on the ground floor (currentFloor=0) every above-ground group
  // is transparent (floor 1 AND the roof); once up on floor 1
  // (currentFloor=1) only the roof (index 2 > 1) stays transparent, floor
  // 1's own group (index 1) is no longer > 1 so it turns back opaque — and
  // the ground floor is never in this list at all, so it's simply never
  // touched, matching "the ground floor never fades."
  //
  // This is a DISCRETE state change, called only when local.currentFloor
  // actually changes (see checkStairsContact/handlePlayerBlackout and the
  // one-time initial call right after `local` itself is built) — unlike
  // updateTownWallFade's continuous per-frame ease, there's nothing to
  // animate here, just an on/off flip the moment the floor changes.
  function applyGlophicsFloorCutaway(currentFloor) {
    for (const { index, group } of glophicsFloorGroups) {
      setGroupHidden(group, index > currentFloor);
    }
  }

  // Simple X/Z footprint test against Glophics' own outer wall line —
  // deliberately NOT isInsideTownWalls (that tests the shared per-floor
  // wallSegments array, which lumps Glophics' ground floor in with Karirs'
  // and Luba's own ground-floor walls too, since they've always shared one
  // array). This only needs to answer "is the player standing anywhere
  // within Glophics' own tower footprint," regardless of which floor.
  function isInsideGlophicsFootprint(x, z) {
    return isInsideAreaFootprint(x, z, 0, 0, TOWN_HALF_X);
  }

  // One combined box spanning every above-ground Glophics floor + the roof
  // (ground level up through GLOPHICS_ROOF_Y, plus a little slack for the
  // roof slab's own thickness) — used only to ask "does the camera-to-
  // player line pass through the tower's airspace at all," not which floor
  // specifically. Deliberately coarser than a real per-wall raycast (see
  // this function's own caller) — a false "yes, it's blocking" just hides
  // the building a touch more eagerly than strictly necessary, which is
  // the safe direction to err in for a sight-blocking fix, and reusing
  // segmentIntersectsWallBox's existing cheap slab test avoids a second,
  // much pricier per-mesh raycast system.
  const GLOPHICS_VOLUME_BOX = { minX: -TOWN_HALF_X, maxX: TOWN_HALF_X, minZ: -TOWN_HALF_Z, maxZ: TOWN_HALF_Z, baseY: 0, wallHeight: GLOPHICS_ROOF_Y + 1 };

  // Is the tower's own volume sitting between the camera and the player
  // right now? Only ever meaningful while OUTSIDE the footprint (see this
  // function's only caller) — a third-person camera orbiting at a fixed
  // radius/elevation around the player can easily swing around to the far
  // side of the tower from a player standing just outside its wall,
  // putting the (very tall, see GLOPHICS_FLOORS' own floor-1 wallHeight)
  // upper-floor geometry directly between camera and character and
  // filling the whole view with solid wall.
  function isGlophicsVolumeOccludingView() {
    return segmentIntersectsWallBox(
      camera.position.x, camera.position.y, camera.position.z,
      local.x, local.y + PAN_TARGET_Y, local.z,
      GLOPHICS_VOLUME_BOX,
    );
  }

  // Re-evaluated every frame (unlike applyGlophicsFloorCutaway's other call
  // sites, which only fire on a discrete floor CHANGE via the stairs) —
  // walking in or out of Glophics' own footprint, OR the camera swinging
  // through its airspace while still outside (see isGlophicsVolumeOccludingView
  // above), both change what should be see-through even though
  // local.currentFloor itself hasn't changed. From outside and NOT
  // currently blocking the view, the whole building still reads as solid
  // (matching real Pokémon Center/Gym exteriors) — the cutaway is only
  // ever a "so the camera isn't blocked" trick, not a permanent X-ray.
  // Modeled as "pretend you're standing on a floor above the roof" (or, if
  // occluding, literally the ground floor, forcing every real floor AND
  // the roof to hide) rather than a separate on/off flag, so it reuses
  // applyGlophicsFloorCutaway's own ">" comparison unchanged and still
  // generalizes to future floors. lastCutawayFloor caches the last value
  // actually applied so this doesn't re-run setGroupHidden on every single
  // frame — only when the effective floor actually changes.
  let lastCutawayFloor = local.currentFloor;
  function updateGlophicsExteriorCutaway() {
    const insideFootprint = isInsideGlophicsFootprint(local.x, local.z);
    let effectiveFloor;
    if (insideFootprint) effectiveFloor = local.currentFloor;
    else if (isGlophicsVolumeOccludingView()) effectiveFloor = 0; // hides every real floor (index >= 1) and the roof
    else effectiveFloor = GLOPHICS_ROOF_INDEX;
    if (effectiveFloor === lastCutawayFloor) return;
    lastCutawayFloor = effectiveFloor;
    applyGlophicsFloorCutaway(effectiveFloor);
  }

  const AREA_LABEL_SIGN_FADE_RATE = 1.5; // per-second opacity ease — "slowly" fades the floating sign, not an instant pop
  let lastAreaLabelName = "Plains";
  function updateAreaLabels(dt) {
    const current = AREA_LABELS.find((a) => isInsideAreaFootprint(local.x, local.z, a.x, a.z, a.half));
    const ease = Math.min(1, AREA_LABEL_SIGN_FADE_RATE * dt);
    for (const a of AREA_LABELS) {
      if (!a.sign) continue; // Karirs has no floating sign to fade — nothing to do for it here
      const targetOpacity = a === current ? 0 : 1;
      a.sign.material.opacity += (targetOpacity - a.sign.material.opacity) * ease;
    }
    const currentName = current?.name ?? "Plains";
    if (currentName !== lastAreaLabelName) {
      lastAreaLabelName = currentName;
      minimapAreaLabelEl.textContent = currentName;
    }
    // Every floating shop/board sign uses the same depthTest:false
    // SpriteMaterial as the building name signs above (see buildTownSign/
    // buildKarirsBoardSign), so none of them are ever occluded by wall/floor
    // geometry the normal WebGL way — only explicit area(+floor) gating
    // (see getAreaKey's own comment) keeps them from bleeding through into
    // a building the player isn't actually standing in.
    const signAreaKey = getAreaKey(local.x, local.z);
    // Jared's stall sits inside the same Glophics footprint the cinema
    // floor sits directly above (see buildJaredShop's own "it's inside
    // Glophics, not a second walled area" comment), so it needs both the
    // area check and the floor check.
    jaredSign.visible = signAreaKey === "town" && local.currentFloor === 0;
    karirsBoard.sprite.visible = signAreaKey === "karirs";
    for (const boardId of [1, 2, 3]) {
      const sign = CHESS_BOARD_SIGNS[boardId];
      // hasHost is set by updateChessBoardSign whenever that table's own
      // chess_state changes (event-driven, matches updateKarirsBoardText's
      // own on-demand-redraw convention) — re-applied every frame here
      // alongside the area gate since the player's own position (unlike a
      // table's host state) changes constantly.
      sign.sprite.visible = !!sign.hasHost && signAreaKey === "tambayan";
    }
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

  // One summoned Glophimon rig per player who currently has one out (see
  // this game's own plan file) — keyed by owner user_id, including this
  // account's own (the server's own companion_roster/companion_tick
  // broadcasts include every summoned companion in the world, not just
  // other players'). No HP field at all, ever — companions can never be
  // "defeated," only the player's own body takes damage (see hp_update/
  // player_blackout below).
  const companionSpawns = new Map();

  const WILD_HP_BAR_CANVAS_WIDTH = 44;
  const WILD_HP_BAR_CANVAS_HEIGHT = 6;
  // Sits a bit above the species/level name label — see updateWildSpawns,
  // which positions it off that label's own (already-synced) y each frame
  // rather than duplicating character.js's own HEAD_Y/HEAD_SIZE math here.
  const WILD_HP_BAR_Y_OFFSET = 0.26;

  // A tiny two-rect canvas texture (background + colored fill), the same
  // "canvas -> CanvasTexture -> Sprite" shape character.js's own
  // createNameLabel already uses for name tags — kept local to this file
  // rather than added to character.js since only wild Glophimon ever show
  // one. Redrawn on demand (see redrawWildHpBar) rather than continuously,
  // since it only actually changes on a hit or a periodic wild_tick.
  function buildWildHpBarSprite() {
    const canvas = document.createElement("canvas");
    canvas.width = WILD_HP_BAR_CANVAS_WIDTH;
    canvas.height = WILD_HP_BAR_CANVAS_HEIGHT;
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 999;
    sprite.visible = false; // only ever shown once combat_state is "aggroed" — see updateWildSpawns
    sprite.userData.canvas = canvas;
    sprite.userData.ctx = canvas.getContext("2d");
    return sprite;
  }

  function redrawWildHpBar(spawn) {
    const ctx2d = spawn.hpBarSprite.userData.ctx;
    const w = WILD_HP_BAR_CANVAS_WIDTH;
    const h = WILD_HP_BAR_CANVAS_HEIGHT;
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.fillStyle = "#3333334d";
    ctx2d.fillRect(0, 0, w, h);
    const pct = spawn.maxHp > 0 ? Math.max(0, Math.min(1, spawn.hp / spawn.maxHp)) : 0;
    ctx2d.fillStyle = pct > 0.5 ? "#4ade80" : pct > 0.2 ? "#facc15" : "#ef4444";
    ctx2d.fillRect(0, 0, w * pct, h);
    spawn.hpBarSprite.material.map.needsUpdate = true;
  }

  // Same screen-space-constant sizing math as character.js's own
  // scaleNameLabel (kept local rather than exported/shared since this
  // sprite isn't part of a rig built by buildBlockyCharacter) — a constant
  // NUMBER OF SCREEN PIXELS regardless of distance, same as every name
  // label already is, rather than a fixed world-unit size that would
  // shrink to unreadable far away or dominate the screen up close.
  function scaleWildHpBar(sprite, anchorPos, visible) {
    sprite.visible = visible;
    if (!visible) return;
    const dx = camera.position.x - anchorPos.x;
    const dy = camera.position.y - anchorPos.y;
    const dz = camera.position.z - anchorPos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const verticalFovRad = (camera.fov * Math.PI) / 180;
    const viewportHeightPx = lastHeight || canvas.height;
    const worldUnitsPerScreenPixel = (2 * distance * Math.tan(verticalFovRad / 2)) / viewportHeightPx;
    sprite.scale.set(WILD_HP_BAR_CANVAS_WIDTH * worldUnitsPerScreenPixel, WILD_HP_BAR_CANVAS_HEIGHT * worldUnitsPerScreenPixel, 1);
  }

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

  // Builds (or, if the server later resends one we already have, just
  // returns) the render state for one server-owned wild. difficulty/label/
  // wedge color are still a purely local, per-viewer computation (relative
  // to *this* player's own starter level), same as before. hp/maxHp/
  // combatState are real, shared, server-authoritative fields now (see
  // this game's own plan file) — every player fighting this same wild sees
  // the exact same numbers.
  function ensureWildSpawn(id, speciesKey, level, x, z, facing, hp, maxHp, combatState) {
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

    // A child of rig.group (same as rig.nameLabel), not of the scene
    // directly — its local position is set once per frame below purely as
    // a Y offset off nameLabel's own local position, so it automatically
    // world-follows this rig's position/facing exactly like the name label
    // already does (a pure Y-axis local offset is unaffected by the
    // group's own Y-axis rotation).
    const hpBarSprite = buildWildHpBarSprite();
    rig.group.add(hpBarSprite);

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
      hp: hp ?? 0,
      maxHp: maxHp ?? 1,
      combatState: combatState || "normal",
      hpBarSprite,
      visionWedge: createVisionWedge(wedgeColor),
      // Non-null while a landed-swing animation (see the "wild_attack"
      // broadcast/handler below) is still playing — counts UP from 0 each
      // frame in updateWildSpawns, null the rest of the time. Without this
      // a successful attack was invisible: the wild simply stops moving
      // (see _wild_tick's own MOB_ATTACK_RANGE branch) and nothing ever
      // signals the swing itself, so combat looked like the mob just
      // stood there doing nothing even while the target's HP was really
      // dropping.
      attackAnimElapsedMs: null,
      // Non-null for effectivePoseDurationMs("flinch") right after a
      // companion hit lands (see wild_hp_update below) — drives both a
      // brief red emissive flash and the actual Flinch recoil pose, taking
      // priority over the proximity highlight AND this wild's own attack-
      // swing while active (see updateWildSpawns).
      flinchElapsedMs: null,
      // Counts up only while the player is within INTERACTION_RANGE of
      // this wild (see updateWildSpawns) — same "every clickable thing
      // nearby glows, not just whichever one's under the cursor" rule
      // createNpcHighlightUpdater already uses for every NPC. Reset to 0
      // the instant that stops being true, so the pulse always restarts
      // fresh rather than resuming mid-cycle the next time it's in range
      // again.
      highlightElapsedMs: 0,
      // Non-null from the moment this wild is killed/captured (see
      // startWildDeath) until it's actually torn down — counts up through
      // DEATH_HOLD_MS (collapsed, fully opaque) then DEATH_FADE_MS (easing
      // out) before updateWildSpawns calls the real removeWildSpawn. null
      // the rest of this wild's life, same convention as attackAnimElapsedMs/
      // flinchElapsedMs above.
      dyingElapsedMs: null,
      // {hp, maxHp, delayMs} / {delayMs} — set by wild_hp_update/
      // wild_despawn(killed) instead of applying right away, so the hit
      // only actually shows once the attacking companion's own swing
      // visually finishes (see pendingCompanionAttackDelayMs above and
      // this function's own countdown in updateWildSpawns). null the rest
      // of the time; only one of the two is ever set at once (a kill
      // replaces whatever pending non-lethal hp update preceded it, same
      // as the server's own authoritative order).
      pendingHp: null,
      pendingDeath: null,
    };
    redrawWildHpBar(spawn);
    wildSpawns.set(id, spawn);
    return spawn;
  }

  // Shared by every message that carries fresh hp/max_hp/combat_state for a
  // wild already in wildSpawns (wild_roster's initial catch-up, wild_tick's
  // periodic broadcast, and the immediate wild_hp_update push on a hit) —
  // redraws the HP bar's texture only when there's actually a bar to draw,
  // not unconditionally every call.
  function setWildCombatFields(spawn, hp, maxHp, combatState) {
    spawn.hp = hp;
    spawn.maxHp = maxHp;
    if (combatState !== undefined) spawn.combatState = combatState;
    redrawWildHpBar(spawn);
  }

  function removeWildSpawn(id) {
    const spawn = wildSpawns.get(id);
    if (!spawn) return;
    scene.remove(spawn.rig.group);
    disposeRig(spawn.rig);
    scene.remove(spawn.visionWedge);
    spawn.visionWedge.children[0].geometry.dispose();
    spawn.visionWedge.children[0].material.dispose();
    spawn.hpBarSprite.material.map.dispose();
    spawn.hpBarSprite.material.dispose();
    wildSpawns.delete(id);
  }

  // A continuous (not binary, unlike setGroupTransparent's own on/off 0.3/1)
  // fade — the only caller that needs an in-between value is a wild's own
  // death fade-out (see updateWildSpawns' own dyingElapsedMs handling).
  function setRigOpacity(rig, opacity) {
    rig.group.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        obj.material.transparent = true;
        obj.material.opacity = opacity;
        obj.material.needsUpdate = true;
      }
    });
  }

  // Kill/capture both end a wild's life the same way from this client's own
  // point of view (see this game's own plan file — _kill_wild handles both
  // server-side) — a believable collapse instead of just winking out of
  // existence. Idempotent (checks dyingElapsedMs, not just wildSpawns.has),
  // same reasoning as the old direct removeWildSpawn calls this replaces:
  // wild_capture_result's own "caught" branch and the wild_despawn broadcast
  // for that same kill can both arrive, in either order.
  function startWildDeath(id) {
    const spawn = wildSpawns.get(id);
    if (!spawn || spawn.dyingElapsedMs != null) return;
    spawn.dyingElapsedMs = 0;
    spawn.visionWedge.visible = false;
    spawn.hpBarSprite.visible = false;
    spawn.rig.nameLabel.visible = false;
    if (selectedWildId === id) {
      selectedWildId = null;
      refreshSelectedWildHud();
    }
  }

  // Eases every wild toward wherever the server last placed it (exactly
  // the peers.values() loop's own pattern) — no AI/spawn-timer simulation
  // happens here any more, that's all server-side now (see
  // games/glophimon/api's own wild_tick_loop). A wild inside my own
  // teamBattle dome is still hidden outright, so it doesn't wander through
  // that fight and disturb it (identical to how setPeerHidden already
  // treats other players near the dome) — wild combat itself has no
  // dome/instanced space any more, so there's no equivalent hide for that.
  function updateWildSpawns(dt) {
    for (const spawn of wildSpawns.values()) {
      // Dying is its own short-lived, self-contained lifecycle — no more
      // server-driven movement/combat/highlight applies once a wild is
      // dead (there's nothing left server-side to broadcast updates for;
      // see startWildDeath), so this skips every bit of the normal
      // per-frame handling below entirely rather than threading dying
      // checks through all of it.
      if (spawn.dyingElapsedMs != null) {
        spawn.dyingElapsedMs += dt * 1000;
        if (spawn.dyingElapsedMs >= DEATH_HOLD_MS + DEATH_FADE_MS) {
          removeWildSpawn(spawn.id);
          continue;
        }
        applyDeathPose(spawn.rig, spawn.dyingElapsedMs);
        const fadeElapsed = spawn.dyingElapsedMs - DEATH_HOLD_MS;
        if (fadeElapsed > 0) setRigOpacity(spawn.rig, Math.max(0, 1 - fadeElapsed / DEATH_FADE_MS));
        continue;
      }

      // A held hp update/kill (see wild_hp_update/wild_despawn's own
      // handlers) counting down to when the attacking companion's swing
      // actually finishes — checked before the normal pose/movement below
      // so a kill lands on schedule even if this wild would otherwise have
      // wandered/attacked again in the meantime. pendingDeath wins if
      // somehow both are set (shouldn't normally happen — a kill clears
      // pendingHp when it's scheduled, see wild_despawn's own handler).
      if (spawn.pendingDeath) {
        spawn.pendingDeath.delayMs -= dt * 1000;
        if (spawn.pendingDeath.delayMs <= 0) {
          spawn.pendingDeath = null;
          startWildDeath(spawn.id);
          continue;
        }
      } else if (spawn.pendingHp) {
        spawn.pendingHp.delayMs -= dt * 1000;
        if (spawn.pendingHp.delayMs <= 0) {
          const { hp, maxHp } = spawn.pendingHp;
          spawn.pendingHp = null;
          if (hp < spawn.hp) spawn.flinchElapsedMs = 0;
          setWildCombatFields(spawn, hp, maxHp);
        }
      }

      const ease = Math.min(1, 12 * dt);
      spawn.x += (spawn.targetX - spawn.x) * ease;
      spawn.z += (spawn.targetZ - spawn.z) * ease;
      spawn.facingAngle = spawn.targetFacing;

      // Flinch's own timer is advanced here, once, ahead of the skeletal
      // pose decision below — it has to win over even its OWN attack-swing
      // (getting hit mid-swing interrupts it, same priority the emissive
      // overlay further down already gives it over the proximity
      // highlight) before anything else gets a chance to read it this
      // frame.
      if (spawn.flinchElapsedMs != null) {
        spawn.flinchElapsedMs += dt * 1000;
        if (spawn.flinchElapsedMs >= effectivePoseDurationMs("flinch")) spawn.flinchElapsedMs = null;
      }

      if (spawn.flinchElapsedMs != null) {
        // A saved Pose Designer "Flinch" override (see POSE_OVERRIDE_SLOTS)
        // takes effect immediately, no redeploy needed — same poseOverrides
        // object tryPlayLocalOverride already reads for the player's own
        // Walk; falls back to the built-in recoil when nothing's saved.
        if (!tryPlayBattlePoseOverride(spawn.rig, "flinch", spawn.flinchElapsedMs, true)) applyFlinchPose(spawn.rig, spawn.flinchElapsedMs, effectivePoseDurationMs("flinch"));
      } else if (spawn.attackAnimElapsedMs != null) {
        spawn.attackAnimElapsedMs += dt * 1000;
        const totalMs = effectivePoseDurationMs("attack");
        if (spawn.attackAnimElapsedMs >= totalMs) spawn.attackAnimElapsedMs = null;
        // A saved Pose Designer "Attack" override takes effect immediately,
        // no redeploy needed; falls back to the built-in swing when
        // nothing's been saved.
        else if (!tryPlayBattlePoseOverride(spawn.rig, "attack", spawn.attackAnimElapsedMs, true)) applyAttackPose(spawn.rig, spawn.attackAnimElapsedMs, totalMs);
      } else if (spawn.isMoving) updateWalkCycle(spawn.rig, dt);
      else applyIdlePose(spawn.rig, dt);

      // Emissive overlay — independent of the skeletal pose above, so it
      // layers over walk/idle/attack/flinch alike. Flinch (just got hit)
      // wins over the proximity highlight (you could click this) whenever
      // both would otherwise apply, since "I was just hit" is the more
      // urgent of the two cues. The highlight itself is PURE proximity,
      // same rule as every NPC (see createNpcHighlightUpdater) — every wild
      // within INTERACTION_RANGE glows at once, not just whichever one the
      // mouse happens to be over.
      if (spawn.flinchElapsedMs != null) {
        const fade = 1 - spawn.flinchElapsedMs / effectivePoseDurationMs("flinch");
        setRigEmissiveIntensity(spawn.rig, FLINCH_PEAK * fade, FLINCH_COLOR);
      } else if (Math.hypot(local.x - spawn.x, local.z - spawn.z) <= INTERACTION_RANGE) {
        spawn.highlightElapsedMs += dt * 1000;
        const pulse = (Math.sin((spawn.highlightElapsedMs / 1000) * NPC_HIGHLIGHT_PULSE_HZ * Math.PI * 2) + 1) / 2;
        setRigEmissiveIntensity(spawn.rig, NPC_HIGHLIGHT_PEAK * (0.4 + 0.6 * pulse));
      } else {
        spawn.highlightElapsedMs = 0;
        setRigEmissiveIntensity(spawn.rig, 0);
      }

      // Wild Glophimon are always outdoors (floor 0 — nothing spawns
      // inside the tower), so this is always real terrain height, no
      // entityGroundY floor check needed.
      const spawnGroundY = terrainHeight(spawn.x, spawn.z);
      spawn.rig.group.position.set(spawn.x, spawnGroundY, spawn.z);
      spawn.rig.group.rotation.y = spawn.facingAngle;
      syncNameLabel(spawn.rig);
      const labelVisible = Math.hypot(local.x - spawn.x, local.z - spawn.z) <= LABEL_VISIBLE_DISTANCE;
      scaleNameLabel(spawn.rig, camera, lastHeight || canvas.height, labelVisible);

      // Only ever shown once a fight has actually started (see
      // setWildCombatFields) — a wild nobody has touched yet shouldn't show
      // an empty/full HP bar hovering over it. A pure local Y offset off
      // nameLabel's own (already-synced) local position — see hpBarSprite's
      // own comment in ensureWildSpawn for why this stays correct as the
      // rig moves/turns without any world-space math here.
      spawn.hpBarSprite.position.set(0, spawn.rig.nameLabel.position.y + WILD_HP_BAR_Y_OFFSET, 0);
      scaleWildHpBar(spawn.hpBarSprite, spawn.rig.group.position, labelVisible && spawn.combatState === "aggroed");

      spawn.visionWedge.position.set(spawn.x, spawnGroundY + 0.02, spawn.z);
      spawn.visionWedge.rotation.y = spawn.facingAngle;
      spawn.visionWedge.visible = showWildVisionRange;

      if (teamBattle) {
        const dist = Math.hypot(spawn.x - teamBattle.centerX, spawn.z - teamBattle.centerZ);
        spawn.rig.group.visible = dist > TEAM_DOME_RADIUS;
      } else {
        spawn.rig.group.visible = true;
      }
    }
  }

  // Builds (or, if already present, returns) the render state for one
  // summoned companion — same "server owns it, this is just a view" shape
  // wildSpawns/peers already use. Never has an HP bar (see companionSpawns'
  // own comment) — just a name label (species/level, matching a wild's own
  // convention) and easing toward whatever companion_tick last reported.
  function ensureCompanionSpawn(userId, speciesKey, level, x, z, facing, state) {
    const existing = companionSpawns.get(userId);
    // A re-summon (pressing E again to swap) reuses this same user_id key
    // server-side (see this game's own plan file) — if it's a genuinely
    // different Glophimon, the old rig has to actually be torn down and
    // rebuilt rather than silently kept as the previous species forever.
    if (existing && existing.speciesKey === speciesKey) return existing;
    if (existing) removeCompanionSpawn(userId);
    const species = SPECIES_BY_KEY[speciesKey];
    if (!species) return null; // shouldn't happen — defensive only
    const rig = buildBlockyCharacter(
      { head: species.head_color, body: species.body_color, arm: species.arm_color, leg: species.leg_color },
      `${species.name} Lv.${level}`,
      WILD_LABEL_COLOR_EASY,
    );
    rig.group.scale.setScalar(CREATURE_SCALE);
    rig.group.position.set(x, 0, z);
    rig.group.rotation.y = facing;
    scene.add(rig.group);
    const spawn = {
      userId,
      speciesKey,
      rig,
      x,
      z,
      facingAngle: facing,
      targetX: x,
      targetZ: z,
      targetFacing: facing,
      isMoving: false,
      state: state || "idle_follow",
      // Non-null while this companion's own landed-swing animation (see
      // the "companion_attack_landed" broadcast/handler below) is still
      // playing — same shape as a wild's own attackAnimElapsedMs, just
      // nothing ever flinches it back (companions have no HP to lose, see
      // this game's own plan file).
      attackAnimElapsedMs: null,
    };
    companionSpawns.set(userId, spawn);
    return spawn;
  }

  function removeCompanionSpawn(userId) {
    const spawn = companionSpawns.get(userId);
    if (!spawn) return;
    scene.remove(spawn.rig.group);
    disposeRig(spawn.rig);
    companionSpawns.delete(userId);
  }

  // Same per-frame easing shape updateWildSpawns/the peers loop already
  // use. Companion floor isn't tracked server-side at all (see
  // companion_tick's own field list) — always rendered at real terrain
  // height, same "always outdoors" simplification wild Glophimon
  // themselves already make.
  function updateCompanionSpawns(dt) {
    for (const spawn of companionSpawns.values()) {
      const ease = Math.min(1, 12 * dt);
      spawn.x += (spawn.targetX - spawn.x) * ease;
      spawn.z += (spawn.targetZ - spawn.z) * ease;
      spawn.facingAngle = spawn.targetFacing;
      if (spawn.attackAnimElapsedMs != null) {
        spawn.attackAnimElapsedMs += dt * 1000;
        const totalMs = effectivePoseDurationMs("attack");
        if (spawn.attackAnimElapsedMs >= totalMs) spawn.attackAnimElapsedMs = null;
        else if (!tryPlayBattlePoseOverride(spawn.rig, "attack", spawn.attackAnimElapsedMs, true)) applyAttackPose(spawn.rig, spawn.attackAnimElapsedMs, totalMs);
      } else if (spawn.isMoving) updateWalkCycle(spawn.rig, dt);
      else applyIdlePose(spawn.rig, dt);
      const spawnGroundY = terrainHeight(spawn.x, spawn.z);
      spawn.rig.group.position.set(spawn.x, spawnGroundY, spawn.z);
      spawn.rig.group.rotation.y = spawn.facingAngle;
      syncNameLabel(spawn.rig);
      scaleNameLabel(spawn.rig, camera, lastHeight || canvas.height, Math.hypot(local.x - spawn.x, local.z - spawn.z) <= LABEL_VISIBLE_DISTANCE);
    }
  }

  // Stairs — same per-frame proximity idiom wild contact used to use (a
  // plain distance check against fixed coordinates, not a click/raycast),
  // just driving a floor change instead of a battle. Iterates
  // GLOPHICS_STAIR_TRANSITIONS so a future floor 3 needs no new code here
  // at all — only another entry in GLOPHICS_FLOORS.
  let stairsCooldownUntil = 0;

  // Shared by both directions checkStairsContact can trigger — sets the
  // floor/y, re-applies the cutaway, nudges the player off the tile (see
  // STAIRS_STEP_AWAY) so they don't instantly re-trigger it, and starts a
  // short cooldown as a second safety net against flicker/re-trigger.
  function goToGlophicsFloor(floorIndex, y, nudgedZ) {
    local.currentFloor = floorIndex;
    local.y = y;
    local.z = nudgedZ;
    applyGlophicsFloorCutaway(floorIndex);
    stairsCooldownUntil = performance.now() + STAIRS_COOLDOWN_MS;
  }

  function checkStairsContact() {
    if (battle || teamBattle || pvpBattle) return;
    if (performance.now() < stairsCooldownUntil) return;
    for (const t of GLOPHICS_STAIR_TRANSITIONS) {
      if (local.currentFloor === t.belowFloor) {
        if (Math.hypot(local.x - t.x, local.z - t.z) <= STAIRS_CONTACT_RADIUS) {
          goToGlophicsFloor(t.aboveFloor, t.aboveY, t.z - STAIRS_STEP_AWAY);
          return;
        }
      } else if (local.currentFloor === t.aboveFloor) {
        if (Math.hypot(local.x - t.x, local.z - t.z) <= STAIRS_CONTACT_RADIUS) {
          goToGlophicsFloor(t.belowFloor, t.belowY, t.z - STAIRS_STEP_AWAY);
          return;
        }
      }
    }
  }

  // Wild combat has no instanced battle screen any more (see this game's
  // own plan file) — `battle` stays permanently null, kept only because
  // teamBattle/pvpBattle's own mutual-exclusion guards ("if (battle ||
  // teamBattle || pvpBattle)") already check it throughout this file, and
  // leaving it declared-but-unused there is simpler and lower-risk than
  // hunting down and rewriting every one of those compound conditions.
  let battle = null;

  function setBattleButtonsDisabled(disabled) {
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
  // Own free-running clock for the gait's tremble/breath sine terms (see
  // updateKarirsTrackVisual) — matches render3d.js's own local `crowdTime`
  // accumulator rather than feeding Date.now()/performance.now() directly
  // into Math.sin (those are fine numerically, this just mirrors the
  // source exactly and starts at a sane 0 instead of a huge epoch value).
  let karirsGaitTime = 0;

  // Practice races — a fully LOCAL, client-only sandbox (see
  // simulateKarirsPracticeRace/onKarraPracticeClick below): nothing here is
  // ever sent to the server or broadcast, so this never touches the real
  // karirsRace/betting state, and only the requesting player's own client
  // ever sees it (every other nearby player keeps rendering the real
  // shared race, exactly as before). null when no practice is active or
  // counting down; otherwise { phase: "countdown", countdownEndsAt,
  // racerNames } while waiting to start, or { phase: "racing", race,
  // revertAt } once it has (revertAt is null until the practice race
  // actually finishes, then sets when to switch back to showing the real
  // race — see updateKarirsPracticeState).
  let karirsPracticeState = null;

  // Advances karirsPracticeState's own little state machine — countdown ->
  // racing -> (once finished) held for KARIRS_PRACTICE_RESULT_HOLD_MS ->
  // back to null (reverting the track to whatever the real karirsRace is
  // doing). Called once per frame; each transition only actually does
  // anything the one frame it crosses its own deadline.
  function updateKarirsPracticeState() {
    if (!karirsPracticeState) return;
    const now = Date.now();
    if (karirsPracticeState.phase === "countdown") {
      if (now < karirsPracticeState.countdownEndsAt) return;
      const { steps, winner } = simulateKarirsPracticeRace(karirsPracticeState.racerNames);
      karirsPracticeState = {
        phase: "racing",
        race: {
          racer_names: karirsPracticeState.racerNames,
          steps,
          winning_name: winner,
          status: "racing",
          // Matches the "${race.started_at}Z" parsing convention every
          // real race's own started_at already relies on (a naive UTC
          // string with no timezone suffix of its own) — toISOString()
          // already ends in "Z", so that has to come off first or the
          // parse would see a bogus trailing "ZZ".
          started_at: new Date().toISOString().replace(/Z$/, ""),
        },
        revertAt: null,
      };
      return;
    }
    // phase === "racing"
    const finished = now - new Date(`${karirsPracticeState.race.started_at}Z`).getTime() >= karirsPracticeState.race.steps.length * KARIRS_STEP_DELAY_MS;
    if (finished && karirsPracticeState.revertAt === null) {
      karirsPracticeState.revertAt = now + KARIRS_PRACTICE_RESULT_HOLD_MS;
    }
    if (karirsPracticeState.revertAt !== null && now >= karirsPracticeState.revertAt) {
      karirsPracticeState = null;
      refreshKarraMenu(); // re-enables the practice button if Karra's menu happens to still be open
    }
  }

  // Drives the racetrack's own live rendering (see buildKarirsTrack/
  // buildKarirsRacerRig) — a *second* view of the exact same karirsRace/
  // steps data renderKarirsTvContent already replays against started_at,
  // not a separate simulation, with the gait itself ported from
  // games/karirs/client/src/render3d.js's own update() (see
  // buildKarirsRacerRig's own comment for what was intentionally left out).
  // Called once per frame regardless of where the local player is standing
  // (cheap: 4 small rigs) — same "always-on ambient world state, let
  // frustum culling handle whether it's actually on screen" approach the
  // wild Glophimon roster and every NPC already use, so anyone who simply
  // walks near the track sees the race in progress without needing to have
  // opened the TV at all.
  //
  // race is whichever of karirsPracticeState's own local race and the real
  // karirsRace should currently be shown — practice, being purely local,
  // completely overrides the real one on THIS client's own screen for its
  // duration (see karirsPracticeState's own comment: nobody else's client
  // is affected, they keep rendering the real race the whole time).
  function updateKarirsTrackVisual(dt) {
    updateKarirsPracticeState();
    const race =
      karirsPracticeState?.phase === "racing"
        ? karirsPracticeState.race
        : karirsPracticeState?.phase === "countdown"
          ? { racer_names: karirsPracticeState.racerNames, steps: null, status: "betting_open" }
          : karirsRace;
    karirsGaitTime += dt;
    const isResolved = race?.status === "resolved";
    let startedAt = null;
    if (race && race.status !== "betting_open" && race.steps && race.steps.length > 0) {
      startedAt = new Date(`${race.started_at}Z`).getTime();
    }
    for (let i = 0; i < karirsRacerMarkers.length; i++) {
      const marker = karirsRacerMarkers[i];
      const name = race?.racer_names?.[i];
      marker.group.visible = !!name;
      if (!name) continue;
      if (marker.currentName !== name) {
        marker.currentName = name;
        updateKarirsRacerLabel(marker, name);
        marker.prevPos = NaN; // a different racer now owns this lane — don't derive a speed off the previous one's last position
        marker.gaitPhase = i; // reseeded, not 0 — see buildRacerRig's own gaitSeed comment, so a fresh field of racers doesn't all step in unison
      }

      // Same interpolated-between-steps position games/karirs' own
      // currentStepInfo() computes (see that function's own comment) — a
      // raw stepped value only actually changes every KARIRS_STEP_DELAY_MS
      // (300ms); without smoothing it, the gait's own finite-difference
      // speed below would read as "stopped" almost every frame and
      // "sprinting" for one frame every 300ms, instead of a continuous
      // cadence.
      let pos = 0;
      if (startedAt !== null) {
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        const raw = elapsedMs / KARIRS_STEP_DELAY_MS;
        const idx = Math.floor(raw);
        if (idx >= race.steps.length) {
          pos = race.steps[race.steps.length - 1].positions[name] ?? 0;
        } else {
          const frac = raw - idx;
          const prevPositions = idx === 0 ? null : race.steps[idx - 1].positions;
          const prevVal = prevPositions ? prevPositions[name] ?? 0 : 0;
          const curVal = race.steps[idx].positions[name] ?? 0;
          pos = prevVal + (curVal - prevVal) * frac;
        }
      }
      pos = Math.max(0, Math.min(100, pos));

      // --- Gait, ported from render3d.js's own update() — see that
      // file's own comments for the reasoning behind each term; only the
      // "shouting"/ninja-pose blend is omitted (see buildKarirsRacerRig's
      // own comment on why there's no data here to drive it).
      const speed = isResolved || Number.isNaN(marker.prevPos) ? 0 : Math.max(0, (pos - marker.prevPos) / dt);
      marker.prevPos = pos;
      const isMoving = speed > KARIRS_GAIT_STOP_SPEED_THRESHOLD;
      const speedRatio = Math.min(1, speed / KARIRS_GAIT_SPRINT_SPEED);
      const isExhausted = isMoving && speed < KARIRS_GAIT_EXHAUSTED_SPEED_THRESHOLD;

      const easeStep = Math.min(1, dt * KARIRS_GAIT_POSE_EASE_RATE);
      marker.exhaustedBlend += ((isExhausted ? 1 : 0) - marker.exhaustedBlend) * easeStep;
      const eb = marker.exhaustedBlend;

      if (isMoving) {
        const frequency =
          (KARIRS_GAIT_WALK_FREQUENCY + (KARIRS_GAIT_SPRINT_FREQUENCY - KARIRS_GAIT_WALK_FREQUENCY) * speedRatio) * (1 - 0.5 * eb);
        marker.gaitPhase += dt * frequency;
      }
      const strideScale = (isMoving ? Math.max(0.35, speedRatio) : 0) * (1 - 0.5 * eb);
      const gait = Math.sin(marker.gaitPhase) * KARIRS_GAIT_SPRINT_STRIDE * strideScale;
      marker.leftLeg.rotation.x = gait;
      marker.rightLeg.rotation.x = -gait;

      const exhaustedArmL = KARIRS_GAIT_EXHAUSTED_ARM_FORWARD + Math.sin(karirsGaitTime * 9) * KARIRS_GAIT_EXHAUSTED_TREMBLE;
      const exhaustedArmR = KARIRS_GAIT_EXHAUSTED_ARM_FORWARD + Math.sin(karirsGaitTime * 9 + 1) * KARIRS_GAIT_EXHAUSTED_TREMBLE;
      marker.leftArm.rotation.x = -gait + (exhaustedArmL - -gait) * eb;
      marker.rightArm.rotation.x = gait + (exhaustedArmR - gait) * eb;

      marker.torso.rotation.x = KARIRS_GAIT_EXHAUSTED_LEAN * eb;
      marker.head.rotation.x = KARIRS_GAIT_EXHAUSTED_HEAD_DROOP * eb;
      marker.torso.scale.y = 1 + Math.sin(karirsGaitTime * KARIRS_GAIT_EXHAUSTED_BREATH_FREQUENCY) * KARIRS_GAIT_EXHAUSTED_BREATH_AMPLITUDE * eb;

      const bodyBounce = Math.abs(Math.sin(marker.gaitPhase)) * KARIRS_GAIT_SPRINT_BOUNCE * strideScale;
      marker.z = KARIRS_TRACK_START_Z + (KARIRS_TRACK_FINISH_Z - KARIRS_TRACK_START_Z) * (pos / 100);
      marker.group.position.set(KARIRS_FIELD_X + KARIRS_TRACK_LANE_OFFSETS[i], bodyBounce, marker.z);
      // Same phase as the body bounce above (peaks on every footfall), on
      // top of it rather than instead of it — head.position.y is in the
      // torso's own local space (see buildKarirsRacerRig), so this adds a
      // little extra bob beyond what the whole body already gets from
      // group.position.y just above.
      marker.head.position.y = marker.headBaseY + Math.abs(Math.sin(marker.gaitPhase)) * KARIRS_GAIT_HEAD_BOB * strideScale;

      // Same LABEL_VISIBLE_DISTANCE fade every other NPC's own name label
      // already uses — the runner's body still renders at any distance
      // (matching how NPCs/wild Glophimon themselves are never distance-
      // culled), only the floating name sprite is gated.
      marker.label.visible = Math.hypot(local.x - marker.group.position.x, local.z - marker.z) <= LABEL_VISIBLE_DISTANCE;
    }
  }
  let statsModalGlophimon = null; // the owned-Glophimon row the stats modal is currently showing, if any
  let releasingId = null; // owned-Glophimon id currently showing "Confirm Release?" in place of its normal row actions
  let actionsForId = null; // owned-Glophimon id currently showing its expanded action list (see makeGlophimonRow)
  let localUserId = null; // this account's own user_id — learned once from the server's own "self" message, needed to tell "me" apart from other Luba lobby members
  let bossRickStep = "closed"; // "closed" | "choose_mode" | "mode_confirm" | "duration_select" — see renderBossRickMenu
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

  // Dama Phase 2 — mirrors chessBoards/etc.'s own shape exactly, kept as
  // fully separate state (see the DOM block above's own comment on why).
  const damaBoards = { 1: { status: "empty" }, 2: { status: "empty" }, 3: { status: "empty" } };
  let boardHostChoiceTargetBoardId = null; // which empty table's Chess/Dama picker is open, or null (never board 3)
  let damaJoinTargetBoardId = null;
  let myHostedDamaBoardId = null;
  let activeDamaMatch = null; // {boardId, isSpectator, selectedSquare, midChain} while the match/spectate modal is open, else null


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
      // Same "saved Starting Angle takes effect immediately" reasoning as
      // the wild battle's own camAngle init above — see cameraOverrides.team.
      camAngle: cameraOverrides.team?.angle ?? (local.facingAngle + BATTLE_CAM_ANGLE_OFFSET),
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
    // Wild combat has no spectator-hide concept any more (see this game's
    // own plan file) — an unconditional unhide is correct again now that
    // that's the only other thing that used to also hide a peer's avatar.
    for (const [, peer] of peers.entries()) setPeerHidden(peer, false);
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
  // Eases toward local.y exactly like followX/followZ ease toward
  // local.x/z below — see the overworld camera branch in frame() for how
  // this gets added on top of PAN_TARGET_Y (which stays a fixed "look
  // slightly above the ground" fine-tune, unchanged). Starts at local.y
  // (not always 0 — see initialFloor above, a reconnecting client can
  // mount already on an upper floor) so there's no visible snap on the
  // very first frame.
  let followY = local.y;
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
    bossRickStep = "choose_mode";
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

    if (bossRickStep === "choose_mode") {
      addLabel("What'll it be?");
      addBtn("Host a Luba deathmatch", () => {
        bossRickStep = "mode_confirm";
        renderBossRickMenu();
      });
      // Practice mode is a fully local sandbox (see game.js's own
      // mountPractice — no lobby, no WebSocket, just the dummy), so this
      // skips the host/mode/duration flow entirely and hands off to it
      // directly, the same "hide Glophimon, mount Luba" handoff
      // onLubaMatchReady already does for a real match (see
      // ctx.onLubaPracticeRequested's own call site in chat.js).
      addBtn("Practice Mode", () => {
        hideBossRickMenu();
        ctx.onLubaPracticeRequested?.();
      });
      addBtn("Cancel", () => hideBossRickMenu());
    } else if (bossRickStep === "mode_confirm") {
      addLabel("Mode: Deathmatch");
      addBtn("Confirm", () => {
        bossRickStep = "duration_select";
        renderBossRickMenu();
      });
      addBtn("Back", () => {
        bossRickStep = "choose_mode";
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

  // The Usher — floor 2 cinema's own greeter (see USHER_NAME's own
  // comment). Same shell/hide convention as every NPC popup above; its
  // body is entirely re-derived from the shared cinemaProjectionist value
  // on every render, the same "state-driven, not step-driven" shape
  // renderPlayerOptionsMenu already uses, since there's no local multi-step
  // flow here at all — just three mutually exclusive states (vacant / held
  // by someone else / held by me).
  function hideUsherMenu() {
    usherMenuEl.style.display = "none";
  }

  function showUsherMenu(clientX, clientY) {
    const wrapRect = wrap.getBoundingClientRect();
    usherMenuEl.style.left = `${clientX - wrapRect.left}px`;
    usherMenuEl.style.top = `${clientY - wrapRect.top}px`;
    usherMenuEl.style.display = "block";
    renderUsherMenu();
  }

  // Same shape as showLubaError/showPvpError above, just anchored to the
  // Usher's own popup — surfaces a cinema_error response (already_taken/
  // invalid_url/not_in_cinema/not_projectionist) right where the player
  // just clicked a button, rather than silently failing.
  function showUsherError(reason) {
    const p = document.createElement("p");
    p.style.fontSize = "10px";
    p.style.color = "#ef4444";
    p.style.margin = "4px 0 0 0";
    p.textContent = `Error: ${reason}`;
    if (usherMenuEl.style.display !== "none") usherMenuBodyEl.appendChild(p);
    else console.warn("[cinema]", reason);
  }

  function renderUsherMenu() {
    usherMenuBodyEl.innerHTML = "";

    function addBtn(label, onClick) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.fontSize = "11px";
      btn.style.display = "block";
      btn.style.width = "100%";
      btn.style.margin = "2px 0";
      btn.addEventListener("click", onClick);
      usherMenuBodyEl.appendChild(btn);
    }
    function addLabel(text) {
      const p = document.createElement("p");
      p.style.margin = "0 0 4px 0";
      p.textContent = text;
      usherMenuBodyEl.appendChild(p);
    }

    if (cinemaProjectionist && cinemaProjectionist.user_id === localUserId) {
      // I hold the role myself — the only place in this whole game a
      // player can actually change the cinema's screen content, gated
      // entirely by actually holding it (the server re-checks this too,
      // see main.py's own cinema_set_url handler — this button being
      // visible at all is just this client's own reflection of that, not
      // what actually authorizes the change).
      addLabel("You're our projectionist! What should we play?");
      const urlInput = document.createElement("input");
      urlInput.type = "text";
      urlInput.placeholder = "https://...";
      urlInput.style.width = "100%";
      urlInput.style.marginBottom = "4px";
      usherMenuBodyEl.appendChild(urlInput);
      addBtn("Change what's playing", () => {
        // Basic client-side sanity check only — non-empty, looks like it
        // starts with http. The server does the real validation (scheme +
        // length, see _is_valid_cinema_url) and answers with cinema_error
        // if this slips something bad past this check anyway.
        const url = urlInput.value.trim();
        if (!url || !url.startsWith("http")) {
          showUsherError("invalid_url");
          return;
        }
        socket.sendCinemaSetUrl(url);
      });
    } else if (cinemaProjectionist) {
      // Someone else already holds it — no claim button, nothing to do
      // here but let them know who's currently running the show.
      addLabel(`Sorry, ${cinemaProjectionist.display_name} is already our projectionist.`);
    } else {
      // Vacant — anyone standing in the cinema (server re-checks this,
      // see main.py's own cinema_claim_projectionist handler) can claim it.
      addLabel("We're hiring! Want to be our projectionist?");
      addBtn("I'll do it!", () => socket.sendCinemaClaimProjectionist());
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

  function showDamaError(reason) {
    const p = document.createElement("p");
    p.style.fontSize = "10px";
    p.style.color = "#ef4444";
    p.style.margin = "4px 0 0 0";
    p.textContent = `Error: ${reason}`;
    if (boardHostChoiceMenuEl.style.display !== "none") boardHostChoiceBodyEl.appendChild(p);
    else if (damaJoinMenuEl.style.display !== "none") damaJoinMenuBodyEl.appendChild(p);
    else console.warn("[dama]", reason);
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
    const sign = CHESS_BOARD_SIGNS[boardId];
    // sign.sprite.visible itself is re-applied every frame in
    // updateAreaLabels (ANDed with the Tambayan area gate) — this only
    // records whether there's actually a host to show at all.
    sign.hasHost = board.status !== "empty";
    if (!sign.hasHost) return;
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

  // Only ever shown for board 3 (the AI table) — boards 1/2 route their own
  // empty-table click through onSharedBoardClick/boardHostChoiceMenuEl
  // instead (see that function's own comment). Dual-purpose as of Dama
  // Phase 3: an empty AI table now offers a choice of opponent, same shape
  // as boardHostChoiceMenuEl's own Chess/Dama choice for tables 1/2, just
  // against an AI instead of a human either way.
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
    p.textContent = "Battle the AI — pick a game:";
    chessHostMenuBodyEl.appendChild(p);
    addBtn(`Chess (${STOCKFISH_NAME})`, () => {
      socket.sendChessAiStart(chessHostTargetBoardId);
      hideChessHostMenu();
    });
    addBtn(`Dama (${DAMA_AI_NAME})`, () => {
      socket.sendDamaAiStart(chessHostTargetBoardId);
      hideChessHostMenu();
    });
    addBtn("Cancel", () => hideChessHostMenu());
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
        // Last-move highlight (a tint, so it never fights the selection
        // ring below) drawn first so the ring can still show through on
        // top of it if a square happens to be both.
        const isLastMove = board.lastMove && (square === board.lastMove.from || square === board.lastMove.to);
        sq.style.background = isLastMove ? TAMBAYAN_LAST_MOVE_TINT : (light ? TAMBAYAN_BOARD_LIGHT : TAMBAYAN_BOARD_DARK);
        // Same technique as the real standalone Cheddar Chess client (see
        // games/chess/client/src/game.js's own render()): a selection ring
        // instead of a solid fill, so the square's own theme color stays
        // visible underneath.
        sq.style.boxShadow = activeChessMatch.selectedSquare === square ? "inset 0 0 0 2px orange" : "none";
        if (pieceChar) {
          sq.textContent = CHESS_UNICODE[pieceChar] || "";
          // Also lifted from games/chess/client/src/game.js: the Unicode
          // chess glyphs (♔ vs ♚) are a single ink color with no fill/
          // outline of their own, so plain text color barely contrasted
          // against the square — and a stroke (tried first here too) ate
          // into the thinner glyphs (the pawn especially), making a WHITE
          // piece's mostly-hollow outline read as visually darker/heavier
          // than its own black-filled counterpart. This is what was making
          // White and Black pieces hard to tell apart at a glance. A
          // 4-direction pixel-offset text-shadow halo fixes it without
          // touching the glyph's own antialiasing.
          const isWhitePiece = pieceChar === pieceChar.toUpperCase();
          if (isWhitePiece) {
            sq.style.color = "#f5f5f5";
            sq.style.textShadow = "1px 0 0 #151515, -1px 0 0 #151515, 0 1px 0 #151515, 0 -1px 0 #151515";
          } else {
            sq.style.color = "#151515";
            sq.style.textShadow = "1px 0 0 #e8e8e8, -1px 0 0 #e8e8e8, 0 1px 0 #e8e8e8, 0 -1px 0 #e8e8e8";
          }
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
        draw_agreed: "Draw by agreement", resignation: "Resignation",
        disconnect: "Opponent disconnected",
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
      turnEl.textContent = board.turn === myColor
        ? "Your move."
        : activeChessMatch.boardId === AI_BOARD_ID ? `${STOCKFISH_NAME} is thinking…` : "Waiting for opponent…";
      chessMatchBodyEl.appendChild(turnEl);
    }

    if (!activeChessMatch.isSpectator && !board.outcome) {
      // Offer Draw / Request Undo — human-vs-human boards only (never
      // offered against the AI table at all, see AI_BOARD_ID); at most one
      // of a draw offer or undo request is ever pending at a time (see the
      // api's own chess_draw_offer/chess_undo_request).
      if (board.undoRequestedBy != null) {
        const p = document.createElement("p");
        p.style.fontSize = "11px";
        p.style.margin = "0 0 4px 0";
        p.textContent = board.undoRequestedBy === localUserId
          ? "Undo request sent — waiting for response…"
          : "Opponent requests to undo their last move.";
        chessMatchBodyEl.appendChild(p);
        if (board.undoRequestedBy !== localUserId) {
          addRespondButtons(chessMatchBodyEl, (accept) => socket.sendChessUndoRespond(activeChessMatch.boardId, accept));
        }
      } else if (board.drawOfferedBy != null) {
        const p = document.createElement("p");
        p.style.fontSize = "11px";
        p.style.margin = "0 0 4px 0";
        p.textContent = board.drawOfferedBy === localUserId
          ? "Draw offer sent — waiting for response…"
          : "Opponent offers a draw.";
        chessMatchBodyEl.appendChild(p);
        if (board.drawOfferedBy !== localUserId) {
          addRespondButtons(chessMatchBodyEl, (accept) => socket.sendChessDrawRespond(activeChessMatch.boardId, accept));
        }
      } else if (activeChessMatch.boardId !== AI_BOARD_ID) {
        const drawBtn = document.createElement("button");
        drawBtn.textContent = "Offer Draw";
        drawBtn.style.fontSize = "11px";
        drawBtn.style.marginRight = "4px";
        drawBtn.addEventListener("click", () => socket.sendChessDrawOffer(activeChessMatch.boardId));
        chessMatchBodyEl.appendChild(drawBtn);

        if (board.turn !== myColor && board.moveHistory && board.moveHistory.length > 0) {
          const undoBtn = document.createElement("button");
          undoBtn.textContent = "Request Undo";
          undoBtn.style.fontSize = "11px";
          undoBtn.style.marginRight = "4px";
          undoBtn.addEventListener("click", () => socket.sendChessUndoRequest(activeChessMatch.boardId));
          chessMatchBodyEl.appendChild(undoBtn);
        }
      }

      const resignBtn = document.createElement("button");
      resignBtn.textContent = "Resign";
      resignBtn.style.fontSize = "11px";
      resignBtn.addEventListener("click", () => socket.sendChessResign(activeChessMatch.boardId));
      chessMatchBodyEl.appendChild(resignBtn);
    }
  }

  // Shared Accept/Decline pair for an incoming draw offer or undo request —
  // used by both Chess's and Dama's own match modals.
  function addRespondButtons(container, onRespond) {
    const acceptBtn = document.createElement("button");
    acceptBtn.textContent = "Accept";
    acceptBtn.style.fontSize = "11px";
    acceptBtn.style.marginRight = "4px";
    acceptBtn.addEventListener("click", () => onRespond(true));
    container.appendChild(acceptBtn);
    const declineBtn = document.createElement("button");
    declineBtn.textContent = "Decline";
    declineBtn.style.fontSize = "11px";
    declineBtn.addEventListener("click", () => onRespond(false));
    container.appendChild(declineBtn);
  }

  // === Dama Phase 2 — networked, sharing tables 1/2 with Chess =============

  // Same physical sign sprite CHESS_BOARD_SIGNS already maps board 1/2/3
  // to — one prop per table regardless of which game is currently hosted
  // there, so this reuses that same lookup rather than a separate one.
  function updateDamaBoardSign(boardId, board) {
    const sign = CHESS_BOARD_SIGNS[boardId];
    sign.hasHost = board.status !== "empty";
    if (!sign.hasHost) return;
    if (board.status === "waiting") {
      updateKarirsBoardText(sign, `Hosted by ${board.hostDisplayName} — waiting for opponent (Dama)`);
    } else {
      updateKarirsBoardText(sign, `${board.whiteDisplayName} vs ${board.blackDisplayName} — Dama In Progress`);
    }
  }

  // The dispatcher for tables 1/2 (board 3, the Stockfish table, keeps
  // using onChessBoardClick directly — always chess, never offered a
  // choice). Which game (if either) currently owns this physical table is
  // never ambiguous: the api's own _physical_board_free guarantees at most
  // one of chessBoards[id]/damaBoards[id] is ever non-"empty" at a time.
  function onSharedBoardClick(boardId, clientX, clientY) {
    if (chessBoards[boardId].status !== "empty") {
      onChessBoardClick(boardId, clientX, clientY);
      return;
    }
    if (damaBoards[boardId].status !== "empty") {
      onDamaBoardClick(boardId, clientX, clientY);
      return;
    }
    showBoardHostChoiceMenu(boardId, clientX, clientY);
  }

  // The dispatcher for board 3 specifically (the standing AI table) — same
  // "check chess, then dama, then offer a fresh choice" shape as
  // onSharedBoardClick above, just landing on chessHostMenuEl's own
  // Chess/Dama-vs-AI choice (see renderChessHostMenu) instead of
  // boardHostChoiceMenuEl's host-vs-human one when the table is empty.
  function onAiBoardClick(boardId, clientX, clientY) {
    if (chessBoards[boardId].status !== "empty") {
      onChessBoardClick(boardId, clientX, clientY);
      return;
    }
    if (damaBoards[boardId].status !== "empty") {
      onDamaBoardClick(boardId, clientX, clientY);
      return;
    }
    showChessHostMenu(boardId, clientX, clientY);
  }

  function hideBoardHostChoiceMenu() {
    boardHostChoiceMenuEl.style.display = "none";
    boardHostChoiceTargetBoardId = null;
  }

  function showBoardHostChoiceMenu(boardId, clientX, clientY) {
    boardHostChoiceTargetBoardId = boardId;
    const wrapRect = wrap.getBoundingClientRect();
    boardHostChoiceMenuEl.style.left = `${clientX - wrapRect.left}px`;
    boardHostChoiceMenuEl.style.top = `${clientY - wrapRect.top}px`;
    boardHostChoiceMenuEl.style.display = "block";
    renderBoardHostChoiceMenu();
  }

  function renderBoardHostChoiceMenu() {
    if (boardHostChoiceTargetBoardId == null) return;
    boardHostChoiceBodyEl.innerHTML = "";
    function addBtn(label, onClick) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.fontSize = "11px";
      btn.style.display = "block";
      btn.style.width = "100%";
      btn.style.margin = "2px 0";
      btn.addEventListener("click", onClick);
      boardHostChoiceBodyEl.appendChild(btn);
    }
    addBtn("Host Chess", () => {
      socket.sendChessHostRequest(boardHostChoiceTargetBoardId);
      hideBoardHostChoiceMenu();
    });
    addBtn("Host Dama", () => {
      socket.sendDamaHostRequest(boardHostChoiceTargetBoardId);
      hideBoardHostChoiceMenu();
    });
    addBtn("Cancel", () => hideBoardHostChoiceMenu());
  }

  function onDamaBoardClick(boardId, clientX, clientY) {
    const board = damaBoards[boardId];
    if (board.status === "waiting") {
      if (board.hostId === localUserId) {
        showDamaWaitingModal(boardId);
      } else {
        showDamaJoinMenu(boardId, clientX, clientY);
      }
    } else if (board.status === "in_progress") {
      const isPlayer = board.whiteUserId === localUserId || board.blackUserId === localUserId;
      showDamaMatchModal(boardId, !isPlayer);
    }
  }

  function hideDamaJoinMenu() {
    damaJoinMenuEl.style.display = "none";
    damaJoinTargetBoardId = null;
  }

  function showDamaJoinMenu(boardId, clientX, clientY) {
    damaJoinTargetBoardId = boardId;
    const wrapRect = wrap.getBoundingClientRect();
    damaJoinMenuEl.style.left = `${clientX - wrapRect.left}px`;
    damaJoinMenuEl.style.top = `${clientY - wrapRect.top}px`;
    damaJoinMenuEl.style.display = "block";
    renderDamaJoinMenu();
  }

  function renderDamaJoinMenu() {
    if (damaJoinTargetBoardId == null) return;
    damaJoinMenuBodyEl.innerHTML = "";
    function addBtn(label, onClick) {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.fontSize = "11px";
      btn.style.display = "block";
      btn.style.width = "100%";
      btn.style.margin = "2px 0";
      btn.addEventListener("click", onClick);
      damaJoinMenuBodyEl.appendChild(btn);
    }
    const board = damaBoards[damaJoinTargetBoardId];
    const p = document.createElement("p");
    p.style.margin = "0 0 4px 0";
    p.textContent = `Play Dama with ${board.hostDisplayName}?`;
    damaJoinMenuBodyEl.appendChild(p);
    addBtn("Yes", () => socket.sendDamaJoinRequest(damaJoinTargetBoardId));
    addBtn("No", () => hideDamaJoinMenu());
  }

  function showDamaWaitingModal(boardId) {
    myHostedDamaBoardId = boardId;
    damaWaitingModalEl.style.display = "flex";
    renderDamaWaitingModal();
  }

  function hideDamaWaitingModal() {
    damaWaitingModalEl.style.display = "none";
  }

  function renderDamaWaitingModal() {
    if (myHostedDamaBoardId == null) return;
    damaWaitingBodyEl.innerHTML = "";
    const p = document.createElement("p");
    p.style.margin = "0";
    p.style.fontSize = "12px";
    p.textContent = "Waiting for a player to join…";
    damaWaitingBodyEl.appendChild(p);
  }

  function showDamaMatchModal(boardId, isSpectator) {
    hideBoardHostChoiceMenu();
    hideDamaJoinMenu();
    // lastTurnSnapshot/turnStartSquare exist purely for the undo flow (see
    // onDamaMatchSquareClick) and the last-move highlight — set fresh at
    // the start of each of MY OWN turns, null otherwise/for a spectator.
    activeDamaMatch = { boardId, isSpectator, selectedSquare: null, midChain: false, lastTurnSnapshot: null, turnStartSquare: null };
    damaMatchModalEl.style.display = "flex";
    renderDamaMatchModal();
  }

  function hideDamaMatchModal() {
    damaMatchModalEl.style.display = "none";
    activeDamaMatch = null;
  }

  // The acting player's own click always runs the real dama.js engine
  // locally first (same rules already proven in Phase 1's self-play test)
  // — mandatory capture, chain captures, promotion, flying kings all just
  // work here for free. The resulting board is applied optimistically
  // right away (not just on the server's own echo, unlike Chess) because a
  // mid-chain capture needs the player to see the intermediate jump and
  // pick the next one before any round trip could complete; the server
  // trusts this exact board back once it arrives, so the two can never
  // actually disagree (see the api's own dama_move handler).
  function onDamaMatchSquareClick(boardId, row, col) {
    if (!activeDamaMatch || activeDamaMatch.boardId !== boardId || activeDamaMatch.isSpectator) return;
    const board = damaBoards[boardId];
    if (board.status !== "in_progress" || board.outcome) return;
    const myColor = board.whiteUserId === localUserId ? "white" : board.blackUserId === localUserId ? "black" : null;
    if (myColor == null || board.turn !== myColor) return;

    const legalMoves = getAllLegalMoves(board.grid, myColor, activeDamaMatch.midChain ? activeDamaMatch.selectedSquare : undefined);
    if (activeDamaMatch.selectedSquare == null) {
      const piece = board.grid[row][col];
      if (piece && piece.side === myColor && legalMoves.some((m) => m.from.row === row && m.from.col === col)) {
        activeDamaMatch.selectedSquare = { row, col };
        renderDamaMatchModal();
      }
      return;
    }

    const move = legalMoves.find(
      (m) => m.from.row === activeDamaMatch.selectedSquare.row && m.from.col === activeDamaMatch.selectedSquare.col
        && m.to.row === row && m.to.col === col,
    );
    if (move) {
      // This turn's very first hop — snapshot the board/side exactly as
      // they are right now, before the move is applied, purely so a later
      // "Request Undo" (see renderDamaMatchModal) has something to send
      // back (see dama_undo_commit's own comment on why it has to be THIS
      // client, not the server, that holds it). Untouched by every
      // subsequent hop of the same turn — only the first one matters.
      if (!activeDamaMatch.midChain) {
        activeDamaMatch.lastTurnSnapshot = { board: board.grid, sideToMove: board.turn };
        activeDamaMatch.turnStartSquare = { row: activeDamaMatch.selectedSquare.row, col: activeDamaMatch.selectedSquare.col };
      }
      const result = applyDamaMove(board.grid, move);
      const continued = !!result.continuedCaptureFrom;
      let outcome = null;
      if (continued) {
        activeDamaMatch.selectedSquare = result.continuedCaptureFrom;
        activeDamaMatch.midChain = true;
      } else {
        activeDamaMatch.selectedSquare = null;
        activeDamaMatch.midChain = false;
        const otherSide = myColor === "white" ? "black" : "white";
        if (hasNoLegalMoves(result.board, otherSide)) outcome = { winner_side: myColor, reason: "no_moves" };
      }
      board.grid = result.board;
      board.turn = continued ? myColor : (myColor === "white" ? "black" : "white");
      board.lastMove = { from: [activeDamaMatch.turnStartSquare.row, activeDamaMatch.turnStartSquare.col], to: [row, col], by: myColor };
      if (outcome) board.outcome = { winnerUserId: outcome.winner_side === "white" ? board.whiteUserId : board.blackUserId, reason: outcome.reason };
      renderDamaMatchModal();
      socket.sendDamaMove(boardId, result.board, { continued, outcome, lastMove: board.lastMove });
      return;
    }

    if (activeDamaMatch.midChain) return; // must keep capturing with the same piece — ignore anything else
    const piece = board.grid[row][col];
    if (piece && piece.side === myColor && legalMoves.some((m) => m.from.row === row && m.from.col === col)) {
      activeDamaMatch.selectedSquare = { row, col };
    } else {
      activeDamaMatch.selectedSquare = null;
    }
    renderDamaMatchModal();
  }

  function renderDamaMatchModal() {
    if (!activeDamaMatch) return;
    const board = damaBoards[activeDamaMatch.boardId];
    damaMatchBodyEl.innerHTML = "";

    const myColor = board.whiteUserId === localUserId ? "white" : board.blackUserId === localUserId ? "black" : null;
    const whiteName = board.whiteDisplayName || "?";
    const blackName = board.blackDisplayName || "?";
    const info = document.createElement("p");
    info.style.margin = "0 0 6px 0";
    info.style.fontSize = "11px";
    info.textContent = activeDamaMatch.isSpectator
      ? `Spectating: ${whiteName} (White) vs ${blackName} (Black)`
      : `You are ${myColor === "white" ? "White" : "Black"} — vs ${myColor === "white" ? blackName : whiteName}`;
    damaMatchBodyEl.appendChild(info);

    // A one-time legend for the two last-move tints (see
    // TAMBAYAN_LAST_MOVE_TINT/_OPPONENT_TINT above) — only meaningful once
    // there's actually a last move to show, and only for the two real
    // players (a spectator has no "mine" to tell the opponent's apart
    // from).
    if (board.lastMove && myColor != null) {
      const legend = document.createElement("p");
      legend.style.margin = "0 0 6px 0";
      legend.style.fontSize = "10px";
      legend.style.display = "flex";
      legend.style.gap = "10px";
      const swatch = (color) => `<span style="display:inline-block;width:9px;height:9px;background:${color};border-radius:2px;margin-right:3px;vertical-align:middle;"></span>`;
      legend.innerHTML = `<span>${swatch(TAMBAYAN_LAST_MOVE_TINT)}Your last move</span><span>${swatch(TAMBAYAN_LAST_MOVE_OPPONENT_TINT)}Opponent's last move</span>`;
      damaMatchBodyEl.appendChild(legend);
    }

    // White always sits at the bottom for White/spectators; Black's own
    // view flips (screen row/col reversed) so Black sits at the bottom of
    // their own board too — same convention Chess's board already uses.
    const flip = !activeDamaMatch.isSpectator && myColor === "black";
    const legalMoves = !activeDamaMatch.isSpectator && !board.outcome && board.turn === myColor
      ? getAllLegalMoves(board.grid, myColor, activeDamaMatch.midChain ? activeDamaMatch.selectedSquare : undefined)
      : [];
    const destinations = activeDamaMatch.selectedSquare
      ? legalMoves.filter((m) => m.from.row === activeDamaMatch.selectedSquare.row && m.from.col === activeDamaMatch.selectedSquare.col).map((m) => m.to)
      : [];

    const gridEl = document.createElement("div");
    gridEl.style.display = "grid";
    gridEl.style.gridTemplateColumns = "repeat(8, 32px)";
    gridEl.style.gridTemplateRows = "repeat(8, 32px)";
    gridEl.style.margin = "0 0 6px 0";
    for (let screenRow = 0; screenRow < 8; screenRow++) {
      for (let screenCol = 0; screenCol < 8; screenCol++) {
        const row = flip ? 7 - screenRow : screenRow;
        const col = flip ? 7 - screenCol : screenCol;
        const sq = document.createElement("div");
        sq.style.width = "32px";
        sq.style.height = "32px";
        sq.style.display = "flex";
        sq.style.alignItems = "center";
        sq.style.justifyContent = "center";
        sq.style.position = "relative";
        sq.style.cursor = activeDamaMatch.isSpectator ? "default" : "pointer";
        const light = (row + col) % 2 === 0;
        const isLastMove = board.lastMove && (
          (board.lastMove.from[0] === row && board.lastMove.from[1] === col) ||
          (board.lastMove.to[0] === row && board.lastMove.to[1] === col)
        );
        // Distinct tint for "the opponent's (or the AI's) last move" vs
        // "my own last move" — see board.lastMove.by's own comment
        // (_play_dama_ai_move/dama_move, both api-side). Spectators have
        // no myColor at all (null), so their own view always falls back to
        // the plain "mine" tint.
        const lastMoveTint = board.lastMove && myColor != null && board.lastMove.by !== myColor
          ? TAMBAYAN_LAST_MOVE_OPPONENT_TINT
          : TAMBAYAN_LAST_MOVE_TINT;
        sq.style.background = isLastMove ? lastMoveTint : (light ? TAMBAYAN_BOARD_LIGHT : TAMBAYAN_BOARD_DARK);
        const isSelected = activeDamaMatch.selectedSquare && activeDamaMatch.selectedSquare.row === row && activeDamaMatch.selectedSquare.col === col;
        sq.style.boxShadow = isSelected ? "inset 0 0 0 2px orange" : "none";
        const piece = board.grid[row][col];
        if (piece) {
          const disc = document.createElement("div");
          disc.style.width = "24px";
          disc.style.height = "24px";
          disc.style.borderRadius = "50%";
          disc.style.display = "flex";
          disc.style.alignItems = "center";
          disc.style.justifyContent = "center";
          disc.style.fontSize = "12px";
          disc.style.background = piece.side === "white" ? "#f5f5f5" : "#1f2937";
          disc.style.border = piece.side === "white" ? "2px solid #1f2937" : "2px solid #f5f5f5";
          if (piece.king) {
            disc.textContent = "★";
            disc.style.color = piece.side === "white" ? "#1f2937" : "#f5f5f5";
          }
          sq.appendChild(disc);
        }
        if (destinations.some((d) => d.row === row && d.col === col)) {
          const dot = document.createElement("div");
          dot.style.position = "absolute";
          dot.style.width = "9px";
          dot.style.height = "9px";
          dot.style.borderRadius = "50%";
          dot.style.background = "#4ade8099";
          sq.appendChild(dot);
        }
        if (!activeDamaMatch.isSpectator) {
          sq.addEventListener("click", () => onDamaMatchSquareClick(activeDamaMatch.boardId, row, col));
        }
        gridEl.appendChild(sq);
      }
    }
    damaMatchBodyEl.appendChild(gridEl);

    if (board.outcome) {
      const reasonText = {
        resignation: "Resignation", disconnect: "Opponent disconnected",
        no_moves: "No legal moves left", draw_agreed: "Draw by agreement",
      }[board.outcome.reason] || board.outcome.reason;
      const outcomeEl = document.createElement("p");
      outcomeEl.style.fontWeight = "bold";
      outcomeEl.style.fontSize = "12px";
      if (board.outcome.winnerUserId == null) {
        outcomeEl.textContent = `Game over — ${reasonText}.`;
      } else if (board.outcome.winnerUserId === localUserId) {
        outcomeEl.textContent = `You won — ${reasonText}!`;
      } else if (!activeDamaMatch.isSpectator) {
        outcomeEl.textContent = `You lost — ${reasonText}.`;
      } else {
        const winnerName = board.outcome.winnerUserId === board.whiteUserId ? whiteName : blackName;
        outcomeEl.textContent = `${winnerName} won — ${reasonText}.`;
      }
      damaMatchBodyEl.appendChild(outcomeEl);
    } else if (!activeDamaMatch.isSpectator) {
      const turnEl = document.createElement("p");
      turnEl.style.fontSize = "11px";
      turnEl.style.color = "#a3a3a3";
      turnEl.textContent = activeDamaMatch.midChain
        ? "Continue capturing with the same piece."
        : board.turn === myColor ? "Your move."
        : activeDamaMatch.boardId === AI_BOARD_ID ? `${DAMA_AI_NAME} is thinking…` : "Waiting for opponent…";
      damaMatchBodyEl.appendChild(turnEl);
    }

    if (!activeDamaMatch.isSpectator && !board.outcome) {
      // Offer Draw / Request Undo — same shape as Chess's own (see
      // renderChessMatchModal), human-vs-human boards only.
      if (board.undoRequestedBy != null) {
        const p = document.createElement("p");
        p.style.fontSize = "11px";
        p.style.margin = "0 0 4px 0";
        p.textContent = board.undoRequestedBy === localUserId
          ? "Undo request sent — waiting for response…"
          : "Opponent requests to undo their last move.";
        damaMatchBodyEl.appendChild(p);
        if (board.undoRequestedBy !== localUserId) {
          addRespondButtons(damaMatchBodyEl, (accept) => socket.sendDamaUndoRespond(activeDamaMatch.boardId, accept));
        }
      } else if (board.drawOfferedBy != null) {
        const p = document.createElement("p");
        p.style.fontSize = "11px";
        p.style.margin = "0 0 4px 0";
        p.textContent = board.drawOfferedBy === localUserId
          ? "Draw offer sent — waiting for response…"
          : "Opponent offers a draw.";
        damaMatchBodyEl.appendChild(p);
        if (board.drawOfferedBy !== localUserId) {
          addRespondButtons(damaMatchBodyEl, (accept) => socket.sendDamaDrawRespond(activeDamaMatch.boardId, accept));
        }
      } else if (activeDamaMatch.boardId !== AI_BOARD_ID) {
        const drawBtn = document.createElement("button");
        drawBtn.textContent = "Offer Draw";
        drawBtn.style.fontSize = "11px";
        drawBtn.style.marginRight = "4px";
        drawBtn.addEventListener("click", () => socket.sendDamaDrawOffer(activeDamaMatch.boardId));
        damaMatchBodyEl.appendChild(drawBtn);

        // board.moveHistory isn't a reliable "has anyone moved yet" signal
        // for Dama the way it is for Chess (see sendDamaMove — this client
        // never actually sends move_text, so the server's own move_history
        // never grows past its own dama_move handler's own no-op default)
        // — board.lastMove is set on every real move sent though, so use
        // that instead as "at least one turn has actually completed."
        if (board.turn !== myColor && board.lastMove != null) {
          const undoBtn = document.createElement("button");
          undoBtn.textContent = "Request Undo";
          undoBtn.style.fontSize = "11px";
          undoBtn.style.marginRight = "4px";
          undoBtn.addEventListener("click", () => socket.sendDamaUndoRequest(activeDamaMatch.boardId));
          damaMatchBodyEl.appendChild(undoBtn);
        }
      }

      const resignBtn = document.createElement("button");
      resignBtn.textContent = "Resign";
      resignBtn.style.fontSize = "11px";
      resignBtn.addEventListener("click", () => socket.sendDamaResign(activeDamaMatch.boardId));
      damaMatchBodyEl.appendChild(resignBtn);
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
      // Same "saved Starting Angle takes effect immediately" reasoning as
      // the wild/team battles' own camAngle init above — see cameraOverrides.pvp.
      camAngle: cameraOverrides.pvp?.angle ?? (local.facingAngle + BATTLE_CAM_ANGLE_OFFSET),
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

    // Disabled (not hidden) while a practice is already counting down or
    // running — the button staying visible but inert reads more clearly
    // as "one's already going" than the whole section vanishing would.
    karraPracticeBtn.disabled = !!karirsPracticeState;
    karraPracticeBtn.textContent = karirsPracticeState ? "Practice already running" : "Practice Race";
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
    karraPracticeMsgEl.style.display = "none";
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

    const usherHits = raycaster.intersectObject(usherRig.group, true);
    const usherInRange = Math.hypot(local.x - USHER_X, local.z - USHER_Z) <= INTERACTION_RANGE;
    if (usherHits.length > 0 && usherInRange) {
      showUsherMenu(event.clientX, event.clientY);
      return;
    }
    hideUsherMenu();

    // The two chess tables — same raycast shape as every NPC/prop above,
    // but the range gate itself depends on that board's own state: a plain
    // proximity check for an empty/waiting board (must walk right up to
    // host/join), or "anywhere inside Chessdom" once a game is actually
    // in_progress (so a spectator can click it from across the yard) —
    // mirrors the exact same OR'd-in condition the highlight updaters use.
    const board1Hits = raycaster.intersectObject(chessBoard1Group, true);
    const board1AnyInProgress = chessBoards[1].status === "in_progress" || damaBoards[1].status === "in_progress";
    const board1Clickable = board1AnyInProgress
      ? isInsideTambayan(local.x, local.z)
      : Math.hypot(local.x - CHESS_BOARD_1_X, local.z - CHESS_BOARD_1_Z) <= INTERACTION_RANGE;
    if (board1Hits.length > 0 && board1Clickable) {
      onSharedBoardClick(1, event.clientX, event.clientY);
      return;
    }
    const board2Hits = raycaster.intersectObject(chessBoard2Group, true);
    const board2AnyInProgress = chessBoards[2].status === "in_progress" || damaBoards[2].status === "in_progress";
    const board2Clickable = board2AnyInProgress
      ? isInsideTambayan(local.x, local.z)
      : Math.hypot(local.x - CHESS_BOARD_2_X, local.z - CHESS_BOARD_2_Z) <= INTERACTION_RANGE;
    if (board2Hits.length > 0 && board2Clickable) {
      onSharedBoardClick(2, event.clientX, event.clientY);
      return;
    }
    const board3Hits = raycaster.intersectObject(chessBoard3Group, true);
    const board3AnyInProgress = chessBoards[3].status === "in_progress" || damaBoards[3].status === "in_progress";
    const board3Clickable = board3AnyInProgress
      ? isInsideTambayan(local.x, local.z)
      : Math.hypot(local.x - CHESS_BOARD_3_X, local.z - CHESS_BOARD_3_Z) <= INTERACTION_RANGE;
    if (board3Hits.length > 0 && board3Clickable) {
      onAiBoardClick(3, event.clientX, event.clientY);
      return;
    }
    hideChessHostMenu();
    hideChessJoinMenu();
    hideBoardHostChoiceMenu();
    hideDamaJoinMenu();

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

    // A wild mob — left-click SELECTS it (drives selectedWildHudEl above
    // and is what "T" throws a Glophiball at, see onKeyDown) if you're
    // actually within INTERACTION_RANGE of it — same "right distance" rule
    // as every NPC/prop above (and the same distance its own proximity
    // highlight lights up at, see updateWildSpawns), since throwing a ball
    // or reading its info is a personal, close-range action. Directing an already-
    // summoned companion at it is a SEPARATE, deliberately ungated action
    // (a companion can be sent at anything visible on screen and will
    // simply walk there itself; the server is the real authority on range
    // for the attack itself, see companion_attack) — sent whenever the
    // raycast hits regardless of the player's own distance, independent of
    // whether selection itself succeeded this click. Sending
    // companion_target with no summoned companion is silently ignored
    // server-side, so gating that specific call (not the hit-test) on
    // companionSpawns.has(...) is purely a "don't bother sending it"
    // client-side shortcut.
    for (const spawn of wildSpawns.values()) {
      const wildHits = raycaster.intersectObject(spawn.rig.group, true);
      if (wildHits.length > 0) {
        if (companionSpawns.has(localUserId)) socket.sendCompanionTarget(spawn.id);
        if (Math.hypot(local.x - spawn.x, local.z - spawn.z) <= INTERACTION_RANGE) {
          selectedWildId = spawn.id;
          refreshSelectedWildHud();
        }
        return;
      }
    }
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
    // A friendly send-off instead of the menu just vanishing — same
    // "leave the text up, let the player close it themselves" UX the
    // already-claimed scolding message above already uses, rather than
    // calling hideRodzMenu() immediately (which used to close the popup
    // before there was ever anything to read).
    const sendOff = RODZ_CLAIM_SEND_OFFS[Math.floor(Math.random() * RODZ_CLAIM_SEND_OFFS.length)];
    rodzClaimTextEl.textContent = `Here's ${DAILY_CLAIM_GLOPHIBALLS} Glophiballs. ${sendOff}`;
    rodzClaimTextEl.style.display = "block";
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
  // Fully local — no server round-trip, no await, unlike the two handlers
  // above. See KARIRS_PRACTICE_BLOCK_WINDOW_MS's own comment for why the
  // real race's own state can still veto it even though nothing here talks
  // to the server about it.
  karraPracticeBtn.addEventListener("click", () => {
    const race = karirsRace;
    const now = Date.now();
    const closesAt = race?.status === "betting_open" ? new Date(`${race.betting_closes_at}Z`).getTime() : null;
    const raceImminent = race?.status === "racing" || (closesAt !== null && closesAt - now < KARIRS_PRACTICE_BLOCK_WINDOW_MS);
    karraPracticeMsgEl.style.display = "block";
    if (raceImminent) {
      karraPracticeMsgEl.textContent = "The next race will run shortly, so I can't let you use the field right now.";
      return;
    }
    const racerNames = race?.racer_names?.length ? race.racer_names : KARIRS_PRACTICE_FALLBACK_NAMES;
    karirsPracticeState = { phase: "countdown", countdownEndsAt: now + KARIRS_PRACTICE_COUNTDOWN_MS, racerNames };
    karraPracticeMsgEl.textContent = "Clear the track — the race will begin in a 10 second countdown!";
    refreshKarraMenu();
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
    // E opens the companion picker (or, pressed again, swaps whichever one
    // is currently summoned for a different pick — see
    // showCompanionSummonModal) — edge-triggered, not part of the held
    // `pressed` set below, since opening a modal on every frame a key
    // happens to still be down would be wrong.
    if (event.code === "KeyE") {
      showCompanionSummonModal();
      return;
    }
    // The companion's basic melee attack (see this game's own plan file —
    // other number keys are visually reserved for future skills and stay
    // inert). Edge-triggered the same way: one attack per press, not one
    // per frame the key happens to still be held. The server itself is
    // still the real cooldown gate (see _handle_companion_message's own
    // companion_attack branch) — this client-side check (see
    // actionCooldownUntil/refreshActionBar) is purely to avoid sending a
    // request the server would just silently drop anyway, and to start the
    // visual clock the instant the key is pressed rather than waiting on a
    // round trip.
    if (event.code === "Digit1") {
      const now = performance.now();
      if ((actionCooldownUntil[1] ?? 0) > now) return;
      socket.sendCompanionAttack();
      if (companionActionSpeed != null) actionCooldownUntil[1] = now + actionCooldownS(ACTION_WEIGHTS[1], companionActionSpeed) * 1000;
      return;
    }
    // "T" throws a Glophiball at whatever's currently selected (left-click,
    // see onCanvasClick/selectedWildId above) — replaces the old right-
    // click-to-capture control. No local range/cooldown gate here, same as
    // every other real-time-combat send in this file — the server is the
    // sole authority (see _handle_wild_capture_attempt), this is just "the
    // player asked to throw one," nothing more.
    if (event.code === "KeyT") {
      if (selectedWildId != null) socket.sendWildCaptureAttempt(selectedWildId);
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
      for (const p of msg.players) ensurePeer(p.user_id, p.display_name, p, p.x, p.z, p.facing, p.floor ?? 0);
      status.textContent = `Connected as ${character.display_name}`;
    } else if (msg.type === "joined") {
      ensurePeer(msg.user_id, msg.display_name, msg, msg.x, msg.z, msg.facing, msg.floor ?? 0);
    } else if (msg.type === "position") {
      const peer = peers.get(msg.user_id);
      if (!peer) return;
      peer.targetX = msg.x;
      peer.targetZ = msg.z;
      peer.targetFacing = msg.facing;
      peer.isMoving = Math.hypot(msg.x - peer.x, msg.z - peer.z) > 0.01;
      // Floor changes are a discrete snap, not something to ease like x/z
      // above (matches how the LOCAL player's own currentFloor changes on
      // the stairs, see checkStairsContact) — updates peer.y immediately
      // too, so this peer renders at the correct height the instant it's
      // no longer hidden by the floor-mismatch check in the render loop
      // below (see frame()'s own peers loop).
      peer.floor = msg.floor ?? 0;
      peer.y = glophicsFloorY(peer.floor);
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
      for (const w of msg.wilds) ensureWildSpawn(w.id, w.species_key, w.level, w.x, w.z, w.facing, w.hp, w.max_hp, w.combat_state);
    } else if (msg.type === "wild_spawn") {
      // No hp/max_hp/combat_state on a fresh spawn's own broadcast (a brand
      // new wild is always "normal" with a full, not-yet-computed-on-this-
      // client HP pool) — ensureWildSpawn's own hp ?? 0/maxHp ?? 1 fallback
      // covers the instant before the next wild_tick fills in the real
      // numbers, and the bar itself stays hidden the whole time anyway
      // (only shown once combat_state is "aggroed").
      ensureWildSpawn(msg.id, msg.species_key, msg.level, msg.x, msg.z, msg.facing);
    } else if (msg.type === "wild_despawn") {
      // Only an actual combat kill (reason: "killed", see the api's own
      // _kill_wild) gets the new collapse-then-fade — a capture already has
      // its own satisfying moment via wild_capture_result's instant
      // removeWildSpawn, and a wild that simply wandered off/expired (see
      // _wild_tick's own to_despawn list, reason: "left") never took any
      // damage at all, so playing a death animation for it would read as a
      // bug, not a feature.
      if (msg.reason === "killed") {
        const spawn = wildSpawns.get(msg.id);
        // Same visual-sync delay as wild_hp_update below — the kill itself
        // already happened server-side, but it shouldn't SHOW until the
        // companion's own swing (see companion_attack_landed) actually
        // connects. pendingCompanionAttackDelayMs is null (apply right
        // away) if this kill came from a capture instead — captures have
        // no attack swing to wait on.
        if (spawn && pendingCompanionAttackDelayMs != null) {
          spawn.pendingHp = null; // a kill supersedes any still-pending non-lethal hit
          spawn.pendingDeath = { delayMs: pendingCompanionAttackDelayMs };
          pendingCompanionAttackDelayMs = null;
        } else {
          startWildDeath(msg.id);
        }
      } else removeWildSpawn(msg.id);
    } else if (msg.type === "wild_tick") {
      for (const u of msg.updates) {
        const spawn = wildSpawns.get(u.id);
        if (!spawn) continue;
        spawn.targetX = u.x;
        spawn.targetZ = u.z;
        spawn.targetFacing = u.facing;
        spawn.isMoving = u.moving;
        setWildCombatFields(spawn, u.hp, u.max_hp, u.combat_state);
      }
    } else if (msg.type === "wild_hp_update") {
      // A live push on every companion hit that didn't kill it, independent
      // of (and snappier than) the next periodic wild_tick — see this
      // game's own plan file. Held until the attacking companion's own
      // swing visually connects (see pendingCompanionAttackDelayMs and this
      // wild's own pendingHp countdown in updateWildSpawns) rather than
      // applied the instant it arrives — same reasoning as wild_attack's
      // own hp_update delay, the other direction.
      const spawn = wildSpawns.get(msg.id);
      if (spawn) {
        if (pendingCompanionAttackDelayMs != null) {
          spawn.pendingHp = { hp: msg.hp, maxHp: msg.max_hp, delayMs: pendingCompanionAttackDelayMs };
          pendingCompanionAttackDelayMs = null;
        } else {
          if (msg.hp < spawn.hp) spawn.flinchElapsedMs = 0; // a real hit landed, not just a refresh echoing the same value
          setWildCombatFields(spawn, msg.hp, msg.max_hp);
        }
      }
    } else if (msg.type === "wild_attack") {
      // A landed swing against SOME player's own body (see this game's own
      // _wild_tick) — broadcast to everyone, not just the victim, purely so
      // the mob's own attack animation (see updateWildSpawns) is visible to
      // any bystander watching the same aggroed wild too.
      const spawn = wildSpawns.get(msg.id);
      if (spawn) spawn.attackAnimElapsedMs = 0;
      // Also arms the delay THIS account's own hp_update/player_blackout
      // (below) waits out before actually applying — but only when this
      // swing actually targeted ME. wild_attack broadcasts to every
      // bystander regardless of who got hit, while hp_update only ever
      // arrives for the real victim, so arming the delay for someone
      // ELSE's hit would wrongly hold up this account's own next,
      // unrelated one.
      if (msg.target_user_id === localUserId) pendingWildAttackDelayMs = effectivePoseDurationMs("attack");
    } else if (msg.type === "wild_capture_result") {
      if (msg.caught) {
        // Idempotent — the wild_despawn broadcast for the same kill is
        // already on its way right behind this, if it hasn't landed first.
        removeWildSpawn(msg.wild_id);
        showCaptureToast(`Gotcha! Caught it!`);
      } else if (msg.reason === "missed") {
        showCaptureToast("It broke free!");
      } else if (msg.reason === "no_glophiballs") {
        showCaptureToast("You're out of Glophiballs.");
      }
    } else if (msg.type === "companion_roster") {
      for (const c of msg.companions) ensureCompanionSpawn(c.user_id, c.species_key, c.level, c.x, c.z, c.facing, c.state);
    } else if (msg.type === "companion_spawn") {
      // Fired once, the instant ANY player (including this client itself)
      // summons or swaps a companion mid-session — companion_roster above
      // only ever covers whoever was already summoned at connect time, and
      // companion_tick's own per-frame updates silently skip any user_id
      // this client hasn't seen a spawn for yet, so without this a fresh
      // summon would tick along forever without ever actually appearing.
      ensureCompanionSpawn(msg.user_id, msg.species_key, msg.level, msg.x, msg.z, msg.facing, "idle_follow");
    } else if (msg.type === "companion_tick") {
      for (const u of msg.updates) {
        const spawn = companionSpawns.get(u.user_id);
        if (!spawn) continue;
        spawn.targetX = u.x;
        spawn.targetZ = u.z;
        spawn.targetFacing = u.facing;
        spawn.isMoving = u.moving;
        spawn.state = u.state;
      }
    } else if (msg.type === "companion_despawn") {
      removeCompanionSpawn(msg.user_id);
    } else if (msg.type === "companion_attack_landed") {
      // A companion's own swing landed (see _handle_companion_message's own
      // companion_attack branch) — broadcast to everyone so any bystander
      // watching this fight sees the companion's own attack animation too,
      // not just its owner. Also arms the delay the wild_hp_update/
      // wild_despawn that's always immediately about to follow (same
      // server-side handler call) will wait out — see those handlers.
      const spawn = companionSpawns.get(msg.user_id);
      if (spawn) spawn.attackAnimElapsedMs = 0;
      pendingCompanionAttackDelayMs = effectivePoseDurationMs("attack");
    } else if (msg.type === "hp_update") {
      // A non-lethal mob hit landed on this account's own body — applied
      // directly (unlike Rodz's heal/setPlayerHp) since the server already
      // persisted this itself; no ctx.onSetPlayerHp round-trip needed or
      // wanted here. Held until the mob's own swing (see wild_attack above)
      // visually finishes rather than applied immediately — same reasoning
      // as wild_hp_update's own delay, the other direction.
      if (pendingWildAttackDelayMs != null) {
        pendingPlayerHp = { currentHp: msg.current_hp, delayMs: pendingWildAttackDelayMs };
        pendingWildAttackDelayMs = null;
      } else {
        if (msg.current_hp < playerHp) playerFlinchElapsedMs = 0; // see local.rig's own flinch overlay in frame()
        playerHp = msg.current_hp;
        refreshPlayerHpHud();
      }
    } else if (msg.type === "player_blackout") {
      // Full heal + teleport back to the Glophics spawn — the exact same
      // local effect handlePlayerBlackout already produces, just triggered
      // by the server's own authoritative push instead of a local 0-HP
      // check, since the trainer's own HP is server-owned now (see this
      // game's own plan file). handlePlayerBlackout's own setPlayerHp call
      // does re-notify the server via ctx.onSetPlayerHp — harmless, since
      // it's just re-confirming the exact value the server itself just set.
      // Same swing-finishes-first delay as hp_update above.
      if (pendingWildAttackDelayMs != null) {
        pendingPlayerBlackout = { delayMs: pendingWildAttackDelayMs };
        pendingWildAttackDelayMs = null;
      } else {
        handlePlayerBlackout();
        refreshPlayerHpHud();
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
        drawOfferedBy: msg.draw_offered_by,
        undoRequestedBy: msg.undo_requested_by,
        lastMove: msg.last_move,
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
    } else if (msg.type === "dama_state") {
      // While I'm mid-chain as the piece's own acting mover, my local
      // grid/turn are always at least as fresh as anything this broadcast
      // can say — I'm the only one who can still be capturing with this
      // board's pieces right now (see onDamaMatchSquareClick: every hop is
      // sent as its own dama_move, optimistically applied locally first).
      // A network-delayed echo of an EARLIER hop in this same chain must
      // never roll the board back underneath a selection that's already
      // moved further along — that's exactly the "highlight sitting on an
      // empty square, stuck saying continue capturing" bug this guards
      // against: rapid clicks through a multi-hop capture can easily
      // outrun the round trip of an earlier hop's own echo. Every other
      // field (status/outcome/etc) still always takes the broadcast's own
      // value regardless — those can change for reasons this optimistic
      // path doesn't cover at all (the opponent resigning mid-chain is
      // legal at any time, and must still end the game immediately).
      const amMidChainActor = activeDamaMatch && activeDamaMatch.boardId === msg.board_id && activeDamaMatch.midChain && !activeDamaMatch.isSpectator;
      const prevBoard = damaBoards[msg.board_id];
      const board = {
        status: msg.status,
        hostId: msg.host_id,
        hostDisplayName: msg.host_display_name,
        whiteUserId: msg.white_user_id,
        whiteDisplayName: msg.white_display_name,
        blackUserId: msg.black_user_id,
        blackDisplayName: msg.black_display_name,
        grid: amMidChainActor && prevBoard ? prevBoard.grid : msg.board,
        turn: amMidChainActor && prevBoard ? prevBoard.turn : msg.turn,
        moveHistory: msg.move_history,
        outcome: msg.outcome ? { winnerUserId: msg.outcome.winner_user_id, reason: msg.outcome.reason } : null,
        drawOfferedBy: msg.draw_offered_by,
        undoRequestedBy: msg.undo_requested_by,
        undoAcceptPendingFor: msg.undo_accept_pending_for,
        // Same "keep my own further-along local value" guard as grid/turn
        // above — purely cosmetic here (unlike grid/turn, a stale value
        // can't wedge the render), but there's no reason to let a
        // network-delayed echo flicker the highlight backward mid-chain
        // either.
        lastMove: amMidChainActor && prevBoard ? prevBoard.lastMove : msg.last_move,
      };
      damaBoards[msg.board_id] = board;
      updateDamaBoardSign(msg.board_id, board);

      // My own undo request was just accepted — I'm the only client that
      // still has the pre-move board in memory (see
      // activeDamaMatch.lastTurnSnapshot, set right when I started that
      // move), so I'm the one who has to send it back. One-shot: clear the
      // snapshot immediately so a later, unrelated dama_state broadcast
      // (still carrying the same now-stale undo_accept_pending_for right
      // up until this commit's own echo arrives) can't fire it twice.
      if (
        board.undoAcceptPendingFor === localUserId
        && activeDamaMatch && activeDamaMatch.boardId === msg.board_id
        && activeDamaMatch.lastTurnSnapshot
      ) {
        const snap = activeDamaMatch.lastTurnSnapshot;
        activeDamaMatch.lastTurnSnapshot = null;
        socket.sendDamaUndoCommit(msg.board_id, snap.board, snap.sideToMove);
      }

      if (board.status === "waiting" && board.hostId === localUserId) {
        myHostedDamaBoardId = msg.board_id;
        damaWaitingModalEl.style.display = "flex";
        renderDamaWaitingModal();
      } else if (myHostedDamaBoardId === msg.board_id) {
        myHostedDamaBoardId = null;
        hideDamaWaitingModal();
      }

      const isNewActiveGameIAmIn = board.status === "in_progress" && !board.outcome &&
        (board.whiteUserId === localUserId || board.blackUserId === localUserId);
      if (isNewActiveGameIAmIn && (!activeDamaMatch || activeDamaMatch.boardId !== msg.board_id)) {
        showDamaMatchModal(msg.board_id, false);
      } else if (activeDamaMatch && activeDamaMatch.boardId === msg.board_id) {
        if (board.status === "empty") {
          hideDamaMatchModal();
        } else {
          // Authoritative echo of a move this same client likely already
          // applied optimistically (see onDamaMatchSquareClick) — keeps
          // selectedSquare/midChain exactly as they are instead of
          // clearing them, so a chain-capture already mid-flight from this
          // client's own optimistic update doesn't get its selection
          // wiped out by the server simply confirming what it already knew.
          renderDamaMatchModal();
        }
      }
    } else if (msg.type === "dama_error") {
      showDamaError(msg.reason);
    } else if (msg.type === "cinema_projectionist_state") {
      // Sent both as a live push (someone just claimed or vacated the
      // role) and as this client's own late-join catch-up (see the api's
      // own world_ws, right where it sends wild_battle_roster/karirs_state)
      // — both arrive as the exact same shape, so there's nothing to
      // distinguish here, just take whatever the server says as current.
      cinemaProjectionist = msg.projectionist ?? null;
      if (usherMenuEl.style.display !== "none") renderUsherMenu();
    } else if (msg.type === "cinema_screen_state") {
      // Same "live push or late-join catch-up, identical shape" story as
      // cinema_projectionist_state above. Updating cinemaScreenUrl (not
      // just the iframe's own src) matters — it's what the frame() loop's
      // isYoutubeEmbedUrl check reads to decide whether the YouTube-only
      // play/pause postMessage command is even worth sending on the next
      // floor/battle visibility change.
      cinemaScreenUrl = msg.url;
      cinemaScreen.iframe.src = cinemaScreenUrl;
    } else if (msg.type === "cinema_error") {
      showUsherError(msg.reason);
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

  const socket = connectGlophiworldSocket(onSocketMessage);

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
      if (!tryPlayLocalOverride("idle", dt)) applyIdlePose(local.rig, dt);
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
        if (!isInsideTownWalls(nextX, local.z, local.currentFloor) && !isInsideTambayanWalls(nextX, local.z) && !isInsideChessTables(nextX, local.z)) local.x = nextX;
        if (!isInsideTownWalls(local.x, nextZ, local.currentFloor) && !isInsideTambayanWalls(local.x, nextZ) && !isInsideChessTables(local.x, nextZ)) local.z = nextZ;
        local.facingAngle = Math.atan2(moveX, moveZ);
        if (!tryPlayLocalOverride("walk", dt)) updateWalkCycle(local.rig, dt, speedMult);
      } else {
        if (!tryPlayLocalOverride("idle", dt)) applyIdlePose(local.rig, dt);
      }
      if (wantsSprint) {
        stamina = Math.max(0, stamina - STAMINA_DRAIN_PER_SEC * dt);
        if (stamina <= 0) staminaExhausted = true;
      } else {
        stamina = Math.min(STAMINA_MAX, stamina + STAMINA_REGEN_PER_SEC * dt);
        if (staminaExhausted && stamina >= STAMINA_MAX) staminaExhausted = false;
      }
    }
    // A held hp update/blackout (see hp_update/player_blackout's own
    // handlers) counting down to when the attacking wild's own swing
    // actually finishes — checked before the flinch block below so a
    // just-applied hit's flinch starts on the very same frame. Blackout
    // wins if somehow both are pending at once (shouldn't normally happen
    // — a lethal hit's own hp_update is never sent, only player_blackout,
    // see _wild_tick's own branch).
    if (pendingPlayerBlackout) {
      pendingPlayerBlackout.delayMs -= dt * 1000;
      if (pendingPlayerBlackout.delayMs <= 0) {
        pendingPlayerBlackout = null;
        pendingPlayerHp = null;
        handlePlayerBlackout();
        refreshPlayerHpHud();
      }
    } else if (pendingPlayerHp) {
      pendingPlayerHp.delayMs -= dt * 1000;
      if (pendingPlayerHp.delayMs <= 0) {
        const { currentHp } = pendingPlayerHp;
        pendingPlayerHp = null;
        if (currentHp < playerHp) playerFlinchElapsedMs = 0;
        playerHp = currentHp;
        refreshPlayerHpHud();
      }
    }
    // Local player's own flinch (see onSocketMessage's own hp_update
    // handling) — a decaying red emissive overlay plus, while it's still
    // active, stomps over whatever walk/idle pose the movement block above
    // just set for this same frame with the actual recoil pose instead
    // (same "getting hit overrides whatever you were doing" priority a
    // wild's own flinch already gives itself over its own attack-swing, see
    // updateWildSpawns).
    if (playerFlinchElapsedMs != null) {
      playerFlinchElapsedMs += dt * 1000;
      const totalMs = effectivePoseDurationMs("flinch");
      if (playerFlinchElapsedMs >= totalMs) {
        playerFlinchElapsedMs = null;
        setRigEmissiveIntensity(local.rig, 0);
      } else {
        // A saved Pose Designer "Flinch" override takes effect immediately,
        // no redeploy needed; falls back to the built-in recoil otherwise.
        if (!tryPlayBattlePoseOverride(local.rig, "flinch", playerFlinchElapsedMs, true)) applyFlinchPose(local.rig, playerFlinchElapsedMs, totalMs);
        const fade = 1 - playerFlinchElapsedMs / totalMs;
        setRigEmissiveIntensity(local.rig, FLINCH_PEAK * fade, FLINCH_COLOR);
      }
    }
    updateStaminaBar();
    updateGCoinsHud();
    // Recomputed every frame regardless of movement (not just while
    // actually walking) so standing still after a teleport/area change
    // still lands at the correct height, and so the camera's own
    // follow/pan targets (which read local.y) stay right too. A no-op for
    // floor >0 (entityGroundY just returns that floor's own fixed Y again).
    local.y = entityGroundY(local.currentFloor, local.x, local.z);
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

    applyIdlePose(usherRig, dt);
    syncNameLabel(usherRig);
    updateUsherHighlight(dt);

    updateLubaLobbyLive(dt);
    updateChessBoard1Highlight(dt);
    updateChessBoard2Highlight(dt);
    updateChessBoard3Highlight(dt);

    applyIdlePose(stockfishRig, dt);
    syncNameLabel(stockfishRig);

    for (const [peerUserId, peer] of peers.entries()) {
      const ease = Math.min(1, 12 * dt);
      peer.x += (peer.targetX - peer.x) * ease;
      peer.z += (peer.targetZ - peer.z) * ease;
      peer.facingAngle = peer.targetFacing;
      if (peer.isMoving) updateWalkCycle(peer.rig, dt);
      else applyIdlePose(peer.rig, dt);
      // Recomputed every frame from this peer's own (eased) x/z, same as
      // the local player's own y above — keeps them riding the terrain
      // smoothly as they walk instead of snapping.
      peer.y = entityGroundY(peer.floor, peer.x, peer.z);
      peer.rig.group.position.set(peer.x, peer.y, peer.z);
      peer.rig.group.rotation.y = peer.facingAngle;
      syncNameLabel(peer.rig);
      updateChatBubble(peer);
      peer.updateHighlight(dt);
      // A peer on a different Glophics floor than the local player is
      // hidden outright — the simplest correct behavior given floor 1
      // reuses the exact same X/Z footprint as the ground floor, which
      // would otherwise put two peers on different floors visually on top
      // of each other at the same spot. Computed every frame from
      // peer.floor (kept fresh by onSocketMessage's own "position"
      // handling — see ensurePeer/glophicsFloorY) vs. local.currentFloor,
      // same "hide the whole rig" mechanism (setPeerHidden) the battle-dome
      // hiding below already uses — this is just one more reason to hide,
      // combined with (not replacing) those.
      const floorMismatch = peer.floor !== local.currentFloor;
      // "Anyone who tries to enter this field will not be seen inside" —
      // a purely local rendering filter on this client only, not a
      // networked exclusion (see teamBattle's own comment). Wild combat has
      // no dome/instanced space any more (see this game's own plan file) —
      // there's nothing left to hide a peer from just for fighting a mob.
      if (teamBattle) {
        const dist = Math.hypot(peer.x - teamBattle.centerX, peer.z - teamBattle.centerZ);
        setPeerHidden(peer, floorMismatch || dist <= TEAM_DOME_RADIUS);
      } else {
        setPeerHidden(peer, floorMismatch);
      }
    }

    updateWildSpawns(dt);
    updateCompanionSpawns(dt);
    refreshActionBar();
    refreshSelectedWildHud();
    checkStairsContact();
    updateGlophicsExteriorCutaway();
    updateAreaLabels(dt);
    updateKarirsTrackVisual(dt);
    renderMinimap();

    // Other players' wild battles this client is spectating — see
    // peerBattles/applySpectatorBattleSnapshot/onSocketMessage's own
    // wild_battle_state handling above. Each entry drives its own rigs
    // through the exact same updateBattleRigAnim dispatch `battle`'s own
    // block below uses, so whatever Ready/Attack/Defend/Cast pose THIS
    // account has saved locally applies here too — pose overrides are a
    // purely local, per-viewer rendering preference (see
    // updateBattleRigAnim's own comment), never networked, so nothing about
    // this loop needs to know or care what pose the battling player (or any
    // other spectator) actually sees for the same action.
    for (const entry of peerBattles.values()) {
      for (const memberRig of entry.memberRigs) {
        updateBattleRigAnim(memberRig, "anim", memberRig.rig, dt);
        syncNameLabel(memberRig.rig);
      }
      updateBattleRigAnim(entry, "wildAnim", entry.wildRig, dt);
      syncNameLabel(entry.wildRig);
    }

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
      socket.sendPosition(local.x, local.z, local.facingAngle, local.currentFloor);
    }

    const width = canvas.clientWidth || canvas.getBoundingClientRect().width;
    const height = canvas.clientHeight || canvas.getBoundingClientRect().height;
    if (width > 0 && height > 0 && (width !== lastWidth || height !== lastHeight)) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      // Kept in lockstep with the WebGL canvas's own size/aspect — see the
      // cssRenderer's own construction comment above for why this second
      // render layer needs to always match it exactly.
      cssRenderer.setSize(width, height);
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
        // called every round by beginRound (and now also by
        // resolvePlayerAttack/resolveWildAttack's own "attack scene"/
        // "defend scene" re-aims). camY/lookY are read straight off
        // battle.focus itself now (resolved per-call by
        // resolveWildFocusParams from whichever Camera Designer slot was
        // active) rather than the old shared TEAM_FOCUS_CAM_HEIGHT/LOOK_Y
        // constants, so this render block never needs to know which of the
        // 4 focus slots produced the current shot. advanceFocusOrbit runs
        // first every frame so an active slot's own angle/heightRotateSpeed
        // (if any) keeps advancing camX/camY/camZ/lookX/lookY/lookZ in
        // place — see that function's own comment for why the advancing
        // happens here rather than inside focusWildCameraOnRig itself.
        advanceFocusOrbit(battle, battle.focus, dt);
        camera.position.set(battle.focus.camX, battle.focus.camY, battle.focus.camZ);
        camera.lookAt(battle.focus.lookX, battle.focus.lookY, battle.focus.lookZ);
      } else {
        // Fallback wide framing — not normally reached (beginRound always
        // sets a focus before the first frame renders), kept as a safe
        // default only. Drifts slowly like a satellite rather than sitting
        // at a fixed angle, same as teamBattle's own reset framing below.
        // See cameraOverrides.wild (the Camera Designer dev panel's "Save to
        // Game" for the Wild Battle slot) — radius/elevation/rotation speed
        // all fall back to the exact same hardcoded constants as before
        // whenever nothing's been saved, so this is byte-identical to the
        // original behavior until a player actually customizes it.
        const wildCamOverride = cameraOverrides.wild;
        const wildCamRadius = wildCamOverride?.radius ?? BATTLE_CAM_RADIUS;
        const wildCamBaseElevation = wildCamOverride?.elevation ?? BATTLE_CAM_ELEVATION;
        const wildCamAutoRotate = wildCamOverride?.autoRotate !== false;
        const wildCamRotateSpeed = wildCamAutoRotate ? (wildCamOverride?.rotateSpeed ?? RESET_CAM_ORBIT_SPEED) : 0;
        const wildCamElevationRotateSpeed = wildCamAutoRotate ? (wildCamOverride?.elevationRotateSpeed ?? 0) : 0;
        battle.camAngle += wildCamRotateSpeed * dt;
        const wildCamElevation = advanceOrbitElevation(battle, wildCamBaseElevation, wildCamElevationRotateSpeed, dt, MIN_ELEVATION, MAX_ELEVATION);
        camera.position.set(
          battle.midX + Math.sin(battle.camAngle) * Math.cos(wildCamElevation) * wildCamRadius,
          PAN_TARGET_Y + Math.sin(wildCamElevation) * wildCamRadius,
          battle.midZ + Math.cos(battle.camAngle) * Math.cos(wildCamElevation) * wildCamRadius,
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
        // angle, so the "everyone visible" shot doesn't read as frozen. See
        // cameraOverrides.team — same override/fallback shape as the wild
        // battle above, just defaulting to TEAM_CAM_RADIUS instead of
        // BATTLE_CAM_RADIUS (this battle type's own wider "everyone
        // visible" framing).
        const teamCamOverride = cameraOverrides.team;
        const teamCamRadius = teamCamOverride?.radius ?? TEAM_CAM_RADIUS;
        const teamCamBaseElevation = teamCamOverride?.elevation ?? BATTLE_CAM_ELEVATION;
        const teamCamAutoRotate = teamCamOverride?.autoRotate !== false;
        const teamCamRotateSpeed = teamCamAutoRotate ? (teamCamOverride?.rotateSpeed ?? RESET_CAM_ORBIT_SPEED) : 0;
        const teamCamElevationRotateSpeed = teamCamAutoRotate ? (teamCamOverride?.elevationRotateSpeed ?? 0) : 0;
        teamBattle.camAngle += teamCamRotateSpeed * dt;
        const teamCamElevation = advanceOrbitElevation(teamBattle, teamCamBaseElevation, teamCamElevationRotateSpeed, dt, MIN_ELEVATION, MAX_ELEVATION);
        camera.position.set(
          teamBattle.centerX + Math.sin(teamBattle.camAngle) * Math.cos(teamCamElevation) * teamCamRadius,
          PAN_TARGET_Y + Math.sin(teamCamElevation) * teamCamRadius,
          teamBattle.centerZ + Math.cos(teamBattle.camAngle) * Math.cos(teamCamElevation) * teamCamRadius,
        );
        camera.lookAt(teamBattle.centerX, PAN_TARGET_Y, teamBattle.centerZ);
      }
    } else if (pvpBattle) {
      // Same drifting wide-framing fallback the wild battle's own camera
      // uses when it has no per-turn focus target (see battle.camAngle
      // above) — PVP has no "camera follows whoever's declaring" concept
      // since both sides act simultaneously, so this is the only framing
      // it needs. See cameraOverrides.pvp — same override/fallback shape as
      // the wild/team battles above.
      const pvpCamOverride = cameraOverrides.pvp;
      const pvpCamRadius = pvpCamOverride?.radius ?? BATTLE_CAM_RADIUS;
      const pvpCamBaseElevation = pvpCamOverride?.elevation ?? BATTLE_CAM_ELEVATION;
      const pvpCamAutoRotate = pvpCamOverride?.autoRotate !== false;
      const pvpCamRotateSpeed = pvpCamAutoRotate ? (pvpCamOverride?.rotateSpeed ?? RESET_CAM_ORBIT_SPEED) : 0;
      const pvpCamElevationRotateSpeed = pvpCamAutoRotate ? (pvpCamOverride?.elevationRotateSpeed ?? 0) : 0;
      pvpBattle.camAngle += pvpCamRotateSpeed * dt;
      const pvpCamElevation = advanceOrbitElevation(pvpBattle, pvpCamBaseElevation, pvpCamElevationRotateSpeed, dt, MIN_ELEVATION, MAX_ELEVATION);
      camera.position.set(
        pvpBattle.midX + Math.sin(pvpBattle.camAngle) * Math.cos(pvpCamElevation) * pvpCamRadius,
        PAN_TARGET_Y + Math.sin(pvpCamElevation) * pvpCamRadius,
        pvpBattle.midZ + Math.cos(pvpBattle.camAngle) * Math.cos(pvpCamElevation) * pvpCamRadius,
      );
      camera.lookAt(pvpBattle.midX, PAN_TARGET_Y, pvpBattle.midZ);
      updateTownWallFade(dt, pvpBattle.centerX, PAN_TARGET_Y, pvpBattle.centerZ);
    } else {
      const followEase = Math.min(1, CAMERA_FOLLOW_LERP_SPEED * dt);
      followX += (local.x - followX) * followEase;
      followZ += (local.z - followZ) * followEase;
      // Eases toward whatever floor's Y the player is currently on, same
      // rate as followX/followZ above — 0 on the ground floor, so
      // followY + PAN_TARGET_Y === PAN_TARGET_Y and every line below is
      // byte-identical to this code's pre-tower behavior. PAN_TARGET_Y
      // itself stays a fixed "look slightly above the ground" fine-tune;
      // followY is purely the floor's own additive offset on top of it.
      followY += (local.y - followY) * followEase;
      camera.position.set(
        followX + Math.sin(camAngle) * Math.cos(camElevation) * zoomRadius,
        followY + PAN_TARGET_Y + Math.sin(camElevation) * zoomRadius,
        followZ + Math.cos(camAngle) * Math.cos(camElevation) * zoomRadius,
      );
      camera.lookAt(followX, followY + PAN_TARGET_Y, followZ);
      updateTownWallFade(dt);
    }

    scaleNameLabel(local.rig, camera, lastHeight || canvas.height, true);
    // Every stationary NPC/peer name label (and Rodz's own shout bubble,
    // Jared's shop sign — see updateAreaLabels) is gated on BOTH being in
    // the same walled area (getAreaKey) AND, for Town specifically, the
    // same floor — without the area half of this, standing right outside
    // e.g. Karirs Field's wall (a totally different building, but still
    // within LABEL_VISIBLE_DISTANCE of Karra) still showed her label
    // straight through the wall, since every label/sign sprite in this file
    // is depthTest:false (see getAreaKey's own comment) and so is never
    // occluded by wall/floor geometry the normal way. Rodz/Karra/Jared/
    // Boss Rick/Stockfish all stand at ground level (y=0 — see their own
    // group.position.set calls above); Usher alone stands up on the cinema
    // floor itself (see cinemaUsherRig's own floorY placement in buildTown),
    // hence the opposite floor check for just that one.
    const localAreaKey = getAreaKey(local.x, local.z);
    const inTownGroundFloor = localAreaKey === "town" && local.currentFloor === 0;
    scaleNameLabel(rodzRig, camera, lastHeight || canvas.height, inTownGroundFloor && Math.hypot(local.x - RODZ_X, local.z - RODZ_Z) <= LABEL_VISIBLE_DISTANCE);
    scaleNameLabel(karraRig, camera, lastHeight || canvas.height, localAreaKey === "karirs" && Math.hypot(local.x - KARRA_X, local.z - KARRA_Z) <= LABEL_VISIBLE_DISTANCE);
    scaleNameLabel(jaredRig, camera, lastHeight || canvas.height, inTownGroundFloor && Math.hypot(local.x - JARED_X, local.z - JARED_Z) <= LABEL_VISIBLE_DISTANCE);
    scaleNameLabel(bossRickRig, camera, lastHeight || canvas.height, localAreaKey === "luba" && Math.hypot(local.x - BOSS_RICK_X, local.z - BOSS_RICK_Z) <= LABEL_VISIBLE_DISTANCE);
    scaleNameLabel(usherRig, camera, lastHeight || canvas.height, localAreaKey === "town" && local.currentFloor === CINEMA_SCREEN_FLOOR_INDEX && Math.hypot(local.x - USHER_X, local.z - USHER_Z) <= LABEL_VISIBLE_DISTANCE);
    scaleNameLabel(stockfishRig, camera, lastHeight || canvas.height, localAreaKey === "tambayan" && Math.hypot(local.x - STOCKFISH_X, local.z - STOCKFISH_Z) <= LABEL_VISIBLE_DISTANCE);
    for (const peer of peers.values()) {
      // Same area+floor guard as updateChatBubble's own sameArea/entityFloor
      // checks just above — name labels are already a child of
      // peer.rig.group (see buildBlockyCharacter's own group.add(nameLabel)),
      // so setPeerHidden's group.visible=false during the per-frame peer
      // loop normally cascades to hide this too, but that's an indirect
      // side effect of the battle-dome/floor hide logic, not something
      // scaleNameLabel itself checks — asserted explicitly here too, same
      // defensive belt-and-braces reasoning as the rest of this frame's own
      // visibility checks.
      const peerVisible =
        getAreaKey(peer.x, peer.z) === localAreaKey &&
        peer.floor === local.currentFloor &&
        Math.hypot(local.x - peer.x, local.z - peer.z) <= LABEL_VISIBLE_DISTANCE;
      scaleNameLabel(peer.rig, camera, lastHeight || canvas.height, peerVisible);
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
    // Spectated battles aren't part of the if/else chain above — unlike
    // battle/teamBattle/pvpBattle (mutually exclusive, at most one of MY
    // OWN fights runs at a time), this client can simultaneously be
    // spectating any number of OTHER players' wild battles, including one
    // while it's off fighting its own.
    for (const entry of peerBattles.values()) {
      for (const memberRig of entry.memberRigs) scaleNameLabel(memberRig.rig, camera, lastHeight || canvas.height);
      scaleNameLabel(entry.wildRig, camera, lastHeight || canvas.height);
    }

    updateSkyFollowCamera(skyDome, sunSprite, camera);
    renderer.render(scene, camera);

    // Cinema screen visibility — mirrors applyGlophicsFloorCutaway's own
    // "opaque once index <= currentFloor" rule (index > currentFloor is the
    // transparent/hidden case there) rather than hardcoding
    // `currentFloor === 1`, so this stays correct without changes if a
    // future floor 3 is ever added above floor 2. Also hidden during any of
    // the three battle types, which overlay this same canvas/camera with
    // their own scene content — the CSS3D layer would otherwise float on
    // top of a battle scene nonsensically. "Hidden" means actually not
    // rendering/showing the DOM layer at all (style.display = "none", and
    // the .render() call below is skipped outright) — but display:none
    // alone was found to NOT reliably stop YouTube's own player from
    // continuing to decode/play in the background inside this specific
    // webview (flagged as a real resource drain — the video would keep
    // running the entire time this game panel is mounted, not just while
    // on floor 2), so an explicit pauseVideo/playVideo postMessage command
    // (see sendCinemaScreenCommand) is sent at the same transition, the
    // actual documented way to control a YouTube embed's playback state
    // rather than relying on a browser DOM-visibility side effect for it.
    // Also requires isInsideGlophicsFootprint — currentFloor alone isn't
    // enough. The screen is a CSS3DObject (see cssRenderer/cssScene above),
    // which never respects the WebGL depth buffer, so if currentFloor ever
    // stayed at CINEMA_SCREEN_FLOOR_INDEX while the player's real X/Z was
    // outside the tower (e.g. a battle's own end-of-fight relocation not
    // reconciling floor state the way the stairs' own goToGlophicsFloor
    // always does), the screen would show straight through the back wall
    // from outside — no geometry could ever occlude it either way. Same
    // defensive belt-and-braces reasoning as updateGlophicsExteriorCutaway's
    // own identical footprint check just above.
    const cinemaScreenVisible =
      local.currentFloor >= CINEMA_SCREEN_FLOOR_INDEX &&
      isInsideGlophicsFootprint(local.x, local.z) &&
      !battle &&
      !teamBattle &&
      !pvpBattle;
    if (cinemaScreenVisible !== cinemaScreenShown) {
      cinemaScreenShown = cinemaScreenVisible;
      cssRenderer.domElement.style.display = cinemaScreenShown ? "" : "none";
      // Only meaningful for an actual YouTube embed — since the
      // projectionist can now point this at any http(s) URL (see
      // USHER_NAME's own section), a non-YouTube page has no obligation to
      // implement (or even ignore harmlessly) this postMessage protocol, so
      // it's simply never sent for one.
      if (isYoutubeEmbedUrl(cinemaScreenUrl)) {
        sendCinemaScreenCommand(cinemaScreen.iframe, cinemaScreenShown ? "playVideo" : "pauseVideo");
      }
    }
    if (cinemaScreenShown) cssRenderer.render(cssScene, camera);

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
    hidePoseDesignerModal(); // same reasoning again
    socket.dispose();
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("mousedown", onMouseDown);
    canvas.removeEventListener("click", onCanvasClick);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    teamBattleButton.removeEventListener("click", startTeamBattle);
    disposeRig(local.rig);
    disposeRig(rodzRig);
    disposeRig(karraRig);
    disposeRig(jaredRig);
    disposeRig(bossRickRig);
    disposeRig(usherRig);
    disposeRig(stockfishRig);
    karirsBoard.texture.dispose();
    karirsBoard.sprite.material.dispose();
    hideRodzShoutBubble();
    if (local.chatBubble) disposeChatBubble(local.chatBubble);
    // Before removePeer below — teardownSpectatorBattleEntry does its own
    // defensive peers.get() lookup, but disposing each spectated battle's
    // own dome/rigs while the peer it belongs to still exists is cleaner
    // than leaving it for whatever order Map iteration below happens to hit.
    for (const userId of [...peerBattles.keys()]) teardownSpectatorBattleEntry(userId);
    for (const userId of [...peers.keys()]) removePeer(userId);
    for (const id of [...wildSpawns.keys()]) removeWildSpawn(id);
    renderer.dispose();
    // Blank the iframe's own src BEFORE removing it — removal alone doesn't
    // reliably stop an already-loaded YouTube player from continuing to
    // play audio in some browsers, but clearing src first does (this is the
    // important part of this cleanup, not just tidiness — a background
    // Glophimon tab should never keep playing music after the player has
    // left it entirely).
    cinemaScreen.iframe.src = "";
    cssRenderer.domElement.remove();
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

// The Pose Designer dev tool's own controllable joints. "axis" x/y/z means
// rig[part].rotation.x/y/z; posY means rig[part].position.y (only ever
// "visual", for the whole-body crouch/jump height every real pose already
// uses that same way).
//
// Lean (forward/back and sideways) and head movement are rotations of
// "visual"/"head" around their own local origin — pivoting the whole body
// from the feet, or the whole head from the neck — not a position offset.
// The very first version of "Body Lean" moved visual.position.z instead
// (a straight-line shift, same trick applyAttackPose's own lunge uses),
// which read as nothing happening: a translation along the camera's own
// view axis barely changes the silhouette, unlike an actual tilt.
const POSE_DESIGNER_PARTS = [
  // ±3.3 rad (~189°) rather than stopping at ±2.2 (~126°, short of even
  // horizontal-behind) — a hanging arm is 0, so it takes a full ±π (~3.14)
  // to swing all the way up to pointing straight overhead; the extra bit
  // past π is just a little headroom past dead-vertical, confirmed
  // visually rather than assumed.
  { key: "leftArmX", label: "L Arm Swing", part: "leftArm", axis: "x", min: -3.3, max: 3.3, step: 0.05 },
  { key: "leftArmZ", label: "L Arm Spread", part: "leftArm", axis: "z", min: -1.6, max: 1.6, step: 0.05 },
  { key: "rightArmX", label: "R Arm Swing", part: "rightArm", axis: "x", min: -3.3, max: 3.3, step: 0.05 },
  { key: "rightArmZ", label: "R Arm Spread", part: "rightArm", axis: "z", min: -1.6, max: 1.6, step: 0.05 },
  { key: "leftLegX", label: "L Leg Swing", part: "leftLeg", axis: "x", min: -1.6, max: 1.6, step: 0.05 },
  { key: "leftLegZ", label: "L Leg Spread", part: "leftLeg", axis: "z", min: -1.2, max: 1.2, step: 0.05 },
  { key: "rightLegX", label: "R Leg Swing", part: "rightLeg", axis: "x", min: -1.6, max: 1.6, step: 0.05 },
  { key: "rightLegZ", label: "R Leg Spread", part: "rightLeg", axis: "z", min: -1.2, max: 1.2, step: 0.05 },
  { key: "bodyY", label: "Body Height", part: "visual", axis: "posY", min: -0.3, max: 0.5, step: 0.01 },
  // Actually moving the whole body (a straight-line step/lunge), distinct
  // from the Lean sliders just below (which tilt/pivot from the feet in
  // place) — the two combine for things a lean alone can't do, e.g. a real
  // sidestep or a forward lunge that also carries the feet with it.
  { key: "bodyMoveForward", label: "Move Forward/Back", part: "visual", axis: "posZ", min: -0.6, max: 0.6, step: 0.02 },
  { key: "bodyMoveSide", label: "Move Sideways", part: "visual", axis: "posX", min: -0.6, max: 0.6, step: 0.02 },
  { key: "bodyLeanForward", label: "Lean Forward/Back", part: "visual", axis: "x", min: -0.6, max: 0.6, step: 0.02 },
  { key: "bodyLeanSide", label: "Lean Sideways", part: "visual", axis: "z", min: -0.6, max: 0.6, step: 0.02 },
  // Yaw — twisting the whole body (torso, arms, legs together) around the
  // vertical axis, independent of both Lean (which tilts it, rotation.x/z)
  // and the character's actual movement-facing (group.rotation.y, driven by
  // input direction, untouched by anything in this designer). Full ±π so
  // any orientation is reachable directly by the slider without wrapping.
  { key: "bodyRotation", label: "Body Rotation", part: "visual", axis: "y", min: -3.14, max: 3.14, step: 0.02 },
  { key: "headTurn", label: "Head Turn", part: "head", axis: "y", min: -1.0, max: 1.0, step: 0.02 },
  { key: "headNod", label: "Head Nod", part: "head", axis: "x", min: -0.6, max: 0.6, step: 0.02 },
  { key: "headTilt", label: "Head Tilt", part: "head", axis: "z", min: -0.6, max: 0.6, step: 0.02 },
];

function poseDesignerDefaultValues() {
  const values = {};
  for (const spec of POSE_DESIGNER_PARTS) values[spec.key] = 0;
  return values;
}

// Writes one full set of Pose Designer values onto a rig — shared by the
// live (slider-driven) preview and keyframe-playback preview below, so the
// two can never render a pose differently from how it was authored.
function applyPoseDesignerValues(rig, values) {
  for (const spec of POSE_DESIGNER_PARTS) {
    const obj = rig[spec.part];
    const v = values[spec.key] ?? 0;
    if (spec.axis === "x") obj.rotation.x = v;
    else if (spec.axis === "y") obj.rotation.y = v;
    else if (spec.axis === "z") obj.rotation.z = v;
    else if (spec.axis === "posX") obj.position.x = v;
    else if (spec.axis === "posY") obj.position.y = v;
    else if (spec.axis === "posZ") obj.position.z = v;
  }
}

// Blends between consecutive keyframes and applies the result to rig —
// elapsedMs is caller-tracked (not stored here), so this same function
// drives both the Pose Designer's own preview (see poseDesignerFrame) and,
// via tryPlayOverride below, a saved override's real, permanent use in the
// live game — the two can never render a saved pose differently. Returns
// false (and touches nothing) for an empty/missing keyframe list, so
// callers can fall through to the built-in procedural pose.
function playPoseKeyframes(rig, keyframes, elapsedMs) {
  if (!keyframes || keyframes.length === 0) return false;
  const totalMs = keyframes.reduce((sum, kf) => sum + Math.max(1, kf.transitionMs), 0);
  const t = elapsedMs % totalMs;
  let prevValues = keyframes[keyframes.length - 1].values; // wraps: last -> first
  let acc = 0;
  let segmentIdx = keyframes.length - 1;
  for (let i = 0; i < keyframes.length; i++) {
    const dur = Math.max(1, keyframes[i].transitionMs);
    if (t < acc + dur) {
      segmentIdx = i;
      break;
    }
    acc += dur;
    prevValues = keyframes[i].values;
  }
  const dur = Math.max(1, keyframes[segmentIdx].transitionMs);
  const localT = Math.min(1, (t - acc) / dur);
  const toValues = keyframes[segmentIdx].values;
  const blended = {};
  for (const spec of POSE_DESIGNER_PARTS) {
    const a = prevValues[spec.key] ?? 0;
    const b = toValues[spec.key] ?? 0;
    blended[spec.key] = a + (b - a) * localT;
  }
  applyPoseDesignerValues(rig, blended);
  return true;
}

// The inverse of applyPoseDesignerValues — reads whatever a rig's joints
// currently hold back out into POSE_DESIGNER_PARTS' own {key: value} shape.
// Only ever used by sampleBuiltinPoseKeyframes below, to snapshot a
// throwaway rig after running a *real* pose function on it, rather than
// hand-guessing values that would inevitably drift from the real thing.
function readPoseDesignerValues(rig) {
  const values = {};
  for (const spec of POSE_DESIGNER_PARTS) {
    const obj = rig[spec.part];
    if (spec.axis === "x") values[spec.key] = obj.rotation.x;
    else if (spec.axis === "y") values[spec.key] = obj.rotation.y;
    else if (spec.axis === "z") values[spec.key] = obj.rotation.z;
    else if (spec.axis === "posX") values[spec.key] = obj.position.x;
    else if (spec.axis === "posY") values[spec.key] = obj.position.y;
    else if (spec.axis === "posZ") values[spec.key] = obj.position.z;
  }
  return values;
}

// "Recreate" one of the 6 built-in procedural poses as an editable keyframe
// sequence, by actually *running* the real pose function(s) on a scratch
// rig (never added to any scene) and reading back the result — a faithful
// sample, not a hand-guessed approximation that could silently drift from
// what the built-in pose really does. Lets the Pose Designer offer "start
// from the real thing" instead of only ever a blank slate for a slot with
// no custom override saved yet.
//
// Idle/Ready settle toward a fixed target via easeTo (see character.js) —
// a huge dt (100) makes easeTo's own min(1, rate*dt) clamp jump straight to
// that target in one call, so a single keyframe holding it is an exact
// sample, not an approximation. Walk is a genuine phase-driven cycle with
// no fixed duration of its own, so it's sampled at 8 evenly-spaced points
// around one full phase revolution (with walkBlend pinned to 1 — fully
// blended into the cycle, not still easing in from idle) and looped over an
// arbitrarily chosen 800ms — the original real-time speed doesn't carry
// over, but the shape of the gait does, since keyframe playback is its own
// separate system from here on. Attack/Defend/Cast already have a real
// fixed envelope duration (see ATTACK_ANIM_MS etc.), so those are sampled
// directly across their own actual timeline.
function sampleBuiltinPoseKeyframes(poseName) {
  const scratchRig = buildBlockyCharacter({ head: "#ffffff", body: "#ffffff", arm: "#ffffff", leg: "#ffffff" }, null);
  let keyframes = [];
  if (poseName === "idle") {
    applyIdlePose(scratchRig, 100);
    keyframes = [{ values: readPoseDesignerValues(scratchRig), transitionMs: 500 }];
  } else if (poseName === "ready") {
    applyReadyPose(scratchRig, 100);
    keyframes = [{ values: readPoseDesignerValues(scratchRig), transitionMs: 500 }];
  } else if (poseName === "walk") {
    const STEPS = 8;
    const CYCLE_MS = 800;
    for (let i = 0; i < STEPS; i++) {
      scratchRig.walkPhase = (i / STEPS) * Math.PI * 2;
      scratchRig.walkBlend = 1;
      updateWalkCycle(scratchRig, 0, 1); // dt=0 — samples this exact phase, advances nothing
      keyframes.push({ values: readPoseDesignerValues(scratchRig), transitionMs: CYCLE_MS / STEPS });
    }
  } else {
    const fn = poseName === "attack" ? applyAttackPose : poseName === "cast" ? applyCastPose : applyDefendPose;
    const totalMs = poseName === "attack" ? ATTACK_ANIM_MS : poseName === "cast" ? CAST_ANIM_MS : DEFEND_ANIM_MS;
    const STEPS = 6;
    for (let i = 0; i <= STEPS; i++) {
      fn(scratchRig, (i / STEPS) * totalMs, totalMs);
      keyframes.push({ values: readPoseDesignerValues(scratchRig), transitionMs: Math.max(1, Math.round(totalMs / STEPS)) });
    }
  }
  disposeRig(scratchRig);
  return keyframes;
}

// Camera Designer — every slot the dev panel offers, each tagged with which
// of the 2 shapes/UIs it uses (see CAMERA_DESIGNER_FIELDS/CAMERA_FOCUS_FIELDS
// below and mount()'s own slot-select "change" handler, which swaps the
// rendered sliders based on this): kind:"orbit" is the original reset/orbit
// camera (radius/pitch/starting angle/auto-rotate/rotation speed) — "wild"
// here stays exactly as it always was, unchanged in meaning/id, so an
// already-saved override isn't orphaned. kind:"focus" is new — one of the
// wild battle's own 4 independently-tunable focus-camera re-aim moments
// (see focusWildCameraOnRig/resolveWildFocusParams), never the 3v3 team
// battle's near-identical (and deliberately untouched) focusCameraOnMember.
// Enforced again server-side (see the api's own ORBIT_CAMERA_SLOTS/
// FOCUS_CAMERA_SLOTS) so a stray request can't wedge in an arbitrary key.
const CAMERA_OVERRIDE_SLOTS = [
  { id: "wild", label: "Wild: Reset / Orbit", kind: "orbit" },
  { id: "team", label: "Team Battle (3v3)", kind: "orbit" },
  { id: "pvp", label: "PvP Battle", kind: "orbit" },
  { id: "wild_decide_defend", label: "Wild: Decide Defend", kind: "focus" },
  { id: "wild_declare", label: "Wild: About to Attack", kind: "focus" },
  { id: "wild_attack_scene", label: "Wild: Attack Scene", kind: "focus" },
  { id: "wild_defend_scene", label: "Wild: Defend Scene", kind: "focus" },
];

// The reset/orbit camera's own tunable shape (radius, pitch, starting
// angle, whether it auto-rotates, and how fast) for every kind:"orbit" slot
// above. Explicitly NOT the focus camera (see CAMERA_FOCUS_FIELDS below for
// that); this only ever touches the wide "nothing focused" fallback framing
// every battle type falls back to. min/max mirror the same real bounds the
// per-frame battle code already clamps elevation to (MIN_ELEVATION/
// MAX_ELEVATION) so a saved override can never produce an orientation the
// game wouldn't otherwise allow.
const CAMERA_DESIGNER_FIELDS = [
  { key: "radius", label: "Distance", min: 2, max: 20, step: 0.5 },
  { key: "elevation", label: "Pitch", min: MIN_ELEVATION, max: MAX_ELEVATION, step: 0.01 },
  { key: "angle", label: "Starting Angle", min: 0, max: Math.PI * 2, step: 0.01 },
  { key: "rotateSpeed", label: "Rotation Speed (Y axis)", min: 0, max: 1.0, step: 0.01 },
  // Y-axis rotation (rotateSpeed above) is a full 360° orbit — it wraps for
  // free via sin/cos periodicity, so it can spin forever in one direction.
  // Pitch can't do that without eventually flipping the camera upside
  // down, so this is a bounce between MIN_ELEVATION/MAX_ELEVATION instead
  // of a spin (see advanceOrbitElevation) — a slow crane-up-crane-down
  // sweep rather than a loop. 0 (the default) means "don't move," same
  // "byte-identical until customized" contract every other field here
  // already follows.
  { key: "elevationRotateSpeed", label: "Rotation Speed (X axis)", min: 0, max: 0.5, step: 0.01 },
];

// The wild battle's own focus camera's tunable shape, for every
// kind:"focus" slot above — see TEAM_FOCUS_CAM_BEHIND/HEIGHT/LOOK_Y/
// LOOK_AHEAD for the shared constants these ranges are centered on, and
// resolveWildFocusParams for how a saved override here actually gets read
// at battle time. angle/rotateSpeed/heightRotateSpeed (new) give a focus
// shot the same orbit-around-the-subject capability the 3 orbit slots
// already have — angle is a static "start here" offset from today's
// default "directly behind" placement (0 reproduces that exact placement —
// see computeFocusCameraFrame's own theta parameter), rotateSpeed spins it
// around the anchor rig on the Y axis (free-spinning, no bounds needed —
// same reasoning as the orbit slots' own rotateSpeed), and
// heightRotateSpeed bounces the camera's own height between this field's
// own min/max (FOCUS_CAM_HEIGHT_MIN/MAX) the same way the orbit slots'
// elevationRotateSpeed bounces pitch between MIN_ELEVATION/MAX_ELEVATION
// (see advanceOrbitElevation, generalized to take explicit bounds so both
// use the one function). autoRotate gates all of it, same as the orbit
// slots — see the slot-select "change" handler, which used to force-hide
// that whole control for a focus slot and no longer does.
const CAMERA_FOCUS_FIELDS = [
  { key: "behind", label: "Distance Behind", min: 0.3, max: 3, step: 0.05 },
  { key: "height", label: "Height", min: FOCUS_CAM_HEIGHT_MIN, max: FOCUS_CAM_HEIGHT_MAX, step: 0.05 },
  { key: "lookY", label: "Look-At Height", min: -1, max: 2, step: 0.05 },
  { key: "lookAhead", label: "Look-Ahead Distance", min: 0, max: 8, step: 0.1 },
  { key: "angle", label: "Orbit Angle", min: 0, max: Math.PI * 2, step: 0.01 },
  { key: "rotateSpeed", label: "Rotation Speed (Y axis)", min: 0, max: 1.0, step: 0.01 },
  { key: "heightRotateSpeed", label: "Rotation Speed (Height)", min: 0, max: 0.5, step: 0.01 },
];

// Defaults reproduce TODAY's hardcoded behavior exactly — a player who never
// opens the Camera Designer sees zero change, since a slot with no saved
// override falls back to these same constants either way.
function cameraDesignerDefaultValues(slotId) {
  const slot = CAMERA_OVERRIDE_SLOTS.find((s) => s.id === slotId);
  if (slot && slot.kind === "focus") {
    // All 4 focus slots share the exact same default shape — the shared
    // TEAM_FOCUS_CAM_* constants every one of them falls back to today,
    // before any of them has ever been individually customized.
    // rotateSpeed/heightRotateSpeed default to 0 ("off") rather than the
    // orbit slots' own RESET_CAM_ORBIT_SPEED-and-on default — a focus shot
    // never rotated at all before this, so "off until customized" is the
    // byte-identical baseline here, same principle as the orbit slots' own
    // elevationRotateSpeed defaulting to 0.
    return {
      behind: TEAM_FOCUS_CAM_BEHIND,
      height: TEAM_FOCUS_CAM_HEIGHT,
      lookY: TEAM_FOCUS_CAM_LOOK_Y,
      lookAhead: TEAM_FOCUS_CAM_LOOK_AHEAD,
      angle: 0,
      autoRotate: true,
      rotateSpeed: 0,
      heightRotateSpeed: 0,
    };
  }
  // kind:"orbit" (or an unrecognized/blank slotId, which the slot-select's
  // own "(pick a battle type below)" placeholder can produce) — only the
  // team (3v3) slot differs among these, since that battle type already
  // used its own wider TEAM_CAM_RADIUS instead of BATTLE_CAM_RADIUS.
  return {
    radius: slotId === "team" ? TEAM_CAM_RADIUS : BATTLE_CAM_RADIUS,
    elevation: BATTLE_CAM_ELEVATION,
    angle: 0,
    autoRotate: true,
    rotateSpeed: RESET_CAM_ORBIT_SPEED,
    elevationRotateSpeed: 0, // off by default — today's exact behavior (a fixed pitch) until a player turns it up
  };
}

// Y-axis (heading) counterpart is a plain `angle += speed * dt` — it never
// needs bounds-checking since sin/cos already wrap it for free every full
// turn. Pitch has a real valid range (MIN_ELEVATION/MAX_ELEVATION for the 3
// orbit slots) a camera can't cross without flipping upside down, so this
// bounces back and forth between explicit `min`/`max` bounds instead of a
// free spin — `state` is the battle/teamBattle/pvpBattle object itself (or,
// for a focus slot's own height-bounce, that slot's own
// battle.focusOrbitState[slotId] entry — see advanceFocusOrbit), so
// camElevation/camElevationDir persist across frames the same way
// state.camAngle already does. `min`/`max` are explicit parameters (rather
// than this function hardcoding MIN_ELEVATION/MAX_ELEVATION itself) so the
// exact same bounce logic can also drive a focus shot's height bounce
// between FOCUS_CAM_HEIGHT_MIN/MAX, instead of a second near-duplicate copy
// of this function existing just to use different bounds. Snaps back to
// the slider's own static `baseElevation` the instant rotation is turned
// off (speed <= 0), so disabling it doesn't leave the camera stranded
// wherever the bounce last left it.
function advanceOrbitElevation(state, baseElevation, rotateSpeed, dt, min, max) {
  if (rotateSpeed <= 0) {
    state.camElevation = baseElevation;
    state.camElevationDir = 1;
    return state.camElevation;
  }
  if (state.camElevation == null) state.camElevation = baseElevation;
  if (!state.camElevationDir) state.camElevationDir = 1;
  state.camElevation += state.camElevationDir * rotateSpeed * dt;
  if (state.camElevation >= max) {
    state.camElevation = max;
    state.camElevationDir = -1;
  } else if (state.camElevation <= min) {
    state.camElevation = min;
    state.camElevationDir = 1;
  }
  return state.camElevation;
}

const PREVIEW_TARGET_Y = 0.9; // roughly chest height, so the orbit centers the character in frame rather than its feet
const PREVIEW_MIN_RADIUS = 1.4;
const PREVIEW_MAX_RADIUS = 5;
const PREVIEW_DEFAULT_RADIUS = 2.4;
const PREVIEW_DEFAULT_ELEVATION = 0.35;
const PREVIEW_MIN_ELEVATION = -0.4;
const PREVIEW_MAX_ELEVATION = 1.3;
// Camera Designer only (options.battleScenePreview below) — a "wild" rig
// and a "your side" rig placed symmetrically around the origin so the
// origin itself is their midpoint, matching how the real per-battle reset
// camera always orbits/looks at a battle's own centerX/centerZ without
// this preview needing to invent a separate center concept of its own.
// Distances are shorter than the real BATTLE_WILD_OFFSET/
// BATTLE_PLAYER_MON_OFFSET (this 320x240 preview canvas is much smaller
// than the real battle viewport) — picked purely so both rigs read clearly
// at the Camera Designer's own default radius/elevation.
const PREVIEW_BATTLE_WILD_Z = 1.6;
const PREVIEW_BATTLE_PLAYER_Z = -1.2;

// Character-creation preview — a small standalone rotate-to-inspect view of
// the current color choices, live-updated as the player edits them (see
// setColors below, called from chat.js's own color-input listeners).
// Deliberately not the full mount() above: no network socket, no movement,
// no name label — just one character, always rotatable (no separate Auto/
// Manual toggle, unlike the real world view, since orbiting is this view's
// entire purpose) so every angle can be checked before committing (colors
// can never be changed again once created — see the game's own plan).
export function mountPreview(el, initialColors, options = {}) {
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
  // Camera Designer only (options.battleScenePreview) — builds a tiny
  // randomized "battle" (a wild-side rig + a your-side rig, see
  // PREVIEW_BATTLE_WILD_Z/PREVIEW_BATTLE_PLAYER_Z above) instead of the
  // single centered character every other caller (character creation, the
  // starter picker, Character Movements, the Pose Designer) still gets —
  // species are random since this is purely a stand-in for "something
  // battle-shaped to frame the camera against," not a real fight. `rig`
  // stays a single real rig (the "your side" one) so setColors/setPose/
  // setCustomPose/showFrontMarker below keep working exactly as before for
  // every other caller; `extraRigs` holds anything beyond that one, given
  // the same idle treatment each frame and disposed the same way.
  const extraRigs = [];
  let rig;
  if (options.battleScenePreview) {
    const wildSpecies = pickRandomSpeciesByRarity();
    const wildRig = buildBlockyCharacter(
      { head: wildSpecies.head_color, body: wildSpecies.body_color, arm: wildSpecies.arm_color, leg: wildSpecies.leg_color },
      wildSpecies.name,
    );
    wildRig.group.position.set(0, 0, PREVIEW_BATTLE_WILD_Z);
    wildRig.group.rotation.y = Math.PI; // facing back toward the player side — same convention startWildBattle's own wildRig uses
    scene.add(wildRig.group);
    extraRigs.push(wildRig);

    const playerSpecies = pickRandomSpeciesByRarity();
    rig = buildBlockyCharacter(
      { head: playerSpecies.head_color, body: playerSpecies.body_color, arm: playerSpecies.arm_color, leg: playerSpecies.leg_color },
      playerSpecies.name,
    );
    rig.group.position.set(0, 0, PREVIEW_BATTLE_PLAYER_Z);
    scene.add(rig.group);
  } else {
    rig = buildBlockyCharacter(initialColors, null);
    scene.add(rig.group);
  }
  // Opt-in only — the Pose Designer is the one place this actually matters
  // (you're constantly orbiting the camera while posing and need to tell
  // front from back); character creation/the starter picker/Character
  // Movements never asked for it, so they're unaffected. Both markers, not
  // just the front smiley — Body Rotation turns the head right along with
  // the rest of the body, so the smiley alone could end up facing away
  // from the camera with nothing telling you it's now on the far side.
  if (options.showFrontMarker) {
    rig.head.add(buildFaceMarker());
    rig.head.add(buildBackMarker());
  }

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

  // Which pose this preview plays — defaults to idle (character creation/
  // starter picker never call setPose, so they're unaffected by any of
  // this). Unused in glophiworld now that the Character Movements dev
  // panel is gone (superseded by the Pose Designer's own setCustomPose
  // below) — kept rather than ripped out since it's a harmless, generic
  // capability of this shared preview helper, not something broken.
  let currentPose = "idle";
  let poseElapsedMs = 0;
  // Only ever set via setCustomPose (the Pose Designer dev panel) — a
  // per-frame callback given full control of the rig instead of one of the
  // named poses below, so the designer can drive it from live sliders or
  // its own keyframe playback using this exact same preview/camera/orbit.
  let customPoseFn = null;
  // A brief hold at rest between loops of a fixed-envelope pose (Attack/
  // Defend/Cast) — without it, the animation would restart mid-swing the
  // instant it completes, reading as a stutter rather than a held finish.
  const POSE_LOOP_PAUSE_MS = 400;

  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;
    poseElapsedMs += dt * 1000;

    if (currentPose === "walk") {
      updateWalkCycle(rig, dt);
    } else if (currentPose === "ready") {
      applyReadyPose(rig, dt);
    } else if (currentPose === "attack" || currentPose === "defend" || currentPose === "cast") {
      const totalMs = currentPose === "attack" ? ATTACK_ANIM_MS : currentPose === "cast" ? CAST_ANIM_MS : DEFEND_ANIM_MS;
      const loopElapsedMs = poseElapsedMs % (totalMs + POSE_LOOP_PAUSE_MS);
      const clamped = Math.min(loopElapsedMs, totalMs);
      if (currentPose === "attack") applyAttackPose(rig, clamped, totalMs);
      else if (currentPose === "cast") applyCastPose(rig, clamped, totalMs);
      else applyDefendPose(rig, clamped, totalMs);
    } else if (currentPose === "custom") {
      customPoseFn?.(rig, dt);
    } else {
      applyIdlePose(rig, dt); // a light idle bob so the preview doesn't look frozen, same as the real world view's own idle characters
    }
    // The battle-scene preview's extra "wild" rig (see options.battleScenePreview
    // above) never switches pose with `rig` — nothing here declares moves or
    // attacks, it's just a stand-in body for the camera to frame, so a plain
    // idle bob is all it ever needs.
    for (const extraRig of extraRigs) applyIdlePose(extraRig, dt);

    const width = canvas.clientWidth || canvas.getBoundingClientRect().width;
    const height = canvas.clientHeight || canvas.getBoundingClientRect().height;
    if (width > 0 && height > 0 && (width !== lastWidth || height !== lastHeight)) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      lastWidth = width;
      lastHeight = height;
    }

    // Camera Designer only (see game.js's own cameraDesignerButton/
    // cameraDesignerDriver) — an optional external hook that takes over
    // this exact same orbit-camera/lookAt call entirely, so that panel can
    // drive the preview from its live slider values (radius/pitch/angle/
    // rotation speed) instead of mouse drag. Every other caller of
    // mountPreview (character creation, the starter picker, Character
    // Movements, the Pose Designer) never passes this, so they keep using
    // the drag/wheel-driven camAngle/camElevation/zoomRadius above,
    // completely unaffected.
    if (options.cameraDriver) {
      options.cameraDriver(camera, dt);
    } else {
      camera.position.set(
        Math.sin(camAngle) * Math.cos(camElevation) * zoomRadius,
        PREVIEW_TARGET_Y + Math.sin(camElevation) * zoomRadius,
        Math.cos(camAngle) * Math.cos(camElevation) * zoomRadius,
      );
      camera.lookAt(0, PREVIEW_TARGET_Y, 0);
    }

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
    for (const extraRig of extraRigs) disposeRig(extraRig);
    renderer.dispose();
  };

  return {
    setColors(colors) {
      recolorRig(rig, colors);
    },
    setPose(pose) {
      currentPose = pose;
      poseElapsedMs = 0; // restart a fixed-envelope pose from its beginning rather than mid-swing
      customPoseFn = null;
    },
    setCustomPose(fn) {
      currentPose = "custom";
      poseElapsedMs = 0;
      customPoseFn = fn;
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
window.CheddarGames["glophiworld"] = { mount, unmount, mountPreview };
