import { demoOrgId } from "@/lib/fleetQueries";
import { loadWeatherForOrg } from "@/lib/weather";

// PUBLIC, like every /api/demo route: the org comes from orgs.is_demo and never
// from the caller. The demo's sites are invented, so their coordinates are
// hand-seeded site_geocode rows (source='manual') pointing at real US cities —
// the weather shown is genuine, the address it hangs off is not.
export async function GET() {
  const orgId = await demoOrgId();
  if (!orgId) return Response.json({ weather: {}, error: "Demo is not configured" }, { status: 503 });

  const result = await loadWeatherForOrg(orgId);
  if (result.error) return Response.json(result, { status: 500 });
  return Response.json(result);
}
