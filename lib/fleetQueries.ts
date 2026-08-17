import "server-only";

import { supabaseAdmin } from "./supabaseServer";
import type { Asset, TelemetrySample, TelemetryBucket, AlertEvent, AlertRule } from "./supabase";
import type {
  FleetAsset,
  FleetResult,
  AssetDetailResult,
  HeliumSeriesResult,
  AssetAlertsResult,
} from "./dataSource";

// The org-scoped read layer. Every function here takes an explicit orgId and
// filters by it — there is deliberately no "load everything" variant, so a
// forgotten filter is a compile error rather than a cross-tenant leak.
//
// These read `assets` directly rather than the public_assets view: the view
// omits org_id (so it can't be filtered) and the service-role client bypasses
// RLS anyway. The column list below IS the public-safe projection — it must
// never grow to include gateway_token, monitor_password or monitor_username.
const PUBLIC_ASSET_COLUMNS =
  "id, name, site_name, site_address, offline_threshold_minutes, status, " +
  "last_seen_at, last_sample_at, created_at, service_user, maintenance, " +
  "router_online, router_status_at, tailscale_online, tailscale_status_at";

const HISTORY_ROW_LIMIT = 5000;

/**
 * The demo org's id.
 *
 * /demo is public — no session, no cookie — so its endpoints resolve the org
 * from `orgs.is_demo` and NEVER from anything the caller supplies. That is what
 * keeps a public route from being talked into returning a real tenant's fleet.
 */
export async function demoOrgId(): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("orgs")
    .select("id")
    .eq("is_demo", true)
    .maybeSingle();
  return error || !data ? null : (data.id as string);
}

/**
 * Confirms an asset belongs to the org before any per-asset query runs.
 *
 * This is the check that makes the /api/asset/[id] routes safe: the asset id is
 * a client-supplied uuid, and asset_telemetry_15min / telemetry_samples /
 * alert_events carry no org_id of their own. Without this, knowing a uuid would
 * be enough to read another tenant's telemetry.
 */
export async function assetInOrg(assetId: string, orgId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("assets")
    .select("id")
    .eq("id", assetId)
    .eq("org_id", orgId)
    .maybeSingle();
  return !error && !!data;
}

/** Light asset list for the admin panel — no telemetry, no history. */
export async function listOrgAssets(orgId: string): Promise<{ assets: Asset[]; error: string | null }> {
  const { data, error } = await supabaseAdmin
    .from("assets")
    .select(PUBLIC_ASSET_COLUMNS)
    .eq("org_id", orgId)
    .order("name");
  if (error) return { assets: [], error: error.message };
  return { assets: (data ?? []) as unknown as Asset[], error: null };
}

export async function loadFleetForOrg(orgId: string, historyHours: number): Promise<FleetResult> {
  const historyCutoff = new Date(Date.now() - historyHours * 60 * 60 * 1000).toISOString();

  const { data: assetRows, error: assetsErr } = await supabaseAdmin
    .from("assets")
    .select(PUBLIC_ASSET_COLUMNS)
    .eq("org_id", orgId)
    .order("name");
  if (assetsErr) return { assets: [], error: assetsErr.message };

  const assets = (assetRows ?? []) as unknown as Asset[];
  const ids = assets.map((a) => a.id);
  // No assets in this org: return early rather than issuing `.in("asset_id", [])`
  // queries, which PostgREST answers with everything-or-nothing depending on
  // version. An empty fleet is a legitimate state for a newly created org.
  if (ids.length === 0) return { assets: [], error: null };

  const [
    { data: latest, error: latestErr },
    { data: history, error: historyErr },
    { data: rules, error: rulesErr },
  ] = await Promise.all([
    supabaseAdmin.from("latest_telemetry").select("*").in("asset_id", ids),
    supabaseAdmin
      // recorded_at = true reading time (not created_at = ingest time), so the
      // window and ordering stay correct now the collector batch-reports minute
      // rows whose created_at is all "now" but recorded_at spans the hour.
      .from("telemetry_samples")
      .select("*")
      .in("asset_id", ids)
      .gte("recorded_at", historyCutoff)
      .order("recorded_at", { ascending: true })
      .limit(HISTORY_ROW_LIMIT),
    // Per-asset overrides only; fleet-wide rows (asset_id null) stay server-side
    // with evaluate_alerts. org_id filter is belt-and-braces alongside asset_id.
    supabaseAdmin
      .from("alert_rules")
      .select("*")
      .eq("org_id", orgId)
      .not("asset_id", "is", null)
      .eq("enabled", true),
  ]);

  if (latestErr || historyErr || rulesErr) {
    return {
      assets: [],
      error: latestErr?.message || historyErr?.message || rulesErr?.message || "Failed to load",
    };
  }

  const latestByAsset = new Map((latest ?? []).map((t) => [t.asset_id, t as TelemetrySample]));
  const historyByAsset = new Map<string, TelemetrySample[]>();
  for (const sample of (history ?? []) as TelemetrySample[]) {
    const arr = historyByAsset.get(sample.asset_id) ?? [];
    arr.push(sample);
    historyByAsset.set(sample.asset_id, arr);
  }
  const rulesByAsset = new Map<string, AlertRule[]>();
  for (const r of (rules ?? []) as AlertRule[]) {
    if (!r.asset_id) continue;
    const arr = rulesByAsset.get(r.asset_id) ?? [];
    // numeric can arrive as a string from PostgREST — coerce so the resolver in
    // lib/faults compares numbers, not strings.
    arr.push({ ...r, threshold: Number(r.threshold) });
    rulesByAsset.set(r.asset_id, arr);
  }

  const fleet: FleetAsset[] = assets.map((a) => ({
    ...a,
    latest: latestByAsset.get(a.id) ?? null,
    history: historyByAsset.get(a.id) ?? [],
    alertRules: rulesByAsset.get(a.id) ?? [],
  }));

  return { assets: fleet, error: null };
}

