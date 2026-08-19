import type { Conversation } from "../types";

interface Props {
  conversations: Conversation[];
  currentUserId: number;
  selectedId: number | null;
  onSelect: (conversation: Conversation) => void;
  onlineUserIds: Set<number>;
}

function peerOf(conversation: Conversation, currentUserId: number) {
  return conversation.participants.find((p) => p.id !== currentUserId) ?? null;
}

function isUnread(conversation: Conversation) {
  return conversation.last_message_id != null && conversation.last_message_id > (conversation.last_read_message_id ?? 0);
}

export function ConversationList({ conversations, currentUserId, selectedId, onSelect, onlineUserIds }: Props) {
  if (conversations.length === 0) {
    return <p className="p-4 text-sm text-neutral-500">No conversations yet. Message a friend to start one.</p>;
  }

  return (
    <ul>
      {conversations.map((conversation) => {
        const peer = peerOf(conversation, currentUserId);
        const label = conversation.name ?? peer?.display_name ?? `Conversation #${conversation.id}`;
        const isOnline = peer ? onlineUserIds.has(peer.id) : false;
        const unread = isUnread(conversation);

        return (
          <li key={conversation.id}>
            <button
              onClick={() => onSelect(conversation)}
              className={`flex w-full items-center gap-2 border-b border-neutral-100 px-4 py-3 text-left text-sm hover:bg-neutral-50 ${
                selectedId === conversation.id ? "bg-amber-50" : ""
              }`}
            >
              <span className={`h-2 w-2 flex-shrink-0 rounded-full ${isOnline ? "bg-green-500" : "bg-neutral-300"}`} />
              <span className={`flex-1 truncate ${unread ? "font-semibold text-neutral-900" : "text-neutral-700"}`}>
                {label}
              </span>
              {unread && (
                <span
                  className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-amber-500"
                  aria-label="Unread messages"
                />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
