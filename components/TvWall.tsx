"use client";

// TV / Display mode — a chrome-free wall display for the service center.
//
// Opened on a TV and left running: it auto-advances horizontally through the
// fleet a few big cards at a time, at a leisurely pace, so anyone can read it
// at a glance from across the room. Alarms take priority — units in a bad
// state are pulled to the front of the rotation, flash, and raise a persistent
// banner so a fault is never hidden between page turns. When all is well the
// screen stays calm and green.
//
// Public + unattended: no login, keeps the screen awake, recovers on its own
// from network blips via the same 30s poll the dashboard uses. Tunable by URL:
//   ?dwell=20    seconds each page is shown (default 15)
//   ?perView=2   columns per page (default: auto-fit to screen width)
//   ?rows=2      rows per page (default 2)
//   ?anim=slide  rotation transition: zoom (default) | fade | slide | up | blur | none

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getDataSource, type FleetAsset } from "@/lib/dataSource";
import { useDemo } from "@/lib/demoContext";
import { minutesSince } from "@/lib/health";
import {
  computeAssetAlarm,
  sortByAlarmPriority,
  buildAlertItems,
  groupAlertItems,
  ALARM_COLORS,
  ALARM_LABELS,
  type AlarmLevel,
} from "@/lib/faults";
import { cryoState, CRYO_SHORT_LABELS } from "@/lib/cryo";
import { useFleetForecasts } from "@/lib/useFleetForecasts";
import { refillChipLabel, refillUrgency, type HeliumForecast } from "@/lib/forecast";
import {
  envNum,
  powerState,
  showsPower,
  usesMagmon,
  zonesToShow,
  POWER_COLORS,
  POWER_SHORT,
} from "@/lib/modality";
import OrgMark from "./OrgMark";
import MiniLineChart from "./MiniLineChart";

const POLL_MS = 30_000;
const HISTORY_HOURS = 1;
const DEFAULT_DWELL_S = 15;

// Card entrance styles for units cycling into the rotation, selectable via
// ?anim=. "none" turns the transition off. Default is "zoom".
const ENTER_ANIMS = ["fade", "slide", "up", "zoom", "blur", "none"];

