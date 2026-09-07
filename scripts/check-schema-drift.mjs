#!/usr/bin/env node
//
// Does the repo still describe the database that is actually running?
//
// This exists because of the 2026-09-06 audit. supabase/schema.sql reads as the
// source of truth and had quietly stopped being one: twelve indexes and FORTY
// OF NINETY-NINE functions existed in production and appeared nowhere in the
// file — including resolve_session, create_session and _admin_actor. A rebuild
// from that file would not have been slow, it would not have authenticated
// anybody. Nothing noticed for months, because nothing was looking.
//
// A migrations directory alone does not fix that. An object created through the
// Supabase dashboard never passes through a migration, so the drift returns the
// first afternoon somebody clicks "add index" on the advisor's suggestion. What
// closes the loop is something that LOOKS, on demand and in CI.
//
//   npm run db:check
//
// Deliberately NOT part of `npm test`. The test suite is static and offline by
// design — it must keep passing on a plane, in a fresh clone, with no secrets —
// and folding a network call into it would trade that for this. Run this in CI
// and before a release instead.
//
// Reads pg_catalog through the schema_inventory() RPC because PostgREST exposes
// only the `public` schema, so a plain REST call cannot see catalog tables. That
// RPC is service_role-only. The service-role key is the only credential needed:
// no database password, no Docker, no linked project.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const URL_ENV = "NEXT_PUBLIC_SUPABASE_URL";
const KEY_ENV = "SUPABASE_SERVICE_ROLE_KEY";

// What counts as "ours to declare" is decided in SQL, by schema_inventory(),
// not guessed at here. It already excludes the two categories that would
// otherwise be noise, and excludes them precisely:
//
//   constraint-backed indexes  a `constraint foo unique (name)` inside a CREATE
//                              TABLE produces an index of the same name, and the
//                              table declares it. pg_constraint.conindid says
//                              which those are; a `_key$` name pattern only
//                              guesses, and got assets_name_unique wrong.
//   extension-owned functions  pg_net installs its own machinery into public.
//                              pg_depend deptype='e' names them exactly.

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(2);
}

// ---- the repo's side ------------------------------------------------------

/**
 * Every .sql file the repo uses to describe the database, concatenated.
 *
 * Reads BOTH the migrations directory and the legacy schema.sql, so this works
 * before the baseline migration exists and keeps working after — during the
 * changeover the truth is spread across the two, and a check that only looked
 * at one would report drift that is not there.
 */
function repoSql() {
  const parts = [];
  const migrations = join("supabase", "migrations");
  if (existsSync(migrations)) {
    for (const f of readdirSync(migrations).filter((f) => f.endsWith(".sql"))) {
      parts.push(readFileSync(join(migrations, f), "utf8"));
    }
  }
  const legacy = join("supabase", "schema.sql");
  if (existsSync(legacy)) parts.push(readFileSync(legacy, "utf8"));
  if (parts.length === 0) fail("No supabase/migrations/*.sql and no supabase/schema.sql to check against.");
  return parts.join("\n").toLowerCase();
}

/**
 * Is this object declared anywhere in the repo's SQL?
 *
 * Matches on the DECLARING form rather than a bare name — `create function
 * public.foo(`, not "foo" — so a passing mention in a comment cannot make a
 * missing object look present. Comments are where this file's own explanations
 * live, and they name plenty of things they do not create.
 */
function declares(sql, kind, name) {
  const n = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  switch (kind) {
    case "function":
      return new RegExp(`function\\s+(public\\.)?${n}\\s*\\(`).test(sql);
    case "table":
      return new RegExp(`create\\s+table[^;]*?(public\\.)?${n}\\s*\\(`).test(sql);
    case "view":
      return new RegExp(`create\\s+(or\\s+replace\\s+)?view\\s+(public\\.)?${n}\\b`).test(sql);
    case "index":
      return new RegExp(`create\\s+(unique\\s+)?index[^;]*?\\b${n}\\b`).test(sql);
    case "trigger":
      return new RegExp(`create\\s+(or\\s+replace\\s+)?trigger\\s+${n}\\b`).test(sql);
    case "cron":
      // Cron jobs are scheduled through cron.schedule() or the dashboard; what
      // matters is that the repo names the job somewhere it can be recreated.
      return sql.includes(name.toLowerCase());
    default:
      return true;
  }
}

// ---- production's side ----------------------------------------------------

async function inventory(url, key) {
  let res;
  try {
    res = await fetch(`${url}/rest/v1/rpc/schema_inventory`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    // Exit 2, not 1. "The network was down" and "the schema has drifted" are
    // different answers, and a CI run that reports the first as the second
    // teaches everyone to ignore this check — which is how the drift it exists
    // to catch got to forty functions in the first place.
    fail(`Could not reach ${url}\n  ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 404) {
      fail(
        "schema_inventory() is not installed in this database.\n" +
          "  It is declared in supabase/schema.sql — apply that function, then re-run."
      );
    }
    fail(`schema_inventory() failed (${res.status}). ${body.slice(0, 300)}`);
  }
  return res.json();
}

// ---- main -----------------------------------------------------------------

const url = process.env[URL_ENV];
const key = process.env[KEY_ENV];
if (!url || !key) {
  fail(
    `Missing ${!url ? URL_ENV : KEY_ENV}.\n` +
      "  Run through the npm script, which loads .env.local:  npm run db:check"
  );
}

const sql = repoSql();
const rows = await inventory(url, key);

const missing = [];
const counts = {};
for (const { kind, name, detail } of rows) {
  counts[kind] = (counts[kind] ?? 0) + 1;
  if (!declares(sql, kind, name)) missing.push({ kind, name, detail });
}

const order = ["table", "view", "function", "index", "trigger", "cron"];
const PLURAL = {
  table: "tables", view: "views", function: "functions",
  index: "indexes", trigger: "triggers", cron: "cron jobs",
};
const summary = order
  .filter((k) => counts[k])
  .map((k) => `${counts[k]} ${counts[k] === 1 ? k : PLURAL[k]}`)
  .join(", ");

if (missing.length === 0) {
  console.log(`\n  ✓ The repo declares everything in production — ${summary}.\n`);
  process.exit(0);
}

console.error(`\n  ✗ ${missing.length} object(s) exist in production but are declared nowhere in the repo.`);
console.error(`    Checked ${summary}.\n`);
for (const k of order) {
  const group = missing.filter((m) => m.kind === k);
  if (group.length === 0) continue;
  console.error(`    ${PLURAL[k]} (${group.length}):`);
  for (const m of group) {
    console.error(`      ${m.name}${m.kind === "function" && m.detail ? `(${m.detail})` : ""}`);
  }
  console.error("");
}
console.error("    Each of these would be absent from a database rebuilt from this repo.");
console.error("    Capture them:  supabase db pull      (see supabase/migrations/README.md)\n");
process.exit(1);
