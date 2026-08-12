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
-- SECURITY NOTE (see the architecture review, findings F-1 and F-4)
--   * The "public read" policies below grant SELECT to EVERYONE (role
--     public / anon) with no condition. Combined with the SECURITY DEFINER
--     views, all site and telemetry data is readable by anyone holding the
--     public anon key. This is intentional to change before multi-tenant.
--   * The SECURITY DEFINER views (public_assets, latest_telemetry) are
--     flagged by Supabase's linter; the F-1 fix converts them to
--     security_invoker and adds proper policies.
-- Nothing in this file has been applied to the live database.
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
  failed_attempts  integer     not null default 0,
  locked_until     timestamptz,
  created_at       timestamptz not null default now(),
  constraint users_username_key unique (username)
);

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
  last_seen_at               timestamptz,
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
  constraint assets_name_unique unique (name)
);

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

-- --- alert_rules (per-asset thresholds; currently unused) ------------
create table if not exists public.alert_rules (
  id          uuid        primary key default gen_random_uuid(),
  asset_id    uuid        references public.assets(id) on delete cascade,
  field       text        not null,   -- e.g. 'he_lvl', 'h2o_flow'
  comparator  text        not null,   -- e.g. '<', '>', '<=', '>='
  threshold   numeric     not null,
  enabled     boolean     not null default true,
  created_at  timestamptz not null default now()
);

