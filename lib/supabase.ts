import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Public-safe shape (from the `public_assets` view) — never includes gateway_token.
// Location metadata (site_name/site_address) lives directly on the asset now;
// both are optional free text, so either can be null.
export type Asset = {
  id: string;
  name: string;
  site_name: string | null;
  site_address: string | null;
  offline_threshold_minutes: number | null;
  status: string | null;
  // last_seen_at = reachability: the collector Pi phoned home (stamped on every
  // device contact, even an empty/duplicate report). last_sample_at = data
  // freshness: a genuinely NEW telemetry row actually stored. Health keys off
  // last_sample_at so a reachable-but-silent or wrong-clock unit reads honestly;
  // last_seen_at only distinguishes "reporting stalled" from "offline". null
  // last_sample_at = the unit has never stored a reading. See lib/health.ts.
  last_seen_at: string | null;
  last_sample_at: string | null;
  created_at: string;
  service_user: string;
  // When true, TV/Display mode suppresses value-based alarms for this unit
  // (known-warm / in-service assets), showing a calm "Maintenance" state
  // instead of flashing red. Connectivity status is unaffected.
  maintenance: boolean;
  // Connectivity signals shown as informational chips beside the status chip
  // (never alert). router_online: iR305 state from InHand DM (dm-webhook).
  // tailscale_online: collector Pi's Tailscale node state (tailscale-poll).
  // false = down, true = up, null = unknown / not applicable. See
  // connectivityStatuses() in lib/health.ts.
  router_online?: boolean | null;
  router_status_at?: string | null;
  tailscale_online?: boolean | null;
  tailscale_status_at?: string | null;
  // COLLECTOR_VERSION reported by the script running on this unit's host, and
  // when it last said so. null = has not reported since versioning shipped,
  // which itself means the script predates it. See lib/piScript.
  collector_version?: string | null;
  collector_version_at?: string | null;
};

export type TelemetrySample = {
  id: number;
  asset_id: string;
  recorded_at: string;
  created_at: string;
  he_lvl: number | null;
  he_press: number | null;
  h2o_flow: number | null;
  h2o_temp: number | null;
  shield: number | null;
  cs1: number | null;
  data: Record<string, unknown> | null;
};

// A fired alert, from the alert_events table (public-readable). Opened and
// resolved by evaluate_alerts() on its cron; notified_at is stamped once a
// notifier delivers it (Phase 3). kind is 'offline' | 'threshold'.
export type AlertEvent = {
  id: number;
  asset_id: string;
  alert_rule_id: string | null;
  kind: string;
  message: string;
  // Which metric a kind='sensor_fault' / 'trend' / 'flatline' / 'bound' event
  // refers to; null for every other kind. One unit can have several blind
  // channels (NM1006 has two).
  channel: string | null;
  severity: "warning" | "critical";
  // Evidence behind a diagnostic finding; null for threshold/connectivity kinds.
  detail: Record<string, unknown> | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  disposition: "accepted" | "ignored" | "false_alarm" | null;
  triggered_at: string;
  resolved_at: string | null;
  notified_at: string | null;
};

// A threshold rule from alert_rules. asset_id null = fleet-wide default;
// asset_id set = per-asset override. The TV/dashboard fault model reads the
// per-asset rows as overrides on the built-in FAULT_THRESHOLDS (lib/faults.ts),
// exactly as the server-side evaluate_alerts() cron does for email/push — so a
// unit that legitimately runs off-nominal (e.g. NM1035's elevated He pressure)
// stops false-alarming without loosening the fleet default. Public-readable
// (RLS policy "public read alert_rules").
export type AlertRule = {
  id: string;
  asset_id: string | null;
  field: string; // 'he_lvl' | 'he_press' | 'h2o_flow' | 'h2o_temp' | 'shield' | 'cs1'
  comparator: string; // '<' | '<=' | '>' | '>=' | '=' | '!='
  threshold: number;
  enabled: boolean;
};

// A 15-minute averaged bucket, from the asset_telemetry_15min RPC. Same
// field names as TelemetrySample for the metrics + created_at so it can
// drop into the same chart/table components; adds sample_count so the UI
// can show how many raw readings went into each averaged point.
export type TelemetryBucket = {
  created_at: string;
  he_lvl: number | null;
  he_press: number | null;
  h2o_flow: number | null;
  h2o_temp: number | null;
  shield: number | null;
  cs1: number | null;
  sample_count: number;
};
