import "server-only";

import { supabaseAdmin } from "./supabaseServer";
import type { DebriefEntry, DebriefResult } from "./dataSource";
// The window maths and the bucket rule live in their own module so they can
// be tested — this file is server-only and a node test cannot import it.
import { DEBRIEF_TIME_ZONE, DEBRIEF_HOUR, debriefWindow, bucketFor } from "./debriefWindow.ts";
export { DEBRIEF_TIME_ZONE, DEBRIEF_HOUR, debriefWindow };
export type { DebriefWindow } from "./debriefWindow.ts";

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
    .select("id, asset_id, alert_rule_id, kind, message, triggered_at, resolved_at, suppression_id")
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
      // Set at insert by the alert_event_suppress trigger, so this is the
      // historical truth about whether the event paged — not whether the mute
      // happens to still be standing when the debrief is read.
      muted: (e.suppression_id as string | null) !== null,
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
