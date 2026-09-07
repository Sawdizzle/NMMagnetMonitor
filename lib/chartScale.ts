// The maths behind the asset page's trend charts, kept out of the component so
// it can be tested without a DOM.
//
// Both functions replace a piece of Recharts (107 kB gzipped, the largest chunk
// in the app, for six 140-pixel line charts). They are the parts that can be
// silently wrong — an axis that rounds badly or a curve that overshoots looks
// plausible and misreports a magnet — which is exactly why they live here and
// carry tests rather than sitting inline in the render.

/**
 * Round, human tick values covering [min, max] — Recharts' `domain={["auto"]}`.
 *
 * Steps are chosen from 1/2/2.5/5 × a power of ten, so a helium axis reads
 * 20/40/60/80 rather than 23.7/41.2/58.7. Returns the padded domain alongside
 * the ticks because the axis has to be drawn to the rounded bounds, not the
 * raw data bounds, or the top tick label sits off the top of the plot.
 */
export function niceScale(min: number, max: number, target = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1] };
  // A dead-flat channel — a stuck sensor, or a compressor that has read 0 all
  // day — has no range to divide. Give it a band so the line sits mid-chart
  // instead of collapsing onto the axis.
  if (max - min < 1e-9) {
    const pad = Math.abs(max) > 1e-9 ? Math.abs(max) * 0.1 : 1;
    return { lo: min - pad, hi: max + pad, ticks: [min - pad, min, max + pad] };
  }

  const raw = (max - min) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;

  // Clamped to the data after rounding. `Math.ceil(max / step) * step` can land
  // a hair BELOW max on a narrow range — [55, 55.0000001] rounds up to
  // 55.000000099999994 — and a domain that excludes its own data draws that
  // point outside the plot, over the axis labels. Rounding is for legibility;
  // containing the readings is not negotiable.
  const lo = Math.min(Math.floor(min / step) * step, min);
  const hi = Math.max(Math.ceil(max / step) * step, max);
  const ticks: number[] = [];
  // Guarded rather than `for (v = lo; v <= hi; v += step)`: accumulating a
  // float step can overshoot or never terminate on awkward values.
  for (let i = 0; i <= Math.round((hi - lo) / step); i++) ticks.push(lo + i * step);
  return { lo, hi, ticks };
}

/** Axis labels without float noise — 72.48, not 72.48000000000001. */
export function axisLabel(v: number): string {
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return Number(v.toFixed(digits)).toString();
}

/**
 * Monotone cubic path (Fritsch–Carlson), matching Recharts' `type="monotone"`.
 *
 * The property that earns it over a plain cubic: it cannot overshoot. A helium
 * level that falls to 24 % and flattens must not be drawn dipping below 24 and
 * curving back — on this page that would be inventing a reading the magnet
 * never produced.
 */
export function monotonePath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0].x},${pts[0].y}`;
  if (n === 2) return `M${pts[0].x},${pts[0].y}L${pts[1].x},${pts[1].y}`;

  // Secant slopes between consecutive points.
  const dx: number[] = [];
  const dy: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1].x - pts[i].x;
    dx.push(h);
    dy.push(pts[i + 1].y - pts[i].y);
    slope.push(h === 0 ? 0 : (pts[i + 1].y - pts[i].y) / h);
  }

  // Tangents: one-sided at the ends, weighted harmonic mean inside.
  const m: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      // A local extremum. A zero tangent here is what forbids the overshoot.
      m.push(0);
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m.push((w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]));
    }
  }
  m.push(slope[n - 2]);

  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${pts[i].x + h},${pts[i].y + m[i] * h},${pts[i + 1].x - h},${pts[i + 1].y - m[i + 1] * h},${pts[i + 1].x},${pts[i + 1].y}`;
  }
  return d;
}
