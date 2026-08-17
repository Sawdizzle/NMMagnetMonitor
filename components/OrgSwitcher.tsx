"use client";

import { useCallback, useEffect, useState } from "react";
import { listSwitchableOrgs, switchOrgAction, type SwitchableOrg } from "@/lib/authActions";

/**
 * Organization switcher for the nav.
 *
 * Renders nothing at all when the caller can only reach one org, which is the
 * normal case for a single-company deployment — Numed's users should not see
 * tenancy chrome that means nothing to them. It appears only for people who
 * genuinely hold several memberships, and for superadmins.
 *
 * The switch is a server action that flips user_sessions.active_org, so it
 * changes what EVERY subsequent query returns, not just this component's view.
 *
 * It finishes with a full document reload, NOT router.refresh(). That was the
 * first attempt and it is not enough: Dashboard, AssetDetail and TvWall are
 * client components that fetch /api/* on their own setInterval, so
 * router.refresh() re-rendered the server tree and updated the org label while
 * the fleet kept showing the PREVIOUS tenant's assets until the next poll —
 * one company's data sitting under another company's name, which is the exact
 * confusion this control exists to prevent. A reload re-runs every fetch under
 * the new org at once.
 */
export default function OrgSwitcher() {
  const [orgs, setOrgs] = useState<SwitchableOrg[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listSwitchableOrgs()
      .then((rows) => {
        if (!cancelled) setOrgs(rows);
      })
      // A failure here must not take the nav down with it.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const onChange = useCallback(
    async (orgId: string) => {
      const target = orgs.find((o) => o.orgId === orgId);
      if (!target || target.isActive || busy) return;

      setBusy(true);
      setError(null);
      const message = await switchOrgAction(orgId);
      if (message) {
        // switch_active_org refuses an org the caller isn't a member of. That
        // shouldn't be reachable from this list, so surface it rather than
        // silently reverting — it would mean the list and the check disagree.
        setError(message);
        setBusy(false);
        return;
      }
      // Full reload: the polling client components must re-fetch under the new
      // org, which router.refresh() cannot make them do. Stay "busy" through it
      // so the select can't be changed again mid-navigation.
      window.location.reload();
    },
    [orgs, busy]
  );

  // One org (or none, e.g. signed out) — no switcher.
  if (orgs.length < 2) return null;

  const active = orgs.find((o) => o.isActive);

  return (
    <span className="flex items-center gap-1.5">
      <label className="sr-only" htmlFor="org-switcher">
        Active organization
      </label>
      <select
        id="org-switcher"
        value={active?.orgId ?? ""}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        title={
          error
            ? error
            : `Viewing ${active?.name ?? "—"}. Switching changes the fleet, alerts and admin panel.`
        }
        className="bg-transparent border border-[var(--border-soft)] rounded-md px-1.5 py-0.5 text-xs text-[var(--text-dim)] max-w-[11rem] truncate focus:outline-none focus:border-[var(--accent)] disabled:opacity-50"
        style={error ? { borderColor: "var(--status-offline)" } : undefined}
      >
        {orgs.map((o) => (
          <option key={o.orgId} value={o.orgId}>
            {o.name}
            {o.isDemo ? " (demo)" : ""}
          </option>
        ))}
      </select>
    </span>
  );
}
