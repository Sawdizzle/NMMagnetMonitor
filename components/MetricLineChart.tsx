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

export default function MetricLineChart({
  samples,
  metricKey,
  label,
  unit,
  color,
  emptyNote,
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
}) {
  const chartData = samples.map((s) => ({
    time: new Date(s.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    value: s[metricKey] as number | null,
    count: s.sample_count,
  }));

  const hasData = chartData.some((d) => d.value !== null);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-medium" style={{ color }}>
          {label}
        </h3>
        <span className="text-[10px] text-[var(--text-dim)] uppercase tracking-wide">{unit || "—"}</span>
      </div>
      {!hasData ? (
        <div className="h-[140px] flex items-center justify-center px-3 text-center text-[var(--text-dim)] text-xs">
          {emptyNote || "No data in this window"}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={140}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="time" stroke="var(--text-dim)" fontSize={10} tickLine={false} minTickGap={40} />
            <YAxis stroke="var(--text-dim)" fontSize={10} tickLine={false} width={40} domain={["auto", "auto"]} />
            <Tooltip
              contentStyle={{
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 11,
              }}
              labelStyle={{ color: "var(--text-dim)" }}
              formatter={(value, _name, item) => {
                const count = (item?.payload as { count?: number } | undefined)?.count;
                return [
                  `${value ?? "—"}${unit ? ` ${unit}` : ""}${count ? ` (avg of ${count})` : ""}`,
                  label,
                ];
              }}
            />
            <Line
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
