// Third-person character rig — blocky Roblox-style proportions (boxy
// head/torso/limbs, no neck) with a footstep walk cycle and head bob,
// replacing the earlier capsule+sphere placeholder. Not a real "ninja"
// model yet (see the plan's deferred list), just a much more readable
// silhouette than a plain capsule. Swing animation and the 1s cooldown
// live here so both the local player and remote players (once networked,
// Phase 2) render identically off the same rig code.
import * as THREE from "three";

// Two-hit diagonal combo, samurai-style. Slash 1 has two sub-phases: a
// visible wind-up (arm rises from neutral up to a high "ready" pose —
// without this the swing just started already-raised, with no
// anticipation) followed by the actual cut (a wide arc swinging all the
// way down to a low follow-through — the higher the ready pose, the
// wider that arc reads). The arm then holds at the bottom for up to
// COMBO_WINDOW_MS awaiting a free second swing (slash 2 — no wind-up of
// its own, since the arm is already cocked at the bottom, ready to swing
// straight back up). Only once the combo actually concludes — either
// slash 2 fires, or the window times out unused — does the real cooldown
// start: the first two swings have no delay between them at all, the
// cost is paid once, after the combo, not per swing.
// Speeds mirrored server-side by games/luba/api/app/main.py's
// SLASH1_TOTAL_S/SLASH2_DURATION_S (a combo-gating backstop, not the
// visual animation) — keep both in sync.
const SLASH1_WINDUP_MS = 90;
const SLASH1_CUT_MS = 140;
const SLASH2_DURATION_MS = 150;
const COMBO_WINDOW_MS = 3000;
export const ATTACK_COOLDOWN_MS = 1000;
const COOLDOWN_EASE_MS = 200; // arm relaxing back to neutral at the start of cooldown
// A parry needs two swings to clash "at the same time" — but requiring
// literally the same simulation frame (or, server-side, the same
// message) made that window well under 20ms wide, far tighter than human
// timing precision, so a clash was effectively never reachable on
// purpose even once the underlying geometry was correct. This grace
// period is how long a swing stays "parry-eligible" *after* its actual
// cutting motion ends — the caller checks isActiveSwing OR
// (now < activeSwingUntil), not isActiveSwing alone. Mirrored server-side
// by games/luba/api/app/main.py's PARRY_GRACE_S — keep both in sync.
export const PARRY_GRACE_MS = 150;

// Diagonal poses (rotation.x = forward/back lift, rotation.z = side-to-
// side twist) — combining both is what makes the arc read as a diagonal
// samurai cut instead of a flat up-down chop. POSE_READY is deliberately
// steep (arm raised high) specifically so the cut down to
// POSE_FOLLOW_THROUGH covers a wide arc, per the "arm should be high up
// for the sword to be swung wide" spec.
//
// Sign convention (traced from a real bug — the arm ended up behind the
// character at follow-through): the arm hangs from a shoulder pivot with
// its rest tip pointing local -Y (straight down). Rotating by +rotation.x
// swings that tip toward -Z (behind the character); *negative*
// rotation.x is what swings it toward +Z (in front). So both ready and
// follow-through need negative x — they only differ in how far past
// vertical that swing goes, not in sign — a positive value here (as
// follow-through used to be) always ends up behind, never in front.
const BLADE_LENGTH = 0.8;
const POSE_NEUTRAL = { x: 0, z: 0 };
// z is now the *dominant* sweep axis — a wide right-to-left horizontal
// cut, not a mostly-vertical chop with a side twist. For this (right)
// arm, positive rotation.z swings the tip toward the character's own
// left/center, negative swings it further right (see the sign-convention
// note near tryAttack/getSwordWorldSamplePoints for the equivalent x
// reasoning). x stays negative throughout (forward the whole time, per
// that same convention) but far less steep than before — this is a wide
// slice, not an overhead drop.
const POSE_READY = { x: -1.2, z: -1.3 }; // arm raised, extended out to the right
// z pulled back in from 1.3 — that far across put the arm/blade visibly
// clipping through the torso on the follow-through (swinging past the
// body's own centerline instead of stopping short of it); this still
// reads as a wide cut but leaves clearance in front of the chest.
// z pulled in again (0.95 -> 0.65) — even at 0.95 the swinging (right)
// arm's follow-through still reached far enough across to visually touch
// the idle left arm/body; this leaves clearance from that too, not just
// the torso itself.
const POSE_FOLLOW_THROUGH = { x: -0.3, z: 0.65 };
// Extra forward commitment on the actual *cut* of slash 1 specifically
// (not the wind-up, not slash2) — a bit more arm extension plus a body
// lean, selling the cut as a lunge rather than just an arm swing. Both
// ease in with the cut's own progress and back out once it ends.
// SLASH1_BODY_LEAN bumped up from 0.18 — the smaller value barely read as
// a lean at all; this is meant to look like the character is actually
// reaching toward its target, not just swinging an arm.
const SLASH1_ARM_LEAN = 0.3;
const SLASH1_BODY_LEAN = 0.5;
// The lean stays fully committed through holdBottom and slash2 too, not
// just the initial cut — it only actually eases back out once the whole
// combo concludes and cooldown begins. Previously this was a much
// smaller HOLD_BODY_LEAN during the hold and 0 outright during slash2,
// which read as snapping back upright immediately after the first swing.

