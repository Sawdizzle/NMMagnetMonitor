import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { supabaseAdmin } from "./supabaseServer";
import type { Brand } from "./brand";

// Name kept from the old localStorage key so there is one concept called
// "nm_session" in the codebase, not two. Different storage, same meaning.
export const SESSION_COOKIE = "nm_session";
// Separate cookie from the human session on purpose: a wall display and a
// signed-in person can share a browser profile without clobbering each other,
// and clearing one never signs out the other.
export const DISPLAY_COOKIE = "nm_display";

export type Role = "admin" | "viewer";

export type Membership = {
  orgId: string;
  slug: string;
  name: string;
  role: Role;
  tvAccess: boolean;
  docsAccess: boolean;
  isDemo: boolean;
};

// What the server knows about the caller. Note there is no PIN here — that was
// the point of moving the session server-side. `role` is the EFFECTIVE role in
// the active org: a superadmin resolves to "admin" in every org, including ones
// they hold no membership in.
export type SessionContext = {
  userId: string;
  username: string;
  isSuperadmin: boolean;
  activeOrgId: string | null;
  activeOrgSlug: string | null;
  /**
   * True when the active org is a demo tenant (orgs.is_demo) — a sales
   * showcase running on synthetic telemetry, not a production fleet.
   *
   * NOT derivable from `memberships`: a superadmin can switch into an org they
   * hold no membership in, so the active org may be absent from that array
   * entirely. Read it from here, never by searching the memberships list.
   */
  activeOrgIsDemo: boolean;
  role: Role;
  tvAccess: boolean;
  /**
   * May this caller read the live runbook at /docs?
   *
   * Same shape as tvAccess: the per-membership grant OR being an admin
   * (superadmins are admin everywhere, so they always qualify). It gates real
   * infrastructure identifiers, so app/docs/page.tsx checks it on the SERVER
   * before those values are put in the response — a client-only check would
   * ship them to the browser and then decline to draw them.
   */
  docsAccess: boolean;
  memberships: Membership[];
  expiresAt: string;
  /**
   * The ACTIVE org's brand strings. Phase 0 moved these onto `orgs` so a
   * company can be turned up without a deploy; this is what finally carries
   * them to the UI. Null when there is no active org — the client falls back to
   * its built-in brand rather than rendering blanks.
   */
  brand: Brand | null;
};

type ResolveRow = {
  user_id: string;
  username: string;
  is_superadmin: boolean;
  active_org: string | null;
  active_org_slug: string | null;
  active_org_is_demo: boolean;
  effective_role: Role;
  tv_access: boolean;
  docs_access: boolean;
  memberships: {
    org_id: string;
    slug: string;
    name: string;
    role: Role;
    tv_access: boolean;
    docs_access: boolean;
    is_demo: boolean;
  }[];
  expires_at: string;
  org_product_name: string | null;
  org_eyebrow: string | null;
  org_tagline: string | null;
  org_logo_url: string | null;
};

/**
 * Resolve a raw token, bypassing the cookie and the per-render memo.
 *
 * Needed by loginAction: it has just called cookieStore.set(), but getSession()
 * may already have been memoized as null earlier in the same request, so reading
 * back through the cache would report "not signed in" immediately after a
 * successful login.
 */
export async function resolveToken(token: string): Promise<SessionContext | null> {
  const { data, error } = await supabaseAdmin.rpc("resolve_session", { p_token: token });
  // An expired or forged token resolves to zero rows, which is indistinguishable
  // here from "no session" — both mean not signed in.
  if (error || !data || data.length === 0) return null;

  const row = data[0] as ResolveRow;
  return {
    userId: row.user_id,
    username: row.username,
    isSuperadmin: row.is_superadmin,
    activeOrgId: row.active_org,
    activeOrgSlug: row.active_org_slug,
    activeOrgIsDemo: row.active_org_is_demo ?? false,
    role: row.effective_role,
    tvAccess: row.tv_access,
    docsAccess: row.docs_access ?? false,
    memberships: (row.memberships ?? []).map((m) => ({
      orgId: m.org_id,
      slug: m.slug,
      name: m.name,
      role: m.role,
      tvAccess: m.tv_access,
      docsAccess: m.docs_access ?? false,
      isDemo: m.is_demo,
    })),
    expiresAt: row.expires_at,
    brand:
      row.org_product_name && row.org_eyebrow
        ? {
            productName: row.org_product_name,
            eyebrow: row.org_eyebrow,
            tagline: row.org_tagline ?? "",
            logoUrl: row.org_logo_url ?? null,
          }
        : null,
  };
}

// Memoized for the duration of one render pass (React `cache`), so a layout, a
// page and three server components asking "who is this?" cost one round-trip
// rather than five. Per-request only — nothing is cached across requests.
export const getSession = cache(async (): Promise<SessionContext | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return resolveToken(token);
});

// The org every tenant-scoped query must filter by. Returns null when there is
// no session OR no active org — callers must treat null as "show nothing",
// never as "show everything", which is the failure mode that would leak one
// tenant's fleet to another.
export async function activeOrgId(): Promise<string | null> {
  return (await getSession())?.activeOrgId ?? null;
}

export async function isAdminHere(): Promise<boolean> {
  const s = await getSession();
  return s?.role === "admin";
}

export type DisplayScope = { orgId: string; label: string };

/**
 * Resolve the wall-display cookie to an org.
 *
 * A display token is long-lived, revocable and READ-ONLY: it grants one org's
 * fleet and nothing else. It deliberately does not go through _admin_actor, so
 * a screen can never reach an admin RPC. Previously a corridor TV ran on a
 * human's 30-day session — carrying that person's identity and access, and
 * dropping to a login form when it lapsed.
 */
export const getDisplayScope = cache(async (): Promise<DisplayScope | null> => {
  const token = (await cookies()).get(DISPLAY_COOKIE)?.value;
  if (!token) return null;

  const { data, error } = await supabaseAdmin.rpc("resolve_display_token", { p_token: token });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) return null;
  return { orgId: row.org_id as string, label: row.label as string };
});

/**
 * Is the tenant this browser is currently looking at a demo one?
 *
 * Answers for BOTH ways a page gets its org — a person's session and a wall
 * display's token — because both can point at the demo company and a corridor
 * TV showing invented magnets is exactly the screen that most needs to say so.
 * Either one being demo is enough: a browser holding both cookies is ambiguous,
 * and the safe reading of an ambiguous case is "flag it".
 *
 * Deliberately server-side. The client session in lib/auth.tsx is an optimistic
 * localStorage copy that lags an org switch by a round-trip, and a stale "not
 * demo" is precisely the wrong answer to be briefly showing over demo data.
 */
export const viewingDemoTenant = cache(async (): Promise<boolean> => {
  const [session, display] = await Promise.all([getSession(), getDisplayScope()]);
  if (session?.activeOrgIsDemo) return true;
  if (!display) return false;

  const { data } = await supabaseAdmin
    .from("orgs")
    .select("is_demo")
    .eq("id", display.orgId)
    .maybeSingle();
  return data?.is_demo === true;
});
