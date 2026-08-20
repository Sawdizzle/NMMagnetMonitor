// The docs page is full of real infrastructure identifiers — admin emails,
// tailnet account, LAN/Tailscale IPs, server hostname, the numed Pi user, real
// asset IDs. Rather than keep a drift-prone second copy for the demo, every
// sensitive literal is pulled out: the live docs render with realInfra, the
// /demo docs render with demoInfra (neutral placeholders). Structure and prose
// are identical; only these values change.
//
// This module holds ONLY the type and the neutral demo values, so it is safe
// to import from anywhere. `realInfra` lives in lib/docsInfraReal.ts behind a
// `server-only` guard — it used to sit here and was reachable from a public
// client chunk. Do not move it back.

export type DocsInfra = {
  introOwner: string; // "…the {introOwner} fleet is set up…"
  deviceScopeLabel: string; // "All {deviceScopeLabel} live on the … tailnet"
  lanLabel: string; // "on the {lanLabel}, or over Tailscale"
  sampleHostname: string; // example Pi hostname
  piUser: string; // SSH user / systemd owner on the Pis
  inhandEmail: string; // InHand Device Manager console login
  tailnetAccount: string; // Tailscale account the fleet joins
  serverHostname: string; // central Pi server hostname
  serverLanIp: string; // Pi server address on the LAN
  serverTailscaleIp: string; // Pi server address over Tailscale
  servicePrefix: string; // systemd unit prefix, e.g. nm-magmon-gateway
  scriptBase: string; // collector script path prefix, e.g. /opt/magmon-gateway
  processMatch: string; // token to grep the running process by
  reportHost: string; // cloud host the gateway reports to (the one DNS lookup that matters)
  assets: string[]; // asset IDs shown in the collector list
  // How to reach one specific unit's MagMon web interface. Queried live rather
  // than hard-coded, because the whole point is that the LAN address is NOT
  // enough to identify a unit — see the unitAccess section in DocsContent.
  unitAccess: UnitAccess[];
};

/** One unit's reach-it-directly details, for the runbook's tunnel table. */
export type UnitAccess = {
  name: string;
  site: string | null;
  magmonHost: string | null; // private LAN address of the MagMon
  piHost: string | null; // the collector Pi's MagicDNS name — the unambiguous part
  piUser: string; // SSH user on that Pi
  /** True when another unit shares this exact magmonHost. */
  ambiguousHost: boolean;
};

export const demoInfra: DocsInfra = {
  introOwner: "MagMon",
  deviceScopeLabel: "fleet devices",
  lanLabel: "operations LAN",
  sampleHostname: "site01-scanner",
  piUser: "gateway",
  inhandEmail: "it@example-imaging.com",
  tailnetAccount: "ops@example-imaging.com",
  serverHostname: "gw-server",
  serverLanIp: "10.0.0.10",
  serverTailscaleIp: "100.100.10.20",
  servicePrefix: "magmon-gateway",
  scriptBase: "/opt/magmon-gateway",
  processMatch: "magmon-gateway",
  reportHost: "example-project.supabase.co",
  // Was DEMO_ASSET_IDS.slice(0, 6) from lib/demoFixtures, deleted in Phase 4
  // when the demo became a real org. These are display labels for the docs
  // page, not real ids, so they are inlined rather than queried — the docs
  // should render identically whether or not the demo org has been seeded.
  assets: ["MM-1001", "MM-1002", "MM-1003", "MM-1004", "MM-1005", "MM-1006"],
  // Placeholders, but deliberately including a colliding pair: the demo docs
  // should show the same shape of problem the real runbook exists to solve.
  unitAccess: [
    { name: "MM-1001", site: "Example Regional", magmonHost: "192.168.1.50", piHost: "mm1001-pi.example.ts.net", piUser: "gateway", ambiguousHost: false },
    { name: "MM-1002", site: "Example Community", magmonHost: "192.168.1.99", piHost: "mm1002-pi.example.ts.net", piUser: "gateway", ambiguousHost: true },
    { name: "MM-1003", site: "Example Imaging", magmonHost: "192.168.1.99", piHost: "mm1003-pi.example.ts.net", piUser: "gateway", ambiguousHost: true },
  ],
};
