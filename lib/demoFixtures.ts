// Synthetic fleet for demo mode. Everything here is generated in the browser —
// demo mode NEVER touches Supabase, so no real customer/site/asset data can
// reach a /demo URL. Values are deterministic functions of (asset, metric,
// time): stable enough that a metric doesn't jump wildly between 30s polls, but
// time-dependent so the charts visibly evolve on a live walkthrough.

import type { Asset, TelemetrySample, TelemetryBucket, AlertEvent } from "./supabase";

export type DemoFleetAsset = Asset & {
  latest: TelemetrySample | null;
  history: TelemetrySample[];
  alertRules: never[]; // demo has no per-asset overrides — always empty
};

// ---- deterministic helpers ----------------------------------------------

function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 — tiny seeded PRNG. Same seed → same sequence, so per-asset
// baselines/phases are stable across reloads (only wall-clock time moves).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- metric model --------------------------------------------------------

type MetricKey = "he_lvl" | "he_press" | "h2o_flow" | "h2o_temp" | "shield" | "cs1";

type MetricCfg = {
  key: MetricKey;
  baseline: number;
  amp: number; // slow swing amplitude
  periodMin: number; // slow swing period
  noiseAmp: number; // faster ripple so the trace isn't a clean sine
  decimals: number;
  min: number;
  max: number;
};

const METRIC_CFGS: MetricCfg[] = [
  { key: "he_lvl", baseline: 66, amp: 3.5, periodMin: 190, noiseAmp: 0.6, decimals: 1, min: 0, max: 100 },
  { key: "he_press", baseline: 1.0, amp: 0.06, periodMin: 95, noiseAmp: 0.03, decimals: 2, min: 0, max: 10 },
  { key: "h2o_flow", baseline: 3.0, amp: 0.5, periodMin: 65, noiseAmp: 0.12, decimals: 1, min: 0, max: 8 },
  { key: "h2o_temp", baseline: 52, amp: 3.2, periodMin: 240, noiseAmp: 0.7, decimals: 0, min: 32, max: 90 },
  { key: "shield", baseline: 35, amp: 2.4, periodMin: 300, noiseAmp: 0.5, decimals: 0, min: 0, max: 80 },
  { key: "cs1", baseline: 4.6, amp: 0.22, periodMin: 130, noiseAmp: 0.05, decimals: 1, min: 0, max: 10 },
];

function clampRound(v: number, cfg: MetricCfg): number {
  const clamped = Math.min(cfg.max, Math.max(cfg.min, v));
  const f = 10 ** cfg.decimals;
  return Math.round(clamped * f) / f;
}

// Value of one metric for one asset at time tMs. The per-asset PRNG (seeded by
// assetSeed+metric) fixes a phase and a small baseline shift, so each asset has
// its own steady personality while all of them drift smoothly with time.
function metricValue(assetSeed: number, cfg: MetricCfg, tMs: number, skew: number): number {
  const rnd = mulberry32(assetSeed ^ hashSeed(cfg.key));
  const phase = rnd() * Math.PI * 2;
  const baseAdj = cfg.baseline * (0.92 + rnd() * 0.16) * skew;
  const tMin = tMs / 60000;
  const slow = cfg.amp * Math.sin((tMin / cfg.periodMin) * 2 * Math.PI + phase);
  const ripple = cfg.noiseAmp * Math.sin((tMin / 6.3) * 2 * Math.PI + phase * 1.7);
  return clampRound(baseAdj + slow + ripple, cfg);
}

