"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { supabase, type Site, type Asset } from "@/lib/supabase";
import { generatePiScript } from "@/lib/piScript";
import Protected from "@/components/Protected";
import type { Session } from "@/lib/auth";

const MAGMON_VERSIONS = ["v1", "v2", "v3"];

type AppUser = { username: string; role: "viewer" | "admin"; created_at: string };

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
    const [{ data: siteRows }, { data: assetRows }, { data: userRows }] = await Promise.all([
      supabase.from("sites").select("*").order("name"),
      supabase.from("public_assets").select("*").order("name"),
      supabase.rpc("admin_list_users", { p_actor_username: me.username, p_actor_pin: me.pin }),
    ]);
    setSites(siteRows ?? []);
    setAssets(assetRows ?? []);
    setUsers((userRows as AppUser[]) ?? []);
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
    if (error) return setStatus(`Error adding site: ${error.message}`);
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
    if (error) return setStatus(`Error adding asset: ${error.message}`);
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
    if (error) return setStatus(`Error adding user: ${error.message}`);
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
    setStatus(error ? `Error: ${error.message}` : `PIN reset for ${u.username}.`);
  }

  async function handleToggleRole(u: AppUser) {
    const newRole = u.role === "admin" ? "viewer" : "admin";
    const { error } = await supabase.rpc("admin_set_role", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_target_username: u.username,
      p_new_role: newRole,
    });
    if (error) return setStatus(`Error: ${error.message}`);
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
    if (error || !config) return setStatus(`Error loading asset: ${error?.message ?? "not found"}`);
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
    if (error) return setStatus(`Error saving asset: ${error.message}`);
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
    if (error) return setStatus(`Error deleting asset: ${error.message}`);
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
    if (error) return setStatus(`Error saving site: ${error.message}`);
    setStatus(`Site "${editSiteName}" updated.`);
    setEditingSiteId(null);
    load();
  }

  async function handleDeleteSite(s: Site) {
    const assetCount = assets.filter((a) => a.site_id === s.id).length;
    const warning =
      assetCount > 0
        ? `Delete site "${s.name}"? This will also delete its ${assetCount} asset(s) and all their telemetry history. This cannot be undone.`
        : `Delete site "${s.name}"? This cannot be undone.`;
    if (!confirm(warning)) return;
    setStatus(null);
    const { error } = await supabase.rpc("admin_delete_site", {
      p_actor_username: me.username,
      p_actor_pin: me.pin,
      p_site_id: s.id,
    });
    if (error) return setStatus(`Error deleting site: ${error.message}`);
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
    if (error || !config) return setStatus(`Error retrieving config: ${error?.message ?? "not found"}`);
    buildScript(asset.name, config.gateway_token, config.monitor_host, config.monitor_port, config.monitor_username, config.monitor_password);
    setScriptForAsset(asset.id);
  }

  function downloadScript() {
    if (!scriptText) return;
    const blob = new Blob([scriptText], { type: "text/x-python" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "nm-magmon-gateway.py";
    a.click();
    URL.revokeObjectURL(url);
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
            <button
              onClick={() => {
                const a = assets.find((x) => x.id === scriptForAsset);
                if (a) handleGetScriptForExisting(a);
              }}
              className="btn-secondary"
            >
              Regenerate with this interval
            </button>
            <button onClick={downloadScript} className="btn-primary">Download script</button>
          </div>
          <pre className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-4 overflow-x-auto text-xs font-mono-data max-h-96 whitespace-pre">
            {scriptText}
          </pre>
        </section>
      )}

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
