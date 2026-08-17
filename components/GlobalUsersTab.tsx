"use client";

import { useCallback, useEffect, useState } from "react";
import {
  adminListAllUsers,
  adminCreateUnassignedUser,
  adminSetMembership,
  adminResetPin,
  type GlobalUser,
} from "@/lib/adminActions";
import { listSwitchableOrgs, type SwitchableOrg } from "@/lib/authActions";
import { actionError } from "@/lib/errors";

/**
 * Superadmin user administration: people and company access as two separate
 * decisions.
 *
 * The org-scoped UsersTab creates a person directly into whatever org the
 * switcher is on. That is how the "Demo" account ended up a member of Numed and
 * able to read all 17 real magnets. Here a person is created with NO access at
 * all, and each company is granted explicitly afterwards — so the dangerous
 * outcome requires a deliberate click rather than being the default.
 *
 * Only rendered for superadmins; an ordinary company admin still gets the
 * org-scoped tab and cannot see that other tenants exist.
 */
export default function GlobalUsersTab({
  notify,
  fail,
  askPrompt,
  askConfirm,
}: {
  notify: (m: string) => void;
  fail: (m: string) => void;
  askPrompt: (o: { title: string; label: string; minLength?: number }) => Promise<string | null>;
  askConfirm: (m: string, danger?: boolean) => Promise<boolean>;
}) {
  const [users, setUsers] = useState<GlobalUser[]>([]);
  const [orgs, setOrgs] = useState<SwitchableOrg[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newPin, setNewPin] = useState("");

  const load = useCallback(async () => {
    const [{ data: userRows, error }, orgRows] = await Promise.all([
      adminListAllUsers(),
      listSwitchableOrgs(),
    ]);
    if (error) fail(actionError("Could not load users", error));
    setUsers(userRows ?? []);
    setOrgs(orgRows);
    setLoading(false);
  }, [fail]);

  useEffect(() => {
    load();
  }, [load]);

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await adminCreateUnassignedUser(newName, newPin);
    if (error) return fail(actionError("Could not create user", error));
    notify(`"${newName}" created. They have no company access yet — grant it below.`);
    setNewName("");
    setNewPin("");
    load();
  }

  async function setGrant(
    username: string,
    orgId: string,
    orgName: string,
    role: "admin" | "viewer" | null,
    tvAccess: boolean
  ) {
    // Revoking is the one destructive action here and it is a single click on a
    // dropdown, so confirm it.
    if (role === null && !(await askConfirm(`Remove ${username}'s access to ${orgName}?`, true))) {
      return;
    }
    setBusy(`${username}:${orgId}`);
    const { error } = await adminSetMembership(username, orgId, role, tvAccess);
    setBusy(null);
    if (error) return fail(actionError("Could not change access", error));
    notify(
      role === null
        ? `${username} removed from ${orgName}.`
        : `${username} is now ${role} of ${orgName}.`
    );
    load();
  }

  async function resetPin(username: string) {
    const pin = await askPrompt({
      title: `Reset PIN for ${username}`,
      label: "New PIN (min 4 characters)",
      minLength: 4,
    });
    if (!pin) return;
    const { error } = await adminResetPin(username, pin);
    if (error) return fail(actionError("Could not reset PIN", error));
    notify(`PIN reset for ${username}. Their existing sessions were signed out.`);
  }

  if (loading) return <p className="text-sm text-[var(--text-dim)]">Loading users…</p>;

  return (
    <section className="mb-10">
      <form
        onSubmit={addUser}
        className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-5 flex flex-wrap items-end gap-4 mb-2"
      >
        <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
          Username
          <input
            required
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="input"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
          PIN (min 4 characters)
          <input
            required
            type="password"
            minLength={4}
            value={newPin}
            onChange={(e) => setNewPin(e.target.value)}
            className="input font-mono-data"
          />
        </label>
        <button type="submit" className="btn-primary">
          Add person
        </button>
      </form>
      <p className="text-xs text-[var(--text-dim)] mb-5">
        New accounts start with no access to any company. Grant it explicitly below — that way
        nobody lands in a company just because it happened to be the one on screen.
      </p>

      <div className="rounded-xl border border-[var(--border-soft)] overflow-hidden">
        {users.map((u) => {
          const grantOf = new Map(u.memberships.map((m) => [m.org_id, m]));
          return (
            <div key={u.username} className="px-4 py-4 border-b border-[var(--border)] last:border-0">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{u.username}</p>
                  {u.is_superadmin && (
                    <span
                      className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-[var(--border-soft)] text-[var(--text-dim)]"
                      title="Superadmins are admin of every company, whether or not they hold a membership."
                    >
                      Superadmin
                    </span>
                  )}
                  {u.memberships.length === 0 && !u.is_superadmin && (
                    <span
                      className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border"
                      style={{ borderColor: "var(--status-warning)", color: "var(--status-warning)" }}
                      title="This person can sign in but will see nothing until you grant a company."
                    >
                      No access
                    </span>
                  )}
                </div>
                <button onClick={() => resetPin(u.username)} className="btn-secondary">
                  Reset PIN
                </button>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                {orgs.map((o) => {
                  const g = grantOf.get(o.orgId);
                  const key = `${u.username}:${o.orgId}`;
                  return (
                    <div
                      key={o.orgId}
                      className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] px-3 py-2"
                    >
                      <span className="text-sm truncate">
                        {o.name}
                        {o.isDemo && <span className="text-[var(--text-dim)]"> (demo)</span>}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        <label className="flex items-center gap-1 text-[11px] text-[var(--text-dim)]">
                          <input
                            type="checkbox"
                            disabled={!g || busy === key || g.role === "admin"}
                            checked={g ? g.tv_access || g.role === "admin" : false}
                            onChange={(e) =>
                              g && setGrant(u.username, o.orgId, o.name, g.role, e.target.checked)
                            }
                            title={
                              g?.role === "admin"
                                ? "Admins always have TV access"
                                : "TV / Display access for this company"
                            }
                          />
                          TV
                        </label>
                        <select
                          className="input py-1 text-xs"
                          disabled={busy === key}
                          value={g?.role ?? ""}
                          onChange={(e) =>
                            setGrant(
                              u.username,
                              o.orgId,
                              o.name,
                              (e.target.value || null) as "admin" | "viewer" | null,
                              g?.tv_access ?? false
                            )
                          }
                        >
                          <option value="">No access</option>
                          <option value="viewer">Viewer</option>
                          <option value="admin">Admin</option>
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
