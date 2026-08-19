import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useAuth } from "../context/AuthContext";
import { useChatDataContext } from "../context/ChatDataContext";
import { ConversationList } from "../components/ConversationList";
import { FriendsPanel } from "../components/FriendsPanel";
import type { RootStackParamList } from "../../App";

type Tab = "conversations" | "friends";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;

export function HomeScreen({ navigation }: Props) {
  const { user, logout } = useAuth();
  const {
    conversations,
    friends,
    incomingRequests,
    outgoingRequests,
    onlineUserIds,
    refreshAll,
    startConversationWith,
  } = useChatDataContext();

  const [tab, setTab] = useState<Tab>("conversations");

  if (!user) return null;

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.name}>{user.display_name}</Text>
          <Text style={styles.username}>@{user.username}</Text>
        </View>
        <Pressable onPress={logout}>
          <Text style={styles.logout}>Log out</Text>
        </Pressable>
      </View>

      <View style={styles.tabs}>
        <Pressable style={styles.tab} onPress={() => setTab("conversations")}>
          <Text style={[styles.tabText, tab === "conversations" && styles.tabTextActive]}>Chats</Text>
          {tab === "conversations" && <View style={styles.tabIndicator} />}
        </Pressable>
        <Pressable style={styles.tab} onPress={() => setTab("friends")}>
          <View style={styles.tabLabelRow}>
            <Text style={[styles.tabText, tab === "friends" && styles.tabTextActive]}>Friends</Text>
            {incomingRequests.length > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{incomingRequests.length}</Text>
              </View>
            )}
          </View>
          {tab === "friends" && <View style={styles.tabIndicator} />}
        </Pressable>
      </View>

      <View style={styles.content}>
        {tab === "conversations" ? (
          <ConversationList
            conversations={conversations}
            currentUserId={user.id}
            onlineUserIds={onlineUserIds}
            onSelect={(conversation) => navigation.navigate("ChatDetail", { conversation })}
          />
        ) : (
          <FriendsPanel
            friends={friends}
            incomingRequests={incomingRequests}
            outgoingRequests={outgoingRequests}
            onlineUserIds={onlineUserIds}
            onRefresh={refreshAll}
            onMessageFriend={startConversationWith}
            onSelectConversation={(conversation) => {
              setTab("conversations");
              navigation.navigate("ChatDetail", { conversation });
            }}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#fff" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e5e5",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  name: { fontSize: 14, fontWeight: "600", color: "#171717" },
  username: { fontSize: 12, color: "#737373" },
  logout: { fontSize: 12, color: "#737373" },
  tabs: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e5e5e5" },
  tab: { flex: 1, alignItems: "center", paddingVertical: 10 },
  tabLabelRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  tabText: { fontSize: 14, color: "#737373" },
  tabTextActive: { fontWeight: "600", color: "#171717" },
  tabIndicator: { position: "absolute", bottom: -1, height: 2, width: "60%", backgroundColor: "#f59e0b" },
  badge: { borderRadius: 8, backgroundColor: "#f59e0b", paddingHorizontal: 6, minWidth: 16, alignItems: "center" },
  badgeText: { fontSize: 11, color: "#fff" },
  content: { flex: 1 },
});
