// Luba — Phase 2 (see /home/rev/.claude/plans/vast-whistling-umbrella.md):
// real multiplayer. Position/attack sync over a direct WebSocket to
// luba-api (bypassing the extension's action-relay entirely — see the
// plan's architecture decision), server-authoritative hit/parry/death
// resolution off client-reported blade positions (per the user's own
// confirmed choice over full server-side re-simulation), server-driven
// respawn. Local movement/camera/combo/dash mechanics are unchanged from
// Phase 1 — only the combat *resolution* and the presence of other
// players is new.
import * as THREE from "three";
import { buildArena, solidBlocks, PLAYER_HEIGHT } from "./arena.js";
import { createPlayerPhysics, stepPhysics, FALL_DEATH_Y } from "./physics.js";
import {
  buildPlayerRig,
  tryAttack,
  updatePlayerVisual,
  disposeRig,
  interruptToCooldown,
  getSwordWorldSamplePoints,
  startDeathFall,
  updateDeathFall,
  resetAfterRespawn,
  updateShieldVisual,
  ATTACK_COOLDOWN_MS,
  getHeadWorldPosition,
  hideHead,
} from "./player.js";
import { connectLubaSocket, NETWORK_TICK_MS } from "./net/lubaSocket.js";
import { spawnBloodSpray, spawnDashEffect, spawnSmokeCloud, spawnFlyingHead, spawnGoreFountain } from "./effects.js";

const CAMERA_DISTANCE = 2.7; // zoomed in further still (was 3.4, 4.3, originally 5.5) — closer, more readable combat framing
const CAMERA_DAMPING = 0.18;
// Added to pitchAngle only for the camera's own orbit position — without
// this, pitch=0 (the resting state) would put the camera dead level with
// the pivot, looking flat at the character's chest instead of the more
// typical slightly-above-looking-down third-person framing. Bumped up
// from 0.25 to sit the camera a bit higher.
const CAMERA_BASE_TILT = 0.42;
// Keyboard/button-driven camera turn rate — mouse-look (pointer lock) is
// a separate, not-yet-decided track (see the plan discussion); this is
// the guaranteed-to-work fallback either way.
const TURN_SPEED = 2.4; // rad/sec (yaw)
const PITCH_SPEED = 2.0; // rad/sec (keyboard up/down)
// Clamped short of straight up/down (±~90°) — a third-person orbit camera
// right at the poles is disorienting and prone to snapping/flipping.
const PITCH_MIN = -1.2;
const PITCH_MAX = 1.2;
const SPAWN = { x: 0, y: 6, z: 8 }; // dropped in from above so landing on the floor is visible/obvious
const PARRY_STUN_MS = 900; // must match games/luba/api/app/main.py's PARRY_STUN_S
// Knockback on a parry — a short, fixed-speed movement override in the
// pushed direction, the exact same mechanism the dash already uses (see
// its own comment below), just triggered by an incoming parry event
// instead of a keypress. Applied even though the player is also stunned
// during this window (see the frame loop) — the stun blocks *acting*
// (attacking/dashing), not being physically thrown back.
const PARRY_KNOCKBACK_SPEED = 9;
const PARRY_KNOCKBACK_DURATION_MS = 220;
// Dash: direction depends on current movement input at the moment it's
// pressed — whichever way you're currently moving (already
// facing-relative, same as normal strafing), or straight backward
// (relative to facing) if you're not moving at all. A short, fixed-speed
// burst rather than a velocity impulse — this project's movement model
// sets velocity directly from input every frame (no inertia/momentum at
// all), so an impulse would just get overwritten the very next frame;
// the dash instead locks out normal movement input for its duration and
// forces the chosen direction at DASH_SPEED.
const DASH_SPEED = 14;
const DASH_DURATION_MS = 180;
const DASH_COOLDOWN_MS = 1500;
// Smoke skill — a stationary cloud dropped at the caster's current spot.
// Client-side cooldown mirrors the server's own backstop (see
// games/luba/api/app/main.py's SMOKE_COOLDOWN_S); duration/radius here
// mirror what the server tells clients via the "smoke" broadcast, but
// the local player's own gating uses this constant directly rather than
// waiting on a round trip just to know when its own key can be pressed
// again.
const SMOKE_COOLDOWN_MS = 30000;
const SMOKE_RADIUS = 4.5;
const SMOKE_DURATION_MS = 6000; // mirrors main.py's SMOKE_DURATION_S — practice mode has no server to tell it this
// How fast a peer's rendered position/facing eases toward its latest
// network update — same exponential-approach technique used elsewhere in
// this project (PokeWorld's overlay, karirs' 3D scene) so peers glide
// between ~15Hz position ticks instead of visibly snapping tile-to-tile.
const PEER_EASE_RATE = 12;
const BLADE_HIT_RADIUS = 0.5; // must match main.py's HIT_RADIUS
// Horizontal distance a peer's reported position has to move between two
// network ticks to count as "moving" for the walk/run animation — a real
// walk at MOVE_SPEED (5 units/sec) covers ~0.3 units per NETWORK_TICK_MS
// (66ms), well above this; idle floating-point/network jitter is not.
const PEER_MOVE_THRESHOLD = 0.05;

function buildArenaMeshes(scene, arena) {
  const floorMat = new THREE.MeshStandardMaterial({ color: "#3f3f46" });
  const obstacleMat = new THREE.MeshStandardMaterial({ color: "#78350f" });
  for (const tile of arena.floorTiles) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(tile.w, tile.h, tile.d), floorMat);
    mesh.position.set(tile.x, tile.y, tile.z);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  for (const b of arena.obstacles) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), obstacleMat);
    mesh.position.set(b.x, b.y, b.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#0f172a");
  scene.fog = new THREE.Fog("#0f172a", 20, 45);

  scene.add(new THREE.AmbientLight("#ffffff", 0.55));
  const sun = new THREE.DirectionalLight("#e0e7ff", 0.9);
  sun.position.set(10, 16, 8);
  sun.castShadow = true;
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);

  const arena = buildArena();
  buildArenaMeshes(scene, arena);

  return { renderer, scene, camera, arena };
}

// Local-space input only — forward/back (W/S) and strafe left/right (A/D)
// are relative to wherever the camera is currently facing, never derived
// from movement direction itself (that was Phase 1's first cut; this is
// the "just like all FPS" rework). Facing changes via arrow keys/on-screen
// buttons (always available) or mouse-look while pointer-locked (toggled
// by KeyM — untested territory in a vscode webview, see the plan; if the
// browser/webview refuses requestPointerLock() or silently never fires
// "pointerlockchange", turning just falls back to keys/buttons only, no
// separate error handling needed for that case).
const MOUSE_SENSITIVITY = 0.0025; // rad per pixel of mouse movement while locked
const MOUSE_LOOK_KEY = "KeyM";
const DASH_KEYS = ["ShiftLeft", "ShiftRight"];
const STANDINGS_KEY = "Tab"; // held, not pressed once — see createInputState's `read()`
const SMOKE_KEY = "KeyF";

