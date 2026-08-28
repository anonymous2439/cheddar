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
  // Which clients have a playable UI for this game — filter "Host a game"
  // against this so we don't offer to host something with no web client.
  platforms: string[];
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
  // Display name for this lobby's chat — defaults to "{game_name} lobby",
  // renameable by the leader. Always populated, never null.
  name: string;
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
  | { type: "game.started"; data: { lobby_id: number; game_key: string; game_name: string } }
  | { type: "chess.move"; data: ChessState }
  | { type: "beats.session_started"; data: BeatsState }
  | { type: "beats.standing"; data: BeatsStandingOut }
  | { type: "mtg.state"; data: MtgState };

// Chess — lives in the main Cheddar API (app/models/chess_game.py), not a
// separate game microservice like Karirs. Server (python-chess) is the sole
// authority on legal moves and game-end conditions; the client's own
// chess.js instance is only ever used for immediate drag-and-drop UX.
export interface ChessState {
  lobby_id: number;
  fen: string;
  moves: string[];
  moves_san: string[];
  turn: "white" | "black";
  white_user_id: number;
  black_user_id: number;
  status: "in_progress" | "checkmate" | "stalemate" | "draw" | "resigned";
  winner_user_id: number | null;
  is_check: boolean;
  // None for a human-vs-human game — set (0-20) when black is the
  // Stockfish bot.
  ai_skill_level: number | null;
  created_at: string;
  updated_at: string;
}

// Karirs game API — a separate service (games/karirs/api), not the main
// Cheddar API. See its RaceOut/BetOut/WalletOut schemas.
export interface KarirsWallet {
  user_id: number;
  coins: number;
  daily_bonus_available: boolean;
}

// The 10 biggest wagers that ever actually won, ranked by wager size (not
// payout) — see games/karirs/api/app/schemas.py's HallOfFameEntryOut.
export interface KarirsHallOfFameEntry {
  display_name: string;
  racer_name: string;
  wager: number;
  payout: number;
  created_at: string;
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

// Cheddar Beats — lives in the main Cheddar API (app/models/beats_*.py),
// same reasoning as chess: no separate wallet/economy, so no need for a
// dedicated microservice like Karirs has.
//
// Players don't share one synchronized note timeline — each independently
// cycles level 1→9→1... at their own pace, pressing a level-length key
// sequence then timing a spacebar press against a sliding gauge — so the
// live leaderboard just updates continuously as each player's own attempts
// land, with no barrier/waiting on anyone else (see beats.py's
// submit_attempt).
export type BeatsJudgment = "miss" | "bad" | "cool" | "great" | "perfect";

export interface BeatsStandingEntry {
  user_id: number;
  score: number;
  rank: number;
}

export interface BeatsState {
  lobby_id: number;
  mode: "4key" | "8key";
  // Host-chosen at session creation, fixed for the whole match — bpm drives
  // the gauge's sweep speed, pulse_count how many times the target circle's
  // heartbeat glow pulses over one round's sweep.
  bpm: number;
  pulse_count: number;
  // The shared match-clock anchor — every client counts its own 60s window
  // down from this same server timestamp (like Karirs' betting_closes_at),
  // so everyone's match ends at the same wall-clock moment even though each
  // player's own level/round progress differs.
  started_at: string;
  duration_seconds: number;
  standings: BeatsStandingEntry[];
}

export interface BeatsRound {
  level: number;
  mode: "4key" | "8key";
  sequence: string[];
  move_name: string;
}

export interface BeatsAttemptAck {
  judgment: BeatsJudgment;
  points: number;
  total_score: number;
  // Consecutive-perfect streak length after this attempt (0 once broken).
  // The multiplier is this value once it reaches 2+.
  chain: number;
  // Effective multiplier actually applied to this attempt's points (chain
  // multiplier, times 1.1 on top if Reverse Mode was active).
  multiplier: number;
  rev_active: boolean;
}

export interface BeatsStandingOut {
  lobby_id: number;
  standings: BeatsStandingEntry[];
}

// Cheddar MTG — no rules engine. The server only owns zones (library/hand/
// battlefield/graveyard/exile), turn/phase structure, and per-viewer hidden
// info (a card's name/image_url come back null when it's in someone else's
// hand) — players read their own cards and self-apply them, same honor
// system Cockatrice/Tabletop Simulator use.
export type MtgZone = "library" | "hand" | "battlefield" | "graveyard" | "exile";

export const MTG_PHASES = [
  "untap",
  "upkeep",
  "draw",
  "main1",
  "combat_begin",
  "attackers",
  "blockers",
  "damage",
  "combat_end",
  "main2",
  "end",
  "cleanup",
] as const;
export type MtgPhase = (typeof MTG_PHASES)[number];

export interface MtgCard {
  id: string;
  // null when this card is in an opponent's hand, or a face-down
  // battlefield permanent viewed by anyone but its owner — the client
  // renders a card-back placeholder instead of the real name/image.
  name: string | null;
  image_url: string | null;
  tapped: boolean;
  counters: Record<string, number>;
  x: number;
  y: number;
  // Battlefield-only. Sent even when hidden, so the client can tell "face
  // down" apart from "someone else's hand".
  face_down: boolean;
}

export interface MtgPlayerState {
  user_id: number;
  life: number;
  library_count: number;
  hand: MtgCard[];
  battlefield: MtgCard[];
  graveyard: MtgCard[];
  exile: MtgCard[];
}

export interface MtgState {
  lobby_id: number;
  turn_number: number;
  active_user_id: number;
  phase: MtgPhase;
  status: "in_progress" | "finished";
  winner_user_id: number | null;
  // The fixed reference seat battlefield (x, y) is stored relative to — the
  // client rotates the board 180° for whichever viewer isn't this player
  // (both x and y flip), so each player always sees their own side at the
  // bottom, the way two people facing each other across a table would.
  player1_user_id: number;
  players: MtgPlayerState[];
}

export interface MtgDeckImportResult {
  card_count: number;
  unresolved_names: string[];
}

export interface MtgDeckStatusEntry {
  user_id: number;
  card_count: number;
}

export interface MtgDeckStatusOut {
  players: MtgDeckStatusEntry[];
}
