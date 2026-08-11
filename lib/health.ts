import type { Asset } from "./supabase";

export type HealthStatus = "online" | "stale" | "offline" | "unknown";

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
  if (minutesSince > OFFLINE_AFTER_MINUTES) return "offline";
  return "stale";
}

export function minutesSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.round((Date.now() - new Date(dateStr).getTime()) / 60000);
}

export const STATUS_COLORS: Record<HealthStatus, string> = {
  online: "#4ade80",
  stale: "#fbbf24", // --status-warning
  offline: "#f0575a",
  unknown: "#6b7280",
};
