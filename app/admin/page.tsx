"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { type Asset } from "@/lib/supabase";
import {
  generatePiScript,
  generateEnvPiScript,
  generateSystemdUnit,
  COLLECTOR_VERSION,
  ENV_COLLECTOR_VERSION,
} from "@/lib/piScript";
import { MODALITIES, MODALITY_MRI, usesMagmon, modalityBadge } from "@/lib/modality";
import { zipStore } from "@/lib/zip";
import { actionError } from "@/lib/errors";
import { NO_TELEMETRY_KINDS } from "@/lib/health";
import Protected from "@/components/Protected";
// Admin mutations go through server actions now: the httpOnly session cookie
// travels with the call and the server resolves both the actor and the active
// org. The browser sends no credential, and the RPCs are org-scoped, so an
// admin of one company cannot reach another's assets, users or alert rules.
import {
  adminCreateAsset,
  adminUpdateAsset,
  adminDeleteAsset,
  adminGetAssetConfig,
  adminSetAssetMaintenance,
  adminListSiteGeocodes,
  type SiteGeocodeRow,
  adminRotateGatewayToken,
  adminListUsers,
  adminCreateUser,
  adminSetTvAccess,
  adminSetDocsAccess,
  adminSetRole,
  adminResetPin,
  adminListAlertRules,
  adminUpsertAlertRule,
  adminDeleteAlertRule,
  adminListAlertRecipients,
  adminUpsertAlertRecipient,
  adminDeleteAlertRecipient,
  adminListAlertEvents,
  adminGetAlertIdentity,
  adminSetAlertIdentity,
  adminSetAlertFrom,
  adminSetPlatformAlertFrom,
  adminListAuditLog,
  adminSendTestAlert,
} from "@/lib/adminActions";
import type { AlertIdentity } from "@/lib/adminActions";
import { getSessionAction } from "@/lib/authActions";
import GlobalUsersTab from "@/components/GlobalUsersTab";
import CompaniesTab from "@/components/CompaniesTab";
import DisplaysSection from "@/components/DisplaysSection";
import SiteLocationRow from "@/components/SiteLocationRow";
import { addressKey } from "@/lib/weatherFormat";

const ALERT_METRICS: { key: string; label: string; unit: string }[] = [
  { key: "he_lvl", label: "Helium level", unit: "%" },
  { key: "he_press", label: "Helium pressure", unit: "" },
  { key: "h2o_flow", label: "Water flow", unit: "gpm" },
  { key: "h2o_temp", label: "Water temp", unit: "°F" },
  { key: "shield", label: "Shield temp", unit: "" },
  { key: "cs1", label: "CS1 / compressor", unit: "" },
];
const ALERT_COMPARATORS = ["<", "<=", ">", ">=", "=", "!="];

const NO_LOCATION = "No location set";

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

type AppUser = {
  username: string;
  role: "viewer" | "engineer" | "admin";
  tv_access: boolean;
  docs_access: boolean;
  created_at: string;
};
type AuditEntry = {
  id: number;
  actor: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: string | null;
  created_at: string;
};
type AlertRule = {
  id: string;
  asset_id: string | null;
  asset_name: string | null;
  field: string;
  comparator: string;
  threshold: number;
  enabled: boolean;
  created_at: string;
};
type AlertRecipient = {
  id: string;
  channel: "email" | "sms";
  address: string;
  enabled: boolean;
  created_at: string;
};
type AlertEventRow = {
  id: number;
  asset_id: string;
  asset_name: string;
  kind: string;
  message: string;
  triggered_at: string;
  resolved_at: string | null;
  notified_at: string | null;
};

type Toast = { msg: string; kind: "success" | "error" };
type ConfirmReq = { message: string; danger?: boolean; resolve: (ok: boolean) => void };
type PromptReq = {
  title: string;
  label: string;
  minLength?: number;
  resolve: (value: string | null) => void;
};

export default function AdminPage() {
  return <Protected requireAdmin>{() => <AdminPanel />}</Protected>;
}

