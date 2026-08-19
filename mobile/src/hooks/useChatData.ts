import { useCallback, useEffect, useRef, useState } from "react";
import * as conversationsApi from "../api/conversations";
import * as friendsApi from "../api/friends";
import { useWebSocket } from "../context/WebSocketContext";
import { useAuth } from "../context/AuthContext";
import type { Conversation, FriendRequest, Message, User } from "../types";

export function useChatData() {
  const { user } = useAuth();
  const { send, subscribe } = useWebSocket();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [friends, setFriends] = useState<User[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<FriendRequest[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<FriendRequest[]>([]);
  const [messagesByConversation, setMessagesByConversation] = useState<Record<number, Message[]>>({});
  const [typingByConversation, setTypingByConversation] = useState<Record<number, Set<number>>>({});
  const [onlineUserIds, setOnlineUserIds] = useState<Set<number>>(new Set());
  const [hasMoreByConversation, setHasMoreByConversation] = useState<Record<number, boolean>>({});
  const [loadingMoreByConversation, setLoadingMoreByConversation] = useState<Record<number, boolean>>({});

  // Matches the backend's default page size — used to infer whether more history exists.
  const HISTORY_PAGE_SIZE = 50;

  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const refreshAll = useCallback(async () => {
    if (!user) return;
    const [convos, friendList, incoming, outgoing] = await Promise.all([
      conversationsApi.listConversations(),
      friendsApi.listFriends(),
      friendsApi.listFriendRequests("incoming"),
      friendsApi.listFriendRequests("outgoing"),
    ]);
    setConversations(convos);
    setFriends(friendList);
    setIncomingRequests(incoming);
    setOutgoingRequests(outgoing);

    // Seed current online/offline status: presence WS events only report *changes*,
    // so without this, friends who were already online before this session connected
    // would show as offline until they happen to reconnect.
    const knownUsers = [...friendList, ...convos.flatMap((c) => c.participants)];
    setOnlineUserIds((prev) => {
      const next = new Set(prev);
      for (const u of knownUsers) {
        if (u.status === "online") next.add(u.id);
        else next.delete(u.id);
      }
      return next;
    });
  }, [user]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    return subscribe((event) => {
      if (event.type === "message.new") {
        const message = event.data;
        setMessagesByConversation((prev) => {
          const existing = prev[message.conversation_id] ?? [];
          if (existing.some((m) => m.id === message.id)) return prev;
          return { ...prev, [message.conversation_id]: [...existing, message] };
        });
        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === message.conversation_id);
          if (idx === -1) return prev;
          const updated = { ...prev[idx], updated_at: message.created_at, last_message_id: message.id };
          const rest = prev.filter((_, i) => i !== idx);
          return [updated, ...rest];
        });
      } else if (event.type === "typing") {
        const { conversation_id, user_id, state } = event.data;
        const key = `${conversation_id}:${user_id}`;
        setTypingByConversation((prev) => {
          const next = new Set(prev[conversation_id] ?? []);
          if (state === "start") next.add(user_id);
          else next.delete(user_id);
          return { ...prev, [conversation_id]: next };
        });

        const existingTimer = typingTimers.current.get(key);
        if (existingTimer) clearTimeout(existingTimer);
        if (state === "start") {
          typingTimers.current.set(
            key,
            setTimeout(() => {
              setTypingByConversation((prev) => {
                const next = new Set(prev[conversation_id] ?? []);
                next.delete(user_id);
                return { ...prev, [conversation_id]: next };
              });
            }, 5000),
          );
        }
      } else if (event.type === "presence") {
        setOnlineUserIds((prev) => {
          const next = new Set(prev);
          if (event.data.status === "online") next.add(event.data.user_id);
          else next.delete(event.data.user_id);
          return next;
        });
      }
    });
  }, [subscribe]);

  const loadHistory = useCallback(async (conversationId: number) => {
    const history = await conversationsApi.getMessages(conversationId);
    setMessagesByConversation((prev) => ({ ...prev, [conversationId]: history }));
    setHasMoreByConversation((prev) => ({ ...prev, [conversationId]: history.length === HISTORY_PAGE_SIZE }));
  }, []);

  const loadMoreHistory = useCallback(
    async (conversationId: number) => {
      if (loadingMoreByConversation[conversationId]) return;
      if (hasMoreByConversation[conversationId] === false) return;

      const oldest = messagesByConversation[conversationId]?.[0];
      if (!oldest) return;

      setLoadingMoreByConversation((prev) => ({ ...prev, [conversationId]: true }));
      try {
        const older = await conversationsApi.getMessages(conversationId, oldest.id);
        setMessagesByConversation((prev) => ({
          ...prev,
          [conversationId]: [...older, ...(prev[conversationId] ?? [])],
        }));
        setHasMoreByConversation((prev) => ({ ...prev, [conversationId]: older.length === HISTORY_PAGE_SIZE }));
      } finally {
        setLoadingMoreByConversation((prev) => ({ ...prev, [conversationId]: false }));
      }
    },
    [messagesByConversation, hasMoreByConversation, loadingMoreByConversation],
  );

  const startConversationWith = useCallback(async (userId: number) => {
    const conversation = await conversationsApi.createConversation(userId);
    setConversations((prev) => (prev.some((c) => c.id === conversation.id) ? prev : [conversation, ...prev]));
    return conversation;
  }, []);

  const sendMessage = useCallback(
    (conversationId: number, content: string) => {
      send("message.send", { conversation_id: conversationId, content });
    },
    [send],
  );

  const sendTyping = useCallback(
    (conversationId: number, state: "start" | "stop") => {
      send("typing", { conversation_id: conversationId, state });
    },
    [send],
  );

  const markRead = useCallback(
    (conversationId: number, messageId: number) => {
      send("message.read", { conversation_id: conversationId, message_id: messageId });
      // Optimistic local update: the server only broadcasts message.read to *other*
      // participants, so our own unread indicator needs to clear immediately here
      // rather than waiting on a round trip that will never come back to us.
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === conversationId);
        if (idx === -1) return prev;
        const current = prev[idx];
        if ((current.last_read_message_id ?? 0) >= messageId) return prev;
        const updated = { ...current, last_read_message_id: messageId };
        return [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
      });
    },
    [send],
  );

  return {
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
  };
}
