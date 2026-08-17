// The single seam between the UI and where its data comes from.
//
// The live source used to query Supabase directly from the browser with the
// anon key. As of the multi-tenant Phase 2 cutover it fetches this app's own
// org-scoped route handlers instead (/api/fleet, /api/asset/[id], ...), which
// resolve the httpOnly session cookie server-side and filter every query by the
// session's active org. The browser no longer holds database credentials and
// cannot ask for another tenant's data — see lib/fleetQueries.ts.
//
// Keeping this interface intact is what let the cutover happen without touching
// Dashboard / AssetDetail / TvWall: they are polling client components, and
// converting them to server components would have broken their setInterval
// refresh. They still call getDataSource(demo).loadX() exactly as before.
//
// Demo mode still reads in-browser fixtures and issues no network request,
// because /demo is unauthenticated and has no session to scope. That collapses
// in Phase 4 when the demo becomes a real seeded org.

import type { Asset, TelemetrySample, TelemetryBucket, AlertEvent, AlertRule } from "./supabase";
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
  // Per-asset overrides for this asset, carried so the detail page evaluates
  // value-faults against the exact same thresholds as the fleet card (which
  // loads them in loadFleet). Without this an override-asset would show a pill
  // on the detail page that the card suppresses — a fresh card/detail mismatch.
  alertRules: AlertRule[];
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

// ---- live: this app's org-scoped API ------------------------------------

// Every response already carries `error: string | null`, so a failed request is
// shaped like a successful one and the components' existing error handling keeps
// working unchanged.
type WithError = { error: string | null };

async function getJson<T extends WithError>(
  path: string,
  onError: (message: string) => T
): Promise<T> {
  try {
    // no-store: these are live readings behind a session, and a cached response
    // would be both stale and a cross-tenant hazard.
    const res = await fetch(path, { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as T | null;
    if (!res.ok) {
      // 401 = the session cookie expired or was cleared. Surfaced as an ordinary
      // error rather than a redirect, so a transient failure doesn't yank a wall
      // display off its dashboard mid-rotation.
      const message =
        body?.error ?? (res.status === 401 ? "Session expired" : `Request failed (${res.status})`);
      return onError(message);
    }
    return body ?? onError("Empty response");
  } catch (e) {
    return onError(e instanceof Error ? e.message : "Network error");
  }
}

const liveDataSource: DataSource = {
  async loadFleet(historyHours) {
    return getJson<FleetResult>(`/api/fleet?hours=${historyHours}`, (error) => ({
      assets: [],
      error,
    }));
  },

  async loadAssetDetail(assetId, historyHours) {
    return getJson<AssetDetailResult>(
      `/api/asset/${encodeURIComponent(assetId)}?hours=${historyHours}`,
      (error) => ({ asset: null, latest: null, buckets: [], alertRules: [], error })
    );
  },

  async loadHeliumSeries(assetId, historyHours) {
    return getJson<HeliumSeriesResult>(
      `/api/asset/${encodeURIComponent(assetId)}/helium?hours=${historyHours}`,
      (error) => ({ points: [], error })
    );
  },

  async loadAssetAlerts(assetId, limit = 20) {
    return getJson<AssetAlertsResult>(
      `/api/asset/${encodeURIComponent(assetId)}/alerts?limit=${limit}`,
      (error) => ({ events: [], error })
    );
  },
};
// ---- demo: in-browser fixtures ------------------------------------------

const demoDataSource: DataSource = {
  async loadFleet(historyHours) {
    return { assets: demoFleet(historyHours), error: null };
  },
  async loadAssetDetail(assetId, historyHours) {
    const detail = demoAssetDetail(assetId, historyHours);
    if (!detail) return { asset: null, latest: null, buckets: [], alertRules: [], error: "Asset not found" };
    // Demo has no per-asset overrides — value-faults evaluate against defaults.
    return { ...detail, alertRules: [], error: null };
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
