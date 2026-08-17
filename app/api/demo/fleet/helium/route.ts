import { demoOrgId, loadFleetHeliumForOrg } from "@/lib/fleetQueries";
import { parseHours } from "@/lib/apiAuth";

// PUBLIC — see app/api/demo/fleet/route.ts.
export async function GET(request: Request) {
  const orgId = await demoOrgId();
  if (!orgId) return Response.json({ series: {}, error: "Demo is not configured" }, { status: 503 });

  const result = await loadFleetHeliumForOrg(orgId, parseHours(request.url, 168));
  if (result.error) return Response.json(result, { status: 500 });
  return Response.json(result);
}
