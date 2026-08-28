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

async function call(
  fn: string,
  args: Record<string, unknown>,
  // Most of these RPCs return `found`; mute_alert returns the new suppression's
  // id. `succeeded` is how a caller says which shape it expects.
  succeeded: (data: unknown) => boolean = (data) => data !== false
): Promise<TriageResult> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return { ok: false, error: "Not signed in" };

  const { data, error } = await supabaseAdmin.rpc(fn, { p_token: token, ...args });
  if (error) {
    // 'not authorized' / 'not authenticated' come straight from the RPC. Passed
    // through as-is: they are already vague about which of the two applies.
    // The mute RPCs raise their own, more specific messages ("only an admin can
    // mute an alert indefinitely"), which are meant to be read.
    return { ok: false, error: error.message };
  }
  // The event was open-and-ours a moment ago and is not now — someone else
  // resolved or acked it in between.
  if (!succeeded(data)) {
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

/**
 * Mute the CONDITION behind an alert, not just this one firing of it.
 *
 * The difference is the whole point. Acknowledging says "I have seen this
 * event"; the moment the condition flaps shut and open again, evaluate_alerts
 * opens a NEW event and it pages afresh. NM1035's dead water sensor did that 95
 * times in a week. A mute is attached to (asset, kind, channel) and survives
 * the churn — it is the place "we know, we're waiting on a part" can actually
 * live.
 *
 * `hours: null` is an indefinite mute and the DB refuses it to anyone who is
 * not an admin. Everything else is capped at two weeks for an engineer. The
 * duration list lives in lib/alertTriage.ts — a "use server" module may only
 * export async functions.
 */
export async function muteAlert(
  eventId: number,
  hours: number | null,
  reason: string
): Promise<TriageResult> {
  if (!reason.trim()) return { ok: false, error: "Say why — a mute without a reason is how a unit goes quietly dark." };
  // Unlike the ack RPCs this one returns the new suppression's id rather than a
  // boolean, so `call`'s false-means-gone check cannot see a null. Check here.
  const result = await call("mute_alert", {
    p_event_id: eventId,
    p_hours: hours,
    p_reason: reason.trim(),
  }, (data) => data !== null);
  if (result.ok) revalidatePath("/engineer");
  return result;
}

export async function unmuteAlert(suppressionId: string): Promise<TriageResult> {
  const result = await call("unmute_alert", { p_suppression_id: suppressionId });
  if (result.ok) revalidatePath("/engineer");
  return result;
}

/**
 * Revise the note (and optionally the call) on an alert already triaged,
 * without disturbing who acknowledged it or when.
 *
 * Un-acknowledging and re-acknowledging would do neither: it loses the original
 * ack time and, for a mute, re-arms the page.
 */
export async function updateAlertNote(
  eventId: number,
  note: string,
  disposition?: Disposition
): Promise<TriageResult> {
  const result = await call("update_alert_note", {
    p_event_id: eventId,
    p_note: note,
    p_disposition: disposition ?? null,
  });
  if (result.ok) revalidatePath("/engineer");
  return result;
}
