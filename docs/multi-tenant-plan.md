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
anon cannot reach *these* RPCs at all. ⚠ This does **not** close F-4 — an earlier
version of this line claimed it did. F-4 is the `is_admin()` path reached through
the 23 anon-executable `admin_*` RPCs; see the F-4 subsection under Phase 2 and
Phase 3 below. Self-tested end to end on a throwaway user: wrong PIN
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

### Phase 2 — reads move server-side — CODE DONE 2026-08-17, cutover pending

Built: `lib/fleetQueries.ts` (org-scoped server reads), `lib/apiAuth.ts`
(`requireOrgScope` + clamped query parsing), five route handlers under
`app/api/`, and `liveDataSource` in `lib/dataSource.ts` rewritten to fetch them.
`app/admin/page.tsx`'s one direct `public_assets` read now goes through
`/api/assets`. **Dashboard, AssetDetail and TvWall are unchanged**, as intended.
Typecheck passes; `next build` compiles and then stops at the deliberate
`SUPABASE_SERVICE_ROLE_KEY` guard.

Two safety details worth keeping:
- Per-asset routes verify the asset belongs to the caller's org before touching
  telemetry (`assetInOrg`). `telemetry_samples`, `alert_events` and
  `asset_telemetry_15min` carry no org of their own, so without that check a
  known uuid would read across tenants.
- "Another tenant's asset" and "no such asset" return the identical 404 shape, so
  the endpoint can't be used as an existence oracle for uuids.

The eager throw in `lib/supabaseServer.ts` is kept on purpose: a Vercel deploy
missing the key fails the *build*, leaving the previous version live, which for a
monitoring tool beats a green deploy where every request 500s.

**Sequencing correction.** Phase 2 is NOT independently deployable as first
written: `dataSource` now needs the cookie session, but `lib/auth.tsx` logged in
via `verify_user_login` into localStorage and never set a cookie, so `/api/fleet`
would answer 401 and the dashboard would come up empty. Fixed with a bridge —
`login()` now calls `loginAction` (minting the cookie) and *keeps* writing the
localStorage copy so the admin panel's `me.pin` survives until Phase 3.

The bridge deliberately calls `create_session` **instead of**, not in addition
to, `verify_user_login`. Running both would record two failed attempts per bad
PIN and trip the 5-strike lockout after three tries. `loginAction` therefore
returns the resolved session context so the client still gets role/tvAccess in
one round-trip. On mount, a live cookie is authoritative; if it has expired but
localStorage still holds credentials, the session is silently re-minted rather
than bouncing the user — losing a wall display to a cookie expiry would be a
regression.

**Verified end to end 2026-08-17** against the live DB (throwaway `_e2e` account,
member of both orgs, removed afterwards):

| check | result |
| --- | --- |
| unauthenticated `/api/fleet` | 401 `Not signed in` |
| forged cookie | 401 |
| authenticated fleet | 17 assets, 1000 history rows, no `*token*`/`*password*` fields |
| asset detail (NM1035) | 96 buckets, latest he_lvl 75.062, 287 helium points |
| **switch to demo → same numed asset** | **404 on detail, helium AND alerts** |
| switch to demo → fleet | 0 assets |
| browser login through the bridge | dashboard live, 17 assets / 13 sites |
| requests to `*.supabase.co` from the browser | **zero** — all `/api/*` |
| `document.cookie` | session not readable from JS |

**Known follow-up (not a regression):** the Dashboard fires one
`/api/asset/<id>/helium` request per asset — 17 round trips per forecast refresh.
It was already N+1 against Supabase before, but each now also costs an
`assetInOrg` pre-check, so ~34 DB queries per refresh. A batch
`/api/fleet/helium` endpoint would collapse it to one request, at the cost of a
new `DataSource` method and touching Dashboard.

**Cutover APPLIED 2026-08-17 — F-1 closed. F-4 only PARTIALLY mitigated.**

⚠ Correction: an earlier commit message on this branch claimed F-4 was closed.
It is not. See the F-4 subsection below before relying on that.

Merged to `main` as `8cdf351`; production deployed and verified on
`www.nmmagmon.com` (note: the apex 308-redirects to www, so www is canonical).
Only then did the lockdown run, as two migrations:

1. `phase2_close_public_reads` — security_invoker on both views, the three
   public-read policies dropped, SELECT revoked from anon/authenticated.
