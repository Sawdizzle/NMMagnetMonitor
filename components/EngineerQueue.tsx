"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  acknowledgeAlert,
  unacknowledgeAlert,
  muteAlert,
  unmuteAlert,
  updateAlertNote,
  type Disposition,
} from "@/lib/engineerActions";
import { MUTE_DURATIONS, muteRemaining, type SuppressionRow } from "@/lib/alertTriage";
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
// a picture of the fleet. Muting does not remove it either — a muted row keeps
// its place and gains a badge saying who silenced it and until when.

/** Whole days an alert has been open. Floor, so "open 1 day" means at least one. */
function daysOpen(triggeredAt: string): number {
  return Math.floor((Date.now() - new Date(triggeredAt).getTime()) / 86_400_000);
}

const KIND_LABELS: Record<string, string> = {
  offline: "Offline",
  reporting_stalled: "Reporting stalled",
  never_reported: "Never reported",
  // One of two collectors on a mixed unit has stopped while the other keeps
  // the asset reporting. Names the collector, so it is not read as six dead
  // sensors.
  magmon_silent: "MagMon silent",
  env_silent: "Env silent",
  threshold: "Threshold",
  sensor_fault: "Sensor fault",
  cooling_loss: "Cooling fault",
  trend: "Trend",
  boiloff: "Helium loss",
  flatline: "Flatlined",
  bound: "Out of range",
  // Non-paging by design (see _upsert_finding): recorded and shown here, never
  // emailed or pushed, because it is deliberately weak evidence.
  anomaly: "Unlike the fleet",
};

function kindLabel(kind: string | null): string {
  if (!kind) return "every alert";
  return KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}

// Three calls, and they are not interchangeable. `false_alarm` is kept apart
// from the other two because it is the only signal that a BOUND needs tuning
// rather than a magnet needing a visit.
const DISPOSITION_LABELS: Record<Disposition, string> = {
  accepted: "accepted",
  ignored: "muted",
  false_alarm: "flagged false alarm",
};

function severityRank(a: OpenAlertRow): number {
  // Unacknowledged always outranks acknowledged, whatever the severity: an
  // owned critical is in better shape than an unowned warning nobody has seen.
  const owned = a.acknowledged_at ? 0 : 2;
  return owned + (a.severity === "critical" ? 1 : 0);
}

export default function EngineerQueue({
  alerts,
  mutes,
  error,
  viewer,
  isAdmin,
}: {
  alerts: OpenAlertRow[];
  mutes: SuppressionRow[];
  error: string | null;
  viewer: string;
  isAdmin: boolean;
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
        <Tile n={mutes.length} label="muted" color="var(--text-dim)" />
      </div>

      {alerts.length === 0 && mutes.length === 0 && !error ? (
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
          <Section
            title="Needs someone"
            blurb="Open and unowned — nobody has picked these up."
            rows={open}
            isAdmin={isAdmin}
          />
          <Section
            title="Acknowledged"
            blurb="Still faulted, but someone owns them. They re-notify if they get worse."
            rows={owned}
            isAdmin={isAdmin}
          />
          <MuteSection mutes={mutes} />
        </>
      )}
    </div>
  );
}

function Section({
  title,
  blurb,
  rows,
  isAdmin,
}: {
  title: string;
  blurb: string;
  rows: OpenAlertRow[];
  isAdmin: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-1">
        {title} <span className="alert-count">{rows.length}</span>
      </h2>
      <p className="text-xs text-[var(--text-dim)] mb-3">{blurb}</p>
      <div className="flex flex-col gap-2">
        {rows.map((a) => (
          <AlertCard key={a.id} alert={a} isAdmin={isAdmin} />
        ))}
      </div>
    </section>
  );
}

/**
 * Every mute in force, listed on its own.
 *
 * It has to be its own section rather than a badge on the queue rows, because
 * the dangerous mute is the one whose alert has since RESOLVED: the row is gone
 * from the queue, the mute is still standing, and the next firing of that
 * condition will be silent. This is the only screen that will tell you.
 */
