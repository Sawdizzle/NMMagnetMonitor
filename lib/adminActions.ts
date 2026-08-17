"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "./supabaseServer";
import { SESSION_COOKIE } from "./session";
import type { SupabaseLikeError } from "./errors";

// Server actions for the admin panel.
//
// These replace the old pattern of calling admin_* RPCs straight from the
// browser with (p_actor_username, p_actor_pin) — which meant the plaintext PIN
// lived in localStorage and every RPC was anon-executable with no lockout
// (finding F-4). Now the browser sends no credential at all: the httpOnly
// session cookie travels with the action call, the server reads it, and the
// token-based RPCs resolve the actor AND the active org through _admin_actor().
//
// Every function returns { data, error } rather than throwing, matching the
// shape supabase-js returned, so the call sites in app/admin/page.tsx keep
// destructuring exactly as before.

// The error is passed through as the raw PostgREST shape rather than a plain
// string, so lib/errors.ts can keep mapping constraint violations to plain
// English — friendlyErrorMessage() needs `code` and `details`, and flattening
// to a message would silently lose the assets_name_unique guidance.
export type AdminResult<T> = { data: T | null; error: SupabaseLikeError | null };

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<AdminResult<T>> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  // No cookie at all: don't bother the database, and don't leak which of
  // "signed out" vs "not an admin" applies beyond this generic message.
  if (!token) return { data: null, error: { message: "Not signed in" } };

  const { data, error } = await supabaseAdmin.rpc(fn, { p_token: token, ...args });
  if (error) {
    // The RPCs raise deliberately vague messages for cross-tenant misses
    // ("Asset not found.", "User not found in this organization.") — pass them
    // through unchanged rather than adding detail the caller shouldn't have.
    return { data: null, error };
  }
  return { data: data as T, error: null };
}

// ---- assets ---------------------------------------------------------------

export async function adminCreateAsset(args: {
  name: string;
  siteName: string | null;
  siteAddress: string | null;
  offlineThresholdMinutes: number;
  monitorHost: string | null;
  monitorPort: number;
  monitorUsername: string;
  monitorPassword: string;
  serviceUser: string;
}) {
  const res = await call<unknown>("admin_create_asset", {
    p_name: args.name,
    p_site_name: args.siteName,
    p_site_address: args.siteAddress,
    p_offline_threshold_minutes: args.offlineThresholdMinutes,
    p_monitor_host: args.monitorHost,
    p_monitor_port: args.monitorPort,
    p_monitor_username: args.monitorUsername,
    p_monitor_password: args.monitorPassword,
    p_service_user: args.serviceUser,
  });
  revalidatePath("/admin");
  return res;
}

export async function adminUpdateAsset(args: {
  assetId: string;
  name: string;
  offlineThresholdMinutes: number;
  monitorHost: string | null;
  monitorPort: number;
  monitorUsername: string;
  monitorPassword: string;
  siteName: string | null;
  siteAddress: string | null;
  serviceUser: string;
}) {
  const res = await call<unknown>("admin_update_asset", {
    p_asset_id: args.assetId,
    p_name: args.name,
    p_offline_threshold_minutes: args.offlineThresholdMinutes,
    p_monitor_host: args.monitorHost,
    p_monitor_port: args.monitorPort,
    p_monitor_username: args.monitorUsername,
    p_monitor_password: args.monitorPassword,
    p_site_name: args.siteName,
    p_site_address: args.siteAddress,
    p_service_user: args.serviceUser,
  });
  revalidatePath("/admin");
  return res;
}

export async function adminDeleteAsset(assetId: string) {
  const res = await call<boolean>("admin_delete_asset", { p_asset_id: assetId });
  revalidatePath("/admin");
  return res;
}

/** gateway_token + MagMon credentials — the most sensitive read in the app. */
export async function adminGetAssetConfig(assetId: string) {
  return call<
    {
      gateway_token: string;
      monitor_host: string | null;
      monitor_port: number;
      monitor_username: string;
      monitor_password: string;
    }[]
  >("admin_get_asset_config", { p_asset_id: assetId });
}

export async function adminSetAssetMaintenance(assetId: string, maintenance: boolean) {
  const res = await call<unknown>("admin_set_asset_maintenance", {
    p_asset_id: assetId,
    p_maintenance: maintenance,
  });
  revalidatePath("/admin");
  return res;
}

export async function adminRotateGatewayToken(assetId: string) {
  return call<string>("admin_rotate_gateway_token", { p_asset_id: assetId });
}

// ---- users ----------------------------------------------------------------

export async function adminListUsers() {
  return call<{ username: string; role: string; tv_access: boolean; created_at: string }[]>(
    "admin_list_users"
  );
}

export async function adminCreateUser(username: string, pin: string, role: string) {
  const res = await call<{ username: string; role: string }[]>("admin_create_user", {
    p_new_username: username,
    p_new_pin: pin,
    p_role: role,
  });
  revalidatePath("/admin");
  return res;
}

