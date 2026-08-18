import "server-only";

import { supabaseAdmin } from "./supabaseServer";
import type { DebriefEntry, DebriefResult, DebriefBucket } from "./dataSource";

// The morning debrief: everything the alerting system did between yesterday
// morning and this morning, in one read.
//
// It is DERIVED, not stored — there is no nightly job and no snapshot table.
// The window is pinned to the most recent 9am boundary, so the answer is stable
// for the whole day (open it at 09:05 and again at 16:00 and you see the same
// debrief) and rolls over on its own at 9am the next morning. Nothing to
// schedule, nothing to backfill, and no way for a missed cron run to leave a
// morning with no debrief.

/**
 * The zone the 9am boundary is measured in.
 *
 * A fixed zone rather than the viewer's, on purpose: two people in different
 * zones must be looking at the SAME window, or "the 9am debrief" stops being
 * one shared artifact that a team can talk about.
 */
export const DEBRIEF_TIME_ZONE = "America/Chicago";
export const DEBRIEF_HOUR = 9;

type ZonedParts = { year: number; month: number; day: number };

const PART_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: DEBRIEF_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * The zone's UTC offset at a given instant, in ms.
 *
 * Read out of Intl rather than hard-coded, so the DST flip is handled by the
 * platform's tz database instead of by us guessing which half of the year it is.
 */
function zoneOffsetMs(instant: number): number {
  const parts = PART_FORMAT.formatToParts(new Date(instant));
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    at("year"),
    at("month") - 1,
    at("day"),
    at("hour"),
    at("minute"),
    at("second")
  );
  return asUtc - instant;
}

function zonedDateOf(instant: number): ZonedParts {
  const parts = PART_FORMAT.formatToParts(new Date(instant));
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: at("year"), month: at("month"), day: at("day") };
}

/**
 * The instant at which the clock in DEBRIEF_TIME_ZONE reads `hour:00` on the
 * given local date.
 *
 * Two passes: the offset we need is the one in effect at the ANSWER, not at the
 * naive UTC reading of the same wall clock, and those differ across a DST
 * changeover. Guessing once and correcting once converges for every real zone.
 */
function zonedHourToInstant({ year, month, day }: ZonedParts, hour: number): number {
  const wall = Date.UTC(year, month - 1, day, hour, 0, 0);
  const first = wall - zoneOffsetMs(wall);
  return wall - zoneOffsetMs(first);
}

export type DebriefWindow = { start: number; end: number };

/**
 * The window a debrief viewed at `now` covers: the most recent 9am boundary
 * (`end`) back to the 9am before it (`start`).
 *
 * Boundaries are calendar-local, so on the two DST changeover days the window
 * is 23 or 25 hours rather than exactly 24. That is deliberate — "since
 * yesterday morning" with no gap and no overlap beats a rigid 24h that would
 * drift the boundary off 9am and either double-report or drop an hour of alerts.
 */
export function debriefWindow(now: Date = new Date()): DebriefWindow {
  const t = now.getTime();

  let end = zonedHourToInstant(zonedDateOf(t), DEBRIEF_HOUR);
  // Before 9am local, today's boundary hasn't happened yet: the live debrief is
  // still yesterday's. Step back a day in the zone (not a flat -24h on the
  // result) so a changeover day lands on 9am rather than 8 or 10.
  if (end > t) end = zonedHourToInstant(zonedDateOf(end - 24 * 60 * 60 * 1000), DEBRIEF_HOUR);

  const start = zonedHourToInstant(zonedDateOf(end - 24 * 60 * 60 * 1000), DEBRIEF_HOUR);
  return { start, end };
}

function bucketFor(openedInWindow: boolean, resolvedInWindow: boolean): DebriefBucket {
  if (openedInWindow) return resolvedInWindow ? "flapped" : "new";
  return resolvedInWindow ? "cleared" : "ongoing";
}

/**
 * One org's alert activity for the debrief window.
 *
 * Three kinds of row qualify, and all three matter to someone reading this at
 * 9am: opened in the window, resolved in the window, and still open from before
 * it (the unit that has been down all week is exactly what a morning debrief
 * must not quietly omit).
 *
 * Events opened AFTER the boundary are excluded — they belong to tomorrow's
 * debrief, and including them would make the page change under the reader
 * during the day, which is the property the fixed boundary exists to provide.
 */
export async function loadDebriefForOrg(
  orgId: string,
  now: Date = new Date()
): Promise<DebriefResult> {
  const { start, end } = debriefWindow(now);
  const startIso = new Date(start).toISOString();
  const endIso = new Date(end).toISOString();
  const window = { start: startIso, end: endIso, timeZone: DEBRIEF_TIME_ZONE, hour: DEBRIEF_HOUR };
  const empty: DebriefResult = {
    window,
    entries: [],
    counts: { opened: 0, resolved: 0, stillOpen: 0, assetsAffected: 0 },
    error: null,
  };

  // Asset ids first, then events — same shape as loadFleetForOrg. alert_events
  // carries no org_id of its own, so this list IS the tenant boundary.
  const { data: assetRows, error: assetsErr } = await supabaseAdmin
    .from("assets")
    .select("id, name")
    .eq("org_id", orgId);
  if (assetsErr) return { ...empty, error: assetsErr.message };

  const names = new Map((assetRows ?? []).map((a) => [a.id as string, a.name as string]));
  if (names.size === 0) return empty;

  const { data, error } = await supabaseAdmin
    .from("alert_events")
    .select("id, asset_id, alert_rule_id, kind, message, triggered_at, resolved_at")
    .in("asset_id", [...names.keys()])
    .lt("triggered_at", endIso)
    .or(`triggered_at.gte.${startIso},resolved_at.gte.${startIso},resolved_at.is.null`)
    .order("triggered_at", { ascending: false });
  if (error) return { ...empty, error: error.message };

  const entries: DebriefEntry[] = (data ?? []).map((e) => {
    const triggered = new Date(e.triggered_at as string).getTime();
    const resolved = e.resolved_at ? new Date(e.resolved_at as string).getTime() : null;
    const openedInWindow = triggered >= start;
    const resolvedInWindow = resolved !== null && resolved >= start && resolved < end;
    return {
      id: e.id as number,
      assetId: e.asset_id as string,
      assetName: names.get(e.asset_id as string) ?? "Unknown unit",
      // The grain repeats are collapsed at in the UI: same asset, same kind,
      // same rule. Not the message — a threshold message embeds the reading
      // ("now 100.476"), so twenty crossings of one rule would look like twenty
      // different problems.
      alertRuleId: (e.alert_rule_id as string | null) ?? null,
      kind: e.kind as string,
      message: e.message as string,
      triggeredAt: e.triggered_at as string,
      resolvedAt: (e.resolved_at as string | null) ?? null,
      bucket: bucketFor(openedInWindow, resolvedInWindow),
      // An event that recovered after the boundary is still reported as it stood
      // at 9am (bucket "new"/"ongoing"), but the reader is told it has since
      // cleared — otherwise the page insists a unit is down that plainly isn't.
      resolvedAfterWindow: resolved !== null && resolved >= end,
    };
  });

  return {
    window,
    entries,
    counts: {
      opened: entries.filter((e) => e.bucket === "new" || e.bucket === "flapped").length,
      resolved: entries.filter((e) => e.bucket === "flapped" || e.bucket === "cleared").length,
      // "Still open" is as of the boundary, matching the buckets — not as of now.
      stillOpen: entries.filter((e) => e.bucket === "new" || e.bucket === "ongoing").length,
      assetsAffected: new Set(entries.map((e) => e.assetId)).size,
    },
    error: null,
  };
}
