"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { DocsInfra } from "@/lib/docsInfra";

// The knowledge base body, shared by the live docs (/docs, realInfra) and the
// demo docs (/demo/docs, demoInfra). Every site-specific identifier comes from
// `infra` so there is a single source of truth for structure and prose; only
// the redactable values differ between modes.
//
// Ordered as a runbook, not a reference, and in the order the work actually
// happens: PART 1 takes a Pi from the sealed box to an asset reporting on the
// dashboard, PART 2 adds environmental hardware — either bolted onto a magnet
// or as the whole job on a unit with no MagMon, PART 3 is the per-site network
// work, PART 4 is what you reach for when something looks wrong. The TOC
// mirrors those parts.

const PARTS: { part: string; blurb: string; sections: { id: string; label: string }[] }[] = [
  {
    part: "1 · Stand up a gateway",
    blurb: "Sealed box to reporting",
    sections: [
      { id: "pi-setup", label: "Flash the card + first boot" },
      { id: "tailscale", label: "Join the tailnet" },
      { id: "add-asset", label: "Create the asset in Admin" },
      { id: "get-script", label: "Generate the install script" },
      { id: "scp", label: "Copy the files over (SCP)" },
      { id: "install-collector", label: "Install + verify the collector" },
    ],
  },
  {
    part: "2 · Environmental hardware",
    blurb: "Sensors, UPS",
    sections: [
      { id: "env-overview", label: "What it adds, and to what" },
      { id: "env-wiring", label: "Wire the sensors + UPS" },
      { id: "env-addressing", label: "Address the sensors (S1/S2/S3)" },
      { id: "env-nut", label: "Set up the UPS (NUT)" },
      { id: "env-on-a-magnet", label: "On an MRI (add-on)" },
      { id: "env-standalone", label: "PET/CT and Nuc Med units" },
      { id: "env-alerts", label: "Alert rules for temp and power" },
    ],
  },
  {
    part: "3 · Site + network setup",
    blurb: "Per-site access",
    sections: [
      { id: "site-topology", label: "How the Pi reaches the MagMon" },
      { id: "ir305", label: "iR305 remote access" },
      { id: "tailscale-ssh", label: "SSH over Tailscale" },
      { id: "reach-magmon", label: "Open a unit's MagMon" },
      { id: "replace-script", label: "Replace a collector script" },
      { id: "pi-server", label: "The shared Pi server" },
    ],
  },
  {
    part: "4 · Run + troubleshoot",
    blurb: "Day to day",
    sections: [
      { id: "troubleshooting", label: "Troubleshooting a gateway" },
      { id: "resolution-check", label: "Confirm minute resolution" },
      { id: "commands", label: "Everyday Pi commands" },
    ],
  },
];

const ALL_SECTIONS = PARTS.flatMap((p) => p.sections);

