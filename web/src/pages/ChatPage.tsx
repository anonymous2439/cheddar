import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useChatData } from "../hooks/useChatData";
import { useGames } from "../hooks/useGames";
import { ConversationList } from "../components/ConversationList";
import { FriendsPanel } from "../components/FriendsPanel";
import { ChatWindow } from "../components/ChatWindow";
import { GamesPanel } from "../components/GamesPanel";
import { LobbyRoom } from "../components/LobbyRoom";
import type { Conversation } from "../types";

type Tab = "conversations" | "friends" | "games";

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

  const {
    catalog,
    myLobbies,
    currentLobby,
    selectLobby,
    createLobby,
    setReady,
    startLobby,
    restartLobby,
    finishGame,
    kickFromLobby,
    transferLeader,
    renameLobby,
    playVsAi,
    setChessColorChoice,
    inviteToLobby,
    getInviteCode,
    joinLobbyByCode,
    leaveLobby,
  } = useGames();

  const [tab, setTab] = useState<Tab>("conversations");
  const [selected, setSelected] = useState<Conversation | null>(null);
  // Narrow-viewport only — on desktop the sidebar is always visible
  // alongside the main pane, so this only matters below the md breakpoint.
  // Lets the sidebar open as a temporary overlay without touching
  // `selected`/`currentLobby` at all, so peeking at another chat never
  // costs an active game its state (the lobby stays joined, KarirsGame
  // stays mounted underneath) the way actually leaving the lobby would.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // `tab` doubles as "which panel is main showing" on desktop (intentional
  // — the Games tab itself navigates main there even with no lobby
  // selected yet). On mobile that's a problem: just tapping "Chats" inside
  // the drawer to look around, with no actual selection, would otherwise
  // yank main away from the lobby underneath. This remembers what tab was
  // active before the drawer opened, so closing it without picking
  // anything specific reverts to it instead of stranding main on whatever
  // tab happened to be open when the drawer closed.
  const tabBeforeDrawerRef = useRef<Tab>(tab);

  function openMobileNav() {
    tabBeforeDrawerRef.current = tab;
    setMobileNavOpen(true);
  }

  function closeMobileNav(committed: boolean) {
    if (!committed) setTab(tabBeforeDrawerRef.current);
    setMobileNavOpen(false);
  }

  useEffect(() => {
    if (selected) loadHistory(selected.id);
  }, [selected, loadHistory]);

  // The lobby's own chat is a normal conversation under the hood (the same
  // one that shows up in the Chats tab as "<game> lobby") — this just loads
  // its history so the compact dock in the Games tab has something to show
  // without the player needing to switch tabs to find it.
  useEffect(() => {
    const conversationId = currentLobby?.conversation_id;
    if (conversationId) loadHistory(conversationId);
  }, [currentLobby?.conversation_id, loadHistory]);

  if (!user) return null;

  async function handleMessageFriend(userId: number) {
    return startConversationWith(userId);
  }

  const isInLobby = tab === "games" && !!currentLobby;
  const sidebarWouldBeHidden = !!(selected || isInLobby);

  return (
    <div className="relative flex h-full">
      {mobileNavOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => closeMobileNav(false)} />
      )}

      <aside
        className={`w-full flex-shrink-0 flex-col border-r border-neutral-200 bg-white md:static md:z-auto md:flex md:w-80 ${
          mobileNavOpen ? "fixed inset-y-0 left-0 z-40 flex w-4/5 max-w-xs shadow-xl" : sidebarWouldBeHidden ? "hidden" : "flex"
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
          <button
            onClick={() => setTab("games")}
            className={`flex-1 py-2 ${tab === "games" ? "border-b-2 border-amber-500 font-medium" : "text-neutral-500"}`}
          >
            Games
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {tab === "conversations" && (
            <ConversationList
              conversations={conversations}
              currentUserId={user.id}
              selectedId={selected?.id ?? null}
              onSelect={(c) => {
                setSelected(c);
                closeMobileNav(true);
              }}
              onlineUserIds={onlineUserIds}
            />
          )}
          {tab === "friends" && (
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
                closeMobileNav(true);
              }}
            />
          )}
          {tab === "games" && (
            <GamesPanel
              catalog={catalog}
              myLobbies={myLobbies}
              selectedLobbyId={currentLobby?.id ?? null}
              onHost={(gameKey) => {
                createLobby(gameKey);
                closeMobileNav(true);
              }}
              onSelect={(lobby) => {
                selectLobby(lobby);
                closeMobileNav(true);
              }}
              onJoinByCode={joinLobbyByCode}
            />
          )}
        </div>
      </aside>

      <main className={`min-w-0 flex-1 flex-col ${sidebarWouldBeHidden ? "flex" : "hidden md:flex"}`}>
        {isInLobby && (
          // A normal, in-flow row above the content — not a floating/fixed
          // button. Fixed positioning meant this had to avoid colliding
          // with whatever happened to be at top-left in *every* possible
          // view (the game title, a chat header, ...); giving it its own
          // strip sidesteps that entirely instead of chasing each view's
          // layout.
          <div className="flex-shrink-0 border-b border-neutral-200 px-2 py-1.5 md:hidden">
            <button
              onClick={openMobileNav}
              className="rounded p-1.5 text-neutral-600 hover:bg-neutral-100"
              aria-label="Open menu"
            >
              ☰
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {tab === "games" ? (
            currentLobby ? (
              <LobbyRoom
                lobby={currentLobby}
                currentUserId={user.id}
                friends={friends}
                chatMessages={messagesByConversation[currentLobby.conversation_id] ?? []}
                onSendChat={(content) => sendMessage(currentLobby.conversation_id, content)}
                onReady={(isReady) => setReady(currentLobby.id, isReady)}
                onStart={() => startLobby(currentLobby.id)}
                onLeave={() => leaveLobby(currentLobby.id)}
                onRestart={() => restartLobby(currentLobby.id)}
                onKick={(userId) => kickFromLobby(currentLobby.id, userId)}
                onTransferLeader={(userId) => transferLeader(currentLobby.id, userId)}
                onRename={(name) => renameLobby(currentLobby.id, name)}
                onPlayVsAi={(skillLevel, preferredColor) => playVsAi(currentLobby.id, skillLevel, preferredColor)}
                onSetChessColorChoice={(preferredColor) => setChessColorChoice(currentLobby.id, preferredColor)}
                onInviteFriend={(userId) => inviteToLobby(currentLobby.id, userId)}
                onGetInviteCode={() => getInviteCode(currentLobby.id)}
                onGameFinished={() => finishGame(currentLobby.id)}
                gameTracksCompletion={catalog.find((g) => g.key === currentLobby.game_key)?.tracks_completion ?? false}
              />
            ) : (
              <div className="hidden h-full items-center justify-center text-neutral-400 md:flex">
                Host a game or pick one of your lobbies
              </div>
            )
          ) : selected ? (
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
        </div>
      </main>
    </div>
  );
}
