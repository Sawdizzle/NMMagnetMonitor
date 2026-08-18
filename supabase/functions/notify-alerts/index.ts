import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Emails MagMon alerts via Resend. Two modes:
//   * default (cron): for EACH ORG, a digest of that org's open, not-yet-
//     notified, debounced alert_events to that org's enabled email recipients,
//     then stamps notified_at.
//   * { test: true, to, token }: an admin-gated single test email so a
//     recipient can be verified from the admin UI. Session-authenticated only —
//     there is deliberately no PIN path.
//
// ORG SCOPING (multi-tenant Phase 3e). This function used to select
// alert_recipients with no filter and email EVERY recipient in the database
// about EVERY open alert. With one tenant that was invisible; with two it pages
// one company's staff about another company's magnet. Events are now grouped by
// their asset's org and each digest goes only to that org's recipients, under
// that org's sender identity.
//
// DEMO TENANTS (orgs.is_demo) and DISABLED companies (orgs.enabled = false) are
// excluded outright: a demo's assets are invented, and a suspended company's
// staff should not be emailed. Neither must reach a human inbox no matter how
// the org is configured. See the suppression block below.
//
// SENDER IDENTITY (2026-08-18). One verified domain that Numed owns carries
// every company's mail; the per-company part is the display name and the
// Reply-To, neither of which needs a record in the customer's DNS. Sending as
// alerts@customer.org would need SPF/DKIM published by the customer, and a
// DMARC-enforcing hospital junks anything without them. org_alert_identity()
// resolves all four fields; the address itself still falls back
// org.alert_from -> app_settings.alert_from -> ALERT_FROM secret -> Resend test
// sender.
//
// CORS: the test mode is invoked from the admin page in the browser, so the
// function must answer the preflight and set CORS headers on every response.
// The cron/pg_net path is server-to-server and unaffected.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type EventRow = {
  id: number;
  kind: string;
  message: string;
  triggered_at: string;
  asset_id: string;
};

