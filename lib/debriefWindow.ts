// The debrief's 9am boundary, and which side of it an alert fell.
//
// Its own module so it can be tested: lib/debrief.ts is `server-only` and
// therefore unreachable from a node test, but this is the part with the
// interesting behaviour — a fixed zone, a DST-aware boundary, and a four-way
// bucket classification that decides what a team reads at 9am. Same split as
// lib/chartScale and lib/collectorVersion, for the same reason.
//
// lib/debrief re-exports what it used to own, so nothing else moved.

import type { DebriefBucket } from "./dataSource";

/**
 * The zone the 9am boundary is measured in.
 *
 * A fixed zone rather than the viewer's, on purpose: two people in different
 * zones must be looking at the SAME window, or "the 9am debrief" stops being
 * one shared artifact that a team can talk about.
 */
export const DEBRIEF_TIME_ZONE = "America/Chicago";
export const DEBRIEF_HOUR = 9;

type ZonedParts = { year: number; month: number; day: number };

const PART_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: DEBRIEF_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * The zone's UTC offset at a given instant, in ms.
 *
 * Read out of Intl rather than hard-coded, so the DST flip is handled by the
 * platform's tz database instead of by us guessing which half of the year it is.
 */
function zoneOffsetMs(instant: number): number {
  const parts = PART_FORMAT.formatToParts(new Date(instant));
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    at("year"),
    at("month") - 1,
    at("day"),
    at("hour"),
    at("minute"),
    at("second")
  );
  return asUtc - instant;
}

function zonedDateOf(instant: number): ZonedParts {
  const parts = PART_FORMAT.formatToParts(new Date(instant));
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: at("year"), month: at("month"), day: at("day") };
}

/**
 * The instant at which the clock in DEBRIEF_TIME_ZONE reads `hour:00` on the
 * given local date.
 *
 * Two passes: the offset we need is the one in effect at the ANSWER, not at the
 * naive UTC reading of the same wall clock, and those differ across a DST
 * changeover. Guessing once and correcting once converges for every real zone.
 */
function zonedHourToInstant({ year, month, day }: ZonedParts, hour: number): number {
  const wall = Date.UTC(year, month - 1, day, hour, 0, 0);
  const first = wall - zoneOffsetMs(wall);
  return wall - zoneOffsetMs(first);
}

export type DebriefWindow = { start: number; end: number };

/**
 * The window a debrief viewed at `now` covers: the most recent 9am boundary
 * (`end`) back to the 9am before it (`start`).
 *
 * Boundaries are calendar-local, so on the two DST changeover days the window
 * is 23 or 25 hours rather than exactly 24. That is deliberate — "since
 * yesterday morning" with no gap and no overlap beats a rigid 24h that would
 * drift the boundary off 9am and either double-report or drop an hour of alerts.
 */
export function debriefWindow(now: Date = new Date()): DebriefWindow {
  const t = now.getTime();

  let end = zonedHourToInstant(zonedDateOf(t), DEBRIEF_HOUR);
  // Before 9am local, today's boundary hasn't happened yet: the live debrief is
  // still yesterday's. Step back a day in the zone (not a flat -24h on the
  // result) so a changeover day lands on 9am rather than 8 or 10.
  if (end > t) end = zonedHourToInstant(zonedDateOf(end - 24 * 60 * 60 * 1000), DEBRIEF_HOUR);

  const start = zonedHourToInstant(zonedDateOf(end - 24 * 60 * 60 * 1000), DEBRIEF_HOUR);
  return { start, end };
}

export function bucketFor(openedInWindow: boolean, resolvedInWindow: boolean): DebriefBucket {
  if (openedInWindow) return resolvedInWindow ? "flapped" : "new";
  return resolvedInWindow ? "cleared" : "ongoing";
}
