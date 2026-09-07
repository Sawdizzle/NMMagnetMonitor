<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Database changes

`supabase/schema.sql` and `supabase/migrations/` describe the database. They are
checked, not trusted: run `npm run db:check` after any schema change and before
committing one. It asks the live database what exists and fails on anything the
repo does not declare.

This is not ceremony. The file drifted to the point where forty of ninety-nine
production functions were absent from it, including the ones that authenticate
requests, and nobody knew because nothing was looking. `npm test` deliberately
does NOT cover this — that suite is static and offline, and must stay that way.

See `supabase/migrations/README.md` for the workflow and for the one-time
baseline step, which needs a credential this repo does not hold.
