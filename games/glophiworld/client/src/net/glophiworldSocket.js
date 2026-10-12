// Direct WebSocket connection to Glophiworld's own backend — same
// architecture decision as GL Sims World's net/worldSocket.js (itself
// following Luba's own net/lubaSocket.js): continuous position broadcasts
// are exactly the "many messages a second, not occasional" case the
// extension's send()/game.action HTTP relay was never built for.
// window.CheddarHost still brokers the access token via getAccessToken()
// and window.CheddarGlophiworldWsBaseUrl is baked into the page by
// extension.ts from the user's own vscode settings. No racer/skin choice
// to pass here (unlike GL Sims World) — the server identifies the caller
// entirely from the token and looks up their own persistent character.
export const NETWORK_TICK_MS = 100; // casual walking, matches GL Sims World's own cadence

export function connectGlophiworldSocket(onMessage) {
  let ws = null;
  let closed = false;

  async function connect() {
    const wsBase = window.CheddarGlophiworldWsBaseUrl;
    if (!wsBase) {
      onMessage({ type: "_error", message: "Glophiworld backend URL not configured" });
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
    // floor: which Glophics floor the player is currently on (0 = ground) —
    // see game.js's own local.currentFloor/GLOPHICS_FLOORS. Threaded
    // through unchanged to the server (main.py's own Connection.floor),
    // which relays it to every other connected client exactly like x/z/
    // facing already are, so peers can be hidden/rendered at the right
    // height on whichever floor they're actually standing on.
    sendPosition(x, z, facing, floor) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "position", x, z, facing, floor }));
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
    sendChessAiStart(boardId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "chess_ai_start", board_id: boardId }));
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
    // Draw offer / undo request — human-vs-human boards only (see the api's
    // own chess_draw_offer/chess_undo_request), same fire-and-forget shape
    // as every send method above.
    sendChessDrawOffer(boardId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "chess_draw_offer", board_id: boardId }));
      }
    },
    sendChessDrawRespond(boardId, accept) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "chess_draw_respond", board_id: boardId, accept: !!accept }));
      }
    },
    sendChessUndoRequest(boardId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "chess_undo_request", board_id: boardId }));
      }
    },
    sendChessUndoRespond(boardId, accept) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "chess_undo_respond", board_id: boardId, accept: !!accept }));
      }
    },
    // Dama (Phase 2) — shares tables 1/2 with Chess but is otherwise a
    // fully separate message set (see the api's own _handle_dama_message).
    // sendDamaMove's board is the *whole* resulting 8x8 grid, not a single
    // move notation — the server trusts the sending client's own dama.js
    // validation rather than re-deriving the move itself (see this
    // feature's own plan file for why).
    sendDamaHostRequest(boardId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "dama_host_request", board_id: boardId }));
      }
    },
    // Phase 3 — the standing AI table's Dama option (see the api's own
    // dama_ai_start), same fire-and-forget shape as sendChessAiStart.
    sendDamaAiStart(boardId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "dama_ai_start", board_id: boardId }));
      }
    },
    sendDamaCancelHost(boardId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "dama_cancel_host", board_id: boardId }));
      }
    },
    sendDamaJoinRequest(boardId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "dama_join_request", board_id: boardId }));
      }
    },
    // last_move: {from: {row,col}, to: {row,col}} — the WHOLE current turn's
    // own start/end squares so far (start stays fixed across a multi-jump
    // chain's own hops, see game.js's own activeDamaMatch.turnStartSquare),
    // used purely for the last-move highlight (see the api's own last_move
    // field) — never validated server-side, same trust level as `board`.
    sendDamaMove(boardId, board, { continued, outcome, lastMove }) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "dama_move", board_id: boardId, board, continued: !!continued, outcome: outcome || null, last_move: lastMove || null }));
      }
    },
    sendDamaResign(boardId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "dama_resign", board_id: boardId }));
      }
    },
    // Draw offer / undo request — same shape as Chess's own (see
    // sendChessDrawOffer etc.), human-vs-human boards only.
    sendDamaDrawOffer(boardId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "dama_draw_offer", board_id: boardId }));
      }
    },
    sendDamaDrawRespond(boardId, accept) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "dama_draw_respond", board_id: boardId, accept: !!accept }));
      }
    },
    sendDamaUndoRequest(boardId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "dama_undo_request", board_id: boardId }));
      }
    },
    sendDamaUndoRespond(boardId, accept) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "dama_undo_respond", board_id: boardId, accept: !!accept }));
      }
    },
    // Sent only by whichever client the server just told (via dama_state's
    // own undo_accept_pending_for) that its undo request was accepted — the
    // ONE client that still has the pre-move board in memory (see game.js's
    // own activeDamaMatch.lastTurnSnapshot). board/sideToMove is exactly
    // that snapshot, played back to the server the same way any other
    // dama_move's board already is.
    sendDamaUndoCommit(boardId, board, sideToMove) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "dama_undo_commit", board_id: boardId, board, side_to_move: sideToMove }));
      }
    },
    // Real-time wild combat (see this game's own plan file) — fully
    // server-validated/authoritative (ownership, range, cooldowns, the
    // shared HP pool itself), the opposite trust level Glophimon's own
    // turn-based wild battles used. slot is one of the 3 active-lineup
    // indices (see game.js's own getActiveLineup); summoning a different
    // one just swaps whichever companion was already out.
    sendCompanionSummon(slot) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "companion_summon", slot }));
      }
    },
    // Left-click on a wild while a companion is out — starts it moving
    // toward that wild to engage in melee.
    sendCompanionTarget(wildId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "companion_target", wild_id: wildId }));
      }
    },
    // The '1' key — the companion's basic melee attack, only meaningful
    // once it's actually in range (state "engaged"); the server itself
    // resolves it against whatever wild that companion currently has
    // targeted and is cooldown-gated server-side.
    sendCompanionAttack() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "companion_attack" }));
      }
    },
    // Right-click on a wild — a real-time capture attempt, same cost/chance
    // formula Glophimon's own turn-based catch button used, just resolved
    // instantly server-side against the wild's live shared HP.
    sendWildCaptureAttempt(wildId) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "wild_capture_attempt", wild_id: wildId }));
      }
    },
    // Floor 2 cinema's shared projectionist role — same fire-and-forget
    // shape as every send method above, server-validated (see main.py's
    // own _handle_cinema_message: re-checks the role is actually vacant/
    // actually held by this caller rather than trusting whatever the
    // client's own Usher popup currently shows) and answered via a
    // cinema_projectionist_state/cinema_screen_state/cinema_error message
    // rather than a direct reply to either of these.
    sendCinemaClaimProjectionist() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "cinema_claim_projectionist" }));
      }
    },
    sendCinemaSetUrl(url) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "cinema_set_url", url }));
      }
    },
    dispose() {
      closed = true;
      ws?.close();
    },
  };
}
