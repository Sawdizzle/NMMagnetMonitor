import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Emails MagMon alerts via Resend. Two modes:
//   * default (cron): a digest of every OPEN, not-yet-notified, debounced
//     alert_event to all enabled email recipients, then stamps notified_at.
//   * { test: true, to, actor_username, actor_pin }: an admin-gated single test
//     email to `to`, so a newly-added recipient can be verified from the admin
//     UI. PIN-gated via is_admin so the endpoint isn't an open email relay.
// The From address is the app_settings 'alert_from' value if set, else the
// ALERT_FROM secret, else Resend's test sender. Resend key is never hardcoded.
Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) return json({ error: "RESEND_API_KEY is not set" }, 500);

  const supabase = createClient(supabaseUrl, serviceKey);

  // From address: DB setting (admin-editable) overrides the secret overrides the
  // Resend test sender.
  const { data: fromSetting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "alert_from")
    .maybeSingle();
  const from =
    (fromSetting?.value as string | undefined)?.trim() ||
    Deno.env.get("ALERT_FROM") ||
    "onboarding@resend.dev";

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // ---- test mode: admin-gated single send --------------------------------
  if (body?.test) {
    const to = String(body.to ?? "").trim();
    if (!to) return json({ ok: false, message: "No address provided." });
    const { data: isAdmin, error: adminErr } = await supabase.rpc("is_admin", {
      p_username: body.actor_username,
      p_pin: body.actor_pin,
    });
    if (adminErr) return json({ ok: false, message: "Could not verify admin credentials." });
    if (!isAdmin) return json({ ok: false, message: "Not authorized." });

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
    return json({ ok: true, message: `Test email sent to ${to} (from ${from}).` });
  }

  // ---- default mode: digest to all recipients ----------------------------
  // Debounce: only notify events open at least this long, so a metric flapping
  // across its threshold (e.g. he_press near 3.0) never emails.
  const debounceMin = Number(Deno.env.get("ALERT_DEBOUNCE_MINUTES") ?? "5");
  const debounceCutoff = new Date(Date.now() - debounceMin * 60_000).toISOString();

  const { data: events, error: evErr } = await supabase
    .from("alert_events")
    .select("id, kind, message, triggered_at")
    .is("resolved_at", null)
    .is("notified_at", null)
    .lte("triggered_at", debounceCutoff)
    .order("triggered_at", { ascending: true });
  if (evErr) return json({ error: evErr.message }, 500);
  if (!events || events.length === 0) return json({ sent: 0, reason: "no new alerts" });

  const { data: recips, error: rErr } = await supabase
    .from("alert_recipients")
    .select("address")
    .eq("enabled", true)
    .eq("channel", "email");
  if (rErr) return json({ error: rErr.message }, 500);
  const to = (recips ?? []).map((r) => r.address as string);
  if (to.length === 0) return json({ sent: 0, reason: "no recipients configured" });

  const lines = events.map((e) => `• [${e.kind}] ${e.message}`).join("\n");
  const subject = `MagMon: ${events.length} active alert${events.length === 1 ? "" : "s"}`;
  const text = `The following MagMon alerts are active:\n\n${lines}\n\n— NM Magnet Monitor`;

  const resp = await sendEmail(resendKey, from, to, subject, text);
  if (!resp.ok) return json({ error: `resend ${resp.status}`, body: await resp.text() }, 502);

  const ids = events.map((e) => e.id);
  const { error: uErr } = await supabase
    .from("alert_events")
    .update({ notified_at: new Date().toISOString() })
    .in("id", ids);
  if (uErr) return json({ error: uErr.message }, 500);

  return json({ sent: to.length, events: ids.length });
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
    headers: { "Content-Type": "application/json" },
  });
}
