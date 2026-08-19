"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getDataSource, type DebriefEntry, type DebriefResult } from "@/lib/dataSource";
import { useDemo } from "@/lib/demoContext";
import { NO_TELEMETRY_KINDS } from "@/lib/health";
import OrgMark from "./OrgMark";

// The morning debrief page: what the alerting system did between yesterday
// morning and this morning, in the order someone triaging it cares about —
// what is still broken, then what fixed itself, then what merely flickered.
//
// The window is pinned server-side to the most recent 9am boundary (see
// lib/debrief.ts), so this page reads the same all day and rolls over on its
// own. The poll below exists only so a screen left open overnight crosses the
// boundary without a manual refresh; there is nothing live to chase here.
const POLL_MS = 5 * 60_000;

type Section = {
  key: string;
  title: string;
  blurb: string;
  entries: DebriefEntry[];
  tone: "bad" | "good" | "neutral";
};

/**
 * Repeat occurrences of ONE condition, collapsed into a single row.
 *
 * A unit sitting right on a threshold opens and resolves the same rule every
 * few minutes — one asset produced twenty of them overnight in the real fleet.
 * Listed flat, that is a wall of near-identical lines that hides the other nine
 * units. Collapsed, "×20" is itself the finding.
 */
type DebriefGroup = {
  key: string;
  lead: DebriefEntry;
  count: number;
  earliest: string;
  latest: string;
  openMs: number;
};

function groupEntries(entries: DebriefEntry[]): DebriefGroup[] {
  const groups = new Map<string, DebriefGroup>();
  // `entries` arrives newest-first, so the first occurrence seen is the lead
  // and insertion order keeps the section sorted by most recent activity.
  for (const e of entries) {
    const key = `${e.assetId}|${e.kind}|${e.alertRuleId ?? ""}`;
    const span = (e.resolvedAt ? new Date(e.resolvedAt).getTime() : Date.now()) -
      new Date(e.triggeredAt).getTime();
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        lead: e,
        count: 1,
        earliest: e.triggeredAt,
        latest: e.resolvedAt ?? e.triggeredAt,
        openMs: Math.max(0, span),
      });
      continue;
    }
    existing.count++;
    if (e.triggeredAt < existing.earliest) existing.earliest = e.triggeredAt;
    const last = e.resolvedAt ?? e.triggeredAt;
    if (last > existing.latest) existing.latest = last;
    existing.openMs += Math.max(0, span);
  }
  return [...groups.values()];
}

