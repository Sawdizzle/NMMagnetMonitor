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
- [x] **Phase 2 — surface in-app.** Asset page shows persisted `alert_events`
  (open + recent resolved, with durations) via the public-read policy. Admin
  Alerts tab gained a **recipients editor** and a **recent-alerts log** on top of
  the existing rules editor, backed by new RPCs `admin_list/upsert/delete_alert_recipient`
  + `admin_list_alert_events` (migration `admin_alert_recipient_and_event_rpcs`,
  verified live). *(Optional remaining: a fleet-level persisted-alert count on the
  dashboard alongside the client-derived ticker.)*
- [x] **Phase 3 — notifications LIVE (channel = Resend email).** Done 2026-08-12:
  `notify-alerts` edge fn redeployed (v3) with debounce (only emails events open
  ≥ `ALERT_DEBOUNCE_MINUTES`, default 5); `pg_net` enabled; recipient added; cron
  job `notify-alerts` (`* * * * *`) invokes the fn over `net.http_post` right
  alongside the evaluator. Controlled test returned HTTP 200 `{"sent":1,"events":6}`
  and stamped all six. **Caveat:** `ALERT_FROM = onboarding@resend.dev` (Resend
  test sender) delivers **only to the Resend account's own email**. For
  fleet-wide / multiple recipients, verify a domain in Resend (e.g.
  `numedmagnetdata.com`) and set `ALERT_FROM` to an address on it.
  *(Remaining polish: coldhead-from-blob check so emails match the TV; richer
  email formatting; optional per-rule debounce windows.)*

### Phase 4 — sender identity (2026-08-18)

**Decision: one verified sending domain, per-company identity on top of it.**

The alternative — each customer's alerts arriving from `alerts@theirdomain.org`
— was considered and rejected. SPF and DKIM for that From have to be published
in the *customer's* DNS, and hospitals enforce DMARC, so without those records
the alert is junked or refused. It would put a customer IT ticket in front of
every onboarding, and put alert delivery at the mercy of a DNS change nobody
here would see until a magnet quenched quietly. Reputation is also per-domain:
one warmed domain beats seventeen cold ones.

What makes it per-company anyway, with zero customer DNS:

| Field | Column | Who edits | Default when blank |
|---|---|---|---|
| Display name | `orgs.alert_from_name` | company admin | `name` + `product_name` |
| Reply-To | `orgs.alert_reply_to` | company admin | no header (unmonitored) |
| Subject prefix | `orgs.alert_subject_prefix` | company admin | `product_name` |
| Address | `orgs.alert_from` | **superadmin** | platform address |
| Platform address | `app_settings.alert_from` | **superadmin** | `ALERT_FROM` secret |

The display name is what a recipient reads in an inbox list, and Reply-To is
what routes an answer back to their people — so the mail reads as theirs while
leaving from an address Numed controls. `orgs.alert_from` survives as a
bring-your-own-domain upgrade, but is superadmin-only now: it was settable by
any company admin to any string, and an unverified sender fails every send
silently, once a minute, forever.

Subjects now name the magnet instead of counting alerts. `MagMon: 1 active
alert` became `Magnet Monitor: NM1035 h2o_temp > 75 (now 100.476)`, and a
digest reads `Magnet Monitor: 3 alerts — NM1027, NM1020 +1 more`. `send-push`
composes its title the same way off the same prefix, so the two channels stay
in step. Deliberately **not** a subject template language: `{{asset}}` strings
are a support burden and a header-injection surface for no gain.

One trap worth remembering: `Numed, Inc Magnet Monitor` contains a **comma**,
which is the address separator in a mail header — unquoted it parses as two
broken addresses. `encodeDisplayName()` in `notify-alerts` RFC-quotes anything
with a special character and falls back to an RFC 2047 encoded-word for
non-ASCII.

**Still open — the part that makes any of this deliver.** `ALERT_FROM` is
still Resend's test sender, which only ever delivers to Numed's own Resend
account. Until the domain is verified, a second recipient silently receives
nothing:

1. Add the sending domain in Resend — use a **subdomain**
   (`alerts.numedmagnetdata.com`). The root SPF is
   `include:websitewelcome.com` for HostGator; a subdomain leaves website mail
   untouched and isolates alert reputation from it.
2. Add the DKIM/SPF/MX records Resend generates. DNS is on Cloudflare
   (`margot`/`vin.ns.cloudflare.com`), so this is Numed's to do.
3. There is **no DMARC record** on the domain today. Add `_dmarc` at `p=none`
   first to collect reports without risking delivery, then tighten.
4. Set the platform address in Admin → Alerts → Sender identity, and confirm
   with a recipient's **Test** button.

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
