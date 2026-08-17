import { demoOrgId, loadAssetAlertsForOrg } from "@/lib/fleetQueries";
import { parseLimit } from "@/lib/apiAuth";

// PUBLIC — see app/api/demo/fleet/route.ts.
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const orgId = await demoOrgId();
  if (!orgId) return Response.json({ events: [], error: "Demo is not configured" }, { status: 503 });

  const { id } = await ctx.params;
  const result = await loadAssetAlertsForOrg(id, orgId, parseLimit(request.url, 20));
  if (result.error) {
    return Response.json(result, { status: result.error === "Asset not found" ? 404 : 500 });
  }
  return Response.json(result);
}
