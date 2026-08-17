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
-- SECURITY NOTE — F-1 and F-4 are CLOSED as of 2026-08-17.
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
--   * F-4 (PIN brute force). Moving login to create_session was NOT
--     sufficient — verify_user_login stayed anon-callable, so an attacker
--     could bypass the app and hammer the RPC directly with the publishable
--     key. Fixed by phase2_revoke_public_execute_on_legacy_auth_rpcs.
--     Note the Postgres gotcha behind the first failed attempt: functions
--     grant EXECUTE to the PUBLIC pseudo-role by default (ACL "=X/postgres"),
--     which anon inherits, so revoking from anon alone is a no-op.
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
  is_demo      boolean     not null default false,
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
  kind           text        not null,   -- 'offline' | 'reporting_stalled' | 'router_offline' | 'threshold'
  message        text        not null,
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
--                active_org_slug, effective_role, tv_access, memberships,
--                expires_at)
--       The per-request read path. effective_role collapses the superadmin
--       rule — a superadmin is admin in EVERY org, including ones they hold
--       no membership in, hence the left join to org_members.
--
--   switch_active_org(token, org_id) -> boolean
--       Refuses an org the caller has no membership in unless superadmin.
--       This is the check that stops a multi-org user reaching a tenant they
--       were never granted.
--
--   destroy_session(token) -> boolean
--   cleanup_expired_sessions() -> integer   (pg_cron 'cleanup-expired-sessions', 17 3 * * *)

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
    update assets set last_seen_at = now(), status = 'online' where id = v_asset_id;
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
    values (v_asset_id, v_rec, p_he_lvl, p_he_press, p_h2o_flow, p_h2o_temp, p_shield, p_cs1, p_raw);
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
  update assets set last_seen_at = now(), status = 'online' where id = v_asset_id;

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
         (s->>'h2o_flow')::numeric,
         (s->>'h2o_temp')::numeric,
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

  -- STALE TELEMETRY (no NEW data within the unit's threshold, by last_sample_at)
  -- -> partition by Pi reachability into two actionable kinds:
  --   * reporting_stalled: the Pi is reachable (fresh Tailscale poll, or still
  --     phoning home via last_seen_at) yet no fresh telemetry -> a
  --     gateway/device/clock fault on an otherwise-up Pi. Covers both the NM1020
  --     2026-08-13 DNS case and a hung MagMon that stops advancing its log.
  --   * offline: no fresh data and the Pi is NOT confirmed reachable -> the unit
  --     is down / the site network is down.
  -- Exactly one kind is open per stale unit; if reachability flips, the wrong one
  -- is resolved and the right one opened on the next run. BOTH notify -- only the
  -- router_offline/tailscale_offline connectivity chips stay informational.
  -- Reachability requires a FRESH Tailscale poll (status within 15 min) OR a
  -- fresh last_seen_at, so a stale signal is never trusted.
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

  -- THRESHOLD / STATE with per-asset override (skip maintenance)
  for r in
    with effective as (
      select distinct on (a.id, ar.field)
        a.id as asset_id, a.name, ar.id as rule_id, ar.field, ar.comparator, ar.threshold
      from assets a
      join alert_rules ar on (ar.asset_id = a.id or ar.asset_id is null)
      where ar.enabled and a.maintenance = false
      order by a.id, ar.field, (ar.asset_id is not null) desc
    )
    select e.asset_id, e.name, e.rule_id, e.field, e.comparator, e.threshold,
      case e.field when 'he_lvl' then lt.he_lvl when 'he_press' then lt.he_press
        when 'h2o_flow' then lt.h2o_flow when 'h2o_temp' then lt.h2o_temp
        when 'shield' then lt.shield when 'cs1' then lt.cs1 end as value
    from effective e
    join latest_telemetry lt on lt.asset_id = e.asset_id
  loop
    if r.value is null then continue; end if;
    if (r.comparator='<' and r.value<r.threshold) or (r.comparator='<=' and r.value<=r.threshold)
    or (r.comparator='>' and r.value>r.threshold) or (r.comparator='>=' and r.value>=r.threshold)
    or (r.comparator='=' and r.value=r.threshold) or (r.comparator='!=' and r.value<>r.threshold) then
      if not exists (select 1 from alert_events e where e.alert_rule_id=r.rule_id and e.asset_id=r.asset_id and e.resolved_at is null) then
        insert into alert_events (asset_id, alert_rule_id, kind, message)
        values (r.asset_id, r.rule_id, 'threshold', format('%s %s %s %s (now %s)', r.name, r.field, r.comparator, r.threshold, r.value));
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

-- Alert sending address (app_settings key 'alert_from'), admin-editable from the
-- UI (migration admin_alert_from_setting_rpcs, 2026-08-12). notify-alerts reads
-- this value; DB overrides the ALERT_FROM secret overrides the Resend test sender.
CREATE OR REPLACE FUNCTION public.admin_get_alert_from(p_actor_username text, p_actor_pin text)
 RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then raise exception 'not authorized'; end if;
  return (select value from app_settings where key = 'alert_from');
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_alert_from(p_actor_username text, p_actor_pin text, p_from text)
 RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then raise exception 'not authorized'; end if;
  if btrim(coalesce(p_from, '')) = '' then
    delete from app_settings where key = 'alert_from';
    perform _record_audit(p_actor_username, 'set_alert_from', 'app', 'alert_from', 'Cleared sending address (revert to default)');
  else
    insert into app_settings (key, value) values ('alert_from', btrim(p_from))
      on conflict (key) do update set value = excluded.value;
    perform _record_audit(p_actor_username, 'set_alert_from', 'app', 'alert_from', format('Sending address set to %s', btrim(p_from)));
  end if;
  return true;
end;
$function$;


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

-- SELECT is now revoked too — phase2_close_public_reads, applied 2026-08-17
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
