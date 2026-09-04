import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { generatePiScript } from "../lib/piScript.ts";

/**
 * The device timestamps the fleet ACTUALLY emits must parse.
 *
 * This test exists because they didn't. Every MagMon serves its minute table
 * with dates like "04-Sep-26", and _DEV_DATE_FORMATS carried only numeric
 * patterns, so parse_dev_dt returned None for every row of every fetch. That is
 * not a visible failure: build_samples finds no dated rows, returns (None,
 * None), and main() falls through to "report just the latest row, stamped now".
 * The fleet reported one sample per poll cycle and looked perfectly healthy
 * while the devices were serving sixty rows an hour. It ran that way from the
 * day the batch collector shipped until 2026-09-04, when NM1019's install
 * happened to compare rows offered against rows stored.
 *
 * So the cases below are not invented: each is a real Date value read out of
 * `telemetry_samples.data` for a named unit on 2026-09-04, wrong device clocks
 * and all. A parser change that drops any of them silently costs the whole
 * fleet its resolution again.
 *
 * The Python is extracted and run rather than mirrored in TypeScript, because a
 * TS reimplementation of strptime would pass while the shipped collector fails
 * — which is exactly the class of bug being guarded against.
 */

const script = generatePiScript({
  assetName: "TEST",
  gatewayToken: "t",
  monitorHost: "10.0.0.1",
  monitorPort: 80,
  monitorUsername: "u",
  monitorPassword: "p",
  supabaseUrl: "https://example.test",
  supabaseAnonKey: "k",
  intervalMinutes: 5,
});

// Just the format table and the parser — not the whole collector, which would
// need `requests` and a live device.
const start = script.indexOf("_DEV_DATE_FORMATS");
const end = script.indexOf("def floor_minute");
assert.ok(start > 0 && end > start, "could not locate parse_dev_dt in the generated script");
const parserSource = script.slice(start, end);

// Real values, each read from a live unit's stored payload on 2026-09-04.
const FLEET_DATES: [string, string][] = [
  ["04-Sep-26", "NM1019, NM1003, NM1030, NM1034, NM1001, NM1021, NM1027, NM1028, NM1031"],
  ["04-Sep-21", "CA1012 — device clock years behind"],
  ["04-Jun-06", "NM1020 — clock reset to the power-on epoch"],
  ["30-Dec-10", "NM1037"],
  ["04-Sep-11", "NM1006"],
  ["26-Aug-22", "NM1008 — the known 2022 clock"],
  ["25-Aug-21", "NM1029"],
  ["13-May-06", "the device's documented power-on epoch"],
];

function runParser(cases: [string, string][]): Record<string, string | null> {
  const py = `
import datetime, json
${parserSource}
out = {}
for d, t in ${JSON.stringify(cases.map(([d]) => [d, "13:18"]))}:
    v = parse_dev_dt(d, t)
    out[d] = v.isoformat() if v else None
print(json.dumps(out))
`;
  return JSON.parse(execFileSync("python3", ["-c", py], { encoding: "utf8" }));
}

test("every device date format the fleet emits parses", () => {
  const got = runParser(FLEET_DATES);
  for (const [date, who] of FLEET_DATES) {
    assert.notEqual(got[date], null, `${date} (${who}) must parse — the collector drops rows it cannot date`);
  }
  // Anchoring uses the relative spacing between rows, so the year matters less
  // than the month/day, but a mis-parsed month would reorder the table.
  assert.equal(got["04-Sep-26"], "2026-09-04T13:18:00");
  assert.equal(got["13-May-06"], "2006-05-13T13:18:00");
});

test("numeric forms still resolve exactly as they did", () => {
  const got = runParser([
    ["09/04/26", "US numeric, the first pattern tried"],
    ["2026-09-04", "ISO"],
  ]);
  assert.equal(got["09/04/26"], "2026-09-04T13:18:00");
  assert.equal(got["2026-09-04"], "2026-09-04T13:18:00");
});

test("an undateable row is still rejected rather than guessed at", () => {
  // A row that cannot be dated must return None so build_samples degrades
  // honestly instead of inventing a position in the timeline.
  const got = runParser([
    ["040926", "the .dat/FTP form — ambiguous, deliberately not accepted"],
    ["", "empty"],
  ]);
  assert.equal(got["040926"], null);
  assert.equal(got[""], null);
});
