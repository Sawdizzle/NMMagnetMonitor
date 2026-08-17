"use client";

import { useEffect, useState, useCallback, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type TelemetrySample } from "@/lib/supabase";
import { getDataSource, type FleetAsset } from "@/lib/dataSource";
import { useDemo } from "@/lib/demoContext";
import { computeAssetHealth, connectivityStatuses, CONNECTIVITY_COLORS, minutesSince, STATUS_COLORS, STATUS_LABELS } from "@/lib/health";
import { computeAssetAlarm, sortByAlarmPriority, buildAlertItems, ALARM_COLORS, type FaultSeverity } from "@/lib/faults";
import { useFleetForecasts } from "@/lib/useFleetForecasts";
import { refillChipLabel, refillUrgency, type HeliumForecast } from "@/lib/forecast";
import FieldRing from "./FieldRing";
import MiniLineChart from "./MiniLineChart";
import OrgMark from "./OrgMark";

type AssetWithTelemetry = FleetAsset;

const POLL_MS = 30_000;
const HISTORY_HOURS = 1;

// `label` is the full form used on the cards; `short` is the compact header used
// by the collapsed table, where seven columns share a phone's width.
const METRICS: { key: keyof TelemetrySample; label: string; short: string; unit: string; color: string }[] = [
  { key: "he_lvl", label: "He Lvl", short: "He Lvl", unit: "%", color: "#22d3ee" },
  { key: "h2o_flow", label: "H2O Flow", short: "Flow", unit: "gpm", color: "#5b93f7" },
  { key: "he_press", label: "He Press", short: "Press", unit: "psi", color: "#4ade80" },
  { key: "h2o_temp", label: "H2O Temp", short: "Temp", unit: "°F", color: "#fbbf24" },
  { key: "shield", label: "Shield", short: "Shield", unit: "", color: "#f0575a" },
  { key: "cs1", label: "CS1", short: "CS1", unit: "", color: "#a78bfa" },
];

// Value-faults map onto exactly one metric column, so the offending cell can
// tint itself in the table. Keys come from computeAssetFaults (lib/faults.ts);
// `coldhead` has no column of its own (it lives in the raw data blob), so it
// shows only via the row's status edge.
const FAULT_METRIC: Record<string, keyof TelemetrySample> = {
  compressor: "cs1",
  helium: "he_lvl",
  he_press: "he_press",
  shield: "shield",
};

type FleetView = "cards" | "table";
const VIEW_KEY = "dashboard-view";

