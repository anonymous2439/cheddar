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

function ConversationRow({
  conversation,
  currentUserId,
  selectedId,
  onSelect,
  onlineUserIds,
}: Props & { conversation: Conversation }) {
  const peer = peerOf(conversation, currentUserId);
  const label = conversation.name ?? peer?.display_name ?? `Conversation #${conversation.id}`;
  const isOnline = peer ? onlineUserIds.has(peer.id) : false;
  const unread = isUnread(conversation);

  return (
    <li>
      <button
        onClick={() => onSelect(conversation)}
        className={`flex w-full items-center gap-2 border-b border-neutral-100 px-4 py-3 text-left text-sm hover:bg-neutral-50 ${
          selectedId === conversation.id ? "bg-amber-50" : ""
        }`}
      >
        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${isOnline ? "bg-green-500" : "bg-neutral-300"}`} />
        <span className={`flex-1 truncate ${unread ? "font-semibold text-neutral-900" : "text-neutral-700"}`}>{label}</span>
        {unread && <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-amber-500" aria-label="Unread messages" />}
      </button>
    </li>
  );
}

export function ConversationList(props: Props) {
  const { conversations } = props;
  if (conversations.length === 0) {
    return <p className="p-4 text-sm text-neutral-500">No conversations yet. Message a friend to start one.</p>;
  }

  // Every group conversation is a game lobby's chat (that's the only way
  // one gets created — see games.py's create_lobby) — splitting on it
  // separates "who am I actually playing with" from "who am I just
  // talking to" at a glance, instead of one flat mixed list.
  const lobbyChats = conversations.filter((c) => c.type === "group");
  const directChats = conversations.filter((c) => c.type !== "group");

  return (
    <div>
      {lobbyChats.length > 0 && (
        <div>
          <p className="border-b border-neutral-200 bg-neutral-50 px-4 py-1.5 text-xs font-semibold uppercase text-neutral-500">
            Game Lobbies
          </p>
          <ul>
            {lobbyChats.map((conversation) => (
              <ConversationRow key={conversation.id} {...props} conversation={conversation} />
            ))}
          </ul>
        </div>
      )}
      {directChats.length > 0 && (
        <div>
          <p className="border-b border-t border-neutral-200 bg-neutral-50 px-4 py-1.5 text-xs font-semibold uppercase text-neutral-500">
            Direct Messages
          </p>
          <ul>
            {directChats.map((conversation) => (
              <ConversationRow key={conversation.id} {...props} conversation={conversation} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