export default function Debrief() {
  const { demo, basePath, brand } = useDemo();
  const [data, setData] = useState<DebriefResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const result = await getDataSource(demo).loadDebrief();
      if (!alive) return;
      setData(result);
      setLoading(false);
    };
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [demo]);

  if (loading && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center text-[var(--text-muted)]" role="status" aria-live="polite">
        Loading debrief&hellip;
      </div>
    );
  }

  // A window is always in hand, even on an error response — the header and the
  // timestamp formatter both need one, and a half-drawn page is worse than a
  // page that says "no activity" above an error banner.
  const w = data?.window ?? { start: "", end: "", timeZone: "UTC", hour: 9 };
  const tz = w.timeZone;
  const counts = data?.counts ?? { opened: 0, resolved: 0, stillOpen: 0, assetsAffected: 0 };
  const entries = data?.entries ?? [];

  // "New" ahead of "ongoing" inside the same section: something that broke
  // overnight is news, something that has been broken for a week is context.
  const stillOpen = [
    ...entries.filter((e) => e.bucket === "new"),
    ...entries.filter((e) => e.bucket === "ongoing"),
  ];
  const sections: Section[] = ([
    {
      key: "open",
      title: "Still open",
      blurb: "Open as of this morning's cutoff — these need someone.",
      entries: stillOpen,
      tone: "bad",
    },
    {
      key: "cleared",
      title: "Cleared overnight",
      blurb: "Was already open when the window started, recovered during it.",
      entries: entries.filter((e) => e.bucket === "cleared"),
      tone: "good",
    },
    {
      key: "flapped",
      title: "Came and went",
      blurb: "Opened and resolved inside the window — no action needed, but worth a look if it repeats.",
      entries: entries.filter((e) => e.bucket === "flapped"),
      tone: "neutral",
    },
  ] as Section[]).filter((s) => s.entries.length > 0);

  return (
    <div id="main-content" className="min-h-screen p-6 md:p-10" role="main">
      <header className="mb-6">
        <p className="eyebrow mb-1.5">{brand.eyebrow}</p>
        <div className="flex items-center gap-3 justify-between flex-wrap">
          <div className="flex items-center gap-3">
            <span className="dash-mark" aria-hidden="true">
              <OrgMark size="100%" bleed />
            </span>
            <div>
              <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Morning debrief</h1>
              <p className="text-xs text-[var(--text-dim)] mt-1">
                {w.start ? windowLabel(w) : "—"}
              </p>
            </div>
          </div>
          <Link href={basePath || "/"} className="btn-secondary inline-flex items-center gap-1.5 shrink-0">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M10 8l-4 4 4 4M6 12h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back to fleet
          </Link>
        </div>
      </header>

      {data?.error && (
        <div className="debrief-error" role="alert">
          {data.error}
        </div>
      )}

      <div className="debrief-tiles mb-7">
        <DebriefTile n={counts.opened} label={counts.opened === 1 ? "alert opened" : "alerts opened"} color="var(--status-offline)" />
        <DebriefTile n={counts.resolved} label={counts.resolved === 1 ? "resolution" : "resolutions"} color="var(--status-online)" />
        <DebriefTile n={counts.stillOpen} label="still open" color="var(--status-warning)" />
        <DebriefTile n={counts.assetsAffected} label={counts.assetsAffected === 1 ? "unit involved" : "units involved"} color="var(--text-muted)" />
      </div>

      {entries.length === 0 && !data?.error ? (
        <div className="debrief-quiet">
          <span className="debrief-quiet-mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M4.5 12.5l5 5 10-11" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <p className="text-sm font-semibold">All quiet.</p>
            <p className="text-xs text-[var(--text-dim)] mt-0.5">
              Nothing opened, nothing resolved, and nothing was left open from before the window.
            </p>
          </div>
        </div>
      ) : (
        sections.map((s) => {
          const groups = groupEntries(s.entries);
          return (
            <section key={s.key} className="mb-8">
              <h2 className="debrief-section-title" data-tone={s.tone}>
                {s.title}
                {/* Counts CONDITIONS, matching the rows below. The raw event
                    total follows in the blurb when collapsing hid some, so the
                    header never disagrees with what is on screen and nothing
                    silently disappears. */}
                <span className="debrief-section-count">{groups.length}</span>
              </h2>
              <p className="text-xs text-[var(--text-dim)] mb-3">
                {s.blurb}
                {groups.length < s.entries.length &&
                  ` ${s.entries.length} events in all — repeats of one condition are collapsed.`}
              </p>
              <div className="flex flex-col gap-2">
                {groups.map((g) => (
                  <DebriefRow key={g.key} g={g} w={w} basePath={basePath} />
                ))}
              </div>
            </section>
          );
        })
      )}

      <p className="text-[11px] text-[var(--text-dim)] mt-8">
        Covers every alert the monitor opened or resolved in the window, plus anything still open from
        before it. Rolls over automatically at {formatHour(w.hour)} {tzAbbrev(w.end, tz)}.
      </p>
    </div>
  );
}

function DebriefTile({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div className="debrief-tile" style={{ ["--dc" as string]: color }}>
      <span className="debrief-tile-num font-mono-data">{n}</span>
      <span className="debrief-tile-lbl">{label}</span>
    </div>
  );
}