type Identity = {
  from_addr: string | null;
  from_name: string | null;
  reply_to: string | null;
  subject_prefix: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) return json({ error: "RESEND_API_KEY is not set" }, 500);

  const supabase = createClient(supabaseUrl, serviceKey);
  const secretFrom = Deno.env.get("ALERT_FROM") || "onboarding@resend.dev";

  // Resolve an org's full sending identity, falling back to the secret/test
  // sender for the address only — the name and prefix always have a default.
  async function identityFor(orgId: string): Promise<Identity> {
    const { data } = await supabase.rpc("org_alert_identity", { p_org_id: orgId });
    const row = (Array.isArray(data) ? data[0] : data) as Identity | undefined;
    return {
      from_addr: row?.from_addr?.trim() || secretFrom,
      from_name: row?.from_name?.trim() || null,
      reply_to: row?.reply_to?.trim() || null,
      subject_prefix: row?.subject_prefix?.trim() || "MagMon",
    };
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // ---- test mode: admin-gated single send --------------------------------
  if (body?.test) {
    const to = String(body.to ?? "").trim();
    if (!to) return json({ ok: false, message: "No address provided." });

    // Session-only. The legacy { actor_username, actor_pin } branch was removed
    // once production served the token path (commit a534539): a reachable
    // PIN-checking endpoint is exactly the F-4 pattern, and it distinguished a
    // right PIN from a wrong one with no lockout.
    if (!body.token) return json({ ok: false, message: "Not authorized." });

    const { data: actorData, error: actorErr } = await supabase.rpc("_admin_actor", {
      p_token: body.token,
    });
    const actor = Array.isArray(actorData) ? actorData[0] : actorData;
    if (actorErr || !actor) return json({ ok: false, message: "Not authorized." });
    const actorOrg = actor.org_id as string;
    const actorName = actor.username as string;

    // Only send to an address already configured for the caller's org. The
    // admin UI only offers Test on a saved recipient, so this costs nothing —
    // and without it an admin of any org could use this as an email relay to
    // arbitrary addresses.
    const { data: allowed } = await supabase.rpc("org_alert_recipients", { p_org_id: actorOrg });
    const isConfigured = ((allowed ?? []) as { address: string }[]).some(
      (r) => r.address.toLowerCase() === to.toLowerCase(),
    );
    if (!isConfigured) {
      return json({
        ok: false,
        message: "That address is not a recipient for your organization. Add and save it first.",
      });
    }

    const id = await identityFor(actorOrg);
    const from = composeFrom(id);
    // The test exists to prove the identity, so it shows what it used rather
    // than only that something arrived.
    const resp = await sendEmail(resendKey, from, [to], `${id.subject_prefix}: test alert`, [
      `This is a test from ${id.from_name ?? "NM Magnet Monitor"}.`,
      ``,
      `If you received this, alert delivery to ${to} is working.`,
      ``,
      `Sent as: ${from}`,
      id.reply_to ? `Replies go to: ${id.reply_to}` : `Replies to this address are not monitored.`,
      ``,
      `— ${id.from_name ?? "NM Magnet Monitor"}`,
    ].join("\n"), id.reply_to);
    if (!resp.ok) {
      return json({ ok: false, message: `Resend rejected it (${resp.status}). ${await resp.text()}` });
    }
    console.log(`test email sent to ${to} by ${actorName} (org ${actorOrg})`);
    return json({ ok: true, message: `Test email sent to ${to} (from ${from}).` });
  }

  // ---- default mode: one digest PER ORG ----------------------------------
  // Debounce: only notify events open at least this long, so a metric flapping
  // across its threshold (e.g. he_press near 3.0) never emails.
  const debounceMin = Number(Deno.env.get("ALERT_DEBOUNCE_MINUTES") ?? "5");
  const debounceCutoff = new Date(Date.now() - debounceMin * 60_000).toISOString();

  const { data: events, error: evErr } = await supabase
    .from("alert_events")
    .select("id, kind, message, triggered_at, asset_id")
    .is("resolved_at", null)
    .is("notified_at", null)
    // Connectivity (iR305/Tailscale) is informational status only — never email.
    .not("kind", "in", "(router_offline,tailscale_offline)")
    .lte("triggered_at", debounceCutoff)
    .order("triggered_at", { ascending: true });
  if (evErr) return json({ error: evErr.message }, 500);
  if (!events || events.length === 0) return json({ sent: 0, reason: "no new alerts" });

  // Map each event to its asset's org. Done as a separate lookup rather than a
  // PostgREST embed so the row shape is unambiguous. The name comes along so
  // the subject can say WHICH magnet — the whole point of a lockscreen glance.
  const assetIds = [...new Set((events as EventRow[]).map((e) => e.asset_id))];
  const { data: assets, error: aErr } = await supabase
    .from("assets")
    .select("id, org_id, name")
    .in("id", assetIds);
  if (aErr) return json({ error: aErr.message }, 500);
  const orgOf = new Map((assets ?? []).map((a) => [a.id as string, a.org_id as string]));
  const nameOf = new Map((assets ?? []).map((a) => [a.id as string, a.name as string]));

  // Demo tenants never email. Their alerts are real rows on purpose — the demo
  // has to look alive, so evaluate_alerts still opens and resolves them — but
  // the units behind them are invented, so every one of these is a page about a
  // magnet that does not exist. Today the demo org happens to have no
  // recipients and the block below would close them out anyway; that is an
  // accident of configuration, one "add recipient" away from paging a real
  // person about MM-1004. This makes it a property of being a demo instead.
  //
  // DISABLED companies (orgs.enabled = false) are suppressed by the same gate,
  // for a related reason. A suspended company keeps collecting telemetry by
  // design, so evaluate_alerts keeps opening events for it — but "we stopped
  // this company's access" and "we still email their staff at 3am" cannot both
  // be true. One query answers both questions: who must not be written to.
  const { data: mutedOrgs, error: dErr } = await supabase
    .from("orgs")
    .select("id")
    .or("is_demo.eq.true,enabled.eq.false");
  if (dErr) return json({ error: dErr.message }, 500);
  const mutedOrgIds = new Set((mutedOrgs ?? []).map((o) => o.id as string));

  const byOrg = new Map<string, EventRow[]>();
  const mutedIds: number[] = [];
  for (const e of events as EventRow[]) {
    const org = orgOf.get(e.asset_id);
    // An event whose asset vanished mid-run has no org to route to. Skip it
    // rather than guessing — and leave notified_at unset so it isn't lost.
    if (!org) continue;
    // Stamped as handled, same as the no-recipients case: "there is nobody this
    // may be sent to" is a terminal outcome, and leaving them queued would
    // re-examine every demo alert every minute forever.
    if (mutedOrgIds.has(org)) {
      mutedIds.push(e.id);
      continue;
    }
    const arr = byOrg.get(org) ?? [];
    arr.push(e);
    byOrg.set(org, arr);
  }
  if (mutedIds.length > 0) {
    console.log(`${mutedIds.length} alert(s) suppressed — demo and disabled companies never email`);
  }

  const notifiedIds: number[] = [...mutedIds];
  const perOrg: { org: string; recipients: number; events: number }[] = [];

  for (const [orgId, orgEvents] of byOrg) {
    const { data: recips } = await supabase.rpc("org_alert_recipients", { p_org_id: orgId });
    const to = ((recips ?? []) as { address: string }[]).map((r) => r.address);

    // No recipients configured for this org. Mark the events as handled anyway.
    //
    // The obvious alternative — leave them queued so they send "once someone is
    // configured" — sounds kinder but is worse: a company accumulates a backlog
    // for as long as it has nobody listening, and then the first person ever
    // added is greeted with a digest of every alert since the company was
    // created, most of them long stale. "Nobody to tell" is a terminal outcome,
    // not a pending one. The events remain in alert_events with their real
    // history; only the delivery attempt is closed out.
    if (to.length === 0) {
      notifiedIds.push(...orgEvents.map((e) => e.id));
      console.log(`org ${orgId}: ${orgEvents.length} alert(s), no recipients configured — closing out`);
      perOrg.push({ org: orgId, recipients: 0, events: orgEvents.length });
      continue;
    }

    const id = await identityFor(orgId);
    const subject = composeSubject(id.subject_prefix!, orgEvents, nameOf);
    const lines = orgEvents
      .map((e) => `• ${e.message}  (since ${shortTime(e.triggered_at)})`)
      .join("\n");
    const text = [
      `The following alerts are active:`,
      ``,
      lines,
      ``,
      id.reply_to ? `` : `This mailbox is not monitored.`,
      `— ${id.from_name ?? "NM Magnet Monitor"}`,
    ].join("\n");

    const resp = await sendEmail(resendKey, composeFrom(id), to, subject, text, id.reply_to);
    if (!resp.ok) {
      // One org's send failing must not stop the others, and its events stay
      // un-notified so the next run retries them.
      console.error(`resend ${resp.status} for org ${orgId}: ${await resp.text()}`);
      perOrg.push({ org: orgId, recipients: to.length, events: 0 });
      continue;
    }
    notifiedIds.push(...orgEvents.map((e) => e.id));
    perOrg.push({ org: orgId, recipients: to.length, events: orgEvents.length });
  }

  if (notifiedIds.length > 0) {
    const { error: uErr } = await supabase
      .from("alert_events")
      .update({ notified_at: new Date().toISOString() })
      .in("id", notifiedIds);
    if (uErr) return json({ error: uErr.message }, 500);
  }

  return json({ orgs: perOrg, notified: notifiedIds.length, suppressed: mutedIds.length });
});

