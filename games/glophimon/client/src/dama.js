// Dama — the Filipino draughts variant (see this game's own plan file for
// the ruleset chosen). Phase 1 only: a pure, dependency-free rules engine
// with no rendering/networking of its own, so it can be exercised by
// self-play in a Dev-menu test modal (see game.js) before anything about
// hosting/AI exists. Board coordinates are [row][col], row 0 at the top;
// pieces sit only on the dark squares, (row + col) odd.
//
// Ruleset (a few genuinely regional choices, picked and recorded here
// rather than left ambiguous):
//  - A man moves one square diagonally *forward* onto an empty square, but
//    CAPTURES in any of the 4 diagonal directions (including backward) —
//    this is Dama's own real departure from American checkers, where a man
//    can only ever capture forward.
//  - Capturing is mandatory whenever any of the side-to-move's pieces has
//    one available. Real Filipino Dama goes further than "any legal capture
//    is fine" though — its own "majority capture" rule additionally forces
//    whichever piece/sequence captures the *most* pieces this turn (across
//    every piece and every fork in a multi-jump chain, not just the first
//    hop), and only as a tie-break at equal count, whichever captures a
//    king (a "dama") over a man. See getAllLegalMoves below for exactly how
//    this narrows the legal-move list; ties that are equal on both counts
//    still leave the player a free choice.
//  - A capture that lands the piece on the far row promotes it to a king
//    immediately, and if that same piece has a further capture available
//    from its new square, the chain continues using its new king moves.
//  - Kings are "flying kings" (international-draughts style): they move
//    any number of empty squares along a diagonal, and capture by jumping
//    an enemy piece anywhere along a diagonal to land on any empty square
//    beyond it.
export const DAMA_SIZE = 8;

export function createInitialDamaBoard() {
  const board = Array.from({ length: DAMA_SIZE }, () => Array(DAMA_SIZE).fill(null));
  for (let row = 0; row < DAMA_SIZE; row++) {
    for (let col = 0; col < DAMA_SIZE; col++) {
      if ((row + col) % 2 !== 1) continue; // dark squares only
      if (row <= 2) board[row][col] = { side: "black", king: false };
      else if (row >= 5) board[row][col] = { side: "white", king: false };
    }
  }
  return board;
}

function inBounds(row, col) {
  return row >= 0 && row < DAMA_SIZE && col >= 0 && col < DAMA_SIZE;
}

const DIAGONALS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

function forwardDir(side) {
  return side === "black" ? 1 : -1; // black starts at the top, moves down; white starts at the bottom, moves up
}

function isBackRow(side, row) {
  return side === "black" ? row === DAMA_SIZE - 1 : row === 0;
}

// Every single-jump capture a man at (row, col) can currently make — a
// plain array, since a man's own captures are never ambiguous about the
// landing square (always exactly 2 squares from its start).
function manCaptures(board, row, col, side) {
  const moves = [];
  for (const [dr, dc] of DIAGONALS) {
    const midRow = row + dr;
    const midCol = col + dc;
    const toRow = row + dr * 2;
    const toCol = col + dc * 2;
    if (!inBounds(toRow, toCol)) continue;
    const mid = board[midRow][midCol];
    if (mid && mid.side !== side && board[toRow][toCol] === null) {
      moves.push({ to: { row: toRow, col: toCol }, captured: { row: midRow, col: midCol } });
    }
  }
  return moves;
}

function manSimpleMoves(board, row, col, side) {
  const moves = [];
  const dr = forwardDir(side);
  for (const dc of [-1, 1]) {
    const toRow = row + dr;
    const toCol = col + dc;
    if (inBounds(toRow, toCol) && board[toRow][toCol] === null) {
      moves.push({ to: { row: toRow, col: toCol } });
    }
  }
  return moves;
}

// A king's captures: for each diagonal direction, walk outward over empty
// squares; the first non-empty square encountered is either an enemy (in
// which case every empty square immediately beyond it, until the next
// obstacle or the edge, is a valid landing square) or a friendly piece (no
// capture that direction).
function kingCaptures(board, row, col, side) {
  const moves = [];
  for (const [dr, dc] of DIAGONALS) {
    let r = row + dr;
    let c = col + dc;
    while (inBounds(r, c) && board[r][c] === null) {
      r += dr;
      c += dc;
    }
    if (!inBounds(r, c) || board[r][c].side === side) continue; // ran off the board, or hit a friendly piece first
    const capturedRow = r;
    const capturedCol = c;
    r += dr;
    c += dc;
    while (inBounds(r, c) && board[r][c] === null) {
      moves.push({ to: { row: r, col: c }, captured: { row: capturedRow, col: capturedCol } });
      r += dr;
      c += dc;
    }
  }
  return moves;
}