function DebriefRow({
  g,
  w,
  basePath,
}: {
  g: DebriefGroup;
  w: DebriefResult["window"];
  basePath: string;
}) {
  const e = g.lead;
  const color = severityColor(e);
  return (
    <div className="debrief-row" style={{ ["--ac" as string]: color }} data-bucket={e.bucket}>
      <span className="alert-dot" aria-hidden="true" />
      <div className="debrief-row-body">
        <div className="debrief-row-head">
          <Link href={`${basePath}/asset/${e.assetId}`} className="debrief-asset">
            {e.assetName}
          </Link>
          <span className="debrief-kind">{kindLabel(e.kind)}</span>
          {g.count > 1 && (
            <span className="debrief-repeat" title="Times this same condition opened during the window">
              &times;{g.count}
            </span>
          )}
          {e.resolvedAfterWindow && <span className="debrief-since">cleared since</span>}
        </div>
        <p className="debrief-msg">{e.message}</p>
      </div>
      <span className="debrief-timing font-mono-data">{timing(g, w)}</span>
    </div>
  );
}

// offline, reporting_stalled and never_reported all mean "no telemetry" -> red;
// thresholds and a blind channel are amber (the unit is still reporting, we just
// can't see one metric). Anything already resolved reads dim, whatever it was —
// same convention as the alert rows on the asset page.
function severityColor(e: DebriefEntry): string {
  if (e.bucket === "cleared" || e.bucket === "flapped") return "var(--text-dim)";
  return NO_TELEMETRY_KINDS.has(e.kind)
    ? "var(--status-offline)"
    : "var(--status-warning)";
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "offline":
      return "Offline";
    case "reporting_stalled":
      return "Reporting stalled";
    case "threshold":
      return "Threshold";
    case "sensor_fault":
      return "Sensor fault";
    case "cooling_loss":
      return "Cooling fault";
    case "trend":
      return "Trend";
    case "flatline":
      return "Flatlined";
    case "bound":
      return "Out of range";
    case "never_reported":
      return "Never reported";
    default:
      return kind.replace(/_/g, " ");
  }
}

function fmtDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function clock(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  });
}

function dayAndClock(iso: string, tz: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" })}, ${clock(iso, tz)}`;
}

function localDay(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/**
 * A timestamp with just enough date on it to be unambiguous.
 *
 * The window always straddles two calendar days, and events still open from
 * before it can be a week old — so a bare clock reading turns "opened Monday
 * morning, cleared Tuesday dawn" into "8:10 AM → 6:33 AM", which reads
 * backwards. The window's own two days get a weekday; anything older gets a
 * date, because a weekday alone stops being unique past a week.
 */
function stamp(iso: string, w: DebriefResult["window"]): string {
  const tz = w.timeZone;
  const day = localDay(iso, tz);
  const inWindowDays = day === localDay(w.start, tz) || day === localDay(w.end, tz);
  const prefix = new Date(iso).toLocaleDateString("en-US",
    inWindowDays
      ? { timeZone: tz, weekday: "short" }
      : { timeZone: tz, month: "short", day: "numeric" });
  return `${prefix} ${clock(iso, tz)}`;
}

// What happened and when, in the debrief's zone rather than relative "3h ago" —
// a digest is read hours after the fact, so an absolute time is the useful one.
function timing(g: DebriefGroup, w: DebriefResult["window"]): string {
  const e = g.lead;
  if (g.count > 1) {
    return `${stamp(g.earliest, w)} → ${stamp(g.latest, w)} · ${fmtDur(g.openMs)} total`;
  }
  const trig = new Date(e.triggeredAt).getTime();
  if (!e.resolvedAt) return `opened ${stamp(e.triggeredAt, w)} · open ${fmtDur(Date.now() - trig)}`;
  const res = new Date(e.resolvedAt).getTime();
  return `${stamp(e.triggeredAt, w)} → ${stamp(e.resolvedAt, w)} · ${fmtDur(res - trig)}`;
}

function formatHour(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:00 ${hour < 12 ? "AM" : "PM"}`;
}

function tzAbbrev(iso: string | undefined, tz: string): string {
  if (!iso) return "";
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(new Date(iso))
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}

function windowLabel(w: DebriefResult["window"]): string {
  return `${dayAndClock(w.start, w.timeZone)} → ${dayAndClock(w.end, w.timeZone)} ${tzAbbrev(w.end, w.timeZone)}`;
}
