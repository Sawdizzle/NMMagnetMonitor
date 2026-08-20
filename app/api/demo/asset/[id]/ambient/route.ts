import { parseHours } from "@/lib/apiAuth";
import { assetInOrg, demoOrgId } from "@/lib/fleetQueries";
import { loadAmbientForAsset } from "@/lib/weather";

// PUBLIC. Same org-membership check as the authenticated route, against the
// is_demo org resolved server-side — a demo URL must not become a way to read
// a real tenant's asset by uuid.
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const orgId = await demoOrgId();
  if (!orgId) {
    return Response.json({ points: [], station: null, error: "Demo is not configured" }, { status: 503 });
  }

  const { id } = await ctx.params;
  if (!(await assetInOrg(id, orgId))) {
    return Response.json({ points: [], station: null, error: "Asset not found" }, { status: 404 });
  }

  const result = await loadAmbientForAsset(id, parseHours(request.url, 24));
  if (result.error) return Response.json(result, { status: 500 });
  return Response.json(result);
}