function AdminPanel() {
  const [activeTab, setActiveTab] = useState<TabId>("assets");

  const [assets, setAssets] = useState<Asset[]>([]);
  // Resolved map position per asset, for the location line under each unit.
  const [geocodes, setGeocodes] = useState<Record<string, SiteGeocodeRow>>({});
  const [users, setUsers] = useState<AppUser[]>([]);
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

  // add-asset collapsible + list search
  const [showAddAsset, setShowAddAsset] = useState(false);
  const [assetSearch, setAssetSearch] = useState("");

  const [assetName, setAssetName] = useState("");
  // Which kind of unit is being added. Everything MagMon-specific below is
  // gated on this: an environmental asset has no local device to scrape, and
  // the MagMon address field was `required`, so creating one was impossible.
  const [assetModality, setAssetModality] = useState<string>(MODALITY_MRI);
  const [assetSiteName, setAssetSiteName] = useState("");
  const [assetSiteAddress, setAssetSiteAddress] = useState("");
  const [offlineThreshold, setOfflineThreshold] = useState(30);
  const [monitorHost, setMonitorHost] = useState("");
  const [monitorPort, setMonitorPort] = useState(80);
  const [monitorUsername, setMonitorUsername] = useState("MMService");
  const [monitorPassword, setMonitorPassword] = useState("MagnetMonitor");
  const [assetServiceUser, setAssetServiceUser] = useState("pi");

  const [userName, setUserName] = useState("");
  const [userPin, setUserPin] = useState("");
  const [userRole, setUserRole] = useState<"viewer" | "engineer" | "admin">("viewer");

  // script
  const [scriptText, setScriptText] = useState<string | null>(null);
  const [scriptForAsset, setScriptForAsset] = useState<string | null>(null);
  // Which collector the loaded script is, tracked explicitly rather than looked
  // up from `assets`: right after Add asset the new row has not come back from
  // load() yet, so deriving it from the list would name the first download of a
  // brand-new unit after the wrong collector.
  const [scriptVariant, setScriptVariant] = useState<"magmon" | "env">("magmon");
  const [pollMinutes, setPollMinutes] = useState(5);
  // The OS user the collector runs as on the target machine. Default "pi" for a
  // standalone Raspberry Pi; set to the login user (e.g. "Numed") on a shared
  // server that runs several assets. Flows into install ownership + the unit's User=.
  const [serviceUser, setServiceUser] = useState("pi");
  const [downloadingAll, setDownloadingAll] = useState(false);

  // alert rules
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleScope, setRuleScope] = useState<string>(""); // "" = all assets (fleet default)
  const [ruleField, setRuleField] = useState<string>(ALERT_METRICS[1].key);
  const [ruleComparator, setRuleComparator] = useState<string>(">");
  const [ruleThreshold, setRuleThreshold] = useState<number>(3);
  const [ruleEnabled, setRuleEnabled] = useState<boolean>(true);

  // inline asset editing (includes the asset's own location fields)
  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSiteName, setEditSiteName] = useState("");
  const [editSiteAddress, setEditSiteAddress] = useState("");
  const [editThreshold, setEditThreshold] = useState(30);
  const [editHost, setEditHost] = useState("");
  const [editPort, setEditPort] = useState(80);
  const [editUsername, setEditUsername] = useState("MMService");
  const [editPassword, setEditPassword] = useState("MagnetMonitor");
  const [editServiceUser, setEditServiceUser] = useState("pi");
  const [editModality, setEditModality] = useState<string>(MODALITY_MRI);

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

  async function handleAddAsset(e: React.FormEvent) {
    e.preventDefault();
    const envAsset = !usesMagmon(assetModality);
    const { data, error } = await adminCreateAsset({
      name: assetName,
      siteName: assetSiteName.trim() || null,
      siteAddress: assetSiteAddress.trim() || null,
      offlineThresholdMinutes: offlineThreshold,
      // An environmental unit has no MagMon to reach. Stored as a genuine null
      // rather than whatever was last typed into the (now hidden) field, so
      // "has no monitor host" stays a reliable signal everywhere it is read.
      monitorHost: envAsset ? null : monitorHost,
      monitorPort: monitorPort,
      monitorUsername: monitorUsername,
      monitorPassword: monitorPassword,
      serviceUser: assetServiceUser,
      modality: assetModality,
    });
    if (error) return fail(actionError("Could not add asset", error));
    notify(`Asset "${assetName}" added. Install script generated below.`);
    setAssetName("");
    setAssetSiteName("");
    setAssetSiteAddress("");
    setShowAddAsset(false);
    load();
    const created = data as {
      id: string;
      name: string;
      gateway_token: string;
      monitor_host: string | null;
      monitor_port: number;
      monitor_username: string;
      monitor_password: string;
      modality: string;
    };
    setServiceUser(assetServiceUser);
    buildScript({
      name: created.name,
      token: created.gateway_token,
      // From the row the database returned, not from the form: the RPC
      // normalises a blank modality to 'MRI', and the script must match what
      // was actually stored rather than what was typed.
      modality: created.modality,
      host: created.monitor_host,
      port: created.monitor_port,
      username: created.monitor_username,
      password: created.monitor_password,
      svcUser: assetServiceUser,
    });
    setScriptForAsset(created.id);
    setAssetServiceUser("pi");
    setAssetModality(MODALITY_MRI);
  }

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await adminCreateUser(userName, userPin, userRole);
    if (error) return fail(actionError("Could not add user", error));
    notify(`User "${userName}" created.`);
    setUserName("");
    setUserPin("");
    setUserRole("viewer");
    load();
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
    load();
  }
  async function handleToggleDocsAccess(u: AppUser) {
    const { error } = await adminSetDocsAccess(u.username, !u.docs_access);
    if (error) return fail(actionError("Could not change Docs access", error));
    notify(
      u.docs_access
        ? `Docs access revoked for ${u.username}.`
        : `Docs access granted to ${u.username}.`
    );
    load();
  }


  // Was a two-way toggle ("Make admin" / "Make viewer"), which cannot express
  // three roles — engineer would have been unreachable from the UI.
  async function handleSetRole(u: AppUser, newRole: "viewer" | "engineer" | "admin") {
    if (newRole === u.role) return;
    const { error } = await adminSetRole(u.username, newRole);
    if (error) return fail(actionError("Could not change role", error));
    notify(`${u.username} is now ${newRole}.`);
    load();
  }

  async function handleStartEditAsset(asset: Asset) {
    const { data, error } = await adminGetAssetConfig(asset.id);
    const config = data && data[0];
    if (error || !config) return fail(error ? actionError("Could not load asset", error) : "Could not load asset: not found.");
    setEditingAssetId(asset.id);
    setEditName(asset.name);
    setEditSiteName(asset.site_name ?? "");
    setEditSiteAddress(asset.site_address ?? "");
    setEditThreshold(asset.offline_threshold_minutes ?? 30);
    setEditHost(config.monitor_host ?? "");
    setEditPort(config.monitor_port ?? 80);
    setEditUsername(config.monitor_username ?? "MMService");
    setEditPassword(config.monitor_password ?? "MagnetMonitor");
    setEditServiceUser(asset.service_user || "pi");
    setEditModality(asset.modality || MODALITY_MRI);
  }

  async function handleSaveAssetEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingAssetId) return;
    const { error } = await adminUpdateAsset({
      assetId: editingAssetId,
      name: editName,
      siteName: editSiteName.trim() || null,
      siteAddress: editSiteAddress.trim() || null,
      offlineThresholdMinutes: editThreshold,
      // Same as on create: switching a unit to an environmental modality clears
      // the MagMon address rather than leaving a stale one behind.
      monitorHost: usesMagmon(editModality) ? editHost : null,
      monitorPort: editPort,
      monitorUsername: editUsername,
      monitorPassword: editPassword,
      serviceUser: editServiceUser,
      modality: editModality,
    });
    if (error) return fail(actionError("Could not save asset", error));
    notify(`Asset "${editName}" updated.`);
    setEditingAssetId(null);
    load();
  }

  async function handleDeleteAsset(a: Asset) {
    if (!(await askConfirm(`Delete asset "${a.name}"? This also deletes all its telemetry history. This cannot be undone.`, true))) return;
    const { error } = await adminDeleteAsset(a.id);
    if (error) return fail(actionError("Could not delete asset", error));
    notify(`Asset "${a.name}" deleted.`);
    if (editingAssetId === a.id) setEditingAssetId(null);
    load();
  }

  async function handleToggleMaintenance(a: Asset) {
    const { error } = await adminSetAssetMaintenance(a.id, !a.maintenance);
    if (error) return fail(actionError("Could not update maintenance mode", error));
    notify(
      a.maintenance
        ? `Maintenance cleared for "${a.name}".`
        : `"${a.name}" set to maintenance — TV/Display alarms muted for this unit.`
    );
    load();
  }

  // Takes an options object rather than seven positionals: the MagMon branch
  // needs the device's address and credentials and the environmental branch
  // needs none of them, and a positional call with four empty strings in the
  // middle is exactly the sort of thing that ends up on the wrong Pi.
  function buildScript(opts: {
    name: string;
    token: string;
    modality: string;
    host?: string | null;
    port?: number;
    username?: string;
    password?: string;
    svcUser?: string;
  }) {
    const svcUser = opts.svcUser ?? serviceUser;
    const shared = {
      assetName: opts.name,
      gatewayToken: opts.token,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      intervalMinutes: pollMinutes,
      serviceUser: svcUser,
    };
    if (!usesMagmon(opts.modality)) {
      setScriptText(generateEnvPiScript(shared));
      setScriptVariant("env");
      return;
    }
    setScriptText(
      generatePiScript({
        ...shared,
        monitorHost: opts.host ?? "",
        monitorPort: opts.port ?? 80,
        monitorUsername: opts.username ?? "MMService",
        monitorPassword: opts.password ?? "MagnetMonitor",
      })
    );
    setScriptVariant("magmon");
  }

  async function handleGetScriptForExisting(asset: Asset) {
    const { data, error } = await adminGetAssetConfig(asset.id);
    const config = data && data[0];
    if (error || !config) return fail(error ? actionError("Could not retrieve config", error) : "Could not retrieve config: not found.");
    // monitor_host is nullable, and the MagMon collector needs it to reach the
    // device. Previously a null flowed straight into the template and produced a
    // script that could never connect; say so instead. An environmental asset is
    // SUPPOSED to have no monitor host, so the check applies only to MagMons.
    if (usesMagmon(asset.modality) && !config.monitor_host) {
      return fail(`"${asset.name}" has no monitor host set. Edit the asset and add the MagMon's address before generating a script.`);
    }
    // Default the panel's service-user field to this asset's stored value, and
    // build with it so the .py + unit come out with the right User=.
    const su = asset.service_user || "pi";
    setServiceUser(su);
    buildScript({
      name: asset.name,
      token: config.gateway_token,
      modality: asset.modality,
      host: config.monitor_host,
      port: config.monitor_port,
      username: config.monitor_username,
      password: config.monitor_password,
      svcUser: su,
    });
    setScriptForAsset(asset.id);
  }

  async function handleRotateToken() {
    const asset = assets.find((a) => a.id === scriptForAsset);
    if (!asset) return;
    if (
      !(await askConfirm(
        `Rotate the gateway token for "${asset.name}"? The Pi will stop reporting until you download the new script and deploy it. Telemetry already collected is NOT affected.`,
        true
      ))
    )
      return;
    const { error } = await adminRotateGatewayToken(asset.id);
    if (error) return fail(actionError("Could not rotate token", error));
    notify(
      `Token rotated for "${asset.name}". Download the script again and deploy it — the Pi is offline until you do.`
    );
    // Clear the stale script so the old token can't be downloaded by mistake.
    setScriptText("");
  }

  function resetRuleForm() {
    setEditingRuleId(null);
    setRuleScope("");
    setRuleField(ALERT_METRICS[1].key);
    setRuleComparator(">");
    setRuleThreshold(3);
    setRuleEnabled(true);
  }

  function handleEditRule(r: AlertRule) {
    setEditingRuleId(r.id);
    setRuleScope(r.asset_id ?? "");
    setRuleField(r.field);
    setRuleComparator(r.comparator);
    setRuleThreshold(Number(r.threshold));
    setRuleEnabled(r.enabled);
  }

  async function handleSaveRule(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await adminUpsertAlertRule({
      ruleId: editingRuleId,
      assetId: ruleScope || null,
      field: ruleField,
      comparator: ruleComparator,
      threshold: ruleThreshold,
      enabled: ruleEnabled,
    });
    if (error) return fail(actionError("Could not save alert rule", error));
    notify(editingRuleId ? "Alert rule updated." : "Alert rule added.");
    resetRuleForm();
    load();
  }

  async function handleToggleRule(r: AlertRule) {
    const { error } = await adminUpsertAlertRule({
      ruleId: r.id,
      assetId: r.asset_id,
      field: r.field,
      comparator: r.comparator,
      threshold: Number(r.threshold),
      enabled: !r.enabled,
    });
    if (error) return fail(actionError("Could not update alert rule", error));
    load();
  }

  async function handleDeleteRule(r: AlertRule) {
    const metric = ALERT_METRICS.find((m) => m.key === r.field)?.label ?? r.field;
    if (!(await askConfirm(`Delete this alert rule (${metric} ${r.comparator} ${Number(r.threshold)})?`, true))) return;
    const { error } = await adminDeleteAlertRule(r.id);
    if (error) return fail(actionError("Could not delete alert rule", error));
    notify("Alert rule deleted.");
    if (editingRuleId === r.id) resetRuleForm();
    load();
  }

  function downloadFile(contents: string, filename: string, mime: string) {
    const blob = new Blob([contents], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Both collectors' files are named for the collector as well as the asset, so
  // a site running one of each cannot end up installing an environmental script
  // over a MagMon one — the setup instructions inside each file assume the
  // matching unit name.
  const scriptStem = scriptVariant === "env" ? "nm-env-gateway" : "nm-magmon-gateway";

  function downloadScript() {
    if (!scriptText) return;
    // Name the file per asset so nine downloads in a row don't overwrite
    // each other in ~/Downloads and get installed on the wrong Pi.
    const asset = assets.find((a) => a.id === scriptForAsset);
    const suffix = asset ? `-${asset.name}` : "";
    downloadFile(scriptText, `${scriptStem}${suffix}.py`, "text/x-python");
  }

  function downloadUnitFile() {
    const asset = assets.find((a) => a.id === scriptForAsset);
    if (!asset) return;
    // Named per asset for the same reason as the script: nine downloads in a
    // row must not collide in ~/Downloads and get installed on the wrong Pi.
    downloadFile(
      generateSystemdUnit({ assetName: asset.name, serviceUser, variant: scriptVariant }),
      `${scriptStem}-${asset.name}.service`,
      "text/plain"
    );
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Bundle every asset's install script + systemd unit into one zip, each under
  // its own folder — one download instead of clicking through each asset when
  // re-imaging a fleet. Uses the current poll interval and service user.
  async function downloadAllScripts() {
    if (assets.length === 0 || downloadingAll) return;
    setDownloadingAll(true);
    try {
      const built = await Promise.all(
        assets.map(async (a) => {
          const { data, error } = await adminGetAssetConfig(a.id);
          const cfg = data && data[0];
          if (error || !cfg) return { name: a.name, ok: false as const };
          const env = !usesMagmon(a.modality);
          // No monitor host = the MagMon script could never reach the device, so
          // count it as a failure rather than emitting a broken file. An
          // environmental asset has no monitor host by design and is exempt.
          if (!env && !cfg.monitor_host) return { name: a.name, ok: false as const };
          const su = a.service_user || "pi";
          const shared = {
            assetName: a.name,
            gatewayToken: cfg.gateway_token,
            supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
            supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            intervalMinutes: pollMinutes,
            serviceUser: su,
          };
          const script = env
            ? generateEnvPiScript(shared)
            : generatePiScript({
                ...shared,
                monitorHost: cfg.monitor_host as string,
                monitorPort: cfg.monitor_port,
                monitorUsername: cfg.monitor_username,
                monitorPassword: cfg.monitor_password,
              });
          const unit = generateSystemdUnit({
            assetName: a.name,
            serviceUser: su,
            variant: env ? "env" : "magmon",
          });
          const stem = env ? "nm-env-gateway" : "nm-magmon-gateway";
          return { name: a.name, ok: true as const, script, unit, stem };
        })
      );

      const files: { name: string; content: string }[] = [];
      const failed: string[] = [];
      for (const r of built) {
        if (!r.ok) {
          failed.push(r.name);
          continue;
        }
        files.push({ name: `${r.name}/${r.stem}-${r.name}.py`, content: r.script });
        files.push({ name: `${r.name}/${r.stem}-${r.name}.service`, content: r.unit });
      }

      if (files.length === 0) {
        return fail("Could not build any scripts — no asset configs came back.");
      }

      downloadBlob(zipStore(files), "magmon-gateway-scripts.zip");
      const okCount = files.length / 2;
      notify(
        failed.length
          ? `Bundled ${okCount} asset${okCount === 1 ? "" : "s"}; skipped ${failed.length} (${failed.join(", ")}).`
          : `Bundled scripts for all ${okCount} asset${okCount === 1 ? "" : "s"}.`,
        failed.length ? "error" : "success"
      );
    } finally {
      setDownloadingAll(false);
    }
  }

  // Assets filtered by search, grouped by their (optional) location. Assets
  // with no site_name fall into a "No location set" bucket sorted last.
  const assetGroups = useMemo(() => {
    const q = assetSearch.trim().toLowerCase();
    const filtered = q ? assets.filter((a) => a.name.toLowerCase().includes(q)) : assets;
    const groups = new Map<string, Asset[]>();
    for (const a of filtered) {
      const key = a.site_name?.trim() || NO_LOCATION;
      const list = groups.get(key) ?? [];
      list.push(a);
      groups.set(key, list);
    }
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === NO_LOCATION) return 1;
      if (b[0] === NO_LOCATION) return -1;
      return a[0].localeCompare(b[0]);
    });
  }, [assets, assetSearch]);

  // Dismiss the loaded install-script panel when the user searches somewhere
  // that no longer includes the asset it was generated for. Otherwise the panel
  // (and its "Download script" button) keeps pointing at the previous asset, so
  // it's easy to grab the wrong files after searching for a new one. Driven off
  // the keystroke rather than an effect so it never fires while an asset is
  // being added — that path generates a script for a not-yet-listed asset.
  function handleAssetSearchChange(value: string) {
    setAssetSearch(value);
    if (!scriptForAsset) return;
    const q = value.trim().toLowerCase();
    const loaded = assets.find((a) => a.id === scriptForAsset);
    if (loaded && q && !loaded.name.toLowerCase().includes(q)) {
      setScriptText(null);
      setScriptForAsset(null);
    }
  }

  // When a script loads (or switches asset), bring the panel into view so it's
  // obvious which asset the download buttons now belong to.
  useEffect(() => {
    if (scriptForAsset && scriptText) {
      document.getElementById("install-script-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [scriptForAsset, scriptText]);

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
        <AssetsTab
          assets={assets}
          geocodes={geocodes}
          reloadGeocodes={load}
          assetGroups={assetGroups}
          assetSearch={assetSearch}
          setAssetSearch={handleAssetSearchChange}
          showAddAsset={showAddAsset}
          setShowAddAsset={setShowAddAsset}
          handleAddAsset={handleAddAsset}
          assetName={assetName}
          setAssetName={setAssetName}
          assetSiteName={assetSiteName}
          setAssetSiteName={setAssetSiteName}
          assetSiteAddress={assetSiteAddress}
          setAssetSiteAddress={setAssetSiteAddress}
          offlineThreshold={offlineThreshold}
          setOfflineThreshold={setOfflineThreshold}
          assetModality={assetModality}
          setAssetModality={setAssetModality}
          editModality={editModality}
          setEditModality={setEditModality}
          scriptVariant={scriptVariant}
          monitorHost={monitorHost}
          setMonitorHost={setMonitorHost}
          monitorPort={monitorPort}
          setMonitorPort={setMonitorPort}
          monitorUsername={monitorUsername}
          setMonitorUsername={setMonitorUsername}
          monitorPassword={monitorPassword}
          setMonitorPassword={setMonitorPassword}
          assetServiceUser={assetServiceUser}
          setAssetServiceUser={setAssetServiceUser}
          editingAssetId={editingAssetId}
          setEditingAssetId={setEditingAssetId}
          editName={editName}
          setEditName={setEditName}
          editSiteName={editSiteName}
          setEditSiteName={setEditSiteName}
          editSiteAddress={editSiteAddress}
          setEditSiteAddress={setEditSiteAddress}
          editThreshold={editThreshold}
          setEditThreshold={setEditThreshold}
          editHost={editHost}
          setEditHost={setEditHost}
          editPort={editPort}
          setEditPort={setEditPort}
          editUsername={editUsername}
          setEditUsername={setEditUsername}
          editPassword={editPassword}
          setEditPassword={setEditPassword}
          editServiceUser={editServiceUser}
          setEditServiceUser={setEditServiceUser}
          handleStartEditAsset={handleStartEditAsset}
          handleSaveAssetEdit={handleSaveAssetEdit}
          handleDeleteAsset={handleDeleteAsset}
          handleToggleMaintenance={handleToggleMaintenance}
          handleGetScriptForExisting={handleGetScriptForExisting}
          scriptText={scriptText}
          scriptForAsset={scriptForAsset}
          pollMinutes={pollMinutes}
          setPollMinutes={setPollMinutes}
          serviceUser={serviceUser}
          setServiceUser={setServiceUser}
          downloadScript={downloadScript}
          downloadUnitFile={downloadUnitFile}
          handleRotateToken={handleRotateToken}
          downloadAllScripts={downloadAllScripts}
          downloadingAll={downloadingAll}
        />
      )}

      {activeTab === "alerts" && (
        <>
          <AlertsTab
            assets={assets}
            alertRules={alertRules}
            editingRuleId={editingRuleId}
            ruleScope={ruleScope}
            setRuleScope={setRuleScope}
            ruleField={ruleField}
            setRuleField={setRuleField}
            ruleComparator={ruleComparator}
            setRuleComparator={setRuleComparator}
            ruleThreshold={ruleThreshold}
            setRuleThreshold={setRuleThreshold}
            ruleEnabled={ruleEnabled}
            setRuleEnabled={setRuleEnabled}
            handleSaveRule={handleSaveRule}
            resetRuleForm={resetRuleForm}
            handleToggleRule={handleToggleRule}
            handleEditRule={handleEditRule}
            handleDeleteRule={handleDeleteRule}
          />
          <AlertRecipientsSection
            isDemoOrg={isDemoOrg}
            notify={notify}
            fail={fail}
            askConfirm={askConfirm}
          />
          <AlertSenderSection notify={notify} fail={fail} />
          <AlertEventsSection />
        </>
      )}

      {activeTab === "users" &&
        // A superadmin manages people globally and grants each company
        // explicitly; a company admin manages only their own org's members and
        // never learns that other tenants exist.
        (isSuperadmin ? (
          <GlobalUsersTab notify={notify} fail={fail} askPrompt={askPrompt} askConfirm={askConfirm} />
        ) : (
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

/* ---------------------------------------------------------------- Assets tab */

/**
 * How many OTHER units sit at the same street address.
 *
 * Coordinates are stored per address, so pinning one unit moves its neighbours
 * too — five of Numed's units share the Denton service centre. The editor says
 * so before you save rather than after.
 */
function sharingAddress(assets: Asset[], asset: Asset): number {
  const key = addressKey(asset.site_address ?? "");
  if (!key) return 0;
  return assets.filter((a) => a.id !== asset.id && addressKey(a.site_address ?? "") === key).length;
}

function AssetsTab(props: {
  assets: Asset[];
  geocodes: Record<string, SiteGeocodeRow>;
  reloadGeocodes: () => void;
  assetGroups: [string, Asset[]][];
  assetSearch: string;
  setAssetSearch: (v: string) => void;
  showAddAsset: boolean;
  setShowAddAsset: (v: boolean) => void;
  handleAddAsset: (e: React.FormEvent) => void;
  assetName: string;
  setAssetName: (v: string) => void;
  assetSiteName: string;
  setAssetSiteName: (v: string) => void;
  assetSiteAddress: string;
  setAssetSiteAddress: (v: string) => void;
  offlineThreshold: number;
  setOfflineThreshold: (v: number) => void;
  assetModality: string;
  setAssetModality: (v: string) => void;
  editModality: string;
  setEditModality: (v: string) => void;
  /** Which collector the loaded install-script panel is showing. */
  scriptVariant: "magmon" | "env";
  monitorHost: string;
  setMonitorHost: (v: string) => void;
  monitorPort: number;
  setMonitorPort: (v: number) => void;
  monitorUsername: string;
  setMonitorUsername: (v: string) => void;
  monitorPassword: string;
  setMonitorPassword: (v: string) => void;
  assetServiceUser: string;
  setAssetServiceUser: (v: string) => void;
  editingAssetId: string | null;
  setEditingAssetId: (v: string | null) => void;
  editName: string;
  setEditName: (v: string) => void;
  editSiteName: string;
  setEditSiteName: (v: string) => void;
  editSiteAddress: string;
  setEditSiteAddress: (v: string) => void;
  editThreshold: number;
  setEditThreshold: (v: number) => void;
  editHost: string;
  setEditHost: (v: string) => void;
  editPort: number;
  setEditPort: (v: number) => void;
  editUsername: string;
  setEditUsername: (v: string) => void;
  editPassword: string;
  setEditPassword: (v: string) => void;
  editServiceUser: string;
  setEditServiceUser: (v: string) => void;
  handleStartEditAsset: (a: Asset) => void;
  handleSaveAssetEdit: (e: React.FormEvent) => void;
  handleDeleteAsset: (a: Asset) => void;
  handleToggleMaintenance: (a: Asset) => void;
  handleGetScriptForExisting: (a: Asset) => void;
  scriptText: string | null;
  scriptForAsset: string | null;
  pollMinutes: number;
  setPollMinutes: (v: number) => void;
  serviceUser: string;
  setServiceUser: (v: string) => void;
  downloadScript: () => void;
  downloadUnitFile: () => void;
  handleRotateToken: () => void;
  downloadAllScripts: () => void;
  downloadingAll: boolean;
}) {
  const { assets, assetGroups, assetSearch, setAssetSearch, showAddAsset, setShowAddAsset, editingAssetId } = props;
  // The whole MagMon block (address, port, credentials) is meaningless on an
  // environmental unit — and the address input was `required`, which is why
  // adding one used to fail with a browser validation error on a hidden field.
  const addingEnv = !usesMagmon(props.assetModality);

  return (
    <section className="mb-10">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <input
          value={assetSearch}
          onChange={(e) => setAssetSearch(e.target.value)}
          placeholder="Search assets…"
          className="input flex-1 min-w-[12rem] max-w-sm"
          aria-label="Search assets"
        />
        <div className="flex flex-wrap gap-2">
          <button
            onClick={props.downloadAllScripts}
            disabled={props.downloadingAll || assets.length === 0}
            className="btn-secondary"
            title="Download every asset's install script + systemd unit as one zip"
          >
            {props.downloadingAll ? "Preparing…" : `Download all (${assets.length})`}
          </button>
          <button onClick={() => setShowAddAsset(!showAddAsset)} className="btn-primary">
            {showAddAsset ? "Cancel" : "+ Add asset"}
          </button>
        </div>
      </div>

      {showAddAsset && (
        <form onSubmit={props.handleAddAsset} className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-5 flex flex-col gap-3 mb-6">
          <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)]">Add asset</h2>
          <Field label="Modality">
            <select
              value={props.assetModality}
              onChange={(e) => props.setAssetModality(e.target.value)}
              className="input"
            >
              {MODALITIES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-xs text-[var(--text-dim)] -mt-1">
            {MODALITIES.find((m) => m.value === props.assetModality)?.hint}
          </p>
          <Field label="Asset tag">
            <input required value={props.assetName} onChange={(e) => props.setAssetName(e.target.value)} placeholder={addingEnv ? "e.g. PC-LAB01" : "e.g. CA1012-SETONSW"} className="input" />
          </Field>
          <Field label="Site name (optional)">
            <input value={props.assetSiteName} onChange={(e) => props.setAssetSiteName(e.target.value)} placeholder="e.g. Seton Northwest" className="input" />
          </Field>
          <Field label="Address (optional)">
            <input value={props.assetSiteAddress} onChange={(e) => props.setAssetSiteAddress(e.target.value)} placeholder="e.g. 11113 Research Blvd, Austin TX" className="input" />
          </Field>
          <Field label="Stale threshold (minutes)">
            <input type="number" min={1} value={props.offlineThreshold} onChange={(e) => props.setOfflineThreshold(Number(e.target.value))} className="input" />
          </Field>
          <p className="text-xs text-[var(--text-dim)] -mt-1">
            Card turns amber after this many minutes with no report, and red after 60.
          </p>
          {addingEnv ? (
            <p className="text-xs rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-[var(--text-muted)]">
              No MagMon address is needed. The environmental collector reads its
              three zone sensors over RS-485 and the UPS through NUT, both local
              to the Pi — download its install script once the asset is added.
            </p>
          ) : (
            <>
              <Field label="MagMon local IP">
                <input required value={props.monitorHost} onChange={(e) => props.setMonitorHost(e.target.value)} placeholder="e.g. 192.168.1.50" className="input font-mono-data" />
              </Field>
              <div className="flex flex-wrap gap-3">
                <Field label="Port">
                  <input type="number" value={props.monitorPort} onChange={(e) => props.setMonitorPort(Number(e.target.value))} className="input w-20" />
                </Field>
                <Field label="Username">
                  <input value={props.monitorUsername} onChange={(e) => props.setMonitorUsername(e.target.value)} className="input" />
                </Field>
                <PasswordField label="Password" value={props.monitorPassword} onChange={props.setMonitorPassword} />
              </div>
            </>
          )}
          <Field label="Service user (systemd User=)">
            <input value={props.assetServiceUser} onChange={(e) => props.setAssetServiceUser(e.target.value)} placeholder="pi" className="input font-mono-data" />
          </Field>
          <p className="text-xs text-[var(--text-dim)] -mt-1">
            OS user the collector runs as on its host. Site Pis use <code className="font-mono-data">pi</code>; assets on the central Pi server use <code className="font-mono-data">numed</code>.
          </p>
          <button type="submit" className="btn-primary">Add asset</button>
        </form>
      )}

      {assets.length === 0 ? (
        <p className="rounded-xl border border-[var(--border-soft)] px-4 py-6 text-center text-[var(--text-dim)]">No assets yet.</p>
      ) : assetGroups.length === 0 ? (
        <p className="rounded-xl border border-[var(--border-soft)] px-4 py-6 text-center text-[var(--text-dim)]">No assets match &ldquo;{assetSearch}&rdquo;.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {assetGroups.map(([groupName, groupAssets]) => (
            <div key={groupName}>
              <h3 className="text-xs uppercase tracking-wide text-[var(--text-dim)] mb-2 px-1">{groupName}</h3>
              <div className="rounded-xl border border-[var(--border-soft)] overflow-hidden">
                {groupAssets.map((a) =>
                  editingAssetId === a.id ? (
                    <AssetEditRow key={a.id} {...props} asset={a} />
                  ) : (
                    <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[var(--border)] last:border-0">
                      <div>
                        <p className="font-medium">
                          {a.name}
                          {modalityBadge(a.modality) && (
                            <span
                              className="ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide align-middle"
                              style={{ background: "color-mix(in srgb, #a78bfa 18%, transparent)", color: "#c4b5fd" }}
                              title="Environmental unit — zone temp/humidity and UPS power, no MagMon"
                            >
                              {modalityBadge(a.modality)}
                            </span>
                          )}
                          {a.maintenance && (
                            <span
                              className="ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide align-middle"
                              style={{ background: "color-mix(in srgb, #5b93f7 18%, transparent)", color: "#8fb4ff" }}
                              title="TV/Display alarms are muted for this unit"
                            >
                              Maintenance
                            </span>
                          )}
                        </p>
                        {a.site_address?.trim() && (
                          <p className="text-xs text-[var(--text-dim)]">{a.site_address}</p>
                        )}
                        <SiteLocationRow
                          assetId={a.id}
                          address={a.site_address}
                          geocode={props.geocodes[a.id]}
                          siblingCount={sharingAddress(assets, a)}
                          onChanged={props.reloadGeocodes}
                        />
                        <CollectorVersion asset={a} />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => props.handleToggleMaintenance(a)}
                          className="btn-secondary"
                          title="When on, TV/Display mode mutes value-based alarms for this unit"
                        >
                          {a.maintenance ? "End maintenance" : "Maintenance"}
                        </button>
                        <button onClick={() => props.handleGetScriptForExisting(a)} className="btn-secondary">Get install script</button>
                        <button onClick={() => props.handleStartEditAsset(a)} className="btn-secondary">Edit</button>
                        <button onClick={() => props.handleDeleteAsset(a)} className="btn-secondary" style={{ color: "var(--status-offline)" }}>Delete</button>
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {props.scriptText && (
        <div id="install-script-panel" className="mt-8 scroll-mt-24">
          <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-3">
            {props.scriptVariant === "env" ? "Environmental install script" : "Pi install script"}
            {props.scriptForAsset ? ` — ${assets.find((a) => a.id === props.scriptForAsset)?.name ?? ""}` : ""}
          </h2>
          <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-4 mb-3 flex flex-wrap items-end gap-4">
            <Field label="Poll interval (min)">
              <input type="number" min={1} value={props.pollMinutes} onChange={(e) => props.setPollMinutes(Number(e.target.value))} className="input w-24" />
            </Field>
            <Field label="Service user">
              <input value={props.serviceUser} onChange={(e) => props.setServiceUser(e.target.value)} placeholder="pi" className="input w-28 font-mono-data" />
            </Field>
            <button
              onClick={() => {
                const a = assets.find((x) => x.id === props.scriptForAsset);
                if (a) props.handleGetScriptForExisting(a);
              }}
              className="btn-secondary"
            >
              Regenerate
            </button>
            <button onClick={props.downloadScript} className="btn-primary">Download script</button>
            <button onClick={props.downloadUnitFile} className="btn-secondary">Download systemd unit</button>
            <button onClick={props.handleRotateToken} className="btn-secondary">Rotate token</button>
          </div>
          <p className="mb-3 text-xs rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-[var(--text-muted)]">
            <strong className="text-[var(--text)]">Run this under systemd, not cron.</strong>{" "}
            The collector runs continuously and sleeps between polls on its own. A
            cron entry would launch an additional copy on every tick while the
            earlier copies keep running. Install both files, then:{" "}
            <code className="font-mono-data">
              sudo systemctl enable --now {props.scriptVariant === "env" ? "nm-env-gateway" : "nm-magmon-gateway"}-
              {assets.find((a) => a.id === props.scriptForAsset)?.name ?? "ASSET"}
            </code>{" "}
            and confirm with{" "}
            <code className="font-mono-data">
              pgrep -c -f {props.scriptVariant === "env" ? "env-gateway" : "magmon-gateway"}
            </code>{" "}
            (must print 1). The full setup, including the dependencies this
            collector needs, is in the header comment of the script itself.
          </p>
          <pre className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-4 overflow-x-auto text-xs font-mono-data max-h-96 whitespace-pre">
            {props.scriptText}
          </pre>
        </div>
      )}
    </section>
  );
}

function AssetEditRow(props: {
  asset: Asset;
  editName: string;
  setEditName: (v: string) => void;
  editSiteName: string;
  setEditSiteName: (v: string) => void;
  editSiteAddress: string;
  setEditSiteAddress: (v: string) => void;
  editThreshold: number;
  setEditThreshold: (v: number) => void;
  editHost: string;
  setEditHost: (v: string) => void;
  editPort: number;
  setEditPort: (v: number) => void;
  editUsername: string;
  setEditUsername: (v: string) => void;
  editPassword: string;
  setEditPassword: (v: string) => void;
  editServiceUser: string;
  setEditServiceUser: (v: string) => void;
  editModality: string;
  setEditModality: (v: string) => void;
  setEditingAssetId: (v: string | null) => void;
  handleSaveAssetEdit: (e: React.FormEvent) => void;
}) {
  const editingEnv = !usesMagmon(props.editModality);
  return (
    <form onSubmit={props.handleSaveAssetEdit} className="flex flex-col gap-3 px-4 py-4 border-b border-[var(--border)] last:border-0 bg-[var(--bg-elevated)]">
      <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Editing {props.asset.name}</p>
      <Field label="Modality">
        <select
          value={props.editModality}
          onChange={(e) => props.setEditModality(e.target.value)}
          className="input"
        >
          {MODALITIES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-xs text-[var(--text-dim)] -mt-1">
        Changing this changes which card the fleet renders and which collector
        this unit needs. Redeploy its Pi with the matching install script after
        saving.
      </p>
      <Field label="Asset tag">
        <input required value={props.editName} onChange={(e) => props.setEditName(e.target.value)} className="input" />
      </Field>
      <Field label="Site name (optional)">
        <input value={props.editSiteName} onChange={(e) => props.setEditSiteName(e.target.value)} placeholder="e.g. Seton Northwest" className="input" />
      </Field>
      <Field label="Address (optional)">
        <input value={props.editSiteAddress} onChange={(e) => props.setEditSiteAddress(e.target.value)} placeholder="e.g. 11113 Research Blvd, Austin TX" className="input" />
      </Field>
      <Field label="Stale threshold (minutes)">
        <input type="number" min={1} value={props.editThreshold} onChange={(e) => props.setEditThreshold(Number(e.target.value))} className="input" />
      </Field>
      <p className="text-xs text-[var(--text-dim)] -mt-1">
        Card turns amber after this many minutes with no report, and red after 60.
      </p>
      {editingEnv ? (
        <p className="text-xs rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-[var(--text-muted)]">
          Environmental units have no MagMon to reach, so the device address and
          credentials do not apply. Saving clears any address this asset had.
        </p>
      ) : (
        <>
          <Field label="MagMon local IP">
            <input required value={props.editHost} onChange={(e) => props.setEditHost(e.target.value)} className="input font-mono-data" />
          </Field>
          <div className="flex flex-wrap gap-3">
            <Field label="Port">
              <input type="number" value={props.editPort} onChange={(e) => props.setEditPort(Number(e.target.value))} className="input w-20" />
            </Field>
            <Field label="Username">
              <input value={props.editUsername} onChange={(e) => props.setEditUsername(e.target.value)} className="input" />
            </Field>
            <PasswordField label="Password" value={props.editPassword} onChange={props.setEditPassword} />
          </div>
        </>
      )}
      <Field label="Service user (systemd User=)">
        <input value={props.editServiceUser} onChange={(e) => props.setEditServiceUser(e.target.value)} placeholder="pi" className="input font-mono-data" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary">Save changes</button>
        <button type="button" onClick={() => props.setEditingAssetId(null)} className="btn-secondary">Cancel</button>
      </div>
      <p className="text-xs text-[var(--text-dim)]">
        Note: if you change the local IP, port, username, or password here, re-download the install script for this asset so the Pi&apos;s copy matches.
      </p>
    </form>
  );
}

/* ---------------------------------------------------------------- Alerts tab */

function AlertsTab(props: {
  assets: Asset[];
  alertRules: AlertRule[];
  editingRuleId: string | null;
  ruleScope: string;
  setRuleScope: (v: string) => void;
  ruleField: string;
  setRuleField: (v: string) => void;
  ruleComparator: string;
  setRuleComparator: (v: string) => void;
  ruleThreshold: number;
  setRuleThreshold: (v: number) => void;
  ruleEnabled: boolean;
  setRuleEnabled: (v: boolean) => void;
  handleSaveRule: (e: React.FormEvent) => void;
  resetRuleForm: () => void;
  handleToggleRule: (r: AlertRule) => void;
  handleEditRule: (r: AlertRule) => void;
  handleDeleteRule: (r: AlertRule) => void;
}) {
  const { assets, alertRules, editingRuleId } = props;
  return (
    <section className="mb-10">
      <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-2">Alert rules</h2>
      <p className="text-xs text-[var(--text-dim)] mb-3">
        A rule scoped to <strong>All assets</strong> is the fleet default. Scope a rule to a single asset to
        override the fleet default for just that unit. The evaluator runs every minute; maintenance units are exempt.
      </p>
      <form onSubmit={props.handleSaveRule} className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-5 flex flex-wrap items-end gap-4 mb-4">
        <Field label="Scope">
          <select value={props.ruleScope} onChange={(e) => props.setRuleScope(e.target.value)} className="input">
            <option value="">All assets</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Metric">
          <select value={props.ruleField} onChange={(e) => props.setRuleField(e.target.value)} className="input">
            {ALERT_METRICS.map((m) => (
              <option key={m.key} value={m.key}>{m.label}{m.unit ? ` (${m.unit})` : ""}</option>
            ))}
          </select>
        </Field>
        <Field label="Condition">
          <select value={props.ruleComparator} onChange={(e) => props.setRuleComparator(e.target.value)} className="input w-20 font-mono-data">
            {ALERT_COMPARATORS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Threshold">
          <input type="number" step="any" value={props.ruleThreshold} onChange={(e) => props.setRuleThreshold(Number(e.target.value))} className="input w-28 font-mono-data" />
        </Field>
        <label className="flex items-center gap-2 text-xs text-[var(--text-dim)]">
          <input type="checkbox" checked={props.ruleEnabled} onChange={(e) => props.setRuleEnabled(e.target.checked)} />
          Enabled
        </label>
        <button type="submit" className="btn-primary">{editingRuleId ? "Save rule" : "Add rule"}</button>
        {editingRuleId && (
          <button type="button" onClick={props.resetRuleForm} className="btn-secondary">Cancel</button>
        )}
      </form>

      <div className="rounded-xl border border-[var(--border-soft)] overflow-hidden">
        {alertRules.map((r) => {
          const metric = ALERT_METRICS.find((m) => m.key === r.field);
          return (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[var(--border)] last:border-0">
              <div>
                <p className="font-medium">
                  {metric?.label ?? r.field}{" "}
                  <span className="font-mono-data text-sm text-[var(--text-muted)]">{r.comparator} {Number(r.threshold)}</span>
                  {!r.enabled && <span className="ml-2 text-xs text-[var(--text-dim)]">(disabled)</span>}
                </p>
                <p className="text-xs text-[var(--text-dim)]">
                  {r.asset_name ? `Override — ${r.asset_name}` : "All assets"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => props.handleToggleRule(r)} className="btn-secondary">{r.enabled ? "Disable" : "Enable"}</button>
                <button onClick={() => props.handleEditRule(r)} className="btn-secondary">Edit</button>
                <button onClick={() => props.handleDeleteRule(r)} className="btn-secondary" style={{ color: "var(--status-offline)" }}>Delete</button>
              </div>
            </div>
          );
        })}
        {alertRules.length === 0 && <p className="px-4 py-6 text-center text-[var(--text-dim)]">No alert rules yet.</p>}
      </div>
    </section>
  );
}

/* -------------------------------------------------- Alert recipients section */

function AlertRecipientsSection({
  isDemoOrg,
  notify,
  fail,
  askConfirm,
}: {
  isDemoOrg: boolean;
  notify: (msg: string) => void;
  fail: (msg: string) => void;
  askConfirm: (message: string, danger?: boolean) => Promise<boolean>;
}) {
  const [recipients, setRecipients] = useState<AlertRecipient[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [address, setAddress] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await adminListAlertRecipients();
    setRecipients((data as AlertRecipient[]) ?? []);
  }, []);
  useEffect(() => {
    // load() is async: every setState in it runs after an await, on a
    // later tick, not synchronously during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  function reset() {
    setEditingId(null);
    setChannel("email");
    setAddress("");
    setEnabled(true);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await adminUpsertAlertRecipient({
      id: editingId,
      channel,
      address,
      enabled,
    });
    if (error) return fail(actionError("Could not save recipient", error));
    notify(editingId ? "Recipient updated." : "Recipient added.");
    reset();
    load();
  }
  function edit(r: AlertRecipient) {
    setEditingId(r.id);
    setChannel(r.channel);
    setAddress(r.address);
    setEnabled(r.enabled);
  }
  async function toggle(r: AlertRecipient) {
    const { error } = await adminUpsertAlertRecipient({
      id: r.id,
      channel: r.channel,
      address: r.address,
      enabled: !r.enabled,
    });
    if (error) return fail(actionError("Could not update recipient", error));
    load();
  }
  async function remove(r: AlertRecipient) {
    if (!(await askConfirm(`Remove ${r.address} from alert recipients?`, true))) return;
    const { error } = await adminDeleteAlertRecipient(r.id);
    if (error) return fail(actionError("Could not remove recipient", error));
    notify("Recipient removed.");
    if (editingId === r.id) reset();
    load();
  }
  // Send a single test email to this recipient via the notify-alerts function's
  // admin-gated test mode, so a new address can be verified end-to-end.
  //
  // Goes through a server action so the browser never handles a credential —
  // the session cookie's token is forwarded server-side and validated by
  // _admin_actor. This was the last call site keeping Session.pin alive.
  async function test(r: AlertRecipient) {
    if (r.channel !== "email") return fail("Test currently supports email recipients only.");
    setTestingId(r.id);
    try {
      const { data, error } = await adminSendTestAlert(r.address);
      if (error) return fail(actionError("Test failed", error));
      if (data?.message) notify(data.message);
    } finally {
      setTestingId(null);
    }
  }

  return (
    <section className="mb-10">
      <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-2">Recipients</h2>
      <p className="text-xs text-[var(--text-dim)] mb-3">
        Who gets notified when an alert opens. Email is delivered via Resend once the notifier is enabled; the SMS
        channel is stored but not yet wired.
      </p>
      {/* Recipients stay editable here — the block is in the notifier, which is
          the only place it can't be worked around — but saying so up front beats
          letting someone add an address and wait for mail that never comes. */}
      {isDemoOrg && (
        <p className="text-xs mb-3 rounded-lg px-3 py-2 border border-[var(--border-soft)] text-[var(--text-dim)]">
          This is a demo company. Its alerts are <strong>never emailed or pushed</strong>, whatever is
          listed here — the units behind them are simulated.
        </p>
      )}
      <form onSubmit={save} className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-5 flex flex-wrap items-end gap-4 mb-4">
        <Field label="Channel">
          <select value={channel} onChange={(e) => setChannel(e.target.value as "email" | "sms")} className="input">
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </select>
        </Field>
        <Field label={channel === "email" ? "Email address" : "Phone (E.164)"}>
          <input
            required
            type={channel === "email" ? "email" : "text"}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={channel === "email" ? "name@example.com" : "+15125550123"}
            className="input min-w-[16rem] font-mono-data"
          />
        </Field>
        <label className="flex items-center gap-2 text-xs text-[var(--text-dim)]">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <button type="submit" className="btn-primary">{editingId ? "Save recipient" : "Add recipient"}</button>
        {editingId && (
          <button type="button" onClick={reset} className="btn-secondary">Cancel</button>
        )}
      </form>

      <div className="rounded-xl border border-[var(--border-soft)] overflow-hidden">
        {recipients.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[var(--border)] last:border-0">
            <div>
              <p className="font-medium font-mono-data">
                {r.address}
                {!r.enabled && <span className="ml-2 text-xs text-[var(--text-dim)]">(disabled)</span>}
              </p>
              <p className="text-xs text-[var(--text-dim)] uppercase tracking-wide">{r.channel}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => test(r)}
                disabled={testingId === r.id}
                className="btn-secondary"
                title="Send a test email to this address"
              >
                {testingId === r.id ? "Sending…" : "Test"}
              </button>
              <button onClick={() => toggle(r)} className="btn-secondary">{r.enabled ? "Disable" : "Enable"}</button>
              <button onClick={() => edit(r)} className="btn-secondary">Edit</button>
              <button onClick={() => remove(r)} className="btn-secondary" style={{ color: "var(--status-offline)" }}>Remove</button>
            </div>
          </div>
        ))}
        {recipients.length === 0 && (
          <p className="px-4 py-6 text-center text-[var(--text-dim)]">No recipients yet — add one to receive alert emails.</p>
        )}
      </div>
    </section>
  );
}

/* ---------------------------------------------------- Sender identity section */

// Who the alert emails come FROM, and how they read.
//
// The split here is deliberate. Everything a company admin can edit is
// cosmetic-but-meaningful — the display name is what a recipient actually reads
// in an inbox list, and Reply-To decides where an answer lands — and none of it
// requires a DNS record. The ADDRESS is superadmin-only, because it must be a
// Resend-verified sender: point it at an unverified domain and every send fails
// silently, once a minute, forever.
//
// Sending as alerts@customer.org was considered and rejected: SPF/DKIM for that
// From would have to be published in the CUSTOMER's DNS, and a DMARC-enforcing
// hospital junks anything without them.

function AlertSenderSection({
  notify,
  fail,
}: {
  notify: (msg: string) => void;
  fail: (msg: string) => void;
}) {
  const [identity, setIdentity] = useState<AlertIdentity | null>(null);
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [prefix, setPrefix] = useState("");
  const [orgFrom, setOrgFrom] = useState("");
  const [platformFrom, setPlatformFrom] = useState("");

  const load = useCallback(async () => {
    const { data } = await adminGetAlertIdentity();
    if (!data) return;
    setIdentity(data);
    setFromName(data.from_name ?? "");
    setReplyTo(data.reply_to ?? "");
    setPrefix(data.subject_prefix ?? "");
    setOrgFrom(data.from_addr ?? "");
    setPlatformFrom(data.platform_from ?? "");
  }, []);
  useEffect(() => {
    // load() is async: every setState in it runs after an await, on a
    // later tick, not synchronously during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function saveIdentity(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await adminSetAlertIdentity({ fromName, replyTo, subjectPrefix: prefix });
    if (error) return fail(actionError("Could not save sender identity", error));
    notify("Sender identity updated.");
    load();
  }

  async function saveOrgFrom(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await adminSetAlertFrom(orgFrom);
    if (error) return fail(actionError("Could not save sending address", error));
    notify(orgFrom.trim() ? "Company sending address updated." : "Cleared — using the platform address.");
    load();
  }

  async function savePlatformFrom(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await adminSetPlatformAlertFrom(platformFrom);
    if (error) return fail(actionError("Could not save platform address", error));
    notify(platformFrom.trim() ? "Platform sending address updated." : "Cleared — falling back to the ALERT_FROM secret.");
    load();
  }

  const loaded = identity !== null;
  const effectiveName = fromName.trim() || identity?.from_name_default || "";
  const effectivePrefix = prefix.trim() || identity?.subject_prefix_default || "MagMon";
  // Mirrors composeFrom() in the notify-alerts function, including the quoting
  // rule — a company name with a comma ("Numed, Inc") has to be quoted or the
  // header parses as two addresses, and an admin should see that here.
  const effectiveAddr = identity?.from_addr || "onboarding@resend.dev (Resend test sender)";
  const needsQuotes = /[()<>@,;:\\".[\]]/.test(effectiveName);
  const previewFrom = effectiveName
    ? `${needsQuotes ? `"${effectiveName}"` : effectiveName} <${effectiveAddr}>`
    : effectiveAddr;

  return (
    <section className="mb-10">
      <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-2">Sender identity</h2>
      <p className="text-xs text-[var(--text-dim)] mb-3">
        How your alert emails appear in a recipient&apos;s inbox. The sending address is shared across
        companies and set by Numed; the name and reply address are yours.
      </p>

      <form onSubmit={saveIdentity} className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-5">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Sender name">
            <input
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder={identity?.from_name_default ?? ""}
              maxLength={78}
              className="input min-w-[18rem]"
              disabled={!loaded}
            />
          </Field>
          <Field label="Reply-To">
            <input
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              placeholder="biomed@yourhospital.org"
              className="input min-w-[16rem] font-mono-data"
              disabled={!loaded}
            />
          </Field>
          <Field label="Subject prefix">
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder={identity?.subject_prefix_default ?? "MagMon"}
              maxLength={40}
              className="input min-w-[12rem]"
              disabled={!loaded}
            />
          </Field>
          <button type="submit" className="btn-primary" disabled={!loaded}>Save</button>
        </div>

        <p className="text-xs text-[var(--text-dim)] mt-3">
          Leave any field blank to use the placeholder shown. With no Reply-To, replies go to an
          unmonitored mailbox.
        </p>

        {loaded && (
          <div className="mt-4 rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] p-4 text-xs font-mono-data leading-relaxed">
            <div className="text-[var(--text-dim)] uppercase tracking-wide mb-2 font-sans">Preview</div>
            <div><span className="text-[var(--text-dim)]">From:&nbsp;&nbsp;&nbsp;&nbsp;</span>{previewFrom}</div>
            <div>
              <span className="text-[var(--text-dim)]">Reply-To:</span>{" "}
              {replyTo.trim() || <span className="text-[var(--text-dim)]">(none)</span>}
            </div>
            <div><span className="text-[var(--text-dim)]">Subject:&nbsp;</span>{effectivePrefix}: NM1035 h2o_temp &gt; 75 (now 100.5)</div>
            <div><span className="text-[var(--text-dim)]">Subject:&nbsp;</span>{effectivePrefix}: 3 alerts — NM1027, NM1020 +1 more</div>
          </div>
        )}
      </form>

      {identity?.is_superadmin && (
        <div className="mt-4 rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-5">
          <h3 className="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-1">
            Sending address · Numed only
          </h3>
          <p className="text-xs text-[var(--text-dim)] mb-4">
            Must be a <strong>Resend-verified sender</strong> — verify the domain in Resend first, or every
            send fails. Plain address only, no name: the name above is attached at send time. The platform
            address is the default every company inherits; the per-company override is for a customer who
            has verified their own domain.
          </p>
          <div className="flex flex-wrap items-end gap-6">
            <form onSubmit={savePlatformFrom} className="flex items-end gap-3">
              <Field label="Platform default (all companies)">
                <input
                  value={platformFrom}
                  onChange={(e) => setPlatformFrom(e.target.value)}
                  placeholder="alerts@numedmagnetdata.com"
                  className="input min-w-[20rem] font-mono-data"
                />
              </Field>
              <button type="submit" className="btn-secondary">Save</button>
            </form>
            <form onSubmit={saveOrgFrom} className="flex items-end gap-3">
              <Field label="Override for this company">
                <input
                  value={orgFrom}
                  onChange={(e) => setOrgFrom(e.target.value)}
                  placeholder="(inherit the platform default)"
                  className="input min-w-[20rem] font-mono-data"
                />
              </Field>
              <button type="submit" className="btn-secondary">Save</button>
            </form>
          </div>
          <p className="text-xs text-[var(--text-dim)] mt-4">
            With both blank, sending falls back to the <span className="font-mono-data">ALERT_FROM</span>{" "}
            secret and then to <span className="font-mono-data">onboarding@resend.dev</span>, which only ever
            delivers to your own Resend account — no customer will receive anything.
          </p>
        </div>
      )}

      <p className="text-xs text-[var(--text-dim)] mt-3">
        Use a recipient&apos;s <strong>Test</strong> button above to confirm a change actually delivers.
      </p>
    </section>
  );
}

/* ------------------------------------------------------ Recent alerts section */

function AlertEventsSection() {
  const [events, setEvents] = useState<AlertEventRow[]>([]);
  const load = useCallback(async () => {
    const { data } = await adminListAlertEvents(100);
    setEvents((data as AlertEventRow[]) ?? []);
  }, []);
  useEffect(() => {
    // load() is async: every setState in it runs after an await, on a
    // later tick, not synchronously during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const openCount = events.filter((e) => !e.resolved_at).length;

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)]">
          Recent alerts
          {openCount > 0 && <span className="alert-count">{openCount} active</span>}
        </h2>
        <button onClick={load} className="btn-secondary">Refresh</button>
      </div>
      <p className="text-xs text-[var(--text-dim)] mb-3">
        Opened and resolved automatically by the evaluator each minute. Active first, showing the most recent {events.length}.
      </p>
      <div className="rounded-xl border border-[var(--border-soft)] overflow-hidden">
        {events.map((e) => {
          const isOpen = !e.resolved_at;
          const color = isOpen
            ? NO_TELEMETRY_KINDS.has(e.kind)
              ? "var(--status-offline)"
              : "var(--status-warning)"
            : "var(--text-dim)";
          return (
            <div
              key={e.id}
              className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-[var(--border)] last:border-0"
              style={{ opacity: isOpen ? 1 : 0.68 }}
            >
              <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm">{e.message}</p>
                <p className="text-xs text-[var(--text-dim)]">
                  {isOpen ? "open" : "resolved"} · {formatAuditTime(isOpen ? e.triggered_at : (e.resolved_at as string))}
                  {e.notified_at ? " · notified" : ""}
                </p>
              </div>
            </div>
          );
        })}
        {events.length === 0 && (
          <p className="px-4 py-6 text-center text-[var(--text-dim)]">No alerts recorded yet.</p>
        )}
      </div>
    </section>
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

/* -------------------------------------------------------------- Activity tab */

function ActivityTab({ auditLog, loadAuditLog }: { auditLog: AuditEntry[]; loadAuditLog: () => void }) {
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

/* -------------------------------------------------------- Toast + dialogs UI */

function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
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

function ModalShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "color-mix(in srgb, black 55%, transparent)" }}>
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-xl">{children}</div>
    </div>
  );
}

function ConfirmModal({ req, onDone }: { req: ConfirmReq; onDone: (ok: boolean) => void }) {
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

function PromptModal({ req, onDone }: { req: PromptReq; onDone: (value: string | null) => void }) {
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

/* ------------------------------------------------------------------- helpers */

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

function formatAuditTime(iso: string): string {
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
function CollectorVersion({ asset }: { asset: Asset }) {
  // The two collectors are separate programs with separate version stamps.
  // Comparing an environmental unit against the MagMon generator's version
  // would mark every PET/CT asset permanently "behind".
  const current = usesMagmon(asset.modality) ? COLLECTOR_VERSION : ENV_COLLECTOR_VERSION;
  const reported = asset.collector_version ?? null;
  const state = reported === null ? "unknown" : reported === current ? "ok" : "behind";
  if (state === "ok") {
    return (
      <p className="text-[10px] text-[var(--text-dim)] font-mono-data mt-0.5">collector {reported}</p>
    );
  }
  const color = state === "behind" ? "#fbbf24" : "var(--text-dim)";
  return (
    <p className="text-[10px] mt-0.5 font-mono-data" style={{ color }}>
      collector {reported ?? "version unknown"}
      <span className="ml-1.5 font-sans">
        {state === "behind"
          ? `— behind, current is ${current}`
          : `— predates version reporting; redeploy to find out`}
      </span>
    </p>
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

function PasswordField({
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
