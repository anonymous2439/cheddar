import { api } from "./client";
import type { Conversation, Message } from "../types";

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

export function uploadAttachment(conversationId: number, file: File, caption?: string) {
  const formData = new FormData();
  formData.append("file", file);
  if (caption) formData.append("caption", caption);
  return api.post<Message>(`/conversations/${conversationId}/attachments`, formData).then((r) => r.data);
}