export default function Dashboard() {
  const { demo, basePath, brand } = useDemo();
  const [assets, setAssets] = useState<AssetWithTelemetry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "stale" | "offline" | "unknown">("all");
  // Cards vs. the collapsed table. Starts as "cards" so server and first client
  // render agree (no hydration mismatch); the effect below then resolves the
  // real preference — a saved choice, or table-by-default on a phone.
  const [view, setView] = useState<FleetView>("cards");

  useEffect(() => {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === "cards" || saved === "table") {
      setView(saved);
    } else if (window.matchMedia("(max-width: 767px)").matches) {
      setView("table");
    }
  }, []);

  const chooseView = useCallback((v: FleetView) => {
    setView(v);
    localStorage.setItem(VIEW_KEY, v);
  }, []);

  const load = useCallback(async () => {
    const { assets: rows, error: err } = await getDataSource(demo).loadFleet(HISTORY_HOURS);
    if (err) {
      setError(err);
      return;
    }
    setAssets(rows);
    setError(null);
    setLoading(false);
    setLastRefreshed(new Date());
  }, [demo]);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  // Sort so anything alerting (offline/stale or a value-fault like a warm
  // coldhead) floats to the top of the grid, and gather the open issues for the
  // ticker — same alert logic the TV uses.
  const ordered = sortByAlarmPriority(assets);
  const alertItems = buildAlertItems(ordered);
  const forecasts = useFleetForecasts(assets.map((a) => a.id), demo);
  const filteredAssets =
    statusFilter === "all" ? ordered : ordered.filter((a) => computeAssetHealth(a) === statusFilter);

  const onlineCount = assets.filter((a) => computeAssetHealth(a) === "online").length;
  const staleCount = assets.filter((a) => computeAssetHealth(a) === "stale").length;
  const offlineCount = assets.filter((a) => computeAssetHealth(a) === "offline").length;
  const unknownCount = assets.filter((a) => computeAssetHealth(a) === "unknown").length;

  const siteCount = new Set(
    assets.map((a) => a.site_name?.trim()).filter((n): n is string => !!n)
  ).size;

  return (
    <div id="main-content" className="min-h-screen p-6 md:p-10" role="main">
      <header className="mb-6">
        <p className="eyebrow mb-1.5">{brand.eyebrow}</p>
        <div className="flex items-center gap-3 justify-between">
          <div className="flex items-center gap-3">
            <span className="dash-mark" aria-hidden="true">
              <OrgMark size="100%" bleed />
            </span>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Magnet Monitor Dashboard</h1>
          </div>
          <Link
            href={`${basePath}/tv`}
            target="_blank"
            rel="noopener"
            className="btn-secondary inline-flex items-center gap-1.5 shrink-0"
            aria-label="Open TV / Display mode in a new tab"
            title="Full-screen wall display that auto-rotates through the fleet"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="3" y="4" width="18" height="12" rx="1.6" stroke="currentColor" strokeWidth="2" />
              <path d="M8 20h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            TV mode
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-[var(--text-dim)]">
          <span className="flex items-center gap-1.5 text-[var(--text-muted)]">
            <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-70" style={{ backgroundColor: "var(--status-online)" }} />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ backgroundColor: "var(--status-online)" }} />
            </span>
            Live
          </span>
          <span aria-hidden="true">&middot;</span>
          <span className="font-mono-data">
            {lastRefreshed ? `updated ${lastRefreshed.toLocaleTimeString()}` : "connecting…"}
          </span>
          {assets.length > 0 && (
            <>
              <span aria-hidden="true">&middot;</span>
              <span>
                {assets.length} {assets.length === 1 ? "asset" : "assets"}
                {siteCount > 0 && (
                  <>
                    {" "}
                    &middot; {siteCount} {siteCount === 1 ? "site" : "sites"}
                  </>
                )}
              </span>
            </>
          )}
        </div>
      </header>

      <div
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 mb-7"
        role="group"
        aria-label="Filter assets by status"
      >
        <StatusTile
          color="var(--accent)"
          count={assets.length}
          label="All assets"
          active={statusFilter === "all"}
          onClick={() => setStatusFilter("all")}
          icon={
            <>
              <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2" />
            </>
          }
        />
        <StatusTile
          color={STATUS_COLORS.online}
          count={onlineCount}
          label="Online"
          active={statusFilter === "online"}
          onClick={() => setStatusFilter(statusFilter === "online" ? "all" : "online")}
          icon={<path d="M5 12.5l4 4 10-10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />}
        />
        <StatusTile
          color={STATUS_COLORS.stale}
          count={staleCount}
          label="Stale"
          active={statusFilter === "stale"}
          onClick={() => setStatusFilter(statusFilter === "stale" ? "all" : "stale")}
          icon={
            <>
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
              <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </>
          }
        />
        <StatusTile
          color={STATUS_COLORS.offline}
          count={offlineCount}
          label="Offline"
          active={statusFilter === "offline"}
          onClick={() => setStatusFilter(statusFilter === "offline" ? "all" : "offline")}
          icon={
            <>
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
              <path d="M12 7v6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              <circle cx="12" cy="17" r="1.3" fill="currentColor" />
            </>
          }
        />
        <StatusTile
          color={STATUS_COLORS.unknown}
          count={unknownCount}
          label="Unknown"
          active={statusFilter === "unknown"}
          onClick={() => setStatusFilter(statusFilter === "unknown" ? "all" : "unknown")}
          icon={
            <>
              <path d="M9.2 9a2.8 2.8 0 1 1 3.8 2.6c-.8.4-1 .9-1 1.7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <circle cx="12" cy="17" r="1.3" fill="currentColor" />
            </>
          }
        />
      </div>

      {alertItems.length > 0 && (
        <div
          className="dash-ticker"
          data-critical={alertItems.some((i) => i.severity === "critical") ? "true" : "false"}
          role="status"
          aria-label={`${alertItems.length} active ${alertItems.length === 1 ? "alert" : "alerts"}`}
        >
          <span className="dash-ticker-tag">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 3.5 22 20H2L12 3.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M12 10v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <circle cx="12" cy="17" r="1" fill="currentColor" />
            </svg>
            {alertItems.length} {alertItems.length === 1 ? "alert" : "alerts"}
          </span>
          <div className="dash-ticker-viewport">
            {/* Two copies back-to-back → seamless -50% marquee. Pauses on hover
                (see globals.css) so an item can be read and clicked. */}
            <div
              className="dash-ticker-track"
              style={{ animationDuration: `${Math.max(20, alertItems.length * 7)}s` }}
            >
              {[...alertItems, ...alertItems].map((it, i) => (
                <Link
                  key={i}
                  href={`${basePath}/asset/${it.assetId}`}
                  className={`dash-ticker-item ${it.severity}`}
                >
                  <span className="dash-ticker-dot" aria-hidden="true" />
                  <b>{it.asset}</b>
                  <span className="dash-ticker-sep">—</span>
                  {it.label}
                  {it.detail && <span className="dash-ticker-detail font-mono-data">{it.detail}</span>}
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

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

      {!loading && !error && filteredAssets.length > 0 && (
        <>
          <div className="flex items-center justify-end mb-3">
            <ViewToggle view={view} onChange={chooseView} />
          </div>

          {view === "cards" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {filteredAssets.map((a) => (
                <AssetCard key={a.id} asset={a} basePath={basePath} forecast={forecasts[a.id] ?? null} />
              ))}
            </div>
          ) : (
            <AssetTable assets={filteredAssets} basePath={basePath} />
          )}
        </>
      )}
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: FleetView; onChange: (v: FleetView) => void }) {
  return (
    <div className="view-seg" role="group" aria-label="Dashboard layout">
      <button
        type="button"
        className={view === "cards" ? "on" : ""}
        aria-pressed={view === "cards"}
        onClick={() => onChange("cards")}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.6" />
          <rect x="9.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.6" />
          <rect x="1.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.6" />
          <rect x="9.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        Cards
      </button>
      <button
        type="button"
        className={view === "table" ? "on" : ""}
        aria-pressed={view === "table"}
        onClick={() => onChange("table")}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M1.5 3.5h13M1.5 8h13M1.5 12.5h13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        Table
      </button>
    </div>
  );
}

function AssetTable({ assets, basePath }: { assets: AssetWithTelemetry[]; basePath: string }) {
  return (
    <div className="fleet-table-wrap">
      <div className="fleet-scroll">
        <table className="fleet-table">
          <thead>
            <tr>
              <th className="ft-asset-h">Asset</th>
              {METRICS.map((m) => (
                <th key={m.key as string}>
                  <span className="ft-h">{m.short}</span>
                  <span className="ft-u">{m.unit || " "}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => (
              <AssetRow key={a.id} asset={a} basePath={basePath} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AssetRow({ asset, basePath }: { asset: AssetWithTelemetry; basePath: string }) {
  const router = useRouter();
  const alarm = computeAssetAlarm(asset);
  const status = computeAssetHealth(asset);
  // Age of the last genuinely-new reading (data freshness), so it always agrees
  // with the status chip — a reachable-but-silent unit reads its true data age,
  // not the misleadingly-fresh last_seen_at.
  const mins = minutesSince(asset.last_sample_at);
  const href = `${basePath}/asset/${asset.id}`;

  // Colored edge = the single folded alarm level (matches the TV card rail),
  // falling back to plain connectivity color when nothing's wrong.
  const edge = alarm.level === "ok" ? STATUS_COLORS[status] : ALARM_COLORS[alarm.level];
  const alarming = alarm.level === "critical" || alarm.level === "warning";

  // Which cell (if any) each fault should light up, and how severely.
  const faultCell: Partial<Record<keyof TelemetrySample, FaultSeverity>> = {};
  for (const f of alarm.faults) {
    const mk = FAULT_METRIC[f.key];
    if (!mk) continue;
    if (faultCell[mk] !== "critical") faultCell[mk] = f.severity;
  }

  const sub = alarm.maintenance
    ? "maintenance"
    : mins === null
      ? "never reported"
      : `${mins} min ago`;

  return (
    <tr
      className="fleet-row"
      data-alarm={alarming ? "true" : "false"}
      style={{ ["--sc" as string]: edge }}
      onClick={() => router.push(href)}
    >
      <td className="ft-asset">
        <Link
          href={href}
          className="ft-name"
          onClick={(e) => e.stopPropagation()}
          aria-label={`${asset.name}, ${alarm.maintenance ? "maintenance" : status}, ${sub}. View details.`}
        >
          <span className="ft-dot" aria-hidden="true" />
          {asset.name}
        </Link>
        <div className="ft-sub">{sub}</div>
      </td>
      {METRICS.map((m) => {
        const value = asset.latest?.[m.key] as number | null | undefined;
        const sev = faultCell[m.key];
        const cls = alarm.maintenance ? "dim" : sev === "critical" ? "bad" : sev === "warning" ? "warn" : "";
        return (
          <td key={m.key as string} className={`ft-m ${cls}`.trim()}>
            {value ?? "—"}
          </td>
        );
      })}
    </tr>
  );
}

function StatusTile({
  color,
  count,
  label,
  active,
  onClick,
  icon,
}: {
  color: string;
  count: number;
  label: string;
  active?: boolean;
  onClick?: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${count} ${label}${active ? ", active filter" : ""}`}
      className={`stat-tile${active ? " active" : ""}`}
      style={{ ["--sc" as string]: color }}
    >
      <span className="st-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          {icon}
        </svg>
      </span>
      <span>
        <span className="st-num font-mono-data block">{count}</span>
        <span className="st-lbl block">{label}</span>
      </span>
    </button>
  );
}

function DropletIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.5c3.5 4 6 6.9 6 10.1a6 6 0 0 1-12 0c0-3.2 2.5-6.1 6-10.1Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AssetCard({
  asset,
  basePath,
  forecast,
}: {
  asset: AssetWithTelemetry;
  basePath: string;
  forecast: HeliumForecast | null;
}) {
  const status = computeAssetHealth(asset);
  const alarm = computeAssetAlarm(asset);
  const mins = minutesSince(asset.last_sample_at);
  const refillLabel = refillChipLabel(forecast);
  const refillColor = forecast && refillUrgency(forecast) === "soon" ? "var(--status-warning)" : "#38bdf8";

  return (
    <Link
      href={`${basePath}/asset/${asset.id}`}
      aria-label={`${asset.name}, ${STATUS_LABELS[status]}, ${mins === null ? "never reported" : `last seen ${mins} minutes ago`}. View details.`}
      className="asset-card group rounded-2xl border border-[var(--border-soft)] bg-[var(--card)] hover:bg-[var(--card-hover)] hover:border-[var(--border)] transition-colors p-5 pl-6 flex flex-col gap-4"
      style={{ ["--sc" as string]: STATUS_COLORS[status] }}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="font-semibold text-base">{asset.name}</p>
          <p className="text-xs text-[var(--text-dim)] mt-0.5">
            {asset.site_name?.trim() || "No location set"}
          </p>
        </div>
        <FieldRing status={status} />
      </div>

      {(alarm.faults.length > 0 || refillLabel) && (
        <div className="flex flex-wrap items-center gap-1.5 -mt-1.5">
          {alarm.faults.slice(0, 3).map((f) => (
            <span key={f.key} className={`fault-pill ${f.severity}`}>
              {f.label} <b>{f.detail}</b>
            </span>
          ))}
          {refillLabel && (
            <span className="refill-pill" style={{ ["--rc" as string]: refillColor }}>
              <DropletIcon />
              {refillLabel}
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        {METRICS.map((m) => {
          const value = asset.latest?.[m.key] as number | null | undefined;
          const series = asset.history.map((h) => h[m.key] as number | null | undefined);
          return (
            <div key={m.key} className="metric-tile flex flex-col gap-1">
              <p className="text-[var(--text-dim)] text-[10px] uppercase tracking-wide">{m.label}</p>
              <p className="font-mono-data text-sm text-[var(--text)]">
                {value ?? "—"} <span className="text-[var(--text-dim)] text-[10px]">{m.unit}</span>
              </p>
              <MiniLineChart values={series} width={90} height={22} color={m.color} />
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between text-xs text-[var(--text-dim)] pt-3 border-t border-[var(--border-soft)]">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="status-chip" style={{ ["--sc" as string]: STATUS_COLORS[status] }}>
            <span className="cd" aria-hidden="true" />
            {STATUS_LABELS[status]}
          </span>
          {connectivityStatuses(asset).map((c) => (
            <span
              key={c.key}
              className="status-chip"
              style={{ ["--sc" as string]: c.up ? CONNECTIVITY_COLORS.up : CONNECTIVITY_COLORS.down }}
            >
              <span className="cd" aria-hidden="true" />
              {c.label}
            </span>
          ))}
        </div>
        <span>{mins === null ? "never reported" : `${mins} min ago`}</span>
      </div>
    </Link>
  );
}