2. `phase2_revoke_public_execute_on_legacy_auth_rpcs` — because the first one
   **didn't actually work** for functions.

**The Postgres gotcha worth remembering:** functions grant `EXECUTE` to the
`PUBLIC` pseudo-role by default — the ACL reads `=X/postgres`, where the bare
`=` *is* the PUBLIC grant — and anon inherits it. So
`revoke ... from anon` is a no-op; you must revoke from `public` too. The
post-migration probe caught `asset_telemetry_15min -> STILL CALLABLE` while every
table read was already BLOCKED. Any uuid holder could still have pulled that
asset's history across tenants.

#### F-4 is still open — read this before trusting the commit messages

Two claims on this branch were wrong and are corrected here.

Phase 1a did **not** close F-4 by moving login to `create_session`:
`verify_user_login` stayed anon-callable, so an attacker could ignore the app
and hammer the RPC with the publishable key. Now revoked, along with
`record_login_failure` and `log_session_event` (unused since the bridge).
`reset_own_pin` calls `verify_user_login` internally and is fine — it's
`SECURITY DEFINER`, so the nested call runs as the owner.

But that was never F-4's main surface. As the architecture review recorded it,
F-4 is **`is_admin(username, pin)` applying no lockout while being reachable by
anon through all 23 `admin_*` RPCs**. Measured after the lockdown: all 23 plus
`is_admin` itself were still anon-callable.

Mitigated so far (`revoke_public_execute_on_is_admin`): `is_admin` is revoked
from PUBLIC. It was the cleanest oracle — a plain boolean return, so
`select is_admin('admin','0000')` was a direct PIN check with no rate limit, no
lockout and no audit trail. Safe to revoke because no client code calls it and
all 23 SQL callers are `SECURITY DEFINER`. Verified afterwards: the oracle is
BLOCKED, and `admin_list_users` still works with a wrong PIN correctly rejected.

**Still open.** The 23 `admin_*` RPCs remain anon-executable and each
distinguishes a right PIN from a wrong one via its `not authorized` exception, so
a slower oracle survives — still no lockout on that path. **Phase 3 is the real
fix**: replace the `(p_actor_username, p_actor_pin)` pair with the session
cookie, then revoke the grants outright. Until then, treat the admin PIN as
brute-forceable and make it long.

Final state, verified against production:

| surface | anon |
| --- | --- |
| assets, public_assets, telemetry_samples, latest_telemetry, alert_rules, alert_events | BLOCKED |
| `asset_telemetry_15min` | BLOCKED |
| `verify_user_login`, `record_login_failure` | BLOCKED |
| `create_session` and the session RPCs | BLOCKED |
| **`report_telemetry`, `report_telemetry_batch`** | **granted — the 17 Pis need them** |

App unaffected throughout: every page 200, fleet 17 assets / 1000 history rows,
detail 97 buckets, helium 288 points, alerts 5 events, and ingest never paused
(10 rows from 8 assets in the 3 minutes after the lockdown, newest 9s old).

**Found while scoping this (fixed 2026-08-17, migration `revoke_anon_write_grants`):**
the read exposure was worse than "public-read policies". `public_assets` and
`latest_telemetry` were created without `security_invoker`, so they run with the
view owner's rights and bypass the underlying RLS completely — anon sees 0 rows
in `assets` but all 17 through `public_assets`. And `public_assets`, being a
simple single-base-table view, is auto-updatable, while anon held Supabase's
default INSERT/UPDATE/DELETE grants on it. The anon key ships in the JS bundle,
so it was a live write path into Numed's assets, not just a read leak.

All write grants are now revoked from anon/authenticated on every table and both
views; reads and collector ingest verified unaffected. `security_invoker` and the
SELECT grants are deliberately left alone — flipping them now blacks out the
dashboard, so they close as part of this phase's cutover.

**Implementation note (settled):** `lib/dataSource.ts` is already a `DataSource`
interface consumed by three polling client components. Rather than converting
Dashboard / AssetDetail / TvWall into server components (which would break their
`setInterval` refresh), keep the interface and reimplement `liveDataSource` to
`fetch` org-scoped route handlers (`/api/fleet`, `/api/asset/[id]`, …). The
route handlers resolve the session, take `activeOrgId`, and filter. The three
components then need **no changes at all**, and polling keeps working.

`demoDataSource` stays on fixtures through this phase — `/demo` is
unauthenticated and has no session until Phase 4 seeds the demo org and we
settle how `/demo` logs in.

