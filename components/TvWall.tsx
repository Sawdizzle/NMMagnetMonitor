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

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getDataSource, type FleetAsset } from "@/lib/dataSource";
import { useDemo } from "@/lib/demoContext";
import { minutesSince } from "@/lib/health";
import {
  computeAssetAlarm,
  sortByAlarmPriority,
  ALARM_COLORS,
  ALARM_LABELS,
  type AlarmLevel,
} from "@/lib/faults";
import BrandMark from "./BrandMark";
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

  // ---- responsive cards-per-page -----------------------------------------
  const [vw, setVw] = useState(1280);
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const autoPerView = vw < 900 ? 1 : vw < 1400 ? 2 : 3;
  const cols = Math.max(1, Math.min(perViewOverride ?? autoPerView, Math.max(1, assets.length)));
  // Rows for the rotation when nothing needs attention; overridable via ?rows=.
  const rowCount = clampInt(params.get("rows"), 1, 3, 2);

  // ---- ordering (recomputed as `now` ticks so status stays live) ---------
  const ordered = useMemo(() => sortByAlarmPriority(assets), [assets, now]);

  // One uniform, edge-to-edge grid of equal cards. Critical (red) units hold the
  // first cells and stay put (never rotate); every remaining cell cycles through
  // everyone else — warning (amber), nominal (green), unknown (grey), maintenance
  // (blue) — a page at a time. Warnings still stay surfaced via the ticker.
  const criticalUnits = useMemo(
    () => ordered.filter((a) => computeAssetAlarm(a).level === "critical"),
    [ordered, now]
  );

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
  const alertItems = useMemo(() => buildAlertItems(ordered), [ordered, now]);
  const anyCritical = alertItems.some((it) => it.severity === "critical");

  // ---- rotation ----------------------------------------------------------
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (pageCount <= 1) {
      setPage(0);
      return;
    }
    const id = setInterval(() => setPage((p) => (p + 1) % pageCount), dwellMs);
    return () => clearInterval(id);
  }, [pageCount, dwellMs]);
  // Clamp if the page count shrank under us (assets dropped off).
  useEffect(() => {
    if (page >= pageCount) setPage(0);
  }, [page, pageCount]);

  const clockDate = now ? new Date(now) : null;
  const dateStr = clockDate
    ? clockDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : "";
  const clockStr = clockDate ? clockDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  const maxStart = Math.max(0, rotating.length - rotCells);
  const rotStart = rotCells > 0 ? Math.min(page * rotCells, maxStart) : 0;
  const rotWindow = rotCells > 0 ? rotating.slice(rotStart, rotStart + rotCells) : [];

  return (
    <div className="tv-root" role="main">
      <header className="tv-header">
        <div className="tv-brand">
          <BrandMark size={30} />
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
              {[...alertItems, ...alertItems].map((it, i) => (
                <span key={i} className={`tv-ticker-item ${it.severity}`}>
                  <span className="tv-ticker-dot" aria-hidden="true" />
                  <b>{it.asset}</b>
                  <span className="tv-ticker-sep">—</span>
                  {it.label}
                  {it.detail && <span className="tv-ticker-detail font-mono-data">{it.detail}</span>}
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
            <TvCard key={a.id} asset={a} />
          ))}
          {/* Remaining cells: the current rotation page (keyed by page so they
              animate in when the page turns). */}
          {rotWindow.map((a) => (
            <TvCard key={`rot-${page}-${a.id}`} asset={a} enterAnim={enterAnim} />
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="tv-dots" aria-hidden="true">
          {Array.from({ length: pageCount }).map((_, i) => (
            <span key={i} className={`tv-dot${i === page ? " on" : ""}`} />
          ))}
        </div>
      )}
    </div>
  );
}

function TvCard({ asset, enterAnim }: { asset: FleetAsset; enterAnim?: string }) {
  const alarm = computeAssetAlarm(asset);
  const color = ALARM_COLORS[alarm.level];
  const mins = minutesSince(asset.last_seen_at);
  const t = asset.latest;
  const cold = readColdheadK(asset);
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

      {alarm.faults.length > 0 ? (
        <div className="tv-faults">
          {alarm.faults.slice(0, 3).map((f) => (
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
      ) : (
        <div className="tv-faults tv-faults-clear">All readings nominal</div>
      )}

      <div className="tv-metrics">
        <Metric
          label="Coldhead"
          value={cold}
          unit="K"
          digits={1}
          series={asset.history.map((h) => coldheadFromData(h.data))}
          color="#38bdf8"
          emphasize
        />
        <Metric
          label="Helium"
          value={numVal(t?.he_lvl)}
          unit="%"
          digits={1}
          series={asset.history.map((h) => numVal(h.he_lvl))}
          color="#5b93f7"
        />
        <Metric
          label="He Press"
          value={numVal(t?.he_press)}
          unit="psi"
          digits={2}
          series={asset.history.map((h) => numVal(h.he_press))}
          color="#4ade80"
        />
        <Metric
          label="Shield"
          value={numVal(t?.shield)}
          unit="K"
          digits={0}
          series={asset.history.map((h) => numVal(h.shield))}
          color="#fbbf24"
        />
      </div>

      <div className="tv-card-foot">
        <span>{asset.maintenance ? "maintenance" : alarm.connectivity}</span>
        <span className="font-mono-data">{mins === null ? "no report" : `${mins} min ago`}</span>
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

type AlertItem = { key: string; asset: string; label: string; detail: string; severity: "critical" | "warning" };

// Flatten every open issue across the fleet into one "ASSET — error" line per
// fault (plus a connectivity line for offline/stale), for the scrolling ticker.
// Only critical/warning units contribute; maintenance/ok/unknown are excluded.
function buildAlertItems(assets: FleetAsset[]): AlertItem[] {
  const items: AlertItem[] = [];
  for (const a of assets) {
    const alarm = computeAssetAlarm(a);
    if (alarm.level !== "critical" && alarm.level !== "warning") continue;

    if (alarm.connectivity === "offline") {
      const m = minutesSince(a.last_seen_at);
      items.push({ key: `${a.id}-offline`, asset: a.name, label: "Offline", detail: m === null ? "" : `${m} min`, severity: "critical" });
    } else if (alarm.connectivity === "stale") {
      const m = minutesSince(a.last_seen_at);
      items.push({ key: `${a.id}-stale`, asset: a.name, label: "No recent data", detail: m === null ? "" : `${m} min`, severity: "warning" });
    }
    for (const f of alarm.faults) {
      items.push({ key: `${a.id}-${f.key}`, asset: a.name, label: f.label, detail: f.detail, severity: f.severity });
    }
  }
  return items;
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
