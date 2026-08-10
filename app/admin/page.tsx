"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { supabase, type Site, type Asset } from "@/lib/supabase";
import { generatePiScript, generateSystemdUnit } from "@/lib/piScript";
import { actionError } from "@/lib/errors";
import Protected from "@/components/Protected";
import type { Session } from "@/lib/auth";

const MAGMON_VERSIONS = ["v1", "v2", "v3"];

const ALERT_METRICS: { key: string; label: string; unit: string }[] = [
  { key: "he_lvl", label: "Helium level", unit: "%" },
  { key: "he_press", label: "Helium pressure", unit: "" },
  { key: "h2o_flow", label: "Water flow", unit: "gpm" },
  { key: "h2o_temp", label: "Water temp", unit: "°F" },
  { key: "shield", label: "Shield temp", unit: "" },
  { key: "cs1", label: "CS1 / compressor", unit: "" },
];
const ALERT_COMPARATORS = ["<", "<=", ">", ">=", "=", "!="];

type AppUser = { username: string; role: "viewer" | "admin"; created_at: string };
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

export default function AdminPage() {
  return <Protected requireAdmin>{(session) => <AdminPanel me={session} />}</Protected>;
}

function AdminPanel({ me }: { me: Session }) {
  const [sites, setSites] = useState<Site[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const [siteName, setSiteName] = useState("");
  const [siteAddress, setSiteAddress] = useState("");

  const [assetSiteId, setAssetSiteId] = useState("");
  const [assetName, setAssetName] = useState("");
  const [assetVersion, setAssetVersion] = useState(MAGMON_VERSIONS[2]);
  const [offlineThreshold, setOfflineThreshold] = useState(15);
  const [monitorHost, setMonitorHost] = useState("");
  const [monitorPort, setMonitorPort] = useState(80);
  const [monitorUsername, setMonitorUsername] = useState("MMService");
  const [monitorPassword, setMonitorPassword] = useState("MagnetMonitor");

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

  // alert rules
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleScope, setRuleScope] = useState<string>(""); // "" = all assets (fleet default)
  const [ruleField, setRuleField] = useState<string>(ALERT_METRICS[1].key);
  const [ruleComparator, setRuleComparator] = useState<string>(">");
  const [ruleThreshold, setRuleThreshold] = useState<number>(3);
  const [ruleEnabled, setRuleEnabled] = useState<boolean>(true);

  // editing
  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSiteId, setEditSiteId] = useState("");
  const [editVersion, setEditVersion] = useState(MAGMON_VERSIONS[2]);
  const [editThreshold, setEditThreshold] = useState(15);
  const [editHost, setEditHost] = useState("");
  const [editPort, setEditPort] = useState(80);
  const [editUsername, setEditUsername] = useState("MMService");
  const [editPassword, setEditPassword] = useState("MagnetMonitor");

  const [editingSiteId, setEditingSiteId] = useState<string | null>(null);
  const [editSiteName, setEditSiteName] = useState("");
  const [editSiteAddress, setEditSiteAddress] = useState("");

  const load = useCallback(async () => {
    const [{ data: siteRows }, { data: assetRows }, { data: userRows }, { data: ruleRows }] = await Promise.all([
      supabase.from("sites").select("*").order("name"),
      supabase.from("public_assets").select("*").order("name"),
      supabase.rpc("admin_list_users", { p_actor_username: me.username, p_actor_pin: me.pin }),
      supabase.rpc("admin_list_alert_rules", { p_actor_username: me.username, p_actor_pin: me.pin }),
    ]);
    setSites(siteRows ?? []);
    setAssets(assetRows ?? []);
    setUsers((userRows as AppUser[]) ?? []);
    setAlertRules((ruleRows as AlertRule[]) ?? []);
    if (siteRows && siteRows.length > 0 && !assetSiteId) setAssetSiteId(siteRows[0].id);
  }, [assetSiteId, me.username, me.pin]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAddSite(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    const { error } = await supabase.rpc("admin_create_site", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_name: siteName,
      p_address: siteAddress || null,
    });
    if (error) return setStatus(actionError("Could not add site", error));
    setSiteName("");
    setSiteAddress("");
    setStatus(`Site "${siteName}" added.`);
    load();
  }

  async function handleAddAsset(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    const { data, error } = await supabase.rpc("admin_create_asset", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_site_id: assetSiteId,
      p_name: assetName,
      p_magmon_version: assetVersion,
      p_offline_threshold_minutes: offlineThreshold,
      p_monitor_host: monitorHost,
      p_monitor_port: monitorPort,
      p_monitor_username: monitorUsername,
      p_monitor_password: monitorPassword,
    });
    if (error) return setStatus(actionError("Could not add asset", error));
    setStatus(`Asset "${assetName}" added. Generate its install script below.`);
    setAssetName("");
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
    buildScript(created.name, created.gateway_token, created.monitor_host, created.monitor_port, created.monitor_username, created.monitor_password);
    setScriptForAsset(created.id);
  }

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    const { error } = await supabase.rpc("admin_create_user", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_new_username: userName,
      p_new_pin: userPin,
      p_role: userRole,
    });
    if (error) return setStatus(actionError("Could not add user", error));
    setStatus(`User "${userName}" created.`);
    setUserName("");
    setUserPin("");
    setUserRole("viewer");
    load();
  }

  async function handleResetPin(u: AppUser) {
    const newPin = prompt(`New PIN for ${u.username} (min 4 characters):`);
    if (!newPin) return;
    const { error } = await supabase.rpc("admin_reset_pin", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_target_username: u.username,
      p_new_pin: newPin,
    });
    setStatus(error ? actionError("Could not reset PIN", error) : `PIN reset for ${u.username}.`);
  }

  async function handleToggleRole(u: AppUser) {
    const newRole = u.role === "admin" ? "viewer" : "admin";
    const { error } = await supabase.rpc("admin_set_role", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_target_username: u.username,
      p_new_role: newRole,
    });
    if (error) return setStatus(actionError("Could not change role", error));
    setStatus(`${u.username} is now ${newRole}.`);
    load();
  }

  async function handleStartEditAsset(asset: Asset) {
    setStatus(null);
    const { data, error } = await supabase.rpc("admin_get_asset_config", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_asset_id: asset.id,
    });
    const config = data && data[0];
    if (error || !config) return setStatus(error ? actionError("Could not load asset", error) : "Could not load asset: not found.");
    setEditingAssetId(asset.id);
    setEditName(asset.name);
    setEditSiteId(asset.site_id);
    setEditVersion(asset.magmon_version);
    setEditThreshold(asset.offline_threshold_minutes ?? 15);
    setEditHost(config.monitor_host ?? "");
    setEditPort(config.monitor_port ?? 80);
    setEditUsername(config.monitor_username ?? "MMService");
    setEditPassword(config.monitor_password ?? "MagnetMonitor");
  }

  async function handleSaveAssetEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingAssetId) return;
    setStatus(null);
    const { error } = await supabase.rpc("admin_update_asset", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_asset_id: editingAssetId,
      p_name: editName,
      p_site_id: editSiteId,
      p_magmon_version: editVersion,
      p_offline_threshold_minutes: editThreshold,
      p_monitor_host: editHost,
      p_monitor_port: editPort,
      p_monitor_username: editUsername,
      p_monitor_password: editPassword,
    });
    if (error) return setStatus(actionError("Could not save asset", error));
    setStatus(`Asset "${editName}" updated.`);
    setEditingAssetId(null);
    load();
  }

  async function handleDeleteAsset(a: Asset) {
    if (!confirm(`Delete asset "${a.name}"? This also deletes all its telemetry history. This cannot be undone.`)) return;
    setStatus(null);
    const { error } = await supabase.rpc("admin_delete_asset", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_asset_id: a.id,
    });
    if (error) return setStatus(actionError("Could not delete asset", error));
    setStatus(`Asset "${a.name}" deleted.`);
    if (editingAssetId === a.id) setEditingAssetId(null);
    load();
  }

  function handleStartEditSite(s: Site) {
    setEditingSiteId(s.id);
    setEditSiteName(s.name);
    setEditSiteAddress(s.address ?? "");
  }

  async function handleSaveSiteEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingSiteId) return;
    setStatus(null);
    const { error } = await supabase.rpc("admin_update_site", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_site_id: editingSiteId,
      p_name: editSiteName,
      p_address: editSiteAddress || null,
    });
    if (error) return setStatus(actionError("Could not save site", error));
    setStatus(`Site "${editSiteName}" updated.`);
    setEditingSiteId(null);
    load();
  }

  async function handleDeleteSite(s: Site) {
    // The database now refuses this outright (admin_delete_site raises when
    // assets are attached), because assets.site_id and telemetry_samples both
    // cascade — deleting a site would silently take out the asset, its gateway
    // token, and every reading. Catch it here so the admin gets a useful
    // explanation instead of a round trip to a server error; the RPC guard is
    // still the real enforcement.
    const attached = assets.filter((a) => a.site_id === s.id);
    if (attached.length > 0) {
      return setStatus(
        `Cannot delete site "${s.name}": ${attached.length} asset(s) still attached (${attached
          .map((a) => a.name)
          .join(", ")}). Delete or move them first.`
      );
    }
    if (!confirm(`Delete site "${s.name}"? This cannot be undone.`)) return;
    setStatus(null);
    const { error } = await supabase.rpc("admin_delete_site", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_site_id: s.id,
    });
    if (error) return setStatus(actionError("Could not delete site", error));
    setStatus(`Site "${s.name}" deleted.`);
    load();
  }

  function buildScript(
    name: string,
    token: string,
    host: string,
    port: number,
    username: string,
    password: string
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
      serviceUser,
    });
    setScriptText(script);
  }

  async function handleGetScriptForExisting(asset: Asset) {
    setStatus(null);
    const { data, error } = await supabase.rpc("admin_get_asset_config", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_asset_id: asset.id,
    });
    const config = data && data[0];
    if (error || !config) return setStatus(error ? actionError("Could not retrieve config", error) : "Could not retrieve config: not found.");
    buildScript(asset.name, config.gateway_token, config.monitor_host, config.monitor_port, config.monitor_username, config.monitor_password);
    setScriptForAsset(asset.id);
  }

  async function handleRotateToken() {
    const asset = assets.find((a) => a.id === scriptForAsset);
    if (!asset) return;
    if (
      !confirm(
        `Rotate the gateway token for "${asset.name}"?\n\nThe Pi will stop reporting until you download the new script and deploy it. Telemetry already collected is NOT affected.`
      )
    )
      return;
    setStatus(null);
    const { error } = await supabase.rpc("admin_rotate_gateway_token", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_asset_id: asset.id,
    });
    if (error) return setStatus(actionError("Could not rotate token", error));
    setStatus(
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
    setStatus(null);
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
    if (error) return setStatus(actionError("Could not save alert rule", error));
    setStatus(editingRuleId ? "Alert rule updated." : "Alert rule added.");
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
    if (error) return setStatus(actionError("Could not update alert rule", error));
    load();
  }

  async function handleDeleteRule(r: AlertRule) {
    const metric = ALERT_METRICS.find((m) => m.key === r.field)?.label ?? r.field;
    if (!confirm(`Delete this alert rule (${metric} ${r.comparator} ${Number(r.threshold)})?`)) return;
    setStatus(null);
    const { error } = await supabase.rpc("admin_delete_alert_rule", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_rule_id: r.id,
    });
    if (error) return setStatus(actionError("Could not delete alert rule", error));
    setStatus("Alert rule deleted.");
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

  return (
    <div id="main-content" className="min-h-screen p-6 md:p-10 max-w-5xl mx-auto" role="main">
      <Link href="/" className="text-xs text-[var(--text-dim)] hover:text-[var(--accent)]">
        &larr; Back to dashboard
      </Link>
      <h1 className="text-2xl md:text-3xl font-semibold mt-4 mb-8">Admin</h1>

      {status && (
        <p className="mb-6 text-sm font-mono-data rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2" role="status" aria-live="polite">
          {status}
        </p>
      )}

      <div className="grid md:grid-cols-2 gap-6 mb-10">
        <form onSubmit={handleAddSite} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 flex flex-col gap-3">
          <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)]">Add site</h2>
          <Field label="Site name">
            <input required value={siteName} onChange={(e) => setSiteName(e.target.value)} className="input" />
          </Field>
          <Field label="Address (optional)">
            <input value={siteAddress} onChange={(e) => setSiteAddress(e.target.value)} className="input" />
          </Field>
          <button type="submit" className="btn-primary">Add site</button>
        </form>

        <form onSubmit={handleAddAsset} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 flex flex-col gap-3">
          <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)]">Add MagMon asset</h2>
          <Field label="Site">
            <select required value={assetSiteId} onChange={(e) => setAssetSiteId(e.target.value)} className="input">
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Asset name">
            <input required value={assetName} onChange={(e) => setAssetName(e.target.value)} placeholder="e.g. CA1012-SETONSW" className="input" />
          </Field>
          <Field label="MagMon version">
            <select value={assetVersion} onChange={(e) => setAssetVersion(e.target.value)} className="input">
              {MAGMON_VERSIONS.map((v) => (
                <option key={v} value={v}>{v.toUpperCase()}</option>
              ))}
            </select>
          </Field>
          <Field label="Offline alert threshold (minutes)">
            <input type="number" min={1} value={offlineThreshold} onChange={(e) => setOfflineThreshold(Number(e.target.value))} className="input" />
          </Field>
          <Field label="MagMon local IP">
            <input required value={monitorHost} onChange={(e) => setMonitorHost(e.target.value)} placeholder="e.g. 192.168.1.50" className="input font-mono-data" />
          </Field>
          <div className="flex flex-wrap gap-3">
            <Field label="Port">
              <input type="number" value={monitorPort} onChange={(e) => setMonitorPort(Number(e.target.value))} className="input w-20" />
            </Field>
            <Field label="Username">
              <input value={monitorUsername} onChange={(e) => setMonitorUsername(e.target.value)} className="input" />
            </Field>
            <Field label="Password">
              <input value={monitorPassword} onChange={(e) => setMonitorPassword(e.target.value)} className="input" />
            </Field>
          </div>
          <button type="submit" className="btn-primary" disabled={sites.length === 0}>Add asset</button>
          {sites.length === 0 && <p className="text-xs text-[var(--text-dim)]">Add a site first.</p>}
        </form>
      </div>

      <section className="mb-10">
        <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-3">Existing sites</h2>
        <div className="rounded-lg border border-[var(--border)] overflow-hidden">
          {sites.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[var(--border)] last:border-0">
              <div>
                <p className="font-medium">{s.name}</p>
                {s.address && <p className="text-xs text-[var(--text-dim)]">{s.address}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => handleStartEditSite(s)} className="btn-secondary">Edit</button>
                <button onClick={() => handleDeleteSite(s)} className="btn-secondary" style={{ color: "var(--status-offline)" }}>Delete</button>
              </div>
            </div>
          ))}
          {sites.length === 0 && <p className="px-4 py-6 text-center text-[var(--text-dim)]">No sites yet.</p>}
        </div>
      </section>

      {editingSiteId && (
        <section className="mb-10">
          <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-3">
            Edit site &mdash; {sites.find((s) => s.id === editingSiteId)?.name}
          </h2>
          <form onSubmit={handleSaveSiteEdit} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 flex flex-col gap-3 max-w-md">
            <Field label="Site name">
              <input required value={editSiteName} onChange={(e) => setEditSiteName(e.target.value)} className="input" />
            </Field>
            <Field label="Address (optional)">
              <input value={editSiteAddress} onChange={(e) => setEditSiteAddress(e.target.value)} className="input" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className="btn-primary">Save changes</button>
              <button type="button" onClick={() => setEditingSiteId(null)} className="btn-secondary">Cancel</button>
            </div>
          </form>
        </section>
      )}

      <section className="mb-10">
        <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-3">Existing assets</h2>
        <div className="rounded-lg border border-[var(--border)] overflow-hidden">
          {assets.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[var(--border)] last:border-0">
              <div>
                <p className="font-medium">{a.name}</p>
                <p className="text-xs text-[var(--text-dim)]">{a.magmon_version.toUpperCase()}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => handleGetScriptForExisting(a)} className="btn-secondary">Get install script</button>
                <button onClick={() => handleStartEditAsset(a)} className="btn-secondary">Edit</button>
                <button onClick={() => handleDeleteAsset(a)} className="btn-secondary" style={{ color: "var(--status-offline)" }}>Delete</button>
              </div>
            </div>
          ))}
          {assets.length === 0 && <p className="px-4 py-6 text-center text-[var(--text-dim)]">No assets yet.</p>}
        </div>
      </section>

      {editingAssetId && (
        <section className="mb-10">
          <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-3">
            Edit asset &mdash; {assets.find((a) => a.id === editingAssetId)?.name}
          </h2>
          <form onSubmit={handleSaveAssetEdit} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 flex flex-col gap-3 max-w-xl">
            <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
              Site
              <select required value={editSiteId} onChange={(e) => setEditSiteId(e.target.value)} className="input">
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
              Asset name
              <input required value={editName} onChange={(e) => setEditName(e.target.value)} className="input" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
              MagMon version
              <select value={editVersion} onChange={(e) => setEditVersion(e.target.value)} className="input">
                {MAGMON_VERSIONS.map((v) => (
                  <option key={v} value={v}>{v.toUpperCase()}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
              Offline alert threshold (minutes)
              <input type="number" min={1} value={editThreshold} onChange={(e) => setEditThreshold(Number(e.target.value))} className="input" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
              MagMon local IP
              <input required value={editHost} onChange={(e) => setEditHost(e.target.value)} className="input font-mono-data" />
            </label>
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
                Port
                <input type="number" value={editPort} onChange={(e) => setEditPort(Number(e.target.value))} className="input w-20" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
                Username
                <input value={editUsername} onChange={(e) => setEditUsername(e.target.value)} className="input" />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--text-dim)]">
                Password
                <input value={editPassword} onChange={(e) => setEditPassword(e.target.value)} className="input" />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className="btn-primary">Save changes</button>
              <button type="button" onClick={() => setEditingAssetId(null)} className="btn-secondary">Cancel</button>
            </div>
            <p className="text-xs text-[var(--text-dim)]">
              Note: if you change the local IP, port, username, or password here, re-download the install script for this asset so the Pi&apos;s copy matches.
            </p>
          </form>
        </section>
      )}

      {scriptText && (
        <section className="mb-10">
          <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-3">
            Pi install script {scriptForAsset ? `— ${assets.find((a) => a.id === scriptForAsset)?.name ?? ""}` : ""}
          </h2>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 mb-3 flex flex-wrap items-end gap-4">
            <Field label="Poll interval (min)">
              <input type="number" min={1} value={pollMinutes} onChange={(e) => setPollMinutes(Number(e.target.value))} className="input w-24" />
            </Field>
            <Field label="Service user">
              <input value={serviceUser} onChange={(e) => setServiceUser(e.target.value)} placeholder="pi" className="input w-28 font-mono-data" />
            </Field>
            <button
              onClick={() => {
                const a = assets.find((x) => x.id === scriptForAsset);
                if (a) handleGetScriptForExisting(a);
              }}
              className="btn-secondary"
            >
              Regenerate
            </button>
            <button onClick={downloadScript} className="btn-primary">Download script</button>
            <button onClick={downloadUnitFile} className="btn-secondary">Download systemd unit</button>
            <button onClick={handleRotateToken} className="btn-secondary">Rotate token</button>
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
            {scriptText}
          </pre>
        </section>
      )}

      <section className="mb-10">
        <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-3">Alerts</h2>
        <p className="text-xs text-[var(--text-dim)] mb-3">
          A rule scoped to <strong>All assets</strong> is the fleet default. Scope a rule to a single asset to
          override the fleet default for just that unit.
        </p>
        <form onSubmit={handleSaveRule} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 flex flex-wrap items-end gap-4 mb-4">
          <Field label="Scope">
            <select value={ruleScope} onChange={(e) => setRuleScope(e.target.value)} className="input">
              <option value="">All assets</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Metric">
            <select value={ruleField} onChange={(e) => setRuleField(e.target.value)} className="input">
              {ALERT_METRICS.map((m) => (
                <option key={m.key} value={m.key}>{m.label}{m.unit ? ` (${m.unit})` : ""}</option>
              ))}
            </select>
          </Field>
          <Field label="Condition">
            <select value={ruleComparator} onChange={(e) => setRuleComparator(e.target.value)} className="input w-20 font-mono-data">
              {ALERT_COMPARATORS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Threshold">
            <input type="number" step="any" value={ruleThreshold} onChange={(e) => setRuleThreshold(Number(e.target.value))} className="input w-28 font-mono-data" />
          </Field>
          <label className="flex items-center gap-2 text-xs text-[var(--text-dim)]">
            <input type="checkbox" checked={ruleEnabled} onChange={(e) => setRuleEnabled(e.target.checked)} />
            Enabled
          </label>
          <button type="submit" className="btn-primary">{editingRuleId ? "Save rule" : "Add rule"}</button>
          {editingRuleId && (
            <button type="button" onClick={resetRuleForm} className="btn-secondary">Cancel</button>
          )}
        </form>

        <div className="rounded-lg border border-[var(--border)] overflow-hidden mb-10">
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
                  <button onClick={() => handleToggleRule(r)} className="btn-secondary">{r.enabled ? "Disable" : "Enable"}</button>
                  <button onClick={() => handleEditRule(r)} className="btn-secondary">Edit</button>
                  <button onClick={() => handleDeleteRule(r)} className="btn-secondary" style={{ color: "var(--status-offline)" }}>Delete</button>
                </div>
              </div>
            );
          })}
          {alertRules.length === 0 && <p className="px-4 py-6 text-center text-[var(--text-dim)]">No alert rules yet.</p>}
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-3">Users</h2>
        <form onSubmit={handleAddUser} className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 flex flex-wrap items-end gap-4 mb-4">
          <Field label="Username">
            <input required value={userName} onChange={(e) => setUserName(e.target.value)} className="input" />
          </Field>
          <Field label="PIN (min 4 characters)">
            <input required minLength={4} value={userPin} onChange={(e) => setUserPin(e.target.value)} className="input font-mono-data" />
          </Field>
          <Field label="Role">
            <select value={userRole} onChange={(e) => setUserRole(e.target.value as "viewer" | "admin")} className="input">
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
          <button type="submit" className="btn-primary">Add user</button>
        </form>

        <div className="rounded-lg border border-[var(--border)] overflow-hidden">
          {users.map((u) => (
            <div key={u.username} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[var(--border)] last:border-0">
              <div>
                <p className="font-medium">{u.username}</p>
                <p className="text-xs text-[var(--text-dim)] capitalize">{u.role}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => handleToggleRole(u)} className="btn-secondary">
                  Make {u.role === "admin" ? "viewer" : "admin"}
                </button>
                <button onClick={() => handleResetPin(u)} className="btn-secondary">Reset PIN</button>
              </div>
            </div>
          ))}
          {users.length === 0 && <p className="px-4 py-6 text-center text-[var(--text-dim)]">No users yet.</p>}
        </div>
      </section>
    </div>
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
