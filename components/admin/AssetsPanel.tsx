"use client";

// The Assets tab: the fleet list, the add/edit forms, and the collector-script
// panel that generates what gets deployed to a Pi.
//
// Split out of app/admin/page.tsx, which held all of this inline. It was the
// worst of that file: 28 of the page's 66 pieces of state are here, and they
// used to be passed down as 52 separate props — so every keystroke in the
// add-asset name field re-rendered all six tabs. They are local now, and the
// panel takes six props.
//
// Nothing below was rewritten in the move.

import { useEffect, useMemo, useState } from "react";
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
import {
  adminCreateAsset,
  adminUpdateAsset,
  adminDeleteAsset,
  adminGetAssetConfig,
  adminRotateGatewayToken,
  adminSetAssetMaintenance,
  type SiteGeocodeRow,
} from "@/lib/adminActions";
import SiteLocationRow from "@/components/SiteLocationRow";
import { addressKey } from "@/lib/weatherFormat";
import { Field, PasswordField, type Toast } from "./shared";

const NO_LOCATION = "No location set";

export default function AssetsPanel({
  assets,
  geocodes,
  reload,
  notify,
  fail,
  askConfirm,
}: {
  assets: Asset[];
  geocodes: Record<string, SiteGeocodeRow>;
  /** Re-read the shell's shared data after a mutation. */
  reload: () => void;
  notify: (msg: string, kind?: Toast["kind"]) => void;
  fail: (msg: string) => void;
  askConfirm: (message: string, danger?: boolean) => Promise<boolean>;
}) {
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
    reload();
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
    reload();
  }

  async function handleDeleteAsset(a: Asset) {
    if (!(await askConfirm(`Delete asset "${a.name}"? This also deletes all its telemetry history. This cannot be undone.`, true))) return;
    const { error } = await adminDeleteAsset(a.id);
    if (error) return fail(actionError("Could not delete asset", error));
    notify(`Asset "${a.name}" deleted.`);
    if (editingAssetId === a.id) setEditingAssetId(null);
    reload();
  }

  async function handleToggleMaintenance(a: Asset) {
    const { error } = await adminSetAssetMaintenance(a.id, !a.maintenance);
    if (error) return fail(actionError("Could not update maintenance mode", error));
    notify(
      a.maintenance
        ? `Maintenance cleared for "${a.name}".`
        : `"${a.name}" set to maintenance — TV/Display alarms muted for this unit.`
    );
    reload();
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
    /**
     * Which collector to generate, when the unit could run either.
     *
     * A MagMon unit that has also been fitted with a UPS or zone sensors runs
     * BOTH collectors on the same Pi, for the same asset — NM1019 is the first.
     * Modality alone cannot express that: it says whether there is a magnet to
     * scrape, not what else is bolted to the trailer. Left unset, modality
     * still decides, so nothing changes for a unit with only one of the two.
     */
    variant?: "magmon" | "env";
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
    if (opts.variant === "env" || !usesMagmon(opts.modality)) {
      setScriptText(
        generateEnvPiScript({
          ...shared,
          // A magnet that also carries env hardware gets a script that says so:
          // the header is the install instructions a tech reads on the Pi, and
          // on a mixed unit it has to mention the MagMon collector running
          // beside it rather than claim to be the only thing on the box.
          modality: opts.modality,
          alongsideMagmon: usesMagmon(opts.modality),
        })
      );
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

  async function handleGetScriptForExisting(asset: Asset, variant?: "magmon" | "env") {
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
      variant,
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
  return (
    <AssetsTab
      assets={assets}
      geocodes={geocodes}
      reloadGeocodes={reload}
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
  handleGetScriptForExisting: (a: Asset, variant?: "magmon" | "env") => void;
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
            {/*
              A magnet fitted with a UPS or a zone sensor runs BOTH collectors —
              two scripts, two units, two lock files, one asset. Without this
              switch the panel could only ever hand out the MagMon script for an
              MRI unit, and the env half of the install had nowhere to come from.
              Only shown for a MagMon unit: a PET/CT trailer has one collector
              and a choice would be a choice between one option and a broken one.
            */}
            {(() => {
              const a = assets.find((x) => x.id === props.scriptForAsset);
              if (!a || !usesMagmon(a.modality)) return null;
              return (
                <Field label="Collector">
                  <div className="flex rounded-md border border-[var(--border)] overflow-hidden">
                    {(["magmon", "env"] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => props.handleGetScriptForExisting(a, v)}
                        className={`px-3 py-1.5 text-xs ${
                          props.scriptVariant === v
                            ? "bg-[var(--accent)] text-black"
                            : "bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text)]"
                        }`}
                      >
                        {v === "magmon" ? "MagMon" : "Environmental"}
                      </button>
                    ))}
                  </div>
                </Field>
              );
            })()}
            <button
              onClick={() => {
                const a = assets.find((x) => x.id === props.scriptForAsset);
                if (a) props.handleGetScriptForExisting(a, props.scriptVariant);
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


function CollectorVersion({ asset }: { asset: Asset }) {
  // ONE LINE PER COLLECTOR THE UNIT ACTUALLY RUNS, not one line per unit.
  //
  // The two collectors are separate programs with separate version stamps, and
  // a unit can run both: NM1019's Pi scrapes its MagMon and reads a UPS and a
  // bay sensor for the same asset. Reporting a single version there would have
  // to pick one program and hide the other's drift — and while both stamps
  // shared assets.collector_version, the two overwrote each other every minute.
  //
  // The env line shows when the unit has reported an env version even if its
  // modality is MRI: environmental hardware is an addition to a magnet, not a
  // different kind of unit, so presence is what decides. Comparing a PET/CT
  // asset against the MagMon generator's version would mark it permanently
  // "behind", which is why the two are compared against their own constants.
  const lines: { label: string; reported: string | null; current: string }[] = [];
  if (usesMagmon(asset.modality)) {
    lines.push({ label: "collector", reported: asset.collector_version ?? null, current: COLLECTOR_VERSION });
  }
  if (!usesMagmon(asset.modality) || asset.env_collector_version) {
    lines.push({
      label: "env collector",
      reported: asset.env_collector_version ?? null,
      current: ENV_COLLECTOR_VERSION,
    });
  }

  return (
    <>
      {lines.map(({ label, reported, current }) => {
        const state = reported === null ? "unknown" : reported === current ? "ok" : "behind";
        if (state === "ok") {
          return (
            <p key={label} className="text-[10px] text-[var(--text-dim)] font-mono-data mt-0.5">
              {label} {reported}
            </p>
          );
        }
        const color = state === "behind" ? "#fbbf24" : "var(--text-dim)";
        return (
          <p key={label} className="text-[10px] mt-0.5 font-mono-data" style={{ color }}>
            {label} {reported ?? "version unknown"}
            <span className="ml-1.5 font-sans">
              {state === "behind"
                ? `— behind, current is ${current}`
                : `— predates version reporting; redeploy to find out`}
            </span>
          </p>
        );
      })}
    </>
  );
}

