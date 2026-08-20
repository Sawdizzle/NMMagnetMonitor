// Weather shapes shared by the server reader (lib/weather.ts) and the client
// components that render it. Split out because lib/weather.ts is "server-only"
// and Dashboard/AssetDetail are client components: a type-only import would be
// erased, but keeping the types on this side of the line makes that guarantee
// structural instead of incidental.

export type WeatherIconKey =
  | "clear-day"
  | "clear-night"
  | "partly-day"
  | "partly-night"
  | "cloudy"
  | "rain"
  | "snow"
  | "storm"
  | "fog"
  | "unknown";

/** Current conditions at one site. Every field is independently nullable —
 *  stations drop channels routinely, and a missing humidity must not blank the
 *  temperature next to it. */
export type SiteWeather = {
  tempF: number | null;
  feelsLikeF: number | null;
  humidity: number | null;
  windMph: number | null;
  windDir: string | null;
  condition: string | null;
  /** Our own icon key, not an NWS URL — the client renders it as inline SVG. */
  icon: WeatherIconKey;
  observedAt: string | null;
  /** e.g. "KDTO" — shown so an operator can tell how close the reading is. */
  station: string | null;
  /** Nearest named place per NWS, e.g. "Denton, TX". */
  place: string | null;
  /** "station" = a real observation from `station`. "grid" = NWS's own hourly
   *  analysis for the forecast cell the site sits in, used where no nearby
   *  station actually reports (rural and mountain grids are ringed by mesonet
   *  sites that carry fuel moisture and nothing else). Surfaced in the UI —
   *  a measurement and a model output should not be presented as the same
   *  thing. */
  source: "station" | "grid";
};

/** Keyed by asset id. An asset with no resolvable location is simply absent. */
export type WeatherResult = { weather: Record<string, SiteWeather>; error: string | null };
