import { requireOrgScope, parseHours } from "@/lib/apiAuth";
import { loadHeliumSeriesForOrg } from "@/lib/fleetQueries";

// Downsampled he_lvl series for the boil-off forecast.
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const scope = await requireOrgScope();
  if ("response" in scope) return scope.response;

  const { id } = await ctx.params;
  const result = await loadHeliumSeriesForOrg(id, scope.orgId, parseHours(request.url, 72));
  if (result.error) {
    return Response.json(result, { status: result.error === "Asset not found" ? 404 : 500 });
  }
  return Response.json(result);
}
