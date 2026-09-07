import test from "node:test";
import assert from "node:assert/strict";

import {
  computeAssetAlarm,
  computeAssetFaults,
  FAULT_THRESHOLDS,
  type Fault,
} from "../lib/faults.ts";
import type { FleetAsset } from "../lib/dataSource.ts";
import type { AlertRule } from "../lib/supabase.ts";

/**
 * The alarm fold — the single call that decides a unit's colour and what a
 * screen reader is told about it.
 *
 * This exists because of the 2026-09-06 audit. The fleet card coloured its ring
 * and its rail from computeAssetHealth (connectivity: "did the unit phone
 * home?") while the wall display coloured from computeAssetAlarm (connectivity
 * folded together with the value faults). A magnet reporting perfectly with its
 * compressor off and its coldhead at 58 K therefore drew a GREEN ring on the
 * page an engineer checks first and a RED card on the wall — and the card's
 * aria-label announced it as "online", so the two critical faults on screen
 * were silent to a screen reader. Both surfaces now read this function. Nothing
 * in the suite would have caught either, and nothing would catch them coming
 * back; the first test below is that guard.
 *
 * Bounds are asserted RELATIVE to FAULT_THRESHOLDS, never as literals. The
 * thresholds are explicitly provisional — tuned against live readings and
 * expected to move once the service-centre team has them against real machines
 * — so a test pinning "50" would fail the day they are tuned and teach everyone
 * to distrust it. What is pinned here is the shape: which side of a line trips,
 * how severities fold, and what is deliberately NOT evaluated.
 *
 * Static and offline: no database, no network.
 */

const MINUTE = 60_000;
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * MINUTE).toISOString();

/**
 * PostgREST hands numerics back as STRINGS for high-precision columns, and the
 * coldhead is not a typed column at all — it lives in the raw `data` blob under
 * one of three spellings depending on the device's firmware. Readings are
 * written as strings here on purpose: a helper that only coped with real
 * numbers would pass a prettier test and fail against the API.
 */
function unit(over: {
  reading?: Record<string, unknown>;
  coldheadK?: string | number;
  sampleMinsAgo?: number | null;
  seenMinsAgo?: number | null;
  staleAfter?: number;
  maintenance?: boolean;
  rules?: AlertRule[];
} = {}): FleetAsset {
  const {
    reading,
    coldheadK,
    // Fresh by default: most cases below are about the VALUES, and a unit that
    // is not reporting never reaches the value checks at all.
    sampleMinsAgo = 1,
    seenMinsAgo = 1,
    staleAfter = 30,
    maintenance = false,
    rules = [],
  } = over;

  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "NM9999",
    maintenance,
    offline_threshold_minutes: staleAfter,
    last_sample_at: sampleMinsAgo === null ? null : iso(sampleMinsAgo),
    last_seen_at: seenMinsAgo === null ? null : iso(seenMinsAgo),
    latest:
      reading === undefined && coldheadK === undefined
        ? null
        : {
            he_lvl: null,
            he_press: null,
            h2o_flow: null,
            h2o_temp: null,
            shield: null,
            cs1: null,
            data: coldheadK === undefined ? {} : { ColdheadRuO: String(coldheadK) },
            ...reading,
          },
    history: [],
    alertRules: rules,
    openAlerts: [],
  } as unknown as FleetAsset;
}

const keys = (faults: Fault[]) => faults.map((f) => f.key);
const rule = (field: string, comparator: string, threshold: number): AlertRule => ({
  id: "rule-1",
  asset_id: "00000000-0000-0000-0000-000000000001",
  field,
  comparator,
  threshold,
  enabled: true,
});

// A value comfortably clear of every bound, for the channels a case is not about.
const HEALTHY = { he_lvl: "72.4", he_press: "1.02", shield: "41.8", cs1: "0" };

// ---------------------------------------------------------------- the guard

