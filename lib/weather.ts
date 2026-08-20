import "server-only";

import { supabaseAdmin } from "./supabaseServer";
import type { SiteWeather, WeatherIconKey, WeatherResult } from "./weatherTypes";
import { addressKey, cToF, compass, iconKey, kmhToMph, parseWindSpeed, round } from "./weatherFormat";

export type { SiteWeather, WeatherIconKey, WeatherResult };
export { addressKey } from "./weatherFormat";

// Outside weather at each site, for the dashboard cards and the asset page.
//
// Why it belongs in a magnet monitor: these are water-cooled compressors. A
// 105F afternoon shows up as rising H2O Temp and a chiller working harder,
// which shows up hours later as helium boil-off. Ambient temperature is the
// one input to that chain we can see but do not measure — so we borrow it.
//
// Source is the National Weather Service (api.weather.gov): free, no API key,
// no commercial-use restriction, and it covers every unit in the fleet because
// every unit is in the US. That last part is also its limit — a non-US site
// resolves to nothing and the UI simply shows no weather. If the fleet ever
// leaves the country, WEATHER_PROVIDER is the seam to add a second one behind.
//
// Two lookups back this, cached at very different rates:
//   geocode   address -> lat/lon, in the site_geocode table (near-permanent)
//   NWS       lat/lon -> grid + station -> observation (30 days / 10 minutes)

const NWS_BASE = "https://api.weather.gov";
const CENSUS_GEOCODER =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

// NWS asks every client to identify itself and to include contact info so they
// can reach whoever is hammering them. The contact is env-configured rather
// than baked in: it is a real address handed to a third party, and it differs
// per deployment.
const USER_AGENT =
  process.env.NWS_CONTACT
    ? `NMMagnetMonitor/1.0 (${process.env.NWS_CONTACT})`
    : "NMMagnetMonitor/1.0";

// A grid cell and its station list are stable geography — the mapping changes
// when NWS redraws a forecast office, which is a once-in-years event.
const GEOGRAPHY_TTL_S = 30 * 24 * 60 * 60;
// Most ASOS stations report hourly, some every 20 minutes. Ten minutes keeps
// the panel honest without asking for observations that do not exist yet.
const OBSERVATION_TTL_S = 10 * 60;
// An address the geocoder could not place is retried weekly, not per request.
const GEOCODE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 6000;
// How far out to walk the station list before giving up on a real observation.
// Five covers a metro grid comfortably; past that the stations are far enough
// away that the gridded analysis at the site is the better answer anyway.
const MAX_STATIONS = 5;


// ---- upstream fetch -------------------------------------------------------

async function getJson<T>(url: string, revalidate: number, headers?: HeadersInit): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, ...headers },
      // Next's data cache, shared across requests and instances: 17 assets on
      // 12 addresses behind however many open dashboards collapse to one
      // upstream call per address per TTL.
      next: { revalidate },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // Weather is decoration on a monitoring tool. A timeout, a 500 from NWS or
    // a DNS blip must degrade to "no weather", never to a failed fleet load.
    return null;
  }
}

// ---- geocoding ------------------------------------------------------------

type Coords = { latitude: number; longitude: number };

type CensusResponse = {
  result?: { addressMatches?: { coordinates?: { x: number; y: number } }[] };
};

async function geocodeUpstream(address: string): Promise<Coords | null> {
  const url =
    `${CENSUS_GEOCODER}?address=${encodeURIComponent(address)}` +
    `&benchmark=Public_AR_Current&format=json`;
  // Census is a street-level US geocoder: it either matches a TIGER address
  // range or it does not, and it has no notion of "close enough". Sites it
  // cannot place get a manual row instead.
  const body = await getJson<CensusResponse>(url, GEOGRAPHY_TTL_S);
  const c = body?.result?.addressMatches?.[0]?.coordinates;
  if (!c || typeof c.x !== "number" || typeof c.y !== "number") return null;
  return { latitude: c.y, longitude: c.x };
}

type GeocodeRow = {
  address_key: string;
  latitude: number | null;
  longitude: number | null;
  source: string;
  resolved_at: string | null;
  attempted_at: string;
  attempts: number;
};

/**
 * Coordinates for a batch of addresses, resolving anything not cached yet.
 *
 * Returns only what it could place; an unresolvable address is simply absent
 * from the map, which the caller renders as "no weather" rather than an error.
 */
