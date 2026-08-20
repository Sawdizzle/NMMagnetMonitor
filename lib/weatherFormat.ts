// The pure half of the weather reader: normalization, unit conversion and the
// NWS icon mapping. No imports, no I/O, no "server-only" — which is the point.
// lib/weather.ts talks to Census and api.weather.gov and cannot be exercised
// without both; these are the parts with real branching, so they live where a
// test can reach them (tests/weather-format.test.mts).

import type { WeatherIconKey } from "./weatherTypes";

// ---- address normalization ------------------------------------------------

/**
 * The site_geocode primary key.
 *
 * Punctuation and case are noise in a hand-typed address — "1400 N. Texana St.,
 * Hallettsville" and "1400 N Texana St Hallettsville" are the same door — so
 * they are collapsed out. This must stay in step with any hand-seeded row.
 */
export function addressKey(address: string): string {
  return address.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
}


export function cToF(c: number | null): number | null {
  return c === null ? null : Math.round(c * (9 / 5) + 32);
}

/** The grid gives wind as prose — "10 mph", or "5 to 10 mph" for a range. Take
 *  the leading number; `|| null` would be wrong here because 0 means calm. */
export function parseWindSpeed(text: string | undefined): number | null {
  const n = parseInt(text ?? "", 10);
  return Number.isFinite(n) ? n : null;
}

export function kmhToMph(kmh: number | null): number | null {
  return kmh === null ? null : Math.round(kmh * 0.621371);
}

export function round(n: number | null, digits: number): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

export function compass(degrees: number | null): string | null {
  if (degrees === null || !Number.isFinite(degrees)) return null;
  return COMPASS[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16];
}


/**
 * Collapse the ~40 NWS icon slugs into the handful of shapes we actually draw.
 *
 * The slug lives in a URL like /icons/land/day/tsra_hi?size=medium, and NWS has
 * been threatening to retire that field for years — so textDescription is the
 * fallback, and "unknown" (a plain thermometer) is a fine final answer.
 */
export function iconKey(iconUrl: string | null, description: string | null): WeatherIconKey {
  const path = (iconUrl ?? "").split("?")[0];
  const parts = path.split("/").filter(Boolean);
  const slug = parts.length ? parts[parts.length - 1] : "";
  const night = path.includes("/night/");
  const text = (description ?? "").toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => slug.startsWith(n) || text.includes(n));

  if (has("tsra", "thunder")) return "storm";
  // "freezing"/"wintry" are here rather than under rain on purpose: freezing
  // rain reads as rain by its text and as fzra by its slug, and it is an ice
  // event either way. This check must stay ABOVE the rain one.
  if (has("snow", "blizzard", "sleet", "fzra", "ice", "freezing", "wintry")) return "snow";
  if (has("rain", "shower", "drizzle")) return "rain";
  if (has("fog", "haze", "smoke", "dust")) return "fog";
  if (has("ovc", "overcast", "bkn", "cloudy")) return "cloudy";
  if (has("sct", "few", "partly", "mostly sunny", "mostly clear")) return night ? "partly-night" : "partly-day";
  if (has("skc", "clear", "sunny", "wind_skc", "hot", "cold")) return night ? "clear-night" : "clear-day";
  return "unknown";
}

