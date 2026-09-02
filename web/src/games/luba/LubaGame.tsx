import { useEffect, useRef } from "react";
import { mount, unmount, type LubaMountCtx } from "./engine/game";
import type { Lobby } from "../../types";

interface Props {
  lobby: Lobby;
  currentUserId: number;
  onFinished?: () => void;
}

// Thin React wrapper around the vanilla engine in engine/game.ts — that
// module is a self-contained closure owning its own Three.js
// scene/render loop/input handling/WebSocket (mirroring
// games/luba/client/src/game.js, the vscode extension's version of the
// same engine), so this component's job is just to mount it into a
// container div once and keep it fed with live data, not to reimplement
// any of its logic as React state.
export function LubaGame({ lobby, currentUserId, onFinished }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The engine reads ctx.participants fresh every frame (for the
  // standings overlay's name lookup) — keeping this object identity
  // stable and just mutating .participants in place means a lobby
  // participant list update (someone else joining) doesn't require
  // tearing down and remounting the whole game/socket.
  const ctxRef = useRef<LubaMountCtx>({ lobbyId: lobby.id, selfId: currentUserId, participants: [] });
  // onFinished is typically a fresh inline arrow every render (see
  // ChatPage.tsx's onGameFinished) — read through a ref, same reasoning
  // KarirsGame.tsx's onFinishedRef uses, so the mount effect below
  // doesn't need it in its dependency array (that would tear down and
  // reconnect the WebSocket on every unrelated parent re-render).
  const onFinishedRef = useRef(onFinished);

  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    ctxRef.current.participants = lobby.participants.map((p) => p.user);
  }, [lobby.participants]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    ctxRef.current = {
      lobbyId: lobby.id,
      selfId: currentUserId,
      participants: lobby.participants.map((p) => p.user),
      onMatchOver: () => onFinishedRef.current?.(),
    };
    mount(el, ctxRef.current);
    return () => unmount(el);
    // Deliberately just [lobby.id, currentUserId] — a live participants
    // update is handled by the effect above without remounting (see its
    // comment); remounting here would drop the WebSocket connection and
    // reset the player's in-match position every time someone else's
    // ready state or similar unrelated lobby field changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby.id, currentUserId]);

  return <div ref={containerRef} className="p-4" />;
}
