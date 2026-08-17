"use client";

import { useCallback, useEffect, useState } from "react";
import {
  adminListDisplayTokens,
  adminCreateDisplayToken,
  adminRevokeDisplayToken,
  type DisplayToken,
} from "@/lib/adminActions";
import { actionError } from "@/lib/errors";

/**
 * Wall displays: long-lived, read-only, revocable credentials for TVs.
 *
 * Before this, a corridor screen ran on a human's 30-day session — it carried
 * that person's identity and access, and dropped to a login form when the
 * session lapsed, usually with nobody watching. A display token is bound to one
 * company, grants only the fleet read, and can be revoked if the TV moves.
 *
 * A company admin sees only their own screens; a superadmin sees all.
 */
export default function DisplaysSection({
  notify,
  fail,
  askConfirm,
}: {
  notify: (m: string) => void;
  fail: (m: string) => void;
  askConfirm: (m: string, danger?: boolean) => Promise<boolean>;
}) {
  const [rows, setRows] = useState<DisplayToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  // Shown once, right after minting — the raw token is never stored, so if it
  // is lost the only remedy is to revoke and mint another.
  const [justCreated, setJustCreated] = useState<{ label: string; url: string } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await adminListDisplayTokens();
    if (error) fail(actionError("Could not load displays", error));
    setRows(data ?? []);
    setLoading(false);
  }, [fail]);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const { data, error } = await adminCreateDisplayToken(label);
    if (error) return fail(actionError("Could not create display", error));
    const token = data?.[0]?.display_token;
    if (token) {
      setJustCreated({
        label,
        url: `${window.location.origin}/tv/display?token=${token}`,
      });
    }
    setLabel("");
    load();
  }

  async function revoke(d: DisplayToken) {
    if (
      !(await askConfirm(
        `Revoke "${d.label}"? That screen will stop showing the fleet immediately and will need a new link.`,
        true
      ))
    ) {
      return;
    }
    const { error } = await adminRevokeDisplayToken(d.id);
    if (error) return fail(actionError("Could not revoke display", error));
    notify(`"${d.label}" revoked.`);
    load();
  }

  if (loading) return <p className="text-sm text-[var(--text-dim)]">Loading displays…</p>;

  return (
    <section className="mb-10">
      <h2 className="text-sm font-semibold mb-1">Wall displays</h2>
      <p className="text-xs text-[var(--text-dim)] mb-4">
        A one-time link for a TV. Open it once on the screen and it stays signed in — no account,
        no 30-day expiry. Read-only, limited to one company, revocable here.
      </p>

      <form
        onSubmit={create}
        className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-5 flex flex-wrap items-end gap-4 mb-4"
      >
        <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)] flex-1 min-w-[16rem]">
          Where is this screen?
          <input
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Corridor TV, Iuka"
            className="input"
          />
        </label>
        <button type="submit" className="btn-primary">
          Create display link
        </button>
      </form>

      {justCreated && (
        <div
          className="rounded-xl border p-4 mb-4"
          style={{ borderColor: "var(--accent)" }}
          role="status"
        >
          <p className="text-sm font-medium mb-1">Open this once on “{justCreated.label}”</p>
          <p className="text-xs text-[var(--text-dim)] mb-2">
            Shown only now — it isn’t stored. If you lose it, revoke the display and create another.
          </p>
          <code className="block text-xs font-mono-data break-all bg-[var(--card)] rounded p-2">
            {justCreated.url}
          </code>
          <div className="flex gap-2 mt-2">
            <button
              className="btn-secondary"
              onClick={() => {
                navigator.clipboard?.writeText(justCreated.url);
                notify("Link copied.");
              }}
            >
              Copy link
            </button>
            <button className="btn-secondary" onClick={() => setJustCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-[var(--border-soft)] overflow-hidden">
        {rows.length === 0 && (
          <p className="px-4 py-3 text-sm text-[var(--text-dim)]">No wall displays yet.</p>
        )}
        {rows.map((d) => (
          <div
            key={d.id}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-[var(--border)] last:border-0"
            style={d.revoked_at ? { opacity: 0.55 } : undefined}
          >
            <div className="min-w-0">
              <p className="font-medium truncate">{d.label}</p>
              <p className="text-xs text-[var(--text-dim)]">
                {d.org_name}
                {d.created_by ? ` · added by ${d.created_by}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs text-[var(--text-dim)]">
              <span
                title={
                  d.last_seen_at
                    ? "Last time this screen asked for fleet data."
                    : "This link has never been opened."
                }
              >
                {d.revoked_at
                  ? "revoked"
                  : d.last_seen_at
                    ? `seen ${new Date(d.last_seen_at).toLocaleString()}`
                    : "never opened"}
              </span>
              {!d.revoked_at && (
                <button
                  onClick={() => revoke(d)}
                  className="btn-secondary"
                  style={{ color: "var(--status-offline)" }}
                >
                  Revoke
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
