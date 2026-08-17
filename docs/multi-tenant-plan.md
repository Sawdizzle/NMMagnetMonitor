# Multi-tenant plan

Rescope the app from "Numed's fleet" to "N companies, one deployment". Numed
becomes org #1, the demo becomes a real org, and a user can belong to several
orgs with a different role in each.

Decisions taken (2026-08-17):

1. **Enforcement: server-side session.** PIN login sets an httpOnly cookie; all
   fleet reads move server-side and run with the service role, filtered by the
   session's active org. The public-read RLS policies go away. The browser stops
   holding credentials and stops talking to Supabase directly.
2. **Demo is a real org**, seeded with generated data on a cron. `demoFixtures.ts`
   and the second rendering path are deleted.
3. **Many-to-many membership.** `org_members` carries the role, so one person can
   be admin of Numed and viewer of Demo, and a contractor can cover two client
   companies from one account.

## Why the current shape can't do this

`lib/supabase.ts:6` builds a browser client with the anon key, which ships in the
JS bundle. `telemetry_samples`, `alert_rules` and `alert_events` carry
`for select to public using (true)` (schema.sql:1153-1155), and assets are exposed
through the `public_assets` view. So today every row is readable by anyone who
opens devtools. An org dropdown in the admin panel would filter the UI while
leaving the data open — cosmetic isolation.

Second problem: `lib/auth.tsx:7` persists `{ username, pin, role, tvAccess }` —
plaintext PIN — in `localStorage`, and every admin RPC takes `p_actor_pin`. One
trusted company can live with that. Several cannot.

## What already fits

- **`lib/dataSource.ts`** is a single `DataSource` interface with two
  implementations behind `getDataSource(demo)`. All fleet reads are 6 queries in
  this one file (lines 59-135). This is the only place reads have to move.
- **`lib/brand.ts`** already splits `realBrand` / `demoBrand` with exactly the
  fields a tenant needs. Those become columns on `orgs`.
- **Every mutation is a `SECURITY DEFINER` RPC behind one `is_admin()` gate**, so
  there is a single authorization pattern to change rather than 30 ad-hoc ones.
- **`sites` was folded into `assets`**, so `assets` is the only table needing an
  `org_id`. Telemetry, alerts and audit all scope transitively through it.

## Schema

```sql
create table public.orgs (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,        -- 'numed', 'demo'
  name         text not null,               -- 'Numed, Inc'
  product_name text not null default 'Magnet Monitor',
  eyebrow      text not null,               -- was Brand.eyebrow
  tagline      text not null,               -- was Brand.tagline
  invite_code  text,                        -- per-org; replaces app_settings.invite_code
  is_demo      boolean not null default false,
  created_at   timestamptz not null default now()
);

create table public.org_members (
  user_id    uuid not null references public.users(id) on delete cascade,
  org_id     uuid not null references public.orgs(id) on delete cascade,
  role       text not null default 'viewer' check (role = any (array['admin','viewer'])),
  tv_access  boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, org_id)
);

create table public.user_sessions (
  token_hash text        primary key,       -- sha256 of the cookie value
  user_id    uuid        not null references public.users(id) on delete cascade,
  active_org uuid        references public.orgs(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
```

Column changes:

- `assets.org_id` → `orgs`, **not null**.
- `alert_rules.org_id` → `orgs`. Needed because the 4 seeded fleet defaults use
  `asset_id = NULL` to mean "all assets"; that must become "all assets **in this
  org**" or Numed's thresholds leak onto every tenant.
- `audit_log.org_id` so `admin_list_audit_log` can scope.
- `users.is_superadmin boolean` — cross-org access for the operator (Shawn).
- `users.role` and `users.tv_access` migrate into `org_members`, then drop.
- `app_settings.invite_code` retires in favour of `orgs.invite_code`.

## Phases

Ordering is load-bearing: **do not drop the public-read policies until Phase 2
lands**, or the live app goes dark.

### Phase 0 — schema + backfill ✅ DONE 2026-08-17
Applied as migration `multi_tenant_phase0_orgs_and_backfill`; `supabase/schema.sql`
updated to match. Backfilled 17 assets, 7 alert rules (6 of them fleet-wide) and
34 audit rows onto org `numed`; created 3 memberships. Telemetry ingest verified
unaffected afterwards.

Two things differed from the plan as written. `org_id` on `assets` and
`alert_rules` carries a `default public.default_org_id()` rather than a bare
`NOT NULL`, because `admin_create_asset`, `admin_upsert_alert_rule` and
`_record_audit` all insert without one and would have broken instantly; Phase 3
passes it explicitly and drops the defaults. And the empty `demo` org row was
created here rather than in Phase 4, since it costs nothing and gives Phase 4 a
target.

Create the tables above. Create org `numed` ("Numed, Inc"), stamp every existing
asset, alert rule and audit row with its id, and convert each existing user's
`role`/`tv_access` into an `org_members` row against it. Purely additive; the
running app keeps working untouched.

