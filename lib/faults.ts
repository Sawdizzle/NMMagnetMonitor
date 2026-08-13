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
import { computeAssetHealth, minutesSince, type HealthStatus } from "./health";

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
      faults.push({ key: "coldhead", label: "Coldhead warm", detail: `${fmt(cold)} K`, severity: "critical" });
    } else if (cold > th.coldheadWarnK) {
      faults.push({ key: "coldhead", label: "Coldhead warming", detail: `${fmt(cold, 1)} K`, severity: "warning" });
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

  // critical first, then warnings — so a card's headline fault is its worst.
  return faults.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function severityRank(s: FaultSeverity): number {
  return s === "critical" ? 2 : 1;
}

// The one call the TV uses per asset: connectivity + value-faults + maintenance,
// resolved to a single level.
export function computeAssetAlarm(asset: FleetAsset): AssetAlarm {
  const connectivity = computeAssetHealth(asset);

  // Maintenance units are intentionally quiet — no value alarms, no offline
  // screaming. They still render, just calmly and last in the rotation.
  if (asset.maintenance) {
    return { level: "maintenance", connectivity, faults: [], maintenance: true };
  }

  const faults = computeAssetFaults(asset);
  const hasCritical = faults.some((f) => f.severity === "critical") || connectivity === "offline";
  const hasWarning = faults.some((f) => f.severity === "warning") || connectivity === "stale";

  let level: AlarmLevel;
  if (hasCritical) level = "critical";
  else if (hasWarning) level = "warning";
  else if (connectivity === "unknown") level = "unknown";
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

    if (alarm.connectivity === "offline") {
      const m = minutesSince(a.last_seen_at);
      items.push({ key: `${a.id}-offline`, assetId: a.id, asset: a.name, label: "Offline", detail: m === null ? "" : `${m} min`, severity: "critical" });
    } else if (alarm.connectivity === "stale") {
      const m = minutesSince(a.last_seen_at);
      items.push({ key: `${a.id}-stale`, assetId: a.id, asset: a.name, label: "No recent data", detail: m === null ? "" : `${m} min`, severity: "warning" });
    }
    for (const f of alarm.faults) {
      items.push({ key: `${a.id}-${f.key}`, assetId: a.id, asset: a.name, label: f.label, detail: f.detail, severity: f.severity });
    }
  }
  return items;
}
