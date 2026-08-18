"use client";

import { useCallback, useEffect, useState } from "react";
import {
  adminListDisplayTokens,
  adminCreateDisplayToken,
  adminRevokeDisplayToken,
  adminDeleteDisplayToken,
  adminListOrgs,
  type DisplayToken,
  type OrgRow,
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
 *
 * WHICH company a link is for is a choice, not a side effect of whatever org
 * the admin happens to be switched into. A superadmin runs every tenant's
 * screens from one panel, so making them switch active org, mint, and switch
 * back is both tedious and easy to get wrong — and getting it wrong hangs
 * another company's fleet on a TV in someone's corridor. The picker below
 * mirrors admin_create_display_token exactly: a superadmin may target any
 * company, anyone else only their own.
 */
export default function DisplaysSection({
  notify,
  fail,
  askConfirm,
  isSuperadmin,
  activeOrg,
}: {
  notify: (m: string) => void;
  fail: (m: string) => void;
  askConfirm: (m: string, danger?: boolean) => Promise<boolean>;
  isSuperadmin: boolean;
  activeOrg: { id: string; name: string } | null;
}) {
  const [rows, setRows] = useState<DisplayToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  // Superadmin only: admin_list_orgs refuses anyone else, and anyone else can
  // only mint for their own company anyway, so there would be nothing to pick.
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  // null = "whatever company is being administered". Held as an override rather
  // than seeded into state, so the default tracks the active org without an
  // effect that syncs one piece of state from another.
  const [orgChoice, setOrgChoice] = useState<string | null>(null);
  // Shown once, right after minting — the raw token is never stored, so if it
  // is lost the only remedy is to revoke and mint another. Carries the company
  // as well as the label: the link is company-bound and unlabelled once copied,
  // so this panel is the last chance to notice it was minted for the wrong one.
  const [justCreated, setJustCreated] = useState<{
    label: string;
    org: string;
    url: string;
  } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await adminListDisplayTokens();
    if (error) fail(actionError("Could not load displays", error));
    setRows(data ?? []);
    setLoading(false);
  }, [fail]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!isSuperadmin) return;
    let alive = true;
    adminListOrgs().then(({ data, error }) => {
      if (!alive || error) return;
      setOrgs(data ?? []);
    });
    return () => {
      alive = false;
    };
  }, [isSuperadmin]);

  // Defaults to the company being administered, so the common case — a link for
  // the tenant you are already looking at — needs no interaction, and picking
  // another is a deliberate act rather than an unnoticed default.
  const orgId = orgChoice ?? activeOrg?.id ?? "";
  // Undefined rather than the raw value for non-superadmins: the RPC then falls
  // back to the actor's own org, which is the only one it would accept from
  // them anyway. Sending it explicitly would only add a way to be refused.
  const targetOrgId = isSuperadmin ? orgId || undefined : undefined;
  const targetOrgName =
    orgs.find((o) => o.org_id === targetOrgId)?.name ?? activeOrg?.name ?? "this company";

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const { data, error } = await adminCreateDisplayToken(label, targetOrgId);
    if (error) return fail(actionError("Could not create display", error));
    const token = data?.[0]?.display_token;
    if (token) {
      setJustCreated({
        label,
        org: targetOrgName,
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

  async function remove(d: DisplayToken) {
    // Two different warnings, because these are two different acts. Deleting a
    // revoked link only tidies the list; deleting a live one takes a screen
    // down as well, and the person clicking may not have realised it was live.
    const message = d.revoked_at
      ? `Delete "${d.label}" from the list? It is already revoked, so no screen is affected — this only removes the row.`
      : `Delete "${d.label}"? It is still active: that screen will stop showing the fleet immediately, and the row will be gone rather than listed as revoked.`;
    if (!(await askConfirm(message, true))) return;

    const { error } = await adminDeleteDisplayToken(d.id);
    if (error) return fail(actionError("Could not delete display", error));
    notify(`"${d.label}" deleted.`);
    load();
  }

  if (loading) return <p className="text-sm text-[var(--text-dim)]">Loading displays…</p>;

  return (
    <section className="mb-10">
      <h2 className="text-sm font-semibold mb-1">Wall displays</h2>
      <p className="text-xs text-[var(--text-dim)] mb-4">
        A one-time link for a TV. Open it once on the screen and it stays signed in — no account,
        no 30-day expiry. Read-only, tied to one company, revocable here.
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

        {isSuperadmin ? (
          <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)] min-w-[14rem]">
            Whose fleet should it show?
            <select
              required
              value={orgId}
              onChange={(e) => setOrgChoice(e.target.value)}
              className="input"
            >
              {/* Empty only until the company list arrives; the RPC would fall
                  back to the active org, but submitting a blank picker should
                  not be how that gets decided. */}
              {orgs.length === 0 && <option value="">Loading companies…</option>}
              {orgs.map((o) => (
                <option key={o.org_id} value={o.org_id}>
                  {o.name}
                  {o.is_demo ? " (demo)" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : (
          // Not a disabled picker: a control you cannot use invites the reading
          // that the choice exists and is being withheld. It doesn't — this
          // admin has exactly one company to mint for.
          <p className="text-xs text-[var(--text-dim)] min-w-[14rem]">
            Shows{" "}
            <span className="font-medium text-[var(--text)]">{activeOrg?.name ?? "your company"}</span>
            &rsquo;s fleet.
          </p>
        )}

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
            Shows <span className="font-medium text-[var(--text)]">{justCreated.org}</span>&rsquo;s
            fleet. Shown only now — it isn’t stored. If you lose it, revoke the display and create
            another.
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
                  title="Stop this screen, but keep the row on record"
                >
                  Revoke
                </button>
              )}
              <button
                onClick={() => remove(d)}
                className="btn-secondary"
                style={{ color: "var(--status-offline)" }}
                title={
                  d.revoked_at
                    ? "Remove this row from the list"
                    : "Remove this row — the screen stops immediately"
                }
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
