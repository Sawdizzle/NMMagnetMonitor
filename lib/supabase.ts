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
  magmon_version: string;
  site_name: string | null;
  site_address: string | null;
  offline_threshold_minutes: number | null;
  status: string | null;
  last_seen_at: string | null;
  created_at: string;
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
