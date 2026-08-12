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
  last_seen_at: string | null;
  created_at: string;
  service_user: string;
  // When true, TV/Display mode suppresses value-based alarms for this unit
  // (known-warm / in-service assets), showing a calm "Maintenance" state
  // instead of flashing red. Connectivity status is unaffected.
  maintenance: boolean;
  // Last iR305 state from InHand Device Manager (via the dm-webhook edge fn).
  // false = router reported down (connectivity, magnet likely fine); null =
  // unknown / not on an iR305. Drives the "router_offline" health state.
  router_online?: boolean | null;
  router_status_at?: string | null;
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
  triggered_at: string;
  resolved_at: string | null;
  notified_at: string | null;
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
