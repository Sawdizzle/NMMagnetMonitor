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

export async function adminSetInviteCode(code: string) {
  const res = await call<boolean>("admin_set_invite_code", { p_new_code: code });
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
