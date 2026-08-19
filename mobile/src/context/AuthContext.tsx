import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import * as authApi from "../api/auth";
import { clearStoredAuth, getStoredAuth, setStoredAuth } from "../api/client";
import type { User } from "../types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  register: (input: {
    username: string;
    email: string;
    password: string;
    display_name: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const stored = await getStoredAuth();
      if (!stored) {
        setLoading(false);
        return;
      }
      try {
        setUser(await authApi.me());
      } catch {
        await clearStoredAuth();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function login(identifier: string, password: string) {
    const tokens = await authApi.login({ identifier, password });
    await setStoredAuth(tokens);
    const profile = await authApi.me();
    setUser(profile);
  }

  async function register(input: {
    username: string;
    email: string;
    password: string;
    display_name: string;
  }) {
    await authApi.register(input);
    await login(input.username, input.password);
  }

  async function logout() {
    const stored = await getStoredAuth();
    if (stored) {
      await authApi.logout(stored.refresh_token).catch(() => undefined);
    }
    await clearStoredAuth();
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
