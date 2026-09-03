import test from "node:test";
import assert from "node:assert/strict";

import { collectorStatuses, NO_TELEMETRY_KINDS } from "../lib/health.ts";
import { usesMagmon, MODALITY_MRI, MODALITY_PETCT } from "../lib/modality.ts";
import type { Asset } from "../lib/supabase.ts";

/**
 * Which half of a unit is reporting.
 *
 * A unit can run two collectors for one asset, and EITHER keeps last_sample_at
 * fresh — so a green "online" chip is not evidence that the magnet is being
 * watched. NM1019 sat on a bench reporting a bay sensor and a UPS, with no
 * MagMon connected at all, and the app called it online.
 *
 * Worth a test because the failure is silent in both directions: too eager and
 * every PET/CT trailer permanently claims a missing MagMon, too shy and a
 * magnet whose collector died keeps a green chip over blank helium.
 *
 * Static and offline, like the other suites: no database, no network.
 */

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();

function asset(over: Partial<Asset>): Asset {
  return {
    id: "a1",
    name: "NM1019",
    status: "online",
    modality: MODALITY_MRI,
    maintenance: false,
    offline_threshold_minutes: 30,
    last_sample_at: minsAgo(1),
    last_seen_at: minsAgo(1),
    ...over,
  } as Asset;
}

test("a magnet reporting normally shows no collector chip", () => {
  const chips = collectorStatuses(
    asset({ last_magmon_sample_at: minsAgo(1), last_env_sample_at: null })
  );
  assert.deepEqual(chips, []);
});

test("env reporting with no MagMon ever says so, and says NOT CONNECTED", () => {
  // NM1019 on the bench: the environmental collector is installed and the
  // MagMon one is not.
  const chips = collectorStatuses(
    asset({ last_magmon_sample_at: null, last_env_sample_at: minsAgo(1) })
  );
  assert.equal(chips.length, 1);
  assert.equal(chips[0].key, "magmon");
  assert.equal(chips[0].label, "MagMon not connected");
});

test("a MagMon that WAS reporting and stopped reads differently", () => {
  // Same chip, different job: one is an install that never happened, the other
  // is something that worked and quit.
  const chips = collectorStatuses(
    asset({ last_magmon_sample_at: minsAgo(120), last_env_sample_at: minsAgo(1) })
  );
  assert.deepEqual(chips.map((c) => c.label), ["MagMon silent"]);
});

test("a fitted environmental side that goes quiet is named too", () => {
  const chips = collectorStatuses(
    asset({ last_magmon_sample_at: minsAgo(1), last_env_sample_at: minsAgo(90) })
  );
  assert.deepEqual(chips.map((c) => c.label), ["Env silent"]);
});

test("a magnet with no sensors fitted never claims a dead env side", () => {
  // A null clock means no environmental hardware ever reported here, which is
  // most of the fleet. Treating that as a fault would light up every magnet.
  const chips = collectorStatuses(
    asset({ last_magmon_sample_at: minsAgo(1), last_env_sample_at: null })
  );
  assert.equal(chips.find((c) => c.key === "env"), undefined);
});

test("a trailer with no magnet is not accused of a missing MagMon", () => {
  const chips = collectorStatuses(
    asset({
      modality: MODALITY_PETCT,
      last_magmon_sample_at: null,
      last_env_sample_at: minsAgo(1),
    })
  );
  assert.deepEqual(chips, []);
});

test("a unit that is stale overall shows nothing — the status chip has it", () => {
  // Naming both halves under an "offline" chip is noise, and it is the same
  // rule evaluate_alerts uses: family silence is only evaluated while the unit
  // as a whole is still reporting.
  const chips = collectorStatuses(
    asset({
      last_sample_at: minsAgo(240),
      last_magmon_sample_at: null,
      last_env_sample_at: minsAgo(240),
    })
  );
  assert.deepEqual(chips, []);
});

test("health's inlined has-magmon rule matches lib/modality's usesMagmon", () => {
  // health.ts deliberately does not import modality.ts, so this pins the one
  // duplicated line against the real thing — including the default that an
  // unknown modality is assumed NOT to have a magnet.
  for (const modality of [MODALITY_MRI, MODALITY_PETCT, "NUC MED", null]) {
    const chips = collectorStatuses(
      asset({
        modality: modality as string,
        last_magmon_sample_at: null,
        last_env_sample_at: minsAgo(1),
      })
    );
    assert.equal(
      chips.some((c) => c.key === "magmon"),
      usesMagmon(modality),
      `modality ${String(modality)}`
    );
  }
});

test("both silence kinds read as no-telemetry, so they render red", () => {
  assert.ok(NO_TELEMETRY_KINDS.has("magmon_silent"));
  assert.ok(NO_TELEMETRY_KINDS.has("env_silent"));
});