test("a reporting unit with a critical fault is never nominal", () => {
  // THE regression. MM-1002's shape, and the exact reading the audit caught:
  // reporting one minute ago, so connectivity says "online" — and the compressor
  // is off and the coldhead is at 58 K. Before the fix the card read this as
  // green, because it asked computeAssetHealth instead of this function.
  const alarm = computeAssetAlarm(
    unit({ reading: { ...HEALTHY, cs1: "33" }, coldheadK: "58" })
  );

  assert.equal(alarm.level, "critical");
  assert.notEqual(alarm.level, "ok");
  // Connectivity is still reported, and is still "online" — that is not the bug.
  // The bug was letting it decide the LEVEL.
  assert.equal(alarm.connectivity, "online");
  assert.deepEqual(keys(alarm.faults), ["compressor", "coldhead"]);
});

test("every critical fault forces a critical level, whichever channel raised it", () => {
  // The invariant behind the guard above, over each channel that can go
  // critical on its own. A new critical channel added without folding it into
  // the level would fail here rather than in a hospital corridor.
  const criticalCases: Record<string, FleetAsset> = {
    compressor: unit({ reading: { ...HEALTHY, cs1: "1" } }),
    coldhead: unit({
      reading: HEALTHY,
      coldheadK: FAULT_THRESHOLDS.coldheadCriticalK + 1,
    }),
    helium: unit({
      reading: { ...HEALTHY, he_lvl: String(FAULT_THRESHOLDS.heliumCriticalBelow - 1) },
    }),
  };

  for (const [name, a] of Object.entries(criticalCases)) {
    const alarm = computeAssetAlarm(a);
    assert.equal(alarm.level, "critical", `${name} did not fold into a critical level`);
    assert.ok(
      alarm.faults.some((f) => f.severity === "critical"),
      `${name} produced no critical fault`
    );
  }
});

test("a warning alone stays amber, and a healthy unit stays green", () => {
  const warn = computeAssetAlarm(
    unit({ reading: { ...HEALTHY, shield: String(FAULT_THRESHOLDS.shieldWarnK + 1) } })
  );
  assert.equal(warn.level, "warning");

  const ok = computeAssetAlarm(unit({ reading: HEALTHY, coldheadK: "4.15" }));
  assert.equal(ok.level, "ok");
  assert.deepEqual(ok.faults, []);
});

test("one critical outranks any number of warnings", () => {
  // The card shows only its first three pills and the label leads with the
  // level, so the worst fault has to sort to the front.
  const alarm = computeAssetAlarm(
    unit({
      reading: {
        he_lvl: String(FAULT_THRESHOLDS.heliumCriticalBelow - 1), // critical
        he_press: String(FAULT_THRESHOLDS.hePressHigh + 1), // warning
        shield: String(FAULT_THRESHOLDS.shieldWarnK + 1), // warning
        cs1: "0",
      },
    })
  );

  assert.equal(alarm.level, "critical");
  assert.equal(alarm.faults[0].severity, "critical");
  assert.equal(alarm.faults[0].key, "helium");
  assert.ok(alarm.faults.length > 1, "the warnings should still be listed behind it");
});

// ------------------------------------------------------------ where the lines are

test("a reading exactly on a bound has not crossed it", () => {
  const T = FAULT_THRESHOLDS;

  // Every comparison in computeAssetFaults is strict, so sitting precisely on a
  // limit is nominal. A magnet parked on its warn line all week should not pill.
  assert.deepEqual(keys(computeAssetFaults(unit({ reading: { cs1: String(T.compressorOffAbove) } }))), []);
  assert.deepEqual(keys(computeAssetFaults(unit({ reading: { he_lvl: String(T.heliumWarnBelow) } }))), []);
  assert.deepEqual(keys(computeAssetFaults(unit({ reading: { shield: String(T.shieldWarnK) } }))), []);
  assert.deepEqual(keys(computeAssetFaults(unit({ coldheadK: T.coldheadWarnK }))), []);
});

test("the helium tiers land on the right side of each line", () => {
  const T = FAULT_THRESHOLDS;
  const he = (v: number) => computeAssetFaults(unit({ reading: { he_lvl: String(v) } }));

  assert.deepEqual(he(T.heliumWarnBelow - 0.1)[0].severity, "warning");
  assert.deepEqual(he(T.heliumCriticalBelow - 0.1)[0].severity, "critical");
  // Nobody fills above ~82 %, so an implausibly high level reads as a sensor
  // fault or an overfill — amber, not red: the magnet is not in danger.
  assert.deepEqual(he(T.heliumHighAbove + 0.1)[0].severity, "warning");
  assert.equal(he(T.heliumHighAbove + 0.1)[0].label, "Helium high");
});

