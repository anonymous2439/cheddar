import axios, { type InternalAxiosRequestConfig } from "axios";
import type { TokenResponse } from "../types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;
const API_KEY = import.meta.env.VITE_API_KEY as string;

const AUTH_STORAGE_KEY = "cheddar.auth";

export interface StoredAuth {
  access_token: string;
  refresh_token: string;
}

export function getStoredAuth(): StoredAuth | null {
  const raw = localStorage.getItem(AUTH_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as StoredAuth) : null;
}

export function setStoredAuth(tokens: TokenResponse): void {
  localStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ access_token: tokens.access_token, refresh_token: tokens.refresh_token }),
  );
}

export function clearStoredAuth(): void {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

export const apiKey = API_KEY;
export const apiBaseUrl = API_BASE_URL;

export const api = axios.create({
  baseURL: `${API_BASE_URL}/api/v1`,
});

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  config.headers.set("X-API-Key", API_KEY);
  const auth = getStoredAuth();
  if (auth) {
    config.headers.set("Authorization", `Bearer ${auth.access_token}`);
  }
  return config;
});

let refreshPromise: Promise<StoredAuth | null> | null = null;

async function refreshAccessToken(): Promise<StoredAuth | null> {
  const auth = getStoredAuth();
  if (!auth) return null;

  try {
    const response = await axios.post<TokenResponse>(
      `${API_BASE_URL}/api/v1/auth/refresh`,
      { refresh_token: auth.refresh_token },
      { headers: { "X-API-Key": API_KEY } },
    );
    setStoredAuth(response.data);
    return getStoredAuth();
  } catch {
    clearStoredAuth();
    return null;
  }
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry && getStoredAuth()) {
      originalRequest._retry = true;

      if (!refreshPromise) {
        refreshPromise = refreshAccessToken().finally(() => {
          refreshPromise = null;
        });
      }
      const refreshed = await refreshPromise;

      if (refreshed) {
        originalRequest.headers["Authorization"] = `Bearer ${refreshed.access_token}`;
        return api(originalRequest);
      }
    }
    return Promise.reject(error);
  },
);
