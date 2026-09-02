// Direct WebSocket connection to Luba's own backend (games/luba/api) —
// same architecture as the vscode client's net/lubaSocket.js: this is a
// separate service from the main Cheddar API, so it gets its own
// persistent connection rather than being routed through anything else.
// Unlike the vscode webview (which has to ask the extension host for the
// access token via a message-passing bridge, since the token is private
// to extension.ts), the web app already has direct synchronous access to
// it via getStoredAuth() — no round trip needed here.
import { getStoredAuth } from "../../../api/client";

const LUBA_API_BASE_URL = import.meta.env.VITE_LUBA_API_BASE_URL as string;

// ~30/sec — bumped from the original ~15/sec (66ms) after playtesting
// found hits sometimes not registering, especially against a moving
// target: the server's known position for the *target* is only as fresh
// as their own last position tick, so a slower tick left more room for a
// running target to have moved meaningfully since their last update by
// the time an attacker's swing was checked against it. See also
// sendAttackSample below, a second, denser channel specifically for the
// brief active-swing window itself.
export const NETWORK_TICK_MS = 33;

export interface RosterPlayer {
  userId: number;
  x: number;
  y: number;
  z: number;
  facing: number;
  alive: boolean;
  kills: number;
}

export type LubaServerMessage =
  | { type: "roster"; selfId: number; selfX: number; selfY: number; selfZ: number; matchEndsInMs: number; players: RosterPlayer[] }
  | { type: "joined"; userId: number; x: number; y: number; z: number }
  | { type: "left"; userId: number }
  | { type: "peer_position"; userId: number; x: number; y: number; z: number; facing: number; isActiveSwing: boolean }
  | { type: "death"; userId: number; cause: "hit" | "fall"; attackerId: number | null; attackerKills?: number }
  | { type: "respawn"; userId: number; x: number; y: number; z: number; invulnerableMs: number }
  | { type: "parry"; player1Id: number; player2Id: number }
  | { type: "match_over"; winnerId: number | null; winnerKills: number; isTie: boolean }
  | { type: "smoke"; userId: number; x: number; y: number; z: number; durationMs: number }
  | { type: "_disconnected" }
  | { type: "_error"; message: string };

export interface LubaSocketHandle {
  sendPosition(x: number, y: number, z: number, facing: number, isActiveSwing: boolean, bladePoints: { x: number; y: number; z: number }[] | null): void;
  sendAttackStart(): void;
  sendAttackSample(bladePoints: { x: number; y: number; z: number }[]): void;
  sendFell(): void;
  sendSmokeStart(): void;
  dispose(): void;
}

function wsUrl(lobbyId: number, token: string): string {
  const wsBase = LUBA_API_BASE_URL.startsWith("http")
    ? LUBA_API_BASE_URL.replace(/^http/, "ws")
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${LUBA_API_BASE_URL}`;
  return `${wsBase}/ws?lobby_id=${encodeURIComponent(lobbyId)}&token=${encodeURIComponent(token)}`;
}

export function connectLubaSocket(lobbyId: number, onMessage: (msg: LubaServerMessage) => void): LubaSocketHandle {
  let ws: WebSocket | null = null;
  let closed = false;

  function connect() {
    if (!LUBA_API_BASE_URL) {
      onMessage({ type: "_error", message: "Luba backend URL not configured" });
      return;
    }
    const auth = getStoredAuth();
    ws = new WebSocket(wsUrl(lobbyId, auth?.access_token ?? ""));
    ws.addEventListener("message", (event) => {
      let msg: LubaServerMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      onMessage(msg);
    });
    ws.addEventListener("close", () => {
      if (!closed) onMessage({ type: "_disconnected" });
    });
    ws.addEventListener("error", () => {
      onMessage({ type: "_error", message: "Connection error" });
    });
  }
  connect();

  function send(payload: Record<string, unknown>) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  return {
    sendPosition(x, y, z, facing, isActiveSwing, bladePoints) {
      send({ type: "position", x, y, z, facing, isActiveSwing, bladePoints: bladePoints ?? null });
    },
    sendAttackStart() {
      send({ type: "attack_start" });
    },
    // Sent every render frame while the swing is actively cutting (not
    // gated to NETWORK_TICK_MS) — a ~200ms active window sampled only at
    // the regular position-tick rate could miss a real continuous blade
    // sweep entirely between two ticks; this closes that gap without
    // needing to speed up the (larger, more frequent) general position
    // broadcast to everyone else in the room.
    sendAttackSample(bladePoints) {
      send({ type: "attack_sample", bladePoints });
    },
    sendFell() {
      send({ type: "fell" });
    },
    sendSmokeStart() {
      send({ type: "smoke_start" });
    },
    dispose() {
      closed = true;
      if (ws) ws.close();
    },
  };
}
