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
// Phase 4 collapsed the last duplication: the demo used to be a SECOND
// implementation reading in-browser fixtures, so every UI change had to work
// twice and the demo could silently drift from the real app. The demo is now an
// ordinary tenant with real rows, so both modes run the SAME code and differ
// only by URL prefix — /api/* (session-scoped) vs /api/demo/* (public, always
// the is_demo org). One data path, and the demo exercises exactly what Numed
// uses, org scoping included.

import type { Asset, TelemetrySample, TelemetryBucket, AlertEvent, AlertRule } from "./supabase";
import type { HeliumPoint } from "./forecast";
import type { AmbientResult, WeatherResult } from "./weatherTypes";

/**
 * An open server-side alert, carried onto the fleet card.
 *
 * evaluate_alerts (schema.sql) and lib/faults.ts used to be two disjoint alarm
 * systems: the server emailed about h2o_flow / h2o_temp / sensor_fault, which
 * the card could not render, while the card showed a warming coldhead that the
 * server never emailed about. A unit could therefore be alarming loudly in one
 * place and look perfectly healthy in the other — NM1006 and NM1027 had open
 * alerts and clean cards on 2026-08-19. This carries the server's view to the
 * client so the card can show both.
 *
 * `field` is resolved from the event's rule (threshold events) or its channel
 * (sensor faults) purely so lib/faults can drop anything it already evaluates
 * itself and avoid double-pilling the same condition.
 */
export type FleetAlertEvent = {
  id: number;
  kind: string;
  message: string;
  triggeredAt: string;
  field: string | null;
  severity: "warning" | "critical";
  /** Structured evidence behind a diagnostic finding (slope, projection, the
   *  readings a cross-signal diagnosis was drawn from). Null for plain
   *  threshold and connectivity events. */
  detail: Record<string, unknown> | null;
  acknowledgedBy: string | null;
};

