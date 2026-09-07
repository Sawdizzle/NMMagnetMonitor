# Migrations

This directory is empty on purpose, and filling it is a one-command job that
needs a credential this repo does not hold. Read the next section before doing
anything else.

## Why this exists

`supabase/schema.sql` was the source of truth, by convention, maintained by
hand. A 2026-09-06 audit compared it against the running database:

| | in production | absent from `schema.sql` |
|---|---|---|
| indexes | 27 | 12 |
| functions | 99 | **40** |

Among the forty were `resolve_session`, `create_session` and `_admin_actor`.
A database rebuilt from that file would not have been slow — it would not have
authenticated anybody. Nobody was careless; objects added through the Supabase
dashboard simply never pass through a file, and nothing was comparing the two.

## The rule

**A database change is not finished until `npm run db:check` passes.**

```bash
npm run db:check
```

It asks the running database what exists, checks each object is declared
somewhere under `supabase/`, and exits non-zero listing anything that is not.
It needs only `SUPABASE_SERVICE_ROLE_KEY` from `.env.local` — no database
password, no Docker, no linked project — so it runs in CI as easily as locally.

It is deliberately **not** part of `npm test`: that suite is static and offline
by design, and must keep passing in a fresh clone with no secrets.

## Creating the baseline (one time, needs the database password)

The CLI is installed and `supabase/config.toml` is committed. What is missing is
the initial migration, and generating it needs a direct Postgres connection —
the database password, which is not in `.env.local` and should not be. So this
step is yours:

```bash
supabase link --project-ref wxygirzfxutvtfkxxcvw
```

```bash
supabase db pull
```

`db pull` writes `supabase/migrations/<timestamp>_remote_schema.sql` containing
the real, complete schema as Postgres reports it — every table, function, policy
and grant, exactly as they run. That file, not a hand-written one, is the
baseline.

Then confirm the loop is closed:

```bash
npm run db:check
```

It should print `✓ The repo declares everything in production`.

### Why the baseline is not already here

It could have been assembled from `pg_get_functiondef()` and friends over the
MCP connection. It was not, deliberately: a hand-reconstructed baseline that is
90 % right is worse than none, because it looks authoritative and fails on the
one table whose constraint or default got transcribed wrong — which is the same
class of problem this directory exists to end. `db pull` asks Postgres to
describe itself, and Postgres does not misremember.

## Afterwards

Once a baseline exists, `supabase/schema.sql` becomes redundant. Keep it until
`db:check` passes against the migrations alone, then delete it — two files
claiming to describe one database is how this started.

New changes, from then on:

```bash
supabase migration new add_whatever    # writes an empty timestamped file
```

```bash
supabase db push                       # applies pending migrations to remote
```

If a change is made in the dashboard instead — which will happen, the advisor
suggests indexes and the button is right there — `supabase db pull` captures it
into a migration after the fact. That is a perfectly good workflow. The part
that must not be skipped is `npm run db:check` afterwards, which is what turns
"someone will remember" into something that fails loudly.
