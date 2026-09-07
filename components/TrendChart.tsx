"use client";

import { useEffect, useRef, useState } from "react";

import { axisLabel, monotonePath, niceScale } from "@/lib/chartScale";
import type { TelemetryBucket } from "@/lib/supabase";

// The 24-hour trend charts on the asset page, drawn directly rather than
// through a charting library.
//
// This replaces Recharts, which was 107 kB gzipped — the largest single chunk
// in the application — to draw six identical 140-pixel line charts with no
// zoom, no brush, no legend, no animation and at most two series. The page it
// sits on is the one a technician opens on a phone in a scanner room, so the
// weight was being paid exactly where it hurts most.
//
// What is deliberately kept from the Recharts version, because a chart that
// changes shape during a bundle-size change is not reviewable:
//
//   monotone cubic interpolation   same curve, via Fritsch–Carlson (below)
//   two independent y scales       outside air keeps its own right-hand axis
//   "nice" rounded axis domains    Recharts' domain={["auto","auto"]}
//   nulls bridged, not broken      connectNulls
//   hover tooltip with the bucket's sample count
//
// What is NOT kept: the animation (it was already disabled) and the SVG-based
// tooltip (an absolutely-positioned div is lighter and easier to style).

const AMBIENT_COLOR = "var(--text-dim)";

const PAD_TOP = 6;
const PAD_BOTTOM = 18; // room for the time labels
const PAD_LEFT = 38; // room for the value labels
const PAD_RIGHT_BARE = 8;
const PAD_RIGHT_AMBIENT = 34; // room for the second scale
const HEIGHT = 140;

/** One plotted bucket, after the metric has been picked out of the row. */
type TrendPoint = {
  t: string;
  v: number | null;
  /** Raw readings averaged into this bucket, shown in the tooltip. */
  n?: number;
  ambient?: number | null;
};

// Width to draw at before the element has been measured. The chart is drawn at
// this and corrected on the first observation rather than being withheld until
// measurement succeeds — see useMeasuredWidth.
const FALLBACK_WIDTH = 340;

/**
 * The element's own width, so the chart can be drawn at real pixel sizes.
 *
 * A viewBox that stretches would be simpler, but `preserveAspectRatio="none"`
 * scales the stroke widths and the text with it — a 2px line becomes 3.4px on a
 * wide card and the axis labels smear. Measuring costs one extra render and
 * keeps every stroke and glyph crisp, which is what ResponsiveContainer was
 * doing anyway.
 *
 * Returns 0 when it has not measured yet, and the caller draws at a fallback
 * rather than drawing nothing. That distinction is the whole point: a browser
 * DEFERS ResizeObserver callbacks while the document is hidden, so a chart that
 * mounts in a background tab measures 0 and — if rendering were gated on the
 * measurement — could still be blank when the tab is brought forward. Observed
 * directly: a container going 0 → 326px produced no redraw while hidden.
 * Opening a few assets in background tabs is an ordinary thing to do, and a
 * blank trend chart on this page reads as a dead channel.
 */
