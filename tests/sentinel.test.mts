import test from "node:test";
import assert from "node:assert/strict";

import {
  suppressedReading,
  formatSuppressed,
  sentinelExplanation,
} from "../lib/sentinel.ts";

/**
 * Reading back the placeholder that nullify_sentinel() threw away.
 *
 * The MagMon has no concept of a blank channel: an analog input with no sensor
 * on it still prints a number every minute, and on this fleet that number is a
 * fixed constant. The database stores NULL for those so a dead channel cannot
 * trip a threshold rule; this puts the number back ON SCREEN, labelled, so the
 * app and the device's own web interface do not silently disagree.
 *
 * The stakes both ways: fail to recognise a placeholder and the page shows a
 * bare em-dash where the MagMon shows 5.024, which reads as the app losing
 * data. Recognise one that is not there and the page tells an engineer a real
 * reading is fake. The constants and the 0.002 tolerance must stay in step with
 * nullify_sentinel() in supabase/schema.sql — these tests are what notices if
 * one side moves.
 *
 * Static and offline.
 */

// The four spellings the fleet actually emits: the HTTP reading and the .dat
// file's metric twin, per channel.
const FLOW_HTTP = 5.0238;
const FLOW_DAT = 19.017;
const TEMP_HTTP = 100.4756;
const TEMP_DAT = 38.042;

test("a blanked channel reports the placeholder the device sent", () => {
  assert.equal(suppressedReading("h2o_flow", null, { H20_Flow: FLOW_HTTP }), FLOW_HTTP);
  assert.equal(suppressedReading("h2o_temp", null, { H2O_Temp: TEMP_HTTP }), TEMP_HTTP);
});

test("the .dat file's metric twin counts too", () => {
  // A unit whose feed comes over FTP reports litres and Celsius. Both reach the
  // database, so both have to be recognised or half the fleet renders em-dashes.
  assert.equal(suppressedReading("h2o_flow", null, { H20_Flow: FLOW_DAT }), FLOW_DAT);
  assert.equal(suppressedReading("h2o_temp", null, { H2O_Temp: TEMP_DAT }), TEMP_DAT);
});

test("both spellings of the raw key are accepted", () => {
  // The gateway writes the device's own column name — H20_Flow, with the zero
  // the device actually prints — and report_telemetry_batch carries a lowercase
  // copy. A reader that knew only one would blank half the rows.
  assert.equal(suppressedReading("h2o_flow", null, { h2o_flow: FLOW_HTTP }), FLOW_HTTP);
  assert.equal(suppressedReading("h2o_temp", null, { h2o_temp: TEMP_HTTP }), TEMP_HTTP);
});

test("numeric strings from the raw blob are read as numbers", () => {
  // The blob is device output; values arrive as text as often as not.
  assert.equal(suppressedReading("h2o_flow", null, { H20_Flow: String(FLOW_HTTP) }), FLOW_HTTP);
});

test("a channel with a real reading is never called a placeholder", () => {
  // The stored column wins outright. This is the direction that would tell an
  // engineer a genuine measurement is fake.
  assert.equal(suppressedReading("h2o_flow", 3.4, { H20_Flow: FLOW_HTTP }), null);
  assert.equal(suppressedReading("h2o_flow", 0, { H20_Flow: FLOW_HTTP }), null);
  assert.equal(suppressedReading("h2o_temp", 52.6, { H2O_Temp: TEMP_HTTP }), null);
});

test("blank for any other reason stays blank", () => {
  // Claiming a placeholder that was never seen is its own kind of lie: no raw
  // row kept, a gateway that never reported the field, a genuinely different
  // reading — all render as an ordinary em-dash.
  assert.equal(suppressedReading("h2o_flow", null, null), null);
  assert.equal(suppressedReading("h2o_flow", null, {}), null);
  assert.equal(suppressedReading("h2o_flow", null, { H20_Flow: 3.4 }), null);
  assert.equal(suppressedReading("h2o_flow", null, { H20_Flow: "not a number" }), null);
  assert.equal(suppressedReading("h2o_flow", undefined, { H20_Flow: null }), null);
});

test("the tolerance is tight enough not to swallow a real reading", () => {
  // 0.002 either side, matching nullify_sentinel(). A flow of 5.03 gpm is a
  // measurement and must not be dismissed as the 5.0238 placeholder.
  assert.equal(suppressedReading("h2o_flow", null, { H20_Flow: FLOW_HTTP + 0.0019 }), FLOW_HTTP + 0.0019);
  assert.equal(suppressedReading("h2o_flow", null, { H20_Flow: FLOW_HTTP + 0.05 }), null);
  assert.equal(suppressedReading("h2o_flow", null, { H20_Flow: 5.03 }), null);
});

test("a channel only matches its own placeholders", () => {
  // The temperature constant must not blank a flow reading, or a trailer with
  // 38 gpm of flow would read as a dead sensor.
  assert.equal(suppressedReading("h2o_flow", null, { H20_Flow: TEMP_DAT }), null);
  assert.equal(suppressedReading("h2o_temp", null, { H2O_Temp: FLOW_DAT }), null);
});

test("the number is printed the way the MagMon prints it", () => {
  // The whole point is that it can be matched against the device's own screen,
  // so a float-repr twin left over from the .dat unit conversion must still
  // render as the device's spelling.
  assert.equal(formatSuppressed(FLOW_HTTP), "5.024");
  assert.equal(formatSuppressed(5.023759919694909), "5.024");
  assert.equal(formatSuppressed(TEMP_HTTP), "100.476");
  assert.equal(formatSuppressed(TEMP_DAT), "38.042");
  // No trailing zeros — 19.017, not 19.0170.
  assert.equal(formatSuppressed(FLOW_DAT), "19.017");
});

test("the explanation names the value it is explaining", () => {
  const text = sentinelExplanation(FLOW_HTTP);
  assert.match(text, /5\.024/);
  assert.match(text, /placeholder rather than a measurement/);
});
