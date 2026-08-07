import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type Site = {
  id: string;
  name: string;
  address: string | null;
  created_at: string;
};

// Public-safe shape (from the `public_assets` view) — never includes gateway_token
export type Asset = {
  id: string;
  site_id: string;
  name: string;
  magmon_version: string;
  offline_threshold_minutes: number | null;
  status: string | null;
  last_seen_at: string | null;
  created_at: string;
};

export type TelemetrySample = {
  id: number;
  asset_id: string;
  recorded_at: string;
  he_lvl: number | null;
  he_press: number | null;
  h2o_flow: number | null;
  h2o_temp: number | null;
  shield: number | null;
  cs1: number | null;
  data: Record<string, unknown> | null;
};