async function resolveCoords(addresses: string[]): Promise<Map<string, Coords>> {
  const keys = addresses.map(addressKey);
  const { data } = await supabaseAdmin
    .from("site_geocode")
    .select("address_key, latitude, longitude, source, resolved_at, attempted_at, attempts")
    .in("address_key", keys);

  const cached = new Map<string, GeocodeRow>();
  for (const row of (data ?? []) as GeocodeRow[]) cached.set(row.address_key, row);

  const out = new Map<string, Coords>();
  const toResolve: string[] = [];

  for (const address of addresses) {
    const key = addressKey(address);
    const row = cached.get(key);
    if (row?.latitude != null && row.longitude != null) {
      out.set(key, { latitude: row.latitude, longitude: row.longitude });
      continue;
    }
    // A hand-entered row with no coordinates is a deliberate "this site has no
    // weather" — leave it be. Everything else is retried on a slow cadence.
    if (row?.source === "manual") continue;
    const attempted = row ? Date.parse(row.attempted_at) : 0;
    if (!row || Date.now() - attempted > GEOCODE_RETRY_MS) toResolve.push(address);
  }

  if (toResolve.length === 0) return out;

  await Promise.all(
    toResolve.map(async (address) => {
      const key = addressKey(address);
      const coords = await geocodeUpstream(address);
      if (coords) out.set(key, coords);
      await supabaseAdmin.from("site_geocode").upsert(
        {
          address_key: key,
          address,
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
          source: "census",
          resolved_at: coords ? new Date().toISOString() : null,
          attempted_at: new Date().toISOString(),
          // Counts tries, not successes — a row sitting at attempts=5 with no
          // coordinates is the signal that this address needs a manual fix.
          attempts: (cached.get(key)?.attempts ?? 0) + 1,
        },
        { onConflict: "address_key" }
      );
    })
  );

  return out;
}

// ---- NWS ------------------------------------------------------------------

type PointsResponse = {
  properties?: {
    observationStations?: string;
    forecastHourly?: string;
    relativeLocation?: { properties?: { city?: string; state?: string } };
  };
};

type StationsResponse = {
  features?: { properties?: { stationIdentifier?: string } }[];
};

type Quantity = { value: number | null } | null | undefined;

type HourlyResponse = {
  properties?: {
    periods?: {
      startTime?: string;
      isDaytime?: boolean;
      temperature?: number;
      temperatureUnit?: string;
      relativeHumidity?: Quantity;
      windSpeed?: string;
      windDirection?: string;
      icon?: string | null;
      shortForecast?: string;
    }[];
  };
};

type ObservationResponse = {
  properties?: {
    timestamp?: string;
    textDescription?: string;
    icon?: string | null;
    temperature?: Quantity;
    dewpoint?: Quantity;
    relativeHumidity?: Quantity;
    windSpeed?: Quantity;
    windDirection?: Quantity;
    heatIndex?: Quantity;
    windChill?: Quantity;
  };
};

/** NWS rejects more than four decimal places on /points with a redirect. */
const round4 = (n: number) => Math.round(n * 10000) / 10000;

async function fetchWeather(coords: Coords): Promise<SiteWeather | null> {
  const point = await getJson<PointsResponse>(
    `${NWS_BASE}/points/${round4(coords.latitude)},${round4(coords.longitude)}`,
    GEOGRAPHY_TTL_S
  );
  if (!point?.properties) return null; // outside NWS coverage (non-US, or offshore)

  const rel = point.properties.relativeLocation?.properties;
  const place = rel?.city && rel?.state ? `${rel.city}, ${rel.state}` : null;

  const observed = await fetchObservation(point.properties.observationStations, place);
  if (observed) return observed;

  // No nearby station has a usable reading. This is not rare: around Crestline,
  // CA the three closest "stations" are RAWS sites that publish fuel moisture
  // and leave temperature null, and rural Texas and Mississippi grids look the
  // same. NWS's own hourly analysis for the cell is always populated, so a site
  // gets real numbers instead of an empty card — flagged as a grid value.
  return fetchGridHour(point.properties.forecastHourly, place);
}

/** First nearby station carrying BOTH a temperature and a sky description.
 *  Half-populated stations are skipped rather than blended: a measured
 *  temperature under someone else's cloud cover is worse than neither. */
