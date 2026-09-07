import test from "node:test";
import assert from "node:assert/strict";

import {
  computeAssetHealth,
  isReachable,
  minutesSince,
  OFFLINE_AFTER_MINUTES,
} from "../lib/health.ts";
import { muteRemaining } from "../lib/alertTriage.ts";
import type { Asset } from "../lib/supabase.ts";

/**
 * The freshness model, and the mute countdown beside it.
 *
 * computeAssetHealth is what decides whether a unit is online, and it keys off
 * last_sample_at (a genuinely NEW reading actually stored), never
 * last_seen_at (mere reachability). That distinction is the whole point: the
 * collector phones home on every cycle even when the device behind it has
 * stopped producing rows, so keying off reachability gave a hung unit a
 * permanent green light. These pin the model so it cannot quietly regress to
 * the version that could not see a silent magnet.
 *
 * Static and offline.
 */

const MIN = 60_000;

function unit(over: Partial<Asset> = {}): Asset {
  return {
    last_sample_at: new Date(Date.now() - 1 * MIN).toISOString(),
    last_seen_at: new Date(Date.now() - 1 * MIN).toISOString(),
    offline_threshold_minutes: 30,
    ...over,
  } as Asset;
}

const ago = (mins: number) => new Date(Date.now() - mins * MIN).toISOString();

// ---- the four states ------------------------------------------------------

test("a unit reporting inside its threshold is online", () => {
  assert.equal(computeAssetHealth(unit({ last_sample_at: ago(1) })), "online");
  assert.equal(computeAssetHealth(unit({ last_sample_at: ago(29) })), "online");
  // Exactly on the line is still online — the comparison is <=.
  assert.equal(computeAssetHealth(unit({ last_sample_at: ago(30) })), "online");
});

test("past the threshold is stale, past the hour is offline", () => {
  // Amber before red gives an intermittent cellular link — CA1012 on the iR305
  // over Verizon drops a report now and then — room to recover before it reads
  // as a genuine outage.
  assert.equal(computeAssetHealth(unit({ last_sample_at: ago(31) })), "stale");
  assert.equal(computeAssetHealth(unit({ last_sample_at: ago(OFFLINE_AFTER_MINUTES) })), "stale");
  assert.equal(computeAssetHealth(unit({ last_sample_at: ago(OFFLINE_AFTER_MINUTES + 1) })), "offline");
  assert.equal(computeAssetHealth(unit({ last_sample_at: ago(60 * 24) })), "offline");
});

test("a unit that has never stored a reading is unknown, not offline", () => {
  // Different thing, different colour: never-reported is a commissioning state,
  // offline is a fault. NM1009 in the demo fleet is the former.
  assert.equal(computeAssetHealth(unit({ last_sample_at: null })), "unknown");
});

test("health is judged on stored data, never on the collector phoning home", () => {
  // THE regression this model exists to prevent. The Pi is reachable this
  // minute; the device behind it last stored a row four hours ago. Keying off
  // last_seen_at gave that unit a permanent green light — a reachable-but-
  // silent magnet nobody was told about.
  const silent = unit({ last_sample_at: ago(240), last_seen_at: ago(1) });
  assert.equal(computeAssetHealth(silent), "offline");
  // Reachability is still reported — it is what distinguishes "the gateway
  // stalled" from "the site is off the air" — it just does not set the status.
  assert.equal(isReachable(silent), true);
});

test("a per-asset threshold moves the line", () => {
  // A unit that only reports every couple of hours must not sit permanently
  // amber.
  const slow = unit({ last_sample_at: ago(90), offline_threshold_minutes: 120 });
  assert.equal(computeAssetHealth(slow), "online");
  assert.equal(computeAssetHealth(unit({ last_sample_at: ago(45), offline_threshold_minutes: 15 })), "stale");
});

test("a threshold above the hour skips amber entirely", () => {
  // Worth pinning because it is surprising rather than wrong: once a unit's own
  // late threshold exceeds OFFLINE_AFTER_MINUTES, anything past it is already
  // past the hour, so it goes straight from online to offline with no stale
  // step. A future change that adds a warning tier needs to know this.
  const slow = { last_sample_at: ago(130), offline_threshold_minutes: 120 };
  assert.equal(computeAssetHealth(unit(slow)), "offline");
  assert.equal(computeAssetHealth(unit({ ...slow, last_sample_at: ago(119) })), "online");
});

test("a missing threshold falls back to the fleet default", () => {
  assert.equal(computeAssetHealth(unit({ last_sample_at: ago(20), offline_threshold_minutes: null })), "online");
  assert.equal(computeAssetHealth(unit({ last_sample_at: ago(40), offline_threshold_minutes: null })), "stale");
});

// ---- reachability ---------------------------------------------------------

test("a unit that has never been seen is not reachable", () => {
  assert.equal(isReachable(unit({ last_seen_at: null })), false);
});

test("minutesSince reports null for never, and rounds otherwise", () => {
  assert.equal(minutesSince(null), null);
  assert.equal(minutesSince(ago(0)), 0);
  assert.equal(minutesSince(ago(45)), 45);
});

// ---- the mute countdown ---------------------------------------------------

test("a mute says how long it has left, in units a person reads", () => {
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  assert.equal(muteRemaining(null), "no expiry");
  assert.equal(muteRemaining(inHours(-1)), "expired");
  assert.equal(muteRemaining(inHours(3)), "3h left");
  // Switches to days at two, so a fortnight's mute does not read "336h left".
  assert.equal(muteRemaining(inHours(47)), "47h left");
  assert.equal(muteRemaining(inHours(72)), "3d left");
  assert.equal(muteRemaining(inHours(24 * 14)), "14d left");
});

test("a mute expiring this instant reads as expired, not as zero hours left", () => {
  // The boundary matters: a mute is either in force or it is not, and "0h left"
  // would read as still active.
  assert.equal(muteRemaining(new Date(Date.now() - 1).toISOString()), "expired");
});
