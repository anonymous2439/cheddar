// Static arena geometry — a grid of floor tiles (not one solid slab) so
// battle-royale mode can despawn the outermost ring of tiles over time
// without needing a separate "shrinking zone" concept: a tile that's gone
// just isn't solid anymore, and a player standing there falls through via
// the exact same fall-detection path a normal ring-out uses. Obstacle
// blocks (cover/jump platforms) are separate and fixed — only the floor
// grid ever shrinks.
//
// Ported from games/luba/client/src/arena.js (the vscode extension's
// vendored copy) — kept behaviorally identical (same constants, same
// obstacle layout) so the arena plays out the same on both platforms.
export const PLAYER_HEIGHT = 1.8;
// Per the spec: jump height should be about the player's own height.
export const JUMP_HEIGHT = PLAYER_HEIGHT;

export const TILE_SIZE = 2;
export const GRID_RADIUS = 8; // tiles extend from -GRID_RADIUS..GRID_RADIUS on each axis
const FLOOR_THICKNESS = 1;
const FLOOR_TOP_Y = 0;

// An axis-aligned box: {x,y,z} is its CENTER, {w,h,d} its full
// width/height/depth. `ring` (floor tiles only) is the Chebyshev distance
// from the center tile — battle-royale mode despawns the highest ring
// number first, working inward. `id` is only present on floor tiles
// (obstacles are never individually removed).
export interface Block {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  isFloor: boolean;
  id?: string;
  ring?: number;
}

export interface Arena {
  floorTiles: Block[];
  obstacles: Block[];
}

function buildFloorTiles(): Block[] {
  const tiles: Block[] = [];
  for (let ix = -GRID_RADIUS; ix <= GRID_RADIUS; ix++) {
    for (let iz = -GRID_RADIUS; iz <= GRID_RADIUS; iz++) {
      tiles.push({
        id: `${ix},${iz}`,
        x: ix * TILE_SIZE,
        y: FLOOR_TOP_Y - FLOOR_THICKNESS / 2,
        z: iz * TILE_SIZE,
        w: TILE_SIZE,
        h: FLOOR_THICKNESS,
        d: TILE_SIZE,
        ring: Math.max(Math.abs(ix), Math.abs(iz)),
        isFloor: true,
      });
    }
  }
  return tiles;
}

// Cover blocks (short — hide behind, can't easily jump-attack over) and
// jump blocks (tall enough that reaching the top requires an actual jump,
// but no taller than JUMP_HEIGHT so they stay traversable) — placed by
// hand for a reasonably interesting layout, not procedurally generated.
function buildObstacles(): Block[] {
  const coverH = 1.1;
  const jumpH = JUMP_HEIGHT * 0.85;
  function cover(tx: number, tz: number, w = 1.8, d = 1.8): Block {
    return { x: tx * TILE_SIZE, y: coverH / 2, z: tz * TILE_SIZE, w, h: coverH, d, isFloor: false };
  }
  function jump(tx: number, tz: number, w = 2, d = 2): Block {
    return { x: tx * TILE_SIZE, y: jumpH / 2, z: tz * TILE_SIZE, w, h: jumpH, d, isFloor: false };
  }
  return [
    cover(4, 2),
    cover(-4, -2),
    cover(2, -4),
    cover(-2, 4),
    jump(0, 0, 2.4, 2.4),
    jump(3, 3),
    jump(-3, 3),
    jump(3, -3),
    jump(-3, -3),
    cover(7, 0),
    cover(-7, 0),
    cover(0, 7),
    cover(0, -7),
    cover(5, 5),
    cover(-5, -5),
    jump(6, 6),
    jump(-6, 6),
    jump(6, -6),
    jump(-6, -6),
  ];
}

export function buildArena(): Arena {
  return { floorTiles: buildFloorTiles(), obstacles: buildObstacles() };
}

// Everything currently solid for collision — floor tiles still present
// (a shrunk-away tile is simply omitted by the caller) plus all obstacles.
export function solidBlocks(arena: Arena, removedTileIds: Set<string> | null): Block[] {
  const floor = removedTileIds ? arena.floorTiles.filter((t) => !removedTileIds.has(t.id!)) : arena.floorTiles;
  return [...floor, ...arena.obstacles];
}