function createInputState(canvas, rotateButtonState, onPointerLockChange) {
  const pressed = new Set();
  let jumpQueued = false;
  let attackQueued = false;
  let dashQueued = false;
  let smokeQueued = false;
  let mouseDeltaX = 0;
  let mouseDeltaY = 0;
  // Without this, these listeners (necessarily on window/document, since
  // a canvas alone never sees a keydown) would react to every keystroke
  // in the whole webview — typing in the chat textbox, clicking lobby
  // buttons, anything — not just input meant for the game. Gate every
  // handler on the canvas actually having focus (native focus/blur, same
  // as any other focusable element), and drop any held keys the instant
  // focus leaves so a key doesn't stay "stuck" down after alt-tabbing
  // away mid-press.
  let canvasFocused = document.activeElement === canvas;
  function onFocus() {
    canvasFocused = true;
  }
  function onBlur() {
    canvasFocused = false;
    pressed.clear();
  }

  function keydown(e) {
    if (!canvasFocused) return;
    pressed.add(e.code);
    if (e.code === "Space") jumpQueued = true;
    if (e.code === "KeyJ") attackQueued = true;
    if (DASH_KEYS.includes(e.code)) dashQueued = true;
    if (e.code === SMOKE_KEY) smokeQueued = true;
    if (e.code === MOUSE_LOOK_KEY) {
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      else canvas.requestPointerLock();
    }
    // Space/arrows would otherwise scroll the page they're typed into,
    // and Tab would otherwise cycle focus away from the canvas entirely
    // (defeating the point of holding it) — only suppress any of that
    // while the canvas itself is the thing focused, never globally.
    if (e.code === "Space" || e.code.startsWith("Arrow") || e.code === STANDINGS_KEY) e.preventDefault();
  }
  function keyup(e) {
    pressed.delete(e.code);
  }
  function mousedown(e) {
    // Scoped to clicks actually on the canvas (or already pointer-locked
    // to it, where every mouse event implicitly targets it) — a click on
    // some other part of the panel shouldn't queue a sword swing.
    if (e.button === 0 && (e.target === canvas || document.pointerLockElement === canvas)) attackQueued = true;
  }
  function mousemove(e) {
    if (document.pointerLockElement !== canvas) return;
    mouseDeltaX += e.movementX || 0;
    mouseDeltaY += e.movementY || 0;
  }
  function pointerlockchange() {
    onPointerLockChange(document.pointerLockElement === canvas);
  }

  canvas.addEventListener("focus", onFocus);
  canvas.addEventListener("blur", onBlur);
  window.addEventListener("keydown", keydown);
  window.addEventListener("keyup", keyup);
  window.addEventListener("mousedown", mousedown);
  window.addEventListener("mousemove", mousemove);
  document.addEventListener("pointerlockchange", pointerlockchange);

  return {
    read() {
      let inputForward = 0;
      let inputStrafe = 0;
      if (pressed.has("KeyW")) inputForward += 1;
      if (pressed.has("KeyS")) inputForward -= 1;
      if (pressed.has("KeyD")) inputStrafe += 1;
      if (pressed.has("KeyA")) inputStrafe -= 1;

      // Signed to match mouse-look's already-correct direction (see
      // mouseTurnDelta below) — ArrowRight/right-button must turn the
      // same way moving the mouse right does.
      let turn = 0;
      if (pressed.has("ArrowLeft") || rotateButtonState.left) turn += 1;
      if (pressed.has("ArrowRight") || rotateButtonState.right) turn -= 1;

      let pitchTurn = 0;
      if (pressed.has("ArrowUp")) pitchTurn += 1;
      if (pressed.has("ArrowDown")) pitchTurn -= 1;

      // Already in radians (not a rate) — added directly to facingAngle/
      // pitchAngle, unlike `turn`/`pitchTurn` above which are rates scaled
      // by *_SPEED*dt. Negated: screen-space mouse deltas are the
      // opposite sign of the turn they should produce (moving the mouse
      // right should turn the view right, i.e. increase yaw the same
      // direction ArrowRight does — moving the mouse up should look up,
      // same direction ArrowUp does).
      const mouseTurnDelta = -mouseDeltaX * MOUSE_SENSITIVITY;
      const mousePitchDelta = -mouseDeltaY * MOUSE_SENSITIVITY;
      mouseDeltaX = 0;
      mouseDeltaY = 0;

      const jump = jumpQueued;
      const attack = attackQueued;
      const dash = dashQueued;
      const smoke = smokeQueued;
      const standingsHeld = pressed.has(STANDINGS_KEY);
      jumpQueued = false;
      attackQueued = false;
      dashQueued = false;
      smokeQueued = false;
      return { inputForward, inputStrafe, turn, pitchTurn, mouseTurnDelta, mousePitchDelta, jump, attack, dash, smoke, standingsHeld };
    },
    dispose() {
      canvas.removeEventListener("focus", onFocus);
      canvas.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("mousedown", mousedown);
      window.removeEventListener("mousemove", mousemove);
      document.removeEventListener("pointerlockchange", pointerlockchange);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    },
  };
}

// Two on-screen buttons for camera turning — the guaranteed-to-work
// "directional buttons" alternative discussed alongside a possible
// pointer-lock mouse-look mode (unresolved/untested — see the plan).
function buildTurnButtons() {
  const state = { left: false, right: false };
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.gap = "8px";
  wrap.style.marginTop = "6px";
  wrap.style.touchAction = "none";

  function makeButton(label, key) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.width = "48px";
    btn.style.height = "36px";
    btn.style.borderRadius = "4px";
    btn.style.border = "none";
    btn.style.background = "#262626";
    btn.style.color = "#fff";
    btn.style.userSelect = "none";
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      state[key] = true;
    });
    const release = () => {
      state[key] = false;
    };
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointerleave", release);
    btn.addEventListener("pointercancel", release);
    return btn;
  }

  wrap.appendChild(makeButton("◀", "left"));
  wrap.appendChild(makeButton("▶", "right"));
  return { el: wrap, state };
}

// Cooldown indicators for the sword and the smoke skill, shown just below
// the canvas — a small bar per skill that starts full the instant it's
// used and drains back to empty (and "Ready") as the cooldown elapses.
function buildCooldownHud() {
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.gap = "10px";
  wrap.style.marginTop = "6px";

  function makeBar(icon, label) {
    const box = document.createElement("div");
    box.style.flex = "1";
    box.style.minWidth = "0";

    const labelEl = document.createElement("div");
    labelEl.style.fontSize = "10px";
    labelEl.style.color = "#a3a3a3";
    labelEl.style.marginBottom = "2px";
    labelEl.textContent = `${icon} ${label}`;
    box.appendChild(labelEl);

    const barBg = document.createElement("div");
    barBg.style.height = "6px";
    barBg.style.borderRadius = "3px";
    barBg.style.background = "#27272a";
    barBg.style.overflow = "hidden";
    const barFill = document.createElement("div");
    barFill.style.height = "100%";
    barFill.style.width = "0%";
    barFill.style.background = "#38bdf8";
    barFill.style.transition = "width 80ms linear";
    barBg.appendChild(barFill);
    box.appendChild(barBg);

    return { box, labelEl, barFill };
  }

  const sword = makeBar("⚔", "Sword: Ready");
  const smoke = makeBar("💨", "Smoke: Ready");
  const dash = makeBar("💫", "Dash: Ready");
  wrap.appendChild(sword.box);
  wrap.appendChild(smoke.box);
  wrap.appendChild(dash.box);

  // frac: 0 = ready, 1 = just used — bars fill on use and drain to empty.
  function updateBar(bar, name, frac, totalMs) {
    bar.barFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    bar.labelEl.textContent =
      frac > 0 ? `${name}: ${((frac * totalMs) / 1000).toFixed(1)}s` : `${name}: Ready`;
  }

  return {
    el: wrap,
    update(swordFrac, smokeFrac, dashFrac) {
      updateBar(sword, "⚔ Sword", swordFrac, ATTACK_COOLDOWN_MS);
      updateBar(smoke, "💨 Smoke", smokeFrac, SMOKE_COOLDOWN_MS);
      updateBar(dash, "💫 Dash", dashFrac, DASH_COOLDOWN_MS);
    },
  };
}

// A small circular badge overlaid directly on the canvas showing a
// skill's cooldown as a clock-style radial wipe — a dark wedge that
// starts full the instant the skill is used and shrinks away as the
// cooldown drains, on top of the existing below-canvas bars (those stay
// too; this is an *additional*, more glanceable in-view indicator since
// the bars sit outside the player's actual view of the action).
// rightOffsetPx positions multiple icons side by side in the same corner
// (see the dash + smoke instances below — dash sits just to smoke's left).
function buildSkillCanvasIcon(emoji, rightOffsetPx) {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.top = "8px";
  el.style.right = `${rightOffsetPx}px`;
  el.style.width = "34px";
  el.style.height = "34px";
  el.style.borderRadius = "50%";
  el.style.background = "rgba(24,24,27,0.8)";
  el.style.border = "2px solid #52525b";
  el.style.pointerEvents = "none";
  el.style.userSelect = "none";
  el.style.overflow = "hidden";

  const emojiEl = document.createElement("div");
  emojiEl.style.position = "absolute";
  emojiEl.style.inset = "0";
  emojiEl.style.display = "flex";
  emojiEl.style.alignItems = "center";
  emojiEl.style.justifyContent = "center";
  emojiEl.style.fontSize = "15px";
  emojiEl.textContent = emoji;
  el.appendChild(emojiEl);

  const wipe = document.createElement("div");
  wipe.style.position = "absolute";
  wipe.style.inset = "0";
  wipe.style.borderRadius = "50%";
  wipe.style.background = "conic-gradient(rgba(0,0,0,0.78) 0deg, transparent 0deg)";
  el.appendChild(wipe);

  const countEl = document.createElement("div");
  countEl.style.position = "absolute";
  countEl.style.inset = "0";
  countEl.style.display = "flex";
  countEl.style.alignItems = "center";
  countEl.style.justifyContent = "center";
  countEl.style.fontSize = "11px";
  countEl.style.fontWeight = "700";
  countEl.style.color = "#ffffff";
  countEl.style.textShadow = "0 1px 2px rgba(0,0,0,0.85)";
  el.appendChild(countEl);

  return {
    el,
    // frac: 0 = ready, 1 = just used — same convention as buildCooldownHud.
    update(frac, totalMs) {
      const deg = Math.max(0, Math.min(1, frac)) * 360;
      wipe.style.background = `conic-gradient(rgba(0,0,0,0.78) ${deg}deg, transparent ${deg}deg)`;
      const remainingS = (frac * totalMs) / 1000;
      countEl.textContent = frac > 0 ? Math.ceil(remainingS).toString() : "";
    },
  };
}

