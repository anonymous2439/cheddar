// Purely a client-side cosmetic preference — not synced to the backend or
// the other player at all (each player can pick their own board look
// independently, same as lichess/chess.com), unlike the chess color
// choice feature (a real gameplay setting, server-assigned). Persisted in
// localStorage following the one existing convention for that in this
// codebase (see api/client.ts's "cheddar.auth" key) rather than a new
// storage mechanism.
export interface ChessBoardTheme {
  id: string;
  label: string;
  // Omitted entirely for "classic" — react-chessboard's own defaults, so
  // "current look stays the default" just means passing nothing here.
  lightSquareStyle?: { backgroundColor: string };
  darkSquareStyle?: { backgroundColor: string };
}

export const CHESS_BOARD_THEMES: ChessBoardTheme[] = [
  { id: "classic", label: "Classic" },
  { id: "green", label: "Green", lightSquareStyle: { backgroundColor: "#eeeed2" }, darkSquareStyle: { backgroundColor: "#769656" } },
  { id: "blue", label: "Blue", lightSquareStyle: { backgroundColor: "#dee3e6" }, darkSquareStyle: { backgroundColor: "#8ca2ad" } },
  { id: "wood", label: "Wood", lightSquareStyle: { backgroundColor: "#f0d9b5" }, darkSquareStyle: { backgroundColor: "#b58863" } },
  { id: "gray", label: "Gray", lightSquareStyle: { backgroundColor: "#e8e8e8" }, darkSquareStyle: { backgroundColor: "#8a8a8a" } },
];

const STORAGE_KEY = "cheddar.chess.boardTheme";

export function getStoredChessBoardTheme(): string {
  return localStorage.getItem(STORAGE_KEY) ?? CHESS_BOARD_THEMES[0].id;
}

export function setStoredChessBoardTheme(themeId: string): void {
  localStorage.setItem(STORAGE_KEY, themeId);
}
