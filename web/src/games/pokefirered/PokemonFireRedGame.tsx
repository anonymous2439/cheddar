import { useEffect, useRef, useState } from "react";
import { createEmulator, type EmulatorHandle } from "./emulator";
import { TouchControls } from "./TouchControls";
import type { Lobby } from "../../types";

interface Props {
  lobby: Lobby;
  currentUserId: number;
  onFinished?: () => void;
}

export function PokemonFireRedGame({ onFinished }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const emulatorRef = useRef<EmulatorHandle | null>(null);

  const [status, setStatus] = useState("Choose your GBA ROM to begin.");
  const [emulatorVersion, setEmulatorVersion] = useState<string | null>(null);
  const [romLoaded, setRomLoaded] = useState(false);

  useEffect(() => {
    return () => emulatorRef.current?.dispose();
  }, []);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !canvasRef.current) return;

    setStatus("Loading emulator core…");
    setRomLoaded(false);
    try {
      if (!emulatorRef.current) {
        emulatorRef.current = await createEmulator(canvasRef.current);
        setEmulatorVersion(emulatorRef.current.version);
      }

      setStatus("Loading ROM…");
      const ok = await emulatorRef.current.loadRom(file);
      if (!ok) {
        setStatus(`Failed to load "${file.name}" — is this a valid GBA ROM?`);
        return;
      }
      setRomLoaded(true);
      canvasRef.current.tabIndex = 0;
      canvasRef.current.focus();
      setStatus(`Running "${file.name}".`);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">🔥 Pokémon Fire Red</h2>
        <div className="flex items-center gap-3">
          {emulatorVersion && <span className="text-sm text-neutral-500">{emulatorVersion}</span>}
          {onFinished && (
            <button onClick={onFinished} className="text-xs text-neutral-500 hover:underline">
              Leave
            </button>
          )}
        </div>
      </div>

      <input type="file" accept=".gba" onChange={handleFileChange} className="mb-3 text-sm" />
      <p className="mb-2 text-sm text-neutral-600">{status}</p>

      <div className="w-full max-w-[720px]">
        <canvas
          ref={canvasRef}
          width={240}
          height={160}
          tabIndex={0}
          className="w-full rounded border border-neutral-200 focus:outline-amber-400"
          style={{ imageRendering: "pixelated" }}
        />
        {romLoaded && emulatorRef.current && <TouchControls emulator={emulatorRef.current} />}
      </div>

      {romLoaded && (
        <p className="mt-2 text-xs text-neutral-500">
          Arrow keys to move, Z = A, X = B, Enter = Start, Backspace = Select — or use the on-screen buttons on mobile.
        </p>
      )}
    </div>
  );
}
