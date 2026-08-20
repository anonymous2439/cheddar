import { api } from "./client";
import type { GameCatalogEntry, Lobby } from "../types";

export function listGameCatalog() {
  return api.get<GameCatalogEntry[]>("/games/catalog").then((r) => r.data);
}

export function listMyLobbies() {
  return api.get<Lobby[]>("/games/lobbies").then((r) => r.data);
}

export function getLobby(lobbyId: number) {
  return api.get<Lobby>(`/games/lobbies/${lobbyId}`).then((r) => r.data);
}

export function createLobby(gameKey: string) {
  return api.post<Lobby>("/games/lobbies", { game_key: gameKey }).then((r) => r.data);
}

export function inviteToLobby(lobbyId: number, userId: number) {
  return api.post<Lobby>(`/games/lobbies/${lobbyId}/invite`, { user_id: userId }).then((r) => r.data);
}

export function getInviteCode(lobbyId: number) {
  return api.post<Lobby>(`/games/lobbies/${lobbyId}/invite-code`).then((r) => r.data);
}

export function joinLobbyByCode(inviteCode: string) {
  return api.post<Lobby>("/games/lobbies/join", { invite_code: inviteCode }).then((r) => r.data);
}

export function setReady(lobbyId: number, isReady: boolean) {
  return api.post<Lobby>(`/games/lobbies/${lobbyId}/ready`, { is_ready: isReady }).then((r) => r.data);
}

export function kickFromLobby(lobbyId: number, userId: number) {
  return api.post<Lobby>(`/games/lobbies/${lobbyId}/kick`, { user_id: userId }).then((r) => r.data);
}

export function transferLeader(lobbyId: number, userId: number) {
  return api.post<Lobby>(`/games/lobbies/${lobbyId}/leader`, { user_id: userId }).then((r) => r.data);
}

export function leaveLobby(lobbyId: number) {
  return api.post<Lobby>(`/games/lobbies/${lobbyId}/leave`).then((r) => r.data);
}

export function startLobby(lobbyId: number) {
  return api.post<Lobby>(`/games/lobbies/${lobbyId}/start`).then((r) => r.data);
}

export function restartLobby(lobbyId: number) {
  return api.post<Lobby>(`/games/lobbies/${lobbyId}/restart`).then((r) => r.data);
}
