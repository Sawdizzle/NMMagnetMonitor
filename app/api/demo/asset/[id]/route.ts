import { demoOrgId, loadAssetDetailForOrg } from "@/lib/fleetQueries";
import { parseHours } from "@/lib/apiAuth";

// PUBLIC — see app/api/demo/fleet/route.ts. loadAssetDetailForOrg still filters
// by org, so a real tenant's asset id returns "Asset not found." here.
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const orgId = await demoOrgId();
  if (!orgId) {
    return Response.json(
      { asset: null, latest: null, buckets: [], alertRules: [], error: "Demo is not configured" },
      { status: 503 },
    );
  }
  const { id } = await ctx.params;
  const result = await loadAssetDetailForOrg(id, orgId, parseHours(request.url, 24));
  if (result.error) {
    return Response.json(result, { status: result.error === "Asset not found" ? 404 : 500 });
  }
  return Response.json(result);
}
