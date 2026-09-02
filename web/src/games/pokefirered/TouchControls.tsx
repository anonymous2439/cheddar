import type { EmulatorHandle } from "./emulator";

interface Props {
  emulator: EmulatorHandle;
}

// On-screen controls for touch devices — presses the same GBA buttons
// the keyboard bindings map to (see emulator.ts's bindKey calls), via
// mgba-wasm's direct buttonPress/buttonUnpress API.
export function TouchControls({ emulator }: Props) {
  function pressProps(gbaButton: string) {
    return {
      onPointerDown: (e: React.PointerEvent) => {
        e.preventDefault();
        emulator.buttonPress(gbaButton);
      },
      onPointerUp: () => emulator.buttonUnpress(gbaButton),
      onPointerLeave: () => emulator.buttonUnpress(gbaButton),
      onPointerCancel: () => emulator.buttonUnpress(gbaButton),
    };
  }

  const dpadButtonClass =
    "flex h-12 w-12 items-center justify-center rounded bg-neutral-800 text-lg text-white active:bg-neutral-600 select-none";
  const actionButtonClass =
    "flex h-14 w-14 items-center justify-center rounded-full bg-neutral-800 text-sm font-semibold text-white active:bg-neutral-600 select-none";
  const utilButtonClass =
    "rounded bg-neutral-800 px-3 py-1.5 text-xs text-white active:bg-neutral-600 select-none";

  return (
    <div className="mt-3 flex items-center justify-between" style={{ touchAction: "none" }}>
      <div className="grid w-fit grid-cols-3 grid-rows-3 gap-1">
        <div />
        <button {...pressProps("Up")} className={dpadButtonClass} aria-label="Up">
          ↑
        </button>
        <div />

        <button {...pressProps("Left")} className={dpadButtonClass} aria-label="Left">
          ←
        </button>
        <div />
        <button {...pressProps("Right")} className={dpadButtonClass} aria-label="Right">
          →
        </button>

        <div />
        <button {...pressProps("Down")} className={dpadButtonClass} aria-label="Down">
          ↓
        </button>
        <div />
      </div>

      <div className="flex flex-col items-center gap-2">
        <button {...pressProps("Select")} className={utilButtonClass}>
          Select
        </button>
        <button {...pressProps("Start")} className={utilButtonClass}>
          Start
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button {...pressProps("B")} className={actionButtonClass} aria-label="B">
          B
        </button>
        <button {...pressProps("A")} className={actionButtonClass} aria-label="A">
          A
        </button>
      </div>
    </div>
  );
}
