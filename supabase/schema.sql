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

-- --- sites -----------------------------------------------------------
create table if not exists public.sites (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  address     text,
  created_at  timestamptz not null default now(),
  constraint sites_name_unique unique (name)
);

-- --- users (custom PIN auth; PINs are bcrypt-hashed) ------------------
create table if not exists public.users (
  id               uuid        primary key default gen_random_uuid(),
  username         text        not null,
  pin_hash         text        not null,
  role             text        not null default 'viewer'
                     check (role = any (array['admin','viewer'])),
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
create table if not exists public.assets (
  id                         uuid        primary key default gen_random_uuid(),
  site_id                    uuid        not null references public.sites(id) on delete cascade,
  name                       text        not null,
  magmon_version             text        not null default 'v1',
  gateway_token              text        not null default encode(extensions.gen_random_bytes(24), 'hex'),
  offline_threshold_minutes  integer     not null default 15,
  status                     text        not null default 'unknown',
  last_seen_at               timestamptz,
  created_at                 timestamptz not null default now(),
  monitor_host               text,
  monitor_port               integer     not null default 80,
  monitor_username           text        not null default 'MMService',
  monitor_password           text        not null default 'MagnetMonitor',
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

-- --- alert_events (fired alerts; currently unused) -------------------
create table if not exists public.alert_events (
  id             bigint      generated always as identity primary key,
  asset_id       uuid        not null references public.assets(id) on delete cascade,
  alert_rule_id  uuid        references public.alert_rules(id) on delete set null,
  kind           text        not null,   -- e.g. 'offline', 'threshold'
  message        text        not null,
  triggered_at   timestamptz not null default now(),
  resolved_at    timestamptz
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
  select id, site_id, name, magmon_version, offline_threshold_minutes,
         status, last_seen_at, created_at
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
 RETURNS TABLE(username text, role text)
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
    return query select v_user.username, v_user.role;
  else
    update users
      set failed_attempts = failed_attempts + 1,
          locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
      where id = v_user.id;
    raise exception 'invalid username or PIN';
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

CREATE OR REPLACE FUNCTION public.admin_create_site(p_actor_username text, p_actor_pin text, p_name text, p_address text)
 RETURNS sites
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  result sites;
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  insert into sites (name, address) values (p_name, p_address) returning * into result;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_update_site(p_actor_username text, p_actor_pin text, p_site_id uuid, p_name text, p_address text)
 RETURNS sites
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  result sites;
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  update sites set name = p_name, address = p_address where id = p_site_id returning * into result;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_site(p_actor_username text, p_actor_pin text, p_site_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count int;
  v_names text;
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;

  select count(*), string_agg(name, ', ' order by name)
    into v_count, v_names
  from assets
  where site_id = p_site_id;

  if v_count > 0 then
    raise exception
      'This site still has % asset(s) attached (%). Delete or move them first. Deleting the site would also delete those assets, their gateway tokens, and all of their telemetry.',
      v_count, v_names;
  end if;

  delete from sites where id = p_site_id;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_create_asset(p_actor_username text, p_actor_pin text, p_site_id uuid, p_name text, p_magmon_version text, p_offline_threshold_minutes integer DEFAULT 15, p_monitor_host text DEFAULT NULL::text, p_monitor_port integer DEFAULT 80, p_monitor_username text DEFAULT 'MMService'::text, p_monitor_password text DEFAULT 'MagnetMonitor'::text)
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
    site_id, name, magmon_version, gateway_token, offline_threshold_minutes,
    status, monitor_host, monitor_port, monitor_username, monitor_password
  )
  values (
    p_site_id, p_name, p_magmon_version, encode(extensions.gen_random_bytes(24), 'hex'), p_offline_threshold_minutes,
    'unknown', p_monitor_host, p_monitor_port, p_monitor_username, p_monitor_password
  )
  returning * into result;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_update_asset(p_actor_username text, p_actor_pin text, p_asset_id uuid, p_name text, p_site_id uuid, p_magmon_version text, p_offline_threshold_minutes integer, p_monitor_host text, p_monitor_port integer, p_monitor_username text, p_monitor_password text)
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
    site_id = p_site_id,
    magmon_version = p_magmon_version,
    offline_threshold_minutes = p_offline_threshold_minutes,
    monitor_host = p_monitor_host,
    monitor_port = p_monitor_port,
    monitor_username = p_monitor_username,
    monitor_password = p_monitor_password
  where id = p_asset_id
  returning * into result;
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
 RETURNS TABLE(username text, role text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not is_admin(p_actor_username, p_actor_pin) then
    raise exception 'not authorized';
  end if;
  return query select u.username, u.role, u.created_at from users u order by u.created_at;
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


-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
-- RLS is enabled on every table. Tables with NO policy (users, assets,
-- app_settings) are therefore unreadable/unwritable directly — they are
-- reached only through the SECURITY DEFINER functions and views above.
-- The four "public read" policies expose SELECT to everyone (see F-1).

alter table public.sites             enable row level security;
alter table public.users             enable row level security;
alter table public.app_settings      enable row level security;
alter table public.assets            enable row level security;
alter table public.telemetry_samples enable row level security;
alter table public.alert_rules       enable row level security;
alter table public.alert_events      enable row level security;

-- Open read policies (candidates for tightening under F-1).
create policy "public read sites"        on public.sites             for select to public using (true);
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
