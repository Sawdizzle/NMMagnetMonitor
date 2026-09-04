"use client";

import { useEffect, useState, useCallback, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type TelemetrySample } from "@/lib/supabase";
import { getDataSource, type FleetAsset } from "@/lib/dataSource";
import { useDemo } from "@/lib/demoContext";
import { collectorStatuses, computeAssetHealth, connectivityStatuses, CONNECTIVITY_COLORS, minutesSince, STATUS_COLORS, STATUS_LABELS } from "@/lib/health";
import { computeAssetAlarm, sortByAlarmPriority, buildAlertItems, groupAlertItems, ALARM_COLORS, type FaultSeverity } from "@/lib/faults";
import { cryoState, CRYO_COLORS, CRYO_SHORT_LABELS } from "@/lib/cryo";
import { useFleetForecasts } from "@/lib/useFleetForecasts";
import { useWeather } from "@/lib/useWeather";
import type { SiteWeather } from "@/lib/weatherTypes";
import { refillChipLabel, refillUrgency, type HeliumForecast } from "@/lib/forecast";
import {
  envChartSpecs,
  envNum,
  hasEnvSection,
  showsPower,
  usesMagmon,
  zonesToShow,
  ENV_ZONES,
  type EnvZone,
  POWER_COLORS,
  POWER_LABELS,
  POWER_SHORT,
  powerState,
} from "@/lib/modality";
import FieldRing from "./FieldRing";
import { WeatherChip } from "./SiteWeather";
import MiniLineChart from "./MiniLineChart";
import OrgMark from "./OrgMark";
import DebriefLink from "./DebriefLink";

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

