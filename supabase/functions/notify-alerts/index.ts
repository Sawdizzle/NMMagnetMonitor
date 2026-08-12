import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Sends an email digest of any OPEN, not-yet-notified alert_events to every
// enabled email recipient, then stamps notified_at so they are not re-sent.
// Reads the Resend key from the RESEND_API_KEY secret (never hardcoded).
// Intended to be invoked once a minute by pg_cron, right after evaluate_alerts().
Deno.serve(async () => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("ALERT_FROM") ?? "onboarding@resend.dev";

  if (!resendKey) {
    return json({ error: "RESEND_API_KEY is not set" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Debounce: only notify events that have stayed open at least this long, so a
  // metric flapping across its threshold (e.g. he_press hovering near 3.0) opens
  // and resolves without ever emailing. Tunable via ALERT_DEBOUNCE_MINUTES.
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

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!resp.ok) return json({ error: `resend ${resp.status}`, body: await resp.text() }, 502);

  const ids = events.map((e) => e.id);
  const { error: uErr } = await supabase
    .from("alert_events")
    .update({ notified_at: new Date().toISOString() })
    .in("id", ids);
  if (uErr) return json({ error: uErr.message }, 500);

  return json({ sent: to.length, events: ids.length });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
