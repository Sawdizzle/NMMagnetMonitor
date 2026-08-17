import "server-only";

import { getSession } from "./session";
import type { SessionContext } from "./session";

export type OrgScope = { session: SessionContext; orgId: string };

/**
 * Resolve the caller's session and active org for a route handler, or return the
 * Response to send back.
 *
 * Callers must branch on `"response" in result` — the point of returning the
 * Response rather than throwing is that a route handler which forgets to handle
 * the unauthorized case won't accidentally fall through to serving data.
 *
 * A session with no active org is 403, not 200-with-everything: an org-less
 * caller must see nothing, never the whole fleet.
 */
export async function requireOrgScope(): Promise<OrgScope | { response: Response }> {
  const session = await getSession();
  if (!session) {
    return { response: Response.json({ error: "Not signed in" }, { status: 401 }) };
  }
  if (!session.activeOrgId) {
    return { response: Response.json({ error: "No active organization" }, { status: 403 }) };
  }
  return { session, orgId: session.activeOrgId };
}

/**
 * Parse an hours window from the query string, clamped. Unbounded values would
 * let one request pull the entire retention window for every asset.
 */
export function parseHours(url: string, fallback: number): number {
  const raw = Number(new URL(url).searchParams.get("hours"));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.max(Math.round(raw), 1), 24 * 7);
}

export function parseLimit(url: string, fallback: number, max = 200): number {
  const raw = Number(new URL(url).searchParams.get("limit"));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.round(raw), max);
}
