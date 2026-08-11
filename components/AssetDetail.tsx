"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { type Asset, type TelemetrySample, type TelemetryBucket } from "@/lib/supabase";
import { getDataSource } from "@/lib/dataSource";
import { useDemo } from "@/lib/demoContext";
import { computeAssetHealth, minutesSince, STATUS_COLORS } from "@/lib/health";
import FieldRing from "@/components/FieldRing";
import MetricLineChart from "@/components/MetricLineChart";

const POLL_MS = 30_000;
const HISTORY_HOURS = 24;

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Pre-aggregated into 15-minute averaged buckets (at most 96 rows for a 24h
    // window in the live path) so the chart/table cost is fixed regardless of
    // how many raw readings a gateway actually sent.
    const { asset: assetRow, latest: latestRow, buckets: bucketRows, error: err } = await getDataSource(
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
    setError(null);
    setLoading(false);
  }, [assetId, demo]);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  if (loading) return <div className="p-10 text-[var(--text-muted)]">Loading&hellip;</div>;
  if (error || !asset)
    return <div className="p-10 text-[var(--status-offline)] font-mono-data">Error: {error}</div>;

  const status = computeAssetHealth(asset);
  const mins = minutesSince(asset.last_seen_at);
  const tableRows = [...buckets].reverse(); // newest-first for the table

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
              {status}
            </span>
            <span className="text-xs text-[var(--text-dim)]">
              {mins === null ? "never reported" : `last seen ${mins} min ago`}
            </span>
          </div>
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
