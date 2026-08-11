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
//   ?perView=2   cards per page (default: auto-fit to screen width)

import { useEffect, useMemo, useState } from "react";
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

const POLL_MS = 30_000;
const HISTORY_HOURS = 1;
const DEFAULT_DWELL_S = 15;

export default function TvWall() {
  const { demo, brand } = useDemo();
  const params = useSearchParams();

  const dwellMs = clampInt(params.get("dwell"), 5, 120, DEFAULT_DWELL_S) * 1000;
  const perViewOverride = params.get("perView") ? clampInt(params.get("perView"), 1, 6, 3) : null;

  const [assets, setAssets] = useState<FleetAsset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
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
      setLastRefreshed(new Date());
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

  // ---- responsive cards-per-page -----------------------------------------
  const [vw, setVw] = useState(1280);
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const autoPerView = vw < 900 ? 1 : vw < 1400 ? 2 : 3;
  const perView = Math.max(1, Math.min(perViewOverride ?? autoPerView, Math.max(1, assets.length)));

  // ---- ordering + paging (recomputed as `now` ticks so status stays live) -
  const ordered = useMemo(() => sortByAlarmPriority(assets), [assets, now]);
  const pages = useMemo(() => chunk(ordered, perView), [ordered, perView]);
  const pageCount = Math.max(1, pages.length);

  const criticalUnits = useMemo(
    () => ordered.filter((a) => computeAssetAlarm(a).level === "critical"),
    [ordered, now]
  );
  const anyCritical = criticalUnits.length > 0;

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

  const clockStr = now ? new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  return (
    <div className="tv-root" data-alert={anyCritical ? "true" : "false"} role="main">
      {anyCritical && <div className="tv-edge" aria-hidden="true" />}

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
          <Tally color={ALARM_COLORS.maintenance} n={countLevel(ordered, "maintenance")} label="Maint." />
        </div>

        <div className="tv-clock">
          <span className="tv-live" aria-hidden="true">
            <span className="tv-live-dot" style={{ background: error ? ALARM_COLORS.warning : ALARM_COLORS.ok }} />
            {error ? "reconnecting" : "live"}
          </span>
          <span className="tv-time font-mono-data">{clockStr}</span>
        </div>
      </header>

      {anyCritical && (
        <div className="tv-banner" role="alert">
          <span className="tv-banner-icon" aria-hidden="true">⚠</span>
          <span className="tv-banner-text">
            {criticalUnits.length === 1 ? "Alarm" : `${criticalUnits.length} alarms`} ·{" "}
            {criticalUnits.map((a) => a.name).join(" · ")}
          </span>
        </div>
      )}

      {!loaded && !error && <CenterMsg>Connecting to fleet…</CenterMsg>}
      {loaded && ordered.length === 0 && <CenterMsg>No assets to display.</CenterMsg>}

      {ordered.length > 0 && (
        <div className="tv-viewport">
          <div
            className="tv-track"
            style={{
              width: `${pageCount * 100}%`,
              // translateX % is relative to the track's own width (pageCount ×
              // viewport), so divide by pageCount to advance exactly one page.
              transform: `translateX(-${(page * 100) / pageCount}%)`,
            }}
          >
            {pages.map((pageAssets, i) => (
              <div
                key={i}
                className="tv-page"
                style={{ width: `${100 / pageCount}%`, gridTemplateColumns: `repeat(${perView}, minmax(0, 1fr))` }}
              >
                {pageAssets.map((a) => (
                  <TvCard key={a.id} asset={a} />
                ))}
              </div>
            ))}
          </div>
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

function TvCard({ asset }: { asset: FleetAsset }) {
  const alarm = computeAssetAlarm(asset);
  const color = ALARM_COLORS[alarm.level];
  const mins = minutesSince(asset.last_seen_at);
  const t = asset.latest;
  const cold = readColdheadK(asset);

  return (
    <div className="tv-card" data-level={alarm.level} style={{ ["--lc" as string]: color }}>
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
      ) : (
        <div className="tv-faults tv-faults-clear">All readings nominal</div>
      )}

      <div className="tv-metrics">
        <Metric label="Coldhead" value={cold} unit="K" digits={1} emphasize />
        <Metric label="Helium" value={numVal(t?.he_lvl)} unit="%" digits={1} />
        <Metric label="He Press" value={numVal(t?.he_press)} unit="psi" digits={2} />
        <Metric label="Shield" value={numVal(t?.shield)} unit="K" digits={0} />
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
  emphasize,
}: {
  label: string;
  value: number | null;
  unit: string;
  digits: number;
  emphasize?: boolean;
}) {
  return (
    <div className={`tv-metric${emphasize ? " emph" : ""}`}>
      <p className="tv-metric-label">{label}</p>
      <p className="tv-metric-value font-mono-data">
        {value === null ? "—" : value.toFixed(digits)}
        <span className="tv-metric-unit">{unit}</span>
      </p>
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

function readColdheadK(asset: FleetAsset): number | null {
  const d = asset.latest?.data as Record<string, unknown> | null | undefined;
  if (!d) return null;
  return numVal(d.ColdheadRuO) ?? numVal(d.Coldhead) ?? numVal(d.ColdHead);
}

function countLevel(assets: FleetAsset[], level: AlarmLevel): number {
  return assets.filter((a) => computeAssetAlarm(a).level === level).length;
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