function mount(el, ctx) {
  el.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.position = "relative";

  const status = document.createElement("p");
  status.style.fontSize = "12px";
  status.style.margin = "0 0 6px 0";
  status.textContent =
    "WASD to move/strafe, arrow keys (or M for mouse-look) to look around, Space to jump, click or J to swing, Shift to dash. Connecting…";
  wrap.appendChild(status);

  const mouseLookStatus = document.createElement("p");
  mouseLookStatus.style.fontSize = "11px";
  mouseLookStatus.style.margin = "0 0 6px 0";
  mouseLookStatus.style.color = "#a3a3a3";
  mouseLookStatus.textContent = "Mouse-look: off (press M to try enabling it)";
  wrap.appendChild(mouseLookStatus);

  // Timed Deathmatch's running countdown — a separate persistent element
  // rather than reusing `status`, which gets overwritten constantly by
  // one-off event messages (swing/hit/dash/etc.) and would just flicker.
  const matchTimeEl = document.createElement("p");
  matchTimeEl.style.fontSize = "11px";
  matchTimeEl.style.margin = "0 0 6px 0";
  matchTimeEl.style.color = "#fbbf24";
  matchTimeEl.style.fontWeight = "600";
  wrap.appendChild(matchTimeEl);

  // A dedicated relative-positioned wrapper just for the canvas — the
  // standings overlay (held-Tab scoreboard, see below) is absolutely
  // positioned to cover exactly this box, regardless of whatever status
  // text sits above it in `wrap`.
  const canvasWrap = document.createElement("div");
  canvasWrap.style.position = "relative";
  canvasWrap.style.width = "100%";
  canvasWrap.style.maxWidth = "720px";

  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  canvas.tabIndex = 0;
  canvas.style.width = "100%";
  canvas.style.display = "block";
  canvas.style.borderRadius = "4px";
  canvasWrap.appendChild(canvas);

  // Held-key scoreboard (see TAB_KEY below) — who's in the match and
  // whether they're currently alive or waiting to respawn. Hidden by
  // default, toggled purely by whether the key is currently held (no
  // click target, so it can't itself steal focus from the canvas).
  const standingsEl = document.createElement("div");
  standingsEl.style.position = "absolute";
  standingsEl.style.inset = "0";
  standingsEl.style.display = "none";
  standingsEl.style.background = "rgba(15, 23, 42, 0.85)";
  standingsEl.style.color = "#e5e7eb";
  standingsEl.style.padding = "10px";
  standingsEl.style.fontSize = "13px";
  standingsEl.style.overflowY = "auto";
  standingsEl.style.borderRadius = "4px";
  standingsEl.style.pointerEvents = "none"; // never intercepts clicks meant for the canvas
  canvasWrap.appendChild(standingsEl);

  const smokeIcon = buildSkillCanvasIcon("💨", 8);
  canvasWrap.appendChild(smokeIcon.el);
  const dashIcon = buildSkillCanvasIcon("💫", 48);
  canvasWrap.appendChild(dashIcon.el);

  wrap.appendChild(canvasWrap);

  const cooldownHud = buildCooldownHud();
  wrap.appendChild(cooldownHud.el);

  const turnButtons = buildTurnButtons();
  wrap.appendChild(turnButtons.el);

  const controlsHelp = document.createElement("p");
  controlsHelp.style.fontSize = "11px";
  controlsHelp.style.margin = "8px 0 0 0";
  controlsHelp.style.color = "#a3a3a3";
  controlsHelp.style.lineHeight = "1.5";
  controlsHelp.innerHTML =
    "<strong>Controls</strong> — WASD: move/strafe &nbsp;•&nbsp; Arrow keys: look &nbsp;•&nbsp; M: toggle mouse-look &nbsp;•&nbsp; Space: jump &nbsp;•&nbsp; Click or J: swing sword &nbsp;•&nbsp; Shift: dash &nbsp;•&nbsp; F: smoke skill &nbsp;•&nbsp; Tab (hold): show standings";
  wrap.appendChild(controlsHelp);

  el.appendChild(wrap);
  canvas.focus();

  const { renderer, scene, camera, arena } = createScene(canvas);
  const blocks = solidBlocks(arena, null);

  const physics = createPlayerPhysics(SPAWN.x, SPAWN.y, SPAWN.z);
  const rig = buildPlayerRig("#f59e0b");
  scene.add(rig.group);

  // userId -> { rig, targetX/Y/Z/Facing (latest network update),
  // renderFacing (eased separately since angles wrap, see updatePeers) }.
  const peers = new Map();

  function ensurePeer(userId, x, y, z, facing) {
    let peer = peers.get(userId);
    if (!peer) {
      const peerRig = buildPlayerRig("#38bdf8");
      scene.add(peerRig.group);
      peer = {
        rig: peerRig,
        targetX: x,
        targetY: y,
        targetZ: z,
        targetFacing: facing,
        // Movement/swing are inferred locally from what the server relays
        // (a position/facing/isActiveSwing snapshot every network tick),
        // not driven by a real animation timeline from the peer's own
        // client — see the peer_position handler below for how each of
        // these gets set.
        isMoving: false,
        wasActiveSwing: false,
        invulnerableUntil: 0,
        kills: 0,
      };
      peer.rig.group.position.set(x, y, z);
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
    peers.delete(userId);
  }

  let facingAngle = 0;
  let pitchAngle = 0;
  const camPos = new THREE.Vector3(SPAWN.x, SPAWN.y + PLAYER_HEIGHT, SPAWN.z + CAMERA_DISTANCE);
  const camLookAt = new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z);

  const input = createInputState(canvas, turnButtons.state, (locked) => {
    mouseLookStatus.textContent = locked
      ? "Mouse-look: ON (press M to disable)"
      : "Mouse-look: off (press M to try enabling it)";
  });
  let lastWidth = 0;
  let lastHeight = 0;
  let lastFrameTime = performance.now();
  let lastNetworkTickAt = 0;
  let rafId;

  let playerStunnedUntil = 0;
  let invulnerableUntil = 0; // post-respawn "prepare" window — see onRespawnMessage
  let selfKills = 0; // score for this match — see the standings overlay
  let playerWasActive = false;
  let dashingUntil = 0;
  let dashCooldownUntil = 0;
  let dashDirX = 0;
  let dashDirZ = 0;
  let knockbackUntil = 0;
  let knockbackDirX = 0;
  let knockbackDirZ = 0;
  let isDead = false;
  let hasReportedFall = false;
  let matchEndsAt = 0; // performance.now()-space — set from roster's matchEndsInMs
  let matchOver = false;
  let smokeCooldownUntil = 0;
  const bloodEffects = []; // active spawnBloodSpray()/spawnDashEffect()/spawnSmokeCloud() handles — pruned in frame()

  // Roughly chest height on the victim — not the exact server-side hit
  // point (that's never sent back, just the death event itself), but
  // close enough that the spray reads as coming from the body, not the
  // feet or floor.
  const BLOOD_SPRAY_HEIGHT = 1.0;
  // Roughly where the head's bottom edge sits (matches player.js's
  // LEG_H+TORSO_H proportions, and main.py's HEAD_Y_MIN) — used as the
  // neck stump position for the gore fountain, not the exact geometry
  // (getHeadWorldPosition already gives the real head position for the
  // flying head itself).
  const NECK_Y = 1.3;

  // Headshot kill — hides the real head mesh and spawns a detached,
  // physics-lite flying head (launched in the direction the server
  // computed from attacker/target positions) plus a much bigger blood
  // fountain at the neck, instead of the normal blood spray.
  function triggerDecapitation(targetRig, msg, color) {
    const headPos = getHeadWorldPosition(targetRig);
    hideHead(targetRig);
    bloodEffects.push(spawnFlyingHead(scene, headPos.x, headPos.y, headPos.z, msg.headPushX, msg.headPushY, msg.headPushZ, color));
    bloodEffects.push(
      spawnGoreFountain(scene, targetRig.group.position.x, targetRig.group.position.y + NECK_Y, targetRig.group.position.z),
    );
  }

  function onDeathMessage(msg) {
    const now = performance.now();
    if (msg.userId === ctx.selfId) {
      isDead = true;
      startDeathFall(rig, now);
      status.textContent = msg.cause === "fall" ? "You fell! Respawning…" : "You were struck down! Respawning…";
      if (msg.cause === "hit") {
        if (msg.isHeadshot) triggerDecapitation(rig, msg, "#f59e0b");
        else bloodEffects.push(spawnBloodSpray(scene, physics.x, physics.y + BLOOD_SPRAY_HEIGHT, physics.z));
      }
    } else {
      const peer = peers.get(msg.userId);
      if (peer) startDeathFall(peer.rig, now);
      if (msg.cause === "hit" && peer) {
        if (msg.isHeadshot) triggerDecapitation(peer.rig, msg, "#38bdf8");
        else {
          const pos = peer.rig.group.position;
          bloodEffects.push(spawnBloodSpray(scene, pos.x, pos.y + BLOOD_SPRAY_HEIGHT, pos.z));
        }
      }
      if (msg.attackerId === ctx.selfId) {
        selfKills = msg.attackerKills;
        status.textContent = "Hit!";
      } else if (msg.attackerId != null) {
        const attackerPeer = peers.get(msg.attackerId);
        if (attackerPeer) attackerPeer.kills = msg.attackerKills;
      }
    }
  }

  function onRespawnMessage(msg) {
    const now = performance.now();
    const invulnMs = msg.invulnerableMs || 0;
    if (msg.userId === ctx.selfId) {
      isDead = false;
      hasReportedFall = false;
      invulnerableUntil = now + invulnMs;
      resetAfterRespawn(rig, now);
      physics.x = msg.x;
      physics.y = msg.y;
      physics.z = msg.z;
      physics.vx = 0;
      physics.vy = 0;
      physics.vz = 0;
      status.textContent = "Back in the fight! Preparing — can't attack or be hit for a moment.";
    } else {
      const peer = peers.get(msg.userId);
      if (peer) {
        peer.invulnerableUntil = now + invulnMs;
        resetAfterRespawn(peer.rig, now);
        peer.targetX = msg.x;
        peer.targetY = msg.y;
        peer.targetZ = msg.z;
        peer.rig.group.position.set(msg.x, msg.y, msg.z);
      }
    }
  }

  function onParryMessage(msg) {
    const isPlayer1 = msg.player1Id === ctx.selfId;
    if (isPlayer1 || msg.player2Id === ctx.selfId) {
      const now = performance.now();
      playerStunnedUntil = now + PARRY_STUN_MS;
      interruptToCooldown(rig, now);
      knockbackUntil = now + PARRY_KNOCKBACK_DURATION_MS;
      knockbackDirX = isPlayer1 ? msg.player1PushX : msg.player2PushX;
      knockbackDirZ = isPlayer1 ? msg.player1PushZ : msg.player2PushZ;
      status.textContent = "Parry! Both swords clashed — stunned for a moment.";
    }
  }

  const socket = connectLubaSocket(ctx.lobbyId, (msg) => {
    switch (msg.type) {
      case "roster":
        // The server assigned `me` a random spawn point before this ever
        // arrived (see main.py) — apply it now instead of leaving the
        // client sitting at its own locally-hardcoded SPAWN constant,
        // which is what actually made the very first spawn of a match
        // non-random (every position tick after that just kept
        // overwriting the server's own random pick with the client's
        // fixed one).
        physics.x = msg.selfX;
        physics.y = msg.selfY;
        physics.z = msg.selfZ;
        matchEndsAt = performance.now() + (msg.matchEndsInMs || 0);
        for (const p of msg.players) {
          const peer = ensurePeer(p.userId, p.x, p.y, p.z, p.facing);
          peer.kills = p.kills;
          if (!p.alive) startDeathFall(peer.rig, performance.now());
        }
        status.textContent = `Connected — ${msg.players.length} other player(s) here.`;
        break;
      case "joined":
        ensurePeer(msg.userId, msg.x, msg.y, msg.z, 0);
        break;
      case "left":
        removePeer(msg.userId);
        break;
      case "peer_position": {
        const peer = ensurePeer(msg.userId, msg.x, msg.y, msg.z, msg.facing);
        // Real movement, inferred from actual position deltas between
        // ticks — not the previous hardcoded "always true" that made
        // every peer look like they were perpetually running in place
        // even when standing still. A real walk at MOVE_SPEED covers
        // ~0.3 units per NETWORK_TICK_MS; PEER_MOVE_THRESHOLD sits well
        // below that but above idle floating-point/network jitter.
        const dx = msg.x - peer.targetX;
        const dz = msg.z - peer.targetZ;
        peer.isMoving = Math.hypot(dx, dz) > PEER_MOVE_THRESHOLD;
        peer.targetX = msg.x;
        peer.targetY = msg.y;
        peer.targetZ = msg.z;
        peer.targetFacing = msg.facing;
        // Kick off a locally-mirrored swing the instant the flag rises —
        // there's no frame-by-frame animation timeline coming over the
        // wire (see net/lubaSocket.js), just this boolean, so the peer's
        // own combo state machine plays through its usual timing on its
        // own rig once triggered, same visual as the real thing even
        // though it's not literally frame-synced to the attacker's client.
        if (msg.isActiveSwing && !peer.wasActiveSwing && !peer.rig.isDead) {
          tryAttack(peer.rig, performance.now());
        }
        peer.wasActiveSwing = !!msg.isActiveSwing;
        break;
      }
      case "death":
        onDeathMessage(msg);
        break;
      case "respawn":
        onRespawnMessage(msg);
        break;
      case "parry":
        onParryMessage(msg);
        break;
      case "match_over": {
        matchOver = true;
        const winnerInfo = msg.winnerId != null ? ctx.participants.find((p) => p.id === msg.winnerId) : null;
        const winnerName = winnerInfo ? winnerInfo.display_name || winnerInfo.username : `user#${msg.winnerId}`;
        status.textContent = msg.isTie
          ? `Time's up! Tied at ${msg.winnerKills} kills.`
          : `Time's up! ${winnerName} wins with ${msg.winnerKills} kill${msg.winnerKills === 1 ? "" : "s"}!`;
        matchTimeEl.textContent = "Match over";
        // ctx.onMatchOver — optional, for a match that was never backed by
        // a real Cheddar lobby row (see glophimon's own Luba-lobby feature,
        // which mints its own synthetic lobby_id and calls mount() this
        // way). When provided, it replaces the usual finish call entirely
        // rather than running alongside it — there's no real lobby for
        // /lobbies/{id}/finish to act on, so calling it too would just be a
        // guaranteed-to-fail request. Every other caller (the normal
        // Cheddar-lobby flow) doesn't pass this, so its own behavior below
        // is completely unchanged.
        if (ctx.onMatchOver) {
          ctx.onMatchOver();
        } else if (window.CheddarHost && window.CheddarHost.finishGame) {
          // Reports the match as finished to Cheddar's generic lobby
          // state — the same bridge method used for every other game — so
          // the leader's "Back to Lobby" button appears. Idempotent
          // server-side, so every connected client calling this is fine.
          window.CheddarHost.finishGame();
        }
        break;
      }
      case "smoke":
        // Broadcast to everyone including the caster (see main.py) so
        // every client spawns the exact same cloud at the exact same
        // spot — no separate optimistic local-only spawn on the caster's
        // own client.
        bloodEffects.push(spawnSmokeCloud(scene, msg.x, msg.y, msg.z, SMOKE_RADIUS, msg.durationMs));
        if (msg.userId === ctx.selfId) status.textContent = "Smoke deployed!";
        break;
      case "_disconnected":
        status.textContent = "Disconnected from the match.";
        break;
      case "_error":
        status.textContent = `Connection error: ${msg.message}`;
        break;
    }
  });

  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    const { inputForward, inputStrafe, turn, pitchTurn, mouseTurnDelta, mousePitchDelta, jump, attack, dash, smoke, standingsHeld } =
      input.read();

    if (!matchOver) {
      const msLeft = Math.max(0, matchEndsAt - now);
      const totalSec = Math.ceil(msLeft / 1000);
      const mm = Math.floor(totalSec / 60);
      const ss = String(totalSec % 60).padStart(2, "0");
      matchTimeEl.textContent = `Timed Deathmatch — ${mm}:${ss} left`;
    }

    standingsEl.style.display = standingsHeld ? "block" : "none";
    if (standingsHeld) {
      // Built with real DOM nodes + textContent, not innerHTML string
      // concatenation — display_name/username come from other players
      // and must never be interpreted as markup.
      standingsEl.replaceChildren();
      const heading = document.createElement("strong");
      heading.textContent = "Standings";
      standingsEl.appendChild(heading);
      const list = document.createElement("ul");
      list.style.margin = "6px 0 0 0";
      list.style.paddingLeft = "18px";
      const rows = [{ userId: ctx.selfId, alive: !isDead, kills: selfKills }];
      for (const [userId, peer] of peers) rows.push({ userId, alive: !peer.rig.isDead, kills: peer.kills });
      rows.sort((a, b) => b.kills - a.kills); // highest score first — this is a leaderboard, not a join order list
      for (const r of rows) {
        const info = ctx.participants.find((p) => p.id === r.userId);
        const name = info ? info.display_name || info.username : `user#${r.userId}`;
        const item = document.createElement("li");
        const killLabel = r.kills === 1 ? "1 kill" : `${r.kills} kills`;
        item.textContent =
          `${name}${r.userId === ctx.selfId ? " (you)" : ""} — ${killLabel} — ${r.alive ? "🟢 Alive" : "💀 Down"}`;
        list.appendChild(item);
      }
      standingsEl.appendChild(list);
    }
    facingAngle += turn * TURN_SPEED * dt + mouseTurnDelta;
    pitchAngle += pitchTurn * PITCH_SPEED * dt + mousePitchDelta;
    pitchAngle = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitchAngle));

    // Forward/right derived from facing, not from movement — strafing
    // shifts you sideways relative to whichever way the camera is
    // currently pointing, and never rotates the character on its own.
    const forwardX = Math.sin(facingAngle);
    const forwardZ = Math.cos(facingAngle);
    const rightX = -Math.cos(facingAngle);
    const rightZ = Math.sin(facingAngle);
    const playerStunned = now < playerStunnedUntil || isDead;
    let moveX = forwardX * inputForward + rightX * inputStrafe;
    let moveZ = forwardZ * inputForward + rightZ * inputStrafe;
    const moveLen = Math.hypot(moveX, moveZ);
    let isMoving = moveLen > 0.001;
    if (isMoving) {
      moveX /= moveLen;
      moveZ /= moveLen;
    }
    if (playerStunned) {
      moveX = 0;
      moveZ = 0;
      isMoving = false;
    }

    // Direction locked in at the moment the dash starts — whichever way
    // you're currently moving (isMoving, already facing-relative same
    // as strafing), or straight backward if you're not moving at all.
    if (dash && !playerStunned && now >= dashingUntil && now >= dashCooldownUntil) {
      dashDirX = isMoving ? moveX : -forwardX;
      dashDirZ = isMoving ? moveZ : -forwardZ;
      dashingUntil = now + DASH_DURATION_MS;
      dashCooldownUntil = now + DASH_COOLDOWN_MS;
      bloodEffects.push(spawnDashEffect(scene, physics.x, physics.y + 0.3, physics.z, dashDirX, dashDirZ));
      status.textContent = "Dash!";
    } else if (dash && now < dashCooldownUntil) {
      status.textContent = "Dash still on cooldown…";
    }
    const isDashing = now < dashingUntil;
    if (isDashing) {
      moveX = dashDirX;
      moveZ = dashDirZ;
      isMoving = true; // so the run lean/arm-trail animation applies during a backward dash too
    }

    // Parry knockback overrides movement even though the player is also
    // stunned right now — the stun blocks *acting* (attacking/dashing
    // can't be triggered while now < playerStunnedUntil), not being
    // physically thrown back, which is exactly what this is.
    const isKnockedBack = now < knockbackUntil;
    if (isKnockedBack) {
      moveX = knockbackDirX;
      moveZ = knockbackDirZ;
      isMoving = true;
    }

    if (!isDead) {
      stepPhysics(
        physics,
        {
          moveX,
          moveZ,
          jump: playerStunned ? false : jump,
          speed: isDashing ? DASH_SPEED : isKnockedBack ? PARRY_KNOCKBACK_SPEED : undefined,
        },
        blocks,
        dt,
      );
    }

    if (!isDead && !hasReportedFall && physics.y < FALL_DEATH_Y) {
      hasReportedFall = true;
      isDead = true;
      startDeathFall(rig, now);
      status.textContent = "You fell! Respawning…";
      socket.sendFell();
    }

    // Position/rotation set *before* the hit-check below, not after —
    // getSwordWorldSamplePoints reads the rig's current world transform,
    // so it has to already reflect this frame's movement. Rotation.y
    // (facing) is frozen once dead — a lying corpse shouldn't spin just
    // because the camera is still being panned around with the mouse.
    rig.group.position.set(physics.x, physics.y, physics.z);
    if (!isDead) rig.group.rotation.y = facingAngle;

    const isInvulnerable = now < invulnerableUntil;
    if (attack && matchOver) {
      status.textContent = "Time's up — combat's over.";
    } else if (attack && isInvulnerable) {
      status.textContent = "Still preparing — can't attack yet…";
    } else if (attack && !playerStunned) {
      const started = tryAttack(rig, now);
      if (!started) status.textContent = "Sword's still on cooldown…";
      else {
        status.textContent = "Swing!";
        socket.sendAttackStart();
      }
    }

    if (isDead) updateDeathFall(rig, now);
    else updatePlayerVisual(rig, now, isMoving, dt);
    updateShieldVisual(rig, isInvulnerable, now);

    if (smoke && matchOver) {
      status.textContent = "Time's up — combat's over.";
    } else if (smoke && (isInvulnerable || playerStunned)) {
      // Same restriction as the sword — no gadgets while preparing/stunned.
    } else if (smoke && now >= smokeCooldownUntil) {
      smokeCooldownUntil = now + SMOKE_COOLDOWN_MS;
      socket.sendSmokeStart();
    } else if (smoke) {
      status.textContent = "Smoke skill still on cooldown…";
    }
    const smokeFrac = Math.max(0, (smokeCooldownUntil - now) / SMOKE_COOLDOWN_MS);
    const dashFrac = Math.max(0, (dashCooldownUntil - now) / DASH_COOLDOWN_MS);
    cooldownHud.update(
      rig.comboState === "cooldown" ? Math.max(0, 1 - (now - rig.stateEnteredAt) / ATTACK_COOLDOWN_MS) : 0,
      smokeFrac,
      dashFrac,
    );
    smokeIcon.update(smokeFrac, SMOKE_COOLDOWN_MS);
    dashIcon.update(dashFrac, DASH_COOLDOWN_MS);

    // Denser than the tick-gated position broadcast below — sent every
    // render frame the swing is actually active, so a fast continuous
    // blade sweep can't slip through the gaps between two ~33ms position
    // ticks. See net/lubaSocket.js's sendAttackSample for the full reasoning.
    if (rig.isActiveSwing) socket.sendAttackSample(getSwordWorldSamplePoints(rig));

    // Peers: their swing is mirrored locally (triggered on the rising
    // edge of the isActiveSwing flag — see the peer_position handler
    // above) and isMoving reflects their actual reported position deltas,
    // not a hardcoded true (that was the bug — every peer looked like
    // they were perpetually running even standing still). Ease their
    // rendered position/facing toward the latest network update. A dead
    // peer plays its own fall-and-lie-flat animation instead, and holds
    // its last-known facing rather than continuing to ease it.
    const peerEase = 1 - Math.exp(-PEER_EASE_RATE * dt);
    for (const peer of peers.values()) {
      if (peer.rig.isDead) updateDeathFall(peer.rig, now);
      else updatePlayerVisual(peer.rig, now, peer.isMoving, dt);
      updateShieldVisual(peer.rig, now < peer.invulnerableUntil, now);
      peer.rig.group.position.x += (peer.targetX - peer.rig.group.position.x) * peerEase;
      peer.rig.group.position.y += (peer.targetY - peer.rig.group.position.y) * peerEase;
      peer.rig.group.position.z += (peer.targetZ - peer.rig.group.position.z) * peerEase;
      if (!peer.rig.isDead) {
        // Shortest-path angle easing — without this, easing straight
        // through raw angle values glitches every time facing crosses
        // the -π/π wraparound.
        let angleDiff = peer.targetFacing - peer.rig.group.rotation.y;
        angleDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
        peer.rig.group.rotation.y += angleDiff * peerEase;
      }
    }

    // Per-frame swept-hit sampling — sent to the server (not resolved
    // locally, see the plan's authority model) whenever the swing is
    // actually active. Sent on the same fixed network tick as position,
    // not every render frame, matching the plan's ~15/sec rate.
    if (now - lastNetworkTickAt >= NETWORK_TICK_MS) {
      lastNetworkTickAt = now;
      const bladePoints = rig.isActiveSwing ? getSwordWorldSamplePoints(rig) : null;
      socket.sendPosition(physics.x, physics.y, physics.z, facingAngle, rig.isActiveSwing, bladePoints);
    }

    if (playerWasActive && !rig.isActiveSwing) {
      status.textContent = "Swing finished.";
    }
    playerWasActive = rig.isActiveSwing;

    // Orbit camera around a pivot near the character's chest/head — both
    // yaw (facingAngle) and pitch (pitchAngle, plus a small constant tilt
    // so the default view still looks slightly down at the character
    // rather than sitting dead-level with them) place the camera on a
    // sphere of radius CAMERA_DISTANCE around that pivot, always looking
    // back at it.
    // Subtracted, not added: since the camera always looks back at a
    // fixed pivot, making the view tilt *up* means moving the camera
    // *down* (so its fixed gaze points upward) — increasing pitchAngle
    // (both keyboard Up and mouse-up map to a positive delta) must lower
    // orbitY, not raise it.
    const effectivePitch = CAMERA_BASE_TILT - pitchAngle;
    const orbitX = Math.sin(facingAngle) * Math.cos(effectivePitch);
    const orbitY = Math.sin(effectivePitch);
    const orbitZ = Math.cos(facingAngle) * Math.cos(effectivePitch);
    const pivotX = physics.x;
    const pivotY = physics.y + PLAYER_HEIGHT * 0.6;
    const pivotZ = physics.z;

    const desiredCamX = pivotX - orbitX * CAMERA_DISTANCE;
    const desiredCamY = pivotY + orbitY * CAMERA_DISTANCE;
    const desiredCamZ = pivotZ - orbitZ * CAMERA_DISTANCE;
    camPos.x += (desiredCamX - camPos.x) * CAMERA_DAMPING;
    camPos.y += (desiredCamY - camPos.y) * CAMERA_DAMPING;
    camPos.z += (desiredCamZ - camPos.z) * CAMERA_DAMPING;
    camLookAt.x += (pivotX - camLookAt.x) * CAMERA_DAMPING;
    camLookAt.y += (pivotY - camLookAt.y) * CAMERA_DAMPING;
    camLookAt.z += (pivotZ - camLookAt.z) * CAMERA_DAMPING;
    camera.position.copy(camPos);
    camera.lookAt(camLookAt);

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width > 0 && height > 0 && (width !== lastWidth || height !== lastHeight)) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      lastWidth = width;
      lastHeight = height;
    }

    // Iterate backward so removing a finished effect mid-loop (via
    // splice) doesn't skip the element that shifts into its place.
    for (let i = bloodEffects.length - 1; i >= 0; i--) {
      if (!bloodEffects[i].update(dt)) bloodEffects.splice(i, 1);
    }

    renderer.render(scene, camera);
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  el._lubaCleanup = () => {
    cancelAnimationFrame(rafId);
    input.dispose();
    socket.dispose();
    for (const userId of Array.from(peers.keys())) removePeer(userId);
    disposeRig(rig);
    // A huge dt forces update() straight past its own lifetime, which is
    // what actually removes it from the scene and disposes its
    // geometry/material — same code path a natural fade-out uses, just
    // driven to completion immediately rather than left dangling.
    for (const effect of bloodEffects) effect.update(1000);
    renderer.dispose();
  };
}

