// Named RAM-offset constants, one row per ROM this game recognizes — keyed
// by a client-side checksum/header match on the uploaded file (see
// PokeWorldGame.tsx), never by asking the user which game they have. Every
// offset here is a byte offset into the *inflated* save-state blob a
// captureState() call returns (see emulator.ts's captureState — this is
// mGBA's own serialized-state layout, not a raw GBA guest address; there is
// no live memory-read API in the emulator core we depend on, only
// saveState()-based introspection).
//
// `test_rom` is the only row populated right now. Correction: offset 0xc is
// NOT actually our hand-built ROM's own counter — it's mGBA's own
// `masterCycles` field (the very first few bytes of its serialized-state
// struct), which increments every single emulated CPU cycle regardless of
// what the ROM does. It was mistaken for our counter early on because it's
// also a monotonically-increasing 4-byte value, and the mistake wasn't
// caught until a real Pokémon ROM's read came back in the tens of millions
// after only a few seconds — far too large to be our own slow counter.
// Harmless for what this row is actually used for (synthesizing a
// stand-in, always-changing "position" for the Phase 4 networking/overlay
// demo — see PokeWorldGame.tsx), but it does mean this offset must NOT be
// treated as a template for a real ROM's player-position offset. Finding a
// real one requires the differential (idle vs. moved-by-exactly-one-tile)
// method in the offset-finder tool at ~/mgba_spike instead — see
// emerald_us/firered_us below.
//
// emerald_us is still a TODO — same discovery method as firered_us below,
// just not done yet.
//
// firered_us was found empirically, not derived from pret's source (pret
// gives field/struct *names* like gSaveBlock1Ptr->pos, not the byte offset
// into mGBA's own save-state blob, and hand-deriving that from mGBA's C
// struct layout turned out to be unreliable — see the test_rom correction
// above). The real method: capture state while standing still, take the
// same single step twice in a row, then reverse it, and look for a 16-bit
// value that changes by the *identical* amount for both repeated steps and
// flips sign on the reverse — a real tile coordinate does this; animation/
// audio/VRAM noise from the walk animation doesn't.
//
// That protocol actually found TWO independent candidate pairs against a
// real "Pokemon Fire Red (U)" cartridge, both passing in both the
// horizontal and vertical test: {0x46558, 0x4655a} and
// {0x57e48, 0x57e4a}. The first one was used initially, but real play
// sessions showed it tracking correctly for a while and then silently
// freezing at unpredictable points (confirmed NOT a capture-mechanism bug —
// a whole-state checksum kept changing the entire time the position
// reading was frozen), which points at that address holding some
// transient/shared value that only coincides with player position some of
// the time, not a stable dedicated position field. Switched to the second
// pair to test that theory — if this one holds up reliably where the
// first didn't, that's good evidence the first was simply the wrong
// field, not a deeper bug in this file's whole approach.
//
// mapId/facing were not found this way yet (that needs a map-transition
// test / a menu-driven facing change instead of a plain step test) — left
// absent rather than pointed at a guessed offset; computeLocalPosition
// falls back to sensible defaults (map 0, facing "down") when they're
// missing, same as it did for the fully-synthetic test_rom row.
export type RomVersion = "test_rom" | "emerald_us" | "firered_us" | "unknown";

export interface RomOffsets {
  // Byte offset of the local player's X/Y tile position within the
  // inflated state blob. Both point at the same placeholder offset for
  // test_rom since it only has one real value to read.
  playerX: number;
  playerY: number;
  // Map ID and facing direction are optional — not every row has them
  // discovered yet (see firered_us below). Absent means "unknown," not
  // "always zero"; callers should default sensibly, not read a wrong
  // offset.
  mapId?: number;
  // Facing direction is a single byte GBA-side (commonly 0-3 for
  // down/up/left/right in Pokémon Gen 3's own overworld object struct).
  facing?: number;
}

export const ROM_OFFSETS: Record<RomVersion, RomOffsets | null> = {
  test_rom: { playerX: 0xc, playerY: 0xc },
  emerald_us: null, // TODO: populate using the same discovery method as firered_us
  firered_us: { playerX: 0x57e48, playerY: 0x57e4a },
  unknown: null,
};

// The test ROM has no real cartridge title, so this only ever matches
// "test_rom" (via its title bytes at header offset 0xA0), the specific
// FireRed (U) release the offsets above were found against, or falls
// through to "unknown" for anything else — including other FireRed
// releases/languages/revisions, which are a different binary and would
// need their own offsets found the same way, not assumed to match.
export function detectRomVersion(romBytes: Uint8Array): RomVersion {
  const title = new TextDecoder()
    .decode(romBytes.slice(0xa0, 0xac))
    .replace(/\0+$/, "");
  if (title === "TESTROM") return "test_rom";
  if (title === "POKEMON FIRE") return "firered_us";
  return "unknown";
}
