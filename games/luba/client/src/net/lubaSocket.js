// Direct WebSocket connection to Luba's own backend — bypassing the
// extension's send()/game.action relay entirely (see the plan's
// architecture decision: that relay is a fresh HTTP call per action,
// fine for occasional calls but never built for the many-times-a-second
// bidirectional traffic real-time position sync needs). window.CheddarHost
// still brokers the one sensitive value this needs (the access token,
// via getAccessToken() — a request/response bridge, not the fire-and-
// forget send()/onEvent() pair) and window.CheddarLubaWsBaseUrl is baked
// into the page by extension.ts from the user's own vscode settings.
// ~30/sec — bumped from the original ~15/sec (66ms) after playtesting
// found hits sometimes not registering, especially against a moving
// target: the server's known position for the *target* is only as fresh
// as their own last position tick, so a slower tick left more room for a
// running target to have moved meaningfully since their last update by
// the time an attacker's swing was checked against it. See also
// sendAttackSample below, a second, denser channel specifically for the
// brief active-swing window itself.
export const NETWORK_TICK_MS = 33;

export function connectLubaSocket(lobbyId, onMessage) {
  let ws = null;
  let closed = false;

  async function connect() {
    const wsBase = window.CheddarLubaWsBaseUrl;
    if (!wsBase) {
      onMessage({ type: "_error", message: "Luba backend URL not configured" });
      return;
    }
    const token = await window.CheddarHost.getAccessToken();
    if (closed) return; // unmounted while awaiting the token
    const url = `${wsBase}/ws?lobby_id=${encodeURIComponent(lobbyId)}&token=${encodeURIComponent(token || "")}`;
    ws = new WebSocket(url);
    ws.addEventListener("message", (event) => {
      let msg;
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

  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  return {
    // equippedWeapon/aimElevation/isDrawingBow — added for the bow: lets
    // every peer see the shooter actually holding/aiming/drawing it (see
    // main.py's own peer_position broadcast and game.js's own
    // peer_position handler), the same way isActiveSwing already lets
    // peers mirror a sword swing.
    sendPosition(x, y, z, facing, isActiveSwing, bladePoints, equippedWeapon, aimElevation, isDrawingBow) {
      send({
        type: "position",
        x,
        y,
        z,
        facing,
        isActiveSwing,
        bladePoints: bladePoints || null,
        equippedWeapon,
        aimElevation,
        isDrawingBow,
      });
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
    // Sent once, on release (not a tick-gated stream like position/attack
    // sampling) — the server assigns the arrow's real id and simulates its
    // whole flight itself (see main.py's own arrow tick loop), broadcasting
    // "arrow_spawned" back to every client including this one so the local
    // visual spawns from the same authoritative event everyone else sees,
    // same reasoning as the smoke skill's own no-optimistic-local-spawn
    // choice. speed is client-reported but clamped server-side to a sane
    // range — never trusted outright, same trust model as everything else
    // here that's client-authoritative-with-a-backstop.
    sendFireArrow(originX, originY, originZ, dirX, dirY, dirZ, speed) {
      send({ type: "fire_arrow", originX, originY, originZ, dirX, dirY, dirZ, speed });
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
