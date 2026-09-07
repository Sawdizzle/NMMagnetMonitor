"use client";

// The admin shell.
//
// This file was 2,388 lines: 66 pieces of state, six tabs' worth of components,
// and a single child taking 52 props. Every keystroke in the add-asset form
// re-rendered the lot. It was the one place in an otherwise well-factored
// codebase where the structure fought every change made to it.
//
// What is left here is what genuinely belongs to the page rather than to a tab:
// which tab is showing, the data more than one tab reads, and the toast/dialog
// plumbing every tab raises. Each tab owns its own form state and its own
// handlers, in components/admin/. CompaniesTab, DisplaysSection and
// GlobalUsersTab already worked this way and are unchanged — this is the same
// move applied to the other three.
//
// The shared loads stay HERE rather than moving into the tabs, deliberately:
// the tab bar shows a count against each one, and self-loading tabs would mean
// either dropping those counts or fetching the same rows twice.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { type Asset } from "@/lib/supabase";
import Protected from "@/components/Protected";
import { adminListUsers, adminListAlertRules, adminListSiteGeocodes, adminListAuditLog, type SiteGeocodeRow } from "@/lib/adminActions";
import { getSessionAction } from "@/lib/authActions";
import GlobalUsersTab from "@/components/GlobalUsersTab";
import CompaniesTab from "@/components/CompaniesTab";
import DisplaysSection from "@/components/DisplaysSection";
import AssetsPanel from "@/components/admin/AssetsPanel";
import AlertsPanel from "@/components/admin/AlertsPanel";
import UsersPanel from "@/components/admin/UsersPanel";
import ActivityTab from "@/components/admin/ActivityPanel";
import {
  ToastView,
  ConfirmModal,
  PromptModal,
  type AppUser,
  type AlertRule,
  type AuditEntry,
  type Toast,
  type ConfirmReq,
  type PromptReq,
} from "@/components/admin/shared";

type TabId = "assets" | "alerts" | "users" | "displays" | "companies" | "activity";
// "Companies" is superadmin-only and filtered out below — a company admin must
// not even learn that other tenants exist.
const TABS: { id: TabId; label: string; superadminOnly?: boolean }[] = [
  { id: "assets", label: "Assets" },
  { id: "alerts", label: "Alerts" },
  { id: "users", label: "Users" },
  // Not superadmin-only: a company admin manages their own screens.
  { id: "displays", label: "Displays" },
  { id: "companies", label: "Companies", superadminOnly: true },
  { id: "activity", label: "Activity" },
];

export default function AdminPage() {
  return <Protected requireAdmin>{() => <AdminPanel />}</Protected>;
}

