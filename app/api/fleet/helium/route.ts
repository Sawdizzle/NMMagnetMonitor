import { requireFleetScope, parseHours } from "@/lib/apiAuth";
import { loadFleetHeliumForOrg } from "@/lib/fleetQueries";

// Whole-fleet helium history in one request. Accepts a display token as well as
// a session, because the TV wall shows refill chips too.
export async function GET(request: Request) {
  const scope = await requireFleetScope();
  if ("response" in scope) return scope.response;

  const result = await loadFleetHeliumForOrg(scope.orgId, parseHours(request.url, 168));
  if (result.error) return Response.json(result, { status: 500 });
  return Response.json(result);
}
