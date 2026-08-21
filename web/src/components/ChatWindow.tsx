import { useEffect, useRef, useState } from "react";
import type { Conversation, Message, MessageAttachment, SystemActionMetadata } from "../types";
import { applyEmojiShortcuts } from "../lib/emoji";
import { EmojiPicker } from "./EmojiPicker";
import { apiBaseUrl } from "../api/client";
import { uploadAttachment } from "../api/conversations";
import { KarirsReplayModal } from "../games/karirs/KarirsReplayModal";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// metadata's shape depends on message type — these two just narrow it back
// down for the one type each actually applies to, rather than widening the
// type back to `any` at every call site.
function asAttachment(m: Message): MessageAttachment | null {
  if (m.type !== "image" && m.type !== "file") return null;
  return (m.metadata as MessageAttachment | null) ?? null;
}

function karirsReplayRaceId(m: Message): number | null {
  if (m.type !== "system_action" || !m.metadata) return null;
  const metadata = m.metadata as SystemActionMetadata;
  if (metadata.action !== "karirs_race_replay") return null;
  return typeof metadata.race_id === "number" ? metadata.race_id : null;
}

interface Props {
  conversation: Conversation;
  currentUserId: number;
  messages: Message[];
  typingUserIds: Set<number>;
  hasMore: boolean;
  loadingMore: boolean;
  onSend: (content: string) => void;
  onTyping: (state: "start" | "stop") => void;
  onMarkRead: (messageId: number) => void;
  onLoadMore: () => void;
  onBack: () => void;
}

