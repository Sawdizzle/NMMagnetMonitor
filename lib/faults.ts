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
import { computeAssetHealth, type HealthStatus } from "./health";

// ---- tunable thresholds --------------------------------------------------

export const FAULT_THRESHOLDS = {
  // Compressor: CS1 > 0 means the compressor is OFF / faulted (0 = running).
  compressorOffAbove: 0,
  // Coldhead temperature (K). Healthy ~4.1–4.3 K. Warming is the early warning;
  // clearly warm is critical.
  coldheadWarnK: 6,
  coldheadCriticalK: 20,
  // Helium level (%). Healthy ~55–82 %.
  heliumWarnBelow: 40,
  heliumCriticalBelow: 15,
  // Helium pressure. Healthy ~0.9–1.1. Negative reads as a sensor/system fault;
  // well above nominal reads as abnormal.
  hePressLow: 0,
  hePressHigh: 3,
  // Shield temperature (K). Healthy ~38–47 K.
  shieldWarnK: 60,
} as const;

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

  const cs1 = num(t.cs1);
  if (cs1 !== null && cs1 > FAULT_THRESHOLDS.compressorOffAbove) {
    faults.push({ key: "compressor", label: "Compressor OFF", detail: `CS1 ${fmt(cs1)}`, severity: "critical" });
  }

  const cold = coldheadK(asset);
  if (cold !== null) {
    if (cold > FAULT_THRESHOLDS.coldheadCriticalK) {
      faults.push({ key: "coldhead", label: "Coldhead warm", detail: `${fmt(cold)} K`, severity: "critical" });
    } else if (cold > FAULT_THRESHOLDS.coldheadWarnK) {
      faults.push({ key: "coldhead", label: "Coldhead warming", detail: `${fmt(cold, 1)} K`, severity: "warning" });
    }
  }

  const he = num(t.he_lvl);
  if (he !== null) {
    if (he < FAULT_THRESHOLDS.heliumCriticalBelow) {
      faults.push({ key: "helium", label: "Helium critical", detail: `${fmt(he, 1)} %`, severity: "critical" });
    } else if (he < FAULT_THRESHOLDS.heliumWarnBelow) {
      faults.push({ key: "helium", label: "Helium low", detail: `${fmt(he, 1)} %`, severity: "warning" });
    }
  }

  const press = num(t.he_press);
  if (press !== null && (press < FAULT_THRESHOLDS.hePressLow || press > FAULT_THRESHOLDS.hePressHigh)) {
    faults.push({ key: "he_press", label: "He pressure abnormal", detail: `${fmt(press, 1)} psi`, severity: "warning" });
  }

  const shield = num(t.shield);
  if (shield !== null && shield > FAULT_THRESHOLDS.shieldWarnK) {
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