function unmount(el) {
  if (el && el._lubaCleanup) {
    el._lubaCleanup();
    delete el._lubaCleanup;
  }
}

const DUMMY_POS = { x: 0, y: 0, z: 4 };
const DUMMY_ATTACK_MIN_MS = 2200;
const DUMMY_ATTACK_MAX_MS = 3400;
const PRACTICE_HIT_RADIUS = 0.5; // matches games/luba/api's HIT_RADIUS
const PRACTICE_RESPAWN_MS = 1800;
const HEAD_Y_MIN = 1.3; // matches games/luba/api's HEAD_Y_MIN
const NECK_Y = 1.3; // neck stump position for the gore fountain — see main mount()'s own comment

// A fully local, non-networked sandbox — no lobby, no WebSocket, just the
// arena/physics/rig/camera/dash/combat code shared with the real match,
// plus a practice dummy that swings on its own timer (always, not
// conditionally, so parry timing can be practiced reliably) and can be
// hit or hit you back. Hit resolution here is client-only (there's no
// server to trust or distrust — the whole point is a private sandbox),
// unlike the real match's server-authoritative check.
function mountPractice(el) {
  el.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.position = "relative";

  const status = document.createElement("p");
  status.style.fontSize = "12px";
  status.style.margin = "0 0 6px 0";
  status.textContent =
    "Practice mode — the dummy attacks on its own timer so you can drill parries. WASD to move/strafe, arrow keys (or M for mouse-look) to look around, Space to jump, click or J to swing, Shift to dash.";
  wrap.appendChild(status);

  const mouseLookStatus = document.createElement("p");
  mouseLookStatus.style.fontSize = "11px";
  mouseLookStatus.style.margin = "0 0 6px 0";
  mouseLookStatus.style.color = "#a3a3a3";
  mouseLookStatus.textContent = "Mouse-look: off (press M to try enabling it)";
  wrap.appendChild(mouseLookStatus);

  const scoreEl = document.createElement("p");
  scoreEl.style.fontSize = "11px";
  scoreEl.style.margin = "0 0 6px 0";
  scoreEl.style.color = "#fbbf24";
  scoreEl.style.fontWeight = "600";
  wrap.appendChild(scoreEl);

  const canvasWrap = document.createElement("div");
  canvasWrap.style.position = "relative";
  canvasWrap.style.width = "100%";
  canvasWrap.style.maxWidth = "720px";

  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  canvas.tabIndex = 0;
  canvas.style.width = "100%";
  canvas.style.display = "block";
  canvas.style.borderRadius = "4px";
  canvasWrap.appendChild(canvas);

  const smokeIcon = buildSkillCanvasIcon("💨", 8);
  canvasWrap.appendChild(smokeIcon.el);
  const dashIcon = buildSkillCanvasIcon("💫", 48);
  canvasWrap.appendChild(dashIcon.el);

  wrap.appendChild(canvasWrap);

  const cooldownHud = buildCooldownHud();
  wrap.appendChild(cooldownHud.el);

  const turnButtons = buildTurnButtons();
  wrap.appendChild(turnButtons.el);

  const controlsHelp = document.createElement("p");
  controlsHelp.style.fontSize = "11px";
  controlsHelp.style.margin = "8px 0 0 0";
  controlsHelp.style.color = "#a3a3a3";
  controlsHelp.style.lineHeight = "1.5";
  controlsHelp.innerHTML =
    "<strong>Controls</strong> — WASD: move/strafe &nbsp;•&nbsp; Arrow keys: look &nbsp;•&nbsp; M: toggle mouse-look &nbsp;•&nbsp; Space: jump &nbsp;•&nbsp; Click or J: swing sword &nbsp;•&nbsp; Shift: dash &nbsp;•&nbsp; F: smoke skill";
  wrap.appendChild(controlsHelp);

  el.appendChild(wrap);
  canvas.focus();

  const { renderer, scene, camera, arena } = createScene(canvas);
  const blocks = solidBlocks(arena, null);

  const physics = createPlayerPhysics(SPAWN.x, SPAWN.y, SPAWN.z);
  const rig = buildPlayerRig("#f59e0b");
  scene.add(rig.group);

  const dummy = buildPlayerRig("#ef4444");
  dummy.group.position.set(DUMMY_POS.x, DUMMY_POS.y, DUMMY_POS.z);
  scene.add(dummy.group);
  let dummyNextAttackAt = performance.now() + DUMMY_ATTACK_MIN_MS;
  let dummyDeadUntil = 0;
  // Dummy has no physics object of its own (it never moves except for
  // the death-fall animation), so its parry knockback is just a direct
  // position nudge each frame rather than going through stepPhysics.
  let dummyKnockbackUntil = 0;
  let dummyKnockbackDirX = 0;
  let dummyKnockbackDirZ = 0;

  let facingAngle = 0;
  let pitchAngle = 0;
  const camPos = new THREE.Vector3(SPAWN.x, SPAWN.y + PLAYER_HEIGHT, SPAWN.z + CAMERA_DISTANCE);
  const camLookAt = new THREE.Vector3(SPAWN.x, SPAWN.y, SPAWN.z);

  const input = createInputState(canvas, turnButtons.state, (locked) => {
    mouseLookStatus.textContent = locked
      ? "Mouse-look: ON (press M to disable)"
      : "Mouse-look: off (press M to try enabling it)";
  });
  let lastWidth = 0;
  let lastHeight = 0;
  let lastFrameTime = performance.now();
  let rafId;

  let playerStunnedUntil = 0;
  let playerWasActive = false;
  let dashingUntil = 0;
  let dashCooldownUntil = 0;
  let dashDirX = 0;
  let dashDirZ = 0;
  let knockbackUntil = 0;
  let knockbackDirX = 0;
  let knockbackDirZ = 0;
  let isDead = false;
  let hasReportedFall = false;
  let hitsLanded = 0;
  let timesHit = 0;
  let smokeCooldownUntil = 0;
  const bloodEffects = [];
  const BLOOD_SPRAY_HEIGHT = 1.0;

  function respawnPlayer(now) {
    isDead = false;
    hasReportedFall = false;
    resetAfterRespawn(rig, now);
    physics.x = SPAWN.x;
    physics.y = SPAWN.y;
    physics.z = SPAWN.z;
    physics.vx = 0;
    physics.vy = 0;
    physics.vz = 0;
    status.textContent = "Back up — keep practicing!";
  }

  // Checks `attacker`'s currently-active swing against `target`'s known
  // position — the same geometry the real match's server-side
  // _check_hit uses, just resolved locally since there's no server here.
  // Mirrors games/luba/api/app/main.py's server-side hit resolution: only
  // the ATTACKER's blade needs to have geometrically reached the target
  // this frame — the parry-vs-hit decision then turns on whether the
  // TARGET was *also* engaged (isActiveSwing, or still within its own
  // PARRY_GRACE_MS grace window), not on the target's own blade having
  // independently reached the attacker on this exact same frame. That
  // symmetric requirement was the original bug: it shrank the parry
  // window to well under one frame, since it demanded two independent
  // sweeps land in the same 16ms tick rather than just "both mid-swing
  // around the same time."
  //
  // Headshot kill — no server here, so the push direction (attacker to
  // target, plus upward bias) is computed locally instead of arriving on
  // the death broadcast, but otherwise identical to the real match's
  // triggerDecapitation.
  function triggerDecapitation(targetRig, attackerX, attackerZ, color) {
    const headPos = getHeadWorldPosition(targetRig);
    hideHead(targetRig);
    const dx = targetRig.group.position.x - attackerX;
    const dz = targetRig.group.position.z - attackerZ;
    const dist = Math.hypot(dx, dz) || 1;
    bloodEffects.push(spawnFlyingHead(scene, headPos.x, headPos.y, headPos.z, dx / dist, 1.0, dz / dist, color));
    bloodEffects.push(
      spawnGoreFountain(scene, targetRig.group.position.x, targetRig.group.position.y + NECK_Y, targetRig.group.position.z),
    );
  }

  function resolveAttack(attacker, target, now) {
    if (!attacker.isActiveSwing || attacker.hasHitThisSwing) return null;
    const points = getSwordWorldSamplePoints(attacker);
    const targetPos = target.group.position;
    const landedPoint = points.find((p) => {
      const dx = p.x - targetPos.x;
      const dz = p.z - targetPos.z;
      return Math.hypot(dx, dz) <= PRACTICE_HIT_RADIUS && p.y >= targetPos.y && p.y <= targetPos.y + PLAYER_HEIGHT + 0.2;
    });
    if (!landedPoint) return null;
    attacker.hasHitThisSwing = true;
    // Same HEAD_Y_MIN band as main.py's own — only decides which death
    // animation plays, not whether the hit landed at all.
    const headshot = landedPoint.y >= targetPos.y + HEAD_Y_MIN;
    const targetEngaged = target.isActiveSwing || now < target.activeSwingUntil;
    if (targetEngaged && !target.hasHitThisSwing) {
      target.hasHitThisSwing = true;
      return { outcome: "parry", headshot: false };
    }
    return { outcome: "hit", headshot };
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    const { inputForward, inputStrafe, turn, pitchTurn, mouseTurnDelta, mousePitchDelta, jump, attack, dash, smoke } = input.read();

    scoreEl.textContent = `Hits landed: ${hitsLanded} — Times you've been hit: ${timesHit}`;

    facingAngle += turn * TURN_SPEED * dt + mouseTurnDelta;
    pitchAngle += pitchTurn * PITCH_SPEED * dt + mousePitchDelta;
    pitchAngle = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitchAngle));

    const forwardX = Math.sin(facingAngle);
    const forwardZ = Math.cos(facingAngle);
    const rightX = -Math.cos(facingAngle);
    const rightZ = Math.sin(facingAngle);
    const playerStunned = now < playerStunnedUntil || isDead;
    let moveX = forwardX * inputForward + rightX * inputStrafe;
    let moveZ = forwardZ * inputForward + rightZ * inputStrafe;
    const moveLen = Math.hypot(moveX, moveZ);
    let isMoving = moveLen > 0.001;
    if (isMoving) {
      moveX /= moveLen;
      moveZ /= moveLen;
    }
    if (playerStunned) {
      moveX = 0;
      moveZ = 0;
      isMoving = false;
    }

    if (dash && !playerStunned && now >= dashingUntil && now >= dashCooldownUntil) {
      dashDirX = isMoving ? moveX : -forwardX;
      dashDirZ = isMoving ? moveZ : -forwardZ;
      dashingUntil = now + DASH_DURATION_MS;
      dashCooldownUntil = now + DASH_COOLDOWN_MS;
      bloodEffects.push(spawnDashEffect(scene, physics.x, physics.y + 0.3, physics.z, dashDirX, dashDirZ));
      status.textContent = "Dash!";
    } else if (dash && now < dashCooldownUntil) {
      status.textContent = "Dash still on cooldown…";
    }
    const isDashing = now < dashingUntil;
    if (isDashing) {
      moveX = dashDirX;
      moveZ = dashDirZ;
      isMoving = true;
    }

    // Parry knockback overrides movement even though the player is also
    // stunned right now — the stun blocks *acting*, not being physically
    // thrown back.
    const isKnockedBack = now < knockbackUntil;
    if (isKnockedBack) {
      moveX = knockbackDirX;
      moveZ = knockbackDirZ;
      isMoving = true;
    }

    if (!isDead) {
      stepPhysics(
        physics,
        {
          moveX,
          moveZ,
          jump: playerStunned ? false : jump,
          speed: isDashing ? DASH_SPEED : isKnockedBack ? PARRY_KNOCKBACK_SPEED : undefined,
        },
        blocks,
        dt,
      );
    }

    // Dummy has no physics object — its own knockback is a direct
    // position nudge, skipped once it's mid-death-fall (shouldn't slide
    // around while collapsing).
    if (now < dummyKnockbackUntil && !dummy.isDead) {
      dummy.group.position.x += dummyKnockbackDirX * PARRY_KNOCKBACK_SPEED * dt;
      dummy.group.position.z += dummyKnockbackDirZ * PARRY_KNOCKBACK_SPEED * dt;
    }

    if (!isDead && !hasReportedFall && physics.y < FALL_DEATH_Y) {
      hasReportedFall = true;
      isDead = true;
      startDeathFall(rig, now);
      status.textContent = "You fell! Respawning…";
      setTimeout(() => respawnPlayer(performance.now()), PRACTICE_RESPAWN_MS);
    }

    rig.group.position.set(physics.x, physics.y, physics.z);
    if (!isDead) rig.group.rotation.y = facingAngle;

    if (attack && !playerStunned) {
      const started = tryAttack(rig, now);
      if (!started) status.textContent = "Sword's still on cooldown…";
      else status.textContent = "Swing!";
    }
    if (smoke && !playerStunned && now >= smokeCooldownUntil) {
      smokeCooldownUntil = now + SMOKE_COOLDOWN_MS;
      bloodEffects.push(spawnSmokeCloud(scene, physics.x, physics.y, physics.z, SMOKE_RADIUS, SMOKE_DURATION_MS));
      status.textContent = "Smoke deployed!";
    } else if (smoke && now < smokeCooldownUntil) {
      status.textContent = "Smoke skill still on cooldown…";
    }
    const smokeFrac = Math.max(0, (smokeCooldownUntil - now) / SMOKE_COOLDOWN_MS);
    const dashFrac = Math.max(0, (dashCooldownUntil - now) / DASH_COOLDOWN_MS);
    cooldownHud.update(
      rig.comboState === "cooldown" ? Math.max(0, 1 - (now - rig.stateEnteredAt) / ATTACK_COOLDOWN_MS) : 0,
      smokeFrac,
      dashFrac,
    );
    smokeIcon.update(smokeFrac, SMOKE_COOLDOWN_MS);
    dashIcon.update(dashFrac, DASH_COOLDOWN_MS);

    if (isDead) updateDeathFall(rig, now);
    else updatePlayerVisual(rig, now, isMoving, dt);

    // Dummy: always swings on its own timer (not conditional on the
    // player's range/facing) so parry timing can be drilled reliably,
    // per earlier playtesting feedback ("make the dummy always slashing
    // so I can test the parry"). Faces the player while idle — without
    // this it never turned at all (stuck at its spawn orientation), so
    // its swing arc almost never actually reached wherever the player
    // was standing, making a genuine simultaneous "both landed" parry
    // effectively impossible regardless of timing, not just hard. Facing
    // is only updated while idle, then held fixed for the whole swing —
    // it commits to a direction once it starts, like a real attack.
    const dummyDead = now < dummyDeadUntil;
    if (dummy.comboState === "idle") {
      dummy.group.rotation.y = Math.atan2(physics.x - dummy.group.position.x, physics.z - dummy.group.position.z);
    }
    if (!dummyDead && now >= dummyNextAttackAt && dummy.comboState === "idle") {
      tryAttack(dummy, now);
      dummyNextAttackAt = now + DUMMY_ATTACK_MIN_MS + Math.random() * (DUMMY_ATTACK_MAX_MS - DUMMY_ATTACK_MIN_MS);
    }
    if (dummy.isDead) updateDeathFall(dummy, now);
    else updatePlayerVisual(dummy, now, false, dt);

    if (!isDead && !dummyDead) {
      // Both calls run regardless of which one resolves first — the
      // second call's own hasHitThisSwing guard (set by either a hit or
      // a parry) naturally prevents a double resolution if the first one
      // already decided it was a parry.
      const playerResult = resolveAttack(rig, dummy, now);
      const dummyResult = resolveAttack(dummy, rig, now);
      if (playerResult?.outcome === "parry" || dummyResult?.outcome === "parry") {
        interruptToCooldown(rig, now);
        interruptToCooldown(dummy, now);
        playerStunnedUntil = now + PARRY_STUN_MS;
        // Push direction: away from each other, along the line between
        // their two current positions.
        const dx = dummy.group.position.x - physics.x;
        const dz = dummy.group.position.z - physics.z;
        const dist = Math.hypot(dx, dz) || 1;
        knockbackUntil = now + PARRY_KNOCKBACK_DURATION_MS;
        knockbackDirX = -dx / dist;
        knockbackDirZ = -dz / dist;
        dummyKnockbackUntil = now + PARRY_KNOCKBACK_DURATION_MS;
        dummyKnockbackDirX = dx / dist;
        dummyKnockbackDirZ = dz / dist;
        status.textContent = "Parry! Both swords clashed.";
      } else if (playerResult?.outcome === "hit") {
        hitsLanded++;
        startDeathFall(dummy, now);
        if (playerResult.headshot) {
          triggerDecapitation(dummy, physics.x, physics.z, "#ef4444");
        } else {
          bloodEffects.push(spawnBloodSpray(scene, dummy.group.position.x, dummy.group.position.y + BLOOD_SPRAY_HEIGHT, dummy.group.position.z));
        }
        dummyDeadUntil = now + PRACTICE_RESPAWN_MS;
        status.textContent = playerResult.headshot ? "Headshot!" : "Hit!";
        setTimeout(() => {
          resetAfterRespawn(dummy, performance.now());
          dummy.group.position.set(DUMMY_POS.x, DUMMY_POS.y, DUMMY_POS.z);
          dummyNextAttackAt = performance.now() + DUMMY_ATTACK_MIN_MS;
        }, PRACTICE_RESPAWN_MS);
      } else if (dummyResult?.outcome === "hit") {
        timesHit++;
        isDead = true;
        startDeathFall(rig, now);
        if (dummyResult.headshot) {
          triggerDecapitation(rig, dummy.group.position.x, dummy.group.position.z, "#f59e0b");
        } else {
          bloodEffects.push(spawnBloodSpray(scene, physics.x, physics.y + BLOOD_SPRAY_HEIGHT, physics.z));
        }
        status.textContent = dummyResult.headshot ? "You got headshot! Respawning…" : "You got hit! Respawning…";
        setTimeout(() => respawnPlayer(performance.now()), PRACTICE_RESPAWN_MS);
      }
    }

    if (playerWasActive && !rig.isActiveSwing) {
      status.textContent = "Swing finished.";
    }
    playerWasActive = rig.isActiveSwing;

    const effectivePitch = CAMERA_BASE_TILT - pitchAngle;
    const orbitX = Math.sin(facingAngle) * Math.cos(effectivePitch);
    const orbitY = Math.sin(effectivePitch);
    const orbitZ = Math.cos(facingAngle) * Math.cos(effectivePitch);
    const pivotX = physics.x;
    const pivotY = physics.y + PLAYER_HEIGHT * 0.6;
    const pivotZ = physics.z;

    const desiredCamX = pivotX - orbitX * CAMERA_DISTANCE;
    const desiredCamY = pivotY + orbitY * CAMERA_DISTANCE;
    const desiredCamZ = pivotZ - orbitZ * CAMERA_DISTANCE;
    camPos.x += (desiredCamX - camPos.x) * CAMERA_DAMPING;
    camPos.y += (desiredCamY - camPos.y) * CAMERA_DAMPING;
    camPos.z += (desiredCamZ - camPos.z) * CAMERA_DAMPING;
    camLookAt.x += (pivotX - camLookAt.x) * CAMERA_DAMPING;
    camLookAt.y += (pivotY - camLookAt.y) * CAMERA_DAMPING;
    camLookAt.z += (pivotZ - camLookAt.z) * CAMERA_DAMPING;
    camera.position.copy(camPos);
    camera.lookAt(camLookAt);

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width > 0 && height > 0 && (width !== lastWidth || height !== lastHeight)) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      lastWidth = width;
      lastHeight = height;
    }

    for (let i = bloodEffects.length - 1; i >= 0; i--) {
      if (!bloodEffects[i].update(dt)) bloodEffects.splice(i, 1);
    }

    renderer.render(scene, camera);
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  el._lubaCleanup = () => {
    cancelAnimationFrame(rafId);
    input.dispose();
    disposeRig(rig);
    disposeRig(dummy);
    for (const effect of bloodEffects) effect.update(1000);
    renderer.dispose();
  };
}

window.CheddarGames = window.CheddarGames || {};
window.CheddarGames["luba"] = { mount, unmount, mountPractice };
