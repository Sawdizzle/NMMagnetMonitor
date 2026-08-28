// Plain constants and shapes for alert triage.
//
// Kept out of lib/engineerActions.ts because that file is "use server": a
// server-actions module may only export async functions, so a const array of
// durations there is a build error, not a style preference.

/** A mute long enough to be useful, short enough to expire before it is forgotten. */
export const MUTE_DURATIONS: { label: string; hours: number | null; adminOnly?: boolean }[] = [
  { label: "24 hours", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "1 week", hours: 168 },
  { label: "2 weeks", hours: 336 },
  // The DB refuses this to anyone who is not an admin (mute_alert), so the
  // button is hidden rather than shown-and-rejected. Two weeks is the engineer
  // ceiling; past that, somebody senior should be making the call on the record.
  { label: "Until I clear it", hours: null, adminOnly: true },
];

/** One active mute, as the queue shows it. */
export type SuppressionRow = {
  id: string;
  asset_id: string | null;
  assetName: string;
  kind: string | null;
  channel: string | null;
  reason: string;
  severity_at_mute: "warning" | "critical";
  created_by: string;
  created_at: string;
  expires_at: string | null;
};

/** "3 days left" / "expired" / "no expiry" — the only thing anyone reads on a mute row. */
export function muteRemaining(expiresAt: string | null): string {
  if (!expiresAt) return "no expiry";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours}h left`;
  return `${Math.round(hours / 24)}d left`;
}
