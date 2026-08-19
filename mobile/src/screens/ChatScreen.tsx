import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  FlatList,
  Image,
  Linking,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import * as DocumentPicker from "expo-document-picker";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useAuth } from "../context/AuthContext";
import { useChatDataContext } from "../context/ChatDataContext";
import { apiBaseUrl } from "../api/client";
import { uploadAttachment } from "../api/conversations";
import { applyEmojiShortcuts } from "../lib/emoji";
import { EmojiPicker } from "../components/EmojiPicker";
import type { RootStackParamList } from "../../App";
import type { Message } from "../types";

type Props = NativeStackScreenProps<RootStackParamList, "ChatDetail">;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ChatScreen({ route, navigation }: Props) {
  const conversation = route.params.conversation;
  const { user } = useAuth();
  const {
    messagesByConversation,
    typingByConversation,
    hasMoreByConversation,
    loadingMoreByConversation,
    loadHistory,
    loadMoreHistory,
    sendMessage,
    sendTyping,
    markRead,
  } = useChatDataContext();

  const currentUserId = user!.id;
  const messages = messagesByConversation[conversation.id] ?? [];
  const hasMore = hasMoreByConversation[conversation.id] ?? false;
  const loadingMore = loadingMoreByConversation[conversation.id] ?? false;
  const typingUserIds = new Set(
    [...(typingByConversation[conversation.id] ?? [])].filter((id) => id !== currentUserId),
  );

  const [draft, setDraft] = useState("");
  const [emojiPickerVisible, setEmojiPickerVisible] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const typingStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMarkedReadId = useRef<number | null>(null);
  const listRef = useRef<FlatList<Message>>(null);
  // Inverted list: content offset 0 is the bottom (latest message).
  const isNearBottomRef = useRef(true);
  const lastMessageIdRef = useRef<number | null>(null);

  const peer = conversation.participants.find((p) => p.id !== currentUserId);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: conversation.name ?? peer?.display_name ?? `Conversation #${conversation.id}`,
    });
  }, [navigation, conversation, peer]);

  useEffect(() => {
    loadHistory(conversation.id);
  }, [conversation.id, loadHistory]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last && last.id !== lastMarkedReadId.current) {
      lastMarkedReadId.current = last.id;
      markRead(conversation.id, last.id);
    }
  }, [messages, conversation.id, markRead]);

  // Reset scroll tracking when switching conversations.
  useEffect(() => {
    lastMessageIdRef.current = null;
    isNearBottomRef.current = true;
    setShowScrollToBottom(false);
  }, [conversation.id]);

  function scrollToBottom(animated: boolean) {
    listRef.current?.scrollToOffset({ offset: 0, animated });
    setShowScrollToBottom(false);
  }

  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const nearBottom = event.nativeEvent.contentOffset.y < 120;
    isNearBottomRef.current = nearBottom;
    if (nearBottom) setShowScrollToBottom(false);
  }

  // Auto-scroll to the latest message when it's our own or we're already at the
  // bottom (Messenger-style); otherwise surface a "scroll to latest" button instead
  // of yanking the view out from under someone reading older messages.
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.id === lastMessageIdRef.current) return;

    const isFirstLoad = lastMessageIdRef.current === null;
    lastMessageIdRef.current = last.id;

    if (isFirstLoad) {
      scrollToBottom(false);
      return;
    }

    if (last.sender_id === currentUserId || isNearBottomRef.current) {
      scrollToBottom(true);
    } else {
      setShowScrollToBottom(true);
    }
  }, [messages, currentUserId]);

  function notifyTyping() {
    sendTyping(conversation.id, "start");
    if (typingStopTimer.current) clearTimeout(typingStopTimer.current);
    typingStopTimer.current = setTimeout(() => sendTyping(conversation.id, "stop"), 1500);
  }

  function handleChangeText(text: string) {
    setDraft(applyEmojiShortcuts(text));
    notifyTyping();
  }

  function insertEmoji(emoji: string) {
    setDraft((prev) => prev + emoji);
    notifyTyping();
  }

  function handleSubmit() {
    const content = draft.trim();
    if (!content) return;
    sendMessage(conversation.id, content);
    setDraft("");
    sendTyping(conversation.id, "stop");
    scrollToBottom(true);
  }

  async function handlePickAttachment() {
    const result = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];

    setUploading(true);
    setUploadError(null);
    try {
      // The upload endpoint creates the message server-side and broadcasts it
      // over the websocket to all participants (including us), so no local
      // state update is needed here — it'll arrive via the same message.new
      // event a text message would.
      await uploadAttachment(conversation.id, {
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType ?? "application/octet-stream",
      });
    } catch {
      setUploadError("Upload failed. File may be too large or an unsupported type.");
    } finally {
      setUploading(false);
    }
  }

  function renderMessage({ item: m }: { item: Message }) {
    const isMine = m.sender_id === currentUserId;
    const attachmentUrl = m.metadata ? `${apiBaseUrl}${m.metadata.url}` : null;

    return (
      <View style={[styles.messageRow, isMine ? styles.messageRowMine : styles.messageRowTheirs]}>
        <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
          {m.type === "image" && attachmentUrl && (
            <Pressable onPress={() => Linking.openURL(attachmentUrl)}>
              <Image source={{ uri: attachmentUrl }} style={styles.attachmentImage} resizeMode="cover" />
            </Pressable>
          )}
          {m.type === "file" && attachmentUrl && m.metadata && (
            <Pressable
              style={[styles.fileChip, isMine ? styles.fileChipMine : styles.fileChipTheirs]}
              onPress={() => Linking.openURL(attachmentUrl)}
            >
              <Text>📄</Text>
              <Text style={[styles.fileChipName, isMine && styles.textMine]} numberOfLines={1}>
                {m.metadata.filename}
              </Text>
              <Text style={[styles.fileChipSize, isMine && styles.textMine]}>{formatBytes(m.metadata.size)}</Text>
            </Pressable>
          )}
          {!!m.content && <Text style={isMine ? styles.textMine : styles.textTheirs}>{m.content}</Text>}
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
      >
        <View style={styles.flex}>
          <FlatList
            ref={listRef}
            data={[...messages].reverse()}
            keyExtractor={(m) => String(m.id)}
            renderItem={renderMessage}
            inverted
            contentContainerStyle={styles.listContent}
            onScroll={handleScroll}
            scrollEventThrottle={16}
            onEndReachedThreshold={0.3}
            onEndReached={() => {
              if (hasMore && !loadingMore) loadMoreHistory(conversation.id);
            }}
            ListFooterComponent={
              loadingMore ? (
                <Text style={styles.paginationHint}>Loading earlier messages...</Text>
              ) : !hasMore && messages.length > 0 ? (
                <Text style={styles.paginationHint}>Beginning of conversation</Text>
              ) : null
            }
          />

          {showScrollToBottom && (
            <Pressable style={styles.scrollToBottomButton} onPress={() => scrollToBottom(true)}>
              <Text style={styles.scrollToBottomText}>↓ New messages</Text>
            </Pressable>
          )}
        </View>

        <View style={styles.statusBar}>
          <Text style={styles.statusText} numberOfLines={1}>
            {uploadError ? uploadError : uploading ? "Uploading..." : typingUserIds.size > 0 ? "Typing..." : ""}
          </Text>
        </View>

        <View style={styles.composer}>
          <Pressable style={styles.iconButton} onPress={() => setEmojiPickerVisible(true)}>
            <Text style={styles.icon}>😊</Text>
          </Pressable>
          <Pressable style={styles.iconButton} onPress={handlePickAttachment} disabled={uploading}>
            <Text style={styles.icon}>📎</Text>
          </Pressable>
          <TextInput
            style={styles.textInput}
            value={draft}
            onChangeText={handleChangeText}
            placeholder="Type a message..."
            multiline
          />
          <Pressable style={styles.sendButton} onPress={handleSubmit}>
            <Text style={styles.sendButtonText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <EmojiPicker
        visible={emojiPickerVisible}
        onSelect={insertEmoji}
        onClose={() => setEmojiPickerVisible(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#fff" },
  flex: { flex: 1 },
  listContent: { padding: 16 },
  paginationHint: { textAlign: "center", fontSize: 12, color: "#a3a3a3", paddingVertical: 8 },
  scrollToBottomButton: {
    position: "absolute",
    bottom: 12,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#171717",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  scrollToBottomText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  messageRow: { marginBottom: 8, flexDirection: "row" },
  messageRowMine: { justifyContent: "flex-end" },
  messageRowTheirs: { justifyContent: "flex-start" },
  bubble: { maxWidth: "85%", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleMine: { backgroundColor: "#f59e0b" },
  bubbleTheirs: { backgroundColor: "#f5f5f5" },
  textMine: { color: "#fff", fontSize: 14 },
  textTheirs: { color: "#171717", fontSize: 14 },
  attachmentImage: { width: 220, height: 220, borderRadius: 6, marginBottom: 4 },
  fileChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 4,
  },
  fileChipMine: { borderColor: "#fcd34d" },
  fileChipTheirs: { borderColor: "#d4d4d4" },
  fileChipName: { flexShrink: 1, fontSize: 13, color: "#171717" },
  fileChipSize: { fontSize: 11, opacity: 0.7 },
  statusBar: { height: 20, paddingHorizontal: 16, justifyContent: "center" },
  statusText: { fontSize: 12, color: "#737373" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: "#e5e5e5",
    padding: 12,
  },
  iconButton: {
    height: 40,
    width: 40,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#d4d4d4",
    borderRadius: 6,
  },
  icon: { fontSize: 18 },
  textInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#d4d4d4",
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    maxHeight: 100,
  },
  sendButton: { backgroundColor: "#f59e0b", borderRadius: 6, paddingHorizontal: 16, paddingVertical: 10 },
  sendButtonText: { color: "#fff", fontSize: 14, fontWeight: "600" },
});
