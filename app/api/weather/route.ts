import { requireFleetScope } from "@/lib/apiAuth";
import { loadWeatherForOrg } from "@/lib/weather";

// Outside conditions at every site in the caller's org, keyed by asset id.
//
// Accepts a display token as well as a session: the wall display shows the same
// cards, and weather is the least sensitive thing on them. Kept off /api/fleet
// deliberately — that route is on a 30s poll and must never wait on a third
// party, so weather loads separately and fills in when it arrives.
export async function GET() {
  const scope = await requireFleetScope();
  if ("response" in scope) return scope.response;

  const result = await loadWeatherForOrg(scope.orgId);
  if (result.error) return Response.json(result, { status: 500 });
  return Response.json(result);
}
