import { useEffect, useRef } from "react";
import { mountPractice, unmount } from "./engine/game";

// A fully local sandbox — no lobby, no WebSocket, just the arena and a
// practice dummy (see engine/game.ts's mountPractice). Unlike LubaGame,
// this never touches lobby/auth state at all, so it needs no props.
export function LubaPracticeGame() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    mountPractice(el);
    return () => unmount(el);
  }, []);

  return <div ref={containerRef} className="p-4" />;
}
