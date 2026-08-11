"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";

export default function LoginScreen() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result =
      mode === "login"
        ? await login(username, pin, remember)
        : await register(inviteCode, username, pin, remember);
    setSubmitting(false);
    if (result) setError(result);
  }

  return (
    <div id="main-content" className="min-h-screen flex items-center justify-center p-6" role="main">
      <Link
        href="/demo"
        className="demo-link"
        style={{ position: "fixed", top: 16, right: 16 }}
        aria-label="Open the live demo"
      >
        View live demo
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7 17L17 7M17 7H8M17 7v9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Link>
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-xs rounded-xl border border-[var(--border)] bg-[var(--card)] p-6 flex flex-col gap-4"
        aria-label={mode === "login" ? "Sign in" : "Create account"}
      >
        <div>
          <p className="text-xs tracking-[0.2em] uppercase text-[var(--text-dim)] mb-1">
            Numed &middot; Remote Monitoring
          </p>
          <h1 className="text-xl font-semibold">
            {mode === "login" ? "Sign in" : "Create account"}
          </h1>
        </div>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
          Username
          <input
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="input"
            autoFocus
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
          PIN
          <input
            required
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className="input font-mono-data tracking-widest"
          />
        </label>

        {mode === "register" && (
          <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
            Invite code
            <input
              required
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              className="input"
            />
          </label>
        )}

        <label className="flex items-center gap-2 text-xs text-[var(--text-dim)] select-none cursor-pointer">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Keep me signed in on this device
        </label>

        {error && <p className="text-[var(--status-offline)] text-sm" role="alert">{error}</p>}

        <button type="submit" disabled={submitting} className="btn-primary">
          {mode === "login" ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
          className="text-center text-xs text-[var(--text-dim)] hover:text-[var(--accent)]"
        >
          {mode === "login" ? "Need an account? Register with an invite code" : "Already have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