function sampleAt(spec: AssetSpec, tMs: number, nowMs: number): TelemetrySample {
  const metrics = Object.fromEntries(
    METRIC_CFGS.map((cfg) => [cfg.key, metricValue(spec.seed, cfg, tMs, spec.skew?.[cfg.key] ?? 1)])
  ) as Record<MetricKey, number>;

  // CS1 = 0 means the compressor is running (matches real fleet data, where a
  // healthy unit reports CS1 0.0). The synthetic metric model wanders above 0,
  // which TV mode would read as "compressor OFF", so pin it unless a fault is
  // injected for this unit.
  metrics.cs1 = spec.inject?.cs1 ?? 0;
  if (spec.inject?.he_lvl !== undefined) {
    metrics.he_lvl = spec.inject.he_lvl;
  } else if (spec.boilOffPerDay) {
    // A steady linear decline anchored at `now` (drift 0 at now, higher in the
    // past), so the boil-off forecast has a real slope to fit. Re-clamped since
    // the drift is applied after the metric model's own clamp.
    const drift = spec.boilOffPerDay * ((tMs - nowMs) / 86_400_000);
    metrics.he_lvl = Math.max(0, Math.round((metrics.he_lvl + drift) * 10) / 10);
  }
  if (spec.inject?.shield !== undefined) metrics.shield = spec.inject.shield;

  // Coldhead temperature isn't a typed column — TV mode reads it from `data`.
  // Healthy ~4.2 K; injected units run warm.
  const coldheadK = spec.inject?.coldheadK ?? 4.2;

  const iso = new Date(tMs).toISOString();
  return {
    id: Math.floor(tMs / 1000),
    asset_id: spec.id,
    recorded_at: iso,
    created_at: iso,
    ...metrics,
    data: { source: "demo", ColdheadRuO: coldheadK },
  };
}

// ---- the fixed demo roster ----------------------------------------------

type AssetSpec = {
  id: string;
  name: string;
  site_name: string;
  site_address: string;
  // Minutes since the unit last reported. null = never reported (unknown).
  // Health is derived from this by computeAssetHealth: <=30 online, 30–60
  // stale, >60 offline, null unknown.
  lastSeenMinAgo: number | null;
  // Optional per-metric multiplier to give a couple of units distinctive
  // (but still plausible) readings, e.g. a lower helium level.
  skew?: Partial<Record<MetricKey, number>>;
  // Injected fault values so /demo/tv can demonstrate value-based alarms:
  // a compressor-off unit, a warm coldhead, etc. Absent = healthy.
  inject?: Partial<{ cs1: number; coldheadK: number; he_lvl: number; shield: number }>;
  // Suppress value alarms on the TV (known-warm / in-service unit).
  maintenance?: boolean;
  // Simulate InHand DM reporting this unit's iR305 cellular link down — shows a
  // red "iR305 down" connectivity chip beside the status chip (informational).
  routerOffline?: boolean;
  // Simulate the collector Pi's Tailscale node unreachable — shows a red
  // "Tailscale down" connectivity chip.
  tailscaleOffline?: boolean;
  // A steady helium boil-off in %/day (negative = losing helium), so the
  // days-to-refill forecast has a real declining trend to demonstrate. Absent =
  // flat (healthy coldhead).
  boilOffPerDay?: number;
  seed: number;
};

