export interface EmulatorHandle {
  version: string;
  loadRom(file: File): Promise<boolean>;
  resume(): void;
  pause(): void;
  buttonPress(name: string): void;
  buttonUnpress(name: string): void;
  dispose(): void;
}

// mgba-wasm's threaded runtime needs a same-origin, non-hashed script —
// Vite can't bundle it (it spins up its own Workers referencing itself
// by URL), so it's loaded as a dynamic import against the public static
// copy vendored into public/mgba/ (copied by hand from
// node_modules/@thenick775/mgba-wasm/dist/, since node_modules isn't
// served statically in production).
export async function createEmulator(canvas: HTMLCanvasElement): Promise<EmulatorHandle> {
  // Routed through a variable rather than a literal string specifier —
  // tsc statically resolves (and fails on) a literal import() path even
  // though this is only ever meant to run at runtime against a public
  // static file, not a bundler-resolved module. Built off BASE_URL
  // (Vite's own resolved `base` config, e.g. "/cheddar/" in production)
  // rather than a hardcoded absolute "/mgba/..." — an absolute path
  // resolves against the domain root and ignores the app's own base
  // path entirely, which silently 404s once deployed under a subpath.
  const mgbaModuleUrl = `${import.meta.env.BASE_URL}mgba/mgba.js`;
  const mGBA = (await import(/* @vite-ignore */ mgbaModuleUrl)).default;
  const Module = await mGBA({ canvas });
  await Module.FSInit();

  Module.bindKey("Left", "Left");
  Module.bindKey("Right", "Right");
  Module.bindKey("Up", "Up");
  Module.bindKey("Down", "Down");
  Module.bindKey("Z", "A");
  Module.bindKey("X", "B");
  Module.bindKey("Return", "Start");
  Module.bindKey("Backspace", "Select");

  async function loadRom(file: File): Promise<boolean> {
    await new Promise<void>((resolve) => Module.uploadRom(file, resolve));
    const paths = Module.filePaths();
    const ok = Module.loadGame(paths.gamePath + "/" + file.name);
    if (ok) Module.resumeGame();
    return ok;
  }

  return {
    version: `${Module.version.projectName} ${Module.version.projectVersion}`,
    loadRom,
    resume: () => Module.resumeGame(),
    pause: () => Module.pauseGame(),
    buttonPress: (name: string) => Module.buttonPress(name),
    buttonUnpress: (name: string) => Module.buttonUnpress(name),
    dispose: () => Module.quitMgba(),
  };
}
