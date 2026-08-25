import { useEffect, useRef, useState } from "react";
import * as beatsApi from "../../api/beats";
import { useWebSocket } from "../../context/WebSocketContext";
import type { BeatsJudgment, BeatsRound, BeatsStandingEntry, BeatsState, Lobby } from "../../types";

interface Props {
  lobby: Lobby;
  currentUserId: number;
  onFinished?: () => void;
}

// How many beats (at the match's own bpm) the gauge takes to sweep the
// whole bar — higher bpm means a shorter, faster (harder) sweep. The sweep
// runs continuously off the match clock for the whole match (see tick()) —
// each sweepMs-long span is one "cycle" (one move's worth of opportunity),
// one after another with no gap, rather than a fresh per-round timer that
// would otherwise pause between rounds waiting on a network fetch.
const SWEEP_BEATS = 6;
// Where the static target circle sits along the bar (0-1) — "before it
// reaches the end of the bar", not right at the end.
const STATIC_POS = 0.85;

const WINDOWS: { judgment: BeatsJudgment; ms: number }[] = [
  { judgment: "perfect", ms: 30 },
  { judgment: "great", ms: 60 },
  { judgment: "cool", ms: 100 },
  { judgment: "bad", ms: 150 },
];

const JUDGMENT_COLOR: Record<BeatsJudgment, string> = {
  perfect: "#f5c542",
  great: "#4caf50",
  cool: "#3b82f6",
  bad: "#f97316",
  miss: "#6b7280",
};

const ARROW_GLYPH: Record<string, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  up_left: "↖",
  up_right: "↗",
  down_left: "↙",
  down_right: "↘",
};

// 8key is the 4 arrows plus the 4 diagonals, reachable from the numpad's
// navigation cluster with Num Lock off — 7/9/1/3 send Home/PageUp/End/
// PageDown, the corners of the 7-8-9/4-5-6/1-2-3 grid, diagonal to the
// arrow keys at 8/4/6/2. Browsers report the same `key` value whether the
// press came from the numpad or a dedicated nav-cluster key, so either
// works.
const KEY_TO_SYMBOL: Record<string, string> = {
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  home: "up_left",
  pageup: "up_right",
  end: "down_left",
  pagedown: "down_right",
};

function judgmentFor(deltaMs: number): BeatsJudgment {
  const abs = Math.abs(deltaMs);
  for (const w of WINDOWS) {
    if (abs <= w.ms) return w.judgment;
  }
  return "miss";
}

function sweepMs(bpm: number): number {
  return (60000 / bpm) * SWEEP_BEATS;
}

