// The single seam between the UI and where its data comes from. The live app
// reads from Supabase exactly as before; demo mode reads from in-browser
// fixtures and never issues a network request. Dashboard/AssetDetail pick an
// implementation with getDataSource(demo) and are otherwise identical in both
// modes.

import { supabase, type Asset, type TelemetrySample, type TelemetryBucket } from "./supabase";
import { demoFleet, demoAssetDetail } from "./demoFixtures";

export type FleetAsset = Asset & {
  latest: TelemetrySample | null;
  history: TelemetrySample[];
};

export type FleetResult = { assets: FleetAsset[]; error: string | null };
export type AssetDetailResult = {
  asset: Asset | null;
  latest: TelemetrySample | null;
  buckets: TelemetryBucket[];
  error: string | null;
};

export interface DataSource {
  loadFleet(historyHours: number): Promise<FleetResult>;
  loadAssetDetail(assetId: string, historyHours: number): Promise<AssetDetailResult>;
}

// ---- live: Supabase ------------------------------------------------------

const liveDataSource: DataSource = {
  async loadFleet(historyHours) {
    const historyCutoff = new Date(Date.now() - historyHours * 60 * 60 * 1000).toISOString();

    const [
      { data: assetRows, error: assetsErr },
      { data: latest, error: latestErr },
      { data: history, error: historyErr },
    ] = await Promise.all([
      supabase.from("public_assets").select("*").order("name"),
      supabase.from("latest_telemetry").select("*"),
      supabase
        .from("telemetry_samples")
        .select("*")
        .gte("created_at", historyCutoff)
        .order("created_at", { ascending: true })
        .limit(5000),
    ]);

    if (assetsErr || latestErr || historyErr) {
      return { assets: [], error: assetsErr?.message || latestErr?.message || historyErr?.message || "Failed to load" };
    }

    const latestByAsset = new Map((latest ?? []).map((t) => [t.asset_id, t]));
    const historyByAsset = new Map<string, TelemetrySample[]>();
    for (const sample of history ?? []) {
      const arr = historyByAsset.get(sample.asset_id) ?? [];
      arr.push(sample);
      historyByAsset.set(sample.asset_id, arr);
    }

    const assets: FleetAsset[] = (assetRows ?? []).map((a) => ({
      ...a,
      latest: latestByAsset.get(a.id) ?? null,
      history: historyByAsset.get(a.id) ?? [],
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
};

export function getDataSource(demo: boolean): DataSource {
  return demo ? demoDataSource : liveDataSource;
}
