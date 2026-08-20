"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { TelemetryBucket } from "@/lib/supabase";

// Deliberately outside the METRICS palette: the ambient trace is context, not
// another channel of the magnet, and should not read as one.
const AMBIENT_COLOR = "var(--text-dim)";

export default function MetricLineChart({
  samples,
  metricKey,
  label,
  unit,
  color,
  emptyNote,
  ambient,
  ambientStation,
}: {
  samples: TelemetryBucket[]; // oldest-first, one row per 15-minute bucket
  metricKey: keyof Omit<TelemetryBucket, "created_at" | "sample_count">;
  label: string;
  unit: string;
  color: string;
  // Why this chart is empty, when the caller knows. A blind water channel plots
  // nothing because nullify_sentinel() blanked a placeholder reading, and "No
  // data in this window" makes that look like the app dropped it.
  emptyNote?: string | null;
  // Outside temperature aligned index-for-index with `samples`, drawn as a
  // second, dimmer trace. Used by the water-temperature chart so a summer
  // afternoon in the loop can be read against the afternoon that caused it.
  ambient?: (number | null)[] | null;
  // Which NWS station the ambient trace came from — named on the chart because
  // it is a different instrument from the one inside the magnet room.
  ambientStation?: string | null;
}) {
  const chartData = samples.map((s, i) => ({
    time: new Date(s.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    value: s[metricKey] as number | null,
    count: s.sample_count,
    ambient: ambient?.[i] ?? null,
  }));

  const hasData = chartData.some((d) => d.value !== null);
  const hasAmbient = chartData.some((d) => d.ambient !== null);

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
        <ResponsiveContainer width="100%" height={140}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="time" stroke="var(--text-dim)" fontSize={10} tickLine={false} minTickGap={40} />
            <YAxis yAxisId="main" stroke="var(--text-dim)" fontSize={10} tickLine={false} width={40} domain={["auto", "auto"]} />
            {hasAmbient && (
              // Its OWN scale, on the right. Sharing one axis is more literally
              // honest — outside air really is 40 degrees above the water — but
              // it flattens the water trace into a straight line, and the whole
              // reason to draw the two together is to compare their SHAPES. The
              // axis is labelled and the trace stays visually subordinate so the
              // second scale cannot be missed.
              <YAxis
                yAxisId="ambient"
                orientation="right"
                stroke={AMBIENT_COLOR}
                fontSize={9}
                tickLine={false}
                axisLine={false}
                width={32}
                domain={["auto", "auto"]}
              />
            )}
            <Tooltip
              contentStyle={{
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 11,
              }}
              labelStyle={{ color: "var(--text-dim)" }}
              formatter={(value, name, item) => {
                if (name === "ambient") return [`${value ?? "—"}${unit ? ` ${unit}` : ""}`, "Outside air"];
                const count = (item?.payload as { count?: number } | undefined)?.count;
                return [
                  `${value ?? "—"}${unit ? ` ${unit}` : ""}${count ? ` (avg of ${count})` : ""}`,
                  label,
                ];
              }}
            />
            {hasAmbient && (
              // Drawn first so the metric it explains sits on top of it.
              <Line
                yAxisId="ambient"
                type="monotone"
                dataKey="ambient"
                stroke={AMBIENT_COLOR}
                strokeDasharray="3 2"
                dot={false}
                strokeWidth={1.5}
                connectNulls
                isAnimationActive={false}
              />
            )}
            <Line
              yAxisId="main"
              type="monotone"
              dataKey="value"
              stroke={color}
              dot={false}
              strokeWidth={2}
              connectNulls
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
