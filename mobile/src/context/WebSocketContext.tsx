import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { apiBaseUrl, apiKey, getStoredAuth } from "../api/client";
import { useAuth } from "./AuthContext";
import type { WsEvent } from "../types";

type Listener = (event: WsEvent) => void;

interface WsContextValue {
  send: (type: string, data: Record<string, unknown>) => void;
  subscribe: (listener: Listener) => () => void;
}

const WsContext = createContext<WsContextValue | null>(null);

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const socketRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Set<Listener>>(new Set());
  const pendingQueueRef = useRef<string[]>([]);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    async function connect() {
      const auth = await getStoredAuth();
      if (!auth || cancelled) return;

      const wsBase = apiBaseUrl.replace(/^http/, "ws");
      const url = `${wsBase}/api/v1/ws?token=${encodeURIComponent(auth.access_token)}&api_key=${encodeURIComponent(apiKey)}`;
      socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        const queued = pendingQueueRef.current;
        pendingQueueRef.current = [];
        queued.forEach((payload) => socket?.send(payload));
      };

      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as WsEvent;
          listenersRef.current.forEach((listener) => listener(parsed));
        } catch {
          // ignore malformed frames
        }
      };

      socket.onclose = () => {
        socketRef.current = null;
        if (!cancelled) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      socketRef.current = null;
    };
  }, [user]);

  function send(type: string, data: Record<string, unknown>) {
    const payload = JSON.stringify({ type, data });
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(payload);
    } else {
      pendingQueueRef.current.push(payload);
    }
  }

  function subscribe(listener: Listener) {
    listenersRef.current.add(listener);
    return () => listenersRef.current.delete(listener);
  }

  return <WsContext.Provider value={{ send, subscribe }}>{children}</WsContext.Provider>;
}

export function useWebSocket() {
  const ctx = useContext(WsContext);
  if (!ctx) throw new Error("useWebSocket must be used within WebSocketProvider");
  return ctx;
}
