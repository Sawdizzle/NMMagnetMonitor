"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { type Asset, type TelemetrySample, type TelemetryBucket, type AlertEvent, type AlertRule } from "@/lib/supabase";
import { getDataSource, type FleetAsset } from "@/lib/dataSource";
import { useDemo } from "@/lib/demoContext";
import { computeAssetHealth, connectivityStatuses, CONNECTIVITY_COLORS, minutesSince, NO_TELEMETRY_KINDS, STATUS_COLORS, STATUS_LABELS } from "@/lib/health";
import { computeAssetAlarm } from "@/lib/faults";
import { heliumForecast, forecastHeadline, type HeliumForecast } from "@/lib/forecast";
import FieldRing from "@/components/FieldRing";
import MetricLineChart from "@/components/MetricLineChart";

const POLL_MS = 30_000;
const HISTORY_HOURS = 24;
// The boil-off forecast fits a longer window than the 24h trend charts — a week
// of 15-min buckets gives a stable slope. Refreshed slowly; the trend is daily.
const FORECAST_HOURS = 24 * 7;
const FORECAST_POLL_MS = 5 * 60_000;

const METRICS: { key: keyof Omit<TelemetryBucket, "created_at" | "sample_count">; label: string; unit: string; color: string }[] = [
  { key: "he_lvl", label: "He Lvl", unit: "%", color: "#22d3ee" },
  { key: "h2o_flow", label: "H2O Flow", unit: "gpm", color: "#5b93f7" },
  { key: "he_press", label: "He Press", unit: "psi", color: "#4ade80" },
  { key: "h2o_temp", label: "H2O Temp", unit: "°F", color: "#fbbf24" },
  { key: "shield", label: "Shield", unit: "", color: "#f0575a" },
  { key: "cs1", label: "CS1", unit: "", color: "#a78bfa" },
];

