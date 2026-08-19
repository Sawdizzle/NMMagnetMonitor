// Value-based fault detection for TV/Display mode.
//
// The dashboard's health model (lib/health.ts) answers only "did the unit phone
// home?" (online / stale / offline). A wall display in the service center also
// needs to catch a unit that IS connected but is in a bad physical state — the
// compressor off, the coldhead warming, helium running low. Those signals live
// partly in typed telemetry columns and partly in the raw `data` blob.
//
// Thresholds are collected at the top as plain constants so they're trivial to
// tune once the service-center team sees them against real machines. They are a
// starting point derived from live fleet readings, NOT gospel.
//
// Units flagged `maintenance` (known-warm / in-service, e.g. a decommissioned
// service-center unit) are exempt: computeAssetAlarm short-circuits to a calm
// "maintenance" level so the display never cries wolf over them.

import type { FleetAsset } from "./dataSource";
import { computeAssetHealth, isReachable, minutesSince, type HealthStatus } from "./health";

// ---- tunable thresholds --------------------------------------------------

export const FAULT_THRESHOLDS = {
  // Compressor: CS1 > 0 means the compressor is OFF / faulted (0 = running).
  compressorOffAbove: 0,
  // Coldhead temperature (K). Healthy ~4.1–4.3 K. Warming is the early warning;
  // clearly warm is critical.
  coldheadWarnK: 6,
  coldheadCriticalK: 20,
  // Helium level (%). Active fleet sits ~55–82 % (lowest healthy unit ~56).
  // Low thresholds tuned 2026-08-12 against live readings + the legacy MagMon
  // 50 % low limit: warn early enough to schedule a refill, critical when it's
  // genuinely urgent. A high alarm catches sensor faults / overfill — nobody
  // fills above ~82 %, so >90 only ever means something's wrong.
  heliumWarnBelow: 50,
  heliumCriticalBelow: 30,
  heliumHighAbove: 90,
  // Helium pressure. Healthy ~0.9–1.1. Negative reads as a sensor/system fault;
  // well above nominal reads as abnormal.
  hePressLow: 0,
  hePressHigh: 3,
  // Shield temperature (K). Healthy ~38–47 K.
  shieldWarnK: 60,
} as const;

// A per-asset override lives in alert_rules (asset_id = that asset). It folds
// onto these defaults: same table, same precedence the server evaluator uses
// (per-asset beats fleet-wide). Only the bounds the TV actually evaluates are
// mapped — helium/pressure/shield/compressor; a rule on an unmapped field
// (h2o_flow/h2o_temp, or a coldhead rule) is ignored here and left to the
// server-side evaluate_alerts() notifier.
type Thresholds = { -readonly [K in keyof typeof FAULT_THRESHOLDS]: number };

// Fold this asset's per-asset alert_rules onto FAULT_THRESHOLDS. Returns the
// shared default object untouched when the asset has no overrides (the common
// case), so we don't allocate per call for the whole fleet.
function effectiveThresholds(asset: FleetAsset): Thresholds {
  const rules = asset.alertRules;
  if (!rules || rules.length === 0) return FAULT_THRESHOLDS;
  const t: Thresholds = { ...FAULT_THRESHOLDS };
  for (const r of rules) {
    if (r.enabled === false) continue;
    const v = num(r.threshold);
    if (v === null) continue;
    const gt = r.comparator === ">" || r.comparator === ">=";
    const lt = r.comparator === "<" || r.comparator === "<=";
    switch (r.field) {
      case "he_press":
        if (gt) t.hePressHigh = v;
        else if (lt) t.hePressLow = v;
        break;
      case "he_lvl": // low-side override tunes the warn tier; critical stays default
        if (lt) t.heliumWarnBelow = v;
        break;
      case "shield":
        if (gt) t.shieldWarnK = v;
        break;
      case "cs1":
        if (gt) t.compressorOffAbove = v;
        break;
      // he_lvl critical, coldhead (JSON blob), h2o_* have no per-asset slot yet.
    }
  }
  return t;
}

// ---- types ---------------------------------------------------------------

export type FaultSeverity = "critical" | "warning";

export type Fault = {
  key: string;
  label: string; // short, glanceable — e.g. "Compressor OFF"
  detail: string; // the offending value — e.g. "310 K"
  severity: FaultSeverity;
};

// The single severity the TV uses to color, order, and (for critical) flash a
// card. Folds connectivity and value-faults together.
export type AlarmLevel = "critical" | "warning" | "ok" | "unknown" | "maintenance";