Original sketch:
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

### Phase 3 — org-scope the admin RPCs — IN PROGRESS (started 2026-08-17)

Closing what's left of F-4. Sequenced around one hard constraint: **a DB
migration hits production instantly, while code only changes on deploy.** So the
new session-authenticated functions are added as OVERLOADS taking `p_token`, and
the old `(p_actor_username, p_actor_pin)` signatures stay live until the new app
ships. Parameter names differ and supabase-js calls RPCs with named arguments,
so resolution is unambiguous. Dropping the old signatures + revoking anon is
Phase 3c, and that is the step that actually closes F-4.

**Done (DB):**
- `_admin_actor(p_token)` — the single authorization gate replacing `is_admin()`.
  Resolves the session, demands the admin role, returns the active org every
  scoped statement filters by. Raises rather than returning null, so a caller
  that forgets to check gets an exception instead of unscoped access.
- `_record_audit` gained `p_org_id`. It previously relied on `audit_log.org_id`'s
  column default (`default_org_id()`), so an action in *any* org was stamped
  `numed`. The 5-arg version was dropped and recreated with a defaulted 6th
  param — keeping both would have made every legacy 5-arg call ambiguous.
- `alert_recipients.org_id`, backfilled to numed. Recipients were global, so
  once a second company existed Numed would have been paged for its magnets.
- All six asset RPCs, org-scoped. Two gained audit rows they never had:
  `admin_delete_asset` (deleting a unit and cascading its telemetry was
  untraceable) and `admin_rotate_gateway_token` (breaks that Pi until redeployed).

Verified on the live DB with a throwaway admin in both orgs: viewer refused;
cross-org config read returns 0 rows; cross-org update / rotate / delete /
maintenance all refused with `Asset not found.`; and a create lands in the
**active** org, not numed. Positive paths were exercised on a throwaway asset —
deliberately never rotating a real unit's gateway token, which would break that
Pi until redeployed. Fleet confirmed untouched afterwards (17 assets, ingest
uninterrupted).