export async function adminSetTvAccess(username: string, tvAccess: boolean) {
  const res = await call<boolean>("admin_set_tv_access", {
    p_target_username: username,
    p_tv_access: tvAccess,
  });
  // Could be the caller's own access, which the nav reads from the session.
  revalidatePath("/", "layout");
  return res;
}

export async function adminSetRole(username: string, role: string) {
  const res = await call<boolean>("admin_set_role", {
    p_target_username: username,
    p_new_role: role,
  });
  revalidatePath("/", "layout");
  return res;
}

export async function adminResetPin(username: string, newPin: string) {
  const res = await call<boolean>("admin_reset_pin", {
    p_target_username: username,
    p_new_pin: newPin,
  });
  revalidatePath("/admin");
  return res;
}

/**
 * Set (or clear) a company's self-registration code.
 *
 * Kept separate from adminUpdateOrg on purpose: an org edit that didn't touch
 * the code would otherwise clear it — which is exactly how Numed's code was
 * lost. Passing an empty string closes self-registration for that company.
 */
export async function adminSetInviteCode(code: string, orgId?: string) {
  const res = await call<boolean>("admin_set_invite_code", {
    p_new_code: code,
    p_org_id: orgId ?? null,
  });
  revalidatePath("/admin");
  return res;
}

// ---- alert rules ----------------------------------------------------------

export async function adminListAlertRules() {
  return call<
    {
      id: string;
      asset_id: string | null;
      asset_name: string | null;
      field: string;
      comparator: string;
      threshold: number;
      enabled: boolean;
      created_at: string;
    }[]
  >("admin_list_alert_rules");
}

export async function adminUpsertAlertRule(args: {
  ruleId: string | null;
  assetId: string | null;
  field: string;
  comparator: string;
  threshold: number;
  enabled: boolean;
}) {
  const res = await call<string>("admin_upsert_alert_rule", {
    p_rule_id: args.ruleId,
    p_asset_id: args.assetId,
    p_field: args.field,
    p_comparator: args.comparator,
    p_threshold: args.threshold,
    p_enabled: args.enabled,
  });
  revalidatePath("/admin");
  return res;
}

export async function adminDeleteAlertRule(ruleId: string) {
  const res = await call<boolean>("admin_delete_alert_rule", { p_rule_id: ruleId });
  revalidatePath("/admin");
  return res;
}

// ---- alert recipients -----------------------------------------------------

export async function adminListAlertRecipients() {
  return call<
    { id: string; channel: string; address: string; enabled: boolean; created_at: string }[]
  >("admin_list_alert_recipients");
}

export async function adminUpsertAlertRecipient(args: {
  id: string | null;
  channel: string;
  address: string;
  enabled: boolean;
}) {
  const res = await call<string>("admin_upsert_alert_recipient", {
    p_id: args.id,
    p_channel: args.channel,
    p_address: args.address,
    p_enabled: args.enabled,
  });
  revalidatePath("/admin");
  return res;
}

export async function adminDeleteAlertRecipient(id: string) {
  const res = await call<boolean>("admin_delete_alert_recipient", { p_id: id });
  revalidatePath("/admin");
  return res;
}

// ---- alert events / sending address / audit -------------------------------

export async function adminListAlertEvents(limit = 100) {
  return call<
    {
      id: number;
      asset_id: string;
      asset_name: string;
      kind: string;
      message: string;
      triggered_at: string;
      resolved_at: string | null;
      notified_at: string | null;
    }[]
  >("admin_list_alert_events", { p_limit: limit });
}

export async function adminGetAlertFrom() {
  return call<string | null>("admin_get_alert_from");
}

export async function adminSetAlertFrom(from: string) {
  const res = await call<boolean>("admin_set_alert_from", { p_from: from });
  revalidatePath("/admin");
  return res;
}

export async function adminListAuditLog(limit = 200) {
  return call<
    {
      id: number;
      actor: string | null;
      action: string;
      entity_type: string | null;
      entity_id: string | null;
      detail: string | null;
      created_at: string;
    }[]
  >("admin_list_audit_log", { p_limit: limit });
}

// ---- alert delivery test --------------------------------------------------

/**
 * Send a single test email to a configured recipient, via the notify-alerts
 * edge function's admin-gated test mode.
 *
 * This runs server-side specifically so the browser never handles a credential:
 * it forwards the session cookie's token, which the function validates with
 * _admin_actor. It was the last call site holding Session.pin alive.
 *
 * The function additionally refuses any address that isn't already a recipient
 * of the caller's org, so this cannot be used as an email relay.
 */
export async function adminSendTestAlert(address: string): Promise<AdminResult<{ message: string }>> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return { data: null, error: { message: "Not signed in" } };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return { data: null, error: { message: "Supabase URL/key not configured" } };

  try {
    const res = await fetch(`${url}/functions/v1/notify-alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${anon}` },
      body: JSON.stringify({ test: true, to: address, token }),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; message?: string }
      | null;
    if (!res.ok) return { data: null, error: { message: `Test failed (${res.status})` } };
    if (!body?.ok) return { data: null, error: { message: body?.message ?? "Test failed." } };
    return { data: { message: body.message ?? `Test sent to ${address}.` }, error: null };
  } catch (e) {
    return { data: null, error: { message: e instanceof Error ? e.message : "Network error" } };
  }
}