async function fetchObservation(
  stationsUrl: string | undefined,
  place: string | null
): Promise<SiteWeather | null> {
  if (!stationsUrl) return null;

  const stations = await getJson<StationsResponse>(stationsUrl, GEOGRAPHY_TTL_S);
  const ids = (stations?.features ?? [])
    .map((f) => f.properties?.stationIdentifier)
    .filter((id): id is string => !!id)
    .slice(0, MAX_STATIONS);

  for (const id of ids) {
    const obs = await getJson<ObservationResponse>(
      `${NWS_BASE}/stations/${encodeURIComponent(id)}/observations/latest`,
      OBSERVATION_TTL_S
    );
    const p = obs?.properties;
    const tempC = p?.temperature?.value ?? null;
    const condition = p?.textDescription?.trim() || null;
    if (tempC === null || !condition) continue;

    return {
      tempF: cToF(tempC),
      // NWS reports whichever of heat index / wind chill applies and leaves the
      // other null; on a mild day both are null and "feels like" is just the
      // temperature, which is not worth a line of its own.
      feelsLikeF: cToF(p?.heatIndex?.value ?? p?.windChill?.value ?? null),
      humidity: round(p?.relativeHumidity?.value ?? null, 0),
      windMph: kmhToMph(p?.windSpeed?.value ?? null),
      windDir: compass(p?.windDirection?.value ?? null),
      condition,
      icon: iconKey(p?.icon ?? null, condition),
      observedAt: p?.timestamp ?? null,
      station: id,
      place,
      source: "station",
    };
  }
  return null;
}

/** The current hour of NWS's gridded hourly forecast — already in F and mph. */
async function fetchGridHour(
  hourlyUrl: string | undefined,
  place: string | null
): Promise<SiteWeather | null> {
  if (!hourlyUrl) return null;

  // Shorter-lived than an observation: the grid is reissued through the day and
  // period[0] rolls over on the hour.
  const hourly = await getJson<HourlyResponse>(hourlyUrl, OBSERVATION_TTL_S);
  const now = hourly?.properties?.periods?.[0];
  if (!now || typeof now.temperature !== "number") return null;
  // Guard the one assumption worth guarding: NWS serves Fahrenheit here today,
  // and a silent unit switch would put 30C on a card as "30F".
  if (now.temperatureUnit && now.temperatureUnit.toUpperCase() !== "F") return null;

  const condition = now.shortForecast?.trim() || null;
  return {
    tempF: Math.round(now.temperature),
    // The grid carries no heat index or wind chill.
    feelsLikeF: null,
    humidity: round(now.relativeHumidity?.value ?? null, 0),
    windMph: parseWindSpeed(now.windSpeed),
    windDir: now.windDirection?.trim() || null,
    condition,
    icon: iconKey(now.icon ?? null, condition),
    observedAt: now.startTime ?? null,
    station: null,
    place,
    source: "grid",
  };
}

// ---- the org-scoped entry point -------------------------------------------

type SiteRow = { id: string; site_address: string | null };

/**
 * Current conditions for every asset in one org, keyed by asset id.
 *
 * Assets sharing a site address share one upstream lookup — Numed has five
 * units at the Denton service center, and they are not five weather stations.
 */
export async function loadWeatherForOrg(orgId: string): Promise<WeatherResult> {
  const { data, error } = await supabaseAdmin
    .from("assets")
    .select("id, site_address")
    .eq("org_id", orgId);
  if (error) return { weather: {}, error: error.message };

  const rows = (data ?? []) as SiteRow[];
  const byKey = new Map<string, string[]>();
  const addressForKey = new Map<string, string>();
  for (const row of rows) {
    const address = row.site_address?.trim();
    if (!address) continue;
    const key = addressKey(address);
    addressForKey.set(key, address);
    byKey.set(key, [...(byKey.get(key) ?? []), row.id]);
  }
  if (byKey.size === 0) return { weather: {}, error: null };

  const coords = await resolveCoords([...addressForKey.values()]);

  const weather: Record<string, SiteWeather> = {};
  await Promise.all(
    [...byKey.entries()].map(async ([key, assetIds]) => {
      const point = coords.get(key);
      if (!point) return;
      const current = await fetchWeather(point);
      if (!current) return;
      for (const id of assetIds) weather[id] = current;
    })
  );

  return { weather, error: null };
}
