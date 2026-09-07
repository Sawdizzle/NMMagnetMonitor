"use client";

// Types and small UI shared by more than one admin panel.
//
// app/admin/page.tsx was 2,388 lines holding 66 pieces of state, and passed 52
// props into a single child. Every keystroke in the add-asset form re-rendered
// the whole thing — six tabs' worth of definitions — and, more to the point, it
// was the one file in an otherwise well-factored codebase whose structure
// fought every change made to it.
//
// It is now a shell that owns the tab, the shared data and the dialogs; each
// tab owns its own form state. What lives HERE is only what genuinely crosses
// panels: the row types the shell loads and the panels render, the toast and
// modal plumbing every panel raises, and two form controls used by more than
// one of them. Nothing was rewritten in the split — the code moved.

import { useState } from "react";

export type AppUser = {
  username: string;
  role: "viewer" | "engineer" | "admin";
  tv_access: boolean;
  docs_access: boolean;
  created_at: string;
};
export type AuditEntry = {
  id: number;
  actor: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: string | null;
  created_at: string;
};
export type AlertRule = {
  id: string;
  asset_id: string | null;
  asset_name: string | null;
  field: string;
  comparator: string;
  threshold: number;
  enabled: boolean;
  created_at: string;
};
export type AlertRecipient = {
  id: string;
  channel: "email" | "sms";
  address: string;
  enabled: boolean;
  created_at: string;
};
export type AlertEventRow = {
  id: number;
  asset_id: string;
  asset_name: string;
  kind: string;
  message: string;
  triggered_at: string;
  resolved_at: string | null;
  notified_at: string | null;
};

export type Toast = { msg: string; kind: "success" | "error" };
export type ConfirmReq = { message: string; danger?: boolean; resolve: (ok: boolean) => void };
export type PromptReq = {
  title: string;
  label: string;
  minLength?: number;
  resolve: (value: string | null) => void;
};


/* -------------------------------------------------------- Toast + dialogs UI */

export function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const border = toast.kind === "error" ? "var(--status-offline)" : "var(--accent)";
  return (
    <div
      role="status"
      aria-live="polite"
      onClick={onDismiss}
      className="fixed bottom-6 right-6 z-50 max-w-sm rounded-lg border bg-[var(--card)] px-4 py-3 text-sm shadow-lg cursor-pointer"
      style={{ borderColor: border }}
    >
      <span style={{ color: border }} className="font-medium">{toast.kind === "error" ? "Error" : "Done"}</span>
      <span className="mx-2 text-[var(--text-dim)]">·</span>
      <span className="text-[var(--text)]">{toast.msg}</span>
    </div>
  );
}

export function ModalShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "color-mix(in srgb, black 55%, transparent)" }}>
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-xl">{children}</div>
    </div>
  );
}

export function ConfirmModal({ req, onDone }: { req: ConfirmReq; onDone: (ok: boolean) => void }) {
  return (
    <ModalShell>
      <p className="text-sm text-[var(--text)] mb-5">{req.message}</p>
      <div className="flex justify-end gap-2">
        <button onClick={() => onDone(false)} className="btn-secondary">Cancel</button>
        <button
          onClick={() => onDone(true)}
          className="btn-primary"
          style={req.danger ? { background: "var(--status-offline)", color: "#fff" } : undefined}
          autoFocus
        >
          Confirm
        </button>
      </div>
    </ModalShell>
  );
}

export function PromptModal({ req, onDone }: { req: PromptReq; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState("");
  const tooShort = req.minLength != null && value.length > 0 && value.length < req.minLength;
  const canSubmit = value.length > 0 && !tooShort;
  return (
    <ModalShell>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onDone(value);
        }}
      >
        <h2 className="text-sm font-medium text-[var(--text)] mb-4">{req.title}</h2>
        <Field label={req.label}>
          <input
            autoFocus
            value={value}
            minLength={req.minLength}
            onChange={(e) => setValue(e.target.value)}
            className="input font-mono-data"
          />
        </Field>
        {tooShort && <p className="text-xs mt-1" style={{ color: "var(--status-offline)" }}>Must be at least {req.minLength} characters.</p>}
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={() => onDone(null)} className="btn-secondary">Cancel</button>
          <button type="submit" className="btn-primary" disabled={!canSubmit}>Save</button>
        </div>
      </form>
    </ModalShell>
  );
}


export function formatAuditTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Which collector build this unit is actually running.
 *
 * The whole point is drift: with 14 collectors across 10 hosts, a code change is
 * only as good as the slowest Pi to receive it, and until now nothing recorded
 * which build each was on. NM1035 sat on a months-old pre-batch collector and it
 * was spotted by accident, from the SHAPE of its timestamps.
 *
 * Three states, deliberately distinct:
 *   up to date  - reported version equals what the generator produces now
 *   behind      - reported something older; the script needs redeploying
 *   unknown     - never reported a version at all, which means the script
 *                 predates versioning entirely. Not the same as "fine".
 */

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
      {label}
      {children}
    </label>
  );
}

export function PasswordField({
  label,
  value,
  onChange,
  minLength,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  minLength?: number;
  mono?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
      {label}
      <span className="relative flex items-center">
        <input
          type={show ? "text" : "password"}
          required
          minLength={minLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`input pr-14 ${mono ? "font-mono-data" : ""}`}
        />
        <button
          type="button"
          onClick={() => setShow(!show)}
          className="absolute right-2 text-xs text-[var(--text-dim)] hover:text-[var(--accent)]"
          aria-label={show ? "Hide" : "Show"}
        >
          {show ? "Hide" : "Show"}
        </button>
      </span>
    </label>
  );
}
