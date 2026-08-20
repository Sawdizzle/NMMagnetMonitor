import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The MagMon code tables exist TWICE and must stay identical.
 *
 * supabase/schema.sql has them as magmon_error_text() /
 * magmon_compressor_status_text(), used when evaluate_diagnostics composes a
 * finding server-side. lib/magmonCodes.ts has them again, because the asset page
 * decodes the raw EC1-EC4 columns out of telemetry_samples.data in the browser
 * and should not round-trip to the database for a lookup.
 *
 * Two copies of a 97-row table is exactly the kind of thing that drifts
 * silently: someone corrects a wording on one side, and for months the alert
 * email and the asset page quietly disagree about what code 23 means. Nothing
 * would fail, which is the problem. This compares them entry for entry.
 *
 * Deliberately STATIC — it reads both files and talks to nothing. No database,
 * no network, no credentials, so it runs in CI and on a plane.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(join(root, "supabase/schema.sql"), "utf8");
const ts = readFileSync(join(root, "lib/magmonCodes.ts"), "utf8");

/** Pull the (code, text) pairs out of one SQL function's VALUES list. */
function sqlTable(fnName) {
  const start = sql.indexOf(`create or replace function public.${fnName}(`);
  assert.notEqual(start, -1, `${fnName} not found in supabase/schema.sql`);
  const end = sql.indexOf("$function$;", start);
  assert.notEqual(end, -1, `${fnName} has no terminator`);
  const body = sql.slice(start, end);
  const out = new Map();
  for (const m of body.matchAll(/\((\d+),\s*'([^']*)'\)/g)) {
    out.set(Number(m[1]), m[2]);
  }
  return out;
}

/** Pull the same pairs out of one TS Record literal. */
function tsTable(constName) {
  const start = ts.indexOf(`const ${constName}: Record<number, string> = {`);
  assert.notEqual(start, -1, `${constName} not found in lib/magmonCodes.ts`);
  const end = ts.indexOf("\n};", start);
  assert.notEqual(end, -1, `${constName} has no terminator`);
  const body = ts.slice(ts.indexOf("{", start) + 1, end);
  const out = new Map();
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*(\d+):\s*"(.*)",\s*$/);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

function compare(label, a, b) {
  // Guard against a parser that silently matched nothing — without this an
  // empty Map would compare equal to an empty Map and the test would "pass"
  // while checking absolutely nothing.
  assert.ok(a.size > 5, `${label}: SQL side parsed only ${a.size} entries — parser is broken`);
  assert.ok(b.size > 5, `${label}: TS side parsed only ${b.size} entries — parser is broken`);

  const codes = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y);
  const drift = [];
  for (const c of codes) {
    if (!a.has(c)) drift.push(`${c}: missing from SQL (TS says "${b.get(c)}")`);
    else if (!b.has(c)) drift.push(`${c}: missing from TS (SQL says "${a.get(c)}")`);
    else if (a.get(c) !== b.get(c)) drift.push(`${c}: SQL "${a.get(c)}" vs TS "${b.get(c)}"`);
  }
  assert.deepEqual(drift, [], `${label} drifted between supabase/schema.sql and lib/magmonCodes.ts:\n  ${drift.join("\n  ")}`);
  return codes.length;
}

test("magmon error codes match between SQL and TS", () => {
  const n = compare("magmon_error_text / ERROR_TEXT", sqlTable("magmon_error_text"), tsTable("ERROR_TEXT"));
  // The device's published table. A change here should be deliberate.
  assert.equal(n, 97, "expected 97 documented error codes");
});

test("magmon compressor status codes match between SQL and TS", () => {
  const n = compare(
    "magmon_compressor_status_text / COMPRESSOR_STATUS",
    sqlTable("magmon_compressor_status_text"),
    tsTable("COMPRESSOR_STATUS")
  );
  assert.equal(n, 14, "expected 14 documented compressor status codes");
});

test("water and compressor codes decode to their documented meaning", () => {
  // Spot-checks on the codes this fleet actually turns on. These are the ones a
  // wrong edit would be most costly on: 5/6 and 7/8 are how a dead water sensor
  // announces itself, and 11 is the compressor overtemp that pages someone.
  const err = tsTable("ERROR_TEXT");
  assert.equal(err.get(5), "Water flow for compressor 1 too low");
  assert.equal(err.get(6), "Water flow for compressor 1 too high");
  assert.equal(err.get(7), "Water temp for compressor 1 too cold");
  assert.equal(err.get(8), "Water temp for compressor 1 too hot");
  assert.equal(err.get(23), "Coldhead RuO temp too hot");
  assert.equal(tsTable("COMPRESSOR_STATUS").get(11), "compressor stopped due to overheat");
});
