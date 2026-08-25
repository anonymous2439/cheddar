import { api } from "./client";
import type { ChessState } from "../types";

export function getChessState(lobbyId: number) {
  return api.get<ChessState>(`/chess/${lobbyId}/state`).then((r) => r.data);
}

export function makeChessMove(lobbyId: number, uci: string) {
  // The endpoint's `move` field accepts either UCI or SAN (see chess.py's
  // _parse_move_text) — the web board always sends UCI since react-chessboard
  // already gives it exact source/target squares.
  return api.post<ChessState>(`/chess/${lobbyId}/move`, { move: uci }).then((r) => r.data);
}

export function resignChess(lobbyId: number) {
  return api.post<ChessState>(`/chess/${lobbyId}/resign`).then((r) => r.data);
}
