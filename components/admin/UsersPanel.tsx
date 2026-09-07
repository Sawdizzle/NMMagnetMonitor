"use client";

// The Users tab, for a company admin: the people in THIS org and what they may
// reach. A superadmin gets GlobalUsersTab instead, which was already its own
// component — this is the same move applied to the other half.
//
// Split out of app/admin/page.tsx; the three form fields and five handlers were
// held by the page and drilled down.

import { useState } from "react";
import { actionError } from "@/lib/errors";
import {
  adminCreateUser,
  adminSetRole,
  adminSetTvAccess,
  adminSetDocsAccess,
  adminResetPin,
} from "@/lib/adminActions";
import { Field, PasswordField, type AppUser, type Toast } from "./shared";

export default function UsersPanel({
  users,
  reload,
  notify,
  fail,
  askPrompt,
}: {
  users: AppUser[];
  reload: () => void;
  notify: (msg: string, kind?: Toast["kind"]) => void;
  fail: (msg: string) => void;
  /** Resetting a PIN asks for the new one through the shell's modal. */
  askPrompt: (opts: { title: string; label: string; minLength?: number }) => Promise<string | null>;
}) {
  const [userName, setUserName] = useState("");
  const [userPin, setUserPin] = useState("");
  const [userRole, setUserRole] = useState<"viewer" | "engineer" | "admin">("viewer");

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await adminCreateUser(userName, userPin, userRole);
    if (error) return fail(actionError("Could not add user", error));
    notify(`User "${userName}" created.`);
    setUserName("");
    setUserPin("");
    setUserRole("viewer");
    reload();
  }

  async function handleResetPin(u: AppUser) {
    const newPin = await askPrompt({
      title: `Reset PIN for ${u.username}`,
      label: "New PIN (min 4 characters)",
      minLength: 4,
    });
    if (!newPin) return;
    const { error } = await adminResetPin(u.username, newPin);
    if (error) return fail(actionError("Could not reset PIN", error));
    notify(`PIN reset for ${u.username}.`);
  }

  async function handleToggleTvAccess(u: AppUser) {
    const { error } = await adminSetTvAccess(u.username, !u.tv_access);
    if (error) return fail(actionError("Could not update TV access", error));
    notify(u.tv_access ? `TV access revoked for ${u.username}.` : `TV access granted to ${u.username}.`);
    reload();
  }
  async function handleToggleDocsAccess(u: AppUser) {
    const { error } = await adminSetDocsAccess(u.username, !u.docs_access);
    if (error) return fail(actionError("Could not change Docs access", error));
    notify(
      u.docs_access
        ? `Docs access revoked for ${u.username}.`
        : `Docs access granted to ${u.username}.`
    );
    reload();
  }


  // Was a two-way toggle ("Make admin" / "Make viewer"), which cannot express
  // three roles — engineer would have been unreachable from the UI.
  async function handleSetRole(u: AppUser, newRole: "viewer" | "engineer" | "admin") {
    if (newRole === u.role) return;
    const { error } = await adminSetRole(u.username, newRole);
    if (error) return fail(actionError("Could not change role", error));
    notify(`${u.username} is now ${newRole}.`);
    reload();
  }
  return (
    <UsersTab
      users={users}
      userName={userName}
      setUserName={setUserName}
      userPin={userPin}
      setUserPin={setUserPin}
      userRole={userRole}
      setUserRole={setUserRole}
      handleAddUser={handleAddUser}
      handleSetRole={handleSetRole}
      handleToggleTvAccess={handleToggleTvAccess}
      handleToggleDocsAccess={handleToggleDocsAccess}
      handleResetPin={handleResetPin}
    />
  );
}

/* ----------------------------------------------------------------- Users tab */

function UsersTab(props: {
  users: AppUser[];
  userName: string;
  setUserName: (v: string) => void;
  userPin: string;
  setUserPin: (v: string) => void;
  userRole: "viewer" | "engineer" | "admin";
  setUserRole: (v: "viewer" | "engineer" | "admin") => void;
  handleAddUser: (e: React.FormEvent) => void;
  handleSetRole: (u: AppUser, role: "viewer" | "engineer" | "admin") => void;
  handleToggleTvAccess: (u: AppUser) => void;
  handleToggleDocsAccess: (u: AppUser) => void;
  handleResetPin: (u: AppUser) => void;
}) {
  const { users } = props;
  return (
    <section className="mb-10">
      <form onSubmit={props.handleAddUser} className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-5 flex flex-wrap items-end gap-4 mb-4">
        <Field label="Username">
          <input required value={props.userName} onChange={(e) => props.setUserName(e.target.value)} className="input" />
        </Field>
        <PasswordField label="PIN (min 4 characters)" value={props.userPin} onChange={props.setUserPin} minLength={4} mono />
        <Field label="Role">
          <select value={props.userRole} onChange={(e) => props.setUserRole(e.target.value as "viewer" | "engineer" | "admin")} className="input">
            <option value="viewer">Viewer</option>
            <option value="engineer">Engineer</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <button type="submit" className="btn-primary">Add user</button>
      </form>

      <div className="rounded-xl border border-[var(--border-soft)] overflow-hidden">
        {users.map((u) => (
          // Stacks on phones. As one wrapping justify-between row the controls
          // sprang to both edges with a hole in the middle, and the group could
          // not shrink below the width of three labelled controls.
          <div key={u.username} className="flex flex-col gap-2 px-4 py-3 border-b border-[var(--border)] last:border-0 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">{u.username}</p>
              <p className="text-xs text-[var(--text-dim)] capitalize">{u.role}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {u.role === "admin" ? (
                <label
                  className="flex items-center gap-1.5 text-xs text-[var(--text-dim)]"
                  title="Admins always have TV/Display access"
                >
                  <input type="checkbox" checked disabled readOnly />
                  TV access
                </label>
              ) : (
                <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={u.tv_access}
                    onChange={() => props.handleToggleTvAccess(u)}
                  />
                  TV access
                </label>
              )}
              {u.role === "admin" ? (
                <label
                  className="flex items-center gap-1.5 text-xs text-[var(--text-dim)]"
                  title="Admins always have Docs access"
                >
                  <input type="checkbox" checked disabled readOnly />
                  Docs
                </label>
              ) : (
                <label
                  className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] cursor-pointer"
                  title="The runbook at /docs carries real infrastructure details — hostnames, IPs, the tailnet account and SSH user."
                >
                  <input
                    type="checkbox"
                    checked={u.docs_access}
                    onChange={() => props.handleToggleDocsAccess(u)}
                  />
                  Docs
                </label>
              )}
              <select
                value={u.role}
                onChange={(e) => props.handleSetRole(u, e.target.value as "viewer" | "engineer" | "admin")}
                className="input py-1 text-xs"
                aria-label={`Role for ${u.username}`}
                title="Engineer can acknowledge and annotate alerts, but cannot change companies, users, rules or tokens."
              >
                <option value="viewer">Viewer</option>
                <option value="engineer">Engineer</option>
                <option value="admin">Admin</option>
              </select>
              <button onClick={() => props.handleResetPin(u)} className="btn-secondary">Reset PIN</button>
            </div>
          </div>
        ))}
        {users.length === 0 && <p className="px-4 py-6 text-center text-[var(--text-dim)]">No users yet.</p>}
      </div>
    </section>
  );
}

