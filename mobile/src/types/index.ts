export interface User {
  id: number;
  username: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  status: "online" | "offline" | "away";
  created_at: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export interface FriendRequest {
  id: number;
  status: "pending" | "accepted" | "declined";
  direction: "incoming" | "outgoing";
  user: User;
  created_at: string;
  responded_at: string | null;
}

export interface Conversation {
  id: number;
  type: "direct" | "group";
  name: string | null;
  created_at: string;
  updated_at: string;
  participants: User[];
  last_message_id: number | null;
  last_read_message_id: number | null;
}

export interface MessageAttachment {
  url: string;
  filename: string;
  size: number;
  mime_type: string;
}

export interface Message {
  id: number;
  conversation_id: number;
  sender_id: number;
  type: string;
  content: string | null;
  metadata: MessageAttachment | null;
  reply_to_id: number | null;
  edited_at: string | null;
  created_at: string;
}

export type WsEvent =
  | { type: "message.new"; data: Message }
  | { type: "typing"; data: { conversation_id: number; user_id: number; state: "start" | "stop" } }
  | { type: "message.read"; data: { conversation_id: number; user_id: number; message_id: number } }
  | { type: "presence"; data: { user_id: number; status: "online" | "offline" } }
  | { type: "friend_request.accepted"; data: FriendRequest }
  | { type: "error"; data: { message: string } };
