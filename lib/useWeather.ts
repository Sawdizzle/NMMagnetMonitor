"use client";

// Outside conditions for the whole fleet, on their own slow cadence.
//
// One request for every site, keyed by asset id so a card looks up its own in
// O(1) — the same shape as useFleetForecasts, and for the same reason: the
// alternative is one round trip per card on every 30s status poll.
//
// The cadence is deliberately far slower than the telemetry poll. Stations
// report hourly, the server caches observations for ten minutes, and polling
// faster would only re-serve the same cached bytes.

import { useEffect, useState } from "react";
import { getDataSource } from "./dataSource";
import type { SiteWeather } from "./weatherTypes";

const WEATHER_POLL_MS = 10 * 60_000;

export function useWeather(demo: boolean): Record<string, SiteWeather> {
  const [weather, setWeather] = useState<Record<string, SiteWeather>>({});

  useEffect(() => {
    let alive = true;
    const run = async () => {
      const { weather: next, error } = await getDataSource(demo).loadWeather();
      // Hold the last good reading rather than blanking the cards: NWS goes
      // down for minutes at a time, and a magnet dashboard flickering its
      // weather chips off and on is worse than a chip that is 20 minutes old.
      if (alive && !error) setWeather(next);
    };
    run();
    const t = setInterval(run, WEATHER_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [demo]);

  return weather;
}
