"use client";

// Fleet-wide helium forecasts for the glance surfaces (dashboard + TV).
//
// Loads a week-long he_lvl series per asset and fits a boil-off forecast, on a
// slow cadence that's independent of the 30s status poll — the trend changes by
// the day, not the second, and ten extra RPC calls shouldn't ride every refresh.
// Keyed by asset id so a card can look up its own forecast in O(1).

import { useEffect, useMemo, useState } from "react";
import { getDataSource } from "./dataSource";
import { heliumForecast, type HeliumForecast } from "./forecast";

const FLEET_FORECAST_HOURS = 24 * 7;
const FLEET_FORECAST_POLL_MS = 10 * 60_000;

export function useFleetForecasts(
  assetIds: string[],
  demo: boolean
): Record<string, HeliumForecast | null> {
  const [forecasts, setForecasts] = useState<Record<string, HeliumForecast | null>>({});

  // Depend on the *content* of the id list, not the array identity — the fleet
  // poll hands us a fresh array every 30s but the ids rarely change, so this
  // keeps the forecast load on its own slow schedule instead of restarting.
  const idsKey = useMemo(() => [...assetIds].sort().join(","), [assetIds]);

  useEffect(() => {
    if (!idsKey) return;
    const ids = idsKey.split(",");
    let alive = true;
    const run = async () => {
      const entries = await Promise.all(
        ids.map(async (id) => {
          const { points } = await getDataSource(demo).loadHeliumSeries(id, FLEET_FORECAST_HOURS);
          return [id, heliumForecast(points)] as const;
        })
      );
      if (!alive) return;
      setForecasts(Object.fromEntries(entries));
    };
    run();
    const t = setInterval(run, FLEET_FORECAST_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [idsKey, demo]);

  return forecasts;
}
