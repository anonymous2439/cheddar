// A blocky "Roblox-style" rig — independently colored head/torso/arms/legs,
// each a plain THREE.BoxGeometry — genuinely new geometry (GL Sims' own
// stick-figure rig doesn't fit this game's "blocky avatar" requirement),
// but reusing the exact same conventions GL Sims' character.js already
// established: each limb/torso pre-translates its own geometry so it
// pivots at its joint (shoulder/hip) instead of its center, poses just ease
// rotation values toward a target every frame, and the name label is a
// screen-space-scaled Sprite parented to the group so it always faces the
// camera and reads at a constant size regardless of zoom.
import * as THREE from "three";

const HEAD_SIZE = 0.34;
const TORSO_WIDTH = 0.42;
const TORSO_DEPTH = 0.24;
const TORSO_LEN = 0.55;
const LEG_LEN = 0.55;
const LEG_WIDTH = 0.18;
const LEG_DEPTH = 0.2;
const ARM_LEN = 0.55;
const ARM_WIDTH = 0.16;
const ARM_DEPTH = 0.18;
const ARM_X_OFFSET = TORSO_WIDTH / 2 + ARM_WIDTH / 2;
const LEG_X_OFFSET = TORSO_WIDTH / 4;
const HEAD_Y = LEG_LEN + TORSO_LEN + HEAD_SIZE / 2 + 0.04; // small neck gap

const WALK_FREQUENCY = 6;
const WALK_LEG_SWING = 0.7;
const WALK_ARM_SWING = 0.5;
const POSE_EASE_RATE = 8;

function box(width, depth, length, x, y, color) {
  const geometry = new THREE.BoxGeometry(width, length, depth);
  // Pivot at the top (shoulder/hip), not center — see the file comment.
  geometry.translate(0, -length / 2, 0);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color }));
  mesh.position.set(x, y, 0);
  mesh.castShadow = true;
  return mesh;
}

