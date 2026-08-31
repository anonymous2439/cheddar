from datetime import datetime
from typing import Literal

from pydantic import BaseModel

# "random" is resolved server-side (a coin flip) — never sent back to any
# client as a real seat assignment, only ever used as an input value here.
ChessColorChoice = Literal["white", "black", "random"]


class ChessStateOut(BaseModel):
    lobby_id: int
    fen: str
    moves: list[str]
    # Same moves as `moves`, in standard algebraic notation (e.g. "Nf3",
    # "O-O") — for display (vscode's move-history panel, in particular),
    # since UCI ("g1f3") isn't how a player types or reads a move.
    moves_san: list[str]
    turn: str
    white_user_id: int
    black_user_id: int
    status: str
    winner_user_id: int | None
    is_check: bool
    # None for a human-vs-human game — set when black is the Stockfish bot,
    # so the client can show "vs AI (skill N)" and knows not to expect a
    # real person to ever show as "typing" on that side.
    ai_skill_level: int | None
    created_at: datetime
    updated_at: datetime


class ChessMoveIn(BaseModel):
    # Either UCI ("e2e4", used by the web app's drag-and-drop board, which
    # already knows source/target squares) or standard algebraic notation
    # ("Nf3", used by vscode's typed-move input) — see chess.py's
    # _parse_move_text, which tries SAN first and falls back to UCI.
    move: str


class ChessVsAiIn(BaseModel):
    # Stockfish's own "Skill Level" UCI option, 0 (weakest) - 20 (strongest,
    # full-strength engine play).
    skill_level: int = 10
    # Which side the human wants to play — the bot always takes whichever
    # side is left. Previously always "white" for the human; now a choice.
    preferred_color: ChessColorChoice = "random"


class ChessColorPreferenceIn(BaseModel):
    # The lobby leader's choice for a human-vs-human game, set before the
    # generic lobby /start call — see chess.py's _pending_color_choice for
    # why this is a separate call rather than a param on /start itself.
    preferred_color: ChessColorChoice = "random"
