// Third-person character rig — blocky Roblox-style proportions (boxy
// head/torso/limbs, no neck) with a footstep walk cycle and head bob.
// Swing animation and the 1s cooldown live here so both the local player
// and remote players render identically off the same rig code.
//
// Ported from games/luba/client/src/player.js (the vscode extension's
// vendored copy) — kept behaviorally/numerically identical, including
// every sign-convention fix discovered during playtesting (see the
// comments below, carried over verbatim since they document *why*, not
// just *what*).
import * as THREE from "three";

export type ComboState = "idle" | "slash1" | "holdBottom" | "slash2" | "cooldown";

export interface PlayerRig {
  group: THREE.Group;
  visual: THREE.Group;
  head: THREE.Mesh;
  headBaseY: number;
  leftArm: THREE.Mesh;
  rightArm: THREE.Mesh;
  leftLeg: THREE.Mesh;
  rightLeg: THREE.Mesh;
  swordPivot: THREE.Group;
  blade: THREE.Mesh;
  shield: THREE.Mesh;
  isActiveSwing: boolean;
  hasHitThisSwing: boolean;
  comboState: ComboState;
  stateEnteredAt: number;
  walkPhase: number;
  walkBlend: number;
  isDead: boolean;
  deathFallStartAt: number;
  cooldownFromX?: number;
  cooldownFromZ?: number;
  cooldownFromBodyLean?: number;
}

// Two-hit diagonal combo, samurai-style. Slash 1 has two sub-phases: a
// visible wind-up (arm rises from neutral up to a high "ready" pose)
// followed by the actual cut (a wide arc swinging all the way down to a
// low follow-through). The arm then holds at the bottom for up to
// COMBO_WINDOW_MS awaiting a free second swing (slash 2 — no wind-up of
// its own, since the arm is already cocked at the bottom). Only once the
// combo actually concludes — either slash 2 fires, or the window times
// out unused — does the real cooldown start: the first two swings have
// no delay between them at all, the cost is paid once, after the combo.
const SLASH1_WINDUP_MS = 130;
const SLASH1_CUT_MS = 200;
const SLASH2_DURATION_MS = 220;
const COMBO_WINDOW_MS = 3000;
export const ATTACK_COOLDOWN_MS = 1000;
const COOLDOWN_EASE_MS = 200; // arm relaxing back to neutral at the start of cooldown

// Diagonal poses (rotation.x = forward/back lift, rotation.z = side-to-
// side twist) — combining both is what makes the arc read as a diagonal
// samurai cut instead of a flat up-down chop.
//
// Sign convention (traced from a real bug — the arm ended up behind the
// character at follow-through): the arm hangs from a shoulder pivot with
// its rest tip pointing local -Y (straight down). Rotating by
// +rotation.x swings that tip toward -Z (behind the character);
// *negative* rotation.x is what swings it toward +Z (in front). So both
// ready and follow-through need negative x.
const BLADE_LENGTH = 0.8;
const POSE_NEUTRAL = { x: 0, z: 0 };
// z is the dominant sweep axis — a wide right-to-left horizontal cut. For
// this (right) arm, positive rotation.z swings the tip toward the
// character's own left/center, negative swings it further right.
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
// Extra forward commitment on the actual *cut* of slash 1 specifically —
// a bit more arm extension plus a body lean, selling the cut as a lunge.
// SLASH1_BODY_LEAN bumped up from 0.18 — meant to read as the character
// actually reaching toward its target, not just swinging an arm.
const SLASH1_ARM_LEAN = 0.3;
const SLASH1_BODY_LEAN = 0.5;
// The lean stays fully committed through holdBottom and slash2 too, not
// just the initial cut — it only actually eases back out once the whole
// combo concludes and cooldown begins (see the slash2/holdBottom
// branches below, which used to drop to a much smaller lean/zero
// entirely, reading as snapping back upright right after the first swing).

// Roblox-classic-ish proportions, tuned to sum to ~PLAYER_HEIGHT (1.8):
// legs 0.7 + torso 0.65 + head 0.45 = 1.8.
const LEG_H = 0.7;
const TORSO_H = 0.65;
const TORSO_W = 0.5;
const TORSO_D = 0.28;
const HEAD_SIZE = 0.45;
const ARM_H = 0.62;
const LIMB_W = 0.22;