### Phase 1 — server-side session — 1a/1b DONE 2026-08-17, 1c pending

**1a (done)** — migration `multi_tenant_phase1_session_rpcs`: `create_session`,
`resolve_session`, `switch_active_org`, `destroy_session`,
`cleanup_expired_sessions` (+ nightly cron). Granted to `service_role` only, so
anon cannot reach PIN verification at all — that also closes the F-4
brute-force surface. Self-tested end to end on a throwaway user: wrong PIN
returns no rows and records a strike, the raw token is never stored, a bogus
token resolves empty, a destroyed session is dead, and **a numed-only member is
refused the demo org**.

Also fixed here (migration `multi_tenant_register_user_joins_org`): `register_user`
inserted into `users` only, so after Phase 0 any new signup would have landed
with no membership and seen an empty app. It now resolves the invite code to an
org and creates the membership.

**1b (done)** — `lib/supabaseServer.ts` (service-role client, `server-only`),
`lib/session.ts` (React `cache()`-memoized DAL per the Next 16 auth guide), and
`lib/authActions.ts` (login / logout / switchOrg server actions). Typechecks.
**Not yet exercised end to end** — needs `SUPABASE_SERVICE_ROLE_KEY` in
`.env.local` and in Vercel.

Next 16 note: `middleware.ts` is deprecated in favour of **`proxy.ts`**. If we
add optimistic route gating, it goes in `proxy.ts` and must read the cookie
only — no DB calls, since it runs on prefetches too.

#### 1c must land together with Phase 3

`app/admin/page.tsx` passes `me.pin` to **25** admin RPCs as `p_actor_pin`. The
moment the client session stops carrying the plaintext PIN, every one of those
breaks. So "retire localStorage" and "org-scope the RPCs" are a single cutover,
not two phases — the admin panel has to move to server actions that read the
session in the same change. Sequencing them apart would leave the admin panel
dead in between.

Original Phase 1 sketch, for reference:
`user_sessions` + a login route handler that verifies the PIN, mints a token, and
sets it httpOnly/secure/sameSite=lax. Session resolution becomes a server helper
returning `{ user, activeOrg, role, isSuperadmin, memberships }`. Add the org
switcher (needed now that membership is many-to-many). Retire the localStorage
session in `lib/auth.tsx`.

### Phase 2 — reads move server-side
Rewrite `lib/dataSource.ts` as server-only, taking `org_id` from the session and
filtering all 6 queries by it. Dashboard / AssetDetail / TvWall receive data as
props from server components instead of fetching. Then, and only then, drop the
three public-read policies and the `public_assets` view's open grant.

Deletions this phase: `demoDataSource`, `lib/demoFixtures.ts`, `getDataSource()`,
and the `demo` branch in `lib/demoContext`. One data path from here on.

### Phase 3 — org-scope the RPCs
Replace `is_admin(p_username, p_pin)` with a session-token + org check, and add
an org guard to every admin RPC so an admin of one org cannot touch another's
assets. 26 call sites in `app/admin/page.tsx`. `admin_get_asset_config` and
`admin_rotate_gateway_token` matter most — they expose gateway credentials.

**Do not touch `report_telemetry` or `report_telemetry_batch`.** They authenticate
by per-asset `gateway_token` and 17 field Pis depend on them. They stay
unchanged; `org_id` is derivable from the asset they already resolve.

### Phase 4 — demo org + generator
Seed org `demo` (`is_demo = true`) with the 12 assets currently in
`demoFixtures.ts` — including the anonymised site names, since the fixtures had a
real hospital name and address in them once already. A pg_cron generator keeps
recent telemetry flowing so the demo looks alive.

Sizing: 12 assets × 1440 min/day × 7-day retention ≈ 121k rows, which the
existing `cleanup_old_telemetry` purge already bounds. Worth watching against
free-tier headroom, not worth worrying about.

The generator must reproduce the states the fixtures deliberately staged: a
router-offline unit, a Tailscale-offline unit, a maintenance unit, a cooling
failure, and a low-helium unit with negative boil-off. Those are what make the
demo demonstrate anything.

### Phase 5 — admin panel
Org CRUD, membership management (the assignment UI, now multi-select per user
since one user can hold several orgs), per-org invite codes, and an org picker
for superadmins. Brand fields become editable so a new company can be turned up
without a deploy.

## Open questions

- **`/tv` on a shared wall.** Currently `tv_access` gates a logged-in user. A wall
  display in a hospital corridor probably wants a long-lived per-org display
  token instead of a human session. Worth deciding before Phase 1 fixes the
  session shape.
- **Alert recipients** are global today. Per-org routing is required before any
  outside customer, or Numed gets paged for another company's magnet.
- **`/demo` URL.** Keep it as a route that auto-logs-in the Demo user, or send
  prospects to the normal login with published credentials?
