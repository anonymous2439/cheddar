import { api } from "./client";
import type { Conversation, Message } from "../types";

export interface PickedFile {
  uri: string;
  name: string;
  mimeType: string;
}

export function createConversation(userId: number) {
  return api.post<Conversation>("/conversations", { user_id: userId }).then((r) => r.data);
}

export function listConversations() {
  return api.get<Conversation[]>("/conversations").then((r) => r.data);
}

export function getMessages(conversationId: number, beforeId?: number) {
  return api
    .get<Message[]>(`/conversations/${conversationId}/messages`, {
      params: beforeId ? { before_id: beforeId } : undefined,
    })
    .then((r) => r.data);
}

export function uploadAttachment(conversationId: number, file: PickedFile, caption?: string) {
  const formData = new FormData();
  // React Native's FormData accepts { uri, name, type } file descriptors instead of a Blob.
  formData.append("file", { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
  if (caption) formData.append("caption", caption);
  return api
    .post<Message>(`/conversations/${conversationId}/attachments`, formData, {
      headers: { "Content-Type": "multipart/form-data" },
    })
    .then((r) => r.data);
}
