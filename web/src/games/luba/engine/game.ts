// Luba's engine — real multiplayer sword-fight arena. Position/attack
// sync over a direct WebSocket to luba-api, server-authoritative
// hit/parry/death resolution off client-reported blade positions,
// server-driven respawn. Movement/camera/combo/dash are fully
// client-side; only combat *resolution* and the presence of other
// players goes through the server.
//
// Ported from games/luba/client/src/game.js (the vscode extension's
// vendored copy) — kept as the same imperative mount(el, ctx)/unmount(el)
// engine (rather than rewritten as idiomatic React state) since it's
// already a carefully-tuned, self-contained closure with its own
// render/input loop; LubaGame.tsx is a thin wrapper that mounts it into a
// container div via a ref, the same way KarirsGame.tsx drives its own
// imperative Three.js scene off a canvas ref.
import * as THREE from "three";
import { buildArena, solidBlocks, PLAYER_HEIGHT, type Arena, type Block } from "./arena";
import { createPlayerPhysics, stepPhysics, FALL_DEATH_Y, type PlayerPhysics } from "./physics";
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
  type PlayerRig,
} from "./player";
import { connectLubaSocket, NETWORK_TICK_MS, type LubaServerMessage } from "./lubaSocket";
import { spawnBloodSpray, spawnDashEffect, spawnSmokeCloud, type BloodSprayHandle } from "./effects";
import { createMobileControls } from "./touchControls";

export interface LubaParticipant {
  id: number;
  username: string;
  display_name: string;
}

export interface LubaMountCtx {
  lobbyId: number;
  selfId: number;
  participants: LubaParticipant[];
  // Called once the server declares Timed Deathmatch over (see
  // main.py's _run_match_timer) — the web wrapper (LubaGame.tsx) wires
  // this to the same onFinished prop every other game component already
  // uses to report a lobby's game session as concluded.
  onMatchOver?: () => void;
}

const CAMERA_DISTANCE = 2.7; // zoomed in further still (was 3.4, 4.3, originally 5.5) — closer, more readable combat framing
const CAMERA_DAMPING = 0.18;
// Added to pitchAngle only for the camera's own orbit position — without
// this, pitch=0 (the resting state) would put the camera dead level with
// the pivot, looking flat at the character's chest instead of the more
// typical slightly-above-looking-down third-person framing. Bumped up
// from 0.25 to sit the camera a bit higher.
const CAMERA_BASE_TILT = 0.42;
const TURN_SPEED = 2.4; // rad/sec (yaw)
const PITCH_SPEED = 2.0; // rad/sec (keyboard up/down)
// Clamped short of straight up/down (±~90°) — a third-person orbit camera
// right at the poles is disorienting and prone to snapping/flipping.
const PITCH_MIN = -1.2;
const PITCH_MAX = 1.2;
const SPAWN = { x: 0, y: 6, z: 8 }; // dropped in from above so landing on the floor is visible/obvious
const PARRY_STUN_MS = 900; // must match games/luba/api/app/main.py's PARRY_STUN_S
// Dash: direction depends on current movement input at the moment it's
// pressed — whichever way you're currently moving (already
// facing-relative, same as normal strafing), or straight backward
// (relative to facing) if you're not moving at all. A short, fixed-speed
// burst rather than a velocity impulse — this project's movement model
// sets velocity directly from input every frame (no inertia/momentum at
// all), so an impulse would just get overwritten the very next frame.
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
// network update — so peers glide between ~15Hz position ticks instead
// of visibly snapping tile-to-tile.
const PEER_EASE_RATE = 12;
// Horizontal distance a peer's reported position has to move between two
// network ticks to count as "moving" for the walk/run animation — a real
// walk at MOVE_SPEED (5 units/sec) covers ~0.3 units per NETWORK_TICK_MS
// (66ms), well above this; idle floating-point/network jitter is not.
const PEER_MOVE_THRESHOLD = 0.05;

