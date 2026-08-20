"use client";

// Outside-temperature history for one asset, on the same slow cadence as the
// weather chips. Stations report hourly at best and the server caches for ten
// minutes, so anything faster would re-serve identical bytes.

import { useEffect, useState } from "react";
import { getDataSource } from "./dataSource";
import type { AmbientResult } from "./weatherTypes";

const AMBIENT_POLL_MS = 10 * 60_000;
const EMPTY: AmbientResult = { points: [], station: null, error: null };

export function useAmbient(assetId: string, demo: boolean, hours: number): AmbientResult {
  // Stored WITH the asset it belongs to, and matched during render, so
  // navigating between units cannot draw the previous site's weather behind
  // this one's water trend — not even for the single frame that clearing the
  // state inside the effect would still leave.
  const [loaded, setLoaded] = useState<{ assetId: string; result: AmbientResult } | null>(null);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      const next = await getDataSource(demo).loadAmbient(assetId, hours);
      // Hold nothing on error: an empty trace just hides the dashed line, which
      // is the right failure for context that is nice to have.
      if (alive && !next.error) setLoaded({ assetId, result: next });
    };
    run();
    const t = setInterval(run, AMBIENT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [assetId, demo, hours]);

  return loaded?.assetId === assetId ? loaded.result : EMPTY;
}
