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
  // What kind of equipment this unit watches, and therefore which card the UI
  // renders and which channels mean anything. 'MRI' is the MagMon magnet fleet
  // (helium, water, coldhead); 'PET/CT' is an environmental unit reporting zone
  // temperature/humidity and UPS power. Deliberately free text with no CHECK
  // constraint in the database, so 'NUC MED' and whatever follows need no
  // migration — but the UI only knows the two it renders, and anything else
  // falls back to the MRI card. Never null: the column defaults to 'MRI'.
  modality: string;
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
  // The ENV collector's own version stamp, on a unit that runs one. Separate
  // from collector_version because a unit can run both programs at once — NM1019
  // is the first — and they are released on different cadences. Sharing one
  // column made the two collectors overwrite each other every minute, which is
  // exactly the drift the version panel exists to show. See ENV_COLLECTOR_VERSION.
  env_collector_version?: string | null;
  env_collector_version_at?: string | null;
  // Per-COLLECTOR-FAMILY freshness. last_sample_at is one clock for the whole
  // asset, and on a unit running both collectors either one keeps it fresh — so
  // "online" stopped meaning "the magnet is being watched" the moment a Pi could
  // report a UPS and a bay sensor with no MagMon attached. These say which half
  // is live. last_magmon_sample_at null = never sent MagMon telemetry;
  // last_env_sample_at null = no environmental hardware has ever reported here,
  // which is how a magnet with no sensors fitted stays quiet. See
  // collectorStatuses() in lib/health.ts.
  last_magmon_sample_at?: string | null;
  last_env_sample_at?: string | null;
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
  // Environmental channels (modality 'PET/CT'), all null on an MRI sample and
  // vice versa — one telemetry_samples table serves both, and which columns are
  // populated is what distinguishes the two kinds of row. s1/s2/s3 are the three
  // XY-MD02 sensors: zone 1 Engineering, zone 2 Tech/Patient, zone 3 Equipment.
  s1_temp_f: number | null;
  s1_rh: number | null;
  s2_temp_f: number | null;
  s2_rh: number | null;
  s3_temp_f: number | null;
  s3_rh: number | null;
  // UPS, read over NUT. ups_on_battery is 1/0 rather than a boolean because it
  // has to be comparable by an alert_rules threshold like every other channel —
  // the fleet-wide "ups_on_battery = 1" rule is what pages on a power cut.
  ups_on_battery: number | null;
  ups_batt_pct: number | null;
  ups_input_v: number | null;
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
  // Env channels. Always present in the row — asset_telemetry_15min returns
  // every channel for every asset — and null on a unit that does not report
  // them, exactly like the MagMon columns above are null on one with no magnet.
  // ups_on_battery is the bucket MAXIMUM, not its average: a four-minute outage
  // inside a fifteen-minute bucket has to read as 1, not 0.27.
  s1_temp_f: number | null;
  s1_rh: number | null;
  s2_temp_f: number | null;
  s2_rh: number | null;
  s3_temp_f: number | null;
  s3_rh: number | null;
  ups_on_battery: number | null;
  ups_batt_pct: number | null;
  ups_input_v: number | null;
  sample_count: number;
};
