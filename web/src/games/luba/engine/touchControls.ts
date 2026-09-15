// Mobile touch HUD — a virtual joystick (movement) plus round action
// buttons (jump/attack/dash/smoke/standings), plus swipe-to-look camera
// control. Web-only: the vscode extension is a desktop editor panel, this
// file has no vscode counterpart. Built the same way the rest of this
// engine builds DOM (plain createElement + inline styles, pointer events)
// rather than as a React component, since it has to live inside the same
// imperative mount()/mountPractice() closures in game.ts, not as JSX.
//
// Two layout modes, chosen by the caller (game.ts, based on fullscreen
// state — see its own comment on why fullscreen forces "overlay"):
//   - "docked": joystick + buttons sit in a bar pinned to the bottom of
//     the *viewport* (position:fixed, not just "below the canvas" in
//     document flow — the canvas's own height varies with screen width,
//     so anything short of viewport-fixed could still land off-screen or
//     with dead space under it) with a solid dark background, so
//     touching them never covers the game view and they stay visibly
//     legible regardless of the surrounding page's own background.
//   - "overlay": the same joystick + buttons (the identical DOM nodes,
//     just reparented — this keeps their event listeners/pointer-capture
//     state intact across a mode switch) sit absolutely positioned over
//     the canvas instead, bigger and arranged as a thumb cluster (see
//     buildOverlayCluster below), for when there's no "below the canvas"
//     space left (fullscreen).
export interface TouchControlsFrame {
  inputForward: number;
  inputStrafe: number;
  // Swipe-to-look deltas, same units/sign convention as createInputState's
  // mouseTurnDelta/mousePitchDelta in game.ts (radians, already scaled by
  // sensitivity) — the caller just adds them together.
  turnDelta: number;
  pitchDelta: number;
  jump: boolean;
  attack: boolean;
  dash: boolean;
  smoke: boolean;
  standingsHeld: boolean;
}

export type MobileControlsMode = "hidden" | "docked" | "overlay";

export interface TouchControlsHandle {
  dockedEl: HTMLDivElement;
  overlayEl: HTMLDivElement;
  read(): TouchControlsFrame;
  setMode(mode: MobileControlsMode): void;
  dispose(): void;
}

const DOCKED_JOYSTICK_SIZE = 96;
const OVERLAY_JOYSTICK_SIZE = 128; // "a bit bigger" for fullscreen, per request
const JOYSTICK_KNOB_RATIO = 44 / 96; // knob stays proportional to whatever size is set

const DOCKED_BUTTON_SIZE = 56;
// Overlay sizes form the requested cluster: attack (slash) is the
// biggest/primary button, dash sits just left of it slightly smaller,
// jump/smoke stay at the normal size, standings shrinks since it's the
// least combat-critical.
const OVERLAY_ATTACK_SIZE = 80;
const OVERLAY_DASH_SIZE = 68;
const OVERLAY_SECONDARY_SIZE = 56;
const OVERLAY_STANDINGS_SIZE = 46;

// Tall enough for the 3-row button cluster (see buildCluster below) at
// docked size: 3 * DOCKED_BUTTON_SIZE + 2 gaps + top/bottom breathing
// room. A flat single row of all 5 buttons used to live here instead, but
// at typical portrait phone widths a 5-across row anchored to the right
// edge started well to the *left* of the joystick's own right edge,
// overlapping it — stacking into a narrower multi-row cluster (same
// shape as the overlay's, just without its size differences) keeps the
// whole thing well clear of the joystick regardless of screen width.
const DOCKED_BAR_HEIGHT = 224;

