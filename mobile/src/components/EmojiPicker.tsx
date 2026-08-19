import { FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { EMOJI_PICKER_LIST } from "../lib/emoji";

interface Props {
  visible: boolean;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ visible, onSelect, onClose }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.panel} onPress={(e) => e.stopPropagation()}>
          <FlatList
            data={EMOJI_PICKER_LIST}
            keyExtractor={(emoji) => emoji}
            numColumns={8}
            renderItem={({ item: emoji }) => (
              <Pressable
                style={styles.cell}
                onPress={() => {
                  onSelect(emoji);
                  onClose();
                }}
              >
                <Text style={styles.emoji}>{emoji}</Text>
              </Pressable>
            )}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.15)", justifyContent: "flex-end" },
  panel: {
    maxHeight: 280,
    backgroundColor: "#fff",
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    padding: 8,
    borderWidth: 1,
    borderColor: "#e5e5e5",
  },
  cell: { flex: 1 / 8, aspectRatio: 1, alignItems: "center", justifyContent: "center" },
  emoji: { fontSize: 22 },
});
