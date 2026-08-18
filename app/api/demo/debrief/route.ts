import { demoOrgId } from "@/lib/fleetQueries";
import { loadDebriefForOrg, debriefWindow, DEBRIEF_TIME_ZONE, DEBRIEF_HOUR } from "@/lib/debrief";

// PUBLIC — see app/api/demo/fleet/route.ts. The org comes from orgs.is_demo and
// never from the caller, so this cannot be steered at a real tenant.
export async function GET() {
  const orgId = await demoOrgId();
  if (!orgId) {
    const { start, end } = debriefWindow();
    return Response.json(
      {
        window: {
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          timeZone: DEBRIEF_TIME_ZONE,
          hour: DEBRIEF_HOUR,
        },
        entries: [],
        counts: { opened: 0, resolved: 0, stillOpen: 0, assetsAffected: 0 },
        error: "Demo is not configured",
      },
      { status: 503 }
    );
  }

  const result = await loadDebriefForOrg(orgId);
  if (result.error) return Response.json(result, { status: 500 });
  return Response.json(result);
}
