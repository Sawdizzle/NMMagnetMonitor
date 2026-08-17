import { demoOrgId, loadFleetForOrg } from "@/lib/fleetQueries";
import { parseHours } from "@/lib/apiAuth";

// PUBLIC. /demo has no session by design — a prospect should not meet a login
// form, and minting one would clobber the session of a signed-in user who
// clicks "View demo".
//
// The org is resolved from orgs.is_demo, never from anything the caller sends,
// so this route cannot be steered at a real tenant. It reuses the exact same
// org-scoped query layer the authenticated routes use, which is the point of
// making the demo a real org: one data path, one set of behaviour to keep
// correct.
export async function GET(request: Request) {
  const orgId = await demoOrgId();
  if (!orgId) return Response.json({ assets: [], error: "Demo is not configured" }, { status: 503 });

  const result = await loadFleetForOrg(orgId, parseHours(request.url, 24));
  if (result.error) return Response.json(result, { status: 500 });
  return Response.json(result);
}
