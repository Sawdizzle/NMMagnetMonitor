-- =====================================================================
-- Multi-tenant Phase 2 cutover — CLOSE THE PUBLIC READ SURFACE
--
-- ⚠ NOT YET APPLIED. This must run AFTER the Phase 2 app code is deployed.
--
-- Ordering matters and is not reversible in the friendly direction: the
-- moment this lands, the anon key can no longer read fleet data. If the
-- deployed app is still the old build that reads Supabase directly from the
-- browser, the dashboard, asset pages and TV wall all go blank for Numed.
--
-- Correct sequence:
--   1. Set SUPABASE_SERVICE_ROLE_KEY in Vercel (the build fails without it).
--   2. Deploy the Phase 2 build (lib/dataSource.ts fetching /api/*).
--   3. Confirm the live dashboard, an asset page and /tv all still render.
--   4. Apply this file.
--   5. Re-confirm the same three surfaces, then re-run the anon visibility
--      probe and expect zeros / permission denied everywhere.
--
-- What stays untouched, deliberately:
--   * report_telemetry / report_telemetry_batch keep their anon EXECUTE
--     grant. The 17 collector Pis call them with the anon key plus a
--     per-asset gateway_token, and they are SECURITY DEFINER so table grants
--     never applied to them. Revoking these would take the whole fleet's
--     ingest down.
--   * Every other SECURITY DEFINER RPC (verify_user_login, register_user,
--     admin_*, push_*, log_session_event) is likewise unaffected by table
--     grants and keeps working through the Phase 3 cutover.
--   * /demo keeps working: demoDataSource reads in-browser fixtures and
--     issues no network request at all.
-- =====================================================================

-- --- 1. make the views respect RLS -----------------------------------
-- These were created without security_invoker, so they ran with the view
-- owner's rights and bypassed the underlying tables' RLS entirely — the
-- reason anon could see 0 rows in assets but all 17 through public_assets.
-- With security_invoker on, the view is evaluated as the CALLER, so assets'
-- "RLS enabled, no policy" finally applies through the view too.
alter view public.public_assets    set (security_invoker = true);
alter view public.latest_telemetry set (security_invoker = true);

-- --- 2. drop the open read policies ----------------------------------
-- F-1 from the architecture review. Reads are now server-side and scoped by
-- org in lib/fleetQueries.ts; nothing legitimate reads these as anon.
drop policy if exists "public read telemetry"    on public.telemetry_samples;
drop policy if exists "public read alert_rules"  on public.alert_rules;
drop policy if exists "public read alert_events" on public.alert_events;

-- --- 3. revoke the SELECT grants -------------------------------------
-- Belt and braces: with the policies gone and security_invoker on, RLS
-- already returns zero rows. Removing SELECT means the attempt fails
-- outright instead of silently returning an empty set, which is far easier
-- to diagnose if some forgotten call site still tries.
revoke select on public.assets            from anon, authenticated;
revoke select on public.telemetry_samples from anon, authenticated;
revoke select on public.alert_rules       from anon, authenticated;
revoke select on public.alert_events      from anon, authenticated;
revoke select on public.public_assets     from anon, authenticated;
revoke select on public.latest_telemetry  from anon, authenticated;

-- --- 4. close the by-uuid telemetry read ------------------------------
-- asset_telemetry_15min(p_asset_id, p_hours) was granted to anon, so anyone
-- holding an asset uuid could pull that asset's history regardless of which
-- tenant owned it. Only the server calls it now (service role), through
-- loadAssetDetailForOrg / loadHeliumSeriesForOrg, both of which verify the
-- asset belongs to the caller's org first.
revoke execute on function public.asset_telemetry_15min(uuid, integer)
  from anon, authenticated;
grant execute on function public.asset_telemetry_15min(uuid, integer)
  to service_role;

-- --- verification (run after applying) -------------------------------
-- Expect: every object BLOCKED (permission denied) for anon.
--
--   create temp table _v(line text);
--   do $$
--   declare
--     v_objs text[] := array['public.assets','public.public_assets',
--                            'public.telemetry_samples','public.latest_telemetry',
--                            'public.alert_rules','public.alert_events'];
--     v_out text[] := '{}'; v_o text; v_n bigint;
--   begin
--     set local role anon;
--     foreach v_o in array v_objs loop
--       begin
--         execute format('select count(*) from %s', v_o) into v_n;
--         v_out := v_out || (v_o || ' -> ' || v_n || ' rows STILL VISIBLE');
--       exception when others then
--         v_out := v_out || (v_o || ' -> BLOCKED');
--       end;
--     end loop;
--     reset role;
--     insert into _v select unnest(v_out);
--   end $$;
--   select * from _v;
