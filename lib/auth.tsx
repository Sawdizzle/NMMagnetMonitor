"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { supabase } from "./supabase";

export type Role = "admin" | "viewer";
export type Session = { username: string; pin: string; role: Role };

const SESSION_KEY = "nm_session";

type AuthContextValue = {
  session: Session | null;
  loading: boolean;
  login: (username: string, pin: string) => Promise<string | null>; // returns error message or null
  register: (inviteCode: string, username: string, pin: string) => Promise<string | null>;
  logout: () => void;
  changePin: (oldPin: string, newPin: string) => Promise<string | null>;
  changeUsername: (newUsername: string) => Promise<string | null>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const raw = typeof window !== "undefined" ? sessionStorage.getItem(SESSION_KEY) : null;
    if (raw) {
      try {
        const parsed: Session = JSON.parse(raw);
        // re-verify the stored credentials are still valid
        supabase
          .rpc("verify_user_login", { p_username: parsed.username, p_pin: parsed.pin })
          .then(({ data, error }) => {
            if (!error && data && data[0]) {
              setSession(parsed);
            } else {
              sessionStorage.removeItem(SESSION_KEY);
            }
            setLoading(false);
          });
        return;
      } catch {
        sessionStorage.removeItem(SESSION_KEY);
      }
    }
    setLoading(false);
  }, []);

  const login = useCallback(async (username: string, pin: string) => {
    const { data, error } = await supabase.rpc("verify_user_login", { p_username: username, p_pin: pin });
    if (error || !data || !data[0]) {
      return error?.message ?? "Invalid username or PIN";
    }
    const newSession: Session = { username, pin, role: data[0].role };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(newSession));
    setSession(newSession);
    return null;
  }, []);

  const register = useCallback(async (inviteCode: string, username: string, pin: string) => {
    const { data, error } = await supabase.rpc("register_user", {
      p_invite_code: inviteCode,
      p_username: username,
      p_pin: pin,
    });
    if (error || !data || !data[0]) {
      return error?.message ?? "Could not create account";
    }
    const newSession: Session = { username, pin, role: data[0].role };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(newSession));
    setSession(newSession);
    return null;
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(SESSION_KEY);
    setSession(null);
  }, []);

  const changePin = useCallback(
    async (oldPin: string, newPin: string) => {
      if (!session) return "Not signed in";
      const { error } = await supabase.rpc("reset_own_pin", {
        p_username: session.username,
        p_old_pin: oldPin,
        p_new_pin: newPin,
      });
      if (error) return error.message;
      const updated: Session = { ...session, pin: newPin };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(updated));
      setSession(updated);
      return null;
    },
    [session]
  );

  const changeUsername = useCallback(
    async (newUsername: string) => {
      if (!session) return "Not signed in";
      const { error } = await supabase.rpc("update_own_username", {
        p_username: session.username,
        p_pin: session.pin,
        p_new_username: newUsername,
      });
      if (error) return error.message;
      const updated: Session = { ...session, username: newUsername };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(updated));
      setSession(updated);
      return null;
    },
    [session]
  );

  return (
    <AuthContext.Provider value={{ session, loading, login, register, logout, changePin, changeUsername }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