-- --- alert_events (fired alerts; opened/resolved by evaluate_alerts) --
create table if not exists public.alert_events (
  id             bigint      generated always as identity primary key,
  asset_id       uuid        not null references public.assets(id) on delete cascade,
  alert_rule_id  uuid        references public.alert_rules(id) on delete set null,
  kind           text        not null,   -- 'offline' | 'threshold'
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
-- NOTE: both views are currently SECURITY DEFINER (they run with the
-- creator's rights and bypass RLS). This is what makes them readable via
-- the anon key. The F-1 remediation recreates them WITH (security_invoker=on).
-- Reproduced here as-is for fidelity.

-- public_assets: asset list WITHOUT the secret columns (gateway_token,
-- monitor_password, monitor_host/port/username). This is the shape the
-- dashboard reads.
create or replace view public.public_assets as
  select id, name, site_name, site_address,
         offline_threshold_minutes, status, last_seen_at, created_at, service_user,
         maintenance
  from public.assets;

-- latest_telemetry: newest reading per asset.
create or replace view public.latest_telemetry as
  select t.asset_id, t.id, t.recorded_at, t.created_at,
         t.he_lvl, t.he_press, t.h2o_flow, t.h2o_temp, t.shield, t.cs1, t.data
  from public.assets a
  cross join lateral (
    select ts.id, ts.asset_id, ts.recorded_at, ts.data,
           ts.he_lvl, ts.he_press, ts.h2o_flow, ts.h2o_temp, ts.shield, ts.cs1, ts.created_at
    from public.telemetry_samples ts
    where ts.asset_id = a.id
    order by ts.created_at desc
    limit 1
  ) t;


-- =====================================================================
-- FUNCTIONS (RPCs) — all SECURITY DEFINER with pinned search_path
-- =====================================================================

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
declare
  v_code text;
begin
  select value into v_code from app_settings where key = 'invite_code';
  if v_code is null or v_code <> p_invite_code then
    raise exception 'invalid invite code';
  end if;
  insert into users (username, pin_hash, role)
  values (p_username, extensions.crypt(p_pin, extensions.gen_salt('bf')), 'viewer');
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
begin
  select id, last_seen_at into v_asset_id, v_last_seen
  from assets where gateway_token = p_gateway_token;

  if v_asset_id is null then
    raise exception 'invalid gateway token';
  end if;

  if v_last_seen is null or v_last_seen < now() - interval '10 seconds' then
    update assets set last_seen_at = now(), status = 'online' where id = v_asset_id;
  end if;

  select count(*) into v_recent_count
  from telemetry_samples
  where asset_id = v_asset_id and created_at >= now() - interval '60 seconds';

  if v_recent_count = 0 then
    insert into telemetry_samples (asset_id, recorded_at, he_lvl, he_press, h2o_flow, h2o_temp, shield, cs1, data)
    values (v_asset_id, p_recorded_at, p_he_lvl, p_he_press, p_h2o_flow, p_h2o_temp, p_shield, p_cs1, p_raw);
  end if;

  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.asset_telemetry_15min(p_asset_id uuid, p_hours integer DEFAULT 24)
 RETURNS TABLE(created_at timestamp with time zone, he_lvl numeric, he_press numeric, h2o_flow numeric, h2o_temp numeric, shield numeric, cs1 numeric, sample_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    to_timestamp(floor(extract(epoch from t.created_at) / 900) * 900) as created_at,
    round(avg(t.he_lvl), 2) as he_lvl,
    round(avg(t.he_press), 3) as he_press,
    round(avg(t.h2o_flow), 3) as h2o_flow,
    round(avg(t.h2o_temp), 2) as h2o_temp,
    round(avg(t.shield), 2) as shield,
    round(avg(t.cs1), 2) as cs1,
    count(*) as sample_count
  from telemetry_samples t
  where t.asset_id = p_asset_id
    and t.created_at >= now() - (p_hours || ' hours')::interval
  group by 1
  order by 1;
$function$;


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
-- ALERTING (offline + threshold/state rules; evaluated by pg_cron once live)
-- =====================================================================

-- Evaluate offline + threshold/state conditions and open/resolve alert_events.
-- Idempotent. A per-asset rule overrides the global (asset_id NULL) rule for
-- the same field. Maintenance-flagged units are exempt (mirrors TV/Display):
-- their open events are resolved and no new ones are opened, so known-warm
-- service-center units (e.g. NM1034) don't raise permanent phantom alarms.
-- Scheduled every minute by pg_cron job 'evaluate-alerts' (see end of file);
-- sends nothing itself — notification is a separate step.
-- APPLIED to live DB 2026-08-12 via migration evaluate_alerts_exempt_maintenance.
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

  -- OFFLINE open (skip maintenance)
  for r in
    select a.id, a.name, a.last_seen_at, a.offline_threshold_minutes
    from assets a
    where a.maintenance = false
      and a.last_seen_at is not null
      and a.last_seen_at < now() - make_interval(mins => a.offline_threshold_minutes)
  loop
    if not exists (select 1 from alert_events e where e.asset_id=r.id and e.kind='offline' and e.resolved_at is null) then
      insert into alert_events (asset_id, kind, message)
      values (r.id, 'offline', format('%s offline — no report since %s', r.name, to_char(r.last_seen_at,'YYYY-MM-DD HH24:MI UTC')));
    end if;
  end loop;
  -- OFFLINE resolve
  update alert_events e set resolved_at=now()
  from assets a
  where e.asset_id=a.id and e.kind='offline' and e.resolved_at is null
    and a.last_seen_at >= now() - make_interval(mins => a.offline_threshold_minutes);

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
  created_at  timestamptz not null default now()
);
create index if not exists idx_audit_log_created_at on public.audit_log using btree (created_at desc);

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

-- Open read policies (candidates for tightening under F-1).
create policy "public read telemetry"    on public.telemetry_samples for select to public using (true);
create policy "public read alert_rules"  on public.alert_rules       for select to public using (true);
create policy "public read alert_events" on public.alert_events      for select to public using (true);

-- =====================================================================
-- GRANTS
-- =====================================================================
-- The anon / authenticated roles hold Supabase's default broad table
-- grants; RLS (above) is what actually gates access. Reproduced here as a
-- reminder that the security boundary is the POLICY set, not the GRANTs.
-- (Left as Supabase defaults; no custom GRANT statements were in use.)


-- =====================================================================
-- SEED — fleet-wide alert defaults (global rules; asset_id NULL)
-- =====================================================================
-- The confirmed starting thresholds. Per-asset overrides and the compressor
-- rule are added through the admin Alerts UI. Idempotent (skips if present).
insert into public.alert_rules (asset_id, field, comparator, threshold, enabled)
select v.asset_id, v.field, v.comparator, v.threshold, v.enabled
from (values
  (null::uuid, 'he_lvl',   '<',  40::numeric,  true),  -- helium low; matches TV amber warning (added 2026-08-12)
  (null::uuid, 'he_press', '>',  3.0::numeric, true),
  (null::uuid, 'h2o_flow', '<',  0.6::numeric, true),
  (null::uuid, 'h2o_temp', '>',  75::numeric,  true),
  (null::uuid, 'shield',   '>',  80::numeric,  true),
  (null::uuid, 'cs1',      '>',  0::numeric,   true)   -- compressor: 0 = ON (normal), >0 = OFF (alarm)
) as v(asset_id, field, comparator, threshold, enabled)
where not exists (
  select 1 from public.alert_rules ar where ar.asset_id is null and ar.field = v.field
);


-- =====================================================================
-- SCHEDULED JOBS (pg_cron)
-- =====================================================================
-- Live jobs as of 2026-08-12:
--   jobid 1  cleanup_old_telemetry  '0 3 * * *'  delete telemetry_samples > 7 days
--   jobid 2  evaluate-alerts        '* * * * *'  select public.evaluate_alerts()
-- The evaluator job was added 2026-08-12 (Phase 1 of alerting rollout). It only
-- opens/resolves alert_events; no notification is sent until the notify-alerts
-- edge function is scheduled (Phase 3). To (re)create the evaluator schedule:
--   select cron.schedule('evaluate-alerts', '* * * * *', $$ select public.evaluate_alerts(); $$);
-- To remove it:
--   select cron.unschedule('evaluate-alerts');
