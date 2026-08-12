// The single seam between the UI and where its data comes from. The live app
// reads from Supabase exactly as before; demo mode reads from in-browser
// fixtures and never issues a network request. Dashboard/AssetDetail pick an
// implementation with getDataSource(demo) and are otherwise identical in both
// modes.

import { supabase, type Asset, type TelemetrySample, type TelemetryBucket, type AlertEvent, type AlertRule } from "./supabase";
import { demoFleet, demoAssetDetail, demoAssetAlerts } from "./demoFixtures";
import type { HeliumPoint } from "./forecast";

export type FleetAsset = Asset & {
  latest: TelemetrySample | null;
  history: TelemetrySample[];
  // Per-asset threshold overrides (alert_rules rows where asset_id = this asset).
  // Fleet-wide defaults (asset_id null) are left to the built-in FAULT_THRESHOLDS
  // / the server evaluator; only overrides ride along here. Empty when none.
  alertRules: AlertRule[];
};

export type FleetResult = { assets: FleetAsset[]; error: string | null };
export type AssetDetailResult = {
  asset: Asset | null;
  latest: TelemetrySample | null;
  buckets: TelemetryBucket[];
  error: string | null;
};
export type HeliumSeriesResult = { points: HeliumPoint[]; error: string | null };
export type AssetAlertsResult = { events: AlertEvent[]; error: string | null };

export interface DataSource {
  loadFleet(historyHours: number): Promise<FleetResult>;
  loadAssetDetail(assetId: string, historyHours: number): Promise<AssetDetailResult>;
  // A downsampled he_lvl series (15-min buckets) over `historyHours`, for the
  // boil-off forecast. Uses the same pre-aggregation as the detail charts so a
  // multi-day window stays a few hundred rows, not tens of thousands of raw ones.
  loadHeliumSeries(assetId: string, historyHours: number): Promise<HeliumSeriesResult>;
  // Persisted alert_events for one asset (open + recent resolved), newest first.
  // The system-of-record view that evaluate_alerts() maintains on its cron.
  loadAssetAlerts(assetId: string, limit?: number): Promise<AssetAlertsResult>;
}

// ---- live: Supabase ------------------------------------------------------

const liveDataSource: DataSource = {
  async loadFleet(historyHours) {
    const historyCutoff = new Date(Date.now() - historyHours * 60 * 60 * 1000).toISOString();

    const [
      { data: assetRows, error: assetsErr },
      { data: latest, error: latestErr },
      { data: history, error: historyErr },
      { data: rules, error: rulesErr },
    ] = await Promise.all([
      supabase.from("public_assets").select("*").order("name"),
      supabase.from("latest_telemetry").select("*"),
      supabase
        .from("telemetry_samples")
        .select("*")
        .gte("created_at", historyCutoff)
        .order("created_at", { ascending: true })
        .limit(5000),
      // Per-asset overrides only; fleet-wide rows (asset_id null) stay server-side.
      supabase.from("alert_rules").select("*").not("asset_id", "is", null).eq("enabled", true),
    ]);

    if (assetsErr || latestErr || historyErr || rulesErr) {
      return { assets: [], error: assetsErr?.message || latestErr?.message || historyErr?.message || rulesErr?.message || "Failed to load" };
    }

    const latestByAsset = new Map((latest ?? []).map((t) => [t.asset_id, t]));
    const historyByAsset = new Map<string, TelemetrySample[]>();
    for (const sample of history ?? []) {
      const arr = historyByAsset.get(sample.asset_id) ?? [];
      arr.push(sample);
      historyByAsset.set(sample.asset_id, arr);
    }
    const rulesByAsset = new Map<string, AlertRule[]>();
    for (const r of rules ?? []) {
      if (!r.asset_id) continue;
      const arr = rulesByAsset.get(r.asset_id) ?? [];
      // numeric can arrive as a string from PostgREST — coerce so the resolver
      // in lib/faults compares numbers, not strings.
      arr.push({ ...r, threshold: Number(r.threshold) });
      rulesByAsset.set(r.asset_id, arr);
    }

    const assets: FleetAsset[] = (assetRows ?? []).map((a) => ({
      ...a,
      latest: latestByAsset.get(a.id) ?? null,
      history: historyByAsset.get(a.id) ?? [],
      alertRules: rulesByAsset.get(a.id) ?? [],
    }));

    return { assets, error: null };
  },

  async loadAssetDetail(assetId, historyHours) {
    const { data: assetRow, error: assetErr } = await supabase
      .from("public_assets")
      .select("*")
      .eq("id", assetId)
      .single();

    if (assetErr || !assetRow) {
      return { asset: null, latest: null, buckets: [], error: assetErr?.message || "Asset not found" };
    }

    const [{ data: latestRow }, { data: bucketRows, error: bucketErr }] = await Promise.all([
      supabase.from("latest_telemetry").select("*").eq("asset_id", assetId).maybeSingle(),
      supabase.rpc("asset_telemetry_15min", { p_asset_id: assetId, p_hours: historyHours }),
    ]);

    if (bucketErr) {
      return { asset: null, latest: null, buckets: [], error: bucketErr.message };
    }

    return { asset: assetRow, latest: latestRow ?? null, buckets: bucketRows ?? [], error: null };
  },

  async loadHeliumSeries(assetId, historyHours) {
    const { data, error } = await supabase.rpc("asset_telemetry_15min", {
      p_asset_id: assetId,
      p_hours: historyHours,
    });
    if (error) return { points: [], error: error.message };
    const points = (data ?? [])
      .filter((b: TelemetryBucket) => b.he_lvl !== null)
      .map((b: TelemetryBucket) => ({ t: new Date(b.created_at).getTime(), v: Number(b.he_lvl) }));
    return { points, error: null };
  },

  async loadAssetAlerts(assetId, limit = 20) {
    const { data, error } = await supabase
      .from("alert_events")
      .select("id, asset_id, alert_rule_id, kind, message, triggered_at, resolved_at, notified_at")
      .eq("asset_id", assetId)
      .order("triggered_at", { ascending: false })
      .limit(limit);
    if (error) return { events: [], error: error.message };
    return { events: (data ?? []) as AlertEvent[], error: null };
  },
};

// ---- demo: in-browser fixtures ------------------------------------------

const demoDataSource: DataSource = {
  async loadFleet(historyHours) {
    return { assets: demoFleet(historyHours), error: null };
  },
  async loadAssetDetail(assetId, historyHours) {
    const detail = demoAssetDetail(assetId, historyHours);
    if (!detail) return { asset: null, latest: null, buckets: [], error: "Asset not found" };
    return { ...detail, error: null };
  },
  async loadHeliumSeries(assetId, historyHours) {
    const detail = demoAssetDetail(assetId, historyHours);
    if (!detail) return { points: [], error: "Asset not found" };
    const points = detail.buckets
      .filter((b) => b.he_lvl !== null)
      .map((b) => ({ t: new Date(b.created_at).getTime(), v: Number(b.he_lvl) }));
    return { points, error: null };
  },
  async loadAssetAlerts(assetId) {
    return { events: demoAssetAlerts(assetId), error: null };
  },
};

export function getDataSource(demo: boolean): DataSource {
  return demo ? demoDataSource : liveDataSource;
}