function kingSimpleMoves(board, row, col) {
  const moves = [];
  for (const [dr, dc] of DIAGONALS) {
    let r = row + dr;
    let c = col + dc;
    while (inBounds(r, c) && board[r][c] === null) {
      moves.push({ to: { row: r, col: c } });
      r += dr;
      c += dc;
    }
  }
  return moves;
}

// The null guards here are a pure safety net, not a normal case: every
// caller in this file only ever passes a square it already knows holds a
// piece. It matters for forcedFromSquare (see getAllLegalMoves) though —
// that value is threaded through from game.js's own activeDamaMatch state
// across a network round trip, so if it's ever stale relative to
// whatever board this gets called with, this returns "no moves" instead of
// throwing and wedging the whole match modal's render.
function capturesForPiece(board, row, col) {
  const piece = board[row][col];
  if (!piece) return [];
  return piece.king ? kingCaptures(board, row, col, piece.side) : manCaptures(board, row, col, piece.side);
}

function simpleMovesForPiece(board, row, col) {
  const piece = board[row][col];
  if (!piece) return [];
  return piece.king ? kingSimpleMoves(board, row, col) : manSimpleMoves(board, row, col, piece.side);
}

// Recursively computes the best (count, kingCount) achievable by a single
// piece's own capture chain starting/continuing from (row, col) — the core
// of the majority-capture rule above. Compared lexicographically: count
// first (quantity always outranks rank), kingCount only as a tie-break.
function bestCaptureValue(board, row, col) {
  const moves = capturesForPiece(board, row, col);
  if (moves.length === 0) return { count: 0, kingCount: 0 };
  let best = { count: -1, kingCount: -1 };
  for (const m of moves) {
    const capturedWasKing = board[m.captured.row][m.captured.col].king;
    const { board: nextBoard, continuedCaptureFrom } = applyDamaMove(board, { from: { row, col }, to: m.to, captured: m.captured });
    const rest = continuedCaptureFrom ? bestCaptureValue(nextBoard, continuedCaptureFrom.row, continuedCaptureFrom.col) : { count: 0, kingCount: 0 };
    const total = { count: 1 + rest.count, kingCount: (capturedWasKing ? 1 : 0) + rest.kingCount };
    if (isBetterValue(total, best)) best = total;
  }
  return best;
}

function isBetterValue(a, b) {
  return a.count > b.count || (a.count === b.count && a.kingCount > b.kingCount);
}

// Among one piece's own immediate capture options (a fork mid-chain, or its
// very first hop), keep only whichever achieve that piece's own best
// (count, kingCount) per bestCaptureValue above — i.e. this piece's own
// slice of the majority-capture rule, with no comparison against any other
// piece (see getAllLegalMoves's own forcedFromSquare for why that matters).
function mandatoryMovesForPiece(board, row, col) {
  const moves = capturesForPiece(board, row, col);
  if (moves.length === 0) return [];
  const scored = moves.map((m) => {
    const capturedWasKing = board[m.captured.row][m.captured.col].king;
    const { board: nextBoard, continuedCaptureFrom } = applyDamaMove(board, { from: { row, col }, to: m.to, captured: m.captured });
    const rest = continuedCaptureFrom ? bestCaptureValue(nextBoard, continuedCaptureFrom.row, continuedCaptureFrom.col) : { count: 0, kingCount: 0 };
    return { move: { from: { row, col }, to: m.to, captured: m.captured }, total: { count: 1 + rest.count, kingCount: (capturedWasKing ? 1 : 0) + rest.kingCount } };
  });
  let bestTotal = scored[0].total;
  for (const s of scored) if (isBetterValue(s.total, bestTotal)) bestTotal = s.total;
  return scored.filter((s) => s.total.count === bestTotal.count && s.total.kingCount === bestTotal.kingCount).map((s) => s.move);
}