// Roblox-classic-ish proportions, tuned to sum to ~PLAYER_HEIGHT (1.8):
// legs 0.7 + torso 0.65 + head 0.45 = 1.8.
const LEG_H = 0.7;
const TORSO_H = 0.65;
const TORSO_W = 0.5;
const TORSO_D = 0.28;
const HEAD_SIZE = 0.45;
const ARM_H = 0.62;
const LIMB_W = 0.22;

// Walk-cycle tuning — phase only advances while actually moving (see
// updatePlayerVisual), same reasoning karirs' render3d.ts gait uses: a
// standing character holds a neutral pose instead of endlessly replaying
// a cycle with zero amplitude.
const WALK_FREQUENCY = 7;
const WALK_SWING = 0.6;
const HEAD_BOB = 0.045;
const BODY_BOUNCE = 0.03;
const BOB_EASE_RATE = 10; // how fast walking/idle blend, not a duration
// "Ninja run" — instead of a normal front-back arm swing, both arms
// trail backward (positive rotation.x, per the sign convention above)
// as if the character is moving too fast for them to keep up, with the
// whole body leaning forward into the sprint. Both scale with walkBlend,
// so standing still still looks like standing still, not a held pose.
const RUN_ARM_TRAIL = 1.1;
const RUN_ARM_OSC = 0.15; // small residual life on top of the trail, not a real swing
const RUN_BODY_LEAN = 0.28;

// Bow — the second weapon (see game.js's own KeyQ handling). Held in the
// LEFT hand (off-hand), leaving the right arm free for a draw pose — the
// opposite of the sword, which lives on the right arm and owns that arm's
// rotation via the combo state machine (see tryAttack/updatePlayerVisual).
// Built as a partial torus (an open "C" arc) rather than a proper curved
// bow-limb model — this rig is all flat-shaded boxes/primitives already
// (see limb() above), so a torus arc reads as "a bow" well enough at this
// fidelity without needing real curve geometry.
const BOW_RADIUS = 0.42;
const BOW_TUBE_RADIUS = 0.025;
const BOW_ARC = Math.PI * 1.15; // a bit more than a semicircle — reads as a strung bow's curve, not a full ring
// Neutral (not drawn) vs. fully-drawn right-arm poses — same x/z rotation
// convention as the sword's own POSE_* constants above (negative x swings
// the arm forward, per that section's own sign-convention note). Drawn
// pulls the arm back and slightly across the body, like nocking an arrow
// back toward the cheek.
const BOW_ARM_NEUTRAL = { x: -0.5, z: 0 };
const BOW_ARM_DRAWN = { x: 0.35, z: 0.55 };
// How long the LEFT arm/bow (and head) take to snap toward pointing at the
// aim reticle once drawing starts — quick and decisive, not tied to how
// long the draw is held (see BOW_MIN_DRAW_MS/BOW_MAX_DRAW_MS below, which
// govern the much slower RIGHT-arm lift/charge instead). "The bow-holding
// hand points directly at the target" reads as an immediate commitment,
// not something that creeps in over the whole draw.
const BOW_DRAW_EASE_MS = 220;
// The right arm's own charge-tied lift — exported since game.js's
// releaseBowDraw call sites need the exact same range to convert a draw's
// hold duration into an arrow speed (see releaseBowDraw below), and the
// HUD's own charge-percentage bar needs it too. A held draw below
// BOW_MIN_DRAW_MS still fires (at minimum speed/lift), climbing to full
// speed/full right-arm lift at BOW_MAX_DRAW_MS held — the right arm's own
// visual rise IS the charge meter, just embodied instead of drawn as a bar.
export const BOW_MIN_DRAW_MS = 120;
export const BOW_MAX_DRAW_MS = 1200;
// Release follow-through — see releaseBowDraw's own bowReleaseAt/
// bowReleaseFromCharge fields. Deliberately much faster than the draw
// itself: SNAP is an accelerating (ease-in) motion from wherever the
// charge had reached up to full extension, then SETTLE eases the arm back
// down to neutral once the string has "let go."
const BOW_RELEASE_SNAP_MS = 100;
const BOW_RELEASE_SETTLE_MS = 220;
// The left arm's fixed "holding the bow up, aiming" pose — held steady
// regardless of walking (see updatePlayerVisual's own weapon-gated arm
// trail), the same simplification real-time games with a "run while
// aiming" pose commonly make rather than a fully separate aim-walk cycle.
// aimElevation (see updatePlayerVisual) tilts this further once drawing.
const BOW_HOLD_POSE = { x: -1.1, z: -0.15 };

// Sword-hand cooldown tint — the right arm reddens while comboState is
// 'cooldown' (including a parry's forced cooldown via interruptToCooldown)
// and eases back to the player's normal color once it ends. "A bit red",
// not fully red — COOLDOWN_TINT_STRENGTH caps how far the blend goes even
// at full tint alpha.
const COOLDOWN_TINT_COLOR = new THREE.Color("#ff3b30");
const COOLDOWN_TINT_STRENGTH = 0.45;
const COOLDOWN_TINT_EASE_RATE = 6;