const ROSTER: AssetSpec[] = [
  { id: "MM-1001", name: "MM-1001", site_name: "Riverbend Imaging Center", site_address: "1200 Riverbend Dr, Springfield", lastSeenMinAgo: 2, seed: hashSeed("MM-1001") },
  { id: "MM-1002", name: "MM-1002", site_name: "Summit Diagnostic Center", site_address: "455 Summit Ave, Fairview", lastSeenMinAgo: 4, inject: { cs1: 33, coldheadK: 58 }, seed: hashSeed("MM-1002") },
  { id: "MM-1003", name: "MM-1003", site_name: "Lakeside Medical Center", site_address: "88 Lakeshore Blvd, Elmwood", lastSeenMinAgo: 1, seed: hashSeed("MM-1003") },
  { id: "MM-1004", name: "MM-1004", site_name: "Harbor Radiology", site_address: "310 Harbor St, Bayport", lastSeenMinAgo: 47, seed: hashSeed("MM-1004") },
  { id: "MM-1005", name: "MM-1005", site_name: "Grandview Regional Hospital", site_address: "2 Grandview Pkwy, Northfield", lastSeenMinAgo: 6, skew: { he_lvl: 0.42 }, boilOffPerDay: -0.6, seed: hashSeed("MM-1005") },
  { id: "MM-1006", name: "MM-1006", site_name: "Cedar Valley Clinic", site_address: "77 Cedar Valley Rd, Ashton", lastSeenMinAgo: 214, seed: hashSeed("MM-1006") },
  { id: "MM-1007", name: "MM-1007", site_name: "Northgate Imaging", site_address: "1450 Northgate Blvd, Westbrook", lastSeenMinAgo: 3, inject: { coldheadK: 128, he_lvl: 0, shield: 240 }, maintenance: true, seed: hashSeed("MM-1007") },
  { id: "MM-1008", name: "MM-1008", site_name: "Pinehurst Health", site_address: "9 Pinehurst Way, Millbrook", lastSeenMinAgo: 9, boilOffPerDay: -1.3, seed: hashSeed("MM-1008") },
  { id: "MM-1009", name: "MM-1009", site_name: "Fairmont Mobile MRI", site_address: "Mobile unit · region 4", lastSeenMinAgo: null, seed: hashSeed("MM-1009") },
  { id: "MM-1010", name: "MM-1010", site_name: "Westland Imaging", site_address: "620 Westland Ave, Crestline", lastSeenMinAgo: 5, seed: hashSeed("MM-1010") },
  { id: "MM-1011", name: "MM-1011", site_name: "Glenmore Regional Hospital", site_address: "875 Ridgeway Ave, Glenmore · iR305", lastSeenMinAgo: 88, routerOffline: true, seed: hashSeed("MM-1011") },
  { id: "MM-1012", name: "MM-1012", site_name: "Cedar Falls Imaging", site_address: "300 Cedar Falls Rd, Parkview · Pi", lastSeenMinAgo: 132, tailscaleOffline: true, seed: hashSeed("MM-1012") },
];

// Every demo asset id, exposed so the demo docs can reference a consistent
// fleet rather than invent its own separate list.
export const DEMO_ASSET_IDS = ROSTER.map((a) => a.id);

function specToAsset(spec: AssetSpec, now: number): Asset {
  const lastSeen = spec.lastSeenMinAgo === null ? null : new Date(now - spec.lastSeenMinAgo * 60000).toISOString();
  return {
    id: spec.id,
    name: spec.name,
    site_name: spec.site_name,
    site_address: spec.site_address,
    offline_threshold_minutes: null,
    status: null,
    last_seen_at: lastSeen,
    // Demo units' data freshness mirrors last-seen, so health (which now keys off
    // last_sample_at) matches each spec's lastSeenMinAgo exactly as before.
    last_sample_at: lastSeen,
    created_at: new Date(now - 400 * 24 * 60 * 60 * 1000).toISOString(),
    service_user: "gateway",
    maintenance: spec.maintenance ?? false,
    router_online: spec.routerOffline ? false : null,
    router_status_at: spec.routerOffline ? lastSeen : null,
    tailscale_online: spec.tailscaleOffline ? false : null,
    tailscale_status_at: spec.tailscaleOffline ? lastSeen : null,
  };
}

// The most recent reading lands at last_seen (not "now"), so a stale/offline
// unit's numbers and charts stop where it went quiet — matching its status.
function effectiveEnd(spec: AssetSpec, now: number): number | null {
  if (spec.lastSeenMinAgo === null) return null;
  return now - spec.lastSeenMinAgo * 60000;
}

// ---- public generators ---------------------------------------------------

export function demoFleet(historyHours: number): DemoFleetAsset[] {
  const now = Date.now();
  const stepMs = 5 * 60000; // a fleet history point every 5 minutes
  const spanMs = historyHours * 60 * 60 * 1000;

  return ROSTER.map((spec) => {
    const asset = specToAsset(spec, now);
    const end = effectiveEnd(spec, now);
    if (end === null) return { ...asset, latest: null, history: [], alertRules: [] };

    const history: TelemetrySample[] = [];
    for (let t = end - spanMs; t <= end; t += stepMs) history.push(sampleAt(spec, t, now));
    return { ...asset, latest: sampleAt(spec, end, now), history, alertRules: [] };
  });
}

