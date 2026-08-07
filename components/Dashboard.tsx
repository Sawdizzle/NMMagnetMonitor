"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { supabase, type Site, type Asset, type TelemetrySample } from "@/lib/supabase";
import { computeAssetHealth, minutesSince, STATUS_COLORS } from "@/lib/health";
import FieldRing from "./FieldRing";
import MiniLineChart from "./MiniLineChart";

type AssetWithTelemetry = Asset & {
  site: Site | null;
  latest: TelemetrySample | null;
  history: TelemetrySample[];
};

const POLL_MS = 30_000;
const HISTORY_HOURS = 1;

const METRICS: { key: keyof TelemetrySample; label: string; unit: string; color: string }[] = [
  { key: "he_lvl", label: "He Lvl", unit: "%", color: "#5b8def" },
  { key: "h2o_flow", label: "H2O Flow", unit: "gpm", color: "#2fd47a" },
  { key: "he_press", label: "He Press", unit: "psi", color: "#f0a84a" },
  { key: "h2o_temp", label: "H2O Temp", unit: "°F", color: "#e15b8f" },
  { key: "shield", label: "Shield", unit: "", color: "#a679f2" },
  { key: "cs1", label: "CS1", unit: "", color: "#4ad4d4" },
];

export default function Dashboard() {
  const [assets, setAssets] = useState<AssetWithTelemetry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "offline" | "unknown">("all");

  const load = useCallback(async () => {
    const historyCutoff = new Date(Date.now() - HISTORY_HOURS * 60 * 60 * 1000).toISOString();

    const [
      { data: sites, error: sitesErr },
      { data: assetRows, error: assetsErr },
      { data: latest, error: latestErr },
      { data: history, error: historyErr },
    ] = await Promise.all([
      supabase.from("sites").select("*"),
      supabase.from("public_assets").select("*").order("name"),
      supabase.from("latest_telemetry").select("*"),
      supabase
        .from("telemetry_samples")
        .select("*")
        .gte("recorded_at", historyCutoff)
        .order("recorded_at", { ascending: true })
        .limit(5000),
    ]);

    if (sitesErr || assetsErr || latestErr || historyErr) {
      setError(
        sitesErr?.message || assetsErr?.message || latestErr?.message || historyErr?.message || "Failed to load"
      );
      return;
    }

    const siteById = new Map((sites ?? []).map((s) => [s.id, s]));
    const latestByAsset = new Map((latest ?? []).map((t) => [t.asset_id, t]));
    const historyByAsset = new Map<string, TelemetrySample[]>();
    for (const sample of history ?? []) {
      const arr = historyByAsset.get(sample.asset_id) ?? [];
      arr.push(sample);
      historyByAsset.set(sample.asset_id, arr);
    }

    const merged: AssetWithTelemetry[] = (assetRows ?? []).map((a) => ({
      ...a,
      site: siteById.get(a.site_id) ?? null,
      latest: latestByAsset.get(a.id) ?? null,
      history: historyByAsset.get(a.id) ?? [],
    }));

    setAssets(merged);
    setError(null);
    setLoading(false);
    setLastRefreshed(new Date());
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  const filteredAssets =
    statusFilter === "all" ? assets : assets.filter((a) => computeAssetHealth(a) === statusFilter);

  const bySite = new Map<string, AssetWithTelemetry[]>();
  for (const a of filteredAssets) {
    const key = a.site?.name ?? "Unassigned";
    if (!bySite.has(key)) bySite.set(key, []);
    bySite.get(key)!.push(a);
  }

  const onlineCount = assets.filter((a) => computeAssetHealth(a) === "online").length;
  const offlineCount = assets.filter((a) => computeAssetHealth(a) === "offline").length;
  const unknownCount = assets.filter((a) => computeAssetHealth(a) === "unknown").length;

  return (
    <div id="main-content" className="min-h-screen p-6 md:p-10" role="main">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between mb-10">
        <div>
          <p className="text-xs tracking-[0.2em] uppercase text-[var(--text-dim)] mb-1">
            Numed &middot; Remote Monitoring
          </p>
          <h1 className="text-2xl md:text-3xl font-semibold">MagMon Fleet Dashboard</h1>
        </div>
        <div className="flex items-center gap-6 font-mono-data text-sm" role="group" aria-label="Filter assets by status">
          <StatusPill
            color={STATUS_COLORS.online}
            label={`${onlineCount} online`}
            active={statusFilter === "online"}
            onClick={() => setStatusFilter(statusFilter === "online" ? "all" : "online")}
          />
          <StatusPill
            color={STATUS_COLORS.offline}
            label={`${offlineCount} offline`}
            active={statusFilter === "offline"}
            onClick={() => setStatusFilter(statusFilter === "offline" ? "all" : "offline")}
          />
          <StatusPill
            color={STATUS_COLORS.unknown}
            label={`${unknownCount} unknown`}
            active={statusFilter === "unknown"}
            onClick={() => setStatusFilter(statusFilter === "unknown" ? "all" : "unknown")}
          />
          {statusFilter !== "all" && (
            <button
              onClick={() => setStatusFilter("all")}
              className="text-[var(--text-dim)] hover:text-[var(--accent)] text-xs underline"
            >
              clear filter
            </button>
          )}
          <span className="text-[var(--text-dim)]">
            {lastRefreshed ? `updated ${lastRefreshed.toLocaleTimeString()}` : ""}
          </span>
        </div>
      </header>

      {loading && <p className="text-[var(--text-muted)]" aria-live="polite">Loading fleet status&hellip;</p>}
      {error && (
        <p className="text-[var(--status-offline)] font-mono-data text-sm" role="alert">Error: {error}</p>
      )}

      {!loading && !error && assets.length === 0 && (
        <div className="rounded-lg border border-dashed border-[var(--border)] p-10 text-center text-[var(--text-muted)]" aria-live="polite">
          No MagMon assets yet. Add a site and asset in the admin panel to see it here.
        </div>
      )}

      {!loading && !error && assets.length > 0 && filteredAssets.length === 0 && (
        <div className="rounded-lg border border-dashed border-[var(--border)] p-10 text-center text-[var(--text-muted)]" aria-live="polite">
          No assets match the current filter.
        </div>
      )}

      <div className="flex flex-col gap-10">
        {[...bySite.entries()].map(([siteName, siteAssets]) => (
          <section key={siteName}>
            <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-3">
              {siteName}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {siteAssets.map((a) => (
                <AssetCard key={a.id} asset={a} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function StatusPill({
  color,
  label,
  active,
  onClick,
}: {
  color: string;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className="flex items-center gap-2 rounded-full px-3 transition-colors"
      style={{
        backgroundColor: active ? "var(--bg-elevated)" : "transparent",
        border: active ? "1px solid var(--border)" : "1px solid transparent",
      }}
    >
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      {label}
    </button>
  );
}

function AssetCard({ asset }: { asset: AssetWithTelemetry }) {
  const status = computeAssetHealth(asset);
  const mins = minutesSince(asset.last_seen_at);

  return (
    <Link
      href={`/asset/${asset.id}`}
      aria-label={`${asset.name}, ${status}, ${mins === null ? "never reported" : `last seen ${mins} minutes ago`}. View details.`}
      className="group rounded-xl border border-[var(--border)] bg-[var(--card)] hover:bg-[var(--card-hover)] transition-colors p-5 flex flex-col gap-4"
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="font-semibold text-base">{asset.name}</p>
          <p className="text-xs text-[var(--text-dim)] mt-0.5">
            {asset.magmon_version.toUpperCase()}
          </p>
        </div>
        <FieldRing status={status} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        {METRICS.map((m) => {
          const value = asset.latest?.[m.key] as number | null | undefined;
          const series = asset.history.map((h) => h[m.key] as number | null | undefined);
          return (
            <div key={m.key} className="rounded-md bg-[var(--bg-elevated)] px-2 py-1.5 flex flex-col gap-1">
              <p className="text-[var(--text-dim)] text-[10px] uppercase tracking-wide">{m.label}</p>
              <p className="font-mono-data text-sm text-[var(--text)]">
                {value ?? "—"} <span className="text-[var(--text-dim)] text-[10px]">{m.unit}</span>
              </p>
              <MiniLineChart values={series} width={90} height={22} color={m.color} />
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between text-xs text-[var(--text-dim)] pt-1 border-t border-[var(--border)]">
        <span className="capitalize" style={{ color: STATUS_COLORS[status] }}>
          {status}
        </span>
        <span>{mins === null ? "never reported" : `${mins} min ago`}</span>
      </div>
    </Link>
  );
}
