import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { supabaseAdmin } from "./supabaseServer";
import type { Brand } from "./brand";

// Name kept from the old localStorage key so there is one concept called
// "nm_session" in the codebase, not two. Different storage, same meaning.
export const SESSION_COOKIE = "nm_session";

export type Role = "admin" | "viewer";

export type Membership = {
  orgId: string;
  slug: string;
  name: string;
  role: Role;
  tvAccess: boolean;
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
  role: Role;
  tvAccess: boolean;
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
  effective_role: Role;
  tv_access: boolean;
  memberships: {
    org_id: string;
    slug: string;
    name: string;
    role: Role;
    tv_access: boolean;
    is_demo: boolean;
  }[];
  expires_at: string;
  org_product_name: string | null;
  org_eyebrow: string | null;
  org_tagline: string | null;
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
    role: row.effective_role,
    tvAccess: row.tv_access,
    memberships: (row.memberships ?? []).map((m) => ({
      orgId: m.org_id,
      slug: m.slug,
      name: m.name,
      role: m.role,
      tvAccess: m.tv_access,
      isDemo: m.is_demo,
    })),
    expiresAt: row.expires_at,
    brand:
      row.org_product_name && row.org_eyebrow
        ? {
            productName: row.org_product_name,
            eyebrow: row.org_eyebrow,
            tagline: row.org_tagline ?? "",
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