function buildArenaMeshes(scene: THREE.Scene, arena: Arena): void {
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

function createScene(canvas: HTMLCanvasElement): { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; arena: Arena } {
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

const MOUSE_SENSITIVITY = 0.0025; // rad per pixel of mouse movement while locked
const MOUSE_LOOK_KEY = "KeyM";
const DASH_KEYS = ["ShiftLeft", "ShiftRight"];
const STANDINGS_KEY = "Tab"; // held, not pressed once
const SMOKE_KEY = "KeyF";

interface InputFrame {
  inputForward: number;
  inputStrafe: number;
  turn: number;
  pitchTurn: number;
  mouseTurnDelta: number;
  mousePitchDelta: number;
  jump: boolean;
  attack: boolean;
  dash: boolean;
  smoke: boolean;
  standingsHeld: boolean;
}

interface InputState {
  read(): InputFrame;
  dispose(): void;
}

function createInputState(canvas: HTMLCanvasElement, rotateButtonState: { left: boolean; right: boolean }, onPointerLockChange: (locked: boolean) => void): InputState {
  const pressed = new Set<string>();
  let jumpQueued = false;
  let attackQueued = false;
  let dashQueued = false;
  let smokeQueued = false;
  let mouseDeltaX = 0;
  let mouseDeltaY = 0;
  // Gate every handler on the canvas actually having focus (native
  // focus/blur) — without this, these window-level listeners would react
  // to every keystroke on the page (typing elsewhere in the lobby chat,
  // clicking other buttons), not just input meant for the game. Drop any
  // held keys the instant focus leaves so a key doesn't stay "stuck" down.
  let canvasFocused = document.activeElement === canvas;
  function onFocus() {
    canvasFocused = true;
  }
  function onBlur() {
    canvasFocused = false;
    pressed.clear();
  }

  function keydown(e: KeyboardEvent) {
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
    // Space/arrows would otherwise scroll the page, and Tab would
    // otherwise cycle focus away from the canvas entirely — only
    // suppress any of that while the canvas itself is focused.
    if (e.code === "Space" || e.code.startsWith("Arrow") || e.code === STANDINGS_KEY) e.preventDefault();
  }
  function keyup(e: KeyboardEvent) {
    pressed.delete(e.code);
  }
  function mousedown(e: MouseEvent) {
    // Scoped to clicks actually on the canvas (or already pointer-locked
    // to it) — a click on some other part of the page shouldn't queue a
    // sword swing.
    if (e.button === 0 && (e.target === canvas || document.pointerLockElement === canvas)) attackQueued = true;
  }
  function mousemove(e: MouseEvent) {
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
    read(): InputFrame {
      let inputForward = 0;
      let inputStrafe = 0;
      if (pressed.has("KeyW")) inputForward += 1;
      if (pressed.has("KeyS")) inputForward -= 1;
      if (pressed.has("KeyD")) inputStrafe += 1;
      if (pressed.has("KeyA")) inputStrafe -= 1;

      let turn = 0;
      if (pressed.has("ArrowLeft") || rotateButtonState.left) turn += 1;
      if (pressed.has("ArrowRight") || rotateButtonState.right) turn -= 1;

      let pitchTurn = 0;
      if (pressed.has("ArrowUp")) pitchTurn += 1;
      if (pressed.has("ArrowDown")) pitchTurn -= 1;

      // Negated: screen-space mouse deltas are the opposite sign of the
      // turn they should produce.
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
// fallback alongside pointer-lock mouse-look.
function buildTurnButtons(): { el: HTMLDivElement; state: { left: boolean; right: boolean } } {
  const state = { left: false, right: false };
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.gap = "8px";
  wrap.style.marginTop = "6px";
  wrap.style.touchAction = "none";

  function makeButton(label: string, key: "left" | "right"): HTMLButtonElement {
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

interface CooldownHud {
  el: HTMLDivElement;
  update(swordFrac: number, smokeFrac: number): void;
}

// Cooldown indicators for the sword and the smoke skill, shown just below
// the canvas — a small bar per skill that starts full the instant it's
// used and drains back to empty (and "Ready") as the cooldown elapses.
function buildCooldownHud(): CooldownHud {
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.gap = "10px";
  wrap.style.marginTop = "6px";

  function makeBar(icon: string, label: string) {
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
  wrap.appendChild(sword.box);
  wrap.appendChild(smoke.box);

  // frac: 0 = ready, 1 = just used — bars fill on use and drain to empty.
  function updateBar(bar: ReturnType<typeof makeBar>, name: string, frac: number, totalMs: number) {
    bar.barFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    bar.labelEl.textContent = frac > 0 ? `${name}: ${((frac * totalMs) / 1000).toFixed(1)}s` : `${name}: Ready`;
  }

  return {
    el: wrap,
    update(swordFrac: number, smokeFrac: number) {
      updateBar(sword, "⚔ Sword", swordFrac, ATTACK_COOLDOWN_MS);
      updateBar(smoke, "💨 Smoke", smokeFrac, SMOKE_COOLDOWN_MS);
    },
  };
}

interface Peer {
  rig: PlayerRig;
  targetX: number;
  targetY: number;
  targetZ: number;
  targetFacing: number;
  isMoving: boolean;
  wasActiveSwing: boolean;
  invulnerableUntil: number;
  kills: number;
}

export function mount(el: HTMLElement, ctx: LubaMountCtx): void {
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
  // one-off event messages and would just flicker.
  const matchTimeEl = document.createElement("p");
  matchTimeEl.style.fontSize = "11px";
  matchTimeEl.style.margin = "0 0 6px 0";
  matchTimeEl.style.color = "#fbbf24";
  matchTimeEl.style.fontWeight = "600";
  wrap.appendChild(matchTimeEl);

  // A dedicated relative-positioned wrapper just for the canvas — the
  // standings overlay (held-Tab scoreboard) is absolutely positioned to
  // cover exactly this box, regardless of whatever status text sits
  // above it in `wrap`.
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

  // Held-key scoreboard — who's in the match and whether they're
  // currently alive or waiting to respawn. Hidden by default, toggled
  // purely by whether the key is currently held (no click target, so it
  // can't itself steal focus from the canvas).
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

  // Joystick + action buttons, shown only on touch-primary/narrow
  // viewports (desktop mouse+keyboard users never see this) — see the
  // matchMedia listener set up below.
  const mobileControls = createMobileControls();
  canvasWrap.appendChild(mobileControls.el);
  const touchMediaQuery = window.matchMedia("(pointer: coarse), (max-width: 820px)");
  function updateMobileControlsVisibility() {
    mobileControls.setVisible(touchMediaQuery.matches);
  }
  updateMobileControlsVisibility();
  touchMediaQuery.addEventListener("change", updateMobileControlsVisibility);

  wrap.appendChild(canvasWrap);

  const cooldownHud = buildCooldownHud();
  wrap.appendChild(cooldownHud.el);

  // Not appended to the DOM — the on-screen ◀▶ buttons were removed from
  // the web build (the touch HUD's joystick + mouse-look/arrow keys
  // already cover turning; the separate button row below the canvas was
  // redundant clutter). turnButtons.state is still needed as-is below,
  // since createInputState reads rotateButtonState.left/right — it just
  // never gets set to true now that nothing renders these buttons.
  const turnButtons = buildTurnButtons();

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
  const blocks: Block[] = solidBlocks(arena, null);

  const physics: PlayerPhysics = createPlayerPhysics(SPAWN.x, SPAWN.y, SPAWN.z);
  const rig = buildPlayerRig("#f59e0b");
  scene.add(rig.group);

  const peers = new Map<number, Peer>();

  function ensurePeer(userId: number, x: number, y: number, z: number, facing: number): Peer {
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

  function removePeer(userId: number): void {
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
  let rafId = 0;

  let playerStunnedUntil = 0;
  let invulnerableUntil = 0; // post-respawn "prepare" window
  let selfKills = 0; // score for this match — see the standings overlay
  let playerWasActive = false;
  let dashingUntil = 0;
  let dashCooldownUntil = 0;
  let dashDirX = 0;
  let dashDirZ = 0;
  let isDead = false;
  let hasReportedFall = false;
  let matchEndsAt = 0; // performance.now()-space — set from roster's matchEndsInMs
  let matchOver = false;
  let smokeCooldownUntil = 0;
  const bloodEffects: BloodSprayHandle[] = [];

  // Roughly chest height on the victim — not the exact server-side hit
  // point (that's never sent back, just the death event itself), but
  // close enough that the spray reads as coming from the body.
  const BLOOD_SPRAY_HEIGHT = 1.0;

  function onDeathMessage(msg: Extract<LubaServerMessage, { type: "death" }>): void {
    const now = performance.now();
    if (msg.userId === ctx.selfId) {
      isDead = true;
      startDeathFall(rig, now);
      status.textContent = msg.cause === "fall" ? "You fell! Respawning…" : "You were struck down! Respawning…";
      if (msg.cause === "hit") {
        bloodEffects.push(spawnBloodSpray(scene, physics.x, physics.y + BLOOD_SPRAY_HEIGHT, physics.z));
      }
    } else {
      const peer = peers.get(msg.userId);
      if (peer) startDeathFall(peer.rig, now);
      if (msg.cause === "hit" && peer) {
        const pos = peer.rig.group.position;
        bloodEffects.push(spawnBloodSpray(scene, pos.x, pos.y + BLOOD_SPRAY_HEIGHT, pos.z));
      }
      if (msg.attackerId === ctx.selfId) {
        selfKills = msg.attackerKills ?? selfKills;
        status.textContent = "Hit!";
      } else if (msg.attackerId != null) {
        const attackerPeer = peers.get(msg.attackerId);
        if (attackerPeer) attackerPeer.kills = msg.attackerKills ?? attackerPeer.kills;
      }
    }
  }

  function onRespawnMessage(msg: Extract<LubaServerMessage, { type: "respawn" }>): void {
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

  function onParryMessage(msg: Extract<LubaServerMessage, { type: "parry" }>): void {
    if (msg.player1Id === ctx.selfId || msg.player2Id === ctx.selfId) {
      const now = performance.now();
      playerStunnedUntil = now + PARRY_STUN_MS;
      interruptToCooldown(rig, now);
      status.textContent = "Parry! Both swords clashed — stunned for a moment.";
    }
  }

  const socket = connectLubaSocket(ctx.lobbyId, (msg) => {
    switch (msg.type) {
      case "roster":
        // The server assigned `me` a random spawn point before this ever
        // arrived — apply it now instead of leaving the client sitting
        // at its own locally-hardcoded SPAWN constant.
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
        // ticks.
        const dx = msg.x - peer.targetX;
        const dz = msg.z - peer.targetZ;
        peer.isMoving = Math.hypot(dx, dz) > PEER_MOVE_THRESHOLD;
        peer.targetX = msg.x;
        peer.targetY = msg.y;
        peer.targetZ = msg.z;
        peer.targetFacing = msg.facing;
        // Kick off a locally-mirrored swing the instant the flag rises —
        // there's no frame-by-frame animation timeline coming over the
        // wire, just this boolean, so the peer's own combo state machine
        // plays through its usual timing on its own rig once triggered.
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
        ctx.onMatchOver?.();
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

  function frame(now: number): void {
    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    const kb = input.read();
    const touch = mobileControls.read();
    // Additive, not either/or — a touch device can still have a physical
    // keyboard attached (or the joystick simply isn't being touched right
    // now, leaving its axes at 0), so summing is safe; the existing
    // moveLen normalization below already handles a combined magnitude
    // over 1.
    const inputForward = kb.inputForward + touch.inputForward;
    const inputStrafe = kb.inputStrafe + touch.inputStrafe;
    const turn = kb.turn;
    const pitchTurn = kb.pitchTurn;
    const mouseTurnDelta = kb.mouseTurnDelta;
    const mousePitchDelta = kb.mousePitchDelta;
    const jump = kb.jump || touch.jump;
    const attack = kb.attack || touch.attack;
    const dash = kb.dash || touch.dash;
    const smoke = kb.smoke || touch.smoke;
    const standingsHeld = kb.standingsHeld || touch.standingsHeld;

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
      const rows: { userId: number; alive: boolean; kills: number }[] = [{ userId: ctx.selfId, alive: !isDead, kills: selfKills }];
      for (const [userId, peer] of peers) rows.push({ userId, alive: !peer.rig.isDead, kills: peer.kills });
      rows.sort((a, b) => b.kills - a.kills); // highest score first — this is a leaderboard, not a join order list
      for (const r of rows) {
        const info = ctx.participants.find((p) => p.id === r.userId);
        const name = info ? info.display_name || info.username : `user#${r.userId}`;
        const item = document.createElement("li");
        const killLabel = r.kills === 1 ? "1 kill" : `${r.kills} kills`;
        item.textContent = `${name}${r.userId === ctx.selfId ? " (you)" : ""} — ${killLabel} — ${r.alive ? "🟢 Alive" : "💀 Down"}`;
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
    // you're currently moving, or straight backward if you're not
    // moving at all.
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

    if (!isDead) {
      stepPhysics(physics, { moveX, moveZ, jump: playerStunned ? false : jump, speed: isDashing ? DASH_SPEED : undefined }, blocks, dt);
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
    // (facing) is frozen once dead — a lying corpse shouldn't spin.
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
    cooldownHud.update(
      rig.comboState === "cooldown" ? Math.max(0, 1 - (now - rig.stateEnteredAt) / ATTACK_COOLDOWN_MS) : 0,
      Math.max(0, (smokeCooldownUntil - now) / SMOKE_COOLDOWN_MS),
    );

    // Denser than the tick-gated position broadcast below — sent every
    // render frame the swing is actually active, so a fast continuous
    // blade sweep can't slip through the gaps between two ~33ms position
    // ticks. See lubaSocket.ts's sendAttackSample for the full reasoning.
    if (rig.isActiveSwing) socket.sendAttackSample(getSwordWorldSamplePoints(rig));

    // Peers: their swing is mirrored locally and isMoving reflects their
    // actual reported position deltas. Ease their rendered
    // position/facing toward the latest network update. A dead peer
    // plays its own fall-and-lie-flat animation instead, and holds its
    // last-known facing rather than continuing to ease it.
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

    // Per-frame swept-hit sampling — sent to the server whenever the
    // swing is actually active. Sent on the same fixed network tick as
    // position, not every render frame.
    if (now - lastNetworkTickAt >= NETWORK_TICK_MS) {
      lastNetworkTickAt = now;
      const bladePoints = rig.isActiveSwing ? getSwordWorldSamplePoints(rig) : null;
      socket.sendPosition(physics.x, physics.y, physics.z, facingAngle, rig.isActiveSwing, bladePoints);
    }

    if (playerWasActive && !rig.isActiveSwing) {
      status.textContent = "Swing finished.";
    }
    playerWasActive = rig.isActiveSwing;

    // Orbit camera around a pivot near the character's chest/head.
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

  (el as HTMLElement & { _lubaCleanup?: () => void })._lubaCleanup = () => {
    cancelAnimationFrame(rafId);
    input.dispose();
    mobileControls.dispose();
    touchMediaQuery.removeEventListener("change", updateMobileControlsVisibility);
    socket.dispose();
    for (const userId of Array.from(peers.keys())) removePeer(userId);
    disposeRig(rig);
    // A huge dt forces update() straight past its own lifetime, which is
    // what actually removes it from the scene and disposes its
    // geometry/material.
    for (const effect of bloodEffects) effect.update(1000);
    renderer.dispose();
  };
}

const DUMMY_POS = { x: 0, y: 0, z: 4 };
const DUMMY_ATTACK_MIN_MS = 2200;
const DUMMY_ATTACK_MAX_MS = 3400;
const PRACTICE_HIT_RADIUS = 0.5; // matches games/luba/api's HIT_RADIUS
const PRACTICE_RESPAWN_MS = 1800;

// A fully local, non-networked sandbox — no lobby, no WebSocket, just the
// arena/physics/rig/camera/dash/combat code shared with the real match,
// plus a practice dummy that swings on its own timer (always, not
// conditionally, so parry timing can be practiced reliably) and can be
// hit or hit you back. Hit resolution here is client-only (there's no
// server to trust or distrust — the whole point is a private sandbox),
// unlike the real match's server-authoritative check.
export function mountPractice(el: HTMLElement): void {
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

  const mobileControls = createMobileControls();
  canvasWrap.appendChild(mobileControls.el);
  const touchMediaQuery = window.matchMedia("(pointer: coarse), (max-width: 820px)");
  function updateMobileControlsVisibility() {
    mobileControls.setVisible(touchMediaQuery.matches);
  }
  updateMobileControlsVisibility();
  touchMediaQuery.addEventListener("change", updateMobileControlsVisibility);

  wrap.appendChild(canvasWrap);

  const cooldownHud = buildCooldownHud();
  wrap.appendChild(cooldownHud.el);

  // Not appended to the DOM — the on-screen ◀▶ buttons were removed from
  // the web build (the touch HUD's joystick + mouse-look/arrow keys
  // already cover turning; the separate button row below the canvas was
  // redundant clutter). turnButtons.state is still needed as-is below,
  // since createInputState reads rotateButtonState.left/right — it just
  // never gets set to true now that nothing renders these buttons.
  const turnButtons = buildTurnButtons();

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
  const blocks: Block[] = solidBlocks(arena, null);

  const physics: PlayerPhysics = createPlayerPhysics(SPAWN.x, SPAWN.y, SPAWN.z);
  const rig = buildPlayerRig("#f59e0b");
  scene.add(rig.group);

  const dummy = buildPlayerRig("#ef4444");
  dummy.group.position.set(DUMMY_POS.x, DUMMY_POS.y, DUMMY_POS.z);
  scene.add(dummy.group);
  let dummyNextAttackAt = performance.now() + DUMMY_ATTACK_MIN_MS;
  let dummyDeadUntil = 0;

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
  let rafId = 0;

  let playerStunnedUntil = 0;
  let playerWasActive = false;
  let dashingUntil = 0;
  let dashCooldownUntil = 0;
  let dashDirX = 0;
  let dashDirZ = 0;
  let isDead = false;
  let hasReportedFall = false;
  let hitsLanded = 0;
  let timesHit = 0;
  let smokeCooldownUntil = 0;
  const bloodEffects: BloodSprayHandle[] = [];
  const BLOOD_SPRAY_HEIGHT = 1.0;

  function respawnPlayer(now: number) {
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
  function resolveHit(attacker: typeof rig, target: typeof rig): boolean {
    if (!attacker.isActiveSwing || attacker.hasHitThisSwing) return false;
    const points = getSwordWorldSamplePoints(attacker);
    const targetPos = target.group.position;
    const landed = points.some((p) => {
      const dx = p.x - targetPos.x;
      const dz = p.z - targetPos.z;
      return Math.hypot(dx, dz) <= PRACTICE_HIT_RADIUS && p.y >= targetPos.y && p.y <= targetPos.y + PLAYER_HEIGHT + 0.2;
    });
    if (!landed) return false;
    attacker.hasHitThisSwing = true;
    return true;
  }

  function frame(now: number): void {
    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    const kb = input.read();
    const touch = mobileControls.read();
    const inputForward = kb.inputForward + touch.inputForward;
    const inputStrafe = kb.inputStrafe + touch.inputStrafe;
    const { turn, pitchTurn, mouseTurnDelta, mousePitchDelta } = kb;
    const jump = kb.jump || touch.jump;
    const attack = kb.attack || touch.attack;
    const dash = kb.dash || touch.dash;
    const smoke = kb.smoke || touch.smoke;

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

    if (!isDead) {
      stepPhysics(physics, { moveX, moveZ, jump: playerStunned ? false : jump, speed: isDashing ? DASH_SPEED : undefined }, blocks, dt);
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
    cooldownHud.update(
      rig.comboState === "cooldown" ? Math.max(0, 1 - (now - rig.stateEnteredAt) / ATTACK_COOLDOWN_MS) : 0,
      Math.max(0, (smokeCooldownUntil - now) / SMOKE_COOLDOWN_MS),
    );

    if (isDead) updateDeathFall(rig, now);
    else updatePlayerVisual(rig, now, isMoving, dt);

    // Dummy: always swings on its own timer (not conditional on the
    // player's range/facing) so parry timing can be drilled reliably,
    // per earlier playtesting feedback ("make the dummy always slashing
    // so I can test the parry").
    const dummyDead = now < dummyDeadUntil;
    if (!dummyDead && now >= dummyNextAttackAt && dummy.comboState === "idle") {
      tryAttack(dummy, now);
      dummyNextAttackAt = now + DUMMY_ATTACK_MIN_MS + Math.random() * (DUMMY_ATTACK_MAX_MS - DUMMY_ATTACK_MIN_MS);
    }
    if (dummy.isDead) updateDeathFall(dummy, now);
    else updatePlayerVisual(dummy, now, false, dt);

    if (!isDead && !dummyDead) {
      const playerLanded = resolveHit(rig, dummy);
      const dummyLanded = resolveHit(dummy, rig);
      if (playerLanded && dummyLanded) {
        // Both swords land on the same frame — a clash, not a double hit.
        interruptToCooldown(rig, now);
        interruptToCooldown(dummy, now);
        status.textContent = "Parry! Both swords clashed.";
      } else if (playerLanded) {
        hitsLanded++;
        startDeathFall(dummy, now);
        bloodEffects.push(spawnBloodSpray(scene, dummy.group.position.x, dummy.group.position.y + BLOOD_SPRAY_HEIGHT, dummy.group.position.z));
        dummyDeadUntil = now + PRACTICE_RESPAWN_MS;
        status.textContent = "Hit!";
        setTimeout(() => {
          resetAfterRespawn(dummy, performance.now());
          dummy.group.position.set(DUMMY_POS.x, DUMMY_POS.y, DUMMY_POS.z);
          dummyNextAttackAt = performance.now() + DUMMY_ATTACK_MIN_MS;
        }, PRACTICE_RESPAWN_MS);
      } else if (dummyLanded) {
        timesHit++;
        isDead = true;
        startDeathFall(rig, now);
        bloodEffects.push(spawnBloodSpray(scene, physics.x, physics.y + BLOOD_SPRAY_HEIGHT, physics.z));
        status.textContent = "You got hit! Respawning…";
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

  (el as HTMLElement & { _lubaCleanup?: () => void })._lubaCleanup = () => {
    cancelAnimationFrame(rafId);
    input.dispose();
    mobileControls.dispose();
    touchMediaQuery.removeEventListener("change", updateMobileControlsVisibility);
    disposeRig(rig);
    disposeRig(dummy);
    for (const effect of bloodEffects) effect.update(1000);
    renderer.dispose();
  };
}

export function unmount(el: HTMLElement): void {
  const cleanup = (el as HTMLElement & { _lubaCleanup?: () => void })._lubaCleanup;
  if (cleanup) {
    cleanup();
    delete (el as HTMLElement & { _lubaCleanup?: () => void })._lubaCleanup;
  }
}
