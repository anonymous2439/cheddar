import { useEffect, useRef, useState } from "react";
import { createPokeWorldEmulator } from "./emulator";
import type { PokeWorldEmulatorHandle } from "./emulator";
import { ROM_OFFSETS, detectRomVersion } from "./memoryMap";
import type { RomVersion } from "./memoryMap";
import { createOverlayRenderer } from "./overlay";
import type { OverlayRenderer } from "./overlay";
import { useWorldSocket } from "./useWorldSocket";

// Phase 4 of the PokeWorld plan (see /home/rev/.claude/plans/vast-whistling-umbrella.md):
// wire the proven emulator+RAM-read pipeline (Phase 3) up to the always-on
// world socket (Phase 2) and an overlay canvas, so two browser tabs running
// the same ROM actually see each other move. Not wired into Cheddar's
// lobby system at all — this is an always-on world (see ChatPage.tsx's
// "world" tab), not a per-lobby game.
// TEMPORARY diagnostic value (was 300ms) — testing whether saveState()'s
// write actually completes synchronously or races with an immediate
// read-back when polled this fast. Revert once confirmed either way.
const CAPTURE_INTERVAL_MS = 2000;

interface LocalPosition {
  mapId: number;
  x: number;
  y: number;
  facing: string;
}

// The test ROM (see memoryMap.ts) only has one raw incrementing counter, not
// real player-controlled X/Y — this synthesizes a distinct, bounded x/y pair
// out of that single value purely so the networking+overlay pipeline has
// *something* live to move around on screen. A real Pokémon ROM (once
// emerald_us/firered_us are populated in memoryMap.ts) would read genuine
// playerX/playerY/mapId/facing offsets directly instead of going through
// this synthesis at all.
function computeLocalPosition(view: DataView, version: RomVersion): LocalPosition | null {
  const offsets = ROM_OFFSETS[version];
  if (!offsets) return null;
  if (version === "test_rom") {
    // Kept to a tight 5x3 range (not the full 15x10 screen) so two
    // independently-started counters are actually likely to land within
    // camera view of each other — a real ROM's genuine player-controlled
    // X/Y wouldn't need this narrowing, since real players who are near
    // each other are near each other by construction.
    const counter = view.getUint32(offsets.playerX, true);
    return { mapId: 0, x: counter % 5, y: Math.floor(counter / 5) % 3, facing: "down" };
  }
  // Real ROMs: these are 16-bit tile coordinates (see memoryMap.ts's
  // firered_us comment on how they were actually found), not 32-bit —
  // reading them as getUint32 would pull in the adjacent Y/next field's
  // bytes as garbage high bits.
  return {
    mapId: offsets.mapId !== undefined ? view.getUint32(offsets.mapId, true) : 0,
    x: view.getInt16(offsets.playerX, true),
    y: view.getInt16(offsets.playerY, true),
    facing: offsets.facing !== undefined ? String(view.getUint8(offsets.facing)) : "down",
  };
}