function limb(w, h, d, x, y, color) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
  mesh.position.set(x, y, 0);
  // Pivot at the top (shoulder/hip), not center, so rotating swings the
  // limb like a real joint instead of clipping through the torso.
  mesh.geometry.translate(0, -h / 2, 0);
  mesh.castShadow = true;
  return mesh;
}

export function buildPlayerRig(color) {
  const group = new THREE.Group(); // physics-driven — game.js sets this directly each frame
  const visual = new THREE.Group(); // cosmetic — walk bob/bounce only ever touches this
  group.add(visual);

  const limbColor = "#404040";
  const torso = new THREE.Mesh(new THREE.BoxGeometry(TORSO_W, TORSO_H, TORSO_D), new THREE.MeshStandardMaterial({ color }));
  torso.position.y = LEG_H + TORSO_H / 2;
  torso.castShadow = true;
  visual.add(torso);

  const head = new THREE.Mesh(new THREE.BoxGeometry(HEAD_SIZE, HEAD_SIZE, HEAD_SIZE), new THREE.MeshStandardMaterial({ color }));
  const headBaseY = LEG_H + TORSO_H + HEAD_SIZE / 2;
  head.position.y = headBaseY;
  head.castShadow = true;
  visual.add(head);

  // Eyes on the +Z face specifically — "forward" is local +Z (see the
  // facing-direction note on the arms below), so these double as a
  // ground-truth marker for which way the character is actually facing,
  // not just cosmetic.
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: "#171717" });
  const eyeGeometry = new THREE.SphereGeometry(0.045, 8, 8);
  const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
  leftEye.position.set(-0.1, 0.03, HEAD_SIZE / 2 + 0.01);
  const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
  rightEye.position.set(0.1, 0.03, HEAD_SIZE / 2 + 0.01);
  head.add(leftEye, rightEye);

  const shoulderY = LEG_H + TORSO_H - ARM_H * 0.15;
  const hipY = LEG_H;
  // Given how facing/forward is derived in game.js (forward = (sin,cos)
  // of facingAngle), the character's own anatomical right side —
  // forward × up — works out to local -X, not +X; this was backwards
  // before (sword read as being in the left hand from behind).
  const leftArm = limb(LIMB_W, ARM_H, LIMB_W, TORSO_W / 2 + LIMB_W / 2, shoulderY, color);
  const rightArm = limb(LIMB_W, ARM_H, LIMB_W, -(TORSO_W / 2 + LIMB_W / 2), shoulderY, color);
  const leftLeg = limb(LIMB_W, LEG_H, LIMB_W, -TORSO_W / 4, hipY, limbColor);
  const rightLeg = limb(LIMB_W, LEG_H, LIMB_W, TORSO_W / 4, hipY, limbColor);
  visual.add(leftArm, rightArm, leftLeg, rightLeg);

  // Sword held in the right hand — parented to the right arm itself so it
  // swings along with arm rotation for free (attack pose overrides the
  // walk-cycle rotation on this arm specifically, see updatePlayerVisual).
  // swordPivot sits exactly at the hand (bottom tip of the arm mesh,
  // which is itself anchored/pivoted at the shoulder — see limb()); the
  // blade's own geometry is pre-translated (same trick as limb()) so it
  // extends OUT from that grip point via its length + rotation, rather
  // than via an extra position offset — a separate offset on top of an
  // already-short arm was what put the visible blade up near the
  // shoulder instead of at the hand.
  const swordPivot = new THREE.Group();
  swordPivot.position.set(0, -ARM_H, 0);
  const bladeGeometry = new THREE.BoxGeometry(0.05, BLADE_LENGTH, 0.05);
  // Hilt at local origin (the grip), tip extending toward local -Y — the
  // same direction the arm mesh itself hangs in its own rest frame (see
  // limb(): the arm runs from the shoulder at y=0 down to the hand at
  // y=-ARM_H). With no extra rotation on the blade, this makes the sword
  // read as a straight continuation of the forearm past the hand — the
  // arm effectively got longer — instead of the blade sitting at a fixed
  // upward cant relative to whatever direction the arm is currently
  // swung (which is what made it look like it was just "held up" rather
  // than extending the reach of the swing).
  bladeGeometry.translate(0, -BLADE_LENGTH / 2, 0);
  const blade = new THREE.Mesh(bladeGeometry, new THREE.MeshStandardMaterial({ color: "#e4e4e7", metalness: 0.7, roughness: 0.25 }));
  blade.castShadow = true;
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.06), new THREE.MeshStandardMaterial({ color: "#78716c" }));
  swordPivot.add(blade, guard);
  rightArm.add(swordPivot);

  // Bow — parented to the left arm's own hand point, same reasoning as
  // swordPivot above. Both weapons exist on the rig at all times; only
  // .visible is toggled on switch (see switchEquippedWeapon) — simpler and
  // cheaper than re-parenting geometry at runtime, and avoids ever being
  // caught mid-switch with neither weapon attached.
  const bowPivot = new THREE.Group();
  bowPivot.position.set(0, -ARM_H, 0);
  const bowMaterial = new THREE.MeshStandardMaterial({ color: "#78350f", roughness: 0.6 });
  const bowArc = new THREE.Mesh(
    new THREE.TorusGeometry(BOW_RADIUS, BOW_TUBE_RADIUS, 8, 16, BOW_ARC),
    bowMaterial,
  );
  // Torus arcs sweep in its own local XY plane starting along +X — rotated
  // so the arc stands upright (running along the hand's local Y) and
  // centered on the grip rather than starting there, and turned to face
  // out and slightly forward like a real drawn bow's cant.
  bowArc.rotation.z = Math.PI / 2 - BOW_ARC / 2;
  bowArc.rotation.y = Math.PI / 2;
  bowArc.castShadow = true;
  const bowString = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008, 0.008, BOW_RADIUS * 1.85, 6),
    new THREE.MeshBasicMaterial({ color: "#e7e5e4" }),
  );
  bowPivot.add(bowArc, bowString);
  leftArm.add(bowPivot);

  // Post-respawn "prepare" shield — a translucent bubble shown only while
  // the server has this player flagged invulnerable (see
  // games/luba/api/app/main.py's RESPAWN_INVULN_S), so both the player
  // themselves and everyone watching can see combat is off for them right
  // now. Sized generously around the whole body, centered roughly at
  // chest height. Parented to `group` (not `visual`) so it doesn't
  // inherit the walk bounce/combat lean — purely a status indicator, not
  // part of the character's own pose.
  const shield = new THREE.Mesh(
    new THREE.SphereGeometry(0.95, 16, 12),
    new THREE.MeshBasicMaterial({ color: "#22d3ee", transparent: true, opacity: 0.22, depthWrite: false }),
  );
  shield.position.y = 0.9;
  shield.visible = false;
  group.add(shield);

  // Sword equipped by default — every existing player (and the practice
  // dummy) behaves exactly as before unless something actually presses Q.
  bowPivot.visible = false;

  return {
    group,
    visual,
    head,
    headBaseY,
    leftArm,
    rightArm,
    leftLeg,
    rightLeg,
    swordPivot,
    blade,
    bowPivot,
    equippedWeapon: "sword",
    bowDrawing: false,
    bowDrawStartAt: -Infinity,
    // Set by releaseBowDraw at the exact moment of firing — drives the
    // accelerated snap/settle follow-through in updatePlayerVisual's own
    // bow-pose block once bowDrawing goes back to false.
    bowReleaseAt: -Infinity,
    bowReleaseFromCharge: 0,
    shield,
    // Swept-hit tracking (see getSwordWorldSamplePoints/isActiveSwing
    // below) — isActiveSwing is true only while the blade is actually
    // cutting (slash1's cut sub-phase, or all of slash2), not during the
    // wind-up/hold/cooldown; hasHitThisSwing gates a single swing to at
    // most one resolved hit, reset each time a new swing actually starts
    // (see tryAttack).
    isActiveSwing: false,
    // Stays true a little *after* isActiveSwing itself goes false too —
    // see PARRY_GRACE_MS below for why a parry needs this, not just the
    // instantaneous flag.
    activeSwingUntil: -Infinity,
    hasHitThisSwing: false,
    // State machine: 'idle' -> 'slash1' -> 'holdBottom' -> (free
    // second swing) 'slash2' -> 'cooldown' -> back to 'idle'. A
    // holdBottom that times out without a slash2 also drops straight
    // into 'cooldown' (see updatePlayerVisual) — without that, spamming
    // only ever slash 1 and letting the window lapse would be a free,
    // cooldown-less attack forever, defeating the point of the cooldown.
    comboState: "idle",
    stateEnteredAt: -Infinity,
    walkPhase: 0,
    walkBlend: 0,
    isDead: false,
    deathFallStartAt: -Infinity,
    // Base color to blend from/back to for the cooldown tint below — a
    // clone (not the same Color instance material.color already uses),
    // since material.color itself gets overwritten every frame once
    // tinting starts.
    rightArmBaseColor: rightArm.material.color.clone(),
    cooldownTintAlpha: 0,
  };
}