export function ChatWindow({
  conversation,
  currentUserId,
  messages,
  typingUserIds,
  hasMore,
  loadingMore,
  onSend,
  onTyping,
  onMarkRead,
  onLoadMore,
  onBack,
}: Props) {
  const [draft, setDraft] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [replayRaceId, setReplayRaceId] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const typingStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const prevConversationIdRef = useRef<number | null>(null);
  const lastMessageIdRef = useRef<number | null>(null);
  // Tracks whether the view should stay glued to the newest message. Attachment
  // images finish downloading after the initial scroll-to-bottom already ran
  // (their height is unknown/collapsed until then), which used to leave the
  // view stranded above the true bottom once the image expanded the layout.
  const pinnedToBottomRef = useRef(true);

  const peer = conversation.participants.find((p) => p.id !== currentUserId);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (prependAnchorRef.current) {
      // Older messages were just prepended — keep the viewport anchored on the
      // same content instead of jumping, since scrolling to bottom would yank
      // the user away from what they were reading.
      const { scrollHeight: prevHeight, scrollTop: prevTop } = prependAnchorRef.current;
      container.scrollTop = container.scrollHeight - prevHeight + prevTop;
      prependAnchorRef.current = null;
      return;
    }

    // Parent components re-create callback props on every render, so this effect
    // re-runs far more often than "messages actually changed" — only act on a
    // genuine conversation switch or a genuinely new last message, and only
    // check `hasMore`/pagination-relevant guards then. Instant (non-animated)
    // scrolling is used deliberately: an animated scroll fires many intermediate
    // native `scroll` events, which is what caused spurious auto-pagination here.
    const isNewConversation = prevConversationIdRef.current !== conversation.id;
    const last = messages[messages.length - 1];
    const isNewMessage = !isNewConversation && !!last && last.id !== lastMessageIdRef.current;

    if (isNewConversation || isNewMessage) {
      container.scrollTop = container.scrollHeight;
      pinnedToBottomRef.current = true;
    }

    prevConversationIdRef.current = conversation.id;
    if (last) {
      lastMessageIdRef.current = last.id;
      onMarkRead(last.id);
    }
  }, [messages, conversation.id, onMarkRead]);

  function handleScroll() {
    const container = scrollContainerRef.current;
    if (!container) return;

    const distanceFromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
    pinnedToBottomRef.current = distanceFromBottom < 40;

    if (loadingMore || !hasMore) return;
    if (container.scrollTop < 100) {
      prependAnchorRef.current = { scrollHeight: container.scrollHeight, scrollTop: container.scrollTop };
      onLoadMore();
    }
  }

  // Watches the actual rendered height of the message list, rather than reacting
  // to individual <img> load events. onLoad fires as soon as the image decodes,
  // which on some (especially mobile) browsers is before layout has finished
  // reflowing to the image's real size — reading scrollHeight at that instant
  // under-counts it. ResizeObserver's callback only fires once layout has
  // actually settled, so it's the reliable way to catch the height growing.
  useEffect(() => {
    const content = contentRef.current;
    const container = scrollContainerRef.current;
    if (!content || !container) return;

    const observer = new ResizeObserver(() => {
      if (!pinnedToBottomRef.current) return;
      container.scrollTop = container.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  function notifyTyping() {
    onTyping("start");
    if (typingStopTimer.current) clearTimeout(typingStopTimer.current);
    typingStopTimer.current = setTimeout(() => onTyping("stop"), 1500);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    const cursorPos = e.target.selectionStart ?? raw.length;
    const converted = applyEmojiShortcuts(raw);
    const lengthDiff = converted.length - raw.length;

    setDraft(converted);
    notifyTyping();

    if (lengthDiff !== 0) {
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        const newPos = cursorPos + lengthDiff;
        el.setSelectionRange(newPos, newPos);
      });
    }
  }

  function insertEmoji(emoji: string) {
    const el = inputRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + emoji + draft.slice(end);
    setDraft(next);
    notifyTyping();

    requestAnimationFrame(() => {
      if (!el) return;
      const pos = start + emoji.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    onSend(content);
    setDraft("");
    onTyping("stop");
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setUploading(true);
    setUploadError(null);
    try {
      // The upload endpoint creates the message server-side and broadcasts it
      // over the websocket to all participants (including us), so no local
      // state update is needed here — it'll arrive via the same message.new
      // event a text message would.
      await uploadAttachment(conversation.id, file);
    } catch {
      setUploadError("Upload failed. File may be too large or an unsupported type.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-3 font-medium">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-lg text-neutral-500 hover:bg-neutral-100 md:hidden"
          aria-label="Back to conversations"
        >
          ←
        </button>
        <span className="truncate">{conversation.name ?? peer?.display_name ?? `Conversation #${conversation.id}`}</span>
      </div>

      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4">
        <div ref={contentRef}>
        {loadingMore && (
          <div className="py-2 text-center text-xs text-neutral-400">Loading earlier messages...</div>
        )}
        {!hasMore && !loadingMore && messages.length > 0 && (
          <div className="py-2 text-center text-xs text-neutral-300">Beginning of conversation</div>
        )}
        {messages.map((m) => {
          const isMine = m.sender_id === currentUserId;
          const attachment = asAttachment(m);
          const attachmentUrl = attachment ? `${apiBaseUrl}${attachment.url}` : null;
          const replayRaceIdForMessage = karirsReplayRaceId(m);

          return (
            <div key={m.id} className={`mb-2 flex ${isMine ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm sm:max-w-xs ${
                  m.type === "system_action"
                    ? "bg-neutral-50 text-neutral-700 ring-1 ring-neutral-200"
                    : isMine
                      ? "bg-amber-500 text-white"
                      : "bg-neutral-100 text-neutral-900"
                }`}
              >
                {m.type === "image" && attachmentUrl && (
                  <a href={attachmentUrl} target="_blank" rel="noreferrer">
                    <img
                      src={attachmentUrl}
                      alt={attachment?.filename ?? "attachment"}
                      className="mb-1 max-h-64 rounded"
                    />
                  </a>
                )}
                {m.type === "file" && attachmentUrl && attachment && (
                  <a
                    href={attachmentUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={`mb-1 flex items-center gap-2 rounded border px-2 py-1 ${
                      isMine ? "border-amber-300" : "border-neutral-300"
                    }`}
                  >
                    <span>📄</span>
                    <span className="truncate">{attachment.filename}</span>
                    <span className="text-xs opacity-70">{formatBytes(attachment.size)}</span>
                  </a>
                )}
                {m.content}
                {replayRaceIdForMessage !== null && (
                  <button
                    onClick={() => setReplayRaceId(replayRaceIdForMessage)}
                    className="mt-2 block w-full rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100"
                  >
                    🏁 Watch Replay
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
        </div>
      </div>

      <div className="h-5 px-4 text-xs text-neutral-500">
        {uploadError ? <span className="text-red-500">{uploadError}</span> : uploading ? "Uploading..." : typingUserIds.size > 0 ? "Typing..." : ""}
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2 border-t border-neutral-200 p-3">
        <div className="relative flex-shrink-0">
          <button
            type="button"
            onClick={() => setShowEmojiPicker((v) => !v)}
            className="flex h-full items-center rounded border border-neutral-300 px-3 text-lg hover:bg-neutral-50"
            aria-label="Insert emoji"
          >
            😊
          </button>
          {showEmojiPicker && (
            <EmojiPicker
              onSelect={insertEmoji}
              onClose={() => setShowEmojiPicker(false)}
            />
          )}
        </div>
        <input ref={fileInputRef} type="file" onChange={handleFileSelected} className="hidden" />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="flex flex-shrink-0 items-center rounded border border-neutral-300 px-3 text-lg hover:bg-neutral-50 disabled:opacity-50"
          aria-label="Attach file"
        >
          📎
        </button>
        <input
          ref={inputRef}
          value={draft}
          onChange={handleChange}
          placeholder="Type a message..."
          className="min-w-0 flex-1 rounded border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-amber-500"
        />
        <button type="submit" className="flex-shrink-0 rounded bg-amber-500 px-4 py-2 text-sm text-white hover:bg-amber-600">
          Send
        </button>
      </form>

      {replayRaceId !== null && (
        <KarirsReplayModal raceId={replayRaceId} onClose={() => setReplayRaceId(null)} />
      )}
    </div>
  );
}
