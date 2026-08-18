"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { DocsInfra } from "@/lib/docsInfra";

// The knowledge base body, shared by the live docs (/docs, realInfra) and the
// demo docs (/demo/docs, demoInfra). Every site-specific identifier comes from
// `infra` so there is a single source of truth for structure and prose; only
// the redactable values differ between modes.
//
// Ordered as a runbook, not a reference: PART 1 takes a Pi from the box to
// reporting telemetry, PART 2 is the per-site network work (iR305, Tailscale,
// shared server), PART 3 is what you reach for once it is deployed and
// something looks wrong. The TOC mirrors those parts.

const PARTS: { part: string; blurb: string; sections: { id: string; label: string }[] }[] = [
  {
    part: "1 · Stand up a gateway",
    blurb: "Unbox to reporting",
    sections: [
      { id: "pi-setup", label: "Flash the card + first boot" },
      { id: "get-script", label: "Generate the install script" },
      { id: "scp", label: "Copy the files over (SCP)" },
      { id: "install-collector", label: "Install + verify the collector" },
    ],
  },
  {
    part: "2 · Site + network setup",
    blurb: "Per-site access",
    sections: [
      { id: "ir305", label: "iR305 remote access" },
      { id: "tailscale", label: "Tailscale setup" },
      { id: "tailscale-ssh", label: "SSH over Tailscale" },
      { id: "pi-server", label: "The shared Pi server" },
    ],
  },
  {
    part: "3 · Run + troubleshoot",
    blurb: "Day to day",
    sections: [
      { id: "troubleshooting", label: "Troubleshooting a gateway" },
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
          take a Raspberry Pi from the box to reporting telemetry, wire the site up for remote access,
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
            These four steps take it from a sealed box to an asset showing <b>online</b> on the
            dashboard. Do them in order — each one depends on the last.
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
                  <li>Hostname (e.g. <code className="doc-code">{infra.sampleHostname}</code>)</li>
                  <li>Enable SSH (password authentication is fine to start)</li>
                  <li>
                    Username + password — this is the account you&rsquo;ll SSH in as <i>and</i> the
                    one the collector service will run as, so write it down; you&rsquo;ll type it into
                    the admin panel in step 2
                  </li>
                  <li>Wi-Fi SSID, password, and country — if it&rsquo;ll be on Wi-Fi</li>
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
              Then install the one library the collector needs. This is <b>per machine</b>, not per
              asset — do it once and it covers every collector you install later:
            </P>
            <CodeBlock code={`sudo apt-get install -y python3-requests`} />
            <Callout variant="note" title="Static-ish addressing">
              For a site Pi, reserve its IP in the router&rsquo;s DHCP by MAC address rather than
              hand-configuring one on the Pi — it survives re-imaging and avoids collisions. Extra
              knobs live under <code className="doc-code">sudo raspi-config</code>.
            </Callout>
          </Section>

          {/* ---------------- 2. Generate the install script ---------------- */}
          <Section id="get-script" step="Step 2" title="Generate the install script in Admin">
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
              <li>Set the poll interval if it needs to differ from the default, then click <b>Regenerate</b>.</li>
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
          <Section id="scp" step="Step 3" title="Copy the files to the Pi with SCP">
            <P>
              <code className="doc-code">scp</code> copies files over the same SSH connection. It
              runs from your laptop, not from the Pi.
            </P>
            <P className="text-[var(--text)] font-medium">Send the two files from step 2 up:</P>
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
          <Section id="install-collector" step="Step 4" title="Install the collector and verify it reports">
            <P>
              Now SSH in — everything below runs <b>on the Pi</b>. The unit file is already correct,
              so this is just: put the script in place, put the unit in place, start it.
            </P>
            <CodeBlock code={`sudo install -o <user> -g "$(id -gn <user>)" -m 700 \\\n  /home/<user>/${infra.servicePrefix}-<ASSET>.py ${infra.scriptBase}-<ASSET>.py\n\nsudo cp /home/<user>/${infra.servicePrefix}-<ASSET>.service \\\n        /etc/systemd/system/${infra.servicePrefix}-<ASSET>.service\n\nsudo systemctl daemon-reload\nsudo systemctl enable --now ${infra.servicePrefix}-<ASSET>`} />
            <P className="text-[var(--text)] font-medium">
              Verify — all three must pass before you call it done:
            </P>
            <CodeBlock code={`systemctl status ${infra.servicePrefix}-<ASSET> --no-pager      # active (running)\njournalctl -u ${infra.servicePrefix}-<ASSET> -n 30 --no-pager   # "reported OK", no errors\npgrep -c -f ${infra.processMatch}-<ASSET>                        # prints exactly 1`} />
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

          {/* ================= PART 2 — site + network ================= */}
          <PartHeading n="Part 2" title="Site and network setup">
            How you <i>reach</i> a gateway once it is deployed, which depends on the site. Cellular
            sites come in behind an <b>iR305</b> router; everything on the tailnet is reachable
            directly over <b>Tailscale</b> from anywhere. Set up Tailscale on every gateway you can —
            it makes the rest of this document one-step instead of two.
          </PartHeading>

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

          {/* ---------------- Tailscale ---------------- */}
          <Section id="tailscale" title="Install Tailscale and join the tailnet">
            <P>
              Tailscale puts every Pi on one private mesh network so you can reach it by a stable{" "}
              <code className="doc-code">100.x.y.z</code> address from anywhere, no port forwarding.
              All {infra.deviceScopeLabel} live on the <b>{infra.tailnetAccount}</b> tailnet.
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

          {/* ================= PART 3 — run + troubleshoot ================= */}
          <PartHeading n="Part 3" title="Run and troubleshoot">
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
              <i>both</i> files from Admin and redoing step 4. Units must live in{" "}
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
              <Cmd c="Service state 217/USER" d="The Service user you set in Admin doesn't exist here. Check whoami, re-download, redo step 4." />
              <Cmd c="Permission denied on the .py" d="Wrong owner or mode — re-run the sudo install line in step 4 exactly." />
              <Cmd c="'another copy already holds the lock'" d="A second copy really is running. pgrep -af, kill the extras, remove any cron entry." />
              <Cmd c="'Cannot reach MagMon at <ip>:<port>'" d="Wrong or unroutable MagMon address for this site. Fix it in Admin → Edit, re-download, redo step 4." />
              <Cmd c="Still offline after a few minutes" d="Token mismatch — most likely rotated. Re-download the current script and redo step 4." />
            </CheatGroup>

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