// Returns true if a swing was actually allowed to start right now — the
// caller uses this both for local responsiveness and (Phase 2) to decide
// whether to even send an attack event to the server at all. Only 'idle'
// (starts slash 1) and 'holdBottom' (starts the free slash 2) can ever
// return true — mid-swing or mid-cooldown, an attack press is just
// ignored.
export function tryAttack(rig, nowMs) {
  if (rig.comboState === "idle") {
    rig.comboState = "slash1";
    rig.stateEnteredAt = nowMs;
    rig.hasHitThisSwing = false;
    return true;
  }
  if (rig.comboState === "holdBottom") {
    rig.comboState = "slash2";
    rig.stateEnteredAt = nowMs;
    rig.hasHitThisSwing = false;
    return true;
  }
  return false;
}

// Sets which weapon is equipped outright (not a toggle) — used to mirror a
// PEER's own equippedWeapon (see game.js's own peer_position handler),
// where the local client is told the actual weapon, not asked to flip it.
// switchEquippedWeapon below (the local player's own Q-key handler) is now
// just this plus the toggle logic, so the two can never drift out of sync
// with each other's own mesh-visibility/draw-cancel side effects.
export function setEquippedWeapon(rig, weapon) {
  if (rig.equippedWeapon === weapon) return;
  rig.equippedWeapon = weapon;
  rig.bowDrawing = false;
  rig.swordPivot.visible = weapon === "sword";
  rig.bowPivot.visible = weapon === "bow";
}

