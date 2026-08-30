// A stateful wrapper around @thenick775/mgba-wasm — created once per
// PokeWorldGame mount, matching karirs' createKarirsScene3D(canvas)
// convention (a factory returning an imperative handle, not a React hook
// itself, so it can be driven from a plain RAF/interval loop reading only
// refs — see render3d.ts).
//
// The actual JS glue (mgba.js) is loaded from a plain static URL
// (web/public/mgba/), not through a regular `import "@thenick775/mgba-wasm"`
// — its threaded runtime spawns a pthread Web Worker that re-loads that
// exact script by URL, which requires it to stay an untouched, same-origin,
// non-hashed file. Letting Vite bundle/hash it would break that assumption,
// so this dynamically imports the public URL instead; @vite-ignore tells
// Vite not to try to statically analyze/bundle a path that's deliberately
// not one of its own modules.
//
// Also requires the page itself to be cross-origin isolated (COOP:
// same-origin + COEP: require-corp — see vite.config.ts and
// public/serve.json) and served over a secure context: browsers only treat
// plain HTTP as secure for localhost specifically, so this needs real
// HTTPS everywhere else.
// import.meta.env.BASE_URL (not a hardcoded "/mgba/...") because production
// serves the whole app under a "/cheddar/" base path (see vite.config.ts) —
// a hardcoded absolute path here would resolve to the site root instead and
// 404, the same class of bug the mgba_spike harness hit with an absolute
// "/test.gba" fetch path under its own "/mgba-spike/" nginx prefix.
const MGBA_SCRIPT_URL = `${import.meta.env.BASE_URL}mgba/mgba.js`;

interface MgbaFilePaths {
  root: string;
  gamePath: string;
  saveStatePath: string;
}

// Only the subset of mGBAEmulator's real (much larger) API surface this
// wrapper actually calls — see node_modules/@thenick775/mgba-wasm/dist/mgba.d.ts
// for the full contract. Declared locally rather than importing that
// package's own types, since its `export =` namespace style doesn't mix
// cleanly with loading the runtime value from a raw URL instead of through
// node_modules.
interface MgbaModule {
  version: { projectName: string; projectVersion: string };
  FSInit(): Promise<void>;
  uploadRom(file: File, callback?: () => void): void;
  loadGame(romPath: string, savePathOverride?: string): boolean;
  resumeGame(): void;
  pauseGame(): void;
  saveState(slot: number): boolean;
  bindKey(bindingName: string, inputName: string): void;
  filePaths(): MgbaFilePaths;
  FS: {
    readdir(path: string): string[];
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
    stat(path: string): { mtime: Date };
  };
}

type MgbaFactory = (options: { canvas: HTMLCanvasElement }) => Promise<MgbaModule>;

export interface StateCapture {
  bytes: Uint8Array;
  captureMs: number;
}

export interface PokeWorldEmulatorHandle {
  version: string;
  loadRom(file: File): Promise<boolean>;
  resume(): void;
  pause(): void;
  dispose(): void;
  // Snapshots the running game's full state via saveState() + a PNG/zlib
  // unpack (see memoryMap.ts's file comment for why — there is no live
  // memory-read API in this build). Returns null if no ROM is loaded yet or
  // the capture fails for any reason; callers should just skip that tick
  // rather than treat it as fatal.
  captureState(): Promise<StateCapture | null>;
}

function extractGbAsChunk(pngBytes: Uint8Array): Uint8Array {
  let offset = 8; // skip the 8-byte PNG signature
  const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  while (offset + 8 <= pngBytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      pngBytes[offset + 4],
      pngBytes[offset + 5],
      pngBytes[offset + 6],
      pngBytes[offset + 7],
    );
    const data = pngBytes.slice(offset + 8, offset + 8 + length);
    if (type === "gbAs") return data;
    offset += 8 + length + 4; // length + type + data + crc
  }
  throw new Error("save state PNG has no gbAs chunk");
}

