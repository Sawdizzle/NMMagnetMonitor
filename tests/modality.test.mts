import test from "node:test";
import assert from "node:assert/strict";

import {
  ENV_ZONES,
  envChartSpecs,
  envNum,
  expectsEnv,
  powerState,
  showsPower,
  usesMagmon,
  zonesToShow,
  zonesWithData,
  MODALITY_MRI,
  MODALITY_PETCT,
} from "../lib/modality.ts";
import type { ChannelRow } from "../lib/modality.ts";

/**
 * The rules that decide which sections an asset's card and page are made of.
 *
 * This is worth a test rather than a screenshot because the thing being
 * protected is a FUTURE state that no live asset is in yet. UPS power and zone
 * temperature sensors are being fitted across the whole fleet, so an MRI will
 * shortly report helium AND zones AND mains power at once. Nothing in the
 * database exercises that combination today, which means the first time it
 * happens will be in production on a real magnet — unless it is pinned here.
 *
 * The failure this guards against is specific and quiet: an either/or rule
 * ("MRI gets the magnet card, everything else gets the environmental one")
 * passes every test that uses today's data and silently drops half the channels
 * the day a magnet gets a UPS.
 *
 * Static and offline, like the other suites: no database, no network.
 */

// A row shaped like the telemetry the API returns. Numerics arrive from
// PostgREST as STRINGS, so they are written as strings here on purpose — a
// helper that only handled real numbers would pass a prettier test and fail
// against the actual API.
type Values = Record<string, string | null>;

function row(values: Values): ChannelRow {
  const base: Values = {
    he_lvl: null, he_press: null, h2o_flow: null, h2o_temp: null, shield: null, cs1: null,
    s1_temp_f: null, s1_rh: null, s2_temp_f: null, s2_rh: null, s3_temp_f: null, s3_rh: null,
    ups_on_battery: null, ups_batt_pct: null, ups_input_v: null,
  };
  return { ...base, ...values } as unknown as ChannelRow;
}

const MAGNET: Values = { he_lvl: "71.5", h2o_temp: "48.8", cs1: "0" };
const ZONES_AND_POWER: Values = {
  s1_temp_f: "70.0", s1_rh: "47.4",
  s2_temp_f: "70.2", s2_rh: "47.3",
  s3_temp_f: "70.3", s3_rh: "46.7",
  ups_on_battery: "0", ups_batt_pct: "100.0", ups_input_v: "114.0",
};

test("modality decides only whether there is a MagMon to scrape", () => {
  assert.equal(usesMagmon(MODALITY_MRI), true);
  assert.equal(usesMagmon(MODALITY_PETCT), false);
  // Null/undefined mean a row written before the column existed. The column
  // defaults to 'MRI', so these must agree with it.
  assert.equal(usesMagmon(null), true);
  assert.equal(usesMagmon(undefined), true);
  // A modality nobody has taught the UI about is assumed to have no magnet:
  // the safer guess, and the likelier truth for whatever gets added next.
  assert.equal(usesMagmon("NUC MED"), false);
  assert.equal(expectsEnv("NUC MED"), true);
});

test("a magnet with no sensors fitted shows no zone or power sections", () => {
  const rows = [row(MAGNET)];
  assert.deepEqual(zonesToShow(MODALITY_MRI, rows), []);
  assert.equal(showsPower(MODALITY_MRI, rows), false);
});

test("a trailer shows every zone even before it has reported one", () => {
  // Expected, not merely present: a PET/CT unit with no readings is broken and
  // has to show blank tiles that say so, rather than rendering as an asset with
  // nothing on it.
  assert.deepEqual(zonesToShow(MODALITY_PETCT, [null]), ENV_ZONES);
  assert.equal(showsPower(MODALITY_PETCT, [null]), true);
});

test("a magnet that gets a UPS and sensors fitted shows BOTH families", () => {
  // The case that does not exist in the database yet, and the whole reason the
  // rendering is additive rather than a choice between two kinds of card.
  const combined = [row({ ...MAGNET, ...ZONES_AND_POWER })];
  assert.equal(usesMagmon(MODALITY_MRI), true, "keeps its magnet channels");
  assert.equal(zonesToShow(MODALITY_MRI, combined).length, 3, "gains all three zones");
  assert.equal(showsPower(MODALITY_MRI, combined), true, "gains the power section");
});