// ---- header composition ---------------------------------------------------

// Build the From header. If the configured address ALREADY carries a display
// name (`Name <addr>`) it is trusted as-is — the ALERT_FROM secret predates the
// split into address + name, and wrapping it again would nest the brackets.
function composeFrom(id: Identity): string {
  const addr = id.from_addr!;
  if (addr.includes("<")) return addr;
  if (!id.from_name) return addr;
  return `${encodeDisplayName(id.from_name)} <${addr}>`;
}

// A display name is not free text once it reaches a mail header. "Numed, Inc
// Magnet Monitor" — a real value here — contains a comma, which is the address
// SEPARATOR: unquoted, the header parses as two broken recipients and Resend
// rejects it. Quote anything with a special character, and fall back to an
// RFC 2047 encoded-word for non-ASCII, which quoting alone cannot carry.
function encodeDisplayName(name: string): string {
  if (/[^\x20-\x7E]/.test(name)) {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(name)));
    return `=?UTF-8?B?${b64}?=`;
  }
  if (/[()<>@,;:\\".\[\]]/.test(name)) {
    return `"${name.replace(/([\\"])/g, "\\$1")}"`;
  }
  return name;
}

// "Magnet Monitor: 1 active alert" told you nothing without opening it. Name the
// magnet instead — on a phone lockscreen that is the entire message.
function composeSubject(
  prefix: string,
  events: EventRow[],
  nameOf: Map<string, string>,
): string {
  if (events.length === 1) return clamp(`${prefix}: ${events[0].message}`, 150);

  const names = [...new Set(events.map((e) => nameOf.get(e.asset_id)).filter(Boolean))] as string[];
  const shown = names.slice(0, 2).join(", ");
  const rest = names.length - Math.min(2, names.length);
  const tail = rest > 0 ? ` +${rest} more` : "";
  return clamp(`${prefix}: ${events.length} alerts — ${shown}${tail}`, 150);
}

function clamp(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

function shortTime(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

function sendEmail(
  key: string,
  from: string,
  to: string[],
  subject: string,
  text: string,
  replyTo?: string | null,
) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
