import webpush from "npm:web-push@3.6.7";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Web-push companion to notify-alerts. Two modes:
//   * default (cron): send a browser/PWA push for any OPEN, not-yet-pushed,
//     debounced alert_event to every stored subscription, stamp push_notified_at,
//     and prune expired (404/410) endpoints.
//   * { test: true, endpoint }: send one test push to a single already-subscribed
//     device, so the Account page can confirm delivery. Only targets endpoints
//     already in push_subscriptions, so it can't be used to push arbitrary devices.
// CORS is set because the test path is invoked from the browser; the cron path is
// server-to-server and unaffected.
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

  // ---- default mode: digest of new open events to all subscriptions ------
  const cutoff = new Date(Date.now() - DEBOUNCE_MIN * 60_000).toISOString();
  const { data: events, error: evErr } = await supabase
    .from("alert_events")
    .select("id, message")
    .is("resolved_at", null)
    .is("push_notified_at", null)
    // Connectivity (iR305/Tailscale) is informational status only — never push.
    .not("kind", "in", "(router_offline,tailscale_offline)")
    .lte("triggered_at", cutoff)
    .order("triggered_at", { ascending: true });
  if (evErr) return json({ error: evErr.message }, 500);
  if (!events || events.length === 0) return json({ sent: 0, reason: "no new alerts" });

  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth");
  if (!subs || subs.length === 0) return json({ sent: 0, reason: "no subscriptions" });

  const payload = JSON.stringify({
    title: events.length === 1 ? "MagMon alert" : `MagMon: ${events.length} new alerts`,
    body:
      events.slice(0, 4).map((e) => e.message).join("\n") +
      (events.length > 4 ? `\n+${events.length - 4} more` : ""),
    url: "/",
  });

  let sent = 0;
  let pruned = 0;
  await Promise.all(
    subs.map(async (s) => {
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

  await supabase
    .from("alert_events")
    .update({ push_notified_at: new Date().toISOString() })
    .in("id", events.map((e) => e.id));

  return json({ sent, pruned, events: events.length });
});

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), {
    status: s,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