export default function DocsContent({ infra }: { infra: DocsInfra }) {
  const active = useScrollSpy(ALL_SECTIONS.map((s) => s.id));
  const sampleAsset = infra.assets[1] ?? infra.assets[0] ?? "ASSET";

  return (
    <div id="main-content" className="min-h-screen p-6 md:p-10" role="main">
      <header className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="eyebrow mb-1.5">Knowledge base</p>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Documentation</h1>
          </div>
          <button
            onClick={() => window.print()}
            className="btn-secondary print-hide flex items-center gap-2 whitespace-nowrap"
            title="Opens your browser's print dialog — choose “Save as PDF”"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 3v11m0 0l-4-4m4 4l4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Download PDF
          </button>
        </div>
        <p className="text-sm text-[var(--text-muted)] leading-relaxed mt-2 max-w-2xl">
          How the {infra.introOwner} fleet is built and kept running, in the order you actually do it:
          take a Raspberry Pi from the sealed box to an asset reporting on the dashboard, add
          environmental sensors and a UPS if the unit gets them, wire the site up for remote access,
          then keep it healthy. Read it top to bottom the first time; after that, jump to the part you
          need.
        </p>
      </header>

      {/* Mobile: horizontal jump-to chips */}
      <nav className="lg:hidden flex gap-2 overflow-x-auto pb-1 mb-6 print-hide" aria-label="On this page">
        {ALL_SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="doc-chip">
            {s.label}
          </a>
        ))}
      </nav>

      <div className="lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-10">
        {/* Desktop: sticky table of contents, grouped by part */}
        <nav className="doc-toc hidden lg:block" aria-label="On this page">
          {PARTS.map((p) => (
            <div key={p.part} className="mb-4">
              <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-dim)] mb-2 pl-2.5">
                {p.part}
              </p>
              {p.sections.map((s) => (
                <a key={s.id} href={`#${s.id}`} className={active === s.id ? "active" : ""}>
                  {s.label}
                </a>
              ))}
            </div>
          ))}
        </nav>

        <div className="min-w-0 flex flex-col gap-12">
          {/* ================= PART 1 — stand up a gateway ================= */}
          <PartHeading n="Part 1" title="Stand up a gateway">
            A gateway is one Raspberry Pi (or one shared server) running one collector per asset.
            These six steps take it from a sealed box to an asset showing <b>online</b> on the
            dashboard. Do them in order — each one depends on the last, and the two that people
            skip (join the tailnet, create the asset) are the two that force a second trip when
            they are left out.
          </PartHeading>

          {/* ---------------- 1. New Pi setup ---------------- */}
          <Section id="pi-setup" step="Step 1" title="Flash the card and first boot">
            <P>
              Every gateway starts as a headless Raspberry Pi running Raspberry Pi OS Lite (64-bit).
              Flash the card on your laptop with all the settings baked in, so the Pi comes up on the
              network ready to SSH into — no monitor or keyboard needed.
            </P>
            <ol className="doc-ol">
              <li>
                Install <b>Raspberry Pi Imager</b> from{" "}
                <a className="doc-a" href="https://www.raspberrypi.com/software/" target="_blank" rel="noreferrer">
                  raspberrypi.com/software
                </a>{" "}
                and insert the microSD card.
              </li>
              <li>
                Choose device, then <b>Raspberry Pi OS Lite (64-bit)</b> under &ldquo;Raspberry Pi OS
                (other)&rdquo;, then the SD card as storage.
              </li>
              <li>
                Click <b>Next → Edit Settings</b> before writing, and set:
                <ul className="doc-ul mt-1.5">
                  <li>
                    <b>Hostname</b> — <code className="doc-code">&lt;asset&gt;-pi</code>, e.g.{" "}
                    <code className="doc-code">{infra.sampleHostname}</code>. The asset code has to be
                    in there: it is how the app matches this machine to the unit on the tailnet.
                  </li>
                  <li>Enable SSH (password authentication is fine to start)</li>
                  <li>
                    <b>Username + password</b> — the account you&rsquo;ll SSH in as <i>and</i> the one
                    the collector runs as. The fleet uses{" "}
                    <code className="doc-code">{infra.piUser}</code>; whatever you pick has to match
                    the <b>Service user</b> on the asset in step 3.
                  </li>
                  <li>
                    <b>Wi-Fi SSID, password and country</b> — bake these in whenever the Pi will use
                    Wi-Fi for its uplink, including the common case where its one Ethernet port goes
                    straight to the MagMon. See{" "}
                    <a className="doc-a" href="#site-topology">how the Pi reaches the MagMon</a>.
                  </li>
                  <li>Locale / timezone</li>
                </ul>
              </li>
              <li>Write the card, put it in the Pi, and power it on. Give it a minute on first boot.</li>
              <li>Find and connect to it by hostname:</li>
            </ol>
            <CodeBlock code={`ssh <user>@<hostname>.local\n# e.g. ssh ${infra.piUser}@${infra.sampleHostname}.local`} />
            <P>Once you&rsquo;re in, bring it fully up to date and reboot:</P>
            <CodeBlock code={`sudo apt update && sudo apt full-upgrade -y\nsudo reboot`} />
            <P>
              Then the dependencies. These are <b>per machine</b>, not per asset — do them once and
              they cover every collector you install later. The first line is all a MagMon-only
              gateway needs; install the other two now anyway if this unit might ever get sensors or
              a UPS, so you are not doing apt work in a trailer later:
            </P>
            <CodeBlock code={`sudo apt-get install -y python3-requests                    # MagMon collector
sudo apt-get install -y python3-pymodbus nut-server nut-client   # environmental collector
# if python3-pymodbus is not packaged for your release:
#   sudo pip3 install --break-system-packages pymodbus`} />
            <P>
              And the serial groups, needed only if an RS-485 sensor bus is ever plugged in. Harmless
              on a unit without one, and easy to forget on a unit that gets one later:
            </P>
            <CodeBlock code={`sudo usermod -aG dialout,plugdev ${infra.piUser}
# log out and back in for it to take effect`} />
            <Callout variant="note" title="Static-ish addressing">
              For a site Pi, reserve its IP in the router&rsquo;s DHCP by MAC address rather than
              hand-configuring one on the Pi — it survives re-imaging and avoids collisions. Extra
              knobs live under <code className="doc-code">sudo raspi-config</code>.
            </Callout>
          </Section>

          {/* ---------------- Tailscale ---------------- */}
          <Section id="tailscale" step="Step 2" title="Join the tailnet (Tailscale)">
            <P>
              Tailscale puts every Pi on one private mesh network so you can reach it by a stable{" "}
              <code className="doc-code">100.x.y.z</code> address from anywhere, no port forwarding.
              All {infra.deviceScopeLabel} live on the <b>{infra.tailnetAccount}</b> tailnet.
            </P>
            <P>
              Do this <b>before</b> the collector, while the Pi is still on your bench and easy to
              reach. Everything after this step — copying scripts up, reading journals, fixing a bad
              address — is then the same whether the Pi is on your desk or in a trailer three hours
              away, and you never have to plan a second trip to finish an install.
            </P>
            <ol className="doc-ol">
              <li>Install it on the Pi:</li>
            </ol>
            <CodeBlock code={`curl -fsSL https://tailscale.com/install.sh | sh`} />
            <ol className="doc-ol" start={2}>
              <li>Bring it up — this prints a login URL:</li>
            </ol>
            <CodeBlock code={`sudo tailscale up`} />
            <ol className="doc-ol" start={3}>
              <li>
                Open that URL and sign in with the <b>{infra.tailnetAccount}</b> account to join the
                device to that tailnet.
              </li>
              <li>
                Approve the machine in the{" "}
                <a className="doc-a" href="https://login.tailscale.com/admin/machines" target="_blank" rel="noreferrer">
                  Tailscale admin console
                </a>
                . For an always-on gateway, open its menu and <b>disable key expiry</b> so it never
                drops off.
              </li>
              <li>Confirm its tailnet address:</li>
            </ol>
            <CodeBlock code={`tailscale ip -4\ntailscale status`} />
            <Callout variant="note" title="Name it clearly — the dashboard reads these names">
              Set the machine name in the admin console to match the asset (same as the hostname). It
              keeps <code className="doc-code">tailscale status</code> reading like a fleet list rather
              than a wall of IPs, and it is how the app tells &ldquo;the Pi is offline&rdquo; apart
              from &ldquo;the Pi is up but not reporting&rdquo; — a distinction that decides which of
              the two troubleshooting paths below you take.
            </Callout>
          </Section>

          {/* ---------------- 3. Create the asset ---------------- */}
          <Section id="add-asset" step="Step 3" title="Create the asset in Admin">
            <P>
              The asset has to exist in the dashboard before there is a script to install: the
              generator bakes that asset&rsquo;s gateway token, its device address and its service
              user into the file. Skipping ahead here is the usual cause of an install that runs
              cleanly and reports nothing.
            </P>
            <P className="text-[var(--text)] font-medium">
              <b>Admin → + Add asset</b>, then:
            </P>
            <table className="cheat-table my-1">
              <tbody>
                <tr>
                  <td className="desc">Asset name</td>
                  <td className="cmd">
                    The unit code, e.g. {sampleAsset}
                    <span className="block text-[10px] text-[var(--text-dim)]">
                      Goes in the filenames, the service names and the Pi hostname. Match it exactly.
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="desc">Site name + address</td>
                  <td className="cmd">
                    The facility, e.g. a hospital and its street address
                    <span className="block text-[10px] text-[var(--text-dim)]">
                      The address is geocoded for outside weather on the card — a rough address is
                      better than none, and it can be edited later.
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="desc">Modality</td>
                  <td className="cmd">
                    MRI / PET/CT / Nuc Med
                    <span className="block text-[10px] text-[var(--text-dim)]">
                      MRI is the only one with a MagMon to scrape; the device fields appear only for
                      it. Everything else is an environmental unit — see Part 2.
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="desc">Stale threshold</td>
                  <td className="cmd">
                    Comfortably above the poll interval
                    <span className="block text-[10px] text-[var(--text-dim)]">
                      A 5-minute poll wants about 30 minutes, so one missed report is not an alarm.
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="desc">Service user</td>
                  <td className="cmd">
                    The login user on the target machine
                    <span className="block text-[10px] text-[var(--text-dim)]">
                      The one you set when flashing. It becomes <code className="doc-code">User=</code>{" "}
                      in the systemd unit; wrong here fails the service with{" "}
                      <code className="doc-code">217/USER</code>.
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="desc">MagMon address + port</td>
                  <td className="cmd">
                    MRI only — the device&rsquo;s address <i>as the Pi sees it</i>
                    <span className="block text-[10px] text-[var(--text-dim)]">
                      Not how you reach it from the office or over a VPN. See{" "}
                      <a className="doc-a" href="#site-topology">how the Pi reaches the MagMon</a>.
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="desc">MagMon credentials</td>
                  <td className="cmd">
                    Pre-filled with the fleet default
                    <span className="block text-[10px] text-[var(--text-dim)]">
                      Change them only if this site&rsquo;s device was given its own login.
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
            <Callout variant="warn" title="The asset name has to appear in the Pi's hostname">
              The app matches a Tailscale machine to an asset by finding the asset code inside the
              machine&rsquo;s hostname — separator-insensitive, so{" "}
              <code className="doc-code">{sampleAsset.toLowerCase()}-pi</code> and{" "}
              <code className="doc-code">{sampleAsset.toLowerCase()}pi</code> both match, while an
              adjacent digit does not, so a shorter code cannot match a longer one. Get this wrong and everything
              still reports — you simply never get the &ldquo;Pi offline&rdquo; signal that tells a
              dead gateway apart from a dead device.
            </Callout>
            <Callout variant="note" title="Nothing to fill in for the token">
              The gateway token is generated for you and only ever leaves the app inside a downloaded
              script. If one is ever rotated, every deployed copy of that asset&rsquo;s script stops
              reporting until you re-download and redeploy it.
            </Callout>
          </Section>

          {/* ---------------- 4. Generate the install script ---------------- */}
          <Section id="get-script" step="Step 4" title="Generate the install script in Admin">
            <P>
              Nothing is copied by hand. Each asset gets its <b>own</b> generated collector and its
              own systemd unit, carrying that asset&rsquo;s gateway token and its MagMon&rsquo;s
              address — so a script is only ever valid for the one asset it was generated for.
            </P>
            <ol className="doc-ol">
              <li>
                In the web app: <b>Admin → Existing assets →</b> pick the asset <b>→ Get install
                script</b>.
              </li>
              <li>
                Set <b>Service user</b> to the login user on the target machine — the account you
                created in step 1 (<code className="doc-code">pi</code> on a stock image). On the
                shared server it&rsquo;s that box&rsquo;s user instead. Run{" "}
                <code className="doc-code">whoami</code> on the machine if you&rsquo;re unsure; a
                wrong value here fails the service with <code className="doc-code">217/USER</code>.
              </li>
              <li>
                Leave <b>Collector</b> on <b>MagMon</b>. The switch only appears on an MRI asset,
                because that is the only kind of unit that could run either collector — a magnet
                fitted with sensors or a UPS runs <i>both</i>, and you download each pair in turn.
                Part 2 covers that.
              </li>
              <li>
                Set the poll interval if it needs to differ from the default, then click{" "}
                <b>Regenerate</b>. Five minutes is the fleet default and it does <i>not</i> limit
                resolution: each cycle collects every new one-minute row the device has logged since
                the last one, so the stored history is minute-by-minute either way.
              </li>
              <li>
                Click <b>Download script</b> and <b>Download systemd unit</b>. You now have two files
                in <code className="doc-code">~/Downloads</code>:
                <ul className="doc-ul mt-1.5">
                  <li><code className="doc-code">{infra.servicePrefix}-&lt;ASSET&gt;.py</code></li>
                  <li>
                    <code className="doc-code">{infra.servicePrefix}-&lt;ASSET&gt;.service</code> —
                    already carries the right <code className="doc-code">User=</code> and paths, so
                    there is nothing to edit
                  </li>
                </ul>
              </li>
            </ol>
            <P>Repeat for every asset you&rsquo;re deploying — each one is its own pair of files.</P>
            <Callout variant="warn" title="One asset's files never go on another machine">
              The script embeds that asset&rsquo;s unique gateway token and its MagMon&rsquo;s
              IP/credentials. Installing the wrong pair reports one asset&rsquo;s data under another
              name. The asset is in the filename to keep them straight — download fresh per asset
              rather than copying a file you already have. If a token is ever rotated, every deployed
              copy of that script is dead until you re-download it.
            </Callout>
          </Section>

          {/* ---------------- 3. SCP ---------------- */}
          <Section id="scp" step="Step 5" title="Copy the files to the Pi with SCP">
            <P>
              <code className="doc-code">scp</code> copies files over the same SSH connection. It
              runs from your laptop, not from the Pi.
            </P>
            <P className="text-[var(--text)] font-medium">Send the two files from step 4 up:</P>
            <CodeBlock code={`scp ~/Downloads/${infra.servicePrefix}-<ASSET>.py      <user>@<host>:/home/<user>/\nscp ~/Downloads/${infra.servicePrefix}-<ASSET>.service <user>@<host>:/home/<user>/`} />
            <P className="text-[var(--text)] font-medium">Other shapes you&rsquo;ll want:</P>
            <table className="cheat-table my-1">
              <tbody>
                <tr>
                  <td className="desc">A whole folder (recursive)</td>
                  <td className="cmd">scp -r ./scripts &lt;user&gt;@&lt;host&gt;:/home/&lt;user&gt;/</td>
                </tr>
                <tr>
                  <td className="desc">Pull a file back down (e.g. a log)</td>
                  <td className="cmd">scp &lt;user&gt;@&lt;host&gt;:/home/&lt;user&gt;/gateway.log ./</td>
                </tr>
                <tr>
                  <td className="desc">Through a Device Manager tunnel port</td>
                  <td className="cmd">scp -P &lt;tunnel-port&gt; ./file &lt;user&gt;@&lt;tunnel-host&gt;:/home/&lt;user&gt;/</td>
                </tr>
              </tbody>
            </table>
            <Callout variant="warn" title="It's -P, capital, for scp">
              <code className="doc-code">scp</code> uses <code className="doc-code">-P</code> (capital)
              for the port, while <code className="doc-code">ssh</code> uses{" "}
              <code className="doc-code">-p</code> (lowercase). Easy to mix up. Over Tailscale, just
              use the tailnet IP or MagicDNS name as <code className="doc-code">&lt;host&gt;</code> —
              no tunnel needed.
            </Callout>
          </Section>

          {/* ---------------- 4. Install + verify ---------------- */}
          <Section id="install-collector" step="Step 6" title="Install the collector and verify it reports">
            <P>
              Now SSH in — everything below runs <b>on the Pi</b>. The unit file is already correct,
              so this is just: put the script in place, put the unit in place, start it.
            </P>
            <CodeBlock code={`sudo install -o <user> -g "$(id -gn <user>)" -m 700 \\\n  /home/<user>/${infra.servicePrefix}-<ASSET>.py ${infra.scriptBase}-<ASSET>.py\n\nsudo cp /home/<user>/${infra.servicePrefix}-<ASSET>.service \\\n        /etc/systemd/system/${infra.servicePrefix}-<ASSET>.service\n\nsudo systemctl daemon-reload\nsudo systemctl enable --now ${infra.servicePrefix}-<ASSET>`} />
            <P className="text-[var(--text)] font-medium">
              Verify — all four must pass before you call it done:
            </P>
            <CodeBlock code={`systemctl status ${infra.servicePrefix}-<ASSET> --no-pager      # active (running)\njournalctl -u ${infra.servicePrefix}-<ASSET> -n 30 --no-pager   # "reported N sample(s)", no errors\npgrep -af ${infra.processMatch}-<ASSET>                          # ONE python line, and you can see it\nls -l /var/tmp/${infra.servicePrefix}-<ASSET>.hwm                # exists after the SECOND cycle`} />
            <Callout variant="warn" title="Use pgrep -af, not pgrep -c, over SSH">
              Run as <code className="doc-code">ssh host &quot;… pgrep -c -f {infra.processMatch}-&lt;ASSET&gt;&quot;</code>,
              the count comes back <b>one too high</b>: the remote shell&rsquo;s own command line
              contains the text being searched for, so pgrep matches the question. Typed at a prompt
              it is fine, which is why this is easy to miss.{" "}
              <code className="doc-code">-af</code> prints what matched, so a real collector
              (<code className="doc-code">/usr/bin/python3 {infra.scriptBase}-&lt;ASSET&gt;.py</code>)
              is obvious next to a <code className="doc-code">bash -c</code> echoing your own command.
            </Callout>
            <Callout variant="note" title="The first cycle reports 1 sample. The second is the one to read.">
              A fresh start has no high-water mark, so the collector deliberately sends only the
              newest row rather than dumping an hour of history. One poll interval later it should
              report <b>one sample per minute elapsed</b> — five on a five-minute poll — and write the{" "}
              <code className="doc-code">.hwm</code> file. If the second cycle also says{" "}
              <code className="doc-code">reported 1 sample(s)</code> and no{" "}
              <code className="doc-code">.hwm</code> appears, the unit is storing one reading per poll
              instead of every minute:{" "}
              <a className="doc-a" href="#resolution-check">confirm minute resolution</a>.
            </Callout>
            <Callout variant="note" title="'normal fetch failed … trying raw socket fallback' is normal">
              Several MagMons answer with a malformed HTTP status line that Python refuses to parse,
              so the collector retries the same request over a raw socket and carries on. Seeing that
              line once per cycle is expected on those units and is not a fault.
            </Callout>
            <P>
              …and the asset flips to <b>online</b> on the dashboard within a couple of minutes. If
              any check fails, go to <a className="doc-a" href="#troubleshooting">troubleshooting</a>.
              Once it&rsquo;s green you can clean up the copies in the home directory:
            </P>
            <CodeBlock code={`rm -f /home/<user>/${infra.servicePrefix}-<ASSET>.*`} />
            <Callout variant="warn" title="systemd, never cron">
              The collector runs continuously and sleeps between polls on its own. A cron entry would
              launch an <i>additional</i> copy on every tick while the earlier ones keep running —
              which is what the lock file complaints in the journal mean. If{" "}
              <code className="doc-code">pgrep -c</code> prints anything but 1, you have a duplicate.
            </Callout>
            <Callout variant="note" title="Replacing an older single-name install">
              Early builds installed one fixed{" "}
              <code className="doc-code">{infra.servicePrefix}.service</code> at{" "}
              <code className="doc-code">{infra.scriptBase}.py</code> (no asset in the name). Remove
              that <i>before</i> installing the per-asset version or you&rsquo;ll run two collectors
              at once:
              <CodeBlockInline code={`sudo systemctl disable --now ${infra.servicePrefix}\nsudo rm -f /etc/systemd/system/${infra.servicePrefix}.service ${infra.scriptBase}.py\nsudo rm -f /var/lock/${infra.servicePrefix}-*.lock\nsudo systemctl daemon-reload`} />
            </Callout>
          </Section>

          {/* ================= PART 2 — environmental units ================= */}
          <PartHeading n="Part 2" title="Environmental hardware (sensors + UPS)">
            Temperature and humidity sensors on an RS-485 bus, and the UPS feeding the trailer.
            The hardware and the collector are the same wherever they go &mdash; what changes is
            whether they are the whole job or an addition to a magnet. Steps 1 to 3 are shared;
            Step 4 comes in two versions, one for each case. Everything about the Pi itself is
            Part 1, so do that first.
          </PartHeading>

          <Section id="env-overview" title="What it adds, and to what">
            <P>
              This is an <b>additive</b> set of channels, not a different kind of unit. Whichever
              of these are fitted is what the dashboard draws:
            </P>
            <table className="cheat-table my-1">
              <tbody>
                <tr>
                  <td className="desc">Zone temp / humidity</td>
                  <td className="cmd">
                    up to three XY-MD02 sensors on one RS-485 bus
                    <span className="block text-[10px] text-[var(--text-dim)]">
                      One is fine. Two or three is a wiring decision, never a code change &mdash;
                      only the zones that report get drawn.
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="desc">Mains / UPS power</td>
                  <td className="cmd">
                    on-battery state, battery %, input volts, via NUT
                    <span className="block text-[10px] text-[var(--text-dim)]">
                      The fleet-wide outage rule starts paging for this unit the moment it reports.
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="desc">Collector</td>
                  <td className="cmd">{infra.envServicePrefix}-&lt;ASSET&gt;.py</td>
                </tr>
                <tr>
                  <td className="desc">Extra packages</td>
                  <td className="cmd">python3-pymodbus, nut-server, nut-client</td>
                </tr>
              </tbody>
            </table>
            <P className="text-[var(--text)] font-medium">The two cases:</P>
            <table className="cheat-table my-1">
              <tbody>
                <tr>
                  <td className="desc">
                    On an <b>MRI</b>
                    <span className="block text-[10px] text-[var(--text-dim)]">
                      Step 4 &middot; MRI
                    </span>
                  </td>
                  <td className="cmd">
                    An addition. The asset stays modality MRI and keeps its MagMon address; its Pi
                    runs BOTH collectors, reporting one asset. Helium, bay temperature and mains
                    power land in the same row and show on one card.
                  </td>
                </tr>
                <tr>
                  <td className="desc">
                    On a <b>PET/CT</b> or <b>Nuc Med</b> unit
                    <span className="block text-[10px] text-[var(--text-dim)]">
                      Step 4 &middot; PET/CT &middot; Nuc Med
                    </span>
                  </td>
                  <td className="cmd">
                    The whole job. There is no MagMon, so the asset is created with that modality,
                    the device-address fields disappear, and one collector runs on its own.
                  </td>
                </tr>
              </tbody>
            </table>
            <P>
              The collector names differ from the MagMon one on purpose &mdash; separate service,
              path, lock file and log tag &mdash; because on a magnet the two run side by side and
              would otherwise fight over each other&rsquo;s files.
            </P>
            <Callout variant="note" title="A blank channel is never a zero">
              A sensor that fails to answer is reported as <b>no reading</b>, not as 0. That is
              what lets a dead UPS link show up as a fault instead of quietly reading &ldquo;wall
              power is fine&rdquo; forever. If a zone shows an em-dash on the dashboard, the
              sensor is not answering &mdash; it is not a cold room.
            </Callout>
          </Section>

          <Section id="env-wiring" step="Step 1" title="Wire the sensors and the UPS">
            <P>
              The three sensors share one RS-485 pair back to a USB adapter on the Pi. RS-485 is
              a <b>bus</b>: every sensor lands on the same two wires (A to A, B to B), daisy-chained
              from one to the next rather than home-run to the Pi.
            </P>
            <ol className="doc-ol">
              <li>
                Mount one XY-MD02 in each zone: <b>Section 1 Engineering</b>, <b>Section 2 Tech /
                Patient</b>, <b>Section 3 Equipment</b>.
              </li>
              <li>
                Daisy-chain A and B between them and back to the USB&ndash;RS485 adapter. Keep the
                pair away from mains runs; it is a differential pair and will tolerate a lot, but
                not a compressor contactor.
              </li>
              <li>Power the sensors from their supply (they are not bus-powered).</li>
              <li>Plug the adapter into the Pi, and the UPS&rsquo;s USB data cable into the Pi.</li>
              <li>The Pi itself plugs into the UPS &mdash; a gateway that dies with the mains cannot report the outage.</li>
            </ol>
            <P className="text-[var(--text)] font-medium">Confirm the Pi can see both:</P>
            <CodeBlock code={`ls -l /dev/ttyUSB*        # the RS-485 adapter, usually /dev/ttyUSB0\nlsusb                     # the UPS should appear by brand`} />
            <Callout variant="warn" title="The service user needs the serial port groups">
              Without this every zone reads blank and nothing in the log says why &mdash; it is a
              permission error on the serial port, not a sensor fault. Log out and back in (or
              reboot) afterwards for it to take effect:
              <CodeBlockInline code={`sudo usermod -aG dialout,plugdev ${infra.piUser}`} />
              <b>Both</b> groups, because which one owns the device depends on the adapter:{" "}
              <code className="doc-code">ls -l /dev/ttyUSB0</code> shows{" "}
              <code className="doc-code">root dialout</code> on some and{" "}
              <code className="doc-code">root plugdev</code> on others &mdash; both seen in this fleet.
              And a trailing <code className="doc-code">+</code> on those permissions is an ACL that
              logind grants <i>the logged-in user</i> &mdash; so a hand-run scan works over SSH while
              the collector, which has no seat, is refused. Testing by hand proves nothing about the
              service. Check the real thing with{" "}
              <code className="doc-code">getfacl /dev/ttyUSB0</code> and{" "}
              <code className="doc-code">groups</code>.
            </Callout>
          </Section>

          <Section id="env-addressing" step="Step 2" title="Address each sensor: 1 = S1, 2 = S2, 3 = S3">
            <P>
              This is the step that decides which zone is which, and the one worth slowing down
              for. The collector reads Modbus unit <b>1</b> into <b>S1 Engineering</b>, unit{" "}
              <b>2</b> into <b>S2 Tech / Patient</b> and unit <b>3</b> into <b>S3 Equipment</b>.
            </P>
            <Callout variant="warn" title="The address is the only identity a sensor has">
              RS-485 is a multidrop bus, not a chain the Pi can walk. Nothing in the protocol
              reports position, order or location, so <b>no software can work out where a sensor
              is</b>. The mapping is correct only if the sensor you install in a zone is the one
              addressed with that zone&rsquo;s number. Write the address on each sensor with a
              marker before it goes on the wall.
            </Callout>
            <P>
              They all ship as address <b>1</b>, so they must be addressed <b>one at a time</b>{" "}
              &mdash; two unaddressed sensors on the same bus both answer to 1 and you get
              garbage. Connect one, set it, unplug it, move to the next.
            </P>
            <P className="text-[var(--text)] font-medium">
              Set the address with the vendor&rsquo;s Windows tool, or from the Pi:
            </P>
            <CodeBlock code={`# ONE sensor connected. Set NEW to 1, 2 or 3 for the zone it is going into.\npython3 - <<'PY'\nfrom pymodbus.client import ModbusSerialClient\nNEW = 2   # 1 = Engineering, 2 = Tech / Patient, 3 = Equipment\nc = ModbusSerialClient(port="/dev/ttyUSB0", baudrate=9600, bytesize=8,\n                       parity="N", stopbits=1, timeout=2)\nc.connect()\ntry:\n    r = c.write_register(address=0x0101, value=NEW, device_id=1)\nexcept TypeError:                      # older pymodbus spells it slave=\n    r = c.write_register(address=0x0101, value=NEW, slave=1)\nprint("FAILED" if r.isError() else f"sensor is now address {NEW}")\nc.close()\nPY`} />
            <Callout variant="note" title="Check the register against your datasheet">
              0x0101 is the device-address register on the common XY-MD02. Variants exist. If the
              write fails, use the vendor tool rather than guessing at registers &mdash; a wrong
              write can change the baud rate and take the sensor off the bus entirely.
            </Callout>
            <P className="text-[var(--text)] font-medium">
              With all three wired up, confirm the bus &mdash; this is also how you identify a sensor:
            </P>
            <CodeBlock code={`python3 - <<'PY'\nfrom pymodbus.client import ModbusSerialClient\nc = ModbusSerialClient(port="/dev/ttyUSB0", baudrate=9600, bytesize=8,\n                       parity="N", stopbits=1, timeout=0.4)\nprint("port open:", c.connect())\nfound = 0\nfor uid in range(1, 8):\n    try:\n        # pymodbus renamed the keyword: >=3.7 wants device_id=, older wants slave=.\n        try:\n            rr = c.read_input_registers(address=1, count=2, device_id=uid)\n        except TypeError:\n            rr = c.read_input_registers(address=1, count=2, slave=uid)\n    except Exception as e:\n        # An address with no sensor on it RAISES rather than returning an error\n        # result. Catching it is what lets the scan reach address 2.\n        print(f"address {uid}: no answer ({type(e).__name__})")\n        continue\n    if rr and not rr.isError():\n        t, h = rr.registers[0] / 10.0, rr.registers[1] / 10.0\n        print(f"address {uid}: {t * 9 / 5 + 32:.1f} F   {h:.1f} %RH   <-- FOUND")\n        found += 1\nprint(f"{found} sensor(s) on the bus")\nc.close()\nPY`} />
            <P>
              Exactly three lines marked FOUND, at addresses 1, 2 and 3 &mdash; a unit fitted with
              fewer sensors shows correspondingly fewer. <b>Zero</b> found, with the port opening,
              is a bus problem rather than an addressing one: check the sensor has its own 5&ndash;30
              VDC supply (it is not bus-powered), swap A and B (the commonest RS-485 fault, and
              adapter silkscreens disagree with each other), confirm{" "}
              <code className="doc-code">/dev/ttyUSB0</code> really is the RS-485 adapter with{" "}
              <code className="doc-code">lsusb</code>, and re-run at 4800 and 19200 baud before
              concluding a sensor is dead. To prove which is which, warm one
              sensor with your hand for a minute and re-run &mdash; the address that moves is that
              zone. Do this <i>before</i> you close the trailer up.
            </P>
          </Section>

          <Section id="env-nut" step="Step 3" title="Set up the UPS with NUT">
            <P>
              The collector reads the UPS by shelling out to <code className="doc-code">upsc</code>,
              so NUT has to be answering locally before the collector will report anything about
              power.
            </P>
            <CodeBlock code={`sudo apt-get update\nsudo apt-get install -y nut-server nut-client`} />
            <P className="text-[var(--text)] font-medium">
              <code className="doc-code">/etc/nut/ups.conf</code> &mdash; the name in brackets matters:
            </P>
            <CodeBlock code={`[ups]\n    driver = usbhid-ups\n    port = auto\n    desc = "Trailer UPS"`} />
            <Callout variant="warn" title="It must be called ups">
              The generated collector runs <code className="doc-code">upsc ups</code>. If you name
              the section anything else, every power field reports blank and the dashboard shows{" "}
              <b>Power unknown</b> &mdash; which reads as a broken link, not as a naming mistake.
              Either call it <code className="doc-code">ups</code> or change{" "}
              <code className="doc-code">UPS_NAME</code> at the top of the script.
            </Callout>
            <P className="text-[var(--text)] font-medium">The remaining three files:</P>
            <CodeBlock code={`# /etc/nut/nut.conf\nMODE=standalone\n\n# /etc/nut/upsd.users\n[monuser]\n    password = <pick-a-password>\n    upsmon master\n\n# /etc/nut/upsmon.conf  (append)\nMONITOR ups@localhost 1 monuser <pick-a-password> master`} />
            <CodeBlock code={`sudo systemctl restart nut-server nut-monitor\nsudo systemctl enable nut-server nut-monitor\nupsc ups`} />
            <P>
              <code className="doc-code">upsc ups</code> should print a block of values. The three
              the collector uses are <code className="doc-code">ups.status</code> (
              <code className="doc-code">OL</code> on line, <code className="doc-code">OB</code> on
              battery), <code className="doc-code">battery.charge</code> and{" "}
              <code className="doc-code">input.voltage</code>. Pull the UPS&rsquo;s mains plug for a
              few seconds and watch <code className="doc-code">ups.status</code> flip to{" "}
              <code className="doc-code">OB</code> &mdash; that is the whole alarm path proven at
              the source.
            </P>
          </Section>

          <Section id="env-on-a-magnet" step="Step 4 · MRI" title="Install it alongside a MagMon collector">
            <P>
              A UPS or a bay sensor on an <b>MRI</b> unit is an <b>addition</b>, not a different
              kind of unit. The asset stays on modality <b>MRI</b> with its MagMon address intact,
              and its Pi runs <b>both</b> collectors &mdash; two scripts, two services, two lock
              files, one asset.
            </P>
            <P>
              Nothing about the asset changes &mdash; no new asset, no modality edit, no second tile
              on the dashboard.
            </P>
            <ol className="doc-ol">
              <li>
                Wire and address only the sensors actually being fitted (Steps 1&ndash;3 above). One
                sensor gives one tile; the collector polls all three addresses regardless, so a
                second one added later is a wiring job with no redeploy.
              </li>
              <li>
                <b>Admin → the asset → Get install script</b>, then set <b>Collector</b> to{" "}
                <b>Environmental</b>. Set the poll interval to <b>1 minute</b> &mdash; see below for
                why that is free on a magnet &mdash; and download the script and the systemd unit.
              </li>
              <li>
                Install them exactly as in <a className="doc-a" href="#install-collector">Step 6</a>,
                substituting the environmental names. Nothing about either install changes because
                the other one is there:
                <CodeBlockInline code={`sudo install -o <user> -g "$(id -gn <user>)" -m 700 \\
  /home/<user>/${infra.envServicePrefix}-<ASSET>.py ${infra.envScriptBase}-<ASSET>.py
sudo cp /home/<user>/${infra.envServicePrefix}-<ASSET>.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ${infra.envServicePrefix}-<ASSET>`} />
              </li>
              <li>
                Watch a cycle. You want one line per fitted zone, one UPS line, and{" "}
                <code className="doc-code">reported N channel(s)</code>:
                <CodeBlockInline code={`journalctl -u ${infra.envServicePrefix}-<ASSET> -f`} />
              </li>
            </ol>
            <Callout variant="note" title="Poll environmental channels every minute on a magnet">
              It costs nothing here. The MagMon collector already writes a row for every minute, and
              the environmental readings merge into those same rows &mdash; so a one-minute poll adds
              no rows at all, it only fills columns. And it matters for power: the alert crons run
              every minute, so a five-minute poll can burn a third of a UPS&rsquo;s runtime before
              anyone is paged. On a standalone unit the trade is different &mdash; there, every poll
              is a new row.
            </Callout>
            <Callout variant="note" title="&quot;No sensor answered&quot; on unfitted zones is expected">
              Addresses with nothing on them log one line per cycle for the first three cycles, then
              drop to being retried every tenth cycle so they stop costing a Modbus timeout on every
              poll. A zone you <i>did</i> fit showing that line is the fault &mdash; check its
              address first.
            </Callout>
            <Callout variant="warn" title="Two collectors on this box is correct">
              The Part 1 check <code className="doc-code">pgrep -c -f {infra.processMatch}</code>{" "}
              counts MagMon collectors only, but a bare{" "}
              <code className="doc-code">pgrep -c -f gateway</code> prints <b>2</b> on a mixed unit.
              That is the healthy state, not a doubled collector. Check the specific names:
              <CodeBlockInline code={`pgrep -c -f ${infra.processMatch}-<ASSET>      # 1\npgrep -c -f ${infra.envProcessMatch}-<ASSET>         # 1`} />
            </Callout>
            <Callout variant="note" title="Both collectors write the same minute">
              Each one merges its own channels into that minute&rsquo;s row and leaves the
              other&rsquo;s alone, so the card shows helium, bay temperature and mains power
              together rather than one blanking the other. Nothing to configure.
            </Callout>
            <Callout variant="note" title="Half a unit can go quiet, and the app says which half">
              Because either collector keeps the asset reporting, &ldquo;online&rdquo; on a mixed
              unit does not mean both halves are alive. Each side keeps its own clock, so a dark one
              gets a red chip on the card &mdash; <b>MagMon not connected</b> if it has never
              reported, <b>MagMon silent</b> if it was reporting and stopped, <b>Env silent</b> for
              the reverse &mdash; and raises one alert naming the collector, rather than six
              sensor-fault events for the channels it carried. Expect the &ldquo;not
              connected&rdquo; chip in the window between installing the environmental collector and
              the MagMon one; it clears itself the moment magnet telemetry lands.
            </Callout>
          </Section>

          <Section id="env-standalone" step="Step 4 · PET/CT · Nuc Med" title="Create the asset and install the collector">
            <P>
              A unit with no MagMon &mdash; a PET/CT or Nuc Med trailer or lab &mdash; is an
              ordinary asset whose only channels are environmental. One collector, no device
              address, everything else identical to Part 1.
            </P>
            <ol className="doc-ol">
              <li>
                Create the asset as in <a className="doc-a" href="#add-asset">Step 3</a>, setting{" "}
                <b>Modality</b> to <b>PET/CT</b> or <b>Nuc Med</b>. The MagMon address and
                credential fields disappear &mdash; there is no device to reach. A stale threshold
                of about 20 minutes suits a 5-minute poll.
              </li>
              <li>
                <b>Get install script</b> hands back the environmental collector automatically; there
                is no Collector switch, because this unit can only run the one.
              </li>
              <li>
                Set the poll interval. Unlike a magnet, <b>every poll here is a new row</b> &mdash;
                five minutes is the sensible default, and one minute is a five-fold increase in
                stored history for readings that move slowly.
              </li>
              <li>Download the script and the systemd unit.</li>
            </ol>
            <P className="text-[var(--text)] font-medium">On the Pi &mdash; dependencies first:</P>
            <CodeBlock code={`sudo apt-get install -y python3-requests python3-pymodbus nut-server nut-client\n# if python3-pymodbus is not packaged for your release:\n#   sudo pip3 install --break-system-packages pymodbus\nsudo usermod -aG dialout,plugdev <user>   # then log out and back in`} />
            <P className="text-[var(--text)] font-medium">
              Copy the two files up (same SCP as{" "}
              <a className="doc-a" href="#scp">Part 1</a>), then install:
            </P>
            <CodeBlock code={`sudo install -o <user> -g "$(id -gn <user>)" -m 700 \\\n  /home/<user>/${infra.envServicePrefix}-<ASSET>.py ${infra.envScriptBase}-<ASSET>.py\n\nsudo cp /home/<user>/${infra.envServicePrefix}-<ASSET>.service \\\n        /etc/systemd/system/${infra.envServicePrefix}-<ASSET>.service\n\nsudo systemctl daemon-reload\nsudo systemctl enable --now ${infra.envServicePrefix}-<ASSET>`} />
            <P className="text-[var(--text)] font-medium">Verify &mdash; all four before you call it done:</P>
            <CodeBlock code={`systemctl status ${infra.envServicePrefix}-<ASSET> --no-pager   # active (running)\njournalctl -u ${infra.envServicePrefix}-<ASSET> -n 30 --no-pager # three zones + a UPS line\npgrep -c -f ${infra.envProcessMatch}-<ASSET>                     # prints exactly 1\nupsc ups | grep ups.status                                       # OL`} />
            <P>
              Then check the dashboard: the asset shows a tile per fitted zone with readings, a green{" "}
              <b>Wall power</b> chip, and a battery percentage. If a zone you fitted reads an
              em-dash, go back to <a className="doc-a" href="#env-addressing">Step 2</a> and re-run
              the bus scan.
            </P>
            <Callout variant="warn" title="systemd, never cron">
              Same rule as the MagMon collector, same reason: this script never exits, so a cron
              entry starts a fresh copy on every tick while the old ones keep running. If{" "}
              <code className="doc-code">pgrep -c</code> prints anything but 1, you have duplicates.
            </Callout>
          </Section>

          <Section id="env-alerts" title="Alert rules for temperature and power">
            <P>
              Power is already covered fleet-wide. A rule of{" "}
              <code className="doc-code">On UPS battery = 1</code> raises a critical{" "}
              <b>POWER OUTAGE</b> for any asset that reports the channel, so a new trailer is
              covered the moment it starts reporting &mdash; nothing to add per unit.
            </P>
            <P>
              Temperature and humidity limits are deliberately <b>unset</b>. Add them in{" "}
              <b>Admin → Alerts</b> once the right numbers are known for the space:
            </P>
            <ol className="doc-ol">
              <li>
                Pick the channel under the <b>Environment</b> group &mdash; each zone has its own
                temperature and humidity.
              </li>
              <li>
                Leave <b>Scope</b> on <b>All assets</b> for a fleet-wide limit, or pick one asset to
                override the fleet default for just that unit.
              </li>
              <li>Set the comparator and the threshold, and save.</li>
            </ol>
            <Callout variant="note" title="A fleet-wide environmental rule is safe on a magnet">
              A rule only applies where the reading exists. A channel an asset does not report is
              skipped rather than treated as zero, so adding a zone-temperature rule across all
              assets does nothing to units without sensors &mdash; and starts working by itself on
              the day they are fitted.
            </Callout>
            <Callout variant="note" title="Blank for an hour is its own alarm">
              A channel that reads blank on every sample for an hour, while the unit is otherwise
              reporting, raises a <b>sensor fault</b> naming that channel. That covers a sensor that
              drops off the bus and the UPS link going down &mdash; no rule needed, and it is why a
              missing reading must never be filled in with a zero.
            </Callout>
          </Section>

          {/* ================= PART 3 — site + network ================= */}
          <PartHeading n="Part 3" title="Site and network setup">
            Two different questions, and it is worth keeping them apart: how the <b>Pi</b> reaches
            the <b>MagMon</b> (a decision made at install time, and the one that decides the device
            address you put on the asset), and how <b>you</b> reach the Pi afterwards. Cellular
            sites come in behind an <b>iR305</b>; everything on the tailnet is reachable directly
            over Tailscale from anywhere.
          </PartHeading>

          {/* ---------------- How the Pi reaches the MagMon ---------------- */}
          <Section id="site-topology" title="How the Pi reaches the MagMon">
            <P>
              The collector talks to the device over the LAN, so the address you enter as the
              <b> MagMon address</b> on the asset is whatever the <i>Pi</i> can reach &mdash; not
              what your laptop reaches, and not what a VPN server reaches. Two shapes cover the
              fleet.
            </P>

            <P className="text-[var(--text)] font-medium">
              A. Both on the router&rsquo;s LAN &mdash; the simple one
            </P>
            <P>
              The MagMon and the Pi each plug into the site router (or a small switch behind it) and
              get addresses on the same subnet. Nothing to configure on the Pi; the device address is
              its LAN IP. Use this whenever there is a spare LAN port. It also means the MagMon&rsquo;s
              own web interface is reachable from anything else on that LAN.
            </P>

            <P className="text-[var(--text)] font-medium">
              B. Pi on Wi-Fi, MagMon on a private cable &mdash; when the device stays off the site network
            </P>
            <P>
              The Pi uplinks over the router&rsquo;s Wi-Fi and its single Ethernet port runs straight
              to the MagMon. The device is then reachable only from its own Pi, which is a real
              security gain and keeps a hospital network out of the picture entirely. Two things have
              to be true or it silently does not work:
            </P>
            <ol className="doc-ol">
              <li>
                <b>Bake the Wi-Fi credentials in when you flash the card</b> (Part 1, Step 1). With
                Ethernet committed to the device, Wi-Fi is the only uplink &mdash; a Pi that cannot
                join it is a Pi you cannot reach.
              </li>
              <li>
                <b>The Wi-Fi subnet and the device subnet must differ.</b> Two interfaces on one
                subnet makes routing ambiguous. Check the router&rsquo;s LAN range before you start.
              </li>
            </ol>
            <P>
              A direct cable has no DHCP server, so give <code className="doc-code">eth0</code> a
              static address on the device&rsquo;s subnet. Keep the MagMon&rsquo;s existing address if
              it has one &mdash; matching the Pi to the device is far easier than reconfiguring the
              device, and a device that kept its address through a router swap needs nothing done to
              it at all. <code className="doc-code">ipv4.never-default</code> is the load-bearing
              flag: it keeps the default route on Wi-Fi, so reporting and Tailscale are unaffected.
            </P>
            <CodeBlock code={`sudo nmcli con add type ethernet ifname eth0 con-name magmon-link \\
  ipv4.method manual ipv4.addresses 10.0.0.10/24,169.254.7.10/16 \\
  ipv4.never-default yes ipv6.method disabled connection.autoconnect-priority 100

sudo nmcli con up magmon-link`} />
            <P>
              The second, link-local address costs nothing and covers the case where the device was
              on DHCP from an old router and has fallen back to <code className="doc-code">169.254.x.x</code>.
              Then confirm the routing and the device, in that order:
            </P>
            <CodeBlock code={`ip -4 addr show eth0        # the static address is on the interface
ip route | head -3          # default MUST be via wlan0, not eth0
ping -c3 -W2 <magmon-host>
curl -sS -m 8 -o /dev/null -w 'HTTP %{http_code}\\n' http://<magmon-host>/`} />
            <P>
              Any HTTP status &mdash; 302 to the login page is the usual one &mdash; means the
              collector will be able to talk to it.
            </P>
            <Callout variant="note" title="If you don't know the device's address">
              Listen to what it says on the wire rather than guessing subnets. With the cable in and
              the interface up, its own broadcasts give it away:
              <CodeBlockInline code={`sudo apt-get install -y tcpdump
sudo tcpdump -ni eth0 -c 20      # ARP/DHCP chatter reveals its IP or subnet
ip neigh show dev eth0           # anything that has answered`} />
              The device&rsquo;s front panel usually shows it too.
            </Callout>
            <Callout variant="warn" title="One profile, not three">
              <code className="doc-code">nmcli con add</code> does not replace a profile of the same
              name, it adds another one &mdash; run it twice and a reboot picks one at random. If you
              have repeated it, clear them out and add one:
              <CodeBlockInline code={`for u in $(nmcli -t -f UUID,NAME con show | awk -F: '$2=="magmon-link"{print $1}'); do sudo nmcli con delete "$u"; done`} />
            </Callout>
            <Callout variant="note" title="Reaching the device yourself, on shape B">
              Only the Pi can see it, so browse it through an SSH tunnel to that named Pi &mdash;
              see <a className="doc-a" href="#reach-magmon">open a unit&rsquo;s MagMon</a>. That is
              the recommended route on shape A as well, for a different reason: several sites reuse
              the same private address.
            </Callout>
          </Section>

          {/* ---------------- iR305 ---------------- */}
          <Section id="ir305" title="Remote access via the iR305 (InHand Device Manager)">
            <P>
              Cellular sites reach the internet through an <b>InHand iR305</b> router. Its cloud
              console — the InHand IoT Device Manager — can open a secure tunnel to the Raspberry Pi
              sitting on the router&rsquo;s LAN, handing you a temporary public host and port that
              forwards straight to the Pi&rsquo;s SSH (port 22).
            </P>
            <Callout variant="note" title="Console login">
              InHand Device Manager:{" "}
              <a className="doc-a" href="https://iot.inhandnetworks.com/dashboard" target="_blank" rel="noreferrer">
                iot.inhandnetworks.com/dashboard
              </a>{" "}
              — sign in as <code className="doc-code">{infra.inhandEmail}</code>.
            </Callout>
            <ol className="doc-ol">
              <li>Sign in and open the <b>iR305</b> for the site; confirm it shows online.</li>
              <li>
                Open its remote-access / tunnel tool and create a tunnel to the <b>Pi&rsquo;s LAN
                address</b> on port <code className="doc-code">22</code> (the Pi&rsquo;s IP on the
                router&rsquo;s network — check the router&rsquo;s connected-devices list if you&rsquo;re
                unsure of it).
              </li>
              <li>Copy the public host and port the tunnel issues.</li>
              <li>SSH through it from your laptop:</li>
            </ol>
            <CodeBlock code={`ssh <user>@<public-host> -p <public-port>`} />
            <Callout variant="note" title="Tunnel to the Pi, not the router">
              Point the tunnel at the Pi&rsquo;s LAN IP:22 — not the router itself. Menu wording can
              vary slightly by firmware, but the mechanism is always the same: the tunnel gives you a
              host:port, and you <code className="doc-code">ssh</code> to it. Once a site is also on
              Tailscale (below), you can skip the tunnel entirely.
            </Callout>
            <Callout variant="warn" title="An offline router is not an offline magnet">
              If the iR305 itself drops, the dashboard says so separately from the asset. That means
              the <i>site&rsquo;s connectivity</i> is down and telemetry has nowhere to go — the magnet
              underneath may be perfectly fine. Restore the router first, then re-read the asset.
            </Callout>
          </Section>

          {/* ---------------- SSH over Tailscale ---------------- */}
          <Section id="tailscale-ssh" title="SSH into Tailscale assets">
            <P>
              From any machine signed in to the same tailnet, SSH straight to a device&rsquo;s tailnet
              IP (or its MagicDNS name):
            </P>
            <CodeBlock code={`ssh <user>@100.x.y.z\n# or, with MagicDNS:\nssh <user>@<hostname>`} />
            <P>
              The central <b>Pi server</b> is reachable two ways — on the {infra.lanLabel}, or over
              Tailscale from anywhere:
            </P>
            <table className="cheat-table my-1">
              <tbody>
                <tr>
                  <td className="desc">Pi server &mdash; LAN</td>
                  <td className="cmd">ssh &lt;user&gt;@{infra.serverLanIp}</td>
                </tr>
                <tr>
                  <td className="desc">Pi server &mdash; Tailscale</td>
                  <td className="cmd">ssh &lt;user&gt;@{infra.serverTailscaleIp}</td>
                </tr>
              </tbody>
            </table>
            <P>
              List every machine on the tailnet and its IP with{" "}
              <code className="doc-code">tailscale status</code> from any joined device.
            </P>
          </Section>

          {/* ---------------- Reaching one unit's MagMon ---------------- */}
          <Section id="reach-magmon" title="Open a unit's MagMon web interface">
            <P>
              <b>Do not browse the MagMon&rsquo;s LAN address directly.</b> That address is private
              and several sites reuse it, so over a tailnet subnet route it reaches whichever Pi
              currently owns that route — with nothing on screen to tell you which unit you got.
              This is not hypothetical: a week of minute data was read from one unit while believed
              to be another, and only the readings themselves gave it away.
            </P>
            <P>
              Tunnel through a <i>named</i> Pi instead. The Pi is at exactly one site, so the tunnel
              can only land on one MagMon. Pick a different local port per unit and you can hold
              several open at once:
            </P>
            <CodeBlock
              code={`ssh -L 8080:<magmon-host>:80 <user>@<pi-host>\n# then open http://localhost:8080`}
            />
            {infra.unitAccess.length > 0 && (
              <>
                <P>
                  Ready-made per unit. A <span className="text-[var(--status-warning)]">shared</span>{" "}
                  address is one another unit also uses — for those the tunnel is the only safe route.
                </P>
                <div className="overflow-x-auto">
                  <table className="cheat-table my-1">
                    <tbody>
                      {infra.unitAccess.map((u, i) => (
                        <tr key={u.name}>
                          <td className="desc">
                            {u.name}
                            {u.site && (
                              <span className="block text-[10px] text-[var(--text-dim)]">{u.site}</span>
                            )}
                            {u.ambiguousHost && (
                              <span className="block text-[10px] text-[var(--status-warning)]">
                                shared address
                              </span>
                            )}
                          </td>
                          <td className="cmd">
                            {u.piHost && u.magmonHost ? (
                              <>
                                ssh -L {8080 + i}:{u.magmonHost}:80 {u.piUser}@{u.piHost}
                                <span className="block text-[10px] text-[var(--text-dim)]">
                                  then http://localhost:{8080 + i}
                                </span>
                              </>
                            ) : !u.magmonHost ? (
                              <span className="text-[var(--text-dim)]">no MagMon address on record</span>
                            ) : (
                              <span className="text-[var(--text-dim)]">
                                no Tailscale node matched yet — {u.magmonHost} on its own LAN
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <P>
              To see which Pi currently owns a route from your own machine:{" "}
              <code className="doc-code">
                tailscale status --json | jq -r &apos;.Peer[] | select(.PrimaryRoutes) | &quot;\(.HostName)\t\(.PrimaryRoutes | join(&quot;,&quot;))&quot;&apos;
              </code>
            </P>
          </Section>

          {/* ---------------- Replacing a collector script ---------------- */}
          <Section id="replace-script" title="Replace a collector script on a running Pi">
            <P>
              Every collector is generated per asset with its own token and MagMon
              credentials baked in, so a change to the collector code has to be rebuilt and
              placed on each host. There are 14 collectors across 10 hosts — nine units with
              their own Pi, and five sharing the Pi server — so work down the list rather
              than trusting memory. The <b>collector version</b> shown against each asset in
              Admin tells you which are still behind.
            </P>
            <P>
              This is a <b>script swap and a restart</b>, not a reinstall. The systemd unit
              rarely changes, so there is normally no <code className="doc-code">daemon-reload</code>{" "}
              and no re-enable. Do the units in maintenance first and live hospital sites last.
            </P>

            <ol className="doc-ol">
              <li>
                In <b>Admin → Assets</b>, click <b>Get install script</b> on the asset, then{" "}
                <b>Download script</b>. It lands in <code className="doc-code">~/Downloads</code>{" "}
                as <code className="doc-code">{infra.servicePrefix}-&lt;ASSET&gt;.py</code>.
              </li>
              <li>Copy it to the host&rsquo;s home directory (one password prompt).</li>
              <li>
                Back up the running script, install the new one over it, and restart the
                service. The <code className="doc-code">cp -n</code> will not clobber an
                existing backup, so a second run in the same session still leaves you a way back.
              </li>
              <li>
                Verify three things: the service is <code className="doc-code">active</code>,
                the journal shows the new version at startup, and within a few minutes the
                asset&rsquo;s collector version in Admin matches.
              </li>
            </ol>

            <P>Copy up, then install and restart:</P>
            <CodeBlock
              code={`scp ~/Downloads/${infra.servicePrefix}-<ASSET>.py <user>@<pi-host>:/home/<user>/

ssh <user>@<pi-host> 'sudo cp -n ${infra.scriptBase}-<ASSET>.py ${infra.scriptBase}-<ASSET>.py.bak; \\
  sudo install -o <user> -g "$(id -gn <user>)" -m 700 \\
    /home/<user>/${infra.servicePrefix}-<ASSET>.py ${infra.scriptBase}-<ASSET>.py && \\
  sudo systemctl restart ${infra.servicePrefix}-<ASSET> && sleep 20 && \\
  systemctl is-active ${infra.servicePrefix}-<ASSET> && \\
  journalctl -u ${infra.servicePrefix}-<ASSET> -n 5 --no-pager'`}
            />
            <P>
              A healthy result is <code className="doc-code">active</code> followed by a
              startup line carrying the version, e.g.{" "}
              <code className="doc-code">starting for asset &lsquo;{sampleAsset}&rsquo; v2026.09.04-1</code>.
              Restarting makes the collector run a cycle immediately, so one extra reading
              lands out of step with the five-minute rhythm — that is the restart, not a fault.
            </P>

            <P>If it misbehaves, roll back to the script that was running a moment ago:</P>
            <CodeBlock
              code={`ssh <user>@<pi-host> 'sudo cp ${infra.scriptBase}-<ASSET>.py.bak ${infra.scriptBase}-<ASSET>.py && \\
  sudo systemctl restart ${infra.servicePrefix}-<ASSET>'`}
            />

            {infra.unitAccess.length > 0 && (
              <>
                <P>
                  The <code className="doc-code">&lt;user&gt;@&lt;pi-host&gt;</code> for each unit.
                  Units with no Tailscale node of their own run on the shared Pi server — use
                  its address for those.
                </P>
                <div className="overflow-x-auto">
                  <table className="cheat-table my-1">
                    <tbody>
                      {infra.unitAccess.map((u) => (
                        <tr key={u.name}>
                          <td className="desc">
                            {u.name}
                            {u.site && (
                              <span className="block text-[10px] text-[var(--text-dim)]">{u.site}</span>
                            )}
                          </td>
                          <td className="cmd">
                            {u.piHost ? (
                              `${u.piUser}@${u.piHost}`
                            ) : (
                              <span className="text-[var(--text-dim)]">
                                {u.piUser}@{infra.serverTailscaleIp} (shared Pi server — confirm before deploying)
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Section>

          {/* ---------------- Pi server ---------------- */}
          <Section id="pi-server" title={`The shared Pi server (${infra.serverHostname})`}>
            <P>
              Some sites don&rsquo;t get their own Pi — they&rsquo;re reached over a VPN from one
              central box instead. The Pi server — hostname{" "}
              <code className="doc-code">{infra.serverHostname}</code>,{" "}
              <code className="doc-code">{infra.serverLanIp}</code> on the LAN or{" "}
              <code className="doc-code">{infra.serverTailscaleIp}</code> over Tailscale — runs{" "}
              <b>one collector per asset</b>, each installed exactly as in Part 1. Every asset is a
              matching pair owned by the <code className="doc-code">{infra.piUser}</code> user: a{" "}
              <code className="doc-code">.py</code> collector and its{" "}
              <code className="doc-code">.service</code> unit, both named{" "}
              <code className="doc-code">{infra.servicePrefix}-&lt;ASSET&gt;</code>.
            </P>
            <CheatGroup title="Collector services">
              {infra.assets.map((a) => (
                <Cmd key={a} c={`${infra.servicePrefix}-${a}`} d={`Reports telemetry for ${a}`} />
              ))}
            </CheatGroup>
            <P>SSH in and manage a collector by its service name:</P>
            <CodeBlock code={`ssh ${infra.piUser}@${infra.serverTailscaleIp}              # or ${infra.serverLanIp} on the LAN\nls -la                                # the .py + .service pairs\nsystemctl status ${infra.servicePrefix}-${sampleAsset}\njournalctl -u ${infra.servicePrefix}-${sampleAsset} -f     # live logs\nsudo systemctl restart ${infra.servicePrefix}-${sampleAsset}`} />
            <P>Check the whole box at once:</P>
            <CodeBlock code={`systemctl list-units '${infra.servicePrefix}-*' --no-pager   # one per asset, all running\npgrep -c -f ${infra.processMatch}                            # should equal the asset count`} />
            <P>
              Take an installed collector out of service — stop it now and keep it from starting on
              boot (<code className="doc-code">--now</code> does both):
            </P>
            <CodeBlock code={`sudo systemctl disable --now ${infra.servicePrefix}-<ASSET>\nsystemctl status ${infra.servicePrefix}-<ASSET>     # confirm: inactive (dead), disabled\npgrep -af ${infra.processMatch}-<ASSET>               # no output = nothing left running`} />
            <P>
              Re-enable it later with{" "}
              <code className="doc-code">sudo systemctl enable --now {infra.servicePrefix}-&lt;ASSET&gt;</code>. The
              service is named <code className="doc-code">{infra.servicePrefix}-&lt;ASSET&gt;</code>,
              while the running process comes from{" "}
              <code className="doc-code">{infra.scriptBase}-&lt;ASSET&gt;.py</code> — so match on{" "}
              <code className="doc-code">{infra.processMatch}</code> when grepping.
            </P>
            <Callout variant="warn" title="Confirm routing before adding sites to one box">
              Each MagMon must be reachable <i>from this server</i> at a distinct address (the
              monitor host set on the asset). If two sites reuse the same private subnet behind the
              tunnel they will collide — give them distinct routes or NAT first.
            </Callout>
          </Section>

          {/* ================= PART 4 — run + troubleshoot ================= */}
          <PartHeading n="Part 4" title="Run and troubleshoot">
            What to do when an asset goes red. Work the triage table first — it splits the two failure
            families that look identical on the dashboard (<i>the site is unreachable</i> vs{" "}
            <i>the site is reachable but nothing is arriving</i>) before you start changing things.
          </PartHeading>

          {/* ---------------- Troubleshooting ---------------- */}
          <Section id="troubleshooting" title="Troubleshooting a gateway">
            <P>
              &ldquo;Offline&rdquo; on the dashboard means <b>no fresh telemetry</b> — nothing more.
              A dead magnet, a dead Pi, a dead router and a Pi that simply can&rsquo;t reach the
              internet all produce the same red chip. Start by finding out which one you have.
            </P>

            <P className="text-[var(--text)] font-medium">Triage — run these three, in this order:</P>
            <CodeBlock code={`# 1. Can you reach the Pi at all?  (from your laptop, on the tailnet)\nssh <user>@<tailnet-ip>\n\n# 2. Is the collector running, and is it saying anything?\nsystemctl status ${infra.servicePrefix}-<ASSET> --no-pager\njournalctl -u ${infra.servicePrefix}-<ASSET> -n 50 --no-pager\n\n# 3. Can the Pi reach the outside world, by name?\nping -c2 8.8.8.8                       # raw-IP internet\ngetent hosts ${infra.reportHost}   # the DNS lookup that actually matters`} />

            <CheatGroup title="What the answers mean">
              <Cmd c="SSH fails, Tailscale shows the node down" d="The Pi or the site link is down — power, network, or router. Start at the iR305." />
              <Cmd c="SSH works, service inactive/failed" d="Collector problem. See the install-failure table below." />
              <Cmd c="SSH works, service running, ping OK, getent FAILS" d="Pi-local DNS failure. This is the classic one — see below." />
              <Cmd c="Everything green, journal says 'reported OK'" d="Telemetry is flowing. If values look wrong, judge the magnet itself." />
              <Cmd c="Card shows 'MagMon not connected' or 'MagMon silent'" d="A unit with two collectors has one down. The other keeps it reporting, so the status chip stays green — check that specific service, not the asset." />
              <Cmd c="Card shows 'Env silent'" d="Same, the other way round: the sensors or UPS link stopped while the MagMon side keeps reporting." />
              <Cmd c="Every zone blank on a unit with sensors" d="Almost always serial permissions, not sensors — see the dialout/plugdev note in Part 2." />
            </CheatGroup>

            <Callout variant="warn" title="Offline while the Pi looks perfectly healthy = suspect DNS">
              SSH, Tailscale and a direct <code className="doc-code">curl</code> to the MagMon all use
              a raw IP or Tailscale&rsquo;s own path — <b>none of them need DNS</b>. So they all pass
              while the one DNS-dependent call, reporting to{" "}
              <code className="doc-code">{infra.reportHost}</code>, fails silently. The journal tell is{" "}
              <code className="doc-code">
                socket.gaierror [Errno -3] Temporary failure in name resolution
              </code>
              . Confirm with the <code className="doc-code">getent</code> line above; if{" "}
              <code className="doc-code">ping 8.8.8.8</code> works and the lookup doesn&rsquo;t,
              it&rsquo;s DNS only. Fix by pointing the Pi at a public resolver, then restarting the
              collector:
              <CodeBlockInline code={`sudo nano /etc/resolv.conf        # nameserver 1.1.1.1 / 8.8.8.8\nsudo systemctl restart ${infra.servicePrefix}-<ASSET>\n\n# make it survive a reboot:\n# add to /etc/dhcpcd.conf:\n#   static domain_name_servers=1.1.1.1 8.8.8.8`} />
              If only <i>one</i> asset gapped while the others kept reporting, it is that Pi — not the
              backend.
            </Callout>

            <Callout variant="note" title="Running but the journal is empty — that's buffering, not a hang">
              If <code className="doc-code">pgrep -c -f {infra.processMatch}-&lt;ASSET&gt;</code>{" "}
              prints 1 but <code className="doc-code">journalctl</code> shows nothing recent, the
              process is usually fine — Python is block-buffering its output. Current units set{" "}
              <code className="doc-code">Environment=PYTHONUNBUFFERED=1</code>; units deployed before
              that don&rsquo;t. Trust <code className="doc-code">systemctl status</code> and CPU time
              over a live <code className="doc-code">journalctl -f</code>, and fix it by re-downloading
              <i>both</i> files from Admin and redoing step 6. Units must live in{" "}
              <code className="doc-code">/etc/systemd/system/</code> — confirm which file is actually
              loaded with{" "}
              <code className="doc-code">
                systemctl cat {infra.servicePrefix}-&lt;ASSET&gt; | grep FragmentPath
              </code>
              .
            </Callout>

            <Callout variant="note" title="Reporting, but the data never moves on">
              These controllers have no battery-backed clock, so a power blip reboots the MagMon and
              snaps its clock back to <code className="doc-code">13-May-06</code>. The collector only
              sends rows <i>newer</i> than the last one it sent, so every row now looks older than the
              stored high-water mark and the feed goes quiet while the service looks perfectly healthy.
              Clear the mark to recover:
              <CodeBlockInline code={`sudo systemctl stop ${infra.servicePrefix}-<ASSET>\nsudo rm -f /var/tmp/${infra.servicePrefix}-<ASSET>.hwm\nsudo systemctl start ${infra.servicePrefix}-<ASSET>`} />
              Current scripts detect the reset and re-anchor themselves, so this is only needed on a
              Pi that hasn&rsquo;t been redeployed since. A 2006 date on its own is normal for these
              units and is not evidence of anything — rule out DNS first.
            </Callout>

            <P className="text-[var(--text)] font-medium">Install-time failures (fresh deploys):</P>
            <CheatGroup title="Symptom → fix">
              <Cmd c="ModuleNotFoundError: 'requests'" d="python3-requests was never installed. Install it, then restart the service." />
              <Cmd c="Service state 217/USER" d="The Service user you set in Admin doesn't exist here. Check whoami, re-download, redo step 6." />
              <Cmd c="Permission denied on the .py" d="Wrong owner or mode — re-run the sudo install line in step 6 exactly." />
              <Cmd c="'another copy already holds the lock'" d="A second copy really is running. pgrep -af, kill the extras, remove any cron entry." />
              <Cmd c="'Cannot reach MagMon at <ip>:<port>'" d="Wrong or unroutable MagMon address for this site. Fix it in Admin → Edit, re-download, redo step 6." />
              <Cmd c="Still offline after a few minutes" d="Token mismatch — most likely rotated. Re-download the current script and redo step 6." />
            </CheatGroup>

            <Callout variant="note" title="&quot;Compressor powered off or cable disconnected&quot; — the coldhead tells you which">
              That status code covers two different jobs, and the cryogenics decide between them. A
              compressor genuinely stopped for weeks <b>cannot</b> leave a coldhead at 4 K, so a cold
              coldhead beside that alarm means the MagMon has lost its 24 V sense line and the
              cryocooler is still running &mdash; check the cable before you order a compressor. A
              coldhead up at 50 K or 300 K beside the same code means it really has stopped. The
              alert now says which of the two it is; this is the reasoning behind it.
            </Callout>
            <Callout variant="note" title="Falling helium with a cold coldhead is not boil-off">
              Same idea, the other way round. If the coldhead is at 4 K the cryocooler is working, so
              helium leaving the vessel is going out somewhere else &mdash; a relief valve or a seal,
              not a cryogenic failure. A warming coldhead alongside falling helium is the boil-off
              case. Worth knowing how small the normal signal is: across this fleet a healthy magnet
              moves <b>less than 0.1 % of helium in three weeks</b>, so any sustained daily loss is a
              large departure long before the level looks low.
            </Callout>
            <Callout variant="note" title="Telling a real magnet fault from a collection bug">
              When the numbers look alarming, cross-check the two independent read paths — the HTTP
              scrape and the FTP file use completely different parsers. If both agree to the decimal,
              the numbers are the device&rsquo;s true state, not misalignment. Then judge health from
              the <b>cryo diodes</b>, not the helium level: a cold, running magnet reads coldhead and
              recon around <b>4 K</b> with the shield near 40 K, while a warm or powered-down one reads
              them all at <b>300 K+</b> with helium at 0 and no water flow. An all-zero reading from a
              genuinely warm unit looks exactly like a parser bug — this is how you tell.
            </Callout>

            <Callout variant="warn" title="Leave legacy collectors alone">
              Some older Pis still run pre-app collectors under cron alongside the gateway service
              (older <code className="doc-code">magmon_collect_*</code> scripts and their log files).
              They are unrelated to this app, but other reporting may still depend on them — don&rsquo;t
              disable, delete, or clean up those cron entries as part of gateway work. If one is
              filling the disk, ask before touching it, and archive anything you remove: several of
              those scripts exist on the Pi and nowhere else.
            </Callout>
          </Section>

          {/* ---------------- Minute resolution ---------------- */}
          <Section id="resolution-check" title="Confirm a collector is storing every minute">
            <P>
              A collector can be perfectly healthy and still be storing a twelfth of what the device
              is serving. The MagMons log a row a minute; the collector fetches the last hour each
              cycle and files every row newer than the last one it sent. If it cannot read the
              device&rsquo;s timestamps it degrades quietly instead of failing: it files just the
              newest row, stamped with the current time. The unit reports on schedule, the charts
              draw, and the resolution is gone. It ran that way fleet-wide from August 2026 until it
              was noticed on an install in September.
            </P>
            <P className="text-[var(--text)] font-medium">The tell, in the journal:</P>
            <CodeBlock code={`journalctl -u ${infra.servicePrefix}-<ASSET> -n 20 --no-pager | grep 'reported'`} />
            <table className="cheat-table my-1">
              <tbody>
                <tr>
                  <td className="desc">Healthy</td>
                  <td className="cmd">
                    reported 5 sample(s) &mdash; on a 5-minute poll
                    <span className="block text-[10px] text-[var(--text-dim)]">
                      One per minute elapsed. The first cycle after any restart reports 1 by design.
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="desc">Degraded</td>
                  <td className="cmd">
                    reported 1 sample(s) &mdash; every cycle, forever
                    <span className="block text-[10px] text-[var(--text-dim)]">
                      And no <code className="doc-code">.hwm</code> file, which is only written when a
                      row&rsquo;s timestamp parses.
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
            <CodeBlock code={`ls -l /var/tmp/${infra.servicePrefix}-<ASSET>.hwm   # missing = nothing has ever dated`} />
            <P>
              The same thing is visible from the dashboard side without SSH: a degraded unit stores
              exactly <b>60 ÷ poll-minutes</b> rows an hour &mdash; a flat 12/hour on a five-minute
              poll, never more.
            </P>
            <P className="text-[var(--text)] font-medium">
              The fix is a script redeploy, not a device change:
            </P>
            <ol className="doc-ol">
              <li>
                Check the asset&rsquo;s <b>collector version</b> in Admin. Anything older than the
                current generator is suspect, and the panel marks it &ldquo;behind&rdquo;.
              </li>
              <li>
                Redeploy it &mdash; <a className="doc-a" href="#replace-script">replace a collector
                script</a>. Script swap and restart; the systemd unit does not change.
              </li>
              <li>
                Watch the <i>second</i> cycle after the restart. Five samples and a{" "}
                <code className="doc-code">.hwm</code> file means it is filing every minute.
              </li>
            </ol>
            <Callout variant="note" title="Confirming the device really is logging every minute">
              Pull the minute table by hand and look at the spacing. One-minute steps mean the data is
              there and the collector is the problem; five-minute steps mean the device itself is
              configured to log at that interval, and no collector change will help:
              <CodeBlockInline code={`curl -s --http0.9 --max-time 25 -u <user>:<pass> \\
  "http://<magmon-host>/goform/showMinutesCGI?num_hours=1&start_day=0&start_hour=1" \\
  | grep -oE '[0-9]{2}:[0-9]{2}' | tail -15`} />
            </Callout>
            <Callout variant="warn" title="Expect roughly five times the rows per unit">
              Raw samples are purged on a rolling window, so the database settles at a new steady
              state a week after a unit is converted rather than growing without bound &mdash; but
              convert the fleet deliberately and watch the size as you go. Daily rollups carry the
              long history, so shortening the raw window is the first lever if it gets tight.
            </Callout>
          </Section>

          {/* ---------------- Everyday commands ---------------- */}
          <Section id="commands" title="Everyday Raspberry Pi commands">
            <P>A quick cheat sheet for working on a Pi over SSH.</P>

            <CheatGroup title="Getting around">
              <Cmd c="pwd" d="Print the folder you're currently in" />
              <Cmd c="ls -la" d="List everything, including hidden files, with details" />
              <Cmd c="cd /path/to/dir" d="Change directory" />
              <Cmd c="cd ~" d="Go to your home directory" />
              <Cmd c="cd .." d="Go up one level" />
            </CheatGroup>

            <CheatGroup title="Files">
              <Cmd c="cat file" d="Print a file to the screen" />
              <Cmd c="less file" d="Scroll through a long file (q to quit)" />
              <Cmd c="nano file" d="Edit a file (Ctrl+O save, Ctrl+X exit)" />
              <Cmd c="cp a b" d="Copy a to b" />
              <Cmd c="mv a b" d="Move or rename a to b" />
              <Cmd c="rm file" d="Delete a file (no undo)" />
              <Cmd c="mkdir dir" d="Make a new folder" />
              <Cmd c="chmod +x script.py" d="Make a script executable" />
              <Cmd c="du -sh *" d="What's using the space in this folder" />
            </CheatGroup>

            <CheatGroup title="System">
              <Cmd c="sudo apt update && sudo apt full-upgrade -y" d="Update all packages" />
              <Cmd c="df -h" d="Disk space, human-readable" />
              <Cmd c="free -h" d="Memory in use" />
              <Cmd c="htop" d="Live processes + CPU (q to quit)" />
              <Cmd c="uptime" d="How long it's been up, load average" />
              <Cmd c="date" d="The Pi's clock — worth checking during odd faults" />
              <Cmd c="sudo reboot" d="Restart the Pi" />
              <Cmd c="sudo shutdown now" d="Power it off" />
            </CheatGroup>

            <CheatGroup title="Services (systemd)">
              <Cmd c="systemctl status <name>" d="Is the service running?" />
              <Cmd c="sudo systemctl restart <name>" d="Restart it" />
              <Cmd c="sudo systemctl enable --now <name>" d="Start now + on every boot" />
              <Cmd c="sudo systemctl disable --now <name>" d="Stop now + never start on boot" />
              <Cmd c="journalctl -u <name> -f" d="Follow its live logs" />
              <Cmd c="journalctl -u <name> -n 50 --no-pager" d="Last 50 lines, no pager" />
              <Cmd c="systemctl cat <name>" d="Show the unit file that's actually loaded" />
            </CheatGroup>

            <CheatGroup title="Processes">
              <Cmd c="pgrep -af <pattern>" d="Every matching process, with its full command" />
              <Cmd c="pgrep -c -f <pattern>" d="Just the count — 1 is what you want per collector" />
              <Cmd c="sudo kill <pid>" d="Stop a stray process" />
            </CheatGroup>

            <CheatGroup title="Scheduling (cron)">
              <Cmd c="crontab -e" d="Edit your scheduled jobs" />
              <Cmd c="crontab -l" d="List your scheduled jobs" />
              <Cmd c="* * * * * command" d="min hour day month weekday — then the command" />
            </CheatGroup>
            <Callout variant="note" title="MagMon runs under systemd, not cron">
              The gateway collector is a long-running service managed by systemd — check it with{" "}
              <code className="doc-code">systemctl status {infra.servicePrefix}-&lt;ASSET&gt;</code>,
              not <code className="doc-code">crontab</code>. Use cron for one-off periodic maintenance
              tasks.
            </Callout>

            <CheatGroup title="Networking">
              <Cmd c="hostname -I" d="This Pi's IP address(es)" />
              <Cmd c="ip a" d="All network interfaces in detail" />
              <Cmd c="ping 8.8.8.8" d="Test raw-IP connectivity (Ctrl+C to stop)" />
              <Cmd c="getent hosts <hostname>" d="Test DNS specifically — resolves a name to an IP" />
              <Cmd c="curl -s http://<magmon-ip>" d="Read the MagMon directly, bypassing the collector" />
              <Cmd c="tailscale status" d="Every device on the tailnet + its IP" />
              <Cmd c="tailscale ip -4" d="This device's tailnet IP" />
            </CheatGroup>
          </Section>
        </div>
      </div>
    </div>
  );
}

/* ------------------------- pieces ------------------------- */

/* Divider that opens each of the three parts, so the page reads as a sequence
   of phases rather than a flat list of topics. */
function PartHeading({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="doc-part">
      <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--accent)] mb-1">{n}</p>
      <h2 className="text-xl md:text-2xl font-semibold tracking-tight text-[var(--text)] mb-2">
        {title}
      </h2>
      <p className="text-sm text-[var(--text-muted)] leading-relaxed max-w-2xl">{children}</p>
    </div>
  );
}

function Section({
  id,
  step,
  title,
  children,
}: {
  id: string;
  step?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="doc-section">
      {step && (
        <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-dim)] mb-1">{step}</p>
      )}
      <h3 className="text-lg md:text-xl font-semibold tracking-tight text-[var(--text)] mb-3">
        {title}
      </h3>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function P({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-sm text-[var(--text-muted)] leading-relaxed ${className}`}>{children}</p>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the text is still visible to select manually */
    }
  }
  return (
    <div className="code-block">
      <button type="button" className="code-copy font-mono-data" onClick={copy} aria-label="Copy to clipboard">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="font-mono-data">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/* Same block, spaced for use inside a callout body. */
function CodeBlockInline({ code }: { code: string }) {
  return (
    <div className="mt-2">
      <CodeBlock code={code} />
    </div>
  );
}

function Callout({
  variant = "note",
  title,
  children,
}: {
  variant?: "note" | "warn" | "todo";
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`callout callout--${variant}`}>
      <span className="callout-icon" aria-hidden="true">
        {variant === "warn" ? (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
            <path d="M12 3.5 22 20H2L12 3.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M12 10v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="12" cy="17" r="1" fill="currentColor" />
          </svg>
        ) : variant === "todo" ? (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 8v4l2.5 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 11v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="12" cy="7.75" r="1" fill="currentColor" />
          </svg>
        )}
      </span>
      <div className="min-w-0">
        {title && <strong className="block text-[var(--text)] mb-0.5">{title}</strong>}
        {children}
      </div>
    </div>
  );
}

function CheatGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--card)] overflow-hidden">
      <p className="text-xs uppercase tracking-wide text-[var(--text-muted)] px-4 pt-3 pb-2">
        {title}
      </p>
      <table className="cheat-table">
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Cmd({ c, d }: { c: string; d: string }) {
  return (
    <tr>
      <td className="cmd">{c}</td>
      <td className="desc">{d}</td>
    </tr>
  );
}

/* Highlights the TOC entry whose section is currently in view. */
function useScrollSpy(ids: string[]): string {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 }
    );
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(",")]);
  return active;
}