// Toggles which weapon is equipped — called from game.js on KeyQ. Does NOT
// touch comboState; a sword swing already in progress finishes its own
// animation/cooldown normally even if Q is pressed mid-swing (matching how
// dash/smoke never interrupt a swing either), it just won't be able to
// start a *new* one until switched back.
export function switchEquippedWeapon(rig) {
  setEquippedWeapon(rig, rig.equippedWeapon === "sword" ? "bow" : "sword");
}

// Opacity for the LOCAL player's own rig only, while aiming — a
// zoomed-in, over-the-shoulder bow camera can put the character's own body
// between the camera and whatever they're aiming at (see game.js's own
// AIM_LOCAL_OPACITY); this is never applied to a peer's or the practice
// dummy's rig, since another player's own body isn't blocking anything on
// ITS OWN client's screen the same way. Only touches meshes with a
// material — the invulnerability shield already manages its own opacity
// independently and would otherwise get stomped by a blanket traversal.
export function setRigOpacity(rig, opacity) {
  rig.group.traverse((obj) => {
    if (obj.isMesh && obj !== rig.shield) {
      obj.material.transparent = opacity < 1;
      obj.material.opacity = opacity;
      obj.material.needsUpdate = true;
    }
  });
}

export function startBowDraw(rig, nowMs) {
  rig.bowDrawing = true;
  rig.bowDrawStartAt = nowMs;
}

// Ends the draw and reports how long it was held, mapped to an arrow
// speed — minSpeed/maxSpeed come from game.js (kept there, not duplicated
// here, since main.py's own MIN/MAX_ARROW_SPEED need to match whatever
// game.js sends and this file has no reason to know networking constants);
// BOW_MIN_DRAW_MS/BOW_MAX_DRAW_MS live here instead since
// updatePlayerVisual's own right-arm lift needs the exact same range, not
// just the speed calc. Always returns a fireable speed, even for a
// near-instant tap (clamped to minSpeed) — holding decides *how fast*, not
// *whether* it fires at all, per the feature's own spec. Also stamps
// bowReleaseAt/bowReleaseFromCharge, which is what actually drives the
// accelerated snap/settle follow-through (see updatePlayerVisual's own
// bow-pose block) — without capturing the charge reached at THIS exact
// moment, the follow-through would have no idea where to snap up *from*.
export function releaseBowDraw(rig, nowMs, minSpeed, maxSpeed) {
  const heldMs = Math.max(0, nowMs - rig.bowDrawStartAt);
  const chargeFrac = Math.min(1, Math.max(0, (heldMs - BOW_MIN_DRAW_MS) / (BOW_MAX_DRAW_MS - BOW_MIN_DRAW_MS)));
  rig.bowDrawing = false;
  rig.bowReleaseAt = nowMs;
  rig.bowReleaseFromCharge = chargeFrac;
  return { speed: minSpeed + (maxSpeed - minSpeed) * chargeFrac, chargeFrac };
}

// Forces a combo straight into cooldown from wherever it currently is —
// used for a parry (both swords clash mid-swing, interrupting whatever
// either side was doing). Not part of the normal state machine's own
// transitions, so it's a separate exported entry point rather than
// something tryAttack/updatePlayerVisual reach on their own.
export function interruptToCooldown(rig, nowMs) {
  rig.cooldownFromX = rig.rightArm.rotation.x;
  rig.cooldownFromZ = rig.rightArm.rotation.z;
  rig.visual.rotation.x = 0;
  rig.comboState = "cooldown";
  rig.stateEnteredAt = nowMs;
}

