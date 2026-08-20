import "server-only";

import { supabaseAdmin } from "./supabaseServer";
import type { Asset, TelemetrySample, TelemetryBucket, AlertEvent, AlertRule } from "./supabase";
import type {
  FleetAlertEvent,
  FleetAsset,
  FleetResult,
  AssetDetailResult,
  HeliumSeriesResult,
  AssetAlertsResult,
} from "./dataSource";
import type { UnitAccess } from "./docsInfra";

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

/** One row of the engineer queue: an open alert plus the asset it belongs to. */
export type OpenAlertRow = {
  id: number;
  asset_id: string;
  assetName: string;
  kind: string;
  channel: string | null;
  severity: "warning" | "critical";
  message: string;
  detail: Record<string, unknown> | null;
  triggered_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  disposition: "accepted" | "ignored" | "false_alarm" | null;
  ack_note: string | null;
};

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
 * One org's brand strings, by id.
 *
 * Needed by the wall display: a display token has no user session, so
 * OrgBrandProvider (which reads the session) falls back to the built-in brand
 * and a white-labelled tenant's TV would show the wrong product name.
 */
export async function orgBrand(
  orgId: string
): Promise<{ productName: string; eyebrow: string; tagline: string; logoUrl: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from("orgs")
    .select("product_name, eyebrow, tagline, logo_url")
    .eq("id", orgId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    productName: data.product_name as string,
    eyebrow: data.eyebrow as string,
    tagline: (data.tagline as string) ?? "",
    // Carried here as well as on the session because a wall display has no user
    // session to read it from — this is the only path that brands a TV.
    logoUrl: (data.logo_url as string | null) ?? null,
  };
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
    { data: openEvents, error: openErr },
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
    // Open server-side alerts, so the card can show what the notifier already
    // emailed about. The embedded rule supplies the field name, which is what
    // lets lib/faults skip conditions it evaluates itself instead of showing a
    // duplicate pill.
    supabaseAdmin
      .from("alert_events")
      .select("id, asset_id, kind, channel, severity, message, triggered_at, detail, acknowledged_by, alert_rules(field)")
      .in("asset_id", ids)
      .is("resolved_at", null),
  ]);

  if (latestErr || historyErr || rulesErr || openErr) {
    return {
      assets: [],
      error:
        latestErr?.message || historyErr?.message || rulesErr?.message || openErr?.message ||
        "Failed to load",
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

  // PostgREST returns the embedded rule as an object (or null when the event
  // has no rule, i.e. offline / sensor_fault); `channel` covers the sensor-fault
  // case, where the metric is on the event itself rather than on a rule.
  type OpenRow = {
    id: number;
    asset_id: string;
    kind: string;
    channel: string | null;
    severity: string | null;
    message: string;
    triggered_at: string;
    detail: Record<string, unknown> | null;
    acknowledged_by: string | null;
    alert_rules: { field: string } | { field: string }[] | null;
  };
  const openByAsset = new Map<string, FleetAlertEvent[]>();
  for (const e of (openEvents ?? []) as unknown as OpenRow[]) {
    const rule = Array.isArray(e.alert_rules) ? e.alert_rules[0] : e.alert_rules;
    const arr = openByAsset.get(e.asset_id) ?? [];
    arr.push({
      id: e.id,
      kind: e.kind,
      message: e.message,
      triggeredAt: e.triggered_at,
      field: e.channel ?? rule?.field ?? null,
      severity: e.severity === "critical" ? "critical" : "warning",
      detail: e.detail ?? null,
      acknowledgedBy: e.acknowledged_by ?? null,
    });
    openByAsset.set(e.asset_id, arr);
  }

  const fleet: FleetAsset[] = assets.map((a) => ({
    ...a,
    latest: latestByAsset.get(a.id) ?? null,
    history: historyByAsset.get(a.id) ?? [],
    alertRules: rulesByAsset.get(a.id) ?? [],
    openAlerts: openByAsset.get(a.id) ?? [],
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
    .select("id, asset_id, alert_rule_id, kind, channel, severity, message, detail, acknowledged_at, acknowledged_by, disposition, triggered_at, resolved_at, notified_at")
    .eq("asset_id", assetId)
    .order("triggered_at", { ascending: false })
    .limit(limit);
  if (error) return { events: [], error: error.message };
  return { events: (data ?? []) as AlertEvent[], error: null };
}

/**
 * Every open alert for one org, newest first, with its asset's name.
 *
 * The engineer's queue. Deliberately org-scoped through the asset join rather
 * than by trusting an id from the caller: alert_events carries no org_id of its
 * own, so this is the only thing standing between a uuid and another tenant's
 * fault list.
 */
export async function loadOpenAlertsForOrg(orgId: string): Promise<{
  alerts: OpenAlertRow[];
  error: string | null;
}> {
  const { data: assetRows, error: aErr } = await supabaseAdmin
    .from("assets")
    .select("id, name, maintenance")
    .eq("org_id", orgId);
  if (aErr) return { alerts: [], error: aErr.message };

  const assets = (assetRows ?? []) as { id: string; name: string; maintenance: boolean }[];
  if (assets.length === 0) return { alerts: [], error: null };
  const nameOf = new Map(assets.map((a) => [a.id, a.name]));

  const { data, error } = await supabaseAdmin
    .from("alert_events")
    .select(
      "id, asset_id, kind, channel, severity, message, detail, triggered_at, " +
        "acknowledged_at, acknowledged_by, disposition, ack_note"
    )
    .in("asset_id", assets.map((a) => a.id))
    .is("resolved_at", null)
    .order("triggered_at", { ascending: false });
  if (error) return { alerts: [], error: error.message };

  const rows = (data ?? []) as unknown as (Omit<OpenAlertRow, "assetName"> & { asset_id: string })[];
  return {
    alerts: rows.map((r) => ({ ...r, assetName: nameOf.get(r.asset_id) ?? "unknown" })),
    error: null,
  };
}

/**
 * How to reach each unit's MagMon directly, for the gated /docs runbook.
 *
 * NOT part of PUBLIC_ASSET_COLUMNS and deliberately kept out of it:
 * monitor_host and the Pi's hostname are infrastructure, and the runbook is the
 * one surface already gated on admin-or-docs_access.
 *
 * The `ambiguousHost` flag is the reason this exists at all. Several sites hand
 * their MagMon the same private address — NM1027 (NMMC Hamilton) and NM1029
 * (Limestone) are both 192.168.14.199, NM1003 (Iuka) and NM1035 (Numed DSC) are
 * both 192.168.0.1 — so browsing that address over a tailnet subnet route
 * reaches whichever Pi currently owns the route, with nothing on screen to say
 * which. Marking the collisions turns a silent trap into a visible one.
 */
export async function loadUnitAccessForOrg(orgId: string): Promise<UnitAccess[]> {
  const { data, error } = await supabaseAdmin
    .from("assets")
    .select("name, site_name, monitor_host, tailscale_hostname, service_user")
    .eq("org_id", orgId)
    .order("name");
  if (error || !data) return [];

  const rows = data as unknown as {
    name: string;
    site_name: string | null;
    monitor_host: string | null;
    tailscale_hostname: string | null;
    service_user: string | null;
  }[];

  // Count each host so a shared one can be flagged on every unit that shares it.
  const hostCount = new Map<string, number>();
  for (const r of rows) {
    if (r.monitor_host) hostCount.set(r.monitor_host, (hostCount.get(r.monitor_host) ?? 0) + 1);
  }

  return rows.map((r) => ({
    name: r.name,
    site: r.site_name,
    magmonHost: r.monitor_host,
    piHost: r.tailscale_hostname,
    piUser: r.service_user || "pi",
    ambiguousHost: !!r.monitor_host && (hostCount.get(r.monitor_host) ?? 0) > 1,
  }));
}