async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  // .slice() (not a plain buffer reference) so this is always a fresh,
  // definitely-non-shared ArrayBuffer regardless of what backs the input
  // view — Blob's type only accepts ArrayBuffer, not SharedArrayBuffer,
  // which mGBA's threaded runtime could in principle hand back here.
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("deflate"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function createPokeWorldEmulator(canvas: HTMLCanvasElement): Promise<PokeWorldEmulatorHandle> {
  const imported = (await import(/* @vite-ignore */ MGBA_SCRIPT_URL)) as { default: MgbaFactory };
  const module = await imported.default({ canvas });
  await module.FSInit();

  // No default key bindings are documented for this package — without
  // these the emulator loads and renders but the player has no way to
  // actually move their character. Standard GBA-emulator convention
  // (arrow keys for the d-pad, Z/X for A/B, Return/Backspace for
  // Start/Select).
  module.bindKey("Left", "Left");
  module.bindKey("Right", "Right");
  module.bindKey("Up", "Up");
  module.bindKey("Down", "Down");
  module.bindKey("Z", "A");
  module.bindKey("X", "B");
  module.bindKey("Return", "Start");
  module.bindKey("Backspace", "Select");

  let loaded = false;
  let stateSlotCounter = 0;

  async function loadRom(file: File): Promise<boolean> {
    await new Promise<void>((resolve) => module.uploadRom(file, () => resolve()));
    const paths = module.filePaths();
    const ok = module.loadGame(`${paths.gamePath}/${file.name}`);
    if (ok) {
      module.resumeGame();
      loaded = true;
    }
    return ok;
  }

  async function captureState(): Promise<StateCapture | null> {
    if (!loaded) return null;
    const started = performance.now();
    const paths = module.filePaths();

    // Ever-incrementing slot number, no cleanup, freshness identified by
    // diffing the directory before/after saveState() — this is the one
    // variant, out of several tried, that actually held up under real
    // testing (30+ continuous seconds tracking real movement correctly).
    // Every other variant called module.FS.unlink() to remove old
    // save-state files — either reusing one slot, or clearing the
    // directory before each write — and every one of those broke down
    // dramatically faster than this one. The strong, repeated correlation
    // (unlink present -> breaks almost immediately; unlink absent -> holds
    // up for a real, multi-tile walk) points at unlink() itself having
    // some destructive side effect on this package's save-state
    // bookkeeping beyond just removing that one file — not proven, but
    // consistent enough across several attempts to treat as a hard rule:
    // never call FS.unlink() on the save-state directory. The tradeoff
    // this accepts is unbounded file accumulation in IndexedDB over a long
    // session — a real but much smaller problem than incorrect position
    // data, and a separate one to solve later (e.g. clearing very
    // infrequently, well after confirming it doesn't reintroduce this).
    const before = new Set(module.FS.readdir(paths.saveStatePath));
    const slot = stateSlotCounter++;
    if (!module.saveState(slot)) throw new Error(`saveState(${slot}) returned false`);
    const after = module.FS.readdir(paths.saveStatePath);
    const newFiles = after.filter((f) => !before.has(f));
    if (newFiles.length !== 1) {
      throw new Error(`expected exactly one new save-state file after saveState(${slot}), found ${newFiles.length}: ${newFiles.join(", ")}`);
    }

    const pngBytes = module.FS.readFile(`${paths.saveStatePath}/${newFiles[0]}`);
    const gbAsChunk = extractGbAsChunk(pngBytes);
    const bytes = await inflateZlib(gbAsChunk);
    return { bytes, captureMs: performance.now() - started };
  }

  return {
    version: `${module.version.projectName} ${module.version.projectVersion}`,
    loadRom,
    resume: () => module.resumeGame(),
    pause: () => module.pauseGame(),
    captureState,
    dispose: () => {
      // No teardown call is documented beyond pausing — the canvas element
      // itself gets torn down by React regardless, and this game is a
      // single always-on world (see the plan), not something users are
      // expected to mount/unmount rapidly.
      module.pauseGame();
    },
  };
}
