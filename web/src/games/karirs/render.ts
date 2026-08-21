// Shared between the live game view (KarirsGame) and the chat "watch a
// replay" modal (KarirsReplayModal) — both are just "given a precomputed
// steps array and an anchor instant, draw the track right now", they only
// differ in what anchor they use (the race's real betting_closes_at for a
// live race, vs. "whenever I opened this modal" for a replay).

// Must match games/karirs/api/app/race.py and main.py — the server never
// tells us these, they're just the game's fixed parameters.
export const STEP_DELAY_MS = 300;
export const FINISH_LINE = 100;

export const RACER_COLORS = ["#f59e0b", "#3b82f6", "#ef4444", "#10b981", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

export interface RaceStep {
  positions: Record<string, number>;
  shouting: string[];
}

export interface Playback {
  positions: Record<string, number>;
  stepDisplay: number;
  totalSteps: number;
  done: boolean;
  // Racers currently at/above peak speed, straight from whichever step is
  // active right now — a discrete flag, never interpolated/blended like
  // positions are (see KarirsRaceStep's comment in types/index.ts).
  shouting: string[];
}

// Every frame just asks "given how much wall-clock time has passed since
// the anchor instant, where is everyone right now", interpolating between
// the two surrounding steps. Uses Date.now() (wall clock), not
// performance.now() — anchorMs is always a real timestamp, not a monotonic
// clock reading.
export function computePlayback(steps: RaceStep[], anchorMs: number, now: number): Playback {
  if (steps.length === 0) return { positions: {}, stepDisplay: 0, totalSteps: 0, done: false, shouting: [] };

  const elapsedMs = Math.max(0, now - anchorMs);
  const raw = elapsedMs / STEP_DELAY_MS;
  const idx = Math.floor(raw);

  if (idx >= steps.length) {
    const last = steps[steps.length - 1];
    return { positions: last.positions, stepDisplay: steps.length, totalSteps: steps.length, done: true, shouting: last.shouting };
  }

  const frac = raw - idx;
  const prev = idx === 0 ? null : steps[idx - 1].positions;
  const cur = steps[idx];
  const positions: Record<string, number> = {};
  for (const name of Object.keys(cur.positions)) {
    const p = prev ? prev[name] : 0;
    positions[name] = p + (cur.positions[name] - p) * frac;
  }
  return { positions, stepDisplay: idx + 1, totalSteps: steps.length, done: false, shouting: cur.shouting };
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
// here: canvas redraws from scratch every frame by design.
export function renderTrack(
  canvas: HTMLCanvasElement,
  racerNames: string[],
  winningName: string | null,
  isResolved: boolean,
  playback: Playback,
  myBetRacerName: string | null,
  signatureMoves: Record<string, string> = {},
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

  const laneHeight = cssHeight / racerNames.length;
  const trackLeft = 96;
  const trackRight = cssWidth - 28;
  const trackWidth = Math.max(1, trackRight - trackLeft);

  ctx.fillStyle = "#fafaf9";
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  racerNames.forEach((name, i) => {
    const laneTop = laneHeight * i;
    const y = laneTop + laneHeight / 2;

    ctx.fillStyle = i % 2 === 0 ? "#f0efed" : "#fafaf9";
    ctx.fillRect(0, laneTop, cssWidth, laneHeight);

    const isMine = myBetRacerName === name;
    const isWinner = isResolved && name === winningName;

    ctx.font = isMine ? "bold 12px system-ui, sans-serif" : "12px system-ui, sans-serif";
    ctx.fillStyle = isWinner ? "#b45309" : "#404040";
    ctx.textBaseline = "middle";
    const label = `${isMine ? "★ " : ""}${name}`;
    ctx.fillText(truncateToWidth(ctx, label, trackLeft - 12), 6, y);

    const pos = playback.positions[name] ?? 0;
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

    if (playback.shouting.includes(name)) {
      const line = signatureMoves[name] ?? `${name}'s Signature Move!`;
      ctx.font = "bold 10px system-ui, sans-serif";
      const textWidth = ctx.measureText(line).width;
      const bubbleW = textWidth + 12;
      const bubbleH = 16;
      const bubbleX = Math.min(Math.max(x - bubbleW / 2, 2), cssWidth - bubbleW - 2);
      const bubbleY = Math.max(2, y - laneHeight / 2 - bubbleH + 2);

      ctx.fillStyle = "#fef3c7";
      ctx.strokeStyle = "#d97706";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bubbleX, bubbleY, bubbleW, bubbleH, 6);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#92400e";
      ctx.textAlign = "center";
      ctx.fillText(line, bubbleX + bubbleW / 2, bubbleY + bubbleH / 2 + 1);
      ctx.textAlign = "left";
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
