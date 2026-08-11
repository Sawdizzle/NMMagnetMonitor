"use client";

import { useEffect, useState, type ReactNode } from "react";
import Protected from "@/components/Protected";

const SECTIONS = [
  { id: "pi-setup", label: "New Pi setup" },
  { id: "remote-access", label: "Remote access (tunnel)" },
  { id: "scp", label: "Copy files with SCP" },
  { id: "tailscale", label: "Tailscale setup" },
  { id: "tailscale-ssh", label: "SSH over Tailscale" },
  { id: "pi-server", label: "Scripts on the Pi server" },
  { id: "commands", label: "Everyday Pi commands" },
];

export default function DocsPage() {
  return <Protected>{() => <Docs />}</Protected>;
}

function Docs() {
  const active = useScrollSpy(SECTIONS.map((s) => s.id));

  return (
    <div id="main-content" className="min-h-screen p-6 md:p-10" role="main">
      <header className="mb-6">
        <p className="eyebrow mb-1.5">Knowledge base</p>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Documentation</h1>
        <p className="text-sm text-[var(--text-muted)] leading-relaxed mt-2 max-w-2xl">
          How the Numed MagMon fleet is set up and maintained — from imaging a fresh Raspberry Pi
          to reaching one over Tailscale, plus a command cheat sheet for day-to-day work on the Pis.
        </p>
      </header>

      {/* Mobile: horizontal jump-to chips */}
      <nav className="lg:hidden flex gap-2 overflow-x-auto pb-1 mb-6" aria-label="On this page">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="doc-chip">
            {s.label}
          </a>
        ))}
      </nav>

      <div className="lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-10">
        {/* Desktop: sticky table of contents */}
        <nav className="doc-toc hidden lg:block" aria-label="On this page">
          <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-dim)] mb-2 pl-2.5">
            On this page
          </p>
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className={active === s.id ? "active" : ""}>
              {s.label}
            </a>
          ))}
        </nav>

        <div className="min-w-0 flex flex-col gap-12">
          {/* ---------------- New Pi setup ---------------- */}
          <Section id="pi-setup" title="Set up a brand-new Raspberry Pi">
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
                  <li>Hostname (e.g. <code className="doc-code">ca1012-setonsw</code>)</li>
                  <li>Enable SSH (password authentication is fine to start)</li>
                  <li>Username + password (the account you&rsquo;ll SSH in as)</li>
                  <li>Wi-Fi SSID, password, and country — if it&rsquo;ll be on Wi-Fi</li>
                  <li>Locale / timezone</li>
                </ul>
              </li>
              <li>Write the card, put it in the Pi, and power it on. Give it a minute on first boot.</li>
              <li>Find and connect to it by hostname:</li>
            </ol>
            <CodeBlock code={`ssh <user>@<hostname>.local\n# e.g. ssh numed@ca1012-setonsw.local`} />
            <P>Once you&rsquo;re in, bring it fully up to date and reboot:</P>
            <CodeBlock code={`sudo apt update && sudo apt full-upgrade -y\nsudo reboot`} />
            <Callout variant="note" title="Static-ish addressing">
              For a site Pi, reserve its IP in the router&rsquo;s DHCP by MAC address rather than
              hand-configuring one on the Pi — it survives re-imaging and avoids collisions. Extra
              knobs live under <code className="doc-code">sudo raspi-config</code>.
            </Callout>
          </Section>

          {/* ---------------- Remote access via tunnel ---------------- */}
          <Section id="remote-access" title="Remote access via the iR305 (InHand Device Manager)">
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
              — sign in as <code className="doc-code">NumedIT@numedinc.com</code>.
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
          </Section>

          {/* ---------------- SCP ---------------- */}
          <Section id="scp" title="Copy scripts to a Pi with SCP">
            <P>
              <code className="doc-code">scp</code> copies files over the same SSH connection. It
              runs from your laptop, not from the Pi.
            </P>
            <P className="text-[var(--text)] font-medium">Push a script up to the Pi:</P>
            <CodeBlock code={`scp ./collector.py <user>@<host>:/home/<user>/`} />
            <P className="text-[var(--text)] font-medium">Copy a whole folder (recursive):</P>
            <CodeBlock code={`scp -r ./scripts <user>@<host>:/home/<user>/`} />
            <P className="text-[var(--text)] font-medium">Pull a file back down from the Pi:</P>
            <CodeBlock code={`scp <user>@<host>:/home/<user>/gateway.log ./`} />
            <P className="text-[var(--text)] font-medium">Through a Device Manager tunnel port:</P>
            <CodeBlock code={`scp -P <tunnel-port> ./collector.py <user>@<tunnel-host>:/home/<user>/`} />
            <Callout variant="warn" title="It's -P, capital, for scp">
              <code className="doc-code">scp</code> uses <code className="doc-code">-P</code> (capital)
              for the port, while <code className="doc-code">ssh</code> uses{" "}
              <code className="doc-code">-p</code> (lowercase). Easy to mix up. Over Tailscale, just
              use the tailnet IP or MagicDNS name as <code className="doc-code">&lt;host&gt;</code> —
              no tunnel needed.
            </Callout>
          </Section>

          {/* ---------------- Tailscale ---------------- */}
          <Section id="tailscale" title="Install Tailscale + join the tailnet">
            <P>
              Tailscale puts every Pi on one private mesh network so you can reach it by a stable{" "}
              <code className="doc-code">100.x.y.z</code> address from anywhere, no port forwarding.
              All Numed devices live on the <b>nmbackup@numedinc.com</b> tailnet.
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
                Open that URL and sign in with the <b>nmbackup@numedinc.com</b> account to join the
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
            <Callout variant="note" title="Name it clearly">
              Set the machine name in the admin console to match the asset (same as the hostname) so{" "}
              <code className="doc-code">tailscale status</code> reads like a fleet list rather than a
              wall of IPs.
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
              The central <b>Pi server</b> is reachable two ways — on the Numed LAN, or over Tailscale
              from anywhere:
            </P>
            <table className="cheat-table my-1">
              <tbody>
                <tr>
                  <td className="desc">Pi server &mdash; LAN</td>
                  <td className="cmd">ssh &lt;user&gt;@10.1.100.100</td>
                </tr>
                <tr>
                  <td className="desc">Pi server &mdash; Tailscale</td>
                  <td className="cmd">ssh &lt;user&gt;@100.120.75.117</td>
                </tr>
              </tbody>
            </table>
            <P>
              List every machine on the tailnet and its IP with{" "}
              <code className="doc-code">tailscale status</code> from any joined device.
            </P>
          </Section>

          {/* ---------------- Pi server scripts ---------------- */}
          <Section id="pi-server" title="Scripts on the Pi server (nas123)">
            <P>
              The Pi server — hostname <code className="doc-code">nas123</code>,{" "}
              <code className="doc-code">10.1.100.100</code> on the LAN or{" "}
              <code className="doc-code">100.120.75.117</code> over Tailscale — runs one collector per
              monitored asset as a <b>systemd service</b>. Each asset is a matching pair owned by the{" "}
              <code className="doc-code">numed</code> user: a{" "}
              <code className="doc-code">.py</code> collector and its{" "}
              <code className="doc-code">.service</code> unit, both named{" "}
              <code className="doc-code">nm-magmon-gateway-&lt;ASSET&gt;</code>.
            </P>
            <CheatGroup title="Collector services">
              <Cmd c="nm-magmon-gateway-CA1012" d="Reports telemetry for CA1012" />
              <Cmd c="nm-magmon-gateway-NM1001" d="Reports telemetry for NM1001" />
              <Cmd c="nm-magmon-gateway-NM1003" d="Reports telemetry for NM1003" />
              <Cmd c="nm-magmon-gateway-NM1019" d="Reports telemetry for NM1019" />
              <Cmd c="nm-magmon-gateway-NM1027" d="Reports telemetry for NM1027" />
              <Cmd c="nm-magmon-gateway-NM1034" d="Reports telemetry for NM1034" />
              <Cmd c="nm-magmon-gateway-NM1037" d="Reports telemetry for NM1037" />
            </CheatGroup>
            <P>SSH in and manage a collector by its service name:</P>
            <CodeBlock code={`ssh numed@100.120.75.117              # or 10.1.100.100 on the LAN\nls -la                                # the .py + .service pairs\nsystemctl status nm-magmon-gateway-NM1001\njournalctl -u nm-magmon-gateway-NM1001 -f     # live logs\nsudo systemctl restart nm-magmon-gateway-NM1001`} />
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
            </CheatGroup>

            <CheatGroup title="System">
              <Cmd c="sudo apt update && sudo apt full-upgrade -y" d="Update all packages" />
              <Cmd c="df -h" d="Disk space, human-readable" />
              <Cmd c="free -h" d="Memory in use" />
              <Cmd c="htop" d="Live processes + CPU (q to quit)" />
              <Cmd c="uptime" d="How long it's been up, load average" />
              <Cmd c="sudo reboot" d="Restart the Pi" />
              <Cmd c="sudo shutdown now" d="Power it off" />
            </CheatGroup>

            <CheatGroup title="Services (systemd)">
              <Cmd c="systemctl status <name>" d="Is the service running?" />
              <Cmd c="sudo systemctl restart <name>" d="Restart it" />
              <Cmd c="sudo systemctl enable --now <name>" d="Start now + on every boot" />
              <Cmd c="journalctl -u <name> -f" d="Follow its live logs" />
            </CheatGroup>

            <CheatGroup title="Scheduling (cron)">
              <Cmd c="crontab -e" d="Edit your scheduled jobs" />
              <Cmd c="crontab -l" d="List your scheduled jobs" />
              <Cmd c="* * * * * command" d="min hour day month weekday — then the command" />
            </CheatGroup>
            <Callout variant="note" title="MagMon runs under systemd, not cron">
              The gateway collector is a long-running service managed by systemd — check it with{" "}
              <code className="doc-code">systemctl status nm-magmon-gateway</code>, not{" "}
              <code className="doc-code">crontab</code>. Use cron for one-off periodic maintenance
              tasks.
            </Callout>

            <CheatGroup title="Networking">
              <Cmd c="hostname -I" d="This Pi's IP address(es)" />
              <Cmd c="ip a" d="All network interfaces in detail" />
              <Cmd c="ping 8.8.8.8" d="Test connectivity (Ctrl+C to stop)" />
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

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="doc-section">
      <h2 className="text-lg md:text-xl font-semibold tracking-tight text-[var(--text)] mb-3">
        {title}
      </h2>
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
      <div>
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
