import { getSession, activeOrgId } from "@/lib/session";
import { loadOpenAlertsForOrg, loadSuppressionsForOrg } from "@/lib/fleetQueries";
import EngineerQueue from "@/components/EngineerQueue";

/**
 * The engineer's workspace: every open finding in the org, in one queue.
 *
 * A SERVER component, and the gate is here rather than in the client, for the
 * same reason /docs is: client-side gating decides what to RENDER, not what to
 * SEND, and by then the fault list is already in the browser. A viewer gets the
 * refusal and an empty payload.
 *
 * This is the counterpart to the dashboard. The dashboard answers "how is the
 * fleet?", per unit, at a glance. This answers "what needs a person, and who
 * has it?" — one list, worst first, with somebody's name against each row.
 */
export default async function EngineerPage() {
  const session = await getSession();
  const canTriage = session?.role === "admin" || session?.role === "engineer";
  const orgId = await activeOrgId();

  if (!session || !canTriage || !orgId) {
    return (
      <div id="main-content" className="min-h-screen p-6 md:p-10" role="main">
        <p className="eyebrow mb-1.5">Engineering</p>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight mb-3">Alert queue</h1>
        <p className="text-sm text-[var(--text-muted)] max-w-prose">
          {session
            ? "This area is for engineers and admins. Ask an admin to grant you the engineer role if you need to work the alert queue."
            : "Sign in to view the alert queue."}
        </p>
      </div>
    );
  }

  const [{ alerts, error }, mutes] = await Promise.all([
    loadOpenAlertsForOrg(orgId),
    loadSuppressionsForOrg(orgId),
  ]);
  // isAdmin gates only the "until I clear it" option in the mute menu. The DB
  // refuses an indefinite mute to an engineer regardless — this just keeps the
  // UI from offering a button that would be rejected.
  return (
    <EngineerQueue
      alerts={alerts}
      mutes={mutes}
      error={error}
      viewer={session.username}
      isAdmin={session.role === "admin"}
    />
  );
}
