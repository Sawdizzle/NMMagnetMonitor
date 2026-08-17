"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { supabase } from "./supabase";
import { loginAction, logoutAction, getSessionAction } from "./authActions";

export type Role = "admin" | "viewer";

// TRANSITIONAL SHAPE. `pin` is still here because app/admin/page.tsx passes it
// to 25 admin RPCs as p_actor_pin. The authoritative session is now the httpOnly
// cookie minted by loginAction — this localStorage copy exists only to keep the
// admin panel working until Phase 3 moves those RPCs to server actions, at which
// point `pin` comes out and the localStorage session goes away entirely.
// See docs/multi-tenant-plan.md.
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
    // instead of waiting on a network round-trip behind a full-screen spinner,
    // then reconcile against the server below.
    setSession(parsed);
    setLoading(false);

    let cancelled = false;
    (async () => {
      try {
        // The cookie session is authoritative now. If it's still live, take
        // role/tvAccess from it so a grant or revoke lands on reload.
        const server = await getSessionAction();
        if (cancelled) return;

        if (server) {
          const fresh: Session = {
            ...parsed,
            username: server.username,
            role: server.role,
            tvAccess: server.tvAccess,
          };
          updateStoredSession(fresh);
          setSession(fresh);
          return;
        }

        // No cookie session: it expired, or this is a browser that logged in
        // before the cookie existed. We still hold username+pin, so re-mint
        // silently rather than bouncing the user to the login form — losing a
        // wall display to a cookie expiry would be a regression.
        const result = await loginAction(parsed.username, parsed.pin);
        if (cancelled) return;

        if ("session" in result) {
          const fresh: Session = {
            ...parsed,
            role: result.session.role,
            tvAccess: result.session.tvAccess,
          };
          updateStoredSession(fresh);
          setSession(fresh);
        } else {
          // Definitive rejection — the PIN changed or the account is gone.
          clearStoredSession();
          setSession(null);
        }
      } catch {
        // Network/transport failure — keep the optimistic session so a flaky
        // connection doesn't bounce the user to the login form.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, pin: string, remember = true) => {
    // Single server round-trip: create_session verifies the PIN, applies the
    // 5-strike lockout, sets the httpOnly cookie and returns the resolved
    // context. Deliberately NOT paired with verify_user_login — running both
    // would record two failed attempts per bad PIN and lock the account after
    // three tries instead of five.
    const result = await loginAction(username, pin, remember);
    if ("error" in result) return result.error;

    const newSession: Session = {
      username,
      pin,
      role: result.session.role,
      tvAccess: result.session.tvAccess,
    };
    writeStoredSession(newSession, remember);
    setSession(newSession);
    // create_session already writes the 'login' audit row, so no
    // log_session_event call here.
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
    // register_user resolves the invite code to an org and creates the
    // membership; now open a real session so the cookie exists and /api/* will
    // answer for the new account.
    const result = await loginAction(username, pin, remember);
    if ("error" in result) return result.error;

    // New accounts have no TV access until an admin grants it.
    const newSession: Session = {
      username,
      pin,
      role: result.session.role,
      tvAccess: result.session.tvAccess,
    };
    writeStoredSession(newSession, remember);
    setSession(newSession);
    return null;
  }, []);

  const logout = useCallback(() => {
    // destroy_session deletes the row (so the token can't be replayed) and
    // writes the 'logout' audit entry, then clears the cookie.
    logoutAction().catch(() => {});
    clearStoredSession();
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
