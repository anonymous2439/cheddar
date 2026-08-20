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

export interface GameCatalogEntry {
  key: string;
  name: string;
  min_players: number;
  max_players: number;
}

export interface LobbyParticipant {
  user: User;
  is_ready: boolean;
  is_leader: boolean;
  joined_at: string;
}

export interface Lobby {
  id: number;
  conversation_id: number;
  game_key: string;
  game_name: string;
  status: "waiting" | "in_progress" | "finished";
  leader_id: number | null;
  invite_code: string | null;
  participants: LobbyParticipant[];
  created_at: string;
  updated_at: string;
  started_at: string | null;
}

export type WsEvent =
  | { type: "message.new"; data: Message }
  | { type: "typing"; data: { conversation_id: number; user_id: number; state: "start" | "stop" } }
  | { type: "message.read"; data: { conversation_id: number; user_id: number; message_id: number } }
  | { type: "presence"; data: { user_id: number; status: "online" | "offline" } }
  | { type: "error"; data: { message: string } }
  | { type: "lobby.updated"; data: Lobby }
  | { type: "lobby.invited"; data: Lobby }
  | { type: "lobby.kicked"; data: { lobby_id: number } }
  | { type: "game.started"; data: { lobby_id: number; game_key: string; game_name: string } };

// Karirs game API — a separate service (games/karirs/api), not the main
// Cheddar API. See its RaceOut/BetOut/WalletOut schemas.
export interface KarirsWallet {
  user_id: number;
  coins: number;
}

export interface KarirsRace {
  id: number;
  lobby_id: number;
  racer_names: string[];
  status: "betting_open" | "racing" | "resolved";
  winning_name: string | null;
  created_by: number;
  created_at: string;
  betting_closes_at: string;
  resolved_at: string | null;
}

export interface KarirsBet {
  id: number;
  race_id: number;
  user_id: number;
  racer_name: string;
  wager: number;
  payout: number | null;
  created_at: string;
}

export type KarirsPool = Record<string, number>;

export interface KarirsStepMessage {
  type: "step";
  step: number;
  total_steps: number;
  positions: Record<string, number>;
}

export interface KarirsResolvedMessage {
  type: "resolved";
  race: KarirsRace;
  standings: string[];
  pool: KarirsPool;
}
