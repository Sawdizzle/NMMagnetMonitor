"use client";

import WeatherIcon from "./WeatherIcon";
import type { SiteWeather } from "@/lib/weatherTypes";
import { warmthRatio } from "@/lib/weatherFormat";

// Outside conditions at the site, in two sizes: a chip beside the site name on
// a fleet card, and a panel on the asset page.
//
// Both are informational only. Nothing here ever raises an alert or colours a
// status — a hot day is context for a rising H2O Temp, not a fault in itself.

/**
 * A continuous "the chiller is working today" cue, not a threshold — the
 * compressor's own limits live in lib/faults.ts and are the ones that alarm.
 *
 * Mixes toward `neutral` — the colour the element would wear with no tint at
 * all — so that a barely-warm site is indistinguishable from a cool one on
 * every surface. The default of currentColor covers the two text cases (a
 * card chip inherits dim text, the asset page's big temperature inherits full
 * brightness); the panel's icon passes its own, because its untinted state is
 * neither of those.
 *
 * Returns undefined below the ramp so nothing is painted at all — a 0% mix
 * computes to the same colour, but leaving the property unset means a cool
 * site carries no inline style to reason about.
 */
function accentFor(weather: SiteWeather, neutral = "currentColor"): string | undefined {
  const ratio = warmthRatio(weather.tempF);
  if (ratio <= 0) return undefined;
  return `color-mix(in srgb, var(--status-warning) ${Math.round(ratio * 100)}%, ${neutral})`;
}

/** How stale an observation is, in the station's own terms. Hourly reporting is
 *  normal, so this only speaks up once a reading is old enough to mislead. */
function staleNote(observedAt: string | null): string | null {
  if (!observedAt) return null;
  const mins = Math.round((Date.now() - Date.parse(observedAt)) / 60000);
  if (!Number.isFinite(mins) || mins < 90) return null;
  return mins < 60 * 48 ? `${Math.round(mins / 60)}h old` : "stale";
}

/** How the reading was arrived at, in the fewest words that stay true. */
function sourceLabel(weather: SiteWeather): string {
  return weather.source === "station" && weather.station
    ? `NWS ${weather.station}`
    : "NWS grid forecast";
}

function summary(weather: SiteWeather): string {
  return [
    weather.place,
    weather.condition,
    weather.tempF !== null ? `${weather.tempF}°F` : null,
    sourceLabel(weather),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Compact form for a fleet card: an icon and a temperature, nothing else. */
export function WeatherChip({ weather }: { weather: SiteWeather | null }) {
  // Absent rather than empty: a site whose address will not geocode, or a
  // station that dropped offline, should look like the feature was never there
  // instead of like something is broken.
  if (!weather || weather.tempF === null) return null;

  return (
    <span
      className="inline-flex items-center gap-1 shrink-0 tabular-nums"
      style={{ color: accentFor(weather) }}
      title={summary(weather)}
    >
      <WeatherIcon icon={weather.icon} size={13} />
      {weather.tempF}°
    </span>
  );
}

// The panel icon sits dimmer than the temperature beside it when untinted, so
// its ramp has to start from there rather than from the inherited text colour.
const ICON_NEUTRAL = "var(--text-muted)";

/** Full panel for the asset page. */
export function WeatherPanel({ weather }: { weather: SiteWeather | null }) {
  if (!weather || weather.tempF === null) return null;

  const accent = accentFor(weather);
  // Only meaningful for a real observation: the grid always describes the hour
  // you are asking about, so it is never "old".
  const stale = weather.source === "station" ? staleNote(weather.observedAt) : null;
  // Only worth a line when it actually differs — NWS reports heat index or wind
  // chill and leaves the other null, so on a mild day this equals the air temp.
  const feelsLike =
    weather.feelsLikeF !== null && weather.feelsLikeF !== weather.tempF ? weather.feelsLikeF : null;

  return (
    <div className="rounded-2xl border border-[var(--border-soft)] bg-[var(--card)] p-5 mb-10">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)]">Outside conditions</h2>
        <span className="text-[10px] text-[var(--text-dim)]">
          {sourceLabel(weather)}
          {stale ? ` · ${stale}` : ""}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
        <div className="flex items-center gap-3 min-w-0">
          <span style={{ color: accentFor(weather, ICON_NEUTRAL) ?? ICON_NEUTRAL }}>
            <WeatherIcon icon={weather.icon} size={34} title={weather.condition ?? "Current conditions"} />
          </span>
          <div className="min-w-0">
            <p className="text-2xl md:text-3xl font-semibold tracking-tight tabular-nums" style={{ color: accent }}>
              {weather.tempF}°F
            </p>
            <p className="text-xs text-[var(--text-dim)] mt-1">
              {[weather.condition, weather.place].filter(Boolean).join(" · ") || "Current conditions"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 font-mono-data text-sm">
          {feelsLike !== null && <WeatherStat label="Feels like" value={`${feelsLike} °F`} />}
          {weather.humidity !== null && <WeatherStat label="Humidity" value={`${weather.humidity} %`} />}
          {weather.windMph !== null && (
            <WeatherStat
              label="Wind"
              value={weather.windMph === 0 ? "calm" : `${weather.windMph} mph ${weather.windDir ?? ""}`.trim()}
            />
          )}
          {weather.observedAt && (
            <WeatherStat
              // A gridded value is the model's read on the current hour, not a
              // measurement taken at a moment — so it does not claim to be one.
              label={weather.source === "station" ? "Observed" : "For hour"}
              value={new Date(weather.observedAt).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            />
          )}
        </div>
      </div>

      <p className="text-[11px] text-[var(--text-dim)] mt-4">
        Ambient context for the water loop — a hot afternoon shows up in H2O Temp before it shows up
        in helium. Not a fault signal.
        {weather.source === "grid" &&
          " No station near this site reports conditions, so this is the National Weather Service's gridded analysis for the site rather than a measurement."}
      </p>
    </div>
  );
}

function WeatherStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-[var(--text-dim)]">{label}</p>
      <p className="text-[var(--text)]">{value}</p>
    </div>
  );
}
