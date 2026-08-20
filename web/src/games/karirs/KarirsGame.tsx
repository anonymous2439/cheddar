import axios from "axios";
import { useEffect, useRef, useState } from "react";
import * as karirsApi from "../../api/karirs";
import type { KarirsBet, KarirsPool, KarirsRace, KarirsResolvedMessage, KarirsStepMessage, KarirsWallet, Lobby } from "../../types";

// Must match games/karirs/api/app/race.py and main.py — the server never
// tells us these, they're just the game's fixed parameters.
const STEP_DELAY_MS = 300;
const FINISH_LINE = 100;

const RACER_COLORS = ["#f59e0b", "#3b82f6", "#ef4444", "#10b981", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

interface StepState {
  prev: Record<string, number> | null;
  last: Record<string, number> | null;
  lastAt: number;
  step: number;
  totalSteps: number;
}

function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

// Canvas, not CSS/DOM — a browser game screen deserves real graphics, and
// unlike the vscode client (a webview log with CSS-transitioned dots) there's
// no "recreate the DOM every frame defeats the transition" trap to fall into
// here: canvas redraws from scratch every frame by design, so interpolating
// between the last two server positions here just works.
function renderTrack(
  canvas: HTMLCanvasElement,
  race: KarirsRace,
  steps: StepState,
  myBet: KarirsBet | null,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  if (cssWidth === 0 || cssHeight === 0) return;
  if (canvas.width !== cssWidth * dpr || canvas.height !== cssHeight * dpr) {
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const names = race.racer_names;
  const laneHeight = cssHeight / names.length;
  const trackLeft = 96;
  const trackRight = cssWidth - 28;
  const trackWidth = Math.max(1, trackRight - trackLeft);

  ctx.fillStyle = "#fafaf9";
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  const now = performance.now();
  const t = steps.last && steps.lastAt ? Math.min(1, (now - steps.lastAt) / STEP_DELAY_MS) : 1;

  names.forEach((name, i) => {
    const laneTop = laneHeight * i;
    const y = laneTop + laneHeight / 2;

    ctx.fillStyle = i % 2 === 0 ? "#f0efed" : "#fafaf9";
    ctx.fillRect(0, laneTop, cssWidth, laneHeight);

    const isMine = myBet?.racer_name === name;
    const isWinner = race.status === "resolved" && name === race.winning_name;

    ctx.font = isMine ? "bold 12px system-ui, sans-serif" : "12px system-ui, sans-serif";
    ctx.fillStyle = isWinner ? "#b45309" : "#404040";
    ctx.textBaseline = "middle";
    const label = `${isMine ? "★ " : ""}${name}`;
    ctx.fillText(truncateToWidth(ctx, label, trackLeft - 12), 6, y);

    const prevPos = steps.prev?.[name] ?? 0;
    const lastPos = steps.last?.[name] ?? 0;
    const pos = prevPos + (lastPos - prevPos) * t;
    const pct = Math.max(0, Math.min(1, pos / FINISH_LINE));
    const x = trackLeft + pct * trackWidth;

    ctx.beginPath();
    ctx.fillStyle = RACER_COLORS[i % RACER_COLORS.length];
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    if (isMine) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#171717";
      ctx.stroke();
    }

    if (isWinner) {
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillText("🏆", x + 12, y);
    }
  });

  ctx.strokeStyle = "#d4d4d4";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(trackRight, 0);
  ctx.lineTo(trackRight, cssHeight);
  ctx.stroke();
  ctx.setLineDash([]);
}

interface Props {
  lobby: Lobby;
}

export function KarirsGame({ lobby }: Props) {
  const [wallet, setWallet] = useState<KarirsWallet | null>(null);
  const [race, setRace] = useState<KarirsRace | null>(null);
  const [pool, setPool] = useState<KarirsPool | null>(null);
  const [myBet, setMyBet] = useState<KarirsBet | null>(null);
  const [selectedRacer, setSelectedRacer] = useState<string | null>(null);
  const [wager, setWager] = useState(50);
  const [error, setError] = useState("");
  const [, forceTick] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stepsRef = useRef<StepState>({ prev: null, last: null, lastAt: 0, step: 0, totalSteps: 150 });
  const raceRef = useRef<KarirsRace | null>(null);
  const myBetRef = useRef<KarirsBet | null>(null);
  const lastProcessedRef = useRef<{ id: number; status: string } | null>(null);

  useEffect(() => {
    raceRef.current = race;
  }, [race]);
  useEffect(() => {
    myBetRef.current = myBet;
  }, [myBet]);

  // New lobby focused — reset everything and get/create its race.
  useEffect(() => {
    let cancelled = false;
    setWallet(null);
    setRace(null);
    setPool(null);
    setMyBet(null);
    setSelectedRacer(null);
    setError("");
    stepsRef.current = { prev: null, last: null, lastAt: 0, step: 0, totalSteps: 150 };
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

  // Pool + my-bet only need fetching twice: once on first load of a race,
  // once more on resolution to pick up the final payout — not on every
  // poll tick, which is exactly the stale-response bug the vscode client
  // hit (an old pre-resolution null-payout response landing after the
  // resolved one and clobbering a correct payout).
  useEffect(() => {
    if (!race) return;
    const prevEntry = lastProcessedRef.current;
    const isNewRace = !prevEntry || prevEntry.id !== race.id;
    const justResolved = !isNewRace && prevEntry.status === "betting_open" && race.status === "resolved";
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
  }, [race]);

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

  // The race's own websocket — separate from the Cheddar chat socket, since
  // this belongs to a different, independent API.
  useEffect(() => {
    if (!race) return;
    const ws = new WebSocket(karirsApi.karirsWsUrl(race.id));
    ws.onmessage = (event) => {
      let msg: KarirsStepMessage | KarirsResolvedMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "step") {
        const s = stepsRef.current;
        stepsRef.current = {
          prev: s.last ?? msg.positions,
          last: msg.positions,
          lastAt: performance.now(),
          step: msg.step,
          totalSteps: msg.total_steps,
        };
        forceTick((n) => n + 1);
      } else if (msg.type === "resolved") {
        setRace(msg.race);
        setPool(msg.pool);
      }
    };
    return () => ws.close();
  }, [race?.id]);

  // Draw loop runs continuously off refs — no need to depend on state that
  // changes every animation frame.
  useEffect(() => {
    let rafId: number;
    function draw() {
      const canvas = canvasRef.current;
      if (canvas && raceRef.current) {
        renderTrack(canvas, raceRef.current, stepsRef.current, myBetRef.current);
      }
      rafId = requestAnimationFrame(draw);
    }
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
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

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">🏇 {lobby.game_name}</h2>
        <span className="text-sm text-neutral-500">💰 {wallet ? wallet.coins : "…"} coins</span>
      </div>

      <p className="mb-2 text-sm text-neutral-600">
        {isBetting && `Betting closes in ${secondsLeft}s`}
        {!isBetting && !isResolved && `Racing… (${stepsRef.current.step}/${stepsRef.current.totalSteps})`}
        {isResolved && `🏁 ${race.winning_name} wins!`}
      </p>

      <canvas ref={canvasRef} className="mb-3 h-48 w-full rounded border border-neutral-200" />

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
        <p className="mb-3 text-sm text-neutral-600">
          You bet {myBet.wager} coins on {myBet.racer_name} — nobody else can see that.
        </p>
      )}

      {!isBetting && (
        <ul className="mb-3 space-y-1 text-sm">
          {race.racer_names.map((name) => (
            <li key={name} className={name === race.winning_name ? "font-semibold text-amber-700" : "text-neutral-600"}>
              {name === race.winning_name ? "🏆 " : ""}
              {name} — pool: {pool?.[name] ?? 0}
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