export default function TvWall() {
  const { demo, brand, basePath } = useDemo();
  const params = useSearchParams();

  const dwellMs = clampInt(params.get("dwell"), 5, 120, DEFAULT_DWELL_S) * 1000;
  const perViewOverride = params.get("perView") ? clampInt(params.get("perView"), 1, 6, 3) : null;
  // Transition style for cards cycling into the rotation (see ENTER_ANIMS).
  const animRaw = params.get("anim");
  const enterAnim = animRaw && ENTER_ANIMS.includes(animRaw) ? animRaw : "zoom";
  // Shift-handoff overlay: opt-in via ?handoff=<minutes> (0/absent = off, so the
  // existing wall display is unchanged). Shows a full-fleet digest for a few
  // seconds on that cadence. ?handoffSecs= tunes how long it stays up.
  const handoffMin = params.get("handoff") ? clampInt(params.get("handoff"), 1, 240, 0) : 0;
  const handoffSecs = clampInt(params.get("handoffSecs"), 5, 120, 18);

  const [assets, setAssets] = useState<FleetAsset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => 0);

  // ---- data: poll the fleet, same source as the dashboard ----------------
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { assets: rows, error: err } = await getDataSource(demo).loadFleet(HISTORY_HOURS);
      if (!alive) return;
      if (err) {
        setError(err);
        return; // keep showing the last good frame; recover on the next tick
      }
      setAssets(rows);
      setError(null);
      setLoaded(true);
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [demo]);

  // ---- a ticking clock (also refreshes "x min ago" + re-derives health) ---
  useEffect(() => {
    // seeds the clock on mount. Date.now() cannot be rendered on the
    // server without a hydration mismatch, so the first value has to land here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // ---- keep the TV awake -------------------------------------------------
  useEffect(() => {
    type WakeLockNav = Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    let sentinel: { release: () => Promise<void> } | null = null;
    const request = async () => {
      try {
        sentinel = (await (navigator as WakeLockNav).wakeLock?.request("screen")) ?? null;
      } catch {
        /* wake lock unsupported or blocked — the display still works */
      }
    };
    request();
    const onVisible = () => {
      if (document.visibilityState === "visible") request();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      sentinel?.release().catch(() => {});
    };
  }, []);

  // ---- full screen (a one-tap toggle for the wall TV setup) --------------
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    } else {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }, []);

  // ---- audible chime on a NEW critical -----------------------------------
  // Off by default (an unattended wall shouldn't surprise anyone), opt-in via
  // the header toggle and remembered per browser. Browsers block audio until a
  // user gesture, so the AudioContext is created/resumed inside the toggle.
  const [soundOn, setSoundOn] = useState(false);
  useEffect(() => {
    // reads the remembered sound preference after hydration;
    // localStorage does not exist during SSR.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSoundOn(localStorage.getItem("tv-sound") === "on");
  }, []);
  const audioCtxRef = useRef<AudioContext | null>(null);
  // The set of asset ids currently critical, so we chime only on new entries.
  const seenCriticalRef = useRef<Set<string> | null>(null);

  const toggleSound = useCallback(() => {
    setSoundOn((on) => {
      const next = !on;
      localStorage.setItem("tv-sound", next ? "on" : "off");
      if (next) {
        // Create/resume the context on this gesture so later chimes are allowed,
        // and give an immediate confirmation blip that sound is armed.
        const ctx =
          audioCtxRef.current ??
          (audioCtxRef.current = new (window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)());
        ctx.resume().catch(() => {});
        playChime(ctx, "arm");
      }
      return next;
    });
  }, []);

  // ---- responsive grid ---------------------------------------------------
  // Both axes are measured, because a grid is two decisions and they have
  // different inputs: how many cards fit across is a question about width, how
  // many fit down is a question about height. Rows used to be a fixed 2 at
  // every size, which is why a 4K panel showed six cards on a screen with room
  // for sixteen.
  const [vw, setVw] = useState(1280);
  const [vh, setVh] = useState(800);
  useEffect(() => {
    const onResize = () => {
      setVw(window.innerWidth);
      setVh(window.innerHeight);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Columns by width. The 640 floor exists because small landscape panels — the
  // 800x480 and 1024x600 screens people actually mount on a wall — were falling
  // to a single column of enormously wide cards with the second row clipped off
  // the bottom; only a portrait phone genuinely needs one column. The 2400 step
  // is the 4K/ultrawide end: at 3840 a three-column card is over a metre wide
  // on a real panel, mostly empty.
  const autoPerView = vw < 640 ? 1 : vw < 1400 ? 2 : vw < 2400 ? 3 : 4;
  const cols = Math.max(1, Math.min(perViewOverride ?? autoPerView, Math.max(1, assets.length)));
  // Rows by height, on the same principle. The thresholds are set so that a
  // cell never falls below roughly 300px tall, which is where a card starts
  // having to drop its sparklines: 1080p keeps the 2 rows it has always had,
  // 1440p takes 3, and 2160p takes 4 — a 4x4 of sixteen cells, very nearly
  // Numed's whole fleet on one screen with no rotation at all.
  const autoRows = vh >= 1900 ? 4 : vh >= 1300 ? 3 : 2;
  // ...but never reserve a row the fleet cannot fill. A 4K screen asks for four
  // rows; a twelve-unit fleet in four columns only has three rows' worth, and
  // the sixteen-cell grid left the bottom quarter of the wall blank. Taking the
  // smaller of the two makes the cards grow into the space instead.
  const fittedRows = Math.min(autoRows, Math.ceil(Math.max(1, assets.length) / cols));
  // ?rows= still wins, now up to 4 rather than 3 so the override can reach what
  // a 4K screen picks on its own.
  const rowCount = clampInt(params.get("rows"), 1, 4, Math.max(1, fittedRows));

  // ---- ordering (recomputed as `now` ticks so status stays live) ---------
  // `now` is listed on purpose. It is not read in the callback, but the
  // helpers called here derive status from the current time, so the tick is
  // what keeps the wall live; drop it and the display freezes at first paint.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ordered = useMemo(() => sortByAlarmPriority(assets), [assets, now]);

  // Fleet helium forecasts (days-to-refill), on their own slow cadence.
  const forecasts = useFleetForecasts(assets.map((a) => a.id), demo);

  // ---- shift-handoff overlay ---------------------------------------------
  const [showHandoff, setShowHandoff] = useState(false);
  useEffect(() => {
    if (handoffMin <= 0) return;
    let hideTimer: ReturnType<typeof setTimeout>;
    const reveal = () => {
      setShowHandoff(true);
      hideTimer = setTimeout(() => setShowHandoff(false), handoffSecs * 1000);
    };
    // Appear shortly after load so it's demonstrable, then on the chosen cadence.
    const firstTimer = setTimeout(reveal, 8000);
    const id = setInterval(reveal, handoffMin * 60_000);
    return () => {
      clearTimeout(firstTimer);
      clearTimeout(hideTimer);
      clearInterval(id);
    };
  }, [handoffMin, handoffSecs]);
  // `now` is listed on purpose. It is not read in the callback, but the
  // helpers called here derive status from the current time, so the tick is
  // what keeps the wall live; drop it and the display freezes at first paint.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const summary = useMemo(() => buildShiftSummary(ordered, forecasts), [ordered, forecasts, now]);

  // One uniform, edge-to-edge grid of equal cards. Critical (red) units hold the
  // first cells and stay put (never rotate); every remaining cell cycles through
  // everyone else — warning (amber), nominal (green), unknown (grey), maintenance
  // (blue) — a page at a time. Warnings still stay surfaced via the ticker.
  const criticalUnits = useMemo(
    () => ordered.filter((a) => computeAssetAlarm(a).level === "critical"),
    // `now` is listed on purpose. It is not read in the callback, but the
    // helpers called here derive status from the current time, so the tick is
    // what keeps the wall live; drop it and the display freezes at first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ordered, now]
  );

  // Chime when an asset newly crosses into critical. Diffs the current critical
  // id set against the previous one; the first populated frame only establishes
  // the baseline (so opening the page over an existing alarm stays silent).
  const criticalKey = useMemo(
    () => criticalUnits.map((a) => a.id).sort().join(","),
    [criticalUnits]
  );
  useEffect(() => {
    if (!loaded) return; // wait for real data — the empty mount frame isn't a baseline
    const current = new Set(criticalKey ? criticalKey.split(",") : []);
    const prev = seenCriticalRef.current;
    seenCriticalRef.current = current;
    if (prev === null) return; // first loaded frame only establishes the baseline
    if (!soundOn) return;
    let isNew = false;
    for (const id of current) if (!prev.has(id)) { isNew = true; break; }
    if (!isNew) return;
    // Reuse the gesture-unlocked context if we have one; otherwise try to make
    // one. On a normal browser it stays suspended (silent, no error) until the
    // operator has interacted; on a kiosk with autoplay allowed it just sounds.
    let ctx = audioCtxRef.current;
    if (!ctx) {
      try {
        ctx = audioCtxRef.current = new (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      } catch {
        return;
      }
    }
    ctx.resume().catch(() => {});
    playChime(ctx, "alert");
  }, [criticalKey, soundOn, loaded]);

  const totalCells = cols * rowCount;
  const pinned = criticalUnits.slice(0, totalCells); // static, capped to the grid
  const pinnedIds = new Set(pinned.map((a) => a.id));
  const rotating = ordered.filter((a) => !pinnedIds.has(a.id));
  const rotCells = Math.max(0, totalCells - pinned.length); // cells left to rotate

  // Page through the rotating units with a full-size window that never leaves a
  // sparse or pinned-only last page: the final page's start is clamped so its
  // window still ends at the list's end (overlapping the previous page instead
  // of showing blanks), then rotation wraps back to the first page.
  const pageCount =
    rotCells > 0 && rotating.length > rotCells ? Math.ceil(rotating.length / rotCells) : 1;

  // Every open issue as its own "ASSET — error" line for the scrolling ticker:
  // criticals and warnings both, so a warning stays visible until it's cleared
  // or accepted (maintenance). Maintenance units are excluded by design.
  // `now` is listed on purpose. It is not read in the callback, but the
  // helpers called here derive status from the current time, so the tick is
  // what keeps the wall live; drop it and the display freezes at first paint.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const alertItems = useMemo(() => buildAlertItems(ordered), [ordered, now]);
  // One line per asset, faults joined — see groupAlertItems.
  const alertGroups = useMemo(() => groupAlertItems(alertItems), [alertItems]);
  const anyCritical = alertItems.some((it) => it.severity === "critical");

  // ---- rotation ----------------------------------------------------------
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (pageCount <= 1) return;
    const id = setInterval(() => setPage((p) => (p + 1) % pageCount), dwellMs);
    return () => clearInterval(id);
  }, [pageCount, dwellMs]);
  // Derive the effective page instead of clamping through state. If pageCount
  // shrinks under us (assets dropped off, or the grid grew enough to fit them
  // all), a stale `page` would otherwise render one blank frame before an
  // effect corrected it — and that correction was a setState-in-effect, i.e. a
  // cascading render on a screen that repaints every second.
  const safePage = pageCount > 0 ? page % pageCount : 0;

  const clockDate = now ? new Date(now) : null;
  const dateStr = clockDate
    ? clockDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : "";
  const clockStr = clockDate ? clockDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  const maxStart = Math.max(0, rotating.length - rotCells);
  const rotStart = rotCells > 0 ? Math.min(safePage * rotCells, maxStart) : 0;
  const rotWindow = rotCells > 0 ? rotating.slice(rotStart, rotStart + rotCells) : [];

  return (
    <div className="tv-root" role="main">
      <header className="tv-header">
        <div className="tv-brand">
          <OrgMark size={30} />
          <div>
            <p className="tv-brand-name">{brand.productName ?? "Magnet Monitor"}</p>
            <p className="tv-brand-sub">Fleet Status</p>
          </div>
          {demo && <span className="tv-demo-chip">DEMO</span>}
        </div>

        <div className="tv-summary" aria-live="off">
          <Tally color={ALARM_COLORS.critical} n={countLevel(ordered, "critical")} label="Alarm" />
          <Tally color={ALARM_COLORS.warning} n={countLevel(ordered, "warning")} label="Warning" />

          <Tally color={ALARM_COLORS.ok} n={countLevel(ordered, "ok")} label="Nominal" />
          <Tally color={ALARM_COLORS.unknown} n={countLevel(ordered, "unknown")} label="No data" />
          <Tally color={ALARM_COLORS.maintenance} n={countLevel(ordered, "maintenance")} label="Maint." />
        </div>

        <div className="tv-header-right">
          <button
            type="button"
            className="tv-fs"
            onClick={toggleSound}
            aria-pressed={soundOn}
            aria-label={soundOn ? "Mute alarm chime" : "Enable alarm chime"}
            title={soundOn ? "Alarm chime on — click to mute" : "Alarm chime off — click to enable"}
            style={soundOn ? { opacity: 1, color: ALARM_COLORS.ok, borderColor: ALARM_COLORS.ok } : undefined}
          >
            {soundOn ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 9v6h4l5 4V5L8 9H4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 9v6h4l5 4V5L8 9H4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                <path d="M17 9.5l4 5M21 9.5l-4 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
          </button>
          <Link
            href={basePath || "/"}
            className="tv-fs"
            onClick={() => {
              if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
            }}
            aria-label="Exit TV mode"
            title="Exit TV mode"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M14 5h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M10 8l-4 4 4 4M6 12h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <button
            type="button"
            className="tv-fs"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Exit full screen" : "Enter full screen"}
            title={isFullscreen ? "Exit full screen" : "Full screen"}
          >
            {isFullscreen ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9 4v3a2 2 0 0 1-2 2H4M20 9h-3a2 2 0 0 1-2-2V4M15 20v-3a2 2 0 0 1 2-2h3M4 15h3a2 2 0 0 1 2 2v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          <div className="tv-clock">
            <span className="tv-live" aria-hidden="true">
              <span className="tv-live-dot" style={{ background: error ? ALARM_COLORS.warning : ALARM_COLORS.ok }} />
              {error ? "reconnecting" : "live"}
            </span>
            <span className="tv-time font-mono-data">
              <span className="tv-date">{dateStr}</span>
              {clockStr}
            </span>
          </div>
        </div>
      </header>

      {alertItems.length > 0 && (
        <div className="tv-ticker" data-critical={anyCritical ? "true" : "false"} role="alert">
          <span className="tv-ticker-tag" aria-hidden="true">
            <span className="tv-ticker-tag-icon">⚠</span>
            {anyCritical ? "ALERTS" : "WARNINGS"}
          </span>
          <div className="tv-ticker-viewport">
            {/* Two copies of the list back-to-back; translating the track by
                exactly one copy width (-50%) yields a seamless infinite crawl.
                Duration scales with item count so scroll speed stays constant. */}
            <div
              className="tv-ticker-track"
              style={{ animationDuration: `${Math.max(18, alertItems.length * 7)}s` }}
            >
              {[...alertGroups, ...alertGroups].map((g, i) => (
                <span key={i} className={`tv-ticker-item ${g.severity}`}>
                  <span className="tv-ticker-dot" aria-hidden="true" />
                  <b>{g.asset}</b>
                  <span className="tv-ticker-sep">—</span>
                  {g.items.map((it, j) => (
                    <span key={it.key} className={`tv-ticker-fault ${it.severity}`}>
                      {j > 0 && <span className="tv-ticker-div" aria-hidden="true">&middot;</span>}
                      {it.label}
                      {it.detail && <span className="tv-ticker-detail font-mono-data">{it.detail}</span>}
                    </span>
                  ))}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {!loaded && !error && <CenterMsg>Connecting to fleet…</CenterMsg>}
      {loaded && ordered.length === 0 && <CenterMsg>No assets to display.</CenterMsg>}

      {ordered.length > 0 && (
        <div
          className="tv-grid"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rowCount}, minmax(0, 1fr))`,
          }}
        >
          {/* Critical units: first cells, static (stable keys → never re-mount). */}
          {pinned.map((a) => (
            <TvCard key={a.id} asset={a} forecast={forecasts[a.id] ?? null} />
          ))}
          {/* Remaining cells: the current rotation page (keyed by page so they
              animate in when the page turns). */}
          {rotWindow.map((a) => (
            <TvCard key={`rot-${safePage}-${a.id}`} asset={a} forecast={forecasts[a.id] ?? null} enterAnim={enterAnim} />
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="tv-dots" aria-hidden="true">
          {Array.from({ length: pageCount }).map((_, i) => (
            <span key={i} className={`tv-dot${i === safePage ? " on" : ""}`} />
          ))}
        </div>
      )}

      {showHandoff && (
        <HandoffOverlay summary={summary} dateStr={dateStr} clockStr={clockStr} />
      )}
    </div>
  );
}

type ShiftSummary = {
  critical: string[];
  warning: string[];
  offline: string[];
  noData: number;
  nominal: number;
  lowestHelium: { name: string; pct: number } | null;
  soonestRefill: { name: string; days: number } | null;
};

// A point-in-time digest of the whole fleet for the shift-handoff overlay,
// derived from current state + forecasts (no persisted event history yet — that
// arrives with the alert_events/incidents work).
function buildShiftSummary(
  assets: FleetAsset[],
  forecasts: Record<string, HeliumForecast | null>
): ShiftSummary {
  const critical: string[] = [];
  const warning: string[] = [];
  const offline: string[] = [];
  let noData = 0;
  let nominal = 0;
  let lowestHelium: { name: string; pct: number } | null = null;

  for (const a of assets) {
    const alarm = computeAssetAlarm(a);
    // Offline units go to the Offline row only (they're critical-level too, but
    // listing them twice muddies the handoff). Everything else buckets by level.
    if (alarm.connectivity === "offline") offline.push(a.name);
    else if (alarm.level === "critical") critical.push(a.name);
    else if (alarm.level === "warning") warning.push(a.name);
    else if (alarm.level === "ok") nominal++;
    else if (alarm.level === "unknown") noData++;

    const he = numVal(a.latest?.he_lvl);
    if (he !== null && (lowestHelium === null || he < lowestHelium.pct)) {
      lowestHelium = { name: a.name, pct: he };
    }
  }

  let soonestRefill: { name: string; days: number } | null = null;
  for (const a of assets) {
    const f = forecasts[a.id];
    if (f && f.trend === "falling" && f.daysToRefill !== null) {
      if (soonestRefill === null || f.daysToRefill < soonestRefill.days) {
        soonestRefill = { name: a.name, days: f.daysToRefill };
      }
    }
  }

  return { critical, warning, offline, noData, nominal, lowestHelium, soonestRefill };
}

function HandoffOverlay({
  summary,
  dateStr,
  clockStr,
}: {
  summary: ShiftSummary;
  dateStr: string;
  clockStr: string;
}) {
  const allClear =
    summary.critical.length === 0 && summary.warning.length === 0 && summary.offline.length === 0;

  return (
    <div className="tv-handoff" role="status" aria-live="polite">
      <div className="tv-handoff-card">
        <div className="tv-handoff-head">
          <span>Shift Summary</span>
          <span className="font-mono-data tv-handoff-when">
            {dateStr} · {clockStr}
          </span>
        </div>

        {allClear ? (
          <p className="tv-handoff-allclear" style={{ color: ALARM_COLORS.ok }}>
            All systems nominal
          </p>
        ) : (
          <div className="tv-handoff-rows">
            {summary.critical.length > 0 && (
              <HandoffRow color={ALARM_COLORS.critical} label="Alarms" items={summary.critical} />
            )}
            {summary.offline.length > 0 && (
              <HandoffRow color={ALARM_COLORS.critical} label="Offline" items={summary.offline} />
            )}
            {summary.warning.length > 0 && (
              <HandoffRow color={ALARM_COLORS.warning} label="Warnings" items={summary.warning} />
            )}
          </div>
        )}

        <div className="tv-handoff-stats">
          <HandoffStat value={String(summary.nominal)} label="Nominal" color={ALARM_COLORS.ok} />
          {summary.lowestHelium && (
            <HandoffStat
              value={`${summary.lowestHelium.pct.toFixed(0)}%`}
              label={`Lowest He · ${summary.lowestHelium.name}`}
              color="#5b93f7"
            />
          )}
          {summary.soonestRefill && (
            <HandoffStat
              value={soonestRefillLabel(summary.soonestRefill.days)}
              label={`Next refill · ${summary.soonestRefill.name}`}
              color="#38bdf8"
            />
          )}
          {summary.noData > 0 && (
            <HandoffStat value={String(summary.noData)} label="No data" color={ALARM_COLORS.unknown} />
          )}
        </div>
      </div>
    </div>
  );
}

function soonestRefillLabel(days: number): string {
  if (days < 1) return "now";
  if (days < 14) return `${Math.round(days)}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 30)}mo`;
}

function HandoffRow({ color, label, items }: { color: string; label: string; items: string[] }) {
  return (
    <div className="tv-handoff-row">
      <span className="tv-handoff-row-label" style={{ color }}>
        <span className="tv-handoff-dot" style={{ background: color }} />
        {label} <b>{items.length}</b>
      </span>
      <span className="tv-handoff-names">{items.join(" · ")}</span>
    </div>
  );
}

function HandoffStat({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <div className="tv-handoff-stat">
      <span className="tv-handoff-stat-n font-mono-data" style={{ color }}>
        {value}
      </span>
      <span className="tv-handoff-stat-label">{label}</span>
    </div>
  );
}

function TvCard({
  asset,
  forecast,
  enterAnim,
}: {
  asset: FleetAsset;
  forecast: HeliumForecast | null;
  enterAnim?: string;
}) {
  const alarm = computeAssetAlarm(asset);
  const color = ALARM_COLORS[alarm.level];
  const mins = minutesSince(asset.last_sample_at);
  const cold = readColdheadK(asset);
  const showMagmon = usesMagmon(asset.modality);
  // Graded cryogenic state. Two jobs on this screen, and only two:
  //
  //   1. It replaces "All readings nominal" when it is not. The value-fault
  //      thresholds behind the pills are coarse, so a coldhead drifting to 9 K
  //      on a magnet with healthy helium clears them all and the wall says
  //      everything is fine — which is the exact shape of what went unnoticed
  //      on NM1004 for a fortnight.
  //   2. It leads the fault list when it reads critical and the pills do not,
  //      so the worst reading of the unit is always the first line on the card.
  //
  // Otherwise it stays out of the way: the wall has room for three lines and
  // repeating a pill in different words would spend one of them.
  const cryo = showMagmon ? cryoState(asset.latest) : null;
  const cryoLead = cryo && cryo.level === "critical" && alarm.level !== "critical" ? cryo : null;
  const cryoInsteadOfClear = cryo && cryo.level !== "nominal" && cryo.level !== "unknown";
  // A refill projection needs helium, which a unit with no magnet has none of.
  const refillLabel = showMagmon ? refillChipLabel(forecast) : null;
  const refillColor = forecast && refillUrgency(forecast) === "soon" ? ALARM_COLORS.warning : "#38bdf8";
  // "none" (and pinned cards, which pass no enterAnim) get no entrance animation.
  const animClass = enterAnim && enterAnim !== "none" ? ` tv-enter-${enterAnim}` : "";

  return (
    <div
      className={`tv-card${animClass}`}
      data-level={alarm.level}
      style={{ ["--lc" as string]: color }}
    >
      <div className="tv-card-top">
        <div className="tv-card-id">
          <p className="tv-card-name">{asset.name}</p>
          <p className="tv-card-site">{asset.site_name?.trim() || "—"}</p>
        </div>
        <span className="tv-level" style={{ color }}>
          <span className="tv-level-dot" style={{ background: color }} />
          {ALARM_LABELS[alarm.level]}
        </span>
      </div>

      {alarm.faults.length > 0 || cryoLead ? (
        <div className="tv-faults">
          {cryoLead && (
            <span className="tv-fault critical">
              {CRYO_SHORT_LABELS.critical} <b>{cryoLead.headline ?? ""}</b>
            </span>
          )}
          {alarm.faults.slice(0, cryoLead ? 2 : 3).map((f) => (
            <span key={f.key} className={`tv-fault ${f.severity}`}>
              {f.label} <b>{f.detail}</b>
            </span>
          ))}
        </div>
      ) : alarm.level === "maintenance" ? (
        <div className="tv-faults">
          <span className="tv-fault maint">In service — alarms muted</span>
        </div>
      ) : alarm.connectivity === "offline" ? (
        <div className="tv-faults">
          <span className="tv-fault critical">
            Offline — no report {mins !== null && <b>{mins} min</b>}
          </span>
        </div>
      ) : alarm.connectivity === "stale" ? (
        <div className="tv-faults">
          <span className="tv-fault warning">
            Awaiting data {mins !== null && <b>{mins} min</b>}
          </span>
        </div>
      ) : alarm.connectivity === "unknown" ? (
        <div className="tv-faults">
          <span className="tv-fault maint">No data reported yet</span>
        </div>
      ) : cryoInsteadOfClear && cryo ? (
        // Not clear, whatever the pills think.
        <div className="tv-faults">
          <span className={`tv-fault ${cryo.level === "critical" ? "critical" : "warning"}`}>
            {CRYO_SHORT_LABELS[cryo.level]} <b>{cryo.headline ?? ""}</b>
          </span>
        </div>
      ) : (
        <div className="tv-faults tv-faults-clear">All readings nominal</div>
      )}

      {refillLabel && (
        <div className="tv-refill" style={{ ["--rc" as string]: refillColor }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3.5c3.5 4 6 6.9 6 10.1a6 6 0 0 1-12 0c0-3.2 2.5-6.1 6-10.1Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          </svg>
          {refillLabel}
        </div>
      )}

      <TvMetrics asset={asset} showMagmon={showMagmon} cold={cold} />

      <div className="tv-card-foot">
        <span>{asset.maintenance ? "maintenance" : alarm.connectivity}</span>
        <span className="font-mono-data">{mins === null ? "no report" : `${mins} min ago`}</span>
      </div>
    </div>
  );
}

/**
 * The four tiles at the foot of a TV card.
 *
 * The grid is a fixed four columns, so this picks four from whatever the asset
 * reports rather than rendering everything: magnet channels first, then a tile
 * per zone, then power. A magnet keeps exactly the four it has always shown; a
 * trailer with three zones plus power fills the row precisely.
 *
 * Capping is safe because these tiles are NOT how a problem reaches the screen.
 * Anything actually wrong — an over-temperature zone, a lost mains supply —
 * arrives as a fault pill above and colours the whole card, whether or not its
 * tile made the cut. The tiles are context; the pills are the alarm.
 */
function TvMetrics({
  asset,
  showMagmon,
  cold,
}: {
  asset: FleetAsset;
  showMagmon: boolean;
  cold: number | null;
}) {
  const t = asset.latest as unknown as Record<string, unknown> | null;
  const rows = [asset.latest, ...asset.history];
  const zones = zonesToShow(asset.modality, rows);

  const tiles = [
    ...(showMagmon
      ? [
          <Metric key="cold" label="Coldhead" value={cold} unit="K" digits={1}
            series={asset.history.map((h) => coldheadFromData(h.data))} color="#38bdf8" emphasize />,
          <Metric key="he" label="Helium" value={numVal(asset.latest?.he_lvl)} unit="%" digits={1}
            series={asset.history.map((h) => numVal(h.he_lvl))} color="#5b93f7" />,
          <Metric key="press" label="He Press" value={numVal(asset.latest?.he_press)} unit="psi" digits={2}
            series={asset.history.map((h) => numVal(h.he_press))} color="#4ade80" />,
          <Metric key="shield" label="Shield" value={numVal(asset.latest?.shield)} unit="K" digits={0}
            series={asset.history.map((h) => numVal(h.shield))} color="#fbbf24" />,
        ]
      : []),
    ...zones.map((z) => (
      <Metric
        key={z.key}
        label={z.short}
        value={envNum(t?.[`${z.key}_temp_f`])}
        unit="°F"
        digits={1}
        series={asset.history.map((h) => envNum((h as unknown as Record<string, unknown>)[`${z.key}_temp_f`]))}
        color="#fbbf24"
      />
    )),
    ...(showsPower(asset.modality, rows) ? [<PowerTile key="power" latest={asset.latest} />] : []),
  ];

  return <div className="tv-metrics">{tiles.slice(0, 4)}</div>;
}

/**
 * Mains power as a word, not a number.
 *
 * Reads across a room, which a voltage does not. Grey "—" is a real state and
 * not a quiet "fine": it means the UPS is not answering, so an outage is
 * precisely what could not be seen.
 */
function PowerTile({ latest }: { latest: FleetAsset["latest"] }) {
  const t = latest as unknown as Record<string, unknown> | null;
  const state = powerState(t?.ups_on_battery);
  const batt = envNum(t?.ups_batt_pct);
  const volts = envNum(t?.ups_input_v);
  // Shared with the fleet table's power column rather than spelled out again
  // here — two copies of "what to call an outage in a narrow space" is exactly
  // the kind of pair that drifts.
  const word = POWER_SHORT[state];
  const sub = [
    batt === null ? null : `${batt.toFixed(0)}%`,
    volts === null ? null : `${volts.toFixed(0)} V`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="tv-metric">
      <p className="tv-metric-label">Power</p>
      <p className="tv-metric-value font-mono-data" style={{ color: POWER_COLORS[state] }}>
        {word}
      </p>
      <div className="tv-metric-spark" style={{ color: "var(--tv-dim)" }}>
        <span className="font-mono-data" style={{ fontSize: "0.7em" }}>{sub || " "}</span>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  unit,
  digits,
  series,
  color,
  emphasize,
}: {
  label: string;
  value: number | null;
  unit: string;
  digits: number;
  series: (number | null)[];
  color: string;
  emphasize?: boolean;
}) {
  return (
    <div className={`tv-metric${emphasize ? " emph" : ""}`}>
      <p className="tv-metric-label">{label}</p>
      <p className="tv-metric-value font-mono-data">
        {value === null ? "—" : value.toFixed(digits)}
        <span className="tv-metric-unit">{unit}</span>
      </p>
      <div className="tv-metric-spark" style={{ color }}>
        <MiniLineChart values={series} color={color} height={20} />
      </div>
    </div>
  );
}

function Tally({ color, n, label }: { color: string; n: number; label: string }) {
  return (
    <div className="tv-tally" data-zero={n === 0 ? "true" : "false"}>
      <span className="tv-tally-n font-mono-data" style={{ color }}>
        {n}
      </span>
      <span className="tv-tally-label">{label}</span>
    </div>
  );
}

function CenterMsg({ children }: { children: React.ReactNode }) {
  return (
    <div className="tv-center" aria-live="polite">
      {children}
    </div>
  );
}

// ---- small pure helpers --------------------------------------------------

// A short WebAudio tone so there's no audio asset to ship. "alert" is an
// attention-getting rising two-note ping repeated once; "arm" is a single soft
// blip confirming the toggle. Gain is enveloped to avoid start/stop clicks.
function playChime(ctx: AudioContext, kind: "alert" | "arm") {
  const t0 = ctx.currentTime;
  const notes: { freq: number; at: number; dur: number; gain: number }[] =
    kind === "alert"
      ? [
          { freq: 784, at: 0.0, dur: 0.18, gain: 0.22 }, // G5
          { freq: 1047, at: 0.16, dur: 0.22, gain: 0.22 }, // C6
          { freq: 784, at: 0.42, dur: 0.18, gain: 0.18 },
          { freq: 1047, at: 0.58, dur: 0.28, gain: 0.18 },
        ]
      : [{ freq: 880, at: 0.0, dur: 0.12, gain: 0.14 }]; // A5 confirmation blip

  for (const n of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = n.freq;
    const start = t0 + n.at;
    const end = start + n.dur;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(n.gain, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

function numVal(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Coldhead temperature isn't a typed column — it lives in the reading's data
// blob under one of a few label variants. Used for both the latest value and
// each history point's sparkline.
function coldheadFromData(data: unknown): number | null {
  const d = data as Record<string, unknown> | null | undefined;
  if (!d) return null;
  return numVal(d.ColdheadRuO) ?? numVal(d.Coldhead) ?? numVal(d.ColdHead);
}

function readColdheadK(asset: FleetAsset): number | null {
  return coldheadFromData(asset.latest?.data);
}

function countLevel(assets: FleetAsset[], level: AlarmLevel): number {
  return assets.filter((a) => computeAssetAlarm(a).level === level).length;
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
