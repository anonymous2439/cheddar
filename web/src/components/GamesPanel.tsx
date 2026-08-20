import { useState } from "react";
import type { GameCatalogEntry, Lobby } from "../types";

interface Props {
  catalog: GameCatalogEntry[];
  myLobbies: Lobby[];
  selectedLobbyId: number | null;
  onHost: (gameKey: string) => void;
  onSelect: (lobby: Lobby) => void;
  onJoinByCode: (code: string) => Promise<unknown>;
}

export function GamesPanel({ catalog, myLobbies, selectedLobbyId, onHost, onSelect, onJoinByCode }: Props) {
  const [code, setCode] = useState("");
  const [joinError, setJoinError] = useState("");

  async function handleJoin() {
    if (!code.trim()) return;
    try {
      await onJoinByCode(code.trim());
      setCode("");
      setJoinError("");
    } catch {
      setJoinError("Invalid or expired code");
    }
  }

  return (
    <div>
      <div className="border-b border-neutral-200 p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase text-neutral-500">Host a game</h3>
        {catalog.length === 0 ? (
          <p className="text-sm text-neutral-500">No games available.</p>
        ) : (
          <ul className="space-y-1">
            {catalog.map((g) => (
              <li key={g.key} className="flex items-center justify-between text-sm">
                <span>
                  {g.name} <span className="text-xs text-neutral-400">({g.min_players}-{g.max_players})</span>
                </span>
                <button
                  onClick={() => onHost(g.key)}
                  className="rounded bg-amber-500 px-2 py-1 text-xs text-white hover:bg-amber-600"
                >
                  Host
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleJoin()}
            placeholder="Have an invite code?"
            className="w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-xs"
          />
          <button onClick={handleJoin} className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50">
            Join
          </button>
        </div>
        {joinError && <p className="mt-1 text-xs text-red-600">{joinError}</p>}
      </div>

      <div className="p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase text-neutral-500">Your lobbies</h3>
        {myLobbies.length === 0 ? (
          <p className="text-sm text-neutral-500">No active lobbies yet.</p>
        ) : (
          <ul className="space-y-1">
            {myLobbies.map((lobby) => (
              <li key={lobby.id}>
                <button
                  onClick={() => onSelect(lobby)}
                  className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-50 ${
                    selectedLobbyId === lobby.id ? "bg-amber-50" : ""
                  }`}
                >
                  <span>{lobby.game_name}</span>
                  <span className="text-xs text-neutral-400">{lobby.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
