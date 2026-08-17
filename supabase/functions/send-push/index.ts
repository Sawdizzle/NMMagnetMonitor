import webpush from "npm:web-push@3.6.7";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Web-push companion to notify-alerts. Two modes:
//   * default (cron): for EACH ORG, push its OPEN, not-yet-pushed, debounced
//     alert_events to that org's members' devices only, stamp push_notified_at,
//     and prune expired (404/410) endpoints.
//   * { test: true, endpoint }: send one test push to a single already-subscribed
//     device, so the Account page can confirm delivery. Only targets endpoints
//     already in push_subscriptions, so it can't be used to push arbitrary devices.
// CORS is set because the test path is invoked from the browser; the cron path is
// server-to-server and unaffected.
// DEMO TENANTS (orgs.is_demo) are excluded outright — their assets are invented,
// so their alerts never reach a device. See the suppression block below.
const DEBOUNCE_MIN = Number(Deno.env.get("ALERT_DEBOUNCE_MINUTES") ?? "5");
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: cfg } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["vapid_public", "vapid_private"]);
  const pub = cfg?.find((c) => c.key === "vapid_public")?.value;
  const priv = cfg?.find((c) => c.key === "vapid_private")?.value;
  if (!pub || !priv) return json({ error: "VAPID keys not generated" }, 500);
  webpush.setVapidDetails("mailto:sawdizzle@gmail.com", pub, priv);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // ---- test mode: one push to a single already-subscribed device --------
  if (body?.test) {
    const endpoint = String(body.endpoint ?? "");
    if (!endpoint) return json({ ok: false, message: "No device endpoint provided." });
    const { data: sub } = await supabase
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("endpoint", endpoint)
      .maybeSingle();
    if (!sub) return json({ ok: false, message: "This device isn’t subscribed." });
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({
          title: "MagMon test",
          body: "Push notifications are working on this device.",
          url: "/",
        }),
      );
      return json({ ok: true, message: "Test notification sent." });
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
        return json({ ok: false, message: "This subscription expired — turn push off and on again." });
      }
      return json({ ok: false, message: `Push was rejected (${code ?? "error"}).` });
    }
  }

  // ---- default mode: one push digest PER ORG -----------------------------
  // This used to select every row in push_subscriptions and push all of them
  // for any open alert. Invisible with a single tenant; with two it pushes one
  // company's magnet alerts to another company's phones. Events are now grouped
  // by their asset's org and pushed only to that org's members' devices, via
  // org_push_subscriptions() (push_subscriptions -> users -> org_members).
  const cutoff = new Date(Date.now() - DEBOUNCE_MIN * 60_000).toISOString();
  const { data: events, error: evErr } = await supabase
    .from("alert_events")
    .select("id, message, asset_id")
    .is("resolved_at", null)
    .is("push_notified_at", null)
    // Connectivity (iR305/Tailscale) is informational status only — never push.
    .not("kind", "in", "(router_offline,tailscale_offline)")
    .lte("triggered_at", cutoff)
    .order("triggered_at", { ascending: true });
  if (evErr) return json({ error: evErr.message }, 500);
  if (!events || events.length === 0) return json({ sent: 0, reason: "no new alerts" });

  // Resolve each event's asset to an org (separate lookup, so the row shape is
  // unambiguous rather than depending on PostgREST embed behaviour).
  type Ev = { id: number; message: string; asset_id: string };
  const assetIds = [...new Set((events as Ev[]).map((e) => e.asset_id))];
  const { data: assets, error: aErr } = await supabase
    .from("assets")
    .select("id, org_id")
    .in("id", assetIds);
  if (aErr) return json({ error: aErr.message }, 500);
  const orgOf = new Map((assets ?? []).map((a) => [a.id as string, a.org_id as string]));

  // Demo tenants never push — the mirror of the same gate in notify-alerts, and
  // needed just as much: a demo org has members, members have phones, and a
  // buzz at 3am about a magnet that does not exist is worse than a stale email.
  // Being a demo is the check, not "does this org happen to have subscribers".
  const { data: demoOrgs, error: dErr } = await supabase
    .from("orgs")
    .select("id")
    .eq("is_demo", true);
  if (dErr) return json({ error: dErr.message }, 500);
  const demoOrgIds = new Set((demoOrgs ?? []).map((o) => o.id as string));

  const byOrg = new Map<string, Ev[]>();
  const demoIds: number[] = [];
  for (const e of events as Ev[]) {
    const org = orgOf.get(e.asset_id);
    // No resolvable org (asset deleted mid-run): skip, and leave
    // push_notified_at unset rather than guessing a destination.
    if (!org) continue;
    // Stamped, not left queued — see notify-alerts for why "nobody to tell" is
    // a terminal outcome rather than a pending one.
    if (demoOrgIds.has(org)) {
      demoIds.push(e.id);
      continue;
    }
    const arr = byOrg.get(org) ?? [];
    arr.push(e);
    byOrg.set(org, arr);
  }
  if (demoIds.length > 0) {
    console.log(`${demoIds.length} demo-tenant alert(s) suppressed — demo companies never push`);
  }

  let sent = 0;
  let pruned = 0;
  const pushedIds: number[] = [...demoIds];

  for (const [orgId, orgEvents] of byOrg) {
    const { data: subs } = await supabase.rpc("org_push_subscriptions", { p_org_id: orgId });
    const list = (subs ?? []) as { endpoint: string; p256dh: string; auth: string }[];

    // Nobody in this org has push enabled. Stamp anyway — same reasoning as
    // notify-alerts: leaving them queued means the first person to ever enable
    // push gets buzzed with the org's entire alert history.
    if (list.length === 0) {
      pushedIds.push(...orgEvents.map((e) => e.id));
      console.log(`org ${orgId}: ${orgEvents.length} alert(s), no push subscriptions — closing out`);
      continue;
    }

    const payload = JSON.stringify({
      title: orgEvents.length === 1 ? "MagMon alert" : `MagMon: ${orgEvents.length} new alerts`,
      body:
        orgEvents.slice(0, 4).map((e) => e.message).join("\n") +
        (orgEvents.length > 4 ? `\n+${orgEvents.length - 4} more` : ""),
      url: "/",
    });

    await Promise.all(
      list.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
          );
          sent++;
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) {
            await supabase.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
            pruned++;
          }
        }
      }),
    );
    pushedIds.push(...orgEvents.map((e) => e.id));
  }

  if (pushedIds.length > 0) {
    await supabase
      .from("alert_events")
      .update({ push_notified_at: new Date().toISOString() })
      .in("id", pushedIds);
  }

  return json({
    sent,
    pruned,
    orgs: byOrg.size,
    events: pushedIds.length,
    demoSuppressed: demoIds.length,
  });
});

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), {
    status: s,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
