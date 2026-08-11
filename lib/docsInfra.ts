// The docs page is full of real infrastructure identifiers — admin emails,
// tailnet account, LAN/Tailscale IPs, server hostname, the numed Pi user, real
// asset IDs. Rather than keep a drift-prone second copy for the demo, every
// sensitive literal is pulled out here: the live docs render with realInfra,
// the /demo docs render with demoInfra (neutral placeholders). Structure and
// prose are identical; only these values change.

import { DEMO_ASSET_IDS } from "./demoFixtures";

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
  assets: string[]; // asset IDs shown in the collector list
};

export const realInfra: DocsInfra = {
  introOwner: "Numed MagMon",
  deviceScopeLabel: "Numed devices",
  lanLabel: "Numed LAN",
  sampleHostname: "ca1012-setonsw",
  piUser: "numed",
  inhandEmail: "NumedIT@numedinc.com",
  tailnetAccount: "nmbackup@numedinc.com",
  serverHostname: "nas123",
  serverLanIp: "10.1.100.100",
  serverTailscaleIp: "100.120.75.117",
  servicePrefix: "nm-magmon-gateway",
  scriptBase: "/opt/magmon-gateway",
  processMatch: "magmon-gateway",
  assets: ["CA1012", "NM1001", "NM1019", "NM1027", "NM1034", "NM1037"],
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
  assets: DEMO_ASSET_IDS.slice(0, 6),
};
