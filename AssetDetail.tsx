"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { supabase, type Asset, type Site, type TelemetrySample } from "@/lib/supabase";
import { computeAssetHealth, minutesSince, STATUS_COLORS } from "@/lib/health";
import FieldRing from "@/components/FieldRing";
import MetricLineChart from "@/components/MetricLineChart";

const POLL_MS = 30_000;
const HISTORY_HOURS = 24;

const METRICS: { key: keyof TelemetrySample; label: string; unit: string; color: string }[] = [
  { key: "he_lvl", label: "He Lvl", unit: "%", color: "#5b8def" },
  { key: "h2o_flow", label: "H2O Flow", unit: "gpm", color: "#2fd47a" },
  { key: "he_press", label: "He Press", unit: "psi", color: "#f0a84a" },
  { key: "h2o_temp", label: "H2O Temp", unit: "°F", color: "#e15b8f" },
  { key: "shield", label: "Shield", unit: "", color: "#a679f2" },
  { key: "cs1", label: "CS1", unit: "", color: "#4ad4d4" },
];

export default function AssetDetail({ assetId }: { assetId: string }) {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [samples, setSamples] = useState<TelemetrySample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: assetRow, error: assetErr } = await supabase
      .from("public_assets")
      .select("*")
      .eq("id", assetId)
      .single();

    if (assetErr || !assetRow) {
      setError(assetErr?.message || "Asset not found");
      setLoading(false);
      return;
    }

    const historyCutoff = new Date(Date.now() - HISTORY_HOURS * 60 * 60 * 1000).toISOString();
    const [{ data: siteRow }, { data: history, error: histErr }] = await Promise.all([
      supabase.from("sites").select("*").eq("id", assetRow.site_id).single(),
      supabase
        .from("telemetry_samples")
        .select("*")
        .eq("asset_id", assetId)
        .gte("recorded_at", historyCutoff)
        .order("recorded_at", { ascending: true })
        .limit(2000),
    ]);

    if (histErr) {
      setError(histErr.message);
      setLoading(false);
      return;
    }

    setAsset(assetRow);
    setSite(siteRow ?? null);
    setSamples(history ?? []);
    setError(null);
    setLoading(false);
  }, [assetId]);

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
  const latest = samples[samples.length - 1];
  const tableRows = [...samples].reverse(); // newest-first for the table

  return (
    <div id="main-content" className="min-h-screen p-6 md:p-10" role="main">
      <Link href="/" className="text-xs text-[var(--text-dim)] hover:text-[var(--accent)]">
        &larr; Back to fleet
      </Link>

      <header className="flex items-start justify-between mt-4 mb-8">
        <div>
          <p className="text-xs tracking-[0.2em] uppercase text-[var(--text-dim)] mb-1">
            {site?.name ?? "Unassigned site"}
          </p>
          <h1 className="text-2xl md:text-3xl font-semibold">{asset.name}</h1>
          <p className="text-xs text-[var(--text-dim)] mt-1">
            {asset.magmon_version.toUpperCase()} &middot;{" "}
            <span style={{ color: STATUS_COLORS[status] }} className="capitalize">
              {status}
            </span>{" "}
            &middot; {mins === null ? "never reported" : `last seen ${mins} min ago`}
          </p>
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
        Trends (last 24 hours)
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-10">
        {METRICS.map((m) => (
          <MetricLineChart
            key={m.key}
            samples={samples}
            metricKey={m.key}
            label={m.label}
            unit={m.unit}
            color={m.color}
          />
        ))}
      </div>

      <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-3">
        Recent readings ({tableRows.length} in last 24h)
      </h2>

      {/* Mobile: stacked cards, no horizontal scroll needed */}
      <div className="flex flex-col gap-2 md:hidden">
        {tableRows.slice(0, 200).map((s) => (
          <div key={s.id} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
            <p className="text-xs text-[var(--text-dim)] mb-2">{new Date(s.recorded_at).toLocaleString()}</p>
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
          <p className="text-center text-[var(--text-dim)] py-6 rounded-lg border border-dashed border-[var(--border)]">
            No telemetry received yet.
          </p>
        )}
      </div>

      {/* Desktop/tablet: full table */}
      <div className="hidden md:block overflow-x-auto rounded-lg border border-[var(--border)]">
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
            </tr>
          </thead>
          <tbody>
            {tableRows.slice(0, 200).map((s) => (
              <tr key={s.id} className="border-b border-[var(--border)] last:border-0">
                <td className="px-3 py-2 text-[var(--text-muted)]">
                  {new Date(s.recorded_at).toLocaleString()}
                </td>
                <td className="px-3 py-2">{s.he_lvl ?? "—"}</td>
                <td className="px-3 py-2">{s.he_press ?? "—"}</td>
                <td className="px-3 py-2">{s.h2o_flow ?? "—"}</td>
                <td className="px-3 py-2">{s.h2o_temp ?? "—"}</td>
                <td className="px-3 py-2">{s.shield ?? "—"}</td>
                <td className="px-3 py-2">{s.cs1 ?? "—"}</td>
              </tr>
            ))}
            {tableRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-[var(--text-dim)]">
                  No telemetry received yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {tableRows.length > 200 && (
          <p className="text-xs text-[var(--text-dim)] px-3 py-2 border-t border-[var(--border)]">
            Showing the most recent 200 of {tableRows.length} readings.
          </p>
        )}
      </div>
      {tableRows.length > 200 && (
        <p className="text-xs text-[var(--text-dim)] md:hidden mt-2">
          Showing the most recent 200 of {tableRows.length} readings.
        </p>
      )}
    </div>
  );
}

function ReadingCell({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="rounded-md bg-[var(--bg-elevated)] px-2 py-1">
      <p className="text-[9px] uppercase tracking-wide text-[var(--text-dim)]">{label}</p>
      <p>{value ?? "—"}</p>
    </div>
  );
}

function MetricCard({ label, value, unit }: { label: string; value: number | null | undefined; unit: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-3">
      <p className="text-[10px] uppercase tracking-wide text-[var(--text-dim)]">{label}</p>
      <p className="font-mono-data text-lg mt-0.5">
        {value ?? "—"} <span className="text-xs text-[var(--text-dim)]">{unit}</span>
      </p>
    </div>
  );
}
