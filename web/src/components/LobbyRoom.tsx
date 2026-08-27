import { useEffect, useState } from "react";
import type { Lobby, Message, User } from "../types";
import { KarirsGame } from "../games/karirs/KarirsGame";
import { ChessGame } from "../games/chess/ChessGame";
import { BeatsGame } from "../games/beats/BeatsGame";
import { MtgGame } from "../games/mtg/MtgGame";
import { createBeatsSession } from "../api/beats";
import { createMtgSession, getMtgDeckStatus, importMtgDeck } from "../api/mtg";
import { LobbyChatDock } from "./LobbyChatDock";

interface Props {
  lobby: Lobby;
  currentUserId: number;
  friends: User[];
  chatMessages: Message[];
  onSendChat: (content: string) => void;
  onReady: (isReady: boolean) => void;
  onStart: () => Promise<unknown>;
  onLeave: () => void;
  onRestart: () => void;
  onKick: (userId: number) => void;
  onTransferLeader: (userId: number) => void;
  onInviteFriend: (userId: number) => void;
  onGetInviteCode: () => Promise<string>;
  onGameFinished: () => void;
  gameTracksCompletion: boolean;
}

export function LobbyRoom({
  lobby,
  currentUserId,
  friends,
  chatMessages,
  onSendChat,
  onReady,
  onStart,
  onLeave,
  onRestart,
  onKick,
  onTransferLeader,
  onInviteFriend,
  onGetInviteCode,
  onGameFinished,
  gameTracksCompletion,
}: Props) {
  const [showInvite, setShowInvite] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(lobby.invite_code);
  const [copied, setCopied] = useState(false);
  const [beatsMode, setBeatsMode] = useState<"4key" | "8key">("4key");
  const [beatsBpm, setBeatsBpm] = useState(100);
  const [beatsPulseCount, setBeatsPulseCount] = useState(5);
  const [mtgDecklist, setMtgDecklist] = useState("");
  const [mtgImportResult, setMtgImportResult] = useState<{ card_count: number; unresolved_names: string[] } | null>(null);
  const [mtgImportError, setMtgImportError] = useState("");
  const [mtgDeckCounts, setMtgDeckCounts] = useState<Record<number, number>>({});

  // Deck imports aren't part of the Lobby model (each player submits their
  // own independently, before there's any MtgGame row to broadcast from —
  // see mtg.py's MtgDeckImport), so there's no websocket push for "the
  // other player just imported a deck": a light poll while still waiting
  // is the simplest way to reflect their progress.
  useEffect(() => {
    if (lobby.game_key !== "cheddar_mtg" || lobby.status !== "waiting") return;
    let cancelled = false;
    function poll() {
      getMtgDeckStatus(lobby.id)
        .then((s) => {
          if (cancelled) return;
          setMtgDeckCounts(Object.fromEntries(s.players.map((p) => [p.user_id, p.card_count])));
        })
        .catch(() => {});
    }
    poll();
    const interval = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [lobby.id, lobby.game_key, lobby.status]);

  const me = lobby.participants.find((p) => p.user.id === currentUserId);
  const isLeader = !!me?.is_leader;
  const isLive = lobby.status !== "waiting";
  const isOngoing = lobby.status === "in_progress" && gameTracksCompletion;
  const allReady = lobby.participants.length > 0 && lobby.participants.every((p) => p.is_ready);
  const memberIds = new Set(lobby.participants.map((p) => p.user.id));
  const invitableFriends = friends.filter((f) => !memberIds.has(f.id));

  const chatDock = (
    <LobbyChatDock currentUserId={currentUserId} participants={lobby.participants} messages={chatMessages} onSend={onSendChat} />
  );

  if (isLive) {
    const backToLobbyChrome = isLeader && (
      <div className="border-t border-neutral-200 p-3">
        {isOngoing ? (
          <p className="text-xs text-neutral-500">🎮 Game in progress — invites are disabled until it finishes.</p>
        ) : (
          <button
            onClick={onRestart}
            className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-white hover:bg-neutral-900"
          >
            Back to Lobby
          </button>
        )}
      </div>
    );

    if (lobby.game_key === "karirs") {
      return (
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1 overflow-hidden">
            <KarirsGame lobby={lobby} onFinished={onGameFinished} />
          </div>
          {backToLobbyChrome}
          {chatDock}
        </div>
      );
    }
    if (lobby.game_key === "chess") {
      return (
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ChessGame lobby={lobby} currentUserId={currentUserId} onFinished={onGameFinished} />
          </div>
          {backToLobbyChrome}
          {chatDock}
        </div>
      );
    }
    if (lobby.game_key === "cheddar_beats") {
      return (
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <BeatsGame lobby={lobby} currentUserId={currentUserId} onFinished={onGameFinished} />
          </div>
          {backToLobbyChrome}
          {chatDock}
        </div>
      );
    }
    if (lobby.game_key === "cheddar_mtg") {
      return (
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <MtgGame lobby={lobby} currentUserId={currentUserId} onFinished={onGameFinished} />
          </div>
          {backToLobbyChrome}
          {chatDock}
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto p-6 text-sm text-neutral-500">
          {lobby.game_name} isn't available on the web yet — try it from the vscode extension.
        </div>
        {backToLobbyChrome}
        {chatDock}
      </div>
    );
  }

  async function handleStartClick() {
    await onStart();
    if (lobby.game_key === "cheddar_beats") {
      // The generic start above just flips the lobby to in_progress — the
      // actual chart (level/mode the leader picked, which random chart to
      // play) is its own separate call, same reasoning chess/karirs have
      // for lazily creating their own session state instead of teaching the
      // generic lobby endpoints about every game's specific setup.
      await createBeatsSession(lobby.id, beatsMode, beatsBpm, beatsPulseCount);
    }
    if (lobby.game_key === "cheddar_mtg") {
      await createMtgSession(lobby.id);
    }
  }

  async function handleMtgImport() {
    setMtgImportError("");
    try {
      const result = await importMtgDeck(lobby.id, mtgDecklist);
      setMtgImportResult(result);
      setMtgDeckCounts((prev) => ({ ...prev, [currentUserId]: result.card_count }));
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setMtgImportError(detail ?? "Could not import that decklist");
    }
  }

  async function handleShowInviteCode() {
    if (!inviteCode) setInviteCode(await onGetInviteCode());
    setShowInvite(false);
  }

  async function handleCopyCode() {
    if (!inviteCode) return;
    await navigator.clipboard.writeText(inviteCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{lobby.game_name}</h2>
          <button onClick={onLeave} className="text-xs text-neutral-500 hover:underline">
            Leave
          </button>
        </div>

        <ul className="mb-4 space-y-1">
          {lobby.participants.map((p) => (
            <li key={p.user.id} className="flex items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-neutral-50">
              <span>
                {p.is_leader && "👑 "}
                {p.user.display_name} <span className="text-neutral-400">@{p.user.username}</span>
              </span>
              <div className="flex items-center gap-2">
                <span className={p.is_ready ? "text-green-600" : "text-neutral-400"}>
                  {p.is_ready ? "Ready" : "Not ready"}
                </span>
                {isLeader && p.user.id !== currentUserId && (
                  <>
                    <button onClick={() => onTransferLeader(p.user.id)} className="text-xs text-neutral-400 hover:underline">
                      Make leader
                    </button>
                    <button onClick={() => onKick(p.user.id)} className="text-xs text-red-500 hover:underline">
                      Kick
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>

        {isLeader && lobby.game_key === "cheddar_beats" && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded border border-neutral-200 p-3 text-sm">
            <label className="flex items-center gap-2">
              Mode
              <select
                value={beatsMode}
                onChange={(e) => setBeatsMode(e.target.value as "4key" | "8key")}
                className="rounded border border-neutral-300 px-2 py-1"
              >
                <option value="4key">4 keys</option>
                <option value="8key">8 keys</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              BPM
              <select
                value={beatsBpm}
                onChange={(e) => setBeatsBpm(Number(e.target.value))}
                className="rounded border border-neutral-300 px-2 py-1"
              >
                {[80, 90, 100, 110, 120, 130].map((bpm) => (
                  <option key={bpm} value={bpm}>
                    {bpm}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              Heartbeats
              <select
                value={beatsPulseCount}
                onChange={(e) => setBeatsPulseCount(Number(e.target.value))}
                className="rounded border border-neutral-300 px-2 py-1"
              >
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {lobby.game_key === "cheddar_mtg" && (
          <div className="mb-3 rounded border border-neutral-200 p-3 text-sm">
            <p className="mb-2 text-xs font-semibold uppercase text-neutral-500">Import your deck</p>
            <textarea
              value={mtgDecklist}
              onChange={(e) => setMtgDecklist(e.target.value)}
              placeholder={"4 Lightning Bolt\n4 Mountain\n1 Black Lotus\n..."}
              rows={4}
              className="mb-2 w-full rounded border border-neutral-300 p-2 font-mono text-xs"
            />
            <button
              onClick={handleMtgImport}
              disabled={!mtgDecklist.trim()}
              className="rounded bg-neutral-800 px-3 py-1.5 text-xs text-white hover:bg-neutral-900 disabled:cursor-not-allowed disabled:bg-neutral-300"
            >
              Import deck
            </button>
            {mtgImportError && <p className="mt-2 text-xs text-red-600">{mtgImportError}</p>}
            {mtgImportResult && (
              <p className="mt-2 text-xs text-green-700">
                Imported {mtgImportResult.card_count} cards.
                {mtgImportResult.unresolved_names.length > 0 && (
                  <span className="text-amber-600"> Couldn't find: {mtgImportResult.unresolved_names.join(", ")}</span>
                )}
              </p>
            )}
            <ul className="mt-3 space-y-0.5 text-xs text-neutral-500">
              {lobby.participants.map((p) => (
                <li key={p.user.id}>
                  {p.user.display_name}: {mtgDeckCounts[p.user.id] ? `${mtgDeckCounts[p.user.id]} cards imported` : "no deck imported yet"}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mb-4 flex flex-wrap gap-2">
          <button
            onClick={() => onReady(!me?.is_ready)}
            className={`rounded px-3 py-1.5 text-sm text-white ${me?.is_ready ? "bg-neutral-500 hover:bg-neutral-600" : "bg-green-600 hover:bg-green-700"}`}
          >
            {me?.is_ready ? "Unready" : "Ready"}
          </button>
          {isLeader && (
            <button
              onClick={handleStartClick}
              disabled={!allReady || (lobby.game_key === "cheddar_mtg" && lobby.participants.some((p) => !mtgDeckCounts[p.user.id]))}
              className="rounded bg-amber-500 px-3 py-1.5 text-sm text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-neutral-300"
            >
              Start
            </button>
          )}
          <button
            onClick={() => setShowInvite((v) => !v)}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50"
          >
            Invite
          </button>
        </div>

        {!isLeader && (
          <p className="mb-3 text-xs text-neutral-500">
            {allReady ? "Everyone's ready — waiting for the leader to start." : "Waiting for everyone to ready up."}
          </p>
        )}

        {showInvite && (
          <div className="mb-4 rounded border border-neutral-200 p-3">
            <p className="mb-2 text-xs font-semibold uppercase text-neutral-500">Invite a friend</p>
            {invitableFriends.length === 0 ? (
              <p className="text-sm text-neutral-500">No friends available to invite.</p>
            ) : (
              <ul className="mb-3 space-y-1">
                {invitableFriends.map((f) => (
                  <li key={f.id} className="flex items-center justify-between text-sm">
                    <span>{f.display_name}</span>
                    <button
                      onClick={() => onInviteFriend(f.id)}
                      className="rounded bg-amber-500 px-2 py-0.5 text-xs text-white hover:bg-amber-600"
                    >
                      Invite
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <p className="mb-1 text-xs font-semibold uppercase text-neutral-500">Or share a code</p>
            {inviteCode ? (
              <div className="flex items-center gap-2">
                <code className="rounded bg-neutral-100 px-2 py-1 text-sm">{inviteCode}</code>
                <button onClick={handleCopyCode} className="text-xs text-neutral-500 hover:underline">
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            ) : (
              <button onClick={handleShowInviteCode} className="text-xs text-amber-600 hover:underline">
                Generate a code
              </button>
            )}
          </div>
        )}
      </div>
      {chatDock}
    </div>
  );
}