test("two zones or three is a wiring decision, not a code change", () => {
  const twoZones = [row({ s1_temp_f: "70.0", s1_rh: "47.4", s2_temp_f: "71.1", s2_rh: "46.0" })];
  assert.deepEqual(
    zonesToShow(MODALITY_MRI, twoZones).map((z) => z.key),
    ["s1", "s2"]
  );
});

test("a zone that stops answering keeps its tile", () => {
  // Presence is judged across the window, not off the newest row alone. A
  // sensor that dropped off the bus must show a blank — which reads as a fault
  // — instead of vanishing, which reads as though it was never fitted.
  const window = [row({}), row({}), row({ s2_temp_f: "70.2", s2_rh: "47.3" })];
  assert.deepEqual(
    zonesWithData(window).map((z) => z.key),
    ["s2"]
  );
});

test("power has three states and unknown is not a synonym for fine", () => {
  assert.equal(powerState("0"), "wall");
  assert.equal(powerState(0), "wall");
  assert.equal(powerState("1"), "battery");
  assert.equal(powerState(1), "battery");
  // No reading means the NUT link is down, so the one condition this hardware
  // exists to catch is exactly what cannot be seen. It must NOT read as "wall".
  assert.equal(powerState(null), "unknown");
  assert.equal(powerState(undefined), "unknown");
  assert.equal(powerState(""), "unknown");
});

test("numeric strings from PostgREST are coerced, junk is not", () => {
  assert.equal(envNum("70.0"), 70);
  assert.equal(envNum(70), 70);
  assert.equal(envNum(null), null);
  assert.equal(envNum(""), null);
  assert.equal(envNum("   "), null);
  assert.equal(envNum("not a number"), null);
  assert.equal(envNum(Number.NaN), null);
  assert.equal(envNum(Number.POSITIVE_INFINITY), null);
  // 0 is a genuine reading — "on wall power", "no flow" — and must survive.
  assert.equal(envNum("0"), 0);
  assert.equal(envNum(0), 0);
});

test("the zone list and the collector's Modbus unit ids stay in step", () => {
  // ENV_ZONES is the single place the mapping from a Modbus unit id to a column
  // prefix is written down; the generated collector reads unit 1 into s1_*.
  // If these drift, every zone lands under the wrong name on every screen.
  assert.deepEqual(
    ENV_ZONES.map((z) => [z.zone, z.key]),
    [
      [1, "s1"],
      [2, "s2"],
      [3, "s3"],
    ]
  );
});

test("zone charts are ordered so temperature and humidity form rows", () => {
  // The ORDER IS THE LAYOUT. These go into a grid with one column per zone, so
  // all temperatures must come first (filling the top row, one per zone) and
  // all humidity second (filling the row beneath, aligned zone-for-zone).
  // Interleaving per zone — the obvious construction — wraps into a diagonal
  // scatter, which is what this page actually looked like before.
  const specs = envChartSpecs(ENV_ZONES);
  assert.deepEqual(
    specs.map((m) => m.key),
    ["s1_temp_f", "s2_temp_f", "s3_temp_f", "s1_rh", "s2_rh", "s3_rh"]
  );
  // First half temperature, second half humidity — no interleaving anywhere.
  const half = specs.length / 2;
  assert.ok(specs.slice(0, half).every((m) => m.isTemp), "top row is all temperature");
  assert.ok(specs.slice(half).every((m) => !m.isTemp), "bottom row is all humidity");
});

test("the chart grid stays rectangular for a two-zone unit", () => {
  const twoZones = ENV_ZONES.slice(0, 2);
  const specs = envChartSpecs(twoZones);
  // Two columns, two rows, still aligned: zone order is preserved within each
  // family so column 1 is always the same zone in both rows.
  assert.deepEqual(
    specs.map((m) => m.key),
    ["s1_temp_f", "s2_temp_f", "s1_rh", "s2_rh"]
  );
  assert.equal(specs.length % twoZones.length, 0, "grid divides evenly into rows");
});

test("only temperature charts carry the outside-air trace", () => {
  // Humidity against outside temperature would be two unrelated quantities
  // sharing an axis.
  for (const m of envChartSpecs(ENV_ZONES)) {
    assert.equal(m.isTemp, m.key.endsWith("_temp_f"));
  }
});