export function BeatsGame({ lobby, currentUserId, onFinished }: Props) {
  const { subscribe } = useWebSocket();
  const [matchState, setMatchState] = useState<BeatsState | null>(null);
  const [waitingForHost, setWaitingForHost] = useState(false);
  const [standings, setStandings] = useState<BeatsStandingEntry[]>([]);
  const [level, setLevel] = useState(1);
  const [round, setRound] = useState<BeatsRound | null>(null);
  const [sequenceProgress, setSequenceProgress] = useState(0);
  const [flash, setFlash] = useState<{ judgment: BeatsJudgment; moveName: string } | null>(null);
  const [, forceTick] = useState(0);

  const roundRef = useRef<BeatsRound | null>(null);
  const nextRoundRef = useRef<BeatsRound | null>(null);
  const prefetchingLevelRef = useRef<number | null>(null);
  const sequenceProgressRef = useRef(0);
  // Which sweep cycle `round` belongs to — cycles are continuous spans of
  // matchElapsed time (0..sweepMs, sweepMs..2*sweepMs, ...), so this is how
  // tick() notices "time crossed into the next cycle" and rolls over.
  const activeCycleRef = useRef(0);
  const roundSettledRef = useRef(false);
  const levelRef = useRef(1);
  const matchStateRef = useRef<BeatsState | null>(null);
  const finishedRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const matchStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onFinishedRef = useRef(onFinished);

  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  // Fetched ahead of time (while the current cycle is still playing out) so
  // the rollover at the next cycle boundary is instant — no network wait,
  // which is what used to cause a visible pause in the "seamless" sweep.
  async function prefetchNext(lvl: number) {
    if (prefetchingLevelRef.current === lvl) return;
    prefetchingLevelRef.current = lvl;
    const r = await beatsApi.getBeatsRound(lobby.id, lvl).catch(() => null);
    if (prefetchingLevelRef.current === lvl) nextRoundRef.current = r;
  }

  async function startFirstRound() {
    const r = await beatsApi.getBeatsRound(lobby.id, 1).catch(() => null);
    roundRef.current = r;
    setRound(r);
    levelRef.current = 1;
    setLevel(1);
    activeCycleRef.current = 0;
    sequenceProgressRef.current = 0;
    setSequenceProgress(0);
    roundSettledRef.current = false;
    void prefetchNext(2);
  }

  // The first round mustn't start until the shared countdown actually
  // reaches zero — otherwise its cycle is already ticking away before the
  // player can even see the sequence to press.
  function scheduleFirstRound(s: BeatsState) {
    if (matchStartTimerRef.current) clearTimeout(matchStartTimerRef.current);
    const delay = new Date(s.started_at + "Z").getTime() - Date.now();
    if (delay <= 0) {
      void startFirstRound();
    } else {
      matchStartTimerRef.current = setTimeout(() => void startFirstRound(), delay);
    }
  }

  // New lobby focused — reset everything and try to pick up whatever match
  // the host may have already created (a reconnect case); if none exists
  // yet, wait for the beats.session_started broadcast instead.
  useEffect(() => {
    let cancelled = false;
    setMatchState(null);
    matchStateRef.current = null;
    setStandings([]);
    setWaitingForHost(false);
    finishedRef.current = false;
    levelRef.current = 1;
    setLevel(1);
    roundRef.current = null;
    setRound(null);

    beatsApi
      .getBeatsState(lobby.id)
      .then((s) => {
        if (cancelled) return;
        setMatchState(s);
        matchStateRef.current = s;
        setStandings(s.standings);
        scheduleFirstRound(s);
      })
      .catch(() => {
        // The host's own client can legitimately hit this 404 if this GET
        // reaches the server just before their own createBeatsSession POST
        // does — the beats.session_started broadcast below still arrives
        // and sets real state moments later. Only show "waiting" if that
        // hasn't *already* happened by the time this rejection lands, or a
        // late, stale 404 would clobber perfectly good state.
        if (!cancelled && !matchStateRef.current) setWaitingForHost(true);
      });

    return () => {
      cancelled = true;
      if (matchStartTimerRef.current) clearTimeout(matchStartTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby.id]);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === "beats.session_started" && event.data.lobby_id === lobby.id) {
        setMatchState(event.data);
        matchStateRef.current = event.data;
        setStandings(event.data.standings);
        setWaitingForHost(false);
        if (!roundRef.current) scheduleFirstRound(event.data);
      } else if (event.type === "beats.standing" && event.data.lobby_id === lobby.id) {
        setStandings(event.data.standings);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, lobby.id]);

  // Scores this cycle's attempt but does NOT touch the gauge/level/round —
  // the sweep just keeps going uninterrupted, and the actual rollover to
  // the next round happens purely from tick() noticing the cycle boundary,
  // using whatever prefetchNext() already fetched.
  function recordAttempt(judgment: BeatsJudgment) {
    if (roundSettledRef.current || !roundRef.current) return;
    roundSettledRef.current = true;
    setFlash({ judgment, moveName: roundRef.current.move_name });
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 700);
    beatsApi.submitBeatsAttempt(lobby.id, levelRef.current, judgment).catch(() => {});
  }

  // Keyboard: arrow/diagonal keys advance or reset the sequence; space
  // judges the beat (or is an automatic miss if the sequence isn't done yet).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const ms = matchStateRef.current;
      const r = roundRef.current;
      if (!ms || !r || roundSettledRef.current || finishedRef.current) return;

      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (sequenceProgressRef.current < r.sequence.length) {
          recordAttempt("miss");
          return;
        }
        const startedAtMs = new Date(ms.started_at + "Z").getTime();
        const matchElapsed = Date.now() - startedAtMs;
        const cycleMs = sweepMs(ms.bpm);
        const withinCycle = matchElapsed - activeCycleRef.current * cycleMs;
        const perfectMs = STATIC_POS * cycleMs;
        recordAttempt(judgmentFor(withinCycle - perfectMs));
        return;
      }

      const symbol = KEY_TO_SYMBOL[e.key.toLowerCase()];
      if (!symbol) return;
      // Home/End/PageUp/PageDown otherwise scroll the page — same reasoning
      // as preventDefault on Space above.
      e.preventDefault();
      // Sequence already fully entered — extra presses are harmless no-ops,
      // not a wrong-key reset. The player only needs to hit SPACE now.
      if (sequenceProgressRef.current >= r.sequence.length) return;
      const expected = r.sequence[sequenceProgressRef.current];
      if (symbol === expected) {
        sequenceProgressRef.current += 1;
        setSequenceProgress(sequenceProgressRef.current);
      } else {
        sequenceProgressRef.current = 0;
        setSequenceProgress(0);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby.id]);

  // Draw loop + cycle-boundary rollover + match timer — all off refs so
  // they don't need state deps. The gauge position is a pure function of
  // matchElapsed (continuous since the match's own started_at anchor), so
  // it never pauses regardless of how round data arrives.
  useEffect(() => {
    let rafId: number;
    function tick() {
      const ms = matchStateRef.current;
      const canvas = canvasRef.current;
      if (ms && !finishedRef.current) {
        const matchElapsed = Date.now() - new Date(ms.started_at + "Z").getTime();
        if (matchElapsed >= ms.duration_seconds * 1000) {
          finishedRef.current = true;
          onFinishedRef.current?.();
        } else if (matchElapsed >= 0 && canvas && roundRef.current) {
          const cycleMs = sweepMs(ms.bpm);
          const cycleIndex = Math.floor(matchElapsed / cycleMs);
          const withinCycle = matchElapsed - cycleIndex * cycleMs;

          if (cycleIndex > activeCycleRef.current) {
            if (!roundSettledRef.current) recordAttempt("miss");
            activeCycleRef.current = cycleIndex;
            const nextLevel = (levelRef.current % 9) + 1;
            levelRef.current = nextLevel;
            setLevel(nextLevel);
            roundRef.current = nextRoundRef.current ?? roundRef.current;
            setRound(roundRef.current);
            nextRoundRef.current = null;
            prefetchingLevelRef.current = null;
            sequenceProgressRef.current = 0;
            setSequenceProgress(0);
            roundSettledRef.current = false;
            void prefetchNext((nextLevel % 9) + 1);
          }

          drawGauge(canvas, ms, withinCycle);
        }
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby.id]);

  // Countdown/timer text isn't drawn on the canvas, so it needs its own
  // re-render ticks.
  useEffect(() => {
    const interval = setInterval(() => forceTick((n) => n + 1), 200);
    return () => clearInterval(interval);
  }, []);

  if (waitingForHost) {
    return <div className="p-6 text-sm text-neutral-500">Waiting for the host to start a match…</div>;
  }
  if (!matchState) {
    return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  }

  const startedAtMs = new Date(matchState.started_at + "Z").getTime();
  const matchElapsed = Date.now() - startedAtMs;
  const countdown = matchElapsed < 0 ? Math.ceil(-matchElapsed / 1000) : 0;
  const secondsLeft = Math.max(0, Math.ceil((matchState.duration_seconds * 1000 - matchElapsed) / 1000));

  const byUser = new Map(lobby.participants.map((p) => [p.user.id, p.user]));

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4 md:flex-row md:gap-4">
      <div className="flex-1">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">🎵 {lobby.game_name}</h2>
          <span className="text-sm text-neutral-500">
            Level {level} · {matchState.mode} · {secondsLeft}s left
          </span>
        </div>

        <div className="relative mb-3 flex justify-center gap-2">
          {round?.sequence.map((sym, i) => (
            <div
              key={i}
              className={`flex h-10 w-10 items-center justify-center rounded border text-xl font-bold ${
                i < sequenceProgress
                  ? "border-green-500 bg-green-50 text-green-600"
                  : i === sequenceProgress
                    ? "border-amber-500 bg-amber-50 text-amber-600"
                    : "border-neutral-200 text-neutral-400"
              }`}
            >
              {ARROW_GLYPH[sym] ?? sym}
            </div>
          ))}
        </div>

        <div className="relative">
          <canvas ref={canvasRef} width={400} height={70} className="w-full rounded border border-neutral-200 bg-neutral-900" />
          {countdown > 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-4xl font-bold text-white">
              {countdown}
            </div>
          )}
          {flash && (
            <div
              className="absolute left-0 right-0 -top-8 text-center text-lg font-bold"
              style={{ color: JUDGMENT_COLOR[flash.judgment] }}
            >
              {flash.judgment.toUpperCase()} {flash.moveName && `— ${flash.moveName}`}
            </div>
          )}
        </div>

        <p className="mt-2 text-center text-xs text-neutral-500">
          Complete the sequence, then press SPACE at the right moment.
        </p>
      </div>

      <div className="mt-4 w-full shrink-0 md:mt-0 md:w-56">
        <h3 className="mb-2 text-xs font-semibold uppercase text-neutral-500">Standings</h3>
        <ul className="space-y-1">
          {standings.map((entry) => (
            <li
              key={entry.user_id}
              className={`flex items-center justify-between rounded px-2 py-1.5 text-sm ${
                entry.user_id === currentUserId ? "bg-amber-50" : ""
              }`}
            >
              <span>
                #{entry.rank} {byUser.get(entry.user_id)?.display_name ?? `user#${entry.user_id}`}
              </span>
              <span className="font-mono text-xs">{entry.score}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// A soft, feathered glow around the target circle that grows/shrinks and
// fades in/out smoothly. Phase-locked to the perfect-beat instant (not just
// evenly spaced across the whole sweep) so the heartbeat's final, fullest
// expansion always lands exactly when the sliding circle reaches the
// target — `pulse_count` beats build up to it, one per period, and it
// gently fades out again over the remaining tail of the sweep.
function drawHeartbeat(ctx: CanvasRenderingContext2D, x: number, y: number, withinCycle: number, state: BeatsState) {
  const cycleMs = sweepMs(state.bpm);
  const targetMs = STATIC_POS * cycleMs;
  let pulse: number;
  if (withinCycle <= targetMs) {
    const period = targetMs / state.pulse_count;
    const phase = (withinCycle - targetMs) / period; // 0 exactly at the target, negative before it
    pulse = (Math.cos(phase * 2 * Math.PI) + 1) / 2;
  } else {
    const tailProgress = (withinCycle - targetMs) / (cycleMs - targetMs); // 0..1
    pulse = Math.cos((tailProgress * Math.PI) / 2); // eases 1 -> 0, no post-target beats
  }
  const radius = 6 + pulse * 18;
  const alpha = 0.15 + pulse * 0.45;
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, `rgba(245, 197, 66, ${alpha})`);
  gradient.addColorStop(1, "rgba(245, 197, 66, 0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

// `withinCycle` is always in [0, sweepMs) — the position sawtooths back to
// the start at each cycle boundary rather than pausing, the same way a
// metronome needle snaps back rather than freezing.
function drawGauge(canvas: HTMLCanvasElement, state: BeatsState, withinCycle: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const barY = h / 2;
  const barPad = 16;
  const barWidth = w - barPad * 2;

  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "#374151";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(barPad, barY);
  ctx.lineTo(barPad + barWidth, barY);
  ctx.stroke();

  const staticX = barPad + STATIC_POS * barWidth;
  drawHeartbeat(ctx, staticX, barY, withinCycle, state);
  ctx.beginPath();
  ctx.arc(staticX, barY, 10, 0, Math.PI * 2);
  ctx.strokeStyle = "#f5c542";
  ctx.lineWidth = 3;
  ctx.stroke();

  const progress = withinCycle / sweepMs(state.bpm);
  const slideX = barPad + progress * barWidth;
  ctx.beginPath();
  ctx.arc(slideX, barY, 8, 0, Math.PI * 2);
  ctx.fillStyle = "#4caf50";
  ctx.fill();
}