// ---- superadmin: users as people, companies as explicit grants ------------
//
// Creating a user used to put them in whatever org the switcher was on, which
// is how the Demo account ended up able to read Numed's real fleet. These treat
// a person and their company access as two separate decisions.

export type UserGrant = {
  org_id: string;
  slug: string;
  name: string;
  role: "admin" | "viewer";
  tv_access: boolean;
};

export type GlobalUser = {
  username: string;
  is_superadmin: boolean;
  is_active: boolean;
  created_at: string;
  memberships: UserGrant[];
};

export type OrgRow = {
  org_id: string;
  slug: string;
  name: string;
  product_name: string;
  eyebrow: string;
  tagline: string;
  is_demo: boolean;
  invite_code: string | null;
  asset_count: number;
  member_count: number;
  created_at: string;
};

/** Every user with their per-company grants. Superadmin only. */
export async function adminListAllUsers() {
  return call<GlobalUser[]>("admin_list_all_users");
}

/** Create a person with NO company access; grants come after, explicitly. */
export async function adminCreateUnassignedUser(username: string, pin: string) {
  const res = await call<boolean>("admin_create_unassigned_user", {
    p_new_username: username,
    p_new_pin: pin,
  });
  revalidatePath("/admin");
  return res;
}

/**
 * Grant, adjust, or revoke one company's access for one person.
 * Pass role = null to revoke.
 */
export async function adminSetMembership(
  username: string,
  orgId: string,
  role: "admin" | "viewer" | null,
  tvAccess = false
) {
  const res = await call<boolean>("admin_set_membership", {
    p_target_username: username,
    p_org_id: orgId,
    p_role: role,
    p_tv_access: tvAccess,
  });
  // Could be the caller's own access, which the nav reads from the session.
  revalidatePath("/", "layout");
  return res;
}

// ---- user lifecycle -------------------------------------------------------

/**
 * Deactivate or reactivate an account.
 *
 * Deactivating is a real account state, not "strip their grants": it blocks
 * login outright AND deletes their live sessions, so access stops immediately
 * rather than whenever their cookie happens to expire. Their audit history
 * survives, which is the reason to prefer this over deleting.
 */
export async function adminSetUserActive(username: string, active: boolean) {
  const res = await call<boolean>("admin_set_user_active", {
    p_target_username: username,
    p_active: active,
  });
  revalidatePath("/", "layout");
  return res;
}

/** Rename an account. Also moves their push devices, which key by username. */
export async function adminRenameUser(username: string, newUsername: string) {
  const res = await call<boolean>("admin_rename_user", {
    p_target_username: username,
    p_new_username: newUsername,
  });
  revalidatePath("/", "layout");
  return res;
}

/**
 * Permanently delete an account. Memberships and sessions cascade; the audit
 * trail of what they did is deliberately kept (audit_log.actor is plain text).
 */
export async function adminDeleteUser(username: string) {
  const res = await call<boolean>("admin_delete_user", { p_target_username: username });
  revalidatePath("/", "layout");
  return res;
}

// ---- companies ------------------------------------------------------------

export async function adminListOrgs() {
  return call<OrgRow[]>("admin_list_orgs");
}

export async function adminCreateOrg(args: {
  name: string;
  slug: string;
  eyebrow?: string;
  tagline?: string;
  productName?: string;
}) {
  const res = await call<string>("admin_create_org", {
    p_name: args.name,
    p_slug: args.slug,
    p_eyebrow: args.eyebrow ?? null,
    p_tagline: args.tagline ?? null,
    p_product_name: args.productName ?? "Magnet Monitor",
  });
  revalidatePath("/", "layout");
  return res;
}

export async function adminUpdateOrg(args: {
  orgId: string;
  name: string;
  eyebrow: string;
  tagline: string;
  productName: string;
}) {
  const res = await call<boolean>("admin_update_org", {
    p_org_id: args.orgId,
    p_name: args.name,
    p_eyebrow: args.eyebrow,
    p_tagline: args.tagline,
    p_product_name: args.productName,
  });
  // Brand comes from the session, so an edit changes what the nav renders.
  revalidatePath("/", "layout");
  return res;
}

// ---- wall displays --------------------------------------------------------

export type DisplayToken = {
  id: string;
  org_id: string;
  org_name: string;
  label: string;
  created_by: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
};

export async function adminListDisplayTokens() {
  return call<DisplayToken[]>("admin_list_display_tokens");
}

/**
 * Mint a display token. The raw value comes back ONCE — only its hash is
 * stored — so the UI must show it immediately and say so.
 */
export async function adminCreateDisplayToken(label: string, orgId?: string) {
  const res = await call<{ display_token: string; id: string }[]>("admin_create_display_token", {
    p_label: label,
    p_org_id: orgId ?? null,
  });
  revalidatePath("/admin");
  return res;
}

export async function adminRevokeDisplayToken(id: string) {
  const res = await call<boolean>("admin_revoke_display_token", { p_id: id });
  revalidatePath("/admin");
  return res;
}