function AdminPanel() {
  const [activeTab, setActiveTab] = useState<TabId>("assets");

  const [assets, setAssets] = useState<Asset[]>([]);
  // Resolved map position per asset, for the location line under each unit.
  const [geocodes, setGeocodes] = useState<Record<string, SiteGeocodeRow>>({});
  const [users, setUsers] = useState<AppUser[]>([]);
  // Loaded here, not in AlertsPanel: the tab bar shows a count against it.
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  // Not on the client Session type — read from the server session, which is the
  // only authority on it.
  const [isSuperadmin, setIsSuperadmin] = useState(false);
  // Whether the org being administered is a demo tenant. Read from the server
  // session, not the client one — see lib/session.ts.
  const [isDemoOrg, setIsDemoOrg] = useState(false);
  // The company being administered, for surfaces that must NAME it rather than
  // just scope to it — a wall-display link is company-bound, and "which fleet
  // will this TV show?" has to be answerable before the link is minted.
  const [activeOrg, setActiveOrg] = useState<{ id: string; name: string } | null>(null);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);

  // Toast + dialog state (replaces the old top-of-page status string and the
  // native prompt()/confirm() dialogs).
  const [toast, setToast] = useState<Toast | null>(null);
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null);
  const [promptReq, setPromptReq] = useState<PromptReq | null>(null);

  const notify = useCallback((msg: string, kind: Toast["kind"] = "success") => {
    setToast({ msg, kind });
  }, []);
  const fail = useCallback((msg: string) => setToast({ msg, kind: "error" }), []);

  const askConfirm = useCallback(
    (message: string, danger = false) =>
      new Promise<boolean>((resolve) => setConfirmReq({ message, danger, resolve })),
    []
  );
  const askPrompt = useCallback(
    (opts: { title: string; label: string; minLength?: number }) =>
      new Promise<string | null>((resolve) => setPromptReq({ ...opts, resolve })),
    []
  );

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);


  const loadAuditLog = useCallback(async () => {
    const { data } = await adminListAuditLog(200);
    setAuditLog((data as AuditEntry[]) ?? []);
  }, []);

  const load = useCallback(async () => {
    const [assetRes, { data: userRows }, { data: ruleRows }, { data: geocodeRows }] = await Promise.all([
      // Org-scoped through our own API rather than a direct public_assets read:
      // the anon client can no longer see the table, and this list must show
      // only the active org's units. See lib/fleetQueries.ts.
      fetch("/api/assets", { cache: "no-store" })
        .then((r) => r.json())
        .catch(() => ({ assets: [] })),
      adminListUsers(),
      adminListAlertRules(),
      adminListSiteGeocodes(),
    ]);
    setAssets(assetRes?.assets ?? []);
    setUsers((userRows as AppUser[]) ?? []);
    setAlertRules((ruleRows as AlertRule[]) ?? []);
    setGeocodes(Object.fromEntries((geocodeRows ?? []).map((g) => [g.asset_id, g])));
    loadAuditLog();
  }, [loadAuditLog]);

  useEffect(() => {
    // load() is async: every setState in it runs after an await, on a
    // later tick, not synchronously during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    getSessionAction()
      .then((s) => {
        setIsSuperadmin(!!s?.isSuperadmin);
        setIsDemoOrg(!!s?.activeOrgIsDemo);
        // Name via memberships. A superadmin can be active in an org they hold
        // no membership in, so this can be null for them — DisplaysSection
        // loads the full company list in that case anyway.
        const orgId = s?.activeOrgId ?? null;
        const name = s?.memberships.find((m) => m.orgId === orgId)?.name ?? null;
        setActiveOrg(orgId ? { id: orgId, name: name ?? "this company" } : null);
      })
      .catch(() => {});
  }, []);

  const tabCounts: Record<TabId, number | null> = {
    assets: assets.length,
    alerts: alertRules.length,
    users: users.length,
    // CompaniesTab loads its own list, so there is no count to show here
    // without a second fetch the header doesn't need.
    displays: null,
    companies: null,
    activity: null,
  };

  return (
    <div id="main-content" className="min-h-screen p-6 md:p-10 max-w-5xl mx-auto" role="main">
      <Link href="/" className="back-link">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back to fleet
      </Link>
      <p className="eyebrow mt-4 mb-1.5">Fleet management</p>
      <h1 className="text-2xl md:text-3xl font-semibold tracking-tight mb-6">Admin</h1>

      {/* Tab bar */}
      <div role="tablist" aria-label="Admin sections" className="flex flex-wrap gap-1 border-b border-[var(--border)] mb-8">
        {TABS.filter((t) => !t.superadminOnly || isSuperadmin).map((t) => {
          const active = activeTab === t.id;
          const count = tabCounts[t.id];
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(t.id)}
              className="relative px-4 py-2.5 text-sm font-medium -mb-px border-b-2 transition-colors"
              style={{
                borderColor: active ? "var(--accent)" : "transparent",
                color: active ? "var(--text)" : "var(--text-muted)",
              }}
            >
              {t.label}
              {count !== null && count > 0 && (
                <span className="ml-1.5 text-xs font-mono-data text-[var(--text-dim)]">{count}</span>
              )}
            </button>
          );
        })}
      </div>


      {activeTab === "assets" && (
        <AssetsPanel
          assets={assets}
          geocodes={geocodes}
          reload={load}
          notify={notify}
          fail={fail}
          askConfirm={askConfirm}
        />
      )}

      {activeTab === "alerts" && (
        <AlertsPanel
          assets={assets}
          alertRules={alertRules}
          isDemoOrg={isDemoOrg}
          reload={load}
          notify={notify}
          fail={fail}
          askConfirm={askConfirm}
        />
      )}

      {activeTab === "users" &&
        // A superadmin manages people globally and grants each company
        // explicitly; a company admin manages only their own org's members and
        // never learns that other tenants exist.
        (isSuperadmin ? (
          <GlobalUsersTab notify={notify} fail={fail} askPrompt={askPrompt} askConfirm={askConfirm} />
        ) : (
          <UsersPanel users={users} reload={load} notify={notify} fail={fail} askPrompt={askPrompt} />
        ))}

      {activeTab === "companies" && isSuperadmin && (
        <CompaniesTab notify={notify} fail={fail} askConfirm={askConfirm} askPrompt={askPrompt} />
      )}

      {activeTab === "displays" && (
        <DisplaysSection
          notify={notify}
          fail={fail}
          askConfirm={askConfirm}
          isSuperadmin={isSuperadmin}
          activeOrg={activeOrg}
        />
      )}

      {activeTab === "activity" && <ActivityTab auditLog={auditLog} loadAuditLog={loadAuditLog} />}

      {toast && <ToastView toast={toast} onDismiss={() => setToast(null)} />}
      {confirmReq && (
        <ConfirmModal
          req={confirmReq}
          onDone={(ok) => {
            confirmReq.resolve(ok);
            setConfirmReq(null);
          }}
        />
      )}
      {promptReq && (
        <PromptModal
          req={promptReq}
          onDone={(value) => {
            promptReq.resolve(value);
            setPromptReq(null);
          }}
        />
      )}
    </div>
  );
}
