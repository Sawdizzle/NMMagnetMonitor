import { demoOrgId, loadHeliumSeriesForOrg } from "@/lib/fleetQueries";
import { parseHours } from "@/lib/apiAuth";

// PUBLIC — see app/api/demo/fleet/route.ts.
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const orgId = await demoOrgId();
  if (!orgId) return Response.json({ points: [], error: "Demo is not configured" }, { status: 503 });

  const { id } = await ctx.params;
  const result = await loadHeliumSeriesForOrg(id, orgId, parseHours(request.url, 72));
  if (result.error) {
    return Response.json(result, { status: result.error === "Asset not found" ? 404 : 500 });
  }
  return Response.json(result);
}
