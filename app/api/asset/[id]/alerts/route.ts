import { requireOrgScope, parseLimit } from "@/lib/apiAuth";
import { loadAssetAlertsForOrg } from "@/lib/fleetQueries";

// Persisted alert_events for one asset (open + recent resolved), newest first.
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const scope = await requireOrgScope();
  if ("response" in scope) return scope.response;

  const { id } = await ctx.params;
  const result = await loadAssetAlertsForOrg(id, scope.orgId, parseLimit(request.url, 20));
  if (result.error) {
    return Response.json(result, { status: result.error === "Asset not found" ? 404 : 500 });
  }
  return Response.json(result);
}
