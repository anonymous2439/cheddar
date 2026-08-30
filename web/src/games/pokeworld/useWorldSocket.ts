import { useEffect, useRef } from "react";
import { pokeWorldWsUrl } from "../../api/pokeworld";

export interface WorldPlayerPosition {
  userId: number;
  mapId: number;
  x: number;
  y: number;
  facing: string;
}

export interface WorldSocketHandle {
  sendPosition(pos: { mapId: number; x: number; y: number; facing: string }): void;
  // Live map of other players' last-known positions, keyed by user_id — a
  // plain ref, not React state: the overlay's own draw call reads this
  // every tick already (see PokeWorldGame.tsx), so wrapping it in state
  // would just force a re-render on every single incoming WS message for
  // no benefit.
  otherPlayers: Map<number, WorldPlayerPosition>;
}

// One always-on connection for the whole session (not per-map, not
// per-lobby — see games/pokeworld/api/app/main.py's WorldConnectionManager,
// which is keyed by map internally instead). Connects once on mount and
// stays open for as long as the World tab is mounted; no reconnect-on-drop
// logic yet, matching every other game socket in this codebase (karirs'
// race_ws included) — a real gap worth revisiting if it turns out to
// matter in practice, not something to build preemptively for a first
// slice.
export function useWorldSocket(): WorldSocketHandle {
  const socketRef = useRef<WebSocket | null>(null);
  const otherPlayersRef = useRef<Map<number, WorldPlayerPosition>>(new Map());

  useEffect(() => {
    const ws = new WebSocket(pokeWorldWsUrl());
    socketRef.current = ws;

    ws.onmessage = (event) => {
      let msg: { type: string; user_id?: number; map_id?: number; x?: number; y?: number; facing?: string };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "pos" && msg.user_id !== undefined) {
        otherPlayersRef.current.set(msg.user_id, {
          userId: msg.user_id,
          mapId: msg.map_id ?? 0,
          x: msg.x ?? 0,
          y: msg.y ?? 0,
          facing: msg.facing ?? "down",
        });
      } else if (msg.type === "leave" && msg.user_id !== undefined) {
        otherPlayersRef.current.delete(msg.user_id);
      }
    };

    return () => {
      ws.close();
      socketRef.current = null;
    };
  }, []);

  function sendPosition(pos: { mapId: number; x: number; y: number; facing: string }) {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "pos", map_id: pos.mapId, x: pos.x, y: pos.y, facing: pos.facing }));
  }

  return { sendPosition, otherPlayers: otherPlayersRef.current };
}