// `isMoving` drives the walk cycle; `dt` in seconds, `nowMs` for the
// attack-swing timeline (a separate clock so it's unaffected by whatever
// dt clamping the walk cycle uses).
// aimElevation: the local camera's own current vertical look angle in
// radians (positive = looking up), used only to tilt the bow-holding arm
// and nod the head to match while aiming — see game.js's own aimDir/
// aimElevation. Only ever passed for the LOCAL player's own rig; every
// other call site (peers, the practice dummy) omits it and gets the
// default 0, since nothing here currently broadcasts a peer's own live
// aim pitch the way it does their position/facing — a peer who switches to
// a bow is visible to others (their fired arrows are real, networked
// projectiles), but their rig doesn't yet show them visibly aiming one.
export function updatePlayerVisual(rig, nowMs, isMoving, dt, aimElevation = 0) {
  const easeStep = Math.min(1, dt * BOB_EASE_RATE);
  rig.walkBlend += ((isMoving ? 1 : 0) - rig.walkBlend) * easeStep;
  if (isMoving) rig.walkPhase += dt * WALK_FREQUENCY;

  const swing = Math.sin(rig.walkPhase) * WALK_SWING * rig.walkBlend;
  rig.leftLeg.rotation.x = swing;
  rig.rightLeg.rotation.x = -swing;

  // Both arms trail backward together (not a normal alternating swing)
  // — the "ninja run" look — with a small oscillation riding on top so
  // it doesn't read as a perfectly rigid held pose.
  const armTrail = RUN_ARM_TRAIL * rig.walkBlend + Math.sin(rig.walkPhase) * RUN_ARM_OSC * rig.walkBlend;
  const isBow = rig.equippedWeapon === "bow";
  // The bow's own hold pose owns the left arm instead of the run trail
  // while equipped — see BOW_HOLD_POSE's own comment on why this doesn't
  // bother blending with walkBlend the way the sword-handed run trail does.
  // leftArmT: how "committed" the bow-holding arm/head are to pointing
  // directly at the aim reticle right now — quick (BOW_DRAW_EASE_MS) in
  // both directions, ramping up from bowDrawStartAt while actively
  // drawing, back down from bowReleaseAt once released. Deliberately much
  // faster than the right arm's own chargeFrac below: "the left hand
  // points directly at the target" reads as an immediate commitment the
  // instant you start holding, not something that creeps in with draw
  // strength the way the right arm's visible charge lift does.
  let leftArmT = 0;
  if (isBow) {
    if (rig.bowDrawing) {
      leftArmT = Math.min(1, (nowMs - rig.bowDrawStartAt) / BOW_DRAW_EASE_MS);
    } else {
      leftArmT = Math.max(0, 1 - (nowMs - rig.bowReleaseAt) / BOW_DRAW_EASE_MS);
    }
  }
  if (isBow) {
    // Subtracted, not added — same sign convention as every other
    // rotation.x in this file (see the sword's own POSE_* comment): more
    // negative x swings a hanging-limb's tip further forward/up, so
    // tilting the bow to point higher as aimElevation rises needs to push
    // this more negative, not less.
    rig.leftArm.rotation.x = BOW_HOLD_POSE.x - aimElevation * leftArmT;
    rig.leftArm.rotation.z = BOW_HOLD_POSE.z;
    // Confirmed via the same rotation-about-X trig every other pose here
    // already relies on: a point on the face (local +Z) moves toward -Y
    // (down) under positive rotation.x, toward +Y (up) under negative —
    // so nodding the head UP to match a positive (upward) aimElevation
    // needs the negated angle here, not the raw value.
    rig.head.rotation.x = -aimElevation * leftArmT;
  } else {
    rig.leftArm.rotation.x = armTrail;
    rig.head.rotation.x = 0;
  }
  // Right arm's run pose only applies at rest, with the sword equipped —
  // the combo state machine owns that arm the rest of the time, and the
  // bow draw pose (below) owns it unconditionally whenever the bow is out.
  if (!isBow && rig.comboState === "idle") {
    rig.rightArm.rotation.x = armTrail;
    // Body lean only applied here (not unconditionally) for the same
    // reason — combat states own rig.visual.rotation.x themselves once
    // a swing starts.
    rig.visual.rotation.x = RUN_BODY_LEAN * rig.walkBlend;
  }

  const footfall = Math.abs(Math.sin(rig.walkPhase)) * rig.walkBlend;
  rig.visual.position.y = footfall * BODY_BOUNCE;
  // Head bobs a bit extra on top of the whole body's own bounce — same
  // phase (peaks on every footfall) so it reads as in sync, not against it.
  rig.head.position.y = rig.headBaseY + footfall * HEAD_BOB;

  const elapsed = nowMs - rig.stateEnteredAt;
  // Only true while the blade is actually cutting — slash1's cut
  // sub-phase, or all of slash2 (which has no wind-up of its own) — not
  // during the wind-up itself (just raising the arm, not yet attacking)
  // or any other state. Consumed by getSwordWorldSamplePoints' caller to
  // gate when a swept-hit check is even meaningful.
  rig.isActiveSwing = (rig.comboState === "slash1" && elapsed >= SLASH1_WINDUP_MS) || rig.comboState === "slash2";
  if (rig.isActiveSwing) rig.activeSwingUntil = nowMs + PARRY_GRACE_MS;
  if (rig.comboState === "slash1") {
    if (elapsed < SLASH1_WINDUP_MS) {
      // Wind-up: rises from neutral up to the high ready pose — no body
      // lean yet, nothing has actually committed to the cut at this point.
      const t = elapsed / SLASH1_WINDUP_MS;
      const eased = Math.sin(t * Math.PI * 0.5);
      rig.rightArm.rotation.x = POSE_NEUTRAL.x + (POSE_READY.x - POSE_NEUTRAL.x) * eased;
      rig.rightArm.rotation.z = POSE_NEUTRAL.z + (POSE_READY.z - POSE_NEUTRAL.z) * eased;
    } else {
      // The cut itself: a wide arc from the high ready pose down to the
      // low follow-through, with the extra forward lean/lunge.
      const t = Math.min(1, (elapsed - SLASH1_WINDUP_MS) / SLASH1_CUT_MS);
      const eased = Math.sin(t * Math.PI * 0.5);
      // Subtracted, not added: negative rotation.x is what swings the arm
      // further forward (see the sign-convention note by the pose
      // constants above), so extra forward commitment needs to push this
      // more negative, not more positive (which would instead pull it
      // back toward — and past — straight-down/behind).
      rig.rightArm.rotation.x = POSE_READY.x + (POSE_FOLLOW_THROUGH.x - POSE_READY.x) * eased - SLASH1_ARM_LEAN * eased;
      rig.rightArm.rotation.z = POSE_READY.z + (POSE_FOLLOW_THROUGH.z - POSE_READY.z) * eased;
      rig.visual.rotation.x = SLASH1_BODY_LEAN * eased;
      if (t >= 1) {
        rig.comboState = "holdBottom";
        rig.stateEnteredAt = nowMs;
      }
    }
  } else if (rig.comboState === "slash2") {
    // No wind-up of its own — the arm is already cocked at the bottom
    // (holdBottom) from slash1, free to swing straight back up.
    const t = Math.min(1, elapsed / SLASH2_DURATION_MS);
    const eased = Math.sin(t * Math.PI * 0.5);
    rig.rightArm.rotation.x = POSE_FOLLOW_THROUGH.x + (POSE_READY.x - POSE_FOLLOW_THROUGH.x) * eased;
    rig.rightArm.rotation.z = POSE_FOLLOW_THROUGH.z + (POSE_READY.z - POSE_FOLLOW_THROUGH.z) * eased;
    rig.visual.rotation.x = SLASH1_BODY_LEAN; // stays fully committed through the second swing — see the const's own comment
    if (t >= 1) {
      // Captured right at the transition — the cooldown branch below
      // just eases from this fixed snapshot, not from whatever the
      // rotation happens to be on its own first frame (which would be
      // one frame late and off by a frame's worth of prior easing).
      rig.cooldownFromX = rig.rightArm.rotation.x;
      rig.cooldownFromZ = rig.rightArm.rotation.z;
      rig.cooldownFromBodyLean = SLASH1_BODY_LEAN;
      rig.comboState = "cooldown";
      rig.stateEnteredAt = nowMs;
    }
  } else if (rig.comboState === "holdBottom") {
    rig.rightArm.rotation.x = POSE_FOLLOW_THROUGH.x;
    rig.rightArm.rotation.z = POSE_FOLLOW_THROUGH.z;
    rig.visual.rotation.x = SLASH1_BODY_LEAN; // stays fully committed during the hold too, not a softer bow
    if (elapsed >= COMBO_WINDOW_MS) {
      rig.cooldownFromX = POSE_FOLLOW_THROUGH.x;
      rig.cooldownFromZ = POSE_FOLLOW_THROUGH.z;
      rig.cooldownFromBodyLean = SLASH1_BODY_LEAN;
      rig.comboState = "cooldown";
      rig.stateEnteredAt = nowMs;
    }
  } else if (rig.comboState === "cooldown") {
    // Eases back to neutral from wherever the combo left off (captured
    // in cooldownFromX/Z/BodyLean at the transition into this state
    // above — the slash2-ending path never sets cooldownFromBodyLean,
    // which is fine, it's already 0 by the time slash2 finishes).
    const easeT = Math.min(1, elapsed / COOLDOWN_EASE_MS);
    rig.rightArm.rotation.x = (rig.cooldownFromX ?? 0) * (1 - easeT);
    rig.rightArm.rotation.z = (rig.cooldownFromZ ?? 0) * (1 - easeT);
    rig.visual.rotation.x = (rig.cooldownFromBodyLean ?? 0) * (1 - easeT);
    if (elapsed >= ATTACK_COOLDOWN_MS) {
      rig.comboState = "idle";
      rig.stateEnteredAt = nowMs;
    }
  }

  // Bow draw pose — unconditional whenever the bow is equipped (comboState
  // stays "idle" the whole time the bow is out, since firing it never goes
  // through tryAttack/the sword's own state machine), so this always runs
  // after — and overrides — the idle branch above's right-arm rotation.
  //
  // chargeFrac is the right arm's own "how much draw power is built up"
  // lift — the SAME formula releaseBowDraw uses for arrow speed (so the
  // arm's visible height IS the charge meter, not a separate animation
  // with its own timing), climbing from BOW_MIN_DRAW_MS to BOW_MAX_DRAW_MS
  // held. Releasing plays a much faster, ACCELERATING (ease-in) snap from
  // wherever the charge had reached up to full extension, then settles
  // back down to neutral — rather than just freezing or instantly
  // resetting the instant the string lets go.
  if (isBow) {
    let chargeFrac;
    if (rig.bowDrawing) {
      const heldMs = nowMs - rig.bowDrawStartAt;
      chargeFrac = Math.min(1, Math.max(0, (heldMs - BOW_MIN_DRAW_MS) / (BOW_MAX_DRAW_MS - BOW_MIN_DRAW_MS)));
    } else {
      const releaseElapsed = nowMs - rig.bowReleaseAt;
      if (releaseElapsed < BOW_RELEASE_SNAP_MS) {
        const t = releaseElapsed / BOW_RELEASE_SNAP_MS;
        chargeFrac = rig.bowReleaseFromCharge + (1 - rig.bowReleaseFromCharge) * (t * t); // ease-in — accelerating, not linear
      } else if (releaseElapsed < BOW_RELEASE_SNAP_MS + BOW_RELEASE_SETTLE_MS) {
        const t = (releaseElapsed - BOW_RELEASE_SNAP_MS) / BOW_RELEASE_SETTLE_MS;
        chargeFrac = 1 - t;
      } else {
        chargeFrac = 0;
      }
    }
    // The fully-drawn target itself tracks aimElevation too (same sign
    // convention as the left arm/head above) — this is what makes "the
    // highest lift" also mean "pointing at the reticle," not just "pulled
    // back," converging with the bow's own aim as the draw completes.
    const drawnX = BOW_ARM_DRAWN.x - aimElevation;
    rig.rightArm.rotation.x = BOW_ARM_NEUTRAL.x + (drawnX - BOW_ARM_NEUTRAL.x) * chargeFrac;
    rig.rightArm.rotation.z = BOW_ARM_NEUTRAL.z + (BOW_ARM_DRAWN.z - BOW_ARM_NEUTRAL.z) * chargeFrac;
  }

  const tintTarget = rig.comboState === "cooldown" ? 1 : 0;
  rig.cooldownTintAlpha += (tintTarget - rig.cooldownTintAlpha) * Math.min(1, dt * COOLDOWN_TINT_EASE_RATE);
  rig.rightArm.material.color.copy(rig.rightArmBaseColor).lerp(COOLDOWN_TINT_COLOR, rig.cooldownTintAlpha * COOLDOWN_TINT_STRENGTH);
}

