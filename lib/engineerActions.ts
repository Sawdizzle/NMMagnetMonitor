"use server";

// Alert triage, for the 'engineer' role (and admins, who are engineers plus
// everything else).
//
// Same shape as lib/adminActions.ts: the httpOnly session cookie is read
// server-side and handed to a SECURITY DEFINER RPC, so the browser never holds
// a token it could replay and the DB — not this file — is what decides whether
// the caller may act. _engineer_actor() in schema.sql is that boundary; it
// admits 'admin' and 'engineer', rejects everyone else, and scopes the write to
// the caller's active org so an event id from another tenant is a silent no-op
// rather than a leak.

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "./supabaseServer";
import { SESSION_COOKIE } from "./session";

export type TriageResult = { ok: boolean; error: string | null };

/**
 * Why an engineer is closing the loop on an alert.
 *
 *   accepted     real, and I own it
 *   ignored      real, and we are choosing to live with it for now
 *   false_alarm  the alert itself is wrong
 *
 * `false_alarm` is kept apart from `accepted` deliberately: it is the only
 * signal that a bound needs tuning rather than a magnet needing a visit, and
 * collapsing the two would throw that away.
 */
export type Disposition = "accepted" | "ignored" | "false_alarm";

async function call(fn: string, args: Record<string, unknown>): Promise<TriageResult> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return { ok: false, error: "Not signed in" };

  const { data, error } = await supabaseAdmin.rpc(fn, { p_token: token, ...args });
  if (error) {
    // 'not authorized' / 'not authenticated' come straight from the RPC. Passed
    // through as-is: they are already vague about which of the two applies.
    return { ok: false, error: error.message };
  }
  // The RPCs return `found`, so false means the event was open-and-ours a
  // moment ago and is not now — someone else resolved or acked it in between.
  if (data === false) {
    return { ok: false, error: "That alert is no longer open — it may have just cleared." };
  }
  return { ok: true, error: null };
}

export async function acknowledgeAlert(
  eventId: number,
  disposition: Disposition = "accepted",
  note?: string
): Promise<TriageResult> {
  const result = await call("acknowledge_alert", {
    p_event_id: eventId,
    p_disposition: disposition,
    p_note: note?.trim() ? note.trim() : null,
  });
  if (result.ok) {
    // The queue and the asset pages both read alert_events; re-render them
    // rather than leaving a stale "unacknowledged" row on screen.
    revalidatePath("/engineer");
  }
  return result;
}

export async function unacknowledgeAlert(eventId: number): Promise<TriageResult> {
  const result = await call("unacknowledge_alert", { p_event_id: eventId });
  if (result.ok) revalidatePath("/engineer");
  return result;
}