function MuteSection({ mutes }: { mutes: SuppressionRow[] }) {
  if (mutes.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="text-sm uppercase tracking-wide text-[var(--text-muted)] mb-1">
        Muted <span className="alert-count">{mutes.length}</span>
      </h2>
      <p className="text-xs text-[var(--text-dim)] mb-3">
        These conditions still open alerts and still show on the fleet — they just don&rsquo;t email or
        push. Anything that escalates to critical breaks through anyway.
      </p>
      <div className="flex flex-col gap-2">
        {mutes.map((m) => (
          <MuteCard key={m.id} mute={m} />
        ))}
      </div>
    </section>
  );
}

function MuteCard({ mute }: { mute: SuppressionRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  const indefinite = mute.expires_at === null;

  return (
    <div
      className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] px-4 py-3"
      style={{ borderLeft: "3px solid var(--text-dim)" }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {mute.asset_id ? (
              <Link href={`/asset/${mute.asset_id}`} className="font-semibold text-sm hover:underline">
                {mute.assetName}
              </Link>
            ) : (
              <span className="font-semibold text-sm">{mute.assetName}</span>
            )}
            <span className="debrief-kind">{kindLabel(mute.kind)}</span>
            {mute.channel && <span className="debrief-kind">{mute.channel}</span>}
            <span
              className="fault-pill"
              style={{ fontSize: "10px", color: indefinite ? "var(--status-warning)" : undefined }}
            >
              {muteRemaining(mute.expires_at)}
            </span>
          </div>
          <p className="text-sm text-[var(--text-muted)] mt-1 italic">&ldquo;{mute.reason}&rdquo;</p>
          <p className="text-[11px] text-[var(--text-dim)] mt-1">
            muted by {mute.created_by} on {new Date(mute.created_at).toLocaleDateString()}
            {mute.severity_at_mute === "critical" && " · muted at critical, so escalation will not break it"}
          </p>
        </div>
        <button
          className="btn-secondary shrink-0"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await unmuteAlert(mute.id);
              if (!result.ok) return setFailure(result.error);
              setFailure(null);
              router.refresh();
            })
          }
        >
          Un-mute
        </button>
      </div>
      {failure && (
        <p className="text-[11px] mt-2" style={{ color: "var(--status-offline)" }} role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}

type Panel = "none" | "triage" | "mute" | "edit";

function AlertCard({ alert, isAdmin }: { alert: OpenAlertRow; isAdmin: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [panel, setPanel] = useState<Panel>("none");
  const [note, setNote] = useState(alert.ack_note ?? "");
  const [failure, setFailure] = useState<string | null>(null);

  const critical = alert.severity === "critical";
  const muted = alert.suppression_id !== null;
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
      setPanel("none");
      // The server action revalidates /engineer; refresh pulls the new render
      // so the row moves between sections without a manual reload.
      router.refresh();
    });

  const durations = MUTE_DURATIONS.filter((d) => !d.adminOnly || isAdmin);

  return (
    <div
      className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] px-4 py-3"
      style={{ borderLeft: `3px solid ${muted ? "var(--text-dim)" : color}` }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/asset/${alert.asset_id}`} className="font-semibold text-sm hover:underline">
              {alert.assetName}
            </Link>
            <span className="debrief-kind">{kindLabel(alert.kind)}</span>
            {critical && (
              <span className="fault-pill critical" style={{ fontSize: "10px" }}>
                critical
              </span>
            )}
            {muted && (
              <span className="fault-pill" style={{ fontSize: "10px" }} title="Not emailed or pushed">
                muted
              </span>
            )}
          </div>
          <p className="text-sm text-[var(--text-muted)] mt-1">{alert.message}</p>
          <p className="text-[11px] text-[var(--text-dim)] mt-1">
            since {new Date(alert.triggered_at).toLocaleString()}
            {/*
              How long this has gone unanswered, in the plainest terms.
              An alert open for a fortnight looked exactly like one raised this
              morning, which is how a correct helium alarm sat in this queue for
              thirteen days. Days first, because that is the number that should
              make someone uncomfortable.
            */}
            {daysOpen(alert.triggered_at) >= 1 && (
              <>
                {" · "}
                <b style={{ color: daysOpen(alert.triggered_at) >= 3 ? "var(--status-warning)" : undefined }}>
                  open {daysOpen(alert.triggered_at)} day{daysOpen(alert.triggered_at) === 1 ? "" : "s"}
                </b>
              </>
            )}
            {alert.escalation_count > 0 && (
              <>
                {" · "}
                <span title="Re-raised because it stayed open and unacknowledged">
                  re-raised {alert.escalation_count}&times;
                </span>
              </>
            )}
            {alert.acknowledged_at && (
              <>
                {" · "}
                <b>{DISPOSITION_LABELS[alert.disposition ?? "accepted"]}</b>
                {" by "}
                {alert.acknowledged_by}
              </>
            )}
          </p>
          {alert.ack_note && (
            <p className="text-[11px] text-[var(--text-muted)] mt-1 italic">&ldquo;{alert.ack_note}&rdquo;</p>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {alert.acknowledged_at ? (
            <>
              {panel === "none" && (
                <button className="btn-secondary" disabled={pending} onClick={() => setPanel("edit")}>
                  Edit note
                </button>
              )}
              <button
                className="btn-secondary"
                disabled={pending}
                onClick={() => act(() => unacknowledgeAlert(alert.id))}
              >
                Un-acknowledge
              </button>
            </>
          ) : (
            panel === "none" && (
              <button className="btn-secondary" disabled={pending} onClick={() => setPanel("triage")}>
                Triage
              </button>
            )
          )}
        </div>
      </div>

      {panel === "triage" && (
        <div className="mt-3 pt-3 border-t border-[var(--border)]">
          <label className="block text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
            Note (what did you find?)
          </label>
          <input
            className="input mt-1 w-full"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. flow sensor loose at the pump, service booked Thursday"
          />
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            <button
              className="btn-secondary"
              title="Real, and I own it. Still pages if it gets worse."
              disabled={pending}
              onClick={() => act(() => acknowledgeAlert(alert.id, "accepted", note))}
            >
              Accept
            </button>
            <button
              className="btn-secondary"
              title="Real, and we're living with it — stop paging about it for a while"
              disabled={pending}
              onClick={() => setPanel("mute")}
            >
              Mute…
            </button>
            <button
              className="btn-secondary"
              title="The alert itself is wrong — the bound needs tuning"
              disabled={pending}
              onClick={() => act(() => acknowledgeAlert(alert.id, "false_alarm", note))}
            >
              False alarm
            </button>
            <button className="btn-secondary" disabled={pending} onClick={() => setPanel("none")}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {panel === "mute" && (
        <div className="mt-3 pt-3 border-t border-[var(--border)]">
          <label className="block text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
            Why? (required — this is what the next person reads)
          </label>
          <input
            className="input mt-1 w-full"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. compressor on order, ETA Sept 3"
            autoFocus
          />
          <p className="text-[11px] text-[var(--text-dim)] mt-2">
            Stops email and push for <b>{kindLabel(alert.kind)}</b>
            {alert.channel && <> ({alert.channel})</>} on <b>{alert.assetName}</b>. The unit still shows as
            faulted.{" "}
            {/* The escalation escape hatch only exists above the severity being muted, so
                promising it on an already-critical alert would be a lie. */}
            {critical
              ? "This one is already critical, so nothing will break the mute — it runs until it expires or you lift it."
              : "A rise to critical breaks the mute and pages anyway."}
          </p>
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            {durations.map((d) => (
              <button
                key={d.label}
                className="btn-secondary"
                disabled={pending || !note.trim()}
                onClick={() => act(() => muteAlert(alert.id, d.hours, note))}
              >
                {d.label}
              </button>
            ))}
            <button className="btn-secondary" disabled={pending} onClick={() => setPanel("triage")}>
              Back
            </button>
          </div>
        </div>
      )}

      {panel === "edit" && (
        <div className="mt-3 pt-3 border-t border-[var(--border)]">
          <label className="block text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
            Revise the note — {alert.acknowledged_by}&rsquo;s original acknowledgement stands
          </label>
          <input
            className="input mt-1 w-full"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. part arrived, swapping it Friday"
            autoFocus
          />
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            <button
              className="btn-secondary"
              disabled={pending}
              onClick={() => act(() => updateAlertNote(alert.id, note))}
            >
              Save
            </button>
            <button
              className="btn-secondary"
              disabled={pending}
              onClick={() => {
                setNote(alert.ack_note ?? "");
                setPanel("none");
              }}
            >
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
