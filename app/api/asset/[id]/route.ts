import { requireOrgScope, parseHours } from "@/lib/apiAuth";
import { loadAssetDetailForOrg } from "@/lib/fleetQueries";

// Next 16: dynamic route params are a Promise and must be awaited.
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const scope = await requireOrgScope();
  if ("response" in scope) return scope.response;

  const { id } = await ctx.params;
  const result = await loadAssetDetailForOrg(id, scope.orgId, parseHours(request.url, 24));
  // 404 covers both "no such asset" and "another tenant's asset" — the query
  // layer returns the same shape for each so this can't be used to probe uuids.
  if (result.error) {
    return Response.json(result, { status: result.error === "Asset not found" ? 404 : 500 });
  }
  return Response.json(result);
}
