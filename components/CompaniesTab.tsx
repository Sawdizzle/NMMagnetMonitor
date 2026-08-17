"use client";

import { useCallback, useEffect, useState } from "react";
import {
  adminListOrgs,
  adminCreateOrg,
  adminUpdateOrg,
  adminSetInviteCode,
  type OrgRow,
} from "@/lib/adminActions";
import { actionError } from "@/lib/errors";

/**
 * Company (tenant) administration. Superadmin only.
 *
 * Creating a company here is what makes onboarding self-serve: a new org gets
 * its own brand strings, its own assets, its own alert recipients and its own
 * invite code, with no deploy involved.
 *
 * Deliberately no delete. A company owns assets, telemetry, alert history and
 * audit rows — `audit_log.org_id` references it, so a plain DELETE fails, and
 * cascading it would erase the record of what was done. Emptying a company
 * first (remove its assets and members) is the honest path, and it should be a
 * considered operation rather than a button next to "Edit".
 */
export default function CompaniesTab({
  notify,
  fail,
}: {
  notify: (m: string) => void;
  fail: (m: string) => void;
}) {
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [inviteCode, setInviteCode] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [eyebrow, setEyebrow] = useState("");
  const [tagline, setTagline] = useState("");
  const [productName, setProductName] = useState("Magnet Monitor");

  const load = useCallback(async () => {
    const { data, error } = await adminListOrgs();
    if (error) fail(actionError("Could not load companies", error));
    setOrgs(data ?? []);
    setLoading(false);
  }, [fail]);

  useEffect(() => {
    load();
  }, [load]);

  function resetForm() {
    setName("");
    setSlug("");
    setEyebrow("");
    setTagline("");
    setProductName("Magnet Monitor");
    setInviteCode("");
    setShowAdd(false);
    setEditingId(null);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await adminCreateOrg({ name, slug, eyebrow, tagline, productName });
    if (error) return fail(actionError("Could not create company", error));
    notify(`"${name}" created. Add its assets and people, then set an invite code.`);
    resetForm();
    load();
  }

  function startEdit(o: OrgRow) {
    setEditingId(o.org_id);
    setInviteCode(o.invite_code ?? "");
    setName(o.name);
    setEyebrow(o.eyebrow);
    setTagline(o.tagline);
    setProductName(o.product_name);
    setShowAdd(false);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    const { error } = await adminUpdateOrg({ orgId: editingId, name, eyebrow, tagline, productName });
    if (error) return fail(actionError("Could not save company", error));

    // Separate call so a company edit can never silently clear the code.
    const original = orgs.find((o) => o.org_id === editingId)?.invite_code ?? "";
    if (inviteCode !== original) {
      const { error: codeErr } = await adminSetInviteCode(inviteCode, editingId);
      if (codeErr) return fail(actionError("Saved, but the invite code did not change", codeErr));
    }
    notify(`"${name}" updated.`);
    resetForm();
    load();
  }

  if (loading) return <p className="text-sm text-[var(--text-dim)]">Loading companies…</p>;

  const editing = orgs.find((o) => o.org_id === editingId);

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-[var(--text-dim)]">
          Each company is a separate tenant: its own assets, people, alert recipients and branding.
        </p>
        <button
          className="btn-primary"
          onClick={() => {
            resetForm();
            setShowAdd((v) => !v);
          }}
        >
          {showAdd ? "Cancel" : "+ Add company"}
        </button>
      </div>

      {(showAdd || editing) && (
        <form
          onSubmit={editing ? saveEdit : create}
          className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-5 grid gap-4 sm:grid-cols-2 mb-6"
        >
          <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
            Company name
            <input required value={name} onChange={(e) => setName(e.target.value)} className="input" />
          </label>

          {editing ? (
            <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
              URL slug (fixed)
              <input
                value={editing.slug}
                disabled
                className="input opacity-60"
                title="The slug is not editable — default_org_id() and the demo lookup match on it, so changing it would silently re-point them."
              />
            </label>
          ) : (
            <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
              URL slug
              <input
                required
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="riverside-health"
                className="input font-mono-data"
              />
            </label>
          )}

          <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
            Product name (shown in the nav)
            <input value={productName} onChange={(e) => setProductName(e.target.value)} className="input" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
            Eyebrow (above the dashboard heading)
            <input
              value={eyebrow}
              onChange={(e) => setEyebrow(e.target.value)}
              placeholder={name ? `${name} · Remote Monitoring` : "Acme · Remote Monitoring"}
              className="input"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)] sm:col-span-2">
            Tagline (docs + metadata)
            <input value={tagline} onChange={(e) => setTagline(e.target.value)} className="input" />
          </label>

          {editing && (
            <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)] sm:col-span-2">
              Invite code — anyone with it can self-register into this company. Leave empty to close
              self-registration.
              <input
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="(self-registration closed)"
                className="input font-mono-data"
              />
            </label>
          )}

          <div className="sm:col-span-2 flex items-center gap-3">
            <button type="submit" className="btn-primary">
              {editing ? "Save changes" : "Create company"}
            </button>
            <button type="button" className="btn-secondary" onClick={resetForm}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="rounded-xl border border-[var(--border-soft)] overflow-hidden">
        {orgs.map((o) => (
          <div
            key={o.org_id}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-[var(--border)] last:border-0"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-medium truncate">{o.name}</p>
                {o.is_demo && (
                  <span
                    className="demo-badge"
                    title="Demonstration only. /demo reads this company, its assets are simulated, and its alerts are never emailed or pushed."
                  >
                    <span className="cd" aria-hidden="true" />
                    Demo only
                  </span>
                )}
              </div>
              <p className="text-xs text-[var(--text-dim)] font-mono-data">{o.slug}</p>
            </div>
            <div className="flex items-center gap-4 text-xs text-[var(--text-dim)]">
              <span title={o.is_demo ? "Simulated units — not production assets." : undefined}>
                {o.asset_count} {o.is_demo ? "simulated " : ""}asset
                {o.asset_count === 1 ? "" : "s"}
              </span>
              <span>
                {o.member_count} member{o.member_count === 1 ? "" : "s"}
              </span>
              <span title="Anyone with this code can self-register into this company.">
                {o.invite_code ? "invite code set" : "no invite code"}
              </span>
              <button onClick={() => startEdit(o)} className="btn-secondary">
                Edit
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
