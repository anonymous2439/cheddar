import axios from "axios";
import { Chess } from "chess.js";
import { useEffect, useRef, useState } from "react";
import { Chessboard } from "react-chessboard";
import * as chessApi from "../../api/chess";
import { useWebSocket } from "../../context/WebSocketContext";
import type { ChessState, Lobby } from "../../types";

interface Props {
  lobby: Lobby;
  currentUserId: number;
  onFinished?: () => void;
}

const STATUS_LABEL: Record<ChessState["status"], string> = {
  in_progress: "",
  checkmate: "Checkmate",
  stalemate: "Stalemate — draw",
  draw: "Draw",
  resigned: "Resigned",
};

export function ChessGame({ lobby, currentUserId, onFinished }: Props) {
  const { subscribe } = useWebSocket();
  const [state, setState] = useState<ChessState | null>(null);
  // The brief window between a locally-legal drop and the server's
  // authoritative response — cleared as soon as either arrives, so the
  // board never lingers out of sync with what the server actually accepted.
  const [optimisticFen, setOptimisticFen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const lastFinishedRef = useRef<string | null>(null);
  const onFinishedRef = useRef(onFinished);

  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setOptimisticFen(null);
    setError("");
    lastFinishedRef.current = null;

    chessApi.getChessState(lobby.id).then((s) => {
      if (!cancelled) setState(s);
    });

    return () => {
      cancelled = true;
    };
  }, [lobby.id]);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === "chess.move" && event.data.lobby_id === lobby.id) {
        setState(event.data);
        setOptimisticFen(null);
      }
    });
  }, [subscribe, lobby.id]);

  useEffect(() => {
    if (!state) return;
    // Only fire once per concluded game — a lobby restart gets a fresh
    // ChessGame row server-side (see chess.py's lobby_started_at key), and
    // this component itself remounts its state on a new lobby.id, but not
    // on a same-lobby restart, so this guard is what stops a second
    // spurious finish call after the first one already unblocked the
    // leader's "Back to Lobby".
    const marker = `${lobby.id}:${state.updated_at}`;
    if (state.status !== "in_progress" && lastFinishedRef.current !== marker) {
      lastFinishedRef.current = marker;
      onFinishedRef.current?.();
    }
  }, [state, lobby.id]);

  if (!state) {
    return <div className="p-6 text-sm text-neutral-500">Loading board…</div>;
  }

  const myColor: "white" | "black" | null =
    currentUserId === state.white_user_id ? "white" : currentUserId === state.black_user_id ? "black" : null;
  const isMyTurn = myColor === state.turn && state.status === "in_progress";
  const displayFen = optimisticFen ?? state.fen;

  function handleDrop({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) {
    if (!targetSquare || !isMyTurn) return false;

    const board = new Chess(state!.fen);
    let move;
    try {
      move = board.move({ from: sourceSquare, to: targetSquare, promotion: "q" });
    } catch {
      return false;
    }

    const uci = `${move.from}${move.to}${move.promotion ?? ""}`;
    setOptimisticFen(board.fen());
    setError("");
    chessApi
      .makeChessMove(lobby.id, uci)
      .then((s) => {
        setState(s);
        setOptimisticFen(null);
      })
      .catch((err) => {
        setOptimisticFen(null);
        const detail = axios.isAxiosError(err) ? (err.response?.data?.detail as string | undefined) : undefined;
        setError(detail ?? "Could not make that move");
      });
    return true;
  }

  async function handleResign() {
    try {
      const s = await chessApi.resignChess(lobby.id);
      setState(s);
    } catch (err) {
      const detail = axios.isAxiosError(err) ? (err.response?.data?.detail as string | undefined) : undefined;
      setError(detail ?? "Could not resign");
    }
  }

  const opponentColor = myColor === "white" ? "black" : "white";
  const statusText = (() => {
    if (state.status === "in_progress") {
      if (!myColor) return state.turn === "white" ? "White to move" : "Black to move";
      return isMyTurn ? "Your move" + (state.is_check ? " — you're in check" : "") : "Waiting for opponent" + (state.is_check ? " (check)" : "");
    }
    if (state.status === "resigned") {
      const winnerIsMe = state.winner_user_id === currentUserId;
      return myColor ? (winnerIsMe ? `${opponentColor} resigned — you win!` : "You resigned") : "A player resigned";
    }
    if (state.status === "checkmate") {
      const winnerIsMe = state.winner_user_id === currentUserId;
      return myColor ? (winnerIsMe ? "Checkmate — you win!" : "Checkmate — you lose") : `${STATUS_LABEL.checkmate}`;
    }
    return STATUS_LABEL[state.status];
  })();

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">♟️ {lobby.name}</h2>
        {myColor && state.status === "in_progress" && (
          <button onClick={handleResign} className="text-xs text-neutral-500 hover:text-red-600 hover:underline">
            Resign
          </button>
        )}
      </div>

      <p className="mb-3 text-sm text-neutral-600">
        {statusText}
        {state.ai_skill_level != null && <span className="text-neutral-400"> · vs AI (skill {state.ai_skill_level})</span>}
      </p>

      <div className="mx-auto w-full max-w-md">
        <Chessboard
          options={{
            position: displayFen,
            onPieceDrop: handleDrop,
            boardOrientation: myColor ?? "white",
            allowDragging: isMyTurn,
            id: `chess-${lobby.id}`,
          }}
        />
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}
