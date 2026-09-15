// Simple low-poly stick-figure rig — thin cylinder limbs pivoted at the
// top joint (same trick as Luba's player.js: pre-translate each limb's
// own geometry so it rotates like a real joint instead of a bar clipping
// through its parent), a sphere head, and a wide box torso (also
// pivoted at the top, same trick). Deliberately much simpler than Luba's
// blocky rig — GL Sims is about a crowd of characters and their
// autonomous behavior, not a single detailed fighter.
import * as THREE from "three";

const HEAD_RADIUS = 0.14;
const SPINE_LEN = 0.5;
export const LEG_LEN = 0.8;
const ARM_LEN = 0.55;
const LIMB_RADIUS = 0.045;
// A boxy torso rather than a thin spine cylinder — much wider left-to-right
// than it is deep, for a broader-bodied look instead of a literal stick.
const TORSO_WIDTH = 0.34;
const TORSO_DEPTH = 0.18;
const LIMB_SEGMENTS = 6; // low-poly on purpose, matches the "simple stick figure" look
// Arm/leg mount offsets widened to match the wider torso — arms sit just
// outside the torso's half-width, legs proportionally further apart too.
const ARM_X_OFFSET = 0.21;
const LEG_X_OFFSET = 0.13;
// Shared by buildStickFigure (initial head placement) and any pose that
// needs to reference/restore the head's neutral position (e.g. after
// applyKissPose's forward head-reach).
const HEAD_Y = LEG_LEN + SPINE_LEN + HEAD_RADIUS * 1.3;

const WALK_FREQUENCY = 6;
const WALK_LEG_SWING = 0.7;
const WALK_ARM_SWING = 0.5;
const POSE_EASE_RATE = 8; // how fast poses blend toward their target each frame, not a duration

function limb(radius, length, x, y, color) {
  const geometry = new THREE.CylinderGeometry(radius, radius, length, LIMB_SEGMENTS);
  // Pivot at the top (shoulder/hip), not center — see the file comment.
  geometry.translate(0, -length / 2, 0);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color }));
  mesh.position.set(x, y, 0);
  mesh.castShadow = true;
  return mesh;
}

function torso(width, depth, length, x, y, color) {
  const geometry = new THREE.BoxGeometry(width, length, depth);
  // Same pivot-at-top convention as limb() above.
  geometry.translate(0, -length / 2, 0);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color }));
  mesh.position.set(x, y, 0);
  mesh.castShadow = true;
  return mesh;
}

// Simple drawn-on facial expressions — a small plane mounted just proud of
// the head sphere's front surface, textured with one of a handful of tiny
// canvas-drawn faces swapped per state (see setFaceExpression, called from
// simulation.js's updateCharacter and conversation.js's updateGhostSlots).
// The four textures are built once and shared by every rig (identical
// bitmaps regardless of who's wearing them) — each rig gets its own plane
// geometry/material instance so swapping one character's expression never
// affects anyone else's, and disposeRig can safely dispose that per-rig
// material without touching the shared textures other rigs still use.
const FACE_SIZE = 40; // canvas px — kept small since HEAD_RADIUS itself renders tiny on screen; bold shapes read better than fine detail at this scale
const FACE_PLANE_SIZE = HEAD_RADIUS * 1.3;

