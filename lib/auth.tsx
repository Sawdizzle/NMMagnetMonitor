"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { supabase } from "./supabase";

export type Role = "admin" | "viewer";
export type Session = { username: string; pin: string; role: Role; tvAccess: boolean };

const SESSION_KEY = "nm_session";

type AuthContextValue = {
  session: Session | null;
  loading: boolean;
  login: (username: string, pin: string, remember?: boolean) => Promise<string | null>; // returns error message or null
  register: (inviteCode: string, username: string, pin: string, remember?: boolean) => Promise<string | null>;
  logout: () => void;
  changePin: (oldPin: string, newPin: string) => Promise<string | null>;
  changeUsername: (newUsername: string) => Promise<string | null>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

// Session storage helpers.
//   remember = true  -> localStorage, survives closing the tab/browser
//   remember = false -> sessionStorage, cleared when the tab closes
// Reads check both so an existing session is found regardless of how it was
// stored, and every write clears the other store to avoid a stale duplicate.
function readStoredSession(): Session | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(SESSION_KEY) ?? window.sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    clearStoredSession();
    return null;
  }
}

function writeStoredSession(session: Session, remember: boolean) {
  if (typeof window === "undefined") return;
  const target = remember ? window.localStorage : window.sessionStorage;
  const other = remember ? window.sessionStorage : window.localStorage;
  target.setItem(SESSION_KEY, JSON.stringify(session));
  other.removeItem(SESSION_KEY);
}

// Update the stored session in place, keeping it in whichever store already
// holds it (used after a PIN/username change, where "remember" isn't re-asked).
function updateStoredSession(session: Session) {
  writeStoredSession(session, typeof window !== "undefined" && window.localStorage.getItem(SESSION_KEY) != null);
}

function clearStoredSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_KEY);
  window.sessionStorage.removeItem(SESSION_KEY);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const parsed = readStoredSession();
    if (!parsed) {
      setLoading(false);
      return;
    }

    // Show the stored session immediately so the app is interactive on load
    // instead of waiting on a network round-trip behind a full-screen spinner.
    // Data access is governed by RLS on the server, so this client-side gate is
    // UX only — re-verify the credentials in the background and drop the
    // session if they're no longer valid.
    setSession(parsed);
    setLoading(false);

    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc("verify_user_login", {
          p_username: parsed.username,
          p_pin: parsed.pin,
        });
        // Only sign out on a definitive rejection (valid response, no match).
        // A transport error (offline, timeout) leaves the optimistic session in
        // place so a flaky connection doesn't bounce the user to the login form.
        if (!cancelled && !error && (!data || !data[0])) {
          clearStoredSession();
          setSession(null);
        } else if (!cancelled && !error && data && data[0]) {
          // Refresh role + TV access from the server so a grant/revoke (or an
          // older stored session missing tvAccess) takes effect on reload.
          const fresh: Session = {
            ...parsed,
            role: data[0].role as Role,
            tvAccess: !!data[0].tv_access,
          };
          updateStoredSession(fresh);
          setSession(fresh);
        }
      } catch {
        // Network/transport failure — keep the optimistic session.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, pin: string, remember = true) => {
    const { data, error } = await supabase.rpc("verify_user_login", { p_username: username, p_pin: pin });
    if (error || !data || !data[0]) {
      // Record the failed attempt (best-effort; its own transaction so it
      // isn't rolled back with verify_user_login's raise).
      supabase.rpc("record_login_failure", { p_username: username }).then(() => {});
      return error?.message ?? "Invalid username or PIN";
    }
    const newSession: Session = { username, pin, role: data[0].role, tvAccess: !!data[0].tv_access };
    writeStoredSession(newSession, remember);
    setSession(newSession);
    supabase.rpc("log_session_event", { p_username: username, p_pin: pin, p_event: "login" }).then(() => {});
    return null;
  }, []);

  const register = useCallback(async (inviteCode: string, username: string, pin: string, remember = true) => {
    const { data, error } = await supabase.rpc("register_user", {
      p_invite_code: inviteCode,
      p_username: username,
      p_pin: pin,
    });
    if (error || !data || !data[0]) {
      return error?.message ?? "Could not create account";
    }
    // New accounts have no TV access until an admin grants it.
    const newSession: Session = { username, pin, role: data[0].role, tvAccess: false };
    writeStoredSession(newSession, remember);
    setSession(newSession);
    supabase.rpc("log_session_event", { p_username: username, p_pin: pin, p_event: "login" }).then(() => {});
    return null;
  }, []);

  const logout = useCallback(() => {
    if (session) {
      // Log the sign-out while we still hold valid credentials, then clear.
      supabase
        .rpc("log_session_event", { p_username: session.username, p_pin: session.pin, p_event: "logout" })
        .then(() => {});
    }
    clearStoredSession();
    setSession(null);
  }, [session]);

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
      updateStoredSession(updated);
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
      updateStoredSession(updated);
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