// Tips the whole rig over onto its back and lets it lie flat on the
// ground, held there until a respawn arrives. Rotates rig.group itself
// (not rig.visual, which the walk/combat code already owns) — group's
// origin is the feet (game.js sets its position directly from physics
// each frame), so pivoting there swings the body over like a felled tree
// rather than sinking it into the floor.
//
// Sign: rotating a point starting at local (0, h, 0) — e.g. the head —
// by rotation.x=θ moves it to (0, h·cosθ, h·sinθ), i.e. toward +Z
// (forward, the way the character is facing) for positive θ, toward -Z
// (backward) for negative θ. Falling backward (away from whatever they
// were facing when struck) reads better than pitching forward onto their
// own blade, hence the negative target.
const DEATH_FALL_MS = 450;

export function startDeathFall(rig, nowMs) {
  rig.isDead = true;
  rig.deathFallStartAt = nowMs;
}

export function updateDeathFall(rig, nowMs) {
  const t = Math.min(1, (nowMs - rig.deathFallStartAt) / DEATH_FALL_MS);
  const eased = 1 - Math.pow(1 - t, 3); // fast tip, soft settle
  rig.group.rotation.x = -(Math.PI / 2) * eased;
  // Freeze out whatever pose/lean/bounce the walk or combo state left
  // behind — a corpse shouldn't still be mid-stride or mid-swing.
  rig.visual.rotation.x = 0;
  rig.visual.position.y = 0;
}

