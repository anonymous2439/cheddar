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

// A "system_action" message's metadata — a system-posted chat message with
// a button attached. `action` picks which button/behavior to render;
// everything else is whatever that action needs (e.g. Karirs' race replay
// carries race_id/winner). Generic on purpose: this is the first consumer,
// not the only one a system message can ever have.
export interface SystemActionMetadata {
  action: string;
  [key: string]: unknown;
}

export interface Message {
  id: number;
  conversation_id: number;
  sender_id: number;
  type: string;
  content: string | null;
  metadata: MessageAttachment | SystemActionMetadata | null;
  reply_to_id: number | null;
  edited_at: string | null;
  created_at: string;
}

export interface GameCatalogEntry {
  key: string;
  name: string;
  min_players: number;
  max_players: number;
  tracks_completion: boolean;
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

// A single precomputed step of a race — positions get interpolated between
// neighboring steps for smooth motion, but shouting is a discrete "yes/no
// right now" flag (a racer's speed at/above race.py's PEAK_SPEED_THRESHOLD),
// so it's always read off whichever step is currently active, never blended.
export interface KarirsRaceStep {
  positions: Record<string, number>;
  shouting: string[];
}

export interface KarirsRace {
  id: number;
  lobby_id: number;
  racer_names: string[];
  status: "betting_open" | "racing" | "resolved";
  winning_name: string | null;
  // The whole race, precomputed the instant betting closed (index 0 = step
  // 1) — null until then. Clients replay it locally, timed off
  // betting_closes_at, instead of animating from live per-step pushes.
  steps: KarirsRaceStep[] | null;
  // Every racer's catchphrase for this race's roster (see signature_moves.py)
  // — shown when playback.shouting includes their name.
  signature_moves: Record<string, string>;
  // Fixed payout odds per racer, frozen the moment betting opened — a
  // favorite (stronger overall win/loss record) pays less, a longshot pays
  // more. Same numbers used for the actual payout at resolution time.
  payout_multipliers: Record<string, number>;
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

export interface KarirsStepsMessage {
  type: "steps";
  steps: KarirsRaceStep[];
  total_steps: number;
  started_at: string;
}

export interface KarirsResolvedMessage {
  type: "resolved";
  race: KarirsRace;
  standings: string[];
  pool: KarirsPool;
}
