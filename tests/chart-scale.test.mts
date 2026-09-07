import test from "node:test";
import assert from "node:assert/strict";

import { niceScale, axisLabel, monotonePath } from "../lib/chartScale.ts";

/**
 * The maths behind the asset page's trend charts.
 *
 * These replaced Recharts — 107 kB gzipped to draw six 140-pixel line charts —
 * and they are the half of that swap which can be silently wrong. A chart with
 * a bad axis or an overshooting curve does not throw or look broken; it looks
 * like a plausible reading the magnet never produced. That is the failure mode
 * these pin.
 *
 * Static and offline: no DOM, no database.
 */

// ---- axis domains --------------------------------------------------------

test("ticks land on round numbers a person would choose", () => {
  // Recharts' domain={["auto","auto"]}: an axis over live helium readings
  // should read 20/40/60/80, not 23.7/41.2/58.7.
  const s = niceScale(23.7, 81.4);
  assert.ok(s.ticks.every((t) => Number.isInteger(t / 20)), `got ${s.ticks.join(", ")}`);
  assert.equal(s.lo, 20);
  assert.equal(s.hi, 100);
});

test("the domain always contains the data", () => {
  // The invariant that matters: a point outside [lo, hi] is drawn outside the
  // plot area, clipped or overlapping the axis labels.
  const cases: [number, number][] = [
    [0, 1], [23.7, 81.4], [4.11, 4.29], [-3, 12], [0.001, 0.009],
    [55, 55.0000001], [-40, -12], [1e5, 3e5],
  ];
  for (const [min, max] of cases) {
    const s = niceScale(min, max);
    assert.ok(s.lo <= min, `lo ${s.lo} > min ${min}`);
    assert.ok(s.hi >= max, `hi ${s.hi} < max ${max}`);
    assert.ok(s.ticks.length >= 2, `only ${s.ticks.length} ticks for [${min}, ${max}]`);
    assert.ok(s.ticks.every(Number.isFinite), `non-finite tick for [${min}, ${max}]`);
  }
});

test("a dead-flat channel still gets a band to sit in", () => {
  // A stuck sensor, or a compressor reading 0 all day. Zero range would divide
  // by zero and collapse the line onto the axis; it should sit mid-chart.
  const s = niceScale(0, 0);
  assert.ok(s.hi > s.lo, "flat data produced an empty domain");
  assert.ok(s.lo <= 0 && s.hi >= 0);

  const warm = niceScale(38.042, 38.042); // the water-temp sentinel value
  assert.ok(warm.hi > warm.lo);
  assert.ok(warm.lo <= 38.042 && warm.hi >= 38.042);
});

test("the tick loop terminates on awkward float steps", () => {
  // Accumulating a float step can overshoot or never reach the end. Ranges
  // chosen to produce steps like 0.30000000000000004.
  for (const [lo, hi] of [[0.1, 0.7], [1 / 3, 2 / 3], [0.0001, 0.0007]] as [number, number][]) {
    const s = niceScale(lo, hi);
    assert.ok(s.ticks.length > 1 && s.ticks.length < 500, `${s.ticks.length} ticks for [${lo}, ${hi}]`);
  }
});

test("axis labels carry no float noise", () => {
  // Arithmetic on a float step is where the noise comes from — 0.1 + 0.2 is
  // the canonical case, and a tick reading "0.30000000000000004" is the visible
  // symptom.
  assert.equal(axisLabel(0.1 + 0.2), "0.3");
  assert.equal(axisLabel(4.150000000000001), "4.15");
  assert.equal(axisLabel(100), "100");
  assert.equal(axisLabel(20), "20");
});

test("label precision follows magnitude", () => {
  // A coldhead at 4.15 K needs its decimals; a shield at 310 K does not, and
  // "310.7" on a 38-pixel axis gutter would collide with the plot.
  assert.equal(axisLabel(4.153), "4.15");
  assert.equal(axisLabel(72.48), "72.5");
  assert.equal(axisLabel(310.7), "311");
});

// ---- the curve -----------------------------------------------------------

const pts = (ys: number[]) => ys.map((y, i) => ({ x: i * 10, y }));

test("the curve never overshoots the readings it connects", () => {
  // THE reason monotone cubic is used rather than a plain spline. Helium that
  // falls to 24 % and flattens must not be drawn dipping below 24 and curving
  // back — that is a reading the magnet never produced.
  const d = monotonePath(pts([80, 60, 40, 24, 24, 24]));
  const ys = [...d.matchAll(/[-\d.]+,([-\d.]+)/g)].map((m) => Number(m[1]));

  assert.ok(ys.every(Number.isFinite), "path contains NaN");
  assert.ok(Math.max(...ys) <= 80 + 1e-9, `overshot the top: ${Math.max(...ys)}`);
  assert.ok(Math.min(...ys) >= 24 - 1e-9, `overshot the bottom: ${Math.min(...ys)}`);
});

test("a spike does not drag the neighbouring segments past it", () => {
  // A single outlier reading between two flat runs. Every control point must
  // stay inside the data's own range.
  const d = monotonePath(pts([10, 10, 90, 10, 10]));
  const ys = [...d.matchAll(/[-\d.]+,([-\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(Math.max(...ys) <= 90 + 1e-9);
  assert.ok(Math.min(...ys) >= 10 - 1e-9);
});

test("degenerate point counts produce a valid path, not a crash", () => {
  assert.equal(monotonePath([]), "");
  assert.equal(monotonePath(pts([5])), "M0,5");
  assert.equal(monotonePath(pts([5, 9])), "M0,5L10,9");
  // Every longer path starts with a move and is otherwise cubics.
  const d = monotonePath(pts([1, 2, 3]));
  assert.match(d, /^M0,1C/);
});

test("a perfectly flat run stays flat", () => {
  // Equal readings must not acquire curvature — a compressor sitting at 0 all
  // day should draw as a straight line.
  const d = monotonePath(pts([7, 7, 7, 7]));
  const ys = [...d.matchAll(/[-\d.]+,([-\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(ys.every((y) => Math.abs(y - 7) < 1e-9), `flat run curved: ${d}`);
});

test("repeated x values do not divide by zero", () => {
  // Two buckets sharing a timestamp is malformed but survivable; NaN in a path
  // silently blanks the whole line.
  const d = monotonePath([
    { x: 0, y: 1 }, { x: 0, y: 5 }, { x: 10, y: 9 },
  ]);
  assert.doesNotMatch(d, /NaN|Infinity/);
});