function createJoystick(): { el: HTMLDivElement; read(): { x: number; y: number }; setSize(size: number): void; dispose(): void } {
  const base = document.createElement("div");
  base.style.position = "absolute";
  base.style.left = "16px";
  base.style.bottom = "16px";
  base.style.borderRadius = "50%";
  base.style.background = "rgba(255,255,255,0.12)";
  base.style.border = "2px solid rgba(255,255,255,0.25)";
  base.style.touchAction = "none";
  base.style.pointerEvents = "auto";

  const knob = document.createElement("div");
  knob.style.position = "absolute";
  knob.style.borderRadius = "50%";
  knob.style.background = "rgba(255,255,255,0.45)";
  base.appendChild(knob);

  let vecX = 0;
  let vecY = 0;
  let activePointerId: number | null = null;
  let maxRadius = (DOCKED_JOYSTICK_SIZE - DOCKED_JOYSTICK_SIZE * JOYSTICK_KNOB_RATIO) / 2;

  function setSize(size: number) {
    const knobSize = size * JOYSTICK_KNOB_RATIO;
    maxRadius = (size - knobSize) / 2;
    base.style.width = `${size}px`;
    base.style.height = `${size}px`;
    knob.style.left = `${(size - knobSize) / 2}px`;
    knob.style.top = `${(size - knobSize) / 2}px`;
    knob.style.width = `${knobSize}px`;
    knob.style.height = `${knobSize}px`;
  }
  setSize(DOCKED_JOYSTICK_SIZE);

  function setKnob(dx: number, dz: number) {
    knob.style.transform = `translate(${dx}px, ${dz}px)`;
  }

  function onPointerDown(e: PointerEvent) {
    if (activePointerId !== null) return;
    activePointerId = e.pointerId;
    base.setPointerCapture(e.pointerId);
    updateFromEvent(e);
  }
  function updateFromEvent(e: PointerEvent) {
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > maxRadius) {
      dx = (dx / dist) * maxRadius;
      dy = (dy / dist) * maxRadius;
    }
    setKnob(dx, dy);
    vecX = dx / maxRadius;
    // Screen Y grows downward; dragging the knob up (negative dy) should
    // mean "forward", so this is negated.
    vecY = -dy / maxRadius;
  }
  function onPointerMove(e: PointerEvent) {
    if (e.pointerId !== activePointerId) return;
    updateFromEvent(e);
  }
  function release(e: PointerEvent) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    vecX = 0;
    vecY = 0;
    setKnob(0, 0);
  }

  base.addEventListener("pointerdown", onPointerDown);
  base.addEventListener("pointermove", onPointerMove);
  base.addEventListener("pointerup", release);
  base.addEventListener("pointercancel", release);

  return {
    el: base,
    read: () => ({ x: vecX, y: vecY }),
    setSize,
    dispose() {
      base.removeEventListener("pointerdown", onPointerDown);
      base.removeEventListener("pointermove", onPointerMove);
      base.removeEventListener("pointerup", release);
      base.removeEventListener("pointercancel", release);
    },
  };
}

function createRoundButton(label: string): { el: HTMLDivElement; held(): boolean; consumePress(): boolean; setSize(size: number): void; dispose(): void } {
  const el = document.createElement("div");
  el.textContent = label;
  el.style.borderRadius = "50%";
  el.style.background = "rgba(255,255,255,0.16)";
  el.style.border = "2px solid rgba(255,255,255,0.3)";
  el.style.display = "flex";
  el.style.alignItems = "center";
  el.style.justifyContent = "center";
  el.style.color = "#fff";
  el.style.userSelect = "none";
  el.style.touchAction = "none";
  el.style.pointerEvents = "auto";
  el.style.flex = "none"; // never let a flex/grid parent shrink these off their explicit size

  function setSize(size: number) {
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    // Roughly the same glyph-to-button ratio the original fixed 56px/20px
    // button used, so bigger buttons get proportionally bigger icons too.
    el.style.fontSize = `${Math.round(size * 0.36)}px`;
  }
  setSize(DOCKED_BUTTON_SIZE);

  let isHeld = false;
  let pressed = false; // consumed on next read, mirrors keyboard's queued-until-consumed semantics
  function onDown(e: PointerEvent) {
    e.preventDefault();
    isHeld = true;
    pressed = true;
    el.style.background = "rgba(255,255,255,0.32)";
  }
  function onUp() {
    isHeld = false;
    el.style.background = "rgba(255,255,255,0.16)";
  }
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointerleave", onUp);
  el.addEventListener("pointercancel", onUp);

  return {
    el,
    held: () => isHeld,
    consumePress() {
      const p = pressed;
      pressed = false;
      return p;
    },
    setSize,
    dispose() {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointerleave", onUp);
      el.removeEventListener("pointercancel", onUp);
    },
  };
}

