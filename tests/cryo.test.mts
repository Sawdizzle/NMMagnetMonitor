import test from "node:test";
import assert from "node:assert/strict";

import { cryoState, CRYO_BANDS, CRYO_LABELS, CRYO_SHORT_LABELS, CRYO_COLORS } from "../lib/cryo.ts";
import type { TelemetrySample } from "../lib/supabase.ts";

/**
 * The cryogenic state badge, pinned against real fleet readings.
 *
 * Every case below is a row this fleet actually produced on 2026-09-04, because
 * a scale calibrated against imagined numbers is a scale that goes green on the
 * day it matters. NM1004 is the unit that prompted it: 0.7 % helium for the
 * whole retained history, correct alarms open for thirteen days, and nothing on
 * screen that said "this magnet is gone" without reading four separate numbers.
 *
 * Static and offline: no database, no network.
 */

// PostgREST hands numerics back as STRINGS, so they are written as strings here
// on purpose — a helper that only coped with real numbers would pass a prettier
// test and fail against the API.
function row(over: Record<string, unknown>): TelemetrySample {
  return {
    he_lvl: null,
    he_press: null,
    shield: null,
    data: {},
    ...over,
  } as unknown as TelemetrySample;
}

test("a healthy magnet reads nominal with nothing to say", () => {
  // NM1003 as it stands today.
  const s = cryoState(row({
    he_lvl: "76.51", he_press: "1.02", shield: "43.443",
    data: { ColdheadRuO: "4.15", ReconRuO: "4.28" },
  }));
  assert.equal(s.level, "nominal");
  assert.deepEqual(s.reasons, []);
});

test("NM1004's last reading is critical, and says why", () => {
  const s = cryoState(row({
    he_lvl: "0.72", he_press: "5.427", shield: "38.722",
    data: { ColdheadRuO: "10.04", ReconRuO: "4.40" },
  }));
  assert.equal(s.level, "critical");
  assert.match(s.reasons.join(" | "), /effectively empty/);
  assert.match(s.reasons.join(" | "), /cryocooler is losing the coldhead/);
});

test("the coldhead pulling away from the recondenser is caught while helium is still fine", () => {
  // NM1028: 76.4 % helium — nothing wrong by the level alone — but 8.97 K
  // against a recondenser at 4.16 K. This is the case the scale exists for.
  const s = cryoState(row({
    he_lvl: "76.39", he_press: "0.971",
    data: { ColdheadRuO: "8.97", ReconRuO: "4.16" },
  }));
  assert.notEqual(s.level, "nominal");
  assert.equal(s.level, "critical"); // 8.97 K is past the coldhead critical line
  assert.match(s.reasons.join(" | "), /recondenser at 4\.2 K/);
});

test("a warm magnet is reported as warm, not as low on helium", () => {
  // NM1034 at the service centre: everything at room temperature. Saying
  // "helium 0 %" here would bury the actual state.
  const s = cryoState(row({
    he_lvl: "0.0", he_press: "-3.62", shield: "382.82",
    data: { ColdheadRuO: "310.89", ReconRuO: "310.89" },
  }));
  assert.equal(s.level, "critical");
  assert.equal(s.reasons.length, 1);
  assert.match(s.reasons[0], /Magnet is warm/);
});

test("a fill-line breach is urgent, not critical", () => {
  // NM1037 at 35.4 %: needs scheduling, is not an emergency.
  const s = cryoState(row({
    he_lvl: "35.38", he_press: "1.426",
    data: { ColdheadRuO: "4.13", ReconRuO: "4.20" },
  }));
  assert.equal(s.level, "urgent");
  assert.match(s.reasons[0], /below the 50 % fill line/);
});

test("the lowest healthy unit reads watch, not alarm", () => {
  // NM1020 at 55.7 %: real information, not worth waking anyone.
  const s = cryoState(row({
    he_lvl: "55.741", he_press: "0.971",
    data: { ColdheadRuO: "4.19", ReconRuO: "4.23" },
  }));
  assert.equal(s.level, "watch");
});

test("ABSENCE IS NEVER GREEN", () => {
  // The rule the whole file turns on. A unit with no cryo reading must not
  // render as healthy, whether the row is missing, empty, or all nulls.
  assert.equal(cryoState(null).level, "unknown");
  assert.equal(cryoState(undefined).level, "unknown");
  assert.equal(cryoState(row({})).level, "unknown");
  assert.equal(cryoState(row({ he_lvl: null, data: {} })).level, "unknown");
  // An environmental-only row — bay temp and UPS, no magnet channels at all.
  assert.equal(cryoState(row({ he_lvl: null, data: { ups_status: "OL" } })).level, "unknown");
});

test("a partial reading still judges what it has", () => {
  // Helium present, coldhead missing (the FTP fallback drops the device codes
  // and the RuO temps): judge the helium rather than giving up.
  assert.equal(cryoState(row({ he_lvl: "12.0", data: {} })).level, "critical");
  assert.equal(cryoState(row({ he_lvl: "70.0", data: {} })).level, "nominal");
});

test("the urgent bands are the fleet's own alarm thresholds", () => {
  // If these drift apart, the badge and the alert rules start telling different
  // stories about the same magnet.
  assert.equal(CRYO_BANDS.heliumUrgent, 50);
  assert.equal(CRYO_BANDS.pressureUrgent, 3.0);
  assert.equal(CRYO_BANDS.coldheadUrgent, 6.0);
});

test("every level has a label, a short label and a colour", () => {
  // The card and the wall render the short form; a missing entry would draw an
  // empty chip rather than fail, which is the kind of gap nobody notices.
  for (const level of ["nominal", "watch", "urgent", "critical", "unknown"] as const) {
    assert.ok(CRYO_LABELS[level]?.length > 0, level);
    assert.ok(CRYO_SHORT_LABELS[level]?.length > 0, level);
    assert.match(CRYO_COLORS[level], /^#|^var\(/, level);
  }
  // Grey, not green — the same rule as the badge itself.
  assert.notEqual(CRYO_COLORS.unknown, CRYO_COLORS.nominal);
});

test("the headline is short enough for the wall, and is the worst finding", () => {
  // The TV lays fault lines out with nowrap and hides the overflow, so this is
  // the field that has to fit. NM1004: helium is the worse of its findings, so
  // that is what leads — not whichever check happened to run first.
  const nm1004 = cryoState(row({
    he_lvl: "0.72", he_press: "5.427",
    data: { ColdheadRuO: "10.04", ReconRuO: "4.40" },
  }));
  assert.equal(nm1004.headline, "Helium 0.7 %");
  assert.ok(nm1004.headline!.length <= 34);

  // NM1028: helium is fine, so the divergence leads.
  const nm1028 = cryoState(row({
    he_lvl: "76.39", he_press: "0.971",
    data: { ColdheadRuO: "8.97", ReconRuO: "4.16" },
  }));
  assert.equal(nm1028.headline, "Coldhead 9.0 K");

  // Nothing wrong, nothing to say.
  assert.equal(cryoState(row({ he_lvl: "70.0", data: {} })).headline, null);
  assert.equal(cryoState(null).headline, null);
});

test("reasons are ordered worst first", () => {
  const s = cryoState(row({
    he_lvl: "55.0", he_press: "5.5", data: { ColdheadRuO: "4.2", ReconRuO: "4.2" },
  }));
  // Pressure is critical, helium only watch — the critical one leads both the
  // list and the headline.
  assert.match(s.reasons[0], /Vessel pressure/);
  assert.equal(s.headline, "Pressure 5.50");
  assert.equal(s.level, "critical");
});
