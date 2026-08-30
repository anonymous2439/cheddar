import { getStoredAuth } from "./client";

// PokeWorld is its own service (games/pokeworld/api) with no database of its
// own — it only trusts the same Cheddar-issued JWT (verified with Cheddar's
// own secret), same pattern as karirs.ts's karirsWsUrl. No REST client here
// at all: this service is WS-only (see games/pokeworld/api/app/main.py).
const POKEWORLD_API_BASE_URL = import.meta.env.VITE_POKEWORLD_API_BASE_URL as string;

export function pokeWorldWsUrl(): string {
  const auth = getStoredAuth();
  const wsBase = POKEWORLD_API_BASE_URL.startsWith("http")
    ? POKEWORLD_API_BASE_URL.replace(/^http/, "ws")
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${POKEWORLD_API_BASE_URL}`;
  return `${wsBase}/ws?token=${encodeURIComponent(auth?.access_token ?? "")}`;
}
