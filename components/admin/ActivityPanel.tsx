"use client";

// The Activity tab: the org's audit log. Split out of app/admin/page.tsx with
// the three label/colour helpers only it uses.


import { type AuditEntry, formatAuditTime } from "./shared";

/* -------------------------------------------------------------- Activity tab */

export default function ActivityTab({ auditLog, loadAuditLog }: { auditLog: AuditEntry[]; loadAuditLog: () => void }) {
  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-[var(--text-dim)]">
          Sign-ins, sign-outs, failed attempts, and every change made to assets, users, and alert rules.
          Showing the most recent {auditLog.length}.
        </p>
        <button onClick={loadAuditLog} className="btn-secondary">Refresh</button>
      </div>
      <div className="rounded-xl border border-[var(--border-soft)] overflow-hidden">
        {auditLog.map((e) => (
          <div key={e.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 border-b border-[var(--border)] last:border-0">
            <div className="min-w-0">
              <p className="text-sm">
                <span className="font-medium">{e.actor ?? "system"}</span>
                <span className="mx-2 text-[var(--text-dim)]">&middot;</span>
                <span
                  className="text-xs font-mono-data uppercase tracking-wide"
                  style={{ color: auditActionColor(e.action) }}
                >
                  {auditActionLabel(e.action)}
                </span>
              </p>
              {e.detail && <p className="text-xs text-[var(--text-dim)] mt-0.5">{e.detail}</p>}
            </div>
            <p className="text-xs font-mono-data text-[var(--text-dim)] whitespace-nowrap" title={new Date(e.created_at).toLocaleString()}>
              {formatAuditTime(e.created_at)}
            </p>
          </div>
        ))}
        {auditLog.length === 0 && <p className="px-4 py-6 text-center text-[var(--text-dim)]">No activity recorded yet.</p>}
      </div>
    </section>
  );
}



const AUDIT_ACTION_LABELS: Record<string, string> = {
  login: "Signed in",
  logout: "Signed out",
  login_failed: "Failed sign-in",
  // Historical entries: sites were folded into assets, but old rows remain.
  create_site: "Site added",
  update_site: "Site edited",
  delete_site: "Site deleted",
  create_asset: "Asset added",
  update_asset: "Asset edited",
  delete_asset: "Asset deleted",
  set_maintenance: "Maintenance toggled",
  rotate_token: "Token rotated",
  create_user: "User created",
  reset_pin: "PIN reset",
  set_role: "Role changed",
  set_tv_access: "TV access changed",
  set_docs_access: "Docs access changed",
  set_invite_code: "Invite code changed",
  create_alert_rule: "Alert rule added",
  update_alert_rule: "Alert rule edited",
  delete_alert_rule: "Alert rule deleted",
  upsert_alert_recipient: "Alert recipient saved",
  delete_alert_recipient: "Alert recipient removed",
  set_alert_from: "Sending address changed",
};

function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}

function auditActionColor(action: string): string {
  if (action === "login_failed") return "var(--status-offline)";
  if (action.startsWith("delete_")) return "var(--status-offline)";
  if (action === "login" || action === "logout") return "var(--text-muted)";
  return "var(--accent)";
}