test("the coldhead is high before it is hot", () => {
  const T = FAULT_THRESHOLDS;
  const warm = computeAssetFaults(unit({ coldheadK: T.coldheadWarnK + 0.1 }));
  const hot = computeAssetFaults(unit({ coldheadK: T.coldheadCriticalK + 1 }));

  assert.equal(warm[0].severity, "warning");
  assert.equal(warm[0].label, "Coldhead high");
  assert.equal(hot[0].severity, "critical");
  assert.equal(hot[0].label, "Coldhead hot");
  // "warming" would claim a direction a single reading cannot see — NM1028 sat
  // flat at 8.94 K for eight days and was labelled as warming throughout.
  assert.doesNotMatch(warm[0].label, /warming/i);
});

test("helium pressure is abnormal on both sides", () => {
  const T = FAULT_THRESHOLDS;
  const low = computeAssetFaults(unit({ reading: { he_press: String(T.hePressLow - 0.5) } }));
  const high = computeAssetFaults(unit({ reading: { he_press: String(T.hePressHigh + 0.5) } }));

  assert.deepEqual(keys(low), ["he_press"]);
  assert.deepEqual(keys(high), ["he_press"]);
});

test("the coldhead is read under any of the spellings the fleet emits", () => {
  // Devices report the coldhead under different labels depending on firmware,
  // and it is not a typed column — a miss here silently drops the single most
  // diagnostic channel on the card.
  const hot = String(FAULT_THRESHOLDS.coldheadCriticalK + 1);
  for (const key of ["ColdheadRuO", "Coldhead", "ColdHead"]) {
    const a = unit({ reading: {} });
    (a.latest as unknown as { data: Record<string, unknown> }).data = { [key]: hot };
    assert.deepEqual(keys(computeAssetFaults(a)), ["coldhead"], `${key} was not read`);
  }
});

// ------------------------------------------------------------ per-asset overrides

test("a per-asset rule moves that unit's line and leaves the fleet's alone", () => {
  // NM1035's elevated He-pressure ceiling is the real case: off-nominal for the
  // fleet, normal for that magnet, and it should not pill.
  const T = FAULT_THRESHOLDS;
  const pressure = String(T.hePressHigh + 1);

  assert.deepEqual(keys(computeAssetFaults(unit({ reading: { he_press: pressure } }))), ["he_press"]);
  assert.deepEqual(
    keys(
      computeAssetFaults(
        unit({ reading: { he_press: pressure }, rules: [rule("he_press", ">", T.hePressHigh + 2)] })
      )
    ),
    [],
    "the override should have raised this unit's ceiling above the reading"
  );
});

test("a disabled rule leaves the fleet default in force", () => {
  const T = FAULT_THRESHOLDS;
  const disabled = { ...rule("he_press", ">", T.hePressHigh + 2), enabled: false };
  assert.deepEqual(
    keys(computeAssetFaults(unit({ reading: { he_press: String(T.hePressHigh + 1) }, rules: [disabled] }))),
    ["he_press"]
  );
});

test("an override on a field this module does not evaluate is ignored, not misapplied", () => {
  // h2o_flow has no client-side check — it is the server evaluator's ground.
  // The risk being pinned is a rule leaking onto the wrong threshold.
  const a = unit({ reading: HEALTHY, coldheadK: "4.15", rules: [rule("h2o_flow", "<", 0.6)] });
  assert.deepEqual(computeAssetFaults(a), []);
  assert.equal(computeAssetAlarm(a).level, "ok");
});

// ------------------------------------------------------- what is NOT evaluated

test("a unit that has stopped reporting is not judged on its last reading", () => {
  // The stored values are old. Presenting them as current would show an ancient
  // "Compressor OFF" as if it were happening now — and, worse, a stale reading
  // that happened to be healthy as if the magnet were fine.
  const alarm = computeAssetAlarm(
    unit({
      reading: { ...HEALTHY, cs1: "33" },
      coldheadK: "58",
      sampleMinsAgo: 240,
      seenMinsAgo: 240,
    })
  );

  assert.equal(alarm.connectivity, "offline");
  assert.equal(alarm.level, "critical");
  // The outage itself, and ONLY the outage. The card's accessible name is built
  // from these faults, so the silence has to arrive as one.
  assert.deepEqual(keys(alarm.faults), ["silent"]);
  assert.equal(alarm.faults[0].label, "Offline");
});

