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
