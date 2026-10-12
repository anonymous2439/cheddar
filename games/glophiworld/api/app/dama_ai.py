"""Dama (Phase 3) — there's no existing draughts engine installed on this
box the way Stockfish already was for Chess (and no off-the-shelf one would
match this specific ruleset — backward captures for men, flying kings —
without a lot of adaptation anyway), so this is a small hand-written
minimax/alpha-beta search instead, over a straight Python port of the
client's own already-tested rules engine (games/glophimon/client/src/
dama.js — see that file for the ruleset notes; kept in sync with it by
hand, same as every other "the two sides can't literally share code"
pair in this project).

Board shape: an 8x8 list of rows, each cell either None or
{"side": "white"|"black", "king": bool} — the exact shape the client sends/
receives already (see main.py's own DamaBoardState).
"""

import time

DAMA_SIZE = 8
DIAGONALS = ((-1, -1), (-1, 1), (1, -1), (1, 1))


def create_initial_dama_board() -> list[list[dict | None]]:
    board: list[list[dict | None]] = [[None] * DAMA_SIZE for _ in range(DAMA_SIZE)]
    for row in range(DAMA_SIZE):
        for col in range(DAMA_SIZE):
            if (row + col) % 2 != 1:
                continue
            if row <= 2:
                board[row][col] = {"side": "black", "king": False}
            elif row >= 5:
                board[row][col] = {"side": "white", "king": False}
    return board


def _in_bounds(row: int, col: int) -> bool:
    return 0 <= row < DAMA_SIZE and 0 <= col < DAMA_SIZE


def _forward_dir(side: str) -> int:
    return 1 if side == "black" else -1


def _is_back_row(side: str, row: int) -> bool:
    return row == DAMA_SIZE - 1 if side == "black" else row == 0


def _man_captures(board, row, col, side):
    moves = []
    for dr, dc in DIAGONALS:
        mid_row, mid_col = row + dr, col + dc
        to_row, to_col = row + dr * 2, col + dc * 2
        if not _in_bounds(to_row, to_col):
            continue
        mid = board[mid_row][mid_col]
        if mid is not None and mid["side"] != side and board[to_row][to_col] is None:
            moves.append({"to": (to_row, to_col), "captured": (mid_row, mid_col)})
    return moves


def _man_simple_moves(board, row, col, side):
    moves = []
    dr = _forward_dir(side)
    for dc in (-1, 1):
        to_row, to_col = row + dr, col + dc
        if _in_bounds(to_row, to_col) and board[to_row][to_col] is None:
            moves.append({"to": (to_row, to_col)})
    return moves


def _king_captures(board, row, col, side):
    moves = []
    for dr, dc in DIAGONALS:
        r, c = row + dr, col + dc
        while _in_bounds(r, c) and board[r][c] is None:
            r += dr
            c += dc
        if not _in_bounds(r, c) or board[r][c]["side"] == side:
            continue
        captured_row, captured_col = r, c
        r += dr
        c += dc
        while _in_bounds(r, c) and board[r][c] is None:
            moves.append({"to": (r, c), "captured": (captured_row, captured_col)})
            r += dr
            c += dc
    return moves


def _king_simple_moves(board, row, col):
    moves = []
    for dr, dc in DIAGONALS:
        r, c = row + dr, col + dc
        while _in_bounds(r, c) and board[r][c] is None:
            moves.append({"to": (r, c)})
            r += dr
            c += dc
    return moves


def _captures_for_piece(board, row, col):
    piece = board[row][col]
    if piece is None:
        return []
    return _king_captures(board, row, col, piece["side"]) if piece["king"] else _man_captures(board, row, col, piece["side"])


def _simple_moves_for_piece(board, row, col):
    piece = board[row][col]
    if piece is None:
        return []
    return _king_simple_moves(board, row, col) if piece["king"] else _man_simple_moves(board, row, col, piece["side"])


# Recursively computes the best (count, king_count) achievable by a single
# piece's own capture chain starting/continuing from (row, col) — the core
# of the majority-capture rule (see get_all_legal_moves below). Compared
# lexicographically via plain tuple ordering: count first (quantity always
# outranks rank), king_count only as a tie-break — a straight port of
# dama.js's own bestCaptureValue, kept in sync with it by hand like every
# other client/server pair in this project.
def _best_capture_value(board, row, col) -> tuple[int, int]:
    moves = _captures_for_piece(board, row, col)
    if not moves:
        return (0, 0)
    best = (-1, -1)
    for m in moves:
        move = {"from": (row, col), "to": m["to"], "captured": m["captured"]}
        captured_row, captured_col = m["captured"]
        captured_was_king = board[captured_row][captured_col]["king"]
        next_board, continued_from = apply_dama_move(board, move)
        rest = _best_capture_value(next_board, *continued_from) if continued_from is not None else (0, 0)
        total = (1 + rest[0], (1 if captured_was_king else 0) + rest[1])
        if total > best:
            best = total
    return best


