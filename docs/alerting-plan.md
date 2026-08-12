# Alerting implementation plan

**Status (2026-08-12):** Phase 1 LIVE. The evaluator + tables + admin rule RPCs
+ seed rules already existed on the live DB; on 2026-08-12 we (a) patched
`evaluate_alerts()` to exempt maintenance units — migration
`evaluate_alerts_exempt_maintenance` — and (b) scheduled it every minute via
pg_cron job `evaluate-alerts`. So `alert_events` now fills continuously (no
emails yet). Remaining: surface persisted alerts in-app + admin Alerts UI
(Phase 2), then notifications with debounce (Phase 3).
**Goal:** turn the dashboard into a monitor that *tells someone* when a magnet
is in trouble or a gateway goes dark, instead of only showing it to whoever
happens to be looking. (Architecture review finding **F-2**.)

## Rollout status

- [x] **Phase 1 — evaluator safe + scheduled.** Maintenance exemption applied;
  `evaluate-alerts` cron runs `evaluate_alerts()` every minute. Dry-run confirmed
  no phantom alarms on NM1001/NM1034/NM1037; real events open for NM1003 (offline),
  NM1006/NM1027 (h2o_temp/flow), NM1035 (he_press, borderline).
- [ ] **Phase 2 — surface in-app.** Read persisted `alert_events` on the
  dashboard + asset pages; admin Alerts UI (rules editor over existing
  `admin_*_alert_rule` RPCs, recipients editor, event log).
- [ ] **Phase 3 — notifications.** Channel = Microsoft Graph `sendMail` (email,
  from the M365 domain) and/or RingCentral REST (SMS) — both HTTPS from the
  notifier, not SMTP/sockets. Add per-rule **debounce** (N consecutive
  violations) before enabling outbound, or a flapping metric like `he_press`≈3
  will spam. Needs: provider app registration + secrets (user-provided),
  recipients, and scheduling the notifier.

### Tuning backlog (needs the physicist/engineer)
- `he_press > 3.0` flaps near threshold (NM1035 3.318, NM1004 in/out) — raise it
  or add debounce.
- No `he_lvl` low rule — NM1004 read **0.69%** helium and nothing alerted. Add a
  `he_lvl <` rule.