export function PokeWorldGame() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const emulatorRef = useRef<PokeWorldEmulatorHandle | null>(null);
  const overlayRef = useRef<OverlayRenderer | null>(null);
  const romVersionRef = useRef<RomVersion>("unknown");
  const world = useWorldSocket();

  const [status, setStatus] = useState("Choose a ROM file to begin.");
  const [emulatorVersion, setEmulatorVersion] = useState<string | null>(null);
  const [romLoaded, setRomLoaded] = useState(false);
  const [localPos, setLocalPos] = useState<LocalPosition | null>(null);
  const [peerCount, setPeerCount] = useState(0);
  const [lastCaptureMs, setLastCaptureMs] = useState<number | null>(null);
  const [avgCaptureMs, setAvgCaptureMs] = useState<number | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [stateChecksum, setStateChecksum] = useState<number | null>(null);

  useEffect(() => {
    if (overlayCanvasRef.current) overlayRef.current = createOverlayRenderer(overlayCanvasRef.current);
    return () => overlayRef.current?.dispose();
  }, []);

  // Poll loop — deliberately a self-rescheduling timeout, not a fixed
  // setInterval, so a slow captureState() call (see emulator.ts) can never
  // overlap with the next one instead of piling up. Each tick both reads
  // the local position (for the overlay's own camera-relative math) and
  // broadcasts it over the world socket.
  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;
    let captureCount = 0;
    let totalCaptureMs = 0;

    async function tick() {
      if (cancelled) return;
      const emulator = emulatorRef.current;
      if (emulator) {
        try {
          const capture = await emulator.captureState();
          if (capture && !cancelled) {
            setCaptureError(null);
            // Diagnostic: a cheap whole-blob checksum (FNV-1a), independent
            // of whichever two offsets memoryMap.ts happens to point at —
            // lets us tell "the capture mechanism stopped producing fresh
            // data" apart from "it's still fresh, but this specific offset
            // isn't player position anymore in this situation" (e.g. right
            // after a map transition).
            let hash = 0x811c9dc5;
            for (let i = 0; i < capture.bytes.length; i++) {
              hash ^= capture.bytes[i];
              hash = Math.imul(hash, 0x01000193);
            }
            setStateChecksum(hash >>> 0);
            const view = new DataView(capture.bytes.buffer, capture.bytes.byteOffset, capture.bytes.byteLength);
            const pos = computeLocalPosition(view, romVersionRef.current);
            if (pos) {
              setLocalPos(pos);
              world.sendPosition(pos);
              overlayRef.current?.update(pos, world.otherPlayers);
              setPeerCount(world.otherPlayers.size);
            }
            captureCount += 1;
            totalCaptureMs += capture.captureMs;
            setLastCaptureMs(capture.captureMs);
            setAvgCaptureMs(totalCaptureMs / captureCount);
          }
        } catch (err) {
          if (!cancelled) setCaptureError(err instanceof Error ? err.message : String(err));
        }
      }
      if (!cancelled) timeoutId = window.setTimeout(tick, CAPTURE_INTERVAL_MS);
    }

    timeoutId = window.setTimeout(tick, CAPTURE_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- world.sendPosition/otherPlayers are stable refs from useWorldSocket, not reactive state
  }, []);

  useEffect(() => {
    return () => emulatorRef.current?.dispose();
  }, []);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !canvasRef.current) return;

    setStatus("Loading emulator core…");
    setRomLoaded(false);
    try {
      const romBytes = new Uint8Array(await file.arrayBuffer());
      romVersionRef.current = detectRomVersion(romBytes);

      if (!emulatorRef.current) {
        emulatorRef.current = await createPokeWorldEmulator(canvasRef.current);
        setEmulatorVersion(emulatorRef.current.version);
      }

      setStatus("Loading ROM…");
      const ok = await emulatorRef.current.loadRom(file);
      if (!ok) {
        setStatus(`Failed to load "${file.name}" — is this a valid GBA ROM?`);
        return;
      }
      setRomLoaded(true);
      // The canvas needs actual keyboard focus for mGBA's key bindings
      // (see emulator.ts) to receive anything at all — without this the
      // character never moves and every read just reflects wherever the
      // save file/new game placed the player initially.
      canvasRef.current.tabIndex = 0;
      canvasRef.current.focus();
      setStatus(
        romVersionRef.current === "unknown"
          ? `Running "${file.name}" (unrecognized ROM — position readout needs an entry in memoryMap.ts).`
          : `Running "${file.name}" (recognized as ${romVersionRef.current}).`,
      );
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">🌍 PokeWorld</h2>
        {emulatorVersion && <span className="text-sm text-neutral-500">{emulatorVersion}</span>}
      </div>

      <input type="file" accept=".gba" onChange={handleFileChange} className="mb-3 text-sm" />

      <p className="mb-2 text-sm text-neutral-600">{status}</p>

      <div className="relative mb-3 w-full max-w-[720px]">
        <canvas
          ref={canvasRef}
          width={240}
          height={160}
          tabIndex={0}
          className="w-full rounded border border-neutral-200 focus:outline-amber-400"
          style={{ imageRendering: "pixelated" }}
        />
        <canvas
          ref={overlayCanvasRef}
          width={240}
          height={160}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
      </div>

      {romLoaded && (
        <div className="text-xs text-neutral-500">
          <p>
            Local: {localPos ? `map ${localPos.mapId}, (${localPos.x}, ${localPos.y}) facing ${localPos.facing}` : "…"} —
            other players visible: {peerCount}
          </p>
          <p>
            Last capture: {lastCaptureMs !== null ? `${lastCaptureMs.toFixed(2)}ms` : "…"} — avg:{" "}
            {avgCaptureMs !== null ? `${avgCaptureMs.toFixed(2)}ms` : "…"}
          </p>
          <p>Whole-state checksum (should change every tick even if the position above doesn't): {stateChecksum ?? "…"}</p>
          {captureError && <p className="text-red-500">Capture error: {captureError}</p>}
        </div>
      )}
    </div>
  );
}