export async function loadAssetDetailForOrg(
  assetId: string,
  orgId: string,
  historyHours: number
): Promise<AssetDetailResult> {
  const empty = { asset: null, latest: null, buckets: [], alertRules: [] };

  const { data: assetRow, error: assetErr } = await supabaseAdmin
    .from("assets")
    .select(PUBLIC_ASSET_COLUMNS)
    .eq("id", assetId)
    .eq("org_id", orgId)
    .maybeSingle();
  // Another tenant's asset and a genuinely missing one return the same thing on
  // purpose — "not found" must not double as an existence oracle for uuids.
  if (assetErr || !assetRow) return { ...empty, error: "Asset not found" };

  const [{ data: latestRow }, { data: bucketRows, error: bucketErr }, { data: rules }] =
    await Promise.all([
      supabaseAdmin.from("latest_telemetry").select("*").eq("asset_id", assetId).maybeSingle(),
      supabaseAdmin.rpc("asset_telemetry_15min", { p_asset_id: assetId, p_hours: historyHours }),
      supabaseAdmin.from("alert_rules").select("*").eq("asset_id", assetId).eq("enabled", true),
    ]);

  if (bucketErr) return { ...empty, error: bucketErr.message };

  const alertRules = ((rules ?? []) as AlertRule[]).map((r) => ({
    ...r,
    threshold: Number(r.threshold),
  }));

  return {
    asset: assetRow as unknown as Asset,
    latest: (latestRow as TelemetrySample) ?? null,
    buckets: (bucketRows ?? []) as TelemetryBucket[],
    alertRules,
    error: null,
  };
}

export async function loadHeliumSeriesForOrg(
  assetId: string,
  orgId: string,
  historyHours: number
): Promise<HeliumSeriesResult> {
  if (!(await assetInOrg(assetId, orgId))) return { points: [], error: "Asset not found" };

  const { data, error } = await supabaseAdmin.rpc("asset_telemetry_15min", {
    p_asset_id: assetId,
    p_hours: historyHours,
  });
  if (error) return { points: [], error: error.message };

  const points = ((data ?? []) as TelemetryBucket[])
    .filter((b) => b.he_lvl !== null)
    .map((b) => ({ t: new Date(b.created_at).getTime(), v: Number(b.he_lvl) }));
  return { points, error: null };
}

/**
 * A week of he_lvl for EVERY asset in one org, in one query.
 *
 * Replaces a per-asset fan-out: useFleetForecasts was making one HTTP request
 * per asset (17 for Numed), each with its own ownership check, every 10 minutes
 * for every open dashboard and wall display.
 */
export async function loadFleetHeliumForOrg(
  orgId: string,
  historyHours: number
): Promise<{ series: Record<string, { t: number; v: number }[]>; error: string | null }> {
  const { data, error } = await supabaseAdmin.rpc("org_helium_15min", {
    p_org_id: orgId,
    p_hours: historyHours,
  });
  if (error) return { series: {}, error: error.message };

  const series: Record<string, { t: number; v: number }[]> = {};
  for (const row of (data ?? []) as { asset_id: string; bucket: string; he_lvl: number }[]) {
    (series[row.asset_id] ??= []).push({ t: new Date(row.bucket).getTime(), v: Number(row.he_lvl) });
  }
  return { series, error: null };
}

export async function loadAssetAlertsForOrg(
  assetId: string,
  orgId: string,
  limit = 20
): Promise<AssetAlertsResult> {
  if (!(await assetInOrg(assetId, orgId))) return { events: [], error: "Asset not found" };

  const { data, error } = await supabaseAdmin
    .from("alert_events")
    .select("id, asset_id, alert_rule_id, kind, message, triggered_at, resolved_at, notified_at")
    .eq("asset_id", assetId)
    .order("triggered_at", { ascending: false })
    .limit(limit);
  if (error) return { events: [], error: error.message };
  return { events: (data ?? []) as AlertEvent[], error: null };
}
