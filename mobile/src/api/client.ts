import axios, { type InternalAxiosRequestConfig } from "axios";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { TokenResponse } from "../types";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL as string;
const API_KEY = process.env.EXPO_PUBLIC_API_KEY as string;

const AUTH_STORAGE_KEY = "cheddar.auth";

export interface StoredAuth {
  access_token: string;
  refresh_token: string;
}

export async function getStoredAuth(): Promise<StoredAuth | null> {
  const raw = await AsyncStorage.getItem(AUTH_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as StoredAuth) : null;
}

export async function setStoredAuth(tokens: TokenResponse): Promise<void> {
  await AsyncStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ access_token: tokens.access_token, refresh_token: tokens.refresh_token }),
  );
}

export async function clearStoredAuth(): Promise<void> {
  await AsyncStorage.removeItem(AUTH_STORAGE_KEY);
}

export const apiKey = API_KEY;
export const apiBaseUrl = API_BASE_URL;

export const api = axios.create({
  baseURL: `${API_BASE_URL}/api/v1`,
});

api.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  config.headers.set("X-API-Key", API_KEY);
  const auth = await getStoredAuth();
  if (auth) {
    config.headers.set("Authorization", `Bearer ${auth.access_token}`);
  }
  return config;
});

let refreshPromise: Promise<StoredAuth | null> | null = null;

async function refreshAccessToken(): Promise<StoredAuth | null> {
  const auth = await getStoredAuth();
  if (!auth) return null;

  try {
    const response = await axios.post<TokenResponse>(
      `${API_BASE_URL}/api/v1/auth/refresh`,
      { refresh_token: auth.refresh_token },
      { headers: { "X-API-Key": API_KEY } },
    );
    await setStoredAuth(response.data);
    return getStoredAuth();
  } catch {
    await clearStoredAuth();
    return null;
  }
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry && (await getStoredAuth())) {
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
