import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { Conversation } from "../types";

interface Props {
  conversations: Conversation[];
  currentUserId: number;
  onSelect: (conversation: Conversation) => void;
  onlineUserIds: Set<number>;
}

function peerOf(conversation: Conversation, currentUserId: number) {
  return conversation.participants.find((p) => p.id !== currentUserId) ?? null;
}

function isUnread(conversation: Conversation) {
  return conversation.last_message_id != null && conversation.last_message_id > (conversation.last_read_message_id ?? 0);
}

export function ConversationList({ conversations, currentUserId, onSelect, onlineUserIds }: Props) {
  if (conversations.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No conversations yet. Message a friend to start one.</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={conversations}
      keyExtractor={(c) => String(c.id)}
      renderItem={({ item: conversation }) => {
        const peer = peerOf(conversation, currentUserId);
        const label = conversation.name ?? peer?.display_name ?? `Conversation #${conversation.id}`;
        const isOnline = peer ? onlineUserIds.has(peer.id) : false;
        const unread = isUnread(conversation);

        return (
          <Pressable style={styles.row} onPress={() => onSelect(conversation)}>
            <View style={[styles.dot, isOnline ? styles.dotOnline : styles.dotOffline]} />
            <Text style={[styles.label, unread && styles.labelUnread]} numberOfLines={1}>
              {label}
            </Text>
            {unread && <View style={styles.unreadDot} />}
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  empty: { padding: 16 },
  emptyText: { fontSize: 14, color: "#737373" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#f5f5f5",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  dotOnline: { backgroundColor: "#22c55e" },
  dotOffline: { backgroundColor: "#d4d4d4" },
  label: { flex: 1, fontSize: 14, color: "#404040" },
  labelUnread: { fontWeight: "600", color: "#171717" },
  unreadDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#f59e0b", flexShrink: 0 },
});
