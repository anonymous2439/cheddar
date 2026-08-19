import { api } from "./client";
import type { TokenResponse, User } from "../types";

export function register(input: {
  username: string;
  email: string;
  password: string;
  display_name: string;
}) {
  return api.post<User>("/auth/register", input).then((r) => r.data);
}

export function login(input: { identifier: string; password: string }) {
  return api.post<TokenResponse>("/auth/login", input).then((r) => r.data);
}

export function logout(refresh_token: string) {
  return api.post("/auth/logout", { refresh_token });
}

export function me() {
  return api.get<User>("/auth/me").then((r) => r.data);
}
