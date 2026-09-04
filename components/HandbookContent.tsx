import Link from "next/link";
import type { HandbookData } from "@/lib/handbook";

/**
 * The operations handbook — the "what is this and what do I do" page.
 *
 * Deliberately NOT a second copy of /docs. The runbook there is procedural:
 * flash this card, run this command, in this order. This is the page you read
 * when you need to UNDERSTAND or EXPLAIN the system — what it watches, what
 * each alert actually means, what a healthy magnet looks like on this fleet.
 *
 * The reference half is written down here because it does not change week to
 * week. The fleet half is passed in from the server on every load, because a
 * handbook whose "right now" section is a snapshot of the day it was written is
 * a handbook nobody trusts twice.
 */

function Section({
  eyebrow,
  title,
  lede,
  children,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-12">
      <p className="eyebrow mb-1">{eyebrow}</p>
      <h2 className="text-xl md:text-2xl font-semibold tracking-tight mb-1">{title}</h2>
      {lede && <p className="text-sm text-[var(--text-muted)] max-w-2xl mb-4">{lede}</p>}
      {children}
    </section>
  );
}

export default function HandbookContent({ data }: { data: HandbookData }) {
  const { counts, rollout, attention } = data;

  return (
    <div id="main-content" className="min-h-screen p-6 md:p-10" role="main">
      <header className="mb-8">
        <p className="eyebrow mb-1.5">Operations</p>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Handbook</h1>
        <p className="text-sm text-[var(--text-muted)] leading-relaxed mt-2 max-w-2xl">
          What the system watches, what every alert means, and what to do about it. The fleet
          sections below are read live each time this page loads — everything else is reference.
          For the step-by-step procedures, see the <Link className="doc-a" href="/docs">runbook</Link>.
        </p>
      </header>

      {/* ---------------- live: the fleet right now ---------------- */}
      <Section
        eyebrow="Right now"
        title="The fleet at this moment"
        lede={`Read ${new Date(data.generatedAt).toLocaleString()}.`}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Stat label="Units" value={String(counts.total)} note={`${counts.env} environmental`} />
          <Stat label="Reporting" value={String(counts.reporting)} note="fresh telemetry" />
          <Stat label="In service" value={String(counts.maintenance)} note="alarms muted" />
          <Stat
            label="Needing attention"
            value={String(attention.length)}
            note={attention.length === 0 ? "nothing open" : "units with open alerts"}
          />
        </div>

        {attention.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">
            No open alerts anywhere on the fleet. That is a real state, not a loading one.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="cheat-table my-1">
              <tbody>
                {attention.map((a) => (
                  <tr key={a.name}>
                    <td className="desc">
                      {a.name}
                      {a.site && (
                        <span className="block text-[10px] text-[var(--text-dim)]">{a.site}</span>
                      )}
                    </td>
                    <td className="cmd">
                      <span
                        className="status-chip"
                        style={{
                          ["--sc" as string]:
                            a.worst === "critical" ? "var(--status-offline)" : "var(--status-warning)",
                        }}
                      >
                        <span className="cd" aria-hidden="true" />
                        {a.open} open
                      </span>{" "}
                      {a.oldestDays >= 1 && (
                        <span className="text-[10px] text-[var(--text-dim)]">
                          oldest {a.oldestDays} day{a.oldestDays === 1 ? "" : "s"}
                        </span>
                      )}
                      <span className="block text-[11px] text-[var(--text-muted)] mt-0.5">
                        {a.headline}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ---------------- live: collector rollout ---------------- */}
      <Section
        eyebrow="Right now"
        title="Collector versions"
        lede={`A unit behind the current build still reports — it just stores one reading per poll instead of every minute the device logged.`}
      >
        <div className="grid md:grid-cols-2 gap-3">
          <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-4">
            <p className="eyebrow mb-1">On {rollout.currentVersion}</p>
            <p className="text-2xl font-semibold">{rollout.current.length}</p>
            <p className="text-[11px] text-[var(--text-dim)] font-mono-data mt-1 leading-relaxed">
              {rollout.current.join(" · ") || "none"}
            </p>
          </div>
          <div
            className="rounded-xl border p-4"
            style={{
              borderColor: rollout.behind.length ? "var(--status-warning)" : "var(--border-soft)",
              background: "var(--card)",
            }}
          >
            <p className="eyebrow mb-1">Behind</p>
            <p className="text-2xl font-semibold">{rollout.behind.length}</p>
            <p className="text-[11px] text-[var(--text-dim)] font-mono-data mt-1 leading-relaxed">
              {rollout.behind.join(" · ") || "none — the whole fleet is current"}
            </p>
          </div>
        </div>
        {rollout.behind.length > 0 && (
          <p className="text-sm text-[var(--text-muted)] mt-3 max-w-2xl">
            To bring one up to date: <b>Admin → the asset → Get install script</b>, then follow{" "}
            <Link className="doc-a" href="/docs#replace-script">replace a collector script</Link>. For a
            host running several, <code className="doc-code">scripts/deploy-collector.sh</code> in the
            repo does them in one pass.
          </p>
        )}
      </Section>

      {/* ---------------- reference ---------------- */}
      <Section
        eyebrow="How it works"
        title="Four steps, device to phone"
        lede="Every reading takes the same path. When something breaks it broke at one of these four points, which is usually the fastest way to narrow it down."
      >
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-3">
          <Stage n="1 · At the magnet" title="The MagMon">
            A controller wired to the magnet&rsquo;s own sensors. Logs a row every minute and serves
            them on a small web page. We only read it — never change it.
          </Stage>
          <Stage n="2 · In the trailer" title="The Raspberry Pi">
            Scrapes the MagMon every five minutes and sends every new minute it finds. Some units
            also run a second collector for bay temperature and the UPS.
          </Stage>
          <Stage n="3 · In the cloud" title="Database &amp; rules">
            Stores the readings, then re-checks the fleet every minute against the alert rules and
            every five against the diagnostics.
          </Stage>
          <Stage n="4 · To you" title="Dashboard, email, push">
            The fleet view, the wall and the engineer queue all read the same data. Anything that
            opens an alert emails and pushes once.
          </Stage>
        </div>
        <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-4 mt-3 max-w-3xl">
          <p className="text-sm leading-relaxed">
            <b>The one thing worth remembering:</b> &ldquo;offline&rdquo; only ever means{" "}
            <i>no fresh readings arrived</i>. It says nothing about the magnet. A dead Pi, a dead
            cell router, a DNS fault and a genuinely dead magnet all produce the same red chip —
            which is why the alerts below work so hard to name <i>which</i> of those it is.
          </p>
        </div>
      </Section>

      <Section
        eyebrow="Runs by itself"
        title="What happens with nobody touching it"
      >
        <div className="overflow-x-auto">
          <table className="cheat-table my-1">
            <tbody>
              <tr>
                <td className="desc">Every minute</td>
                <td className="cmd">
                  Re-checks every unit against the alert rules — helium, pressure, water,
                  compressor, power — opening and closing alerts. Sends the emails and pushes.
                </td>
              </tr>
              <tr>
                <td className="desc">Every 5 minutes</td>
                <td className="cmd">
                  Diagnostics: trends, cooling faults, flatlined sensors, out-of-range readings,
                  fleet outliers. Helium against each unit&rsquo;s own baseline. Tailscale poll.
                </td>
              </tr>
              <tr>
                <td className="desc">Every hour</td>
                <td className="cmd">
                  Re-raises any alert still open, unacknowledged and unmuted after three days, then
                  every seven days after that.
                </td>
              </tr>
              <tr>
                <td className="desc">Nightly</td>
                <td className="cmd">
                  Rolls yesterday into daily summaries (kept 400 days), then deletes raw minute
                  readings older than 7 days.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section
        eyebrow="Reference"
        title="What each alert means, and what to do"
        lede="The middle column is what it actually means; the right is the first thing to check."
      >
        <div className="overflow-x-auto">
          <table className="cheat-table my-1">
            <tbody>
              {ALERTS.map((a) => (
                <tr key={a.kind}>
                  <td className="desc">{a.kind}</td>
                  <td className="cmd">
                    {a.means}
                    <span className="block text-[11px] text-[var(--text-dim)] mt-1">
                      → {a.first}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="text-base font-semibold mt-6 mb-2">
          Three things that change how an alert behaves
        </h3>
        <ul className="doc-ul text-sm max-w-2xl">
          <li>
            <b>Maintenance</b> silences a unit completely and closes its open alerts. For a unit you
            know is down. It hides real faults too — that is the trade.
          </li>
          <li>
            <b>Mute</b> silences one alert, with a reason and an expiry, and it stays visible in the
            queue with a badge. The right tool for &ldquo;known, not today&rdquo;.
          </li>
          <li>
            <b>Acknowledge</b> means you own it. It stops the alert being re-raised for age, so
            acknowledge only what you are actually going to handle.
          </li>
        </ul>
      </Section>

      <Section
        eyebrow="Reading the numbers"
        title="What a healthy magnet looks like here"
        lede="Measured across this fleet, not textbook figures. A unit well outside these is the one to look at."
      >
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <Stat label="Helium" value="55–82 %" note="and barely moving" />
          <Stat label="Coldhead" value="3.9–4.3 K" note="recondenser matches" />
          <Stat label="Vessel pressure" value="~1.0" note="3.0 alarms" />
          <Stat label="Water flow" value="~2 gpm" note="under 0.6 alarms" />
          <Stat label="Compressor" value="CS1 = 0" note="anything else is a fault" />
        </div>
        <p className="text-sm text-[var(--text-muted)] max-w-2xl mb-4">
          <b>Helium barely moves.</b> Over three weeks the healthy magnets here shifted less than
          0.1 % — a working recondenser means essentially no boil-off. That is why a unit losing even
          half a percent a day is serious long before the level looks low, and why helium is judged
          against each unit&rsquo;s own history rather than a fixed line.
        </p>

        <h3 className="text-base font-semibold mt-6 mb-2">The cryogenics badge</h3>
        <p className="text-sm text-[var(--text-muted)] max-w-2xl mb-3">
          On the asset page, the fleet cards and the wall. It grades the current state — it does not
          predict a quench.
        </p>
        <div className="overflow-x-auto">
          <table className="cheat-table my-1">
            <tbody>
              {CRYO_ROWS.map((r) => (
                <tr key={r.label}>
                  <td className="desc">
                    <span className="status-chip" style={{ ["--sc" as string]: r.color }}>
                      <span className="cd" aria-hidden="true" />
                      {r.label}
                    </span>
                  </td>
                  <td className="cmd">{r.means}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-4 mt-3 max-w-3xl">
          <p className="text-sm leading-relaxed">
            <b>The earliest warning available</b> is the coldhead pulling away from the recondenser.
            On a healthy unit both sit within a few tenths of each other. When the coldhead climbs
            and the recondenser stays cold, the cryocooler is losing ground — and that happens while
            the helium level still looks perfectly fine.
          </p>
        </div>
      </Section>

      <Section eyebrow="How to" title="The things you will actually do">
        <h3 className="text-base font-semibold mb-2">Stand up a new unit</h3>
        <ol className="doc-ol text-sm max-w-2xl">
          <li>
            Flash the card — hostname <code className="doc-code">&lt;asset&gt;-pi</code>, username
            matching the Service user you will set in Admin. The asset code must be in the hostname
            or the unit never gets its &ldquo;Pi offline&rdquo; signal.
          </li>
          <li>Join Tailscale and disable key expiry, on the bench. Everything after this is remote.</li>
          <li>
            Create the asset in <b>Admin → Add asset</b>. Nothing to install exists until the asset
            does — the script carries its token.
          </li>
          <li>
            Get install script, copy it up, install, verify. The second cycle should report about
            five samples, not one.
          </li>
        </ol>

        <h3 className="text-base font-semibold mt-6 mb-2">Add sensors or a UPS to an existing magnet</h3>
        <ol className="doc-ol text-sm max-w-2xl">
          <li>
            Wire and address the sensors — <b>1 = Engineering, 2 = Tech/Patient, 3 = Equipment</b>.
            The Modbus address is the only identity a sensor has; label them before mounting.
          </li>
          <li>Set the UPS up in NUT, with the section named exactly <code className="doc-code">ups</code>.</li>
          <li>
            Same asset, same panel — switch <b>Collector</b> to Environmental, poll every minute,
            install alongside. Both collectors running is the healthy state on that unit.
          </li>
        </ol>

        <h3 className="text-base font-semibold mt-6 mb-2">When something looks wrong</h3>
        <ul className="doc-ul text-sm max-w-2xl">
          <li>Read the alert message first — it names the mechanism, not just the channel.</li>
          <li>
            Check the coldhead. It is the most diagnostic number on the unit: about 4 K means the
            cryogenics are working whatever else is wrong.
          </li>
          <li>
            An offline unit whose Pi is reachable is a gateway problem; one that is unreachable is a
            site problem.
          </li>
          <li>
            If every reading looks alarming at once, cross-check the two read paths — if they agree
            to the decimal, the numbers are real.
          </li>
        </ul>
      </Section>

      <footer className="border-t border-[var(--border-soft)] pt-5 text-sm text-[var(--text-muted)] max-w-2xl">
        <p>
          Step-by-step procedures live in the <Link className="doc-a" href="/docs">runbook</Link>.
          Incident write-ups are in <code className="doc-code">docs/incidents/</code> in the repo.
          Every threshold named on this page is set in <b>Admin → Alerts</b> and can be changed
          without touching code.
        </p>
      </footer>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-4">
      <p className="eyebrow mb-1">{label}</p>
      <p className="text-2xl font-semibold font-mono-data">{value}</p>
      {note && <p className="text-[11px] text-[var(--text-dim)] mt-0.5">{note}</p>}
    </div>
  );
}

function Stage({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] p-4">
      <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-dim)]">{n}</p>
      <p className="font-semibold mt-1 mb-1.5">{title}</p>
      <p className="text-[13px] text-[var(--text-muted)] leading-relaxed">{children}</p>
    </div>
  );
}

const ALERTS: { kind: string; means: string; first: string }[] = [
  {
    kind: "Offline",
    means: "No readings arrived and the Pi is not reachable either. The site's connectivity is down.",
    first: "Check the iR305 in InHand, then power at the site.",
  },
  {
    kind: "Reporting stalled",
    means:
      "The Pi IS reachable but no new readings are arriving — the gateway, the device or its clock, not the network.",
    first: "SSH in and read the collector's journal.",
  },
  {
    kind: "Never reported",
    means: "Added more than two hours ago and has never sent anything. Almost always an unfinished install.",
    first: "Finish or redo the collector install.",
  },
  {
    kind: "MagMon silent",
    means:
      "A unit with two collectors: the environmental half is reporting, the MagMon half is not. It looks online because half of it is.",
    first: "Restart that one service — the other is fine.",
  },
  {
    kind: "Env silent",
    means: "The reverse: sensors or UPS stopped while the magnet keeps reporting.",
    first: "Check the RS-485 adapter and upsc ups.",
  },
  {
    kind: "Helium loss",
    means:
      "Helium falling far faster than this unit's own normal. Healthy magnets here barely move, so any real slope matters.",
    first: "Read the alert — it names venting versus boil-off.",
  },
  {
    kind: "Cooling fault",
    means: "Low water flow and hot water together — one story told twice. A warming coldhead alongside makes it serious.",
    first: "Chiller and water loop at the site.",
  },
  {
    kind: "Out of range",
    means: "A reading past a fixed limit, most often the coldhead above 6 K where about 4 K is normal.",
    first: "Compare the coldhead against the recondenser.",
  },
  {
    kind: "Trending",
    means: "A channel moving steadily toward its limit, with a date attached.",
    first: "Not urgent — schedule against the date.",
  },
  {
    kind: "Flatlined",
    means:
      "A channel has read the EXACT same value for two days. Live sensors jitter; this one has stopped measuring.",
    first: "Treat as a dead sensor or cable, not a reading.",
  },
  {
    kind: "Sensor blind",
    means: "A channel blank for an hour while the unit reports everything else.",
    first: "Sensor or its cable. Common on water sensors.",
  },
  {
    kind: "Threshold",
    means: "A plain limit you set was crossed — helium under 50 %, pressure over 3, compressor not running.",
    first: "Read the number in the message.",
  },
  {
    kind: "Power outage",
    means: "A unit with a UPS is running on battery. Raised the moment it reports.",
    first: "Site power. The Pi keeps reporting on battery.",
  },
  {
    kind: "Unlike the fleet",
    means: "This unit's device error codes differ from everyone else's. Deliberately weak evidence — it never emails.",
    first: "Context only. Read it alongside the rest.",
  },
];

const CRYO_ROWS: { label: string; color: string; means: string }[] = [
  {
    label: "Nominal",
    color: "#4ade80",
    means: "Everything in band. On fleet cards this shows as no badge at all, so silence is good news.",
  },
  {
    label: "Watch",
    color: "#fbbf24",
    means: "Helium under 60 %, pressure drifting up, or the coldhead above 5 K. Worth knowing, not worth a call.",
  },
  {
    label: "Urgent",
    color: "#fb923c",
    means:
      "Helium under 50 %, pressure over 3, coldhead over 6 K, or the coldhead pulling away from the recondenser.",
  },
  {
    label: "Critical",
    color: "#f0575a",
    means: "Helium under 20 %, coldhead over 8 K, pressure over 5 — or the whole magnet at room temperature.",
  },
  {
    label: "No data",
    color: "#6b7280",
    means:
      "No cryogenic reading at all. Deliberately grey, never green: a magnet nobody can see must not look healthy.",
  },
];
