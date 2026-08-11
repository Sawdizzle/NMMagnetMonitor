"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { supabase, type Asset } from "@/lib/supabase";
import { generatePiScript, generateSystemdUnit } from "@/lib/piScript";
import { zipStore } from "@/lib/zip";
import { actionError } from "@/lib/errors";
import Protected from "@/components/Protected";
import type { Session } from "@/lib/auth";

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

type TabId = "assets" | "alerts" | "users" | "activity";
const TABS: { id: TabId; label: string }[] = [
  { id: "assets", label: "Assets" },
  { id: "alerts", label: "Alerts" },
  { id: "users", label: "Users" },
  { id: "activity", label: "Activity" },
];

type AppUser = { username: string; role: "viewer" | "admin"; tv_access: boolean; created_at: string };
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

type Toast = { msg: string; kind: "success" | "error" };
type ConfirmReq = { message: string; danger?: boolean; resolve: (ok: boolean) => void };
type PromptReq = {
  title: string;
  label: string;
  minLength?: number;
  resolve: (value: string | null) => void;
};

export default function AdminPage() {
  return <Protected requireAdmin>{(session) => <AdminPanel me={session} />}</Protected>;
}

function AdminPanel({ me }: { me: Session }) {
  const [activeTab, setActiveTab] = useState<TabId>("assets");

  const [assets, setAssets] = useState<Asset[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
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
  const [userRole, setUserRole] = useState<"viewer" | "admin">("viewer");

  // script
  const [scriptText, setScriptText] = useState<string | null>(null);
  const [scriptForAsset, setScriptForAsset] = useState<string | null>(null);
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

  const loadAuditLog = useCallback(async () => {
    const { data } = await supabase.rpc("admin_list_audit_log", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_limit: 200,
    });
    setAuditLog((data as AuditEntry[]) ?? []);
  }, [me.username, me.pin]);

  const load = useCallback(async () => {
    const [{ data: assetRows }, { data: userRows }, { data: ruleRows }] = await Promise.all([
      supabase.from("public_assets").select("*").order("name"),
      supabase.rpc("admin_list_users", { p_actor_username: me.username, p_actor_pin: me.pin }),
      supabase.rpc("admin_list_alert_rules", { p_actor_username: me.username, p_actor_pin: me.pin }),
    ]);
    setAssets(assetRows ?? []);
    setUsers((userRows as AppUser[]) ?? []);
    setAlertRules((ruleRows as AlertRule[]) ?? []);
    loadAuditLog();
  }, [me.username, me.pin, loadAuditLog]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAddAsset(e: React.FormEvent) {
    e.preventDefault();
    const { data, error } = await supabase.rpc("admin_create_asset", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_name: assetName,
      p_site_name: assetSiteName.trim() || null,
      p_site_address: assetSiteAddress.trim() || null,
      p_offline_threshold_minutes: offlineThreshold,
      p_monitor_host: monitorHost,
      p_monitor_port: monitorPort,
      p_monitor_username: monitorUsername,
      p_monitor_password: monitorPassword,
      p_service_user: assetServiceUser,
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
      monitor_host: string;
      monitor_port: number;
      monitor_username: string;
      monitor_password: string;
    };
    setServiceUser(assetServiceUser);
    buildScript(created.name, created.gateway_token, created.monitor_host, created.monitor_port, created.monitor_username, created.monitor_password, assetServiceUser);
    setScriptForAsset(created.id);
    setAssetServiceUser("pi");
  }

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.rpc("admin_create_user", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_new_username: userName,
      p_new_pin: userPin,
      p_role: userRole,
    });
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
    const { error } = await supabase.rpc("admin_reset_pin", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_target_username: u.username,
      p_new_pin: newPin,
    });
    if (error) return fail(actionError("Could not reset PIN", error));
    notify(`PIN reset for ${u.username}.`);
  }

  async function handleToggleTvAccess(u: AppUser) {
    const { error } = await supabase.rpc("admin_set_tv_access", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_target_username: u.username,
      p_tv_access: !u.tv_access,
    });
    if (error) return fail(actionError("Could not update TV access", error));
    notify(u.tv_access ? `TV access revoked for ${u.username}.` : `TV access granted to ${u.username}.`);
    load();
  }

  async function handleToggleRole(u: AppUser) {
    const newRole = u.role === "admin" ? "viewer" : "admin";
    const { error } = await supabase.rpc("admin_set_role", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_target_username: u.username,
      p_new_role: newRole,
    });
    if (error) return fail(actionError("Could not change role", error));
    notify(`${u.username} is now ${newRole}.`);
    load();
  }

  async function handleStartEditAsset(asset: Asset) {
    const { data, error } = await supabase.rpc("admin_get_asset_config", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_asset_id: asset.id,
    });
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
  }

  async function handleSaveAssetEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingAssetId) return;
    const { error } = await supabase.rpc("admin_update_asset", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_asset_id: editingAssetId,
      p_name: editName,
      p_site_name: editSiteName.trim() || null,
      p_site_address: editSiteAddress.trim() || null,
      p_offline_threshold_minutes: editThreshold,
      p_monitor_host: editHost,
      p_monitor_port: editPort,
      p_monitor_username: editUsername,
      p_monitor_password: editPassword,
      p_service_user: editServiceUser,
    });
    if (error) return fail(actionError("Could not save asset", error));
    notify(`Asset "${editName}" updated.`);
    setEditingAssetId(null);
    load();
  }

  async function handleDeleteAsset(a: Asset) {
    if (!(await askConfirm(`Delete asset "${a.name}"? This also deletes all its telemetry history. This cannot be undone.`, true))) return;
    const { error } = await supabase.rpc("admin_delete_asset", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_asset_id: a.id,
    });
    if (error) return fail(actionError("Could not delete asset", error));
    notify(`Asset "${a.name}" deleted.`);
    if (editingAssetId === a.id) setEditingAssetId(null);
    load();
  }

  async function handleToggleMaintenance(a: Asset) {
    const { error } = await supabase.rpc("admin_set_asset_maintenance", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_asset_id: a.id,
      p_maintenance: !a.maintenance,
    });
    if (error) return fail(actionError("Could not update maintenance mode", error));
    notify(
      a.maintenance
        ? `Maintenance cleared for "${a.name}".`
        : `"${a.name}" set to maintenance — TV/Display alarms muted for this unit.`
    );
    load();
  }

  function buildScript(
    name: string,
    token: string,
    host: string,
    port: number,
    username: string,
    password: string,
    svcUser: string = serviceUser
  ) {
    const script = generatePiScript({
      assetName: name,
      gatewayToken: token,
      monitorHost: host,
      monitorPort: port,
      monitorUsername: username,
      monitorPassword: password,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      intervalMinutes: pollMinutes,
      serviceUser: svcUser,
    });
    setScriptText(script);
  }

  async function handleGetScriptForExisting(asset: Asset) {
    const { data, error } = await supabase.rpc("admin_get_asset_config", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_asset_id: asset.id,
    });
    const config = data && data[0];
    if (error || !config) return fail(error ? actionError("Could not retrieve config", error) : "Could not retrieve config: not found.");
    // Default the panel's service-user field to this asset's stored value, and
    // build with it so the .py + unit come out with the right User=.
    const su = asset.service_user || "pi";
    setServiceUser(su);
    buildScript(asset.name, config.gateway_token, config.monitor_host, config.monitor_port, config.monitor_username, config.monitor_password, su);
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
    const { error } = await supabase.rpc("admin_rotate_gateway_token", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_asset_id: asset.id,
    });
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
    const { error } = await supabase.rpc("admin_upsert_alert_rule", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_rule_id: editingRuleId,
      p_asset_id: ruleScope || null,
      p_field: ruleField,
      p_comparator: ruleComparator,
      p_threshold: ruleThreshold,
      p_enabled: ruleEnabled,
    });
    if (error) return fail(actionError("Could not save alert rule", error));
    notify(editingRuleId ? "Alert rule updated." : "Alert rule added.");
    resetRuleForm();
    load();
  }

  async function handleToggleRule(r: AlertRule) {
    const { error } = await supabase.rpc("admin_upsert_alert_rule", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_rule_id: r.id,
      p_asset_id: r.asset_id,
      p_field: r.field,
      p_comparator: r.comparator,
      p_threshold: Number(r.threshold),
      p_enabled: !r.enabled,
    });
    if (error) return fail(actionError("Could not update alert rule", error));
    load();
  }

  async function handleDeleteRule(r: AlertRule) {
    const metric = ALERT_METRICS.find((m) => m.key === r.field)?.label ?? r.field;
    if (!(await askConfirm(`Delete this alert rule (${metric} ${r.comparator} ${Number(r.threshold)})?`, true))) return;
    const { error } = await supabase.rpc("admin_delete_alert_rule", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_rule_id: r.id,
    });
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

  function downloadScript() {
    if (!scriptText) return;
    // Name the file per asset so nine downloads in a row don't overwrite
    // each other in ~/Downloads and get installed on the wrong Pi.
    const asset = assets.find((a) => a.id === scriptForAsset);
    const suffix = asset ? `-${asset.name}` : "";
    downloadFile(scriptText, `nm-magmon-gateway${suffix}.py`, "text/x-python");
  }

  function downloadUnitFile() {
    const asset = assets.find((a) => a.id === scriptForAsset);
    if (!asset) return;
    // Named per asset for the same reason as the script: nine downloads in a
    // row must not collide in ~/Downloads and get installed on the wrong Pi.
    // The file is installed on the Pi as nm-magmon-gateway.service regardless.
    downloadFile(
      generateSystemdUnit({ assetName: asset.name, serviceUser }),
      `nm-magmon-gateway-${asset.name}.service`,
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
          const { data, error } = await supabase.rpc("admin_get_asset_config", {
            p_actor_username: me.username,
            p_actor_pin: me.pin,
            p_asset_id: a.id,
          });
          const cfg = data && data[0];
          if (error || !cfg) return { name: a.name, ok: false as const };
          const su = a.service_user || "pi";
          const script = generatePiScript({
            assetName: a.name,
            gatewayToken: cfg.gateway_token,
            monitorHost: cfg.monitor_host,
            monitorPort: cfg.monitor_port,
            monitorUsername: cfg.monitor_username,
            monitorPassword: cfg.monitor_password,
            supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
            supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            intervalMinutes: pollMinutes,
            serviceUser: su,
          });
          const unit = generateSystemdUnit({ assetName: a.name, serviceUser: su });
          return { name: a.name, ok: true as const, script, unit };
        })
      );

      const files: { name: string; content: string }[] = [];
      const failed: string[] = [];
      for (const r of built) {
        if (!r.ok) {
          failed.push(r.name);
          continue;
        }
        files.push({ name: `${r.name}/nm-magmon-gateway-${r.name}.py`, content: r.script });
        files.push({ name: `${r.name}/nm-magmon-gateway-${r.name}.service`, content: r.unit });
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
        {TABS.map((t) => {
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
      )}

      {activeTab === "users" && (
        <UsersTab
          users={users}
          userName={userName}
          setUserName={setUserName}
          userPin={userPin}
          setUserPin={setUserPin}
          userRole={userRole}
          setUserRole={setUserRole}
          handleAddUser={handleAddUser}
          handleToggleRole={handleToggleRole}
          handleToggleTvAccess={handleToggleTvAccess}
          handleResetPin={handleResetPin}
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

function AssetsTab(props: {
  assets: Asset[];
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
          <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)]">Add MagMon asset</h2>
          <Field label="Asset tag">
            <input required value={props.assetName} onChange={(e) => props.setAssetName(e.target.value)} placeholder="e.g. CA1012-SETONSW" className="input" />
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
          <Field label="Service user (systemd User=)">
            <input value={props.assetServiceUser} onChange={(e) => props.setAssetServiceUser(e.target.value)} placeholder="pi" className="input font-mono-data" />
          </Field>
          <p className="text-xs text-[var(--text-dim)] -mt-1">
            OS user the collector runs as on its host. Site Pis use <code className="font-mono-data">pi</code>; assets on the nas123 pi server use <code className="font-mono-data">numed</code>.
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
            Pi install script {props.scriptForAsset ? `— ${assets.find((a) => a.id === props.scriptForAsset)?.name ?? ""}` : ""}
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
            <code className="font-mono-data">sudo systemctl enable --now nm-magmon-gateway</code>{" "}
            and confirm with{" "}
            <code className="font-mono-data">pgrep -c -f nm-magmon-gateway</code>{" "}
            (must print 1).
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
  setEditingAssetId: (v: string | null) => void;
  handleSaveAssetEdit: (e: React.FormEvent) => void;
}) {
  return (
    <form onSubmit={props.handleSaveAssetEdit} className="flex flex-col gap-3 px-4 py-4 border-b border-[var(--border)] last:border-0 bg-[var(--bg-elevated)]">
      <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Editing {props.asset.name}</p>
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
      <p className="text-xs text-[var(--text-dim)] mb-3">
        A rule scoped to <strong>All assets</strong> is the fleet default. Scope a rule to a single asset to
        override the fleet default for just that unit.
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

/* ----------------------------------------------------------------- Users tab */

function UsersTab(props: {
  users: AppUser[];
  userName: string;
  setUserName: (v: string) => void;
  userPin: string;
  setUserPin: (v: string) => void;
  userRole: "viewer" | "admin";
  setUserRole: (v: "viewer" | "admin") => void;
  handleAddUser: (e: React.FormEvent) => void;
  handleToggleRole: (u: AppUser) => void;
  handleToggleTvAccess: (u: AppUser) => void;
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
          <select value={props.userRole} onChange={(e) => props.setUserRole(e.target.value as "viewer" | "admin")} className="input">
            <option value="viewer">Viewer</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <button type="submit" className="btn-primary">Add user</button>
      </form>

      <div className="rounded-xl border border-[var(--border-soft)] overflow-hidden">
        {users.map((u) => (
          <div key={u.username} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[var(--border)] last:border-0">
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
              <button onClick={() => props.handleToggleRole(u)} className="btn-secondary">
                Make {u.role === "admin" ? "viewer" : "admin"}
              </button>
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
  set_invite_code: "Invite code changed",
  create_alert_rule: "Alert rule added",
  update_alert_rule: "Alert rule edited",
  delete_alert_rule: "Alert rule deleted",
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
