import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useChatData } from "../hooks/useChatData";
import { ConversationList } from "../components/ConversationList";
import { FriendsPanel } from "../components/FriendsPanel";
import { ChatWindow } from "../components/ChatWindow";
import type { Conversation } from "../types";

type Tab = "conversations" | "friends";

export function ChatPage() {
  const { user, logout } = useAuth();
  const {
    conversations,
    friends,
    incomingRequests,
    outgoingRequests,
    messagesByConversation,
    typingByConversation,
    onlineUserIds,
    hasMoreByConversation,
    loadingMoreByConversation,
    refreshAll,
    loadHistory,
    loadMoreHistory,
    startConversationWith,
    sendMessage,
    sendTyping,
    markRead,
  } = useChatData();

  const [tab, setTab] = useState<Tab>("conversations");
  const [selected, setSelected] = useState<Conversation | null>(null);

  useEffect(() => {
    if (selected) loadHistory(selected.id);
  }, [selected, loadHistory]);

  if (!user) return null;

  async function handleMessageFriend(userId: number) {
    return startConversationWith(userId);
  }

  return (
    <div className="flex h-full">
      <aside
        className={`w-full flex-shrink-0 flex-col border-r border-neutral-200 md:flex md:w-80 ${
          selected ? "hidden md:flex" : "flex"
        }`}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
          <div>
            <p className="text-sm font-medium">{user.display_name}</p>
            <p className="text-xs text-neutral-500">@{user.username}</p>
          </div>
          <button onClick={logout} className="text-xs text-neutral-500 hover:underline">
            Log out
          </button>
        </div>

        <div className="flex border-b border-neutral-200 text-sm">
          <button
            onClick={() => setTab("conversations")}
            className={`flex-1 py-2 ${tab === "conversations" ? "border-b-2 border-amber-500 font-medium" : "text-neutral-500"}`}
          >
            Chats
          </button>
          <button
            onClick={() => setTab("friends")}
            className={`flex-1 py-2 ${tab === "friends" ? "border-b-2 border-amber-500 font-medium" : "text-neutral-500"}`}
          >
            Friends
            {incomingRequests.length > 0 && (
              <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-xs text-white">
                {incomingRequests.length}
              </span>
            )}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {tab === "conversations" ? (
            <ConversationList
              conversations={conversations}
              currentUserId={user.id}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
              onlineUserIds={onlineUserIds}
            />
          ) : (
            <FriendsPanel
              friends={friends}
              incomingRequests={incomingRequests}
              outgoingRequests={outgoingRequests}
              onlineUserIds={onlineUserIds}
              onRefresh={refreshAll}
              onMessageFriend={handleMessageFriend}
              onSelectConversation={(c) => {
                setSelected(c);
                setTab("conversations");
              }}
            />
          )}
        </div>
      </aside>

      <main className={`min-w-0 flex-1 ${selected ? "block" : "hidden md:block"}`}>
        {selected ? (
          <ChatWindow
            conversation={selected}
            currentUserId={user.id}
            messages={messagesByConversation[selected.id] ?? []}
            typingUserIds={
              new Set([...(typingByConversation[selected.id] ?? [])].filter((id) => id !== user.id))
            }
            hasMore={hasMoreByConversation[selected.id] ?? false}
            loadingMore={loadingMoreByConversation[selected.id] ?? false}
            onSend={(content) => sendMessage(selected.id, content)}
            onTyping={(state) => sendTyping(selected.id, state)}
            onMarkRead={(messageId) => markRead(selected.id, messageId)}
            onLoadMore={() => loadMoreHistory(selected.id)}
            onBack={() => setSelected(null)}
          />
        ) : (
          <div className="hidden h-full items-center justify-center text-neutral-400 md:flex">
            Select a conversation to start chatting
          </div>
        )}
      </main>
    </div>
  );
}
