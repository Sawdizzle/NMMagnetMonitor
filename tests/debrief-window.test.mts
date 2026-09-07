import test from "node:test";
import assert from "node:assert/strict";

import {
  debriefWindow,
  bucketFor,
  DEBRIEF_HOUR,
  DEBRIEF_TIME_ZONE,
} from "../lib/debriefWindow.ts";

/**
 * The morning debrief's 9am boundary.
 *
 * The debrief is derived on read rather than snapshotted, so this function IS
 * the schedule: there is no nightly job to check against. Two properties make
 * it work, and both are invisible when broken —
 *
 *   the window is STABLE for a whole day, so opening the page at 09:05 and
 *   again at 16:00 shows the same debrief, and
 *
 *   consecutive windows abut exactly, so no alert is reported twice and none
 *   falls down the gap between them.
 *
 * The boundary is calendar-local in a FIXED zone, which means the two DST
 * changeover days are 23 and 25 hours long. That is deliberate; a rigid 24h
 * would walk the boundary off 9am and start double-reporting.
 */

const H = 3_600_000;
const inZone = (t: number) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: DEBRIEF_TIME_ZONE,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t));

// ---- the boundary ---------------------------------------------------------

test("both ends of the window land on 9am in the debrief's zone", () => {
  // Not on the viewer's 9am: two people in different zones must be looking at
  // the same window, or "the 9am debrief" stops being one shared artifact.
  for (const iso of [
    "2026-09-07T14:05:00Z", // mid-morning, after the boundary
    "2026-09-07T02:00:00Z", // before it
    "2026-01-15T20:00:00Z", // winter, CST
    "2026-07-15T20:00:00Z", // summer, CDT
  ]) {
    const w = debriefWindow(new Date(iso));
    assert.equal(inZone(w.start), `0${DEBRIEF_HOUR}:00`, `start for ${iso}`);
    assert.equal(inZone(w.end), `0${DEBRIEF_HOUR}:00`, `end for ${iso}`);
  }
});

test("the window is the same all day, then rolls over at 9am", () => {
  // The property the fixed boundary exists to give: the page must not change
  // under a reader during the day.
  const morning = debriefWindow(new Date("2026-09-07T14:30:00Z")); // 09:30 CDT
  const evening = debriefWindow(new Date("2026-09-07T23:00:00Z")); // 18:00 CDT
  assert.deepEqual(morning, evening);

  // A minute before the next boundary is still today's window; a minute after
  // is tomorrow's.
  const justBefore = debriefWindow(new Date("2026-09-08T13:59:00Z"));
  const justAfter = debriefWindow(new Date("2026-09-08T14:01:00Z"));
  assert.deepEqual(justBefore, morning);
  assert.notDeepEqual(justAfter, morning);
  assert.equal(justAfter.start, morning.end, "the new window starts where the old one ended");
});

test("before 9am the live debrief is still yesterday's", () => {
  // 08:00 CDT — today's boundary has not happened yet.
  const w = debriefWindow(new Date("2026-09-07T13:00:00Z"));
  assert.ok(w.end < Date.parse("2026-09-07T13:00:00Z"), "end must be in the past");
  assert.equal(inZone(w.end), "09:00");
});

test("consecutive windows abut exactly — no gap, no overlap", () => {
  // An alert that fell between two windows would never be reported; one in both
  // would be reported twice. Walked across a whole year, DST changeovers
  // included.
  let cursor = new Date("2026-01-01T15:00:00Z");
  let prev = debriefWindow(cursor);
  for (let day = 0; day < 365; day++) {
    cursor = new Date(cursor.getTime() + 24 * H);
    const w = debriefWindow(cursor);
    if (w.end === prev.end) continue; // same window, cursor drifted within the day
    assert.equal(w.start, prev.end, `gap or overlap at day ${day} (${cursor.toISOString()})`);
    prev = w;
  }
});

test("the changeover days are 23 and 25 hours, and still start at 9am", () => {
  // US DST 2026: forward 8 March, back 1 November. A rigid 24 hours would put
  // these boundaries on 8am or 10am and start double-reporting.
  const spring = debriefWindow(new Date("2026-03-08T18:00:00Z"));
  const autumn = debriefWindow(new Date("2026-11-01T18:00:00Z"));

  assert.equal((spring.end - spring.start) / H, 23, "spring forward should be 23 hours");
  assert.equal((autumn.end - autumn.start) / H, 25, "fall back should be 25 hours");

  for (const w of [spring, autumn]) {
    assert.equal(inZone(w.start), "09:00");
    assert.equal(inZone(w.end), "09:00");
  }
});

test("an ordinary window is exactly 24 hours", () => {
  const w = debriefWindow(new Date("2026-09-07T18:00:00Z"));
  assert.equal((w.end - w.start) / H, 24);
});

// ---- which side of the boundary an alert fell -----------------------------

test("the four buckets say what happened overnight", () => {
  // Each maps to a different thing a reader does at 9am, which is why they are
  // four and not two.
  assert.equal(bucketFor(true, false), "new"); // broke overnight, still broken
  assert.equal(bucketFor(true, true), "flapped"); // came and went — worth seeing, not chasing
  assert.equal(bucketFor(false, true), "cleared"); // was broken, recovered overnight
  assert.equal(bucketFor(false, false), "ongoing"); // down all week; must not be omitted
});