# Among one piece's own immediate capture options (a fork mid-chain, or its
# very first hop), keep only whichever achieve that piece's own best (count,
# king_count) per _best_capture_value above — this piece's own slice of the
# majority-capture rule, with no comparison against any other piece (see
# get_full_moves's own recursion for why that separation matters: mid-chain,
# only this same piece may ever move next regardless of what any other
# piece on the board could do).
def _mandatory_moves_for_piece(board, row, col) -> list[dict]:
    moves = _captures_for_piece(board, row, col)
    if not moves:
        return []
    scored = []
    for m in moves:
        move = {"from": (row, col), "to": m["to"], "captured": m["captured"]}
        captured_row, captured_col = m["captured"]
        captured_was_king = board[captured_row][captured_col]["king"]
        next_board, continued_from = apply_dama_move(board, move)
        rest = _best_capture_value(next_board, *continued_from) if continued_from is not None else (0, 0)
        total = (1 + rest[0], (1 if captured_was_king else 0) + rest[1])
        scored.append((move, total))
    best_total = max(total for _, total in scored)
    return [move for move, total in scored if total == best_total]


# Filipino Dama's own "majority capture" rule, on top of the plainer
# "captures are mandatory over simple moves" already enforced below: the
# specific capture sequence taken is further constrained to whichever
# piece/sequence(s) capture the *most* pieces this turn (across every piece
# and every fork in a multi-jump chain, not just the first hop), and only as
# a tie-break at equal count, whichever captures a king (a "dama") over a
# man — quantity always outranks rank. Ties equal on both counts still
# leave a free choice. A straight port of dama.js's own getAllLegalMoves.
def get_all_legal_moves(board, side):
    simple_moves = []
    capturing_squares = []
    for row in range(DAMA_SIZE):
        for col in range(DAMA_SIZE):
            piece = board[row][col]
            if piece is None or piece["side"] != side:
                continue
            if _captures_for_piece(board, row, col):
                capturing_squares.append((row, col))
            for move in _simple_moves_for_piece(board, row, col):
                simple_moves.append({"from": (row, col), "to": move["to"], "captured": None})
    if not capturing_squares:
        return simple_moves
    best_by_piece = {pos: _best_capture_value(board, *pos) for pos in capturing_squares}
    global_best = max(best_by_piece.values())
    capture_moves = []
    for pos in capturing_squares:
        if best_by_piece[pos] == global_best:
            capture_moves.extend(_mandatory_moves_for_piece(board, *pos))
    return capture_moves


# Promotion only happens on whichever hop turns out to be the LAST one of
# the whole turn — a man that merely lands ON the back rank mid-chain, with
# a further capture still forced from there, does NOT promote; it keeps
# moving/capturing as a plain man (short hops only, not a flying king)
# until its turn genuinely ends, and only promotes then if THAT final
# landing square happens to be the back rank. A straight port of dama.js's
# own applyDamaMove — see that file's own comment for the full reasoning;
# checking "any further capture?" using the piece's own still-not-yet-
# promoted rank (below) is what makes that continuation check itself
# correctly use man rules rather than king ones while this is still in
# question.
def apply_dama_move(board, move):
    next_board = [r[:] for r in board]
    from_row, from_col = move["from"]
    to_row, to_col = move["to"]
    piece = next_board[from_row][from_col]
    next_board[from_row][from_col] = None
    if move.get("captured"):
        cap_row, cap_col = move["captured"]
        next_board[cap_row][cap_col] = None
    next_board[to_row][to_col] = {"side": piece["side"], "king": piece["king"]}

    has_more_captures = bool(move.get("captured")) and bool(_captures_for_piece(next_board, to_row, to_col))
    continued_capture_from = None
    if has_more_captures:
        continued_capture_from = (to_row, to_col)
    elif not piece["king"] and _is_back_row(piece["side"], to_row):
        next_board[to_row][to_col] = {"side": piece["side"], "king": True}
    return next_board, continued_capture_from


def has_no_legal_moves(board, side) -> bool:
    return len(get_all_legal_moves(board, side)) == 0