- Coldhead (lives in the `data` blob) isn't evaluated in SQL, so email/persisted
  alerts don't match the TV's coldhead-warming detection. Add a blob-aware check
  (dovetails with the #4 coldhead RPC).

---

## What already exists (the head start)

Introspecting the live database (2026-08-10) showed the foundation is already
in place:

| Piece | State |
|-------|-------|
| `alert_rules` table (`asset_id, field, comparator, threshold, enabled`) | exists, **empty** |
| `alert_events` table (`asset_id, alert_rule_id, kind, message, triggered_at, resolved_at`) | exists, **empty** |
| `pg_cron` extension (the scheduler) | **installed** (v1.6.4) |
| `assets.last_seen_at` + `assets.offline_threshold_minutes` | populated by `report_telemetry` on every reading |
| `latest_telemetry` view (newest reading per asset) | exists |

So this is **wiring, not design**. Three things are missing: (1) something that
evaluates the rules on a schedule, (2) a way to notify a human, and (3) a small
UI to manage rules and see active alerts.

---

## Two kinds of alert

1. **Offline** — an asset stopped reporting. Derived from `last_seen_at` vs the
   asset's own `offline_threshold_minutes`. No `alert_rules` row needed; it
   applies to every asset automatically.
2. **Threshold** — a metric crossed a limit (e.g. `he_lvl < 60`). Driven by
   `alert_rules` rows. `field` is a telemetry column, `comparator` is one of
   `< <= > >=`, `threshold` is the number.

Both open an `alert_events` row when the condition starts and set `resolved_at`
when it clears — so the events table is a clean history of "what went wrong and
for how long," and we never fire the same alert twice.

---

## Step 1 — one schema addition

The only DB change needed beyond what exists: a way to know which events have
already been notified (so cron doesn't email the same alert every minute), and
who to notify.

```sql
-- track notification delivery on each event
alter table public.alert_events
  add column if not exists notified_at timestamptz;

-- who receives alerts (start global; becomes per-org at multi-tenant time)
create table if not exists public.alert_recipients (
  id         uuid primary key default gen_random_uuid(),
  channel    text not null check (channel in ('email','sms')),
  address    text not null,          -- email address or E.164 phone number
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.alert_recipients enable row level security;
-- no public policy: readable/writable only via admin RPCs (like users/assets)
```

## Step 2 — the evaluator function

A single `SECURITY DEFINER` function that opens and resolves events. It is
idempotent: safe to run every minute, never double-fires.

```sql
create or replace function public.evaluate_alerts()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
begin
  ----------------------------------------------------------------
  -- OFFLINE: open events for assets past their threshold
  ----------------------------------------------------------------
  for r in
    select a.id, a.name, a.last_seen_at, a.offline_threshold_minutes
    from assets a
    where a.last_seen_at is not null
      and a.last_seen_at < now() - make_interval(mins => a.offline_threshold_minutes)
  loop
    -- only if there isn't already an unresolved offline event
    if not exists (
      select 1 from alert_events e
      where e.asset_id = r.id and e.kind = 'offline' and e.resolved_at is null
    ) then
      insert into alert_events (asset_id, kind, message)
      values (r.id, 'offline',
              format('%s has not reported since %s', r.name, r.last_seen_at));
    end if;
  end loop;

  -- OFFLINE: resolve when the asset is reporting again
  update alert_events e
    set resolved_at = now()
  from assets a
  where e.asset_id = a.id
    and e.kind = 'offline'
    and e.resolved_at is null
    and a.last_seen_at >= now() - make_interval(mins => a.offline_threshold_minutes);

  ----------------------------------------------------------------
  -- THRESHOLD: evaluate each enabled rule against the latest reading
  ----------------------------------------------------------------
  for r in
    select ar.id as rule_id, ar.asset_id, ar.field, ar.comparator, ar.threshold,
           a.name,
           case ar.field
             when 'he_lvl'   then lt.he_lvl
             when 'he_press' then lt.he_press
             when 'h2o_flow' then lt.h2o_flow
             when 'h2o_temp' then lt.h2o_temp
             when 'shield'   then lt.shield
             when 'cs1'      then lt.cs1
           end as value
    from alert_rules ar
    join assets a on a.id = ar.asset_id
    join latest_telemetry lt on lt.asset_id = ar.asset_id
    where ar.enabled
  loop
    if r.value is null then continue; end if;

    if (r.comparator = '<'  and r.value <  r.threshold)
    or (r.comparator = '<=' and r.value <= r.threshold)
    or (r.comparator = '>'  and r.value >  r.threshold)
    or (r.comparator = '>=' and r.value >= r.threshold)
    then
      if not exists (
        select 1 from alert_events e
        where e.alert_rule_id = r.rule_id and e.resolved_at is null
      ) then
        insert into alert_events (asset_id, alert_rule_id, kind, message)
        values (r.asset_id, r.rule_id, 'threshold',
                format('%s %s %s %s (was %s)', r.name, r.field, r.comparator, r.threshold, r.value));
      end if;
    else
      -- condition cleared -> resolve any open event for this rule
      update alert_events
        set resolved_at = now()
      where alert_rule_id = r.rule_id and resolved_at is null;
    end if;
  end loop;
end;
$$;
```

## Step 3 — schedule it

`pg_cron` is already installed, so this is one statement:

```sql
select cron.schedule('evaluate-alerts', '* * * * *', $$ select public.evaluate_alerts(); $$);
```

That runs the evaluator every minute. (Offline detection is only as fast as this
interval — one minute is plenty for MRI cryogenics.)

## Step 4 — notify a human

Two clean options; recommended first:

**A. Edge Function + cron (recommended).** A Supabase Edge Function `notify-alerts`
that: selects `alert_events` where `notified_at is null`, sends each via Resend
(email) and/or Twilio (SMS) to `alert_recipients`, then stamps `notified_at`.
Schedule it with `pg_cron` + `pg_net` (both available) every minute, right after
the evaluator. Keeps all secrets (Resend/Twilio keys) in Edge Function env vars,
never in the database or the browser.

```
supabase/functions/notify-alerts/index.ts
  1. service-role client (server-side only)
  2. select unnotified events (join assets for names)
  3. for each recipient x each event -> send
  4. update alert_events set notified_at = now()
```

**B. Database webhook.** Supabase "Database Webhooks" on `insert into alert_events`
→ POST to the same Edge Function. Simpler to wire, but fires per-row and is
harder to batch/rate-limit. Prefer A.

## Step 5 — the UI (small)

- **Admin → Alerts:** a per-asset list of `alert_rules` (field dropdown,
  comparator, threshold, enable toggle) using new `admin_*` RPCs that mirror the
  existing asset CRUD. Plus a recipients editor for `alert_recipients`.
- **Dashboard:** a badge on any asset card with an unresolved `alert_events` row,
  and a top-level "N active alerts" pill next to the online/offline counts.
- **Asset page:** an "Alerts" section showing open + recent events.

---

## Rollout order (low-risk first)

1. Apply Step 1 (schema add) and Step 2 (function) — inert until scheduled.
2. **Dry run:** `select public.evaluate_alerts();` by hand, inspect
   `alert_events`. Tune thresholds against real data before anything is sent.
3. Add a couple of `alert_recipients` and the `notify-alerts` function; test with
   one throwaway rule you can trigger on purpose.
4. Schedule both cron jobs (Step 3).
5. Build the UI last — the safety net works headless before any screen exists.

## Notes / decisions to make

- **Suggested starting thresholds** (confirm with the physicist/engineer):
  `he_lvl < 60`, `h2o_flow < 0.5`, `h2o_temp > 55`. Offline uses each asset's
  existing `offline_threshold_minutes` (default 15).
- **Escalation / quiet hours / de-dupe windows** — out of scope for v1; the
  open/resolved model makes them easy to add later.
- **Multi-tenant:** when orgs arrive, `alert_recipients` (and rules) get an
  `org_id` and the notifier scopes per org. Designed to extend, not rewrite.
```
