import axios, { type InternalAxiosRequestConfig } from "axios";
import { getStoredAuth } from "./client";
import type { KarirsBet, KarirsPool, KarirsRace, KarirsWallet } from "../types";

// Karirs is its own service (games/karirs/api) with its own database — it
// only trusts the same Cheddar-issued JWT (verified with Cheddar's own
// secret), it has no login/API-key of its own, so this client only ever
// attaches the bearer token.
const KARIRS_API_BASE_URL = import.meta.env.VITE_KARIRS_API_BASE_URL as string;

export const karirsApi = axios.create({ baseURL: KARIRS_API_BASE_URL });

karirsApi.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const auth = getStoredAuth();
  if (auth) config.headers.set("Authorization", `Bearer ${auth.access_token}`);
  return config;
});

export function karirsWsUrl(raceId: number): string {
  const auth = getStoredAuth();
  const wsBase = KARIRS_API_BASE_URL.startsWith("http")
    ? KARIRS_API_BASE_URL.replace(/^http/, "ws")
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${KARIRS_API_BASE_URL}`;
  return `${wsBase}/races/${raceId}/ws?token=${encodeURIComponent(auth?.access_token ?? "")}`;
}

export function getWallet() {
  return karirsApi.get<KarirsWallet>("/wallet").then((r) => r.data);
}

export function syncRace(lobbyId: number) {
  return karirsApi.post<KarirsRace>("/races", { lobby_id: lobbyId }).then((r) => r.data);
}

export function getRace(raceId: number) {
  return karirsApi.get<KarirsRace>(`/races/${raceId}`).then((r) => r.data);
}

export function getPool(raceId: number) {
  return karirsApi.get<KarirsPool>(`/races/${raceId}/pool`).then((r) => r.data);
}

export function getMyBet(raceId: number) {
  return karirsApi.get<KarirsBet[]>(`/races/${raceId}/bets`).then((r) => r.data);
}

export function placeBet(raceId: number, racerName: string, wager: number) {
  return karirsApi.post<KarirsBet>(`/races/${raceId}/bets`, { racer_name: racerName, wager }).then((r) => r.data);
}
