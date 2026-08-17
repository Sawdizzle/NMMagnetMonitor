import { requireOrgScope, parseHours } from "@/lib/apiAuth";
import { loadFleetForOrg } from "@/lib/fleetQueries";

// The fleet read for Dashboard and TvWall. Route handlers are uncached by
// default in Next 16, and reading the session cookie makes this dynamic
// regardless — a cached fleet response would be a cross-tenant leak.
export async function GET(request: Request) {
  const scope = await requireOrgScope();
  if ("response" in scope) return scope.response;

  const result = await loadFleetForOrg(scope.orgId, parseHours(request.url, 24));
  if (result.error) return Response.json(result, { status: 500 });
  return Response.json(result);
}