export function demoAssetDetail(
  assetId: string,
  historyHours: number
): { asset: Asset; latest: TelemetrySample | null; buckets: TelemetryBucket[] } | null {
  const spec = ROSTER.find((a) => a.id === assetId);
  if (!spec) return null;

  const now = Date.now();
  const asset = specToAsset(spec, now);
  const end = effectiveEnd(spec, now);
  if (end === null) return { asset, latest: null, buckets: [] };

  // 15-minute averaged buckets, oldest→newest, mirroring the asset_telemetry_15min RPC.
  const stepMs = 15 * 60000;
  const buckets: TelemetryBucket[] = [];
  for (let t = end - historyHours * 60 * 60 * 1000; t <= end; t += stepMs) {
    const s = sampleAt(spec, t, now);
    const countRnd = mulberry32(spec.seed ^ Math.floor(t / stepMs));
    buckets.push({
      created_at: new Date(t).toISOString(),
      he_lvl: s.he_lvl,
      he_press: s.he_press,
      h2o_flow: s.h2o_flow,
      h2o_temp: s.h2o_temp,
      shield: s.shield,
      cs1: s.cs1,
      sample_count: 12 + Math.floor(countRnd() * 4), // ~12–15 raw readings per bucket
    });
  }

  return { asset, latest: sampleAt(spec, end, now), buckets };
}

// Synthetic alert_events for one demo asset, so the asset page's Alerts section
// has something to show in /demo. Evaluated against the SAME global thresholds
// the live evaluator uses (he_lvl<40, he_press>3, h2o_flow<0.6, h2o_temp>75,
// shield>80, cs1>0) plus offline, so demo and live read consistently.
// Maintenance units are exempt, mirroring evaluate_alerts().
export function demoAssetAlerts(assetId: string): AlertEvent[] {
  const spec = ROSTER.find((a) => a.id === assetId);
  if (!spec || spec.maintenance) return [];

  const now = Date.now();
  const events: AlertEvent[] = [];
  let id = 1;
  const push = (kind: string, message: string, triggeredMsAgo: number, resolvedMsAgo: number | null = null) =>
    events.push({
      id: id++,
      asset_id: spec.id,
      alert_rule_id: kind === "offline" ? null : `demo-${spec.id}-${id}`,
      kind,
      message,
      triggered_at: new Date(now - triggeredMsAgo).toISOString(),
      resolved_at: resolvedMsAgo === null ? null : new Date(now - resolvedMsAgo).toISOString(),
      notified_at: null,
    });

  // Offline (only when the unit is genuinely dark, matching the >60-min rule).
  // Connectivity (iR305/Tailscale) is informational status only — no alert event.
  if (spec.lastSeenMinAgo !== null && spec.lastSeenMinAgo > 60) {
    push("offline", `${spec.name} offline — no report`, spec.lastSeenMinAgo * 60_000);
  }

  // Open threshold events from the current reading.
  const end = effectiveEnd(spec, now);
  if (end !== null) {
    const s = sampleAt(spec, end, now);
    const check = (bad: boolean, msg: string) => {
      if (bad) push("threshold", `${spec.name} ${msg}`, 22 * 60_000);
    };
    check((s.he_lvl ?? 100) < 40, `he_lvl < 40 (now ${s.he_lvl})`);
    check((s.he_press ?? 0) > 3, `he_press > 3.0 (now ${s.he_press})`);
    check((s.cs1 ?? 0) > 0, `cs1 > 0 (now ${s.cs1})`);
    check((s.h2o_temp ?? 0) > 75, `h2o_temp > 75 (now ${s.h2o_temp})`);
    check((s.shield ?? 0) > 80, `shield > 80 (now ${s.shield})`);
  }

  // One resolved event a day back so the history isn't all-open.
  push("threshold", `${spec.name} h2o_temp > 75 (now 78.2)`, 26 * 3_600_000, 25 * 3_600_000);

  // Open first, then newest triggered first.
  return events.sort(
    (a, b) => (a.resolved_at ? 1 : 0) - (b.resolved_at ? 1 : 0) || b.triggered_at.localeCompare(a.triggered_at)
  );
}
