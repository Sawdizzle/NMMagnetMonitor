import "server-only";

import type { DocsInfra } from "./docsInfra";

/**
 * The REAL infrastructure identifiers rendered by /docs.
 *
 * Split into its own server-only module after these values were found sitting
 * in a PUBLIC client chunk: app/docs/page.tsx was a client component that
 * imported them, so `curl /_next/static/chunks/….js` returned the tailnet
 * account, the server's LAN and Tailscale addresses, its hostname and the
 * InHand console login — with no session, no cookie, and no account.
 *
 * The `server-only` import above is the guard that keeps that from coming
 * back: importing this from a client component is now a BUILD error rather
 * than a quiet leak. The values reach the browser only as props the server
 * chose to send, after it has checked the caller may read them.
 *
 * lib/docsInfra.ts keeps the TYPE and the neutral `demoInfra` (placeholders,
 * safe to ship anywhere), so DocsContent can still be a shared client
 * component typed against DocsInfra.
 */
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