// Walk-cycle tuning — phase only advances while actually moving: a
// standing character holds a neutral pose instead of endlessly replaying
// a cycle with zero amplitude.
const WALK_FREQUENCY = 7;
const WALK_SWING = 0.6;
const HEAD_BOB = 0.045;
const BODY_BOUNCE = 0.03;
const BOB_EASE_RATE = 10; // how fast walking/idle blend, not a duration
// "Ninja run" — instead of a normal front-back arm swing, both arms
// trail backward (positive rotation.x) as if the character is moving too
// fast for them to keep up, with the whole body leaning forward into the
// sprint. Both scale with walkBlend, so standing still still looks like
// standing still, not a held pose.
const RUN_ARM_TRAIL = 1.1;
const RUN_ARM_OSC = 0.15; // small residual life on top of the trail, not a real swing
const RUN_BODY_LEAN = 0.28;

function limb(w: number, h: number, d: number, x: number, y: number, color: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
  mesh.position.set(x, y, 0);
  // Pivot at the top (shoulder/hip), not center, so rotating swings the
  // limb like a real joint instead of clipping through the torso.
  mesh.geometry.translate(0, -h / 2, 0);
  mesh.castShadow = true;
  return mesh;
}

export function buildPlayerRig(color: string): PlayerRig {
  const group = new THREE.Group(); // physics-driven — game.ts sets this directly each frame
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

  // Eyes on the +Z face specifically — "forward" is local +Z — so these
  // double as a ground-truth marker for which way the character is
  // actually facing, not just cosmetic.
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: "#171717" });
  const eyeGeometry = new THREE.SphereGeometry(0.045, 8, 8);
  const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
  leftEye.position.set(-0.1, 0.03, HEAD_SIZE / 2 + 0.01);
  const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial);
  rightEye.position.set(0.1, 0.03, HEAD_SIZE / 2 + 0.01);
  head.add(leftEye, rightEye);

  const shoulderY = LEG_H + TORSO_H - ARM_H * 0.15;
  const hipY = LEG_H;
  // Given how facing/forward is derived in game.ts (forward = (sin,cos)
  // of facingAngle), the character's own anatomical right side — forward
  // × up — works out to local -X, not +X.
  const leftArm = limb(LIMB_W, ARM_H, LIMB_W, TORSO_W / 2 + LIMB_W / 2, shoulderY, color);
  const rightArm = limb(LIMB_W, ARM_H, LIMB_W, -(TORSO_W / 2 + LIMB_W / 2), shoulderY, color);
  const leftLeg = limb(LIMB_W, LEG_H, LIMB_W, -TORSO_W / 4, hipY, limbColor);
  const rightLeg = limb(LIMB_W, LEG_H, LIMB_W, TORSO_W / 4, hipY, limbColor);
  visual.add(leftArm, rightArm, leftLeg, rightLeg);

  // Sword held in the right hand — parented to the right arm itself so it
  // swings along with arm rotation for free. swordPivot sits exactly at
  // the hand (bottom tip of the arm mesh); the blade's own geometry is
  // pre-translated (same trick as limb()) so it extends OUT from that
  // grip point via its length, rather than via an extra position offset.
  const swordPivot = new THREE.Group();
  swordPivot.position.set(0, -ARM_H, 0);
  const bladeGeometry = new THREE.BoxGeometry(0.05, BLADE_LENGTH, 0.05);
  // Hilt at local origin (the grip), tip extending toward local -Y — the
  // same direction the arm mesh itself hangs in its own rest frame. With
  // no extra rotation on the blade, this makes the sword read as a
  // straight continuation of the forearm past the hand — the arm
  // effectively got longer — instead of the blade sitting at a fixed
  // upward cant relative to whatever direction the arm is currently swung.
  bladeGeometry.translate(0, -BLADE_LENGTH / 2, 0);
  const blade = new THREE.Mesh(bladeGeometry, new THREE.MeshStandardMaterial({ color: "#e4e4e7", metalness: 0.7, roughness: 0.25 }));
  blade.castShadow = true;
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.06), new THREE.MeshStandardMaterial({ color: "#78716c" }));
  swordPivot.add(blade, guard);
  rightArm.add(swordPivot);

  // Post-respawn "prepare" shield — a translucent bubble shown only while
  // the server has this player flagged invulnerable, so both the player
  // themselves and everyone watching can see combat is off for them right
  // now. Parented to `group` (not `visual`) so it doesn't inherit the
  // walk bounce/combat lean — purely a status indicator.
  const shield = new THREE.Mesh(
    new THREE.SphereGeometry(0.95, 16, 12),
    new THREE.MeshBasicMaterial({ color: "#22d3ee", transparent: true, opacity: 0.22, depthWrite: false }),
  );
  shield.position.y = 0.9;
  shield.visible = false;
  group.add(shield);

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
    shield,
    // Swept-hit tracking — isActiveSwing is true only while the blade is
    // actually cutting (slash1's cut sub-phase, or all of slash2), not
    // during the wind-up/hold/cooldown; hasHitThisSwing gates a single
    // swing to at most one resolved hit.
    isActiveSwing: false,
    hasHitThisSwing: false,
    comboState: "idle",
    stateEnteredAt: -Infinity,
    walkPhase: 0,
    walkBlend: 0,
    isDead: false,
    deathFallStartAt: -Infinity,
  };
}

