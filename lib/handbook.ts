import "server-only";

import { listOrgAssets, loadOpenAlertsForOrg } from "./fleetQueries";
import { COLLECTOR_VERSION } from "./piScript";
import { usesMagmon } from "./modality";

/**
 * The live half of the operations handbook.
 *
 * Deliberately a query, not a component: it reads the clock, and clock reads
 * belong in the data layer rather than in render, where a re-render would
 * silently change the answer. The page above it is then only a gate and a
 * layout.
 */

export type HandbookAttention = {
  name: string;
  site: string | null;
  open: number;
  worst: "critical" | "warning";
  oldestDays: number;
  headline: string;
};

export type HandbookData = {
  generatedAt: string;
  counts: { total: number; reporting: number; maintenance: number; env: number };
  rollout: { currentVersion: string; current: string[]; behind: string[] };
  attention: HandbookAttention[];
};

const DEFAULT_STALE_MINUTES = 30;

export async function loadHandbookData(orgId: string): Promise<HandbookData> {
  const [{ assets }, { alerts }] = await Promise.all([
    listOrgAssets(orgId),
    loadOpenAlertsForOrg(orgId),
  ]);

  const now = Date.now();

  const reporting = assets.filter((a) => {
    if (!a.last_sample_at) return false;
    const staleAfter = (a.offline_threshold_minutes ?? DEFAULT_STALE_MINUTES) * 60_000;
    return now - new Date(a.last_sample_at).getTime() <= staleAfter;
  }).length;

  // Only MagMon units run the MagMon collector, so a PET/CT trailer is not
  // "behind" for lacking its version — it runs the environmental one.
  const magmonUnits = assets.filter((a) => usesMagmon(a.modality));

  // One row per unit with anything open: how many, how bad, how long, and the
  // worst one's own words. A unit's headline follows its worst alert, because
  // that is the one that decides whether anybody moves today.
  const byAsset = new Map<string, HandbookAttention>();
  for (const e of alerts) {
    const days = Math.floor((now - new Date(e.triggered_at).getTime()) / 86_400_000);
    const existing = byAsset.get(e.assetName);
    if (!existing) {
      const asset = assets.find((a) => a.id === e.asset_id);
      byAsset.set(e.assetName, {
        name: e.assetName,
        site: asset?.site_name?.trim() || null,
        open: 1,
        worst: e.severity,
        oldestDays: days,
        headline: e.message,
      });
      continue;
    }
    existing.open += 1;
    existing.oldestDays = Math.max(existing.oldestDays, days);
    if (e.severity === "critical" && existing.worst !== "critical") {
      existing.worst = "critical";
      existing.headline = e.message;
    }
  }

  // Critical first, then longest-open — the order somebody would work them in.
  const attention = [...byAsset.values()].sort(
    (a, b) =>
      (a.worst === b.worst ? 0 : a.worst === "critical" ? -1 : 1) || b.oldestDays - a.oldestDays
  );

  return {
    generatedAt: new Date(now).toISOString(),
    counts: {
      total: assets.length,
      reporting,
      maintenance: assets.filter((a) => a.maintenance).length,
      env: assets.filter((a) => !usesMagmon(a.modality)).length,
    },
    rollout: {
      currentVersion: COLLECTOR_VERSION,
      current: magmonUnits
        .filter((a) => a.collector_version === COLLECTOR_VERSION)
        .map((a) => a.name),
      behind: magmonUnits
        .filter((a) => a.collector_version !== COLLECTOR_VERSION)
        .map((a) => a.name),
    },
    attention,
  };
}
