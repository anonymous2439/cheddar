"""Stockfish integration for Tambayan's own vs-AI board — same technique as
the main Cheddar API's own Chess "vs AI" mode (api/app/core/chess_ai.py),
duplicated rather than imported since this is a separate deployable service
with its own venv (see this game's own plan file for why Tambayan's chess
doesn't call into the real Chess backend at all). Requires the `stockfish`
binary on PATH (Debian/Ubuntu: `apt install stockfish`, which installs it to
/usr/games/stockfish).
"""

import shutil

import chess
import chess.engine

_STOCKFISH_PATH = shutil.which("stockfish") or "/usr/games/stockfish"
# Fixed think time rather than a search depth — keeps response latency
# predictable regardless of skill level (a low-skill engine "thinking" for
# 0.5s still just plays worse moves, it doesn't finish faster).
_THINK_TIME_SECONDS = 0.5


def compute_ai_move(board: chess.Board, skill_level: int) -> chess.Move:
    """Blocking — spawns Stockfish as a subprocess and waits for it to
    think. Call via starlette's run_in_threadpool so this doesn't stall the
    event loop (and every other connection's messages) while it runs."""
    with chess.engine.SimpleEngine.popen_uci(_STOCKFISH_PATH) as engine:
        engine.configure({"Skill Level": max(0, min(20, skill_level))})
        result = engine.play(board, chess.engine.Limit(time=_THINK_TIME_SECONDS))
        if result.move is None:
            raise RuntimeError("Stockfish returned no move")
        return result.move
