import type { Asset } from "./supabase";

// "router_offline" is a connectivity state, not a magnet fault: InHand Device
// Manager has told us (via the dm-webhook edge function → assets.router_online)
// that the unit's iR305 cellular link is down, so telemetry can't reach us even
// though the magnet itself is probably fine. It supersedes a plain stale/offline
// so the UI can say "iR305 down — check the link" instead of flashing a red
// magnet alarm.
export type HealthStatus =
  | "online"
  | "stale"
  | "offline"
  | "router_offline"
  | "unknown";

const DEFAULT_STALE_THRESHOLD_MINUTES = 30;
// A quiet unit turns amber ("stale") once it passes its per-asset late
// threshold, and only escalates to red ("offline") after this many minutes.
// This gives an intermittent cellular link (e.g. CA1012 on the IR305 over
// Verizon, which drops a report now and then) room to recover before it reads
// as a genuine outage.
export const OFFLINE_AFTER_MINUTES = 60;

export function computeAssetHealth(asset: Asset): HealthStatus {
  if (!asset.last_seen_at) return "unknown";
  const staleAfter =
    asset.offline_threshold_minutes ?? DEFAULT_STALE_THRESHOLD_MINUTES;
  const lastSeen = new Date(asset.last_seen_at).getTime();
  const minutesSince = (Date.now() - lastSeen) / 60000;
  if (minutesSince <= staleAfter) return "online";
  // Once the unit is genuinely late, prefer the connectivity explanation when
  // DM has affirmatively reported its router down (router_online === false).
  // null/undefined (not on an iR305, or unknown) falls through to stale/offline.
  const base: HealthStatus =
    minutesSince > OFFLINE_AFTER_MINUTES ? "offline" : "stale";
  if (asset.router_online === false) return "router_offline";
  return base;
}

export function minutesSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.round((Date.now() - new Date(dateStr).getTime()) / 60000);
}

export const STATUS_COLORS: Record<HealthStatus, string> = {
  online: "#4ade80",
  stale: "#fbbf24", // --status-warning
  offline: "#f0575a",
  router_offline: "#38bdf8", // sky — connectivity/infra, not a magnet alarm
  unknown: "#6b7280",
};

// Human-facing chip/label text for each status (the raw enum leaks otherwise).
export const STATUS_LABELS: Record<HealthStatus, string> = {
  online: "online",
  stale: "stale",
  offline: "offline",
  router_offline: "iR305 down",
  unknown: "unknown",
};
