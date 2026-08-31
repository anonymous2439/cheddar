import { api } from "./client";
import type { ChessState, Lobby } from "../types";

export type ChessColorChoice = "white" | "black" | "random";

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

export function playChessVsAi(lobbyId: number, skillLevel: number, preferredColor: ChessColorChoice) {
  // Returns the updated Lobby (not ChessState) — same shape as the generic
  // /start endpoint, so callers can applyLobby() it directly. ChessGame
  // fetches the actual board itself on mount, same as any other game.
  return api
    .post<Lobby>(`/chess/${lobbyId}/vs-ai`, { skill_level: skillLevel, preferred_color: preferredColor })
    .then((r) => r.data);
}

export function setChessColorPreference(lobbyId: number, preferredColor: ChessColorChoice) {
  // Must be called *before* the generic lobby /start (see
  // useGames.ts/LobbyRoom.tsx) — the human-vs-human ChessGame row can be
  // created by whichever player's client fetches /state first once the
  // lobby goes live, so the preference has to already be stored before
  // that race can happen at all. See chess.py's _pending_color_choice.
  return api.post(`/chess/${lobbyId}/color-preference`, { preferred_color: preferredColor });
}
