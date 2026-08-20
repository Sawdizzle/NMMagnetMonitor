import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { addressKey, cToF, compass, iconKey, kmhToMph, parseWindSpeed } from "../lib/weatherFormat.ts";

/**
 * The pure half of the local-weather feature.
 *
 * Everything interesting about lib/weather.ts that does NOT require the network:
 * how an address becomes a cache key, and how ~40 NWS icon slugs collapse into
 * the seven shapes we draw. Both are quietly load-bearing — a change to the key
 * orphans every hand-pinned site_geocode row, and a missed slug silently drops
 * every card to a thermometer.
 *
 * Static and offline, like tests/code-tables.test.mts: no database, no
 * api.weather.gov, no credentials.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("address keys ignore the punctuation humans vary on", () => {
  // The same door, typed three ways by three people in the admin form.
  const same = [
    "1400 N. Texana St., Hallettsville, TX 77964",
    "1400 N Texana St, Hallettsville, TX 77964",
    "  1400   N Texana St   Hallettsville  TX 77964 ",
  ].map(addressKey);
  assert.equal(new Set(same).size, 1, `expected one key, got ${JSON.stringify(same)}`);

  // Different sites must NOT collide — the key is a cache key for coordinates,
  // and a collision would put one hospital's weather on another's card.
  assert.notEqual(addressKey("1777 Curtis Dr, Iuka, MS 38852"), addressKey("1777 Curtis Dr, Iuka, MS 38853"));
});

test("every hand-pinned site_geocode row is written in normalized form", () => {
  // The seeds in schema.sql / the migration are hand-typed keys. If one is not
  // what addressKey() produces, that row is dead weight: the resolver will
  // never find it, and the site it was meant to fix silently loses its pin.
  const sql = readFileSync(join(root, "supabase/schema.sql"), "utf8");
  const pairs = [...sql.matchAll(/\(\s*'([^']+)',\s*'([^']+)',\s*-?\d+\.\d+,\s*-?\d+\.\d+,\s*'manual'/g)];
  for (const [, key, address] of pairs) {
    assert.equal(key, addressKey(address), `seed key for "${address}" is not normalized`);
  }
});

test("NWS icon slugs map to the shapes we actually draw", () => {
  const cases: [string, string][] = [
    ["https://api.weather.gov/icons/land/day/skc?size=medium", "clear-day"],
    ["https://api.weather.gov/icons/land/night/skc?size=medium", "clear-night"],
    ["https://api.weather.gov/icons/land/day/sct?size=medium", "partly-day"],
    ["https://api.weather.gov/icons/land/night/few?size=medium", "partly-night"],
    ["https://api.weather.gov/icons/land/day/ovc?size=medium", "cloudy"],
    ["https://api.weather.gov/icons/land/day/bkn?size=medium", "cloudy"],
    ["https://api.weather.gov/icons/land/day/rain_showers?size=medium", "rain"],
    ["https://api.weather.gov/icons/land/day/tsra_hi?size=medium", "storm"],
    ["https://api.weather.gov/icons/land/day/snow?size=medium", "snow"],
    ["https://api.weather.gov/icons/land/day/fog?size=medium", "fog"],
  ];
  for (const [url, expected] of cases) {
    assert.equal(iconKey(url, null), expected, url);
  }
});

test("icon falls back to the text description, then to unknown", () => {
  // NWS has been threatening to retire the icon field for years; when it goes,
  // textDescription is all that is left.
  assert.equal(iconKey(null, "Mostly Cloudy"), "cloudy");
  assert.equal(iconKey(null, "Thunderstorm"), "storm");
  assert.equal(iconKey(null, "Light Drizzle"), "rain");
  // A mesonet station with no sky report gets a thermometer, not a fake sun.
  assert.equal(iconKey(null, null), "unknown");
  assert.equal(iconKey(null, "Funnel Cloud"), "unknown");
});

test("storm and snow win over the rain their descriptions contain", () => {
  // "Thunderstorms and Rain Showers" must not read as plain rain, and freezing
  // rain is an ice event, not a wet one — order of the checks is the guarantee.
  assert.equal(iconKey(null, "Thunderstorms and Rain Showers"), "storm");
  assert.equal(iconKey(null, "Freezing Rain"), "snow");
});

test("unit conversions round the way the cards display", () => {
  assert.equal(cToF(0), 32);
  assert.equal(cToF(37), 99); // 98.6 -> 99: cards show whole degrees
  assert.equal(cToF(null), null);
  assert.equal(kmhToMph(7.416), 5);
  assert.equal(kmhToMph(0), 0); // calm, not "no data"
  assert.equal(kmhToMph(null), null);
});

test("wind speed parses the grid's prose without swallowing calm", () => {
  assert.equal(parseWindSpeed("10 mph"), 10);
  assert.equal(parseWindSpeed("5 to 10 mph"), 5);
  // 0 is a real reading. A `|| null` here would turn calm into missing data.
  assert.equal(parseWindSpeed("0 mph"), 0);
  assert.equal(parseWindSpeed(undefined), null);
  assert.equal(parseWindSpeed("calm"), null);
});

test("compass bearings land on the right of sixteen points", () => {
  assert.equal(compass(0), "N");
  assert.equal(compass(360), "N"); // wraps rather than falling off the array
  assert.equal(compass(280), "W");
  assert.equal(compass(292.5), "WNW");
  assert.equal(compass(null), null);
});

// ---- ambient alignment ----------------------------------------------------

const { alignAmbient } = await import("../lib/ambientAlign.ts");

const at = (minutes: number) => new Date(Date.UTC(2026, 7, 20, 12, 0) + minutes * 60_000).toISOString();

test("each bucket takes the nearest observation, not the last one seen", () => {
  // 15-minute buckets against an hourly station. The 12:45 bucket is closer to
  // the 13:00 reading than to the 12:00 one, so carrying 12:00 forward would
  // draw a staircase that never happened outside.
  //
  // The 12:30 bucket sits exactly between the two. A tie goes BACKWARDS, to the
  // reading that had already been taken — a trace of what the afternoon was
  // like should not reach forward for a temperature nobody had measured yet.
  const buckets = [at(0), at(15), at(30), at(45), at(60)];
  const points = [
    { t: at(0), tempF: 80 },
    { t: at(60), tempF: 90 },
  ];
  assert.deepEqual(alignAmbient(buckets, points), [80, 80, 80, 90, 90]);
});

test("a gap in reporting leaves a hole rather than a flat line", () => {
  // Two readings six hours apart: the buckets in between get nothing, so the
  // chart shows a break instead of implying the temperature held all afternoon.
  const buckets = [at(0), at(120), at(240), at(360)];
  const points = [
    { t: at(0), tempF: 75 },
    { t: at(360), tempF: 95 },
  ];
  assert.deepEqual(alignAmbient(buckets, points), [75, null, null, 95]);
});

test("alignment survives the shapes that actually turn up", () => {
  // No weather at all: every bucket blank, same length as the input.
  assert.deepEqual(alignAmbient([at(0), at(15)], []), [null, null]);
  // No telemetry yet, but weather exists.
  assert.deepEqual(alignAmbient([], [{ t: at(0), tempF: 80 }]), []);
  // A station denser than the buckets — the common case at an airport.
  const dense = Array.from({ length: 13 }, (_, i) => ({ t: at(i * 5), tempF: 70 + i }));
  assert.deepEqual(alignAmbient([at(0), at(30), at(60)], dense), [70, 76, 82]);
  // An unparseable bucket timestamp must not poison the ones after it.
  assert.deepEqual(alignAmbient(["not-a-date", at(0)], [{ t: at(0), tempF: 88 }]), [null, 88]);
});

test("observations that start after the window still attach to later buckets", () => {
  // Telemetry running before the station's first reading of the window: the
  // early buckets are blank rather than back-filled from the future.
  const buckets = [at(0), at(15), at(180), at(195)];
  const points = [{ t: at(180), tempF: 91 }, { t: at(195), tempF: 92 }];
  assert.deepEqual(alignAmbient(buckets, points), [null, null, 91, 92]);
});

// ---- warmth ramp ----------------------------------------------------------

const { warmthRatio, WARM_START_F, WARM_FULL_F } = await import("../lib/weatherFormat.ts");

test("the warmth ramp has no cliff in the middle of it", () => {
  // The whole reason this replaced a 95F cutoff: 94 and 95 must not look like
  // different categories, and 93 and 99 must not look identical.
  assert.ok(warmthRatio(95) - warmthRatio(94) < 0.1, "neighbouring degrees jump");
  assert.ok(warmthRatio(99) - warmthRatio(93) > 0.2, "a six-degree spread is invisible");
  // Monotonic across the whole plausible range, ends included.
  for (let t = -40; t < 130; t++) {
    assert.ok(warmthRatio(t + 1) >= warmthRatio(t), `ramp goes backwards at ${t}F`);
  }
});

test("the ramp is flat outside its ends and never leaves 0..1", () => {
  assert.equal(warmthRatio(WARM_START_F), 0);
  assert.equal(warmthRatio(WARM_START_F - 30), 0);
  assert.equal(warmthRatio(WARM_FULL_F), 1);
  // Phoenix in July must not compute past full tint.
  assert.equal(warmthRatio(122), 1);
  // A cold site is neutral, not negatively tinted.
  assert.equal(warmthRatio(-20), 0);
  assert.equal(warmthRatio(null), 0);
  assert.equal(warmthRatio(Number.NaN), 0);
});

test("the midpoint of the ramp is halfway tinted", () => {
  assert.equal(warmthRatio((WARM_START_F + WARM_FULL_F) / 2), 0.5);
});