function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Seeded synchronously as well as observed: without this the first paint is
    // an empty box until the observer fires, which reads as a broken chart.
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      // Integer widths only. Sub-pixel churn from a flex parent would otherwise
      // re-render every chart on the page continuously.
      setWidth((prev) => (Math.abs(prev - w) < 1 ? prev : Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width] as const;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export default function TrendChart({
  samples,
  metricKey,
  label,
  unit,
  color,
  emptyNote,
  ambient,
  ambientStation,
}: {
  /** Oldest-first, one row per 15-minute bucket. */
  samples: TelemetryBucket[];
  metricKey: keyof Omit<TelemetryBucket, "created_at" | "sample_count">;
  label: string;
  unit: string;
  /** Why this chart is empty, when the caller knows — a blind water channel
   *  plots nothing, and "No data in this window" makes that look like a bug. */
  emptyNote?: string | null;
  color: string;
  /** Outside temperature aligned index-for-index with `samples`, drawn as a
   *  second, dimmer trace on its own scale. */
  ambient?: (number | null)[] | null;
  /** Which NWS station the ambient trace came from — named because it is a
   *  different instrument from the one inside the magnet room. */
  ambientStation?: string | null;
}) {
  const [wrapRef, measured] = useMeasuredWidth();
  const width = measured || FALLBACK_WIDTH;
  const [hover, setHover] = useState<number | null>(null);

  // Same shape MetricLineChart built, so this is a drop-in for it: the props
  // and the rendered result are unchanged, only the 107 kB behind them is gone.
  const points: TrendPoint[] = samples.map((s, i) => ({
    t: s.created_at,
    v: s[metricKey] as number | null,
    n: s.sample_count,
    ambient: ambient?.[i] ?? null,
  }));

  const hasData = points.some((p) => p.v !== null);
  const hasAmbient = points.some((p) => p.ambient !== null && p.ambient !== undefined);

  const padRight = hasAmbient ? PAD_RIGHT_AMBIENT : PAD_RIGHT_BARE;
  const plotW = Math.max(0, width - PAD_LEFT - padRight);
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;

  const vals = points.map((p) => p.v).filter((v): v is number => v !== null);
  const ambVals = points
    .map((p) => p.ambient)
    .filter((v): v is number => v !== null && v !== undefined);

  const main = niceScale(Math.min(...vals), Math.max(...vals));
  const amb = hasAmbient ? niceScale(Math.min(...ambVals), Math.max(...ambVals), 3) : null;

  const xAt = (i: number) => (points.length < 2 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yAt = (v: number, s: { lo: number; hi: number }) =>
    plotH - ((v - s.lo) / (s.hi - s.lo || 1)) * plotH;

  // connectNulls: gaps are bridged rather than breaking the line, so a single
  // dropped reading does not read as an outage.
  const mainPts = points
    .map((p, i) => (p.v === null ? null : { x: xAt(i), y: yAt(p.v, main) }))
    .filter((p): p is { x: number; y: number } => p !== null);
  const ambPts = amb
    ? points
        .map((p, i) =>
          p.ambient === null || p.ambient === undefined
            ? null
            : { x: xAt(i), y: yAt(p.ambient, amb) }
        )
        .filter((p): p is { x: number; y: number } => p !== null)
    : [];

  // At most four time labels, whatever the window: Recharts' minTickGap={40}.
  const xTickIdx: number[] = [];
  if (points.length > 0) {
    const want = Math.max(2, Math.min(4, Math.floor(plotW / 90)));
    for (let i = 0; i < want; i++) {
      xTickIdx.push(Math.round((i / (want - 1)) * (points.length - 1)));
    }
  }

  // A plain function, not useCallback: `points` is rebuilt each render, so the
  // compiler cannot preserve a manual memo over it — and under the React
  // compiler hand-memoizing an event handler earns nothing anyway.
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (points.length === 0 || plotW <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - PAD_LEFT;
    const i = Math.round((x / plotW) * (points.length - 1));
    setHover(i < 0 || i >= points.length ? null : i);
  };

  const hovered = hover !== null ? points[hover] : null;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-medium" style={{ color }}>
          {label}
        </h3>
        <span className="text-[10px] text-[var(--text-dim)] uppercase tracking-wide">{unit || "—"}</span>
      </div>

      {hasAmbient && (
        <p className="text-[10px] text-[var(--text-dim)] -mt-1 mb-1.5 flex items-center gap-1.5">
          <svg width="14" height="6" aria-hidden="true">
            <line x1="0" y1="3" x2="14" y2="3" stroke={AMBIENT_COLOR} strokeWidth="1.5" strokeDasharray="3 2" />
          </svg>
          Outside air, right-hand scale{ambientStation ? ` · NWS ${ambientStation}` : ""}
        </p>
      )}

      {!hasData ? (
        <div className="h-[140px] flex items-center justify-center px-3 text-center text-[var(--text-dim)] text-xs">
          {emptyNote || "No data in this window"}
        </div>
      ) : (
        <div ref={wrapRef} className="relative" style={{ height: HEIGHT }}>
            <svg
              width={width}
              height={HEIGHT}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
              role="img"
              aria-label={`${label} over the last 24 hours, ${vals.length} readings between ${axisLabel(
                Math.min(...vals)
              )} and ${axisLabel(Math.max(...vals))}${unit ? ` ${unit}` : ""}.`}
              style={{ touchAction: "pan-y" }}
            >
              <g transform={`translate(${PAD_LEFT},${PAD_TOP})`}>
                {/* Grid + left scale */}
                {main.ticks.map((t) => {
                  const y = yAt(t, main);
                  if (y < -1 || y > plotH + 1) return null;
                  return (
                    <g key={`m${t}`}>
                      <line
                        x1={0}
                        y1={y}
                        x2={plotW}
                        y2={y}
                        stroke="var(--border)"
                        strokeDasharray="3 3"
                        shapeRendering="crispEdges"
                      />
                      <text x={-6} y={y} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="var(--text-dim)">
                        {axisLabel(t)}
                      </text>
                    </g>
                  );
                })}

                {/* Right scale, when outside air is drawn */}
                {amb &&
                  amb.ticks.map((t) => {
                    const y = yAt(t, amb);
                    if (y < -1 || y > plotH + 1) return null;
                    return (
                      <text
                        key={`a${t}`}
                        x={plotW + 6}
                        y={y}
                        textAnchor="start"
                        dominantBaseline="middle"
                        fontSize={9}
                        fill={AMBIENT_COLOR}
                      >
                        {axisLabel(t)}
                      </text>
                    );
                  })}

                {/* Time labels */}
                {xTickIdx.map((i, k) => (
                  <text
                    key={`x${i}-${k}`}
                    x={xAt(i)}
                    y={plotH + 13}
                    textAnchor={k === 0 ? "start" : k === xTickIdx.length - 1 ? "end" : "middle"}
                    fontSize={10}
                    fill="var(--text-dim)"
                  >
                    {clock(points[i].t)}
                  </text>
                ))}

                {/* Outside air first, so the metric it explains sits on top. */}
                {ambPts.length > 1 && (
                  <path
                    d={monotonePath(ambPts)}
                    fill="none"
                    stroke={AMBIENT_COLOR}
                    strokeWidth={1.5}
                    strokeDasharray="3 2"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )}

                <path
                  d={monotonePath(mainPts)}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />

                {hover !== null && points[hover] && (
                  <g pointerEvents="none">
                    <line x1={xAt(hover)} y1={0} x2={xAt(hover)} y2={plotH} stroke="var(--border)" />
                    {points[hover].v !== null && (
                      <circle cx={xAt(hover)} cy={yAt(points[hover].v as number, main)} r={3} fill={color} />
                    )}
                  </g>
                )}
              </g>
            </svg>

          {hovered && (
            <div
              className="pointer-events-none absolute z-10 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[11px] shadow-lg"
              style={{
                // Flips to the left of the cursor past the midpoint so the
                // tooltip never runs off the edge of a narrow card.
                left: PAD_LEFT + xAt(hover as number) + (xAt(hover as number) > plotW / 2 ? -8 : 8),
                transform: xAt(hover as number) > plotW / 2 ? "translateX(-100%)" : undefined,
                top: 0,
              }}
            >
              <div className="text-[var(--text-dim)]">{clock(hovered.t)}</div>
              <div style={{ color }}>
                {label}: <span className="font-mono-data">{hovered.v ?? "—"}</span>
                {hovered.v !== null && unit ? ` ${unit}` : ""}
                {hovered.n ? (
                  <span className="text-[var(--text-dim)]"> (avg of {hovered.n})</span>
                ) : null}
              </div>
              {hovered.ambient !== null && hovered.ambient !== undefined && (
                <div style={{ color: AMBIENT_COLOR }}>
                  Outside air: <span className="font-mono-data">{hovered.ambient}</span>
                  {unit ? ` ${unit}` : ""}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
