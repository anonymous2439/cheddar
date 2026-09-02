import axios, { type InternalAxiosRequestConfig } from "axios";
import { getStoredAuth } from "./client";

// Luba is its own service (games/luba/api) with its own in-memory-only
// state — it only trusts the same Cheddar-issued JWT (verified with
// Cheddar's own secret), same as karirs.ts. The only REST call it needs
// is this one: setting a lobby's Timed Deathmatch length before anyone's
// websocket connects (see games/luba/api/app/main.py's POST /matches and
// its own comment on why this has to happen before, not after, the
// generic lobby start).
const LUBA_API_BASE_URL = import.meta.env.VITE_LUBA_API_BASE_URL as string;

export const lubaApi = axios.create({ baseURL: LUBA_API_BASE_URL });

lubaApi.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const auth = getStoredAuth();
  if (auth) config.headers.set("Authorization", `Bearer ${auth.access_token}`);
  return config;
});

export function createLubaMatch(lobbyId: number, durationS: number) {
  return lubaApi.post("/matches", { lobby_id: lobbyId, duration_s: durationS }).then((r) => r.data);
}
