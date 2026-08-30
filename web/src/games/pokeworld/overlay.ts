import type { WorldPlayerPosition } from "./useWorldSocket";

// A transparent canvas stacked on top of the emulator's own canvas (see
// PokeWorldGame.tsx) — other players are drawn here as simple dots rather
// than injected into the emulator's own NPC/object-event system, which
// would need hooking the game engine's own actor table (too fragile for a
// first slice — see the approved plan). Not a self-scheduling RAF loop:
// `update()` is called from PokeWorldGame's own poll tick, matching
// render3d.ts's `createKarirsScene3D(canvas)` convention of a stateful
// factory whose `update()` is driven externally.
const TILE_SIZE_PX = 16; // GBA's own overworld tile size in its native 240x160 resolution

export interface OverlayRenderer {
  update(local: { mapId: number; x: number; y: number }, others: Map<number, WorldPlayerPosition>): void;
  dispose(): void;
}

export function createOverlayRenderer(canvas: HTMLCanvasElement): OverlayRenderer {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  function update(local: { mapId: number; x: number; y: number }, others: Map<number, WorldPlayerPosition>) {
    ctx!.clearRect(0, 0, canvas.width, canvas.height);
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    for (const peer of others.values()) {
      if (peer.mapId !== local.mapId) continue;
      // Camera-relative: the GBA's own camera is always centered on the
      // local player's tile (standard Pokémon Emerald/FireRed overworld
      // behavior), so no RAM read is needed for peers at all — only the
      // local player's own position (already known by the caller).
      const screenX = centerX + (peer.x - local.x) * TILE_SIZE_PX;
      const screenY = centerY + (peer.y - local.y) * TILE_SIZE_PX;
      if (screenX < -TILE_SIZE_PX || screenX > canvas.width + TILE_SIZE_PX) continue;
      if (screenY < -TILE_SIZE_PX || screenY > canvas.height + TILE_SIZE_PX) continue;

      ctx!.fillStyle = "#ef4444";
      ctx!.beginPath();
      ctx!.arc(screenX, screenY, 6, 0, Math.PI * 2);
      ctx!.fill();
      ctx!.strokeStyle = "#ffffff";
      ctx!.lineWidth = 1;
      ctx!.stroke();
    }
  }

  function dispose() {
    ctx!.clearRect(0, 0, canvas.width, canvas.height);
  }

  return { update, dispose };
}
