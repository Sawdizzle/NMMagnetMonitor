import { requireFleetScope, parseHours } from "@/lib/apiAuth";
import { assetInOrg } from "@/lib/fleetQueries";
import { loadAmbientForAsset } from "@/lib/weather";

// Outside-temperature history for the ambient trace on the asset page's water
// chart. The org check is explicit here because loadAmbientForAsset reads the
// asset by id alone — it is the address that matters to it, not the tenant —
// so this route is what keeps a known uuid from leaking another org's site.
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const scope = await requireFleetScope();
  if ("response" in scope) return scope.response;

  const { id } = await ctx.params;
  if (!(await assetInOrg(id, scope.orgId))) {
    return Response.json({ points: [], station: null, error: "Asset not found" }, { status: 404 });
  }

  const result = await loadAmbientForAsset(id, parseHours(request.url, 24));
  if (result.error) return Response.json(result, { status: 500 });
  return Response.json(result);
}
