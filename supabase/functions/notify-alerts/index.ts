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
// their asset's org and each digest goes only to that org's recipients, from
// that org's sending address.
//
// DEMO TENANTS (orgs.is_demo) and DISABLED companies (orgs.enabled = false) are
// excluded outright: a demo's assets are invented, and a suspended company's
// staff should not be emailed. Neither must reach a human inbox no matter how
// the org is configured. See the suppression block below.
//
// The From address per org: orgs.alert_from, else the legacy global
// app_settings 'alert_from' (both via org_alert_from()), else the ALERT_FROM
// secret, else Resend's test sender.
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) return json({ error: "RESEND_API_KEY is not set" }, 500);

  const supabase = createClient(supabaseUrl, serviceKey);
  const secretFrom = Deno.env.get("ALERT_FROM") || "onboarding@resend.dev";

  // Resolve an org's sending address, falling back to the secret/test sender.
  async function fromFor(orgId: string): Promise<string> {
    const { data } = await supabase.rpc("org_alert_from", { p_org_id: orgId });
    return (data as string | null)?.trim() || secretFrom;
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

    const from = await fromFor(actorOrg);
    const resp = await sendEmail(
      resendKey,
      from,
      [to],
      "MagMon: test alert",
      `This is a test from NM Magnet Monitor.\n\nIf you received this, alert delivery to ${to} is working.\n\n— NM Magnet Monitor`,
    );
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
  // PostgREST embed so the row shape is unambiguous.
  const assetIds = [...new Set((events as EventRow[]).map((e) => e.asset_id))];
  const { data: assets, error: aErr } = await supabase
    .from("assets")
    .select("id, org_id")
    .in("id", assetIds);
  if (aErr) return json({ error: aErr.message }, 500);
  const orgOf = new Map((assets ?? []).map((a) => [a.id as string, a.org_id as string]));

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

    const lines = orgEvents.map((e) => `• [${e.kind}] ${e.message}`).join("\n");
    const subject = `MagMon: ${orgEvents.length} active alert${orgEvents.length === 1 ? "" : "s"}`;
    const text = `The following MagMon alerts are active:\n\n${lines}\n\n— NM Magnet Monitor`;

    const resp = await sendEmail(resendKey, await fromFor(orgId), to, subject, text);
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

function sendEmail(key: string, from: string, to: string[], subject: string, text: string) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text }),
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
