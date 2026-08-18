import { getSession } from "@/lib/session";
import { realInfra } from "@/lib/docsInfraReal";
import DocsGated from "@/components/DocsGated";

/**
 * The live runbook. A SERVER component on purpose.
 *
 * It used to be a client component that imported realInfra directly, which
 * compiled those values into a public static chunk — the tailnet account, the
 * server's LAN and Tailscale IPs, its hostname and the InHand login were all
 * fetchable with no session at all. Client-side gating cannot fix that: by the
 * time <Protected> decides not to render, the bytes are already in the browser.
 *
 * So the decision happens HERE, on the server, and the real values are only
 * put in the response when the caller may read them. Everyone else gets null
 * and their bundle carries nothing to find.
 *
 * /demo/docs is unaffected and stays public — it renders demoInfra, which is
 * placeholders by design.
 */
export default async function DocsPage() {
  const session = await getSession();
  // Same rule as TV access: admins always qualify, viewers need the grant.
  const allowed = !!session && (session.role === "admin" || session.docsAccess);

  return <DocsGated infra={allowed ? realInfra : null} />;
}