**Remaining:**
1. User RPCs — `admin_create_user` (must also create the `org_members` row),
   `admin_list_users` (scope to the org's members), `admin_set_tv_access` /
   `admin_set_role` (write the MEMBERSHIP, not `users`), `admin_reset_pin`,
   `admin_set_invite_code` (write `orgs.invite_code`, not the global
   `app_settings`). `set_role` and `reset_pin` currently write no audit row —
   privilege and credential changes should be audited.
2. Alert + audit RPCs — rules and recipients by `org_id`, events via the asset's
   org, audit log by `org_id`. `alert_from` is still a global `app_settings` key;
   per-org sending addresses probably want `orgs.alert_from`.
3. App layer — `lib/adminActions.ts` server actions + the 25 call sites in the
   1788-line `app/admin/page.tsx`.
4. Drop `pin` from the client `Session`, add the org switcher UI.
5. Phase 3c — drop the old signatures, revoke anon. **F-4 closes here.**

---

## ⚠ BLOCKER before any second tenant goes live: the alerting pipeline is not org-aware

Found while org-scoping the alert RPCs (2026-08-17). The admin RPCs are now
correctly per-org, but the **edge functions that actually send** are not. Today
this is harmless — only Numed has assets, recipients and push subscriptions — so
nothing is misrouted right now. The moment a second org has either, it breaks,
and it breaks in the worst possible way: one company's staff paged about another
company's magnet.

Three concrete gaps:

1. **`notify-alerts` emails every recipient in the database.**
   `supabase/functions/notify-alerts/index.ts:90` selects `alert_recipients`
   with no org filter. It must resolve the alert's asset → that asset's `org_id`
   → only that org's recipients. `alert_recipients.org_id` now exists for this.

2. **`notify-alerts` reads the wrong sending address.** It reads
   `app_settings.alert_from` (index.ts:36-38), while `admin_set_alert_from` now
   writes `orgs.alert_from`. So a per-org sender set in the admin UI is silently
   ignored. It should read `orgs.alert_from` for the alert's org and fall back to
   the global key, then the `ALERT_FROM` secret — the same precedence
   `admin_get_alert_from` implements. Note `app_settings` currently has **no**
   `alert_from` row, so the live behaviour is the secret and nothing regressed.

3. **`send-push` pushes to every subscription in the database.**
   `supabase/functions/send-push/index.ts:84-85` selects all of
   `push_subscriptions`. Subscriptions are per-device rows keyed to a user, so
   the fix is to push only to devices of users who are members of the asset's
   org (join `push_subscriptions` → `users` → `org_members`), rather than adding
   an `org_id` to the table.

None of this is on the Phase 3 critical path, but **it must land before onboarding
a real second company** — ahead of Phase 4's demo seeding, since a demo org with
its own recipients would already trip gap 1.

### Phase 3c — DROP the PIN-authenticated admin RPCs ✅ F-4 CLOSED 2026-08-17

Applied as `phase3c_drop_pin_authenticated_admin_rpcs`, after production
(deployment `108d2af`, live on `www.nmmagmon.com`) was confirmed serving the
admin panel through server actions.

Dropped all 22 `admin_*` functions taking `(p_actor_username, p_actor_pin)`,
selected by having a `p_actor_pin` **parameter** rather than by hand-written
signatures — 22 hand-typed signatures is 22 chances to silently miss one.

Verified immediately after:

| check | result |
| --- | --- |
| functions with a `p_actor_pin` parameter | **0** |
| `p_token` admin functions present | 22 |
| `admin_*` or `is_admin` executable by anon | **none** |
| `is_admin` still available to `service_role` | true (notify-alerts needs it) |
| `report_telemetry_batch` still granted to anon | true (the 17 Pis need it) |

Production re-verified afterwards: admin panel loads 17 assets / 7 alerts /
4 users, every page returns 200, no console errors, ingest uninterrupted.

**Why it took three attempts** — worth remembering, because each failure mode
repeats easily:

1. Granting the session RPCs to `service_role` only was claimed as the fix. It
   wasn't: `verify_user_login` stayed anon-callable.
2. Revoking `verify_user_login` was claimed as the fix. It wasn't either — that
   was never F-4's main surface, which is `is_admin()` reached through the
   `admin_*` RPCs. And `revoke ... from anon` on a function is a **no-op**
   while `PUBLIC` still holds EXECUTE (the default, ACL `=X/postgres`).
3. Only dropping the functions actually closed it. Revoking would have left the
   PIN-checking code reachable by anything that regained EXECUTE; while such a
   function exists, its `not authorized` exception is an oracle.

**What is still open** (tracked, not forgotten):
- `Session.pin` still exists for the notify-alerts "Send test" button, whose
  edge function gates on `is_admin(actor_username, actor_pin)` and has no
  session-token path. Teaching it `_admin_actor` + redeploying retires the
  localStorage PIN for good.
- The org switcher UI is not built. Switching works at the DB level
  (`switch_active_org`) and is exercised by tests, but nothing in the UI calls it,
  so a multi-org user is stuck in whichever org `create_session` picked.
- The alerting edge functions are still not org-aware — see the BLOCKER section.

### Phase 3d — org switcher UI ✅ DONE 2026-08-17

`components/OrgSwitcher.tsx` in the nav, backed by a new
`list_switchable_orgs(p_token)` RPC and a `listSwitchableOrgs()` server action.

It **renders nothing when the caller can reach only one org** — the normal case
for a single-company deployment. Numed's users should not see tenancy chrome
that means nothing to them; it appears only for genuinely multi-org users and
superadmins.

The list comes from its own RPC rather than `session.memberships`, because a
superadmin can switch into an org they hold no membership in (`switch_active_org`
exempts them) and those orgs would otherwise be missing. The RPC mirrors
`switch_active_org`'s rule exactly, so the switcher never offers an org the
switch would then refuse.

**A bug caught in testing, worth keeping in mind for anything similar:** the
first version finished with `router.refresh()`. That re-renders the *server*
tree, but Dashboard, AssetDetail and TvWall are client components polling
`/api/*` on their own `setInterval` — so the org label flipped to "Demo Company"
while the fleet kept showing Numed's 17 assets until the next poll. One
company's data under another company's name is exactly what this control exists
to prevent. It now does a full `window.location.reload()`.

Verified in the browser: a two-org user sees the switcher, switching to Demo
shows 0 assets and the empty state, switching back shows all 17 immediately with
label and data in sync; a single-org user sees no switcher at all.

**Gap found while testing — per-org branding is not wired up.** The eyebrow
still read "NUMED · REMOTE MONITORING" while viewing Demo Company. Phase 0 moved
`product_name` / `eyebrow` / `tagline` onto `orgs`, but the UI still reads the
`lib/brand.ts` constants. Wiring it means flowing the active org's brand from
the session into the context `useDemo()` serves. Cosmetic for Numed today,
required before showing a second tenant their own instance.

### Phase 3e/3f — alerting is org-aware, and the localStorage PIN is gone ✅ 2026-08-17

**The BLOCKER above is cleared.** `notify-alerts` (v7) and `send-push` (v4) are
redeployed, both still `verify_jwt: false` as before — changing that would have
broken the pg_cron invocation.

Both now group open events by their asset's `org_id` and fan out **per org**:
`notify-alerts` emails only that org's recipients from that org's sending
address (`org_alert_from`, falling back to the legacy global key then the
`ALERT_FROM` secret); `send-push` pushes only to that org's members' devices via
`org_push_subscriptions` (`push_subscriptions -> users -> org_members`).
Subscriptions with a NULL username can't be attributed to an org and are
excluded — pushing one tenant's alerts to an unattributable device is the leak
this exists to stop. An org with no recipients leaves its events *unstamped*, so
they still send once someone is configured, matching the old behaviour.

The test mode now takes a **session token** (validated with `_admin_actor`)
instead of `actor_username`/`actor_pin`, and additionally refuses any address
that is not already a recipient of the caller's org — without that, an admin of
any org could use it as an email relay to arbitrary addresses. The legacy PIN
branch is still present *only* so a browser running the old bundle doesn't break
during rollout; it should be deleted once this deploy is live.

Verified against the live functions: default mode returns `no new alerts`;
bogus token and no-credential both `Not authorized`; a valid token sending to a
non-recipient is refused as a relay attempt; a valid token to Numed's real
recipient **sent successfully**; and the same admin switched to the demo org is
refused when targeting Numed's recipient.

**`Session.pin` is gone.** The stored session is now
`{username, role, tvAccess}` — verified in the browser, with the cookie still
invisible to JS. Two changes made that possible: the test button moved to an
`adminSendTestAlert` server action, and `update_own_username` became
session-authenticated (`phase3f`), dropping the old PIN-checking signature.

Consequence worth knowing: there is no longer any credential cached to silently
re-mint an expired session, so a lapsed cookie now lands on the login form. The
"remember me" cookie is 30 days. **If a `/tv` wall display starts dropping to
login, lengthen `REMEMBER_DAYS` — do not reintroduce a cached PIN.**

Two latent bugs fixed in passing:
- `update_own_username` never updated `push_subscriptions`, which keys devices by
  *username*. A rename orphaned that person's devices and — after the Phase 3e
  scoping above — would have silently stopped their alerts.
- The old `update_own_username` had no uniqueness or empty-string check; it now
  reports a clash as "unavailable" rather than "already exists", so it isn't a
  cross-tenant username oracle.

**Not verified:** the test button's click path in the browser. The edge function
was exercised directly and thoroughly with curl, and the server action
typechecks and builds, but the Browser pane stopped rendering mid-session so the
button itself was never clicked end-to-end. Worth one manual click.

### Phase 3g/3h — the last PIN checks ✅ 2026-08-17

**`is_admin` is dropped.** notify-alerts v8 removed its legacy PIN branch (safe:
production was confirmed on `a534539`, serving the token path), which left
`is_admin` with no callers anywhere — verified across `app/`, `components/`,
`lib/`, `supabase/functions/`, and every other function body in the database.
It was the heart of F-4: a PIN check with no lockout returning a bare boolean,
i.e. a perfect oracle.

**And dropping it surfaced a worse one.** `reset_own_pin(p_username, p_old_pin,
p_new_pin)` was **anon-executable** and compared the PIN with a direct `crypt`
call instead of going through `verify_user_login` — so unlike login it applied
**no lockout and recorded no failed attempt**. Anyone holding the publishable
key could guess PINs against any username at full speed, and a correct guess
didn't merely confirm the PIN, it *changed* it. Account takeover, not just
disclosure. It survived every earlier sweep because it isn't an `admin_*`
function and doesn't mention `is_admin`.

`change_own_pin` had the same anon-callable shape. It at least routed through
`verify_user_login` so the lockout applied, but nothing in the app called it —
dead code that checks PINs, dropped.

The replacement is session-authenticated and rate-limited. Verified:

| check | result |
| --- | --- |
| wrong current PIN | returns false **and records a strike** (was: raise, no strike) |
| five wrong tries | locked |
| correct PIN while locked | refused |
| correct PIN unlocked | changes it, new PIN logs in |
| no session | `not authenticated` |

The strike is recorded by *returning false rather than raising* — a raise would
roll the increment back in the same transaction, which is precisely the bug the
`fix_pin_lockout_persistence` migration fixed in `verify_user_login`.

**Where PIN verification now lives, and nowhere else:** `create_session` (login,
5-strike lockout), `reset_own_pin` (session + current PIN, same lockout), and
`register_user` (which validates an invite code, not a PIN, and must stay
anon-callable because signup precedes any session). `lib/auth.tsx` no longer
touches the anon Supabase client for anything except `register_user`.

### Phase 4a — users are people; companies are explicit grants ✅ 2026-08-17

**Why this changed.** `admin_create_user` puts the new person into whatever org
the switcher happens to be on. That is how the `Demo` account ended up a member
of **Numed** and able to read all 17 real magnets — the dangerous outcome was
the *default*, produced by doing nothing wrong. Creating a person and deciding
which companies they may see are now two separate, deliberate steps.

Scope, as chosen: **only the Users tab** leaves the switcher. Assets and Alerts
stay org-scoped, because a magnet or a threshold genuinely belongs to one
company. And it is **superadmin-only** — an ordinary company admin keeps the
org-scoped tab and still cannot learn that other tenants exist.

New (all service_role, superadmin-gated where noted):
- `admin_list_all_users(p_token)` — every user with their grants. Superadmin
  only; a company admin is refused outright.
- `admin_create_unassigned_user(p_token, username, pin)` — creates a person with
  **no** company access. They can sign in and see nothing until granted.
- `admin_set_membership(p_token, username, org_id, role, tv_access)` — grant,
  adjust, or (role = null) revoke. A superadmin may target any company; a
  company admin only the one they are currently administering, so an admin of
  one tenant cannot hand out access to another.

Two safeguards worth keeping:
- Revoking someone's access also **repoints any live session** off that org, so
  an existing cookie cannot keep reading the company they just lost.
- An admin cannot revoke their own access (superadmins exempt, since they keep
  admin everywhere regardless) — otherwise a single click locks you out of the
  org you were administering with no way back.

`components/GlobalUsersTab.tsx` renders it: an "Add person" form with no role
and no company, then one row per person with a per-company `No access / Viewer /
Admin` control and a TV checkbox. A person with no grants gets a "No access"
badge so the state is visible rather than silent.

Verified end to end in the browser: creating a person produced **0 memberships**
and the audit line *Created "_grantee" with no company access yet*; granting
Demo through the dropdown produced *Granted "_grantee" viewer access to Demo
Company*. Backed by 8 SQL assertions including a company admin refused the
global list, refused a foreign org, self-revoke refused, and revocation
repointing the target's session.

Also done: the `Demo` account was moved out of Numed into the demo org and its
live session repointed.

### Phase 4b — per-org branding ✅ 2026-08-17

Phase 0 moved `product_name` / `eyebrow` / `tagline` onto `orgs` so a company
could be turned up without a deploy — then nothing ever read them. The eyebrow
said "NUMED · REMOTE MONITORING" while viewing Demo Company.

`resolve_session` now returns the active org's brand, so it rides along with the
session rather than costing a second round-trip. That required DROP + CREATE:
adding columns to a `RETURNS TABLE` changes the function's return type, which
`CREATE OR REPLACE` cannot do. Its callers (`_admin_actor`,
`list_switchable_orgs`, `reset_own_pin`, `update_own_username`) resolve at
runtime, so recreating in one transaction is safe — verified afterwards.

`components/OrgBrandProvider.tsx` feeds it into the same `DemoContext` the
components already read, so **no component changed**. It sits inside
`AuthProvider` (it reads the session) and outside the `/demo` tree, whose
`DemoShell` nests its own provider — the nearer provider wins, so `/demo` keeps
its neutral white-label identity regardless of who is signed in. Signed out, or
with no active org, it falls back to `realBrand` so the login screen still looks
like itself.

The brand is also cached in the localStorage session copy, purely so a returning
user paints their own company's branding on the first frame instead of flashing
the default and correcting itself. The server session stays authoritative and
reconciles on mount.

Verified in the browser: signed in against Numed the eyebrow reads
"NUMED · REMOTE MONITORING"; switching to Demo Company it becomes
"LIVE DEMO · REMOTE MONITORING", with the fleet correctly empty.