# One entry in the returned list is one *complete turn* — a list of hops
# (length 1 for a simple move or a single capture, longer for a forced
# multi-jump chain) plus the board once every hop in it has been applied.
# Needed because the search has to pick the best whole turn, not just the
# best first hop — a chain can genuinely branch partway through (more than
# one continuation capture available from the same piece).
def get_full_moves(board, side):
    initial_moves = get_all_legal_moves(board, side)
    if not initial_moves:
        return []
    results: list[tuple[list[dict], list]] = []

    def recurse(current_board, hops, from_square):
        # _mandatory_moves_for_piece, not get_all_legal_moves — mid-chain,
        # only this same piece may ever continue (a hard pre-existing rule),
        # so re-running get_all_legal_moves's own cross-piece comparison
        # here against the current (mid-turn) board could let some other,
        # unrelated piece's opportunity silently override the forced
        # continuation. See that function's own comment for the full
        # reasoning (ported from dama.js's own forcedFromSquare).
        continuations = _mandatory_moves_for_piece(current_board, *from_square)
        if not continuations:
            results.append((hops, current_board))
            return
        for m in continuations:
            new_board, continued_from = apply_dama_move(current_board, m)
            new_hops = hops + [m]
            if continued_from is not None:
                recurse(new_board, new_hops, continued_from)
            else:
                results.append((new_hops, new_board))

    for m in initial_moves:
        new_board, continued_from = apply_dama_move(board, m)
        if continued_from is not None:
            recurse(new_board, [m], continued_from)
        else:
            results.append(([m], new_board))
    return results


def _other_side(side: str) -> str:
    return "black" if side == "white" else "white"


# Kings worth more than men (a real, if simple, edge over a flat piece
# count), plus a small centralization nudge for men so the search doesn't
# treat every non-capturing man move as equally indifferent — without any
# positional term at all, the fixed-depth search plays a materially weaker,
# more randomly-drifting midgame.
_MAN_VALUE = 1.0
_KING_VALUE = 1.6


def _evaluate(board, perspective: str) -> float:
    score = 0.0
    for row in range(DAMA_SIZE):
        for col in range(DAMA_SIZE):
            piece = board[row][col]
            if piece is None:
                continue
            value = _KING_VALUE if piece["king"] else _MAN_VALUE
            if not piece["king"]:
                # Advancement bonus for men only (kings already reached the
                # far row) — row 0..7, closer to promotion is worth a
                # little more, mirrored per side since they advance in
                # opposite directions.
                advancement = row if piece["side"] == "black" else (DAMA_SIZE - 1 - row)
                value += advancement * 0.03
            score += value if piece["side"] == perspective else -value
    return score


_WIN_SCORE = 1000.0


def _minimax(board, side, depth, alpha, beta, maximizing_side, deadline):
    moves = get_full_moves(board, side)
    if not moves:
        # side-to-move is stuck — a real win/loss, not just a heuristic
        # score, so it always dominates the search regardless of depth.
        return (-_WIN_SCORE if side == maximizing_side else _WIN_SCORE), None
    if depth == 0 or time.monotonic() >= deadline:
        return _evaluate(board, maximizing_side), None

    best_hops = None
    if side == maximizing_side:
        best_score = -float("inf")
        for hops, result_board in moves:
            score, _ = _minimax(result_board, _other_side(side), depth - 1, alpha, beta, maximizing_side, deadline)
            if score > best_score:
                best_score, best_hops = score, hops
            alpha = max(alpha, best_score)
            if alpha >= beta or time.monotonic() >= deadline:
                break
        return best_score, best_hops
    else:
        best_score = float("inf")
        for hops, result_board in moves:
            score, _ = _minimax(result_board, _other_side(side), depth - 1, alpha, beta, maximizing_side, deadline)
            if score < best_score:
                best_score, best_hops = score, hops
            beta = min(beta, best_score)
            if alpha >= beta or time.monotonic() >= deadline:
                break
        return best_score, best_hops


# Iterative deepening within a fixed think-time budget (same shape as the
# Chess AI's own fixed think time, see chess_ai.py) rather than a fixed
# depth — keeps response latency predictable and lets the search bank
# whatever depth it can actually finish, instead of guessing one depth that
# might be too slow on a busy server tick or too shallow on a quiet one.
_THINK_TIME_SECONDS = 1.0
_MAX_DEPTH = 8


def compute_ai_move(board, side: str) -> list[dict]:
    """Blocking — call via starlette's run_in_threadpool, same reasoning as
    the Chess AI's own compute_ai_move. Returns the full list of hops
    making up the AI's turn (length >1 for a forced multi-jump chain)."""
    deadline = time.monotonic() + _THINK_TIME_SECONDS
    best_hops = None
    depth = 1
    while depth <= _MAX_DEPTH and time.monotonic() < deadline:
        score, hops = _minimax(board, side, depth, -float("inf"), float("inf"), side, deadline)
        if hops is not None:
            best_hops = hops
        if abs(score) >= _WIN_SCORE:
            break  # found a forced win/loss line — no deeper search can change that
        depth += 1
    if best_hops is None:
        # Time ran out before depth 1 even finished (shouldn't happen at
        # _THINK_TIME_SECONDS=1.0, but fall back to any legal full move
        # rather than crash) — same "just don't return nothing" spirit as
        # this being the only place a caller ever needs a fallback.
        moves = get_full_moves(board, side)
        best_hops = moves[0][0] if moves else []
    return best_hops
