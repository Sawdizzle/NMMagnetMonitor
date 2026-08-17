import "server-only";

import { getSession, getDisplayScope } from "./session";
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
    // Reachable by design now that "create the person, then grant a company" is
    // the flow — a new account genuinely has no company until someone grants
    // one. Say what to do about it rather than showing a bare error code.
    return {
      response: Response.json(
        {
          error:
            "Your account isn't linked to a company yet. Ask an administrator to grant you access.",
        },
        { status: 403 },
      ),
    };
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

/**
 * Org scope for READ-ONLY fleet data, accepting either a human session or a
 * wall-display token.
 *
 * Kept separate from requireOrgScope so display tokens can only ever reach the
 * fleet read — never the admin routes. A screen in a corridor should be able to
 * show magnets and nothing else.
 */
export async function requireFleetScope(): Promise<
  { orgId: string; isDisplay: boolean } | { response: Response }
> {
  const session = await getSession();
  if (session?.activeOrgId) return { orgId: session.activeOrgId, isDisplay: false };

  const display = await getDisplayScope();
  if (display) return { orgId: display.orgId, isDisplay: true };

  if (session) {
    return {
      response: Response.json(
        {
          error:
            "Your account isn't linked to a company yet. Ask an administrator to grant you access.",
        },
        { status: 403 },
      ),
    };
  }
  return { response: Response.json({ error: "Not signed in" }, { status: 401 }) };
}
