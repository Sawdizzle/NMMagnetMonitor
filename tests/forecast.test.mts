import test from "node:test";
import assert from "node:assert/strict";

import {
  heliumForecast,
  refillChipLabel,
  refillUrgency,
  forecastHeadline,
  DEFAULT_REFILL_FLOOR,
  type HeliumPoint,
} from "../lib/forecast.ts";

/**
 * The helium boil-off projection — "this magnet needs filling in nine days".
 *
 * A number an engineer schedules a cryogen delivery against, fitted from a
 * week of 15-minute buckets. The failure that matters is not a crash: it is a
 * confident-looking date drawn from four noisy points, or a magnet that is
 * quietly falling being reported as stable. Both look completely normal on
 * screen.
 *
 * `now` and the sample times are injected throughout, so nothing here depends
 * on when it runs.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);

/** `days` of samples ending at NOW, falling `perDay` percent a day from `from`. */
function ramp(days: number, perDay: number, from: number, perDayPoints = 4): HeliumPoint[] {
  const pts: HeliumPoint[] = [];
  const step = DAY / perDayPoints;
  for (let t = NOW - days * DAY; t <= NOW; t += step) {
    pts.push({ t, v: from + ((t - (NOW - days * DAY)) / DAY) * perDay });
  }
  return pts;
}

// ---- refusing to answer ---------------------------------------------------

test("too little data produces no forecast at all", () => {
  // Silence beats a projection nobody should act on. Three points is not a
  // trend, and this is the guard that stops a freshly-installed unit showing a
  // refill date on its first afternoon.
  assert.equal(heliumForecast([]), null);
  assert.equal(heliumForecast(ramp(1, -1, 60).slice(0, 3)), null);
});

test("samples that all share one timestamp produce no forecast", () => {
  // Zero span means an infinite slope. Returning null beats dividing by it.
  const t = NOW;
  assert.equal(heliumForecast([{ t, v: 60 }, { t, v: 59 }, { t, v: 58 }, { t, v: 57 }]), null);
});

test("non-finite readings are dropped, not fitted", () => {
  const pts = ramp(7, -1, 60);
  const dirty = [...pts, { t: NaN, v: 50 }, { t: NOW, v: Infinity }];
  const clean = heliumForecast(pts, { now: NOW });
  const withJunk = heliumForecast(dirty, { now: NOW });
  assert.ok(clean && withJunk);
  assert.ok(Math.abs(clean.ratePerDay - withJunk.ratePerDay) < 1e-9, "junk moved the slope");
});

test("points arriving out of order are sorted, not mis-fitted", () => {
  const pts = ramp(7, -1, 60);
  const shuffled = [...pts].reverse();
  const a = heliumForecast(pts, { now: NOW })!;
  const b = heliumForecast(shuffled, { now: NOW })!;
  assert.ok(Math.abs(a.ratePerDay - b.ratePerDay) < 1e-9);
});

// ---- the trend ------------------------------------------------------------

test("a steady decline is measured at the rate it actually falls", () => {
  const f = heliumForecast(ramp(7, -1.5, 70), { now: NOW })!;
  assert.equal(f.trend, "falling");
  assert.ok(Math.abs(f.ratePerDay - -1.5) < 0.01, `rate was ${f.ratePerDay}`);
  assert.ok(Math.abs(f.currentPct - 59.5) < 0.1, `level was ${f.currentPct}`);
});

test("sensor jitter reads as stable, not as a slow fill or a slow leak", () => {
  // The flat band exists so a magnet holding its level does not accumulate a
  // spurious refill date from noise. A drift under 0.05 %/day is nothing.
  const f = heliumForecast(ramp(7, -0.02, 70), { now: NOW })!;
  assert.equal(f.trend, "stable");
  assert.equal(f.daysToRefill, null, "a stable magnet must not get a refill date");
  assert.equal(f.refillBy, null);
});

test("a fill shows as rising and projects nothing", () => {
  const f = heliumForecast(ramp(2, +6, 40), { now: NOW })!;
  assert.equal(f.trend, "rising");
  assert.equal(f.daysToRefill, null);
});

// ---- the projection -------------------------------------------------------

