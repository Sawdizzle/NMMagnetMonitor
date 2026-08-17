"use client";

// Fleet-wide helium forecasts for the glance surfaces (dashboard + TV).
//
// Loads a week of he_lvl for the WHOLE fleet in one request and fits a boil-off
// forecast per asset, on a slow cadence independent of the 30s status poll — the
// trend changes by the day, not the second. Keyed by asset id so a card can look
// up its own forecast in O(1).
//
// This used to fan out one request per asset: 17 round trips for Numed, each
// with its own ownership check, every 10 minutes for every open dashboard and
// wall display. Now it is one call to loadFleetHelium.

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
      const { series } = await getDataSource(demo).loadFleetHelium(FLEET_FORECAST_HOURS);
      if (!alive) return;
      // Fit per asset from the one payload. An asset with no helium history
      // simply has no entry, and heliumForecast handles the empty case.
      setForecasts(Object.fromEntries(ids.map((id) => [id, heliumForecast(series[id] ?? [])])));
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