export default function AssetDetail({ assetId }: { assetId: string }) {
  const { demo, basePath } = useDemo();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [latest, setLatest] = useState<TelemetrySample | null>(null);
  const [buckets, setBuckets] = useState<TelemetryBucket[]>([]);
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Pre-aggregated into 15-minute averaged buckets (at most 96 rows for a 24h
    // window in the live path) so the chart/table cost is fixed regardless of
    // how many raw readings a gateway actually sent.
    const { asset: assetRow, latest: latestRow, buckets: bucketRows, alertRules: rules, error: err } = await getDataSource(
      demo
    ).loadAssetDetail(assetId, HISTORY_HOURS);

    if (err || !assetRow) {
      setError(err || "Asset not found");
      setLoading(false);
      return;
    }

    setAsset(assetRow);
    setLatest(latestRow);
    setBuckets(bucketRows);
    setAlertRules(rules);
    setError(null);
    setLoading(false);
  }, [assetId, demo]);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  // Helium boil-off forecast — its own slow-cadence load over a week-long window,
  // independent of the 30s value poll above.
  const [forecast, setForecast] = useState<HeliumForecast | null>(null);
  const [forecastLoaded, setForecastLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const run = async () => {
      const { points } = await getDataSource(demo).loadHeliumSeries(assetId, FORECAST_HOURS);
      if (!alive) return;
      setForecast(heliumForecast(points));
      setForecastLoaded(true);
    };
    run();
    const id = setInterval(run, FORECAST_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [assetId, demo]);

  // Persisted alert history (alert_events), on the same 30s cadence as telemetry.
  // Failures are tolerated (empty list) so the page still renders without alerts.
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  useEffect(() => {
    let alive = true;
    const run = async () => {
      const { events } = await getDataSource(demo).loadAssetAlerts(assetId);
      if (alive) setAlerts(events);
    };
    run();
    const id = setInterval(run, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [assetId, demo]);

  if (loading) return <div className="p-10 text-[var(--text-muted)]">Loading&hellip;</div>;
  if (error || !asset)
    return <div className="p-10 text-[var(--status-offline)] font-mono-data">Error: {error}</div>;

  const status = computeAssetHealth(asset);
  const mins = minutesSince(asset.last_sample_at);
  const tableRows = [...buckets].reverse(); // newest-first for the table

  // Same value-fault evaluation the fleet card runs, so the pills here match the
  // card exactly (single source of truth in lib/faults). computeAssetFaults only
  // reads latest / latest.data / alertRules — history is unused, so [] is fine.
  const fleetShape: FleetAsset = { ...asset, latest, history: [], alertRules };
  const alarm = computeAssetAlarm(fleetShape);

  return (
    <div id="main-content" className="min-h-screen p-6 md:p-10" role="main">
      <Link href={basePath || "/"} className="back-link">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back to fleet
      </Link>

      <header className="flex items-start justify-between mt-4 mb-8">
        <div>
          <p className="eyebrow mb-1.5">{asset.site_name?.trim() || "No location set"}</p>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">{asset.name}</h1>
          {asset.site_address?.trim() && (
            <p className="text-xs text-[var(--text-dim)] mt-1">{asset.site_address}</p>
          )}
          <div className="flex flex-wrap items-center gap-2.5 mt-2.5">
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
            <span className="text-xs text-[var(--text-dim)]">
              {mins === null ? "never reported" : `last seen ${mins} min ago`}
            </span>
          </div>

          {alarm.faults.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
              {alarm.faults.map((f) => (
                <span key={f.key} className={`fault-pill ${f.severity}`}>
                  {f.label} <b>{f.detail}</b>
                </span>
              ))}
            </div>
          )}
        </div>
        <FieldRing status={status} size={56} />
      </header>

      {latest && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-10">
          <MetricCard label="He Level" value={latest.he_lvl} unit="%" />
          <MetricCard label="He Pressure" value={latest.he_press} unit="psi" />
          <MetricCard label="H2O Flow" value={latest.h2o_flow} unit="gpm" />
          <MetricCard label="H2O Temp" value={latest.h2o_temp} unit="°F" />
          <MetricCard label="Shield" value={latest.shield} unit="" />
          <MetricCard label="CS1" value={latest.cs1} unit="" />
        </div>
      )}

      <ForecastCard forecast={forecast} loaded={forecastLoaded} />

      <AlertsSection events={alerts} />

      <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-3">
        Trends (last 24 hours &middot; 15-min averages)
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-10">
        {METRICS.map((m) => (
          <MetricLineChart
            key={m.key}
            samples={buckets}
            metricKey={m.key}
            label={m.label}
            unit={m.unit}
            color={m.color}
          />
        ))}
      </div>

      <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-3">
        Recent readings ({tableRows.length} &middot; 15-min averages, last 24h)
      </h2>

      {/* Mobile: stacked cards, no horizontal scroll needed */}
      <div className="flex flex-col gap-2 md:hidden">
        {tableRows.map((s) => (
          <div key={s.created_at} className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-3">
            <p className="text-xs text-[var(--text-dim)] mb-2 flex items-center justify-between">
              <span>{new Date(s.created_at).toLocaleString()}</span>
              <span className="text-[10px]">avg of {s.sample_count}</span>
            </p>
            <div className="grid grid-cols-3 gap-2 font-mono-data text-sm">
              <ReadingCell label="He Lvl" value={s.he_lvl} />
              <ReadingCell label="He Press" value={s.he_press} />
              <ReadingCell label="H2O Flow" value={s.h2o_flow} />
              <ReadingCell label="H2O Temp" value={s.h2o_temp} />
              <ReadingCell label="Shield" value={s.shield} />
              <ReadingCell label="CS1" value={s.cs1} />
            </div>
          </div>
        ))}
        {tableRows.length === 0 && (
          <p className="text-center text-[var(--text-dim)] py-6 rounded-xl border border-dashed border-[var(--border)]">
            No telemetry received yet.
          </p>
        )}
      </div>

      {/* Desktop/tablet: full table */}
      <div className="hidden md:block overflow-x-auto rounded-xl border border-[var(--border-soft)]">
        <table className="w-full text-sm font-mono-data">
          <thead>
            <tr className="text-left text-[var(--text-dim)] border-b border-[var(--border)] bg-[var(--bg-elevated)]">
              <th className="px-3 py-2 font-normal">Time</th>
              <th className="px-3 py-2 font-normal">He Lvl</th>
              <th className="px-3 py-2 font-normal">He Press</th>
              <th className="px-3 py-2 font-normal">H2O Flow</th>
              <th className="px-3 py-2 font-normal">H2O Temp</th>
              <th className="px-3 py-2 font-normal">Shield</th>
              <th className="px-3 py-2 font-normal">CS1</th>
              <th className="px-3 py-2 font-normal">Samples</th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map((s) => (
              <tr key={s.created_at} className="border-b border-[var(--border)] last:border-0">
                <td className="px-3 py-2 text-[var(--text-muted)]">
                  {new Date(s.created_at).toLocaleString()}
                </td>
                <td className="px-3 py-2">{s.he_lvl ?? "—"}</td>
                <td className="px-3 py-2">{s.he_press ?? "—"}</td>
                <td className="px-3 py-2">{s.h2o_flow ?? "—"}</td>
                <td className="px-3 py-2">{s.h2o_temp ?? "—"}</td>
                <td className="px-3 py-2">{s.shield ?? "—"}</td>
                <td className="px-3 py-2">{s.cs1 ?? "—"}</td>
                <td className="px-3 py-2 text-[var(--text-dim)]">{s.sample_count}</td>
              </tr>
            ))}
            {tableRows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-[var(--text-dim)]">
                  No telemetry received yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AlertsSection({ events }: { events: AlertEvent[] }) {
  const open = events.filter((e) => !e.resolved_at);
  const resolved = events.filter((e) => e.resolved_at);

  return (
    <section className="mb-10">
      <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-3">
        Alerts
        {open.length > 0 && <span className="alert-count">{open.length} active</span>}
      </h2>

      {events.length === 0 ? (
        <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] px-4 py-3 text-sm text-[var(--text-dim)]">
          No alerts on record for this unit.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {open.map((e) => (
            <AlertRow key={e.id} e={e} />
          ))}
          {resolved.length > 0 && (
            <>
              {open.length > 0 && (
                <p className="text-[10px] uppercase tracking-wide text-[var(--text-dim)] mt-2">Recently resolved</p>
              )}
              {resolved.slice(0, 5).map((e) => (
                <AlertRow key={e.id} e={e} />
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function AlertRow({ e }: { e: AlertEvent }) {
  const isOpen = !e.resolved_at;
  // No-telemetry kinds read red; each message carries its own disambiguation
  // (reporting_stalled = Pi reachable/egress fault, never_reported = install
  // never completed). threshold/sensor_fault stay amber — the unit is reporting.
  const color = isOpen
    ? NO_TELEMETRY_KINDS.has(e.kind)
      ? "var(--status-offline)"
      : "var(--status-warning)"
    : "var(--text-dim)";
  return (
    <div className="alert-row" data-open={isOpen ? "true" : "false"} style={{ ["--ac" as string]: color }}>
      <span className="alert-dot" aria-hidden="true" />
      <span className="alert-msg">{e.message}</span>
      <span className="alert-meta font-mono-data">{alertTiming(e)}</span>
    </div>
  );
}

function fmtDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function alertTiming(e: AlertEvent): string {
  const now = Date.now();
  const trig = new Date(e.triggered_at).getTime();
  if (!e.resolved_at) return `open ${fmtDur(now - trig)}`;
  const res = new Date(e.resolved_at).getTime();
  return `resolved ${fmtDur(now - res)} ago · lasted ${fmtDur(res - trig)}`;
}

const CONFIDENCE_STYLE: Record<HeliumForecast["confidence"], { label: string; color: string }> = {
  high: { label: "high confidence", color: "#4ade80" },
  medium: { label: "medium confidence", color: "#fbbf24" },
  low: { label: "low confidence", color: "#6b7280" },
};

function ForecastCard({ forecast, loaded }: { forecast: HeliumForecast | null; loaded: boolean }) {
  // Days-to-refill drives the accent: a soon-due unit glows amber, a slower
  // decline stays cool blue, and anything not falling is neutral cyan.
  const daysLeft = forecast && forecast.trend === "falling" ? forecast.daysToRefill : null;
  const accent =
    !forecast || forecast.trend !== "falling"
      ? "#38bdf8"
      : daysLeft !== null && daysLeft < 14
        ? "#fbbf24"
        : "#5b93f7";

  return (
    <div className="rounded-2xl border border-[var(--border-soft)] bg-[var(--card)] p-5 mb-10">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)]">Helium forecast</h2>
        <span className="text-[10px] text-[var(--text-dim)]">boil-off &middot; 7-day fit</span>
      </div>

      {!loaded ? (
        <p className="text-[var(--text-muted)] text-sm" aria-live="polite">Analyzing helium trend&hellip;</p>
      ) : !forecast ? (
        <p className="text-[var(--text-muted)] text-sm">Not enough helium history yet to project a refill.</p>
      ) : (
        <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
          <div className="min-w-0">
            <p className="text-2xl md:text-3xl font-semibold tracking-tight" style={{ color: accent }}>
              {forecastHeadline(forecast)}
            </p>
            <p className="text-xs text-[var(--text-dim)] mt-1">
              {forecast.trend === "falling" && forecast.refillBy
                ? `Projected to reach ${forecast.floor}% by ${new Date(forecast.refillBy).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
                : forecast.trend === "rising"
                  ? "Level is trending up — recently filled or recovering"
                  : "Level is holding steady — no refill projected"}
            </p>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-2 font-mono-data text-sm">
            <Stat label="Rate" value={`${forecast.ratePerDay > 0 ? "+" : ""}${forecast.ratePerDay.toFixed(2)} %/day`} />
            <Stat label="Now (fit)" value={`${forecast.currentPct.toFixed(1)} %`} />
            {daysLeft !== null && (
              <Stat label="Days left" value={daysLeft < 1 ? "<1" : String(Math.round(daysLeft))} />
            )}
            <Stat label="Fit R²" value={forecast.r2.toFixed(2)} />
          </div>

          <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-dim)]">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: CONFIDENCE_STYLE[forecast.confidence].color }}
              aria-hidden="true"
            />
            {CONFIDENCE_STYLE[forecast.confidence].label}
          </span>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-[var(--text-dim)]">{label}</p>
      <p className="text-[var(--text)]">{value}</p>
    </div>
  );
}

function ReadingCell({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="metric-tile !py-1">
      <p className="text-[9px] uppercase tracking-wide text-[var(--text-dim)]">{label}</p>
      <p>{value ?? "—"}</p>
    </div>
  );
}

function MetricCard({ label, value, unit }: { label: string; value: number | null | undefined; unit: string }) {
  return (
    <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] px-3 py-3">
      <p className="text-[10px] uppercase tracking-wide text-[var(--text-dim)]">{label}</p>
      <p className="font-mono-data text-lg mt-0.5">
        {value ?? "—"} <span className="text-xs text-[var(--text-dim)]">{unit}</span>
      </p>
    </div>
  );
}