export type AssetAlarm = {
  level: AlarmLevel;
  connectivity: HealthStatus;
  faults: Fault[]; // value-based; empty for maintenance units
  maintenance: boolean;
};

export const ALARM_COLORS: Record<AlarmLevel, string> = {
  critical: "#f0575a",
  warning: "#fbbf24",
  ok: "#4ade80",
  unknown: "#6b7280",
  maintenance: "#5b93f7",
};

export const ALARM_LABELS: Record<AlarmLevel, string> = {
  critical: "Alarm",
  warning: "Warning",
  ok: "Nominal",
  unknown: "No data",
  maintenance: "Maintenance",
};

// ---- helpers -------------------------------------------------------------

// Telemetry numerics can arrive as numbers or, for high-precision numeric
// columns, as strings — coerce defensively so a stringy value still evaluates.
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Coldhead temperature isn't a typed column — it lives in the raw data blob.
// Devices emit either short or long labels, so check the known variants.
function coldheadK(asset: FleetAsset): number | null {
  const d = asset.latest?.data as Record<string, unknown> | null | undefined;
  if (!d) return null;
  return num(d.ColdheadRuO) ?? num(d.Coldhead) ?? num(d.ColdHead);
}

function fmt(n: number, digits = 0): string {
  return n.toFixed(digits).replace(/\.0+$/, "");
}

// Compact age for the "No fresh telemetry" detail so a long silence reads as
// "31 h" / "5 d" rather than a five-digit minute count. null = never reported.
function ageLabel(mins: number | null): string {
  if (mins === null) return "no readings";
  if (mins < 90) return `${mins} min`;
  const hrs = mins / 60;
  if (hrs < 48) return `${Math.round(hrs)} h`;
  return `${Math.round(hrs / 24)} d`;
}

// ---- fault detection -----------------------------------------------------

