import type { AmbientPoint } from "./weatherTypes";

// Putting an hourly weather observation onto a 15-minute telemetry grid.
//
// Kept separate from the chart because it is the part with edges: stations
// report at irregular intervals (every 5 minutes at a busy airport, once an
// hour at a small one), the telemetry buckets are evenly spaced, and the two
// windows rarely line up at either end.

/** Beyond this, the nearest observation is not describing this bucket's weather
 *  any more. An hourly station still fills every bucket; a gap in reporting
 *  leaves a hole in the trace, which is the honest outcome. */
const MAX_GAP_MS = 45 * 60_000;

/**
 * One ambient temperature per bucket, index-aligned with `bucketTimes`.
 *
 * Nearest observation wins, rather than last-known-value: with an hourly
 * station, carrying a reading forward for 59 minutes would draw a staircase
 * that implies the temperature held and then jumped, when what actually
 * happened is that nobody looked in between.
 */
export function alignAmbient(bucketTimes: string[], points: AmbientPoint[]): (number | null)[] {
  if (points.length === 0) return bucketTimes.map(() => null);

  // Both sides are already sorted oldest-first, so a single moving index walks
  // them together instead of scanning the observations once per bucket.
  const stamps = points.map((p) => Date.parse(p.t));
  let i = 0;

  return bucketTimes.map((t) => {
    const target = Date.parse(t);
    if (!Number.isFinite(target)) return null;

    while (i < stamps.length - 1 && stamps[i + 1] <= target) i++;
    // i is now the last observation at or before the bucket; the one after it
    // may still be closer.
    const before = i;
    const after = i + 1 < stamps.length ? i + 1 : i;
    // Strict `<` makes an exact tie resolve backwards, to the reading already
    // taken rather than one from the future. Ties are common with an hourly
    // station on a 15-minute grid — the half-past bucket hits one every hour.
    const best =
      Math.abs(stamps[after] - target) < Math.abs(stamps[before] - target) ? after : before;

    return Math.abs(stamps[best] - target) <= MAX_GAP_MS ? points[best].tempF : null;
  });
}
