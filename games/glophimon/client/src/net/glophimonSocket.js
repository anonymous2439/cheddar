// Direct WebSocket connection to Glophimon's own backend — same
// architecture decision as GL Sims World's net/worldSocket.js (itself
// following Luba's own net/lubaSocket.js): continuous position broadcasts
// are exactly the "many messages a second, not occasional" case the
// extension's send()/game.action HTTP relay was never built for.
// window.CheddarHost still brokers the access token via getAccessToken()
// and window.CheddarGlophimonWsBaseUrl is baked into the page by
// extension.ts from the user's own vscode settings. No racer/skin choice
// to pass here (unlike GL Sims World) — the server identifies the caller
// entirely from the token and looks up their own persistent character.
export const NETWORK_TICK_MS = 100; // casual walking, matches GL Sims World's own cadence

export function connectGlophimonSocket(onMessage) {
  let ws = null;
  let closed = false;

  async function connect() {
    const wsBase = window.CheddarGlophimonWsBaseUrl;
    if (!wsBase) {
      onMessage({ type: "_error", message: "Glophimon backend URL not configured" });
      return;
    }
    const token = await window.CheddarHost.getAccessToken();
    if (closed) return; // unmounted while awaiting the token
    const url = `${wsBase}/ws?token=${encodeURIComponent(token || "")}`;
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
    ws.addEventListener("close", (event) => {
      if (closed) return;
      // A rejection (no_character/already_in_world/unauthorized) arrives as
      // a real 'rejected' message *before* this fires (see main.py's
      // _reject — closing before accept() surfaces to the browser as a
      // bare handshake failure with no code/reason at all), so this
      // handler only needs to cover an unexpected drop after a successful
      // join.
      onMessage({ type: "_disconnected", code: event.code });
    });
    ws.addEventListener("error", () => {
      // Quiet on purpose, matching cheddarSocket's/worldSocket's own error
      // handling — the close event above (or an explicit 'rejected'
      // message) is what actually drives UI state.
    });
  }
  connect();

  return {
    sendPosition(x, z, facing) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "position", x, z, facing }));
      }
    },
    sendChat(text) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "chat", text }));
      }
    },
    // The Luba lobby system (see game.js's own Boss Rick/lobby modal) —
    // same fire-and-forget shape as sendPosition/sendChat above, the
    // server-side handler (main.py's own _handle_luba_message) answers
    // with a luba_lobby_state/luba_error/luba_lobby_closed message rather
    // than a direct reply to any one of these.
    sendLubaHostRequest(mode, durationS) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "luba_host_request", mode, duration_s: durationS }));
      }
    },
    sendLubaInvite(targetUserId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "luba_invite", target_user_id: targetUserId }));
      }
    },
    sendLubaRespond(lobbyId, accept) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "luba_respond", lobby_id: lobbyId, accept }));
      }
    },
    sendLubaReady(ready) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "luba_ready", ready }));
      }
    },
    sendLubaLeave() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "luba_leave" }));
      }
    },
    sendLubaKick(targetUserId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "luba_kick", target_user_id: targetUserId }));
      }
    },
    sendLubaStart() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "luba_start" }));
      }
    },
    // Player-to-player PVP invites — same fire-and-forget shape as the
    // Luba lobby's own send methods above.
    sendPvpInvite(targetUserId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pvp_invite", target_user_id: targetUserId }));
      }
    },
    sendPvpRespond(inviteId, accept) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pvp_respond", invite_id: inviteId, accept }));
      }
    },
    sendPvpCancel(inviteId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pvp_cancel", invite_id: inviteId }));
      }
    },
    // Stage 2 — the real battle. moveKey is either a real move key or the
    // "defend" sentinel; the server holds each side's choice privately
    // until both are in (see main.py's own pvp_move_choice handler).
    sendPvpMoveChoice(matchId, moveKey) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pvp_move_choice", match_id: matchId, move_key: moveKey }));
      }
    },
    sendPvpForfeit(matchId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pvp_forfeit", match_id: matchId }));
      }
    },
    // Chessdom — same fire-and-forget shape as every send method above.
    // move is a UCI string (e.g. "e2e4", or "e7e8q" for a promotion).
    sendChessHostRequest(boardId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "chess_host_request", board_id: boardId }));
      }
    },
    sendChessCancelHost(boardId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "chess_cancel_host", board_id: boardId }));
      }
    },
    sendChessJoinRequest(boardId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "chess_join_request", board_id: boardId }));
      }
    },
    sendChessMove(boardId, move) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "chess_move", board_id: boardId, move }));
      }
    },
    sendChessResign(boardId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "chess_resign", board_id: boardId }));
      }
    },
    dispose() {
      closed = true;
      ws?.close();
    },
  };
}