test("the refill date is where the fitted line crosses the floor", () => {
  // 60 % now, falling 2 %/day, floor 20 % → twenty days.
  const f = heliumForecast(ramp(7, -2, 74), { now: NOW })!;
  assert.equal(f.floor, DEFAULT_REFILL_FLOOR);
  assert.ok(Math.abs(f.daysToRefill! - 20) < 0.5, `daysToRefill was ${f.daysToRefill}`);
  assert.ok(Math.abs(f.refillBy! - (NOW + 20 * DAY)) < 0.5 * DAY);
});

test("a magnet already under the floor is due now, not overdue by a negative", () => {
  // Below the floor the arithmetic goes negative; clamping to zero is what
  // keeps the card from reading "refill in -3 days".
  const f = heliumForecast(ramp(7, -1, 22), { now: NOW })!;
  assert.equal(f.trend, "falling");
  assert.equal(f.daysToRefill, 0);
  assert.equal(f.refillBy, NOW);
});

test("a decline too slow to matter is not given a date a decade out", () => {
  // 0.06 %/day counts as falling, but crossing the floor is ~660 days away —
  // still inside the horizon, so it should project.
  const slow = heliumForecast(ramp(7, -0.06, 60), { now: NOW })!;
  assert.equal(slow.trend, "falling");
  assert.ok(slow.daysToRefill !== null && slow.daysToRefill > 300);

  // A floor already far below a barely-moving level goes past the 10-year
  // horizon and is reported as no meaningful date rather than a fake one.
  const glacial = heliumForecast(ramp(7, -0.051, 100), { now: NOW, floor: -1000 })!;
  assert.equal(glacial.daysToRefill, null);
});

test("a custom floor moves the date", () => {
  const high = heliumForecast(ramp(7, -2, 74), { now: NOW, floor: 40 })!;
  const low = heliumForecast(ramp(7, -2, 74), { now: NOW, floor: 20 })!;
  assert.ok(high.daysToRefill! < low.daysToRefill!, "a higher floor is reached sooner");
});

// ---- how much to believe it ----------------------------------------------

test("confidence reflects the window, not just the fit", () => {
  // A clean week-long decline is worth acting on.
  assert.equal(heliumForecast(ramp(7, -1.5, 70), { now: NOW })!.confidence, "high");

  // The same perfect fit over four points in a few hours is not — the r² is 1
  // either way, which is exactly why span and count are part of the grade.
  const brief = heliumForecast(
    [0, 1, 2, 3].map((i) => ({ t: NOW - (3 - i) * 3600_000, v: 60 - i * 0.2 })),
    { now: NOW }
  )!;
  assert.equal(brief.confidence, "low");
  assert.ok(brief.r2 > 0.99, "the fit itself is perfect; only the window is thin");
});

test("a noisy week is not sold as a confident projection", () => {
  const noisy = ramp(7, -1, 70).map((p, i) => ({ ...p, v: p.v + (i % 2 ? 9 : -9) }));
  const f = heliumForecast(noisy, { now: NOW })!;
  assert.ok(f.r2 < 0.6, `r² was ${f.r2}`);
  assert.notEqual(f.confidence, "high");
});

// ---- what the card says ---------------------------------------------------

test("the chip only appears when there is something to schedule", () => {
  assert.equal(refillChipLabel(null), null);
  assert.equal(refillChipLabel(heliumForecast(ramp(7, -0.02, 70), { now: NOW })), null);
  assert.match(refillChipLabel(heliumForecast(ramp(7, -2, 74), { now: NOW }))!, /\d/);
});

test("urgency separates the fill to book now from the one to watch", () => {
  const soon = heliumForecast(ramp(7, -4, 60), { now: NOW })!;
  const later = heliumForecast(ramp(7, -0.5, 90), { now: NOW })!;
  assert.equal(refillUrgency(soon), "soon");
  assert.equal(refillUrgency(later), "watch");
});

test("the headline says which way the magnet is going", () => {
  assert.match(forecastHeadline(heliumForecast(ramp(7, -2, 74), { now: NOW })!), /\S/);
  assert.match(forecastHeadline(heliumForecast(ramp(7, -0.02, 70), { now: NOW })!), /\S/);
  assert.match(forecastHeadline(heliumForecast(ramp(2, +6, 40), { now: NOW })!), /\S/);
});
