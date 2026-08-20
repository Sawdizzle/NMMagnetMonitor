-- =====================================================================
-- NM Magnet Monitor — database schema snapshot
-- =====================================================================
-- Project:  NMMagnetMonitor (Supabase ref: wxygirzfxutvtfkxxcvw, Postgres 17)
-- Captured: 2026-08-10 by introspecting the live database.
--
-- WHY THIS FILE EXISTS
-- The entire backend (tables, views, row-security policies, and the 20
-- RPC functions the app depends on) previously lived ONLY inside the live
-- Supabase project. This file is the first version-controlled copy of it,
-- so the backend can be rebuilt, reviewed, and eventually stood up for a
-- second environment.
--
-- FIDELITY NOTE
-- This is a hand-verified introspection snapshot, faithful to what the
-- database contained on the capture date. It is meant to be readable and
-- reconstructable. When the Supabase CLI is available, `supabase db dump`
-- remains the canonical, byte-exact export — treat this as the working
-- source of truth until then.
--
-- SECURITY NOTE — F-1 and F-4 are both CLOSED as of 2026-08-17.
-- What they were, and what actually fixed them:
--   * F-1 (public read). The "public read" policies granted SELECT to
--     everyone, and — worse than the review recorded — public_assets and
--     latest_telemetry were created WITHOUT security_invoker, so they ran
--     with the view owner's rights and bypassed the underlying RLS entirely.
--     Measured before the fix: anon saw 0 rows in assets but all 17 through
--     public_assets. public_assets is also auto-updatable, and anon held
--     Supabase's default INSERT/UPDATE/DELETE grants on it, so the anon key
--     shipped in the JS bundle was a WRITE path into the fleet, not just a
--     read leak.
--     Fixed by: revoke_anon_write_grants, then phase2_close_public_reads
--     (security_invoker on both views, policies dropped, SELECT revoked)
--     once reads had moved server-side into lib/fleetQueries.ts.
--   * F-4 (PIN brute force) — CLOSED 2026-08-17 by
--     phase3c_drop_pin_authenticated_admin_rpcs, which DROPPED all 22 admin_*
--     functions that took (p_actor_username, p_actor_pin). Nothing
--     admin-related is executable by anon any more; the panel calls
--     p_token overloads through server actions using the service role. It took
--     three attempts, and the two failed ones are recorded below because each
--     failure mode is easy to repeat.
--     History of the two earlier, WRONG "F-4 is closed" claims:
--       (a) Moving login to create_session was NOT sufficient:
--           verify_user_login stayed anon-callable, so an attacker could
--           bypass the app and hammer the RPC with the publishable key. That
--           path is now revoked (phase2_revoke_public_execute_on_legacy_auth_rpcs).
--       (b) That was never F-4's main surface. F-4 is is_admin(username, pin)
--           applying NO lockout while reachable by anon through all 23
--           admin_* RPCs. is_admin is now revoked from PUBLIC
--           (revoke_public_execute_on_is_admin) — it was the cleanest oracle,
--           returning a bare boolean with no lockout or audit trail. Safe to
--           revoke: nothing client-side calls it and all 23 SQL callers are
--           SECURITY DEFINER, so their nested calls run as the owner.
--     (c) FINALLY CLOSED by dropping the functions outright rather than
--         revoking them: as long as a PIN-checking function existed and was
--         reachable, its "not authorized" exception distinguished a right PIN
--         from a wrong one, with no lockout on that path. Verified after:
--         0 functions with a p_actor_pin parameter remain, 22 p_token
--         versions are present, and no admin_* function (nor is_admin) is
--         executable by anon.
--     is_admin() is deliberately NOT dropped — notify-alerts still uses it for
--     its admin-gated test mode, authenticating with the SERVICE ROLE key, so
--     anon cannot reach it.
--     Postgres gotcha behind the first failed attempt at all of this:
--     functions grant EXECUTE to the PUBLIC pseudo-role by default (ACL shows
--     as a bare "=X/postgres"), which anon inherits, so revoking from anon
--     alone is a NO-OP. Always revoke from `public` too.
--
-- Still granted to anon ON PURPOSE: report_telemetry and
-- report_telemetry_batch. The 17 collector Pis call them with the publishable
-- key plus a per-asset gateway_token; revoking either stops fleet ingest.
--
-- This file tracks the live database. Everything below has been applied.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Extensions (managed by Supabase; listed for completeness)
-- ---------------------------------------------------------------------
-- pgcrypto      -> crypt()/gen_salt() for PIN hashing, gen_random_bytes()
-- uuid-ossp     -> uuid helpers
-- pg_cron       -> already installed (used by the planned alerting job)
-- pg_stat_statements, supabase_vault -> Supabase-managed
create extension if not exists pgcrypto      with schema extensions;
create extension if not exists "uuid-ossp"   with schema extensions;
-- pg_cron is provisioned by Supabase and lives in the pg_catalog schema.


-- =====================================================================
-- TABLES
-- =====================================================================

-- --- users (custom PIN auth; PINs are bcrypt-hashed) ------------------
create table if not exists public.users (
  id               uuid        primary key default gen_random_uuid(),
  username         text        not null,
  pin_hash         text        not null,
  role             text        not null default 'viewer'
                     check (role = any (array['admin','viewer'])),
  -- Grants access to TV/Display mode (/tv). Admin-toggled; admins always have
  -- access regardless. Returned by verify_user_login into the client session.
  tv_access        boolean     not null default false,
  -- Cross-org operator access: a superadmin sees and switches between every
  -- org, where org_members.role only grants rights within one org. Applied
  -- 2026-08-17 (migration multi_tenant_phase0_orgs_and_backfill).
  is_superadmin    boolean     not null default false,
  failed_attempts  integer     not null default 0,
  locked_until     timestamptz,
  created_at       timestamptz not null default now(),
  constraint users_username_key unique (username)
);

-- --- orgs (tenants) ---------------------------------------------------
-- One row per company. product_name/eyebrow/tagline were lib/brand.ts's
-- realBrand/demoBrand constants, moved into data so a new company can be
-- turned up without a deploy. invite_code is per-org self-registration and
-- supersedes the single global app_settings.invite_code.
-- See docs/multi-tenant-plan.md.
create table if not exists public.orgs (
  id           uuid        primary key default gen_random_uuid(),
  slug         text        not null unique,
  name         text        not null,
  product_name text        not null default 'Magnet Monitor',
  eyebrow      text        not null,
  tagline      text        not null,
  invite_code  text,
  -- Suspension (migration org_enabled_and_delete, 2026-08-18). False = access
  -- stops, collection continues: no login into it, no org switch into it, dead
  -- wall-display links, no alert email or push -- but telemetry keeps arriving,
  -- so re-enabling restores the company intact with no gap in history. That
  -- combination is the whole point; a suspension that also stopped ingest would
  -- lose exactly the history a returning customer came back for.
  --
  -- SUPERADMINS BYPASS THIS. Someone has to be able to reach a disabled company
  -- to re-enable it, so every gate reads "(o.enabled or is_superadmin)". The
  -- exception is resolve_display_token, which has none: a screen is not a
  -- person, and a suspended company's corridor TV must go dark.
  enabled      boolean     not null default true,
  -- The company's own logo, as a URL into the PUBLIC 'org-logos' storage
  -- bucket (migration org_logos_storage_bucket). The fourth brand field
  -- alongside product_name/eyebrow/tagline: when set it REPLACES the built-in
  -- BrandMark on that tenant's nav, dashboard heading and wall display
  -- (components/OrgMark.tsx); null falls back to the MRI mark, so a company
  -- that never uploads one is untouched.
  --
  -- A URL, not bytes: the image stays out of Postgres and therefore out of
  -- every resolve_session round-trip. Uploads go through the admin-only server
  -- action adminUploadOrgLogo (service-role key, superadmin-gated) — the
  -- bucket has NO write policy, so nothing else can put objects there.
  -- Applied 2026-08-17 (migration org_logo_url_column_and_rpcs).
  logo_url     text,
  -- Demonstration tenant, not a production one. Its assets are invented and
  -- its telemetry is synthesized every minute by generate_demo_telemetry()
  -- (pg_cron 'generate-demo-telemetry'), so nothing under it may be treated as
  -- a real magnet. What this flag switches off, all keyed off is_demo:
  --   * notify-alerts / send-push  never email or push a demo org's alerts,
  --     regardless of recipients or subscriptions being configured.
  --   * tailscale-poll / dm-webhook  never match a demo asset to real hardware
  --     (both match on name substrings, so a collision is possible).
  --   * the app  renders a persistent demo banner (components/DemoTenantBanner)
  --     whenever the active org — or a wall display's token — points here.
  -- evaluate_alerts DOES still run on demo assets: the demo is meant to look
  -- alive, and blocking delivery is what keeps that contained.
  is_demo      boolean     not null default false,
  -- --- alert sender identity (migration alert_sender_identity_per_org,
  -- 2026-08-18) ------------------------------------------------------------
  -- The decision behind the split: ONE Resend-verified domain that Numed owns
  -- carries every company's alert mail, with the per-company identity layered
  -- on top of it. Sending as alerts@customer.org instead would require SPF and
  -- DKIM records in the CUSTOMER's DNS -- hospitals enforce DMARC, so without
  -- them the alert is junked or rejected, and every onboarding would block on
  -- someone else's IT ticket. What a recipient actually reads in an inbox list
  -- is the display name; where a reply lands is Reply-To. Both are per-company
  -- and neither touches customer DNS.
  --
  -- alert_from is the bare address, and it is SUPERADMIN-ONLY: it must be a
  -- Resend-verified sender, and pointing it at an unverified domain fails every
  -- send silently, once a minute, forever. It stays as a bring-your-own-domain
  -- escape hatch for a customer who will do the DNS work. Null falls back to
  -- app_settings 'alert_from', then the ALERT_FROM secret, then Resend's test
  -- sender (which only ever delivers to Numed's own Resend account).
  alert_from           text,
  -- Display name on the From header. Null => name || ' ' || product_name, e.g.
  -- "Mercy Health Magnet Monitor". Stored raw; notify-alerts is what RFC-quotes
  -- it at send time, which matters more than it looks: "Numed, Inc Magnet
  -- Monitor" contains a COMMA, the address separator, so unquoted it parses as
  -- two broken addresses.
  alert_from_name      text,
  -- Reply-To. Null => no header at all, and replies go to an unmonitored
  -- mailbox. This is the field that lets one sending domain still route each
  -- company's answers back to its own people.
  alert_reply_to       text,
  -- Leading text on the email subject and the push title, so both channels
  -- rename together. Null => product_name.
  alert_subject_prefix text,
  created_at   timestamptz not null default now()
);

-- --- org_members (user <-> org, many-to-many) -------------------------
-- role and tv_access are properties of the MEMBERSHIP, not the user: one
-- person can be admin of one company and viewer of another (e.g. a
-- contractor covering two client sites). users.role / users.tv_access are
-- still present and still read by verify_user_login; they are dropped in
-- Phase 2 once nothing reads them.
create table if not exists public.org_members (
  user_id    uuid        not null references public.users(id) on delete cascade,
  org_id     uuid        not null references public.orgs(id)  on delete cascade,
  role       text        not null default 'viewer'
               check (role = any (array['admin','viewer'])),
  tv_access  boolean     not null default false,
  -- Access to the live runbook at /docs, which renders lib/docsInfraReal.ts:
  -- admin emails, the tailnet account, LAN and Tailscale IPs, the server
  -- hostname, the Pi SSH user. /docs was gated on "signed in" alone, so every
  -- user of every tenant could read Numed's infrastructure — including the
  -- demo org's viewer. Now a grant, mirroring tv_access, and `default false`
  -- means nobody holds it until it is given.
  --
  -- Admins pass WITHOUT the flag (resolve_session ORs it with is_superadmin,
  -- and the app checks `role === 'admin' || docsAccess`), so it only ever has
  -- to be ticked for viewers.
  --
  -- NOTE: this flag alone was never enough. app/docs/page.tsx had to become a
  -- SERVER component too — as a client component it compiled those values into
  -- a PUBLIC static chunk, readable with no session at all. The flag decides
  -- who may read; the server component decides what is ever sent.
  -- Applied 2026-08-17 (migration org_members_docs_access_grant).
  docs_access boolean    not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, org_id)
);

