import { useEffect, useRef, useState, type FormEvent } from "react";
import axios from "axios";
import type { LobbyParticipant, Message, SystemActionMetadata } from "../types";
import { claimDailyBonus } from "../api/karirs";
import { notifyKarirsWalletChanged } from "../lib/karirsEvents";

interface Props {
  currentUserId: number;
  participants: LobbyParticipant[];
  messages: Message[];
  onSend: (content: string) => void;
}

function isKarirsDailyBonusMessage(m: Message): boolean {
  if (m.type !== "system_action" || !m.metadata) return false;
  return (m.metadata as SystemActionMetadata).action === "karirs_daily_bonus";
}

// The Games tab used to have no way to chat at all — this is scoped to
// exactly one conversation (the lobby's own, via its conversation_id), never
// any other chat. Collapsed by default to a single-line preview of the
// latest message so it doesn't compete with the game itself for space;
// tapping it expands a short, semi-transparent scrollback over the game
// view instead of pushing a whole separate column into the layout.
export function LobbyChatDock({ currentUserId, participants, messages, onSend }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [bonusClaimStatus, setBonusClaimStatus] = useState<Record<number, "loading" | "claimed" | "error">>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, expanded]);

  function nameFor(userId: number): string {
    if (userId === currentUserId) return "You";
    return participants.find((p) => p.user.id === userId)?.user.display_name ?? "Someone";
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setDraft("");
  }

  async function handleClaimDailyBonus(messageId: number) {
    setBonusClaimStatus((prev) => ({ ...prev, [messageId]: "loading" }));
    try {
      await claimDailyBonus();
      setBonusClaimStatus((prev) => ({ ...prev, [messageId]: "claimed" }));
      // KarirsGame owns the coin total shown in the game view, and doesn't
      // know this claim happened at all otherwise — this is what tells it
      // to refetch instead of sitting stale.
      notifyKarirsWalletChanged();
    } catch (err) {
      // A 409 just means today's bonus is already claimed (possibly from
      // another device) — treat it the same as a successful claim rather
      // than an error.
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        setBonusClaimStatus((prev) => ({ ...prev, [messageId]: "claimed" }));
      } else {
        setBonusClaimStatus((prev) => ({ ...prev, [messageId]: "error" }));
      }
    }
  }

  const latest = messages[messages.length - 1];

  return (
    <div className="flex-shrink-0 border-t border-neutral-200 bg-white/70 backdrop-blur-sm">
      {expanded && (
        <div ref={scrollRef} className="max-h-48 overflow-y-auto bg-white/60 px-3 py-2 backdrop-blur-sm">
          {messages.length === 0 && <p className="text-center text-xs text-neutral-400">No messages yet</p>}
          {messages.map((m) => {
            const isDailyBonus = isKarirsDailyBonusMessage(m);
            const bonusStatus = bonusClaimStatus[m.id];
            return (
              <div key={m.id} className={`mb-1 flex ${m.sender_id === currentUserId ? "justify-end" : "justify-start"}`}>
                <span
                  className={`max-w-[80%] rounded px-2 py-1 text-xs ${
                    m.type === "system_action" || m.type === "system"
                      ? "bg-neutral-100/80 text-neutral-600"
                      : m.sender_id === currentUserId
                        ? "bg-amber-500/90 text-white"
                        : "bg-neutral-100/80 text-neutral-900"
                  }`}
                >
                  {m.sender_id !== currentUserId && m.type !== "system_action" && m.type !== "system" && (
                    <span className="mr-1 font-medium">{nameFor(m.sender_id)}:</span>
                  )}
                  {m.content}
                  {isDailyBonus && bonusStatus !== "claimed" && (
                    <button
                      type="button"
                      onClick={() => handleClaimDailyBonus(m.id)}
                      disabled={bonusStatus === "loading"}
                      className="mt-1 block w-full rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                    >
                      {bonusStatus === "loading" ? "Claiming…" : bonusStatus === "error" ? "Couldn't claim — try again" : "🎁 Claim 250 coins"}
                    </button>
                  )}
                  {isDailyBonus && bonusStatus === "claimed" && (
                    <p className="mt-1 text-xs font-medium text-amber-700">✅ Claimed!</p>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-neutral-600 hover:bg-neutral-50/80"
      >
        <span className="min-w-0 flex-1 truncate">
          {latest ? `💬 ${nameFor(latest.sender_id)}: ${latest.content}` : "💬 Lobby chat"}
        </span>
        <span className="flex-shrink-0 text-neutral-400">{expanded ? "▾" : "▸"}</span>
      </button>

      <form onSubmit={handleSubmit} className="flex gap-2 border-t border-neutral-100 p-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setExpanded(true)}
          placeholder="Message the lobby…"
          className="min-w-0 flex-1 rounded border border-neutral-300 bg-white/80 px-2 py-1 text-sm outline-none focus:border-amber-500"
        />
        <button type="submit" className="flex-shrink-0 rounded bg-amber-500 px-3 py-1 text-sm text-white hover:bg-amber-600">
          Send
        </button>
      </form>
    </div>
  );
}