// Returns true if a swing was actually allowed to start right now — the
// caller uses this both for local responsiveness and to decide whether
// to even send an attack event to the server at all. Only 'idle' (starts
// slash 1) and 'holdBottom' (starts the free slash 2) can ever return
// true — mid-swing or mid-cooldown, an attack press is just ignored.
export function tryAttack(rig: PlayerRig, nowMs: number): boolean {
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

// Forces a combo straight into cooldown from wherever it currently is —
// used for a parry (both swords clash mid-swing, interrupting whatever
// either side was doing).
export function interruptToCooldown(rig: PlayerRig, nowMs: number): void {
  rig.cooldownFromX = rig.rightArm.rotation.x;
  rig.cooldownFromZ = rig.rightArm.rotation.z;
  rig.visual.rotation.x = 0;
  rig.comboState = "cooldown";
  rig.stateEnteredAt = nowMs;
}

// `isMoving` drives the walk cycle; `dt` in seconds, `nowMs` for the
// attack-swing timeline (a separate clock so it's unaffected by whatever
// dt clamping the walk cycle uses).
export function updatePlayerVisual(rig: PlayerRig, nowMs: number, isMoving: boolean, dt: number): void {
  const easeStep = Math.min(1, dt * BOB_EASE_RATE);
  rig.walkBlend += ((isMoving ? 1 : 0) - rig.walkBlend) * easeStep;
  if (isMoving) rig.walkPhase += dt * WALK_FREQUENCY;

  const swing = Math.sin(rig.walkPhase) * WALK_SWING * rig.walkBlend;
  rig.leftLeg.rotation.x = swing;
  rig.rightLeg.rotation.x = -swing;

  // Both arms trail backward together (not a normal alternating swing) —
  // the "ninja run" look — with a small oscillation riding on top so it
  // doesn't read as a perfectly rigid held pose.
  const armTrail = RUN_ARM_TRAIL * rig.walkBlend + Math.sin(rig.walkPhase) * RUN_ARM_OSC * rig.walkBlend;
  rig.leftArm.rotation.x = armTrail;
  // Right arm's run pose only applies at rest — the combo state machine
  // below owns that arm's rotation for every other state.
  if (rig.comboState === "idle") {
    rig.rightArm.rotation.x = armTrail;
    rig.visual.rotation.x = RUN_BODY_LEAN * rig.walkBlend;
  }

  const footfall = Math.abs(Math.sin(rig.walkPhase)) * rig.walkBlend;
  rig.visual.position.y = footfall * BODY_BOUNCE;
  rig.head.position.y = rig.headBaseY + footfall * HEAD_BOB;

  const elapsed = nowMs - rig.stateEnteredAt;
  // Only true while the blade is actually cutting.
  rig.isActiveSwing = (rig.comboState === "slash1" && elapsed >= SLASH1_WINDUP_MS) || rig.comboState === "slash2";
  if (rig.comboState === "slash1") {
    if (elapsed < SLASH1_WINDUP_MS) {
      // Wind-up: rises from neutral up to the high ready pose.
      const t = elapsed / SLASH1_WINDUP_MS;
      const eased = Math.sin(t * Math.PI * 0.5);
      rig.rightArm.rotation.x = POSE_NEUTRAL.x + (POSE_READY.x - POSE_NEUTRAL.x) * eased;
      rig.rightArm.rotation.z = POSE_NEUTRAL.z + (POSE_READY.z - POSE_NEUTRAL.z) * eased;
    } else {
      // The cut itself: a wide arc from the high ready pose down to the
      // low follow-through, with the extra forward lean/lunge.
      const t = Math.min(1, (elapsed - SLASH1_WINDUP_MS) / SLASH1_CUT_MS);
      const eased = Math.sin(t * Math.PI * 0.5);
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
    const easeT = Math.min(1, elapsed / COOLDOWN_EASE_MS);
    rig.rightArm.rotation.x = (rig.cooldownFromX ?? 0) * (1 - easeT);
    rig.rightArm.rotation.z = (rig.cooldownFromZ ?? 0) * (1 - easeT);
    rig.visual.rotation.x = (rig.cooldownFromBodyLean ?? 0) * (1 - easeT);
    if (elapsed >= ATTACK_COOLDOWN_MS) {
      rig.comboState = "idle";
      rig.stateEnteredAt = nowMs;
    }
  }
}

// Tips the whole rig over onto its back and lets it lie flat on the
// ground, held there until a respawn arrives. Rotates rig.group itself
// (not rig.visual, which the walk/combat code already owns) — group's
// origin is the feet, so pivoting there swings the body over like a
// felled tree rather than sinking it into the floor.
const DEATH_FALL_MS = 450;

export function startDeathFall(rig: PlayerRig, nowMs: number): void {
  rig.isDead = true;
  rig.deathFallStartAt = nowMs;
}

export function updateDeathFall(rig: PlayerRig, nowMs: number): void {
  const t = Math.min(1, (nowMs - rig.deathFallStartAt) / DEATH_FALL_MS);
  const eased = 1 - Math.pow(1 - t, 3); // fast tip, soft settle
  rig.group.rotation.x = -(Math.PI / 2) * eased;
  rig.visual.rotation.x = 0;
  rig.visual.position.y = 0;
}

// Toggles/animates the prepare-window shield — a slow opacity pulse so it
// reads as a temporary status effect rather than a static decoration.
export function updateShieldVisual(rig: PlayerRig, invulnerable: boolean, nowMs: number): void {
  rig.shield.visible = invulnerable && !rig.isDead;
  if (rig.shield.visible) {
    (rig.shield.material as THREE.MeshBasicMaterial).opacity = 0.16 + 0.1 * Math.sin(nowMs * 0.006);
  }
}

export function resetAfterRespawn(rig: PlayerRig, nowMs: number): void {
  rig.isDead = false;
  rig.group.rotation.x = 0;
  rig.comboState = "idle";
  rig.stateEnteredAt = nowMs;
  rig.walkPhase = 0;
  rig.walkBlend = 0;
}

// Real swept-blade positions in world space — sampled at the blade's
// midpoint and tip. This is what makes hit detection skill-based: the
// caller checks these against a target's hitbox every frame the swing is
// active, so landing a hit means the blade's actual animated arc has to
// pass through the target.
export function getSwordWorldSamplePoints(rig: PlayerRig): THREE.Vector3[] {
  rig.group.updateMatrixWorld(true);
  return [0.5, 1.0].map((frac) => rig.blade.localToWorld(new THREE.Vector3(0, -BLADE_LENGTH * frac, 0)));
}

export function disposeRig(rig: PlayerRig): void {
  rig.group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  });
}
