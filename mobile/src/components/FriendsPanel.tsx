import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as friendsApi from "../api/friends";
import type { Conversation, FriendRequest, User } from "../types";

interface Props {
  friends: User[];
  incomingRequests: FriendRequest[];
  outgoingRequests: FriendRequest[];
  onlineUserIds: Set<number>;
  onRefresh: () => Promise<void>;
  onMessageFriend: (userId: number) => Promise<Conversation>;
  onSelectConversation: (conversation: Conversation) => void;
}

export function FriendsPanel({
  friends,
  incomingRequests,
  outgoingRequests,
  onlineUserIds,
  onRefresh,
  onMessageFriend,
  onSelectConversation,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleSearch() {
    if (query.trim().length < 2) return;
    setSearching(true);
    setMessage(null);
    try {
      setResults(await friendsApi.searchUsers(query.trim()));
    } finally {
      setSearching(false);
    }
  }

  async function handleAdd(userId: number) {
    try {
      await friendsApi.sendFriendRequest(userId);
      setMessage("Friend request sent");
      setResults((prev) => prev.filter((u) => u.id !== userId));
      await onRefresh();
    } catch {
      setMessage("Could not send request (maybe already sent, or blocked)");
    }
  }

  async function handleAccept(requestId: number) {
    await friendsApi.acceptFriendRequest(requestId);
    await onRefresh();
  }

  async function handleDecline(requestId: number) {
    await friendsApi.declineFriendRequest(requestId);
    await onRefresh();
  }

  async function handleCancel(requestId: number) {
    await friendsApi.cancelFriendRequest(requestId);
    await onRefresh();
  }

  async function handleMessage(userId: number) {
    const conversation = await onMessageFriend(userId);
    onSelectConversation(conversation);
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Add friend</Text>
        <View style={styles.searchRow}>
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search username..."
            autoCapitalize="none"
            onSubmitEditing={handleSearch}
          />
          <Pressable style={[styles.searchButton, searching && styles.buttonDisabled]} onPress={handleSearch} disabled={searching}>
            <Text style={styles.searchButtonText}>Search</Text>
          </Pressable>
        </View>
        {message && <Text style={styles.hint}>{message}</Text>}
        {results.length > 0 && (
          <View style={styles.list}>
            {results.map((u) => (
              <View key={u.id} style={styles.listRow}>
                <Text style={styles.rowText}>
                  {u.display_name} (@{u.username})
                </Text>
                <Pressable onPress={() => handleAdd(u.id)}>
                  <Text style={styles.link}>Add</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </View>

      {incomingRequests.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Incoming requests</Text>
          <View style={styles.list}>
            {incomingRequests.map((r) => (
              <View key={r.id} style={styles.listRow}>
                <Text style={styles.rowText}>{r.user.display_name}</Text>
                <View style={styles.actionRow}>
                  <Pressable onPress={() => handleAccept(r.id)}>
                    <Text style={styles.linkGreen}>Accept</Text>
                  </Pressable>
                  <Pressable onPress={() => handleDecline(r.id)}>
                    <Text style={styles.linkRed}>Decline</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        </View>
      )}

      {outgoingRequests.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Sent requests</Text>
          <View style={styles.list}>
            {outgoingRequests.map((r) => (
              <View key={r.id} style={styles.listRow}>
                <Text style={styles.rowText}>{r.user.display_name}</Text>
                <Pressable onPress={() => handleCancel(r.id)}>
                  <Text style={styles.linkMuted}>Cancel</Text>
                </Pressable>
              </View>
            ))}
          </View>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Friends</Text>
        {friends.length === 0 && <Text style={styles.hint}>No friends yet.</Text>}
        <View style={styles.list}>
          {friends.map((f) => (
            <View key={f.id} style={styles.listRow}>
              <View style={styles.actionRow}>
                <View style={[styles.dot, onlineUserIds.has(f.id) ? styles.dotOnline : styles.dotOffline]} />
                <Text style={styles.rowText}>{f.display_name}</Text>
              </View>
              <Pressable onPress={() => handleMessage(f.id)}>
                <Text style={styles.link}>Message</Text>
              </Pressable>
            </View>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 12 },
  section: { marginBottom: 16 },
  sectionTitle: { marginBottom: 4, fontSize: 11, fontWeight: "700", textTransform: "uppercase", color: "#737373" },
  searchRow: { flexDirection: "row", gap: 8 },
  searchInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#d4d4d4",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 14,
  },
  searchButton: { backgroundColor: "#f59e0b", borderRadius: 6, paddingHorizontal: 12, justifyContent: "center" },
  buttonDisabled: { opacity: 0.5 },
  searchButtonText: { color: "#fff", fontSize: 14, fontWeight: "500" },
  hint: { marginTop: 4, fontSize: 12, color: "#737373" },
  list: { marginTop: 8, gap: 4 },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 6,
    backgroundColor: "#fafafa",
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  rowText: { fontSize: 14, color: "#262626" },
  actionRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  link: { color: "#d97706", fontSize: 14 },
  linkGreen: { color: "#16a34a", fontSize: 14 },
  linkRed: { color: "#dc2626", fontSize: 14 },
  linkMuted: { color: "#737373", fontSize: 14 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOnline: { backgroundColor: "#22c55e" },
  dotOffline: { backgroundColor: "#d4d4d4" },
});
