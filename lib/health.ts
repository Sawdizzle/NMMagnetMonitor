import type { Asset } from "./supabase";

export type HealthStatus = "online" | "offline" | "unknown";

const DEFAULT_OFFLINE_THRESHOLD_MINUTES = 15;

export function computeAssetHealth(asset: Asset): HealthStatus {
  if (!asset.last_seen_at) return "unknown";
  const thresholdMinutes =
    asset.offline_threshold_minutes ?? DEFAULT_OFFLINE_THRESHOLD_MINUTES;
  const lastSeen = new Date(asset.last_seen_at).getTime();
  const minutesSince = (Date.now() - lastSeen) / 60000;
  return minutesSince > thresholdMinutes ? "offline" : "online";
}

export function minutesSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.round((Date.now() - new Date(dateStr).getTime()) / 60000);
}

export const STATUS_COLORS: Record<HealthStatus, string> = {
  online: "#4ade80",
  offline: "#f0575a",
  unknown: "#6b7280",
};
