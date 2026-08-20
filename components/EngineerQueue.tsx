"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { acknowledgeAlert, unacknowledgeAlert, type Disposition } from "@/lib/engineerActions";
import { NO_TELEMETRY_KINDS } from "@/lib/health";
import type { OpenAlertRow } from "@/lib/fleetQueries";

// The engineer's queue.
//
// Ordering is the whole design: unacknowledged before acknowledged, critical
// before warning, oldest before newest inside a tier. A queue sorted by time
// alone buries a three-day-old critical under this morning's noise, and a queue
// that hides acknowledged rows loses the thing an engineer most wants to know —
// who already has it.
//
// Acknowledging does NOT remove the row. The unit is still faulted; the row
// just stops being unowned. That is deliberate: a triage screen where acting on
// something makes it vanish teaches people that the list is a to-do rather than
// a picture of the fleet.

const KIND_LABELS: Record<string, string> = {
  offline: "Offline",
  reporting_stalled: "Reporting stalled",
  never_reported: "Never reported",
  threshold: "Threshold",
  sensor_fault: "Sensor fault",
  cooling_loss: "Cooling fault",
  trend: "Trend",
  flatline: "Flatlined",
  bound: "Out of range",
  // Non-paging by design (see _upsert_finding): recorded and shown here, never
  // emailed or pushed, because it is deliberately weak evidence.
  anomaly: "Unlike the fleet",
};

const DISPOSITIONS: { value: Disposition; label: string; hint: string }[] = [
  { value: "accepted", label: "Accept", hint: "Real, and I own it" },
  { value: "ignored", label: "Ignore", hint: "Real, but we're living with it for now" },
  { value: "false_alarm", label: "False alarm", hint: "The alert itself is wrong — the bound needs tuning" },
];

function severityRank(a: OpenAlertRow): number {
  // Unacknowledged always outranks acknowledged, whatever the severity: an
  // owned critical is in better shape than an unowned warning nobody has seen.
  const owned = a.acknowledged_at ? 0 : 2;
  return owned + (a.severity === "critical" ? 1 : 0);
}

export default function EngineerQueue({
  alerts,
  error,
  viewer,
}: {
  alerts: OpenAlertRow[];
  error: string | null;
  viewer: string;
}) {
  const sorted = [...alerts].sort(
    (a, b) =>
      severityRank(b) - severityRank(a) ||
      new Date(a.triggered_at).getTime() - new Date(b.triggered_at).getTime()
  );
  const open = sorted.filter((a) => !a.acknowledged_at);
  const owned = sorted.filter((a) => a.acknowledged_at);

  return (
    <div id="main-content" className="min-h-screen p-6 md:p-10" role="main">
      <header className="mb-6">
        <p className="eyebrow mb-1.5">Engineering</p>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Alert queue</h1>
            <p className="text-xs text-[var(--text-dim)] mt-1">
              Every open finding in the fleet. Signed in as {viewer}.
            </p>
          </div>
          <Link href="/" className="btn-secondary inline-flex items-center gap-1.5 shrink-0">
            Back to fleet
          </Link>
        </div>
      </header>

      {error && (
        <div className="debrief-error" role="alert">
          {error}
        </div>
      )}

      <div className="debrief-tiles mb-7">
        <Tile n={open.length} label="needs someone" color="var(--status-offline)" />
        <Tile n={owned.length} label="acknowledged" color="var(--status-warning)" />
        <Tile
          n={alerts.filter((a) => a.severity === "critical").length}
          label="critical"
          color="var(--status-offline)"
        />
      </div>

      {alerts.length === 0 && !error ? (
        <div className="debrief-quiet">
          <div>
            <p className="text-sm font-semibold">Nothing open.</p>
            <p className="text-xs text-[var(--text-dim)] mt-0.5">
              No unit in the fleet has an unresolved finding right now.
            </p>
          </div>
        </div>
      ) : (
        <>
          <Section title="Needs someone" blurb="Open and unowned — nobody has picked these up." rows={open} />
          <Section
            title="Acknowledged"
            blurb="Still faulted, but someone owns them. They re-notify if they get worse."
            rows={owned}
          />
        </>
      )}
    </div>
  );
}

function Section({ title, blurb, rows }: { title: string; blurb: string; rows: OpenAlertRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-1">
        {title} <span className="alert-count">{rows.length}</span>
      </h2>
      <p className="text-xs text-[var(--text-dim)] mb-3">{blurb}</p>
      <div className="flex flex-col gap-2">
        {rows.map((a) => (
          <AlertCard key={a.id} alert={a} />
        ))}
      </div>
    </section>
  );
}

function AlertCard({ alert }: { alert: OpenAlertRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const critical = alert.severity === "critical";
  const color = critical || NO_TELEMETRY_KINDS.has(alert.kind)
    ? "var(--status-offline)"
    : "var(--status-warning)";

  const act = (fn: () => Promise<{ ok: boolean; error: string | null }>) =>
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setFailure(result.error);
        return;
      }
      setFailure(null);
      setNote("");
      setShowNote(false);
      // The server action revalidates /engineer; refresh pulls the new render
      // so the row moves between sections without a manual reload.
      router.refresh();
    });

  return (
    <div
      className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] px-4 py-3"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/asset/${alert.asset_id}`} className="font-semibold text-sm hover:underline">
              {alert.assetName}
            </Link>
            <span className="debrief-kind">{KIND_LABELS[alert.kind] ?? alert.kind.replace(/_/g, " ")}</span>
            {critical && (
              <span className="fault-pill critical" style={{ fontSize: "10px" }}>
                critical
              </span>
            )}
          </div>
          <p className="text-sm text-[var(--text-muted)] mt-1">{alert.message}</p>
          <p className="text-[11px] text-[var(--text-dim)] mt-1">
            since {new Date(alert.triggered_at).toLocaleString()}
            {alert.acknowledged_at && (
              <>
                {" · "}
                <b>{alert.disposition === "false_alarm" ? "flagged false alarm" : alert.disposition === "ignored" ? "ignored" : "accepted"}</b>
                {" by "}
                {alert.acknowledged_by}
              </>
            )}
          </p>
          {alert.ack_note && (
            <p className="text-[11px] text-[var(--text-muted)] mt-1 italic">“{alert.ack_note}”</p>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {alert.acknowledged_at ? (
            <button
              className="btn-secondary"
              disabled={pending}
              onClick={() => act(() => unacknowledgeAlert(alert.id))}
            >
              Un-acknowledge
            </button>
          ) : (
            <>
              {!showNote && (
                <button className="btn-secondary" disabled={pending} onClick={() => setShowNote(true)}>
                  Triage
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {showNote && !alert.acknowledged_at && (
        <div className="mt-3 pt-3 border-t border-[var(--border)]">
          <label className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
            Note (optional — what did you find?)
          </label>
          <input
            className="input mt-1"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. flow sensor loose at the pump, service booked Thursday"
          />
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            {DISPOSITIONS.map((d) => (
              <button
                key={d.value}
                className="btn-secondary"
                title={d.hint}
                disabled={pending}
                onClick={() => act(() => acknowledgeAlert(alert.id, d.value, note))}
              >
                {d.label}
              </button>
            ))}
            <button className="btn-secondary" disabled={pending} onClick={() => setShowNote(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {failure && (
        <p className="text-[11px] mt-2" style={{ color: "var(--status-offline)" }} role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}

function Tile({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] px-4 py-3">
      <p className="font-mono-data text-2xl" style={{ color }}>
        {n}
      </p>
      <p className="text-[11px] uppercase tracking-wide text-[var(--text-dim)] mt-0.5">{label}</p>
    </div>
  );
}
