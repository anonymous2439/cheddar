import { useState } from "react";
import type { Lobby, User } from "../types";
import { KarirsGame } from "../games/karirs/KarirsGame";

interface Props {
  lobby: Lobby;
  currentUserId: number;
  friends: User[];
  onReady: (isReady: boolean) => void;
  onStart: () => void;
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

  const me = lobby.participants.find((p) => p.user.id === currentUserId);
  const isLeader = !!me?.is_leader;
  const isLive = lobby.status !== "waiting";
  const isOngoing = lobby.status === "in_progress" && gameTracksCompletion;
  const allReady = lobby.participants.length > 0 && lobby.participants.every((p) => p.is_ready);
  const memberIds = new Set(lobby.participants.map((p) => p.user.id));
  const invitableFriends = friends.filter((f) => !memberIds.has(f.id));

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
          <KarirsGame lobby={lobby} onFinished={onGameFinished} />
          {backToLobbyChrome}
        </div>
      );
    }
    return (
      <div className="p-6 text-sm text-neutral-500">
        {lobby.game_name} isn't available on the web yet — try it from the vscode extension.
        {backToLobbyChrome}
      </div>
    );
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
    <div className="flex h-full flex-col p-4">
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

      <div className="mb-4 flex flex-wrap gap-2">
        <button
          onClick={() => onReady(!me?.is_ready)}
          className={`rounded px-3 py-1.5 text-sm text-white ${me?.is_ready ? "bg-neutral-500 hover:bg-neutral-600" : "bg-green-600 hover:bg-green-700"}`}
        >
          {me?.is_ready ? "Unready" : "Ready"}
        </button>
        {isLeader && (
          <button
            onClick={onStart}
            disabled={!allReady}
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
  );
}
