// Mobile touch HUD — a virtual joystick (movement) plus round action
// buttons (jump/attack/dash/smoke/standings), overlaid on the canvas.
// Web-only: the vscode extension is a desktop editor panel, this file has
// no vscode counterpart. Built the same way the rest of this engine
// builds DOM (plain createElement + inline styles, pointer events) rather
// than as a React component, since it has to live inside the same
// imperative mount()/mountPractice() closures in game.ts, not as JSX.
export interface TouchControlsFrame {
  inputForward: number;
  inputStrafe: number;
  jump: boolean;
  attack: boolean;
  dash: boolean;
  smoke: boolean;
  standingsHeld: boolean;
}

export interface TouchControlsHandle {
  el: HTMLDivElement;
  read(): TouchControlsFrame;
  dispose(): void;
}

const JOYSTICK_SIZE = 96;
const JOYSTICK_KNOB_SIZE = 44;
const JOYSTICK_MAX_RADIUS = (JOYSTICK_SIZE - JOYSTICK_KNOB_SIZE) / 2;

function createJoystick(): { el: HTMLDivElement; read(): { x: number; y: number }; dispose(): void } {
  const base = document.createElement("div");
  base.style.position = "absolute";
  base.style.left = "16px";
  base.style.bottom = "16px";
  base.style.width = `${JOYSTICK_SIZE}px`;
  base.style.height = `${JOYSTICK_SIZE}px`;
  base.style.borderRadius = "50%";
  base.style.background = "rgba(255,255,255,0.12)";
  base.style.border = "2px solid rgba(255,255,255,0.25)";
  base.style.touchAction = "none";
  base.style.pointerEvents = "auto";

  const knob = document.createElement("div");
  knob.style.position = "absolute";
  knob.style.left = `${(JOYSTICK_SIZE - JOYSTICK_KNOB_SIZE) / 2}px`;
  knob.style.top = `${(JOYSTICK_SIZE - JOYSTICK_KNOB_SIZE) / 2}px`;
  knob.style.width = `${JOYSTICK_KNOB_SIZE}px`;
  knob.style.height = `${JOYSTICK_KNOB_SIZE}px`;
  knob.style.borderRadius = "50%";
  knob.style.background = "rgba(255,255,255,0.45)";
  base.appendChild(knob);

  let vecX = 0;
  let vecY = 0;
  let activePointerId: number | null = null;

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
    if (dist > JOYSTICK_MAX_RADIUS) {
      dx = (dx / dist) * JOYSTICK_MAX_RADIUS;
      dy = (dy / dist) * JOYSTICK_MAX_RADIUS;
    }
    setKnob(dx, dy);
    vecX = dx / JOYSTICK_MAX_RADIUS;
    // Screen Y grows downward; dragging the knob up (negative dy) should
    // mean "forward", so this is negated.
    vecY = -dy / JOYSTICK_MAX_RADIUS;
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
    dispose() {
      base.removeEventListener("pointerdown", onPointerDown);
      base.removeEventListener("pointermove", onPointerMove);
      base.removeEventListener("pointerup", release);
      base.removeEventListener("pointercancel", release);
    },
  };
}

function createRoundButton(label: string): { el: HTMLDivElement; held(): boolean; consumePress(): boolean; dispose(): void } {
  const el = document.createElement("div");
  el.textContent = label;
  el.style.width = "56px";
  el.style.height = "56px";
  el.style.borderRadius = "50%";
  el.style.background = "rgba(255,255,255,0.16)";
  el.style.border = "2px solid rgba(255,255,255,0.3)";
  el.style.display = "flex";
  el.style.alignItems = "center";
  el.style.justifyContent = "center";
  el.style.fontSize = "20px";
  el.style.color = "#fff";
  el.style.userSelect = "none";
  el.style.touchAction = "none";
  el.style.pointerEvents = "auto";

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
    dispose() {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointerleave", onUp);
      el.removeEventListener("pointercancel", onUp);
    },
  };
}

// Shown only on touch-primary/narrow viewports (see the caller's own
// matchMedia check) — always mounted, just toggled via setVisible, so a
// window resize across the breakpoint doesn't need new listeners set up.
export function createMobileControls(): TouchControlsHandle & { setVisible(visible: boolean): void } {
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.inset = "0";
  el.style.pointerEvents = "none"; // only the joystick/buttons themselves intercept touches
  el.style.display = "none";

  const joystick = createJoystick();
  el.appendChild(joystick.el);

  const buttonRow = document.createElement("div");
  buttonRow.style.position = "absolute";
  buttonRow.style.right = "16px";
  buttonRow.style.bottom = "16px";
  buttonRow.style.display = "flex";
  buttonRow.style.gap = "10px";
  buttonRow.style.pointerEvents = "auto";

  const jumpBtn = createRoundButton("⤴");
  const attackBtn = createRoundButton("⚔");
  const dashBtn = createRoundButton("⚡");
  const smokeBtn = createRoundButton("💨");
  const standingsBtn = createRoundButton("☰");
  buttonRow.appendChild(jumpBtn.el);
  buttonRow.appendChild(attackBtn.el);
  buttonRow.appendChild(dashBtn.el);
  buttonRow.appendChild(smokeBtn.el);
  buttonRow.appendChild(standingsBtn.el);
  el.appendChild(buttonRow);

  return {
    el,
    read() {
      const { x, y } = joystick.read();
      return {
        inputForward: y,
        inputStrafe: x,
        jump: jumpBtn.consumePress(),
        attack: attackBtn.consumePress(),
        dash: dashBtn.consumePress(),
        smoke: smokeBtn.consumePress(),
        standingsHeld: standingsBtn.held(),
      };
    },
    setVisible(visible: boolean) {
      el.style.display = visible ? "block" : "none";
    },
    dispose() {
      joystick.dispose();
      jumpBtn.dispose();
      attackBtn.dispose();
      dashBtn.dispose();
      smokeBtn.dispose();
      standingsBtn.dispose();
    },
  };
}
