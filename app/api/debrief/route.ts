import { requireOrgScope } from "@/lib/apiAuth";
import { loadDebriefForOrg } from "@/lib/debrief";

// The morning debrief for the session's active org: every alert the system
// opened or resolved between yesterday's 9am boundary and this morning's.
//
// requireOrgScope, not requireFleetScope — a wall display shows live state, and
// a day-old digest is not something a corridor screen needs (or should be able
// to pull). Uncached for the same reason every other org-scoped route is.
export async function GET() {
  const scope = await requireOrgScope();
  if ("response" in scope) return scope.response;

  const result = await loadDebriefForOrg(scope.orgId);
  if (result.error) return Response.json(result, { status: 500 });
  return Response.json(result);
}
