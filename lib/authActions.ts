"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "./supabaseServer";
import { SESSION_COOKIE, getSession, resolveToken } from "./session";
import type { SessionContext } from "./session";

// "Remember me" now controls session lifetime instead of which browser store
// gets used: a remembered login is a 30-day persistent cookie, an unremembered
// one dies with the tab and its DB row expires in a day either way.
const REMEMBER_DAYS = 30;
const SESSION_DAYS = 1;

async function setSessionCookie(token: string, expiresAt: string, remember: boolean) {
  const cookieStore = await cookies();
  cookieStore.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    // A `secure` cookie is silently dropped over plain http, which would make
    // local dev look like a broken login. Production is https-only.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // Omitting expires makes it a session cookie, cleared when the tab closes.
    ...(remember ? { expires: new Date(expiresAt) } : {}),
  });
}

/**
 * Verify a PIN and open a server-side session. Returns an error message, or
 * null on success.
 *
 * Brute-force protection is the 5-strike/15-minute lockout inside
 * create_session, not an in-process rate limiter — this runs on serverless
 * instances that don't share memory, so a per-instance counter would be
 * trivially bypassed by spreading attempts.
 */
export async function loginAction(
  username: string,
  pin: string,
  remember = true
): Promise<{ error: string } | { session: SessionContext }> {
  const { data, error } = await supabaseAdmin.rpc("create_session", {
    p_username: username,
    p_pin: pin,
    p_ttl_days: remember ? REMEMBER_DAYS : SESSION_DAYS,
  });

  if (error) {
    // create_session raises for a locked account and for an unknown username;
    // the lockout message is worth surfacing verbatim, the rest is not (it
    // would confirm which usernames exist).
    return { error: /locked/i.test(error.message) ? error.message : "Invalid username or PIN" };
  }
  // No rows = wrong PIN. The strike has already been recorded and committed.
  if (!data || data.length === 0) return { error: "Invalid username or PIN" };

  const { token, expires_at } = data[0] as { token: string; expires_at: string };
  await setSessionCookie(token, expires_at, remember);

  // Return the resolved context so the caller gets role/tv_access without a
  // second verify_user_login round-trip. That matters: calling both would
  // record TWO failed attempts per bad PIN and trip the 5-strike lockout after
  // three tries.
  const session = await resolveToken(token);
  if (!session) return { error: "Session could not be established" };

  revalidatePath("/", "layout");
  return { session };
}

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    // Best-effort: even if the row is already gone, clear the cookie.
    await supabaseAdmin.rpc("destroy_session", { p_token: token });
  }
  cookieStore.delete(SESSION_COOKIE);
  revalidatePath("/", "layout");
}

/**
 * Point the org switcher at a different tenant. The membership check lives in
 * switch_active_org (server-side, superadmin-aware) — this wrapper deliberately
 * does not pre-filter by the client's idea of its memberships, so a forged
 * request cannot talk its way into another company's fleet.
 */
export async function switchOrgAction(orgId: string): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return "Not signed in";

  const { error } = await supabaseAdmin.rpc("switch_active_org", {
    p_token: token,
    p_org_id: orgId,
  });
  if (error) return error.message;

  revalidatePath("/", "layout");
  return null;
}

/** Session context for client components, fetched through a server action. */
export async function getSessionAction() {
  return getSession();
}
