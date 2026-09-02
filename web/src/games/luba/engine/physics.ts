// Hand-rolled gravity + AABB collision against the arena's static blocks
// (see arena.ts) — no physics-engine dependency, the geometry here is
// boxy enough that a full library would be overkill for what's just
// gravity + jump + walking into boxes.
//
// Ported from games/luba/client/src/physics.js — kept behaviorally
// identical, including two bug fixes discovered during playtesting:
// standing on a block's top being misread as a side collision (see
// GROUND_EPSILON), and touching a block's face while sliding sideways
// snapping you clean through to the opposite edge (see the combined
// depth-based horizontal resolution below).
import { JUMP_HEIGHT, PLAYER_HEIGHT, type Block } from "./arena";

export const GRAVITY = 30; // magnitude, units/sec^2
// v0 = sqrt(2 * g * h) — the initial upward speed needed to reach exactly
// JUMP_HEIGHT under this gravity, per the "jump height ~= player height"
// spec.
export const JUMP_SPEED = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);
export const MOVE_SPEED = 5; // units/sec
export const PLAYER_RADIUS = 0.35;
// Falling well below the arena's floor (y=0) means off the edge, not just
// a momentary dip through a gap — this is what "died by falling" checks
// against.
export const FALL_DEATH_Y = -15;

export interface PlayerPhysics {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  radius: number;
}

export interface PhysicsInput {
  moveX: number;
  moveZ: number;
  jump: boolean;
  speed?: number;
}

interface BlockBounds {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  z1: number;
  z2: number;
}

function blockBounds(b: Block): BlockBounds {
  return {
    x1: b.x - b.w / 2,
    x2: b.x + b.w / 2,
    y1: b.y - b.h / 2,
    y2: b.y + b.h / 2,
    z1: b.z - b.d / 2,
    z2: b.z + b.d / 2,
  };
}

function overlapsHorizontally(p: PlayerPhysics, bb: BlockBounds): boolean {
  const px1 = p.x - p.radius;
  const px2 = p.x + p.radius;
  const pz1 = p.z - p.radius;
  const pz2 = p.z + p.radius;
  return px1 < bb.x2 && px2 > bb.x1 && pz1 < bb.z2 && pz2 > bb.z1;
}

// Small tolerance on the "below the top surface" side only — without it,
// standing exactly on a block's top (feet snapped to bb.y2 by the Y-pass
// landing resolution below) could still register as horizontally
// colliding with that same block on the very next frame, the instant a
// single frame's worth of gravity left p.y a hair below bb.y2 before the
// landing check re-snapped it.
const GROUND_EPSILON = 0.02;

function overlapsBlock(p: PlayerPhysics, bb: BlockBounds): boolean {
  const py1 = p.y;
  const py2 = p.y + PLAYER_HEIGHT;
  return overlapsHorizontally(p, bb) && py1 < bb.y2 - GROUND_EPSILON && py2 > bb.y1;
}

export function createPlayerPhysics(x: number, y: number, z: number): PlayerPhysics {
  return { x, y, z, vx: 0, vy: 0, vz: 0, onGround: false, radius: PLAYER_RADIUS };
}

// input.speed optionally overrides MOVE_SPEED (used for a dash burst —
// see game.ts — without needing its own separate movement/collision code
// path). blocks: the arena's currently-solid boxes (see arena.ts's
// solidBlocks — a shrunk-away floor tile is just absent from this list).
export function stepPhysics(p: PlayerPhysics, input: PhysicsInput, blocks: Block[], dt: number): PlayerPhysics {
  const speed = input.speed ?? MOVE_SPEED;
  p.vx = input.moveX * speed;
  p.vz = input.moveZ * speed;

  if (input.jump && p.onGround) {
    p.vy = JUMP_SPEED;
    p.onGround = false;
  }
  p.vy -= GRAVITY * dt;

  // Y axis first, its own pass — landing/ceiling resolution shouldn't be
  // tangled up with the X/Z walk-into-a-wall resolution below.
  //
  // prevY (feet height *before* this step) gates whether an overlap
  // actually means "landing on top" / "hit the ceiling" versus "already
  // overlapping this block's side at a lower height" — only a real
  // downward crossing of the top surface (or upward crossing of the
  // bottom, for a ceiling) resolves here; a pure side overlap is left
  // entirely to the X/Z resolution below, which pushes it out
  // horizontally instead.
  const prevY = p.y;
  p.y += p.vy * dt;
  p.onGround = false;
  for (const b of blocks) {
    const bb = blockBounds(b);
    if (!overlapsHorizontally(p, bb)) continue;
    const py1 = p.y;
    const py2 = p.y + PLAYER_HEIGHT;
    if (py1 >= bb.y2 || py2 <= bb.y1) continue; // no vertical overlap at all
    if (p.vy <= 0 && prevY >= bb.y2 - 0.001) {
      p.y = bb.y2;
      p.vy = 0;
      p.onGround = true;
    } else if (p.vy > 0 && prevY + PLAYER_HEIGHT <= bb.y1 + 0.001) {
      p.y = bb.y1 - PLAYER_HEIGHT;
      p.vy = 0;
    }
  }

  // Horizontal: both axes are moved first, then resolved together — not
  // as two independent sequential passes. Resolving by minimum
  // penetration depth (the standard AABB fix) picks whichever axis is
  // actually shallow — the face you're really touching — and only ever
  // pushes back out along that one, leaving the other axis (the
  // direction you're sliding) untouched.
  p.x += p.vx * dt;
  p.z += p.vz * dt;
  for (const b of blocks) {
    const bb = blockBounds(b);
    if (!overlapsBlock(p, bb)) continue;
    const penetrateLeft = p.x + p.radius - bb.x1;
    const penetrateRight = bb.x2 - (p.x - p.radius);
    const depthX = Math.min(penetrateLeft, penetrateRight);
    const penetrateBack = p.z + p.radius - bb.z1;
    const penetrateFront = bb.z2 - (p.z - p.radius);
    const depthZ = Math.min(penetrateBack, penetrateFront);
    if (depthX < depthZ) {
      p.x = penetrateLeft < penetrateRight ? bb.x1 - p.radius : bb.x2 + p.radius;
    } else {
      p.z = penetrateBack < penetrateFront ? bb.z1 - p.radius : bb.z2 + p.radius;
    }
  }

  return p;
}
