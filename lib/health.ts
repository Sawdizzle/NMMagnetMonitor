import type { Asset } from "./supabase";

export type HealthStatus = "online" | "stale" | "offline" | "unknown";

const DEFAULT_STALE_THRESHOLD_MINUTES = 30;
// A quiet unit turns amber ("stale") once it passes its per-asset late
// threshold, and only escalates to red ("offline") after this many minutes.
// This gives an intermittent cellular link (e.g. CA1012 on the IR305 over
// Verizon, which drops a report now and then) room to recover before it reads
// as a genuine outage.
export const OFFLINE_AFTER_MINUTES = 60;

// Health answers only "is the asset reporting FRESH telemetry?" — this is what
// drives email/push alerts. It keys off last_sample_at (a genuinely new reading
// actually stored), NOT last_seen_at (mere reachability — the Pi phones home on
// every cycle, even an empty or duplicate report, so it stays fresh while a hung
// or wrong-clock device logs nothing new). Using last_sample_at is what makes a
// reachable-but-silent unit read honestly instead of a permanent green. A null
// last_sample_at means the unit has never stored a reading -> "unknown".
// Connectivity infrastructure (iR305 / Tailscale) is tracked separately (see
// connectivityStatuses) and shown as informational chips only; it never changes
// the health status and never alerts.
export function computeAssetHealth(asset: Asset): HealthStatus {
  if (!asset.last_sample_at) return "unknown";
  const staleAfter =
    asset.offline_threshold_minutes ?? DEFAULT_STALE_THRESHOLD_MINUTES;
  const lastSample = new Date(asset.last_sample_at).getTime();
  const minutesSince = (Date.now() - lastSample) / 60000;
  if (minutesSince <= staleAfter) return "online";
  if (minutesSince > OFFLINE_AFTER_MINUTES) return "offline";
  return "stale";
}

// Reachability: the collector Pi is still phoning home (fresh last_seen_at) even
// if its data has gone stale. Distinguishes "reporting stalled" (Pi up, telemetry
// dead — a gateway/device/clock fault) from a true "offline". Mirrors the
// reachability test in evaluate_alerts (schema.sql); the server also folds in a
// fresh Tailscale poll, which the client doesn't have here.
export function isReachable(asset: Asset): boolean {
  if (!asset.last_seen_at) return false;
  const staleAfter =
    asset.offline_threshold_minutes ?? DEFAULT_STALE_THRESHOLD_MINUTES;
  return (Date.now() - new Date(asset.last_seen_at).getTime()) / 60000 <= staleAfter;
}

export function minutesSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.round((Date.now() - new Date(dateStr).getTime()) / 60000);
}

// NOTE: the old isTelemetrySilent() heuristic (compare last_seen_at against the
// newest sample's recorded_at) is gone. It was fooled by a wrong device clock —
// NM1008 reports fresh data every minute but stamps it 2022, so recorded_at read
// as "silent" when it wasn't. computeAssetHealth now keys off last_sample_at
// (ingest-side), which is immune to the device clock, so "reachable but silent"
// is just health !== "online" while isReachable() stays true.

// Alert kinds that mean "we are not getting telemetry" and therefore read red
// wherever an alert is rendered: 'offline' (unit or site network down),
// 'reporting_stalled' (Pi reachable, data dead) and 'never_reported' (added but
// never reported once). Every other kind — 'threshold', 'sensor_fault' — leaves
// the unit reporting normally and reads amber. Shared so the asset page, the
// admin log and the debrief cannot drift apart when a kind is added.
export const NO_TELEMETRY_KINDS: ReadonlySet<string> = new Set([
  "offline",
  "reporting_stalled",
  "never_reported",
]);

export const STATUS_COLORS: Record<HealthStatus, string> = {
  online: "#4ade80",
  stale: "#fbbf24", // --status-warning
  offline: "#f0575a",
  unknown: "#6b7280",
};

// Human-facing chip text for each status (the raw enum leaks otherwise).
export const STATUS_LABELS: Record<HealthStatus, string> = {
  online: "online",
  stale: "stale",
  offline: "offline",
  unknown: "unknown",
};

// ---- connectivity chips (informational, never alerts) --------------------
// The iR305 cellular link (via InHand DM → assets.router_online) and the
// collector Pi's Tailscale node (via tailscale-poll → assets.tailscale_online)
// are shown beside the status chip so an operator can see WHY a unit is quiet —
// without any email/push and without changing the alerting health status. Only
// signals we actually have (column non-null) produce a chip.
export type ConnectivityChip = { key: string; label: string; up: boolean };

const ONLINE = "#4ade80";
const DOWN = "#f0575a";

export function connectivityStatuses(asset: Asset): ConnectivityChip[] {
  const chips: ConnectivityChip[] = [];
  if (asset.router_online != null) {
    chips.push({ key: "ir305", label: asset.router_online ? "iR305" : "iR305 down", up: asset.router_online });
  }
  if (asset.tailscale_online != null) {
    chips.push({ key: "ts", label: asset.tailscale_online ? "Tailscale" : "Tailscale down", up: asset.tailscale_online });
  }
  return chips;
}

export const CONNECTIVITY_COLORS = { up: ONLINE, down: DOWN };