// Toggles/animates the prepare-window shield — a slow opacity pulse so it
// reads as a temporary status effect rather than a static decoration.
// Suppressed while dead (the death-fall animation owns that visual
// instead) even if the caller's own invulnerability bookkeeping hasn't
// caught up yet.
export function updateShieldVisual(rig, invulnerable, nowMs) {
  rig.shield.visible = invulnerable && !rig.isDead;
  if (rig.shield.visible) {
    rig.shield.material.opacity = 0.16 + 0.1 * Math.sin(nowMs * 0.006);
  }
}

export function resetAfterRespawn(rig, nowMs) {
  rig.isDead = false;
  rig.group.rotation.x = 0;
  rig.comboState = "idle";
  rig.stateEnteredAt = nowMs;
  rig.walkPhase = 0;
  rig.walkBlend = 0;
  rig.activeSwingUntil = -Infinity;
  rig.head.visible = true; // undoes hideHead(), in case the last death was a headshot
  rig.cooldownTintAlpha = 0;
  rig.rightArm.material.color.copy(rig.rightArmBaseColor);
}

// Real swept-blade positions in world space — sampled at the blade's
// midpoint and tip (skipping the hilt, which sits at the hand and isn't
// meaningfully different for hit-detection purposes). This is what makes
// hit detection skill-based: the caller checks these against a target's
// hitbox every frame the swing is active, so landing a hit means the
// blade's actual animated arc has to pass through the target, not just
// "was in range when the button was pressed."
//
// updateMatrixWorld(true) is called here (not left to the renderer)
// because this needs to be correct in the same frame the rig's
// positions/rotations were just set — Three.js only recomputes world
// matrices during its own render pass otherwise, which would read back
// last frame's (stale) transforms.
export function getSwordWorldSamplePoints(rig) {
  rig.group.updateMatrixWorld(true);
  // Negative Y — the blade's geometry now extends toward local -Y (see
  // where bladeGeometry is built above), not +Y.
  return [0.5, 1.0].map((frac) => rig.blade.localToWorld(new THREE.Vector3(0, -BLADE_LENGTH * frac, 0)));
}

// Real world-space position of the head, for the decapitation effect —
// read *before* hiding the head (see hideHead), so the detached flying
// head spawns exactly where the real one currently is, not some
// approximation.
export function getHeadWorldPosition(rig) {
  rig.group.updateMatrixWorld(true);
  return rig.head.getWorldPosition(new THREE.Vector3());
}

// Hides the rig's own head mesh (the game.js/game.ts caller spawns a
// separate detached flying head in its place via effects.js's
// spawnFlyingHead) — resetAfterRespawn is what makes it visible again.
export function hideHead(rig) {
  rig.head.visible = false;
}

export function disposeRig(rig) {
  rig.group.traverse((obj) => {
    if (obj.isMesh) {
      obj.geometry.dispose();
      obj.material.dispose();
    }
  });
}