export type FleetAsset = Asset & {
  latest: TelemetrySample | null;
  history: TelemetrySample[];
  // Per-asset threshold overrides (alert_rules rows where asset_id = this asset).
  // Fleet-wide defaults (asset_id null) are left to the built-in FAULT_THRESHOLDS
  // / the server evaluator; only overrides ride along here. Empty when none.
  alertRules: AlertRule[];
  // Currently-open alert_events for this asset (resolved_at is null).
  openAlerts: FleetAlertEvent[];
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
/** Whole-fleet helium history, keyed by asset id. One request, not one per asset. */
export type FleetHeliumResult = { series: Record<string, HeliumPoint[]>; error: string | null };
export type AssetAlertsResult = { events: AlertEvent[]; error: string | null };

// ---- morning debrief ------------------------------------------------------

/**
 * Where one alert_event sits relative to the debrief window:
 *   new      opened in the window and still open at the 9am boundary
 *   flapped  opened AND resolved inside the window — came and went overnight
 *   cleared  opened before the window, recovered inside it
 *   ongoing  opened before the window and still open at the boundary
 */
export type DebriefBucket = "new" | "flapped" | "cleared" | "ongoing";

export type DebriefEntry = {
  id: number;
  assetId: string;
  assetName: string;
  /** null for offline/reporting_stalled; the rule id for threshold events. */
  alertRuleId: string | null;
  kind: string;
  message: string;
  triggeredAt: string;
  resolvedAt: string | null;
  bucket: DebriefBucket;
  /** Resolved after the 9am cutoff — reported as it stood, flagged as since-cleared. */
  resolvedAfterWindow: boolean;
  /**
   * Covered by a mute, so it never emailed or pushed.
   *
   * The debrief still lists it — muting quiets an alert, it does not hide one —
   * but a review that presents a known, owned, deliberately-silenced condition
   * as if it were this morning's news is the fatigue this is meant to reduce.
   */
  muted: boolean;
};

export type DebriefResult = {
  // ISO bounds plus the zone they were measured in, so the client formats the
  // same window the server computed instead of re-deriving it in the browser's
  // own zone and disagreeing about which morning this is.
  window: { start: string; end: string; timeZone: string; hour: number };
  entries: DebriefEntry[];
  counts: { opened: number; resolved: number; stillOpen: number; assetsAffected: number };
  error: string | null;
};

export interface DataSource {
  loadFleet(historyHours: number): Promise<FleetResult>;
  loadAssetDetail(assetId: string, historyHours: number): Promise<AssetDetailResult>;
  // A downsampled he_lvl series (15-min buckets) over `historyHours`, for the
  // boil-off forecast. Uses the same pre-aggregation as the detail charts so a
  // multi-day window stays a few hundred rows, not tens of thousands of raw ones.
  loadHeliumSeries(assetId: string, historyHours: number): Promise<HeliumSeriesResult>;
  // Fleet-wide equivalent for the glance surfaces (dashboard + TV), which need
  // every asset's trend at once. Fetching them one at a time was 17 round trips
  // per refresh; this is one.
  loadFleetHelium(historyHours: number): Promise<FleetHeliumResult>;
  // Persisted alert_events for one asset (open + recent resolved), newest first.
  // The system-of-record view that evaluate_alerts() maintains on its cron.
  loadAssetAlerts(assetId: string, limit?: number): Promise<AssetAlertsResult>;
  // The 9am-to-9am alert digest for the whole org. Derived on read from
  // alert_events — no snapshot table, no nightly job.
  loadDebrief(): Promise<DebriefResult>;
  // Outside conditions at each site, keyed by asset id. Its own call rather
  // than a field on loadFleet: the fleet poll is every 30s and must not wait on
  // api.weather.gov, and weather that is ten minutes old is still weather.
  loadWeather(): Promise<WeatherResult>;
  // Outside temperature over the same window the asset page charts, so the
  // water trend can be read against the weather that drove it.
  loadAmbient(assetId: string, historyHours: number): Promise<AmbientResult>;
}

// ---- one implementation, two prefixes ------------------------------------

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

/**
 * @param base "/api" for the signed-in app (scoped to the session's active org),
 *             "/api/demo" for the public demo (always the is_demo org).
 */
function makeDataSource(base: string): DataSource {
  return {
    async loadFleet(historyHours) {
      return getJson<FleetResult>(`${base}/fleet?hours=${historyHours}`, (error) => ({
        assets: [],
        error,
      }));
    },

    async loadAssetDetail(assetId, historyHours) {
      return getJson<AssetDetailResult>(
        `${base}/asset/${encodeURIComponent(assetId)}?hours=${historyHours}`,
        (error) => ({ asset: null, latest: null, buckets: [], alertRules: [], error })
      );
    },

    async loadHeliumSeries(assetId, historyHours) {
      return getJson<HeliumSeriesResult>(
        `${base}/asset/${encodeURIComponent(assetId)}/helium?hours=${historyHours}`,
        (error) => ({ points: [], error })
      );
    },

    async loadFleetHelium(historyHours) {
      return getJson<FleetHeliumResult>(`${base}/fleet/helium?hours=${historyHours}`, (error) => ({
        series: {},
        error,
      }));
    },

    async loadAssetAlerts(assetId, limit = 20) {
      return getJson<AssetAlertsResult>(
        `${base}/asset/${encodeURIComponent(assetId)}/alerts?limit=${limit}`,
        (error) => ({ events: [], error })
      );
    },

    async loadWeather() {
      return getJson<WeatherResult>(`${base}/weather`, (error) => ({ weather: {}, error }));
    },

    async loadAmbient(assetId, historyHours) {
      return getJson<AmbientResult>(
        `${base}/asset/${encodeURIComponent(assetId)}/ambient?hours=${historyHours}`,
        (error) => ({ points: [], station: null, error })
      );
    },

    async loadDebrief() {
      return getJson<DebriefResult>(`${base}/debrief`, (error) => ({
        // A failed fetch must still carry a window the UI can render a header
        // from, so the error state looks like the page rather than a blank slab.
        window: { start: "", end: "", timeZone: "UTC", hour: 9 },
        entries: [],
        counts: { opened: 0, resolved: 0, stillOpen: 0, assetsAffected: 0 },
        error,
      }));
    },
  };
}

const liveDataSource = makeDataSource("/api");
const demoDataSource = makeDataSource("/api/demo");

export function getDataSource(demo: boolean): DataSource {
  return demo ? demoDataSource : liveDataSource;
}
