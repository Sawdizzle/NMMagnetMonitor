// Helium boil-off forecasting.
//
// A healthy magnet with a working coldhead loses essentially no helium — the
// level is flat. A failing coldhead (or a leak) shows up first as a slow,
// steady decline in he_lvl long before it trips a low-level alarm. Fitting a
// line to the recent helium history turns that slope into the number the
// service team actually plans around: "how many days until this needs a fill?"
//
// This is a pure module: it takes a series of (time, level) points and returns
// a forecast, with a confidence flag so the UI never shows a confident date off
// a handful of noisy readings. It knows nothing about Supabase or React.

export type HeliumPoint = { t: number; v: number }; // t = epoch ms, v = he_lvl %

export type HeliumTrend = "falling" | "stable" | "rising";
export type ForecastConfidence = "high" | "medium" | "low";

export type HeliumForecast = {
  trend: HeliumTrend;
  ratePerDay: number; // signed %/day (negative = boiling off)
  currentPct: number; // fitted level at the latest sample (less noisy than raw)
  floor: number; // the refill-planning level days-to-refill counts down to
  daysToRefill: number | null; // null unless falling toward the floor
  refillBy: number | null; // epoch ms when the fit reaches the floor
  r2: number; // goodness of fit, 0..1
  confidence: ForecastConfidence;
  spanDays: number; // time covered by the fitted window
  n: number; // points used
};

export const DEFAULT_REFILL_FLOOR = 20; // %; plan a fill before the low-level alarms

// Below this magnitude (%/day) we call the level flat rather than trending —
// keeps sensor jitter from reading as a slow fill or boil-off.
const FLAT_RATE = 0.05;
const MIN_POINTS = 4;
const MAX_HORIZON_DAYS = 3650; // beyond ~10y, treat as "not meaningfully falling"

// Fit he_lvl against time and project when it reaches the refill floor. Returns
// null when there isn't enough signal to say anything (too few points, or no
// time span). `now` is injectable for deterministic tests.
export function heliumForecast(
  points: HeliumPoint[],
  opts?: { floor?: number; now?: number }
): HeliumForecast | null {
  const floor = opts?.floor ?? DEFAULT_REFILL_FLOOR;
  const now = opts?.now ?? Date.now();

  const clean = points
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (clean.length < MIN_POINTS) return null;

  const n = clean.length;
  const tMin = clean[0].t;
  const tMax = clean[n - 1].t;
  const spanMs = tMax - tMin;
  if (spanMs <= 0) return null;
  const spanDays = spanMs / 86_400_000;

  // Ordinary least squares with x centered on its mean (keeps the epoch-ms
  // magnitudes from wrecking precision).
  const xBar = clean.reduce((s, p) => s + p.t, 0) / n;
  const yBar = clean.reduce((s, p) => s + p.v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of clean) {
    const dx = p.t - xBar;
    const dy = p.v - yBar;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;

  const slopePerMs = sxy / sxx; // % per ms
  const ratePerDay = slopePerMs * 86_400_000;
  const r2 = syy === 0 ? 1 : Math.max(0, Math.min(1, (sxy * sxy) / (sxx * syy)));

  // Fitted (de-noised) level at the most recent sample.
  const currentPct = yBar + slopePerMs * (tMax - xBar);

  const trend: HeliumTrend =
    ratePerDay <= -FLAT_RATE ? "falling" : ratePerDay >= FLAT_RATE ? "rising" : "stable";

  let daysToRefill: number | null = null;
  let refillBy: number | null = null;
  if (trend === "falling") {
    const days = (currentPct - floor) / -ratePerDay; // -ratePerDay > 0 here
    if (days <= MAX_HORIZON_DAYS) {
      daysToRefill = Math.max(0, days);
      refillBy = now + daysToRefill * 86_400_000;
    }
  }

  return {
    trend,
    ratePerDay,
    currentPct,
    floor,
    daysToRefill,
    refillBy,
    r2,
    confidence: gradeConfidence(r2, spanDays, n),
    spanDays,
    n,
  };
}

// Confidence blends fit quality, how long a window we saw, and how many points.
// A clean week-long decline is "high"; a short or noisy window is "low" and the
// UI should hedge the number.
function gradeConfidence(r2: number, spanDays: number, n: number): ForecastConfidence {
  if (spanDays >= 3 && n >= 12 && r2 >= 0.6) return "high";
  if (spanDays >= 1 && n >= 8 && r2 >= 0.3) return "medium";
  return "low";
}

// How soon a refill is due — drives chip color across the fleet.
export type RefillUrgency = "soon" | "watch";

// A compact chip label for fleet views ("12d to refill"), or null when the unit
// isn't meaningfully falling toward a fill within the planning horizon. Farther
// than ~4 months out reads as effectively stable, so it stays off the glance.
const CHIP_HORIZON_DAYS = 120;
export function refillChipLabel(f: HeliumForecast | null): string | null {
  if (!f || f.trend !== "falling" || f.daysToRefill === null) return null;
  const d = f.daysToRefill;
  if (d >= CHIP_HORIZON_DAYS) return null;
  if (d < 1) return "refill due";
  if (d < 14) return `${Math.round(d)}d to refill`;
  if (d < 60) return `${Math.round(d / 7)}w to refill`;
  return `${Math.round(d / 30)}mo to refill`;
}

// Under two weeks is "soon" (amber); otherwise "watch" (cool). Only meaningful
// when refillChipLabel is non-null.
export function refillUrgency(f: HeliumForecast): RefillUrgency {
  return f.daysToRefill !== null && f.daysToRefill < 14 ? "soon" : "watch";
}

// A short, glanceable phrase for the forecast headline.
export function forecastHeadline(f: HeliumForecast): string {
  if (f.trend === "rising") return "Helium rising";
  if (f.trend === "stable") return "Helium stable";
  if (f.daysToRefill === null) return "Slow decline";
  const d = f.daysToRefill;
  if (d < 1) return "Refill due now";
  if (d < 14) return `~${Math.round(d)} days to refill`;
  if (d < 60) return `~${Math.round(d / 7)} weeks to refill`;
  return `~${Math.round(d / 30)} months to refill`;
}
