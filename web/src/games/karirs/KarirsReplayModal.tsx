import { useEffect, useRef, useState } from "react";
import * as karirsApi from "../../api/karirs";
import { computePlayback, renderTrack } from "./render";
import type { KarirsPool, KarirsRace } from "../../types";

interface Props {
  raceId: number;
  onClose: () => void;
}

// A one-off playback of a past, already-resolved race — reachable straight
// from the lobby's chat (the "watch a replay" system message), so nobody
// has to go back into the game lobby just to see how it went. Reuses the
// exact same canvas renderer as the live game; the only real difference is
// the playback anchor: a live race times itself off betting_closes_at, a
// replay times itself off "whenever this modal opened".
export function KarirsReplayModal({ raceId, onClose }: Props) {
  const [race, setRace] = useState<KarirsRace | null>(null);
  const [pool, setPool] = useState<KarirsPool | null>(null);
  const [error, setError] = useState("");
  const [, forceTick] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const raceRef = useRef<KarirsRace | null>(null);
  const anchorRef = useRef(Date.now());

  useEffect(() => {
    raceRef.current = race;
  }, [race]);

  useEffect(() => {
    let cancelled = false;
    karirsApi
      .getRace(raceId)
      .then((r) => {
        if (cancelled) return;
        setRace(r);
        anchorRef.current = Date.now();
      })
      .catch(() => setError("Could not load this replay"));
    karirsApi
      .getPool(raceId)
      .then((p) => {
        if (!cancelled) setPool(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [raceId]);

  useEffect(() => {
    let rafId: number;
    function draw() {
      const canvas = canvasRef.current;
      const r = raceRef.current;
      if (canvas && r && r.steps) {
        const playback = computePlayback(r.steps, anchorRef.current, Date.now());
        renderTrack(canvas, r.racer_names, r.winning_name, true, playback, null);
      }
      rafId = requestAnimationFrame(draw);
    }
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Drives the step-count text and the "done" flag below — the canvas
  // redraws every animation frame regardless, off the refs above.
  useEffect(() => {
    if (!race?.steps) return;
    const interval = setInterval(() => forceTick((n) => n + 1), 200);
    return () => clearInterval(interval);
  }, [race?.steps]);

  function watchAgain() {
    anchorRef.current = Date.now();
  }

  const playback = race?.steps ? computePlayback(race.steps, anchorRef.current, Date.now()) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">🏇 Race Replay</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600" aria-label="Close">
            ✕
          </button>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {!race && !error && <p className="text-sm text-neutral-500">Loading…</p>}

        {race && (
          <>
            <canvas ref={canvasRef} className="mb-3 h-40 w-full rounded border border-neutral-200" />
            <p className="mb-2 text-sm text-neutral-600">
              {playback?.done ? `🏁 ${race.winning_name} won!` : `Racing… (${playback?.stepDisplay ?? 0}/${playback?.totalSteps ?? 0})`}
            </p>
            <ul className="mb-3 space-y-1 text-sm">
              {race.racer_names.map((name) => (
                <li
                  key={name}
                  className={name === race.winning_name ? "font-semibold text-amber-700" : "text-neutral-600"}
                >
                  {name === race.winning_name ? "🏆 " : ""}
                  {name} — pool: {pool?.[name] ?? 0}
                </li>
              ))}
            </ul>
            {playback?.done && (
              <button
                onClick={watchAgain}
                className="rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-50"
              >
                ▶ Watch again
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
