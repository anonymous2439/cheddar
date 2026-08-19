import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function initNotifications(): Promise<void> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  const { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") {
    await Notifications.requestPermissionsAsync();
  }
}

async function notify(title: string, body: string, data?: Record<string, unknown>): Promise<void> {
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") return;

  await Notifications.scheduleNotificationAsync({
    content: { title, body, data },
    trigger: null,
  });
}

export function notifyNewMessage(senderName: string, content: string, conversationId: number): void {
  notify(senderName, content || "Sent an attachment", { type: "message.new", conversationId });
}

export function notifyFriendRequestAccepted(displayName: string): void {
  notify("Friend request accepted", `${displayName} accepted your friend request`, {
    type: "friend_request.accepted",
  });
}