// A flat smiley decal for the head's own local +Z face — the model's own
// "front" (facingAngle 0 turns the whole rig to face world +Z; see game.js's
// local.facingAngle/atan2 convention and how box()'s "depth" param already
// treats Z as the front-to-back axis for every other limb). A real 3D plane
// parented to the head, not a camera-facing Sprite (like the name label
// below) — the whole point is that it has to rotate WITH the model so
// orbiting the Pose Designer's preview camera around it actually reveals
// which side is front, instead of always facing the viewer regardless.
export function buildFaceMarker() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.strokeStyle = "#000000";
  ctx.fillStyle = "#000000";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(22, 26, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(42, 26, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(32, 28, 16, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
  const marker = new THREE.Mesh(new THREE.PlaneGeometry(HEAD_SIZE * 0.85, HEAD_SIZE * 0.85), material);
  marker.position.z = HEAD_SIZE / 2 + 0.002; // just proud of the head's own front face, avoiding z-fighting
  marker.renderOrder = 1;
  return marker;
}

// The head's local -Z face — opposite buildFaceMarker's own +Z placement.
// Deliberately not another face (a plain dot, in a color that reads as
// "the other one," not a second smiley) — the Pose Designer's own Body
// Rotation slider turns the whole head right along with the body, so the
// front smiley can end up facing away from the camera with nothing telling
// you it's now back there. With both markers, whichever one you're
// currently looking at always tells you the orientation outright, with no
// need to orbit the camera around hunting for the smiley.
export function buildBackMarker() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ef4444";
  ctx.beginPath();
  ctx.arc(32, 32, 20, 0, Math.PI * 2);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
  const marker = new THREE.Mesh(new THREE.PlaneGeometry(HEAD_SIZE * 0.85, HEAD_SIZE * 0.85), material);
  marker.position.z = -(HEAD_SIZE / 2 + 0.002);
  marker.rotation.y = Math.PI; // flips its normal to face outward (-Z), not into the head
  marker.renderOrder = 1;
  return marker;
}

const NAME_LABEL_FONT = "bold 13px sans-serif"; // was 8px — hard to read at a glance, especially wild Glophimon's Lv.N suffix
const NAME_LABEL_HEIGHT = 20;
const NAME_LABEL_PADDING = 5;
const NAME_LABEL_STROKE_WIDTH = 2;

function createNameLabel(name, color = "#ffffff") {
  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");
  measureCtx.font = NAME_LABEL_FONT;
  const textWidth = measureCtx.measureText(name).width;

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(textWidth + NAME_LABEL_PADDING * 2);
  canvas.height = NAME_LABEL_HEIGHT;
  const ctx = canvas.getContext("2d");
  ctx.font = NAME_LABEL_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = NAME_LABEL_STROKE_WIDTH;
  ctx.strokeStyle = "rgba(0,0,0,0.8)";
  ctx.strokeText(name, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = color;
  ctx.fillText(name, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.userData.canvasWidth = canvas.width;
  sprite.userData.canvasHeight = canvas.height;
  sprite.renderOrder = 999;
  return sprite;
}

// colors: { head, body, arm, leg } — hex strings ("#rrggbb"). labelColor
// (also a hex string) lets callers color-code the name label itself — used
// by wild Glophimon spawns to flag difficulty (red/yellow) at a glance;
// everyone else just takes the default white.
export function buildBlockyCharacter(colors, name, labelColor) {
  const group = new THREE.Group(); // position/facing set directly by game.js each frame
  const visual = new THREE.Group(); // cosmetic — walk bob only ever touches this
  group.add(visual);

  const hipY = LEG_LEN;
  const shoulderY = LEG_LEN + TORSO_LEN;

  const torso = box(TORSO_WIDTH, TORSO_DEPTH, TORSO_LEN, 0, shoulderY, colors.body);
  visual.add(torso);

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(HEAD_SIZE, HEAD_SIZE, HEAD_SIZE),
    new THREE.MeshStandardMaterial({ color: colors.head }),
  );
  head.position.y = HEAD_Y;
  head.castShadow = true;
  visual.add(head);

  const leftArm = box(ARM_WIDTH, ARM_DEPTH, ARM_LEN, ARM_X_OFFSET, shoulderY, colors.arm);
  const rightArm = box(ARM_WIDTH, ARM_DEPTH, ARM_LEN, -ARM_X_OFFSET, shoulderY, colors.arm);
  const leftLeg = box(LEG_WIDTH, LEG_DEPTH, LEG_LEN, LEG_X_OFFSET, hipY, colors.leg);
  const rightLeg = box(LEG_WIDTH, LEG_DEPTH, LEG_LEN, -LEG_X_OFFSET, hipY, colors.leg);
  visual.add(leftArm, rightArm, leftLeg, rightLeg);

  const nameLabel = name ? createNameLabel(name, labelColor) : null;
  if (nameLabel) {
    // Child of group (not visual), same reasoning as GL Sims' own rig: it
    // must never inherit the walk-bob pose, and THREE.Sprite always faces
    // the camera regardless of parent rotation.
    nameLabel.position.y = HEAD_Y + HEAD_SIZE / 2 + 0.2;
    group.add(nameLabel);
  }

  return {
    group,
    visual,
    head,
    torso,
    leftArm,
    rightArm,
    leftLeg,
    rightLeg,
    nameLabel,
    walkPhase: 0,
    walkBlend: 0,
    breathPhase: 0,
    targetAnim: null,
  };
}

// Recolors an already-built rig in place — used by the character-creation
// preview (see game.js's mountPreview) so picking a new color updates the
// live 3D preview without rebuilding any geometry, since color pickers fire
// continuously while being dragged.
export function recolorRig(rig, colors) {
  rig.head.material.color.set(colors.head);
  rig.torso.material.color.set(colors.body);
  rig.leftArm.material.color.set(colors.arm);
  rig.rightArm.material.color.set(colors.arm);
  rig.leftLeg.material.color.set(colors.leg);
  rig.rightLeg.material.color.set(colors.leg);
}

function easeTo(current, target, rate, dt) {
  return current + (target - current) * Math.min(1, rate * dt);
}

export function syncNameLabel(rig) {
  if (!rig.nameLabel) return;
  rig.nameLabel.position.y = HEAD_Y + HEAD_SIZE / 2 + 0.2 + rig.visual.position.y;
}

// A slow, gentle head bob layered on top of whatever pose is already
// holding — without it, any standing-still pose (idle, ready) reads as
// completely frozen once its own eased values settle, since none of them
// have any continuous motion of their own. Deliberately head-only, not a
// whole-body offset: moving rig.visual.position.y lifts the legs off the
// ground right along with everything else, which reads as floating/
// flying rather than breathing. head.position.y isn't touched by any
// other pose function, so it's safe to just set outright each frame
// rather than needing to add on top of something else.
const BREATH_FREQUENCY = 1.3;
const BREATH_AMPLITUDE = 0.015;

function applyBreathing(rig, dt) {
  rig.breathPhase += dt * BREATH_FREQUENCY;
  rig.head.position.y = HEAD_Y + Math.sin(rig.breathPhase) * BREATH_AMPLITUDE;
}

// Arms rest slightly away from the body rather than straight down at the
// sides — a dead-straight hang reads as stiff/lifeless at a standstill, and
// this is the one pose everyone (players, peers, every Glophimon) sits in
// most of the time. Only a lateral spread (rotation.z) — the forward/back
// swing (rotation.x) still eases to 0, unlike walking/attacking, which both
// drive rotation.x directly and reset .z back to neutral before doing so.
const IDLE_ARM_SPREAD = 0.16;

export function applyIdlePose(rig, dt) {
  rig.leftArm.rotation.x = easeTo(rig.leftArm.rotation.x, 0, POSE_EASE_RATE, dt);
  rig.rightArm.rotation.x = easeTo(rig.rightArm.rotation.x, 0, POSE_EASE_RATE, dt);
  rig.leftArm.rotation.z = easeTo(rig.leftArm.rotation.z, IDLE_ARM_SPREAD, POSE_EASE_RATE, dt);
  rig.rightArm.rotation.z = easeTo(rig.rightArm.rotation.z, -IDLE_ARM_SPREAD, POSE_EASE_RATE, dt);
  rig.leftLeg.rotation.x = easeTo(rig.leftLeg.rotation.x, 0, POSE_EASE_RATE, dt);
  rig.rightLeg.rotation.x = easeTo(rig.rightLeg.rotation.x, 0, POSE_EASE_RATE, dt);
  rig.visual.position.y = easeTo(rig.visual.position.y, 0, POSE_EASE_RATE, dt);
  rig.walkBlend = easeTo(rig.walkBlend, 0, POSE_EASE_RATE, dt);
  applyBreathing(rig, dt);
}

// speedMult (default 1) scales how fast the cycle itself advances — used
// for sprinting (see game.js's own stamina/Shift handling), so a run
// actually reads as faster leg/arm turnover, not just a faster-sliding
// walk cycle.
export function updateWalkCycle(rig, dt, speedMult = 1) {
  rig.walkBlend = easeTo(rig.walkBlend, 1, POSE_EASE_RATE, dt);
  rig.walkPhase += dt * WALK_FREQUENCY * speedMult;
  const legSwing = Math.sin(rig.walkPhase) * WALK_LEG_SWING * rig.walkBlend;
  const armSwing = Math.sin(rig.walkPhase) * WALK_ARM_SWING * rig.walkBlend;
  rig.leftLeg.rotation.x = legSwing;
  rig.rightLeg.rotation.x = -legSwing;
  rig.leftArm.rotation.x = -armSwing;
  rig.rightArm.rotation.x = armSwing;
  rig.leftArm.rotation.z = 0; // clears the idle spread — a clean forward/back swing while actually walking
  rig.rightArm.rotation.z = 0;
  const footfall = Math.abs(Math.sin(rig.walkPhase)) * rig.walkBlend;
  rig.visual.position.y = footfall * 0.03 * Math.min(1.3, speedMult); // a slightly higher bob while sprinting
}

// A single forward swing-through — elapsedMs/totalMs is this move's own
// progress (same convention as GL Sims' own applyHitWindupPose/
// applyHitSwingPose), not eased toward a target: both arms swing forward
// and the torso lunges into the hit, then fully resets to neutral once the
// window ends (game.js's own per-frame driver clears the animation and
// falls back to applyIdlePose right after, so no explicit "ease back out"
// tail is needed here).
const ATTACK_ARM_SWING = 1.6;
const ATTACK_LUNGE = 0.26; // a real forward hop, not just a lean — was 0.18
const ATTACK_LEG_SPREAD = 0.5; // splayed outward at the swing's peak, so a full-blast attack reads as a wide braced stance, not just arm-waving
const ATTACK_JUMP_HEIGHT = 0.16; // leaves the ground at the swing's peak, landing back down by the end of the window

export function applyAttackPose(rig, elapsedMs, totalMs) {
  const t = Math.min(1, elapsedMs / totalMs);
  const swing = Math.sin(t * Math.PI); // 0 -> 1 -> 0 across the window
  rig.rightArm.rotation.x = -ATTACK_ARM_SWING * swing;
  rig.leftArm.rotation.x = -ATTACK_ARM_SWING * 0.5 * swing;
  rig.leftArm.rotation.z = 0; // clears the idle spread for a clean forward swing
  rig.rightArm.rotation.z = 0;
  rig.visual.position.z = -ATTACK_LUNGE * swing;
  rig.visual.position.y = ATTACK_JUMP_HEIGHT * swing;
  rig.leftLeg.rotation.z = ATTACK_LEG_SPREAD * swing;
  rig.rightLeg.rotation.z = -ATTACK_LEG_SPREAD * swing;
}

// A hit reaction — recoils backward and away rather than bracing forward
// into a guard: leans/steps back and the arms fling backward, same "quick
// snap in, held, eased back out" envelope shape as before (still reads as
// a held reaction rather than an instant snap), just a different direction
// of motion since "defending" here means "got hit and staggered," not
// "blocked."
const DEFEND_ARM_BACK = 1.0;
const DEFEND_LEAN_BACK = 0.22;
const DEFEND_HOLD_START = 0.15;
const DEFEND_HOLD_END = 0.8;

export function applyDefendPose(rig, elapsedMs, totalMs) {
  const t = Math.min(1, elapsedMs / totalMs);
  let amount;
  if (t < DEFEND_HOLD_START) amount = t / DEFEND_HOLD_START;
  else if (t < DEFEND_HOLD_END) amount = 1;
  else amount = Math.max(0, 1 - (t - DEFEND_HOLD_END) / (1 - DEFEND_HOLD_END));
  rig.leftArm.rotation.z = 0; // clears the idle spread
  rig.rightArm.rotation.z = 0;
  rig.leftArm.rotation.x = DEFEND_ARM_BACK * amount;
  rig.rightArm.rotation.x = DEFEND_ARM_BACK * amount;
  rig.visual.position.z = DEFEND_LEAN_BACK * amount; // staggers backward, away from the attacker
}

// Taking a hit — a quick, involuntary snap-back, not a held stagger like
// Defend above: a sharp jolt away from the hit plus a slight sideways
// stumble, spiking almost immediately then easing back out over the rest
// of the window, so it reads as "ow" rather than "bracing." Same fixed-
// envelope elapsedMs/totalMs convention as Attack/Cast — one shot, then
// game.js's own per-frame driver falls back to idle/walk once it ends.
const FLINCH_LEAN_BACK = 0.16;
const FLINCH_SIDE_STEP = 0.06;
const FLINCH_ARM_FLING = 0.6;
const FLINCH_SPIKE_FRACTION = 0.2; // reaches full amount almost immediately...
const FLINCH_RECOVER_START = 0.35; // ...holds only briefly, then eases back out the rest of the way

export function applyFlinchPose(rig, elapsedMs, totalMs) {
  const t = Math.min(1, elapsedMs / totalMs);
  let amount;
  if (t < FLINCH_SPIKE_FRACTION) amount = t / FLINCH_SPIKE_FRACTION;
  else if (t < FLINCH_RECOVER_START) amount = 1;
  else amount = Math.max(0, 1 - (t - FLINCH_RECOVER_START) / (1 - FLINCH_RECOVER_START));
  rig.leftArm.rotation.z = 0; // clears the idle spread
  rig.rightArm.rotation.z = 0;
  rig.leftArm.rotation.x = FLINCH_ARM_FLING * amount;
  rig.rightArm.rotation.x = FLINCH_ARM_FLING * amount;
  rig.visual.position.z = FLINCH_LEAN_BACK * amount;
  rig.visual.position.x = FLINCH_SIDE_STEP * amount;
}

// Heal/buff/debuff moves (see game.js's own MOVES_BY_SPECIES) all reuse
// this one "casting something" pose rather than a pose per move kind —
// both arms raised overhead with a small hop, a silhouette distinct from
// Attack's forward lunge-and-swing and Defend's backward stagger, same
// fixed-envelope sin(t*PI) shape as Attack so it reads as one deliberate
// action rather than a held/sustained state like Ready.
const CAST_ARM_RAISE = 1.4;
const CAST_HOP_HEIGHT = 0.1;

export function applyCastPose(rig, elapsedMs, totalMs) {
  const t = Math.min(1, elapsedMs / totalMs);
  const raise = Math.sin(t * Math.PI);
  rig.leftArm.rotation.x = -CAST_ARM_RAISE * raise;
  rig.rightArm.rotation.x = -CAST_ARM_RAISE * raise;
  rig.leftArm.rotation.z = 0; // clears the idle spread
  rig.rightArm.rotation.z = 0;
  rig.visual.position.y = CAST_HOP_HEIGHT * raise;
}

// "It's my turn" cue — held (not a fixed-duration envelope like Attack/
// Defend above) for as long as this Glophimon is the current attacker
// awaiting the defender's response: left arm raised, leaning a step
// forward, eased in the same easeTo style as applyIdlePose rather than a
// sin-envelope, since there's no fixed end time — game.js's own per-frame
// driver just overwrites this with the real applyAttackPose swing the
// instant the exchange actually resolves.
const READY_ARM_RAISE = 1.3;
const READY_LEAN_FORWARD = 0.15;

export function applyReadyPose(rig, dt) {
  rig.leftArm.rotation.x = easeTo(rig.leftArm.rotation.x, -READY_ARM_RAISE, POSE_EASE_RATE, dt);
  rig.rightArm.rotation.x = easeTo(rig.rightArm.rotation.x, 0, POSE_EASE_RATE, dt);
  rig.leftArm.rotation.z = easeTo(rig.leftArm.rotation.z, 0, POSE_EASE_RATE, dt);
  rig.rightArm.rotation.z = easeTo(rig.rightArm.rotation.z, 0, POSE_EASE_RATE, dt);
  rig.visual.position.z = easeTo(rig.visual.position.z, -READY_LEAN_FORWARD, POSE_EASE_RATE, dt);
  applyBreathing(rig, dt);
}

// A wild mob's own death collapse (see game.js's own startWildDeath) — one-
// directional, unlike every pose above: topples sideways and sinks partway
// into the ground over DEATH_FALL_MS, then just HOLDS there (never eases
// back to idle) for however much longer game.js's own fade-then-remove
// timeline keeps this rig around. elapsedMs is this whole dying lifetime,
// not re-zeroed at any hold boundary the way Attack/Flinch's own fixed-
// envelope elapsedMs/totalMs pairs are — Math.min below just clamps the
// fall's own progress once it's done collapsing.
const DEATH_FALL_MS = 500;
const DEATH_TOPPLE_ROTATION = (Math.PI / 2) * 0.85; // short of fully flat — reads as "collapsed," not "pancaked"
const DEATH_SINK = 0.22;

export function applyDeathPose(rig, elapsedMs) {
  const t = Math.min(1, elapsedMs / DEATH_FALL_MS);
  const eased = 1 - Math.pow(1 - t, 3); // ease-out — a believable deceleration into the ground, not a linear tip
  rig.leftArm.rotation.x = 0;
  rig.rightArm.rotation.x = 0;
  rig.leftArm.rotation.z = 0;
  rig.rightArm.rotation.z = 0;
  rig.leftLeg.rotation.x = 0;
  rig.rightLeg.rotation.x = 0;
  rig.visual.rotation.z = DEATH_TOPPLE_ROTATION * eased;
  rig.visual.position.y = -DEATH_SINK * eased;
}

// "Who's being targeted" cue — a brief red emissive flash on every mesh of
// the rig, independent of (and layered on top of) whatever pose-anim is
// already driving that same rig (a defender that's also guarding needs to
// show the guard pose AND the flash at once, so this can't just be another
// `anim.type` in the same single-slot state machine those use). Purely
// additive on top of the material's own base color via `emissive`, so
// there's nothing to restore once it fades — easing emissiveIntensity back
// to 0 is enough.
const TARGET_FLASH_MS = 450;
const TARGET_FLASH_COLOR = new THREE.Color("#ff3b3b");
const TARGET_FLASH_PEAK = 0.85;

export function updateTargetFlash(rig, dt) {
  if (!rig.targetAnim) return;
  rig.targetAnim.elapsedMs += dt * 1000;
  const t = Math.min(1, rig.targetAnim.elapsedMs / TARGET_FLASH_MS);
  const intensity = Math.sin(t * Math.PI) * TARGET_FLASH_PEAK;
  rig.group.traverse((obj) => {
    if (obj.isMesh && obj.material && obj.material.emissive) {
      obj.material.emissive.set(TARGET_FLASH_COLOR);
      obj.material.emissiveIntensity = intensity;
    }
  });
  if (rig.targetAnim.elapsedMs >= TARGET_FLASH_MS) {
    rig.targetAnim = null;
    rig.group.traverse((obj) => {
      if (obj.isMesh && obj.material && obj.material.emissive) obj.material.emissiveIntensity = 0;
    });
  }
}

export function scaleNameLabel(rig, camera, viewportHeightPx, visible = true) {
  if (!rig.nameLabel) return;
  rig.nameLabel.visible = visible;
  if (!visible) return; // skip the scaling work below too — nothing to show
  const anchor = rig.group.position;
  const dx = camera.position.x - anchor.x;
  const dy = camera.position.y - anchor.y;
  const dz = camera.position.z - anchor.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const verticalFovRad = (camera.fov * Math.PI) / 180;
  const worldUnitsPerScreenPixel = (2 * distance * Math.tan(verticalFovRad / 2)) / viewportHeightPx;
  rig.nameLabel.scale.set(
    rig.nameLabel.userData.canvasWidth * worldUnitsPerScreenPixel,
    rig.nameLabel.userData.canvasHeight * worldUnitsPerScreenPixel,
    1,
  );
}

export function disposeRig(rig) {
  rig.group.traverse((obj) => {
    if (obj.isMesh) {
      obj.geometry.dispose();
      obj.material.dispose();
    }
  });
  if (rig.nameLabel) {
    rig.nameLabel.material.map.dispose();
    rig.nameLabel.material.dispose();
  }
}

// A Glophiball — the thrown capture device (see game.js's own catch
// animation, which throws/shrinks a wild Glophimon into one of these then
// shakes it before revealing whether the catch worked). Two-tone sphere +
// a dark center band + a small front "button," the same generic
// three-part capsule shape as any catch-device toy, built out of plain
// primitives like every other model in this file rather than a loaded
// asset.
const GLOPHIBALL_RADIUS = 0.16;

export function buildGlophiballMesh() {
  const group = new THREE.Group();

  const top = new THREE.Mesh(
    new THREE.SphereGeometry(GLOPHIBALL_RADIUS, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: "#38bdf8" }),
  );
  group.add(top);

  const bottom = new THREE.Mesh(
    new THREE.SphereGeometry(GLOPHIBALL_RADIUS, 20, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: "#f4f4f5" }),
  );
  group.add(bottom);

  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(GLOPHIBALL_RADIUS * 1.03, GLOPHIBALL_RADIUS * 1.03, GLOPHIBALL_RADIUS * 0.2, 20),
    new THREE.MeshStandardMaterial({ color: "#18181b" }),
  );
  group.add(band);

  const button = new THREE.Mesh(
    new THREE.CircleGeometry(GLOPHIBALL_RADIUS * 0.3, 16),
    new THREE.MeshStandardMaterial({ color: "#f4f4f5" }),
  );
  button.position.set(0, 0, GLOPHIBALL_RADIUS * 0.99);
  group.add(button);

  const buttonRing = new THREE.Mesh(
    new THREE.RingGeometry(GLOPHIBALL_RADIUS * 0.3, GLOPHIBALL_RADIUS * 0.38, 16),
    new THREE.MeshStandardMaterial({ color: "#18181b" }),
  );
  buttonRing.position.set(0, 0, GLOPHIBALL_RADIUS * 0.995);
  group.add(buttonRing);

  return group;
}

export function disposeGlophiball(group) {
  group.traverse((obj) => {
    if (obj.isMesh) {
      obj.geometry.dispose();
      obj.material.dispose();
    }
  });
}
