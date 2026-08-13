import type { Asset } from "./supabase";

export type HealthStatus = "online" | "stale" | "offline" | "unknown";

const DEFAULT_STALE_THRESHOLD_MINUTES = 30;
// A quiet unit turns amber ("stale") once it passes its per-asset late
// threshold, and only escalates to red ("offline") after this many minutes.
// This gives an intermittent cellular link (e.g. CA1012 on the IR305 over
// Verizon, which drops a report now and then) room to recover before it reads
// as a genuine outage.
export const OFFLINE_AFTER_MINUTES = 60;

// Health answers only "is the asset reporting telemetry?" — this is what drives
// email/push alerts. Connectivity infrastructure (iR305 / Tailscale) is tracked
// separately (see connectivityStatuses) and shown as informational chips only;
// it never changes the health status and never alerts.
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

// How long a reachable unit may go without a *new* telemetry reading before it
// counts as silent. Kept at the offline horizon so silence and offline escalate
// on the same clock.
export const SILENT_AFTER_MINUTES = OFFLINE_AFTER_MINUTES;

// "Reachable but silent" — the blind spot last_seen_at alone can't see.
//
// The collector stamps last_seen_at on EVERY successful device read, even when
// the read produced no new rows (report_batch in lib/piScript.ts), so an
// operator stays reassured that the Pi is up. But that means a unit whose device
// log has stopped advancing — a parse fault, a hung readout, a clock reset —
// keeps a fresh last_seen_at and renders green while logging nothing. This
// catches it by comparing liveness against the newest actual sample's reading
// time (recorded_at). We only flag it while connectivity still reads "online":
// once last_seen_at itself goes stale/offline, the normal health status already
// tells the story. A null latestRecordedAt on an otherwise-live unit (reachable
// but never logged a reading) is silent by definition.
export function isTelemetrySilent(
  asset: Asset,
  latestRecordedAt: string | null,
): boolean {
  if (computeAssetHealth(asset) !== "online") return false;
  if (!latestRecordedAt) return true;
  const mins = (Date.now() - new Date(latestRecordedAt).getTime()) / 60000;
  return mins > SILENT_AFTER_MINUTES;
}

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
