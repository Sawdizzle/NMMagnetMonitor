"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Protected from "@/components/Protected";
import { useAuth } from "@/lib/auth";
import type { Session } from "@/lib/auth";

export default function AccountPage() {
  return <Protected>{(session) => <AccountPanel session={session} />}</Protected>;
}

function AccountPanel({ session }: { session: Session }) {
  const router = useRouter();
  const { changeUsername, changePin, logout } = useAuth();
  const [status, setStatus] = useState<string | null>(null);

  const [newName, setNewName] = useState(session.username);
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");

  async function handleNameChange(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    const err = await changeUsername(newName);
    setStatus(err ? `Error: ${err}` : "Display name updated.");
  }

  async function handlePinChange(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    const err = await changePin(oldPin, newPin);
    if (err) {
      setStatus(`Error: ${err}`);
      return;
    }
    setStatus("PIN updated.");
    setOldPin("");
    setNewPin("");
  }

  function handleSignOut() {
    logout();
    router.push("/");
  }

  return (
    <div id="main-content" className="min-h-screen p-6 md:p-10 max-w-lg mx-auto" role="main">
      <Link href="/" className="text-xs text-[var(--text-dim)] hover:text-[var(--accent)]">
        &larr; Back to dashboard
      </Link>
      <h1 className="text-2xl font-semibold mt-4 mb-1">Account</h1>
      <p className="text-xs text-[var(--text-dim)] mb-8">
        Signed in as {session.username} &middot; {session.role}
      </p>

      {status && (
        <p className="mb-6 text-sm font-mono-data rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2" role="status" aria-live="polite">
          {status}
        </p>
      )}

      <form onSubmit={handleNameChange} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 flex flex-col gap-3 mb-6">
        <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)]">Change username</h2>
        <Field label="New username">
          <input required value={newName} onChange={(e) => setNewName(e.target.value)} className="input" />
        </Field>
        <button type="submit" className="btn-primary">Save</button>
      </form>

      <form onSubmit={handlePinChange} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 flex flex-col gap-3 mb-6">
        <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)]">Change PIN</h2>
        <Field label="Current PIN">
          <input
            required
            type="password"
            inputMode="numeric"
            value={oldPin}
            onChange={(e) => setOldPin(e.target.value)}
            className="input font-mono-data tracking-widest"
          />
        </Field>
        <Field label="New PIN (min 4 characters)">
          <input
            required
            minLength={4}
            type="password"
            inputMode="numeric"
            value={newPin}
            onChange={(e) => setNewPin(e.target.value)}
            className="input font-mono-data tracking-widest"
          />
        </Field>
        <button type="submit" className="btn-primary">Update PIN</button>
      </form>

      <button onClick={handleSignOut} className="btn-secondary w-full">
        Sign out
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
      {label}
      {children}
    </label>
  );
}