// canvas is needed here (not just for the caller) because swipe-to-look
// listens directly on it — a drag starting on the joystick/buttons never
// reaches these listeners since those are separate elements that already
// claim their own touches via pointer capture, so this only ever sees
// touches on the open canvas surface.
export function createMobileControls(canvas: HTMLCanvasElement): TouchControlsHandle {
  const dockedEl = document.createElement("div");
  dockedEl.style.position = "fixed";
  dockedEl.style.left = "0";
  dockedEl.style.right = "0";
  dockedEl.style.bottom = "0";
  dockedEl.style.height = `${DOCKED_BAR_HEIGHT}px`;
  dockedEl.style.background = "#18181b";
  dockedEl.style.borderTop = "1px solid #3f3f46";
  dockedEl.style.zIndex = "20";
  dockedEl.style.display = "none";

  const overlayEl = document.createElement("div");
  overlayEl.style.position = "absolute";
  overlayEl.style.inset = "0";
  overlayEl.style.pointerEvents = "none"; // only the joystick/buttons themselves intercept touches
  overlayEl.style.display = "none";

  const joystick = createJoystick();

  const jumpBtn = createRoundButton("⤴");
  const attackBtn = createRoundButton("⚔");
  const dashBtn = createRoundButton("⚡");
  const smokeBtn = createRoundButton("💨");
  const standingsBtn = createRoundButton("☰");

  // Shared thumb-cluster layout, reused for both modes (only sizes differ
  // — see applyMode below): attack anchors the bottom-right corner, dash
  // sits just to its left, jump/smoke form a row above them (smoke lands
  // above attack, jump above dash, by right-aligning both rows against
  // each other), and standings tucks in above that. Built with flex
  // rather than manual pixel offsets so it stays correct regardless of
  // which size constants apply. Narrow (at most 2 buttons wide) by
  // design — a single 5-across row used to live here instead, but at
  // typical portrait phone widths it started well to the *left* of the
  // joystick's own right edge, overlapping it.
  const cluster = document.createElement("div");
  cluster.style.position = "absolute";
  cluster.style.right = "16px";
  cluster.style.bottom = "16px";
  cluster.style.display = "flex";
  cluster.style.flexDirection = "column";
  cluster.style.alignItems = "flex-end";
  cluster.style.gap = "10px";

  const standingsRow = document.createElement("div");
  const secondaryRow = document.createElement("div");
  secondaryRow.style.display = "flex";
  secondaryRow.style.gap = "10px";
  const primaryRow = document.createElement("div");
  primaryRow.style.display = "flex";
  primaryRow.style.gap = "10px";
  primaryRow.style.alignItems = "flex-end"; // dash (smaller, in overlay mode) bottom-aligns with attack, not top-aligns

  standingsRow.appendChild(standingsBtn.el);
  secondaryRow.appendChild(jumpBtn.el);
  secondaryRow.appendChild(smokeBtn.el);
  primaryRow.appendChild(dashBtn.el);
  primaryRow.appendChild(attackBtn.el);
  cluster.appendChild(standingsRow);
  cluster.appendChild(secondaryRow);
  cluster.appendChild(primaryRow);

  let mode: MobileControlsMode = "hidden";
  function applyMode() {
    dockedEl.style.display = mode === "docked" ? "block" : "none";
    overlayEl.style.display = mode === "overlay" ? "block" : "none";

    if (mode === "overlay") {
      joystick.setSize(OVERLAY_JOYSTICK_SIZE);
      attackBtn.setSize(OVERLAY_ATTACK_SIZE);
      dashBtn.setSize(OVERLAY_DASH_SIZE);
      jumpBtn.setSize(OVERLAY_SECONDARY_SIZE);
      smokeBtn.setSize(OVERLAY_SECONDARY_SIZE);
      standingsBtn.setSize(OVERLAY_STANDINGS_SIZE);
      overlayEl.appendChild(joystick.el);
      overlayEl.appendChild(cluster);
    } else {
      joystick.setSize(DOCKED_JOYSTICK_SIZE);
      attackBtn.setSize(DOCKED_BUTTON_SIZE);
      dashBtn.setSize(DOCKED_BUTTON_SIZE);
      jumpBtn.setSize(DOCKED_BUTTON_SIZE);
      smokeBtn.setSize(DOCKED_BUTTON_SIZE);
      standingsBtn.setSize(DOCKED_BUTTON_SIZE);
      dockedEl.appendChild(joystick.el);
      dockedEl.appendChild(cluster);
    }
  }
  applyMode();

  // Swipe-to-look — mirrors the desktop's pointer-locked mouse-look, but
  // always-on rather than a toggle (there's no keyboard to press "M"
  // with). pointerType-gated to touch only: a touch tap also synthesizes
  // a compatibility mousedown, which game.ts's createInputState uses to
  // queue a sword attack on canvas clicks — without this gate, swiping to
  // look would also swing the sword. createInputState's own mousedown
  // handling was switched to pointerdown+pointerType==='mouse' at the
  // same time, for the same reason, from the other direction.
  let swipePointerId: number | null = null;
  let lastSwipeX = 0;
  let lastSwipeY = 0;
  let turnDelta = 0;
  let pitchDelta = 0;
  const SWIPE_SENSITIVITY = 0.006;
  function onCanvasPointerDown(e: PointerEvent) {
    if (e.pointerType !== "touch" || swipePointerId !== null) return;
    swipePointerId = e.pointerId;
    lastSwipeX = e.clientX;
    lastSwipeY = e.clientY;
  }
  function onCanvasPointerMove(e: PointerEvent) {
    if (e.pointerId !== swipePointerId) return;
    const dx = e.clientX - lastSwipeX;
    const dy = e.clientY - lastSwipeY;
    lastSwipeX = e.clientX;
    lastSwipeY = e.clientY;
    turnDelta += -dx * SWIPE_SENSITIVITY;
    pitchDelta += -dy * SWIPE_SENSITIVITY;
  }
  function onCanvasPointerUp(e: PointerEvent) {
    if (e.pointerId !== swipePointerId) return;
    swipePointerId = null;
  }
  canvas.addEventListener("pointerdown", onCanvasPointerDown);
  canvas.addEventListener("pointermove", onCanvasPointerMove);
  canvas.addEventListener("pointerup", onCanvasPointerUp);
  canvas.addEventListener("pointercancel", onCanvasPointerUp);

  return {
    dockedEl,
    overlayEl,
    read(): TouchControlsFrame {
      const { x, y } = joystick.read();
      const t = turnDelta;
      const p = pitchDelta;
      turnDelta = 0;
      pitchDelta = 0;
      return {
        inputForward: y,
        inputStrafe: x,
        turnDelta: t,
        pitchDelta: p,
        jump: jumpBtn.consumePress(),
        attack: attackBtn.consumePress(),
        dash: dashBtn.consumePress(),
        smoke: smokeBtn.consumePress(),
        standingsHeld: standingsBtn.held(),
      };
    },
    setMode(next: MobileControlsMode) {
      mode = next;
      applyMode();
    },
    dispose() {
      joystick.dispose();
      jumpBtn.dispose();
      attackBtn.dispose();
      dashBtn.dispose();
      smokeBtn.dispose();
      standingsBtn.dispose();
      canvas.removeEventListener("pointerdown", onCanvasPointerDown);
      canvas.removeEventListener("pointermove", onCanvasPointerMove);
      canvas.removeEventListener("pointerup", onCanvasPointerUp);
      canvas.removeEventListener("pointercancel", onCanvasPointerUp);
    },
  };
}