-- --- user_sessions (server-side session, Phase 1) --------------------
-- token_hash is the sha256 of the httpOnly cookie value; the raw token is
-- never stored. active_org is where the org switcher currently points.
create table if not exists public.user_sessions (
  token_hash text        primary key,
  user_id    uuid        not null references public.users(id) on delete cascade,
  active_org uuid        references public.orgs(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Resolves the 'numed' org. Exists so the org_id columns added below can
-- carry a DEFAULT: admin_create_asset, admin_upsert_alert_rule and
-- _record_audit all insert without an org_id, so without this default they
-- would break the moment org_id went NOT NULL. Phase 3 passes org_id
-- explicitly and drops the defaults.
create or replace function public.default_org_id()
  returns uuid
  language sql
  stable
  security definer
  set search_path to 'public'
as $$ select id from public.orgs where slug = 'numed' $$;

-- --- app_settings (key/value; holds e.g. the invite_code) ------------
create table if not exists public.app_settings (
  key    text primary key,
  value  text not null
);

-- --- assets (one GE MagMon unit) -------------------------------------
-- Location metadata (site_name/site_address) lives here as optional free
-- text. The former normalized `sites` table was folded in: in practice the
-- relationship was strictly 1:1, so a separate table was pure overhead.
create table if not exists public.assets (
  id                         uuid        primary key default gen_random_uuid(),
  name                       text        not null,
  site_name                  text,
  site_address               text,
  gateway_token              text        not null default encode(extensions.gen_random_bytes(24), 'hex'),
  offline_threshold_minutes  integer     not null default 30,
  status                     text        not null default 'unknown',
  -- last_seen_at = reachability: the collector phoned home. Stamped on EVERY
  -- device contact (report_telemetry*), even an empty or all-duplicate report.
  last_seen_at               timestamptz,
  -- last_sample_at = data freshness: a genuinely NEW telemetry row actually
  -- stored (report_telemetry* bump this only on a real insert). Immune to a
  -- wrong device clock and to duplicate/empty reports, so it — not last_seen_at —
  -- is what health + evaluate_alerts key off. A hung or reachable-but-silent unit
  -- lets this age into stale/offline instead of reading a permanent green.
  -- Applied to live DB 2026-08-13 (migration add_last_sample_at).
  last_sample_at             timestamptz,
  created_at                 timestamptz not null default now(),
  monitor_host               text,
  monitor_port               integer     not null default 80,
  monitor_username           text        not null default 'MMService',
  monitor_password           text        not null default 'MagnetMonitor',
  service_user               text        not null default 'pi',
  -- When true, TV/Display mode suppresses value-based alarms for this unit
  -- (known-warm / in-service assets like a decommissioned service-center unit),
  -- so the wall display doesn't flash red forever. Connectivity status is
  -- unaffected. Toggled from the admin panel via admin_set_asset_maintenance.
  maintenance                boolean     not null default false,
  -- InHand Device Manager (DM) router disambiguation. router_device_id is the
  -- gateway's identity in DM (SN / device id) that DM sends in its webhook
  -- payload; router_online is the last state DM told us (null = unknown, no DM
  -- mapping yet). Lets us split a real magnet/collector fault from a mere iR305
  -- cellular drop — see evaluate_alerts and the dm-webhook edge function.
  router_device_id           text,
  router_online              boolean,
  router_status_at           timestamptz,
  -- Tailscale node liveness for this unit's collector Pi, polled from the
  -- Tailscale API by the tailscale-poll edge function. Same disambiguation as
  -- the iR305/DM signal but for the Pi itself: node up + no telemetry = the
  -- collector/MagMon is the fault; node down = Pi/site network down. null =
  -- unknown / no Tailscale node mapped yet.
  tailscale_device_id        text,
  tailscale_online           boolean,
  tailscale_status_at        timestamptz,
  -- The Pi's MagicDNS name, stamped by tailscale-poll alongside the flags above.
  -- We held only the numeric node id, which is the one thing you cannot type
  -- into an ssh command. It matters because monitor_host is a PRIVATE address
  -- that several sites reuse -- NM1027 (NMMC Hamilton) and NM1029 (Limestone)
  -- are both 192.168.14.199, NM1003 (Iuka) and NM1035 (Numed DSC) are both
  -- 192.168.0.1 -- so browsing that address over a tailnet subnet route reaches
  -- whichever Pi owns the route, with nothing on screen to say which. An
  -- engineer read a week of NM1027 minute data believing it was NM1029. Naming
  -- the Pi lets /docs print a tunnel that can only land on one unit.
  -- Applied 2026-08-20 (migration assets_tailscale_hostname).
  tailscale_hostname         text,
  -- Which collector build this unit is actually RUNNING, self-reported by the
  -- script on every cycle (COLLECTOR_VERSION in lib/piScript.ts, baked into the
  -- generated file and carried on every sample by row_to_sample).
  --
  -- We had no way to ask this. NM1035 was found running a months-old pre-batch
  -- collector only because somebody noticed its recorded_at carried sub-second
  -- precision instead of being minute-truncated -- luck, not monitoring, across
  -- 14 collectors on 10 hosts. NULL means it has not reported a version at all,
  -- which itself says the script predates versioning (2026-08-20).
  -- Applied 2026-08-20 (migration assets_collector_version).
  collector_version          text,
  collector_version_at       timestamptz,
  -- Owning tenant. Every unit belongs to exactly one company, so this is NOT
  -- NULL; the default keeps pre-Phase-3 RPCs (which don't pass it) working.
  -- Applied 2026-08-17 (multi_tenant_phase0_orgs_and_backfill).
  org_id                     uuid        not null default public.default_org_id()
                               references public.orgs(id),
  constraint assets_name_unique unique (name)
);
create index if not exists assets_org_id_idx on public.assets (org_id);

-- --- telemetry_samples (one reading) ---------------------------------
create table if not exists public.telemetry_samples (
  id           bigint      generated always as identity primary key,
  asset_id     uuid        not null references public.assets(id) on delete cascade,
  recorded_at  timestamptz not null default now(),
  data         jsonb,
  he_lvl       numeric,
  he_press     numeric,
  h2o_flow     numeric,
  h2o_temp     numeric,
  shield       numeric,
  cs1          numeric,
  created_at   timestamptz not null default now()
);
create index if not exists idx_telemetry_asset_created on public.telemetry_samples using btree (asset_id, created_at desc);
create index if not exists idx_telemetry_created_at    on public.telemetry_samples using btree (created_at);
-- One reading per asset per timestamp. Doubles as the ON CONFLICT target for
-- report_telemetry_batch's idempotent inserts and as the index that serves
-- latest_telemetry's `order by recorded_at desc limit 1`. Applied to the live
-- DB 2026-08-12 (migration telemetry_batch_reporting_and_recorded_at_readpath),
-- which first de-duplicated 106 byte-identical (asset_id, recorded_at) rows.
create unique index if not exists idx_telemetry_asset_recorded on public.telemetry_samples (asset_id, recorded_at);

-- --- alert_rules (per-asset thresholds; currently unused) ------------
create table if not exists public.alert_rules (
  id          uuid        primary key default gen_random_uuid(),
  asset_id    uuid        references public.assets(id) on delete cascade,
  field       text        not null,   -- e.g. 'he_lvl', 'h2o_flow'
  comparator  text        not null,   -- e.g. '<', '>', '<=', '>='
  threshold   numeric     not null,
  enabled     boolean     not null default true,
  created_at  timestamptz not null default now(),
  -- NOT NULL because a fleet-wide rule (asset_id IS NULL) means "all assets
  -- in THIS org" — without it, one tenant's thresholds would apply to every
  -- other tenant's units. 6 of the 7 live rules are fleet-wide.
  org_id      uuid        not null default public.default_org_id()
                references public.orgs(id)
);
create index if not exists alert_rules_org_id_idx on public.alert_rules (org_id);

-- --- alert_events (fired alerts; opened/resolved by evaluate_alerts) --
create table if not exists public.alert_events (
  id             bigint      generated always as identity primary key,
  asset_id       uuid        not null references public.assets(id) on delete cascade,
  alert_rule_id  uuid        references public.alert_rules(id) on delete set null,
  kind           text        not null,   -- 'offline' | 'reporting_stalled' | 'router_offline' | 'threshold' | 'sensor_fault' | 'never_reported'
  message        text        not null,
  channel        text,                   -- metric name for kind='sensor_fault' (dedup key: one unit can have several blind channels)
  triggered_at   timestamptz not null default now(),
  resolved_at    timestamptz,
  notified_at    timestamptz             -- set once a notifier has delivered it
);

-- --- alert_recipients (who receives alert emails) --------------------
-- Reached only via SECURITY DEFINER / service_role (no public policy).
create table if not exists public.alert_recipients (
  id         uuid primary key default gen_random_uuid(),
  channel    text not null default 'email' check (channel in ('email','sms')),
  address    text not null,
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

-- --- display_tokens (long-lived read-only credentials for wall TVs) ---
-- Added by migration display_tokens_and_rpcs; recorded here 2026-08-18, having
-- been missing from this file since it shipped.
--
-- A corridor TV used to run on a HUMAN's 30-day session: it carried that
-- person's identity and access, and dropped to a login form when the session
-- lapsed, usually with nobody watching. A display token is bound to one org,
-- grants only the fleet read, never expires, and is revocable.
--
-- Stored as a hash, exactly like user_sessions: the raw token is shown once at
-- creation and never persisted, so a dump of this table cannot be replayed
-- onto a screen. resolve_display_token matches on that hash, which is why
-- DELETING a row is itself a revocation — there is no longer a hash to match.
create table if not exists public.display_tokens (
  id           uuid        primary key default gen_random_uuid(),
  org_id       uuid        not null references public.orgs(id) on delete cascade,
  label        text        not null,   -- 'Corridor TV, Iuka' — how screens are told apart
  token_hash   text        not null unique,
  created_by   text,                   -- username, for the audit trail
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,            -- last fleet read by this screen; null = never opened
  revoked_at   timestamptz             -- set by admin_revoke_display_token; the row survives
);
create index if not exists display_tokens_org_idx on public.display_tokens (org_id);


-- =====================================================================
-- VIEWS
-- =====================================================================
-- Both views now run WITH (security_invoker = true) — applied by
-- phase2_close_public_reads on 2026-08-17. Before that they were effectively
-- SECURITY DEFINER (Postgres' default), running with the view OWNER's rights
-- and bypassing the underlying tables' RLS. That was the actual F-1 exposure:
-- anon saw 0 rows querying assets directly but all 17 through public_assets,
-- and since public_assets is a single-base-table view it was auto-updatable
-- too, so anon's default write grants reached the real table.
--
-- With security_invoker on, each view is evaluated as the CALLER, so assets'
-- "RLS enabled, no policy" now applies through the view as well. Keep it that
-- way: dropping and recreating either view WITHOUT this option silently
-- restores the bypass, because the insecure behaviour is the Postgres default.
-- The server reads these through the service role, which is unaffected.

-- public_assets: asset list WITHOUT the secret columns (gateway_token,
-- monitor_password, monitor_host/port/username). This is the shape the
-- dashboard reads.
create or replace view public.public_assets
  with (security_invoker = true) as
  select id, name, site_name, site_address,
         offline_threshold_minutes, status, last_seen_at, created_at, service_user,
         maintenance, router_online, router_status_at,
         tailscale_online, tailscale_status_at,
         last_sample_at
  from public.assets;

-- latest_telemetry: newest reading per asset, by recorded_at (true reading
-- time). Ordering by created_at would be unsafe once report_telemetry_batch
-- inserts several rows sharing one created_at -- it could return an arbitrary
-- reading from the batch as "latest". The idx_telemetry_asset_recorded unique
-- index serves this order-by-recorded_at-desc-limit-1.
create or replace view public.latest_telemetry
  with (security_invoker = true) as
  select t.asset_id, t.id, t.recorded_at, t.created_at,
         t.he_lvl, t.he_press, t.h2o_flow, t.h2o_temp, t.shield, t.cs1, t.data
  from public.assets a
  cross join lateral (
    select ts.id, ts.asset_id, ts.recorded_at, ts.data,
           ts.he_lvl, ts.he_press, ts.h2o_flow, ts.h2o_temp, ts.shield, ts.cs1, ts.created_at
    from public.telemetry_samples ts
    where ts.asset_id = a.id
    order by ts.recorded_at desc
    limit 1
  ) t;


-- =====================================================================
-- FUNCTIONS (RPCs) — all SECURITY DEFINER with pinned search_path
-- =====================================================================

-- --- server-side sessions (multi-tenant Phase 1a, 2026-08-17) --------
-- Granted to service_role ONLY: the Next server holds the service key and is
-- the sole caller. anon/authenticated cannot reach these at all, which takes
-- PIN verification off the public API surface (anon-callable verify_user_login
-- is what allowed PIN brute-forcing) and lets the app rate-limit login itself.
-- Applied as migration multi_tenant_phase1_session_rpcs. Full bodies live in
-- that migration; signatures and contracts recorded here:
--
--   _session_token_hash(token) -> text
--       sha256 hex. The raw token is returned once at creation and never
--       stored, so a leaked user_sessions dump cannot be replayed as a login.
--
--   create_session(username, pin, ttl_days default 30)
--       -> table(token, expires_at)
--       Same lockout semantics as verify_user_login (5 strikes -> 15 min),
--       and returns NO ROWS on a bad PIN rather than raising — a raise would
--       roll back the strike (the fix_pin_lockout_persistence bug). Points
--       active_org at the first membership, preferring 'numed'; falls back to
--       numed for a superadmin holding no membership.
--
--   resolve_session(token)
--       -> table(user_id, username, is_superadmin, active_org,
--                active_org_slug, active_org_is_demo, effective_role,
--                tv_access, docs_access, memberships, expires_at,
--                org_product_name, org_eyebrow, org_tagline, org_logo_url)
--       The per-request read path. effective_role collapses the superadmin
--       rule — a superadmin is admin in EVERY org, including ones they hold
--       no membership in, hence the left join to org_members.
--       active_org_is_demo (migration resolve_session_active_org_is_demo,
--       2026-08-17) exists for the same reason as that left join: the active
--       org can be one the caller holds no membership in, so memberships[]
--       cannot answer "am I looking at demo data?". Callers must read this
--       field, not search the array. Recreating the function to widen its
--       OUT columns resets the ACL, so a follow-up migration re-revokes
--       anon/authenticated — it is service_role-only, like its siblings.
--       org_logo_url joined it the same way (migration
--       resolve_session_active_org_logo_url) so the nav/dashboard mark can be
--       a tenant's own logo with no extra round-trip.
--
-- --- Docs access grant (2026-08-17) -----------------------------------
--   admin_set_docs_access(p_token, p_target_username, p_docs_access)
--       The checkbox, an exact mirror of admin_set_tv_access: scoped to the
--       actor's active org, audited as 'set_docs_access', and raising the same
--       deliberately vague "User not found in this organization." for both a
--       missing user and a non-member.
--   admin_list_users / admin_list_all_users / admin_set_membership all carry
--       docs_access alongside tv_access. admin_set_membership was DROPPED and
--       recreated with a 6th defaulted param — an overload would have left the
--       5-arg version live and made a 5-arg call ambiguous.
--
-- --- Company logos (2026-08-17) ---------------------------------------
--   admin_set_org_logo(p_token, p_org_id, p_logo_url) -> boolean
--       Superadmin-only; sets or (with NULL) clears orgs.logo_url, audited as
--       'set_org_logo'. Kept SEPARATE from admin_update_org because the logo
--       is saved by a file upload that has already reached storage, on its own
--       button — folding it in would mean an upload could only be kept by also
--       re-submitting name/eyebrow/tagline. Rejects any URL outside the
--       org-logos bucket, so a caller other than the upload action cannot
--       point a company's mark at an arbitrary host.
--
--   Storage: bucket 'org-logos' (migration org_logos_storage_bucket) —
--       PUBLIC READ, because the logo has to paint on surfaces with no user
--       session (login screen, long-lived wall displays) and signed URLs would
--       expire under a TV that has been up for a month. NO write policy
--       exists, so anon/authenticated can write nothing; uploads go through
--       the service-role key in adminUploadOrgLogo, which checks superadmin
--       BEFORE the bytes land. PNG/JPEG/WebP only, 2 MB — no SVG, whose
--       embedded script would run on direct navigation to the storage host.
--
--   switch_active_org(token, org_id) -> boolean
--       Refuses an org the caller has no membership in unless superadmin.
--       This is the check that stops a multi-org user reaching a tenant they
--       were never granted.
--
--   destroy_session(token) -> boolean
--   cleanup_expired_sessions() -> integer   (pg_cron 'cleanup-expired-sessions', 17 3 * * *)

-- --- Wall displays (2026-08-17; delete added 2026-08-18) --------------
-- Migrations display_tokens_and_rpcs, then admin_delete_display_token.
-- service_role only, like every other admin_* — a new function carries EXECUTE
-- for PUBLIC by default, so each migration revokes anon/authenticated.
--
--   resolve_display_token(p_token) -> table(org_id, label)
--       The read path, called on every request a screen makes. Matches the
--       sha256 hash, ignores revoked rows, and stamps last_seen_at as a side
--       effect — which is what makes "never opened" vs "seen 10 min ago"
--       answerable in the admin list. Returns no rows for a revoked, deleted
--       or forged token; app/tv/page.tsx renders a dead-link message rather
--       than a login form, because someone standing at a wall TV needs to know
--       the link is dead, not wonder why a screen is asking for a PIN.
--
--   admin_create_display_token(p_token, p_label, p_org_id default null)
--       -> table(display_token, id)
--       Returns the raw token ONCE. p_org_id defaults to the actor's active
--       org; a superadmin may name any company, anyone else is refused for
--       anything but their own. That rule is what the company picker in
--       DisplaysSection mirrors — the UI must never offer a company this
--       would then reject.
--
--   admin_list_display_tokens(p_token)
--       -> table(id, org_id, org_name, label, created_by, created_at,
--                last_seen_at, revoked_at)
--       A company admin sees only their own screens; a superadmin sees all.
--
--   admin_revoke_display_token(p_token, p_id) -> boolean
--       Stamps revoked_at and KEEPS the row, so a screen that was real stays
--       on record with when it stopped.
--
--   admin_delete_display_token(p_token, p_id) -> boolean
--       Removes the row outright — for links that are clutter rather than
--       history (a typo'd label, a duplicate, a test). Allowed on an ACTIVE
--       token too: the commonest reason to delete is a link created by
--       mistake, and requiring a revoke first is a two-step dance for one
--       intent. Audits BEFORE deleting, noting whether the link was still
--       live, since the row is about to stop existing and a removal with
--       nothing recording who did it is worse than the clutter it clears.
--
-- Both mutators carry the same tenancy check as the list (superadmin any,
-- otherwise own org only) and raise a deliberately vague "Display not found."
-- for a miss, so the id space cannot be probed for other tenants' rows.

-- --- Company suspension + deletion (2026-08-18) -----------------------
-- Migration org_enabled_and_delete. service_role only, as ever.
--
--   admin_set_org_enabled(p_token, p_org_id, p_enabled) -> boolean
--       Superadmin-only; flips orgs.enabled, audited as enable_org/disable_org.
--       Takes effect on the NEXT REQUEST, not the next login: the gate lives in
--       resolve_session, which every request already calls.
--
--   admin_delete_org(p_token, p_id) -> boolean
--       Superadmin-only. Destroys the company and everything under it. The
--       child deletes are written out rather than left to ON DELETE CASCADE:
--       the FKs from assets/alert_rules/alert_recipients to orgs are NO ACTION,
--       so a bare "delete from orgs" just errors -- and a cascade that silently
--       removes tens of thousands of telemetry rows ought to be visible in the
--       source of the function doing it. Order: alert_recipients, alert_rules,
--       assets (which cascades telemetry_samples, alert_events, per-asset rules
--       and demo_asset_specs), then the org itself (cascading org_members and
--       display_tokens, and nulling user_sessions.active_org).
--
--       audit_log is the deliberate exception: its rows are NULLED, not
--       deleted. Losing the record of what was done to a company at the moment
--       the company is destroyed is precisely backwards. The deletion is itself
--       audited BEFORE the row goes, while the FK still holds.
--
--       Two refusals, both about states the app cannot recover from on its own:
--       deleting the caller's OWN active org would strand their session with no
--       active_org, which _admin_actor rejects -- every subsequent admin action
--       would fail and the panel would look broken; and deleting the LAST org
--       leaves an empty orgs table, which no admin RPC can be called to fix.
--
-- The gate itself is spread across the access paths rather than centralised,
-- because there is no single choke point -- create_session (login),
-- resolve_session (every request), switch_active_org, list_switchable_orgs and
-- resolve_display_token each grant access their own way. notify-alerts and
-- send-push carry the delivery half, folded into the query that already
-- excluded demo tenants: one "who must not be written to" list, two reasons to
-- be on it.

-- --- Phase 3: session-authenticated, org-scoped admin RPCs (2026-08-17) ----
-- Migrations: phase3a_admin_session_foundation, phase3b1_asset_admin_rpcs_session_scoped.
--
-- IN PROGRESS. The admin RPCs are being moved off (p_actor_username,
-- p_actor_pin) — the F-4 surface — onto the server-side session. Because a DB
-- migration hits production instantly while code only changes on deploy, the
-- new versions are added as OVERLOADS taking p_token; the old signatures stay
-- live until the new app code ships. Parameter names differ and supabase-js
-- calls RPCs with named arguments, so resolution is unambiguous.
--
--   _admin_actor(p_token) -> (user_id, username, org_id, is_superadmin)
--       The single authorization gate, replacing is_admin(). Resolves the
--       session, demands the admin role, and returns the ACTIVE ORG every
--       scoped statement must filter by. RAISES rather than returning null, so
--       a caller that forgets to check gets an exception, not unscoped access.
--       Superadmin comes free: resolve_session already reports
--       effective_role='admin' for a superadmin in any org.
--
--   _record_audit(actor, action, entity_type, entity_id, detail, org_id=null)
--       Gained p_org_id. audit_log.org_id previously relied on its column
--       default — default_org_id() — so an action in ANY org was stamped
--       'numed'. The 5-arg version was dropped and recreated with a 6th
--       defaulted param (keeping a 5-arg overload would make legacy calls
--       ambiguous); null still falls back to default_org_id().
--
-- DONE so far — asset group, all filtering on assets.org_id = actor's org:
--   admin_create_asset(p_token, ...)            sets org_id EXPLICITLY (the
--       column default would file another tenant's unit under Numed)
--   admin_update_asset(p_token, p_asset_id, ...)
--   admin_delete_asset(p_token, p_asset_id)     NOW AUDITED (was not — deleting
--       a unit and cascading its telemetry used to be untraceable)
--   admin_get_asset_config(p_token, p_asset_id) the most sensitive read in the
--       app: gateway_token + MagMon credentials
--   admin_set_asset_maintenance(p_token, p_asset_id, p_maintenance)
--   admin_rotate_gateway_token(p_token, p_asset_id)  NOW AUDITED
--
-- A wrong-org asset id raises "Asset not found." — identical to a genuinely
-- missing one, so these can't probe which uuids exist in other tenants.
-- Verified: viewer refused; cross-org read returns 0 rows; cross-org update /
-- rotate / delete / maintenance all refused; create lands in the ACTIVE org.
--
-- STILL TO DO: the user, alert and audit-log RPCs; the app layer
-- (lib/adminActions.ts + app/admin/page.tsx); then Phase 3c drops the old
-- (username, pin) signatures and revokes anon EXECUTE, which closes F-4.
-- alert_recipients gained org_id here (it was global — Numed would have been
-- paged for another tenant's magnet).

-- --- auth / self-service ---------------------------------------------

CREATE OR REPLACE FUNCTION public.is_admin(p_username text, p_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  perform 1 from users
    where username = p_username and role = 'admin' and pin_hash = extensions.crypt(p_pin, pin_hash);
  return found;
end;
$function$;

CREATE OR REPLACE FUNCTION public.verify_user_login(p_username text, p_pin text)
 RETURNS TABLE(username text, role text, tv_access boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_user users%rowtype;
begin
  select * into v_user from users where users.username = p_username;
  if v_user.id is null then
    raise exception 'invalid username or PIN';
  end if;
  if v_user.locked_until is not null and v_user.locked_until > now() then
    raise exception 'account locked — try again later';
  end if;
  if v_user.pin_hash = extensions.crypt(p_pin, v_user.pin_hash) then
    update users set failed_attempts = 0, locked_until = null where id = v_user.id;
    return query select v_user.username, v_user.role, v_user.tv_access;
  else
    -- Wrong PIN. Persist the attempt/lockout, then return no rows (do NOT raise:
    -- a raise here rolls this update back in the same transaction, which is why
    -- the lockout never engaged before the fix_pin_lockout_persistence migration
    -- of 2026-08-10). The client treats an empty result as a failed login.
    update users
      set failed_attempts = failed_attempts + 1,
          locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
      where id = v_user.id;
    return;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.register_user(p_invite_code text, p_username text, p_pin text)
 RETURNS TABLE(username text, role text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
-- Resolves the invite code to an ORG and creates the membership. Before this
-- (migration multi_tenant_register_user_joins_org, 2026-08-17) it inserted into
-- users only, which after Phase 0 meant a successful signup followed by an
-- empty app. Per-org codes are what make onboarding a new company self-serve.
-- Numed's org invite_code was copied from app_settings.invite_code in Phase 0,
-- so the code already in circulation keeps working.
declare
  v_org_id  uuid;
  v_user_id uuid;
begin
  select id into v_org_id
    from orgs
   where invite_code is not null
     and invite_code = p_invite_code;

  if v_org_id is null then
    raise exception 'invalid invite code';
  end if;

  -- users.role is still written because verify_user_login reads it until the
  -- Phase 1c cutover; org_members.role is the real grant.
  insert into users (username, pin_hash, role)
  values (p_username, extensions.crypt(p_pin, extensions.gen_salt('bf')), 'viewer')
  returning id into v_user_id;

  insert into org_members (user_id, org_id, role, tv_access)
  values (v_user_id, v_org_id, 'viewer', false);

  return query select p_username, 'viewer'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION public.change_own_pin(p_username text, p_old_pin text, p_new_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  perform username from verify_user_login(p_username, p_old_pin);
  -- verify_user_login now returns empty (instead of raising) on a wrong PIN, so
  -- guard explicitly: a wrong current PIN must never change the PIN.
  if not found then
    raise exception 'incorrect current pin';
  end if;
  update users set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf')) where username = p_username;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reset_own_pin(p_username text, p_old_pin text, p_new_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not exists (
    select 1 from users where username = p_username and pin_hash = extensions.crypt(p_old_pin, pin_hash)
  ) then
    raise exception 'incorrect current pin';
  end if;
  update users set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf')) where username = p_username;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_own_username(p_username text, p_pin text, p_new_username text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not exists (
    select 1 from users where username = p_username and pin_hash = extensions.crypt(p_pin, pin_hash)
  ) then
    raise exception 'incorrect pin';
  end if;
  update users set username = p_new_username where username = p_username;
  return true;
end;
$function$;

-- --- admin (all gated by is_admin) -----------------------------------

-- The site CRUD RPCs (admin_create_site/admin_update_site/admin_delete_site)
-- were dropped when `sites` was folded into `assets`. Location is now set on
-- the asset via admin_create_asset / admin_update_asset below.

CREATE OR REPLACE FUNCTION public.admin_create_asset(p_actor_username text, p_actor_pin text, p_name text, p_site_name text DEFAULT NULL::text, p_site_address text DEFAULT NULL::text, p_offline_threshold_minutes integer DEFAULT 30, p_monitor_host text DEFAULT NULL::text, p_monitor_port integer DEFAULT 80, p_monitor_username text DEFAULT 'MMService'::text, p_monitor_password text DEFAULT 'MagnetMonitor'::text, p_service_user text DEFAULT 'pi'::text)
 RETURNS assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  result assets;
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  insert into assets (
    name, site_name, site_address, gateway_token, offline_threshold_minutes,
    status, monitor_host, monitor_port, monitor_username, monitor_password, service_user
  )
  values (
    p_name, p_site_name, p_site_address, encode(extensions.gen_random_bytes(24), 'hex'), p_offline_threshold_minutes,
    'unknown', p_monitor_host, p_monitor_port, p_monitor_username, p_monitor_password, coalesce(nullif(btrim(p_service_user), ''), 'pi')
  )
  returning * into result;
  perform _record_audit(p_actor_username, 'create_asset', 'asset', result.id::text, format('Added asset "%s"', p_name));
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_update_asset(p_actor_username text, p_actor_pin text, p_asset_id uuid, p_name text, p_offline_threshold_minutes integer, p_monitor_host text, p_monitor_port integer, p_monitor_username text, p_monitor_password text, p_site_name text DEFAULT NULL::text, p_site_address text DEFAULT NULL::text, p_service_user text DEFAULT 'pi'::text)
 RETURNS assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  result assets;
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  update assets set
    name = p_name,
    site_name = p_site_name,
    site_address = p_site_address,
    offline_threshold_minutes = p_offline_threshold_minutes,
    monitor_host = p_monitor_host,
    monitor_port = p_monitor_port,
    monitor_username = p_monitor_username,
    monitor_password = p_monitor_password,
    service_user = coalesce(nullif(btrim(p_service_user), ''), 'pi')
  where id = p_asset_id
  returning * into result;
  perform _record_audit(p_actor_username, 'update_asset', 'asset', p_asset_id::text, format('Updated asset "%s"', p_name));
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_asset(p_actor_username text, p_actor_pin text, p_asset_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  delete from assets where id = p_asset_id;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_get_asset_config(p_actor_username text, p_actor_pin text, p_asset_id uuid)
 RETURNS TABLE(gateway_token text, monitor_host text, monitor_port integer, monitor_username text, monitor_password text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  return query
    select a.gateway_token, a.monitor_host, a.monitor_port, a.monitor_username, a.monitor_password
    from assets a where a.id = p_asset_id;
end;
$function$;

-- Toggle a unit's maintenance flag (TV/Display mode alarm suppression).
CREATE OR REPLACE FUNCTION public.admin_set_asset_maintenance(p_actor_username text, p_actor_pin text, p_asset_id uuid, p_maintenance boolean)
 RETURNS assets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  result assets;
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  update assets set maintenance = p_maintenance
   where id = p_asset_id
  returning * into result;
  perform _record_audit(
    p_actor_username,
    'set_maintenance',
    'asset',
    p_asset_id::text,
    format('%s maintenance mode for "%s"',
           case when p_maintenance then 'Enabled' else 'Cleared' end, result.name)
  );
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_create_user(p_actor_username text, p_actor_pin text, p_new_username text, p_new_pin text, p_role text DEFAULT 'viewer'::text)
 RETURNS TABLE(username text, role text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  insert into users (username, pin_hash, role)
  values (p_new_username, extensions.crypt(p_new_pin, extensions.gen_salt('bf')), p_role);
  return query select p_new_username, p_role;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_list_users(p_actor_username text, p_actor_pin text)
 RETURNS TABLE(username text, role text, tv_access boolean, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  return query select u.username, u.role, u.tv_access, u.created_at from users u order by u.created_at;
end;
$function$;

-- Admin-only toggle for a user's TV/Display access, audited.
CREATE OR REPLACE FUNCTION public.admin_set_tv_access(p_actor_username text, p_actor_pin text, p_target_username text, p_tv_access boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  update users set tv_access = p_tv_access where username = p_target_username;
  perform _record_audit(
    p_actor_username, 'set_tv_access', 'user', p_target_username,
    format('%s TV access for "%s"', case when p_tv_access then 'Granted' else 'Revoked' end, p_target_username)
  );
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_reset_pin(p_actor_username text, p_actor_pin text, p_target_username text, p_new_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  update users
    set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf')),
        failed_attempts = 0, locked_until = null
    where username = p_target_username;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_role(p_actor_username text, p_actor_pin text, p_target_username text, p_new_role text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  update users set role = p_new_role where username = p_target_username;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_invite_code(p_actor_username text, p_actor_pin text, p_new_code text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  update app_settings set value = p_new_code where key = 'invite_code';
  return true;
end;
$function$;

-- --- telemetry -------------------------------------------------------
-- ── Sensor sentinels stored as NULL, not as a reading ──────────────────
-- The MagMon does not omit a water channel that has no sensor attached (or
-- whose sensor has failed) — it emits a FIXED placeholder. It is the same
-- constant on every machine, which is what gives it away: NM1006 and NM1035
-- sit on it permanently (1972/1972 and 1990/1990 samples), while NM1027 and
-- NM1019 drop into it intermittently. Depending on the unit system a device is
-- configured for it arrives as either the metric or the imperial rendering of
-- one underlying value — NM1035 has emitted both, which is how the pairing was
-- identified:
--
--   h2o_temp    38.042 °C     ==  100.4756 °F   (device rounds to 100.476)
--   h2o_flow    19.017 L/min  ==    5.0238 gpm  (device rounds to 5.024)
--
-- Storing that as a reading is worse than storing nothing. It held a
-- "h2o_temp > 75" alert open on NM1006 for 177 h against a channel that was
-- never measuring anything, and on NM1027 it repeatedly RESOLVED a genuine
-- low-flow alarm: real flow reads 0.05–0.6, the sensor drops out to 5.024, the
-- alarm clears, the next real sample re-opens it — 12 open/close cycles and 6
-- notifications in 24 h. We store NULL instead. The device's original payload
-- is preserved verbatim in telemetry_samples.data, so nothing is discarded.
--
-- Tolerance is deliberately tight (0.002). The observed spellings are 100.476 /
-- 100.47560000000001 and 5.024 / 5.023759919694909, all well inside it, while
-- the highest real reading on the fleet is 77.68 °F and 3.884 gpm — no genuine
-- measurement is anywhere near either constant.
create or replace function public.nullify_sentinel(p_field text, p_value numeric)
returns numeric
language sql
immutable
as $$
  select case
    when p_value is null then null
    when p_field = 'h2o_temp'
      and (abs(p_value - 100.4756) < 0.002 or abs(p_value - 38.042) < 0.002) then null
    when p_field = 'h2o_flow'
      and (abs(p_value - 5.0238) < 0.002 or abs(p_value - 19.017) < 0.002) then null
    else p_value
  end;
$$;
-- APPLIED to live DB 2026-08-19 via migration
-- sensor_sentinel_nullify_and_alert_channel, plus a one-time backfill of the
-- 5,375 already-stored rows that carried the placeholder.


CREATE OR REPLACE FUNCTION public.report_telemetry(p_gateway_token text, p_recorded_at timestamp with time zone, p_he_lvl numeric DEFAULT NULL::numeric, p_he_press numeric DEFAULT NULL::numeric, p_h2o_flow numeric DEFAULT NULL::numeric, p_h2o_temp numeric DEFAULT NULL::numeric, p_shield numeric DEFAULT NULL::numeric, p_cs1 numeric DEFAULT NULL::numeric, p_raw jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_asset_id uuid;
  v_last_seen timestamptz;
  v_recent_count int;
  v_rec timestamptz;
begin
  select id, last_seen_at into v_asset_id, v_last_seen
  from assets where gateway_token = p_gateway_token;

  if v_asset_id is null then
    raise exception 'invalid gateway token';
  end if;

  if v_last_seen is null or v_last_seen < now() - interval '10 seconds' then
    -- collector_version rides beside the LIVENESS stamp, not the data stamp: it is
  -- a property of the script phoning home, so a unit whose device has gone quiet
  -- still reports which code it runs -- exactly when you want to know. coalesce
  -- keeps a known version rather than blanking it, so an older collector that
  -- does not send the field cannot erase what a newer one told us.
  update assets set last_seen_at = now(), status = 'online',
         collector_version = coalesce(p_raw->>'collector_version', collector_version),
         collector_version_at = case when p_raw->>'collector_version' is not null
                                     then now() else collector_version_at end
   where id = v_asset_id;
  end if;

  -- Clock-skew safety net (see report_telemetry_batch): a grossly-wrong device
  -- clock (> 2 days off, e.g. a pre-anchoring collector on a Pi whose RTC is
  -- stuck in the past) rebases to the current minute; otherwise the reading time
  -- is kept as-is.
  if p_recorded_at is not null and abs(extract(epoch from (now() - p_recorded_at))) > 172800 then
    v_rec := date_trunc('minute', now());
  else
    v_rec := p_recorded_at;
  end if;

  select count(*) into v_recent_count
  from telemetry_samples
  where asset_id = v_asset_id and created_at >= now() - interval '60 seconds';

  if v_recent_count = 0 then
    insert into telemetry_samples (asset_id, recorded_at, he_lvl, he_press, h2o_flow, h2o_temp, shield, cs1, data)
    -- Water channels pass through nullify_sentinel(): the MagMon's fixed
    -- no-sensor placeholder is stored as NULL rather than as a reading. p_raw
    -- keeps the device's original payload verbatim.
    values (v_asset_id, v_rec, p_he_lvl, p_he_press,
            nullify_sentinel('h2o_flow', p_h2o_flow),
            nullify_sentinel('h2o_temp', p_h2o_temp),
            p_shield, p_cs1, p_raw);
    -- A genuinely new sample stored: bump the data-freshness clock.
    update assets set last_sample_at = now() where id = v_asset_id;
  end if;

  return true;
end;
$function$;

-- report_telemetry_batch: report every NEW minute row a collector fetched this
-- cycle in one call, instead of only the latest (report_telemetry above). This
-- gives true minute-resolution history WITHOUT polling the MagMon any harder --
-- the collector already fetches the last hour of minute rows each cycle. Inserts
-- are idempotent on (asset_id, recorded_at) via idx_telemetry_asset_recorded, so
-- overlapping fetches and restart re-sends are harmless. Returns the count of
-- rows actually inserted. p_samples is a JSON array of objects, each with
-- recorded_at (Pi-anchored, minute-truncated) plus the numeric metric fields;
-- the whole object is also stored in `data` for audit (keeps the source tag).
CREATE OR REPLACE FUNCTION public.report_telemetry_batch(p_gateway_token text, p_samples jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_asset_id uuid;
  v_inserted int;
  v_max_rec timestamptz;
  v_offset interval := interval '0';
begin
  select id into v_asset_id from assets where gateway_token = p_gateway_token;
  if v_asset_id is null then
    raise exception 'invalid gateway token';
  end if;

  -- Liveness stamp uses ingest wall-clock (now()), never the reading time, so a
  -- backfill of delayed rows can never make a unit look more recently seen than
  -- it is. Mirrors the single-row report_telemetry.
  -- collector_version rides beside the LIVENESS stamp, not the data stamp: it is
  -- a property of the script phoning home, so a unit whose device has gone quiet
  -- still reports which code it runs -- exactly when you want to know. coalesce
  -- keeps a known version rather than blanking it, so an older collector that
  -- does not send the field cannot erase what a newer one told us.
  update assets set last_seen_at = now(), status = 'online',
         collector_version = coalesce(p_samples->0->>'collector_version', collector_version),
         collector_version_at = case when p_samples->0->>'collector_version' is not null
                                     then now() else collector_version_at end
   where id = v_asset_id;

  -- Clock-skew safety net: rebase the whole batch by offset = now() - newest when
  -- the newest reading is grossly skewed (> 2 days) — a Pi still on the
  -- pre-anchoring collector whose device RTC is wrong (e.g. NM1008 stuck in 2022).
  -- offset is ~constant for a wrong-but-running clock, so a given device minute
  -- maps to a stable wall minute across overlapping re-sends and dedups cleanly;
  -- minute-floor keeps that stable. offset ~ 0 (correctly clocked / genuine
  -- backfill / already-anchored collector) leaves recorded_at untouched. The raw
  -- device timestamp is preserved in `data`. Applied to live DB 2026-08-13
  -- (migration report_telemetry_clock_skew_safety_net).
  select max((s->>'recorded_at')::timestamptz) into v_max_rec
  from jsonb_array_elements(p_samples) s
  where (s->>'recorded_at') is not null;

  if v_max_rec is not null and abs(extract(epoch from (now() - v_max_rec))) > 172800 then
    v_offset := now() - v_max_rec;
  end if;

  insert into telemetry_samples (asset_id, recorded_at, he_lvl, he_press, h2o_flow, h2o_temp, shield, cs1, data)
  select v_asset_id,
         case when v_offset = interval '0'
              then (s->>'recorded_at')::timestamptz
              else date_trunc('minute', (s->>'recorded_at')::timestamptz + v_offset) end,
         (s->>'he_lvl')::numeric,
         (s->>'he_press')::numeric,
         nullify_sentinel('h2o_flow', (s->>'h2o_flow')::numeric),  -- see report_telemetry
         nullify_sentinel('h2o_temp', (s->>'h2o_temp')::numeric),
         (s->>'shield')::numeric,
         (s->>'cs1')::numeric,
         s
  from jsonb_array_elements(p_samples) s
  where (s->>'recorded_at') is not null
  on conflict (asset_id, recorded_at) do nothing;

  get diagnostics v_inserted = row_count;

  -- Only a real insert refreshes data-freshness. An all-duplicate batch (a hung
  -- device re-serving the same rows) leaves last_sample_at to age -> stale.
  if v_inserted > 0 then
    update assets set last_sample_at = now() where id = v_asset_id;
  end if;

  return v_inserted;
end;
$function$;
grant execute on function public.report_telemetry_batch(text, jsonb) to anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.asset_telemetry_15min(p_asset_id uuid, p_hours integer DEFAULT 24)
 RETURNS TABLE(created_at timestamp with time zone, he_lvl numeric, he_press numeric, h2o_flow numeric, h2o_temp numeric, shield numeric, cs1 numeric, sample_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    to_timestamp(floor(extract(epoch from t.recorded_at) / 900) * 900) as created_at,
    round(avg(t.he_lvl), 2) as he_lvl,
    round(avg(t.he_press), 3) as he_press,
    round(avg(t.h2o_flow), 3) as h2o_flow,
    round(avg(t.h2o_temp), 2) as h2o_temp,
    round(avg(t.shield), 2) as shield,
    round(avg(t.cs1), 2) as cs1,
    count(*) as sample_count
  from telemetry_samples t
  where t.asset_id = p_asset_id
    and t.recorded_at >= now() - (p_hours || ' hours')::interval
  group by 1
  order by 1;
$function$;
-- NB: buckets/windows on recorded_at (true reading time), not created_at
-- (ingest time). The output column keeps the name created_at so the chart and
-- table components need no change -- it now carries the reading-time bucket.


-- ── Gateway token rotation (backs the admin "Rotate token" button) ──
CREATE OR REPLACE FUNCTION public.admin_rotate_gateway_token(p_actor_username text, p_actor_pin text, p_asset_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_token text;
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  update assets
     set gateway_token = encode(extensions.gen_random_bytes(24), 'hex')
   where id = p_asset_id
  returning gateway_token into v_token;
  if v_token is null then
    raise exception 'Asset not found.';
  end if;
  return v_token;
end;
$function$;


-- =====================================================================
-- DM ROUTER STATUS (InHand Device Manager webhook disambiguation)
-- =====================================================================
-- Idempotent live-DB migration for the router_* columns declared on the
-- assets table above (create-table is a no-op on an existing table, so the
-- columns are added here for already-provisioned databases). Safe to re-run.
alter table public.assets add column if not exists router_device_id text;
alter table public.assets add column if not exists router_online     boolean;
alter table public.assets add column if not exists router_status_at   timestamptz;
create index if not exists idx_assets_router_device_id
  on public.assets (router_device_id);

-- Raw landing table for every DM webhook POST. We keep the full payload so the
-- FIRST real "Gateway Offline"/"Gateway Online" event reveals DM's exact field
-- names (device id, event type, timestamp) — then the dm-webhook function's
-- best-effort parser can be tightened to match. Also an audit trail. Written
-- only by the service-role edge function; no public policy.
create table if not exists public.dm_webhook_events (
  id            bigint      generated always as identity primary key,
  received_at   timestamptz not null default now(),
  event_type    text,                         -- best-effort parsed (online/offline/…)
  device_id     text,                         -- best-effort parsed gateway id
  matched_asset uuid        references public.assets(id) on delete set null,
  authed        boolean     not null default false, -- did the shared key verify?
  payload       jsonb       not null,          -- the full body DM sent
  note          text
);
create index if not exists idx_dm_webhook_events_received
  on public.dm_webhook_events using btree (received_at desc);

-- =====================================================================
-- ALERTING (offline + threshold/state rules; evaluated by pg_cron once live)
-- =====================================================================

-- Evaluate offline + threshold/state conditions and open/resolve alert_events.
-- Idempotent. A per-asset rule overrides the global (asset_id NULL) rule for
-- the same field. Maintenance-flagged units are exempt (mirrors TV/Display):
-- their open events are resolved and no new ones are opened, so known-warm
-- service-center units (e.g. NM1034) don't raise permanent phantom alarms.
-- Scheduled every minute by pg_cron job 'evaluate-alerts' (see end of file);
-- sends nothing itself — notification is a separate step.
-- APPLIED to live DB 2026-08-12 via migration evaluate_alerts_exempt_maintenance,
-- then 2026-08-13 via migration alerts_disambiguate_reporting_stalled (splits a
-- stale unit into 'offline' vs 'reporting_stalled' by Tailscale reachability),
-- then 2026-08-13 via migration evaluate_alerts_key_off_last_sample_at (staleness
-- keys off last_sample_at = fresh-data, not last_seen_at = reachability, closing
-- the reachable-but-silent blind spot; reachability now also accepts a fresh
-- last_seen_at, not just a Tailscale poll).
-- APPLIED to live DB 2026-08-19 via migration
-- evaluate_alerts_sensor_fault_never_reported_freshness, which adds three
-- things found during a fleet health check:
--   * kind 'never_reported' -- the stale loop requires last_sample_at is not
--     null, so a unit that never reported once was invisible to alerting
--     FOREVER. NM1030 and NM1031 had been silent and un-alerted for 8 and 13
--     days respectively.
--   * kind 'sensor_fault' (with alert_events.channel) -- a channel blank for an
--     hour on a unit that is otherwise reporting. Without it, nullify_sentinel()
--     would convert a blind channel into a silent one.
--   * a freshness guard on the threshold loop -- latest_telemetry used to be
--     joined with no freshness test, so an offline unit's final reading was
--     re-evaluated forever and a unit that went dark mid-breach held that alarm
--     indefinitely. Stale units now have their threshold events resolved; the
--     offline / reporting_stalled event is what speaks for them.
CREATE OR REPLACE FUNCTION public.evaluate_alerts()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record;
begin
  -- MAINTENANCE mute: resolve any open events for units now in maintenance.
  update alert_events e set resolved_at = now()
  from assets a
  where e.asset_id = a.id and e.resolved_at is null and a.maintenance;

  -- NEVER REPORTED: provisioned, but no telemetry has EVER landed. The stale
  -- loop below requires last_sample_at is not null, so these units were
  -- invisible to alerting entirely — NM1030 (added 2026-08-06) and NM1031
  -- (added 2026-08-11) sat silent and un-alerted for days. The grace period
  -- keeps a freshly-added asset quiet while its Pi is still being installed.
  for r in
    select a.id, a.name, a.created_at
    from assets a
    where a.maintenance = false
      and a.last_sample_at is null
      and a.created_at < now() - interval '2 hours'
  loop
    if not exists (select 1 from alert_events e
                   where e.asset_id = r.id and e.kind = 'never_reported' and e.resolved_at is null) then
      insert into alert_events (asset_id, kind, message)
      values (r.id, 'never_reported',
        format('%s has never reported telemetry since it was added on %s — check the collector install on its Pi',
               r.name, to_char(r.created_at, 'YYYY-MM-DD')));
    end if;
  end loop;

  update alert_events e set resolved_at = now()
  from assets a
  where e.asset_id = a.id and e.kind = 'never_reported' and e.resolved_at is null
    and a.last_sample_at is not null;

  -- STALE TELEMETRY (no NEW data within the unit's threshold) -> partition by Pi
  -- reachability into two actionable kinds:
  --   * reporting_stalled: the Pi is reachable (fresh Tailscale poll, or it is
  --     still phoning home via last_seen_at) yet no fresh telemetry -> a
  --     gateway/device/clock fault on an otherwise-up Pi. Covers both the NM1020
  --     DNS case and a hung MagMon that stops advancing its log.
  --   * offline: no fresh data and the Pi is NOT confirmed reachable -> the unit
  --     or its site network is down.
  -- Exactly one kind is open per stale unit; if reachability flips, the wrong one
  -- is resolved and the right one opened next run.
  for r in
    select a.id, a.name, a.last_sample_at,
      ((a.tailscale_online is true
         and a.tailscale_status_at is not null
         and a.tailscale_status_at >= now() - interval '15 minutes')
       or (a.last_seen_at is not null
         and a.last_seen_at >= now() - make_interval(mins => a.offline_threshold_minutes))
      ) as pi_reachable
    from assets a
    where a.maintenance = false
      and a.last_sample_at is not null
      and a.last_sample_at < now() - make_interval(mins => a.offline_threshold_minutes)
  loop
    if r.pi_reachable then
      if not exists (select 1 from alert_events e where e.asset_id=r.id and e.kind='reporting_stalled' and e.resolved_at is null) then
        insert into alert_events (asset_id, kind, message)
        values (r.id, 'reporting_stalled',
          format('%s reachable but no fresh telemetry since %s — likely gateway/device/clock fault on the Pi', r.name, to_char(r.last_sample_at,'YYYY-MM-DD HH24:MI UTC')));
      end if;
      update alert_events e set resolved_at=now()
        where e.asset_id=r.id and e.kind='offline' and e.resolved_at is null;
    else
      if not exists (select 1 from alert_events e where e.asset_id=r.id and e.kind='offline' and e.resolved_at is null) then
        insert into alert_events (asset_id, kind, message)
        values (r.id, 'offline', format('%s offline — no report since %s', r.name, to_char(r.last_sample_at,'YYYY-MM-DD HH24:MI UTC')));
      end if;
      update alert_events e set resolved_at=now()
        where e.asset_id=r.id and e.kind='reporting_stalled' and e.resolved_at is null;
    end if;
  end loop;

  -- Resolve BOTH offline kinds once fresh telemetry is flowing again.
  update alert_events e set resolved_at=now()
  from assets a
  where e.asset_id=a.id and e.kind in ('offline','reporting_stalled') and e.resolved_at is null
    and a.last_sample_at >= now() - make_interval(mins => a.offline_threshold_minutes);

  -- SENSOR FAULT: a metric that reads blank on EVERY sample for an hour while
  -- the unit is otherwise reporting normally is a dead or absent sensor, not a
  -- measurement. Without this, nullify_sentinel() would turn a blind channel
  -- into a silent one — it would render as an em-dash on the dashboard forever
  -- and nobody would be told. Windowed on created_at (ingest time), so a device
  -- with a wrong clock is judged on when we received the sample, not on what it
  -- stamped. Requires >= 10 samples so a unit that just came up is not judged
  -- on one reading.
  for r in
    with reporting as (
      select a.id, a.name
      from assets a
      where a.maintenance = false
        and a.last_sample_at is not null
        and a.last_sample_at >= now() - make_interval(mins => a.offline_threshold_minutes)
    ),
    chan as (
      select rp.id as asset_id, rp.name, v.field,
             count(*) as n, count(v.val) as n_present
      from reporting rp
      join telemetry_samples t
        on t.asset_id = rp.id and t.created_at >= now() - interval '1 hour'
      cross join lateral (values
        ('he_lvl', t.he_lvl), ('he_press', t.he_press),
        ('h2o_flow', t.h2o_flow), ('h2o_temp', t.h2o_temp),
        ('shield', t.shield), ('cs1', t.cs1)
      ) as v(field, val)
      group by rp.id, rp.name, v.field
    )
    select asset_id, name, field, n, n_present from chan
  loop
    if r.n >= 10 and r.n_present = 0 then
      if not exists (select 1 from alert_events e
                     where e.asset_id = r.asset_id and e.kind = 'sensor_fault'
                       and e.channel = r.field and e.resolved_at is null) then
        insert into alert_events (asset_id, kind, channel, message)
        values (r.asset_id, 'sensor_fault', r.field,
          format('%s %s sensor is not reporting a value — the channel has read blank for the last hour while the unit is otherwise online', r.name, r.field));
      end if;
      -- A channel with no reading cannot support a value alarm either way.
      update alert_events e set resolved_at = now()
      from alert_rules ar
      where e.asset_id = r.asset_id and e.kind = 'threshold' and e.resolved_at is null
        and e.alert_rule_id = ar.id and ar.field = r.field;
    elsif r.n_present > 0 then
      update alert_events e set resolved_at = now()
      where e.asset_id = r.asset_id and e.kind = 'sensor_fault'
        and e.channel = r.field and e.resolved_at is null;
    end if;
  end loop;

  -- Threshold events on a unit whose data has gone stale are resolved. The
  -- offline / reporting_stalled event already says the unit is not reporting,
  -- and holding a value alarm against a reading that may be hours old asserts
  -- something we no longer know. Previously latest_telemetry was joined with no
  -- freshness test at all, so an offline unit's final reading was re-evaluated
  -- forever — a unit that went dark mid-breach held that alarm indefinitely.
  update alert_events e set resolved_at = now()
  from assets a
  where e.asset_id = a.id and e.kind = 'threshold' and e.resolved_at is null
    and (a.last_sample_at is null
         or a.last_sample_at < now() - make_interval(mins => a.offline_threshold_minutes));

  -- THRESHOLD / STATE with per-asset override (skip maintenance, skip stale)
  for r in
    with effective as (
      select distinct on (a.id, ar.field)
        a.id as asset_id, a.name, ar.id as rule_id, ar.field, ar.comparator, ar.threshold
      from assets a
      join alert_rules ar on (ar.asset_id = a.id or ar.asset_id is null)
      where ar.enabled and a.maintenance = false
        and a.last_sample_at is not null
        and a.last_sample_at >= now() - make_interval(mins => a.offline_threshold_minutes)
      order by a.id, ar.field, (ar.asset_id is not null) desc
    )
    select e.asset_id, e.name, e.rule_id, e.field, e.comparator, e.threshold,
      case e.field when 'he_lvl' then lt.he_lvl when 'he_press' then lt.he_press
        when 'h2o_flow' then lt.h2o_flow when 'h2o_temp' then lt.h2o_temp
        when 'shield' then lt.shield when 'cs1' then lt.cs1 end as value
    from effective e
    join latest_telemetry lt on lt.asset_id = e.asset_id
  loop
    -- A NULL reading is the ABSENCE of information: it neither opens nor
    -- resolves. Resolving on null is exactly what made NM1027 flap once the
    -- sentinel became NULL, and a persistently blank channel is already handled
    -- by the sensor-fault block above.
    if r.value is null then continue; end if;
    if (r.comparator='<' and r.value<r.threshold) or (r.comparator='<=' and r.value<=r.threshold)
    or (r.comparator='>' and r.value>r.threshold) or (r.comparator='>=' and r.value>=r.threshold)
    or (r.comparator='=' and r.value=r.threshold) or (r.comparator='!=' and r.value<>r.threshold) then
      if not exists (select 1 from alert_events e where e.alert_rule_id=r.rule_id and e.asset_id=r.asset_id and e.resolved_at is null) then
        insert into alert_events (asset_id, alert_rule_id, kind, message)
        -- cs1 carries a STATUS CODE, not a magnitude: "cs1 > 0 (now 11.0)"
        -- told an on-call engineer nothing, where 11 is "compressor stopped due
        -- to overheat" -- a different night entirely. Decoded here so both the
        -- email and the push carry it. Applied 2026-08-20 (migration
        -- decode_compressor_status_in_threshold_message).
        values (r.asset_id, r.rule_id, 'threshold', format('%s %s %s %s (now %s)%s', r.name, r.field, r.comparator, r.threshold, r.value,
                case when r.field = 'cs1' then ' -- ' || magmon_compressor_status_text(r.value) else '' end));
      end if;
    else
      update alert_events set resolved_at=now() where alert_rule_id=r.rule_id and asset_id=r.asset_id and resolved_at is null;
    end if;
  end loop;
end;
$function$;

-- Admin RPCs to manage alert rules (PIN-gated, same pattern as other admin_*).
CREATE OR REPLACE FUNCTION public.admin_list_alert_rules(p_actor_username text, p_actor_pin text)
 RETURNS TABLE(id uuid, asset_id uuid, asset_name text, field text, comparator text, threshold numeric, enabled boolean, created_at timestamptz)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then raise exception 'not authorized'; end if;
  return query
    select ar.id, ar.asset_id, a.name, ar.field, ar.comparator, ar.threshold, ar.enabled, ar.created_at
    from alert_rules ar
    left join assets a on a.id = ar.asset_id
    order by (ar.asset_id is not null), a.name nulls first, ar.field;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_upsert_alert_rule(p_actor_username text, p_actor_pin text, p_rule_id uuid, p_asset_id uuid, p_field text, p_comparator text, p_threshold numeric, p_enabled boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare v_id uuid;
begin
  if not is_admin(p_actor_username, p_actor_pin) then raise exception 'not authorized'; end if;
  if p_field not in ('he_lvl','he_press','h2o_flow','h2o_temp','shield','cs1') then
    raise exception 'unknown metric: %', p_field;
  end if;
  if p_comparator not in ('<','<=','>','>=','=','!=') then
    raise exception 'invalid comparator: %', p_comparator;
  end if;
  if p_rule_id is null then
    insert into alert_rules (asset_id, field, comparator, threshold, enabled)
    values (p_asset_id, p_field, p_comparator, p_threshold, coalesce(p_enabled, true))
    returning id into v_id;
  else
    update alert_rules
       set asset_id = p_asset_id, field = p_field, comparator = p_comparator,
           threshold = p_threshold, enabled = coalesce(p_enabled, true)
     where id = p_rule_id
     returning id into v_id;
  end if;
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_alert_rule(p_actor_username text, p_actor_pin text, p_rule_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then raise exception 'not authorized'; end if;
  delete from alert_rules where id = p_rule_id;
  return true;
end;
$function$;

-- Alert recipients CRUD + joined event-log reader (added 2026-08-12, migration
-- admin_alert_recipient_and_event_rpcs). alert_recipients has no public policy,
-- so it's reached only through these SECURITY DEFINER functions.
CREATE OR REPLACE FUNCTION public.admin_list_alert_recipients(p_actor_username text, p_actor_pin text)
 RETURNS TABLE(id uuid, channel text, address text, enabled boolean, created_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then raise exception 'not authorized'; end if;
  return query select r.id, r.channel, r.address, r.enabled, r.created_at
    from alert_recipients r order by r.channel, r.address;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_upsert_alert_recipient(p_actor_username text, p_actor_pin text, p_id uuid, p_channel text, p_address text, p_enabled boolean)
 RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $function$
declare v_id uuid;
begin
  if not is_admin(p_actor_username, p_actor_pin) then raise exception 'not authorized'; end if;
  if p_channel not in ('email','sms') then raise exception 'invalid channel: %', p_channel; end if;
  if btrim(coalesce(p_address, '')) = '' then raise exception 'address required'; end if;
  if p_id is null then
    insert into alert_recipients (channel, address, enabled)
    values (p_channel, btrim(p_address), coalesce(p_enabled, true)) returning id into v_id;
  else
    update alert_recipients set channel = p_channel, address = btrim(p_address), enabled = coalesce(p_enabled, true)
      where id = p_id returning id into v_id;
  end if;
  perform _record_audit(p_actor_username, 'upsert_alert_recipient', 'alert_recipient', v_id::text,
    format('%s recipient %s (%s)', case when p_id is null then 'Added' else 'Updated' end, p_address, p_channel));
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_alert_recipient(p_actor_username text, p_actor_pin text, p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then raise exception 'not authorized'; end if;
  delete from alert_recipients where id = p_id;
  perform _record_audit(p_actor_username, 'delete_alert_recipient', 'alert_recipient', p_id::text, 'Removed alert recipient');
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_list_alert_events(p_actor_username text, p_actor_pin text, p_limit integer DEFAULT 100)
 RETURNS TABLE(id bigint, asset_id uuid, asset_name text, kind text, message text, triggered_at timestamptz, resolved_at timestamptz, notified_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then raise exception 'not authorized'; end if;
  return query
    select e.id, e.asset_id, a.name, e.kind, e.message, e.triggered_at, e.resolved_at, e.notified_at
    from alert_events e join assets a on a.id = e.asset_id
    order by (e.resolved_at is null) desc, e.triggered_at desc
    limit least(coalesce(p_limit, 100), 500);
end;
$function$;

-- --- alert sender identity RPCs --------------------------------------
-- Migration alert_sender_identity_per_org (2026-08-18) replaced the PIN-era
-- pair documented here before (admin_alert_from_setting_rpcs, 2026-08-12),
-- which took (p_actor_username, p_actor_pin) and wrote ONE global
-- app_settings key. Two things changed: the actor is now a session token like
-- every other admin_* RPC, and the setting is per-company.
--
-- Who may change what is the point of the split. A company admin owns how
-- their alerts READ -- display name, Reply-To, subject prefix -- none of which
-- needs a DNS record anywhere. The ADDRESS is superadmin-only; see the orgs
-- column comments for why an unverified sender is worse than no setting.

-- Resolution order for an org, used by notify-alerts and send-push.
-- Supersedes org_alert_from(), which is left in place so a not-yet-redeployed
-- function keeps working.
CREATE OR REPLACE FUNCTION public.org_alert_identity(p_org_id uuid)
RETURNS TABLE(from_addr text, from_name text, reply_to text, subject_prefix text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select
    coalesce(o.alert_from, (select s.value from app_settings s where s.key = 'alert_from')),
    coalesce(o.alert_from_name, btrim(o.name || ' ' || coalesce(o.product_name, 'Magnet Monitor'))),
    o.alert_reply_to,
    coalesce(o.alert_subject_prefix, o.product_name, 'MagMon')
  from orgs o
  where o.id = p_org_id
$function$;

-- Anything bound for a mail header gets control characters stripped. Resend
-- takes JSON rather than raw SMTP, so this is not classic header injection --
-- but a newline in a display name still corrupts the rendered header, and
-- these fields are customer-editable.
CREATE OR REPLACE FUNCTION public._clean_header(p text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO ''
AS $function$
  select nullif(btrim(regexp_replace(coalesce(p, ''), '[[:cntrl:]]', ' ', 'g')), '')
$function$;

-- Returns the STORED values (so a blank field shows blank in the UI) next to
-- the derived defaults, which the admin page renders as placeholders -- an
-- admin can then see what "leave blank" will actually send.
CREATE OR REPLACE FUNCTION public.admin_get_alert_identity(p_token text)
RETURNS TABLE(from_addr text, from_name text, reply_to text, subject_prefix text,
              from_name_default text, subject_prefix_default text,
              platform_from text, is_superadmin boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor record; v_org record;
begin
  select * into v_actor from public._admin_actor(p_token);
  select * into v_org from orgs o where o.id = v_actor.org_id;
  return query select
    v_org.alert_from, v_org.alert_from_name, v_org.alert_reply_to, v_org.alert_subject_prefix,
    btrim(v_org.name || ' ' || coalesce(v_org.product_name, 'Magnet Monitor')),
    coalesce(v_org.product_name, 'MagMon'),
    (select s.value from app_settings s where s.key = 'alert_from'),
    v_actor.is_superadmin;
end;
$function$;

-- The self-serve half: any company admin, no DNS involved.
CREATE OR REPLACE FUNCTION public.admin_set_alert_identity(
  p_token text, p_from_name text, p_reply_to text, p_subject_prefix text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor record; v_name text; v_reply text; v_prefix text;
begin
  select * into v_actor from public._admin_actor(p_token);
  v_name   := public._clean_header(p_from_name);
  v_reply  := public._clean_header(p_reply_to);
  v_prefix := public._clean_header(p_subject_prefix);
  -- A single bare address: a display name here would be double-wrapped by the
  -- sender, and a comma would split it in two.
  if v_reply is not null and v_reply !~ '^[^@[:space:],<>]+@[^@[:space:],<>]+\.[^@[:space:],<>]+$' then
    raise exception 'Reply-To must be a single plain email address, with no name attached.';
  end if;
  -- 78 keeps the composed From header inside the RFC 5322 line limit.
  if length(coalesce(v_name, '')) > 78 then
    raise exception 'Sender name is too long (78 characters max).';
  end if;
  if length(coalesce(v_prefix, '')) > 40 then
    raise exception 'Subject prefix is too long (40 characters max).';
  end if;
  update orgs set alert_from_name = v_name, alert_reply_to = v_reply, alert_subject_prefix = v_prefix
   where id = v_actor.org_id;
  perform _record_audit(v_actor.username, 'set_alert_identity', 'app', 'alert_identity',
    format('Sender identity set (name %s, reply-to %s, prefix %s)',
           coalesce(v_name, 'default'), coalesce(v_reply, 'none'), coalesce(v_prefix, 'default')),
    v_actor.org_id);
  return true;
end;
$function$;

-- Superadmin-only, and now a BARE address: the display name is attached at send
-- time from alert_from_name, so a full "Name <addr>" here would be double-wrapped.
CREATE OR REPLACE FUNCTION public.admin_set_alert_from(p_token text, p_from text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor record; v_from text;
begin
  select * into v_actor from public._admin_actor(p_token);
  if not v_actor.is_superadmin then
    raise exception 'Only Numed can change the sending address. Set the sender name and Reply-To instead.';
  end if;
  v_from := public._clean_header(p_from);
  if v_from is not null and v_from !~ '^[^@[:space:],<>]+@[^@[:space:],<>]+\.[^@[:space:],<>]+$' then
    raise exception 'Sending address must be a single plain email address, with no name attached.';
  end if;
  update orgs set alert_from = v_from where id = v_actor.org_id;
  perform _record_audit(v_actor.username, 'set_alert_from', 'app', 'alert_from',
    case when v_from is null
         then 'Cleared per-company sending address (revert to the platform address)'
         else format('Per-company sending address set to %s', v_from) end,
    v_actor.org_id);
  return true;
end;
$function$;

-- The platform-wide default every company inherits. This value used to live
-- ONLY in the ALERT_FROM edge-function secret, where nobody could read it --
-- which is how "who sends our alerts?" became a question you could only answer
-- by opening a received email and reading its headers.
CREATE OR REPLACE FUNCTION public.admin_set_platform_alert_from(p_token text, p_from text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
declare v_actor record; v_from text;
begin
  select * into v_actor from public._admin_actor(p_token);
  if not v_actor.is_superadmin then raise exception 'Not authorized.'; end if;
  v_from := public._clean_header(p_from);
  if v_from is null then
    delete from app_settings where key = 'alert_from';
    perform _record_audit(v_actor.username, 'set_platform_alert_from', 'app', 'alert_from',
      'Cleared the platform sending address (revert to the ALERT_FROM secret)', v_actor.org_id);
    return true;
  end if;
  if v_from !~ '^[^@[:space:],<>]+@[^@[:space:],<>]+\.[^@[:space:],<>]+$' then
    raise exception 'Sending address must be a single plain email address, with no name attached.';
  end if;
  insert into app_settings (key, value) values ('alert_from', v_from)
    on conflict (key) do update set value = excluded.value;
  perform _record_audit(v_actor.username, 'set_platform_alert_from', 'app', 'alert_from',
    format('Platform sending address set to %s', v_from), v_actor.org_id);
  return true;
end;
$function$;

-- EXECUTE defaults to the PUBLIC pseudo-role on a fresh function, so each of
-- these is locked down explicitly (see the ACL note at the top of this file).
revoke execute on function public._clean_header(text)                              from public, anon, authenticated;
revoke execute on function public.org_alert_identity(uuid)                         from public, anon, authenticated;
revoke execute on function public.admin_get_alert_identity(text)                   from public, anon, authenticated;
revoke execute on function public.admin_set_alert_identity(text, text, text, text) from public, anon, authenticated;
-- admin_set_alert_from changed SIGNATURE here (the PIN pair became a token), so
-- this is a NEW function to Postgres, not a replaced one -- it starts with the
-- default PUBLIC grant no matter what the old one was locked down to.
revoke execute on function public.admin_set_alert_from(text, text)                 from public, anon, authenticated;
revoke execute on function public.admin_set_platform_alert_from(text, text)        from public, anon, authenticated;
grant  execute on function public.org_alert_identity(uuid)                         to service_role;
grant  execute on function public.admin_get_alert_identity(text)                   to service_role;
grant  execute on function public.admin_set_alert_identity(text, text, text, text) to service_role;
grant  execute on function public.admin_set_alert_from(text, text)                 to service_role;
grant  execute on function public.admin_set_platform_alert_from(text, text)        to service_role;


-- =====================================================================
-- AUDIT LOG (added 2026-08-10)
-- =====================================================================
-- Applied via migrations `add_audit_log` and `instrument_admin_rpcs_audit`.
-- Records auth events (login/logout/failed) and every admin mutation. Rows are
-- written only from inside SECURITY DEFINER functions, so the client cannot
-- bypass or forge them, and are read back through admin_list_audit_log.
--
-- NOTE: every admin_* mutation RPC above (create/update/delete for
-- assets, users, alert rules, plus reset_pin, set_role, set_invite_code, and
-- rotate_gateway_token) was amended to call `perform _record_audit(...)` after
-- its write. Only the audit line was added; those bodies are otherwise
-- unchanged. `supabase db dump` remains the byte-exact source for them.

create table if not exists public.audit_log (
  id          bigint      generated always as identity primary key,
  actor       text,                          -- username of the acting user (null = system)
  action      text        not null,          -- e.g. 'login','create_asset','delete_site'
  entity_type text,                          -- 'auth','site','asset','user','alert_rule','app'
  entity_id   text,                          -- uuid/name of the affected row, when applicable
  detail      text,                          -- human-readable summary
  created_at  timestamptz not null default now(),
  -- Nullable, unlike assets/alert_rules: historical rows predate orgs. New
  -- rows get the default so admin_list_audit_log can scope per tenant.
  org_id      uuid        default public.default_org_id() references public.orgs(id)
);
create index if not exists idx_audit_log_created_at on public.audit_log using btree (created_at desc);
create index if not exists audit_log_org_id_idx on public.audit_log (org_id);

-- Internal writer. Execute is revoked from the API roles so it cannot be called
-- directly to forge rows; the SECURITY DEFINER callers reach it as the owner.
CREATE OR REPLACE FUNCTION public._record_audit(p_actor text, p_action text, p_entity_type text, p_entity_id text, p_detail text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into audit_log (actor, action, entity_type, entity_id, detail)
  values (p_actor, p_action, p_entity_type, p_entity_id, p_detail);
end;
$function$;
revoke execute on function public._record_audit(text, text, text, text, text) from anon, authenticated, public;

-- Session events. Verifies credentials so the actor can't be spoofed. Called by
-- the client on a real sign-in/sign-out, NOT on the silent re-verify each page
-- load performs (which would otherwise log a "login" on every refresh).
CREATE OR REPLACE FUNCTION public.log_session_event(p_username text, p_pin text, p_event text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if p_event not in ('login','logout') then
    raise exception 'invalid session event';
  end if;
  if not exists (
    select 1 from users where username = p_username and pin_hash = extensions.crypt(p_pin, pin_hash)
  ) then
    raise exception 'invalid credentials';
  end if;
  perform _record_audit(p_username, p_event, 'auth', null,
    case when p_event = 'login' then 'Signed in' else 'Signed out' end);
  return true;
end;
$function$;

-- Failed sign-in. Recorded client-side after verify_user_login rejects the
-- attempt — that function raises, rolling back anything it wrote, so the
-- failure must be its own committed transaction. The username is the
-- (unverified) value that was tried.
CREATE OR REPLACE FUNCTION public.record_login_failure(p_username text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform _record_audit(nullif(p_username, ''), 'login_failed', 'auth', null,
    format('Failed sign-in attempt for "%s"', coalesce(nullif(p_username, ''), '(blank)')));
  return true;
end;
$function$;

-- Admin-gated reader for the activity log.
CREATE OR REPLACE FUNCTION public.admin_list_audit_log(p_actor_username text, p_actor_pin text, p_limit integer DEFAULT 200)
 RETURNS TABLE(id bigint, actor text, action text, entity_type text, entity_id text, detail text, created_at timestamptz)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  return query
    select a.id, a.actor, a.action, a.entity_type, a.entity_id, a.detail, a.created_at
    from audit_log a
    order by a.created_at desc
    limit least(coalesce(p_limit, 200), 1000);
end;
$function$;


-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
-- RLS is enabled on every table. Tables with NO policy (users, assets,
-- app_settings, audit_log) are therefore unreadable/unwritable directly — they
-- are reached only through the SECURITY DEFINER functions and views above.
-- The "public read" policies expose SELECT to everyone (see F-1).

alter table public.users             enable row level security;
alter table public.app_settings      enable row level security;
alter table public.assets            enable row level security;
alter table public.telemetry_samples enable row level security;
alter table public.alert_rules       enable row level security;
alter table public.alert_events      enable row level security;
alter table public.alert_recipients  enable row level security;  -- no policy: SECURITY DEFINER / service_role only
alter table public.audit_log         enable row level security;  -- no policy: SECURITY DEFINER only (written by _record_audit, read by admin_list_audit_log)

-- Multi-tenant tables: RLS on, deliberately NO policy, and the API roles are
-- revoked outright. user_sessions must never be anon-readable (it would hand
-- out session tokens), and orgs / org_members would otherwise let anyone
-- enumerate every tenant and its members. Reached only via SECURITY DEFINER
-- RPCs and the server-side service-role client.
alter table public.orgs              enable row level security;
alter table public.org_members       enable row level security;
alter table public.user_sessions     enable row level security;
revoke all on public.orgs          from anon, authenticated;
revoke all on public.org_members   from anon, authenticated;
revoke all on public.user_sessions from anon, authenticated;
-- display_tokens holds screen credentials (hashed, but still one row per live
-- screen), so it gets the same treatment as user_sessions: RLS on, no policy,
-- and no reach for anon/authenticated at all.
alter table public.display_tokens    enable row level security;
revoke all on public.display_tokens from anon, authenticated;

-- The three "public read" policies that used to live here are GONE, dropped by
-- phase2_close_public_reads (2026-08-17). For the record, they were:
--   create policy "public read telemetry"    on telemetry_samples for select to public using (true);
--   create policy "public read alert_rules"  on alert_rules       for select to public using (true);
--   create policy "public read alert_events" on alert_events      for select to public using (true);
--
-- Nothing replaces them. telemetry_samples, alert_rules and alert_events now
-- have RLS enabled with NO policy, exactly like assets and users: unreachable
-- for anon, and read only by the server through lib/fleetQueries.ts, which
-- filters every query by the session's active org.
--
-- Do NOT add a policy here to "restore" client reads. Tenant scoping lives in
-- the server query layer; a permissive policy would silently reopen the
-- cross-tenant leak that this whole migration exists to close.

-- =====================================================================
-- GRANTS
-- =====================================================================
-- CORRECTION (2026-08-17, migration revoke_anon_write_grants): this section
-- previously said "the security boundary is the POLICY set, not the GRANTs".
-- That is FALSE for views. public_assets and latest_telemetry were created
-- WITHOUT security_invoker, so they execute with the view owner's rights and
-- bypass the underlying tables' RLS entirely. Measured: anon sees 0 rows in
-- public.assets (RLS on, no policy) but 17 through public_assets.
--
-- public_assets is a simple single-base-table view and therefore
-- auto-updatable — `delete from public_assets` does not raise the "cannot
-- delete from view" error that latest_telemetry does. Combined with anon
-- holding Supabase's default INSERT/UPDATE/DELETE grants, the publishable
-- anon key (which ships in the JS bundle) could modify or delete assets.
--
-- All write grants are now revoked from anon and authenticated on every
-- table plus both views. Verified afterwards: reads still return 17 rows and
-- 27k samples (the live app depends on them until Phase 2), all three write
-- probes return "permission denied", and collector ingest kept flowing.
--
-- Nothing in the app wrote as anon: mutations go through SECURITY DEFINER
-- RPCs (admin_*, report_telemetry*), the Pis authenticate with a per-asset
-- gateway_token, and the edge functions use the service role. The
-- `authenticated` role is unused — this app has never used Supabase Auth.
revoke insert, update, delete, truncate, references, trigger
  on public.assets, public.telemetry_samples, public.alert_rules,
     public.alert_events, public.users, public.app_settings,
     public.audit_log, public.alert_recipients, public.push_subscriptions,
     public.dm_webhook_events, public.public_assets, public.latest_telemetry
  from anon, authenticated;

-- Anon can read NO table at all. phase2_close_public_reads did the fleet tables;
-- phase6e finished the job (users, app_settings, audit_log, alert_recipients,
-- push_subscriptions, dm_webhook_events). Those six already returned 0 rows via
-- RLS-with-no-policy — including app_settings, which holds the VAPID private
-- key, the DM webhook key and the Tailscale OAuth secret, so nothing was
-- exposed. They were revoked because an empty result and a refusal look
-- identical to a caller: a forgotten client-side read would render "no data"
-- rather than failing, which is how a bug hides.
--
-- Anon's entire remaining surface is the collector RPCs (report_telemetry,
-- report_telemetry_batch — the 17 Pis) and the self-service auth RPCs
-- (register_user, update_own_username, save/delete_push_subscription,
-- get_vapid_public_key).
--
-- SELECT on the fleet tables was revoked by phase2_close_public_reads, applied 2026-08-17
-- after production (8cdf351) was verified serving Phase 2. Reads all go through
-- lib/fleetQueries.ts on the server via the service role.
revoke select on public.assets            from anon, authenticated;
revoke select on public.telemetry_samples  from anon, authenticated;
revoke select on public.alert_rules        from anon, authenticated;
revoke select on public.alert_events       from anon, authenticated;
revoke select on public.public_assets      from anon, authenticated;
revoke select on public.latest_telemetry    from anon, authenticated;

-- Function EXECUTE. Note the PUBLIC pseudo-role: Postgres grants EXECUTE on
-- functions to PUBLIC by default (ACL shows as a bare "=X/postgres"), and anon
-- INHERITS it — so "revoke ... from anon" alone is a NO-OP. The first attempt at
-- this left asset_telemetry_15min fully callable; always revoke from `public`
-- as well. Applied by phase2_revoke_public_execute_on_legacy_auth_rpcs.
--
-- asset_telemetry_15min took an asset uuid and no org context, so while it was
-- open, any uuid holder could read that asset's history across tenants.
revoke execute on function public.asset_telemetry_15min(uuid, integer)
  from public, anon, authenticated;
grant  execute on function public.asset_telemetry_15min(uuid, integer) to service_role;

-- Legacy auth RPCs, unused since login moved to create_session. Leaving
-- verify_user_login anon-callable kept F-4 (PIN brute force) open even after
-- login moved server-side. reset_own_pin calls verify_user_login internally and
-- is unaffected — it is SECURITY DEFINER, so the nested call runs as the owner.
revoke execute on function public.verify_user_login(text, text)
  from public, anon, authenticated;
revoke execute on function public.record_login_failure(text)
  from public, anon, authenticated;
revoke execute on function public.log_session_event(text, text, text)
  from public, anon, authenticated;
grant  execute on function public.verify_user_login(text, text) to service_role;

-- STILL GRANTED TO ANON, DELIBERATELY: report_telemetry and
-- report_telemetry_batch. The 17 collector Pis call them with the publishable
-- key plus a per-asset gateway_token. Revoking either stops fleet ingest.
-- Verified after the lockdown: has_function_privilege('anon', ...) = true for
-- both, and ingest continued (10 rows from 8 assets in the next 3 minutes).


-- =====================================================================
-- SEED — fleet-wide alert defaults (global rules; asset_id NULL)
-- =====================================================================
-- The confirmed starting thresholds. Per-asset overrides and the compressor
-- rule are added through the admin Alerts UI. Idempotent (skips if present).
insert into public.alert_rules (asset_id, field, comparator, threshold, enabled)
select v.asset_id, v.field, v.comparator, v.threshold, v.enabled
from (values
  (null::uuid, 'he_lvl',   '<',  50::numeric,  true),  -- helium low; matches TV amber warning (warn <50 / crit <30 in FAULT_THRESHOLDS; server is single-tier per field so it notifies at the warn level). Retuned 40->50 on 2026-08-12.
  (null::uuid, 'he_press', '>',  3.0::numeric, true),
  (null::uuid, 'h2o_flow', '<',  0.6::numeric, true),
  (null::uuid, 'h2o_temp', '>',  75::numeric,  true),
  (null::uuid, 'shield',   '>',  80::numeric,  true),
  (null::uuid, 'cs1',      '>',  0::numeric,   true)   -- compressor: 0 = ON (normal), >0 = OFF (alarm)
) as v(asset_id, field, comparator, threshold, enabled)
where not exists (
  select 1 from public.alert_rules ar where ar.asset_id is null and ar.field = v.field
);

-- --- per-asset overrides (name-keyed so a rebuild restores them) -----
-- NM1035 legitimately runs an elevated He-pressure band (~3.2-3.9 psi vs the
-- ~1.0 fleet), so the fleet-wide he_press > 3.0 rule false-alarmed it. This
-- per-asset ceiling (>4.5) supersedes the global rule for NM1035 in both the
-- TV fault model (lib/faults.ts) and the server evaluator (per-asset beats
-- fleet-wide). Added 2026-08-12. Idempotent.
insert into public.alert_rules (asset_id, field, comparator, threshold, enabled)
select a.id, 'he_press', '>', 4.5::numeric, true
from public.assets a
where a.name = 'NM1035'
  and not exists (
    select 1 from public.alert_rules ar where ar.asset_id = a.id and ar.field = 'he_press'
  );


-- =====================================================================
-- WEB PUSH (browser / PWA notifications) — added 2026-08-12
-- =====================================================================
-- VAPID keypair lives in app_settings (keys 'vapid_public' / 'vapid_private'),
-- generated once by the vapid-keygen edge function (Web Crypto P-256). The
-- private key stays server-side; the public key is exposed to the client via
-- get_vapid_public_key(). alert_events gained a push_notified_at column so push
-- delivery tracks independently of email's notified_at. Migrations:
-- push_subscriptions_and_rpcs, alert_events_push_notified_at.

create table if not exists public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  username     text,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;  -- no public policy: SECURITY DEFINER RPCs only

-- Upsert a device subscription (self-serve; the dashboard toggle is behind login).
CREATE OR REPLACE FUNCTION public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_username text DEFAULT NULL, p_user_agent text DEFAULT NULL)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  insert into push_subscriptions (endpoint, p256dh, auth, username, user_agent)
  values (p_endpoint, p_p256dh, p_auth, p_username, p_user_agent)
  on conflict (endpoint) do update
    set p256dh = excluded.p256dh, auth = excluded.auth,
        username = coalesce(excluded.username, push_subscriptions.username),
        user_agent = excluded.user_agent, last_seen_at = now();
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_push_subscription(p_endpoint text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  delete from push_subscriptions where endpoint = p_endpoint;
  return true;
end;
$function$;

-- The VAPID public key is not secret; expose it so the client can subscribe.
CREATE OR REPLACE FUNCTION public.get_vapid_public_key()
 RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' STABLE
AS $function$ select value from app_settings where key = 'vapid_public'; $function$;


-- =====================================================================
-- SCHEDULED JOBS (pg_cron)
-- =====================================================================
-- Live jobs as of 2026-08-12:
--   jobid 1  cleanup_old_telemetry  '0 3 * * *'  delete telemetry_samples > 7 days
--   jobid 2  evaluate-alerts        '* * * * *'  select public.evaluate_alerts()
--   jobid 3  notify-alerts          '* * * * *'  net.http_post -> notify-alerts edge fn
--   jobid 4  send-push              '* * * * *'  net.http_post -> send-push edge fn
--   jobid 5  tailscale-poll         '*/5 * * * *' net.http_post -> tailscale-poll edge fn
-- tailscale-poll (added 2026-08-13) reads each collector Pi's Tailscale node
-- liveness from the Tailscale API (OAuth client creds in app_settings keys
-- ts_oauth_client_id / ts_oauth_secret / ts_tailnet) and stamps
-- assets.tailscale_online. Matches only os=linux devices whose name embeds the
-- asset code (the tailnet also holds Windows site PCs named after the same
-- assets). Connectivity is INFORMATIONAL only — shown as a chip on the
-- dashboard/asset page; it never opens an alert_event and never emails/pushes.
-- Same for the iR305/DM signal (dm-webhook stamps assets.router_online).
--   select cron.schedule('tailscale-poll', '*/5 * * * *', $$
--     select net.http_post(
--       url := 'https://wxygirzfxutvtfkxxcvw.supabase.co/functions/v1/tailscale-poll',
--       headers := jsonb_build_object('Content-Type','application/json')
--     );
--   $$);
-- evaluate-alerts (Phase 1) opens/resolves alert_events. notify-alerts (Phase 3,
-- added 2026-08-12) invokes the edge function over pg_net; the function emails
-- new open events (debounced ALERT_DEBOUNCE_MINUTES, default 5) via Resend to
-- alert_recipients, then stamps notified_at. Requires the pg_net extension and
-- the RESEND_API_KEY + ALERT_FROM edge-function secrets.
-- send-push (added 2026-08-12) is the web-push companion: same debounce, sends a
-- browser/PWA notification for new open events to every push_subscriptions row,
-- stamps push_notified_at, and prunes expired (404/410) endpoints. Uses the VAPID
-- keys in app_settings (vapid_public / vapid_private).
--
-- To (re)create the schedules:
--   select cron.schedule('evaluate-alerts', '* * * * *', $$ select public.evaluate_alerts(); $$);
--   select cron.schedule('notify-alerts', '* * * * *', $$
--     select net.http_post(
--       url := 'https://wxygirzfxutvtfkxxcvw.supabase.co/functions/v1/notify-alerts',
--       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <ANON_KEY>')
--     );
--   $$);
-- To remove: select cron.unschedule('evaluate-alerts');  select cron.unschedule('notify-alerts');
-- pg_net enabled 2026-08-12 via migration enable_pg_net_for_alert_notifier.


-- ═══════════════════════════════════════════════════════════════════════
-- DIAGNOSTICS  (applied to the live DB 2026-08-19)
--
-- Everything below turns the app from a threshold monitor into something that
-- reasons about the data. The prompt was a fleet health check that found the
-- two alarm systems disagreeing (see lib/faults.ts) and a phantom alert held
-- open for a week by a dead sensor.
--
-- Migrations, in order:
--   telemetry_daily_rollups
--   alert_severity_acknowledgement_engineer_role
--   acknowledge_alert_session_token_and_disposition
--   diagnostic_bounds_and_finding_helpers
--   evaluate_diagnostics
--   evaluate_diagnostics_numeric_casts
--   demo_coldhead_jitter_and_unruled_bounds
--   cooling_loss_null_is_not_recovery
--   cooling_loss_uses_latest_real_reading
-- ═══════════════════════════════════════════════════════════════════════

-- --- telemetry_daily: long-horizon history ---------------------------
-- telemetry_samples is purged after 7 days, which is right for raw minute data
-- but makes slow degradation structurally invisible: you cannot project six days
-- out from seven days of history. One aggregated row per asset per channel per
-- day, kept ~400 days — a few MB against ~55k raw rows for a single week.
--
-- Long format (channel as a value, not a column) so the evaluator can iterate
-- channels generically and a new channel needs no DDL. `coldhead` is included
-- even though it has no typed column: it lives in the raw blob and is the best
-- early indicator of a cold-head or compressor problem.
create table if not exists public.telemetry_daily (
  asset_id uuid    not null references public.assets(id) on delete cascade,
  day      date    not null,
  channel  text    not null,
  n        integer not null,
  min_v    numeric,
  avg_v    numeric,
  max_v    numeric,
  primary key (asset_id, day, channel)
);
create index if not exists telemetry_daily_asset_channel_day_idx
  on public.telemetry_daily (asset_id, channel, day);
alter table public.telemetry_daily enable row level security;

-- --- alert_events: severity, acknowledgement, evidence ----------------
alter table public.alert_events
  add column if not exists severity text not null default 'warning'
    check (severity in ('warning','critical')),
  add column if not exists acknowledged_at timestamptz,
  add column if not exists acknowledged_by text,
  add column if not exists ack_note text,
  add column if not exists detail jsonb,
  add column if not exists disposition text
    check (disposition in ('accepted','ignored','false_alarm'));

-- 'engineer' sits between viewer and admin: may acknowledge and annotate
-- alerts, may not change companies, users, rules or tokens.
alter table public.org_members drop constraint if exists org_members_role_check;
alter table public.org_members add constraint org_members_role_check
  check (role in ('admin','engineer','viewer'));

-- --- diagnostic_bounds: one copy of the physical envelope -------------
-- These numbers previously existed twice and disagreed: FAULT_THRESHOLDS in
-- lib/faults.ts (client, cards + TV) and alert_rules rows (server, email).
-- Coldhead was only in the first and water only in the second, which is exactly
-- why NM1028 showed a warm coldhead that emailed nobody while NM1006 emailed
-- about water with a green card. alert_rules is unchanged and still drives
-- simple threshold email; this is the envelope a DIAGNOSIS reasons against, and
-- it covers channels (coldhead) that have no column to write a rule on.
create table if not exists public.diagnostic_bounds (
  channel        text primary key,
  label          text not null,
  unit           text not null default '',
  warn_above     numeric,
  critical_above numeric,
  warn_below     numeric,
  critical_below numeric,
  sane_min       numeric,
  sane_max       numeric
);
insert into public.diagnostic_bounds
  (channel, label, unit, warn_above, critical_above, warn_below, critical_below, sane_min, sane_max)
values
  ('coldhead', 'Coldhead',    'K',    6,    20,   null, null,  0,    400),
  ('shield',   'Shield',      'K',   60,    80,   null, null,  0,    400),
  ('h2o_temp', 'Water temp',  '°F',  75,    90,   null, null, -40,   250),
  ('h2o_flow', 'Water flow',  'gpm', null,  null, 0.6,  0.2,   0,    100),
  ('he_lvl',   'Helium',      '%',   90,    null, 50,   30,    0,    110),
  ('he_press', 'He pressure', 'psi',  3,     4.5, 0,    null, -5,     50)
on conflict (channel) do nothing;
alter table public.diagnostic_bounds enable row level security;

-- --- rollup + retention ----------------------------------------------
-- Numeric-looking text only. The raw blob is device-authored and a malformed
-- coldhead value must yield NULL, not abort the whole night's rollup.
create or replace function public.safe_numeric(p text)
returns numeric language sql immutable as $function$
  select case when p ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then p::numeric else null end;
$function$;

-- Buckets on recorded_at (true reading time), consistent with
-- asset_telemetry_15min; the clock-skew net in report_telemetry_batch already
-- rebases a grossly-wrong device clock before storage. Idempotent upsert over a
-- trailing window, so re-runs and a late backfill both settle. Scheduled 02:30,
-- deliberately BEFORE the 03:00 raw purge.
create or replace function public.rollup_telemetry_daily(p_days integer default 2)
returns integer language plpgsql security definer set search_path to 'public'
as $function$
declare v_rows integer;
begin
  insert into telemetry_daily (asset_id, day, channel, n, min_v, avg_v, max_v)
  select t.asset_id, (t.recorded_at at time zone 'UTC')::date, v.channel,
         count(v.val), min(v.val), avg(v.val), max(v.val)
  from telemetry_samples t
  cross join lateral (values
    ('he_lvl', t.he_lvl), ('he_press', t.he_press),
    ('h2o_flow', t.h2o_flow), ('h2o_temp', t.h2o_temp),
    ('shield', t.shield), ('cs1', t.cs1),
    ('coldhead', coalesce(safe_numeric(t.data->>'ColdheadRuO'),
                          safe_numeric(t.data->>'Coldhead'),
                          safe_numeric(t.data->>'ColdHead')))
  ) as v(channel, val)
  where t.recorded_at >= now() - make_interval(days => p_days)
    and v.val is not null
  group by 1, 2, 3
  on conflict (asset_id, day, channel) do update
    set n = excluded.n, min_v = excluded.min_v,
        avg_v = excluded.avg_v, max_v = excluded.max_v;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$function$;

create or replace function public.cleanup_old_rollups()
returns void language sql security definer set search_path to 'public'
as $function$
  delete from telemetry_daily where day < (now() at time zone 'UTC')::date - 400;
$function$;

-- --- engineer actor + acknowledgement ---------------------------------
-- Mirrors _admin_actor but admits 'engineer' as well as 'admin'. Superadmins
-- resolve to 'admin' in resolve_session, and a disabled org yields a null
-- active_org there, so a suspended company cannot acknowledge through this.
create or replace function public._engineer_actor(p_token text)
returns table(user_id uuid, username text, org_id uuid)
language plpgsql security definer set search_path to 'public'
as $function$
declare v_row record;
begin
  select r.user_id, r.username, r.active_org, r.effective_role into v_row
  from public.resolve_session(p_token) r;
  if v_row.user_id is null then raise exception 'not authenticated'; end if;
  if v_row.effective_role is distinct from 'admin'
     and v_row.effective_role is distinct from 'engineer' then
    raise exception 'not authorized';
  end if;
  if v_row.active_org is null then raise exception 'no active organization'; end if;
  return query select v_row.user_id, v_row.username, v_row.active_org;
end;
$function$;

-- Acknowledge an open alert: "seen, I own this."
-- Deliberately does NOT resolve or hide the event — the unit is still faulted
-- and still reads as faulted. What changes is that it stops paging. Escalation
-- re-arms it (see _upsert_finding), so acking a warning never silences the
-- critical it later becomes.
create or replace function public.acknowledge_alert(
  p_token text, p_event_id bigint,
  p_disposition text default 'accepted', p_note text default null
) returns boolean language plpgsql security definer set search_path to 'public'
as $function$
declare v_actor record;
begin
  select * into v_actor from public._engineer_actor(p_token);
  if p_disposition is not null
     and p_disposition not in ('accepted','ignored','false_alarm') then
    raise exception 'invalid disposition';
  end if;
  update alert_events e
     set acknowledged_at = now(), acknowledged_by = v_actor.username,
         disposition = coalesce(p_disposition, 'accepted'),
         ack_note = coalesce(p_note, e.ack_note)
    from assets a
   where e.id = p_event_id and e.asset_id = a.id
     and a.org_id = v_actor.org_id and e.resolved_at is null;
  return found;
end;
$function$;

create or replace function public.unacknowledge_alert(p_token text, p_event_id bigint)
returns boolean language plpgsql security definer set search_path to 'public'
as $function$
declare v_actor record;
begin
  select * into v_actor from public._engineer_actor(p_token);
  update alert_events e
     set acknowledged_at = null, acknowledged_by = null,
         disposition = null, ack_note = null
    from assets a
   where e.id = p_event_id and e.asset_id = a.id
     and a.org_id = v_actor.org_id and e.resolved_at is null;
  return found;
end;
$function$;

revoke execute on function public._engineer_actor(text) from anon, authenticated;
revoke execute on function public.acknowledge_alert(text, bigint, text, text) from anon;
revoke execute on function public.unacknowledge_alert(text, bigint) from anon;
grant execute on function public.acknowledge_alert(text, bigint, text, text) to authenticated, service_role;
grant execute on function public.unacknowledge_alert(text, bigint) to authenticated, service_role;

-- --- finding lifecycle ------------------------------------------------
-- Opens a finding, or updates the one already open for this (asset, kind,
-- channel). Escalation is the interesting case: a warning somebody acknowledged
-- must never silence the critical it turns into, so crossing UP re-arms the
-- event — clears the ack AND clears notified_at, which is all the existing
-- notifier needs to pick it up again (it sends anything open, unresolved and
-- not yet notified). No notifier change required. De-escalation keeps the ack:
-- someone already owns it and it is improving.
create or replace function public._upsert_finding(
  p_asset uuid, p_kind text, p_channel text,
  p_severity text, p_message text, p_detail jsonb
) returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_id bigint;
  v_sev text;
  -- Findings that are recorded and displayed but never notified. Handled HERE
  -- rather than in the two notifiers because "does this page a person" is a
  -- property of the finding, not of the transport — and it keeps notify-alerts
  -- and send-push identical instead of teaching both the same list. The
  -- mechanism is the one the notifier already uses for muted orgs: stamp
  -- notified_at at insert, meaning "there is nobody this should be sent to".
  v_non_paging constant text[] := array['anomaly'];
  v_silent boolean := p_kind = any(v_non_paging);
begin
  select id, severity into v_id, v_sev
  from alert_events
  where asset_id = p_asset and kind = p_kind
    and channel is not distinct from p_channel and resolved_at is null
  limit 1;

  if v_id is null then
    insert into alert_events (asset_id, kind, channel, severity, message, detail,
                              notified_at, push_notified_at)
    values (p_asset, p_kind, p_channel, p_severity, p_message, p_detail,
            case when v_silent then now() end,
            case when v_silent then now() end);
    return;
  end if;

  -- Escalation re-arms the alert: a warning somebody acknowledged must not
  -- silence the critical it becomes. Clearing notified_at is what makes the
  -- existing notifier pick it up again. A non-paging kind is NOT re-armed —
  -- re-arming it would page, which is the one thing it must never do.
  if p_severity = 'critical' and v_sev is distinct from 'critical' and not v_silent then
    update alert_events
       set severity = 'critical', message = p_message, detail = p_detail,
           notified_at = null, push_notified_at = null,
           acknowledged_at = null, acknowledged_by = null, disposition = null
     where id = v_id;
  else
    -- De-escalation keeps the ack: someone already owns it and it is improving.
    update alert_events set severity = p_severity, message = p_message, detail = p_detail
     where id = v_id;
  end if;
end;
$function$;

create or replace function public._resolve_finding(p_asset uuid, p_kind text, p_channel text)
returns void language sql security definer set search_path to 'public'
as $function$
  update alert_events set resolved_at = now()
   where asset_id = p_asset and kind = p_kind
     and channel is not distinct from p_channel and resolved_at is null;
$function$;

-- --- MagMon device code tables ---------------------------------------
-- APPLIED to live DB 2026-08-20 (migration magmon_device_code_tables).
-- Mirrored for the browser in lib/magmonCodes.ts -- the asset page decodes the
-- raw EC1-EC4 columns client-side and must not round-trip for a lookup. The SQL
-- side here is the source of truth; keep the two in step.
-- MagMon device code tables, transcribed from the device's own help pages
-- (http://<device>/errors_help.html and /minlog_help.html). Captured from
-- NM1027 on 2026-08-20. Until now we had neither table and said so in the
-- findings ("the MagMon code list would say what it means"); we have it now.
--
-- Transcribed VERBATIM, including the vendor's own apparent typo at 51/52
-- (both read "Recondensor Si410 (2A) cable disconnected"; 52 is presumably 2B).
-- Left as published rather than silently corrected -- if a unit ever raises 52
-- we want to match what the device's own page tells the engineer standing at it.
create or replace function public.magmon_error_text(p_code numeric)
returns text
language sql
immutable
as $function$
  select coalesce(
    (select d from (values
      (0,  'No error'),
      (1,  'He level too high'),
      (2,  'He level too low'),
      (3,  'He level top too high'),
      (4,  'He level top too low'),
      (5,  'Water flow for compressor 1 too low'),
      (6,  'Water flow for compressor 1 too high'),
      (7,  'Water temp for compressor 1 too cold'),
      (8,  'Water temp for compressor 1 too hot'),
      (9,  'Water flow for compressor 2 too low'),
      (10, 'Water flow for compressor 2 too high'),
      (11, 'Water temp for compressor 2 too cold'),
      (12, 'Water temp for compressor 2 too hot'),
      (13, 'Shield temp too cold'),
      (14, 'Shield temp too hot'),
      (15, 'Recondensor RuO temp too low'),
      (16, 'Recondensor RuO temp too high'),
      (17, 'Recondensor Si410 temp too low'),
      (18, 'Recondensor Si410 temp too high'),
      (19, 'Recondensor Si410 (2A) temp too low'),
      (20, 'Recondensor Si410 (2A) temp too high'),
      (21, 'Recondensor Si410 (2B) temp too low'),
      (22, 'Recondensor Si410 (2B) temp too high'),
      (23, 'Coldhead RuO temp too hot'),
      (24, 'Coldhead RuO temp too cold'),
      (25, 'Vessel pressure too high'),
      (26, 'Vessel pressure too low'),
      (27, 'Spare SR1A high'),
      (28, 'Spare SR1A low'),
      (29, 'Spare SR1B high'),
      (30, 'Spare SR1B low'),
      (31, 'SC pressure too high'),
      (32, 'SC pressure too low'),
      (33, 'Spare CMP1B high'),
      (34, 'Spare CMP1B low'),
      (35, 'Spare CMP1C high'),
      (36, 'Spare CMP1C low'),
      (37, 'Single-stage temp too low'),
      (38, 'Single-stage temp too high'),
      (44, 'Vessel pressure sensor cable disconnected'),
      (45, 'He level cable disconnected'),
      (46, 'He level top cable disconnected'),
      (47, 'Recondensor RuO cable disconnected'),
      (48, 'Coldhead RuO sensor cable disconnected'),
      (49, 'Shield temp sensor cable disconnected'),
      (50, 'Recondensor Si410 cable disconnected'),
      (51, 'Recondensor Si410 (2A) cable disconnected'),
      (52, 'Recondensor Si410 (2A) cable disconnected'),
      (53, 'The RuO buffer is drawing too much current from Magmon'),
      (54, 'The remote alarm is drawing too much current from Magmon'),
      (55, 'The 12v heater is drawing too much current from Magmon'),
      (56, 'Water meter 1 is drawing too much current from Magmon'),
      (57, 'Water meter 2 is drawing too much current from Magmon'),
      (58, 'The 12v heater is under voltage when turned on'),
      (65, 'Magmon driving too much current into the He level sensor'),
      (66, 'Magmon not driving enough current into the He level sensor'),
      (67, 'Magmon driving too much current into the He level top sensor'),
      (68, 'Magmon not driving enough current into the He level top sensor'),
      (69, 'Magmon driving too much current into the Recondensor RuO sensor'),
      (70, 'Magmon not driving enough current into the Recondensor RuO sensor'),
      (71, 'Magmon driving too much current into the coldhead RuO sensor'),
      (72, 'Magmon not driving enough current into the coldhead RuO sensor'),
      (73, 'Magmon driving too much current into the Recondensor Si410 sensor'),
      (74, 'Magmon not driving enough current into the Recondensor Si410 sensor'),
      (75, 'Magmon driving too much current into the Recondensor Si410 (2A) sensor'),
      (76, 'Magmon not driving enough current into the Recondensor Si410 (2A) sensor'),
      (77, 'Magmon driving too much current into the Recondensor Si410 (2B) sensor'),
      (78, 'Magmon not driving enough current into the Recondensor Si410 (2B) sensor'),
      (79, 'Magmon driving too much current into the Shield Si410 sensor'),
      (80, 'Magmon not driving enough current into the Shield Si410 sensor'),
      (81, 'Magmon supplied 12v for the RuO buffer is too high'),
      (82, 'Magmon supplied 12v for the RuO buffer is too low'),
      (83, 'Magmon internal 12v supply is too high'),
      (84, 'Magmon internal 12v supply is too low'),
      (85, 'Magmon internal -12v supply is too high'),
      (86, 'Magmon internal -12v supply is too low'),
      (87, 'Magmon supplied -12v for the RuO buffer is too high'),
      (88, 'Magmon supplied -12v for the RuO buffer is too low'),
      (91, 'Magnet monitor internal temp too hot'),
      (92, 'Magnet monitor internal temp too cold'),
      (100,'The heater has been on too long'),
      (101,'The He pressure is not changing'),
      (102,'The RfUnblank signal from the system cabinet is always on'),
      (110,'System cabinet coolant leak detected'),
      (120,'The magnet field reed switch is open'),
      (121,'Compressor 1 is not running'),
      (122,'Compressor 1 reports a tripped fuse'),
      (123,'Compressor 1 reports an overtemp shutdown'),
      (124,'Compressor 1 reports a low He pressure shutdown'),
      (125,'No 24v supply from compressor 1'),
      (126,'Compressor 1 reports a klixon error'),
      (127,'Compressor 2 is not running'),
      (128,'Compressor 2 reports a tripped fuse'),
      (129,'Compressor 2 reports an overtemp shutdown'),
      (130,'Compressor 2 reports a low He pressure shutdown'),
      (131,'No 24v supply from compressor 2'),
      (132,'Compressor 2 reports a klixon error')
    ) as t(c, d) where c = p_code::int),
    'undocumented code'
  );
$function$;

-- Compressor status codes (the CS1/CS2 minute-data columns), from
-- /minlog_help.html. This is what turns "cs1 > 0 (now 11.0)" -- which tells an
-- on-call engineer nothing at 2am -- into "compressor stopped due to overheat".
-- Note the vendor lists the fuse and klixon codes in both a one- and two-digit
-- form (8/18, 4/14); both are carried here.
create or replace function public.magmon_compressor_status_text(p_code numeric)
returns text
language sql
immutable
as $function$
  select coalesce(
    (select d from (values
      (0,  'normal operation, compressor running'),
      (4,  'klixon error'),
      (8,  'compressor fuse tripped'),
      (10, 'compressor stopped, reason unknown'),
      (11, 'compressor stopped due to overheat'),
      (12, 'compressor stopped due to low He pressure'),
      (13, 'compressor stopped due to overheat and low pressure'),
      (14, 'klixon error'),
      (18, 'compressor fuse tripped'),
      (20, 'compressor powered off or cable disconnected (no 24v signal)'),
      (30, 'compressor powered off or cable disconnected (no 24v signal)'),
      (31, 'compressor powered off or cable disconnected (no 24v signal)'),
      (32, 'compressor powered off or cable disconnected (no 24v signal)'),
      (33, 'compressor powered off or cable disconnected (no 24v signal)')
    ) as t(c, d) where c = p_code::int),
    'undocumented status code'
  );
$function$;

grant execute on function public.magmon_error_text(numeric) to anon, authenticated, service_role;
grant execute on function public.magmon_compressor_status_text(numeric) to anon, authenticated, service_role;


-- --- evaluate_diagnostics --------------------------------------------
-- evaluate_alerts answers "is a value over a line right now". This answers the
-- questions an engineer actually asks: is it MOVING, is it STUCK, and do several
-- channels together mean one thing? Writes into alert_events like everything
-- else, so findings inherit notification, acknowledgement and the fleet card.
-- Scheduled every 5 minutes.
create or replace function public.evaluate_diagnostics()
returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  r record;
  v_sev text;
  v_flow_bad boolean;
  v_temp_bad boolean;
  v_cause text;
begin
  -- 1. TREND. Least-squares fit over daily averages, projected to the channel's
  -- critical bound. r2 guards it: a channel that merely wobbles has no
  -- trustworthy slope, and projecting from noise would page people about
  -- nothing. Only a fit explaining most of the variance, landing inside a
  -- three-week horizon, is raised. regr_slope/regr_r2 return double precision
  -- and are cast to numeric so round(value, digits) resolves.
  for r in
    with live as (
      select a.id, a.name from assets a
      where a.maintenance = false
        and a.last_sample_at is not null
        and a.last_sample_at >= now() - make_interval(mins => a.offline_threshold_minutes)
    ),
    pts as (
      select d.asset_id, d.channel, (d.day - date '2020-01-01')::numeric as x,
             d.avg_v as y, d.day
      from telemetry_daily d
      join live l on l.id = d.asset_id
      where d.day >= (now() at time zone 'UTC')::date - 30 and d.avg_v is not null
    ),
    fit as (
      select p.asset_id, p.channel, count(*) as n,
             regr_slope(p.y, p.x)::numeric as slope,
             coalesce(regr_r2(p.y, p.x), 0)::numeric as r2,
             (array_agg(p.y order by p.day desc))[1] as last_y
      from pts p group by p.asset_id, p.channel having count(*) >= 4
    )
    select l.id as asset_id, l.name, f.channel, f.slope, f.r2, f.last_y, f.n,
           b.label, b.unit, b.critical_above, b.critical_below,
           case
             when b.critical_above is not null and f.slope > 0 and f.last_y < b.critical_above
               then (b.critical_above - f.last_y) / f.slope
             when b.critical_below is not null and f.slope < 0 and f.last_y > b.critical_below
               then (b.critical_below - f.last_y) / f.slope
           end as days_to_cross,
           case when f.slope > 0 then b.critical_above else b.critical_below end as target
    from fit f
    join live l on l.id = f.asset_id
    join diagnostic_bounds b on b.channel = f.channel
  loop
    if r.days_to_cross is not null and r.days_to_cross > 0
       and r.days_to_cross <= 21 and r.r2 >= 0.6 then
      v_sev := case when r.days_to_cross <= 5 then 'critical' else 'warning' end;
      perform _upsert_finding(r.asset_id, 'trend', r.channel, v_sev,
        format('%s %s %s %s %s/day — on this trend it reaches %s %s in about %s days',
               r.name, r.label, case when r.slope > 0 then 'rising' else 'falling' end,
               abs(round(r.slope, 3)), r.unit, round(r.target, 1), r.unit,
               round(r.days_to_cross)),
        jsonb_build_object('slope_per_day', round(r.slope, 4), 'r2', round(r.r2, 3),
                           'current', round(r.last_y, 3), 'target', r.target,
                           'days_to_cross', round(r.days_to_cross, 1), 'days_fitted', r.n));
    else
      perform _resolve_finding(r.asset_id, 'trend', r.channel);
    end if;
  end loop;

  -- 2. COOLING LOSS. The cross-signal one: low flow and hot water are the same
  -- story told twice, and a warming coldhead alongside them is what turns it
  -- from a plumbing annoyance into a magnet risk. Raised as ONE finding naming
  -- the cause rather than three pills the reader must assemble.
  --
  -- Each channel resolves to its most recent NON-NULL reading in the last 30
  -- minutes. Reading straight from latest_telemetry made the diagnosis a coin
  -- flip on NM1027, whose flow sensor drops out every other sample. A threshold
  -- may fairly speak only for the current sample; a diagnosis reasons over
  -- recent evidence.
  for r in
    select a.id as asset_id, a.name,
           (select t.h2o_flow from telemetry_samples t
             where t.asset_id = a.id and t.h2o_flow is not null
               and t.created_at >= now() - interval '30 minutes'
             order by t.recorded_at desc limit 1) as h2o_flow,
           (select t.h2o_temp from telemetry_samples t
             where t.asset_id = a.id and t.h2o_temp is not null
               and t.created_at >= now() - interval '30 minutes'
             order by t.recorded_at desc limit 1) as h2o_temp,
           safe_numeric(lt.data->>'ColdheadRuO') as coldhead,
           (select bb.warn_below from diagnostic_bounds bb where bb.channel='h2o_flow') as flow_warn,
           (select bb.critical_below from diagnostic_bounds bb where bb.channel='h2o_flow') as flow_crit,
           (select bb.warn_above from diagnostic_bounds bb where bb.channel='h2o_temp') as temp_warn,
           (select bb.warn_above from diagnostic_bounds bb where bb.channel='coldhead') as cold_warn,
           (select min(e.triggered_at) from alert_events e
             where e.asset_id = a.id and e.kind='cooling_loss' and e.resolved_at is null) as opened_at
    from assets a
    join latest_telemetry lt on lt.asset_id = a.id
    where a.maintenance = false
      and a.last_sample_at is not null
      and a.last_sample_at >= now() - make_interval(mins => a.offline_threshold_minutes)
  loop
    v_flow_bad := r.h2o_flow is not null and r.h2o_flow < r.flow_warn;
    v_temp_bad := r.h2o_temp is not null and r.h2o_temp > r.temp_warn;

    if v_flow_bad or v_temp_bad then
      v_cause := case
        when v_flow_bad and v_temp_bad then 'flow is low and water is running hot'
        when v_flow_bad then 'cooling water flow is low'
        else 'cooling water is running hot' end;
      -- Escalation: hard-low flow, the coldhead joining in, or simple
      -- persistence past two hours.
      v_sev := case
        when (r.h2o_flow is not null and r.flow_crit is not null and r.h2o_flow < r.flow_crit)
          or (r.coldhead is not null and r.coldhead > r.cold_warn)
          or (r.opened_at is not null and r.opened_at < now() - interval '2 hours')
        then 'critical' else 'warning' end;
      perform _upsert_finding(r.asset_id, 'cooling_loss', null, v_sev,
        format('%s cooling fault — %s (flow %s gpm, water %s °F, coldhead %s K)%s',
               r.name, v_cause,
               coalesce(round(r.h2o_flow, 2)::text, '—'),
               coalesce(round(r.h2o_temp, 1)::text, '—'),
               coalesce(round(r.coldhead, 2)::text, '—'),
               case when r.coldhead is not null and r.coldhead > r.cold_warn
                    then ' — coldhead is above nominal, treat as urgent' else '' end),
        jsonb_build_object('h2o_flow', r.h2o_flow, 'h2o_temp', r.h2o_temp,
                           'coldhead', r.coldhead, 'flow_low', v_flow_bad,
                           'temp_high', v_temp_bad));
    elsif r.h2o_flow is not null and r.h2o_temp is not null then
      -- Only a reading that actually ARRIVED can clear this. If either channel
      -- is absent we cannot confirm recovery, so the finding is left exactly as
      -- it stands rather than being cleared by a blink.
      perform _resolve_finding(r.asset_id, 'cooling_loss', null);
    end if;
  end loop;

  -- 3. FLATLINE. A live analog channel jitters; one returning a single value for
  -- two days is not measuring. Sibling of the sentinel work — there the device
  -- announced "no sensor" with a fixed placeholder, here it simply stops moving.
  -- Restricted to channels that MUST vary: cs1 is binary and sits at 0 on every
  -- healthy unit, and he_lvl is quantised and can legitimately hold for days, so
  -- both would false-positive forever.
  for r in
    select a.id as asset_id, a.name, d.channel, sum(d.n) as n,
           min(d.min_v) as lo, max(d.max_v) as hi
    from assets a
    join telemetry_daily d on d.asset_id = a.id
    where a.maintenance = false
      and a.last_sample_at is not null
      and a.last_sample_at >= now() - make_interval(mins => a.offline_threshold_minutes)
      and d.day >= (now() at time zone 'UTC')::date - 1
      and d.channel in ('h2o_temp','h2o_flow','he_press','shield','coldhead')
    group by a.id, a.name, d.channel
  loop
    if r.n >= 30 and r.lo = r.hi then
      perform _upsert_finding(r.asset_id, 'flatline', r.channel, 'warning',
        format('%s %s has read exactly %s for two days — a live sensor jitters, so this channel is probably not measuring',
               r.name, (select label from diagnostic_bounds b where b.channel = r.channel),
               round(r.lo, 3)),
        jsonb_build_object('value', r.lo, 'samples', r.n));
    else
      perform _resolve_finding(r.asset_id, 'flatline', r.channel);
    end if;
  end loop;

  -- 4. UNRULED BOUNDS. alert_rules can only target typed telemetry columns, so
  -- coldhead — raw-blob only, and the earliest indicator of a cold-head or
  -- compressor problem — had never been evaluated server-side at all. NM1028 sat
  -- at ~8.9 K for eight days: a pill on the fleet card, and not one notification.
  for r in
    select a.id as asset_id, a.name,
           safe_numeric(lt.data->>'ColdheadRuO') as v,
           -- Recondenser sensors, carried purely as CONTEXT on the finding. They
           -- have no bound of their own: nobody here knows what recondenser
           -- temperature counts as bad, so inventing one would be guessing.
           -- Reporting the numbers is not, and it changes how the same alert
           -- reads — NM1028 sits at 8.9 K with its recondenser at 4.2 / 3.5 K.
           safe_numeric(lt.data->>'ReconRuO') as recon_ruo,
           safe_numeric(lt.data->>'ReconSi410') as recon_si,
           b.label, b.unit, b.warn_above, b.critical_above
    from assets a
    join latest_telemetry lt on lt.asset_id = a.id
    cross join diagnostic_bounds b
    where b.channel = 'coldhead'
      and a.maintenance = false
      and a.last_sample_at is not null
      and a.last_sample_at >= now() - make_interval(mins => a.offline_threshold_minutes)
  loop
    if r.v is not null and r.v > r.warn_above then
      v_sev := case when r.v > r.critical_above then 'critical' else 'warning' end;
      perform _upsert_finding(r.asset_id, 'bound', 'coldhead', v_sev,
        -- The clause is omitted entirely when neither sensor reported, rather
        -- than rendering "reads — / —", which says nothing and reads like a bug.
        format('%s %s at %s %s — nominal is below %s %s%s',
               r.name, r.label, round(r.v, 2), r.unit, r.warn_above, r.unit,
               case when r.recon_ruo is null and r.recon_si is null then ''
                    else format(' (recondenser reads %s / %s K)',
                                coalesce(round(r.recon_ruo, 2)::text, '—'),
                                coalesce(round(r.recon_si, 2)::text, '—')) end),
        jsonb_build_object('value', r.v, 'warn_above', r.warn_above,
                           'critical_above', r.critical_above,
                           'recon_ruo', r.recon_ruo, 'recon_si', r.recon_si));
    else
      perform _resolve_finding(r.asset_id, 'bound', 'coldhead');
    end if;
  end loop;

  -- 5. FLEET OUTLIER on the device's own error registers (EC1-EC4).
  -- We do not have the MagMon code list, so we cannot say what any EC value
  -- MEANS. We can say what is unlike the rest of the fleet, and that needs no
  -- code list at all.
  --
  -- Measured before building, because the obvious approach does not work.
  -- Alerting on EC TRANSITIONS is unusable: the registers are rock-steady on 10
  -- of 15 units (a single value across two days) but NM1027's EC2 oscillates
  -- 0<->5<->6 sixty-plus times in two days, which would page somebody hourly.
  -- Comparing across the fleet instead yields two flags on fifteen units.
  --
  -- Validation: of the twelve fleet-unique values, ten belonged to units already
  -- flagged `maintenance` — it rediscovers the known-abnormal units knowing
  -- nothing about the codes. Maintenance units are excluded (abnormal by
  -- definition, and would otherwise be all this ever reported).
  --
  -- Deliberately weak claims: fifteen units is small, so "unique" may mean
  -- uncommon rather than wrong. It complements the other detections; it does not
  -- replace them. Non-paging (see _upsert_finding). Compared WITHIN an org,
  -- never across tenants.
  --
  -- CORRECTION 2026-08-20: this used to say NM1027 "runs a real cooling fault".
  -- It does not, and did not. Its coldhead has been flat at 4.21-4.23 K with a
  -- steady 44.9 K shield and 60-62 F water for as long as we have retention;
  -- what it has is a dead flow SENSOR, raising the device's own codes 5 (flow
  -- too low) and 6 (flow too high) in nearly equal numbers, which no real flow
  -- can do. Left recorded rather than deleted: the wrong reading was load-
  -- bearing for a while.
  perform evaluate_diagnostics_ec_outliers();
end;
$function$;

-- Section 5, extracted so the comparison it performs can be stated plainly.
--
-- The previous version compared EC1-to-EC1, EC2-to-EC2 across units. The
-- device's own /minlog_help.html says EC1-EC4 are "the four worst error codes
-- active during this minute", severity-ranked and zero-padded -- so which SLOT
-- a code lands in depends on how many OTHER codes happen to be active on that
-- unit at that moment, and a slot-wise comparison compares nothing. Live proof
-- at the time of writing: code 6 sat in EC2 on CA1012/NM1027 but EC3 on
-- NM1006/NM1029, and code 26 was split 3 units in EC1 against 4 in EC2.
--
-- Membership is the only stable identity, so this compares the SET of codes a
-- unit raises and keys the finding on the CODE. That also removes a churn bug:
-- keyed on the slot, an unrelated code clearing would slide a code into a
-- different slot, resolve the finding and open a duplicate for the same
-- condition. APPLIED to live DB 2026-08-20 (migrations magmon_device_code_tables,
-- ec_codes_as_set_not_slots, evaluate_diagnostics_delegates_ec_outliers).
create or replace function public.evaluate_diagnostics_ec_outliers()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r record;
begin
  -- Materialized because it is needed twice: once to raise findings, once to
  -- sweep findings whose code is no longer raised (a loop over current codes
  -- cannot see a code that has gone away).
  drop table if exists _ec_now;
  create temp table _ec_now on commit drop as
  with live as (
    select a.id, a.name, a.org_id
    from assets a
    where a.maintenance = false
      and a.last_sample_at is not null
      and a.last_sample_at >= now() - make_interval(mins => a.offline_threshold_minutes)
  ),
  totals as (
    select l.org_id, l.id as asset_id, count(*) as n_total
    from live l
    join telemetry_samples t on t.asset_id = l.id and t.created_at >= now() - interval '24 hours'
    where t.data ? 'EC1'
    group by 1, 2
  ),
  -- PERSISTENT codes only. A code present on a fifth of a unit's samples is its
  -- steady state; a one-minute blip (CA1012 showed code 72 exactly once in a
  -- week) is not something to compare fleets on, and would flap a finding.
  persistent as (
    select tt.org_id, tt.asset_id, l.name, (v.code::numeric)::int as code
    from totals tt
    join live l on l.id = tt.asset_id
    join telemetry_samples t on t.asset_id = tt.asset_id and t.created_at >= now() - interval '24 hours'
    cross join lateral (values
      (t.data->>'EC1'), (t.data->>'EC2'), (t.data->>'EC3'), (t.data->>'EC4')) as v(code)
    where v.code is not null and v.code <> '0.0'
      and v.code ~ '^[0-9]+(\.[0-9]+)?$' and (v.code::numeric)::int <> 0
    group by tt.org_id, tt.asset_id, l.name, (v.code::numeric)::int, tt.n_total
    having count(*) >= greatest(10, tt.n_total / 5)
  ),
  sized as (select org_id, count(distinct asset_id) as fleet_n from totals group by 1),
  freq as (select org_id, code, count(distinct asset_id) as n_units from persistent group by 1, 2)
  select p.asset_id, p.name, p.code, f.n_units, s.fleet_n
  from persistent p
  join freq f on f.org_id = p.org_id and f.code = p.code
  join sized s on s.org_id = p.org_id;

  -- Below eight reporting units "unique in the fleet" means nothing, so a small
  -- or half-offline fleet reports nothing rather than noise.
  for r in select * from _ec_now where fleet_n >= 8 and n_units = 1
  loop
    perform _upsert_finding(r.asset_id, 'anomaly', 'EC' || r.code, 'warning',
      format('%s reports error code %s -- %s. No other unit in the fleet raises it.',
             r.name, r.code, magmon_error_text(r.code)),
      jsonb_build_object('code', r.code, 'meaning', magmon_error_text(r.code),
                         'units_sharing_code', r.n_units, 'fleet_size', r.fleet_n));
  end loop;

  -- One sweep retires everything the loop above did not raise: codes that
  -- stopped being unique, codes no longer raised at all, and the findings the
  -- previous SLOT-keyed version left behind on channels 'EC1'..'EC4'.
  update alert_events e set resolved_at = now()
  where e.kind = 'anomaly' and e.resolved_at is null
    and not exists (
      select 1 from _ec_now n
      where n.asset_id = e.asset_id and n.fleet_n >= 8 and n.n_units = 1
        and e.channel = 'EC' || n.code
    );
end;
$function$;
grant execute on function public.evaluate_diagnostics_ec_outliers() to service_role;

-- NOTE: generate_demo_telemetry now jitters ColdheadRuO instead of emitting
-- demo_asset_specs.coldhead_k as a bare constant. It was the only channel
-- without a wobble, so the entire demo fleet tripped the new flatline detector.
-- The detector was right and the data was wrong — a real coldhead jitters
-- (NM1028 reads 8.86-9.09 around a flat 8.94 mean, which is why it did NOT
-- trip). See migration demo_coldhead_jitter_and_unruled_bounds.

-- pg_cron jobs added 2026-08-19:
--   jobid 8   rollup-telemetry-daily  '30 2 * * *'   (BEFORE the 03:00 raw purge)
--   jobid 9   cleanup-old-rollups     '45 3 * * *'
--   jobid 10  evaluate-diagnostics    '*/5 * * * *'

-- --- engineer role reachability (migration allow_engineer_role_in_admin_rpcs)
-- Three admin RPCs validated the requested role against a hardcoded
-- ('admin','viewer') whitelist that was STRICTER than the org_members check
-- constraint. Adding 'engineer' to the constraint was therefore not enough on
-- its own — the constraint permitted the role while every path that writes the
-- column refused it, so it would have been unreachable from the UI:
--   admin_set_role(p_token, p_target_username, p_new_role)
--   admin_set_membership(p_token, p_target_username, p_org_id, p_role, ...)
--   admin_create_user(p_token, p_new_username, p_new_pin, p_role)
-- All three now accept ('admin','engineer','viewer'). The self-demotion guard
-- in admin_set_role is untouched and still refuses to strip your own admin role.
--
-- NB: these three live in the DB under the session-token signature shown above.
-- The copies earlier in this file still carry the retired
-- (p_actor_username, p_actor_pin) signature — see the "IN PROGRESS" note at the
-- top of the admin section; that drift predates this work.

-- --- site_geocode (address -> lat/lon, for local weather) -------------------
-- Applied to live DB 2026-08-20 (migrations site_geocode_cache,
-- seed_manual_site_geocodes).
--
-- Keyed by the NORMALIZED address text, not by asset id: five Numed units share
-- the Denton service-center address, and they are not five weather stations.
-- The key is lib/weather.ts addressKey() — lowercased, punctuation to spaces,
-- whitespace collapsed — so any hand-seeded row must be written the same way.
--
-- Nothing here is per-tenant (an address resolves to the same point whoever owns
-- the magnet), so there is no org_id. RLS is on with no policy: the weather
-- reader runs service-role, and nothing else touches this table.
--
-- source='census'  resolved automatically; retried weekly while unresolved.
-- source='manual'  a hand-pinned fix. NEVER overwritten and never retried —
--                  including a manual row with NULL coordinates, which is how
--                  you say "this site has no weather" permanently.
create table if not exists public.site_geocode (
  address_key  text        primary key,
  address      text        not null,
  latitude     double precision,
  longitude    double precision,
  place_label  text,
  source       text        not null default 'census',
  resolved_at  timestamptz,
  attempted_at timestamptz not null default now(),
  attempts     integer     not null default 0
);
alter table public.site_geocode enable row level security;  -- no policy: service_role only

-- Manually pinned at seed time: NMMC West Point (a real site on a TIGER address
-- range Census does not carry) plus all twelve Demo Company sites, whose street
-- addresses are invented and therefore unplaceable. See the migration for the
-- reasoning on pointing demo sites at real US cities.
