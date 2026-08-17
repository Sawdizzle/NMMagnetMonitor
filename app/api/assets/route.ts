import { requireOrgScope } from "@/lib/apiAuth";
import { listOrgAssets } from "@/lib/fleetQueries";

// Light asset list for the admin panel, replacing its direct
// supabase.from("public_assets") read. Telemetry-free on purpose — the admin
// table only needs names, sites and status.
export async function GET() {
  const scope = await requireOrgScope();
  if ("response" in scope) return scope.response;

  const result = await listOrgAssets(scope.orgId);
  if (result.error) return Response.json(result, { status: 500 });
  return Response.json(result);
}
