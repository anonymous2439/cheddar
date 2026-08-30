import axios from "axios";
import { useEffect, useRef, useState } from "react";
import * as karirsApi from "../../api/karirs";
import { computePlayback, renderTrack } from "./render";
import { createKarirsScene3D } from "./render3d";
import type { Karirs3DCameraMode, Karirs3DScene } from "./render3d";
import { onKarirsWalletChanged } from "../../lib/karirsEvents";
import { KarirsHallOfFameModal } from "./KarirsHallOfFameModal";
import type { KarirsBet, KarirsPool, KarirsRace, KarirsResolvedMessage, KarirsStepsMessage, KarirsWallet, Lobby } from "../../types";

interface Props {
  lobby: Lobby;
  onFinished?: () => void;
}

export function KarirsGame({ lobby, onFinished }: Props) {
  const [wallet, setWallet] = useState<KarirsWallet | null>(null);
  const [race, setRace] = useState<KarirsRace | null>(null);
  const [pool, setPool] = useState<KarirsPool | null>(null);
  const [myBet, setMyBet] = useState<KarirsBet | null>(null);
  const [selectedRacer, setSelectedRacer] = useState<string | null>(null);
  const [wager, setWager] = useState(50);
  const [error, setError] = useState("");
  const [showHallOfFame, setShowHallOfFame] = useState(false);
  const [cameraMode, setCameraMode] = useState<Karirs3DCameraMode>("chase");
  const [, forceTick] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvas3dRef = useRef<HTMLCanvasElement | null>(null);
  const scene3dRef = useRef<Karirs3DScene | null>(null);
  // Populated by callback refs on the per-racer profile-square canvases
  // below (see the JSX) — read fresh every animation frame rather than
  // needing its own effect, since setFaceCanvases is cheap to call
  // redundantly (see its own doc comment in render3d.ts).
  const faceCanvasesRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const raceRef = useRef<KarirsRace | null>(null);
  const myBetRef = useRef<KarirsBet | null>(null);
  const lastProcessedRef = useRef<{ id: number; status: string } | null>(null);
  // Read via a ref (not a WS-effect dependency) so the race socket doesn't
  // reconnect every time the parent re-renders with a new inline callback —
  // it only needs the latest onFinished at the moment resolution fires.
  const onFinishedRef = useRef(onFinished);
  const cameraModeRef = useRef(cameraMode);

  useEffect(() => {
    raceRef.current = race;
  }, [race]);
  useEffect(() => {
    myBetRef.current = myBet;
  }, [myBet]);
  useEffect(() => {
    cameraModeRef.current = cameraMode;
  }, [cameraMode]);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  // New lobby focused — reset everything and get/create its race.
  useEffect(() => {
    let cancelled = false;
    setWallet(null);
    setRace(null);
    setPool(null);
    setMyBet(null);
    setSelectedRacer(null);
    setError("");
    lastProcessedRef.current = null;

    karirsApi
      .syncRace(lobby.id)
      .then((r) => {
        if (!cancelled) setRace(r);
      })
      .catch(() => {});
    karirsApi
      .getWallet()
      .then((w) => {
        if (!cancelled) setWallet(w);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [lobby.id]);

  // The daily-bonus claim button lives in the chat components (ChatWindow,
  // LobbyChatDock), not here — claiming there doesn't touch this
  // component's state at all, so without this the coin total shown above
  // would just sit stale until something else happened to refetch it (the
  // next bet, the next race). This is the other end of that notification.
  useEffect(() => {
    return onKarirsWalletChanged(() => {
      karirsApi.getWallet().then(setWallet).catch(() => {});
    });
  }, []);

  // Pool + my-bet only need fetching twice: once on first load of a race,
  // once more on resolution to pick up the final payout — not on every
  // poll tick, which is exactly the stale-response bug the vscode client
  // hit (an old pre-resolution null-payout response landing after the
  // resolved one and clobbering a correct payout). In practice the WS
  // "resolved" handler above already covers a live viewer (guaranteed to
  // fire exactly once); this is the fallback for a REST poll noticing
  // resolution instead — e.g. a dropped WS message — so it checks "wasn't
  // resolved before, is now" rather than specifically "was betting_open",
  // since a live race's status always passes through "racing" first and
  // would never match the latter.
  useEffect(() => {
    if (!race) return;
    const prevEntry = lastProcessedRef.current;
    const isNewRace = !prevEntry || prevEntry.id !== race.id;
    const justResolved = !isNewRace && prevEntry.status !== "resolved" && race.status === "resolved";
    lastProcessedRef.current = { id: race.id, status: race.status };

    if (isNewRace || justResolved) {
      karirsApi.getPool(race.id).then(setPool).catch(() => {});
      karirsApi
        .getMyBet(race.id)
        .then((bets) => {
          const incoming = bets[0] ?? null;
          setMyBet((prev) => {
            const isStale = race.status === "resolved" && incoming && incoming.payout == null && prev && prev.payout != null;
            return isStale ? prev : incoming;
          });
        })
        .catch(() => {});
    }

    // Tell the lobby the race is over so the leader can "Back to Lobby" —
    // this is what lets restart() unblock instead of leaving the lobby
    // stuck "in_progress" forever with a finished race behind it.
    if (race.status === "resolved" && (isNewRace || justResolved)) {
      onFinished?.();
    }
  }, [race, onFinished]);

  // Live pool totals while betting is open.
  useEffect(() => {
    if (!race || race.status !== "betting_open") return;
    const interval = setInterval(() => {
      karirsApi.getPool(race.id).then(setPool).catch(() => {});
    }, 2000);
    return () => clearInterval(interval);
  }, [race?.id, race?.status]);

  // Countdown ticks — re-render once a second while betting is open.
  useEffect(() => {
    if (!race || race.status !== "betting_open") return;
    const interval = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [race?.id, race?.status]);

  // The "Racing… (step/total)" text isn't drawn on the canvas (the canvas
  // redraws every animation frame regardless), so it needs its own re-render
  // ticks while animating — the canvas itself doesn't depend on this.
  useEffect(() => {
    if (!race || race.status !== "racing") return;
    const interval = setInterval(() => forceTick((n) => n + 1), 200);
    return () => clearInterval(interval);
  }, [race?.id, race?.status]);

  // The race's own websocket — separate from the Cheddar chat socket, since
  // this belongs to a different, independent API. Only ever carries at most
  // two messages now: the whole precomputed race the instant betting
  // closes, then the final resolved result — no more one message per step.
  useEffect(() => {
    if (!race) return;
    const ws = new WebSocket(karirsApi.karirsWsUrl(race.id));
    ws.onmessage = (event) => {
      let msg: KarirsStepsMessage | KarirsResolvedMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "steps") {
        setRace((prev) => (prev ? { ...prev, status: "racing", steps: msg.steps } : prev));
        forceTick((n) => n + 1);
      } else if (msg.type === "resolved") {
        setRace(msg.race);
        setPool(msg.pool);
        // Fetched directly here, not left to the effect below — that one
        // gates on a direct betting_open->resolved transition, which a live
        // viewer's race never actually has (it always passes through
        // "racing" first via the "steps" message above), so it would never
        // fire for anyone actually watching. This WS message is the one
        // signal guaranteed to fire exactly once, right when the race
        // resolves — the right place to pick up the final payout, the
        // updated wallet, and unblock the leader's "Back to Lobby".
        karirsApi.getMyBet(msg.race.id).then((bets) => setMyBet(bets[0] ?? null)).catch(() => {});
        karirsApi.getWallet().then(setWallet).catch(() => {});
        onFinishedRef.current?.();
      }
    };
    return () => ws.close();
  }, [race?.id]);

  // Draw loop runs continuously off refs — no need to depend on state that
  // changes every animation frame. Recomputes playback position from
  // scratch every frame off race.steps + elapsed wall-clock time. Drives
  // both the 2D canvas and the 3D scene off the exact same computed
  // playback — they're two views of one race, never allowed to drift out
  // of sync with each other.
  useEffect(() => {
    let rafId: number;
    function draw() {
      const canvas = canvasRef.current;
      const currentRace = raceRef.current;
      if (canvas && currentRace) {
        const anchor = new Date(currentRace.betting_closes_at + "Z").getTime();
        const playback = computePlayback(currentRace.steps ?? [], anchor, Date.now());
        const isResolved = currentRace.status === "resolved";
        renderTrack(
          canvas,
          currentRace.racer_names,
          currentRace.winning_name,
          isResolved,
          playback,
          myBetRef.current?.racer_name ?? null,
          currentRace.signature_moves,
        );

        const canvas3d = canvas3dRef.current;
        if (canvas3d) {
          if (!scene3dRef.current) scene3dRef.current = createKarirsScene3D(canvas3d);
          scene3dRef.current.setCameraMode(cameraModeRef.current);
          scene3dRef.current.setFaceCanvases(faceCanvasesRef.current);
          scene3dRef.current.update({
            racerNames: currentRace.racer_names,
            playback,
            winningName: currentRace.winning_name,
            isResolved,
            myBetRacerName: myBetRef.current?.racer_name ?? null,
            faceImageUrls: currentRace.face_image_urls,
            signatureMoves: currentRace.signature_moves,
          });
        }
      }
      rafId = requestAnimationFrame(draw);
    }
    rafId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafId);
      scene3dRef.current?.dispose();
      scene3dRef.current = null;
    };
  }, []);

  async function handlePlaceBet() {
    if (!race) return;
    if (!selectedRacer) {
      setError("Pick a racer first");
      return;
    }
    if (!wager || wager <= 0) {
      setError("Enter a valid wager");
      return;
    }
    try {
      const bet = await karirsApi.placeBet(race.id, selectedRacer, wager);
      setMyBet(bet);
      setError("");
      const [w, p] = await Promise.all([karirsApi.getWallet(), karirsApi.getPool(race.id)]);
      setWallet(w);
      setPool(p);
    } catch (err) {
      const detail = axios.isAxiosError(err) ? (err.response?.data?.detail as string | undefined) : undefined;
      setError(detail ?? "Could not place bet");
    }
  }

  if (!race) {
    return <div className="p-6 text-sm text-neutral-500">Loading race…</div>;
  }

  const isBetting = race.status === "betting_open";
  const isResolved = race.status === "resolved";
  const secondsLeft = isBetting
    ? Math.max(0, Math.round((new Date(race.betting_closes_at + "Z").getTime() - Date.now()) / 1000))
    : 0;
  const playback = !isBetting
    ? computePlayback(race.steps ?? [], new Date(race.betting_closes_at + "Z").getTime(), Date.now())
    : null;

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">🏇 {lobby.name}</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowHallOfFame(true)}
            className="text-sm text-neutral-500 hover:text-amber-600 hover:underline"
          >
            🏆 Hall of Fame
          </button>
          <span className="text-sm text-neutral-500">💰 {wallet ? wallet.coins : "…"} coins</span>
        </div>
      </div>

      <p className="mb-2 text-sm text-neutral-600">
        {isBetting && `Betting closes in ${secondsLeft}s`}
        {!isBetting && !isResolved && `Racing… (${playback?.stepDisplay ?? 0}/${playback?.totalSteps ?? 0})`}
        {isResolved && `🏁 ${race.winning_name} wins!`}
      </p>

      <canvas ref={canvasRef} className="mb-3 h-48 w-full rounded border border-neutral-200" />

      {/* Same race, same live playback data, an alternate 3D view — kept
          alongside the 2D track rather than replacing it, so whoever's
          watching can just look at whichever one they prefer. */}
      <div className="mb-1 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase text-neutral-400">3D View</p>
        <button
          onClick={() => setCameraMode((m) => (m === "overview" ? "chase" : m === "chase" ? "front" : "overview"))}
          className={`rounded px-2 py-0.5 text-xs ${
            cameraMode !== "overview" ? "bg-amber-500 text-white hover:bg-amber-600" : "border border-neutral-300 hover:bg-neutral-100"
          }`}
        >
          {cameraMode === "overview" && "🎥 Follow leader"}
          {cameraMode === "chase" && "🎥 Following (behind)"}
          {cameraMode === "front" && "🎥 Following (front)"}
        </button>
      </div>
      <canvas ref={canvas3dRef} className="mb-3 h-56 w-full rounded border border-neutral-200" />

      {/* One dedicated little camera per racer, all pointed at just their
          own head — rendered from the exact same live 3D scene above, not
          a separate copy, so these never drift out of sync with it. */}
      <p className="mb-1 text-[10px] font-semibold uppercase text-neutral-400">Face Cam</p>
      <div className="mb-3 flex flex-wrap gap-2">
        {race.racer_names.map((name) => (
          <div key={name} className="flex flex-col items-center gap-0.5">
            <canvas
              ref={(el) => {
                if (el) faceCanvasesRef.current.set(name, el);
                else faceCanvasesRef.current.delete(name);
              }}
              className={`h-24 w-24 rounded border ${myBet?.racer_name === name ? "border-amber-500" : "border-neutral-200"}`}
            />
            <span className="max-w-[96px] truncate text-center text-[9px] text-neutral-500">
              {myBet?.racer_name === name ? "★ " : ""}
              {name}
            </span>
          </div>
        ))}
      </div>

      {showHallOfFame && <KarirsHallOfFameModal onClose={() => setShowHallOfFame(false)} />}

      {isBetting && !myBet && (
        <div className="mb-3">
          <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {race.racer_names.map((name) => (
              <button
                key={name}
                onClick={() => setSelectedRacer(name)}
                className={`rounded border px-2 py-2 text-left text-sm ${
                  selectedRacer === name ? "border-amber-500 bg-amber-50" : "border-neutral-200 hover:bg-neutral-50"
                }`}
              >
                <div>{name}</div>
                <div className="text-xs font-semibold text-amber-600">
                  {race.payout_multipliers?.[name]?.toFixed(2) ?? "?"}x payout
                </div>
                <div className="text-xs text-neutral-400">pool: {pool?.[name] ?? 0}</div>
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="number"
              min={1}
              value={wager}
              onChange={(e) => setWager(Number(e.target.value))}
              className="w-24 rounded border border-neutral-300 px-2 py-1 text-sm"
            />
            <button onClick={handlePlaceBet} className="rounded bg-amber-500 px-3 py-1 text-sm text-white hover:bg-amber-600">
              Place Bet
            </button>
          </div>
        </div>
      )}

      {isBetting && myBet && (
        <p className="mb-3 text-sm text-neutral-600">✅ Bet placed — check the game chat for the announcement.</p>
      )}

      {!isBetting && (
        <ul className="mb-3 space-y-1 text-sm">
          {race.racer_names.map((name) => (
            <li key={name} className={name === race.winning_name ? "font-semibold text-amber-700" : "text-neutral-600"}>
              {name === race.winning_name ? "🏆 " : ""}
              {name} — {race.payout_multipliers?.[name]?.toFixed(2) ?? "?"}x — pool: {pool?.[name] ?? 0}
            </li>
          ))}
        </ul>
      )}

      {isResolved && myBet && (
        <p className="text-sm">
          {myBet.payout && myBet.payout > 0
            ? `You bet on ${myBet.racer_name} and won ${myBet.payout} coins!`
            : `You bet ${myBet.wager} on ${myBet.racer_name} — no payout this time.`}
        </p>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