function drawNeutralFace(ctx) {
  const s = FACE_SIZE;
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  ctx.arc(s * 0.34, s * 0.42, s * 0.06, 0, Math.PI * 2);
  ctx.arc(s * 0.66, s * 0.42, s * 0.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = s * 0.05;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(s * 0.36, s * 0.66);
  ctx.lineTo(s * 0.64, s * 0.66);
  ctx.stroke();
}

function drawKissFace(ctx) {
  const s = FACE_SIZE;
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = s * 0.05;
  ctx.lineCap = "round";
  // Closed eyes — little upward-opening arcs, not dots.
  ctx.beginPath();
  ctx.arc(s * 0.34, s * 0.44, s * 0.07, Math.PI, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(s * 0.66, s * 0.44, s * 0.07, Math.PI, 0);
  ctx.stroke();
  // Puckered lips.
  ctx.fillStyle = "#d1466b";
  ctx.beginPath();
  ctx.ellipse(s * 0.5, s * 0.68, s * 0.07, s * 0.09, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawAngryFace(ctx) {
  const s = FACE_SIZE;
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = s * 0.06;
  ctx.lineCap = "round";
  // Eyebrows angled down toward the center — the single biggest "angry" cue.
  ctx.beginPath();
  ctx.moveTo(s * 0.2, s * 0.26);
  ctx.lineTo(s * 0.42, s * 0.4);
  ctx.moveTo(s * 0.8, s * 0.26);
  ctx.lineTo(s * 0.58, s * 0.4);
  ctx.stroke();
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  ctx.arc(s * 0.34, s * 0.5, s * 0.05, 0, Math.PI * 2);
  ctx.arc(s * 0.66, s * 0.5, s * 0.05, 0, Math.PI * 2);
  ctx.fill();
  // Frown.
  ctx.lineWidth = s * 0.05;
  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.86, s * 0.18, Math.PI * 1.15, Math.PI * 1.85);
  ctx.stroke();
}

function drawConfusedFace(ctx) {
  const s = FACE_SIZE;
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = s * 0.05;
  ctx.lineCap = "round";
  // Asymmetric eyebrows — one raised/arched, one flat — is what reads as
  // "confused" rather than any other expression.
  ctx.beginPath();
  ctx.arc(s * 0.34, s * 0.32, s * 0.08, Math.PI * 1.1, Math.PI * 1.9);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s * 0.58, s * 0.34);
  ctx.lineTo(s * 0.78, s * 0.34);
  ctx.stroke();
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  ctx.arc(s * 0.34, s * 0.48, s * 0.05, 0, Math.PI * 2);
  ctx.arc(s * 0.66, s * 0.48, s * 0.05, 0, Math.PI * 2);
  ctx.fill();
  // Wavy, slightly puzzled mouth.
  ctx.beginPath();
  ctx.moveTo(s * 0.35, s * 0.68);
  ctx.quadraticCurveTo(s * 0.46, s * 0.6, s * 0.5, s * 0.68);
  ctx.quadraticCurveTo(s * 0.54, s * 0.76, s * 0.65, s * 0.68);
  ctx.stroke();
}

let _faceTextures = null;
function faceTextures() {
  if (_faceTextures) return _faceTextures;
  const build = (draw) => {
    const canvas = document.createElement("canvas");
    canvas.width = FACE_SIZE;
    canvas.height = FACE_SIZE;
    draw(canvas.getContext("2d"));
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    return texture;
  };
  _faceTextures = {
    neutral: build(drawNeutralFace),
    kiss: build(drawKissFace),
    angry: build(drawAngryFace),
    confused: build(drawConfusedFace),
  };
  return _faceTextures;
}

// Swaps the given rig's face texture — called every frame from
// simulation.js's updateCharacter (neutral by default, overridden for
// kissing/fighting/conv_talking) and conversation.js's updateGhostSlots
// (confused while a ghost is actively holding the floor). Reassigning the
// same texture it's already showing is a harmless no-op, so callers don't
// need to track "did this already change" themselves.
export function setFaceExpression(rig, expression) {
  if (!rig.face) return;
  const texture = faceTextures()[expression] ?? faceTextures().neutral;
  if (rig.face.material.map !== texture) {
    rig.face.material.map = texture;
    rig.face.material.needsUpdate = true;
  }
}

export function buildStickFigure(color, name) {
  const group = new THREE.Group(); // position/facing set directly by simulation.js each frame
  const visual = new THREE.Group(); // cosmetic — walk bob/sit/gesture poses only ever touch this
  group.add(visual);

  const hipY = LEG_LEN;
  const shoulderY = LEG_LEN + SPINE_LEN;

  const spine = torso(TORSO_WIDTH, TORSO_DEPTH, SPINE_LEN, 0, shoulderY, color);
  visual.add(spine);

  const head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS, 10, 8), new THREE.MeshStandardMaterial({ color }));
  head.position.y = HEAD_Y;
  head.castShadow = true;
  visual.add(head);

  // A child of head (not visual) so it automatically tracks the head's own
  // position — including the forward reach/bob applyKissPose gives it —
  // without needing separate per-frame positioning of its own. Just proud
  // of the sphere's own surface (>HEAD_RADIUS) to avoid z-fighting/
  // clipping into it. Unlit (MeshBasicMaterial) and double-sided so it
  // reads as flat drawn-on artwork regardless of scene lighting or which
  // way the character currently faces.
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(FACE_PLANE_SIZE, FACE_PLANE_SIZE),
    new THREE.MeshBasicMaterial({ map: faceTextures().neutral, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
  );
  face.position.z = HEAD_RADIUS * 1.05;
  head.add(face);

  // Arms/legs mounted just outside the torso's own width — purely
  // cosmetic spacing, this rig has no left/right-specific meaning the way
  // Luba's sword-arm did.
  const leftArm = limb(LIMB_RADIUS, ARM_LEN, ARM_X_OFFSET, shoulderY, color);
  const rightArm = limb(LIMB_RADIUS, ARM_LEN, -ARM_X_OFFSET, shoulderY, color);
  const leftLeg = limb(LIMB_RADIUS, LEG_LEN, LEG_X_OFFSET, hipY, color);
  const rightLeg = limb(LIMB_RADIUS, LEG_LEN, -LEG_X_OFFSET, hipY, color);
  visual.add(leftArm, rightArm, leftLeg, rightLeg);

  const nameLabel = name ? createNameLabel(name) : null;
  if (nameLabel) {
    // Attached to group (not visual) so the label's position tracks the
    // character but never inherits the visual group's lean/bob poses —
    // and since THREE.Sprite always faces the camera regardless of parent
    // rotation, it also stays readable no matter which way the character
    // is currently facing (rotation.y on group).
    nameLabel.position.y = HEAD_Y + HEAD_RADIUS + 0.2;
    group.add(nameLabel);
  }

  return {
    group,
    visual,
    head,
    face,
    leftArm,
    rightArm,
    leftLeg,
    rightLeg,
    nameLabel,
    walkPhase: 0,
    walkBlend: 0,
    dancePhase: 0,
  };
}

// "Ghost angel" — a temporary stand-in for a conversation line whose real
// speaker isn't one of the 25 roster racers (see conversation.js's ghost
// slot system: at most 2 of these exist at once, reused across whichever
// non-racer names come up, not one per unique person). Reuses the exact
// same stick-figure rig rather than a separate build path — just recolored
// pale/translucent with a halo added on top — so it reads as "one of
// these people, but a ghost" rather than a completely different character
// design. No name label of its own (unlike every other character here) —
// it's a temporary stand-in, and its name already shows in its chat
// bubble, so a floating tag above its head would just be redundant.
const GHOST_COLOR = "#f5f5ff";
const GHOST_OPACITY = 0.72;
const GHOST_HALO_RADIUS = 0.1;
const GHOST_HALO_TUBE = 0.012;
const GHOST_HALO_COLOR = "#fff6c9";

function buildGhostHalo() {
  const geometry = new THREE.TorusGeometry(GHOST_HALO_RADIUS, GHOST_HALO_TUBE, 8, 20);
  const material = new THREE.MeshStandardMaterial({
    color: GHOST_HALO_COLOR,
    emissive: GHOST_HALO_COLOR,
    emissiveIntensity: 0.7,
    transparent: true,
    opacity: 0.9,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = Math.PI / 2; // lie flat, ring-above-the-head orientation
  mesh.position.y = HEAD_Y + HEAD_RADIUS * 2.4;
  return mesh;
}

// Same buildStickFigure everyone else uses, just with every mesh's
// material recolored translucent, no name (buildStickFigure only builds a
// label when given one), and a halo added on top — deliberately not a
// parallel rig-building path, so poses (applyIdlePose etc.) and disposeRig
// all keep working on a ghost's rig completely unchanged.
export function buildGhostAngel() {
  const rig = buildStickFigure(GHOST_COLOR, null);
  rig.visual.traverse((obj) => {
    if (obj.isMesh) {
      obj.material.transparent = true;
      obj.material.opacity = GHOST_OPACITY;
      obj.material.depthWrite = false;
    }
  });
  rig.visual.add(buildGhostHalo());
  return rig;
}

// Same font size as the chat bubble (see BUBBLE_FONT below) per explicit
// request — "not too big". Sized to the actual text (no fixed base width
// clipping long names like "Elieser Tajanlangit") and, like the chat
// bubble, kept at a constant *screen* size regardless of camera zoom —
// see scaleNameLabel, called every frame for every character from
// game.js, unlike the chat bubble which only exists while someone's
// actually talking.
const NAME_LABEL_FONT = "bold 8px sans-serif";
const NAME_LABEL_HEIGHT = 13;
const NAME_LABEL_PADDING = 4;
const NAME_LABEL_STROKE_WIDTH = 1.5;

function createNameLabel(name) {
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
  ctx.fillStyle = "#ffffff";
  ctx.fillText(name, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  // depthTest off + a high renderOrder so a name tag always reads clearly
  // above whoever it belongs to, even from behind another character
  // standing in front — a nameplate is UI, not scene geometry.
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  // Raw canvas pixel dimensions, not a world-space size — scaleNameLabel
  // (called every frame from game.js) is what actually sizes it, same
  // approach as createChatBubble's sprite.userData below.
  sprite.userData.canvasWidth = canvas.width;
  sprite.userData.canvasHeight = canvas.height;
  sprite.renderOrder = 999;
  return sprite;
}

function easeTo(current, target, rate, dt) {
  return current + (target - current) * Math.min(1, rate * dt);
}

// The label is a child of group rather than visual specifically so it
// never inherits visual's lean/twist rotations (see buildStickFigure) —
// but that means it doesn't automatically follow visual.position.y either,
// so poses that meaningfully move the body vertically (sitting drops it
// by roughly a leg's length) need this called once a frame to keep the
// label attached to the head instead of floating at standing height.
export function syncNameLabel(rig) {
  if (!rig.nameLabel) return;
  rig.nameLabel.position.y = HEAD_Y + HEAD_RADIUS + 0.2 + rig.visual.position.y;
}

// Neutral standing pose — eases every pose value back toward rest. Used
// whenever a character is just standing idle, and as the general "settle
// back to neutral" for anything not actively driving its own pose.
export function applyIdlePose(rig, dt) {
  rig.leftArm.rotation.x = easeTo(rig.leftArm.rotation.x, 0, POSE_EASE_RATE, dt);
  rig.rightArm.rotation.x = easeTo(rig.rightArm.rotation.x, 0, POSE_EASE_RATE, dt);
  rig.leftArm.rotation.z = easeTo(rig.leftArm.rotation.z, 0, POSE_EASE_RATE, dt);
  rig.rightArm.rotation.z = easeTo(rig.rightArm.rotation.z, 0, POSE_EASE_RATE, dt);
  rig.leftLeg.rotation.x = easeTo(rig.leftLeg.rotation.x, 0, POSE_EASE_RATE, dt);
  rig.rightLeg.rotation.x = easeTo(rig.rightLeg.rotation.x, 0, POSE_EASE_RATE, dt);
  rig.visual.position.x = easeTo(rig.visual.position.x, 0, POSE_EASE_RATE, dt);
  rig.visual.position.y = easeTo(rig.visual.position.y, 0, POSE_EASE_RATE, dt);
  rig.visual.rotation.x = easeTo(rig.visual.rotation.x, 0, POSE_EASE_RATE, dt);
  rig.visual.rotation.y = easeTo(rig.visual.rotation.y, 0, POSE_EASE_RATE, dt);
  rig.head.position.z = easeTo(rig.head.position.z, 0, POSE_EASE_RATE, dt);
  rig.head.position.y = easeTo(rig.head.position.y, HEAD_Y, POSE_EASE_RATE, dt);
  rig.walkBlend = easeTo(rig.walkBlend, 0, POSE_EASE_RATE, dt);
}

// Classic alternating walk — opposite arm swings with the opposite leg,
// unlike Luba's ninja-run (both arms trailing back), since GL Sims'
// characters are just casually wandering, not sprinting into a fight.
export function updateWalkCycle(rig, dt) {
  rig.walkBlend = easeTo(rig.walkBlend, 1, POSE_EASE_RATE, dt);
  rig.walkPhase += dt * WALK_FREQUENCY;
  const legSwing = Math.sin(rig.walkPhase) * WALK_LEG_SWING * rig.walkBlend;
  const armSwing = Math.sin(rig.walkPhase) * WALK_ARM_SWING * rig.walkBlend;
  rig.leftLeg.rotation.x = legSwing;
  rig.rightLeg.rotation.x = -legSwing;
  rig.leftArm.rotation.x = -armSwing;
  rig.rightArm.rotation.x = armSwing;
  const footfall = Math.abs(Math.sin(rig.walkPhase)) * rig.walkBlend;
  rig.visual.position.y = footfall * 0.03;
  rig.visual.rotation.x = easeTo(rig.visual.rotation.x, 0, POSE_EASE_RATE, dt);
}

// A single-segment leg can't really bend at a knee, so "sitting" here
// means legs rotated to fully horizontal (straight out in front) with the
// whole body lowered to match — a rough approximation, but a geometrically
// consistent one. The leg pivots at the hip (visual-local height LEG_LEN);
// rotating it to exactly -π/2 swings the foot to the *same* height as the
// hip instead of partway between standing and horizontal, so hip and foot
// land at the same height after the drop below and neither ends up
// floating above or clipping below the ground. The previous version used
// a smaller rotation (-1.3 rad, short of horizontal) with an arbitrary
// -0.25 drop that didn't match either the leg length or that angle, which
// left the whole seated body hovering above the ground.
const SIT_LEG_ANGLE = -Math.PI / 2;
const SIT_GROUND_CLEARANCE = 0.04;
const SIT_HIP_DROP = LEG_LEN - SIT_GROUND_CLEARANCE;

export function applySitPose(rig, dt) {
  rig.leftLeg.rotation.x = easeTo(rig.leftLeg.rotation.x, SIT_LEG_ANGLE, POSE_EASE_RATE, dt);
  rig.rightLeg.rotation.x = easeTo(rig.rightLeg.rotation.x, SIT_LEG_ANGLE, POSE_EASE_RATE, dt);
  rig.leftArm.rotation.x = easeTo(rig.leftArm.rotation.x, 0, POSE_EASE_RATE, dt);
  rig.rightArm.rotation.x = easeTo(rig.rightArm.rotation.x, 0, POSE_EASE_RATE, dt);
  rig.visual.position.y = easeTo(rig.visual.position.y, -SIT_HIP_DROP, POSE_EASE_RATE, dt);
  rig.visual.rotation.x = easeTo(rig.visual.rotation.x, 0, POSE_EASE_RATE, dt);
  rig.walkBlend = easeTo(rig.walkBlend, 0, POSE_EASE_RATE, dt);
}

// Wind-up (arm raised) before the actual swing — elapsedMs/totalMs is
// this sub-phase's own progress, not the whole interaction's.
export function applyHitWindupPose(rig, elapsedMs, totalMs) {
  const t = Math.min(1, elapsedMs / totalMs);
  const eased = Math.sin(t * Math.PI * 0.5);
  rig.rightArm.rotation.x = -1.6 * eased;
  rig.rightArm.rotation.z = -0.3 * eased;
}

// The actual slap/swing, from the raised wind-up down across the front.
export function applyHitSwingPose(rig, elapsedMs, totalMs) {
  const t = Math.min(1, elapsedMs / totalMs);
  const eased = Math.sin(t * Math.PI * 0.5);
  rig.rightArm.rotation.x = -1.6 + 1.9 * eased;
  rig.rightArm.rotation.z = -0.3 + 0.6 * eased;
}

// The target's brief stumble-back reaction to being hit — a quick lean
// away that rises then settles back to neutral.
export function applyReactPose(rig, elapsedMs, totalMs) {
  const t = Math.min(1, elapsedMs / totalMs);
  const eased = Math.sin(t * Math.PI);
  rig.visual.rotation.x = -0.35 * eased;
}

// A slow, lingering embrace: ease in over the first couple seconds, hold
// for nearly the whole ~30s duration with a slight sway so two characters
// don't just freeze like statues, then ease back out at the end.
const KISS_RAMP_IN_MS = 2200;
const KISS_RAMP_OUT_MS = 3000;
// Shallower still than an already-reduced earlier pass (0.15 rad) — per
// explicit request to cut down how heavily they have to bend. Tuned
// together with INTIMATE_DISTANCE in simulation.js (0.75 → 0.5): with
// bodies already pulled in closer, bridging the remaining gap needs much
// less forward tilt than before.
const KISS_LEAN_MAX = 0.08;
// The "touches" — arms rise off the sides and reach forward, as if
// wrapping around the partner. This rig has no hands/fingers, so this is
// as literal as an embrace gets here. Each arm slowly alternates between a
// high reach (toward the partner's head/face) and a lower one (toward
// their hips), out of phase with each other, so the two arms don't always
// do the exact same thing for the whole ~30s hold.
const KISS_ARM_RAISE_HEAD = 1.05;
const KISS_ARM_RAISE_HIP = 0.5;
const KISS_TOUCH_PERIOD_MS = 9000;
const KISS_SWAY_AMPLITUDE = 0.18; // fraction of KISS_LEAN_MAX, not absolute radians
const KISS_SWAY_PERIOD_MS = 3400;
// The head cranes forward and gently bobs, independent of and on top of
// the whole-body lean above — moving it (rather than just rotating it) is
// what actually reads as motion. Reduced alongside KISS_LEAN_MAX/
// INTIMATE_DISTANCE above — the closer body distance already does most of
// the work of bringing them together.
const KISS_HEAD_REACH = 0.06;
const KISS_HEAD_BOB_AMPLITUDE = 0.018;
const KISS_HEAD_BOB_PERIOD_MS = 1700;

// Both participants lean in slightly, hold in a raised-arm embrace for
// most of the duration, then lean back — plus a puckered-lips face for the
// whole hold (see setFaceExpression), now that heads have one. Positive
// rotation.x tips the
// upper body toward local +Z — the direction a character is currently
// facing (see simulation.js's facingAngle convention) — which is toward
// the other participant, since both face each other right before this
// pose starts. Negative rotation.x on an arm swings it toward local +Z
// (forward, see the same convention used by applyHitWindupPose above),
// which is what raises the arms toward the partner rather than behind.
//
// Takes dt because, unlike every other interaction pose here, this one
// has to actively ease the legs back to neutral every frame — a kiss can
// begin mid-stride (approaching was a walk right up until contact), and
// nothing else in this state touches leg rotation, so without this the
// legs stay frozen in whatever split mid-step pose they were in for the
// entire ~30s embrace.
export function applyKissPose(rig, elapsedMs, totalMs, dt) {
  let intensity;
  if (elapsedMs < KISS_RAMP_IN_MS) {
    intensity = Math.sin((elapsedMs / KISS_RAMP_IN_MS) * Math.PI * 0.5);
  } else if (elapsedMs > totalMs - KISS_RAMP_OUT_MS) {
    const remaining = Math.max(0, totalMs - elapsedMs) / KISS_RAMP_OUT_MS;
    intensity = Math.sin(remaining * Math.PI * 0.5);
  } else {
    intensity = 1;
  }
  const sway = 1 + Math.sin((elapsedMs / KISS_SWAY_PERIOD_MS) * Math.PI * 2) * KISS_SWAY_AMPLITUDE;
  rig.visual.rotation.x = KISS_LEAN_MAX * intensity * sway;
  const leftTouch = (Math.sin((elapsedMs / KISS_TOUCH_PERIOD_MS) * Math.PI * 2) + 1) / 2;
  const rightTouch = (Math.sin((elapsedMs / KISS_TOUCH_PERIOD_MS) * Math.PI * 2 + Math.PI) + 1) / 2;
  const leftRaise = KISS_ARM_RAISE_HIP + (KISS_ARM_RAISE_HEAD - KISS_ARM_RAISE_HIP) * leftTouch;
  const rightRaise = KISS_ARM_RAISE_HIP + (KISS_ARM_RAISE_HEAD - KISS_ARM_RAISE_HIP) * rightTouch;
  rig.leftArm.rotation.x = -leftRaise * intensity;
  rig.rightArm.rotation.x = -rightRaise * intensity;
  rig.leftLeg.rotation.x = easeTo(rig.leftLeg.rotation.x, 0, POSE_EASE_RATE, dt);
  rig.rightLeg.rotation.x = easeTo(rig.rightLeg.rotation.x, 0, POSE_EASE_RATE, dt);
  rig.visual.position.y = easeTo(rig.visual.position.y, 0, POSE_EASE_RATE, dt);

  const bob = Math.sin((elapsedMs / KISS_HEAD_BOB_PERIOD_MS) * Math.PI * 2) * KISS_HEAD_BOB_AMPLITUDE * intensity;
  rig.head.position.z = KISS_HEAD_REACH * intensity;
  rig.head.position.y = HEAD_Y + bob;
  setFaceExpression(rig, "kiss");
}

// One attack-and-react beat of a fight — turns alternate every
// FIGHT_EXCHANGE_MS. Exported so simulation.js can schedule whose turn it
// is (it owns fightRole/fightStartedAt) while all the actual pose math
// stays here, matching every other interaction in this file.
export const FIGHT_EXCHANGE_MS = 650;

function applyFightGuardPose(rig) {
  rig.leftArm.rotation.x = -0.9;
  rig.rightArm.rotation.x = -0.9;
  rig.leftLeg.rotation.x = 0.1;
  rig.rightLeg.rotation.x = -0.1;
  rig.visual.rotation.x = 0.08;
}

// Where each strike's strength curve peaks, as a fraction of the
// exchange — exported so simulation.js can trigger a finishing blow's
// knockdown/launch at the moment the strike actually connects, rather
// than at the start of the exchange before the animation has even played.
export const PUNCH_IMPACT_T = 0.55;
export const KICK_IMPACT_T = 0.5;

function punchStrength(t) {
  return t < PUNCH_IMPACT_T
    ? Math.sin((t / PUNCH_IMPACT_T) * Math.PI * 0.5)
    : Math.sin((1 - (t - PUNCH_IMPACT_T) / (1 - PUNCH_IMPACT_T)) * Math.PI * 0.5);
}

function kickStrength(t) {
  return t < KICK_IMPACT_T
    ? Math.sin((t / KICK_IMPACT_T) * Math.PI * 0.5)
    : Math.sin((1 - (t - KICK_IMPACT_T) / (1 - KICK_IMPACT_T)) * Math.PI * 0.5);
}

// Cheap deterministic pseudo-random in [0,1), seeded by exchange index —
// both fighters compute this independently from the same exchangeIndex,
// so the attacker's punch/kick strength and the defender's react
// magnitude agree on how hard a given exchange is without either side
// needing to tell the other (same "no interaction owns another's
// animation state" principle as isAttacker above).
function exchangeIntensity(exchangeIndex) {
  const x = Math.sin(exchangeIndex * 12.9898) * 43758.5453;
  const frac = x - Math.floor(x);
  return 0.65 + frac * 0.7; // roughly 0.65 (glancing) to 1.35 (solid)
}

// A kung-fu-style sparring exchange: both fighters hold a ready guard
// stance, and every FIGHT_EXCHANGE_MS the attacker throws a punch or kick
// (alternating each beat, and alternating which arm/leg throws it, for a
// jab-cross-style combo) while the defender braces then flinches at the
// moment it lands. isAttacker is computed by simulation.js from a shared
// fightStartedAt timestamp plus each side's own fightRole, so both
// characters can independently agree on whose turn it is without one
// driving the other — same "no interaction owns another's animation
// state" principle as the rest of this file. Negative rotation.x on an
// arm or leg swings it toward local +Z (forward, see applyHitWindupPose's
// comment above) — that's what throws punches/kicks forward instead of
// behind the fighter.
export function applyFightPose(rig, elapsed, isAttacker) {
  const local = elapsed % FIGHT_EXCHANGE_MS;
  const t = local / FIGHT_EXCHANGE_MS;
  const exchangeIndex = Math.floor(elapsed / FIGHT_EXCHANGE_MS);
  const intensity = exchangeIntensity(exchangeIndex);
  applyFightGuardPose(rig);
  setFaceExpression(rig, "angry");
  if (!isAttacker) {
    if (t > 0.5) {
      const reactT = (t - 0.5) / 0.5;
      const eased = Math.sin(Math.min(1, reactT) * Math.PI);
      rig.visual.rotation.x = 0.08 - 0.3 * eased * intensity;
    }
    return;
  }
  const usesPunch = exchangeIndex % 2 === 0;
  const usesLeftSide = exchangeIndex % 4 < 2;
  if (usesPunch) {
    const strength = punchStrength(t) * intensity;
    const arm = usesLeftSide ? rig.leftArm : rig.rightArm;
    arm.rotation.x = -0.9 - 1.0 * strength;
  } else {
    const strength = kickStrength(t) * intensity;
    const leg = usesLeftSide ? rig.leftLeg : rig.rightLeg;
    const guardBase = usesLeftSide ? 0.1 : -0.1;
    leg.rotation.x = guardBase - 1.5 * strength;
  }
}

// A finishing punch drops the target straight down where they stand —
// visual.rotation.x eases from standing to -π/2. The rotation pivot sits
// at ground level (visual's own local origin), so a point at any height h
// along the body maps to height h·cos(θ); at θ=-π/2 that's 0 for every
// point, meaning the whole body (torso, head, and — since legs are also
// under visual, see buildStickFigure — the legs too) ends up lying flat
// along the ground, extending backward from the character's own feet
// (which stay fixed, sitting right on the rotation pivot) rather than
// floating or clipping through the floor.
export const KNOCKDOWN_FALL_MS = 450;

export function applyKnockedDownPose(rig, elapsedMs) {
  const t = Math.min(1, elapsedMs / KNOCKDOWN_FALL_MS);
  const eased = Math.sin(t * Math.PI * 0.5);
  rig.visual.rotation.x = -(Math.PI / 2) * eased;
}

// Held once fully down (see applyKnockedDownPose above for why -π/2 is
// exactly flat-on-the-ground, not just "very tilted"). Also reused as the
// landed pose after a finishing kick's launch arc in simulation.js.
export function applyLyingPose(rig) {
  rig.visual.rotation.x = -Math.PI / 2;
}

// Continuous mid-air tumble while a finishing kick sends the target
// flying — simulation.js owns the actual projectile physics (position/
// velocity/gravity), this is purely the cosmetic spin.
const LAUNCH_TUMBLE_SPEED = 6; // rad/sec

export function applyLaunchedPose(rig, elapsedMs) {
  rig.visual.rotation.x = (elapsedMs / 1000) * LAUNCH_TUMBLE_SPEED;
}

const DANCE_FREQUENCY = 4.5;
const DANCE_BOUNCE_AMPLITUDE = 0.09;
const DANCE_SWAY_AMPLITUDE = 0.1;
const DANCE_TWIST_AMOUNT = 0.25;
const DANCE_ARM_PUMP = 1.1;
const DANCE_LEG_KICK = 0.5;

// A bouncy solo dance break — hips sway side to side, torso twists, arms
// pump, legs kick, all riding one shared phase so everything stays in
// rhythm. rotation.y here is the visual group's own twist (independent of
// simulation.js's facingAngle on the outer group), which — unlike the
// lean used elsewhere in this file — is fine to let sweep the legs along
// with it: a dance is supposed to shift weight and step around, not hold
// feet planted the way standing still or kissing should.
export function applyDancePose(rig, dt) {
  rig.dancePhase += dt * DANCE_FREQUENCY;
  const p = rig.dancePhase;
  rig.visual.position.x = Math.sin(p) * DANCE_SWAY_AMPLITUDE;
  rig.visual.position.y = Math.abs(Math.sin(p * 2)) * DANCE_BOUNCE_AMPLITUDE;
  rig.visual.rotation.y = Math.sin(p * 0.5) * DANCE_TWIST_AMOUNT;
  rig.visual.rotation.x = 0;
  rig.leftArm.rotation.x = -DANCE_ARM_PUMP * Math.max(0, Math.sin(p));
  rig.rightArm.rotation.x = -DANCE_ARM_PUMP * Math.max(0, Math.sin(p + Math.PI));
  rig.leftLeg.rotation.x = DANCE_LEG_KICK * Math.sin(p + Math.PI);
  rig.rightLeg.rotation.x = DANCE_LEG_KICK * Math.sin(p);
}

// Chat bubbles (conversation.js) — a separate sprite from the name label
// above, created/disposed per line rather than kept around empty, since
// unlike the name label a bubble isn't always showing. Canvas-drawn same
// as createNameLabel, but sized to the actual text (word-wrapped) instead
// of a fixed box, so a short "Photos" and a long sentence don't share one
// cramped/oversized bubble shape.
// Bumped back up a bit from the 1/4-of-first-pass size (8px) — that read
// slightly too small once actually playtested at the pixel-accurate 1:1
// canvas-to-screen mapping (see scaleChatBubble). Padding/line-height/tail/
// corner-radius scaled up proportionally so the bubble shape stays
// balanced against the bigger font instead of looking cramped.
const BUBBLE_FONT = "bold 10px sans-serif";
const BUBBLE_PADDING = 6;
const BUBBLE_LINE_HEIGHT = 12;
const BUBBLE_TAIL_SIZE = 5;
const BUBBLE_CORNER_RADIUS = 5;
const BUBBLE_BORDER_WIDTH = 1;
const BUBBLE_NAME_COLOR = "#15317e"; // sets the "Name:" prefix apart from the message text, like a real chat bubble
const BUBBLE_TEXT_COLOR = "#000000";
const BUBBLE_TEXT_STROKE_WIDTH = 0.6; // see drawBoldText below — thickens the glyphs beyond plain CSS "bold"
// Wrap width is also capped as a fraction of the actual viewport, not just
// this fixed px value — see createChatBubble's maxTextWidthPx — so a long
// line can't stretch the bubble past the edge of a narrow canvas/webview
// regardless of how that compares to this default.
// Narrowed from 155/0.5 — the wider a bubble is allowed to get, the less
// room clampWorldPointToScreen has to work with on a narrow canvas (its
// margin grows with the bubble's own half-width), so keeping bubbles
// narrower to begin with makes edge-clamping robust rather than marginal.
const BUBBLE_MAX_TEXT_WIDTH_DEFAULT = 120;
const BUBBLE_VIEWPORT_WIDTH_FRACTION = 0.4;

function wrapBubbleText(ctx, text, maxTextWidthPx) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const attempt = current ? `${current} ${word}` : word;
    if (ctx.measureText(attempt).width > maxTextWidthPx && current) {
      lines.push(current);
      current = word;
    } else {
      current = attempt;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

// viewportWidthPx is the game canvas's current CSS width — since
// scaleChatBubble keeps canvas pixels mapped 1:1 to screen pixels
// regardless of zoom (see below), capping the wrap width against it here
// guarantees the bubble can never render wider than the visible screen.
export function createChatBubble(name, text, viewportWidthPx) {
  const maxTextWidthPx = Math.min(
    BUBBLE_MAX_TEXT_WIDTH_DEFAULT,
    Math.max(60, viewportWidthPx * BUBBLE_VIEWPORT_WIDTH_FRACTION - BUBBLE_PADDING * 2),
  );

  const namePrefix = `${name}:`;
  // Wrapped as one continuous word sequence — "Chaimel Enjambre: hello" —
  // so the name prefix naturally flows into the message instead of always
  // reserving its own line; only the resulting *first* line gets split
  // back apart below so the name can be drawn in its own color.
  const combined = `${namePrefix} ${text}`;

  // Measure on a throwaway context first since canvas size itself depends
  // on the wrapped line count/widths.
  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");
  measureCtx.font = BUBBLE_FONT;
  const lines = wrapBubbleText(measureCtx, combined, maxTextWidthPx);
  const textWidth = Math.min(maxTextWidthPx, Math.max(...lines.map((l) => measureCtx.measureText(l).width)));

  const canvasWidth = Math.ceil(textWidth + BUBBLE_PADDING * 2);
  const canvasHeight = Math.ceil(lines.length * BUBBLE_LINE_HEIGHT + BUBBLE_PADDING * 2 + BUBBLE_TAIL_SIZE);

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d");
  ctx.font = BUBBLE_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const bubbleBottom = canvasHeight - BUBBLE_TAIL_SIZE;
  const radius = BUBBLE_CORNER_RADIUS;
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(canvasWidth - radius, 0);
  ctx.arcTo(canvasWidth, 0, canvasWidth, radius, radius);
  ctx.lineTo(canvasWidth, bubbleBottom - radius);
  ctx.arcTo(canvasWidth, bubbleBottom, canvasWidth - radius, bubbleBottom, radius);
  // Tail, pointing down toward the speaker's head.
  ctx.lineTo(canvasWidth / 2 + BUBBLE_TAIL_SIZE, bubbleBottom);
  ctx.lineTo(canvasWidth / 2, canvasHeight);
  ctx.lineTo(canvasWidth / 2 - BUBBLE_TAIL_SIZE, bubbleBottom);
  ctx.lineTo(radius, bubbleBottom);
  ctx.arcTo(0, bubbleBottom, 0, bubbleBottom - radius, radius);
  ctx.lineTo(0, radius);
  ctx.arcTo(0, 0, radius, 0, radius);
  ctx.closePath();
  // More transparent still (was 0.82, before that a near-solid 0.95) so
  // the bubble reads as a light floating overlay — text stays fully
  // opaque regardless, so legibility doesn't suffer for it.
  ctx.fillStyle = "rgba(255,255,255,0.68)";
  ctx.fill();
  ctx.lineWidth = BUBBLE_BORDER_WIDTH;
  ctx.strokeStyle = "rgba(30,30,30,0.75)";
  ctx.stroke();

  // Text is drawn in its own fully-opaque fillStyle (globalAlpha reset to
  // 1 defensively, since it's never touched above, but this makes that
  // guarantee explicit) — so it composites as solid color *on top of* the
  // translucent background instead of ever inheriting that translucency.
  ctx.globalAlpha = 1;
  // CSS "bold" alone reads thin at 8px — a thin stroke under the fill (in
  // the exact same color) thickens the glyphs a bit further, a standard
  // canvas-text pseudo-bolding trick.
  const drawBoldText = (text, x, y, color) => {
    ctx.lineWidth = BUBBLE_TEXT_STROKE_WIDTH;
    ctx.strokeStyle = color;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };
  const firstLineY = BUBBLE_PADDING + BUBBLE_LINE_HEIGHT / 2;
  lines.forEach((line, i) => {
    const y = firstLineY + i * BUBBLE_LINE_HEIGHT;
    if (i === 0 && line.startsWith(namePrefix)) {
      drawBoldText(namePrefix, BUBBLE_PADDING, y, BUBBLE_NAME_COLOR);
      const prefixWidth = ctx.measureText(namePrefix + " ").width;
      drawBoldText(line.slice(namePrefix.length + 1), BUBBLE_PADDING + prefixWidth, y, BUBBLE_TEXT_COLOR);
    } else {
      drawBoldText(line, BUBBLE_PADDING, y, BUBBLE_TEXT_COLOR);
    }
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  // Raw canvas pixel dimensions, not a world-space size — scaleChatBubble
  // (called right after this, every frame the bubble is visible) is what
  // actually sizes it, so the placeholder scale here never gets rendered.
  sprite.userData.canvasWidth = canvasWidth;
  sprite.userData.canvasHeight = canvasHeight;
  sprite.renderOrder = 1000; // above the name label (999)
  return sprite;
}

// Shared by scaleChatBubble and scaleNameLabel below — sizes a sprite so
// its canvas maps 1:1 to actual screen pixels regardless of camera
// distance or viewport size, unlike a plain Sprite (or the first version
// of the chat bubble, which just picked one fixed world size that only
// looked right at one particular zoom level: legible when tested at a
// close-up zoom, nearly unreadable at the default distance). Standard
// perspective-camera projection: at distance d, a world-space height h
// spans screenPixels = h / (2 * d * tan(verticalFovRadians / 2)) *
// viewportHeightPx — inverted here to solve for the world height (h) that
// produces exactly canvasHeight screen pixels, then the same per-pixel
// scale is applied to canvasWidth so the sprite doesn't distort.
// anchorWorldPos is a plain {x,y,z} rather than a rig — the chat bubble
// isn't a rig.group child any more (see computeBubbleAnchorWorld below
// for why), so "distance to this sprite's owner" has to be passed in
// explicitly instead of read off a parent transform.
function scaleSpriteToScreenPixels(anchorWorldPos, sprite, camera, viewportHeightPx) {
  const dx = camera.position.x - anchorWorldPos.x;
  const dy = camera.position.y - anchorWorldPos.y;
  const dz = camera.position.z - anchorWorldPos.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const verticalFovRad = (camera.fov * Math.PI) / 180;
  const worldUnitsPerScreenPixel = (2 * distance * Math.tan(verticalFovRad / 2)) / viewportHeightPx;
  sprite.scale.set(
    sprite.userData.canvasWidth * worldUnitsPerScreenPixel,
    sprite.userData.canvasHeight * worldUnitsPerScreenPixel,
    1,
  );
}

export function scaleChatBubble(anchorWorldPos, sprite, camera, viewportHeightPx) {
  scaleSpriteToScreenPixels(anchorWorldPos, sprite, camera, viewportHeightPx);
}

// Called every frame for every character (not just whoever's currently
// talking) since the name label is always showing, unlike the bubble.
// Still a rig.group child (see buildStickFigure) — it only ever needs a
// vertical offset, never the screen-clamping/collision-dodging the chat
// bubble does, so staying parented (with distance read straight off the
// parent transform) is simpler and correct.
export function scaleNameLabel(rig, camera, viewportHeightPx) {
  if (!rig.nameLabel) return;
  scaleSpriteToScreenPixels(rig.group.position, rig.nameLabel, camera, viewportHeightPx);
}

// The chat bubble is *not* a rig.group child (unlike the name label) —
// conversation.js adds it straight to the scene and positions it in world
// space every frame instead. A rig.group child's position is a local
// offset that gets rotated by the parent's own rotation.y (the
// character's facing direction) before landing in world space; that's
// harmless for a pure-vertical offset (rotating a vector with no X/Z
// component around Y leaves it unchanged) but would skew any *horizontal*
// adjustment — exactly what screen-edge clamping and side-by-side
// collision separation both need to apply. Scene-level avoids that
// entirely: the bubble's world position is just set directly, no parent
// transform involved.
//
// This returns the bubble's *natural* anchor — directly above the head,
// tracking walk-bob/sitting via rig.visual.position.y — before any
// clamping or separation; conversation.js computes this, sizes the
// bubble against it (scaleChatBubble), adds half the resulting bubble
// height so it sits above the name label rather than overlapping it, and
// only *then* applies clampWorldPointToScreen / collision separation to
// the result.
const BUBBLE_GAP_ABOVE_LABEL = 0.22;

export function computeBubbleAnchorWorld(character) {
  return {
    x: character.x,
    y: character.y + HEAD_Y + HEAD_RADIUS + 0.2 + character.rig.visual.position.y + BUBBLE_GAP_ABOVE_LABEL,
    z: character.z,
  };
}

export function positionChatBubbleAt(sprite, worldPos) {
  sprite.position.set(worldPos.x, worldPos.y, worldPos.z);
}

// Scratch vector reused across calls below to avoid an allocation every
// frame for every bubble — none of these functions are reentrant (a
// second call overwrites the first's scratch state), which is fine since
// each call fully consumes its result before returning.
const _screenVec = new THREE.Vector3();

// Keeps a world point within a safe margin of the visible frame — used so
// a chat bubble stays readable even when the character it belongs to has
// wandered toward (or past) the edge of the screen, rather than clipping
// or vanishing off-frame with them. Projects to normalized device
// coordinates (-1..1 on each axis), clamps, and unprojects back at the
// *same depth* (preserving NDC z) so the point still lands at the
// original distance from the camera — this keeps scaleChatBubble's
// distance-based sizing consistent regardless of whether clamping fired.
//
// worldPos is the bubble's *center* (a THREE.Sprite is centered on its own
// position), not just some arbitrary reference point — so clamping it to
// a flat fraction of the screen (the first version of this) only kept the
// center on screen, not the actual bubble: a wide bubble's edges could
// still run past the left/right edge of the screen even while its center
// was comfortably inside the margin. marginPxX/marginPxY (the bubble's
// own half-width/half-height in screen pixels, from scaleChatBubble's
// pixel-accurate sizing, plus a little breathing room) convert to an NDC
// margin here so the *edge*, not just the center, is what's actually kept
// on screen.
const EDGE_BUFFER_PX = 8;

export function clampWorldPointToScreen(worldPos, camera, marginPxX, marginPxY, viewportWidthPx, viewportHeightPx) {
  _screenVec.set(worldPos.x, worldPos.y, worldPos.z).project(camera);
  const marginFracX = Math.min(0.9, ((marginPxX + EDGE_BUFFER_PX) / viewportWidthPx) * 2);
  const marginFracY = Math.min(0.9, ((marginPxY + EDGE_BUFFER_PX) / viewportHeightPx) * 2);
  const clampedX = Math.min(1 - marginFracX, Math.max(-1 + marginFracX, _screenVec.x));
  const clampedY = Math.min(1 - marginFracY, Math.max(-1 + marginFracY, _screenVec.y));
  if (clampedX === _screenVec.x && clampedY === _screenVec.y) {
    return { x: worldPos.x, y: worldPos.y, z: worldPos.z };
  }
  _screenVec.x = clampedX;
  _screenVec.y = clampedY;
  _screenVec.unproject(camera);
  return { x: _screenVec.x, y: _screenVec.y, z: _screenVec.z };
}

// Converts a world point to actual on-screen pixel coordinates (origin
// top-left, +Y down — standard screen/CSS convention) — used to detect
// and resolve two bubbles' bounding boxes overlapping.
export function worldToScreenPixels(worldPos, camera, viewportWidthPx, viewportHeightPx) {
  _screenVec.set(worldPos.x, worldPos.y, worldPos.z).project(camera);
  return {
    x: ((_screenVec.x + 1) / 2) * viewportWidthPx,
    y: ((1 - _screenVec.y) / 2) * viewportHeightPx,
  };
}

// The inverse of worldToScreenPixels — depthReferenceWorldPos supplies the
// depth (NDC z) to unproject at, since a 2D pixel coordinate alone is
// ambiguous about how far from the camera it should land; passing the
// bubble's own pre-adjustment position keeps it at its own distance.
export function screenPixelsToWorld(pixelX, pixelY, depthReferenceWorldPos, camera, viewportWidthPx, viewportHeightPx) {
  _screenVec.set(depthReferenceWorldPos.x, depthReferenceWorldPos.y, depthReferenceWorldPos.z).project(camera);
  const ndcZ = _screenVec.z;
  const ndcX = (pixelX / viewportWidthPx) * 2 - 1;
  const ndcY = 1 - (pixelY / viewportHeightPx) * 2;
  _screenVec.set(ndcX, ndcY, ndcZ).unproject(camera);
  return { x: _screenVec.x, y: _screenVec.y, z: _screenVec.z };
}

export function disposeChatBubble(sprite) {
  if (!sprite) return;
  sprite.material.map.dispose();
  sprite.material.dispose();
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
