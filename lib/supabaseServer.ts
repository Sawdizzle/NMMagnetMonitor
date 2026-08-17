import "server-only";

import { createClient } from "@supabase/supabase-js";

// Service-role Supabase client. It bypasses RLS entirely, which is the whole
// point: from Phase 2 on, tenant scoping is enforced by this server filtering
// every query by the session's active org, not by row policies.
//
// The "server-only" import above is load-bearing. Importing this module from a
// client component is a build error rather than a service key shipped in the
// JS bundle. Never re-export the client or the key from a "use client" file.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
if (!serviceKey) {
  throw new Error(
    "SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.local and to the " +
      "Vercel project's environment variables (Settings -> Environment " +
      "Variables). Supabase dashboard -> Project Settings -> API -> service_role."
  );
}

export const supabaseAdmin = createClient(url, serviceKey, {
  // No user auth flows run through this client, so there is nothing to persist
  // or refresh; leaving these on would have it look for browser storage.
  auth: { persistSession: false, autoRefreshToken: false },
});