// One column per zone on a card, so the temperature row and the humidity row
// beneath it line up zone-for-zone. Whole class names because Tailwind scans
// source text — a built `grid-cols-${n}` produces no CSS at all.
const ENV_CARD_COLS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
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
      // deliberate: the real view preference lives in localStorage and a
      // media query, neither of which exists on the server. Resolving it during
      // render would hydration-mismatch; see the `view` state comment above.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
    // load() is async: every setState in it runs after an await, on a
    // later tick, not synchronously during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  // Sort so anything alerting (offline/stale or a value-fault like a warm
  // coldhead) floats to the top of the grid, and gather the open issues for the
  // ticker — same alert logic the TV uses.
  const ordered = sortByAlarmPriority(assets);
  const alertItems = buildAlertItems(ordered);
  // Rendered one row per asset, not one per fault — see groupAlertItems.
  const alertGroups = groupAlertItems(alertItems);
  const forecasts = useFleetForecasts(assets.map((a) => a.id), demo);
  // Outside conditions per site. Loads independently of the 30s status poll and
  // is simply absent until it arrives — no skeleton, no layout shift.
  const weather = useWeather(demo);
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
        {/* Stacks on phones: title first, actions on their own row beneath. Side
            by side, the two buttons squeezed the heading into three wrapped
            lines and left the header the tallest thing on the screen. */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <span className="dash-mark" aria-hidden="true">
              <OrgMark size="100%" bleed />
            </span>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Magnet Monitor Dashboard</h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <DebriefLink />
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
              {[...alertGroups, ...alertGroups].map((g, i) => (
                <Link
                  key={i}
                  href={`${basePath}/asset/${g.assetId}`}
                  className={`dash-ticker-item ${g.severity}`}
                >
                  <span className="dash-ticker-dot" aria-hidden="true" />
                  <b>{g.asset}</b>
                  <span className="dash-ticker-sep">—</span>
                  {g.items.map((it, j) => (
                    <span key={it.key} className={`dash-ticker-fault ${it.severity}`}>
                      {j > 0 && <span className="dash-ticker-div" aria-hidden="true">&middot;</span>}
                      {it.label}
                      {it.detail && <span className="dash-ticker-detail font-mono-data">{it.detail}</span>}
                    </span>
                  ))}
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
          No assets yet. Add a site and asset in the admin panel to see it here.
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
                <AssetCard
                  key={a.id}
                  asset={a}
                  basePath={basePath}
                  forecast={forecasts[a.id] ?? null}
                  weather={weather[a.id] ?? null}
                />
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

/**
 * The collapsed fleet view, as one table per CHANNEL FAMILY.
 *
 * A single table cannot carry both families. Its columns ARE the MagMon
 * channels, so a unit with no magnet previously had to borrow the whole span
 * for a cramped inline list that lined up with nothing — and widening it to the
 * union of every channel would give a phone twelve columns, most of them empty
 * on any given row.
 *
 * Split by family and NOT by kind of unit, which matters as soon as the fleet
 * has a magnet with a UPS fitted: filing each asset under one heading would
 * mean picking one of its families and silently dropping the other, which is
 * exactly the either/or mistake the cards avoid. An asset appears under every
 * family it reports — its magnet readings under one heading, its environmental
 * ones under the other — so nothing it sends is missing from this view.
 *
 * Headings appear only when both tables are present, so an all-magnet fleet
 * looks exactly as it always has.
 */
function AssetTable({ assets, basePath }: { assets: AssetWithTelemetry[]; basePath: string }) {
  const magnetRows = assets.filter((a) => usesMagmon(a.modality));
  const envRows = assets.filter((a) => hasEnvSection(a.modality, [a.latest, ...a.history]));
  const both = magnetRows.length > 0 && envRows.length > 0;

  return (
    <div className="flex flex-col gap-5">
      {magnetRows.length > 0 && (
        <div>
          {both && <TableHeading>Magnet channels</TableHeading>}
          <MagmonTable assets={magnetRows} basePath={basePath} />
        </div>
      )}
      {envRows.length > 0 && (
        <div>
          {both && <TableHeading>Environment &amp; power</TableHeading>}
          <EnvTable assets={envRows} basePath={basePath} />
        </div>
      )}
    </div>
  );
}

function TableHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs uppercase tracking-wide text-[var(--text-dim)] mb-2 px-1">{children}</h3>
  );
}

function MagmonTable({ assets, basePath }: { assets: AssetWithTelemetry[]; basePath: string }) {
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
                  <span className="ft-u">{m.unit || " "}</span>
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

/**
 * The environmental table.
 *
 * One column per zone rather than two, with temperature and humidity paired in
 * the cell: the table view is the phone default, and eight numeric columns on a
 * 375px screen is a horizontal scroll nobody reads. Columns are the union of
 * the zones these assets report, so a two-zone fleet gets two columns.
 */
function EnvTable({ assets, basePath }: { assets: AssetWithTelemetry[]; basePath: string }) {
  const zones = ENV_ZONES.filter((z) =>
    assets.some((a) =>
      zonesToShow(a.modality, [a.latest, ...a.history]).some((az) => az.key === z.key)
    )
  );

  return (
    <div className="fleet-table-wrap">
      <div className="fleet-scroll">
        <table className="fleet-table">
          <thead>
            <tr>
              <th className="ft-asset-h">Asset</th>
              {zones.map((z) => (
                <th key={z.key} title={z.label}>
                  <span className="ft-h">{z.short}</span>
                  <span className="ft-u">&deg;F &middot; %RH</span>
                </th>
              ))}
              <th>
                <span className="ft-h">Power</span>
                <span className="ft-u">&nbsp;</span>
              </th>
              <th>
                <span className="ft-h">Batt</span>
                <span className="ft-u">%</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => (
              <EnvRow key={a.id} asset={a} basePath={basePath} zones={zones} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The chrome every fleet row shares: its status edge, its "N min ago" subtitle
 * and where it links. Split out so the two tables cannot drift apart on the one
 * column they have in common.
 *
 * A plain function, deliberately not named useX: it calls no hooks, and the
 * prefix would claim ordering rules it does not have.
 */
function rowChrome(asset: AssetWithTelemetry, basePath: string) {
  const alarm = computeAssetAlarm(asset);
  const status = computeAssetHealth(asset);
  // Age of the last genuinely-new reading (data freshness), so it always agrees
  // with the status chip — a reachable-but-silent unit reads its true data age,
  // not the misleadingly-fresh last_seen_at.
  const mins = minutesSince(asset.last_sample_at);
  return {
    alarm,
    status,
    href: `${basePath}/asset/${asset.id}`,
    // Colored edge = the single folded alarm level (matches the TV card rail),
    // falling back to plain connectivity color when nothing's wrong.
    edge: alarm.level === "ok" ? STATUS_COLORS[status] : ALARM_COLORS[alarm.level],
    alarming: alarm.level === "critical" || alarm.level === "warning",
    sub: alarm.maintenance
      ? "maintenance"
      : mins === null
        ? "never reported"
        : `${mins} min ago`,
  };
}

function AssetNameCell({
  asset,
  href,
  status,
  sub,
  maintenance,
}: {
  asset: AssetWithTelemetry;
  href: string;
  status: string;
  sub: string;
  maintenance: boolean;
}) {
  return (
    <td className="ft-asset">
      <Link
        href={href}
        className="ft-name"
        onClick={(e) => e.stopPropagation()}
        aria-label={`${asset.name}, ${maintenance ? "maintenance" : status}, ${sub}. View details.`}
      >
        <span className="ft-dot" aria-hidden="true" />
        {asset.name}
      </Link>
      <div className="ft-sub">{sub}</div>
    </td>
  );
}

function AssetRow({ asset, basePath }: { asset: AssetWithTelemetry; basePath: string }) {
  const router = useRouter();
  const { alarm, status, href, edge, alarming, sub } = rowChrome(asset, basePath);

  // Which cell (if any) each fault should light up, and how severely.
  const faultCell: Partial<Record<keyof TelemetrySample, FaultSeverity>> = {};
  for (const f of alarm.faults) {
    const mk = FAULT_METRIC[f.key];
    if (!mk) continue;
    if (faultCell[mk] !== "critical") faultCell[mk] = f.severity;
  }

  return (
    <tr
      className="fleet-row"
      data-alarm={alarming ? "true" : "false"}
      style={{ ["--sc" as string]: edge }}
      onClick={() => router.push(href)}
    >
      <AssetNameCell asset={asset} href={href} status={status} sub={sub} maintenance={alarm.maintenance} />
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

/**
 * Which environmental column a fault belongs to, so the offending cell can tint
 * itself the way the magnet table's already does.
 *
 * Fault keys are built in lib/faults as `alert:<field>` / `sensor:<field>` /
 * `trend:<field>`, plus the bare "power" key for a mains outage. Reading the
 * field back out of the key is what lets a zone alarm light its own column
 * instead of the whole row going amber with no indication of where.
 */
function envFaultColumns(faults: { key: string; severity: FaultSeverity }[]) {
  const out: Record<string, FaultSeverity> = {};
  const bump = (col: string, sev: FaultSeverity) => {
    if (out[col] !== "critical") out[col] = sev;
  };
  for (const f of faults) {
    if (f.key === "power") {
      bump("power", f.severity);
      continue;
    }
    const i = f.key.indexOf(":");
    if (i < 0) continue;
    const field = f.key.slice(i + 1);
    const zone = ENV_ZONES.find((z) => field.startsWith(`${z.key}_`));
    if (zone) bump(zone.key, f.severity);
    else if (field.startsWith("ups_")) bump("power", f.severity);
  }
  return out;
}

function EnvRow({
  asset,
  basePath,
  zones,
}: {
  asset: AssetWithTelemetry;
  basePath: string;
  zones: EnvZone[];
}) {
  const router = useRouter();
  const { alarm, status, href, edge, alarming, sub } = rowChrome(asset, basePath);
  const t = asset.latest as unknown as Record<string, unknown> | null;
  const power = powerState(t?.ups_on_battery);
  const batt = envNum(t?.ups_batt_pct);
  const faultCol = envFaultColumns(alarm.faults);
  const cls = (col: string) => {
    if (alarm.maintenance) return "ft-m dim";
    const sev = faultCol[col];
    return `ft-m ${sev === "critical" ? "bad" : sev === "warning" ? "warn" : ""}`.trim();
  };

  return (
    <tr
      className="fleet-row"
      data-alarm={alarming ? "true" : "false"}
      style={{ ["--sc" as string]: edge }}
      onClick={() => router.push(href)}
    >
      <AssetNameCell asset={asset} href={href} status={status} sub={sub} maintenance={alarm.maintenance} />
      {zones.map((z) => {
        const temp = envNum(t?.[`${z.key}_temp_f`]);
        const rh = envNum(t?.[`${z.key}_rh`]);
        return (
          <td key={z.key} className={`${cls(z.key)} ft-stack`}>
            {temp === null ? "—" : `${temp.toFixed(1)}°`}
            <span className="ft-rh">{rh === null ? "—" : `${rh.toFixed(0)}%`}</span>
          </td>
        );
      })}
      <td
        className={cls("power")}
        style={alarm.maintenance ? undefined : { color: POWER_COLORS[power] }}
        title={POWER_LABELS[power]}
      >
        {POWER_SHORT[power]}
      </td>
      <td className={cls("power")}>{batt === null ? "—" : batt.toFixed(0)}</td>
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

/**
 * One tile per zone channel, each with its own hour of history.
 *
 * Built to be the same tile the magnet channels use — label, value with unit,
 * sparkline — because these ARE the same kind of thing and a card that draws
 * them differently implies a distinction that does not exist. A zone tile and a
 * helium tile sit side by side on a unit that has both.
 *
 * Two rows: every temperature across the top, each zone's humidity directly
 * beneath it (see envChartSpecs — the order is the layout). The grid takes one
 * column per zone so the two rows align zone-for-zone.
 *
 * Readings go through envNum because PostgREST serialises numeric columns as
 * strings; toFixed on "70.0" would throw.
 */
function ZoneTiles({
  zones,
  latest,
  history,
}: {
  zones: EnvZone[];
  latest: TelemetrySample | null;
  history: TelemetrySample[];
}) {
  // Indexed through a Record rather than typed keys: the channels differ only
  // by a column-name prefix, and spelling out six accessors to satisfy the type
  // system would bury that.
  const t = latest as unknown as Record<string, unknown> | null;
  const cols = ENV_CARD_COLS[zones.length] ?? "grid-cols-3";

  return (
    <div className={`grid ${cols} gap-2`}>
      {envChartSpecs(zones).map((m) => {
        const value = envNum(t?.[m.key]);
        const series = history.map((h) => envNum((h as unknown as Record<string, unknown>)[m.key]));
        return (
          <div key={m.key} className="metric-tile flex flex-col gap-1">
            <p
              className="text-[var(--text-dim)] text-[10px] uppercase tracking-wide truncate"
              title={`${m.zone.label} · ${m.isTemp ? "temperature" : "humidity"}`}
            >
              {m.short}
            </p>
            <p className="font-mono-data text-sm text-[var(--text)]">
              {value === null ? "—" : value.toFixed(m.isTemp ? 1 : 0)}{" "}
              <span className="text-[var(--text-dim)] text-[10px]">{m.unit}</span>
            </p>
            <MiniLineChart values={series} width={90} height={22} color={m.color} />
          </div>
        );
      })}
    </div>
  );
}

/** Mains power state, for any asset with a UPS on it. */
function PowerRow({ latest }: { latest: TelemetrySample | null }) {
  const t = latest as unknown as Record<string, unknown> | null;
  const power = powerState(t?.ups_on_battery);
  const batt = envNum(t?.ups_batt_pct);
  const volts = envNum(t?.ups_input_v);

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {/* Grey for unknown is deliberate and is NOT a synonym for "fine": a null
          ups_on_battery means the UPS link is not answering, so the one thing
          this hardware exists to detect is what we cannot currently see. */}
      <span className="status-chip" style={{ ["--sc" as string]: POWER_COLORS[power] }}>
        <span className="cd" aria-hidden="true" />
        {POWER_LABELS[power]}
      </span>
      {batt !== null && (
        <span className="text-[11px] text-[var(--text-dim)] font-mono-data">
          {batt.toFixed(0)}% batt
        </span>
      )}
      {volts !== null && (
        <span className="text-[11px] text-[var(--text-dim)] font-mono-data">
          {volts.toFixed(0)} V in
        </span>
      )}
    </div>
  );
}

function AssetCard({
  asset,
  basePath,
  forecast,
  weather,
}: {
  asset: AssetWithTelemetry;
  basePath: string;
  forecast: HeliumForecast | null;
  weather: SiteWeather | null;
}) {
  const status = computeAssetHealth(asset);
  const alarm = computeAssetAlarm(asset);
  const mins = minutesSince(asset.last_sample_at);
  // A boil-off refill projection needs helium, which a unit with no magnet does
  // not have — the forecast for one comes back empty anyway, but gating here
  // says why rather than relying on that.
  const showMagmon = usesMagmon(asset.modality);
  const refillLabel = showMagmon ? refillChipLabel(forecast) : null;
  // Presence is judged over the whole 1h window, not just the newest reading,
  // so a sensor that dropped off the bus twenty minutes ago keeps its tile and
  // shows a blank instead of quietly vanishing from the card.
  const rows = [asset.latest, ...asset.history];
  const zones = zonesToShow(asset.modality, rows);
  const showPower = showsPower(asset.modality, rows);
  // Graded cryogenic state, drawn only for a unit that has a magnet.
  const cryo = showMagmon ? cryoState(asset.latest) : null;
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
          <p className="text-xs text-[var(--text-dim)] mt-0.5 flex items-center gap-1.5">
            <span className="truncate">{asset.site_name?.trim() || "No location set"}</span>
            <WeatherChip weather={weather} />
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

      {/* Three independent sections, each drawn on its own terms. A magnet
          shows the MagMon grid; a trailer shows zones and power; a magnet that
          later gets a UPS and sensors fitted shows all three, with no change
          here. */}
      <div className="flex flex-col gap-2.5">
        {showMagmon && (
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
        )}
        {zones.length > 0 && (
          <ZoneTiles zones={zones} latest={asset.latest} history={asset.history} />
        )}
        {showPower && <PowerRow latest={asset.latest} />}
      </div>

      <div className="flex items-center justify-between text-xs text-[var(--text-dim)] pt-3 border-t border-[var(--border-soft)]">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="status-chip" style={{ ["--sc" as string]: STATUS_COLORS[status] }}>
            <span className="cd" aria-hidden="true" />
            {STATUS_LABELS[status]}
          </span>
          {/* A collector family that is dark while the other keeps the unit
              reporting — 'online' alone would say the magnet is being watched
              when only the bay sensor and the UPS are. Red, because for those
              channels nothing is arriving at all. */}
          {collectorStatuses(asset).map((c) => (
            <span
              key={c.key}
              className="status-chip"
              style={{ ["--sc" as string]: CONNECTIVITY_COLORS.down }}
            >
              <span className="cd" aria-hidden="true" />
              {c.label}
            </span>
          ))}
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
          {/*
            Cryogenic state, but ONLY when it is not nominal.
            A card is scanned, not read, and a green "cryo nominal" chip on every
            magnet would be one more thing to look past. No chip therefore means
            nominal — which is why "unknown" keeps its own grey chip rather than
            being folded into that silence: a reporting magnet whose cryo
            channels are missing must not look like a healthy one.

            The exception is a unit that is not reporting at all, where the
            status chip beside this one already says offline or stale and a grey
            "no data" would just repeat it. A LAST-KNOWN watch/urgent/critical
            still shows on an offline unit, deliberately: "offline, and it was
            critical when we lost sight of it" is the NM1004 story, and it is
            the one thing that card most needs to say.
          */}
          {cryo && cryo.level !== "nominal" && !(cryo.level === "unknown" && status !== "online") && (
            <span className="status-chip" style={{ ["--sc" as string]: CRYO_COLORS[cryo.level] }}>
              <span className="cd" aria-hidden="true" />
              {CRYO_SHORT_LABELS[cryo.level]}
            </span>
          )}
        </div>
        <span>{mins === null ? "never reported" : `${mins} min ago`}</span>
      </div>
    </Link>
  );
}