// Every value-based fault currently tripping for an asset, worst first. Empty
// when there's no latest reading (nothing to evaluate) — connectivity handles
// the "silent" case separately.
export function computeAssetFaults(asset: FleetAsset): Fault[] {
  const t = asset.latest;
  if (!t) return [];
  const faults: Fault[] = [];
  // Per-asset overrides folded onto the fleet defaults (e.g. NM1035's elevated
  // He-pressure ceiling), so an off-nominal-but-healthy unit doesn't false-alarm.
  const th = effectiveThresholds(asset);

  const cs1 = num(t.cs1);
  if (cs1 !== null && cs1 > th.compressorOffAbove) {
    faults.push({ key: "compressor", label: "Compressor OFF", detail: `CS1 ${fmt(cs1)}`, severity: "critical" });
  }

  const cold = coldheadK(asset);
  if (cold !== null) {
    if (cold > th.coldheadCriticalK) {
      faults.push({ key: "coldhead", label: "Coldhead hot", detail: `${fmt(cold)} K`, severity: "critical" });
    } else if (cold > th.coldheadWarnK) {
      // "warming" claimed a direction this check cannot see: it compares one
      // reading to a bound. NM1028 sat at a flat 8.94 K for eight days and was
      // labelled as warming the whole time. Direction is the trend detector's
      // job (kind='trend'), which reads the daily rollups and says so explicitly.
      faults.push({ key: "coldhead", label: "Coldhead high", detail: `${fmt(cold, 1)} K`, severity: "warning" });
    }
  }

  const he = num(t.he_lvl);
  if (he !== null) {
    if (he < th.heliumCriticalBelow) {
      faults.push({ key: "helium", label: "Helium critical", detail: `${fmt(he, 1)} %`, severity: "critical" });
    } else if (he < th.heliumWarnBelow) {
      faults.push({ key: "helium", label: "Helium low", detail: `${fmt(he, 1)} %`, severity: "warning" });
    } else if (he > th.heliumHighAbove) {
      // Above any normal fill level — reads as a sensor fault / overfill, not an
      // imminent magnet risk, so amber not red.
      faults.push({ key: "helium", label: "Helium high", detail: `${fmt(he, 1)} %`, severity: "warning" });
    }
  }

  const press = num(t.he_press);
  if (press !== null && (press < th.hePressLow || press > th.hePressHigh)) {
    faults.push({ key: "he_press", label: "He pressure abnormal", detail: `${fmt(press, 1)} psi`, severity: "warning" });
  }

  const shield = num(t.shield);
  if (shield !== null && shield > th.shieldWarnK) {
    faults.push({ key: "shield", label: "Shield warm", detail: `${fmt(shield)} K`, severity: "warning" });
  }

  faults.push(...serverFaults(asset, faults));

  // critical first, then warnings — so a card's headline fault is its worst.
  return faults.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

// Metrics this module evaluates itself, above. A server alert on one of these
// describes the same condition the local pill already shows, so it is dropped
// rather than double-pilled; the local version is richer (it has warn/critical
// tiers, the server has one level).
const CLIENT_EVALUATED_FIELDS = new Set(["cs1", "he_lvl", "he_press", "shield", "coldhead"]);

const KNOWN_FIELDS = ["he_lvl", "he_press", "h2o_flow", "h2o_temp", "shield", "cs1"] as const;

/**
 * Recover the metric a threshold event refers to from its message.
 *
 * The fleet card gets the field from the event's embedded rule, but the asset
 * page loads alert_events on their own and only per-asset rule overrides ride
 * along — a fleet-wide rule (which is most of them) would not resolve. The
 * message is generated by evaluate_alerts as "NM1027 h2o_flow < 0.6 (now ...)",
 * so the field is recoverable from it, and a miss just means no pill rather
 * than a wrong one.
 */
export function fieldFromMessage(message: string): string | null {
  for (const f of KNOWN_FIELDS) if (message.includes(` ${f} `)) return f;
  return null;
}

const FIELD_LABELS: Record<string, string> = {
  he_lvl: "Helium",
  he_press: "He pressure",
  h2o_flow: "Water flow",
  h2o_temp: "Water temp",
  shield: "Shield",
  cs1: "Compressor",
};

/**
 * Open server-side alerts rendered as card faults.
 *
 * evaluate_alerts covers ground lib/faults does not — h2o_flow and h2o_temp
 * thresholds, and sensor_fault for a channel that has gone blind. Those were
 * emailing and pushing while the fleet card stayed green, which is how NM1006
 * (both water sensors dead) and NM1027 (genuine low flow) looked healthy on
 * 2026-08-19 while alarming everywhere else.
 *
 * Connectivity kinds (offline / reporting_stalled / never_reported) are NOT
 * folded in: computeAssetAlarm already resolves those from last_sample_at and
 * returns before this runs.
 */
function serverFaults(asset: FleetAsset, existing: Fault[]): Fault[] {
  const events = asset.openAlerts;
  if (!events || events.length === 0) return [];
  const out: Fault[] = [];
  const seen = new Set(existing.map((f) => f.key));
  const named = (field: string | null, fallback: string) =>
    field ? (FIELD_LABELS[field] ?? field) : fallback;

  for (const e of events) {
    // Connectivity kinds never reach here — computeAssetAlarm resolves those
    // from last_sample_at and returns before faults are computed.
    let fault: Fault | null = null;

    switch (e.kind) {
      case "sensor_fault":
        fault = { key: `sensor:${e.field ?? e.id}`, label: `${named(e.field, "Sensor")} sensor blind`,
                  detail: "no reading", severity: e.severity };
        break;

      case "cooling_loss": {
        // The cross-signal diagnosis: shown as ONE pill naming the cause, with
        // the flow reading as its evidence, rather than as separate flow and
        // temperature pills the reader has to correlate themselves.
        const flow = num(e.detail?.h2o_flow);
        fault = { key: "cooling", label: "Cooling fault",
                  detail: flow !== null ? `${fmt(flow, 2)} gpm` : "see alert",
                  severity: e.severity };
        break;
      }

      case "trend": {
        // Predictive, so the pill leads with the deadline rather than the value:
        // "12 d to limit" is the actionable half.
        const days = num(e.detail?.days_to_cross);
        fault = { key: `trend:${e.field}`, label: `${named(e.field, "Metric")} trending`,
                  detail: days !== null ? `${fmt(days)} d to limit` : "projected",
                  severity: e.severity };
        break;
      }

      case "flatline": {
        const v = num(e.detail?.value);
        fault = { key: `flat:${e.field}`, label: `${named(e.field, "Metric")} flatlined`,
                  detail: v !== null ? `stuck at ${fmt(v, 2)}` : "not moving",
                  severity: e.severity };
        break;
      }

      case "bound":
      case "threshold": {
        if (!e.field || CLIENT_EVALUATED_FIELDS.has(e.field)) continue;
        const value = num((asset.latest as Record<string, unknown> | null)?.[e.field]);
        fault = { key: `alert:${e.field}`, label: `${named(e.field, "Metric")} alarm`,
                  detail: value !== null ? fmt(value, 2) : "no reading",
                  severity: e.severity };
        break;
      }

      default:
        continue;
    }

    if (!fault || seen.has(fault.key)) continue;
    seen.add(fault.key);
    out.push(fault);
  }
  return out;
}

function severityRank(s: FaultSeverity): number {
  return s === "critical" ? 2 : 1;
}

// The one call the TV uses per asset: connectivity + value-faults + maintenance,
// resolved to a single level.
export function computeAssetAlarm(asset: FleetAsset): AssetAlarm {
  // connectivity now reflects DATA freshness (last_sample_at), so "online" means
  // the stored reading is genuinely current — safe to evaluate value-faults.
  const connectivity = computeAssetHealth(asset);

  // Maintenance units are intentionally quiet — no value alarms, no offline
  // screaming. They still render, just calmly and last in the rotation.
  if (asset.maintenance) {
    return { level: "maintenance", connectivity, faults: [], maintenance: true };
  }

  // No FRESH telemetry (stale / offline / unknown): the stored values are old, so
  // we deliberately do NOT evaluate value-faults against them (that would present
  // an ancient reading as current). Surface the connectivity state itself. If the
  // Pi is still reachable (phoning home) but data has stopped, that's a "reporting
  // stalled" gateway/device fault rather than a true outage — mirrors the
  // reporting_stalled vs offline split in evaluate_alerts (schema.sql).
  if (connectivity !== "online") {
    if (connectivity === "unknown") {
      return { level: "unknown", connectivity, faults: [], maintenance: false };
    }
    const detail = ageLabel(minutesSince(asset.last_sample_at));
    const reachable = isReachable(asset);
    const label = reachable
      ? "Reporting stalled"
      : connectivity === "offline"
        ? "Offline"
        : "No recent data";
    const severity: FaultSeverity = connectivity === "offline" ? "critical" : "warning";
    return {
      level: severity,
      connectivity,
      faults: [{ key: "silent", label, detail, severity }],
      maintenance: false,
    };
  }

  const faults = computeAssetFaults(asset);
  const hasCritical = faults.some((f) => f.severity === "critical");
  const hasWarning = faults.some((f) => f.severity === "warning");

  let level: AlarmLevel;
  if (hasCritical) level = "critical";
  else if (hasWarning) level = "warning";
  else level = "ok";

  return { level, connectivity, faults, maintenance: false };
}

// Ordering for the carousel: alarms lead, healthy units next, quiet/maintenance
// units trail. Ties break by name so rotation order is stable between polls.
const LEVEL_PRIORITY: Record<AlarmLevel, number> = {
  critical: 4,
  warning: 3,
  ok: 2,
  unknown: 1,
  maintenance: 0,
};

export function alarmPriority(level: AlarmLevel): number {
  return LEVEL_PRIORITY[level];
}

export function sortByAlarmPriority(assets: FleetAsset[]): FleetAsset[] {
  return [...assets].sort((a, b) => {
    const pa = alarmPriority(computeAssetAlarm(a).level);
    const pb = alarmPriority(computeAssetAlarm(b).level);
    if (pa !== pb) return pb - pa;
    return a.name.localeCompare(b.name);
  });
}

// ---- alert list (shared by the TV ticker and the dashboard ticker) -------

export type AlertItem = {
  key: string;
  assetId: string;
  asset: string;
  label: string;
  detail: string;
  severity: FaultSeverity;
};

// Flatten every open issue across the fleet into one "ASSET — error" line per
// fault (plus a connectivity line for offline/stale). Only critical/warning
// units contribute; maintenance/ok/unknown are excluded. One source of truth so
// the TV and dashboard tickers never disagree.
export function buildAlertItems(assets: FleetAsset[]): AlertItem[] {
  const items: AlertItem[] = [];
  for (const a of assets) {
    const alarm = computeAssetAlarm(a);
    if (alarm.level !== "critical" && alarm.level !== "warning") continue;

    // alarm.faults already carries the connectivity state for non-online units
    // (the "silent" fault: Offline / Reporting stalled / No recent data) as well
    // as value-faults for online units — one unified source, no double-counting.
    for (const f of alarm.faults) {
      items.push({ key: `${a.id}-${f.key}`, assetId: a.id, asset: a.name, label: f.label, detail: f.detail, severity: f.severity });
    }
  }
  return items;
}