test("silence is coloured by how long, and named by whether the Pi is still there", () => {
  // Two independent axes, and they are easy to conflate. HOW RED comes from
  // data freshness alone — amber once a unit passes its late threshold, red
  // only after the hour, which gives an intermittent cellular link room to
  // recover. WHAT IT IS CALLED comes from reachability: a Pi still phoning home
  // while its device has stopped producing rows is a reporting_stalled fault,
  // not an outage, and mirrors the same split in evaluate_alerts.
  //
  // 45 minutes is past the 30-minute late threshold but inside the hour;
  // 240 is well past both.
  const cases = [
    { mins: 45, reachable: true, level: "warning", label: "Reporting stalled" },
    { mins: 240, reachable: true, level: "critical", label: "Reporting stalled" },
    { mins: 45, reachable: false, level: "warning", label: "No recent data" },
    { mins: 240, reachable: false, level: "critical", label: "Offline" },
  ] as const;

  for (const c of cases) {
    const alarm = computeAssetAlarm(
      unit({
        reading: HEALTHY,
        sampleMinsAgo: c.mins,
        // "Reachable" is the collector having phoned home within the same late
        // threshold, whatever the device behind it has been doing.
        seenMinsAgo: c.reachable ? 1 : c.mins,
      })
    );
    const where = `${c.mins} min, ${c.reachable ? "reachable" : "unreachable"}`;
    assert.equal(alarm.level, c.level, `${where}: wrong level`);
    assert.deepEqual(keys(alarm.faults), ["silent"], `${where}: wrong faults`);
    assert.equal(alarm.faults[0].label, c.label, `${where}: wrong label`);
  }
});

test("a unit that has never reported is unknown, with nothing to say about it", () => {
  const alarm = computeAssetAlarm(unit({ sampleMinsAgo: null, seenMinsAgo: null }));

  assert.equal(alarm.level, "unknown");
  assert.deepEqual(alarm.faults, []);
  // No faults and no reading is what makes the label read "no data, never
  // reported" rather than inventing a fault out of an absence.
  assert.equal(alarm.connectivity, "unknown");
});

test("a maintenance unit stays calm however bad its readings are", () => {
  // NM1034 sits warm at the service centre. Its zeros are expected, and a card
  // screaming about a decommissioned magnet is the fatigue the flag exists to
  // prevent.
  const alarm = computeAssetAlarm(
    unit({
      reading: { he_lvl: "0", he_press: "-1", shield: "300", cs1: "33" },
      coldheadK: "300",
      sampleMinsAgo: 5000,
      maintenance: true,
    })
  );

  assert.equal(alarm.level, "maintenance");
  assert.equal(alarm.maintenance, true);
  assert.deepEqual(alarm.faults, []);
});

// ------------------------------------------------------------------ coercion

test("readings are judged the same whether they arrive as numbers or strings", () => {
  // PostgREST returns high-precision numerics as strings. A check that only
  // coped with numbers would go quiet against the real API and nowhere else.
  const asText = computeAssetFaults(unit({ reading: { cs1: "33", he_lvl: "24.4" } }));
  const asNumber = computeAssetFaults(unit({ reading: { cs1: 33, he_lvl: 24.4 } }));

  assert.deepEqual(keys(asText), keys(asNumber));
  assert.deepEqual(keys(asText), ["compressor", "helium"]);
});

test("a blank channel is not a zero", () => {
  // A null helium reading must not be read as 0 % and pilled as critical — the
  // channel is absent, which is a different thing from empty.
  const alarm = computeAssetAlarm(unit({ reading: { he_lvl: null, cs1: null, shield: null } }));
  assert.equal(alarm.level, "ok");
  assert.deepEqual(alarm.faults, []);
});

test("a unit with no reading at all produces no value faults", () => {
  assert.deepEqual(computeAssetFaults(unit({ sampleMinsAgo: 1 })), []);
});