// The actual legal moves for whichever side is to move — {from, to,
// captured?} entries, already filtered down to captures-only if any single
// one of the side's pieces has a capture available, and further narrowed by
// the majority-capture rule (see this file's own ruleset note above) when
// more than one piece/sequence is available. Grouped by "from" isn't needed
// by callers; the UI (game.js) just filters this list down to whichever
// `from` the player has selected.
//
// `forcedFromSquare` is passed only while continuing an already-started
// multi-jump chain (see game.js's own midChain state) — mid-chain, a hard
// pre-existing rule already forces the SAME piece to keep capturing, so the
// cross-piece comparison below must be skipped entirely rather than
// re-run against the current (mid-turn) board: some other, unrelated
// piece's own opportunity could otherwise silently override the forced
// continuation. Passing it narrows the tie-break down to that one piece's
// own remaining fork, as if it were the only capturing piece on the board.
export function getAllLegalMoves(board, side, forcedFromSquare) {
  if (forcedFromSquare) {
    return mandatoryMovesForPiece(board, forcedFromSquare.row, forcedFromSquare.col);
  }
  const simpleMoves = [];
  const capturingSquares = [];
  for (let row = 0; row < DAMA_SIZE; row++) {
    for (let col = 0; col < DAMA_SIZE; col++) {
      const piece = board[row][col];
      if (!piece || piece.side !== side) continue;
      if (capturesForPiece(board, row, col).length > 0) {
        capturingSquares.push({ row, col });
      }
      for (const move of simpleMovesForPiece(board, row, col)) {
        simpleMoves.push({ from: { row, col }, to: move.to });
      }
    }
  }
  if (capturingSquares.length === 0) return simpleMoves;
  const bestByPiece = capturingSquares.map((sq) => ({ sq, value: bestCaptureValue(board, sq.row, sq.col) }));
  let globalBest = bestByPiece[0].value;
  for (const { value } of bestByPiece) if (isBetterValue(value, globalBest)) globalBest = value;
  const captureMoves = [];
  for (const { sq, value } of bestByPiece) {
    if (value.count === globalBest.count && value.kingCount === globalBest.kingCount) {
      captureMoves.push(...mandatoryMovesForPiece(board, sq.row, sq.col));
    }
  }
  return captureMoves;
}

// Applies one already-legal move (as returned by getAllLegalMoves) to a
// *copy* of the board. Returns the new board plus, if this move was a
// capture that leaves the same piece with a further capture available,
// `continuedCaptureFrom` — the caller (game.js) must keep the same piece
// selected and the same player's turn in that case, instead of passing the
// turn to the other side.
//
// Promotion only happens on whichever hop turns out to be the LAST one of
// the whole turn — a man that merely lands ON the back rank mid-chain,
// with a further capture still forced from there, does NOT promote; it
// keeps moving/capturing as a plain man (short hops only, not a flying
// king) until its turn genuinely ends, and only promotes then if THAT
// final landing square happens to be the back rank. Landing on the back
// rank and immediately flying off it as a king in the same turn is
// explicitly not how this ruleset works — a real, deliberate rule, not an
// oversight. Checking "any further capture?" using the piece's own
// still-not-yet-promoted rank (below) is what makes that continuation
// check itself correctly use man rules rather than king ones while this
// is still in question.
export function applyDamaMove(board, move) {
  const next = board.map((r) => r.slice());
  const piece = next[move.from.row][move.from.col];
  next[move.from.row][move.from.col] = null;
  if (move.captured) next[move.captured.row][move.captured.col] = null;
  next[move.to.row][move.to.col] = { side: piece.side, king: piece.king };

  const hasMoreCaptures = !!move.captured && capturesForPiece(next, move.to.row, move.to.col).length > 0;
  let continuedCaptureFrom = null;
  let promoted = false;
  if (hasMoreCaptures) {
    continuedCaptureFrom = { row: move.to.row, col: move.to.col };
  } else if (!piece.king && isBackRow(piece.side, move.to.row)) {
    promoted = true;
    next[move.to.row][move.to.col] = { side: piece.side, king: true };
  }
  return { board: next, continuedCaptureFrom, promoted };
}

// True once the side-to-move has no legal move at all — win condition for
// the *other* side (either every piece was captured, or what's left is
// fully blocked).
export function hasNoLegalMoves(board, side) {
  return getAllLegalMoves(board, side).length === 0;
}
